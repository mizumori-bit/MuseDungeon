// V4-1j（IMPROVEMENTS_V4 §30）の確認。ゲームの側: 仲間が最後に動いた時点（party[].last_act。§30.6）・explore toward: sense は目的だけ（§30.5）。
// pilot の側: 危ないときの薬と綱の順（§30.2）・on_danger（§30.3）・協力で立て直しのために階を移らない（§30.4）・だれについていくかの知らせと、先頭でも先に下りない（§30.1）・party_idle は last_act（§30.6。pilot.test.ts の B5）
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, ObsMonster, ObsPartyMember, Observation, RememberedView } from '@muse/shared';
import { applyEvent, macroNext, macroStart, projectPlayerView } from '@muse/shared';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { decide, defaultOrders, newMemory, parseOrders, runPilot } from '../src/index';
import type { DecideContext, PilotMemory, PilotOrders, WakeEvent } from '../src/index';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let esid = 990000;

async function coopRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 300 }));
  const a = await manager.createRun({ name: 'A', mode: 'coop', seed, controller: { kind: 'agent', label: 'a' } });
  if ('error' in a) throw new Error(a.error.message);
  const b = await manager.joinRun(a.session.runId, { name: 'B', classId: 'core:scout', controller: { kind: 'agent', label: 'b' } });
  if ('error' in b) throw new Error(b.error.message);
  const started = await a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
  if (!started.ok) throw new Error(started.error.message);
  const world = a.session.world;
  const actAs = async (who: 'a' | 'b', cmd: Command) => {
    const me = who === 'a' ? a.port : b.port;
    const other = who === 'a' ? b.port : a.port;
    for (let i = 0; i < 20; i++) {
      if (me.view().status === 'your_turn') return me.act(cmd, { source: 'bot' });
      if (other.view().status === 'your_turn') await other.act({ type: 'wait' }, { source: 'bot' });
      else await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('no turn');
  };
  return { manager, a, b, world, actAs };
}

describe('V4-1j §30.6: party[].last_act（ゲームの側。すべてのプレイヤーに同じに渡す）', () => {
  it('last_act is the ally’s own action count: it rises when the ally acts, also out of sight; nothing else about the ally leaks', async () => {
    expect(ENGINE_VERSION >= '0.35.0').toBe(true);
    const t = await coopRun('v41j-last');
    const w = t.world;
    const bPid = t.b.port.playerId;
    const bE = w.entities[w.players[bPid]!.entityId]!;
    const before = t.a.port.observe({}).observation.party[0]!;
    expect(before.last_act).toBe(w.players[bPid]!.lastAct ?? 0);
    await t.actAs('b', { type: 'wait' });
    const after = t.a.port.observe({}).observation.party[0]!;
    expect(after.last_act).toBe(bE.actor!.turns);
    expect(after.last_act).toBeGreaterThan(before.last_act);
    // A が動いても、B の last_act は変わらない
    await t.actAs('a', { type: 'wait' });
    expect(t.a.port.observe({}).observation.party[0]!.last_act).toBe(after.last_act);
    // 見えていない仲間にも出す（位置・エンティティは出さない）。文には出さない
    const o = t.a.port.observe({});
    const mine = o.observation.party[0]!;
    if (!mine.pos) expect(Object.keys(mine).sort()).toEqual(['controller', 'floor', 'hp', 'id', 'last_act', 'name', 'order', 'status']);
    expect(o.text).not.toContain('last_act');
    t.manager.closeAll();
  });
  it('a turn the game waited for the ally (turn timeout) does not count: actor turns rise, last_act stays (an AFK ally is idle)', async () => {
    const t = await coopRun('v41j-timeout');
    const w = t.world;
    const bPid = t.b.port.playerId;
    const bE = w.entities[w.players[bPid]!.entityId]!;
    // B が自分で 1 手動く
    await t.actAs('b', { type: 'wait' });
    const la = t.a.port.observe({}).observation.party[0]!.last_act;
    // ここから B は何もしない。時間切れで、ゲームが B を待たせる（同じ階に A がいるとき）
    w.meta.options.turnTimeoutMs = 30;
    const turns0 = bE.actor!.turns;
    for (let i = 0; i < 8; i++) {
      if (t.a.port.view().status === 'your_turn') await t.a.port.act({ type: 'wait' }, { source: 'bot' });
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(w.entities[bE.id]!.actor!.turns).toBeGreaterThan(turns0);
    expect(t.a.port.observe({}).observation.party[0]!.last_act).toBe(la);
    t.manager.closeAll();
  });
});

describe('V4-1j §30.5: explore toward: sense は目的の相手・品を見ている・覚えているときだけ止まる（ゲームの側）', () => {
  const relic = (key: string, x: number, y: number, id = 'e_rlc901'): Entity => ({ id, kind: 'core:relic_hunter', sid: ++esid, role: 'relic', pos: { floor: key, x, y }, item: { qty: 1, affixes: [] } } as unknown as Entity);
  it('a relic in view that is not the objective does not stop it; the objective relic does', async () => {
    const a = await arena('v41j-sense-see', { map: ['P....', '.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    // 守護者は外す（目的でない守護者で止まらないことは V3-7a で確かめてある）
    applyEvent(a.world, { type: 'thought', player: a.pid, text: '', seq: a.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], del: [a.gId], put: [relic(a.key, a.ox + 3, a.oy + 1)] } as unknown as GameEvent);
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(a.r.port.observe({}).observation.visible.items.some((i) => i.id === 'e_rlc901' && !i.objective)).toBe(true);
    const out = await a.r.port.act({ type: 'explore', toward: 'sense' }, { source: 'bot' });
    expect(!out.ok && out.error.message.includes('気配の元')).toBe(false);
    // 目的の遺物にすると、気配の元として断る（travel_to を勧める）
    const x = a.world.expeditions![a.world.expeditions!.length - 1]!;
    x.objective = { type: 'retrieve_relic', targetDepth: a.world.floors[a.key]!.depth };
    x.targets.relic = 'e_rlc901';
    const out2 = await a.r.port.act({ type: 'explore', toward: 'sense' }, { source: 'bot' });
    expect(!out2.ok && out2.error.message.includes('気配の元')).toBe(true);
    a.manager.closeAll();
  });
  it('a remembered relic stops it only when it is the objective (the B9 case: remembered relics that were not the objective)', async () => {
    const a = await arena('v41j-sense-mem', { map: ['P....', '.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    applyEvent(a.world, { type: 'thought', player: a.pid, text: '', seq: a.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], del: [a.gId] } as unknown as GameEvent);
    const v = projectPlayerView(a.world, a.pid);
    const mem = (objective: boolean): RememberedView => ({ id: 'e_rlc902', cat: 'item', kind: 'core:relic_hunter', appearanceId: null, pos: { x: 40, y: 22 }, qty: 1, ft: 0, role: 'relic', ...(objective ? { objective: true } : {}) } as RememberedView);
    v.memory.remembered.push(mem(false));
    const st = macroStart(v, { type: 'explore', toward: 'sense' }, catalog);
    expect(macroNext(st, v, catalog, [])).not.toEqual({ stop: 'sense_found' });
    v.memory.remembered[v.memory.remembered.length - 1] = mem(true);
    const st2 = macroStart(v, { type: 'explore', toward: 'sense' }, catalog);
    expect(macroNext(st2, v, catalog, [])).toEqual({ stop: 'sense_found' });
    a.manager.closeAll();
  });
});

// ---- pilot の判断（観測は最小限の写し） ----
type Over = { depth?: number; monsters?: ObsMonster[]; stairs?: Observation['navigation']['known_stairs']; party?: ObsPartyMember[]; hp?: number; alerts?: Observation['alerts']; recovery?: Observation['self']['recovery']; lifeline?: boolean };
function fieldObs(o: Over = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: o.alerts ?? [],
    self: {
      name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: o.hp ?? 40, max_hp: 40, statuses: [], pos: { x: 20, y: 10 }, floor: { depth: o.depth ?? 3 }, attack: { acc: 5, dmg: '1d6', throws: [] }, defense: { eva: 0, armor: 0 }, recovery: o.recovery ?? [],
      inventory: o.lifeline ? [{ slot: 'z', name: '帰還の綱', qty: 1, category: 'tool', identified: true, equipped: false, kind: 'core:lifeline' }] : [],
    },
    visible: { monsters: o.monsters ?? [], items: [], players: [], features: [] },
    party: o.party ?? [],
    navigation: { known_stairs: o.stairs ?? [], frontiers: [{ pos: { x: 1, y: 1 }, dir: 'w', dist: 3 }], collectable: { count: 0, ids: [] } },
    expedition: {
      no: 6, objective: { type: 'reach_depth', target_depth: 6, text: '目的' }, progress: {}, status: 'in_progress', points: 0,
      can_extract: false, extract_outcome: 'withdraw', text: '遠征 6', haul: { total: 0, multiplier_pct: 100, parts: {}, if_extract_now: 0, next_overreach: null, next_camp: null, text: '戦利品 0' },
    },
  } as unknown as Observation;
}
function mon(over: Partial<ObsMonster>): ObsMonster {
  return { id: 'e_aaaaaa', name: '敵', pos: { x: 21, y: 10 }, dir: 'e', dist: 1, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [], ...over } as ObsMonster;
}
const ctx = (orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext => ({ orders, coop: false, waiting: false, acked: new Set(), text: '', ...over });
const summary = (r: ReturnType<typeof decide>) => (r.decision.kind === 'wake' ? `${r.decision.wake.level}:${r.decision.wake.reason}` : r.decision.kind === 'act' ? `act:${r.decision.tool}:${JSON.stringify(r.decision.args)}` : r.decision.kind);
const member = (o: Partial<ObsPartyMember>): ObsPartyMember => ({ id: 'p_h', name: 'H', controller: 'agent', order: 2, status: 'in_dungeon', floor: 3, hp: 'healthy', last_act: 0, ...o });
const lethal = { code: 'lethal_range', level: 'danger', text: '1 手で倒されうる: 追跡中の敵の 1 手の最悪の被害の合計 30 ≥ HP 12' } as unknown as Observation['alerts'][number];
const escUp = { code: 'escape', level: 'info', text: '階段まで 4 歩', data: { stairs: 'up', path_len: 4, worst_if_chased: 3, hp: 12 } } as unknown as Observation['alerts'][number];
const potion: Observation['self']['recovery'] = [{ kind: 'item', slot: 'c', name: '回復の薬', qty: 1, amount: '2d6+5' }];
const upFar = { type: 'up' as const, pos: { x: 5, y: 10 }, dist: 15, reachable: true, path_len: 15 };
const ordersOf = (policy: Record<string, unknown>): PilotOrders => parseOrders({ rev: 1, policy });

describe('V4-1j §30.2: 危ないときは、薬が先（階段の上 → 着ける階段 → 回復の手段 → 綱）', () => {
  const chased = [mon({ dist: 2, pos: { x: 22, y: 10 } })];
  it('chased, the stairs not reachable, a potion and a lifeline: drink the potion first (allow_lifeline is false by default)', () => {
    const r = decide(fieldObs({ hp: 12, alerts: [lethal], stairs: [upFar], monsters: chased, recovery: potion, lifeline: true }), ctx());
    expect(summary(r)).toBe('act:use_item:{"slot":"c"}');
    expect(r.notify.find((n) => n.reason === 'danger')?.level).toBe('escalate');
    expect(r.update?.dangerHome).toBe(1);
  });
  it('no recovery left: the lifeline (also with allow_lifeline false; §30.7)', () => {
    const r = decide(fieldObs({ hp: 12, alerts: [lethal], stairs: [upFar], monsters: chased, lifeline: true }), ctx());
    expect(summary(r)).toBe('act:use_item:{"slot":"lifeline"}');
  });
  it('the stairs reachable (escape): to the stairs before the potion', () => {
    const r = decide(fieldObs({ hp: 12, alerts: [lethal, escUp], stairs: [upFar], monsters: chased, recovery: potion, lifeline: true }), ctx());
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"stairs_up","mode":"flee"/);
  });
  it('after the danger, on the way home (not in danger now): no lifeline unless allow_lifeline (walk to the stairs even when chased)', () => {
    const m = newMemory(); m.dangerHome = 1;
    const r = decide(fieldObs({ hp: 30, stairs: [upFar], monsters: chased, lifeline: true }), ctx({ ...defaultOrders(), mode: 'return' }, { mem: m }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"stairs_up"/);
  });
});

describe('V4-1j §30.3: on_danger（return が既定・recover は 1 回目だけ立て直す）', () => {
  const chased = [mon({ dist: 2, pos: { x: 22, y: 10 } })];
  it('the default is return', () => {
    expect(defaultOrders().policy.on_danger).toBe('return');
    expect(ordersOf({ on_danger: 'recover' }).policy.on_danger).toBe('recover');
    expect(ordersOf({ on_danger: 'x' }).policy.on_danger).toBe('return');
  });
  it('recover: the first danger is raised (escalate) and recovered by the potion or by changing floors, not home; no means: home; danger gone: the one try is used; the second danger: home', () => {
    const od = ordersOf({ on_danger: 'recover' });
    const r = decide(fieldObs({ hp: 12, alerts: [lethal], stairs: [upFar], monsters: chased, recovery: potion, lifeline: true }), ctx(od));
    const n = r.notify.find((x) => x.reason === 'danger')!;
    expect(n.level).toBe('escalate');
    expect(n.detail).toContain('立て直す');
    expect(r.update?.dangerRecover).toBe('on');
    expect(r.update?.dangerHome).toBeUndefined();
    expect(summary(r)).toBe('act:use_item:{"slot":"c"}');
    // 階段の上: 帰らずに階を移る（休んだら戻る）。上げ直さない
    const m1 = newMemory(); m1.dangerRecover = 'on'; m1.recovering = true;
    const onUp = { ...upFar, pos: { x: 20, y: 10 }, dist: 0, path_len: 0 };
    const rs = decide(fieldObs({ hp: 12, alerts: [lethal], stairs: [onUp], monsters: chased, lifeline: true }), ctx(od, { mem: m1 }));
    expect(summary(rs)).toBe('act:use_stairs:{}');
    expect(rs.update).toMatchObject({ crossed: 'down', stairRetreats: 1 });
    expect(rs.notify.some((x) => x.reason === 'danger' && x.level === 'escalate')).toBe(false);
    // 着ける階段も回復の手段も無い: 帰る（綱。立て直しの段で、倒されうるまま歩かない。測り直しで 10 本すべてが倒れた形）
    const r1 = decide(fieldObs({ hp: 12, alerts: [lethal], stairs: [upFar], monsters: chased, lifeline: true }), ctx(od, { mem: m1 }));
    expect(summary(r1)).toBe('act:use_item:{"slot":"lifeline"}');
    expect(r1.update?.dangerHome).toBe(1);
    expect(r1.notify.find((x) => x.reason === 'danger')?.detail).toContain('立て直す手が無い');
    // 倒されうる状態でなくなった: 1 回は使った
    const r2 = decide(fieldObs({ hp: 30 }), ctx(od, { mem: m1 }));
    expect(r2.update?.dangerRecover).toBe('used');
    // 同じ遠征で 2 回目: 帰る
    const m3 = newMemory(); m3.dangerRecover = 'used';
    const r3 = decide(fieldObs({ hp: 12, alerts: [lethal], stairs: [upFar], monsters: chased, recovery: potion }), ctx(od, { mem: m3 }));
    expect(r3.update?.dangerHome).toBe(1);
    expect(r3.notify.find((x) => x.reason === 'danger')?.detail).toContain('この遠征は帰る');
  });
});

describe('V4-1j の測り直しで見つけた: 眠っている目的の相手には、先に隣へ寄る（fight は追ってくる相手を待つ手）', () => {
  it('engage_objective: an asleep objective guardian 5 away → travel_to it; next to it, or hunting → fight', () => {
    const g = (o: Partial<ObsMonster>) => mon({ id: 'e_grd001', role: 'guardian', objective: true, guardian: { name: 'カベルキ', types: [] }, ...o } as Partial<ObsMonster>);
    const od = ordersOf({ engage_objective: true });
    expect(summary(decide(fieldObs({ monsters: [g({ awareness: 'asleep', dist: 5, pos: { x: 25, y: 10 } })] }), ctx(od)))).toBe('act:travel_to:{"to":"e_grd001"}');
    expect(summary(decide(fieldObs({ monsters: [g({ awareness: 'asleep', dist: 1 })] }), ctx(od)))).toMatch(/^act:fight:\{"target":"e_grd001"/);
    expect(summary(decide(fieldObs({ monsters: [g({ awareness: 'hunting', dist: 5, pos: { x: 25, y: 10 } })] }), ctx(od)))).toMatch(/^act:fight:\{"target":"e_grd001"/);
  });
});

describe('V4-1j §31.6 の 3: 協力プレイで、仲間が重傷以下なら、休むより先に助けに行く（自分の HP が減っていても）', () => {
  it('HP below the recovery line, nothing chasing: goes to the badly wounded ally instead of resting; healthy ally or solo: rests; in danger: its own retreat first', () => {
    const m = newMemory(); m.recovering = true;
    m.follow = { id: 'p_h', exp: 6, met: true, inDungeon: true, lastPos: null, lastFloor: 3, floorAtStart: 3, startTurn: 0 };
    const hurtAlly = member({ order: 1, controller: 'human', hp: 'badly_wounded', pos: [30, 10], entity: 'e_h00001' });
    const r = decide(fieldObs({ hp: 12, party: [hurtAlly] }), ctx(defaultOrders(), { coop: true, mem: m }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"e_h00001","mode":"flee"/);
    expect(r.decision.kind === 'act' && r.decision.why).toBe('assist');
    // 仲間が元気: 休む（今までどおり）
    const r2 = decide(fieldObs({ hp: 12, party: [{ ...hurtAlly, hp: 'healthy' }] }), ctx(defaultOrders(), { coop: true, mem: m }));
    expect(summary(r2)).toBe('act:rest:{}');
    // 自分が倒されうる: 判断の表の 7（危ないとき）が先。協力プレイでは、上げて、帰る前に 1 回だけ相手の所へ寄る（§28.2 の 1）
    const r3 = decide(fieldObs({ hp: 12, party: [hurtAlly], alerts: [lethal], monsters: [mon({ dist: 2, pos: { x: 22, y: 10 } })], recovery: potion }), ctx(defaultOrders(), { coop: true, mem: m }));
    expect(r3.decision.kind === 'act' && r3.decision.why).toBe('danger');
    expect(r3.notify.find((n) => n.reason === 'danger')?.detail).toContain('H の所へ寄る');
    // 寄り終えた（もう寄った）: 自分の退く手（ここでは薬）
    const m4 = { ...m, dangerJoin: 'done' as const };
    const r4 = decide(fieldObs({ hp: 12, party: [hurtAlly], alerts: [lethal], monsters: [mon({ dist: 2, pos: { x: 22, y: 10 } })], recovery: potion }), ctx(defaultOrders(), { coop: true, mem: m4 }));
    expect(summary(r4)).toBe('act:use_item:{"slot":"c"}');
  });
});

describe('V4-1j §30.4: 協力プレイで、同じ階に仲間が生きている間は、立て直しのために階を移らない', () => {
  const mem = (): PilotMemory => { const m = newMemory(); m.recovering = true; m.trail = [{ x: 1, y: 1 }, { x: 28, y: 10 }]; return m; };
  it('the ally on this floor out of sight: no stairs; the ally on another floor: stairs; retreat_via_stairs: true: stairs', () => {
    const chase = [mon({ dist: 3, pos: { x: 23, y: 10 } })];
    const base = { hp: 12, alerts: [escUp], stairs: [{ ...upFar, dist: 4, path_len: 4 }], monsters: chase };
    const r = decide(fieldObs({ ...base, party: [member({ floor: 3 })] }), ctx(defaultOrders(), { coop: true, mem: mem() }));
    expect(r.decision.kind === 'act' && (r.decision.tool === 'use_stairs' || String(r.decision.args.to).startsWith('stairs_'))).toBe(false);
    const r2 = decide(fieldObs({ ...base, party: [member({ floor: 2 })] }), ctx(defaultOrders(), { coop: true, mem: mem() }));
    expect(summary(r2)).toMatch(/^act:travel_to:\{"to":"stairs_up"/);
    const r3 = decide(fieldObs({ ...base, party: [member({ floor: 3 })] }), ctx(ordersOf({ retreat_via_stairs: true }), { coop: true, mem: mem() }));
    expect(summary(r3)).toMatch(/^act:travel_to:\{"to":"stairs_up"/);
  });
});

describe('V4-1j §30.1: 自分が先頭でも、同じ階に仲間がいる間は先に階段を下りない', () => {
  const onDown = { type: 'down' as const, pos: { x: 20, y: 10 }, dist: 0, reachable: true, path_len: 0 };
  it('on the down stairs as the leader: waits until the ally is next to it (hold_max_turns), then goes down; the ally adjacent or on another floor: goes down', () => {
    // 自分（参加の順 1）が先頭: 相手は参加の順 2 の AI
    const o = fieldObs({ stairs: [onDown], party: [member({ order: 2 })] });
    const r = decide(o, ctx(defaultOrders(), { coop: true, turnNo: 50 }));
    expect(summary(r)).toBe('act:wait:{}');
    expect(r.notify.find((n) => n.reason === 'stairs_hold')?.detail).toContain('H が隣に来るまで待つ');
    expect(r.update?.stairHold).toEqual({ depth: 3, since: 50 });
    // hold_max_turns（40）が過ぎた: 1 人で下りる（moved_without_party を知らせる。§31.6 の 4）
    const m = newMemory(); m.stairHold = { depth: 3, since: 50 };
    const rx = decide(o, ctx(defaultOrders(), { coop: true, turnNo: 90, mem: m }));
    expect(summary(rx)).toBe('act:use_stairs:{}');
    expect(rx.notify.find((n) => n.reason === 'moved_without_party')?.detail).toContain('H が 40 手番待っても隣に来なかった');
    expect(r.notify.some((n) => n.reason === 'moved_without_party')).toBe(false);
    // 相手が隣: 下りる
    const near = fieldObs({ stairs: [onDown], party: [member({ order: 2, pos: [21, 10], entity: 'e_h00001' })] });
    expect(summary(decide(near, ctx(defaultOrders(), { coop: true, turnNo: 50 })))).toBe('act:use_stairs:{}');
    // 相手が別の階: 待たない
    const other = fieldObs({ stairs: [onDown], party: [member({ order: 2, floor: 4 })] });
    expect(summary(decide(other, ctx(defaultOrders(), { coop: true, turnNo: 50 })))).toBe('act:use_stairs:{}');
  });
});

describe('V4-1j §30.1: だれについていくかを知らせる（following。state.json にも）', () => {
  it('AI and AI with coop.follow auto: the earlier joiner leads ("self"); with coop.follow set to the partner: follows the partner', async () => {
    for (const follow of ['auto', 'B'] as const) {
      const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
      const manager = new SessionManager(content, config);
      const app = createApp(manager, config);
      await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const r = await manager.createRun({ name: 'Pilot', seed: `v41j-follow-${follow}`, classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' }, mode: 'coop' });
      if ('error' in r) throw new Error(r.error.message);
      const b = await manager.joinRun(r.session.runId, { name: 'B', controller: { kind: 'agent', label: 'b' } });
      if ('error' in b) throw new Error(b.error.message);
      const dir = mkdtempSync(join(tmpdir(), 'muse-pilot-test-'));
      writeFileSync(join(dir, 'orders.json'), JSON.stringify({ rev: 1, policy: { coop: { follow } } }));
      const wakes: WakeEvent[] = [];
      const ac = new AbortController();
      const done = runPilot({ baseUrl: base, token: r.token, dir, pollMs: 20, log: () => {}, signal: ac.signal, maxActions: 50, mode: 'coop', onWake: (ev) => wakes.push(ev) });
      const t0 = Date.now();
      while (!wakes.some((w) => w.reason === 'following') && Date.now() - t0 < 15000) await new Promise((res) => setTimeout(res, 20));
      const n = wakes.find((w) => w.reason === 'following')!;
      expect(n.level).toBe('notify');
      const state = () => (existsSync(join(dir, 'state.json')) ? JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8')) as { following?: unknown } : {});
      const t1 = Date.now();
      while (state().following === undefined && Date.now() - t1 < 5000) await new Promise((res) => setTimeout(res, 20));
      if (follow === 'auto') {
        expect(n.detail).toContain('自分が先頭');
        expect(n.detail).toContain('coop.follow');
        expect(state().following).toBe('self');
      } else {
        expect(n.detail).toContain('ついていく相手: B［AI］');
        expect(state().following).toEqual({ id: b.port.playerId, name: 'B' });
      }
      ac.abort();
      await done;
      manager.closeAll();
      await new Promise<void>((r2) => app.server.close(() => r2()));
    }
  }, 60000);
});

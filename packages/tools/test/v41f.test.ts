// V4-1f（IMPROVEMENTS_V4 §22）の確認: 仲間の情報（観測の party[]・start_expedition の still_inside。すべてのプレイヤーに同じに渡る）と、
// pilot の「探す」・大守護者のもう一度の相談・空回りの後の再開・仲間についていく・キャンプで仲間を待つ。
// pilot をサーバーにつないだ確かめ（キャンプで仲間を待つ・2 体の pilot・rev だけで再開）は pilot.test.ts。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, ObsMonster, ObsPartyMember, Observation } from '@muse/shared';
import { applyEvent } from '@muse/shared';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';
import { decide, defaultOrders, leaderOf, newMemory, patrolTarget, selfOrder } from '../src/index';
import type { DecideContext, HistoryRow, PilotOrders, PilotState, WakeEvent } from '../src/index';
import { wardenRetry, wardenRetryDetail } from '../src/pilot/pilot';
import { simpleResponder } from '../src/pilot/responder';
import { readOrders } from '../src/pilot/orders';

const content = loadContent();

async function coopRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 300 }));
  // キャンプから作り、2 人目が入ってから遠征を始める（V4-1g G1: 途中で入った者はキャンプから。次の遠征から一緒に出る）
  const a = await manager.createRun({ name: 'A', mode: 'coop', seed, controller: { kind: 'agent', label: 'a' } });
  if ('error' in a) throw new Error(a.error.message);
  const b = await manager.joinRun(a.session.runId, { name: 'B', classId: 'core:scout', controller: { kind: 'human', label: 'b' } });
  if ('error' in b) throw new Error(b.error.message);
  const started = await a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
  if (!started.ok) throw new Error(started.error.message);
  const world = a.session.world;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: a.port.playerId, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  /** どちらかの手番が来るまで、もう一方を待たせて回す */
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
  return { manager, a, b, world, inject, actAs };
}
const stairsCell = (world: Awaited<ReturnType<typeof coopRun>>['world'], key: string, id: string) => {
  const f = world.floors[key]!;
  const tv = world.meta.terrainTable.indexOf(id);
  const i = f.terrain.findIndex((v) => v === tv);
  return { x: i % f.width, y: Math.trunc(i / f.width) };
};

describe('V4-1f party[] and still_inside (§22.4)', () => {
  it('party shows each ally’s floor and status even out of sight; position, HP and entity only when seen on the same floor; nothing of the ally’s floor leaks', async () => {
    const t = await coopRun('v41f-party');
    const w = t.world;
    const aPid = t.a.port.playerId, bPid = t.b.port.playerId;
    const aE = w.entities[w.players[aPid]!.entityId]!;
    expect(w.players[bPid]!.state).toBe('alive');
    // 隣に置く: 見えている
    const bE0 = structuredClone(w.entities[w.players[bPid]!.entityId]!);
    bE0.pos = { floor: aE.pos!.floor, x: aE.pos!.x + 1, y: aE.pos!.y };
    t.inject({ put: [bE0] });
    let o = t.a.port.observe({}).observation;
    expect(o.party).toHaveLength(1);
    expect(o.party[0]).toMatchObject({ id: bPid, name: 'B', controller: 'human', order: 2, status: 'in_dungeon', floor: w.floors[aE.pos!.floor]!.depth, pos: [aE.pos!.x + 1, aE.pos!.y], entity: bE0.id });
    expect(o.party[0]!.hp).toMatch(/healthy|wounded|badly_wounded|near_death/);
    expect(t.a.port.observe({}).text).toContain('仲間: B［人間］（地下 1 階・健康・見えている');
    // B から見た A: 参加の順は 1
    expect(t.b.port.observe({}).observation.party[0]).toMatchObject({ id: aPid, controller: 'agent', order: 1 });
    // 下り階段の上に置いて、下の階へ移らせる
    const down = stairsCell(w, aE.pos!.floor, 'core:stairs_down');
    const bE1 = structuredClone(w.entities[bE0.id]!);
    bE1.pos = { floor: aE.pos!.floor, ...down };
    t.inject({ put: [bE1] });
    const r = await t.actAs('b', { type: 'stairs' });
    expect(r.ok).toBe(true);
    const bFloor = w.entities[bE0.id]!.pos!.floor;
    expect(w.floors[bFloor]!.depth).toBe(2);
    o = t.a.port.observe({}).observation;
    // 見えていない仲間: 階と HP の段階は出る（V4-1g G3）。位置とエンティティは出ない
    expect(o.party[0]).toEqual({ id: bPid, name: 'B', controller: 'human', order: 2, status: 'in_dungeon', floor: 2, hp: 'healthy', last_act: w.entities[bE0.id]!.actor!.turns });
    expect(t.a.port.observe({}).text).toContain('仲間: B［人間］（地下 2 階・健康）');
    // 漏洩テスト: 仲間のいる階の敵・地物・アイテムの ID も、仲間の位置も出ない
    const json = JSON.stringify(t.a.port.observe({}));
    const floor2Ids = Object.values(w.entities).filter((e) => e.pos?.floor === bFloor && !e.player).map((e) => e.id);
    expect(floor2Ids.length).toBeGreaterThan(0);
    for (const id of floor2Ids) expect(json).not.toContain(id);
    expect(json).not.toContain(bE0.id);
    // A のプレイヤー視点にも、2 階の地形は無い（覚えている階は 1 階だけ）
    expect(Object.keys(w.players[aPid]!.knowledge.floors)).not.toContain(bFloor);
    t.manager.closeAll();
  });

  it('start_expedition refused while an ally is still inside names them and their floor (details.still_inside and the hint)', async () => {
    const t = await coopRun('v41f-still');
    const w = t.world;
    const aPid = t.a.port.playerId, bPid = t.b.port.playerId;
    const aE = w.entities[w.players[aPid]!.entityId]!;
    // A は階段の上で帰る（撤退）。B は迷宮に残る
    const up = stairsCell(w, aE.pos!.floor, 'core:stairs_down');
    const a1 = structuredClone(aE); a1.pos = { floor: aE.pos!.floor, ...up };
    t.inject({ put: [a1] });
    const ex = await t.actAs('a', { type: 'extract', confirm: true });
    expect(ex.ok).toBe(true);
    expect(w.players[aPid]!.state).toBe('at_camp');
    expect(t.a.port.observe({}).observation.party[0]).toMatchObject({ id: bPid, status: 'in_dungeon', floor: 1 });
    const res = await t.a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.still_inside).toEqual([{ id: bPid, name: 'B', floor: 1 }]);
      expect(res.error.hint).toContain('Bがまだ地下 1 階にいる。遠征は全員が戻るまで続く。');
    }
    expect(ENGINE_VERSION >= '0.33.0').toBe(true);
    t.manager.closeAll();
  });

  it('a solo run has an empty party and no party line', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await manager.createRun({ name: 'S', seed: 'v41f-solo', controller: { kind: 'agent', label: 's' }, objective: 'auto' });
    if ('error' in r) throw new Error(r.error.message);
    const o = r.port.observe({});
    expect(o.observation.party).toEqual([]);
    expect(o.text).not.toContain('仲間:');
    manager.closeAll();
  });
});

// ---- pilot の判断（観測は最小限の写し） ----
type Over = { depth?: number; monsters?: ObsMonster[]; items?: Observation['visible']['items']; stairs?: Observation['navigation']['known_stairs']; objective?: { type: string; target_depth: number | null }; frontiers?: number; sense?: { what: 'guardian' | 'relic'; dir: 'e' | 'w' | 'n' | 's'; range: 'near' | 'far' }; party?: ObsPartyMember[]; pos?: { x: number; y: number }; status?: string };
function fieldObs(o: Over = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: [],
    self: { name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: 40, max_hp: 40, statuses: [], pos: o.pos ?? { x: 20, y: 10 }, floor: { depth: o.depth ?? 3 }, attack: { acc: 5, dmg: '1d6' }, defense: { eva: 0, armor: 0 }, recovery: [] },
    visible: { monsters: o.monsters ?? [], items: o.items ?? [], players: [], features: [] },
    party: o.party ?? [],
    navigation: { known_stairs: o.stairs ?? [], frontiers: Array.from({ length: o.frontiers ?? 0 }, () => ({ pos: { x: 1, y: 1 }, dir: 'w', dist: 3 })), collectable: { count: 0, ids: [] } },
    expedition: {
      no: 6, objective: { type: o.objective?.type ?? 'slay_guardian', target_depth: o.objective?.target_depth ?? 3, text: '地下3階の守護者を倒す' }, progress: {}, status: o.status ?? 'in_progress', points: 0,
      can_extract: false, extract_outcome: 'withdraw', text: '遠征 6', haul: { total: 0, multiplier_pct: 100, parts: {}, if_extract_now: 0, next_overreach: null, next_camp: null, text: '戦利品 0' },
      ...(o.sense ? { sense: { ...o.sense, text: `気配: 守護者は${o.sense.dir}` } } : {}),
    },
  } as unknown as Observation;
}
const ctx = (orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext => ({ orders, coop: false, waiting: false, acked: new Set(), text: '', ...over });
const withPolicy = (p: Partial<PilotOrders['policy']>): PilotOrders => { const o = defaultOrders(); return { ...o, policy: { ...o.policy, ...p } }; };
const summary = (r: ReturnType<typeof decide>) => (r.decision.kind === 'wake' ? `${r.decision.wake.level}:${r.decision.wake.reason}` : r.decision.kind === 'act' ? `act:${r.decision.tool}:${JSON.stringify(r.decision.args)}${r.decision.seek ? ':seek' : ''}` : `${r.decision.kind}${r.decision.kind === 'idle' && r.decision.wait ? `:${r.decision.wait}` : ''}`);
const member = (o: Partial<ObsPartyMember>): ObsPartyMember => ({ id: 'p_b', name: 'B', controller: 'agent', order: 2, status: 'in_dungeon', floor: 3, last_act: 0, ...o });

describe('V4-1f pilot: seeking the objective (§22.1)', () => {
  const up = { type: 'up' as const, pos: { x: 3, y: 10 }, dist: 17, reachable: true, path_len: 17 };
  it('on the target floor with the target not in view: explores toward the sense first; on an explored floor it patrols (sense direction first, farthest first) instead of going home', () => {
    // 探索できる所が残っている: 気配の方角へ探索（探す手）
    expect(summary(decide(fieldObs({ frontiers: 2, sense: { what: 'guardian', dir: 'e', range: 'far' } }), ctx()))).toBe('act:explore:{"pickup":"useful","toward":"sense"}:seek');
    // 探索し終えた: 立ったことのあるマスを見回る（気配の方角＝東の、いちばん遠い所）
    const walked = [{ x: 5, y: 10 }, { x: 30, y: 10 }, { x: 38, y: 12 }, { x: 22, y: 10 }];
    const r = decide(fieldObs({ stairs: [up], sense: { what: 'guardian', dir: 'e', range: 'far' } }), ctx(defaultOrders(), { walked }));
    expect(summary(r)).toBe('act:travel_to:{"to":{"x":38,"y":12}}:seek');
    // 気配が無ければ、方角を問わずいちばん遠い所
    expect(summary(decide(fieldObs({ stairs: [up] }), ctx(defaultOrders(), { walked })))).toBe('act:travel_to:{"to":{"x":38,"y":12}}:seek');
    // 探し始めてから行った所の近く（6 マス未満）は行き先にしない
    const mem = newMemory(); mem.seekVisited = [{ x: 37, y: 11 }];
    expect(patrolTarget(fieldObs({ stairs: [up] }), mem, walked)).toEqual({ x: 3, y: 10 });
  });
  it('nothing left to patrol, or seek_max_turns used up: wakes target_not_found (not nothing_to_do); not on the target floor, it does not seek', () => {
    expect(summary(decide(fieldObs(), ctx()))).toBe('wake:target_not_found');
    const mem = newMemory(); mem.seekTurns = 150;
    expect(summary(decide(fieldObs({ frontiers: 2 }), ctx(defaultOrders(), { mem })))).toBe('wake:target_not_found');
    // 目的の相手が見えている（覚えている）なら探さない
    const g = { id: 'e_grd001', name: '守護者', pos: { x: 25, y: 10 }, dir: 'e', dist: 5, hp_state: 'healthy', awareness: 'asleep', threat: 2, statuses: [], worst_hit: 5, speed: 'normal', traits: [], worst_turn: 5, shot: 'clear', shots: [], role: 'guardian', guardian: { name: 'g', types: [] }, objective: true } as ObsMonster;
    expect(summary(decide(fieldObs({ monsters: [g] }), ctx()))).not.toBe('wake:target_not_found');
    // 目的の階でなければ探さない（下りる・上る・探索の行のまま）
    expect(summary(decide(fieldObs({ depth: 2 }), ctx()))).toBe('wake:nothing_to_do');
  });
  it('sample responder goes home on target_not_found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41f-resp-'));
    const ordersPath = join(dir, 'orders.json');
    writeFileSync(ordersPath, JSON.stringify(defaultOrders()));
    simpleResponder({ level: 'wake', reason: 'target_not_found', key: 'k', detail: '', state: { hostiles: [], traps: [] } as unknown as PilotState, statePath: join(dir, 'state.json'), ordersPath } as WakeEvent);
    expect(readOrders(ordersPath)!.mode).toBe('return');
  });
});

describe('V4-1f pilot: asking again about the warden (§22.2)', () => {
  const row = (no: number, type: string, slain: boolean, over: Partial<HistoryRow> = {}): HistoryRow => ({ no, slot: 'safe', objective: { type, target_depth: 5 }, turns: 80, banked: 0, end: 'lifeline', last_wake: null, slain, met: true, dealt: 30, taken: 25, ...over });
  it('after warden: engage, two warden expeditions ending without the kill ask again (with how each went); the kill or other objectives do not count', () => {
    const h = [row(1, 'slay_guardian', false), row(2, 'slay_warden', false), row(3, 'slay_guardian', true), row(4, 'slay_warden', false, { met: false, dealt: 0 })];
    expect(wardenRetry(h, 0, 2)).toMatchObject({ depth: 5, tries: [{ no: 2 }, { no: 4 }] });
    expect(wardenRetry(h, 2, 2)).toBeNull();
    expect(wardenRetry([row(1, 'slay_warden', true), row(2, 'slay_warden', false)], 0, 2)).toBeNull();
    const d = wardenRetryDetail(wardenRetry(h, 0, 2)!, { level: 7, hp: 50, max_hp: 60 });
    expect(d).toContain('倒さずに 2 回の遠征が終わった');
    expect(d).toContain('遠征 2: lifeline・相手に会えた・相手に見た被害 30・受けた被害 25');
    expect(d).toContain('遠征 4: lifeline・相手に会えなかった・相手に見た被害 0');
  });
});

describe('V4-1f pilot: following an ally (§22.5)', () => {
  it('leaderOf: a human ally first; otherwise the earliest joiner (none when that is me); follow: none / a name', () => {
    const o = (party: ObsPartyMember[]) => fieldObs({ party });
    expect(leaderOf(o([member({ id: 'p_a', order: 1 }), member({ id: 'p_h', order: 3, controller: 'human' })]), defaultOrders().policy)?.id).toBe('p_h');
    expect(leaderOf(o([member({ id: 'p_a', order: 1 })]), defaultOrders().policy)?.id).toBe('p_a');
    // 自分が参加の順で最初（相手は 2 番）: だれにもついていかない（pilot 2 体がお互いを追わない）
    expect(selfOrder([member({ order: 2 })])).toBe(1);
    expect(leaderOf(o([member({ order: 2 })]), defaultOrders().policy)).toBeNull();
    expect(leaderOf(o([member({ id: 'p_h', controller: 'human' })]), withPolicy({ coop: { follow: 'none', follow_distance: 8, wait_for_party: true, idle_minutes: 10, wait_for_join: true, assist: true, on_party_down: 'return' } }).policy)).toBeNull();
    expect(leaderOf(o([member({ id: 'p_a', order: 1 }), member({ id: 'p_c', name: 'C', order: 3 })]), withPolicy({ coop: { follow: 'C', follow_distance: 8, wait_for_party: true, idle_minutes: 10, wait_for_join: true, assist: true, on_party_down: 'return' } }).policy)?.id).toBe('p_c');
    // 倒れた仲間にはついていかない
    expect(leaderOf(o([member({ id: 'p_h', controller: 'human', status: 'down' })]), defaultOrders().policy)).toBeNull();
  });
  const leaderMem = (over: Partial<NonNullable<ReturnType<typeof newMemory>['follow']>> = {}) => { const m = newMemory(); m.follow = { id: 'p_h', exp: 6, met: true, inDungeon: true, lastPos: null, lastFloor: 3, floorAtStart: 3, startTurn: 0, ...over }; return m; };
  const downSt = { type: 'down' as const, pos: { x: 30, y: 10 }, dist: 10, reachable: true, path_len: 10 };
  it('the ally on another floor: no going ahead on its own; heads to the ally’s floor (down or up)', () => {
    // 相手は 4 階（自分は 3 階）: 下りる
    const p4 = member({ id: 'p_h', controller: 'human', floor: 4 });
    expect(summary(decide(fieldObs({ party: [p4], stairs: [downSt], objective: { type: 'reach_depth', target_depth: 6 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem() })))).toBe('act:travel_to:{"to":"stairs_down"}');
    expect(summary(decide(fieldObs({ party: [p4], stairs: [{ ...downSt, dist: 0 }], objective: { type: 'reach_depth', target_depth: 6 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem() })))).toBe('act:use_stairs:{}');
    // 相手は 2 階: 上る（自分の目的の階が深くても、下りない）
    const p2 = member({ id: 'p_h', controller: 'human', floor: 2 });
    const upSt = { type: 'up' as const, pos: { x: 5, y: 10 }, dist: 15, reachable: true, path_len: 15 };
    expect(summary(decide(fieldObs({ party: [p2], stairs: [downSt, upSt], objective: { type: 'reach_depth', target_depth: 6 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem({ lastFloor: 2 }) })))).toBe('act:travel_to:{"to":"stairs_up"}');
  });
  it('the ally on the same floor: closes in past follow_distance; near it, plays as usual but never takes the stairs first; the ally went back to camp: heads home', () => {
    const far = member({ id: 'p_h', controller: 'human', floor: 3, pos: [5, 10], entity: 'e_ally01' });
    expect(summary(decide(fieldObs({ party: [far], stairs: [downSt], objective: { type: 'reach_depth', target_depth: 6 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem() })))).toBe('act:travel_to:{"to":"e_ally01"}');
    // 近い: 下り階段を知っていても下りない（探索できる所が無ければ、待つ）
    const near = member({ id: 'p_h', controller: 'human', floor: 3, pos: [22, 10], entity: 'e_ally01' });
    expect(summary(decide(fieldObs({ party: [near], stairs: [downSt], objective: { type: 'reach_depth', target_depth: 6 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem() })))).toBe('act:wait:{}');
    expect(summary(decide(fieldObs({ party: [near], stairs: [downSt], frontiers: 1, objective: { type: 'reach_depth', target_depth: 6 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem() })))).toBe('act:explore:{"pickup":"useful"}');
    // 見えていない: 最後に見た位置へ
    const unseen = member({ id: 'p_h', controller: 'human', floor: 3 });
    expect(summary(decide(fieldObs({ party: [unseen] }), ctx(defaultOrders(), { coop: true, mem: leaderMem({ lastPos: { x: 8, y: 4 } }) })))).toBe('act:travel_to:{"to":{"x":8,"y":4}}');
    // キャンプに帰った（この遠征で迷宮にいた）: 帰る
    const home = member({ id: 'p_h', controller: 'human', status: 'at_camp', floor: undefined });
    const upSt = { type: 'up' as const, pos: { x: 5, y: 10 }, dist: 15, reachable: true, path_len: 15 };
    // 帰る途中は撃たれても止まらない進み方（flee。V4-1g §24.2）
    expect(summary(decide(fieldObs({ party: [home], stairs: [upSt] }), ctx(defaultOrders(), { coop: true, mem: leaderMem() })))).toMatch(/^act:travel_to:\{"to":"stairs_up","mode":"flee"/);
  });
  it('the ally already on another floor at the start: heads there without waiting (V4-1k §32.3 の 3; wait_for_party waits only while the ally is at camp)', () => {
    const p4 = member({ id: 'p_h', controller: 'human', floor: 4 });
    const startMem = leaderMem({ met: false, lastFloor: 4, floorAtStart: 4, startTurn: 0 });
    const o = fieldObs({ party: [p4], stairs: [downSt], objective: { type: 'reach_depth', target_depth: 6 } });
    // V4-1f では、遠征の最初に hold_max_turns まで待っていた（Muse の協力で、40 手番ほど待ってから動いた）
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: startMem, turnNo: 5 })))).toBe('act:travel_to:{"to":"stairs_down"}');
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: startMem, turnNo: 60 })))).toBe('act:travel_to:{"to":"stairs_down"}');
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: leaderMem({ met: false, lastFloor: 4, floorAtStart: 3 }), turnNo: 5 })))).toBe('act:travel_to:{"to":"stairs_down"}');
    expect(summary(decide(o, ctx(withPolicy({ coop: { follow: 'auto', follow_distance: 8, wait_for_party: false, idle_minutes: 10, wait_for_join: true, assist: true, on_party_down: 'return' } }), { coop: true, mem: startMem, turnNo: 5 })))).toBe('act:travel_to:{"to":"stairs_down"}');
  });
  it('danger, HP and enemies come before following (an enemy next to me is fought first)', () => {
    const p4 = member({ id: 'p_h', controller: 'human', floor: 4 });
    const foe = { id: 'e_foe001', name: '敵', pos: { x: 21, y: 10 }, dir: 'e', dist: 1, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [] } as ObsMonster;
    expect(summary(decide(fieldObs({ party: [p4], stairs: [downSt], monsters: [foe] }), ctx(defaultOrders(), { coop: true, mem: leaderMem() })))).toMatch(/^act:fight:\{"target":"e_foe001"/);
  });
  it('at camp with an ally still inside: waits (idle wait: party) instead of the camp wake, the stall check or starting', () => {
    const camp = { ...fieldObs(), status: 'at_camp', self: { ...fieldObs().self, pos: null, floor: null }, camp: { next_no: 7, offers: [{ index: 1, type: 'slay_guardian', target_depth: 3, points: 100, text: '1', multiplier_pct: 100, recommended_level: 2, level_gap: 0, trait_danger: 0, slot: 'safe' }] } } as unknown as Observation;
    camp.party = [member({ status: 'in_dungeon', floor: 2 })];
    const auto = defaultOrders(); auto.camp.auto_start = 'safe';
    expect(summary(decide(camp, ctx(auto, { coop: true, stalled: '空回り' })))).toBe('idle:party');
    camp.party = [member({ status: 'at_camp', floor: undefined })];
    expect(summary(decide(camp, ctx(auto, { coop: true })))).toBe('act:start_expedition:{"offer":1}');
    // 遠征が終わっている（始められる）なら、仲間が迷宮にいても待たない
    camp.party = [member({ status: 'in_dungeon', floor: 2 })];
    camp.expedition = { ...camp.expedition!, status: 'ended' };
    expect(summary(decide(camp, ctx(auto, { coop: true })))).toBe('act:start_expedition:{"offer":1}');
  });
});

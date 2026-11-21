// V4-1k（IMPROVEMENTS_V4 §32）の確認。ゲームの側: 同じ階の仲間の位置は見えていなくても渡す（§32.3。漏洩テストも）。
// pilot の側: 通らない相手に殴り続けない・fight_with（§32.1）、目的の相手を覚えている地図から探す（§32.2）、ついていく動き（§32.3）、小さな直し（§32.4）
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, ObsMonster, ObsPartyMember, Observation } from '@muse/shared';
import { applyEvent, projectPlayerView } from '@muse/shared';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';
import { allyDest, decide, defaultOrders, fightArgs, fightNumbers, newMemory, parseOrders, patrolTarget, throughVerdict } from '../src/index';
import type { DecideContext, FightStat, PilotOrders } from '../src/index';
import { mapCellsOf } from '../src/pilot/pilot';

const content = loadContent();
let esid = 995000;

async function coopRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 300 }));
  const a = await manager.createRun({ name: 'A', mode: 'coop', seed, controller: { kind: 'agent', label: 'a' } });
  if ('error' in a) throw new Error(a.error.message);
  const b = await manager.joinRun(a.session.runId, { name: 'B', classId: 'core:scout', controller: { kind: 'agent', label: 'b' } });
  if ('error' in b) throw new Error(b.error.message);
  const started = await a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
  if (!started.ok) throw new Error(started.error.message);
  const world = a.session.world;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: a.port.playerId, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
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

describe('V4-1k §32.3: 同じ階の仲間の位置は、見えていなくても渡す（ゲームの側。漏洩テスト）', () => {
  it('an ally on the same floor out of sight: party[].pos is given (no entity); the ally’s cell and the enemies around it stay unknown', async () => {
    expect(ENGINE_VERSION >= '0.36.0').toBe(true);
    const t = await coopRun('v41k-pos');
    const w = t.world;
    const aPid = t.a.port.playerId, bPid = t.b.port.playerId;
    const aE = w.entities[w.players[aPid]!.entityId]!;
    const key = aE.pos!.floor;
    const f = w.floors[key]!;
    const fkA = w.players[aPid]!.knowledge.floors[key]!;
    // A がまだ見ていない、通れるマスを探す（B をそこに置く）
    const tt = w.meta.terrainTable;
    let cell = -1;
    for (let i = 0; i < f.terrain.length; i++) if (!fkA.seen[i] && (tt[f.terrain[i]!] ?? '').includes('floor') && !Object.values(w.entities).some((e) => e.pos?.floor === key && e.pos.y * f.width + e.pos.x === i)) { cell = i; break; }
    expect(cell).toBeGreaterThanOrEqual(0);
    const bx = cell % f.width, by = Math.trunc(cell / f.width);
    const bE = structuredClone(w.entities[w.players[bPid]!.entityId]!);
    bE.pos = { floor: key, x: bx, y: by };
    // B の隣に敵を置く（A には見えていない）
    const foe = { id: 'e_lk0001', kind: 'core:goblin', sid: ++esid, pos: { floor: key, x: bx, y: by }, actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'asleep', targetPos: null, lostTurns: 0, params: {} } }, stats: { hp: 9, maxHp: 9, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, base: { maxHp: 9, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, statuses: [] } as unknown as Entity;
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: bx + dx!, y: by + dy! })).find((c) => (tt[f.terrain[c.y * f.width + c.x]!] ?? '').includes('floor'));
    if (nb) foe.pos = { floor: key, ...nb };
    t.inject({ put: [bE, ...(nb ? [foe] : [])] });
    const o = t.a.port.observe({});
    const pm = o.observation.party[0]!;
    expect(pm.pos).toEqual([bx, by]);
    expect(pm.entity).toBeUndefined();
    expect(o.text).toContain(`仲間: B（地下 ${f.depth} 階・健康・(${bx},${by})）`);
    // 漏洩: B のいるマスの地形は A の記憶に無いまま。B の隣の敵の ID も出ない
    const v = projectPlayerView(w, aPid);
    expect(v.memory.terrain[cell]).toBe(0);
    expect(JSON.stringify(o)).not.toContain('e_lk0001');
    expect(v.party.find((p) => p.playerId === bPid)?.pos).toEqual({ x: bx, y: by });
    // 別の階の仲間は位置を出さない
    const down = f.terrain.findIndex((x) => tt[x] === 'core:stairs_down');
    const b2 = structuredClone(w.entities[w.players[bPid]!.entityId]!);
    b2.pos = { floor: key, x: down % f.width, y: Math.trunc(down / f.width) };
    t.inject({ put: [b2] });
    expect((await t.actAs('b', { type: 'stairs' })).ok).toBe(true);
    const o2 = t.a.port.observe({}).observation.party[0]!;
    expect(o2.floor).toBe(f.depth + 1);
    expect(o2.pos).toBeUndefined();
    t.manager.closeAll();
  });
});

// ---- pilot の判断（観測は最小限の写し） ----
type Over = { depth?: number; monsters?: ObsMonster[]; stairs?: Observation['navigation']['known_stairs']; party?: ObsPartyMember[]; hp?: number; alerts?: Observation['alerts']; frontiers?: number; sense?: { dir: string; range: string }; objective?: { type: string; target_depth: number | null }; throws?: boolean; status?: string };
function fieldObs(o: Over = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: o.alerts ?? [],
    self: { name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: o.hp ?? 40, max_hp: 40, statuses: [], pos: { x: 20, y: 10 }, floor: { depth: o.depth ?? 3 }, attack: { acc: 5, dmg: '1d6', throws: o.throws ? [{ slot: 'k', kind: 'core:throwing_knife', name: '投げナイフ', qty: 5 }] : [] }, defense: { eva: 0, armor: 0 }, recovery: [], inventory: [] },
    visible: { monsters: o.monsters ?? [], items: [], players: [], features: [] },
    party: o.party ?? [],
    navigation: { known_stairs: o.stairs ?? [], frontiers: Array.from({ length: o.frontiers ?? 0 }, () => ({ pos: { x: 1, y: 1 }, dir: 'w', dist: 3 })), collectable: { count: 0, ids: [] } },
    expedition: {
      no: 6, objective: { type: o.objective?.type ?? 'reach_depth', target_depth: o.objective?.target_depth ?? 6, text: '目的' }, progress: {}, status: o.status ?? 'in_progress', points: 0,
      can_extract: false, extract_outcome: 'withdraw', text: '遠征 6', haul: { total: 0, multiplier_pct: 100, parts: {}, if_extract_now: 0, next_overreach: null, next_camp: null, text: '戦利品 0' },
      ...(o.sense ? { sense: { what: 'guardian', ...o.sense, text: '気配' } } : {}),
    },
  } as unknown as Observation;
}
function mon(over: Partial<ObsMonster>): ObsMonster {
  return { id: 'e_aaaaaa', name: '敵', pos: { x: 21, y: 10 }, dir: 'e', dist: 1, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [], ...over } as ObsMonster;
}
const ctx = (orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext => ({ orders, coop: false, waiting: false, acked: new Set(), text: '', ...over });
const summary = (r: ReturnType<typeof decide>) => (r.decision.kind === 'wake' ? `${r.decision.wake.level}:${r.decision.wake.reason}` : r.decision.kind === 'act' ? `act:${r.decision.tool}:${JSON.stringify(r.decision.args)}` : r.decision.kind);
const member = (o: Partial<ObsPartyMember>): ObsPartyMember => ({ id: 'p_h', name: 'H', controller: 'human', order: 1, status: 'in_dungeon', floor: 3, hp: 'healthy', last_act: 0, ...o });
const ordersOf = (policy: Record<string, unknown>): PilotOrders => parseOrders({ rev: 1, policy });
const stat = (o: Partial<FightStat>): FightStat => ({ id: 'e_grd001', name: 'キモルヤ', exp: 6, depth: 5, warden: true, objective: true, stage0: 'healthy', stageM0: 'healthy', stageT0: null, stage: 'healthy', mHits: 0, mDealt: 0, tHits: 0, tDealt: 0, selfHp0: 60, selfHp: 40, ...o });

describe('V4-1k §32.1: 通らない相手に殴り続けない（自分の与えた被害と、観測の HP の段階から決める）・fight_with', () => {
  it('reads the fight numbers from the result text (melee, throws, both; Japanese and English)', () => {
    expect(fightNumbers('fight: 7 手進んだ。 9 回攻撃し 7 回命中・合計 21 ダメージを与えた。')).toEqual({ melee: 9, throws: 0, hits: 7, dealt: 21 });
    expect(fightNumbers('3 回投げ 2 回命中・合計 10 ダメージを与えた（待った手番 1）。')).toEqual({ melee: 0, throws: 3, hits: 2, dealt: 10 });
    expect(fightNumbers('近接 2 回・投擲 4 回、5 回命中・合計 18 ダメージを与えた。')).toEqual({ melee: 2, throws: 4, hits: 5, dealt: 18 });
    expect(fightNumbers('Swung 4 times, 3 hit for 9 total.')).toEqual({ melee: 4, throws: 0, hits: 3, dealt: 9 });
    expect(fightNumbers('no numbers')).toBeNull();
  });
  it('the verdict: more than 6 melee hits with no stage drop → throw (if it can); giving up is by the estimate (V4-1l §34.1: no hp_left_est → 12 hits without a drop)', () => {
    const p = defaultOrders().policy;
    expect(throughVerdict(stat({ mHits: 6, mDealt: 18 }), p, true)).toBe('ok');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21 }), p, true)).toBe('throw');
    // V4-1l §34.1: 投げられなくても、すぐにはやめない（体力の目安が無い相手は 12 回で）
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21 }), p, false)).toBe('ok');
    // 段階が下がっていれば、通っている
    expect(throughVerdict(stat({ mHits: 9, mDealt: 27, stage: 'wounded' }), p, true)).toBe('ok');
    // 投げ始めた後: 投げ続ける。投げて 6 回当てても下がらず、合わせて 12 回 → やめる。近接より通らない → 近接に戻す（V4-1l）
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21, tHits: 2, tDealt: 16, stageT0: 'healthy' }), p, true)).toBe('throw');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21, tHits: 7, tDealt: 56, stageT0: 'healthy' }), p, true)).toBe('give_up');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21, tHits: 3, tDealt: 6, stageT0: 'healthy' }), p, true)).toBe('ok');
    // 投げて段階が下がった後、投げる物が無くなった: 近接で続ける
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21, tHits: 4, tDealt: 32, stageT0: 'healthy', stage: 'wounded' }), p, false)).toBe('ok');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21 }), ordersOf({ fight_with: 'melee' }).policy, true)).toBe('ok');
    expect(throughVerdict(stat({ mHits: 12, mDealt: 21 }), ordersOf({ fight_with: 'melee' }).policy, true)).toBe('give_up');
    // 先に投げる: 投げる物がある間は投げ、無くなったら近接（測り直しで分かった: 投げる物が尽きたら、近接を試さずにやめていた）
    const tf = ordersOf({ fight_with: 'throw_first' }).policy;
    expect(throughVerdict(stat({ stageM0: null, tHits: 9, tDealt: 18, stageT0: 'healthy' }), tf, true)).toBe('throw');
    expect(throughVerdict(stat({ stageM0: null, tHits: 9, tDealt: 18, stageT0: 'healthy' }), tf, false)).toBe('ok');
    expect(throughVerdict(stat({ stageM0: 'healthy', mHits: 7, mDealt: 14, tHits: 9, tDealt: 18, stageT0: 'healthy' }), tf, false)).toBe('give_up');
  });
  it('fightArgs: auto throws (keeps throwing when adjacent) once melee is not getting through; throw_first throws from the start; melee never throws (also at a fled target)', () => {
    const o = fieldObs({ throws: true, monsters: [mon({ id: 'e_grd001', guardian: { name: 'キモルヤ', types: [], warden: true } as never, role: 'guardian', objective: true })] });
    const kinds = new Set(['core:throwing_knife']);
    const stats = new Map([['6:e_grd001', stat({ mHits: 8, mDealt: 24 })]]);
    expect(fightArgs(o, defaultOrders().policy, newMemory(), 'e_grd001', kinds)).not.toHaveProperty('with');
    expect(fightArgs(o, defaultOrders().policy, newMemory(), 'e_grd001', kinds, stats)).toMatchObject({ with: 'core:throwing_knife', adjacent: 'throw' });
    expect(fightArgs(o, ordersOf({ fight_with: 'throw_first' }).policy, newMemory(), 'e_grd001', kinds)).toMatchObject({ with: 'core:throwing_knife', adjacent: 'throw' });
    const fled = newMemory(); fled.fled = ['e_grd001'];
    expect(fightArgs(o, ordersOf({ fight_with: 'melee' }).policy, fled, 'e_grd001', kinds, stats)).not.toHaveProperty('with');
  });
  it('warden_decision carries the numbers of the earlier fights (melee and throws, hits and per hit, the stage)', () => {
    const camp = { ...fieldObs(), status: 'at_camp', self: { ...fieldObs().self, pos: null, floor: null }, camp: { next_no: 9, milestone: { depth: 5, name: '石の番人', cleared: false, text: '節目' }, offers: [{ index: 1, type: 'slay_warden', target_depth: 5, points: 100, text: '節目に挑む', multiplier_pct: 100, recommended_level: 6, level_gap: 0, trait_danger: 0, slot: 'safe' }] } } as unknown as Observation;
    const r = decide(camp, ctx(defaultOrders(), { fightStats: new Map([['6:e_grd001', stat({ mHits: 58, mDealt: 174, stage: 'wounded' })]]) }));
    expect(summary(r)).toBe('escalate:warden_decision');
    const d = r.decision.kind === 'wake' ? r.decision.wake.detail : '';
    expect(d).toContain('前の戦い');
    expect(d).toContain('近接 当てた 58 回・1 回あたり 3.0');
    expect(d).toContain('fight_with');
  });
  it('the objective not getting through (noThrough): not engaged again', () => {
    const g = mon({ id: 'e_grd001', role: 'guardian', objective: true, guardian: { name: 'カベルキ', types: [] } as never, dist: 3, pos: { x: 23, y: 10 } });
    const od = ordersOf({ engage_objective: true });
    expect(summary(decide(fieldObs({ monsters: [g] }), ctx(od)))).toMatch(/^act:fight:\{"target":"e_grd001"/);
    expect(summary(decide(fieldObs({ monsters: [g] }), ctx(od, { noThrough: new Set(['e_grd001']) })))).not.toMatch(/e_grd001/);
  });
});

describe('V4-1k §32.2: 目的の相手を、覚えている地図の通れるマスからも探す', () => {
  it('patrol candidates include the known map cells; the exact sense direction first (8 sectors, not signs)', () => {
    const o = fieldObs({ sense: { dir: 'e', range: 'far' }, objective: { type: 'slay_guardian', target_depth: 3 } });
    const mem = newMemory();
    // 立ったマスは西だけ（東の部屋に立ったことが無い）。地図には東の部屋がある
    const walked = [{ x: 5, y: 10 }, { x: 8, y: 12 }];
    const map = [{ x: 5, y: 10 }, { x: 34, y: 11 }, { x: 33, y: 12 }, { x: 22, y: 25 }];
    expect(patrolTarget(o, mem, walked)).toEqual({ x: 5, y: 10 });
    expect(patrolTarget(o, mem, walked, map)).toEqual({ x: 34, y: 11 });
    // 南の気配: 符号だけで見ると 1 マスでも南なら「南」になり、西の端を選んでいた。8 方位で見て、真南を先に
    const os = fieldObs({ sense: { dir: 's', range: 'far' } });
    expect(patrolTarget(os, mem, [], [{ x: 2, y: 11 }, { x: 21, y: 24 }])).toEqual({ x: 21, y: 24 });
  });
  it('reads the passable known cells from the get_map data (blank = unknown, impassable terrain by name)', () => {
    const cells = mapCellsOf({ origin: { x: 10, y: 5 }, rows: ['#.#', '#@ +'], legend: { '#': '壁', '.': '床', '@': '自分', '+': '扉' } }, new Set(['壁']));
    expect(cells).toEqual([{ x: 11, y: 5 }, { x: 11, y: 6 }, { x: 13, y: 6 }]);
  });
});

describe('V4-1k §32.3: 協力プレイで、ついていく動き', () => {
  const lead = (o: Partial<ObsPartyMember>) => member({ order: 1, controller: 'human', ...o });
  const followMem = () => { const m = newMemory(); m.follow = { id: 'p_h', exp: 6, met: true, inDungeon: true, lastPos: { x: 2, y: 2 }, lastFloor: 3, floorAtStart: 3, startTurn: 0 }; return m; };
  it('follows the ally’s current position (not the last seen one); an unknown cell → the nearest known cell; at it, explore', () => {
    const o = fieldObs({ party: [lead({ pos: [40, 10] })], frontiers: 2 });
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: followMem() })))).toBe('act:travel_to:{"to":{"x":40,"y":10}}');
    expect(allyDest(lead({ pos: [40, 10] }), [{ x: 30, y: 10 }, { x: 38, y: 11 }])).toEqual({ x: 38, y: 11 });
    expect(allyDest(lead({ pos: [40, 10], entity: 'e_h00001' }), [{ x: 30, y: 10 }])).toBe('e_h00001');
    // 覚えているいちばん近い所にいる: 探索で見に行く
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: followMem(), mapCells: [{ x: 21, y: 10 }] })))).toMatch(/^act:explore:/);
  });
  it('the ally standing on stairs: goes next to it even within follow_distance (no explore/collect); next to it: waits', () => {
    const st = { type: 'down' as const, pos: { x: 24, y: 10 }, dist: 4, reachable: true, path_len: 4 };
    const o = fieldObs({ party: [lead({ pos: [24, 10], entity: 'e_h00001' })], stairs: [st], frontiers: 3 });
    const r = decide(o, ctx(defaultOrders(), { coop: true, mem: followMem() }));
    expect(summary(r)).toBe('act:travel_to:{"to":"e_h00001"}');
    expect(r.notify.some((n) => n.reason === 'leader_on_stairs')).toBe(true);
    const near = fieldObs({ party: [lead({ pos: [21, 10], entity: 'e_h00001' })], stairs: [{ ...st, pos: { x: 21, y: 10 }, dist: 1 }], frontiers: 3 });
    expect(summary(decide(near, ctx(defaultOrders(), { coop: true, mem: followMem() })))).toBe('act:wait:{}');
  });
  it('the ally went home: goes home at once (no fighting, no resting; only a blocker is hit)', () => {
    const m = followMem();
    const home = lead({ status: 'at_camp', floor: undefined });
    const up = { type: 'up' as const, pos: { x: 5, y: 10 }, dist: 15, reachable: true, path_len: 15 };
    const r = decide(fieldObs({ hp: 15, party: [home], stairs: [up], monsters: [mon({ id: 'e_foe001', dist: 3, pos: { x: 23, y: 10 } })] }), ctx(defaultOrders(), { coop: true, mem: m }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"stairs_up"/);
    expect(r.decision.kind === 'act' && r.decision.why).toBe('return');
  });
  it('assisting: against a shooter, the usual retries (wait → advance → throw)', () => {
    const hurt = lead({ hp: 'badly_wounded', pos: [22, 10], entity: 'e_h00001' });
    const shooter = mon({ id: 'e_sht001', dist: 6, pos: { x: 26, y: 10 }, traits: ['ranged'] });
    const kinds = new Set(['core:throwing_knife']);
    const o = fieldObs({ party: [hurt], monsters: [shooter], throws: true });
    const m = followMem(); m.assisting = true;
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: m, throwKinds: kinds })))).toMatch(/^act:fight:\{"target":"e_sht001","hp_floor":\d+\}$/);
    const m2 = { ...m, stops: { e_sht001: 1 }, advance: ['e_sht001'], away: ['e_sht001'] };
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: m2, throwKinds: kinds })))).toMatch(/"approach":"advance"/);
    const m3 = { ...m2, stops: { e_sht001: 2 } };
    expect(summary(decide(o, ctx(defaultOrders(), { coop: true, mem: m3, throwKinds: kinds })))).toMatch(/"with":"core:throwing_knife"/);
  });
});

describe('V4-1k §32.4: 小さな直し', () => {
  it('camp is raised once per expedition end (answered: idle, not raised again); stalled at camp carries the expedition result', () => {
    const camp = { ...fieldObs(), status: 'at_camp', self: { ...fieldObs().self, pos: null, floor: null }, expedition: { ...fieldObs().expedition, status: 'ended', result: { text: '遠征 6 は終了した（撤退）。確定 +120' } }, camp: { next_no: 7, offers: [{ index: 1, type: 'reach_depth', target_depth: 3, points: 100, text: '1', multiplier_pct: 100, recommended_level: 2, level_gap: 0, trait_danger: 0, slot: 'safe' }] } } as unknown as Observation;
    expect(summary(decide(camp, ctx()))).toBe('wake:camp');
    expect(summary(decide(camp, ctx(defaultOrders(), { acked: new Set(['camp:7']) })))).toBe('idle');
    const st = decide(camp, ctx(defaultOrders(), { stalled: '直近 3 回の遠征が空回り' }));
    expect(summary(st)).toBe('escalate:stalled');
    expect(st.decision.kind === 'wake' && st.decision.wake.detail).toContain('確定 +120');
  });
  it('waiting on the stairs as the leader: the wait command’s why is stairs_hold', () => {
    const onDown = { type: 'down' as const, pos: { x: 20, y: 10 }, dist: 0, reachable: true, path_len: 0 };
    const r = decide(fieldObs({ stairs: [onDown], party: [member({ order: 2, controller: 'agent' })] }), ctx(defaultOrders(), { coop: true, turnNo: 10 }));
    expect(r.decision.kind === 'act' && `${r.decision.tool}:${r.decision.why}`).toBe('wait:stairs_hold');
  });
  it('no rest while a hunting enemy that reaches is in view (a stationary one next to me counts too, as in the game)', () => {
    const turret = mon({ id: 'e_trt001', dist: 1, traits: ['stationary'] });
    const r = decide(fieldObs({ hp: 10, monsters: [turret] }), ctx());
    expect(r.decision.kind === 'act' && r.decision.tool === 'rest').toBe(false);
    const far = mon({ id: 'e_trt001', dist: 5, pos: { x: 25, y: 10 }, traits: ['stationary'] });
    const r2 = decide(fieldObs({ hp: 10, monsters: [far] }), ctx(defaultOrders(), { mem: { ...newMemory(), recovering: true } }));
    expect(r2.decision.kind === 'act' && r2.decision.tool).toBe('rest');
  });
});

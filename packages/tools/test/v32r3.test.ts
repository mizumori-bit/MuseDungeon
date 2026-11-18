// V3-2R3（IMPROVEMENTS_V3 §20）の完了の定義: 到達の条件（目標階の下り階段）、守護者の格と見込み、候補の基準（達成した最深の階）、
// 生成済みの目標階への配置、即時の綱、1 手番の最悪の被害、被弾の前に止まる fight、守護者の記録、撃破の経験値と宝、同じか劣る装備、短い説明。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { applyEvent, buildObservation, deepestGenerated, memoryKey, pickableItems, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);

async function newRun(seed: string, opts: { classId?: string; objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' | 'endless' | null } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: opts.classId, controller: { kind: 'agent', label: 't' }, ...(opts.objective === null ? {} : { objective: opts.objective ?? 'auto' }) });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const place = (x: number, y: number, floor = me().pos!.floor) => { const e = structuredClone(me()); e.pos = { floor, x, y }; inject({ put: [e] }); };
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  /** 今いる階の下り階段で手番を終え、降りる */
  const crossAndDescend = async () => {
    const f = world.floors[me().pos!.floor];
    place(f.stairs.down[0].x, f.stairs.down[0].y);
    await act({ type: 'wait' });
    const s = await act({ type: 'stairs' });
    clearMonsters();
    return s;
  };
  return { manager, r, world, pid, meId, inject, me, place, clearMonsters, act, obs, crossAndDescend };
}

let sid = 990000;
function monster(id: string, kind: string, floor: string, x: number, y: number, o: { hp?: number; speed?: number; acc?: number; xp?: number; role?: 'guardian'; affixes?: string[] } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed: o.speed ?? 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
    ...(o.xp !== undefined ? { xp: o.xp } : {}),
    ...(o.role ? { role: o.role } : {}),
    ...(o.affixes ? { scale: { tier: 0, affixes: o.affixes } } : {}),
  };
}

function passable(world: World, key: string, x: number, y: number): boolean {
  const f = world.floors[key];
  return x >= 0 && y >= 0 && x < f.width && y < f.height && content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]].passable
    && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
}

function openLine(world: World, key: string, n: number): { p: { x: number; y: number }; dx: number; dy: number } {
  const f = world.floors[key];
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      let ok = true;
      for (let k = 0; k <= n && ok; k++) if (!passable(world, key, x + dx * k, y + dy * k)) ok = false;
      if (ok) return { p: { x, y }, dx, dy };
    }
  }
  throw new Error('no open line');
}

function setMemory(t: Awaited<ReturnType<typeof newRun>>, key: string, mem: Record<string, unknown>) {
  applyEvent(t.world, { type: 'monster_memory_updated', player: t.pid, kind: key, memoryAfter: { kind: key.replace('guardian|', ''), encounters: 3, kills: 1, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...mem }, seq: t.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [t.pid] } as unknown as GameEvent);
}

describe('V3-2R3 objectives and offers (§20.1, §20.2)', () => {
  it('reach_depth completes on the target floor’s down stairs, not on arrival; the next offers count from the achieved target, not the crossing', async () => {
    const t = await newRun('v32r3-reach-1');
    t.clearMonsters();
    expect(t.world.expeditions![0].objective).toMatchObject({ type: 'reach_depth', targetDepth: 2 });
    await t.crossAndDescend(); // 地下1階 → 地下2階（目標）
    await t.act({ type: 'wait' });
    expect(t.world.expeditions![0].status).toBe('in_progress');
    expect(t.obs().expedition!.objective.text).toContain('踏破');
    await t.crossAndDescend(); // 地下2階の下り階段に立って達成 → 地下3階
    expect(t.world.expeditions![0].status).toBe('objective_complete');
    await t.crossAndDescend(); // 地下3階を踏破 → 地下4階
    const f4 = t.world.floors[t.me().pos!.floor];
    t.place(f4.stairs.down[0].x, f4.stairs.down[0].y);
    await t.act({ type: 'wait' });
    expect(t.obs().expedition!.haul!.next_camp!.min_target_depth).toBe(3);
    const ex = await t.act({ type: 'extract' });
    expect(ex.ok).toBe(true);
    const offers = t.world.camp!.offers;
    // 堅実 +1・標準 +2・野心 +3（達成した目標の地下2階から）。地下5階は節目の大守護者の階なので、野心は 1 つ深い 6 階（V3-3 §3.2）
    expect(offers.find((o) => o.slot === 'safe')!.objective.targetDepth).toBe(3);
    expect(offers.find((o) => o.slot === 'standard')!.objective.targetDepth).toBe(4);
    expect(offers.find((o) => o.slot === 'ambitious')!.objective.targetDepth).toBe(6);
    // 下り階段にすでに立った階（地下3・4階）には踏破型を出さない
    for (const o of offers) if (o.objective.type === 'reach_depth') expect(o.objective.targetDepth!).toBeGreaterThanOrEqual(deepestGenerated(t.world));
  });

  it('guardian rank follows the slot; offers carry a forecast but never the species; safe relics are unguarded', async () => {
    let checked = 0;
    for (let i = 0; i < 12; i++) {
      const t = await newRun(`v32r3-offer-${i}`, { objective: null });
      const v = t.r.port.view();
      expect(JSON.stringify(v.camp)).not.toContain('guardianKind');
      for (const o of t.world.camp!.offers) {
        if (o.slot === 'safe' && o.objective.type === 'retrieve_relic') expect(o.relicGuarded).toBe(false);
        if (o.objective.type === 'slay_guardian' || o.relicGuarded) {
          expect(o.guardian?.rank).toBe(o.slot === 'safe' ? 1 : o.slot === 'standard' ? 2 : 3);
          expect(o.guardianKind).toBeTruthy();
          checked++;
        }
      }
      const text = t.obs().camp!.offers.map((o) => o.text).join('\n');
      if (t.world.camp!.offers.some((o) => o.guardian)) expect(text).toMatch(/守護者(「[^」]+」)?: 格/);
      t.manager.closeAll();
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('rank 1 guardians come from the lower half without kiting shooters and get less HP; rank 3 get more', () => {
    const [r1, , r3] = content.balance.guardian.ranks;
    for (let i = 0; i < 30; i++) {
      for (const depth of [2, 4, 6]) {
        const g1 = generateFloor(content, `v32r3-g-${i}`, 'main', depth, content.terrain.map((tt) => tt.id), { guardian: true, relic: false, rank: 1 });
        const s1 = g1.spawns.find((s) => s.type === 'monster' && s.role === 'guardian');
        if (s1?.type === 'monster') {
          expect(content.monsters[s1.kind].ai.archetype).not.toBe('ranged_kiter');
          expect(s1.hpBonusPct).toBe(r1.hpPct);
          expect(s1.minHp).toBe(r1.minHpBase + r1.minHpPerDepth * depth);
        }
        const g3 = generateFloor(content, `v32r3-g-${i}`, 'main', depth, content.terrain.map((tt) => tt.id), { guardian: true, relic: false, rank: 3 });
        const s3 = g3.spawns.find((s) => s.type === 'monster' && s.role === 'guardian');
        if (s3?.type === 'monster') expect(s3.hpBonusPct).toBe(r3.hpPct);
      }
    }
  });

  it('a target floor that already exists gets its guardian when the expedition starts', async () => {
    // 遠征 1: 地下2階を踏破して地下3階へ降り、地下3階を生成させてから帰る
    const t = await newRun('v32r3-exist-1');
    t.clearMonsters();
    await t.crossAndDescend();
    await t.crossAndDescend();
    const f3 = t.world.floors[t.me().pos!.floor];
    t.place(f3.stairs.up!.x, f3.stairs.up!.y);
    await t.act({ type: 'wait' });
    expect((await t.act({ type: 'extract' })).ok).toBe(true);
    // 地下3階（生成済み）を目標にする守護者か遺物の候補を選ぶ
    const o = t.world.camp!.offers.find((x) => x.objective.targetDepth === 3 && (x.objective.type === 'slay_guardian' || x.objective.type === 'retrieve_relic'));
    if (!o) return;
    expect(t.world.floors['main:3']).toBeTruthy();
    const s = await t.act({ type: 'start_expedition', offer: o.index });
    expect(s.ok).toBe(true);
    const x = t.world.expeditions![1];
    const id = o.objective.type === 'slay_guardian' ? x.targets.guardian : x.targets.relic;
    expect(id).toBeTruthy();
    expect(t.world.entities[id!].pos?.floor).toBe('main:3');
    if (o.objective.type === 'slay_guardian' && o.guardianKind) expect(t.world.entities[id!].kind).toBe(o.guardianKind);
    // 2 回目以降の遠征の開始の説明は 1 行
    if (s.ok) expect(s.briefing?.length).toBe(1);
  });
});

describe('V3-2R3 lifeline and reading danger (§20.3, §20.4)', () => {
  it('the lifeline returns you to camp in the same turn', async () => {
    const t = await newRun('v32r3-life-1');
    t.clearMonsters();
    const slot = t.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    const turns0 = t.me().actor!.turns;
    const r = await t.act({ type: 'use', slot });
    expect(r.ok).toBe(true);
    expect(t.r.port.view().status).toBe('at_camp');
    expect(t.world.expeditions![0].endReason).toBe('lifeline');
    expect(t.me().actor!.turns - turns0).toBeLessThanOrEqual(1);
  });

  it('worst_turn doubles for faster enemies; two turns of it can kill you; size and armored are visible', async () => {
    const t = await newRun('v32r3-turn-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r3wt01', 'core:jackal', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3, { speed: 120 }), monster('e_r3wt02', 'core:cave_troll', key, ln.p.x + ln.dx * 2, ln.p.y + ln.dy * 2, { speed: 80 })] });
    await t.act({ type: 'wait' }); // 視界を更新する
    setMemory(t, 'core:jackal', { maxDamageToYou: 5 });
    setMemory(t, 'core:cave_troll', { maxDamageToYou: 4 });
    const me = structuredClone(t.me());
    me.stats!.hp = 17;
    t.inject({ put: [me] });
    delete t.world.players[t.pid].knowledge.paceSeen; // 2 回動いたのを見た直後は 1 回と数える（V3-8 §53.4）。ここでは素の数え方を見る
    const view = projectPlayerView(t.world, t.pid);
    const o = buildObservation(view, catalog, { detail: 'brief', map: false });
    const jackal = o.visible.monsters.find((m) => m.id === 'e_r3wt01');
    const troll = o.visible.monsters.find((m) => m.id === 'e_r3wt02');
    if (!jackal || !troll) return;
    expect(jackal.worst_turn).toBe(10);
    expect(troll.worst_turn).toBe(4);
    expect(troll.size).toBe('large');
    expect(troll.traits).toContain('armored');
    // 合計 14 < HP 17、× 2 = 28 ≥ 17
    expect(o.alerts.some((a) => a.code === 'lethal_2turns')).toBe(true);
  });

  it('fight stops before the hit that would break hp_floor, and once at the first hit from an unrecorded creature', async () => {
    const t = await newRun('v32r3-fight-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r3ft01', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 60, acc: 30 })] });
    setMemory(t, 'core:goblin', { maxDamageToYou: 6 });
    const me = structuredClone(t.me());
    me.stats!.hp = 20;
    t.inject({ put: [me] });
    await t.act({ type: 'wait' });
    if (!t.obs().visible.monsters.some((m) => m.id === 'e_r3ft01' && m.dist === 1)) return;
    // HP 20 − 最悪 6 = 14 < hp_floor 15 → 被弾の前に止まる（始める前なら手番を使わずに拒否）
    const refused = await t.act({ type: 'fight', target: 'e_r3ft01', hpFloor: 15 });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('hp_floor');
    // 記録の無い種族（守護者の記録は別）: 初めて被弾したら一度止まる（最大 HP の 15% 以上の被弾のとき。V3-3a §35.6）
    t.clearMonsters();
    const me2 = structuredClone(t.me());
    me2.stats!.hp = me2.stats!.maxHp;
    // 視界はすでに隣のマスを含む（待つと相手が先に攻撃して記録ができてしまうので、待たずに戦う）
    const jk = monster('e_r3ft02', 'core:jackal', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 200, acc: 40 });
    jk.stats!.dmg = `${Math.ceil(me2.stats!.maxHp * 0.2)}d1`;
    t.inject({ put: [me2, jk] });
    if (!t.obs().visible.monsters.some((m) => m.id === 'e_r3ft02' && m.dist === 1)) return;
    if ((t.r.port.view().monsterMemory['core:jackal']?.maxDamageToYou ?? 0) > 0) return;
    const f = await t.act({ type: 'fight', target: 'e_r3ft02', hpFloor: 0 });
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.interrupted_by).toBe('first_hit');
  });

  it('guardians keep their own memory; kill XP grows with depth; large and affixed monsters drop a treasure', async () => {
    const t = await newRun('v32r3-mem-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r3gm01', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 1, role: 'guardian', xp: 10 })] });
    await t.act({ type: 'wait' });
    const s0 = t.world.seq;
    for (let i = 0; i < 20 && t.world.entities.e_r3gm01; i++) await t.act({ type: 'move', dir: (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).find((d) => { const v = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] }[d]; return t.me().pos!.x + v[0] === ln.p.x + ln.dx && t.me().pos!.y + v[1] === ln.p.y + ln.dy; })! });
    if (t.world.entities.e_r3gm01) return;
    const mem = t.r.port.view().monsterMemory;
    expect(mem[memoryKey('core:goblin', 'guardian')]?.kills).toBe(1);
    expect(mem['core:goblin']?.kills ?? 0).toBe(0);
    // 深度 1 なので経験値は素のまま（10）
    const xp = t.r.session.history.filter((e) => e.seq > s0 && e.type === 'xp_gained').reduce((a, e) => a + (e.type === 'xp_gained' ? e.amount : 0), 0);
    expect(xp).toBe(10);
    // 大柄な種族は宝を落とす
    const s1 = t.world.seq;
    t.inject({ put: [monster('e_r3gm02', 'core:cave_troll', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 1, xp: 35 })] });
    await t.act({ type: 'wait' });
    for (let i = 0; i < 20 && t.world.entities.e_r3gm02; i++) await t.act({ type: 'move', dir: (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).find((d) => { const v = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] }[d]; return t.me().pos!.x + v[0] === ln.p.x + ln.dx && t.me().pos!.y + v[1] === ln.p.y + ln.dy; })! });
    if (t.world.entities.e_r3gm02) return;
    const drops = t.r.session.history.filter((e) => e.seq > s1 && e.type === 'entity_spawned' && e.reason === 'drop');
    expect(drops.some((e) => e.type === 'entity_spawned' && content.items[e.entity.kind]?.category === 'treasure')).toBe(true);
  });

  it('explore and collect skip same-or-worse equipment', async () => {
    const t = await newRun('v32r3-eq-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x, ln.p.y);
    const weapon = t.r.port.view().inventory.find((i) => i.equipped === 'weapon')!;
    const same: Entity = { id: 'e_r3eq01', kind: weapon.kind!, sid: 999001, pos: { floor: key, x: ln.p.x + ln.dx, y: ln.p.y + ln.dy }, item: { qty: 1, affixes: [] } };
    const better: Entity = { id: 'e_r3eq02', kind: weapon.kind!, sid: 999002, pos: { floor: key, x: ln.p.x + ln.dx * 2, y: ln.p.y + ln.dy * 2 }, item: { qty: 1, affixes: ['core:keen'] } };
    t.inject({ put: [same, better] });
    await t.act({ type: 'wait' });
    const ids = pickableItems(t.r.port.view(), catalog).map((x) => x.id);
    if (!t.r.port.view().entities.some((e) => e.id === 'e_r3eq01')) return;
    expect(ids).not.toContain('e_r3eq01');
    expect(ids).toContain('e_r3eq02');
  });
});

describe('V3-2R3a restart and shooters (§22)', () => {
  it('after a lifeline the next expedition starts where the last one began; the restart floor settles (no hunters, full HP, nobody watching the restart cell)', async () => {
    const t = await newRun('v32r3a-restart-1');
    t.clearMonsters();
    const startPos = { ...t.world.expeditions![0].start[t.pid].pos! };
    // 地下1階で入口から離れ、追跡中で手負いの敵を置いてから綱
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    const near = monster('e_r3as01', 'core:goblin', key, ln.p.x + ln.dx * 2, ln.p.y + ln.dy * 2, { hp: 20 });
    near.stats!.hp = 5;
    // 再開地点が見える位置の敵（入口の 2 マス先）
    let spot: { x: number; y: number } | null = null;
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) if (!spot && passable(t.world, startPos.floor, startPos.x + dx, startPos.y + dy)) spot = { x: startPos.x + dx, y: startPos.y + dy };
    const watcher = monster('e_r3as02', 'core:jackal', startPos.floor, spot!.x, spot!.y);
    t.inject({ put: [near, watcher] });
    const slot = t.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    expect((await t.act({ type: 'use', slot })).ok).toBe(true);
    expect(t.r.port.view().status).toBe('at_camp');
    expect(t.world.players[t.pid].extractPos).toMatchObject({ floor: startPos.floor, x: startPos.x, y: startPos.y });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const me = t.me().pos!;
    expect(me.floor).toBe(startPos.floor);
    expect(Math.max(Math.abs(me.x - startPos.x), Math.abs(me.y - startPos.y))).toBeLessThanOrEqual(2);
    const g = t.world.entities.e_r3as01;
    if (g) {
      expect(g.stats!.hp).toBe(g.stats!.maxHp);
    }
    for (const id of ['e_r3as01', 'e_r3as02']) {
      const m = t.world.entities[id];
      if (!m) continue;
      expect(['unaware', 'asleep']).toContain(m.actor!.ai!.state === 'asleep' ? 'asleep' : m.actor!.ai!.state);
    }
    // 見張っていた敵は再開地点から 12 マス以上離れた
    const w = t.world.entities.e_r3as02;
    expect(Math.max(Math.abs(w.pos!.x - startPos.x), Math.abs(w.pos!.y - startPos.y))).toBeGreaterThanOrEqual(content.balance.teleport.minDistance);
  });

  it('a hunting shooter is not offered as a "meet it" fight; the advice is to close in or break line of sight', async () => {
    const t = await newRun('v32r3a-shoot-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 5);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r3sh01', 'core:goblin_slinger', key, ln.p.x + ln.dx * 5, ln.p.y + ln.dy * 5)] });
    await t.act({ type: 'wait' });
    const o = t.obs();
    const m = o.visible.monsters.find((x) => x.id === 'e_r3sh01');
    if (!m || m.awareness !== 'hunting' || m.dist <= 1) return;
    expect(o.valid_actions.some((a) => a.startsWith('fight e_r3sh01 (') && a.includes('迎え撃つ'))).toBe(false);
    expect(o.valid_actions.some((a) => a.startsWith('travel_to e_r3sh01') && a.includes('視線を切る'))).toBe(true);
  });
});

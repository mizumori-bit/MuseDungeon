// V3-3 の後の AI 評価（IMPROVEMENTS_V3 §34）で見つかった不具合の再現と修正の確認。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, PlayerView } from '@muse/shared';
import { applyEvent, buildObservation, formatObservationText, macroNext, macroStart, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 950000;

async function newRun(seed: string, opts: { classId?: string; objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: opts.classId ?? 'core:warrior', controller: { kind: 'agent', label: 't' }, ...(opts.objective ? { objective: opts.objective } : {}) });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject({ put: [e] }); };
  const place = (x: number, y: number) => edit((e) => { e.pos = { floor: e.pos!.floor, x, y }; });
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player && !e.guardian?.warden).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  const view = () => projectPlayerView(world, pid);
  const toDownStairs = async () => {
    const f = world.floors[me().pos!.floor];
    place(f.stairs.down[0].x, f.stairs.down[0].y);
    clearMonsters();
    await act({ type: 'wait' });
  };
  const descend = async () => { await toDownStairs(); const s = await act({ type: 'stairs' }); clearMonsters(); return s; };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, obs, view, toDownStairs, descend };
}

function monster(id: string, floor: string, x: number, y: number, o: { hp?: number; kind?: string; affixes?: string[]; nextActAt?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind: o.kind ?? 'core:goblin', sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: o.nextActAt ?? 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' },
    base: { maxHp: hp, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' },
    statuses: [],
    ...(o.affixes ? { scale: { tier: 0, affixes: o.affixes } } : {}),
  };
}

describe('V3-3 evaluation fixes: fight waiting', () => {
  it('stops with hit_and_run when the target hits you while you wait and is not adjacent; stops after 3 waits without it closing in', async () => {
    const a = await arena('v33e-fight', { map: ['P.....G'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [] }, player: { hp: 60 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 0 }, catalog);
    expect('command' in macroNext(st, v, catalog, [])).toBe(true);
    const hit = [{ type: 'attack', attacker: a.gId, target: v.self.id, hit: true, seq: 1 }] as never;
    expect(macroNext(st, v, catalog, hit)).toEqual({ stop: 'hit_and_run' });
    // 近づかない相手: 同じ距離のまま 3 回待つと止まる
    const st2 = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 0 }, catalog);
    const seen: unknown[] = [];
    for (let k = 0; k < 6; k++) { const d = macroNext(st2, v, catalog, []); seen.push(d); if ('stop' in d) break; }
    expect(seen[seen.length - 1]).toEqual({ stop: 'target_not_approaching' });
    expect(seen.length).toBeLessThanOrEqual(5);
    a.manager.closeAll();
  });
});

describe('V3-3 evaluation fixes: movement macros', () => {
  it('a movement macro going back and forth between two cells stops with no_progress', async () => {
    const t = await newRun('v33e-osc-1', { objective: 'reach_depth' });
    t.clearMonsters();
    const v0 = t.view();
    const p = t.me().pos!;
    const f = t.world.floors[p.floor];
    const pass = (x: number, y: number) => !!content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[y * f.width + x]]]]?.passable;
    const b = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find((c) => pass(c.x, c.y))!;
    // 行き先は見えている（記憶した）床のうち 3 マス以上離れたマス
    const fk = t.world.players[t.pid].knowledge.floors[p.floor];
    let dest = { x: p.x, y: p.y };
    for (let i = 0; i < fk.seen.length; i++) {
      const x = i % f.width, y = Math.trunc(i / f.width);
      if (fk.seen[i] && pass(x, y) && Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) >= 3) { dest = { x, y }; break; }
    }
    const st = macroStart(v0, { type: 'travel', to: dest }, catalog);
    const at = (q: { x: number; y: number }) => ({ ...v0, self: { ...v0.self, pos: { ...v0.self.pos!, x: q.x, y: q.y } } }) as PlayerView;
    const seq = [p, b, p, b, p];
    let last: unknown = null;
    for (const q of seq) { last = macroNext(st, at(q), catalog, []); st.steps += 1; if ('stop' in (last as object)) break; }
    expect(last).toEqual({ stop: 'no_progress' });
    t.manager.closeAll();
  });
});

describe('V3-3 evaluation fixes: offers', () => {
  it('no reach offer for a floor whose stairs down you already stood on (several seeds)', async () => {
    for (let i = 0; i < 8; i++) {
      const t = await newRun(`v33e-crossed-${i}`, { objective: 'reach_depth' });
      expect((await t.descend()).ok).toBe(true);
      expect((await t.descend()).ok).toBe(true);
      await t.toDownStairs();
      expect((await t.act({ type: 'extract' })).ok).toBe(true);
      for (const o of t.world.camp!.offers) if (o.objective.type === 'reach_depth') expect(o.objective.targetDepth!).toBeGreaterThan(3);
      t.manager.closeAll();
    }
  });

  it('no reach offer for a crossed floor; offers past the warden say so; the sealed crossing is marked', async () => {
    const t = await newRun('v33e-reach-1', { objective: 'reach_depth' });
    expect(t.world.expeditions![0].objective.targetDepth).toBe(2);
    expect((await t.descend()).ok).toBe(true); // 地下2階
    expect((await t.descend()).ok).toBe(true); // 地下2階の下り階段で達成 → 地下3階
    await t.toDownStairs(); // 地下3階の下り階段に立つ（踏破）
    expect(t.world.expeditions![0].progress.crossedDepth).toBe(3);
    expect((await t.act({ type: 'extract' })).ok).toBe(true);
    const offers = t.world.camp!.offers;
    for (const o of offers) if (o.objective.type === 'reach_depth') expect(o.objective.targetDepth!).toBeGreaterThan(3);
    const past = offers.filter((o) => o.objective.targetDepth! > 5);
    expect(past.length).toBeGreaterThan(0);
    const texts = t.obs().camp!.offers.map((o) => o.text);
    for (const o of past) {
      expect(o.passesWarden?.depth).toBe(5);
      expect(texts[o.index - 1]).toContain('途中の地下5階で大守護者');
    }
    // 次の候補の下限は節目の階を飛ばす（地下4階の目標を達成した後の見込みは地下6階以上）
    const d4 = offers.find((o) => o.objective.targetDepth === 4);
    if (d4) {
      expect((await t.act({ type: 'start_expedition', offer: d4.index })).ok).toBe(true);
      while (t.world.floors[t.me().pos!.floor].depth < 4) expect((await t.descend()).ok).toBe(true);
      if (d4.objective.type === 'reach_depth') {
        await t.toDownStairs();
        const haul = t.obs().expedition!.haul!;
        expect(haul.text).toContain('大守護者を倒すまで封じられている');
        expect(haul.next_camp!.min_target_depth).not.toBe(5);
      }
    }
    t.manager.closeAll();
  });

  it('quiet and restless never come together', async () => {
    for (let i = 0; i < 40; i++) {
      const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
      const r = await manager.createRun({ name: 'R', seed: `v33e-traits-${i}`, controller: { kind: 'agent', label: 't' } });
      if ('error' in r) throw new Error(r.error.message);
      for (const o of r.session.world.camp!.offers) expect((o.traits ?? []).includes('core:quiet') && (o.traits ?? []).includes('core:restless')).toBe(false);
      manager.closeAll();
    }
  });
});

describe('V3-3 evaluation fixes: guardians', () => {
  it('a stalker + enrager warden still rages (the enrager acts before the stalker)', async () => {
    const a = await arena('v33e-rage', { map: ['.......', 'P.....G', '.......'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', types: ['core:stalker', 'core:enrager'] }, player: { hp: 60 } });
    const g = structuredClone(a.world.entities[a.gId]);
    g.stats!.hp = 18;
    a.inject({ put: [g] });
    let raged = false;
    for (let k = 0; k < 4 && !raged; k++) { await a.r.port.act({ type: 'wait' }, { source: 'bot' }); raged = !!a.world.entities[a.gId]?.guardian?.enraged; }
    expect(raged).toBe(true);
    a.manager.closeAll();
  });

  it('a lit ward fire next to you is offered as interact; once out, it is not', async () => {
    const a = await arena('v33e-fire', { map: ['PF....G'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', types: ['core:warded'], state: 'unaware' }, player: { hp: 60 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(a.r.port.observe({ map: false }).observation.valid_actions.some((x) => x.startsWith('interact e'))).toBe(true);
    expect((await a.r.port.act({ type: 'interact', dir: 'e' }, { source: 'bot' })).ok).toBe(true);
    expect(a.r.port.observe({ map: false }).observation.valid_actions.some((x) => x.startsWith('interact e'))).toBe(false);
    a.manager.closeAll();
  });

  it('a guardian of a known species is not "first seen", and gets no HP estimate from another guardian', async () => {
    const a = await arena('v33e-first', { map: ['P...G'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', types: [], state: 'unaware' }, player: { hp: 60 } });
    const k = a.world.players[a.pid].knowledge;
    k.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 3, kills: 2, maxDamageToYou: 0, maxDamageByYou: 3, abilities: [], hpSeen: { min: 5, max: 7, samples: 2 } } as never;
    k.monsterMemory['guardian|core:goblin'] = { kind: 'core:goblin', encounters: 1, kills: 1, maxDamageToYou: 0, maxDamageByYou: 3, abilities: [], hpSeen: { min: 14, max: 14, samples: 1 } } as never;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const m = a.r.port.observe({ map: false }).observation.visible.monsters.find((x) => x.id === a.gId)!;
    expect(m.first_seen).toBeUndefined();
    expect(m.hp_left_est).toBeUndefined();
    expect(a.r.port.look(a.gId).text).not.toContain('推定残りHP');
    a.manager.closeAll();
  });
});

describe('V3-3 evaluation fixes: camp, summaries and valid actions', () => {
  it('a settled floor clears statuses and resets the damage you saw', async () => {
    const t = await newRun('v33e-settle-1', { objective: 'reach_depth' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const dn = f.stairs.down[0];
    const near = [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2]].map(([dx, dy]) => ({ x: dn.x + dx, y: dn.y + dy }))
      .find((p) => content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[p.y * f.width + p.x]]]]?.passable)!;
    const m = monster('e_st0001', key, near.x, near.y, { hp: 30 });
    m.stats!.hp = 20;
    m.statuses = [{ id: 'core:poison', turnsLeft: 9, power: 1, source: null }];
    t.inject({ put: [m] });
    t.world.players[t.pid].knowledge.damageSeen = { e_st0001: 10 };
    t.place(dn.x, dn.y);
    expect((await t.act({ type: 'extract', confirm: true })).ok).toBe(true);
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const after = t.world.entities.e_st0001;
    expect(after.stats!.hp).toBe(30);
    expect(after.statuses ?? []).toEqual([]);
    expect(t.world.players[t.pid].knowledge.damageSeen?.e_st0001).toBeUndefined();
    t.manager.closeAll();
  });

  it('fight until:clear names affixed kills and guardians; slip lists every way out; unreachable stairs are marked; the floor type shows in the header', async () => {
    const t = await newRun('v33e-misc-1', { classId: 'core:scout', objective: 'reach_depth' });
    t.clearMonsters();
    const p = t.me().pos!;
    const f = t.world.floors[p.floor];
    const pass = (x: number, y: number) => !!content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[y * f.width + x]]]]?.passable;
    const cell = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find((c) => pass(c.x, c.y))!;
    const af = content.lists.affixes.find((x) => x.target === 'monster')!;
    t.inject({ put: [monster('e_af0001', p.floor, cell.x, cell.y, { hp: 1, affixes: [af.id], nextActAt: f.time + 1000 })] });
    t.edit((e) => { e.stats!.acc = 99; e.build = { ...(e.build ?? { perks: [], pending: [], abilities: [] }), abilities: [...(e.build?.abilities ?? []), { id: 'core:slip', readyAt: 0 }] }; });
    const slipLine = t.obs().valid_actions.find((x) => x.startsWith('use_ability slip'));
    expect(slipLine).toMatch(/<[a-z|]+>/);
    const res = await t.act({ type: 'fight', target: 'e_af0001', until: 'clear', hpFloor: 0 });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.outcome).toContain(af.name.ja);
    // 知っているのが自分のマスと下り階段だけ（経路が無い）
    const fk = t.world.players[t.pid].knowledge.floors[p.floor];
    const dn = f.stairs.down[0];
    const me = t.me().pos!;
    fk.seen = f.terrain.map(() => 0);
    for (const c of [me, dn]) fk.seen[c.y * f.width + c.x] = f.terrain[c.y * f.width + c.x];
    delete fk.mapped;
    t.world.players[t.pid].knowledge.visible = [me.y * f.width + me.x];
    const va = buildVA(t.view());
    expect(va.some((x) => x.startsWith('travel_to stairs_down (不可'))).toBe(true);
    t.manager.closeAll();

    // 大守護者の間の見出し
    const u = await newRun('v33e-hall-1', { objective: 'reach_depth' });
    for (let d = 1; d < 5; d++) expect((await u.descend()).ok).toBe(true);
    expect(formatObservationText(u.obs(), 'ja')).toContain(`（${content.floorTypes['core:warden_hall'].name.ja}）`);
    u.manager.closeAll();
  });
});

function buildVA(v: PlayerView): string[] {
  // 観測を作り直して valid_actions を見る（知識を書き換えた後）
  return buildObservation(v, catalog, { detail: 'brief', map: false }).valid_actions;
}

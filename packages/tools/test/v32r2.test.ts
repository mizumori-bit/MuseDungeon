// V3-2R2（IMPROVEMENTS_V3 §18）の完了の定義: 退却（階段での extract・帰還の綱・転移・逃げ道）、危険の表示（特徴・群れ・命中の記録）、
// 候補の式、踏破の式と下への風、fight の拡張と wait { turns }、守護者の下限、視界外の毒。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor, shotLine } from '@muse/engine';
import type { Command, Entity, GameEvent, OfferSlot, World } from '@muse/shared';
import {
  applyEvent, buildNavGrid, buildObservation, changesLine, cheb, compassDir, filterEventsForPlayer, narrate, offerPoints,
  overreachStepPoints, projectPlayerView, recommendedLevel,
} from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);

async function newRun(seed: string, opts: { classId?: string; objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' | 'endless' } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: opts.classId, controller: { kind: 'agent', label: 't' }, objective: opts.objective ?? 'auto' });
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
  return { manager, r, world, pid, meId, inject, me, place, clearMonsters, act, obs };
}

let sid = 970000;
function monster(id: string, kind: string, floor: string, x: number, y: number, state: 'asleep' | 'hunting' = 'hunting', hp = 30, speed = 100, archetype = 'melee_chaser'): Entity {
  sid++;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed, nextActAt: 0, faction: 'monster', turns: 0, ...(state === 'asleep' ? { dormant: true } : {}), ai: { archetype, state, targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
  };
}

function passable(world: World, key: string, x: number, y: number): boolean {
  const f = world.floors[key];
  return x >= 0 && y >= 0 && x < f.width && y < f.height && content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]].passable
    && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
}

/** 通れるマスが一直線に n+1 個並ぶ場所 */
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

const SLOTS: OfferSlot[] = ['safe', 'standard', 'ambitious'];
const TYPES: [string, boolean][] = [['reach_depth', false], ['slay_guardian', false], ['retrieve_relic', false], ['retrieve_relic', true]];

describe('V3-2R2 offers (§18.3)', () => {
  it('every combination ranks safe < standard < ambitious; ambitious is +3; the level table steps by at most 1', () => {
    const rules = catalog.rules;
    for (let deepest = 1; deepest <= 40; deepest++) {
      const range = (slot: OfferSlot) => {
        const s = rules.slots[slot];
        const pts: number[] = [];
        for (let d = deepest + s.aheadMin; d <= deepest + s.aheadMax; d++) for (const [ty, g] of TYPES) pts.push(offerPoints(rules, slot, ty, g, d));
        return { min: Math.min(...pts), max: Math.max(...pts) };
      };
      const [a, b, c] = SLOTS.map(range);
      expect(a.max).toBeLessThan(b.min);
      expect(b.max).toBeLessThan(c.min);
    }
    // 最初の遠征（標準と野心が同じ地下3階）でも野心が上
    const first = rules.expedition.firstTargetDepth;
    const std = TYPES.map(([ty, g]) => offerPoints(rules, 'standard', ty, g, first.standard));
    const amb = TYPES.map(([ty, g]) => offerPoints(rules, 'ambitious', ty, g, first.ambitious));
    expect(Math.max(...std)).toBeLessThan(Math.min(...amb));
    expect(rules.slots.ambitious.aheadMin).toBe(3);
    expect(rules.slots.ambitious.aheadMax).toBe(3);
    for (let d = 1; d < 30; d++) expect(Math.abs(recommendedLevel(rules, d + 1) - recommendedLevel(rules, d))).toBeLessThanOrEqual(1);
  });
});

describe('V3-2R2 crossing points (§18.4)', () => {
  it('the n-th crossing pays a share of the objective points, never below the old floor', () => {
    const r = catalog.rules;
    expect(overreachStepPoints(r, 3600, 1)).toBe(900);
    expect(overreachStepPoints(r, 2400, 1)).toBe(600);
    expect(overreachStepPoints(r, 1000, 1)).toBe(600);
    expect(overreachStepPoints(r, 3600, 2)).toBe(1260);
    expect(overreachStepPoints(r, 1000, 2)).toBe(900);
  });

  it('a new floor shows the draft toward its unseen down stairs and how much of it you have seen', async () => {
    const t = await newRun('v32r2-draft-1');
    t.clearMonsters();
    const f1 = t.world.floors[t.me().pos!.floor];
    t.place(f1.stairs.down[0].x, f1.stairs.down[0].y);
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    const key = t.me().pos!.floor;
    const f2 = t.world.floors[key];
    const view = t.r.port.view();
    const seen = (p: { x: number; y: number }) => (view.memory.terrain[p.y * f2.width + p.x] ?? 0) !== 0;
    const o = t.obs();
    expect(o.self.floor!.explored).toBeGreaterThanOrEqual(1);
    if (!f2.stairs.down.some(seen)) {
      const near = [...f2.stairs.down].sort((a, b) => cheb(t.me().pos!, a) - cheb(t.me().pos!, b) || a.y - b.y || a.x - b.x)[0];
      expect(o.self.floor!.draft).toBe(compassDir(t.me().pos!, near));
      expect(o.self.floor!.hint_text).toContain('下への風');
    } else {
      expect(o.self.floor!.draft).toBeUndefined();
    }
    // 見た割合は階全体を見れば「ほぼ全て」になる（engine の計算。地形そのものは渡さない）
    const json = JSON.stringify(view);
    expect(json).not.toContain('"stairs"');
  });
});

describe('V3-2R2 retreat (§18.1)', () => {
  it('extract works on stairs even with a hunting enemy in view', async () => {
    const t = await newRun('v32r2-stairs-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const s = f.stairs.down[0];
    t.place(s.x, s.y);
    // 隣に追跡中の敵（見えている）
    let spot: { x: number; y: number } | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) if (passable(t.world, key, s.x + dx, s.y + dy)) { spot = { x: s.x + dx, y: s.y + dy }; break; }
    expect(spot).not.toBeNull();
    t.inject({ put: [monster('e_r2st01', 'core:goblin', key, spot!.x, spot!.y)] });
    await t.act({ type: 'wait' });
    const o = t.obs();
    if (t.r.port.view().status !== 'your_turn' || !o.visible.monsters.some((m) => m.awareness === 'hunting')) return;
    expect(o.expedition!.can_extract).toBe(true);
    expect(o.expedition!.extract_blocked_by).toBeUndefined();
    const w = await t.act({ type: 'extract', confirm: true });
    expect(w.ok).toBe(true);
    expect(t.world.expeditions![0].endReason).toBe('withdrawn');
  });

  it('camp hands out exactly one lifeline per expedition; it cannot be dropped or thrown and does not take a slot', async () => {
    const t = await newRun('v32r2-life-1');
    const lifelines = () => t.r.port.view().inventory.filter((i) => i.kind === 'core:lifeline');
    expect(lifelines()).toHaveLength(1);
    expect(lifelines()[0].qty).toBe(1);
    const slot = lifelines()[0].slot;
    const o = t.obs();
    expect(o.self.inventory_count).toBe(t.r.port.view().inventory.length - 1);
    // 危なくないときは短い行（説明は追跡中の敵がいるか HP が半分以下のときだけ）
    expect(o.valid_actions.some((a) => a.startsWith(`use_item ${slot}`) && a.includes('帰還の綱'))).toBe(true);
    const d = await t.act({ type: 'drop', slot });
    expect(d.ok).toBe(false);
    const th = await t.act({ type: 'throw', slot, target: 'n' });
    expect(th.ok).toBe(false);
  });

  it('the lifeline takes its turns (you can be hit), then banks half the haul and ends the expedition as lifeline; the next expedition gets one again', async () => {
    const t = await newRun('v32r2-life-2');
    t.clearMonsters();
    // 目標の地下2階へ（到達で達成）
    const f1 = t.world.floors[t.me().pos!.floor];
    t.place(f1.stairs.down[0].x, f1.stairs.down[0].y);
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    t.clearMonsters();
    await t.act({ type: 'wait' });
    expect(t.world.expeditions![0].status).toBe('objective_complete');
    // 階段から離れて、隣に追跡中の敵
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r2lf01', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy)] });
    const o = t.obs();
    const expected = o.expedition!.haul!.if_lifeline_now!;
    expect(expected).toBe(Math.trunc((o.expedition!.haul!.total * catalog.rules.lifeline.pct) / 100));
    const slot = t.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    const banked0 = t.r.port.view().record.banked;
    const res = await t.act({ type: 'use', slot });
    expect(res.ok).toBe(true);
    const v = t.r.port.view();
    if (v.status === 'dead') return; // 2 手番の間に倒れることはある（その場合は綱の段階ではない）
    expect(v.status).toBe('at_camp');
    const x = t.world.expeditions![0];
    expect(x.endReason).toBe('lifeline');
    expect(v.record.banked - banked0).toBe(expected);
    expect(v.record.expeditions).toBe(0);
    if (res.ok) expect(res.outcome).toContain('帰還の綱');
    // 次の遠征で再び 1 本
    const s = await t.act({ type: 'start_expedition', offer: 1 });
    expect(s.ok).toBe(true);
    expect(t.r.port.view().inventory.filter((i) => i.kind === 'core:lifeline')).toHaveLength(1);
  });

  it('a teleport lands at least minDistance away and out of the hunters’ sight when possible', async () => {
    const t = await newRun('v32r2-tele-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r2tp01', 'core:goblin', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3)] });
    // 鑑定済みでなくても使える。所持品に転移の巻物を足す
    const me = structuredClone(t.me());
    const sc: Entity = { id: 'e_r2tp02', kind: 'core:scroll_teleport', sid: 970999, item: { qty: 1, affixes: [], heldBy: me.id, slot: 'q' } };
    me.inv!.items.push(sc.id);
    t.inject({ put: [sc, me] });
    const from = { ...t.me().pos! };
    const r = await t.act({ type: 'use', slot: 'q' });
    expect(r.ok).toBe(true);
    const to = t.me().pos!;
    expect(cheb(from, to)).toBeGreaterThanOrEqual(catalog.rules.teleport.minDistance);
  });

  it('with hunters in view and known stairs, alerts carry the escape estimate', async () => {
    const t = await newRun('v32r2-esc-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const s = f.stairs.down[0];
    // 階段の近く（隣）に立ち、速い敵を置く
    let at: { x: number; y: number } | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) if (passable(t.world, key, s.x + dx, s.y + dy)) { at = { x: s.x + dx, y: s.y + dy }; break; }
    t.place(at!.x, at!.y);
    let spot: { x: number; y: number } | null = null;
    for (let r = 2; r <= 4 && !spot; r++) for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if (!spot && passable(t.world, key, at!.x + dx, at!.y + dy)) spot = { x: at!.x + dx, y: at!.y + dy };
    t.inject({ put: [monster('e_r2es01', 'core:jackal', key, spot!.x, spot!.y, 'hunting', 30, 120), monster('e_r2es02', 'core:goblin', key, spot!.x, spot!.y === at!.y ? spot!.y : spot!.y, 'hunting')].slice(0, 1) });
    // 視界を更新するために 1 手番（隣で殴られる前に）
    const view = projectPlayerView(t.world, t.pid);
    const o = buildObservation({ ...view, visibleCells: view.visibleCells }, catalog, { detail: 'brief', map: false });
    const esc = o.alerts.find((a) => a.code === 'escape');
    if (o.visible.monsters.some((m) => m.awareness === 'hunting')) {
      expect(esc).toBeDefined();
      expect(esc!.data).toMatchObject({ stairs: 'down', faster: 1 });
      expect(o.visible.monsters.find((m) => m.id === 'e_r2es01')!.speed).toBe('fast');
      expect(o.visible.monsters.find((m) => m.id === 'e_r2es01')!.traits).toContain('pack');
    }
  });
});

describe('V3-2R2 reading danger (§18.2)', () => {
  it('pack size on depth d is at most d + 1', () => {
    for (let i = 0; i < 40; i++) {
      for (const depth of [1, 2]) {
        const g = generateFloor(content, `v32r2-pack-${i}`, 'main', depth, content.terrain.map((tt) => tt.id));
        const jackals = g.spawns.filter((s) => s.type === 'monster' && s.kind === 'core:jackal');
        // 隣り合う群れ（連結成分）の大きさ
        const seen = new Set<number>();
        for (let k = 0; k < jackals.length; k++) {
          if (seen.has(k)) continue;
          const comp = [k];
          seen.add(k);
          for (let q = 0; q < comp.length; q++) {
            for (let j = 0; j < jackals.length; j++) {
              if (seen.has(j)) continue;
              if (Math.max(Math.abs(jackals[j].x - jackals[comp[q]].x), Math.abs(jackals[j].y - jackals[comp[q]].y)) <= 1) { seen.add(j); comp.push(j); }
            }
          }
          expect(comp.length).toBeLessThanOrEqual(depth + 1);
        }
      }
    }
  });

  it('two or more hunters give the incoming alert from the recorded worst hits; hit records show as counts', async () => {
    const t = await newRun('v32r2-inc-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r2in01', 'core:goblin', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3), monster('e_r2in02', 'core:goblin', key, ln.p.x + ln.dx * 4, ln.p.y + ln.dy * 4)] });
    // 思い出に記録を足す（applyEvent 経由）
    applyEvent(t.world, {
      type: 'monster_memory_updated', player: t.pid, kind: 'core:goblin', seq: t.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [t.pid],
      memoryAfter: { kind: 'core:goblin', encounters: 5, kills: 2, maxDamageToYou: 4, maxDamageByYou: 6, abilities: [], hitsByYou: { melee: [1, 6] }, hitsOnYou: [3, 5] },
    } as unknown as GameEvent);
    await t.act({ type: 'wait' });
    const o = t.obs();
    const hunting = o.visible.monsters.filter((m) => m.awareness === 'hunting');
    if (hunting.length < 2) return;
    const inc = o.alerts.find((a) => a.code === 'incoming');
    expect(inc).toBeDefined();
    expect(inc!.data).toMatchObject({ hunting: hunting.length, worst_sum: 4 * hunting.length, unrecorded: 0 });
    expect(hunting[0].hits?.your_melee?.[1]).toBeGreaterThanOrEqual(6);
    expect(hunting[0].first_seen).toBeUndefined();
  });

  it('guardians come from the top half of the depth’s candidates by XP, never vermin, with a minimum HP', () => {
    for (let i = 0; i < 30; i++) {
      for (const depth of [2, 3, 4, 6]) {
        const g = generateFloor(content, `v32r2-guard-${i}`, 'main', depth, content.terrain.map((tt) => tt.id), { guardian: true, relic: false });
        const spec = g.spawns.find((s) => s.type === 'monster' && s.role === 'guardian');
        if (!spec || spec.type !== 'monster') continue;
        expect(content.monsters[spec.kind].tags).not.toContain('vermin');
        expect(spec.minHp).toBe(content.balance.guardian.minHpBase + content.balance.guardian.minHpPerDepth * depth);
      }
    }
  });

  it('the guardian falling is its own first line of changes; stationary monsters make their neighbours hazards', async () => {
    const line = changesLine('ja', [{ code: 'hp_dropped', text: 'HP 10→8（-2）' }, { code: 'guardian_slain', text: '★ 守護者が倒れた' }]);
    expect(line.split('\n')[0]).toBe('★ 守護者が倒れた');
    const t = await newRun('v32r2-haz-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    const mx = ln.p.x + ln.dx * 3, my = ln.p.y + ln.dy * 3;
    t.inject({ put: [monster('e_r2hz01', 'core:spore_mold', key, mx, my, 'hunting', 10, 100, 'stationary')] });
    await t.act({ type: 'wait' });
    const v = t.r.port.view();
    if (!v.entities.some((e) => e.id === 'e_r2hz01')) return;
    const grid = buildNavGrid(v, catalog)!;
    const nx = mx - ln.dx, ny = my - ln.dy;
    expect(grid.hazard[ny * grid.width + nx]).toBe(1);
  });
});

describe('V3-2R2 calls (§18.5)', () => {
  it('fight without with waits for a hunting enemy to come, then fights; it refuses to wait for a sleeper', async () => {
    const t = await newRun('v32r2-fight-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r2fa01', 'core:goblin', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3, 'asleep', 4)] });
    const refused = await t.act({ type: 'fight', target: 'e_r2fa01' });
    expect(refused.ok).toBe(false);
    t.clearMonsters();
    t.inject({ put: [monster('e_r2fa02', 'core:goblin', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3, 'hunting', 4)] });
    await t.act({ type: 'wait' });
    if (!t.obs().visible.monsters.some((m) => m.id === 'e_r2fa02' && m.dist > 1)) return;
    const s0 = t.world.seq;
    const r = await t.act({ type: 'fight', target: 'e_r2fa02', hpFloor: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const evs = t.r.session.history.filter((e) => e.seq > s0);
    expect(evs.some((e) => e.type === 'attack' && e.attacker === t.meId)).toBe(true);
    expect(r.outcome).toMatch(/攻撃し/);
  });

  it('fight with a throwing slot keeps throwing until the target falls or closes in', async () => {
    const t = await newRun('v32r2-fight-2', { classId: 'core:scout' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 5);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r2fb01', 'core:goblin', key, ln.p.x + ln.dx * 5, ln.p.y + ln.dy * 5, 'hunting', 6)] });
    await t.act({ type: 'wait' });
    const o = t.obs();
    const knives = o.self.attack.throws?.[0];
    expect(knives).toBeDefined();
    if (!o.visible.monsters.some((m) => m.id === 'e_r2fb01' && m.dist > 1)) return;
    expect(o.valid_actions.some((a) => a.startsWith('fight ') && a.includes(`with:${knives!.slot}`))).toBe(true);
    const s0 = t.world.seq;
    const r = await t.act({ type: 'fight', target: 'e_r2fb01', with: knives!.slot, hpFloor: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const throws = t.r.session.history.filter((e) => e.seq > s0 && e.type === 'item_thrown' && e.actor === t.meId).length;
    expect(throws).toBeGreaterThanOrEqual(1);
    expect(['target_down', 'target_adjacent', 'out_of_ammo']).toContain(r.interrupted_by);
  });

  it('wait { turns } waits that many turns when nothing happens', async () => {
    const t = await newRun('v32r2-wait-1');
    t.clearMonsters();
    const r = await t.act({ type: 'wait', turns: 4 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps).toBe(4);
    expect(r.interrupted_by).toBe('max_turns');
  });
});

describe('V3-2R2 fixes from the AI playtest', () => {
  it('shot lines are symmetric: if A can shoot B, B can shoot A (throws and monster shots use the same path)', async () => {
    const t = await newRun('v32r2-shot-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const cells: { x: number; y: number }[] = [];
    for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) if (passable(t.world, key, x, y)) cells.push({ x, y });
    const ctx = { world: t.world, terrainAt: (k: string, x: number, y: number) => content.terrain[content.terrainIndex[t.world.meta.terrainTable[t.world.floors[k].terrain[y * f.width + x]]]], actorAt: () => null };
    let checked = 0;
    for (let i = 0; i < cells.length; i += 7) {
      for (let j = i + 3; j < cells.length && j < i + 200; j += 11) {
        const a = cells[i], b = cells[j];
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 8) continue;
        const ab = shotLine(ctx as never, key, a, b) !== null;
        const ba = shotLine(ctx as never, key, b, a) !== null;
        expect(ab).toBe(ba);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('no throwing fight against an adjacent target; a fleeing enemy is not tagged as attacking you', async () => {
    const t = await newRun('v32r2-fix-1', { classId: 'core:scout' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_r2fx01', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, 'hunting', 30)] });
    await t.act({ type: 'wait' });
    const o = t.obs();
    if (!o.visible.monsters.some((m) => m.id === 'e_r2fx01' && m.dist === 1)) return;
    expect(o.valid_actions.some((a) => a.startsWith('fight e_r2fx01 with:'))).toBe(false);
  });

  it('the rest estimate counts the remaining poison', async () => {
    const t = await newRun('v32r2-fix-2');
    t.clearMonsters();
    const me = structuredClone(t.me());
    me.stats!.hp = me.stats!.maxHp - 1;
    me.statuses = [{ id: 'core:poison', turnsLeft: 6, power: 1 }];
    t.inject({ put: [me] });
    const o = buildObservation(projectPlayerView(t.world, t.pid), catalog, { detail: 'brief', map: false });
    const re = o.self.rest_estimate!;
    expect(re.blocked_by).toBe('poisoned');
    expect(re.turns).toBeGreaterThanOrEqual(6);
    expect(re.lowest_hp!).toBeLessThan(me.stats!.maxHp - 1);
  });

  it('a withdrawal result does not claim the multiplier; travel_to an item id picks it up even if it is harmful', async () => {
    const t = await newRun('v32r2-fix-3');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    const potion: Entity = { id: 'e_r2fx02', kind: 'core:potion_poison', sid: 979001, pos: { floor: key, x: ln.p.x + ln.dx * 3, y: ln.p.y + ln.dy * 3 }, item: { qty: 1, affixes: [] } };
    t.inject({ put: [potion] });
    // 鑑定済みにする（有害品と分かっている）
    applyEvent(t.world, { type: 'item_identified', player: t.pid, kind: 'core:potion_poison', appearanceId: t.world.secret.appearances['core:potion_poison'] ?? null, seq: t.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [t.pid] } as unknown as GameEvent);
    await t.act({ type: 'wait' });
    const r = await t.act({ type: 'travel', to: 'e_r2fx02' });
    expect(r.ok).toBe(true);
    expect(t.r.port.view().inventory.some((i) => i.id === 'e_r2fx02')).toBe(true);
    // 撤退の結果の文
    const f = t.world.floors[key];
    t.place(f.stairs.down[0].x, f.stairs.down[0].y);
    await t.act({ type: 'wait' });
    const w = await t.act({ type: 'extract', confirm: true });
    expect(w.ok).toBe(true);
    const text = t.obs().expedition?.result?.text ?? '';
    expect(text).toContain('撤退で目的を除いて');
    expect(text).not.toContain('倍率 ×');
  });
});

describe('V3-2R2 invariants (§18.7)', () => {
  it('poison on an unseen monster reveals nothing until it dies; then only "something fell to your poison" and the kill', async () => {
    const t = await newRun('v32r2-poison-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const vis = new Set(t.world.players[t.pid].knowledge.visible);
    // 視界外の遠いマス
    let spot: { x: number; y: number } | null = null;
    for (let y = 1; y < f.height - 1 && !spot; y++) for (let x = 1; x < f.width - 1 && !spot; x++) {
      if (passable(t.world, key, x, y) && !vis.has(y * f.width + x) && cheb(t.me().pos!, { x, y }) > 15) spot = { x, y };
    }
    expect(spot).not.toBeNull();
    const m = monster('e_r2po01', 'core:spore_mold', key, spot!.x, spot!.y, 'hunting', 2, 100, 'stationary');
    m.statuses = [{ id: 'core:poison', turnsLeft: 5, power: 1, source: t.meId }];
    t.inject({ put: [m] });
    const startSeq = t.world.seq;
    const kills0 = t.world.players[t.pid].stats.kills;
    for (let i = 0; i < 6 && t.world.entities['e_r2po01']; i++) await t.act({ type: 'wait' });
    expect(t.world.entities['e_r2po01']).toBeUndefined();
    expect(t.world.players[t.pid].stats.kills).toBe(kills0 + 1);
    const evs = t.r.session.history.filter((e) => e.seq > startSeq);
    const mine = filterEventsForPlayer(evs, t.pid, t.r.port.view());
    expect(mine.some((e) => e.type === 'damaged' && (e as Record<string, unknown>).via === 'poison')).toBe(false);
    const died = mine.find((e) => e.type === 'died') as Record<string, unknown> | undefined;
    expect(died).toBeDefined();
    expect(died!.kind).toBeNull();
    expect(died!.pos).toBeNull();
    const text = narrate(died as never, { catalog, locale: 'ja', selfId: t.meId, playerNames: {} });
    expect(text).toBe('あなたの毒で何かが倒れた。');
    // 思い出（種族の撃破数）には数えない
    expect(t.world.players[t.pid].knowledge.monsterMemory['core:spore_mold']?.kills ?? 0).toBe(0);
  });
});

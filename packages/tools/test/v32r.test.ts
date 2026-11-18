// V3-2R（IMPROVEMENTS_V3 §14）の完了の定義: 踏破、退却（flee）、0 歩のマクロが無い、射程外の拒否、会心、
// 地図の巻物の後の explore、キャンプから始まる new_run（v3haul）、気配、fight、拾得、鑑定の対象、脅威・最悪の一撃、文章。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { line } from '@muse/engine';
import type { Command, Entity, GameEvent, PerceivedEvent, PlayerView, World } from '@muse/shared';
import {
  applyEvent, buildObservation, diceMax, diffChanges, killPoints, narrate, Rng, turnSnapshot,
} from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { greedyDecide, newMemo, playWithPort } from '../src/index';

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
  /** 自分を同じ階の別のマスへ置く（盤面の準備用。applyEvent 経由） */
  const place = (x: number, y: number, floor = me().pos!.floor) => { const e = structuredClone(me()); e.pos = { floor, x, y }; inject({ put: [e] }); };
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  return { manager, r, world, pid, meId, inject, me, place, clearMonsters, act };
}

let sid = 950000;
function monster(id: string, kind: string, floor: string, x: number, y: number, state: 'asleep' | 'hunting' = 'hunting', hp = 30): Entity {
  sid++;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ...(state === 'asleep' ? { dormant: true } : {}), ai: { archetype: 'melee_chaser', state, targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
  };
}

/** 通れるマスが一直線に n+1 個並ぶ場所（自分の階） */
function openLine(world: World, key: string, n: number): { p: { x: number; y: number }; dx: number; dy: number } {
  const f = world.floors[key];
  const pass = (x: number, y: number) => x >= 0 && y >= 0 && x < f.width && y < f.height && content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]].passable
    && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      let ok = true;
      for (let k = 0; k <= n && ok; k++) if (!pass(x + dx * k, y + dy * k)) ok = false;
      if (ok) return { p: { x, y }, dx, dy };
    }
  }
  throw new Error('no open line');
}

describe('V3-2R crossing (§14.1)', () => {
  it('arriving below the target pays nothing; standing on that floor’s down stairs pays the crossing points', async () => {
    const t = await newRun('v32r-cross-1');
    const x0 = t.world.expeditions![0];
    expect(x0.objective.targetDepth).toBe(2);
    t.clearMonsters();
    // 地下1階の下り階段 → 地下2階（目標）→ その下り階段 → 地下3階
    const descend = async () => {
      const f = t.world.floors[t.me().pos!.floor];
      t.place(f.stairs.down[0].x, f.stairs.down[0].y);
      // 下り階段の上で手番を終える（目標階の踏破は「下り階段に立った」で達成。V3-2R3 §20.1）
      await t.act({ type: 'wait' });
      const r = await t.act({ type: 'stairs' });
      expect(r.ok).toBe(true);
      t.clearMonsters();
    };
    await descend();
    await descend();
    expect(t.world.floors[t.me().pos!.floor].depth).toBe(3);
    // 着いただけ: 踏破の点は 0。次の踏破は地下3階の下り階段
    await t.act({ type: 'wait' });
    let obs = t.r.port.observe({ map: false }).observation;
    expect(obs.expedition!.haul!.parts.overreach).toBe(0);
    expect(obs.expedition!.haul!.next_overreach).toMatchObject({ depth: 3, points: content.balance.haul.overreachFirst, at: 'stairs_down' });
    // 次の候補は「目標として達成した最深の階（2）」から（踏破しても深くならない。V3-2R3 §20.2）
    expect(t.world.expeditions![0].status).toBe('objective_complete');
    expect(obs.expedition!.haul!.next_camp!.min_target_depth).toBe(Math.max(content.balance.expedition.firstTargetDepth.safe, 2 + content.balance.expedition.slots.safe.aheadMin));
    // 下り階段に立つと踏破の点が入る
    const f3 = t.world.floors[t.me().pos!.floor];
    t.place(f3.stairs.down[0].x, f3.stairs.down[0].y);
    const w = await t.act({ type: 'wait' });
    obs = t.r.port.observe({ map: false }).observation;
    expect(obs.expedition!.haul!.parts.overreach).toBe(content.balance.haul.overreachFirst);
    expect(obs.expedition!.haul!.next_overreach!.depth).toBe(4);
    expect(w.ok && w.turn.changes.some((c) => c.text.includes('深追い'))).toBe(true);
    // 目的の基礎点は踏破 2 階分以上（§14.1）
    const h = content.balance.haul;
    expect(t.world.expeditions![0].points).toBeGreaterThanOrEqual(h.overreachFirst * 2 + h.overreachStep);
    t.manager.closeAll();
  });
});

describe('V3-2R calls as a resource (§14.2)', () => {
  it('with an awake enemy adjacent, careful travel is refused without a turn; flee moves anyway', async () => {
    const t = await newRun('v32r-flee-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 5);
    t.place(ln.p.x + ln.dx, ln.p.y + ln.dy);
    t.inject({ put: [monster('e_adj001', 'core:goblin', key, ln.p.x, ln.p.y)] });
    await t.act({ type: 'wait' });
    const goal = { x: ln.p.x + ln.dx * 5, y: ln.p.y + ln.dy * 5 };
    const seq0 = t.world.seq;
    const careful = await t.act({ type: 'travel', to: goal });
    expect(careful.ok).toBe(false);
    if (!careful.ok) expect(careful.error.code).toBe('hostile_adjacent');
    expect(t.world.seq).toBe(seq0); // 手番を使わない
    const obs = t.r.port.observe({ map: false }).observation;
    expect(obs.valid_actions.some((a) => a.startsWith('fight e_adj001'))).toBe(true);
    const flee = await t.act({ type: 'travel', to: goal, mode: 'flee' });
    expect(flee.ok).toBe(true);
    if (flee.ok) expect(flee.steps!).toBeGreaterThan(0);
    t.manager.closeAll();
  });

  it('fight repeats melee on the adjacent target until it falls, and reports swings and damage', async () => {
    const t = await newRun('v32r-fight-1', { classId: 'core:warrior' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x + ln.dx, ln.p.y + ln.dy);
    t.inject({ put: [monster('e_fgt001', 'core:cave_rat', key, ln.p.x, ln.p.y, 'hunting', 6)] });
    await t.act({ type: 'wait' });
    const r = await t.act({ type: 'fight', target: 'e_fgt001', hpFloor: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.steps!).toBeGreaterThan(1);
      expect(r.outcome).toMatch(/\d+ 回攻撃し \d+ 回命中・合計 \d+ ダメージを与えた/);
      expect(['target_down', 'hp_floor', 'target_moved']).toContain(r.interrupted_by);
    }
    t.manager.closeAll();
  });

  it('bots never make a 0-step macro call; explore picks up items on the way', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    let macros = 0, zero = 0, picked = 0;
    for (let s = 0; s < 4; s++) {
      const r = await manager.createRun({ name: 'Z', seed: `v32r-zero-${s}`, controller: { kind: 'agent', label: 't' } });
      if ('error' in r) throw new Error(r.error.message);
      const port = r.port;
      const spy = new Proxy(port, {
        get(target, prop) {
          if (prop === 'act') {
            return async (cmd: Command, meta: { source: 'bot' }) => {
              const before = target.view().inventory.reduce((a, i) => a + i.qty, 0);
              const out = await target.act(cmd, meta);
              if (out.ok && out.steps !== undefined) { macros++; if (out.steps === 0) zero++; }
              if (out.ok && cmd.type === 'explore' && target.view().inventory.reduce((a, i) => a + i.qty, 0) > before) picked++;
              return out;
            };
          }
          const val = Reflect.get(target, prop, target) as unknown;
          return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
        },
      });
      await playWithPort(spy, { kind: 'greedy', seed: `v32r-zero-${s}`, maxActs: 300 });
      r.session.close();
    }
    expect(macros).toBeGreaterThan(20);
    expect(zero).toBe(0);
    expect(picked).toBeGreaterThan(0);
    manager.closeAll();
  });

  it('after a mapping scroll, explore still heads for the unseen parts of the floor', async () => {
    const t = await newRun('v32r-map-1');
    t.clearMonsters();
    const scroll: Entity = { id: 'e_map001', kind: 'core:scroll_mapping', sid: 990201, item: { qty: 1, affixes: [], heldBy: t.meId, slot: 'q' } };
    const me = structuredClone(t.me());
    me.inv = { ...me.inv!, items: [...me.inv!.items, 'e_map001'] };
    t.inject({ put: [scroll, me] });
    const u = await t.act({ type: 'use', slot: 'q' });
    expect(u.ok).toBe(true);
    const obs = t.r.port.observe({ map: false }).observation;
    expect(obs.navigation.unsighted ?? 0).toBeGreaterThan(0);
    expect(obs.navigation.frontiers.length).toBeGreaterThan(0);
    const before = obs.navigation.unsighted!;
    const ex = await t.act({ type: 'explore', pickup: false });
    expect(ex.ok).toBe(true);
    if (ex.ok) expect(ex.steps!).toBeGreaterThan(0);
    expect(t.r.port.observe({ map: false }).observation.navigation.unsighted ?? 0).toBeLessThan(before);
    t.manager.closeAll();
  });

  it('on the target floor the expedition shows the sense of the guardian (direction and near/far only)', async () => {
    const t = await newRun('v32r-sense-1', { objective: 'slay_guardian' });
    const target = t.world.expeditions![0].objective.targetDepth!;
    t.clearMonsters();
    while (t.world.floors[t.me().pos!.floor].depth < target) {
      const f = t.world.floors[t.me().pos!.floor];
      t.place(f.stairs.down[0].x, f.stairs.down[0].y);
      expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    }
    const view = t.r.port.view();
    expect(view.sense?.what).toBe('guardian');
    const obs = t.r.port.observe({ map: false }).observation;
    expect(obs.expedition!.sense!.text).toMatch(/気配: 守護者は.+・(近い|遠い)/);
    // 正確な位置は出さない
    const g = t.world.expeditions![0].targets.guardian!;
    const gp = t.world.entities[g].pos!;
    expect(JSON.stringify(obs.expedition!.sense)).not.toContain(`${gp.x}`.length > 1 ? `"x":${gp.x}` : '"x"');
    t.manager.closeAll();
  });
});

describe('V3-2R numbers you need (§14.3, §14.7)', () => {
  it('an id throw out of range is refused with out_of_range and keeps the item; shots show out_of_range per item', async () => {
    const t = await newRun('v32r-range-1', { classId: 'core:scout' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 8);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_far001', 'core:goblin', key, ln.p.x + ln.dx * 8, ln.p.y + ln.dy * 8, 'asleep')] });
    await t.act({ type: 'wait' });
    const v = t.r.port.view();
    const knife = v.inventory.find((i) => i.kind === 'core:throwing_knife')!;
    const obs = t.r.port.observe({ map: false }).observation;
    const m = obs.visible.monsters.find((x) => x.id === 'e_far001')!;
    expect(line(t.me().pos!, t.world.entities.e_far001.pos!).length).toBeGreaterThan(7);
    expect(m.shots.find((s) => s.slot === knife.slot)!.state).toBe('out_of_range');
    expect(obs.valid_actions.some((a) => a.startsWith('throw_item') && a.includes('e_far001'))).toBe(false);
    const seq0 = t.world.seq;
    const r = await t.act({ type: 'throw', slot: knife.slot, target: 'e_far001' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('out_of_range');
    expect(t.world.seq).toBe(seq0);
    expect(t.r.port.view().inventory.find((i) => i.kind === 'core:throwing_knife')!.qty).toBe(knife.qty);
    // 自分の武器と投擲物の性能は所持品に出る
    expect(obs.self.inventory_brief).toContain('投擲1d4+1・射程7・命中+1');
    t.manager.closeAll();
  });

  it('a critical hit deals the dice maximum plus might and ignores armor', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    let checked = 0;
    for (let s = 0; s < 12 && checked < 2; s++) {
      const r = await manager.createRun({ name: 'C', seed: `v32r-crit-${s}`, controller: { kind: 'agent', label: 't' }, objective: 'endless' });
      if ('error' in r) throw new Error(r.error.message);
      const rng = Rng.fromSeed(`v32r-crit-${s}`);
      const memo = newMemo();
      const meId = r.session.world.players[r.port.playerId].entityId;
      for (let i = 0; i < 400 && r.port.view().status === 'your_turn'; i++) {
        // 行動の直前の自分の能力値で、その行動中の自分の会心を確かめる（装甲は無視される）
        const me = r.session.world.entities[meId];
        const dmg = me.stats!.dmg, might = me.stats!.might;
        const from = r.session.history.length;
        await r.port.act(greedyDecide(r.port, rng, memo), { source: 'bot' });
        const h = r.session.history.slice(from);
        for (let k = 0; k < h.length; k++) {
          const a = h[k];
          if (a.type !== 'attack' || !a.crit || !a.hit || a.ranged || a.attacker !== meId) continue;
          const d = h.slice(k + 1, k + 4).find((e) => e.type === 'damaged' && e.target === a.target && e.source === meId) as Extract<GameEvent, { type: 'damaged' }> | undefined;
          if (!d) continue;
          expect(d.amount).toBe(Math.max(1, diceMax(dmg) + might));
          checked++;
        }
      }
      r.session.close();
    }
    expect(checked).toBeGreaterThan(0);
    manager.closeAll();
  });

  it('an unrecorded species has unknown threat; a recorded worst hit at or above your HP raises lethal_range', async () => {
    const t = await newRun('v32r-threat-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_unk001', 'core:orc_brute', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3)] });
    await t.act({ type: 'wait' });
    let view = t.r.port.view();
    let obs = buildObservation(view, catalog, { detail: 'brief', map: false });
    const m = obs.visible.monsters.find((x) => x.id === 'e_unk001')!;
    expect(m.threat).toBeNull();
    expect(m.worst_hit).toBeNull();
    // 記録がある（受けた最大の一撃 ≥ 今の HP）なら一撃の危険が出る
    view = structuredClone(view) as PlayerView;
    view.monsterMemory['core:orc_brute'] = { kind: 'core:orc_brute', encounters: 1, kills: 0, maxDamageToYou: view.self.stats.hp, maxDamageByYou: 0, abilities: [] };
    obs = buildObservation(view, catalog, { detail: 'brief', map: false });
    expect(obs.visible.monsters.find((x) => x.id === 'e_unk001')!.worst_hit).toBe(view.self.stats.hp);
    expect(obs.alerts.some((a) => a.code === 'lethal_range')).toBe(true);
    t.manager.closeAll();
  });

  it('identify scrolls take target_slot; without it the first unidentified item by slot is identified', async () => {
    const t = await newRun('v32r-ident-1');
    t.clearMonsters();
    const apps = t.world.secret.appearances;
    const kinds = Object.keys(apps).filter((k) => content.items[k]?.category === 'potion' && !t.world.players[t.pid].knowledge.identified.includes(k));
    const mk = (id: string, kind: string, slot: string): Entity => ({ id, kind, sid: 990300 + slot.charCodeAt(0), item: { qty: 1, affixes: [], heldBy: t.meId, slot } });
    const items = [mk('e_idn001', 'core:scroll_identify', 'v'), mk('e_idn002', kinds[0], 'w'), mk('e_idn003', kinds[1], 'x')];
    const me = structuredClone(t.me());
    me.inv = { ...me.inv!, items: [...me.inv!.items, ...items.map((i) => i.id)] };
    t.inject({ put: [...items, me] });
    const r = await t.act({ type: 'use', slot: 'v', targetSlot: 'x' });
    expect(r.ok).toBe(true);
    const known = t.world.players[t.pid].knowledge.identified;
    expect(known).toContain(kinds[1]);
    expect(known).not.toContain(kinds[0]);
    t.manager.closeAll();
  });

  it('texts: affixes in combat names, a departing enemy’s heading, level-up gains', () => {
    const ctx = { locale: 'ja' as const, catalog, selfId: 'e_me0001', playerNames: {} };
    const dmg = { type: 'damaged', seq: 1, target: 'e_gob001', targetKind: 'core:goblin', targetAffixes: ['core:venomous'], amount: 3, dealt: 3, hpAfter: 2, source: 'e_me0001', sourceKind: 'core:warrior', via: 'melee' };
    const venom = Object.keys(catalog.affixes).find((a) => catalog.affixes[a].target === 'monster')!;
    const text = narrate({ ...dmg, targetAffixes: [venom] } as never, ctx)!;
    expect(text).toContain(`${catalog.affixes[venom].name.ja}ゴブリン`);
    const lv = narrate({ type: 'level_up', seq: 2, target: 'e_me0001', levelAfter: 3, gains: { maxHp: 6, acc: 1, might: 0, eva: 0 } } as never, ctx)!;
    expect(lv).toBe('レベル 3 に上がった！（最大HP+6・命中+1）');
  });

  it('hostile_gone tells where it was last seen and which way it stepped out', async () => {
    const t = await newRun('v32r-gone-1');
    const view = t.r.port.view();
    const obs = buildObservation(view, catalog, { detail: 'brief', map: false });
    const prev = turnSnapshot(view, obs);
    prev.hostiles = { e_gon001: 'ゴブリン' };
    prev.hostilePos = { e_gon001: { x: 5, y: 6 } };
    const cur = turnSnapshot(view, obs);
    const ev = { seq: view.seq, type: 'entity_moved', text: '', event: { type: 'entity_moved', id: 'e_gon001', from: { x: 5, y: 6 }, to: null, dirOut: 'ne' } } as unknown as PerceivedEvent;
    const ch = diffChanges(prev, cur, view, obs, [ev]);
    expect(ch.find((c) => c.code === 'hostile_gone')!.text).toBe('見えなくなった敵: ゴブリン（最後に見た位置 (5,6)・北東へ）');
    t.manager.closeAll();
  });

  it('a poison kill counts for whoever applied it; rest goes on through poison ticks (V3-2R evaluation)', async () => {
    const t = await newRun('v32r-poison-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    t.place(ln.p.x, ln.p.y);
    const m = monster('e_psn001', 'core:goblin', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3, 'hunting', 1);
    m.statuses = [{ id: 'core:poison', turnsLeft: 5, power: 2, source: t.meId }];
    t.inject({ put: [m] });
    const k0 = t.world.expeditions![0].haul?.kills ?? 0;
    for (let i = 0; i < 3 && t.world.entities.e_psn001; i++) await t.act({ type: 'wait' });
    const died = t.r.session.history.find((e) => e.type === 'died' && e.id === 'e_psn001') as Extract<GameEvent, { type: 'died' }> | undefined;
    expect(died?.killer).toBe(t.meId);
    // 撃破の点 = 種族の経験値 × killPerXp × 深さの係数（V3-2R3 §20.5）
    const depth = t.world.floors[died!.floor!].depth;
    expect(t.world.expeditions![0].haul!.kills).toBe(k0 + killPoints(catalog.rules, content.monsters[died!.kind].xp, depth, (died!.affixes?.length ?? 0) > 0));
    // 毒を受けたまま休む: 毒の継続ダメージでは止まらない
    const me = structuredClone(t.me());
    me.stats = { ...me.stats!, hp: Math.max(5, me.stats!.maxHp - 6) };
    me.statuses = [{ id: 'core:poison', turnsLeft: 3, power: 1 }];
    t.inject({ put: [me] });
    const r = await t.act({ type: 'rest' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.interrupted_by).not.toBe('damaged');
      expect(r.steps!).toBeGreaterThan(3);
    }
    t.manager.closeAll();
  });

  it('travel_to an item stops as arrived once it is picked up; collect counts what it actually picked', async () => {
    const t = await newRun('v32r-pick-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    t.place(ln.p.x, ln.p.y);
    const mk = (id: string, k: number): Entity => ({ id, kind: 'core:throwing_knife', sid: 990400 + k, pos: { floor: key, x: ln.p.x + ln.dx * k, y: ln.p.y + ln.dy * k }, item: { qty: 1, affixes: [] } });
    t.inject({ put: [mk('e_itm001', 2), mk('e_itm002', 4)] });
    await t.act({ type: 'wait' });
    const r = await t.act({ type: 'travel', to: 'e_itm001' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.interrupted_by).toBe('arrived');
    expect(t.r.port.view().inventory.some((i) => i.id === 'e_itm001' || i.kind === 'core:throwing_knife')).toBe(true);
    const c = await t.act({ type: 'collect', what: 'items' });
    expect(c.ok).toBe(true);
    if (c.ok) expect(c.collected!.picked).toBeGreaterThan(0);
    t.manager.closeAll();
  });

  it('reappeared is only for monsters a response already reported', async () => {
    const t = await newRun('v32r-reap-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_rep001', 'core:goblin', key, ln.p.x + ln.dx * 3, ln.p.y + ln.dy * 3, 'asleep')] });
    await t.act({ type: 'wait' });
    const view = t.r.port.view();
    const obs = buildObservation(view, catalog, { detail: 'brief', map: false });
    const prev = turnSnapshot(view, obs);
    prev.hostiles = {};
    prev.reported = [];
    prev.seq = view.seq + 10; // 個体は「前の応答より前」に見ていた扱い
    const cur = turnSnapshot(view, obs);
    expect(diffChanges(prev, cur, view, obs, []).find((c) => c.entity === 'e_rep001')!.code).toBe('new_hostile');
    prev.reported = ['e_rep001'];
    expect(diffChanges(prev, turnSnapshot(view, obs), view, obs, []).find((c) => c.entity === 'e_rep001')!.code).toBe('reappeared');
    t.manager.closeAll();
  });
});

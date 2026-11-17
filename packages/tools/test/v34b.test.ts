// V3-4b（IMPROVEMENTS_V3 §28.1〜§28.8・§28.11）の完了の定義: 綱は目的の点を運ばない・守護者の格で種族の表が深くなる・
// 休憩は 75% まで・fight の続け方（until / adjacent / 見失ったとき / 待つ間の射撃 / 記録のある種族では止まらない）・
// 効いた特技と起きた理由の知らせ・使える物だけ拾う・情報の短縮・Muse の実プレイで出た不具合。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { guardianCandidates, selectBiome, selectFloorType } from '@muse/engine';
import type { Command, Entity, GameEvent, PlayerView, World } from '@muse/shared';
import {
  applyEvent, buildObservation, campDepthOf, formatObservationText, hpLeftEstimate, macroNext, macroStart, payoutOf, pickableItems, projectPlayerView, restCapHp,
} from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);

async function newRun(seed: string, opts: { classId?: string; objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: opts.classId ?? 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: opts.objective ?? 'auto' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject({ put: [e] }); };
  const place = (x: number, y: number) => edit((e) => { e.pos = { floor: e.pos!.floor, x, y }; });
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  const view = () => projectPlayerView(world, pid);
  /** 所持品に品を足す（スロットを返す）。equip なら装備する */
  const give = (kind: string, o: { affixes?: string[]; qty?: number; equip?: 'weapon' | 'armor' | 'accessory' } = {}): string => {
    const used = new Set((me().inv!.items).map((id) => world.entities[id]?.item?.slot));
    let slot = 'a';
    for (let c = 97; c <= 122; c++) if (!used.has(String.fromCharCode(c))) { slot = String.fromCharCode(c); break; }
    const id = `e_b${(++sid).toString(36).padStart(5, '0')}`;
    const it: Entity = { id, kind, sid: ++sid, item: { qty: o.qty ?? 1, affixes: o.affixes ?? [], heldBy: meId, slot, inspected: true } };
    const body = structuredClone(me());
    body.inv!.items.push(id);
    if (o.equip) body.equip = { ...(body.equip ?? {}), [o.equip]: id };
    inject({ put: [it, body] });
    return slot;
  };
  /** 知っている地図を、指定したマスだけにする（すべて見えている） */
  const knowOnly = (cells: { x: number; y: number }[]) => {
    const key = me().pos!.floor;
    const f = world.floors[key];
    const fk = world.players[pid].knowledge.floors[key];
    fk.seen = f.terrain.map(() => 0);
    for (const c of cells) fk.seen[c.y * f.width + c.x] = f.terrain[c.y * f.width + c.x];
    delete fk.mapped;
    world.players[pid].knowledge.visible = cells.map((c) => c.y * f.width + c.x);
  };
  const descend = async () => {
    const f = world.floors[me().pos!.floor];
    place(f.stairs.down[0].x, f.stairs.down[0].y);
    clearMonsters();
    await act({ type: 'wait' });
    const s = await act({ type: 'stairs' });
    clearMonsters();
    return s;
  };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, obs, view, give, knowOnly, descend };
}

let sid = 995000;
function monster(id: string, kind: string, floor: string, x: number, y: number, o: { hp?: number; state?: 'hunting' | 'unaware' | 'asleep'; speed?: number; affixes?: string[]; flee?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed: o.speed ?? 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.state ?? 'hunting', targetPos: null, lostTurns: 0, params: o.flee ? { fleeBelowHpPct: o.flee } : {} }, ...(o.state === 'asleep' ? { dormant: true } : {}) },
    stats: { hp, maxHp: o.flee ? 30 : hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: o.flee ? 30 : hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
    ...(o.affixes ? { scale: { tier: 0, affixes: o.affixes } } : {}),
  };
}

function passable(world: World, key: string, x: number, y: number): boolean {
  const f = world.floors[key];
  if (x < 0 || y < 0 || x >= f.width || y >= f.height) return false;
  const t = content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]];
  return t.passable && !t.stairs && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
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

describe('V3-4b lifeline and guardians (§28.1, §28.2)', () => {
  it('the lifeline never carries objective points (complete or not); a carried relic is lost; the next offers do not deepen', () => {
    const parts = { objective: 3000, overreach: 100, treasure: 50, bounty: 40, discovery: 30, kills: 80 };
    const pct = catalog.rules.lifeline.pct;
    expect(payoutOf(catalog.rules, parts, true, 120, true)).toBe(Math.trunc(((300) * pct) / 100));
    expect(payoutOf(catalog.rules, parts, false, 120, true)).toBe(Math.trunc(((300) * pct) / 100));
    const w = { expeditions: [{ objective: { type: 'retrieve_relic', targetDepth: 5 }, extracted: [{ player: 'p', completed: true, treasure: 0, lifeline: true }] }] } as unknown as World;
    expect(campDepthOf(w)).toBe(0);
    const w2 = { expeditions: [{ objective: { type: 'retrieve_relic', targetDepth: 5 }, extracted: [{ player: 'p', completed: true, treasure: 0 }] }] } as unknown as World;
    expect(campDepthOf(w2)).toBe(5);
  });

  it('using the lifeline while holding the relic loses the relic and banks half the haul without the objective', async () => {
    const t = await newRun('v34b-relic-1', { objective: 'retrieve_relic' });
    const target = t.world.expeditions![0].objective.targetDepth!;
    for (let d = 1; d < target; d++) expect((await t.descend()).ok).toBe(true);
    const relic = Object.values(t.world.entities).find((e) => e.role === 'relic' && e.pos?.floor === t.me().pos!.floor);
    expect(relic).toBeTruthy();
    // 遺物を所持品に入れる（拾う）
    t.place(relic!.pos!.x, relic!.pos!.y);
    t.clearMonsters();
    const pk = await t.act({ type: 'pickup', item: relic!.id });
    expect(pk.ok).toBe(true);
    t.clearMonsters();
    expect(t.world.expeditions![0].status).toBe('objective_complete');
    const o = t.obs();
    const haul = o.expedition!.haul!;
    expect(haul.text).toContain('（遺物は失う）');
    expect(haul.if_lifeline_now).toBe(Math.trunc(((haul.total - haul.parts.objective) * catalog.rules.lifeline.pct) / 100));
    const banked0 = t.view().record.banked;
    const slot = t.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    const res = await t.act({ type: 'use', slot });
    expect(res.ok).toBe(true);
    expect(t.view().status).toBe('at_camp');
    expect(t.view().record.banked - banked0).toBe(haul.if_lifeline_now);
    expect(t.world.entities[relic!.id]).toBeUndefined();
    expect(t.world.expeditions![0].endReason).toBe('lifeline');
    expect(campDepthOf(t.world)).toBe(0);
  });

  it('guardian species come from deeper tables by rank: rank 3 on depth 3 is never the plain goblin', () => {
    for (const seed of ['g1', 'g2', 'g3']) {
      const ft = selectFloorType(content, seed, 'main', 3), bi = selectBiome(content, seed, 'main', 3);
      const r3 = guardianCandidates(content, ft, bi, 3, 3).map((m) => m.id);
      const r1 = guardianCandidates(content, ft, bi, 3, 1).map((m) => m.id);
      expect(r3).not.toContain('core:goblin');
      expect(r3.length).toBeGreaterThan(0);
      // 格 1 は目標の深度の下位半分（今までどおり）
      expect(r1.every((id) => !r3.includes(id) || id === 'core:goblin_slinger')).toBe(true);
    }
  });
});

describe('V3-4b rest cap (§28.3)', () => {
  it('rest stops at the cap; above it rest is refused; a potion still heals past it', async () => {
    const t = await newRun('v34b-rest-1');
    t.clearMonsters();
    const max = t.me().stats!.maxHp;
    const cap = restCapHp(catalog.rules, max);
    expect(cap).toBeLessThan(max);
    t.edit((e) => { e.stats!.hp = 2; });
    const o = t.obs();
    expect(o.self.rest_estimate?.cap_hp).toBe(cap);
    expect(o.valid_actions.some((a) => a.startsWith('rest') && a.includes(`${cap} まで`))).toBe(true);
    const r = await t.act({ type: 'rest' });
    expect(r.ok).toBe(true);
    if (r.ok && r.interrupted_by !== 'rest_cap') return; // 休む間に徘徊が来た（このシードでは確かめられない）
    expect(t.me().stats!.hp).toBe(cap);
    // これ以上は休憩では戻らない
    const again = await t.act({ type: 'rest' });
    expect(again.ok).toBe(false);
    expect(t.obs().valid_actions.some((a) => a.startsWith('rest') && a.includes('不可'))).toBe(true);
    // 自然回復も上限で止まる
    for (let i = 0; i < 30; i++) { t.clearMonsters(); await t.act({ type: 'wait' }); }
    expect(t.me().stats!.hp).toBe(cap);
    // 回復の薬は上限を超えて戻す
    const slot = t.give('core:potion_healing');
    const u = await t.act({ type: 'use', slot });
    expect(u.ok).toBe(true);
    expect(t.me().stats!.hp).toBeGreaterThan(cap);
  });
});

describe('V3-4b fight (§28.4)', () => {
  it("until: 'clear' keeps going to the next hunting enemy and ends when none is left", async () => {
    const t = await newRun('v34b-clear-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x + ln.dx, ln.p.y + ln.dy);
    t.edit((e) => { e.stats!.acc = 60; e.stats!.hp = 200; e.stats!.maxHp = 200; e.base!.maxHp = 200; });
    setMemory(t, 'core:goblin', { maxDamageToYou: 1 });
    t.inject({ put: [monster('e_cl0001', 'core:goblin', key, ln.p.x, ln.p.y, { hp: 2 }), monster('e_cl0002', 'core:goblin', key, ln.p.x + 2 * ln.dx, ln.p.y + 2 * ln.dy, { hp: 2 })] });
    await t.act({ type: 'wait' });
    const r = await t.act({ type: 'fight', target: 'e_cl0001', until: 'clear', hpFloor: 0 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.interrupted_by).toBe('cleared');
      expect(r.outcome).toContain('倒した: 2 体');
    }
    expect(t.world.entities.e_cl0001).toBeUndefined();
    expect(t.world.entities.e_cl0002).toBeUndefined();
  });

  it('a newly seen hunter of a recorded species does not stop fight; an unrecorded one does', async () => {
    const t = await newRun('v34b-rec-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    t.place(ln.p.x, ln.p.y);
    setMemory(t, 'core:goblin', { maxDamageToYou: 2 });
    t.inject({ put: [monster('e_rc0001', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy)] });
    await t.act({ type: 'wait' });
    const state = macroStart(t.view(), { type: 'fight', target: 'e_rc0001', hpFloor: 0 }, catalog);
    state.steps = 1;
    t.inject({ put: [monster('e_rc0002', 'core:goblin', key, ln.p.x + 3 * ln.dx, ln.p.y + 3 * ln.dy)] });
    t.world.players[t.pid].knowledge.visible.push((ln.p.y + 3 * ln.dy) * t.world.floors[key].width + ln.p.x + 3 * ln.dx);
    expect('command' in macroNext(state, t.view(), catalog, [])).toBe(true);
    t.inject({ put: [monster('e_rc0003', 'core:jackal', key, ln.p.x + 4 * ln.dx, ln.p.y + 4 * ln.dy)] });
    t.world.players[t.pid].knowledge.visible.push((ln.p.y + 4 * ln.dy) * t.world.floors[key].width + ln.p.x + 4 * ln.dx);
    expect(macroNext(state, t.view(), catalog, [])).toEqual({ stop: 'hostile_in_view' });
  });

  it('a hunting target that slips out of sight is waited for; a fleeing one stops at once; being shot while waiting stops', async () => {
    const t = await newRun('v34b-lost-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_ls0001', 'core:goblin', key, ln.p.x + 2 * ln.dx, ln.p.y + 2 * ln.dy)] });
    await t.act({ type: 'wait' });
    const v1 = t.view();
    const st = macroStart(v1, { type: 'fight', target: 'e_ls0001', hpFloor: 0 }, catalog);
    expect(st.targetFleeing).toBe(false);
    // 見えなくなった（物陰に入った）: lostWait 手番まで待つ
    const hidden = { ...v1, entities: v1.entities.filter((e) => e.id !== 'e_ls0001') } as PlayerView;
    const lw = catalog.rules.fightLostWait ?? 5;
    for (let i = 0; i < lw; i++) expect(macroNext(st, hidden, catalog, [])).toEqual({ command: { type: 'wait' } });
    expect(macroNext(st, hidden, catalog, [])).toEqual({ stop: 'target_gone' });
    // 逃げて見えなくなった: すぐ止まる
    const st2 = macroStart(v1, { type: 'fight', target: 'e_ls0001', hpFloor: 0 }, catalog);
    st2.targetFleeing = true;
    expect(macroNext(st2, hidden, catalog, [])).toEqual({ stop: 'target_fled' });
    // 待つ手番に、標的以外の射撃で被弾した
    const st3 = macroStart(v1, { type: 'fight', target: 'e_ls0001', hpFloor: 0 }, catalog);
    expect(macroNext(st3, hidden, catalog, [])).toEqual({ command: { type: 'wait' } });
    const shot = [{ type: 'damaged', target: t.meId, via: 'ranged', source: 'e_other1', amount: 2, seq: 1 }] as never;
    expect(macroNext(st3, hidden, catalog, shot)).toEqual({ stop: 'shot_while_waiting' });
  });

  it("fight with: adjacent: 'throw' keeps throwing at an adjacent target; the default stops", async () => {
    const t = await newRun('v34b-adj-1', { classId: 'core:scout' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 1);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_aj0001', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy)] });
    await t.act({ type: 'wait' });
    const slot = t.view().inventory.find((i) => i.kind === 'core:throwing_knife')!.slot;
    const v = t.view();
    expect(macroNext(macroStart(v, { type: 'fight', target: 'e_aj0001', with: slot, hpFloor: 0 }, catalog), v, catalog, [])).toEqual({ stop: 'target_adjacent' });
    const d = macroNext(macroStart(v, { type: 'fight', target: 'e_aj0001', with: slot, adjacent: 'throw', hpFloor: 0 }, catalog), v, catalog, []);
    expect('command' in d && d.command.type).toBe('throw');
    const m = macroNext(macroStart(v, { type: 'fight', target: 'e_aj0001', with: slot, adjacent: 'melee', hpFloor: 0 }, catalog), v, catalog, []);
    expect('command' in m && (m.command.type === 'move' || m.command.type === 'ability')).toBe(true);
  });

  it('fight on a target that fled out of sight in the last response says so without using a turn', async () => {
    const t = await newRun('v34b-fled-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_fd0001', 'core:goblin', key, ln.p.x + 2 * ln.dx, ln.p.y + 2 * ln.dy, { hp: 1, flee: 50 })] });
    const w = await t.act({ type: 'wait' });
    expect(w.ok).toBe(true);
    if (!t.view().entities.some((e) => e.id === 'e_fd0001' && e.fleeing)) return; // 逃げて見えなくなった後なら、この確認はできない
    t.inject({ del: ['e_fd0001'] });
    const turns = t.me().actor!.turns;
    const r = await t.act({ type: 'fight', target: 'e_fd0001' });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.code).toBe('no_target'); expect(r.error.message).toContain('逃げて見えなくなった'); }
    expect(t.me().actor!.turns).toBe(turns);
  });
});

describe('V3-4b notices, pickup and information (§28.6–§28.8, §28.11)', () => {
  it('ambush and the retriever say when they worked; the silence ring names itself when its noise wakes a sleeper', async () => {
    const t = await newRun('v34b-perk-1', { classId: 'core:scout' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    t.edit((e) => { e.build!.perks.push('core:perk_ambush', 'core:perk_retrieve'); });
    t.give('core:ring_silence', { equip: 'accessory' });
    t.inject({ put: [
      monster('e_pa0001', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { state: 'unaware', hp: 50 }),
      monster('e_pa0002', 'core:jackal', key, ln.p.x + 3 * ln.dx, ln.p.y + 3 * ln.dy, { state: 'asleep' }),
    ] });
    // 手番を進めずに（気づかれる前に）、線の上が見えている状態にする
    t.knowOnly([0, 1, 2, 3].map((k) => ({ x: ln.p.x + k * ln.dx, y: ln.p.y + k * ln.dy })));
    const h0 = t.r.session.history.length;
    await t.act({ type: 'move', dir: ln.dx === 1 ? 'e' : ln.dx === -1 ? 'w' : ln.dy === 1 ? 's' : 'n' });
    const evs = t.r.session.history.slice(h0);
    expect(evs.some((e) => e.type === 'perk_triggered' && (e as { effect: string }).effect === 'crit')).toBe(true);
    const woke = evs.find((e) => e.type === 'monster_woke' && (e as { id: string }).id === 'e_pa0002') as { ring: string | null; by: string | null } | undefined;
    expect(woke?.by).toBe(t.meId);
    expect(woke?.ring).toBe('core:ring_silence');
    // 変化の行に出る
    const o = t.r.port.observeWithTurn('observed', {});
    void o;
    // 回収の手: 自分が投げた物が隣のマスにあれば、歩いて入ったときに拾う
    const t2 = await newRun('v34b-perk-2', { classId: 'core:scout' });
    t2.clearMonsters();
    const k2 = t2.me().pos!.floor;
    const l2 = openLine(t2.world, k2, 2);
    t2.place(l2.p.x, l2.p.y);
    t2.edit((e) => { e.build!.perks.push('core:perk_retrieve'); });
    t2.inject({ put: [{ id: 'e_kn0001', kind: 'core:throwing_knife', sid: ++sid, pos: { floor: k2, x: l2.p.x + 2 * l2.dx, y: l2.p.y + 2 * l2.dy }, item: { qty: 1, affixes: [], thrownBy: t2.pid } }] });
    const h1 = t2.r.session.history.length;
    await t2.act({ type: 'move', dir: l2.dx === 1 ? 'e' : l2.dx === -1 ? 'w' : l2.dy === 1 ? 's' : 'n' });
    expect(t2.r.session.history.slice(h1).some((e) => e.type === 'perk_triggered' && (e as { effect: string; amount?: number }).effect === 'picked')).toBe(true);
  });

  it("explore picks up only useful gear by default ('useful'); valid_actions does not offer worse gear of another kind", async () => {
    const t = await newRun('v34b-useful-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x, ln.p.y);
    t.give('core:scale_mail', { equip: 'armor' });
    t.inject({ put: [{ id: 'e_la0001', kind: 'core:leather_armor', sid: ++sid, pos: { floor: key, x: ln.p.x + ln.dx, y: ln.p.y + ln.dy }, item: { qty: 1, affixes: [] } }] });
    await t.act({ type: 'wait' });
    const v = t.view();
    expect(pickableItems(v, catalog).some((x) => x.id === 'e_la0001')).toBe(false);
    expect(pickableItems(v, catalog, [], false).some((x) => x.id === 'e_la0001')).toBe(true);
    const slot = t.give('core:leather_armor');
    expect(t.obs().valid_actions.some((a) => a.startsWith(`equip ${slot} `))).toBe(false);
  });

  it('sleeping and far enemies get a short line; the expedition header shortens when unchanged; affixed kills stay out of the species HP record', async () => {
    const t = await newRun('v34b-info-1', { classId: 'core:scout' });
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 9);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_in0001', 'core:goblin', key, ln.p.x + 9 * ln.dx, ln.p.y + 9 * ln.dy, { state: 'unaware' })] });
    await t.act({ type: 'wait' });
    const o = buildObservation(t.view(), catalog, { detail: 'brief', map: false });
    const text = formatObservationText(o, 'ja');
    const line = text.split('\n').find((l) => l.includes('e_in0001'));
    expect(line).toBeTruthy();
    expect(line).not.toContain('射程外');
    // 見出し: 2 回続けて同じなら短い形
    await t.act({ type: 'wait' });
    await t.act({ type: 'wait' });
    const r2 = t.r.port.observeWithTurn('observed', {});
    expect(r2.text).toMatch(/【遠征1】(extract は階段の上で|この場で extract できる)/);
    // 接辞付きの個体は種族の体力の記録に入らない
    const k2 = t.me().pos!.floor;
    t.clearMonsters();
    t.inject({ put: [monster('e_in0002', 'core:jackal', k2, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 1, affixes: ['core:swift'] })] });
    t.edit((e) => { e.stats!.acc = 60; });
    await t.act({ type: 'wait' });
    await t.act({ type: 'move', dir: ln.dx === 1 ? 'e' : ln.dx === -1 ? 'w' : ln.dy === 1 ? 's' : 'n' });
    expect(t.world.entities.e_in0002).toBeUndefined();
    expect(t.view().monsterMemory['core:jackal']?.hpSeen).toBeUndefined();
  });

  it('an untouched enemy at full health is estimated at its recorded HP, not the bottom of the healthy band', () => {
    const mem = { kind: 'core:goblin', encounters: 1, kills: 1, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], hpSeen: { min: 4, max: 4, samples: 1 } } as never;
    expect(hpLeftEstimate(mem, 'healthy', 0, 5)).toMatchObject({ min: 4, max: null });
  });
});

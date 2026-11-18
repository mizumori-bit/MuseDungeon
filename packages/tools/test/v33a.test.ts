// V3-3a（IMPROVEMENTS_V3 §35.1〜§35.8）の確認: 守護者は離れている間に回復する・節目を候補に入れる（堅実と標準は越えない、節目に挑む、
// 繰り返しの減点、推奨レベル、体力の上限）・外れた弱点も記録する・回復の薬の下限と Lv6 の職業の能動技・格 1 の型・fight の止まり方・
// 納めた欠片が次の番人の記憶を返す。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { Command, Entity, GameEvent, PlayerView } from '@muse/shared';
import { applyEvent, formatObservationText, macroNext, macroStart, offerGap, offerWardenExtra, projectPlayerView, recommendedLevel } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
const terrainTable = content.terrain.map((tt) => tt.id);
let sid = 940000;

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
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  const view = () => projectPlayerView(world, pid);
  const toDown = async () => { const f = world.floors[me().pos!.floor]; place(f.stairs.down[0].x, f.stairs.down[0].y); clearMonsters(); await act({ type: 'wait' }); };
  const toUp = async () => { const f = world.floors[me().pos!.floor]; place(f.stairs.up!.x, f.stairs.up!.y); clearMonsters(); await act({ type: 'wait' }); };
  const descend = async () => { await toDown(); const s = await act({ type: 'stairs' }); clearMonsters(); return s; };
  /** 最初の遠征（到達 地下2階）の目標を target に書き換えて達成し、キャンプへ戻る（候補の基準を target にする） */
  const achieveTo = async (target: number) => {
    world.expeditions![world.expeditions!.length - 1].objective.targetDepth = target;
    while (world.floors[me().pos!.floor].depth < target) expect((await descend()).ok).toBe(true);
    await toDown();
    expect((await act({ type: 'extract' })).ok).toBe(true);
  };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, obs, view, toDown, toUp, descend, achieveTo };
}

function monster(id: string, floor: string, x: number, y: number, o: { hp?: number; dmg?: string; acc?: number; nextActAt?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 10;
  return {
    id, kind: 'core:goblin', sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: o.nextActAt ?? 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: o.acc ?? 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d1' },
    base: { maxHp: hp, acc: o.acc ?? 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d1' },
    statuses: [],
  };
}

describe('V3-3a guardians heal while you are away (§35.1)', () => {
  it('a guardian heals 2% of max HP per turn you spent away; at full it settles; camp heals every guardian', async () => {
    const t = await newRun('v33a-away-1', { objective: 'reach_depth' });
    for (let d = 1; d < 5; d++) expect((await t.descend()).ok).toBe(true);
    const key = t.me().pos!.floor;
    const w = Object.values(t.world.entities).find((e) => e.pos?.floor === key && e.guardian?.warden)!;
    const max = w.stats!.maxHp;
    const g0 = structuredClone(w);
    g0.stats!.hp = Math.trunc(max / 2);
    g0.statuses = [{ id: 'core:poison', turnsLeft: 50, power: 1, source: null }];
    t.inject({ put: [g0] });
    // 上へ逃げて 5 手番待ち、戻る: 2% × 離れていた手番（階段の手番を含む）だけ回復（全快しない）
    await t.toUp();
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    expect(t.world.entities[w.id].guardian!.awaySince).toBeTruthy();
    const hpLeft = t.world.entities[w.id].stats!.hp;
    for (let k = 0; k < 4; k++) await t.act({ type: 'wait' });
    await t.toDown();
    const turnsAway = t.me().actor!.turns - t.world.entities[w.id].guardian!.awaySince!.turns + 1;
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    const healed = t.world.entities[w.id].stats!.hp - hpLeft;
    expect(healed).toBe(Math.trunc((max * 2 * turnsAway) / 100));
    expect(t.r.session.history.some((e) => e.type === 'guardian_rested' && !(e as { full?: boolean }).full)).toBe(true);
    // 長く離れると全快して落ち着く（状態異常も消える）
    await t.toUp();
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    for (let k = 0; k < 60; k++) await t.act({ type: 'wait' });
    await t.toDown();
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    const after = t.world.entities[w.id];
    expect(after.stats!.hp).toBe(max);
    expect(after.statuses ?? []).toEqual([]);
    expect(after.actor!.ai!.state).not.toBe('hunting');
    expect(t.r.session.history.some((e) => e.type === 'guardian_rested' && (e as { full?: boolean }).full)).toBe(true);
    // キャンプへ戻ると、どの階の守護者も全快する（最大体力 − 傷跡まで。V3-8 §53.3。
    // 再開する階の大守護者も同じ: 今までは再開する階を先に全快させていたので、傷跡が消えていた。V4-0e §8.3）
    const g1 = structuredClone(t.world.entities[w.id]);
    g1.stats!.hp = 5;
    t.inject({ put: [g1] });
    const scar = Math.min(Math.trunc(max / 2), (g1.scar ?? 0) + Math.trunc((max - (g1.scar ?? 0) - 5) / 4));
    await t.toUp();
    expect((await t.act({ type: 'extract', confirm: true })).ok).toBe(true);
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(t.world.entities[w.id].scar).toBe(scar);
    expect(t.world.entities[w.id].stats!.hp).toBe(max - scar);
    t.manager.closeAll();
  });
});

describe('V3-3a milestones in the offers (§35.2)', () => {
  it('before the milestone: safe stays above it (rank 1), standard challenges it, ambitious goes past; levels and repeats', async () => {
    const t = await newRun('v33a-offer-1', { objective: 'reach_depth' });
    await t.achieveTo(4);
    const offers = t.world.camp!.offers;
    const safe = offers.find((o) => o.slot === 'safe')!;
    const std = offers.find((o) => o.slot === 'standard')!;
    const amb = offers.find((o) => o.slot === 'ambitious')!;
    expect(safe.objective).toEqual({ type: 'slay_guardian', targetDepth: 4 });
    expect(safe.guardian?.rank).toBe(1);
    expect(safe.guardian?.types).toHaveLength(1);
    expect(safe.repeatNo).toBe(2);
    expect(std.objective).toEqual({ type: 'slay_warden', targetDepth: 5 });
    expect(std.warden?.depth).toBe(5);
    expect(amb.objective.targetDepth!).toBeGreaterThan(5);
    expect(amb.passesWarden?.depth).toBe(5);
    // 推奨レベル: 節目に挑む = +2、節目を越える = 大守護者と目標の大きいほう・危険度 +1
    const lv = t.view().self.level;
    const gStd = offerGap(catalog.rules, 5, std.traits ?? [], lv, offerWardenExtra(std));
    expect(gStd.recommendedLevel).toBe(recommendedLevel(catalog.rules, 5) + (catalog.rules.milestone?.levelBonus ?? 2));
    const gAmb = offerGap(catalog.rules, amb.objective.targetDepth!, amb.traits ?? [], lv, offerWardenExtra(amb));
    const base = offerGap(catalog.rules, amb.objective.targetDepth!, amb.traits ?? [], lv);
    expect(gAmb.traitDanger).toBe(base.traitDanger + 1);
    expect(gAmb.recommendedLevel!).toBeGreaterThanOrEqual(gStd.recommendedLevel!);
    // 文: 節目に挑む・繰り返し
    const texts = t.obs().camp!.offers.map((o) => o.text).join('\n');
    expect(texts).toContain('節目に挑む');
    expect(texts).toContain('この階は 2 回目');
    t.manager.closeAll();
  });

  it('a slay_warden expedition completes when the warden falls and you extract on stairs; the next milestone becomes 10', async () => {
    const t = await newRun('v33a-warden-1', { objective: 'reach_depth' });
    await t.achieveTo(4);
    const std = t.world.camp!.offers.find((o) => o.objective.type === 'slay_warden')!;
    expect((await t.act({ type: 'start_expedition', offer: std.index })).ok).toBe(true);
    while (t.world.floors[t.me().pos!.floor].depth < 5) expect((await t.descend()).ok).toBe(true);
    const key = t.me().pos!.floor;
    const w = Object.values(t.world.entities).find((e) => e.pos?.floor === key && e.guardian?.warden)!;
    const p = t.me().pos!;
    const g = structuredClone(w);
    g.pos = { floor: key, x: p.x + 1, y: p.y };
    g.stats!.hp = 1; g.stats!.eva = -99;
    t.inject({ put: [g] });
    t.edit((e) => { e.stats!.acc = 99; e.stats!.hp = 999; e.stats!.maxHp = 999; });
    for (let k = 0; k < 6 && t.world.entities[w.id]; k++) await t.act({ type: 'move', dir: 'e' });
    expect(t.world.entities[w.id]).toBeUndefined();
    const x = t.world.expeditions![t.world.expeditions!.length - 1];
    expect(x.status).toBe('objective_complete');
    if (t.me().boonChoice) await t.act({ type: 'choose_boon', option: 1 });
    await t.toUp();
    expect((await t.act({ type: 'extract' })).ok).toBe(true);
    expect(t.world.expeditions![t.world.expeditions!.length - 1].endReason).toBe('completed');
    expect(t.world.camp!.milestone?.depth).toBe(10);
    t.manager.closeAll();
  });

  it('the warden HP is capped at maxHpBase + maxHpPerDepth × depth', () => {
    const wb = content.balance.guardian.warden;
    for (let i = 0; i < 20; i++) {
      for (const depth of [5, 10]) {
        const sp = generateFloor(content, `v33a-cap-${i}`, 'main', depth, terrainTable).spawns.find((s) => s.type === 'monster' && s.guardian?.warden);
        if (sp?.type !== 'monster') continue;
        expect(sp.maxHp).toBe(wb.maxHpBase + wb.maxHpPerDepth * depth);
      }
    }
  });
});

describe('V3-3a weaknesses, potions, perks, fight (§35.3–§35.6)', () => {
  it('a missed try is recorded and shown ("毒ではない")', async () => {
    const a = await arena('v33a-miss', { map: ['P...G'], guardian: { kind: 'core:goblin', hp: 60, dmg: '1d1', acc: 0, types: [], weakness: 'core:weak_water', state: 'unaware' }, player: { hp: 60, acc: 30, items: [{ kind: 'core:throwing_knife', qty: 10 }] } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const slot = a.r.port.view().inventory.find((i) => i.kind === 'core:throwing_knife')!.slot;
    for (let k = 0; k < 6 && !(a.world.players[a.pid].knowledge.guardianTried?.[a.gId] ?? []).length; k++) await a.r.port.act({ type: 'throw', slot, target: a.gId }, { source: 'bot' });
    expect(a.world.players[a.pid].knowledge.guardianTried?.[a.gId]).toContain('core:weak_thrown');
    expect(a.world.players[a.pid].knowledge.guardianIntel?.[a.gId]).toBeUndefined();
    expect(a.r.port.look(a.gId).text).toContain('投擲ではない');
    const m = a.r.port.observe({ map: false }).observation.visible.monsters.find((x) => x.id === a.gId);
    expect(m?.guardian?.not_weak?.map((x) => x.id)).toContain('core:weak_thrown');
    a.manager.closeAll();
  });

  it('a healing potion heals at least 30% of max HP', async () => {
    const t = await newRun('v33a-potion-1', { objective: 'reach_depth' });
    const id = `e_pt${(++sid).toString(36).padStart(4, '0')}`;
    const body = structuredClone(t.me());
    body.stats!.maxHp = 200; body.base!.maxHp = 200; body.stats!.hp = 10;
    body.inv!.items.push(id);
    t.inject({ put: [{ id, kind: 'core:potion_healing', sid: ++sid, item: { qty: 1, affixes: [], heldBy: t.meId, slot: 'z', inspected: true } }, body] });
    t.world.players[t.pid].knowledge.identified = [...t.world.players[t.pid].knowledge.identified, 'core:potion_healing'];
    expect((await t.act({ type: 'use', slot: 'z' })).ok).toBe(true);
    expect(t.me().stats!.hp).toBeGreaterThanOrEqual(10 + 60);
    t.manager.closeAll();
  });

  it('at Lv6 a class ability perk never offered before replaces one option', async () => {
    const t = await newRun('v33a-perk-1', { objective: 'reach_depth' });
    t.clearMonsters();
    t.edit((e) => { e.level = { level: 5, xp: 999999 - 1 }; e.build = { perks: [], pending: [], abilities: [], offered: [] }; });
    const p = t.me().pos!;
    const f = t.world.floors[p.floor];
    const cell = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find((c) => content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[c.y * f.width + c.x]]]]?.passable)!;
    // xp を Lv6 の手前にしてから 1 体倒す
    const { xpForLevel } = await import('@muse/shared');
    t.edit((e) => { e.level = { level: 5, xp: xpForLevel(5) - 1 }; e.stats!.acc = 99; });
    const m = monster('e_lv0001', p.floor, cell.x, cell.y, { hp: 1, nextActAt: f.time + 1000 });
    m.xp = 50;
    t.inject({ put: [m] });
    const dir = (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const).find((d) => { const v = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] }[d]; return p.x + v[0] === cell.x && p.y + v[1] === cell.y; })!;
    for (let k = 0; k < 4 && t.world.entities.e_lv0001; k++) await t.act({ type: 'move', dir });
    const ev = t.r.session.history.filter((e) => e.type === 'perk_offered' && (e as { level?: number }).level === 6) as unknown as { options: string[] }[];
    expect(ev.length).toBe(1);
    const cls = content.classes['core:warrior'];
    const lineages = new Set(cls.lineages.map((l) => l.id));
    expect(ev[0].options.some((id) => !!content.perks[id]?.ability && lineages.has(content.perks[id].lineage))).toBe(true);
    t.manager.closeAll();
  });

  it('fight does not stop on a small first hit, stops on a big one; 3 kills count as a record', async () => {
    const a = await arena('v33a-first', { map: ['PG'], guardian: { kind: 'core:goblin', hp: 60, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 0 }, catalog);
    expect('command' in macroNext(st, v, catalog, [])).toBe(true);
    const small = [{ type: 'damaged', target: v.self.id, source: a.gId, sourceKind: 'core:goblin', amount: 3, via: 'melee', seq: 1 }] as never;
    expect('stop' in macroNext(st, v, catalog, small) ? 'stop' : 'go').toBe('go');
    const st2 = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 0 }, catalog);
    expect('command' in macroNext(st2, v, catalog, [])).toBe(true);
    const big = [{ type: 'damaged', target: v.self.id, source: a.gId, sourceKind: 'core:goblin', amount: 40, via: 'melee', seq: 1 }] as never;
    expect(macroNext(st2, v, catalog, big)).toEqual({ stop: 'first_hit' });
    // 3 体倒した種族は記録あり: 記録の無い種族の一覧に入らない
    const v3 = { ...v, monsterMemory: { ...v.monsterMemory, 'guardian|core:goblin': { kind: 'core:goblin', encounters: 3, kills: 3, maxDamageToYou: 0, maxDamageByYou: 2, abilities: [] } } } as PlayerView;
    const st3 = macroStart(v3, { type: 'fight', target: a.gId, hpFloor: 0 }, catalog);
    expect(st3.unrecorded ?? []).not.toContain('guardian|core:goblin');
    a.manager.closeAll();
  });
});

describe('V3-3a relics bring back warden memories (§35.7)', () => {
  it('each relic delivered recalls the next warden: weakness first, then HP and max hit (matching the real warden)', async () => {
    let checked = false;
    for (let i = 0; i < 12 && !checked; i++) {
      const t = await newRun(`v33a-mem-${i}`, { objective: 'retrieve_relic' });
      const x = t.world.expeditions![0];
      if (x.objective.type !== 'retrieve_relic') { t.manager.closeAll(); continue; }
      while (t.world.floors[t.me().pos!.floor].depth < x.objective.targetDepth!) expect((await t.descend()).ok).toBe(true);
      const relic = Object.values(t.world.entities).find((e) => e.role === 'relic' && e.pos?.floor === t.me().pos!.floor)!;
      t.place(relic.pos!.x, relic.pos!.y);
      await t.act({ type: 'wait' });
      expect((await t.act({ type: 'pickup', item: relic.id })).ok).toBe(true);
      await t.toDown();
      expect((await t.act({ type: 'extract' })).ok).toBe(true);
      const intel = t.world.players[t.pid].knowledge.wardenIntel?.['5'];
      expect(intel?.weakness).toBeTruthy();
      expect(t.obs().camp?.milestone?.text).toContain('記録庫の記憶');
      expect(formatObservationText(t.obs(), 'ja')).toContain('記録庫: 欠片 1/');
      // 次の遺物の候補に「残り 1」
      const relicOffer = t.obs().camp!.offers.find((o) => o.text.includes('記録庫が地下5階の番人の記憶'));
      if (relicOffer) expect(relicOffer.text).toContain('残り 1');
      // 大守護者に会うと、弱点が最初から分かっている
      expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
      for (let k = 0; k < 6 && t.world.floors[t.me().pos!.floor].depth < 5; k++) expect((await t.descend()).ok).toBe(true);
      if (t.world.floors[t.me().pos!.floor].depth === 5) {
        const w = Object.values(t.world.entities).find((e) => e.pos?.floor === t.me().pos!.floor && e.guardian?.warden)!;
        t.place(w.pos!.x - 2, w.pos!.y);
        await t.act({ type: 'wait' });
        expect(t.view().entities.find((e) => e.id === w.id)?.guardian?.weakness).toBe(intel!.weakness);
        expect(intel!.weakness).toBe(w.guardian!.weakness);
      }
      checked = true;
      t.manager.closeAll();
    }
    expect(checked).toBe(true);
  });
});

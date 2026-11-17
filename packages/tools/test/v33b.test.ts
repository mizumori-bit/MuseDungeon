// V3-3b（IMPROVEMENTS_V3 §40.1〜§40.7）の確認: 斥候の投擲（急所狙い・朦朧への会心・fight の拾い直し・種類で指す）、
// 小悪魔と「回避が高い」、落ち着いた守護者の手下は去る・眠りに戻る・追っていない間の回復、繰り返しの減点の下限、
// 守護者の一撃の目安、封じられた下り階段で終えた遠征の再開位置、valid_actions、突進の 2 倍。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { guardianTraits } from '@muse/engine';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { applyEvent, offerPoints, projectPlayerView, xpForLevel } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 960000;

async function newRun(seed: string, opts: { classId?: string } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: opts.classId ?? 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: 'reach_depth' });
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
  const toDown = async () => { const f = world.floors[me().pos!.floor]; place(f.stairs.down[0].x, f.stairs.down[0].y); clearMonsters(); await act({ type: 'wait' }); };
  const descend = async () => { await toDown(); const s = await act({ type: 'stairs' }); clearMonsters(); return s; };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, toDown, descend };
}

function knifeOnFloor(a: Awaited<ReturnType<typeof arena>>, x: number, y: number, qty = 1): Entity {
  const id = `e_n${(++sid).toString(36).padStart(5, '0')}`;
  return { id, kind: 'core:throwing_knife', sid: ++sid, pos: { floor: a.key, x, y }, item: { qty, affixes: [], thrownBy: a.pid } } as Entity;
}

/** arena の「守護者」を普通の個体にする */
function asMonster(a: Awaited<ReturnType<typeof arena>>, o: { kind?: string; armor?: number; hp?: number; status?: string; state?: 'hunting' | 'unaware' } = {}) {
  const g = structuredClone(a.world.entities[a.gId]);
  delete g.role; delete g.guardian; delete g.home;
  if (o.kind) g.kind = o.kind;
  if (o.armor !== undefined) { g.stats!.armor = o.armor; g.base!.armor = o.armor; }
  if (o.hp !== undefined) { g.stats!.hp = o.hp; g.stats!.maxHp = o.hp; g.base!.maxHp = o.hp; }
  if (o.status) g.statuses = [{ id: o.status, turnsLeft: 5, power: 0, source: null }];
  if (o.state && g.actor?.ai) { g.actor.ai.state = o.state; delete g.actor.dormant; }
  a.inject({ put: [g] });
}

describe('V3-3b scout and armor (§40.1)', () => {
  it('Weak spot lets throws ignore 2 armor per rank; the Deflector still halves', async () => {
    const plain = async (ranks: number) => {
      const a = await arena(`v33b-ws-${ranks}`, { classId: 'core:scout', map: ['P...G'], guardian: { kind: 'core:goblin', hp: 900, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 900, acc: 40, items: [{ kind: 'core:throwing_knife', qty: 30 }] } });
      asMonster(a, { armor: 3, hp: 900 });
      const me = structuredClone(a.world.entities[a.meId]);
      me.build = { perks: Array(ranks).fill('core:perk_weak_spot'), pending: [], abilities: [], offered: [] };
      a.inject({ put: [me] });
      await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      const slot = a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:throwing_knife')!.item!.slot!;
      const h0 = a.r.session.history.length;
      for (let i = 0; i < 12; i++) await a.r.port.act({ type: 'throw', slot, target: a.gId }, { source: 'bot' });
      // 会心でない命中だけ（会心は装甲を無視する）
      const out: number[] = [];
      for (const e of a.r.session.history.slice(h0)) if (e.type === 'damaged' && e.target === a.gId && e.via === 'thrown') out.push(e.amount);
      a.manager.closeAll();
      return out.filter((d) => d < 5);
    };
    const none = await plain(0);
    const one = await plain(1);
    expect(Math.max(...none)).toBeLessThanOrEqual(2);
    expect(Math.max(...one)).toBeGreaterThanOrEqual(3);
  });

  it('a scout is offered Weak spot by Lv4 if never offered before', async () => {
    const t = await newRun('v33b-perk-1', { classId: 'core:scout' });
    t.clearMonsters();
    const p = t.me().pos!;
    const f = t.world.floors[p.floor];
    const cell = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find((c) => content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[c.y * f.width + c.x]]]]?.passable)!;
    t.edit((e) => { e.level = { level: 3, xp: xpForLevel(3) - 1 }; e.stats!.acc = 99; e.build = { perks: [], pending: [], abilities: [], offered: [] }; });
    const m: Entity = { id: 'e_ws0001', kind: 'core:goblin', sid: ++sid, pos: { floor: p.floor, x: cell.x, y: cell.y }, xp: 50,
      actor: { speed: 100, nextActAt: f.time + 1000, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
      stats: { hp: 1, maxHp: 1, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' }, base: { maxHp: 1, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' }, statuses: [] } as Entity;
    t.inject({ put: [m] });
    const dir = (['n', 'e', 's', 'w'] as const).find((d) => { const v = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[d]; return p.x + v[0] === cell.x && p.y + v[1] === cell.y; })!;
    for (let k = 0; k < 4 && t.world.entities.e_ws0001; k++) await t.act({ type: 'move', dir });
    const ev = t.r.session.history.filter((e) => e.type === 'perk_offered' && (e as { level?: number }).level === 4) as unknown as { options: string[] }[];
    expect(ev.length).toBe(1);
    expect(ev[0].options).toContain('core:perk_weak_spot');
    t.manager.closeAll();
  });

  it('aimed throw crits a stunned (helpless) target that is aware of you', async () => {
    const a = await arena('v33b-aimed', { classId: 'core:scout', map: ['P..G'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 300, acc: 40, items: [{ kind: 'core:throwing_knife', qty: 5 }] } });
    asMonster(a, { status: 'core:stun', state: 'hunting', hp: 300 });
    const me = structuredClone(a.world.entities[a.meId]);
    me.build = { perks: ['core:perk_aimed_throw'], pending: [], abilities: [{ id: 'core:aimed_throw', readyAt: 0 }], offered: [] };
    a.inject({ put: [me] });
    const slot = a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:throwing_knife')!.item!.slot!;
    // 視界は最初の手で更新される（朦朧の相手は動かない）
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const g = structuredClone(a.world.entities[a.gId]);
    g.statuses = [{ id: 'core:stun', turnsLeft: 5, power: 0, source: null }];
    a.inject({ put: [g] });
    const h0 = a.r.session.history.length;
    const out = await a.r.port.act({ type: 'ability', id: 'aimed_throw', target: a.gId, slot }, { source: 'bot' });
    expect(out.ok).toBe(true);
    const dmg = a.r.session.history.slice(h0).find((e) => e.type === 'damaged' && e.target === a.gId) as Extract<GameEvent, { type: 'damaged' }> | undefined;
    expect(dmg?.amount).toBe(5); // 1d4+1 の最大（会心）
    a.manager.closeAll();
  });

  it('fight with a throwing kind walks to its own thrown knives when it runs out, then keeps throwing', async () => {
    const a = await arena('v33b-retrieve', { classId: 'core:scout', map: ['......', 'P....G'], guardian: { kind: 'core:goblin', hp: 500, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 300, acc: 40 } });
    asMonster(a, { hp: 500 });
    // 持っている投擲物を外し、自分が投げたナイフを床に置く
    const me = structuredClone(a.world.entities[a.meId]);
    const own = me.inv!.items.filter((id) => a.world.entities[id]?.kind === 'core:throwing_knife');
    me.inv!.items = me.inv!.items.filter((id) => !own.includes(id));
    a.inject({ put: [me, knifeOnFloor(a, a.ox + 1, a.oy, 3)], del: own });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const h0 = a.r.session.history.length;
    const out = await a.r.port.act({ type: 'fight', target: a.gId, with: 'throwing_knife', hpFloor: 1 }, { source: 'bot' });
    expect(out.ok).toBe(true);
    const evs = a.r.session.history.slice(h0);
    expect(evs.some((e) => e.type === 'item_picked_up' && e.actor === a.meId)).toBe(true);
    expect(evs.some((e) => e.type === 'item_thrown' && e.actor === a.meId)).toBe(true);
    a.manager.closeAll();
  });
});

describe('V3-3b imps and evasive (§40.2)', () => {
  it('imps are milder and shallower; high evasion is a visible trait', () => {
    const imp = content.monsters['core:imp'];
    expect(imp.stats.eva).toBe(5);
    expect(imp.stats.acc).toBe(3);
    expect(imp.depth).toMatchObject({ min: 4, max: 10 });
    expect(imp.xp).toBe(9);
    expect(catalog.monsters['core:imp'].evasive).toBe(true);
    expect(catalog.monsters['core:goblin'].evasive).toBe(false);
    expect(guardianTraits({ content } as never, 'core:imp')).toContain('evasive');
  });
});

describe('V3-3b guardians settle properly (§40.3〜§40.5)', () => {
  it('a guardian that heals to full while not chasing you settles: its minions leave and a deep sleeper falls asleep again', async () => {
    const a = await arena('v33b-settle', { map: ['P....G'], guardian: { kind: 'core:goblin', hp: 60, dmg: '1d1', types: [], weakness: 'core:weak_sleep', state: 'unaware' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]);
    g.stats!.hp = 10;
    g.guardian!.awaySince = { player: a.pid, turns: (a.world.entities[a.meId].actor?.turns ?? 0) - 100 };
    const minion: Entity = { ...structuredClone(g), id: 'e_mn0001', sid: ++sid, pos: { floor: a.key, x: a.ox + 4, y: a.oy }, minionOf: a.gId } as Entity;
    delete minion.guardian; delete minion.role; delete minion.home;
    a.inject({ put: [g, minion] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const gg = a.world.entities[a.gId];
    expect(gg.stats!.hp).toBe(gg.stats!.maxHp);
    expect(a.world.entities.e_mn0001).toBeUndefined();
    expect(gg.actor?.ai?.state).toBe('asleep');
    expect(gg.actor?.dormant).toBe(true);
    const rest = a.r.session.history.find((e) => e.type === 'guardian_rested') as Extract<GameEvent, { type: 'guardian_rested' }> | undefined;
    expect(rest?.full).toBe(true);
    expect(rest?.dispersed).toBe(1);
    a.manager.closeAll();
  });

  it('a guardian that loses you starts resting; seeing it later applies the heal for the turns that passed', async () => {
    const a = await arena('v33b-calm', { map: ['P..............G'], guardian: { kind: 'core:goblin', hp: 100, dmg: '1d1', types: [], state: 'unaware' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]);
    g.stats!.hp = 20;
    g.actor!.ai = { ...g.actor!.ai!, state: 'searching', lostTurns: 30, targetPos: { x: g.pos!.x, y: g.pos!.y } };
    a.inject({ put: [g] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const since = a.world.entities[a.gId].guardian!.awaySince;
    expect(since).toBeTruthy();
    for (let i = 0; i < 10; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const hp0 = a.world.entities[a.gId].stats!.hp;
    // 近づいて見る
    const me = structuredClone(a.world.entities[a.meId]);
    me.pos = { ...me.pos!, x: a.ox + 11 };
    a.inject({ put: [me] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const hp1 = a.world.entities[a.gId].stats!.hp;
    expect(hp1).toBeGreaterThan(hp0);
    expect(a.r.session.history.some((e) => e.type === 'guardian_rested' && !(e as { full?: boolean }).full)).toBe(true);
    a.manager.closeAll();
  });
});

describe('V3-3b offers and resume (§40.6)', () => {
  it('repeats bottom out at 25%; guardian offers show the max hit; ending on the sealed stairs resumes from the stairs up', async () => {
    const t = await newRun('v33b-offer-1');
    // 地下4階を目標にした達成を 2 回あったことにして、地下4階で達成して帰る（3 回目の繰り返しは 12.5% → 25%）
    const cur = t.world.expeditions![t.world.expeditions!.length - 1];
    for (const no of [90, 91]) t.world.expeditions!.push({ ...structuredClone(cur), no, status: 'ended', endReason: 'completed', objective: { type: 'reach_depth', targetDepth: 4 } });
    t.world.expeditions!.push(t.world.expeditions!.splice(t.world.expeditions!.indexOf(cur), 1)[0]);
    cur.objective.targetDepth = 4;
    for (let d = 1; d < 4; d++) expect((await t.descend()).ok).toBe(true);
    await t.toDown();
    expect((await t.act({ type: 'extract' })).ok).toBe(true);
    const safe = t.world.camp!.offers.find((o) => o.slot === 'safe')!;
    expect(safe.objective).toEqual({ type: 'slay_guardian', targetDepth: 4 });
    expect(safe.repeatNo).toBe(4);
    const pr = { expedition: content.balance.expedition, slots: content.balance.expedition.slots as never };
    expect(safe.points).toBe(Math.trunc((offerPoints(pr, 'safe', 'slay_guardian', false, 4) * 25) / 100));
    expect(safe.guardian?.maxHit).toBeGreaterThan(0);
    const text = t.r.port.observe({ map: false }).observation.camp!.offers.find((o) => o.slot === 'safe')!.text;
    expect(text).toContain(`一撃は最大 ${safe.guardian!.maxHit} まで`);
    // 標準（節目に挑む）で地下5階の封じられた下り階段の上で撤退すると、次は地下5階の上り階段から
    const std = t.world.camp!.offers.find((o) => o.slot === 'standard')!;
    expect((await t.act({ type: 'start_expedition', offer: std.index })).ok).toBe(true);
    while (t.world.floors[t.me().pos!.floor].depth < 5) expect((await t.descend()).ok).toBe(true);
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    t.place(f.stairs.down[0].x, f.stairs.down[0].y);
    t.clearMonsters();
    await t.act({ type: 'wait' });
    expect((await t.act({ type: 'extract', confirm: true })).ok).toBe(true);
    const ps = [...t.r.session.history].reverse().find((e) => e.type === 'player_state' && e.player === t.pid) as Extract<GameEvent, { type: 'player_state' }>;
    expect(ps.extractPos).toEqual({ floor: key, x: f.stairs.up!.x, y: f.stairs.up!.y });
    t.manager.closeAll();
  });
});

describe('V3-3b smaller items (§40.7)', () => {
  it('valid_actions: no throwing fight for a class bad at throwing; used-up abilities are left out; a charge line gets step-off moves', async () => {
    const a = await arena('v33b-va', { map: ['.....', 'P...G', '.....'], guardian: { kind: 'core:orc_brute', hp: 300, dmg: '1d1', types: ['core:charger'], state: 'hunting' }, player: { hp: 300, items: [{ kind: 'core:throwing_knife', qty: 3 }] } });
    const me = structuredClone(a.world.entities[a.meId]);
    me.build = { perks: ['core:perk_second_wind'], pending: [], abilities: [{ id: 'core:second_wind', readyAt: 0, usedNo: a.world.expeditions![0].no, uses: 1 }], offered: [] };
    a.inject({ put: [me] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const g2 = structuredClone(a.world.entities[a.gId]);
    g2.actor!.ai = { ...g2.actor!.ai!, intent: { kind: 'winding_up', dir: 'w' } };
    g2.pos = { ...g2.pos!, x: a.ox + 4, y: a.oy + 1 };
    const me2 = structuredClone(a.world.entities[a.meId]);
    me2.pos = { ...me2.pos!, x: a.ox, y: a.oy + 1 };
    a.inject({ put: [g2, me2] });
    const va = a.r.port.observe({ map: false }).observation.valid_actions;
    expect(va.some((x) => x.startsWith('fight ') && x.includes('with:'))).toBe(false);
    expect(va.some((x) => x.startsWith('use_ability second_wind'))).toBe(false);
    expect(va.filter((x) => x.startsWith('move ') && x.includes('(突進の直線から外れる)')).length).toBeGreaterThanOrEqual(2);
    expect(va).toContain('move e');
    a.manager.closeAll();
  });

  it('a charge that hits deals double damage', async () => {
    const a = await arena('v33b-charge', { map: ['P...G'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1+5', acc: 60, types: ['core:charger'], state: 'hunting' }, player: { hp: 300 } });
    const me = structuredClone(a.world.entities[a.meId]);
    me.stats!.armor = 0; me.base!.armor = 0; me.stats!.eva = -50;
    a.inject({ put: [me] });
    const h0 = a.r.session.history.length;
    for (let i = 0; i < 8; i++) {
      await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      if (a.r.session.history.slice(h0).some((e) => e.type === 'guardian_acted' && (e as { act?: string }).act === 'charged')) break;
    }
    const evs = a.r.session.history.slice(h0);
    const ci = evs.findIndex((e) => e.type === 'guardian_acted' && (e as { act?: string }).act === 'charged');
    expect(ci).toBeGreaterThanOrEqual(0);
    const hit = evs.slice(0, ci + 1).reverse().find((e) => e.type === 'damaged' && e.target === a.meId) as Extract<GameEvent, { type: 'damaged' }> | undefined;
    expect(hit?.amount).toBe(12);
    a.manager.closeAll();
  });
});

void projectPlayerView;

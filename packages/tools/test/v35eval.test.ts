// V3-3a・V3-6・V3-5a の後の AI 評価で見つかった不具合の確認: fight の hp_risk に隣の逃走中の敵、状態異常で止まる条件、
// flee の既定の hp_floor、状態異常と能動技の文の守護者の印、キャンプで能動技の再使用待ちが戻る。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Entity, GameEvent, MonsterMemory, ProjectedEvent } from '@muse/shared';
import { buildExpeditionReport, compareReports, macroNext, macroStart, narrate, projectPlayerView } from '@muse/shared';
import type { ExpeditionReport } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);

/** 隣に、記録のある普通のゴブリンを置いた場面（fleeing: 体力が逃げる閾値を下回っている） */
async function scene(seed: string, o: { fleeing?: boolean; myHp?: number; armor?: number } = {}) {
  const a = await arena(seed, { map: ['PG'], guardian: { kind: 'core:goblin', hp: 100, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 40 } });
  const g = structuredClone(a.world.entities[a.gId]);
  delete g.role; delete g.guardian; delete g.home;
  if (g.actor?.ai) g.actor.ai.params = { fleeBelowHpPct: 25 };
  if (o.fleeing) g.stats!.hp = 10;
  const me = structuredClone(a.world.entities[a.meId]);
  me.stats!.hp = o.myHp ?? 40;
  if (o.armor !== undefined) { me.stats!.armor = o.armor; me.base!.armor = o.armor; }
  a.inject({ put: [g, me] });
  const mem: MonsterMemory = { kind: 'core:goblin', encounters: 3, kills: 3, maxDamageToYou: 8, maxDamageByYou: 5, abilities: [], hpSeen: { min: 6, max: 10, samples: 3 } };
  a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = mem;
  // 視界は最初の手で更新される（1 手待ってから、HP と装甲を置き直す）
  await a.r.port.act({ type: 'wait' }, { source: 'bot' });
  const me2 = structuredClone(a.world.entities[a.meId]);
  me2.stats!.hp = o.myHp ?? 40;
  if (o.armor !== undefined) { me2.stats!.armor = o.armor; me2.base!.armor = o.armor; }
  me2.statuses = [];
  a.inject({ put: [me2] });
  const view = () => projectPlayerView(a.world, a.pid);
  return { a, view };
}

describe('V3-5a evaluation fixes: fight (macro)', () => {
  it('hp_risk counts an adjacent fleeing enemy (a cornered one still hits)', async () => {
    const { a, view } = await scene('v35e-flee-risk', { fleeing: true, myHp: 20 });
    const v = view();
    expect(v.entities.find((e) => e.id === a.gId)?.fleeing).toBe(true);
    const st = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 15 }, catalog);
    expect(macroNext(st, v, catalog, [])).toEqual({ stop: 'hp_risk' });
    a.manager.closeAll();
  });

  it('a status stops the fight only the first time in the call; not your own brace, not rust that cannot lower your armor', async () => {
    const { a, view } = await scene('v35e-status', { armor: 0 });
    const v = view();
    const me = v.self.id;
    const st = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 1 }, catalog);
    expect('command' in macroNext(st, v, catalog, [])).toBe(true);
    const applied = (id: string, source: string | null): ProjectedEvent => ({ type: 'status_applied', seq: 1, cause: null, floor: null, ft: 0, wall: 0, target: me, targetKind: 'core:warrior', status: { id, turnsLeft: 5, power: 1, source }, statusesAfter: [] } as unknown as ProjectedEvent);
    // 自分の構え（source が自分）
    expect((macroNext(st, v, catalog, [applied('core:braced', me)]) as { stop?: string }).stop).not.toBe('status_changed');
    // 装甲 0 の錆は効き目が無い
    expect((macroNext(st, v, catalog, [applied('core:rust', a.gId)]) as { stop?: string }).stop).not.toBe('status_changed');
    // 毒は止まる。同じ呼び出しで一度掛かった状態は、切れて付き直しても止まらない
    expect(macroNext(st, v, catalog, [applied('core:poison', a.gId)])).toEqual({ stop: 'status_changed' });
    const st2 = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 1 }, catalog);
    macroNext(st2, v, catalog, []);
    st2.myStatuses.push('core:poison');
    expect((macroNext(st2, v, catalog, [applied('core:poison', a.gId)]) as { stop?: string }).stop).not.toBe('status_changed');
    a.manager.closeAll();
  });

  it('rust that lowers your armor still stops the fight once', async () => {
    const { a, view } = await scene('v35e-rust', { armor: 4 });
    const v = view();
    const st = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 1 }, catalog);
    macroNext(st, v, catalog, []);
    const ev = { type: 'status_applied', seq: 1, cause: null, floor: null, ft: 0, wall: 0, target: v.self.id, targetKind: 'core:warrior', status: { id: 'core:rust', turnsLeft: 10, power: 1, source: a.gId }, statusesAfter: [] } as unknown as ProjectedEvent;
    expect(macroNext(st, v, catalog, [ev])).toEqual({ stop: 'status_changed' });
    a.manager.closeAll();
  });

  it('flee does not refuse when HP is already under its default floor', async () => {
    const { a, view } = await scene('v35e-flee', { myHp: 5 });
    const low = macroStart(view(), { type: 'travel', to: 'stairs_up', mode: 'flee' }, catalog);
    expect(low.hpFloor).toBe(0);
    const me = structuredClone(a.world.entities[a.meId]);
    me.stats!.hp = 40;
    a.inject({ put: [me] });
    expect(macroStart(view(), { type: 'travel', to: 'stairs_up', mode: 'flee' }, catalog).hpFloor).toBe(10);
    // 明示した hp_floor はそのまま
    expect(macroStart(view(), { type: 'travel', to: 'stairs_up', mode: 'flee', hpFloor: 30 }, catalog).hpFloor).toBe(30);
    a.manager.closeAll();
  });
});

describe('V3-5a evaluation fixes: names and camp', () => {
  it('a guardian keeps its mark when its status ends and when you use an ability on it', () => {
    const ctx = { locale: 'ja' as const, catalog, selfId: 'e_me0001', playerNames: {} };
    const base = { seq: 1, cause: null, floor: null, ft: 0, wall: 0 };
    expect(narrate({ ...base, type: 'status_expired', target: 'e_g00001', targetKind: 'core:rust_slime', statusId: 'core:stun', statusesAfter: [], targetAffixes: ['core:guardian'] } as unknown as ProjectedEvent, ctx)).toBe('守護者錆の粘体の朦朧状態が解けた。');
    expect(narrate({ ...base, type: 'ability_used', actor: 'e_me0001', actorKind: 'core:warrior', ability: 'core:bash', target: 'e_g00001', targetKind: 'core:rust_slime', targetAffixes: ['core:guardian'], cooldownLeft: 0 } as unknown as ProjectedEvent, ctx)).toBe('強打を使った（守護者錆の粘体へ）。');
  });

  it('abilities are ready again after camp (like HP and statuses)', async () => {
    const a = await arena('v35e-camp', { map: ['P.......'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 40 } });
    const me = structuredClone(a.world.entities[a.meId]) as Entity;
    me.build = { ...(me.build ?? { perks: [], pending: [], abilities: [] }), abilities: [{ id: 'core:bash', readyAt: 9999 }] };
    a.inject({ put: [me] });
    const out = await a.r.port.act({ type: 'use', slot: a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:lifeline')!.item!.slot! }, { source: 'bot' });
    expect(out.ok).toBe(true);
    for (let i = 0; i < 6 && a.r.port.view().status !== 'at_camp'; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(a.r.port.view().status).toBe('at_camp');
    expect(a.world.entities[a.meId].build!.abilities[0].readyAt).toBe(0);
    expect(a.r.session.history.some((e: GameEvent) => e.type === 'player_state' && e.reason === 'lifeline')).toBe(true);
    a.manager.closeAll();
  });
});

let isid = 990000;
function knife(a: Awaited<ReturnType<typeof arena>>, x: number, y: number, kind = 'core:throwing_knife', mine = true): Entity {
  const id = `e_k${(++isid).toString(36).padStart(5, '0')}`;
  return { id, kind, sid: ++isid, pos: { floor: a.key, x, y }, item: { qty: 1, affixes: [], ...(mine ? { thrownBy: a.pid } : {}) } } as Entity;
}

describe('V3-5a evaluation fixes: collect, travel, explore toward sense', () => {
  it('collect leaves the item under an enemy for later and goes for a free one', async () => {
    const a = await arena('v35e-collect', { map: ['P....', '.....', '..G..'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 40 } });
    // 敵の足元（すぐ隣）と、少し離れた空いたマス
    const g = structuredClone(a.world.entities[a.gId]);
    g.pos = { ...g.pos!, x: a.ox + 1, y: a.oy + 1 };
    a.inject({ put: [g, knife(a, a.ox + 1, a.oy + 1), knife(a, a.ox + 4, a.oy)] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'collect', mode: 'flee' }, catalog);
    const d = macroNext(st, v, catalog, []);
    expect(d).toEqual({ command: { type: 'move', dir: 'e' } });
    a.manager.closeAll();
  });

  it('collect what:items picks up identified poison (it can be thrown); a cursed item stays', async () => {
    const a = await arena('v35e-poison', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 40 } });
    a.inject({ del: [a.gId] });
    a.world.players[a.pid].knowledge.identified = [...new Set([...a.world.players[a.pid].knowledge.identified, 'core:potion_poison'])];
    a.inject({ put: [knife(a, a.ox + 2, a.oy, 'core:potion_poison', false)] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const out = await a.r.port.act({ type: 'collect', what: 'items' }, { source: 'bot' });
    expect(out.ok).toBe(true);
    expect(a.r.port.view().inventory.some((i) => i.kind === 'core:potion_poison')).toBe(true);
    a.manager.closeAll();
  });

  it('explore toward:sense refuses once the relic or guardian is in view, pointing to travel_to', async () => {
    const a = await arena('v35e-sense', { map: ['P...G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 40 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const out = await a.r.port.act({ type: 'explore', toward: 'sense' }, { source: 'bot' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.hint).toContain('travel_to');
    a.manager.closeAll();
  });
});

describe('V3-5a evaluation fixes: report and fight text', () => {
  it('the report counts thrown hits and misses; least / fewest say they compare completed expeditions', () => {
    const me = 'e_me0001';
    const ev = (seq: number, type: string, p: Record<string, unknown>) => ({ type, seq, cause: null, floor: 'main:2', ft: 0, wall: 0, ...p }) as unknown as ProjectedEvent;
    const r = buildExpeditionReport({ locale: 'ja', catalog, selfId: me, no: 2, marks: [], calls: [], events: [
      ev(1, 'expedition_started', { expedition: { no: 2, objective: { type: 'reach_depth', targetDepth: 2 }, self: { turns: 0, hp: 30, maxHp: 30 } } }),
      ev(2, 'item_thrown', { actor: me, outcome: 'hit' }), ev(3, 'item_thrown', { actor: me, outcome: 'missed' }), ev(4, 'attack', { attacker: me, hit: true, crit: false }),
      ev(5, 'expedition_ended', { no: 2, reason: 'completed', result: { reason: 'completed', deepest: 2, payout: { banked: 100, lost: 0, multiplierPct: 100, parts: { objective: 100, overreach: 0, treasure: 0, bounty: 0, discovery: 0, kills: 0 }, players: [] } } }),
    ] });
    expect(r.combat.hits).toBe(2);
    expect(r.combat.misses).toBe(1);
    const prev: ExpeditionReport = { ...r, no: 1, combat: { ...r.combat, taken: 50 }, tempo: { ...r.tempo, turns: 500, tool_calls: 90 } };
    const c = compareReports('ja', r, [prev])!;
    expect(c.personal_best).toContain('被ダメージが達成した遠征で最少（0）');
  });

  it('a fight that mixes throws and melee says both', async () => {
    const a = await arena('v35e-mixed', { map: ['PG'], guardian: { kind: 'core:goblin', hp: 500, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 200, acc: 30, items: [{ kind: 'core:throwing_knife', qty: 3 }] } });
    const slot = a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:throwing_knife')!.item!.slot!;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const out = await a.r.port.act({ type: 'fight', target: a.gId, with: slot, adjacent: 'melee', hpFloor: 1 }, { source: 'bot' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.outcome).toMatch(/近接 \d+ 回|回攻撃し/);
    if (out.ok) expect(out.outcome).not.toMatch(/\d+ 回投げ \d+ 回命中/);
    a.manager.closeAll();
  });
});

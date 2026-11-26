// 音の状態（docs/SOUND_SPEC.md §2・§7）の確認: 視界と届いた出来事だけから作る、同じ入力から同じ状態、視界の外の敵では変わらない、
// 場面の決め方・各入力・合図。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Entity, ExpeditionOffer, GameEvent, PlayerView, ProjectedEvent, World } from '@muse/shared';
import { applyEvent, projectPlayerView, soundStep } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 996000;

async function newRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'human', label: 't' } });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const view = () => projectPlayerView(world, pid);
  const start = async () => {
    world.camp!.offers = [{ index: 1, points: 500, relicGuarded: false, slot: 'standard', traits: [], multiplierPct: 100, objective: { type: 'reach_depth', targetDepth: 3 } } as ExpeditionOffer];
    expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  };
  return { manager, r, world, pid, meId, inject, view, start };
}

function goblin(id: string, floor: string, x: number, y: number, state: 'hunting' | 'unaware' = 'hunting'): Entity {
  sid++;
  return {
    id, kind: 'core:goblin', sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 1e9, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state, targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp: 10, maxHp: 10, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d1' },
    base: { maxHp: 10, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d1' },
    statuses: [],
  };
}

/** 視界の中の通れるマス（自分から距離 d） */
function visibleCell(t: Awaited<ReturnType<typeof newRun>>, d: number): { x: number; y: number } {
  const v = t.view();
  const me = v.self.pos!;
  const f = t.world.floors[v.floor!.key];
  const vis = new Set(v.visibleCells);
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      if (Math.max(Math.abs(x - me.x), Math.abs(y - me.y)) !== d || !vis.has(y * f.width + x)) continue;
      const tr = content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[y * f.width + x]]]];
      if (tr?.passable && !tr.stairs && !Object.values(t.world.entities).some((e) => e.pos?.floor === f.key && e.pos.x === x && e.pos.y === y)) return { x, y };
    }
  }
  throw new Error(`no visible cell at ${d}`);
}

/** 視界の外の通れるマス */
function hiddenCell(t: Awaited<ReturnType<typeof newRun>>): { x: number; y: number } {
  const v = t.view();
  const f = t.world.floors[v.floor!.key];
  const vis = new Set(v.visibleCells);
  for (let i = f.terrain.length - 1; i >= 0; i--) {
    const tr = content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[i]]]];
    if (tr?.passable && !vis.has(i)) return { x: i % f.width, y: Math.floor(i / f.width) };
  }
  throw new Error('no hidden cell');
}

const ev = (e: Record<string, unknown>) => e as unknown as ProjectedEvent;

describe('sound state (SOUND_SPEC §2.1)', () => {
  it('at camp: scene camp with the fixed floor values; on a floor: explore with depth, biome and floor kind', async () => {
    const t = await newRun('sound-1');
    const c = soundStep(null, t.view(), [], catalog).state;
    expect(c).toMatchObject({ scene: 'camp', depth_band: 0, depth_tier: 0, biome: 'none', floor_kind: 'other', threat: 0, sense: 'none', stake: 0, telegraph: false });
    await t.start();
    const v = t.view();
    const s = soundStep(null, v, [], catalog).state;
    expect(s).toMatchObject({ scene: 'explore', depth_band: 0, depth_tier: 0, biome: v.floor!.biome, threat: 0, hp: 'healthy', ailment: false, boost: false });
    expect(['standard', 'sanctuary', 'warden_hall', 'other']).toContain(s.floor_kind);
    t.manager.closeAll();
  });

  it('is a pure function of the view: same input, same output; an enemy out of sight changes nothing', async () => {
    const t = await newRun('sound-2');
    await t.start();
    const v1 = t.view();
    const a = soundStep(null, v1, [], catalog);
    expect(soundStep(null, structuredClone(v1), [], catalog)).toEqual(a);
    const h = hiddenCell(t);
    t.inject({ put: [goblin('e_snd_hid', v1.floor!.key, h.x, h.y)] });
    expect(soundStep(null, t.view(), [], catalog).state).toEqual(a.state);
    // 見えるところに来れば変わる
    const c = visibleCell(t, 3);
    t.inject({ put: [goblin('e_snd_vis', v1.floor!.key, c.x, c.y)] });
    expect(soundStep(null, t.view(), [], catalog).state).toMatchObject({ scene: 'alert', threat: 1 });
    t.manager.closeAll();
  });

  it('scene: alert when a hunting enemy is seen, combat when one is adjacent or after a fight in the last 3 turns; threat by count', async () => {
    const t = await newRun('sound-3');
    await t.start();
    const key = t.view().floor!.key;
    const adj = visibleCell(t, 1);
    t.inject({ put: [goblin('e_snd_a', key, adj.x, adj.y)] });
    expect(soundStep(null, t.view(), [], catalog).state).toMatchObject({ scene: 'combat', threat: 1 });
    // 眠っている・気づいていない敵は追跡中に数えない
    t.inject({ del: ['e_snd_a'] });
    t.inject({ put: [goblin('e_snd_b', key, adj.x, adj.y, 'unaware')] });
    expect(soundStep(null, t.view(), [], catalog).state).toMatchObject({ scene: 'explore', threat: 0 });
    // 数: 1 体＝1、2〜3 体＝2、4 体以上＝3（ビューの写しで）
    const base = t.view();
    const mk = (n: number): PlayerView => ({ ...base, entities: [...base.entities, ...Array.from({ length: n }, (_, i) => ({ id: `e_n${i}`, cat: 'monster' as const, kind: 'core:goblin', appearanceId: null, pos: { x: base.self.pos!.x + 3, y: base.self.pos!.y + i }, awareness: 'hunting' as const }))] });
    expect([1, 2, 3, 4, 6].map((n) => soundStep(null, mk(n), [], catalog).state.threat)).toEqual([1, 2, 2, 3, 3]);
    // 直前の戦い: 見えない相手に撃たれた手番から 3 手番の間は combat
    const v = t.view();
    const hit = soundStep(null, v, [ev({ type: 'attack', attacker: null, target: v.self.id, hit: true, crit: false })], catalog);
    expect(hit.state.scene).toBe('combat');
    expect(hit.cues).toEqual(['hit_taken']);
    const later = (n: number): PlayerView => ({ ...v, self: { ...v.self, turns: v.self.turns + n } });
    expect([1, 2, 3].map((n) => soundStep(hit.memory, later(n), [], catalog).state.scene)).toEqual(['combat', 'combat', 'explore']);
    t.manager.closeAll();
  });

  it('guardian and warden scenes, telegraph, sense, depth, ailment and boost', async () => {
    const t = await newRun('sound-4');
    await t.start();
    const v = t.view();
    const g = { id: 'e_g', cat: 'monster' as const, kind: 'core:goblin', appearanceId: null, pos: { x: 1, y: 1 }, awareness: 'unaware' as const, guardian: { name: { ja: 'グ', en: 'G' }, types: [] } };
    expect(soundStep(null, { ...v, entities: [g] }, [], catalog).state.scene).toBe('guardian');
    expect(soundStep(null, { ...v, entities: [{ ...g, guardian: { ...g.guardian, warden: true } }] }, [], catalog).state.scene).toBe('warden');
    const tele = { ...g, guardian: undefined, intent: { kind: 'winding_up' as const, dir: 'e' as const } };
    const first = soundStep(null, v, [], catalog);
    const st = soundStep(first.memory, { ...v, entities: [tele] }, [], catalog);
    expect(st.state.telegraph).toBe(true);
    expect(st.cues).toEqual(['telegraph_start']);
    expect(soundStep(st.memory, { ...v, entities: [tele] }, [], catalog).cues).toEqual([]);
    expect(soundStep(null, { ...v, sense: { what: 'relic', dir: 'n', range: 'near' } }, [], catalog).state.sense).toBe('near');
    const deep = (d: number) => soundStep(null, { ...v, floor: { ...v.floor!, depth: d } }, [], catalog).state;
    expect([1, 4, 5, 14, 15, 19, 20, 33].map((d) => [deep(d).depth_band, deep(d).depth_tier])).toEqual([[0, 0], [0, 0], [1, 1], [2, 2], [3, 3], [3, 3], [3, 4], [3, 6]]);
    const withStatus = (id: string) => soundStep(null, { ...v, self: { ...v.self, statuses: [{ id, turnsLeft: 3, power: 1 }] } }, [], catalog).state;
    expect(withStatus('core:poison')).toMatchObject({ ailment: true, boost: false });
    expect(withStatus('core:haste')).toMatchObject({ ailment: false, boost: true });
    expect(withStatus('core:recall')).toMatchObject({ ailment: false, boost: false });
    t.manager.closeAll();
  });

  it('ended keeps the last floor; near death is a cue only when entering the band', async () => {
    const t = await newRun('sound-5');
    await t.start();
    const v = t.view();
    const a = soundStep(null, v, [], catalog);
    const low = { ...v, self: { ...v.self, stats: { ...v.self.stats, hp: 1 } } };
    const b = soundStep(a.memory, low, [], catalog);
    expect(b.state.hp).toBe('near_death');
    expect(b.cues).toEqual(['near_death']);
    expect(soundStep(b.memory, low, [], catalog).cues).toEqual([]);
    const dead = soundStep(b.memory, { ...low, status: 'dead', floor: null }, [ev({ type: 'died', id: v.self.id, killer: null })], catalog);
    expect(dead.state).toMatchObject({ scene: 'ended', depth_tier: a.state.depth_tier, biome: a.state.biome });
    expect(dead.cues).toEqual(['death']);
    t.manager.closeAll();
  });
});

describe('sound cues (SOUND_SPEC §2.2)', () => {
  it('come from the events that reached the player, in order; hit and crit are not both played for one blow', async () => {
    const t = await newRun('sound-6');
    await t.start();
    const v = t.view();
    const me = v.self.id;
    const m0 = soundStep(null, v, [], catalog).memory;
    const step = (evs: Record<string, unknown>[]) => soundStep(m0, v, evs.map(ev), catalog).cues;
    expect(step([{ type: 'attack', attacker: me, target: 'e_x', hit: true, crit: true }, { type: 'damaged', target: 'e_x', source: me, via: 'melee' }])).toEqual(['crit_dealt']);
    expect(step([{ type: 'attack', attacker: me, target: 'e_x', hit: true, crit: false }, { type: 'damaged', target: 'e_x', source: me, via: 'melee' }, { type: 'died', id: 'e_x', killer: me }])).toEqual(['hit_dealt', 'kill']);
    expect(step([{ type: 'attack', attacker: me, target: 'e_x', hit: false, crit: false }])).toEqual(['miss']);
    expect(step([{ type: 'attack', attacker: 'e_x', target: me, hit: true, crit: true }, { type: 'damaged', target: me, source: 'e_x', via: 'melee' }])).toEqual(['crit_taken']);
    // 罠の被害は hit_taken、毒の刻みは鳴らさない
    expect(step([{ type: 'damaged', target: me, source: null, via: 'trap' }, { type: 'damaged', target: me, source: null, via: 'poison' }])).toEqual(['hit_taken']);
    // 投げた物が当たった（攻撃の出来事が無い）
    expect(step([{ type: 'item_thrown', actor: me, outcome: 'hit' }, { type: 'damaged', target: 'e_x', source: me, via: 'thrown' }])).toEqual(['hit_dealt']);
    expect(step([{ type: 'level_up', target: me }, { type: 'entity_changed_floor', id: me }, { type: 'objective_completed' }, { type: 'boon_granted', target: me }, { type: 'haul_changed', gains: { discovery: 50 } }]))
      .toEqual(['level_up', 'stairs', 'objective', 'boon', 'discovery']);
    expect(step([{ type: 'player_state', player: v.playerId, state: 'at_camp', reason: 'lifeline' }])).toEqual(['lifeline']);
    expect(step([{ type: 'player_state', player: v.playerId, state: 'at_camp', reason: 'withdrew' }])).toEqual(['extract']);
    expect(step([{ type: 'item_picked_up', actor: me, kind: 'core:potion_heal' }, { type: 'item_picked_up', actor: me, kind: Object.entries(catalog.items).find(([, i]) => i.category === 'treasure')![0] }])).toEqual(['pickup', 'treasure']);
    // ほかの者の出来事では鳴らさない
    expect(step([{ type: 'attack', attacker: 'e_y', target: 'e_x', hit: true, crit: true }, { type: 'level_up', target: 'e_y' }, { type: 'died', id: 'e_x', killer: 'e_y' }])).toEqual([]);
    // 見えていた守護者が倒れた
    const g = { id: 'e_g', cat: 'monster' as const, kind: 'core:goblin', appearanceId: null, pos: { x: 1, y: 1 }, awareness: 'hunting' as const, guardian: { name: { ja: 'グ', en: 'G' }, types: [] } };
    const seen = soundStep(m0, { ...v, entities: [g] }, [], catalog).memory;
    expect(soundStep(seen, v, [ev({ type: 'died', id: 'e_g', killer: me })], catalog).cues).toEqual(['kill', 'guardian_down']);
    expect(soundStep(seen, v, [ev({ type: 'warden_slain', id: 'e_w' })], catalog).cues).toEqual(['warden_down']);
    t.manager.closeAll();
  });

  it('foe_down (S16a §70.3 の 3): a seen enemy felled by someone else; not with kill, guardian_down or warden_down; not for unseen deaths or players', async () => {
    const t = await newRun('sound-foe');
    await t.start();
    const v = t.view();
    const me = v.self.id;
    const m0 = soundStep(null, v, [], catalog).memory;
    const step = (evs: Record<string, unknown>[], mem = m0) => soundStep(mem, v, evs.map(ev), catalog).cues;
    // 見えていた敵が、ほかの者（罠・毒・仲間）の手で倒れた
    expect(step([{ type: 'died', id: 'e_x', kind: 'core:goblin', killer: 'e_y', via: 'melee' }])).toEqual(['foe_down']);
    expect(step([{ type: 'died', id: 'e_x', kind: 'core:goblin', killer: null, via: 'poison' }])).toEqual(['foe_down']);
    // 自分が倒した: kill だけ（重ねない）
    expect(step([{ type: 'died', id: 'e_x', kind: 'core:goblin', killer: me, via: 'melee' }])).toEqual(['kill']);
    // 見えていない死（id と種族が伏せられた）: 鳴らさない
    expect(step([{ type: 'died', id: null, kind: null, killer: null, via: 'poison' }])).toEqual([]);
    // ほかのプレイヤーが倒れた（体の種類は職）: 敵の撃破ではない
    expect(step([{ type: 'died', id: 'e_ally1', kind: 'core:warrior', killer: 'e_x', via: 'melee' }])).toEqual([]);
    // 見えていた守護者・大守護者: その合図だけ
    const g = { id: 'e_g', cat: 'monster' as const, kind: 'core:goblin', appearanceId: null, pos: { x: 1, y: 1 }, awareness: 'hunting' as const, guardian: { name: { ja: 'グ', en: 'G' }, types: [] } };
    const w = { ...g, id: 'e_w', guardian: { ...g.guardian, warden: true } };
    const seen = soundStep(m0, { ...v, entities: [g, w] } as PlayerView, [], catalog).memory;
    expect(step([{ type: 'died', id: 'e_g', kind: 'core:goblin', killer: 'e_y' }], seen)).toEqual(['guardian_down']);
    expect(step([{ type: 'died', id: 'e_w', kind: 'core:goblin', killer: null }], seen)).toEqual(['warden_down']);
    // 攻撃の出来事が届かない当たり（遊ぶ画面・追従だけの観戦の枠: 会心でない当たりの attack は文にならない）: 被害から hit_dealt。attack が届いていれば 1 回だけ
    expect(step([{ type: 'ability_used', actor: me, ability: 'core:bash' }, { type: 'damaged', target: 'e_x', source: me, via: 'melee' }, { type: 'died', id: 'e_x', kind: 'core:goblin', killer: me }])).toEqual(['hit_dealt', 'kill']);
    expect(step([{ type: 'attack', attacker: me, target: 'e_x', hit: true, crit: false }, { type: 'damaged', target: 'e_x', source: me, via: 'melee' }])).toEqual(['hit_dealt']);
    // 同じ手に 2 体倒れたら 2 回（まとめるのは鳴らす側: 0.15 秒以内の同じ合図は 1 つ）
    expect(step([{ type: 'died', id: 'e_a', kind: 'core:goblin', killer: 'e_y' }, { type: 'died', id: 'e_b', kind: 'core:goblin', killer: 'e_y' }])).toEqual(['foe_down', 'foe_down']);
    t.manager.closeAll();
  });

  it('only takes the player view and events (not the World)', () => {
    const fn = (w: World) => {
      // @ts-expect-error World は PlayerView ではない（音の状態は視界のデータからだけ作る。SOUND_SPEC §7）
      soundStep(null, w, [], catalog);
    };
    expect(typeof fn).toBe('function');
  });
});

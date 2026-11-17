// コンテンツ定義 → エンティティ。深層スケーリングと接辞を反映する。
import type { Content } from '@muse/content';
import type { Entity, FloorKey } from '@muse/shared';
import { addDiceBonus, floorDiv } from '@muse/shared';
import type { Ctx } from './ctx';
import type { SpawnSpec } from './gen/generate';

export function sumAffixMods(content: Content, affixes: readonly string[]) {
  const m = { hpPct: 0, speed: 0, acc: 0, eva: 0, might: 0, armor: 0, dmgBonus: 0, xpPct: 0, maxHp: 0, sight: 0 };
  for (const id of affixes) {
    const a = content.affixes[id];
    if (!a) continue;
    for (const k of Object.keys(m) as (keyof typeof m)[]) m[k] += a.mods[k] ?? 0;
  }
  return m;
}

export function makeMonster(ctx: Ctx, floor: FloorKey, spec: Extract<SpawnSpec, { type: 'monster' }>, id: string, sid: number): Entity {
  const def = ctx.content.monsters[spec.kind];
  const mods = sumAffixMods(ctx.content, spec.affixes);
  const tier = spec.tier;
  const raw = Math.max(1, spec.minHp ?? 0, floorDiv(spec.hp * (100 + 50 * tier + mods.hpPct + (spec.hpBonusPct ?? 0)), 100));
  const maxHp = spec.maxHp !== undefined ? Math.max(1, Math.min(raw, spec.maxHp)) : raw;
  const base = {
    maxHp,
    acc: def.stats.acc + 2 * tier + mods.acc,
    eva: def.stats.eva + floorDiv(tier, 2) + mods.eva,
    might: def.stats.might + tier + mods.might,
    armor: def.stats.armor + floorDiv(tier, 2) + mods.armor,
    sight: def.stats.sight,
    dmg: addDiceBonus(def.attack.dice, mods.dmgBonus),
  };
  const { archetype, ...params } = def.ai;
  const f = ctx.world.floors[floor];
  const e: Entity = {
    id, kind: def.id, sid,
    pos: { floor, x: spec.x, y: spec.y },
    actor: {
      speed: Math.max(def.speed + mods.speed, spec.minSpeed ?? 0),
      nextActAt: (f?.time ?? 0) + spec.delay,
      faction: 'monster',
      turns: 0,
      ai: { archetype, state: spec.asleep ? 'asleep' : 'unaware', targetPos: null, lostTurns: 0, params: params as Record<string, number> },
    },
    stats: { hp: maxHp, ...base },
    base,
    statuses: [],
    xp: floorDiv(def.xp * (100 + 50 * tier + mods.xpPct), 100),
  };
  if (spec.asleep) e.actor!.dormant = true;
  if (tier > 0 || spec.affixes.length) e.scale = { tier, affixes: [...spec.affixes] };
  if (spec.role) e.role = spec.role;
  if (spec.bounty) e.bounty = spec.bounty;
  // 守護者は置かれたマスを持ち場にする（守護者付きの遺物では遺物の隣。V3-2R3b §23.2）
  if (spec.role === 'guardian') e.home = { x: spec.x, y: spec.y };
  // 守護者の型・名前・弱点（V3-3）
  if (spec.guardian) e.guardian = structuredClone(spec.guardian);
  // 持たせる品（宝物庫の鍵。V3-5 §5.1）
  if (spec.carries) e.carries = spec.carries;
  // 名前付きの強敵（V3-5 §5.4）と巡回の道（V3-5 §5.3）
  if (spec.elite) { e.named = { ...spec.elite }; if (!e.role) e.role = 'elite'; }
  if (spec.route?.length) e.actor!.ai = { ...e.actor!.ai!, archetype: 'patrol', route: spec.route.map((q) => ({ ...q })), routeIdx: 1 % spec.route.length };
  return e;
}

export function makeItem(floor: FloorKey | null, kind: string, x: number, y: number, qty: number, affixes: string[], id: string, sid: number, value?: number, hidden?: string[]): Entity {
  const e: Entity = { id, kind, sid, item: { qty, affixes: [...affixes] } };
  if (value !== undefined) e.item!.value = value;
  if (hidden?.length) e.item!.hidden = [...hidden];
  if (floor) e.pos = { floor, x, y };
  return e;
}

export function makeFeature(ctx: Ctx, floor: FloorKey, kind: string, x: number, y: number, id: string, sid: number): Entity {
  const def = ctx.content.features[kind];
  const e: Entity = { id, kind, sid, pos: { floor, x, y } };
  if (def.category === 'trap') e.trap = { revealedTo: [] };
  else e.feature = { state: def.initialState };
  return e;
}

/** 生成仕様からエンティティを作り entity_spawned を発行する */
export function spawnFromSpec(ctx: Ctx, floor: FloorKey, spec: SpawnSpec, reason: string, opts: { lairOf?: string } = {}): Entity {
  const id = ctx.newEntityId();
  const sid = ctx.nextSid();
  let e: Entity;
  if (spec.type === 'monster') e = makeMonster(ctx, floor, spec, id, sid);
  else if (spec.type === 'item') {
    e = makeItem(floor, spec.kind, spec.x, spec.y, spec.qty, spec.affixes, id, sid, spec.value, spec.hidden);
    if (spec.role) e.role = spec.role;
  } else {
    e = makeFeature(ctx, floor, spec.kind, spec.x, spec.y, id, sid);
    if (spec.links?.length) e.links = spec.links.map((q) => ({ ...q }));
  }
  // 棲み処の地物の持ち主（V3-3c §44.6）
  if (opts.lairOf) e.lairOf = opts.lairOf;
  const seen = ctx.perceive(floor, [{ field: 'entity', pos: e.pos }]);
  ctx.emit({ type: 'entity_spawned', entity: e, reason, floor, seenBy: seen.seenBy });
  return ctx.world.entities[id];
}

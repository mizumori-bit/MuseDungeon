// 実効能力値（基本値＋装備＋接辞）と実効速度。
import type { Entity, Stats } from '@muse/shared';
import { addDiceBonus, floorDiv } from '@muse/shared';
import type { Ctx } from './ctx';
import { sumAffixMods } from './spawn';

export function effectiveStats(ctx: Ctx, e: Entity): Stats {
  const b = e.base!;
  const s: Stats = { hp: e.stats?.hp ?? b.maxHp, maxHp: b.maxHp, acc: b.acc, eva: b.eva, might: b.might, armor: b.armor, sight: b.sight, dmg: b.dmg };
  for (const slot of ['weapon', 'armor', 'accessory'] as const) {
    const id = e.equip?.[slot];
    if (!id) continue;
    const it = ctx.world.entities[id];
    const def = it ? ctx.content.items[it.kind] : undefined;
    if (!def?.equip) continue;
    const mods = sumAffixMods(ctx.content, it.item?.affixes ?? []);
    s.acc += def.equip.acc + mods.acc;
    s.eva += def.equip.eva + mods.eva;
    s.might += def.equip.might + mods.might;
    s.armor += def.equip.armor + mods.armor;
    if (slot === 'weapon' && def.equip.dmg) s.dmg = addDiceBonus(def.equip.dmg, mods.dmgBonus);
  }
  if (s.hp > s.maxHp) s.hp = s.maxHp;
  return s;
}

function sameStats(a: Stats | undefined, b: Stats): boolean {
  if (!a) return false;
  return a.hp === b.hp && a.maxHp === b.maxHp && a.acc === b.acc && a.eva === b.eva && a.might === b.might
    && a.armor === b.armor && a.sight === b.sight && a.dmg === b.dmg;
}

export function recomputeStats(ctx: Ctx, e: Entity, reason: string): void {
  const s = effectiveStats(ctx, e);
  if (sameStats(e.stats, s)) return;
  ctx.emit({ type: 'stats_changed', target: e.id, statsAfter: s, baseAfter: null, speedAfter: null, reason, seenBy: e.player ? [e.player] : [] });
}

export function effSpeed(ctx: Ctx, e: Entity): number {
  let sp = e.actor?.speed ?? 100;
  for (const st of e.statuses ?? []) {
    const def = ctx.content.statuses[st.id];
    if (def?.handler === 'speed_pct') sp = floorDiv(sp * (def.params.pct ?? 100), 100);
  }
  return Math.max(10, sp);
}

/** 行動コスト（標準 100）→ nextActAt の増分 */
export function actionDelay(ctx: Ctx, e: Entity, cost = 100): number {
  return Math.max(1, floorDiv(cost * 100, effSpeed(ctx, e)));
}

// 加護（V3-3 §3.3）: 遺物を持ち帰る（・大守護者を倒す）と付き、ランの終わりまで残る。
// mods は取ったときに素の能力値へ足す（特技と同じ）。hooks は各所（自然回復・投擲・起床・階段・致死）が読む。
import type { Content } from '@muse/content';
import type { Entity, RelicInfo } from '@muse/shared';
import { Rng } from '@muse/shared';
import type { Ctx } from './ctx';
import { recomputeStats } from './stats';

/** その者の加護の hook（最初に見つかったもの。無ければ null） */
export function boonHook(ctx: Ctx, e: Entity | null | undefined, hook: string): { boon: string; params: Record<string, number> } | null {
  for (const id of e?.boons ?? []) {
    for (const h of ctx.content.boons[id]?.hooks ?? []) if (h.hook === hook) return { boon: id, params: h as unknown as Record<string, number> };
  }
  return null;
}

/** 加護を付ける（素の能力値の修正を足し、加護の一覧に入れる）。同じ加護をもう持っていれば何もしない */
export function grantBoon(ctx: Ctx, e: Entity, boonId: string, source: string, edit?: (body: Entity) => void): boolean {
  const def = ctx.content.boons[boonId];
  const cur = ctx.world.entities[e.id];
  if (!def || !cur || (cur.boons ?? []).includes(boonId)) return false;
  const body = structuredClone(cur);
  edit?.(body);
  body.boons = [...(body.boons ?? []), boonId];
  const m = def.mods;
  if (body.base) {
    body.base.maxHp += m.maxHp;
    body.base.acc += m.acc;
    body.base.eva += m.eva;
    body.base.might += m.might;
    body.base.armor += m.armor;
    body.base.sight += m.sight;
  }
  if (body.stats && m.maxHp > 0) body.stats.hp += m.maxHp;
  ctx.emit({ type: 'boon_granted', target: e.id, boon: boonId, source, put: [body], seenBy: body.player ? [body.player] : [], floor: body.pos?.floor ?? null });
  recomputeStats(ctx, ctx.world.entities[e.id], 'boon');
  return true;
}

/** 遺物の公開情報（名前と加護）。owned: 参加者がもうその加護を持っている */
export function relicInfo(content: Content, kind: string, owned: ReadonlySet<string>): RelicInfo {
  const it = content.items[kind];
  const boon = it?.boon ?? null;
  const b = boon ? content.boons[boon] : undefined;
  return {
    kind, name: { ...(it?.name ?? { ja: kind, en: kind }) }, boon,
    ...(b ? { boonName: { ...b.name }, boonDesc: { ...b.desc } } : {}),
    ...(boon && owned.has(boon) ? { owned: true } : {}),
  };
}

/**
 * 遺物の候補を引く（状態を持たない: seed|expedition|通番|relic|枠）。参加者のまだ持っていない加護の遺物から引き、
 * すべて持っていれば全体から引く（そのときの遺物は owned になり、持ち帰っても新しい加護は付かない）
 */
export function pickRelic(content: Content, seed: string, no: number, slotIndex: number, owned: ReadonlySet<string>, avoid: ReadonlySet<string> = new Set()): RelicInfo | null {
  const all = content.lists.relics;
  if (!all.length) return null;
  const rng = Rng.fromSeed(`${seed}|expedition|${no}|relic|${slotIndex}`);
  // 同じキャンプのほかの候補に出た遺物は避ける（V3-7a 後の評価: 同じ欠片が 2 枠に同時に出た）
  const fresh = all.filter((it) => !owned.has(it.boon!));
  const freshNew = fresh.filter((it) => !avoid.has(it.id));
  const pool = freshNew.length ? freshNew : fresh.length ? fresh : all;
  return relicInfo(content, pool[rng.int(pool.length)].id, owned);
}

/** 今いる参加者（とキャンプの者）が持っている加護の集合 */
export function ownedBoons(ctx: Ctx): Set<string> {
  const out = new Set<string>();
  for (const pid of ctx.world.playerOrder) {
    const pr = ctx.world.players[pid];
    if (!pr || (pr.state !== 'alive' && pr.state !== 'at_camp')) continue;
    for (const b of ctx.world.entities[pr.entityId]?.boons ?? []) out.add(b);
  }
  return out;
}

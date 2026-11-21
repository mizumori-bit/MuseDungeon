// 状態異常。振る舞いはハンドラ（dot / speed_pct / incapacitate）で、定義はデータ。
import type { StatusDef } from '@muse/content';
import type { Entity, StatusInst } from '@muse/shared';
import { applyDamage } from './combat';
import type { Ctx } from './ctx';
import { lifelineReturn } from './expedition';
import { fireReturnExpire, fireReturnTick } from './campfire';
import { Registry } from './registry';
import { notePerk, perkHook, perkWithHook } from './build';
import { guardianDotMult } from './guardians';

export interface StatusHandler {
  /** 手番開始時の処理（毒ダメージなど） */
  tick?(ctx: Ctx, e: Entity, inst: StatusInst, def: StatusDef): void;
  /** 行動不能にするか */
  incapacitates?: boolean;
  /** 効果が切れたときの処理（帰還の綱: キャンプへ戻る） */
  expire?(ctx: Ctx, e: Entity, inst: StatusInst): void;
}

export const statusHandlers = new Registry<StatusHandler>('statusHandler');

statusHandlers.register('dot', {
  tick(ctx, e, inst) {
    // 毒を与えた者がまだいれば、その者のダメージとして数える（倒せばその者の撃破・賞金・経験値）
    const src = inst.source ? ctx.world.entities[inst.source] ?? null : null;
    // 毒に弱い守護者は 2 倍（V3-3）
    const mult = e.guardian ? guardianDotMult(ctx, e, inst.id) : 1;
    applyDamage(ctx, e, Math.max(1, inst.power) * mult, src && (src.stats?.hp ?? 0) > 0 ? src : null, 'poison');
  },
});
statusHandlers.register('speed_pct', {});
statusHandlers.register('incapacitate', { incapacitates: true });
// V3-4: 身かわし（近接が当たらない）・構え（次の一撃の装甲。power が上乗せ）・怯え（逃げ出す HP の閾値に power を足す）。効果は戦闘と AI が読む
statusHandlers.register('evade', {});
statusHandlers.register('brace', {});
statusHandlers.register('cowed', {});
// V3-5a: 能力値の修正（錆: 装甲 −2）。効果は armorOf が読む
statusHandlers.register('stat_mod', {});
// 帰還の綱（V3-2R2 §18.1）: その間は行動できず、切れたらキャンプへ戻る。被害は受ける
statusHandlers.register('recall', { incapacitates: true, expire: (ctx, e) => lifelineReturn(ctx, e) });
// 野営の火からの帰り支度（S1c §14.3 の 1）: その間は行動できない。手番の始めに、追ってくる敵が見えたら取りやめ。切れたら火から帰る
statusHandlers.register('fire_return', { incapacitates: true, tick: (ctx, e) => fireReturnTick(ctx, e), expire: (ctx, e, inst) => fireReturnExpire(ctx, e, inst.power) });

function statusSeen(ctx: Ctx, e: Entity) {
  return e.pos ? ctx.perceive(e.pos.floor, [{ field: 'target', pos: e.pos, entity: e.id }], e.player ? [e.player] : []) : { seenBy: e.player ? [e.player] : [] };
}

export function addStatus(ctx: Ctx, e: Entity, id: string, turns: number, power: number, source: string | null = null): void {
  if (!ctx.content.statuses[id] || turns <= 0) return;
  // 鉄の胃: 毒の手番が短くなる（V3-4 §4.1）
  if (id === 'core:poison') {
    const h = perkHook(ctx, e, 'poison_resist');
    if (h) {
      turns = Math.max(1, Math.ceil((turns * (h.pct ?? 50)) / 100));
      notePerk(ctx, e, perkWithHook(ctx, e, 'poison_resist'), 'poison_halved');
    }
  }
  const cur = (e.statuses ?? []).map((s) => ({ ...s }));
  const existing = cur.find((s) => s.id === id);
  let inst: StatusInst;
  if (existing) {
    existing.turnsLeft = Math.max(existing.turnsLeft, turns);
    existing.power = Math.max(existing.power, power);
    if (source) existing.source = source;
    inst = existing;
  } else {
    inst = { id, turnsLeft: turns, power, ...(source ? { source } : {}) };
    cur.push(inst);
  }
  ctx.emit({
    type: 'status_applied', target: e.id, targetKind: e.kind, status: { ...inst }, statusesAfter: cur,
    ...(e.scale?.affixes?.length ? { targetAffixes: [...e.scale.affixes] } : {}), ...statusSeen(ctx, e),
  });
}

export function removeStatus(ctx: Ctx, e: Entity, id: string): boolean {
  if (!(e.statuses ?? []).some((s) => s.id === id)) return false;
  const after = (e.statuses ?? []).filter((s) => s.id !== id).map((s) => ({ ...s }));
  ctx.emit({ type: 'status_expired', target: e.id, targetKind: e.kind, statusId: id, statusesAfter: after, ...(e.scale?.affixes?.length ? { targetAffixes: [...e.scale.affixes] } : {}), ...statusSeen(ctx, e) });
  return true;
}

/** 手番開始時に状態異常を処理する。行動不能だったら true */
export function tickStatuses(ctx: Ctx, e: Entity): boolean {
  if (!e.statuses?.length) return false;
  const incapIds: string[] = [];
  for (const inst of [...e.statuses]) {
    const def = ctx.content.statuses[inst.id];
    if (!def) continue;
    const h = statusHandlers.get(def.handler);
    if (h.incapacitates) incapIds.push(inst.id);
    h.tick?.(ctx, e, inst, def);
    if ((ctx.world.entities[e.id]?.stats?.hp ?? 0) <= 0) return true;
  }
  const cur = ctx.world.entities[e.id];
  // 自分の tick で外れた状態（帰り支度の取りやめ。S1c §14.3 の 1）は、この手番を止めない
  const incap = incapIds.some((id) => (cur?.statuses ?? []).some((s) => s.id === id));
  if (!cur?.statuses?.length) return incap;
  const after = cur.statuses.map((s) => ({ ...s, turnsLeft: s.turnsLeft - 1 }));
  const expired = after.filter((s) => s.turnsLeft <= 0);
  const remain = after.filter((s) => s.turnsLeft > 0);
  if (remain.length) ctx.emit({ type: 'status_ticked', target: e.id, statusesAfter: after.map((s) => ({ ...s, turnsLeft: Math.max(0, s.turnsLeft) })), seenBy: [] });
  let state = after;
  for (const ex of expired) {
    state = state.filter((s) => s.id !== ex.id);
    ctx.emit({ type: 'status_expired', target: e.id, targetKind: e.kind, statusId: ex.id, statusesAfter: state.map((s) => ({ ...s })), ...(e.scale?.affixes?.length ? { targetAffixes: [...e.scale.affixes] } : {}), ...statusSeen(ctx, e) });
    const def = ctx.content.statuses[ex.id];
    const h = def ? statusHandlers.get(def.handler) : undefined;
    if (h?.expire && ctx.world.entities[e.id]?.pos) h.expire(ctx, ctx.world.entities[e.id], ex);
  }
  return incap;
}

export function hasStatus(e: Entity, id: string): boolean {
  return (e.statuses ?? []).some((s) => s.id === id);
}

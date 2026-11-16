// 状態異常。振る舞いはハンドラ（dot / speed_pct / incapacitate）で、定義はデータ。
import type { StatusDef } from '@muse/content';
import type { Entity, StatusInst } from '@muse/shared';
import { applyDamage } from './combat';
import type { Ctx } from './ctx';
import { Registry } from './registry';

export interface StatusHandler {
  /** 手番開始時の処理（毒ダメージなど） */
  tick?(ctx: Ctx, e: Entity, inst: StatusInst, def: StatusDef): void;
  /** 行動不能にするか */
  incapacitates?: boolean;
}

export const statusHandlers = new Registry<StatusHandler>('statusHandler');

statusHandlers.register('dot', {
  tick(ctx, e, inst) {
    // 毒を与えた者がまだいれば、その者のダメージとして数える（倒せばその者の撃破・賞金・経験値）
    const src = inst.source ? ctx.world.entities[inst.source] ?? null : null;
    applyDamage(ctx, e, Math.max(1, inst.power), src && (src.stats?.hp ?? 0) > 0 ? src : null, 'poison');
  },
});
statusHandlers.register('speed_pct', {});
statusHandlers.register('incapacitate', { incapacitates: true });

function statusSeen(ctx: Ctx, e: Entity) {
  return e.pos ? ctx.perceive(e.pos.floor, [{ field: 'target', pos: e.pos, entity: e.id }], e.player ? [e.player] : []) : { seenBy: e.player ? [e.player] : [] };
}

export function addStatus(ctx: Ctx, e: Entity, id: string, turns: number, power: number, source: string | null = null): void {
  if (!ctx.content.statuses[id] || turns <= 0) return;
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
  ctx.emit({ type: 'status_expired', target: e.id, targetKind: e.kind, statusId: id, statusesAfter: after, ...statusSeen(ctx, e) });
  return true;
}

/** 手番開始時に状態異常を処理する。行動不能だったら true */
export function tickStatuses(ctx: Ctx, e: Entity): boolean {
  if (!e.statuses?.length) return false;
  let incap = false;
  for (const inst of [...e.statuses]) {
    const def = ctx.content.statuses[inst.id];
    if (!def) continue;
    const h = statusHandlers.get(def.handler);
    if (h.incapacitates) incap = true;
    h.tick?.(ctx, e, inst, def);
    if ((ctx.world.entities[e.id]?.stats?.hp ?? 0) <= 0) return true;
  }
  const cur = ctx.world.entities[e.id];
  if (!cur?.statuses?.length) return incap;
  const after = cur.statuses.map((s) => ({ ...s, turnsLeft: s.turnsLeft - 1 }));
  const expired = after.filter((s) => s.turnsLeft <= 0);
  const remain = after.filter((s) => s.turnsLeft > 0);
  if (remain.length) ctx.emit({ type: 'status_ticked', target: e.id, statusesAfter: after.map((s) => ({ ...s, turnsLeft: Math.max(0, s.turnsLeft) })), seenBy: [] });
  let state = after;
  for (const ex of expired) {
    state = state.filter((s) => s.id !== ex.id);
    ctx.emit({ type: 'status_expired', target: e.id, targetKind: e.kind, statusId: ex.id, statusesAfter: state.map((s) => ({ ...s })), ...statusSeen(ctx, e) });
  }
  return incap;
}

export function hasStatus(e: Entity, id: string): boolean {
  return (e.statuses ?? []).some((s) => s.id === id);
}

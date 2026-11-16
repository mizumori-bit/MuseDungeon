// 効果 DSL のハンドラ（レジストリ登録）。データ（アイテム・地物・罠・攻撃時効果）から ID で参照される。
import type { EffectDef } from '@muse/content';
import type { Entity, Pos } from '@muse/shared';
import { applyDamage, heal } from './combat';
import type { Ctx } from './ctx';
import { makeNoise, updateMemory } from './perception';
import { Registry, roll } from './registry';
import { addStatus, removeStatus } from './statuses';

export interface EffectCtx {
  /** 効果の使い手（薬を飲んだ者、攻撃者、罠なら null） */
  user: Entity | null;
  /** 効果の対象 */
  target: Entity;
  pos: Pos;
  source: Entity | null;
  via: string;
  /** 鑑定などの対象スロット（use_item の target_slot） */
  itemSlot?: string;
  /** 使った品の種類（鑑定の既定の対象から除く） */
  usedKind?: string;
}

export type EffectHandler = (ctx: Ctx, params: EffectDef, ec: EffectCtx) => void;

export const effects = new Registry<EffectHandler>('effect');

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
const dice = (ctx: Ctx, v: unknown, d = '1') => roll(ctx.rng('runtime'), typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);

effects.register('heal', (ctx, p, ec) => heal(ctx, ec.target, dice(ctx, p.amount, '1d8'), ec.via));

effects.register('cure', (ctx, p, ec) => { removeStatus(ctx, ec.target, String(p.status)); });

effects.register('status', (ctx, p, ec) => {
  const st = String(p.status);
  addStatus(ctx, ec.target, st, dice(ctx, p.turns, '5'), num(p.power, 1), ec.source?.id ?? null);
  if (st === 'core:poison' && ec.source && !ec.source.player && ec.target.player) {
    updateMemory(ctx, ec.target.player, ec.source.kind, (m) => { m.abilities.push('poison'); });
  }
});

effects.register('damage', (ctx, p, ec) => applyDamage(ctx, ec.target, Math.max(1, dice(ctx, p.amount, '1d4')), ec.source, ec.via === 'trap' ? 'trap' : 'effect'));

effects.register('max_hp', (ctx, p, ec) => {
  const t = ctx.world.entities[ec.target.id];
  if (!t?.stats || !t.base) return;
  const n = num(p.amount, 1);
  const seen = t.pos ? ctx.perceive(t.pos.floor, [{ field: 'target', pos: t.pos, entity: t.id }], t.player ? [t.player] : []) : { seenBy: [] };
  ctx.emit({ type: 'max_hp_changed', target: t.id, targetKind: t.kind, maxHpAfter: t.stats.maxHp + n, hpAfter: t.stats.hp + n, ...seen });
  ctx.emit({ type: 'stats_changed', target: t.id, statsAfter: { ...ctx.world.entities[t.id].stats! }, baseAfter: { ...t.base, maxHp: t.base.maxHp + n }, speedAfter: null, reason: 'max_hp', seenBy: t.player ? [t.player] : [] });
});

effects.register('teleport', (ctx, _p, ec) => {
  const t = ctx.world.entities[ec.target.id];
  if (!t?.pos) return;
  const key = t.pos.floor;
  const f = ctx.world.floors[key];
  const rng = ctx.rng('runtime');
  for (let tries = 0; tries < 200; tries++) {
    const x = rng.range(1, f.width - 2), y = rng.range(1, f.height - 2);
    const tr = ctx.terrainAt(key, x, y);
    if (!tr.passable || tr.stairs || ctx.actorAt(key, x, y) || ctx.featureAt(key, x, y)?.trap) continue;
    const from = { x: t.pos.x, y: t.pos.y };
    const seen = ctx.perceive(key, [{ field: 'from', pos: from }, { field: 'to', pos: { x, y } }], t.player ? [t.player] : []);
    ctx.emit({ type: 'entity_moved', id: t.id, kind: t.kind, from, to: { x, y }, mode: 'teleport', ...seen });
    return;
  }
});

effects.register('identify', (ctx, p, ec) => {
  const user = ec.user ?? ec.target;
  if (!user.player) return;
  const pr = ctx.world.players[user.player];
  // 対象: target_slot があればその品。無ければスロット順で最初の未鑑定品（使った巻物自身の種類は除く。公開ルール）
  const items = (user.inv?.items ?? []).map((id) => ctx.world.entities[id]).filter((it): it is Entity => !!it?.item)
    .sort((a, b) => (a.item!.slot ?? '').localeCompare(b.item!.slot ?? ''));
  const kinds: string[] = [];
  const pick = (it: Entity) => {
    if (ctx.world.secret.appearances[it.kind] && !pr.knowledge.identified.includes(it.kind) && !kinds.includes(it.kind)) kinds.push(it.kind);
  };
  if (ec.itemSlot) { const it = items.find((x) => x.item!.slot === ec.itemSlot); if (it) pick(it); }
  for (const it of items) if (it.kind !== ec.usedKind) pick(it);
  for (const k of kinds.slice(0, num(p.count, 1))) {
    ctx.emit({ type: 'item_identified', player: pr.id, kind: k, appearanceId: ctx.world.secret.appearances[k] ?? null, seenBy: [pr.id] });
  }
});

effects.register('map', (ctx, _p, ec) => {
  const t = ec.target;
  if (!t.player || !t.pos) return;
  const key = t.pos.floor;
  const f = ctx.world.floors[key];
  const pr = ctx.world.players[t.player];
  const fk = pr.knowledge.floors[key];
  const newly: number[] = [];
  const wallIdx = ctx.world.meta.terrainTable.indexOf('core:wall');
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const i = y * f.width + x;
      const tv = f.terrain[i];
      if ((fk?.seen[i] ?? 0) === tv) continue;
      if (tv === wallIdx) {
        // 床に接する壁だけ
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
          if (f.terrain[ny * f.width + nx] !== wallIdx) { touches = true; break; }
        }
        if (!touches) continue;
      }
      newly.push(i, tv);
    }
  }
  // 地形は分かったが目で見ていないセル（今の視界の外で、まだ記憶に無かったもの）
  const vis = new Set(pr.knowledge.visible);
  const already = new Set(fk?.mapped ?? []);
  const mappedAdd: number[] = [];
  for (let j = 0; j + 1 < newly.length; j += 2) {
    const i = newly[j];
    if (!vis.has(i) && !already.has(i) && (fk?.seen[i] ?? 0) === 0) mappedAdd.push(i);
  }
  ctx.emit({
    type: 'knowledge_updated', player: pr.id, floorKey: key, visible: null, newlySeen: newly, rememberedSet: [], rememberedDel: [], metAdd: [],
    ...(mappedAdd.length ? { mappedAdd } : {}), seenBy: [pr.id], floor: key,
  });
});

effects.register('noise', (ctx, p, ec) => {
  if (!ec.target.pos) return;
  makeNoise(ctx, ec.target.pos.floor, ec.pos, num(p.loudness, 10), null);
});

export function applyEffects(ctx: Ctx, list: readonly EffectDef[], ec: EffectCtx): void {
  const rng = ctx.rng('runtime');
  for (const e of list) {
    if (e.chancePct !== undefined && !rng.chance(e.chancePct)) continue;
    const target = ctx.world.entities[ec.target.id];
    if (!target || (target.stats && target.stats.hp <= 0)) return;
    effects.get(e.effect)(ctx, e, { ...ec, target });
  }
}

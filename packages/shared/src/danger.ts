// 危険の見積もり（V3-2R3 §20.4）: 速さの比と思い出の記録から、1 手番あたりの最悪の被害を出す。観測とマクロで共用。
// 入力は PlayerView と公開カタログだけ（伏せた能力値は使わない）。
import type { Catalog } from './catalog';
import { memoryKey } from './catalog';
import type { MonsterMemory } from './types';
import { ceilDiv, floorDiv } from './util';
import type { EntityView, PlayerView } from './view';

/** 自分の実効の速さ（状態異常の倍率込み） */
export function selfSpeed(view: PlayerView, catalog: Catalog): number {
  let sp = view.self.speed;
  for (const st of view.self.statuses) {
    const pct = catalog.statuses[st.id]?.speedPct;
    if (pct !== undefined) sp = floorDiv(sp * pct, 100);
  }
  return Math.max(10, sp);
}

/** 敵の実効の速さ（状態異常の倍率込み）。分からなければ null */
export function monsterSpeedOf(catalog: Catalog, e: Pick<EntityView, 'speed' | 'statuses'>): number | null {
  if (e.speed === undefined) return null;
  let sp = e.speed;
  for (const st of e.statuses ?? []) {
    const pct = catalog.statuses[st]?.speedPct;
    if (pct !== undefined) sp = floorDiv(sp * pct, 100);
  }
  return Math.max(10, sp);
}

/** その個体の思い出（守護者は守護者の記録） */
export function memoryOf(view: PlayerView, e: Pick<EntityView, 'kind' | 'role'>): MonsterMemory | undefined {
  return e.kind ? view.monsterMemory[memoryKey(e.kind, e.role)] : undefined;
}

/**
 * 自分の 1 手番のあいだにその相手が行動する回数（速さの比の切り上げ。自分より速ければ 2 回）。
 * 2 回動いたのを見た敵は、次に 2 回動けるまでの手番を 1 回と数える（V3-8 §53.4）: 1 回の行動の時間 c = 10000 ÷ 敵の速さ、
 * 自分の P = 10000 ÷ 自分の速さ（どちらも切り捨て）。2 回動いた手番の後の 切り捨て((2c − P) ÷ (P − c)) 手番は 1 回（速さ 120 と 100 なら 3）
 */
export function attacksPerTurn(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'speed' | 'statuses' | 'paceAgo'>): number {
  const sp = monsterSpeedOf(catalog, e);
  if (sp === null) return 1;
  const self = selfSpeed(view, catalog);
  const n = Math.max(1, ceilDiv(sp, self));
  if (n === 2 && e.paceAgo !== undefined) {
    const c = floorDiv(10000, sp), P = floorDiv(10000, self);
    if (P > c && 2 * c > P && e.paceAgo < floorDiv(2 * c - P, P - c)) return 1;
  }
  return n;
}

/** 歩く手番のコスト（重い鎧。装備中の品の最大。100 が普通） */
export function selfMoveCost(view: PlayerView, catalog: Catalog): number {
  let cost = 100;
  for (const it of view.inventory) {
    if (!it.equipped || !it.kind) continue;
    const mc = catalog.items[it.kind]?.equipStats?.moveCost;
    if (mc !== undefined && mc > cost) cost = mc;
  }
  return cost;
}

/**
 * 階段まで歩く間にその相手が攻撃できる回数（V3-4b §28.5）。射撃する敵は歩数（射程と視線は続くと見る）。
 * 近接の敵は 切り上げ(歩数 × max(0, 敵の速さ ÷ 自分の歩く速さ − 1)) で、今隣にいれば +1。自分の歩く速さは重い鎧の手番コストを入れる
 */
export function chaseAttacks(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'speed' | 'statuses'>, steps: number, o: { ranged: boolean; adjacent: boolean }): number {
  if (o.ranged) return steps;
  const sp = monsterSpeedOf(catalog, e) ?? 100;
  // 敵の速さ ÷ 自分の歩く速さ − 1 = (sp × moveCost − self × 100) ÷ (self × 100)（整数で切り上げ）
  const self = selfSpeed(view, catalog);
  const num = sp * selfMoveCost(view, catalog) - self * 100;
  return (num > 0 ? ceilDiv(steps * num, self * 100) : 0) + (o.adjacent ? 1 : 0);
}

/** 1 手番あたりの最悪の被害 = 受けた最大の一撃 × 行動の回数（記録が無ければ null） */
export function worstTurnOf(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses' | 'paceAgo'>): number | null {
  const mem = memoryOf(view, e);
  if (!mem || mem.maxDamageToYou <= 0) return null;
  return mem.maxDamageToYou * attacksPerTurn(view, catalog, e);
}

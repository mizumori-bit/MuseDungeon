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

/** 自分の 1 手番のあいだにその相手が行動する回数（速さの比の切り上げ。自分より速ければ 2 回） */
export function attacksPerTurn(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'speed' | 'statuses'>): number {
  const sp = monsterSpeedOf(catalog, e);
  if (sp === null) return 1;
  return Math.max(1, ceilDiv(sp, selfSpeed(view, catalog)));
}

/** 1 手番あたりの最悪の被害 = 受けた最大の一撃 × 行動の回数（記録が無ければ null） */
export function worstTurnOf(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses'>): number | null {
  const mem = memoryOf(view, e);
  if (!mem || mem.maxDamageToYou <= 0) return null;
  return mem.maxDamageToYou * attacksPerTurn(view, catalog, e);
}

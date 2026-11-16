// 公開カタログ: 各コンテンツ ID の分類・カテゴリ・表示名と、プレイヤーが知ってよい性質のみ。
// 能力値・出現条件は含まない。content が生成し、client は /api/content/catalog で取得する。
import type { Names } from './types';

export interface CatalogTerrain {
  name: Names;
  passable: boolean;
  opaque: boolean;
  layer: 'ground' | 'object';
  door?: 'open' | 'closed';
  stairs?: 'up' | 'down';
  tags: string[];
}

export interface CatalogItem {
  name: Names;
  category: string;
  unidentified: boolean;
  stack: boolean;
  slot?: 'weapon' | 'armor' | 'accessory';
  usable: boolean;
  throwable: boolean;
  /** use 時に対象指定が必要か */
  targeted: boolean;
  /** 鑑定済み・装備品の説明（プレイヤーが知り得る範囲） */
  desc: Names;
}

export interface Catalog {
  contentVersion: string;
  terrain: Record<string, CatalogTerrain>;
  monsters: Record<string, { name: Names; tags: string[] }>;
  classes: Record<string, { name: Names; desc: Names }>;
  items: Record<string, CatalogItem>;
  appearances: Record<string, { name: Names; category: string }>;
  features: Record<string, { name: Names; category: 'feature' | 'trap'; states: string[]; interactable: boolean; passable: boolean }>;
  /** speedPct: 速度を変える状態異常の倍率（%）。公開ルール（加速 x2 など） */
  statuses: Record<string, { name: Names; speedPct?: number }>;
  affixes: Record<string, { name: Names; target: 'monster' | 'item' | 'guardian' }>;
  biomes: Record<string, { name: Names }>;
  floorTypes: Record<string, { name: Names }>;
  /** 公開ルールの数値（content の balance.json から。ルールブックと実際の挙動を一致させる） */
  rules: CatalogRules;
}

export interface CatalogRules {
  regen: { baseInterval: number; levelDiv: number; minInterval: number; restMultiplier: number };
  restMaxTurns: number;
  macroStepLimit: number;
  wander: { intervalMin: number; intervalMax: number };
  score: { perDepth: number; perKill: number; perLevel: number };
  expedition: { firstTargetDepth: number; aheadMin: number; aheadMax: number; points: Record<string, number>; pointsPerExtraDepth: number };
  /** 敵の HP 4 段階の境界（%）: healthy >= [0], wounded >= [1], badly_wounded >= [2], それ未満 near_death */
  hpBands: [number, number, number];
}

/** 自然回復の間隔（手番）。engine と観測の見積もりで同じ式を使う */
export function regenInterval(rules: Pick<CatalogRules, 'regen'>, level: number): number {
  const r = rules.regen;
  return Math.max(r.minInterval, r.baseInterval - Math.trunc(level / r.levelDiv));
}

/**
 * 回復の蓄積を 1 手番進める（engine の実処理と観測の見積もりで共用）。
 * 満タンなら蓄積は 0。gain を足し、間隔に達するごとに 1 HP。
 */
export function regenStep(acc: number, hp: number, maxHp: number, gain: number, interval: number): { acc: number; heal: number } {
  if (hp >= maxHp) return { acc: 0, heal: 0 };
  let a = acc + gain;
  let heal = 0;
  while (a >= interval && hp + heal < maxHp) { a -= interval; heal++; }
  if (hp + heal >= maxHp) a = 0;
  return { acc: a, heal };
}

export function nameOf(n: Names | undefined, locale: 'ja' | 'en', fallback = '?'): string {
  if (!n) return fallback;
  return locale === 'en' ? n.en : n.ja;
}

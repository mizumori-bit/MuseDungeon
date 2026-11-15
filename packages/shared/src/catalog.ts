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
  statuses: Record<string, { name: Names }>;
  affixes: Record<string, { name: Names; target: 'monster' | 'item' }>;
  biomes: Record<string, { name: Names }>;
  floorTypes: Record<string, { name: Names }>;
}

export function nameOf(n: Names | undefined, locale: 'ja' | 'en', fallback = '?'): string {
  if (!n) return fallback;
  return locale === 'en' ? n.en : n.ja;
}

// 公開カタログ: 各コンテンツ ID の分類・カテゴリ・表示名と、プレイヤーが知ってよい性質のみ。
// 能力値・出現条件は含まない。content が生成し、client は /api/content/catalog で取得する。
import type { HaulParts, Names } from './types';

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
  /** 自分に使うと害がある */
  harmful: boolean;
  /** 投擲の射程（投げられない物は null） */
  throwRange: number | null;
  /** 宝（持ち帰ると点になる。価値は個体ごと） */
  treasure: boolean;
  /** 自分の持ち物の性能（鑑定済みなら定義の値をそのまま見せる。V3-2R §14.3） */
  weapon?: { dmg: string; acc: number };
  armorStats?: { armor: number; eva: number };
  throwStats?: { dmg: string; acc: number; range: number };
}

export interface CatalogClass {
  name: Names;
  desc: Names;
  base: { maxHp: number; acc: number; eva: number; might: number; armor: number; sight: number; speed: number; capacity: number };
  startItems: { item: string; qty: number; equip: boolean }[];
  growth: { maxHpPerLevel: number; accEvery: number; mightEvery: number; evaEvery: number };
}

export interface Catalog {
  contentVersion: string;
  terrain: Record<string, CatalogTerrain>;
  /** glyph: 地図の 1 文字（種族ごとに一意） */
  monsters: Record<string, { name: Names; tags: string[]; glyph: string }>;
  classes: Record<string, CatalogClass>;
  items: Record<string, CatalogItem>;
  appearances: Record<string, { name: Names; category: string }>;
  features: Record<string, { name: Names; category: 'feature' | 'trap'; states: string[]; interactable: boolean; passable: boolean }>;
  /** speedPct: 速度を変える状態異常の倍率（%）。公開ルール（加速 x2 など） */
  statuses: Record<string, { name: Names; speedPct?: number }>;
  /** itemMods: 品物の接辞の効果（自分の持ち物の性能表示に使う。敵の接辞の値は出さない） */
  affixes: Record<string, { name: Names; target: 'monster' | 'item' | 'guardian'; itemMods?: { acc: number; dmgBonus: number; armor: number } }>;
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
  expedition: { firstTargetDepth: Record<'safe' | 'standard' | 'ambitious', number>; aheadMin: number; aheadMax: number; points: Record<string, number>; pointsPerExtraDepth: number };
  /** 敵の HP 4 段階の境界（%）: healthy >= [0], wounded >= [1], badly_wounded >= [2], それ未満 near_death */
  hpBands: [number, number, number];
  /** 推定残り HP: 記録がこの数未満の間は上限を出さない */
  estimateMinSamples: number;
  /** 戦利品（v3） */
  haul: {
    overreachFirst: number; overreachStep: number; perKill: number; withdrawPct: number;
    discovery: { species: number; identify: number; room: number; inscription: number };
    guardianBounty: { base: number; perDepth: number };
  };
  /** キャンプの 3 枠（目標深度の幅・条件の数・基礎点の割合） */
  slots: Record<'safe' | 'standard' | 'ambitious', { aheadMin: number; aheadMax: number; traitsMin: number; traitsMax: number; pointsPct: number }>;
  /** 目的達成後の徘徊の湧き間隔（%）と推奨レベルの式 */
  afterObjectiveWanderPct: number;
  /** 推奨レベルの表（深度 1 から。bot の実測） */
  recommendedLevel: { byDepth: number[] };
  /** 敵を倒す以外の経験値 */
  xp: { perNewDepth: number; perObjective: number };
  /** 遠征の条件（公開） */
  traits: Record<string, { name: Names; desc: Names; multiplierPct: number; danger: number }>;
}

/**
 * 深追い（踏破）の点: 目標より深い階を横切り、その階の下り階段に立つたびに入る（V3-2R §14.1）。
 * crossedDepth = 下り階段に立った最も深い階。k 階目ごとに first + step × (k - 1)
 */
export function overreachPoints(rules: Pick<CatalogRules, 'haul'>, targetDepth: number | null, crossedDepth: number): number {
  if (targetDepth === null) return 0;
  const k = Math.max(0, crossedDepth - targetDepth);
  let total = 0;
  for (let i = 0; i < k; i++) total += rules.haul.overreachFirst + rules.haul.overreachStep * i;
  return total;
}

/** 次に踏破の点が入る階（その階の下り階段に立てば入る）とその点 */
export function nextOverreach(rules: Pick<CatalogRules, 'haul'>, targetDepth: number | null, crossedDepth: number): { depth: number; points: number } | null {
  if (targetDepth === null) return null;
  const k = Math.max(0, crossedDepth - targetDepth);
  return { depth: Math.max(targetDepth, crossedDepth) + 1, points: rules.haul.overreachFirst + rules.haul.overreachStep * k };
}

export function haulTotal(p: HaulParts): number {
  return p.objective + p.overreach + p.treasure + p.bounty + p.discovery + p.kills;
}

/** 払い戻し: 帰還は全部 × 倍率、撤退は目的を除いて × withdrawPct（倍率は掛けない） */
export function payoutOf(rules: Pick<CatalogRules, 'haul'>, p: HaulParts, completed: boolean, multiplierPct: number): number {
  if (completed) return Math.trunc((haulTotal(p) * multiplierPct) / 100);
  return Math.trunc(((haulTotal(p) - p.objective) * rules.haul.withdrawPct) / 100);
}

/** 推奨レベル（公開の表。表より深い階は直近 4 階の傾きで外挿する。整数のみ） */
export function recommendedLevel(rules: Pick<CatalogRules, 'recommendedLevel'>, depth: number): number {
  const t = rules.recommendedLevel.byDepth;
  const d = Math.max(1, depth);
  if (d <= t.length) return t[d - 1];
  const n = t.length;
  const span = Math.min(4, n - 1);
  const rise = t[n - 1] - t[n - 1 - span];
  return t[n - 1] + Math.trunc(((d - n) * rise) / span);
}

/** 候補の難しさ（V3-2R §14.4）: 推奨レベルとの差と、条件の危険度の合計。段階に丸めない */
export function offerGap(rules: Pick<CatalogRules, 'recommendedLevel' | 'traits'>, targetDepth: number | null, traits: readonly string[], level: number): { recommendedLevel: number | null; levelGap: number | null; traitDanger: number } {
  const traitDanger = traits.reduce((a, id) => a + (rules.traits[id]?.danger ?? 0), 0);
  if (targetDepth === null) return { recommendedLevel: null, levelGap: null, traitDanger };
  const rec = recommendedLevel(rules, targetDepth);
  return { recommendedLevel: rec, levelGap: rec - level, traitDanger };
}

/** 今帰った場合の次の候補の下限（生成済みの最深階 + 堅実の幅）と推奨レベル */
export function nextCampOf(rules: Pick<CatalogRules, 'recommendedLevel' | 'slots'>, deepestGenerated: number): { minTargetDepth: number; recommendedLevel: number } {
  const min = deepestGenerated + rules.slots.safe.aheadMin;
  return { minTargetDepth: min, recommendedLevel: recommendedLevel(rules, min) };
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

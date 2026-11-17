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
  /** データに書いた説明だけ（素の性能の列を含まない。所持品の詳細で、接辞込みの性能と並べるとき） */
  note?: Names;
  /** 鑑定済み・装備品の説明（プレイヤーが知り得る範囲） */
  desc: Names;
  /** 自分に使うと害がある */
  harmful: boolean;
  /** 投擲の射程（投げられない物は null） */
  throwRange: number | null;
  /** 宝（持ち帰ると点になる。価値は個体ごと） */
  treasure: boolean;
  /** 手放せない品（帰還の綱）。捨てる・投げることができず、所持数に数えない */
  bound?: boolean;
  /** 自分の持ち物の性能（鑑定済みなら定義の値をそのまま見せる。V3-2R §14.3） */
  weapon?: { dmg: string; acc: number };
  armorStats?: { armor: number; eva: number };
  throwStats?: { dmg: string; acc: number; range: number };
  /** 装備の性能（V3-4。鑑定済みなら定義の値をそのまま見せる）。0 / 既定値の項目は省く */
  equipStats?: CatalogEquipStats;
}

/** 装備の修正（V3-4 §4.4・§14.5）。traits は武器の特性の ID */
export interface CatalogEquipStats {
  acc?: number; eva?: number; might?: number; armor?: number; maxHp?: number; sight?: number;
  meleeAcc?: number; thrownAcc?: number; stealthPct?: number; wakePct?: number; moveCost?: number; noiseWakes?: boolean;
  traits?: string[];
}

/** 特技（V3-4 §4.1） */
export interface CatalogPerk {
  name: Names; desc: Names; lineage: string; maxRanks: number; requires: string[];
  mods: { maxHp: number; acc: number; eva: number; might: number; armor: number; capacity: number; stealthPct: number };
  ability?: string;
  hooks: string[];
}

/** 能動技（V3-4 §4.2） */
export interface CatalogAbility { name: Names; desc: Names; target: 'adjacent' | 'throw' | 'dir' | 'none'; cooldown: number; perExpedition?: number; /** 振る舞いの種類（strike / cleave / heal_pct / aimed_throw / slip） */ handler: string }

export interface CatalogClass {
  name: Names;
  desc: Names;
  base: { maxHp: number; acc: number; eva: number; might: number; armor: number; sight: number; speed: number; capacity: number };
  startItems: { item: string; qty: number; equip: boolean }[];
  /** レベルごとの固定成長は最大 HP だけ（命中・威力・回避は特技。V3-4） */
  growth: { maxHpPerLevel: number };
  /** 習熟: 近接・投擲の命中の修正 */
  proficiency: { melee: number; thrown: number };
  /** 特技の系統（共通の表に加えて候補に出る） */
  lineages: { id: string; name: Names }[];
  /** Lv1 から持つ特技 */
  startPerks: string[];
}

export interface Catalog {
  contentVersion: string;
  terrain: Record<string, CatalogTerrain>;
  /** glyph: 地図の 1 文字（種族ごとに一意） */
  /** size・armored: 見れば分かる性質（V3-2R3 §20.4） */
  monsters: Record<string, { name: Names; tags: string[]; glyph: string; size?: 'small' | 'medium' | 'large'; armored?: boolean }>;
  classes: Record<string, CatalogClass>;
  items: Record<string, CatalogItem>;
  appearances: Record<string, { name: Names; category: string }>;
  features: Record<string, { name: Names; category: 'feature' | 'trap'; states: string[]; interactable: boolean; passable: boolean }>;
  /** speedPct: 速度を変える状態異常の倍率（%）。公開ルール（加速 x2 など） */
  statuses: Record<string, { name: Names; speedPct?: number }>;
  /** itemMods: 品物の接辞の効果（自分の持ち物の性能表示に使う。敵の接辞の値は出さない） */
  affixes: Record<string, { name: Names; target: 'monster' | 'item' | 'guardian'; itemMods?: { acc: number; dmgBonus: number; armor: number; eva?: number; might?: number; maxHp?: number; sight?: number }; cursed?: boolean }>;
  /** ビルド（V3-4） */
  perks: Record<string, CatalogPerk>;
  abilities: Record<string, CatalogAbility>;
  /** reach: 近接の届く距離（長柄）、attackCost: 近接の手番コスト（速い） */
  weaponTraits: Record<string, { name: Names; desc: Names; reach?: number; attackCost?: number }>;
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
  /** 候補の点 = 枠の基礎点 × typePct % × (depthPct.base + depthPct.perDepth × 目標深度) %（V3-2R2 §18.3） */
  expedition: { firstTargetDepth: Record<'safe' | 'standard' | 'ambitious', number>; typePct: Record<string, number>; depthPct: { base: number; perDepth: number } };
  /** 敵の HP 4 段階の境界（%）: healthy >= [0], wounded >= [1], badly_wounded >= [2], それ未満 near_death */
  hpBands: [number, number, number];
  /** 推定残り HP: 記録がこの数未満の間は上限を出さない */
  estimateMinSamples: number;
  /** 戦利品（v3） */
  haul: {
    overreachFirst: number; overreachStep: number; overreachPct: { first: number; step: number }; killPerXp: number; killAffixPct: number; withdrawPct: number;
    discovery: { species: number; identify: number; room: number; inscription: number };
    guardianBounty: { base: number; perDepth: number };
  };
  /** キャンプの 3 枠（目標深度の幅・条件の数・枠の基礎点） */
  slots: Record<'safe' | 'standard' | 'ambitious', { aheadMin: number; aheadMax: number; traitsMin: number; traitsMax: number; base: number }>;
  /** 目的達成後の徘徊の湧き間隔（%）と推奨レベルの式 */
  afterObjectiveWanderPct: number;
  /** 推奨レベルの表（深度 1 から。bot の実測） */
  recommendedLevel: { byDepth: number[] };
  /** 敵を倒す以外の経験値と、撃破の経験値の深さの係数（深度 1 階ごとの %） */
  xp: { perNewDepth: number; perObjective: number; killDepthPct?: number };
  /** 帰還の綱: 使ってから戻るまでの手番と、確定する戦利品の割合（V3-2R2 §18.1） */
  lifeline: { turns: number; pct: number };
  /** 転移の巻物の着地点の最短距離 */
  teleport: { minDistance: number };
  /** 守護者の格ごとの体力の上乗せ（%。V3-2R3 §20.1） */
  guardianRanks?: { hpPct: number }[];
  /** 特技の候補の数・生成された装備が呪われる確率（V3-4） */
  perkOptions?: number;
  curseChancePct?: number;
  /** 遠征の条件（公開） */
  traits: Record<string, { name: Names; desc: Names; multiplierPct: number; danger: number }>;
}

/**
 * n 階目（1 から）の踏破の点（V3-2R2 §18.4）: 目的の点 × (pct.first + pct.step × (n − 1))%。
 * 下限は overreachFirst + overreachStep × (n − 1)。目的の点は条件の倍率をかける前の値
 */
export function overreachStepPoints(rules: Pick<CatalogRules, 'haul'>, objectivePoints: number, n: number): number {
  const h = rules.haul;
  const floor = h.overreachFirst + h.overreachStep * (n - 1);
  const pct = (h.overreachPct?.first ?? 0) + (h.overreachPct?.step ?? 0) * (n - 1);
  return Math.max(floor, Math.trunc((objectivePoints * pct) / 100));
}

/**
 * 深追い（踏破）の点: 目標より深い階を横切り、その階の下り階段に立つたびに入る（V3-2R §14.1）。
 * crossedDepth = 下り階段に立った最も深い階。k 階目ごとに overreachStepPoints(k)
 */
export function overreachPoints(rules: Pick<CatalogRules, 'haul'>, targetDepth: number | null, crossedDepth: number, objectivePoints: number): number {
  if (targetDepth === null) return 0;
  const k = Math.max(0, crossedDepth - targetDepth);
  let total = 0;
  for (let i = 1; i <= k; i++) total += overreachStepPoints(rules, objectivePoints, i);
  return total;
}

/** 次に踏破の点が入る階（その階の下り階段に立てば入る）とその点 */
export function nextOverreach(rules: Pick<CatalogRules, 'haul'>, targetDepth: number | null, crossedDepth: number, objectivePoints: number): { depth: number; points: number } | null {
  if (targetDepth === null) return null;
  const k = Math.max(0, crossedDepth - targetDepth);
  return { depth: Math.max(targetDepth, crossedDepth) + 1, points: overreachStepPoints(rules, objectivePoints, k + 1) };
}

export function haulTotal(p: HaulParts): number {
  return p.objective + p.overreach + p.treasure + p.bounty + p.discovery + p.kills;
}

/**
 * 払い戻し: 帰還は全部 × 倍率、撤退は目的を除いて × withdrawPct（倍率は掛けない）。
 * 帰還の綱（V3-2R2 §18.1）は戦利品全体 × lifeline.pct（倍率は掛けない。目的は達成済みのときだけ含む）
 */
export function payoutOf(rules: Pick<CatalogRules, 'haul'> & Partial<Pick<CatalogRules, 'lifeline'>>, p: HaulParts, completed: boolean, multiplierPct: number, lifeline = false): number {
  if (lifeline) return Math.trunc(((haulTotal(p) - (completed ? 0 : p.objective)) * (rules.lifeline?.pct ?? 50)) / 100);
  if (completed) return Math.trunc((haulTotal(p) * multiplierPct) / 100);
  return Math.trunc(((haulTotal(p) - p.objective) * rules.haul.withdrawPct) / 100);
}

/** 候補の点（V3-2R2 §18.3）: 枠の基礎点 × 種類の係数 × 深さの係数。どの組み合わせでも 堅実 < 標準 < 野心 */
export function offerPoints(rules: Pick<CatalogRules, 'expedition' | 'slots'>, slot: 'safe' | 'standard' | 'ambitious', type: string, guarded: boolean, targetDepth: number): number {
  const x = rules.expedition;
  const key = type === 'retrieve_relic' && guarded ? 'retrieve_relic_guarded' : type;
  const typePct = x.typePct[key] ?? 100;
  const depthPct = x.depthPct.base + x.depthPct.perDepth * targetDepth;
  return Math.trunc((Math.trunc((rules.slots[slot].base * typePct) / 100) * depthPct) / 100);
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

/**
 * 次の候補の下限（V3-2R3 §20.2）: 目標として達成した最深の階（campDepth）+ 堅実の幅。最初の候補の深さより浅くはならない。
 * 踏破で先まで降りても深くならない
 */
export function nextCampOf(rules: Pick<CatalogRules, 'recommendedLevel' | 'slots' | 'expedition'>, campDepth: number): { minTargetDepth: number; recommendedLevel: number } {
  const min = Math.max(rules.expedition.firstTargetDepth?.safe ?? 1, campDepth + rules.slots.safe.aheadMin);
  return { minTargetDepth: min, recommendedLevel: recommendedLevel(rules, min) };
}

/** 深さの係数（%）: depthPct.base + depthPct.perDepth × 深度（候補の点と撃破の点で共用） */
export function depthFactorPct(rules: Pick<CatalogRules, 'expedition'>, depth: number): number {
  return rules.expedition.depthPct.base + rules.expedition.depthPct.perDepth * depth;
}

/** 撃破の点（V3-2R3 §20.5）: 種族の経験値 × killPerXp × 深さの係数、接辞付きは × killAffixPct % */
export function killPoints(rules: Pick<CatalogRules, 'expedition' | 'haul'>, speciesXp: number, depth: number, affixed: boolean): number {
  const base = Math.trunc((speciesXp * rules.haul.killPerXp * depthFactorPct(rules, depth)) / 100);
  return affixed ? Math.trunc((base * rules.haul.killAffixPct) / 100) : base;
}

/** 思い出のキー: 守護者は種族と分けて記録する（V3-2R3 §20.4） */
export function memoryKey(kind: string, role?: string | null): string {
  return role === 'guardian' ? `guardian|${kind}` : kind;
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

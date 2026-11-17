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
  /** 未鑑定の手がかり（V3-5 §5.4） */
  clue?: Names;
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
  /** 遺物が持ち帰られるとなる加護（V3-3 §3.3） */
  boon?: string;
}

/** 加護（V3-3 §3.3）。hooks は観測の見積もり（自然回復の間隔）でも使う */
export interface CatalogBoon {
  name: Names;
  desc: Names;
  hooks: ({ hook: string } & Record<string, number | string>)[];
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
  /** 投擲で無視する装甲（1 ランクあたり。急所狙い。V3-3b §40.1） */
  thrownPierce?: number;
  /** 投擲のダメージの上乗せ（強肩。V3-3c §44.4） */
  thrownDmg?: number;
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
  monsters: Record<string, { name: Names; tags: string[]; glyph: string; size?: 'small' | 'medium' | 'large'; armored?: boolean; evasive?: boolean; desc?: Names }>;
  classes: Record<string, CatalogClass>;
  items: Record<string, CatalogItem>;
  appearances: Record<string, { name: Names; category: string }>;
  features: Record<string, { name: Names; category: 'feature' | 'trap'; states: string[]; interactable: boolean; passable: boolean; afterInteract?: string; desc?: Names; gamble?: { name: Names; pct: number }[] }>;
  /** speedPct: 速度を変える状態異常の倍率（%）。公開ルール（加速 x2 など） */
  /** armor: 装甲の修正（錆。V3-5a） */
  statuses: Record<string, { name: Names; speedPct?: number; armor?: number }>;
  /** itemMods: 品物の接辞の効果（自分の持ち物の性能表示に使う。敵の接辞の値は出さない） */
  affixes: Record<string, { name: Names; target: 'monster' | 'item' | 'guardian'; itemMods?: { acc: number; dmgBonus: number; armor: number; eva?: number; might?: number; maxHp?: number; sight?: number }; cursed?: boolean }>;
  /** ビルド（V3-4） */
  perks: Record<string, CatalogPerk>;
  abilities: Record<string, CatalogAbility>;
  /** reach: 近接の届く距離（長柄）、attackCost: 近接の手番コスト（速い） */
  weaponTraits: Record<string, { name: Names; desc: Names; reach?: number; attackCost?: number }>;
  /** 守護者の型（V3-3 §3.1）。name は称号 */
  guardianTypes: Record<string, { name: Names; desc: Names; strongVs: 'melee' | 'thrown'; handler: string }>;
  /** 守護者の弱点（V3-3 §3.1）。どの守護者が持つかは試すまで伏せる */
  guardianWeaknesses: Record<string, { name: Names; desc: Names; handler: string; short?: Names }>;
  /** 加護（V3-3 §3.3） */
  boons: Record<string, CatalogBoon>;
  /** 物語の枠（V3-3 §3.4。get_rules に出す） */
  lore?: { frame: Names[] };
  biomes: Record<string, { name: Names; desc?: Names }>;
  floorTypes: Record<string, { name: Names }>;
  /** 公開ルールの数値（content の balance.json から。ルールブックと実際の挙動を一致させる） */
  rules: CatalogRules;
}

export interface CatalogRules {
  regen: { baseInterval: number; levelDiv: number; minInterval: number; restMultiplier: number };
  restMaxTurns: number;
  /** 休憩と自然回復で戻る上限（最大 HP の %。V3-4b §28.3） */
  restCapPct?: number;
  /** 階の異変の確率・名前付きの強敵・未鑑定の手がかりの手番（V3-5 §5.3・§5.4） */
  floorEventPct?: number;
  elite?: { chancePct: number; minDepth: number; affixes: number };
  clueTurns?: number;
  /** 守護者が、相手が階を離れている間に手番 1 つにつき回復する最大体力の %（V3-3a §35.1） */
  guardianAwayHealPct?: number;
  /** 節目の大守護者の階（V3-3 §3.2）: 深度 every の倍数（min 以上）。levelBonus: 節目に挑む候補の推奨レベルの上乗せ */
  /** hp: 大守護者の体力の式（V3-3c §44.2: 種族の体力 × (100 + hpPct)% を下限 minHpBase + minHpPerDepth × 深さ、上限 maxHpBase + maxHpPerDepth × 深さに収める）。minSpeed: 速さの下限 */
  milestone?: { every: number; min: number; boonOptions: number; levelBonus?: number; hpRule?: { hpPct: number; minHpBase: number; minHpPerDepth: number; maxHpBase: number; maxHpPerDepth: number }; minSpeed?: number };
  macroStepLimit: number;
  /** fight の標的（追跡中・逃げていない）が見えなくなったときに待つ手番（V3-4b §28.4） */
  fightLostWait?: number;
  /** fight: 初被弾で止まる被弾の大きさ（最大 HP の %）と、記録ありとして扱う撃破数（V3-3a §35.6） */
  fightFirstHitStopPct?: number;
  fightRecordedKills?: number;
  wander: { intervalMin: number; intervalMax: number };
  score: { perDepth: number; perKill: number; perLevel: number };
  /** 候補の点 = 枠の基礎点 × typePct % × (depthPct.base + depthPct.perDepth × 目標深度) %（V3-2R2 §18.3） */
  expedition: { firstTargetDepth: Record<'safe' | 'standard' | 'ambitious', number>; typePct: Record<string, number>; depthPct: { base: number; perDepth: number }; repeatPct?: number; repeatMinPct?: number };
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
  guardianRanks?: { hpPct: number; minHpBase?: number; minHpPerDepth?: number }[];
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
 * 帰還の綱は、目的を除いた戦利品 × lifeline.pct（倍率は掛けない。目的を達成済みでも目的の点は運ばない。V3-4b §28.1）
 */
export function payoutOf(rules: Pick<CatalogRules, 'haul'> & Partial<Pick<CatalogRules, 'lifeline'>>, p: HaulParts, completed: boolean, multiplierPct: number, lifeline = false): number {
  if (lifeline) return Math.trunc(((haulTotal(p) - p.objective) * (rules.lifeline?.pct ?? 50)) / 100);
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
export function offerGap(rules: Pick<CatalogRules, 'recommendedLevel' | 'traits'> & Partial<Pick<CatalogRules, 'milestone'>>, targetDepth: number | null, traits: readonly string[], level: number,
  extra?: { warden?: boolean; passesWarden?: number }): { recommendedLevel: number | null; levelGap: number | null; traitDanger: number } {
  let traitDanger = traits.reduce((a, id) => a + (rules.traits[id]?.danger ?? 0), 0);
  if (targetDepth === null) return { recommendedLevel: null, levelGap: null, traitDanger };
  let rec = recommendedLevel(rules, targetDepth);
  // 大守護者を推奨レベルと危険度に入れる（V3-3a §35.2）: 節目に挑む = その深さ + levelBonus、節目を越える = 目標と大守護者の大きいほう・危険度 +1
  const bonus = rules.milestone?.levelBonus ?? 2;
  if (extra?.warden) rec += bonus;
  if (extra?.passesWarden) { rec = Math.max(rec, recommendedLevel(rules, extra.passesWarden) + bonus); traitDanger += 1; }
  return { recommendedLevel: rec, levelGap: rec - level, traitDanger };
}

/** 候補の大守護者の情報（offerGap の extra） */
export function offerWardenExtra(o: { objective: { type: string }; passesWarden?: { depth: number } }): { warden?: boolean; passesWarden?: number } {
  return { ...(o.objective.type === 'slay_warden' ? { warden: true } : {}), ...(o.passesWarden ? { passesWarden: o.passesWarden.depth } : {}) };
}

/**
 * 次の候補の下限（V3-2R3 §20.2）: 目標として達成した最深の階（campDepth）+ 堅実の幅。最初の候補の深さより浅くはならない。
 * 踏破で先まで降りても深くならない
 */
export function nextCampOf(rules: Pick<CatalogRules, 'recommendedLevel' | 'slots' | 'expedition'> & Partial<Pick<CatalogRules, 'milestone'>>, campDepth: number, cleared: readonly number[] = []): { minTargetDepth: number; recommendedLevel: number } {
  let min = Math.max(rules.expedition.firstTargetDepth?.safe ?? 1, campDepth + rules.slots.safe.aheadMin);
  // 節目の階（大守護者の間）は目標にならない: 未踏破なら堅実はその 1 つ上（力を付ける）、踏破済みなら 1 つ深く（V3-3a §35.2）
  const ms = rules.milestone;
  const isMs = (d: number) => !!ms && d >= ms.min && d % ms.every === 0;
  if (isMs(min) && !cleared.includes(min)) min -= 1;
  while (isMs(min)) min++;
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
export function regenInterval(rules: Pick<CatalogRules, 'regen'>, level: number, boonDelta = 0): number {
  const r = rules.regen;
  const base = Math.max(r.minInterval, r.baseInterval - Math.trunc(level / r.levelDiv));
  if (!boonDelta) return base;
  // 加護（息吹。V3-3 §3.3）: 間隔を縮める。下限は 1 だけ下げる（下限の後に −2 すると、レベル 12 以上で毎手番 1 回復になり、
  // 1 ダメージずつ撃つ相手と永久に釣り合った。bot の計測で 1 ランが止まらなくなった）
  return Math.max(Math.max(1, r.minInterval - 1), base + boonDelta);
}

/** 加護の hooks の数値の合計（engine と観測で同じ計算。例: regen の interval） */
export function boonHookSum(boons: Record<string, { hooks: ({ hook: string } & Record<string, number | string>)[] } | undefined>, ids: readonly string[] | undefined, hook: string, field: string): number {
  let n = 0;
  for (const id of ids ?? []) for (const h of boons[id]?.hooks ?? []) if (h.hook === hook && typeof h[field] === 'number') n += h[field] as number;
  return n;
}

/** 休憩と自然回復で戻る上限の HP（最大 HP × restCapPct %。V3-4b §28.3）。engine と観測で同じ式を使う */
export function restCapHp(rules: Pick<CatalogRules, 'restCapPct'>, maxHp: number): number {
  const pct = rules.restCapPct ?? 100;
  return pct >= 100 ? maxHp : Math.max(1, Math.trunc((maxHp * pct) / 100));
}

/**
 * 回復の蓄積を 1 手番進める（engine の実処理と観測の見積もりで共用）。
 * limit（休憩・自然回復の上限）に達していれば蓄積は 0。gain を足し、間隔に達するごとに 1 HP。
 */
export function regenStep(acc: number, hp: number, limit: number, gain: number, interval: number): { acc: number; heal: number } {
  if (hp >= limit) return { acc: 0, heal: 0 };
  let a = acc + gain;
  let heal = 0;
  while (a >= interval && hp + heal < limit) { a -= interval; heal++; }
  if (hp + heal >= limit) a = 0;
  return { acc: a, heal };
}

/** 状態異常の装甲の修正を足した装甲（錆。下げる修正では 0 未満にしない。engine の armorOf と同じ規則。V3-5a §35.10） */
export function armorWithStatuses(statusDefs: Record<string, { armor?: number }>, statuses: readonly { id: string }[] | undefined, armor: number): number {
  let d = 0;
  for (const s of statuses ?? []) d += statusDefs[s.id]?.armor ?? 0;
  return d < 0 ? Math.max(Math.min(armor, 0), armor + d) : armor + d;
}

export function nameOf(n: Names | undefined, locale: 'ja' | 'en', fallback = '?'): string {
  if (!n) return fallback;
  return locale === 'en' ? n.en : n.ja;
}

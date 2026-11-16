// コンテンツ定義の zod スキーマ。packages/content/data/<pack>/*.json を起動時に検証する。
// 見た目（グリフ・色・スプライト）はここに書かない（client のテーマが持つ）。
import { z } from 'zod';

export const IdSchema = z.string().regex(/^[a-z0-9_]+:[a-z0-9_]+$/, 'ID は pack:name 形式');
export const NamesSchema = z.object({ ja: z.string().min(1), en: z.string().min(1) });
export const DiceSchema = z.string().regex(/^\s*(?:\d+d\d+)?\s*(?:[+-]\s*\d+)?\s*$|^\s*-?\d+\s*$/, 'ダイス表記 (例 2d4+2)');
export const DepthSchema = z.object({
  min: z.number().int().min(1),
  peak: z.number().int().min(1).optional(),
  max: z.number().int().min(1).optional(),
});
/** 効果 DSL の 1 要素。effect はエンジンのレジストリに登録されたハンドラ ID */
export const EffectSchema = z.object({ effect: z.string().min(1), chancePct: z.number().int().min(0).max(100).optional() }).passthrough();
export type EffectDef = z.infer<typeof EffectSchema> & Record<string, unknown>;

export const TerrainSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  passable: z.boolean(),
  opaque: z.boolean(),
  layer: z.enum(['ground', 'object']).default('ground'),
  door: z.enum(['open', 'closed']).optional(),
  stairs: z.enum(['up', 'down']).optional(),
  tags: z.array(z.string()).default([]),
});

export const MonsterSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  /** 地図の 1 文字（種族ごとに一意。起動時に重複を検証） */
  glyph: z.string().regex(/^[A-Za-z]$/, '英字 1 文字'),
  tags: z.array(z.string()).default([]),
  depth: DepthSchema,
  rarity: z.number().int().min(1),
  stats: z.object({
    hp: DiceSchema, acc: z.number().int(), eva: z.number().int(), might: z.number().int(),
    armor: z.number().int(), sight: z.number().int().min(1),
  }),
  speed: z.number().int().min(10).default(100),
  attack: z.object({ dice: DiceSchema, onHit: z.array(EffectSchema).default([]) }),
  ranged: z.object({ dice: DiceSchema, range: z.number().int().min(2), acc: z.number().int().default(0) }).optional(),
  ai: z.object({ archetype: z.string().min(1) }).catchall(z.number()),
  xp: z.number().int().min(0),
  drops: z.array(z.object({ table: IdSchema, chancePct: z.number().int().min(0).max(100) })).default([]),
  group: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).optional(),
  sleepPct: z.number().int().min(0).max(100).default(50),
  /** モンスターの思い出に記録され得る観測可能な能力 */
  abilities: z.array(z.string()).default([]),
});

export const EquipSchema = z.object({
  slot: z.enum(['weapon', 'armor', 'accessory']),
  dmg: DiceSchema.optional(),
  acc: z.number().int().default(0),
  eva: z.number().int().default(0),
  might: z.number().int().default(0),
  armor: z.number().int().default(0),
});

export const ItemSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  category: z.string().min(1),
  unidentified: z.boolean().default(false),
  depth: DepthSchema,
  rarity: z.number().int().min(1),
  stack: z.boolean().default(false),
  equip: EquipSchema.optional(),
  onUse: z.array(EffectSchema).default([]),
  /** use 時の対象: none=自分, pos=座標, entity=視界内の対象 */
  target: z.enum(['none', 'pos', 'entity']).default('none'),
  throw: z.object({ dmg: DiceSchema, range: z.number().int().min(1), acc: z.number().int().default(0) }).optional(),
  /** 投げて当たった時に onUse を対象に適用する（薬など） */
  shatter: z.boolean().default(false),
  /** 自分に使うと害がある（鑑定済みなら use_item ではなく throw_item を候補に出す） */
  harmful: z.boolean().default(false),
  /** 宝（category: treasure）の価値: dice × mult × (100 + 深度 × perDepthPct) / 100。見えた時点で分かる */
  value: z.object({ dice: DiceSchema, mult: z.number().int().min(1), perDepthPct: z.number().int().min(0).default(10) }).optional(),
  desc: NamesSchema.optional(),
});

export const AppearanceSchema = z.object({ id: IdSchema, name: NamesSchema, category: z.string().min(1) });

export const AffixSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  /** guardian: 遠征の守護者専用（通常の生成では付かない） */
  target: z.enum(['monster', 'item', 'guardian']),
  depth: DepthSchema,
  rarity: z.number().int().min(1),
  categories: z.array(z.string()).default([]),
  mods: z.object({
    hpPct: z.number().int().default(0), speed: z.number().int().default(0), acc: z.number().int().default(0),
    eva: z.number().int().default(0), might: z.number().int().default(0), armor: z.number().int().default(0),
    dmgBonus: z.number().int().default(0), xpPct: z.number().int().default(0),
  }).default({}),
  onHit: z.array(EffectSchema).default([]),
  abilities: z.array(z.string()).default([]),
});

export const StatusSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  /** engine の status ハンドラ ID（dot / speed_pct / incapacitate など） */
  handler: z.string().min(1),
  params: z.record(z.number()).default({}),
});

export const BiomeSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  depth: DepthSchema,
  weight: z.number().int().min(0),
  palette: z.object({
    floor: IdSchema, wall: IdSchema, doorClosed: IdSchema, doorOpen: IdSchema,
    extra: z.array(z.object({ terrain: IdSchema, pct: z.number().int().min(0).max(100), clusters: z.number().int().min(0).default(0) })).default([]),
  }),
  layouts: z.record(z.number().int().min(0)),
  spawnTags: z.record(z.number().int().min(0)).default({}),
  features: z.array(z.object({ feature: IdSchema, chancePct: z.number().int().min(0).max(100) })).default([]),
});

const Per1000Schema = z.object({ per1000: z.number().int().min(0) });
/** 深度帯ごとのテンポ調整（IMPROVEMENTS_V2 §5.1）。最初に一致した帯を使う */
export const PacingSchema = z.object({
  depth: z.object({ min: z.number().int().min(1), max: z.number().int().min(1).optional() }),
  size: z.object({ w: z.number().int().min(20), h: z.number().int().min(15) }).optional(),
  /** 到着地点から下り階段までの歩行距離の範囲 */
  stairsPath: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).optional(),
  monsters: Per1000Schema.optional(),
  items: Per1000Schema.optional(),
  traps: Per1000Schema.optional(),
});

export const FloorTypeSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  depth: DepthSchema,
  weight: z.number().int().min(0),
  /** depth % every === 0 のとき強制（0 は無効） */
  every: z.number().int().min(0).default(0),
  size: z.object({ w: z.number().int().min(20), h: z.number().int().min(15) }).default({ w: 64, h: 40 }),
  layouts: z.record(z.number().int().min(0)).optional(),
  monsters: z.object({ per1000: z.number().int().min(0), table: IdSchema }),
  items: z.object({ per1000: z.number().int().min(0), table: IdSchema }),
  traps: z.object({ per1000: z.number().int().min(0) }).default({ per1000: 0 }),
  prefabs: z.object({ tags: z.array(z.string()).default([]), min: z.number().int().min(0).default(0), max: z.number().int().min(0).default(1) }).default({}),
  guaranteedFeatures: z.array(IdSchema).default([]),
  rules: z.object({ noWander: z.boolean().default(false) }).default({}),
  validators: z.array(z.string()).default(['stairs_connected', 'start_safe', 'min_floor_area']),
  /** 深度帯ごとの寸法・階段距離・密度（size / per1000 を上書き） */
  pacing: z.array(PacingSchema).default([]),
});

export const PrefabCellSchema = z.object({
  /** 地形 ID か、バイオームのパレット参照 '$floor' '$wall' '$door' */
  terrain: z.string().optional(),
  feature: IdSchema.optional(),
  monster: z.string().optional(), // ID か '$spawn'
  item: z.string().optional(), // ID か '$loot'
  loot: IdSchema.optional(),
  asleep: z.boolean().optional(),
});

export const PrefabSchema = z.object({
  id: IdSchema,
  tags: z.array(z.string()).default([]),
  depth: DepthSchema,
  weight: z.number().int().min(0),
  map: z.array(z.string()).min(1),
  legend: z.record(PrefabCellSchema),
  rotate: z.boolean().default(true),
  flip: z.boolean().default(true),
});

export const SpawnTableSchema = z.object({
  id: IdSchema,
  tagsAny: z.array(z.string()).default([]),
  tagsNone: z.array(z.string()).default([]),
  /** 深層の敵が混ざる確率と、その深度差 */
  oodChancePct: z.number().int().min(0).max(100).default(5),
  oodDepth: z.number().int().min(0).default(3),
});

export const LootTableSchema = z.object({
  id: IdSchema,
  entries: z.array(z.object({ item: IdSchema.optional(), category: z.string().optional(), weight: z.number().int().min(1) })).min(1),
  depthBonus: z.number().int().default(0),
  affixChancePct: z.number().int().min(0).max(100).default(10),
});

export const ClassSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  stats: z.object({ hp: z.number().int().min(1), acc: z.number().int(), eva: z.number().int(), might: z.number().int(), armor: z.number().int(), sight: z.number().int().min(1) }),
  speed: z.number().int().min(10).default(100),
  capacity: z.number().int().min(1).max(26).default(20),
  unarmed: DiceSchema.default('1d3'),
  startItems: z.array(z.object({ item: IdSchema, qty: z.number().int().min(1).default(1), equip: z.boolean().default(false) })).default([]),
  levelUp: z.object({ hp: z.number().int().min(0), accEvery: z.number().int().min(0).default(2), mightEvery: z.number().int().min(0).default(3), evaEvery: z.number().int().min(0).default(4) }),
  /** 罠を見つける確率（隣接時、毎手番） */
  searchPct: z.number().int().min(0).max(100).default(15),
  /** 寝ているモンスターを起こしにくさ（起床判定の確率補正 %） */
  stealthPct: z.number().int().min(0).max(100).default(0),
});

const Int = z.number().int();
/** 調整値（IMPROVEMENTS_V2 §6）。get_rules の数値もここから作る */
export const BalanceSchema = z.object({
  id: IdSchema,
  regen: z.object({
    /** 自然回復の間隔（手番）= max(minInterval, baseInterval - floor(Lv / levelDiv)) */
    baseInterval: Int.min(1), levelDiv: Int.min(1), minInterval: Int.min(1),
    /** 休息中（追跡中の敵が見えない wait）の回復の速さ（倍） */
    restMultiplier: Int.min(1),
  }),
  rest: z.object({ maxTurns: Int.min(1) }),
  macro: z.object({ stepLimit: Int.min(1) }),
  wander: z.object({ firstAt: Int.min(0), intervalMin: Int.min(1), intervalMax: Int.min(1), maxAwake: Int.min(0), minDistance: Int.min(0) }),
  score: z.object({ perDepth: Int, perKill: Int, perLevel: Int }),
  /** 推定残り HP: 記録がこの数未満の間は上限を出さない */
  estimate: z.object({ minSamples: Int.min(1) }).default({ minSamples: 5 }),
  /** 敵を倒す以外の経験値（V3-2R §14.5）: 新しい深度に初めて着く（× 深度）、遠征の目的を達成する（× 目標深度） */
  xp: z.object({ perNewDepth: Int.min(0), perObjective: Int.min(0) }).default({ perNewDepth: 0, perObjective: 0 }),
  /** 戦利品（IMPROVEMENTS_V3 §2.2） */
  haul: z.object({
    overreachFirst: Int.min(0), overreachStep: Int.min(0), perKill: Int.min(0),
    discovery: z.object({ species: Int.min(0), identify: Int.min(0), room: Int.min(0), inscription: Int.min(0) }),
    /** 撤退のときに確定する割合（目的の基礎点は含まない） */
    withdrawPct: Int.min(0).max(100),
    guardianBounty: z.object({ base: Int.min(0), perDepth: Int.min(0) }),
  }),
  expedition: z.object({
    /** 最初の遠征の目標深度（枠ごと） */
    firstTargetDepth: z.object({ safe: Int.min(2), standard: Int.min(2), ambitious: Int.min(2) }),
    aheadMin: Int.min(1), aheadMax: Int.min(1),
    /** 達成時の基礎点（目的の種類ごと） */
    points: z.record(Int),
    /** 目標が「最深到達＋aheadMin」より深い 1 階ごとの加点 */
    pointsPerExtraDepth: Int,
    /** retrieve_relic で遺物を守護者が守る確率 */
    relicGuardianPct: Int.min(0).max(100),
    /** 目的達成後の圧力（slay_guardian / retrieve_relic）: 徘徊の湧き間隔の割合 */
    afterObjective: z.object({ wanderIntervalPct: Int.min(1).max(100) }),
    /** 推奨レベル（深度 1 から順。bot の実測の中央値。表より深い階は直近 4 階の傾きで外挿する） */
    recommendedLevelByDepth: z.array(Int.min(1)).min(5),
    /** 候補の 3 枠: 目標の深さ（最深 + aheadMin〜aheadMax）、条件の数、基礎点の割合 */
    slots: z.record(z.object({ aheadMin: Int.min(1), aheadMax: Int.min(1), traitsMin: Int.min(0), traitsMax: Int.min(0), pointsPct: Int.min(1) })),
  }),
});

/** 遠征の条件（公開の修飾。目標階までの全階に効く。倍率は帰還時の戦利品に掛かる） */
export const ExpeditionTraitSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  multiplierPct: z.number().int().min(1),
  /** 危険度への加算 */
  danger: z.number().int(),
  effects: z.object({
    monstersPct: z.number().int().min(0).optional(),
    itemsPct: z.number().int().min(0).optional(),
    treasurePct: z.number().int().min(0).optional(),
    wanderIntervalPct: z.number().int().min(1).optional(),
    sightDelta: z.number().int().optional(),
    noWander: z.boolean().optional(),
    noFountain: z.boolean().optional(),
  }).default({}),
});

export const FeatureSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  category: z.enum(['feature', 'trap']),
  states: z.array(z.string()).default(['idle']),
  initialState: z.string().default('idle'),
  passable: z.boolean().default(true),
  /** 地物を操作したときの効果 */
  onInteract: z.array(EffectSchema).default([]),
  /** 操作後に遷移する状態（無ければ遷移しない） */
  afterInteract: z.string().optional(),
  /** 罠: 踏んだときの効果 */
  onEnter: z.array(EffectSchema).default([]),
  depth: DepthSchema.default({ min: 1 }),
  rarity: z.number().int().min(1).default(1),
});

export type TerrainDef = z.infer<typeof TerrainSchema>;
export type MonsterDef = z.infer<typeof MonsterSchema>;
export type ItemDef = z.infer<typeof ItemSchema>;
export type AppearanceDef = z.infer<typeof AppearanceSchema>;
export type AffixDef = z.infer<typeof AffixSchema>;
export type StatusDef = z.infer<typeof StatusSchema>;
export type BiomeDef = z.infer<typeof BiomeSchema>;
export type FloorTypeDef = z.infer<typeof FloorTypeSchema>;
export type PrefabDef = z.infer<typeof PrefabSchema>;
export type PrefabCell = z.infer<typeof PrefabCellSchema>;
export type SpawnTableDef = z.infer<typeof SpawnTableSchema>;
export type LootTableDef = z.infer<typeof LootTableSchema>;
export type ClassDef = z.infer<typeof ClassSchema>;
export type FeatureDef = z.infer<typeof FeatureSchema>;
export type BalanceDef = z.infer<typeof BalanceSchema>;
export type PacingDef = z.infer<typeof PacingSchema>;
export type ExpeditionTraitDef = z.infer<typeof ExpeditionTraitSchema>;

/** ファイル名 → スキーマ。新しい定義ファイル種別はここに 1 行足す */
export const FILE_SCHEMAS = {
  terrain: TerrainSchema,
  monsters: MonsterSchema,
  items: ItemSchema,
  appearances: AppearanceSchema,
  affixes: AffixSchema,
  statuses: StatusSchema,
  biomes: BiomeSchema,
  floorTypes: FloorTypeSchema,
  prefabs: PrefabSchema,
  spawnTables: SpawnTableSchema,
  lootTables: LootTableSchema,
  classes: ClassSchema,
  features: FeatureSchema,
  balance: BalanceSchema,
  expeditionTraits: ExpeditionTraitSchema,
} as const;

export type FileKind = keyof typeof FILE_SCHEMAS;

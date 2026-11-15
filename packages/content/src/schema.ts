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
  desc: NamesSchema.optional(),
});

export const AppearanceSchema = z.object({ id: IdSchema, name: NamesSchema, category: z.string().min(1) });

export const AffixSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  target: z.enum(['monster', 'item']),
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
} as const;

export type FileKind = keyof typeof FILE_SCHEMAS;

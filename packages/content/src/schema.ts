// コンテンツ定義の zod スキーマ。packages/content/data/<pack>/*.json を起動時に検証する。
// 見た目（グリフ・色・スプライト）はここに書かない（client のテーマが持つ）。
import { z } from 'zod';
import type { FeatCond } from '@muse/shared';

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
  /** 入るときの手番コストの倍率（%。V3-5 §5.2: 浅い水は 150） */
  moveCostPct: z.number().int().min(1).default(100),
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
  /** pierce: 装甲（と構え）を無視する射撃（V3-5a §35.10） */
  ranged: z.object({ dice: DiceSchema, range: z.number().int().min(2), acc: z.number().int().default(0), pierce: z.boolean().optional() }).optional(),
  ai: z.object({ archetype: z.string().min(1) }).catchall(z.number()),
  xp: z.number().int().min(0),
  drops: z.array(z.object({ table: IdSchema, chancePct: z.number().int().min(0).max(100) })).default([]),
  group: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).optional(),
  sleepPct: z.number().int().min(0).max(100).default(50),
  /** モンスターの思い出に記録され得る観測可能な能力 */
  abilities: z.array(z.string()).default([]),
  /** 体格（見れば分かる公開の性質。V3-2R3 §20.4）。大柄は宝を必ず落とす */
  size: z.enum(['small', 'medium', 'large']).default('medium'),
  /** 初見の描写（1 文。V3-5 §5.4） */
  desc: NamesSchema.optional(),
});

export const EquipSchema = z.object({
  slot: z.enum(['weapon', 'armor', 'accessory']),
  dmg: DiceSchema.optional(),
  acc: z.number().int().default(0),
  eva: z.number().int().default(0),
  might: z.number().int().default(0),
  armor: z.number().int().default(0),
  /** 以下 V3-4（IMPROVEMENTS_V3 §4.4・§14.5） */
  maxHp: z.number().int().default(0),
  sight: z.number().int().default(0),
  /** 近接・投擲だけの命中の修正（習熟と同じ扱い） */
  meleeAcc: z.number().int().default(0),
  thrownAcc: z.number().int().default(0),
  /** 起こしにくさ（職業の stealthPct に足す） */
  stealthPct: z.number().int().default(0),
  /** 眠っている敵が起きる確率に足す（%。重い鎧） */
  wakePct: z.number().int().default(0),
  /** 歩く手番のコスト（標準 100。重い鎧） */
  moveCost: z.number().int().min(50).default(100),
  /** 自分の立てた音で、眠っている敵が必ず起きる（静寂の指輪の欠点） */
  noiseWakes: z.boolean().default(false),
  /** 武器の特性（weaponTraits の ID） */
  traits: z.array(IdSchema).default([]),
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
  /** 手放せない品（帰還の綱）: 捨てる・投げることができず、所持数に数えない。坑の中には出ない */
  bound: z.boolean().default(false),
  /** 宝（category: treasure）の価値: dice × mult × (100 + 深度 × perDepthPct) / 100。見えた時点で分かる */
  value: z.object({ dice: DiceSchema, mult: z.number().int().min(1), perDepthPct: z.number().int().min(0).default(10) }).optional(),
  /** 遺物（category: relic）が持ち帰られるとなる加護（boons の ID。V3-3 §3.3） */
  boon: IdSchema.optional(),
  /** 由来の 1 文（遺物。説明の前に付き、納めたときの物語の文にも使う。V3-3 §3.4） */
  origin: NamesSchema.optional(),
  desc: NamesSchema.optional(),
  /** 未鑑定の手がかり（感覚の特徴。2〜3 種で共有する。V3-5 §5.4）。持って clueTurns 手番たつか、斥候なら拾った時点で分かる */
  clue: NamesSchema.optional(),
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
    /** 品物の接辞だけ: 最大 HP・視界（V3-4） */
    maxHp: z.number().int().default(0), sight: z.number().int().default(0),
  }).default({}),
  onHit: z.array(EffectSchema).default([]),
  abilities: z.array(z.string()).default([]),
  /** 呪い（V3-4 §4.4）: 装備するか鑑定するまで見えず、装備すると外せない */
  cursed: z.boolean().default(false),
});

export const StatusSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  /** engine の status ハンドラ ID（dot / speed_pct / incapacitate など） */
  handler: z.string().min(1),
  params: z.record(z.number()).default({}),
  /** 付いた者にとって悪い・良い状態か（音の状態の ailment・boost。SOUND_SPEC §2.1）。無ければどちらでもない（帰還中など） */
  tone: z.enum(['bad', 'good']).optional(),
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
  /** 初見の描写（1 文。V3-5 §5.4） */
  desc: NamesSchema.optional(),
  /** バイオームの仕掛け（V3-5 §5.2）: levers 格子扉とレバーの組の数、ceilings 脆い天井の数、pods 胞子嚢の数 */
  rules: z.object({ levers: z.number().int().min(0).default(0), ceilings: z.number().int().min(0).default(0), pods: z.number().int().min(0).default(0) }).default({}),
  /** その階に置く品（V3-5 §5.2: 沈んだ書庫の残り頁） */
  items: z.array(z.object({ item: IdSchema, min: z.number().int().min(0), max: z.number().int().min(0) })).default([]),
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
  /** depth % every === 0 のとき強制（0 は無効）。重なったら priority の大きい方（V3-3 §3.2: 節目の階は聖域より優先） */
  every: z.number().int().min(0).default(0),
  priority: z.number().int().default(0),
  size: z.object({ w: z.number().int().min(20), h: z.number().int().min(15) }).default({ w: 64, h: 40 }),
  layouts: z.record(z.number().int().min(0)).optional(),
  monsters: z.object({ per1000: z.number().int().min(0), table: IdSchema }),
  items: z.object({ per1000: z.number().int().min(0), table: IdSchema }),
  traps: z.object({ per1000: z.number().int().min(0) }).default({ per1000: 0 }),
  prefabs: z.object({ tags: z.array(z.string()).default([]), min: z.number().int().min(0).default(0), max: z.number().int().min(0).default(1) }).default({}),
  guaranteedFeatures: z.array(IdSchema).default([]),
  /** warden: 節目の大守護者の階（V3-3 §3.2）。レイアウトの目印の場所に大守護者を置き、倒すまで下り階段を封じる */
  /** events: 階の異変（V3-5 §5.3）が付くことがある階の種類 */
  rules: z.object({ noWander: z.boolean().default(false), warden: z.boolean().default(false), events: z.boolean().default(false) }).default({}),
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
  /** 特殊部屋の名前（V3-5 §5.1。tags に room を持つ部屋は、見つけると発見の点が入る） */
  name: NamesSchema.optional(),
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
  /** depthMin: この深さ（depthBonus を足した深さ）から引く（V3-3b §40.1: 投げ槍） */
  entries: z.array(z.object({ item: IdSchema.optional(), category: z.string().optional(), weight: z.number().int().min(1), depthMin: z.number().int().min(1).optional() })).min(1),
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
  /** レベルごとの固定成長は HP だけ。命中・威力・回避は特技で選ぶ（V3-4 §4.1） */
  levelUp: z.object({ hp: z.number().int().min(0) }),
  /** 習熟（V3-4 §4.3）: 近接・投擲の命中の修正 */
  proficiency: z.object({ melee: z.number().int().default(0), thrown: z.number().int().default(0) }).default({}),
  /** 職業の特技の系統（共通の表に加えて候補に出る）。perks.json の lineage と対応 */
  lineages: z.array(z.object({ id: z.string().min(1), name: NamesSchema })).default([]),
  /** Lv1 から持つ特技（能動技 1 つを含む） */
  startPerks: z.array(IdSchema).default([]),
  /** 罠を見つける確率（隣接時、毎手番） */
  searchPct: z.number().int().min(0).max(100).default(15),
  /** 寝ているモンスターを起こしにくさ（起床判定の確率補正 %） */
  stealthPct: z.number().int().min(0).max(100).default(0),
  /** 未鑑定の品の手がかりが、拾った時点で分かる（V3-5 §5.4: 斥候） */
  clueOnPickup: z.boolean().default(false),
});

/** 特技（V3-4 §4.1）。lineage: 'common' か職業の系統 ID。mods は取った時点で基本値に入る。hooks はエンジンのレジストリ（perkHooks）の ID と引数 */
export const PerkSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  lineage: z.string().min(1),
  maxRanks: z.number().int().min(1).default(1),
  requires: z.array(IdSchema).default([]),
  mods: z.object({
    maxHp: z.number().int().default(0), acc: z.number().int().default(0), eva: z.number().int().default(0),
    might: z.number().int().default(0), armor: z.number().int().default(0), capacity: z.number().int().default(0),
    stealthPct: z.number().int().default(0),
  }).default({}),
  /** 取ると覚える能動技 */
  ability: IdSchema.optional(),
  hooks: z.array(z.object({ hook: z.string().min(1) }).catchall(z.number())).default([]),
  /** このレベルまでに一度も候補に出ていなければ、このレベルの候補の 1 枠をこれにする（その職業の系統のときだけ。V3-3b §40.1） */
  offerByLevel: z.number().int().min(2).optional(),
});

/** 能動技（V3-4 §4.2）。資源は持たず、再使用までの手番（cooldown）だけ。handler はエンジンのレジストリ（abilities） */
export const AbilitySchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  handler: z.string().min(1),
  /** 対象の取り方: adjacent 隣の敵 / throw 投擲の射程と射線が通る敵 / dir 方向 / none 自分 */
  target: z.enum(['adjacent', 'throw', 'dir', 'none']),
  cooldown: z.number().int().min(0),
  /** 遠征ごとの回数の上限（立て直し） */
  perExpedition: z.number().int().min(1).optional(),
  params: z.record(z.number()).default({}),
});

/** 武器の特性（V3-4 §4.4）。handler はエンジンのレジストリ（weaponTraits） */
/** 守護者の型（V3-3 §3.1・§28.9）。振る舞いは engine の guardianTypeHandlers。strongVs: 近接に強い型か、投擲に強い型か（半々に引く） */
export const GuardianTypeSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  handler: z.string().min(1),
  strongVs: z.enum(['melee', 'thrown']),
  /** この型が打ち消す弱点（V3-3c §44.2: 弾く者に「投擲に弱い」、潜む者に「眠りが深い」を付けない） */
  excludesWeaknesses: z.array(IdSchema).default([]),
  params: z.record(z.number()).default({}),
});

/** 守護者の弱点（V3-3 §3.1）。最初は伏せる（試して分かるまで観測に出さない） */
export const GuardianWeaknessSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  /** 短い呼び名（外れた試しの「毒ではない」。V3-3a §35.3） */
  short: NamesSchema.optional(),
  desc: NamesSchema,
  handler: z.string().min(1),
  /** 付けてよい装甲の目安の上限（V4-1l §34.2: 装甲の高い相手に「投擲に弱い」を付けない。無ければ上限なし） */
  maxArmor: z.number().int().nonnegative().optional(),
  params: z.record(z.number()).default({}),
});

/** 加護（V3-3 §3.3）: 遺物を持ち帰る・大守護者を倒すと付き、ランの終わりまで残る。mods は取ったときに素の能力値へ足す。
 * hooks はエンジンの各所が読む（regen: 自然回復の間隔 / throw_return: 投げた物が戻る / soothe: 起きにくい / stairs_haste: 階段の後に加速 / last_stand: 致死を耐える） */
export const BoonSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  mods: z.object({
    maxHp: z.number().int().default(0), acc: z.number().int().default(0), eva: z.number().int().default(0),
    might: z.number().int().default(0), armor: z.number().int().default(0), sight: z.number().int().default(0),
  }).default({}),
  hooks: z.array(z.object({ hook: z.string().min(1) }).catchall(z.number())).default([]),
});

/**
 * 物語の文（V3-3 §3.4）。frame: 世界の枠（get_rules）／briefing: 遠征の開始の 1 文／guardian_slain・warden_slain: 倒したとき／
 * relic_delivered: 遺物を納めたとき。when に合う中で、条件の多いものから weight で選ぶ。{depth} {guardian} {relic} {origin} を埋める
 */
export const LoreSchema = z.object({
  id: IdSchema,
  kind: z.enum(['frame', 'briefing', 'guardian_slain', 'warden_slain', 'relic_delivered', 'inscription', 'note']),
  when: z.object({ objective: z.string().optional(), guarded: z.boolean().optional(), guardianType: IdSchema.optional() }).default({}),
  weight: z.number().int().min(1).default(1),
  text: NamesSchema,
});

/**
 * 階の異変（V3-5 §5.3）。生成時に低い確率で 1 つ付く。到着の文（arrival）だけを観測に出し、ID と中身は出さない。
 * handler: エンジンのレジストリ（generate の floorEventHandlers）
 */
export const FloorEventSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  arrival: NamesSchema,
  handler: z.string().min(1),
  depth: DepthSchema,
  weight: z.number().int().min(1).default(1),
});

/** 実績の条件（V3-7 §7.4）: 遠征レポートと要約の値（FeatContext のパス）に対する比較式 */
const FeatCondSchema: z.ZodType<FeatCond> = z.lazy(() => z.union([
  z.object({ all: z.array(FeatCondSchema).min(1) }),
  z.object({ any: z.array(FeatCondSchema).min(1) }),
  z.object({ path: z.string().regex(/^(report|expedition|run|profile)\.[a-z_.]+$/), op: z.enum(['==', '!=', '>=', '<=', '>', '<']), value: z.union([z.number(), z.string(), z.boolean()]) }),
]));

/** 実績（V3-7 §7.4）。強さには影響しない（記録だけ）。hidden: 取るまで条件を伏せる */
export const FeatSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  hidden: z.boolean().default(false),
  cond: FeatCondSchema,
});

/** 守護者の名前の音節（V3-3 §3.1。シードで 2〜3 個つなぐ） */
export const GuardianNamesSchema = z.object({
  id: IdSchema,
  parts: z.array(NamesSchema).min(4),
});

export const WeaponTraitSchema = z.object({
  id: IdSchema,
  name: NamesSchema,
  desc: NamesSchema,
  handler: z.string().min(1),
  params: z.record(z.number()).default({}),
});

const Int = z.number().int();
/** 調整値（IMPROVEMENTS_V2 §6）。get_rules の数値もここから作る */
export const BalanceSchema = z.object({
  id: IdSchema,
  /** 種族の表を定義する深さ（V3-5b §44.7: この深さまでは接辞と深層強化で硬くするだけの階にしない）。種族の最も深い peak と大きいほう */
  monsterTableDepth: Int.min(1).default(1),
  /** 階の異変（V3-5 §5.3）: 付く確率（%） */
  floorEvent: z.object({ chancePct: Int.min(0).max(100) }).default({ chancePct: 0 }),
  /** 名前付きの強敵（V3-5 §5.4）: 通常の出現に混ざる確率（%）・最初の深さ・接辞の数・賞金（基礎 + 深さごと） */
  elite: z.object({ chancePct: Int.min(0).max(100), minDepth: Int.min(1), affixes: Int.min(0), bountyBase: Int.min(0), bountyPerDepth: Int.min(0) })
    .default({ chancePct: 0, minDepth: 3, affixes: 2, bountyBase: 150, bountyPerDepth: 30 }),
  /** 未鑑定の品の手がかり（V3-5 §5.4）: この手番だけ持てば分かる（斥候は拾った時点で） */
  clueTurns: Int.min(0).default(30),
  /** 継承（V3-7 §7.3）: 図鑑でこの数以上倒した種族の知識を、次のランの開始時に引き継ぐ */
  legacy: z.object({ minKills: Int.min(1) }).default({ minKills: 5 }),
  regen: z.object({
    /** 自然回復の間隔（手番）= max(minInterval, baseInterval - floor(Lv / levelDiv)) */
    baseInterval: Int.min(1), levelDiv: Int.min(1), minInterval: Int.min(1),
    /** 休息中（追跡中の敵が見えない wait）の回復の速さ（倍） */
    restMultiplier: Int.min(1),
  }),
  /** capPct: 休憩と自然回復で戻る上限（最大 HP の %。V3-4b §28.3）。100 で上限なし */
  rest: z.object({ maxTurns: Int.min(1), capPct: Int.min(1).max(100).default(100) }),
  macro: z.object({ stepLimit: Int.min(1) }),
  /** fight（V3-4b §28.4）: 追跡中で逃げていない標的が見えなくなったときに待つ手番 */
  /** firstHitStopPct: 初被弾で止まるのは、その被弾が最大 HP のこの % 以上のときだけ。recordedKills: この数以上倒した種族は記録ありとして扱う（V3-3a §35.6） */
  fight: z.object({ lostWait: Int.min(0), firstHitStopPct: Int.min(0).max(100).default(15), recordedKills: Int.min(1).default(3) }).default({ lostWait: 5, firstHitStopPct: 15, recordedKills: 3 }),
  wander: z.object({ firstAt: Int.min(0), intervalMin: Int.min(1), intervalMax: Int.min(1), maxAwake: Int.min(0), minDistance: Int.min(0) }),
  score: z.object({ perDepth: Int, perKill: Int, perLevel: Int }),
  /** 推定残り HP: 記録がこの数未満の間は上限を出さない */
  estimate: z.object({ minSamples: Int.min(1) }).default({ minSamples: 5 }),
  /** 敵を倒す以外の経験値（V3-2R §14.5）: 新しい深度に初めて着く（× 深度）、遠征の目的を達成する（× 目標深度） */
  xp: z.object({ perNewDepth: Int.min(0), perObjective: Int.min(0), killDepthPct: Int.min(0).default(0) }).default({ perNewDepth: 0, perObjective: 0, killDepthPct: 0 }),
  /** 戦利品（IMPROVEMENTS_V3 §2.2） */
  haul: z.object({
    /** 踏破の点の下限（n 階目 = first + step × (n − 1)） */
    overreachFirst: Int.min(0), overreachStep: Int.min(0),
    /** 踏破の点（V3-2R2 §18.4）: n 階目 = 目的の点 × (first + step × (n − 1))%。下限は overreachFirst / overreachStep */
    overreachPct: z.object({ first: Int.min(0), step: Int.min(0) }).default({ first: 0, step: 0 }),
    /** 撃破の点（V3-2R3 §20.5）= 種族の経験値 × killPerXp × 深さの係数（depthPct）。接辞付きは × killAffixPct % */
    killPerXp: Int.min(0), killAffixPct: Int.min(100).default(150),
    discovery: z.object({ species: Int.min(0), identify: Int.min(0), room: Int.min(0), inscription: Int.min(0) }),
    /** 撤退のときに確定する割合（目的の基礎点は含まない） */
    withdrawPct: Int.min(0).max(100),
    guardianBounty: z.object({ base: Int.min(0), perDepth: Int.min(0) }),
  }),
  /**
   * シーズンの野営の火（S1。SEASON.md §8）: 置く費用（深さ × fireCostPerDepth 点。このランの確定点から）・シーズンで置ける数・ほかの火との間（チェビシェフ距離）・
   * 支援賞に数える使用の戻りの下限（最大 HP の %）
   */
  season: z.object({ fireCostPerDepth: Int.min(0), firesPerSeason: Int.min(0), fireSpacing: Int.min(0), supportMinHealPct: Int.min(0).max(100) })
    .default({ fireCostPerDepth: 200, firesPerSeason: 3, fireSpacing: 5, supportMinHealPct: 10 }),
  /** 帰還の綱（V3-2R2 §18.1）: 使ってから戻るまでの手番と、確定する戦利品の割合 */
  lifeline: z.object({ turns: Int.min(0), pct: Int.min(0).max(100) }).default({ turns: 0, pct: 50 }),
  /** 転移の着地点: 元の位置からこの距離以上（チェビシェフ）を優先する */
  teleport: z.object({ minDistance: Int.min(0) }).default({ minDistance: 0 }),
  /** 守護者の格（V3-2R3 §20.1。堅実 1・標準 2・野心 3）ごとの体力の上乗せ（%）と下限（minHpBase + minHpPerDepth × 深度） */
  guardian: z.object({
    /** tableDepth: 候補の種族を引く表の深さの上乗せ（格 2 は +1、格 3 は +2 の表の上位半分。V3-4b §28.2） */
    ranks: z.array(z.object({ hpPct: Int.min(0), minHpBase: Int.min(0), minHpPerDepth: Int.min(0), tableDepth: Int.min(0).default(0),
      /** 型の数（V3-3 §28.9: 格 1 は 0、格 2・3 は 1） */
      types: Int.min(0).default(0) })).min(1),
    /** 持ち場の範囲（V3-2R3b §23.2）: 気づいていない守護者は持ち場からこのマス数（チェビシェフ）以内だけを動く */
    leash: Int.min(0).default(3),
    /** 相手が階を離れている間、守護者が手番 1 つにつき回復する最大体力の %（V3-3a §35.1） */
    awayHealPct: Int.min(0).default(2),
    /** 節目の大守護者（V3-3 §3.2）: 体力の上乗せと下限、賞金の倍率（%）、型の数、倒したときに選べる加護の数 */
    warden: z.object({
      hpPct: Int.min(0), minHpBase: Int.min(0), minHpPerDepth: Int.min(0), bountyPct: Int.min(0), types: Int.min(0), boonOptions: Int.min(1),
      /** 体力の上限（V3-3a §35.2）: maxHpBase + maxHpPerDepth × 深さ */
      maxHpBase: Int.min(1).default(40), maxHpPerDepth: Int.min(0).default(10),
      /** 節目に挑む候補の推奨レベルの上乗せ（V3-3a §35.2） */
      levelBonus: Int.min(0).default(2),
      /** 大守護者の速さの下限（V3-3c §44.2: 遅い種族の大守護者は、離れて投げるだけで近づかれなかった） */
      minSpeed: Int.min(0).default(100),
    }).default({ hpPct: 250, minHpBase: 20, minHpPerDepth: 6, bountyPct: 300, types: 2, boonOptions: 3, maxHpBase: 40, maxHpPerDepth: 10, levelBonus: 2, minSpeed: 100 }),
  }),
  /** 特技の候補の数（V3-4 §4.1） */
  perks: z.object({ options: Int.min(1) }).default({ options: 3 }),
  /** 呪い（V3-4 §4.4）: 武器・防具・装飾品が生成されるときに呪われる確率（%）。呪われた品は必ず良い接辞も持つ */
  curse: z.object({ chancePct: Int.min(0).max(100) }).default({ chancePct: 0 }),
  /** 床に落ちている投擲用の品の 1 山の数（V3-4b §28.6: 投げナイフの供給を絞る） */
  loot: z.object({ throwStackMin: Int.min(1), throwStackMax: Int.min(1) }).default({ throwStackMin: 2, throwStackMax: 6 }),
  expedition: z.object({
    /** 最初の遠征の目標深度（枠ごと） */
    firstTargetDepth: z.object({ safe: Int.min(2), standard: Int.min(2), ambitious: Int.min(2) }),
    /** 候補の点（V3-2R2 §18.3）= 枠の基礎点 × 種類の係数 % × 深さの係数 %。retrieve_relic_guarded は守護者付きの遺物 */
    typePct: z.record(Int.min(1)),
    /** 同じ階を目標にした達成を繰り返すと、目的の基礎点に掛かる %（2 回目 50%、3 回目 25%。V3-3a §35.2） */
    repeatPct: Int.min(0).max(100).default(50),
    /** 繰り返しの減点の下限（V3-3b §40.6。2 回目 50%、3 回目からは 25% で止まる） */
    repeatMinPct: Int.min(0).max(100).default(25),
    /** 深さの係数 = base + perDepth × 目標深度（%） */
    depthPct: z.object({ base: Int.min(1), perDepth: Int.min(0) }),
    /** retrieve_relic で遺物を守護者が守る確率 */
    relicGuardianPct: Int.min(0).max(100),
    /** 目的達成後の圧力（slay_guardian / retrieve_relic）: 徘徊の湧き間隔の割合 */
    afterObjective: z.object({ wanderIntervalPct: Int.min(1).max(100) }),
    /** 推奨レベル（深度 1 から順。bot の実測の中央値。表より深い階は直近 4 階の傾きで外挿する） */
    recommendedLevelByDepth: z.array(Int.min(1)).min(5),
    /** 候補の 3 枠: 目標の深さ（最深 + aheadMin〜aheadMax）、条件の数、枠の基礎点 */
    slots: z.record(z.object({ aheadMin: Int.min(1), aheadMax: Int.min(1), traitsMin: Int.min(0), traitsMax: Int.min(0), base: Int.min(1) })),
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
  /** 同じ候補に付けない条件（V3-3 後の AI 評価: 静か＝徘徊なし と 騒がしい＝徘徊が早い が同時に付いた） */
  excludes: z.array(IdSchema).default([]),
  /**
   * 階を作るときに効く条件（敵・アイテム・宝の数、泉なし）が、作った階に残す性質（V4-0e §8.1）。
   * name: 階の性質の短い名前（「この階は群れている」）、detail: 括弧の中、danger: その階を通る候補の危険度への加算（条件と同じだけ）
   */
  floor: z.object({ name: NamesSchema, detail: NamesSchema.optional(), danger: z.number().int().default(0) }).optional(),
}).superRefine((t, c) => {
  // 階を作るときに効く効果を持つ条件は、階の性質の名前を持つ（作った階に残るので、見せる名前が要る）
  const gen = t.effects.monstersPct !== undefined || t.effects.itemsPct !== undefined || t.effects.treasurePct !== undefined || !!t.effects.noFountain;
  if (gen && !t.floor) c.addIssue({ code: z.ZodIssueCode.custom, message: `${t.id}: an expedition trait with floor-generation effects needs "floor" (V4-0e §8.1)` });
  if (!gen && t.floor) c.addIssue({ code: z.ZodIssueCode.custom, message: `${t.id}: "floor" is only for traits with floor-generation effects` });
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
  /** 説明（look で読める。V3-5 §5.1） */
  desc: NamesSchema, // 何であるか・どう使うかの 1 行。すべての地物に要る（V4-1g G6。無ければ起動時の検査で落とす）
  /** レバー（V3-5 §5.2）: 操作するとつないだ格子扉を開け閉めする */
  lever: z.boolean().default(false),
  /** 脆い天井（V3-5 §5.2）: trigger マス以内で音量 loudness 以上の音がすると崩れ、radius マスの者に dmg を与え、その場は瓦礫になる */
  collapse: z.object({ trigger: z.number().int().min(0), loudness: z.number().int().min(0), radius: z.number().int().min(0), dmg: DiceSchema }).optional(),
  /** 胞子嚢（V3-5 §5.2）: 突く（interact）か投げた物が当たると弾け、radius マスに毒の雲（cloud）を turns 手番残す */
  burst: z.object({ radius: z.number().int().min(0), cloud: IdSchema, turns: z.number().int().min(1) }).optional(),
  /** 野営の火（S1。SEASON.md §8）: シーズンの参加者が置く。隣か上で操作すると HP が休憩の上限まで戻る（処理は engine の interact） */
  campfire: z.boolean().default(false),
  /** 賭けの祭壇（V3-5 §5.1）: 操作すると重みで 1 つ選び、その効果が起きる（表と確率は公開） */
  gamble: z.array(z.object({ weight: z.number().int().min(1), name: NamesSchema, effects: z.array(EffectSchema).min(1) })).optional(),
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
export type PerkDef = z.infer<typeof PerkSchema>;
export type AbilityDef = z.infer<typeof AbilitySchema>;
export type WeaponTraitDef = z.infer<typeof WeaponTraitSchema>;
export type GuardianTypeDef = z.infer<typeof GuardianTypeSchema>;
export type GuardianWeaknessDef = z.infer<typeof GuardianWeaknessSchema>;
export type GuardianNamesDef = z.infer<typeof GuardianNamesSchema>;
export type BoonDef = z.infer<typeof BoonSchema>;
export type LoreDef = z.infer<typeof LoreSchema>;
export type FloorEventDef = z.infer<typeof FloorEventSchema>;
export type FeatDef = z.infer<typeof FeatSchema>;

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
  perks: PerkSchema,
  abilities: AbilitySchema,
  weaponTraits: WeaponTraitSchema,
  guardianTypes: GuardianTypeSchema,
  guardianWeaknesses: GuardianWeaknessSchema,
  guardianNames: GuardianNamesSchema,
  boons: BoonSchema,
  lore: LoreSchema,
  floorEvents: FloorEventSchema,
  feats: FeatSchema,
} as const;

export type FileKind = keyof typeof FILE_SCHEMAS;

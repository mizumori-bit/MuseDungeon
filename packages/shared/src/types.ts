// World State の型。プレーンな JSON 直列化可能データのみ（クラス・メソッド無し）。
// 仕様: docs/DESIGN.md §3

export type EntityId = string;
export type PlayerId = string;
export type FloorKey = string; // `${branch}:${depth}` 例 "main:3"
export type Locale = 'ja' | 'en';

export type Dir = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';
export const DIRS: readonly Dir[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
export const DIR_VEC: Readonly<Record<Dir, readonly [number, number]>> = {
  n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1],
};

export interface Pos { x: number; y: number }
export interface FloorPos extends Pos { floor: FloorKey }
export interface Names { ja: string; en: string }

export type AiStateName = 'asleep' | 'unaware' | 'hunting' | 'searching';
export interface AiState {
  archetype: string;
  state: AiStateName;
  targetPos: Pos | null;
  /** 見失ってからの手番数（searching の打ち切り用） */
  lostTurns: number;
  params: Record<string, number>;
}

export interface StatusInst { id: string; turnsLeft: number; power: number }

export interface Stats {
  hp: number; maxHp: number;
  acc: number; eva: number; might: number; armor: number; sight: number;
  /** 近接攻撃のダメージダイス（装備込みの実効値） */
  dmg: string;
}
export type BaseStats = Omit<Stats, 'hp'>;

export type EquipSlot = 'weapon' | 'armor' | 'accessory';
export const EQUIP_SLOTS: readonly EquipSlot[] = ['weapon', 'armor', 'accessory'];

export interface ActorComp {
  speed: number;
  nextActAt: number;
  faction: 'player' | 'monster';
  /** このアクターが行動した手番数 */
  turns: number;
  /** 休眠中（スケジューラが手番を与えない。睡眠中モンスター用） */
  dormant?: boolean;
  ai?: AiState;
  /** 自然回復の蓄積値（プレイヤー）。通常の手番で +1、休息の手番で +restMultiplier、回復間隔に達すると 1 HP */
  regen?: number;
}

export interface Entity {
  id: EntityId;
  kind: string;
  /** 生成時の seq。エンティティ走査はこの順（挿入順）で行う */
  sid: number;
  pos?: FloorPos;
  actor?: ActorComp;
  stats?: Stats;
  base?: BaseStats;
  inv?: { items: EntityId[]; capacity: number };
  equip?: Partial<Record<EquipSlot, EntityId>>;
  item?: { qty: number; affixes: string[]; heldBy?: EntityId; slot?: string };
  statuses?: StatusInst[];
  trap?: { revealedTo: PlayerId[] };
  feature?: { state: string };
  player?: PlayerId;
  level?: { level: number; xp: number };
  scale?: { tier: number; affixes: string[] };
  /** モンスター撃破時の経験値 */
  xp?: number;
  /** 遠征の目的に関わる個体（守護者・遺物） */
  role?: EntityRole;
}

export type EntityRole = 'guardian' | 'relic';

export interface Region {
  id: number;
  kind: 'room' | 'cave' | 'corridor' | 'prefab';
  x: number; y: number; w: number; h: number;
  tags: string[];
}

export interface Floor {
  key: FloorKey;
  branch: string;
  depth: number;
  biome: string;
  floorType: string;
  width: number;
  height: number;
  /** このフロアのローカル時刻 */
  time: number;
  /** width*height。meta.terrainTable への index */
  terrain: number[];
  regions: Region[];
  entry: Pos;
  stairs: { up: Pos | null; down: Pos[] };
  /** 現在コマンド待ちのアクター（プレイヤー）。null は凍結中 */
  currentActor: EntityId | null;
  nextWanderAt: number;
  rules: { noWander: boolean };
}

export interface MonsterMemory {
  kind: string;
  encounters: number;
  kills: number;
  /** このモンスター種から一撃で受けた最大ダメージ */
  maxDamageToYou: number;
  /** このモンスター種に一撃で与えた最大ダメージ */
  maxDamageByYou: number;
  /** 観測した能力（例 'poison', 'ranged', 'fast', 'slow', 'flees'） */
  abilities: string[];
  /** 目の前で倒れた個体の最大 HP（守護者は除く） */
  hpSeen?: { min: number; max: number; samples: number };
}

export interface RememberedEntity {
  id: EntityId;
  kind: string;
  cat: 'item' | 'feature' | 'trap';
  pos: Pos;
  qty: number;
  /** 最後に見たフロア時刻 */
  ft: number;
  state?: string;
}

export interface FloorKnowledge {
  /** width*height。記憶した地形（terrainTable index）。0 = 未知 */
  seen: number[];
  remembered: RememberedEntity[];
}

export interface Knowledge {
  floors: Record<FloorKey, FloorKnowledge>;
  /** 現在視界内のセル index（現在フロア、昇順） */
  visible: number[];
  identified: string[];
  monsterMemory: Record<string, MonsterMemory>;
  notes: string[];
  /** 遭遇済みの個体 ID（思い出の遭遇数カウント用） */
  met: EntityId[];
  /** 自分が見ている間にその個体が受けた実ダメージの合計（生存中の個体のみ） */
  damageSeen?: Record<EntityId, number>;
}

export interface PlayerStats {
  kills: number;
  deepest: number;
  turns: number;
  deathCause: string | null;
  endedSeq: number | null;
  /** 達成した遠征の数と、その基礎点の合計 */
  expeditions?: number;
  expeditionPoints?: number;
}

export interface Controller { kind: 'agent' | 'human'; label: string }

export interface PlayerRecord {
  id: PlayerId;
  name: string;
  classId: string;
  locale: Locale;
  controller: Controller;
  entityId: EntityId;
  /** at_camp: 遠征から帰還・撤退してキャンプにいる（盤面にいない） */
  state: PlayerState;
  joinedSeq: number;
  stats: PlayerStats;
  knowledge: Knowledge;
  /** 最後に extract した地点（次の遠征の再開地点） */
  extractPos?: FloorPos | null;
}

export type PlayerState = 'alive' | 'dead' | 'left' | 'at_camp';

// ---- 遠征（IMPROVEMENTS_V2 §2） ----
export type ObjectiveType = 'reach_depth' | 'slay_guardian' | 'retrieve_relic' | 'endless';
export type ExpeditionEndReason = 'completed' | 'withdrawn' | 'died' | 'retired';
export const OBJECTIVE_TYPES: readonly ObjectiveType[] = ['reach_depth', 'slay_guardian', 'retrieve_relic', 'endless'];

export interface Objective {
  type: ObjectiveType;
  /** endless は null */
  targetDepth: number | null;
}

export interface ExpeditionOffer {
  /** 1 始まりの番号（start_expedition の offer） */
  index: number;
  objective: Objective;
  /** 達成時の基礎点 */
  points: number;
  /** retrieve_relic: 遺物を守護者が守る */
  relicGuarded: boolean;
}

export interface CampState {
  /** 次の遠征の通番 */
  nextNo: number;
  offers: ExpeditionOffer[];
}

export interface ObjectiveProgress {
  /** 目標深度に誰かが到達した */
  reached: boolean;
  guardianSlain: boolean;
  /** 遺物を持っているプレイヤーのエンティティ */
  relicHeldBy: EntityId | null;
}

export interface ExpeditionResult {
  reason: ExpeditionEndReason;
  /** 獲得した遠征の基礎点（達成時のみ） */
  points: number;
  /** この遠征中の最深到達（最大）・撃破と手番（参加者の合計） */
  deepest: number;
  kills: number;
  turns: number;
}

export interface Expedition {
  no: number;
  objective: Objective;
  points: number;
  relicGuarded: boolean;
  status: 'in_progress' | 'objective_complete' | 'ended';
  startSeq: number;
  endSeq: number | null;
  endReason: ExpeditionEndReason | null;
  participants: PlayerId[];
  /** 開始時点の参加者の成績（結果の差分計算用） */
  start: Record<PlayerId, { kills: number; turns: number; deepest: number }>;
  /** 目標階に配置した守護者・遺物（目標階の生成時に決まる。プレイヤーには渡さない） */
  targets: { guardian: EntityId | null; relic: EntityId | null };
  progress: ObjectiveProgress;
  extracted: { player: PlayerId; completed: boolean }[];
  result: ExpeditionResult | null;
}

export type RngState = [number, number, number, number];

export interface RunOptions {
  /** COOP で他プレイヤー待ちのタイムアウト。null は無制限 */
  turnTimeoutMs: number | null;
  maxPlayers: number;
}

export interface RunMeta {
  runId: string;
  contentVersion: string;
  engineVersion: string;
  eventVersion: number;
  mode: 'solo' | 'coop';
  createdSeq: number;
  /** terrain index → terrain ID。リプレイがコンテンツ更新に影響されないようランごとに固定 */
  terrainTable: string[];
  options: RunOptions;
}

export interface WorldSecret {
  seed: string;
  rng: Record<string, RngState>;
  /** 未鑑定になり得るアイテム kind → 外見 ID（ランごとにシャッフル） */
  appearances: Record<string, string>;
}

export interface World {
  meta: RunMeta;
  /** 外部射影から必ず除去（観戦では seed と rng を除去） */
  secret: WorldSecret;
  seq: number;
  status: 'active' | 'ended';
  endReason: string | null;
  floors: Record<FloorKey, Floor>;
  entities: Record<EntityId, Entity>;
  players: Record<PlayerId, PlayerRecord>;
  /** 参加順 */
  playerOrder: PlayerId[];
  /** 遠征の記録（古いログには無い） */
  expeditions?: Expedition[];
  /** キャンプの候補（遠征と遠征の間） */
  camp?: CampState | null;
}

export interface RunSummaryPlayer {
  id: PlayerId;
  name: string;
  classId: string;
  controller: Controller;
  level: number;
  deepest: number;
  turns: number;
  kills: number;
  state: PlayerRecord['state'];
  deathCause: string | null;
  equipment: Partial<Record<EquipSlot, string>>;
  score: number;
  /** 達成した遠征の数 */
  expeditions?: number;
}

export interface ExpeditionBrief {
  no: number;
  objective: Objective;
  status: Expedition['status'];
  endReason: ExpeditionEndReason | null;
  points: number;
  startSeq: number;
  endSeq: number | null;
}

export interface RunSummary {
  runId: string;
  reason: string;
  seed: string;
  endedSeq: number;
  players: RunSummaryPlayer[];
  /** 遠征ごとの記録 */
  expeditions?: ExpeditionBrief[];
}

export function floorKey(branch: string, depth: number): FloorKey {
  return `${branch}:${depth}`;
}

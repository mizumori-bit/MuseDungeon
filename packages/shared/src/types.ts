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
}

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
}

export interface PlayerStats {
  kills: number;
  deepest: number;
  turns: number;
  deathCause: string | null;
  endedSeq: number | null;
}

export interface Controller { kind: 'agent' | 'human'; label: string }

export interface PlayerRecord {
  id: PlayerId;
  name: string;
  classId: string;
  locale: Locale;
  controller: Controller;
  entityId: EntityId;
  state: 'alive' | 'dead' | 'left';
  joinedSeq: number;
  stats: PlayerStats;
  knowledge: Knowledge;
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
}

export interface RunSummary {
  runId: string;
  reason: string;
  seed: string;
  endedSeq: number;
  players: RunSummaryPlayer[];
}

export function floorKey(branch: string, depth: number): FloorKey {
  return `${branch}:${depth}`;
}

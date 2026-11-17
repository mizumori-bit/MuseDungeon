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
  /** 予備動作（V3-3 §3.1）: 次の手番に大きな行動を取る。見えていれば公開情報。dir: 突進の向き */
  intent?: Intent;
}

/** 予備動作: winding_up（突進の構え）/ summoning（手下を呼ぶ）/ enraging（怒る） */
export interface Intent { kind: 'winding_up' | 'summoning' | 'enraging'; dir?: Dir }

/**
 * 守護者の型と名前（V3-3 §3.1）。name・types は公開（候補にも出る）。weakness はプレイヤーには渡さない（試して分かったら knowledge.guardianIntel）。
 * summoned: 手下を呼んだ閾値の数、enraged: 怒った、unseen: 直前の手番を相手の視界の外で終えた（潜む者）
 */
export interface GuardianInfo {
  name: Names; title?: Names; types: string[]; weakness: string | null; summoned?: number; enraged?: boolean;
  /** 潜む者: unseen = 相手の視界の外から隣へ寄った（次の一撃が会心）、lurk = 見られたまま隠れていた手番、struck = 会心の一撃の後（退いて隠れ直す） */
  unseen?: boolean; lurk?: number; struck?: boolean;
}

/** source: 状態異常を与えた者（毒で倒したときの撃破者。V3-2R 評価の修正） */
export interface StatusInst { id: string; turnsLeft: number; power: number; source?: EntityId | null }

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
  /** thrownBy: 床に落ちている投げた物の持ち主（その人が上に入ると自動で拾う） */
  /**
   * hidden: まだ見えていない接辞（呪い。V3-4 §4.4）。装備するか鑑定すると affixes へ移る。プレイヤーには渡さない。
   * inspected: 呪いの有無を確かめた（装備した・鑑定した・初期装備）。武器・防具・装飾品だけが使う
   */
  item?: { qty: number; affixes: string[]; heldBy?: EntityId; slot?: string; thrownBy?: PlayerId; value?: number; hidden?: string[]; inspected?: boolean };
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
  /** 倒すと遠征の戦利品に入る賞金（守護者・名前付きの強敵） */
  bounty?: number;
  /** 持ち場（守護者が置かれたマス。V3-2R3b §23.2）。気づいていない間はここから guardian.leash マス以内だけを動く。プレイヤーには渡さない */
  home?: { x: number; y: number };
  /** ビルド（プレイヤー。V3-4 §4.1・§4.2） */
  build?: PlayerBuild;
  /** 守護者の型・名前・弱点（V3-3） */
  guardian?: GuardianInfo;
}

/** 特技の候補（レベルアップごとに 1 つ）。options が空なのは、前の候補を選ぶまで引いていないもの */
export interface PerkOffer { level: number; options: string[] }
/** 覚えた能動技。readyAt: 自分の手番数（actor.turns）がこの値以上なら使える。usedNo: 最後に使った遠征の番号、uses: その遠征で使った回数 */
export interface AbilityState { id: string; readyAt: number; usedNo?: number; uses?: number }
/** perks: 取った特技（段階のある特技は段階の数だけ並ぶ）、pending: 選んでいない候補（古い順） */
export interface PlayerBuild { perks: string[]; pending: PerkOffer[]; abilities: AbilityState[] }

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
  /** 観測した遠隔攻撃の最長距離 */
  rangeMax?: number;
  /** 守護者の記録（種族の記録と分ける。キーは guardian|種族） */
  guardian?: boolean;
  /** 自分の攻撃が当たったときの実ダメージの [合計, 回数]（近接・投擲。V3-2R3 §20.4「通り」） */
  dmgByYou?: { melee?: [number, number]; thrown?: [number, number] };
  /** 自分の攻撃の [命中, 回数]（近接・投擲を分ける。V3-2R2 §18.2） */
  hitsByYou?: { melee?: [number, number]; thrown?: [number, number] };
  /** この種族から自分への攻撃の [命中, 回数] */
  hitsOnYou?: [number, number];
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
  /** 地形は知っているが、まだ自分の目で見ていないセル（地図の巻物で知った区画。V3-2R §14.2） */
  mapped?: number[];
}

/** 遺物・守護者の気配（目標階にいる間。方角と、10 マス以内かどうか。正確な位置は見るまで出さない） */
export interface Sense { what: 'guardian' | 'relic'; dir: Dir; range: 'far' | 'near' }

/**
 * 今いる階の手がかり（V3-2R2 §18.4。engine が計算する）。
 * draft: 下り階段をまだ見ていないときの、その方角（遠近は出さない）。explored: 通れるマスのうち見た割合の 4 段階（1 = 約 1/4 … 4 = ほぼ全て）
 */
export interface FloorHint { floor: FloorKey; draft: Dir | null; explored: 1 | 2 | 3 | 4 }

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
  /** 自分のセルから投擲の経路が通る、視界内の敵 */
  shots?: EntityId[];
  /** 個体を初めて見た seq（met と同時に記録） */
  metAt?: Record<EntityId, number>;
  /** 目標の気配（目標階にいる間だけ） */
  sense?: Sense | null;
  /** 今いる階の手がかり（下への風・探索の進み具合） */
  floorHint?: FloorHint | null;
  /** 試して分かった守護者の弱点（V3-3 §3.1。守護者の ID → 弱点の ID） */
  guardianIntel?: Record<EntityId, string>;
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
  /** スコア版 2: 確定点の合計と、死亡・引退で失った戦利品の合計 */
  banked?: number;
  lost?: number;
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
/** lifeline: 帰還の綱で戻った（V3-2R2 §18.1） */
export type ExpeditionEndReason = 'completed' | 'withdrawn' | 'lifeline' | 'died' | 'retired';
export const OBJECTIVE_TYPES: readonly ObjectiveType[] = ['reach_depth', 'slay_guardian', 'retrieve_relic', 'endless'];

export interface Objective {
  type: ObjectiveType;
  /** endless は null */
  targetDepth: number | null;
}

export type OfferSlot = 'safe' | 'standard' | 'ambitious';

export interface ExpeditionOffer {
  /** 1 始まりの番号（start_expedition の offer） */
  index: number;
  objective: Objective;
  /** 達成時の基礎点 */
  points: number;
  /** retrieve_relic: 遺物を守護者が守る */
  relicGuarded: boolean;
  /** 枠（堅実・標準・野心）。古いランには無い */
  slot?: OfferSlot;
  /** 条件（expeditionTraits の ID） */
  traits?: string[];
  /** 帰還時の戦利品に掛かる倍率（%） */
  multiplierPct?: number;
  /** 守護者の見込み（守護者を倒す・守護者付きの遺物。V3-2R3 §20.1）。種族名は会うまで出さない。name・types（V3-3）は公開 */
  guardian?: { rank: 1 | 2 | 3; traits: string[]; name?: Names; title?: Names; types?: string[] };
  /** 守護者の種族（候補を作った時点で決める。プレイヤーには渡さない） */
  guardianKind?: string;
  /** 守護者の弱点（候補を作った時点で決める。プレイヤーには渡さない。V3-3） */
  guardianWeakness?: string | null;
}

/** 遠征の戦利品のうち、参加者で共有する部分（目的・深追い・宝は別に計算する） */
export interface ExpeditionHaul {
  bounty: number;
  discovery: number;
  kills: number;
}

/** 戦利品の内訳 */
export interface HaulParts {
  objective: number;
  overreach: number;
  treasure: number;
  bounty: number;
  discovery: number;
  kills: number;
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
  /** この遠征で参加者が到達した最深階（深追いの計算用） */
  maxDepth?: number;
  /** 踏破: 参加者が下り階段に立った最も深い階（目標より深い階だけが点になる。V3-2R） */
  crossedDepth?: number;
}

export interface ExpeditionResult {
  reason: ExpeditionEndReason;
  /** 獲得した遠征の基礎点（達成時のみ） */
  points: number;
  /** この遠征中の最深到達（最大）・撃破と手番（参加者の合計） */
  deepest: number;
  kills: number;
  turns: number;
  /** スコア版 2 の払い戻し（参加者の合計） */
  payout?: { banked: number; lost: number; multiplierPct: number; parts: HaulParts; players: { player: PlayerId; banked: number; lost: number }[] };
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
  /** pos: その参加者がこの遠征を始めた地点（綱で戻った次の遠征はここから。V3-2R3a §22.1） */
  start: Record<PlayerId, { kills: number; turns: number; deepest: number; pos?: FloorPos }>;
  /** 目標階に配置した守護者・遺物（目標階の生成時に決まる。プレイヤーには渡さない） */
  targets: { guardian: EntityId | null; relic: EntityId | null };
  progress: ObjectiveProgress;
  /** treasure: extract のときに持ち帰った宝の価値の合計 */
  /** lifeline: 帰還の綱で戻った（確定は戦利品の lifeline.pct %） */
  extracted: { player: PlayerId; completed: boolean; treasure?: number; lifeline?: boolean }[];
  result: ExpeditionResult | null;
  slot?: OfferSlot;
  traits?: string[];
  multiplierPct?: number;
  haul?: ExpeditionHaul;
  /** 守護者の種族と格（候補から引き継ぐ。プレイヤーには渡さない。V3-2R3 §20.1） */
  guardianKind?: string;
  guardianRank?: 1 | 2 | 3;
  /** 守護者の名前と型（公開）・弱点（プレイヤーには渡さない）。V3-3 */
  guardianName?: Names;
  guardianTitle?: Names;
  guardianTypes?: string[];
  guardianWeakness?: string | null;
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
  /** スコア版 2 の確定点 */
  banked?: number;
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
  /** 2: score は確定点（IMPROVEMENTS_V3 §2.2）。無ければ版 1（深度×1000 ほか） */
  scoreVersion?: 1 | 2;
}

export function floorKey(branch: string, depth: number): FloorKey {
  return `${branch}:${depth}`;
}

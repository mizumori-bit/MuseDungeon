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
  /** 最後に大振りした手番（V3-5b §44.7。swingEvery 手番ごとに構える） */
  swingAt?: number;
  /** 巡回の道（V3-5 §5.3。番人の巡回・賞金首）と、次に向かう点 */
  route?: Pos[];
  routeIdx?: number;
}

/** 予備動作: winding_up（突進の構え）/ summoning（手下を呼ぶ）/ enraging（怒る）/ swinging（大振りの構え。pos: 打つマス。V3-5b） */
/**
 * hold（S1c §14.4 の 3）: 構えたときの相手（プレイヤー）とその手番の数。相手が 1 回動くまで、突進・大振りを出さない
 * （速い敵が、構えと大振りを相手の 1 手番の間に続けて出し、予備動作が一度も見えなかった）
 */
export interface Intent { kind: 'winding_up' | 'summoning' | 'enraging' | 'swinging'; dir?: Dir; pos?: Pos; hold?: { id: EntityId; turns: number } }

/**
 * 守護者の型と名前（V3-3 §3.1）。name・types は公開（候補にも出る）。weakness はプレイヤーには渡さない（試して分かったら knowledge.guardianIntel）。
 * summoned: 手下を呼んだ閾値の数、enraged: 怒った、unseen: 直前の手番を相手の視界の外で終えた（潜む者）
 */
export interface GuardianInfo {
  name: Names; title?: Names; types: string[]; weakness: string | null; summoned?: number; enraged?: boolean;
  /** 潜む者: unseen = 相手の視界の外から隣へ寄った（次の一撃が会心）、lurk = 見られたまま隠れていた手番、struck = 会心の一撃の後（退いて隠れ直す） */
  unseen?: boolean; lurk?: number; struck?: boolean;
  /** 節目の大守護者（V3-3 §3.2）。倒すまでその階の下り階段は封じられる */
  warden?: boolean;
  /** 重い一撃（V3-8 §53.1）: 格 2 以上と大守護者。攻撃は装甲で一撃の半分までしか減らない */
  heavy?: boolean;
  /** 最後のプレイヤーが階を離れたときの、そのプレイヤーの手番数（戻ったときに離れていた手番だけ回復する。V3-3a §35.1） */
  awaySince?: { player: string; turns: number };
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
  /** droppedBy（S1c §14.4 の 6）: 床に置いた者（拾えば消える）。引数なしの pickup は、足元にほかの品があれば、自分の置いた品を拾い直さない */
  item?: { qty: number; affixes: string[]; heldBy?: EntityId; slot?: string; thrownBy?: PlayerId; droppedBy?: PlayerId; value?: number; hidden?: string[]; inspected?: boolean };
  statuses?: StatusInst[];
  trap?: { revealedTo: PlayerId[] };
  /** expiresAt: この階の時刻を過ぎたら消える（毒の雲。V3-5 §5.2） */
  feature?: { state: string; expiresAt?: number };
  /** 野営の火（S1。SEASON.md §8）: 置いた者の名前。地物の判定（featureAt）には入らない */
  campfire?: { by: string };
  /** レバーがつながっている格子扉のマス（V3-5 §5.2） */
  links?: Pos[];
  player?: PlayerId;
  level?: { level: number; xp: number };
  scale?: { tier: number; affixes: string[] };
  /** モンスター撃破時の経験値 */
  xp?: number;
  /** 遠征の目的に関わる個体（守護者・遺物） */
  role?: EntityRole;
  /** 倒すと遠征の戦利品に入る賞金（守護者・名前付きの強敵） */
  bounty?: number;
  /** 呼んだ守護者（呼び集める者の手下。守護者が落ち着くと去る。V3-3b §40.3）。プレイヤーには渡さない */
  minionOf?: EntityId;
  /** 棲み処の地物（護りの火）の持ち主の守護者（V3-3c §44.6。守護者が去ると一緒に消える） */
  lairOf?: EntityId;
  /** 持っている品（倒すと落とす。宝物庫の鍵。V3-5 §5.1。見れば分かる） */
  carries?: string;
  /** 名前付きの強敵の名前（V3-5 §5.4。role: elite） */
  named?: Names;
  /** 傷跡（V3-8 §53.3）: 遠征をまたいで残る体力の減り（大守護者・再挑戦の守護者・賞金首）。キャンプでの全快は最大体力 − 傷跡まで */
  scar?: number;
  /** 持ち場（守護者が置かれたマス。V3-2R3b §23.2）。気づいていない間はここから guardian.leash マス以内だけを動く。プレイヤーには渡さない */
  home?: { x: number; y: number };
  /** ビルド（プレイヤー。V3-4 §4.1・§4.2） */
  build?: PlayerBuild;
  /** 守護者の型・名前・弱点（V3-3） */
  guardian?: GuardianInfo;
  /** 加護（プレイヤー。V3-3 §3.3）: 持ち帰った遺物・倒した大守護者から。ランの終わりまで残る */
  boons?: string[];
  /** 選べる加護の候補（大守護者を倒した。V3-3 §3.2）。choose_boon で 1 つ選ぶ */
  boonChoice?: { options: string[]; source: string; depth: number };
  /** 遠征に 1 回の加護を使った遠征の通番（加護 ID → 通番。執念） */
  boonUsed?: Record<string, number>;
}

/** 遺物の公開情報（V3-3 §3.3）: 候補の時点で名前と加護を出す。owned: 参加者がもう持っている加護 */
export interface RelicInfo {
  kind: string;
  name: Names;
  boon: string | null;
  boonName?: Names;
  boonDesc?: Names;
  owned?: boolean;
}

/** 特技の候補（レベルアップごとに 1 つ）。options が空なのは、前の候補を選ぶまで引いていないもの */
export interface PerkOffer { level: number; options: string[] }
/** 覚えた能動技。readyAt: 自分の手番数（actor.turns）がこの値以上なら使える。usedNo: 最後に使った遠征の番号、uses: その遠征で使った回数 */
export interface AbilityState { id: string; readyAt: number; usedNo?: number; uses?: number }
/** perks: 取った特技（段階のある特技は段階の数だけ並ぶ）、pending: 選んでいない候補（古い順） */
export interface PlayerBuild { perks: string[]; pending: PerkOffer[]; abilities: AbilityState[]   /** これまでに候補に出た特技（職業の能動技を Lv6 までに一度は出すため。V3-3a §35.4） */
  offered?: string[];
}

export type EntityRole = 'guardian' | 'relic' | 'elite';

export interface Region {
  id: number;
  kind: 'room' | 'cave' | 'corridor' | 'prefab';
  x: number; y: number; w: number; h: number;
  tags: string[];
  /** 特殊部屋を見つけた（発見の点は 1 回だけ。V3-5 §5.1） */
  found?: boolean;
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
  /** 階の異変（V3-5 §5.3）。arrival だけをプレイヤーに渡す（ID と中身は渡さない） */
  event?: { id: string; handler: string; arrival: Names };
  /**
   * この階を作ったときに効いた遠征の条件（V4-0e §8.1。階を作るときに効く条件だけ: 群れる・乏しい・静かの「泉なし」）。
   * 作られた階にずっと残る性質で、階にいる者と候補に見せる（プレイヤーがその条件の遠征で作った階なので、知っている情報）。
   * 古い版で作った階には無く、遠征の開始時に足す（floor_traits_noted）
   */
  genTraits?: string[];
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
  /**
   * この種族の攻撃（近接・射撃）で受けた被害の [合計, 当たった回数, 攻撃された回数]（S1c §14.4 の 1・S1d §17.2。平均の被害 = 合計 ÷ 攻撃された回数。外れは 0）。
   * 3 つの欄はどれも同じ時から数える（0.42.0 の 2 つの欄の記録は平均に使わない）
   */
  dmgOnYou?: number[];
  /** この種族から受けた、会心でない最大の一撃（S1d §17.2。0.42.1 より前の記録には無い） */
  maxPlainToYou?: number;
  /** 前の潜る者の覚え書き（継承。V3-7 §7.3）: 前のランまでに倒した数。能力・体力の記録・最大の一撃は、この記録に最初から入っている */
  legacy?: { kills: number };
  /** 守護者の記録だけ: 見た型（図鑑。V3-7 §7.2） */
  types?: string[];
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
  /** 品の接辞（見たときのもの。S3c §33.3 の 1: 覚えている地図は見たときのまま。eventVersion 31 より前の記録には無く、名前だけで出る） */
  affixes?: string[];
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
  /** 試して外れた弱点（守護者 → 弱点 ID の一覧。V3-3a §35.3） */
  guardianTried?: Record<EntityId, string[]>;
  /** 未鑑定の手がかり（V3-5 §5.4）: 分かった見た目 → 手がかりの文。clueSince: 拾った手番（clueTurns たてば分かる） */
  clues?: Record<string, Names>;
  clueSince?: Record<string, number>;
  /** 記録庫が返した節目の大守護者の記憶（深さ → 弱点・体力・最大の一撃。V3-3a §35.7） */
  wardenIntel?: Record<string, { weakness?: string; hp?: number; maxHit?: number; armor?: number }>;
  /** 記録庫に納めた遺物の種類 */
  archive?: string[];
  /** 見ていた敵が 1 手番に 2 回動いたときの自分の手番数（V3-8 §53.4。hp_risk の数え方） */
  paceSeen?: Record<EntityId, number>;
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

/** kind: agent（AI）/ human（人間）/ unknown（参加のときに言わなかった。V4-1g G2: HTTP で controller を省いたとき） */
export interface Controller { kind: 'agent' | 'human' | 'unknown'; label: string }

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
  /** 継承したこと（V3-7 §7.3）: 覚え書きの種族の数。継承なしのランには無い */
  legacy?: { kinds: number };
  /** 最後に extract した地点（次の遠征の再開地点） */
  extractPos?: FloorPos | null;
  /**
   * 自分で出した命令で最後に行動したときの手番数（V4-1j §30.6。actor_scheduled の acted から）。時間切れでゲームが代わりに待たせた手番
   * （source: timeout）と、サーバーが代わりに出した命令（system）は数えない。まだ無ければ 0 とみなす
   */
  lastAct?: number;
}

export type PlayerState = 'alive' | 'dead' | 'left' | 'at_camp';

// ---- 遠征（IMPROVEMENTS_V2 §2） ----
/** slay_warden: 節目に挑む（節目の大守護者を倒して帰る。V3-3a §35.2） */
/** slay_bounty: 賞金首を討つ・open_vault: 宝物庫を開ける（V3-8 §53.2。目標が地下 6 階より深い踏破の枠から） */
export type ObjectiveType = 'reach_depth' | 'slay_guardian' | 'retrieve_relic' | 'slay_warden' | 'slay_bounty' | 'open_vault' | 'endless';
/** lifeline: 帰還の綱で戻った（V3-2R2 §18.1） */
/** time_up: シーズンの行動予算が尽きた（S0。PROTOCOL §9.2。倒れた扱いにしない） */
export type ExpeditionEndReason = 'completed' | 'withdrawn' | 'lifeline' | 'died' | 'retired' | 'time_up';
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
  /** maxHit: 一撃の目安（装甲で減る前。V3-3b §40.6） */
  /** hp: 体力の目安（格 1〜3。種族の体力の平均から。V3-3c §44.2）、hpRange: 体力の幅（格 1〜3 は体力ダイスの最小と最大に目安と同じ上乗せ。V4-0d §6.1。大守護者は式の下限と上限で、hp は無い） */
  /** armor: 装甲の目安（種族・接辞・深層強化。型の効果を除く。V3-8a §56.1） */
  guardian?: { rank: 1 | 2 | 3; traits: string[]; name?: Names; title?: Names; types?: string[]; maxHit?: number; hp?: number; hpRange?: { min: number; max: number }; armor?: number };
  /** 守護者の種族（候補を作った時点で決める。プレイヤーには渡さない） */
  guardianKind?: string;
  /** 守護者の接辞（候補の時点で決める。見込みの特徴と一撃の目安に入る。プレイヤーには渡さない。V3-5a 後の評価 2） */
  guardianAffixes?: string[];
  /** 守護者の弱点（候補を作った時点で決める。プレイヤーには渡さない。V3-3） */
  guardianWeakness?: string | null;
  /** 遺物（retrieve_relic。名前と加護は公開。V3-3 §3.3） */
  relic?: RelicInfo;
  /** 目標へ行く途中で倒す必要がある節目の大守護者（V3-3 後の AI 評価） */
  passesWarden?: MilestoneInfo;
  /** 節目に挑む候補の大守護者（V3-3a §35.2。公開） */
  warden?: MilestoneInfo;
  /** 同じ階を目標にした何回目の達成か（2 以上で基礎点に repeatPct が掛かる。V3-3a §35.2） */
  repeatNo?: number;
  /** くり返しで基礎点（守護者を倒す遠征では守護者の賞金も）に掛けた割合 %（repeatNo があるときだけ。S3b §30.2） */
  repeatPct?: number;
  /** 守護者を倒す遠征の、守護者の賞金（S3b §30.2。くり返しで基礎点と同じ割合に減る。再挑戦は残っている守護者の賞金。公開） */
  guardianBounty?: number;
  /** 再挑戦（V3-3c §44.1）: 目標の階に残っている守護者をもう一度目的にする。no はその守護者を目的にした遠征、guardian はその守護者（賞金首なら bounty。V3-8 §53.3） */
  /** inherits: 基礎点（と守護者の賞金）・条件と倍率（S3c §33.2）を、その相手を置いた遠征から引き継いだ（S3b §30.1。置いた遠征が同じ種類のときだけ。遺物を守っていた守護者などは無い） */
  rechallenge?: { no: number | null; guardian: EntityId; bounty?: boolean; inherits?: boolean };
  /** 賞金首を討つ（V3-8 §53.2）: 種族・接辞・名前・体力と一撃の目安・装甲（公開。守護者の候補と同じ並び） */
  /** hpRange: 体力の幅（体力ダイスの最小と最大に目安と同じ上乗せ。V4-0d §6.1。古い候補には無い） */
  bounty?: BountyInfo & { kindName: Names; affixNames: Names[]; hp: number; hpRange?: { min: number; max: number }; maxHit: number; armor: number };
  /** 宝物庫を開ける（V3-8 §53.2）: 鍵を持つ敵が階にいる */
  vault?: boolean;
  /** 傷跡（V3-8 §53.3）: 前の挑戦で与えたダメージのうち、次の挑戦に残る体力の減り（再挑戦の守護者・賞金首・大守護者） */
  scar?: number;
  /** 目的の階と通り道の階のうち、もう作られていて性質のある階（V4-0e §8.1。条件の ID ごとに深さ。まだ作られていない階は入れない） */
  floorTraits?: { trait: string; depths: number[] }[];
}

/** 賞金首（V3-8 §53.2。名前付きの強敵を遠征の目的にする） */
export interface BountyInfo { kind: string; name: Names; affixes: string[] }

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
  /** 次の節目（V3-3 §3.2）: まだ倒していない最も浅い大守護者の階 */
  milestone?: MilestoneInfo;
}

/** 節目の大守護者の公開情報（V3-3 §3.2）。弱点と種族は伏せる */
export interface MilestoneInfo { depth: number; name: Names; title?: Names; types: string[] }

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
  /** 宝物庫を開けた（open_vault。V3-8 §53.2） */
  vaultOpened?: boolean;
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
  /** hp / maxHp: 開始時点の HP（遠征レポートの HP の推移。V3-6 §6） */
  start: Record<PlayerId, { kills: number; turns: number; deepest: number; pos?: FloorPos; hp?: number; maxHp?: number }>;
  /** 目標階に配置した守護者・遺物（目標階の生成時に決まる。プレイヤーには渡さない）。bounty: 目的の賞金首、vaultLocks: 目標階の鍵のかかった格子扉の数（V3-8 §53.2） */
  targets: { guardian: EntityId | null; relic: EntityId | null; bounty?: EntityId | null; vaultLocks?: number };
  progress: ObjectiveProgress;
  /** treasure: extract のときに持ち帰った宝の価値の合計 */
  /** lifeline: 帰還の綱で戻った（確定は戦利品の lifeline.pct %） */
  /** timeUp: シーズンの予算が尽きてキャンプへ戻された（S0。確定 0、未確定の戦利品は失う） */
  extracted: { player: PlayerId; completed: boolean; treasure?: number; lifeline?: boolean; timeUp?: boolean }[];
  result: ExpeditionResult | null;
  slot?: OfferSlot;
  traits?: string[];
  multiplierPct?: number;
  haul?: ExpeditionHaul;
  /** 守護者の種族と格（候補から引き継ぐ。プレイヤーには渡さない。V3-2R3 §20.1） */
  guardianKind?: string;
  /** 再挑戦の守護者（V3-3c §44.1。新しく置かず、この守護者を目的にする）。賞金首の再挑戦もここ（V3-8 §53.3） */
  rechallengeOf?: EntityId;
  /** 賞金首（V3-8 §53.2）: 候補で決めた種族・接辞・名前（公開） */
  bounty?: BountyInfo;
  /** 守護者の接辞（候補の時点で決める。見込みの特徴と一撃の目安に入る。プレイヤーには渡さない。V3-5a 後の評価 2） */
  guardianAffixes?: string[];
  guardianRank?: 1 | 2 | 3;
  /** 守護者の名前と型（公開）・弱点（プレイヤーには渡さない）。V3-3 */
  guardianName?: Names;
  guardianTitle?: Names;
  guardianTypes?: string[];
  guardianWeakness?: string | null;
  /** 遺物（候補から引き継ぐ。公開。V3-3 §3.3） */
  relic?: RelicInfo;
  /** 目標階に置く守護者の賞金（候補から引き継ぐ。くり返しで減らした額。無ければ式のまま。S3b §30.2） */
  guardianBounty?: number;
  /** 開始時点の次の節目（V3-3 §3.2） */
  milestone?: MilestoneInfo;
  /** ブリーフィングの物語の 1 文（V3-3 §3.4。公開） */
  story?: Names;
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
  /** 中にいる者が隣からしか見えない地形（背の高い草。V3-5 §5.2）の terrainTable の番号 */
  concealTerrain?: number[];
  options: RunOptions;
  /** シーズンのラン（S0。SEASON.md §2）。ランの始まりから。生成・候補・予算の決まりが変わる */
  season?: { id: string; name: string };
}

/** シーズンの賞の写し（S0。PROTOCOL §9.5）。value・rank が null なら対象外（生還賞で倒れた） */
export interface SeasonAward {
  id: 'adventure' | 'contribution' | 'survival' | 'support';
  value: number | null;
  rank: number | null;
  entrants: number;
  leader: { name: string; value: number } | null;
  gap: number | null;
}

/** 公開された下り階段（S0 §9.4）。by: 最初に報告した者の名前 */
export interface SeasonStairs { depth: number; x: number; y: number; by: string }

/** 共有層の野営の火（S1。PROTOCOL §9.10）。mine: 自分の火、uses: 自分の火が支援賞に数えられた回数、dup: 同じマスの取り合いで載らなかった自分の火（S1a） */
export interface SeasonFire { depth: number; x: number; y: number; by: string; mine?: boolean; uses?: number; dup?: boolean; /** S1c: 自分の火を使った参加者の表示名（支援賞に数えた順） */ users?: string[] }

/** 公開された特別な場所（S1c §14.5。祭壇・賭けの祭壇・碑文のうち、部屋の作りに組み込まれたもの）。by は最初に報告した者 */
export interface SeasonSpot { depth: number; x: number; y: number; kind: string; by: string }

/** 補給の置き場（S3。SEASON.md §25.2）: 各階の上り階段・下り階段のマスと、野営の火（火のマス） */
export type SupplyPlace = 'stairs_up' | 'stairs_down' | 'fire';

/**
 * 共有層の補給の品（S3 §25.2。取り込みの写し）。id は共有層の番号 's<番号>'。identified: 預けた者が鑑定済みだった（名前つきで預かる）。
 * mine: 自分が預けた品。n: このランで預けた品なら、その番号（このランの deposited の n。載った後に、自分の世界の写しと重ねない）
 */
export interface SeasonSupply { id: string; depth: number; x: number; y: number; place: SupplyPlace; kind: string; identified: boolean; by: string; mine?: boolean; n?: number }

/** このランで預けた品（S3 §25.2）。n はこのランの通し番号（自分の世界では 'l<n>' の品）。no は預けた遠征 */
export interface SeasonDeposit { n: number; no: number; depth: number; x: number; y: number; place: SupplyPlace; kind: string; identified: boolean }

/** このランで置き場から取った品（S3 §25.2。1 回の遠征で 1 つまで）。id は 's<番号>'（共有層の品）か 'l<番号>'（このランで預けた品） */
export interface SeasonTaken { no: number; id: string; depth: number; x: number; y: number; place: SupplyPlace; kind: string; identified: boolean; by: string }

/** 自分が預けた品を、ほかの参加者が取った（S3 §25.2。取り込みの写し）。taker は取った者の名前 */
export interface SeasonSupplyTaken { id: string; depth: number; x: number; y: number; place: SupplyPlace; kind: string; identified: boolean; taker: string }

/** 討伐の記録の、与えた被害の 1 つの区分（S4）: 合計と回数（1 回あたりは total ÷ n） */
export interface SlayHits { total: number; n: number }

/**
 * 討伐の記録の装備（S4。SEASON.md §35.5 の 2）: 種類と、見えている接辞（隠れた呪いは入らない）。
 * got: その品を手に入れた方法（picked: 拾った・supply: 補給の置き場から取った・start: 最初から持っていた）。depth: 拾った・取った階（場所の座標は持たない）
 */
export interface SlayGear { kind: string; affixes: string[]; got: 'picked' | 'supply' | 'start'; depth?: number }

/**
 * 討伐の記録（S4。SEASON.md §35.5・PROTOCOL §9.13）: 節目の大守護者を倒した参加者の、その戦いの事実。サーバーがそのランの出来事の記録から作る
 * （自由な文は入らない。名前は招いたときの表示名）。取り込みの写し。
 * 戦いの範囲は、倒した遠征のうち、その大守護者の階にいた間（倒すまで）。first: その階で最初に載った記録、least: その階で受けた被害がいちばん少ない記録、
 * of: その階に載った記録の数、mine: 自分の記録。weapon・armor が null なのは、何も装備していなかった（素手・鎧なし）か、未鑑定で載せなかった（hidden）
 */
export interface SeasonSlay {
  depth: number;
  /** 大守護者の呼び名（候補に出るものと同じ） */
  warden: Names;
  by: string;
  mine?: boolean;
  first?: boolean;
  least?: boolean;
  of: number;
  level: number;
  classId: string;
  weapon: SlayGear | null;
  armor: SlayGear | null;
  /** 装備のうち、未鑑定なので載せなかったものがある */
  hidden?: boolean;
  /** 与えた被害（近接・投擲・毒・地物（脆い天井など））と、近接の会心の回数 */
  dealt: { melee: SlayHits; thrown: SlayHits; poison: SlayHits; feature: SlayHits; crits: number };
  /** 受けた被害の合計と、いちばん低かった HP の割合（%。記録から分からなければ無い。S4b） */
  taken: number;
  lowestPct?: number;
  /** 使った品（飲んだ・読んだ）・投げた品（種類と数。倒した者が鑑定済みのものだけ）・使った能動技 */
  used: { kind: string; n: number }[];
  thrown: { kind: string; n: number }[];
  abilities: { id: string; n: number }[];
  /** 消した護りの火の数（棲み処の仕掛け） */
  wardFires: number;
  /** 倒したランで、その大守護者と戦った（攻撃・被害の出来事があった）遠征の何回目で倒したか（S4b: 階に入っただけの遠征は数えない） */
  attempt: number;
  /** 倒した遠征の、始めてから倒すまでの自分の手番 */
  turns: number;
  /** 予備動作への対し方（S5。SEASON.md §47.4 の 1。予備動作の種類ごと。S5 より前の記録には無い） */
  tells?: SlayTell[];
  /** 相手が動けなかった手番と、その手番に与えた・受けた被害（S5。S5 より前の記録には無い） */
  openings?: SlayOpenings;
}

/** 討伐の記録の事実（だれのものか・選ばれ方を除いた中身）。倒さずに帰った自分の挑戦（S5 §47.4 の 2）も同じ形 */
export type SeasonSlayFacts = Omit<SeasonSlay, 'by' | 'mine' | 'first' | 'least' | 'of'>;

/**
 * 予備動作（構え）への対し方（S5。SEASON.md §47.4 の 1）。kind: 予備動作の種類（Intent の kind: winding_up 突進・swinging 大振り・summoning 手下を呼ぶ・enraging 怒り）。
 * n・seen: 構えの後の自分の手番の初めに相手が見えていた構えの回数（突進・大振りは自分に向けた構えだけ。S5c で n も seen と同じ数にした）・
 * missed: 外させた（大きな一撃が空を切り、相手が動けなくなった）・hit: 受けた（大きな一撃が自分に当たった）。missed・hit は突進と大振りだけ（ほかは 0）
 */
export interface SlayTell { kind: Intent['kind']; n: number; seen: number; missed: number; hit: number }

/**
 * 相手が動けなかった手番（S5。SEASON.md §47.4 の 1）: 自分の手番の初めに、相手が見えていて、朦朧・睡眠など動けない状態だった手番。
 * missed: 予備動作を外させた後（外れて動けない）の手番・other: それ以外（眠っている・強打の朦朧が自分の手番まで残った など）。
 * それ以外の手番（相手が動けた手番）の分は、記録の合計（与えた被害の合計・taken）から 2 つを引いた残り
 */
export interface SlayOpenings { missed: SlayOpening; other: SlayOpening }
/** turns: 手番の数・dealt: その手番の自分の行動で相手に与えた被害・hitTurns: 被害を与えた手番の数・taken: その手番から次の自分の手番までに受けた被害 */
export interface SlayOpening { turns: number; dealt: number; hitTurns: number; taken: number }

/**
 * シーズンの写し（S0。PROTOCOL §9.6）。キャンプで取り込んだ共有層（season_sync）。
 * budget.left は取り込んだときの残り、budget.at はそのときの自分の手番（残り = left − (手番 − at)）
 */
export interface SeasonState {
  id: string;
  name: string;
  budget: { limit: number; left: number; at: number };
  /** 終わりの時刻（表示用。ゲームは ended だけを見る） */
  ends_at: number;
  ended: boolean;
  public: SeasonStairs[];
  awards: SeasonAward[];
  /** 自分が最初に報告した数（シーズンの合計） */
  contribution: number;
  /** このシーズンで倒れたことがある（生還賞の対象外） */
  died: boolean;
  /** このランで報告した階の深さ */
  reported: number[];
  /** S1（どれも古いランの写しには無い）: 取り込んだ共有層の火・このランで置いた火（キャンプに着くかランが終わると載る）・このランで火を使った遠征と階・参加者の表示名 */
  fires?: SeasonFire[];
  placed?: { depth: number; x: number; y: number }[];
  fireUses?: { no: number; depth: number; x: number; y: number }[];
  self?: string;
  /** S1c（古いランの写しには無い）: 公開された特別な場所・このランで報告した特別な場所（深さと座標）・前の取り込みから新しく自分の火を使った者（キャンプの知らせ） */
  spots?: SeasonSpot[];
  reportedSpots?: { depth: number; x: number; y: number }[];
  fireNews?: { depth: number; x: number; y: number; names: string[] }[];
  /**
   * S3（§25.2。古いランの写しには無い）: 取り込んだ共有層の補給の品・このランで預けた品・このランで取った品・
   * 自分の預けた品をほかの者が取ったもの（取り込みの写し）・前の取り込みから新しく取られたもの（キャンプの知らせ）
   */
  supplies?: SeasonSupply[];
  deposited?: SeasonDeposit[];
  /** このランで預けた品のうち、もう共有層に載ったものの番号（取り込みの写し。取られて supplies から消えた後も） */
  depositsPublished?: number[];
  taken?: SeasonTaken[];
  mineTaken?: SeasonSupplyTaken[];
  supplyNews?: SeasonSupplyTaken[];
  /** S4（§35.5。古いランの写しには無い）: 討伐の記録（節目ごとに、最初の 1 件といちばん少ない被害の 1 件） */
  slays?: SeasonSlay[];
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
  /** 倒した節目の大守護者の深さ（V3-3 §3.2） */
  milestones?: { cleared: number[] };
  /** シーズンの写し（S0。ソロだけなので、ランに 1 つ。取り込みは season_synced だけ） */
  season?: SeasonState;
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
  /** 継承したラン（V3-7 §7.3） */
  legacy?: boolean;
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

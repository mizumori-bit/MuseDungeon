// WebSocket（/ws）と HTTP API のメッセージ型。サーバーとクライアントの契約。
// 仕様: docs/PROTOCOL.md §7, §8
import type { ActionError, Command, CommandRecord } from './commands';
import type { GameEvent } from './events';
import type { PerceivedEvent } from './filter';
import type { TurnBlock } from './turn';
import type { Controller, DirectiveItem, ExpeditionBrief, ExpeditionEndReason, Locale, Names, Objective, ObjectiveType, PlayerId, PlayerState, RunSummary, SeasonSlay, World } from './types';
import type { PlayerView } from './view';
import type { DirectiveUndecided, Observation } from './observation';
import type { OwnerPace } from './directive';
import type { ProfileRecords } from './profile';

export type SpectatorPolicy = 'omniscient' | 'follow_only' | 'delayed';

// ---- WS: client → server ----
export type ClientMsg =
  | { t: 'hello'; role: 'player'; runId: string; token: string }
  /** profileToken（S3。SEASON.md §25.1・PROTOCOL §9.7）: 開催中のシーズンのランを観戦する参加者の、招かれたプロフィールのトークン */
  | { t: 'hello'; role: 'spectator'; runId: string; mode: 'director' | 'follow'; follow?: PlayerId; fromSeq?: number; profileToken?: string }
  | { t: 'command'; command: Command; expectSeq?: number; thought?: string }
  | { t: 'query'; id: string; kind: 'look' | 'recall' | 'map' | 'inventory' | 'messages' | 'observation'; args?: Record<string, unknown> };

/**
 * 観戦に送る活動の記録の引数から、トークンを除く（S7。SEASON.md §52.1 の 1。§27・§28 の漏れをくり返さない）: 名前に token を含む引数は、
 * どの深さでも落とし、知っているトークンの値（8 字以上）を含む文字列は伏せる。サーバーが記録を作るときと、画面が出すときの両方で通す
 */
export function stripTokenArgs(v: unknown, secrets: readonly unknown[] = []): unknown {
  const sec = secrets.filter((x): x is string => typeof x === 'string' && x.length >= 8);
  const walk = (x: unknown, depth: number): unknown => {
    if (typeof x === 'string') return sec.some((t) => x.includes(t)) ? '••••' : x;
    if (depth > 6 || x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, y] of Object.entries(x as Record<string, unknown>)) if (!/token/i.test(k)) out[k] = walk(y, depth + 1);
    return out;
  };
  return walk(v, 0);
}

/** 観戦の「直前の命令」に出さない引数（S7）: 考え・トークン・表示の引数・前提の seq・断った呼び出しの知らない名前 */
const BRIEF_SKIP: ReadonlySet<string> = new Set(['thought', 'player_token', 'profile_token', 'expect_seq', 'map', 'inventory', 'status_line', 'unknown_args']);

/** 照会・設定のツール（手番を使わず、盤面を動かさない）。観戦の「直前の命令」は、これ以外の呼び出し（S7） */
export const INFO_TOOLS: ReadonlySet<string> = new Set([
  'get_rules', 'list_runs', 'new_run', 'join_run', 'resume_run', 'records', 'profile', 'expedition', 'review', 'observe', 'wait_for_turn', 'set_options',
  'look', 'get_map', 'inventory', 'recall', 'get_messages', 'notes', 'say',
]);

/**
 * 観戦の「思考」の欄に、思考の代わりに出す直前の命令の文（S7。SEASON.md §52.1 の 1）: ツールの名前と、要る引数（thought・トークン・表示の引数は出さない）。
 * 例: explore { toward: "sense" }
 */
export function commandBrief(a: Pick<AgentActivity, 'tool' | 'args'>): string {
  const args = stripTokenArgs(a.args ?? {}) as Record<string, unknown>;
  const parts = Object.entries(args).filter(([k, v]) => !BRIEF_SKIP.has(k) && v !== undefined).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return parts.length ? `${a.tool} { ${parts.join(', ')} }` : a.tool;
}

/** AI パネル用: MCP ツール呼び出しの記録（観戦にのみ流す。ゲームに影響しない） */
export interface AgentActivity {
  playerId: PlayerId;
  seq: number;
  tool: string;
  args: Record<string, unknown>;
  /** ツールが返した観測テキスト（content の text） */
  text: string;
  wall: number;
}

// ---- WS: server → client ----
export type ServerMsg =
  | { t: 'welcome'; role: 'player' | 'spectator'; runId: string; contentVersion: string; playerId?: PlayerId; policy: SpectatorPolicy; mode?: 'director' | 'follow' }
  /** player / follow_only の追従観戦: 状態が進むたび */
  | { t: 'view'; view: PlayerView; events: PerceivedEvent[] }
  /** spectator: 接続時（secret の seed/rng 除去済み） */
  | { t: 'snapshot'; seq: number; world: World }
  /** spectator: 逐次（内部イベント除去済み） */
  | { t: 'events'; events: GameEvent[] }
  | { t: 'agent'; activity: AgentActivity }
  | { t: 'macro'; playerId: PlayerId; kind: string; state: 'running' | 'stopped'; steps: number; reason?: string }
  | { t: 'error'; error: ActionError; valid_actions?: string[] }
  | { t: 'result'; id: string; data: unknown }
  | { t: 'ended'; summary: RunSummary };

// ---- HTTP ----
export interface RunListingPlayer {
  id: PlayerId;
  name: string;
  classId: string;
  controller: Controller;
  state: PlayerState;
  depth: number | null;
  level: number;
  /** 進行中のシーズンのラン（S2a）: 状態・階・レベルを伏せた（state・depth・level は意味を持たない） */
  hidden?: true;
}

export interface RunListing {
  runId: string;
  status: 'active' | 'ended';
  mode: 'solo' | 'coop';
  /** シーズンのラン（S0）: シーズンの ID */
  season?: string;
  createdAt: number;
  updatedAt: number;
  seq: number;
  live: boolean;
  joinable: boolean;
  players: RunListingPlayer[];
  summary?: RunSummary;
  /** 遠征の一覧（遠征単位のリプレイ選択用） */
  expeditions?: ExpeditionBrief[];
  /** サーバーの起動時に復旧できなかった（理由の 1 行と時刻。V4-1m §37.1） */
  recoveryFailed?: { reason: string; at: number };
}

export interface RunMetaFile {
  runId: string;
  createdAt: number;
  endedAt?: number;
  mode: 'solo' | 'coop';
  contentVersion: string;
  engineVersion: string;
  eventVersion: number;
  options: { turnTimeoutMs: number | null; maxPlayers: number };
  status: 'active' | 'ended';
  players: { id: PlayerId; name: string; classId: string; controller: Controller; joinedSeq: number }[];
  /** 終了後のみ（シード共有用）。シーズンのランは出さない（S0） */
  seed?: string;
  lastSeq?: number;
  /** シーズンのラン（S0）: シーズンの ID */
  season?: string;
}

export type MarkerType = 'join' | 'floor' | 'level_up' | 'kill' | 'near_death' | 'death' | 'thought' | 'end'
  | 'expedition_start' | 'objective' | 'expedition_end';
export interface Marker { seq: number; type: MarkerType; label: string; player?: PlayerId }
export interface RunIndex { runId: string; lastSeq: number; markers: Marker[]; keyframes: number[]; expeditions?: ExpeditionBrief[] }

export interface LeaderboardEntry {
  runId: string;
  playerId: PlayerId;
  name: string;
  classId: string;
  controller: Controller;
  deepest: number;
  kills: number;
  level: number;
  turns: number;
  score: number;
  deathCause: string | null;
  endedAt: number;
  /** 達成した遠征の数 */
  expeditions: number;
  /** ラン終了前（キャンプ中）の記録か */
  ongoing: boolean;
  /** 1: 旧スコア（深度×1000 ほか）、2: 確定点。版ごとに別の表として扱う */
  scoreVersion: 1 | 2;
  /** 継承したラン（V3-7 §7.3: 表を分ける） */
  legacy?: boolean;
}

export type ObjectiveChoice = 'auto' | ObjectiveType;

export interface NewRunRequest {
  name: string;
  classId?: string;
  mode?: 'solo' | 'coop';
  seed?: string;
  locale?: Locale;
  controller?: Controller;
  /** 最初の遠征の目的（既定 auto = 最初の候補） */
  objective?: ObjectiveChoice;
  /** プロフィール（V3-7 §7.1）。省くと新しく作り、応答に profileToken を返す */
  profileToken?: string;
  /** false で継承しない（V3-7 §7.3。比較用。サーバーの legacyPolicy が off なら常に継承しない） */
  legacy?: boolean;
  /** シーズンの ID（S0。PROTOCOL §9.1）。シーズンのシードでソロ、Lv1 のキャンプから。seed・mode・objective・legacy は使わない */
  season?: string;
  /**
   * 冒険者 1 人に続きは 1 つ（S9。SEASON.md §58.3）: そのプロフィールに続きを遊べるランがあれば、new_run は run_in_progress で断られる。
   * true なら、前のランを引退（retire と同じ）で終わらせてから、新しいランを始める（確定した点と記録は残る）
   */
  endPrevious?: boolean;
}

/**
 * new_run で、プロフィールの握る項目を引き継いだ（S9 §58.3）。hold: 入れた握る項目（持ち主の口の set_directive として記録に残る）、
 * objectiveIgnored: 最初の遠征の目的が渡されていたが、キャンプから始めた（持ち主の支度を待つ）
 */
export interface InheritedHold { hold: DirectiveItem[]; objectiveIgnored: boolean }

/**
 * プロフィールが招かれたシーズン（S10。SEASON.md §58.4 の拠点の冒険者の札。GET /api/profile の seasons。そのプロフィールのトークンでだけ返る）。
 * name: 招いたときの表示名（順位の表の名前）。used: 今までに使った予算（ランをまたいで。キャンプでの公開の値ではなく今の値）。
 * runs: 始めたランの数。died: このシーズンで倒れたことがある。status はシーズンの一覧と同じ
 */
export interface ProfileSeasonEntry {
  id: string; seasonName: string; name: string; status: 'open' | 'ended' | 'final';
  budget: number; used: number; runs: number; died: boolean;
  /** 終わっていないそのシーズンのランが、サーバーの起動時に復旧できなかった（S10a。V4-1m §37.1 の recoveryFailed。運用者に知らせる） */
  failed?: true;
}

/** シーズンの一覧の 1 行（S0。GET /api/seasons・list_runs の seasons） */
/** participants: 1 回でもランを始めた参加者の数、invited: 招いた数（S0a）。openedAt: 開いた時刻（S16d。一覧の並びに使う。記録に無い古いシーズンは無い） */
export interface SeasonListing { id: string; name: string; budget: number; endsAt: number; openedAt?: number; status: 'open' | 'ended' | 'final'; participants: number; invited: number }

/** シーズンの順位の表の 1 行（S0。GET /api/seasons/:id。公開された階段の位置は入れない） */
export interface SeasonStandingRow {
  name: string; runs: number; used: number; died: boolean;
  adventure: { value: number; rank: number };
  contribution: { value: number; rank: number };
  survival: { value: number; rank: number } | null;
  /** 支援賞（S1）: 自分の火がほかの参加者に使われた回数。古い記録には無い */
  support?: { value: number; rank: number };
  /** 確定した点の合計（S2 §18.3。倒れた者も。火の費用を引いた後。生還賞の数字と同じ式）。古い記録には無い（HTTP は参加者の記録から埋める） */
  banked?: number;
  /** その参加者の称号（S2 §18.2。確定したシーズンのすべてで付いたもの。HTTP の応答で付ける） */
  titles?: SeasonTitle[];
  /** 指図の印（S8。SEASON.md §54.6）: そのシーズンで、持ち主の口から決めた項目（キャンプで更新）。順位は分けない。決めていなければ無い */
  directed?: DirectiveItem[];
  /** その参加者のシーズンのラン（S8 §54.7。HTTP の応答で付ける。確定したシーズンと、同じ機械からの接続だけ） */
  runIds?: string[];
}

/**
 * シーズンの称号（S2。SEASON.md §18.2）。表示だけで、力は足さない。name はデータ（content の seasonTitles）から確定のときに作った名前。
 * kind: award は賞の 1 位（award）、first_warden は節目の大守護者の初討伐（depth）
 */
export interface SeasonTitle {
  id: string;
  season: string;
  seasonName: string;
  kind: 'award' | 'first_warden';
  award?: 'adventure' | 'contribution' | 'survival' | 'support';
  depth?: number;
  name: { ja: string; en: string };
  /** 付いた時刻（シーズンの確定） */
  at: number;
}

/**
 * 坑の断面の 1 行（S2 §18.3）: 階ごとに、最深の印・公開された階段と特別な場所（報告した者）・共有層に載った火（置いた者・使われた回数）。
 * 位置は出さない（階だけ）。進行中のシーズンでも、順位の表に出ているもの（最深）と、もう公開されているものだけ
 */
export interface SeasonSectionRow {
  depth: number;
  /** その階が最深の参加者（順位の表の冒険賞の値） */
  deepest: string[];
  stairs: { by: string } | null;
  spots: { kind: string; by: string }[];
  fires: { by: string; uses: number }[];
  /** 補給の置き場（S3 §25.2）: 共有層に載って、まだだれも取っていない品の数（場所と種類は出さない）。S3 より前の応答には無い */
  supplies?: number;
  /** 節目の大守護者を最初に倒した者（倒した後にキャンプへ着いた順。確定したシーズンだけ） */
  firstWarden?: string;
}

/** 確定した結果（S2 §18.3。GET /api/seasons/:id の result） */
export interface SeasonResultView {
  finalizedAt: number;
  reason: 'all_back' | 'grace_over' | 'operator';
  winners: Record<'adventure' | 'contribution' | 'survival' | 'support', { name: string; value: number }[]>;
  standings: SeasonStandingRow[];
  /** このシーズンで付いた称号（holder: 付いた参加者の表示名）。称号の無い古い結果には無い */
  titles?: (SeasonTitle & { holder: string })[];
  /** 節目の大守護者の初討伐（深さの順） */
  deeds?: { depth: number; name: string }[];
}

/**
 * GET /api/seasons/:id/watch（S3。SEASON.md §25.1・PROTOCOL §9.7）: いま観戦できる、そのシーズンの進行中のラン。
 * local: サーバーと同じ機械からの接続、final: シーズンの結果が確定している（どちらも、すべてのランを見られる）。name は順位の表の名前
 */
export interface SeasonWatchResponse {
  local: boolean; final: boolean;
  /** expeditionsEnded（S17）: そのランの、見ている者が見返せる冒険者の、終わった遠征の数（シーズンの表の「見返す」を出すか） */
  runs: { runId: string; name: string; expeditionsEnded?: number }[];
  /**
   * 終わった（引退した・倒れた）ランのうち、見ている者が、冒険者の目線で見返せるもの（S17a の G。開催中のシーズンで、持ち主の鍵を示したときだけ。
   * 同じ PC から・確定の後は、巻き戻しで全体を見返せるので入れない）。expeditionsEnded: 見返せる遠征の数
   */
  review?: { runId: string; expeditionsEnded: number }[];
}

// ---- 見返し（S17。SEASON.md §70.6。PROTOCOL §9.16）----
/**
 * 見返せる遠征（終わったもの。その場の観戦が、もう見せた所まで）。中身は、そのプレイヤーの見え方（PlayerView の expedition）に出ているものだけ。
 * banked: その遠征で、そのプレイヤーが確定した点（分からなければ null）
 */
export interface ReviewExpedition {
  no: number; objective: Objective; status: 'in_progress' | 'objective_complete' | 'ended'; endReason: ExpeditionEndReason | null;
  startSeq: number; endSeq: number; deepest: number | null; banked: number | null;
}
/**
 * GET /api/runs/:id/review（S17）: 見返せる遠征の一覧（古い順）と、今の冒険者の居場所（見返している間に、その場で起きていることの小さい知らせ）。
 * 門は、その場の観戦と同じ（そのランの持ち主の鍵か、サーバーと同じ PC から。シーズンでないラン・確定したシーズンのランは、だれでも）
 */
export interface ReviewListResponse {
  runId: string; playerId: PlayerId; name: string;
  season: string | null; final: boolean;
  expeditions: ReviewExpedition[];
  /**
   * 今（見返している間の知らせ）: state は冒険者の状態。expedition は、いま進めている遠征の番号（迷宮の中のときだけ）。
   * null（S17a）: その場の観戦が遅らせて見せている（遅らせる観戦 delayed の、進行中のラン）ので、今の状態は出さない
   */
  now: { state: 'at_camp' | 'in_dungeon' | 'dead' | 'ended'; expedition: number | null } | null;
  /** 1 回の求めで返すコマの上限 */
  pageFrames: number;
}
/** 見返しの 1 コマ（その場の観戦の追従だけの枠 `{ t: 'view' }` と同じ中身: その時点の見え方と、前のコマより後に届いた出来事） */
export interface ReviewFrame { view: PlayerView; events: PerceivedEvent[] }
/**
 * GET /api/runs/:id/review/:no（S17）: 遠征 1 つのコマ。after を省いた最初の求めは、遠征を始める前（キャンプ）の見え方を最初のコマ（出来事なし。
 * その場の観戦の、つないだ直後の枠と同じ）にする。agent: その間の AI の呼び出しの記録（命令の記録から。考え・命令・引数。応答の文は記録に無いので空）。
 * next: 続きがあれば、次の求めの after（最後のコマの見え方の seq）。無ければ null
 */
export interface ReviewPageResponse {
  runId: string; playerId: PlayerId; no: number;
  frames: ReviewFrame[];
  agent: AgentActivity[];
  next: number | null;
  range: { startSeq: number; endSeq: number };
}

// ---- 持ち主の口（S8。SEASON.md §54.5。PROTOCOL §9.14）----
/**
 * GET /api/owner/runs の 1 行: 持ち主と認められた、進行中のラン（このブラウザのプロフィールのトークン、か同じ機械から）。
 * eligible: 指図を出せるラン（ソロで、人間が自分で遊んでいない）。waiting: AI がキャンプで、持ち主が次の遠征を始めるのを待っている
 */
export interface OwnerRunRow {
  /** season.participant: そのシーズンでの自分の表示名（順位の表の名前。招いたときの名前） */
  runId: string; playerId: PlayerId; name: string; classId: string; season?: { id: string; name: string; participant?: string };
  status: 'at_camp' | 'in_dungeon' | 'ended'; eligible: boolean; waiting: boolean;
  hold: DirectiveItem[]; message: string;
  level: number; hp: number; maxHp: number; depth: number | null; banked: number; budgetLeft?: number; budgetLimit?: number; updatedAt: number;
  /** 自分のラン（S8a）: 送ったプロフィールのトークンのプレイヤー。false は、同じ機械からだけで認めた（運用者として） */
  mine?: boolean;
  /** 持ち主が、まだ決めていないもの（S9a。SEASON.md §57.3 の 2。AI の観測の self.directive.undecided と同じ）。無ければ無い */
  undecided?: DirectiveUndecided;
  /** 支度の札（S9。SEASON.md §58.1。握っている項目があるときだけ。objective: 持ち主が選んだ次の遠征） */
  prep?: { state: 'pending' | 'ready'; objective?: number | 'endless' };
  /** AI の希望の数（S9 §58.2。今も成り立つものだけ。中身は …/owner/view の view.directive.wishes） */
  wishes?: number;
  /** AI との行き来（S9 §58.1。サーバーの控え。World に入れない）。lastCallAgoS: AI が最後に呼び出してからの秒数（このサーバーの起動の後に無ければ null）。waitingNow: いま wait_for_turn で支度を待っている */
  ai?: { lastCallAgoS: number | null; waitingNow: boolean };
  /**
   * 続きを遊べるか（S10a。冒険者 1 人に続きは 1 つの数え方 SessionManager.continuable と同じ判定）。oldVersion: このサーバーと違う版の engine で始まったラン
   * （続きは遊べない。記録は見返せる）
   */
  continuable?: boolean;
  oldVersion?: true;
  /** 進め方の希望（S14。SEASON.md §65.4 の 2。プロフィールの控え。指図を出せる冒険者だけ。無ければ self） */
  pace?: OwnerPace;
  /** 終わった遠征の数（S14。このプレイヤーが参加して、終わったもの。拠点の「続けて遊ばせる」が、回数を数える） */
  expeditionsEnded?: number;
}
export interface OwnerRunsResponse { local: boolean; runs: OwnerRunRow[] }
/** GET /api/runs/:id/owner/view・POST …/owner/directive・…/owner/act の応答。result: POST の結果（断りなら error） */
export interface OwnerViewResponse {
  runId: string; playerId: PlayerId; name: string; eligible: boolean; reason?: string; waiting: boolean;
  /** AI との行き来（S9 §58.1。OwnerRunRow.ai と同じ） */
  ai?: { lastCallAgoS: number | null; waitingNow: boolean };
  /** 続きを遊べるか・違う版で始まったラン（S10a。OwnerRunRow と同じ） */
  continuable?: boolean;
  oldVersion?: true;
  /** 進め方の希望（S14。OwnerRunRow と同じ） */
  pace?: OwnerPace;
  view: PlayerView; observation: Observation; text: string;
  result?: { ok: true } | { ok: false; error: ActionError };
}

/** GET /api/seasons/:id（S0 §9.8・S2 §18.3） */
export interface SeasonStandingsResponse {
  season: SeasonListing;
  standings: SeasonStandingRow[];
  result?: SeasonResultView;
  section: SeasonSectionRow[];
  /**
   * 討伐の記録（S4。SEASON.md §35.5）: 節目ごとに、最初の 1 件といちばん少ない被害の 1 件。位置は無い。記録が無ければ無い。
   * 開催中のシーズンでは、同じ機械からの接続にだけ（S4a §46）。ほかは slaysBrief だけ（中身はシーズンが確定してから）
   */
  slays?: SeasonSlay[];
  slaysBrief?: SeasonSlayBrief[];
}

/**
 * 開催中の外向けの討伐の記録（S4a §46）: 節目・倒した者の名前・レベル・職業・その階で載った順だけ。
 * firstKill（S4b）: 初討伐の称号の持ち主（倒した後に最初にキャンプへ着いた者）の行。載った順の 1 番目とは限らない
 */
export interface SeasonSlayBrief { depth: number; warden: Names; by: string; level: number; classId: string; order: number; firstKill?: true }

// ---- ターンフィード（GET /api/player/feed、SSE） ----
export type FeedEvent =
  | { type: 'hello'; runId: string; playerId: PlayerId; seq: number; turn: TurnBlock }
  /** 手番が来た（マクロ実行中は送らない） */
  | { type: 'turn'; runId: string; playerId: PlayerId; seq: number; turn: TurnBlock; observation_text: string }
  /** 手番のまま一定時間入力が無い */
  | { type: 'idle'; runId: string; playerId: PlayerId; seq: number; seconds: number; turn: TurnBlock }
  /** 遠征またはランが終わった（scope で区別） */
  | { type: 'ended'; runId: string; playerId: PlayerId; seq: number; scope: 'expedition' | 'run'; turn: TurnBlock; text: string; summary: RunSummary | null };
export interface JoinRunRequest { name: string; classId?: string; locale?: Locale; controller?: Controller; profileToken?: string; legacy?: boolean }
/** profileToken は新しく作ったときだけ（渡したトークンは返さない） */
export interface JoinedResponse { runId: string; playerId: PlayerId; token: string; profileId?: string; profileToken?: string }

/**
 * 拠点の運用者の口（S12b。SEASON.md §63.7。PROTOCOL §9.15）: サーバーと同じ PC からだけ。鍵（プロフィールのトークン）は、冒険者を足した応答の 1 回だけ。
 * 名簿の 1 行: name 招いたときの表示名・kind 拠点で足したときの種類（無ければ、いちばん新しいランの操作の種類。分からなければ null）・
 * runs 始めたランの数・used 使った予算・died このシーズンで倒れたことがある・runId いちばん新しいランの ID・failed 終わっていないランが起動時に読み込めなかった
 */
export interface OpsRosterEntry {
  name: string; profileId: string; kind: 'ai' | 'human' | null;
  runs: number; used: number; budget: number; died: boolean; runId: string | null; failed?: true;
}
/**
 * GET /api/ops/roster: season 今のシーズン（開催中。無ければ null）とその名簿。pending: 確定していない、ほかのシーズン（終わりの時刻を過ぎて、結果を待っている）。
 * canOpen: 新しいシーズンを始められる（確定していないシーズンも、記録が読めないシーズンも無い）。next: そのときの既定（ID・名前の数・名前・日数・予算）。
 * broken: 記録が読めないシーズンがある
 */
export interface OpsRosterResponse {
  season: { id: string; name: string; budget: number; endsAt: number } | null;
  roster: OpsRosterEntry[];
  pending: { id: string; name: string }[];
  canOpen: boolean;
  next?: { id: string; number: number; name: string; days: number; budget: number };
  broken?: true;
}
/** POST /api/ops/season の応答（シードは入れない） */
export interface OpsSeasonOpened { season: { id: string; name: string; budget: number; endsAt: number } }
/**
 * POST /api/ops/adventurers の応答: profileToken は、この 1 回だけ（名簿・ほかの口からは読めない）。
 * 自分で潜る（kind human）ときは、POST /api/runs と同じ runId・playerId・token も
 */
export interface OpsAdventurerAdded {
  seasonId: string; name: string; profileId: string; kind: 'ai' | 'human'; profileToken: string;
  runId?: string; playerId?: PlayerId; token?: string;
}
/** POST /api/ops/enroll の応答。already: もう招かれていた */
export interface OpsEnrolled { seasonId: string; name: string; profileId: string; already?: true }
/**
 * GET /api/ops/codex の 1 人分（S16b。SEASON.md §70.4 の 4）: そのサーバーのプロフィールの、図鑑と実績だけ（`GET /api/profile/records` の `codex`・`feats` と同じ形）。
 * 鍵（トークンもそのハッシュも）・シード・ランの一覧・最高到達などの 1 人ずつの記録は入れない
 */
export interface OpsCodexProfile { profileId: string; name: string; codex: ProfileRecords['codex']; feats: ProfileRecords['feats'] }
/** GET /api/ops/codex の応答（サーバーと同じ PC からだけ）。図鑑か実績が 1 つでもあるプロフィールだけ。プロフィールの作られた順 */
export interface OpsCodexResponse { profiles: OpsCodexProfile[] }

/** /api/runs/:id/commands の 1 行 */
export type CommandLine = CommandRecord;

export function isClientMsg(v: unknown): v is ClientMsg {
  return !!v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string';
}

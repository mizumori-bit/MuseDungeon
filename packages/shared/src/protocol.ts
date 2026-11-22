// WebSocket（/ws）と HTTP API のメッセージ型。サーバーとクライアントの契約。
// 仕様: docs/PROTOCOL.md §7, §8
import type { ActionError, Command, CommandRecord } from './commands';
import type { GameEvent } from './events';
import type { PerceivedEvent } from './filter';
import type { TurnBlock } from './turn';
import type { Controller, ExpeditionBrief, Locale, ObjectiveType, PlayerId, PlayerState, RunSummary, World } from './types';
import type { PlayerView } from './view';

export type SpectatorPolicy = 'omniscient' | 'follow_only' | 'delayed';

// ---- WS: client → server ----
export type ClientMsg =
  | { t: 'hello'; role: 'player'; runId: string; token: string }
  /** profileToken（S3。SEASON.md §25.1・PROTOCOL §9.7）: 開催中のシーズンのランを観戦する参加者の、招かれたプロフィールのトークン */
  | { t: 'hello'; role: 'spectator'; runId: string; mode: 'director' | 'follow'; follow?: PlayerId; fromSeq?: number; profileToken?: string }
  | { t: 'command'; command: Command; expectSeq?: number; thought?: string }
  | { t: 'query'; id: string; kind: 'look' | 'recall' | 'map' | 'inventory' | 'messages' | 'observation'; args?: Record<string, unknown> };

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
}

/** シーズンの一覧の 1 行（S0。GET /api/seasons・list_runs の seasons） */
/** participants: 1 回でもランを始めた参加者の数、invited: 招いた数（S0a） */
export interface SeasonListing { id: string; name: string; budget: number; endsAt: number; status: 'open' | 'ended' | 'final'; participants: number; invited: number }

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
export interface SeasonWatchResponse { local: boolean; final: boolean; runs: { runId: string; name: string }[] }

/** GET /api/seasons/:id（S0 §9.8・S2 §18.3） */
export interface SeasonStandingsResponse {
  season: SeasonListing;
  standings: SeasonStandingRow[];
  result?: SeasonResultView;
  section: SeasonSectionRow[];
}

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

/** /api/runs/:id/commands の 1 行 */
export type CommandLine = CommandRecord;

export function isClientMsg(v: unknown): v is ClientMsg {
  return !!v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string';
}

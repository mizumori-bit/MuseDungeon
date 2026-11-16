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
  | { t: 'hello'; role: 'spectator'; runId: string; mode: 'director' | 'follow'; follow?: PlayerId; fromSeq?: number }
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
}

export interface RunListing {
  runId: string;
  status: 'active' | 'ended';
  mode: 'solo' | 'coop';
  createdAt: number;
  updatedAt: number;
  seq: number;
  live: boolean;
  joinable: boolean;
  players: RunListingPlayer[];
  summary?: RunSummary;
  /** 遠征の一覧（遠征単位のリプレイ選択用） */
  expeditions?: ExpeditionBrief[];
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
  /** 終了後のみ（シード共有用） */
  seed?: string;
  lastSeq?: number;
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
export interface JoinRunRequest { name: string; classId?: string; locale?: Locale; controller?: Controller }
export interface JoinedResponse { runId: string; playerId: PlayerId; token: string }

/** /api/runs/:id/commands の 1 行 */
export type CommandLine = CommandRecord;

export function isClientMsg(v: unknown): v is ClientMsg {
  return !!v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string';
}

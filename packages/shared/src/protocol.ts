// WebSocket（/ws）と HTTP API のメッセージ型。サーバーとクライアントの契約。
// 仕様: docs/PROTOCOL.md §7, §8
import type { ActionError, Command, CommandRecord } from './commands';
import type { GameEvent } from './events';
import type { PerceivedEvent } from './filter';
import type { Controller, Locale, PlayerId, RunSummary, World } from './types';
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
  state: 'alive' | 'dead' | 'left';
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

export type MarkerType = 'join' | 'floor' | 'level_up' | 'kill' | 'near_death' | 'death' | 'thought' | 'end';
export interface Marker { seq: number; type: MarkerType; label: string; player?: PlayerId }
export interface RunIndex { runId: string; lastSeq: number; markers: Marker[]; keyframes: number[] }

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
}

export interface NewRunRequest {
  name: string;
  classId?: string;
  mode?: 'solo' | 'coop';
  seed?: string;
  locale?: Locale;
  controller?: Controller;
}
export interface JoinRunRequest { name: string; classId?: string; locale?: Locale; controller?: Controller }
export interface JoinedResponse { runId: string; playerId: PlayerId; token: string }

/** /api/runs/:id/commands の 1 行 */
export type CommandLine = CommandRecord;

export function isClientMsg(v: unknown): v is ClientMsg {
  return !!v && typeof v === 'object' && typeof (v as { t?: unknown }).t === 'string';
}

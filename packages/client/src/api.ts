// HTTP API（docs/PROTOCOL.md §8）。失敗は ApiError で投げ、画面側でバナー表示する。
import type {
  ActionError, Catalog, CommandRecord, GameEvent, JoinedResponse, JoinRunRequest, LeaderboardEntry,
  NewRunRequest, RunIndex, RunListing, RunMetaFile, SpectatorPolicy, World,
} from '@muse/shared';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly error: ActionError | null) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError(`サーバーに接続できません (${(e as Error).message})`, 0, null);
  }
  if (!res.ok) {
    let err: ActionError | null = null;
    try {
      const body = (await res.json()) as { error?: ActionError };
      err = body.error ?? null;
    } catch {
      /* 本文が JSON でない */
    }
    throw new ApiError(err ? `${err.message}${err.hint ? ` — ${err.hint}` : ''}` : `HTTP ${res.status} ${path}`, res.status, err);
  }
  return res;
}

async function getJSON<T>(path: string): Promise<T> {
  return (await (await request(path)).json()) as T;
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as T;
}

async function getJSONL<T>(path: string): Promise<T[]> {
  const text = await (await request(path)).text();
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s) as T);
    } catch {
      /* 壊れた行は飛ばす */
    }
  }
  return out;
}

const enc = encodeURIComponent;

export const api = {
  runs: () => getJSON<{ runs: RunListing[] }>('/api/runs').then((r) => r.runs ?? []),
  newRun: (req: NewRunRequest) => postJSON<JoinedResponse>('/api/runs', req),
  joinRun: (runId: string, req: JoinRunRequest) => postJSON<JoinedResponse>(`/api/runs/${enc(runId)}/join`, req),
  meta: (runId: string) => getJSON<RunMetaFile>(`/api/runs/${enc(runId)}/meta`),
  events: (runId: string, from: number, to: number) => getJSONL<GameEvent>(`/api/runs/${enc(runId)}/events?from=${from}&to=${to}`),
  keyframes: (runId: string) => getJSON<{ keyframes: number[] }>(`/api/runs/${enc(runId)}/keyframes`).then((r) => r.keyframes ?? []),
  keyframe: (runId: string, seq: number) => getJSON<World>(`/api/runs/${enc(runId)}/keyframes/${seq}`),
  index: (runId: string) => getJSON<RunIndex>(`/api/runs/${enc(runId)}/index`),
  commands: (runId: string) => getJSONL<CommandRecord>(`/api/runs/${enc(runId)}/commands`),
  leaderboard: () => getJSON<{ entries: LeaderboardEntry[] }>('/api/leaderboard').then((r) => r.entries ?? []),
  config: () => getJSON<{ spectatorPolicy: SpectatorPolicy }>('/api/config'),
};

let catalogPromise: Promise<Catalog> | null = null;

/** 公開カタログ（起動時に 1 回だけ取得） */
export function getCatalog(): Promise<Catalog> {
  if (!catalogPromise) {
    catalogPromise = getJSON<Catalog>('/api/content/catalog').catch((e) => {
      catalogPromise = null;
      throw e;
    });
  }
  return catalogPromise;
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

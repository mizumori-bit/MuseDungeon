// HTTP API（docs/PROTOCOL.md §8）。失敗は ApiError で投げ、画面側でバナー表示する。
import type {
  ActionError, Catalog, Command, CommandRecord, DirectiveItem, GameEvent, JoinedResponse, JoinRunRequest, LeaderboardEntry,
  NewRunRequest, OwnerRunsResponse, OwnerViewResponse, ProfileRecords, RunIndex, RunListing, RunMetaFile, SeasonListing, SeasonStandingsResponse, SeasonWatchResponse,
  SpectatorPolicy, World,
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
const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });

/**
 * 持ち主の口（S8。SEASON.md §54.5）: プロフィールのトークンは Authorization の見出しでだけ渡す（URL・本文・画面・console に出さない）。
 * トークンが無ければ見出しも付けない（同じ機械からの接続なら、それで通る）
 */
async function ownerGet<T>(path: string, token?: string): Promise<T> {
  return (await (await request(path, token ? bearer(token) : undefined)).json()) as T;
}
async function ownerPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return (await (await request(path, { method: 'POST', headers, body: JSON.stringify(body) })).json()) as T;
}

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
  /** シーズン（S0。PROTOCOL §9.8）: 一覧と、1 つのシーズンの順位の表 */
  seasons: () => getJSON<{ seasons: SeasonListing[] }>('/api/seasons').then((r) => r.seasons ?? []),
  /** 順位の表・確定した結果・坑の断面（S2 §18.3） */
  season: (id: string) => getJSON<SeasonStandingsResponse>(`/api/seasons/${enc(id)}`),
  /** いま観戦できる進行中のラン（S3 §25.1）。参加者のトークンは見出しで渡す（URL に出さない） */
  seasonWatch: async (id: string, profileToken?: string) => (await (await request(`/api/seasons/${enc(id)}/watch`, profileToken ? bearer(profileToken) : undefined)).json()) as SeasonWatchResponse,
  config: () => getJSON<{ spectatorPolicy: SpectatorPolicy }>('/api/config'),
  /** プロフィールの記録（V3-7 §7.2。MCP の records と同じ中身） */
  /** プロフィールの表示名・要約・称号（S2 §18.2。MCP の profile と同じ中身） */
  profile: async (profileToken: string, locale: string) => (await (await request(`/api/profile?locale=${enc(locale)}`, bearer(profileToken))).json()) as { name: string; summary: string; titles?: { name: string; season: string; season_name: string }[] },
  records: async (profileToken: string, locale: string) => (await (await request(`/api/profile/records?locale=${enc(locale)}`, bearer(profileToken))).json()) as { text: string; records: ProfileRecords },
  /** 持ち主と認められた進行中のラン（S8 §54.7 の「出撃」）。token: プロフィールのトークン（無ければ見出しを付けない） */
  ownerRuns: (token?: string) => ownerGet<OwnerRunsResponse>('/api/owner/runs', token),
  /** 持ち主の見るもの（そのプレイヤーの PlayerView と、AI に届くのと同じ観測）。認められなければ 403 */
  ownerView: (runId: string, token?: string) => ownerGet<OwnerViewResponse>(`/api/runs/${enc(runId)}/owner/view`, token),
  /** 指図（握る項目と伝言）。キャンプでだけ通る。断りは result.error */
  ownerDirective: (runId: string, d: { hold: DirectiveItem[]; message: string }, token?: string) => ownerPost<OwnerViewResponse>(`/api/runs/${enc(runId)}/owner/directive`, d, token),
  /** 握った項目の命令（start_expedition・equip・unequip・choose_perk・choose_boon）。断りは result.error */
  ownerAct: (runId: string, command: Command, token?: string) => ownerPost<OwnerViewResponse>(`/api/runs/${enc(runId)}/owner/act`, { command }, token),
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

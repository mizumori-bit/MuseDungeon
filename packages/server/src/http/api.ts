// HTTP: Web クライアント配信、REST API（ReplayPort）、/mcp、/ws へのアップグレード。
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import type { ActionError, Controller, GameEvent, JoinRunRequest, NewRunRequest, OwnerViewResponse, World } from '@muse/shared';
import { actionError, stripSecret } from '@muse/shared';
import { ownerAct, ownerView } from '../session/OwnerPort';
import type { ServerConfig } from '../config';
import { McpHttpHandler } from '../mcp/http';
import { feedToken, handleFeed } from './feed';
import { MarkerBuilder, spectatorEvent } from '../log/RunStore';
import type { SessionManager } from '../session/SessionManager';
import { seasonReplayError } from '../session/SessionManager';
import { WsHub } from '../ws/hub';
import { allowLocalHosts, isLocalRequest, jsonContentType, sameOrigin } from './local';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function fail(res: ServerResponse, status: number, error: ActionError): void {
  json(res, status, { error });
}

/** 持ち主の口のプロフィールのトークン（S8）: Authorization: Bearer か、POST の本文の profileToken。URL の ?token= は受けない（§27・§28 の漏れをくり返さない） */
function ownerToken(req: IncomingMessage, bodyToken?: string): { profileToken?: string } {
  const auth = req.headers.authorization;
  const h = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const tok = h || (bodyToken ?? '').trim();
  return tok ? { profileToken: tok } : {};
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : undefined;
}

export interface App {
  server: Server;
  manager: SessionManager;
  mcp: McpHttpHandler;
  ws: WsHub;
  close(): Promise<void>;
}

export function createApp(manager: SessionManager, config: ServerConfig): App {
  // 「同じ機械」と認める Host の名前に、待ち受けのアドレス（MUSE_HOST）を足す（S8a。127.0.0.1・localhost・[::1] は、もとから）
  allowLocalHosts(config.host.split(','));
  const mcp = new McpHttpHandler(manager);
  const ws = new WsHub(manager, config);
  const store = manager.store;

  const liveEvents = (runId: string): { events: GameEvent[]; ended: boolean } | null => {
    const s = manager.get(runId);
    if (s) return { events: s.history, ended: s.world.status === 'ended' };
    // 記録だけのラン: 命令の記録が覆っている出来事だけ（S3i §46.2 の 5。動いているランの履歴は、もともと覆う出来事だけ）
    if (store?.exists(runId)) return { events: store.coveredEvents(runId), ended: store.meta(runId)?.status === 'ended' };
    return null;
  };

  const spectatorBlocked = (runId: string, req: IncomingMessage): ActionError | null => {
    const s = manager.get(runId);
    const season = s?.world.meta.season?.id ?? store?.meta(runId)?.season;
    // 確定する前のシーズンのランの巻き戻しは、同じ機械からの接続だけ（S3。SEASON.md §25.1: 巻き戻しは World を見せる。参加者のトークンでも開かない）
    if (season && !manager.seasonFinal(season) && !isLocalRequest(req)) return seasonReplayError();
    // シーズンのランは follow_only（S0 §9.7）
    if (config.spectatorPolicy !== 'follow_only' && !season) return null;
    const ended = s ? s.world.status === 'ended' : store?.meta(runId)?.status === 'ended';
    return ended ? null : actionError('bad_request', 'spectatorPolicy=follow_only: replay data is available after the run ends', '');
  };

  const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    const m = req.method ?? 'GET';

    if (p === '/mcp') {
      const body = m === 'POST' ? await readBody(req, 4_000_000).catch(() => undefined) : undefined;
      await mcp.handle(req, res, body);
      return;
    }
    // 状態を変える口（S8a。SEASON.md §55.6）: Origin があれば要求の Host と同じ origin だけ（トークンで認める口も）、本文は application/json だけ。
    // ブラウザの別のページからは、text/plain の POST・フォームを送れず、JSON は事前の問い合わせ（CORS の見出しを返さない）で止まる。/mcp は SDK が JSON だけを受ける
    if (p.startsWith('/api/') && m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
      if (!sameOrigin(req)) return fail(res, 403, actionError('bad_request', 'cross-origin request refused: Origin must be the same origin as Host / 別の origin からの要求は受けない', ''));
      if (!jsonContentType(req)) return fail(res, 415, actionError('bad_request', 'Content-Type must be application/json / 本文は application/json だけ', ''));
    }
    if (p === '/api/health') return json(res, 200, { ok: true, contentVersion: manager.catalog.contentVersion });
    if (p === '/api/player/feed' && m === 'GET') {
      const tok = feedToken(req, url);
      if (!tok || !handleFeed(req, res, manager, config, tok)) {
        // 復旧に失敗したランのトークン（V4-1m §37.1）: 「見つからない」でなく、理由つきで 503
        const f = manager.recoveryFailedForToken(tok ?? undefined);
        return f ? fail(res, 503, f) : fail(res, 401, actionError('no_session', 'unknown or missing player token', 'Authorization: Bearer <player_token> か ?token= を付ける'));
      }
      return;
    }
    if (p === '/api/config') return json(res, 200, { spectatorPolicy: config.spectatorPolicy });
    // 運用の口（S7 §52.1 の 2）: 直近の MCP の呼び出し（受け取った時刻・ツール・ラン・サーバーの側でかかった時間）。同じ機械からだけ（引数・トークン・考えは持っていない）
    if (p === '/api/ops/calls' && m === 'GET') {
      if (!isLocalRequest(req)) return fail(res, 403, actionError('bad_request', 'only from the same machine as the server', ''));
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit') ?? 200) || 200));
      return json(res, 200, { long_ms: manager.calls.longMs, calls: manager.calls.list(limit) });
    }
    if (p === '/api/content/catalog') return json(res, 200, manager.catalog);
    // 開催中のシーズンのランは載せない（S3a §27.9 の 3）
    if (p === '/api/leaderboard') return json(res, 200, { entries: store?.leaderboard((sid) => manager.seasonHidden(sid)) ?? [] });
    // シーズン（S0。PROTOCOL §9.8）: 一覧と順位の表（公開された階段の位置は出さない）
    if (p === '/api/seasons' && m === 'GET') return json(res, 200, { seasons: manager.seasons.list() });
    {
      const sm = /^\/api\/seasons\/([a-z0-9][a-z0-9_-]{0,31})$/.exec(p);
      if (sm && m === 'GET') {
        // 討伐の記録の中身は、確定の後か、同じ機械からの接続にだけ（S4a §46。観戦の決まりと同じ判定）
        const st = manager.seasons.standings(sm[1], { full: isLocalRequest(req) });
        return st ? json(res, 200, st) : fail(res, 404, actionError('no_session', `unknown season ${sm[1]}`, 'GET /api/seasons'));
      }
      // いま観戦できる進行中のラン（S3。SEASON.md §25.1）: 参加者のトークンは Authorization の見出しでだけ受ける（URL に出さない）
      const wm = /^\/api\/seasons\/([a-z0-9][a-z0-9_-]{0,31})\/watch$/.exec(p);
      if (wm && m === 'GET') {
        const auth = req.headers.authorization;
        const tok = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
        const r = manager.seasonWatchable(wm[1], { local: isLocalRequest(req), ...(tok ? { profileToken: tok } : {}) });
        return r ? json(res, 200, r) : fail(res, 404, actionError('no_session', `unknown season ${wm[1]}`, 'GET /api/seasons'));
      }
    }
    // 持ち主の口（S8。SEASON.md §54。PROTOCOL §9.14）: 持ち主と認められた進行中のラン。トークンは Authorization の見出しでだけ（URL に出さない）
    if (p === '/api/owner/runs' && m === 'GET') return json(res, 200, manager.ownerRuns({ local: isLocalRequest(req), ...ownerToken(req) }));
    if (p === '/api/runs' && m === 'GET') return json(res, 200, { runs: manager.listRuns() });
    if (p === '/api/runs' && m === 'POST') {
      const body = (await readBody(req).catch(() => null)) as NewRunRequest | null;
      if (!body?.name) return fail(res, 400, actionError('bad_request', 'name is required', '{ name, classId?, seed?, mode?, locale? }'));
      // controller を省いたら「分からない」（V4-1g G2。ブラウザの画面は human を送る）
      const controller: Controller = body.controller ?? { kind: 'unknown', label: 'http' };
      const r = await manager.createRun({ ...body, controller });
      if ('error' in r) return fail(res, r.error.code === 'season_unavailable' ? 409 : 400, r.error);
      return json(res, 200, { runId: r.session.runId, playerId: r.playerId, token: r.token, profileId: r.profile.id, ...(r.profile.token ? { profileToken: r.profile.token } : {}) });
    }
    // プロフィール（V3-7 §7.1）: Authorization: Bearer <profile_token>。MCP の profile・records と同じ中身
    if (p === '/api/profile' || p === '/api/profile/records') {
      const tok = feedToken(req, url);
      const pp = tok ? manager.profilePortForToken(tok) : null;
      if (!pp) return fail(res, 401, actionError('no_session', 'unknown or missing profile token', 'Authorization: Bearer <profile_token>'));
      const L = url.searchParams.get('locale') === 'en' ? 'en' : 'ja';
      if (p === '/api/profile' && m === 'POST') {
        const body = (await readBody(req).catch(() => null)) as { name?: string } | null;
        if (!body?.name || !pp.rename(body.name)) return fail(res, 400, actionError('bad_request', 'name is required', '{ name }'));
      }
      if (p === '/api/profile') { const r = pp.info(L); return r ? json(res, 200, { text: r.text, ...r.data }) : fail(res, 404, actionError('no_session', 'no profile', '')); }
      const r = pp.records(L);
      return r ? json(res, 200, { text: r.text, records: r.data }) : fail(res, 404, actionError('no_session', 'no profile', ''));
    }
    const mm = /^\/api\/runs\/(run_[0-9a-z]+)(\/.*)?$/.exec(p);
    if (mm) {
      const runId = mm[1];
      const sub = mm[2] ?? '';
      if (sub === '/join' && m === 'POST') {
        const body = (await readBody(req).catch(() => null)) as JoinRunRequest | null;
        if (!body?.name) return fail(res, 400, actionError('bad_request', 'name is required', ''));
        const r = await manager.joinRun(runId, { name: body.name, classId: body.classId, locale: body.locale, controller: body.controller ?? { kind: 'unknown', label: 'http' }, profileToken: body.profileToken, legacy: body.legacy });
        if ('error' in r) return fail(res, r.error.code === 'recovery_failed' ? 503 : 400, r.error);
        return json(res, 200, { runId, playerId: r.playerId, token: r.token, profileId: r.profile.id, ...(r.profile.token ? { profileToken: r.profile.token } : {}) });
      }
      // 持ち主の口（S8 §54.1・§54.5）: 見る（GET …/owner/view）・指図（POST …/owner/directive）・握った項目の命令（POST …/owner/act）。
      // 認め方は観戦と同じ（そのプレイヤーのプロフィールのトークンか、同じ機械）。トークンは見出しか本文で受け、応答にも記録にも出さない
      if (sub === '/owner/view' || sub === '/owner/directive' || sub === '/owner/act') {
        const post = sub !== '/owner/view';
        if (post !== (m === 'POST')) return fail(res, 405, actionError('bad_request', `${post ? 'POST' : 'GET'} ${sub}`, ''));
        const body = post ? ((await readBody(req, 16_000).catch(() => null)) as Record<string, unknown> | null) : null;
        if (post && (!body || typeof body !== 'object')) return fail(res, 400, actionError('bad_request', 'JSON body is required', sub === '/owner/directive' ? '{ hold: ["objective"|"loadout"|"perks"], message? }' : '{ command }'));
        const bodyTok = typeof body?.profileToken === 'string' ? body.profileToken : undefined;
        const acc = manager.ownerAccess(runId, { local: isLocalRequest(req), ...ownerToken(req, bodyTok) });
        if ('error' in acc) return fail(res, acc.status, acc.error);
        let result: OwnerViewResponse['result'];
        if (sub === '/owner/directive') result = await ownerAct(acc.session, acc.pid, { type: 'set_directive', hold: body!.hold, ...(body!.message !== undefined ? { message: body!.message } : {}) });
        else if (sub === '/owner/act') result = await ownerAct(acc.session, acc.pid, body!.command);
        return json(res, 200, { ...ownerView(acc.session, acc.pid), ...(result ? { result } : {}) });
      }
      const live = manager.get(runId);
      if (!live && !store?.exists(runId)) return fail(res, 404, actionError('no_session', `unknown run ${runId}`, ''));
      if (sub === '/meta') {
        const meta = live ? live.meta() : store!.meta(runId);
        // 開催中のシーズンのラン（S3a §27.9 の 3）: 進み具合（lastSeq・終わった時刻・参加の seq）を出さない
        if (meta?.season && manager.seasonHidden(meta.season)) {
          const { lastSeq: _l, endedAt: _e, seed: _s, ...rest } = meta;
          return json(res, 200, { ...rest, players: rest.players.map((x) => ({ ...x, joinedSeq: 0 })) });
        }
        return json(res, 200, meta);
      }
      { const blocked = spectatorBlocked(runId, req); if (blocked) return fail(res, 403, blocked); }
      if (sub === '/events') {
        const src = liveEvents(runId)!;
        const from = Number(url.searchParams.get('from') ?? 0);
        const to = url.searchParams.has('to') ? Number(url.searchParams.get('to')) : Number.MAX_SAFE_INTEGER;
        const lines: string[] = [];
        for (const ev of src.events) {
          if (ev.seq < from || ev.seq > to) continue;
          // シーズンのラン（S0）は終わってもシードを出さない
          const se = spectatorEvent(ev, src.ended && !(live?.world.meta.season ?? store?.meta(runId)?.season));
          if (se) lines.push(JSON.stringify(se));
        }
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
        res.end(lines.length ? lines.join('\n') + '\n' : '');
        return;
      }
      if (sub === '/keyframes') return json(res, 200, { keyframes: store?.keyframeSeqs(runId) ?? [] });
      const km = /^\/keyframes\/(\d+)$/.exec(sub);
      if (km) {
        const kf = store?.keyframe(runId, Number(km[1]));
        if (!kf) return fail(res, 404, actionError('bad_request', 'no such keyframe', ''));
        const ended = live ? live.world.status === 'ended' : store!.meta(runId)?.status === 'ended';
        // シーズンのラン（S0）は終わってもシードを出さない
        const w: World = ended && !kf.world.meta.season ? { ...kf.world, secret: { ...kf.world.secret, rng: {} } } : stripSecret(kf.world);
        return json(res, 200, w);
      }
      if (sub === '/index') {
        if (live) {
          const mb = new MarkerBuilder();
          for (const ev of live.history) mb.add(ev);
          return json(res, 200, { runId, lastSeq: live.world.seq, markers: mb.markers, keyframes: store?.keyframeSeqs(runId) ?? [], expeditions: mb.expeditions });
        }
        return json(res, 200, store!.index(runId, store!.coveredEvents(runId)));
      }
      if (sub === '/commands') {
        const recs = store?.commands(runId) ?? [];
        res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
        res.end(recs.map((r) => JSON.stringify(r)).join('\n') + (recs.length ? '\n' : ''));
        return;
      }
      if (sub === '/summary') return json(res, 200, live?.summary() ?? store?.summary(runId) ?? null);
      return fail(res, 404, actionError('bad_request', 'unknown endpoint', ''));
    }
    if (p.startsWith('/api/')) return fail(res, 404, actionError('bad_request', 'unknown endpoint', ''));

    // 静的ファイル（Web クライアント）
    const dist = config.clientDist;
    if (!existsSync(join(dist, 'index.html'))) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>MuseDungeon</title><body style="font-family:sans-serif;background:#111;color:#ddd;padding:2em"><h1>MuseDungeon server</h1><p>Web クライアントが未ビルドです。<code>npm run build</code> を実行してください。</p><p>MCP: <code>/mcp</code> / API: <code>/api/runs</code></p></body>');
      return;
    }
    const rel = normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
    let file = resolve(dist, rel || 'index.html');
    if (!file.startsWith(resolve(dist)) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600' });
    createReadStream(file).pipe(res);
  };

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      if (!res.headersSent) fail(res, 500, actionError('bad_request', `internal error: ${(e as Error).message}`, ''));
      else res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws') ws.handleUpgrade(req, socket, head);
    else socket.destroy();
  });

  return {
    server, manager, mcp, ws,
    async close() {
      ws.close();
      await mcp.closeAll();
      manager.closeAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

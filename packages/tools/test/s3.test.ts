// S3（SEASON.md §25。観戦は持ち主だけ §25.1・補給の置き場 §25.2）のテスト（§25.5）
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { App } from '@muse/server';
import type { Command, ServerMsg } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's3t';

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir, waitOthersMs: 100 } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}

function openSeason(m: SessionManager, id = SID): void {
  m.seasons.store.open({ id, name: 'S3試し', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}

async function seasonRun(m: SessionManager, name: string, season = SID) {
  const inv = m.seasons.invite(season, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return Object.assign(r, { ptoken: inv.token! });
}

const act = (r: { port: { act: (c: Command, o: { source: 'bot' }) => Promise<unknown> } }, cmd: Command) => r.port.act(cmd, { source: 'bot' });

async function listen(m: SessionManager): Promise<{ app: App; port: number }> {
  const app = createApp(m, m.config);
  await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
  return { app, port: (app.server.address() as AddressInfo).port };
}

/** 外からの接続のふり（プロキシの印。S3: 同じ機械からの接続として扱わない） */
const REMOTE = { 'x-forwarded-for': '203.0.113.7' };

/** 観戦の WS: hello を送り、閉じるか、届いた数が足りるか、時間が来るまでのメッセージ */
function spectate(port: number, hello: Record<string, unknown>, headers: Record<string, string> = {}, enough = 3): Promise<{ msgs: ServerMsg[]; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const msgs: ServerMsg[] = [];
    let closed = false;
    const done = () => { clearTimeout(timer); try { ws.close(); } catch { /* 閉じている */ } resolve({ msgs, closed }); };
    const timer = setTimeout(done, 1500);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'spectator', ...hello })));
    ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw)) as ServerMsg); if (msgs.length >= enough) done(); });
    ws.on('close', () => { closed = true; done(); });
    ws.on('error', reject);
  });
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

describe('S3 §25.1: a run of a season in progress can be watched only by its participant (or from the server machine)', () => {
  it('WS: refuses no token and another participant\'s token; the owner\'s token follows; the same machine follows; anyone after the season is final', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s3-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      const b = await seasonRun(m, 'Ben');
      await act(a, { type: 'start_expedition', offer: 1 });
      const { app, port } = await listen(m);
      try {
        const runA = a.session.runId;
        // 外から・トークンなし: 断る（理由つき）
        const none = await spectate(port, { runId: runA, mode: 'follow' }, REMOTE);
        const e0 = none.msgs.find((x) => x.t === 'error');
        expect(e0 && e0.t === 'error' ? e0.error.code : null).toBe('season_unavailable');
        expect(e0 && e0.t === 'error' ? e0.error.message : '').toContain('参加者のトークン');
        expect(e0 && e0.t === 'error' ? e0.error.message : '').toContain('確定した後は、だれでも見返せる');
        expect(none.msgs.some((x) => x.t === 'view' || x.t === 'snapshot' || x.t === 'welcome')).toBe(false);
        expect(none.closed).toBe(true);
        // 外から・違う参加者のトークン: 断る
        const other = await spectate(port, { runId: runA, mode: 'follow', profileToken: b.ptoken }, REMOTE);
        const e1 = other.msgs.find((x) => x.t === 'error');
        expect(e1 && e1.t === 'error' ? e1.error.message : '').toContain('このランの参加者のものではない');
        expect(other.msgs.some((x) => x.t === 'view' || x.t === 'snapshot')).toBe(false);
        // 外から・知らないトークン: 断る
        const unknown = await spectate(port, { runId: runA, mode: 'follow', profileToken: 'p_nope' }, REMOTE);
        expect(unknown.msgs.some((x) => x.t === 'error')).toBe(true);
        // 外から・持ち主のトークン: 追従（PlayerView だけ。World は送らない）。follow に別の名前を渡しても、持ち主を追う
        const own = await spectate(port, { runId: runA, mode: 'follow', follow: 'p_other', profileToken: a.ptoken }, REMOTE, 2);
        expect(own.msgs[0]?.t).toBe('welcome');
        const v = own.msgs.find((x) => x.t === 'view');
        expect(v && v.t === 'view' ? v.view.playerId : null).toBe(a.playerId);
        expect(own.msgs.some((x) => x.t === 'snapshot' || x.t === 'events')).toBe(false);
        // 持ち主のトークンでも俯瞰は断る
        const dir2 = await spectate(port, { runId: runA, mode: 'director', profileToken: a.ptoken }, REMOTE);
        expect(dir2.msgs.some((x) => x.t === 'error')).toBe(true);
        expect(dir2.msgs.some((x) => x.t === 'snapshot')).toBe(false);
        // 同じ機械から（プロキシの印なし）: トークンなしでも追従できる（運用者）
        const local = await spectate(port, { runId: b.session.runId, mode: 'follow' }, {}, 2);
        expect(local.msgs[0]?.t).toBe('welcome');
        expect(local.msgs.some((x) => x.t === 'view')).toBe(true);

        // 持ち主のランが終わっても、持ち主の観戦は追従だけ（俯瞰の World を送らない: まだ見ていない地図と階段が分かる）
        await act(a, { type: 'retire' });
        expect(a.session.world.status).toBe('ended');
        const ownEnded = await spectate(port, { runId: runA, mode: 'follow', profileToken: a.ptoken }, REMOTE, 2);
        expect(ownEnded.msgs.some((x) => x.t === 'view')).toBe(true);
        expect(ownEnded.msgs.some((x) => x.t === 'snapshot' || x.t === 'events')).toBe(false);

        // 確定した後は、だれでも（今までどおり）
        m.seasons.finalize(m.seasons.get(SID)!, 'operator');
        const after = await spectate(port, { runId: b.session.runId, mode: 'follow' }, REMOTE, 2);
        expect(after.msgs[0]?.t).toBe('welcome');
        expect(after.msgs.some((x) => x.t === 'view')).toBe(true);
      } finally {
        await app.close();
      }
      // トークンは、記録（ランの置き場所・シーズン・プロフィールのファイル）のどこにも出ない
      for (const f of filesUnder(dir)) {
        const text = readFileSync(f, 'utf8');
        expect(text.includes(a.ptoken), f).toBe(false);
        expect(text.includes(b.ptoken), f).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('HTTP: rewinding a run of an unfinalized season is for the server machine only (not even the owner\'s token); the watch list follows the same rules', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    const { app, port } = await listen(m);
    const base = `http://127.0.0.1:${port}`;
    try {
      const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
      await act(a, { type: 'retire' });
      const runA = a.session.runId;
      for (const sub of ['events', 'keyframes', 'index', 'commands', 'summary']) {
        const r = await get(`/api/runs/${runA}/${sub}`, REMOTE);
        expect(r.status, sub).toBe(403);
        const body = (await r.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe('season_unavailable');
        expect(body.error.message).toContain('確定した後に');
        // 持ち主のトークンでも開かない（巻き戻しは World を見せる）
        expect((await get(`/api/runs/${runA}/${sub}`, { ...REMOTE, authorization: `Bearer ${a.ptoken}` })).status, sub).toBe(403);
      }
      // meta は今までどおり
      expect((await get(`/api/runs/${runA}/meta`, REMOTE)).status).toBe(200);
      // 同じ機械から: 終わったランは見られる。進行中のランは今までどおり見られない（follow_only）
      expect((await get(`/api/runs/${runA}/events`)).status).toBe(200);
      expect((await get(`/api/runs/${b.session.runId}/events`)).status).toBe(403);
      // 観戦できるランの一覧
      type W = { local: boolean; final: boolean; runs: { runId: string; name: string }[] };
      const w0 = (await (await get(`/api/seasons/${SID}/watch`, REMOTE)).json()) as W;
      expect(w0).toEqual({ local: false, final: false, runs: [] });
      const wb = (await (await get(`/api/seasons/${SID}/watch`, { ...REMOTE, authorization: `Bearer ${b.ptoken}` })).json()) as W;
      expect(wb.runs).toEqual([{ runId: b.session.runId, name: 'Ben' }]);
      // 終わったランは一覧に入らない（進行中のランだけ）
      const wa = (await (await get(`/api/seasons/${SID}/watch`, { ...REMOTE, authorization: `Bearer ${a.ptoken}` })).json()) as W;
      expect(wa.runs).toEqual([]);
      const wl = (await (await get(`/api/seasons/${SID}/watch`)).json()) as W;
      expect(wl.local).toBe(true);
      expect(wl.runs.map((x) => x.name)).toEqual(['Ben']);
      expect((await get('/api/seasons/nope/watch')).status).toBe(404);
      // トークンを URL で渡しても受けない（?token= は見ない）
      const wq = (await (await get(`/api/seasons/${SID}/watch?token=${b.ptoken}`, REMOTE)).json()) as W;
      expect(wq.runs).toEqual([]);
      // 確定した後は、だれでも巻き戻せる
      m.seasons.finalize(m.seasons.get(SID)!, 'operator');
      expect((await get(`/api/runs/${runA}/events`, REMOTE)).status).toBe(200);
      const wf = (await (await get(`/api/seasons/${SID}/watch`, REMOTE)).json()) as W;
      expect(wf.final).toBe(true);
      expect(wf.runs.map((x) => x.name)).toEqual(['Ben']);
      // ランの一覧に、記録だけのランにもシーズンの ID が付く（ロビーが巻き戻しを出し分ける）
      const runs = (await (await get('/api/runs')).json()) as { runs: { runId: string; season?: string }[] };
      expect(runs.runs.find((x) => x.runId === runA)?.season).toBe(SID);
    } finally {
      await app.close();
    }
  });
});

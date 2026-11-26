// S15a（S15 の検査の指摘）:
// 1. シーズンのランは、終わっても（引退・倒れた）、シードを出さない: キーフレーム（最後のものも）・俯瞰のスナップショット・出来事・まとめ・meta・一覧・順位。
//    シードの無いキーフレームから、リプレイの画面と同じに畳めて、最後まで描ける（ライブの World と一致し、追従の見え方を作れる）。
//    シーズンでないランは、今までどおり（終わったら、最後のキーフレームにシードが見える）。
// 3. 画面の巻き戻しの決まり（client/src/ui/replayRule.ts）が、サーバーの巻き戻しの口の答えとそろっている（同じ組み合わせを聞いて比べる）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { App } from '@muse/server';
import { applyEvent, canonicalHash, projectPlayerView, stripSecret } from '@muse/shared';
import type { GameEvent, ServerMsg, SpectatorPolicy, World } from '@muse/shared';
import { rewindAllowed } from '../../client/src/ui/replayRule';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's15a';
const SEED = 's15a-seed-Qx7PzM2k';
const PLAIN_SEED = 'plain-seed-Vb3nT8';
/** 外からの接続のふり（プロキシの印。同じ機械からの接続として扱わない） */
const REMOTE = { 'x-forwarded-for': '203.0.113.7' };

function manager(runsDir: string | null, policy?: SpectatorPolicy): SessionManager {
  const base = runsDir ? { runsDir, waitOthersMs: 100 } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 };
  return new SessionManager(content, loadConfig({ ...base, ...(policy ? { spectatorPolicy: policy } : {}) }));
}

function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S15a試し', seed: SEED, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}

async function seasonRun(m: SessionManager, name: string) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: SID, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}

async function plainRun(m: SessionManager, name: string, seed?: string) {
  const r = await m.createRun({ name, controller: agent, ...(seed ? { seed } : {}) });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}

async function listen(m: SessionManager): Promise<{ app: App; port: number }> {
  const app = createApp(m, m.config);
  await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
  return { app, port: (app.server.address() as AddressInfo).port };
}

function spectate(port: number, hello: Record<string, unknown>, headers: Record<string, string> = {}, enough = 4): Promise<ServerMsg[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const msgs: ServerMsg[] = [];
    const done = () => { clearTimeout(timer); try { ws.close(); } catch { /* 閉じている */ } resolve(msgs); };
    const timer = setTimeout(done, 1500);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'spectator', ...hello })));
    ws.on('message', (raw) => { msgs.push(JSON.parse(String(raw)) as ServerMsg); if (msgs.length >= enough) done(); });
    ws.on('close', done);
    ws.on('error', reject);
  });
}

describe('S15a 1: a season run never gives out its seed, even after it ended', () => {
  it('keyframes (the last one too), the director snapshot, events, summary, meta and lists; the seedless keyframes still replay to the end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s15a-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      const b = await seasonRun(m, 'Ben');
      // 迷宮に入って（階のキーフレーム）、少し歩いてから引退する（終わったキーフレーム）
      expect((await a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
      for (let i = 0; i < 3; i++) await a.port.act({ type: 'wait' }, { source: 'bot' });
      expect((await a.port.act({ type: 'retire' }, { source: 'bot' })).ok).toBe(true);
      expect(a.session.world.status).toBe('ended');
      expect(a.session.world.secret.seed).toBe(SEED);
      const runA = a.session.runId;
      const { app, port } = await listen(m);
      const base = `http://127.0.0.1:${port}`;
      try {
        const get = async (path: string, headers: Record<string, string> = {}) => {
          const r = await fetch(`${base}${path}`, { headers });
          return { status: r.status, text: await r.text() };
        };
        /** 終わったシーズンのランの、関係する口の全部（キーフレームは全部）。どれにもシードが無い */
        const scan = async (headers: Record<string, string>) => {
          const kfs = JSON.parse((await get(`/api/runs/${runA}/keyframes`, headers)).text) as { keyframes: number[] };
          expect(kfs.keyframes.length).toBeGreaterThan(1);
          // 最後のキーフレームは、終わった World
          const lastKf = JSON.parse((await get(`/api/runs/${runA}/keyframes/${Math.max(...kfs.keyframes)}`, headers)).text) as World;
          expect(lastKf.status).toBe('ended');
          expect(lastKf.secret.seed).toBe('');
          expect(Object.keys(lastKf.secret.rng)).toHaveLength(0);
          const paths = [
            ...kfs.keyframes.map((k) => `/api/runs/${runA}/keyframes/${k}`),
            ...['events', 'index', 'commands', 'summary', 'meta'].map((s) => `/api/runs/${runA}/${s}`),
            `/api/runs/${b.session.runId}/meta`, '/api/runs', '/api/leaderboard', `/api/seasons/${SID}`, '/api/seasons',
          ];
          for (const p of paths) {
            const r = await get(p, headers);
            expect(r.status, p).toBe(200);
            expect(r.text.includes(SEED), p).toBe(false);
          }
          return kfs.keyframes;
        };
        // 確定する前: 同じ PC から（終わったランは見返せる）
        await scan({});
        // 確定した後: だれでも
        m.seasons.finalize(m.seasons.get(SID)!, 'operator');
        const keyframes = await scan(REMOTE);
        // 俯瞰つきの観戦（確定した後の、終わったラン）: スナップショットと、ランの終わりの知らせに、シードが無い
        const dirMsgs = await spectate(port, { runId: runA, mode: 'director' }, REMOTE);
        const snap = dirMsgs.find((x) => x.t === 'snapshot');
        expect(snap && snap.t === 'snapshot' ? snap.world.status : null).toBe('ended');
        expect(snap && snap.t === 'snapshot' ? snap.world.secret.seed : null).toBe('');
        expect(dirMsgs.some((x) => x.t === 'ended')).toBe(true);
        expect(JSON.stringify(dirMsgs).includes(SEED)).toBe(false);
        // 追従の観戦・進行中のランの俯瞰も
        expect(JSON.stringify(await spectate(port, { runId: runA, mode: 'follow' }, REMOTE)).includes(SEED)).toBe(false);
        expect(JSON.stringify(await spectate(port, { runId: b.session.runId, mode: 'director' }, REMOTE)).includes(SEED)).toBe(false);

        // リプレイの画面と同じ畳み方: 各キーフレーム（シード無し）から、出来事を最後まで畳むと、ライブの World と一致する。最後の World から、追従の見え方を作れる
        const events = (await get(`/api/runs/${runA}/events`, REMOTE)).text.trim().split('\n').map((l) => JSON.parse(l) as GameEvent);
        const live = stripSecret(a.session.world);
        for (const k of keyframes) {
          const w = JSON.parse((await get(`/api/runs/${runA}/keyframes/${k}`, REMOTE)).text) as World;
          for (const ev of events) if (ev.seq > w.seq) applyEvent(w, ev);
          expect(w.seq, `from #${k}`).toBe(a.session.world.seq);
          expect(canonicalHash({ ...w, secret: null }), `from #${k}`).toBe(canonicalHash({ ...live, secret: null }));
          expect(w.secret.seed).toBe('');
          const v = projectPlayerView(w, a.playerId);
          expect(v.runStatus).toBe('ended');
        }
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-season run is as before: once ended, its last keyframe shows the seed (and never while it runs)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s15a-'));
    try {
      const m = manager(dir);
      const r = await plainRun(m, 'Cid', PLAIN_SEED);
      const { app, port } = await listen(m);
      const base = `http://127.0.0.1:${port}`;
      try {
        const kfList = async () => (await (await fetch(`${base}/api/runs/${r.session.runId}/keyframes`)).json() as { keyframes: number[] }).keyframes;
        for (const k of await kfList()) {
          const t = await (await fetch(`${base}/api/runs/${r.session.runId}/keyframes/${k}`)).text();
          expect(t.includes(PLAIN_SEED)).toBe(false);
        }
        expect((await r.port.act({ type: 'retire' }, { source: 'bot' })).ok).toBe(true);
        const ks = await kfList();
        const last = (await (await fetch(`${base}/api/runs/${r.session.runId}/keyframes/${Math.max(...ks)}`)).json()) as World;
        expect(last.status).toBe('ended');
        expect(last.secret.seed).toBe(PLAIN_SEED);
        expect(Object.keys(last.secret.rng)).toHaveLength(0);
        // 俯瞰のスナップショット（stripSecret）も、終わったシーズンでないランはシードを見せる（今までどおり）
        const msgs = await spectate(port, { runId: r.session.runId, mode: 'director' });
        const snap = msgs.find((x) => x.t === 'snapshot');
        expect(snap && snap.t === 'snapshot' ? snap.world.secret.seed : null).toBe(PLAIN_SEED);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S15a 3: the screen\'s rewind rule matches the server\'s rewind endpoints', () => {
  it('season open / final × run active / ended × same PC / elsewhere; non-season runs under omniscient and follow_only', async () => {
    const check = async (m: SessionManager, runs: { runId: string; season: string | null; status: () => 'active' | 'ended' }[], final: boolean, policy: SpectatorPolicy) => {
      const { app, port } = await listen(m);
      try {
        let n = 0;
        for (const r of runs) {
          for (const local of [true, false]) {
            const want = rewindAllowed({ season: r.season, status: r.status(), final, local, policy });
            for (const sub of ['events', 'keyframes', 'index', 'commands', 'summary']) {
              const res = await fetch(`http://127.0.0.1:${port}/api/runs/${r.runId}/${sub}`, { headers: local ? {} : REMOTE });
              await res.arrayBuffer();
              expect(res.status === 200, `${r.season ?? 'plain'} ${r.status()} final=${final} local=${local} ${policy} ${sub}`).toBe(want);
              n++;
            }
          }
        }
        return n;
      } finally {
        await app.close();
      }
    };
    const m = manager(null);
    openSeason(m);
    const sa = await seasonRun(m, 'Aya');
    const sb = await seasonRun(m, 'Ben');
    await sb.port.act({ type: 'retire' }, { source: 'bot' });
    const pa = await plainRun(m, 'Cid');
    const pb = await plainRun(m, 'Dot');
    await pb.port.act({ type: 'retire' }, { source: 'bot' });
    const runs = [sa, sb, pa, pb].map((r) => ({ runId: r.session.runId, season: r.session.world.meta.season?.id ?? null, status: () => r.session.world.status }));
    expect(runs.map((r) => r.status())).toEqual(['active', 'ended', 'active', 'ended']);
    let n = await check(m, runs, false, 'omniscient');
    m.seasons.finalize(m.seasons.get(SID)!, 'operator');
    n += await check(m, runs, true, 'omniscient');
    // 方針 follow_only のサーバー（シーズンでないランは、終わったランだけ）
    const f = manager(null, 'follow_only');
    const fa = await plainRun(f, 'Eve');
    const fb = await plainRun(f, 'Fay');
    await fb.port.act({ type: 'retire' }, { source: 'bot' });
    n += await check(f, [fa, fb].map((r) => ({ runId: r.session.runId, season: null, status: () => r.session.world.status })), false, 'follow_only');
    expect(n).toBe(4 * 2 * 5 * 2 + 2 * 2 * 5);
  });
});

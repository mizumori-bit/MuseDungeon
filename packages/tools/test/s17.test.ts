// S17（SEASON.md §70.6）: 見返す（開催中のシーズンのランの、終わった遠征を、冒険者の目線で）。
// 1. 門: その場の観戦（WS の追従）と、まったく同じ組み合わせで、同じ答え（鍵なし・ほかの冒険者の鍵・知らない鍵・ほかの PC から（転送の見出し・Host・Origin）・
//    持ち主の鍵・同じ PC から。確定の後・シーズンでないラン）。巻き戻しの口は、今までどおり、開催中のシーズンのランを外から断る
// 2. 中身: 本物の engine で遠征を進めて、その場で観戦して集めたコマと、後から見返したコマが、同じ並び・同じ中身。シード・乱数の状態・鍵・World が無い
// 3. 遅れ（spectatorDelaySeq）: その場の観戦がまだ見せていない遠征は、返さない
// 4. 量: 1 回の求めはコマの上限まで（続きは next）。続けて集めると、1 回で集めたものと同じ。同時に作る数の上限（越えたら 503）
// 5. 書かない: 求めの前後で、ランの記録・プロフィール・シーズンの記録のファイルが 1 バイトも変わらない。ランの本体の World も変わらない
// 6. 待たせない: 見返しの求めの最中に、AI の命令が通る
// 7. AI の呼び出しの記録: 考え（thought）が、命令の記録から出る。鍵は伏せる。記録だけの終わったランも、同じ門で見返せる
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { App, PlayerPort } from '@muse/server';
import { canonicalHash } from '@muse/shared';
import type { Command, ReviewListResponse, ReviewPageResponse, ServerMsg, SpectatorPolicy } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's17';
const SEED = 's17-season-seed-Wq8Lr2';
/** 外からの接続のふり（プロキシの印） */
const REMOTE = { 'x-forwarded-for': '203.0.113.9' };

function manager(runsDir: string, o: { policy?: SpectatorPolicy; delay?: number } = {}): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir, waitOthersMs: 100, ...(o.policy ? { spectatorPolicy: o.policy } : {}), ...(o.delay !== undefined ? { spectatorDelaySeq: o.delay } : {}) }));
}

function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S17試し', seed: SEED, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}

async function seasonRun(m: SessionManager, name: string) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: SID, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return { ...r, profileToken: inv.token! };
}

async function listen(m: SessionManager): Promise<{ app: App; port: number }> {
  const app = createApp(m, m.config);
  await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
  return { app, port: (app.server.address() as AddressInfo).port };
}

const act = async (port: PlayerPort, cmd: Command, thought?: string) => port.act(cmd, { source: 'mcp', ...(thought ? { thought } : {}) });

/** 遠征を 1 つ進めて終える: 始める → 少し探索して待つ → 隣に敵がいれば戦う → 帰還の綱で戻る */
async function oneExpedition(port: PlayerPort, tag: string): Promise<void> {
  const st = await act(port, { type: 'start_expedition', offer: 1 }, `${tag}: 候補 1 で出る`);
  expect(st.ok, JSON.stringify(st)).toBe(true);
  await act(port, { type: 'explore', maxSteps: 12 } as Command, `${tag}: 少し歩く`);
  for (let i = 0; i < 12 && port.view().status !== 'at_camp'; i++) {
    const v = port.view();
    const me = v.self.pos;
    const foe = me ? v.entities.find((e) => e.cat === 'monster' && Math.max(Math.abs(e.pos.x - me.x), Math.abs(e.pos.y - me.y)) <= 1) : undefined;
    if (foe) { await act(port, { type: 'fight', target: foe.id } as Command, `${tag}: 隣の敵と戦う`); continue; }
    // 待つ（知覚しない確定）: 1 回の待つ（その確定で 1 コマ）と、続けて待つマクロ（手はためて、マクロの終わりに 1 コマ）
    if (i === 0) { await act(port, { type: 'wait' }, `${tag}: 様子を見る`); continue; }
    if (i === 1) { await act(port, { type: 'wait', turns: 4 }, `${tag}: しばらく待つ`); continue; }
    const slot = v.inventory.find((x) => x.kind === 'core:lifeline')?.slot;
    if (slot) await act(port, { type: 'use', slot } as Command, `${tag}: 帰還の綱で戻る`);
    else await act(port, { type: 'wait' });
  }
  expect(port.view().status).toBe('at_camp');
}

/** 観戦の WS（追従）: 開いて、最初のものが届くまで待つ。msgs にたまる */
async function openSpectator(port: number, hello: Record<string, unknown>, headers: Record<string, string> = {}): Promise<{ msgs: ServerMsg[]; raw: string[]; close: () => void }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const msgs: ServerMsg[] = [];
  const raw: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no first view')), 3000);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'spectator', ...hello })));
    ws.on('message', (data) => {
      raw.push(String(data));
      const m = JSON.parse(String(data)) as ServerMsg;
      msgs.push(m);
      if (m.t === 'view' || m.t === 'snapshot' || m.t === 'error') { clearTimeout(timer); resolve(); }
    });
    ws.on('error', reject);
  });
  return { msgs, raw, close: () => ws.close() };
}

/** 観戦の WS の門の答え: 通れば true（welcome と view か snapshot）、断られれば false */
function wsGate(port: number, hello: Record<string, unknown>, headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    let ok: boolean | null = null;
    const done = () => { clearTimeout(timer); try { ws.close(); } catch { /* 閉じている */ } resolve(ok ?? false); };
    const timer = setTimeout(done, 1500);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'spectator', ...hello })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw)) as ServerMsg;
      if (m.t === 'error') { ok = false; done(); }
      if (m.t === 'view' || m.t === 'snapshot') { ok = true; done(); }
    });
    ws.on('close', done);
    ws.on('error', reject);
  });
}

const views = (msgs: ServerMsg[]) => msgs.filter((m): m is Extract<ServerMsg, { t: 'view' }> => m.t === 'view');
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/** GET（Host の見出しも替えられるように、http.request で） */
function getJson<T>(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string; cache: string | null }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: Number(u.port), method: 'GET', path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: T = null as T;
        try { body = (text ? JSON.parse(text) : null) as T; } catch { /* JSON でない */ }
        const cc = res.headers['cache-control'];
        resolve({ status: res.statusCode ?? 0, body, text, cache: typeof cc === 'string' ? cc : null });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

/** 遠征 1 つのコマを、続きの印（next）をたどって全部集める */
async function allPages(base: string, runId: string, no: number, headers: Record<string, string> = {}, follow?: string): Promise<{ pages: ReviewPageResponse[]; texts: string[] }> {
  const pages: ReviewPageResponse[] = [];
  const texts: string[] = [];
  let after: number | null | undefined;
  for (let n = 0; n < 200; n++) {
    const q = new URLSearchParams();
    if (after !== undefined && after !== null) q.set('after', String(after));
    if (follow) q.set('follow', follow);
    const r = await getJson<ReviewPageResponse>(base, `/api/runs/${runId}/review/${no}${q.size ? `?${q}` : ''}`, headers);
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.cache).toBe('no-store');
    pages.push(r.body);
    texts.push(r.text);
    after = r.body.next;
    if (after === null) break;
  }
  return { pages, texts };
}

/** 置き場所のファイルの全部（相対の道 → 中身の hash） */
function snapshotFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(p.slice(dir.length), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

describe('S17 1: the look-back gate is the live watch gate', () => {
  it('every combination of key and origin gets the same answer from the live follow WS and from the look-back endpoints', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      const b = await seasonRun(m, 'Ben');
      await oneExpedition(a.port, 'A1');
      const plain = await m.createRun({ name: 'Cid', controller: agent, seed: 's17-plain-1' });
      if ('error' in plain) throw new Error(plain.error.message);
      const { app, port } = await listen(m);
      const base = `http://127.0.0.1:${port}`;
      try {
        const keys: Record<string, string | undefined> = { none: undefined, owner: a.profileToken, other: b.profileToken, unknown: 'not-a-real-token-xxxxxxxx', player: a.token };
        const origins: Record<string, Record<string, string>> = {
          same: {}, forwarded: REMOTE, realIp: { 'x-real-ip': '198.51.100.4' }, fwd: { forwarded: 'for=192.0.2.60' },
          host: { host: `rebind.evil.example:${port}` }, origin: { origin: 'http://evil.example' }, nullOrigin: { origin: 'null' },
        };
        const check = async (runId: string, label: string, final: boolean) => {
          let n = 0;
          for (const [kn, key] of Object.entries(keys)) {
            for (const [on, hdr] of Object.entries(origins)) {
              const live = await wsGate(port, { runId, mode: 'follow', ...(key ? { profileToken: key } : {}) }, hdr);
              const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
              const list = await getJson<ReviewListResponse>(base, `/api/runs/${runId}/review`, { ...hdr, ...auth });
              const page = await getJson<ReviewPageResponse>(base, `/api/runs/${runId}/review/1`, { ...hdr, ...auth });
              const tag = `${label} final=${final} key=${kn} origin=${on}`;
              expect(list.status === 200, `${tag} list ${list.status} ${list.text.slice(0, 120)}`).toBe(live);
              // 遠征を終えていないランは、一覧は通っても、遠征 1 が無い（404）
              if (live && label === 'A') expect(page.status, tag).toBe(200);
              if (!live) {
                expect([403, 400].includes(list.status), tag).toBe(true);
                expect(page.status === 200, tag).toBe(false);
                expect(page.text.includes('"frames"'), tag).toBe(false);
              }
              n++;
            }
          }
          return n;
        };
        let n = await check(a.session.runId, 'A', false);
        // 持ち主の鍵で見られるのは、その鍵の冒険者だけ（follow に別の者を渡しても、持ち主）
        const own = await getJson<ReviewListResponse>(base, `/api/runs/${a.session.runId}/review?follow=${b.playerId}`, { ...REMOTE, authorization: `Bearer ${a.profileToken}` });
        expect(own.status).toBe(200);
        expect(own.body.playerId).toBe(a.playerId);
        // ほかの冒険者のランは、その鍵の冒険者のものでなければ断る
        const cross = await getJson<ReviewListResponse>(base, `/api/runs/${b.session.runId}/review`, { ...REMOTE, authorization: `Bearer ${a.profileToken}` });
        expect(cross.status).toBe(403);
        // 巻き戻しの口は、今までどおり、開催中のシーズンのランを、外から断る（持ち主の鍵でも）
        for (const sub of ['events', 'keyframes', 'index', 'commands', 'summary']) {
          const r = await fetch(`${base}/api/runs/${a.session.runId}/${sub}`, { headers: { ...REMOTE, authorization: `Bearer ${a.profileToken}` } });
          await r.arrayBuffer();
          expect(r.status, sub).toBe(403);
        }
        // シーズンでないラン: その場の観戦と同じく、だれでも
        n += await check(plain.session.runId, 'plain', false);
        // 確定の後: だれでも（その場の観戦と同じ）
        m.seasons.finalize(m.seasons.get(SID)!, 'operator');
        n += await check(a.session.runId, 'A', true);
        expect(n).toBe(3 * 5 * 7);
        // 状態を変えない: POST は受けない
        const post = await fetch(`${base}/api/runs/${a.session.runId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        expect(post.status).toBe(405);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

describe('S17 2: what the look-back returns is what the live follow showed', () => {
  it('frames collected live and frames looked back later have the same order and contents; no seed, rng, token or World', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      const { app, port } = await listen(m);
      const base = `http://127.0.0.1:${port}`;
      try {
        // 持ち主の鍵で、外から、その場で観戦する（遠征を始める前につなぐ）
        const sp = await openSpectator(port, { runId: a.session.runId, mode: 'follow', profileToken: a.profileToken }, REMOTE);
        await oneExpedition(a.port, 'E1');
        await settle();
        await oneExpedition(a.port, 'E2');
        await settle();
        // 遠征 3: 着いてすぐ、何も見えない所で待つ（相手が知覚しない確定: 1 回の待つは、その確定で 1 コマ。続けて待つマクロは、終わりに 1 コマ）
        expect((await act(a.port, { type: 'start_expedition', offer: 1 }, 'E3: 候補 1 で出る')).ok).toBe(true);
        for (let i = 0; i < 6; i++) await act(a.port, { type: 'wait' }, i ? undefined : 'E3: 少し歩く');
        await act(a.port, { type: 'wait', turns: 5 }, 'E3: しばらく待つ');
        const life = a.port.view().inventory.find((x) => x.kind === 'core:lifeline')?.slot;
        await act(a.port, { type: 'use', slot: life! } as Command, 'E3: 戻る');
        expect(a.port.view().status).toBe('at_camp');
        await settle();
        sp.close();
        const live = views(sp.msgs).slice(1);
        const auth = { ...REMOTE, authorization: `Bearer ${a.profileToken}` };
        const list = await getJson<ReviewListResponse>(base, `/api/runs/${a.session.runId}/review`, auth);
        expect(list.status).toBe(200);
        expect(list.cache).toBe('no-store');
        expect(list.body.expeditions.map((x) => x.no)).toEqual([1, 2, 3]);
        let unperceivedFrames = 0;
        expect(list.body.now?.state).toBe('at_camp');
        for (const x of list.body.expeditions) {
          const { pages, texts } = await allPages(base, a.session.runId, x.no, auth);
          const frames = pages.flatMap((p) => p.frames);
          // 最初のコマは、遠征を始める前（キャンプ）の見え方で、出来事なし
          expect(frames[0].events).toEqual([]);
          expect(frames[0].view.status).toBe('at_camp');
          const got = frames.slice(1);
          const lo = got[0].view.seq, hi = got[got.length - 1].view.seq;
          const want = live.filter((f) => f.view.seq >= lo && f.view.seq <= hi);
          expect(got.length, `expedition ${x.no}`).toBeGreaterThan(3);
          expect(got.map((f) => f.view.seq)).toEqual(want.map((f) => f.view.seq));
          unperceivedFrames += got.filter((f) => !f.events.length).length;
          for (let i = 0; i < got.length; i++) {
            expect(JSON.stringify(got[i].events), `exp ${x.no} frame ${i} events`).toBe(JSON.stringify(want[i].events));
            expect(canonicalHash(got[i].view), `exp ${x.no} frame ${i} view`).toBe(canonicalHash(want[i].view));
          }
          // その遠征の、届いた出来事の全部（その人の PlayerPort が受け取るものと同じ）
          const perceived = a.port.perceivedSince(frames[0].view.seq).filter((e) => e.seq <= hi);
          expect(JSON.stringify(got.flatMap((f) => f.events))).toBe(JSON.stringify(perceived));
          // 漏れない: シード・乱数の状態・鍵・World の形
          for (const t of texts) {
            expect(t.includes(SEED)).toBe(false);
            expect(t.includes(a.token)).toBe(false);
            expect(t.includes(a.profileToken)).toBe(false);
            // World にだけある項目（シードと見た目の表・乱数・プレイヤーの並び・出来事の届け先と伏せ字）。見え方と、届いた出来事には無い
            // （遠征の終わりの出来事のまとめの seed は、シーズンのランでは空: その場の観戦と同じ）
            for (const k of ['"secret"', '"rng"', '"appearances"', '"playerOrder"', '"seenBy"', '"masks"']) expect(t.includes(k), k).toBe(false);
            expect(t.includes('"seed":"s')).toBe(false);
          }
          // AI の呼び出しの記録: その遠征の命令の考え
          const thoughts = pages.flatMap((p) => p.agent).map((g) => g.args.thought);
          expect(thoughts).toContain(`E${x.no}: 候補 1 で出る`);
          expect(thoughts).toContain(`E${x.no}: 少し歩く`);
          expect(pages.flatMap((p) => p.agent).every((g) => g.playerId === a.playerId && g.text === '')).toBe(true);
          if (x.no < 3) expect(pages.flatMap((p) => p.agent).find((g) => g.tool === 'explore')?.args).toMatchObject({ max_steps: 12 });
        }
        // 相手が知覚しない確定のコマ（出来事の無いコマ）も、その場の観戦と同じ所で区切られていた（遠征 3 の待つ）
        expect(unperceivedFrames).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

describe('S17 3-6: delay, page limits, no writes, no waiting', () => {
  it('a delayed server does not return an expedition the live view has not shown yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17-'));
    try {
      // S17a: 遅れが 1 でも、遠征の終わりの確定（終わりの後の、次の候補の出来事まで）が見せた所を越えるので、見返せない。遅れ 0 なら見返せる
      for (const [delay, want] of [[100000, 0], [1, 0], [0, 1]] as const) {
        const m = manager(join(dir, String(delay)), { policy: 'delayed', delay });
        const r = await m.createRun({ name: 'Dot', controller: agent, seed: 's17-delay-1' });
        if ('error' in r) throw new Error(r.error.message);
        await oneExpedition(r.port, 'D');
        const list = await m.review.list(r.session.runId, { local: false });
        expect(list.ok).toBe(true);
        expect(list.ok ? list.body.expeditions.length : -1, `delay ${delay}`).toBe(want);
        const page = await m.review.page(r.session.runId, 1, { local: false });
        expect(page.ok, `delay ${delay}`).toBe(want === 1);
        m.closeAll();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it('pages are capped and chain to the same frames; concurrent builds are capped; nothing on disk and no live World changes; commands still go through meanwhile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      await oneExpedition(a.port, 'E1');
      const { app, port } = await listen(m);
      const base = `http://127.0.0.1:${port}`;
      try {
        const full = await allPages(base, a.session.runId, 1);
        expect(full.pages).toHaveLength(1);
        const allFrames = full.pages[0].frames;
        expect(allFrames.length).toBeGreaterThan(6);
        // コマの上限を小さくすると、続きの印で区切られ、つなぐと同じ並び（覚えた World からの続きと、作り直しの続きの両方）
        m.review.limits = { ...m.review.limits, pageFrames: 3 };
        const paged = await allPages(base, a.session.runId, 1);
        expect(paged.pages.length).toBeGreaterThan(2);
        expect(paged.pages.slice(1).every((p) => p.frames.length <= 3)).toBe(true);
        expect(paged.pages[0].frames.length).toBe(4);
        expect(JSON.stringify(paged.pages.flatMap((p) => p.frames))).toBe(JSON.stringify(allFrames));
        expect(JSON.stringify(paged.pages.flatMap((p) => p.agent))).toBe(JSON.stringify(full.pages[0].agent));
        expect(m.review.cached).toBeLessThanOrEqual(m.review.limits.cacheEntries);
        m.review.limits = { ...m.review.limits, cacheEntries: 0 };
        const rebuilt = await allPages(base, a.session.runId, 1);
        expect(JSON.stringify(rebuilt.pages.flatMap((p) => p.frames))).toBe(JSON.stringify(allFrames));
        expect(m.review.cached).toBe(0);
        // 知らない続きの印は断る
        const bad = await getJson(base, `/api/runs/${a.session.runId}/review/1?after=${paged.pages[0].frames[1].view.seq + 1}`);
        expect(bad.status).toBe(400);
        expect((await getJson(base, `/api/runs/${a.session.runId}/review/1?after=abc`)).status).toBe(400);
        expect((await getJson(base, `/api/runs/${a.session.runId}/review/9`)).status).toBe(404);

        // 書かない: 求めの前後で、置き場所（ランの記録・キーフレーム・プロフィール・シーズン）のファイルが 1 バイトも変わらない。ランの本体の World も
        m.review.limits = { ...REVIEW_LIMITS_OF(m), pageFrames: 2, sliceMs: 0 };
        const before = snapshotFiles(dir);
        const w0 = canonicalHash(a.session.world);
        await allPages(base, a.session.runId, 1);
        await getJson(base, `/api/runs/${a.session.runId}/review`);
        const after = snapshotFiles(dir);
        expect([...after.entries()]).toEqual([...before.entries()]);
        expect(canonicalHash(a.session.world)).toBe(w0);

        // 長い遠征（2）: 待つ手番をたくさん重ねて、作り直しに時間のかかる遠征にする
        expect((await act(a.port, { type: 'start_expedition', offer: 1 }, 'E2: 長く待つ')).ok).toBe(true);
        for (let i = 0; i < 250 && a.port.view().status === 'your_turn'; i++) await a.port.act({ type: 'wait' }, { source: 'bot' });
        const slot = a.port.view().inventory.find((x) => x.kind === 'core:lifeline')?.slot;
        expect(slot).toBeTruthy();
        await act(a.port, { type: 'use', slot: slot! } as Command, 'E2: 戻る');
        expect(a.port.view().status).toBe('at_camp');
        m.review.limits = { ...REVIEW_LIMITS_OF(m), pageFrames: 1000, sliceMs: 1 };
        const long = await allPages(base, a.session.runId, 2);
        expect(long.pages[0].frames.length).toBeGreaterThan(200);

        // 待たせない: 見返しの求め（譲りながら作る）の最中に、AI の命令と、ほかの HTTP の求めが通る。見返しは、それに乱されない
        const pending = getJson<ReviewPageResponse>(base, `/api/runs/${a.session.runId}/review/2`);
        await until(() => m.review.inFlight > 0);
        const st = await act(a.port, { type: 'start_expedition', offer: 1 }, 'E3: 見返しの最中に出る');
        expect(st.ok).toBe(true);
        expect((await a.port.act({ type: 'wait' }, { source: 'bot' })).ok).toBe(true);
        const health = await getJson<{ ok: boolean }>(base, '/api/health');
        expect(health.body.ok).toBe(true);
        // 命令と、ほかの求めは、見返しが終わる前に済んだ
        expect(m.review.inFlight).toBeGreaterThan(0);
        const got = await pending;
        expect(got.status).toBe(200);
        expect(JSON.stringify(got.body.frames)).toBe(JSON.stringify(long.pages[0].frames));
        // 進行中の遠征（3）は、一覧に無い。今の居場所は、迷宮の中
        const list = await getJson<ReviewListResponse>(base, `/api/runs/${a.session.runId}/review`);
        expect(list.body.expeditions.map((x) => x.no)).toEqual([1, 2]);
        expect(list.body.now).toEqual({ state: 'in_dungeon', expedition: 3 });
        expect((await getJson(base, `/api/runs/${a.session.runId}/review/3`)).status).toBe(404);

        // 同時に作る数の上限: 作る 1・待つ 1 にして、一度に 4 つ求めると、2 つは 503（断った求めは、何も作らない）
        m.review.limits = { ...REVIEW_LIMITS_OF(m), pageFrames: 1000, concurrent: 1, queued: 1, sliceMs: 0 };
        const burst = await Promise.all([0, 1, 2, 3].map(() => fetch(`${base}/api/runs/${a.session.runId}/review/2`).then(async (r) => { await r.arrayBuffer(); return r.status; })));
        expect(burst.filter((s) => s === 200).length).toBe(2);
        expect(burst.filter((s) => s === 503).length).toBe(2);
        expect(m.review.inFlight).toBe(0);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

describe('S17 7: a run that ended and is only on disk goes through the same gate', () => {
  it('after a restart, the owner (and the same PC) can look back on the ended run of a season in progress; others cannot; the thought carries no token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17-'));
    try {
      const m1 = manager(dir);
      openSeason(m1);
      const a = await seasonRun(m1, 'Aya');
      const b = await seasonRun(m1, 'Ben');
      const st = await act(a.port, { type: 'start_expedition', offer: 1 }, '出る');
      expect(st.ok).toBe(true);
      await act(a.port, { type: 'explore', maxSteps: 6 } as Command, `鍵 ${a.token} を書いてしまった`);
      expect((await act(a.port, { type: 'retire' }, '引退する')).ok).toBe(true);
      expect(a.session.world.status).toBe('ended');
      const runId = a.session.runId;
      // 起動し直す（終わったランは、動いているランにならない。記録だけ）
      m1.closeAll();
      const m2 = manager(dir);
      m2.recoverAll();
      expect(m2.get(runId)).toBeUndefined();
      const { app, port } = await listen(m2);
      const base = `http://127.0.0.1:${port}`;
      try {
        const before = snapshotFiles(dir);
        const own = { ...REMOTE, authorization: `Bearer ${a.profileToken}` };
        const list = await getJson<ReviewListResponse>(base, `/api/runs/${runId}/review`, own);
        expect(list.status, list.text).toBe(200);
        expect(list.body.expeditions.map((x) => x.no)).toEqual([1]);
        expect(list.body.now?.state).toBe('ended');
        const { pages, texts } = await allPages(base, runId, 1, own);
        const frames = pages.flatMap((p) => p.frames);
        expect(frames.length).toBeGreaterThan(2);
        expect(frames[frames.length - 1].view.runStatus).toBe('ended');
        const thoughts = pages.flatMap((p) => p.agent).map((g) => String(g.args.thought ?? ''));
        expect(thoughts).toContain('出る');
        expect(thoughts.some((t) => t.includes('••••'))).toBe(true);
        for (const t of texts) {
          expect(t.includes(a.token)).toBe(false);
          expect(t.includes(SEED)).toBe(false);
        }
        // 同じ PC からも見られる。ほかの冒険者の鍵・鍵なしの外からは断る
        expect((await getJson(base, `/api/runs/${runId}/review/1`)).status).toBe(200);
        expect((await getJson(base, `/api/runs/${runId}/review/1`, { ...REMOTE, authorization: `Bearer ${b.profileToken}` })).status).toBe(403);
        expect((await getJson(base, `/api/runs/${runId}/review`, REMOTE)).status).toBe(403);
        expect([...snapshotFiles(dir).entries()]).toEqual([...before.entries()]);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

function REVIEW_LIMITS_OF(m: SessionManager) {
  return { ...m.review.limits };
}

/** 条件が成り立つまで待つ（setImmediate で回す。成り立たなければ 3 秒で落とす） */
async function until(f: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > 3000) throw new Error('until: timed out');
    await new Promise((r) => setImmediate(r));
  }
}

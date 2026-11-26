// S17a（S17 の検査の指摘の直し）:
// B. 記録だけのランへの見返しは、軽いもの（meta.json とシーズンの記録）で門を決めてから、重い読み込みをする。断る求めでは読まない。門の答えは前と同じ
// C. 遅らせる観戦では、一覧の今の居場所を出さない（null）。遠征の終わりを含む確定が、見せた所を越えるなら、まだ見返せない
// E. 考えの文に書かれた、このサーバーの知っているトークン（プロフィールの鍵はハッシュと照らす）を伏せる: その場の観戦の記録・俯瞰の考えの出来事・見返し・巻き戻し
// G. 終わった自分のランの「見返す」: 観戦できるランの一覧の review（持ち主の鍵を示したときだけ）
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { commitEndIn, createApp, loadConfig, maskTokensDeep, maskTokensIn, SessionManager } from '@muse/server';
import type { App, PlayerPort } from '@muse/server';
import type { Command, CommandRecord, GameEvent, ReviewListResponse, ReviewPageResponse, SeasonWatchResponse, ServerMsg, SpectatorPolicy } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's17a';
const REMOTE = { 'x-forwarded-for': '203.0.113.9' };

function manager(runsDir: string, o: { policy?: SpectatorPolicy; delay?: number } = {}): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir, waitOthersMs: 100, ...(o.policy ? { spectatorPolicy: o.policy } : {}), ...(o.delay !== undefined ? { spectatorDelaySeq: o.delay } : {}) }));
}
function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S17a試し', seed: 's17a-seed-Hk3', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
async function seasonRun(m: SessionManager, name: string) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: SID, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return { ...r, profileToken: inv.token! };
}
async function listen(m: SessionManager): Promise<{ app: App; port: number; base: string }> {
  const app = createApp(m, m.config);
  await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
  const port = (app.server.address() as AddressInfo).port;
  return { app, port, base: `http://127.0.0.1:${port}` };
}
function get<T>(base: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: T; text: string }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: Number(u.port), method: 'GET', path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: T = null as T;
        try { body = (text ? JSON.parse(text) : null) as T; } catch { /* JSON の行など */ }
        resolve({ status: res.statusCode ?? 0, body, text });
      });
    });
    r.on('error', reject);
    r.end();
  });
}
const act = (port: PlayerPort, cmd: Command, thought?: string) => port.act(cmd, { source: 'mcp', ...(thought ? { thought } : {}) });

/** 遠征を 1 つ: 始める → 少し歩く → 帰還の綱で戻る */
async function oneExpedition(port: PlayerPort, tag: string): Promise<void> {
  expect((await act(port, { type: 'start_expedition', offer: 1 }, `${tag}: 出る`)).ok).toBe(true);
  await act(port, { type: 'explore', maxSteps: 8 } as Command, `${tag}: 歩く`);
  for (let i = 0; i < 12 && port.view().status !== 'at_camp'; i++) {
    const v = port.view();
    const me = v.self.pos;
    const foe = me ? v.entities.find((e) => e.cat === 'monster' && Math.max(Math.abs(e.pos.x - me.x), Math.abs(e.pos.y - me.y)) <= 1) : undefined;
    if (foe) { await act(port, { type: 'fight', target: foe.id } as Command); continue; }
    const slot = v.inventory.find((x) => x.kind === 'core:lifeline')?.slot;
    await act(port, slot ? ({ type: 'use', slot } as Command) : { type: 'wait' }, slot ? `${tag}: 戻る` : undefined);
  }
  expect(port.view().status).toBe('at_camp');
}

describe('S17a B: a run only on disk is gated with light reads first', () => {
  it('refused requests read neither the command log nor keyframes; the answers are the same as the gate fed from the join commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17a-'));
    try {
      const m1 = manager(dir);
      openSeason(m1);
      const a = await seasonRun(m1, 'Aya');
      const b = await seasonRun(m1, 'Ben');
      await oneExpedition(a.port, 'A1');
      expect((await act(a.port, { type: 'retire' })).ok).toBe(true);
      const runId = a.session.runId;
      m1.closeAll();
      const m2 = manager(dir);
      m2.recoverAll();
      expect(m2.get(runId)).toBeUndefined();
      const { app, base } = await listen(m2);
      try {
        // 前の門（参加の命令から読んだプロフィールで、同じ門の関数を通す）の答え
        const meta = JSON.parse(readFileSync(join(dir, runId, 'meta.json'), 'utf8')) as { players: { id: string }[] };
        const joins = new Map<string, string>();
        for (const line of readFileSync(join(dir, runId, 'commands.jsonl'), 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const r = JSON.parse(line) as CommandRecord;
          if (r.command.type === 'join' && r.assigned && r.command.profile) joins.set(r.assigned, r.command.profile);
        }
        const oldGate = (o: { local: boolean; profileToken?: string }) => m2.watchAccess({ seasonId: SID, players: meta.players.map((p) => p.id), profileOf: (p) => joins.get(p) ?? null }, o);
        const keys: Record<string, string | undefined> = { none: undefined, owner: a.profileToken, other: b.profileToken, unknown: 'not-a-real-token-xxxxxxxx' };
        let n = 0;
        for (const [kn, key] of Object.entries(keys)) {
          const origins: Record<string, Record<string, string>> = { same: {}, remote: REMOTE, origin: { origin: 'http://evil.example' } };
          for (const [on, hdr] of Object.entries(origins)) {
            const local = on === 'same';
            const want = !('error' in oldGate({ local, ...(key ? { profileToken: key } : {}) }));
            const before = m2.review.heavyReads;
            const auth: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
            const list = await get<ReviewListResponse>(base, `/api/runs/${runId}/review`, { ...hdr, ...auth });
            const page = await get<ReviewPageResponse>(base, `/api/runs/${runId}/review/1`, { ...hdr, ...auth });
            expect(list.status === 200, `${kn} ${on} list`).toBe(want);
            expect(page.status === 200, `${kn} ${on} page`).toBe(want);
            // 断る求めは、重い読み込み（命令の記録・キーフレーム）をしない
            if (!want) expect(m2.review.heavyReads, `${kn} ${on}`).toBe(before);
            n++;
          }
        }
        expect(n).toBe(12);
        // 通った求めは、重い読み込みをした（覚えた後は、読み直さない）
        expect(m2.review.heavyReads).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

describe('S17a C: the delayed live view', () => {
  it('no "now" while the live view is delayed; an expedition whose ending commit reaches past what the live view showed is not listed yet', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17a-'));
    try {
      const m1 = manager(dir);
      const r = await m1.createRun({ name: 'Dot', controller: agent, seed: 's17a-delay-1' });
      if ('error' in r) throw new Error(r.error.message);
      await oneExpedition(r.port, 'D');
      const runId = r.session.runId;
      const x = r.session.world.expeditions!.find((e) => e.no === 1)!;
      const endCommit = commitEndIn(r.session.history, x.endSeq!);
      // 遠征の終わりの確定には、終わりの後の出来事もある（次の遠征の候補など）
      expect(endCommit).toBeGreaterThan(x.endSeq!);
      const last = r.session.world.seq;
      m1.closeAll();
      // 見せた所が、遠征の終わりの出来事ちょうど（確定の途中）: まだ見返せない。今の居場所は出さない
      const m2 = manager(dir, { policy: 'delayed', delay: last - x.endSeq! });
      m2.recoverAll();
      const l2 = await m2.review.list(runId, { local: false });
      expect(l2.ok && l2.body.expeditions.length).toBe(0);
      expect(l2.ok && l2.body.now).toBeNull();
      expect((await m2.review.page(runId, 1, { local: false })).ok).toBe(false);
      m2.closeAll();
      // 見せた所が、終わりの確定の最後: 見返せる
      const m3 = manager(dir, { policy: 'delayed', delay: last - endCommit });
      m3.recoverAll();
      const l3 = await m3.review.list(runId, { local: false });
      expect(l3.ok && l3.body.expeditions.map((e) => e.no)).toEqual([1]);
      expect((await m3.review.page(runId, 1, { local: false })).ok).toBe(true);
      m3.closeAll();
      // 遅らせない観戦では、今の居場所を出す
      const m4 = manager(dir);
      m4.recoverAll();
      const l4 = await m4.review.list(runId, { local: false });
      expect(l4.ok && l4.body.now).toEqual({ state: 'at_camp', expedition: null });
      m4.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('S17a E: tokens written in a thought are masked wherever spectators can read them', () => {
  it('the mask function: only tokens the server knows, also inside a longer run of characters', () => {
    const known = new Set(['AbCdEfGhIjKlMnOpQrStUv12', 'zz_yy-xx_ww-vv_uu-tt_ss1']);
    const isTok = (c: string) => known.has(c);
    expect(maskTokensIn('鍵は AbCdEfGhIjKlMnOpQrStUv12 です', isTok)).toBe('鍵は •••• です');
    expect(maskTokensIn('xAbCdEfGhIjKlMnOpQrStUv12y', isTok)).toBe('x••••y');
    expect(maskTokensIn('普通の文 abcdefghijklmnopqrstuvwxyz0123', isTok)).toBe('普通の文 abcdefghijklmnopqrstuvwxyz0123');
    expect(maskTokensIn('短い', isTok)).toBe('短い');
    expect(maskTokensDeep({ a: ['zz_yy-xx_ww-vv_uu-tt_ss1'], b: 3 }, isTok)).toEqual({ a: ['••••'], b: 3 });
  });

  it('a profile key and a player token written in thoughts never reach the live agent records, the director thought events, the look-back, or the rewind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17a-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const { app, port, base } = await listen(m);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      try {
        // シーズンのラン（MCP から）: 招かれたプロフィールの鍵を、考えに書いてしまう
        const inv = m.seasons.invite(SID, 'Kai', m.profiles.store);
        if ('error' in inv) throw new Error(inv.error);
        const key = inv.token!;
        const nr = await client.callTool({ name: 'new_run', arguments: { character_name: 'Kai', season: SID, profile_token: key } }) as unknown as { structuredContent: { player_token: string; run_id: string } };
        const ptok = nr.structuredContent.player_token;
        const runId = nr.structuredContent.run_id;
        const seen: string[] = [];
        const orig = m.recordActivity.bind(m);
        m.recordActivity = (id, x) => { seen.push(JSON.stringify(x)); orig(id, x); };
        // プロフィールの鍵（サーバーはハッシュだけを持つ）: 文の中のその所だけを伏せる
        const st = await client.callTool({ name: 'start_expedition', arguments: { offer: 1, thought: `鍵は ${key} です`, player_token: ptok } }) as unknown as { isError?: boolean };
        expect(st.isError ?? false).toBe(false);
        // プレイヤーのトークン（前から、知っている値を含む文字列ごと伏せる: stripTokenArgs）
        await client.callTool({ name: 'explore', arguments: { max_steps: 3, thought: `トークン ${ptok}`, player_token: ptok } });
        // その場の観戦の記録（AI の呼び出しの記録）に、鍵もトークンも無い（伏せた印はある）
        expect(seen.length).toBeGreaterThan(0);
        for (const s of seen) { expect(s.includes(key)).toBe(false); expect(s.includes(ptok)).toBe(false); }
        expect(seen.some((s) => s.includes('••••'))).toBe(true);
        // 遠征を終えて、見返し: 考えの記録に、鍵もトークンも無い
        const s = m.get(runId)!;
        const pport = m.portForToken(ptok)!;
        for (let i = 0; i < 12 && pport.view().status !== 'at_camp'; i++) {
          const slot = pport.view().inventory.find((x) => x.kind === 'core:lifeline')?.slot;
          await pport.act(slot ? ({ type: 'use', slot } as Command) : { type: 'wait' }, { source: 'bot' });
        }
        expect(pport.view().status).toBe('at_camp');
        const page = await get<ReviewPageResponse>(base, `/api/runs/${runId}/review/1`, { ...REMOTE, authorization: `Bearer ${key}` });
        expect(page.status).toBe(200);
        expect(page.text.includes(key)).toBe(false);
        expect(page.text.includes(ptok)).toBe(false);
        // 求めの鍵は、前から、その値を含む文字列ごと伏せる。同じ PC から（求めに鍵が無い）でも、考えの中の鍵だけを伏せる（ハッシュと照らす）
        expect(page.body.agent.find((g) => g.tool === 'start_expedition')?.args.thought).toBe('••••');
        const localPage = await get<ReviewPageResponse>(base, `/api/runs/${runId}/review/1`);
        expect(localPage.status).toBe(200);
        expect(localPage.text.includes(key)).toBe(false);
        expect(localPage.body.agent.find((g) => g.tool === 'start_expedition')?.args.thought).toBe('鍵は •••• です');
        expect(seen.some((x) => x.includes('鍵は •••• です'))).toBe(true);
        // 記録そのものは、変えない（命令の記録の考えは、そのまま残る: 読む口で伏せる）
        expect(readFileSync(join(dir, s.runId, 'commands.jsonl'), 'utf8').includes(key)).toBe(true);

        // シーズンでないラン（俯瞰の観戦・巻き戻し）: 自分のプロフィールの鍵を考えに書いて、引退
        const pr = await m.createRun({ name: 'Lio', controller: agent, seed: 's17a-plain-mask' });
        if ('error' in pr) throw new Error(pr.error.message);
        const pkey = pr.profile.token!;
        const director = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const dmsgs: string[] = [];
        await new Promise<void>((res, rej) => {
          director.on('open', () => director.send(JSON.stringify({ t: 'hello', role: 'spectator', runId: pr.session.runId, mode: 'director' })));
          director.on('message', (d) => { dmsgs.push(String(d)); if ((JSON.parse(String(d)) as ServerMsg).t === 'snapshot') res(); });
          director.on('error', rej);
        });
        expect((await act(pr.port, { type: 'start_expedition', offer: 1 }, `私の鍵 ${pkey}`)).ok).toBe(true);
        // 迷宮の中の手の考えは、考えの出来事（thought）になり、俯瞰の観戦と巻き戻しの出来事・印に出る
        expect((await act(pr.port, { type: 'wait' }, `もう一度 ${pkey} を書く`)).ok).toBe(true);
        expect((await act(pr.port, { type: 'retire' })).ok).toBe(true);
        await new Promise((r) => setTimeout(r, 200));
        director.close();
        const thoughtsSeen = dmsgs.filter((x) => x.includes('"thought"'));
        expect(thoughtsSeen.length).toBeGreaterThan(0);
        for (const x of dmsgs) expect(x.includes(pkey)).toBe(false);
        for (const sub of ['events', 'commands', 'index']) {
          const r = await get<unknown>(base, `/api/runs/${pr.session.runId}/${sub}`);
          expect(r.status, sub).toBe(200);
          expect(r.text.includes(pkey), sub).toBe(false);
          expect(r.text.includes('••••'), sub).toBe(true);
        }
        // 出来事の記録（ファイル）は、そのまま（再生と照合は、記録だけで同じ）
        const ev = readFileSync(join(dir, pr.session.runId, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as GameEvent);
        expect(ev.some((e) => e.type === 'thought' && (e as { text: string }).text.includes(pkey))).toBe(true);
      } finally {
        await client.close();
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

describe('S17a G: the entrance for your own ended run', () => {
  it('the watch list carries review rows only for the owner key (not from the same PC, not for others), after a restart too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s17a-'));
    try {
      const m1 = manager(dir);
      openSeason(m1);
      const a = await seasonRun(m1, 'Aya');
      const b = await seasonRun(m1, 'Ben');
      await oneExpedition(a.port, 'A1');
      expect((await act(a.port, { type: 'retire' })).ok).toBe(true);
      const check = async (m: SessionManager) => {
        const { app, base } = await listen(m);
        try {
          const own = await get<SeasonWatchResponse>(base, `/api/seasons/${SID}/watch`, { ...REMOTE, authorization: `Bearer ${a.profileToken}` });
          expect(own.body.review).toEqual([{ runId: a.session.runId, expeditionsEnded: 1 }]);
          // 終わったランは、その場の観戦の一覧（runs）には入らない（今までどおり）
          expect(own.body.runs).toEqual([]);
          expect((await get<SeasonWatchResponse>(base, `/api/seasons/${SID}/watch`, { ...REMOTE, authorization: `Bearer ${b.profileToken}` })).body.review).toBeUndefined();
          expect((await get<SeasonWatchResponse>(base, `/api/seasons/${SID}/watch`, REMOTE)).body.review).toBeUndefined();
          // 同じ PC からは、巻き戻し（全体）で見返せるので、入れない
          expect((await get<SeasonWatchResponse>(base, `/api/seasons/${SID}/watch`)).body.review).toBeUndefined();
        } finally {
          await app.close();
        }
      };
      await check(m1);
      m1.closeAll();
      const m2 = manager(dir);
      m2.recoverAll();
      await check(m2);
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120000);
});

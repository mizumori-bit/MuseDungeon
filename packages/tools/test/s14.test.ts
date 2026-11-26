// S14（SEASON.md §65.4 の 2。版・World・出来事・命令の形・内容のデータは変えない）のテスト: 進め方の希望（持ち主の希望。プロフィールの控え）。
// self（既定）のときは、応答の文が今までと 1 字も変わらない／pilot のとき、キャンプの観測（伝言の次）と、遠征を始めた直後の応答に 1 行・self.owner_pace／
// 持ち主の口 POST …/owner/pace（認め方と守りは、ほかの持ち主の口と同じ。キャンプだけ・人間と協力プレイは断る・札は戻らない・出来事を足さない）／
// プロフィールに残り、新しい冒険に引き継ぐ／観戦の「AI の呼び出しの記録」には出る・ほかの参加者には出ない／規則の文／版の 3 つの値
import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, createMcpServer, loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { EVENT_VERSION, ownerPaceText } from '@muse/shared';
import type { Command } from '@muse/shared';
import { rulesText } from '../../server/src/mcp/rules';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };
const PACE_JA = ownerPaceText('ja');
const PACE_EN = ownerPaceText('en');

function manager(o: { dir?: string } = {}): SessionManager {
  return new SessionManager(content, loadConfig({ ...(o.dir ? { runsDir: o.dir } : { runsDir: null, profilesDir: null, seasonsDir: null }), waitOthersMs: 100 }));
}
async function campRun(m: SessionManager, seed: string, o: { profileToken?: string; controller?: typeof agent | { kind: 'human'; label: string }; endPrevious?: boolean; locale?: 'ja' | 'en' } = {}) {
  const r = await m.createRun({ name: 'Pa', seed, controller: o.controller ?? agent, ...(o.profileToken ? { profileToken: o.profileToken } : {}), ...(o.endPrevious ? { endPrevious: true } : {}), ...(o.locale ? { locale: o.locale } : {}) });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof campRun>>;
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const errCode = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? 'ok' : x.error!.code);
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect(errCode(await act(r.port, { type: 'use', slot: life.slot }))).toBe('ok');
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
/** 応答の文と観測（今の基準のまま。基準を進めない比べ用に、同じ作りのランで） */
const campText = (r: Run) => r.port.observeWithTurn('observed', { detail: 'full' }).text;

type R = { status: number; text: string; json: Record<string, any> | null };
function raw(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<R> {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(o.headers ?? {}), ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}) } }, (x) => {
      const cs: Buffer[] = [];
      x.on('data', (c) => cs.push(c as Buffer));
      x.on('end', () => { const text = Buffer.concat(cs).toString('utf8'); let json: R['json'] = null; try { json = JSON.parse(text); } catch { /* JSON でない */ } res({ status: x.statusCode!, text, json }); });
    });
    r.on('error', rej);
    if (o.body !== undefined) r.write(o.body);
    r.end();
  });
}
async function serve(m: SessionManager) {
  const app = createApp(m, m.config);
  await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
  const port = (app.server.address() as AddressInfo).port;
  return { port, close: async () => { await app.close(); } };
}
const J = { 'content-type': 'application/json' };
/** 同じ PC でない（運用者として認めない）要求の見出し */
const EXT = { 'x-forwarded-for': '203.0.113.9' };

describe('S14 §65.4 の 2: the pace wish (self by default changes nothing; pilot adds one line to the AI\'s own responses)', () => {
  it('self: not a character of the camp or the first expedition response changes; pilot: one line after the message at camp, and once right after starting', async () => {
    expect(ENGINE_VERSION).toBe('0.49.0');
    expect(EVENT_VERSION).toBe(37);
    // 同じシードの 2 つのラン: a は何もしない、b は pilot → self に戻す（既定と同じになる）
    const ma = manager();
    const mb = manager();
    const a = await campRun(ma, 's14-same');
    const b = await campRun(mb, 's14-same');
    expect(a.session.ownerPace(a.playerId)).toBe('self');
    expect(mb.profiles.setPace(b.profile.id, 'pilot')).toBe(true);
    expect(mb.profiles.setPace(b.profile.id, 'pilot')).toBe(false);
    expect(mb.profiles.setPace(b.profile.id, 'self')).toBe(true);
    expect(mb.profiles.store.get(b.profile.id)!.pace).toBeUndefined();
    const ta = campText(a);
    expect(campText(b)).toBe(ta);
    expect(ta).not.toContain('pilot');
    expect(a.port.observeWithTurn('observed').observation.self.owner_pace).toBeUndefined();
    const sa = await act(a.port, { type: 'start_expedition', offer: 1 });
    const sb = await act(b.port, { type: 'start_expedition', offer: 1 });
    expect(b.port.formatActionText(sb)).toBe(a.port.formatActionText(sa));
    expect(a.port.formatActionText(sa)).not.toContain('pilot');

    // pilot: キャンプの観測に 1 行（伝言の次）。構造化した項目にも
    const m = manager();
    const r = await campRun(m, 's14-pilot');
    expect(errCode(await r.session.submit(r.playerId, { type: 'set_directive', hold: [], message: 'ゆっくりでいい' }, { source: 'owner' }))).toBe('ok');
    const seq0 = r.session.world.seq;
    m.profiles.setPace(r.profile.id, 'pilot');
    // World は変わらない（出来事を足さない）
    expect(r.session.world.seq).toBe(seq0);
    const o = r.port.observeWithTurn('observed', { detail: 'full' });
    expect(o.observation.self.owner_pace).toEqual({ pace: 'pilot', text: PACE_JA });
    const lines = o.text.split('\n');
    const mi = lines.findIndex((l) => l.startsWith('持ち主から'));
    expect(mi).toBeGreaterThan(-1);
    expect(lines[mi + 1]).toBe(PACE_JA);
    expect(lines.filter((l) => l === PACE_JA)).toHaveLength(1);
    // 伝言が無くても、同じ場所（「できること」の後、区切りの段の前）に
    expect(errCode(await r.session.submit(r.playerId, { type: 'set_directive', hold: [], message: '' }, { source: 'owner' }))).toBe('ok');
    const o2 = r.port.observeWithTurn('observed', { detail: 'full' }).text.split('\n');
    const ai = o2.findIndex((l) => l.startsWith('できること'));
    expect(o2[ai + 1]).toBe(PACE_JA);
    // 遠征を始めた直後の応答に 1 回。次の応答には出ない（迷宮の中の観測には、構造化した値だけ）
    const st = await act(r.port, { type: 'start_expedition', offer: 1 });
    const stText = r.port.formatActionText(st);
    expect(stText.split('\n').filter((l) => l === PACE_JA)).toHaveLength(1);
    expect(st.ok && st.observation.self.owner_pace?.pace).toBe('pilot');
    const w1 = await act(r.port, { type: 'wait' });
    expect(r.port.formatActionText(w1)).not.toContain(PACE_JA);
    expect(w1.ok && w1.observation.self.owner_pace?.pace).toBe('pilot');
    // 帰ったキャンプにも出る
    await lifelineHome(r);
    expect(campText(r)).toContain(PACE_JA);
    // 持ち主の画面の写し（観測だけ）には付かない
    expect(r.port.observe({ detail: 'full' }).text).not.toContain(PACE_JA);
    // 英語
    const me = manager();
    const re = await campRun(me, 's14-en', { locale: 'en' });
    me.profiles.setPace(re.profile.id, 'pilot');
    expect(campText(re)).toContain(PACE_EN);
  });

  it('not for a human, nor once the run cannot start an expedition; the rules mention it (ja/en)', async () => {
    const m = manager();
    const h = await campRun(m, 's14-human', { controller: { kind: 'human', label: 'browser' } });
    m.profiles.setPace(h.profile.id, 'pilot');
    expect(h.session.ownerPace(h.playerId)).toBe('self');
    expect(campText(h)).not.toContain(PACE_JA);
    const ja = rulesText('directive', 'ja', catalog);
    const en = rulesText('directive', 'en', catalog);
    expect(ja).toContain('持ち主の希望（進め方。S14）');
    expect(ja).toContain('self.owner_pace');
    expect(en).toContain('Your owner\'s wish on how to play (S14)');
    expect(en).toContain('self.owner_pace');
  });
});

describe('S14 §65.4 の 2: the owner endpoint POST …/owner/pace', () => {
  it('same access and guards as the other owner endpoints; camp only; refuses humans and co-op; the ready flag stays; no events', async () => {
    const m = manager();
    const r = await campRun(m, 's14-http');
    const ptok = r.profile.token!;
    const s = await serve(m);
    const P = s.port;
    const here = `http://127.0.0.1:${P}`;
    const v = `/api/runs/${r.session.runId}/owner`;
    const post = (body: unknown, h: Record<string, string> = {}) => raw(P, 'POST', `${v}/pace`, { headers: { ...J, ...h }, body: JSON.stringify(body) });
    try {
      // 既定は self（持ち主の画面と一覧の行に）
      expect((await raw(P, 'GET', `${v}/view`)).json?.pace).toBe('self');
      const row0 = (await raw(P, 'GET', '/api/owner/runs')).json!.runs.find((x: { runId: string }) => x.runId === r.session.runId);
      expect(row0.pace).toBe('self');
      expect(row0.expeditionsEnded).toBe(0);
      // 守り: 別の Origin・JSON でない本文・持ち主と認められない（外から・トークンなし／違うトークン／プレイヤーのトークン）
      expect((await post({ pace: 'pilot' }, { origin: 'http://evil.example' })).status).toBe(403);
      expect((await raw(P, 'POST', `${v}/pace`, { headers: { 'content-type': 'text/plain' }, body: '{"pace":"pilot"}' })).status).toBe(415);
      expect((await post({ pace: 'pilot' }, EXT)).status).toBe(403);
      expect((await post({ pace: 'pilot' }, { ...EXT, authorization: 'Bearer nope' })).status).toBe(403);
      expect((await post({ pace: 'pilot' }, { ...EXT, authorization: `Bearer ${r.token}` })).status).toBe(403);
      expect((await raw(P, 'GET', `${v}/pace`)).status).toBe(405);
      expect(m.profiles.paceOf(r.profile.id)).toBe('self');
      // 形の違う値は断る（200 の result で。ほかの持ち主の口と同じ）
      for (const bad of ['fast', '', 1, null, ['pilot'], 'PILOT']) {
        const x = await post({ pace: bad });
        expect(x.status).toBe(200);
        expect(x.json?.result?.error?.code).toBe('bad_request');
      }
      // 外からでも、そのプレイヤーのプロフィールのトークンなら通る（同じ origin）
      const ok = await post({ pace: 'pilot' }, { ...EXT, authorization: `Bearer ${ptok}`, origin: here });
      expect(ok.status).toBe(200);
      expect(ok.json?.result).toEqual({ ok: true });
      expect(ok.json?.pace).toBe('pilot');
      expect(ok.text).not.toContain(ptok);
      expect(m.profiles.paceOf(r.profile.id)).toBe('pilot');
      // 同じ PC から: 戻す・また pilot
      expect((await post({ pace: 'self' })).json?.pace).toBe('self');
      expect((await post({ pace: 'pilot' })).json?.pace).toBe('pilot');
      expect((await raw(P, 'GET', '/api/owner/runs')).json!.runs.find((x: { runId: string }) => x.runId === r.session.runId).pace).toBe('pilot');

      // 札は戻らない・出来事を足さない（握っている: 目的を選んで準備完了）
      expect(errCode(await r.session.submit(r.playerId, { type: 'set_directive', hold: ['objective'] }, { source: 'owner' }))).toBe('ok');
      expect(errCode(await r.session.submit(r.playerId, { type: 'prepare', objective: 1, ready: true }, { source: 'owner' }))).toBe('ok');
      const seq = r.session.world.seq;
      const x = await post({ pace: 'self' });
      expect(x.json?.result).toEqual({ ok: true });
      expect(r.session.world.seq).toBe(seq);
      expect(r.session.world.players[r.playerId].directive?.prep?.state).toBe('ready');
      expect((await post({ pace: 'pilot' })).json?.result).toEqual({ ok: true });
      expect(r.session.world.seq).toBe(seq);
      // 準備完了の後の start_expedition（引数なし）の応答にも 1 回
      const st = await r.port.act({ type: 'start_expedition' } as Command, { source: 'bot' });
      expect(st.ok).toBe(true);
      expect(r.port.formatActionText(st).split('\n').filter((l) => l === PACE_JA)).toHaveLength(1);
      // 迷宮の中: not_at_camp（変わらない）
      const d = await post({ pace: 'self' });
      expect(d.json?.result?.error?.code).toBe('not_at_camp');
      expect(m.profiles.paceOf(r.profile.id)).toBe('pilot');

      // 人間が自分で潜る冒険者: 断る（一覧・持ち主の画面に値も出さない）
      const h = await campRun(m, 's14-http-h', { controller: { kind: 'human', label: 'browser' } });
      const hv = `/api/runs/${h.session.runId}/owner`;
      const hx = await raw(P, 'POST', `${hv}/pace`, { headers: J, body: JSON.stringify({ pace: 'pilot' }) });
      expect(hx.json?.result?.error?.code).toBe('bad_request');
      expect(hx.json?.pace).toBeUndefined();
      expect(m.profiles.paceOf(h.profile.id)).toBe('self');
      // 協力プレイ: 断る
      const c = await m.createRun({ name: 'Co', seed: 's14-coop', mode: 'coop', controller: agent });
      if ('error' in c) throw new Error(c.error.message);
      // 協力プレイのランは、持ち主の一覧に出ない（ソロだけ）が、口を直に呼んでも断る
      const cx = await raw(P, 'POST', `/api/runs/${c.session.runId}/owner/pace`, { headers: J, body: JSON.stringify({ pace: 'pilot' }) });
      expect(cx.json?.result?.error?.code).toBe('bad_request');
    } finally {
      await s.close();
    }
  });

  it('kept on the profile file; a new run of the same adventurer carries it; other participants never see it; the spectators\' call log may show it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's14-'));
    try {
      const m = manager({ dir });
      const r = await campRun(m, 's14-keep');
      const ptok = r.profile.token!;
      m.profiles.setPace(r.profile.id, 'pilot');
      const file = readdirSync(join(dir, 'profiles')).find((f) => f.startsWith(r.profile.id))!;
      expect(JSON.parse(readFileSync(join(dir, 'profiles', file), 'utf8')).pace).toBe('pilot');
      // 記録のファイル（ランの置き場所）には出ない（World に入れない）
      const runFiles = readdirSync(join(dir, r.session.runId));
      for (const f of runFiles) {
        if (f === 'tokens.json') continue;
        const p = join(dir, r.session.runId, f);
        try { expect(readFileSync(p, 'utf8')).not.toContain('"pace"'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EISDIR') throw e; }
      }
      // 新しい冒険（前の冒険を終えて）: そのまま pilot
      const r2 = await campRun(m, 's14-keep-2', { profileToken: ptok, endPrevious: true });
      expect(r2.session.ownerPace(r2.playerId)).toBe('pilot');
      expect(campText(r2)).toContain(PACE_JA);
      // ほかの冒険者（別のプロフィール）には出ない
      const other = await campRun(m, 's14-keep-3');
      expect(campText(other)).not.toContain(PACE_JA);
      // 観戦の「AI の呼び出しの記録」には出る（持ち主の様子と違い、隠す理由が無い）
      const [x, y] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
      await server.connect(x);
      const client = new Client({ name: 's14', version: '0' });
      await client.connect(y);
      await client.callTool({ name: 'observe', arguments: { player_token: r2.token } });
      expect(r2.session.agentActivity.at(-1)?.text).toContain(PACE_JA);
      await client.close();
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

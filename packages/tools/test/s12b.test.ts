// S12b（SEASON.md §63.7。PROTOCOL.md §9.15）のテスト: 拠点の運用者の口（名簿・シーズンを始める・冒険者を足す・鍵のある冒険者を加える）。
// ほかの PC から（接続元・Host・Origin・text/plain）は 4 つとも断る／確定していないシーズン・読めない記録があると開けない／
// 鍵は足したときの 1 回だけ（名簿・ほかの口・記録のファイルに無い）／シードは応答にも記録の 1 行にも無い／足した AI が、その鍵でシーズンのランを始められる
import http from 'node:http';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { cleanOpsName, opsOpenSeason } from '../../server/src/session/ops';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function manager(o: { disk?: boolean } = {}): { m: SessionManager; dir: string | null } {
  if (!o.disk) return { m: new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 })), dir: null };
  const dir = mkdtempSync(join(tmpdir(), 'muse-s12b-'));
  dirs.push(dir);
  return { m: new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100 })), dir };
}

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
  const J = { 'content-type': 'application/json' };
  return {
    port,
    get: (path: string, h: Record<string, string> = {}) => raw(port, 'GET', path, { headers: h }),
    post: (path: string, body: unknown, h: Record<string, string> = {}) => raw(port, 'POST', path, { headers: { ...J, ...h }, body: JSON.stringify(body) }),
    close: () => app.close(),
  };
}
/** その置き場所のすべてのファイルの中身（鍵・シードが、どこにも書かれていないことを見る） */
function allFiles(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else out.push({ path: p, text: readFileSync(p, 'utf8') });
    }
  };
  walk(dir);
  return out;
}
const openDef = (id: string, endsAt = Date.now() + 86_400_000) => ({ id, name: id, seed: `seed-${id}`, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 3000, endsAt, openedAt: Date.now() });

describe('S12b §63.7 の 1: the operator endpoints on the hub are for the server PC only', () => {
  it('from another PC (remote address, Host, Origin) all four are refused, and POSTs need JSON; nothing changes', async () => {
    const { m } = manager();
    // 鍵のあるプロフィール（ほかの PC から、鍵を付けても断る）
    const plain = await m.createRun({ name: 'Key', seed: 's12b-key', controller: agent });
    if ('error' in plain) throw new Error(plain.error.message);
    const key = plain.profile.token!;
    const s = await serve(m);
    const P = s.port;
    const ext = { 'x-forwarded-for': '203.0.113.9' };
    const reb = { host: `rebind.evil.example:${P}` };
    const evil = { origin: 'http://evil.example' };
    try {
      for (const h of [ext, reb, evil, { ...ext, authorization: `Bearer ${key}` }]) {
        expect((await s.get('/api/ops/roster', h)).status).toBe(403);
        expect((await s.post('/api/ops/season', {}, h)).status).toBe(403);
        expect((await s.post('/api/ops/adventurers', { name: 'X', kind: 'ai' }, h)).status).toBe(403);
        expect((await s.post('/api/ops/enroll', {}, { ...h, authorization: `Bearer ${key}` })).status).toBe(403);
      }
      // text/plain（フォーム・no-cors の fetch と同じ形）: 415。同じ PC からでも
      for (const p of ['/api/ops/season', '/api/ops/adventurers', '/api/ops/enroll']) {
        expect((await raw(P, 'POST', p, { headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
      }
      // 違うメソッド
      expect((await raw(P, 'GET', '/api/ops/season')).status).toBe(405);
      expect((await s.post('/api/ops/roster', {})).status).toBe(405);
      expect(m.seasons.store.ids()).toEqual([]);
      // 同じ PC から（Origin の無い道具・同じ origin の画面）は通る
      expect((await s.get('/api/ops/roster')).status).toBe(200);
      expect((await s.get('/api/ops/roster', { origin: `http://127.0.0.1:${P}` })).json?.canOpen).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('S12b §63.7 の 1: starting a season from the hub', () => {
  it('opens with defaults (id s<N>, "シーズン<N>", 7 days, 3000); the seed is in no response and no log line; refuses while a season is unresolved', async () => {
    const { m, dir } = manager({ disk: true });
    const s = await serve(m);
    try {
      const r0 = (await s.get('/api/ops/roster')).json!;
      expect(r0).toMatchObject({ season: null, roster: [], pending: [], canOpen: true, next: { id: 's1', number: 1, name: 'シーズン1', days: 7, budget: 3000 } });
      const t0 = Date.now();
      const a = await s.post('/api/ops/season', {});
      expect(a.status).toBe(200);
      expect(a.json!.season).toMatchObject({ id: 's1', name: 'シーズン1', budget: 3000 });
      expect(a.json!.season.endsAt).toBeGreaterThanOrEqual(t0 + 7 * 86_400_000);
      expect(a.json!.season.endsAt).toBeLessThan(t0 + 7 * 86_400_000 + 60_000);
      const seed = m.seasons.get('s1')!.def.seed;
      expect(seed.length).toBeGreaterThanOrEqual(20);
      expect(a.text).not.toContain(seed);
      expect(a.text).not.toContain('seed');
      // 記録の 1 行（log.jsonl）にも写さない。持つのは season.json だけ
      for (const f of allFiles(dir!)) {
        if (f.path.endsWith('season.json')) continue;
        expect(f.text).not.toContain(seed);
      }
      expect(readFileSync(join(dir!, 'seasons', 's1', 'log.jsonl'), 'utf8')).toContain('"opened"');
      // ほかの口にも無い
      for (const p of ['/api/seasons', '/api/seasons/s1', '/api/ops/roster', '/api/runs']) expect((await s.get(p)).text).not.toContain(seed);
      // 開催中のシーズンがあると、開かない（画面からは閉じられない）
      const b = await s.post('/api/ops/season', { name: 'もう一つ' });
      expect(b.status).toBe(409);
      expect(b.json!.error.message).toContain('開催中のシーズンがある。閉じるのは、運用の道具で');
      const r1 = (await s.get('/api/ops/roster')).json!;
      expect(r1).toMatchObject({ season: { id: 's1', name: 'シーズン1' }, canOpen: false, pending: [] });
      expect(r1.next).toBeUndefined();
      // 終わりの時刻を過ぎて、確定を待っているシーズンも（確定していないので）
      m.seasons.get('s1')!.def.endsAt = Date.now() - 1000;
      const r2 = (await s.get('/api/ops/roster')).json!;
      expect(r2).toMatchObject({ season: null, pending: [{ id: 's1', name: 'シーズン1' }], canOpen: false });
      expect((await s.post('/api/ops/season', {})).status).toBe(409);
      // 確定すれば、開ける（次の ID と名前）
      m.seasons.finalize(m.seasons.get('s1')!, 'operator');
      const c = await s.post('/api/ops/season', { name: '  冬の\u0007坑​  ', days: 3, budget: 500 });
      expect(c.status).toBe(200);
      expect(c.json!.season).toMatchObject({ id: 's2', name: '冬の坑', budget: 500 });
      // 読めない本文では開かない
      m.seasons.finalize(m.seasons.get('s2')!, 'operator');
      expect((await raw(s.port, 'POST', '/api/ops/season', { headers: { 'content-type': 'application/json' }, body: '{nope' })).status).toBe(400);
      expect((await raw(s.port, 'POST', '/api/ops/season', { headers: { 'content-type': 'application/json' }, body: '[1]' })).status).toBe(400);
      expect(m.seasons.store.ids()).toEqual(['s1', 's2']);
    } finally {
      await s.close();
    }
  });

  it('a season whose records cannot be read blocks opening (as in S9b)', async () => {
    const { m, dir } = manager({ disk: true });
    mkdirSync(join(dir!, 'seasons', 'sx'), { recursive: true });
    writeFileSync(join(dir!, 'seasons', 'sx', 'season.json'), '{broken');
    const s = await serve(m);
    try {
      const r = (await s.get('/api/ops/roster')).json!;
      expect(r).toMatchObject({ canOpen: false, broken: true });
      const a = await s.post('/api/ops/season', {});
      expect(a.status).toBe(409);
      expect(a.json!.error.message).toContain('記録が読めないシーズン（sx）');
      expect(m.seasons.store.ids()).toEqual(['sx']);
    } finally {
      await s.close();
    }
  });

  it('limits: days 1-60, budget 100-20000 (integers), name up to 32 characters with control characters dropped; the default number skips used ids and names', () => {
    const { m } = manager();
    for (const days of [0, 61, 1.5, '7', -1]) expect(opsOpenSeason(m, { days }).status).toBe(400);
    for (const budget of [99, 20_001, 300.5, '3000']) expect(opsOpenSeason(m, { budget }).status).toBe(400);
    expect(opsOpenSeason(m, { name: 'あ'.repeat(33) }).status).toBe(400);
    expect(opsOpenSeason(m, { name: 3 }).status).toBe(400);
    expect(m.seasons.store.ids()).toEqual([]);
    expect(cleanOpsName('‮名前\u0000\r\n')).toBe('名前');
    // 32 字ちょうど・端の値は通る
    const ok = opsOpenSeason(m, { name: '𠮷'.repeat(32), days: 60, budget: 20_000 });
    expect(ok.status).toBe(200);
    // s0〜s4 があれば s5。「シーズン6」という名前が既にあれば、6 は飛ばす
    const { m: m2 } = manager();
    for (const id of ['s0', 's1', 's2', 's3', 's4']) { m2.seasons.store.open(openDef(id)); m2.seasons.finalize(m2.seasons.get(id)!, 'operator'); }
    expect(m2.seasons.nextDefault()).toEqual({ id: 's5', number: 5, name: 'シーズン5' });
    m2.seasons.store.open({ ...openDef('t9'), name: 'シーズン5' });
    m2.seasons.finalize(m2.seasons.get('t9')!, 'operator');
    expect(m2.seasons.nextDefault()).toEqual({ id: 's6', number: 6, name: 'シーズン6' });
  });
});

describe('S12b §63.7 の 1: adding adventurers and the roster', () => {
  it('an AI: the key comes once; the roster and other endpoints never carry it; the AI starts a season run with that key', async () => {
    const { m, dir } = manager({ disk: true });
    const s = await serve(m);
    try {
      // シーズンが無いと足せない
      expect((await s.post('/api/ops/adventurers', { name: 'ミュゼ美', kind: 'ai' })).status).toBe(409);
      expect((await s.post('/api/ops/season', {})).status).toBe(200);
      const a = await s.post('/api/ops/adventurers', { name: ' ミュゼ美 ', kind: 'ai' });
      expect(a.status).toBe(200);
      expect(a.json).toMatchObject({ seasonId: 's1', name: 'ミュゼ美', kind: 'ai' });
      const key = a.json!.profileToken as string;
      expect(key.length).toBeGreaterThanOrEqual(20);
      expect(a.json!.runId).toBeUndefined();
      // 同じシーズンで同じ名前は断る・kind が違う・名前が無い
      expect((await s.post('/api/ops/adventurers', { name: 'みゅぜ美'.replace('みゅぜ', 'ミュゼ'), kind: 'ai' })).status).toBe(400);
      expect((await s.post('/api/ops/adventurers', { name: 'X', kind: 'bot' })).status).toBe(400);
      expect((await s.post('/api/ops/adventurers', { name: '\u0000 ', kind: 'ai' })).status).toBe(400);
      expect((await s.post('/api/ops/adventurers', { name: 'い'.repeat(33), kind: 'ai' })).status).toBe(400);
      const ros = await s.get('/api/ops/roster');
      expect(ros.json!.roster).toEqual([{ name: 'ミュゼ美', profileId: a.json!.profileId, kind: 'ai', runs: 0, used: 0, budget: 3000, died: false, runId: null }]);
      // 鍵は、名簿・ほかの口・記録のファイルのどこにも無い（プロフィールのファイルはハッシュだけ）
      for (const p of ['/api/ops/roster', '/api/seasons', '/api/seasons/s1', '/api/runs', '/api/owner/runs', '/api/seasons/s1/watch']) expect((await s.get(p)).text).not.toContain(key);
      for (const f of allFiles(dir!)) expect(f.text).not.toContain(key);
      // その鍵で、シーズンのランを始められる（MCP の new_run { season, profile_token } と同じ口）
      const run = await m.createRun({ name: 'ミュゼ美', season: 's1', profileToken: key, controller: agent });
      if ('error' in run) throw new Error(run.error.message);
      expect(run.session.world.meta.season?.id).toBe('s1');
      const after = (await s.get('/api/ops/roster')).json!.roster[0];
      expect(after).toMatchObject({ name: 'ミュゼ美', kind: 'ai', runs: 1, runId: run.session.runId });
      // その鍵のプロフィールの招きは、拠点の札と同じ（GET /api/profile の seasons）
      const prof = await s.get('/api/profile', { authorization: `Bearer ${key}` });
      expect(prof.json!.seasons.map((x: { id: string }) => x.id)).toEqual(['s1']);
      for (const f of allFiles(dir!)) expect(f.text).not.toContain(key);
    } finally {
      await s.close();
    }
  });

  it('going down yourself: a human run of that season and class starts at once, with the same values as POST /api/runs plus the key', async () => {
    const { m } = manager();
    const s = await serve(m);
    try {
      expect((await s.post('/api/ops/season', { budget: 800 })).status).toBe(200);
      // 知らない職は、何も作らずに断る（名簿に残らない）
      expect((await s.post('/api/ops/adventurers', { name: 'カエデ', kind: 'human', classId: 'core:nope' })).status).toBe(400);
      expect(m.seasons.store.invites('s1')).toEqual([]);
      const a = await s.post('/api/ops/adventurers', { name: 'カエデ', kind: 'human', classId: 'core:warrior', locale: 'en' });
      expect(a.status).toBe(200);
      const b = a.json!;
      expect(b).toMatchObject({ seasonId: 's1', name: 'カエデ', kind: 'human' });
      for (const k of ['runId', 'playerId', 'token', 'profileToken', 'profileId']) expect(typeof b[k]).toBe('string');
      const sess = m.get(b.runId)!;
      const pr = sess.world.players[b.playerId];
      expect(pr.controller.kind).toBe('human');
      expect(pr.classId).toBe('core:warrior');
      expect(pr.locale).toBe('en');
      expect(sess.world.meta.season?.id).toBe('s1');
      expect(sess.playerForToken(b.token)).toBe(b.playerId);
      expect(sess.profileOf(b.playerId)).toBe(b.profileId);
      const r = (await s.get('/api/ops/roster')).json!;
      expect(r.season).toMatchObject({ id: 's1', budget: 800 });
      expect(r.roster).toEqual([expect.objectContaining({ name: 'カエデ', kind: 'human', runs: 1, runId: b.runId, budget: 800 })]);
      expect(JSON.stringify(r)).not.toContain(b.token);
      expect(JSON.stringify(r)).not.toContain(b.profileToken);
      // 運用の道具で招いた者（種類が無い）は、ランの操作の種類で埋める（まだ始めていなければ null）
      const inv = m.seasons.invite('s1', 'ナギ', m.profiles.store);
      if ('error' in inv) throw new Error(inv.error);
      expect((await s.get('/api/ops/roster')).json!.roster[1]).toMatchObject({ name: 'ナギ', kind: null, runs: 0 });
      const nr = await m.createRun({ name: 'ナギ', season: 's1', profileToken: inv.token!, controller: agent });
      if ('error' in nr) throw new Error(nr.error.message);
      expect((await s.get('/api/ops/roster')).json!.roster[1]).toMatchObject({ name: 'ナギ', kind: 'ai', runs: 1 });
    } finally {
      await s.close();
    }
  });

  it('enrolling a key kept in this browser: joins the current season (already invited is fine); the key goes only in the header', async () => {
    const { m } = manager();
    const plain = await m.createRun({ name: 'ヒイラギ', seed: 's12b-enroll', controller: agent });
    if ('error' in plain) throw new Error(plain.error.message);
    const key = plain.profile.token!;
    const s = await serve(m);
    try {
      // 開催中のシーズンが無い
      expect((await s.post('/api/ops/enroll', {}, { authorization: `Bearer ${key}` })).status).toBe(409);
      expect((await s.post('/api/ops/season', {})).status).toBe(200);
      expect((await s.post('/api/ops/enroll', {})).status).toBe(401);
      expect((await s.post('/api/ops/enroll', {}, { authorization: 'Bearer nope' })).status).toBe(401);
      // 本文の profileToken は受けない（見出しだけ）
      expect((await s.post('/api/ops/enroll', { profileToken: key })).status).toBe(401);
      const a = await s.post('/api/ops/enroll', {}, { authorization: `Bearer ${key}` });
      expect(a.status).toBe(200);
      expect(a.json).toEqual({ seasonId: 's1', name: 'ヒイラギ', profileId: plain.profile.id });
      expect(a.text).not.toContain(key);
      const again = await s.post('/api/ops/enroll', { name: '別の名前' }, { authorization: `Bearer ${key}` });
      expect(again.json).toEqual({ seasonId: 's1', name: 'ヒイラギ', profileId: plain.profile.id, already: true });
      expect((await s.get('/api/ops/roster')).json!.roster.map((x: { name: string }) => x.name)).toEqual(['ヒイラギ']);
      // 名前を変えて加える・重なる名前は断る
      const other = await m.createRun({ name: 'Two', seed: 's12b-enroll2', controller: agent });
      if ('error' in other) throw new Error(other.error.message);
      expect((await s.post('/api/ops/enroll', { name: 'ひいらぎ'.replace('ひいらぎ', 'ヒイラギ') }, { authorization: `Bearer ${other.profile.token!}` })).status).toBe(400);
      const b = await s.post('/api/ops/enroll', { name: 'ツバキ' }, { authorization: `Bearer ${other.profile.token!}` });
      expect(b.json).toMatchObject({ name: 'ツバキ' });
      // 加えた冒険者は、その鍵でシーズンのランを始められる（前の続きのあるランは end_previous で）
      const run = await m.createRun({ name: 'ツバキ', season: 's1', profileToken: other.profile.token!, controller: agent, endPrevious: true });
      expect('error' in run).toBe(false);
    } finally {
      await s.close();
    }
  });
});

// S12c（S12b の検査の指摘）のテスト: 職の検査を Object.prototype の名前がすり抜けない（拠点の口・POST /api/runs・…/join・MCP の new_run・join_run）／
// 何も残さない（招き・プロフィール・プレイヤーのいないラン）／500 と MCP の中の例外の文を返さない／名前を整える 1 つの関数／招きの上限／招きの取り消し
import http from 'node:http';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, createMcpServer, INVITE_MAX, loadConfig, normalizeName, SessionManager } from '@muse/server';
import { seasonCli } from '../src/season';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const PROTO = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function disk(): { m: SessionManager; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'muse-s12c-'));
  dirs.push(dir);
  return { m: new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100 })), dir };
}
const mem = () => new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
const profileFiles = (dir: string) => readdirSync(join(dir, 'profiles')).filter((f) => f.startsWith('prof_')).length;
const runDirs = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('run_'));

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
  return {
    port,
    get: (path: string, h: Record<string, string> = {}) => raw(port, 'GET', path, { headers: h }),
    post: (path: string, body: unknown, h: Record<string, string> = {}) => raw(port, 'POST', path, { headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) }),
    close: () => app.close(),
  };
}
async function mcp(m: SessionManager) {
  const [x, y] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
  await server.connect(x);
  const client = new Client({ name: 's12c', version: '0' });
  await client.connect(y);
  return client;
}
type ToolOut = { isError?: boolean; content: { text: string }[]; structuredContent?: { error?: { code: string } } };
const openSeason = (m: SessionManager, id = 's1') => m.seasons.store.open({ id, name: id, seed: `seed-${id}`, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 3000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });

describe('S12c 1: names on Object.prototype are not classes; nothing is left behind', () => {
  it('the hub, POST /api/runs, POST …/join, MCP new_run and join_run refuse them as bad requests, with no run, profile or invitation left', async () => {
    const { m, dir } = disk();
    openSeason(m);
    const coop = await m.createRun({ name: 'Host', seed: 's12c-coop', mode: 'coop', controller: agent });
    if ('error' in coop) throw new Error(coop.error.message);
    const s = await serve(m);
    const client = await mcp(m);
    const runs0 = m.sessions.size;
    const profs0 = profileFiles(dir);
    const dirs0 = runDirs(dir).length;
    try {
      for (const cls of PROTO) {
        const a = await s.post('/api/ops/adventurers', { name: `H-${cls}`, kind: 'human', classId: cls });
        expect(a.status).toBe(400);
        expect(a.json!.error.code).toBe('bad_request');
        const b = await s.post('/api/runs', { name: 'X', classId: cls });
        expect(b.status).toBe(400);
        expect(b.json!.error.code).toBe('bad_request');
        expect(b.json!.error.message).toBe(`unknown class ${cls}`);
        const sr = await s.post('/api/runs', { name: 'X', classId: cls, season: 's1' });
        expect(sr.status).toBe(400);
        const j = await s.post(`/api/runs/${coop.session.runId}/join`, { name: 'X', classId: cls });
        expect(j.status).toBe(400);
        const n = (await client.callTool({ name: 'new_run', arguments: { character_name: 'X', class: cls } })) as unknown as ToolOut;
        expect(n.isError).toBe(true);
        expect(n.structuredContent?.error?.code).toBe('bad_request');
        const jr = (await client.callTool({ name: 'join_run', arguments: { run_id: coop.session.runId, character_name: 'X', class: cls } })) as unknown as ToolOut;
        expect(jr.isError).toBe(true);
        expect(jr.content[0].text).not.toContain('is not iterable');
      }
      expect(m.sessions.size).toBe(runs0);
      expect(coop.session.world.playerOrder.length).toBe(1);
      expect(profileFiles(dir)).toBe(profs0);
      expect(runDirs(dir).length).toBe(dirs0);
      expect(m.seasons.store.invites('s1')).toEqual([]);
      for (const x of m.sessions.values()) expect(x.world.playerOrder.length).toBeGreaterThan(0);
      // 知っている職は、今までどおり通る
      expect((await s.post('/api/runs', { name: 'Ok', classId: 'core:scout' })).status).toBe(200);
    } finally {
      await client.close();
      await s.close();
    }
  });

  it('an exception while joining leaves no run without players; the 500 and the MCP error carry a fixed text, not the inner message', async () => {
    const { m, dir } = disk();
    openSeason(m);
    const s = await serve(m);
    const client = await mcp(m);
    const store = m.profiles.store as unknown as { create: (...a: unknown[]) => unknown };
    const realCreate = store.create.bind(store);
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { errs.push(a.map(String).join(' ')); };
    try {
      store.create = () => { throw new Error('boom at C:\\secret\\place'); };
      const runs0 = m.sessions.size;
      const a = await s.post('/api/runs', { name: 'Boom', controller: agent });
      expect(a.status).toBe(500);
      expect(a.json!.error.message).toBe('内部のエラー（詳細はサーバーのログ） / internal error (details are in the server log)');
      expect(a.text).not.toContain('boom');
      expect(a.text).not.toContain('secret');
      expect(m.sessions.size).toBe(runs0);
      expect(runDirs(dir)).toEqual([]);
      // MCP: ツールの中の例外も、決まった文（SDK のままだと、例外の文がそのまま返る）
      const n = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Boom' } })) as unknown as ToolOut;
      expect(n.isError).toBe(true);
      expect(n.content[0].text).toContain('内部のエラー');
      expect(n.content[0].text).not.toContain('boom');
      expect(m.sessions.size).toBe(runs0);
      // 拠点の「自分で潜る」: 招きを取り消してから 500（鍵は返さない）
      const realRun = m.createRun.bind(m);
      store.create = realCreate;
      (m as unknown as { createRun: unknown }).createRun = async () => { throw new Error('boom inside createRun'); };
      const h = await s.post('/api/ops/adventurers', { name: 'カエデ', kind: 'human', classId: 'core:warrior' });
      expect(h.status).toBe(500);
      expect(h.text).not.toContain('boom');
      expect(h.json!.profileToken).toBeUndefined();
      expect(m.seasons.store.invites('s1')).toEqual([]);
      (m as unknown as { createRun: unknown }).createRun = realRun;
      // 詳細は、サーバーのログに
      expect(errs.some((x) => x.includes('boom at C:'))).toBe(true);
      expect(errs.some((x) => x.includes('boom inside createRun'))).toBe(true);
    } finally {
      console.error = origErr;
      store.create = realCreate;
      await client.close();
      await s.close();
    }
  });
});

describe('S12c 2: one function shapes every name', () => {
  it('clean → NFKC → clean → trim → count code points; too long is refused, not cut; broken characters and empty names are refused', () => {
    expect(normalizeName('  ミュゼ美  ')).toEqual({ ok: true, name: 'ミュゼ美' });
    expect(normalizeName('ＡＢＣ１')).toEqual({ ok: true, name: 'ABC1' });
    // NFKC で伸びる名前は、黙って切らない
    const kabu = String.fromCodePoint(0x337f).repeat(20);
    expect(normalizeName(kabu)).toMatchObject({ ok: false, reason: 'too_long' });
    expect(normalizeName(String.fromCodePoint(0x337f).repeat(8))).toEqual({ ok: true, name: '株式会社'.repeat(8) });
    // 32 字（コードポイント）ちょうどの絵文字は通り、末尾が壊れない
    const emoji = String.fromCodePoint(0x1f409).repeat(32);
    expect(normalizeName(emoji)).toEqual({ ok: true, name: emoji });
    expect(normalizeName(emoji + 'x')).toMatchObject({ ok: false, reason: 'too_long' });
    // 対になっていないサロゲート
    expect(normalizeName(`a${String.fromCharCode(0xd800)}`)).toMatchObject({ ok: false, reason: 'broken' });
    expect(normalizeName(`${String.fromCharCode(0xdc00)}b`)).toMatchObject({ ok: false, reason: 'broken' });
    // 見えない文字の表（足したもの）: だけの名前は空、混じっていれば落ちる
    const invisible = [0x3164, 0x1160, 0x115f, 0x00ad, 0xfe0f, 0xfe00, 0xe0001, 0xe0041, 0xe007f, 0xe0100, 0x200b, 0x202e, 0x2066, 0xfeff, 0x034f, 0x061c, 0x180e, 0xffa0, 0x2800];
    for (const cp of invisible) {
      expect(normalizeName(String.fromCodePoint(cp))).toMatchObject({ ok: false, reason: 'empty' });
      expect(normalizeName(`ナ${String.fromCodePoint(cp)}ギ`)).toEqual({ ok: true, name: 'ナギ' });
    }
    expect(normalizeName(3)).toMatchObject({ ok: false, reason: 'not_string' });
  });

  it('invite (the operator tool too) and the hub refuse a name that is too long or broken; existing invitations are still read as they are', async () => {
    const { m, dir } = disk();
    openSeason(m);
    const kabu = String.fromCodePoint(0x337f).repeat(20);
    expect(m.seasons.invite('s1', kabu, m.profiles.store)).toEqual({ error: expect.stringContaining('32 字まで') });
    expect(m.seasons.invite('s1', `x${String.fromCharCode(0xd800)}`, m.profiles.store)).toEqual({ error: expect.stringContaining('壊れた文字') });
    expect(m.seasons.invite('s1', String.fromCodePoint(0x3164), m.profiles.store)).toEqual({ error: expect.stringContaining('名前が空') });
    // 運用の道具: 断りの文を出して 1
    const logs: string[] = [];
    expect(seasonCli(content, { sub: 'invite', dir: join(dir, 'seasons'), profilesDir: join(dir, 'profiles'), id: 's1', name: kabu }, (x) => logs.push(x))).toBe(1);
    expect(logs.join('\n')).toContain('32 字まで');
    expect(seasonCli(content, { sub: 'open', dir: join(dir, 'seasons'), id: 's9', seed: 'x', ends: new Date(Date.now() + 86_400_000).toISOString(), name: kabu }, (x) => logs.push(x))).toBe(1);
    // 拠点の口も同じ関数
    const s = await serve(m);
    try {
      const a = await s.post('/api/ops/adventurers', { name: kabu, kind: 'ai' });
      expect(a.status).toBe(400);
      expect(a.json!.error.message).toContain('32 字まで');
      expect(m.seasons.store.invites('s1')).toEqual([]);
      // 今ある招き（前の版で書いた、33 字の名前）は、読むときには検査しない: 名簿に出て、その鍵でランを始められる
      const long = 'あ'.repeat(33);
      const p = m.profiles.store.create('old', Date.now());
      writeFileSync(join(dir, 'seasons', 's1', 'invites.json'), JSON.stringify([{ profileId: p.profile.id, name: long, invitedAt: 1 }]));
      expect((await s.get('/api/ops/roster')).json!.roster.map((x: { name: string }) => x.name)).toEqual([long]);
      const run = await m.createRun({ name: 'old', season: 's1', profileToken: p.token, controller: agent });
      expect('error' in run).toBe(false);
      // 冒険者の名前（new_run の character_name・POST /api/runs の name）も同じ関数: NFKC・見えない文字だけは断る・空は今までどおり Muse
      const n1 = await m.createRun({ name: 'ＡＢＣ', controller: agent });
      if ('error' in n1) throw new Error(n1.error.message);
      expect(n1.session.world.players[n1.playerId].name).toBe('ABC');
      const n2 = await m.createRun({ name: String.fromCodePoint(0x3164, 0x200b), controller: agent });
      expect('error' in n2 && n2.error.code).toBe('bad_request');
      const n3 = await m.createRun({ name: '', controller: agent });
      if ('error' in n3) throw new Error(n3.error.message);
      expect(n3.session.world.players[n3.playerId].name).toBe('Muse');
      expect((await s.post('/api/runs', { name: kabu })).status).toBe(400);
      // プロフィールの名前の変え方も
      expect((await s.post('/api/profile', { name: kabu }, { authorization: `Bearer ${n1.profile.token}` })).status).toBe(400);
      expect((await s.post('/api/profile', { name: ' ＭＩＮＡ ' }, { authorization: `Bearer ${n1.profile.token}` })).json!.name).toBe('MINA');
    } finally {
      await s.close();
    }
  });
});

describe('S12c 4・5・7: withdrawing an invitation from the hub, the invitation limit, and an empty season name', () => {
  it('POST /api/ops/uninvite: only from the server PC, only for invitations that never started; the same name can be added again', async () => {
    const m = mem();
    openSeason(m);
    const s = await serve(m);
    try {
      const a = await s.post('/api/ops/adventurers', { name: 'ツバキ', kind: 'ai' });
      const pid = a.json!.profileId as string;
      expect((await s.post('/api/ops/adventurers', { name: 'ツバキ', kind: 'ai' })).status).toBe(400);
      const outside: Record<string, string>[] = [{ 'x-forwarded-for': '203.0.113.9' }, { origin: 'http://evil.example' }, { host: `rebind.evil.example:${s.port}` }];
      for (const h of outside) {
        expect((await s.post('/api/ops/uninvite', { profileId: pid }, h)).status).toBe(403);
      }
      expect((await raw(s.port, 'POST', '/api/ops/uninvite', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ profileId: pid }) })).status).toBe(415);
      expect((await s.post('/api/ops/uninvite', {})).status).toBe(400);
      expect((await s.post('/api/ops/uninvite', { profileId: '__proto__' })).status).toBe(400);
      const u = await s.post('/api/ops/uninvite', { profileId: pid });
      expect(u.status).toBe(200);
      expect(u.json).toEqual({ seasonId: 's1', name: 'ツバキ', profileId: pid });
      expect((await s.get('/api/ops/roster')).json!.roster).toEqual([]);
      // 足し直すと、新しい鍵
      const b = await s.post('/api/ops/adventurers', { name: 'ツバキ', kind: 'ai' });
      expect(b.status).toBe(200);
      expect(b.json!.profileToken).not.toBe(a.json!.profileToken);
      // ランを始めた招きは、取り消せない
      const run = await m.createRun({ name: 'ツバキ', season: 's1', profileToken: b.json!.profileToken, controller: agent });
      expect('error' in run).toBe(false);
      const started = await s.post('/api/ops/uninvite', { profileId: b.json!.profileId });
      expect(started.status).toBe(409);
      expect(started.json!.error.message).toContain('取り消せない');
    } finally {
      await s.close();
    }
  });

  it('a season takes at most 32 invitations (the hub and the operator tool alike)', () => {
    const m = mem();
    openSeason(m);
    expect(INVITE_MAX).toBe(32);
    for (let i = 0; i < INVITE_MAX; i++) expect('error' in m.seasons.invite('s1', `p${i}`, m.profiles.store)).toBe(false);
    expect(m.seasons.invite('s1', 'one more', m.profiles.store)).toEqual({ error: expect.stringContaining('上限') });
    expect(m.seasons.store.invites('s1').length).toBe(INVITE_MAX);
  });

  it('an empty or blank season name lets the server pick a "シーズン N" that does not clash', async () => {
    const m = mem();
    const s = await serve(m);
    try {
      const a = await s.post('/api/ops/season', { name: '   ' });
      expect(a.json!.season).toMatchObject({ id: 's1', name: 'シーズン1' });
      m.seasons.finalize(m.seasons.get('s1')!, 'operator');
      const b = await s.post('/api/ops/season', { name: '' });
      expect(b.json!.season).toMatchObject({ id: 's2', name: 'シーズン2' });
    } finally {
      await s.close();
    }
  });
});

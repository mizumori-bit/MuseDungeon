// S8a（SEASON.md §55.6。S8 の検査の指摘）のテスト: 同じ機械のブラウザで開いた別のページ・DNS の付け替えから、持ち主の口を使えない
// （Host・Origin・Content-Type）／道具と正しい画面の要求は通る／足りなかったテスト（released・プレイヤーのトークン・Forwarded・終わったラン・呪い・加護・replay-verify・予算）
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { ownerWaited } from '../../server/src/session/OwnerPort';
import { applyEvent, projectPlayerView } from '@muse/shared';
import type { Command, Entity, GameEvent, ServerMsg, World } from '@muse/shared';
import { verifyRunDir } from '../src/replay';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };

function manager(o: { runsDir?: string; host?: string } = {}): SessionManager {
  return new SessionManager(content, loadConfig({ ...(o.runsDir ? { runsDir: o.runsDir } : { runsDir: null, profilesDir: null, seasonsDir: null }), waitOthersMs: 100, ...(o.host ? { host: o.host } : {}) }));
}
async function campRun(m: SessionManager, seed: string, o: { season?: string; profileToken?: string } = {}) {
  const r = await m.createRun({ name: 'Ow', seed, controller: agent, ...(o.season ? { season: o.season, profileToken: o.profileToken } : {}) });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof campRun>>;
const owner = (r: Run, cmd: Command) => r.session.submit(r.playerId, cmd, { source: 'owner' });
const errCode = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? 'ok' : x.error!.code);
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];

type R = { status: number; text: string; json: Record<string, any> | null };
/** 見出しを自由に付けられる要求（Host・Origin を含む） */
function raw(port: number, method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<R> {
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(o.headers ?? {}), ...(o.body !== undefined ? { 'content-length': String(Buffer.byteLength(o.body)) } : {}) } }, (x) => {
      const cs: Buffer[] = [];
      x.on('data', (c) => cs.push(c as Buffer));
      x.on('end', () => { const text = Buffer.concat(cs).toString('utf8'); let json: R['json'] = null; try { json = JSON.parse(text); } catch { /* 本文が JSON でない */ } res({ status: x.statusCode!, text, json }); });
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
  return { app, port, close: async () => { await app.close(); } };
}

describe('S8a §55.6 の 1〜3: another page in the same machine\'s browser, or DNS rebinding, cannot use the owner endpoints', () => {
  it('the inspector\'s requests are refused; the right page (same origin, JSON) and tools (no Origin) go through', async () => {
    const m = manager();
    const r = await campRun(m, 's8a-csrf-1');
    const s = await serve(m);
    const P = s.port;
    const J = { 'content-type': 'application/json' };
    const here = `http://127.0.0.1:${P}`;
    const v = `/api/runs/${r.session.runId}/owner`;
    const armor = r.port.view().inventory.find((i) => i.equipped === 'armor')!;
    const held = () => r.session.world.players[r.playerId].directive?.hold ?? [];
    try {
      // fetch の no-cors と同じ形（text/plain・別の Origin）: 断る（Origin で 403）
      const a = await raw(P, 'POST', `${v}/directive`, { headers: { 'content-type': 'text/plain', origin: 'http://evil.example' }, body: JSON.stringify({ hold: ['objective'] }) });
      expect(a.status).toBe(403);
      // <form enctype="text/plain"> と同じ本文（Origin の無い古い形でも）: 415
      const f = await raw(P, 'POST', `${v}/directive`, { headers: { 'content-type': 'text/plain' }, body: '{"hold":["objective","loadout","perks"],"message":"x":"="}' });
      expect(f.status).toBe(415);
      const f2 = await raw(P, 'POST', `${v}/directive`, { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'hold=objective&message=hi' });
      expect(f2.status).toBe(415);
      // JSON でも、別の Origin・Origin: null は断る
      expect((await raw(P, 'POST', `${v}/directive`, { headers: { ...J, origin: 'http://evil.example' }, body: JSON.stringify({ hold: ['objective'] }) })).status).toBe(403);
      expect((await raw(P, 'POST', `${v}/directive`, { headers: { ...J, origin: 'null' }, body: JSON.stringify({ hold: ['objective'] }) })).status).toBe(403);
      // act（unequip）も
      expect((await raw(P, 'POST', `${v}/act`, { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ command: { type: 'unequip', slot: armor.slot } }) })).status).toBe(415);
      expect(held()).toEqual([]);
      expect(meOf(r.session.world, r.playerId).equip?.armor).toBeTruthy();
      // DNS の付け替え（Host が別の名前）・違うポート: 同じ機械と認めない（読めない・書けない）
      const reb = { host: `rebind.evil.example:${P}` };
      expect(((await raw(P, 'GET', '/api/owner/runs', { headers: reb })).json as { runs: unknown[] }).runs).toEqual([]);
      expect((await raw(P, 'GET', `${v}/view`, { headers: reb })).status).toBe(403);
      expect((await raw(P, 'POST', `${v}/directive`, { headers: { ...J, ...reb }, body: JSON.stringify({ hold: ['objective'] }) })).status).toBe(403);
      expect((await raw(P, 'GET', `${v}/view`, { headers: { host: `127.0.0.1:${P + 1}` } })).status).toBe(403);
      // Forwarded・X-Real-IP の形（今までどおり）
      expect((await raw(P, 'GET', `${v}/view`, { headers: { forwarded: 'for=203.0.113.9' } })).status).toBe(403);
      expect((await raw(P, 'GET', `${v}/view`, { headers: { forwarded: 'proto=http' } })).status).toBe(403);
      expect((await raw(P, 'GET', `${v}/view`, { headers: { 'x-real-ip': '127.0.0.1' } })).status).toBe(200);
      expect((await raw(P, 'GET', `${v}/view`, { headers: { 'x-real-ip': '203.0.113.9' } })).status).toBe(403);
      // 正しい画面（同じ origin・JSON）と、Origin の無い道具は通る
      const ok1 = await raw(P, 'POST', `${v}/directive`, { headers: { ...J, origin: here }, body: JSON.stringify({ hold: ['loadout'] }) });
      expect(ok1.status).toBe(200);
      expect(ok1.json?.result).toEqual({ ok: true });
      const ok2 = await raw(P, 'POST', `${v}/act`, { headers: J, body: JSON.stringify({ command: { type: 'unequip', slot: armor.slot } }) });
      expect(ok2.json?.result).toEqual({ ok: true });
      expect((await raw(P, 'GET', `${v}/view`, { headers: { origin: `http://localhost:${P}`, host: `localhost:${P}` } })).status).toBe(200);
      // プロフィールのトークンで認める口も、別の Origin は断る。プレイヤーのトークンでは持ち主になれない
      const ext = { 'x-forwarded-for': '203.0.113.9' };
      const ptok = r.profile.token!;
      expect((await raw(P, 'POST', `${v}/directive`, { headers: { ...J, ...ext, authorization: `Bearer ${ptok}`, origin: 'http://evil.example' }, body: JSON.stringify({ hold: [] }) })).status).toBe(403);
      expect((await raw(P, 'POST', `${v}/directive`, { headers: { ...J, ...ext, authorization: `Bearer ${ptok}`, origin: here }, body: JSON.stringify({ hold: [] }) })).json?.result).toEqual({ ok: true });
      expect((await raw(P, 'GET', `${v}/view`, { headers: { ...ext, authorization: `Bearer ${r.token}` } })).status).toBe(403);
      // 自分のラン（トークンのプレイヤー）と、同じ機械からだけで認めたラン（運用者として）を分ける
      const runsOf = async (h: Record<string, string>) => ((await raw(P, 'GET', '/api/owner/runs', { headers: h })).json as { runs: { runId: string; mine?: boolean }[] }).runs.find((x) => x.runId === r.session.runId);
      expect((await runsOf({}))?.mine).toBe(false);
      expect((await runsOf({ authorization: `Bearer ${ptok}` }))?.mine).toBe(true);
      // 前からある、状態を変える口も JSON だけ・同じ origin だけ。/mcp は SDK が JSON だけを受ける
      expect((await raw(P, 'POST', '/api/runs', { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'X' }) })).status).toBe(415);
      expect((await raw(P, 'POST', '/api/runs', { headers: { ...J, origin: 'http://evil.example' }, body: JSON.stringify({ name: 'X' }) })).status).toBe(403);
      expect((await raw(P, 'POST', `/api/runs/${r.session.runId}/join`, { headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ name: 'X' }) })).status).toBe(415);
      expect((await raw(P, 'POST', '/api/runs', { headers: J, body: JSON.stringify({ name: 'Tool', controller: agent }) })).status).toBe(200);
      const mcp = await raw(P, 'POST', '/mcp', { headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '0' } } }) });
      expect(mcp.status).toBe(415);
    } finally {
      await s.close();
    }
  });

  it('the address written in MUSE_HOST (a Tailscale-style address) passes as Host and Origin; the WS upgrade from another origin is not local', async () => {
    const m = manager({ host: '127.0.0.1,100.64.0.5' });
    m.seasons.store.open({ id: 's8aw', name: 'S8a', seed: 's8a-season', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 3000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite('s8aw', 'ナギ', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const r = await campRun(m, 's8a-ts-1', { season: 's8aw', profileToken: inv.token! });
    const s = await serve(m);
    const P = s.port;
    try {
      const ts = { host: `100.64.0.5:${P}`, origin: `http://100.64.0.5:${P}` };
      expect(((await raw(P, 'GET', '/api/owner/runs', { headers: ts })).json as { runs: { runId: string }[] }).runs.map((x) => x.runId)).toEqual([r.session.runId]);
      expect((await raw(P, 'POST', `/api/runs/${r.session.runId}/owner/directive`, { headers: { ...ts, 'content-type': 'application/json' }, body: JSON.stringify({ hold: ['perks'] }) })).json?.result).toEqual({ ok: true });
      // 観戦の WS: 別の Origin からの upgrade は同じ機械と認めない（開催中のシーズンのランは断られる）。同じ origin なら通る
      const hello = (origin: string) => new Promise<ServerMsg>((res, rej) => {
        const ws = new WebSocket(`ws://127.0.0.1:${P}/ws`, { origin });
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'spectator', runId: r.session.runId, mode: 'follow' })));
        ws.on('message', (d) => { res(JSON.parse(String(d)) as ServerMsg); ws.close(); });
        ws.on('error', rej);
      });
      const bad = await hello('http://evil.example');
      expect(bad.t).toBe('error');
      expect(bad.t === 'error' && bad.error.code).toBe('season_unavailable');
      const good = await hello(`http://127.0.0.1:${P}`);
      expect(good.t).toBe('welcome');
    } finally {
      await s.close();
    }
  });
});

describe('S8a §55.6 の 12・13: the remaining cases', () => {
  it('waitForOwner returns on released; an ended run refuses the owner endpoints; the waiting mark is off when the season budget is used up; a cleaned message counts its length after cleaning', async () => {
    const m = manager();
    const r = await campRun(m, 's8a-rest-1');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    const w = r.port.waitForOwner(5000);
    expect(errCode(await owner(r, { type: 'set_directive', hold: [] }))).toBe('ok');
    expect(await w).toBe('released');
    // 伝言の長さ（落とした後で数える）
    const ctl = '\u0007'.repeat(10);
    expect(errCode(await owner(r, { type: 'set_directive', hold: [], message: 'あ'.repeat(275) + ctl }))).toBe('ok');
    expect(r.session.world.players[r.playerId].directive?.message.length).toBe(275);
    expect(errCode(await owner(r, { type: 'set_directive', hold: [], message: 'い'.repeat(281) }))).toBe('bad_request');
    // 予算を使い切ったシーズンでは、待っている印を出さない（遠征を始められない）
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    const v = projectPlayerView(r.session.world, r.playerId);
    expect(ownerWaited(v)).toBe(true);
    const season = { id: 'x', name: 'x', budget: { limit: 3000, left: 0, at: 0 }, ends_at: 0, ended: false, public: [], awards: [], contribution: 0, died: false, reported: [], budgetLeft: 0, unreported: 0, unpublished: 0, spotsUnreported: 0, spotsUnpublished: 0 };
    expect(ownerWaited({ ...v, season } as typeof v)).toBe(false);
    expect(ownerWaited({ ...v, season: { ...season, budgetLeft: 10, ended: true } } as typeof v)).toBe(false);
    // 終わったラン
    const s = await serve(m);
    try {
      expect(errCode(await r.port.act({ type: 'retire' }, { source: 'bot' }))).toBe('ok');
      const ended = await raw(s.port, 'GET', `/api/runs/${r.session.runId}/owner/view`);
      expect(ended.status).toBe(409);
      expect(ended.json?.error?.code).toBe('run_ended');
      expect((await raw(s.port, 'POST', `/api/runs/${r.session.runId}/owner/directive`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hold: [] }) })).json?.error?.code).toBe('run_ended');
    } finally {
      await s.close();
    }
  });

  it('the owner\'s camp equip of a known-cursed item needs confirm; the owner picks a boon at camp', async () => {
    const m = manager();
    const r = await campRun(m, 's8a-curse-1');
    const w = r.session.world;
    const curse = Object.entries(catalog.affixes).find(([, a]) => a.cursed)![0];
    const kind = Object.entries(catalog.items).find(([, it]) => it.slot === 'weapon')![0];
    const me = structuredClone(meOf(w, r.playerId));
    const item: Entity = { id: 'e_cursed', kind, sid: 99999, item: { qty: 1, affixes: [curse], heldBy: me.id, slot: 'q', inspected: true } };
    me.inv!.items.push(item.id);
    const bOpts = Object.keys(catalog.boons ?? {}).slice(0, 2);
    me.boonChoice = { options: bOpts, source: 'warden', depth: 5 };
    inject(w, { put: [item, me] });
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['loadout', 'perks'] }))).toBe('ok');
    expect(errCode(await r.port.act({ type: 'choose_boon', option: 1 }, { source: 'bot' }))).toBe('held_by_owner');
    expect(errCode(await owner(r, { type: 'equip', slot: 'q' }))).toBe('confirm_required');
    expect(meOf(w, r.playerId).equip?.weapon).not.toBe('e_cursed');
    expect(errCode(await owner(r, { type: 'equip', slot: 'q', confirm: true }))).toBe('ok');
    expect(meOf(w, r.playerId).equip?.weapon).toBe('e_cursed');
    // 呪いで外せない（今ある決まりのまま）
    expect(errCode(await owner(r, { type: 'unequip', slot: 'q' }))).toBe('cannot_use');
    expect(errCode(await owner(r, { type: 'choose_boon', option: 2 }))).toBe('ok');
    expect(meOf(w, r.playerId).boons).toContain(bOpts[1]);
    expect(w.players[r.playerId].ownerDecided).toEqual(['loadout', 'perks']);
    const ch = r.port.observeWithTurn('observed').turn.changes.filter((c) => c.code === 'owner').map((c) => c.text);
    expect(ch.some((x) => x.startsWith('持ち主が、加護を選んだ: '))).toBe(true);
    m.closeAll();
  });

  it('replay-verify re-executes the owner\'s commands from the records (source: owner) and matches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s8a-rv-'));
    try {
      const m = manager({ runsDir: dir });
      const r = await campRun(m, 's8a-rv-1');
      const armor = r.port.view().inventory.find((i) => i.equipped === 'armor')!;
      expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'loadout'], message: '記録から' }))).toBe('ok');
      expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('ok');
      expect(errCode(await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' }))).toBe('held_by_owner');
      expect(errCode(await owner(r, { type: 'start_expedition', offer: 1 }))).toBe('ok');
      expect(errCode(await r.port.act({ type: 'wait' }, { source: 'bot' }))).toBe('ok');
      const runId = r.session.runId;
      m.closeAll();
      const v = verifyRunDir(content, join(dir, runId));
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

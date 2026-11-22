// S3（SEASON.md §25。観戦は持ち主だけ §25.1・補給の置き場 §25.2）のテスト（§25.5）
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION, generateFloor } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { App, PlayerPort } from '@muse/server';
import { applyEvent, filterEventsForPlayer, formatObservationText } from '@muse/shared';
import { createMcpServer } from '@muse/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { IncomingMessage } from 'node:http';
import { isLocalRequest } from '../../server/src/http/local';
import type { Command, Entity, Expedition, GameEvent, Pos, ServerMsg, World } from '@muse/shared';
import { playWithPort } from '../src/bot';
import { verifyRunDir } from '../src/replay';

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

const act = (r: { port: PlayerPort }, cmd: Command) => r.port.act(cmd, { source: 'bot' });

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

// ---- §25.2 補給の置き場 ----

type Run = Awaited<ReturnType<typeof seasonRun>>;
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
const floorOf = (r: Run) => meOf(r.session.world, r.playerId).pos!.floor;
/** 置いて 1 手待つ（そのマスを目で見て、観測の地図に載る） */
async function placeAt(r: Run, p: Pos): Promise<void> {
  const w = r.session.world;
  const e = structuredClone(meOf(w, r.playerId));
  e.pos = { floor: e.pos!.floor, x: p.x, y: p.y };
  inject(w, { put: [e] });
  clearMonsters(w);
  expect((await act(r, { type: 'wait' })).ok).toBe(true);
}
function clearMonsters(w: World): void {
  inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
}
function setBanked(w: World, pid: string, n: number): void {
  applyEvent(w, { type: 'player_stats', player: pid, stats: { ...w.players[pid].stats, banked: n }, seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [] } as unknown as GameEvent);
}
let nid = 0;
/** 持ち物に品を足す（テストの中だけの書き換え）。入ったスロット */
function give(r: Run, kind: string, qty = 1): string {
  const w = r.session.world;
  const me = structuredClone(meOf(w, r.playerId));
  const used = new Set(me.inv!.items.map((id) => w.entities[id]?.item?.slot));
  const slot = 'abcdefghijklmnopqrstuvwxyz'.split('').find((c) => !used.has(c))!;
  const id = `e_s3${(nid++).toString(36).padStart(4, '0')}`;
  me.inv!.items.push(id);
  inject(w, { put: [{ id, kind, sid: 900000 + nid, item: { qty, affixes: [], heldBy: me.id, slot } } as Entity, me] });
  return slot;
}
const slotOf = (r: Run, kind: string) => r.port.view().inventory.find((i) => i.kind === kind || (i.kind === null && r.session.world.secret.appearances[kind] === i.appearanceId))?.slot;
const qtyOf = (r: Run, kind: string) => r.session.world.entities[meOf(r.session.world, r.playerId).inv!.items.find((id) => r.session.world.entities[id]?.kind === kind) ?? '']?.item?.qty ?? 0;
async function startAndClear(r: Run): Promise<void> {
  const s = await act(r, { type: 'start_expedition', offer: 1 });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(r.session.world);
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
  // キャンプの取り込みは、確定した命令の後に積まれる（待つ）
  await new Promise((res) => setTimeout(res, 5));
}
const support = (m: SessionManager, name: string) => m.seasons.standings(SID)!.standings.find((x) => x.name === name)?.support?.value ?? 0;
const obsOf = (r: Run) => r.port.observe().observation;

describe('S3 §25.2: supply caches', () => {
  it('deposits consumables only, one at a time, on stairs or at a campfire; up to 5 per cache; one take per expedition from any cache; the observation matches', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya', SID);
    await startAndClear(a);
    const w = a.session.world;
    const k1 = floorOf(a);
    const down = w.floors[k1].stairs.down[0];
    const potion = slotOf(a, 'core:potion_healing')!; // 始めの持ち物（1 つ）
    const sword = give(a, 'core:dagger');
    const jav = give(a, 'core:javelin', 3);
    give(a, 'core:scroll_teleport', 2);
    // 置き場の外では断る（手番を使わない）
    const seq0 = w.seq;
    const off = await act(a, { type: 'deposit_supply', slot: potion });
    expect(!off.ok && off.error.message).toContain('上り階段・下り階段のマスと、野営の火');
    expect(w.seq).toBe(seq0);
    expect(obsOf(a).valid_actions.some((v) => v.startsWith('deposit_supply'))).toBe(false);
    await placeAt(a, down);
    // 観測: 置き場にいる。預けられる品ごとの行（装備は出ない）
    const o1 = obsOf(a);
    expect(o1.season?.supply?.place).toBe('stairs_down');
    expect(o1.valid_actions.some((v) => v.startsWith(`deposit_supply ${potion} (`))).toBe(true);
    expect(o1.valid_actions.some((v) => v.startsWith(`deposit_supply ${sword} (`))).toBe(false);
    expect(o1.valid_actions.some((v) => v.startsWith('take_supply'))).toBe(false);
    // 装備・帰還の綱は預けられない
    const ns = await act(a, { type: 'deposit_supply', slot: sword });
    expect(!ns.ok && ns.error.message).toContain('消耗品（薬・巻物・投げる武器）だけ');
    const life = a.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    expect((await act(a, { type: 'deposit_supply', slot: life })).ok).toBe(false);
    // 重ねた品は 1 つずつ・1 手番
    const t0 = meOf(w, a.playerId).actor!.turns;
    const d1 = await act(a, { type: 'deposit_supply', slot: jav });
    expect(d1.ok ? d1.outcome : JSON.stringify(d1.error)).toContain('置き場に預けた');
    expect(meOf(w, a.playerId).actor!.turns).toBe(t0 + 1);
    expect(qtyOf(a, 'core:javelin')).toBe(2);
    expect(w.season!.deposited!.map((x) => x.kind)).toEqual(['core:javelin']);
    // 5 つまで（最後の 1 つを預けた品は、持ち物から無くなる）
    for (const kind of ['core:javelin', 'core:potion_healing', 'core:scroll_teleport', 'core:scroll_teleport']) {
      const r = await act(a, { type: 'deposit_supply', slot: slotOf(a, kind)! });
      expect(r.ok ? '' : r.error.message, kind).toBe('');
    }
    const full = await act(a, { type: 'deposit_supply', slot: slotOf(a, 'core:javelin')! });
    expect(!full.ok && full.error.message).toContain('いっぱい（5/5）');
    expect(obsOf(a).valid_actions.some((v) => v.startsWith('deposit_supply (') && v.includes('いっぱい'))).toBe(true);
    // 取る: 自分の品を取り返すのも数える。1 回の遠征で 1 つまで（別の置き場でも）
    const o2 = obsOf(a);
    expect(o2.season!.supply!.items.map((x) => x.id)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5']);
    expect(o2.valid_actions.filter((v) => v.startsWith('take_supply l')).length).toBe(5);
    const noId = await act(a, { type: 'take_supply' });
    expect(!noId.ok && noId.error.message).toContain('id で選ぶ');
    expect(slotOf(a, 'core:potion_healing')).toBeUndefined();
    const tk = await act(a, { type: 'take_supply', id: 'l3' });
    expect(tk.ok ? tk.outcome : JSON.stringify(tk.error)).toContain('取った');
    expect(qtyOf(a, 'core:potion_healing')).toBe(1);
    const again = await act(a, { type: 'take_supply', id: 'l1' });
    expect(!again.ok && again.error.message).toContain('もう置き場から 1 つ取った');
    expect(obsOf(a).valid_actions.some((v) => v.startsWith('take_supply (') && v.includes('不可'))).toBe(true);
    // 野営の火も置き場（火の隣から）。そこでも、この遠征では取れない
    setBanked(w, a.playerId, 1000);
    const f = w.floors[k1];
    const cells: Pos[] = [];
    for (let y = 2; y < f.height - 2; y++) for (let x = 2; x < f.width - 2; x++) {
      const tr = content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
      const tr2 = content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x + 1]]]];
      if (!tr.passable || tr.stairs || tr.door || tr.tags.includes('grate') || !tr2.passable || tr2.stairs || tr2.door) continue;
      if (Math.max(Math.abs(x - down.x), Math.abs(y - down.y)) < 7 || Math.max(Math.abs(x - f.entry.x), Math.abs(y - f.entry.y)) < 3) continue;
      if (Object.values(w.entities).some((e) => e.pos?.floor === k1 && ((e.pos.x === x || e.pos.x === x + 1) && e.pos.y === y))) continue;
      cells.push({ x, y });
    }
    await placeAt(a, cells[0]);
    expect((await act(a, { type: 'place_fire' })).ok).toBe(true);
    await placeAt(a, { x: cells[0].x + 1, y: cells[0].y });
    expect(obsOf(a).season?.supply?.place).toBe('fire');
    const dj = await act(a, { type: 'deposit_supply', slot: slotOf(a, 'core:javelin')! });
    expect(dj.ok ? '' : dj.error.message).toBe('');
    expect(w.season!.deposited!.at(-1)).toMatchObject({ place: 'fire', x: cells[0].x, y: cells[0].y });
    expect((await act(a, { type: 'take_supply' })).ok).toBe(false);
    // この階の置き場の文
    expect(formatObservationText(obsOf(a), 'ja')).toContain('補給の置き場（この階）');
    m.closeAll();
  });

  it('a non-season run has no caches: the commands are refused and no lines appear', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'Plain', controller: agent, seed: 's3-plain', objective: 'auto' });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const k = w.entities[w.players[r.playerId].entityId].pos!.floor;
    const e = structuredClone(meOf(w, r.playerId));
    e.pos = { floor: k, ...w.floors[k].stairs.down[0] };
    inject(w, { put: [e] });
    clearMonsters(w);
    await r.port.act({ type: 'wait' }, { source: 'bot' });
    const pot = r.port.view().inventory.find((i) => i.kind === 'core:potion_healing')!.slot;
    const d = await r.port.act({ type: 'deposit_supply', slot: pot }, { source: 'bot' });
    expect(!d.ok && d.error.code).toBe('bad_request');
    expect((await r.port.act({ type: 'take_supply' }, { source: 'bot' })).ok).toBe(false);
    const o = r.port.observe().observation;
    expect(o.valid_actions.some((v) => v.includes('supply'))).toBe(false);
    expect(o.season).toBeUndefined();
    m.closeAll();
  });

  it('shares deposits at the depositor\'s camp; others see them from their next sync, names follow identification, unseen stairs stay hidden; takes count for support at the taker\'s camp (a double take once, own retakes never)', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    const c = await seasonRun(m, 'Cid');
    // B は A が預ける前から迷宮にいる（遠征の途中では届かない）
    await startAndClear(b);
    await startAndClear(a);
    const wa = a.session.world;
    const k1 = floorOf(a);
    const down = wa.floors[k1].stairs.down[0];
    await placeAt(a, down);
    const pot = slotOf(a, 'core:potion_healing')!; // 始めの持ち物（鑑定済み）
    const scroll = give(a, 'core:scroll_mapping'); // 未鑑定
    expect(wa.players[a.playerId].knowledge.identified).toContain('core:potion_healing');
    expect(wa.players[a.playerId].knowledge.identified).not.toContain('core:scroll_mapping');
    expect((await act(a, { type: 'deposit_supply', slot: pot })).ok).toBe(true);
    expect((await act(a, { type: 'deposit_supply', slot: scroll })).ok).toBe(true);
    // 預けた者が迷宮にいる間は、共有層に載らない（順位の表にも出ない）
    expect(m.seasons.get(SID)!.supplies).toEqual([]);
    await lifelineHome(a);
    const sup = m.seasons.get(SID)!.supplies;
    expect(sup.map((x) => [x.id, x.kind, x.identified, x.by])).toEqual([['s1', 'core:potion_healing', true, 'Aya'], ['s2', 'core:scroll_mapping', false, 'Aya']]);
    // A のキャンプ: 自分の預けた品（まだだれも取っていない）。自分の世界に写しを重ねない（l1・l2 は s1・s2 と同じ品）
    expect(a.port.view().season!.myDeposits!.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(formatObservationText(obsOf(a), 'ja')).toContain('あなたの預けた品');
    // 断面には数だけ（場所と種類は出さない）
    expect(m.seasons.standings(SID)!.section[0].supplies).toBe(2);
    expect(JSON.stringify(m.seasons.standings(SID))).not.toContain('scroll_mapping');
    // B は遠征の途中なので、まだ見えない
    expect(b.session.world.season!.supplies ?? []).toEqual([]);
    await placeAt(b, down);
    expect(obsOf(b).season?.supply?.items ?? []).toEqual([]);
    await lifelineHome(b);
    // C は次の遠征から: 地下 1 階に入ると、まだ見ていない下り階段の置き場は数だけ
    await startAndClear(c);
    const wc = c.session.world;
    const fk = wc.players[c.playerId].knowledge.floors[k1];
    const seen = (fk.seen[down.y * wc.floors[k1].width + down.x] ?? 0) !== 0;
    const oc = obsOf(c);
    expect(seen, 'this seed keeps the depth-1 down stairs out of sight from the entrance').toBe(false);
    if (seen) expect(oc.season?.caches?.[0]?.items.length).toBe(2);
    else {
      expect(oc.season?.caches_hidden).toBe(2);
      expect(oc.season?.caches ?? []).toEqual([]);
      expect(JSON.stringify(c.port.view().season)).not.toContain(`"x":${down.x},"y":${down.y}`);
      expect(formatObservationText(oc, 'ja')).toContain('まだ見ていない下り階段の置き場にも 2 つ');
    }
    // 置き場に着くと、品の名前（鑑定済みで預けた薬は名前、未鑑定の巻物は外見だけ）
    await placeAt(c, down);
    const items = obsOf(c).season!.supply!.items;
    expect(items.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(items[0].name).toContain('回復');
    expect(items[1].name).not.toContain('地図');
    expect(JSON.stringify(c.port.view())).not.toContain('scroll_mapping');
    expect(JSON.stringify(c.port.observe())).not.toContain('scroll_mapping');
    // C が鑑定済みの薬を取る → C もその種類を知る
    const takeC = await act(c, { type: 'take_supply', id: 's1' });
    expect(takeC.ok ? takeC.outcome : JSON.stringify(takeC.error)).toContain('Aya が預けた');
    expect(wc.players[c.playerId].knowledge.identified).toContain('core:potion_healing');
    // B も同じ品を取る（世界は別々）。B が先にキャンプに着く
    await startAndClear(b);
    await placeAt(b, down);
    expect(obsOf(b).season!.supply!.items.map((x) => x.id)).toEqual(['s1', 's2']);
    expect((await act(b, { type: 'take_supply', id: 's1' })).ok).toBe(true);
    expect(support(m, 'Aya')).toBe(0);
    await lifelineHome(b);
    expect(m.seasons.get(SID)!.supplies[0].takenBy).toBe(b.profile.id);
    expect(support(m, 'Aya')).toBe(1);
    await lifelineHome(c);
    expect(m.seasons.get(SID)!.supplies[0].doubles).toEqual([c.profile.id]);
    // 二重に取られた品は 1 人分。両方の手元に残る
    expect(support(m, 'Aya')).toBe(1);
    expect(qtyOf(b, 'core:potion_healing')).toBeGreaterThan(0);
    expect(qtyOf(c, 'core:potion_healing')).toBeGreaterThan(0);
    // 取られた品は、次の取り込みから置き場に無い。A のキャンプに知らせ（次の取り込みで）
    await a.session.syncSeason(a.playerId, 'camp');
    const na = obsOf(a).season!.supply_news!;
    expect(na.map((x) => x.taker)).toEqual(['Ben']);
    expect(formatObservationText(obsOf(a), 'ja')).toContain('を、Ben が取った（支援賞 +1）');
    expect(a.port.view().season!.myDeposits!.map((x) => x.id)).toEqual(['s2']);
    // 遠征を始める取り込みで、キャンプで見せた知らせは消える
    await startAndClear(a);
    expect(a.port.view().season!.cacheNews ?? []).toEqual([]);
    // A が自分の品（s2）を取り返す: 支援に数えない
    await placeAt(a, down);
    expect((await act(a, { type: 'take_supply', id: 's2' })).ok).toBe(true);
    await lifelineHome(a);
    expect(m.seasons.get(SID)!.supplies[1].takenBy).toBe(a.profile.id);
    expect(support(m, 'Aya')).toBe(1);
    m.closeAll();
  });

  it('a depositor who never gets back still shares: the deposits are published when the run ends', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const down = a.session.world.floors[floorOf(a)].stairs.down[0];
    await placeAt(a, down);
    expect((await act(a, { type: 'deposit_supply', slot: slotOf(a, 'core:potion_healing')! })).ok).toBe(true);
    expect(m.seasons.get(SID)!.supplies).toEqual([]);
    expect((await act(a, { type: 'retire' })).ok).toBe(true);
    expect(m.seasons.get(SID)!.supplies.map((x) => x.kind)).toEqual(['core:potion_healing']);
    m.closeAll();
  });

  it('replays from its records alone (deposits, a retake before sharing, the synced cache and a take of a shared item); the entry and stairs stay those of the seed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s3r-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Rin');
      // 斥候で（投げナイフと薬を持って始まる）。記録に残る命令だけで遊ぶ
      await act(a, { type: 'retire' });
      const sc = await m.createRun({ name: 'Rin', controller: agent, season: SID, classId: 'core:scout', profileToken: a.ptoken });
      if ('error' in sc) throw new Error(sc.error.message);
      const r = Object.assign(sc, { ptoken: a.ptoken }) as Run;
      await playWithPort(r.port, { kind: 'greedy', seed: 'r', maxActs: 900, maxExpeditions: 1 });
      expect(r.port.view().status).toBe('at_camp');
      expect((await act(r, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      const o = obsOf(r);
      expect(o.season?.supply?.place, 'the next expedition starts on the stairs it left from').toMatch(/^stairs_/);
      const knife = slotOf(r, 'core:throwing_knife');
      const pot = slotOf(r, 'core:potion_healing') ?? knife;
      expect(knife).toBeTruthy();
      expect((await act(r, { type: 'deposit_supply', slot: knife! })).ok).toBe(true);
      expect((await act(r, { type: 'deposit_supply', slot: pot! })).ok).toBe(true);
      // 載る前に 1 つ取り返す（共有層には載らない）
      expect((await act(r, { type: 'take_supply', id: 'l1' })).ok).toBe(true);
      expect((await act(r, { type: 'extract', confirm: true })).ok).toBe(true);
      expect(r.port.view().status).toBe('at_camp');
      const sup = m.seasons.get(SID)!.supplies;
      expect(sup.map((x) => [x.id, x.n])).toEqual([['s1', 2]]);
      // 次の遠征は同じ階段から。取り込んだ置き場の品（自分の s1）を取る
      expect((await act(r, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      expect(obsOf(r).season!.supply!.items.map((x) => x.id)).toEqual(['s1']);
      expect((await act(r, { type: 'take_supply', id: 's1' })).ok).toBe(true);
      await act(r, { type: 'retire' });
      expect(m.seasons.get(SID)!.supplies[0].takenBy).toBe(r.profile.id);
      expect(support(m, 'Rin')).toBe(0);
      const types = new Set(r.session.history.map((e) => e.type));
      expect(types.has('supply_deposited') && types.has('supply_taken')).toBe(true);
      const v = verifyRunDir(content, join(dir, r.session.runId));
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
      // 生成は変わらない（置き場は生成の乱数を使わない）: 同じシードのシーズンのランの地下 1 階の入口と下り階段は同じ
      const table = content.terrain.map((x) => x.id);
      for (const e of r.session.history) {
        if (e.type !== 'floor_generated') continue;
        const g = generateFloor(content, 's3-season-1', 'main', e.floorData.depth, table, undefined, undefined, { season: true });
        if (g.floor.floorType === 'core:warden_hall') continue;
        expect(`${e.floorData.entry.x},${e.floorData.entry.y}|${e.floorData.stairs.down.map((d) => `${d.x},${d.y}`).join(' ')}`, e.floorData.key).toBe(`${g.floor.entry.x},${g.floor.entry.y}|${g.floor.stairs.down.map((d) => `${d.x},${d.y}`).join(' ')}`);
      }
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- S3a（§27.9・§27.6） ----

describe('S3a §27.9: leaks', () => {
  it('the player\'s events do not carry the after values (no free identification), and a viewer who has not identified a kind gets the name without the look', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const c = await seasonRun(m, 'Cid');
    await startAndClear(a);
    const wa = a.session.world;
    const down = wa.floors[floorOf(a)].stairs.down[0];
    await placeAt(a, down);
    // 未鑑定の巻物を 2 つ重ねて持ち、1 つ預ける: プレイヤーに渡る出来事に、本当の種類が出ない
    const sc = give(a, 'core:scroll_teleport', 2);
    expect(wa.players[a.playerId].knowledge.identified).not.toContain('core:scroll_teleport');
    expect((await act(a, { type: 'deposit_supply', slot: sc })).ok).toBe(true);
    expect((await act(a, { type: 'take_supply', id: 'l1' })).ok).toBe(true);
    const pe = filterEventsForPlayer(a.session.history, a.playerId, a.port.view());
    const dep = pe.filter((e) => e.type === 'supply_deposited' || e.type === 'supply_taken');
    expect(dep.length).toBe(2);
    expect(JSON.stringify(pe)).not.toContain('scroll_teleport');
    expect(JSON.stringify(a.port.perceivedSince(0))).not.toContain('scroll_teleport');
    // 鑑定済みの巻物を預ける（A だけが知っている種類）
    applyEvent(wa, { type: 'item_identified', player: a.playerId, kind: 'core:scroll_mapping', appearanceId: wa.secret.appearances['core:scroll_mapping'], seq: wa.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [a.playerId] } as unknown as GameEvent);
    const mp = give(a, 'core:scroll_mapping');
    expect((await act(a, { type: 'deposit_supply', slot: mp })).ok).toBe(true);
    await lifelineHome(a);
    // C は未鑑定: 名前は渡るが、外見は渡らない（外見と種類の対応が分かるのは、取ったとき）
    await startAndClear(c);
    await placeAt(c, down);
    const wc = c.session.world;
    expect(wc.players[c.playerId].knowledge.identified).not.toContain('core:scroll_mapping');
    const item = c.port.view().season!.cache!.find((x) => x.kind === 'core:scroll_mapping')!;
    expect(item.appearanceId).toBeNull();
    expect(JSON.stringify(c.port.view())).not.toContain(`"${wc.secret.appearances['core:scroll_mapping']}"`);
    expect(obsOf(c).season!.supply!.items.find((x) => x.id === item.id)!.name).toContain('地図');
    // 取ると知る（外見も）
    expect((await act(c, { type: 'take_supply', id: item.id })).ok).toBe(true);
    expect(wc.players[c.playerId].knowledge.identified).toContain('core:scroll_mapping');
    m.closeAll();
  });

  it('refuses items with affixes, and takes outside an expedition', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    await placeAt(a, w.floors[floorOf(a)].stairs.down[0]);
    const sl = give(a, 'core:javelin', 2);
    const id = meOf(w, a.playerId).inv!.items.find((x) => w.entities[x]?.item?.slot === sl)!;
    const it = structuredClone(w.entities[id]);
    it.item!.affixes = ['core:keen'];
    inject(w, { put: [it] });
    const r = await act(a, { type: 'deposit_supply', slot: sl });
    expect(!r.ok && r.error.message).toContain('接辞や呪い');
    m.closeAll();
  });

  it('a spectator never receives a player token from the AI activity log (all runs)', async () => {
    const m = manager();
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 's3a', version: '0' });
    await client.connect(y);
    const r = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Tok', objective: 'auto' } })) as unknown as { structuredContent: { run_id: string; player_token: string; profile_token?: string } };
    const { run_id, player_token, profile_token } = r.structuredContent;
    expect(player_token.length).toBeGreaterThan(8);
    const acts = m.get(run_id)!.agentActivity;
    expect(acts.length).toBeGreaterThan(0);
    for (const a of acts) {
      expect(a.text).not.toContain(player_token);
      if (profile_token) expect(a.text).not.toContain(profile_token);
      expect(a.text).not.toMatch(/player_token\s*:/);
      expect(JSON.stringify(a.args)).not.toContain(player_token);
    }
    // 俯瞰の観戦（つないだときに直近の記録を受ける）にも出ない
    const { app, port } = await listen(m);
    try {
      const sp = await spectate(port, { runId: run_id, mode: 'director' }, {}, 6);
      expect(sp.msgs.some((x2) => x2.t === 'agent')).toBe(true);
      expect(JSON.stringify(sp.msgs)).not.toContain(player_token);
    } finally {
      await app.close();
      await client.close();
    }
  });

  it('a run of an unfinalized season shows only its name and that it is a season run, through the run list, the leaderboard and meta; all of it once final', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s3a-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      await startAndClear(a);
      await lifelineHome(a);
      await act(a, { type: 'retire' });
      const runId = a.session.runId;
      const { app, port } = await listen(m);
      const base = `http://127.0.0.1:${port}`;
      try {
        const runs = async () => ((await (await fetch(`${base}/api/runs`)).json()) as { runs: { runId: string; summary?: unknown; expeditions?: unknown; seq: number; players: { hidden?: boolean; depth: number | null }[] }[] }).runs.find((x) => x.runId === runId)!;
        const r0 = await runs();
        expect(r0.summary).toBeUndefined();
        expect(r0.expeditions).toBeUndefined();
        expect(r0.seq).toBe(0);
        expect(r0.players[0].hidden).toBe(true);
        const lb = (await (await fetch(`${base}/api/leaderboard`)).json()) as { entries: { runId: string }[] };
        expect(lb.entries.some((x) => x.runId === runId)).toBe(false);
        const meta = (await (await fetch(`${base}/api/runs/${runId}/meta`)).json()) as { lastSeq?: number; endedAt?: number; season?: string };
        expect(meta.season).toBe(SID);
        expect(meta.lastSeq).toBeUndefined();
        expect(meta.endedAt).toBeUndefined();
        // 確定した後は、今までどおり
        m.seasons.finalize(m.seasons.get(SID)!, 'operator');
        const r1 = await runs();
        expect(r1.summary).toBeTruthy();
        expect(r1.players[0].hidden).toBeUndefined();
        const lb1 = (await (await fetch(`${base}/api/leaderboard`)).json()) as { entries: { runId: string }[] };
        expect(lb1.entries.some((x) => x.runId === runId)).toBe(true);
        const meta1 = (await (await fetch(`${base}/api/runs/${runId}/meta`)).json()) as { lastSeq?: number };
        expect(meta1.lastSeq).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the same machine: a loopback peer with forwarded addresses all on this machine (the dev proxy) is local; any other address is not', () => {
    const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers } as unknown as IncomingMessage);
    expect(isLocalRequest(req('127.0.0.1'))).toBe(true);
    expect(isLocalRequest(req('::1'))).toBe(true);
    expect(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' }))).toBe(true);
    expect(isLocalRequest(req('::ffff:127.0.0.1', { 'x-forwarded-for': '::1' }))).toBe(true);
    expect(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '192.168.1.20' }))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', { forwarded: 'for=203.0.113.9' }))).toBe(false);
    expect(isLocalRequest(req('127.0.0.1', { forwarded: 'for="[::1]:5173"' }))).toBe(true);
    expect(isLocalRequest(req('127.0.0.1', { forwarded: 'proto=http' }))).toBe(false);
    // 外から直に来た者が見出しを偽っても、外
    expect(isLocalRequest(req('203.0.113.9', { 'x-forwarded-for': '127.0.0.1' }))).toBe(false);
    expect(isLocalRequest(req('192.168.1.20'))).toBe(false);
  });
});

describe('S3a §27.6: texts', () => {
  it('the warden offer shows its armor and the per-hit estimate with your gear; the relic offer warns that picking it up wakes the floor; the heavy blow perk says only crits grow', async () => {
    const { previewOffers } = await import('@muse/engine');
    const m = manager();
    const r = await m.createRun({ name: 'W', controller: agent, seed: 's3a-warden' });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    // 地下 4 階の遠征を達成して帰った形（標準の枠に、節目に挑む候補が出る）
    const pid = r.playerId;
    w.expeditions = [{ no: 1, objective: { type: 'slay_guardian', targetDepth: 4 }, points: 0, relicGuarded: false, status: 'ended', startSeq: 1, endSeq: 2, endReason: 'completed', participants: [pid], start: {}, targets: { guardian: null, relic: null }, progress: { reached: true, guardianSlain: true, relicHeldBy: null }, extracted: [{ player: pid, completed: true }], result: null } as unknown as Expedition];
    let found = false;
    for (let no = 2; no < 12 && !found; no++) {
      const offers = previewOffers(w, content, no);
      const wo = offers.find((o) => o.objective.type === 'slay_warden');
      if (!wo) continue;
      found = true;
      expect(wo.guardian?.armor).toBeGreaterThanOrEqual(0);
      const camp = structuredClone(w.camp!);
      camp.offers = offers;
      applyEvent(w, { type: 'expedition_offered', camp, seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: 'all' } as unknown as GameEvent);
      const text = formatObservationText(r.port.observe().observation, 'ja');
      expect(text).toMatch(/大守護者「[^」]+」[\s\S]*装甲はおよそ \d+[\s\S]*いまの持ち物で 1 回に通る目安/);
    }
    expect(found).toBe(true);
    const { offerText } = await import('@muse/shared');
    const relic = offerText('ja', { index: 1, objective: { type: 'retrieve_relic', targetDepth: 3 }, points: 100, relicGuarded: false, slot: 'ambitious', traits: [], multiplierPct: 100 } as never);
    expect(relic).toContain('遺物を拾うと、その階の敵が目を覚まして集まり');
    expect(content.perks['core:perk_heavy_blow'].desc.ja).toContain('会心のダメージだけが増える');
    m.closeAll();
  });

  it('explore toward on a fully explored floor still stops, and says the floor is explored and to travel_to a coordinate', async () => {
    const { macroStopError } = await import('@muse/shared');
    const e = macroStopError('ja', 'toward_exhausted', { type: 'explore', toward: 'sense' }, undefined, undefined, undefined, true);
    expect(e.message).toContain('この階は探索し終えている');
    expect(e.hint).toContain('travel_to で座標を指して');
    const e2 = macroStopError('ja', 'toward_exhausted', { type: 'explore', toward: 'sense' });
    expect(e2.message).not.toContain('探索し終えている');
  });
});

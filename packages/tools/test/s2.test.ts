// S2（称号・結果を見返す画面の HTTP。SEASON.md §18.2・§18.3・§18.5）のテスト
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent } from '@muse/shared';
import type { Command, Entity, GameEvent, Pos, SeasonStandingsResponse, World } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's2t';

function manager(): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}

function openSeason(m: SessionManager, id = SID, name = 'S2試し'): void {
  m.seasons.store.open({ id, name, seed: 's2-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}

async function seasonRun(m: SessionManager, name: string, o: { season?: string; profileToken?: string } = {}) {
  const season = o.season ?? SID;
  let ptoken = o.profileToken;
  const inv = m.seasons.invite(season, name, m.profiles.store, ptoken);
  if ('error' in inv) throw new Error(inv.error);
  ptoken = ptoken ?? inv.token!;
  const r = await m.createRun({ name, controller: agent, season, profileToken: ptoken });
  if ('error' in r) throw new Error(r.error.message);
  return Object.assign(r, { ptoken });
}
type Run = Awaited<ReturnType<typeof seasonRun>>;

const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
function editMe(w: World, pid: string, fn: (e: Entity) => void): void { const e = structuredClone(meOf(w, pid)); fn(e); inject(w, { put: [e] }); }
const place = (r: Run, p: Pos) => editMe(r.session.world, r.playerId, (e) => { e.pos = { floor: e.pos!.floor, x: p.x, y: p.y }; });
function setBanked(w: World, pid: string, n: number): void {
  applyEvent(w, { type: 'player_stats', player: pid, stats: { ...w.players[pid].stats, banked: n }, seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [] } as unknown as GameEvent);
}
function clearMonsters(w: World): void {
  inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
}
const floorOf = (r: Run) => meOf(r.session.world, r.playerId).pos!.floor;

function openCells(w: World, key: string, avoid: Pos[] = [], gap = 0): Pos[] {
  const f = w.floors[key];
  const out: Pos[] = [];
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    const tr = content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
    if (!tr.passable || tr.stairs || tr.door || tr.tags.includes('grate') || tr.tags.includes('water')) continue;
    if (Object.values(w.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y)) continue;
    if (avoid.some((a) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) <= gap)) continue;
    out.push({ x, y });
  }
  return out;
}

async function startAndClear(r: Run): Promise<void> {
  const s = await act(r.port, { type: 'start_expedition', offer: 1 });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(r.session.world);
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r.port, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
async function descend(r: Run): Promise<void> {
  const w = r.session.world;
  const d = w.floors[floorOf(r)].stairs.down[0];
  place(r, d);
  // 置いた後に 1 手待って、階段のマスを目で見る（報告できるように）
  expect((await act(r.port, { type: 'wait' })).ok).toBe(true);
  clearMonsters(w);
  const s = await act(r.port, { type: 'stairs' });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(w);
}
const finalize = (m: SessionManager, id = SID) => m.seasons.finalize(m.seasons.get(id)!, 'operator');
const titleNames = (m: SessionManager, id = SID) => (m.seasons.get(id)!.result!.titles ?? []).map((x) => `${x.holder}:${x.name.ja}`).sort();

describe('S2 §18.2: titles', () => {
  it('gives each award\'s first place a title at finalize (data names), all tied leaders get it, and a zero value gets none', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Bo');
    m.seasons.invite(SID, 'Cid', m.profiles.store); // 招いただけ（ランを始めていない）
    // 2 人とも地下 1 階・予算 0・確定点 500 で並ぶ: 生還賞は 2 人とも 1 位。冒険賞は最深が地下 1 階なので付かない（S2a §20.10 の 6）。貢献・支援は値 0 なので付かない
    setBanked(a.session.world, a.playerId, 500);
    setBanked(b.session.world, b.playerId, 500);
    m.seasons.onCommit(a.session, []);
    m.seasons.onCommit(b.session, []);
    finalize(m);
    expect(titleNames(m)).toEqual(['Aya:生還賞（S2試し）', 'Bo:生還賞（S2試し）']);
    const t = m.seasons.get(SID)!.result!.titles![0];
    expect(t.name.en).toBe('Survival award (S2試し)');
    expect(t.kind).toBe('award');
    expect(t.award).toBe('survival');
    void a; void b;
    m.closeAll();
  });

  it('gives the deepest and the most banked their titles, and none in a season with fewer than 2 starters', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Bo');
    await startAndClear(a);
    await descend(a);
    await lifelineHome(a);
    await startAndClear(b);
    await lifelineHome(b);
    setBanked(b.session.world, b.playerId, 100000);
    await act(b.port, { type: 'say', text: 'x' }); // コミットさせて参加者の記録へ写す
    m.seasons.onCommit(b.session, []);
    finalize(m);
    expect(titleNames(m)).toEqual(['Aya:冒険賞（S2試し）', 'Bo:生還賞（S2試し）']);
    m.closeAll();

    const m1 = manager();
    openSeason(m1);
    const solo = await seasonRun(m1, 'Solo');
    await startAndClear(solo);
    await descend(solo);
    await lifelineHome(solo);
    finalize(m1);
    expect(m1.seasons.get(SID)!.result!.titles).toEqual([]);
    expect(m1.seasons.standings(SID)!.standings[0].titles).toEqual([]);
    m1.closeAll();
  });

  it('first warden slayer per depth goes by who reached camp first after the kill', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Bo');
    await startAndClear(a);
    await startAndClear(b);
    // 2 人とも地下 5 階の大守護者を倒した（テストの書き換え）。Aya が先に倒したが、先にキャンプへ着いたのは Bo
    a.session.world.milestones = { cleared: [5] };
    b.session.world.milestones = { cleared: [5] };
    await lifelineHome(b);
    await lifelineHome(a);
    expect(m.seasons.get(SID)!.deeds.map((x) => `${x.depth}:${x.name}`)).toEqual(['5:Bo']);
    // 確定の前の断面には出さない
    expect(m.seasons.standings(SID)!.section.find((r) => r.depth === 5)?.firstWarden).toBeUndefined();
    finalize(m);
    expect(titleNames(m)).toContain('Bo:地下5階の初討伐（S2試し）');
    expect(titleNames(m).some((x) => x.startsWith('Aya:地下5階'))).toBe(false);
    const st = m.seasons.standings(SID)!;
    expect(st.result!.deeds).toEqual([{ depth: 5, name: 'Bo' }]);
    expect(st.section.find((r) => r.depth === 5)?.firstWarden).toBe('Bo');
    m.closeAll();
  });

  it('stays on the profile (profile tool and HTTP) and shows next to the name in the next season\'s standings', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await seasonRun(m, 'Bo');
    await startAndClear(a);
    await descend(a);
    await lifelineHome(a);
    finalize(m);
    // 次のシーズン: 同じプロフィールを招く
    openSeason(m, 's2u', 'S2次');
    await seasonRun(m, 'Aya', { season: 's2u', profileToken: a.ptoken });
    const row = m.seasons.standings('s2u')!.standings.find((r) => r.name === 'Aya')!;
    expect(row.titles!.map((x) => x.name.ja)).toEqual(['冒険賞（S2試し）']);
    expect(row.titles![0].season).toBe(SID);
    // プロフィール（MCP の profile と HTTP の /api/profile が同じ ProfilePort.info）
    const info = m.profilePortForToken(a.ptoken)!.info('ja')!;
    expect(info.text).toContain('称号: 冒険賞（S2試し）');
    expect(info.data.titles).toEqual([{ name: '冒険賞（S2試し）', season: SID, season_name: 'S2試し', kind: 'award', award: 'adventure' }]);
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    try {
      const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
      const prof = (await (await fetch(`${base}/api/profile?locale=en`, { headers: { authorization: `Bearer ${a.ptoken}` } })).json()) as { text: string; titles: { name: string }[] };
      expect(prof.titles.map((x) => x.name)).toEqual(['Adventure award (S2試し)']);
      expect(prof.text).toContain('Titles: Adventure award (S2試し)');
      const st = await (await fetch(`${base}/api/seasons/${SID}`)).text();
      // トークン・プロフィールの ID は出さない
      expect(st).not.toContain(a.ptoken);
      expect(st).not.toContain('prof_');
      const body = JSON.parse(st) as SeasonStandingsResponse;
      expect(body.result!.titles!.map((x) => `${x.holder}:${x.name.ja}`)).toEqual(['Aya:冒険賞（S2試し）']);
      expect(body.standings.find((r) => r.name === 'Aya')!.titles!.length).toBe(1);
    } finally {
      await app.close();
    }
    m.closeAll();
  });
});

describe('S2 §18.1・§18.5: the human screen\'s ports (HTTP and WS) take the same season commands as the AI', () => {
  it('joins over HTTP, then starts, sets a campfire, heals at it, returns from it and reports over WS; tokens stay out of the records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2ws-'));
    const m = new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100 }));
    openSeason(m);
    const inv = m.seasons.invite(SID, 'Hito', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const port = (app.server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    let ws: WebSocket | null = null;
    try {
      // 招かれていないトークンは、サーバーの理由つきで断る（画面はこの文をそのまま出す）
      const bad = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'X', season: SID, profileToken: 'nope', controller: { kind: 'human', label: 'browser' } }) });
      expect(bad.status).toBe(409);
      expect(((await bad.json()) as { error: { message: string } }).error.message).toContain('見つからない');
      // 人間の画面と同じ参加（POST /api/runs { season, profileToken }）
      const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Adventurer', classId: 'core:warrior', locale: 'ja', season: SID, profileToken: inv.token, controller: { kind: 'human', label: 'browser' } }) });
      const joined = (await res.json()) as { runId: string; playerId: string; token: string; profileToken?: string };
      expect(res.status).toBe(200);
      expect(joined.profileToken).toBeUndefined();
      const session = m.get(joined.runId)!;
      const w = session.world;
      const pid = joined.playerId;
      ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const errors: string[] = [];
      ws.on('message', (raw) => { const msg = JSON.parse(String(raw)) as { t: string; error?: { message: string } }; if (msg.t === 'error') errors.push(msg.error!.message); });
      await new Promise<void>((r) => ws!.on('open', () => r()));
      ws.send(JSON.stringify({ t: 'hello', role: 'player', runId: joined.runId, token: joined.token }));
      const until = async (ok: () => boolean, what: string) => {
        for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
        expect(ok() ? '' : `${what}: ${errors.join(' / ')}`).toBe('');
      };
      const cmd = (command: Command) => ws!.send(JSON.stringify({ t: 'command', command }));
      cmd({ type: 'start_expedition', offer: 1 });
      await until(() => w.players[pid].state === 'alive' && !!meOf(w, pid).pos, 'start');
      clearMonsters(w);
      setBanked(w, pid, 1000);
      const k1 = meOf(w, pid).pos!.floor;
      const c1 = openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 2)[0];
      editMe(w, pid, (e) => { e.pos = { floor: k1, x: c1.x, y: c1.y }; e.stats!.hp = 3; });
      cmd({ type: 'place_fire' });
      await until(() => (w.season?.placed ?? []).length === 1, 'place_fire');
      expect(w.players[pid].stats.banked).toBe(900);
      cmd({ type: 'interact' });
      await until(() => (w.season?.fireUses ?? []).length === 1, 'heal at the fire');
      expect(meOf(w, pid).stats!.hp).toBeGreaterThan(3);
      // 2 回目は断られ、理由がそのまま届く
      cmd({ type: 'interact' });
      await until(() => errors.some((e) => e.includes('この階の')), 'second heal refused');
      cmd({ type: 'extract', confirm: true });
      await until(() => w.players[pid].state === 'at_camp', 'return from the fire');
      expect(session.history.some((e) => e.type === 'fire_return' && e.phase === 'done')).toBe(true);
      // キャンプの報告（見た階段が無ければ nothing_to_do。どちらも AI と同じ report_stairs）
      const before = errors.length;
      cmd({ type: 'report_stairs' });
      await until(() => errors.length > before || session.history.some((e) => e.type === 'stairs_reported'), 'report_stairs');
      // 記録（commands.jsonl など）・シーズンの記録に、トークンが出ない
      m.seasons.flush();
      const files: string[] = [];
      const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const p = join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
      walk(dir);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        const text = readFileSync(f, 'utf8');
        expect(text.includes(inv.token!) ? f : '').toBe('');
        // tokens.json は、起動し直したときにランへ戻るための、サーバーのトークンの控え（AI のランも同じ。記録・再生には使わない）
        if (!f.endsWith('tokens.json')) expect(text.includes(joined.token) ? f : '').toBe('');
      }
      // 記録には、AI と同じ命令として残る（source は ws）
      const cmds = readFileSync(join(dir, joined.runId, 'commands.jsonl'), 'utf8');
      for (const t of ['place_fire', 'interact', 'extract']) expect(cmds).toContain(`"type":"${t}"`);
    } finally {
      ws?.close();
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S2 §18.3: the result and the cross-section', () => {
  it('lists per-participant deepest, banked, budget used and falls, and the section shows only what is public (no positions)', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Bo');
    // Aya: 地下 2 階まで（地下 1 階の下り階段を見た）。報告しない
    await startAndClear(a);
    await descend(a);
    await lifelineHome(a);
    // Bo: 地下 1 階に火を置いて、まだ迷宮の中
    await startAndClear(b);
    const w = b.session.world;
    setBanked(w, b.playerId, 1000);
    const k1 = floorOf(b);
    const c1 = openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 2)[0];
    place(b, c1);
    const pf = await act(b.port, { type: 'place_fire' });
    expect(pf.ok ? '' : JSON.stringify(pf.error)).toBe('');
    let st = m.seasons.standings(SID)!;
    expect(st.section.map((r) => r.depth)).toEqual([1, 2]);
    expect(st.section[1].deepest).toEqual(['Aya']);
    expect(st.section[0].deepest).toEqual(['Bo']);
    // 報告していない階段・まだ載っていない火は出ない
    expect(st.section[0].stairs).toBeNull();
    expect(st.section[0].fires).toEqual([]);
    // 報告すると出る（報告した者の名前だけ。位置は出さない）
    expect((await act(a.port, { type: 'report_stairs' })).ok).toBe(true);
    st = m.seasons.standings(SID)!;
    expect(st.section[0].stairs).toEqual({ by: 'Aya' });
    // 火はキャンプに着くと共有層に載り、出る
    await lifelineHome(b);
    st = m.seasons.standings(SID)!;
    expect(st.section[0].fires).toEqual([{ by: 'Bo', uses: 0 }]);
    const json = JSON.stringify(st.section);
    expect(json).not.toMatch(/"x"|"y"/);
    // 取り合いで載らなかった火（dup）は出さない
    m.seasons.get(SID)!.fires.push({ ...m.seasons.get(SID)!.fires[0], order: 9, by: 'Aya', profileId: 'prof_dup', dup: true });
    expect(m.seasons.standings(SID)!.section[0].fires).toEqual([{ by: 'Bo', uses: 0 }]);
    m.seasons.get(SID)!.fires.pop();
    // 参加者ごとの値（倒れた者の確定点も）
    const row = st.standings.find((r) => r.name === 'Bo')!;
    expect(row.banked).toBe(900);
    expect(row.died).toBe(false);
    expect(row.used).toBeGreaterThan(0);
    expect(st.standings.find((r) => r.name === 'Aya')!.adventure.value).toBe(2);
    finalize(m);
    const fin = m.seasons.standings(SID)!;
    expect(fin.result!.standings.find((r) => r.name === 'Bo')!.banked).toBe(900);
    expect(fin.section[0].fires).toEqual([{ by: 'Bo', uses: 0 }]);
    m.closeAll();
  });
});

// S9a（SEASON.md §57.3。版を変えない直し）のテスト: 決めていないものを名前で（観測の行・self.directive.undecided・「できること」の注意・
// 始めた直後の「変化」・迷宮の中の短い指図の行・wait_for_turn の待ち）・持ち主の一覧の行・確定したシーズンのランは命令を受けない・
// 新しいシーズンを開くと前のシーズンが確定する・地図を書き足す品のときだけの文
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createMcpServer, loadConfig, RunSession, SeasonService, SeasonStore, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, EVENT_VERSION, ownerWaitOpen, projectPlayerView } from '@muse/shared';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { rulesText } from '../../server/src/mcp/rules';
import { ownerView } from '../../server/src/session/OwnerPort';
import { seasonCli } from '../src/season';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };

function manager(dir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(dir
    ? { runsDir: join(dir, 'runs'), profilesDir: join(dir, 'profiles'), seasonsDir: join(dir, 'seasons'), waitOthersMs: 100 }
    : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
async function campRun(m: SessionManager, seed: string) {
  const r = await m.createRun({ name: 'Ud', seed, controller: agent });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof campRun>>;
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const owner = (r: Run, cmd: Command) => r.session.submit(r.playerId, cmd, { source: 'owner' });
const errCode = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? 'ok' : x.error!.code);
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
/** 特技の候補を足す（記録の外。再生しないテストだけ） */
function offerPerks(r: Run, n = 3): string[] {
  const opts = Object.entries(catalog.perks).filter(([id, p]) => p.lineage === 'common' && !p.requires.length && !meOf(r.session.world, r.playerId).build?.perks.includes(id)).slice(0, n).map(([id]) => id);
  const e = structuredClone(meOf(r.session.world, r.playerId));
  e.build = { ...e.build!, pending: [{ level: 2, options: opts }] };
  inject(r.session.world, { put: [e] });
  return opts;
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect(errCode(await act(r.port, { type: 'use', slot: life.slot }))).toBe('ok');
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) out.push(...filesUnder(p)); else out.push(p); }
  return out;
}
const hashes = (dir: string) => Object.fromEntries(filesUnder(dir).filter((p) => !p.endsWith('.server.lock')).map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));

describe('S9a §57.3 の 1: what the owner has not decided yet, by name', () => {
  // S9（SEASON.md §58.1）で改めた: 決めていないものは、支度の札の行に入る（指図の行の直後）。「まだ」の間は start_expedition の行を出さず、
  // AI は準備完了まで待つ（「持ち主が特技を選ぶ前に始めると…」の注意は、もう出さない）。待ちは waitForOwner の 1 つ
  it('the camp line and self.directive.undecided; no start lines while not ready; the change after starting with an unchosen perk; the short line inside', async () => {
    expect(ENGINE_VERSION).toBe('0.49.0');
    expect(EVENT_VERSION).toBe(37);
    const m = manager();
    const r = await campRun(m, 's9a-undecided-1');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    // 候補が無ければ、決めていないものは無い（札は準備完了）
    let o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.undecided).toBeUndefined();
    expect(o.text).not.toContain('決めていないもの');
    expect(o.observation.valid_actions.some((l) => l.includes('持ち主が特技を選ぶ前に始めると'))).toBe(false);
    // 遠征の間に候補が出た（記録の外で足す）→ キャンプに着くと、札は「まだ」で、決めていないものが名前で出る
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    const opts = offerPerks(r, 3);
    await lifelineHome(r);
    o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.undecided).toEqual({ perk: { level: 2, options: opts.length, more: 0 }, text: `持ち主が、まだ決めていないもの: 特技（Lv2 の候補 ${opts.length} つ）` });
    const lines = o.text.split('\n');
    const iDir = lines.findIndex((l) => l.startsWith('指図: '));
    expect(lines[iDir + 1]).toBe(`持ち主の支度: まだ（決めていないもの: 特技（Lv2 の候補 ${opts.length} つ））。準備完了になるまで、start_expedition は断られる。待つなら wait_for_turn`);
    // 「できること」: 「まだ」の間は start_expedition の行を出さない（待つ行）
    expect(o.observation.valid_actions.some((l) => l.startsWith('start_expedition'))).toBe(false);
    expect(o.observation.valid_actions.some((l) => l.startsWith('wait_for_turn（待つ: 持ち主の支度'))).toBe(true);
    expect(JSON.stringify(o.observation)).not.toContain('鑑定');
    // 待つ: 準備完了になるか、時間が来るまで（手番は減らない）
    const seq0 = r.session.world.seq;
    expect(await r.port.waitForOwner(30)).toBe('timeout');
    expect(r.session.world.seq).toBe(seq0);
    const w = r.port.waitForOwner(5000);
    expect(errCode(await owner(r, { type: 'choose_perk', option: 1 }))).toBe('ok');
    o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.undecided).toBeUndefined();
    expect(errCode(await owner(r, { type: 'prepare', ready: true }))).toBe('ok');
    expect(await w).toBe('ready');
    // 決めていないものを残して準備完了（記録の外で候補を足す）→ AI が始める: 始めた直後の「変化」に 1 回
    offerPerks(r, 2);
    const s = await act(r.port, { type: 'start_expedition', offer: 1 });
    expect(s.ok).toBe(true);
    const own = s.ok ? s.turn.changes.filter((c) => c.code === 'owner').map((c) => c.text) : [];
    expect(own).toContain('特技を選ばないまま、遠征を始めた（持ち主が選べるのは、次のキャンプ）');
    // 迷宮の中の指図の行は短い。決めていないものの行は出さない（キャンプだけ）
    const oi = r.port.observeWithTurn('observed');
    expect(oi.observation.self.directive?.text).toBe('指図: 特技と加護は、持ち主（キャンプで）');
    expect(oi.observation.self.directive?.undecided).toBeUndefined();
    expect(oi.text).not.toContain('持ち主が、まだ決めていないもの');
    expect(oi.turn.changes.some((c) => c.text.startsWith('特技を選ばないまま'))).toBe(false);
    // 帰ると、キャンプの行がまた出る（候補は保留のまま）
    await lifelineHome(r);
    expect(r.port.observeWithTurn('observed').observation.self.directive?.undecided?.perk?.options).toBe(2);
    m.closeAll();
  });

  // S9（SEASON.md §58.1）で改めた: 装備は「前の準備完了の後に持ち物に入った品」だけを数える（札の seen）。目的を握っていれば「次の遠征の目的」も
  it('equipment held: new equippable pieces are counted; the owner row carries the same; objective held shows the objective; nothing held shows nothing', async () => {
    const m = manager();
    const r = await campRun(m, 's9a-undecided-2');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    expect(r.port.observeWithTurn('observed').observation.self.directive?.undecided).toEqual({ objective: true, text: '持ち主が、まだ決めていないもの: 次の遠征の目的' });
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'loadout'] }))).toBe('ok');
    expect(r.port.observeWithTurn('observed').observation.self.directive?.undecided).toEqual({ objective: true, text: '持ち主が、まだ決めていないもの: 次の遠征の目的' });
    // 持っていた品を外しても、新しく入った品ではないので数えない
    const armor = r.port.view().inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('ok');
    expect(r.port.observeWithTurn('observed').observation.self.directive?.undecided?.gear).toBeUndefined();
    // 新しく持ち物に入った品（記録の外で足す）は数える
    const e = structuredClone(meOf(r.session.world, r.playerId));
    const gid = 'e_s9agr1';
    inject(r.session.world, { put: [{ id: gid, kind: 'core:dagger', sid: 9998, item: { qty: 1, affixes: [], heldBy: e.id, slot: 'q', inspected: true } } as Entity, { ...e, inv: { ...e.inv!, items: [...e.inv!.items, gid] } }] });
    const o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.undecided).toEqual({ objective: true, gear: 1, text: '持ち主が、まだ決めていないもの: 次の遠征の目的・新しく持ち物に入った装備 1 品' });
    // 目的を握られているので、start_expedition の行は無い（注意も無い）
    expect(o.observation.valid_actions.some((l) => l.startsWith('start_expedition'))).toBe(false);
    const row = m.ownerRuns({ local: true }).runs.find((x) => x.runId === r.session.runId)!;
    expect(row.undecided).toEqual(o.observation.self.directive?.undecided);
    // 英語
    r.session.world.players[r.playerId].locale = 'en';
    expect(r.port.observeWithTurn('observed').observation.self.directive?.undecided?.text).toBe('Not yet decided by your owner: the next expedition; 1 new piece of gear in your pack');
    r.session.world.players[r.playerId].locale = 'ja';
    // 持ち主が準備完了を出し、AI が始める: 装備の分は、始めた直後の「変化」に出さない（S9b）
    expect(errCode(await owner(r, { type: 'prepare', objective: 1, ready: true }))).toBe('ok');
    const sx = await act(r.port, { type: 'start_expedition', offer: 1 });
    const ch = sx.ok ? sx.turn.changes.map((c) => c.text) : [];
    expect(ch.some((x) => x.includes('装備'))).toBe(false);
    expect(r.port.observeWithTurn('observed').observation.self.directive?.text).toBe('指図: 目的・装備は、持ち主（キャンプで）');
    // 何も握っていないランは、今までどおり
    const n = await campRun(m, 's9a-undecided-3');
    const on = n.port.observeWithTurn('observed');
    expect(on.observation.self.directive).toBeUndefined();
    expect(m.ownerRuns({ local: true }).runs.find((x) => x.runId === n.session.runId)!.undecided).toBeUndefined();
    m.closeAll();
  });

  // S9（SEASON.md §58.1）で改めた: 待つのは、札が「まだ」の間（準備完了になるまで）。決めるものが無ければ札は最初から準備完了で、すぐ返る
  it('MCP wait_for_turn at camp waits while the preparations are not ready (objective not held), and returns at once when they are', async () => {
    const m = manager();
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 's9a', version: '0' });
    await client.connect(y);
    const nr = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Uw' } })) as unknown as { structuredContent: { run_id: string; player_token: string; player_id: string } };
    const { run_id, player_token, player_id } = nr.structuredContent;
    const s = m.get(run_id)!;
    type T = { structuredContent: { turn: { reason: string }; observation: { self: { directive?: { undecided?: unknown } } } } };
    // 何も決めていないものが無い: すぐ返る（今までどおり）
    const t00 = Date.now();
    await client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 5 } });
    expect(Date.now() - t00).toBeLessThan(2000);
    expect(errCode(await s.submit(player_id, { type: 'set_directive', hold: ['perks'] }, { source: 'owner' }))).toBe('ok');
    // 決めるものが無い: 準備完了なので、すぐ返る
    const t01 = Date.now();
    await client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 5 } });
    expect(Date.now() - t01).toBeLessThan(2000);
    // 遠征の間に候補が出た（記録の外で足す）→ キャンプに着くと「まだ」
    expect(errCode(await s.submit(player_id, { type: 'start_expedition', offer: 1 }, { source: 'mcp' }))).toBe('ok');
    const e = structuredClone(s.world.entities[s.world.players[player_id].entityId]);
    const opts = Object.entries(catalog.perks).filter(([, p]) => p.lineage === 'common' && !p.requires.length).slice(0, 2).map(([id]) => id);
    e.build = { ...e.build!, pending: [{ level: 2, options: opts }] };
    inject(s.world, { put: [e] });
    const life = projectPlayerView(s.world, player_id).inventory.find((it) => it.kind === 'core:lifeline')!;
    expect(errCode(await s.submit(player_id, { type: 'use', slot: life.slot }, { source: 'mcp' }))).toBe('ok');
    for (let i = 0; i < 20 && s.world.players[player_id].state !== 'at_camp'; i++) await s.submit(player_id, { type: 'wait' }, { source: 'mcp' });
    const t0 = (await client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 1 } })) as unknown as T;
    expect(t0.structuredContent.turn.reason).toBe('wait_timeout');
    expect(t0.structuredContent.observation.self.directive?.undecided).toBeDefined();
    const pending = client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 20 } }) as unknown as Promise<T>;
    await new Promise((res) => setTimeout(res, 50));
    expect(errCode(await s.submit(player_id, { type: 'choose_perk', option: 2 }, { source: 'owner' }))).toBe('ok');
    expect(errCode(await s.submit(player_id, { type: 'prepare', ready: true }, { source: 'owner' }))).toBe('ok');
    const t1 = await pending;
    expect(t1.structuredContent.turn.reason).toBe('observed');
    expect(t1.structuredContent.observation.self.directive?.undecided).toBeUndefined();
    await client.close();
    m.closeAll();
  });

  it('the rules mention the undecided line (ja and en)', () => {
    expect(rulesText('directive', 'ja', catalog)).toContain('持ち主が、まだ決めていないもの（S9a）');
    expect(rulesText('directive', 'en', catalog)).toContain('Not yet decided (S9a)');
    expect(rulesText('season', 'ja', catalog)).toContain('そのシーズンのランは、もう命令を受けない');
    expect(rulesText('season', 'en', catalog)).toContain('take no more commands');
  });
});

const SID = 's9at';
function openSeason(m: SessionManager, id = SID): void {
  m.seasons.store.open({ id, name: `試し${id}`, seed: `${id}-seed`, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
async function seasonRun(m: SessionManager, name: string, id = SID) {
  const inv = m.seasons.invite(id, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: id, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}

describe('S9a §57.3 の 4: a finalized season\'s runs take no commands', () => {
  it('player and owner are refused without turns or records (at camp and inside); open seasons and non-season runs are unchanged; recovery leaves the records as they are', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s9a-'));
    try {
      const m = manager(dir);
      openSeason(m);
      openSeason(m, 's9au');
      const a = await seasonRun(m, 'Ai');
      const b = await seasonRun(m, 'Bu');
      const c = await seasonRun(m, 'Ce', 's9au');
      const plain = await campRun(m, 's9a-plain');
      expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
      expect(errCode(await act(a.port, { type: 'note', add: '前の覚え書き' } as Command))).toBe('ok');
      // 確定する前: 出撃に出る
      expect(m.ownerRuns({ local: true }).runs.some((x) => x.runId === a.session.runId)).toBe(true);
      m.seasons.finalize(m.seasons.get(SID)!, 'operator');
      const runDir = (r: Run) => join(dir, 'runs', r.session.runId);
      const before = { a: hashes(runDir(a)), b: hashes(runDir(b)) };
      const seqs = { a: a.session.world.seq, b: b.session.world.seq };
      const hist = { a: a.session.history.length, b: b.session.history.length };
      // プレイヤーの口（キャンプ・迷宮の中・マクロ・手番を使わない命令）
      for (const cmd of [{ type: 'start_expedition', offer: 1 }, { type: 'retire' }, { type: 'report_stairs' }, { type: 'note', add: 'x' }] as Command[]) {
        const x = await act(a.port, cmd);
        expect(errCode(x)).toBe('season_ended');
        if (!x.ok) expect(x.error.message).toContain('このシーズン（試しs9at）は終わった。このランは、もう命令を受けない。記録は、見返せる。');
      }
      for (const cmd of [{ type: 'wait' }, { type: 'explore' }, { type: 'stairs' }] as Command[]) expect(errCode(await act(b.port, cmd))).toBe('season_ended');
      // 持ち主の口
      expect(errCode(await owner(a, { type: 'set_directive', hold: ['objective'] }))).toBe('season_ended');
      expect(errCode(await owner(b, { type: 'set_directive', hold: [] }))).toBe('season_ended');
      expect(a.session.world.seq).toBe(seqs.a);
      expect(b.session.world.seq).toBe(seqs.b);
      expect(a.session.history.length).toBe(hist.a);
      expect(b.session.history.length).toBe(hist.b);
      expect(hashes(runDir(a))).toEqual(before.a);
      expect(hashes(runDir(b))).toEqual(before.b);
      // 「出撃」に出さない
      const rows = m.ownerRuns({ local: true }).runs.map((x) => x.runId);
      expect(rows).not.toContain(a.session.runId);
      expect(rows).not.toContain(b.session.runId);
      expect(rows).toContain(c.session.runId);
      // 開催中のシーズンのランと、シーズンでないランは、今までどおり
      expect(errCode(await act(c.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
      expect(errCode(await act(c.port, { type: 'wait' }))).toBe('ok');
      expect(errCode(await act(plain.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
      expect(errCode(await act(plain.port, { type: 'wait' }))).toBe('ok');
      // 起動し直す: 復旧は記録と一致し、記録を変えない。その後も断る
      const ids = { a: a.session.runId, b: b.session.runId };
      m.closeAll();
      const m2 = manager(dir);
      for (const k of ['a', 'b'] as const) {
        const rec = RunSession.recover(m2.deps, ids[k]);
        expect(rec.verified).toBe(true);
        const pid = rec.session.world.playerOrder[0];
        expect(errCode(await rec.session.submit(pid, { type: 'wait' }, { source: 'mcp' }))).toBe('season_ended');
        rec.session.close();
      }
      m2.closeAll();
      expect(hashes(join(dir, 'runs', ids.a))).toEqual(before.a);
      expect(hashes(join(dir, 'runs', ids.b))).toEqual(before.b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opening a new season: without --close-previous nothing happens; with it the others are finalized first and named; a duplicate id closes nothing (S9b)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s9a-open-'));
    try {
      const sdir = join(dir, 'seasons');
      const ends = new Date(Date.now() + 86_400_000).toISOString();
      const out: string[] = [];
      const log = (s: string) => out.push(s);
      const svc = () => new SeasonService(new SeasonStore(sdir), { engineVersion: ENGINE_VERSION, contentVersion: content.version }, () => null, Date.now, 10, content.lists.seasonTitles);
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_old', seed: 'a', ends, name: '古い' }, log)).toBe(0);
      // --close-previous が無い: 何もせずに 1 で終える（名前と ID を並べる）
      out.length = 0;
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_done', seed: 'b', ends }, log)).toBe(1);
      expect(out).toContain('開催中のシーズン s_old「古い」がある。新しいシーズンを開くと、それを確定する（元に戻せない）。よければ --close-previous を付ける');
      expect(svc().isFinal('s_old')).toBe(false);
      expect(existsSync(join(sdir, 's_done'))).toBe(false);
      // 付ける: 確定してから開く
      out.length = 0;
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_done', seed: 'b', ends, closePrevious: true }, log)).toBe(0);
      expect(out.some((l) => l.startsWith('前のシーズン s_old「古い」を確定した'))).toBe(true);
      expect(existsSync(join(sdir, 's_old', 'result.json'))).toBe(true);
      expect(svc().isFinal('s_old')).toBe(true);
      expect(svc().isFinal('s_done')).toBe(false);
      out.length = 0;
      // 同じ ID: 何も確定しない
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_done', seed: 'c', ends, closePrevious: true }, log)).toBe(1);
      expect(svc().isFinal('s_done')).toBe(false);
      expect(out.some((l) => l.includes('確定した'))).toBe(false);
      // 3 つ目: s_done だけを確定する（s_old は確定し直さない）。サーバーの印に生きたプロセス（このテストのプロセス）があれば注意を 1 行
      const runsDir = join(dir, 'runs');
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(join(runsDir, '.server.lock'), JSON.stringify({ pid: process.pid, startedAt: Date.now(), port: 7999 }));
      const oldResult = readFileSync(join(sdir, 's_old', 'result.json'), 'utf8');
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_new', seed: 'd', ends, closePrevious: true, runsDir }, log)).toBe(0);
      expect(out.some((l) => l.startsWith('注意: 記録の置き場所の印（.server.lock）に、生きているプロセス（pid '))).toBe(true);
      expect(out.filter((l) => l.startsWith('前のシーズン')).map((l) => l.split('「')[0])).toEqual(['前のシーズン s_done']);
      expect(readFileSync(join(sdir, 's_old', 'result.json'), 'utf8')).toBe(oldResult);
      expect(svc().isFinal('s_done')).toBe(true);
      expect(svc().isFinal('s_new')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a season with unreadable records stops open: nothing is finalized or opened (S9b)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s9a-broken-'));
    try {
      const sdir = join(dir, 'seasons');
      const ends = new Date(Date.now() + 86_400_000).toISOString();
      const out: string[] = [];
      const log = (s: string) => out.push(s);
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_ok', seed: 'a', ends }, log)).toBe(0);
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_bad', seed: 'b', ends, closePrevious: true }, log)).toBe(0);
      writeFileSync(join(sdir, 's_bad', 'result.json'), '{ broken');
      out.length = 0;
      expect(seasonCli(content, { sub: 'open', dir: sdir, id: 's_next', seed: 'c', ends, closePrevious: true }, log)).toBe(1);
      expect(out.some((l) => l.startsWith('シーズン s_bad の記録が読めない: ') && l.includes('result.json'))).toBe(true);
      expect(out.some((l) => l.includes('を確定した'))).toBe(false);
      expect(existsSync(join(sdir, 's_next'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S9b: a finalized season\'s run looks closed (its end time still ahead)', () => {
  it('the head line, no actions, season.ended true, no waits; wait_for_turn returns at once; the owner view says the same', async () => {
    const m = manager();
    openSeason(m, 's9bf');
    const a = await seasonRun(m, 'Fa', 's9bf');
    const b = await seasonRun(m, 'Fb', 's9bf');
    expect(errCode(await a.session.submit(a.playerId, { type: 'set_directive', hold: ['objective', 'perks'] }, { source: 'owner' }))).toBe('ok');
    offerPerks(a, 2);
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    expect(m.seasons.get('s9bf')!.def.endsAt).toBeGreaterThan(Date.now());
    // 確定する前: 待つ・決めていないもの・「できること」がある
    expect(r0(a).observation.self.directive?.undecided).toBeDefined();
    expect(r0(a).turn.owner_wait).toBeDefined();
    m.seasons.finalize(m.seasons.get('s9bf')!, 'operator');
    const head = 'このシーズン（試しs9bf）は終わった。このランは、もう命令を受けない。記録は、見返せる。';
    for (const r of [a, b]) {
      const o = r.port.observeWithTurn('observed');
      expect(o.observation.season?.ended).toBe(true);
      expect(o.observation.season?.final).toBe(true);
      expect(o.observation.valid_actions).toEqual([]);
      expect(o.text.split('\n')[1]).toBe(head);
      expect(o.text).toContain(`▶ ${head}`);
      expect(o.turn.awaiting).toBe('nothing');
      expect(o.turn.owner_wait).toBeUndefined();
      expect(o.text).not.toContain('報告と引退はできる');
    }
    const oa = r0(a);
    expect(oa.observation.self.directive?.undecided).toBeUndefined();
    expect(oa.text).not.toContain('wait_for_turn（待つ');
    expect(ownerWaitOpen(a.port.view())).toBe(false);
    // 持ち主の口の表示も同じ
    const ov = ownerView(a.session, a.playerId);
    expect(ov.waiting).toBe(false);
    expect(ov.observation.season?.final).toBe(true);
    expect(ov.observation.valid_actions).toEqual([]);
    expect(ov.text).toContain(head);
    // 英語
    a.session.world.players[a.playerId].locale = 'en';
    expect(r0(a).observation.season?.final_text).toBe('This season (試しs9bf) is over; this run takes no more commands. Its records can be looked back on.');
    a.session.world.players[a.playerId].locale = 'ja';
    // MCP の wait_for_turn: すぐ返る
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 's9b', version: '0' });
    await client.connect(y);
    const t0 = Date.now();
    const w = (await client.callTool({ name: 'wait_for_turn', arguments: { player_token: a.token, timeout_s: 10 } })) as unknown as { structuredContent: { turn: { reason: string } } };
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(w.structuredContent.turn.reason).toBe('observed');
    await client.close();
    m.closeAll();
  });

  // S9（SEASON.md §58.1）で改めた: 持ち主が付け替えたら札は「まだ」になり、準備完了まで待つ。持ち物の品は札が覚えているので、装備のことは知らせない
  it('equipment only: after the owner re-gears, wait_for_turn waits until ready; nothing about gear appears in the changes after starting (S9b)', async () => {
    const m = manager();
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 's9b-g', version: '0' });
    await client.connect(y);
    const nr = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Ug' } })) as unknown as { structuredContent: { run_id: string; player_token: string; player_id: string } };
    const { run_id, player_token, player_id } = nr.structuredContent;
    const s = m.get(run_id)!;
    expect(errCode(await s.submit(player_id, { type: 'set_directive', hold: ['loadout'] }, { source: 'owner' }))).toBe('ok');
    const armor = projectPlayerView(s.world, player_id).inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await s.submit(player_id, { type: 'unequip', slot: armor.slot }, { source: 'owner' }))).toBe('ok');
    type T = { structuredContent: { turn: { reason: string; changes: { text: string }[] }; observation: { valid_actions: string[]; self: { directive?: { undecided?: { gear?: number }; prep?: { state: string } } } } } };
    const w = (await client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 1 } })) as unknown as T;
    expect(w.structuredContent.turn.reason).toBe('wait_timeout');
    expect(w.structuredContent.observation.self.directive?.prep?.state).toBe('pending');
    // 持っていた品なので、決めていないものには数えない
    expect(w.structuredContent.observation.self.directive?.undecided).toBeUndefined();
    expect(errCode(await s.submit(player_id, { type: 'prepare', ready: true }, { source: 'owner' }))).toBe('ok');
    const t0 = Date.now();
    const w2 = (await client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 10 } })) as unknown as T;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(w2.structuredContent.observation.valid_actions.some((l) => l.includes('持ち主が特技'))).toBe(false);
    const st = (await client.callTool({ name: 'start_expedition', arguments: { player_token, offer: 1 } })) as unknown as T;
    expect(st.structuredContent.turn.changes.some((c) => c.text.includes('装備'))).toBe(false);
    await client.close();
    m.closeAll();
  });
});

const r0 = (r: Run) => r.port.observeWithTurn('observed');

describe('S9a §57.3 の 5: the map sentence only for items that write the map', () => {
  it('a healing potion says nothing about the map; a loose page and an unidentified mapping scroll do', async () => {
    const a = await arena('s9a-potion', { map: ['P.....G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 30, items: [{ kind: 'core:potion_healing' }, { kind: 'core:loose_page' }, { kind: 'core:scroll_mapping' }] } });
    const me = structuredClone(a.world.entities[a.meId]);
    me.stats!.hp = 10;
    a.inject({ put: [me] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const inv = () => a.r.port.view().inventory;
    // 視界の中に、もう無い品の覚え（見直すと消える）: 薬を使った手番に、視界の変わらない knowledge_updated（visible: null）が出る
    a.world.players[a.pid].knowledge.floors[a.key].remembered.push({ id: 'e_ghost1', kind: 'core:throwing_knife', cat: 'item', pos: { x: a.ox + 2, y: a.oy }, qty: 1, ft: 0 });
    const seqP = a.world.seq;
    const pot = await a.r.port.act({ type: 'use', slot: inv().find((i) => i.kind === 'core:potion_healing')!.slot }, { source: 'bot' });
    expect(pot.ok).toBe(true);
    if (pot.ok) {
      expect(pot.outcome).not.toContain('地図に載った');
      expect(pot.outcome).not.toContain('地形が地図に');
    }
    // 薬を使った手番にも、地図に関わらない知識の更新（視界の変わらない knowledge_updated）は出ていた（直す前は、これを数えていた）
    expect(a.r.session.history.some((e) => e.seq > seqP && e.type === 'knowledge_updated' && (e as { visible?: unknown }).visible === null && (e as { player?: string }).player === a.pid)).toBe(true);
    const page = await a.r.port.act({ type: 'use', slot: inv().find((i) => i.kind === 'core:loose_page')!.slot }, { source: 'bot' });
    expect(page.ok && page.outcome).toMatch(/地形が地図に載った（新しく \d+ マス。|新しく地図に載った地形は無かった/);
    // 未鑑定の地図の巻物（使って分かった種類から引く）
    const k = a.world.players[a.pid].knowledge;
    k.identified = k.identified.filter((x) => x !== 'core:scroll_mapping');
    const sc = inv().find((i) => !i.kind && i.appearanceId);
    expect(sc).toBeDefined();
    const used = await a.r.port.act({ type: 'use', slot: sc!.slot }, { source: 'bot' });
    expect(used.ok && used.outcome).toMatch(/地形が地図に載った（新しく \d+ マス。|新しく地図に載った地形は無かった/);
    a.manager.closeAll();
  });
});

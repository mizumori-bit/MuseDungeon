// S3d（SEASON.md §36）のテスト: S3c の検査の指摘（キーフレームが記録より先に進む・壊れていない管理ファイル・書けなかった管理ファイル・
// トークンの控え・名前の付け替えの待ち・一時のファイル・パス・確定の記録・2 つ目のサーバー）と、条件を外す再挑戦の倍率
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION, previewOffers } from '@muse/engine';
import { atomicWriteHooks, dropPendingWrites, loadConfig, RUNS_LOCK, scrubPaths, SessionManager, writeFileAtomic } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent } from '@muse/shared';
import type { Command, Entity, GameEvent, World } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'muse-s3d-')); dirs.push(d); return d; };
afterEach(() => {
  atomicWriteHooks.beforeRename = null;
  atomicWriteHooks.rename = (a, b) => renameSync(a, b);
  atomicWriteHooks.read = (p) => readFileSync(p, 'utf8');
  dropPendingWrites();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mgr = (dir: string, keyframeEvery = 500) => new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100, keyframeEvery }));
const restart = (dir: string, keyframeEvery = 500) => { const m = mgr(dir, keyframeEvery); const logs: string[] = []; m.recoverAll((s) => logs.push(s)); return { m, logs }; };
const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { seq: number; cseq: number; resultSeq?: [number, number] | null });

async function waitedRun(dir: string, seed: string, waits: number, keyframeEvery = 500) {
  const m = mgr(dir, keyframeEvery);
  const r = await m.createRun({ name: 'Rev', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  for (let i = 0; i < waits; i++) await act(r.port, { type: 'wait' });
  const out = { runId: r.session.runId, token: r.token, seq: r.session.world.seq, rd: join(dir, r.session.runId) };
  m.closeAll();
  return out;
}
const uniqueSeqs = (p: string) => { const s = lines(p).map((e) => e.seq); return s.every((v, i) => i === 0 || v > s[i - 1]); };

describe('S3d §36.1 の 1: a keyframe ahead of the logs', () => {
  it('a keyframe written past the last surviving command is set aside; the next restart does not rewind the run', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 'rev-pl-2', 40, 30);
    const kd = join(run.rd, 'keyframes');
    const kfs = readdirSync(kd).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
    const kf = JSON.parse(readFileSync(join(kd, `${kfs.at(-1)}.json`), 'utf8')) as { seq: number; cseq: number };
    // 機械が止まって、命令と出来事の記録の末尾だけが失われた形（キーフレームの 3 命令前まで）
    const cmds = lines(join(run.rd, 'commands.jsonl'));
    const keep = cmds.filter((c) => c.cseq <= kf.cseq - 3);
    const cutSeq = [...keep].reverse().find((c) => c.resultSeq)!.resultSeq![1];
    writeFileSync(join(run.rd, 'commands.jsonl'), keep.map((c) => JSON.stringify(c)).join('\n') + '\n');
    writeFileSync(join(run.rd, 'events.jsonl'), lines(join(run.rd, 'events.jsonl')).filter((e) => e.seq <= cutSeq).map((e) => JSON.stringify(e)).join('\n') + '\n');
    const a = restart(dir, 30);
    const rec = a.logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
    expect(rec).toContain('hash ok');
    expect(rec).toContain('記録より先に進んだキーフレーム 1 個');
    expect(existsSync(join(kd, `${kf.seq}.json.ahead`))).toBe(true);
    const s = a.m.get(run.runId)!;
    expect(s.world.seq).toBe(cutSeq);
    const port = a.m.portForToken(run.token)!;
    for (let i = 0; i < 2; i++) await act(port, { type: 'wait' });
    const seq = s.world.seq;
    a.m.closeAll();
    // 命令の番号は重ならない・出来事の番号も重ならない
    const cs = lines(join(run.rd, 'commands.jsonl')).map((c) => c.cseq);
    expect(cs.every((v, i) => i === 0 || v > cs[i - 1])).toBe(true);
    expect(uniqueSeqs(join(run.rd, 'events.jsonl'))).toBe(true);
    const b = restart(dir, 30);
    expect(b.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('hash ok');
    expect(b.m.get(run.runId)!.world.seq).toBe(seq);
    b.m.closeAll();
  });

  it('events written after the last command (crash between the two appends) are cut and kept aside; the run goes on without a mismatch', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3d-orphan', 5);
    const ep = join(run.rd, 'events.jsonl');
    const evs = lines(ep);
    const last = evs.at(-1)!;
    appendFileSync(ep, [1, 2].map((k) => JSON.stringify({ ...last, seq: last.seq + k })).join('\n') + '\n');
    const a = restart(dir);
    const rec = a.logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
    expect(rec).toContain('hash ok');
    expect(rec).toContain('命令の記録が覆っていない出来事 2 件');
    expect(lines(`${ep}.uncommitted`).map((e) => e.seq)).toEqual([last.seq + 1, last.seq + 2]);
    await act(a.m.portForToken(run.token)!, { type: 'wait' });
    a.m.closeAll();
    expect(uniqueSeqs(ep)).toBe(true);
    const b = restart(dir);
    expect(b.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('hash ok');
    b.m.closeAll();
  });

  it('commands that outlived their events (only the event append was lost) are replayed and the missing events written back', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3d-missing', 6);
    const ep = join(run.rd, 'events.jsonl');
    const evs = lines(ep);
    writeFileSync(ep, evs.slice(0, -3).map((e) => JSON.stringify(e)).join('\n') + '\n');
    const a = restart(dir);
    const rec = a.logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
    expect(rec).toContain('hash ok');
    expect(rec).toContain('欠けていた 3 件');
    expect(a.m.get(run.runId)!.world.seq).toBe(run.seq);
    a.m.closeAll();
    expect(lines(ep).at(-1)!.seq).toBe(run.seq);
    expect(uniqueSeqs(ep)).toBe(true);
  });
});

describe('S3d §36.1 の 2〜6: management files', () => {
  it('2: a meta.json with a BOM is read as it is (not rebuilt); one locked for a moment is read after a retry; one locked for long is a recovery failure and stays untouched', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3d-bom', 3);
    const mp = join(run.rd, 'meta.json');
    const orig = readFileSync(mp, 'utf8');
    writeFileSync(mp, '\uFEFF' + orig);
    let a = restart(dir);
    expect(existsSync(`${mp}.broken`)).toBe(false);
    expect(a.logs.some((l) => l.startsWith('rebuilt meta.json'))).toBe(false);
    expect(a.m.get(run.runId)).toBeTruthy();
    a.m.closeAll();
    // しばらく読めない（2 回だけ EBUSY）: 読み直して、ふつうに復旧
    let busy = 2;
    atomicWriteHooks.read = (p) => { if (p.endsWith('meta.json') && busy-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return readFileSync(p, 'utf8'); };
    a = restart(dir);
    expect(a.m.get(run.runId)).toBeTruthy();
    a.m.closeAll();
    // ずっと読めない: 作り直さず、復旧に失敗したランとして出す（次の起動で直る）
    atomicWriteHooks.read = (p) => { if (p.endsWith('meta.json')) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return readFileSync(p, 'utf8'); };
    a = restart(dir);
    expect(a.m.get(run.runId)).toBeUndefined();
    expect(a.m.listRuns().find((x) => x.runId === run.runId)!.recoveryFailed!.reason).toContain('一時的に読めない');
    expect(readdirSync(run.rd).filter((f) => f.startsWith('meta.json'))).toEqual(['meta.json']);
    a.m.closeAll();
    atomicWriteHooks.read = (p) => readFileSync(p, 'utf8');
    a = restart(dir);
    expect(a.m.get(run.runId)).toBeTruthy();
    a.m.closeAll();
  });

  it('3: a meta.json that could not be written at the end of a run (and was never retried) does not bring the run back to life', async () => {
    const dir = tmp();
    const m = mgr(dir);
    const r = await m.createRun({ name: 'Rev', seed: 'rev-st', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    for (let i = 0; i < 3; i++) await act(r.port, { type: 'wait' });
    const runId = r.session.runId;
    atomicWriteHooks.rename = (a, b) => { if (b.endsWith('meta.json')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); renameSync(a, b); };
    expect((await act(r.port, { type: 'retire' })).ok).toBe(true);
    // 書けないまま機械が止まった（やり直しの分も失われた）
    dropPendingWrites();
    atomicWriteHooks.rename = (a, b) => renameSync(a, b);
    m.closeAll();
    expect(JSON.parse(readFileSync(join(dir, runId, 'meta.json'), 'utf8')).status).toBe('active');
    const a = restart(dir);
    expect(a.m.get(runId)).toBeUndefined();
    expect(a.logs.some((l) => l.includes(`${runId} は終わっていた`))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, runId, 'meta.json'), 'utf8')).status).toBe('ended');
    expect(a.m.listRuns().find((x) => x.runId === runId)!.status).toBe('ended');
    a.m.closeAll();
    // 次の起動でも、終わったまま（読み込まない）
    const b = restart(dir);
    expect(b.logs.some((l) => l.startsWith(`recovered ${runId}`))).toBe(false);
    b.m.closeAll();
  });

  it('3: a meta.json that failed to be written is written again on the next write or when the server closes (no restart needed)', async () => {
    const dir = tmp();
    const m = mgr(dir);
    const r = await m.createRun({ name: 'Rev', seed: 'rev-st2', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const runId = r.session.runId;
    atomicWriteHooks.rename = (a, b) => { if (b.endsWith('meta.json')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); renameSync(a, b); };
    expect((await act(r.port, { type: 'retire' })).ok).toBe(true);
    atomicWriteHooks.rename = (a, b) => renameSync(a, b);
    expect(JSON.parse(readFileSync(join(dir, runId, 'meta.json'), 'utf8')).status).toBe('active');
    m.closeAll();
    expect(JSON.parse(readFileSync(join(dir, runId, 'meta.json'), 'utf8')).status).toBe('ended');
  });

  it('4: when the token record cannot be written, the join is refused and the run is left unchanged', async () => {
    const dir = tmp();
    const m = mgr(dir);
    atomicWriteHooks.rename = (a, b) => { if (b.endsWith('tokens.json')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); renameSync(a, b); };
    const r = await m.createRun({ name: 'Rev', seed: 's3d-tok', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error.message).toContain('トークン');
    expect(m.listRuns()).toEqual([]);
    atomicWriteHooks.rename = (a, b) => renameSync(a, b);
    const ok = await m.createRun({ name: 'Rev', seed: 's3d-tok', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    expect('error' in ok).toBe(false);
    if (!('error' in ok)) expect(JSON.parse(readFileSync(join(dir, ok.session.runId, 'tokens.json'), 'utf8'))[ok.token]).toBe(ok.playerId);
    m.closeAll();
  });

  it('5: a rename blocked by another program gives up within about 100 ms (it used to block the whole server for a second)', () => {
    const dir = tmp();
    const p = join(dir, 'x.json');
    writeFileSync(p, 'old');
    let tries = 0;
    atomicWriteHooks.rename = () => { tries++; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
    const t0 = performance.now();
    expect(() => writeFileAtomic(p, 'new')).toThrow(/EPERM/);
    const ms = performance.now() - t0;
    expect(tries).toBe(4);
    expect(ms).toBeLessThan(400);
    expect(readFileSync(p, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual(['x.json']);
  });

  it('6: leftover temp files of dead writers are swept at start (a live writer\'s are kept); failure reasons carry no absolute path', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3d-tmp', 2);
    writeFileSync(join(run.rd, 'meta.json.999999.1.tmp'), 'x');
    writeFileSync(join(run.rd, 'meta.json.tmp'), 'x');
    writeFileSync(join(run.rd, 'keyframes', '5.json.999999.2.tmp'), 'x');
    const mine = `summary.json.${process.pid}.77.tmp`;
    writeFileSync(join(run.rd, mine), 'x');
    const a = restart(dir);
    // 今の書き方の名前（プロセスの番号つき）で、書いたプロセスが居ないものだけ（古い形の .tmp は消さない。S3e §38.2 の 5）
    expect(a.logs.some((l) => l.startsWith('残っていた一時のファイル 2 個を消した'))).toBe(true);
    expect(readdirSync(run.rd).filter((f) => f.endsWith('.tmp')).sort()).toEqual(['meta.json.tmp', mine].sort());
    a.m.closeAll();
    expect(scrubPaths(`ENOENT: open '${join(dir, 'run_x', 'keyframes', '1.json')}'`, dir)).toBe(`ENOENT: open '${join('run_x', 'keyframes', '1.json')}'`);
    expect(scrubPaths("open 'C:\\Users\\someone\\x\\y.json'", dir)).toBe("open 'y.json'");
  });

  it('6: a second server on the same runs folder stops before recovering; a stale lock (dead process, or a live pid whose port does not answer) is cleaned; the lock is not taken for a run', async () => {
    const dir = tmp();
    const m = mgr(dir);
    const lock = join(dir, RUNS_LOCK);
    const yes = async () => true;
    const no = async () => false;
    // 生きている別のプロセス（このテストを動かしている親）が、起動の途中（まだ待ち受けていない）
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now(), port: 7, listening: false }));
    expect(await m.acquireRunsLock(() => undefined, no)).toContain('ほかのサーバー');
    // 待ち受けていて、ポートが応える
    writeFileSync(lock, JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 1000, port: 7, listening: true }));
    expect(await m.acquireRunsLock(() => undefined, yes)).toContain('ほかのサーバー');
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.ppid);
    // プロセスは居るが、ポートが応えない（番号の使い回し・高速スタートアップ）: 古い印
    const logs: string[] = [];
    expect(await m.acquireRunsLock((s) => logs.push(s), no)).toBeNull();
    expect(logs.some((l) => l.includes('古いサーバーの印'))).toBe(true);
    expect(JSON.parse(readFileSync(lock, 'utf8')).pid).toBe(process.pid);
    m.markRunsLockListening();
    expect(JSON.parse(readFileSync(lock, 'utf8')).listening).toBe(true);
    m.releaseRunsLock();
    // もう居ないプロセスの印
    writeFileSync(lock, JSON.stringify({ pid: 999999, startedAt: Date.now(), port: 7, listening: false }));
    expect(await m.acquireRunsLock(() => undefined, yes)).toBeNull();
    expect(m.store!.listRunDirs()).toEqual([]);
    m.recoverAll();
    expect(m.listRuns()).toEqual([]);
    m.releaseRunsLock();
    expect(existsSync(lock)).toBe(false);
    // 同時に 2 つ起動しても、両方は起動しない
    const m2 = mgr(dir);
    const [x, y] = await Promise.all([m.acquireRunsLock(() => undefined, no), m2.acquireRunsLock(() => undefined, no)]);
    expect([x, y].filter((v) => v === null).length).toBeLessThanOrEqual(1);
    m.releaseRunsLock();
    m2.releaseRunsLock();
    m.closeAll();
    m2.closeAll();
  });

  it('6: an unreadable result.json is not taken as "not final": the season is not loaded nor written, nor finalized again', () => {
    const dir = tmp();
    const m = mgr(dir);
    const SID = 's3dt';
    m.seasons.store.open({ id: SID, name: 'S3d', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const d = m.seasons.get(SID)!;
    expect(d).toBeTruthy();
    // 別のプロセス（運用の道具）が確定を書いている途中で、中身が壊れた形
    const rp = join(dir, 'seasons', SID, 'result.json');
    writeFileSync(rp, '{"finalizedAt":');
    expect(m.seasons.get(SID)).toBeNull();
    expect(m.seasons.brokenSeasons().map((b) => b.id)).toEqual([SID]);
    m.seasons.finalize(d, 'operator');
    expect(readFileSync(rp, 'utf8')).toBe('{"finalizedAt":');
    m.seasons.store.saveParticipants(d);
    expect(existsSync(join(dir, 'seasons', SID, 'participants.json'))).toBe(false);
    m.closeAll();
    // BOM つきの season.json は読める
    const m2 = mgr(dir);
    writeFileSync(rp, '\uFEFF' + JSON.stringify({ finalizedAt: 1, reason: 'operator', winners: { adventure: [], contribution: [], survival: [], support: [] }, standings: [] }));
    const sp = join(dir, 'seasons', SID, 'season.json');
    writeFileSync(sp, '\uFEFF' + readFileSync(sp, 'utf8'));
    expect(m2.seasons.get(SID)?.result?.finalizedAt).toBe(1);
    m2.closeAll();
  });
});

function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}

describe('S3d §36.1 の 7: a rechallenge drops conditions that only shape a new floor', () => {
  it('the inherited multiplier is counted again from the conditions it keeps', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const r = await m.createRun({ name: 'R', seed: 'v33b-offer-1', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const pid = r.port.playerId;
    const me = () => w.entities[w.players[pid].entityId];
    const clear = () => inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
    const toDown = async () => { const f = w.floors[me().pos!.floor]; const e = structuredClone(me()); e.pos = { floor: e.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y }; inject(w, { put: [e] }); clear(); await act(r.port, { type: 'wait' }); };
    const reach = w.expeditions!.at(-1)!;
    reach.objective.targetDepth = 4;
    for (let dd = 1; dd < 4; dd++) { await toDown(); expect((await act(r.port, { type: 'stairs' })).ok).toBe(true); clear(); }
    await toDown();
    expect((await act(r.port, { type: 'extract' })).ok).toBe(true);
    const safe = w.camp!.offers.find((o) => o.slot === 'safe')!;
    expect((await act(r.port, { type: 'start_expedition', offer: safe.index })).ok).toBe(true);
    const origin = w.expeditions!.at(-1)!;
    // 置いた遠征が、群れる（階を作るときだけ）と薄暗い（遠征の間に効く）を持っていた
    const crowded = content.expeditionTraits['core:crowded'];
    const dim = content.expeditionTraits['core:dim'];
    origin.traits = ['core:crowded', 'core:dim'];
    origin.multiplierPct = Math.trunc((Math.trunc((100 * crowded.multiplierPct) / 100) * dim.multiplierPct) / 100);
    clear();
    await toDown();
    expect((await act(r.port, { type: 'extract', confirm: true })).ok).toBe(true);
    const re = previewOffers(w, content, w.camp!.nextNo).find((o) => o.slot === 'safe')!;
    expect(re.rechallenge?.inherits).toBe(true);
    expect(re.traits).toEqual(['core:dim']);
    expect(re.multiplierPct).toBe(dim.multiplierPct);
    m.closeAll();
  });
});

// S3c（SEASON.md §33）のテスト: ランの管理ファイルが壊れたときの扱い（§33.1）
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { atomicWriteHooks, loadConfig, SessionManager, writeFileAtomic } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import type { Command, RunMetaFile } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'muse-s3c-')); dirs.push(d); return d; };
afterEach(() => {
  atomicWriteHooks.beforeRename = null;
  atomicWriteHooks.rename = (a, b) => renameSync(a, b);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const mgr = (dir: string) => new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100 }));

/** 遠征を 1 つ終えてキャンプにいるラン（meta.json・summary.json・tokens.json・キーフレームがある）。記録を書くのは、ふつうの命令だけ */
async function campRun(dir: string, seed = 's3c-meta-1') {
  const m = mgr(dir);
  const r = await m.createRun({ name: 'Kashiwa', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  for (let i = 0; i < 3; i++) await act(r.port, { type: 'wait' });
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r.port, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
  const runId = r.session.runId;
  const seq = r.session.world.seq;
  m.closeAll();
  return { runId, token: r.token, seq, runDir: join(dir, runId) };
}

function restart(dir: string) {
  const logs: string[] = [];
  const m = mgr(dir);
  m.recoverAll((s) => logs.push(s));
  return { m, logs };
}
const metaOf = (runDir: string) => JSON.parse(readFileSync(join(runDir, 'meta.json'), 'utf8')) as RunMetaFile;
const sameMeta = (a: RunMetaFile, b: RunMetaFile) => expect({ ...a, lastSeq: 0 }).toEqual({ ...b, lastSeq: 0 });

describe('S3c §33.1: a broken meta.json is rebuilt from the other records', () => {
  for (const shape of ['zero bytes', 'cut halfway', 'deleted', 'wrong shape'] as const) {
    it(`meta.json ${shape}: rebuilt, recovered with the same token, the broken one kept`, async () => {
      const dir = tmp();
      const run = await campRun(dir);
      const metaPath = join(run.runDir, 'meta.json');
      const before = metaOf(run.runDir);
      const raw = readFileSync(metaPath);
      if (shape === 'zero bytes') writeFileSync(metaPath, Buffer.alloc(raw.length));
      else if (shape === 'cut halfway') writeFileSync(metaPath, raw.subarray(0, raw.length >> 1));
      else if (shape === 'deleted') unlinkSync(metaPath);
      else writeFileSync(metaPath, JSON.stringify({ hello: 1 }));
      const { m, logs } = restart(dir);
      expect(logs.some((l) => l.startsWith(`rebuilt meta.json of ${run.runId}`))).toBe(true);
      expect(logs.some((l) => l.startsWith(`recovered ${run.runId}`) && l.includes('hash ok'))).toBe(true);
      const s = m.get(run.runId)!;
      expect(s).toBeTruthy();
      expect(s.world.seq).toBe(run.seq);
      sameMeta(metaOf(run.runDir), before);
      expect(metaOf(run.runDir).lastSeq).toBe(run.seq);
      expect(existsSync(`${metaPath}.broken`)).toBe(shape !== 'deleted');
      if (shape === 'zero bytes') expect([...readFileSync(`${metaPath}.broken`)].every((b) => b === 0)).toBe(true);
      // 同じトークンで再開して、続けられる
      const port = m.portForToken(run.token)!;
      expect(port).toBeTruthy();
      expect(port.view().status).toBe('at_camp');
      expect(m.listRuns().find((x) => x.runId === run.runId)?.recoveryFailed).toBeUndefined();
      m.closeAll();
    });
  }

  it('an ended run with a broken meta.json is rebuilt too (it stays on the run list and the leaderboard)', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    { const { m } = restart(dir); await act(m.portForToken(run.token)!, { type: 'retire' }); m.closeAll(); }
    const before = metaOf(run.runDir);
    expect(before.status).toBe('ended');
    writeFileSync(join(run.runDir, 'meta.json'), Buffer.alloc(300));
    const { m, logs } = restart(dir);
    expect(logs.some((l) => l.startsWith(`rebuilt meta.json of ${run.runId}`))).toBe(true);
    expect(metaOf(run.runDir)).toEqual(before);
    expect(m.listRuns().find((x) => x.runId === run.runId)?.status).toBe('ended');
    expect(m.store!.leaderboard().some((x) => x.runId === run.runId)).toBe(true);
    m.closeAll();
  });

  it('without readable keyframes, meta.json is rebuilt from the event log alone', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    const before = metaOf(run.runDir);
    writeFileSync(join(run.runDir, 'meta.json'), Buffer.alloc(100));
    const kd = join(run.runDir, 'keyframes');
    for (const f of readdirSync(kd)) writeFileSync(join(kd, f), Buffer.alloc(50));
    const { m, logs } = restart(dir);
    expect(logs.some((l) => l.includes('from the event log'))).toBe(true);
    sameMeta(metaOf(run.runDir), before);
    const rec = logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
    expect(rec).toContain('hash ok');
    expect(rec).toContain('出来事の記録だけから作った');
    expect(m.get(run.runId)!.world.seq).toBe(run.seq);
    // 新しいキーフレームを書き直した（次の起動はそれを使う）
    expect(readdirSync(kd).some((f) => /^\d+\.json$/.test(f) && JSON.parse(readFileSync(join(kd, f), 'utf8')).seq === run.seq)).toBe(true);
    m.closeAll();
  });

  it('when it cannot be rebuilt (no event log), the run is listed as a recovery failure and the token gets recovery_failed', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    writeFileSync(join(run.runDir, 'meta.json'), Buffer.alloc(100));
    unlinkSync(join(run.runDir, 'events.jsonl'));
    const { m, logs } = restart(dir);
    expect(logs.some((l) => l.startsWith(`failed to recover ${run.runId}: meta.json が読めず`))).toBe(true);
    const row = m.listRuns().find((x) => x.runId === run.runId)!;
    expect(row.recoveryFailed?.reason).toContain('meta.json が読めず');
    expect(row.live).toBe(false);
    expect(m.recoveryFailedForToken(run.token)?.code).toBe('recovery_failed');
    m.closeAll();
  });
});

describe('S3c §33.1: other files', () => {
  it('a broken tokens.json cannot be rebuilt: the run is a recovery failure with the reason', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    writeFileSync(join(run.runDir, 'tokens.json'), Buffer.alloc(42));
    const { m } = restart(dir);
    expect(m.get(run.runId)).toBeUndefined();
    expect(m.listRuns().find((x) => x.runId === run.runId)!.recoveryFailed!.reason).toContain('tokens.json が読めない');
    m.closeAll();
    rmSync(join(run.runDir, 'tokens.json'));
    const r2 = restart(dir);
    expect(r2.m.listRuns().find((x) => x.runId === run.runId)!.recoveryFailed!.reason).toContain('tokens.json が無い');
    r2.m.closeAll();
  });

  it('a broken summary.json is rebuilt from the last summary in the event log', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    const p = join(run.runDir, 'summary.json');
    const before = JSON.parse(readFileSync(p, 'utf8'));
    writeFileSync(p, Buffer.alloc(200));
    const { m, logs } = restart(dir);
    expect(logs.some((l) => l.startsWith(`rebuilt summary.json/.md of ${run.runId}`))).toBe(true);
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual(before);
    expect(existsSync(`${p}.broken`)).toBe(true);
    expect(readFileSync(join(run.runDir, 'summary.md'), 'utf8')).toContain('Kashiwa');
    m.closeAll();
  });

  it('a broken latest keyframe is set aside and the one before is used (hash ok)', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    const kd = join(run.runDir, 'keyframes');
    const seqs = readdirSync(kd).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
    expect(seqs.length).toBeGreaterThan(1);
    writeFileSync(join(kd, `${seqs.at(-1)}.json`), '{"seq":');
    const { m, logs } = restart(dir);
    const rec = logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
    expect(rec).toContain('hash ok');
    expect(rec).toContain('読めないキーフレーム 1 個');
    expect(existsSync(join(kd, `${seqs.at(-1)}.json.broken`))).toBe(true);
    expect(m.get(run.runId)!.world.seq).toBe(run.seq);
    m.closeAll();
  });

  it('a torn tail of events.jsonl (zero bytes after a crash) is cut, so the next record is not glued onto it', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    const ep = join(run.runDir, 'events.jsonl');
    writeFileSync(ep, Buffer.concat([readFileSync(ep), Buffer.alloc(77)]));
    const { m, logs } = restart(dir);
    expect(logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('events.jsonl の最後の欠けた行（77 バイト）を切った');
    const offer = m.get(run.runId)!.world.camp!.offers[0].index;
    expect((await act(m.portForToken(run.token)!, { type: 'start_expedition', offer })).ok).toBe(true);
    const seq = m.get(run.runId)!.world.seq;
    m.closeAll();
    // 追記した出来事が読める（欠けた行とつながっていない）
    const lines = readFileSync(ep, 'utf8').split('\n').filter(Boolean);
    expect(JSON.parse(lines.at(-1)!).seq).toBe(seq);
    const r2 = restart(dir);
    expect(r2.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('hash ok');
    r2.m.closeAll();
  });
});

describe('S3c §33.1: writes', () => {
  it('a crash after writing the temp file but before the rename leaves the previous meta.json whole', async () => {
    const dir = tmp();
    const run = await campRun(dir);
    const before = readFileSync(join(run.runDir, 'meta.json'), 'utf8');
    const { m } = restart(dir);
    // 次の遠征を始めて、撤退の手前で meta.json を書くときに落ちる（名前を替える前）
    atomicWriteHooks.beforeRename = (_tmp, path) => { if (path.endsWith('meta.json')) throw new Error('crash before rename'); };
    const port = m.portForToken(run.token)!;
    const offer = m.get(run.runId)!.world.camp!.offers[0].index;
    expect((await act(port, { type: 'start_expedition', offer })).ok).toBe(true);
    const life = port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
    await act(port, { type: 'use', slot: life.slot });
    for (let i = 0; i < 20 && port.view().status !== 'at_camp'; i++) await act(port, { type: 'wait' });
    expect(port.view().status).toBe('at_camp');
    atomicWriteHooks.beforeRename = null;
    // 前の中身のまま（読める）。一時のファイルは書き切ってある
    expect(readFileSync(join(run.runDir, 'meta.json'), 'utf8')).toBe(before);
    const tmps = readdirSync(run.runDir).filter((f) => f.startsWith('meta.json.') && f.endsWith('.tmp'));
    expect(tmps.length).toBeGreaterThan(0);
    for (const f of tmps) expect(JSON.parse(readFileSync(join(run.runDir, f), 'utf8')).runId).toBe(run.runId);
    const seq = m.get(run.runId)!.world.seq;
    m.closeAll();
    const r2 = restart(dir);
    expect(r2.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('hash ok');
    expect(r2.m.get(run.runId)!.world.seq).toBe(seq);
    r2.m.closeAll();
  });

  it('a rename refused while the target is open (Windows) is tried again; if it never goes, the old content stays and nothing throws', () => {
    const dir = tmp();
    const p = join(dir, 'x.json');
    writeFileAtomic(p, 'old');
    let refused = 0;
    atomicWriteHooks.rename = (a, b) => { if (refused++ < 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); renameSync(a, b); };
    writeFileAtomic(p, 'new');
    expect(refused).toBe(3);
    expect(readFileSync(p, 'utf8')).toBe('new');
    atomicWriteHooks.rename = () => { throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }); };
    expect(() => writeFileAtomic(p, 'newer')).toThrow(/EBUSY/);
    expect(readFileSync(p, 'utf8')).toBe('new');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('S3c §33.1: season and profile files', () => {
  const SID = 's3ct';
  it('a broken participants.json: the season is not loaded nor written back, its run is a recovery failure (reason hidden), new runs are refused', async () => {
    const dir = tmp();
    const m = mgr(dir);
    m.seasons.store.open({ id: SID, name: 'S3c', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite(SID, 'Aya', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const r = await m.createRun({ name: 'Aya', controller: agent, season: SID, profileToken: inv.token! });
    if ('error' in r) throw new Error(r.error.message);
    const runId = r.session.runId;
    m.closeAll();
    const pp = join(dir, 'seasons', SID, 'participants.json');
    writeFileSync(pp, Buffer.alloc(64));
    const { m: m2, logs } = restart(dir);
    expect(logs.some((l) => l.startsWith(`シーズン ${SID} の記録が読めない（participants.json）`))).toBe(true);
    expect(m2.get(runId)).toBeUndefined();
    const row = m2.listRuns().find((x) => x.runId === runId)!;
    expect(row.recoveryFailed).toBeTruthy();
    expect(row.recoveryFailed!.reason).not.toContain('participants');
    expect(m2.seasons.canStart(SID, inv.profileId)).toEqual({ reason: expect.stringContaining('記録が読めない') });
    expect(() => m2.seasons.store.open({ id: SID, name: 'x', seed: 'y', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 1, endsAt: Date.now() + 1000, openedAt: Date.now() })).toThrow(/already exists/);
    m2.closeAll();
    // 書き戻していない
    expect([...readFileSync(pp)].every((b) => b === 0)).toBe(true);
  });

  it('a broken invites.json: nobody can start, and the operator tool refuses to add (it would drop the other invites)', () => {
    const dir = tmp();
    const m = mgr(dir);
    m.seasons.store.open({ id: SID, name: 'S3c', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite(SID, 'Aya', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const ip = join(dir, 'seasons', SID, 'invites.json');
    writeFileSync(ip, '[{"profileId":');
    expect(m.seasons.canStart(SID, inv.profileId)).toEqual({ reason: expect.stringContaining('invites.json') });
    expect(m.seasons.invite(SID, 'Ben', m.profiles.store)).toEqual({ error: expect.stringContaining('invites.json') });
    expect(readFileSync(ip, 'utf8')).toBe('[{"profileId":');
    m.closeAll();
  });

  it('a broken profile file is reported at start and never overwritten', async () => {
    const dir = tmp();
    await campRun(dir);
    const pd = join(dir, 'profiles');
    const f = readdirSync(pd).find((x) => /^prof_[0-9a-f]+\.json$/.test(x))!;
    writeFileSync(join(pd, f), Buffer.alloc(30));
    const { m, logs } = restart(dir);
    expect(logs.some((l) => l.startsWith(`プロフィールのファイル ${f} が読めない`))).toBe(true);
    m.closeAll();
    expect([...readFileSync(join(pd, f))].every((b) => b === 0)).toBe(true);
  });
});


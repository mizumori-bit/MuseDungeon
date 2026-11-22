// S3e（SEASON.md §38）のテスト: 復旧は、再生が記録と一致したときにだけ記録を直す（§38.1）。食い違ったときは、記録のファイルに何も書かない
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { atomicWriteHooks, dropPendingWrites, loadConfig, pendingWrites, SessionManager, writeFileAtomicLogged } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import type { Command } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'muse-s3e-')); dirs.push(d); return d; };
afterEach(() => {
  atomicWriteHooks.beforeRename = null;
  atomicWriteHooks.rename = (a, b) => renameSync(a, b);
  atomicWriteHooks.read = (p) => readFileSync(p, 'utf8');
  dropPendingWrites();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mgr = (dir: string) => new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100, keyframeEvery: 40 }));
const restart = (dir: string) => { const m = mgr(dir); const logs: string[] = []; m.recoverAll((s) => logs.push(s)); return { m, logs }; };

/** フォルダの中のファイルの中身の指紋（1 バイトでも変われば違う） */
function snap(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) visit(p);
      else out.set(relative(root, p).replace(/\\/g, '/'), createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  visit(root);
  return out;
}
const same = (a: Map<string, string>, b: Map<string, string>) => expect([...b].sort()).toEqual([...a].sort());

/** ふつうのラン: シーズンの取り込み・マクロ（探索・移動・休憩）・遠征の終わりを含む、キーフレームが何枚もあるラン */
async function playedSeasonRun(dir: string) {
  const m = mgr(dir);
  m.seasons.store.open({ id: 's3et', name: 'S3e', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
  const inv = m.seasons.invite('s3et', 'Aya', m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name: 'Aya', controller: agent, season: 's3et', profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  const offer = r.session.world.camp!.offers[0].index;
  expect((await act(r.port, { type: 'start_expedition', offer })).ok).toBe(true);
  for (let i = 0; i < 12 && r.port.view().status === 'your_turn'; i++) {
    await act(r.port, { type: 'explore' });
    await act(r.port, { type: 'rest' });
    await act(r.port, { type: 'wait' });
  }
  const runId = r.session.runId;
  const token = r.token;
  m.closeAll();
  return { runId, token, rd: join(dir, runId) };
}

describe('S3e §38.1: recovery writes nothing unless the replay matches the records', () => {
  it('a sound run (macros, season syncs, several keyframes) is recovered twice without changing one byte in its folder', async () => {
    const dir = tmp();
    const run = await playedSeasonRun(dir);
    expect(readdirSync(join(run.rd, 'keyframes')).length).toBeGreaterThan(2);
    const before = snap(run.rd);
    for (let k = 0; k < 2; k++) {
      const a = restart(dir);
      expect(a.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('hash ok');
      a.m.closeAll();
      same(before, snap(run.rd));
    }
    // 新しいキーフレームを消して長い再実行にしても（一致すれば）、記録は変わらない（キーフレームは書き直さない）
    const kd = join(run.rd, 'keyframes');
    const kfs = readdirSync(kd).map((f) => parseInt(f, 10)).sort((x, y) => x - y);
    for (const s of kfs.slice(-2)) rmSync(join(kd, `${s}.json`));
    const cut = snap(run.rd);
    const a = restart(dir);
    expect(a.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('hash ok');
    a.m.closeAll();
    same(cut, snap(run.rd));
  });

  it('a run whose replay does not match (as when the version changed mid-floor) keeps every file as it was, run after run: nothing added, cut, set aside or rewritten', async () => {
    const dir = tmp();
    const run = await playedSeasonRun(dir);
    const kd = join(run.rd, 'keyframes');
    const kfs = readdirSync(kd).map((f) => parseInt(f, 10)).sort((x, y) => x - y);
    // 階の途中で版が変わった形: 新しいキーフレームを消し、その後の命令の 1 つを抜く（再生が記録と食い違う）
    for (const s of kfs.slice(-2)) rmSync(join(kd, `${s}.json`));
    const keep = kfs.at(-3)!;
    const kfc = JSON.parse(readFileSync(join(kd, `${keep}.json`), 'utf8')).cseq as number;
    const cp = join(run.rd, 'commands.jsonl');
    const cmds = readFileSync(cp, 'utf8').split('\n').filter(Boolean);
    const at = cmds.findIndex((l) => { const c = JSON.parse(l); return c.cseq > kfc + 2 && c.resultSeq && c.command.type === 'wait'; });
    expect(at).toBeGreaterThan(0);
    cmds.splice(at, 1);
    writeFileSync(cp, cmds.join('\n') + '\n');
    // 命令の記録が覆っていない出来事と、欠けた最後の行もある
    const ep = join(run.rd, 'events.jsonl');
    const evs = readFileSync(ep, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(evs.at(-1)!);
    appendFileSync(ep, JSON.stringify({ ...last, seq: last.seq + 1 }) + '\n' + '{"seq":');
    const before = snap(dir);
    for (let k = 0; k < 2; k++) {
      const a = restart(dir);
      const rec = a.logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
      expect(rec).toContain('with mismatch');
      expect(rec).toContain('記録のファイルは直していない');
      expect(a.logs.some((l) => l.includes('再生が記録と食い違ったので'))).toBe(true);
      expect(a.m.get(run.runId)).toBeTruthy();
      a.m.closeAll();
      same(before, snap(dir));
    }
  });

  it('the newest usable keyframe locked for the moment is a recovery failure (no fall back to an older one)', async () => {
    const dir = tmp();
    const run = await playedSeasonRun(dir);
    const kd = join(run.rd, 'keyframes');
    const newest = readdirSync(kd).map((f) => parseInt(f, 10)).sort((x, y) => y - x)[0];
    const before = snap(run.rd);
    atomicWriteHooks.read = (p) => { if (p.endsWith(join('keyframes', `${newest}.json`))) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return readFileSync(p, 'utf8'); };
    const a = restart(dir);
    expect(a.m.get(run.runId)).toBeUndefined();
    expect(a.logs.find((l) => l.startsWith(`failed to recover ${run.runId}`))).toContain('一時的に読めない');
    a.m.closeAll();
    same(before, snap(run.rd));
    atomicWriteHooks.read = (p) => readFileSync(p, 'utf8');
    const b = restart(dir);
    expect(b.m.get(run.runId)).toBeTruthy();
    b.m.closeAll();
  });
});

describe('S3e §38.2 の 3: retrying failed writes', () => {
  it('season files are not remembered for a later write (the next save writes the new content)', () => {
    const dir = tmp();
    const m = mgr(dir);
    m.seasons.store.open({ id: 's3eu', name: 'S3e', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const d = m.seasons.get('s3eu')!;
    atomicWriteHooks.rename = (a, b) => { if (b.endsWith('participants.json')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); renameSync(a, b); };
    m.seasons.store.saveParticipants(d);
    expect(pendingWrites()).toBe(0);
    m.closeAll();
  });

  it('a run file that keeps failing is retried at most once per interval, not on every write', () => {
    const dir = tmp();
    const bad = join(dir, 'a.json');
    let tries = 0;
    atomicWriteHooks.rename = (a, b) => { if (b === bad) { tries++; throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } renameSync(a, b); };
    expect(writeFileAtomicLogged(bad, '1', { remember: true, warn: () => undefined })).toBe(false);
    const first = tries;
    expect(pendingWrites()).toBe(1);
    for (let i = 0; i < 5; i++) expect(writeFileAtomicLogged(join(dir, `b${i}.json`), 'x', { remember: true, warn: () => undefined })).toBe(true);
    // 間隔の下限の内は、やり直さない（どの書き込みも遅くならない）
    expect(tries).toBe(first);
    expect(pendingWrites()).toBe(1);
  });
});

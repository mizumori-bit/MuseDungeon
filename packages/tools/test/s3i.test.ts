// S3i（SEASON.md §46.2。S3h の検査の指摘）のテスト: 断られる参加では何も書かない・境目のキーフレームが読めなければ復旧しない・
// foldBase は前の境目へ下がらない・終わったランの HTTP の出来事は覆う範囲だけ。原則（§38.1）: 食い違ったときは何も書かない
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import type { Command } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'muse-s3i-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const mgr = (dir: string) => new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100, keyframeEvery: 40 }));
const restart = (dir: string) => { const m = mgr(dir); const logs: string[] = []; m.recoverAll((s) => logs.push(s)); return { m, logs }; };
const recLine = (logs: string[], runId: string) => logs.find((l) => l.startsWith(`recovered ${runId}`) || l.startsWith(`failed to recover ${runId}`)) ?? '';
type Line = { seq: number; cseq: number; type?: string; resultSeq?: [number, number] | null; command?: { type: string } };
const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
const writeLines = (p: string, xs: unknown[]) => writeFileSync(p, xs.map((x) => JSON.stringify(x)).join('\n') + '\n');

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

async function waitedRun(dir: string, seed: string, waits: number) {
  const m = mgr(dir);
  const r = await m.createRun({ name: 'Rev', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  for (let i = 0; i < waits; i++) await act(r.port, { type: 'wait' });
  const out = { runId: r.session.runId, token: r.token, playerId: r.playerId, rd: join(dir, r.session.runId) };
  m.closeAll();
  return out;
}
type Run = Awaited<ReturnType<typeof waitedRun>>;

/** 食い違い（届かない形: 前の版が最後の命令について 1 つ多く出していた）を作る。最後の命令より後のキーフレームを消す */
function mismatchShort(run: Run): void {
  const cp = join(run.rd, 'commands.jsonl'), ep = join(run.rd, 'events.jsonl');
  const cmds = lines(cp);
  const at = cmds.map((c) => !!c.resultSeq).lastIndexOf(true);
  const [a, b] = cmds[at].resultSeq!;
  for (const f of readdirSync(join(run.rd, 'keyframes'))) if (parseInt(f, 10) >= a) rmSync(join(run.rd, 'keyframes', f));
  const evs = lines(ep) as unknown as Record<string, unknown>[];
  const lastEv = evs.at(-1)!;
  appendFileSync(ep, JSON.stringify({ type: 'noise', pos: { x: 0, y: 0 }, loudness: 0, source: null, seenBy: [], floor: lastEv.floor, ft: lastEv.ft, seq: b + 1, cause: lastEv.cause, wall: lastEv.wall }) + '\n');
  cmds[at].resultSeq = [a, b + 1];
  writeLines(cp, cmds);
}

/** 食い違ったランを続けて、境目（seq_resume とそのキーフレーム）を残す。境目の番号 */
async function withBoundary(dir: string, run: Run): Promise<number> {
  mismatchShort(run);
  const r = restart(dir);
  for (let i = 0; i < 3; i++) await act(r.m.portForToken(run.token)!, { type: 'wait' });
  const b = r.m.get(run.runId)!.boundaries()[0];
  r.m.closeAll();
  expect(b).toBeGreaterThan(0);
  return b;
}

describe('S3i §46.2 の 1: a refused join writes nothing', () => {
  it('a join refused by a mismatched solo run leaves every file as it was (no boundary, no keyframe, no profile)', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3i-join', 6);
    mismatchShort(run);
    const before = snap(dir);
    const r = restart(dir);
    expect(recLine(r.logs, run.runId)).toContain('with mismatch');
    const s = r.m.get(run.runId)!;
    const pending = s.seqResumePending();
    expect(pending).not.toBeNull();
    // プロフィールのトークン無し（新しいプロフィールを作る形）と、HTTP の口の両方で
    const j = await r.m.joinRun(run.runId, { name: 'Two', controller: agent });
    expect('error' in j ? j.error.code : 'ok').toBe('bad_request');
    const app = createApp(r.m, r.m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    try {
      const port = (app.server.address() as AddressInfo).port;
      const h = await fetch(`http://127.0.0.1:${port}/api/runs/${run.runId}/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Three' }) });
      expect(h.status).toBe(400);
    } finally {
      await app.close();
    }
    expect(s.seqResumePending()).toBe(pending);
    expect(s.boundaries()).toEqual([]);
    r.m.closeAll();
    same(before, snap(dir));
  });
});

describe('S3i §46.2 の 2: a boundary keyframe that cannot be read stops the recovery (nothing is written)', () => {
  it('all keyframes broken: the run is shown as failed to recover, not rebuilt across the boundary from the events', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3i-kf-all', 6);
    const b = await withBoundary(dir, run);
    for (const f of readdirSync(join(run.rd, 'keyframes'))) writeFileSync(join(run.rd, 'keyframes', f), '{ broken');
    const before = snap(dir);
    const r = restart(dir);
    expect(recLine(r.logs, run.runId)).toContain(`境目のキーフレーム（keyframes/${b}.json）が読めない`);
    expect(r.m.get(run.runId)).toBeUndefined();
    expect(r.m.recoveryFailedError(run.runId)?.code).toBe('recovery_failed');
    r.m.closeAll();
    same(before, snap(dir));
  });

  it('only the boundary keyframe gone (older ones readable): re-executed from the old keyframe as before (a mismatch, nothing written); with meta.json gone too: not rebuilt across the boundary (failed, nothing written)', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3i-kf-one', 6);
    const b = await withBoundary(dir, run);
    for (const f of readdirSync(join(run.rd, 'keyframes'))) if (parseInt(f, 10) >= b) rmSync(join(run.rd, 'keyframes', f));
    expect(readdirSync(join(run.rd, 'keyframes')).length).toBeGreaterThan(0);
    const before = snap(dir);
    const r = restart(dir);
    // 古いキーフレームから命令を再実行して照合する（S3f の形のまま）。食い違うので何も書かない
    expect(recLine(r.logs, run.runId)).toContain('with mismatch');
    r.m.closeAll();
    same(before, snap(dir));
    // meta.json も無い: 作り直さない（出来事を古いキーフレームに畳むと、境目をまたぐ）
    rmSync(join(run.rd, 'meta.json'));
    const before2 = snap(dir);
    const r2 = restart(dir);
    expect(recLine(r2.logs, run.runId)).toContain('境目のキーフレーム');
    r2.m.closeAll();
    same(before2, snap(dir));
  });
});

describe('S3i §46.2 の 3: foldBase never falls back to an older boundary', () => {
  it('the newest boundary keyframe unreadable: folds from the empty world (as before), not from an older boundary', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3i-fold', 6);
    const b = await withBoundary(dir, run);
    const r = restart(dir);
    expect(recLine(r.logs, run.runId)).toContain('hash ok');
    const s = r.m.get(run.runId)!;
    expect(s.foldBase(s.world.seq).from).toBe(b);
    // 古い境目があったことにする（読めるキーフレームの番号）。新しい境目のキーフレームを消す
    const older = readdirSync(join(run.rd, 'keyframes')).map((f) => parseInt(f, 10)).filter((x) => x < b).sort((x, y) => x - y)[0];
    (s as unknown as { boundarySeqs: number[]; boundaryCache: unknown }).boundarySeqs.unshift(older);
    (s as unknown as { boundaryCache: unknown }).boundaryCache = null;
    rmSync(join(run.rd, 'keyframes', `${b}.json`));
    expect(s.foldBase(s.world.seq).from).toBe(0);
    // 古い境目だけが範囲に入るときは、それを使う
    expect(s.foldBase(b - 1).from).toBe(older);
    r.m.closeAll();
  });
});

describe('S3i §46.2 の 5: the HTTP events of a finished run are only those the command log covers', () => {
  it('an event no command covers (in the middle) is not served to the replay screen', async () => {
    const dir = tmp();
    const m0 = mgr(dir);
    const r0 = await m0.createRun({ name: 'Rev', seed: 's3i-http', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r0) throw new Error(r0.error.message);
    for (let i = 0; i < 4; i++) await act(r0.port, { type: 'wait' });
    expect((await act(r0.port, { type: 'retire' })).ok).toBe(true);
    const rd = join(dir, r0.session.runId);
    m0.closeAll();
    // 途中の命令の結果の区間を 1 つ縮めて、その最後の出来事を覆われない出来事にする
    const cp = join(rd, 'commands.jsonl');
    const cmds = lines(cp);
    const at = cmds.findIndex((c, i) => i < cmds.length - 2 && c.command?.type === 'wait' && !!c.resultSeq && c.resultSeq[1] > c.resultSeq[0]);
    const gap = cmds[at].resultSeq![1];
    cmds[at].resultSeq = [cmds[at].resultSeq![0], gap - 1];
    writeLines(cp, cmds);
    const m = mgr(dir);
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const text = await (await fetch(`${base}/api/runs/${r0.session.runId}/events`)).text();
      const seqs = text.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { seq: number }).seq);
      expect(seqs).not.toContain(gap);
      expect(seqs).toContain(gap - 1);
      expect(seqs).toContain(gap + 1);
    } finally {
      await app.close();
      m.closeAll();
    }
  });
});

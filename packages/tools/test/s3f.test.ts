// S3f（SEASON.md §40.2）のテスト: 照合の穴（再生が記録より先まで進む）・食い違ったランの続きの番号・replay:verify の読み方・
// サーバーの印の取り合い・起動の前のポートの確かめ
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { acquireLock, atomicWriteHooks, dropPendingWrites, loadConfig, portInUse, RUNS_LOCK, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import type { Command } from '@muse/shared';
import { verifyRunDir } from '../src/replay';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'muse-s3f-')); dirs.push(d); return d; };
afterEach(() => {
  atomicWriteHooks.beforeRename = null;
  atomicWriteHooks.rename = (a, b) => renameSync(a, b);
  atomicWriteHooks.read = (p) => readFileSync(p, 'utf8');
  dropPendingWrites();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mgr = (dir: string) => new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100, keyframeEvery: 40 }));
const restart = (dir: string) => { const m = mgr(dir); const logs: string[] = []; m.recoverAll((s) => logs.push(s)); return { m, logs }; };
type Line = { seq: number; cseq: number; type?: string; fromSeq?: number; resultSeq?: [number, number] | null; command?: { type: string; next?: number }; player?: string | null; source?: string };
const lines = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
const writeLines = (p: string, xs: unknown[]) => writeFileSync(p, xs.map((x) => JSON.stringify(x)).join('\n') + '\n');
/** 出来事の番号が、同じものが無く、増えていく順か */
const strictlyIncreasing = (p: string) => { const s = lines(p).map((e) => e.seq); return s.every((v, i) => i === 0 || v > s[i - 1]); };

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

/** 遠征の途中で待つだけのラン（最後の命令は wait。出来事が 2 つ以上ある） */
async function waitedRun(dir: string, seed: string, waits: number) {
  const m = mgr(dir);
  const r = await m.createRun({ name: 'Rev', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  for (let i = 0; i < waits; i++) await act(r.port, { type: 'wait' });
  const out = { runId: r.session.runId, token: r.token, rd: join(dir, r.session.runId) };
  m.closeAll();
  return out;
}

/** 最後の命令（結果のあるもの）の記録と、その命令より後ろが再生されるように、それ以後のキーフレームを消す */
function lastCommandReplayed(rd: string) {
  const cp = join(rd, 'commands.jsonl');
  const cmds = lines(cp);
  const at = cmds.map((c) => !!c.resultSeq).lastIndexOf(true);
  const [a, b] = cmds[at].resultSeq!;
  expect(b).toBeGreaterThan(a);
  const kd = join(rd, 'keyframes');
  for (const f of readdirSync(kd)) if (parseInt(f, 10) >= a) rmSync(join(kd, f));
  return { cp, cmds, at, a, b, ep: join(rd, 'events.jsonl') };
}

describe('S3f §40.2 の 1: the replay running past the records is a mismatch', () => {
  it('when the current engine emits one more event for the last command than the log has, recovery says mismatch and changes nothing', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3f-past', 6);
    const { cp, cmds, at, a, b, ep } = lastCommandReplayed(run.rd);
    // 前の版の engine が、最後の命令について 1 つ少なく出していた形（今の engine は 1 つ多く出す）
    writeLines(ep, lines(ep).filter((e) => e.seq !== b));
    cmds[at].resultSeq = [a, b - 1];
    writeLines(cp, cmds);
    const before = snap(dir);
    for (let k = 0; k < 2; k++) {
      const r = restart(dir);
      const rec = r.logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
      expect(rec).toContain('with mismatch');
      expect(rec).toContain('再生が記録より先まで進んだ');
      expect(r.logs.some((l) => l.includes('再生が記録と食い違ったので'))).toBe(true);
      // 再生は記録より先にいるので、番号を送らなくても重ならない
      expect(r.m.get(run.runId)!.world.seq).toBe(b);
      expect(r.m.get(run.runId)!.seqResumePending()).toBeNull();
      r.m.closeAll();
      same(before, snap(dir));
    }
    // 続けても、番号は重ならない
    const r = restart(dir);
    await act(r.m.portForToken(run.token)!, { type: 'wait' });
    r.m.closeAll();
    expect(strictlyIncreasing(ep)).toBe(true);
    expect(lines(ep).some((e) => e.type === 'seq_resumed')).toBe(false);
  });
});

describe('S3f §40.2 の 2: continuing a run whose replay did not match', () => {
  it('when the old engine emitted one more event for the last command (a version change), the continuation numbers events after the log, records seq_resume, and the next restart matches', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3f-more', 6);
    const { cp, cmds, at, a, b, ep } = lastCommandReplayed(run.rd);
    // 前の版の engine が、最後の命令について 1 つ多く出していた形（状態を変えない出来事）
    const evs = lines(ep);
    const lastEv = evs.at(-1)! as unknown as Record<string, unknown>;
    appendFileSync(ep, JSON.stringify({ type: 'noise', pos: { x: 0, y: 0 }, loudness: 0, source: null, seenBy: [], floor: lastEv.floor, ft: lastEv.ft, seq: b + 1, cause: lastEv.cause, wall: lastEv.wall }) + '\n');
    cmds[at].resultSeq = [a, b + 1];
    writeLines(cp, cmds);
    const before = snap(dir);
    const r1 = restart(dir);
    const rec = r1.logs.find((l) => l.startsWith(`recovered ${run.runId}`))!;
    expect(rec).toContain('with mismatch');
    expect(rec).toContain('届かなかった');
    expect(rec).toContain(`${b + 2} から振る`);
    const s1 = r1.m.get(run.runId)!;
    expect(s1.world.seq).toBe(b);
    expect(s1.seqResumePending()).toBe(b + 2);
    // 読むだけなら、何も書かない（§38.1）
    r1.m.portForToken(run.token)!.view();
    r1.m.closeAll();
    same(before, snap(dir));
    // 続ける: 最初に記録へ書く前に、番号を送る
    const r2 = restart(dir);
    const port = r2.m.portForToken(run.token)!;
    expect((await act(port, { type: 'wait' })).ok).toBe(true);
    await act(port, { type: 'wait' });
    const s2 = r2.m.get(run.runId)!;
    expect(s2.seqResumePending()).toBeNull();
    const seqAfter = s2.world.seq;
    r2.m.closeAll();
    expect(strictlyIncreasing(ep)).toBe(true);
    const resumed = lines(ep).filter((e) => e.type === 'seq_resumed');
    expect(resumed.map((e) => [e.seq, e.fromSeq])).toEqual([[b + 2, b]]);
    const sys = lines(cp).filter((c) => c.command?.type === 'seq_resume');
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ player: null, source: 'system', command: { type: 'seq_resume', next: b + 2 }, resultSeq: [b + 2, b + 2] });
    // 命令の番号も重ならない
    const cs = lines(cp).map((c) => c.cseq);
    expect(cs.every((v, i) => i === 0 || v > cs[i - 1])).toBe(true);
    // 送った直後のキーフレーム
    expect(existsSync(join(run.rd, 'keyframes', `${b + 2}.json`))).toBe(true);
    // 次の起動は、送った所のキーフレームから再生するので一致し、同じ所にいる
    const r3 = restart(dir);
    expect(r3.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('hash ok');
    expect(r3.m.get(run.runId)!.world.seq).toBe(seqAfter);
    await act(r3.m.portForToken(run.token)!, { type: 'wait' });
    r3.m.closeAll();
    expect(strictlyIncreasing(ep)).toBe(true);
  });

  it('the same holds when the replay diverges mid-floor (newer keyframes gone, one command missing) and the run goes on with a macro; replaying from the old keyframe gives the same numbers', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3f-mid', 14);
    const kd = join(run.rd, 'keyframes');
    const kfs = readdirSync(kd).map((f) => parseInt(f, 10)).sort((x, y) => x - y);
    expect(kfs.length).toBeGreaterThan(1);
    for (const s of kfs.slice(1)) rmSync(join(kd, `${s}.json`));
    const kfc = JSON.parse(readFileSync(join(kd, `${kfs[0]}.json`), 'utf8')).cseq as number;
    const cp = join(run.rd, 'commands.jsonl');
    const cmds = lines(cp);
    const drop = cmds.findIndex((c) => c.cseq > kfc + 1 && !!c.resultSeq && c.command?.type === 'wait');
    expect(drop).toBeGreaterThan(0);
    cmds.splice(drop, 1);
    writeLines(cp, cmds);
    const ep = join(run.rd, 'events.jsonl');
    const lastLogged = lines(ep).at(-1)!.seq;
    const r1 = restart(dir);
    expect(r1.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('with mismatch');
    const s1 = r1.m.get(run.runId)!;
    expect(s1.world.seq).toBeLessThan(lastLogged);
    const next = s1.seqResumePending()!;
    expect(next).toBe(lastLogged + 1);
    // マクロで続ける（呼び出しの記録より前に送る）
    expect((await act(r1.m.portForToken(run.token)!, { type: 'wait', turns: 3 })).ok).toBe(true);
    const seqAfter = s1.world.seq;
    r1.m.closeAll();
    expect(strictlyIncreasing(ep)).toBe(true);
    expect(lines(ep).filter((e) => e.type === 'seq_resumed').map((e) => e.seq)).toEqual([next]);
    const all = lines(cp) as (Line & { macro?: boolean })[];
    const i = all.findIndex((c) => c.command?.type === 'seq_resume');
    expect(all[i + 1]).toMatchObject({ macro: true, command: { type: 'wait' } });
    // 送った所のキーフレームを消して、古いキーフレームから再生しても（版をまたいだ部分は食い違うが）、送った番号は同じで、続きと重ならない
    rmSync(join(kd, `${next}.json`));
    for (const f of readdirSync(kd)) if (parseInt(f, 10) > next) rmSync(join(kd, f));
    const r2 = restart(dir);
    expect(r2.logs.find((l) => l.startsWith(`recovered ${run.runId}`))).toContain('with mismatch');
    const s2 = r2.m.get(run.runId)!;
    expect(s2.world.seq).toBe(seqAfter);
    expect(s2.seqResumePending()).toBeNull();
    await act(r2.m.portForToken(run.token)!, { type: 'wait' });
    r2.m.closeAll();
    expect(strictlyIncreasing(ep)).toBe(true);
  });
});

describe('S3f §40.2 の 3: replay:verify reads the logs like the server', () => {
  it('a torn last line in either log is skipped instead of throwing', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3f-verify', 4);
    const clean = verifyRunDir(content, run.rd);
    expect(clean.reexecMatches).toBe(true);
    appendFileSync(join(run.rd, 'events.jsonl'), '{"seq":');
    appendFileSync(join(run.rd, 'commands.jsonl'), '\0\0\0{"cseq":');
    const v = verifyRunDir(content, run.rd);
    expect(v.reexecMatches).toBe(true);
    expect(v.foldMatchesKeyframe).toBe(true);
    expect(v.events).toBe(clean.events);
  });
});

describe('S3f §40.2 の 4: two servers reading the same stale lock', () => {
  it('the late one moves the fresh lock aside, sees it is not the stale one it read, puts it back and stops (only one starts)', async () => {
    const dir = tmp();
    const path = join(dir, RUNS_LOCK);
    // 古い印: プロセスは生きている（番号の使い回し）が、待ち受けを始めた後のポートが応えない
    writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 1000, port: 1, host: '127.0.0.1', listening: true, nonce: 'old' }));
    const slow = (ms: number) => () => new Promise<boolean>((r) => setTimeout(() => r(false), ms));
    const [x, y] = await Promise.all([acquireLock(path, { port: 7796 }, slow(10)), acquireLock(path, { port: 7797 }, slow(400))]);
    const oks = [x, y].filter((r) => 'ok' in r);
    expect(oks).toHaveLength(1);
    expect('ok' in x).toBe(true);
    expect('busy' in y).toBe(true);
    // 残っている印は、先に取ったほうのもの（移したまま・消したままにしない）
    expect(JSON.parse(readFileSync(path, 'utf8')).port).toBe(7796);
    expect(readdirSync(dir).filter((f) => f.startsWith(`${RUNS_LOCK}.stale`))).toEqual([]);
  });

  it('a stale lock is moved aside (not deleted) and the one that moved it starts', async () => {
    const dir = tmp();
    const path = join(dir, RUNS_LOCK);
    writeFileSync(path, JSON.stringify({ pid: process.ppid, startedAt: Date.now() - 1000, port: 1, listening: true, nonce: 'old' }));
    const r = await acquireLock(path, { port: 7798 }, async () => false);
    expect('ok' in r && r.stale?.nonce).toBe('old');
    expect(JSON.parse(readFileSync(path, 'utf8')).port).toBe(7798);
    expect(readdirSync(dir).filter((f) => f.startsWith(`${RUNS_LOCK}.stale`))).toEqual([]);
  });
});

describe('S3f §40.2 の 5: the port is checked before recovery', () => {
  const listen = () => new Promise<{ srv: Server; port: number }>((res) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => res({ srv, port: (srv.address() as { port: number }).port })); });

  it('portInUse tells a taken port from a free one', async () => {
    const { srv, port } = await listen();
    expect(await portInUse(['127.0.0.1'], port)).toContain(`127.0.0.1:${port}`);
    await new Promise<void>((r) => srv.close(() => r()));
    expect(await portInUse(['127.0.0.1'], port)).toBeNull();
  });

  it('a server started on a taken port stops before recovering and writes nothing in the runs dir', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3f-port', 3);
    // 一致する復旧なら切られる、命令の記録が覆っていない出来事（復旧が走れば、記録が変わる）
    const ep = join(run.rd, 'events.jsonl');
    const last = lines(ep).at(-1)!;
    appendFileSync(ep, JSON.stringify({ ...last, seq: last.seq + 1 }) + '\n');
    const before = snap(dir);
    const { srv, port } = await listen();
    try {
      const root = resolve(__dirname, '..', '..', '..');
      const child = spawn(process.execPath, [join(root, 'packages', 'server', 'bin', 'muse-server.mjs')], {
        cwd: root, env: { ...process.env, MUSE_PORT: String(port), MUSE_HOST: '127.0.0.1', MUSE_RUNS_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += String(d); });
      child.stderr.on('data', (d) => { out += String(d); });
      const code = await new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
      expect(code).toBe(1);
      expect(out).toContain('[port]');
      expect(out).not.toContain('[recover]');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
    same(before, snap(dir));
    expect(existsSync(join(dir, RUNS_LOCK))).toBe(false);
  }, 60_000);
});

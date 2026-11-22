// S3h（SEASON.md §41.10）のテスト: 命令の記録が覆っていない出来事は、続けた後も確定の扱いにしない（中 1）・食い違ったランは、続けるとき必ず境目を残す（中 2）・
// replay:verify の境目・足りなかった形（命令の書けなかった境目・再生で終わったラン・断られる命令・参加・取り込み・別のプロセスの印の取り合い）
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { atomicWriteHooks, dropPendingWrites, loadConfig, RUNS_LOCK, SessionManager, SpectatorPort } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, canonicalHash, emptyWorld, stripSecret } from '@muse/shared';
import type { Command, World } from '@muse/shared';
import { verifyRunDir } from '../src/replay';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'muse-s3h-')); dirs.push(d); return d; };
afterEach(() => {
  atomicWriteHooks.beforeRename = null;
  atomicWriteHooks.rename = (a, b) => renameSync(a, b);
  atomicWriteHooks.read = (p) => readFileSync(p, 'utf8');
  dropPendingWrites();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mgr = (dir: string) => new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100, keyframeEvery: 40 }));
const restart = (dir: string) => { const m = mgr(dir); const logs: string[] = []; m.recoverAll((s) => logs.push(s)); return { m, logs }; };
const recLine = (logs: string[], runId: string) => logs.find((l) => l.startsWith(`recovered ${runId}`)) ?? '';
type Line = { seq: number; cseq: number; type?: string; fromSeq?: number; resultSeq?: [number, number] | null; command?: { type: string; next?: number; reason?: string }; player?: string | null; source?: string; macro?: boolean };
const parse = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
const lines = (p: string) => parse(readFileSync(p, 'utf8'));
const writeLines = (p: string, xs: unknown[]) => writeFileSync(p, xs.map((x) => JSON.stringify(x)).join('\n') + '\n');
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

async function waitedRun(dir: string, seed: string, waits: number, mode: 'solo' | 'coop' = 'solo') {
  const m = mgr(dir);
  const r = await m.createRun({ name: 'Rev', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth', mode });
  if ('error' in r) throw new Error(r.error.message);
  for (let i = 0; i < waits; i++) await act(r.port, { type: 'wait' });
  const out = { runId: r.session.runId, token: r.token, playerId: r.playerId, rd: join(dir, r.session.runId) };
  m.closeAll();
  return out;
}
type Run = Awaited<ReturnType<typeof waitedRun>>;

/** 最後の命令（結果のあるもの）より後ろが再生されるように、それ以後のキーフレームを消す */
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

/** 食い違いの 3 つの形（§41.10 の中 2）を作る */
function mismatch(run: Run, form: 'past' | 'short' | 'content'): { b: number } {
  const { cp, cmds, at, a, b, ep } = lastCommandReplayed(run.rd);
  const evs = lines(ep) as unknown as Record<string, unknown>[];
  const lastEv = evs.at(-1)!;
  const noise = (seq: number, cause: number | null) => ({ type: 'noise', pos: { x: 0, y: 0 }, loudness: 0, source: null, seenBy: [], floor: lastEv.floor, ft: lastEv.ft, seq, cause, wall: lastEv.wall });
  if (form === 'past') {
    // 先まで進んだ: 前の版が最後の命令について 1 つ少なく出していた。その番号には、命令の無い出来事がある
    writeLines(ep, [...evs.filter((e) => e.seq !== b), noise(b, null)]);
    cmds[at].resultSeq = [a, b - 1];
    writeLines(cp, cmds);
  } else if (form === 'short') {
    // 届かない: 前の版が最後の命令について 1 つ多く出していた
    appendFileSync(ep, JSON.stringify(noise(b + 1, lastEv.cause as number)) + '\n');
    cmds[at].resultSeq = [a, b + 1];
    writeLines(cp, cmds);
  } else {
    // 同じ数で中身が違う: 最後の命令の出来事の 1 つの中身が違う
    writeLines(ep, evs.map((e) => (e.seq === b - 1 ? { ...e, ft: (e.ft as number) + 1000 } : e)));
  }
  return { b };
}

/**
 * 続けて最初の書き込みをしたとき（§41.10 の中 2）: 追記だけ（既にあるバイトを変えない）・番号は記録とライブの World のどの番号とも重ならない・
 * 最初に足されるのは境目（seq_resumed）・次の起動は一致（hash ok）で同じ所・その次の起動は何も書かない
 */
async function continueAndCheck(dir: string, run: Run, first: (m: SessionManager) => Promise<unknown>) {
  const ep = join(run.rd, 'events.jsonl'), cp = join(run.rd, 'commands.jsonl');
  const e0 = readFileSync(ep), c0 = readFileSync(cp);
  const oldMax = Math.max(...parse(e0.toString('utf8')).map((e) => e.seq));
  const r = restart(dir);
  expect(recLine(r.logs, run.runId)).toContain('with mismatch');
  const s = r.m.get(run.runId)!;
  const pending = s.seqResumePending()!;
  const live = s.world.seq;
  expect(pending).toBe(Math.max(oldMax, live) + 1);
  await first(r.m);
  const after = s.world.seq;
  r.m.closeAll();
  expect(readFileSync(ep).subarray(0, e0.length).equals(e0)).toBe(true);
  expect(readFileSync(cp).subarray(0, c0.length).equals(c0)).toBe(true);
  expect(strictlyIncreasing(ep)).toBe(true);
  const addedE = parse(readFileSync(ep).subarray(e0.length).toString('utf8'));
  const addedC = parse(readFileSync(cp).subarray(c0.length).toString('utf8'));
  expect(addedE[0]).toMatchObject({ type: 'seq_resumed', seq: pending, fromSeq: live });
  expect(addedE.every((e) => e.seq > Math.max(oldMax, live))).toBe(true);
  expect(addedC[0]).toMatchObject({ player: null, source: 'system', command: { type: 'seq_resume', next: pending }, resultSeq: [pending, pending] });
  expect(readdirSync(join(run.rd, 'keyframes'))).toContain(`${pending}.json`);
  // S3i §46.2 の 4: 一致の側で直す 2 回目の起動も、境目より前のバイトと、境目までのキーフレームを変えない
  const eB = readFileSync(ep), cB = readFileSync(cp);
  const kfUpTo = () => new Map([...snap(join(run.rd, 'keyframes'))].filter(([f]) => /^\d+\.json$/.test(f) && parseInt(f, 10) <= pending));
  const kfB = kfUpTo();
  const r2 = restart(dir);
  expect(recLine(r2.logs, run.runId)).toContain('hash ok');
  expect(r2.m.get(run.runId)!.world.seq).toBe(after);
  r2.m.closeAll();
  const boundaryEnd = eB.indexOf('"seq_resumed"');
  const lineEnd = eB.indexOf(0x0a, boundaryEnd);
  expect(boundaryEnd).toBeGreaterThan(0);
  expect(readFileSync(ep).subarray(0, lineEnd + 1).equals(eB.subarray(0, lineEnd + 1))).toBe(true);
  expect(readFileSync(cp).subarray(0, c0.length).equals(cB.subarray(0, c0.length))).toBe(true);
  same(kfB, kfUpTo());
  const sn = snap(dir);
  const r3 = restart(dir);
  expect(recLine(r3.logs, run.runId)).toContain('hash ok');
  r3.m.closeAll();
  same(sn, snap(dir));
  return { pending, live, addedC, after };
}

describe('S3h §41.10 の中 2: a mismatched run always leaves a boundary when it goes on', () => {
  for (const form of ['past', 'short', 'content'] as const) {
    it(`form "${form}": the next restart matches from the boundary keyframe, the one after writes nothing, nothing already written changes, no number is reused`, async () => {
      const dir = tmp();
      const run = await waitedRun(dir, `s3h-${form}`, 6);
      const { b } = mismatch(run, form);
      const before = snap(dir);
      // 読むだけなら何も書かない
      const r0 = restart(dir);
      expect(recLine(r0.logs, run.runId)).toContain('with mismatch');
      r0.m.portForToken(run.token)!.view();
      r0.m.closeAll();
      same(before, snap(dir));
      const res = await continueAndCheck(dir, run, (m) => act(m.portForToken(run.token)!, { type: 'wait' }));
      if (form === 'past') {
        // 記録の #b（命令の無い出来事）とライブの #b（記録に無い）は、どちらも確定の扱いにならず、番号も重ならない
        expect(res.live).toBe(b);
        const r = restart(dir);
        expect(r.m.get(run.runId)!.history.some((e) => e.seq === b)).toBe(false);
        r.m.closeAll();
      }
    });
  }

  it('the delayed spectator and the history fold start from the boundary keyframe (not from the old-version events before it)', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3h-spect', 14);
    const kd = join(run.rd, 'keyframes');
    const kfs = readdirSync(kd).map((f) => parseInt(f, 10)).sort((x, y) => x - y);
    for (const s of kfs.slice(1)) rmSync(join(kd, `${s}.json`));
    const kfc = JSON.parse(readFileSync(join(kd, `${kfs[0]}.json`), 'utf8')).cseq as number;
    const cp = join(run.rd, 'commands.jsonl');
    const cmds = lines(cp);
    cmds.splice(cmds.findIndex((c) => c.cseq > kfc + 1 && !!c.resultSeq && c.command?.type === 'wait'), 1);
    writeLines(cp, cmds);
    const check = (s: NonNullable<ReturnType<SessionManager['get']>>, oldBefore: boolean) => {
      const b = s.boundaries().at(-1)!;
      expect(canonicalHash(s.foldHistory())).toBe(canonicalHash(s.world));
      // 遅らせた観戦: 境目のキーフレームから、境目の後の出来事を畳んだもの
      const snapW = new SpectatorPort(s, 'delayed', 1).snapshot();
      expect(snapW.seq).toBe(s.world.seq - 1);
      const w = (JSON.parse(readFileSync(join(kd, `${b}.json`), 'utf8')) as { world: World }).world;
      for (const ev of s.history) if (ev.seq > b && ev.seq <= snapW.seq) applyEvent(w, ev);
      expect(canonicalHash(snapW.world)).toBe(canonicalHash(stripSecret(w)));
      // 境目の所まで遅らせた観戦は、境目のキーフレームそのもの。境目より前の履歴が記録の出来事（前の版）のときは、前のように空の World から
      // 畳むと違う World になる（続けたその場の履歴は再生の結果なので、どちらから畳んでも同じ）
      const atB = new SpectatorPort(s, 'delayed', s.world.seq - b).snapshot();
      expect(atB.seq).toBe(b);
      const kfB = (JSON.parse(readFileSync(join(kd, `${b}.json`), 'utf8')) as { world: World }).world;
      expect(canonicalHash(atB.world)).toBe(canonicalHash(stripSecret(kfB)));
      const old = emptyWorld();
      for (const ev of s.history) if (ev.seq <= b) applyEvent(old, ev);
      if (oldBefore) expect(canonicalHash(stripSecret(old))).not.toBe(canonicalHash(atB.world));
      else expect(canonicalHash(stripSecret(old))).toBe(canonicalHash(atB.world));
    };
    const r1 = restart(dir);
    const s1 = r1.m.get(run.runId)!;
    for (let i = 0; i < 3; i++) await act(r1.m.portForToken(run.token)!, { type: 'wait' });
    expect(s1.boundaries()).toHaveLength(1);
    check(s1, false);
    r1.m.closeAll();
    // 境目のキーフレームを残したまま、それより後のキーフレームを消して起動し直しても同じ
    for (const f of readdirSync(kd)) if (parseInt(f, 10) > s1.boundaries()[0]) rmSync(join(kd, f));
    const r2 = restart(dir);
    expect(recLine(r2.logs, run.runId)).toContain('hash ok');
    check(r2.m.get(run.runId)!, true);
    r2.m.closeAll();
  });
});

describe('S3h §41.10 の中 1: events no command covers stay out after the run goes on', () => {
  it('a camp run with two commandless events and one altered event: the refused first command leaves the boundary; on the next restart the two events are not treated as committed and nothing is rewritten', async () => {
    const dir = tmp();
    const m = mgr(dir);
    const r = await m.createRun({ name: 'Rev', seed: 's3h-camp', classId: 'core:warrior', controller: agent });
    if ('error' in r) throw new Error(r.error.message);
    for (const t of ['a', 'b', 'c']) await act(r.port, { type: 'note', add: t });
    const run = { runId: r.session.runId, token: r.token, playerId: r.playerId, rd: join(dir, r.session.runId) };
    m.closeAll();
    const ep = join(run.rd, 'events.jsonl');
    const cp = join(run.rd, 'commands.jsonl');
    const covered = lines(cp).filter((c) => c.resultSeq).at(-1)!.resultSeq![1];
    const evs = lines(ep) as unknown as Record<string, unknown>[];
    const lastEv = evs.at(-1)!;
    // 命令の無い出来事 2 件（文になるので、確定の扱いになればメッセージに出る）と、途中の出来事 1 件の書き換え（食い違い）
    const orphan = (seq: number) => ({ type: 'chat', player: run.playerId, name: 'Rev', text: `ORPHAN-${seq}`, seenBy: 'all', floor: null, ft: 0, seq, cause: null, wall: lastEv.wall });
    const lastNote = [...evs].reverse().find((e) => e.type === 'notes_updated')!;
    writeLines(ep, [...evs.map((e) => (e === lastNote ? { ...e, notesAfter: ['tampered'] } : e)), orphan(covered + 1), orphan(covered + 2)]);
    const before = snap(dir);
    const r1 = restart(dir);
    expect(recLine(r1.logs, run.runId)).toContain('with mismatch');
    const s1 = r1.m.get(run.runId)!;
    expect(s1.seqResumePending()).toBe(covered + 3);
    r1.m.closeAll();
    same(before, snap(dir));
    // 最初の命令は断られる（キャンプでの look）が、境目は残る（§41.10 の決めたこと: 断られた命令でも送る）
    const r2 = restart(dir);
    const s2 = r2.m.get(run.runId)!;
    const res = await s2.submit(run.playerId, { type: 'look' } as unknown as Command, { source: 'bot' });
    expect(res.ok).toBe(false);
    r2.m.closeAll();
    expect(lines(cp).at(-1)).toMatchObject({ command: { type: 'seq_resume', next: covered + 3 } });
    expect(readdirSync(join(run.rd, 'keyframes'))).toContain(`${covered + 3}.json`);
    // 次の起動は一致（記録を直す側へ移る）。足した 2 件は、区間の外なので、確定の扱いにならない
    const sn = snap(dir);
    const r3 = restart(dir);
    expect(recLine(r3.logs, run.runId)).toContain('hash ok');
    const s3 = r3.m.get(run.runId)!;
    expect(s3.history.some((e) => e.seq === covered + 1 || e.seq === covered + 2)).toBe(false);
    expect(s3.messages(run.playerId).some((x) => x.text.includes('ORPHAN'))).toBe(false);
    r3.m.closeAll();
    same(sn, snap(dir));
  });
});

describe('S3h §41.10 の軽 1: replay:verify after a boundary', () => {
  it('a run continued after a mismatch is checked only after the boundary and passes', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3h-verify', 6);
    mismatch(run, 'short');
    const r = restart(dir);
    for (let i = 0; i < 3; i++) await act(r.m.portForToken(run.token)!, { type: 'wait' });
    const B = r.m.get(run.runId)!.boundaries()[0];
    r.m.closeAll();
    const v = verifyRunDir(content, run.rd);
    expect(v.boundary).toMatchObject({ seq: B, keyframe: true });
    expect(v.note).toContain(`境目 #${B}`);
    expect(v.reexecMatches).toBe(true);
    expect(v.foldMatchesKeyframe).toBe(true);
    // 境目のキーフレームが無ければ、照らせないと言う
    rmSync(join(run.rd, 'keyframes', `${B}.json`));
    const v2 = verifyRunDir(content, run.rd);
    expect(v2.boundary).toMatchObject({ seq: B, keyframe: false });
    expect(v2.reexecMatches).toBe(false);
    expect(v2.note).toContain('照らせない');
  });
});

describe('S3h §41.10 の軽 3: the forms that had no test', () => {
  it('the boundary event was written but its command was not (crash in between): it is not committed, and the next continuation leaves a new boundary after it', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3h-crash', 6);
    mismatch(run, 'short');
    const r = restart(dir);
    await act(r.m.portForToken(run.token)!, { type: 'wait' });
    const B = r.m.get(run.runId)!.boundaries()[0];
    r.m.closeAll();
    // seq_resumed（#B）までの出来事を残し、seq_resume の命令とその後ろ、境目からのキーフレームを消す
    const ep = join(run.rd, 'events.jsonl'), cp = join(run.rd, 'commands.jsonl');
    writeLines(ep, lines(ep).filter((e) => e.seq <= B));
    const cmds = lines(cp);
    writeLines(cp, cmds.slice(0, cmds.findIndex((c) => c.command?.type === 'seq_resume')));
    for (const f of readdirSync(join(run.rd, 'keyframes'))) if (parseInt(f, 10) >= B) rmSync(join(run.rd, 'keyframes', f));
    const r1 = restart(dir);
    expect(recLine(r1.logs, run.runId)).toContain('with mismatch');
    const s1 = r1.m.get(run.runId)!;
    expect(s1.history.some((e) => e.type === 'seq_resumed')).toBe(false);
    expect(s1.seqResumePending()).toBe(B + 1);
    r1.m.closeAll();
    const res = await continueAndCheck(dir, run, (m) => act(m.portForToken(run.token)!, { type: 'wait' }));
    expect(res.pending).toBe(B + 1);
  });

  it('a run that the current engine ends during the replay (the log still says active) gets no boundary: nothing is written', async () => {
    const dir = tmp();
    const m = mgr(dir);
    const r0 = await m.createRun({ name: 'Rev', seed: 's3h-ended', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r0) throw new Error(r0.error.message);
    for (let i = 0; i < 3; i++) await act(r0.port, { type: 'wait' });
    expect((await act(r0.port, { type: 'retire' })).ok).toBe(true);
    const run = { runId: r0.session.runId, token: r0.token, playerId: r0.playerId, rd: join(dir, r0.session.runId) };
    m.closeAll();
    // 前の版では、最後の命令（retire）でランが終わらなかった形: run_ended から後ろの出来事が無く、meta.json は進行中
    const ep = join(run.rd, 'events.jsonl'), cp = join(run.rd, 'commands.jsonl');
    const cmds = lines(cp);
    const at = cmds.map((c) => !!c.resultSeq).lastIndexOf(true);
    const [a] = cmds[at].resultSeq!;
    const endSeq = lines(ep).find((e) => e.type === 'run_ended')!.seq;
    writeLines(ep, lines(ep).filter((e) => e.seq < endSeq));
    cmds[at].resultSeq = endSeq > a ? [a, endSeq - 1] : null;
    writeLines(cp, cmds);
    for (const f of readdirSync(join(run.rd, 'keyframes'))) if (parseInt(f, 10) >= a) rmSync(join(run.rd, 'keyframes', f));
    const metaP = join(run.rd, 'meta.json');
    const meta = JSON.parse(readFileSync(metaP, 'utf8'));
    writeFileSync(metaP, JSON.stringify({ ...meta, status: 'active', endedAt: undefined, seed: undefined }, null, 2));
    const before = snap(dir);
    const r1 = restart(dir);
    expect(recLine(r1.logs, run.runId)).toContain('with mismatch');
    const s1 = r1.m.get(run.runId)!;
    expect(s1.world.status).toBe('ended');
    expect(s1.seqResumePending()).toBeNull();
    const res = await s1.submit(run.playerId, { type: 'wait' }, { source: 'bot' });
    expect(res.ok).toBe(false);
    r1.m.closeAll();
    same(before, snap(dir));
  });

  it('a join is the first write: the boundary comes before the join record, and the new player numbers after it', async () => {
    const dir = tmp();
    const run = await waitedRun(dir, 's3h-join', 6, 'coop');
    mismatch(run, 'short');
    const res = await continueAndCheck(dir, run, async (m) => {
      const j = await m.joinRun(run.runId, { name: 'Two', controller: agent });
      expect('error' in j ? j.error.message : 'ok').toBe('ok');
    });
    expect(res.addedC.map((c) => c.command?.type)).toEqual(['seq_resume', 'join']);
  });

  it('a season sync is the first write (start_expedition at camp): the boundary comes before the sync', async () => {
    const dir = tmp();
    const m = mgr(dir);
    m.seasons.store.open({ id: 's3ht', name: 'S3h', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite('s3ht', 'Aya', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const r0 = await m.createRun({ name: 'Aya', controller: agent, season: 's3ht', profileToken: inv.token! });
    if ('error' in r0) throw new Error(r0.error.message);
    const offer = r0.session.world.camp!.offers[0].index;
    const run = { runId: r0.session.runId, token: r0.token, playerId: r0.playerId, rd: join(dir, r0.session.runId) };
    m.closeAll();
    // 取り込みの出来事の中身が違う形（食い違い）
    const ep = join(run.rd, 'events.jsonl'), cp = join(run.rd, 'commands.jsonl');
    const sync = lines(cp).filter((c) => c.command?.type === 'season_sync' && c.resultSeq).at(-1)!;
    for (const f of readdirSync(join(run.rd, 'keyframes'))) if (parseInt(f, 10) >= sync.resultSeq![0]) rmSync(join(run.rd, 'keyframes', f));
    writeLines(ep, (lines(ep) as unknown as Record<string, unknown>[]).map((e) => (e.type === 'season_synced' && (e.seq as number) >= sync.resultSeq![0] ? { ...e, ft: 12345 } : e)));
    const res = await continueAndCheck(dir, run, (mm) => act(mm.portForToken(run.token)!, { type: 'start_expedition', offer }));
    expect(res.addedC.map((c) => c.command?.type)).toEqual(['seq_resume', 'season_sync', 'start_expedition']);
    expect(res.addedC[1].command?.reason).toBe('start');
  });

  it('two server processes reading the same stale lock: only one takes it (separate processes)', async () => {
    const dir = tmp();
    const path = join(dir, RUNS_LOCK);
    const root = resolve(__dirname, '..', '..', '..');
    // 古い印: プロセス（このテストのプロセス）は生きているが、待ち受けを始めた後のポートが応えない
    writeFileSync(path, JSON.stringify({ pid: process.pid, startedAt: Date.now() - 1000, port: 1, host: '127.0.0.1', listening: true, nonce: 'old' }));
    const script = join(dir, 'child.mts');
    writeFileSync(script, [
      'const [mod, path, port, delay, startAt] = process.argv.slice(2);',
      'const { acquireLock } = await import(mod);',
      'while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 5));',
      'const r = await acquireLock(path, { port: Number(port) }, () => new Promise((res) => setTimeout(() => res(false), Number(delay))));',
      "console.log(JSON.stringify('ok' in r ? { ok: true } : 'busy' in r ? { busy: true } : { error: r.error }));",
    ].join('\n'));
    const mod = pathToFileURL(join(root, 'packages', 'server', 'src', 'log', 'atomicWrite.ts')).href;
    const startAt = Date.now() + 4000;
    const run = (port: number, delay: number) => new Promise<string>((res) => {
      const c = spawn(process.execPath, ['--import', 'tsx', script, mod, path, String(port), String(delay), String(startAt)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => { out += String(d); });
      c.stderr.on('data', (d) => { out += String(d); });
      c.on('exit', () => res(out.trim()));
    });
    const [x, y] = await Promise.all([run(7796, 10), run(7797, 600)]);
    expect([x, y]).toEqual([JSON.stringify({ ok: true }), JSON.stringify({ busy: true })]);
    expect(JSON.parse(readFileSync(path, 'utf8')).port).toBe(7796);
    expect(readdirSync(dir).filter((f) => f.startsWith(`${RUNS_LOCK}.stale`))).toEqual([]);
  }, 60_000);
});

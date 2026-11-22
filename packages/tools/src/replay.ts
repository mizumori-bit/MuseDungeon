// リプレイ検証: (1) events.jsonl の畳み込みがキーフレームと一致、(2) commands.jsonl の再実行で events.jsonl と一致。
// ゴールデンリプレイの生成もここ。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Content } from '@muse/content';
import { createRun, joinPlayer, resumeSeq, seasonSync, step } from '@muse/engine';
import type { CommandRecord, GameEvent, RunMetaFile, World } from '@muse/shared';
import { applyEvent, canonicalHash, emptyWorld } from '@muse/shared';
// 記録の読み方はサーバーと同じ（SEASON.md §40.2 の 3: 読めない行（欠けた最後の行など）を飛ばす。行の頭の空のバイトは除く）
import { loadConfig, logBounds, readJsonl, SessionManager } from '@muse/server';
import { playWithPort } from './bot';

const noWall = (es: GameEvent[]) => es.map((e) => ({ ...e, wall: 0 }));

export function foldAll(events: GameEvent[], upTo = Number.MAX_SAFE_INTEGER): World {
  const w = emptyWorld();
  for (const ev of events) {
    if (ev.seq > upTo) break;
    applyEvent(w, ev);
  }
  return w;
}

export interface VerifyResult {
  dir: string;
  events: number;
  commands: number;
  lastSeq: number;
  keyframeSeq: number | null;
  foldMatchesKeyframe: boolean;
  reexecMatches: boolean;
  reexecEvents: number;
  finalHash: string;
  /**
   * 食い違いの後の続き（S3h。SEASON.md §41.10 の軽 1）: 最後の seq_resume の境目（番号・その命令の番号・境目のキーフレームがあるか）。
   * あれば、照らすのは境目の後だけ（境目より前は前の版の出来事なので、今の engine の再実行とは合わない）
   */
  boundary: { seq: number; cseq: number; keyframe: boolean } | null;
  /** 命令の記録が覆っていない出来事の数（サーバーと同じく読まない。S3h §41.10 の中 1） */
  uncovered: number;
  note?: string;
}

export function verifyRunDir(content: Content, dir: string): VerifyResult {
  const raw = readJsonl<GameEvent>(join(dir, 'events.jsonl'));
  const commands = readJsonl<CommandRecord>(join(dir, 'commands.jsonl'));
  // 命令の記録が覆っている出来事だけ（サーバーの復旧と同じ読み方）
  const bounds = logBounds(raw, commands);
  const events = raw.filter((e) => bounds.covers(e.seq));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunMetaFile;
  const kfs = existsSync(join(dir, 'keyframes')) ? readdirSync(join(dir, 'keyframes')).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b) : [];
  const lastKf = kfs.length ? kfs[kfs.length - 1] : null;
  const readKf = (seq: number) => { try { return JSON.parse(readFileSync(join(dir, 'keyframes', `${seq}.json`), 'utf8')) as { seq: number; cseq: number; world: World }; } catch { return null; } };
  // 食い違いの後の続きの境目（最後の seq_resume）。境目のキーフレームがあれば、そこから照らす
  const rb = [...commands].reverse().find((c) => c.command.type === 'seq_resume' && c.resultSeq);
  const bkf = rb ? readKf(rb.resultSeq![1]) : null;
  const boundary = rb ? { seq: rb.resultSeq![1], cseq: rb.cseq, keyframe: !!bkf } : null;
  const base = boundary && bkf ? { seq: boundary.seq, cseq: bkf.cseq, world: bkf.world } : null;
  const fromBase = (upTo: number): World => {
    const w = base ? structuredClone(base.world) : emptyWorld();
    for (const ev of events) {
      if (base && ev.seq <= base.seq) continue;
      if (ev.seq > upTo) break;
      applyEvent(w, ev);
    }
    return w;
  };
  const uncovered = raw.length - events.length;
  const noteOf = boundary ? (base ? `食い違いの後の続き（境目 #${boundary.seq}）: 境目より後だけを照らした（境目より前は前の版の出来事）` : `食い違いの後の続き（境目 #${boundary.seq}）だが、境目のキーフレームが無いので照らせない`) : undefined;
  if (boundary && !base) {
    return { dir, events: events.length, commands: commands.length, lastSeq: events.length ? events[events.length - 1].seq : 0, keyframeSeq: lastKf, foldMatchesKeyframe: false, reexecMatches: false, reexecEvents: 0, finalHash: canonicalHash(foldAll(events)), boundary, uncovered, ...(noteOf ? { note: noteOf } : {}) };
  }
  let foldMatchesKeyframe = true;
  for (const seq of kfs) {
    if (base && seq < base.seq) continue;
    const kf = readKf(seq);
    if (!kf || canonicalHash(fromBase(seq)) !== canonicalHash(kf.world)) { foldMatchesKeyframe = false; break; }
  }
  // 決定論的再実行（基本行動だけを流す）。境目があれば、境目のキーフレームから、その後の命令だけ
  let world: World;
  const re: GameEvent[] = [];
  if (base) world = structuredClone(base.world);
  else {
    const first = events[0];
    if (first?.type !== 'run_started' || !first.secret) throw new Error('events.jsonl must start with run_started (with secret)');
    const c = createRun(content, { runId: first.meta.runId, seed: first.secret.seed, mode: first.meta.mode, options: first.meta.options, wall: first.wall, ...(first.meta.season ? { season: first.meta.season } : {}) });
    world = c.world;
    re.push(...c.events);
  }
  for (const rec of commands) {
    if (rec.macro || (base && rec.cseq <= base.cseq)) continue;
    if (rec.command.type === 'join') re.push(...joinPlayer(world, content, rec.command, { cseq: rec.cseq, wall: rec.wall }).events);
    // シーズンの取り込み（S0 §9.7）: 中身は記録に全部ある
    else if (rec.command.type === 'season_sync') re.push(...seasonSync(world, content, rec.player!, rec.command, { cseq: rec.cseq, wall: rec.wall, thought: rec.thought }).events);
    // 食い違ったランの続きの番号（S3f §40.2 の 2）: 記録の番号で出す
    else if (rec.command.type === 'seq_resume') re.push(...resumeSeq(world, content, rec.command, { cseq: rec.cseq, wall: rec.wall }).events);
    else re.push(...step(world, content, rec.player!, rec.command, { cseq: rec.cseq, wall: rec.wall, thought: rec.thought }).events);
  }
  const target = base ? events.filter((e) => e.seq > base.seq) : events;
  const reexecMatches = canonicalHash(noWall(re)) === canonicalHash(noWall(target));
  void meta;
  return {
    dir, events: events.length, commands: commands.length, lastSeq: events.length ? events[events.length - 1].seq : 0,
    keyframeSeq: lastKf, foldMatchesKeyframe, reexecMatches, reexecEvents: re.length, finalHash: canonicalHash(fromBase(Number.MAX_SAFE_INTEGER)),
    boundary, uncovered, ...(noteOf ? { note: noteOf } : {}),
  };
}

/** 固定シードで bot を走らせ、ゴールデンリプレイ（events.jsonl + expected.json）を書き出す */
export async function writeGolden(content: Content, outDir: string, seed: string): Promise<{ events: number; hash: string }> {
  const tmp = join(tmpdir(), `muse-golden-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  const manager = new SessionManager(content, loadConfig({ runsDir: tmp }));
  const r = await manager.createRun({ name: 'golden', seed, controller: { kind: 'agent', label: 'golden-bot' } });
  if ('error' in r) throw new Error(r.error.message);
  await playWithPort(r.port, { kind: 'greedy', seed, maxActs: 150 });
  manager.closeAll();
  const dir = join(tmp, r.session.runId);
  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(dir, 'events.jsonl'), join(outDir, 'events.jsonl'));
  const events = readJsonl<GameEvent>(join(outDir, 'events.jsonl'));
  const hash = canonicalHash(foldAll(events));
  writeFileSync(join(outDir, 'expected.json'), JSON.stringify({ seed, runId: r.session.runId, lastSeq: events[events.length - 1].seq, finalHash: hash, contentVersion: content.version, note: 'reducer の後方互換性を守るためのゴールデンリプレイ。意図して形式を変えたときだけ npm run golden で作り直す' }, null, 2));
  rmSync(tmp, { recursive: true, force: true });
  return { events: events.length, hash };
}

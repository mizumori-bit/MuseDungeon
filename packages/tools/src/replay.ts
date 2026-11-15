// リプレイ検証: (1) events.jsonl の畳み込みがキーフレームと一致、(2) commands.jsonl の再実行で events.jsonl と一致。
// ゴールデンリプレイの生成もここ。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Content } from '@muse/content';
import { createRun, joinPlayer, step } from '@muse/engine';
import type { CommandRecord, GameEvent, RunMetaFile, World } from '@muse/shared';
import { applyEvent, canonicalHash, emptyWorld } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { playWithPort } from './bot';

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

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
}

export function verifyRunDir(content: Content, dir: string): VerifyResult {
  const events = readJsonl<GameEvent>(join(dir, 'events.jsonl'));
  const commands = readJsonl<CommandRecord>(join(dir, 'commands.jsonl'));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunMetaFile;
  const kfs = existsSync(join(dir, 'keyframes')) ? readdirSync(join(dir, 'keyframes')).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b) : [];
  const lastKf = kfs.length ? kfs[kfs.length - 1] : null;
  let foldMatchesKeyframe = true;
  for (const seq of kfs) {
    const kf = JSON.parse(readFileSync(join(dir, 'keyframes', `${seq}.json`), 'utf8')) as { world: World };
    if (canonicalHash(foldAll(events, seq)) !== canonicalHash(kf.world)) { foldMatchesKeyframe = false; break; }
  }
  // 決定論的再実行（基本行動だけを流す）
  const first = events[0];
  if (first?.type !== 'run_started' || !first.secret) throw new Error('events.jsonl must start with run_started (with secret)');
  const { world, events: created } = createRun(content, { runId: first.meta.runId, seed: first.secret.seed, mode: first.meta.mode, options: first.meta.options, wall: first.wall });
  const re: GameEvent[] = [...created];
  for (const rec of commands) {
    if (rec.macro) continue;
    if (rec.command.type === 'join') re.push(...joinPlayer(world, content, rec.command, { cseq: rec.cseq, wall: rec.wall }).events);
    else re.push(...step(world, content, rec.player!, rec.command, { cseq: rec.cseq, wall: rec.wall, thought: rec.thought }).events);
  }
  const reexecMatches = canonicalHash(noWall(re)) === canonicalHash(noWall(events));
  void meta;
  return {
    dir, events: events.length, commands: commands.length, lastSeq: events.length ? events[events.length - 1].seq : 0,
    keyframeSeq: lastKf, foldMatchesKeyframe, reexecMatches, reexecEvents: re.length, finalHash: canonicalHash(foldAll(events)),
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

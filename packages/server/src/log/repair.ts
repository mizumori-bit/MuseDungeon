// ランの管理ファイルが壊れたときの作り直し（SEASON.md §33.1）。起動時の復旧（SessionManager.recoverAll）から呼ぶ。
// 作り直すのは、ほかの記録から同じものが作れるものだけ: meta.json（出来事の記録とキーフレーム）・summary.json/.md（出来事の要約）・キーフレーム（出来事の記録）。
// 作り直した元の壊れたファイルは、名前を替えて残す（*.broken）。作り直せないもの（tokens.json）は、呼ぶ側が復旧に失敗したランとして見せる。
import { appendFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_VERSION } from '@muse/engine';
import type { Catalog, GameEvent, RunMetaFile, RunSummary, World } from '@muse/shared';
import { applyEvent, emptyWorld } from '@muse/shared';
import { summaryMarkdown } from '../session/summary';
import { readJsonStable, writeFileAtomic } from './atomicWrite';
import type { KeyframeFile } from './LogWriter';
import { readJsonl } from './RunStore';

/** World から meta.json の中身を作る（RunSession の書き出しと、作り直しの両方がこれを使う） */
export function metaFromWorld(w: World, runId: string, createdAt: number, endedAt: number | undefined): RunMetaFile {
  return {
    runId,
    createdAt,
    endedAt: w.status === 'ended' ? endedAt : undefined,
    mode: w.meta.mode,
    contentVersion: w.meta.contentVersion,
    engineVersion: w.meta.engineVersion || ENGINE_VERSION,
    eventVersion: w.meta.eventVersion,
    options: { ...w.meta.options },
    status: w.status,
    players: w.playerOrder.map((pid) => {
      const p = w.players[pid];
      return { id: pid, name: p.name, classId: p.classId, controller: { ...p.controller }, joinedSeq: p.joinedSeq };
    }),
    // シーズンのラン（S0）は終わってもシードを出さない
    seed: w.status === 'ended' && !w.meta.season ? w.secret.seed : undefined,
    lastSeq: w.seq,
    ...(w.meta.season ? { season: w.meta.season.id } : {}),
  };
}

/** 読んだ meta.json が、使える形か（空のバイト・途中で切れた・別の物で上書きされた、を見分ける） */
export function isRunMeta(x: unknown): x is RunMetaFile {
  if (!x || typeof x !== 'object') return false;
  const m = x as Partial<RunMetaFile>;
  return typeof m.runId === 'string' && typeof m.createdAt === 'number' && (m.status === 'active' || m.status === 'ended')
    && Array.isArray(m.players) && (m.mode === 'solo' || m.mode === 'coop') && !!m.options && typeof m.options === 'object';
}

/** 読んだキーフレームが、使える形か */
export function isKeyframe(x: unknown): x is KeyframeFile {
  if (!x || typeof x !== 'object') return false;
  const k = x as Partial<KeyframeFile>;
  return typeof k.seq === 'number' && typeof k.cseq === 'number' && !!k.world && typeof k.world === 'object' && !!k.world.meta && !!k.world.players;
}

/** 壊れたファイルの名前を替えて残す（`<名前>.broken`。もうあれば `.broken.2`・`.broken.3`…。suffix で別の印）。替えた後の名前 */
export function moveAside(path: string, suffix = 'broken'): string | null {
  if (!existsSync(path)) return null;
  let to = `${path}.${suffix}`;
  for (let n = 2; existsSync(to); n++) to = `${path}.${suffix}.${n}`;
  renameSync(path, to);
  return to;
}

/** 出来事を World に畳む（seq が今の World より後のものだけ。同じ seq が 2 度あれば、先のもの） */
function foldOnto(w: World, events: readonly GameEvent[], upTo = Infinity): World {
  for (const e of events) {
    if (e.seq <= w.seq || e.seq > upTo) continue;
    applyEvent(w, e);
  }
  return w;
}

type CmdLite = { cseq: number; resultSeq?: [number, number] | null };

/**
 * 記録の範囲（SEASON.md §36.1 の 1）: covered は命令の記録が覆っている最後の出来事の番号（ランを作ったときの出来事は命令が無いので、
 * 最初の命令の結果より前の出来事も覆っているものと数える）。lastEventSeq は出来事の記録の最後、lastCseq は命令の記録の最後
 */
export function logBounds(events: readonly GameEvent[], commands: readonly CmdLite[]): { events: readonly GameEvent[]; covered: number; lastEventSeq: number; lastCseq: number } {
  const lastEventSeq = events.length ? events[events.length - 1].seq : 0;
  let cmdEnd = 0;
  let firstResult = Infinity;
  for (const c of commands) if (c.resultSeq) { cmdEnd = Math.max(cmdEnd, c.resultSeq[1]); firstResult = Math.min(firstResult, c.resultSeq[0]); }
  const creationEnd = firstResult === Infinity ? lastEventSeq : firstResult - 1;
  return { events, covered: Math.max(cmdEnd, creationEnd), lastEventSeq, lastCseq: commands.length ? commands[commands.length - 1].cseq : 0 };
}

/**
 * 出来事の記録から、番号が seq より後ろの出来事を切る（命令の記録が覆っていない出来事。§35.7 の 2）。切った分は `<名前>.uncommitted` に足して残す。
 * 切った件数（無ければ 0）。出来事は番号の順に追記されているので、最初に seq を越えた行から後ろを切る
 */
export function cutEventsAfter(path: string, seq: number): number {
  if (!existsSync(path)) return 0;
  const buf = readFileSync(path);
  let off = 0;
  let cutAt = -1;
  let n = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off);
    const end = nl < 0 ? buf.length : nl + 1;
    const line = buf.subarray(off, end).toString('utf8').replace(/^\0+/, '').trim();
    if (line) {
      let sq: number | undefined;
      try { sq = (JSON.parse(line) as { seq?: number }).seq; } catch { /* 読めない行は飛ばす（readJsonl と同じ） */ }
      if (sq !== undefined && sq > seq) { if (cutAt < 0) cutAt = off; n++; }
    }
    off = end;
  }
  if (cutAt < 0) return 0;
  appendFileSync(`${path}.uncommitted`, buf.subarray(cutAt));
  truncateSync(path, cutAt);
  return n;
}

/**
 * いちばん新しい、読めるキーフレーム。無ければ null。壊れたものは名前を替えて残す（moved）。
 * maxSeq・maxCseq: 記録の最後（§36.1 の 1）。キーフレームの出来事の番号か命令の番号がそれより先なら、使わずに名前を替えて残す（ahead。`.ahead`）。
 * ほかのプログラムが開いていて一時的に読めないものは、名前を替えずに 1 つ前を使う
 */
export function latestKeyframe(dir: string, opts: { moveBroken: boolean; maxSeq?: number; maxCseq?: number }): { kf: KeyframeFile | null; moved: string[]; ahead: string[] } {
  const kfDir = join(dir, 'keyframes');
  const seqs = existsSync(kfDir) ? readdirSync(kfDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => b - a) : [];
  const moved: string[] = [];
  const ahead: string[] = [];
  for (const seq of seqs) {
    const p = join(kfDir, `${seq}.json`);
    if (opts.maxSeq !== undefined && seq > opts.maxSeq) {
      if (opts.moveBroken) { const to = moveAside(p, 'ahead'); if (to) ahead.push(to); }
      continue;
    }
    const r = readJsonStable<KeyframeFile>(p, (v) => isKeyframe(v) && v.seq === seq);
    if ('value' in r) {
      if (opts.maxCseq !== undefined && r.value.cseq > opts.maxCseq) {
        if (opts.moveBroken) { const to = moveAside(p, 'ahead'); if (to) ahead.push(to); }
        continue;
      }
      return { kf: r.value, moved, ahead };
    }
    if ('broken' in r && opts.moveBroken) { const to = moveAside(p); if (to) moved.push(to); }
  }
  return { kf: null, moved, ahead };
}

/**
 * 出来事の記録だけから、キーフレームの代わりを作る（読めるキーフレームが 1 つも無いとき）。
 * 命令の記録が覆っている最後の出来事（upTo）まで畳み、cseq はその最後の命令（それより後の命令は無いので、再実行はしない）
 */
export function keyframeFromEvents(events: readonly GameEvent[], commands: readonly CmdLite[], upTo = logBounds(events, commands).covered): KeyframeFile | null {
  if (!events.length || events[0].type !== 'run_started') return null;
  const last = commands.length ? commands[commands.length - 1] : null;
  const w = foldOnto(emptyWorld(), events, upTo);
  return { seq: w.seq, cseq: last?.cseq ?? 0, world: w };
}

export type MetaRepair = { meta: RunMetaFile; from: 'keyframe' | 'events'; moved: string | null; season?: string } | { error: string; season?: string };

/**
 * meta.json を作り直す（読めない・中身が壊れている・消えた）。出来事の記録（events.jsonl）が要る:
 * 作った時刻は最初の出来事（run_started）の時刻、そのほかは、読める最新のキーフレームにそれより後の出来事を畳んだ World から（無ければ出来事だけから）。
 * 書く前に、壊れた元を meta.json.broken に残す
 */
export function repairMeta(dir: string, runId: string): MetaRepair {
  const events = readJsonl<GameEvent>(join(dir, 'events.jsonl'));
  const first = events[0];
  const season = first?.type === 'run_started' ? first.meta.season?.id : undefined;
  const why = (s: string): MetaRepair => ({ error: `meta.json が読めず、作り直せない: ${s}`, ...(season ? { season } : {}) });
  if (!first || first.type !== 'run_started') return why('出来事の記録（events.jsonl）が無いか、run_started で始まっていない');
  let world: World;
  let from: 'keyframe' | 'events' = 'keyframe';
  try {
    // 記録が覆っている範囲だけ（§36.1 の 1: 記録より先に進んだキーフレームと、命令の記録が覆っていない出来事は使わない）
    const b = logBounds(events, readJsonl<CmdLite>(join(dir, 'commands.jsonl')));
    const { kf } = latestKeyframe(dir, { moveBroken: false, maxSeq: Math.min(b.lastEventSeq, b.covered), maxCseq: b.lastCseq });
    if (kf) world = foldOnto(kf.world, events, b.covered);
    else { from = 'events'; world = foldOnto(emptyWorld(), events, b.covered); }
  } catch (e) {
    return why(`出来事を畳めない（${String((e as Error).message ?? e).split('\n')[0].slice(0, 120)}）`);
  }
  if (!world.meta?.runId) return why('記録から World を作れない');
  const ended = [...events].reverse().find((e) => e.type === 'run_ended' && e.seq <= world.seq);
  const meta = metaFromWorld(world, runId, first.wall, ended?.wall);
  const moved = moveAside(join(dir, 'meta.json'));
  writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { meta, from, moved, ...(season ? { season } : {}) };
}

/**
 * summary.json が壊れていれば（あるのに読めない）、出来事の記録の最後の要約（run_ended か expedition_ended の summary）から作り直す。
 * 要約の出来事が無ければ、壊れた元を残して消すだけ（まだ遠征を終えていないランと同じ）。何もしなければ null
 */
export function repairSummary(dir: string, catalog: Catalog): { rebuilt: boolean; moved: string | null } | null {
  const p = join(dir, 'summary.json');
  const r = readJsonStable<RunSummary>(p, (v) => !!v && typeof v === 'object' && Array.isArray((v as RunSummary).players));
  // 壊れているときだけ作り直す（無い・一時的に読めないときは触らない。§36.1 の 2）
  if (!('broken' in r)) return null;
  const events = readJsonl<GameEvent>(join(dir, 'events.jsonl'));
  let at = -1;
  for (let i = events.length - 1; i >= 0; i--) { const t = events[i].type; if (t === 'run_ended' || t === 'expedition_ended') { at = i; break; } }
  const moved = moveAside(p);
  moveAside(join(dir, 'summary.md'));
  if (at < 0) return { rebuilt: false, moved };
  const ev = events[at] as Extract<GameEvent, { type: 'run_ended' | 'expedition_ended' }>;
  writeFileAtomic(p, JSON.stringify(ev.summary, null, 2));
  writeFileAtomic(join(dir, 'summary.md'), summaryMarkdown(ev.summary, events.slice(0, at + 1), catalog));
  return { rebuilt: true, moved };
}

/** tokens.json を読む（再開用のトークン。ほかの記録から作り直せない）。無い・読めない・形が違う、を分ける */
export function readTokensStrict(dir: string): { tokens: Record<string, string> } | { error: 'missing' | 'broken' | 'unreadable' } {
  const r = readJsonStable<Record<string, string>>(join(dir, 'tokens.json'), (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'string'));
  if ('value' in r) return { tokens: r.value };
  return { error: 'missing' in r ? 'missing' : 'unreadable' in r ? 'unreadable' : 'broken' };
}

/**
 * 追記するファイル（events.jsonl・commands.jsonl）の最後の欠けた行を切る（復旧するランだけ。この後にまた追記する）。
 * 読むときは欠けた行を飛ばす（readJsonl）が、ファイルに残したまま次を追記すると、次の 1 行が欠けた行とつながって読めなくなる。
 * 切った分は `<名前>.broken-tail` に足して残す。最後の行が読めるのに改行だけ欠けていれば、改行を足す。何もしなければ null
 */
export function repairJsonlTail(path: string): { cut: number } | { newline: true } | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (!size) return null;
  const buf = readFileSync(path);
  if (buf[buf.length - 1] === 0x0a) {
    // 改行で終わっていても、最後の行が空のバイトだけ（落ちて中身が届かなかった追記）なら切る
    const prevNl = buf.lastIndexOf(0x0a, buf.length - 2);
    const last = buf.subarray(prevNl + 1, buf.length - 1);
    if (!last.length || last.some((b) => b !== 0)) return null;
    appendFileSync(`${path}.broken-tail`, last);
    truncateSync(path, prevNl + 1);
    return { cut: last.length + 1 };
  }
  const nl = buf.lastIndexOf(0x0a);
  const tail = buf.subarray(nl + 1);
  const text = tail.toString('utf8').replace(/^\0+/, '');
  try {
    JSON.parse(text);
    appendFileSync(path, '\n');
    return { newline: true };
  } catch {
    appendFileSync(`${path}.broken-tail`, tail);
    truncateSync(path, nl + 1);
    return { cut: tail.length };
  }
}

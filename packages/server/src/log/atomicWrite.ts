// 上書きするファイルの書き方（SEASON.md §33.1 の 1・§36.1）: 一時のファイルに書いて、ディスクまで書き切ってから（fsync）、名前を替える。
// 書いている最中にプロセスや機械が落ちても、前の中身か新しい中身のどちらかが残る（空のバイトや書きかけを残さない）。
// - 一時のファイルの名前はプロセスと回数ごとに分ける（サーバーと運用の道具が同じファイルを同時に書いても、互いの一時のファイルを壊さない）
// - Windows では、名前を替える先のファイルをほかのプログラムが開いていると、名前の付け替えが EPERM・EACCES・EBUSY で断られる。
//   合わせて 100 ミリ秒まで待ってやり直し、それでも替えられなければ、その場はあきらめる（サーバー全体を長く止めない。§36.1 の 5）。
//   サーバーの中の書き込みは、書けなかった中身を覚えておき、次の書き込みのときと閉じるときにやり直す（`writeFileAtomicLogged`）
// 追記するファイル（events.jsonl・commands.jsonl・log.jsonl）は、ここを通さない（`fsyncFile` で、キーフレームと管理ファイルより先に書き切る）
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/** 名前の付け替えを、やり直す間隔（ミリ秒。合わせて 90 ミリ秒。Windows の時計の刻みを入れて 100 ミリ秒ほど） */
export const RENAME_RETRY_MS = [15, 30, 45] as const;
/** 一時的に読めない（ほかのプログラムが開いている）ファイルを読み直す間隔（ミリ秒。合わせて 90 ミリ秒。Windows の時計の刻みを入れて 100 ミリ秒ほど） */
export const READ_RETRY_MS = [15, 30, 45] as const;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * テストの差し込み口: beforeRename は一時のファイルを書き切った後、名前を替える前に呼ばれる（例外を投げると、そこで落ちた形になる）。
 * rename は名前の付け替え（やり直しのテストで、断る形に差し替える）。read はファイルを読む所（一時的に読めない形を作る）
 */
export const atomicWriteHooks: {
  beforeRename: ((tmp: string, path: string) => void) | null;
  rename: (from: string, to: string) => void;
  read: (path: string) => string;
} = {
  beforeRename: null,
  rename: (from, to) => renameSync(from, to),
  read: (path) => readFileSync(path, 'utf8'),
};

let tmpCount = 0;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 書き切ってから名前を替える。替えられなければ、一時のファイルを消して例外を投げる（前の中身は残る） */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${++tmpCount}.tmp`;
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeFileSync(fd, data, 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    // 書く・書き切るのに失敗した一時のファイルも消す（§36.1 の 6）
    try { rmSync(tmp, { force: true }); } catch { /* 消せなくてもよい（起動時に掃除する） */ }
    throw e;
  }
  atomicWriteHooks.beforeRename?.(tmp, path);
  for (let i = 0; ; i++) {
    try {
      atomicWriteHooks.rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRY_CODES.has(code) || i >= RENAME_RETRY_MS.length) {
        try { rmSync(tmp, { force: true }); } catch { /* 消せなくてもよい（起動時に掃除する） */ }
        throw e;
      }
      sleepSync(RENAME_RETRY_MS[i]);
    }
  }
}

/** 書けなかった中身（同じファイルは新しいほう）。次の書き込みのときと、閉じるときにやり直す（§36.1 の 3・5） */
const pending = new Map<string, string>();

/** 書けなかった中身をやり直す（置き場所が消えていれば捨てる）。残った数 */
export function retryPendingWrites(warn: (msg: string) => void = (m) => console.error(m)): number {
  for (const [path, data] of [...pending]) {
    if (!existsSync(dirname(path))) { pending.delete(path); continue; }
    try {
      writeFileAtomic(path, data);
      pending.delete(path);
      warn(`[write] ${path} を、前に書けなかった分から書き直した`);
    } catch { /* 次にまた試す */ }
  }
  return pending.size;
}

/** まだ書けていない中身の数（テスト用） */
export function pendingWrites(): number {
  return pending.size;
}

/** まだ書けていない中身を捨てる（テスト用: 書けないまま機械が止まった形を作る） */
export function dropPendingWrites(): void {
  pending.clear();
}

/**
 * サーバーの中の書き込み（命令の確定の途中から呼ばれる）: 失敗しても例外を投げずに知らせて false。前の中身は残り、書けなかった中身は覚えておいて、
 * 次の書き込みのときと閉じるときにやり直す。記録（meta.json・要約・キーフレーム）は、起動し直したときに、ほかの記録からも作り直せる
 */
export function writeFileAtomicLogged(path: string, data: string, warn: (msg: string) => void = (m) => console.error(m)): boolean {
  pending.delete(path);
  if (pending.size) retryPendingWrites(warn);
  try {
    writeFileAtomic(path, data);
    return true;
  } catch (e) {
    pending.set(path, data);
    warn(`[write] ${path} を書けなかった（前の中身のまま。次に書くときと閉じるときにまた試す）: ${String((e as Error).message ?? e).split('\n')[0]}`);
    return false;
  }
}

/** 追記するファイルを、ディスクまで書き切る（キーフレームと管理ファイルを書く前に。§36.1 の 1）。無ければ何もしない */
export function fsyncFile(path: string): void {
  if (!existsSync(path)) return;
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export type StableRead = { text: string } | { missing: true } | { unreadable: string };

/**
 * ファイルを読む（§36.1 の 2）: 無ければ missing。ほかのプログラムが開いていて一時的に読めなければ、合わせて 100 ミリ秒まで待って読み直し、
 * それでも読めなければ unreadable（壊れているとは見ない）。頭の BOM は外す
 */
export function readFileStable(path: string): StableRead {
  for (let i = 0; ; i++) {
    try {
      const text = atomicWriteHooks.read(path);
      return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT') return { missing: true };
      if (!RETRY_CODES.has(code) || i >= READ_RETRY_MS.length) return { unreadable: code || String((e as Error).message ?? e).split('\n')[0] };
      sleepSync(READ_RETRY_MS[i]);
    }
  }
}

/** JSON を読む: 無い・一時的に読めない・壊れている（JSON として、または shape で形として読めない）・読めた、を分ける */
export function readJsonStable<T>(path: string, shape: (v: unknown) => boolean = () => true): { value: T } | { missing: true } | { unreadable: string } | { broken: true } {
  const r = readFileStable(path);
  if (!('text' in r)) return r;
  try {
    const v: unknown = JSON.parse(r.text);
    return shape(v) ? { value: v as T } : { broken: true };
  } catch {
    return { broken: true };
  }
}

/** 一時のファイルの名前（`<名前>.<pid>.<回数>.tmp`）から、書いたプロセスの番号。古い形（`<名前>.tmp`）は 0 */
export function tmpWriterPid(name: string): number | null {
  const m = /\.(\d+)\.\d+\.tmp$/.exec(name);
  if (m) return parseInt(m[1], 10);
  return /\.tmp$/.test(name) ? 0 : null;
}

/** そのプロセスが動いているか */
export function processAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * 残っている一時のファイルを消す（§36.1 の 6）。置き場所の直下と、その下のフォルダ（ランの記録・キーフレーム・シーズン）を見る。
 * 書いたプロセスが動いているもの（運用の道具が書いている最中のもの・自分のもの）は消さない。消した数
 */
export function sweepTmpFiles(roots: readonly (string | null | undefined)[]): number {
  let n = 0;
  const visit = (d: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const f of names) {
      const p = join(d, f);
      const pid = tmpWriterPid(f);
      if (pid !== null) {
        if (pid && processAlive(pid)) continue;
        try { if (statSync(p).isFile()) { rmSync(p, { force: true }); n++; } } catch { /* 消せなくてもよい */ }
        continue;
      }
      if (depth > 0) { try { if (statSync(p).isDirectory()) visit(p, depth - 1); } catch { /* 読めないフォルダは飛ばす */ } }
    }
  };
  for (const r of new Set(roots.filter((x): x is string => !!x))) if (existsSync(r)) visit(r, 2);
  return n;
}

/** 記録の置き場所の印の名前（`.` で始まるので、ランの並び（`run_…`）と間違えない） */
export const RUNS_LOCK = '.server.lock';

interface LockBody { pid: number; startedAt: number }

/**
 * 印を取る（§36.1 の 6）。生きている別のプロセスの印があれば busy。古い印（プロセスがもう居ない・機械の起動より前に置かれた）は掃除して取る（stale）
 */
export function acquireLock(path: string): { ok: true; stale?: LockBody } | { busy: LockBody } {
  const body: LockBody = { pid: process.pid, startedAt: Date.now() };
  let stale: LockBody | undefined;
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify(body)); fsyncSync(fd); } finally { closeSync(fd); }
      return stale ? { ok: true, stale } : { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const r = readJsonStable<LockBody>(path, (v) => !!v && typeof v === 'object' && typeof (v as LockBody).pid === 'number');
      const cur = 'value' in r ? r.value : null;
      const bootAt = Date.now() - uptime() * 1000;
      if (cur && cur.pid !== process.pid && processAlive(cur.pid) && !(cur.startedAt < bootAt)) return { busy: cur };
      stale = cur ?? { pid: 0, startedAt: 0 };
      try { rmSync(path, { force: true }); } catch { /* 次の試みで、また EEXIST になれば busy と見ない */ }
    }
  }
  throw new Error(`印 ${path} を取れなかった`);
}

/** 印を外す（自分のものだけ） */
export function releaseLock(path: string): void {
  const r = readJsonStable<LockBody>(path);
  if ('value' in r && r.value.pid === process.pid) { try { rmSync(path, { force: true }); } catch { /* 次の起動で古い印として掃除される */ } }
}

/** 文の中の絶対のパスを、記録の置き場所からの相対にする（§36.1 の 6。利用者の名前を含むパスを外に出さない）。ほかの絶対のパスはファイルの名前だけ */
export function scrubPaths(text: string, base: string | null | undefined): string {
  let out = text;
  if (base) {
    const b = resolve(base);
    for (const v of new Set([b, b.replace(/\\/g, '/'), b.replace(/\//g, '\\')])) out = out.split(v + sep).join('').split(v + '/').join('').split(v + '\\').join('').split(v).join('.');
  }
  return out.replace(/(?:\b[A-Za-z]:[\\/]|(?<=^|[\s'"(（])\/)(?:[^\\/\s'"`:]+[\\/])*([^\\/\s'"`:]+)/g, '$1');
}

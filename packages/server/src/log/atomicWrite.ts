// 上書きするファイルの書き方（SEASON.md §33.1 の 1）: 一時のファイルに書いて、ディスクまで書き切ってから（fsync）、名前を替える。
// 書いている最中にプロセスや機械が落ちても、前の中身か新しい中身のどちらかが残る（空のバイトや書きかけを残さない）。
// - 一時のファイルの名前はプロセスと回数ごとに分ける（サーバーと運用の道具が同じファイルを同時に書いても、互いの一時のファイルを壊さない）
// - Windows では、名前を替える先のファイルをほかのプログラムが開いていると、名前の付け替えが EPERM・EACCES・EBUSY で断られる。少し待ってやり直す
// 追記するファイル（events.jsonl・commands.jsonl・log.jsonl）は、ここを通さない（復旧が欠けた最後の行を切る。RunStore の repairJsonlTail）
import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';

/** 名前の付け替えを、やり直す間隔（ミリ秒。合わせて 1 秒ほど） */
export const RENAME_RETRY_MS = [10, 20, 40, 80, 160, 320, 400] as const;
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * テストの差し込み口: beforeRename は一時のファイルを書き切った後、名前を替える前に呼ばれる（例外を投げると、そこで落ちた形になる）。
 * rename は名前の付け替え（やり直しのテストで、断る形に差し替える）
 */
export const atomicWriteHooks: { beforeRename: ((tmp: string, path: string) => void) | null; rename: (from: string, to: string) => void } = {
  beforeRename: null,
  rename: (from, to) => renameSync(from, to),
};

let tmpCount = 0;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 書き切ってから名前を替える。やり直しても名前を替えられなければ、一時のファイルを消して例外を投げる（前の中身は残る） */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${++tmpCount}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  atomicWriteHooks.beforeRename?.(tmp, path);
  for (let i = 0; ; i++) {
    try {
      atomicWriteHooks.rename(tmp, path);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!RETRY_CODES.has(code) || i >= RENAME_RETRY_MS.length) {
        try { rmSync(tmp, { force: true }); } catch { /* 消せなくてもよい（.tmp は読まない） */ }
        throw e;
      }
      sleepSync(RENAME_RETRY_MS[i]);
    }
  }
}

/**
 * サーバーの中の書き込み（命令の確定の途中から呼ばれる）: 失敗しても例外を投げずに知らせて false。前の中身は残り、次の書き込みでまた試す。
 * 記録（meta.json・要約・キーフレーム）は、起動し直したときに、ほかの記録から作り直せる
 */
export function writeFileAtomicLogged(path: string, data: string, warn: (msg: string) => void = (m) => console.error(m)): boolean {
  try {
    writeFileAtomic(path, data);
    return true;
  } catch (e) {
    warn(`[write] ${path} を書けなかった（前の中身のまま。次に書くときにまた試す）: ${String((e as Error).message ?? e).split('\n')[0]}`);
    return false;
  }
}

/** 読んだ中身が、書き込みが落ちた形（空・空のバイトだけ）か */
export function looksTorn(text: string): boolean {
  return !text.replace(/[\0\s]/g, '').length;
}

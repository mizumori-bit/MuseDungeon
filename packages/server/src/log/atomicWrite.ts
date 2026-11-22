// 上書きするファイルの書き方（SEASON.md §33.1 の 1・§36.1）: 一時のファイルに書いて、ディスクまで書き切ってから（fsync）、名前を替える。
// 書いている最中にプロセスや機械が落ちても、前の中身か新しい中身のどちらかが残る（空のバイトや書きかけを残さない）。
// - 一時のファイルの名前はプロセスと回数ごとに分ける（サーバーと運用の道具が同じファイルを同時に書いても、互いの一時のファイルを壊さない）
// - Windows では、名前を替える先のファイルをほかのプログラムが開いていると、名前の付け替えが EPERM・EACCES・EBUSY で断られる。
//   合わせて 100 ミリ秒まで待ってやり直し、それでも替えられなければ、その場はあきらめる（サーバー全体を長く止めない。§36.1 の 5）。
//   サーバーの中の書き込みは、書けなかった中身を覚えておき、次の書き込みのときと閉じるときにやり直す（`writeFileAtomicLogged`）
// 追記するファイル（events.jsonl・commands.jsonl・log.jsonl）は、ここを通さない（`fsyncFile` で、キーフレームと管理ファイルより先に書き切る）
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
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

/** やり直しの間隔の下限（ミリ秒。§38.2 の 3: 1 つのファイルが開かれたままでも、すべての書き込みが遅くならないように） */
export const PENDING_RETRY_GAP_MS = 2000;
let lastRetryAt = 0;

/** 書けなかった中身をやり直す（置き場所が消えていれば捨てる）。force でなければ、前のやり直しから間隔の下限が過ぎたときだけ。残った数 */
export function retryPendingWrites(warn: (msg: string) => void = (m) => console.error(m), force = true): number {
  if (!pending.size) return 0;
  if (!force && Date.now() - lastRetryAt < PENDING_RETRY_GAP_MS) return pending.size;
  lastRetryAt = Date.now();
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
 * サーバーの中の書き込み（命令の確定の途中から呼ばれる）: 失敗しても例外を投げずに知らせて false。前の中身は残る。
 * remember なら、書けなかった中身を覚えておいて、後の書き込みのとき（間隔の下限つき）と閉じるときにやり直す（ランの記録だけ。§38.2 の 3:
 * シーズンとプロフィールは、覚えた古い中身を書く前の検査を通さずに書き戻すと、ほかのプロセスが書いた新しい中身を上書きしうるので、覚えない。次の書き込みが新しい中身で書く）
 */
export function writeFileAtomicLogged(path: string, data: string, opts: { remember?: boolean; warn?: (msg: string) => void } = {}): boolean {
  const warn = opts.warn ?? ((m: string) => console.error(m));
  pending.delete(path);
  if (pending.size) retryPendingWrites(warn, false);
  try {
    writeFileAtomic(path, data);
    return true;
  } catch (e) {
    // 覚えたら、やり直しは間隔の下限が過ぎてから（すぐ次の書き込みで、同じ待ちをくり返さない）
    if (opts.remember) { pending.set(path, data); lastRetryAt = Date.now(); }
    warn(`[write] ${path} を書けなかった（前の中身のまま。${opts.remember ? '次に書くときと閉じるときにまた試す' : '次の書き込みで新しい中身を書く'}）: ${String((e as Error).message ?? e).split('\n')[0]}`);
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

/** 一時のファイルの名前（`<名前>.<pid>.<回数>.tmp`）から、書いたプロセスの番号。今の書き方の名前でなければ null（古い形の `<名前>.tmp` は、だれが書いたか分からないので消さない。§38.2 の 5） */
export function tmpWriterPid(name: string): number | null {
  const m = /\.(\d+)\.\d+\.tmp$/.exec(name);
  return m ? parseInt(m[1], 10) : null;
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
        if (processAlive(pid)) continue;
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

export interface LockBody { pid: number; startedAt: number; port?: number; host?: string; listening?: boolean; nonce?: string }

/** 起動して待ち受けを始めるまでの猶予（ミリ秒）。この間は、印のプロセスが生きていれば、待ち受けていなくても使っているものと見る */
export const LOCK_STARTUP_GRACE_MS = 10 * 60_000;

/** そのポートで、だれかが待ち受けているか（TCP でつないでみる） */
export function portAnswers(host: string | undefined, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((res) => {
    const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    const sock = netConnect({ host: h, port });
    const done = (v: boolean) => { sock.destroy(); res(v); };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** そのホストとポートで、試しに待ち受けられるか（すぐ閉じる）。待ち受けられなければ、その理由のコード */
function tryListen(host: string, port: number): Promise<string | null> {
  return new Promise((res) => {
    const srv = createNetServer();
    srv.once('error', (e: NodeJS.ErrnoException) => res(e.code ?? String(e.message)));
    srv.listen({ host, port, exclusive: true }, () => srv.close(() => res(null)));
  });
}

/**
 * サーバーを起動する前に、待ち受けるホストとポートが空いているか（SEASON.md §40.2 の 5: 印を持たない前の版のサーバーが同じ置き場所で動いていると、
 * 復旧を最後まで走らせてから、ポートの重なりで止まっていた）。それぞれのホストで試しに待ち受けてすぐ閉じ、ほかのプロセスが待ち受けていないかも
 * つないで確かめる（Windows では、ほかのプロセスがすべてのアドレスで待ち受けていても、決まったアドレスでは待ち受けられることがある）。
 * 空いていれば null、空いていなければ理由の文
 */
export async function portInUse(hosts: readonly string[], port: number, probe: (host: string | undefined, port: number) => Promise<boolean> = portAnswers): Promise<string | null> {
  for (const h of hosts) {
    const code = await tryListen(h, port);
    if (code) return `${h}:${port} で待ち受けられない（${code}${code === 'EADDRINUSE' ? '。ほかのプロセスが使っている' : ''}）`;
    if (await probe(h, port)) return `${h}:${port} で、ほかのプロセスが待ち受けている`;
  }
  return null;
}

/**
 * 印を取る（§36.1 の 6・§38.2 の 4）。印にはプロセスの番号・起動の時刻・ポートを書く。
 * - 生きている別のプロセスの印で、まだ待ち受けていない（起動の途中。猶予の内）か、そのポートで待ち受けが応えるなら busy
 * - プロセスがもう居ない・プロセスは居るがポートが応えない（番号の使い回し・高速スタートアップで起動からの時間が戻らない）・機械の起動より前の印は、古い印として掃除して取る（stale）
 * - 古い印は消さずに、名前を替えて移す（`<印>.stale.<pid>.<値>`。SEASON.md §40.2 の 4）。移せたほうだけが新しい印を作る。移したものが、読んだ古い印と
 *   同じ中身でなければ（読んでから移すまでの間に、同時に起動したほかのサーバーが古い印を片付けて自分の印を作った）、元に戻して busy。
 *   前は消していたので、2 つが同じ古い印を読むと、遅れたほうが、先に取ったほうの新しい印を消して、両方が起動しえた
 * - 作った後に少し待って読み直し、自分のものでなくなっていれば（同時に起動した別のサーバーが取った）busy（2 つとも起動しない形を防ぐ）
 * - 印を作れない・読めない・取り直せないときは error（説明つき）
 */
export async function acquireLock(path: string, me: { port?: number; host?: string } = {}, probe: (host: string | undefined, port: number) => Promise<boolean> = portAnswers): Promise<{ ok: true; stale?: LockBody } | { busy: LockBody } | { error: string }> {
  const body: LockBody = { pid: process.pid, startedAt: Date.now(), ...(me.port ? { port: me.port } : {}), ...(me.host ? { host: me.host } : {}), listening: false, nonce: randomBytes(6).toString('hex') };
  let stale: LockBody | undefined;
  for (let i = 0; i < 3; i++) {
    try {
      const fd = openSync(path, 'wx');
      try { writeFileSync(fd, JSON.stringify(body)); fsyncSync(fd); } finally { closeSync(fd); }
      await sleep(100);
      const again = readJsonStable<LockBody>(path);
      if (!('value' in again) || again.value.pid !== process.pid || again.value.nonce !== body.nonce) {
        return 'value' in again ? { busy: again.value } : { error: `印 ${path} を取った後に読めなくなった（同時に起動したサーバーがある？）` };
      }
      return stale ? { ok: true, stale } : { ok: true };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return { error: `印 ${path} を作れない（${code ?? String((e as Error).message ?? e)}）` };
      const raw = readFileStable(path);
      if ('missing' in raw) continue; // 読む前に、ほかのサーバーが片付けた: もう一度作ってみる
      if ('unreadable' in raw) return { error: `印 ${path} を一時的に読めない（${raw.unreadable}）。少し待って起動し直す` };
      let cur: LockBody | null = null;
      try {
        const v = JSON.parse(raw.text) as unknown;
        if (!!v && typeof v === 'object' && typeof (v as LockBody).pid === 'number' && typeof (v as LockBody).startedAt === 'number') cur = v as LockBody;
      } catch { /* 書きかけ・壊れた印 */ }
      if (!cur) {
        // 書きかけの印（同時に起動したサーバーが作った直後）かもしれない: 新しいものは古い印と見ない
        let young = false;
        try { young = Date.now() - statSync(path).mtimeMs < 10_000; } catch { /* 消えていれば次の試みで作る */ }
        if (young) return { error: `印 ${path} が書きかけ（同時に起動したサーバーがある？）。少し待って起動し直す` };
      } else if (cur.pid !== process.pid && processAlive(cur.pid) && !(cur.startedAt < Date.now() - uptime() * 1000)) {
        if (!cur.listening && Date.now() - cur.startedAt < LOCK_STARTUP_GRACE_MS) return { busy: cur };
        if (cur.port && await probe(cur.host, cur.port)) return { busy: cur };
      }
      // 古い印は、消さずに名前を替えて移す（§40.2 の 4）。移せたほうだけが進む
      const aside = `${path}.stale.${process.pid}.${body.nonce}`;
      try { renameSync(path, aside); } catch (e2) {
        const c2 = (e2 as NodeJS.ErrnoException).code ?? '';
        if (c2 === 'ENOENT') continue; // ほかのサーバーが先に移した: その印を読み直す
        return { error: `古い印 ${path} を移せない（${c2}）` };
      }
      // 移したものが、読んだ古い印か（読んでから移すまでの間に、ほかのサーバーが古い印を片付けて、自分の印を作っていないか）
      const movedRaw = readFileStable(aside);
      if (!('text' in movedRaw) || movedRaw.text !== raw.text) {
        let taken: LockBody | null = null;
        if ('text' in movedRaw) { try { taken = JSON.parse(movedRaw.text) as LockBody; } catch { /* 読めなくても戻す */ } }
        // 元に戻す（その間に、また別の印が作られていれば、そちらを残す）
        try { if (!existsSync(path)) renameSync(aside, path); else rmSync(aside, { force: true }); } catch { /* 戻せなくても、そのサーバーの読み直しで分かる */ }
        return taken && typeof taken.pid === 'number' ? { busy: taken } : { error: `印 ${path} を移している間に、ほかのサーバーが印を作った。少し待って起動し直す` };
      }
      try { rmSync(aside, { force: true }); } catch { /* 残っても読まれない（印の名前と違う） */ }
      stale = cur ?? { pid: 0, startedAt: 0 };
    }
  }
  return { error: `印 ${path} を取り直せなかった（同時に起動したサーバーがある？）。少し待って起動し直す` };
}

/** 待ち受けを始めたことを印に書く（自分の印だけ） */
export function markLockListening(path: string): void {
  const r = readJsonStable<LockBody>(path);
  if ('value' in r && r.value.pid === process.pid) { try { writeFileAtomic(path, JSON.stringify({ ...r.value, listening: true })); } catch { /* 書けなくても、起動の猶予が過ぎれば、ポートで確かめられる */ } }
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

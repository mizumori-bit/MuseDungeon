#!/usr/bin/env node
// ダブルクリックで遊ぶための起動（ルートの MuseDungeon.cmd から呼ぶ。`node packages/server/bin/muse-launch.mjs` でも同じ）。
// 依存の無い Node だけで動く（npm install の前にも動くように）。
//  1. Node.js 22 以上か確かめる
//  2. 依存のパッケージが無い・古ければ入れる（npm ci。初回はネットにつなぐ）
//  3. サーバーがもう動いていれば、ブラウザを開くだけ
//  4. 画面が古ければ組み立てる（npm run build）
//  5. サーバーを起動し、起動を待ってブラウザを開く。このウィンドウを閉じるとサーバーも止まる
// 環境変数: MUSE_PORT・MUSE_HOST・MUSE_RUNS_DIR（サーバーと同じ）、MUSE_NO_BROWSER=1（ブラウザを開かない）
/* global console, process, fetch, setTimeout, AbortSignal */
import { exec, spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const host = process.env.MUSE_HOST ?? '127.0.0.1';
const port = Number(process.env.MUSE_PORT ?? '7777');
const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
const base = `http://${browserHost}:${port}`;
const win = process.platform === 'win32';
const say = (s) => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) {
  console.error(`\n[MuseDungeon] ${msg}`);
  process.exit(1);
}

/** npm を実行する（Windows の npm.cmd はシェル経由でしか起動できない） */
function npm(args) {
  const r = spawnSync(`npm ${args}`, { cwd: root, stdio: 'inherit', shell: true });
  return r.status === 0;
}

async function healthy() {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const j = await r.json();
    return j?.ok === true;
  } catch {
    return false;
  }
}

/** その口を何かが使っているか（MuseDungeon でないものが使っていれば、起動できない） */
function portBusy() {
  return new Promise((done) => {
    const s = net.connect({ host: browserHost, port });
    s.once('connect', () => { s.destroy(); done(true); });
    s.once('error', () => done(false));
    s.setTimeout(1000, () => { s.destroy(); done(false); });
  });
}

/**
 * ブラウザで開く。開く命令が終わるまで待つ（待たずに終わると、ウィンドウと一緒に開く命令も消され、ブラウザが開かない）
 */
function openBrowser(url) {
  // MUSE_NO_BROWSER=1 なら開かない（確かめ用・自分で開きたいとき）
  if (process.env.MUSE_NO_BROWSER === '1') { say(`（ブラウザは開きません: ${url}）`); return Promise.resolve(); }
  const cmd = win ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  return new Promise((done) => {
    exec(cmd, (e) => {
      if (e) say(`ブラウザを開けませんでした。${url} を開いてください。`);
      done();
    });
  });
}

/** ディレクトリの中で最も新しいファイルの時刻 */
function newest(p) {
  if (!existsSync(p)) return 0;
  const st = statSync(p);
  if (!st.isDirectory()) return st.mtimeMs;
  let m = 0;
  for (const name of readdirSync(p)) m = Math.max(m, newest(join(p, name)));
  return m;
}

// 1. Node.js の版
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node.js 22 以上が要ります（いまは ${process.versions.node}）。https://nodejs.org/ から入れ直してください。`);

say('MuseDungeon を起動します。');

// 2. 依存のパッケージ（無い、または package-lock.json の方が新しい）
const lock = join(root, 'package-lock.json');
const installed = join(root, 'node_modules', '.package-lock.json');
const needInstall = !existsSync(installed) || (existsSync(lock) && statSync(lock).mtimeMs > statSync(installed).mtimeMs + 1000);

// 3. もう動いていれば開くだけ（依存を入れ直すと動いているサーバーを壊すので、先に見る）
if (await healthy()) {
  say(`サーバーはもう動いています。ブラウザで ${base}/ を開きます。`);
  await openBrowser(`${base}/`);
  say('このウィンドウは数秒で閉じます（サーバーは、先に起動したほうのウィンドウや、AI のつなぐ口が動かしています）。');
  await sleep(4000);
  process.exit(0);
}
if (await portBusy()) fail(`口 ${port} を別のプログラムが使っています。そのプログラムを止めるか、環境変数 MUSE_PORT で別の口を指定してください。`);

if (needInstall) {
  say('依存のパッケージを入れます（初回と、更新の後だけ。ネットにつなぎます。数分かかることがあります）。');
  if (!npm('ci')) fail('依存のパッケージを入れられませんでした。上のメッセージを確かめてください。');
}

// 4. 画面（packages/client/dist）が無いか、元のファイルの方が新しければ組み立てる
const dist = join(root, 'packages', 'client', 'dist', 'index.html');
const sources = ['packages/client/src', 'packages/client/public', 'packages/client/index.html', 'packages/client/vite.config.ts', 'packages/client/package.json', 'packages/shared/src']
  .map((p) => newest(join(root, p)));
if (!existsSync(dist) || Math.max(...sources) > statSync(dist).mtimeMs) {
  say('画面を組み立てます。');
  if (!npm('run build')) fail('画面を組み立てられませんでした。上のメッセージを確かめてください。');
}

// 5. サーバーを起動する（ログはこのウィンドウに出る）
say('サーバーを起動します。');
const child = spawn(process.execPath, [join(root, 'packages', 'server', 'bin', 'muse-server.mjs')], { cwd: root, stdio: 'inherit', env: process.env });
child.on('exit', (code) => {
  if (code) console.error(`\n[MuseDungeon] サーバーが止まりました（終了コード ${code}）。`);
  process.exit(code ?? 0);
});
for (let i = 0; i < 120 && !(await healthy()); i++) await sleep(500);
if (!(await healthy())) {
  child.kill();
  fail('サーバーが起動しませんでした。上のメッセージを確かめてください。');
}
say('');
say(`遊ぶ・観戦する: ${base}/`);
say(`AI（MCP）の接続先: ${base}/mcp`);
say('このウィンドウを閉じると、サーバーが止まります。');
say('');
await openBrowser(`${base}/`);

/* global console, process, URL */
// 音のテーマの試聴ページ用の、読むだけの小さなサーバー。
// 使い方: node docs/sound-audition/serve.mjs  →  http://localhost:7790/
// ゲームのサーバー・クライアントとは関係がない。リポジトリの中のファイルを GET で返すだけ。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const port = Number(process.env.PORT ?? 7790);
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

http.createServer((req, res) => {
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/docs/sound-audition/index.html';
  const file = path.resolve(root, '.' + p);
  const allowed = [path.join(root, 'docs', 'sound-audition'), path.join(root, 'packages', 'client', 'public', 'themes')];
  if (!allowed.some((a) => file.startsWith(a + path.sep))) { res.writeHead(404).end('not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`sound audition: http://localhost:${port}/`));

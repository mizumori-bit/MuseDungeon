// サーバーと同じ機械からの接続か（S3。SEASON.md §25.1・PROTOCOL.md §9.7: 開催中のシーズンのランを、運用者が観戦できる）。
// 今は認証が無いので、接続元のアドレスで見分ける。プロキシの印（X-Forwarded-For など）があれば、外からの接続として扱う。
// トンネルが見出しを足さずに中継すると、外からの接続も同じに見える（公開するときは、認証と一緒に見直す。SEASON.md §25.1）。
import type { IncomingMessage } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLocalRequest(req: IncomingMessage): boolean {
  const h = req.headers;
  if (h['x-forwarded-for'] !== undefined || h['forwarded'] !== undefined || h['x-real-ip'] !== undefined) return false;
  return LOOPBACK.has(req.socket.remoteAddress ?? '');
}

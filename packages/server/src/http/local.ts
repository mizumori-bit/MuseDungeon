// サーバーと同じ機械からの接続か（S3。SEASON.md §25.1・PROTOCOL.md §9.7: 開催中のシーズンのランを、運用者が観戦できる）。
// 今は認証が無いので、接続元のアドレスで見分ける。
// - 直の接続元が自分の機械でなければ、外。
// - 直の接続元が自分の機械で、プロキシの見出し（X-Forwarded-For・Forwarded・X-Real-IP）があれば、そこに書かれた接続元がすべて自分の機械のときだけ、同じ機械（S3a §27.9 の 5:
//   client の開発用のサーバーの proxy は、接続元を X-Forwarded-For で伝える）。外から直に来た者が見出しを偽っても、直の接続元で外と分かる。
// トンネルが見出しを足さずに中継すると、外からの接続も同じに見える（公開するときは、認証と一緒に見直す。SEASON.md §25.1）。
// LAN や Tailscale のアドレスで開くと、自分の機械からでも外の扱いになる（README）。
import type { IncomingMessage } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);

function addr(raw: string): string {
  let a = raw.trim().replace(/^"|"$/g, '');
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') >= 0 ? a.indexOf(']') : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  return a.toLowerCase();
}

export function isLocalRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  const h = req.headers;
  const seen: string[] = [];
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);
  const xff = one(h['x-forwarded-for']);
  if (xff !== undefined) seen.push(...xff.split(','));
  const xri = one(h['x-real-ip']);
  if (xri !== undefined) seen.push(xri);
  const fwd = one(h['forwarded']);
  if (fwd !== undefined) {
    const fors = [...fwd.matchAll(/for=("[^"]*"|[^;,\s]+)/gi)].map((m) => m[1]);
    // for= の無い Forwarded は、接続元が分からないので外
    if (!fors.length) return false;
    seen.push(...fors);
  }
  return seen.every((x) => LOOPBACK.has(addr(x)));
}

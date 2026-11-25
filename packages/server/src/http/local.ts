// サーバーと同じ機械からの接続か（S3。SEASON.md §25.1・PROTOCOL.md §9.7: 開催中のシーズンのランを、運用者が観戦できる）。
// 今は認証が無いので、接続元のアドレスで見分ける。
// - 直の接続元が自分の機械でなければ、外。
// - 直の接続元が自分の機械で、プロキシの見出し（X-Forwarded-For・Forwarded・X-Real-IP）があれば、そこに書かれた接続元がすべて自分の機械のときだけ、同じ機械（S3a §27.9 の 5:
//   client の開発用のサーバーの proxy は、接続元を X-Forwarded-For で伝える）。外から直に来た者が見出しを偽っても、直の接続元で外と分かる。
// トンネルが見出しを足さずに中継すると、外からの接続も同じに見える（公開するときは、認証と一緒に見直す。SEASON.md §25.1）。
// LAN や Tailscale のアドレスで開くと、自分の機械からでも外の扱いになる（README）。
// S8a（SEASON.md §55.6。同じ機械のブラウザで開いた別のページからの書き換え・DNS の付け替えを止める）: 接続元のほかに、
// - `Host` の見出しが、許しの一覧（127.0.0.1・localhost・[::1] と、MUSE_HOST に書いたアドレス。どれも、受けたポートつき）にあること。
// - `Origin` の見出しがあれば、その origin が要求の `Host` と同じ（http・ホストとポートが一致）こと。`Origin: null` は認めない。`Origin` の無い要求（道具・MCP のクライアント）は今までどおり。
// 観戦（WS の upgrade を含む）・巻き戻し・順位の表の full・持ち主の口の、どれもこの関数で見る。
import type { IncomingMessage } from 'node:http';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1', 'localhost']);
/** Host の見出しで認める名前（受けたポートつき）。MUSE_HOST のアドレスは allowLocalHosts で足す */
const LOCAL_HOST_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);
const extraHosts = new Set<string>();

/** 「同じ機械」と認める Host の名前を足す（S8a: サーバーの待ち受けのアドレス = MUSE_HOST。カンマで区切って複数。0.0.0.0・:: は足さない） */
export function allowLocalHosts(hosts: readonly string[]): void {
  for (const h of hosts) {
    const a = h.trim().replace(/^\[|\]$/g, '').toLowerCase();
    if (a && a !== '0.0.0.0' && a !== '::') extraHosts.add(a);
  }
}

/** Host・Origin の「ホスト:ポート」を分ける（"[::1]:7777"・"127.0.0.1:7777"・"localhost"。ポートが無ければ 80） */
function hostPort(raw: string): { name: string; port: number } | null {
  const s = raw.trim().toLowerCase();
  const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(s) ?? /^([^:[\]]+)(?::(\d+))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? parseInt(m[2], 10) : 80;
  return Number.isFinite(port) ? { name: m[1], port } : null;
}

/** Host の見出しが、許しの一覧の名前で、受けたポートと同じか（DNS の付け替えを止める） */
function hostAllowed(req: IncomingMessage): boolean {
  const h = req.headers.host;
  const p = typeof h === 'string' ? hostPort(h) : null;
  if (!p) return false;
  const local = req.socket.localPort;
  if (local !== undefined && p.port !== local) return false;
  return LOCAL_HOST_NAMES.has(p.name) || extraHosts.has(p.name);
}

/**
 * 要求の Origin が、要求の Host と同じ origin か（S8a）。Origin が無ければ true（道具・MCP のクライアント・同じ origin の GET）。
 * `null`・http でないもの・形の崩れたもの・Host と違うものは false
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const o = req.headers.origin;
  if (o === undefined) return true;
  if (typeof o !== 'string' || o === 'null') return false;
  let u: URL;
  try { u = new URL(o); } catch { return false; }
  if (u.protocol !== 'http:' || u.pathname !== '/' || u.username || u.password) return false;
  const a = hostPort(u.host);
  const b = typeof req.headers.host === 'string' ? hostPort(req.headers.host) : null;
  return !!a && !!b && a.name === b.name && a.port === b.port;
}

/** 本文が JSON か（S8a: 状態を変える口は application/json だけ。ブラウザは事前の問い合わせを出し、CORS の見出しが無いので本体を送らない） */
export function jsonContentType(req: IncomingMessage): boolean {
  const ct = req.headers['content-type'];
  return typeof ct === 'string' && ct.split(';')[0].trim().toLowerCase() === 'application/json';
}

function addr(raw: string): string {
  let a = raw.trim().replace(/^"|"$/g, '');
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') >= 0 ? a.indexOf(']') : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  return a.toLowerCase();
}

export function isLocalRequest(req: IncomingMessage): boolean {
  if (!LOOPBACK.has(req.socket.remoteAddress ?? '')) return false;
  // S8a: Host が許しの一覧に無い（DNS の付け替え）・Origin が別の origin（別のページから）なら、同じ機械と認めない
  if (!hostAllowed(req) || !sameOrigin(req)) return false;
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

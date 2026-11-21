// MCP Streamable HTTP（/mcp）。MCP セッションごとに McpServer を 1 つ作り、プレイヤー束縛を保持する。
// 使われていないセッションは掃除する（S0b。SEASON.md §7.9）: セッションの終わり（DELETE）を送らないクライアントでも、セッションと McpServer が残り続けないように。
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../session/SessionManager';
import { createMcpServer } from './server';
import type { McpContext } from './server';

interface McpSession {
  transport: StreamableHTTPServerTransport;
  /** createMcpServer に渡した文脈（boundToken: このセッションに束縛したプレイヤー） */
  ctx: McpContext;
  /** 最後に要求が始まった・終わった時刻 */
  last: number;
  /** 処理中の要求と、開いたままの受信の流れ（GET の SSE）の数 */
  active: number;
}

export class McpHttpHandler {
  private readonly sessions = new Map<string, McpSession>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly manager: SessionManager, private readonly now: () => number = Date.now) {
    const every = Math.max(1000, Math.min(60_000, Math.trunc(Math.min(this.limits().unbound, this.limits().bound) / 4)));
    this.sweeper = setInterval(() => this.sweep(), every);
    this.sweeper.unref?.();
  }

  private limits(): { unbound: number; bound: number } {
    const c = this.manager.config;
    return { unbound: c.mcpIdleMs ?? 30 * 60_000, bound: c.mcpBoundIdleMs ?? 6 * 3600_000 };
  }

  /** 今あるセッションの数（テスト・診断用） */
  get sessionCount(): number { return this.sessions.size; }

  /** セッションごとの使われ方（テスト・診断用。トークンは出さない） */
  sessionInfo(): { id: string; active: number; bound: boolean; last: number }[] {
    return [...this.sessions].map(([id, s]) => ({ id, active: s.active, bound: !!s.ctx.boundToken, last: s.last }));
  }

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    const s = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!s) {
      const init = Array.isArray(body) ? body.find((m) => isInitializeRequest(m)) : isInitializeRequest(body) ? body : undefined;
      if (req.method !== 'POST' || !init) {
        // 知らない（掃除した）セッション: MCP の決まりどおり 404。クライアントは新しい initialize でつなぎ直す
        res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Unknown MCP session' : 'No MCP session: send initialize first' }, id: null }));
        return;
      }
      const clientName = (init as { params?: { clientInfo?: { name?: string } } }).params?.clientInfo?.name ?? 'mcp-client';
      const ctx: McpContext = { manager: this.manager, boundToken: null, briefMap: true, clientLabel: clientName.slice(0, 64) };
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { this.sessions.set(id, { transport: t, ctx, last: this.now(), active: 0 }); },
      });
      t.onclose = () => { if (t.sessionId) this.sessions.delete(t.sessionId); };
      const server = createMcpServer(ctx);
      await server.connect(t);
      await t.handleRequest(req, res, body);
      const made = t.sessionId ? this.sessions.get(t.sessionId) : undefined;
      if (made) made.last = this.now();
      return;
    }
    // 使っている間（処理中の要求・開いたままの GET の流れ）は掃除しない。終わった時刻から数える
    s.active++;
    s.last = this.now();
    let done = false;
    res.on('close', () => {
      if (done) return;
      done = true;
      s.active = Math.max(0, s.active - 1);
      s.last = this.now();
    });
    await s.transport.handleRequest(req, res, body);
  }

  /**
   * 使われていないセッションを閉じる（1 分ごと。テストからも呼ぶ）。閉じた数を返す。
   * 処理中の要求も開いたままの受信の流れも無く、束縛していなければ mcpIdleMs、束縛していれば mcpBoundIdleMs、だれも使っていないもの
   */
  sweep(now = this.now()): number {
    const lim = this.limits();
    let n = 0;
    for (const [id, s] of [...this.sessions]) {
      if (s.active > 0) continue;
      if (now - s.last < (s.ctx.boundToken ? lim.bound : lim.unbound)) continue;
      this.sessions.delete(id);
      void s.transport.close().catch(() => undefined);
      n++;
    }
    return n;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweeper);
    for (const s of this.sessions.values()) await s.transport.close().catch(() => undefined);
    this.sessions.clear();
  }
}

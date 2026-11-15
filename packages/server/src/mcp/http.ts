// MCP Streamable HTTP（/mcp）。MCP セッションごとに McpServer を 1 つ作り、プレイヤー束縛を保持する。
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { SessionManager } from '../session/SessionManager';
import { createMcpServer } from './server';

export class McpHttpHandler {
  private readonly transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(private readonly manager: SessionManager) {}

  async handle(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const sid = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sid) ? sid[0] : sid;
    let transport = sessionId ? this.transports.get(sessionId) : undefined;
    if (!transport) {
      const init = Array.isArray(body) ? body.find((m) => isInitializeRequest(m)) : isInitializeRequest(body) ? body : undefined;
      if (req.method !== 'POST' || !init) {
        res.writeHead(sessionId ? 404 : 400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: sessionId ? 'Unknown MCP session' : 'No MCP session: send initialize first' }, id: null }));
        return;
      }
      const clientName = (init as { params?: { clientInfo?: { name?: string } } }).params?.clientInfo?.name ?? 'mcp-client';
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { this.transports.set(id, t); },
      });
      t.onclose = () => { if (t.sessionId) this.transports.delete(t.sessionId); };
      const server = createMcpServer({ manager: this.manager, boundToken: null, briefMap: true, clientLabel: clientName.slice(0, 64) });
      await server.connect(t);
      transport = t;
    }
    await transport.handleRequest(req, res, body);
  }

  async closeAll(): Promise<void> {
    for (const t of this.transports.values()) await t.close().catch(() => undefined);
    this.transports.clear();
  }
}

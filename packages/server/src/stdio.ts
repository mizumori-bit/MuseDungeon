// muse-mcp-stdio: stdio しか話せない MCP クライアント向けの薄いブリッジ。
// ゲーム状態は持たず、常駐サーバーの /mcp へ JSON-RPC を中継するだけ。サーバーが無ければ起動する。
// stdout は MCP の通信路なので、ログは stderr にのみ出す。
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.env.MUSE_URL ?? `http://${process.env.MUSE_HOST ?? '127.0.0.1'}:${process.env.MUSE_PORT ?? '7777'}`;
const log = (...a: unknown[]) => process.stderr.write(`[muse-mcp-stdio] ${a.map(String).join(' ')}\n`);

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer(): Promise<void> {
  if (await healthy()) return;
  const launcher = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'muse-server.mjs');
  log('server not running; starting', launcher);
  const child = spawn(process.execPath, [launcher], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await healthy()) return;
  }
  throw new Error(`server did not start at ${base}`);
}

async function main(): Promise<void> {
  await ensureServer();
  const upstream = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  const downstream = new StdioServerTransport();
  downstream.onmessage = (msg) => {
    upstream.send(msg).catch((e) => log('upstream send failed:', (e as Error).message));
  };
  upstream.onmessage = (msg) => {
    downstream.send(msg).catch((e) => log('downstream send failed:', (e as Error).message));
  };
  upstream.onerror = (e) => log('upstream error:', e.message);
  downstream.onclose = () => { void upstream.close().finally(() => process.exit(0)); };
  upstream.onclose = () => log('upstream closed');
  await upstream.start();
  await downstream.start();
  log(`bridging stdio <-> ${base}/mcp`);
}

main().catch((e) => {
  log('fatal:', (e as Error).message);
  process.exit(1);
});

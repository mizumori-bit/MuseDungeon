// muse-server（常駐）: HTTP + WebSocket + MCP（Streamable HTTP /mcp）。既定で 127.0.0.1:7777。
import { loadContent } from '@muse/content';
import { validateContentHandlers } from '@muse/engine';
import { loadConfig } from './config';
import { createApp } from './http/api';
import { SessionManager } from './session/SessionManager';

const config = loadConfig();
const content = loadContent();
const errs = validateContentHandlers(content);
if (errs.length) {
  console.error('content handler errors:\n' + errs.join('\n'));
  process.exit(1);
}
const manager = new SessionManager(content, config);
manager.recoverAll((m) => console.log(`[recover] ${m}`));
const app = createApp(manager, config);
app.server.listen(config.port, config.host, () => {
  const base = `http://${config.host}:${config.port}`;
  console.log(`MuseDungeon server  ${base}`);
  console.log(`  Web client        ${base}/`);
  console.log(`  MCP (HTTP)        ${base}/mcp`);
  console.log(`  MCP (stdio)       node packages/server/bin/muse-mcp-stdio.mjs`);
  console.log(`  content ${content.version}  runs dir ${config.runsDir ?? '(disabled)'}  spectatorPolicy ${config.spectatorPolicy}`);
});
const shutdown = () => { void app.close().finally(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

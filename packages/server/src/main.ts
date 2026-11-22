// muse-server（常駐）: HTTP + WebSocket + MCP（Streamable HTTP /mcp）。既定で 127.0.0.1:7777。
// MUSE_HOST はカンマで区切って複数書ける（例 127.0.0.1,100.x.x.x: この PC の中と Tailscale からだけ受け付ける）。
// 2 つ目からの待ち受けは、届いた要求をそのまま最初のサーバーへ渡す（同じ状態・同じ WebSocket）
import { createServer, type Server } from 'node:http';
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
// 同じ記録の置き場所で、サーバーを 2 つ動かさない（SEASON.md §36.1 の 6）: 復旧を始める前に印を取る。生きている別のサーバーの印があれば止まる
const busy = await manager.acquireRunsLock((m) => console.log(`[lock] ${m}`));
if (busy) {
  console.error(`[lock] ${busy}`);
  process.exit(1);
}
process.on('exit', () => manager.releaseRunsLock());
manager.recoverAll((m) => console.log(`[recover] ${m}`));
// 版の違う開いているシーズン（S1a）: 新しいランを始められないので、はっきり知らせる
for (const w of manager.seasons.versionWarnings()) console.warn(`[season] 警告: ${w}`);
const app = createApp(manager, config);
const hosts = config.host.split(',').map((h) => h.trim()).filter(Boolean);
const extras: Server[] = [];
const listenErr = (host: string) => (e: Error) => {
  console.error(`cannot listen on ${host}:${config.port}: ${e.message}`);
  process.exit(1);
};
app.server.on('error', listenErr(hosts[0]));
app.server.listen(config.port, hosts[0], () => {
  // 待ち受けを始めたことを印に書く（SEASON.md §38.2 の 4）
  manager.markRunsLockListening();
  for (const h of hosts) {
    const base = `http://${h}:${config.port}`;
    console.log(`MuseDungeon server  ${base}`);
    console.log(`  Web client        ${base}/`);
    console.log(`  MCP (HTTP)        ${base}/mcp`);
  }
  console.log(`  MCP (stdio)       node packages/server/bin/muse-mcp-stdio.mjs`);
  console.log(`  content ${content.version}  runs dir ${config.runsDir ?? '(disabled)'}  spectatorPolicy ${config.spectatorPolicy}`);
});
for (const h of hosts.slice(1)) {
  const extra = createServer();
  extra.on('request', (req, res) => app.server.emit('request', req, res));
  extra.on('upgrade', (req, socket, head) => app.server.emit('upgrade', req, socket, head));
  extra.on('error', listenErr(h));
  extra.listen(config.port, h);
  extras.push(extra);
}
const shutdown = () => {
  for (const s of extras) s.close();
  void app.close().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

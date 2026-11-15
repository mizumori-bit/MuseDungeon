import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadContent } from '@muse/content';
import type { Command, GameEvent, PlayerView, ServerMsg, World } from '@muse/shared';
import { applyEvent, buildObservation, canonicalHash, emptyWorld, stripSecret } from '@muse/shared';
import { createApp, createMcpServer, loadConfig, RunSession, SessionManager } from '../src/index';
import type { App } from '../src/index';

const content = loadContent();
let runsDir: string;

beforeAll(() => { runsDir = mkdtempSync(join(tmpdir(), 'muse-test-')); });
afterAll(() => { rmSync(runsDir, { recursive: true, force: true }); });

async function mcpClient(manager: SessionManager) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ manager, boundToken: null, briefMap: true, clientLabel: 'test' });
  await server.connect(a);
  const client = new Client({ name: 'contract-test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;
  return { client, call };
}

const ALL_TOOLS = ['get_rules', 'list_runs', 'new_run', 'join_run', 'resume_run', 'retire', 'observe', 'look', 'get_map', 'inventory', 'recall',
  'get_messages', 'notes', 'move', 'wait', 'rest', 'explore', 'travel_to', 'pickup', 'drop', 'equip', 'unequip', 'use_item', 'throw_item',
  'interact', 'use_stairs', 'say'];

describe('MCP contract', () => {
  it('exposes all PROTOCOL tools with schemas', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 200 }));
    const { client } = await mcpClient(manager);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
    for (const t of tools) expect(t.inputSchema.type).toBe('object');
  });

  it('plays: new_run → actions → errors, with text + structuredContent', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 200 }));
    const { call } = await mcpClient(manager);
    const noSession = await call('observe');
    expect(noSession.structuredContent.error.code).toBe('no_session');
    const rules = await call('get_rules', { topic: 'combat' });
    expect(rules.content[0].text).toContain('d20');
    const nr = await call('new_run', { character_name: 'Muse', class: 'warrior', seed: 'contract-seed-XYZ' });
    expect(nr.structuredContent.player_token).toBeTruthy();
    expect(JSON.stringify(nr)).not.toContain('contract-seed-XYZ');
    const obs = nr.structuredContent.observation;
    expect(obs.status).toBe('your_turn');
    expect(obs.valid_actions.length).toBeGreaterThan(0);
    for (const tool of ['observe', 'inventory', 'get_map', 'get_messages', 'notes']) {
      const r = await call(tool);
      expect(r.content[0].type).toBe('text');
      expect(r.structuredContent).toBeTruthy();
    }
    const look = await call('look', { target: obs.self.pos });
    expect(look.content[0].text.length).toBeGreaterThan(0);
    // 壁へ移動 → blocked（状態は変わらない）
    const seq = obs.seq;
    const blockedDir = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].find((d) => !obs.navigation.passable_dirs.includes(d));
    if (blockedDir) {
      const r = await call('move', { dir: blockedDir });
      expect(r.structuredContent.ok).toBe(false);
      expect(r.structuredContent.error.code).toBe('blocked');
      expect(r.structuredContent.valid_actions.length).toBeGreaterThan(0);
      expect((await call('observe')).structuredContent.observation.seq).toBe(seq);
    }
    // stale turn
    await call('wait');
    const stale = await call('wait', { expect_seq: seq });
    expect(stale.structuredContent.error.code).toBe('stale_turn');
    // マクロ
    const ex = await call('explore', { thought: 'test thought' });
    expect(ex.structuredContent.ok).toBe(true);
    expect(typeof ex.structuredContent.steps).toBe('number');
    const bad = await call('use_item', { slot: 'z' });
    expect(bad.structuredContent.error.code).toBe('no_such_item');
    const notes = await call('notes', { add: 'remember the fountain' });
    expect(notes.structuredContent.notes).toContain('remember the fountain');
    const recall = await call('recall', { kind_name: 'ゴブリン' });
    expect(recall.content[0].text).toBeTruthy();
    // resume_run で別接続に再束縛
    const other = await mcpClient(manager);
    const resumed = await other.call('resume_run', { player_token: nr.structuredContent.player_token });
    expect(resumed.structuredContent.player_id).toBe(nr.structuredContent.player_id);
    const badResume = await other.call('resume_run', { player_token: 'nope' });
    expect(badResume.structuredContent.error.code).toBe('no_session');
    const ret = await call('retire', { confirm: true });
    expect(ret.structuredContent.ok).toBe(true);
    const after = await call('wait');
    expect(after.structuredContent.error.code).toBe('run_ended');
  });
});

describe('logs, recovery, determinism', () => {
  it('re-executing commands.jsonl reproduces events.jsonl; recovery matches the live world', async () => {
    const config = loadConfig({ runsDir, waitOthersMs: 200, keyframeEvery: 100 });
    const manager = new SessionManager(content, config);
    const r = await manager.createRun({ name: 'Rec', seed: 'recover-1', controller: { kind: 'agent', label: 't' } });
    if ('error' in r) throw new Error(r.error.message);
    for (let i = 0; i < 40; i++) {
      const out = await r.port.act({ type: i % 7 === 0 ? 'rest' : 'explore' }, { source: 'mcp' });
      if (!out.ok || r.port.view().status !== 'your_turn') break;
    }
    const liveHash = canonicalHash(r.session.world);
    expect(canonicalHash(r.session.foldHistory())).toBe(liveHash);
    const rec = RunSession.recover({ content, catalog: manager.catalog, config }, r.session.runId);
    expect(rec.verified).toBe(true);
    expect(canonicalHash(rec.session.world)).toBe(liveHash);
    rec.session.close();
    manager.closeAll();
  });
});

describe('two players in one run (coop)', () => {
  it('both bots can act in the same run without deadlock', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 300 }));
    const a = await manager.createRun({ name: 'A', mode: 'coop', seed: 'coop-1', controller: { kind: 'agent', label: 'a' } });
    if ('error' in a) throw new Error(a.error.message);
    const b = await manager.joinRun(a.session.runId, { name: 'B', classId: 'core:scout', controller: { kind: 'human', label: 'b' } });
    if ('error' in b) throw new Error(b.error.message);
    // 両者が規定回数（時間を進める行動）を終えるまで、手番が来たら行動し続ける（先に終わった側も待機で手番を回す）
    const counts = { a: 0, b: 0 };
    const target = 8;
    const drive = async (port: typeof a.port, key: 'a' | 'b') => {
      let lastExploreEmpty = false;
      for (let i = 0; i < 300 && (counts.a < target || counts.b < target); i++) {
        const v = port.view();
        if (v.status === 'dead' || v.status === 'ended') break;
        if (v.status !== 'your_turn') { await port.waitForTurn(500); continue; }
        const cmd: Command = lastExploreEmpty || counts[key] >= target ? { type: 'wait' } : { type: 'explore' };
        const r = await port.act(cmd, { source: 'bot', waitTurnMs: 300 });
        lastExploreEmpty = r.ok && cmd.type === 'explore' && (r.steps ?? 0) === 0;
        if (r.ok && !lastExploreEmpty) counts[key]++;
      }
    };
    await Promise.all([drive(a.port, 'a'), drive(b.port, 'b')]);
    expect(counts.a).toBeGreaterThanOrEqual(target);
    expect(counts.b).toBeGreaterThanOrEqual(target);
    const w = a.session.world;
    expect(w.playerOrder).toHaveLength(2);
    expect(canonicalHash(a.session.foldHistory())).toBe(canonicalHash(w));
    manager.closeAll();
  });
});

describe('HTTP + WebSocket', () => {
  let app: App;
  let base: string;
  beforeAll(async () => {
    const config = loadConfig({ runsDir: join(runsDir, 'http'), waitOthersMs: 300 });
    app = createApp(new SessionManager(content, config), config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await app.close(); });

  const wsMessages = (hello: object, until: (msgs: ServerMsg[]) => boolean) => new Promise<{ ws: WebSocket; msgs: ServerMsg[] }>((resolve, reject) => {
    const ws = new WebSocket(`ws://${base}/ws`);
    const msgs: ServerMsg[] = [];
    const timer = setTimeout(() => reject(new Error('ws timeout: ' + JSON.stringify(msgs.map((m) => m.t)))), 5000);
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('message', (d) => {
      msgs.push(JSON.parse(String(d)));
      if (until(msgs)) { clearTimeout(timer); resolve({ ws, msgs }); }
    });
    ws.on('error', reject);
  });

  it('human play over WS uses the same PlayerView as MCP (parity) and spectators fold to the same world', async () => {
    const res = await fetch(`http://${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Human', classId: 'core:scout' }) });
    const joined = await res.json() as { runId: string; token: string; playerId: string };
    expect(joined.token).toBeTruthy();
    const { ws, msgs } = await wsMessages({ t: 'hello', role: 'player', runId: joined.runId, token: joined.token }, (m) => m.some((x) => x.t === 'view'));
    const viewMsg = msgs.find((m) => m.t === 'view') as Extract<ServerMsg, { t: 'view' }>;
    const port = app.manager.portForToken(joined.token)!;
    expect(canonicalHash(viewMsg.view)).toBe(canonicalHash(port.view()));
    // MCP 側の観測も同じ PlayerView から作られる
    const mcpObs = port.observe({ detail: 'brief', map: true }).observation;
    const fromWs = buildObservation(viewMsg.view as PlayerView, app.manager.catalog, { detail: 'brief', map: true, recent: port.pending().slice(-10) });
    expect(canonicalHash(fromWs)).toBe(canonicalHash(mcpObs));
    // WS からコマンド（MCP と同じ Command スキーマ）
    const before = viewMsg.view.seq;
    const next = new Promise<Extract<ServerMsg, { t: 'view' }>>((resolve) => ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.t === 'view' && m.view.seq > before) resolve(m); }));
    ws.send(JSON.stringify({ t: 'command', command: { type: 'wait' } }));
    const v2 = await next;
    expect(v2.view.seq).toBeGreaterThan(before);
    ws.close();

    // 観戦（俯瞰）: snapshot + events を畳むと secret 除去済みのライブ World と一致
    const spec = await wsMessages({ t: 'hello', role: 'spectator', runId: joined.runId, mode: 'director' }, (m) => m.some((x) => x.t === 'snapshot'));
    const snap = spec.msgs.find((m) => m.t === 'snapshot') as Extract<ServerMsg, { t: 'snapshot' }>;
    expect(snap.world.secret.seed).toBe('');
    expect(Object.keys(snap.world.secret.rng)).toHaveLength(0);
    const w: World = snap.world;
    const got = new Promise<void>((resolve) => spec.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      if (m.t === 'events') { for (const e of m.events) applyEvent(w, e); resolve(); }
    }));
    await port.act({ type: 'wait' }, { source: 'ws' });
    await got;
    const live = stripSecret(app.manager.get(joined.runId)!.world);
    expect(canonicalHash({ ...w, secret: null })).toBe(canonicalHash({ ...live, secret: null }));
    spec.ws.close();

    // 観戦者は書き込めない
    // リプレイ API: 内部イベントと secret が出ない
    const evText = await (await fetch(`http://${base}/api/runs/${joined.runId}/events`)).text();
    const evs = evText.trim().split('\n').map((l) => JSON.parse(l) as GameEvent);
    expect(evs.some((e) => e.type === 'rng_advanced' && Object.keys(e.states).length > 0)).toBe(false);
    const started = evs.find((e) => e.type === 'run_started') as Extract<GameEvent, { type: 'run_started' }>;
    expect(started.secret?.seed).toBe('');
    const folded = emptyWorld();
    for (const e of evs) applyEvent(folded, e);
    expect(folded.seq).toBe(app.manager.get(joined.runId)!.world.seq);
    const kfs = await (await fetch(`http://${base}/api/runs/${joined.runId}/keyframes`)).json() as { keyframes: number[] };
    expect(kfs.keyframes.length).toBeGreaterThan(0);
    const kf = await (await fetch(`http://${base}/api/runs/${joined.runId}/keyframes/${kfs.keyframes[0]}`)).json() as World;
    expect(kf.secret.seed).toBe('');
    const index = await (await fetch(`http://${base}/api/runs/${joined.runId}/index`)).json() as { markers: { type: string }[] };
    expect(index.markers.some((m) => m.type === 'join')).toBe(true);
    const catalog = await (await fetch(`http://${base}/api/content/catalog`)).json() as Record<string, unknown>;
    expect(JSON.stringify(catalog)).not.toContain('"hp":');
  });

  it('MCP over Streamable HTTP works', async () => {
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'http-test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`)));
    const r = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Http' } })) as any;
    expect(r.structuredContent.observation.status).toBe('your_turn');
    const w = (await client.callTool({ name: 'wait', arguments: {} })) as any;
    expect(w.structuredContent.ok).toBe(true);
    await client.close();
  });
});

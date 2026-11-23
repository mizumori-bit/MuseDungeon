// S7（SEASON.md §52.1・§53）のテスト: 観戦の「思考」の欄の直前の命令（B）と、MCP の呼び出しの時間の控え（C）
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadContent } from '@muse/content';
import { createApp, createMcpServer, loadConfig, SessionManager } from '@muse/server';
import { commandBrief, INFO_TOOLS, stripTokenArgs } from '@muse/shared';

const content = loadContent();

function manager(): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}

async function mcpPair(m: SessionManager) {
  const [x, y] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
  await server.connect(x);
  const client = new Client({ name: 's7', version: '0' });
  await client.connect(y);
  return client;
}
type NewRun = { structuredContent: { run_id: string; player_token: string; profile_token?: string } };

describe('S7 §52.1 の 1: with no thought, the thought column shows the last command (tool and its arguments, never thought or tokens)', () => {
  it('the brief has the tool and its arguments; thought, tokens and display options never appear', () => {
    expect(commandBrief({ tool: 'explore', args: { toward: 'sense', thought: '気配へ', player_token: 'abcdefghijklmnopqrstuvwx', map: 'never' } })).toBe('explore { toward: "sense" }');
    expect(commandBrief({ tool: 'wait', args: {} })).toBe('wait');
    expect(commandBrief({ tool: 'fight', args: { target: 'e_abc123', hp_floor: 20, expect_seq: 9 } })).toBe('fight { target: "e_abc123", hp_floor: 20 }');
    expect(commandBrief({ tool: 'new_run', args: { character_name: 'A', profile_token: 'zzzzzzzzzzzzzzzzzzzzzzzz' } })).not.toContain('zzzz');
    expect(JSON.stringify(stripTokenArgs({ a: { player_token: 'x', my_token: 'y', ok: 1 }, b: ['secret-secret-secret-1'] }, ['secret-secret-secret-1']))).toBe('{"a":{"ok":1},"b":["••••"]}');
    expect(INFO_TOOLS.has('observe') && INFO_TOOLS.has('notes') && !INFO_TOOLS.has('explore')).toBe(true);
  });

  it('the activity log made by the server keeps no token at any depth, even when a token is passed under another name', async () => {
    const m = manager();
    const client = await mcpPair(m);
    const r = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Tok', objective: 'auto' } })) as unknown as NewRun;
    const { run_id, player_token, profile_token } = r.structuredContent;
    await client.callTool({ name: 'wait', arguments: { player_token, thought: '様子を見る' } });
    await client.callTool({ name: 'explore', arguments: { player_token } });
    await client.callTool({ name: 'observe', arguments: { player_token } });
    // 名前違いでトークンを渡した（知らない名前の引数は値を残さない）
    await client.callTool({ name: 'move', arguments: { player_token, dir: 'n', token: player_token } });
    const acts = m.get(run_id)!.agentActivity;
    expect(acts.length).toBeGreaterThanOrEqual(4);
    for (const a of acts) {
      const j = JSON.stringify(a);
      expect(j).not.toContain(player_token);
      if (profile_token) expect(j).not.toContain(profile_token);
      expect(Object.keys(a.args).some((k) => /token/i.test(k))).toBe(false);
      expect(commandBrief(a)).not.toContain('thought');
      expect(commandBrief(a)).not.toContain(player_token);
    }
    // 画面と同じ選び方: 照会でない、いちばん新しい呼び出し
    const last = [...acts].reverse().find((a) => !INFO_TOOLS.has(a.tool))!;
    expect(last.tool).toBe('move');
    expect(commandBrief(last).startsWith('move { dir: "n"')).toBe(true);
    expect(commandBrief(acts.find((a) => a.tool === 'explore')!)).toBe('explore');
    const wait = acts.find((a) => a.tool === 'wait')!;
    expect(wait.args.thought).toBe('様子を見る');
    expect(commandBrief(wait)).toBe('wait');
    await client.close();
    m.closeAll();
  });
});

describe('S7 §52.1 の 2: the server notes each MCP call (time received, tool, run, time taken) and logs long ones, without arguments', () => {
  it('keeps the last calls in memory; logs a long call with tool, run and seconds only; GET /api/ops/calls only from the same machine', async () => {
    const m = manager();
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
    try {
      m.calls.longMs = -1;
      const client = await mcpPair(m);
      const r = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Clock', objective: 'auto' } })) as unknown as NewRun;
      const { run_id, player_token } = r.structuredContent;
      await client.callTool({ name: 'wait', arguments: { player_token, thought: 'ひみつの考え' } });
      const list = m.calls.list();
      expect(list[0].tool).toBe('wait');
      expect(list[0].run).toBe(run_id);
      expect(list[0].ms).toBeGreaterThanOrEqual(0);
      expect(Number.isNaN(Date.parse(list[0].at))).toBe(false);
      expect(list.some((c) => c.tool === 'new_run')).toBe(true);
      const logged = lines.filter((l) => l.startsWith('[mcp] 長い呼び出し: '));
      expect(logged.length).toBeGreaterThanOrEqual(2);
      expect(logged.some((l) => l.includes(`wait run=${run_id}`))).toBe(true);
      for (const l of lines) { expect(l).not.toContain(player_token); expect(l).not.toContain('ひみつの考え'); }
      expect(JSON.stringify(list)).not.toContain(player_token);
      expect(JSON.stringify(list)).not.toContain('ひみつの考え');
      // ふつうの長さ（10 秒）では、ログに出さない
      m.calls.longMs = 10_000;
      lines.length = 0;
      await client.callTool({ name: 'observe', arguments: { player_token } });
      expect(lines.filter((l) => l.startsWith('[mcp]'))).toEqual([]);
      // 運用の口: 同じ機械からだけ
      const app = createApp(m, m.config);
      await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
      const port = (app.server.address() as AddressInfo).port;
      try {
        const ok = await fetch(`http://127.0.0.1:${port}/api/ops/calls?limit=2`);
        expect(ok.status).toBe(200);
        const body = (await ok.json()) as { calls: { tool: string }[]; long_ms: number };
        expect(body.calls.length).toBe(2);
        expect(body.calls[0].tool).toBe('observe');
        expect(JSON.stringify(body)).not.toContain(player_token);
        const far = await fetch(`http://127.0.0.1:${port}/api/ops/calls`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
        expect(far.status).toBe(403);
      } finally {
        await app.close();
        await client.close();
      }
    } finally {
      spy.mockRestore();
    }
  });

  it('a call that ends in an exception is noted and logged in one line, with the long-looking strings masked', () => {
    const out: string[] = [];
    const m = manager();
    const log = new (m.calls.constructor as new (a: number, b: number, c: (l: string) => void) => typeof m.calls)(10_000, 3, (l) => out.push(l));
    log.record({ at: '2026-11-23T00:00:00.000Z', tool: 'fight', run: 'run_x', ms: 5, error: true }, new Error('boom abcdefghijklmnopqrstuvwxyz0123\nstack'));
    expect(out).toEqual(['[mcp] 例外で終わった呼び出し: fight run=run_x 5 ms（受け取り 2026-11-23T00:00:00.000Z）: boom ••••']);
    for (let i = 0; i < 5; i++) log.record({ at: 'x', tool: `t${i}`, run: null, ms: 1 });
    expect(log.list().map((c) => c.tool)).toEqual(['t4', 't3', 't2']);
    m.closeAll();
  });
});

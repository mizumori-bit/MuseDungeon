// MCP アダプタ。ツールは PROTOCOL.md §2。プレイヤー向けの情報は PlayerPort 経由でしか得ない。
// 1 MCP 接続 = 1 プレイヤー（接続に束縛）。ステートレスなクライアント向けに全ツールが player_token も受け付ける。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ActionError, Command, Controller } from '@muse/shared';
import { actionError } from '@muse/shared';
import type { PlayerPort, ActionPayload } from '../session/PlayerPort';
import type { SessionManager } from '../session/SessionManager';
import { rulesText } from './rules';
import type { RulesTopic } from './rules';

export interface McpContext {
  manager: SessionManager;
  boundToken: string | null;
  briefMap: boolean;
  clientLabel: string;
}

const DirZ = z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
const PosZ = z.object({ x: z.number().int(), y: z.number().int() });
const SlotZ = z.string().regex(/^[a-z]$/).describe('所持品のスロット文字 a〜z / inventory slot letter');
const TargetZ = z.union([DirZ, PosZ, z.string().regex(/^e_[0-9a-z]{6}$/)]).describe('方向 | {x,y} | エンティティ ID');
const common = {
  player_token: z.string().optional().describe('ステートレス利用時のプレイヤートークン'),
};
const actionCommon = {
  ...common,
  thought: z.string().max(280).optional().describe('判断理由の短いメモ（観戦・リプレイに表示。裁定には使わない）'),
  expect_seq: z.number().int().optional().describe('前提とした observation の seq。進んでいれば stale_turn で拒否'),
};

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function out(text: string, structured: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured, ...(isError ? { isError: true } : {}) };
}

function errOut(error: ActionError, valid_actions: string[] = []): ToolResult {
  const text = `Error [${error.code}] ${error.message}${error.hint ? `\nHint: ${error.hint}` : ''}${valid_actions.length ? `\nActions: ${valid_actions.join(' / ')}` : ''}`;
  return out(text, { ok: false, error, valid_actions }, error.code === 'no_session' || error.code === 'bad_request');
}

function normClass(c?: string): string | undefined {
  if (!c) return undefined;
  return c.includes(':') ? c : `core:${c}`;
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'muse-dungeon', version: '0.1.0' },
    {
      instructions:
        'MuseDungeon: an AI-first roguelike. Start with get_rules, then new_run (or resume_run with your token). ' +
        'Each action tool returns the outcome and your next observation. Use explore / travel_to / rest macros to save calls. ' +
        'You only see what your character sees. 日本語の観測が既定（new_run の locale で en に切替）。',
    },
  );
  const { manager } = ctx;
  const waitMs = manager.config.waitOthersMs;

  const portOf = (token?: string): PlayerPort | null => {
    const tok = token ?? ctx.boundToken;
    return tok ? manager.portForToken(tok) : null;
  };
  const noSession = () => errOut(actionError('no_session', 'このMCP接続にはプレイヤーが束縛されていない / no player bound to this connection', 'new_run で始めるか、resume_run(player_token) で再開する / call new_run or resume_run'));

  const record = (port: PlayerPort, tool: string, args: Record<string, unknown>, text: string) => {
    const { player_token: _t, ...safe } = args;
    manager.recordActivity(port.runId, { playerId: port.playerId, seq: port.view().seq, tool, args: safe, text, wall: Date.now() });
  };

  const observeOut = (port: PlayerPort, extra: Record<string, unknown> = {}, prefix = '', detail: 'brief' | 'full' = 'brief') => {
    const o = port.observe({ detail, map: ctx.briefMap });
    return out(prefix + o.text, { ...extra, observation: o.observation });
  };

  const act = async (tool: string, args: Record<string, unknown>, cmd: Command) => {
    const port = portOf(args.player_token as string | undefined);
    if (!port) return noSession();
    const r: ActionPayload = await port.act(cmd, {
      source: 'mcp', thought: args.thought as string | undefined, expectSeq: args.expect_seq as number | undefined,
      waitTurnMs: waitMs, map: ctx.briefMap,
    });
    const text = port.formatActionText(r);
    record(port, tool, args, text);
    if (!r.ok) return errOut(r.error, r.valid_actions);
    return out(text, r as unknown as Record<string, unknown>);
  };

  // ---------------- セッション ----------------
  server.registerTool('get_rules', {
    title: 'ルールブック',
    description: 'ゲームのルール（式と操作方法）。個別のモンスター数値は含まない。Rules of the game.',
    inputSchema: { topic: z.enum(['overview', 'actions', 'combat', 'items', 'observation', 'all']).optional(), locale: z.enum(['ja', 'en']).optional() },
  }, async ({ topic, locale }) => {
    const text = rulesText((topic ?? 'all') as RulesTopic, locale ?? 'ja');
    return out(text, { topic: topic ?? 'all', text });
  });

  server.registerTool('list_runs', {
    title: 'ラン一覧',
    description: '参加可能・再開可能なラン一覧。List active / joinable runs.',
    inputSchema: {},
  }, async () => {
    const runs = manager.listRuns().filter((r) => r.status === 'active').map((r) => ({
      run_id: r.runId, mode: r.mode, joinable: r.joinable, seq: r.seq,
      players: r.players.map((p) => ({ name: p.name, class: p.classId, controller: p.controller.kind, state: p.state, depth: p.depth })),
    }));
    const text = runs.length ? runs.map((r) => `${r.run_id} [${r.mode}] ${r.joinable ? 'joinable' : 'full'} — ${r.players.map((p) => `${p.name}(${p.class}, ${p.state}, depth ${p.depth ?? '-'})`).join(', ')}`).join('\n') : 'No active runs. Use new_run.';
    return out(text, { runs });
  });

  const joinedOut = async (port: PlayerPort, token: string, runId: string, tool: string, args: Record<string, unknown>) => {
    ctx.boundToken = token;
    const o = port.observe({ detail: 'full', map: ctx.briefMap, consume: true });
    const head = `run_id: ${runId}\nplayer_token: ${token}\n(このトークンで resume_run できる / keep this token to resume)\n\n`;
    record(port, tool, args, o.text);
    return out(head + o.text, { run_id: runId, player_token: token, player_id: port.playerId, observation: o.observation });
  };

  server.registerTool('new_run', {
    title: '新しいラン',
    description: '新しいランを始めてこの接続にプレイヤーを束縛する。seed を指定しても結果には返さない。Start a new run.',
    inputSchema: {
      character_name: z.string().min(1).max(32),
      class: z.string().optional().describe('warrior | scout（既定 warrior）'),
      mode: z.enum(['solo', 'coop']).optional(),
      seed: z.string().max(64).optional(),
      locale: z.enum(['ja', 'en']).optional(),
      brief_map: z.boolean().optional().describe('行動結果に局所 ASCII 地図を付けるか（既定 true）'),
    },
  }, async (args) => {
    if (args.brief_map !== undefined) ctx.briefMap = args.brief_map;
    const controller: Controller = { kind: 'agent', label: ctx.clientLabel };
    const r = await manager.createRun({ name: args.character_name, classId: normClass(args.class), mode: args.mode, seed: args.seed, locale: args.locale, controller });
    if ('error' in r) return errOut(r.error);
    return joinedOut(r.port, r.token, r.session.runId, 'new_run', { ...args, seed: undefined });
  });

  server.registerTool('join_run', {
    title: 'ランに参加',
    description: '進行中の COOP ランに参加する。Join a coop run.',
    inputSchema: { run_id: z.string(), character_name: z.string().min(1).max(32), class: z.string().optional(), locale: z.enum(['ja', 'en']).optional() },
  }, async (args) => {
    const r = await manager.joinRun(args.run_id, { name: args.character_name, classId: normClass(args.class), locale: args.locale, controller: { kind: 'agent', label: ctx.clientLabel } });
    if ('error' in r) return errOut(r.error);
    return joinedOut(r.port, r.token, r.session.runId, 'join_run', args);
  });

  server.registerTool('resume_run', {
    title: 'ランを再開',
    description: 'プレイヤートークンで現在の接続にプレイヤーを再束縛する。Rebind your player by token.',
    inputSchema: { player_token: z.string() },
  }, async ({ player_token }) => {
    const port = manager.portForToken(player_token);
    if (!port) return errOut(actionError('no_session', 'そのトークンのランは見つからない / unknown token', 'new_run で新しく始める / start a new run'));
    ctx.boundToken = player_token;
    const o = port.observe({ detail: 'full', map: ctx.briefMap, consume: true });
    record(port, 'resume_run', {}, o.text);
    return out(o.text, { run_id: port.runId, player_id: port.playerId, observation: o.observation });
  });

  server.registerTool('retire', {
    title: '引退',
    description: 'ランを自主終了してスコアを記録する。End your run voluntarily.',
    inputSchema: { ...common, confirm: z.literal(true) },
  }, async (args) => act('retire', args, { type: 'retire' }));

  // ---------------- 情報照会（手番を消費しない） ----------------
  server.registerTool('observe', {
    title: '観測',
    description: '現在の観測。自分の手番でなければ手番が来るまで（最大 20 秒）待つ。Current observation.',
    inputSchema: { ...common, detail: z.enum(['brief', 'full']).optional() },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const v = port.view();
    if (v.status === 'waiting_others') await port.waitForTurn(waitMs);
    const r = observeOut(port, {}, '', args.detail ?? 'brief');
    record(port, 'observe', args, r.content[0].text);
    return r;
  });

  server.registerTool('look', {
    title: '調べる',
    description: '座標かエンティティ ID の説明。モンスターは「思い出」に基づく既知情報のみ。',
    inputSchema: { ...common, target: z.union([PosZ, z.string()]) },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.look(args.target);
    return out(r.text, { target: args.target, ...(r.data as Record<string, unknown>) });
  });

  server.registerTool('get_map', {
    title: '記憶地図',
    description: '記憶している現在フロアの ASCII 地図と凡例、既知の注目点。',
    inputSchema: { ...common, floor: z.number().int().optional().describe('深度（現在は現在フロアのみ）'), region: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1).max(80), h: z.number().int().min(1).max(60) }).optional() },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.map(args.region);
    return out(r.text, r.data as Record<string, unknown>);
  });

  server.registerTool('inventory', {
    title: '所持品',
    description: '所持品と装備の詳細。',
    inputSchema: { ...common },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.inventory();
    return out(r.text, r.data as Record<string, unknown>);
  });

  server.registerTool('recall', {
    title: '思い出',
    description: 'そのモンスター種について自キャラが学んだこと（遭遇数・撃破数・観測した最大ダメージ・見た能力）。',
    inputSchema: { ...common, kind_name: z.string().min(1) },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.recall(args.kind_name);
    return out(r.text, { result: r.data });
  });

  server.registerTool('get_messages', {
    title: 'メッセージログ',
    description: '自分が知覚した出来事の文章ログ。',
    inputSchema: { ...common, since_seq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.messages(args.since_seq, args.limit);
    return out(r.text, { messages: r.data });
  });

  server.registerTool('notes', {
    title: 'メモ',
    description: '自分用メモの読み書き（長時間プレイでの文脈喪失対策。ゲームに影響しない）。',
    inputSchema: { ...common, add: z.string().min(1).max(280).optional(), remove: z.number().int().nonnegative().optional() },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    if (args.add !== undefined || args.remove !== undefined) {
      const r = await port.act({ type: 'note', add: args.add, remove: args.remove }, { source: 'mcp' });
      if (!r.ok) return errOut(r.error, r.valid_actions);
    }
    const notes = port.view().notes;
    return out(notes.length ? notes.map((n, i) => `${i}: ${n}`).join('\n') : '(no notes)', { notes });
  });

  // ---------------- 行動（手番を消費する） ----------------
  server.registerTool('move', { title: '移動', description: '1 マス移動。敵がいれば攻撃、閉じた扉は開ける。', inputSchema: { ...actionCommon, dir: DirZ } },
    async (a) => act('move', a, { type: 'move', dir: a.dir }));
  server.registerTool('wait', { title: '待機', description: '1 手番待機。', inputSchema: { ...actionCommon } },
    async (a) => act('wait', a, { type: 'wait' }));
  server.registerTool('rest', { title: '休憩', description: 'マクロ: HP 全快か中断まで待機。', inputSchema: { ...actionCommon } },
    async (a) => act('rest', a, { type: 'rest' }));
  server.registerTool('explore', { title: '自動探索', description: 'マクロ: 既知地図上で最寄りの未探索へ進む（最大 200 手）。新しい敵・被弾・新アイテム/階段で停止。', inputSchema: { ...actionCommon } },
    async (a) => act('explore', a, { type: 'explore' }));
  server.registerTool('travel_to', {
    title: '移動（目的地）', description: 'マクロ: 既知地図上の経路で座標・階段・記憶した対象へ移動。',
    inputSchema: { ...actionCommon, to: z.union([PosZ, z.enum(['stairs_down', 'stairs_up']), z.string().regex(/^e_[0-9a-z]{6}$/)]) },
  }, async (a) => act('travel_to', a, { type: 'travel', to: a.to }));
  server.registerTool('pickup', { title: '拾う', description: '足元のアイテムを拾う（省略時は全て）。', inputSchema: { ...actionCommon, item: z.string().regex(/^e_[0-9a-z]{6}$/).optional() } },
    async (a) => act('pickup', a, { type: 'pickup', item: a.item }));
  server.registerTool('drop', { title: '置く', description: '所持品を足元に置く。', inputSchema: { ...actionCommon, slot: SlotZ, qty: z.number().int().positive().optional() } },
    async (a) => act('drop', a, { type: 'drop', slot: a.slot, qty: a.qty }));
  server.registerTool('equip', { title: '装備', description: '武器・防具を装備する。', inputSchema: { ...actionCommon, slot: SlotZ } },
    async (a) => act('equip', a, { type: 'equip', slot: a.slot }));
  server.registerTool('unequip', { title: '装備解除', description: '装備を外す（スロット文字か weapon/armor/accessory）。', inputSchema: { ...actionCommon, slot: z.union([SlotZ, z.enum(['weapon', 'armor', 'accessory'])]) } },
    async (a) => act('unequip', a, { type: 'unequip', slot: a.slot }));
  server.registerTool('use_item', { title: '使う', description: '薬を飲む・巻物を読む。', inputSchema: { ...actionCommon, slot: SlotZ, target: TargetZ.optional() } },
    async (a) => act('use_item', a, { type: 'use', slot: a.slot, target: a.target as never }));
  server.registerTool('throw_item', { title: '投げる', description: '対象（エンティティ ID・座標・方向）へ投げる。射線判定あり。', inputSchema: { ...actionCommon, slot: SlotZ, target: TargetZ } },
    async (a) => act('throw_item', a, { type: 'throw', slot: a.slot, target: a.target as never }));
  server.registerTool('interact', { title: '操作', description: '扉の開閉、泉・祭壇などの操作。dir 省略時は足元。', inputSchema: { ...actionCommon, dir: DirZ.optional() } },
    async (a) => act('interact', a, { type: 'interact', dir: a.dir }));
  server.registerTool('use_stairs', { title: '階段', description: '足元の階段を使う。', inputSchema: { ...actionCommon } },
    async (a) => act('use_stairs', a, { type: 'stairs' }));
  server.registerTool('say', { title: '発言', description: 'COOP 用チャット。手番を消費しない。', inputSchema: { ...common, text: z.string().min(1).max(280) } },
    async (a) => act('say', a, { type: 'say', text: a.text }));

  return server;
}

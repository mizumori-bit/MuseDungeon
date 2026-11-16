// MCP アダプタ。ツールは PROTOCOL.md §2。プレイヤー向けの情報は PlayerPort 経由でしか得ない。
// 1 MCP 接続 = 1 プレイヤー（接続に束縛）。ステートレスなクライアント向けに全ツールが player_token も受け付ける。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ActionError, Command, Controller, ObjectiveChoice, TurnBlock } from '@muse/shared';
import { actionError, CommandSchema, t } from '@muse/shared';
import type { PlayerPort, ActionPayload } from '../session/PlayerPort';
import type { SessionManager } from '../session/SessionManager';
import { rulesText, RULE_TOPICS } from './rules';
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
/** 応答テキストの表示オプション（ゲームには影響しない） */
const optionArgs = {
  map: z.enum(['auto', 'always', 'never']).optional().describe('地図: auto（変化があった応答だけ。既定）/ always / never'),
  inventory: z.enum(['on_change', 'always']).optional().describe('所持品の行: on_change（変わったときだけ。既定）/ always'),
  status_line: z.enum(['short', 'long']).optional().describe('末尾の ▶ 行: short（既定）/ long'),
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

/** エラー応答。プレイヤーが束縛されていれば turn ブロックと状態行を付ける */
function errOut(error: ActionError, valid_actions: string[] = [], turn?: { block: TurnBlock; line: string }): ToolResult {
  const text = `Error [${error.code}] ${error.message}${error.hint ? `\nHint: ${error.hint}` : ''}${valid_actions.length ? `\nActions: ${valid_actions.join(' / ')}` : ''}${turn ? `\n${turn.line}` : ''}`;
  return out(text, { ok: false, error, valid_actions, ...(turn ? { turn: turn.block } : {}) }, error.code === 'no_session' || error.code === 'bad_request');
}

/** 照会系の応答に turn（変化なし）と状態行を付ける */
function withTurn(port: PlayerPort, text: string, structured: Record<string, unknown>): ToolResult {
  const turn = port.turnBlock('observed');
  return out(`${text}\n${port.turnLine(turn)}`, { ...structured, turn });
}

function normClass(c?: string): string | undefined {
  if (!c) return undefined;
  return c.includes(':') ? c : `core:${c}`;
}

export function createMcpServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: 'muse-dungeon', version: '0.2.0' },
    {
      instructions:
        'MuseDungeon: an AI-first roguelike played in expeditions. Start with get_rules, then new_run (or resume_run with your token). ' +
        'An expedition ends by completing its objective and extracting on stairs, by withdrawing (extract with confirm), by death, or by retire. ' +
        'Every response carries a `turn` block: while turn.state is "your_turn" the game is waiting for your next action tool. ' +
        'turn.state "expedition_ended" / "at_camp" / "run_ended" (awaiting "nothing" or "camp_choice") are the only signals that it is fine to stop. ' +
        'Each action tool returns the outcome and your next observation. Use explore / travel_to / rest macros to save calls. ' +
        'You only see what your character sees. ' +
        '遠征は「目的を達成して階段の上で extract」「撤退（extract confirm）」「死亡」「引退」のいずれかで終わる。turn.state が your_turn の間はゲームがあなたの次の行動を待っている。日本語の観測が既定（new_run の locale で en に切替）。',
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

  const act = async (tool: string, args: Record<string, unknown>, cmd: Command) => {
    const port = portOf(args.player_token as string | undefined);
    if (!port) return noSession();
    // 引数の形が合わないときも、ゲームのエラー形式（code / hint / valid_actions / turn）で返す（V3-2R §14.7）
    const parsed = CommandSchema.safeParse(cmd);
    if (!parsed.success) {
      const L = port.locale();
      const where = parsed.error.issues.map((i) => i.path.join('.')).filter(Boolean).join(', ') || tool;
      const err = actionError('bad_request', t(L, `引数の形が正しくない: ${where}`, `Invalid argument: ${where}`), t(L,
        'target は方向（n ne e se s sw w nw）・座標 {"x":3,"y":4}・エンティティ ID（e_xxxxxx）のどれか。鑑定の巻物で対象を選ぶなら target_slot にスロット文字。slot は a〜z。',
        'target is a direction (n ne e se s sw w nw), a position {"x":3,"y":4} or an entity id (e_xxxxxx). To choose what an identify scroll identifies, pass target_slot (a slot letter). slot is a-z.'));
      const tb = port.turnBlock('action_rejected');
      const va = port.observe({ map: false }).observation.valid_actions;
      record(port, tool, args, `${err.code} ${err.message}`);
      return errOut(err, va, { block: tb, line: port.turnLine(tb) });
    }
    const r: ActionPayload = await port.act(cmd, {
      source: 'mcp', thought: args.thought as string | undefined, expectSeq: args.expect_seq as number | undefined,
      waitTurnMs: waitMs, map: ctx.briefMap,
    });
    const text = port.formatActionText(r);
    record(port, tool, args, text);
    if (!r.ok) return errOut(r.error, r.valid_actions, { block: r.turn, line: port.turnLine(r.turn) });
    return out(text, r as unknown as Record<string, unknown>);
  };

  // ---------------- セッション ----------------
  server.registerTool('get_rules', {
    title: 'ルールブック',
    description: 'ゲームのルール（式・操作・遠征・観測の読み方）。個別のモンスター数値は含まない。Rules of the game.',
    inputSchema: { topic: z.enum(RULE_TOPICS).optional(), locale: z.enum(['ja', 'en']).optional() },
  }, async ({ topic, locale }) => {
    const text = rulesText((topic ?? 'all') as RulesTopic, locale ?? 'ja', manager.catalog);
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

  /** new_run / resume_run の表示オプション（brief_map は旧引数: false → map: never） */
  const applyOptions = (port: PlayerPort, args: Record<string, unknown>) => {
    const map = (args.map as 'auto' | 'always' | 'never' | undefined) ?? (args.brief_map === false ? 'never' : undefined);
    port.setOptions({ map, inventory: args.inventory as 'on_change' | 'always' | undefined, status_line: args.status_line as 'short' | 'long' | undefined });
  };

  const joinedOut = async (port: PlayerPort, token: string, runId: string, tool: string, args: Record<string, unknown>, reason: 'run_started' | 'resumed') => {
    ctx.boundToken = token;
    applyOptions(port, args);
    const briefing = port.briefing(reason === 'resumed' ? 'resume' : 'start');
    const o = port.observeWithTurn(reason, { detail: 'full', consume: true });
    const head = `run_id: ${runId}\nplayer_token: ${token}\n(このトークンで resume_run できる / keep this token to resume)\n\n`;
    const text = head + (briefing.length ? briefing.join('\n') + '\n\n' : '') + o.text;
    record(port, tool, args, text);
    return out(text, { run_id: runId, player_token: token, player_id: port.playerId, briefing, observation: o.observation, turn: o.turn });
  };

  server.registerTool('new_run', {
    title: '新しいラン',
    description: '新しいランを始め、最初の遠征まで開始してこの接続にプレイヤーを束縛する。seed を指定しても結果には返さない。Start a new run and its first expedition.',
    inputSchema: {
      character_name: z.string().min(1).max(32),
      class: z.string().optional().describe('warrior | scout（既定 warrior）'),
      mode: z.enum(['solo', 'coop']).optional(),
      seed: z.string().max(64).optional(),
      locale: z.enum(['ja', 'en']).optional(),
      objective: z.enum(['auto', 'reach_depth', 'slay_guardian', 'retrieve_relic', 'endless']).optional().describe('最初の遠征の目的（既定 auto = 最初の候補。endless は目的なし）'),
      ...optionArgs,
      brief_map: z.boolean().optional().describe('旧引数。false は map: never と同じ'),
    },
  }, async (args) => {
    const controller: Controller = { kind: 'agent', label: ctx.clientLabel };
    const classId = normClass(args.class);
    if (classId && !manager.catalog.classes[classId]) {
      const list = Object.entries(manager.catalog.classes).map(([id, c]) => `${id.split(':')[1]}（${c.name.ja}）`).join(' / ');
      return errOut(actionError('bad_request', `不明な職業 ${args.class} / unknown class`, `class は ${list}。詳しくは get_rules topic=classes`));
    }
    const r = await manager.createRun({
      name: args.character_name, classId, mode: args.mode, seed: args.seed, locale: args.locale, controller,
      objective: args.objective as ObjectiveChoice | undefined,
    });
    if ('error' in r) return errOut(r.error);
    return joinedOut(r.port, r.token, r.session.runId, 'new_run', { ...args, seed: undefined }, 'run_started');
  });

  server.registerTool('join_run', {
    title: 'ランに参加',
    description: '進行中の COOP ランに参加する。Join a coop run.',
    inputSchema: { run_id: z.string(), character_name: z.string().min(1).max(32), class: z.string().optional(), locale: z.enum(['ja', 'en']).optional() },
  }, async (args) => {
    const r = await manager.joinRun(args.run_id, { name: args.character_name, classId: normClass(args.class), locale: args.locale, controller: { kind: 'agent', label: ctx.clientLabel } });
    if ('error' in r) return errOut(r.error);
    return joinedOut(r.port, r.token, r.session.runId, 'join_run', args, 'run_started');
  });

  server.registerTool('resume_run', {
    title: 'ランを再開',
    description: 'プレイヤートークンで現在の接続にプレイヤーを再束縛する。再開ブリーフィング（遠征の目的と進捗・現在地・直近の節目・メモ）が付く。Rebind your player by token.',
    inputSchema: { player_token: z.string(), ...optionArgs },
  }, async (args) => {
    const port = manager.portForToken(args.player_token);
    if (!port) return errOut(actionError('no_session', 'そのトークンのランは見つからない / unknown token', 'new_run で新しく始める / start a new run'));
    ctx.boundToken = args.player_token;
    applyOptions(port, args);
    const briefing = port.briefing('resume');
    const o = port.observeWithTurn('resumed', { detail: 'full', consume: true });
    const text = (briefing.length ? briefing.join('\n') + '\n\n' : '') + o.text;
    record(port, 'resume_run', {}, text);
    return out(text, { run_id: port.runId, player_id: port.playerId, briefing, observation: o.observation, turn: o.turn });
  });

  server.registerTool('retire', {
    title: '引退',
    description: 'ランを終了する。キャラクターは戻らない（このランはここで終わり、スコアが記録される）。遠征だけを終えたいときは階段の上で extract。End the run; the character does not come back.',
    inputSchema: { ...common, confirm: z.literal(true) },
  }, async (args) => act('retire', args, { type: 'retire' }));

  // ---------------- 遠征 ----------------
  server.registerTool('expedition', {
    title: '遠征',
    description: '現在の遠征の目的・達成条件・進捗。キャンプでは次の遠征の候補。手番を消費しない。Current expedition briefing / camp offers.',
    inputSchema: { ...common },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const lines = port.briefing('start');
    const o = port.observe({ detail: 'brief', map: false });
    return withTurn(port, lines.join('\n'), { briefing: lines, expedition: o.observation.expedition ?? null, camp: o.observation.camp ?? null });
  });
  server.registerTool('start_expedition', {
    title: '遠征を始める',
    description: 'キャンプで次の遠征を選んで始める（offer は候補の番号 1〜3 か "endless"）。前回 extract した階段から再開する。',
    inputSchema: { ...common, offer: z.union([z.number().int().min(1).max(9), z.literal('endless')]), thought: actionCommon.thought },
  }, async (a) => act('start_expedition', a, { type: 'start_expedition', offer: a.offer }));
  server.registerTool('extract', {
    title: '帰還・撤退',
    description: '階段の上で遠征を終える。目的を達成していれば帰還（達成）、未達成なら confirm: true で撤退（報酬なし・生還）。追跡中の敵が見えている間は不可。',
    inputSchema: { ...actionCommon, confirm: z.boolean().optional().describe('未達成のまま撤退するときに true') },
  }, async (a) => act('extract', a, { type: 'extract', confirm: a.confirm }));

  // ---------------- 情報照会（手番を消費しない） ----------------
  server.registerTool('observe', {
    title: '観測',
    description: '現在の観測（待たずに返す）。自分の手番を待つには wait_for_turn。Current observation (returns immediately).',
    inputSchema: { ...common, detail: z.enum(['brief', 'full']).optional() },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const o = port.observeWithTurn('observed', { detail: args.detail ?? 'brief' });
    record(port, 'observe', args, o.text);
    return out(o.text, { observation: o.observation, turn: o.turn });
  });

  server.registerTool('wait_for_turn', {
    title: '手番を待つ',
    description: '自分の手番（または遠征・ランの終了）まで待って観測を返す。既に自分の番なら即座に返る。Wait until it is your turn.',
    inputSchema: { ...common, timeout_s: z.number().int().min(1).max(60).optional().describe('最大待ち時間（秒、既定 20、最大 60）') },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const before = port.view().status;
    const got = before === 'your_turn' ? true : before === 'waiting_others' ? await port.waitForTurn((args.timeout_s ?? 20) * 1000) : false;
    const now = port.view().status;
    const reason = got ? 'turn_arrived' : now === 'waiting_others' ? 'wait_timeout' : 'observed';
    const o = port.observeWithTurn(reason, { detail: 'brief' });
    record(port, 'wait_for_turn', args, o.text);
    return out(o.text, { observation: o.observation, turn: o.turn });
  });

  server.registerTool('set_options', {
    title: '表示オプション',
    description: '応答テキストの出し方（地図・所持品・末尾の ▶ 行）。ゲームには影響しない。手番を消費しない。Response verbosity options.',
    inputSchema: { ...common, ...optionArgs },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const o = port.setOptions({ map: args.map, inventory: args.inventory, status_line: args.status_line });
    return withTurn(port, `map=${o.map} inventory=${o.inventory} status_line=${o.status_line}`, { options: o });
  });

  server.registerTool('look', {
    title: '調べる',
    description: '座標かエンティティ ID の説明。モンスターは「思い出」に基づく既知情報のみ（体力の記録・推定残り HP を含む）。',
    inputSchema: { ...common, target: z.union([PosZ, z.string()]) },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.look(args.target);
    return withTurn(port, r.text, { target: args.target, ...(r.data as Record<string, unknown>) });
  });

  server.registerTool('get_map', {
    title: '記憶地図',
    description: '記憶している現在フロアの ASCII 地図と凡例、既知の注目点。',
    inputSchema: { ...common, floor: z.number().int().optional().describe('深度（現在は現在フロアのみ）'), region: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1).max(80), h: z.number().int().min(1).max(60) }).optional() },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.map(args.region);
    return withTurn(port, r.text, (r.data ?? {}) as Record<string, unknown>);
  });

  server.registerTool('inventory', {
    title: '所持品',
    description: '所持品と装備の詳細。',
    inputSchema: { ...common },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.inventory();
    return withTurn(port, r.text, r.data as Record<string, unknown>);
  });

  server.registerTool('recall', {
    title: '思い出',
    description: 'そのモンスター種について自キャラが学んだこと（遭遇数・撃破数・観測した最大ダメージ・見た能力・倒した個体の体力）。',
    inputSchema: { ...common, kind_name: z.string().min(1) },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.recall(args.kind_name);
    return withTurn(port, r.text, { result: r.data });
  });

  server.registerTool('get_messages', {
    title: 'メッセージログ',
    description: '自分が知覚した出来事の文章ログ。',
    inputSchema: { ...common, since_seq: z.number().int().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.messages(args.since_seq, args.limit);
    return withTurn(port, r.text, { messages: r.data });
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
      if (!r.ok) return errOut(r.error, r.valid_actions, { block: r.turn, line: port.turnLine(r.turn) });
    }
    const notes = port.view().notes;
    return withTurn(port, notes.length ? notes.map((n, i) => `${i}: ${n}`).join('\n') : '(no notes)', { notes });
  });

  // ---------------- 行動（手番を消費する） ----------------
  server.registerTool('move', { title: '移動', description: '1 マス移動。敵がいれば攻撃、閉じた扉は開ける。', inputSchema: { ...actionCommon, dir: DirZ } },
    async (a) => act('move', a, { type: 'move', dir: a.dir }));
  server.registerTool('wait', { title: '待機', description: '1 手番待機。追跡中の敵が見えなければ休息として回復が速い。', inputSchema: { ...actionCommon } },
    async (a) => act('wait', a, { type: 'wait' }));
  server.registerTool('rest', {
    title: '休憩',
    description: 'マクロ: 全快（または until_hp / max_turns）まで休む。休息中は回復が速い。追跡中の敵が見えると止まる。観測の self.rest_estimate に事前の見積もり、結果に実績（hp_gained・turns・time_elapsed）。',
    inputSchema: { ...actionCommon, until_hp: z.number().int().positive().optional().describe('この HP に達したら止まる'), max_turns: z.number().int().positive().optional().describe('この手数で止まる') },
  }, async (a) => act('rest', a, { type: 'rest', untilHp: a.until_hp, maxTurns: a.max_turns }));
  const moveArgs = {
    mode: z.enum(['careful', 'steady', 'flee']).optional().describe("慎重さ: careful（既定。初見の種族・届く追跡中の敵の出現・被攻撃・HP 50%/25% で止まる）/ steady（隣接した追跡中の敵・初見の種族・HP が hp_floor 未満で止まる。弱い射撃や毒を受けながら進む）/ flee（到着・進路をふさがれた・HP が hp_floor 未満で止まる。隣に敵がいても動く＝退却）"),
    hp_floor: z.number().int().min(0).optional().describe('steady / flee: この HP を下回ったら止まる（既定 steady 50%・flee 25%）'),
  };
  server.registerTool('explore', {
    title: '自動探索',
    description: 'マクロ: 未見の区画へ進む（最大 200 手）。pickup（既定 true）なら通り道と見えているアイテムも拾う。止まる条件は mode で選ぶ。1 歩も進めないなら手番を使わずに理由付きで拒否する。',
    inputSchema: { ...actionCommon, ...moveArgs, pickup: z.boolean().optional().describe('通り道と見えている・記憶したアイテムを拾う（既定 true。遺物と鑑定済みの有害品は拾わない）') },
  }, async (a) => act('explore', a, { type: 'explore', mode: a.mode, hpFloor: a.hp_floor, pickup: a.pickup }));
  server.registerTool('travel_to', {
    title: '移動（目的地）', description: "マクロ: 既知地図上の経路で座標・階段・記憶した対象へ移動。目的地がアイテムなら着いて拾う。隣に敵がいても退くなら mode: 'flee'。",
    inputSchema: { ...actionCommon, to: z.union([PosZ, z.enum(['stairs_down', 'stairs_up']), z.string().regex(/^e_[0-9a-z]{6}$/)]), ...moveArgs, pickup: z.boolean().optional().describe('通り道のアイテムも拾う（既定: 目的地がアイテムのとき true）') },
  }, async (a) => act('travel_to', a, { type: 'travel', to: a.to, mode: a.mode, hpFloor: a.hp_floor, pickup: a.pickup }));
  server.registerTool('collect', {
    title: '回収', description: "マクロ: what: 'thrown'（既定）は既知の自分が投げた物を、'items' は見えている・記憶したアイテム（遺物と鑑定済みの有害品を除く）を近い順に回って拾う。結果に回収数と残り。",
    inputSchema: { ...actionCommon, what: z.enum(['thrown', 'items']).optional(), ...moveArgs },
  }, async (a) => act('collect', a, { type: 'collect', what: a.what, mode: a.mode, hpFloor: a.hp_floor }));
  server.registerTool('fight', {
    title: '戦う', description: 'マクロ: 隣の相手に近接攻撃を繰り返す。相手が倒れた・離れた、HP が hp_floor（既定 50%）を下回った、追跡中の別の敵が現れた、状態異常を受けたら止まる。結果に与えた・受けた攻撃の回数と合計。',
    inputSchema: { ...actionCommon, target: z.string().regex(/^e_[0-9a-z]{6}$/), hp_floor: z.number().int().min(0).optional() },
  }, async (a) => act('fight', a, { type: 'fight', target: a.target, hpFloor: a.hp_floor }));
  server.registerTool('pickup', { title: '拾う', description: '足元のアイテムを拾う（省略時は全て）。', inputSchema: { ...actionCommon, item: z.string().regex(/^e_[0-9a-z]{6}$/).optional() } },
    async (a) => act('pickup', a, { type: 'pickup', item: a.item }));
  server.registerTool('drop', { title: '置く', description: '所持品を足元に置く。', inputSchema: { ...actionCommon, slot: SlotZ, qty: z.number().int().positive().optional() } },
    async (a) => act('drop', a, { type: 'drop', slot: a.slot, qty: a.qty }));
  server.registerTool('equip', { title: '装備', description: '武器・防具を装備する。', inputSchema: { ...actionCommon, slot: SlotZ } },
    async (a) => act('equip', a, { type: 'equip', slot: a.slot }));
  server.registerTool('unequip', { title: '装備解除', description: '装備を外す（スロット文字か weapon/armor/accessory）。', inputSchema: { ...actionCommon, slot: z.union([SlotZ, z.enum(['weapon', 'armor', 'accessory'])]) } },
    async (a) => act('unequip', a, { type: 'unequip', slot: a.slot }));
  server.registerTool('use_item', {
    title: '使う', description: '薬を飲む・巻物を読む。鑑定の巻物は target_slot で対象を選べる（省略時はスロット順で最初の未鑑定品）。',
    inputSchema: { ...actionCommon, slot: z.string().describe(SlotZ.description ?? ''), target: z.any().optional().describe(TargetZ.description ?? ''), target_slot: z.string().optional().describe('鑑定の巻物などの対象の所持品スロット') },
  }, async (a) => act('use_item', a, { type: 'use', slot: a.slot, target: a.target as never, targetSlot: a.target_slot }));
  server.registerTool('throw_item', {
    title: '投げる', description: '対象（エンティティ ID・座標・方向）へ投げる。ID 指定で経路が通らなければ no_line_of_sight、射程外なら out_of_range（どちらも手番を使わない）。座標を狙えば遮られた位置・射程の端に落ちる。',
    inputSchema: { ...actionCommon, slot: z.string().describe(SlotZ.description ?? ''), target: z.any().describe(TargetZ.description ?? '') },
  }, async (a) => act('throw_item', a, { type: 'throw', slot: a.slot, target: a.target as never }));
  server.registerTool('interact', { title: '操作', description: '扉の開閉、泉・祭壇などの操作。dir 省略時は足元。', inputSchema: { ...actionCommon, dir: DirZ.optional() } },
    async (a) => act('interact', a, { type: 'interact', dir: a.dir }));
  server.registerTool('use_stairs', { title: '階段', description: '足元の階段を使う。', inputSchema: { ...actionCommon } },
    async (a) => act('use_stairs', a, { type: 'stairs' }));
  server.registerTool('say', { title: '発言', description: 'COOP 用チャット。手番を消費しない。', inputSchema: { ...common, text: z.string().min(1).max(280) } },
    async (a) => act('say', a, { type: 'say', text: a.text }));

  return server;
}

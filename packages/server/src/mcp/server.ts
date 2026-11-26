// MCP アダプタ。ツールは PROTOCOL.md §2。プレイヤー向けの情報は PlayerPort 経由でしか得ない。
// 1 MCP 接続 = 1 プレイヤー（接続に束縛）。ステートレスなクライアント向けに全ツールが player_token も受け付ける。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { argListText, argProblems, argShape, briefArgs, briefNames, exampleOf, issueTexts, type ArgIssue } from './args';
import type { ActionError, Command, Controller, InheritedHold, ObjectiveChoice, TurnBlock } from '@muse/shared';
import { actionError, CommandSchema, directiveItemsText, ownerWaitOpen, seasonFinalView, stripTokenArgs, t, withoutOwnerPresence } from '@muse/shared';
import type { PlayerPort, ActionPayload } from '../session/PlayerPort';
import type { SessionManager } from '../session/SessionManager';
import { isKnownClass } from '../session/SessionManager';
import { internalError } from '../session/ops';
import { rulesText, RULE_TOPICS } from './rules';
import type { RulesTopic } from './rules';

export interface McpContext {
  manager: SessionManager;
  boundToken: string | null;
  briefMap: boolean;
  clientLabel: string;
}

const DirZ = z.enum(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);
/** fight の with の 1 つ（スロットか品の種類）と、valid_actions の書き方で並べたもの（"[a,b]"・"a,b"。V4-1g G5） */
const WITH_ONE = /^([a-z]|(core:)?[a-z][a-z0-9_]+)$/;
const WITH_LIST = /^\[?([a-z]|(core:)?[a-z][a-z0-9_]+)(,([a-z]|(core:)?[a-z][a-z0-9_]+)){0,3}\]?$/;
/** 並べた値を配列にする: 配列はそのまま、"[a,b]"・"a,b"・"a" は分ける */
function listArg(v: string | string[] | undefined): string[] | undefined {
  if (v === undefined) return undefined;
  const list = Array.isArray(v) ? v : v.replace(/^\[|\]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
  return list.length ? list : undefined;
}
const PosZ = z.object({ x: z.number().int(), y: z.number().int() });
/** start_expedition の候補（S11a: 引数の断りでは、省けないプレイヤーには要る引数として扱う） */
const OfferZ = z.union([z.number().int().min(1).max(9), z.literal('endless')]);
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
  return out(text, { ok: false, error, valid_actions, ...(turn ? { turn: turn.block } : {}) }, error.code === 'no_session' || error.code === 'bad_request' || error.code === 'recovery_failed');
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
  // ツールの中の例外（S12c）: SDK は例外の文をそのまま返すので、ここで受けて、決まった文にする（詳細はサーバーのログ。引数は出さない）
  const register = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, cb: (...a: unknown[]) => unknown) => register(name, config as never, (async (...a: unknown[]) => {
    try {
      return await cb(...a);
    } catch (e) {
      console.error(`[mcp] ${name}: 内部のエラー: ${String((e as Error)?.stack ?? e)}`);
      return errOut(internalError());
    }
  }) as never)) as typeof server.registerTool;
  const waitMs = manager.config.waitOthersMs;
  // 野営の火の数（S1c。ツールの説明に出す）
  const fireRules = manager.catalog.rules.seasonFire;
  const supplyRules = manager.catalog.rules.seasonSupply;

  // 直前の portOf で見つからなかったトークン（復旧に失敗したランなら、そのエラーを返す。V4-1m §37.1。portOf と noSession は同期で続けて呼ぶ）
  let missed: string | undefined;
  const portOf = (token?: string): PlayerPort | null => {
    const tok = token ?? ctx.boundToken;
    const port = tok ? manager.portForToken(tok) : null;
    missed = port ? undefined : tok ?? undefined;
    return port;
  };
  const noSession = () => {
    const f = manager.recoveryFailedForToken(missed);
    return errOut(f ?? actionError('no_session', 'このMCP接続にはプレイヤーが束縛されていない / no player bound to this connection', 'new_run で始めるか、resume_run(player_token) で再開する / call new_run or resume_run'));
  };

  const record = (port: PlayerPort, tool: string, args: Record<string, unknown>, text: string, secrets: readonly (string | undefined)[] = []) => {
    const { player_token: _t, profile_token: _p, ...rest } = args;
    // 引数のトークン（名前に token を含む引数・トークンの値）は、どの深さでも記録に残さない（S7 §52.1 の 1: 観戦の「直前の命令」に引数を出す）
    const all = [_t, _p, ...secrets, ...(ctx.boundToken ? [ctx.boundToken] : [])];
    const safe = stripTokenArgs(rest, all) as Record<string, unknown>;
    // 持ち主の様子（S11）は本人にだけ出す文なので、観戦に流す記録からは除く
    manager.recordActivity(port.runId, { playerId: port.playerId, seq: port.view().seq, tool, args: safe, text: withoutTokens(withoutOwnerPresence(text), all), wall: Date.now() });
  };

  const act = async (tool: string, args: Record<string, unknown>, cmd: Command, extra: { bareStart?: boolean } = {}) => {
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
      waitTurnMs: waitMs, map: ctx.briefMap, ...extra,
    });
    const text = port.formatActionText(r);
    record(port, tool, args, text);
    if (!r.ok) return errOut(r.error, r.valid_actions, { block: r.turn, line: port.turnLine(r.turn) });
    return out(text, r as unknown as Record<string, unknown>);
  };

  /** 要る引数が無い（V4-1g G5）: 引数の名前と、呼び方の例を言う。手番は使わない */
  const missingArg = (tool: string, args: Record<string, unknown>, name: string, example: string) => {
    const port = portOf(args.player_token as string | undefined);
    if (!port) return noSession();
    const L = port.locale();
    const err = actionError('bad_request', t(L, `${tool} には ${name} が要る`, `${tool} needs ${name}`), t(L, `例: ${example}（valid_actions の行は、書いてある形のまま呼べる）`, `e.g. ${example} (valid_actions lines can be called as written)`));
    const tb = port.turnBlock('action_rejected');
    const va = port.observe({ map: false }).observation.valid_actions;
    record(port, tool, args, `${err.code} ${err.message}`);
    return errOut(err, va, { block: tb, line: port.turnLine(tb) });
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
      run_id: r.runId, mode: r.mode, joinable: r.joinable && !r.season, seq: r.seq, ...(r.season ? { season: r.season } : {}),
      // 進行中のシーズンのラン（S2a・S2b）: 名前とシーズンのランであることだけ（状態と深さを出さない）
      players: r.players.map((p) => (p.hidden ? { name: p.name, class: p.classId, controller: p.controller.kind, hidden: true as const } : { name: p.name, class: p.classId, controller: p.controller.kind, state: p.state, depth: p.depth })),
    }));
    // 開いているシーズン（S0 §9.1）: new_run { season } で参加する
    const seasons = manager.seasons.list().filter((x) => x.status === 'open').map((x) => ({ id: x.id, name: x.name, budget: x.budget, ends_at: new Date(x.endsAt).toISOString(), participants: x.participants, invited: x.invited }));
    const text = (runs.length ? runs.map((r) => `${r.run_id} [${r.mode}${r.season ? ` season ${r.season}` : ''}] ${r.joinable ? 'joinable' : 'full'} — ${r.players.map((p) => ('hidden' in p ? `${p.name}(${p.class})` : `${p.name}(${p.class}, ${p.state}, depth ${p.depth ?? '-'})`)).join(', ')}`).join('\n') : 'No active runs. Use new_run.')
      + (seasons.length ? '\n' + seasons.map((x) => `season ${x.id}「${x.name}」 budget ${x.budget} turns, ends ${x.ends_at}, participants ${x.participants}/${x.invited} invited — new_run { season: "${x.id}", profile_token } (invited profiles only)`).join('\n') : '');
    return out(text, { runs, seasons });
  });

  /** new_run / resume_run の表示オプション（brief_map は旧引数: false → map: never） */
  const applyOptions = (port: PlayerPort, args: Record<string, unknown>) => {
    const map = (args.map as 'auto' | 'always' | 'never' | undefined) ?? (args.brief_map === false ? 'never' : undefined);
    port.setOptions({ map, inventory: args.inventory as 'on_change' | 'always' | undefined, status_line: args.status_line as 'short' | 'long' | undefined });
  };

  const joinedOut = async (port: PlayerPort, token: string, runId: string, tool: string, args: Record<string, unknown>, reason: 'run_started' | 'resumed', profile?: { id: string; token?: string }, inherited?: InheritedHold) => {
    ctx.boundToken = token;
    applyOptions(port, args);
    // キャンプの候補は観測の文に入るので重ねない
    const briefing = port.briefing(reason === 'resumed' ? 'resume' : 'start', { camp: false });
    // プロフィールの握る項目を引き継いだ（S9 §58.3）: その理由と、最初の遠征の目的を使わなかったこと
    if (inherited) {
      const L = port.locale();
      const items = directiveItemsText(L, inherited.hold);
      briefing.unshift(t(L, `持ち主が握っている項目（${items}）を、このプロフィールから引き継いだ。キャンプから始め、持ち主の支度を待つ${inherited.objectiveIgnored ? '（渡された最初の遠征の目的は、使わなかった）' : ''}。`,
        `Carried over what your owner holds (${items}) from this profile. The run starts at camp and waits for your owner's preparations${inherited.objectiveIgnored ? ' (the first objective you passed was not used)' : ''}.`));
    }
    const o = port.observeWithTurn(reason, { detail: 'full', consume: true });
    // プロフィール（V3-7 §16.3）: 新しく作ったときだけトークンを返す。次の new_run に渡すと記録と継承が引き継がれる
    const prof = profile?.token
      ? `profile_id: ${profile.id}\nprofile_token: ${profile.token}\n(このトークンを保存し、次の new_run の profile_token に渡すと記録・図鑑・継承が引き継がれる / save it and pass it to the next new_run as profile_token to keep records and legacy)\n`
      : profile ? `profile_id: ${profile.id}\n` : '';
    const head = `run_id: ${runId}\nplayer_token: ${token}\n(このトークンで resume_run できる / keep this token to resume)\n${prof}\n`;
    const text = head + (briefing.length ? briefing.join('\n') + '\n\n' : '') + o.text;
    // 観戦の「AI の呼び出しの記録」には、トークンを入れない（S3a §27.9 の 4。俯瞰の観戦は、つないだときに直近の記録を受ける）
    record(port, tool, args, text, [token, profile?.token]);
    return out(text, { run_id: runId, player_token: token, player_id: port.playerId, ...(profile ? { profile_id: profile.id, ...(profile.token ? { profile_token: profile.token } : {}) } : {}), ...(inherited ? { inherited_hold: inherited.hold, objective_ignored: inherited.objectiveIgnored } : {}), briefing, observation: o.observation, turn: o.turn });
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
      profile_token: z.string().optional().describe('前のランで受け取った profile_token。記録・図鑑・実績が積まれ、図鑑の知識の一部を引き継ぐ（省くと新しいプロフィールを作り、応答で返す）'),
      legacy: z.boolean().optional().describe('false で図鑑の知識を引き継がない（既定 true）'),
      season: z.string().max(32).optional().describe('シーズンの ID（list_runs の seasons）。運用者に招かれたプロフィールの profile_token が要る（無い・招かれていなければ断る）。シーズンのシードでソロ、Lv1 のキャンプから始まる。seed・mode・objective・legacy は使わない。倒れた後の新しいランも、同じ profile_token で同じ参加者として数える'),
      end_previous: z.boolean().optional().describe('冒険者 1 人（プロフィール 1 つ）に、続きを遊べるランは 1 つ。profile_token のプロフィールに続きのあるランがあると run_in_progress で断られる。true なら、前のランを引退と同じに終わらせてから始める（確定した点と記録は残る）'),
      ...optionArgs,
      brief_map: z.boolean().optional().describe('旧引数。false は map: never と同じ'),
    },
  }, async (args) => {
    const controller: Controller = { kind: 'agent', label: ctx.clientLabel };
    const classId = normClass(args.class);
    // 自分の持つ鍵かどうかで見る（S12c: constructor・__proto__ などの名前を「知っている職」にしない）
    if (classId && !isKnownClass(manager.catalog.classes, classId)) {
      const list = Object.entries(manager.catalog.classes).map(([id, c]) => `${id.split(':')[1]}（${c.name.ja}）`).join(' / ');
      return errOut(actionError('bad_request', `不明な職業 ${args.class} / unknown class`, `class は ${list}。詳しくは get_rules topic=classes`));
    }
    const r = await manager.createRun({
      name: args.character_name, classId, mode: args.mode, seed: args.seed, locale: args.locale, controller,
      objective: args.objective as ObjectiveChoice | undefined, profileToken: args.profile_token, legacy: args.legacy,
      ...(args.season !== undefined ? { season: args.season } : {}),
      ...(args.end_previous ? { endPrevious: true } : {}),
    });
    if ('error' in r) return errOut(r.error);
    return joinedOut(r.port, r.token, r.session.runId, 'new_run', { ...args, seed: undefined }, 'run_started', r.profile, r.inherited);
  });

  server.registerTool('join_run', {
    title: 'ランに参加',
    description: '進行中の COOP ランに参加する。Join a coop run.',
    inputSchema: {
      run_id: z.string(), character_name: z.string().min(1).max(32), class: z.string().optional(), locale: z.enum(['ja', 'en']).optional(),
      profile_token: z.string().optional().describe('前のランで受け取った profile_token（省くと新しいプロフィールを作る）'), legacy: z.boolean().optional().describe('false で図鑑の知識を引き継がない'),
    },
  }, async (args) => {
    const r = await manager.joinRun(args.run_id, { name: args.character_name, classId: normClass(args.class), locale: args.locale, controller: { kind: 'agent', label: ctx.clientLabel }, profileToken: args.profile_token, legacy: args.legacy });
    if ('error' in r) return errOut(r.error);
    return joinedOut(r.port, r.token, r.session.runId, 'join_run', args, 'run_started', r.profile);
  });

  server.registerTool('resume_run', {
    title: 'ランを再開',
    description: 'プレイヤートークンで現在の接続にプレイヤーを再束縛する。再開ブリーフィング（遠征の目的と進捗・現在地・直近の節目・メモ）が付く。Rebind your player by token.',
    inputSchema: { player_token: z.string(), ...optionArgs },
  }, async (args) => {
    const port = manager.portForToken(args.player_token);
    if (!port) return errOut(manager.recoveryFailedForToken(args.player_token) ?? actionError('no_session', 'そのトークンのランは見つからない / unknown token', 'new_run で新しく始める / start a new run'));
    ctx.boundToken = args.player_token;
    applyOptions(port, args);
    const briefing = port.briefing('resume', { camp: false });
    const o = port.observeWithTurn('resumed', { detail: 'full', consume: true });
    const text = (briefing.length ? briefing.join('\n') + '\n\n' : '') + o.text;
    record(port, 'resume_run', {}, text);
    return out(text, { run_id: port.runId, player_id: port.playerId, briefing, observation: o.observation, turn: o.turn });
  });

  // ---------------- プロフィール（V3-7 §7） ----------------
  /** profile_token があればそのプロフィール、無ければこの接続のプレイヤーのプロフィール */
  const profileOf = (token?: string, playerToken?: string) => {
    if (token) return manager.profilePortForToken(token);
    const tok = playerToken ?? ctx.boundToken;
    const r = tok ? manager.resolveToken(tok) : null;
    const id = r ? r.session.profileOf(r.playerId) : null;
    return id ? manager.profilePort(id) : null;
  };
  const noProfile = () => errOut(actionError('no_session', 'プロフィールが見つからない / no profile', 'profile_token を渡すか、ランに束縛してから呼ぶ / pass profile_token or bind a run first'));
  server.registerTool('records', {
    title: '記録と図鑑',
    description: 'プロフィールの記録（ランの数・確定点の最高と平均・最深・達成した遠征・倒した大守護者・死因・直近のラン）、図鑑（種族・鑑定した品・納めた遺物・守護者の型と弱点・断章・特殊部屋。完成度は「見つけた/全部」）、実績、次の節目。シーズンのランでは、記録庫の討伐の記録の全文も（キャンプの記録庫は 1 行にたたむ）。ランをまたいで残る。手番を消費しない。profile_token を省くと、この接続のプレイヤーのプロフィール。Records, codex and feats of your profile.',
    inputSchema: { ...common, profile_token: z.string().optional(), locale: z.enum(['ja', 'en']).optional() },
  }, async (args) => {
    const pp = profileOf(args.profile_token, args.player_token);
    if (!pp) return noProfile();
    const port = portOf(args.player_token);
    const r = pp.records(args.locale ?? port?.locale() ?? 'ja');
    if (!r) return noProfile();
    // 討伐の記録の全文（S6 §49.5 の 3・4: キャンプの記録庫は 1 行にたたむ）。この接続のプレイヤーのシーズンのランで、取り込んだもの
    const sa = port && !args.profile_token ? port.slayArchive() : null;
    const text = sa?.lines.length ? `${r.text}\n${sa.lines.join('\n')}` : r.text;
    const data = { records: r.data, ...(sa?.data.length ? { slays: sa.data } : {}) };
    return port && !args.profile_token ? withTurn(port, text, data) : out(text, data);
  });
  server.registerTool('profile', {
    title: 'プロフィール',
    description: 'プロフィールの表示名・記録の要約・進行中のラン（run_id だけ）。name で表示名を変える。ランに束縛されていなくても呼べる。手番を消費しない。Your profile (name, summary, runs in progress).',
    inputSchema: { ...common, profile_token: z.string().optional(), name: z.string().min(1).max(32).optional(), locale: z.enum(['ja', 'en']).optional() },
  }, async (args) => {
    const pp = profileOf(args.profile_token, args.player_token);
    if (!pp) return noProfile();
    if (args.name && !args.profile_token) return errOut(actionError('bad_request', '表示名を変えるには profile_token が要る / renaming needs profile_token', ''));
    if (args.name) pp.rename(args.name);
    const r = pp.info(args.locale ?? 'ja');
    if (!r) return noProfile();
    return out(r.text, r.data as unknown as Record<string, unknown>);
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
    // 進行中なら途中経過、キャンプなら直前の遠征のレポート（V3-6 §6）
    const rep = port.expeditionReportLines();
    return withTurn(port, [...lines, ...rep.lines].join('\n'), { briefing: lines, expedition: o.observation.expedition ?? null, camp: o.observation.camp ?? null, ...(rep.progress ? { progress: rep.progress } : {}), ...(rep.report ? { report: rep.report } : {}) });
  });
  server.registerTool('review', {
    title: '振り返り',
    description: '終わった遠征のレポート（確定・戦闘・消耗・進み・このランの前の遠征との比較・場面）。expedition を省くと直前の遠征。手番を消費しない。Review an ended expedition (facts only).',
    inputSchema: { ...common, expedition: z.number().int().min(1).optional().describe('遠征の番号（省略時は直前の遠征）') },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const r = port.review(args.expedition);
    return withTurn(port, r.text, { report: r.data });
  });
  server.registerTool('start_expedition', {
    title: '遠征を始める',
    description: 'キャンプで次の遠征を選んで始める（offer は候補の番号 1〜3 か "endless"）。前回 extract した階段から再開する。持ち主の支度が「まだ」の間は断られる（観測の「持ち主の支度」の行。wait_for_turn で待てる）。目的を持ち主に握られていれば、準備完了の後は、offer によらず持ち主が選んだ目的で始まる。offer: 候補の番号（目的を持ち主が決めていて、支度が準備完了のときだけ、省ける）。',
    // offer は、ツールの定義の上では任意（全員に同じ定義を渡すため）。引数の断りでは、プレイヤーを見て、省けないときは「要る」と書く（S11a: 下の startShape）
    inputSchema: { ...common, offer: OfferZ.optional().describe('候補の番号 1〜3 か "endless"（目的を持ち主が決めていて、支度が準備完了のときだけ、省ける）'), thought: actionCommon.thought },
  }, async (a) => {
    if (a.offer !== undefined) return act('start_expedition', a, { type: 'start_expedition', offer: a.offer });
    // offer なし（S11・S11a）: 引数の断りの前で、受けられることを確かめてある。サーバーが、命令の列の中で、持ち主が選んだ候補を入れる（engine の命令の形は変えない）。
    // ここの offer は形を通すための仮（列の中で入れ直す）
    const port = portOf(a.player_token as string | undefined);
    if (!port) return noSession();
    const o = port.view().directive?.prep?.objective;
    if (!port.bareStartOk() || o === undefined) return missingArg('start_expedition', a, 'offer', 'start_expedition { offer: 1 }');
    return act('start_expedition', a, { type: 'start_expedition', offer: o }, { bareStart: true });
  });
  server.registerTool('extract', {
    title: '帰還・撤退',
    description: `階段の上で遠征を終える。目的を達成していれば帰還（達成）、未達成なら confirm: true で撤退（目的を除いた半分・生還）。追跡中の敵が見えていてもできる（敵は階段を追ってこない）。階段から遠ければ帰還の綱（use_item）。シーズンのランでは、野営の火の上か隣からも帰れる（追ってくる敵が見えていなければ。帰り支度 ${fireRules?.returnTurns ?? 5} 手番。途中で追ってくる敵が見えたら取りやめ。次の遠征はそこから始まる）。`,
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
    description: '自分の手番（または遠征・ランの終了）まで待って観測を返す。既に自分の番なら即座に返る。キャンプで、持ち主の支度が「まだ」のとき（観測の「持ち主の支度: まだ」の行）は、準備完了になるまで待つ（手番は減らない。時間切れなら今の状態を返す。何回呼んでもよい。準備完了になったら、start_expedition で出発する）。Wait until it is your turn (or, at camp while your owner\'s preparations are not ready, until they are; then set out with start_expedition).',
    inputSchema: { ...common, timeout_s: z.number().int().min(1).max(60).optional().describe('最大待ち時間（秒、既定 20、最大 60）') },
  }, async (args) => {
    const port = portOf(args.player_token);
    if (!port) return noSession();
    const v0 = port.view();
    // キャンプで、持ち主の支度の札が「まだ」（S8 §54.4 の 5。S9 §58.1 で、目的を握られているときと、特技・加護の保留があるときの待ちを、これ 1 つにまとめた）:
    // 準備完了になるまで待つ（最長は同じ。時間が来たら今の観測）。予算切れ・時間切れのキャンプは待たない（S8b。下の道で、すぐ返る）
    if (ownerWaitOpen(v0)) {
      const t0 = Date.now();
      const w = await port.waitForOwner((args.timeout_s ?? 20) * 1000);
      const reason = w === 'timeout' ? 'wait_timeout' : w === 'started' && port.view().status === 'your_turn' ? 'turn_arrived' : 'observed';
      const o = port.observeWithTurn(reason, { detail: 'brief', waitedMs: Date.now() - t0 });
      record(port, 'wait_for_turn', args, o.text);
      return out(o.text, { observation: o.observation, turn: o.turn });
    }
    const before = v0.status;
    // 確定したシーズンのラン（S9b）: 何も来ないので、待たずに返す
    if (seasonFinalView(v0)) {
      const o = port.observeWithTurn('observed', { detail: 'brief' });
      record(port, 'wait_for_turn', args, o.text);
      return out(o.text, { observation: o.observation, turn: o.turn });
    }
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
    description: '自分用メモの読み書き（長時間プレイでの文脈喪失対策。ゲームに影響しない。手番を使わない）。項目つきで書ける: add の文の先頭に覚え書きの定型の項目の名前（「次のねらい: …」「分かったこと: …」「まだ分からないこと: …」「前にやめたこと: …（根拠: そのときのレベル・武器・与えた被害と受けた被害）」）。キャンプの観測に新しい順に 8 件まで、resume_run に全部出る / Notes for yourself (no effect on the game; free). Start an add with a template item name ("next aim: ...", "learned: ...", "still unknown: ...", "gave up on: ... (why: level, weapon, damage dealt and taken)"). Camp shows the newest 8; resume_run shows all.',
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
  server.registerTool('wait', {
    title: '待機', description: '1 手番待機。追跡中の敵が見えなければ休息として回復が速い。turns（2〜10）なら、敵が見えた・隣に来た・被害を受けたら止まりつつ続けて待つ。',
    inputSchema: { ...actionCommon, turns: z.number().int().min(1).max(10).optional().describe('続けて待つ手数（最大 10）') },
  }, async (a) => act('wait', a, { type: 'wait', ...(a.turns ? { turns: a.turns } : {}) }));
  server.registerTool('rest', {
    title: '休憩',
    description: 'マクロ: 休憩で戻る上限（最大 HP の一定の割合。get_rules）まで（または until_hp / max_turns まで）休む。それより上は回復の薬・立て直し・泉・キャンプで戻る。休息中は回復が速い。追跡中の敵が見えると止まる。観測の self.rest_estimate に事前の見積もり、結果に実績（hp_gained・turns・time_elapsed）。',
    inputSchema: { ...actionCommon, until_hp: z.number().int().positive().optional().describe('この HP に達したら止まる'), max_turns: z.number().int().positive().optional().describe('この手数で止まる') },
  }, async (a) => act('rest', a, { type: 'rest', untilHp: a.until_hp, maxTurns: a.max_turns }));
  const moveArgs = {
    mode: z.enum(['careful', 'steady', 'flee']).optional().describe("慎重さ: careful（既定。初見の種族・届く追跡中の敵の出現・被攻撃・HP 50%/25% で止まる）/ steady（隣接した追跡中の敵・初見の種族・HP が hp_floor 以下で止まる。弱い射撃や毒を受けながら進む）/ flee（到着・進路をふさがれた・HP が hp_floor 以下で止まる。隣に敵がいても動く＝退却。1 歩ごとの後に見るので、1 歩の間に何度も撃たれると、その分だけ下回って止まる）"),
    hp_floor: z.number().int().min(0).optional().describe('steady / flee: HP がこの値以下になったら止まる。HP の値（割合ではない。20 なら HP 20）。省くと最大 HP の steady 50%・flee 25%（flee は、始めた時点の HP がそれ以下なら 0）。止まった文に使った値が出る'),
  };
  server.registerTool('explore', {
    title: '自動探索',
    description: 'マクロ: 未見の区画へ進む（最大 200 手）。pickup（既定 useful）なら通り道と見えているアイテムのうち使える物を拾う。toward: draft は下への風、sense は遺物・守護者の気配の方角を優先する。止まる条件は mode で選ぶ。1 歩も進めないなら手番を使わずに理由付きで拒否する。',
    inputSchema: {
      ...actionCommon, ...moveArgs, pickup: z.union([z.boolean(), z.literal('useful')]).optional().describe("通り道と見えている・記憶したアイテムを拾う。'useful'（既定）: 使える物だけ（鑑定済みで接辞の無い武器・防具は、装備中の品より数字が上のときだけ）。true: 全部（遺物・鑑定済みの有害品・同じ種類の同じか劣る装備は除く）。false: 拾わない"),
      toward: z.enum(['draft', 'sense']).optional().describe("'draft': 下への風の方角の未探索を優先する（下り階段を探すとき。公開された階段を自分の目で見たら止まる）。'sense': 遺物・守護者の気配の方角の未探索を優先する"),
      max_steps: z.number().int().min(1).max(200).optional().describe('この手数で止まる（既定は 1 回の上限 200。行動予算のあるシーズンで、使う手番を区切るとき）'),
    },
  }, async (a) => act('explore', a, { type: 'explore', mode: a.mode, hpFloor: a.hp_floor, pickup: a.pickup, ...(a.toward ? { toward: a.toward } : {}), ...(a.max_steps !== undefined ? { maxSteps: a.max_steps } : {}) }));
  server.registerTool('travel_to', {
    title: '移動（目的地）', description: "マクロ: 既知地図上の経路で座標・階段・記憶した対象（敵・アイテム・地物の ID）へ移動。目的地がアイテムなら着いて拾う（着いた手番に止まっても、hp_floor・hp_risk・予備動作でなければ拾ってから止まる）。地物は隣に着けば到着。隣に敵がいても退くなら mode: 'flee'。",
    inputSchema: { ...actionCommon, to: z.union([PosZ, z.enum(['stairs_down', 'stairs_up']), z.string().regex(/^e_[0-9a-z]{6}$/)]), ...moveArgs, pickup: z.union([z.boolean(), z.literal('useful')]).optional().describe("通り道のアイテムも拾う（既定: 目的地がアイテムのとき true。'useful' は使える物だけ）") },
  }, async (a) => act('travel_to', a, { type: 'travel', to: a.to, mode: a.mode, hpFloor: a.hp_floor, pickup: a.pickup }));
  server.registerTool('collect', {
    title: '回収', description: "マクロ: what: 'thrown'（既定）は既知の自分が投げた物を、'items' は見えている・記憶したアイテム（遺物と鑑定済みの有害品、鑑定済みで今の装備より劣る装備を除く）を近い順に回って拾う。within は、いま居るマスからいちばん近い品までの歩数の上限（既定 15。それより遠い品へは行かない。1 つ拾うと、そこから数え直して続ける。合計の歩数の上限ではない）、kinds は品の種類（種類 ID か区分。例 [\"potion\",\"javelin\"]。区分は potion・scroll・amulet・ring・weapon・armor・throwing・treasure・page。未鑑定の品は区分で指す）、all: true で劣る装備も拾う。kinds を付けて what を省くと 'items'（kinds の無い既定の thrown は自分が投げた物だけ）。結果に回収数と残り。",
    inputSchema: { ...actionCommon, what: z.enum(['thrown', 'items']).optional(), within: z.number().int().min(1).max(200).optional(), kinds: z.array(z.string()).max(8).optional(), all: z.boolean().optional(), ...moveArgs },
  }, async (a) => act('collect', a, { type: 'collect', what: a.what, mode: a.mode, hpFloor: a.hp_floor, ...(a.within !== undefined ? { within: a.within } : {}), ...(a.kinds ? { kinds: a.kinds } : {}), ...(a.all ? { all: true } : {}) }));
  server.registerTool('fight', {
    title: '戦う', description: 'マクロ: その相手と決着を付ける。with なしは近接（追跡中の相手が隣に来るまで待つ。最大 10 手番。approach: advance なら寄っていき、隣に着いたら殴る）、with にスロットか品の種類を渡すとその品を投げて戦う（射程と射線が通るまで待つ。品が尽きたら、追跡中の敵の隣を通らずに届く自分の投擲物を拾いに行って続ける。retrieve: false で切れる）。長柄の武器（槍）は、相手が縦・横・斜めの直線で 2 マス先にいて間のマスが空いていれば、そこから突く（待つときは、相手が隣か 2 マス先の直線に来たら突く。approach: advance は相手の隣のマスを目指して歩き、途中で 2 マス先の直線に入ったら、そこで突く。2 マス先の位置を選んで寄るのではない）。相手が倒れた・離れた・逃げて見えなくなった、（with）隣に来た・品が尽きた、HP が hp_floor（HP の値。割合ではない。既定は最大 HP の 50%）以下になった、被弾の記録の無い種族の追跡中の敵が現れた、待つ間に別の敵に撃たれた、状態異常を受けたら止まる（記録のある種族が新しく見えても止まらない）。物陰に入った相手は数手番待つ。眠っている・気付いていない相手は待たない。until: clear なら、標的を倒した後も届く追跡中の敵（隣の敵、いなければ最も近い敵）へ続ける。adjacent は with の相手が隣に来たとき（stop: 止まる・既定 / throw: 投げ続ける / melee: 近接に切り替える）。abilities に能動技（強打・なぎ払い・狙い撃ち）を並べると、使える手番ごとに使う（強打は標的が隣、なぎ払いは起きている敵が隣に 2 体以上、狙い撃ちは with の品で射程と射線が通るとき。それ以外の手番は通常の攻撃）。結果に与えた・受けた攻撃の回数と合計、使った能動技の回数。',
    inputSchema: {
      ...actionCommon, target: z.string().regex(/^e_[0-9a-z]{6}$/),
      with: z.union([z.string().regex(WITH_LIST), z.array(z.string().regex(WITH_ONE)).min(1).max(4)]).optional().describe('投げて戦う品の所持品スロット（self.attack.throws）か品の種類（javelin・throwing_knife など。拾ってスロットが変わっても同じ種類を投げる）。配列なら前の品が尽きて拾い直せる物も無くなったら次の品へ（["javelin", "throwing_knife"]。valid_actions の書き方の "[javelin,throwing_knife]" や "javelin,throwing_knife" の文字列でもよい）'),
      collect_after: z.boolean().optional().describe('決着の後（倒した・until: clear で片付いた）、追跡中の敵が見えていなければ自分の投擲物を拾う（collect と同じ止まり方）'),
      hp_floor: z.number().int().min(0).optional().describe('HP の値（割合ではない。20 なら HP 20）。HP がこの値以下になったら止まり、次の手番の見込みの被害でこれを割るなら殴る前に止まる（最悪の 1 手で倒れうるなら、この値によらず止まる）。省くと最大 HP の 50%'),
      retrieve: z.boolean().optional().describe('with の品が尽きたら、追跡中の敵の隣を通らずに届く自分の投擲物を拾いに行く（既定 true）'),
      until: z.enum(['target', 'clear']).optional().describe('clear: 標的を倒した後も、届く追跡中の敵へ続ける（既定 target: 標的 1 体）'),
      adjacent: z.enum(['throw', 'melee', 'stop']).optional().describe('with の相手が隣に来たとき（既定 stop）'),
      approach: z.enum(['wait', 'advance']).optional().describe('with なしの近接で、追跡中で届かない相手を: wait＝隣に来るまで待つ（既定）/ advance＝寄っていき、隣に着いたら殴る（歩く間に撃たれても止まらない。動かずに撃ってくる相手に）'),
      abilities: z.union([z.array(z.string().min(1)).max(4), z.string().min(1)]).optional().describe('使える手番ごとに使う能動技（bash・cleave・aimed_throw。aimed_throw は with と一緒に。second_wind・slip は載せられない）。valid_actions の書き方の "bash,cleave" の文字列でもよい'),
    },
  }, async (a0) => {
    // valid_actions の行を書いてある形のまま呼べるように、並べた値（"[a,b]"・"a,b"）は配列にする（V4-1g G5）
    const a = { ...a0, with: listArg(a0.with), abilities: listArg(a0.abilities) };
    return act('fight', a, { type: 'fight', target: a.target, ...(a.with ? (a.with.length > 1 ? { with: a.with[0]!, alsoWith: a.with.slice(1) } : { with: a.with[0]! }) : {}), ...(a.collect_after ? { collectAfter: true } : {}), hpFloor: a.hp_floor, ...(a.abilities?.length ? { abilities: a.abilities } : {}), ...(a.until ? { until: a.until } : {}), ...(a.adjacent ? { adjacent: a.adjacent } : {}), ...(a.approach ? { approach: a.approach } : {}), ...(a.retrieve === false ? { retrieve: false } : {}) });
  });
  server.registerTool('attack', {
    title: '攻撃', description: '近接攻撃。隣の敵か、長柄の武器（槍）なら縦・横・斜めの直線で 2 マス先の敵（間のマスが通れて誰もいないこと）。隣の敵なら move でも攻撃できる。',
    inputSchema: { ...actionCommon, target: z.string().regex(/^e_[0-9a-z]{6}$/) },
  }, async (a) => act('attack', a, { type: 'attack', target: a.target }));
  server.registerTool('use_ability', {
    title: '能動技', description: '能動技を使う（self.abilities。再使用までの手番 cooldown だけで管理）。target: 隣の敵・投擲の対象なら ID、身をかわすなら方向。slot: 狙い撃ちで投げる品（省略時は投擲用の品の最初のスロット）。使えない・対象が無いときは手番を使わずに拒否する。',
    inputSchema: { ...actionCommon, ability: z.string().min(1).optional().describe('能動技の ID（bash / cleave / second_wind / aimed_throw / slip など。self.abilities の id。valid_actions の「use_ability <ability> target:<…>」の <ability>）'), id: z.string().min(1).optional().describe('ability と同じ（前からの名前）'), target: z.string().optional().describe('敵の ID（e_xxxxxx）か方向（n ne e se s sw w nw）'), slot: z.string().regex(/^[a-z]$/).optional() },
  }, async (a) => {
    // ability（V4-1g G5）か id。どちらも無ければ、要る引数の名前を言う
    const id = a.ability ?? a.id;
    if (!id) return missingArg('use_ability', a, 'ability', "use_ability { ability: 'bash', target: 'e_xxxxxx' }");
    return act('use_ability', a, { type: 'ability', id, ...(a.target ? { target: a.target as never } : {}), ...(a.slot ? { slot: a.slot } : {}) });
  });
  server.registerTool('report_stairs', {
    title: '階段を報告する',
    description: 'シーズンのランのキャンプで、このランで自分の目で見た下り階段と特別な場所（部屋の作りにある祭壇・賭けの祭壇・碑文）のうち、まだ報告していないものを全部報告する（手番を消費しない）。それぞれ、最初に報告した者に貢献 1。報告したものは、ほかの参加者の次の遠征から地図に載る。Report the down stairs and special places (built-in altars, altars of chance, inscriptions) you saw in this run (season runs, at camp).',
    inputSchema: { ...common, thought: actionCommon.thought },
  }, async (a) => act('report_stairs', a, { type: 'report_stairs' }));
  server.registerTool('place_fire', {
    title: '野営の火を置く',
    description: `シーズンのランの迷宮の中で、自分のいるマスに野営の火を置く（1 手番）。置いた本人の得: 火の上か隣から帰還・撤退できる（extract。追ってくる敵が見えていなければ。帰り支度 ${fireRules?.returnTurns ?? 5} 手番）・火から帰ると次の遠征はそこから始まる・火の隣か上で interact すると HP が休憩の上限まで戻る（1 回の遠征で 1 つの階につき 1 回）。費用は 深さ × ${fireRules?.costPerDepth ?? 100} 点で、このランの確定した点から払う（戻らない）。キャンプに着くと、ほかの参加者の世界の同じ階の同じマスにも現れ、ほかの参加者に使われると支援賞に数える。置けない所と上限（シーズンで ${fireRules?.perSeason ?? 3} つ）は get_rules topic=season。Set a campfire on your cell (season runs): you can return home from it and start your next expedition there; costs depth x ${fireRules?.costPerDepth ?? 100} banked points.`,
    inputSchema: { ...actionCommon },
  }, async (a) => act('place_fire', a, { type: 'place_fire' }));
  // 補給の置き場（S3。SEASON.md §25.2）
  server.registerTool('deposit_supply', {
    title: '補給の置き場に預ける',
    description: `シーズンのランの迷宮の中で、補給の置き場（各階の上り階段・下り階段のマス、野営の火の上か隣）に、持っている消耗品（薬・巻物・投げる武器）を 1 つ預ける（1 手番。重ねた品は 1 つずつ。追ってくる敵が見えていてもできる）。装備・遺物・宝・鍵・帰還の綱は預けられない。置き場 1 つに ${supplyRules?.cap ?? 5} 個まで。預けた品は、キャンプに着くと、ほかの参加者の世界の同じ置き場にも現れ、ほかの参加者に取られると支援賞に数える。鑑定済みの品は名前つき、未鑑定の品は外見のまま。Deposit one consumable at a supply cache (stairs or campfire; season runs).`,
    inputSchema: { ...actionCommon, slot: z.string().regex(/^[a-z]$/).describe('預ける品のスロット（inventory の slot）') },
  }, async (a) => act('deposit_supply', a, { type: 'deposit_supply', slot: a.slot }));
  server.registerTool('take_supply', {
    title: '補給の置き場から取る',
    description: `シーズンのランの迷宮の中で、補給の置き場（各階の上り階段・下り階段のマス、野営の火の上か隣）から品を 1 つ取る（1 手番）。1 回の遠征で、置き場から取れるのは ${supplyRules?.perExpedition ?? 1} つまで（どの置き場でも、だれの品でも。自分の預けた品を取り返すのも数える）。id は観測の season.supply.items の id（'s12' など）。置き場に品が 1 つだけなら省ける。鑑定済みで預けられた品を取ると、その種類を知る。Take one item from a supply cache (season runs; ${supplyRules?.perExpedition ?? 1} per expedition).`,
    inputSchema: { ...actionCommon, id: z.string().regex(/^[sl][0-9]{1,6}$/).optional().describe("置き場の品の ID（season.supply.items の id。's12'・'l1'）") },
  }, async (a) => act('take_supply', a, { type: 'take_supply', ...(a.id ? { id: a.id } : {}) }));
  server.registerTool('choose_perk', {
    title: '特技を選ぶ', description: 'レベルアップの特技の候補から 1 つ選ぶ（self.perk_choice。手番を消費しない。選ぶまで進行は止まらない）。option は候補の番号（1 から）か特技の ID。持ち主が特技と加護を握っているときは、断られる代わりに、あなたの希望として持ち主に伝わる（観測の「指図」の行。get_rules topic=directive）。',
    // thought（S9c）: 握られているときは、希望の理由として持ち主に届く（前は引数に無く、共通の名前として捨てていた）
    inputSchema: { ...common, option: z.union([z.number().int().min(1).max(9), z.string().min(1)]), thought: actionCommon.thought },
  }, async (a) => act('choose_perk', a, { type: 'choose_perk', option: a.option }));
  server.registerTool('choose_boon', {
    title: '加護を選ぶ', description: '節目の大守護者を倒したときの加護の候補から 1 つ選ぶ（self.boon_choice。手番を消費しない）。option は候補の番号（1 から）か加護の ID。持ち主が特技と加護を握っているときは、断られる代わりに、あなたの希望として持ち主に伝わる（観測の「指図」の行。get_rules topic=directive）。',
    inputSchema: { ...common, option: z.union([z.number().int().min(1).max(9), z.string().min(1)]), thought: actionCommon.thought },
  }, async (a) => act('choose_boon', a, { type: 'choose_boon', option: a.option }));
  server.registerTool('pickup', { title: '拾う', description: '足元のアイテムを拾う（item を省くと足元の全て。ただし自分が置いた品は、ほかの品があれば拾わない。拾い直すなら item を渡す）。', inputSchema: { ...actionCommon, item: z.string().regex(/^e_[0-9a-z]{6}$/).optional() } },
    async (a) => act('pickup', a, { type: 'pickup', item: a.item }));
  server.registerTool('drop', { title: '置く', description: '所持品を足元に置く。', inputSchema: { ...actionCommon, slot: SlotZ, qty: z.number().int().positive().optional() } },
    async (a) => act('drop', a, { type: 'drop', slot: a.slot, qty: a.qty }));
  server.registerTool('equip', { title: '装備', description: '武器・防具・装飾品を装備する。装備すると正体と呪いの有無が分かる（呪われていれば外せない）。呪いと分かっている品は confirm: true が要る。持ち主が装備を握っているときは、断られる代わりに、あなたの希望として持ち主に伝わる（thought が理由になる）。', inputSchema: { ...actionCommon, slot: SlotZ, confirm: z.boolean().optional() } },
    async (a) => act('equip', a, { type: 'equip', slot: a.slot, ...(a.confirm ? { confirm: true } : {}) }));
  server.registerTool('unequip', { title: '装備解除', description: '装備を外す（スロット文字か weapon/armor/accessory）。持ち主が装備を握っているときは、断られる代わりに、あなたの希望として持ち主に伝わる（thought が理由になる）。', inputSchema: { ...actionCommon, slot: z.union([SlotZ, z.enum(['weapon', 'armor', 'accessory'])]) } },
    async (a) => act('unequip', a, { type: 'unequip', slot: a.slot }));
  server.registerTool('use_item', {
    title: '使う', description: '薬を飲む・巻物を読む・帰還の綱を使う（その場でキャンプへ。目的を除く戦利品の半分が確定。遺物は運べない）。slot はスロット文字か、正体の分かっている品の種類 ID（例 "potion_healing"。同じ種類が複数ならスロット順で最初）。鑑定の巻物は target_slot で対象を選べる（省略時はスロット順で最初の未鑑定品か、呪いの有無を確かめていない装備品）。',
    inputSchema: { ...actionCommon, slot: z.string().describe(`${SlotZ.description ?? ''}（または種類 ID）`), target: z.any().optional().describe(TargetZ.description ?? ''), target_slot: z.string().optional().describe('鑑定の巻物などの対象の所持品スロット') },
  }, async (a) => {
    // 種類 ID での指定（V3-8 §53.4）: 正体の分かっている所持品のスロットに読み替える（見えている所持品だけを使う）
    let slot = a.slot;
    if (!/^[a-z]$/.test(slot)) {
      const port = portOf(a.player_token as string | undefined);
      const k = slot.startsWith('core:') ? slot : `core:${slot}`;
      const hit = port?.view().inventory.filter((i) => i.kind === k).sort((x, y) => x.slot.localeCompare(y.slot))[0];
      if (port && !hit) {
        const L = port.locale();
        const err = actionError('no_such_item', t(L, `種類 ${slot} の品を持っていない（未鑑定の品はスロット文字で指定する）。`, `You carry no ${slot} (use the slot letter for unidentified items).`), t(L, 'inventory のスロットを見る。', 'Check slots in inventory.'));
        const tb = port.turnBlock('action_rejected');
        record(port, 'use_item', a, `${err.code} ${err.message}`);
        return errOut(err, port.observe({ map: false }).observation.valid_actions, { block: tb, line: port.turnLine(tb) });
      }
      if (hit) slot = hit.slot;
    }
    return act('use_item', a, { type: 'use', slot, target: a.target as never, targetSlot: a.target_slot });
  });
  server.registerTool('throw_item', {
    title: '投げる', description: '対象（エンティティ ID・座標・方向）へ投げる。ID・座標の指定で経路が通らなければ no_line_of_sight、射程外なら out_of_range（どちらも手番を使わない）。方向を狙えば遮られた位置・射程の端に落ちる。',
    inputSchema: { ...actionCommon, slot: z.string().describe(SlotZ.description ?? ''), target: z.any().describe(TargetZ.description ?? '') },
  }, async (a) => act('throw_item', a, { type: 'throw', slot: a.slot, target: a.target as never }));
  server.registerTool('interact', { title: '操作', description: '扉の開閉、泉・祭壇などの操作。dir 省略時は足元。', inputSchema: { ...actionCommon, dir: DirZ.optional() } },
    async (a) => act('interact', a, { type: 'interact', dir: a.dir }));
  server.registerTool('use_stairs', { title: '階段', description: '足元の階段を使う。', inputSchema: { ...actionCommon } },
    async (a) => act('use_stairs', a, { type: 'stairs' }));
  server.registerTool('say', { title: '発言', description: 'COOP 用チャット。手番を消費しない。', inputSchema: { ...common, text: z.string().min(1).max(280) } },
    async (a) => act('say', a, { type: 'say', text: a.text }));

  // start_expedition の引数の形（S11a）: 目的を握られ、支度が準備完了のとき（引数なしで受けられる）だけ offer は任意。ほかは、main の版と同じに「要る」
  const startShape = (tool: string, args: Record<string, unknown>, shape: Record<string, ZodTypeAny>): Record<string, ZodTypeAny> => {
    if (tool !== 'start_expedition' || !('offer' in shape)) return shape;
    const port = portOf(args.player_token as string | undefined);
    return port?.bareStartOk() ? shape : { ...shape, offer: OfferZ };
  };
  interceptArgs(server, startShape, (tool, args, names, shape) => {
    // 引数の名前の断り（S1c §14.4 の 2）: ゲームの断りの形で返す。束縛されていなければ、本文と structuredContent だけ
    const port = portOf(args.player_token as string | undefined);
    const L = port?.locale() ?? 'ja';
    const ja = L !== 'en';
    const list = argListText(shape, ja, tool);
    const ex = exampleOf(tool, shape);
    // 足りない要る引数があれば、それを先に言い、知らない名前もあわせて書く（S1d §17.1）
    const unknown = names.unknown, missing = names.missing;
    // 文と記録に出す名前は、数と長さを切る（S16e: 検査の前なので、いくつでも・どんな長さでも来る）
    const unkShown = briefNames(unknown);
    const unk = unknown.length ? (ja ? `${tool} に ${unkShown.join('・')} という名前の引数は無い。` : `${tool} has no argument named ${unkShown.join(', ')}. `) : '';
    // 引数の形の誤り（S16d）: どの引数が、どう違うか（受ける形）。手番は使わない
    const bad = names.invalid.length ? issueTexts(names.invalid, shape, args, ja) : [];
    const msg = bad.length
      ? (ja ? `${tool} の引数の形が違う: ${bad.join('／')}。` : `${tool}: invalid argument: ${bad.join('; ')}.`)
      : missing.length
        ? (ja ? `${tool} には ${missing.join('・')} が要る（渡されていない）。${unk}このツールの引数: ${list}。` : `${tool} needs ${missing.join(', ')} (not given). ${unk}Its arguments: ${list}.`)
        : (ja ? `${unk}このツールの引数: ${list}。` : `${unk}Its arguments: ${list}.`);
    const err = bad.length
      ? actionError('bad_request', msg, ja ? `例: ${ex}（valid_actions の行は、書いてある形のまま呼べる）。このツールの引数: ${list}` : `e.g. ${ex} (valid_actions lines can be called as written). Its arguments: ${list}`)
      : actionError('bad_request', msg, ja ? `例: ${ex}（valid_actions の行は、書いてある形のまま呼べる。別の名前は受け付けない。thought・player_token など共通の名前は、どのツールにも付けてよい）` : `e.g. ${ex} (valid_actions lines can be called as written; other names are not accepted; common names such as thought and player_token are fine on any tool)`);
    if (!port) return out(`Error [${err.code}] ${err.message}\nHint: ${err.hint}`, { ok: false, error: err }, true);
    const tb = port.turnBlock('action_rejected');
    const va = port.observe({ map: false }).observation.valid_actions;
    // 活動の記録には、知らない名前の引数の値を残さない（名前違いでトークンを渡された場合のため。S1d §17.1）。名前だけ残す
    // 残す値は、短く切る（S16e: ここは SDK の検査より前なので、長さの上限が効いていない。切らないと、長い thought・大きい配列が、観戦に流れる）
    const known: Record<string, unknown> = briefArgs(Object.fromEntries(Object.entries(args).filter(([k]) => !unknown.includes(k))));
    record(port, tool, { ...known, ...(unknown.length ? { unknown_args: unkShown } : {}) }, `${err.code} ${err.message}`);
    return errOut(err, va, { block: tb, line: port.turnLine(tb) });
  });
  // 呼び出しの時間の控え（S7 §52.1 の 2）: 受け取りから返すまで（引数の断りも、SDK の検査も、ハンドラも含む）。引数・トークン・考えは控えない
  timeCalls(server, (tool, args, startedAt, ms, err) => {
    const tok = (typeof args.player_token === 'string' ? args.player_token : undefined) ?? ctx.boundToken ?? undefined;
    const run = tok ? manager.portForToken(tok)?.runId ?? null : null;
    manager.calls.record({ at: new Date(startedAt).toISOString(), tool, run, ms, ...(err !== undefined ? { error: true as const } : {}) }, err);
  });
  return server;
}

/** tools/call の処理の時間を測る（interceptArgs の後に包む: 引数の断りの分も入る）。SDK の内部の形が違えば何もしない */
function timeCalls(server: McpServer, done: (tool: string, args: Record<string, unknown>, startedAt: number, ms: number, err?: unknown) => void): void {
  const inner = server.server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
  const orig = inner._requestHandlers?.get('tools/call');
  if (!inner._requestHandlers || !orig) return;
  inner._requestHandlers.set('tools/call', async (req, extra) => {
    const p = (req as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
    const t0 = Date.now();
    try {
      const r = await orig(req, extra);
      done(p?.name ?? '?', p?.arguments ?? {}, t0, Date.now() - t0);
      return r;
    } catch (e) {
      done(p?.name ?? '?', p?.arguments ?? {}, t0, Date.now() - t0, e ?? 'error');
      throw e;
    }
  });
}

/**
 * ツールの呼び出しを、SDK の入力の検査の前に受ける（S1c §14.4 の 2）。定義に無い名前の引数か、足りない要る引数があれば onBad の結果を返し、
 * 無ければ SDK の処理（検査・ハンドラ）へそのまま渡す。ツール一覧（tools/list）は変えない。
 * SDK 1.32.2 の内部（McpServer の _registeredTools・Server の _requestHandlers）を使う。形が違えば何もしない（今までどおり SDK が断る）
 */
function interceptArgs(server: McpServer, shapeFor: (tool: string, args: Record<string, unknown>, shape: Record<string, ZodTypeAny>) => Record<string, ZodTypeAny>, onBad: (tool: string, args: Record<string, unknown>, names: { unknown: string[]; missing: string[]; invalid: ArgIssue[] }, shape: Record<string, ZodTypeAny>) => ToolResult | Promise<ToolResult>): void {
  const inner = server.server as unknown as { _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>> };
  const tools = (server as unknown as { _registeredTools?: Record<string, { inputSchema?: unknown }> })._registeredTools;
  const orig = inner._requestHandlers?.get('tools/call');
  if (!inner._requestHandlers || !tools || !orig) return;
  inner._requestHandlers.set('tools/call', async (req, extra) => {
    const p = (req as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
    // ツールの名前は、登録した名前だけ（S12c: constructor などで、ふつうのオブジェクトの持ち物を引かない）
    const tool = p?.name && Object.hasOwn(tools, p.name) ? tools[p.name] : undefined;
    const shape0 = tool ? argShape(tool.inputSchema) : null;
    const shape = p?.name && shape0 ? shapeFor(p.name, p.arguments ?? {}, shape0) : shape0;
    if (p?.name && shape) {
      const pr = argProblems(shape, p.arguments);
      if (pr.unknown.length || pr.missing.length) return onBad(p.name, p.arguments ?? {}, { ...pr, invalid: [] }, shape);
      // 引数の形（型・値の範囲・選べる値）の誤り（S16d）: SDK の検査と同じ inputSchema で先に確かめ、同じ形の断りで返す
      // （SDK のままだと「Input validation error: …」の文だけで、ok・error・valid_actions・turn が無く、活動の記録にも残らない）
      const schema = tool?.inputSchema as { safeParseAsync?: (v: unknown) => Promise<{ success: boolean; error?: { issues?: ArgIssue[] } }> } | undefined;
      if (typeof schema?.safeParseAsync === 'function') {
        const res = await schema.safeParseAsync(p.arguments ?? {});
        if (!res.success && res.error?.issues?.length) return onBad(p.name, p.arguments ?? {}, { unknown: [], missing: [], invalid: res.error.issues }, shape);
      }
    }
    return orig(req, extra);
  });
}

/**
 * 観戦に流す文からトークンを除く（S3a §27.9 の 4）: player_token・profile_token の行を落とし、渡されたトークンの値が残っていれば伏せる。
 * 応答そのもの（呼んだ AI に返す文）は変えない
 */
export function withoutTokens(text: string, secrets: readonly unknown[] = []): string {
  let out = text.split('\n').filter((l) => !/^\s*(player_token|profile_token)\s*:/.test(l)).join('\n');
  for (const s of secrets) if (typeof s === 'string' && s.length >= 8) out = out.split(s).join('••••');
  return out;
}

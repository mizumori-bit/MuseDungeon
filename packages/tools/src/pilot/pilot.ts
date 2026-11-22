// pilot（IMPROVEMENTS_V4 §10、§14 で見直し）: AI とゲームの間に置く代行 bot の作例。
// 速いループ（このファイル）が方針（orders.json）の範囲で 1 手ずつ速く動かし、AI にしか決められないときだけ AI を起こす（遅いループ）。
// 決められることは pilot が決めて知らせる（notify）。起こして待つ間も、身を守る動きは自分でやる（§14.4）。
// ゲームの側は変えない。pilot はただのプレイヤーで、MCP の同じ道具を使い、ターンフィードで手番を受ける（参照ドライバ drive.ts と同じ口）。
// 決めるのは decide.ts（観測の構造化された項目と、pilot 自身の記録だけ。規則の知識は持たない）。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ObsMonster, ObsPartyMember, Observation, Pos, TurnBlock } from '@muse/shared';
import { readFeed } from '../drive';
import { afterAction, decide, fightArgs, fightNumbers, type FightStat, fightStatText, giveUpText, isRoleEnemy, leaderOf, lineWith, MOVE_TOOLS, newMemory, noteStage, NOTIFY_STOPS, type PilotMemory, throughVerdict, throwKindsOf, type TrapBlock, type TrapRef, trapLines, type Wake, type WakeLevel } from './decide';
import { defaultOrders, parseOrders, type PilotOrders, type QueuedCommand, writeJsonAtomic } from './orders';

/** 遠征ごとの結果（--dir の history.jsonl。1 遠征 1 行。V4-1e §19.3） */
/**
 * banked: 確定した点（遠征の結果の payout。ソロなら自分の分、協力プレイなら参加者の合計）。result.points（達成したときの基礎点）ではない。
 * slain・met・dealt・taken（V4-1f §22.2）: 目的の守護者を倒したか、目的の相手に会えたか（見えたか）、目的の相手に見た被害の最大、自分が受けた被害の合計
 */
export interface HistoryRow { no: number; slot: string | null; objective: { type: string; target_depth: number | null }; turns: number; banked: number; end: string; last_wake: string | null; slain?: boolean; met?: boolean; dealt?: number; taken?: number }
/**
 * 大守護者のもう一度の相談（V4-1f §22.2）: warden: engage にした時点（history の engageSince 行目）より後で、大守護者を目的にして倒さずに終わった遠征。
 * retryAfter 回以上なら、その遠征と大守護者の階を返す（上げる）。無ければ null
 */
export function wardenRetry(history: readonly HistoryRow[], engageSince: number, retryAfter: number): { depth: number; tries: HistoryRow[] } | null {
  const tries = history.slice(engageSince).filter((h) => h.objective.type === 'slay_warden' && !h.slain);
  const depth = tries.at(-1)?.objective.target_depth;
  return depth != null && tries.length >= retryAfter ? { depth, tries } : null;
}
/** wardenRetry で上げるときの detail */
export function wardenRetryDetail(r: { depth: number; tries: readonly HistoryRow[] }, self: { level: number; hp: number; max_hp: number }, fights: readonly FightStat[] = []): string {
  return [
    `節目の大守護者（地下 ${r.depth} 階）に挑むと決めた後、倒さずに ${r.tries.length} 回の遠征が終わった。続けて挑むなら orders.json の rev を上げる（policy.warden は "engage" のまま）、やめるなら "avoid"`,
    ...r.tries.map((h) => `遠征 ${h.no}: ${h.end}・相手に${h.met ? '会えた' : '会えなかった'}・相手に見た被害 ${h.dealt ?? 0}・受けた被害 ${h.taken ?? 0}・${h.turns} 手番`),
    // 前の戦いの数字（V4-1k §32.1）。弱点を読んで戦い方を決めるのは AI（policy.fight_with）
    ...(fights.length ? ['前の戦い（戦い方を先に決めるなら policy.fight_with: "throw_first"・"melee"・"auto"）:', ...fights.slice(-3).map((st) => `- ${fightStatText(st)}`)] : []),
    `レベル ${self.level}・HP ${self.hp}/${self.max_hp}`,
  ].join('\n');
}

/** 同じ理由の wake に、返事役が同じ返事を続けた回数を数えない理由（1 回きりの選択。§19.3） */
const STREAK_SKIP = new Set(['camp', 'perk_pending', 'boon_pending', 'orders_invalid']);

export interface PilotOptions {
  /** サーバーの起点 URL（例 http://127.0.0.1:7777。別の機械なら Tailscale の番地など） */
  baseUrl: string;
  token: string;
  /** 3 つのファイルの置き場所（省くと ./pilot-data/<run_id>/） */
  dir?: string;
  /** ソロか協力か（省くとランのモードから） */
  mode?: 'solo' | 'coop';
  /** 起こす経路: コマンド（標準入力に summary、環境変数 MUSE_PILOT_STATE に state.json のパス）か HTTP（POST）。どちらも無ければファイルと画面の表示だけ */
  wakeCmd?: string;
  wakeUrl?: string;
  /** 同じプロセスの中で起こされる相手（テスト・計測用。待たない） */
  onWake?: (w: WakeEvent) => void;
  /** 安全装置: pilot が出す命令の数・実時間・連続エラー */
  maxActions?: number;
  maxMs?: number;
  maxErrors?: number;
  /** orders.json を見に行く間隔（ミリ秒） */
  pollMs?: number;
  log?: (msg: string) => void;
  signal?: AbortSignal;
  /** 実時間の時計（ミリ秒。テストで差し替える。既定 Date.now）。最大の実時間と、仲間が何もしない時間（party_idle）に使う */
  now?: () => number;
  /** 通信が切れたときのやり直し（V4-1g §24.5）: 最初の間隔（既定 5 秒。倍々で 60 秒まで）と、あきらめるまでの実時間（既定 10 分） */
  retryBaseMs?: number;
  retryMaxMs?: number;
}

export interface PilotState {
  run_id: string;
  expedition_no: number | null;
  turn: number;
  orders_rev: number;
  /** waiting_party: キャンプで、仲間が迷宮から戻るのを待っている（V4-1f §22.5。行き詰まりにも空回りにも数えない） */
  /** waiting_join: 協力プレイのランに、ほかの参加者がまだいない（V4-1g §24.4） */
  /** acting: 命令を出して、結果（手番）を待っている（V4-1k §32.4 の ★9。協力では、相手の手番を待つ間はこのまま） */
  status: 'running' | 'acting' | 'waiting' | 'holding' | 'camp' | 'waiting_party' | 'waiting_join' | 'ended';
  /** level: notify / wake（返事役が答えてよい）/ escalate（返事役は答えない。AI か人間へ回す。V4-1e §19.1） */
  wake: { reason: string; level: WakeLevel; turn: number; detail: string } | null;
  /** いま効いている mode（return は、キャンプに着いたら同じ rev の間 auto。V4-1e §19.4） */
  mode: PilotOrders['mode'];
  self: { level: number; hp: number; max_hp: number; floor: number | null; pos: [number, number] | null };
  /** 観測の遠征の目的をそのまま */
  objective: NonNullable<Observation['expedition']>['objective'] | null;
  /** 最後の命令。source: pilot が自分で出したか、queue の命令か */
  last: { tool: string; args: Record<string, unknown>; stopped: string | null; turns: number; source: 'pilot' | 'queue' } | null;
  /** 見えている敵（観測の写し。§14.6） */
  hostiles: { id: string; name: string; pos: [number, number]; dist: number; hp_state: string; hunting: boolean; role: string | null; objective: boolean; ignored: boolean }[];
  /** 知っている階段（観測の navigation.known_stairs そのまま） */
  stairs: Observation['navigation']['known_stairs'];
  /** 今の階で見つけている罠（観測の visible.features のうち、公開カタログの分類が罠のもの。見えている罠と覚えている罠。V4-1d §18.1） */
  traps: { id: string; name: string; pos: [number, number]; dist: number }[];
  /** 仲間（観測の party の写し。V4-1f §22.4）と、ついていく相手の ID（§22.5。いなければ null） */
  party: ObsPartyMember[];
  follow: string | null;
  /** だれについていくか（V4-1j §30.1）: ついていく相手、self（自分が先頭。だれにもついていかない）、null（ソロ・まだ仲間がいない） */
  following: { id: string; name: string } | 'self' | null;
  /** いま戦っている相手と、倒す前に止まった回数（pilot の記録） */
  target: { id: string; stops: number } | null;
  /** 相手にしないと決めた敵の ID（pilot の記録。方針 ignore・unignore で書き換えられる） */
  ignored: string[];
  /** 立て直しの段の途中か（pilot の記録） */
  recovering: boolean;
  /** キャンプにいる間: 次の遠征の番号と候補（観測の camp の写し。start_expedition の offer に index を書く） */
  camp?: { next_no: number; offers: { index: number; slot: string | null; type: string; target_depth: number | null; points: number; recommended_level: number | null; text: string }[]; milestone?: { depth: number; name: string; cleared: boolean } };
  summary: string;
}

/** wakePath: 起こした時点の写し（--dir の wakes/<連番>.json。V4-1g §24.5） */
export interface WakeEvent extends Wake { state: PilotState; statePath: string; ordersPath: string; wakePath?: string }

export interface PilotResult {
  /** ended: ランが終わった / stopped: mode stop・stop_at_camp・止める合図 / safety: 安全装置 */
  outcome: 'ended' | 'stopped' | 'safety';
  reason: string;
  actions: number;
  wakes: Record<string, number>;
  /** 上げた（escalate）理由ごとの回数（V4-1e §19.1） */
  escalates: Record<string, number>;
  notifies: number;
  /** 知らせた理由ごとの回数 */
  notified: Record<string, number>;
  /** 進めた手番（pilot が自分で出した命令と、queue の命令） */
  turns: { pilot: number; queue: number };
}

interface CallResult { ok: boolean; data: Record<string, unknown>; text: string }

/** 断りのエラー（details.blocked_by: じゃまをしている見えている敵。V4-1a §12.3。blocked_by_traps: 道をふさいでいる罠。V4-1d §18.1） */
type CallError = { code: string; message: string; details?: { blocked_by?: string[]; blocked_by_traps?: TrapRef[]; stop?: string } };
/** 命令の結果から観測・turn・止まった理由を取り出す */
function payload(r: CallResult): { obs?: Observation; turn?: TurnBlock; stop?: string; outcome?: string; error?: CallError } {
  const d = r.data as { observation?: Observation; turn?: TurnBlock; interrupted_by?: string; outcome?: string; error?: CallError };
  return { obs: d.observation, turn: d.turn, stop: d.interrupted_by, outcome: d.outcome, error: d.error };
}

/** queue の命令が敵のせいで断られた（失敗にせず、敵に対応してからやり直す。§14.5） */
const ENEMY_REFUSALS = new Set(['hostile_adjacent', 'hostile_in_view']);
/** 進み具合を数える命令（§14.2 の 4: 階の探索も撃破も進まない命令が 8 回続いたら stuck）。休む・待つ・帰るは数えない */
const PROGRESS_TOOLS = new Set(['explore', 'travel_to', 'collect', 'fight', 'attack', 'move', 'use_stairs']);
const NO_PROGRESS_MAX = 8;
/** 手番が進まない命令が、1 つの手番にこの回数続いたら行き詰まり（V4-1i B1。決まりごとは 3 回で、その手番は使わない） */
const NO_TURN_MAX = 6;
/** 命令も知らせも出さないまま、この実時間が過ぎたら上げる（V4-1i B7） */
const SILENT_MS = 2 * 60000;
/** キャンプでも意味のある起こし方（キャンプに戻っても返事を待ち続ける）。ほかは迷宮でのことなので、キャンプに戻ったら待つのをやめる（V4-1i B7） */
const CAMP_WAKES = new Set(['camp', 'warden_decision', 'stalled', 'party_down', 'party_idle', 'perk_pending', 'boon_pending', 'orders_invalid', 'safety', 'not_getting_through']);

/**
 * pilot に渡すトークン（V4-1i §28.2 の 4）: --token-file（ファイルの 1 行目）、環境変数 MUSE_PLAYER_TOKEN、--token の順。
 * --token はコマンドの記録（シェルの履歴・プロセスの一覧・起動したスクリプトのログ）に残るので、ファイルか環境変数で渡す。pilot 自身の記録・写し・知らせにはトークンを出さない
 */
export function pilotToken(o: { token?: string; tokenFile?: string; env?: Record<string, string | undefined> }): string | undefined {
  if (o.tokenFile) {
    const t = readFileSync(o.tokenFile, 'utf-8').split(/\r?\n/)[0]?.trim();
    if (!t) throw new Error(`token file is empty: ${o.tokenFile}`);
    return t;
  }
  const e = o.env?.MUSE_PLAYER_TOKEN?.trim();
  if (e) return e;
  return o.token?.trim() || undefined;
}

export async function runPilot(opts: PilotOptions): Promise<PilotResult> {
  const log = opts.log ?? (() => undefined);
  const pollMs = opts.pollMs ?? 500;
  const maxActions = opts.maxActions ?? 5000;
  const maxMs = opts.maxMs ?? 6 * 60 * 60 * 1000;
  const maxErrors = opts.maxErrors ?? 5;
  const now = opts.now ?? Date.now;
  const t0 = now();
  const result: PilotResult = { outcome: 'stopped', reason: '', actions: 0, wakes: {}, escalates: {}, notifies: 0, notified: {}, turns: { pilot: 0, queue: 0 } };

  // ---- ゲームへの口（MCP）。表示の文は短く、所持品はいつも構造化して受け取る ----
  let client = new Client({ name: 'muse-pilot', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', opts.baseUrl)));
  const rawCall = async (tool: string, args: Record<string, unknown>): Promise<CallResult> => {
    const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };
    const data = r.structuredContent ?? {};
    const ok = !r.isError && (data as { ok?: boolean }).ok !== false;
    return { ok, data, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  };
  // 通信が切れたら、間を空けてやり直す（V4-1g §24.5）: 5 秒から倍々で 60 秒まで。MCP のつなぎ直しとプレイヤーの束縛（resume_run）もやり直す。
  // 実時間で 10 分つながらなければ、あきらめる（connLost。本体のループが safety で上げて終える）
  const retryBase = opts.retryBaseMs ?? 5000;
  const retryMax = opts.retryMaxMs ?? 10 * 60000;
  let connLost = false;
  let reconnects = 0;
  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const reconnect = async () => {
    try { await client.close(); } catch { /* もう閉じている */ }
    client = new Client({ name: 'muse-pilot', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', opts.baseUrl)));
    const r = await rawCall('resume_run', { player_token: opts.token, map: 'never', inventory: 'always' });
    if (!r.ok) throw new Error(`resume_run failed: ${r.text}`);
    reconnects++;
    log(`[pilot] reconnected (${reconnects})`);
    restartFeed?.();
  };
  let restartFeed: (() => void) | null = null;
  const call = async (tool: string, args: Record<string, unknown>): Promise<CallResult> => {
    try { return await rawCall(tool, args); } catch (e0) {
      const since = now();
      let wait = retryBase;
      opts.log?.(`[pilot] ${tool} failed (${(e0 as Error).message}); retrying`);
      for (;;) {
        if (opts.signal?.aborted || connLost) throw e0;
        if (now() - since >= retryMax) { connLost = true; throw new Error(`connection lost for ${Math.round((now() - since) / 60000)} min: ${(e0 as Error).message}`); }
        await pause(wait);
        wait = Math.min(wait * 2, 60000);
        try { await reconnect(); return await rawCall(tool, args); } catch { /* まだつながらない */ }
      }
    }
  };
  const resumed = await call('resume_run', { player_token: opts.token, map: 'never', inventory: 'always' });
  if (!resumed.ok) { await client.close(); throw new Error(`resume_run failed: ${resumed.text}`); }
  const runId = String((resumed.data as { run_id?: string }).run_id ?? '');
  // 公開カタログ（GET /api/content/catalog）の分類: 投げる武器の品の種類と、罠の地物の種類（V4-1d §18.1・§18.2。品や罠の名前では探さない）
  const throwKinds = new Set<string>();
  const trapKinds = new Set<string>();
  /** 通れない地形の名前（地図 get_map の凡例を読む。V4-1k §32.2） */
  const blockNames = new Set<string>();
  try {
    const res = await fetch(new URL('/api/content/catalog', opts.baseUrl));
    const cat = (await res.json()) as { items?: Record<string, { category?: string }>; features?: Record<string, { category?: string }>; terrain?: Record<string, { name?: { ja?: string; en?: string }; passable?: boolean }> };
    const short = (id: string) => id.split(':')[1] ?? id;
    for (const [id, it] of Object.entries(cat.items ?? {})) if (it.category === 'throwing') { throwKinds.add(id); throwKinds.add(short(id)); }
    for (const [id, f] of Object.entries(cat.features ?? {})) if (f.category === 'trap') trapKinds.add(id);
    for (const tr of Object.values(cat.terrain ?? {})) if (tr.passable === false) for (const n of [tr.name?.ja, tr.name?.en]) if (n) blockNames.add(n);
  } catch (e) { log(`[pilot] catalog failed (no throwing, traps only from refusals): ${(e as Error).message}`); }
  let obs = (resumed.data as { observation: Observation }).observation;
  let turn = (resumed.data as { turn: TurnBlock }).turn;
  let text = resumed.text;
  const dir = resolve(opts.dir ?? join('pilot-data', runId));
  mkdirSync(dir, { recursive: true });
  const ordersPath = join(dir, 'orders.json');
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'log.jsonl');
  // pilot 自身の記録で、起動し直しても残すもの（V4-1e §19.2・§19.3・§19.5）: ランを通して 1 回だけの鍵と、遠征ごとの結果
  const memoryPath = join(dir, 'memory.json');
  // 起こす・知らせるたびに、その時点の写しを wakes/<連番>.json に残す（V4-1g §24.5。返事役は state.json を読み直さなくてよい）
  const wakesDir = join(dir, 'wakes');
  mkdirSync(wakesDir, { recursive: true });
  let wakeSeq = 0;
  try { for (const f of readdirSync(wakesDir)) { const n = Number(f.replace(/\.json$/, '')); if (Number.isFinite(n) && n > wakeSeq) wakeSeq = n; } } catch { /* 無い */ }
  const historyPath = join(dir, 'history.jsonl');
  const onceKeys = new Set<string>();
  /** queue の命令のうち、済ませた数（その rev の。起動し直したときに、済ませた命令をくり返さない） */
  let savedQueue: { rev: number; done: number } | null = null;
  /** 階（深さ）ごとの、pilot が立ったマス（遠征をまたぐ。見回りの行き先。V4-1f §22.1）。1 階につき 400 まで */
  const walked = new Map<string, Pos[]>();
  /** 空回りの数え始め（history の何行目から数えるか。stalled に返事が来たら 0 に戻す。§22.3）と、warden: engage にした時点（§22.2） */
  let stallBase = 0;
  let engageSince: number | null = null;
  /** 相手ごとの戦いの記録（V4-1k §32.1。キーは「遠征:相手」。遠征をまたいで残し、大守護者の相談に数字を出す。50 件まで） */
  const fightStats = new Map<string, FightStat>();
  try {
    const m = JSON.parse(readFileSync(memoryPath, 'utf-8')) as { once?: string[]; queue?: { rev: number; done: number }; walked?: Record<string, [number, number][]>; stall_base?: number; engage_since?: number | null; fights?: FightStat[] };
    for (const f of m.fights ?? []) if (f && typeof f.id === 'string') fightStats.set(`${f.exp}:${f.id}`, f);
    for (const k of m.once ?? []) onceKeys.add(k);
    if (m.queue && typeof m.queue.rev === 'number' && typeof m.queue.done === 'number') savedQueue = m.queue;
    for (const [d, cells] of Object.entries(m.walked ?? {})) walked.set(d, cells.map(([x, y]) => ({ x, y })));
    if (typeof m.stall_base === 'number') stallBase = m.stall_base;
    if (typeof m.engage_since === 'number') engageSince = m.engage_since;
  } catch { /* 無い・壊れている */ }
  let queueMark: { rev: number; done: number } | null = savedQueue;
  const saveMemory = () => writeJsonAtomic(memoryPath, {
    run_id: runId, once: [...onceKeys], ...(queueMark ? { queue: queueMark } : {}), stall_base: stallBase, engage_since: engageSince,
    walked: Object.fromEntries([...walked].map(([d, cells]) => [d, cells.map((c) => [c.x, c.y])])),
    fights: [...fightStats.values()].slice(-50),
  });
  const history: HistoryRow[] = [];
  try { for (const l of readFileSync(historyPath, 'utf-8').split('\n')) if (l.trim()) history.push(JSON.parse(l) as HistoryRow); } catch { /* 無い */ }
  log(`[pilot] run ${runId}, files in ${dir}`);
  let coop = opts.mode === 'coop';
  if (!opts.mode) {
    const runs = (await call('list_runs', {})).data as { runs?: { run_id: string; mode: string }[] };
    coop = runs.runs?.find((r) => r.run_id === runId)?.mode === 'coop';
  }

  // ---- ターンフィード（協力プレイで他の人の番の間、次の手番を待つ） ----
  const ac = new AbortController();
  const feed = { signal: null as (() => void) | null };
  const startFeed = () => {
    void (async () => {
      try {
        const res = await fetch(new URL('/api/player/feed', opts.baseUrl), { headers: { authorization: `Bearer ${opts.token}` }, signal: ac.signal });
        if (!res.ok || !res.body) return;
        for await (const ev of readFeed(res)) { if (ev.type !== 'hello') feed.signal?.(); }
      } catch { /* 切れた（つなぎ直したら、もう一度つなぐ） */ }
    })();
  };
  startFeed();
  restartFeed = startFeed;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const waitFeed = (ms: number) => new Promise<void>((r) => { const t = setTimeout(() => { feed.signal = null; r(); }, ms); feed.signal = () => { clearTimeout(t); feed.signal = null; r(); }; });

  // ---- 方針 ----
  let orders: PilotOrders;
  let ordersError: string | null = null;
  /** 起動の時点で壊れていた orders.json の中身（同じ中身で起こし直さない） */
  let startBadText = '';
  if (!existsSync(ordersPath)) { orders = defaultOrders(); writeJsonAtomic(ordersPath, orders); }
  else {
    const raw0 = readFileSync(ordersPath, 'utf-8');
    try { orders = parseOrders(JSON.parse(raw0)); } catch (e) { orders = defaultOrders(); ordersError = (e as Error).message; startBadText = raw0; }
  }
  // 起動し直した: 同じ rev の queue の、済ませた命令は飛ばす（V4-1e の確かめで分かった: 起動し直すと、済んだ start_expedition をもう一度出していた）
  let queue: QueuedCommand[] = savedQueue && savedQueue.rev === orders.rev ? orders.queue.slice(savedQueue.done) : [...orders.queue];
  /** queue の済ませた数を memory.json に残す */
  const markQueue = () => { queueMark = { rev: orders.rev, done: orders.queue.length - queue.length }; saveMemory(); };
  /** queue の先頭の命令を、敵のせいで断られてやり直した回数（3 回まで。§14.5） */
  let queueRetries = 0;
  let lastBadText = startBadText;
  /** 起こして返事を待っている（rev が変わるまで）。homeward: hold_max_turns が過ぎて帰る側へ倒した */
  /** farDamage: 起こしてから、隣でない相手から受けた被害の合計（最大 HP の 4 分の 1 を超えたら帰る側へ倒す。V4-1c §17.4） */
  let waiting = null as { key: string; also: string[]; reason: string; sinceTurn: number; cond: boolean; homeward: boolean; wake: Wake; farDamage: number } | null;
  /** キャンプで、仲間が迷宮から戻るのを待っている（V4-1f §22.5）・ほかの参加者が入るのを待っている（V4-1g §24.4） */
  let waitingParty = false;
  let waitingJoin = false;
  /** この遠征で、相手にしない敵に撃たれて出た階（V4-1g §24.2 の 2） */
  let avoidDepths = new Set<number>();
  let avoidExp: number | null = null;
  /** 遠征ごとの、相手にしない敵に撃たれて出た階と、その相手（V4-1h §26.3: 同じ相手にまた撃たれたら戻らない） */
  let leftBy = new Map<number, Set<string>>();
  /** 安全装置に達したが、協力プレイで迷宮にいるので、帰ってから終える（V4-1g §24.4。猶予は実時間で 3 分） */
  let closing = null as { reason: string; until: number } | null;
  /** 仲間の観測の写し（状態・階・見えていれば位置と HP）と、それが最後に変わった実時間（party_idle。§23.8） */
  let partySig = '';
  /** 仲間ごとの、最後に見た行動の数え（観測の party[].last_act。V4-1j §30.6） */
  const partyLast = new Map<string, number>();
  /** 知らせた「ついていく相手」（V4-1j §30.1。相手の ID か self） */
  let followingNoted: string | null = null;
  /** 覚えている地図の通れるマス（遠征と階ごと。V4-1k §32.2） */
  let mapCache = null as { key: string; cells: Pos[] } | null;
  /** 通っていないのでやめた目的の相手（V4-1k §32.1）: その遠征は帰り、キャンプで not_getting_through を上げる */
  let notThrough = null as { target: string; exp: number; rev: number; detail: string } | null;
  /** 命令を出して、結果を待っている（state.json の status: acting。V4-1k §32.4 の ★9） */
  let acting = false;
  let partyChangedAt = now();
  /** 上げた party_idle（仲間が最後に動いた時刻ごとに 1 回） */
  const partyIdleRaised = new Set<string>();
  /** この遠征の記録（history.jsonl の met・dealt・taken。V4-1f §22.2） */
  let expTrack = { no: null as number | null, met: false, dealt: 0, taken: 0 };
  /** mode: return でキャンプに着いた rev（同じ rev の間は auto として扱う。V4-1e §19.4） */
  let returnDoneRev: number | null = null;
  // danger を上げて「帰る」に切り替えた（V4-1i §28.2 の 1）: 同じ rev の間は return（AI が rev を上げたら、そちらに従う。キャンプに着いたら終わり）
  const dangerHomeNow = () => mem.dangerHome !== null && mem.dangerHome === orders.rev && obs.status !== 'at_camp' && orders.mode === 'auto';
  // 危ないときの「帰る」（§28.2 の 1）。綱は、倒されうる間だけ、回復の手段の後に使う（判断の表の 7。V4-1j §30.2）。倒されうる状態でなくなった後の
  // 帰り道は、方針の allow_lifeline のとおり（既定では綱を使わず、追われていても階段へ）
  /** 通らない目的の相手から帰る（その遠征。AI が rev を上げたら、そちらに従う） */
  const notThroughHomeNow = () => !!notThrough && notThrough.exp === obs.expedition?.no && notThrough.rev === orders.rev && obs.status !== 'at_camp' && orders.mode === 'auto';
  const effOrders = (): PilotOrders => (closing ? { ...orders, mode: 'stop_at_camp' } : dangerHomeNow() || notThroughHomeNow() ? { ...orders, mode: 'return' } : orders.mode === 'return' && returnDoneRev === orders.rev ? { ...orders, mode: 'auto' } : orders);
  /** 同じ理由の wake に、返事役が同じ返事をした回数（遠征ごと。3 回を超えたら、次は stalled で上げる。V4-1e §19.3） */
  let streak = null as { exp: number | null; reason: string; sig: string; count: number } | null;
  /** 遠征ごとの、最後に起こした理由（history.jsonl に残す） */
  const lastWakeOf = new Map<number, string>();
  /** AI が返事をした、観測の条件からの起こし方（条件が続く間は、同じことで起こさない） */
  const acked = new Set<string>();
  /** 遺物・役割のある敵への返事は、同じ遠征の同じ階にいる間は覚えておく */
  const ackedScope = new Map<string, string>();
  const scopeNow = () => `${obs.expedition?.no ?? ''}:${obs.status === 'at_camp' ? 'camp' : obs.self.floor?.depth ?? ''}`;
  const ENTITY_KEY = /^(relic_seen|guardian_seen|warden_seen|elite_seen)(_hunting)?:/;
  /** 知らせた鍵（同じ階で 1 回だけのもの）と、知らせたときの遠征と階 */
  const notified = new Map<string, string>();
  /** 手番が進まないまま同じ起こし方をくり返した回数（3 回を超えたら stuck、stuck もくり返したら安全装置で終える） */
  const repeats = new Map<string, { turn: number; count: number }>();
  let stuckOut = false;
  /** 同じ命令が同じ止まり方で止まった回数（移動のマクロ。4 回目は stuck） */
  let sameStop = { sig: '', count: 0 };
  /** この手番で断られた道具と fight の相手（手番が進んだら空にする） */
  /** trap: この手番に、罠にふさがれて断られた最初の道具と、その罠（V4-1d §18.1） */
  const refused = { turn: -1, tools: new Set<string>(), targets: new Set<string>(), last: null as { code: string; text: string; blockedBy?: string[]; traps?: TrapRef[] } | null, trap: null as TrapBlock | null };
  /** 断りのエラーの blocked_by_traps の罠（位置と方角）と blocked_by の敵の、観測の文の行（起こす・知らせるときに detail の先頭に添える。V4-1a §13.8・V4-1d §18.1。pilot は自分からは戦わない） */
  const blockedLines = (e?: CallError) => [...trapLines(obs, text, e?.details?.blocked_by_traps ?? []), ...(e?.details?.blocked_by ?? []).map((id) => lineWith(text, id))].filter(Boolean);
  /** 今の階で見つけている罠（観測の写し） */
  const trapsNow = () => obs.visible.features.filter((f) => f.id && trapKinds.has(f.type));
  // ---- pilot 自身の記録（§14.2〜§14.4） ----
  let mem: PilotMemory = newMemory();
  /** AI が ignore に書いた敵（unignore まで、遠征の間は相手にしない） */
  const aiIgnored = new Set<string>();
  // 起動の時点の orders.json の ignore も効かせる（V4-1g の確かめで分かった: rev を上げたときだけ読んでいたので、起動の前に書いた ignore が効いていなかった）
  for (const id of orders.policy.ignore) aiIgnored.add(id);
  /** この階で諦めた敵 */
  let gaveUp = new Set<string>();
  /** 階（遠征と深さ）ごとの、階段へ退いた回数 */
  const stairRetreats = new Map<string, number>();
  /** この階で立ったマス（進み具合）と、進み具合の無い命令の数 */
  let visited = new Set<string>();
  let noProgress = 0;
  let memScope = scopeNow();
  let prev = { hp: obs.self.hp, turn: turn.turn_no, adjAwake: false, scope: memScope };
  let lastNotify = turn.turn_no;
  let last: PilotState['last'] = null;
  let lastTarget: string | null = null;
  let lastOutcome = '';
  let errors = 0;
  let stuck = 0;
  /** 最後に命令を出した・知らせた実時間（V4-1i B7: 黙って 2 分過ぎたら上げる）と、その黙りでもう上げたか */
  let lastActivity = now();
  let silentRaised = false;
  /** この手番で、手番が進まなかった命令の数（決まり why ごとと全部。V4-1i B1） */
  const noTurn = { turn: -1, byWhy: new Map<string, number>(), total: 0, blocked: new Set<string>() };
  /** キャンプで待つ理由を知らせたか（V4-1i B7: 待つ理由を知らせに出す） */
  let waitNoted: string | null = null;

  const ignoredNow = () => [...new Set([...gaveUp, ...aiIgnored])];
  // 起こして返事を待つ間は、待っている起こし方を state.json に残す（持ち場の動きで書き直しても消えない）
  /** だれについていくか（V4-1j §30.1）。協力プレイで、迷宮かキャンプに仲間がいるときだけ */
  const followingNow = (): PilotState['following'] => {
    if (!coop || !(obs.party ?? []).some((m) => m.status === 'in_dungeon' || m.status === 'at_camp')) return null;
    const l = leaderOf(obs, orders.policy);
    return l ? { id: l.id, name: l.name } : 'self';
  };
  const stateOf = (status: PilotState['status'], w0: Wake | null): PilotState => { const w = w0 ?? waiting?.wake ?? null; return {
    run_id: runId, expedition_no: obs.expedition?.no ?? null, turn: turn.turn_no, orders_rev: orders.rev, status,
    wake: w ? { reason: w.reason, level: w.level, turn: turn.turn_no, detail: w.detail } : null,
    mode: effOrders().mode,
    self: { level: obs.self.level, hp: obs.self.hp, max_hp: obs.self.max_hp, floor: obs.self.floor?.depth ?? null, pos: obs.self.pos ? [obs.self.pos.x, obs.self.pos.y] : null },
    objective: obs.expedition?.objective ?? null,
    last,
    hostiles: obs.visible.monsters.map((m) => ({ id: m.id, name: m.name, pos: [m.pos.x, m.pos.y] as [number, number], dist: m.dist, hp_state: m.hp_state, hunting: m.awareness === 'hunting' && !m.fleeing, role: m.role ?? (isRoleEnemy(m) ? 'elite' : null), objective: !!m.objective, ignored: ignoredNow().includes(m.id) })),
    stairs: obs.navigation.known_stairs,
    traps: trapsNow().map((f) => ({ id: f.id!, name: f.name, pos: [f.pos.x, f.pos.y] as [number, number], dist: f.dist })),
    party: obs.party ?? [],
    follow: leaderOf(obs, orders.policy)?.id ?? null,
    following: followingNow(),
    target: lastTarget && obs.visible.monsters.some((m) => m.id === lastTarget) ? { id: lastTarget, stops: mem.stops[lastTarget] ?? 0 } : null,
    ignored: ignoredNow(),
    recovering: mem.recovering,
    ...(obs.status === 'at_camp' && obs.camp ? { camp: { next_no: obs.camp.next_no, offers: obs.camp.offers.map((o) => ({ index: o.index, slot: o.slot ?? null, type: o.type, target_depth: o.target_depth, points: o.points, recommended_level: o.recommended_level, text: o.text })),
      ...(obs.camp.milestone ? { milestone: { depth: obs.camp.milestone.depth, name: obs.camp.milestone.name, cleared: obs.camp.milestone.cleared } } : {}) } } : {}),
    // 観測の文の行をそのまま（pilot は言い換えない）: 状態の 1 行・直前の結果・起こした理由の行
    summary: [obs.summary, lineWith(text, '仲間: '), lastOutcome, w?.detail ?? ''].filter(Boolean).join('\n'),
  }; };
  const statusNow = (): PilotState['status'] => obs.status === 'at_camp' ? (waitingJoin && !waiting ? 'waiting_join' : waitingParty && !waiting ? 'waiting_party' : 'camp') : waiting ? (coop ? 'holding' : 'waiting') : acting ? 'acting' : 'running';
  /** state.json は、中身が変わったときだけ書き直す（返事を待つ間に毎回書き直すと、Windows で、読みに来た相手や相手の orders.json の置き換えとぶつかる。V4-1e の --wake-cmd のテストで分かった） */
  let lastStateJson = '';
  const writeState = () => {
    const st = stateOf(statusNow(), null);
    const j = JSON.stringify(st);
    if (j === lastStateJson) return;
    lastStateJson = j;
    writeJsonAtomic(statePath, st);
  };
  const appendLog = (row: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), turn: turn.turn_no, ...row })}\n`);

  /** 起こす・知らせる: state.json を書いてから経路を呼ぶ。相手の終了は待たない */
  /** at: 起こすと決めた時点の写し（命令の後に出す知らせでも、手番・HP・state は決めた時点のもの。V4-1i B4） */
  const raise = (w: Wake, status?: PilotState['status'], at?: { turn: number; hp: number; max_hp: number; state: PilotState }) => {
    const st = stateOf(status ?? statusNow(), w);
    writeJsonAtomic(statePath, st);
    lastStateJson = JSON.stringify(st);
    lastActivity = now();
    appendLog({ wake: w.reason, level: w.level, detail: w.detail });
    if (w.level === 'wake') result.wakes[w.reason] = (result.wakes[w.reason] ?? 0) + 1;
    else if (w.level === 'escalate') result.escalates[w.reason] = (result.escalates[w.reason] ?? 0) + 1;
    else { result.notifies++; result.notified[w.reason] = (result.notified[w.reason] ?? 0) + 1; }
    log(`[pilot] ${w.level} ${w.reason}: ${w.detail.split('\n')[0]}`);
    // ランを通して 1 回だけの鍵（目的でない遺物・守護者・強敵の知らせ、上げた大守護者）は、起動し直しても残す
    const keys = [w.key, ...(w.also ?? [])].filter((k) => (w.level === 'notify' && /^(relic_seen|seen):/.test(k)) || (w.level === 'escalate' && k.startsWith('warden_decision:')));
    if (keys.length) { for (const k of keys) onceKeys.add(k); saveMemory(); }
    if (w.level !== 'notify' && obs.expedition && obs.status !== 'at_camp') lastWakeOf.set(obs.expedition.no, w.reason);
    // 起こした時点の写し（理由・段・手番・HP・detail・summary・state）。古い写しは 1000 件を超えたら消す
    const n = ++wakeSeq;
    const wakePath = join(wakesDir, `${String(n).padStart(6, '0')}.json`);
    const snapshot = { n, level: w.level, reason: w.reason, key: w.key, turn: at?.turn ?? turn.turn_no, hp: at?.hp ?? obs.self.hp, max_hp: at?.max_hp ?? obs.self.max_hp, detail: w.detail, summary: (at?.state ?? st).summary, state: at?.state ?? st };
    writeJsonAtomic(wakePath, snapshot);
    if (n > 1000) { try { rmSync(join(wakesDir, `${String(n - 1000).padStart(6, '0')}.json`), { force: true }); } catch { /* 消せなくてもよい */ } }
    const env = { ...process.env, MUSE_PILOT_STATE: statePath, MUSE_PILOT_ORDERS: ordersPath, MUSE_PILOT_WAKE: wakePath, MUSE_PILOT_LEVEL: w.level, MUSE_PILOT_REASON: w.reason };
    if (opts.wakeCmd) {
      try {
        // 相手の終了は待たない（unref）。Windows では detached にすると、起動したコマンドが動かないまま残る（--wake-cmd のテストで分かった）ので、
        // Windows では detached にせず、窓も出さない
        const child = spawn(opts.wakeCmd, { shell: true, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'], env });
        child.on('error', (e) => log(`[pilot] wake command failed: ${e.message}`));
        // 標準入力には、起こした時点の写し（JSON。summary も入っている）
        child.stdin?.end(`${JSON.stringify(snapshot)}\n`);
        child.unref();
      } catch (e) { log(`[pilot] wake command failed: ${(e as Error).message}`); }
    }
    if (opts.wakeUrl) {
      void fetch(opts.wakeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...snapshot, state_path: statePath, orders_path: ordersPath, wake_path: wakePath }) })
        .catch((e) => log(`[pilot] wake url failed: ${(e as Error).message}`));
    }
    opts.onWake?.({ ...w, state: st, statePath, ordersPath, wakePath });
  };
  const note = (reason: string, detail: string, key = `${reason}:${turn.turn_no}`) => raise({ level: 'notify', reason, key, detail });
  /** 起こす。手番が進まないまま同じ起こし方が 3 回を超えたら stuck に、stuck もくり返したら終える */
  const wakeNow = (w: Wake, cond = false, at?: { turn: number; hp: number; max_hp: number; state: PilotState }) => {
    // 同じ理由の wake に、返事役が同じ返事を 3 回続けた（この遠征の中で）: 4 回目は返事役に渡さず、上げる（V4-1e §19.3）
    if (w.level === 'wake' && streak && streak.count >= 3 && streak.reason === w.reason && streak.exp === (obs.expedition?.no ?? null)) {
      w = { level: 'escalate', reason: 'stalled', key: `stalled:streak:${turn.turn_no}`, detail: `${w.reason} で起こし、返事役が同じ返事を ${streak.count} 回続けた（同じやり取りが回り続けている）。返事: ${streak.sig}\n${w.detail}` };
    }
    // 上げる段（danger など）も、手番が進まないまま同じ上げ方に 3 回返事が来たら、4 回目は stalled にする（V4-1g の測り直しで分かった: 追い詰められて
    // danger を上げ、返事が来るたびに同じ手番で上げ直して、回り続けた）。stalled もくり返したら終える
    if (w.level === 'escalate' && w.reason !== 'safety' && w.reason !== 'ended') {
      const r = repeats.get(w.key);
      const count = r && r.turn === turn.turn_no ? r.count + 1 : 1;
      repeats.set(w.key, { turn: turn.turn_no, count });
      if (count > 3) {
        const sk = `stalled:repeat:${turn.turn_no}`;
        const rs = repeats.get(sk);
        const c2 = rs && rs.turn === turn.turn_no ? rs.count + 1 : 1;
        repeats.set(sk, { turn: turn.turn_no, count: c2 });
        if (c2 > 1 || w.reason === 'stalled') { stuckOut = true; return; }
        w = { level: 'escalate', reason: 'stalled', key: sk, detail: `${w.reason} で ${count - 1} 回上げて返事が来たが、手番が進まない（同じやり取りが回り続けている）。別の手を queue に書くか、mode を変える\n${w.detail}` };
      }
    }
    if (w.level === 'wake') {
      const r = repeats.get(w.key);
      const count = r && r.turn === turn.turn_no ? r.count + 1 : 1;
      repeats.set(w.key, { turn: turn.turn_no, count });
      if (count > 3) {
        if (w.reason === 'stuck') { stuckOut = true; return; }
        w = { level: 'wake', reason: 'stuck', key: `stuck:${turn.turn_no}`, detail: `${w.reason} で ${count - 1} 回起こしたが、手番が進まない: ${w.detail}` };
        const rs = repeats.get(w.key);
        const c2 = rs && rs.turn === turn.turn_no ? rs.count + 1 : 1;
        repeats.set(w.key, { turn: turn.turn_no, count: c2 });
        if (c2 > 3) { stuckOut = true; return; }
      }
    }
    raise(w, undefined, at);
    if (w.level !== 'notify') waiting = { key: w.key, also: w.also ?? [], reason: w.reason, sinceTurn: turn.turn_no, cond, homeward: false, wake: w, farDamage: 0 };
  };

  /** rev が変わっていれば読み直す（壊れた JSON は読まず、前の方針のまま起こす）。変わったら true */
  const reloadOrders = (): boolean => {
    let raw: string;
    try { raw = readFileSync(ordersPath, 'utf-8'); } catch { return false; }
    let next: PilotOrders;
    try { next = parseOrders(JSON.parse(raw)); } catch (e) {
      if (raw !== lastBadText) { lastBadText = raw; wakeNow({ level: 'wake', reason: 'orders_invalid', key: `orders_invalid:${raw.length}`, detail: (e as Error).message }); }
      return false;
    }
    lastBadText = '';
    if (next.rev === orders.rev) return false;
    // 返事役の返事を数える（同じ理由の wake に同じ返事。上げた後の返事は数え直す。V4-1e §19.3）
    if (waiting && waiting.wake.level === 'wake' && !STREAK_SKIP.has(waiting.reason)) {
      const sig = JSON.stringify({ mode: next.mode, queue: next.queue, policy: { ...next.policy, ignore: [], unignore: [] }, camp: next.camp });
      const exp = obs.expedition?.no ?? null;
      streak = streak && streak.exp === exp && streak.reason === waiting.reason && streak.sig === sig ? { ...streak, count: streak.count + 1 } : { exp, reason: waiting.reason, sig, count: 1 };
    } else if (waiting && waiting.wake.level === 'escalate') streak = null;
    // 空回り（stalled）に返事が来た: rev が上がっただけでも再開し、空回りの数えを 0 に戻す（V4-1f §22.3）。大守護者の相談の返事なら、engage の数え直し（§22.2）
    if (waiting && waiting.reason === 'stalled') { stallBase = history.length; saveMemory(); }
    if (waiting && waiting.reason === 'warden_decision') { engageSince = next.policy.warden === 'engage' ? history.length : null; saveMemory(); }
    // 仲間が倒れた（party_down）に返事が来た: その仲間については、ランを通して、もう上げない（V4-1m C1。起動し直しても同じ）
    if (waiting && waiting.reason === 'party_down') {
      for (const id of waiting.key.replace(/^party_down:camp:/, '').split(',').filter(Boolean)) onceKeys.add(`party_down:${id}`);
      saveMemory();
    }
    orders = next;
    queue = [...next.queue];
    queueRetries = 0;
    // 相手にしない敵を AI が書き換える（§14.6。rev を上げたときに一度だけ効く）
    for (const id of next.policy.ignore) aiIgnored.add(id);
    for (const id of next.policy.unignore) { aiIgnored.delete(id); gaveUp.delete(id); delete mem.stops[id]; }
    if (waiting?.cond) {
      for (const k of [waiting.key, ...waiting.also]) { acked.add(k); if (ENTITY_KEY.test(k)) ackedScope.set(k, scopeNow()); }
    }
    waiting = null;
    appendLog({ orders_rev: next.rev, mode: next.mode, queue: next.queue.length });
    return true;
  };

  /** 観測が新しくなったら、pilot の記録を更新する（階を移ったら数え直す・歩いた跡・隣でない相手からの被害） */
  const observeMemory = () => {
    const scope = scopeNow();
    if (scope !== memScope) {
      // 階を移っても、ついていく相手の記録は遠征の間残す
      const keep = { recovering: mem.recovering, crossed: mem.crossed, follow: mem.follow, assisting: mem.assisting, assistArrived: mem.assistArrived, dangerHome: mem.dangerHome, dangerJoin: mem.dangerJoin, dangerJoinHp: mem.dangerJoinHp, dangerRecover: mem.dangerRecover, apart: mem.apart };
      // 歩いたマスを残す（階を移るたび）
      saveMemory();
      mem = { ...newMemory(), ...keep };
      gaveUp = new Set();
      visited = new Set();
      noProgress = 0;
      memScope = scope;
      if (obs.expedition?.no !== Number(prev.scope.split(':')[0])) { aiIgnored.clear(); stairRetreats.clear(); mem.crossed = null; mem.recovering = false; mem.dangerHome = null; mem.dangerJoin = 'none'; mem.dangerJoinHp = 0; mem.dangerRecover = 'none'; }
    }
    mem.stairRetreats = stairRetreats.get(scope) ?? 0;
    const pos = obs.self.pos;
    if (pos) {
      const lastPos = mem.trail[mem.trail.length - 1];
      if (!lastPos || lastPos.x !== pos.x || lastPos.y !== pos.y) { mem.trail.push({ x: pos.x, y: pos.y }); if (mem.trail.length > 60) mem.trail.shift(); }
      // この階で立ったマス（遠征をまたぐ。見回りの行き先。V4-1f §22.1）
      const d = String(obs.self.floor?.depth ?? '');
      const cells = walked.get(d) ?? [];
      if (!cells.some((c) => c.x === pos.x && c.y === pos.y)) { cells.push({ x: pos.x, y: pos.y }); if (cells.length > 400) cells.shift(); walked.set(d, cells); }
    }
    // この遠征の記録（目的の相手に会えたか・見た被害・受けた被害。V4-1f §22.2）
    const xno = obs.expedition && obs.status !== 'at_camp' ? obs.expedition.no : null;
    if (xno !== null) {
      if (expTrack.no !== xno) expTrack = { no: xno, met: false, dealt: 0, taken: 0 };
      for (const m of obs.visible.monsters.filter((mm) => mm.objective)) { expTrack.met = true; expTrack.dealt = Math.max(expTrack.dealt, m.damage_seen ?? 0); }
      if (prev.scope.split(':')[0] === String(xno) && obs.self.hp < prev.hp) expTrack.taken += prev.hp - obs.self.hp;
    }
    // 相手にしないと決めた敵に撃たれた（V4-1g §24.2 の 2・V4-1h §26.3）: HP が減り、追ってくる相手にしない敵が見えていて、隣に相手にしない敵以外の起きている敵がいない。
    // 階段で階を出る。1 回目は、休んだ後に 1 回戻る。戻って同じ相手にまた撃たれたら、この遠征では、その階に戻らない
    if (xno !== avoidExp) { avoidExp = xno; avoidDepths = new Set(); leftBy = new Map(); }
    if (scope === prev.scope && obs.self.hp < prev.hp && !mem.leaveFloor && obs.self.floor) {
      const ig = new Set(ignoredNow());
      const shooter = obs.visible.monsters.find((m) => ig.has(m.id) && m.awareness === 'hunting' && !m.fleeing);
      const adjOther = obs.visible.monsters.some((m) => m.dist <= 1 && m.awareness !== 'asleep' && !ig.has(m.id));
      if (shooter && !adjOther) {
        const d = obs.self.floor.depth;
        const again = leftBy.get(d)?.has(shooter.id) ?? false;
        leftBy.set(d, new Set([...(leftBy.get(d) ?? []), shooter.id]));
        mem.leaveFloor = true;
        if (again) avoidDepths.add(d);
        note('leave_floor', [lineWith(text, shooter.id), `相手にしないと決めた ${shooter.name} に撃たれた（HP ${prev.hp}→${obs.self.hp}）。階段でこの階（地下 ${d} 階）を出る。${again ? '戻ってまた撃たれたので、この遠征では戻らない' : '休んだ後に 1 回戻る'}`].filter(Boolean).join('\n'));
      }
    }
    // 仲間の動き（§23.8）: 仲間が行動したら（観測の party[].last_act が変わったら。V4-1j §30.6）、その時刻を覚える。party_idle で上げて待っている間に
    // 動いたら、待つのをやめて知らせる。見えていない仲間・別の階の仲間も、last_act で分かる（V4-1i では状態・階・位置で代えていた）
    const moved = (obs.party ?? []).some((m) => partyLast.get(m.id) !== m.last_act) || partyLast.size !== (obs.party ?? []).length;
    for (const m of obs.party ?? []) partyLast.set(m.id, m.last_act);
    const sig = moved ? `${partySig.length}:${now()}` : partySig;
    if (sig !== partySig) {
      partySig = sig;
      partyChangedAt = now();
      if (waiting?.reason === 'party_idle') {
        waiting = null;
        note('party_active', [lineWith(text, '仲間: '), '仲間が動いた。上げた party_idle の返事を待つのをやめて、続ける'].filter(Boolean).join('\n'));
      }
    }
    // だれについていくかを知らせる（V4-1j §30.1）: 起動のときと、決まった・変わったとき。AI 同士の組では、先に入った者が先頭になる
    {
      const f = followingNow();
      const fk = f === null ? null : f === 'self' ? 'self' : f.id;
      if (fk !== null && fk !== followingNoted) {
        followingNoted = fk;
        const fl = orders.policy.coop.follow;
        const ctl = (c: string) => (c === 'human' ? '人間' : c === 'agent' ? 'AI' : '不明');
        const lm = f !== 'self' && f ? (obs.party ?? []).find((m) => m.id === f.id) : undefined;
        note('following', f === 'self'
          ? `自分が先頭（だれにもついていかない。coop.follow: ${fl}${fl === 'auto' ? '。auto は、人間の仲間がいなければ、参加がいちばん早い者を先頭にする' : ''}）。AI 同士で組むときは、手で遊ぶ側の名前を coop.follow に書く`
          : `ついていく相手: ${f!.name}［${ctl(lm?.controller ?? 'unknown')}］（参加の順 ${lm?.order ?? '?'}。coop.follow: ${fl}）`, `following:${fk}:${turn.turn_no}`);
      }
    }
    // ついていく相手（V4-1f §22.5）: 遠征ごとに記録し直す。同じ階で見えた位置、この遠征で迷宮にいたか、同じ階にいたことがあるか
    const leader = obs.status !== 'at_camp' ? leaderOf(obs, orders.policy) : null;
    if (!leader) mem.follow = null;
    else {
      if (!mem.follow || mem.follow.id !== leader.id || mem.follow.exp !== xno) mem.follow = { id: leader.id, exp: xno, met: false, inDungeon: false, lastPos: null, lastFloor: leader.floor ?? null, floorAtStart: leader.floor ?? null, startTurn: turn.turn_no };
      const f = mem.follow;
      const myDepth = obs.self.floor?.depth ?? null;
      if (leader.status === 'in_dungeon') f.inDungeon = true;
      if (leader.floor !== undefined && leader.floor === myDepth) f.met = true;
      if ((leader.floor ?? null) !== f.lastFloor) f.lastPos = null;
      f.lastFloor = leader.floor ?? null;
      // 最後に見た位置は、見えていた（エンティティがある）ときだけ（V4-1k: 位置は見えていなくても出るようになった。見えていない所は覚えていないマスのこともある）
      if (leader.pos && leader.entity) f.lastPos = { x: leader.pos[0], y: leader.pos[1] };
    }
    // 隣でない相手から被害を受けた: HP が減ったのに、前にも今にも起きている敵が隣にいない（観測の構造化された項目だけで決める。§14.9）
    const adjAwake = obs.visible.monsters.some((m) => m.dist <= 1 && m.awareness !== 'asleep');
    const passed = turn.turn_no - prev.turn;
    if (scope === prev.scope && obs.self.hp < prev.hp && !adjAwake && !prev.adjAwake) {
      mem.hurtFarAgo = 0;
      // 起こして返事を待つ間に受けた、隣でない相手からの被害を数える（数え始めは起こした時点）
      if (waiting && obs.status !== 'at_camp') waiting.farDamage += prev.hp - obs.self.hp;
    }
    else if (mem.hurtFarAgo !== null && passed > 0) mem.hurtFarAgo += passed;
    prev = { hp: obs.self.hp, turn: turn.turn_no, adjAwake, scope };
    mem.ignored = ignoredNow();
  };
  /** 進み具合（新しいマスに立った・階を移った・倒した）。8 回続けて無ければ stuck */
  const progressed = (killed: boolean): boolean => {
    const pos = obs.self.pos;
    const cell = pos ? `${scopeNow()}:${pos.x},${pos.y}` : '';
    const fresh = !!cell && !visited.has(cell);
    if (cell) visited.add(cell);
    return fresh || killed;
  };

  /** 1 つの命令を出して、観測を新しくする。失敗（拒否）は観測を取り直す */
  /** count: false なら命令の上限に数えない（仲間を待つ待つ命令。§23.8） */
  const act = async (tool: string, args: Record<string, unknown>, source: 'pilot' | 'queue', count = true, why?: string): Promise<{ ok: boolean; stop?: string; error?: CallError }> => {
    const before = turn.turn_no;
    lastActivity = now();
    silentRaised = false;
    // 記録用: fight の標的が、見れば分かる特徴「飛び道具」を持つか（離れて撃つ敵の計測。V4-1d §18.3）
    const ranged = tool === 'fight' && !!obs.visible.monsters.find((m) => m.id === args.target)?.traits?.includes('ranged');
    const fightBefore = tool === 'fight' ? obs.visible.monsters.find((m) => m.id === args.target) : undefined;
    const hpBefore = obs.self.hp;
    // 命令を出す前にも state.json を書く（協力では、相手の手番を待つ間は結果が返らないので、何をしているかが分からなかった。V4-1k §32.4 の ★9）
    acting = true;
    writeState();
    let r: CallResult;
    try {
      r = await call(tool, { ...args, thought: `[pilot] ${source === 'queue' ? 'queue: ' : ''}${tool}` });
      errors = 0;
    } catch (e) {
      acting = false;
      errors++;
      log(`[pilot] ${tool} failed (${errors}/${maxErrors}): ${(e as Error).message}`);
      return { ok: false, error: { code: 'call_failed', message: (e as Error).message } };
    }
    acting = false;
    if (count) result.actions++;
    const p = payload(r);
    if (p.obs) { obs = p.obs; text = r.text; }
    if (p.turn) turn = p.turn;
    if (!r.ok || !p.obs) {
      // 見直しの observe も、通信が切れて諦めた（connLost）ときは例外を外へ出さない（本体のループが safety で上げて終える。V4-1h の続きで見つけた:
      // 断られた命令の直後に切れると、runPilot が例外で終わっていた）
      const o = await call('observe', {}).catch(() => null);
      const op = (o?.data ?? {}) as { observation?: Observation; turn?: TurnBlock };
      if (op.observation && o) { obs = op.observation; text = o.text; }
      if (op.turn) turn = op.turn;
    }
    const steps = Math.max(0, turn.turn_no - before);
    result.turns[source] += steps;
    lastOutcome = p.outcome ?? (p.error ? `${p.error.code}: ${p.error.message}` : '');
    last = { tool, args, stopped: p.stop ?? (r.ok ? null : p.error?.code ?? 'error'), turns: steps, source };
    if (tool === 'fight' && typeof args.target === 'string') lastTarget = args.target;
    if (tool === 'fight' && r.ok && fightBefore) recordFight(fightBefore, hpBefore);
    appendLog({ source, tool, args, ok: r.ok, stopped: last.stopped, steps, hp: obs.self.hp, max_hp: obs.self.max_hp, ...(why ? { why } : source === 'queue' ? { why: 'queue' } : {}), ...(ranged ? { ranged: true } : {}) });
    observeMemory();
    return { ok: r.ok, stop: p.stop, error: p.error };
  };

  /**
   * fight の結果の文から、相手ごとに近接と投擲の当てた回数・与えた被害を数え、通っているかを判定する（V4-1k §32.1）。
   * 通っていない（throughVerdict が give_up）: 目的の相手なら、その遠征は帰り、キャンプで not_getting_through を上げる。目的でなければ相手にしない
   */
  const recordFight = (before: ObsMonster, hpBefore: number) => {
    const nums = fightNumbers(lastOutcome);
    if (!nums) return;
    const exp = obs.expedition?.no ?? null;
    const key = `${exp}:${before.id}`;
    const st: FightStat = fightStats.get(key) ?? { id: before.id, name: before.name, exp, depth: obs.self.floor?.depth ?? null, warden: !!before.guardian?.warden, objective: !!before.objective, stage0: null, stageM0: null, stageT0: null, stage: before.hp_state, mHits: 0, mDealt: 0, tHits: 0, tDealt: 0, selfHp0: null, selfHp: null };
    // 近接と投擲が混ざった呼び出し（投げて、隣に来たら近接）は、回数の割合で分ける
    const sw = nums.melee + nums.throws;
    const tH = sw ? Math.round((nums.hits * nums.throws) / sw) : 0;
    const tD = sw ? Math.round((nums.dealt * nums.throws) / sw) : 0;
    if (st.stage0 === null && nums.hits > 0) st.stage0 = before.hp_state;
    if (st.stageT0 === null && tH > 0) st.stageT0 = before.hp_state;
    if (st.stageM0 === null && nums.hits - tH > 0) st.stageM0 = before.hp_state;
    if (st.selfHp0 === null) st.selfHp0 = hpBefore;
    st.mHits += nums.hits - tH; st.mDealt += nums.dealt - tD; st.tHits += tH; st.tDealt += tD;
    st.selfHp = obs.self.hp;
    const now0 = obs.visible.monsters.find((m) => m.id === before.id);
    if (now0) noteStage(st, now0.hp_state);
    fightStats.delete(key);
    fightStats.set(key, st);
    if (!now0) return;
    const canThrow = throwKindsOf(obs, throwKinds).length > 0;
    // やめるかは、倒すまでの見込み（観測の残りの体力の目安 ÷ 1 回あたりの被害）で決める（V4-1l §34.1）
    const est = now0.hp_left_est ?? null;
    if (throughVerdict(st, orders.policy, canThrow, est) !== 'give_up') return;
    const why0 = giveUpText(st, orders.policy, est, canThrow);
    const detail = [lineWith(text, before.id), fightStatText(st), why0].filter(Boolean).join('\n');
    if (st.objective && exp !== null) {
      if (notThrough?.target === before.id && notThrough.exp === exp) return;
      notThrough = { target: before.id, exp, rev: orders.rev, detail };
      note('not_getting_through', `${detail}\n目的の相手に通っていないので、戦いをやめて帰る（キャンプで not_getting_through を上げる。戦い方を変えるなら policy.fight_with、やめる見込みの回数は policy.give_up_hits）`, `not_getting_through:${key}`);
    } else if (!gaveUp.has(before.id)) {
      gaveUp.add(before.id);
      mem.ignored = ignoredNow();
      note('not_getting_through', `${detail}\n通っていないので、この階にいる間は相手にしない`, `not_getting_through:${key}`);
    }
  };

  /**
   * fight が倒す前に止まった・断られた（§14.2）: 相手ごとに数える。auto なら寄ってやり直す相手に、hp_floor なら立て直しへ。
   * give_up_after に達したら、目的でない相手は相手にしない（知らせる）。目的の相手は起こす（AI が決める）
   */
  const fightStopped = (target: string | undefined, reason: string, detail: string, o: { recover: boolean; advance: boolean; count: boolean }) => {
    if (o.recover) mem.recovering = true;
    // 逃げた（V4-1i §28.2 の 3）: 次は投げる武器を持たせてやり直す（持っていなければ、今までどおり）
    if (reason === 'fight_target_fled' && target && !mem.fled.includes(target)) mem.fled.push(target);
    // 待つ間に標的でない相手に撃たれた（V4-1d §18.2）: 撃ってきた相手（見えていて追跡中の、飛び道具の特徴を持つ、隣でない、役割の無い敵。
    // 射線の通る相手を先に、近い順）が見えていれば、次の fight の標的にする。見えていなければ、1 回来た道を戻る
    // 待つ間に、標的でない隣の敵に殴られた（V4-1m C5）: 殴ってきた隣の敵（追跡中・役割の無い敵を先に。名前が結果の文にある敵を先に）と、次に戦う。
    // 同じ止まり方で、同じ fight を出し直さない（8 回くり返して stuck になっていた）
    if (reason === 'fight_hit_while_waiting') {
      const ignoredSet = new Set(ignoredNow());
      const adj = obs.visible.monsters.filter((m) => m.id !== target && m.dist <= 1 && m.awareness === 'hunting' && !ignoredSet.has(m.id))
        .sort((a, b) => (isRoleEnemy(a) ? 1 : 0) - (isRoleEnemy(b) ? 1 : 0) || (detail.includes(a.name) ? 0 : 1) - (detail.includes(b.name) ? 0 : 1));
      const hitter = adj[0];
      if (hitter) { mem.hitBy = hitter.id; note(reason, [lineWith(text, hitter.id), detail, `殴ってきた ${hitter.name} ${hitter.id} と戦う（倒したら、もとの相手に戻る）`].filter(Boolean).join('\n')); }
      else note(reason, detail);
      return;
    }
    if (reason === 'fight_shot_while_waiting') {
      const ignoredSet = new Set(ignoredNow());
      const shooter = obs.visible.monsters
        .filter((m) => m.id !== target && m.awareness === 'hunting' && !m.fleeing && m.dist > 1 && m.traits?.includes('ranged') && !isRoleEnemy(m) && !ignoredSet.has(m.id))
        .sort((a, b) => (a.shot === 'clear' ? 0 : 1) - (b.shot === 'clear' ? 0 : 1) || a.dist - b.dist)[0];
      if (shooter) { mem.shotBy = shooter.id; note(reason, [lineWith(text, shooter.id), `${detail}`, `撃ってきた ${shooter.name} ${shooter.id} に標的を替える`].filter(Boolean).join('\n')); }
      else { mem.backOff = true; note(reason, `${detail}\n撃ってきた相手が見えないので、来た道を戻る`); }
      return;
    }
    // 目的の相手は、HP の止まり方も数える（勝てない相手かを AI に決めてもらう。V4-1c の計測: 挑み直し続けて倒れた）
    const isObjective = !!target && !!obs.visible.monsters.find((x) => x.id === target)?.objective;
    if (!target || !(o.count || (isObjective && o.recover))) { note(reason, detail); return; }
    mem.stops[target] = (mem.stops[target] ?? 0) + 1;
    if (o.advance && orders.policy.approach === 'auto' && !mem.advance.includes(target)) mem.advance.push(target);
    // 離れたままの相手（諦める前の最後のやり直しで、投げる品を使う。V4-1d §18.2）
    if (o.advance && !mem.away.includes(target)) mem.away.push(target);
    const m = obs.visible.monsters.find((x) => x.id === target);
    if (mem.stops[target]! >= orders.policy.give_up_after) {
      if (m?.objective) { wakeNow({ level: 'wake', reason: 'gave_up', key: `gave_up:${target}:${mem.stops[target]}`, detail: [lineWith(text, target), detail].filter(Boolean).join('\n') }); return; }
      if (!gaveUp.has(target)) {
        gaveUp.add(target);
        mem.ignored = ignoredNow();
        note('gave_up', [lineWith(text, target), `${mem.stops[target]} 回倒す前に止まったので、この階にいる間は相手にしない: ${detail}`].filter(Boolean).join('\n'), `gave_up:${target}`);
        return;
      }
    }
    note(reason, detail);
  };

  const finish = async (outcome: PilotResult['outcome'], reason: string): Promise<PilotResult> => {
    result.outcome = outcome;
    result.reason = reason;
    ac.abort();
    await client.close().catch(() => undefined);
    return result;
  };

  observeMemory();
  writeState();
  if (ordersError) wakeNow({ level: 'wake', reason: 'orders_invalid', key: 'orders_invalid:start', detail: ordersError });
  for (;;) {
    if (opts.signal?.aborted) return finish('stopped', 'signal');
    // 安全装置（参照ドライバと同じ）: 遠征は終わらせない
    // 通信が実時間で 10 分つながらない（V4-1g §24.5）: 上げて終える（帰ることもできない）
    if (connLost || errors >= maxErrors) {
      const reason = connLost ? 'connection' : 'errors';
      raise({ level: 'escalate', reason: 'safety', key: 'safety', detail: `安全装置（${reason}${connLost ? `: サーバーに ${Math.round(retryMax / 60000)} 分つながらない` : ''}）に達したので pilot を終える。${obs.status !== 'at_camp' && obs.self.floor ? `迷宮（地下 ${obs.self.floor.depth} 階）に残った` : ''}\n${obs.summary}` }, 'ended');
      return finish('safety', reason);
    }
    if (!closing && (result.actions >= maxActions || now() - t0 > maxMs || stuckOut)) {
      const reason = result.actions >= maxActions ? 'max_actions' : stuckOut ? 'stuck' : 'max_time';
      // 協力プレイで自分が迷宮にいる: 終える前に帰る（迷宮に残ると、仲間が次の遠征を始められない。V4-1g §24.4）。猶予は実時間で 3 分
      if (coop && obs.status !== 'at_camp' && obs.status !== 'ended' && obs.status !== 'dead') {
        closing = { reason, until: now() + 3 * 60000 };
        queue = [];
        note('closing', `安全装置（${reason}）に達した。協力プレイで迷宮にいるので、帰ってから終える（猶予は実時間で 3 分）`);
      } else {
        // 黙って終えずに上げる（V4-1e §19.3）
        raise({ level: 'escalate', reason: 'safety', key: 'safety', detail: `安全装置（${reason}）に達したので pilot を終える。${obs.summary}` }, 'ended');
        return finish('safety', reason);
      }
    }
    if (closing && (obs.status === 'at_camp' || now() > closing.until)) {
      const home = obs.status === 'at_camp';
      raise({ level: 'escalate', reason: 'safety', key: 'safety', detail: `安全装置（${closing.reason}）に達したので pilot を終える。${home ? '帰ってから終えた（キャンプにいる）' : `帰る猶予（3 分）に間に合わず、迷宮（地下 ${obs.self.floor?.depth ?? '?'} 階）に残った`}\n${obs.summary}` }, 'ended');
      return finish('safety', closing.reason);
    }
    // キャンプに戻ったのに、迷宮で起こした（キャンプでは意味の無い）返事を待っている: 待つのをやめて、キャンプの判断（camp で起こす・待つ理由を出す）へ（V4-1i B7:
    // 迷宮で上げた escalate の返事を待ったまま、キャンプで 8 分、何も知らせずに止まった）
    if (waiting && obs.status === 'at_camp' && !CAMP_WAKES.has(waiting.reason)) {
      note('back_at_camp', `${waiting.reason} の返事を待っていたが、キャンプに戻った。待つのをやめて、キャンプの判断へ進む`, `back_at_camp:${waiting.key}`);
      waiting = null;
    }
    // 黙って止まらない（V4-1i B7）: 命令も知らせも出さないまま実時間で 2 分過ぎたら、いまの状態を添えて上げる（pilot は止めない。黙りが続く間は 1 回だけ）
    // 上げた（escalate）返事を待っている間は数えない（待つ理由は、もう知らせてある。V4-1m C2: party_down の返事を待つ間に 5 回重なった）
    if (!silentRaised && !(waiting && waiting.wake.level === 'escalate') && now() - lastActivity >= SILENT_MS) {
      silentRaised = true;
      raise({ level: 'escalate', reason: 'safety', key: `safety:silent:${Math.floor(now() / 1000)}`, detail: [`${Math.round((now() - lastActivity) / 60000)} 分、命令も知らせも出していない（pilot は止まっていない）。いまの状態: ${statusNow()}${waiting ? `（${waiting.reason} の返事を待っている）` : ''}`, obs.summary].join('\n') });
    }
    // 3. rev が変わったら読み直す
    reloadOrders();
    if (orders.mode === 'stop') { writeJsonAtomic(statePath, stateOf('ended', null)); return finish('stopped', 'mode_stop'); }
    // 1. ランが終わった（queue より先）
    if (turn.state === 'run_ended' || obs.status === 'ended' || obs.status === 'dead') {
      // ランが終わった（死んだ・引退した）: AI か人間に届ける（V4-1g §24.2 の 4）
      raise({ level: 'escalate', reason: 'ended', key: 'ended', detail: obs.summary }, 'ended');
      return finish('ended', obs.status === 'dead' ? 'dead' : 'run_ended');
    }
    // 帰ってから終える（§14.7）: キャンプに着いたら終える
    if (orders.mode === 'stop_at_camp' && obs.status === 'at_camp') { writeJsonAtomic(statePath, stateOf('ended', null)); return finish('stopped', 'stop_at_camp'); }
    // 帰ってから続ける（V4-1e §19.4）: キャンプに着いたら、同じ rev の間は auto
    if (orders.mode === 'return' && obs.status === 'at_camp' && returnDoneRev !== orders.rev) { returnDoneRev = orders.rev; appendLog({ mode_return_done: orders.rev }); }
    // キャンプに着いた: 終えた遠征の結果を history.jsonl に残す（V4-1e §19.3）
    if (obs.status === 'at_camp' && obs.expedition?.result && !history.some((h) => h.no === obs.expedition!.no)) {
      const x = obs.expedition;
      const pay = (x.result as { payout?: { banked: number; players: { banked: number }[] } }).payout;
      const banked = pay ? (pay.players.length === 1 ? pay.players[0]!.banked : pay.banked) : 0;
      const tr = expTrack.no === x.no ? expTrack : { met: false, dealt: 0, taken: 0 };
      const row: HistoryRow = { no: x.no, slot: x.slot ?? null, objective: { type: x.objective.type, target_depth: x.objective.target_depth }, turns: x.result!.turns, banked, end: x.result!.reason, last_wake: lastWakeOf.get(x.no) ?? null,
        slain: !!x.progress.guardian_slain, met: tr.met, dealt: tr.dealt, taken: tr.taken };
      history.push(row);
      appendFileSync(historyPath, `${JSON.stringify(row)}\n`);
      // 大守護者に挑むと決めた後、倒さずに warden_retry_after 回終わった: もう一度上げる（V4-1f §22.2。返事が来るまでキャンプで待つ）
      if (orders.policy.warden === 'engage') {
        if (engageSince === null) engageSince = history.length - 1;
        const wr = wardenRetry(history, engageSince, orders.policy.warden_retry_after);
        const key = wr ? `warden_decision:${wr.depth}:retry:${engageSince}:${wr.tries.length}` : '';
        if (wr && !onceKeys.has(key)) wakeNow({ level: 'escalate', reason: 'warden_decision', key, detail: wardenRetryDetail(wr, obs.self, [...fightStats.values()].filter((st) => st.warden && st.depth === wr.depth)) });
      } else engageSince = null;
      saveMemory();
    }
    // 他の人の番（協力プレイ）: 次の手番を待つ
    if (turn.state === 'waiting_others') {
      await waitFeed(1000);
      const o = await call('observe', {}).catch(() => null);
      const op = o?.data as { observation?: Observation; turn?: TurnBlock } | undefined;
      if (op?.observation) { obs = op.observation; text = o!.text; }
      if (op?.turn) turn = op.turn;
      observeMemory();
      continue;
    }
    if (refused.turn !== turn.turn_no) { refused.turn = turn.turn_no; refused.tools.clear(); refused.targets.clear(); refused.last = null; refused.trap = null; }
    if (noTurn.turn !== turn.turn_no) { noTurn.turn = turn.turn_no; noTurn.byWhy.clear(); noTurn.total = 0; noTurn.blocked.clear(); }
    // 4. queue（AI が明示した 1 回きりの命令。キャンプでも先に実行する。§14.5）
    if (queue.length && !refused.tools.has('queue') && !closing) {
      const q = queue[0]!;
      // 選ぶ特技・加護が残っていない choose_perk・choose_boon は、断られる前に捨てる（queue_failed を出さない。V4-1m C4: 同じ特技に 2 回積まれた）
      const choice = q.tool === 'choose_perk' ? 'perk_pending' : q.tool === 'choose_boon' ? 'boon_pending' : null;
      if (choice && !obs.alerts.some((al) => al.code === choice)) {
        appendLog({ source: 'queue', tool: q.tool, args: q.args ?? {}, ok: false, why: 'queue_dropped', detail: `${choice} が無いので捨てた（もう選んである）` });
        queue.shift(); markQueue(); queueRetries = 0;
        continue;
      }
      // queue の fight に hp_floor が無ければ、方針の値（wake_hp_pct）を使う
      const args: Record<string, unknown> = q.tool === 'fight' && q.args?.hp_floor === undefined ? { ...(q.args ?? {}), hp_floor: Math.floor((obs.self.max_hp * orders.policy.wake_hp_pct) / 100) } : { ...(q.args ?? {}) };
      const haulBefore = obs.expedition?.haul?.text ?? '';
      const r = await act(q.tool, args, 'queue');
      // queue の命令で綱を使った（AI か返事役が書いた。V4-1e §19.4: どちらが綱を選んだかを記録に残す）
      if (r.ok && q.tool === 'use_item' && args.slot === 'lifeline') note('lifeline_used', ['queue の命令で使った（AI か返事役が書いた）', haulBefore ? `持ち帰っていない戦利品: ${haulBefore}` : ''].filter(Boolean).join('\n'));
      // 敵のせいで断られた: 失敗にしない。この手番は表のとおりに敵へ対応し、次の手番でやり直す（3 回まで）
      if (!r.ok && r.error && ENEMY_REFUSALS.has(r.error.code) && queueRetries < 3) {
        queueRetries++;
        refused.tools.add('queue');
        note('queue_retry', [...blockedLines(r.error), `${q.tool}: ${r.error.code}（${queueRetries}/3。敵に対応してからやり直す）`].join('\n'));
      } else {
        const failed = !r.ok;
        const aa = failed ? null : afterAction(q.tool, r.stop);
        const stoppedShort = !!aa && (aa.kind === 'fight' || aa.kind === 'wake');
        if (aa?.kind === 'fight') fightStopped(typeof args.target === 'string' ? args.target : undefined, aa.reason, lastOutcome || obs.summary, aa);
        if (aa?.kind === 'recover') mem.recovering = true;
        if (failed || stoppedShort) {
          // 失敗（または倒す前に止まった）: discard は残りを捨て、skip はその命令だけ捨てる。どちらも知らせるだけ（§14.5）
          if (orders.policy.queue_on_fail === 'skip') queue.shift(); else queue = [];
          markQueue();
          queueRetries = 0;
          if (failed) {
            // queue の fight が断られた: hp_floor は立て直しへ、ほか（届かない・ふさがれた）は決着しないに数える（V4-1g §24.3）
            if (args.target && q.tool === 'fight' && r.error) fightStopped(String(args.target), `refused_${r.error.code}`, lastOutcome, { recover: r.error.code === 'hp_floor', advance: false, count: r.error.code !== 'hp_floor' });
            note('queue_failed', [...blockedLines(r.error), `${q.tool}: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`.trim()].join('\n'));
          } else if (aa?.kind === 'wake') wakeNow({ level: 'wake', reason: aa.reason, key: `${aa.reason}:${turn.turn_no}`, detail: lastOutcome || obs.summary });
        } else { queue.shift(); markQueue(); queueRetries = 0; }
        writeState();
        continue;
      }
    }
    // 起こして待っている（§14.4）: hold_max_turns が過ぎたら、帰る側へ倒す（くり返し起こさない）
    // party_idle（仲間が何もしない）で上げたときは、自分からは帰らない（置いて帰るかは AI が決める。§23.8）
    if (waiting && waiting.reason !== 'party_idle' && obs.status !== 'at_camp' && !waiting.homeward && turn.turn_no - waiting.sinceTurn >= orders.policy.hold_max_turns) {
      waiting.homeward = true;
      note('no_reply', `${waiting.reason}（${turn.turn_no - waiting.sinceTurn} 手番返事が無い）。階段へ行き、帰る側へ倒す`, `no_reply:${waiting.key}`);
    }
    // 起こして待つ間に撃たれ続けた（隣でない相手からの被害の合計が最大 HP の 4 分の 1 を超えた。ゲームの steady が止まる線と同じ）:
    // hold_max_turns を待たずに、帰る側へ倒す（V4-1c §17.4。no_reply と分けて under_fire で知らせる）
    if (waiting && obs.status !== 'at_camp' && !waiting.homeward && waiting.farDamage * 4 > obs.self.max_hp) {
      waiting.homeward = true;
      note('under_fire', `${waiting.reason} の返事を待つ間に、隣でない相手から ${waiting.farDamage} の被害を受けた（最大 HP の 4 分の 1 を超えた）。階段へ行き、帰る側へ倒す`, `under_fire:${waiting.key}`);
    }
    // 経過を知らせる
    const every = orders.policy.notify_every_turns;
    if (every > 0 && turn.turn_no - lastNotify >= every) {
      lastNotify = turn.turn_no;
      note('periodic', obs.summary);
    }
    const scope = scopeNow();
    for (const [k, sc] of [...notified]) if (sc !== scope) notified.delete(k);
    mem.ignored = ignoredNow();
    // 空回り（V4-1e §19.3）: キャンプで、直近の stall_after 回の遠征がどれも「確定 0」か「10 手番以内」
    const n = orders.policy.stall_after;
    const recent = history.slice(stallBase).slice(-n);
    const stalled = obs.status === 'at_camp' && n > 0 && recent.length >= n && recent.every((h) => h.banked === 0 || h.turns <= 10)
      ? [`直近 ${n} 回の遠征が、どれも確定 0 か 10 手番以内に終わった（空回り）。次の遠征を自動で始めずに止まる。続けるなら queue に start_expedition を書く（方針を変えるなら policy も）:`,
        ...recent.map((h) => `遠征 ${h.no}（${h.slot ?? '-'}・${h.objective.type}${h.objective.target_depth !== null ? ` 地下 ${h.objective.target_depth} 階` : ''}）: ${h.turns} 手番・確定 ${h.banked}・${h.end}・最後に起こした理由 ${h.last_wake ?? 'なし'}`)].join('\n')
      : null;
    const wardenTries: Record<string, number> = {};
    for (const h of history) if (h.objective.type === 'slay_warden' && h.objective.target_depth !== null) wardenTries[String(h.objective.target_depth)] = (wardenTries[String(h.objective.target_depth)] ?? 0) + 1;
    // 探していて、この階に探索できる所が残っていない: 覚えている地図（get_map。手番を使わない）の通れるマスを、見回り先の候補に渡す（V4-1k §32.2）。
    // 遠征と階ごとに 1 回取る（見終えた階なので、地図はもう変わらない）
    const xo = obs.expedition;
    let mapCells: Pos[] | undefined;
    const seekMap = obs.status !== 'at_camp' && xo?.status === 'in_progress' && SEEK_OBJECTIVES.has(xo.objective.type) && xo.objective.target_depth === (obs.self.floor?.depth ?? null)
      && !obs.navigation.frontiers.length && !(obs.navigation.unsighted ?? 0);
    // 協力プレイで、同じ階の仲間が見えていない: 仲間の今の位置が覚えていないマスなら、覚えているいちばん近い所へ向かう（V4-1k §32.3）。地図は 10 手番ごとに取り直す
    const allyMap = coop && obs.status !== 'at_camp' && (obs.party ?? []).some((m) => m.status === 'in_dungeon' && m.floor === (obs.self.floor?.depth ?? null) && !!m.pos && !m.entity);
    if (xo && (seekMap || allyMap)) {
      const key = seekMap ? `${xo.no}:${obs.self.floor?.depth}` : `${xo.no}:${obs.self.floor?.depth}:${Math.floor(turn.turn_no / 10)}`;
      if (mapCache?.key !== key) {
        const r = await call('get_map', {}).catch(() => null);
        // 今いる所から、通れるマスでつながっている所だけ（見えていても行けないマスを、見回り先にしない）
        mapCache = { key, cells: r?.ok && obs.self.pos ? connectedCells(mapCellsOf(r.data, blockNames), obs.self.pos) : [] };
      }
      mapCells = mapCache.cells;
    }
    const { decision, active, notify, update } = decide(obs, {
      orders: effOrders(), coop, waiting: !!waiting, homeward: !!waiting?.homeward || !!closing, acked, text, once: onceKeys, stalled, wardenTries,
      walked: walked.get(String(obs.self.floor?.depth ?? '')) ?? [], turnNo: turn.turn_no, avoidDepths,
      refused: refused.tools, refusedTargets: refused.targets, refusal: refused.last, notified: new Set(notified.keys()), mem,
      trapBlock: refused.trap, throwKinds, blockedWhys: noTurn.blocked, ...(mapCells ? { mapCells } : {}),
      fightStats, ...(notThrough && notThrough.exp === obs.expedition?.no ? { noThrough: new Set([notThrough.target]) } : {}),
    });
    if (update) {
      Object.assign(mem, update);
      if (update.stairRetreats !== undefined) stairRetreats.set(scope, update.stairRetreats);
    }
    // 知らせる（同じ階で 1 回だけのものは、鍵を覚える）
    for (const n of notify) {
      raise(n);
      for (const k of [n.key, ...(n.also ?? [])]) notified.set(k, scope);
    }
    for (const k of [...acked]) {
      if (active.includes(k) || ackedScope.get(k) === scope) continue;
      acked.delete(k);
      ackedScope.delete(k);
    }
    for (const [k, r] of [...repeats]) if (r.turn !== turn.turn_no) repeats.delete(k);
    if (decision.kind === 'end') {
      raise(decision.wake, 'ended');
      return finish('ended', 'run_ended');
    }
    if (decision.kind === 'wake') {
      // 通っていないので帰った遠征（V4-1k §32.1）: キャンプの起こしを not_getting_through にして、戦いの数字を添える（帰って起こす）
      if (decision.wake.reason === 'camp' && notThrough && obs.status === 'at_camp') {
        decision.wake = { ...decision.wake, reason: 'not_getting_through', detail: [notThrough.detail, '目的の相手に通っていないので、戦いをやめて帰った。戦い方を変えるなら policy.fight_with（"throw_first"・"melee"）、挑み直さないなら別の候補を選ぶ', decision.wake.detail].join('\n') };
        notThrough = null;
      }
      // もう返事をもらった起こし方（キャンプで出発の命令が無い・何も残っていない など）: 起こし直さず、次の方針を待つ
      if (waiting?.key !== decision.wake.key) wakeNow(decision.wake, true);
      else if (!reloadOrders()) await sleep(pollMs);
      continue;
    }
    waitingParty = decision.kind === 'idle' && decision.wait === 'party';
    waitingJoin = decision.kind === 'idle' && decision.wait === 'join';
    // キャンプで待つ理由（waiting_join・waiting_party）を知らせに出す（待ち始めに 1 回。V4-1i B7）
    const waitWhy = waitingJoin ? 'waiting_join' : waitingParty ? 'waiting_party' : null;
    if (waitWhy && waitNoted !== waitWhy) {
      note(waitWhy, [waitWhy === 'waiting_join' ? '協力プレイのランに、ほかの参加者がいない。だれかが入るまで、遠征を始めずに待つ' : '仲間がまだ迷宮にいる。全員が戻るまで、遠征を始めずに待つ', lineWith(text, '仲間: ')].filter(Boolean).join('\n'));
    }
    waitNoted = waitWhy;
    // 仲間を待つ（ついていく相手の近く・遠征の最初・キャンプ）間に、仲間が何もしないまま coop.idle_minutes が過ぎた: 上げる（§23.8）。
    // 上げた後も持ち場の動きを続ける（自分からは帰らない）
    // V4-1i B5: 待っている間に限らない（pilot が探索や戦いを続けていても上げる）。条件は「仲間（倒れた・抜けた者を除く）の観測の項目が idle_minutes の間変わらない」
    const idleMin = orders.policy.coop.idle_minutes;
    const partyAlive = (obs.party ?? []).some((m) => m.status === 'in_dungeon' || m.status === 'at_camp');
    if (coop && partyAlive && !waiting && idleMin > 0 && now() - partyChangedAt >= idleMin * 60000) {
      const key = `party_idle:${partyChangedAt}`;
      if (!partyIdleRaised.has(key)) {
        partyIdleRaised.add(key);
        wakeNow({ level: 'escalate', reason: 'party_idle', key, detail: [
          `仲間が ${Math.floor((now() - partyChangedAt) / 60000)} 分、何もしていない（観測の party[].last_act が変わらない）。pilot は待ち続ける（自分からは帰らない）。置いて帰るなら mode: "return"、待つのをやめて 1 人で動くなら policy.coop.follow: "none"`,
          lineWith(text, '仲間: '), obs.summary,
        ].filter(Boolean).join('\n') });
        continue;
      }
    }
    if (decision.kind === 'idle') {
      writeState();
      // キャンプで仲間を待つ（V4-1f §22.5）: 仲間の動きを待って観測を取り直す（返事の orders.json も見る）
      if (decision.wait === 'party' || decision.wait === 'join') {
        if (!reloadOrders()) {
          await waitFeed(1000);
          const o = await call('observe', {}).catch(() => null);
          const op = o?.data as { observation?: Observation; turn?: TurnBlock } | undefined;
          if (op?.observation) { obs = op.observation; text = o!.text; }
          if (op?.turn) turn = op.turn;
          observeMemory();
        }
        continue;
      }
      // ソロで起こして待つ間、追ってくる敵も被害も無い: 何もせずに返事を待つ
      if (!reloadOrders()) await sleep(pollMs);
      continue;
    }
    const before = turn.turn_no;
    // 命令の後に出す知らせ（done・then）の写しは、決めた時点のもの（V4-1i B4）
    const decidedAt = decision.done || decision.then ? { turn: turn.turn_no, hp: obs.self.hp, max_hp: obs.self.max_hp, state: stateOf(statusNow(), (decision.done ?? decision.then)!) } : undefined;
    const relicLine = decision.relic ? lineWith(text, decision.relic) : '';
    // 仲間を待つ待つ命令は、命令の上限に数えない（暴走ではないため。§23.8）
    const uncounted = decision.tool === 'wait' && (!!decision.partyWait || waiting?.reason === 'party_idle');
    const r = await act(decision.tool, decision.args, 'pilot', !uncounted, decision.why);
    // 探す手（V4-1f §22.1）: 使った手番を数え、立ったマスを覚える。見回り先へ着けなかったら、この階ではもう行かない
    if (decision.seek) {
      mem.seekTurns += Math.max(1, turn.turn_no - before);
      if (obs.self.pos) mem.seekVisited.push({ x: obs.self.pos.x, y: obs.self.pos.y });
      const to = decision.args.to as { x?: number; y?: number } | undefined;
      if (decision.tool === 'travel_to' && to && typeof to.x === 'number' && typeof to.y === 'number' && (!r.ok || (r.stop && NOTIFY_STOPS.has(r.stop)))) mem.patrolFailed.push({ x: to.x, y: to.y });
    }
    // 目的でない遺物を拾いに行った（pick_relics。V4-1e §19.5）: 着いて見えなくなった（拾った）なら知らせる。道が無い等なら、この階ではもう行かない
    if (decision.relic) {
      if (r.ok && !obs.visible.items.some((i) => i.id === decision.relic) && (!r.stop || r.stop === 'arrived')) note('relic_picked', relicLine || decision.relic, `relic_picked:${decision.relic}`);
      else if (!r.ok || (r.stop && NOTIFY_STOPS.has(r.stop))) mem.relicFailed.push(decision.relic);
    }
    // 手番が進まない命令を数える（断られた命令も。V4-1i B1: 断られた命令は下の分かれ道で先へ進み、今までの数え（stuck）に届いていなかった）。
    // 同じ決まり（why）で 3 回: その手番では、その決まりを使わない。全部で 6 回: 行き詰まり（stuck）
    if (turn.turn_no === before && r.error?.code !== 'call_failed') {
      const w = decision.why ?? decision.tool;
      const c = (noTurn.byWhy.get(w) ?? 0) + 1;
      noTurn.byWhy.set(w, c);
      noTurn.total++;
      if (c >= 3) noTurn.blocked.add(w);
      if (noTurn.total >= NO_TURN_MAX) {
        noTurn.total = 0;
        wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:noturn:${turn.turn_no}`, detail: `手番が進まない命令が、この手番に ${NO_TURN_MAX} 回続いた（${[...noTurn.byWhy].map(([k, v]) => `${k} ${v} 回`).join('・')}）: ${lastOutcome}` });
        continue;
      }
    }
    if (!r.ok) {
      if (r.error?.code === 'call_failed') continue;
      const code = r.error?.code ?? 'unknown';
      // 探す見回り先へ行けない（覚えている地図には、見えていても行けないマスがある。V4-1k §32.2）: その先はもう選ばず（patrolFailed）、
      // この手番のうちに別の見回り先を試す（断りで起こさない。同じ決まりの手番が進まない命令は 3 回までなので、くり返しは止まる）
      if (decision.seek && decision.tool === 'travel_to' && (code === 'unreachable' || code === 'unknown_destination')) continue;
      // 探す（toward: sense）が sense_found で断られた: 目的でない遺物を覚えているだけで止まる（マクロの判定。V4-1i B9）。この階では方角なしで探索する
      // explore の toward が、その方角に境界が無いので断られた（S1c §14.6 の 2）: この階では方角なしで探索する（知らせない。今までの探索と同じ動き）
      if (decision.tool === 'explore' && decision.args.toward && r.error?.details?.stop === 'toward_exhausted' && !mem.towardOff) { mem.towardOff = true; continue; }
      if (decision.tool === 'explore' && decision.args.toward === 'sense' && code === 'nothing_to_do' && !mem.senseOff) {
        mem.senseOff = true;
        note('sense_off', `explore toward: sense が断られた（${lastOutcome.split('\n')[0]}）。目的の相手・品はまだ見えていないので、この階では方角を付けずに探索する`);
        continue;
      }
      // fight が断られた（hp_floor など）: 相手ごとに数え、この手番はその相手を外して表の次の行へ（§14.2・§14.3）
      if (decision.tool === 'fight' && typeof decision.args.target === 'string') {
        const tgt = decision.args.target;
        fightStopped(tgt, `refused_${code}`, [...blockedLines(r.error), lastOutcome].join('\n'), { recover: code === 'hp_floor', advance: false, count: code !== 'hp_floor' });
        // 寄るやり直しが断られ（届かない等）、次が投げる品での最後のやり直しなら、この手番のうちに投げる（V4-1d §18.2）。ほかは、この手番はその相手を外す
        const throwNext = !decision.args.with && !gaveUp.has(tgt) && !waiting && 'with' in fightArgs(obs, orders.policy, mem, tgt, throwKinds, fightStats);
        if (!throwNext) refused.targets.add(tgt);
        // 立て直しの 3 の fight が断られた（V4-1i B1）: その立て直しの間は、その相手と fight しない（段の次の手へ）
        if (decision.why === 'recover' && !mem.recoverFought.includes(tgt)) mem.recoverFought.push(tgt);
        continue;
      }
      // 休めない（回復の上限など）: 立て直しは終わり
      if (decision.tool === 'rest' && code === 'nothing_to_do') mem.recovering = false;
      // steady の移動が HP の下限で断られた: 立て直しへ（§14.3）
      if (code === 'hp_floor' && decision.tool !== 'rest') mem.recovering = true;
      // 移動の道具・休む・殴るが断られた: その手番の間は外して、表の次の行へ（経路がふさがれている等）
      refused.tools.add(decision.tool);
      if (MOVE_TOOLS.has(decision.tool)) {
        // 「何も無い」より、ふさがれた・隣に敵がいる等の理由を残す
        const traps = r.error?.details?.blocked_by_traps ?? [];
        if (!refused.last || refused.last.code === 'nothing_to_do') refused.last = { code, text: lastOutcome, ...(r.error?.details?.blocked_by?.length ? { blockedBy: [...r.error.details.blocked_by] } : {}), ...(traps.length ? { traps: [...traps] } : {}) };
        // 罠にふさがれた（V4-1d §18.1）: step_on_traps なら、表の行で踏む
        if (traps.length && !refused.trap) refused.trap = { tool: decision.tool, traps: [...traps] };
      } else note(`refused_${code}`, [...blockedLines(r.error), `${decision.tool}: ${lastOutcome}`].join('\n'));
      continue;
    }
    // うまくいった後に知らせる（綱を使った。V4-1e §19.4）
    if (decision.done) raise(decision.done, undefined, decidedAt);
    // 回復の品を使った後に起こす（§16.3）
    if (decision.then) { wakeNow(decision.then, true, decidedAt); continue; }
    // 手番が進まない命令が続いたら起こす（同じ所で止まり続けない）
    stuck = turn.turn_no === before ? stuck + 1 : 0;
    if (waiting || orders.mode === 'hold') { writeState(); continue; }
    const aa = afterAction(decision.tool, r.stop);
    // 進み具合（§14.2 の 4）: 新しいマスに立った・倒した、が 8 回続けて無ければ stuck。
    // 協力プレイで仲間についていく命令（待つ・寄る・助けに行く・立て直しで仲間の所へ）は、進み具合とみなす（相手が先を決める。
    // V4-1h の測り直しで分かった: ゆっくり進む相手について同じマスを行き来するうちに stuck になり、見本が「帰る」と答えて仲間を置いて帰った）
    if (decision.why === 'follow' || decision.why === 'assist' || decision.why === 'recover_ally') noProgress = 0;
    else if (PROGRESS_TOOLS.has(decision.tool)) {
      noProgress = progressed(aa.kind === 'ok' && !!aa.killed) ? 0 : noProgress + 1;
      if (noProgress >= NO_PROGRESS_MAX) { noProgress = 0; wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:progress:${turn.turn_no}`, detail: `階の探索も撃破も進まない命令が ${NO_PROGRESS_MAX} 回続いた: ${lastOutcome}` }); continue; }
    }
    if (aa.kind === 'ok') {
      if (aa.killed && typeof decision.args.target === 'string') { delete mem.stops[decision.args.target]; if (mem.shotBy === decision.args.target) mem.shotBy = null; if (mem.hitBy === decision.args.target) mem.hitBy = null; }
      writeState();
      continue;
    }
    if (aa.kind === 'fight') {
      // 立て直しの 3 の fight が倒す前に止まった: この立て直しの間は、その相手と fight しない（続きへ進む。V4-1h の続き）
      if (decision.why === 'recover' && decision.tool === 'fight' && typeof decision.args.target === 'string' && !mem.recoverFought.includes(decision.args.target)) mem.recoverFought.push(decision.args.target);
      fightStopped(typeof decision.args.target === 'string' ? decision.args.target : undefined, aa.reason, lastOutcome || obs.summary, aa); writeState(); continue;
    }
    if (aa.kind === 'recover') { mem.recovering = true; note('recovering', lastOutcome || obs.summary); writeState(); continue; }
    if (aa.kind === 'notify') {
      // 同じ命令が同じ止まり方で 4 回止まったら stuck（階が変わったら数え直す）
      const sig = `${aa.reason}|${decision.tool}|${JSON.stringify(decision.args)}|${scopeNow()}`;
      sameStop = sameStop.sig === sig ? { sig, count: sameStop.count + 1 } : { sig, count: 1 };
      if (sameStop.count > 3) {
        sameStop = { sig: '', count: 0 };
        wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:${turn.turn_no}`, detail: `同じ命令（${decision.tool}）が同じ止まり方（${aa.reason}）で 4 回止まった: ${lastOutcome}` });
      } else {
        // マクロが罠の手前で止まった（trap_ahead）: 隣の見つけている罠の行と方角を先頭に（V4-1d §18.1。次の同じ命令は断られ、エラーに罠が入る）
        const near = aa.reason === 'trap_ahead' && obs.self.pos ? trapsNow().filter((f) => f.dist <= 1).map((f) => ({ id: f.id!, kind: f.type, pos: f.pos })) : [];
        note(aa.reason, [...trapLines(obs, text, near), lastOutcome || obs.summary].join('\n'));
      }
      writeState();
      continue;
    }
    wakeNow({ level: 'wake', reason: aa.reason, key: `${aa.reason}:${turn.turn_no}`, detail: lastOutcome || obs.summary });
  }
}

/** 探す目的（目的の相手・品。V4-1f §22.1） */
const SEEK_OBJECTIVES = new Set(['slay_guardian', 'slay_warden', 'slay_bounty', 'retrieve_relic']);
/**
 * get_map の地図（origin・rows・legend）から、覚えている通れるマスを取る（V4-1k §32.2）。凡例の名前が、どれも通れない地形の名前なら通れない。
 * 空白は覚えていないマス。品・敵・地物の印のマスは、通れる側に数える（印の下の地形は見えないが、立っていられる所にある）
 */
export function mapCellsOf(data: unknown, blockNames: ReadonlySet<string>): Pos[] {
  const m = data as { origin?: { x: number; y: number }; rows?: string[]; legend?: Record<string, string> } | null;
  if (!m?.origin || !Array.isArray(m.rows)) return [];
  const blocked = new Set(Object.entries(m.legend ?? {}).filter(([, n]) => n.split('/').every((x) => blockNames.has(x))).map(([ch]) => ch));
  const out: Pos[] = [];
  m.rows.forEach((row, i) => {
    for (let j = 0; j < row.length; j++) {
      const ch = row[j]!;
      if (ch === ' ' || blocked.has(ch)) continue;
      out.push({ x: m.origin!.x + j, y: m.origin!.y + i });
    }
  });
  return out;
}

/** 覚えている通れるマスのうち、from からつながっている所（8 方向。V4-1k §32.2: 壁の向こうに見えただけのマスを、見回り先にしない） */
export function connectedCells(cells: readonly Pos[], from: Pos): Pos[] {
  const key = (x: number, y: number) => `${x},${y}`;
  const set = new Map(cells.map((c) => [key(c.x, c.y), c]));
  set.set(key(from.x, from.y), { x: from.x, y: from.y });
  const seen = new Set<string>([key(from.x, from.y)]);
  const queue: Pos[] = [from];
  const out: Pos[] = [];
  while (queue.length) {
    const c = queue.shift()!;
    if (c !== from) out.push(c);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const k = key(c.x + dx, c.y + dy);
      if (seen.has(k) || !set.has(k)) continue;
      seen.add(k);
      queue.push(set.get(k)!);
    }
  }
  return out;
}

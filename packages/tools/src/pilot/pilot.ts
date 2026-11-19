// pilot（IMPROVEMENTS_V4 §10、§14 で見直し）: AI とゲームの間に置く代行 bot の作例。
// 速いループ（このファイル）が方針（orders.json）の範囲で 1 手ずつ速く動かし、AI にしか決められないときだけ AI を起こす（遅いループ）。
// 決められることは pilot が決めて知らせる（notify）。起こして待つ間も、身を守る動きは自分でやる（§14.4）。
// ゲームの側は変えない。pilot はただのプレイヤーで、MCP の同じ道具を使い、ターンフィードで手番を受ける（参照ドライバ drive.ts と同じ口）。
// 決めるのは decide.ts（観測の構造化された項目と、pilot 自身の記録だけ。規則の知識は持たない）。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Observation, TurnBlock } from '@muse/shared';
import { readFeed } from '../drive';
import { afterAction, decide, isRoleEnemy, lineWith, MOVE_TOOLS, newMemory, type PilotMemory, type Wake, type WakeLevel } from './decide';
import { defaultOrders, parseOrders, type PilotOrders, type QueuedCommand, writeJsonAtomic } from './orders';

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
}

export interface PilotState {
  run_id: string;
  expedition_no: number | null;
  turn: number;
  orders_rev: number;
  status: 'running' | 'waiting' | 'holding' | 'camp' | 'ended';
  wake: { reason: string; level: WakeLevel; turn: number; detail: string } | null;
  self: { level: number; hp: number; max_hp: number; floor: number | null; pos: [number, number] | null };
  /** 観測の遠征の目的をそのまま */
  objective: NonNullable<Observation['expedition']>['objective'] | null;
  /** 最後の命令。source: pilot が自分で出したか、queue の命令か */
  last: { tool: string; args: Record<string, unknown>; stopped: string | null; turns: number; source: 'pilot' | 'queue' } | null;
  /** 見えている敵（観測の写し。§14.6） */
  hostiles: { id: string; name: string; pos: [number, number]; dist: number; hp_state: string; hunting: boolean; role: string | null; objective: boolean; ignored: boolean }[];
  /** 知っている階段（観測の navigation.known_stairs そのまま） */
  stairs: Observation['navigation']['known_stairs'];
  /** いま戦っている相手と、倒す前に止まった回数（pilot の記録） */
  target: { id: string; stops: number } | null;
  /** 相手にしないと決めた敵の ID（pilot の記録。方針 ignore・unignore で書き換えられる） */
  ignored: string[];
  /** 立て直しの段の途中か（pilot の記録） */
  recovering: boolean;
  /** キャンプにいる間: 次の遠征の番号と候補（観測の camp の写し。start_expedition の offer に index を書く） */
  camp?: { next_no: number; offers: { index: number; slot: string | null; type: string; target_depth: number | null; points: number; recommended_level: number | null; text: string }[] };
  summary: string;
}

export interface WakeEvent extends Wake { state: PilotState; statePath: string; ordersPath: string }

export interface PilotResult {
  /** ended: ランが終わった / stopped: mode stop・stop_at_camp・止める合図 / safety: 安全装置 */
  outcome: 'ended' | 'stopped' | 'safety';
  reason: string;
  actions: number;
  wakes: Record<string, number>;
  notifies: number;
  /** 知らせた理由ごとの回数 */
  notified: Record<string, number>;
  /** 進めた手番（pilot が自分で出した命令と、queue の命令） */
  turns: { pilot: number; queue: number };
}

interface CallResult { ok: boolean; data: Record<string, unknown>; text: string }

/** 断りのエラー（details.blocked_by: じゃまをしている見えている敵。V4-1a §12.3） */
type CallError = { code: string; message: string; details?: { blocked_by?: string[] } };
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

export async function runPilot(opts: PilotOptions): Promise<PilotResult> {
  const log = opts.log ?? (() => undefined);
  const pollMs = opts.pollMs ?? 500;
  const maxActions = opts.maxActions ?? 5000;
  const maxMs = opts.maxMs ?? 6 * 60 * 60 * 1000;
  const maxErrors = opts.maxErrors ?? 5;
  const t0 = Date.now();
  const result: PilotResult = { outcome: 'stopped', reason: '', actions: 0, wakes: {}, notifies: 0, notified: {}, turns: { pilot: 0, queue: 0 } };

  // ---- ゲームへの口（MCP）。表示の文は短く、所持品はいつも構造化して受け取る ----
  const client = new Client({ name: 'muse-pilot', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', opts.baseUrl)));
  const call = async (tool: string, args: Record<string, unknown>): Promise<CallResult> => {
    const r = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { type: string; text?: string }[] };
    const data = r.structuredContent ?? {};
    const ok = !r.isError && (data as { ok?: boolean }).ok !== false;
    return { ok, data, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  };
  const resumed = await call('resume_run', { player_token: opts.token, map: 'never', inventory: 'always' });
  if (!resumed.ok) { await client.close(); throw new Error(`resume_run failed: ${resumed.text}`); }
  const runId = String((resumed.data as { run_id?: string }).run_id ?? '');
  let obs = (resumed.data as { observation: Observation }).observation;
  let turn = (resumed.data as { turn: TurnBlock }).turn;
  let text = resumed.text;
  const dir = resolve(opts.dir ?? join('pilot-data', runId));
  mkdirSync(dir, { recursive: true });
  const ordersPath = join(dir, 'orders.json');
  const statePath = join(dir, 'state.json');
  const logPath = join(dir, 'log.jsonl');
  log(`[pilot] run ${runId}, files in ${dir}`);
  let coop = opts.mode === 'coop';
  if (!opts.mode) {
    const runs = (await call('list_runs', {})).data as { runs?: { run_id: string; mode: string }[] };
    coop = runs.runs?.find((r) => r.run_id === runId)?.mode === 'coop';
  }

  // ---- ターンフィード（協力プレイで他の人の番の間、次の手番を待つ） ----
  const ac = new AbortController();
  const feed = { signal: null as (() => void) | null };
  void (async () => {
    try {
      const res = await fetch(new URL('/api/player/feed', opts.baseUrl), { headers: { authorization: `Bearer ${opts.token}` }, signal: ac.signal });
      if (!res.ok || !res.body) return;
      for await (const ev of readFeed(res)) { if (ev.type !== 'hello') feed.signal?.(); }
    } catch { /* 切れた（終わり） */ }
  })();
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const waitFeed = (ms: number) => new Promise<void>((r) => { const t = setTimeout(() => { feed.signal = null; r(); }, ms); feed.signal = () => { clearTimeout(t); feed.signal = null; r(); }; });

  // ---- 方針 ----
  let orders: PilotOrders;
  let ordersError: string | null = null;
  if (!existsSync(ordersPath)) { orders = defaultOrders(); writeJsonAtomic(ordersPath, orders); }
  else {
    try { orders = parseOrders(JSON.parse(readFileSync(ordersPath, 'utf-8'))); } catch (e) { orders = defaultOrders(); ordersError = (e as Error).message; }
  }
  let queue: QueuedCommand[] = [...orders.queue];
  /** queue の先頭の命令を、敵のせいで断られてやり直した回数（3 回まで。§14.5） */
  let queueRetries = 0;
  let lastBadText = '';
  /** 起こして返事を待っている（rev が変わるまで）。homeward: hold_max_turns が過ぎて帰る側へ倒した */
  let waiting = null as { key: string; also: string[]; reason: string; sinceTurn: number; cond: boolean; homeward: boolean; wake: Wake } | null;
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
  const refused = { turn: -1, tools: new Set<string>(), targets: new Set<string>(), last: null as { code: string; text: string; blockedBy?: string[] } | null };
  /** 断りのエラーの blocked_by の敵の、観測の文の行（起こす・知らせるときに detail の先頭に添える。V4-1a §13.8。pilot は自分からは戦わない） */
  const blockedLines = (e?: CallError) => (e?.details?.blocked_by ?? []).map((id) => lineWith(text, id)).filter(Boolean);
  // ---- pilot 自身の記録（§14.2〜§14.4） ----
  let mem: PilotMemory = newMemory();
  /** AI が ignore に書いた敵（unignore まで、遠征の間は相手にしない） */
  const aiIgnored = new Set<string>();
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

  const ignoredNow = () => [...new Set([...gaveUp, ...aiIgnored])];
  // 起こして返事を待つ間は、待っている起こし方を state.json に残す（持ち場の動きで書き直しても消えない）
  const stateOf = (status: PilotState['status'], w0: Wake | null): PilotState => { const w = w0 ?? waiting?.wake ?? null; return {
    run_id: runId, expedition_no: obs.expedition?.no ?? null, turn: turn.turn_no, orders_rev: orders.rev, status,
    wake: w ? { reason: w.reason, level: w.level, turn: turn.turn_no, detail: w.detail } : null,
    self: { level: obs.self.level, hp: obs.self.hp, max_hp: obs.self.max_hp, floor: obs.self.floor?.depth ?? null, pos: obs.self.pos ? [obs.self.pos.x, obs.self.pos.y] : null },
    objective: obs.expedition?.objective ?? null,
    last,
    hostiles: obs.visible.monsters.map((m) => ({ id: m.id, name: m.name, pos: [m.pos.x, m.pos.y] as [number, number], dist: m.dist, hp_state: m.hp_state, hunting: m.awareness === 'hunting' && !m.fleeing, role: m.role ?? (isRoleEnemy(m) ? 'elite' : null), objective: !!m.objective, ignored: ignoredNow().includes(m.id) })),
    stairs: obs.navigation.known_stairs,
    target: lastTarget && obs.visible.monsters.some((m) => m.id === lastTarget) ? { id: lastTarget, stops: mem.stops[lastTarget] ?? 0 } : null,
    ignored: ignoredNow(),
    recovering: mem.recovering,
    ...(obs.status === 'at_camp' && obs.camp ? { camp: { next_no: obs.camp.next_no, offers: obs.camp.offers.map((o) => ({ index: o.index, slot: o.slot ?? null, type: o.type, target_depth: o.target_depth, points: o.points, recommended_level: o.recommended_level, text: o.text })) } } : {}),
    // 観測の文の行をそのまま（pilot は言い換えない）: 状態の 1 行・直前の結果・起こした理由の行
    summary: [obs.summary, lastOutcome, w?.detail ?? ''].filter(Boolean).join('\n'),
  }; };
  const statusNow = (): PilotState['status'] => obs.status === 'at_camp' ? 'camp' : waiting ? (coop ? 'holding' : 'waiting') : 'running';
  const writeState = () => writeJsonAtomic(statePath, stateOf(statusNow(), null));
  const appendLog = (row: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), turn: turn.turn_no, ...row })}\n`);

  /** 起こす・知らせる: state.json を書いてから経路を呼ぶ。相手の終了は待たない */
  const raise = (w: Wake, status?: PilotState['status']) => {
    const st = stateOf(status ?? statusNow(), w);
    writeJsonAtomic(statePath, st);
    appendLog({ wake: w.reason, level: w.level, detail: w.detail });
    if (w.level === 'wake') result.wakes[w.reason] = (result.wakes[w.reason] ?? 0) + 1;
    else { result.notifies++; result.notified[w.reason] = (result.notified[w.reason] ?? 0) + 1; }
    log(`[pilot] ${w.level} ${w.reason}: ${w.detail.split('\n')[0]}`);
    const env = { ...process.env, MUSE_PILOT_STATE: statePath, MUSE_PILOT_ORDERS: ordersPath, MUSE_PILOT_LEVEL: w.level, MUSE_PILOT_REASON: w.reason };
    if (opts.wakeCmd) {
      try {
        const child = spawn(opts.wakeCmd, { shell: true, detached: true, stdio: ['pipe', 'ignore', 'ignore'], env });
        child.on('error', (e) => log(`[pilot] wake command failed: ${e.message}`));
        child.stdin?.end(`${st.summary}\n`);
        child.unref();
      } catch (e) { log(`[pilot] wake command failed: ${(e as Error).message}`); }
    }
    if (opts.wakeUrl) {
      void fetch(opts.wakeUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ level: w.level, reason: w.reason, summary: st.summary, state_path: statePath, orders_path: ordersPath, state: st }) })
        .catch((e) => log(`[pilot] wake url failed: ${(e as Error).message}`));
    }
    opts.onWake?.({ ...w, state: st, statePath, ordersPath });
  };
  const note = (reason: string, detail: string, key = `${reason}:${turn.turn_no}`) => raise({ level: 'notify', reason, key, detail });
  /** 起こす。手番が進まないまま同じ起こし方が 3 回を超えたら stuck に、stuck もくり返したら終える */
  const wakeNow = (w: Wake, cond = false) => {
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
    raise(w);
    if (w.level === 'wake') waiting = { key: w.key, also: w.also ?? [], reason: w.reason, sinceTurn: turn.turn_no, cond, homeward: false, wake: w };
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
      const keep = { recovering: mem.recovering, crossed: mem.crossed };
      mem = { ...newMemory(), ...keep };
      gaveUp = new Set();
      visited = new Set();
      noProgress = 0;
      memScope = scope;
      if (obs.expedition?.no !== Number(prev.scope.split(':')[0])) { aiIgnored.clear(); stairRetreats.clear(); mem.crossed = null; mem.recovering = false; }
    }
    mem.stairRetreats = stairRetreats.get(scope) ?? 0;
    const pos = obs.self.pos;
    if (pos) {
      const lastPos = mem.trail[mem.trail.length - 1];
      if (!lastPos || lastPos.x !== pos.x || lastPos.y !== pos.y) { mem.trail.push({ x: pos.x, y: pos.y }); if (mem.trail.length > 60) mem.trail.shift(); }
    }
    // 隣でない相手から被害を受けた: HP が減ったのに、前にも今にも起きている敵が隣にいない（観測の構造化された項目だけで決める。§14.9）
    const adjAwake = obs.visible.monsters.some((m) => m.dist <= 1 && m.awareness !== 'asleep');
    const passed = turn.turn_no - prev.turn;
    if (scope === prev.scope && obs.self.hp < prev.hp && !adjAwake && !prev.adjAwake) mem.hurtFarAgo = 0;
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
  const act = async (tool: string, args: Record<string, unknown>, source: 'pilot' | 'queue'): Promise<{ ok: boolean; stop?: string; error?: CallError }> => {
    const before = turn.turn_no;
    let r: CallResult;
    try {
      r = await call(tool, { ...args, thought: `[pilot] ${source === 'queue' ? 'queue: ' : ''}${tool}` });
      errors = 0;
    } catch (e) {
      errors++;
      log(`[pilot] ${tool} failed (${errors}/${maxErrors}): ${(e as Error).message}`);
      return { ok: false, error: { code: 'call_failed', message: (e as Error).message } };
    }
    result.actions++;
    const p = payload(r);
    if (p.obs) { obs = p.obs; text = r.text; }
    if (p.turn) turn = p.turn;
    if (!r.ok || !p.obs) {
      const o = await call('observe', {});
      const op = o.data as { observation?: Observation; turn?: TurnBlock };
      if (op.observation) { obs = op.observation; text = o.text; }
      if (op.turn) turn = op.turn;
    }
    const steps = Math.max(0, turn.turn_no - before);
    result.turns[source] += steps;
    lastOutcome = p.outcome ?? (p.error ? `${p.error.code}: ${p.error.message}` : '');
    last = { tool, args, stopped: p.stop ?? (r.ok ? null : p.error?.code ?? 'error'), turns: steps, source };
    if (tool === 'fight' && typeof args.target === 'string') lastTarget = args.target;
    appendLog({ source, tool, args, ok: r.ok, stopped: last.stopped, steps, hp: obs.self.hp, max_hp: obs.self.max_hp });
    observeMemory();
    return { ok: r.ok, stop: p.stop, error: p.error };
  };

  /**
   * fight が倒す前に止まった・断られた（§14.2）: 相手ごとに数える。auto なら寄ってやり直す相手に、hp_floor なら立て直しへ。
   * give_up_after に達したら、目的でない相手は相手にしない（知らせる）。目的の相手は起こす（AI が決める）
   */
  const fightStopped = (target: string | undefined, reason: string, detail: string, o: { recover: boolean; advance: boolean; count: boolean }) => {
    if (o.recover) mem.recovering = true;
    if (!target || !o.count) { note(reason, detail); return; }
    mem.stops[target] = (mem.stops[target] ?? 0) + 1;
    if (o.advance && orders.policy.approach === 'auto' && !mem.advance.includes(target)) mem.advance.push(target);
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
    if (result.actions >= maxActions || Date.now() - t0 > maxMs || errors >= maxErrors || stuckOut) {
      const reason = result.actions >= maxActions ? 'max_actions' : errors >= maxErrors ? 'errors' : stuckOut ? 'stuck' : 'max_time';
      raise({ level: 'wake', reason: 'safety', key: 'safety', detail: reason }, 'ended');
      return finish('safety', reason);
    }
    // 3. rev が変わったら読み直す
    reloadOrders();
    if (orders.mode === 'stop') { writeJsonAtomic(statePath, stateOf('ended', null)); return finish('stopped', 'mode_stop'); }
    // 1. ランが終わった（queue より先）
    if (turn.state === 'run_ended' || obs.status === 'ended' || obs.status === 'dead') {
      raise({ level: 'wake', reason: 'ended', key: 'ended', detail: obs.summary }, 'ended');
      return finish('ended', obs.status === 'dead' ? 'dead' : 'run_ended');
    }
    // 帰ってから終える（§14.7）: キャンプに着いたら終える
    if (orders.mode === 'stop_at_camp' && obs.status === 'at_camp') { writeJsonAtomic(statePath, stateOf('ended', null)); return finish('stopped', 'stop_at_camp'); }
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
    if (refused.turn !== turn.turn_no) { refused.turn = turn.turn_no; refused.tools.clear(); refused.targets.clear(); refused.last = null; }
    // 4. queue（AI が明示した 1 回きりの命令。キャンプでも先に実行する。§14.5）
    if (queue.length && !refused.tools.has('queue')) {
      const q = queue[0]!;
      // queue の fight に hp_floor が無ければ、方針の値（wake_hp_pct）を使う
      const args: Record<string, unknown> = q.tool === 'fight' && q.args?.hp_floor === undefined ? { ...(q.args ?? {}), hp_floor: Math.floor((obs.self.max_hp * orders.policy.wake_hp_pct) / 100) } : { ...(q.args ?? {}) };
      const r = await act(q.tool, args, 'queue');
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
          queueRetries = 0;
          if (failed) {
            if (args.target && q.tool === 'fight' && r.error?.code === 'hp_floor') fightStopped(String(args.target), `refused_${r.error.code}`, lastOutcome, { recover: true, advance: false, count: false });
            note('queue_failed', [...blockedLines(r.error), `${q.tool}: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`.trim()].join('\n'));
          } else if (aa?.kind === 'wake') wakeNow({ level: 'wake', reason: aa.reason, key: `${aa.reason}:${turn.turn_no}`, detail: lastOutcome || obs.summary });
        } else { queue.shift(); queueRetries = 0; }
        writeState();
        continue;
      }
    }
    // 起こして待っている（§14.4）: hold_max_turns が過ぎたら、帰る側へ倒す（くり返し起こさない）
    if (waiting && obs.status !== 'at_camp' && !waiting.homeward && turn.turn_no - waiting.sinceTurn >= orders.policy.hold_max_turns) {
      waiting.homeward = true;
      note('no_reply', `${waiting.reason}（${turn.turn_no - waiting.sinceTurn} 手番返事が無い）。階段へ行き、帰る側へ倒す`, `no_reply:${waiting.key}`);
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
    const { decision, active, notify, update } = decide(obs, {
      orders, coop, waiting: !!waiting, homeward: !!waiting?.homeward, acked, text,
      refused: refused.tools, refusedTargets: refused.targets, refusal: refused.last, notified: new Set(notified.keys()), mem,
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
      // もう返事をもらった起こし方（キャンプで出発の命令が無い・何も残っていない など）: 起こし直さず、次の方針を待つ
      if (waiting?.key !== decision.wake.key) wakeNow(decision.wake, true);
      else if (!reloadOrders()) await sleep(pollMs);
      continue;
    }
    if (decision.kind === 'idle') {
      // ソロで起こして待つ間、追ってくる敵も被害も無い: 何もせずに返事を待つ
      writeState();
      if (!reloadOrders()) await sleep(pollMs);
      continue;
    }
    const before = turn.turn_no;
    const r = await act(decision.tool, decision.args, 'pilot');
    if (!r.ok) {
      if (r.error?.code === 'call_failed') continue;
      const code = r.error?.code ?? 'unknown';
      // fight が断られた（hp_floor など）: 相手ごとに数え、この手番はその相手を外して表の次の行へ（§14.2・§14.3）
      if (decision.tool === 'fight' && typeof decision.args.target === 'string') {
        refused.targets.add(decision.args.target);
        fightStopped(decision.args.target, `refused_${code}`, [...blockedLines(r.error), lastOutcome].join('\n'), { recover: code === 'hp_floor', advance: false, count: code !== 'hp_floor' });
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
        if (!refused.last || refused.last.code === 'nothing_to_do') refused.last = { code, text: lastOutcome, ...(r.error?.details?.blocked_by?.length ? { blockedBy: [...r.error.details.blocked_by] } : {}) };
      } else note(`refused_${code}`, [...blockedLines(r.error), `${decision.tool}: ${lastOutcome}`].join('\n'));
      continue;
    }
    // 手番が進まない命令が続いたら起こす（同じ所で止まり続けない）
    stuck = turn.turn_no === before ? stuck + 1 : 0;
    if (stuck >= 3) { stuck = 0; wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:${turn.turn_no}`, detail: lastOutcome }); continue; }
    if (waiting || orders.mode === 'hold') { writeState(); continue; }
    const aa = afterAction(decision.tool, r.stop);
    // 進み具合（§14.2 の 4）: 新しいマスに立った・倒した、が 8 回続けて無ければ stuck
    if (PROGRESS_TOOLS.has(decision.tool)) {
      noProgress = progressed(aa.kind === 'ok' && !!aa.killed) ? 0 : noProgress + 1;
      if (noProgress >= NO_PROGRESS_MAX) { noProgress = 0; wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:progress:${turn.turn_no}`, detail: `階の探索も撃破も進まない命令が ${NO_PROGRESS_MAX} 回続いた: ${lastOutcome}` }); continue; }
    }
    if (aa.kind === 'ok') {
      if (aa.killed && typeof decision.args.target === 'string') delete mem.stops[decision.args.target];
      writeState();
      continue;
    }
    if (aa.kind === 'fight') { fightStopped(typeof decision.args.target === 'string' ? decision.args.target : undefined, aa.reason, lastOutcome || obs.summary, aa); writeState(); continue; }
    if (aa.kind === 'recover') { mem.recovering = true; note('recovering', lastOutcome || obs.summary); writeState(); continue; }
    if (aa.kind === 'notify') {
      // 同じ命令が同じ止まり方で 4 回止まったら stuck（階が変わったら数え直す）
      const sig = `${aa.reason}|${decision.tool}|${JSON.stringify(decision.args)}|${scopeNow()}`;
      sameStop = sameStop.sig === sig ? { sig, count: sameStop.count + 1 } : { sig, count: 1 };
      if (sameStop.count > 3) {
        sameStop = { sig: '', count: 0 };
        wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:${turn.turn_no}`, detail: `同じ命令（${decision.tool}）が同じ止まり方（${aa.reason}）で 4 回止まった: ${lastOutcome}` });
      } else note(aa.reason, lastOutcome || obs.summary);
      writeState();
      continue;
    }
    wakeNow({ level: 'wake', reason: aa.reason, key: `${aa.reason}:${turn.turn_no}`, detail: lastOutcome || obs.summary });
  }
}

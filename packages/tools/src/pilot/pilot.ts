// pilot（IMPROVEMENTS_V4 §10）: AI とゲームの間に置く代行 bot の作例。
// 速いループ（このファイル）が方針（orders.json）の範囲で 1 手ずつ速く動かし、判断が要るときに AI を起こす（遅いループ）。
// ゲームの側は変えない。pilot はただのプレイヤーで、MCP の同じ道具を使い、ターンフィードで手番を受ける（参照ドライバ drive.ts と同じ口）。
// pilot は判断しない。決めるのは decide.ts（観測の構造化された項目だけ）。
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Observation, TurnBlock } from '@muse/shared';
import { readFeed } from '../drive';
import { afterAction, decide, holdAction, lineWith, MOVE_TOOLS, type Wake, type WakeLevel } from './decide';
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
  summary: string;
}

export interface WakeEvent extends Wake { state: PilotState; statePath: string; ordersPath: string }

export interface PilotResult {
  /** ended: ランが終わった / stopped: mode stop・止める合図 / safety: 安全装置 */
  outcome: 'ended' | 'stopped' | 'safety';
  reason: string;
  actions: number;
  wakes: Record<string, number>;
  notifies: number;
  /** 進めた手番（pilot が自分で出した命令と、queue の命令） */
  turns: { pilot: number; queue: number };
}

interface CallResult { ok: boolean; data: Record<string, unknown>; text: string }

/** 命令の結果から観測・turn・止まった理由を取り出す */
/** 断りのエラー（details.blocked_by: じゃまをしている見えている敵。V4-1a §12.3） */
type CallError = { code: string; message: string; details?: { blocked_by?: string[] } };
function payload(r: CallResult): { obs?: Observation; turn?: TurnBlock; stop?: string; outcome?: string; error?: CallError } {
  const d = r.data as { observation?: Observation; turn?: TurnBlock; interrupted_by?: string; outcome?: string; error?: CallError };
  return { obs: d.observation, turn: d.turn, stop: d.interrupted_by, outcome: d.outcome, error: d.error };
}

export async function runPilot(opts: PilotOptions): Promise<PilotResult> {
  const log = opts.log ?? (() => undefined);
  const pollMs = opts.pollMs ?? 500;
  const maxActions = opts.maxActions ?? 5000;
  const maxMs = opts.maxMs ?? 6 * 60 * 60 * 1000;
  const maxErrors = opts.maxErrors ?? 5;
  const t0 = Date.now();
  const result: PilotResult = { outcome: 'stopped', reason: '', actions: 0, wakes: {}, notifies: 0, turns: { pilot: 0, queue: 0 } };

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
  let lastBadText = '';
  /** 起こして返事を待っている（rev が変わるまで） */
  /** cond: 観測の条件から決めた起こし方（decide）。それ以外（拒否・止まり方・queue の失敗など）は、その手番の間だけの起こし方 */
  let waiting = null as { key: string; also: string[]; reason: string; sinceTurn: number; cond: boolean } | null;
  /** AI が返事をした、観測の条件からの起こし方（条件が続く間は、同じことで起こさない） */
  const acked = new Set<string>();
  /** 遺物・役割のある敵への返事は、同じ遠征の同じ階にいる間は覚えておく（見えなくなっても、戦闘中に記憶の品が観測から外れても、起こし直さない） */
  const ackedScope = new Map<string, string>();
  const scopeNow = () => `${obs.expedition?.no ?? ''}:${obs.status === 'at_camp' ? 'camp' : obs.self.floor?.depth ?? ''}`;
  const ENTITY_KEY = /^(relic_seen|guardian_seen|warden_seen|elite_seen)(_hunting)?:/;
  /** 知らせた鍵（目的でない遺物・役割のある敵）と、知らせたときの遠征と階 */
  const notified = new Map<string, string>();
  /** 手番が進まないまま同じ起こし方をくり返した回数（3 回を超えたら stuck、stuck もくり返したら安全装置で終える） */
  const repeats = new Map<string, { turn: number; count: number }>();
  let stuckOut = false;
  /** pilot の同じ命令が、同じ止まり方で止まった回数（返事をもらっても同じことをくり返すなら、4 回目は stuck で起こす。階が変わったら数え直す） */
  let sameStop = { sig: '', count: 0 };
  /** この手番で断られた移動の道具（手番が進んだら空にする） */
  const refused = { turn: -1, tools: new Set<string>(), last: null as { code: string; text: string; blockedBy?: string[] } | null };
  /** 断りのエラーの blocked_by の敵の、観測の文の行（起こすときに detail の先頭に添える。V4-1a §12.3。pilot は自分からは戦わない） */
  const blockedLines = (e?: CallError) => (e?.details?.blocked_by ?? []).map((id) => lineWith(text, id)).filter(Boolean);
  let lastNotify = turn.turn_no;
  let last: PilotState['last'] = null;
  let lastOutcome = '';
  let errors = 0;
  let stuck = 0;

  const stateOf = (status: PilotState['status'], w: Wake | null): PilotState => ({
    run_id: runId, expedition_no: obs.expedition?.no ?? null, turn: turn.turn_no, orders_rev: orders.rev, status,
    wake: w ? { reason: w.reason, level: w.level, turn: turn.turn_no, detail: w.detail } : null,
    self: { level: obs.self.level, hp: obs.self.hp, max_hp: obs.self.max_hp, floor: obs.self.floor?.depth ?? null, pos: obs.self.pos ? [obs.self.pos.x, obs.self.pos.y] : null },
    objective: obs.expedition?.objective ?? null,
    last,
    // 観測の文の行をそのまま（pilot は言い換えない）: 状態の 1 行・直前の結果・起こした理由の行
    summary: [obs.summary, lastOutcome, w?.detail ?? ''].filter(Boolean).join('\n'),
  });
  const statusNow = (): PilotState['status'] => obs.status === 'at_camp' ? 'camp' : waiting ? (coop ? 'holding' : 'waiting') : 'running';
  const writeState = () => writeJsonAtomic(statePath, stateOf(statusNow(), null));
  const appendLog = (row: Record<string, unknown>) => appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), turn: turn.turn_no, ...row })}\n`);

  /** 起こす・知らせる: state.json を書いてから経路を呼ぶ。相手の終了は待たない */
  const raise = (w: Wake, status?: PilotState['status']) => {
    const st = stateOf(status ?? statusNow(), w);
    writeJsonAtomic(statePath, st);
    appendLog({ wake: w.reason, level: w.level, detail: w.detail });
    if (w.level === 'wake') result.wakes[w.reason] = (result.wakes[w.reason] ?? 0) + 1; else result.notifies++;
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
    if (w.level === 'wake') waiting = { key: w.key, also: w.also ?? [], reason: w.reason, sinceTurn: turn.turn_no, cond };
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
    if (waiting?.cond) {
      for (const k of [waiting.key, ...waiting.also]) { acked.add(k); if (ENTITY_KEY.test(k)) ackedScope.set(k, scopeNow()); }
    }
    waiting = null;
    appendLog({ orders_rev: next.rev, mode: next.mode, queue: next.queue.length });
    return true;
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
    appendLog({ source, tool, args, ok: r.ok, stopped: last.stopped, steps, hp: obs.self.hp, max_hp: obs.self.max_hp });
    return { ok: r.ok, stop: p.stop, error: p.error };
  };

  const finish = async (outcome: PilotResult['outcome'], reason: string): Promise<PilotResult> => {
    result.outcome = outcome;
    result.reason = reason;
    ac.abort();
    await client.close().catch(() => undefined);
    return result;
  };

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
    // 他の人の番（協力プレイ）: 次の手番を待つ
    if (turn.state === 'waiting_others') {
      await waitFeed(1000);
      const o = await call('observe', {}).catch(() => null);
      const op = o?.data as { observation?: Observation; turn?: TurnBlock } | undefined;
      if (op?.observation) { obs = op.observation; text = o!.text; }
      if (op?.turn) turn = op.turn;
      continue;
    }
    // 4. queue（AI が明示した 1 回きりの命令。キャンプでも先に実行する）。失敗したら残りを捨てて起こす。
    //    マクロが pilot の命令なら起こす止まり方で止まったとき（fight が倒す前に止まった等）も、残りを捨ててその理由で起こす
    if (queue.length) {
      const q = queue.shift()!;
      const r = await act(q.tool, q.args ?? {}, 'queue');
      if (!r.ok) { queue = []; wakeNow({ level: 'wake', reason: 'queue_failed', key: `queue_failed:${orders.rev}`, detail: [...blockedLines(r.error), `${q.tool}: ${r.error?.code ?? ''} ${r.error?.message ?? ''}`.trim()].join('\n') }); continue; }
      const aa = afterAction(q.tool, r.stop);
      if (aa.wake) { queue = []; wakeNow({ level: 'wake', reason: aa.reason, key: `${aa.reason}:${turn.turn_no}`, detail: lastOutcome || obs.summary }); }
      else writeState();
      continue;
    }
    // 起こして待っている: ソロ（とキャンプ）は止まって待つ。協力プレイは持ち場の動きで毎手番すぐに答える
    if (waiting && (!coop || obs.status === 'at_camp')) {
      if (!reloadOrders()) await sleep(pollMs);
      continue;
    }
    if (waiting && coop && turn.turn_no - waiting.sinceTurn >= orders.policy.hold_max_turns) {
      raise({ level: 'wake', reason: 'still_waiting', key: `still_waiting:${turn.turn_no}`, detail: `${waiting.reason}（${turn.turn_no - waiting.sinceTurn} 手番返事が無い）` }, 'holding');
      waiting.sinceTurn = turn.turn_no;
    }
    // 経過を知らせる
    const every = orders.policy.notify_every_turns;
    if (every > 0 && turn.turn_no - lastNotify >= every) {
      lastNotify = turn.turn_no;
      raise({ level: 'notify', reason: 'periodic', key: `periodic:${turn.turn_no}`, detail: obs.summary });
    }
    if (refused.turn !== turn.turn_no) { refused.turn = turn.turn_no; refused.tools.clear(); refused.last = null; }
    const scope = scopeNow();
    for (const [k, sc] of [...notified]) if (sc !== scope) notified.delete(k);
    const { decision, active, notify } = decide(obs, { orders, coop, waiting: !!waiting, acked, text, refused: refused.tools, refusal: refused.last, notified: new Set(notified.keys()) });
    // 目的でない遺物・役割のある敵: 同じ遠征の同じ階にいる間に 1 回だけ知らせる（止まらない。V4-1a §12.6）
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
      continue;
    }
    const before = turn.turn_no;
    const r = await act(decision.tool, decision.args, 'pilot');
    if (!r.ok) {
      if (r.error?.code === 'call_failed') continue;
      // 持ち場の動きは止まれない: 断られたら 1 手番待つ
      if (waiting || orders.mode === 'hold') { const h = holdAction(obs, orders.policy); if (h.tool !== decision.tool) await act(h.tool, h.args, 'pilot'); else await act('wait', {}, 'pilot'); continue; }
      // 移動の道具が断られた（経路がふさがれている等）: その手番の間は外して、表の次の行へ
      if (MOVE_TOOLS.has(decision.tool)) {
        refused.tools.add(decision.tool);
        // 「何も無い」より、ふさがれた・隣に敵がいる等の理由を残す
        const code = r.error?.code ?? 'unknown';
        if (!refused.last || refused.last.code === 'nothing_to_do') refused.last = { code, text: lastOutcome, ...(r.error?.details?.blocked_by?.length ? { blockedBy: [...r.error.details.blocked_by] } : {}) };
        continue;
      }
      wakeNow({ level: 'wake', reason: `refused_${r.error?.code ?? 'unknown'}`, key: `refused:${decision.tool}:${r.error?.code ?? ''}:${turn.turn_no}`, detail: [...blockedLines(r.error), lastOutcome].join('\n') });
      continue;
    }
    // 手番が進まない命令が続いたら起こす（同じ所で止まり続けない）
    stuck = turn.turn_no === before ? stuck + 1 : 0;
    if (decision.then) { wakeNow(decision.then, true); continue; }
    if (stuck >= 3) { stuck = 0; wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:${turn.turn_no}`, detail: lastOutcome }); continue; }
    if (waiting || orders.mode === 'hold') { writeState(); continue; }
    const aa = afterAction(decision.tool, r.stop);
    if (!aa.wake) { writeState(); continue; }
    const sig = `${aa.reason}|${decision.tool}|${JSON.stringify(decision.args)}|${scopeNow()}`;
    sameStop = sameStop.sig === sig ? { sig, count: sameStop.count + 1 } : { sig, count: 1 };
    if (sameStop.count > 3) {
      sameStop = { sig: '', count: 0 };
      wakeNow({ level: 'wake', reason: 'stuck', key: `stuck:${turn.turn_no}`, detail: `同じ命令（${decision.tool}）が同じ止まり方（${aa.reason}）で 4 回止まった: ${lastOutcome}` });
    } else wakeNow({ level: 'wake', reason: aa.reason, key: `${aa.reason}:${turn.turn_no}`, detail: lastOutcome || obs.summary });
  }
}

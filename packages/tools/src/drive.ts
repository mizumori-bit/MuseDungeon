// 参照ドライバ（IMPROVEMENTS_V2 §1.4）: ホスト側ループの見本。ゲームのルールを知らない薄いループ。
//   ターンフィードを購読
//     turn  → 設定された「エージェント呼び出し」に観測テキストと turn ブロックを渡す
//     idle  → 同じ呼び出しを再送（回数上限あり）
//     ended → 成績を出力して終了
// ドライバは行動を選ばない。AI が MCP で行動した結果、次の turn が流れてくることでループが回る。
// 安全装置（最大手番数・最大実時間・連続エラー数）に達したら「中断」する。遠征は終了せず、後で再開できる。
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FeedEvent, Observation, RunSummary, TurnBlock } from '@muse/shared';

export interface AgentCall {
  event: 'turn' | 'idle';
  token: string;
  mcpUrl: string;
  turn: TurnBlock;
  observationText: string;
  seq: number;
}

/** エージェント呼び出し（差し替え可能）。終わるまで待つ */
export interface AgentInvoker { name: string; invoke(call: AgentCall): Promise<void> }

/** (a) 任意のコマンド: 標準入力に観測テキスト、環境変数にトークンと MCP の URL。終了を待つ */
export function commandInvoker(command: string): AgentInvoker {
  return {
    name: `command: ${command}`,
    invoke: (call) => new Promise<void>((resolve, reject) => {
      const child = spawn(command, {
        shell: true,
        stdio: ['pipe', 'inherit', 'inherit'],
        env: {
          ...process.env,
          MUSE_PLAYER_TOKEN: call.token, MUSE_MCP_URL: call.mcpUrl, MUSE_FEED_EVENT: call.event,
          MUSE_TURN_JSON: JSON.stringify(call.turn), MUSE_SEQ: String(call.seq),
        },
      });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`agent command exited with ${code}`))));
      child.stdin.end(`${call.observationText}\n`);
    }),
  };
}

/** (b) 任意の HTTP エンドポイントへ POST（応答を待つ） */
export function httpInvoker(url: string): AgentInvoker {
  return {
    name: `http: ${url}`,
    async invoke(call) {
      const res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: call.event, player_token: call.token, mcp_url: call.mcpUrl, turn: call.turn, observation_text: call.observationText, seq: call.seq }),
      });
      if (!res.ok) throw new Error(`agent endpoint returned ${res.status}`);
      await res.text();
    },
  };
}

/** 観測だけから 1 手を選ぶ簡易方針（ダミーのエージェント用。ルールの知識は最小限） */
export function dummyDecide(obs: Observation): { tool: string; args: Record<string, unknown> } {
  const x = obs.expedition;
  if (obs.status === 'at_camp') return { tool: 'start_expedition', args: { offer: obs.camp?.offers[0]?.index ?? 'endless' } };
  const mons = obs.visible.monsters;
  const adj = mons.find((m) => m.dist === 1);
  if (adj && adj.dir) return { tool: 'move', args: { dir: adj.dir } };
  if (x?.can_extract && x.extract_outcome === 'complete') return { tool: 'extract', args: {} };
  const hunting = mons.find((m) => m.awareness === 'hunting' && m.dist <= 6);
  if (hunting) return { tool: 'travel_to', args: { to: hunting.id } };
  const hpPct = Math.trunc((obs.self.hp * 100) / Math.max(1, obs.self.max_hp));
  if (!mons.length && hpPct < 50 && obs.self.rest_estimate && !obs.self.rest_estimate.blocked_by) return { tool: 'rest', args: {} };
  const stairs = obs.navigation.known_stairs.filter((s) => s.reachable);
  if (x?.extract_outcome === 'complete' && stairs.length) return { tool: 'travel_to', args: { to: stairs[0].type === 'down' ? 'stairs_down' : 'stairs_up' } };
  const guardian = mons.find((m) => m.role === 'guardian');
  if (guardian && hpPct >= 60) return { tool: 'travel_to', args: { to: guardian.id } };
  const relic = obs.visible.items.find((i) => i.role === 'relic');
  if (relic) return relic.dist === 0 ? { tool: 'pickup', args: { item: relic.id } } : { tool: 'travel_to', args: { to: relic.id } };
  if (obs.navigation.frontiers.length) return { tool: 'explore', args: {} };
  const onTarget = x && x.objective.target_depth !== null && (obs.self.floor?.depth ?? 0) >= x.objective.target_depth;
  if (onTarget && x.status !== 'objective_complete') {
    // 目標階を探索し尽くした → 撤退
    if (x.can_extract) return { tool: 'extract', args: { confirm: true } };
    if (stairs.length) return { tool: 'travel_to', args: { to: stairs[0].type === 'down' ? 'stairs_down' : 'stairs_up' } };
  }
  const down = stairs.find((s) => s.type === 'down');
  if (down) return down.dist === 0 ? { tool: 'use_stairs', args: {} } : { tool: 'travel_to', args: { to: 'stairs_down' } };
  return { tool: 'wait', args: {} };
}

/** (c) 内蔵ダミー: 呼ばれるたびに MCP（Streamable HTTP）へ繋ぎ、resume_run → 観測から 1 手打って切断する */
export function dummyInvoker(): AgentInvoker {
  return {
    name: 'dummy (MCP, one action per call)',
    async invoke(call) {
      const client = new Client({ name: 'muse-drive-dummy', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(call.mcpUrl)));
      try {
        const resumed = (await client.callTool({ name: 'resume_run', arguments: { player_token: call.token } })) as { structuredContent?: { observation?: Observation } };
        const obs = resumed.structuredContent?.observation;
        if (!obs) throw new Error('resume_run returned no observation');
        const d = dummyDecide(obs);
        const r = (await client.callTool({ name: d.tool, arguments: { ...d.args, thought: `dummy: ${d.tool}` } })) as { isError?: boolean; structuredContent?: { ok?: boolean } };
        // 断られた手（既知の経路で届かない相手への travel_to など）は時間が進まないので、同じ手を繰り返さないよう待つ
        if (r.isError || r.structuredContent?.ok === false) await client.callTool({ name: 'wait', arguments: { thought: 'dummy: fallback wait' } });
      } finally {
        await client.close();
      }
    },
  };
}

export interface DriveOptions {
  /** サーバーの起点 URL（例 http://127.0.0.1:7777） */
  baseUrl: string;
  token: string;
  invoker: AgentInvoker;
  maxTurns?: number;
  maxMs?: number;
  maxErrors?: number;
  maxIdleRetries?: number;
  log?: (msg: string) => void;
}

export interface DriveResult {
  /** ended: 遠征かランが終わった / interrupted: 安全装置で中断（遠征は進行中のまま） */
  outcome: 'ended' | 'interrupted';
  scope?: 'expedition' | 'run';
  reason: string;
  invocations: number;
  text?: string;
  summary?: RunSummary | null;
}

/** SSE を読んでイベントを順に返す */
export async function* readFeed(res: Response): AsyncGenerator<FeedEvent> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (data) yield JSON.parse(data) as FeedEvent;
    }
  }
}

export async function drive(opts: DriveOptions): Promise<DriveResult> {
  const log = opts.log ?? (() => undefined);
  const mcpUrl = new URL('/mcp', opts.baseUrl).toString();
  const ac = new AbortController();
  const res = await fetch(new URL('/api/player/feed', opts.baseUrl), { headers: { authorization: `Bearer ${opts.token}` }, signal: ac.signal });
  if (!res.ok || !res.body) throw new Error(`feed: HTTP ${res.status}`);
  const maxTurns = opts.maxTurns ?? 5000;
  const maxMs = opts.maxMs ?? 6 * 60 * 60 * 1000;
  const maxErrors = opts.maxErrors ?? 5;
  const maxIdle = opts.maxIdleRetries ?? 3;
  const t0 = Date.now();
  let invocations = 0;
  let errors = 0;
  let idleRetries = 0;
  let lastSeq = -1;
  // 呼び出し中に届いたイベントは最新のものだけ残す（ended は優先）
  const st: { pending: FeedEvent | null; wake: (() => void) | null; feedDone: boolean } = { pending: null, wake: null, feedDone: false };
  void (async () => {
    try {
      for await (const ev of readFeed(res)) {
        if (ev.type === 'hello') continue;
        if (st.pending?.type !== 'ended') st.pending = ev;
        st.wake?.();
      }
    } catch { /* 切断 */ }
    st.feedDone = true;
    st.wake?.();
  })();
  const finish = (r: DriveResult): DriveResult => { ac.abort(); return r; };
  for (;;) {
    const ev = st.pending;
    if (!ev) {
      if (st.feedDone) return finish({ outcome: 'interrupted', reason: 'feed_closed', invocations });
      await new Promise<void>((r) => { st.wake = r; });
      st.wake = null;
      continue;
    }
    st.pending = null;
    if (ev.type === 'hello') continue;
    if (ev.type === 'ended') {
      log(`ended (${ev.scope}): ${ev.text}`);
      return finish({ outcome: 'ended', scope: ev.scope, reason: ev.scope === 'run' ? 'run_ended' : 'expedition_ended', invocations, text: ev.text, summary: ev.summary });
    }
    if (ev.type === 'turn' && ev.seq <= lastSeq) continue;
    if (ev.type === 'idle') {
      if (idleRetries >= maxIdle) return finish({ outcome: 'interrupted', reason: 'idle_limit', invocations });
      idleRetries++;
    } else idleRetries = 0;
    if (invocations >= maxTurns) return finish({ outcome: 'interrupted', reason: 'max_turns', invocations });
    if (Date.now() - t0 > maxMs) return finish({ outcome: 'interrupted', reason: 'max_time', invocations });
    lastSeq = ev.seq;
    const text = ev.type === 'turn' ? ev.observation_text : `(idle ${ev.seconds}s) ${ev.turn.state}`;
    try {
      invocations++;
      await opts.invoker.invoke({ event: ev.type, token: opts.token, mcpUrl, turn: ev.turn, observationText: text, seq: ev.seq });
      errors = 0;
    } catch (e) {
      errors++;
      log(`agent call failed (${errors}/${maxErrors}): ${(e as Error).message}`);
      if (errors >= maxErrors) return finish({ outcome: 'interrupted', reason: 'errors', invocations });
    }
  }
}

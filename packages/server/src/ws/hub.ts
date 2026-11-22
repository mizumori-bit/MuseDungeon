// WebSocket（/ws）。最初のメッセージ hello で役割を決める。観戦者は書き込み系メッセージを送れない。
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ClientMsg, PlayerId, PlayerView, ServerMsg } from '@muse/shared';
import { actionError } from '@muse/shared';
import type { ServerConfig } from '../config';
import { isLocalRequest } from '../http/local';
import type { SessionManager } from '../session/SessionManager';
import { SpectatorPort } from '../session/SpectatorPort';
import { attachPlayerSocket } from './playerSocket';

/** 追従だけの観戦で、送りがこれより詰まっている（遅い回線）間は、手ごとの枠をやめて 40ms でまとめる */
const FOLLOW_BACKLOG_BYTES = 1 << 20;

export class WsHub {
  readonly wss = new WebSocketServer({ noServer: true });

  constructor(private readonly manager: SessionManager, private readonly config: ServerConfig) {
    this.wss.on('connection', (ws, req: IncomingMessage) => this.onConnection(ws, req));
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    const local = req ? isLocalRequest(req) : false;
    const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const timeout = setTimeout(() => ws.close(4000, 'hello timeout'), 10000);
    ws.once('message', (raw) => {
      clearTimeout(timeout);
      // hello の処理の中の例外で、サーバーの処理ごと止めない（その接続だけ断って閉じる）
      try {
        this.onHello(ws, raw, local, send);
      } catch (e) {
        console.error(`[ws] hello の処理で例外（その接続を閉じた）: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
        send({ t: 'error', error: actionError('bad_request', 'the server could not handle this hello', '') });
        ws.close(1011);
      }
    });
  }

  private onHello(ws: WebSocket, raw: unknown, local: boolean, send: (m: ServerMsg) => void): void {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(raw)); } catch { send({ t: 'error', error: actionError('bad_request', 'invalid JSON', '') }); ws.close(); return; }
    if (!msg || typeof msg !== 'object' || msg.t !== 'hello') { send({ t: 'error', error: actionError('bad_request', 'first message must be hello', '') }); ws.close(); return; }
    if (msg.role === 'player') {
      const token = typeof msg.token === 'string' ? msg.token : '';
      const port = token ? this.manager.portForToken(token) : null;
      if (!port || port.runId !== msg.runId) { send({ t: 'error', error: this.manager.recoveryFailedForToken(token) ?? (typeof msg.runId === 'string' ? this.manager.recoveryFailedError(msg.runId) : null) ?? actionError('no_session', 'invalid token for this run', 'ロビーから参加し直す') }); ws.close(); return; }
      attachPlayerSocket(ws, port, this.manager.get(msg.runId)?.world.meta.season ? 'follow_only' : this.config.spectatorPolicy);
      return;
    }
    if (typeof msg.runId !== 'string') { send({ t: 'error', error: actionError('bad_request', 'runId must be a string', '') }); ws.close(); return; }
    const session = this.manager.get(msg.runId);
    if (!session) { send({ t: 'error', error: this.manager.recoveryFailedError(msg.runId) ?? actionError('no_session', 'run is not live', 'リプレイ画面で見る') }); ws.close(); return; }
    // 開催中のシーズンのランは、その参加者のトークンか、同じ機械からの接続だけ（S3。SEASON.md §25.1）。確定した後は、だれでも
    const gate = this.manager.seasonWatchAccess(session, { local, profileToken: typeof msg.profileToken === 'string' ? msg.profileToken : undefined });
    if ('error' in gate) { send({ t: 'error', error: gate.error }); ws.close(); return; }
    // シーズンのランは follow_only（S0 §9.7: 俯瞰から公開されていない階段が分からないように）
    const spec = new SpectatorPort(session, session.world.meta.season ? 'follow_only' : this.config.spectatorPolicy, this.config.spectatorDelaySeq, gate.access === 'owner' ? gate.pid : null);
    // 追う相手（持ち主の観戦は、持ち主を追うので見ない）: 渡されたら、そのランのプレイヤーの ID でなければ断る。無ければ最初のプレイヤー
    const follow: unknown = gate.access === 'owner' ? gate.pid : msg.follow ?? undefined;
    if (follow !== undefined && !spec.hasPlayer(follow)) {
      send({ t: 'error', error: actionError('bad_request', 'follow is not a player of this run', 'follow を省くか、そのランのプレイヤーの ID（p_…）を渡す') });
      ws.close();
      return;
    }
    this.attachSpectator(ws, spec, msg.mode, follow);
  }

  private attachSpectator(ws: WebSocket, spec: SpectatorPort, mode: 'director' | 'follow', follow?: PlayerId): void {
    const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const unsubs: (() => void)[] = [];
    // 切れたらリスナーを外す（途中で例外が出て閉じたときも、それまでに付けた分を外すので、先に付ける）
    ws.on('close', () => { for (const u of unsubs) u(); });
    const policy = spec.policy;
    // この観戦者の枠を作る・送る所の例外は、この接続だけを閉じる（ログに 1 行）。ほかのリスナーと命令の結果は RunSession.notify が守る
    let failed = false;
    const guarded = <A extends unknown[]>(fn: (...a: A) => void) => (...a: A): void => {
      if (failed) return;
      try {
        fn(...a);
      } catch (e) {
        failed = true;
        console.error(`[ws] ${spec.runId} の観戦の枠で例外（その観戦者の接続を閉じた）: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
        for (const u of unsubs) u();
        ws.close(1011);
      }
    };
    if (mode === 'director' && !spec.directorAllowed()) {
      send({ t: 'error', error: actionError('bad_request', 'director view is disabled by spectatorPolicy=follow_only', 'mode: follow で特定プレイヤーを追従する') });
      ws.close();
      return;
    }
    send({ t: 'welcome', role: 'spectator', runId: spec.runId, contentVersion: spec.contentVersion, policy, mode });
    if (spec.viewOnly()) {
      // 追従のみ: World ではなく、追従の相手の PlayerView と、その人に届いた出来事（遊ぶ画面の WS と同じ中身）だけを送る。
      // 追従の相手が知覚した手は、命令の確定 1 回（世界が 1 回進む）ごとに、その時点の view とその手の出来事で 1 枠（マクロの途中の手を 1 枚にまとめない）。
      // 相手が知覚しない確定（ほかの階の者の手など）と、送りが詰まっている間は、40ms でまとめる（出来事は次の枠に入る）
      const pid = follow ?? spec.players()[0];
      let timer: NodeJS.Timeout | null = null;
      let lastSent = 0;
      const sendFrame = (v: PlayerView | null, withEvents: boolean) => {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!pid || !v) return;
        const events = withEvents ? spec.followPerceivedSince(pid, lastSent) : [];
        lastSent = v.seq;
        send({ t: 'view', view: v, events });
      };
      // 接続した直後は、出来事なしの今の view（つなぎ直しで前の出来事をくり返さない）
      sendFrame(pid ? spec.followView(pid) : null, false);
      const flushLater = guarded(() => sendFrame(spec.followView(pid), true));
      unsubs.push(spec.onCommit(guarded((events) => {
        if (!pid) return;
        const v = spec.followView(pid);
        if (v && ws.bufferedAmount < FOLLOW_BACKLOG_BYTES && spec.followPerceives(pid, events, v)) sendFrame(v, true);
        else if (!timer) timer = setTimeout(flushLater, 40);
      })));
      unsubs.push(() => { if (timer) clearTimeout(timer); timer = null; });
      unsubs.push(spec.onAgent(guarded((a) => { if (a.playerId === pid) send({ t: 'agent', activity: a }); })));
    } else {
      const snap = spec.snapshot();
      send({ t: 'snapshot', seq: snap.seq, world: snap.world });
      for (const a of spec.recentActivity()) send({ t: 'agent', activity: a });
      unsubs.push(spec.subscribe(guarded((events) => send({ t: 'events', events })), snap.seq));
      if (policy !== 'delayed') unsubs.push(spec.onAgent(guarded((a) => send({ t: 'agent', activity: a }))));
      unsubs.push(spec.onMacro(guarded((m) => send({ t: 'macro', ...m }))));
    }
    let endedSent = false;
    const sendEnded = guarded(() => {
      const s = spec.summary();
      if (s && !endedSent) { endedSent = true; send({ t: 'ended', summary: s }); }
    });
    sendEnded();
    unsubs.push(spec.onChange(sendEnded));
    ws.on('message', () => send({ t: 'error', error: actionError('bad_request', 'spectators cannot send commands', '') }));
  }

  close(): void {
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }
}

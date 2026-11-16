// ターンフィード（IMPROVEMENTS_V2 §1.3）: GET /api/player/feed（SSE、プレイヤートークンで認証）。
// ホスト（AI を動かす側のループ）が「手番が来た」を外部から受け取るための経路。ゲームの進行には影響しない。
//   turn  : 手番が来た（マクロ展開中は送らない）。turn ブロック＋ brief 観測テキスト
//   idle  : 手番のまま idleNoticeMs 入力が無い（その間隔ごと）
//   ended : 遠征の終了（scope: expedition）またはランの終了（scope: run）
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeedEvent } from '@muse/shared';
import { resultText } from '@muse/shared';
import type { ServerConfig } from '../config';
import type { SessionManager } from '../session/SessionManager';

export function feedToken(req: IncomingMessage, url: URL): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  return url.searchParams.get('token');
}

export function handleFeed(req: IncomingMessage, res: ServerResponse, manager: SessionManager, config: ServerConfig, token: string): boolean {
  const r = manager.resolveToken(token);
  const port = manager.portForToken(token);
  if (!r || !port) return false;
  const { session, playerId } = r;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  let closed = false;
  const send = (ev: FeedEvent) => { if (!closed) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
  const base = () => ({ runId: session.runId, playerId, seq: port.view().seq });

  let lastTurnKey: string | null = null;
  let lastTurnAt = Date.now();
  let lastIdleAt = 0;
  let endedScope: string | null = null;

  const check = () => {
    if (closed) return;
    const v = port.view();
    if (v.status === 'ended' || v.status === 'dead') {
      if (endedScope !== 'run') {
        endedScope = 'run';
        const turn = port.turnBlock('observed');
        send({ type: 'ended', ...base(), scope: 'run', turn, text: port.turnLine(turn), summary: port.summary() });
      }
      return;
    }
    if (v.status === 'at_camp' && !v.expedition) {
      // キャンプから始まったラン: 最初の遠征を選ぶ番（終了ではないので turn として 1 回送る）
      const key = 'camp:first';
      if (lastTurnKey !== key) {
        lastTurnKey = key;
        lastTurnAt = Date.now();
        lastIdleAt = lastTurnAt;
        const o = port.observeWithTurn('turn_arrived', { detail: 'brief', map: false, changes: 'peek' });
        send({ type: 'turn', ...base(), turn: o.turn, observation_text: o.text });
      }
      return;
    }
    if (v.status === 'at_camp') {
      const key = `expedition:${v.expedition?.no ?? 0}`;
      if (endedScope !== key) {
        endedScope = key;
        const turn = port.turnBlock('observed');
        const head = v.expedition ? resultText(v.locale, v.expedition) : '';
        send({ type: 'ended', ...base(), scope: 'expedition', turn, text: [head, port.turnLine(turn)].filter(Boolean).join('\n'), summary: null });
      }
      return;
    }
    if (v.status !== 'your_turn' || session.isMacroRunning(playerId)) return;
    const key = session.turnKeyOf(playerId);
    if (key === lastTurnKey) return;
    lastTurnKey = key;
    lastTurnAt = Date.now();
    lastIdleAt = lastTurnAt;
    const o = port.observeWithTurn('turn_arrived', { detail: 'brief', map: true, changes: 'peek' });
    send({ type: 'turn', ...base(), turn: o.turn, observation_text: o.text });
  };

  let pending = false;
  const schedule = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => { pending = false; check(); });
  };

  const unsub = session.addListener({
    onEvents: () => schedule(),
    onMacro: (m) => { if (m.playerId === playerId && m.state === 'stopped') schedule(); },
  });
  const idleTimer = setInterval(() => {
    if (closed) return;
    const v = port.view();
    if (v.status !== 'your_turn' || session.isMacroRunning(playerId) || session.turnKeyOf(playerId) !== lastTurnKey) return;
    const now = Date.now();
    const since = Math.max(lastTurnAt, session.lastInputAt(playerId));
    if (now - since < config.idleNoticeMs || now - lastIdleAt < config.idleNoticeMs) return;
    lastIdleAt = now;
    send({ type: 'idle', ...base(), seconds: Math.floor((now - lastTurnAt) / 1000), turn: port.turnBlock('observed') });
  }, Math.max(50, Math.min(1000, Math.floor(config.idleNoticeMs / 4))));
  const ping = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15000);
  idleTimer.unref?.();
  ping.unref?.();

  const close = () => {
    if (closed) return;
    closed = true;
    unsub();
    clearInterval(idleTimer);
    clearInterval(ping);
  };
  req.on('close', close);
  res.on('close', close);

  send({ type: 'hello', ...base(), turn: port.turnBlock('observed') });
  check();
  return true;
}

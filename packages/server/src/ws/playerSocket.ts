// 人間プレイヤー用 WS。MCP と同一の Command スキーマで、同じ PlayerPort.act を通る（特別扱いしない）。
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { ClientMsg, ServerMsg, SpectatorPolicy } from '@muse/shared';
import { actionError, CommandSchema } from '@muse/shared';
import type { PlayerPort } from '../session/PlayerPort';

/** query の引数（MCP の look・map と同じ形。利用者の値をそのまま盤の計算に渡さない） */
const LookTargetZ = z.union([z.object({ x: z.number().int(), y: z.number().int() }), z.string()]);
const MapRegionZ = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int().min(1).max(80), h: z.number().int().min(1).max(60) });

export function attachPlayerSocket(ws: WebSocket, port: PlayerPort, policy: SpectatorPolicy): void {
  const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  let lastSent = 0;
  let timer: NodeJS.Timeout | null = null;
  let endedSent = false;

  const flush = () => {
    timer = null;
    // 枠を作る・送る所の例外で、サーバーの処理ごと止めない（タイマーの中なので、受け止める者がいない）
    try {
      const view = port.view();
      const events = port.perceivedSince(lastSent);
      lastSent = view.seq;
      send({ t: 'view', view, events });
      const summary = port.summary();
      if (summary && !endedSent) { endedSent = true; send({ t: 'ended', summary }); }
    } catch (e) {
      console.error(`[ws] ${port.runId} のプレイヤーの枠で例外（その接続を閉じた）: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
      ws.close(1011);
    }
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 40); };

  send({ t: 'welcome', role: 'player', runId: port.runId, contentVersion: port.catalog.contentVersion, playerId: port.playerId, policy });
  // 接続直後は直近の出来事も少し送る
  lastSent = Math.max(0, port.view().seq - 400);
  flush();
  const unsub = port.onChange(schedule);
  const unsubMacro = port.onMacro((m) => send({ t: 'macro', playerId: port.playerId, ...m }));

  // 1 通の処理の中の例外は、その 1 通の断りにする（async の処理の例外は、受け止めないとサーバーの処理ごと止まる）
  ws.on('message', (raw) => {
    onMessage(raw).catch((e) => {
      console.error(`[ws] ${port.runId} のプレイヤーのメッセージの処理で例外（断った）: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
      send({ t: 'error', error: actionError('bad_request', 'the server could not handle this message', '') });
    });
  });
  const onMessage = async (raw: unknown) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(raw)); } catch { return send({ t: 'error', error: actionError('bad_request', 'invalid JSON', '') }); }
    if (!msg || typeof msg !== 'object') return send({ t: 'error', error: actionError('bad_request', 'message must be an object', '') });
    if (msg.t === 'command') {
      const parsed = CommandSchema.safeParse(msg.command);
      if (!parsed.success) return send({ t: 'error', error: actionError('bad_request', parsed.error.issues.map((i) => i.message).join('; '), 'Command スキーマを確認する') });
      const r = await port.act(parsed.data, {
        source: 'ws',
        expectSeq: typeof msg.expectSeq === 'number' ? msg.expectSeq : undefined,
        thought: typeof msg.thought === 'string' ? msg.thought : undefined,
        map: false,
      });
      if (!r.ok) send({ t: 'error', error: r.error, valid_actions: r.valid_actions });
      schedule();
      return;
    }
    if (msg.t === 'query') {
      const a = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>;
      let data: unknown;
      switch (msg.kind) {
        case 'look': {
          const tg = LookTargetZ.safeParse(a.target ?? port.view().self.id);
          if (!tg.success) return send({ t: 'error', error: actionError('bad_request', 'look: target must be an entity ID or { x, y } (integers)', '') });
          data = port.look(tg.data);
          break;
        }
        case 'map': {
          const rg = a.region === undefined ? undefined : MapRegionZ.safeParse(a.region);
          if (rg && !rg.success) return send({ t: 'error', error: actionError('bad_request', 'map: region must be { x, y, w (1-80), h (1-60) } (integers)', '') });
          data = port.map(rg?.data);
          break;
        }
        case 'inventory': data = port.inventory(); break;
        case 'recall': data = port.recall(String(a.kind_name ?? '')); break;
        case 'messages': data = port.messages(typeof a.since_seq === 'number' ? a.since_seq : undefined, typeof a.limit === 'number' ? a.limit : undefined); break;
        case 'observation': data = port.observe({ detail: a.detail === 'brief' ? 'brief' : 'full', map: true }); break;
        default: data = null;
      }
      return send({ t: 'result', id: msg.id, data });
    }
    send({ t: 'error', error: actionError('bad_request', `unexpected message ${String((msg as { t: unknown }).t)}`, '') });
  };
  ws.on('close', () => { unsub(); unsubMacro(); if (timer) clearTimeout(timer); });
}

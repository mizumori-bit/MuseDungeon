// 人間プレイヤー用 WS。MCP と同一の Command スキーマで、同じ PlayerPort.act を通る（特別扱いしない）。
import type { WebSocket } from 'ws';
import type { ClientMsg, ServerMsg, SpectatorPolicy } from '@muse/shared';
import { actionError, CommandSchema } from '@muse/shared';
import type { PlayerPort } from '../session/PlayerPort';

export function attachPlayerSocket(ws: WebSocket, port: PlayerPort, policy: SpectatorPolicy): void {
  const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  let lastSent = 0;
  let timer: NodeJS.Timeout | null = null;
  let endedSent = false;

  const flush = () => {
    timer = null;
    const view = port.view();
    const events = port.perceivedSince(lastSent);
    lastSent = view.seq;
    // 目標（V3-7a。World の外）: AI と同じ候補と記録を渡す
    send({ t: 'view', view, events, goal: port.goalInfo() });
    const summary = port.summary();
    if (summary && !endedSent) { endedSent = true; send({ t: 'ended', summary }); }
  };
  const schedule = () => { if (!timer) timer = setTimeout(flush, 40); };

  send({ t: 'welcome', role: 'player', runId: port.runId, contentVersion: port.catalog.contentVersion, playerId: port.playerId, policy });
  // 接続直後は直近の出来事も少し送る
  lastSent = Math.max(0, port.view().seq - 400);
  flush();
  const unsub = port.onChange(schedule);
  const unsubMacro = port.onMacro((m) => send({ t: 'macro', playerId: port.playerId, ...m }));

  ws.on('message', async (raw) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(String(raw)); } catch { return send({ t: 'error', error: actionError('bad_request', 'invalid JSON', '') }); }
    if (msg.t === 'command') {
      const parsed = CommandSchema.safeParse(msg.command);
      if (!parsed.success) return send({ t: 'error', error: actionError('bad_request', parsed.error.issues.map((i) => i.message).join('; '), 'Command スキーマを確認する') });
      const r = await port.act(parsed.data, { source: 'ws', expectSeq: msg.expectSeq, thought: msg.thought, map: false });
      if (!r.ok) send({ t: 'error', error: r.error, valid_actions: r.valid_actions });
      schedule();
      return;
    }
    if (msg.t === 'goal') {
      // 目標の宣言（V3-7a。AI の declare_goal と同じ口）
      const r = port.declareGoal(msg.decl ?? null);
      send({ t: 'result', id: 'goal', data: r });
      schedule();
      return;
    }
    if (msg.t === 'query') {
      const a = (msg.args ?? {}) as Record<string, any>;
      let data: unknown;
      switch (msg.kind) {
        case 'look': data = port.look(a.target ?? port.view().self.id); break;
        case 'map': data = port.map(a.region); break;
        case 'inventory': data = port.inventory(); break;
        case 'recall': data = port.recall(String(a.kind_name ?? '')); break;
        case 'messages': data = port.messages(a.since_seq, a.limit); break;
        case 'observation': data = port.observe({ detail: a.detail ?? 'full', map: true }); break;
        default: data = null;
      }
      return send({ t: 'result', id: msg.id, data });
    }
    send({ t: 'error', error: actionError('bad_request', `unexpected message ${(msg as { t: string }).t}`, '') });
  });
  ws.on('close', () => { unsub(); unsubMacro(); if (timer) clearTimeout(timer); });
}

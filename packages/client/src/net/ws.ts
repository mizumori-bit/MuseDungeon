// WebSocket 接続（/ws）。切断時は hello を再送して自動再接続する。
import type { ClientMsg, ServerMsg } from '@muse/shared';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsHandle {
  send(msg: ClientMsg): void;
  close(): void;
}

export function connectWs(hello: ClientMsg, onMsg: (m: ServerMsg) => void, onStatus?: (s: WsStatus) => void): WsHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const url = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/ws`;

  const open = () => {
    if (closed) return;
    onStatus?.('connecting');
    try {
      ws = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      retry = 0;
      onStatus?.('open');
      ws?.send(JSON.stringify(hello));
    };
    ws.onmessage = (ev) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg;
      } catch {
        return;
      }
      onMsg(m);
    };
    ws.onclose = () => {
      onStatus?.('closed');
      schedule();
    };
    ws.onerror = () => {
      /* onclose で再接続 */
    };
  };

  const schedule = () => {
    if (closed) return;
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(open, 500 * 2 ** retry);
  };

  open();
  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}

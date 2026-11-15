// プレイ画面（人間）。AI と同じ Command を同じ PlayerPort（WS 経由）へ送る。
// 受け取るのはサーバーの PlayerView フレーム＋知覚イベントだけ（生のイベント列は受け取らない）。
import type { Command, Dir, PerceivedEvent, PlayerView, Pos, RunSummary, ServerMsg } from '@muse/shared';
import { buildNavGrid, buildObservation, findPath, itemDisplayName } from '@muse/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectWs, type WsHandle, type WsStatus } from '../net/ws';
import type { Canvas2DRenderer } from '../render/canvas2d';
import { toViewEvents } from '../render/events';
import { sceneFromView } from '../render/scene';
import { AlertsBar, InventoryPanel, MessageLog, StatusPanel, SummaryDialog, type InvAction, type LogLine } from '../ui/panels';
import { ErrorBanner, Header, MapView, ThemePicker, useCatalog, useLocaleRefresh, useTheme } from '../ui/common';
import { perceivedLines } from '../ui/narration';
import { getLocale, getToken, tr } from '../util';

const MOVE_KEYS: Record<string, Dir> = {
  ArrowUp: 'n', ArrowDown: 's', ArrowLeft: 'w', ArrowRight: 'e',
  k: 'n', j: 's', h: 'w', l: 'e', y: 'nw', u: 'ne', b: 'sw', n: 'se',
  8: 'n', 2: 's', 4: 'w', 6: 'e', 7: 'nw', 9: 'ne', 1: 'sw', 3: 'se',
  Home: 'nw', PageUp: 'ne', End: 'sw', PageDown: 'se',
};
const DIR_D: Record<Dir, [number, number]> = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };

type Mode = 'normal' | 'target' | 'dir' | 'inv';

export function Play({ runId }: { runId: string }) {
  useLocaleRefresh();
  const { catalog, error: catErr } = useCatalog();
  const th = useTheme(catalog);
  const token = getToken(runId);
  const [view, setView] = useState<PlayerView | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [macro, setMacro] = useState<{ kind: string; state: string; steps: number; reason?: string } | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [mode, setModeState] = useState<Mode>('normal');
  const [selSlot, setSelSlot] = useState<string | null>(null);
  const [chat, setChat] = useState('');

  const viewRef = useRef<PlayerView | null>(null);
  const catalogRef = useRef(catalog);
  const rRef = useRef<Canvas2DRenderer | null>(null);
  const wsRef = useRef<WsHandle | null>(null);
  const pendingRef = useRef(false);
  const macroRef = useRef(false);
  const modeRef = useRef<Mode>('normal');
  const cursorRef = useRef<Pos | null>(null);
  const pathRef = useRef<Pos[] | null>(null);
  const throwSlotRef = useRef<string | null>(null);
  catalogRef.current = catalog;

  const setMode = (m: Mode) => { modeRef.current = m; setModeState(m); if (m !== 'target') cursorRef.current = null; redraw(); };

  const redraw = (evs?: PerceivedEvent[]) => {
    const v = viewRef.current, c = catalogRef.current, r = rRef.current;
    if (!v || !c || !r) return;
    const scene = sceneFromView(v, c, { cursor: cursorRef.current, path: modeRef.current === 'normal' ? pathRef.current : null });
    if (!scene) return;
    r.draw(scene);
    if (evs?.length) void r.animate(toViewEvents(evs.map((e) => e.event), c));
  };

  const addLog = (lines: LogLine[]) => { if (lines.length) setLog((l) => [...l, ...lines].slice(-400)); };

  useEffect(() => {
    if (!token) return;
    const onMsg = (m: ServerMsg) => {
      switch (m.t) {
        case 'view':
          viewRef.current = m.view;
          pendingRef.current = false;
          setView(m.view);
          addLog(perceivedLines(m.events));
          redraw(m.events);
          break;
        case 'macro':
          macroRef.current = m.state === 'running';
          setMacro({ kind: m.kind, state: m.state, steps: m.steps, reason: m.reason });
          break;
        case 'error':
          pendingRef.current = false;
          addLog([{ seq: viewRef.current?.seq ?? 0, text: `⚠ ${m.error.message}${m.error.hint ? ` — ${m.error.hint}` : ''}`, kind: 'error' }]);
          if (m.error.code === 'no_session' || m.error.code === 'bad_request') setError(m.error.message);
          break;
        case 'ended':
          setSummary(m.summary);
          break;
        case 'result': {
          const d = m.data as { text?: string } | null;
          if (d?.text) addLog([{ seq: viewRef.current?.seq ?? 0, text: d.text, kind: 'info' }]);
          break;
        }
        default:
          break;
      }
    };
    const ws = connectWs({ t: 'hello', role: 'player', runId, token: token.token }, onMsg, setWsStatus);
    wsRef.current = ws;
    return () => ws.close();
  }, [runId]);

  useEffect(() => { redraw(); }, [catalog]);

  const send = (command: Command) => {
    const v = viewRef.current;
    const free = command.type === 'say' || command.type === 'note' || command.type === 'retire';
    if (!v || !wsRef.current) return;
    if (!free && (v.status !== 'your_turn' || pendingRef.current || macroRef.current)) return;
    if (!free) {
      pendingRef.current = true;
      setTimeout(() => { pendingRef.current = false; }, 4000);
    }
    pathRef.current = null;
    wsRef.current.send({ t: 'command', command, expectSeq: free ? undefined : v.seq });
  };

  const throwables = (v: PlayerView): string[] => v.inventory.filter((it) => {
    const ci = it.kind ? catalogRef.current?.items[it.kind] : undefined;
    const cat = ci?.category ?? (it.appearanceId ? catalogRef.current?.appearances[it.appearanceId]?.category : undefined);
    return !it.equipped && (ci?.throwable || cat === 'throwing' || cat === 'potion');
  }).map((it) => it.slot);

  const monstersByDist = (v: PlayerView) => v.entities.filter((e) => e.cat === 'monster' && v.self.pos)
    .sort((a, b) => Math.max(Math.abs(a.pos.x - v.self.pos!.x), Math.abs(a.pos.y - v.self.pos!.y)) - Math.max(Math.abs(b.pos.x - v.self.pos!.x), Math.abs(b.pos.y - v.self.pos!.y)));

  const startThrow = (slot: string | null) => {
    const v = viewRef.current;
    if (!v) return;
    const s = slot ?? (selSlot && throwables(v).includes(selSlot) ? selSlot : throwables(v)[0] ?? null);
    if (!s) { addLog([{ seq: v.seq, text: tr('投げられる物を持っていない。', 'Nothing to throw.'), kind: 'error' }]); return; }
    throwSlotRef.current = s;
    const m = monstersByDist(v)[0];
    cursorRef.current = m ? { ...m.pos } : v.self.pos ? { ...v.self.pos } : null;
    setMode('target');
  };

  const fireThrow = (at?: Pos) => {
    const v = viewRef.current;
    const slot = throwSlotRef.current;
    const p = at ?? cursorRef.current;
    if (!v || !slot || !p) return;
    const ent = v.entities.find((e) => e.cat === 'monster' && e.pos.x === p.x && e.pos.y === p.y);
    setMode('normal');
    send({ type: 'throw', slot, target: ent ? ent.id : { x: p.x, y: p.y } });
  };

  const invAction = (a: InvAction, slot: string) => {
    setSelSlot(slot);
    if (a === 'throw') { startThrow(slot); return; }
    if (a === 'use') send({ type: 'use', slot });
    else if (a === 'equip') send({ type: 'equip', slot });
    else if (a === 'unequip') send({ type: 'unequip', slot });
    else if (a === 'drop') send({ type: 'drop', slot });
  };

  const defaultInvAction = (slot: string) => {
    const v = viewRef.current;
    const it = v?.inventory.find((x) => x.slot === slot);
    if (!v || !it) return;
    const ci = it.kind ? catalogRef.current?.items[it.kind] : undefined;
    const cat = ci?.category ?? (it.appearanceId ? catalogRef.current?.appearances[it.appearanceId]?.category : undefined);
    if (it.equipped) invAction('unequip', slot);
    else if (ci?.slot) invAction('equip', slot);
    else if (cat === 'potion' || cat === 'scroll' || ci?.usable) invAction('use', slot);
    else if (ci?.throwable || cat === 'throwing') invAction('throw', slot);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement | null;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const v = viewRef.current;
      if (!v) return;
      const md = modeRef.current;
      const dir = MOVE_KEYS[e.key];
      let handled = true;
      if (e.key === 'Escape') { throwSlotRef.current = null; setMode('normal'); }
      else if (md === 'target') {
        if (dir && cursorRef.current) {
          const d = DIR_D[dir];
          cursorRef.current = { x: cursorRef.current.x + d[0], y: cursorRef.current.y + d[1] };
          redraw();
        } else if (e.key === 'Tab') {
          const ms = monstersByDist(v);
          if (ms.length) {
            const cur = cursorRef.current;
            const i = ms.findIndex((m) => cur && m.pos.x === cur.x && m.pos.y === cur.y);
            cursorRef.current = { ...ms[(i + 1) % ms.length].pos };
            redraw();
          }
        } else if (e.key === 'Enter' || e.key === 't' || e.key === 'f') fireThrow();
        else handled = false;
      } else if (md === 'dir') {
        if (dir) { setMode('normal'); send({ type: 'interact', dir }); }
        else if (e.key === '.' || e.key === '5' || e.key === 'Clear') { setMode('normal'); send({ type: 'interact' }); }
        else handled = false;
      } else if (md === 'inv') {
        if (/^[a-z]$/.test(e.key)) { setMode('normal'); defaultInvAction(e.key); }
        else if (e.key === 'i') setMode('normal');
        else handled = false;
      } else if (dir) send({ type: 'move', dir });
      else if (e.key === '.' || e.key === '5' || e.key === 'Clear') send({ type: 'wait' });
      else if (e.key === 'x') send({ type: 'explore' });
      else if (e.key === 'R') send({ type: 'rest' });
      else if (e.key === 'g' || e.key === ',') send({ type: 'pickup' });
      else if (e.key === '>' || e.key === '<') send({ type: 'stairs' });
      else if (e.key === 'T') send({ type: 'travel', to: 'stairs_down' });
      else if (e.key === 'i') setMode('inv');
      else if (e.key === 't') startThrow(null);
      else if (e.key === 'o' || e.key === 'c') setMode('dir');
      else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selSlot]);

  const gridRef = useRef<{ seq: number; grid: ReturnType<typeof buildNavGrid> } | null>(null);
  const onHover = (p: Pos | null) => {
    const v = viewRef.current, c = catalogRef.current;
    if (!v || !c || modeRef.current !== 'normal' || !p || !v.self.pos || !v.floor) {
      if (pathRef.current) { pathRef.current = null; redraw(); }
      return;
    }
    if (!gridRef.current || gridRef.current.seq !== v.seq) gridRef.current = { seq: v.seq, grid: buildNavGrid(v, c) };
    const grid = gridRef.current.grid;
    const idx = p.y * v.floor.width + p.x;
    pathRef.current = grid && v.memory.terrain[idx] ? findPath(grid, v.self.pos, [idx], false) : null;
    redraw();
  };

  const onClick = (p: Pos) => {
    const v = viewRef.current;
    if (!v?.floor || !v.self.pos) return;
    if (modeRef.current === 'target') { fireThrow(p); return; }
    if (p.x === v.self.pos.x && p.y === v.self.pos.y) return;
    if (!v.memory.terrain[p.y * v.floor.width + p.x]) return;
    send({ type: 'travel', to: { x: p.x, y: p.y } });
  };

  const obs = useMemo(() => (view && catalog ? buildObservation(view, catalog, { detail: 'brief', map: false }) : null), [view, catalog]);
  const L = getLocale();
  const modeHint = mode === 'target'
    ? tr('投擲: 方向キー/Tab で狙い、Enter で投げる（Esc 取消）', 'Throw: aim with keys/Tab, Enter to throw (Esc cancels)')
    : mode === 'dir' ? tr('操作する方向を選ぶ（. で足元、Esc 取消）', 'Pick a direction (. for here, Esc cancels)')
      : mode === 'inv' ? tr('スロットの文字で既定の操作（i/Esc で戻る）', 'Press a slot letter (i/Esc to exit)') : null;

  if (!token) {
    return (
      <div class="page">
        <Header title={tr('プレイ', 'Play')} />
        <div class="banner error">{tr('このランのプレイヤートークンがありません。ロビーから参加してください。', 'No player token for this run. Join from the lobby.')} <a href="#/">{tr('ロビーへ', 'Lobby')}</a> / <a href={`#/watch/${runId}`}>{tr('観戦する', 'Watch')}</a></div>
      </div>
    );
  }

  return (
    <div class="page play">
      <Header title={`${tr('プレイ', 'Play')} ${runId}`}>
        <span class={`ws ${wsStatus}`}>{wsStatus}</span>
        <ThemePicker themes={th.themes} themeId={th.themeId} onChange={th.setThemeId} />
        <a class="button small" href={`#/watch/${runId}`}>{tr('観戦画面', 'Spectate')}</a>
      </Header>
      <ErrorBanner error={error ?? catErr ?? th.error} onClose={() => setError(null)} />
      <div class="layout">
        <div class="main">
          {obs && <AlertsBar alerts={obs.alerts} />}
          <MapView
            theme={th.theme}
            onReady={(r) => { rRef.current = r; redraw(); }}
            onCellHover={onHover}
            onCellClick={onClick}
            overlay={
              <>
                {modeHint && <div class="modehint">{modeHint}</div>}
                {macro?.state === 'running' && <div class="macro">{tr('自動行動中', 'Auto')}: {macro.kind} ({macro.steps})</div>}
                {view && view.status === 'waiting_others' && <div class="macro">{tr('他のプレイヤーの手番を待っています…', 'Waiting for other players…')}</div>}
                {view && view.status === 'dead' && !summary && (
                  <div class="deadbox">{tr('あなたは倒れた。', 'You have fallen.')} <a href={`#/watch/${runId}`}>{tr('観戦を続ける', 'Keep watching')}</a> / <a href={`#/replay/${runId}`}>{tr('リプレイ', 'Replay')}</a></div>
                )}
              </>
            }
          />
          <div class="actions">
            <button class="small" onClick={() => send({ type: 'explore' })} title="x">{tr('探索', 'Explore')} (x)</button>
            <button class="small" onClick={() => send({ type: 'rest' })} title="R">{tr('休憩', 'Rest')} (R)</button>
            <button class="small" onClick={() => send({ type: 'wait' })} title=".">{tr('待機', 'Wait')} (.)</button>
            <button class="small" onClick={() => send({ type: 'pickup' })} title="g">{tr('拾う', 'Pick up')} (g)</button>
            <button class="small" onClick={() => send({ type: 'travel', to: 'stairs_down' })} title="T">{tr('下り階段へ', 'To stairs')} (T)</button>
            <button class="small" onClick={() => send({ type: 'stairs' })} title=">">{tr('階段を使う', 'Use stairs')} (&gt;)</button>
            <button class="small" onClick={() => setMode('dir')} title="o">{tr('操作', 'Interact')} (o)</button>
            <button class="small" onClick={() => startThrow(null)} title="t">{tr('投げる', 'Throw')} (t)</button>
            <button class="small danger" onClick={() => { if (window.confirm(tr('ランから引退しますか？', 'Retire from this run?'))) send({ type: 'retire' }); }}>{tr('引退', 'Retire')}</button>
          </div>
          {obs && (
            <details class="panel valid">
              <summary>{tr('できること', 'Valid actions')} ({obs.valid_actions.length})</summary>
              <div class="muted">{obs.valid_actions.join(' / ')}</div>
            </details>
          )}
        </div>
        <aside class="side">
          {view && catalog && <StatusPanel view={view} catalog={catalog} />}
          {view && catalog && <InventoryPanel view={view} catalog={catalog} onAction={invAction} focused={mode === 'inv'} selected={selSlot} onSelect={setSelSlot} />}
          <MessageLog lines={log} />
          <form class="chat" onSubmit={(e) => { e.preventDefault(); if (chat.trim()) { send({ type: 'say', text: chat.trim().slice(0, 280) }); setChat(''); } }}>
            <input value={chat} placeholder={tr('チャット（COOP）', 'Chat (COOP)')} onInput={(e) => setChat((e.target as HTMLInputElement).value)} />
          </form>
          {view && catalog && view.inventory.length > 0 && selSlot && (
            <div class="muted small">{tr('選択中', 'Selected')}: {(() => { const it = view.inventory.find((x) => x.slot === selSlot); return it ? itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes) : '-'; })()}</div>
          )}
          <div class="help muted">
            {tr('移動: 矢印/テンキー/hjklyubn　待機: .　探索: x　休憩: R　拾う: g　階段: >　投擲: t　操作: o　所持品: i　クリック: その場所へ移動',
              'Move: arrows/numpad/hjklyubn  Wait: .  Explore: x  Rest: R  Pick up: g  Stairs: >  Throw: t  Interact: o  Inventory: i  Click: travel')}
          </div>
        </aside>
      </div>
      {summary && <SummaryDialog summary={summary} catalog={catalog} onClose={() => setSummary(null)} />}
    </div>
  );
}

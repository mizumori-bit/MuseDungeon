// プレイ画面（人間）。AI と同じ Command を同じ PlayerPort（WS 経由）へ送る。
// 受け取るのはサーバーの PlayerView フレーム＋知覚イベントだけ（生のイベント列は受け取らない）。
import type { ActionError, Change, Command, Dir, EntityView, Observation, PerceivedEvent, PlayerView, Pos, RunSummary, ServerMsg, TurnSnapshot } from '@muse/shared';
import { buildNavGrid, buildObservation, buildTurnBlock, diffChanges, findPath, itemDisplayName, monsterDisplayName, turnLine, turnSnapshot } from '@muse/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectWs, type WsHandle, type WsStatus } from '../net/ws';
import type { Canvas2DRenderer } from '../render/canvas2d';
import { toViewEvents } from '../render/events';
import { sceneFromView } from '../render/scene';
import { AlertsBar, InventoryPanel, MessageLog, StatusPanel, SummaryDialog, type InvAction, type LogLine } from '../ui/panels';
import { ErrorBanner, Header, MapView, ThemePicker, useCatalog, useLocaleRefresh, useTheme } from '../ui/common';
import { BriefingCard, CampPanel, completesOnExtract, ExpeditionPanel, extractConfirmText, RestEstimateLine, rulesOf, TurnBar } from '../ui/expedition';
import { extractBlockLabel, viewStatusLabel } from '../ui/labels';
import { perceivedLines } from '../ui/narration';
import { getLocale, getPref, getToken, setPref, tr } from '../util';

const MOVE_KEYS: Record<string, Dir> = {
  ArrowUp: 'n', ArrowDown: 's', ArrowLeft: 'w', ArrowRight: 'e',
  k: 'n', j: 's', h: 'w', l: 'e', y: 'nw', u: 'ne', b: 'sw', n: 'se',
  8: 'n', 2: 's', 4: 'w', 6: 'e', 7: 'nw', 9: 'ne', 1: 'sw', 3: 'se',
  Home: 'nw', PageUp: 'ne', End: 'sw', PageDown: 'se',
};
const DIR_D: Record<Dir, [number, number]> = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };

type Mode = 'normal' | 'target' | 'dir' | 'inv';

/** 手番を消費しないコマンド（いつでも送れる） */
const FREE: ReadonlySet<Command['type']> = new Set<Command['type']>(['say', 'note', 'retire']);

interface SnapAt { snap: TurnSnapshot; seq: number }

function errorLine(err: ActionError): string {
  return `${err.message}${err.hint ? ` — ${err.hint}` : ''}`;
}

/** 既知の「自分が投げた物」の数（観測の visible.items の mine。collect の対象） */
function knownThrown(obs: Observation | null): number {
  return obs ? obs.visible.items.filter((i) => i.mine).reduce((a, i) => a + i.qty, 0) : 0;
}

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
  const [changes, setChanges] = useState<Change[]>([]);
  const [briefingNo, setBriefingNo] = useState<number | null>(null);
  const [restHp, setRestHp] = useState('');

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
  /** 変化の基準: 最後に自分が行動を決めた時点の要約（その行動で世界が進んだら確定する） */
  const baseSnapRef = useRef<SnapAt | null>(null);
  const pendingBaseRef = useRef<SnapAt | null>(null);
  const curSnapRef = useRef<SnapAt | null>(null);
  /** 変化の基準以降に知覚した出来事（diffChanges が撃破・目の前の死を区別するのに使う） */
  const eventsRef = useRef<PerceivedEvent[]>([]);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [aim, setAim] = useState<{ text: string; blocked: boolean } | null>(null);
  catalogRef.current = catalog;

  /** 地図の上に数秒だけ出す注意（射線が通らない等） */
  const flash = (text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4500);
  };

  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    if (m !== 'target') { cursorRef.current = null; setAim(null); }
    redraw();
  };

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
          if (m.events.length) eventsRef.current = [...eventsRef.current, ...m.events];
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
          addLog([{ seq: viewRef.current?.seq ?? 0, text: `⚠ ${errorLine(m.error)}`, kind: 'error' }]);
          // 射線が通らない相手を ID で狙った（手番は消費されない）: 地図の上にもはっきり出す
          if (m.error.code === 'no_line_of_sight') flash(errorLine(m.error));
          // 表示上は達成に見えても、サーバーが撤退扱いと判断した場合（最終判定はサーバー）
          if (m.error.code === 'confirm_required' && window.confirm(extractConfirmText(obsNow()?.expedition, false, rulesOf(catalogRef.current)))) {
            send({ type: 'extract', confirm: true });
          }
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
    const free = FREE.has(command.type);
    const camp = command.type === 'start_expedition';
    if (!v || !wsRef.current) return;
    if (camp ? v.status !== 'at_camp' || pendingRef.current : !free && (v.status !== 'your_turn' || pendingRef.current || macroRef.current)) return;
    if (!free) {
      pendingRef.current = true;
      setTimeout(() => { pendingRef.current = false; }, 4000);
      // 次に世界が進んだら、この時点を「前の手番」として変化を数える
      if (curSnapRef.current) pendingBaseRef.current = curSnapRef.current;
    }
    pathRef.current = null;
    wsRef.current.send({ t: 'command', command, expectSeq: free || camp ? undefined : v.seq });
  };

  const obsNow = () => {
    const v = viewRef.current, c = catalogRef.current;
    return v && c ? buildObservation(v, c, { detail: 'brief', map: false }) : null;
  };

  /** extract: 達成済みなら帰還、未達成なら確認してから撤退（confirm: true） */
  const doExtract = () => {
    const v = viewRef.current;
    if (!v) return;
    const x = v.expedition;
    const ox = obsNow()?.expedition;
    if (!x || !ox || x.status === 'ended' || v.status === 'at_camp') {
      addLog([{ seq: v.seq, text: tr('進行中の遠征が無い。', 'No expedition in progress.'), kind: 'error' }]);
      return;
    }
    if (!ox.can_extract) {
      addLog([{ seq: v.seq, text: `${tr('今は extract できない', 'Cannot extract now')}（${extractBlockLabel(ox.extract_blocked_by)}）`, kind: 'error' }]);
      return;
    }
    // どちらも遠征を終える操作なので、確定する点を見せてから送る
    const complete = completesOnExtract(x);
    if (!window.confirm(extractConfirmText(ox, complete, rulesOf(catalogRef.current)))) return;
    send(complete ? { type: 'extract' } : { type: 'extract', confirm: true });
  };

  /** collect: 既知の「自分が投げた物」を近い順に回収する（マクロ） */
  const doCollect = () => {
    const v = viewRef.current;
    if (!v) return;
    if (!knownThrown(obsNow())) {
      addLog([{ seq: v.seq, text: tr('回収できる「自分が投げた物」を知らない。', 'You know of no thrown items of yours to collect.'), kind: 'error' }]);
      return;
    }
    send({ type: 'collect' });
  };

  /** rest: untilHp を指定すると、その HP まで（現在より大きく最大未満のときのみ） */
  const doRest = (untilHp?: number) => {
    const v = viewRef.current;
    if (!v) return;
    if (untilHp !== undefined && untilHp > v.self.stats.hp && untilHp < v.self.stats.maxHp) send({ type: 'rest', untilHp });
    else send({ type: 'rest' });
  };

  const startExpedition = (offer: number | 'endless') => send({ type: 'start_expedition', offer });
  const retire = () => {
    const msg = tr('引退しますか？ ランは終了し、キャラクターは戻りません。', 'Retire? The run ends and the character does not return.');
    if (window.confirm(msg)) send({ type: 'retire' });
  };

  const throwables = (v: PlayerView): string[] => v.inventory.filter((it) => {
    const ci = it.kind ? catalogRef.current?.items[it.kind] : undefined;
    const cat = ci?.category ?? (it.appearanceId ? catalogRef.current?.appearances[it.appearanceId]?.category : undefined);
    return !it.equipped && (ci?.throwable || cat === 'throwing' || cat === 'potion');
  }).map((it) => it.slot);

  const distOf = (v: PlayerView, p: Pos) => (v.self.pos ? Math.max(Math.abs(p.x - v.self.pos.x), Math.abs(p.y - v.self.pos.y)) : 0);
  const monsterAt = (v: PlayerView, p: Pos): EntityView | undefined => v.entities.find((e) => e.cat === 'monster' && e.pos.x === p.x && e.pos.y === p.y);
  /** 投擲の狙いの候補: 射線が通る相手（shot）を先に、近い順 */
  const throwTargets = (v: PlayerView) => v.entities.filter((e) => e.cat === 'monster' && v.self.pos)
    .sort((a, b) => Number(b.shot !== false) - Number(a.shot !== false) || distOf(v, a.pos) - distOf(v, b.pos) || (a.id < b.id ? -1 : 1));
  /** 選んだ投擲物の射程（鑑定済みのときだけ分かる） */
  const throwRange = (v: PlayerView): number | null => {
    const it = v.inventory.find((x) => x.slot === throwSlotRef.current);
    return it?.kind ? catalogRef.current?.items[it.kind]?.throwRange ?? null : null;
  };

  /** 狙いを動かし、射線・距離・射程を表示する */
  const setCursor = (p: Pos | null) => {
    cursorRef.current = p;
    const v = viewRef.current, c = catalogRef.current;
    if (!v || !c || !p) { setAim(null); redraw(); return; }
    const ent = monsterAt(v, p);
    const d = distOf(v, p);
    const range = throwRange(v);
    const dist = tr(`距離 ${d}${range !== null ? ` / 射程 ${range}` : ''}${range !== null && d > range ? '（射程外）' : ''}`,
      `dist ${d}${range !== null ? ` / range ${range}` : ''}${range !== null && d > range ? ' (out of range)' : ''}`);
    if (ent) {
      const name = monsterDisplayName(c, getLocale(), ent);
      setAim(ent.shot === false
        ? { blocked: true, text: tr(`狙い: ${name} — 射線が通らない（${dist}）。Shift+Enter でそのマスへ投げる`, `Aim: ${name} — no clear line (${dist}). Shift+Enter throws at the cell`) }
        : { blocked: false, text: tr(`狙い: ${name} — 射線: 通る（${dist}）`, `Aim: ${name} — clear line (${dist})`) });
    } else setAim({ blocked: false, text: tr(`狙い: (${p.x},${p.y})（${dist}）`, `Aim: (${p.x},${p.y}) (${dist})`) });
    redraw();
  };

  const startThrow = (slot: string | null) => {
    const v = viewRef.current;
    if (!v) return;
    const s = slot ?? (selSlot && throwables(v).includes(selSlot) ? selSlot : throwables(v)[0] ?? null);
    if (!s) { addLog([{ seq: v.seq, text: tr('投げられる物を持っていない。', 'Nothing to throw.'), kind: 'error' }]); return; }
    throwSlotRef.current = s;
    const m = throwTargets(v)[0];
    setMode('target');
    setCursor(m ? { ...m.pos } : v.self.pos ? { ...v.self.pos } : null);
  };

  /** force: 射線が通らない相手のマスへ、座標を狙って投げる（遮られた位置に落ちる） */
  const fireThrow = (at?: Pos, force = false) => {
    const v = viewRef.current, c = catalogRef.current;
    const slot = throwSlotRef.current;
    const p = at ?? cursorRef.current;
    if (!v || !slot || !p) return;
    const ent = monsterAt(v, p);
    if (ent && ent.shot === false && !force) {
      const name = c ? monsterDisplayName(c, getLocale(), ent) : ent.id;
      const msg = tr(`${name} への射線が通らない（壁や他の者に遮られる）。別の相手を選ぶか、Shift+Enter／Shift+クリックでそのマスへ投げる（途中で落ちる）。`,
        `No clear line to ${name} (blocked by a wall or someone). Pick another target, or Shift+Enter / Shift+click to throw at the cell (it will drop short).`);
      flash(msg);
      addLog([{ seq: v.seq, text: `⚠ ${msg}`, kind: 'error' }]);
      return;
    }
    setMode('normal');
    send({ type: 'throw', slot, target: ent && ent.shot !== false ? ent.id : { x: p.x, y: p.y } });
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
      if (e.key === 'Escape') { throwSlotRef.current = null; setMode('normal'); setBriefingNo(null); }
      else if (md === 'target') {
        if (dir && cursorRef.current) {
          const d = DIR_D[dir];
          setCursor({ x: cursorRef.current.x + d[0], y: cursorRef.current.y + d[1] });
        } else if (e.key === 'Tab') {
          // 射線が通る相手から順に巡回（Shift+Tab で逆順）
          const ms = throwTargets(v);
          if (ms.length) {
            const cur = cursorRef.current;
            const i = ms.findIndex((m) => cur && m.pos.x === cur.x && m.pos.y === cur.y);
            const next = e.shiftKey ? (i <= 0 ? ms.length - 1 : i - 1) : (i + 1) % ms.length;
            setCursor({ ...ms[next].pos });
          }
        } else if (e.key === 'Enter' || e.key === 't' || e.key === 'f') fireThrow(undefined, e.shiftKey);
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
      else if (e.key === 'R') doRest();
      else if (e.key === 'E') doExtract();
      else if (e.key === 'g' || e.key === ',') send({ type: 'pickup' });
      else if (e.key === '>' || e.key === '<') send({ type: 'stairs' });
      else if (e.key === 'T') send({ type: 'travel', to: 'stairs_down' });
      else if (e.key === 'i') setMode('inv');
      else if (e.key === 't') startThrow(null);
      // c は従来どおり「操作」の別名。回収は C（Shift+c）
      else if (e.key === 'C') doCollect();
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

  const onClick = (p: Pos, ev: MouseEvent) => {
    const v = viewRef.current;
    if (!v?.floor || !v.self.pos) return;
    if (modeRef.current === 'target') { fireThrow(p, ev.shiftKey); return; }
    if (p.x === v.self.pos.x && p.y === v.self.pos.y) return;
    if (!v.memory.terrain[p.y * v.floor.width + p.x]) return;
    send({ type: 'travel', to: { x: p.x, y: p.y } });
  };

  // recent: 自分を攻撃している相手を投擲の候補で優先するため（できること一覧）
  const obs = useMemo(() => (view && catalog ? buildObservation(view, catalog, { detail: 'brief', map: false, recent: eventsRef.current.slice(-30) }) : null), [view, catalog]);
  const L = getLocale();
  const thrownKnown = knownThrown(obs);

  // 前回の自分の手番以降の変化（turnSnapshot / diffChanges。撃破の判定に基準以降の出来事を渡す）
  useEffect(() => {
    if (!view || !obs) return;
    const cur: SnapAt = { snap: turnSnapshot(view, obs), seq: view.seq };
    curSnapRef.current = cur;
    const pb = pendingBaseRef.current;
    if (pb && view.seq > pb.seq) { baseSnapRef.current = pb; pendingBaseRef.current = null; }
    if (!baseSnapRef.current) baseSnapRef.current = cur;
    const base = baseSnapRef.current;
    // 基準より前の出来事は不要（長い待機でも溜め込みすぎない）
    eventsRef.current = eventsRef.current.filter((e) => e.seq > base.seq).slice(-2000);
    if (base === cur) return;
    if (view.status === 'waiting_others') return;
    setChanges(diffChanges(base.snap, cur.snap, view, obs, eventsRef.current));
  }, [obs]);

  // 遠征の開始時（再開時を含む）に一度だけブリーフィングを出す
  const expNo = view?.expedition && view.expedition.status !== 'ended' && view.status !== 'at_camp' ? view.expedition.no : null;
  useEffect(() => {
    if (expNo === null) return;
    const key = `brief.${runId}`;
    if (getPref(key, '') === String(expNo)) return;
    setPref(key, String(expNo));
    setBriefingNo(expNo);
  }, [expNo]);

  const turnText = view ? turnLine(view, buildTurnBlock(view, { reason: 'action_completed', changes })) : '';
  const restEst = obs?.self.rest_estimate;
  const atCamp = view?.status === 'at_camp';
  const exp = view?.expedition ?? null;
  const expActive = !!exp && exp.status !== 'ended' && !atCamp;
  const modeHint = mode === 'target'
    ? tr('投擲: 方向キー/Tab で狙い（射線が通る相手が先）、Enter で投げる・Shift+Enter でそのマスへ（Esc 取消）',
      'Throw: aim with keys/Tab (clear lines first), Enter to throw, Shift+Enter at the cell (Esc cancels)')
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
        {view && <span class={`tag vstatus ${view.status}`}>{viewStatusLabel(view.status)}</span>}
        {view && (
          <span class="tag banked" title={tr('持ち帰って確定した点（スコア）。遠征中の戦利品は帰還まで未確定', 'Banked points (your score). The haul of the current expedition is unbanked until you extract')}>
            {tr(`確定 ${view.record.banked}`, `banked ${view.record.banked}`)}
          </span>
        )}
        <span class={`ws ${wsStatus}`}>{wsStatus}</span>
        <ThemePicker themes={th.themes} themeId={th.themeId} onChange={th.setThemeId} />
        <a class="button small" href={`#/watch/${runId}`}>{tr('観戦画面', 'Spectate')}</a>
      </Header>
      <ErrorBanner error={error ?? catErr ?? th.error} onClose={() => setError(null)} />
      <div class="layout">
        <div class="main">
          {obs && <AlertsBar alerts={obs.alerts} />}
          <TurnBar line={turnText} changes={changes} />
          <MapView
            theme={th.theme}
            onReady={(r) => { rRef.current = r; redraw(); }}
            onCellHover={onHover}
            onCellClick={onClick}
            overlay={
              <>
                {(modeHint || notice) && (
                  <div class="modehint">
                    {modeHint && <div>{modeHint}</div>}
                    {mode === 'target' && aim && <div class={`aim ${aim.blocked ? 'blocked' : ''}`}>{aim.text}</div>}
                    {notice && <div class="notice">⚠ {notice}</div>}
                  </div>
                )}
                {macro?.state === 'running' && <div class="macro">{tr('自動行動中', 'Auto')}: {macro.kind} ({macro.steps})</div>}
                {view && view.status === 'waiting_others' && <div class="macro">{tr('他のプレイヤーの手番を待っています…', 'Waiting for other players…')}</div>}
                {view && atCamp && <div class="campwrap"><CampPanel view={view} catalog={catalog} onStart={startExpedition} onRetire={retire} /></div>}
                {exp && expActive && briefingNo === exp.no && <BriefingCard x={exp} catalog={catalog} onClose={() => setBriefingNo(null)} />}
                {view && view.status === 'dead' && !summary && (
                  <div class="deadbox">{tr('あなたは倒れた。', 'You have fallen.')} <a href={`#/watch/${runId}`}>{tr('観戦を続ける', 'Keep watching')}</a> / <a href={`#/replay/${runId}`}>{tr('リプレイ', 'Replay')}</a></div>
                )}
              </>
            }
          />
          <div class="actions">
            <button class="small" onClick={() => send({ type: 'explore' })} title="x">{tr('探索', 'Explore')} (x)</button>
            <button class="small" onClick={() => doRest()} title="R">{tr('休憩', 'Rest')} (R)</button>
            <span class="resthp">
              <input type="number" min={1} max={view?.self.stats.maxHp ?? 999} value={restHp} placeholder="HP"
                onInput={(e) => setRestHp((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doRest(parseInt(restHp, 10) || undefined); } }} />
              <button class="small" onClick={() => doRest(parseInt(restHp, 10) || undefined)} title={tr('指定した HP まで休む', 'Rest until this HP')}>{tr('まで休む', 'Rest until')}</button>
            </span>
            <button class="small" onClick={() => send({ type: 'wait' })} title=".">{tr('待機', 'Wait')} (.)</button>
            <button class="small" onClick={() => send({ type: 'pickup' })} title="g">{tr('拾う', 'Pick up')} (g)</button>
            {thrownKnown > 0 && (
              <button class="small" onClick={doCollect} title={tr('既知の「自分が投げた物」を近い順に回って拾う（C）', 'Walk to and pick up your thrown items, nearest first (C)')}>
                {tr(`回収 ${thrownKnown}`, `Collect ${thrownKnown}`)} (C)
              </button>
            )}
            <button class="small" onClick={() => send({ type: 'travel', to: 'stairs_down' })} title="T">{tr('下り階段へ', 'To stairs')} (T)</button>
            <button class="small" onClick={() => send({ type: 'stairs' })} title=">">{tr('階段を使う', 'Use stairs')} (&gt;)</button>
            {exp && expActive && (
              <button class={`small ${obs?.expedition?.can_extract ? 'exit' : ''}`} onClick={doExtract} title={tr('階段の上で遠征を終える', 'End the expedition on stairs')}>
                {completesOnExtract(exp) ? tr('帰還', 'Extract') : tr('撤退', 'Withdraw')} (E)
              </button>
            )}
            <button class="small" onClick={() => setMode('dir')} title="o">{tr('操作', 'Interact')} (o)</button>
            <button class="small" onClick={() => startThrow(null)} title="t">{tr('投げる', 'Throw')} (t)</button>
            <button class="small danger" onClick={retire}>{tr('引退', 'Retire')}</button>
          </div>
          {restEst && !atCamp && <RestEstimateLine est={restEst} />}
          {obs && (
            <details class="panel valid">
              <summary>{tr('できること', 'Valid actions')} ({obs.valid_actions.length})</summary>
              <div class="muted">{obs.valid_actions.join(' / ')}</div>
            </details>
          )}
        </div>
        <aside class="side">
          {view && <ExpeditionPanel view={view} obs={obs} catalog={catalog} onBriefing={exp && expActive ? () => setBriefingNo(exp.no) : undefined} />}
          {view && catalog && <StatusPanel view={view} catalog={catalog} speed={obs?.self.speed} />}
          {view && catalog && <InventoryPanel view={view} catalog={catalog} onAction={invAction} focused={mode === 'inv'} selected={selSlot} onSelect={setSelSlot} />}
          <MessageLog lines={log} />
          <form class="chat" onSubmit={(e) => { e.preventDefault(); if (chat.trim()) { send({ type: 'say', text: chat.trim().slice(0, 280) }); setChat(''); } }}>
            <input value={chat} placeholder={tr('チャット（COOP）', 'Chat (COOP)')} onInput={(e) => setChat((e.target as HTMLInputElement).value)} />
          </form>
          {view && catalog && view.inventory.length > 0 && selSlot && (
            <div class="muted small">{tr('選択中', 'Selected')}: {(() => { const it = view.inventory.find((x) => x.slot === selSlot); return it ? itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes) : '-'; })()}</div>
          )}
          <div class="help muted">
            {tr('移動: 矢印/テンキー/hjklyubn　待機: .　探索: x　休憩: R　拾う: g　回収: C　階段: >　帰還/撤退: E（階段の上）　投擲: t　操作: o　所持品: i　クリック: その場所へ移動',
              'Move: arrows/numpad/hjklyubn  Wait: .  Explore: x  Rest: R  Pick up: g  Collect: C  Stairs: >  Extract: E (on stairs)  Throw: t  Interact: o  Inventory: i  Click: travel')}
          </div>
        </aside>
      </div>
      {summary && <SummaryDialog summary={summary} catalog={catalog} onClose={() => setSummary(null)} />}
    </div>
  );
}

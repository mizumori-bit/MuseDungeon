// プレイ画面（人間）。AI と同じ Command を同じ PlayerPort（WS 経由）へ送る。
// 受け取るのはサーバーの PlayerView フレーム＋知覚イベントだけ（生のイベント列は受け取らない）。
import type { ActionError, ActionErrorCode, Change, Command, Dir, EntityView, ObsMonster, Observation, PerceivedEvent, PlayerView, Pos, RunSummary, ServerMsg, TurnSnapshot } from '@muse/shared';
import {
  buildNavGrid, buildObservation, buildTurnBlock, diffChanges, findPath, itemDisplayName, itemStats, monsterDisplayName, pickableItems, turnLine, turnSnapshot,
} from '@muse/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectWs, type WsHandle, type WsStatus } from '../net/ws';
import type { Canvas2DRenderer } from '../render/canvas2d';
import { toViewEvents } from '../render/events';
import { sceneFromView } from '../render/scene';
import { AlertsBar, InventoryPanel, MessageLog, MonstersPanel, StatusPanel, SummaryDialog, type InvAction, type LogLine } from '../ui/panels';
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

/** pick: 鑑定の巻物の対象を選ぶ */
type Mode = 'normal' | 'target' | 'dir' | 'inv' | 'pick';

/** 移動マクロ（explore / travel / collect）の慎重さ。flee は退くときの専用ボタンで使う */
type MoveMode = 'careful' | 'steady';

/** 手番を消費しないコマンド（いつでも送れる） */
const FREE: ReadonlySet<Command['type']> = new Set<Command['type']>(['say', 'note', 'retire']);

/** 地図の上の注意に出さないエラー（手番のずれ等の雑音、確認ダイアログやバナーで扱うもの） */
const QUIET_ERRORS: ReadonlySet<ActionErrorCode> = new Set<ActionErrorCode>(['not_your_turn', 'stale_turn', 'confirm_required', 'no_session', 'bad_request', 'dead', 'run_ended']);

interface SnapAt { snap: TurnSnapshot; seq: number }

interface NoticeAction { label: string; title?: string; command: Command }
interface Notice { text: string; actions?: NoticeAction[] }

type ShotState = ObsMonster['shots'][number]['state'];

function errorLine(err: ActionError): string {
  return `${err.message}${err.hint ? ` — ${err.hint}` : ''}`;
}

/** 既知の「自分が投げた物」の数（観測の visible.items の mine。collect の対象） */
function knownThrown(obs: Observation | null): number {
  return obs ? obs.visible.items.filter((i) => i.mine).reduce((a, i) => a + i.qty, 0) : 0;
}

/** 鑑定の巻物か（公開カタログに効果の印が無いので、種別 ID で見分ける） */
function isIdentifyScroll(kind: string | null): boolean {
  return !!kind && kind.includes('identify');
}

/** 隣にいる、起きていて逃げていない敵（careful のマクロが動けない相手） */
function adjacentAwake(obs: Observation | null): ObsMonster[] {
  return obs ? obs.visible.monsters.filter((m) => m.dist === 1 && m.awareness !== 'asleep' && !m.fleeing) : [];
}

/**
 * 退く: 既知で辿り着ける階段へ travel mode: 'flee'（隣に敵がいても動く。途中で攻撃は受ける）。
 * 上り・下りのうち知っているものを、近い順に
 */
function fleeActions(obs: Observation | null): NoticeAction[] {
  if (!obs) return [];
  const out: (NoticeAction & { d: number })[] = [];
  for (const type of ['up', 'down'] as const) {
    const st = obs.navigation.known_stairs
      .filter((s) => s.type === type && s.reachable && (s.path_len ?? 0) > 0)
      .sort((a, b) => (a.path_len ?? 0) - (b.path_len ?? 0))[0];
    if (!st) continue;
    const n = st.path_len ?? st.dist;
    out.push({
      d: n,
      label: type === 'up' ? tr(`上り階段へ退く（flee・${n} 歩）`, `Flee to stairs up (${n})`) : tr(`下り階段へ退く（flee・${n} 歩）`, `Flee to stairs down (${n})`),
      title: tr('隣に敵がいても階段まで移動する（途中で攻撃は受ける。HP が 25% を下回ると止まる）', 'Moves to the stairs even with an enemy adjacent (you will be attacked; stops below 25% HP)'),
      command: { type: 'travel', to: type === 'up' ? 'stairs_up' : 'stairs_down', mode: 'flee' },
    });
  }
  return out.sort((a, b) => a.d - b.d).map(({ d: _d, ...a }) => a);
}

const HP_ORDER: Record<string, number> = { near_death: 0, badly_wounded: 1, wounded: 2, healthy: 3 };

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
  const [moveMode, setMoveModeState] = useState<MoveMode>(getPref('moveMode', 'careful') === 'steady' ? 'steady' : 'careful');
  /** 鑑定の巻物の対象の候補（pick モードの間だけ） */
  const [pick, setPickState] = useState<{ slot: string; options: { slot: string; name: string }[] } | null>(null);

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
  const moveModeRef = useRef<MoveMode>(moveMode);
  const pickRef = useRef<typeof pick>(null);
  /** 直近に描画した観測（キー操作の判定で使う。seq が今の view と違えば作り直す） */
  const obsRef = useRef<Observation | null>(null);
  const obsViewRef = useRef<PlayerView | null>(null);
  /** 変化の基準: 最後に自分が行動を決めた時点の要約（その行動で世界が進んだら確定する） */
  const baseSnapRef = useRef<SnapAt | null>(null);
  const pendingBaseRef = useRef<SnapAt | null>(null);
  const curSnapRef = useRef<SnapAt | null>(null);
  /** 変化の基準以降に知覚した出来事（diffChanges が撃破・目の前の死を区別するのに使う） */
  const eventsRef = useRef<PerceivedEvent[]>([]);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [aim, setAim] = useState<{ text: string; blocked: boolean } | null>(null);
  catalogRef.current = catalog;

  /** 地図の上に数秒だけ出す注意（射線が通らない・マクロが拒否された等）。actions があればボタンを添える */
  const flash = (text: string, actions?: NoticeAction[], ms = 4500) => {
    setNotice({ text, actions: actions?.length ? actions : undefined });
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), actions?.length ? Math.max(ms, 9000) : ms);
  };

  const setMoveMode = (m: MoveMode) => {
    moveModeRef.current = m;
    setPref('moveMode', m);
    setMoveModeState(m);
  };
  /** 移動マクロに付ける mode（careful は既定なので省く）。steady を渡すとその場だけ強行 */
  const modeArg = (force?: MoveMode): { mode?: 'steady' } => ((force ?? moveModeRef.current) === 'steady' ? { mode: 'steady' } : {});

  const setPick = (p: typeof pick) => { pickRef.current = p; setPickState(p); };

  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    if (m !== 'target') { cursorRef.current = null; setAim(null); }
    if (m !== 'pick' && pickRef.current) setPick(null);
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
          // 手番を使わずに拒否されたもの（射線が通らない・射程外の相手を ID で狙った、マクロが 1 歩も進めない等）は地図の上にもはっきり出す。
          // 隣に起きている敵がいて移動マクロが拒否されたら、退く（flee）を選べるようにする
          if (m.error.code === 'hostile_adjacent') flash(errorLine(m.error), fleeActions(obsNow()));
          else if (!QUIET_ERRORS.has(m.error.code)) flash(errorLine(m.error));
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

  /** 今の view の観測（描画済みのものがあれば使い回す） */
  const obsNow = (): Observation | null => {
    const v = viewRef.current, c = catalogRef.current;
    if (!v || !c) return null;
    if (obsRef.current && obsViewRef.current === v) return obsRef.current;
    const o = buildObservation(v, c, { detail: 'brief', map: false });
    obsRef.current = o;
    obsViewRef.current = v;
    return o;
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
    send({ type: 'collect', ...modeArg() });
  };

  /** collect items: 見えている・記憶しているアイテムを近い順に回って拾う（マクロ。遺物と鑑定済みの有害品は拾わない） */
  const doCollectItems = () => {
    const v = viewRef.current, c = catalogRef.current;
    if (!v || !c) return;
    if (!pickableItems(v, c).length) {
      const full = v.inventory.length >= v.self.capacity;
      flash(full ? tr('所持品がいっぱいで拾えない。', 'Your inventory is full.') : tr('拾いに行けるアイテムを知らない。', 'You know of no items to pick up.'));
      return;
    }
    send({ type: 'collect', what: 'items', ...modeArg() });
  };

  /**
   * fight: 隣の相手に近接攻撃を繰り返す（倒れた・離れた・HP が半分を下回った・別の追跡中の敵・状態異常で止まる）。
   * id を省くと、地図で指している隣の敵 → 追跡中の敵 → 弱っている敵の順に選ぶ
   */
  const doFight = (id?: string) => {
    const v = viewRef.current;
    const o = obsNow();
    if (!v || !o) return;
    const adj = o.visible.monsters.filter((m) => m.dist === 1);
    const hov = rRef.current?.hover;
    const tgt = id ? adj.find((m) => m.id === id)
      : (hov ? adj.find((m) => m.pos.x === hov.x && m.pos.y === hov.y) : undefined)
        ?? [...adj].sort((a, b) => Number(b.awareness === 'hunting') - Number(a.awareness === 'hunting') || (HP_ORDER[a.hp_state] ?? 9) - (HP_ORDER[b.hp_state] ?? 9) || (a.id < b.id ? -1 : 1))[0];
    if (!tgt) { flash(tr('隣に敵がいない（「戦う」は隣接した相手にだけ使える）。', 'No adjacent enemy (fight needs an adjacent target).')); return; }
    send({ type: 'fight', target: tgt.id });
  };

  const doExplore = (force?: MoveMode) => send({ type: 'explore', ...modeArg(force) });
  const doTravelDown = () => send({ type: 'travel', to: 'stairs_down', ...modeArg() });

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
  /**
   * 選んだ投擲物でその相手を狙えるか（観測の shots: 品目ごとの射線と射程）。
   * 射程の分からない品（未鑑定の薬など）は shots に無いので、射線だけで判断する
   */
  const shotState = (v: PlayerView, e: EntityView): ShotState => {
    const m = obsNow()?.visible.monsters.find((x) => x.id === e.id);
    const s = m?.shots.find((x) => x.slot === throwSlotRef.current);
    if (s) return s.state;
    return e.shot === false ? 'blocked' : 'clear';
  };
  /** 見えている敵（近い順） */
  const monstersByDist = (v: PlayerView) => v.entities.filter((e) => e.cat === 'monster' && v.self.pos)
    .sort((a, b) => distOf(v, a.pos) - distOf(v, b.pos) || (a.id < b.id ? -1 : 1));
  /** 投擲の狙いの候補: 選んだ品で狙える（射線が通り、射程内の）相手だけ、近い順 */
  const throwTargets = (v: PlayerView) => monstersByDist(v).filter((e) => shotState(v, e) === 'clear');
  /** 選んだ投擲物の射程（鑑定済みのときだけ分かる。接辞込みの性能から） */
  const throwRange = (v: PlayerView): number | null => {
    const it = v.inventory.find((x) => x.slot === throwSlotRef.current);
    const c = catalogRef.current;
    if (!it?.kind || !c) return null;
    return itemStats(c, it.kind, it.affixes)?.throw?.range ?? c.items[it.kind]?.throwRange ?? null;
  };

  /** 狙いを動かし、射線・距離・射程を表示する */
  const setCursor = (p: Pos | null) => {
    cursorRef.current = p;
    const v = viewRef.current, c = catalogRef.current;
    if (!v || !c || !p) { setAim(null); redraw(); return; }
    const ent = monsterAt(v, p);
    const d = distOf(v, p);
    const range = throwRange(v);
    const dist = tr(`距離 ${d}${range !== null ? ` / 射程 ${range}` : ''}`, `dist ${d}${range !== null ? ` / range ${range}` : ''}`);
    if (ent) {
      const name = monsterDisplayName(c, getLocale(), ent);
      const st = shotState(v, ent);
      setAim(st === 'blocked'
        ? { blocked: true, text: tr(`狙い: ${name} — 射線が通らない（${dist}）。Shift+Enter でそのマスへ投げる（途中で落ちる）`, `Aim: ${name} — no clear line (${dist}). Shift+Enter throws at the cell (drops short)`) }
        : st === 'out_of_range'
          ? { blocked: true, text: tr(`狙い: ${name} — 射程外（${dist}）。近づくか、Shift+Enter でそのマスへ投げる（手前に落ちる）`, `Aim: ${name} — out of range (${dist}). Get closer, or Shift+Enter throws at the cell (drops short)`) }
          : { blocked: false, text: tr(`狙い: ${name} — 投げられる（射線が通る・射程内、${dist}）`, `Aim: ${name} — clear and in range (${dist})`) });
    } else {
      const far = range !== null && d > range;
      setAim({ blocked: far, text: tr(`狙い: (${p.x},${p.y})（${dist}${far ? '・射程外: 手前に落ちる' : ''}）`, `Aim: (${p.x},${p.y}) (${dist}${far ? ', out of range: drops short' : ''})`) });
    }
    redraw();
  };

  const startThrow = (slot: string | null) => {
    const v = viewRef.current, c = catalogRef.current;
    if (!v) return;
    const s = slot ?? (selSlot && throwables(v).includes(selSlot) ? selSlot : throwables(v)[0] ?? null);
    if (!s) { addLog([{ seq: v.seq, text: tr('投げられる物を持っていない。', 'Nothing to throw.'), kind: 'error' }]); return; }
    throwSlotRef.current = s;
    const m = throwTargets(v)[0];
    const any = monstersByDist(v)[0];
    setMode('target');
    // 狙える相手がいなければ、いちばん近い敵に合わせて理由（射程外・射線）を見せる
    setCursor(m ? { ...m.pos } : any ? { ...any.pos } : v.self.pos ? { ...v.self.pos } : null);
    if (!m && any) {
      const it = v.inventory.find((x) => x.slot === s);
      const name = it && c ? itemDisplayName(c, getLocale(), it.kind, it.appearanceId, it.affixes) : s;
      flash(tr(`${name} で狙える相手がいない（射程外か、射線が通らない）。Shift+Enter で座標へ投げられる（手前に落ちる）。`,
        `No target you can hit with ${name} (out of range or blocked). Shift+Enter throws at the cell (drops short).`));
    }
  };

  /** force: 狙えない（射線が通らない・射程外の）相手のマスへ、座標を狙って投げる（遮られた位置・射程の端に落ちる） */
  const fireThrow = (at?: Pos, force = false) => {
    const v = viewRef.current, c = catalogRef.current;
    const slot = throwSlotRef.current;
    const p = at ?? cursorRef.current;
    if (!v || !slot || !p) return;
    const ent = monsterAt(v, p);
    const st = ent ? shotState(v, ent) : 'clear';
    if (ent && st !== 'clear' && !force) {
      const name = c ? monsterDisplayName(c, getLocale(), ent) : ent.id;
      const msg = st === 'out_of_range'
        ? tr(`${name} は射程外（距離 ${distOf(v, ent.pos)}${throwRange(v) !== null ? ` / 射程 ${throwRange(v)}` : ''}）。近づくか別の相手を選ぶ。Shift+Enter／Shift+クリックでそのマスへ投げる（手前に落ちる）。`,
          `${name} is out of range (dist ${distOf(v, ent.pos)}${throwRange(v) !== null ? ` / range ${throwRange(v)}` : ''}). Get closer or pick another target, or Shift+Enter / Shift+click to throw at the cell (it will drop short).`)
        : tr(`${name} への射線が通らない（壁や他の者に遮られる）。別の相手を選ぶか、Shift+Enter／Shift+クリックでそのマスへ投げる（途中で落ちる）。`,
          `No clear line to ${name} (blocked by a wall or someone). Pick another target, or Shift+Enter / Shift+click to throw at the cell (it will drop short).`);
      flash(msg);
      addLog([{ seq: v.seq, text: `⚠ ${msg}`, kind: 'error' }]);
      return;
    }
    setMode('normal');
    send({ type: 'throw', slot, target: ent && st === 'clear' ? ent.id : { x: p.x, y: p.y } });
  };

  /** 鑑定の対象の候補: 未鑑定の持ち物（同じ外見は 1 つにまとめる。巻物自身を除く） */
  const identifyOptions = (v: PlayerView, scrollSlot: string) => {
    const c = catalogRef.current;
    const seen = new Set<string>();
    const out: { slot: string; name: string }[] = [];
    for (const it of v.inventory) {
      if (it.slot === scrollSlot || it.kind !== null) continue;
      const key = it.appearanceId ?? it.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ slot: it.slot, name: (c ? itemDisplayName(c, getLocale(), it.kind, it.appearanceId, it.affixes) : it.slot) + (it.qty > 1 ? ` x${it.qty}` : '') });
    }
    return out;
  };

  /** use: 鑑定済みの鑑定の巻物なら対象を選ばせる（候補が 1 つならそれを、未鑑定の巻物ならそのまま使う） */
  const doUse = (slot: string) => {
    const v = viewRef.current;
    const it = v?.inventory.find((x) => x.slot === slot);
    if (v && it && isIdentifyScroll(it.kind)) {
      const opts = identifyOptions(v, slot);
      if (opts.length > 1) { setMode('pick'); setPick({ slot, options: opts }); return; }
      if (opts.length === 1) { send({ type: 'use', slot, targetSlot: opts[0].slot }); return; }
    }
    send({ type: 'use', slot });
  };

  const choosePick = (targetSlot: string) => {
    const p = pickRef.current;
    if (!p || !p.options.some((o) => o.slot === targetSlot)) return;
    setMode('normal');
    send({ type: 'use', slot: p.slot, targetSlot });
  };

  const invAction = (a: InvAction, slot: string) => {
    setSelSlot(slot);
    if (a === 'throw') { startThrow(slot); return; }
    if (a === 'use') doUse(slot);
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
          // 選んだ品で狙える（射線が通り射程内の）相手だけを巡回（Shift+Tab で逆順）。一人もいなければ見えている敵を巡回して理由を見せる
          const clear = throwTargets(v);
          const ms = clear.length ? clear : monstersByDist(v);
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
      } else if (md === 'pick') {
        if (/^[a-z]$/.test(e.key)) choosePick(e.key);
        else handled = false;
      } else if (dir) send({ type: 'move', dir });
      else if (e.key === '.' || e.key === '5' || e.key === 'Clear') send({ type: 'wait' });
      else if (e.key === 'x') doExplore();
      // Shift+X: 強行（steady）で探索。弱い射撃や毒を受けても止まらない
      else if (e.key === 'X') doExplore('steady');
      else if (e.key === 'F') doFight();
      else if (e.key === 'R') doRest();
      else if (e.key === 'E') doExtract();
      else if (e.key === 'g' || e.key === ',') send({ type: 'pickup' });
      // G: 見えている・記憶しているアイテムを拾い集める（collect what: items）
      else if (e.key === 'G') doCollectItems();
      else if (e.key === '>' || e.key === '<') send({ type: 'stairs' });
      else if (e.key === 'T') doTravelDown();
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
    if (modeRef.current === 'pick') return;
    if (p.x === v.self.pos.x && p.y === v.self.pos.y) return;
    if (!v.memory.terrain[p.y * v.floor.width + p.x]) return;
    // Shift+クリック: 退く（flee。隣に敵がいても動く）
    send(ev.shiftKey ? { type: 'travel', to: { x: p.x, y: p.y }, mode: 'flee' } : { type: 'travel', to: { x: p.x, y: p.y }, ...modeArg() });
  };

  // recent: 自分を攻撃している相手を投擲の候補で優先するため（できること一覧）
  const obs = useMemo(() => (view && catalog ? buildObservation(view, catalog, { detail: 'brief', map: false, recent: eventsRef.current.slice(-30) }) : null), [view, catalog]);
  if (obs && view) { obsRef.current = obs; obsViewRef.current = view; }
  const L = getLocale();
  const thrownKnown = knownThrown(obs);
  const pickables = view && catalog && view.status !== 'at_camp' ? pickableItems(view, catalog).length : 0;
  const adjAwake = adjacentAwake(obs);
  const adjacent = obs ? obs.visible.monsters.filter((m) => m.dist === 1) : [];
  const flee = adjAwake.length ? fleeActions(obs) : [];

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
    ? tr('投擲: 方向キー/Tab で狙い（Tab は射線が通り射程内の相手だけ）、Enter で投げる・Shift+Enter でそのマスへ（Esc 取消）',
      'Throw: aim with keys/Tab (Tab cycles targets in range with a clear line), Enter to throw, Shift+Enter at the cell (Esc cancels)')
    : mode === 'dir' ? tr('操作する方向を選ぶ（. で足元、Esc 取消）', 'Pick a direction (. for here, Esc cancels)')
      : mode === 'inv' ? tr('スロットの文字で既定の操作（i/Esc で戻る）', 'Press a slot letter (i/Esc to exit)')
        : mode === 'pick' ? tr('鑑定する品のスロットの文字を押す（Esc 取消）', 'Press the slot letter of the item to identify (Esc cancels)') : null;

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
                    {notice && (
                      <div class="notice">
                        ⚠ {notice.text}
                        {notice.actions && (
                          <div class="nacts">
                            {notice.actions.map((a, i) => (
                              <button key={i} class="tiny flee" title={a.title} onClick={() => { setNotice(null); send(a.command); }}>{a.label}</button>
                            ))}
                            <button class="tiny" onClick={() => setNotice(null)}>{tr('閉じる', 'Close')}</button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {mode === 'pick' && pick && (
                  <div class="pickbox">
                    <div class="head">{tr('どれを鑑定する？', 'Identify which item?')}</div>
                    <div class="row">
                      {pick.options.map((o) => <button key={o.slot} class="small" onClick={() => choosePick(o.slot)}>{o.slot}) {o.name}</button>)}
                    </div>
                    <div class="row end"><button class="small" onClick={() => setMode('normal')}>{tr('取消（Esc）', 'Cancel (Esc)')}</button></div>
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
            <span class="seg mmode" title={tr('探索・移動・回収のマクロの止まり方。慎重: 初見の種族・追跡してくる敵・攻撃を受けたら止まる。強行: 隣接・進路をふさがれる・HP が半分を下回る・初見の種族でだけ止まる（弱い射撃や毒は受けながら進む）',
              'How explore/travel/collect stop. Careful: on a new species, a hunting enemy, or being attacked. Steady: only when an enemy is adjacent or blocks the way, HP drops below half, or a new species appears')}>
              <span class="lbl">{tr('移動', 'Move')}</span>
              <button class={`tiny ${moveMode === 'careful' ? 'on' : ''}`} onClick={() => setMoveMode('careful')}>{tr('慎重', 'Careful')}</button>
              <button class={`tiny ${moveMode === 'steady' ? 'on' : ''}`} onClick={() => setMoveMode('steady')}>{tr('強行', 'Steady')}</button>
            </span>
            <button class="small" onClick={() => doExplore()} title={tr('x（Shift+X: 強行で探索）', 'x (Shift+X: explore steadily)')}>{tr('探索', 'Explore')} (x)</button>
            {adjacent.length > 0 && (
              <button class="small fight" onClick={() => doFight()} title={tr('隣の敵を、倒れる・離れる・HP が半分を下回るまで殴り続ける（F）', 'Keep attacking the adjacent enemy until it falls, moves away, or your HP drops below half (F)')}>
                {tr('戦う', 'Fight')} (F)
              </button>
            )}
            {flee.map((a, i) => (
              <button key={`flee-${i}`} class="small flee" title={a.title} onClick={() => send(a.command)}>{a.label}</button>
            ))}
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
            {pickables > 0 && (
              <button class="small" onClick={doCollectItems} title={tr('見えている・覚えているアイテムを近い順に回って拾う（遺物と、鑑定済みの有害品は拾わない）（G）', 'Walk to and pick up items you see or remember, nearest first (skips relics and known harmful items) (G)')}>
                {tr(`拾い集める ${pickables}`, `Collect items ${pickables}`)} (G)
              </button>
            )}
            <button class="small" onClick={doTravelDown} title="T">{tr('下り階段へ', 'To stairs')} (T)</button>
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
          {obs && !atCamp && <MonstersPanel monsters={obs.visible.monsters} hp={obs.self.hp} onFight={doFight} />}
          {view && catalog && <InventoryPanel view={view} catalog={catalog} onAction={invAction} focused={mode === 'inv'} selected={selSlot} onSelect={setSelSlot} />}
          <MessageLog lines={log} />
          <form class="chat" onSubmit={(e) => { e.preventDefault(); if (chat.trim()) { send({ type: 'say', text: chat.trim().slice(0, 280) }); setChat(''); } }}>
            <input value={chat} placeholder={tr('チャット（COOP）', 'Chat (COOP)')} onInput={(e) => setChat((e.target as HTMLInputElement).value)} />
          </form>
          {view && catalog && view.inventory.length > 0 && selSlot && (
            <div class="muted small">{tr('選択中', 'Selected')}: {(() => { const it = view.inventory.find((x) => x.slot === selSlot); return it ? itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes) : '-'; })()}</div>
          )}
          <div class="help muted">
            {tr('移動: 矢印/テンキー/hjklyubn　待機: .　探索: x（強行: X）　戦う: F（隣の敵）　休憩: R　拾う: g　拾い集める: G　回収: C　階段: >　帰還/撤退: E（階段の上）　投擲: t　操作: o　所持品: i　クリック: その場所へ移動（Shift+クリック: 退く）',
              'Move: arrows/numpad/hjklyubn  Wait: .  Explore: x (steady: X)  Fight: F (adjacent)  Rest: R  Pick up: g  Collect items: G  Collect thrown: C  Stairs: >  Extract: E (on stairs)  Throw: t  Interact: o  Inventory: i  Click: travel (Shift+click: flee)')}
          </div>
        </aside>
      </div>
      {summary && <SummaryDialog summary={summary} catalog={catalog} onClose={() => setSummary(null)} />}
    </div>
  );
}

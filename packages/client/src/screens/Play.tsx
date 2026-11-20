// プレイ画面（人間）。AI と同じ Command を同じ PlayerPort（WS 経由）へ送る。
// 受け取るのはサーバーの PlayerView フレーム＋知覚イベントだけ（生のイベント列は受け取らない）。
import type {
  ActionError, ActionErrorCode, Catalog, Change, Command, Dir, EntityView, ObsMonster, Observation, PerceivedEvent, PlayerView, Pos, RunSummary, ServerMsg, TurnSnapshot,
} from '@muse/shared';
import {
  buildNavGrid, buildObservation, buildTurnBlock, curseUnknown, diffChanges, dirLabel, findPath, isCursedItem, itemDisplayName, itemStats, monsterDisplayName, pickableItems, sameOrWorseEquip, turnLine,
  turnSnapshot,
} from '@muse/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { connectWs, type WsHandle, type WsStatus } from '../net/ws';
import type { Canvas2DRenderer } from '../render/canvas2d';
import { toViewEvents } from '../render/events';
import { sceneFromView } from '../render/scene';
import { soundDirector } from '../sound/director';
import {
  AlertsBar, carriedCount, InventoryPanel, isApproaching, isBoundItem, MessageLog, MonstersPanel, ObsPartyPanel, StatusPanel, SummaryDialog, type InvAction, type LogLine,
} from '../ui/panels';
import { ErrorBanner, Header, MapView, ThemePicker, useCatalog, useLocaleRefresh, useTheme } from '../ui/common';
import { SoundControls } from '../ui/sound';
import { CampScene } from '../ui/camp';
import { BriefingCard, CampPanel, completesOnExtract, ExpeditionPanel, extractConfirmText, lifelineConfirmText, RestEstimateLine, rulesOf, TurnBar } from '../ui/expedition';
import { abilityDisplayName, AbilityBar, BoonChoicePanel, DirPad, PerkChoicePanel } from '../ui/build';
import {
  abilityModeHint, abilityNoTargetText, abilityNotReadyText, abilityPickHint, abilityReady, cursedRemoveText, DIR_ARROW, extractBlockLabel, lifelineEffectText, perkModeHint, reachAttackLabel,
  reachAttackTitle, viewStatusLabel,
} from '../ui/labels';
import { perceivedLines } from '../ui/narration';
import { getLocale, getPref, getToken, setPref, tr } from '../util';

const MOVE_KEYS: Record<string, Dir> = {
  ArrowUp: 'n', ArrowDown: 's', ArrowLeft: 'w', ArrowRight: 'e',
  k: 'n', j: 's', h: 'w', l: 'e', y: 'nw', u: 'ne', b: 'sw', n: 'se',
  8: 'n', 2: 's', 4: 'w', 6: 'e', 7: 'nw', 9: 'ne', 1: 'sw', 3: 'se',
  Home: 'nw', PageUp: 'ne', End: 'sw', PageDown: 'se',
};
const DIR_D: Record<Dir, [number, number]> = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] };

/**
 * pick: 鑑定の巻物の対象を選ぶ。perk: 特技の候補を番号で選ぶ。ability: 能動技を番号で選ぶ。
 * abtarget: 能動技の対象（隣の敵・狙い撃ちの相手・方向）を選ぶ（V3-4）
 */
type Mode = 'normal' | 'target' | 'dir' | 'inv' | 'pick' | 'perk' | 'ability' | 'abtarget';

/** 能動技の対象の候補（隣の敵・狙い撃ちの相手）。slot: 狙い撃ちで投げる品 */
interface AbOption { id: string; label: string; pos: Pos; dir: Dir | null; slot?: string }
/** 能動技の対象を選んでいる間（abtarget モード）。sel: Tab・Enter で使う、いま指している候補 */
interface AbPick { id: string; name: string; target: 'adjacent' | 'throw' | 'dir'; options: AbOption[]; sel: number }

/** 移動マクロ（explore / travel / collect）の慎重さ。flee は退くときの専用ボタンで使う */
type MoveMode = 'careful' | 'steady';
/** 戦う（fight の近接）で、追跡中で届かない相手を待つか寄っていくか（V4-1a §12.5。AI の approach と同じ命令） */
type FightApproach = 'wait' | 'advance';

/** 手番を消費しないコマンド（いつでも送れる。特技の選択はキャンプでも・手番でなくても） */
const FREE: ReadonlySet<Command['type']> = new Set<Command['type']>(['say', 'note', 'retire', 'choose_perk', 'choose_boon']);

/** 地図の上の注意に出さないエラー（手番のずれ等の雑音、確認ダイアログやバナーで扱うもの） */
const QUIET_ERRORS: ReadonlySet<ActionErrorCode> = new Set<ActionErrorCode>(['not_your_turn', 'stale_turn', 'confirm_required', 'no_session', 'bad_request', 'dead', 'run_ended']);

interface SnapAt { snap: TurnSnapshot; seq: number }

/** command を送るか、run を呼ぶ（確認を挟む操作: 帰還の綱など） */
interface NoticeAction { label: string; title?: string; command?: Command; run?: () => void }
interface Notice { text: string; actions?: NoticeAction[] }

/** 「数手待つ」の手数（wait turns。何か変化があればサーバーが止める。V3-2R2 §18.5） */
const WAIT_TURNS = 5;

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

/** 帰還の綱のスロット（手放せない・使える品。遠征の開始時にキャンプが 1 本持たせる。V3-2R2 §18.1） */
function lifelineSlot(v: PlayerView | null, c: Catalog | null): string | null {
  if (!v || !c) return null;
  return v.inventory.find((it) => isBoundItem(c, it.kind) && !!it.kind && c.items[it.kind]?.usable)?.slot ?? null;
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

/** 長柄で 2 マス先から突ける相手（観測の valid_actions の attack。V3-4 §4.4） */
function reachTargets(obs: Observation | null): ObsMonster[] {
  if (!obs) return [];
  const ids = new Set(obs.valid_actions.map((l) => /^attack (\S+)/.exec(l)?.[1]).filter((x): x is string => !!x));
  return ids.size ? obs.visible.monsters.filter((m) => ids.has(m.id)) : [];
}

/** 特技の候補を見分ける鍵（同じ候補を二度選ばない・畳んだ候補を覚える） */
function perkKey(pc: Observation['self']['perk_choice']): string {
  return pc ? `${pc.level}:${pc.options.map((o) => o.id).join(',')}:${pc.more}` : '';
}

/** 身をかわす向きの目安: 1 歩でどの隣の起きている敵からも離れる、通れる向き（観測の valid_actions と同じ考え方） */
function slipAway(obs: Observation | null): Dir[] {
  const me = obs?.self.pos;
  const near = adjacentAwake(obs);
  if (!obs || !me || !near.length) return [];
  return obs.navigation.passable_dirs.filter((d) => {
    const p = { x: me.x + DIR_D[d][0], y: me.y + DIR_D[d][1] };
    return near.every((m) => Math.max(Math.abs(m.pos.x - p.x), Math.abs(m.pos.y - p.y)) > 1);
  });
}

/** 自分から見たそのマスの向き（縦・横・斜めの直線で 2 マス以内のときだけ。身をかわすの向きをクリックで選ぶ） */
function dirToward(from: Pos, to: Pos): Dir | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  if ((dx === 0 && dy === 0) || Math.max(Math.abs(dx), Math.abs(dy)) > 2) return null;
  if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) return null;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  return (Object.keys(DIR_D) as Dir[]).find((d) => DIR_D[d][0] === sx && DIR_D[d][1] === sy) ?? null;
}

export function Play({ runId }: { runId: string }) {
  useLocaleRefresh();
  const { catalog, error: catErr } = useCatalog();
  const th = useTheme(catalog);
  const token = getToken(runId);
  const [view, setView] = useState<PlayerView | null>(null);
  // 目標（V3-7a。World の外。view と一緒に届く）
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
  const [fightApproach, setFightApproachState] = useState<FightApproach>(getPref('fightApproach', 'wait') === 'advance' ? 'advance' : 'wait');
  /** 鑑定の巻物の対象の候補（pick モードの間だけ） */
  const [pick, setPickState] = useState<{ slot: string; options: { slot: string; name: string }[] } | null>(null);
  /** 能動技の対象の候補（abtarget モードの間だけ） */
  const [abPick, setAbPickState] = useState<AbPick | null>(null);
  /** 選んで返事を待っている特技の候補（同じ候補を二度選ばない）と、「あとで」で畳んだ候補（perkKey） */
  const [perkSent, setPerkSentState] = useState<string | null>(null);
  const [perkHidden, setPerkHidden] = useState<string | null>(null);

  const viewRef = useRef<PlayerView | null>(null);
  const catalogRef = useRef(catalog);
  const rRef = useRef<Canvas2DRenderer | null>(null);
  const wsRef = useRef<WsHandle | null>(null);
  const pendingRef = useRef(false);
  /** 最後に送ったコマンド（確認が要ると拒否されたとき、何の確認かを分ける） */
  const lastSentRef = useRef<Command | null>(null);
  const macroRef = useRef(false);
  const modeRef = useRef<Mode>('normal');
  const cursorRef = useRef<Pos | null>(null);
  const pathRef = useRef<Pos[] | null>(null);
  const throwSlotRef = useRef<string | null>(null);
  const moveModeRef = useRef<MoveMode>(moveMode);
  const fightApproachRef = useRef<FightApproach>(fightApproach);
  const pickRef = useRef<typeof pick>(null);
  const abPickRef = useRef<AbPick | null>(null);
  const perkSentRef = useRef<string | null>(null);
  const perkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  /** target: 狙いのマスにいる敵（「投擲で決着」の対象） */
  const [aim, setAim] = useState<{ text: string; blocked: boolean; target?: string } | null>(null);
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
  const setFightApproach = (a: FightApproach) => {
    fightApproachRef.current = a;
    setPref('fightApproach', a);
    setFightApproachState(a);
  };
  /** 移動マクロに付ける mode（careful は既定なので省く）。steady を渡すとその場だけ強行 */
  const modeArg = (force?: MoveMode): { mode?: 'steady' } => ((force ?? moveModeRef.current) === 'steady' ? { mode: 'steady' } : {});

  const setPick = (p: typeof pick) => { pickRef.current = p; setPickState(p); };
  const setAbPick = (p: AbPick | null) => { abPickRef.current = p; setAbPickState(p); };
  /** 返事が来ないまま（拒否の通知も無く）止まらないよう、数秒で選び直せるようにする */
  const setPerkSent = (k: string | null) => {
    perkSentRef.current = k;
    setPerkSentState(k);
    if (perkTimer.current) clearTimeout(perkTimer.current);
    if (k) perkTimer.current = setTimeout(() => { perkSentRef.current = null; setPerkSentState(null); }, 4000);
  };

  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
    if (m !== 'target') { cursorRef.current = null; setAim(null); }
    if (m !== 'pick' && pickRef.current) setPick(null);
    if (m !== 'abtarget' && abPickRef.current) setAbPick(null);
    redraw();
  };

  const redraw = (evs?: PerceivedEvent[]) => {
    const v = viewRef.current, c = catalogRef.current, r = rRef.current;
    if (!v || !c || !r) return;
    // ツールチップは、この view の観測が作り済みならその値で（速さ・特徴・初見・命中の記録）。ここでは作らない
    const monsters = obsRef.current && obsViewRef.current === v ? obsRef.current.visible.monsters : undefined;
    const scene = sceneFromView(v, c, { cursor: cursorRef.current, path: modeRef.current === 'normal' ? pathRef.current : null, monsters });
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
          // 音の状態と合図（演出だけ。届いた視界と出来事から。マクロは 1 歩ごとに届くので、画面の位置に合わせて追う）
          soundDirector.update(m.view, m.events.map((e) => e.event), catalogRef.current);
          break;
        case 'macro':
          macroRef.current = m.state === 'running';
          setMacro({ kind: m.kind, state: m.state, steps: m.steps, reason: m.reason });
          break;
        case 'error':
          pendingRef.current = false;
          // 特技の選択が拒否されたら選び直せるようにする
          if (perkSentRef.current) setPerkSent(null);
          addLog([{ seq: viewRef.current?.seq ?? 0, text: `⚠ ${errorLine(m.error)}`, kind: 'error' }]);
          // 手番を使わずに拒否されたもの（射線が通らない・射程外の相手を ID で狙った、マクロが 1 歩も進めない等）は地図の上にもはっきり出す。
          // 隣に起きている敵がいて移動マクロが拒否されたら、退く（flee）を選べるようにする
          // 階段から遠ければ、帰還の綱も選べるようにする（確認を挟む）
          if (m.error.code === 'hostile_adjacent') flash(errorLine(m.error), [...fleeActions(obsNow()), ...lifelineActions()]);
          else if (!QUIET_ERRORS.has(m.error.code)) flash(errorLine(m.error));
          // 表示上は達成に見えても、サーバーが撤退扱いと判断した場合（最終判定はサーバー）
          // 呪いと分かっている品の装備（V3-8 §53.4）は、拒否の文をそのまま確かめる
          if (m.error.code === 'confirm_required' && lastSentRef.current?.type === 'equip') {
            const last = lastSentRef.current;
            if (window.confirm(`${m.error.message}
${tr('それでも装備しますか？', 'Equip it anyway?')}`)) send({ ...last, confirm: true });
          } else if (m.error.code === 'confirm_required' && window.confirm(extractConfirmText(obsNow()?.expedition, false, rulesOf(catalogRef.current)))) {
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
    return () => { ws.close(); soundDirector.leave(); };
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
    lastSentRef.current = command;
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
      // 手放せない品（帰還の綱）は所持数に数えない
      const full = carriedCount(v, c) >= v.self.capacity;
      flash(full ? tr('所持品がいっぱいで拾えない。', 'Your inventory is full.') : tr('拾いに行けるアイテムを知らない。', 'You know of no items to pick up.'));
      return;
    }
    send({ type: 'collect', what: 'items', ...modeArg() });
  };

  /**
   * fight: その相手と決着を付ける（V3-2R2 §18.5）。隣なら近接攻撃を繰り返し、追跡中で届かない相手は隣に来るまで待つ（迎え撃つ。最大 10 手番）。
   * withSlot: その品を倒れるまで投げ続ける（射程と射線が通るまで待つ）。止まる条件はサーバーが判定する。
   * id を省くと、隣の敵（地図で指している → 追跡中 → 弱っている順）、いなければ追ってくる敵（指している → 近い順）を選ぶ
   */
  /** fight に載せる能動技（覚えているもの。強打・なぎ払い、投擲なら狙い撃ち。使える手番ごとに fight が使う。V3-4a §25.3） */
  const fightAbilities = (v: PlayerView, withSlot?: string): { abilities?: string[] } => {
    const c = catalogRef.current;
    if (!c) return {};
    const want = withSlot ? ['aimed_throw'] : ['strike', 'cleave'];
    const ids = v.self.build.abilities.map((a) => a.id).filter((id) => want.includes(c.abilities[id]?.handler ?? ''));
    return ids.length ? { abilities: ids } : {};
  };

  const doFight = (id?: string, withSlot?: string) => {
    const v = viewRef.current;
    const o = obsNow();
    if (!v || !o) return;
    const w = { ...(withSlot ? { with: withSlot } : {}), ...fightAbilities(v, withSlot), ...(!withSlot && fightApproachRef.current === 'advance' ? { approach: 'advance' as const } : {}) };
    if (id) {
      if (!o.visible.monsters.some((m) => m.id === id)) { flash(tr('その敵は見えていない。', 'That enemy is not in view.')); return; }
      send({ type: 'fight', target: id, ...w });
      return;
    }
    const adj = o.visible.monsters.filter((m) => m.dist === 1);
    const hov = rRef.current?.hover;
    const at = (ms: ObsMonster[]) => (hov ? ms.find((m) => m.pos.x === hov.x && m.pos.y === hov.y) : undefined);
    // 寄るなら、動かない追跡中の敵（その場から撃つ・届かない所にいる）も相手にする（V4-1a §12.5）
    const comers = o.visible.monsters.filter((m) => m.dist > 1 && (isApproaching(m) || (fightApproachRef.current === 'advance' && m.awareness === 'hunting' && !m.fleeing)));
    const tgt = at(adj)
      ?? [...adj].sort((a, b) => Number(b.awareness === 'hunting') - Number(a.awareness === 'hunting') || (HP_ORDER[a.hp_state] ?? 9) - (HP_ORDER[b.hp_state] ?? 9) || (a.id < b.id ? -1 : 1))[0]
      ?? at(comers) ?? comers[0];
    if (!tgt) {
      flash(tr('隣に敵がおらず、追ってくる敵もいない（眠っている・気付いていない相手には近づくか、投げる）。', 'No adjacent enemy and none hunting you (approach or throw at sleeping or unaware ones).'));
      return;
    }
    send({ type: 'fight', target: tgt.id, ...w });
  };

  /**
   * 「投擲で決着」に使う品（その相手について）: 選択中の投擲物 → 狙える品 → （追ってくる相手なら）射程外・射線待ちの品。
   * 追ってこない相手は、今狙えるときだけ（射程に入るのを待てないので）
   */
  const throwSlotFor = (m: ObsMonster): string | null => {
    if (!m.shots.length) return null;
    const sel = selSlot ? m.shots.find((s) => s.slot === selSlot) : undefined;
    const pick = sel ?? m.shots.find((s) => s.state === 'clear') ?? m.shots[0];
    if (pick.state !== 'clear' && !isApproaching(m)) return null;
    return pick.slot;
  };

  /** 帰還の綱を使う: 戻り方（即時か、動けない手番の数）と確定する点を確認してから use（V3-2R2 §18.1・V3-2R3 §20.3） */
  const doLifeline = () => {
    const v = viewRef.current, c = catalogRef.current;
    if (!v || !c) return;
    const slot = lifelineSlot(v, c);
    const x = v.expedition;
    if (!x || x.status === 'ended' || v.status === 'at_camp') { flash(tr('進行中の遠征が無い。', 'No expedition in progress.')); return; }
    if (!slot) { flash(tr('帰還の綱を持っていない（遠征の開始時にキャンプが 1 本持たせる）。', 'You have no lifeline (camp gives one at the start of each expedition).')); return; }
    const it = v.inventory.find((i) => i.slot === slot);
    const name = it ? itemDisplayName(c, getLocale(), it.kind, it.appearanceId, it.affixes) : tr('帰還の綱', 'lifeline');
    if (!window.confirm(lifelineConfirmText(obsNow(), rulesOf(c), name))) return;
    send({ type: 'use', slot });
  };

  /** 注意（地図の上）に添える「帰還の綱」のボタン（綱を持っていて遠征中のときだけ） */
  const lifelineActions = (): NoticeAction[] => {
    const v = viewRef.current;
    const ox = obsNow()?.expedition;
    const pts = ox?.haul?.if_lifeline_now;
    // 階段の上なら extract の方が得か同じ（手番もかからない）
    if (!lifelineSlot(v, catalogRef.current) || pts === undefined || ox?.can_extract) return [];
    const how = lifelineEffectText(catalogRef.current?.rules?.lifeline?.turns);
    return [{
      label: tr(`帰還の綱（L）+${pts}`, `Lifeline (L) +${pts}`),
      title: tr(`${how}。確認が出る`, `${how}. Asks to confirm`),
      run: doLifeline,
    }];
  };

  /** 数手待つ: 何か変化（敵が見えた・隣に来た・被害）があればサーバーが止める */
  const doWaitTurns = () => send({ type: 'wait', turns: WAIT_TURNS });

  const doExplore = (force?: MoveMode) => send({ type: 'explore', ...modeArg(force) });
  /**
   * 風の方へ探索（explore toward: 'draft'。V3-2R3 §20.5）: 下への風の方角にある未探索を優先する。
   * 風は今いる階の下り階段が未発見の間だけ吹く（観測の self.floor.draft）。無ければ送らずに理由を出す
   */
  const doExploreDraft = () => {
    const o = obsNow();
    if (!o?.self.floor?.draft) {
      flash(tr('この階では下への風を感じない（下り階段を見つけた後は吹かない）。探索は x。', 'No draft on this floor (it stops once you have found the down stairs). Use x to explore.'));
      return;
    }
    send({ type: 'explore', toward: 'draft', ...modeArg() });
  };
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
    // 手放せない品（帰還の綱）は投げられない
    return !it.equipped && !ci?.bound && (ci?.throwable || cat === 'throwing' || cat === 'potion');
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
        ? { blocked: true, target: ent.id, text: tr(`狙い: ${name} — 射線が通らない（${dist}）。Shift+Enter でそのマスへ投げる（途中で落ちる）。追ってくる相手なら F で射線が通るまで待って投げる`, `Aim: ${name} — no clear line (${dist}). Shift+Enter throws at the cell (drops short). If it is hunting you, F waits for a clear line`) }
        : st === 'out_of_range'
          ? { blocked: true, target: ent.id, text: tr(`狙い: ${name} — 射程外（${dist}）。近づくか、Shift+Enter でそのマスへ投げる（手前に落ちる）。追ってくる相手なら F で射程に入るまで待って投げる`, `Aim: ${name} — out of range (${dist}). Get closer, or Shift+Enter throws at the cell (drops short). If it is hunting you, F waits until it is in range`) }
          : { blocked: false, target: ent.id, text: tr(`狙い: ${name} — 投げられる（射線が通る・射程内、${dist}）`, `Aim: ${name} — clear and in range (${dist})`) });
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

  /**
   * 投擲で決着（fight with）: 狙っている敵に、選んだ品を倒れるまで投げ続ける。射程外・射線が通らなくても、
   * 追ってくる相手なら射程と射線が通るまで待つ（待てるかどうか・止まる条件はサーバーが判定する）
   */
  const fireFight = () => {
    const v = viewRef.current;
    const slot = throwSlotRef.current;
    const p = cursorRef.current;
    if (!v || !slot || !p) return;
    const ent = monsterAt(v, p);
    if (!ent) { flash(tr('「投擲で決着」は敵を狙ったときだけ使える（Tab で敵に合わせる）。', 'Throw-it-down needs an enemy under the aim (Tab cycles enemies).')); return; }
    setMode('normal');
    send({ type: 'fight', target: ent.id, with: slot, ...fightAbilities(v, slot) });
  };

  /**
   * 鑑定の対象の候補: 未鑑定の持ち物（同じ外見は 1 つにまとめる。巻物自身を除く）と、
   * 呪いの有無をまだ確かめていない装備品（鑑定すると分かる。V3-4）
   */
  const identifyOptions = (v: PlayerView, scrollSlot: string) => {
    const c = catalogRef.current;
    const seen = new Set<string>();
    const out: { slot: string; name: string }[] = [];
    for (const it of v.inventory) {
      if (it.slot === scrollSlot) continue;
      const curseQ = !!c && curseUnknown(c, it);
      if (it.kind !== null && !curseQ) continue;
      // 呪いは品ごとなので、正体が分かっている品はまとめない
      const key = it.kind === null ? it.appearanceId ?? it.id : it.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        slot: it.slot,
        name: (c ? itemDisplayName(c, getLocale(), it.kind, it.appearanceId, it.affixes) : it.slot) + (it.qty > 1 ? ` x${it.qty}` : '') + (it.kind !== null && curseQ ? tr('（呪い?）', ' (curse?)') : ''),
      });
    }
    return out;
  };

  /** use: 帰還の綱なら確認してから。鑑定済みの鑑定の巻物なら対象を選ばせる（候補が 1 つならそれを、未鑑定の巻物ならそのまま使う） */
  const doUse = (slot: string) => {
    const v = viewRef.current;
    const it = v?.inventory.find((x) => x.slot === slot);
    if (it && slot === lifelineSlot(v, catalogRef.current)) { doLifeline(); return; }
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

  // ---- ビルド（V3-4）: 特技の選択・能動技・長柄 ----

  /** 特技を選ぶ（choose_perk。手番を使わない。キャンプでも・手番でなくても送れる） */
  const choosePerk = (option: number) => {
    const pc = obsNow()?.self.perk_choice;
    if (!pc || !pc.options.some((o) => o.option === option)) return;
    const key = perkKey(pc);
    // 返事（新しい view）が来るまで同じ候補は選ばない（連打で次の候補まで選ばないように）
    if (perkSentRef.current === key) return;
    setPerkSent(key);
    // 後に控えている候補が無ければ番号の受付を終える（あれば次の候補が届いたらそのまま選べる）
    if (modeRef.current === 'perk' && pc.more <= 0) setMode('normal');
    send({ type: 'choose_perk', option });
  };

  /** p: 特技の候補に番号の受付を向ける（もう一度 p で戻る） */
  const togglePerk = () => {
    if (modeRef.current === 'perk') { setMode('normal'); return; }
    if (!obsNow()?.self.perk_choice) {
      flash(tr('選べる特技の候補は無い（レベルが上がると出る）。', 'No perk to choose (you get one at each level up).'));
      return;
    }
    setPerkHidden(null);
    setMode('perk');
  };

  /** 隣の敵（地図で指している → 追跡中 → 弱っている順）。強打などの対象 */
  const adjacentOptions = (o: Observation): AbOption[] => {
    const hov = rRef.current?.hover;
    const at = (m: ObsMonster) => Number(!!hov && m.pos.x === hov.x && m.pos.y === hov.y);
    return o.visible.monsters.filter((m) => m.dist <= 1)
      .sort((a, b) => at(b) - at(a) || Number(b.awareness === 'hunting') - Number(a.awareness === 'hunting') || (HP_ORDER[a.hp_state] ?? 9) - (HP_ORDER[b.hp_state] ?? 9) || (a.id < b.id ? -1 : 1))
      .map((m) => ({ id: m.id, label: `${m.dir ? DIR_ARROW[m.dir] : ''} ${m.name}`.trim(), pos: m.pos, dir: m.dir }));
  };

  /**
   * 狙い撃ちの候補: 投擲用の品で射線が通り射程内の相手（近い順）。投げる品は選択中の投擲物 → 最初に狙える品。
   * 薬は投げない（割れて無くなる）
   */
  const aimedOptions = (v: PlayerView, o: Observation): AbOption[] => {
    const c = catalogRef.current;
    const L = getLocale();
    const isThrowing = (slot: string) => {
      const it = v.inventory.find((x) => x.slot === slot);
      if (!it || it.equipped) return false;
      const cat = it.kind ? c?.items[it.kind]?.category : it.appearanceId ? c?.appearances[it.appearanceId]?.category : undefined;
      return cat === 'throwing';
    };
    const out: AbOption[] = [];
    for (const m of [...o.visible.monsters].sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1))) {
      const clear = m.shots.filter((s) => s.state === 'clear' && isThrowing(s.slot));
      if (!clear.length) continue;
      const s = clear.find((x) => x.slot === selSlot) ?? clear[0];
      const it = v.inventory.find((x) => x.slot === s.slot);
      const iname = it && c ? itemDisplayName(c, L, it.kind, it.appearanceId, it.affixes) : s.slot;
      const unaware = m.awareness !== 'hunting' ? tr('・気づいていない: 会心', ', unaware: critical') : '';
      out.push({
        id: m.id, pos: m.pos, dir: m.dir, slot: s.slot,
        label: tr(`${m.name}（距離 ${m.dist}${unaware}）← ${s.slot}) ${iname}`, `${m.name} (dist ${m.dist}${unaware}) <- ${s.slot}) ${iname}`),
      });
    }
    return out;
  };

  const openAbPick = (p: AbPick) => {
    setMode('abtarget');
    setAbPick(p);
    const o = p.options[p.sel];
    cursorRef.current = o ? { ...o.pos } : null;
    redraw();
  };

  /** 候補を指す（Tab・ボタンに乗せたとき）。地図の狙いもそこへ動かす */
  const selectAb = (i: number) => {
    const p = abPickRef.current;
    if (!p || !p.options.length) return;
    const sel = ((i % p.options.length) + p.options.length) % p.options.length;
    setAbPick({ ...p, sel });
    cursorRef.current = { ...p.options[sel].pos };
    redraw();
  };

  const chooseAbTarget = (targetId: string) => {
    const p = abPickRef.current;
    const opt = p?.options.find((x) => x.id === targetId);
    if (!p || !opt) return;
    setMode('normal');
    send({ type: 'ability', id: p.id, target: opt.id, ...(opt.slot ? { slot: opt.slot } : {}) });
  };

  const chooseAbDir = (d: Dir) => {
    const p = abPickRef.current;
    if (!p || p.target !== 'dir') return;
    setMode('normal');
    send({ type: 'ability', id: p.id, target: d });
  };

  /**
   * 能動技を使う（V3-4 §4.2）。対象なしはそのまま。隣の敵は 1 体ならそのまま、複数なら選ばせる。
   * 狙い撃ちは狙える相手を選ばせる（投げる品も見せる）。身をかわすは方向を選ばせる。使えるか・届くかの最終判定はサーバー
   */
  const doAbility = (id: string) => {
    const v = viewRef.current, o = obsNow();
    if (!v || !o) return;
    const a = o.self.abilities.find((x) => x.id === id);
    if (!a) return;
    const name = abilityDisplayName(catalogRef.current, a);
    if (v.status === 'at_camp') { setMode('normal'); flash(tr('キャンプでは能動技を使えない。', 'Abilities cannot be used at camp.')); return; }
    if (!abilityReady(a)) { setMode('normal'); flash(abilityNotReadyText(name, a)); return; }
    if (a.target === 'none') { setMode('normal'); send({ type: 'ability', id }); return; }
    if (a.target === 'dir') { openAbPick({ id, name, target: 'dir', options: [], sel: 0 }); return; }
    const options = a.target === 'adjacent' ? adjacentOptions(o) : aimedOptions(v, o);
    if (!options.length) { setMode('normal'); flash(abilityNoTargetText(name, a.target)); return; }
    if (a.target === 'adjacent' && options.length === 1) { setMode('normal'); send({ type: 'ability', id, target: options[0].id }); return; }
    openAbPick({ id, name, target: a.target, options, sel: 0 });
  };

  /** a: 能動技が 1 つならそのまま使う。2 つ以上なら番号の受付を向ける（もう一度 a で戻る） */
  const openAbilities = () => {
    if (modeRef.current === 'ability') { setMode('normal'); return; }
    const o = obsNow();
    const abs = o?.self.abilities ?? [];
    if (!abs.length) { flash(tr('能動技を覚えていない（能動技を覚える特技を取ると使える）。', 'You know no abilities (some perks teach one).')); return; }
    if (viewRef.current?.status === 'at_camp') { flash(tr('キャンプでは能動技を使えない。', 'Abilities cannot be used at camp.')); return; }
    if (abs.length === 1) { doAbility(abs[0].id); return; }
    setMode('ability');
  };

  /** 長柄で 2 マス先の敵を突く（attack）。id を省くと地図で指している相手 → 最初の相手 */
  const doReach = (id?: string) => {
    const ts = reachTargets(obsNow());
    const hov = rRef.current?.hover;
    const t = id ? ts.find((m) => m.id === id) : (hov ? ts.find((m) => m.pos.x === hov.x && m.pos.y === hov.y) : undefined) ?? ts[0];
    if (!t) {
      flash(tr('2 マス先から突ける敵がいない（長柄の武器で、縦・横・斜めの直線上、間のマスが空いている相手）。', 'No enemy to strike from 2 cells (needs a reach weapon, a straight line, and an open cell between).'));
      return;
    }
    send({ type: 'attack', target: t.id });
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
    // 呪われた装備は外せない（V3-4）
    if (it.equipped && catalogRef.current && isCursedItem(catalogRef.current, it.affixes)) flash(cursedRemoveText());
    else if (it.equipped) invAction('unequip', slot);
    // 装備中の品と同じ種類で性能が同じか下なら、装備しても良くならない（V3-2R3 §20.6）
    else if (ci?.slot && catalogRef.current && sameOrWorseEquip(v, catalogRef.current, it)) flash(tr('装備中の品と同じ種類で、性能が同じか下。装備しても良くならない。', 'Same kind as your equipped item with the same or worse stats; equipping it gains nothing.'));
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
        // F（Shift+f）: 投擲で決着（倒れるまで投げ続ける。追ってくる相手は射程に入るまで待つ）
        else if (e.key === 'F') fireFight();
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
      } else if (md === 'perk') {
        // 番号で特技を選ぶ（テンキーの数字も移動ではなく番号として扱う）
        if (/^[1-9]$/.test(e.key)) choosePerk(Number(e.key));
        else if (e.key === 'p') setMode('normal');
        else handled = false;
      } else if (md === 'ability') {
        if (/^[1-9]$/.test(e.key)) {
          const a = obsNow()?.self.abilities[Number(e.key) - 1];
          if (a) doAbility(a.id);
        } else if (e.key === 'a') setMode('normal');
        else handled = false;
      } else if (md === 'abtarget') {
        const p = abPickRef.current;
        if (!p) setMode('normal');
        else if (p.target === 'dir') {
          if (dir) chooseAbDir(dir);
          else handled = false;
        } else if (e.key === 'Tab') selectAb(p.sel + (e.shiftKey ? -1 : 1));
        else if (e.key === 'Enter') { const o = p.options[p.sel]; if (o) chooseAbTarget(o.id); }
        else if (dir) {
          // 方向キー: その向きの隣の敵
          const me = v.self.pos;
          const o = me ? p.options.find((x) => x.pos.x === me.x + DIR_D[dir][0] && x.pos.y === me.y + DIR_D[dir][1]) : undefined;
          if (o) chooseAbTarget(o.id);
          else flash(tr('その向きに選べる敵はいない。', 'No enemy to pick that way.'));
        } else handled = false;
      } else if (dir) send({ type: 'move', dir });
      else if (e.key === '.' || e.key === '5' || e.key === 'Clear') send({ type: 'wait' });
      // W: 数手待つ（変化があれば止まる）
      else if (e.key === 'W') doWaitTurns();
      // L: 帰還の綱（確認が出る）
      else if (e.key === 'L') doLifeline();
      else if (e.key === 'x') doExplore();
      // Shift+X: 強行（steady）で探索。弱い射撃や毒を受けても止まらない
      else if (e.key === 'X') doExplore('steady');
      // D（Shift+d）: 風の方へ探索（下への風の方角の未探索を優先）
      else if (e.key === 'D') doExploreDraft();
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
      // p: 特技の候補を番号で選ぶ（手番を使わない。キャンプでも）
      else if (e.key === 'p') togglePerk();
      // a: 能動技（1 つならそのまま、2 つ以上なら番号で選ぶ）
      else if (e.key === 'a') openAbilities();
      // A（Shift+a）: 長柄で 2 マス先の敵を突く
      else if (e.key === 'A') doReach();
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
    // 能動技の対象: 候補の敵のマス、身をかわすならその向き（直線で 2 マス以内）
    if (modeRef.current === 'abtarget') {
      const ab = abPickRef.current;
      if (ab?.target === 'dir') { const d = dirToward(v.self.pos, p); if (d) chooseAbDir(d); }
      else { const o = ab?.options.find((x) => x.pos.x === p.x && x.pos.y === p.y); if (o) chooseAbTarget(o.id); }
      return;
    }
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
  // 追ってくる（隣に来るまで待って迎え撃てる）敵
  const comers = obs ? obs.visible.monsters.filter((m) => m.dist > 1 && (isApproaching(m) || (fightApproach === 'advance' && m.awareness === 'hunting' && !m.fleeing))) : [];
  const flee = adjAwake.length ? fleeActions(obs) : [];
  const lifeSlot = lifelineSlot(view, catalog);
  const lifePts = obs?.expedition?.haul?.if_lifeline_now;
  const lifeHow = lifelineEffectText(rulesOf(catalog)?.lifeline?.turns);
  // 下への風（今いる階の下り階段が未発見の間だけ）。「風の方へ探索」を出す
  const draft = obs?.self.floor?.draft;
  // 隣に起きている追跡中の敵がいる: 薬・巻物を使う間にその敵が行動する（V3-2R3 §20.4）
  const exposed = adjAwake.some((m) => m.awareness === 'hunting');
  // ビルド（V3-4）: 特技の候補・長柄で突ける相手
  const perkChoice = view && view.status !== 'dead' && view.status !== 'ended' ? obs?.self.perk_choice : undefined;
  const perkK = perkKey(perkChoice);
  const reach = view?.status === 'at_camp' ? [] : reachTargets(obs);
  const reachIds = new Set(reach.map((m) => m.id));

  // 特技の候補が無くなったら番号の受付を終える
  useEffect(() => {
    if (modeRef.current === 'perk' && !perkChoice) setMode('normal');
  }, [perkK]);

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
    ? tr('投擲: 方向キー/Tab で狙い（Tab は射線が通り射程内の相手だけ）、Enter で投げる・Shift+Enter でそのマスへ・F で投擲で決着（倒れるまで投げ続ける）（Esc 取消）',
      'Throw: aim with keys/Tab (Tab cycles targets in range with a clear line), Enter to throw, Shift+Enter at the cell, F to keep throwing until it falls (Esc cancels)')
    : mode === 'dir' ? tr('操作する方向を選ぶ（. で足元、Esc 取消）', 'Pick a direction (. for here, Esc cancels)')
      : mode === 'inv' ? tr('スロットの文字で既定の操作（i/Esc で戻る）', 'Press a slot letter (i/Esc to exit)')
        : mode === 'pick' ? tr('鑑定する品のスロットの文字を押す（Esc 取消）', 'Press the slot letter of the item to identify (Esc cancels)')
          : mode === 'perk' ? perkModeHint()
            : mode === 'ability' ? abilityModeHint()
              : mode === 'abtarget' && abPick ? abilityPickHint(abPick.name, abPick.target) : null;

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
        <SoundControls />
        <a class="button small" href={`#/watch/${runId}`}>{tr('観戦画面', 'Spectate')}</a>
      </Header>
      <ErrorBanner error={error ?? catErr ?? th.error} onClose={() => setError(null)} />
      <div class="layout">
        <div class="main">
          {/* 特技の候補は下の枠で選ぶので、同じ内容の注意（perk_pending）は出さない */}
          {obs && (
            <AlertsBar alerts={perkChoice ? obs.alerts.filter((a) => a.code !== 'perk_pending') : obs.alerts}
              onEscape={(stairs) => send({ type: 'travel', to: stairs === 'up' ? 'stairs_up' : 'stairs_down', mode: 'flee' })} />
          )}
          {view && perkChoice && (
            <PerkChoicePanel choice={perkChoice} catalog={catalog} classId={view.self.classId} focused={mode === 'perk'} sent={perkSent === perkK}
              collapsed={perkHidden === perkK} onChoose={choosePerk}
              onCollapse={() => { setPerkHidden(perkK); if (mode === 'perk') setMode('normal'); }} onExpand={() => setPerkHidden(null)} />
          )}
          {view?.self.boonChoice && (
            <BoonChoicePanel choice={view.self.boonChoice} catalog={catalog} onChoose={(option) => send({ type: 'choose_boon', option })} />
          )}
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
                    {mode === 'target' && aim?.target && (
                      <div class="nacts">
                        <button class="tiny fight" onClick={fireFight}
                          title={tr('選んだ品を倒れるまで投げ続ける。追ってくる相手は射程と射線が通るまで待つ。隣に来た・品が尽きた・射線が 3 手番通らない・HP が半分を下回ると止まる', 'Keep throwing the item until it falls; waits for range and a clear line if it is hunting you. Stops when it comes adjacent, you run out, the line stays blocked for 3 turns, or HP drops below half')}>
                          {tr('投擲で決着', 'Throw it down')} (F)
                        </button>
                      </div>
                    )}
                    {notice && (
                      <div class="notice">
                        ⚠ {notice.text}
                        {notice.actions && (
                          <div class="nacts">
                            {notice.actions.map((a, i) => (
                              <button key={i} class={`tiny ${a.run ? 'lifeline' : 'flee'}`} title={a.title}
                                onClick={() => { setNotice(null); if (a.run) a.run(); else if (a.command) send(a.command); }}>{a.label}</button>
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
                {mode === 'abtarget' && abPick && (
                  <div class="pickbox abpick">
                    <div class="head">{abPick.name}</div>
                    {abPick.target === 'dir'
                      ? <DirPad passable={obs?.navigation.passable_dirs ?? []} away={slipAway(obs)} onPick={chooseAbDir} />
                      : (
                        <div class="row">
                          {abPick.options.map((o, i) => (
                            <button key={o.id} class={`small ${i === abPick.sel ? 'on' : ''}`} onMouseEnter={() => selectAb(i)} onClick={() => chooseAbTarget(o.id)}>{o.label}</button>
                          ))}
                        </div>
                      )}
                    <div class="row end"><button class="small" onClick={() => setMode('normal')}>{tr('取消（Esc）', 'Cancel (Esc)')}</button></div>
                  </div>
                )}
                {macro?.state === 'running' && <div class="macro">{tr('自動行動中', 'Auto')}: {macro.kind} ({macro.steps})</div>}
                {view && view.status === 'waiting_others' && <div class="macro">{tr('他のプレイヤーの手番を待っています…', 'Waiting for other players…')}</div>}
                {/* キャンプにいる間は地図を隠してキャンプの絵（ASSET_SPEC §7.7）。パネルはその上 */}
                {view && atCamp && <CampScene theme={th.theme} />}
                {view && atCamp && <div class="campwrap"><CampPanel view={view} catalog={catalog} onStart={startExpedition} onRetire={retire} /></div>}
                {exp && expActive && briefingNo === exp.no && <BriefingCard x={exp} catalog={catalog} onClose={() => setBriefingNo(null)} />}
                {view && view.status === 'dead' && !summary && (
                  <div class="deadbox">{tr('あなたは倒れた。', 'You have fallen.')} <a href={`#/watch/${runId}`}>{tr('観戦を続ける', 'Keep watching')}</a> / <a href={`#/replay/${runId}`}>{tr('リプレイ', 'Replay')}</a></div>
                )}
              </>
            }
          />
          {obs && !atCamp && (
            <AbilityBar abilities={obs.self.abilities} catalog={catalog} focused={mode === 'ability' || mode === 'abtarget'} onUse={doAbility} />
          )}
          <div class="actions">
            <span class="seg mmode" title={tr('探索・移動・回収のマクロの止まり方。慎重: 初見の種族・追跡してくる敵・攻撃を受けたら止まる。強行: 隣接・進路をふさがれる・HP が半分を下回る・初見の種族でだけ止まる（弱い射撃や毒は受けながら進む）',
              'How explore/travel/collect stop. Careful: on a new species, a hunting enemy, or being attacked. Steady: only when an enemy is adjacent or blocks the way, HP drops below half, or a new species appears')}>
              <span class="lbl">{tr('移動', 'Move')}</span>
              <button class={`tiny ${moveMode === 'careful' ? 'on' : ''}`} onClick={() => setMoveMode('careful')}>{tr('慎重', 'Careful')}</button>
              <button class={`tiny ${moveMode === 'steady' ? 'on' : ''}`} onClick={() => setMoveMode('steady')}>{tr('強行', 'Steady')}</button>
            </span>
            <span class="seg mmode" title={tr('戦う（F）で、追ってくるが隣にいない相手を: 待つ＝隣に来るまで待つ（最大 10 手番）／寄る＝寄っていき、隣に着いたら殴る（歩く間に撃たれても止まらない。動かずに撃ってくる相手に）',
              'Fight (F) against a hunter that is not adjacent: Wait = wait until it comes adjacent (up to 10 turns) / Close in = walk up to it and attack once adjacent (getting shot on the way does not stop it; for enemies that stand and shoot)')}>
              <span class="lbl">{tr('戦う', 'Fight')}</span>
              <button class={`tiny ${fightApproach === 'wait' ? 'on' : ''}`} onClick={() => setFightApproach('wait')}>{tr('待つ', 'Wait')}</button>
              <button class={`tiny ${fightApproach === 'advance' ? 'on' : ''}`} onClick={() => setFightApproach('advance')}>{tr('寄る', 'Close in')}</button>
            </span>
            <button class="small" onClick={() => doExplore()} title={tr('x（Shift+X: 強行で探索・Shift+D: 風の方へ探索）', 'x (Shift+X: explore steadily, Shift+D: explore toward the draft)')}>{tr('探索', 'Explore')} (x)</button>
            {draft && !atCamp && adjAwake.length === 0 && (
              <button class="small draft" onClick={doExploreDraft}
                title={tr(`下への風（${dirLabel(L, draft)}）の方角にある未探索を優先して探索する（D）。止まり方は「移動」の慎重・強行に従う`,
                  `Explore, preferring unexplored cells toward the draft (${dirLabel(L, draft)}) (D). Stops as set by Move: careful / steady`)}>
                {tr('風の方へ探索', 'Toward the draft')} {DIR_ARROW[draft]} (D)
              </button>
            )}
            {adjacent.length > 0 ? (
              <button class="small fight" onClick={() => doFight()} title={tr('隣の敵を、倒れる・離れる・HP が半分を下回るまで殴り続ける（F）', 'Keep attacking the adjacent enemy until it falls, moves away, or your HP drops below half (F)')}>
                {tr('戦う', 'Fight')} (F)
              </button>
            ) : comers.length > 0 && (fightApproach === 'advance' ? (
              <button class="small fight" onClick={() => doFight()}
                title={tr(`追ってくる敵（${comers[0].name}）へ寄っていき、隣に着いたら殴り続ける（F）。歩く間に撃たれても止まらない。HP が半分を下回る・別の追跡中の敵で止まる`, `Walk up to the enemy hunting you (${comers[0].name}) and keep attacking once adjacent (F). Getting shot on the way does not stop it. Stops below half HP or on another hunting enemy`)}>
                {tr('寄って戦う', 'Close in')} (F)
              </button>
            ) : (
              <button class="small fight" onClick={() => doFight()}
                title={tr(`追ってくる敵（${comers[0].name}）が隣に来るまで待ち（最大 10 手番）、来たら殴り続ける（F）。HP が半分を下回る・別の追跡中の敵で止まる`, `Wait until the enemy hunting you (${comers[0].name}) comes adjacent (up to 10 turns), then keep attacking (F). Stops below half HP or on another hunting enemy`)}>
                {tr('迎え撃つ', 'Meet')} (F)
              </button>
            ))}
            {reach.map((m) => (
              <button key={`reach-${m.id}`} class="small fight" onClick={() => doReach(m.id)} title={reachAttackTitle()}>{reachAttackLabel(m.name)} (A)</button>
            ))}
            {flee.map((a, i) => (
              <button key={`flee-${i}`} class="small flee" title={a.title} onClick={() => { if (a.command) send(a.command); }}>{a.label}</button>
            ))}
            {expActive && lifeSlot && lifePts !== undefined && !obs?.expedition?.can_extract && (
              <button class="small lifeline" onClick={doLifeline}
                title={tr(`帰還の綱（L）: 階段から遠くても使える退却。${lifeHow}。確認が出る`, `Lifeline (L): a retreat usable anywhere; ${lifeHow}. Asks to confirm`)}>
                {tr(`帰還の綱 +${lifePts}`, `Lifeline +${lifePts}`)} (L)
              </button>
            )}
            <button class="small" onClick={() => doRest()} title="R">{tr('休憩', 'Rest')} (R)</button>
            <span class="resthp">
              <input type="number" min={1} max={view?.self.stats.maxHp ?? 999} value={restHp} placeholder="HP"
                onInput={(e) => setRestHp((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); doRest(parseInt(restHp, 10) || undefined); } }} />
              <button class="small" onClick={() => doRest(parseInt(restHp, 10) || undefined)} title={tr('指定した HP まで休む', 'Rest until this HP')}>{tr('まで休む', 'Rest until')}</button>
            </span>
            <button class="small" onClick={() => send({ type: 'wait' })} title=".">{tr('待機', 'Wait')} (.)</button>
            <button class="small" onClick={doWaitTurns}
              title={tr(`最大 ${WAIT_TURNS} 手番続けて待つ（W）。敵が新たに見えた・隣に来た・被害・状態異常で止まる`, `Wait up to ${WAIT_TURNS} turns (W). Stops when an enemy appears or comes adjacent, on damage, or on a status change`)}>
              {tr('数手待つ', 'Wait a few')} (W)
            </button>
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
              <button class={`small ${obs?.expedition?.can_extract ? 'exit' : ''}`} onClick={doExtract}
                title={tr('階段の上で遠征を終える（追跡中の敵が見えていてもよい）。次の遠征はその階段から始まり、その階の敵は追跡をやめて全快する', 'End the expedition on stairs (even with hunters in view). The next expedition starts from those stairs; monsters there stop hunting and heal fully')}>
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
          {view && (
            <ExpeditionPanel view={view} obs={obs} catalog={catalog} onBriefing={exp && expActive ? () => setBriefingNo(exp.no) : undefined}
              onLifeline={expActive && lifeSlot ? doLifeline : undefined} />
          )}
          {view && catalog && <StatusPanel view={view} catalog={catalog} speed={obs?.self.speed} floor={atCamp ? null : obs?.self.floor} />}
          {obs && <ObsPartyPanel party={obs.party} />}
          {obs && !atCamp && <MonstersPanel monsters={obs.visible.monsters} hp={obs.self.hp} onFight={doFight} throwSlotFor={throwSlotFor} reach={reachIds} onReach={doReach} />}
          {view && catalog && <InventoryPanel view={view} catalog={catalog} onAction={invAction} focused={mode === 'inv'} selected={selSlot} onSelect={setSelSlot} exposed={exposed} />}
          <MessageLog lines={log} />
          <form class="chat" onSubmit={(e) => { e.preventDefault(); if (chat.trim()) { send({ type: 'say', text: chat.trim().slice(0, 280) }); setChat(''); } }}>
            <input value={chat} placeholder={tr('チャット（COOP）', 'Chat (COOP)')} onInput={(e) => setChat((e.target as HTMLInputElement).value)} />
          </form>
          {view && catalog && view.inventory.length > 0 && selSlot && (
            <div class="muted small">{tr('選択中', 'Selected')}: {(() => { const it = view.inventory.find((x) => x.slot === selSlot); return it ? itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes) : '-'; })()}</div>
          )}
          <div class="help muted">
            {tr('移動: 矢印/テンキー/hjklyubn　待機: .　数手待つ: W　探索: x（強行: X・風の方へ: D）　戦う: F（隣の敵。いなければ追ってくる敵を迎え撃つ）　休憩: R　拾う: g　拾い集める: G　回収: C　階段: >　帰還/撤退: E（階段の上）　帰還の綱: L　投擲: t（狙い中に F で投擲で決着）　操作: o　所持品: i　能動技: a（2 つ以上なら番号で選ぶ）　特技を選ぶ: p → 番号　長柄で突く: A　クリック: その場所へ移動（Shift+クリック: 退く）',
              'Move: arrows/numpad/hjklyubn  Wait: .  Wait a few: W  Explore: x (steady: X, toward the draft: D)  Fight: F (adjacent; otherwise meet a hunter)  Rest: R  Pick up: g  Collect items: G  Collect thrown: C  Stairs: >  Extract: E (on stairs)  Lifeline: L  Throw: t (F while aiming: throw until it falls)  Interact: o  Inventory: i  Abilities: a (then a number if you have several)  Choose a perk: p, then a number  Reach strike: A  Click: travel (Shift+click: flee)')}
          </div>
        </aside>
      </div>
      {summary && <SummaryDialog summary={summary} catalog={catalog} onClose={() => setSummary(null)} />}
    </div>
  );
}

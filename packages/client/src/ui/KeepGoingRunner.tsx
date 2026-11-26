// 続けて遊ばせる（S14。SEASON.md §65.2・§65.4）の、鳴らす役。アプリの根（main.tsx）に置くので、どの画面（拠点・支度・観戦・記録・運用）にいても、
// このアプリのタブが開いていれば続く。決める所は ui/keepGoing.ts（時刻を外から渡す関数）。ここは、時計・このブラウザの印・一覧の読み直し・鳴らすことだけ。
// タブを 2 つ開いていても、鳴らすのは、生きているタブのうち 1 つ（kgLeader）。タブを全部閉じたら止まり、次に開いても、自動では再開しない（kgOnOpen）。
// 鳴らす時が来て、ブラウザが止めたかもしれないときは、どの画面でも、下の帯と札を光らせ、短い音を鳴らし、「今、鳴らす」を押してもらう。
import { useEffect } from 'preact/hooks';
import { bellUrl, readBell, ringBell } from './bell';
import {
  KG, kgBeat, kgBlockedText, kgLastInput, kgLastLaunch, kgLeader, kgMaybeBlocked, kgNoteInput, kgNoteLaunch, kgOnOpen, kgPace, kgRang, kgRead, kgReadAll, kgReadTabs,
  kgStep, kgStopped, kgWrite, kgWriteTabs, type KgState,
} from './keepGoing';
import { activationNow, kgChime, kgObserveRun, kgRingNow } from './keepGoingRing';
import { useKeepGoing } from './keepGoingUi';
import { tr } from '../util';

const TAB_KEY = 'muse.keepGoing.tab';
const RELOAD_KEY = 'muse.keepGoing.reloadAt';

/** このタブの ID（sessionStorage: 読み直しても同じ。タブを閉じたら消える） */
function tabId(): string {
  try {
    const have = window.sessionStorage.getItem(TAB_KEY);
    if (have) return have;
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(TAB_KEY, id);
    return id;
  } catch {
    return `t-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** このタブが、閉じる直前（読み直しの前）に覚えた時刻（読んだら消す） */
function takeReloadAt(): number | null {
  try {
    const v = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? '');
    window.sessionStorage.removeItem(RELOAD_KEY);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** アプリの根に置く: 鳴らす役と、呼び鈴を鳴らせなかったかもしれないときの帯（どの画面でも） */
export function KeepGoingRunner() {
  const states = useKeepGoing();
  useEffect(() => {
    const me = tabId();
    const reloadAt = takeReloadAt();
    const now0 = Date.now();
    // 開いたとき: ほかに生きているタブが無く、読み直しでもなければ、動いていたものは「タブを閉じたため」止まっている（自動では再開しない）
    const tabs0 = kgReadTabs();
    for (const st of Object.values(kgReadAll())) {
      const n = kgOnOpen(st, tabs0, reloadAt, now0);
      if (n !== st) kgWrite(n);
    }
    kgWriteTabs(kgBeat(tabs0, me, now0));
    let busy = false;
    let lastInput = 0;
    const onInput = () => {
      const t = Date.now();
      if (t - lastInput < 2000) return;
      lastInput = t;
      kgNoteInput(t);
    };
    const tick = async () => {
      const now = Date.now();
      const tabs = kgBeat(kgReadTabs(), me, now);
      kgWriteTabs(tabs);
      if (busy || kgLeader(tabs, now) !== me) return;
      const running = Object.values(kgReadAll()).filter((s) => s.status === 'running');
      if (!running.length) return;
      busy = true;
      try {
        for (const st0 of running) {
          const obs = await kgObserveRun(st0);
          // 読み直している間に、止めた・ほかのタブが鳴らした、を拾う
          const fresh = kgRead(st0.runId);
          if (!fresh || fresh.status !== 'running') continue;
          const t = Date.now();
          const { state: s1, ring } = kgStep(fresh, obs, { now: t, bellOn: readBell() === 'tool' });
          const pace = obs.kind === 'row' ? kgPace(obs.row) : fresh.pace ?? null;
          const state: KgState = { ...s1, pace };
          if (!ring) { kgWrite(state); continue; }
          // 鳴らす直前に、もう一度、鳴らす役か確かめる（ほかのタブが開いた直後など）
          if (kgLeader(kgReadTabs(), t) !== me) continue;
          const url = bellUrl('tool', { season: state.seasonId, run: state.runId, pace });
          if (!url) { kgWrite(kgStopped(state, 'bell_off', t)); continue; }
          const blocked = kgMaybeBlocked({ activation: activationNow(), lastLaunchAt: kgLastLaunch(), lastInputAt: kgLastInput() });
          ringBell(url);
          kgNoteLaunch(t);
          kgWrite(kgRang(state, ring, t, blocked));
          if (blocked) kgChime();
        }
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(() => void tick(), 1500);
    const timer = setInterval(() => void tick(), KG.TICK_MS);
    // 閉じる・読み直す: このタブの印を外す（読み直しなら、この時刻で、同じタブとして続ける）
    const onHide = () => {
      const t = kgReadTabs();
      delete t[me];
      kgWriteTabs(t);
      try { window.sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* 覚えられない */ }
    };
    const onShow = () => { kgWriteTabs(kgBeat(kgReadTabs(), me, Date.now())); };
    window.addEventListener('pointerdown', onInput, true);
    window.addEventListener('keydown', onInput, true);
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('pointerdown', onInput, true);
      window.removeEventListener('keydown', onInput, true);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  const need = Object.values(states).filter((s) => s.status === 'running' && s.attention);
  // タブの名前にも印（ほかのタブを見ているときに気づけるように）
  useEffect(() => {
    const mark = '● ';
    const base = document.title.startsWith(mark) ? document.title.slice(mark.length) : document.title;
    document.title = need.length ? `${mark}${base}` : base;
  }, [need.length]);
  if (!need.length) return null;
  return (
    <div class="kg-bar" role="alert">
      {need.map((s) => (
        <div key={s.runId} class="kg-barrow">
          <p class="kg-bartext">{kgBlockedText(s.name)}</p>
          <button type="button" class="hub-btn primary kg-ring" onClick={() => kgRingNow(s)}>{tr('今、鳴らす', 'Ring now')}</button>
        </div>
      ))}
    </div>
  );
}

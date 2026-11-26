// 続けて遊ばせる（S14。SEASON.md §65.2・§65.4）の、鳴らす役。アプリの根（main.tsx）に置くので、どの画面（拠点・支度・観戦・記録・運用）にいても、
// このアプリのタブが開いていれば続く。決める所は ui/keepGoing.ts（時刻を外から渡す関数）。ここは、時計・このブラウザの印・一覧の読み直し・鳴らすことだけ。
// タブを 2 つ開いていても、鳴らすのは、生きているタブのうち 1 つ（kgLeader）。タブを全部閉じたら止まり、次に開いても、自動では再開しない（kgOnOpen）。
// 受け口に送れなかったときは、どの画面でも、下の帯に「受け口が、動いていない」と「もう一度鳴らす」（S15: リンクの鳴らし方と、光らせて押してもらう流れは、外した）。
import { useEffect } from 'preact/hooks';
import { bellOn, bellProblem, bellRingOf, readBellConfig } from './bell';
import {
  KG, kgHeartbeat, kgLeader, kgLeave, kgOnOpen, kgPace, kgPortFailText, kgRead, kgReadAll, kgReadTabs, kgStep, kgStopped, kgWrite, kgWriteTabs, type KgState,
} from './keepGoing';
import { kgObserveRun, kgRingNow, kgRingVia } from './keepGoingRing';
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

/** ブラウザの言う、このページの開き方（reload・navigate・back_forward など。分からなければ null） */
function navType(): string | null {
  try {
    const e = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return e?.type ?? null;
  } catch {
    return null;
  }
}

/** アプリの根に置く: 鳴らす役と、受け口に送れなかったときの帯（どの画面でも） */
export function KeepGoingRunner() {
  const states = useKeepGoing();
  useEffect(() => {
    const me = tabId();
    const nav = { reloadAt: takeReloadAt(), type: navType() };
    const now0 = Date.now();
    // 開いたとき: ほかに生きているタブが無く、このタブの読み直し（ブラウザが reload と言う）でもなければ、動いていたものは「タブを閉じたため」止まっている
    // （自動では再開しない。S14b: 閉じたタブをすぐ開き直す・セッションの復元は、続けない）
    const tabs0 = kgReadTabs();
    for (const st of Object.values(kgReadAll())) {
      const n = kgOnOpen(st, tabs0, me, nav, now0);
      if (n !== st) kgWrite(n);
    }
    kgWriteTabs(kgHeartbeat(tabs0, me, now0).tabs);
    let busy = false;
    const tick = async () => {
      const now = Date.now();
      const hb = kgHeartbeat(kgReadTabs(), me, now);
      kgWriteTabs(hb.tabs);
      if (busy || !hb.leader) return;
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
          const cfg = readBellConfig();
          // 覚えた受け口のポート・合言葉の形が違う（S14b）: 鳴らさずに止めて、「呼び鈴の設定を見直す」
          const { state: s1, ring } = kgStep(fresh, obs, { now: t, bellOn: bellOn(cfg), bellSetup: !!bellProblem(cfg) });
          const pace = obs.kind === 'row' ? kgPace(obs.row) : fresh.pace ?? null;
          const state: KgState = { ...s1, pace };
          if (!ring) { kgWrite(state); continue; }
          // 鳴らす直前に、もう一度、鳴らす役か確かめる（ほかのタブが開いた直後など）
          if (kgLeader(kgReadTabs(), t) !== me) continue;
          const r = bellRingOf(cfg, { season: state.seasonId, run: state.runId, pace });
          if (!r) { kgWrite(kgStopped(state, 'bell_setup', t)); continue; }
          // 受け口（S14a）: 人の操作が要らないので、そのまま送る
          await kgRingVia(r, state, ring, t);
        }
      } finally {
        busy = false;
      }
    };
    const first = setTimeout(() => void tick(), 1500);
    const timer = setInterval(() => void tick(), KG.TICK_MS);
    // 閉じる・読み直す: このタブの印を外す（読み直しなら、この時刻で、同じタブとして続ける）
    const onHide = () => {
      kgWriteTabs(kgLeave(kgReadTabs(), me));
      try { window.sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* 覚えられない */ }
    };
    const onShow = () => { kgWriteTabs(kgHeartbeat(kgReadTabs(), me, Date.now()).tabs); };
    window.addEventListener('pagehide', onHide);
    window.addEventListener('pageshow', onShow);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      window.removeEventListener('pagehide', onHide);
      window.removeEventListener('pageshow', onShow);
    };
  }, []);

  // 受け口に送れなかった（S14a。知らせるだけ）
  const need = Object.values(states).filter((s) => s.status === 'running' && s.portFail);
  if (!need.length) return null;
  return (
    <div class="kg-bar" role="alert">
      {need.map((s) => (
        <div key={s.runId} class="kg-barrow">
          <p class="kg-bartext">{kgPortFailText(s.name, s.portFail!.port)}</p>
          <button type="button" class="hub-btn primary kg-ring" onClick={() => void kgRingNow(s)}>{tr('もう一度鳴らす', 'Ring again')}</button>
        </div>
      ))}
    </div>
  );
}

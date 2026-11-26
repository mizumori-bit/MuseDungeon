// 続けて遊ばせる（S14。SEASON.md §65.2・§65.4 の 1 と 3。画面だけ）: 持ち主が、拠点の札から、限り（遠征をあと N 回）を決めて始める。
// このアプリのタブが開いている間だけ、ブラウザが、決まった時に、呼び鈴（ui/bell.ts の文字列。ID と、決まった 1 語だけ）を開く。サーバーは、何もしない。
// ここは、決める所（いつ鳴らすか・止まるか・数え方・2 つのタブのどちらが鳴らすか）と、このブラウザに覚える状態だけ。時刻は外から渡す（テストする）。
// 鳴らす役（ui/KeepGoingRunner.tsx。アプリの根）と、拠点の札（screens/Lobby.tsx・ui/keepGoingUi.tsx）が、同じ状態を読む。
// 覚える所は localStorage（ランの ID・残りの回数を決める値・始めたときの遠征の数・鳴らした回数と時刻）。鍵は覚えない（鍵は今までどおり ui/keys.ts）。
import type { OwnerPace, OwnerRunRow } from '@muse/shared';
import { getPref, setPref, tr } from '../util';

/** 決まり（§65.2）。時間はミリ秒 */
export const KG = {
  /** キャンプで、AI の最後の呼び出しから、これだけたったら鳴らす */
  CAMP_SILENT_MS: 30_000,
  /** 同じキャンプで鳴らす間（2 分おき） */
  CAMP_RING_GAP_MS: 120_000,
  /** 同じキャンプで鳴らすのは、ここまで（3 回鳴らしても遠征が始まらなければ、止めて「起きない」） */
  CAMP_RINGS_MAX: 3,
  /** 迷宮の中で、AI が、これだけ黙ったら、1 回だけ鳴らす（同じ遠征で 1 回） */
  DUNGEON_SILENT_MS: 300_000,
  /** 2 つのタブが重ねて鳴らさないための、鳴らした後の間 */
  RING_COOLDOWN_MS: 60_000,
  /** 鳴らす役は、印がこれより新しいタブから選ぶ（閉じるときの知らせ pagehide が来ないまま消えたタブに、役を残さない） */
  TAB_FRESH_MS: 30_000,
  /** タブを開いたとき、印がこれより新しいタブがあれば、まだ開いている（隠れたタブの時計は、ブラウザが 1 分に 1 回まで遅らせることがある） */
  TAB_OPEN_MS: 90_000,
  /** タブの印がこれだけ古ければ、捨てる（新しい印のタブが 1 つも無いときは、この中から鳴らす役を選ぶ） */
  TAB_TTL_MS: 180_000,
  /** 読み直し（再読み込み）の後、これだけの間は、同じタブとして続ける */
  RELOAD_GRACE_MS: 60_000,
  /** 鳴らす役のタブが、様子を見る間 */
  TICK_MS: 10_000,
  /** ランが一覧に無い（持ち主と認められない）のが、何回続いたら止めるか */
  MISSING_MAX: 2,
  /** 回数の選び方 */
  N_MIN: 1, N_MAX: 10, N_DEFAULT: 3,
} as const;

/** 止まった理由 */
export type KgStopReason = 'done' | 'ended' | 'budget' | 'season_over' | 'by_owner' | 'held' | 'bell_off' | 'not_owner' | 'no_wake' | 'tabs_closed';
export type KgWhere = 'camp' | 'dungeon';

/** 鳴らした 1 回（maybeBlocked: ブラウザが止めたかもしれない） */
export interface KgRing { at: number; where: KgWhere; maybeBlocked: boolean }

/** 1 人の冒険者の「続けて遊ばせる」の状態（このブラウザの localStorage） */
export interface KgState {
  v: 1;
  runId: string;
  seasonId: string | null;
  /** 札の名前（文に出すだけ。呼び鈴の文字列には入れない） */
  name: string;
  /** 決めた回数（遠征をあと N 回） */
  total: number;
  /** 始めたときに、終わっていた遠征の数（ここから数える。始めたときに迷宮の中なら、その遠征も 1 回に数える） */
  startEnded: number;
  startedAt: number;
  status: 'running' | 'stopped';
  /** 鳴らしているキャンプ（そのときの、終わった遠征の数）と、そのキャンプで鳴らした回数 */
  campKey: number | null;
  campRings: number;
  /** 迷宮の中で鳴らした遠征（そのときの、終わった遠征の数） */
  dungeonRungFor: number | null;
  lastRingAt: number | null;
  /** 鳴らした回数（全部） */
  rings: number;
  /** 鳴らした記録（新しい 5 つ） */
  log: KgRing[];
  /** ブラウザが止めたかもしれない呼び鈴（「今、鳴らす」を押すまで、札を光らせる） */
  attention: { at: number; where: KgWhere } | null;
  /** ランが一覧に無かった回数（続けて） */
  missing: number;
  /** 最後に見た様子 */
  seen: { ended: number; where: KgWhere; at: number } | null;
  stop: { reason: KgStopReason; at: number } | null;
  /** 最後に見た、持ち主の希望（進め方）。pilot なら、呼び鈴の文字列に &mode=pilot（「今、鳴らす」でも同じ文字列にするため） */
  pace?: OwnerPace | null;
}

/** 札・鳴らす役が読む、一覧の行のうち使うもの */
export type KgRow = Pick<OwnerRunRow, 'status' | 'eligible' | 'hold' | 'budgetLeft' | 'continuable' | 'oldVersion' | 'ai' | 'expeditionsEnded' | 'pace'>;

/**
 * 様子: row 一覧の行がある／gone 一覧に無い（ended ランが終わった・season_over シーズンが確定した・unknown 分からない＝持ち主と認められないかもしれない）／
 * error 読めなかった（サーバーが落ちている など。何もしない）
 */
export type KgObs = { kind: 'row'; row: KgRow } | { kind: 'gone'; why: 'ended' | 'season_over' | 'unknown' } | { kind: 'error' };

export function kgClampN(n: unknown): number {
  const x = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : KG.N_DEFAULT;
  return Math.max(KG.N_MIN, Math.min(KG.N_MAX, x));
}

/** 始めるときの状態 */
export function kgStart(x: { runId: string; seasonId: string | null; name: string; total: number; ended: number; now: number; pace?: OwnerPace | null }): KgState {
  return {
    v: 1, runId: x.runId, seasonId: x.seasonId, name: x.name, total: kgClampN(x.total), startEnded: Math.max(0, x.ended), startedAt: x.now, status: 'running',
    campKey: null, campRings: 0, dungeonRungFor: null, lastRingAt: null, rings: 0, log: [], attention: null, missing: 0, seen: null, stop: null,
    pace: x.pace === 'pilot' ? 'pilot' : null,
  };
}

export function kgStopped(st: KgState, reason: KgStopReason, now: number): KgState {
  return { ...st, status: 'stopped', stop: { reason, at: now }, attention: null };
}

/** 残りの回数（終わった遠征の数から） */
export function kgLeft(st: Pick<KgState, 'total' | 'startEnded'>, ended: number): number {
  return Math.max(0, st.total - Math.max(0, ended - st.startEnded));
}

/**
 * 札に「続けて遊ばせる」を出すか（§65.4 の 3）: start 出す／held 握っている項目がある（小さく、続けては呼ばない、と出す）／null 出さない。
 * 条件: 持ち主と認められている（一覧に行がある）・AI の冒険者・続きを遊べる・握っている項目が無い・呼び鈴の設定が「自分の道具を呼ぶ」
 */
export function kgOffer(x: { row: KgRow | null; bellOn: boolean }): 'start' | 'held' | null {
  const r = x.row;
  if (!x.bellOn || !r || !r.eligible || r.status === 'ended' || r.oldVersion) return null;
  if (r.status === 'at_camp' && (r.continuable === false || (r.budgetLeft !== undefined && r.budgetLeft <= 0))) return null;
  if (r.hold.length) return 'held';
  return 'start';
}

/**
 * 1 回の様子見（鳴らす役のタブだけが呼ぶ）。返すのは、新しい状態と、今鳴らすか（鳴らす所）。止まる・鳴らすの決まりは §65.2・§65.4:
 * 止まる: 決めた回数に達した・ランが終わった（倒れた）・予算を使い切った・シーズンが終わった・握る項目ができた・呼び鈴を「使わない」にした・
 * 持ち主と認められなくなった・同じキャンプで 3 回鳴らしても遠征が始まらない。
 * 鳴らす: キャンプで AI の最後の呼び出しから 30 秒（同じキャンプで 2 分おきに 3 回まで）・迷宮の中で 5 分（同じ遠征で 1 回）。AI が待っている間は鳴らさない
 */
export function kgStep(st: KgState, obs: KgObs, ctx: { now: number; bellOn: boolean }): { state: KgState; ring: KgWhere | null } {
  const now = ctx.now;
  const none = (s: KgState) => ({ state: s, ring: null });
  if (st.status !== 'running') return none(st);
  if (!ctx.bellOn) return none(kgStopped(st, 'bell_off', now));
  if (obs.kind === 'error') return none(st);
  if (obs.kind === 'gone') {
    if (obs.why === 'ended') return none(kgStopped(st, 'ended', now));
    if (obs.why === 'season_over') return none(kgStopped(st, 'season_over', now));
    const missing = st.missing + 1;
    return none(missing >= KG.MISSING_MAX ? kgStopped({ ...st, missing }, 'not_owner', now) : { ...st, missing });
  }
  const row = obs.row;
  let s: KgState = { ...st, missing: 0 };
  if (row.status === 'ended') return none(kgStopped(s, 'ended', now));
  if (!row.eligible) return none(kgStopped(s, 'not_owner', now));
  if (row.hold.length) return none(kgStopped(s, 'held', now));
  const ended = row.expeditionsEnded ?? 0;
  const where: KgWhere = row.status === 'at_camp' ? 'camp' : 'dungeon';
  s = { ...s, seen: { ended, where, at: now } };
  if (kgLeft(s, ended) <= 0) return none(kgStopped(s, 'done', now));
  if (where === 'camp') {
    if (row.budgetLeft !== undefined && row.budgetLeft <= 0) return none(kgStopped(s, 'budget', now));
    // 続きを遊べないキャンプ（終わりの時刻を過ぎた・確定した。予算切れは上）
    if (row.continuable === false) return none(kgStopped(s, 'season_over', now));
  }
  const silent = row.ai?.lastCallAgoS === null || row.ai?.lastCallAgoS === undefined ? Number.POSITIVE_INFINITY : row.ai.lastCallAgoS * 1000;
  // AI が、今、呼び出している・待っている（または、鳴らした後に呼び出した）: 起きている。札の光は消す
  if (s.attention && (s.lastRingAt === null || silent < now - s.lastRingAt)) s = { ...s, attention: null };
  if (row.ai?.waitingNow) return none(s);
  const cooled = s.lastRingAt === null || now - s.lastRingAt >= KG.RING_COOLDOWN_MS;
  if (where === 'camp') {
    if (s.campKey !== ended) s = { ...s, campKey: ended, campRings: 0, attention: null };
    if (silent < KG.CAMP_SILENT_MS) return none(s);
    const sinceRing = s.campRings > 0 && s.lastRingAt !== null ? now - s.lastRingAt : Number.POSITIVE_INFINITY;
    if (s.campRings >= KG.CAMP_RINGS_MAX) return none(sinceRing >= KG.CAMP_RING_GAP_MS ? kgStopped(s, 'no_wake', now) : s);
    if (sinceRing < KG.CAMP_RING_GAP_MS || !cooled) return none(s);
    return { state: { ...s, campRings: s.campRings + 1 }, ring: 'camp' };
  }
  if (silent < KG.DUNGEON_SILENT_MS || s.dungeonRungFor === ended || !cooled) return none(s);
  return { state: { ...s, dungeonRungFor: ended }, ring: 'dungeon' };
}

/** 鳴らしたことを覚える（maybeBlocked なら、札を光らせる） */
export function kgRang(st: KgState, where: KgWhere, now: number, maybeBlocked: boolean): KgState {
  return {
    ...st, lastRingAt: now, rings: st.rings + 1, log: [...st.log, { at: now, where, maybeBlocked }].slice(-5),
    attention: maybeBlocked ? { at: now, where } : null,
  };
}

/**
 * ブラウザが、この呼び鈴を止めたかもしれないか（分かる範囲で）。Chromium 系のブラウザ（Chrome・Edge）は、外の道具を開くリンクを、
 * 人の操作の後に 1 回だけ通し、次は、また人が操作するまで止める（ページからは、止めたかどうかを知る手立てが無い）。
 * activation: 今、人の操作の直後か（navigator.userActivation.isActive。分からなければ null）。lastLaunchAt: このアプリのタブが、最後に呼び鈴を開いた時刻。
 * lastInputAt: このアプリのタブで、人が最後に操作した時刻
 */
export function kgMaybeBlocked(x: { activation: boolean | null; lastLaunchAt: number | null; lastInputAt: number | null }): boolean {
  if (x.activation === true) return false;
  if (x.lastLaunchAt === null) return false;
  return x.lastInputAt === null || x.lastInputAt <= x.lastLaunchAt;
}

// ---- 2 つのタブ ----

/** 開いているタブの印（タブの ID → 最後に見た時刻） */
export type KgTabs = Record<string, number>;

/** 印が within より新しいタブ（ID の順。既定は、捨てるまでの間） */
export function kgAlive(tabs: KgTabs, now: number, within: number = KG.TAB_TTL_MS): string[] {
  return Object.entries(tabs).filter(([, at]) => typeof at === 'number' && now - at < within).map(([id]) => id).sort();
}

/**
 * 鳴らす役のタブ: 印の新しい（30 秒）タブのうち、ID のいちばん小さいもの。無ければ（どのタブも、隠れていて時計が遅い）、捨てていないタブのうち、ID のいちばん小さいもの。
 * どのタブも、同じ印から同じ答えを出す。閉じるときの知らせが来ないまま消えたタブは、30 秒で役を外れる
 */
export function kgLeader(tabs: KgTabs, now: number): string | null {
  return kgAlive(tabs, now, KG.TAB_FRESH_MS)[0] ?? kgAlive(tabs, now)[0] ?? null;
}

/** 印を整える（自分の印を今にし、古いものを捨てる） */
export function kgBeat(tabs: KgTabs, me: string, now: number): KgTabs {
  const out: KgTabs = {};
  for (const id of kgAlive(tabs, now)) out[id] = tabs[id];
  out[me] = now;
  return out;
}

/**
 * タブを開いたとき（§65.4 の 3）: 動いている状態があるのに、ほかに生きているタブが無く、このタブの読み直しでもなければ、タブを全部閉じたので止まった（自動では再開しない）。
 * tabs: 開く前の印（自分の印を足す前）。reloadAt: このタブ（sessionStorage）が閉じる直前に覚えた時刻（読み直しなら、ある）
 */
export function kgOnOpen(st: KgState, tabs: KgTabs, reloadAt: number | null, now: number): KgState {
  if (st.status !== 'running') return st;
  if (kgAlive(tabs, now, KG.TAB_OPEN_MS).length > 0) return st;
  if (reloadAt !== null && now - reloadAt < KG.RELOAD_GRACE_MS) return st;
  return kgStopped(st, 'tabs_closed', now);
}

// ---- 札の文 ----

/** 止まった理由の 1 行 */
export function kgStopText(reason: KgStopReason, name: string, total: number): string {
  switch (reason) {
    case 'done': return tr(`決めた回数（${total} 回）の遠征が終わった。`, `The ${total} expedition${total > 1 ? 's' : ''} you set are done.`);
    case 'ended': return tr('この冒険が終わった（倒れた・引退した）。', 'This adventure has ended (a fall, or retirement).');
    case 'budget': return tr('このシーズンの手番を、使い切った。', 'All of this season\'s turns are used.');
    case 'season_over': return tr('シーズンが終わった。新しい遠征は、始まらない。', 'The season is over. No new expedition starts.');
    case 'by_owner': return tr('あなたが止めた。', 'You stopped it.');
    case 'held': return tr('握る項目ができた（キャンプごとに、支度を決める）。', 'Something is now held (you prepare at each camp).');
    case 'bell_off': return tr('呼び鈴の設定を「使わない」にした。', 'The bell was set to Off.');
    case 'not_owner': return tr('この冒険者の持ち主と、認められなくなった（鍵を外した など）。', 'You are no longer recognized as this adventurer\'s owner (the key was removed, for example).');
    case 'no_wake': return tr(`${name}が、起きない（同じキャンプで、呼び鈴を ${KG.CAMP_RINGS_MAX} 回鳴らしても、遠征が始まらなかった）。`, `${name} does not wake (the bell rang ${KG.CAMP_RINGS_MAX} times at the same camp and no expedition started).`);
    case 'tabs_closed': return tr('タブを閉じたため。', 'The tab was closed.');
  }
}

/** 動いている間の見出し（「続けて遊ばせている（あと 2 回）」） */
export function kgRunningText(left: number): string {
  return tr(`続けて遊ばせている（あと ${left} 回）`, `Keeping them going (${left} more)`);
}

/** 止まったときの見出し（タブを閉じたときは「もう一度始める？」） */
export function kgStoppedText(st: Pick<KgState, 'stop' | 'name' | 'total'>): string {
  if (!st.stop) return '';
  const why = kgStopText(st.stop.reason, st.name, st.total);
  return st.stop.reason === 'tabs_closed'
    ? tr(`続けて遊ばせる、は止まっている（${why.replace(/。$/, '')}）。もう一度始める？`, `"Keep them going" is stopped (${why.replace(/\.$/, '')}). Start it again?`)
    : tr(`続けて遊ばせる、は止まった: ${why}`, `"Keep them going" stopped: ${why}`);
}

/** 鳴らした記録の 1 行（最後に鳴らした時刻と所。fmt は時刻の書き方） */
export function kgLastRingText(st: Pick<KgState, 'log' | 'rings'>, fmt: (ms: number) => string): string | null {
  const r = st.log.at(-1);
  if (!r) return null;
  return tr(`最後に呼び鈴を鳴らした: ${fmt(r.at)}（${r.where === 'camp' ? 'キャンプ' : '迷宮の中'}。全部で ${st.rings} 回）`, `Last rang the bell: ${fmt(r.at)} (${r.where === 'camp' ? 'at camp' : 'in the dungeon'}; ${st.rings} in all)`);
}

/** 呼び鈴を鳴らせなかったかもしれないときの文 */
export function kgBlockedText(name: string): string {
  return tr(`${name}の呼び鈴を、鳴らせなかったかもしれない。ブラウザは、人の操作なしに、この種類のリンクを開くのを止めることがある。「今、鳴らす」を押す。ブラウザが開くか尋ねたら、この種類のリンクを開くのを、いつも許す、にする。`,
    `${name}'s bell may not have rung. Browsers can stop pages from opening this kind of link without a person's action. Press "Ring now". If the browser asks, choose to always allow this kind of link.`);
}

/** 始める窓の説明（2〜3 行） */
export function kgExplainLines(name: string): string[] {
  return [
    tr('このアプリのタブを開いている間だけ動く（どの画面にいてもよい。タブを全部閉じたら止まり、次に開いても、自動では再開しない）。', 'It works only while a tab of this app is open (any screen will do; closing every tab stops it, and it does not restart by itself).'),
    tr(`${name}が黙ったら、呼び鈴を鳴らす（キャンプで 30 秒・迷宮の中で 5 分）。鳴らすたびに、AI の利用枠を使う。`, `When ${name} goes quiet, it rings the bell (30 s at camp, 5 min in the dungeon). Each ring uses your AI's quota.`),
    tr(`止まる: 回数に達した・倒れた・予算を使い切った・シーズンが終わった・握る項目ができた・呼び鈴を「使わない」にした・同じキャンプで ${KG.CAMP_RINGS_MAX} 回鳴らしても起きない・「止める」。今、迷宮の中なら、その遠征も 1 回に数える。`, `It stops when: the count is reached, they fall, the budget runs out, the season ends, something becomes held, the bell is set to Off, ${KG.CAMP_RINGS_MAX} rings at one camp do not wake them, or you press Stop. An expedition under way now counts as one.`),
  ];
}

// ---- このブラウザに覚える所 ----

const KEY = 'keepGoing';
const TABS = 'keepGoing.tabs';
const LAUNCH = 'keepGoing.launch';
const INPUT = 'keepGoing.input';

const listeners = new Set<() => void>();
/** 状態が変わったら呼ぶ（同じタブ。ほかのタブの変更は storage の知らせで） */
export function kgSubscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify(): void {
  for (const cb of [...listeners]) cb();
}

function isState(v: unknown): v is KgState {
  const s = v as KgState;
  return !!s && typeof s === 'object' && s.v === 1 && typeof s.runId === 'string' && (s.status === 'running' || s.status === 'stopped') && typeof s.total === 'number' && typeof s.startEnded === 'number';
}

/** 覚えてある状態（ランの ID ごと。読めないものは捨てる） */
export function kgReadAll(): Record<string, KgState> {
  try {
    const v = JSON.parse(getPref(KEY, '{}')) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: Record<string, KgState> = {};
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) if (isState(s) && s.runId === k) out[k] = { ...s, log: Array.isArray(s.log) ? s.log : [] };
    return out;
  } catch {
    return {};
  }
}

export function kgRead(runId: string): KgState | null {
  return kgReadAll()[runId] ?? null;
}

export function kgWrite(st: KgState): void {
  const all = kgReadAll();
  all[st.runId] = st;
  setPref(KEY, JSON.stringify(all));
  notify();
}

/** 止まった札を片づける（「閉じる」） */
export function kgForget(runId: string): void {
  const all = kgReadAll();
  if (!(runId in all)) return;
  delete all[runId];
  setPref(KEY, JSON.stringify(all));
  notify();
}

export function kgReadTabs(): KgTabs {
  try {
    const v = JSON.parse(getPref(TABS, '{}')) as unknown;
    return v && typeof v === 'object' ? (v as KgTabs) : {};
  } catch {
    return {};
  }
}
export function kgWriteTabs(t: KgTabs): void {
  setPref(TABS, JSON.stringify(t));
}

const num = (k: string): number | null => {
  const n = Number(getPref(k, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
export const kgLastLaunch = (): number | null => num(LAUNCH);
export const kgNoteLaunch = (now: number): void => setPref(LAUNCH, String(now));
export const kgLastInput = (): number | null => num(INPUT);
export const kgNoteInput = (now: number): void => setPref(INPUT, String(now));

/** 呼び鈴の文字列に添える進め方（一覧の行から） */
export function kgPace(row: KgRow | null): OwnerPace | null {
  return row?.pace === 'pilot' ? 'pilot' : null;
}

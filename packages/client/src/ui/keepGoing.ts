// 続けて遊ばせる（S14。SEASON.md §65.2・§65.4 の 1 と 3。画面だけ）: 持ち主が、拠点の札から、限り（遠征をあと N 回）を決めて始める。
// このアプリのタブが開いている間だけ、ブラウザが、決まった時に、呼び鈴（ui/bell.ts。この PC の受け口へ、ID と、決まった 1 語と、合言葉だけ）を送る。サーバーは、何もしない。
// S15（SEASON.md §68.2 の 1）: 呼び鈴は受け口の 1 つだけ（人の操作が要らない）。リンクの鳴らし方に伴う「鳴らす時が来たら、光らせて、押してもらう」の流れは、外した。
// ここは、決める所（いつ鳴らすか・止まるか・数え方・2 つのタブのどちらが鳴らすか）と、このブラウザに覚える状態だけ。時刻は外から渡す（テストする）。
// 鳴らす役（ui/KeepGoingRunner.tsx。アプリの根）と、拠点の札（screens/Lobby.tsx・ui/keepGoingUi.tsx）が、同じ状態を読む。
// 覚える所は localStorage（ランの ID・残りの回数を決める値・始めたときの遠征の数・鳴らした回数と時刻）。鍵は覚えない（鍵は今までどおり ui/keys.ts）。
import type { OwnerPace, OwnerRunRow } from '@muse/shared';
import { getPref, setPref, tr } from '../util';
import { bellPortFailText } from './bell';

/** 決まり（§65.2）。時間はミリ秒 */
export const KG = {
  /**
   * キャンプで、AI の最後の呼び出しから、これだけたったら鳴らす（S14b: 30 秒 → 2 分。長いキャンプの観測を読んで考える間に、30 秒はふつうに超え、
   * 受ける道具が、同じ冒険に 2 つ目の AI を起こしうる）
   */
  CAMP_SILENT_MS: 120_000,
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
export type KgStopReason = 'done' | 'ended' | 'budget' | 'season_over' | 'by_owner' | 'held' | 'bell_off' | 'bell_setup' | 'not_owner' | 'no_wake' | 'tabs_closed';
const STOP_REASONS: readonly KgStopReason[] = ['done', 'ended', 'budget', 'season_over', 'by_owner', 'held', 'bell_off', 'bell_setup', 'not_owner', 'no_wake', 'tabs_closed'];
export type KgWhere = 'camp' | 'dungeon';

/** 鳴らした 1 回（failed: 受け口に送れなかった） */
export interface KgRing { at: number; where: KgWhere; failed?: true }

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
  /** ランが一覧に無かった回数（続けて） */
  missing: number;
  /** 最後に見た様子 */
  seen: { ended: number; where: KgWhere; at: number } | null;
  stop: { reason: KgStopReason; at: number } | null;
  /** 最後に見た、持ち主の希望（進め方）。pilot なら、呼び鈴の本文に mode=pilot（「もう一度鳴らす」でも同じ本文にするため） */
  pace?: OwnerPace | null;
  /** 受け口に送れなかった（S14a。そのポート）。次に送れるか、AI が起きたら消える */
  portFail?: { at: number; port: number } | null;
  /**
   * AI の最後の呼び出しが分からない（サーバーを起動し直した直後など）のを、鳴らす役が最初に見た時刻（S14b）。分からない間は、ここから黙っていると数える。
   * 分かるようになったら消える
   */
  unknownSince?: number | null;
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
    campKey: null, campRings: 0, dungeonRungFor: null, lastRingAt: null, rings: 0, log: [], missing: 0, seen: null, stop: null,
    pace: x.pace === 'pilot' ? 'pilot' : null, portFail: null, unknownSince: null,
  };
}

export function kgStopped(st: KgState, reason: KgStopReason, now: number): KgState {
  return { ...st, status: 'stopped', stop: { reason, at: now } };
}

/** 残りの回数（終わった遠征の数から） */
export function kgLeft(st: Pick<KgState, 'total' | 'startEnded'>, ended: number): number {
  return Math.max(0, st.total - Math.max(0, ended - st.startEnded));
}

/**
 * 札に「続けて遊ばせる」を出すか（§65.4 の 3）: start 出す／held 握っている項目がある（小さく、続けては呼ばない、と出す）／null 出さない。
 * 条件: 持ち主と認められている（一覧に行がある）・AI の冒険者・続きを遊べる・握っている項目が無い・呼び鈴の設定が「この PC の受け口を呼ぶ」
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
 * 鳴らす: キャンプで AI の最後の呼び出しから 2 分（S14b。同じキャンプで 2 分おきに 3 回まで）・迷宮の中で 5 分（同じ遠征で 1 回）。AI が待っている間は鳴らさない。
 * AI の最後の呼び出しが分からない（サーバーを起動し直した直後など）ときは、それを最初に見た時から数える（S14b。すぐには鳴らさない）。
 * bellSetup（S14b）: 呼び鈴の設定に違う所がある（覚えた合言葉・ポートの形が違う）。鳴らさずに止める（「呼び鈴の設定を見直す」）
 */
export function kgStep(st: KgState, obs: KgObs, ctx: { now: number; bellOn: boolean; bellSetup?: boolean }): { state: KgState; ring: KgWhere | null } {
  const now = ctx.now;
  const none = (s: KgState) => ({ state: s, ring: null });
  if (st.status !== 'running') return none(st);
  if (!ctx.bellOn) return none(kgStopped(st, 'bell_off', now));
  if (ctx.bellSetup) return none(kgStopped(st, 'bell_setup', now));
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
  // AI の最後の呼び出し（分からなければ、分からないのを最初に見た時から数える）
  const ago = row.ai?.lastCallAgoS;
  const known = typeof ago === 'number' && Number.isFinite(ago);
  s = { ...s, unknownSince: known ? null : s.unknownSince ?? now };
  const silent = known ? Math.max(0, ago) * 1000 : now - (s.unknownSince ?? now);
  // AI が、今、呼び出している・待っている（または、鳴らした後に呼び出した）: 起きている。受け口に送れなかった知らせは消す
  if (s.portFail && (s.lastRingAt === null || silent < now - s.lastRingAt)) s = { ...s, portFail: null };
  if (row.ai?.waitingNow) return none(s);
  const cooled = s.lastRingAt === null || now - s.lastRingAt >= KG.RING_COOLDOWN_MS;
  if (where === 'camp') {
    if (s.campKey !== ended) s = { ...s, campKey: ended, campRings: 0, portFail: null };
    if (silent < KG.CAMP_SILENT_MS) return none(s);
    const sinceRing = s.campRings > 0 && s.lastRingAt !== null ? now - s.lastRingAt : Number.POSITIVE_INFINITY;
    if (s.campRings >= KG.CAMP_RINGS_MAX) return none(sinceRing >= KG.CAMP_RING_GAP_MS ? kgStopped(s, 'no_wake', now) : s);
    if (sinceRing < KG.CAMP_RING_GAP_MS || !cooled) return none(s);
    return { state: { ...s, campRings: s.campRings + 1 }, ring: 'camp' };
  }
  if (silent < KG.DUNGEON_SILENT_MS || s.dungeonRungFor === ended || !cooled) return none(s);
  return { state: { ...s, dungeonRungFor: ended }, ring: 'dungeon' };
}

/** 鳴らしたことを覚える */
export function kgRang(st: KgState, where: KgWhere, now: number): KgState {
  return { ...st, lastRingAt: now, rings: st.rings + 1, log: [...st.log, { at: now, where }].slice(-5) };
}

/** 受け口に送れなかった（S14a）: 最後の記録に印を付け、札と下の帯に「受け口が、動いていない」 */
export function kgPortFailed(st: KgState, port: number, now: number): KgState {
  const log = st.log.length ? [...st.log.slice(0, -1), { ...st.log[st.log.length - 1], failed: true as const }] : st.log;
  return { ...st, log, portFail: { at: now, port } };
}

/** 受け口に送れた（S14a）: 送れなかった知らせを消す */
export function kgPortOk(st: KgState): KgState {
  return st.portFail ? { ...st, portFail: null } : st;
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

/** 1 回の様子見の初め（鳴らす役の受け渡し）: 自分の印を今にし（古い印は捨てる）、自分が鳴らす役か */
export function kgHeartbeat(tabs: KgTabs, me: string, now: number): { tabs: KgTabs; leader: boolean } {
  const next = kgBeat(tabs, me, now);
  return { tabs: next, leader: kgLeader(next, now) === me };
}

/** タブを閉じる・読み直す（pagehide）: 自分の印を外す（ほかのタブが、すぐに鳴らす役を引き継ぐ） */
export function kgLeave(tabs: KgTabs, me: string): KgTabs {
  const out = { ...tabs };
  delete out[me];
  return out;
}

/**
 * このタブの開き方（S14b）: reloadAt はこのタブ（sessionStorage）が閉じる直前に覚えた時刻、type はブラウザの言う開き方
 * （`performance.getEntriesByType('navigation')[0].type`: reload・navigate・back_forward など。分からなければ null）
 */
export interface KgNav { reloadAt: number | null; type: string | null }

/**
 * タブを開いたとき（§65.4 の 3）: 動いている状態があるのに、ほかに生きているタブ（印が 90 秒より新しい）が無く、このタブの読み直しでもなければ、
 * タブを全部閉じたので止まった（自動では再開しない）。読み直しは、ブラウザが reload と言うときだけ（S14b: 閉じたタブをすぐ開き直す・
 * セッションの復元では、sessionStorage と、自分の古い印が残っていることがある）。tabs: 開く前の印。me: このタブの ID
 */
export function kgOnOpen(st: KgState, tabs: KgTabs, me: string, nav: KgNav, now: number): KgState {
  if (st.status !== 'running') return st;
  const alive = kgAlive(tabs, now, KG.TAB_OPEN_MS);
  if (alive.some((id) => id !== me)) return st;
  const reload = nav.type === 'reload' && (alive.includes(me) || (nav.reloadAt !== null && now - nav.reloadAt < KG.RELOAD_GRACE_MS));
  return reload ? st : kgStopped(st, 'tabs_closed', now);
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
    case 'bell_off': return tr('呼び鈴が「使わない」になった（運用の画面で、この PC の受け口を決める）。', 'The bell is now Off (set the receiver on this PC on the Operations screen).');
    case 'bell_setup': return tr('呼び鈴の設定を見直す（覚えた受け口のポートか合言葉の形が違うので、鳴らさなかった。運用の画面で、決め直す）。', 'Check the bell settings (the saved receiver port or passphrase is not valid, so it did not ring; set them again on the Operations screen).');
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

/** 鳴らし方の 1 行（札と窓）: この PC の受け口へ、自動で送る */
export function kgViaText(port?: number | null): string {
  return tr(`自動で鳴らす（この PC の受け口${port ? `、ポート ${port}` : ''}）。`, `Rings on its own (this PC's receiver${port ? `, port ${port}` : ''}).`);
}

/** 始める窓の説明（3 行） */
export function kgExplainLines(name: string, port?: number | null): string[] {
  return [
    tr('このアプリのタブを開いている間だけ動く（どの画面にいてもよい。タブを全部閉じたら止まり、次に開いても、自動では再開しない）。', 'It works only while a tab of this app is open (any screen will do; closing every tab stops it, and it does not restart by itself).'),
    tr(`${name}が黙ったら、呼び鈴を鳴らす（キャンプで 2 分・迷宮の中で 5 分）。${kgViaText(port)}鳴らすたびに、AI の利用枠を使う。`, `When ${name} goes quiet, it rings the bell (2 min at camp, 5 min in the dungeon). ${kgViaText(port)} Each ring uses your AI's quota.`),
    tr(`止まる: 回数に達した・倒れた・予算を使い切った・シーズンが終わった・握る項目ができた・呼び鈴を「使わない」にした・同じキャンプで ${KG.CAMP_RINGS_MAX} 回鳴らしても起きない・「止める」。今、迷宮の中なら、その遠征も 1 回に数える。`, `It stops when: the count is reached, they fall, the budget runs out, the season ends, something becomes held, the bell is set to Off, ${KG.CAMP_RINGS_MAX} rings at one camp do not wake them, or you press Stop. An expedition under way now counts as one.`),
  ];
}

/** 受け口に送れなかったときの文（S14a。札と下の帯） */
export function kgPortFailText(name: string, port: number): string {
  return tr(`${name}の呼び鈴を、受け口に送れなかった。${bellPortFailText(port)}。受ける道具を起こしてから、「もう一度鳴らす」。`,
    `${name}'s bell did not reach the receiver. ${bellPortFailText(port)}. Start your receiving tool, then press "Ring again".`);
}

// ---- このブラウザに覚える所 ----

const KEY = 'keepGoing';
const TABS = 'keepGoing.tabs';

const listeners = new Set<() => void>();
/** 状態が変わったら呼ぶ（同じタブ。ほかのタブの変更は storage の知らせで） */
export function kgSubscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function notify(): void {
  for (const cb of [...listeners]) cb();
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 知らない形 */
class Bad extends Error {}
/** 0 以上の整数（有限の数でなければ、知らない形） */
function nat(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Bad();
  return Math.max(0, Math.floor(v));
}
const natOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : nat(v));
const whereOf = (v: unknown): KgWhere => { if (v === 'camp' || v === 'dungeon') return v; throw new Bad(); };

/**
 * 覚えてある 1 つの状態を確かめて、整える（S14b: 書き換えられた値で、鳴り続けない）。total は 1〜10・campRings は 0〜3 の整数・
 * 時刻と数は 0 以上の整数・鳴らした記録は 5 つまで。知らない形（数でない・ID の形が違う・理由が無いもの など）は null（捨てる）。
 * 前の版が覚えた、リンクの鳴らし方の印（attention・maybeBlocked・via）は、読まずに捨てる（S15）
 */
export function kgSanitize(v: unknown, runId: string): KgState | null {
  try {
    const s = v as Record<string, unknown>;
    if (!s || typeof s !== 'object' || s.v !== 1 || s.runId !== runId || !ID_RE.test(runId)) return null;
    if (s.status !== 'running' && s.status !== 'stopped') return null;
    if (s.seasonId !== null && s.seasonId !== undefined && (typeof s.seasonId !== 'string' || !ID_RE.test(s.seasonId))) return null;
    if (typeof s.total !== 'number' || !Number.isFinite(s.total)) return null;
    const stop = s.stop === null || s.stop === undefined ? null : (() => {
      const x = s.stop as { reason?: unknown; at?: unknown };
      if (!STOP_REASONS.includes(x?.reason as KgStopReason)) throw new Bad();
      return { reason: x.reason as KgStopReason, at: nat(x.at) };
    })();
    if (s.status === 'stopped' && !stop) return null;
    const log = (Array.isArray(s.log) ? s.log : []).slice(-5).map((r) => {
      const x = r as Record<string, unknown>;
      return { at: nat(x?.at), where: whereOf(x?.where), ...(x?.failed === true ? { failed: true as const } : {}) };
    });
    const pf = s.portFail as { at?: unknown; port?: unknown } | null | undefined;
    const seen = s.seen as { ended?: unknown; where?: unknown; at?: unknown } | null | undefined;
    const port = pf ? nat(pf.port) : 0;
    return {
      v: 1, runId, seasonId: typeof s.seasonId === 'string' ? s.seasonId : null,
      name: typeof s.name === 'string' ? [...s.name].slice(0, 64).join('') : '',
      total: kgClampN(s.total), startEnded: nat(s.startEnded), startedAt: nat(s.startedAt), status: s.status,
      campKey: natOrNull(s.campKey), campRings: Math.min(KG.CAMP_RINGS_MAX, nat(s.campRings ?? 0)), dungeonRungFor: natOrNull(s.dungeonRungFor),
      lastRingAt: natOrNull(s.lastRingAt), rings: nat(s.rings ?? 0), log,
      missing: Math.min(KG.MISSING_MAX, nat(s.missing ?? 0)),
      seen: seen ? { ended: nat(seen.ended), where: whereOf(seen.where), at: nat(seen.at) } : null,
      stop,
      pace: s.pace === 'pilot' ? 'pilot' : null,
      portFail: pf && port >= 1024 && port <= 65535 ? { at: nat(pf.at), port } : null,
      unknownSince: natOrNull(s.unknownSince),
    };
  } catch {
    return null;
  }
}

/** 覚えてある状態（ランの ID ごと。確かめて整え、知らない形は捨てる） */
export function kgReadAll(): Record<string, KgState> {
  try {
    const v = JSON.parse(getPref(KEY, '{}')) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, KgState> = {};
    for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
      const ok = kgSanitize(s, k);
      if (ok) out[k] = ok;
    }
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

/** 呼び鈴の本文に添える進め方（一覧の行から） */
export function kgPace(row: KgRow | null): OwnerPace | null {
  return row?.pace === 'pilot' ? 'pilot' : null;
}

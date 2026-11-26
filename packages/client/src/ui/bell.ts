// 呼び鈴（S12b。SEASON.md §63.6）: 準備完了を押した人のブラウザが、決まった文字列 `musedungeon-bell://ready?season=<ID>&run=<ID>` を開く。
// S14（§65.4）: 持ち主の希望（進め方）が pilot のときは `&mode=pilot` を添える。「続けて遊ばせる」（ui/keepGoing.ts）の間も、同じ文字列を開く。
// S14a: 鳴らし方を、もう 1 つ。**この PC の受け口を呼ぶ**: `http://127.0.0.1:<ポート>/musedungeon-bell` へ、1 行の本文を POST する（応答は読まない）。
//   ブラウザは、外の道具のリンクを、人の操作なしでは続けて開かせない（Chromium 系は、操作の後に 1 回だけ）が、この形は、人の操作が要らない。
//   送り先の名前は、いつも 127.0.0.1（設定で変えられるのは、ポートだけ。ほかの名前・アドレスへは、送らない）。
// サーバーは何も変わらない（送り先も資格も持たず、何も実行しない）。受け取って、AI にどう知らせるかは、その PC の持ち主の道具が決める（ゲームでは用意しない）。
// 入れるのは、シーズンとランの 2 つの ID だけ（[A-Za-z0-9_-] だけであることを確かめてから。合わなければ鳴らさない）と、決まった 1 語（mode=pilot）と、
// 受け口の合言葉（設定の検査を通ったものだけ）。冒険者の名前・伝言など、だれかが決めた文は入れない（受ける道具と、その先の AI への、差し込みの口を作らない）。
// 設定は、このブラウザにだけ覚える（サーバーへ送らない）。文字列・本文を組む関数と、窓の文は、画面から離した関数（テストする）。
import type { OwnerPace } from '@muse/shared';
import { getPref, setPref, tr } from '../util';

/** 設定: 使わない（既定）・自分の道具を呼ぶ（リンク）・この PC の受け口を呼ぶ（S14a） */
export type BellMode = 'off' | 'tool' | 'port';
/** 設定の全部（port: 受け口のポート。key: 合言葉。どちらも検査を通ったものだけ。無ければ null） */
export interface BellConfig { mode: BellMode; port: number | null; key: string | null }
/** 鳴らし方（札と窓の文を変える）: link リンク・port 受け口 */
export type BellVia = 'link' | 'port';

const PREF = 'bell';
const PREF_PORT = 'bell.port';
const PREF_KEY = 'bell.key';

/** 受け口の送り先の名前（変えられない） */
export const BELL_HOST = '127.0.0.1';
/** 受け口の道 */
export const BELL_PATH = '/musedungeon-bell';
export const BELL_PORT_MIN = 1024;
export const BELL_PORT_MAX = 65535;

/** 受け口のポート: 1024〜65535 の整数 */
export function bellPortValid(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= BELL_PORT_MIN && n <= BELL_PORT_MAX;
}

/** 合言葉: 英数字と - _ で 8〜64 字 */
export function bellKeyValid(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(s);
}

const KEY_ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 乱数の合言葉（32 字。英数字と - _）。bytes はテストで差し替える（既定は crypto.getRandomValues） */
export function newBellKey(bytes?: Uint8Array): string {
  const b = bytes ?? crypto.getRandomValues(new Uint8Array(32));
  let out = '';
  for (let i = 0; i < 32; i++) out += KEY_ABC[(b[i % b.length] ?? 0) & 63];
  return out;
}

export function readBellConfig(): BellConfig {
  const m = getPref(PREF, 'off');
  const port = Number(getPref(PREF_PORT, ''));
  const key = getPref(PREF_KEY, '');
  return { mode: m === 'tool' || m === 'port' ? m : 'off', port: bellPortValid(port) ? port : null, key: bellKeyValid(key) ? key : null };
}

/** 設定を覚える（検査を通らないポート・合言葉は覚えない） */
export function saveBellConfig(c: BellConfig): void {
  setPref(PREF, c.mode);
  setPref(PREF_PORT, bellPortValid(c.port) ? String(c.port) : '');
  setPref(PREF_KEY, bellKeyValid(c.key) ? c.key : '');
}

/** 今の鳴らし方（受け口の設定でポートが決まっていなければ、使わないと同じ） */
export function readBell(): BellMode {
  return bellMode(readBellConfig());
}
export function bellMode(c: BellConfig): BellMode {
  return c.mode === 'port' && c.port === null ? 'off' : c.mode;
}

export function saveBell(mode: BellMode): void {
  setPref(PREF, mode);
}

/** 呼び鈴の文字列に入れてよい ID（シーズン・ラン） */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface BellIds { season: string | null | undefined; run: string; pace?: OwnerPace | null }

function idsOk(ids: BellIds): boolean {
  return ID_RE.test(ids.run) && (ids.season === null || ids.season === undefined || ID_RE.test(ids.season));
}

/**
 * 呼び鈴の文字列（自分の道具を呼ぶ）。使わない・ID の形が違う（入れられない文字がある）ときは null（鳴らさない）。
 * シーズンでない冒険（season が null）は season を省く（`musedungeon-bell://ready?run=<ID>`）。
 * pace（S14。SEASON.md §65.4 の 2）: 持ち主の希望（進め方）が pilot のときだけ、決まった 1 語 `&mode=pilot` を添える（self・無いときは、今までと同じ文字列）
 */
export function bellUrl(mode: BellMode, ids: BellIds): string | null {
  if (mode !== 'tool' || !idsOk(ids)) return null;
  const base = ids.season ? `musedungeon-bell://ready?season=${ids.season}&run=${ids.run}` : `musedungeon-bell://ready?run=${ids.run}`;
  return ids.pace === 'pilot' ? `${base}&mode=pilot` : base;
}

/**
 * 受け口に送る本文（S14a）: 1 行の `season=<ID>&run=<ID>[&mode=pilot][&key=<合言葉>]`（シーズンでない冒険は run= から）。
 * ID・合言葉の形が違えば null（送らない）
 */
export function bellBody(ids: BellIds, key: string | null | undefined): string | null {
  if (!idsOk(ids)) return null;
  if (key !== null && key !== undefined && !bellKeyValid(key)) return null;
  return [ids.season ? `season=${ids.season}` : '', `run=${ids.run}`, ids.pace === 'pilot' ? 'mode=pilot' : '', key ? `key=${key}` : ''].filter(Boolean).join('&');
}

/** 受け口に送る要求（送り先は、いつも 127.0.0.1。応答は読まない） */
export interface BellPortRequest { port: number; url: string; init: RequestInit }

export function bellPortRequest(c: BellConfig, ids: BellIds): BellPortRequest | null {
  if (c.mode !== 'port' || !bellPortValid(c.port)) return null;
  const body = bellBody(ids, c.key);
  if (body === null) return null;
  return {
    port: c.port,
    url: `http://${BELL_HOST}:${c.port}${BELL_PATH}`,
    init: { method: 'POST', mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain' }, body },
  };
}

/** 鳴らすもの: リンク（開く文字列）か、受け口（送る要求）。鳴らさないなら null */
export type BellRing = { via: 'link'; url: string } | ({ via: 'port' } & BellPortRequest);

export function bellRingOf(c: BellConfig, ids: BellIds): BellRing | null {
  if (c.mode === 'tool') { const url = bellUrl('tool', ids); return url ? { via: 'link', url } : null; }
  if (c.mode === 'port') { const r = bellPortRequest(c, ids); return r ? { via: 'port', ...r } : null; }
  return null;
}

/** 受け口に送る（応答は読まない。つながらなければ false。10 秒で応答が無ければ、届いたとみなす）。f はテストで差し替える */
export async function ringPort(r: BellPortRequest, f: typeof fetch = fetch): Promise<boolean> {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  const timer = ctl ? setTimeout(() => { timedOut = true; ctl.abort(); }, 10_000) : null;
  try {
    await f(r.url, { ...r.init, ...(ctl ? { signal: ctl.signal } : {}) });
    return true;
  } catch {
    return timedOut;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 受け口に送れなかったときの 1 行 */
export function bellPortFailText(port: number): string {
  return tr(`受け口が、動いていない（ポート ${port}）`, `The receiver is not running (port ${port})`);
}

/** 準備完了の後の窓の、呼び鈴のボタンと 1 行。出さないなら null（使わない・AI がもう待っている・鳴らせない） */
export interface BellView {
  /** ボタンの文 */
  label: string;
  /** 鳴らしたときの 1 行（まだなら null） */
  note: string | null;
  /** 既定のボタンにする（まだ鳴らしていないとき・受け口に送れなかったとき） */
  primary: boolean;
}

/**
 * rung: この窓で鳴らした回数（準備完了を押した流れの中で、ブラウザが許して自動で鳴らしたら 1。受け口は、送れたら 1）。
 * まだなら「呼び鈴を鳴らす」（既定のボタン）、鳴らした後は「鳴らした」と「もう一度鳴らす」。
 * failedPort（S14a）: 受け口に送れなかった（そのポート）。「受け口が、動いていない」と「もう一度鳴らす」（既定のボタン）
 */
export function bellView(x: { url: string | null; aiWaiting: boolean; rung: number; failedPort?: number | null }): BellView | null {
  if (!x.url || x.aiWaiting) return null;
  if (x.failedPort !== null && x.failedPort !== undefined) return { label: tr('もう一度鳴らす', 'Ring again'), note: bellPortFailText(x.failedPort), primary: true };
  if (x.rung <= 0) return { label: tr('呼び鈴を鳴らす', 'Ring the bell'), note: null, primary: true };
  return { label: tr('もう一度鳴らす', 'Ring again'), note: tr('呼び鈴を鳴らした（受ける道具が、知らせる）', 'Rang the bell (your receiving tool passes it on)'), primary: false };
}

/**
 * ブラウザが、今、外の道具を開くのを許しそうか（押した直後のひととき: navigator.userActivation）。分からないブラウザでは、試す。
 * 許されないときは、自動では鳴らさない（窓のボタンで鳴らす）
 */
export function bellAllowedNow(): boolean {
  try {
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return ua ? ua.isActive : true;
  } catch {
    return false;
  }
}

/** 鳴らす（文字列を開く。受ける道具が無ければ、ブラウザは何もしないか、知らせを出す）。試せたら true */
export function ringBell(url: string): boolean {
  try {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener noreferrer';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return true;
  } catch {
    return false;
  }
}

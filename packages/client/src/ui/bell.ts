// 呼び鈴（S12b・S14a。SEASON.md §63.6・§65.4）: 準備完了を押した人のブラウザが、この PC の受け口（`http://127.0.0.1:<ポート>/musedungeon-bell`）へ、
// 1 行の本文を POST する（応答は読まない）。人の操作は要らない。送り先の名前は、いつも 127.0.0.1（設定で変えられるのは、ポートだけ。ほかの名前・アドレスへは、送らない）。
// S15（SEASON.md §68.2 の 1）: 鳴らし方を、受け口の 1 つに絞った（リンク `musedungeon-bell://…` を開く鳴らし方と、「鳴らす時が来たら、押してもらう」の流れは、外した）。
//   前に「自分の道具を呼ぶ（リンク）」を覚えていたブラウザは、「使わない」として読む（設定の画面に 1 行、そう出す）。
// S14（§65.4）: 持ち主の希望（進め方）が pilot のときは `mode=pilot` を添える。「続けて遊ばせる」（ui/keepGoing.ts）の間も、同じ本文を送る。
// サーバーは何も変わらない（送り先も資格も持たず、何も実行しない）。受け取って、AI にどう知らせるかは、その PC の持ち主の道具が決める（ゲームでは用意しない）。
// 入れるのは、シーズンとランの 2 つの ID だけ（[A-Za-z0-9_-] だけであることを確かめてから。合わなければ鳴らさない）と、決まった 1 語（mode=pilot）と、
// 受け口の合言葉（設定の検査を通ったものだけ）。冒険者の名前・伝言など、だれかが決めた文は入れない（受ける道具と、その先の AI への、差し込みの口を作らない）。
// 設定は、このブラウザにだけ覚える（サーバーへ送らない）。本文を組む関数と、窓の文は、画面から離した関数（テストする）。
import type { OwnerPace } from '@muse/shared';
import { getPref, setPref, tr } from '../util';

/** 設定: 使わない（既定）・この PC の受け口を呼ぶ */
export type BellMode = 'off' | 'port';
/**
 * 設定の全部（port: 受け口のポート。key: 合言葉。どちらも検査を通ったものだけ。無ければ null）。
 * bad（S14b）: 覚えてあるポートか合言葉が、形の検査を通らない（書き換えられた など）。受け口の設定では鳴らさず、「呼び鈴の設定を見直す」と出す。
 * legacyLink（S15）: 前の版で「自分の道具を呼ぶ（リンク）」を覚えていた（今は「使わない」として読む）
 */
export interface BellConfig { mode: BellMode; port: number | null; key: string | null; bad?: 'port' | 'key'; legacyLink?: true }

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

/** ポートの文字（入力の欄と、覚えた値で同じ読み方: 数字だけで、範囲の中）。読めなければ null */
export function bellPortParse(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return bellPortValid(n) ? n : null;
}

export function readBellConfig(): BellConfig {
  const m = getPref(PREF, 'off');
  // 前の版のリンク（'tool'）は、使わないとして読む（S15）
  const mode: BellMode = m === 'port' ? 'port' : 'off';
  const portText = getPref(PREF_PORT, '');
  const keyText = getPref(PREF_KEY, '');
  const port = bellPortParse(portText);
  const key = bellKeyValid(keyText) ? keyText : null;
  // 覚えてある値が、形の検査を通らない（空は「無い」で、合言葉は任意）
  const bad = mode === 'port' ? (port === null ? 'port' as const : keyText && key === null ? 'key' as const : undefined) : undefined;
  return { mode, port, key, ...(bad ? { bad } : {}), ...(m === 'tool' ? { legacyLink: true as const } : {}) };
}

/** 受け口の設定に足りない・違う所があるときの 1 行（S14b。無ければ null） */
export function bellProblem(c: BellConfig): string | null {
  if (c.mode !== 'port' || !c.bad) return null;
  return c.bad === 'key'
    ? tr('呼び鈴の設定を見直す（覚えた合言葉の形が違う。運用の画面で、決め直す）', 'Check the bell settings (the saved passphrase is not valid; set it again on the Operations screen)')
    : tr('呼び鈴の設定を見直す（受け口のポートが決まっていない。運用の画面で、決める）', 'Check the bell settings (the receiver port is not set; set it on the Operations screen)');
}

/** 前の版でリンクの鳴らし方を選んでいたときの 1 行（S15。設定の画面に出す。無ければ null） */
export function bellLegacyNote(c: BellConfig): string | null {
  if (!c.legacyLink || c.mode !== 'off') return null;
  return tr('前に選んでいた「自分の道具を呼ぶ（リンク）」は、なくなった。今は「使わない」になっている。鳴らすなら、「この PC の受け口を呼ぶ」にする。',
    'The "Call your own tool (link)" you chose before is gone; the bell is now Off. To ring, choose "Call a receiver on this PC".');
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

/** 呼び鈴を使う設定か（「使わない」でない。設定に違う所があっても true: 鳴らす時に「見直す」と出す） */
export function bellOn(c: BellConfig): boolean {
  return c.mode !== 'off';
}

/** 呼び鈴の本文に入れてよい ID（シーズン・ラン） */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface BellIds { season: string | null | undefined; run: string; pace?: OwnerPace | null }

function idsOk(ids: BellIds): boolean {
  return ID_RE.test(ids.run) && (ids.season === null || ids.season === undefined || ID_RE.test(ids.season));
}

/**
 * 受け口に送る本文（S14a）: 1 行の `season=<ID>&run=<ID>[&mode=pilot][&key=<合言葉>]`（シーズンでない冒険は run= から）。
 * pace（S14。SEASON.md §65.4 の 2）: 持ち主の希望（進め方）が pilot のときだけ、決まった 1 語 `mode=pilot` を添える。
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
  // 覚えた合言葉・ポートの形が違う（S14b）: 合言葉なしで送らない。鳴らさない
  if (c.mode !== 'port' || c.bad || !bellPortValid(c.port)) return null;
  const body = bellBody(ids, c.key);
  if (body === null) return null;
  return {
    port: c.port,
    url: `http://${BELL_HOST}:${c.port}${BELL_PATH}`,
    init: { method: 'POST', mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain' }, body },
  };
}

/** 鳴らすもの（受け口に送る要求）。鳴らさないなら null */
export type BellRing = BellPortRequest;

export function bellRingOf(c: BellConfig, ids: BellIds): BellRing | null {
  return bellPortRequest(c, ids);
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
 * ring: 送る要求（使わない・ID の形が違うときは null）。rung: この窓で鳴らした回数（準備完了を押した流れの中で、受け口に送れたら 1）。
 * まだなら「呼び鈴を鳴らす」（既定のボタン）、鳴らした後は「鳴らした」と「もう一度鳴らす」。
 * failedPort（S14a）: 受け口に送れなかった（そのポート）。「受け口が、動いていない」と「もう一度鳴らす」（既定のボタン）
 */
export function bellView(x: { ring: BellRing | null; aiWaiting: boolean; rung: number; failedPort?: number | null }): BellView | null {
  if (!x.ring || x.aiWaiting) return null;
  if (x.failedPort !== null && x.failedPort !== undefined) return { label: tr('もう一度鳴らす', 'Ring again'), note: bellPortFailText(x.failedPort), primary: true };
  if (x.rung <= 0) return { label: tr('呼び鈴を鳴らす', 'Ring the bell'), note: null, primary: true };
  return { label: tr('もう一度鳴らす', 'Ring again'), note: tr('呼び鈴を鳴らした（受ける道具が、知らせる）', 'Rang the bell (your receiving tool passes it on)'), primary: false };
}

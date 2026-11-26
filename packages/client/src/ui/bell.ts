// 呼び鈴（S12b。SEASON.md §63.6）: 準備完了を押した人のブラウザが、決まった文字列 `musedungeon-bell://ready?season=<ID>&run=<ID>` を開く。
// サーバーは何も変わらない（送り先も資格も持たず、何も実行しない）。受け取って、AI にどう知らせるかは、その PC の持ち主の道具が決める（ゲームでは用意しない）。
// 入れるのは、シーズンとランの 2 つの ID だけ（[A-Za-z0-9_-] だけであることを確かめてから。合わなければ鳴らさない）。冒険者の名前・伝言など、
// だれかが決めた文は入れない（受ける道具と、その先の AI への、差し込みの口を作らない）。設定は、このブラウザにだけ覚える（サーバーへ送らない）。
// 文字列を組む関数と、窓の文は、画面から離した関数（テストする）。
import { getPref, setPref, tr } from '../util';

/** 設定: 使わない（既定）・自分の道具を呼ぶ */
export type BellMode = 'off' | 'tool';

const PREF = 'bell';

export function readBell(): BellMode {
  return getPref(PREF, 'off') === 'tool' ? 'tool' : 'off';
}

export function saveBell(mode: BellMode): void {
  setPref(PREF, mode);
}

/** 呼び鈴の文字列に入れてよい ID（シーズン・ラン） */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 呼び鈴の文字列（自分の道具を呼ぶ）。使わない・ID の形が違う（入れられない文字がある）ときは null（鳴らさない）。
 * シーズンでない冒険（season が null）は season を省く（`musedungeon-bell://ready?run=<ID>`）
 */
export function bellUrl(mode: BellMode, ids: { season: string | null | undefined; run: string }): string | null {
  if (mode !== 'tool') return null;
  if (!ID_RE.test(ids.run)) return null;
  if (ids.season !== null && ids.season !== undefined && !ID_RE.test(ids.season)) return null;
  return ids.season ? `musedungeon-bell://ready?season=${ids.season}&run=${ids.run}` : `musedungeon-bell://ready?run=${ids.run}`;
}

/** 準備完了の後の窓の、呼び鈴のボタンと 1 行。出さないなら null（使わない・AI がもう待っている・鳴らせない） */
export interface BellView {
  /** ボタンの文 */
  label: string;
  /** 鳴らしたときの 1 行（まだなら null） */
  note: string | null;
  /** 既定のボタンにする（まだ鳴らしていないとき） */
  primary: boolean;
}

/**
 * rung: この窓で鳴らした回数（準備完了を押した流れの中で、ブラウザが許して自動で鳴らしたら 1）。
 * まだなら「呼び鈴を鳴らす」（既定のボタン）、鳴らした後は「鳴らした」と「もう一度鳴らす」
 */
export function bellView(x: { url: string | null; aiWaiting: boolean; rung: number }): BellView | null {
  if (!x.url || x.aiWaiting) return null;
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

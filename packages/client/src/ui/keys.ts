// 冒険者の鍵（S10。SEASON.md §58.4）: このブラウザに覚えてあるプロフィールのトークン。画面・URL・console には出さない。
// 覚える場所は profileToken（S8b からの 1 つの欄）。前の版でシーズンごとに覚えた seasonToken.<id> も、今までどおり読む。
// S12b: 拠点で「自分で潜る」冒険者を足したとき、profileToken がもう使われていれば、ほかの鍵の並び（adventurerKeys。JSON の配列）に足す（今の鍵を上書きしない）。
import { getPref, prefNames, setPref } from '../util';

const EXTRA = 'adventurerKeys';

/** ほかの鍵の並び（読めなければ空） */
function extraKeys(): string[] {
  try {
    const v = JSON.parse(getPref(EXTRA, '[]')) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [];
  } catch {
    return [];
  }
}

/** このブラウザに覚えてある鍵（重ならないように）。seasonIds を省くと、覚えてあるシーズンの招きの鍵をすべて読む */
export function storedKeys(seasonIds?: readonly string[]): string[] {
  const ids = seasonIds ?? prefNames('seasonToken.').map((k) => k.slice('seasonToken.'.length));
  const toks = [getPref('profileToken', ''), ...ids.map((id) => getPref(`seasonToken.${id}`, '')), ...extraKeys()].filter(Boolean);
  return [...new Set(toks)];
}

/** 鍵を覚える（入れる欄から。profileToken に） */
export function keepKey(tok: string): void {
  setPref('profileToken', tok);
}

/**
 * 足した冒険者の鍵を覚える（S12b: 拠点で「自分で潜る」冒険者を足したとき）。profileToken が空なら、そこへ（今までと同じ場所）。
 * 別の鍵が入っていれば、上書きせずに、ほかの鍵の並びに足す（もう覚えてあれば、何もしない）
 */
export function addKey(tok: string): void {
  if (!tok || storedKeys().includes(tok)) return;
  if (!getPref('profileToken', '')) { setPref('profileToken', tok); return; }
  setPref(EXTRA, JSON.stringify([...extraKeys(), tok]));
}

/** 鍵をすべて外す（運用の画面から） */
export function forgetKeys(): void {
  setPref('profileToken', '');
  setPref(EXTRA, '[]');
  for (const k of prefNames('seasonToken.')) setPref(k, '');
}

// 冒険者の鍵（S10。SEASON.md §58.4）: このブラウザに覚えてあるプロフィールのトークン。画面・URL・console には出さない。
// 覚える場所は profileToken（S8b からの 1 つの欄）。前の版でシーズンごとに覚えた seasonToken.<id> も、今までどおり読む。
import { getPref, prefNames, setPref } from '../util';

/** このブラウザに覚えてある鍵（重ならないように）。seasonIds を省くと、覚えてあるシーズンの招きの鍵をすべて読む */
export function storedKeys(seasonIds?: readonly string[]): string[] {
  const ids = seasonIds ?? prefNames('seasonToken.').map((k) => k.slice('seasonToken.'.length));
  const toks = [getPref('profileToken', ''), ...ids.map((id) => getPref(`seasonToken.${id}`, ''))].filter(Boolean);
  return [...new Set(toks)];
}

/** 鍵を覚える（入れる欄から。profileToken に） */
export function keepKey(tok: string): void {
  setPref('profileToken', tok);
}

/** 鍵をすべて外す（運用の画面から） */
export function forgetKeys(): void {
  setPref('profileToken', '');
  for (const k of prefNames('seasonToken.')) setPref(k, '');
}

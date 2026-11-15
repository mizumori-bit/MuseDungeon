// クライアント共通のユーティリティ: UI 言語、localStorage（失敗しても動く）、トークン保管。
import type { Locale } from '@muse/shared';

function lsGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* プライベートモード等では保存しない */
  }
}

let uiLocale: Locale = lsGet('muse.locale') === 'en' ? 'en' : 'ja';

export function getLocale(): Locale {
  return uiLocale;
}

export function setLocale(l: Locale): void {
  uiLocale = l;
  lsSet('muse.locale', l);
}

/** UI ラベル（既定は日本語） */
export function tr(ja: string, en: string): string {
  return uiLocale === 'en' ? en : ja;
}

export interface StoredToken { token: string; playerId: string; name?: string }

function readTokens(): Record<string, StoredToken> {
  const raw = lsGet('muse.tokens');
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, StoredToken>) : {};
  } catch {
    return {};
  }
}

export function getToken(runId: string): StoredToken | null {
  return readTokens()[runId] ?? null;
}

export function saveToken(runId: string, t: StoredToken): void {
  const all = readTokens();
  all[runId] = t;
  lsSet('muse.tokens', JSON.stringify(all));
}

export function getPref(key: string, def: string): string {
  return lsGet(`muse.pref.${key}`) ?? def;
}

export function setPref(key: string, value: string): void {
  lsSet(`muse.pref.${key}`, value);
}

export function navigate(hash: string): void {
  window.location.hash = hash;
}

export function fmtTime(ms: number): string {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

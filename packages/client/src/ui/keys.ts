// 冒険者の鍵（S10。SEASON.md §58.4）: このブラウザに覚えてあるプロフィールのトークン。画面・URL・console には出さない。
// 覚える場所は profileToken（S8b からの 1 つの欄）。前の版でシーズンごとに覚えた seasonToken.<id> も、今までどおり読む。
// S12b: 拠点で「自分で潜る」冒険者を足したとき、profileToken がもう使われていれば、ほかの鍵の並び（adventurerKeys。JSON の配列）に足す（今の鍵を上書きしない）。
import { api } from '../api';
import { getPref, prefNames, setPref } from '../util';

const EXTRA = 'adventurerKeys';
/** ランの ID → そのランの冒険者の鍵（見つけたもの。読み直しのたびに問い合わせない） */
const runKeys = new Map<string, string>();

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
  runKeys.clear();
}

/**
 * このブラウザの「自分のプロフィール」の鍵（シーズンでない新しいラン・記録のタブの記録と称号）。profileToken。無ければ ''。
 * 冒険者の札・支度・観戦・キャンプの記録の 1 行は、そのランの鍵（keyForRun）を使う（S12c: 別の冒険者の鍵を渡さない）
 */
export function primaryKey(): string {
  return getPref('profileToken', '');
}

/**
 * 「新しいプロフィールにする」（S12c）: profileToken を空にする。今の鍵は捨てずに、ほかの鍵の並びへ移す（拠点の冒険者の鍵として残る。
 * 外すのは、運用の画面の「鍵を外す」）。鍵は、ほかから作り直せないので、黙って捨てない
 */
export function retireMainKey(): void {
  const cur = getPref('profileToken', '');
  if (!cur) return;
  setPref('profileToken', '');
  if (!extraKeys().includes(cur)) setPref(EXTRA, JSON.stringify([...extraKeys(), cur]));
}

/**
 * そのランの冒険者の鍵（S12c）: 覚えてある鍵の全部から、持ち主の口の一覧で、そのランを自分のもの（mine）として返す鍵を探す。
 * 無ければ undefined（同じ PC から開いているなら、鍵なしで足りる）。ask: 鍵ごとの問い合わせ（テストで差し替える）
 */
export async function keyForRun(runId: string, ask: (tok: string) => Promise<{ runs: { runId: string; mine?: boolean }[] }> = (t) => api.ownerRuns(t)): Promise<string | undefined> {
  const keys = storedKeys();
  const have = runKeys.get(runId);
  if (have && keys.includes(have)) return have;
  for (const t of keys) {
    try {
      const r = await ask(t);
      if (r.runs.some((x) => x.runId === runId && x.mine)) { runKeys.set(runId, t); return t; }
    } catch { /* 次の鍵 */ }
  }
  return undefined;
}

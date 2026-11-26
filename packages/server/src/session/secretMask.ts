// 考えの文などに書かれたトークンを伏せる（S17a。SEASON.md §70.6 の検査の E）。
// プレイヤーのトークンとプロフィールのトークンは、どちらも base64url の 24 字（randomBytes(18)）。サーバーは、プロフィールのトークンそのものは持たず、
// ハッシュ（sha256）だけを持つ（session/profiles.ts）。そこで、文の中の「base64url の 24 字」を拾い、知っているトークンか（プロフィールのハッシュと照らす・
// 動いているランのプレイヤーのトークンと比べる）を確かめて、知っているものだけ伏せる（ふつうの文は、そのまま）。
// その場の観戦（MCP の呼び出しの記録・俯瞰の考えの出来事）・見返し・巻き戻し（出来事・印・命令の記録）が、この 1 つの関数を使う。
import type { GameEvent } from '@muse/shared';

/** トークンの長さ（base64url の 24 字） */
export const TOKEN_CHARS = 24;
const RUN = /[A-Za-z0-9_-]{24,}/g;
const MASK = '••••';

/**
 * 1 つの文で、確かめる候補（24 字の窓）の数の上限（S17b）。確かめるたびに、ハッシュを計算するので、上限が無いと、長い base64url の並び 1 つ
 * （引数には、長さの上限の無いものがある。本文は 4MB まで受ける）で、サーバーが数秒止まる。越えた後の並びは、確かめずに、まるごと伏せる
 * （24 字以上の、区切りの無い英数字の並びが、1 つの文に、これだけ並ぶのは、人の読む文ではない）
 */
export const MASK_CHECKS_MAX = 64;

/**
 * 文の中の、知っているトークンを伏せる。isToken: その 24 字が、このサーバーの知っているトークンか。
 * 24 字より長い並び（区切りの無い所に書かれたトークン）は、24 字の窓を 1 つずつ確かめる（文 1 つにつき、MASK_CHECKS_MAX 回まで）
 */
export function maskTokensIn(s: string, isToken: (candidate: string) => boolean): string {
  return maskWith(s, isToken, { left: MASK_CHECKS_MAX });
}

/** 確かめる数の残り（1 つの文、か、1 つの値の全体で、共有する） */
interface MaskBudget { left: number }

function maskWith(s: string, isToken: (candidate: string) => boolean, budget: MaskBudget): string {
  if (s.length < TOKEN_CHARS) return s;
  return s.replace(RUN, (run) => {
    // 確かめ切れない並びは、まるごと伏せる
    if (run.length - TOKEN_CHARS + 1 > budget.left) { budget.left = 0; return MASK; }
    if (run.length === TOKEN_CHARS) { budget.left -= 1; return isToken(run) ? MASK : run; }
    const hits: string[] = [];
    for (let i = 0; i + TOKEN_CHARS <= run.length; i++) {
      const c = run.slice(i, i + TOKEN_CHARS);
      budget.left -= 1;
      if (isToken(c)) { hits.push(c); i += TOKEN_CHARS - 1; }
    }
    let out = run;
    for (const h of hits) out = out.split(h).join(MASK);
    return out;
  });
}

/**
 * 値の中の文字列を、どの深さでも伏せる（引数の記録など。深さ 6 まで）。確かめる数の上限は、値の全体で 1 つ（MASK_CHECKS_MAX の 4 倍。S17b:
 * 文字列ごとの上限だと、要素の多い配列で、ふくらむ）
 */
export function maskTokensDeep(v: unknown, isToken: (candidate: string) => boolean): unknown {
  return deep(v, isToken, { left: MASK_CHECKS_MAX * 4 }, 0);
}

function deep(v: unknown, isToken: (candidate: string) => boolean, budget: MaskBudget, depth: number): unknown {
  if (typeof v === 'string') return maskWith(v, isToken, budget);
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => deep(x, isToken, budget, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = deep(x, isToken, budget, depth + 1);
  return out;
}

/**
 * 考え（thought）と、話した文（chat。S17b）の出来事の文を伏せる（ほかの出来事は、そのまま）。
 * どちらも、World を変えない出来事（reducer は、何もしない）なので、文を伏せても、巻き戻しの畳み込みと hash は、変わらない
 */
export function maskThoughtEvent<E extends GameEvent>(ev: E, isToken: (candidate: string) => boolean): E {
  if (ev.type !== 'thought' && ev.type !== 'chat') return ev;
  const text = maskTokensIn(ev.text, isToken);
  return text === ev.text ? ev : { ...ev, text };
}

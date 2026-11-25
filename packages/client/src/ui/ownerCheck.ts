// 持ち主の枠の、決めていないもの（S9a。SEASON.md §57.3 の 2）と、準備完了の確かめ（S9 §58.1。S9a の出撃の確かめの窓を、「準備完了」のボタンへ移した）。
// 中身はサーバーが AI の観測と同じ関数で作ったもの（self.directive.undecided・一覧の行の undecided）だけを使う（持ち主に、プレイヤーより多くを見せない）。
import type { DirectiveUndecided } from '@muse/shared';
import { tr } from '../util';

/** 決めていないものの短い名前の並び（「次の遠征の目的」「特技（候補 3 つ）」「新しく持ち物に入った装備 2 品」）。無ければ空 */
export function undecidedParts(u: DirectiveUndecided | undefined | null, opts: { objective?: boolean } = {}): string[] {
  if (!u) return [];
  return [
    u.objective && opts.objective !== false ? tr('次の遠征の目的', 'the next expedition') : '',
    u.perk ? tr(`特技（Lv${u.perk.level} の候補 ${u.perk.options} つ${u.perk.more ? `。ほかに ${u.perk.more} 回分` : ''}）`, `a perk (Lv${u.perk.level}, ${u.perk.options} options${u.perk.more ? `; ${u.perk.more} more after it` : ''})`) : '',
    u.boon ? tr(`加護（地下${u.boon.depth}階の大守護者。候補 ${u.boon.options} つ）`, `a boon (warden of depth ${u.boon.depth}; ${u.boon.options} options)`) : '',
    u.gear ? tr(`新しく持ち物に入った装備 ${u.gear} 品`, `${u.gear} new piece${u.gear > 1 ? 's' : ''} of gear`) : '',
  ].filter(Boolean);
}

/** 枠の目立つ 1 行（「決めていないもの: 特技（候補 3 つ）・新しく持ち物に入った装備 2 品」）。無ければ null */
export function undecidedLine(u: DirectiveUndecided | undefined | null): string | null {
  const parts = undecidedParts(u);
  if (!parts.length) return null;
  return tr(`決めていないもの: ${parts.join('・')}`, `Not decided yet: ${parts.join(', ')}`);
}

/**
 * 「準備完了」を押したときに、確かめの窓を出すか（目的のほかに、決めていないものが残っているときだけ。目的は、選ばないと準備完了にできない）。
 * 出すなら、窓に並べる名前
 */
export function readyCheck(u: DirectiveUndecided | undefined | null): string[] | null {
  const parts = undecidedParts(u, { objective: false });
  return parts.length ? parts : null;
}

/** AI との行き来の 1 行（S9 §58.1: サーバーの控えから）。いま待っている・最後の呼び出しからの時間・このサーバーの起動の後に呼び出しが無い */
export function aiPresenceText(ai: { lastCallAgoS: number | null; waitingNow: boolean } | undefined | null): string | null {
  if (!ai) return null;
  if (ai.waitingNow) return tr('AI は、いま wait_for_turn で、あなたの支度を待っている', 'The AI is waiting for your preparations right now (wait_for_turn)');
  if (ai.lastCallAgoS === null) return tr('このサーバーが起動してから、AI の呼び出しは無い', 'No call from the AI since this server started');
  const s = ai.lastCallAgoS;
  const ago = s < 60 ? tr(`${s} 秒前`, `${s} s ago`) : s < 3600 ? tr(`${Math.floor(s / 60)} 分前`, `${Math.floor(s / 60)} min ago`) : tr(`${Math.floor(s / 3600)} 時間前`, `${Math.floor(s / 3600)} h ago`);
  return tr(`AI の最後の呼び出し: ${ago}`, `Last call from the AI: ${ago}`);
}

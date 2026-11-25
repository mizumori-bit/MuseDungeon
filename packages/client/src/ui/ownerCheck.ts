// 持ち主の枠の、決めていないもの（S9a。SEASON.md §57.3 の 2）: 目立つ 1 行と、出撃の確かめの窓を出すかどうか。
// 中身はサーバーが AI の観測と同じ関数で作ったもの（self.directive.undecided・一覧の行の undecided）だけを使う（持ち主に、プレイヤーより多くを見せない）。
import type { DirectiveUndecided } from '@muse/shared';
import { tr } from '../util';

/** 決めていないものの短い名前の並び（「特技（候補 3 つ）」「着けていない装備 2 品」）。無ければ空 */
export function undecidedParts(u: DirectiveUndecided | undefined | null): string[] {
  if (!u) return [];
  return [
    u.perk ? tr(`特技（Lv${u.perk.level} の候補 ${u.perk.options} つ${u.perk.more ? `。ほかに ${u.perk.more} 回分` : ''}）`, `a perk (Lv${u.perk.level}, ${u.perk.options} options${u.perk.more ? `; ${u.perk.more} more after it` : ''})`) : '',
    u.boon ? tr(`加護（地下${u.boon.depth}階の大守護者。候補 ${u.boon.options} つ）`, `a boon (warden of depth ${u.boon.depth}; ${u.boon.options} options)`) : '',
    u.gear ? tr(`着けていない装備 ${u.gear} 品`, `${u.gear} unworn piece${u.gear > 1 ? 's' : ''} of gear`) : '',
  ].filter(Boolean);
}

/**
 * 枠の目立つ 1 行（「決めていないもの: 特技（候補 3 つ）・着けていない装備 2 品」）。目的を握っていなければ、AI が待たずに出発することがあると添える。
 * 無ければ null
 */
export function undecidedLine(u: DirectiveUndecided | undefined | null, objectiveHeld: boolean): string | null {
  const parts = undecidedParts(u);
  if (!parts.length) return null;
  return tr(`決めていないもの: ${parts.join('・')}${objectiveHeld ? '' : '。AI は、待たずに出発することがある'}`,
    `Not decided yet: ${parts.join(', ')}${objectiveHeld ? '' : '. The AI may set out without waiting'}`);
}

/** 「この目的で出撃」を押したときに、確かめの窓を出すか（決めていないものが残っているときだけ）。出すなら、窓に並べる名前 */
export function departureCheck(u: DirectiveUndecided | undefined | null): string[] | null {
  const parts = undecidedParts(u);
  return parts.length ? parts : null;
}

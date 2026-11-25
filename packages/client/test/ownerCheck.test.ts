// 持ち主の枠の、決めていないもの（S9a。SEASON.md §57.3 の 2）: 目立つ 1 行と、出撃の確かめの窓を出す条件
import { describe, expect, it } from 'vitest';
import { departureCheck, undecidedLine, undecidedParts } from '../src/ui/ownerCheck';

describe('S9a §57.3 の 2: the owner card says what is undecided, and asks before starting', () => {
  it('no window and no line when nothing is undecided', () => {
    expect(departureCheck(undefined)).toBeNull();
    expect(departureCheck(null)).toBeNull();
    expect(departureCheck({ text: '' })).toBeNull();
    expect(undecidedLine(undefined, false)).toBeNull();
  });

  it('lists the undecided items; the line adds that the AI may set out when the objective is not held', () => {
    const u = { perk: { level: 2, options: 3, more: 0 }, gear: 2, text: '…' };
    expect(undecidedParts(u)).toEqual(['特技（Lv2 の候補 3 つ）', '着けていない装備 2 品']);
    expect(departureCheck(u)).toEqual(['特技（Lv2 の候補 3 つ）', '着けていない装備 2 品']);
    expect(undecidedLine(u, false)).toBe('決めていないもの: 特技（Lv2 の候補 3 つ）・着けていない装備 2 品。AI は、待たずに出発することがある');
    expect(undecidedLine(u, true)).toBe('決めていないもの: 特技（Lv2 の候補 3 つ）・着けていない装備 2 品');
    expect(departureCheck({ boon: { depth: 5, options: 3 }, text: '…' })).toEqual(['加護（地下5階の大守護者。候補 3 つ）']);
  });
});

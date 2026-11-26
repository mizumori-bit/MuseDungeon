// 持ち主の枠の、決めていないもの（S9a。SEASON.md §57.3 の 2）: 目立つ 1 行と、確かめの窓を出す条件。
// S9（§58.1）: 確かめの窓は「準備完了」のボタンへ移した（目的は、選ばないと準備完了にできないので、窓には並べない）。AI との行き来の 1 行
import { describe, expect, it } from 'vitest';
import { aiPresenceText, readyCheck, undecidedLine, undecidedParts } from '../src/ui/ownerCheck';

describe('S9a §57.3 の 2・S9 §58.1: the owner card says what is undecided, and asks before marking ready', () => {
  it('no window and no line when nothing is undecided', () => {
    expect(readyCheck(undefined)).toBeNull();
    expect(readyCheck(null)).toBeNull();
    expect(readyCheck({ text: '' })).toBeNull();
    expect(undecidedLine(undefined)).toBeNull();
    // 目的だけ: 行には出すが、窓は出さない（選ばないと準備完了にできない）
    expect(readyCheck({ objective: true, text: '' })).toBeNull();
    expect(undecidedLine({ objective: true, text: '' })).toBe('決めていないもの: 次の遠征の目的');
  });

  it('lists the undecided items', () => {
    const u = { perk: { level: 2, options: 3, more: 0 }, gear: 2, text: '…' };
    expect(undecidedParts(u)).toEqual(['特技（Lv2 の候補 3 つ）', '新しく持ち物に入った装備 2 品']);
    expect(readyCheck(u)).toEqual(['特技（Lv2 の候補 3 つ）', '新しく持ち物に入った装備 2 品']);
    expect(undecidedLine(u)).toBe('決めていないもの: 特技（Lv2 の候補 3 つ）・新しく持ち物に入った装備 2 品');
    expect(readyCheck({ objective: true, boon: { depth: 5, options: 3 }, text: '…' })).toEqual(['加護（地下5階の大守護者。候補 3 つ）']);
  });

  it('the AI presence line (from the server\'s memory)', () => {
    expect(aiPresenceText(undefined)).toBeNull();
    expect(aiPresenceText({ lastCallAgoS: null, waitingNow: false })).toBe('このサーバーが起動してから、AI の呼び出しは無い');
    expect(aiPresenceText({ lastCallAgoS: 5, waitingNow: true })).toBe('AIは、今、あなたの支度を待っている');
    // 画面の言葉（S11）: 冒険者の名前で
    expect(aiPresenceText({ lastCallAgoS: 5, waitingNow: true }, 'ミュゼ美')).toBe('ミュゼ美は、今、あなたの支度を待っている');
    expect(aiPresenceText({ lastCallAgoS: 42, waitingNow: false })).toBe('AI の最後の呼び出し: 42 秒前');
    expect(aiPresenceText({ lastCallAgoS: 180, waitingNow: false })).toBe('AI の最後の呼び出し: 3 分前');
    expect(aiPresenceText({ lastCallAgoS: 7300, waitingNow: false })).toBe('AI の最後の呼び出し: 2 時間前');
  });
});

// S18（SEASON.md §73.2 の 3）: 観戦の待っている間の札。キャンプでは「考えている」と言わない・迷宮の中で 2 分を越えたら「AI の応答を待っている」・
// 持ち主の支度が「まだ」なら「持ち主の支度を、待っている」・見返しの間は出さない
import { afterEach, describe, expect, it } from 'vitest';
import { callAtOf, THINK_LONG_MS, waitText } from '../src/ui/playback';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

const base = { connected: true, queued: false, active: true, agent: true, ownerPending: false, lastAgentAt: 10_000, countFrom: 0, now: 10_000 };

describe('S18 §73.2 の 3: the wait badge', () => {
  it('at camp: not "thinking"; the time since the last call (seconds under a minute, then minutes)', () => {
    const camp = { ...base, atCamp: true };
    expect(waitText({ ...camp, now: 12_000 })).toBeNull();
    expect(waitText({ ...camp, now: 52_500 })).toBe('キャンプにいる（AI の最後の呼び出し: 42 秒前）');
    expect(waitText({ ...camp, now: 10_000 + 3 * 60_000 + 5_000 })).toBe('キャンプにいる（AI の最後の呼び出し: 3 分前）');
    // 呼び出しの記録を 1 つも受けていない
    expect(waitText({ ...camp, lastAgentAt: null, countFrom: 0, now: 90_000 })).toBe('キャンプにいる（つないでから 1 分、AI の呼び出しは無い）');
    // つないだ（20 秒の時点）より前の呼び出しの記録（つないだときに届く直近の記録）: 札は、つないでから 5 秒たってから。時間は、呼び出しの時刻から
    expect(waitText({ ...camp, lastAgentAt: 10_000, countFrom: 20_000, now: 24_000 })).toBeNull();
    expect(waitText({ ...camp, lastAgentAt: 10_000, countFrom: 20_000, now: 40_000 })).toBe('キャンプにいる（AI の最後の呼び出し: 30 秒前）');
    setLocale('en');
    expect(waitText({ ...camp, now: 10_000 + 3 * 60_000 })).toBe('At camp (last call from the AI: 3 min ago)');
  });

  it('in the dungeon: "thinking… N s" up to 2 minutes, then "waiting for the AI"', () => {
    expect(waitText({ ...base, now: 10_000 + 30_000 })).toBe('考えている… 30 秒');
    expect(waitText({ ...base, now: 10_000 + THINK_LONG_MS })).toBe('考えている… 120 秒');
    expect(waitText({ ...base, now: 10_000 + THINK_LONG_MS + 1 })).toBe('AI の応答を待っている（最後の呼び出しから 2 分）');
    expect(waitText({ ...base, now: 10_000 + 7 * 60_000 })).toBe('AI の応答を待っている（最後の呼び出しから 7 分）');
    expect(waitText({ ...base, lastAgentAt: null, now: 10_000 + 7 * 60_000 })).toBe('AI の応答を待っている（つないでから 7 分）');
    // つないだばかりでも、最後の呼び出しが 2 分より前なら「考えている」と言わない
    expect(waitText({ ...base, lastAgentAt: 10_000, countFrom: 10_000 + 5 * 60_000, now: 10_000 + 5 * 60_000 + 6_000 })).toBe('AI の応答を待っている（最後の呼び出しから 5 分）');
    setLocale('en');
    expect(waitText({ ...base, now: 10_000 + 7 * 60_000 })).toBe('Waiting for the AI (7 min since its last call)');
  });

  it("the owner's preparations come first; nothing while looking back (S17)", () => {
    expect(waitText({ ...base, atCamp: true, ownerPending: true, now: 10_000 + 10 * 60_000 })).toBe('持ち主の支度を、待っている');
    expect(waitText({ ...base, atCamp: true, reviewing: true, now: 10_000 + 10 * 60_000 })).toBeNull();
    expect(waitText({ ...base, reviewing: true, now: 10_000 + 30_000 })).toBeNull();
    expect(waitText({ ...base, ownerPending: true, reviewing: true })).toBeNull();
  });
});

describe('S18: the time of a call record', () => {
  it('a record that arrives on connecting is dated by its own time, not by when it arrived', () => {
    expect(callAtOf(100_000, 1_000_000 - 90_000, 1_000_000)).toBe(10_000);
    // 時計がずれて未来の記録になっても、受けた時刻より後にはしない
    expect(callAtOf(100_000, 1_000_500, 1_000_000)).toBe(100_000);
    expect(callAtOf(100_000, undefined, 1_000_000)).toBe(100_000);
  });
});

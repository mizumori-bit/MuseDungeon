// S12b（SEASON.md §63.6）: 呼び鈴の文字列と、準備完了の後の窓のボタン。画面から離した関数のテスト。
// 入れるのは 2 つの ID だけ（[A-Za-z0-9_-] だけ。合わなければ鳴らさない）・使わない（既定）・AI がもう待っていれば出さない・日英
import { afterEach, describe, expect, it } from 'vitest';
import { bellAllowedNow, bellUrl, bellView, readBell } from '../src/ui/bell';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

describe('S12b §63.6: the bell string', () => {
  it('only the season and run IDs, in a fixed form', () => {
    expect(bellUrl('tool', { season: 's5', run: 'run_ab12cd' })).toBe('musedungeon-bell://ready?season=s5&run=run_ab12cd');
    expect(bellUrl('tool', { season: 'T-9_x', run: 'run_Z' })).toBe('musedungeon-bell://ready?season=T-9_x&run=run_Z');
    // シーズンでない冒険は season を省く
    expect(bellUrl('tool', { season: null, run: 'run_ab12cd' })).toBe('musedungeon-bell://ready?run=run_ab12cd');
    expect(bellUrl('tool', { season: undefined, run: 'run_ab12cd' })).toBe('musedungeon-bell://ready?run=run_ab12cd');
  });

  it('does not ring when an ID carries anything outside [A-Za-z0-9_-], or when the bell is off', () => {
    for (const bad of ['run_a&x=1', 'run a', 'run_a\n', 'run_a?', 'run_a#', 'run_a/..', '名前', 'run_a%20', '', 'r'.repeat(65), 'run_a=b', 'run_a;b']) {
      expect(bellUrl('tool', { season: 's5', run: bad })).toBeNull();
      expect(bellUrl('tool', { season: bad, run: 'run_ab12cd' })).toBeNull();
    }
    expect(bellUrl('off', { season: 's5', run: 'run_ab12cd' })).toBeNull();
    // 既定は使わない（このブラウザに何も覚えていない・読めない）
    expect(readBell()).toBe('off');
  });

  it('the button in the window after "Ready": ring (the default) → rang / ring again; none when off, invalid, or the AI is already waiting', () => {
    const url = 'musedungeon-bell://ready?season=s5&run=run_ab12cd';
    expect(bellView({ url, aiWaiting: false, rung: 0 })).toEqual({ label: '呼び鈴を鳴らす', note: null, primary: true });
    expect(bellView({ url, aiWaiting: false, rung: 1 })).toEqual({ label: 'もう一度鳴らす', note: '呼び鈴を鳴らした（受ける道具が、知らせる）', primary: false });
    expect(bellView({ url, aiWaiting: true, rung: 0 })).toBeNull();
    expect(bellView({ url: null, aiWaiting: false, rung: 0 })).toBeNull();
    setLocale('en');
    expect(bellView({ url, aiWaiting: false, rung: 0 })).toEqual({ label: 'Ring the bell', note: null, primary: true });
    expect(bellView({ url, aiWaiting: false, rung: 2 })).toEqual({ label: 'Ring again', note: 'Rang the bell (your receiving tool passes it on)', primary: false });
  });

  it('whether the browser lets it ring now: unknown browsers try', () => {
    // テストの環境（node）には navigator.userActivation が無い
    const g = globalThis as { navigator?: unknown };
    const had = Object.getOwnPropertyDescriptor(g, 'navigator');
    try {
      Object.defineProperty(g, 'navigator', { value: {}, configurable: true });
      expect(bellAllowedNow()).toBe(true);
      Object.defineProperty(g, 'navigator', { value: { userActivation: { isActive: false } }, configurable: true });
      expect(bellAllowedNow()).toBe(false);
      Object.defineProperty(g, 'navigator', { value: { userActivation: { isActive: true } }, configurable: true });
      expect(bellAllowedNow()).toBe(true);
    } finally {
      if (had) Object.defineProperty(g, 'navigator', had);
      else delete g.navigator;
    }
  });
});

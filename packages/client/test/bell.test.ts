// S12b（SEASON.md §63.6）・S15（§68.2 の 1）: 呼び鈴は、この PC の受け口の 1 つだけ。準備完了の後の窓のボタン。画面から離した関数のテスト。
// 使わない（既定）・前の版のリンクの設定は「使わない」として読む・AI がもう待っていれば出さない・日英
import { afterEach, describe, expect, it } from 'vitest';
import { bellLegacyNote, bellOn, bellPortRequest, bellRingOf, bellView, readBell, readBellConfig, type BellConfig } from '../src/ui/bell';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

const ids = { season: 's5', run: 'run_ab12cd' };

/** このブラウザの覚え（localStorage）を差し替えて fn を走らせる */
function withPrefs(prefs: Record<string, string>, fn: () => void): void {
  const g = globalThis as { window?: unknown };
  const had = Object.getOwnPropertyDescriptor(g, 'window');
  const mem = new Map<string, string>(Object.entries(prefs).map(([k, v]) => [`muse.pref.${k}`, v]));
  const ls = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
  try {
    Object.defineProperty(g, 'window', { value: { localStorage: ls }, configurable: true });
    fn();
  } finally {
    if (had) Object.defineProperty(g, 'window', had);
    else delete g.window;
  }
}

describe('S15 §68.2 の 1: one bell, the receiver on this PC', () => {
  it('off by default; a browser that kept the old link setting reads it as off, and the settings say so once', () => {
    // 既定は使わない（このブラウザに何も覚えていない・読めない）
    expect(readBell()).toBe('off');
    withPrefs({ bell: 'tool', 'bell.port': '47123', 'bell.key': '' }, () => {
      const c = readBellConfig();
      expect(c.mode).toBe('off');
      expect(c.legacyLink).toBe(true);
      expect(bellOn(c)).toBe(false);
      expect(bellRingOf(c, ids)).toBeNull();
      expect(bellLegacyNote(c)).toContain('「自分の道具を呼ぶ（リンク）」は、なくなった');
    });
    withPrefs({ bell: 'off' }, () => {
      expect(bellLegacyNote(readBellConfig())).toBeNull();
    });
    withPrefs({ bell: 'port', 'bell.port': '47123' }, () => {
      const c = readBellConfig();
      expect(c.legacyLink).toBeUndefined();
      expect(bellLegacyNote(c)).toBeNull();
      expect(bellRingOf(c, ids)?.url).toBe('http://127.0.0.1:47123/musedungeon-bell');
    });
    // 知らない設定の値も、使わない
    withPrefs({ bell: 'link', 'bell.port': '47123' }, () => expect(readBellConfig().mode).toBe('off'));
  });

  it('the button in the window after "Ready": ring (the default) → rang / ring again; none when off or the AI is already waiting', () => {
    const cfg: BellConfig = { mode: 'port', port: 47123, key: null };
    const ring = bellPortRequest(cfg, ids)!;
    expect(bellView({ ring, aiWaiting: false, rung: 0 })).toEqual({ label: '呼び鈴を鳴らす', note: null, primary: true });
    expect(bellView({ ring, aiWaiting: false, rung: 1 })).toEqual({ label: 'もう一度鳴らす', note: '呼び鈴を鳴らした（受ける道具が、知らせる）', primary: false });
    expect(bellView({ ring, aiWaiting: true, rung: 0 })).toBeNull();
    expect(bellView({ ring: null, aiWaiting: false, rung: 0 })).toBeNull();
    // 送れなかった: 「受け口が、動いていない」と「もう一度鳴らす」（残す知らせ）
    expect(bellView({ ring, aiWaiting: false, rung: 0, failedPort: 47123 })).toEqual({ label: 'もう一度鳴らす', note: '受け口が、動いていない（ポート 47123）', primary: true });
    setLocale('en');
    expect(bellView({ ring, aiWaiting: false, rung: 0 })).toEqual({ label: 'Ring the bell', note: null, primary: true });
    expect(bellView({ ring, aiWaiting: false, rung: 2 })).toEqual({ label: 'Ring again', note: 'Rang the bell (your receiving tool passes it on)', primary: false });
  });
});

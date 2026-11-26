// S14a（SEASON.md §65.4。呼び鈴の鳴らし方を、もう 1 つ）: この PC の受け口（http://127.0.0.1:<ポート>/musedungeon-bell）へ、1 行の本文を送る。
// ポートの範囲・合言葉の検査・本文の形・送り先が固定であること・つながらないときの文。画面から離した関数のテスト
import { afterEach, describe, expect, it } from 'vitest';
import { bellBody, bellKeyValid, bellMode, bellOn, bellPortFailText, bellPortParse, bellPortRequest, bellPortValid, bellProblem, bellRingOf, bellView, newBellKey, readBellConfig, ringPort, type BellConfig } from '../src/ui/bell';
import { bellPortDraft } from '../src/ui/bellSettings';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

const cfg = (o: Partial<BellConfig> = {}): BellConfig => ({ mode: 'port', port: 47123, key: 'Abc_def-12345678', ...o });
const ids = { season: 's5', run: 'run_ab12cd' };

describe('S14a: the receiver on this PC (POST to 127.0.0.1)', () => {
  it('the port is 1024-65535; the passphrase is 8-64 of [A-Za-z0-9_-]; a generated one passes', () => {
    for (const ok of [1024, 8080, 47123, 65535]) expect(bellPortValid(ok)).toBe(true);
    for (const bad of [0, 80, 1023, 65536, 7777.5, -1, NaN, '8080', null, undefined]) expect(bellPortValid(bad)).toBe(false);
    for (const ok of ['abcdefgh', 'A_b-1234', 'x'.repeat(64)]) expect(bellKeyValid(ok)).toBe(true);
    for (const bad of ['short', 'x'.repeat(65), 'has space1', 'あいうえおかきく', 'abc&key=1', 'abcdefg\n', '', null, 12345678]) expect(bellKeyValid(bad)).toBe(false);
    const k = newBellKey(new Uint8Array(Array.from({ length: 32 }, (_, i) => i * 37)));
    expect(k).toHaveLength(32);
    expect(bellKeyValid(k)).toBe(true);
    expect(bellKeyValid(newBellKey())).toBe(true);
    expect(newBellKey()).not.toBe(newBellKey());
    // 画面の入力の確かめ
    expect(bellPortDraft('47123', '')).toEqual({ ok: true, port: 47123, key: null });
    expect(bellPortDraft(' 47123 ', ' Abc_def-12345678 ')).toEqual({ ok: true, port: 47123, key: 'Abc_def-12345678' });
    expect(bellPortDraft('80', '').ok).toBe(false);
    expect(bellPortDraft('4.7e4', '').ok).toBe(false);
    expect(bellPortDraft('47123', 'short').ok).toBe(false);
  });

  it('the body is one line: season, run, mode=pilot, key; only checked IDs and keys', () => {
    expect(bellBody(ids, null)).toBe('season=s5&run=run_ab12cd');
    expect(bellBody({ ...ids, pace: 'pilot' }, 'Abc_def-12345678')).toBe('season=s5&run=run_ab12cd&mode=pilot&key=Abc_def-12345678');
    expect(bellBody({ season: null, run: 'run_ab12cd' }, 'Abc_def-12345678')).toBe('run=run_ab12cd&key=Abc_def-12345678');
    expect(bellBody({ ...ids, pace: 'self' }, undefined)).toBe('season=s5&run=run_ab12cd');
    expect(bellBody({ season: 's5', run: 'run_a&x=1' }, null)).toBeNull();
    expect(bellBody({ season: 's 5', run: 'run_ab12cd' }, null)).toBeNull();
    expect(bellBody(ids, 'bad key!')).toBeNull();
  });

  it('the target is always http://127.0.0.1:<port>/musedungeon-bell, no-cors text/plain, no credentials or referrer', () => {
    const r = bellPortRequest(cfg(), { ...ids, pace: 'pilot' })!;
    expect(r.url).toBe('http://127.0.0.1:47123/musedungeon-bell');
    expect(r.port).toBe(47123);
    expect(r.init).toEqual({ method: 'POST', mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'Content-Type': 'text/plain' }, body: 'season=s5&run=run_ab12cd&mode=pilot&key=Abc_def-12345678' });
    // 送り先の名前は変えられない: 設定に名前の欄は無く、ほかの値を混ぜても 127.0.0.1。ポートの形が違えば送らない
    expect(bellPortRequest(cfg({ port: 80 }), ids)).toBeNull();
    expect(bellPortRequest(cfg({ port: null }), ids)).toBeNull();
    expect(bellPortRequest({ ...cfg(), host: 'evil.example' } as unknown as BellConfig, ids)!.url).toBe('http://127.0.0.1:47123/musedungeon-bell');
    expect(bellPortRequest(cfg({ mode: 'tool' }), ids)).toBeNull();
    expect(bellPortRequest(cfg({ key: 'bad key!' }), ids)).toBeNull();
    // どちらの鳴らし方か
    expect(bellRingOf(cfg({ mode: 'tool' }), ids)).toEqual({ via: 'link', url: 'musedungeon-bell://ready?season=s5&run=run_ab12cd' });
    expect(bellRingOf(cfg(), ids)?.via).toBe('port');
    expect(bellRingOf(cfg({ mode: 'off' }), ids)).toBeNull();
    expect(bellMode(cfg({ port: null }))).toBe('off');
    expect(bellMode(cfg())).toBe('port');
  });

  it('S14b: saved values are read like the input (digits only, in range); a saved passphrase that fails the check means no ring and "check the bell settings", never a ring without it', () => {
    const g = globalThis as { window?: unknown };
    const had = Object.getOwnPropertyDescriptor(g, 'window');
    const mem = new Map<string, string>();
    const ls = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    const put = (mode: string, port: string, key: string) => { mem.set('muse.pref.bell', mode); mem.set('muse.pref.bell.port', port); mem.set('muse.pref.bell.key', key); };
    try {
      Object.defineProperty(g, 'window', { value: { localStorage: ls }, configurable: true });
      put('port', '47123', 'Abc_def-12345678');
      expect(readBellConfig()).toEqual({ mode: 'port', port: 47123, key: 'Abc_def-12345678' });
      expect(bellProblem(readBellConfig())).toBeNull();
      // 合言葉は任意（空なら、合言葉なしで送る）
      put('port', '47123', '');
      expect(bellRingOf(readBellConfig(), ids)?.via).toBe('port');
      // 形の違う合言葉: 合言葉なしでは送らない。鳴らさず「見直す」
      put('port', '47123', 'bad key!');
      const c1 = readBellConfig();
      expect(c1.bad).toBe('key');
      expect(bellRingOf(c1, ids)).toBeNull();
      expect(bellProblem(c1)).toContain('呼び鈴の設定を見直す');
      expect(bellOn(c1)).toBe(true);
      // ポートの読み方は、入力と同じ（数字だけ・範囲の中）
      for (const p of ['4.7e4', '47123abc', '0x1000', '80', '', '-47123', '99999']) {
        put('port', p, '');
        const c = readBellConfig();
        expect(c.port).toBeNull();
        expect(c.bad).toBe('port');
        expect(bellRingOf(c, ids)).toBeNull();
      }
      expect(bellPortParse(' 47123 ')).toBe(47123);
      // リンクの設定では、受け口の値は見ない
      put('tool', 'junk', 'bad key!');
      expect(bellProblem(readBellConfig())).toBeNull();
      expect(bellRingOf(readBellConfig(), ids)?.via).toBe('link');
    } finally {
      if (had) Object.defineProperty(g, 'window', had);
      else delete g.window;
    }
  });

  it('a failed connection is "the receiver is not running"; the reply is never read', async () => {
    const r = bellPortRequest(cfg(), ids)!;
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = await ringPort(r, (async (url: string, init: RequestInit) => { seen.push({ url, init }); return { type: 'opaque' } as Response; }) as unknown as typeof fetch);
    expect(ok).toBe(true);
    expect(seen[0].url).toBe('http://127.0.0.1:47123/musedungeon-bell');
    expect(seen[0].init.body).toBe('season=s5&run=run_ab12cd&key=Abc_def-12345678');
    expect(await ringPort(r, (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toBe(false);
    expect(bellView({ url: r.url, aiWaiting: false, rung: 0, failedPort: 47123 })).toEqual({ label: 'もう一度鳴らす', note: '受け口が、動いていない（ポート 47123）', primary: true });
    setLocale('en');
    expect(bellPortFailText(47123)).toBe('The receiver is not running (port 47123)');
  });
});

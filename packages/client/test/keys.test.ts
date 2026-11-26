// S12c（S12b の検査の 3）: 鍵を読む所を 1 つに。覚えてある鍵の全部（profileToken・前の版の seasonToken.<id>・拠点で足した冒険者の adventurerKeys）から、
// そのランの冒険者の鍵を探す／「新しいプロフィールにする」は鍵を捨てない／足した鍵は今の鍵を上書きしない
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addKey, forgetKeys, keyForRun, primaryKey, retireMainKey, storedKeys } from '../src/ui/keys';

/** テストのための localStorage（util.ts は window.localStorage を読む） */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => m.clear(),
  };
}
const g = globalThis as { window?: unknown };
beforeEach(() => { g.window = { localStorage: memoryStorage() }; });
afterEach(() => { forgetKeys(); delete g.window; });

describe('S12c 3: one place to read keys', () => {
  it('a key added for a person who goes down themselves never overwrites the key already kept; all keys are read', () => {
    addKey('k-main');
    expect(primaryKey()).toBe('k-main');
    addKey('k-human');
    addKey('k-human');
    expect(primaryKey()).toBe('k-main');
    expect(storedKeys()).toEqual(['k-main', 'k-human']);
    // 前の版の、シーズンごとの鍵も
    (g.window as { localStorage: Storage }).localStorage.setItem('muse.pref.seasonToken.s3', 'k-old');
    expect(storedKeys()).toEqual(['k-main', 'k-old', 'k-human']);
  });

  it('"start a new profile" empties the main key but keeps it as a hub adventurer\'s key (keys cannot be rebuilt)', () => {
    addKey('k-main');
    addKey('k-human');
    retireMainKey();
    expect(primaryKey()).toBe('');
    expect(storedKeys().sort()).toEqual(['k-human', 'k-main']);
    // 次に足した鍵は、空いた profileToken へ
    addKey('k-next');
    expect(primaryKey()).toBe('k-next');
    forgetKeys();
    expect(storedKeys()).toEqual([]);
  });

  it('the key for a run is the one whose owner list marks that run as its own, searched among all keys (never another adventurer\'s key)', async () => {
    addKey('k-ai');
    addKey('k-human');
    const asked: string[] = [];
    const ask = async (t: string) => {
      asked.push(t);
      return { runs: t === 'k-human' ? [{ runId: 'run_h', mine: true }, { runId: 'run_a', mine: false }] : [{ runId: 'run_a', mine: true }, { runId: 'run_h', mine: false }] };
    };
    expect(await keyForRun('run_h', ask)).toBe('k-human');
    expect(await keyForRun('run_a', ask)).toBe('k-ai');
    expect(await keyForRun('run_x', ask)).toBeUndefined();
    // 見つけた鍵は覚える（読み直しのたびに問い合わせない）。鍵を外せば忘れる
    const n = asked.length;
    expect(await keyForRun('run_h', ask)).toBe('k-human');
    expect(asked.length).toBe(n);
    forgetKeys();
    expect(await keyForRun('run_h', ask)).toBeUndefined();
    // 問い合わせが失敗した鍵は飛ばす
    addKey('k-bad');
    addKey('k-human');
    expect(await keyForRun('run_h', async (t) => { if (t === 'k-bad') throw new Error('401'); return ask(t); })).toBe('k-human');
  });
});

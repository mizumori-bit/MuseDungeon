import { describe, expect, it } from 'vitest';
import {
  canonicalHash, canonicalStringify, cyrb128, indicesToRanges, parseDice, rangesToIndices, rleDecode, rleEncode, Rng, CommandSchema,
} from '../src/index';

describe('rng', () => {
  it('is deterministic per seed and stays in range', () => {
    const a = Rng.fromSeed('seed-1');
    const b = Rng.fromSeed('seed-1');
    const xs = Array.from({ length: 1000 }, () => a.int(7));
    const ys = Array.from({ length: 1000 }, () => b.int(7));
    expect(xs).toEqual(ys);
    expect(xs.every((x) => x >= 0 && x < 7)).toBe(true);
    expect(new Set(xs).size).toBe(7);
    expect(Rng.fromSeed('seed-2').int(1_000_000)).not.toBe(Rng.fromSeed('seed-1').int(1_000_000));
  });

  it('cyrb128 is stable across runs (golden value)', () => {
    expect(cyrb128('MuseDungeon')).toEqual(cyrb128('MuseDungeon'));
    expect(cyrb128('a')).not.toEqual(cyrb128('b'));
    const r = Rng.fromSeed('golden');
    // 固定値: PRNG の実装が変わるとリプレイ互換性が壊れる
    expect([r.nextU32(), r.nextU32(), r.nextU32()]).toMatchSnapshot();
  });

  it('state round-trips', () => {
    const r = Rng.fromSeed('x');
    r.int(10);
    const s = r.state();
    const r2 = new Rng(s);
    expect(r2.int(1000)).toBe(r.int(1000));
  });
});

describe('util', () => {
  it('rle and ranges round-trip', () => {
    const arr = [0, 0, 0, 1, 1, 2, 0, 0];
    expect(rleDecode(rleEncode(arr))).toEqual(arr);
    const idx = [1, 2, 3, 7, 8, 20];
    expect(rangesToIndices(indicesToRanges(idx))).toEqual(idx);
  });

  it('canonical stringify ignores key order', () => {
    expect(canonicalStringify({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalStringify({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(canonicalHash({ x: 1 })).not.toBe(canonicalHash({ x: 2 }));
  });

  it('parses dice', () => {
    expect(parseDice('2d4+2')).toEqual({ n: 2, sides: 4, bonus: 2 });
    expect(parseDice('1d6')).toEqual({ n: 1, sides: 6, bonus: 0 });
    expect(parseDice('3')).toEqual({ n: 0, sides: 0, bonus: 3 });
    expect(parseDice('1d8-1')).toEqual({ n: 1, sides: 8, bonus: -1 });
  });

  it('command schema validates the shared Command', () => {
    expect(CommandSchema.safeParse({ type: 'move', dir: 'ne' }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'move', dir: 'up' }).success).toBe(false);
    expect(CommandSchema.safeParse({ type: 'travel', to: 'stairs_down' }).success).toBe(true);
    expect(CommandSchema.safeParse({ type: 'throw', slot: 'c', target: 'e_abc123' }).success).toBe(true);
  });
});

// 決定論的 PRNG（32bit 整数演算のみ）。sfc32 + cyrb128。
// 乱数を「使うルール」は engine にのみ置く。ここは純粋なユーティリティ。
import type { RngState } from './types';

/** 文字列 → 128bit ハッシュ（4×u32） */
export function cyrb128(str: string): RngState {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/** 文字列ハッシュの16進表現（正準ハッシュ用） */
export function hashHex(str: string): string {
  return cyrb128(str).map((n) => n.toString(16).padStart(8, '0')).join('');
}

const U32 = 4294967296;

export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(state: RngState) {
    [this.a, this.b, this.c, this.d] = state;
  }

  /** シード文字列から新しいストリームを作る（ウォームアップ込み） */
  static fromSeed(seed: string): Rng {
    const r = new Rng(cyrb128(seed));
    for (let i = 0; i < 12; i++) r.nextU32();
    return r;
  }

  state(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0];
  }

  nextU32(): number {
    let a = this.a | 0, b = this.b | 0, c = this.c | 0, d = this.d | 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  /** [0, n) の一様整数（棄却法でバイアス無し） */
  int(n: number): number {
    if (!Number.isInteger(n) || n <= 0) throw new Error(`Rng.int: bad n ${n}`);
    if (n === 1) return 0;
    const limit = U32 - (U32 % n);
    for (;;) {
      const v = this.nextU32();
      if (v < limit) return v % n;
    }
  }

  /** [lo, hi] の一様整数 */
  range(lo: number, hi: number): number {
    if (hi < lo) return lo;
    return lo + this.int(hi - lo + 1);
  }

  /** pct% の確率で true */
  chance(pct: number): boolean {
    if (pct <= 0) return false;
    if (pct >= 100) return true;
    return this.int(100) < pct;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('Rng.pick: empty');
    return arr[this.int(arr.length)];
  }

  /** 重み付き抽選（重みは非負整数）。全重み 0 なら null */
  weighted<T>(items: readonly T[], weight: (t: T) => number): T | null {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it) | 0);
    if (total <= 0) return null;
    let r = this.int(total);
    for (const it of items) {
      const w = Math.max(0, weight(it) | 0);
      if (r < w) return it;
      r -= w;
    }
    return null;
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
}

/** 不透明 ID（連番にしない）。base36 で len 文字 */
export function opaqueId(rng: Rng, prefix: string, len: number): string {
  let s = '';
  while (s.length < len) s += rng.nextU32().toString(36);
  return prefix + s.slice(0, len);
}

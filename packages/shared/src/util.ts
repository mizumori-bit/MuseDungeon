// 汎用ユーティリティ（ルール無し）。正準 JSON、ハッシュ、RLE、ダイス表記の解析、幾何。
import { hashHex } from './rng';
import type { Dir, Pos } from './types';
import { DIRS, DIR_VEC } from './types';

/** キーを辞書順に並べた JSON。undefined は省く */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite number');
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined ? 'null' : canonicalStringify(v))).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}';
}

export function canonicalHash(value: unknown): string {
  return hashHex(canonicalStringify(value));
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** [value, count, value, count, ...] */
export function rleEncode(arr: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < arr.length) {
    const v = arr[i];
    let n = 1;
    while (i + n < arr.length && arr[i + n] === v) n++;
    out.push(v, n);
    i += n;
  }
  return out;
}

export function rleDecode(rle: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < rle.length; i += 2) {
    const v = rle[i];
    const n = rle[i + 1];
    for (let k = 0; k < n; k++) out.push(v);
  }
  return out;
}

/** 昇順のインデックス集合 → [start, len, ...] */
export function indicesToRanges(sorted: readonly number[]): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    let len = 1;
    while (i + len < sorted.length && sorted[i + len] === start + len) len++;
    out.push(start, len);
    i += len;
  }
  return out;
}

export function rangesToIndices(ranges: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < ranges.length; i += 2) {
    for (let k = 0; k < ranges[i + 1]; k++) out.push(ranges[i] + k);
  }
  return out;
}

export interface Dice { n: number; sides: number; bonus: number }

/** "2d4+2" / "1d6" / "3" / "1d8-1" を解析 */
export function parseDice(s: string): Dice {
  const m = /^\s*(?:(\d+)d(\d+))?\s*([+-]\s*\d+)?\s*$/.exec(s);
  const plain = /^\s*(-?\d+)\s*$/.exec(s);
  if (plain) return { n: 0, sides: 0, bonus: parseInt(plain[1], 10) };
  if (!m || (!m[1] && !m[3])) throw new Error(`bad dice: ${s}`);
  return {
    n: m[1] ? parseInt(m[1], 10) : 0,
    sides: m[2] ? parseInt(m[2], 10) : 0,
    bonus: m[3] ? parseInt(m[3].replace(/\s+/g, ''), 10) : 0,
  };
}

export function formatDice(d: Dice): string {
  const core = d.n > 0 ? `${d.n}d${d.sides}` : '';
  if (!core) return String(d.bonus);
  if (d.bonus === 0) return core;
  return d.bonus > 0 ? `${core}+${d.bonus}` : `${core}${d.bonus}`;
}

export function diceMax(s: string): number {
  const d = parseDice(s);
  return d.n * d.sides + d.bonus;
}

/** ダイス表記の加算（ボーナスのみ加える） */
export function addDiceBonus(s: string, bonus: number): string {
  const d = parseDice(s);
  return formatDice({ ...d, bonus: d.bonus + bonus });
}

/** 整数の床除算（浮動小数を経由しない） */
export function floorDiv(a: number, b: number): number {
  const r = ((a % b) + b) % b;
  return (a - r) / b;
}

export function ceilDiv(a: number, b: number): number {
  return -floorDiv(-a, b);
}

export function cheb(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function samePos(a: Pos | null | undefined, b: Pos | null | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

export function stepPos(p: Pos, d: Dir): Pos {
  const v = DIR_VEC[d];
  return { x: p.x + v[0], y: p.y + v[1] };
}

/** a から b へのおおよその 8 方向（同一点なら null） */
/**
 * 表示用の方角（8 方向に丸める）。ほぼ真北なら「北」。整数のみ: |dx| と |dy| の比が 5:12（約 22.5°）より小さければ軸方向とみなす。
 */
export function compassDir(a: Pos, b: Pos): Dir | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return null;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const sx = ax * 12 < ay * 5 ? 0 : Math.sign(dx);
  const sy = ay * 12 < ax * 5 ? 0 : Math.sign(dy);
  for (const d of DIRS) {
    const v = DIR_VEC[d];
    if (v[0] === sx && v[1] === sy) return d;
  }
  return null;
}

export function dirTo(a: Pos, b: Pos): Dir | null {
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  if (dx === 0 && dy === 0) return null;
  for (const d of DIRS) {
    const v = DIR_VEC[d];
    if (v[0] === dx && v[1] === dy) return d;
  }
  return null;
}

/** 隣接方向（チェビシェフ距離 1 のときのみ） */
export function adjacentDir(a: Pos, b: Pos): Dir | null {
  if (cheb(a, b) !== 1) return null;
  return dirTo(a, b);
}

export function idxOf(width: number, x: number, y: number): number {
  return y * width + x;
}

export function posOf(width: number, idx: number): Pos {
  return { x: idx % width, y: (idx - (idx % width)) / width };
}

export function inBounds(width: number, height: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < width && y < height;
}

/** 比較関数（全順序）: 数値昇順 */
export function byNum(a: number, b: number): number {
  return a - b;
}

/** 比較関数（全順序）: 文字列 */
export function byStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function t(locale: 'ja' | 'en', ja: string, en: string): string {
  return locale === 'en' ? en : ja;
}

/** ID 文字列から見た目専用の 32bit ハッシュ（ゲーム乱数とは無関係） */
export function visualHash(x: number, y: number, salt = 0): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

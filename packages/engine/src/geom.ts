// 視界（対称シャドウキャスティング、整数の有理数演算のみ）と射線。
import { ceilDiv, floorDiv } from '@muse/shared';
import type { Pos } from '@muse/shared';

interface Frac { n: number; d: number } // d > 0

/**
 * 対称シャドウキャスティング（Albert Ford 方式）。
 * isOpaque(x,y) は範囲外を true とすること。半径は dx²+dy² <= r²+r の円。
 * 返り値は可視セル index の昇順。
 */
export function computeFov(width: number, height: number, isOpaque: (x: number, y: number) => boolean, ox: number, oy: number, radius: number): number[] {
  const vis = new Set<number>();
  const mark = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const dx = x - ox;
    const dy = y - oy;
    if (dx * dx + dy * dy > radius * radius + radius) return;
    vis.add(y * width + x);
  };
  mark(ox, oy);
  const r2 = radius;
  for (let q = 0; q < 4; q++) {
    const tf = (depth: number, col: number): [number, number] => {
      switch (q) {
        case 0: return [ox + col, oy - depth]; // north
        case 1: return [ox + depth, oy + col]; // east
        case 2: return [ox + col, oy + depth]; // south
        default: return [ox - depth, oy + col]; // west
      }
    };
    const wallAt = (depth: number, col: number) => {
      const [x, y] = tf(depth, col);
      return isOpaque(x, y);
    };
    const scan = (depth: number, start: Frac, end: Frac) => {
      if (depth > r2) return;
      // min_col = round_ties_up(depth * start), max_col = round_ties_down(depth * end)
      const minCol = floorDiv(2 * depth * start.n + start.d, 2 * start.d);
      const maxCol = ceilDiv(2 * depth * end.n - end.d, 2 * end.d);
      let prevWall: boolean | null = null;
      let s = start;
      for (let col = minCol; col <= maxCol; col++) {
        const isWall = wallAt(depth, col);
        const symmetric = col * s.d >= depth * s.n && col * end.d <= depth * end.n;
        if (isWall || symmetric) {
          const [x, y] = tf(depth, col);
          mark(x, y);
        }
        if (prevWall === true && !isWall) s = { n: 2 * col - 1, d: 2 * depth };
        if (prevWall === false && isWall) scan(depth + 1, s, { n: 2 * col - 1, d: 2 * depth });
        prevWall = isWall;
      }
      if (prevWall === false) scan(depth + 1, s, end);
    };
    scan(1, { n: -1, d: 1 }, { n: 1, d: 1 });
  }
  return [...vis].sort((a, b) => a - b);
}

/** ブレゼンハムの直線（始点を含まず終点を含む） */
export function line(a: Pos, b: Pos): Pos[] {
  const out: Pos[] = [];
  let x = a.x, y = a.y;
  const dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 1000; guard++) {
    if (x === b.x && y === b.y) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
    out.push({ x, y });
  }
  return out;
}

/** 射線: 双方向どちらかの直線上（端点を除く）に遮蔽物が無い */
export function hasLos(a: Pos, b: Pos, isOpaque: (x: number, y: number) => boolean): boolean {
  const clear = (p: Pos[]) => p.slice(0, -1).every((c) => !isOpaque(c.x, c.y));
  return clear(line(a, b)) || clear(line(b, a));
}

export function inCircle(a: Pos, b: Pos, r: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy <= r * r + r;
}

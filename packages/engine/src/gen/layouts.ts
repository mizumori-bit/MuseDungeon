// レイアウト生成器（レジストリ登録）。rooms_corridors（BSP）、cellular_cave（セルオートマトン）、fallback。
import type { Rng } from '@muse/shared';
import { Registry } from '../registry';
import { DOOR, FLOOR, GenGrid, WALL } from './grid';

export interface LayoutInput { w: number; h: number; rng: Rng }
export type LayoutGenerator = (input: LayoutInput) => GenGrid;

export const layoutGenerators = new Registry<LayoutGenerator>('layoutGenerator');

interface Rect { x: number; y: number; w: number; h: number }

function carveRoom(g: GenGrid, r: Rect): void {
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) g.set(x, y, FLOOR);
}

function center(r: Rect, rng: Rng): { x: number; y: number } {
  return { x: r.x + rng.int(r.w), y: r.y + rng.int(r.h) };
}

/** L 字の通路 */
function corridor(g: GenGrid, a: { x: number; y: number }, b: { x: number; y: number }, rng: Rng): void {
  let x = a.x, y = a.y;
  const stepX = () => { while (x !== b.x) { x += x < b.x ? 1 : -1; if (g.inside(x, y)) g.set(x, y, FLOOR); } };
  const stepY = () => { while (y !== b.y) { y += y < b.y ? 1 : -1; if (g.inside(x, y)) g.set(x, y, FLOOR); } };
  if (rng.chance(50)) { stepX(); stepY(); } else { stepY(); stepX(); }
}

/** 部屋に接する通路セルのうち、両脇が壁のもの（戸口）に扉を置く */
function placeDoors(g: GenGrid, roomMask: Int32Array, rng: Rng): void {
  for (let y = 1; y < g.h - 1; y++) {
    for (let x = 1; x < g.w - 1; x++) {
      const i = g.idx(x, y);
      if (g.cells[i] !== FLOOR || roomMask[i] >= 0) continue;
      const touchesRoom = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => roomMask[g.idx(x + dx, y + dy)] >= 0);
      if (!touchesRoom) continue;
      const horizWalls = g.get(x - 1, y) === WALL && g.get(x + 1, y) === WALL;
      const vertWalls = g.get(x, y - 1) === WALL && g.get(x, y + 1) === WALL;
      if ((horizWalls || vertWalls) && rng.chance(45)) g.set(x, y, DOOR);
    }
  }
}

layoutGenerators.register('core:rooms_corridors', ({ w, h, rng }) => {
  const g = new GenGrid(w, h);
  const leaves: Rect[] = [];
  const split = (r: Rect, depth: number) => {
    const canH = r.w >= 18;
    const canV = r.h >= 14;
    if (depth > 5 || (!canH && !canV) || (depth >= 3 && rng.chance(20))) { leaves.push(r); return; }
    const horiz = canH && (!canV || r.w > r.h ? true : rng.chance(50));
    if (horiz) {
      const cut = rng.range(8, r.w - 8);
      split({ x: r.x, y: r.y, w: cut, h: r.h }, depth + 1);
      split({ x: r.x + cut, y: r.y, w: r.w - cut, h: r.h }, depth + 1);
    } else {
      const cut = rng.range(6, r.h - 6);
      split({ x: r.x, y: r.y, w: r.w, h: cut }, depth + 1);
      split({ x: r.x, y: r.y + cut, w: r.w, h: r.h - cut }, depth + 1);
    }
  };
  split({ x: 1, y: 1, w: w - 2, h: h - 2 }, 0);
  const rooms: Rect[] = [];
  for (const leaf of leaves) {
    const rw = rng.range(Math.min(4, leaf.w - 2), Math.max(4, leaf.w - 2));
    const rh = rng.range(Math.min(3, leaf.h - 2), Math.max(3, leaf.h - 2));
    const room = {
      w: Math.max(3, Math.min(rw, leaf.w - 2)),
      h: Math.max(3, Math.min(rh, leaf.h - 2)),
      x: 0, y: 0,
    };
    room.x = leaf.x + 1 + rng.int(Math.max(1, leaf.w - room.w - 1));
    room.y = leaf.y + 1 + rng.int(Math.max(1, leaf.h - room.h - 1));
    if (room.x + room.w >= w - 1) room.w = w - 2 - room.x;
    if (room.y + room.h >= h - 1) room.h = h - 2 - room.y;
    if (room.w < 3 || room.h < 3) continue;
    rooms.push(room);
  }
  const roomMask = new Int32Array(w * h).fill(-1);
  rooms.forEach((r, i) => {
    carveRoom(g, r);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) roomMask[g.idx(x, y)] = i;
    g.regions.push({ id: i, kind: 'room', x: r.x, y: r.y, w: r.w, h: r.h, tags: [] });
  });
  // 隣り合う部屋を順につなぐ（BSP の葉順）＋数本のループ
  for (let i = 1; i < rooms.length; i++) corridor(g, center(rooms[i - 1], rng), center(rooms[i], rng), rng);
  const loops = rooms.length > 3 ? rng.range(1, 3) : 0;
  for (let k = 0; k < loops; k++) {
    const a = rooms[rng.int(rooms.length)];
    const b = rooms[rng.int(rooms.length)];
    if (a !== b) corridor(g, center(a, rng), center(b, rng), rng);
  }
  placeDoors(g, roomMask, rng);
  return g;
});

layoutGenerators.register('core:cellular_cave', ({ w, h, rng }) => {
  const g = new GenGrid(w, h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) g.set(x, y, rng.chance(46) ? WALL : FLOOR);
  const count = (x: number, y: number, r: number) => {
    let n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (g.get(x + dx, y + dy) === WALL) n++;
    }
    return n;
  };
  for (let it = 0; it < 5; it++) {
    const next = new Uint8Array(g.cells);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const n1 = count(x, y, 1);
        const wall = it < 3 ? n1 >= 5 || count(x, y, 2) <= 2 : n1 >= 5;
        next[g.idx(x, y)] = wall ? WALL : FLOOR;
      }
    }
    g.cells.set(next);
  }
  // 小さな成分は埋め、残りは最大成分へつなぐ
  const comps = g.components((i) => g.cells[i] !== WALL);
  for (const c of comps) if (c.length < 12) for (const i of c) g.cells[i] = WALL;
  g.connectAll(rng, (i) => g.cells[i] !== WALL);
  // 空洞の粗い領域分割（プレハブ配置用）
  const cw = Math.max(1, Math.trunc((w - 2) / 3));
  const ch = Math.max(1, Math.trunc((h - 2) / 2));
  let id = 0;
  for (let ry = 0; ry < 2; ry++) for (let rx = 0; rx < 3; rx++) {
    g.regions.push({ id: id++, kind: 'cave', x: 1 + rx * cw, y: 1 + ry * ch, w: cw, h: ch, tags: [] });
  }
  return g;
});

/** 必ず成功する単純レイアウト（validate に 8 回失敗したとき） */
layoutGenerators.register('core:fallback', ({ w, h }) => {
  const g = new GenGrid(w, h);
  const cols = 3, rows = 2;
  const cw = Math.trunc((w - 2) / cols), ch = Math.trunc((h - 2) / rows);
  let id = 0;
  const centers: { x: number; y: number }[] = [];
  for (let ry = 0; ry < rows; ry++) {
    for (let rx = 0; rx < cols; rx++) {
      const r = { x: 1 + rx * cw + 2, y: 1 + ry * ch + 2, w: cw - 4, h: ch - 4 };
      carveRoom(g, r);
      g.regions.push({ id: id++, kind: 'room', ...r, tags: [] });
      centers.push({ x: r.x + Math.trunc(r.w / 2), y: r.y + Math.trunc(r.h / 2) });
    }
  }
  const link = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    let x = a.x, y = a.y;
    while (x !== b.x) { x += x < b.x ? 1 : -1; g.set(x, y, FLOOR); }
    while (y !== b.y) { y += y < b.y ? 1 : -1; g.set(x, y, FLOOR); }
  };
  for (let i = 1; i < centers.length; i++) link(centers[i - 1], centers[i]);
  return g;
});

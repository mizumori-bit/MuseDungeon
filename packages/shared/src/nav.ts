// 既知地図上の経路探索。入力はプレイヤーの既知地図（PlayerView）だけ。未知セルは通行不可扱い。
// タイブレークは DIRS の固定順で決定的。
import type { Catalog } from './catalog';
import type { Dir, Pos } from './types';
import { DIRS, DIR_VEC } from './types';
import type { PlayerView } from './view';

export interface NavGrid {
  width: number;
  height: number;
  /** 既知かつ通行可能（閉じた扉も通行可能扱い） */
  passable: Uint8Array;
  known: Uint8Array;
  /** 視界内の他アクター（障害物） */
  occupied: Uint8Array;
  /** 発見済みの罠（できれば避ける） */
  hazard: Uint8Array;
  /** 地形は知っているが目で見ていないセル（explore の行き先は「見ていない区画」） */
  unsighted: Uint8Array;
}

/** 経路探索の厳しさ: strict = アクターと罠を避ける / actors = アクターだけ避ける / none = 地形のみ */
export type PathMode = 'strict' | 'actors' | 'none';

export function terrainPassable(catalog: Catalog, terrainId: string | undefined): boolean {
  if (!terrainId) return false;
  const t = catalog.terrain[terrainId];
  if (!t) return false;
  return t.passable || t.door === 'closed';
}

export function buildNavGrid(view: PlayerView, catalog: Catalog): NavGrid | null {
  if (!view.floor) return null;
  const { width, height } = view.floor;
  const n = width * height;
  const passable = new Uint8Array(n);
  const known = new Uint8Array(n);
  const occupied = new Uint8Array(n);
  const hazard = new Uint8Array(n);
  const passCache = new Map<number, boolean>();
  for (let i = 0; i < n; i++) {
    const t = view.memory.terrain[i] ?? 0;
    if (t === 0) continue;
    known[i] = 1;
    let p = passCache.get(t);
    if (p === undefined) {
      p = terrainPassable(catalog, view.terrainTable[t]);
      passCache.set(t, p);
    }
    if (p) passable[i] = 1;
  }
  for (const e of view.entities) {
    if (e.cat === 'monster' || e.cat === 'player') occupied[e.pos.y * width + e.pos.x] = 1;
  }
  // 発見済みの罠はできれば避ける
  for (const e of view.entities) if (e.cat === 'trap') hazard[e.pos.y * width + e.pos.x] = 1;
  // 見えている動かない敵の隣も罠と同じ扱い（ほかに道が無ければ通る。V3-2R2 §18.5）
  for (const e of view.entities) {
    if (e.cat !== 'monster' || !e.kind || !catalog.monsters[e.kind]?.tags.includes('stationary')) continue;
    for (const d of DIRS) {
      const nx = e.pos.x + DIR_VEC[d][0], ny = e.pos.y + DIR_VEC[d][1];
      if (nx >= 0 && ny >= 0 && nx < width && ny < height) hazard[ny * width + nx] = 1;
    }
  }
  for (const r of view.memory.remembered) if (r.cat === 'trap') hazard[r.pos.y * width + r.pos.x] = 1;
  const unsighted = new Uint8Array(n);
  for (const i of view.memory.unsighted ?? []) unsighted[i] = 1;
  return { width, height, passable, known, occupied, hazard, unsighted };
}

export interface BfsResult {
  dist: Int32Array;
  prev: Int32Array;
}

/** 複数始点 BFS。blockOccupied のとき他アクター（strict なら罠も）のセルを通らない（始点・終点は除く） */
export function bfs(grid: NavGrid, starts: readonly number[], blockOccupied: boolean | PathMode, goal?: Set<number>): BfsResult {
  const mode: PathMode = blockOccupied === true ? 'strict' : blockOccupied === false ? 'none' : blockOccupied;
  const n = grid.width * grid.height;
  const dist = new Int32Array(n).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const q = new Int32Array(n);
  let head = 0, tail = 0;
  for (const s of starts) {
    if (dist[s] !== -1) continue;
    dist[s] = 0;
    q[tail++] = s;
  }
  while (head < tail) {
    const cur = q[head++];
    const cx = cur % grid.width;
    const cy = (cur - cx) / grid.width;
    for (const d of DIRS) {
      const nx = cx + DIR_VEC[d][0];
      const ny = cy + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
      const ni = ny * grid.width + nx;
      if (dist[ni] !== -1) continue;
      if (!grid.passable[ni]) continue;
      const isGoal = goal?.has(ni) ?? false;
      if (mode !== 'none' && grid.occupied[ni] && !isGoal) continue;
      if (mode === 'strict' && grid.hazard[ni] && !isGoal) continue;
      dist[ni] = dist[cur] + 1;
      prev[ni] = cur;
      q[tail++] = ni;
    }
  }
  return { dist, prev };
}

/** 始点から goal 集合のいずれかへの最短経路（始点を含まない）。到達不能なら null */
export function findPath(grid: NavGrid, start: Pos, goals: readonly number[], blockOccupied: boolean | PathMode = true): Pos[] | null {
  if (goals.length === 0) return null;
  const s = start.y * grid.width + start.x;
  const goalSet = new Set(goals);
  if (goalSet.has(s)) return [];
  const { dist, prev } = bfs(grid, [s], blockOccupied, goalSet);
  let best = -1;
  for (const g of [...goals].sort((a, b) => a - b)) {
    if (dist[g] < 0) continue;
    if (best < 0 || dist[g] < dist[best]) best = g;
  }
  if (best < 0) return null;
  const path: Pos[] = [];
  let cur = best;
  while (cur !== s) {
    const x = cur % grid.width;
    path.push({ x, y: (cur - x) / grid.width });
    cur = prev[cur];
  }
  return path.reverse();
}

/** 未探索との境界: 既知・通行可能で、8 近傍に未知セルを持つセル */
export function findFrontiers(grid: NavGrid): number[] {
  const out: number[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const i = y * grid.width + x;
      if (!grid.passable[i] || grid.unsighted[i]) continue;
      for (const d of DIRS) {
        const nx = x + DIR_VEC[d][0];
        const ny = y + DIR_VEC[d][1];
        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
        const j = ny * grid.width + nx;
        if (!grid.known[j] || grid.unsighted[j]) { out.push(i); break; }
      }
    }
  }
  return out;
}

export function dirBetween(a: Pos, b: Pos): Dir | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const d of DIRS) if (DIR_VEC[d][0] === dx && DIR_VEC[d][1] === dy) return d;
  return null;
}

/** 既知地図上での距離（到達不能なら -1）。自分の位置から全セル */
export function distanceField(grid: NavGrid, from: Pos, blockOccupied = false): Int32Array {
  return bfs(grid, [from.y * grid.width + from.x], blockOccupied).dist;
}

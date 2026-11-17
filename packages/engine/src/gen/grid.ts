// 生成中の抽象グリッド。WALL/FLOOR/DOOR と、地形の上書き（プレハブ・バイオーム地形）を持つ。
import type { Region } from '@muse/shared';
import { DIRS, DIR_VEC } from '@muse/shared';
import type { Rng } from '@muse/shared';

export const WALL = 0;
export const FLOOR = 1;
export const DOOR = 2;

export class GenGrid {
  readonly cells: Uint8Array;
  /** idx → terrain ID（WALL/FLOOR/DOOR の既定パレットより優先） */
  readonly override = new Map<number, string>();
  /** プレハブ等で確定したセル（後段で掘らない・上書きしない） */
  readonly protect = new Uint8Array(0);
  readonly regions: Region[] = [];
  /** レイアウトが決めた場所（大守護者の間: 上り階段・下り階段・大守護者。V3-3 §3.2） */
  anchors: { up?: number; down?: number; warden?: number } = {};

  constructor(readonly w: number, readonly h: number) {
    this.cells = new Uint8Array(w * h);
    (this as { protect: Uint8Array }).protect = new Uint8Array(w * h);
  }

  idx(x: number, y: number): number { return y * this.w + x; }
  inside(x: number, y: number): boolean { return x > 0 && y > 0 && x < this.w - 1 && y < this.h - 1; }
  get(x: number, y: number): number { return x < 0 || y < 0 || x >= this.w || y >= this.h ? WALL : this.cells[y * this.w + x]; }
  set(x: number, y: number, v: number): void { if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.cells[y * this.w + x] = v; }

  /** 通行可能（壁以外。上書き地形の通行可否は passableOverride で判定） */
  passable(i: number, passableOverride: (id: string) => boolean): boolean {
    const o = this.override.get(i);
    if (o !== undefined) return passableOverride(o);
    return this.cells[i] !== WALL;
  }

  floorCells(): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.cells.length; i++) if (this.cells[i] === FLOOR) out.push(i);
    return out;
  }

  /** 8 近傍 BFS で連結成分（通行可能セル） */
  components(passable: (i: number) => boolean): number[][] {
    const seen = new Int32Array(this.cells.length).fill(-1);
    const comps: number[][] = [];
    for (let i = 0; i < this.cells.length; i++) {
      if (seen[i] >= 0 || !passable(i)) continue;
      const comp: number[] = [];
      const q = [i];
      seen[i] = comps.length;
      while (q.length) {
        const c = q.pop()!;
        comp.push(c);
        const cx = c % this.w, cy = (c - cx) / this.w;
        for (const d of DIRS) {
          const nx = cx + DIR_VEC[d][0], ny = cy + DIR_VEC[d][1];
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          const ni = ny * this.w + nx;
          if (seen[ni] >= 0 || !passable(ni)) continue;
          seen[ni] = comps.length;
          q.push(ni);
        }
      }
      comp.sort((a, b) => a - b);
      comps.push(comp);
    }
    return comps;
  }

  /** 全ての連結成分を最大成分へ掘ってつなぐ（保護セルは掘らない） */
  connectAll(rng: Rng, passable: (i: number) => boolean): void {
    for (let guard = 0; guard < 50; guard++) {
      const comps = this.components(passable).sort((a, b) => b.length - a.length || a[0] - b[0]);
      if (comps.length <= 1) return;
      const main = new Set(comps[0]);
      const other = comps[comps.length - 1];
      // other から main への最短トンネル（4 近傍、保護セルの壁は通らない）
      const n = this.cells.length;
      const prev = new Int32Array(n).fill(-2);
      const q: number[] = [];
      for (const s of other) { prev[s] = -1; q.push(s); }
      let hit = -1;
      for (let h = 0; h < q.length && hit < 0; h++) {
        const c = q[h];
        const cx = c % this.w, cy = (c - cx) / this.w;
        const order = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        const start = rng.int(4);
        for (let k = 0; k < 4; k++) {
          const [dx, dy] = order[(start + k) % 4];
          const nx = cx + dx, ny = cy + dy;
          if (!this.inside(nx, ny)) continue;
          const ni = ny * this.w + nx;
          if (prev[ni] !== -2) continue;
          if (this.protect[ni] && !passable(ni)) continue;
          prev[ni] = c;
          if (main.has(ni)) { hit = ni; break; }
          q.push(ni);
        }
      }
      if (hit < 0) {
        // つなげない成分は埋める
        for (const i of other) if (!this.protect[i]) { this.cells[i] = WALL; this.override.delete(i); }
        continue;
      }
      let c = prev[hit];
      while (c >= 0 && prev[c] !== -1) {
        if (!passable(c)) { this.cells[c] = FLOOR; this.override.delete(c); }
        c = prev[c];
      }
      if (c >= 0 && !passable(c)) { this.cells[c] = FLOOR; this.override.delete(c); }
    }
  }
}

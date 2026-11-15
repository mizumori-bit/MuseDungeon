// 生成不変条件のチェック（テスト用。tools/src/cli.ts の gen-check と同じ判定）
import type { Content } from '@muse/content';
import type { GeneratedFloor } from '@muse/engine';
import { DIRS, DIR_VEC } from '@muse/shared';

export function checkFloorForTest(content: Content, g: GeneratedFloor, depth: number, table: string[]): string[] {
  const f = g.floor;
  const errs: string[] = [];
  const pass = (i: number) => {
    const t = content.terrain[content.terrainIndex[table[f.terrain[i]]]];
    return t.passable || t.door === 'closed';
  };
  const start = f.entry.y * f.width + f.entry.x;
  if (!pass(start)) errs.push('entry not passable');
  const dist = new Int32Array(f.width * f.height).fill(-1);
  dist[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const cx = c % f.width, cy = (c - cx) / f.width;
    for (const d of DIRS) {
      const nx = cx + DIR_VEC[d][0], ny = cy + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
      const ni = ny * f.width + nx;
      if (dist[ni] >= 0 || !pass(ni)) continue;
      dist[ni] = dist[c] + 1;
      q.push(ni);
    }
  }
  if (!f.stairs.down.length) errs.push('no down stairs');
  for (const s of f.stairs.down) if (dist[s.y * f.width + s.x] < 0) errs.push('down unreachable');
  if (depth > 1 && !f.stairs.up) errs.push('no up stairs');
  if (f.stairs.up && dist[f.stairs.up.y * f.width + f.stairs.up.x] < 0) errs.push('up unreachable');
  for (const sp of g.spawns) {
    if (!pass(sp.y * f.width + sp.x)) errs.push(`spawn ${sp.kind} on impassable`);
    if (sp.type === 'monster' && Math.max(Math.abs(sp.x - f.entry.x), Math.abs(sp.y - f.entry.y)) <= 6) errs.push('monster near entry');
  }
  for (let x = 0; x < f.width; x++) if (pass(x) || pass((f.height - 1) * f.width + x)) { errs.push('open border'); break; }
  for (let y = 0; y < f.height; y++) if (pass(y * f.width) || pass(y * f.width + f.width - 1)) { errs.push('open border'); break; }
  return errs;
}

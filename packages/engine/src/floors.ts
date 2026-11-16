// フロアの遅延生成（初めて入ったとき）。生成結果は floor_generated（地形 RLE）と entity_spawned で記録する。
// リプレイは生成器を必要としない。
import type { Entity, Floor, FloorKey, Pos } from '@muse/shared';
import { DIRS, DIR_VEC, rleEncode } from '@muse/shared';
import type { Ctx } from './ctx';
import { placementFor, recordTargets } from './expedition';
import { generateFloor } from './gen/generate';
import { spawnFromSpec } from './spawn';

export function ensureFloor(ctx: Ctx, key: FloorKey): Floor {
  const existing = ctx.world.floors[key];
  if (existing) return existing;
  const [branch, depthStr] = key.split(':');
  const depth = parseInt(depthStr, 10);
  // 遠征の目標階なら守護者・遺物を置く（生成の専用段。他の乱数ストリームはずれない）
  const objective = placementFor(ctx, branch, depth);
  const gen = generateFloor(ctx.content, ctx.world.secret.seed, branch, depth, ctx.world.meta.terrainTable, objective ?? undefined);
  const { terrain, ...floorData } = gen.floor;
  const prevFloor = ctx.curFloor;
  const prevNow = ctx.now;
  ctx.curFloor = key;
  ctx.now = 0;
  ctx.emit({ type: 'floor_generated', floorData, terrainRle: rleEncode(terrain), seenBy: [], floor: key, ft: 0 });
  const spawned: Entity[] = [];
  for (const spec of gen.spawns) spawned.push(spawnFromSpec(ctx, key, spec, 'generated'));
  if (objective) recordTargets(ctx, spawned);
  ctx.curFloor = prevFloor;
  ctx.now = prevNow;
  return ctx.world.floors[key];
}

/** 目的地またはその近くの空いている通行可能セル */
export function findFreeCell(ctx: Ctx, key: FloorKey, near: Pos): Pos {
  const f = ctx.world.floors[key];
  const seen = new Set<number>([near.y * f.width + near.x]);
  const q: Pos[] = [near];
  for (let h = 0; h < q.length; h++) {
    const p = q[h];
    const tr = ctx.terrainAt(key, p.x, p.y);
    if (tr.passable && !ctx.actorAt(key, p.x, p.y) && !ctx.featureAt(key, p.x, p.y)?.trap) return p;
    for (const d of DIRS) {
      const n = { x: p.x + DIR_VEC[d][0], y: p.y + DIR_VEC[d][1] };
      if (n.x < 0 || n.y < 0 || n.x >= f.width || n.y >= f.height) continue;
      const i = n.y * f.width + n.x;
      if (seen.has(i)) continue;
      seen.add(i);
      const t = ctx.terrainAt(key, n.x, n.y);
      if (t.passable || h < 2) q.push(n);
    }
  }
  return near;
}

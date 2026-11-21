// フロアの遅延生成（初めて入ったとき）。生成結果は floor_generated（地形 RLE）と entity_spawned で記録する。
// リプレイは生成器を必要としない。
import type { Entity, Expedition, Floor, FloorKey, Pos } from '@muse/shared';
import { DIRS, DIR_VEC, rleEncode } from '@muse/shared';
import type { Ctx } from './ctx';
import { activeEffects, floorGenTraits, placementFor, recordTargets } from './expedition';
import { currentExpedition } from '@muse/shared';
import { generateFloor } from './gen/generate';
import { spawnFromSpec } from './spawn';
import { placeSeasonFires } from './campfire';

/** 今のコンテンツの地形のうち、このランの地形の表に無いもの（古い版で始まったラン） */
export function missingTerrain(ctx: Ctx): string[] {
  const tt = new Set(ctx.world.meta.terrainTable);
  return ctx.content.terrain.map((tr) => tr.id).filter((id) => !tt.has(id));
}

/** 中にいる者を隠す地形の番号のうち、meta.concealTerrain に無いもの（表に足す地形 added を含めて数える） */
export function missingConceal(ctx: Ctx, added: readonly string[] = []): number[] {
  const have = new Set(ctx.world.meta.concealTerrain ?? []);
  return [...ctx.world.meta.terrainTable, ...added]
    .map((id, i) => (ctx.content.terrain[ctx.content.terrainIndex[id]]?.tags.includes('conceal') && !have.has(i) ? i : -1)).filter((i) => i >= 0);
}

/**
 * 古い版で始まったランの地形の表を、今のコンテンツに合わせる（V4-0a・V4-0b §1.2）: 無い地形を表の後ろに足し、
 * 中にいる者を隠す地形（背の高い草）の番号を concealTerrain に足す。番号は後ろに足すだけなので、作り済みの階は変わらない。
 * 階を作る前と、遠征の開始時に呼ぶ
 */
export function syncTerrainTable(ctx: Ctx): void {
  const added = missingTerrain(ctx);
  const concealAdded = missingConceal(ctx, added);
  if (!added.length && !concealAdded.length) return;
  ctx.emit({ type: 'terrain_table_extended', added, concealAdded, seenBy: [], floor: null, ft: 0 });
}

/** 階の並び（枝・深さの順）。遠征の開始時に全部の階を順に扱うときに使う */
export function floorOrder(a: string, b: string): number {
  const [ba, da] = a.split(':');
  const [bb, db] = b.split(':');
  return ba < bb ? -1 : ba > bb ? 1 : parseInt(da, 10) - parseInt(db, 10);
}

/**
 * 古い版で作った階に、作ったときに効いた条件を足す（V4-0e §8.1。V4-0b の syncTerrainTable と同じやり方）。階の性質（genTraits）を持たない階だけ。
 * 作った遠征は、階に残っている者（モンスター・地物。生成時の seq が sid）のうち最も古いものの sid が入る遠征の期間で決める
 * （モンスターは階を移らず、地物は動かない。アイテムは持ち運ばれるので数えない）。階に者が残っていなければ、その深さに初めて届いた遠征。
 * 遠征の外（ランの開始・節目の作り直し）で作った階と、目標階より深い階は条件が効いていないので空。遠征の開始時と、候補を作るときに呼ぶ
 */
export function noteFloorTraits(ctx: Ctx): void {
  const w = ctx.world;
  const missing = Object.keys(w.floors).filter((k) => !w.floors[k].genTraits).sort(floorOrder);
  if (!missing.length) return;
  const exps: Expedition[] = w.expeditions ?? [];
  const oldest = new Map<FloorKey, number>();
  for (const e of Object.values(w.entities)) {
    // 野営の火（S1）は階を作った後に置くので、作った遠征の手がかりにしない
    if (!e.pos || e.player || e.item || e.campfire || (!e.actor && !e.feature)) continue;
    const k = e.pos.floor;
    const cur = oldest.get(k);
    if (cur === undefined || e.sid < cur) oldest.set(k, e.sid);
  }
  const traits: Record<FloorKey, string[]> = {};
  for (const key of missing) {
    const f = w.floors[key];
    const sid = oldest.get(key);
    const x = sid !== undefined
      ? exps.find((e) => e.startSeq <= sid && (e.endSeq === null || sid <= e.endSeq))
      : f.branch === 'main' ? exps.find((e) => (e.result?.deepest ?? e.progress.maxDepth ?? 0) >= f.depth) : undefined;
    const inRange = !!x && (x.objective.targetDepth === null || f.depth <= x.objective.targetDepth);
    traits[key] = inRange ? floorGenTraits(ctx, x!.traits) : [];
  }
  ctx.emit({ type: 'floor_traits_noted', traits, seenBy: [], floor: null });
}

export function ensureFloor(ctx: Ctx, key: FloorKey): Floor {
  const existing = ctx.world.floors[key];
  if (existing) return existing;
  syncTerrainTable(ctx);
  const [branch, depthStr] = key.split(':');
  const depth = parseInt(depthStr, 10);
  // 遠征の目標階なら守護者・遺物を置く（生成の専用段。他の乱数ストリームはずれない）
  const objective = placementFor(ctx, branch, depth);
  // 遠征の条件は目標階までの新しい階に効く
  const x = currentExpedition(ctx.world);
  const fx = activeEffects(ctx);
  const inRange = !!x && (x.objective.targetDepth === null || depth <= x.objective.targetDepth);
  const mods = inRange && (x!.traits?.length ?? 0) > 0
    ? { monstersPct: fx.monstersPct, itemsPct: fx.itemsPct, treasurePct: fx.treasurePct, noFountain: fx.noFountain } : undefined;
  // シーズンのラン（S0 §9.3）: 入口と下り階段がシードと版だけで決まる生成
  const gen = generateFloor(ctx.content, ctx.world.secret.seed, branch, depth, ctx.world.meta.terrainTable, objective ?? undefined, mods, ctx.world.meta.season ? { season: true } : {});
  const { terrain, ...rest } = gen.floor;
  // 階は作られたときの性質を覚える（V4-0e §8.1）: 階を作るときに効いた条件（群れる・乏しい・静かの「泉なし」）。条件の無い階は空
  const floorData = { ...rest, genTraits: inRange ? floorGenTraits(ctx, x!.traits) : [] };
  const prevFloor = ctx.curFloor;
  const prevNow = ctx.now;
  ctx.curFloor = key;
  ctx.now = 0;
  ctx.emit({ type: 'floor_generated', floorData, terrainRle: rleEncode(terrain), seenBy: [], floor: key, ft: 0 });
  const spawned: Entity[] = [];
  // 棲み処の地物は、直前に置いた守護者のもの（V3-3c §44.6）
  let lastGuardian: string | null = null;
  let bountyId: string | null = null;
  for (const spec of gen.spawns) {
    const e = spawnFromSpec(ctx, key, spec, 'generated', spec.type === 'feature' && spec.lair && lastGuardian ? { lairOf: lastGuardian } : {});
    if (e.role === 'guardian') lastGuardian = e.id;
    if (spec.type === 'monster' && spec.objectiveBounty) bountyId = e.id;
    spawned.push(e);
  }
  // 賞金首・宝物庫（V3-8 §53.2）: 目的の強敵と、目標階の鍵のかかった格子扉の数
  const li = ctx.world.meta.terrainTable.indexOf('core:grate_locked');
  const vaultLocks = objective?.vault && li >= 0 ? terrain.filter((tv) => tv === li).length : 0;
  if (objective) recordTargets(ctx, spawned, { bounty: bountyId, vaultLocks });
  // 共有層の野営の火（S1 §9.10）: 作った後に置く（生成の乱数は使わない）
  placeSeasonFires(ctx, key);
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

// モンスター AI。状態機械 asleep → unaware → hunting → (見失い) searching → unaware。
// 行動様式は archetype ID でレジストリから選ぶ。パラメータはデータ側（monsters.json の ai）。
import type { MonsterDef } from '@muse/content';
import type { AiState, Entity, Pos } from '@muse/shared';
import { cheb, DIRS, DIR_VEC } from '@muse/shared';
import { melee, rangedAttack } from './combat';
import type { Ctx } from './ctx';
import { hasLos } from './geom';
import { isOpaqueFn, makeNoise, monsterSees, shotLine, updateMemory, wakeMonster } from './perception';
import { Registry } from './registry';
import { perkHook } from './build';
import { addStatus } from './statuses';

export interface AiInput { target: Entity | null; ai: AiState; def: MonsterDef }
/** 1 手番の行動を行い、行動コスト（標準 100）を返す */
export type Archetype = (ctx: Ctx, m: Entity, input: AiInput) => number;

export const archetypes = new Registry<Archetype>('archetype');

function monsterPassable(ctx: Ctx, key: string, x: number, y: number): boolean {
  const t = ctx.terrainAt(key, x, y);
  return t.passable || t.door === 'closed';
}

/** goal からの BFS 距離（地形のみ。step 内でキャッシュ） */
function distFrom(ctx: Ctx, key: string, goal: Pos): Int32Array {
  const ck = `dist|${key}|${goal.x},${goal.y}|${ctx.terrainVer.get(key) ?? 0}`;
  const cached = ctx.scratch.get(ck) as Int32Array | undefined;
  if (cached) return cached;
  const f = ctx.world.floors[key];
  const dist = new Int32Array(f.width * f.height).fill(-1);
  const q: number[] = [goal.y * f.width + goal.x];
  dist[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const cx = c % f.width, cy = (c - cx) / f.width;
    for (const d of DIRS) {
      const nx = cx + DIR_VEC[d][0], ny = cy + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
      const ni = ny * f.width + nx;
      if (dist[ni] >= 0 || !monsterPassable(ctx, key, nx, ny)) continue;
      dist[ni] = dist[c] + 1;
      q.push(ni);
    }
  }
  ctx.scratch.set(ck, dist);
  return dist;
}

/** 1 歩動く（閉じた扉なら開ける）。罠は避ける */
function stepTo(ctx: Ctx, m: Entity, to: Pos): boolean {
  const key = m.pos!.floor;
  const t = ctx.terrainAt(key, to.x, to.y);
  if (t.door === 'closed') {
    const open = ctx.world.meta.terrainTable.indexOf('core:door_open');
    if (open < 0) return false;
    ctx.emit({ type: 'tile_changed', x: to.x, y: to.y, terrain: open, reason: 'door_open', by: m.id, ...ctx.tileSeen(key, to, m), floor: key });
    makeNoise(ctx, key, to, 4, m);
    return true;
  }
  if (!t.passable || ctx.actorAt(key, to.x, to.y)) return false;
  const from = { x: m.pos!.x, y: m.pos!.y };
  const seen = ctx.perceive(key, [{ field: 'from', pos: from }, { field: 'to', pos: to }]);
  ctx.emit({ type: 'entity_moved', id: m.id, kind: m.kind, from, to: { x: to.x, y: to.y }, mode: 'walk', ...seen, floor: key });
  return true;
}

function freeNeighbors(ctx: Ctx, m: Entity): Pos[] {
  const key = m.pos!.floor;
  const out: Pos[] = [];
  for (const d of DIRS) {
    const x = m.pos!.x + DIR_VEC[d][0], y = m.pos!.y + DIR_VEC[d][1];
    if (!monsterPassable(ctx, key, x, y) || ctx.actorAt(key, x, y)) continue;
    if (ctx.featureAt(key, x, y)?.trap) continue;
    out.push({ x, y });
  }
  return out;
}

export function approach(ctx: Ctx, m: Entity, goal: Pos): boolean {
  const key = m.pos!.floor;
  const f = ctx.world.floors[key];
  const dist = distFrom(ctx, key, goal);
  const here = dist[m.pos!.y * f.width + m.pos!.x];
  let best: Pos | null = null;
  let bestD = here < 0 ? 1 << 30 : here;
  for (const p of freeNeighbors(ctx, m)) {
    const d = dist[p.y * f.width + p.x];
    if (d < 0) continue;
    if (d < bestD || (d === bestD && best === null && here < 0)) { best = p; bestD = d; }
  }
  if (!best) {
    // 直接の詰まり: 目標に近づく任意の隣接セル
    for (const p of freeNeighbors(ctx, m)) {
      if (cheb(p, goal) < cheb(m.pos!, goal)) { best = p; break; }
    }
  }
  return best ? stepTo(ctx, m, best) : false;
}

export function flee(ctx: Ctx, m: Entity, from: Pos): boolean {
  const key = m.pos!.floor;
  const f = ctx.world.floors[key];
  const dist = distFrom(ctx, key, from);
  const here = dist[m.pos!.y * f.width + m.pos!.x];
  let best: Pos | null = null;
  let bestD = here;
  for (const p of freeNeighbors(ctx, m)) {
    const d = dist[p.y * f.width + p.x];
    if (d > bestD) { best = p; bestD = d; }
  }
  if (!best) return false;
  for (const pr of ctx.playersOn(key)) {
    if (ctx.visibleSet(pr.id).has(m.pos!.y * f.width + m.pos!.x)) updateMemory(ctx, pr.id, m, (mm) => { mm.abilities.push('flees'); });
  }
  return stepTo(ctx, m, best);
}

function wander(ctx: Ctx, m: Entity): void {
  const rng = ctx.rng('runtime');
  if (rng.chance(55)) return;
  const opts = freeNeighbors(ctx, m).filter((p) => ctx.terrainAt(m.pos!.floor, p.x, p.y).passable);
  if (opts.length) stepTo(ctx, m, opts[rng.int(opts.length)]);
}

function hpPct(m: Entity): number {
  return m.stats ? Math.trunc((m.stats.hp * 100) / Math.max(1, m.stats.maxHp)) : 100;
}

/**
 * 持ち場を守る（V3-2R3b §23.2）: 持ち場から leash マスより離れていれば持ち場へ向かい、
 * 範囲の中では範囲の中だけを歩き回る
 */
function keepPost(ctx: Ctx, m: Entity, home: Pos): void {
  const leash = ctx.content.balance.guardian.leash;
  if (cheb(m.pos!, home) > leash) {
    if (approach(ctx, m, home)) return;
  }
  const rng = ctx.rng('runtime');
  if (rng.chance(55)) return;
  const opts = freeNeighbors(ctx, m).filter((p) => ctx.terrainAt(m.pos!.floor, p.x, p.y).passable && cheb(p, home) <= leash);
  if (opts.length) stepTo(ctx, m, opts[rng.int(opts.length)]);
}

function noTarget(ctx: Ctx, m: Entity, ai: AiState): number {
  // 見失った直後の捜索（最後に見た位置へ向かう）は追跡の続きとして今までどおり。捜索を終えたら持ち場へ戻る
  if (ai.state === 'searching' && ai.targetPos) {
    if (!approach(ctx, m, ai.targetPos)) { if (m.home) keepPost(ctx, m, m.home); else wander(ctx, m); }
  } else if (ai.state === 'unaware') {
    if (m.home) keepPost(ctx, m, m.home); else wander(ctx, m);
  }
  return 100;
}

/** 怯え（威圧。V3-4）の上乗せ: 逃げ出す HP の閾値に足す */
function cowedPct(m: Entity): number {
  return (m.statuses ?? []).find((s) => s.id === 'core:cowed')?.power ?? 0;
}

function chaser(defaultFlee: number): Archetype {
  return (ctx, m, { target, ai }) => {
    if (!target) return noTarget(ctx, m, ai);
    const fleeAt = (ai.params.fleeBelowHpPct ?? defaultFlee) + cowedPct(m);
    const adjacent = cheb(m.pos!, target.pos!) === 1;
    if (fleeAt > 0 && hpPct(m) < fleeAt) {
      if (flee(ctx, m, target.pos!)) return 100;
    }
    if (adjacent) { melee(ctx, m, target); return 100; }
    approach(ctx, m, target.pos!);
    return 100;
  };
}

archetypes.register('melee_chaser', chaser(0));
archetypes.register('skittish', chaser(50));
archetypes.register('pack', chaser(0));

archetypes.register('stationary', (ctx, m, { target }) => {
  if (target && cheb(m.pos!, target.pos!) === 1) melee(ctx, m, target);
  return 100;
});

archetypes.register('ranged_kiter', (ctx, m, { target, ai, def }) => {
  if (!target) return noTarget(ctx, m, ai);
  const d = cheb(m.pos!, target.pos!);
  const keepAway = ai.params.keepAway ?? 3;
  const range = def.ranged?.range ?? 0;
  if (d <= 1) {
    if (!flee(ctx, m, target.pos!)) melee(ctx, m, target);
    return 100;
  }
  if (d < keepAway && flee(ctx, m, target.pos!)) return 100;
  if (def.ranged && d <= range && clearShot(ctx, m, target)) {
    rangedAttack(ctx, m, target, def.ranged.dice, def.ranged.acc);
    return 100;
  }
  approach(ctx, m, target.pos!);
  return 100;
});

/** 射撃の経路: 視線が通り、投擲と同じ経路（双方向）が通ること。プレイヤーの shots と同じ判定 */
function clearShot(ctx: Ctx, m: Entity, target: Entity): boolean {
  const key = m.pos!.floor;
  if (!hasLos(m.pos!, target.pos!, isOpaqueFn(ctx, key))) return false;
  return shotLine(ctx, key, m.pos!, target.pos!) !== null;
}

function sameAi(a: AiState, b: AiState): boolean {
  return a.state === b.state && a.lostTurns === b.lostTurns
    && (a.targetPos?.x ?? -1) === (b.targetPos?.x ?? -1) && (a.targetPos?.y ?? -1) === (b.targetPos?.y ?? -1);
}

/** モンスターの 1 手番。行動コストを返す */
export function monsterTurn(ctx: Ctx, m: Entity): number {
  const ai = m.actor!.ai!;
  const def = ctx.content.monsters[m.kind];
  const key = m.pos!.floor;
  let target: Entity | null = null;
  let bestD = 1 << 30;
  for (const pr of ctx.playersOn(key)) {
    const pe = ctx.world.entities[pr.entityId];
    if (!monsterSees(ctx, m, pe)) continue;
    const d = cheb(m.pos!, pe.pos!);
    if (d < bestD) { bestD = d; target = pe; }
  }
  // 威圧（V3-4 §4.1）: 威圧を持つプレイヤーの隣にいる敵は怯える（逃げ出す HP の閾値が上がる）
  for (const pr of ctx.playersOn(key)) {
    const pe = ctx.world.entities[pr.entityId];
    const h = perkHook(ctx, pe, 'intimidate');
    if (h && pe.pos && cheb(pe.pos, m.pos!) === 1 && !(m.statuses ?? []).some((s) => s.id === 'core:cowed')) {
      addStatus(ctx, ctx.world.entities[m.id], 'core:cowed', h.turns ?? 3, h.fleePct ?? 25, pe.id);
      break;
    }
  }
  const next: AiState = { ...ai, targetPos: ai.targetPos ? { ...ai.targetPos } : null };
  if (target) {
    next.state = 'hunting';
    next.targetPos = { x: target.pos!.x, y: target.pos!.y };
    next.lostTurns = 0;
    if (ai.state !== 'hunting' && ai.archetype === 'pack') {
      const radius = ai.params.alertRadius ?? 6;
      for (const ally of ctx.entitiesOn(key)) {
        if (ally.id === m.id || ally.kind !== m.kind || !ally.actor?.ai || !ally.pos) continue;
        if (cheb(ally.pos, m.pos!) <= radius) wakeMonster(ctx, ally, next.targetPos);
      }
    }
  } else if (ai.state === 'hunting') {
    next.state = 'searching';
    next.lostTurns = 0;
  } else if (ai.state === 'searching') {
    next.lostTurns = ai.lostTurns + 1;
    const reached = next.targetPos && cheb(next.targetPos, m.pos!) === 0;
    if (reached || next.lostTurns > 25) {
      next.state = 'unaware';
      next.targetPos = null;
      next.lostTurns = 0;
    }
  } else if (ai.state === 'asleep') {
    next.state = 'unaware';
  }
  if (!sameAi(ai, next)) {
    ctx.emit({ type: 'ai_state_changed', id: m.id, ai: next, dormant: false, nextActAt: m.actor!.nextActAt, seenBy: [], floor: key });
  }
  const cur = ctx.world.entities[m.id];
  return archetypes.get(ai.archetype)(ctx, cur, { target, ai: next, def });
}

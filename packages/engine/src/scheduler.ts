// スケジューラ（速度ベース・フロア単位の時計）。
// プレイヤーがいるフロアごとに nextActAt 最小（同値は挿入順）のアクターを次の行動者にする。
// モンスターは AI が即決、プレイヤーならコマンドを待つ。プレイヤーがいないフロアは凍結。
import type { Entity, FloorKey } from '@muse/shared';
import { cheb, floorDiv } from '@muse/shared';
import { monsterTurn } from './ai';
import { heal } from './combat';
import type { Ctx } from './ctx';
import { pickMonster } from './gen/generate';
import { roll } from './registry';
import { updateKnowledge, wakeChecks, wakeMonster } from './perception';
import { spawnFromSpec } from './spawn';
import { actionDelay } from './stats';
import { tickStatuses } from './statuses';

export function endTurn(ctx: Ctx, e: Entity, cost: number): void {
  const cur = ctx.world.entities[e.id];
  if (!cur?.actor) return;
  ctx.emit({
    type: 'actor_scheduled', id: cur.id, nextActAt: cur.actor.nextActAt + actionDelay(ctx, cur, cost), turns: cur.actor.turns + 1,
    seenBy: cur.player ? [cur.player] : [], floor: cur.pos?.floor ?? ctx.curFloor,
  });
}

function nextActor(ctx: Ctx, key: FloorKey): Entity | null {
  let best: Entity | null = null;
  for (const e of ctx.entitiesOn(key)) {
    if (!e.actor || e.actor.dormant || (e.stats?.hp ?? 0) <= 0) continue;
    if (e.player && ctx.world.players[e.player]?.state !== 'alive') continue;
    if (!best || e.actor.nextActAt < best.actor!.nextActAt) best = e;
  }
  return best;
}

function regenInterval(e: Entity): number {
  return Math.max(3, 9 - floorDiv(e.level?.level ?? 1, 2));
}

function spawnWanderer(ctx: Ctx, key: FloorKey): void {
  const f = ctx.world.floors[key];
  const rng = ctx.rng('runtime');
  const biome = ctx.content.biomes[f.biome];
  const floorType = ctx.content.floorTypes[f.floorType];
  if (!biome || !floorType || floorType.monsters.per1000 === 0) return;
  const awake = ctx.entitiesOn(key).filter((e) => e.actor && !e.player && !e.actor.dormant).length;
  if (awake >= 30) return;
  const pick = pickMonster({ content: ctx.content, depth: f.depth, biome, floorType }, rng);
  if (!pick) return;
  const players = ctx.playersOn(key).map((p) => ctx.world.entities[p.entityId]);
  for (let tries = 0; tries < 100; tries++) {
    const x = rng.range(1, f.width - 2), y = rng.range(1, f.height - 2);
    const tr = ctx.terrainAt(key, x, y);
    if (!tr.passable || tr.stairs || ctx.actorAt(key, x, y) || ctx.featureAt(key, x, y)) continue;
    if (players.some((p) => cheb(p.pos!, { x, y }) < 12)) continue;
    if (ctx.seersOf(key, { x, y }).length) continue;
    const m = spawnFromSpec(ctx, key, {
      type: 'monster', kind: pick.def.id, x, y, hp: Math.max(1, roll(rng, pick.def.stats.hp)), affixes: [], tier: pick.tier, asleep: false, delay: 0,
    }, 'wander');
    const target = players[rng.int(players.length)];
    if (m && target?.pos && pick.def.ai.archetype !== 'stationary') wakeMonster(ctx, m, { x: target.pos.x, y: target.pos.y });
    return;
  }
}

/** プレイヤーの手番開始処理。コマンドを受け付けられるなら true */
function beginPlayerTurn(ctx: Ctx, pe: Entity): boolean {
  const key = pe.pos!.floor;
  const pr = ctx.world.players[pe.player!];
  const incap = tickStatuses(ctx, pe);
  let cur = ctx.world.entities[pe.id];
  if (!cur?.pos || pr.state !== 'alive' || ctx.world.status === 'ended') return false;
  // 自然回復
  if (cur.actor!.turns > 0 && cur.actor!.turns % regenInterval(cur) === 0 && cur.stats!.hp < cur.stats!.maxHp) heal(ctx, cur, 1, 'regen');
  // 徘徊モンスター（休憩し放題への圧力）
  const f = ctx.world.floors[key];
  if (!f.rules.noWander && cur.actor!.nextActAt >= f.nextWanderAt) {
    spawnWanderer(ctx, key);
    ctx.emit({ type: 'floor_wander', nextWanderAt: cur.actor!.nextActAt + 4000 + ctx.rng('runtime').int(2000), seenBy: [], floor: key });
  }
  // 罠の発見
  const cls = ctx.content.classes[pr.classId];
  for (const e of ctx.entitiesOn(key)) {
    if (!e.trap || !e.pos || e.trap.revealedTo.includes(pr.id)) continue;
    if (cheb(e.pos, cur.pos) > 1) continue;
    if (ctx.rng('runtime').chance(cls?.searchPct ?? 15)) {
      ctx.emit({ type: 'trap_revealed', trap: e.id, kind: e.kind, player: pr.id, pos: { x: e.pos.x, y: e.pos.y }, seenBy: [pr.id], floor: key });
    }
  }
  wakeChecks(ctx, key);
  updateKnowledge(ctx, key);
  cur = ctx.world.entities[pe.id];
  if (incap) {
    endTurn(ctx, cur, 100);
    return false;
  }
  ctx.emit({ type: 'turn_began', actor: cur.id, time: cur.actor!.nextActAt, seenBy: 'all', floor: key });
  return true;
}

/** フロアの時間を、次にプレイヤーの入力が必要になるまで進める */
export function advance(ctx: Ctx, key: FloorKey): void {
  for (let guard = 0; guard < 50000; guard++) {
    if (ctx.world.status === 'ended') return;
    const f = ctx.world.floors[key];
    if (!f || f.currentActor) return;
    if (!ctx.playersOn(key).length) return;
    const actor = nextActor(ctx, key);
    if (!actor) return;
    ctx.now = actor.actor!.nextActAt;
    ctx.curFloor = key;
    if (actor.player) {
      if (beginPlayerTurn(ctx, actor)) return;
      continue;
    }
    const incap = tickStatuses(ctx, actor);
    let cur = ctx.world.entities[actor.id];
    if (!cur || (cur.stats?.hp ?? 0) <= 0) continue;
    const cost = incap ? 100 : monsterTurn(ctx, cur);
    cur = ctx.world.entities[actor.id];
    if (cur?.actor && (cur.stats?.hp ?? 0) > 0 && cur.pos?.floor === key) endTurn(ctx, cur, cost);
    updateKnowledge(ctx, key);
  }
  throw new Error(`scheduler did not converge on ${key}`);
}

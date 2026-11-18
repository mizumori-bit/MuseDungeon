// スケジューラ（速度ベース・フロア単位の時計）。
// プレイヤーがいるフロアごとに nextActAt 最小（同値は挿入順）のアクターを次の行動者にする。
// モンスターは AI が即決、プレイヤーならコマンドを待つ。プレイヤーがいないフロアは凍結。
import type { Entity, FloorKey } from '@muse/shared';
import { boonHookSum, cheb, floorDiv, regenInterval, regenStep, restCapHp } from '@muse/shared';
import { wanderPct } from './expedition';
import { monsterTurn } from './ai';
import { heal } from './combat';
import type { Ctx } from './ctx';
import { pickMonster } from './gen/generate';
import { roll } from './registry';
import { updateKnowledge, wakeChecks, wakeMonster } from './perception';
import { spawnFromSpec } from './spawn';
import { actionDelay } from './stats';
import { tickStatuses } from './statuses';

/**
 * プレイヤーの自然回復を 1 手番進める（回復があれば healed を出す）。新しい蓄積値を返す。
 * restful: 追跡中の敵が見えない状態での wait（休息）。回復の速さが restMultiplier 倍になる。
 */
export function regenTick(ctx: Ctx, e: Entity, restful: boolean): number | undefined {
  const cur = ctx.world.entities[e.id];
  if (!cur?.player || !cur.stats || !cur.actor) return undefined;
  const rules = ctx.content.balance.regen;
  // 休憩と自然回復は最大 HP の rest.capPct % まで（それより上は薬・立て直し・泉・レベルアップ・キャンプで。V3-4b §28.3）
  const limit = restCapHp({ restCapPct: ctx.content.balance.rest.capPct }, cur.stats.maxHp);
  // 加護（息吹。V3-3 §3.3）: 自然回復の間隔を縮める（観測の見積もりも同じ式）
  const delta = boonHookSum(ctx.content.boons, cur.boons, 'regen', 'interval');
  const r = regenStep(cur.actor.regen ?? 0, cur.stats.hp, limit, restful ? rules.restMultiplier : 1, regenInterval(ctx.content.balance, cur.level?.level ?? 1, delta));
  if (r.heal > 0) heal(ctx, cur, r.heal, restful ? 'rest' : 'regen');
  return r.acc;
}

export function endTurn(ctx: Ctx, e: Entity, cost: number, restful = false): void {
  const regenAfter = regenTick(ctx, e, restful);
  const cur = ctx.world.entities[e.id];
  if (!cur?.actor) return;
  ctx.emit({
    type: 'actor_scheduled', id: cur.id, nextActAt: cur.actor.nextActAt + actionDelay(ctx, cur, cost), turns: cur.actor.turns + 1,
    ...(regenAfter !== undefined ? { regenAfter } : {}),
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

function spawnWanderer(ctx: Ctx, key: FloorKey): void {
  const f = ctx.world.floors[key];
  const rng = ctx.rng('runtime');
  const biome = ctx.content.biomes[f.biome];
  const floorType = ctx.content.floorTypes[f.floorType];
  const wb = ctx.content.balance.wander;
  if (!biome || !floorType || floorType.monsters.per1000 === 0) return;
  const awake = ctx.entitiesOn(key).filter((e) => e.actor && !e.player && !e.actor.dormant).length;
  if (awake >= wb.maxAwake) return;
  const pick = pickMonster({ content: ctx.content, depth: f.depth, biome, floorType }, rng);
  if (!pick) return;
  const players = ctx.playersOn(key).map((p) => ctx.world.entities[p.entityId]);
  for (let tries = 0; tries < 100; tries++) {
    const x = rng.range(1, f.width - 2), y = rng.range(1, f.height - 2);
    const tr = ctx.terrainAt(key, x, y);
    if (!tr.passable || tr.stairs || ctx.actorAt(key, x, y) || ctx.featureAt(key, x, y)) continue;
    if (players.some((p) => cheb(p.pos!, { x, y }) < wb.minDistance)) continue;
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
  // 前の手番のあいだに 2 回動いたのを見た敵（V3-8 §53.4）
  const seen = ctx.actsSeen.get(pr.id);
  if (seen) {
    const ids = [...seen.entries()].filter(([, n]) => n >= 2).map(([id]) => id).sort();
    if (ids.length) ctx.emit({ type: 'pace_seen', player: pr.id, ids, turn: pe.actor?.turns ?? 0, seenBy: [pr.id], floor: key });
    ctx.actsSeen.delete(pr.id);
  }
  const incap = tickStatuses(ctx, pe);
  let cur = ctx.world.entities[pe.id];
  if (!cur?.pos || pr.state !== 'alive' || ctx.world.status === 'ended') return false;
  // 自然回復は手番の終わり（endTurn）で蓄積値として進める
  // 徘徊モンスター（休憩し放題への圧力）
  const f = ctx.world.floors[key];
  // 時間で消える地物（毒の雲。V3-5 §5.2）
  for (const c of ctx.entitiesOn(key)) {
    if (c.feature?.expiresAt !== undefined && c.feature.expiresAt <= f.time) ctx.emit({ type: 'entity_removed', id: c.id, kind: c.kind, reason: 'expired', seenBy: ctx.seersOf(key, c.pos!), floor: key });
  }
  const wb = ctx.content.balance.wander;
  if (!f.rules.noWander && cur.actor!.nextActAt >= f.nextWanderAt) {
    // 遠征の条件と、目的達成後の圧力で間隔が変わる
    const wp = wanderPct(ctx);
    if (!wp.none) spawnWanderer(ctx, key);
    const base = wb.intervalMin + ctx.rng('runtime').int(Math.max(1, wb.intervalMax - wb.intervalMin));
    // 階の異変「溢れた宝」（V3-5 §5.3）: 徘徊の湧きも多い（間隔が半分）
    const glut = f.event?.handler === 'treasure_glut' ? 50 : 100;
    ctx.emit({ type: 'floor_wander', nextWanderAt: cur.actor!.nextActAt + Math.max(1, floorDiv(base * wp.pct * glut, 10000)), seenBy: [], floor: key });
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
    // 見ていた行動の回数（V3-8 §53.4。自分の手番が来たら 2 回のものを知識に残す）
    if (cur?.pos && !incap) {
      const f2 = ctx.world.floors[key];
      for (const pr of ctx.playersOn(key)) {
        if (!ctx.visibleSet(pr.id).has(cur.pos.y * f2.width + cur.pos.x)) continue;
        const m = ctx.actsSeen.get(pr.id) ?? new Map<string, number>();
        m.set(cur.id, (m.get(cur.id) ?? 0) + 1);
        ctx.actsSeen.set(pr.id, m);
      }
    }
  }
  throw new Error(`scheduler did not converge on ${key}`);
}

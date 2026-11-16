// 戦闘（整数のみ）。命中: d20 + acc >= 10 + eva。20 は必中＋クリティカル（ダイス 2 倍）、1 は必ず外れ。
// ダメージ: ダイス + might - armor、最低 1。
import type { DamageVia, Entity, PlayerId, PlayerRecord, RunSummary, RunSummaryPlayer } from '@muse/shared';
import { xpForLevel } from '@muse/shared';
import type { Ctx } from './ctx';
import { applyEffects } from './effects';
import { maybeEndExpedition } from './expedition';
import { pickLoot } from './gen/generate';
import { makeNoise, updateMemory, wakeMonster } from './perception';
import { roll } from './registry';
import { makeItem } from './spawn';
import { effectiveStats } from './stats';
import { hasStatus, removeStatus } from './statuses';

export interface AttackOutcome { hit: boolean; crit: boolean; roll: number }

function isSleeping(e: Entity): boolean {
  return !!e.actor?.dormant || e.actor?.ai?.state === 'asleep' || hasStatus(e, 'core:sleep');
}

export function rollToHit(ctx: Ctx, attacker: Entity, target: Entity, accBonus: number): AttackOutcome {
  const r = ctx.rng('runtime').range(1, 20);
  const acc = (attacker.stats?.acc ?? 0) + accBonus + (isSleeping(target) ? 5 : 0);
  const eva = target.stats?.eva ?? 0;
  const hit = r === 20 || (r !== 1 && r + acc >= 10 + eva);
  return { hit, crit: r === 20, roll: r };
}

function emitAttack(ctx: Ctx, attacker: Entity, target: Entity, o: AttackOutcome, ranged: boolean): void {
  const key = attacker.pos!.floor;
  // 見えていない側は ID だけでなく位置（from/to）も伏せる
  const seen = ctx.perceive(key, [
    { field: 'attacker', pos: attacker.pos, entity: attacker.id },
    { field: 'from', pos: attacker.pos, entity: attacker.id },
    { field: 'target', pos: target.pos, entity: target.id },
    { field: 'to', pos: target.pos, entity: target.id },
  ]);
  ctx.emit({
    type: 'attack', attacker: attacker.id, attackerKind: attacker.kind, target: target.id, targetKind: target.kind,
    roll: o.roll, hit: o.hit, crit: o.crit, ranged,
    from: { x: attacker.pos!.x, y: attacker.pos!.y }, to: { x: target.pos!.x, y: target.pos!.y }, ...seen,
  });
}

/** 近接攻撃（バンプ攻撃） */
export function melee(ctx: Ctx, attacker: Entity, target: Entity): void {
  const o = rollToHit(ctx, attacker, target, 0);
  emitAttack(ctx, attacker, target, o, false);
  makeNoise(ctx, attacker.pos!.floor, target.pos!, 5, attacker);
  if (o.hit) {
    const dmg = Math.max(1, roll(ctx.rng('runtime'), attacker.stats!.dmg, o.crit) + attacker.stats!.might - (target.stats?.armor ?? 0));
    applyDamage(ctx, target, dmg, attacker, 'melee');
    if ((ctx.world.entities[target.id]?.stats?.hp ?? 0) > 0) onHitEffects(ctx, attacker, ctx.world.entities[target.id]);
  } else provoke(ctx, target, attacker);
}

/** 遠隔攻撃（モンスターの射撃） */
export function rangedAttack(ctx: Ctx, attacker: Entity, target: Entity, dice: string, accBonus: number): void {
  const o = rollToHit(ctx, attacker, target, accBonus);
  emitAttack(ctx, attacker, target, o, true);
  for (const pr of ctx.playersOn(attacker.pos!.floor)) updateMemory(ctx, pr.id, attacker.kind, (m) => { m.abilities.push('ranged'); });
  if (o.hit) {
    const dmg = Math.max(1, roll(ctx.rng('runtime'), dice, o.crit) - (target.stats?.armor ?? 0));
    applyDamage(ctx, target, dmg, attacker, 'ranged');
  } else provoke(ctx, target, attacker);
}

function onHitEffects(ctx: Ctx, attacker: Entity, target: Entity): void {
  const def = ctx.content.monsters[attacker.kind];
  const effects = [...(def?.attack.onHit ?? [])];
  for (const a of attacker.scale?.affixes ?? []) effects.push(...(ctx.content.affixes[a]?.onHit ?? []));
  if (!effects.length) return;
  applyEffects(ctx, effects, { user: attacker, target, pos: target.pos!, source: attacker, via: 'melee' });
}

/** 攻撃された（外れた）モンスターは攻撃者に気づく */
function provoke(ctx: Ctx, target: Entity, attacker: Entity): void {
  if (target.actor?.ai && attacker.pos) {
    if (hasStatus(target, 'core:sleep')) removeStatus(ctx, target, 'core:sleep');
    wakeMonster(ctx, target, { x: attacker.pos.x, y: attacker.pos.y });
  }
}

export function applyDamage(ctx: Ctx, target: Entity, amount: number, source: Entity | null, via: DamageVia): void {
  const t = ctx.world.entities[target.id];
  if (!t?.stats || t.stats.hp <= 0) return;
  const hpAfter = Math.max(0, t.stats.hp - amount);
  // 実際に減った HP（とどめの超過分を含めない）
  const dealt = t.stats.hp - hpAfter;
  const key = t.pos?.floor ?? null;
  const seen: { seenBy: PlayerId[]; masks?: Record<PlayerId, string[]> } = key ? ctx.perceive(key, [
    { field: 'target', pos: t.pos, entity: t.id },
    { field: 'source', pos: source?.pos ?? null, entity: source?.id ?? null },
  ], t.player ? [t.player] : []) : { seenBy: t.player ? [t.player] : [] };
  // 見ていたプレイヤーごとの、この個体への累計実ダメージ（after 値）
  let seenTotals: Record<PlayerId, number> | undefined;
  if (!t.player && t.actor && dealt > 0) {
    for (const pid of seen.seenBy) {
      if (seen.masks?.[pid]?.includes('target')) continue;
      const prev = ctx.world.players[pid]?.knowledge.damageSeen?.[t.id] ?? 0;
      (seenTotals ??= {})[pid] = prev + dealt;
    }
  }
  ctx.emit({
    type: 'damaged', target: t.id, targetKind: t.kind, amount, hpAfter, dealt,
    source: source?.id ?? null, sourceKind: source?.kind ?? null, via, ...(seenTotals ? { seenTotals } : {}), ...seen,
  });
  // 思い出（受けたダメージは脅威の見積もり用に出目どおり、与えたダメージは実ダメージ）
  if (source && t.player && !source.player) {
    updateMemory(ctx, t.player, source.kind, (m) => { m.maxDamageToYou = Math.max(m.maxDamageToYou, amount); });
  }
  if (source?.player && !t.player && t.actor) {
    updateMemory(ctx, source.player, t.kind, (m) => { m.maxDamageByYou = Math.max(m.maxDamageByYou, dealt); });
  }
  if (hpAfter <= 0) {
    kill(ctx, ctx.world.entities[t.id], source, via);
    return;
  }
  const cur = ctx.world.entities[t.id];
  if (hasStatus(cur, 'core:sleep') && via !== 'poison') removeStatus(ctx, cur, 'core:sleep');
  if (source && cur.actor?.ai) provoke(ctx, cur, source);
}

export function heal(ctx: Ctx, target: Entity, amount: number, via: string): void {
  const t = ctx.world.entities[target.id];
  if (!t?.stats) return;
  const hpAfter = Math.min(t.stats.maxHp, t.stats.hp + Math.max(0, amount));
  const gained = hpAfter - t.stats.hp;
  if (gained <= 0) return;
  const seen = t.pos ? ctx.perceive(t.pos.floor, [{ field: 'target', pos: t.pos, entity: t.id }], t.player ? [t.player] : []) : { seenBy: t.player ? [t.player] : [] };
  ctx.emit({ type: 'healed', target: t.id, targetKind: t.kind, amount: gained, hpAfter, via, ...seen });
}

export function kill(ctx: Ctx, victim: Entity, killer: Entity | null, via: DamageVia): void {
  const key = victim.pos!.floor;
  const pos = { x: victim.pos!.x, y: victim.pos!.y };
  const seen = ctx.perceive(key, [
    { field: 'id', pos: victim.pos, entity: victim.id },
    { field: 'pos', pos: victim.pos, entity: victim.id },
    { field: 'killer', pos: killer?.pos ?? null, entity: killer?.id ?? null },
  ], victim.player ? [victim.player] : []);
  if (victim.player) {
    // 手番中に死んだらフロアの手番待ちを解除する
    if (ctx.world.floors[key].currentActor === victim.id) {
      ctx.emit({ type: 'actor_scheduled', id: victim.id, nextActAt: victim.actor!.nextActAt, turns: victim.actor!.turns, seenBy: [victim.player], floor: key });
    }
    // プレイヤーは盤面から消える（記録は残る）
    const { pos: _p, ...rest } = structuredClone(victim);
    const body = { ...rest, actor: rest.actor ? { ...rest.actor, dormant: true } : undefined };
    ctx.emit({ type: 'died', id: victim.id, kind: victim.kind, killer: killer?.id ?? null, killerKind: killer?.kind ?? null, via, pos, put: [body], ...seen });
    const pr = ctx.world.players[victim.player];
    const cause = killer ? killer.kind : via;
    ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...pr.stats, deathCause: cause, endedSeq: ctx.world.seq + 1 }, seenBy: [pr.id] });
    ctx.emit({ type: 'player_state', player: pr.id, state: 'dead', reason: cause, seenBy: 'all' });
    maybeEndExpedition(ctx);
    checkRunEnd(ctx);
    return;
  }
  // 目の前で倒れた個体は最大 HP が分かる（見えていない者には伏せる）
  const maxHp = victim.stats?.maxHp ?? null;
  const masks = { ...(seen.masks ?? {}) };
  for (const pid of seen.seenBy) if (masks[pid]?.includes('id')) masks[pid] = [...masks[pid], 'maxHp'];
  ctx.emit({
    type: 'died', id: victim.id, kind: victim.kind, killer: killer?.id ?? null, killerKind: killer?.kind ?? null, via, pos, maxHp,
    seenBy: seen.seenBy, ...(Object.keys(masks).length ? { masks } : {}),
  });
  if (maxHp !== null && victim.role !== 'guardian') {
    for (const pid of seen.seenBy) {
      if (masks[pid]?.includes('id')) continue;
      updateMemory(ctx, pid, victim.kind, (m) => {
        m.hpSeen = m.hpSeen
          ? { min: Math.min(m.hpSeen.min, maxHp), max: Math.max(m.hpSeen.max, maxHp), samples: m.hpSeen.samples + 1 }
          : { min: maxHp, max: maxHp, samples: 1 };
      });
    }
  }
  // ドロップ
  const def = ctx.content.monsters[victim.kind];
  const rng = ctx.rng('runtime');
  const depth = ctx.world.floors[key].depth;
  for (const d of def?.drops ?? []) {
    if (!rng.chance(d.chancePct)) continue;
    const l = pickLoot(ctx.content, d.table, depth, rng);
    if (!l) continue;
    const it = makeItem(key, l.kind, pos.x, pos.y, l.qty, l.affixes, ctx.newEntityId(), ctx.nextSid());
    ctx.emit({ type: 'entity_spawned', entity: it, reason: 'drop', floor: key, seenBy: ctx.seersOf(key, pos) });
  }
  ctx.emit({ type: 'entity_removed', id: victim.id, kind: victim.kind, reason: 'died', seenBy: ctx.seersOf(key, pos), floor: key });
  if (killer?.player) {
    const pr = ctx.world.players[killer.player];
    ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...pr.stats, kills: pr.stats.kills + 1 }, seenBy: [pr.id] });
    updateMemory(ctx, pr.id, victim.kind, (m) => { m.kills += 1; });
    grantXp(ctx, ctx.world.entities[killer.id], victim.xp ?? 0);
  }
}

export function grantXp(ctx: Ctx, e: Entity, amount: number): void {
  if (!e.level || amount <= 0) return;
  const xpAfter = e.level.xp + amount;
  ctx.emit({ type: 'xp_gained', target: e.id, amount, xpAfter, seenBy: e.player ? [e.player] : [] });
  let cur = ctx.world.entities[e.id];
  const cls = ctx.content.classes[ctx.world.players[e.player!]?.classId ?? ''];
  while (cur.level && cur.level.xp >= xpForLevel(cur.level.level)) {
    const lv = cur.level.level + 1;
    const lu = cls?.levelUp ?? { hp: 4, accEvery: 2, mightEvery: 3, evaEvery: 4 };
    const base = { ...cur.base! };
    base.maxHp += lu.hp;
    if (lu.accEvery && lv % lu.accEvery === 0) base.acc += 1;
    if (lu.mightEvery && lv % lu.mightEvery === 0) base.might += 1;
    if (lu.evaEvery && lv % lu.evaEvery === 0) base.eva += 1;
    const tmp: Entity = { ...cur, base, stats: { ...cur.stats!, hp: cur.stats!.hp + lu.hp } };
    const stats = effectiveStats(ctx, tmp);
    ctx.emit({ type: 'level_up', target: e.id, levelAfter: lv, xpAfter: cur.level.xp, statsAfter: stats, baseAfter: base, seenBy: e.player ? [e.player] : [] });
    cur = ctx.world.entities[e.id];
  }
}

export function scoreOf(ctx: Ctx, p: { deepest: number; kills: number; level: number; expeditionPoints?: number }): number {
  const s = ctx.content.balance.score;
  return p.deepest * s.perDepth + p.kills * s.perKill + p.level * s.perLevel + (p.expeditionPoints ?? 0);
}

/** hideSeed: ラン継続中（遠征の終了時）の要約ではシードを伏せる */
export function buildSummary(ctx: Ctx, reason: string, hideSeed = false): RunSummary {
  const players: RunSummaryPlayer[] = ctx.world.playerOrder.map((pid) => {
    const pr: PlayerRecord = ctx.world.players[pid];
    const e = ctx.world.entities[pr.entityId];
    const equipment: RunSummaryPlayer['equipment'] = {};
    for (const slot of ['weapon', 'armor', 'accessory'] as const) {
      const id = e?.equip?.[slot];
      if (id && ctx.world.entities[id]) equipment[slot] = ctx.world.entities[id].kind;
    }
    const level = e?.level?.level ?? 1;
    return {
      id: pid, name: pr.name, classId: pr.classId, controller: pr.controller, level,
      deepest: pr.stats.deepest, turns: e?.actor?.turns ?? 0, kills: pr.stats.kills, state: pr.state,
      deathCause: pr.stats.deathCause, equipment,
      score: scoreOf(ctx, { deepest: pr.stats.deepest, kills: pr.stats.kills, level, expeditionPoints: pr.stats.expeditionPoints }),
      expeditions: pr.stats.expeditions ?? 0,
    };
  });
  const expeditions = (ctx.world.expeditions ?? []).map((x) => ({
    no: x.no, objective: { ...x.objective }, status: x.status, endReason: x.endReason, points: x.points, startSeq: x.startSeq, endSeq: x.endSeq,
  }));
  return { runId: ctx.world.meta.runId, reason, seed: hideSeed ? '' : ctx.world.secret.seed, endedSeq: ctx.world.seq + 1, players, expeditions };
}

export function endRun(ctx: Ctx, reason: string): void {
  if (ctx.world.status === 'ended') return;
  ctx.emit({ type: 'run_ended', reason, summary: buildSummary(ctx, reason), seenBy: 'all', floor: null });
}

/** 盤面かキャンプに誰も残っていなければランを終える */
export function checkRunEnd(ctx: Ctx): void {
  const anyPresent = ctx.world.playerOrder.some((pid) => {
    const s = ctx.world.players[pid].state;
    return s === 'alive' || s === 'at_camp';
  });
  if (!anyPresent && ctx.world.playerOrder.length > 0) endRun(ctx, 'all_players_gone');
}

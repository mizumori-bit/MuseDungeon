// 守護者の型と弱点の振る舞い（V3-3 §3.1・§28.9）。登録は index.ts の読み込みで行う（guardians.ts のレジストリへ）。
import type { Entity, Pos } from '@muse/shared';
import { cheb, DIR_VEC, floorDiv } from '@muse/shared';
import { approach, flee, freeNeighbors, hpPct, stepTo } from './ai';
import { melee } from './combat';
import type { Ctx } from './ctx';
import { pickMonster } from './gen/generate';
import { guardianTypeHandlers, lineDir, playerSees, setGuardian, setIntent, weaknessHandlers } from './guardians';
import { wakeMonster } from './perception';
import { spawnFromSpec } from './spawn';
import { addStatus } from './statuses';
import { roll } from './registry';

/** 守護者のしたことを、見えている者に知らせる */
function acted(ctx: Ctx, m: Entity, act: 'summoned' | 'charged' | 'missed' | 'enraged', count?: number): void {
  if (!m.pos || !m.guardian) return;
  const seen = ctx.perceive(m.pos.floor, [{ field: 'id', pos: m.pos, entity: m.id }], []);
  if (!seen.seenBy.length) return;
  ctx.emit({ type: 'guardian_acted', id: m.id, kind: m.kind, guardianName: { ...m.guardian.name }, act, ...(count !== undefined ? { count } : {}), ...seen, floor: m.pos.floor });
}

// ---- 呼び集める者: 体力が 75%・50%・25% を切るたびに、1 手の予兆の後、手下を呼ぶ ----
const SUMMON_AT = [75, 50, 25];
guardianTypeHandlers.register('summoner', {
  turn(ctx, m, { target, params }) {
    const g = m.guardian!;
    if (m.actor!.ai!.intent?.kind === 'summoning') {
      const n = summonMinions(ctx, m, params.count ?? 2, target);
      setGuardian(ctx, m, (e) => { e.guardian!.summoned = (e.guardian!.summoned ?? 0) + 1; if (e.actor?.ai) delete e.actor.ai.intent; });
      acted(ctx, ctx.world.entities[m.id], 'summoned', n);
      return 100;
    }
    const next = SUMMON_AT[g.summoned ?? 0];
    if (target && next !== undefined && hpPct(m) < next) { setIntent(ctx, m, { kind: 'summoning' }); return 100; }
    return null;
  },
});

function summonMinions(ctx: Ctx, m: Entity, count: number, target: Entity | null): number {
  const key = m.pos!.floor;
  const f = ctx.world.floors[key];
  const biome = ctx.content.biomes[f.biome];
  const floorType = ctx.content.floorTypes[f.floorType];
  if (!biome || !floorType) return 0;
  const rng = ctx.rng('runtime');
  let n = 0;
  for (const p of freeNeighbors(ctx, m)) {
    if (n >= count) break;
    const pick = pickMonster({ content: ctx.content, depth: f.depth, biome, floorType }, rng);
    if (!pick || pick.def.ai.archetype === 'stationary') continue;
    const s = spawnFromSpec(ctx, key, { type: 'monster', kind: pick.def.id, x: p.x, y: p.y, hp: Math.max(1, roll(rng, pick.def.stats.hp)), affixes: [], tier: pick.tier, asleep: false, delay: 0 }, 'summoned');
    // 呼んだ守護者の印（落ち着くと去る。V3-3b §40.3）
    if (s) { const b = structuredClone(s); b.minionOf = m.id; ctx.emit({ type: 'guardian_state', id: s.id, put: [b], seenBy: [], floor: key }); }
    if (s && target?.pos) wakeMonster(ctx, ctx.world.entities[s.id] ?? s, { x: target.pos.x, y: target.pos.y });
    n++;
  }
  return n;
}

// ---- 突き進む者: 直線上に相手がいると 1 手構え、次の手番にその直線を突進する ----
guardianTypeHandlers.register('charger', {
  order: 1,
  turn(ctx, m, { target, params }) {
    const ai = m.actor!.ai!;
    const range = params.range ?? 6;
    const key = m.pos!.floor;
    if (ai.intent?.kind === 'winding_up' && ai.intent.dir) {
      const dir = ai.intent.dir;
      setIntent(ctx, m, null);
      let hit = false;
      for (let k = 0; k < range; k++) {
        const cur = ctx.world.entities[m.id];
        if (!cur?.pos) break;
        const nx = cur.pos.x + DIR_VEC[dir][0], ny = cur.pos.y + DIR_VEC[dir][1];
        const occ = ctx.actorAt(key, nx, ny);
        if (occ?.player) { melee(ctx, cur, occ, { dmgMult: params.mult ?? 2 }); hit = true; break; }
        const tr = ctx.terrainAt(key, nx, ny);
        if (occ || !tr.passable) break;
        if (!stepTo(ctx, cur, { x: nx, y: ny })) break;
      }
      const after = ctx.world.entities[m.id];
      if (!hit && after) {
        // 外れた: 1 手無防備
        addStatus(ctx, after, 'core:stun', 1, 0);
        acted(ctx, ctx.world.entities[m.id], 'missed');
      } else if (after) acted(ctx, after, 'charged');
      return 100;
    }
    if (target?.pos) {
      const d = cheb(m.pos!, target.pos);
      const dir = lineDir(m.pos!, target.pos);
      if (dir && d >= 2 && d <= range && clearLine(ctx, key, m.pos!, dir, d)) { setIntent(ctx, m, { kind: 'winding_up', dir }); return 100; }
    }
    return null;
  },
});

function clearLine(ctx: Ctx, key: string, from: Pos, dir: keyof typeof DIR_VEC, d: number): boolean {
  for (let k = 1; k < d; k++) {
    const x = from.x + DIR_VEC[dir][0] * k, y = from.y + DIR_VEC[dir][1] * k;
    if (!ctx.terrainAt(key, x, y).passable || ctx.actorAt(key, x, y)) return false;
  }
  return true;
}

// ---- 護られし者: 護りの火が 1 つでも灯っている間、装甲が上がる ----
guardianTypeHandlers.register('warded', {
  armor(ctx, m, params) {
    if (!m.pos) return 0;
    const lit = ctx.entitiesOn(m.pos.floor).some((e) => e.kind === 'core:ward_fire' && e.feature?.state === 'lit');
    return lit ? params.armor ?? 4 : 0;
  },
});

// ---- 荒ぶる者: 体力が 50% 以下になると、1 手の予兆の後に怒る ----
guardianTypeHandlers.register('enrager', {
  turn(ctx, m, { target, params }) {
    const g = m.guardian!;
    if (m.actor!.ai!.intent?.kind === 'enraging') {
      setGuardian(ctx, m, (e) => {
        e.guardian!.enraged = true;
        if (e.actor?.ai) delete e.actor.ai.intent;
        e.actor!.speed += params.speed ?? 30;
        e.stats!.might += params.might ?? 2;
        if (e.base) e.base.might += params.might ?? 2;
      });
      acted(ctx, ctx.world.entities[m.id], 'enraged');
      return 100;
    }
    if (!g.enraged && target && hpPct(m) <= (params.belowPct ?? 50)) { setIntent(ctx, m, { kind: 'enraging' }); return 100; }
    return null;
  },
});

// ---- 潜む者: 眠らない。見られている間は近づかず、視界の外を通って寄る。視界の外から隣に来た一撃は会心で、その後は退いて隠れ直す ----
// 見られたまま LURK_MAX 手番隠れていたら、見えたまま寄ってくる（通路で待つ・扉を閉めると、背後から襲えない）
// 一度気づいた相手は、見失っても sense マス以内にいる限り居場所を追い続ける（視界の外を回り込むため）
const LURK_MAX = 4;

/** 気づいている潜む者が、見えていない相手の居場所を追う（近い順・同じ距離は id 順） */
function sensePlayer(ctx: Ctx, m: Entity, radius: number): Entity | null {
  let best: Entity | null = null;
  let bestD = radius + 1;
  for (const pr of ctx.playersOn(m.pos!.floor)) {
    const pe = ctx.world.entities[pr.entityId];
    if (!pe?.pos || (pe.stats?.hp ?? 0) <= 0) continue;
    const d = cheb(pe.pos, m.pos!);
    if (d < bestD || (d === bestD && best && pe.id < best.id)) { best = pe; bestD = d; }
  }
  return best;
}

/** 追い続けている間は、捜索の行き先を相手の居場所に更新する（見失って持ち場に戻らないように） */
function keepTrail(ctx: Ctx, m: Entity, pos: Pos): void {
  const cur = ctx.world.entities[m.id];
  const ai = cur?.actor?.ai;
  if (!ai) return;
  const next = { ...ai, state: 'searching' as const, targetPos: { x: pos.x, y: pos.y }, lostTurns: 0 };
  ctx.emit({ type: 'ai_state_changed', id: m.id, ai: next, dormant: false, nextActAt: cur.actor!.nextActAt, seenBy: [], floor: cur.pos?.floor ?? null });
}

guardianTypeHandlers.register('stalker', {
  sleepless: true,
  order: 2,
  turn(ctx, m, { target: seenTarget, params }) {
    const st = m.actor!.ai!.state;
    let target = seenTarget;
    if (!target && (st === 'hunting' || st === 'searching')) {
      target = sensePlayer(ctx, m, params.sense ?? 12);
      if (target?.pos) keepTrail(ctx, m, target.pos);
    }
    if (!target?.pos) return null;
    m = ctx.world.entities[m.id] ?? m;
    const g = m.guardian!;
    const d = cheb(m.pos!, target.pos);
    const seen = playerSees(ctx, target, m.pos!);
    const hide = (): void => {
      const hidden = freeNeighbors(ctx, m).filter((p) => !playerSees(ctx, target, p)).sort((a, b) => cheb(a, target.pos!) - cheb(b, target.pos!) || a.y - b.y || a.x - b.x);
      if (hidden.length) stepTo(ctx, m, hidden[0]);
      else flee(ctx, m, target.pos!);
    };
    if (d <= 1) {
      if (g.unseen) {
        // 視界の外から寄った: 会心の一撃
        melee(ctx, m, target, { forceCrit: true });
        setGuardian(ctx, m, (e) => { e.guardian!.unseen = false; e.guardian!.struck = true; e.guardian!.lurk = 0; });
        return 100;
      }
      if (g.struck) {
        // 襲った後は退いて隠れ直す
        hide();
        setGuardian(ctx, m, (e) => { e.guardian!.struck = false; });
        return 100;
      }
      melee(ctx, m, target);
      return 100;
    }
    if (seen && (g.lurk ?? 0) < LURK_MAX) {
      // 見られている: 相手の視界の外のマスへ下がる（近い方を選ぶ）。無ければ離れる
      hide();
      setGuardian(ctx, m, (e) => { e.guardian!.lurk = (e.guardian!.lurk ?? 0) + 1; e.guardian!.unseen = false; });
      return 100;
    }
    // 見られていない（または待ちくたびれた）: 寄る。見られていなければ、陰（相手の視界の外）のマスを伝って寄る。
    // 視界の外から隣へ着いたら、次の一撃は会心
    const closer = freeNeighbors(ctx, m).filter((p) => cheb(p, target.pos!) < d);
    const shade = seen ? [] : closer.filter((p) => !playerSees(ctx, target, p) || cheb(p, target.pos!) <= 1);
    if (shade.length) stepTo(ctx, m, shade.sort((a, b) => cheb(a, target.pos!) - cheb(b, target.pos!) || a.y - b.y || a.x - b.x)[0]);
    else approach(ctx, m, target.pos);
    const after = ctx.world.entities[m.id];
    // 隠れた手番の数（lurk）は襲ったときだけ戻す（見失っても戻さない: 見張られ続けたら、いずれ見えたまま来る）
    if (after?.pos) setGuardian(ctx, after, (e) => { e.guardian!.unseen = !seen && cheb(after.pos!, target.pos!) <= 1; });
    return 100;
  },
});

// ---- 弾く者: 2 マス以上離れた相手からの投擲のダメージを半分にする ----
guardianTypeHandlers.register('deflector', {
  incoming(ctx, m, dmg, via, attacker, params) {
    if (via !== 'thrown' || !attacker?.pos || !m.pos) return dmg;
    if (cheb(attacker.pos, m.pos) < (params.minDist ?? 2)) return dmg;
    return Math.max(1, floorDiv(dmg * (params.pct ?? 50), 100));
  },
});

// ---- 弱点 ----
weaknessHandlers.register('poison', { dotMult: (p) => p.mult ?? 2 });
weaknessHandlers.register('thrown', { incoming: (dmg, via, p) => (via === 'thrown' ? dmg * (p.mult ?? 2) : dmg) });
weaknessHandlers.register('deep_sleep', { critIfUnaware: true, asleep: true });
weaknessHandlers.register('water_slow', {
  lairTerrain: 'core:shallow_water',
  costPct(ctx, m, p) {
    if (!m.pos) return 100;
    const t = ctx.terrainAt(m.pos.floor, m.pos.x, m.pos.y);
    return t.id === 'core:shallow_water' ? floorDiv(100 * 100, Math.max(1, p.speedPct ?? 50)) : 100;
  },
});

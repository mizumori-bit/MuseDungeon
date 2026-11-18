// 能動技と武器の特性のハンドラ（V3-4 §4.2・§4.4）。定義はデータ（abilities.json / weaponTraits.json）。
import type { Entity, Pos } from '@muse/shared';
import { actionError, DIR_VEC, t } from '@muse/shared';
import { abilityHandlers, adjacentFoe, weaponTraits } from './build';
import { heal, melee } from './combat';
import { triggerTrap } from './actions';
import { addStatus } from './statuses';

// ---- 武器の特性 ----
weaponTraits.register('none', {});
weaponTraits.register('attack_cost', { attackCost: (p) => p.cost ?? 100 });
weaponTraits.register('reach', { reach: (p) => p.range ?? 2 });
weaponTraits.register('sweep', { sweep: true });
weaponTraits.register('on_hit_stun', {
  onHit: (ctx, attacker, target, p) => {
    if (ctx.rng('runtime').chance(p.chancePct ?? 20)) addStatus(ctx, target, 'core:stun', p.turns ?? 1, 1, attacker.id);
  },
});

// ---- 能動技 ----

/** 強打: 隣の敵に近接攻撃。当たれば朦朧 */
abilityHandlers.register('strike', (ctx, e, pr, def, cmd) => {
  const foe = adjacentFoe(ctx, e, pr, cmd.target);
  if ('code' in foe) return { error: foe };
  return {
    target: foe,
    run: () => {
      const o = melee(ctx, ctx.world.entities[e.id], foe);
      const cur = ctx.world.entities[foe.id];
      if (o.hit && cur && (cur.stats?.hp ?? 0) > 0) addStatus(ctx, cur, 'core:stun', def.params.stunTurns ?? 1, 1, e.id);
    },
  };
});

/** なぎ払い: 隣にいる敵すべてに近接攻撃（武器の「薙ぐ」は重ねない） */
abilityHandlers.register('cleave', (ctx, e, pr) => {
  const key = e.pos!.floor;
  const foes = ctx.entitiesOn(key).filter((m) => m.actor && !m.player && m.pos && (m.stats?.hp ?? 0) > 0
    && Math.max(Math.abs(m.pos.x - e.pos!.x), Math.abs(m.pos.y - e.pos!.y)) === 1).sort((a, b) => a.sid - b.sid);
  if (!foes.length) return { error: actionError('no_target', t(pr.locale, '隣に敵がいない。', 'No enemy next to you.'), t(pr.locale, '敵が隣に来てから使う。', 'Use it with enemies adjacent.')) };
  return {
    target: null,
    run: () => {
      for (const m of foes) {
        const me = ctx.world.entities[e.id];
        const cur = ctx.world.entities[m.id];
        if (!me?.pos || !cur || (cur.stats?.hp ?? 0) <= 0) continue;
        melee(ctx, me, cur, { noSweep: true });
      }
    },
  };
});

/** 立て直し: 最大 HP の pct % を回復 */
abilityHandlers.register('heal_pct', (ctx, e, pr, def) => {
  if (e.stats && e.stats.hp >= e.stats.maxHp) return { error: actionError('cannot_use', t(pr.locale, 'HP は減っていない。', 'Your HP is full.'), t(pr.locale, '傷を負ってから使う（遠征ごとに回数が決まっている）。', 'Use it when wounded (limited uses per expedition).')) };
  return { target: null, run: () => { const me = ctx.world.entities[e.id]; heal(ctx, me, Math.max(1, Math.trunc((me.stats!.maxHp * (def.params.pct ?? 25)) / 100)), 'ability'); } };
});

/** 身をかわす: その方向へ steps マスまで移動し、次の自分の手番まで近接攻撃を受けない */
abilityHandlers.register('slip', (ctx, e, pr, def, cmd) => {
  const L = pr.locale;
  if (typeof cmd.target !== 'string' || !(cmd.target in DIR_VEC)) {
    return { error: actionError('invalid_direction', t(L, '方向を target に渡す（n ne e se s sw w nw）。', 'Pass a direction as target (n ne e se s sw w nw).'), t(L, 'navigation.passable_dirs から選ぶ。', 'Pick from navigation.passable_dirs.')) };
  }
  const v = DIR_VEC[cmd.target as keyof typeof DIR_VEC];
  const key = e.pos!.floor;
  const path: Pos[] = [];
  let p = { x: e.pos!.x, y: e.pos!.y };
  for (let i = 0; i < (def.params.steps ?? 2); i++) {
    const n = { x: p.x + v[0], y: p.y + v[1] };
    const tr = ctx.terrainAt(key, n.x, n.y);
    if (!tr.passable || tr.door === 'closed' || ctx.actorAt(key, n.x, n.y)) break;
    path.push(n);
    p = n;
  }
  if (!path.length) return { error: actionError('blocked', t(L, 'そちらへは動けない。', 'You cannot move that way.'), t(L, 'navigation.passable_dirs から選ぶ。', 'Pick from navigation.passable_dirs.')) };
  return {
    target: null,
    run: () => {
      for (const to of path) {
        const me = ctx.world.entities[e.id];
        if (!me?.pos || me.pos.floor !== key) return;
        const from = { x: me.pos.x, y: me.pos.y };
        ctx.emit({ type: 'entity_moved', id: me.id, kind: me.kind, from, to: { ...to }, mode: 'walk', ...ctx.perceiveMove(key, me, from, to, [pr.id]), floor: key });
        const trap = ctx.featureAt(key, to.x, to.y);
        if (trap?.trap) { triggerTrap(ctx, ctx.world.entities[e.id], trap); break; }
      }
      const me = ctx.world.entities[e.id];
      if (me?.pos) addStatus(ctx, me as Entity, 'core:evasive', 1, 1);
    },
  };
});

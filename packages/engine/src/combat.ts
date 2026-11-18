// 戦闘（整数のみ）。命中: d20 + acc >= 10 + eva。20 は必中＋会心、1 は必ず外れ。
// ダメージ: ダイス + might - armor、最低 1。会心は「ダイスの最大値 + might、装甲無視」（V3-2R §14.3）。
import type { DamageVia, Dir, Entity, PlayerId, PlayerRecord, RunSummary, RunSummaryPlayer } from '@muse/shared';
import { ceilDiv, cheb, currentExpedition, diceMax, dirTo, xpForLevel } from '@muse/shared';
import type { Ctx } from './ctx';
import { applyEffects } from './effects';
import { displayName, maybeEndExpedition } from './expedition';
import { pickLoot } from './gen/generate';
import { makeNoise, updateMemory, wakeMonster } from './perception';
import { roll } from './registry';
import { makeItem } from './spawn';
import { effectiveStats } from './stats';
import { hasStatus, removeStatus } from './statuses';
import { meleeAccOf, notePerk, offerPerk, perkHook, perkHookSum, perkWithHook, sweeps, weaponOnHit } from './build';
import { armorOf, guardianCritIfUnaware, guardianIncoming, noteTrial } from './guardians';
import { boonHook } from './boons';
import { wardenSlain } from './warden';
import { pickLore, tellStory } from './story';

export interface AttackOutcome { hit: boolean; crit: boolean; roll: number }

function isSleeping(e: Entity): boolean {
  return !!e.actor?.dormant || e.actor?.ai?.state === 'asleep' || hasStatus(e, 'core:sleep');
}

/** 気づいていない・眠っている（不意打ち・狙い撃ちの会心） */
export function isUnaware(e: Entity): boolean {
  return isSleeping(e) || e.actor?.ai?.state === 'unaware';
}

/** 無防備（朦朧・眠りなど、行動できない状態異常）。狙い撃ちと不意打ちの会心の条件（V3-3b §40.1） */
export function isHelpless(ctx: Ctx, e: Entity): boolean {
  return (e.statuses ?? []).some((s) => ctx.content.statuses[s.id]?.handler === 'incapacitate');
}

/** 構え（盾の構え）の装甲の上乗せ。当たったら構えは解ける */
function bracedArmor(e: Entity): number {
  return (e.statuses ?? []).find((s) => s.id === 'core:braced')?.power ?? 0;
}

/** 踏みとどまる: HP が閾値以下なら威力の上乗せ */
function lastStandMight(ctx: Ctx, e: Entity): number {
  const h = perkHook(ctx, e, 'last_stand');
  if (!h || !e.stats) return 0;
  return e.stats.hp * 100 <= e.stats.maxHp * (h.belowPct ?? 25) ? h.might ?? 0 : 0;
}

export interface MeleeOpts {
  /** 命中の上乗せ（能動技） */
  accBonus?: number;
  /** なぎ払いの 2 体目など: 武器の「薙ぐ」を重ねない */
  noSweep?: boolean;
  /** ダメージの倍率（突き進む者の突進。V3-3） */
  dmgMult?: number;
  /** 必ず会心（潜む者の、視界の外からの一撃。V3-3） */
  forceCrit?: boolean;
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
    ...affixFields('attacker', attacker), ...affixFields('target', target),
    from: { x: attacker.pos!.x, y: attacker.pos!.y }, to: { x: target.pos!.x, y: target.pos!.y },
    ...fromDirFor(target, attacker, seen.masks, 'attacker'), ...seen,
  });
}

/** 接辞（文章用）。無ければ付けない */
function affixFields(field: string, e: Entity | null): Record<string, string[]> {
  const a = e?.scale?.affixes;
  return a?.length ? { [`${field}Affixes`]: [...a] } : {};
}

/** 攻撃者が見えていない被害者（プレイヤー）にだけ、攻撃が来た方向を残す */
function fromDirFor(target: Entity, source: Entity | null, masks: Record<string, string[]> | undefined, field: string): { fromDir?: Dir | null } {
  if (!target.player || !source?.pos || !target.pos || source.pos.floor !== target.pos.floor) return {};
  if (!masks?.[target.player]?.includes(field)) return {};
  return { fromDir: dirTo(target.pos, source.pos) };
}

/**
 * 命中の記録（V3-2R2 §18.2）: 自分の攻撃（近接・投擲）と、相手から自分への攻撃の回数と命中を、種族ごとの思い出に残す。
 * 相手が見えているときだけ（見えていない相手の種族は記録しない）
 */
export function recordHit(ctx: Ctx, attacker: Entity, target: Entity, hit: boolean, kind: 'melee' | 'thrown' | 'ranged'): void {
  // 守護者は種族と別の記録（guardian|種族）に残る（V3-2R3 §20.4）
  const sees = (pid: PlayerId, m: Entity) => {
    const f = m.pos ? ctx.world.floors[m.pos.floor] : undefined;
    return !!f && ctx.visibleSet(pid).has(m.pos!.y * f.width + m.pos!.x);
  };
  if (attacker.player && !target.player && target.actor && kind !== 'ranged' && sees(attacker.player, target)) {
    updateMemory(ctx, attacker.player, target, (m) => {
      const cur = m.hitsByYou?.[kind] ?? [0, 0];
      m.hitsByYou = { ...(m.hitsByYou ?? {}), [kind]: [cur[0] + (hit ? 1 : 0), cur[1] + 1] };
    });
  }
  if (target.player && !attacker.player && attacker.actor && sees(target.player, attacker)) {
    updateMemory(ctx, target.player, attacker, (m) => {
      const cur = m.hitsOnYou ?? [0, 0];
      m.hitsOnYou = [cur[0] + (hit ? 1 : 0), cur[1] + 1];
    });
  }
}

/**
 * 近接攻撃（バンプ攻撃・attack・能動技）。V3-4: 習熟と装備の命中、不意打ち（気づいていない相手に必ず会心）、
 * 踏みとどまる（威力）、構え（装甲）、身かわし（当たらない）、武器の特性（砕く・薙ぐ）
 */
export function melee(ctx: Ctx, attacker: Entity, target: Entity, opts: MeleeOpts = {}): AttackOutcome {
  const tpos = { x: target.pos!.x, y: target.pos!.y };
  const unaware = isUnaware(target);
  let o = rollToHit(ctx, attacker, target, (opts.accBonus ?? 0) + meleeAccOf(ctx, attacker));
  // 不意打ち: 気づいていない・眠っている・朦朧（無防備）の相手（V3-3b §40.1）
  const ambush = attacker.player && (unaware || isHelpless(ctx, target)) && perkHook(ctx, attacker, 'ambush');
  if (ambush) o = { hit: true, crit: true, roll: o.roll };
  // 守護者（V3-3）: 視界の外からの一撃（潜む者）・眠りが深い守護者への気づかれる前の一撃は会心
  if (opts.forceCrit) o = { hit: true, crit: true, roll: o.roll };
  if (!o.crit && attacker.player && unaware && target.guardian && guardianCritIfUnaware(ctx, target)) o = { hit: true, crit: true, roll: o.roll };
  if (o.hit && attacker.player && unaware && target.guardian) noteTrial(ctx, target, 'unaware_hit');
  // 身をかわした相手には近接が当たらない（次のその者の手番まで）
  if (hasStatus(target, 'core:evasive')) o = { hit: false, crit: false, roll: o.roll };
  if (ambush && o.crit) notePerk(ctx, attacker, perkWithHook(ctx, attacker, 'ambush'), 'crit', { subject: target });
  emitAttack(ctx, attacker, target, o, false);
  recordHit(ctx, attacker, target, o.hit, 'melee');
  makeNoise(ctx, attacker.pos!.floor, target.pos!, 5, attacker);
  if (o.hit) {
    const ls = lastStandMight(ctx, attacker);
    const might = attacker.stats!.might + ls;
    const brace = bracedArmor(target);
    // 重い一撃: 近接の会心のダメージの上乗せ（V3-3c §44.4）
    const raw = o.crit ? 0 : roll(ctx.rng('runtime'), attacker.stats!.dmg) + might;
    const base = o.crit
      ? Math.max(1, diceMax(attacker.stats!.dmg) + might + perkHookSum(ctx, attacker, 'melee_crit_dmg', 'dmg'))
      : Math.max(1, heavyFloor(attacker, raw, raw - armorOf(ctx, target) - brace));
    // 突進の倍率と、守護者の受けるダメージの修正（V3-3）
    const mult = base * (opts.dmgMult ?? 1);
    const dmg = target.guardian ? guardianIncoming(ctx, target, mult, 'melee', attacker) : mult;
    if (ls > 0) notePerk(ctx, attacker, perkWithHook(ctx, attacker, 'last_stand'), 'might', { amount: ls });
    if (brace && !o.crit) notePerk(ctx, target, perkWithHook(ctx, target, 'brace'), 'braced', { amount: brace });
    if (brace) removeStatus(ctx, target, 'core:braced');
    const dealt = applyDamage(ctx, ctx.world.entities[target.id], dmg, attacker, 'melee');
    // 血を吸う（V3-5b §44.7）: 与えた分だけ回復する
    if (dealt > 0 && !attacker.player) drainHeal(ctx, attacker, dealt);
    if ((ctx.world.entities[target.id]?.stats?.hp ?? 0) > 0) onHitEffects(ctx, attacker, ctx.world.entities[target.id]);
    if (attacker.player) weaponOnHit(ctx, ctx.world.entities[attacker.id] ?? attacker, ctx.world.entities[target.id] ?? target);
  } else provoke(ctx, target, attacker);
  // 薙ぐ: 対象と自分の両方に隣接する敵 1 体にも当たる（挿入順で最初の 1 体）
  const me = ctx.world.entities[attacker.id];
  if (!opts.noSweep && me?.pos && attacker.player && sweeps(ctx, me)) {
    const other = ctx.entitiesOn(me.pos.floor).filter((m) => m.actor && !m.player && m.id !== target.id && m.pos && (m.stats?.hp ?? 0) > 0
      && cheb(m.pos, me.pos!) === 1 && cheb(m.pos, tpos) === 1).sort((a, b) => a.sid - b.sid)[0];
    if (other) melee(ctx, me, other, { noSweep: true });
  }
  return o;
}

/** 遠隔攻撃（モンスターの射撃） */
export function rangedAttack(ctx: Ctx, attacker: Entity, target: Entity, dice: string, accBonus: number, pierce = false): void {
  const o = rollToHit(ctx, attacker, target, accBonus);
  emitAttack(ctx, attacker, target, o, true);
  recordHit(ctx, attacker, target, o.hit, 'ranged');
  // 遠隔攻撃を見た者（撃った側が見えている者）の思い出に、能力と観測した距離を残す
  const key = attacker.pos!.floor;
  const f = ctx.world.floors[key];
  const dist = cheb(attacker.pos!, target.pos!);
  for (const pr of ctx.playersOn(key)) {
    if (!ctx.visibleSet(pr.id).has(attacker.pos!.y * f.width + attacker.pos!.x)) continue;
    updateMemory(ctx, pr.id, attacker, (m) => { m.abilities.push('ranged'); m.rangeMax = Math.max(m.rangeMax ?? 0, dist); });
  }
  if (o.hit) {
    // 装甲を抜く射撃（呪い火。V3-5a §35.10）は装甲も構えも無視する
    const brace = pierce ? 0 : bracedArmor(target);
    const armor = pierce ? 0 : armorOf(ctx, target);
    const raw = o.crit ? 0 : roll(ctx.rng('runtime'), dice);
    const dmg = o.crit ? Math.max(1, diceMax(dice)) : Math.max(1, heavyFloor(attacker, raw, raw - armor - brace));
    if (brace && !o.crit) notePerk(ctx, target, perkWithHook(ctx, target, 'brace'), 'braced', { amount: brace });
    if (brace) removeStatus(ctx, target, 'core:braced');
    applyDamage(ctx, ctx.world.entities[target.id], dmg, attacker, 'ranged');
  } else provoke(ctx, target, attacker);
}

function onHitEffects(ctx: Ctx, attacker: Entity, target: Entity): void {
  const def = ctx.content.monsters[attacker.kind];
  const effects = [...(def?.attack.onHit ?? [])];
  for (const a of attacker.scale?.affixes ?? []) effects.push(...(ctx.content.affixes[a]?.onHit ?? []));
  if (!effects.length) return;
  applyEffects(ctx, effects, { user: attacker, target, pos: target.pos!, source: attacker, via: 'melee' });
}

/** 血を吸う種族（タグ drain）: 与えたダメージの分だけ回復する（最大 HP まで） */
function drainHeal(ctx: Ctx, attacker: Entity, dealt: number): void {
  const a = ctx.world.entities[attacker.id];
  if (!a?.stats || a.stats.hp <= 0 || a.stats.hp >= a.stats.maxHp || !ctx.content.monsters[a.kind]?.tags.includes('drain')) return;
  const amount = Math.min(dealt, a.stats.maxHp - a.stats.hp);
  const seen = a.pos ? ctx.perceive(a.pos.floor, [{ field: 'target', pos: a.pos, entity: a.id }], []) : { seenBy: [] as string[] };
  ctx.emit({ type: 'healed', target: a.id, targetKind: a.kind, amount, hpAfter: a.stats.hp + amount, via: 'drain', ...seen, floor: a.pos?.floor ?? null });
}

/** 攻撃された（外れた）モンスターは攻撃者に気づく */
function provoke(ctx: Ctx, target: Entity, attacker: Entity): void {
  if (target.actor?.ai && attacker.pos) {
    if (hasStatus(target, 'core:sleep')) removeStatus(ctx, target, 'core:sleep');
    wakeMonster(ctx, target, { x: attacker.pos.x, y: attacker.pos.y });
  }
}

export function applyDamage(ctx: Ctx, target: Entity, amount: number, source: Entity | null, via: DamageVia): number {
  const t = ctx.world.entities[target.id];
  if (!t?.stats || t.stats.hp <= 0) return 0;
  let hpAfter = Math.max(0, t.stats.hp - amount);
  // 加護（執念。V3-3 §3.3）: 致死のダメージを、遠征に 1 回だけ HP 1 で耐える
  const xNo = currentExpedition(ctx.world)?.no ?? 0;
  const stand = hpAfter <= 0 && t.player ? boonHook(ctx, t, 'last_stand') : null;
  const standing = !!stand && (t.boonUsed?.[stand.boon] ?? -1) !== xNo;
  if (standing) hpAfter = 1;
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
    source: source?.id ?? null, sourceKind: source?.kind ?? null, via, ...(seenTotals ? { seenTotals } : {}),
    ...affixFields('target', t), ...affixFields('source', source),
    ...fromDirFor(t, source, seen.masks, 'source'), ...seen,
  });
  // 思い出（受けたダメージは脅威の見積もり用に出目どおり、与えたダメージは実ダメージ）
  if (source && t.player && !source.player) {
    updateMemory(ctx, t.player, source, (m) => { m.maxDamageToYou = Math.max(m.maxDamageToYou, amount); });
  }
  if (source?.player && !t.player && t.actor) {
    // 通りの記録（V3-2R3 §20.4）: 当たったときの実ダメージの合計と回数（近接・投擲）
    const kindOf = via === 'melee' ? 'melee' as const : via === 'thrown' ? 'thrown' as const : null;
    updateMemory(ctx, source.player, t, (m) => {
      m.maxDamageByYou = Math.max(m.maxDamageByYou, dealt);
      if (kindOf && amount > 0) {
        const cur = m.dmgByYou?.[kindOf] ?? [0, 0];
        m.dmgByYou = { ...(m.dmgByYou ?? {}), [kindOf]: [cur[0] + dealt, cur[1] + 1] };
      }
    });
  }
  if (standing && stand) {
    const body = structuredClone(ctx.world.entities[t.id]);
    body.boonUsed = { ...(body.boonUsed ?? {}), [stand.boon]: xNo };
    ctx.emit({ type: 'boon_triggered', actor: t.id, boon: stand.boon, effect: 'last_stand', put: [body], seenBy: t.player ? [t.player] : [], floor: key });
  }
  if (hpAfter <= 0) {
    kill(ctx, ctx.world.entities[t.id], source, via);
    return dealt;
  }
  const cur = ctx.world.entities[t.id];
  if (hasStatus(cur, 'core:sleep') && via !== 'poison') removeStatus(ctx, cur, 'core:sleep');
  if (source && cur.actor?.ai) provoke(ctx, cur, source);
  return dealt;
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
  // 見ていない者には最大 HP と種族・接辞も伏せる（視界外で毒が倒した相手は「何か」。V3-2R2 §18.7）
  for (const pid of seen.seenBy) if (masks[pid]?.includes('id')) masks[pid] = [...masks[pid], 'maxHp', 'kind', 'affixes'];
  ctx.emit({
    type: 'died', id: victim.id, kind: victim.kind, killer: killer?.id ?? null, killerKind: killer?.kind ?? null, via, pos, maxHp,
    ...(victim.bounty ? { bounty: victim.bounty } : {}), ...(victim.scale?.affixes?.length ? { affixes: [...victim.scale.affixes] } : {}),
    seenBy: seen.seenBy, ...(Object.keys(masks).length ? { masks } : {}),
  });
  // 接辞付きの個体は種族の体力の記録に混ぜない（守護者は守護者の記録に残る。V3-4b §28.8）
  if (maxHp !== null && !((victim.scale?.affixes?.length ?? 0) > 0 && victim.role !== 'guardian')) {
    for (const pid of seen.seenBy) {
      if (masks[pid]?.includes('id')) continue;
      // 守護者は守護者の記録に残る（種族の体力の記録とは分ける）
      updateMemory(ctx, pid, victim, (m) => {
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
  const drops = [...(def?.drops ?? [])];
  // 守護者・大柄な種族・接辞付きの個体は宝を必ず落とす（V3-2R3 §20.5）
  if (victim.role === 'guardian' || def?.size === 'large' || (victim.scale?.affixes?.length ?? 0) > 0) drops.push({ table: 'core:treasure_loot', chancePct: 100 });
  for (const d of drops) {
    if (!rng.chance(d.chancePct)) continue;
    const l = pickLoot(ctx.content, d.table, depth, rng);
    if (!l) continue;
    const it = makeItem(key, l.kind, pos.x, pos.y, l.qty, l.affixes, ctx.newEntityId(), ctx.nextSid(), l.value, l.hidden);
    ctx.emit({ type: 'entity_spawned', entity: it, reason: 'drop', floor: key, seenBy: ctx.seersOf(key, pos) });
  }
  // 持っていた品（宝物庫の鍵。V3-5 §5.1）
  if (victim.carries) {
    const it = makeItem(key, victim.carries, pos.x, pos.y, 1, [], ctx.newEntityId(), ctx.nextSid());
    ctx.emit({ type: 'entity_spawned', entity: it, reason: 'drop', floor: key, seenBy: ctx.seersOf(key, pos) });
  }
  ctx.emit({ type: 'entity_removed', id: victim.id, kind: victim.kind, reason: 'died', seenBy: ctx.seersOf(key, pos), floor: key });
  // 節目の大守護者（V3-3 §3.2）: 節目を記録し、加護の候補を出す
  if (victim.guardian?.warden) wardenSlain(ctx, victim, killer, key);
  // 物語の 1 文（V3-3 §3.4）: 遠征の守護者・大守護者を倒した
  const xNow = currentExpedition(ctx.world);
  if (victim.guardian && (victim.guardian.warden || xNow?.targets.guardian === victim.id)) {
    const kind = victim.guardian.warden ? 'warden_slain' as const : 'guardian_slain' as const;
    tellStory(ctx, kind, pickLore(ctx.content, ctx.world.secret.seed, `${kind}|${victim.id}`, kind, { guardianTypes: victim.guardian.types }, { guardian: displayName(victim.guardian) }), key);
  }
  if (killer?.player) {
    const pr = ctx.world.players[killer.player];
    ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...pr.stats, kills: pr.stats.kills + 1 }, seenBy: [pr.id] });
    // 見ていなかった相手（視界外で毒が倒した）は種族の撃破数に数えない（種族を知らないので）
    if (!masks[pr.id]?.includes('id')) updateMemory(ctx, pr.id, victim, (m) => { m.kills += 1; });
    // 撃破の経験値に深さの係数（深度 1 階ごとに xp.killDepthPct %。直行しても深さに追いつく。V3-2R3 §20.2）
    const kd = ctx.content.balance.xp.killDepthPct ?? 0;
    grantXp(ctx, ctx.world.entities[killer.id], Math.trunc(((victim.xp ?? 0) * (100 + kd * Math.max(0, depth - 1))) / 100));
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
    // 固定成長は HP だけ。命中・威力・回避は特技で選ぶ（V3-4 §4.1）
    const lu = cls?.levelUp ?? { hp: 4 };
    const base = { ...cur.base! };
    base.maxHp += lu.hp;
    const tmp: Entity = { ...cur, base, stats: { ...cur.stats!, hp: cur.stats!.hp + lu.hp } };
    const stats = effectiveStats(ctx, tmp);
    const gains = { maxHp: base.maxHp - cur.base!.maxHp, acc: 0, might: 0, eva: 0 };
    ctx.emit({ type: 'level_up', target: e.id, levelAfter: lv, xpAfter: cur.level.xp, statsAfter: stats, baseAfter: base, gains, seenBy: e.player ? [e.player] : [] });
    offerPerk(ctx, ctx.world.entities[e.id], lv);
    cur = ctx.world.entities[e.id];
  }
}

export function scoreOf(ctx: Ctx, p: { deepest: number; kills: number; level: number; expeditionPoints?: number }): number {
  const s = ctx.content.balance.score;
  return p.deepest * s.perDepth + p.kills * s.perKill + p.level * s.perLevel + (p.expeditionPoints ?? 0);
}

/** 重い一撃（V3-8 §53.1）: 格 2 以上の守護者と大守護者の攻撃は、装甲（と構え）で一撃の半分までしか減らない */
function heavyFloor(attacker: Entity, raw: number, reduced: number): number {
  return attacker.guardian?.heavy ? Math.max(reduced, ceilDiv(raw, 2)) : reduced;
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
      // スコア版 2: 確定点（遠征で持ち帰った戦利品の払い戻しの合計）
      score: pr.stats.banked ?? 0,
      expeditions: pr.stats.expeditions ?? 0,
      banked: pr.stats.banked ?? 0,
      // 継承したラン（V3-7 §7.3: 記録の表を分ける）
      ...(pr.legacy ? { legacy: true } : {}),
    };
  });
  const expeditions = (ctx.world.expeditions ?? []).map((x) => ({
    no: x.no, objective: { ...x.objective }, status: x.status, endReason: x.endReason, points: x.points, startSeq: x.startSeq, endSeq: x.endSeq,
  }));
  return { runId: ctx.world.meta.runId, reason, seed: hideSeed ? '' : ctx.world.secret.seed, endedSeq: ctx.world.seq + 1, players, expeditions, scoreVersion: 2 };
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

// 遠征（IMPROVEMENTS_V2 §2）: 候補の生成、開始、目的の進捗、extract、終了判定。
// 状態は全てイベント（expedition_* / objective_* / player_state）で変わる。
import type {
  ActionError, AiState, Entity, Expedition, ExpeditionEndReason, FloorPos, Pos, ExpeditionHaul, ExpeditionOffer, ExpeditionResult, HaulParts, Objective,
  BountyInfo, Floor, ObjectiveProgress, ObjectiveType, OfferSlot, PlayerId, PlayerRecord, GuardianInfo, Names,
} from '@muse/shared';
import { addDiceBonus, campDepthOf, cheb, currentExpedition, deepestGenerated, diceMax, diceMin, floorDiv, guardianDisplayName, haulTotal, isPursuing, killPoints, offerPoints, overreachPoints, payoutOf, Rng, actionError, t } from '@muse/shared';
import { buildSummary, grantXp } from './combat';
import type { Ctx } from './ctx';
import { ensureFloor, findFreeCell, floorOrder, noteFloorTraits, syncTerrainTable } from './floors';
import { hasLos, inCircle } from './geom';
import { isOpaqueFn } from './perception';
import { deepTier, guardianCandidates, guardianSpec, pickGuardianKind, rollMonsterAffixes, selectBiome, selectFloorType } from './gen/generate';
import { departGuardians, lairPlan, makeName, projectedScar, rollGuardianInfo, settleGuardian } from './guardians';
import { grantBoon, ownedBoons, pickRelic } from './boons';
import { nextMilestone, restoreMilestoneFloors, sealedFloor, wardenHpRange, wardenPreview } from './warden';
import { num, pickLore, tellStory } from './story';
import { isMilestoneDepth } from './gen/generate';
import { spawnFromSpec, sumAffixMods } from './spawn';
import { recomputeStats } from './stats';
import { campfireNear, fireReturnCheck } from './campfire';

const OFFER_TYPES: ObjectiveType[] = ['reach_depth', 'slay_guardian', 'retrieve_relic'];
/** 帰還の綱（V3-2R2 §18.1） */
export const LIFELINE = 'core:lifeline';
const SLOTS: OfferSlot[] = ['safe', 'standard', 'ambitious'];

/** 条件の効果をまとめる（倍率は掛け合わせ、加算は足し合わせ） */
export interface TraitEffects {
  monstersPct: number; itemsPct: number; treasurePct: number; wanderIntervalPct: number; sightDelta: number; noWander: boolean; noFountain: boolean;
}

export function traitEffects(ctx: Ctx, traits: readonly string[] | undefined): TraitEffects {
  const out: TraitEffects = { monstersPct: 100, itemsPct: 100, treasurePct: 100, wanderIntervalPct: 100, sightDelta: 0, noWander: false, noFountain: false };
  for (const id of traits ?? []) {
    const e = ctx.content.expeditionTraits[id]?.effects;
    if (!e) continue;
    if (e.monstersPct !== undefined) out.monstersPct = Math.trunc((out.monstersPct * e.monstersPct) / 100);
    if (e.itemsPct !== undefined) out.itemsPct = Math.trunc((out.itemsPct * e.itemsPct) / 100);
    if (e.treasurePct !== undefined) out.treasurePct = Math.trunc((out.treasurePct * e.treasurePct) / 100);
    if (e.wanderIntervalPct !== undefined) out.wanderIntervalPct = Math.trunc((out.wanderIntervalPct * e.wanderIntervalPct) / 100);
    if (e.sightDelta !== undefined) out.sightDelta += e.sightDelta;
    if (e.noWander) out.noWander = true;
    if (e.noFountain) out.noFountain = true;
  }
  return out;
}

/** 階を作るときに効く効果（敵・アイテム・宝の数、泉なし）を持つ条件か（V4-0e §8.1。作った階に残る） */
function genEffectTrait(ctx: Ctx, id: string): boolean {
  const e = ctx.content.expeditionTraits[id]?.effects;
  return !!e && (e.monstersPct !== undefined || e.itemsPct !== undefined || e.treasurePct !== undefined || !!e.noFountain);
}

/** 階を作るときだけに効く条件（遠征の間に効く効果が無い。群れる・乏しい）: 目的の階がもう作られている候補には付けない（V4-0e §8.2） */
function genOnlyTrait(ctx: Ctx, id: string): boolean {
  const e = ctx.content.expeditionTraits[id]?.effects;
  return genEffectTrait(ctx, id) && !!e && e.wanderIntervalPct === undefined && e.sightDelta === undefined && !e.noWander;
}

/** 条件のうち、階を作るときに効くもの（作った階の性質。V4-0e §8.1）。条件の一覧の順 */
export function floorGenTraits(ctx: Ctx, traits: readonly string[] | undefined): string[] {
  const has = new Set(traits ?? []);
  return ctx.content.lists.expeditionTraits.map((t) => t.id).filter((id) => has.has(id) && genEffectTrait(ctx, id));
}

/**
 * 目的の階と通り道の階（再開する階 from から目的の階 to まで。目的の階が上なら上がっていく階）のうち、もう作られていて性質のある階
 * （V4-0e §8.1。条件ごとに深さ。まだ作られていない階は入れない）
 */
function pathFloorTraits(ctx: Ctx, from: number, to: number): { trait: string; depths: number[] }[] {
  const by = new Map<string, number[]>();
  for (let d = Math.max(1, Math.min(from, to)); d <= Math.max(from, to); d++) {
    for (const id of ctx.world.floors[`main:${d}`]?.genTraits ?? []) by.set(id, [...(by.get(id) ?? []), d]);
  }
  return ctx.content.lists.expeditionTraits.map((t) => t.id).filter((id) => by.has(id)).map((id) => ({ trait: id, depths: by.get(id)! }));
}

/** 進行中の遠征の条件の効果（遠征が無ければ効果なし） */
export function activeEffects(ctx: Ctx): TraitEffects {
  return traitEffects(ctx, currentExpedition(ctx.world)?.traits);
}

/** 徘徊の湧き間隔の割合（条件と、目的達成後の圧力） */
export function wanderPct(ctx: Ctx): { pct: number; none: boolean } {
  const x = currentExpedition(ctx.world);
  const fx = activeEffects(ctx);
  let pct = fx.wanderIntervalPct;
  if (x && x.status === 'objective_complete' && (x.objective.type === 'slay_guardian' || x.objective.type === 'slay_warden' || x.objective.type === 'retrieve_relic')) {
    pct = Math.trunc((pct * ctx.content.balance.expedition.afterObjective.wanderIntervalPct) / 100);
  }
  return { pct: Math.max(1, pct), none: fx.noWander };
}

/** 遠征の共有の戦利品の内訳（宝は別に足す） */
export function sharedParts(ctx: Ctx, x: Expedition): HaulParts {
  const h: ExpeditionHaul = x.haul ?? { bounty: 0, discovery: 0, kills: 0 };
  return {
    objective: x.status === 'objective_complete' ? x.points : 0,
    overreach: overreachPoints(ctx.content.balance, x.objective.targetDepth, x.progress.crossedDepth ?? 0, x.points),
    treasure: 0, bounty: h.bounty, discovery: h.discovery, kills: h.kills,
  };
}

/** 所持している宝の価値の合計 */
export function treasureHeld(ctx: Ctx, e: Entity): number {
  let v = 0;
  for (const id of e.inv?.items ?? []) {
    const it = ctx.world.entities[id];
    if (it?.item && ctx.content.items[it.kind]?.category === 'treasure') v += it.item.value ?? 0;
  }
  return v;
}

/** 目標階に置くもの。rank: 守護者の格、guardianKind: 候補で決めた種族 */
export interface ObjectivePlacement { guardian: boolean; relic: boolean; rank?: 1 | 2 | 3; guardianKind?: string; guardianAffixes?: string[]; info?: GuardianInfo; relicKind?: string; bounty?: BountyInfo; vault?: boolean }

/** 枠ごとの守護者の格（V3-2R3 §20.1）: 堅実 1・標準 2・野心 3。枠の無い遠征は 2 */
export function guardianRankOf(slot: OfferSlot | undefined | null): 1 | 2 | 3 {
  return slot === 'safe' ? 1 : slot === 'ambitious' ? 3 : 2;
}

/** 守護者の呼び名（称号＋名前）を両方の言語で（物語の文に埋める） */
export function displayName(g: { name: Names; title?: Names }): Names {
  return { ja: guardianDisplayName('ja', g), en: guardianDisplayName('en', g) };
}

/** 守護者の一撃の目安（装甲で減る前。生成と同じ計算: 種族のダイス + 守護者の接辞 + 深層強化。ほかの接辞は含まない。V3-3b §40.6） */
export function guardianMaxHit(ctx: Ctx, depth: number, kind: string, affixes: readonly string[] = []): number {
  const def = ctx.content.monsters[kind];
  if (!def) return 0;
  const tier = deepTier(ctx.content, depth);
  const guardAffix = ctx.content.lists.affixes.find((a) => a.target === 'guardian');
  const mods = sumAffixMods(ctx.content, [...(guardAffix ? [guardAffix.id] : []), ...affixes]);
  return diceMax(addDiceBonus(def.attack.dice, mods.dmgBonus)) + def.stats.might + tier + mods.might;
}

/** 守護者・賞金首の装甲の目安（V3-8a §56.1。生成と同じ: 種族 + 深層強化の半分 + 接辞。守護者の接辞も入れる。型の効果は除く） */
export function monsterArmorEstimate(ctx: Ctx, depth: number, kind: string, affixes: readonly string[] = [], guardian = true): number {
  const def = ctx.content.monsters[kind];
  if (!def) return 0;
  const tier = deepTier(ctx.content, depth);
  const guardAffix = guardian ? ctx.content.lists.affixes.find((a) => a.target === 'guardian') : undefined;
  const mods = sumAffixMods(ctx.content, [...(guardAffix ? [guardAffix.id] : []), ...affixes]);
  return def.stats.armor + floorDiv(tier, 2) + mods.armor;
}

/**
 * 体力ダイスの平均・最小・最大に上乗せ（%）を掛け、下限で切る（目安と幅。生成と同じ式: 振った値は 1 以上、
 * 最大体力 = max(1, 下限, ⌊振った値 × 上乗せ / 100⌋)。V4-0d §6.1）
 */
function scaledHp(dice: string, pct: number, minHp: number): { avg: number; min: number; max: number } {
  const f = (v: number) => Math.max(1, minHp, floorDiv(v * pct, 100));
  return { avg: f(floorDiv(diceMin(dice) + diceMax(dice), 2)), min: f(Math.max(1, diceMin(dice))), max: f(Math.max(1, diceMax(dice))) };
}

/** 守護者（格 1〜3）の体力: 種族の体力ダイス × 格の上乗せ・守護者の接辞・候補の接辞・深層強化。下限も生成と同じ */
function guardianHp(ctx: Ctx, depth: number, kind: string, rank: 1 | 2 | 3, affixes: readonly string[]): { avg: number; min: number; max: number } | null {
  const def = ctx.content.monsters[kind];
  if (!def) return null;
  const tier = deepTier(ctx.content, depth);
  const guardAffix = ctx.content.lists.affixes.find((a) => a.target === 'guardian');
  const mods = sumAffixMods(ctx.content, [...(guardAffix ? [guardAffix.id] : []), ...affixes]);
  const ranks = ctx.content.balance.guardian.ranks;
  const r = ranks[Math.min(ranks.length, rank) - 1];
  return scaledHp(def.stats.hp, 100 + 50 * tier + mods.hpPct + r.hpPct, r.minHpBase + r.minHpPerDepth * depth);
}

/**
 * 守護者の体力の目安（V3-3c §44.2。一撃の目安と同じ考え方: 種族の体力ダイスの平均 × 格の上乗せ・守護者の接辞・候補の接辞・深層強化。下限も同じ）
 */
export function guardianHpEstimate(ctx: Ctx, depth: number, kind: string, rank: 1 | 2 | 3, affixes: readonly string[] = []): number {
  return guardianHp(ctx, depth, kind, rank, affixes)?.avg ?? 0;
}

/** 守護者の体力の幅（V4-0d §6.1。体力ダイスの最小と最大に、目安と同じ上乗せと下限） */
export function guardianHpRange(ctx: Ctx, depth: number, kind: string, rank: 1 | 2 | 3, affixes: readonly string[] = []): { min: number; max: number } | undefined {
  const h = guardianHp(ctx, depth, kind, rank, affixes);
  return h ? { min: h.min, max: h.max } : undefined;
}

/** 深い階の遠征の新しい目的が出る深さ（V3-8 §53.2: 目標が地下 6 階より深い踏破の枠） */
const DEEP_OBJECTIVE_DEPTH = 6;

/** 賞金首の見込み（V3-8 §53.2）: 種族・接辞・名前・体力と一撃の目安・装甲。名前付きの強敵は種族を隠さない */
export function bountyOffer(ctx: Ctx, depth: number, b: BountyInfo): NonNullable<ExpeditionOffer['bounty']> {
  const def = ctx.content.monsters[b.kind];
  const tier = deepTier(ctx.content, depth);
  const mods = sumAffixMods(ctx.content, b.affixes);
  // 体力の目安と幅（V4-0d §6.1。生成と同じ: 種族の体力ダイス × (100 + 深層強化 + 接辞)%）
  const hp = def ? scaledHp(def.stats.hp, 100 + 50 * tier + mods.hpPct, 1) : { avg: 1, min: 1, max: 1 };
  return {
    kind: b.kind, name: { ...b.name }, affixes: [...b.affixes],
    kindName: def ? { ...def.name } : { ja: b.kind, en: b.kind }, affixNames: b.affixes.map((a) => ({ ...(ctx.content.affixes[a]?.name ?? { ja: a, en: a }) })),
    hp: hp.avg, hpRange: { min: hp.min, max: hp.max },
    maxHit: def ? diceMax(addDiceBonus(def.attack.dice, mods.dmgBonus)) + def.stats.might + tier + mods.might : 0,
    armor: monsterArmorEstimate(ctx, depth, b.kind, b.affixes, false),
  };
}

/** 候補で決める賞金首（種族・接辞・名前。乱数は expedition|通番|bounty|枠） */
function rollBounty(ctx: Ctx, depth: number, no: number, i: number): BountyInfo | null {
  const rng = Rng.fromSeed(`${ctx.world.secret.seed}|expedition|${no}|bounty|${i}`);
  const cands = guardianCandidates(ctx.content, selectFloorType(ctx.content, ctx.world.secret.seed, 'main', depth), selectBiome(ctx.content, ctx.world.secret.seed, 'main', depth), depth, 2)
    .filter((m) => m.ai.archetype !== 'stationary');
  if (!cands.length) return null;
  const def = cands[rng.int(cands.length)];
  const eb = ctx.content.balance.elite;
  const pool = ctx.content.lists.affixes.filter((a) => a.target === 'monster' && a.depth.min <= depth && (a.depth.max === undefined || depth <= a.depth.max));
  const affixes: string[] = [];
  while (affixes.length < eb.affixes && pool.length) affixes.push(pool.splice(rng.int(pool.length), 1)[0].id);
  return { kind: def.id, name: makeName(ctx.content, rng), affixes };
}


/** 守護者の見込みに出す、見れば分かる特徴（速さ・射撃・大柄・重装）。種族名は出さない。minSpeed: 速さの下限（大守護者） */
export function guardianTraits(ctx: Ctx, kind: string, affixes: readonly string[] = [], minSpeed = 0, heavy = false): string[] {
  const def = ctx.content.monsters[kind];
  if (!def) return [];
  const out: string[] = [];
  // 接辞（俊敏な: 速さ +30 など）も含める（V3-5a 後の評価 2: 「普通の速さ」と出た守護者が速かった）
  const mods = sumAffixMods(ctx.content, [...affixes]);
  const speed = Math.max(def.speed + (mods.speed ?? 0), minSpeed);
  if (speed > 100) out.push('fast');
  else if (speed < 100) out.push('slow');
  if (affixes.some((a) => (ctx.content.affixes[a]?.abilities ?? []).includes('poison'))) out.push('poison');
  if (def.ranged || def.tags.includes('ranged')) out.push('ranged');
  if (def.size === 'large') out.push('large');
  if (def.stats.armor >= 3) out.push('armored');
  if (def.stats.eva + (mods.eva ?? 0) >= 5) out.push('evasive');
  // 錆びさせる・装甲を抜く（V3-5a §35.10。見れば分かる特徴）
  if (def.tags.includes('rusting')) out.push('rusting');
  if (def.tags.includes('pierce') || def.ranged?.pierce) out.push('pierce');
  // 血を吸う・大振り（V3-5b §44.7。見れば分かる特徴）
  if (def.tags.includes('drain')) out.push('drain');
  if (def.tags.includes('heavy_swing')) out.push('heavy_swing');
  // 重い一撃（V3-8 §53.1）: 格 2 以上と大守護者
  if (heavy) out.push('heavy_blow');
  return out;
}

/**
 * 次の遠征の候補（シードと通番から決定的に作る。乱数状態は進めない）。
 * 目標の深さは「目標として達成した最深の階」（campDepth）から数える（V3-2R3 §20.2）。踏破で先まで降りても深くならない
 */
export function makeOffers(ctx: Ctx, no: number): ExpeditionOffer[] {
  const b = ctx.content.balance.expedition;
  const campDepth = campDepthOf(ctx.world);
  const deepest = deepestGenerated(ctx.world);
  const rng = Rng.fromSeed(`${ctx.world.secret.seed}|expedition|${no}`);
  const traitIds = ctx.content.lists.expeditionTraits.map((x) => x.id);
  // 参加者がもう持っている加護（遺物の候補はまだ持っていない加護から引く。V3-3 §3.3）
  const owned = ownedBoons(ctx);
  // 下り階段に立ったことのある最も深い階（到達・踏破。V3-3 後の AI 評価: 踏破した階の到達型が、開始と同時に達成された）
  const crossedMax = Math.max(0, ...(ctx.world.expeditions ?? []).map((x) => Math.max(x.progress.crossedDepth ?? 0, x.progress.reached && x.objective.targetDepth !== null ? x.objective.targetDepth : 0)));
  // 途中で越える節目の大守護者（候補の文に出す）
  const ms = nextMilestone(ctx);
  // 目的の種類は 3 枠で別にする（最初の遠征は 到達・守護者・遺物 の順）
  const types = no === 1 ? [...OFFER_TYPES] : rng.shuffle([...OFFER_TYPES]);
  const M = ms?.depth ?? null;
  // 同じ階を目標にした達成の回数（2 回目からは基礎点が減る。V3-3a §35.2）
  const achievedAt = (d: number) => (ctx.world.expeditions ?? []).filter((x) => x.endReason === 'completed' && x.objective.targetDepth === d && x.objective.type !== 'endless').length;
  // このキャンプの候補に出した遺物（同じ遺物を 2 枠に出さない）
  const offeredRelics = new Set<string>();
  // 階に残っている未討伐の守護者（大守護者を除く。V3-3c §44.1）: 階ごとにいちばん新しい 1 体を再挑戦の候補にする
  const leftover = new Map<number, Entity>();
  for (const e of Object.values(ctx.world.entities).sort((a, b) => a.sid - b.sid)) {
    if (e.role !== 'guardian' || !e.guardian || e.guardian.warden || !e.pos || (e.stats?.hp ?? 0) <= 0) continue;
    const [branch, ds] = e.pos.floor.split(':');
    if (branch === 'main') leftover.set(Number(ds), e);
  }
  // 目的だった賞金首で、まだ生きているもの（V3-8 §53.3: 倒せずに帰ったら再挑戦の候補）
  const bountyIds = new Set((ctx.world.expeditions ?? []).map((x) => x.targets.bounty).filter((id): id is string => !!id));
  const bountyLeft = new Map<number, Entity>();
  for (const id of [...bountyIds].sort()) {
    const e = ctx.world.entities[id];
    if (!e?.pos || (e.stats?.hp ?? 0) <= 0) continue;
    const [branch, ds] = e.pos.floor.split(':');
    if (branch === 'main') bountyLeft.set(Number(ds), e);
  }
  const lastObjective = (ctx.world.expeditions ?? []).at(-1)?.objective.type ?? null;
  // 通り道の始まり（V4-0e §8.1）: キャンプから再開する階のうち最も浅いもの（キャンプに誰もいなければ地下 1 階）
  const campers = ctx.world.playerOrder.filter((pid) => ctx.world.players[pid]?.state === 'at_camp');
  const fromDepth = campers.length ? Math.min(...campers.map((pid) => ctx.world.floors[resumePointOf(ctx, pid).floor]?.depth ?? 1)) : 1;
  return SLOTS.map((slot, i) => {
    const s = b.slots[slot];
    let type = types[i % types.length];
    // 目標の深さは枠ごとに重ならない（堅実 +1・標準 +2・野心 +3）。最初の候補の深さより浅くしない
    let target = Math.max(b.firstTargetDepth[slot], campDepth + rng.range(s.aheadMin, s.aheadMax));
    let forceRank: 1 | 2 | 3 | null = null;
    // 節目（V3-3a §35.2）: 未踏破の節目を越える目標は野心だけ。堅実と標準は越えない。
    // 標準の目標が節目以上なら「節目に挑む」。堅実が節目以上なら、節目の 1 つ上の階の格 1 の守護者（力を付ける）。野心は節目より深く
    if (M !== null && slot !== 'ambitious' && target >= M) {
      if (slot === 'standard') { type = 'slay_warden'; target = M; }
      else { type = 'slay_guardian'; target = M - 1; forceRank = 1; }
    } else if (M !== null && slot === 'ambitious' && target === M) {
      // 野心が節目の階に当たる: 越えた先にする（越える目標は野心だけ）
      target = M + 1;
    }
    // 踏破済みの節目の階は目標にしない（1 つ深く）
    while (type !== 'slay_warden' && isMilestoneDepth(ctx.content, target)) target++;
    // その階の下り階段にすでに立った（下の階が生成済み）なら、踏破型は出さず別の種類に替える
    if (type === 'reach_depth' && (target < deepest || target <= crossedMax)) type = rng.chance(50) ? 'slay_guardian' : 'retrieve_relic';
    // 深い階の遠征（V3-8 §53.2）: 目標が地下 6 階より深い踏破の枠は、踏破・賞金首・宝物庫から等しく引く。直前の遠征が踏破なら踏破は引かない。
    // 賞金首と宝物庫はまだ生成していない階だけ（残っている目的の賞金首は再挑戦）。乱数は別の流れ（ほかの候補を動かさない）
    if (type === 'reach_depth' && target > DEEP_OBJECTIVE_DEPTH) {
      const fresh = !ctx.world.floors[`main:${target}`];
      const pool: ObjectiveType[] = [...(lastObjective === 'reach_depth' ? [] : ['reach_depth' as const]), ...(fresh || bountyLeft.has(target) ? ['slay_bounty' as const] : []), ...(fresh && !ctx.world.meta.season ? ['open_vault' as const] : [])];
      // シーズンのランは宝物庫を開ける遠征を出さない（S0 §9.3: 目標階の階段の位置が変わるため）
      if (pool.length) type = pool[Rng.fromSeed(`${ctx.world.secret.seed}|expedition|${no}|deep|${i}`).int(pool.length)];
    }
    const n = rng.range(s.traitsMin, s.traitsMax);
    const traits: string[] = [];
    // 階を作るときだけに効く条件（群れる・乏しい）は、目的の階がまだ作られていない遠征にだけ付ける（V4-0e §8.2: 倍率だけ付くのを防ぐ）
    const targetBuilt = !!ctx.world.floors[`main:${target}`];
    for (const id of rng.shuffle([...traitIds])) {
      if (traits.length >= n) break;
      if (targetBuilt && genOnlyTrait(ctx, id)) continue;
      const ex = ctx.content.expeditionTraits[id]?.excludes ?? [];
      if (traits.some((x) => ex.includes(x) || (ctx.content.expeditionTraits[x]?.excludes ?? []).includes(id))) continue;
      traits.push(id);
    }
    traits.sort();
    const multiplierPct = traits.reduce((m, id) => Math.trunc((m * ctx.content.expeditionTraits[id].multiplierPct) / 100), 100);
    // 堅実の遺物は無防備（守護者付きは標準・野心だけ）
    const relicGuarded = type === 'retrieve_relic' && rng.chance(b.relicGuardianPct) && slot !== 'safe';
    // 点 = 枠の基礎点 × 種類の係数 × 深さの係数（V3-2R2 §18.3）。節目に挑むは、その深さの格 3 の守護者の目的と同じ式（V3-3a §35.2）
    const pr = { expedition: b, slots: b.slots as Record<OfferSlot, typeof s> };
    let points = type === 'slay_warden' ? offerPoints(pr, 'ambitious', 'slay_guardian', false, target) : offerPoints(pr, slot, type, relicGuarded, target);
    // 再挑戦（V3-3c §44.1）: 守護者を倒す枠の目標の階に、未討伐の守護者が残っている
    const rematch = type === 'slay_guardian' ? leftover.get(target) : undefined;
    // 同じ階の達成の繰り返しは基礎点を repeatPct % ずつ（2 回目 50%、3 回目 25%）。再挑戦（守護者・賞金首。V3-8 §53.2）には掛けない
    const done = rematch || (type === 'slay_bounty' && bountyLeft.get(target)?.named) ? 0 : achievedAt(target);
    // 下限は repeatMinPct %（V3-3b §40.6: 2112 → 1056 → 528 → 264 と細り、選ぶ理由が無くなった）
    if (done > 0) {
      let pct = 100;
      for (let k = 0; k < done; k++) pct = Math.trunc((pct * (b.repeatPct ?? 100)) / 100);
      pct = Math.max(pct, b.repeatMinPct ?? 0);
      points = Math.trunc((points * pct) / 100);
    }
    const offer: ExpeditionOffer = { index: i + 1, objective: { type, targetDepth: target }, points, relicGuarded, slot, traits, multiplierPct };
    if (done > 0) offer.repeatNo = done + 1;
    // 目標が次の節目より深い: 途中で大守護者を倒す必要がある
    if (ms && target > ms.depth) offer.passesWarden = structuredClone(ms);
    // 目的の階と通り道の階のうち、作られていて性質のある階（V4-0e §8.1。群れている階は危険度に入る）
    const ft = pathFloorTraits(ctx, fromDepth, target);
    if (ft.length) offer.floorTraits = ft;
    // 節目に挑む: 大守護者の名前と型（種族は会うまで伏せる。見れば分かる特徴だけ）
    if (type === 'slay_warden' && ms) {
      offer.warden = structuredClone(ms);
      const pv = wardenPreview(ctx, target);
      // 体力の幅（式の下限と上限。V3-3c §44.2）。大守護者は遅くならない
      offer.guardian = { rank: 3, traits: pv ? guardianTraits(ctx, pv.kind, pv.affixes, ctx.content.balance.guardian.warden.minSpeed, true) : [], name: { ...ms.name }, ...(ms.title ? { title: { ...ms.title } } : {}), types: [...ms.types], hpRange: wardenHpRange(ctx.content, target) };
      // 傷跡（V3-8 §53.3）: 前の挑戦で与えたダメージの 4 分の 1
      const live = Object.values(ctx.world.entities).find((e) => e.guardian?.warden && e.pos?.floor === `main:${target}` && (e.stats?.hp ?? 0) > 0);
      const sc = live ? projectedScar(live) : 0;
      if (sc) offer.scar = sc;
    }
    // 賞金首（V3-8 §53.2）: 種族・接辞・名前は候補で決める（公開）。残っている目的の賞金首は再挑戦（傷跡が残る。§53.3）
    if (type === 'slay_bounty') {
      const left = bountyLeft.get(target);
      if (left?.named) {
        const src = [...(ctx.world.expeditions ?? [])].reverse().find((x) => x.targets.bounty === left.id);
        offer.bounty = bountyOffer(ctx, target, { kind: left.kind, name: left.named, affixes: [...(left.scale?.affixes ?? [])] });
        offer.rechallenge = { no: src?.no ?? null, guardian: left.id, bounty: true };
        const sc = projectedScar(left);
        if (sc) offer.scar = sc;
      } else {
        const b = rollBounty(ctx, target, no, i);
        if (b) offer.bounty = bountyOffer(ctx, target, b);
        else offer.objective.type = 'reach_depth';
      }
    }
    // 宝物庫（V3-8 §53.2）: 鍵を持つ敵が階にいる
    if (type === 'open_vault') offer.vault = true;
    // 遺物（V3-3 §3.3）: 候補の時点で名前と加護を出す
    if (type === 'retrieve_relic') {
      const ri = pickRelic(ctx.content, ctx.world.secret.seed, no, i, owned, offeredRelics);
      if (ri) { offer.relic = ri; offeredRelics.add(ri.kind); }
    }
    // 守護者の見込み（格は枠で決まる。種族はここで決め、プレイヤーには特徴だけを出す）
    if (type === 'slay_guardian' || relicGuarded) {
      const rank = forceRank ?? guardianRankOf(slot);
      const kind = pickGuardianKind(ctx.content, ctx.world.secret.seed, 'main', target, rank, rng);
      if (kind) {
        // 接辞もここで決める（見込みの特徴と一撃の目安に入れる。生成ではこれを使う）
        const affixes = rollMonsterAffixes(ctx.content, target, Rng.fromSeed(`${ctx.world.secret.seed}|guardian-affix|${no}|${i}`));
        const armor = monsterArmorEstimate(ctx, target, kind, affixes);
        // 型・名前・弱点（V3-3 §3.1・§28.9）: 型と名前は候補に出す。弱点と種族は伏せる。
        // 弱点は装甲の目安で付けられるものだけ（V4-1l §34.2: 装甲の高い相手に「投擲に弱い」を付けない）
        const gi = rollGuardianInfo(ctx.content, ctx.world.secret.seed, no, i, rank, { armor });
        offer.guardianKind = kind;
        offer.guardianAffixes = affixes;
        offer.guardian = { rank, traits: guardianTraits(ctx, kind, affixes, 0, rank >= 2), name: gi.name, ...(gi.title ? { title: gi.title } : {}), types: gi.types, maxHit: guardianMaxHit(ctx, target, kind, affixes), hp: guardianHpEstimate(ctx, target, kind, rank, affixes), hpRange: guardianHpRange(ctx, target, kind, rank, affixes), armor };
        offer.guardianWeakness = gi.weakness;
      }
      // 再挑戦: 新しい守護者を作らず、残っている守護者をもう一度目的にする（同じ名前・型・弱点。乱数は上で引いたまま）
      if (rematch) {
        const src = [...(ctx.world.expeditions ?? [])].reverse().find((x) => x.targets.guardian === rematch.id);
        const g = rematch.guardian!;
        const rr = src?.guardianRank ?? rank;
        const affs = (rematch.scale?.affixes ?? []).filter((a) => ctx.content.affixes[a]?.target !== 'guardian');
        offer.guardianKind = rematch.kind;
        offer.guardianAffixes = affs;
        offer.guardianWeakness = g.weakness;
        offer.guardian = { rank: rr, traits: guardianTraits(ctx, rematch.kind, affs, 0, !!g.heavy), name: { ...g.name }, ...(g.title ? { title: { ...g.title } } : {}), types: [...g.types], maxHit: guardianMaxHit(ctx, target, rematch.kind, affs), hp: guardianHpEstimate(ctx, target, rematch.kind, rr, affs), hpRange: guardianHpRange(ctx, target, rematch.kind, rr, affs), armor: monsterArmorEstimate(ctx, target, rematch.kind, affs) };
        offer.rechallenge = { no: src?.no ?? null, guardian: rematch.id };
        const sc = projectedScar(rematch);
        if (sc) offer.scar = sc;
      }
    }
    return offer;
  });
}

export function offerExpeditions(ctx: Ctx): void {
  // 古い版で作った階の性質を足してから候補を作る（V4-0e §8.1）
  noteFloorTraits(ctx);
  const no = (ctx.world.expeditions?.length ?? 0) + 1;
  const ms = nextMilestone(ctx);
  ctx.emit({ type: 'expedition_offered', camp: { nextNo: no, offers: makeOffers(ctx, no), ...(ms ? { milestone: ms } : {}) }, seenBy: 'all', floor: null });
}

/** 目標階の生成で置くもの（目標階でなければ null） */
export function placementFor(ctx: Ctx, branch: string, depth: number): ObjectivePlacement | null {
  const x = currentExpedition(ctx.world);
  if (!x || branch !== 'main' || x.objective.targetDepth !== depth) return null;
  const g = {
    rank: x.guardianRank ?? guardianRankOf(x.slot), ...(x.guardianKind ? { guardianKind: x.guardianKind } : {}), ...(x.guardianAffixes ? { guardianAffixes: [...x.guardianAffixes] } : {}),
    ...(x.guardianName ? { info: { name: { ...x.guardianName }, ...(x.guardianTitle ? { title: { ...x.guardianTitle } } : {}), types: [...(x.guardianTypes ?? [])], weakness: x.guardianWeakness ?? null } } : {}),
  };
  // 再挑戦は新しく置かない（V3-3c §44.1）
  if (x.objective.type === 'slay_guardian') return { guardian: !x.rechallengeOf, relic: false, ...g };
  if (x.objective.type === 'retrieve_relic') return { guardian: x.relicGuarded, relic: true, ...g, ...(x.relic ? { relicKind: x.relic.kind } : {}) };
  // 賞金首・宝物庫（V3-8 §53.2）: 生成で異変「賞金首」・施錠された宝物庫を必ず付ける（再挑戦は新しく置かない）
  if (x.objective.type === 'slay_bounty') return x.rechallengeOf || !x.bounty ? null : { guardian: false, relic: false, bounty: structuredClone(x.bounty) };
  if (x.objective.type === 'open_vault') return { guardian: false, relic: false, vault: true };
  return null;
}

/**
 * 目標階が生成済みのとき（V3-2R3 §20.2）: 遠征の開始時に守護者・遺物を置く。生成時と同じ規則
 * （入口から歩いて遠い側の半分。入口から 8 マス以上・階段・扉・アクターのいるマスを除く）。乱数は expedition|通番|place
 */
function placeOnExistingFloor(ctx: Ctx, x: Expedition): void {
  const depth = x.objective.targetDepth;
  if (depth === null) return;
  const key = `main:${depth}`;
  const f = ctx.world.floors[key];
  const pl = placementFor(ctx, 'main', depth);
  if (!f || !pl || (!pl.guardian && !pl.relic)) return;
  const rng = Rng.fromSeed(`${ctx.world.secret.seed}|expedition|${x.no}|place`);
  const n = f.width * f.height;
  const dist = new Int32Array(n).fill(-1);
  const start = f.entry.y * f.width + f.entry.x;
  const q = [start];
  dist[start] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const cx = c % f.width, cy = Math.trunc(c / f.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
      const ni = ny * f.width + nx;
      if (dist[ni] >= 0) continue;
      const tr = ctx.terrainAt(key, nx, ny);
      if (!tr.passable && !tr.door) continue;
      dist[ni] = dist[c] + 1;
      q.push(ni);
    }
  }
  const ok = (i: number, minDist: number) => {
    const px = i % f.width, py = Math.trunc(i / f.width);
    const tr = ctx.terrainAt(key, px, py);
    return tr.passable && !tr.stairs && !tr.door && dist[i] >= minDist && !ctx.actorAt(key, px, py) && ctx.itemsAt(key, px, py).length === 0
      && !ctx.featureAt(key, px, py) && cheb({ x: px, y: py }, f.entry) > 7;
  };
  let cands: number[] = [];
  for (const minDist of [12, 8, 1]) {
    cands = [];
    for (let i = 0; i < n; i++) if (ok(i, minDist)) cands.push(i);
    if (cands.length) break;
  }
  if (!cands.length) return;
  cands.sort((a, b) => dist[a] - dist[b] || a - b);
  const far = cands.slice(Math.trunc(cands.length / 2));
  const at = far[rng.int(far.length)];
  const ax = at % f.width, ay = Math.trunc(at / f.width);
  const spawned: Entity[] = [];
  if (pl.relic) spawned.push(spawnFromSpec(ctx, key, { type: 'item', kind: pl.relicKind ?? 'core:relic', x: ax, y: ay, qty: 1, affixes: [], role: 'relic' }, 'objective'));
  if (pl.guardian) {
    let gx = ax, gy = ay;
    if (pl.relic) {
      const near: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const i = (ay + dy) * f.width + (ax + dx);
        if ((dx || dy) && ax + dx >= 0 && ay + dy >= 0 && ax + dx < f.width && ay + dy < f.height && ok(i, 1)) near.push(i);
      }
      if (near.length) { const ni = near[rng.int(near.length)]; gx = ni % f.width; gy = Math.trunc(ni / f.width); }
    }
    const rank = pl.rank ?? 2;
    const kind = pl.guardianKind ?? pickGuardianKind(ctx.content, ctx.world.secret.seed, 'main', depth, rank, rng);
    if (kind) {
      const spec = guardianSpec(ctx.content, depth, kind, rank, gx, gy, rng, pl.info, pl.guardianKind === kind ? pl.guardianAffixes : undefined);
      if (spec.type === 'monster') spec.delay = 0;
      const g = spawnFromSpec(ctx, key, spec, 'objective');
      // 生成済みの階の棲み処は地物だけ置く（護りの火。地形は変えない。V3-3）。火はこの守護者のもの（V3-3c §44.6）
      if (pl.info) {
        for (const fe of lairPlan(ctx.content, pl.info).features) {
          let placed = 0;
          for (let r = 2; r <= 4 && placed < fe.count; r++) for (let dy = -r; dy <= r && placed < fe.count; dy++) for (let dx = -r; dx <= r && placed < fe.count; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const fx = gx + dx, fy = gy + dy;
            if (fx < 0 || fy < 0 || fx >= f.width || fy >= f.height) continue;
            if (!ok(fy * f.width + fx, 1) || rng.chance(50)) continue;
            spawnFromSpec(ctx, key, { type: 'feature', kind: fe.kind, x: fx, y: fy, lair: true }, 'objective', { lairOf: g.id });
            placed++;
          }
        }
      }
      // 生成済みの階の時刻に合わせる（その階の時間で動き出す）
      spawned.push(g);
    }
  }
  recordTargets(ctx, spawned);
}

/** ensureFloor から: 生成された守護者・遺物を遠征に記録する（俯瞰専用イベント） */
export function recordTargets(ctx: Ctx, spawned: Entity[], extra: { bounty?: string | null; vaultLocks?: number } = {}): void {
  const x = currentExpedition(ctx.world);
  if (!x) return;
  const g = spawned.find((e) => e.role === 'guardian');
  const r = spawned.find((e) => e.role === 'relic');
  if (!g && !r && !extra.bounty && !extra.vaultLocks) return;
  const targets = {
    guardian: g?.id ?? x.targets.guardian, relic: r?.id ?? x.targets.relic,
    ...(extra.bounty ? { bounty: extra.bounty } : x.targets.bounty ? { bounty: x.targets.bounty } : {}),
    ...(extra.vaultLocks ? { vaultLocks: extra.vaultLocks } : x.targets.vaultLocks ? { vaultLocks: x.targets.vaultLocks } : {}),
  };
  ctx.emit({ type: 'objective_progress', no: x.no, progressAfter: { ...x.progress }, statusAfter: x.status, targetsAfter: targets, seenBy: [], floor: null });
}

function present(pr: PlayerRecord | undefined): boolean {
  return !!pr && (pr.state === 'alive' || pr.state === 'at_camp');
}

/** 目的の進捗を World から計算する（イベントは出さない） */
export function computeProgress(ctx: Ctx, x: Expedition): ObjectiveProgress {
  const w = ctx.world;
  // 到達（踏破型）の達成: 目標階（かそれより深い階）の下り階段に参加者が立った（V3-2R3 §20.1。着いただけでは達成しない）
  let reached = x.progress.reached;
  if (!reached && x.objective.targetDepth !== null) {
    for (const pid of w.playerOrder) {
      const pr = w.players[pid];
      if (pr.state !== 'alive') continue;
      const e = w.entities[pr.entityId];
      if (e?.pos && (w.floors[e.pos.floor]?.depth ?? 0) >= x.objective.targetDepth && ctx.terrainAt(e.pos.floor, e.pos.x, e.pos.y).stairs === 'down' && !sealedFloor(ctx, e.pos.floor)) reached = true;
    }
  }
  let maxDepth = x.progress.maxDepth ?? 0;
  let crossedDepth = x.progress.crossedDepth ?? 0;
  for (const pid of x.participants) {
    const pr = w.players[pid];
    const e = pr?.state === 'alive' ? w.entities[pr.entityId] : undefined;
    if (!e?.pos) continue;
    const depth = w.floors[e.pos.floor]?.depth ?? 0;
    maxDepth = Math.max(maxDepth, depth);
    // 踏破: 目標より深い階の下り階段に立った（その階を横切り終えた）
    // 封じられた下り階段（大守護者を倒した記録が無い）に立っても踏破にならない（V3-3 §3.2・V4-0a §1.1）
    if (x.objective.targetDepth !== null && depth > x.objective.targetDepth && ctx.terrainAt(e.pos.floor, e.pos.x, e.pos.y).stairs === 'down' && !sealedFloor(ctx, e.pos.floor)) {
      crossedDepth = Math.max(crossedDepth, depth);
    }
  }
  const guardianSlain = x.progress.guardianSlain
    || (x.objective.type === 'slay_warden' ? (w.milestones?.cleared ?? []).includes(x.objective.targetDepth ?? -1)
      : x.objective.type === 'slay_bounty' ? (!!x.targets.bounty && !w.entities[x.targets.bounty])
        : (x.targets.guardian !== null && !w.entities[x.targets.guardian]));
  // 宝物庫を開けた（V3-8 §53.2）: 目標階の鍵のかかった格子扉が、置いたときより減った
  let vaultOpened = x.progress.vaultOpened ?? false;
  if (!vaultOpened && x.objective.type === 'open_vault' && x.targets.vaultLocks && x.objective.targetDepth !== null) {
    const f = w.floors[`main:${x.objective.targetDepth}`];
    const li = w.meta.terrainTable.indexOf('core:grate_locked');
    if (f && li >= 0) { let n = 0; for (const tv of f.terrain) if (tv === li) n++; vaultOpened = n < x.targets.vaultLocks; }
  }
  let relicHeldBy: string | null = null;
  if (x.targets.relic) {
    const holder = w.entities[x.targets.relic]?.item?.heldBy;
    const he = holder ? w.entities[holder] : undefined;
    if (he?.player && present(w.players[he.player])) relicHeldBy = he.id;
  }
  return { reached, guardianSlain, relicHeldBy, maxDepth, ...(crossedDepth ? { crossedDepth } : {}), ...(vaultOpened ? { vaultOpened } : {}) };
}

function statusFor(o: Objective, p: ObjectiveProgress): Expedition['status'] {
  switch (o.type) {
    case 'reach_depth': return p.reached ? 'objective_complete' : 'in_progress';
    case 'slay_guardian':
    case 'slay_bounty':
    case 'slay_warden': return p.guardianSlain ? 'objective_complete' : 'in_progress';
    case 'open_vault': return p.vaultOpened ? 'objective_complete' : 'in_progress';
    case 'retrieve_relic': return p.relicHeldBy ? 'objective_complete' : 'in_progress';
    default: return 'in_progress';
  }
}

/** 進捗に変化があればイベントを出す（各 step の終わりに呼ぶ） */
export function checkObjective(ctx: Ctx): void {
  const x = currentExpedition(ctx.world);
  if (!x) return;
  const p = computeProgress(ctx, x);
  const status = statusFor(x.objective, p);
  const prev = x.status;
  if (p.reached === x.progress.reached && p.guardianSlain === x.progress.guardianSlain && p.relicHeldBy === x.progress.relicHeldBy
    && (p.maxDepth ?? 0) === (x.progress.maxDepth ?? 0) && (p.crossedDepth ?? 0) === (x.progress.crossedDepth ?? 0) && !!p.vaultOpened === !!x.progress.vaultOpened && status === prev) return;
  ctx.emit({ type: 'objective_progress', no: x.no, progressAfter: p, statusAfter: status, seenBy: [], floor: null });
  if (status === 'objective_complete' && prev !== 'objective_complete') {
    ctx.emit({ type: 'objective_completed', no: x.no, objective: { ...x.objective }, seenBy: 'all', floor: null });
    // 達成の経験値（盤面にいる参加者。目標深度に比例）
    const amount = ctx.content.balance.xp.perObjective * (x.objective.targetDepth ?? 0);
    for (const pid of x.participants) {
      const pr = ctx.world.players[pid];
      const e = pr?.state === 'alive' ? ctx.world.entities[pr.entityId] : undefined;
      if (e) grantXp(ctx, e, amount, { reason: 'objective' });
    }
  }
}

/**
 * この step で起きたことから、遠征の共有の戦利品を積み上げる（撃破・初めての発見・賞金）。
 * step の終わりに一度だけ呼ぶ。after 値の haul_changed を出す。
 */
export function accrueHaul(ctx: Ctx): void {
  const x = currentExpedition(ctx.world);
  if (!x) return;
  const w = ctx.world;
  const h = ctx.content.balance.haul;
  const byEntity = new Map<string, PlayerId>();
  for (const pid of x.participants) if (w.players[pid]) byEntity.set(w.players[pid].entityId, pid);
  const gains: ExpeditionHaul = { bounty: 0, discovery: 0, kills: 0 };
  const reasons: string[] = [];
  // この step で倒した数（プレイヤー×種族）。思い出の撃破数からこの数を引いて 0 なら「このランで初めて倒した」
  const killsNow = new Map<string, { pid: PlayerId; kind: string; n: number }>();
  for (const ev of ctx.events) {
    if (ev.type === 'died' && ev.killer && byEntity.has(ev.killer) && !byEntity.has(ev.id) && !w.players[ev.id]) {
      const pid = byEntity.get(ev.killer)!;
      // 見ていなかった相手（視界外で毒が倒した）: 撃破と賞金だけ。種族は書かない
      const unseen = !!ev.masks?.[pid]?.includes('id');
      // 撃破の点 = 種族の経験値 × killPerXp × 深さの係数、接辞付きは × killAffixPct %（V3-2R3 §20.5）
      const depth = ev.floor ? w.floors[ev.floor]?.depth ?? 1 : 1;
      gains.kills += killPoints({ expedition: ctx.content.balance.expedition, haul: h }, ctx.content.monsters[ev.kind]?.xp ?? 0, depth, (ev.affixes?.length ?? 0) > 0);
      // 守護者は種族の記録と分けるので、「初めて倒した種族」の発見に数えない
      if (ev.id === x.targets.guardian) { if (ev.bounty) { gains.bounty += ev.bounty; reasons.push(unseen ? 'bounty' : `bounty:${ev.kind}`); } continue; }
      if (ev.bounty) { gains.bounty += ev.bounty; reasons.push(unseen ? 'bounty' : `bounty:${ev.kind}`); }
      if (unseen) continue;
      const k = `${pid}|${ev.kind}`;
      const cur = killsNow.get(k);
      if (cur) cur.n++; else killsNow.set(k, { pid, kind: ev.kind, n: 1 });
    } else if (ev.type === 'item_identified' && x.participants.includes(ev.player)) {
      gains.discovery += h.discovery.identify;
      reasons.push(`identify:${ev.kind}`);
    } else if (ev.type === 'room_found' && x.participants.includes(ev.player)) {
      // 特殊部屋を見つけた・碑文を読んだ（V3-5 §5.1）
      gains.discovery += h.discovery.room;
      reasons.push(`room:${ev.room}`);
    } else if (ev.type === 'inscription_read' && x.participants.includes(ev.player) && !ev.note) {
      gains.discovery += h.discovery.inscription;
      reasons.push('inscription');
    }
  }
  for (const { pid, kind, n } of killsNow.values()) {
    const mem = w.players[pid]?.knowledge.monsterMemory[kind];
    if (mem && mem.kills - n === 0) {
      gains.discovery += h.discovery.species;
      reasons.push(`species:${kind}`);
    }
  }
  if (!gains.bounty && !gains.discovery && !gains.kills) return;
  const cur = x.haul ?? { bounty: 0, discovery: 0, kills: 0 };
  const after = { bounty: cur.bounty + gains.bounty, discovery: cur.discovery + gains.discovery, kills: cur.kills + gains.kills };
  const g: Partial<ExpeditionHaul> = {};
  if (gains.bounty) g.bounty = gains.bounty;
  if (gains.discovery) g.discovery = gains.discovery;
  if (gains.kills) g.kills = gains.kills;
  ctx.emit({ type: 'haul_changed', no: x.no, haulAfter: after, gains: g, reasons, seenBy: [...x.participants].sort(), floor: null });
}

/**
 * 特殊部屋を見つけた（V3-5 §5.1）: 参加者の視界に、まだ誰も見つけていない特殊部屋（tags に room）の中が入った。
 * 発見の点は 1 部屋 1 回（room_found の後、accrueHaul が数える）
 */
export function noteRooms(ctx: Ctx): void {
  const x = currentExpedition(ctx.world);
  if (!x) return;
  for (const pid of x.participants) {
    const pr = ctx.world.players[pid];
    const e = pr?.state === 'alive' ? ctx.world.entities[pr.entityId] : undefined;
    if (!e?.pos) continue;
    const f = ctx.world.floors[e.pos.floor];
    const rooms = f?.regions.filter((r) => r.kind === 'prefab' && r.tags.includes('room') && !r.found) ?? [];
    if (!rooms.length) continue;
    const vis = ctx.visibleSet(pid);
    for (const r of rooms) {
      let at: { x: number; y: number } | null = null;
      for (let y = r.y; y < r.y + r.h && !at; y++) for (let xx = r.x; xx < r.x + r.w; xx++) {
        if (!vis.has(y * f.width + xx)) continue;
        const tr = ctx.terrainAt(f.key, xx, y);
        if (tr.passable || tr.tags.includes('grate')) { at = { x: xx, y }; break; }
      }
      if (!at) continue;
      const def = ctx.content.lists.prefabs.find((pf) => pf.id === r.tags[0]);
      ctx.emit({ type: 'room_found', player: pid, floorKey: f.key, region: r.id, room: r.tags[0], name: def?.name ? { ...def.name } : { ja: r.tags[0], en: r.tags[0] }, at, seenBy: [...x.participants].sort(), floor: f.key });
    }
  }
}

/**
 * 自分の視界に追跡中（逃走中を除く）の敵がいるか（観測と同じ判定）。
 * forRest: 休憩の判定では、動かない敵は隣接していなければ数えない（V3-2R §14.2）
 */
export function huntingInView(ctx: Ctx, pr: PlayerRecord, forRest = false): boolean {
  const me = ctx.world.entities[pr.entityId];
  if (!me?.pos) return false;
  const key = me.pos.floor;
  for (const e of ctx.entitiesOn(key)) {
    if (!e.actor || e.player || !e.pos || (e.stats?.hp ?? 0) <= 0) continue;
    if (!ctx.seesActor(pr.id, e)) continue;
    if (forRest && ctx.content.monsters[e.kind]?.tags.includes('stationary') && cheb(e.pos, me.pos) > 1) continue;
    if (isPursuing(e)) return true;
  }
  return false;
}

/** その場で extract したら「達成」になるか */
export function wouldComplete(ctx: Ctx, x: Expedition, e: Entity): boolean {
  const p = computeProgress(ctx, x);
  if (statusFor(x.objective, p) !== 'objective_complete') return false;
  if (x.objective.type === 'retrieve_relic') return p.relicHeldBy === e.id;
  return true;
}

/** fire: 階段の上でなく、野営の火の上か隣から帰る（S1c §14.3 の 1。帰り支度の手番がかかる） */
export function extractError(ctx: Ctx, e: Entity, pr: PlayerRecord, confirm: boolean | undefined): { error: ActionError } | { completed: boolean; expedition: Expedition; fire?: Entity } {
  const L = pr.locale;
  const x = currentExpedition(ctx.world);
  if (!x) return { error: actionError('cannot_extract', t(L, '進行中の遠征が無い。', 'There is no expedition in progress.'), t(L, 'キャンプなら start_expedition で次の遠征を始める。', 'At camp, start one with start_expedition.')) };
  const tr = ctx.terrainAt(e.pos!.floor, e.pos!.x, e.pos!.y);
  // シーズンのラン: 野営の火の上か隣なら、追ってくる敵が見えていなければ、帰り支度の後に帰れる（S1c §14.3 の 1）
  const fire = !tr.stairs ? campfireNear(ctx, e) : undefined;
  if (!tr.stairs && !fire) {
    return { error: actionError('cannot_extract', t(L, ctx.world.season ? '階段の上か、野営の火の上か隣でないと extract できない。' : '階段の上でないと extract できない。', ctx.world.season ? 'You must stand on stairs, or on or next to a campfire, to extract.' : 'You must stand on stairs to extract.'), t(L, 'travel_to stairs_up / stairs_down で階段へ移動する。階段から遠ければ帰還の綱（use_item）も使える。', 'Move onto stairs with travel_to stairs_up / stairs_down. Far from stairs, the lifeline (use_item) also works.')) };
  }
  if (fire) {
    const err = fireReturnCheck(ctx, e, pr, fire);
    if (err) return { error: err };
  }
  // 階段の上なら追跡中の敵が見えていても extract できる（敵は階段を追ってこない。V3-2R2 §18.1）
  const completed = wouldComplete(ctx, x, e);
  if (!completed && confirm !== true) {
    return { error: actionError('confirm_required', t(L, '目的は未達成。今 extract すると撤退（報酬なし）になる。', 'The objective is not complete; extracting now is a withdrawal (no reward).'), t(L, '撤退するなら confirm: true を付けて extract する。', 'To withdraw, call extract with confirm: true.')) };
  }
  return { completed, expedition: x, ...(fire ? { fire } : {}) };
}

/** extract の実行: 盤面から外してキャンプへ（全回復・状態異常解除）。lifeline: 帰還の綱で戻った */
export function doExtract(ctx: Ctx, e: Entity, pr: PlayerRecord, completed: boolean, x: Expedition, lifeline = false): void {
  const me = ctx.world.entities[e.id];
  const key = me.pos!.floor;
  ctx.curFloor = key;
  ctx.emit({ type: 'actor_scheduled', id: me.id, nextActAt: me.actor!.nextActAt + 100, turns: me.actor!.turns + 1, seenBy: [pr.id], floor: key });
  // 持ち帰った宝は換金する（所持品から外す）
  let cur0 = ctx.world.entities[e.id];
  const treasure = treasureHeld(ctx, cur0);
  // 宝と、達成して持ち帰った遺物は所持品から外す（遺物は納める）。綱で戻ると、持っていた遺物は失う（運べない。V3-4b §28.1）
  const relicIds = (cur0.inv?.items ?? []).filter((id) => ctx.content.items[ctx.world.entities[id]?.kind ?? '']?.category === 'relic');
  // 達成して階段の上で持ち帰った遺物は加護になる（綱では持ち帰れない。V3-3 §3.3・§28.9）
  if (completed && !lifeline) {
    for (const id of relicIds) {
      const kind = ctx.world.entities[id]?.kind ?? '';
      const def = ctx.content.items[kind];
      // 物語の 1 文（V3-3 §3.4）: 遺物を納めた（由来の文）
      tellStory(ctx, 'relic_delivered', pickLore(ctx.content, ctx.world.secret.seed, `relic|${x.no}|${kind}`, 'relic_delivered', {}, {
        relic: { ...(def?.name ?? { ja: kind, en: kind }) }, origin: def?.origin ? { ...def.origin } : { ja: '', en: '' },
      }), key);
      if (def?.boon) grantBoon(ctx, cur0, def.boon, kind);
      recallWarden(ctx, pr, kind, key);
    }
  }
  const relicLost = lifeline && relicIds.length > 0;
  cur0 = ctx.world.entities[e.id];
  const treasureIds = (cur0.inv?.items ?? []).filter((id) => ctx.content.items[ctx.world.entities[id]?.kind ?? '']?.category === 'treasure'
    || ((completed || lifeline) && relicIds.includes(id)));
  ctx.emit({
    type: 'objective_progress', no: x.no, progressAfter: { ...x.progress }, statusAfter: x.status,
    extractedAfter: [...x.extracted, { player: pr.id, completed, treasure, ...(lifeline ? { lifeline: true } : {}) }], seenBy: [], floor: key,
  });
  const cur = ctx.world.entities[e.id];
  // 綱で戻った次の遠征は、この遠征を始めた地点から（綱を使った地点ではない。V3-2R3a §22.1）
  const startPos = lifeline ? x.start[pr.id]?.pos : undefined;
  let extractPos = startPos && ctx.world.floors[startPos.floor] ? { ...startPos } : { floor: key, x: cur.pos!.x, y: cur.pos!.y };
  // 封じられた下り階段（大守護者の広間）の上なら、次の遠征はその階の上り階段から（V3-3b §40.6: 全快した大守護者の広間から始まった）
  {
    const ef = ctx.world.floors[extractPos.floor];
    if (ef?.stairs.up && ef.stairs.down.some((s) => s.x === extractPos.x && s.y === extractPos.y) && sealedFloor(ctx, extractPos.floor)) {
      extractPos = { floor: extractPos.floor, x: ef.stairs.up.x, y: ef.stairs.up.y };
    }
  }
  const body = structuredClone(cur);
  delete body.pos;
  if (treasureIds.length) body.inv = { ...body.inv!, items: body.inv!.items.filter((id) => !treasureIds.includes(id)) };
  body.actor = { ...body.actor!, dormant: true, regen: 0 };
  body.stats = { ...body.stats!, hp: body.stats!.maxHp };
  body.statuses = [];
  // 能動技の再使用待ちもキャンプで戻る（V3-5a 後の AI 評価: 遠征をまたいで「あと 6」が残った）。遠征に 1 回の能動技は usedNo で別に数える
  if (body.build?.abilities?.length) body.build = { ...body.build, abilities: body.build.abilities.map((a) => ({ ...a, readyAt: 0 })) };
  ctx.emit({ type: 'player_state', player: pr.id, state: 'at_camp', reason: lifeline ? 'lifeline' : completed ? 'extracted' : 'withdrew', extractPos, ...(relicLost ? { relicLost: true } : {}), put: [body], ...(treasureIds.length ? { del: treasureIds } : {}), seenBy: 'all', floor: key });
  maybeEndExpedition(ctx);
}

/**
 * シーズンの行動予算が尽きた（S0。PROTOCOL §9.2）: その場からキャンプへ戻す。未確定の戦利品は失い、持ち物は残る（宝・遺物も持ったまま）。
 * 倒れた扱いにしない。次の遠征は、綱と同じく、この遠征を始めた地点から（ただし予算が無いので始められない）
 */
export function timeUp(ctx: Ctx, e: Entity, pr: PlayerRecord): void {
  const x = currentExpedition(ctx.world);
  const me = ctx.world.entities[e.id];
  if (!x || !me?.pos || pr.state !== 'alive') return;
  const key = me.pos.floor;
  ctx.curFloor = key;
  ctx.emit({
    type: 'objective_progress', no: x.no, progressAfter: { ...x.progress }, statusAfter: x.status,
    extractedAfter: [...x.extracted, { player: pr.id, completed: false, treasure: 0, timeUp: true }], seenBy: [], floor: key,
  });
  const startPos = x.start[pr.id]?.pos;
  const extractPos = startPos && ctx.world.floors[startPos.floor] ? { ...startPos } : { floor: key, x: me.pos.x, y: me.pos.y };
  const body = structuredClone(ctx.world.entities[e.id]);
  delete body.pos;
  body.actor = { ...body.actor!, dormant: true, regen: 0 };
  body.stats = { ...body.stats!, hp: body.stats!.maxHp };
  body.statuses = [];
  if (body.build?.abilities?.length) body.build = { ...body.build, abilities: body.build.abilities.map((a) => ({ ...a, readyAt: 0 })) };
  ctx.emit({ type: 'player_state', player: pr.id, state: 'at_camp', reason: 'time_up', extractPos, put: [body], seenBy: 'all', floor: key });
  maybeEndExpedition(ctx);
}

/** 記録庫が次の節目の大守護者の記憶を 1 つ返す（V3-3a §35.7）: 節目ごとに 1 つ目は弱点、2 つ目は体力と最大の一撃、3 つ目からは無い */
function recallWarden(ctx: Ctx, pr: PlayerRecord, relic: string, floor: string): void {
  const ms = nextMilestone(ctx);
  if (!ms) return;
  const known = ctx.world.players[pr.id]?.knowledge.wardenIntel?.[String(ms.depth)] ?? {};
  const base = { type: 'archive_recalled' as const, player: pr.id, relic, depth: ms.depth, guardianName: { ...ms.name }, seenBy: [pr.id], floor };
  // 弱点は、その階の大守護者のもの（作られていればその個体、まだなら作ったときの弱点。装甲の目安で変わるので下見から。V4-1l §34.2）
  const pv = wardenPreview(ctx, ms.depth);
  if (!known.weakness) {
    const w = pv?.weakness;
    if (w) { ctx.emit({ ...base, memory: 'weakness', weakness: w }); return; }
  }
  if (known.hp === undefined) {
    if (pv) { ctx.emit({ ...base, memory: 'vitals', hp: pv.hp, maxHit: pv.maxHit, armor: pv.armor }); return; }
  }
  ctx.emit({ ...base, memory: 'none' });
}

/** 帰還の綱の効果が終わった: その場からキャンプへ（確定は目的を除く戦利品の lifeline.pct %。遺物は失う。V3-4b §28.1） */
export function lifelineReturn(ctx: Ctx, e: Entity): void {
  const me = ctx.world.entities[e.id];
  const pr = me?.player ? ctx.world.players[me.player] : undefined;
  const x = currentExpedition(ctx.world);
  if (!me?.pos || !pr || pr.state !== 'alive' || !x) return;
  doExtract(ctx, me, pr, wouldComplete(ctx, x, me), x, true);
}

/** 所持数に数える品の数（手放せない品＝帰還の綱は数えない） */
export function invCount(ctx: Ctx, e: Entity): number {
  return (e.inv?.items ?? []).filter((id) => !ctx.content.items[ctx.world.entities[id]?.kind ?? '']?.bound).length;
}

/** 遠征の開始時: 参加者の帰還の綱を 1 本にそろえる（余っていても 1 本、無ければ補充） */
function issueLifeline(ctx: Ctx, pid: PlayerId): void {
  const pr = ctx.world.players[pid];
  const me = pr ? ctx.world.entities[pr.entityId] : undefined;
  if (!me?.pos || !me.inv || !ctx.content.items[LIFELINE]) return;
  const held = me.inv.items.map((id) => ctx.world.entities[id]).filter((it): it is Entity => it?.kind === LIFELINE);
  if (held.length === 1 && held[0].item!.qty === 1) return;
  const actor = structuredClone(me);
  const put: Entity[] = [];
  const del: string[] = [];
  let itemId: string;
  if (held.length) {
    const keep = structuredClone(held[0]);
    keep.item!.qty = 1;
    put.push(keep);
    itemId = keep.id;
    for (const extra of held.slice(1)) { del.push(extra.id); actor.inv!.items = actor.inv!.items.filter((id) => id !== extra.id); }
  } else {
    const used = new Set(me.inv.items.map((id) => ctx.world.entities[id]?.item?.slot));
    let slot: string | null = null;
    for (let c = 97; c <= 122 && !slot; c++) if (!used.has(String.fromCharCode(c))) slot = String.fromCharCode(c);
    if (!slot) return;
    itemId = ctx.newEntityId();
    put.push({ id: itemId, kind: LIFELINE, sid: ctx.nextSid(), item: { qty: 1, affixes: [], heldBy: me.id, slot } });
    actor.inv!.items.push(itemId);
  }
  put.push(actor);
  ctx.emit({ type: 'item_issued', actor: me.id, item: itemId, kind: LIFELINE, qty: 1, reason: 'expedition_started', put, ...(del.length ? { del } : {}), seenBy: [pid], floor: me.pos.floor });
}

/** 盤面に誰も残っていなければ遠征を終える（extract・死亡・引退の後に呼ぶ） */
export function maybeEndExpedition(ctx: Ctx): void {
  const w = ctx.world;
  const x = currentExpedition(w);
  if (!x) return;
  if (w.playerOrder.some((pid) => w.players[pid].state === 'alive')) return;
  let reason: ExpeditionEndReason;
  if (x.extracted.length) reason = x.extracted.some((r) => r.completed && !r.lifeline && !r.timeUp) ? 'completed' : x.extracted.some((r) => r.lifeline) ? 'lifeline'
    : x.extracted.some((r) => !r.timeUp) ? 'withdrawn' : 'time_up';
  else reason = x.participants.some((pid) => w.players[pid]?.state === 'dead') ? 'died' : 'retired';
  const points = reason === 'completed' ? x.points : 0;
  let deepest = 0, kills = 0, turns = 0;
  for (const pid of x.participants) {
    const pr = w.players[pid];
    if (!pr) continue;
    const s0 = x.start[pid] ?? { kills: 0, turns: 0, deepest: 0 };
    const pe = w.entities[pr.entityId];
    deepest = Math.max(deepest, pr.stats.deepest);
    kills += pr.stats.kills - s0.kills;
    turns += (pe?.actor?.turns ?? 0) - s0.turns;
  }
  // 払い戻し（スコア版 2）: 帰還した人に確定、死亡・引退した人の分は失う
  const shared = sharedParts(ctx, x);
  const mult = x.multiplierPct ?? 100;
  const players: { player: PlayerId; banked: number; lost: number }[] = [];
  let partsTotal: HaulParts = { ...shared };
  for (const r of x.extracted) {
    const pr = w.players[r.player];
    if (!pr) continue;
    // 時間切れ（S0 §9.2）: 確定 0。未確定の戦利品は失う（持っている宝は持ち物に残るので、失った数には宝を入れない）
    if (r.timeUp) {
      const lost = haulTotal({ ...shared, treasure: 0 });
      players.push({ player: pr.id, banked: 0, lost });
      ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...pr.stats, lost: (pr.stats.lost ?? 0) + lost }, seenBy: [pr.id], floor: null });
      continue;
    }
    const parts = { ...shared, treasure: r.treasure ?? 0 };
    partsTotal = { ...partsTotal, treasure: partsTotal.treasure + parts.treasure };
    const banked = payoutOf(ctx.content.balance, parts, r.completed, mult, !!r.lifeline);
    players.push({ player: pr.id, banked, lost: 0 });
    const done = r.completed && !r.lifeline && reason === 'completed';
    ctx.emit({
      type: 'player_stats', player: pr.id,
      stats: {
        ...pr.stats, banked: (pr.stats.banked ?? 0) + banked,
        ...(done ? { expeditions: (pr.stats.expeditions ?? 0) + 1, expeditionPoints: (pr.stats.expeditionPoints ?? 0) + points } : {}),
      },
      seenBy: [pr.id], floor: null,
    });
  }
  for (const pid of x.participants) {
    const pr = w.players[pid];
    if (!pr || x.extracted.some((r) => r.player === pid) || (pr.state !== 'dead' && pr.state !== 'left')) continue;
    const body = w.entities[pr.entityId];
    const lost = haulTotal({ ...shared, treasure: body ? treasureHeld(ctx, body) : 0 });
    players.push({ player: pid, banked: 0, lost });
    ctx.emit({ type: 'player_stats', player: pid, stats: { ...pr.stats, lost: (pr.stats.lost ?? 0) + lost }, seenBy: [pid], floor: null });
  }
  const result: ExpeditionResult = {
    reason, points, deepest, kills, turns,
    payout: { banked: players.reduce((a, p) => a + p.banked, 0), lost: players.reduce((a, p) => a + p.lost, 0), multiplierPct: mult, parts: partsTotal, players },
  };
  ctx.emit({ type: 'expedition_ended', no: x.no, reason, result, summary: buildSummary(ctx, `expedition_${x.no}_${reason}`, true), seenBy: 'all', floor: null });
  if (w.playerOrder.some((pid) => w.players[pid].state === 'at_camp')) offerExpeditions(ctx);
}

/** start_expedition: キャンプ（または遠征の無い状態）から次の遠征を始める */
export function startExpedition(ctx: Ctx, pr: PlayerRecord, offer: number | 'endless'): ActionError | null {
  const L = pr.locale;
  const w = ctx.world;
  // 仲間がまだ迷宮にいる（キャンプに戻ったのは自分だけ）: だれがどの階にいるかを details.still_inside と hint に入れる（V4-1f §22.4）
  const stillInside = (base: ActionError): ActionError => {
    if (pr.state !== 'at_camp') return base;
    const inside = w.playerOrder.filter((pid) => pid !== pr.id && w.players[pid].state === 'alive').map((pid) => {
      const o = w.players[pid];
      const at = w.entities[o.entityId]?.pos?.floor;
      return { id: pid, name: o.name, floor: at ? w.floors[at]?.depth ?? 0 : 0 };
    });
    if (!inside.length) return base;
    const who = inside.map((m) => t(L, `${m.name}がまだ地下 ${m.floor} 階にいる`, `${m.name} is still on depth ${m.floor}`)).join(t(L, '、', '; '));
    return { ...base, hint: t(L, `${who}。遠征は全員が戻るまで続く。`, `${who}. The expedition lasts until everyone is back.`), details: { still_inside: inside } };
  };
  if (currentExpedition(w)) return stillInside(actionError('bad_request', t(L, '遠征は既に進行中。', 'An expedition is already in progress.'), t(L, '行動ツールで遠征を続ける。', 'Continue with action tools.')));
  if (pr.state !== 'at_camp' && pr.state !== 'alive') return actionError('dead', t(L, 'あなたは既にランから外れている。', 'You are no longer in the run.'), '');
  const camp = w.camp;
  if (!camp) return stillInside(actionError('not_at_camp', t(L, '遠征の候補が無い。', 'There are no expedition offers.'), t(L, '仲間の遠征が終わるのを待つ。', 'Wait for your allies to finish.')));
  if (offer !== 'endless' && !camp.offers.some((c) => c.index === offer)) return actionError('bad_request', t(L, `候補 ${offer} は無い。`, `There is no offer ${offer}.`), t(L, `offer は 1〜${camp.offers.length} か "endless"。`, `offer is 1-${camp.offers.length} or "endless".`));
  // 節目の階の不変条件（V4-0a §1.1）: 倒した記録の無い節目の階に大守護者がいなければ、作り直す
  restoreForStart(ctx);
  let objective: Objective;
  let points = 0;
  let relicGuarded = false;
  let slot: OfferSlot | undefined;
  let traits: string[] = [];
  let multiplierPct = 100;
  let guardianKind: string | undefined;
  let guardianAffixes: string[] | undefined;
  let rechallengeOf: string | undefined;
  let guardianInfo: { name?: Names; title?: Names; types?: string[]; weakness?: string | null } = {};
  let relic: Expedition['relic'];
  let bounty: BountyInfo | undefined;
  if (offer === 'endless') objective = { type: 'endless', targetDepth: null };
  else {
    const o = camp.offers.find((c) => c.index === offer);
    if (!o) return actionError('bad_request', t(L, `候補 ${offer} は無い。`, `There is no offer ${offer}.`), t(L, `offer は 1〜${camp.offers.length} か "endless"。`, `offer is 1-${camp.offers.length} or "endless".`));
    objective = { ...o.objective };
    points = o.points;
    relicGuarded = o.relicGuarded;
    slot = o.slot;
    traits = [...(o.traits ?? [])];
    multiplierPct = o.multiplierPct ?? 100;
    guardianKind = o.guardianKind;
    guardianAffixes = o.guardianAffixes;
    // 再挑戦の守護者がまだ生きていれば、その守護者を目的にする
    if (o.rechallenge && w.entities[o.rechallenge.guardian]) rechallengeOf = o.rechallenge.guardian;
    if (o.guardian?.name) guardianInfo = { name: { ...o.guardian.name }, ...(o.guardian.title ? { title: { ...o.guardian.title } } : {}), types: [...(o.guardian.types ?? [])], weakness: o.guardianWeakness ?? null };
    if (o.relic) relic = structuredClone(o.relic);
    if (o.bounty) bounty = { kind: o.bounty.kind, name: { ...o.bounty.name }, affixes: [...o.bounty.affixes] };
  }
  const participants: PlayerId[] = w.playerOrder.filter((pid) => present(w.players[pid]));
  const start: Expedition['start'] = {};
  for (const pid of participants) {
    const p = w.players[pid];
    const pe = w.entities[p.entityId];
    // この遠征を始める地点（キャンプからなら再開する階段、盤面にいればその場）
    const pos = p.state === 'at_camp' ? resumePointOf(ctx, pid) : pe?.pos ? { floor: pe.pos.floor, x: pe.pos.x, y: pe.pos.y } : undefined;
    start[pid] = { kills: p.stats.kills, turns: pe?.actor?.turns ?? 0, deepest: p.stats.deepest, ...(pos ? { pos } : {}), ...(pe?.stats ? { hp: pe.stats.hp, maxHp: pe.stats.maxHp } : {}) };
  }
  let startDepth = 0;
  for (const pid of participants) {
    const p = w.players[pid];
    const e = w.entities[p.entityId];
    const at = e?.pos?.floor ?? p.extractPos?.floor;
    if (at) startDepth = Math.max(startDepth, w.floors[at]?.depth ?? 0);
  }
  const exp: Expedition = {
    no: camp.nextNo, objective, points, relicGuarded, status: 'in_progress', startSeq: w.seq + 1, endSeq: null, endReason: null,
    participants, start, targets: { guardian: null, relic: null, ...(objective.type === 'slay_bounty' && rechallengeOf ? { bounty: rechallengeOf } : {}) }, progress: { reached: false, guardianSlain: false, relicHeldBy: null, maxDepth: startDepth },
    extracted: [], result: null,
    ...(slot ? { slot } : {}), traits, multiplierPct, haul: { bounty: 0, discovery: 0, kills: 0 },
    ...(guardianKind ? { guardianKind } : {}), ...(guardianAffixes ? { guardianAffixes: [...guardianAffixes] } : {}), ...(rechallengeOf ? { rechallengeOf } : {}), guardianRank: objective.type === 'slay_warden' ? 3 : (camp.offers.find((c) => c.index === offer)?.guardian?.rank ?? guardianRankOf(slot)),
    ...(guardianInfo.name ? { guardianName: guardianInfo.name, ...(guardianInfo.title ? { guardianTitle: guardianInfo.title } : {}), guardianTypes: guardianInfo.types ?? [], guardianWeakness: guardianInfo.weakness ?? null } : {}),
    ...(relic ? { relic } : {}),
    ...(bounty ? { bounty } : {}),
    ...(camp.milestone ? { milestone: structuredClone(camp.milestone) } : {}),
  };
  // 物語の 1 文（V3-3 §3.4）: 目的・守護者の型・遺物から選ぶ
  const gName = guardianInfo.name ? displayName({ name: guardianInfo.name, ...(guardianInfo.title ? { title: guardianInfo.title } : {}) }) : undefined;
  const story = pickLore(ctx.content, w.secret.seed, `expedition|${exp.no}|briefing`, 'briefing',
    { objective: objective.type, guarded: relicGuarded, guardianTypes: guardianInfo.types ?? [] },
    { depth: num(objective.targetDepth ?? 0), ...(gName ? { guardian: gName } : {}), ...(relic ? { relic: { ...relic.name } } : {}) });
  if (story) exp.story = story;
  ctx.emit({ type: 'expedition_started', expedition: exp, seenBy: 'all', floor: null });
  // 目的でなくなった守護者は階を去る（V3-3c §44.1）。再挑戦の守護者は残す
  departGuardians(ctx, rechallengeOf ?? null, participants);
  // キャンプで休んでいる間に、すべての階の守護者も全快して落ち着く（V3-3a §35.1）。傷跡を残すので、ほかの敵より先に落ち着かせる（V4-0e §8.3）
  const settledAlready = new Set<string>();
  for (const e of Object.values(w.entities).filter((x) => x.guardian && x.pos && (x.stats?.hp ?? 0) > 0).sort((a, b) => a.sid - b.sid)) {
    settledAlready.add(e.id);
    const r = settleGuardian(ctx, e, true);
    if (!r.healed && !r.dispersed) continue;
    // その階を知っている参加者に、戻ったときの変化として知らせる（V3-3b §40.3: 「ミセの手下は散っていた」）
    const seen = participants.filter((pid) => !!w.players[pid]?.knowledge.floors[e.pos!.floor] && w.players[pid].knowledge.met.includes(e.id));
    for (const pid of seen) ctx.emit({ type: 'guardian_rested', id: e.id, guardianName: { ...e.guardian!.name }, full: true, player: pid, ...(r.dispersed ? { dispersed: r.dispersed } : {}), seenBy: [pid], floor: e.pos!.floor });
  }
  // 再挑戦の賞金首（V3-8 §53.3）: キャンプの間に落ち着いて傷が癒える（傷跡の分は残る）
  const kept = exp.objective.type === 'slay_bounty' && exp.rechallengeOf ? w.entities[exp.rechallengeOf] : undefined;
  if (kept?.pos && kept.stats && kept.actor) {
    const scar = projectedScar(kept);
    const top = kept.stats.maxHp - scar;
    const key = kept.pos.floor;
    if (kept.stats.hp < top) ctx.emit({ type: 'healed', target: kept.id, targetKind: kept.kind, amount: top - kept.stats.hp, hpAfter: top, via: 'camp', resetSeen: true, seenBy: [], floor: key });
    const body = structuredClone(w.entities[kept.id]);
    body.statuses = [];
    if (scar) body.scar = scar;
    if (body.actor!.ai) { body.actor!.ai = { ...body.actor!.ai, state: 'unaware', targetPos: null, lostTurns: 0 }; delete body.actor!.ai.intent; }
    ctx.emit({ type: 'guardian_state', id: kept.id, put: [body], seenBy: [], floor: key });
    settledAlready.add(kept.id);
  }
  // 遠征と遠征の間に、すべての階の敵が落ち着く（V4-0e §8.3。今までは再開する階だけ。V3-2R3a §22.1）: 追跡をやめ、全快し、状態異常が消え、
  // 見た被害の記憶も消える。守護者と再挑戦の賞金首は上で落ち着かせた（傷跡が残る）。盤面にいる参加者の階はそのまま。
  // 再開する階では、再開するマスが見える敵を離れた場所へ（守護者は持ち場へ）
  const settleRng = Rng.fromSeed(`${w.secret.seed}|expedition|${exp.no}|settle`);
  const resumeAt = new Map<string, FloorPos[]>();
  for (const pid of participants) {
    if (w.players[pid].state !== 'at_camp') continue;
    const at = resumePointOf(ctx, pid);
    const list = resumeAt.get(at.floor) ?? [];
    if (!list.some((p) => p.x === at.x && p.y === at.y)) list.push(at);
    resumeAt.set(at.floor, list);
  }
  const onBoard = new Set(participants.filter((pid) => w.players[pid].state !== 'at_camp').map((pid) => w.entities[w.players[pid].entityId]?.pos?.floor).filter((k): k is string => !!k));
  for (const key of Object.keys(w.floors).sort(floorOrder)) {
    if (!onBoard.has(key)) settleFloor(ctx, key, resumeAt.get(key) ?? [], settleRng, settledAlready);
  }
  for (const pid of participants) if (w.players[pid].state === 'at_camp') returnFromCamp(ctx, pid);
  // キャンプが帰還の綱を 1 本持たせる
  for (const pid of participants) issueLifeline(ctx, pid);
  // 目標階が生成済みなら、守護者・遺物をこの時点で置く
  const started = currentExpedition(w);
  if (started) placeOnExistingFloor(ctx, started);
  // 再挑戦: 残っていた守護者を目的に記録する
  if (started && rechallengeOf && w.entities[rechallengeOf]) recordTargets(ctx, [w.entities[rechallengeOf]]);
  // 条件（視界など）を能力値に反映
  for (const pid of participants) {
    const e = w.entities[w.players[pid].entityId];
    if (e?.pos) recomputeStats(ctx, e, 'expedition');
  }
  return null;
}

/**
 * 遠征の開始時の検査（V4-0a §1.1・V4-0b §1.2。いつでも成り立つべき条件を確かめて直す）: 地形の表を今のコンテンツに合わせ、
 * 大守護者のいない、倒した記録の無い節目の階を作り直す。
 * キャンプから再開する地点がその階だった参加者は、作り直した階の上り階段から始める（その階はこの時点で作る）
 */
function restoreForStart(ctx: Ctx): void {
  const w = ctx.world;
  // 地形の表と隠れる地形を今のコンテンツに合わせる（古い版で始まったラン。V4-0b §1.2）
  syncTerrainTable(ctx);
  // 古い版で作った階に、作ったときに効いた条件を足す（V4-0e §8.1）
  noteFloorTraits(ctx);
  const reset = restoreMilestoneFloors(ctx);
  if (!reset.length) return;
  for (const pid of w.playerOrder) {
    const p = w.players[pid];
    const at = p.extractPos;
    if (p.state !== 'at_camp' || !at || !reset.includes(at.floor)) continue;
    const f = ensureFloor(ctx, at.floor);
    const up = f.stairs.up ?? f.entry;
    ctx.emit({ type: 'player_state', player: pid, state: p.state, reason: 'floor_reset', extractPos: { floor: at.floor, x: up.x, y: up.y }, seenBy: 'all', floor: null });
  }
}

/** キャンプから再開する地点（前回 extract した地点。無ければ地下 1 階の入口） */
function resumePointOf(ctx: Ctx, pid: PlayerId): FloorPos {
  const w = ctx.world;
  const pr = w.players[pid];
  const f1 = w.floors['main:1'];
  return pr.extractPos && w.floors[pr.extractPos.floor] ? { ...pr.extractPos } : { floor: 'main:1', x: f1.entry.x, y: f1.entry.y };
}

/**
 * 階を落ち着かせる（V3-2R3a §22.1・V4-0e §8.3。遠征の開始時に、作られているすべての階）: 敵は追跡をやめ（眠っている者はそのまま。予備動作も消える）、
 * 体力は全快し、状態異常が消え、プレイヤーが見た被害の記憶も消える。done（守護者・再挑戦の賞金首）は先に傷跡を残して落ち着かせたので、見た被害の記憶だけ消す。
 * resume: この階から再開する地点。再開するマスが見える位置にいる敵は、転移の着地と同じ規則で動かす（12 マス以上離れ、そこから見えないマス。
 * 無ければ最も遠いマス）。守護者は持ち場へ戻す
 */
function settleFloor(ctx: Ctx, key: string, resume: readonly FloorPos[], rng: Rng, done: ReadonlySet<string>): void {
  const f = ctx.world.floors[key];
  if (!f) return;
  const prevFloor = ctx.curFloor;
  ctx.curFloor = key;
  const mons = ctx.entitiesOn(key).filter((m) => m.actor?.ai && !m.player && m.pos && (m.stats?.hp ?? 0) > 0).sort((a, b) => a.sid - b.sid);
  const seenBySomeone = (id: string) => Object.values(ctx.world.players).some((p) => !!p.knowledge.damageSeen?.[id]);
  for (const m0 of mons) {
    let m = ctx.world.entities[m0.id];
    if (!done.has(m.id)) {
      const ai = m.actor!.ai!;
      if ((ai.state !== 'asleep' && ai.state !== 'unaware') || ai.targetPos || ai.intent) {
        const next: AiState = { ...ai, state: ai.state === 'asleep' ? 'asleep' : 'unaware', targetPos: null, lostTurns: 0 };
        delete next.intent;
        ctx.emit({ type: 'ai_state_changed', id: m.id, ai: next, dormant: !!m.actor!.dormant, nextActAt: m.actor!.nextActAt, seenBy: [], floor: key });
      }
      m = ctx.world.entities[m.id];
      // 全快し、見ていた被害の記憶も戻す（V3-3 後の AI 評価: 前の遠征の累計が残って、体力を読み違えた）
      if (m.stats && m.stats.hp < m.stats.maxHp) {
        ctx.emit({ type: 'healed', target: m.id, targetKind: m.kind, amount: m.stats.maxHp - m.stats.hp, hpAfter: m.stats.maxHp, via: 'camp', resetSeen: true, seenBy: [], floor: key });
      }
      // 状態異常も消す（V3-3 後の AI 評価: 前の遠征の毒が残って、全快した大守護者を削っていた）
      m = ctx.world.entities[m.id];
      if (m.statuses?.length) ctx.emit({ type: 'status_ticked', target: m.id, statusesAfter: [], seenBy: [], floor: key });
    }
    // 体力が減っていないのに見た被害の記憶が残っている（ほかの者に回復された・傷跡まで全快した守護者）: 記憶だけ消す
    m = ctx.world.entities[m.id];
    if (m.stats && seenBySomeone(m.id)) {
      ctx.emit({ type: 'healed', target: m.id, targetKind: m.kind, amount: 0, hpAfter: m.stats.hp, via: 'camp', resetSeen: true, seenBy: [], floor: key });
    }
  }
  if (resume.length) {
    const opaque = isOpaqueFn(ctx, key);
    for (const at of resume) moveAwayFrom(ctx, f, key, at, opaque, rng);
  }
  ctx.curFloor = prevFloor;
}

/** 再開するマスが見える位置にいる敵を離す（V3-2R3a §22.1）。守護者は持ち場へ戻す（V3-2R3b §23.2。ふさがっていれば範囲の中の近い空きマス） */
function moveAwayFrom(ctx: Ctx, f: Floor, key: string, at: FloorPos, opaque: ReturnType<typeof isOpaqueFn>, rng: Rng): void {
  const minD = ctx.content.balance.teleport.minDistance;
  const mons = ctx.entitiesOn(key).filter((m) => m.actor?.ai && !m.player && m.pos && (m.stats?.hp ?? 0) > 0).sort((a, b) => a.sid - b.sid);
  for (const m0 of mons) {
    const m = ctx.world.entities[m0.id];
    if (m.home) {
      const home = m.home;
      if (m.pos!.x === home.x && m.pos!.y === home.y) continue;
      const leash = ctx.content.balance.guardian.leash;
      let to: Pos | undefined;
      for (let r = 0; r <= leash && !to; r++) {
        for (let y = home.y - r; y <= home.y + r && !to; y++) {
          for (let x = home.x - r; x <= home.x + r && !to; x++) {
            if (Math.max(Math.abs(x - home.x), Math.abs(y - home.y)) !== r || x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
            const tr = ctx.terrainAt(key, x, y);
            if (!tr.passable || tr.stairs || ctx.featureAt(key, x, y)?.trap) continue;
            const occ = ctx.actorAt(key, x, y);
            if (occ && occ.id !== m.id) continue;
            to = { x, y };
          }
        }
      }
      if (to && !(to.x === m.pos!.x && to.y === m.pos!.y)) {
        ctx.emit({ type: 'entity_moved', id: m.id, kind: m.kind, from: { x: m.pos!.x, y: m.pos!.y }, to: { ...to }, mode: 'teleport', seenBy: [], floor: key });
      }
      continue;
    }
    const sees = inCircle(m.pos!, at, m.stats?.sight ?? 7) && hasLos(m.pos!, at, opaque);
    if (!sees) continue;
    const sight = Math.max(m.stats?.sight ?? 7, 8);
    const free: Pos[] = [];
    const hidden: Pos[] = [];
    for (let y = 1; y < f.height - 1; y++) {
      for (let x = 1; x < f.width - 1; x++) {
        const tr = ctx.terrainAt(key, x, y);
        if (!tr.passable || tr.stairs || ctx.actorAt(key, x, y) || ctx.featureAt(key, x, y)?.trap) continue;
        free.push({ x, y });
        if (cheb(at, { x, y }) >= minD && !(inCircle({ x, y }, at, sight) && hasLos({ x, y }, at, opaque))) hidden.push({ x, y });
      }
    }
    let to: Pos | undefined;
    if (hidden.length) to = hidden[rng.int(hidden.length)];
    else if (free.length) to = [...free].sort((a, b) => cheb(at, b) - cheb(at, a) || a.y - b.y || a.x - b.x)[0];
    if (!to) continue;
    ctx.emit({ type: 'entity_moved', id: m.id, kind: m.kind, from: { x: m.pos!.x, y: m.pos!.y }, to: { ...to }, mode: 'teleport', seenBy: [], floor: key });
  }
}

/** キャンプのプレイヤーを前回 extract した地点へ戻す */
function returnFromCamp(ctx: Ctx, pid: PlayerId): void {
  const w = ctx.world;
  const pr = w.players[pid];
  const me = w.entities[pr.entityId];
  const fallback = w.floors['main:1'];
  const at = pr.extractPos && w.floors[pr.extractPos.floor] ? pr.extractPos : { floor: 'main:1', x: fallback.entry.x, y: fallback.entry.y };
  const f = w.floors[at.floor];
  const cell = findFreeCell(ctx, at.floor, { x: at.x, y: at.y });
  const body = structuredClone(me);
  body.pos = { floor: at.floor, x: cell.x, y: cell.y };
  const actor = { ...body.actor!, nextActAt: f.time };
  delete actor.dormant;
  body.actor = actor;
  ctx.curFloor = at.floor;
  ctx.now = f.time;
  ctx.emit({ type: 'player_state', player: pid, state: 'alive', reason: 'expedition_started', put: [body], seenBy: 'all', floor: at.floor });
}

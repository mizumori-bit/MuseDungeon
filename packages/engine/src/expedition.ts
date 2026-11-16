// 遠征（IMPROVEMENTS_V2 §2）: 候補の生成、開始、目的の進捗、extract、終了判定。
// 状態は全てイベント（expedition_* / objective_* / player_state）で変わる。
import type {
  ActionError, Entity, Expedition, ExpeditionEndReason, ExpeditionHaul, ExpeditionOffer, ExpeditionResult, HaulParts, Objective,
  ObjectiveProgress, ObjectiveType, OfferSlot, PlayerId, PlayerRecord,
} from '@muse/shared';
import { actionError, currentExpedition, deepestGenerated, haulTotal, isPursuing, offerPoints, overreachPoints, payoutOf, Rng, t } from '@muse/shared';
import { buildSummary } from './combat';
import type { Ctx } from './ctx';
import { findFreeCell } from './floors';
import { recomputeStats } from './stats';

const OFFER_TYPES: ObjectiveType[] = ['reach_depth', 'slay_guardian', 'retrieve_relic'];
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

/** 進行中の遠征の条件の効果（遠征が無ければ効果なし） */
export function activeEffects(ctx: Ctx): TraitEffects {
  return traitEffects(ctx, currentExpedition(ctx.world)?.traits);
}

/** 徘徊の湧き間隔の割合（条件と、目的達成後の圧力） */
export function wanderPct(ctx: Ctx): { pct: number; none: boolean } {
  const x = currentExpedition(ctx.world);
  const fx = activeEffects(ctx);
  let pct = fx.wanderIntervalPct;
  if (x && x.status === 'objective_complete' && (x.objective.type === 'slay_guardian' || x.objective.type === 'retrieve_relic')) {
    pct = Math.trunc((pct * ctx.content.balance.expedition.afterObjective.wanderIntervalPct) / 100);
  }
  return { pct: Math.max(1, pct), none: fx.noWander };
}

/** 遠征の共有の戦利品の内訳（宝は別に足す） */
export function sharedParts(ctx: Ctx, x: Expedition): HaulParts {
  const h: ExpeditionHaul = x.haul ?? { bounty: 0, discovery: 0, kills: 0 };
  return {
    objective: x.status === 'objective_complete' ? x.points : 0,
    overreach: overreachPoints(ctx.content.balance, x.objective.targetDepth, x.progress.maxDepth ?? 0),
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

/** 目標階の生成時に置くもの */
export interface ObjectivePlacement { guardian: boolean; relic: boolean }

/** 次の遠征の候補（シードと通番から決定的に作る。乱数状態は進めない） */
export function makeOffers(ctx: Ctx, no: number): ExpeditionOffer[] {
  const b = ctx.content.balance.expedition;
  const deepest = deepestGenerated(ctx.world);
  const rng = Rng.fromSeed(`${ctx.world.secret.seed}|expedition|${no}`);
  const traitIds = ctx.content.lists.expeditionTraits.map((x) => x.id);
  return SLOTS.map((slot, i) => {
    const s = b.slots[slot];
    // 最初の遠征は 地下(firstTargetDepth) を基本に、種類は 到達・守護者・遺物 の順（野心だけ 1 階深い）
    const type = no === 1 ? OFFER_TYPES[i] : OFFER_TYPES[rng.int(OFFER_TYPES.length)];
    const target = no === 1 ? Math.max(b.firstTargetDepth, deepest + 1) + (slot === 'ambitious' ? 1 : 0) : deepest + rng.range(s.aheadMin, s.aheadMax);
    const n = rng.range(s.traitsMin, s.traitsMax);
    const traits = rng.shuffle([...traitIds]).slice(0, n).sort();
    const multiplierPct = traits.reduce((m, id) => Math.trunc((m * ctx.content.expeditionTraits[id].multiplierPct) / 100), 100);
    const relicGuarded = type === 'retrieve_relic' && rng.chance(b.relicGuardianPct);
    const points = Math.trunc((offerPoints(ctx.content.balance, type, target, deepest) * s.pointsPct) / 100);
    return { index: i + 1, objective: { type, targetDepth: target }, points, relicGuarded, slot, traits, multiplierPct };
  });
}

export function offerExpeditions(ctx: Ctx): void {
  const no = (ctx.world.expeditions?.length ?? 0) + 1;
  ctx.emit({ type: 'expedition_offered', camp: { nextNo: no, offers: makeOffers(ctx, no) }, seenBy: 'all', floor: null });
}

/** 目標階の生成で置くもの（目標階でなければ null） */
export function placementFor(ctx: Ctx, branch: string, depth: number): ObjectivePlacement | null {
  const x = currentExpedition(ctx.world);
  if (!x || branch !== 'main' || x.objective.targetDepth !== depth) return null;
  if (x.objective.type === 'slay_guardian') return { guardian: true, relic: false };
  if (x.objective.type === 'retrieve_relic') return { guardian: x.relicGuarded, relic: true };
  return null;
}

/** ensureFloor から: 生成された守護者・遺物を遠征に記録する（俯瞰専用イベント） */
export function recordTargets(ctx: Ctx, spawned: Entity[]): void {
  const x = currentExpedition(ctx.world);
  if (!x) return;
  const g = spawned.find((e) => e.role === 'guardian');
  const r = spawned.find((e) => e.role === 'relic');
  if (!g && !r) return;
  const targets = { guardian: g?.id ?? x.targets.guardian, relic: r?.id ?? x.targets.relic };
  ctx.emit({ type: 'objective_progress', no: x.no, progressAfter: { ...x.progress }, statusAfter: x.status, targetsAfter: targets, seenBy: [], floor: null });
}

function present(pr: PlayerRecord | undefined): boolean {
  return !!pr && (pr.state === 'alive' || pr.state === 'at_camp');
}

/** 目的の進捗を World から計算する（イベントは出さない） */
export function computeProgress(ctx: Ctx, x: Expedition): ObjectiveProgress {
  const w = ctx.world;
  let reached = x.progress.reached;
  if (!reached && x.objective.targetDepth !== null) {
    for (const pid of w.playerOrder) {
      const pr = w.players[pid];
      if (pr.state !== 'alive') continue;
      const e = w.entities[pr.entityId];
      if (e?.pos && (w.floors[e.pos.floor]?.depth ?? 0) >= x.objective.targetDepth) reached = true;
    }
  }
  let maxDepth = x.progress.maxDepth ?? 0;
  for (const pid of x.participants) {
    const pr = w.players[pid];
    const e = pr?.state === 'alive' ? w.entities[pr.entityId] : undefined;
    if (e?.pos) maxDepth = Math.max(maxDepth, w.floors[e.pos.floor]?.depth ?? 0);
  }
  const guardianSlain = x.progress.guardianSlain || (x.targets.guardian !== null && !w.entities[x.targets.guardian]);
  let relicHeldBy: string | null = null;
  if (x.targets.relic) {
    const holder = w.entities[x.targets.relic]?.item?.heldBy;
    const he = holder ? w.entities[holder] : undefined;
    if (he?.player && present(w.players[he.player])) relicHeldBy = he.id;
  }
  return { reached, guardianSlain, relicHeldBy, maxDepth };
}

function statusFor(o: Objective, p: ObjectiveProgress): Expedition['status'] {
  switch (o.type) {
    case 'reach_depth': return p.reached ? 'objective_complete' : 'in_progress';
    case 'slay_guardian': return p.guardianSlain ? 'objective_complete' : 'in_progress';
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
    && (p.maxDepth ?? 0) === (x.progress.maxDepth ?? 0) && status === prev) return;
  ctx.emit({ type: 'objective_progress', no: x.no, progressAfter: p, statusAfter: status, seenBy: [], floor: null });
  if (status === 'objective_complete' && prev !== 'objective_complete') {
    ctx.emit({ type: 'objective_completed', no: x.no, objective: { ...x.objective }, seenBy: 'all', floor: null });
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
      gains.kills += h.perKill;
      if (ev.bounty) { gains.bounty += ev.bounty; reasons.push(`bounty:${ev.kind}`); }
      const pid = byEntity.get(ev.killer)!;
      const k = `${pid}|${ev.kind}`;
      const cur = killsNow.get(k);
      if (cur) cur.n++; else killsNow.set(k, { pid, kind: ev.kind, n: 1 });
    } else if (ev.type === 'item_identified' && x.participants.includes(ev.player)) {
      gains.discovery += h.discovery.identify;
      reasons.push(`identify:${ev.kind}`);
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

/** 自分の視界に追跡中（逃走中を除く）の敵がいるか（観測と同じ判定） */
export function huntingInView(ctx: Ctx, pr: PlayerRecord): boolean {
  const me = ctx.world.entities[pr.entityId];
  if (!me?.pos) return false;
  const key = me.pos.floor;
  const f = ctx.world.floors[key];
  const vis = ctx.visibleSet(pr.id);
  for (const e of ctx.entitiesOn(key)) {
    if (!e.actor || e.player || !e.pos || (e.stats?.hp ?? 0) <= 0) continue;
    if (!vis.has(e.pos.y * f.width + e.pos.x)) continue;
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

export function extractError(ctx: Ctx, e: Entity, pr: PlayerRecord, confirm: boolean | undefined): { error: ActionError } | { completed: boolean; expedition: Expedition } {
  const L = pr.locale;
  const x = currentExpedition(ctx.world);
  if (!x) return { error: actionError('cannot_extract', t(L, '進行中の遠征が無い。', 'There is no expedition in progress.'), t(L, 'キャンプなら start_expedition で次の遠征を始める。', 'At camp, start one with start_expedition.')) };
  const tr = ctx.terrainAt(e.pos!.floor, e.pos!.x, e.pos!.y);
  if (!tr.stairs) return { error: actionError('cannot_extract', t(L, '階段の上でないと extract できない。', 'You must stand on stairs to extract.'), t(L, 'travel_to stairs_up / stairs_down で階段へ移動する。', 'Move onto stairs with travel_to stairs_up / stairs_down.')) };
  if (huntingInView(ctx, pr)) return { error: actionError('cannot_extract', t(L, '追跡中の敵が見えている間は extract できない。', 'You cannot extract while a hunting enemy is in view.'), t(L, '敵を倒すか、視界から外れてから extract する。', 'Defeat it or break line of sight first.')) };
  const completed = wouldComplete(ctx, x, e);
  if (!completed && confirm !== true) {
    return { error: actionError('confirm_required', t(L, '目的は未達成。今 extract すると撤退（報酬なし）になる。', 'The objective is not complete; extracting now is a withdrawal (no reward).'), t(L, '撤退するなら confirm: true を付けて extract する。', 'To withdraw, call extract with confirm: true.')) };
  }
  return { completed, expedition: x };
}

/** extract の実行: 盤面から外してキャンプへ（全回復・状態異常解除） */
export function doExtract(ctx: Ctx, e: Entity, pr: PlayerRecord, completed: boolean, x: Expedition): void {
  const me = ctx.world.entities[e.id];
  const key = me.pos!.floor;
  ctx.curFloor = key;
  ctx.emit({ type: 'actor_scheduled', id: me.id, nextActAt: me.actor!.nextActAt + 100, turns: me.actor!.turns + 1, seenBy: [pr.id], floor: key });
  // 持ち帰った宝は換金する（所持品から外す）
  const cur0 = ctx.world.entities[e.id];
  const treasure = treasureHeld(ctx, cur0);
  const treasureIds = (cur0.inv?.items ?? []).filter((id) => ctx.content.items[ctx.world.entities[id]?.kind ?? '']?.category === 'treasure');
  ctx.emit({
    type: 'objective_progress', no: x.no, progressAfter: { ...x.progress }, statusAfter: x.status,
    extractedAfter: [...x.extracted, { player: pr.id, completed, treasure }], seenBy: [], floor: key,
  });
  const cur = ctx.world.entities[e.id];
  const extractPos = { floor: key, x: cur.pos!.x, y: cur.pos!.y };
  const body = structuredClone(cur);
  delete body.pos;
  if (treasureIds.length) body.inv = { ...body.inv!, items: body.inv!.items.filter((id) => !treasureIds.includes(id)) };
  body.actor = { ...body.actor!, dormant: true, regen: 0 };
  body.stats = { ...body.stats!, hp: body.stats!.maxHp };
  body.statuses = [];
  ctx.emit({ type: 'player_state', player: pr.id, state: 'at_camp', reason: completed ? 'extracted' : 'withdrew', extractPos, put: [body], ...(treasureIds.length ? { del: treasureIds } : {}), seenBy: 'all', floor: key });
  maybeEndExpedition(ctx);
}

/** 盤面に誰も残っていなければ遠征を終える（extract・死亡・引退の後に呼ぶ） */
export function maybeEndExpedition(ctx: Ctx): void {
  const w = ctx.world;
  const x = currentExpedition(w);
  if (!x) return;
  if (w.playerOrder.some((pid) => w.players[pid].state === 'alive')) return;
  let reason: ExpeditionEndReason;
  if (x.extracted.length) reason = x.extracted.some((r) => r.completed) ? 'completed' : 'withdrawn';
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
    const parts = { ...shared, treasure: r.treasure ?? 0 };
    partsTotal = { ...partsTotal, treasure: partsTotal.treasure + parts.treasure };
    const banked = payoutOf(ctx.content.balance, parts, r.completed, mult);
    players.push({ player: pr.id, banked, lost: 0 });
    const done = r.completed && reason === 'completed';
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
  if (currentExpedition(w)) return actionError('bad_request', t(L, '遠征は既に進行中。', 'An expedition is already in progress.'), t(L, '行動ツールで遠征を続ける。', 'Continue with action tools.'));
  if (pr.state !== 'at_camp' && pr.state !== 'alive') return actionError('dead', t(L, 'あなたは既にランから外れている。', 'You are no longer in the run.'), '');
  const camp = w.camp;
  if (!camp) return actionError('not_at_camp', t(L, '遠征の候補が無い。', 'There are no expedition offers.'), t(L, '仲間の遠征が終わるのを待つ。', 'Wait for your allies to finish.'));
  let objective: Objective;
  let points = 0;
  let relicGuarded = false;
  let slot: OfferSlot | undefined;
  let traits: string[] = [];
  let multiplierPct = 100;
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
  }
  const participants: PlayerId[] = w.playerOrder.filter((pid) => present(w.players[pid]));
  const start: Expedition['start'] = {};
  for (const pid of participants) {
    const p = w.players[pid];
    start[pid] = { kills: p.stats.kills, turns: w.entities[p.entityId]?.actor?.turns ?? 0, deepest: p.stats.deepest };
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
    participants, start, targets: { guardian: null, relic: null }, progress: { reached: false, guardianSlain: false, relicHeldBy: null, maxDepth: startDepth },
    extracted: [], result: null,
    ...(slot ? { slot } : {}), traits, multiplierPct, haul: { bounty: 0, discovery: 0, kills: 0 },
  };
  ctx.emit({ type: 'expedition_started', expedition: exp, seenBy: 'all', floor: null });
  for (const pid of participants) if (w.players[pid].state === 'at_camp') returnFromCamp(ctx, pid);
  // 条件（視界など）を能力値に反映
  for (const pid of participants) {
    const e = w.entities[w.players[pid].entityId];
    if (e?.pos) recomputeStats(ctx, e, 'expedition');
  }
  return null;
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

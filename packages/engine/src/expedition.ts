// 遠征（IMPROVEMENTS_V2 §2）: 候補の生成、開始、目的の進捗、extract、終了判定。
// 状態は全てイベント（expedition_* / objective_* / player_state）で変わる。
import type {
  ActionError, Entity, Expedition, ExpeditionEndReason, ExpeditionOffer, ExpeditionResult, Objective, ObjectiveProgress,
  ObjectiveType, PlayerId, PlayerRecord,
} from '@muse/shared';
import { actionError, currentExpedition, deepestGenerated, isPursuing, offerPoints, Rng, t } from '@muse/shared';
import { buildSummary } from './combat';
import type { Ctx } from './ctx';
import { findFreeCell } from './floors';

const OFFER_TYPES: ObjectiveType[] = ['reach_depth', 'slay_guardian', 'retrieve_relic'];

/** 目標階の生成時に置くもの */
export interface ObjectivePlacement { guardian: boolean; relic: boolean }

/** 次の遠征の候補（シードと通番から決定的に作る。乱数状態は進めない） */
export function makeOffers(ctx: Ctx, no: number): ExpeditionOffer[] {
  const b = ctx.content.balance.expedition;
  const deepest = deepestGenerated(ctx.world);
  const rng = Rng.fromSeed(`${ctx.world.secret.seed}|expedition|${no}`);
  const types = no === 1 ? [...OFFER_TYPES] : rng.shuffle([...OFFER_TYPES]);
  return types.map((type, i) => {
    const target = no === 1 ? Math.max(b.firstTargetDepth, deepest + 1) : deepest + rng.range(b.aheadMin, b.aheadMax);
    const relicGuarded = type === 'retrieve_relic' && rng.chance(b.relicGuardianPct);
    return { index: i + 1, objective: { type, targetDepth: target }, points: offerPoints(ctx.content.balance, type, target, deepest), relicGuarded };
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
  const guardianSlain = x.progress.guardianSlain || (x.targets.guardian !== null && !w.entities[x.targets.guardian]);
  let relicHeldBy: string | null = null;
  if (x.targets.relic) {
    const holder = w.entities[x.targets.relic]?.item?.heldBy;
    const he = holder ? w.entities[holder] : undefined;
    if (he?.player && present(w.players[he.player])) relicHeldBy = he.id;
  }
  return { reached, guardianSlain, relicHeldBy };
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
  if (p.reached === x.progress.reached && p.guardianSlain === x.progress.guardianSlain && p.relicHeldBy === x.progress.relicHeldBy && status === prev) return;
  ctx.emit({ type: 'objective_progress', no: x.no, progressAfter: p, statusAfter: status, seenBy: [], floor: null });
  if (status === 'objective_complete' && prev !== 'objective_complete') {
    ctx.emit({ type: 'objective_completed', no: x.no, objective: { ...x.objective }, seenBy: 'all', floor: null });
  }
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
  ctx.emit({
    type: 'objective_progress', no: x.no, progressAfter: { ...x.progress }, statusAfter: x.status,
    extractedAfter: [...x.extracted, { player: pr.id, completed }], seenBy: [], floor: key,
  });
  const cur = ctx.world.entities[e.id];
  const extractPos = { floor: key, x: cur.pos!.x, y: cur.pos!.y };
  const body = structuredClone(cur);
  delete body.pos;
  body.actor = { ...body.actor!, dormant: true, regen: 0 };
  body.stats = { ...body.stats!, hp: body.stats!.maxHp };
  body.statuses = [];
  ctx.emit({ type: 'player_state', player: pr.id, state: 'at_camp', reason: completed ? 'extracted' : 'withdrew', extractPos, put: [body], seenBy: 'all', floor: key });
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
  const result: ExpeditionResult = { reason, points, deepest, kills, turns };
  if (reason === 'completed') {
    for (const r of x.extracted) {
      const pr = w.players[r.player];
      if (!pr || pr.state !== 'at_camp') continue;
      ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...pr.stats, expeditions: (pr.stats.expeditions ?? 0) + 1, expeditionPoints: (pr.stats.expeditionPoints ?? 0) + points }, seenBy: [pr.id], floor: null });
    }
  }
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
  if (offer === 'endless') objective = { type: 'endless', targetDepth: null };
  else {
    const o = camp.offers.find((c) => c.index === offer);
    if (!o) return actionError('bad_request', t(L, `候補 ${offer} は無い。`, `There is no offer ${offer}.`), t(L, `offer は 1〜${camp.offers.length} か "endless"。`, `offer is 1-${camp.offers.length} or "endless".`));
    objective = { ...o.objective };
    points = o.points;
    relicGuarded = o.relicGuarded;
  }
  const participants: PlayerId[] = w.playerOrder.filter((pid) => present(w.players[pid]));
  const start: Expedition['start'] = {};
  for (const pid of participants) {
    const p = w.players[pid];
    start[pid] = { kills: p.stats.kills, turns: w.entities[p.entityId]?.actor?.turns ?? 0, deepest: p.stats.deepest };
  }
  const exp: Expedition = {
    no: camp.nextNo, objective, points, relicGuarded, status: 'in_progress', startSeq: w.seq + 1, endSeq: null, endReason: null,
    participants, start, targets: { guardian: null, relic: null }, progress: { reached: false, guardianSlain: false, relicHeldBy: null },
    extracted: [], result: null,
  };
  ctx.emit({ type: 'expedition_started', expedition: exp, seenBy: 'all', floor: null });
  for (const pid of participants) if (w.players[pid].state === 'at_camp') returnFromCamp(ctx, pid);
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

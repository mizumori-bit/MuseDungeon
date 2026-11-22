// 野営の火（S1。SEASON.md §8・PROTOCOL.md §9.10）: 置く・使う・共有層の火を世界に置く。
// 火は世界ごとのエンティティ（地物 core:camp_fire、campfire.by）。地物の判定（ctx.featureAt）には入らないので、
// ほかの世界でその世界だけの地物・罠・立てない地形と重なっても、それらは今までどおり働き、火は同じマスにあって隣か上から使える。
import type { ActionError, Entity, Expedition, FloorKey, PlayerRecord } from '@muse/shared';
import { actionError, cheb, currentExpedition, isMilestoneOf, restCapHp, seasonBudgetLeft, t } from '@muse/shared';
import { heal } from './combat';
import type { Ctx } from './ctx';
import { doExtract, huntingFoeInView, huntingInView, wouldComplete } from './expedition';
import { makeFeature } from './spawn';
import { addStatus, removeStatus } from './statuses';
import { milestoneRule } from './warden';

export const CAMPFIRE_KIND = 'core:camp_fire';
/** 火からの帰り支度（S1c §14.3 の 1）。その間は行動できず、切れたら帰還・撤退する。追ってくる敵が見えたら取りやめ */
export const FIRE_RETURN = 'core:fire_return';

/** 足元か隣の野営の火（S1c §14.3 の 1: 火の上か隣から帰還できる）。火どうしは 5 マスより離れているので、あっても 1 つ */
export function campfireNear(ctx: Ctx, e: Entity): Entity | undefined {
  const p = e.pos;
  if (!p || !ctx.world.season) return undefined;
  return ctx.entitiesOn(p.floor).filter((x) => x.campfire && x.pos && cheb(x.pos, p) <= 1).sort((a, b) => cheb(a.pos!, p) - cheb(b.pos!, p) || a.sid - b.sid)[0];
}

/**
 * 火から帰れるか（S1c §14.3 の 1。階段の上でないとき）。追ってくる敵が見えている（休憩と同じ判定）・帰り支度の手番に予算が足りないなら断る。
 * 確定の決まり（達成・confirm）は階段と同じで、extractError が見る
 */
export function fireReturnCheck(ctx: Ctx, e: Entity, pr: PlayerRecord, fire: Entity): ActionError | null {
  const L = pr.locale;
  const n = ctx.content.balance.season.fireReturnTurns;
  if (huntingInView(ctx, pr, true)) {
    return actionError('hostile_in_view', t(L, `追ってくる敵が見えている間は、野営の火から帰れない（帰り支度に ${n} 手番かかる）。階段の上なら、追われていても帰れる。`, `You cannot return from a campfire while a hunting enemy is in view (packing up takes ${n} turns). From stairs you can return even while chased.`), t(L, '敵を片付けるか、離れてから。急ぐなら階段か帰還の綱。', 'Deal with the enemy or get away first. In a hurry, use stairs or the lifeline.'));
  }
  const left = seasonBudgetLeft(ctx.world, pr.id);
  if (left !== null && left < n) {
    return actionError('cannot_extract', t(L, `予算の残り（${left} 手番）が、火からの帰り支度の ${n} 手番に足りない。`, `Your budget left (${left} turns) is less than the ${n} turns packing up at a campfire takes.`), t(L, '階段の上で extract するか、帰還の綱で帰る。', 'Extract on stairs, or use the lifeline.'));
  }
  void fire;
  return null;
}

/**
 * 火から帰り始める（extract の手番が 1 つ目）。残りの手番は帰り支度の状態（行動できない）で過ごし、切れたら帰還・撤退する（confirm を覚える）。
 * 手番が 1 なら、その場で帰る
 */
export function startFireReturn(ctx: Ctx, e: Entity, pr: PlayerRecord, fire: Entity, confirm: boolean, x: Expedition): { cost: number; scheduled?: boolean } {
  const n = ctx.content.balance.season.fireReturnTurns;
  const f = ctx.world.floors[fire.pos!.floor];
  const at = { depth: f.depth, x: fire.pos!.x, y: fire.pos!.y, by: fire.campfire!.by };
  if (n <= 1) {
    finishFireReturn(ctx, ctx.world.entities[e.id], pr, fire, x);
    return { cost: 0, scheduled: true };
  }
  ctx.emit({ type: 'fire_return', player: pr.id, phase: 'start', ...at, turns: n, seenBy: [pr.id], floor: fire.pos!.floor });
  addStatus(ctx, ctx.world.entities[e.id], FIRE_RETURN, n - 1, confirm ? 1 : 0);
  return { cost: 100 };
}

/** 帰り支度が済んだ: その火から帰還・撤退する（確定は階段と同じ。綱ではない）。次の遠征は、いるマス（火の上か隣）から */
function finishFireReturn(ctx: Ctx, e: Entity, pr: PlayerRecord, fire: Entity, x: Expedition): void {
  const f = ctx.world.floors[fire.pos!.floor];
  const completed = wouldComplete(ctx, x, e);
  ctx.emit({ type: 'fire_return', player: pr.id, phase: 'done', depth: f.depth, x: fire.pos!.x, y: fire.pos!.y, by: fire.campfire!.by, completed, seenBy: [pr.id], floor: fire.pos!.floor });
  doExtract(ctx, ctx.world.entities[e.id], pr, completed, x);
}

/** 帰り支度の間に被害を受けた（S1d §17.3。見えない相手に撃たれた場合も・毒も）: 取りやめ。combat の applyDamage が呼ぶ */
export function fireReturnHurt(ctx: Ctx, e: Entity, dealt = 0, source: Entity | null = null): void {
  const cur = ctx.world.entities[e.id];
  const pr = cur?.player ? ctx.world.players[cur.player] : undefined;
  if (!cur?.pos || !pr || !(cur.statuses ?? []).some((s) => s.id === FIRE_RETURN)) return;
  // 被害と、その相手の種族（見えている相手だけ。見えない相手・毒なら null。S3a §27.6 の 4）
  const sourceKind = source && source.id !== cur.id && source.pos && ctx.seesActor(pr.id, source) ? source.kind : null;
  cancelFireReturn(ctx, cur, pr, 'damaged', campfireNear(ctx, cur), { dealt, sourceKind });
}

function cancelFireReturn(ctx: Ctx, e: Entity, pr: PlayerRecord, reason: 'hostile' | 'moved' | 'not_complete' | 'damaged', fire: Entity | undefined, extra: { foe?: Entity | null; dealt?: number; sourceKind?: string | null } = {}): void {
  removeStatus(ctx, e, FIRE_RETURN);
  const f = e.pos ? ctx.world.floors[e.pos.floor] : undefined;
  ctx.emit({
    type: 'fire_return', player: pr.id, phase: 'cancel', reason,
    depth: f?.depth ?? 0, x: fire?.pos?.x ?? -1, y: fire?.pos?.y ?? -1, by: fire?.campfire?.by ?? '',
    ...(extra.foe?.pos ? { foe: { id: extra.foe.id, kind: extra.foe.kind, pos: { x: extra.foe.pos.x, y: extra.foe.pos.y } } } : {}),
    ...(reason === 'damaged' ? { dealt: extra.dealt ?? 0, sourceKind: extra.sourceKind ?? null } : {}),
    seenBy: [pr.id], floor: e.pos?.floor ?? null,
  });
}

/**
 * 帰り支度（S1c §14.3 の 1）の手番の始め: 追ってくる敵が見えた（休憩と同じ判定）・火から離された、なら取りやめ（過ごした手番は戻らない）。
 * 状態のハンドラ（statuses.ts の fire_return）が呼ぶ
 */
export function fireReturnTick(ctx: Ctx, e0: Entity): void {
  const e = ctx.world.entities[e0.id] ?? e0;
  const pr = e.player ? ctx.world.players[e.player] : undefined;
  // 同じ手番の毒などの被害で、もう取りやめになっている（S1d §17.3）
  if (!pr || !e.pos || !(e.statuses ?? []).some((s) => s.id === FIRE_RETURN)) return;
  const fire = campfireNear(ctx, e);
  if (!fire) { cancelFireReturn(ctx, e, pr, 'moved', undefined); return; }
  const foe = huntingFoeInView(ctx, pr, true);
  if (foe) cancelFireReturn(ctx, e, pr, 'hostile', fire, { foe });
}

/** 帰り支度が切れた: 帰る。目的を達成していないのに confirm が無かった（始めたときは達成していた）なら、帰らずに取りやめ */
export function fireReturnExpire(ctx: Ctx, e: Entity, power: number): void {
  const pr = e.player ? ctx.world.players[e.player] : undefined;
  const x = currentExpedition(ctx.world);
  if (!pr || pr.state !== 'alive' || !x || !e.pos) return;
  const fire = campfireNear(ctx, e);
  if (!fire) { cancelFireReturn(ctx, e, pr, 'moved', undefined); return; }
  if (!wouldComplete(ctx, x, e) && power !== 1) { cancelFireReturn(ctx, e, pr, 'not_complete', fire); return; }
  finishFireReturn(ctx, e, pr, fire, x);
}

const sameCell = (a: { depth: number; x: number; y: number }, b: { depth: number; x: number; y: number }) => a.depth === b.depth && a.x === b.x && a.y === b.y;

function spawnCampfire(ctx: Ctx, key: FloorKey, x: number, y: number, by: string, reason: 'fire_placed' | 'season_fire'): Entity {
  const id = ctx.newEntityId();
  const e = makeFeature(ctx, key, CAMPFIRE_KIND, x, y, id, ctx.nextSid());
  e.campfire = { by };
  const seen = ctx.perceive(key, [{ field: 'entity', pos: e.pos, actor: false }]);
  ctx.emit({ type: 'entity_spawned', entity: e, reason, floor: key, seenBy: seen.seenBy });
  return ctx.world.entities[id];
}

/**
 * 共有層の火（取り込んだ SeasonState.fires）を、その階に置く。取り込みのとき（作ってある階のすべて）と、階を作ったとき（生成の後）に呼ぶ。
 * どの世界でも同じマスに置く（品・敵・その世界だけの地物・立てない地形があっても）。そのマスに火がもうあれば置かない（自分が置いた火）。
 * 生成の乱数は使わない（入口と階段はシードと版だけで決まる。§2.3）
 */
export function placeSeasonFires(ctx: Ctx, key: FloorKey): void {
  const fires = ctx.world.season?.fires;
  const f = ctx.world.floors[key];
  if (!fires?.length || !f || f.branch !== 'main') return;
  for (const fire of fires) {
    if (fire.depth !== f.depth || fire.x < 0 || fire.y < 0 || fire.x >= f.width || fire.y >= f.height) continue;
    if (ctx.campfireAt(key, fire.x, fire.y)) continue;
    spawnCampfire(ctx, key, fire.x, fire.y, fire.by, 'season_fire');
  }
}

/**
 * 自分の火（取り込んだ自分の火（取り合いで載らなかった火も）と、このランで置いた火）。シーズンを通して数える。
 * このランで置いた火は、同じマスにほかの者の火が載っていても、いつも自分の火（S1a §10.1 の 5）
 */
export function myFires(ctx: Ctx): { depth: number; x: number; y: number }[] {
  const s = ctx.world.season;
  if (!s) return [];
  const mine = (s.fires ?? []).filter((x) => x.mine).map((x) => ({ depth: x.depth, x: x.x, y: x.y }));
  for (const p of s.placed ?? []) if (!mine.some((x) => sameCell(x, p))) mine.push({ ...p });
  return mine;
}

/** 置けるか（§8.2）。置けるなら費用。断るときは理由と足りないもの（手番を使わない） */
export function placeFireCheck(ctx: Ctx, e: Entity, pr: PlayerRecord): { cost: number } | { error: ActionError } {
  const L = pr.locale;
  const no = (msg: string, en: string, hint: string, hintEn: string, code: 'cannot_use' | 'hostile_in_view' | 'bad_request' = 'cannot_use') => ({ error: actionError(code, t(L, msg, en), t(L, hint, hintEn)) });
  const s = ctx.world.season;
  if (!ctx.world.meta.season || !s) return no('野営の火を置けるのは、シーズンのランだけ。', 'Campfires exist only in season runs.', '', '', 'bad_request');
  const key = e.pos!.floor;
  const f = ctx.world.floors[key];
  const p = e.pos!;
  const r = ctx.content.balance.season;
  if (f.branch !== 'main' || isMilestoneOf(milestoneRule(ctx.content), f.depth)) {
    return no(`大守護者の間の階（${milestoneRule(ctx.content)?.every ?? 5} の倍数の深さ）には置けない。`, `You cannot set a campfire on a warden floor (every ${milestoneRule(ctx.content)?.every ?? 5} depths).`, 'ほかの階で置く。', 'Set it on another floor.');
  }
  const tr = ctx.terrainAt(key, p.x, p.y);
  if (tr.stairs || tr.door || tr.tags.includes('grate')) return no('階段・扉・格子扉の上には置けない。', 'You cannot set a campfire on stairs, a door or a grate.', '一歩離れてから置く。', 'Step off it first.');
  if (ctx.featureAt(key, p.x, p.y)) return no('ほかの地物か罠のあるマスには置けない。', 'You cannot set a campfire where another feature or a trap is.', '一歩離れてから置く。', 'Step aside first.');
  const near = ctx.entitiesOn(key).filter((x) => x.campfire && x.pos && cheb(x.pos, p) <= r.fireSpacing).sort((a, b) => cheb(a.pos!, p) - cheb(b.pos!, p))[0];
  if (near) return no(`ほかの野営の火（${near.campfire!.by} の火・(${near.pos!.x},${near.pos!.y})）から ${r.fireSpacing} マス以内には置けない。`, `You cannot set a campfire within ${r.fireSpacing} cells of another one (${near.campfire!.by}'s at (${near.pos!.x},${near.pos!.y})).`, `${r.fireSpacing + 1} マス以上離れてから置く。`, `Move at least ${r.fireSpacing + 1} cells away.`);
  // 休憩と同じ判定（隣にいない動かない敵は数えない。観測の place_fire の行と同じ。S1a §10.1 の 3）
  if (huntingInView(ctx, pr, true)) return no('追ってくる敵が見えている間は、火を置けない。', 'You cannot set a campfire while a hunting enemy is in view.', '敵を片付けるか、離れてから。', 'Deal with the enemy or get away first.', 'hostile_in_view');
  const mine = myFires(ctx);
  if (mine.some((x) => x.depth === f.depth)) return no('この階には、もうあなたの火がある（1 つの階に 1 人 1 つまで）。', 'You already have a campfire on this floor (one per person per floor).', 'ほかの階で置く。', 'Set it on another floor.');
  if (mine.length >= r.firesPerSeason) return no(`シーズンを通して置ける火は ${r.firesPerSeason} つまで（もう ${mine.length} つ置いた）。`, `You can set at most ${r.firesPerSeason} campfires in the season (you have set ${mine.length}).`, '置いた火は、動かせないし消せない。', 'Campfires cannot be moved or removed.');
  const cost = f.depth * r.fireCostPerDepth;
  const banked = pr.stats.banked ?? 0;
  if (banked < cost) return no(`確定した点が足りない（費用 ${cost} 点 = 深さ ${f.depth} × ${r.fireCostPerDepth}、このランの確定点 ${banked} 点）。`, `Not enough banked points (cost ${cost} = depth ${f.depth} x ${r.fireCostPerDepth}; this run has banked ${banked}).`, '遠征を達成して点を確定させてから。浅い階ほど安い。', 'Bank points by completing expeditions first. Shallower floors cost less.');
  return { cost };
}

/** 置く（1 手番）: 自分の世界に火を置き、確定点から費用を払い、このランで置いた火に足す。共有層へ載るのはキャンプに着いたとき（サーバー） */
export function placeFire(ctx: Ctx, e: Entity, pr: PlayerRecord, cost: number): void {
  const key = e.pos!.floor;
  const f = ctx.world.floors[key];
  const p = { x: e.pos!.x, y: e.pos!.y };
  spawnCampfire(ctx, key, p.x, p.y, ctx.world.season?.self ?? pr.name, 'fire_placed');
  const cur = ctx.world.players[pr.id];
  ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...cur.stats, banked: (cur.stats.banked ?? 0) - cost }, seenBy: [pr.id], floor: key });
  const placedAfter = [...(ctx.world.season?.placed ?? []), { depth: f.depth, x: p.x, y: p.y }];
  ctx.emit({ type: 'fire_placed', player: pr.id, depth: f.depth, x: p.x, y: p.y, cost, placedAfter, seenBy: [pr.id], floor: key });
}

/** 火を今使えるか（§8.1・§8.3）。使えるなら戻る HP、使えないなら理由（手番を使わない） */
export function campfireCheck(ctx: Ctx, e: Entity, pr: PlayerRecord, fire: Entity): { amount: number } | { error: ActionError } {
  const L = pr.locale;
  const f = ctx.world.floors[fire.pos!.floor];
  const no = currentExpedition(ctx.world)?.no ?? 0;
  if ((ctx.world.season?.fireUses ?? []).some((u) => u.no === no && u.depth === f.depth)) {
    return { error: actionError('cannot_use', t(L, 'この遠征では、この階の野営の火をもう使った（1 回の遠征で、1 つの階につき 1 回）。', 'You have already used a campfire on this floor this expedition (once per floor per expedition).'), t(L, '次の階の火か、次の遠征で。', 'Use one on another floor, or next expedition.')) };
  }
  if (huntingInView(ctx, pr, true)) return { error: actionError('hostile_in_view', t(L, '追ってくる敵が見えている間は、火で休めない（休憩と同じ）。', 'You cannot rest at a campfire while a hunting enemy is in view (as with rest).'), t(L, '敵を片付けるか、離れてから。', 'Deal with the enemy or get away first.')) };
  const cap = restCapHp({ restCapPct: ctx.content.balance.rest.capPct }, e.stats!.maxHp);
  if (e.stats!.hp >= cap) return { error: actionError('cannot_use', t(L, `HP はもう休憩の上限（${cap}）以上。火で戻る分は無い。`, `Your HP is already at the rest cap (${cap}); the campfire would not heal you.`), t(L, '傷を負ってから使う。', 'Use it once you are hurt.')) };
  return { amount: cap - e.stats!.hp };
}

/** 使う（1 手番）: HP を休憩の上限まで戻し、この遠征でこの階の火を使ったことを残す */
export function useCampfire(ctx: Ctx, e: Entity, pr: PlayerRecord, fire: Entity, amount: number): void {
  const f = ctx.world.floors[fire.pos!.floor];
  const no = currentExpedition(ctx.world)?.no ?? 0;
  heal(ctx, e, amount, 'fire');
  const usesAfter = [...(ctx.world.season?.fireUses ?? []), { no, depth: f.depth, x: fire.pos!.x, y: fire.pos!.y }];
  ctx.emit({ type: 'fire_used', player: pr.id, depth: f.depth, x: fire.pos!.x, y: fire.pos!.y, by: fire.campfire!.by, amount, maxHp: ctx.world.entities[e.id].stats!.maxHp, usesAfter, seenBy: [pr.id], floor: fire.pos!.floor });
}

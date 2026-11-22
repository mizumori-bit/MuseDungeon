// 危険の見積もり（V3-2R3 §20.4）: 速さの比と思い出の記録から、1 手番あたりの最悪の被害を出す。観測とマクロで共用。
// 入力は PlayerView と公開カタログだけ（伏せた能力値は使わない）。
import type { Catalog } from './catalog';
import { memoryKey } from './catalog';
import type { MonsterMemory } from './types';
import { ceilDiv, floorDiv } from './util';
import type { EntityView, PlayerView } from './view';

/** 自分の実効の速さ（状態異常の倍率込み） */
export function selfSpeed(view: PlayerView, catalog: Catalog): number {
  let sp = view.self.speed;
  for (const st of view.self.statuses) {
    const pct = catalog.statuses[st.id]?.speedPct;
    if (pct !== undefined) sp = floorDiv(sp * pct, 100);
  }
  return Math.max(10, sp);
}

/** 敵の実効の速さ（状態異常の倍率込み）。分からなければ null */
export function monsterSpeedOf(catalog: Catalog, e: Pick<EntityView, 'speed' | 'statuses'>): number | null {
  if (e.speed === undefined) return null;
  let sp = e.speed;
  for (const st of e.statuses ?? []) {
    const pct = catalog.statuses[st]?.speedPct;
    if (pct !== undefined) sp = floorDiv(sp * pct, 100);
  }
  return Math.max(10, sp);
}

/** その個体の思い出（守護者は守護者の記録） */
export function memoryOf(view: PlayerView, e: Pick<EntityView, 'kind' | 'role'>): MonsterMemory | undefined {
  return e.kind ? view.monsterMemory[memoryKey(e.kind, e.role)] : undefined;
}

/**
 * 自分の 1 手番のあいだにその相手が行動する回数（速さの比の切り上げ。自分より速ければ 2 回）。
 * 2 回動いたのを見た敵は、次に 2 回動けるまでの手番を 1 回と数える（V3-8 §53.4）: 1 回の行動の時間 c = 10000 ÷ 敵の速さ、
 * 自分の P = 10000 ÷ 自分の速さ（どちらも切り捨て）。2 回動いた手番の後の 切り捨て((2c − P) ÷ (P − c)) 手番は 1 回（速さ 120 と 100 なら 3）
 */
export function attacksPerTurn(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'speed' | 'statuses' | 'paceAgo'>): number {
  const sp = monsterSpeedOf(catalog, e);
  if (sp === null) return 1;
  const self = selfSpeed(view, catalog);
  const n = Math.max(1, ceilDiv(sp, self));
  if (n === 2 && e.paceAgo !== undefined) {
    const c = floorDiv(10000, sp), P = floorDiv(10000, self);
    if (P > c && 2 * c > P && e.paceAgo < floorDiv(2 * c - P, P - c)) return 1;
  }
  return n;
}

/** 歩く手番のコスト（重い鎧。装備中の品の最大。100 が普通） */
export function selfMoveCost(view: PlayerView, catalog: Catalog): number {
  let cost = 100;
  for (const it of view.inventory) {
    if (!it.equipped || !it.kind) continue;
    const mc = catalog.items[it.kind]?.equipStats?.moveCost;
    if (mc !== undefined && mc > cost) cost = mc;
  }
  return cost;
}

/**
 * 階段まで歩く間にその相手が攻撃できる回数（V3-4b §28.5）。射撃する敵は歩数（射程と視線は続くと見る）。
 * 近接の敵は 切り上げ(歩数 × max(0, 敵の速さ ÷ 自分の歩く速さ − 1)) で、今隣にいれば +1。自分の歩く速さは重い鎧の手番コストを入れる
 */
export function chaseAttacks(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'speed' | 'statuses'>, steps: number, o: { ranged: boolean; adjacent: boolean }): number {
  if (o.ranged) return steps;
  const sp = monsterSpeedOf(catalog, e) ?? 100;
  // 敵の速さ ÷ 自分の歩く速さ − 1 = (sp × moveCost − self × 100) ÷ (self × 100)（整数で切り上げ）
  const self = selfSpeed(view, catalog);
  const num = sp * selfMoveCost(view, catalog) - self * 100;
  return (num > 0 ? ceilDiv(steps * num, self * 100) : 0) + (o.adjacent ? 1 : 0);
}

/** 1 手番あたりの最悪の被害 = 受けた最大の一撃 × 行動の回数（記録が無ければ null） */
export function worstTurnOf(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses' | 'paceAgo'>): number | null {
  const mem = memoryOf(view, e);
  if (!mem || mem.maxDamageToYou <= 0) return null;
  return mem.maxDamageToYou * attacksPerTurn(view, catalog, e);
}

/**
 * 1 回の攻撃の平均の被害（S1c §14.4 の 1）= 攻撃で受けた被害の合計 ÷ 攻撃された回数（外れは 0 に数える。装甲を引いた後）を、times 回分。
 * 整数で切り上げる（重い側）。記録が無ければ null（攻撃された回数か被害の合計が無い: S1c より前の記録・継承した記録）
 */
export function avgHitsOf(view: PlayerView, e: Pick<EntityView, 'kind' | 'role'>, times: number): number | null {
  const d = memoryOf(view, e)?.dmgOnYou;
  // 分母は、被害の合計と同じ時から数えた攻撃された回数（S1d §17.2: 前の版から数えた hitsOnYou で割ると軽く出た）
  if (!d || d.length < 3 || d[2] <= 0) return null;
  return ceilDiv(d[0] * times, d[2]);
}

/** 1 手番あたりの「ふつうの」最大の被害（S1d §17.2）= 会心でない最大の一撃 × 行動の回数。会心でない記録が無ければ、最大の一撃（会心を含む）で */
export function plainTurnOf(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses' | 'paceAgo'>): number | null {
  const mem = memoryOf(view, e);
  if (!mem || mem.maxDamageToYou <= 0) return null;
  const hit = mem.maxPlainToYou && mem.maxPlainToYou > 0 ? mem.maxPlainToYou : mem.maxDamageToYou;
  return hit * attacksPerTurn(view, catalog, e);
}

/** 1 手番あたりの平均の被害（avgHitsOf × 行動の回数）。記録が無ければ null */
export function avgTurnOf(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses' | 'paceAgo'>): number | null {
  return avgHitsOf(view, e, attacksPerTurn(view, catalog, e));
}

/**
 * fight の止まり方の見積もり（S1c §14.4 の 1・S1d §17.2）: 次の手番の被害の見込み expected と、最悪 worst（全員が記録の最大の一撃。会心を含む）。
 * expected = いちばん重い 1 体（1 手の「ふつうの」最大が最大の者）は会心でない最大の一撃、残りは 1 手の平均（平均の記録が無ければ、ふつうの最大。重い側）の合計。
 * fight は、HP が worst 以下なら止まり（死にうる）、HP − expected が hp_floor を下回れば止まる。
 * 被弾の記録の無い敵は、どちらにも数えない（今までどおり。fight は記録の無い種族で別に止まる）。unrecorded はその数
 */
export function threatEstimate(view: PlayerView, catalog: Catalog, threats: readonly Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses' | 'paceAgo'>[]): { expected: number; worst: number; unrecorded: number } {
  const per = threats.map((h) => ({ w: worstTurnOf(view, catalog, h), p: plainTurnOf(view, catalog, h), a: avgTurnOf(view, catalog, h) }));
  const known = per.filter((x): x is { w: number; p: number; a: number | null } => x.w !== null && x.p !== null).sort((a, b) => b.p - a.p);
  const worst = known.reduce((s, x) => s + x.w, 0);
  const expected = known.length ? known[0].p + known.slice(1).reduce((s, x) => s + Math.min(x.p, x.a ?? x.p), 0) : 0;
  return { expected, worst, unrecorded: per.length - known.length };
}

/** fight が止まる理由（S1d §17.2）: lethal＝今の HP が最悪以下（死にうる。hp_floor によらない）、floor＝HP − 見込みが hp_floor を下回る。止まらなければ null */
export function fightRiskStop(hp: number, hpFloor: number, est: { expected: number; worst: number }): 'lethal' | 'floor' | null {
  if (est.worst > 0 && hp <= est.worst) return 'lethal';
  if (est.expected > 0 && hp - est.expected < hpFloor) return 'floor';
  return null;
}

/** fight の脅威（hp_risk の判定に入れる敵。マクロ・観測・pilot が同じものを使う）: 追跡中で逃げていない敵の、隣か射撃する種族と、隣の逃走中の追跡者 */
export function fightThreats<T extends Pick<EntityView, 'cat' | 'kind' | 'awareness' | 'fleeing' | 'pos'>>(catalog: Catalog, hostiles: readonly T[], pos: { x: number; y: number }): T[] {
  const near = (h: T) => Math.max(Math.abs(h.pos.x - pos.x), Math.abs(h.pos.y - pos.y)) <= 1;
  return hostiles.filter((h) => (h.awareness === 'hunting' && !h.fleeing && (near(h) || (!!h.kind && !!catalog.monsters[h.kind]?.tags.includes('ranged'))))
    || (h.awareness === 'hunting' && !!h.fleeing && near(h)));
}

/**
 * 止まった・断った文の数（S1c §14.4 の 1）:「見込み 12・最悪 40（HP 50・hp_floor 45）」。どちらで止めたか（見込み）が分かるように並べる。
 * hpFloor は実際に使った値（渡した値か既定）
 */
export function riskText(view: PlayerView, catalog: Catalog, hpFloor: number): string {
  const pos = view.self.pos;
  const L = view.locale;
  const est = pos ? threatEstimate(view, catalog, fightThreats(catalog, view.entities.filter((e) => e.cat === 'monster'), pos)) : { expected: 0, worst: 0, unrecorded: 0 };
  const ja = L !== 'en';
  const hp = view.self.stats.hp;
  const by = fightRiskStop(hp, hpFloor, est);
  const head = est.expected === est.worst
    ? (ja ? `見込み ${est.expected}（最悪も ${est.worst}）` : `expected ${est.expected} (worst also ${est.worst})`)
    : (ja ? `見込み ${est.expected}・最悪 ${est.worst}` : `expected ${est.expected}, worst ${est.worst}`);
  // どちらで止まったか（S1d §17.2）
  const why = by === 'lethal'
    ? (ja ? `死にうるので止まった: HP ${hp} が最悪 ${est.worst} 以下（hp_floor によらない）。` : `Stopped because one turn could kill you: HP ${hp} is at or below the worst ${est.worst} (whatever hp_floor is). `)
    : by === 'floor' ? (ja ? `hp_floor で止まった: HP ${hp} − 見込み ${est.expected} が hp_floor ${hpFloor} を下回る。` : `Stopped at hp_floor: HP ${hp} minus expected ${est.expected} falls below hp_floor ${hpFloor}. `) : '';
  return ja ? `${why}${head}（HP ${hp}・hp_floor ${hpFloor}。見込みは、いちばん重い 1 体を記録の会心でない最大の一撃、残りを記録の平均の被害で数える。最悪は全員が最大の一撃・会心を含む）`
    : `${why}${head} (HP ${hp}, hp_floor ${hpFloor}; expected counts the heaviest enemy at its recorded worst non-critical hit and the rest at their recorded average; worst has everyone at their worst hit, criticals included)`;
}

// 危険の見積もり（V3-2R3 §20.4）: 速さの比と思い出の記録から、1 手番あたりの最悪の被害を出す。観測とマクロで共用。
// 入力は PlayerView と公開カタログだけ（伏せた能力値は使わない）。
import type { Catalog } from './catalog';
import { memoryKey, stairsSealed } from './catalog';
import type { MonsterMemory } from './types';
import { ceilDiv, cheb, floorDiv } from './util';
import type { EntityView, PlayerView } from './view';

/**
 * 階を移ったときの追っ手（S18。SEASON.md §73.2 の 6。engine の事実: プレイヤーのいない階の時間は止まる。敵は階段を越えない）。
 * 「取れる手」と階段までの見込みの、短い句
 */
export const STAIRS_STAY_JA = '敵は階段を追ってこないが、その階に残る。離れている間、その階の時間は止まり、戻ると同じ所にいる';
export const STAIRS_STAY_EN = 'enemies do not follow you between floors, but they stay: time stops on that floor while you are away, so they are where you left them when you return';

/**
 * use_stairs の応答の 1 行（S18。SEASON.md §73.2 の 6）: 階を移る前に見えていた、追跡中で逃げていない敵の数（見えていなかった者は数えない）。
 * 階を移っていない（断られた・同じ階）・追っ手がいなければ null。near: 階段（移る前の自分のマス）から 2 マス以内
 */
export function stairsLeftBehindText(L: 'ja' | 'en', before: PlayerView, after: PlayerView): string | null {
  const from = before.self.pos, to = after.self.pos;
  if (!from || !to || !before.floor || !after.floor || before.floor.key === after.floor.key) return null;
  const hunters = before.entities.filter((e) => e.cat === 'monster' && e.awareness === 'hunting' && !e.fleeing);
  if (!hunters.length) return null;
  const near = hunters.filter((e) => cheb(e.pos, from) <= 2).length;
  const n = hunters.length;
  if (L === 'en') {
    const where = near === n ? 'by the stairs on the floor you left' : near ? `on the floor you left (${near} of them by the stairs)` : 'on the floor you left';
    return `The ${n} enem${n === 1 ? 'y' : 'ies'} hunting you stay${n === 1 ? 's' : ''} ${where} (time there stops while you are away; when you go back they are where you left them${near ? ', and the ones by the stairs are next to you again' : ''}).`;
  }
  const where = near === n ? '前の階の階段のそばに' : near ? `前の階に（うち ${near} 体は階段のそば）` : '前の階に';
  return `追っていた敵 ${n} 体は、${where}残っている（離れている間、その階の時間は止まる。戻ると、離れたときの所にいる${near ? '。階段のそばの敵とは、また隣り合う' : ''}）。`;
}

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
 * 記録の足りる種族の、攻撃 times 回分の平均の被害（S7。SEASON.md §52.3 の 5）: その種族から攻撃された回数が、体力の記録と同じ決まりの数
 * （rules.estimateMinSamples。既定 5）以上のときだけ、攻撃で受けた被害の合計 ÷ 攻撃された回数（相手の命中の割合 × 当たったときの平均。外れは 0）。
 * 足りなければ null（今までどおりの数え方にする）
 */
export function recordedHitsOf(view: PlayerView, catalog: Catalog, e: Pick<EntityView, 'kind' | 'role'>, times: number): number | null {
  const d = memoryOf(view, e)?.dmgOnYou;
  const min = catalog.rules?.estimateMinSamples ?? 5;
  if (!d || d.length < 3 || d[2] < min) return null;
  return avgHitsOf(view, e, times);
}

/** 射線の切れている射手（S7 §52.3 の 5）: 射撃する種族で、隣でなく、こちらとの間の射線（観測の shot）が通っていない。見込みから外し、最悪には残す */
export function lineBlockedShooter(catalog: Catalog, e: Partial<Pick<EntityView, 'kind' | 'shot' | 'pos'>>, me: { x: number; y: number } | null | undefined): boolean {
  if (!me || !e.pos || e.shot !== false || !e.kind || !catalog.monsters[e.kind]?.tags.includes('ranged')) return false;
  return Math.max(Math.abs(e.pos.x - me.x), Math.abs(e.pos.y - me.y)) > 1;
}

/**
 * fight の止まり方の見積もり（S1c §14.4 の 1・S1d §17.2）: 次の手番の被害の見込み expected と、最悪 worst（全員が記録の最大の一撃。会心を含む）。
 * expected = いちばん重い 1 体（1 手の「ふつうの」最大が最大の者）は会心でない最大の一撃、残りは 1 手の平均（平均の記録が無ければ、ふつうの最大。重い側）の合計。
 * fight は、HP が worst 以下なら止まり（死にうる）、HP − expected が hp_floor を下回れば止まる。
 * 被弾の記録の無い敵は、どちらにも数えない（今までどおり。fight は記録の無い種族で別に止まる）。unrecorded はその数。
 * S7a（SEASON.md §53.9 の 1）: 止まる判定に使うこの数は、S1d のまま。記録の平均で数えた「ふつう」は usualEstimate（表示だけ）
 */
export function threatEstimate(view: PlayerView, catalog: Catalog, threats: readonly Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses' | 'paceAgo'>[]): { expected: number; worst: number; unrecorded: number } {
  const per = threats.map((h) => ({ w: worstTurnOf(view, catalog, h), p: plainTurnOf(view, catalog, h), a: avgTurnOf(view, catalog, h) }));
  const known = per.filter((x): x is { w: number; p: number; a: number | null } => x.w !== null && x.p !== null).sort((a, b) => b.p - a.p);
  const worst = known.reduce((s, x) => s + x.w, 0);
  const expected = known.length ? known[0].p + known.slice(1).reduce((s, x) => s + Math.min(x.p, x.a ?? x.p), 0) : 0;
  return { expected, worst, unrecorded: per.length - known.length };
}

/**
 * 「ふつう」の被害（S7 §52.3 の 5・S7a §53.9 の 2。表示だけ: マクロの止まり方・「できること」・pilot の判定には使わない）:
 * 記録の足りる種族（recordedHitsOf）は、その記録の平均（命中の割合 × 受けた被害の平均）× 行動の回数。記録の足りない種族は、
 * 今までの数え方（その中でいちばん重い 1 体は会心でない最大の一撃、残りは 1 手の平均）。射線の切れている射手は入れない。被弾の記録の無い敵は入れない。
 * 見込み（threatEstimate の expected）より大きくは出さない（S7b）
 */
export function usualEstimate(view: PlayerView, catalog: Catalog, threats: readonly (Pick<EntityView, 'kind' | 'role' | 'speed' | 'statuses' | 'paceAgo'> & Partial<Pick<EntityView, 'shot' | 'pos'>>)[]): number {
  const me = view.self.pos;
  const per = threats.map((h) => ({
    w: worstTurnOf(view, catalog, h), p: plainTurnOf(view, catalog, h), a: avgTurnOf(view, catalog, h),
    r: recordedHitsOf(view, catalog, h, attacksPerTurn(view, catalog, h)), blocked: lineBlockedShooter(catalog, h, me),
  }));
  const counted = per.filter((x): x is typeof x & { w: number; p: number } => x.w !== null && x.p !== null && !x.blocked);
  const byRecord = counted.filter((x) => x.r !== null).reduce((s, x) => s + x.r!, 0);
  const rest = counted.filter((x) => x.r === null).sort((a, b) => b.p - a.p);
  const usual = byRecord + (rest.length ? rest[0].p + rest.slice(1).reduce((s, x) => s + Math.min(x.p, x.a ?? x.p), 0) : 0);
  // 見込みより大きくは出さない（S7b: 記録の足りない種族が「いちばん重い 1 体」に回ると、見込みを 1 上回ることがあった）
  return Math.min(usual, threatEstimate(view, catalog, threats).expected);
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
  // ふつう（S7a §53.9 の 2）: あなたの記録からの平均。見込みと同じなら添えない。止まる判定には使わない
  const usual = pos ? usualEstimate(view, catalog, fightThreats(catalog, view.entities.filter((e) => e.cat === 'monster'), pos)) : est.expected;
  const uj = usual !== est.expected ? `・ふつうは ${usual}` : '';
  const ue = usual !== est.expected ? `, usually ${usual}` : '';
  return ja ? `${why}${head}（HP ${hp}・hp_floor ${hpFloor}${uj}。見込みは、いちばん重い 1 体を記録の会心でない最大の一撃、残りを記録の平均の被害で数える${uj ? '（止まる判定に使う数）。ふつうは、あなたの記録からの平均（表示だけ）' : ''}。最悪は全員が最大の一撃・会心を含む）`
    : `${why}${head} (HP ${hp}, hp_floor ${hpFloor}${ue}; expected counts the heaviest enemy at its recorded worst non-critical hit and the rest at their recorded average${ue ? ' (the number the stop uses); usually is the average from your own record (display only)' : ''}; worst has everyone at their worst hit, criticals included)`;
}

/**
 * 逃げる移動（mode: flee）が死にうるので止まった・断ったときの数（S6 §49.6 の 1）: 次の 1 歩の間の、届く追跡中の敵（隣・射撃）の最悪の 1 手
 * （fight の「死にうる」と同じ数: 全員が記録の最大の一撃・会心を含む）と今の HP。withOptions なら取れる手（綱・回復の薬・向きを変える）も
 */
export function fleeRiskText(view: PlayerView, catalog: Catalog, withOptions = true): string {
  const ja = view.locale !== 'en';
  const pos = view.self.pos;
  const est = pos ? threatEstimate(view, catalog, fightThreats(catalog, view.entities.filter((e) => e.cat === 'monster'), pos)) : { expected: 0, worst: 0, unrecorded: 0 };
  const hp = view.self.stats.hp;
  const head = ja ? `次の 1 歩の間の最悪の見込み ${est.worst}（届く追跡中の敵の、記録の最大の一撃。会心を含む）・いまの HP ${hp}。` : `Worst case during the next step ${est.worst} (the recorded biggest hit of each hunter in reach, crits included); HP now ${hp}.`;
  if (!withOptions) return head;
  return `${head}${ja ? '' : ' '}${fleeOptionsText(view, catalog)}`;
}

/**
 * 逃げる移動が死にうるときの、取れる手（S6・S6a）: 階段の上なら階段と extract（S6a §50.4 の 2）・帰還の綱・回復の薬・向きを変える。
 * 「取れる手: …。」の 1 文（持っている品はスロット付き）
 */
export function fleeOptionsText(view: PlayerView, catalog: Catalog): string {
  const ja = view.locale !== 'en';
  const pos = view.self.pos;
  const lifeline = view.inventory.find((i) => !!i.kind && !!catalog.items[i.kind]?.bound);
  const potion = view.inventory.find((i) => i.kind === 'core:potion_healing');
  // 階段の上（着いた手番に止まった）: 階を移る・帰る。封じられた下り階段は使えない
  const f = view.floor;
  const stairs = f && pos ? catalog.terrain[view.terrainTable[view.memory.terrain[pos.y * f.width + pos.x]]]?.stairs ?? null : null;
  const sealed = stairs === 'down' && stairsSealed(catalog.rules?.milestone, f?.depth ?? 0, view.milestonesCleared ?? []);
  const canExtract = !!stairs && !!view.expedition && view.expedition.status !== 'ended';
  // 観測の extract_outcome と同じ（遺物の目的は、自分が持っているときだけ達成）
  const xv = view.expedition;
  const done = xv?.status === 'objective_complete' && (xv.objective.type !== 'retrieve_relic' || xv.progress.relicHeldByYou);
  const opts = [
    stairs && !sealed ? (ja ? `階段を使う（use_stairs で${stairs === 'down' ? '降りる' : '上る'}。${STAIRS_STAY_JA}）` : `the stairs (use_stairs to go ${stairs}; ${STAIRS_STAY_EN})`) : '',
    // 目的が未達なら、extract は confirm: true が無いと 1 回断られる（S6b。valid_actions の撤退の行と同じ）
    canExtract ? (done ? (ja ? 'ここで帰る（extract）' : 'go home from here (extract)') : (ja ? 'ここで帰る（extract。目的は未達: confirm: true で撤退）' : 'go home from here (extract; objective not met: withdraw with confirm: true)')) : '',
    lifeline ? (ja ? `帰還の綱（use_item { slot: '${lifeline.slot}' }）` : `the lifeline (use_item { slot: '${lifeline.slot}' })`) : '',
    potion ? (ja ? `回復の薬（use_item { slot: '${potion.slot}' }）` : `a healing potion (use_item { slot: '${potion.slot}' })`) : '',
    ja ? '向きを変える（move で 1 歩ずつ。別の道・視線を切る）' : 'another direction (step with move: another way, or break line of sight)',
  ].filter(Boolean);
  return ja ? `取れる手: ${opts.join('・')}。` : `Options: ${opts.join(', ')}.`;
}

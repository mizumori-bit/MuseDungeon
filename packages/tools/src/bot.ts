// ベースライン bot（ランダム／貪欲）。AI と同じ PlayerPort・同じ Command・同じ観測だけを使う。
// 貪欲 bot は遠征を遊ぶ: 目的を追い、達成したら階段の上で extract、キャンプでは次の遠征を選ぶ。
import type { Command, Dir, ExpeditionEndReason, OfferSlot, PlayerView } from '@muse/shared';
import { abilityStatus, buildNavGrid, cheb, compassDir, dirTo, DIRS, distanceField, isCursedItem, offerGap, perkChoice, Rng } from '@muse/shared';
import type { Catalog } from '@muse/shared';
import type { PlayerPort, SessionManager } from '@muse/server';

const WEAPON_RANK = ['core:dagger', 'core:short_sword', 'core:spear', 'core:mace', 'core:war_axe'];
const ARMOR_RANK = ['core:leather_armor', 'core:scale_mail', 'core:plate_armor'];

export type BotKind = 'greedy' | 'random';

export interface BotFloorStat {
  depth: number;
  /** 到着から下り階段を初めて知るまでの自分の手番数（見つけなければ null） */
  turnsToStairs: number | null;
  /** 到着から次の階へ進むまでの手番数（進まなければ null） */
  turnsOnFloor: number | null;
}

export interface BotResult {
  runId: string;
  seed: string;
  depth: number;
  turns: number;
  kills: number;
  level: number;
  acts: number;
  cause: string | null;
  ms: number;
  obsBriefChars: number[];
  obsFullChars: number[];
  /** 遠征の結果（通番順） */
  expeditions: { no: number; type: string; targetDepth: number | null; reason: ExpeditionEndReason | null; turns: number | null; calls: number }[];
  /** マクロ 1 回あたりの手数（判断間隔の計測用） */
  macroSteps: number[];
  floors: BotFloorStat[];
  /** スコア版 2 の確定点 */
  banked: number;
  died: boolean;
  /** 撃破の内訳（自分が倒した敵の、最後の一撃の種類。V3-4 §10 の「投擲と近接」） */
  killsBy?: { total: number; melee: number; thrown: number };
}

function hpPct(v: PlayerView): number {
  return Math.trunc((v.self.stats.hp * 100) / Math.max(1, v.self.stats.maxHp));
}

export interface BotMemo {
  restFails: number; avoid: Set<string>; blocked: number; descend: boolean; gaveUp: number | null;
  /** 探索を終えた目標階で、気配の方角の既知のマスへ向かい直した回数（遠征ごと） */
  senseTries: number; senseNo: number;
  /** 方針: 目的を達成した後、目標より何階深く潜ってから帰るか */
  overreach: number;
  /** 方針: キャンプで選ぶ枠（無ければ 1 番目） */
  offerSlot?: OfferSlot;
  /** 方針: 踏破の途中で HP が 60% を切ったらその場で帰る（既定 true） */
  cautious: boolean;
  /** 方針: 推奨レベルに届いている枠だけを選ぶ（届かなければ堅実で育つ。§18.8 の「推奨レベルどおりの bot」） */
  levelAware: boolean;
  /** 方針: 直行（V3-2R3 §20.2）。道をふさぐ・隣に来た敵とだけ戦い、下り階段を見つけたらすぐ向かう */
  direct: boolean;
  /** 方針: 取り続ける特技の系統（V3-4 §10 の計測）。無ければ既定の好み */
  perkLineage?: string;
}

export function newMemo(policy: { overreach?: number; offerSlot?: OfferSlot; cautious?: boolean; levelAware?: boolean; direct?: boolean; perkLineage?: string } = {}): BotMemo {
  return {
    restFails: 0, avoid: new Set<string>(), blocked: 0, descend: false, gaveUp: null, senseTries: 0, senseNo: 0, overreach: policy.overreach ?? 0, offerSlot: policy.offerSlot,
    cautious: policy.cautious ?? true, levelAware: policy.levelAware ?? false, direct: policy.direct ?? false,
    ...(policy.perkLineage ? { perkLineage: policy.perkLineage } : {}),
  };
}

/** 既定の好み（系統の方針が無いとき・方針の系統が候補に無いとき）: 能力値の特技を先に */
const PERK_PREF = ['core:perk_hardy', 'core:perk_precise', 'core:perk_strong', 'core:perk_nimble'];

/** 特技の候補から選ぶ（V3-4）: 方針の系統 → 既定の好み → 最初の候補 */
export function pickPerk(v: PlayerView, catalog: Catalog, lineage?: string): number | null {
  const o = perkChoice(v);
  if (!o) return null;
  const idx = (pred: (id: string) => boolean) => o.options.findIndex(pred);
  let i = lineage ? idx((id) => catalog.perks[id]?.lineage === lineage) : -1;
  if (i < 0) for (const want of PERK_PREF) { i = idx((id) => id === want); if (i >= 0) break; }
  if (i < 0) i = idx((id) => catalog.perks[id]?.lineage !== 'common');
  return (i < 0 ? 0 : i) + 1;
}

/** 能動技が今使えるか（覚えていて、残りの手番 0、遠征ごとの回数が残っている） */
function ready(v: PlayerView, catalog: Catalog, id: string): boolean {
  if (!v.self.build.abilities.some((a) => a.id === id)) return false;
  const s = abilityStatus(v, catalog, id);
  return s.cooldownLeft === 0 && s.usesLeft !== 0;
}

/** 既知の階段のうち一番近い到達可能なものへの travel（無ければ null） */
function toNearestStairs(port: PlayerPort): Command | null {
  const ks = port.observe({ map: false }).observation.navigation.known_stairs.filter((s) => s.reachable);
  if (!ks.length) return null;
  const hp = hpPct(port.view());
  return { type: 'travel', to: ks[0].type === 'down' ? 'stairs_down' : 'stairs_up', ...steadyIf(hp) };
}

/** 余力（HP 60% 以上）があれば steady で進む */
function steadyIf(hp: number): { mode?: 'steady' } {
  return hp >= 60 ? { mode: 'steady' } : {};
}

function hunting0(v: PlayerView): boolean {
  return v.entities.some((e) => e.cat === 'monster' && e.awareness === 'hunting');
}

const DIR_ORDER: Dir[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
/** 隣り合う方角か（北と北東など） */
function neighborDir(a: Dir | null, b: Dir): boolean {
  if (!a) return false;
  const d = Math.abs(DIR_ORDER.indexOf(a) - DIR_ORDER.indexOf(b));
  return d === 1 || d === 7;
}

/** 気配の方角にある、既知で歩いて届く遠いマス（5 マス以上先。無ければ null） */
function senseCell(port: PlayerPort, dir: Dir): { x: number; y: number } | null {
  const v = port.view();
  const f = v.floor;
  const me = v.self.pos;
  if (!f || !me) return null;
  const grid = buildNavGrid(v, port.catalog);
  if (!grid) return null;
  const dist = distanceField(grid, me, false);
  let best: { x: number; y: number } | null = null;
  let bestD = 0;
  for (let i = 0; i < dist.length; i++) {
    if (dist[i] < 5) continue;
    const p = { x: i % f.width, y: Math.trunc(i / f.width) };
    const d = compassDir(me, p);
    if (d !== dir && !neighborDir(d, dir)) continue;
    const c = cheb(me, p);
    if (c > bestD) { bestD = c; best = p; }
  }
  return best;
}

/** 方針の階数だけ踏破したか */
function crossedEnough(x: NonNullable<PlayerView['expedition']>, memo: BotMemo): boolean {
  return x.objective.targetDepth === null || memo.overreach === 0 || x.crossedDepth >= x.objective.targetDepth + memo.overreach;
}

export function greedyDecide(port: PlayerPort, rng: Rng, memo: BotMemo): Command {
  const v = port.view();
  // 特技は手番を使わずに選べるので、候補が出たらすぐ選ぶ（V3-4）
  const perk = pickPerk(v, port.catalog, memo.perkLineage);
  if (perk !== null) return { type: 'choose_perk', option: perk };
  if (v.status === 'at_camp') {
    let o = (memo.offerSlot ? v.camp?.offers.find((x) => x.slot === memo.offerSlot) : undefined) ?? v.camp?.offers[0];
    // 推奨レベルに届いていなければ堅実で育つ（公開の表と自分のレベルだけで判断）
    if (memo.levelAware && o && o.objective.targetDepth !== null && offerGap(port.catalog.rules, o.objective.targetDepth, o.traits ?? [], v.self.level).levelGap! > 0) {
      o = v.camp?.offers.find((x) => x.slot === 'safe') ?? o;
    }
    return { type: 'start_expedition', offer: o?.index ?? 'endless' };
  }
  const me = v.self;
  const pos = me.pos!;
  const hostiles = v.entities.filter((e) => e.cat === 'monster').sort((a, b) => cheb(a.pos, pos) - cheb(b.pos, pos));
  const adj = hostiles.find((h) => cheb(h.pos, pos) === 1);
  const inv = v.inventory;
  const healing = inv.find((i) => i.kind === 'core:potion_healing');
  const unknownPotion = inv.find((i) => i.kind === null && i.appearanceId?.includes('potion'));
  const unknownScroll = inv.find((i) => i.kind === null && i.appearanceId?.includes('scroll'));
  const throwable = inv.find((i) => i.kind === 'core:throwing_knife' || i.kind === 'core:javelin');
  const lifeline = inv.find((i) => i.kind === 'core:lifeline');
  const carried = inv.filter((i) => i.kind !== 'core:lifeline').length;
  const hp = hpPct(v);
  const onStairs = !!pos && !!port.catalog.terrain[v.terrainTable[v.memory.terrain[pos.y * (v.floor?.width ?? 0) + pos.x]]]?.stairs;
  const x = v.expedition && v.expedition.status !== 'ended' ? v.expedition : null;
  const complete = !!x && x.status === 'objective_complete' && (x.objective.type !== 'retrieve_relic' || x.progress.relicHeldByYou);
  // 踏破の方針: 目標より overreach 階深い下り階段に立つまでは帰らない。ただし余力（HP 60% 以上）が無くなったらその場で帰る
  const done = complete && (x!.objective.targetDepth === null || crossedEnough(x!, memo) || (memo.cautious && x!.maxDepth > x!.objective.targetDepth && hp < 60));
  const onTarget = !!x && x.objective.targetDepth !== null && v.floor?.depth === x.objective.targetDepth;

  // 立て直し（遠征ごとに 1 回）は薬より先に使う
  if (hp < 40 && (adj || hostiles.length) && ready(v, port.catalog, 'core:second_wind')) return { type: 'ability', id: 'second_wind' };
  if (hp < 35 && healing && (adj || hostiles.length)) return { type: 'use', slot: healing.slot };
  if (hp < 25 && unknownPotion && adj) return { type: 'use', slot: unknownPotion.slot };
  // 退く（V3-2R2 §18.1）: 余力が無く、群れ（追跡中 2 体以上）か一撃で倒されうる相手がいる。
  // 階段の上なら extract（達成済みなら帰還、未達成なら撤退）、遠ければ帰還の綱。達成済みで階段の上なら相手によらず帰る
  const huntingNow = hostiles.filter((h) => h.awareness === 'hunting' && !h.fleeing);
  if (hp < 30 && huntingNow.length) {
    if (onStairs && complete) return { type: 'extract' };
    // 1 手で倒されうる（lethal_range）ときだけ退く（群れでも押し切れるなら戦う）
    // 階段の上なら extract、そうでなければ綱（§22.2 の「綱の前に階段へ退く」は V3-2R3b §23.1 で取り消し）
    const danger = port.observe({ map: false }).observation.alerts.some((a) => a.code === 'lethal_range');
    if (danger && onStairs) return { type: 'extract', confirm: true };
    if (danger && lifeline) return { type: 'use', slot: lifeline.slot };
  }
  // 能動技は fight に載せる（使える手番ごとに fight が使う。V3-4a §25.3）
  const meleeAbilities = v.self.build.abilities.map((a) => a.id).filter((id) => ['strike', 'cleave'].includes(port.catalog.abilities[id]?.handler ?? ''));
  const withAb = (ids: string[]) => (ids.length ? { abilities: ids } : {});
  // 隣の敵: 余力があれば fight（1 回の呼び出しで殴り続ける）、無ければ 1 発ずつ
  if (adj && (adj.awareness !== 'asleep' || hp > 50)) {
    const floor = Math.trunc((v.self.stats.maxHp * 35) / 100);
    // 追跡中の敵が 2 体以上なら、倒したら次の相手へ続ける（V3-4b §28.4）
    const pack = hostiles.filter((h) => h.awareness === 'hunting' && !h.fleeing).length >= 2;
    return v.self.stats.hp > floor ? { type: 'fight', target: adj.id, hpFloor: floor, ...(pack ? { until: 'clear' as const } : {}), ...withAb(meleeAbilities) } : { type: 'move', dir: dirTo(pos, adj.pos)! };
  }
  const hunting = hostiles.filter((h) => h.awareness === 'hunting');
  // 投擲が得意な職業（習熟が正）は 2 マス先の相手にも投げる（それ以外は近接に任せる）
  const minThrow = (port.catalog.classes[v.self.classId]?.proficiency?.thrown ?? 0) > 0 ? 2 : 3;
  // 狙い撃ち（V3-4）: まだ気づいていない相手には、先に命中 +4・会心の一投（追跡中の相手には fight に載せる）
  const aimedKnown = v.self.build.abilities.some((a) => a.id === 'core:aimed_throw');
  if (!memo.direct && throwable && ready(v, port.catalog, 'core:aimed_throw')) {
    const tg = hostiles.find((h) => h.awareness === 'unaware' && h.shot && cheb(h.pos, pos) >= minThrow && cheb(h.pos, pos) <= 6 && !memo.avoid.has(h.id));
    if (tg) return { type: 'ability', id: 'aimed_throw', target: tg.id, slot: throwable.slot };
  }
  // 投擲は fight { with } で決着まで（射程に入るまで待つ。V3-2R2 §18.5）。2 マス先の相手はすぐ隣に来るので近接に任せる。直行は投げない
  if (!memo.direct && hunting.length && throwable && cheb(hunting[0].pos, pos) <= 6 && cheb(hunting[0].pos, pos) >= minThrow && !memo.avoid.has(hunting[0].id)) {
    return { type: 'fight', target: hunting[0].id, with: throwable.slot, hpFloor: Math.trunc((v.self.stats.maxHp * 35) / 100), ...withAb(aimedKnown ? ['core:aimed_throw'] : []) };
  }
  // 射撃して距離を取る敵: 投げる物が無ければ HP によらず近づく（寄られると下がり、下がる間は撃たない。V3-2R3a §22.2）
  const shooter = hunting.find((h) => !h.fleeing && !!h.kind && !!port.catalog.monsters[h.kind]?.tags.includes('ranged') && cheb(h.pos, pos) <= 8 && !memo.avoid.has(h.id));
  if (shooter && (!throwable || memo.direct)) return { type: 'travel', to: shooter.id, mode: 'steady', hpFloor: 0 };
  if (!memo.direct && hunting.length && hp < 60 && cheb(hunting[0].pos, pos) <= 8 && !memo.avoid.has(hunting[0].id)) return { type: 'travel', to: hunting[0].id };
  // 遠征の目的
  if (done || memo.gaveUp !== null) {
    const ex = port.observe({ map: false }).observation.expedition;
    if (ex?.can_extract) return done ? { type: 'extract' } : { type: 'extract', confirm: true };
    if (!hostiles.length && hp < 50 && memo.restFails < 3) { memo.restFails++; return { type: 'rest' }; }
    const go = toNearestStairs(port);
    if (go && ex?.extract_blocked_by === 'not_on_stairs') return go;
  }
  if (x && onTarget && !done && v.sense && !hunting0(v)) {
    const want = v.sense.dir;
    const seenTarget = v.entities.some((e) => e.role === (v.sense!.what === 'relic' ? 'relic' : 'guardian'));
    if (!seenTarget) {
      const fr = port.observe({ map: false }).observation.navigation.frontiers.filter((f) => f.dir === want || neighborDir(f.dir, want));
      // 近すぎる行き先は explore に任せる（短い呼び出しを増やさない）
      const far = fr.filter((f) => f.dist >= 5);
      if (far.length) return { type: 'travel', to: far[0].pos, ...steadyIf(hp) };
    }
  }
  // 踏破型（V3-2R3 §20.1）: 目標階の下り階段に立てば達成。知っていれば向かい、知らなければ下への風の方角を探す
  if (x && onTarget && !done && x.objective.type === 'reach_depth' && !x.progress.reached) {
    const down = port.observe({ map: false }).observation.navigation.known_stairs.find((s) => s.type === 'down' && s.reachable);
    if (down) return { type: 'travel', to: 'stairs_down', ...steadyIf(hp) };
    if (v.floorHint?.draft) return { type: 'explore', toward: 'draft', ...steadyIf(hp) };
  }
  // 直行: 目標より上の階では、下り階段を知っていればすぐ降りる（知らなければ下への風の方角を探す）
  if (memo.direct && x && !done && x.objective.targetDepth !== null && (v.floor?.depth ?? 0) < x.objective.targetDepth && !hunting.length) {
    const down = port.observe({ map: false }).observation.navigation.known_stairs.find((s) => s.type === 'down' && s.reachable);
    if (down) { memo.descend = true; return { type: 'travel', to: 'stairs_down', ...steadyIf(hp) }; }
    if (v.floorHint?.draft) return { type: 'explore', toward: 'draft', ...steadyIf(hp) };
  }
  if (x && onTarget && !done) {
    if (x.objective.type === 'slay_guardian' && !x.progress.guardianSlain) {
      const g = hostiles.find((h) => h.role === 'guardian');
      if (g && hp >= 60 && !memo.avoid.has(g.id)) return { type: 'travel', to: g.id };
    }
    if (x.objective.type === 'retrieve_relic' && !x.progress.relicHeld) {
      const here = v.entities.find((e) => e.role === 'relic' && e.pos.x === pos.x && e.pos.y === pos.y);
      if (here && carried >= me.capacity) {
        // 一杯なら要らない物を置く（装備していない武器・防具 → 未鑑定の巻物 → 先頭）
        const junk = inv.find((i) => !i.equipped && (WEAPON_RANK.includes(i.kind ?? '') || ARMOR_RANK.includes(i.kind ?? '')))
          ?? inv.find((i) => !i.equipped && i.kind === null && i.appearanceId?.includes('scroll')) ?? inv.find((i) => !i.equipped && i.kind !== 'core:potion_healing');
        if (junk) return { type: 'drop', slot: junk.slot };
      }
      if (here) return { type: 'pickup', item: here.id };
      const seen = v.entities.find((e) => e.role === 'relic') ?? v.memory.remembered.find((r) => r.role === 'relic');
      const pursuers = hunting.filter((h) => !h.fleeing && !(h.kind && port.catalog.monsters[h.kind]?.tags.includes('stationary') && cheb(h.pos, pos) > 1));
      if (seen && !memo.avoid.has(seen.id) && !pursuers.length) return { type: 'travel', to: seen.id };
    }
  }
  // 装備の更新（公開情報: 名前の序列のみ）。呪われて外せない場所は替えない（V3-4）
  const stuck = (slot: 'weapon' | 'armor' | 'accessory') => { const c = inv.find((i) => i.equipped === slot); return !!c && isCursedItem(port.catalog, c.affixes); };
  for (const it of inv) {
    if (it.equipped) continue;
    // 装飾品: 何も付けていなければ付けてみる（正体と呪いの有無は付けると分かる）
    const cat = it.kind ? port.catalog.items[it.kind]?.category : it.appearanceId ? port.catalog.appearances[it.appearanceId]?.category : undefined;
    if ((cat === 'ring' || cat === 'amulet') && !inv.some((i) => i.equipped === 'accessory')) return { type: 'equip', slot: it.slot };
    if (!it.kind) continue;
    const wr = WEAPON_RANK.indexOf(it.kind);
    const cur = inv.find((i) => i.equipped === 'weapon');
    if (wr >= 0 && !stuck('weapon') && (!cur || WEAPON_RANK.indexOf(cur.kind ?? '') < wr)) return { type: 'equip', slot: it.slot };
    const ar = ARMOR_RANK.indexOf(it.kind);
    const curA = inv.find((i) => i.equipped === 'armor');
    if (ar >= 0 && !stuck('armor') && (!curA || ARMOR_RANK.indexOf(curA.kind ?? '') < ar)) return { type: 'equip', slot: it.slot };
  }
  // 経路が塞がれていたら一番近い敵を排除しに行く／ランダムに動いて抜ける
  if (memo.blocked > 0) {
    memo.blocked--;
    const near = hostiles.find((h) => !memo.avoid.has(h.id));
    if (near && memo.blocked > 2) return { type: 'travel', to: near.id };
    const dirs = DIRS.filter((d) => port.observe({ map: false }).observation.navigation.passable_dirs.includes(d));
    if (dirs.length) return { type: 'move', dir: rng.pick(dirs) };
  }
  if (!hostiles.length && hp < 60 && memo.restFails < 3) { memo.restFails++; return { type: 'rest' }; }
  memo.restFails = 0;
  if (!hostiles.length && unknownScroll) return { type: 'use', slot: unknownScroll.slot };
  // アイテムは explore が通り道と見えている物を拾う。余力があれば steady（敵は隣に来たら止まって fight）
  return { type: 'explore', ...steadyIf(hp) };
}

export function randomDecide(port: PlayerPort, rng: Rng): Command {
  const v = port.view();
  if (v.status === 'at_camp') return { type: 'start_expedition', offer: 1 };
  const r = rng.int(100);
  if (r < 25) return { type: 'explore' };
  if (r < 30) return { type: 'wait' };
  if (r < 33) return { type: 'pickup' };
  if (r < 35) return { type: 'stairs' };
  if (r < 36) return { type: 'extract', confirm: rng.chance(50) };
  if (r < 38 && v.inventory.length) return { type: 'use', slot: rng.pick(v.inventory).slot };
  return { type: 'move', dir: rng.pick(DIRS) as Dir };
}

export interface BotOptions {
  kind: BotKind;
  seed: string;
  classId?: string;
  maxActs?: number;
  maxDepth?: number;
  measureObs?: boolean;
  /** この数の遠征が終わったらキャンプで止める（既定: 止めない） */
  maxExpeditions?: number;
  /** 最初の遠征の目的（既定 auto） */
  objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' | 'endless';
  /** 方針: 達成後に深追いする階数 */
  overreach?: number;
  /** 方針: キャンプで選ぶ枠 */
  offerSlot?: OfferSlot;
  /** 方針: 踏破の途中で HP が 60% を切ったら帰る（既定 true） */
  cautious?: boolean;
  /** 方針: 推奨レベルに届いている枠だけを選ぶ */
  levelAware?: boolean;
  /** 方針: 直行（道をふさぐ敵とだけ戦い、下り階段へ直行する） */
  direct?: boolean;
  /** 方針: 取り続ける特技の系統（V3-4） */
  perkLineage?: string;
}

/** 1 ランを最後まで（死亡・終了・上限）bot で遊ぶ */
export async function runBot(manager: SessionManager, opts: BotOptions): Promise<BotResult> {
  const t0 = Date.now();
  // objective を省くとキャンプから始まり、最初の遠征も方針の枠で選ぶ
  const r = await manager.createRun({ name: `${opts.kind}-bot`, classId: opts.classId, seed: opts.seed, controller: { kind: 'agent', label: `${opts.kind}-bot` }, objective: opts.objective === 'auto' ? undefined : opts.objective });
  if ('error' in r) throw new Error(r.error.message);
  const res = await playWithPort(r.port, opts);
  // 撃破の内訳（俯瞰の履歴から。計測用）
  const meId = r.session.world.players[r.port.playerId]?.entityId;
  const killsBy = { total: 0, melee: 0, thrown: 0 };
  for (const ev of r.session.history) {
    if (ev.type !== 'died' || ev.killer !== meId || ev.id === meId) continue;
    killsBy.total++;
    if (ev.via === 'melee') killsBy.melee++;
    else if (ev.via === 'thrown') killsBy.thrown++;
  }
  return { ...res, runId: r.session.runId, seed: opts.seed, ms: Date.now() - t0, killsBy };
}

export async function playWithPort(port: PlayerPort, opts: BotOptions): Promise<Omit<BotResult, 'runId' | 'seed' | 'ms'>> {
  const rng = Rng.fromSeed(`bot|${opts.seed}`);
  const memo = newMemo({ overreach: opts.overreach, offerSlot: opts.offerSlot, cautious: opts.cautious, levelAware: opts.levelAware, direct: opts.direct, perkLineage: opts.perkLineage });
  const maxActs = opts.maxActs ?? 2500;
  const brief: number[] = [];
  const full: number[] = [];
  const macroSteps: number[] = [];
  const floors: BotFloorStat[] = [];
  const expCalls = new Map<number, number>();
  const expTurns = new Map<number, { first: number; last: number }>();
  let floorKey: string | null = null;
  let floorStart = 0;
  let stairsAt: number | null = null;
  let acts = 0;
  let explored = false;
  for (; acts < maxActs; acts++) {
    const v = port.view();
    if (v.status === 'dead' || v.status === 'ended') break;
    if (v.status === 'at_camp') {
      const doneCount = (v.expedition?.no ?? 0);
      if (opts.kind === 'greedy' && opts.maxExpeditions !== undefined && doneCount >= opts.maxExpeditions) break;
      memo.gaveUp = null;
      memo.descend = false;
      memo.restFails = 0;
      explored = false;
    } else if (v.status !== 'your_turn') { await port.waitForTurn(2000); continue; }
    if (opts.maxDepth && (v.floor?.depth ?? 0) >= opts.maxDepth) break;
    // テンポの計測（自分の手番数で数える）
    if (v.floor && v.floor.key !== floorKey) {
      if (floorKey !== null && floors.length) floors[floors.length - 1].turnsOnFloor = v.self.turns - floorStart;
      floorKey = v.floor.key;
      floorStart = v.self.turns;
      stairsAt = null;
      floors.push({ depth: v.floor.depth, turnsToStairs: null, turnsOnFloor: null });
    }
    if (v.floor && stairsAt === null) {
      const known = v.memory.terrain.some((tt) => tt && port.catalog.terrain[v.terrainTable[tt]]?.stairs === 'down');
      if (known) { stairsAt = v.self.turns - floorStart; floors[floors.length - 1].turnsToStairs = stairsAt; }
    }
    if (opts.measureObs && acts % 10 === 0) {
      brief.push(JSON.stringify(port.observe({ detail: 'brief', map: true }).observation).length);
      full.push(JSON.stringify(port.observe({ detail: 'full', map: true }).observation).length);
    }
    let cmd: Command = opts.kind === 'greedy' ? greedyDecide(port, rng, memo) : randomDecide(port, rng);
    if (cmd.type === 'explore' && explored) {
      const x = v.expedition && v.expedition.status !== 'ended' ? v.expedition : null;
      const stuckOnTarget = !!x && x.objective.targetDepth !== null && (v.floor?.depth ?? 0) >= x.objective.targetDepth
        && x.status !== 'objective_complete' && (x.objective.type === 'slay_guardian' || x.objective.type === 'retrieve_relic');
      if (memo.senseNo !== (x?.no ?? 0)) { memo.senseNo = x?.no ?? 0; memo.senseTries = 0; }
      const toward = stuckOnTarget && v.sense && memo.senseTries < 6 ? senseCell(port, v.sense.dir) : null;
      if (toward) {
        // 探索し尽くしても気配が残っている（守護者は歩き回る）: 気配の方角の既知のマスへ向かい直す
        memo.senseTries++;
        cmd = { type: 'travel', to: toward, ...steadyIf(hpPct(v)) };
      } else if (stuckOnTarget) {
        // 目標階を探索し尽くしても見つからない → 撤退する
        memo.gaveUp = x!.no;
        cmd = toNearestStairs(port) ?? { type: 'wait' };
      } else {
        memo.descend = true;
        cmd = { type: 'travel', to: 'stairs_down', ...steadyIf(hpPct(v)) };
      }
    }
    const xno = v.expedition?.no ?? 0;
    // 呼び出しの予算は choose_perk を除いて数える（特技の選択は呼び出しを使う価値のある判断。V3-4a §25.3）
    if (cmd.type !== 'choose_perk') expCalls.set(xno, (expCalls.get(xno) ?? 0) + 1);
    if (v.status !== 'at_camp') {
      const tt = expTurns.get(xno);
      expTurns.set(xno, { first: tt?.first ?? v.self.turns, last: v.self.turns });
    }
    const out = await port.act(cmd, { source: 'bot' });
    if (out.ok && out.steps !== undefined && cmd.type !== 'rest') macroSteps.push(out.steps);
    if (out.ok && cmd.type === 'travel' && typeof cmd.to === 'string' && cmd.to.startsWith('e_') && (out.steps ?? 0) === 0 && out.interrupted_by !== 'arrived') memo.avoid.add(cmd.to);
    if (out.ok && cmd.type === 'rest' && (out.steps ?? 0) === 0) memo.restFails = 3;
    if (out.ok && out.interrupted_by === 'blocked') memo.blocked = 5;
    if (out.ok) {
      if (cmd.type === 'explore') explored = out.interrupted_by === 'explored';
      if (memo.descend && cmd.type === 'travel' && cmd.to === 'stairs_down' && (out.interrupted_by === 'arrived' || out.observation.alerts.some((a) => a.code === 'on_stairs'))) {
        // 踏破の方針を満たしたら下りずに、この下り階段で帰る（次の判断で extract）
        const xv = port.view().expedition;
        const enough = !!xv && xv.status === 'objective_complete' && memo.overreach > 0 && crossedEnough(xv, memo);
        if (enough) { memo.descend = false; explored = false; }
        else {
          const s = await port.act({ type: 'stairs' }, { source: 'bot' });
          if (s.ok) { explored = false; memo.descend = false; }
        }
      }
      if (cmd.type === 'travel' && cmd.to === 'stairs_down' && (out.interrupted_by === 'unknown_destination' || out.interrupted_by === 'unreachable' || out.interrupted_by === 'blocked')) { explored = false; memo.descend = false; }
    } else if (opts.kind === 'greedy' && cmd.type === 'travel' && cmd.to === 'stairs_down' && out.error.code === 'nothing_to_do') {
      // すでに下り階段の上にいる（「すでに目的地にいる」で断られた）: 着いたときと同じに扱う（断られて待つのを繰り返さない）
      const xv = port.view().expedition;
      const enough = !!xv && xv.status === 'objective_complete' && memo.overreach > 0 && crossedEnough(xv, memo);
      if (enough) { memo.descend = false; explored = false; }
      else {
        const s = await port.act({ type: 'stairs' }, { source: 'bot' });
        if (s.ok) { explored = false; memo.descend = false; }
        else if (port.view().status === 'your_turn') await port.act({ type: 'wait' }, { source: 'bot' });
      }
    } else if (opts.kind === 'greedy' && cmd.type === 'travel' && out.error.code === 'blocked' && !/move \{ dir: '([a-z]+)' \}/.test(out.error.hint)) {
      // 既知の道を敵がふさいでいる（マクロは攻撃しない）: 最寄りの見えている敵へ寄って殴る（断られて待つのを繰り返さない）
      const nv = port.view();
      const me = nv.self.pos;
      const foe = me ? nv.entities.filter((e) => e.cat === 'monster').sort((a, b) => cheb(a.pos, me) - cheb(b.pos, me))[0] : undefined;
      if (foe && me && nv.status === 'your_turn') {
        if (cheb(foe.pos, me) <= 1) await port.act({ type: 'move', dir: dirTo(me, foe.pos)! }, { source: 'bot' });
        else {
          const tr = await port.act({ type: 'travel', to: foe.id, mode: 'steady' }, { source: 'bot' });
          if (!tr.ok && port.view().status === 'your_turn') await port.act({ type: 'wait' }, { source: 'bot' });
        }
      } else if (nv.status === 'your_turn') await port.act({ type: 'wait' }, { source: 'bot' });
    } else if (opts.kind === 'greedy' && /move \{ dir: '([a-z]+)' \}/.test(out.error.hint)) {
      // 残りの道が発見済みの罠を通る（マクロは罠を踏まない）: 自分で 1 歩踏む
      const dir = /move \{ dir: '([a-z]+)' \}/.exec(out.error.hint)![1] as Dir;
      if (port.view().status === 'your_turn') await port.act({ type: 'move', dir }, { source: 'bot' });
    } else if (opts.kind === 'greedy') {
      // 行き詰まったら探索に戻す（1 歩も進めないマクロは手番を使わずに拒否される）
      if (cmd.type === 'travel' && typeof cmd.to === 'string' && cmd.to.startsWith('e_')) memo.avoid.add(cmd.to);
      if (cmd.type === 'fight') memo.avoid.add(cmd.target);
      if (cmd.type === 'explore' && out.error.code === 'nothing_to_do') explored = true;
      if (cmd.type === 'rest') memo.restFails = 3;
      if (cmd.type === 'travel' && cmd.to === 'stairs_down') { explored = false; memo.descend = false; }
      // fight が被弾の前の停止（hp_risk）で断られた: 隣の相手なら 1 発だけ殴る（待つと一方的に殴られる）
      const nv = port.view();
      const tg = cmd.type === 'fight' && out.error.code === 'hp_floor' ? nv.entities.find((e) => e.id === cmd.target) : undefined;
      if (tg && nv.self.pos && cheb(tg.pos, nv.self.pos) <= 1 && nv.status === 'your_turn') {
        await port.act({ type: 'move', dir: dirTo(nv.self.pos, tg.pos)! }, { source: 'bot' });
        continue;
      }
      if (nv.status === 'your_turn') await port.act({ type: 'wait' }, { source: 'bot' });
    }
  }
  const v = port.view();
  if (v.status !== 'dead' && v.status !== 'ended' && !(opts.maxExpeditions !== undefined && v.status === 'at_camp')) await port.act({ type: 'retire' }, { source: 'bot' });
  const summary = port.summary();
  const me = summary?.players.find((p) => p.id === port.playerId);
  const w = port.view();
  const exps = (summary?.expeditions ?? []).length ? summary!.expeditions! : [];
  const expeditions = (exps.length ? exps : (w.expedition ? [{ no: w.expedition.no, objective: w.expedition.objective, endReason: w.expedition.endReason, startSeq: w.expedition.startSeq, endSeq: w.expedition.endSeq }] : []))
    .map((x) => {
      const tt = expTurns.get(x.no);
      return { no: x.no, type: x.objective.type, targetDepth: x.objective.targetDepth, reason: x.endReason, turns: tt ? tt.last - tt.first : null, calls: expCalls.get(x.no) ?? 0 };
    });
  return {
    banked: w.record.banked,
    died: w.status === 'dead' || (me?.state === 'dead'),
    depth: me?.deepest ?? w.deepestDepth,
    turns: me?.turns ?? w.self.turns,
    kills: me?.kills ?? 0,
    level: me?.level ?? w.self.level,
    acts,
    cause: me?.deathCause ?? null,
    obsBriefChars: brief,
    obsFullChars: full,
    expeditions,
    macroSteps,
    floors,
  };
}

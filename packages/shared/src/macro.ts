// マクロ行動（explore / travel / rest / collect / fight）の計画。PlayerView だけを入力に「次の基本行動」を決める。
// AI も人間も同じものを使う。展開はサーバーが行い、各手を source:'macro' の通常コマンドとして記録する。
// V3-2R §14.2: 1 回の呼び出しは 1 つの判断に対応させる。移動マクロは慎重さ（mode）を選べる。
import type { Catalog } from './catalog';
import type { ActionError, Command, MacroMode, TravelTarget } from './commands';
import { actionError } from './commands';
import type { ProjectedEvent } from './filter';
import { memoryKey, nameOf, restCapHp } from './catalog';
import { fightRiskStop, fightThreats, threatEstimate } from './danger';
import { abilityStatus, weaponReach } from './build';

/** 能動技が今使えるか（残りの手番 0・遠征ごとの回数が残っている） */
function abilityReady(view: PlayerView, catalog: Catalog, id: string): boolean {
  const s = abilityStatus(view, catalog, id);
  return s.cooldownLeft === 0 && s.usesLeft !== 0;
}
import { buildNavGrid, dirBetween, findFrontiers, findPath } from './nav';
import type { NavGrid } from './nav';
import { kindName } from './narrate';
import type { Dir, Pos } from './types';
import { DIRS, DIR_VEC } from './types';
import { cheb, compassDir, t } from './util';
import type { Locale } from './types';
import type { EntityView, ItemView, PlayerView } from './view';

/** 既定値（実際の上限は catalog.rules.macroStepLimit / restMaxTurns） */
export const MACRO_STEP_LIMIT = 200;
/** travel: 目的地までの道のりがこの手数のあいだ縮まなければ止まる */
const TRAVEL_NO_PROGRESS = 20;

export type MacroStop =
  | 'hostile_in_view' | 'damaged' | 'item_seen' | 'stairs_seen' | 'arrived' | 'explored'
  | 'unreachable' | 'unknown_destination' | 'step_limit' | 'full_hp' | 'status_changed'
  | 'not_your_turn' | 'dead' | 'run_ended' | 'floor_changed' | 'blocked' | 'error'
  | 'target_hp' | 'max_turns' | 'left_board' | 'attacked' | 'collected' | 'hostile_adjacent' | 'sense_found' | 'hit_while_waiting'
  // シーズンの行動予算が尽きてキャンプへ戻された（S0 §9.2）
  | 'time_up'
  | 'hp_floor' | 'hp_threshold' | 'target_down' | 'target_gone' | 'target_moved' | 'hostile_alerted'
  // explore が止まらずに続けた遅い追跡者が 2 マス以内に来た（V4-0b §1.4）
  | 'chaser_near'
  // fight の拡張（V3-2R2 §18.5）
  | 'target_adjacent' | 'out_of_ammo' | 'no_line_of_sight' | 'target_not_approaching' | 'target_not_hunting' | 'not_throwable'
  // 被弾の前に止まる（V3-2R3 §20.4）: 次の手番に最悪の被害を受けると hp_floor を割る / 記録の無い種族から初めて被弾した
  | 'hp_risk' | 'first_hit'
  // fight に載せた能動技（V3-4a §25.3）: 覚えていない / 載せられない（立て直し・身をかわす） / 狙い撃ちには with が要る
  | 'ability_unknown' | 'ability_not_allowed' | 'ability_needs_with'
  // 既知の経路が発見済みの罠を通る（マクロは罠を踏まない。AI 評価 2026-11-17）
  | 'trap_ahead'
  // 休憩で戻る上限（最大 HP の rest.capPct %）に達した（V3-4b §28.3）
  | 'rest_cap'
  // fight（V3-4b §28.4）: 標的が逃げて見えなくなった / 待つ間に標的以外の射撃で被弾した / until: 'clear' で届く追跡中の敵がいなくなった
  | 'target_fled' | 'shot_while_waiting' | 'cleared'
  // 見えている敵が新しく予備動作を見せた（突進の構え・手下を呼ぶ構え・怒りの予兆。V3-3 §3.1）
  | 'intent'
  // fight: 待つ間に標的に殴られたが、標的は隣にいない（当てて離れる速い相手。V3-3 後の AI 評価）
  | 'hit_and_run' | 'target_shooting'
  // collect: 残りの品はどれも within 歩より遠い（V3-8 §53.4）
  | 'collect_far'
  // explore toward: その方角（下への風・気配）に行ける未探索の境界が無くなった（S1c §14.6 の 2。ほかの方角を探し続けない）
  | 'toward_exhausted'
  // steady の移動マクロで、始めてからの被害の合計が最大 HP の 4 分の 1 を超えた（V3-8a §56.1）
  | 'damage_taken'
  // 移動マクロが同じ 2 マスを往復している（見えるものが変わるたびに最短の道が入れ替わった。V3-3 後の bot の計測）
  | 'no_progress';

/** fight に載せられる能動技の振る舞い（V3-4a §25.3）。立て直し・身をかわすは、いつ使うかが判断そのものなので載せない */
export const FIGHT_ABILITY_HANDLERS: readonly string[] = ['strike', 'cleave', 'aimed_throw'];

/** fight の abilities を解決する（短い ID でもよい） */
export function resolveFightAbilities(view: PlayerView, catalog: Catalog, ids: readonly string[], withSlot: string | undefined): { ids: string[]; error?: 'unknown' | 'not_allowed' | 'needs_with' } {
  const out: string[] = [];
  for (const raw of ids) {
    const id = view.self.build.abilities.map((a) => a.id).find((k) => k === raw || k.split(':')[1] === raw);
    if (!id) return { ids: out, error: 'unknown' };
    const h = catalog.abilities[id]?.handler;
    if (!h || !FIGHT_ABILITY_HANDLERS.includes(h)) return { ids: out, error: 'not_allowed' };
    if (h === 'aimed_throw' && !withSlot) return { ids: out, error: 'needs_with' };
    if (!out.includes(id)) out.push(id);
  }
  return { ids: out };
}

/** 自然に終わった（中断ではない）停止理由 */
export const MACRO_COMPLETED_STOPS: ReadonlySet<MacroStop> = new Set<MacroStop>(['arrived', 'explored', 'full_hp', 'target_hp', 'max_turns', 'collected', 'collect_far', 'target_down', 'cleared', 'rest_cap', 'sense_found']);

/** 直線で 2 マス先、間のマスが既知の地形で通れて、見えている者がいない（長柄。engine の reachLine と同じ判定） */
export function reachMidOpen(view: PlayerView, catalog: Catalog, from: Pos, to: Pos): boolean {
  const f = view.floor;
  if (!f) return false;
  const dx = to.x - from.x, dy = to.y - from.y;
  if (cheb(from, to) !== 2 || (dx !== 0 && Math.abs(dx) !== 2) || (dy !== 0 && Math.abs(dy) !== 2)) return false;
  const mid = { x: from.x + Math.sign(dx), y: from.y + Math.sign(dy) };
  const tr = catalog.terrain[view.terrainTable[view.memory.terrain[mid.y * f.width + mid.x]]];
  if (!tr?.passable || tr.door === 'closed') return false;
  return !view.entities.some((e) => (e.cat === 'monster' || e.cat === 'player') && e.pos.x === mid.x && e.pos.y === mid.y);
}

/** fight が相手を待つ最大の手番（近づいてくるまで・射程に入るまで） */
export const FIGHT_WAIT_MAX = 10;
/** 迎え撃つ fight が、標的が近づかないまま待つ回数の上限（V3-3 後の AI 評価: 寄ってこない相手を 8 手番待って加速が切れた） */
export const FIGHT_NO_CLOSER_MAX = 3;
/** 当てて逃げる相手を待つ手番（隣から離れても 2 マス以内で追跡中なら） */
const FIGHT_APART_MAX = 2;
/** 射線が続けて通らなければ止まる手番 */
const FIGHT_BLOCKED_MAX = 3;

export interface MacroState {
  kind: 'explore' | 'travel' | 'rest' | 'collect' | 'fight' | 'wait';
  target?: TravelTarget;
  /** 移動マクロの慎重さ（careful 既定 / steady / flee） */
  mode: MacroMode;
  /** この HP を下回ったら止まる（steady / flee / fight）。careful は 50%・25% をまたいだら止まる */
  hpFloor: number;
  /** 通り道と目的地のアイテムを拾う */
  pickup: boolean;
  /** collect: 自分が投げた物だけか、見えている・記憶したアイテム全般か */
  collectWhat: 'thrown' | 'items';
  /** collect の絞り込み（V3-8 §53.4）: 歩数の上限・品の種類（種類 ID か区分）・劣る装備も拾う */
  collectWithin?: number;
  collectKinds?: string[];
  collectAll?: boolean;
  /** fight: 相手 */
  fightTarget?: string;
  /** fight: 投げる品のスロットと、開始時のその品の種類（尽きたら止まる） */
  fightWith?: string;
  fightKind?: string | null;
  /** fight: 投げる品の並び（前の品が尽きて拾い直せる物も無ければ次へ。V3-3c §44.6） */
  fightWithList?: { with: string; kind: string | null }[];
  /** fight: 決着の後に自分の投擲物を拾う（V3-3c §44.6）。fightDone: 拾い始めたときの決着（拾い終えたらこの理由で止まる） */
  collectAfter?: boolean;
  fightDone?: MacroStop;
  /** 足元の目的の品を拾ってから止まる理由（V3-8a §56.1。拾う 1 手の次の判断でこの理由で止まる） */
  pendingStop?: MacroStop;
  /** この呼び出しで受けた被害の合計（steady の damage_taken。V3-8a §56.1） */
  damageTaken?: number;
  /** 投げる物が尽きたら拾いに行く（V3-3b §40.1。既定 true） */
  fightRetrieve?: boolean;
  /** 拾いに行った手の数 */
  retrieved?: number;
  /** fight: 使える手番ごとに使う能動技（解決した ID）と、使えない指定（覚えていない・載せられない。V3-4a §25.3） */
  fightAbilities?: string[];
  fightAbilityError?: 'unknown' | 'not_allowed' | 'needs_with';
  /** fight: 一度でも隣で殴り合ったか・待った手番・隣から離れていた手番・射線が通らなかった手番 */
  engaged?: boolean;
  waits?: number;
  apart?: number;
  blocked?: number;
  /** fight の迎え撃ち: 直前の手番の標的との距離と、近づかなかった待ちの回数（V3-3 後の AI 評価） */
  lastDist?: number;
  noCloser?: number;
  /** 移動マクロ: 直近の位置（往復の検出） */
  trail?: number[];
  /** 移動マクロ: 近道をふさいで道を変えさせた、動く敵（その手の数）。往復で止まったときに名指す（S3c §33.3 の 2） */
  routeFoes?: { id: string; name: string; step: number }[];
  /** 往復（no_progress）で止まったときの、道を変えさせた相手（結果の文に出す） */
  noProgressBy?: { id: string; name: string }[];
  /** travel: 目的地までの道のりの最短と、それから縮まないまま進んだ手（V3-5c の bot の計測: 経路が変わり続けて 200 手さまよった） */
  bestLen?: number;
  sinceBest?: number;
  floorKey: string;
  lastHp: number;
  knownHostiles: string[];
  /** 見たことのある種族（初見の種族で止まる判定） */
  knownKinds: string[];
  knownItems: string[];
  knownStairs: number;
  steps: number;
  /** explore: 選んだ行き先（到達するか、行き先でなくなるまで固定。同距離の振動を防ぐ） */
  goal?: number;
  /** explore（careful）: 止まらずに続けた、遅く離れた追跡中の敵（V4-0b §1.4。結果の文に数を出す） */
  slowChasers?: string[];
  /** 拾えなかったアイテム（同じ物を拾い直そうとしない） */
  skipItems: string[];
  /** fight（V3-4b §28.4）: until（clear なら標的を倒した後も続ける）、with の相手が隣に来たときの扱い */
  fightUntil?: 'target' | 'clear';
  fightAdjacent?: 'throw' | 'melee' | 'stop';
  /** fight（V4-1a §12.5）: 追跡中で届かない相手を、隣に来るまで待つ（wait・既定）か、寄っていく（advance） */
  fightApproach?: 'wait' | 'advance';
  /** 標的が見えない手番の数（追跡中で逃げていない標的を見失ったら rules.fightLostWait まで待つ） */
  lostTurns?: number;
  /** 標的を最後に見たときに逃走中だったか（この呼び出しで見ていなければ undefined） */
  targetFleeing?: boolean;
  /** 標的を最後に見た場所（見失って止まったときに結果の文へ出す。草へ入るところを見ていたら、その草のマス。V4-0c §4.2） */
  targetSeenAt?: Pos;
  /** 標的は直前の応答で見えていて逃げていなかった（始めた時点で見えなくても待つ） */
  lostOk?: boolean;
  /** 直前の手が待つ手だった（待つ間に標的以外の射撃で被弾したら止まる） */
  waited?: boolean;
  /** until: 'clear' で倒した数 */
  cleared?: number;
  /** pickup: true（全部。種類の違う劣る装備も拾う）なら false。既定（useful）は true */
  pickUseful?: boolean;
  /** この呼び出しの間に見た動かない敵の位置（見えなくなっても隣を避け続ける。見える・見えないで経路が入れ替わって往復しないように） */
  stationary?: Pos[];
  /**
   * この呼び出しの間に眠っているのを見た敵（S1b §12.4 の 3・4）: 見えなくなっても、そのマスをふさいでいるものとして道を引く
   * （見えるとそのマスを避け、見えないと通る、を繰り返して 2 マスを往復した。試運転 t0）。そのマスが見えて、いなければ忘れる
   */
  sleepers?: { id: string; kind: string | null; x: number; y: number; guardian?: true }[];
  /** travel: 道を変えさせる、この呼び出しの間ずっと残る障害（動かない敵・眠っている敵・発見済みの罠）の印。増えたら道のりの最短を数え直す（S1b §12.4 の 3） */
  obstacleKeys?: string[];
  /** explore toward: 始めたときの方角・方角に境界が無かった手・遠回りなので近い境界を先にした手（結果の文で理由を言う。S1b §12.4 の 4） */
  towardDir?: Dir | null;
  towardNoAlong?: number;
  towardDetour?: number;
  /** explore toward: draft で、直前の手に下への風が出ていた（風が消えた＝下り階段を自分の目で見たら止まる。S1b §12.4 の 4） */
  hadDraft?: boolean;
  /** fight: 投げる物が尽きたが、隣に追ってくる敵がいるので拾いに行かなかった（S1b §12.4 の 5） */
  retrieveHeld?: boolean;
  /**
   * 動かない敵の隣を避けた遠回り（S1c §14.6 の 1）: 近道（その隣を通る）より extra 歩長い道を選んだ。最短より 10 歩を超えて長く、かつ 2 倍を超えるときだけ。
   * around: 避けた敵（見えていた者の名前と ID）
   */
  detour?: { extra: number; around: { id: string; name: string }[] };
  /** fight の approach: advance で、直前の手の標的が追跡中でなかった（距離を道のりで数える。S1b §12.4 の 7） */
  advanceQuiet?: boolean;
  /** 手数の上限 */
  limit: number;
  /** rest: この HP に達したら止まる */
  untilHp?: number;
  /** rest: この手数で止まる */
  maxTurns?: number;
  /** 開始時の HP とフロア時刻（結果の報告用） */
  startHp: number;
  startTime: number;
  /** 開始時の seq */
  startSeq: number;
  /** 直前の手で見えていた敵の覚醒状態（knownHostiles と同じ集合） */
  aware: Record<string, string>;
  /** 直前の手での自分の状態異常（新しく掛かったものだけで止まる） */
  myStatuses: string[];
  /** このマクロの間に一度でも見た個体（rest: 報告済みの逃走中の個体が出入りしても止まらない） */
  everSeen: string[];
  /** 既知の下り階段の数（steady・careful は初めて見たら止まる） */
  knownDown: number;
  /** wait: 直前の手で隣にいた敵 */
  adjacent: string[];
  /** 直前の手で見えていた予備動作（id:kind。新しく見えたら止まる。V3-3） */
  intents?: string[];
  /** explore: 下への風の方角を優先する */
  toward?: 'draft' | 'sense';
  /** fight: 被弾の記録が無い種族（思い出のキー）。最初の被弾で一度止まる */
  unrecorded?: string[];
}

/** 既知の「自分が投げた物」の位置（セル index） */
function mineCells(view: PlayerView): number[] {
  const f = view.floor!;
  const cells = new Set<number>();
  for (const e of view.entities) if (e.cat === 'item' && e.mine) cells.add(e.pos.y * f.width + e.pos.x);
  for (const r of view.memory.remembered) if (r.cat === 'item' && r.mine) cells.add(r.pos.y * f.width + r.pos.x);
  return [...cells].sort((a, b) => a - b);
}

/**
 * fight の拾いに行く 1 歩（V3-3b §40.1）: 自分が投げた同じ種類の品のうち、追跡中の敵（逃走中を除く）の隣を通らずに届く物へ。
 * 届く物が無ければ null
 */
function retrieveStep(view: PlayerView, catalog: Catalog, pos: Pos, hostiles: readonly EntityView[], kind: string): Dir | null {
  const f = view.floor;
  if (!f) return null;
  const grid = buildNavGrid(view, catalog);
  if (!grid) return null;
  const danger = new Set<number>();
  for (const h of hostiles) {
    if (h.awareness !== 'hunting' || h.fleeing) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = h.pos.x + dx, y = h.pos.y + dy;
      if (x >= 0 && y >= 0 && x < f.width && y < f.height) danger.add(y * f.width + x);
    }
  }
  const goals = new Set<number>();
  for (const e of view.entities) if (e.cat === 'item' && e.mine && e.kind === kind) goals.add(e.pos.y * f.width + e.pos.x);
  for (const r of view.memory.remembered) if (r.cat === 'item' && r.mine && r.kind === kind) goals.add(r.pos.y * f.width + r.pos.x);
  const here = pos.y * f.width + pos.x;
  const safeGoals = [...goals].filter((i) => !danger.has(i) && !grid.occupied[i] && i !== here);
  if (!safeGoals.length) return null;
  const passable = grid.passable.slice();
  for (const i of danger) if (i !== here) passable[i] = 0;
  const path = findPath({ ...grid, passable }, pos, safeGoals, 'strict');
  if (!path || !path.length) return null;
  return dirBetween(pos, path[0]);
}

/** 既知の「自分が投げた物」の個数 */
export function mineCount(view: PlayerView): number {
  let n = 0;
  const seen = new Set<string>();
  for (const e of view.entities) if (e.cat === 'item' && e.mine) { n += e.qty ?? 1; seen.add(e.id); }
  for (const r of view.memory.remembered) if (r.cat === 'item' && r.mine && !seen.has(r.id)) n += r.qty;
  return n;
}

/**
 * 同じか劣る装備（V3-2R3 §20.6）: 鑑定済みで、装備中の品と種類が同じで、接辞が装備中の品の接辞に含まれる（性能が同じか下）
 */
export function sameOrWorseEquip(view: PlayerView, catalog: Catalog, it: { kind: string | null; affixes?: readonly string[] }): boolean {
  if (!it.kind) return false;
  const slot = catalog.items[it.kind]?.slot;
  if (!slot) return false;
  const eqId = view.self.equip[slot];
  const eq = eqId ? view.inventory.find((i) => i.id === eqId) : undefined;
  if (!eq || eq.kind !== it.kind) return false;
  return (it.affixes ?? []).every((a) => eq.affixes.includes(a));
}

/** ダイスの平均の 2 倍（"2d4+1" → 2×5 + 2 = 12。整数で比べる） */
function diceAvg2(d: string): number {
  const m = /^(\d+)d(\d+)([+-]\d+)?$/.exec(d.replace(/\s/g, ''));
  if (!m) return 0;
  return Number(m[1]) * (Number(m[2]) + 1) + 2 * Number(m[3] ?? 0);
}

/**
 * 種類が違っても、公開の数字が装備中の品以下の装備（V3-4b §28.7）。鑑定済みで接辞の無い武器・防具だけを比べる
 * （防具は装甲、武器はダメージのダイスの平均。装備中の品の数字は接辞込み）。装飾品・接辞付き・未鑑定は比べない
 */
export function worseEquip(view: PlayerView, catalog: Catalog, it: { kind: string | null; affixes?: readonly string[] }): boolean {
  if (!it.kind || (it.affixes ?? []).length) return false;
  const ci = catalog.items[it.kind];
  if (!ci?.slot || (ci.slot !== 'weapon' && ci.slot !== 'armor')) return false;
  const eqId = view.self.equip[ci.slot];
  const eq = eqId ? view.inventory.find((i) => i.id === eqId) : undefined;
  const eci = eq?.kind ? catalog.items[eq.kind] : undefined;
  if (!eq || !eci) return false;
  const mods = eq.affixes.reduce((a, id) => {
    const m = catalog.affixes[id]?.itemMods;
    return { armor: a.armor + (m?.armor ?? 0), dmg: a.dmg + (m?.dmgBonus ?? 0) };
  }, { armor: 0, dmg: 0 });
  if (ci.slot === 'armor') return !!ci.armorStats && !!eci.armorStats && ci.armorStats.armor <= eci.armorStats.armor + mods.armor;
  return !!ci.weapon && !!eci.weapon && diceAvg2(ci.weapon.dmg) <= diceAvg2(eci.weapon.dmg) + 2 * mods.dmg;
}

/** マクロが拾ってよいアイテムか（遺物・鑑定済みの有害品・同じか劣る装備は拾わない。useful なら種類の違う劣る装備も）。
 *  有害品でも、投げて使える品（毒薬など）は拾う（V3-5a 後の AI 評価: 毒に弱い守護者を倒す鍵の毒薬を collect が拾わなかった） */
function pickable(view: PlayerView, catalog: Catalog, it: { kind: string | null; role?: string; affixes?: readonly string[] }, knownAffixes: boolean, useful: boolean): boolean {
  if (it.role === 'relic') return false;
  if (it.kind && catalog.items[it.kind]?.harmful && catalog.items[it.kind]?.throwRange == null) return false;
  if (knownAffixes && sameOrWorseEquip(view, catalog, it)) return false;
  if (useful && knownAffixes && worseEquip(view, catalog, it)) return false;
  return true;
}

/** collect の what（S1c §14.4 の 6）: 省くと thrown。ただし kinds を付けて what を省いたら items（品の種類で絞るのは、品を拾うときだけなので） */
export function collectWhatOf(cmd: { what?: 'thrown' | 'items'; kinds?: readonly string[] }): 'thrown' | 'items' {
  return cmd.what ?? (cmd.kinds?.length ? 'items' : 'thrown');
}

/** collect の歩数の上限の既定（V3-8 §53.4） */
export const COLLECT_WITHIN = 15;

/**
 * マクロの経路の地図と経路の引き方（V4-1a §12.1 で collect の件数と共有する）。
 * 気づいていない守護者の 2 マス以内（travel・collect・explore）と動かない敵の隣を避け、steady・flee は逃走中の敵のマスも最後に通れるものとする。
 * stationaryMem: この呼び出しの間に一度見た動かない敵（見えなくなっても避け続ける）
 */
export function macroRouting(view: PlayerView, catalog: Catalog, kind: MacroState['kind'], mode: MacroMode, stationaryMem: readonly Pos[] | undefined, sleepersMem?: MacroState['sleepers']): { grid: NavGrid; route: (goals: readonly number[]) => Pos[] | null; stationary: Pos[]; sleepers: NonNullable<MacroState['sleepers']>; nearRoute: (goals: readonly number[]) => Pos[] | null } {
  const pos = view.self.pos!;
  const hostiles = view.entities.filter((e) => e.cat === 'monster');
  const grid = buildNavGrid(view, catalog)!;
  // 気づいていない・眠っている守護者の 2 マス以内は、ほかに道があれば通らない（V3-3b §40.7: flee の経路が大守護者のそばを通った）
  if (kind === 'travel' || kind === 'collect' || kind === 'explore') {
    const quiet = hostiles.filter((h) => h.role === 'guardian' && h.awareness !== 'hunting');
    if (quiet.length) {
      const hazard = grid.hazard.slice();
      for (const h of quiet) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = h.pos.x + dx, y = h.pos.y + dy;
        if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) hazard[y * grid.width + x] = 1;
      }
      grid.hazard = hazard;
    }
  }
  // 動かない敵の隣は罠と同じく避ける（V3-2R2 §18.5）。この呼び出しの間に一度見た敵は、見えなくなっても避け続ける
  // （見えると遠回り・見えないと近道、を繰り返して 2 マスの間を往復した。AI 評価 2026-11-17 の後の bot の計測）
  const vis = new Set(view.visibleCells);
  const seenNow = view.entities.filter((e) => e.cat === 'monster' && isStationary(catalog, e)).map((e) => e.pos);
  // 見えているマスに、もういない（倒した）なら忘れる
  const kept = (stationaryMem ?? []).filter((q) => !vis.has(q.y * grid.width + q.x) || seenNow.some((s) => s.x === q.x && s.y === q.y)).map((q) => ({ x: q.x, y: q.y }));
  for (const s of seenNow) if (!kept.some((q) => q.x === s.x && q.y === s.y)) kept.push({ x: s.x, y: s.y });
  for (const q of kept) for (const d of DIRS) {
    const nx = q.x + DIR_VEC[d][0], ny = q.y + DIR_VEC[d][1];
    if (nx >= 0 && ny >= 0 && nx < grid.width && ny < grid.height) grid.hazard[ny * grid.width + nx] = 1;
  }
  // 動かない敵の隣を避けない近道（S1c §14.6 の 1: 遠回りの大きさを文で言うため。経路そのものは今までどおり避ける）。罠のマスは避けたまま
  const hazardNear = grid.hazard.slice();
  {
    const trapAt = new Set([...view.entities.filter((e) => e.cat === 'trap').map((e) => e.pos), ...view.memory.remembered.filter((r) => r.cat === 'trap').map((r) => r.pos)].map((p) => p.y * grid.width + p.x));
    for (const q of kept) for (const d of DIRS) {
      const nx = q.x + DIR_VEC[d][0], ny = q.y + DIR_VEC[d][1];
      const i = ny * grid.width + nx;
      if (nx >= 0 && ny >= 0 && nx < grid.width && ny < grid.height && !trapAt.has(i)) hazardNear[i] = 0;
    }
  }
  // 眠っている敵（S1b §12.4 の 3・4）: この呼び出しの間に眠っているのを見た敵は、見えなくなってもそのマスをふさいでいるものとする。
  // 起きているのが見えた・そのマスが見えていなくなっていた（動いた・倒した）なら忘れる
  const sleepers: NonNullable<MacroState['sleepers']> = [];
  const visMon = new Map(view.entities.filter((e) => e.cat === 'monster').map((e) => [e.id, e]));
  for (const s of sleepersMem ?? []) {
    if (visMon.has(s.id)) continue;
    if (vis.has(s.y * grid.width + s.x)) continue;
    sleepers.push({ ...s });
  }
  // 気づいていないが動かない敵（持ち場を離れない守護者）も、眠っている敵と同じに覚える（S1c §14.6 の 3）
  for (const e of visMon.values()) if (e.awareness === 'asleep' || (e.awareness === 'unaware' && e.role === 'guardian')) sleepers.push({ id: e.id, kind: e.kind, x: e.pos.x, y: e.pos.y, ...(e.role === 'guardian' ? { guardian: true as const } : {}) });
  for (const s of sleepers) if (!visMon.has(s.id)) grid.occupied[s.y * grid.width + s.x] = 1;
  // 覚えている（いま見えていない）気づいていない守護者は、見えているときと同じに 2 マス以内を避ける（travel・collect・explore）
  if (kind === 'travel' || kind === 'collect' || kind === 'explore') {
    for (const s of sleepers) {
      if (!s.guardian || visMon.has(s.id)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = s.x + dx, y = s.y + dy;
        if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) grid.hazard[y * grid.width + x] = 1;
      }
    }
  }
  // steady・flee は、ほかに道が無ければ逃走中の敵のマスも通れるものとして経路を引く（ふさいでいれば攻撃して進む。V3-2R3 §20.6）
  const fleeGrid = (() => {
    if (mode !== 'steady' && mode !== 'flee') return null;
    const fl = hostiles.filter((h) => h.fleeing);
    if (!fl.length) return null;
    const occupied = grid.occupied.slice();
    for (const h of fl) occupied[h.pos.y * grid.width + h.pos.x] = 0;
    return { ...grid, occupied };
  })();
  const route = (goals: readonly number[]): Pos[] | null =>
    findPath(grid, pos, goals, 'strict') ?? findPath(grid, pos, goals, 'actors')
    ?? (fleeGrid ? findPath(fleeGrid, pos, goals, 'strict') ?? findPath(fleeGrid, pos, goals, 'actors') : null);
  const nearGrid = { ...grid, hazard: hazardNear };
  const nearRoute = (goals: readonly number[]): Pos[] | null => (kept.length ? findPath(nearGrid, pos, goals, 'strict') ?? findPath(nearGrid, pos, goals, 'actors') : null);
  return { grid, route, stationary: kept, sleepers, nearRoute };
}

/**
 * 引数なしの collect（what: items）が拾いに行く品の ID（V4-1a §12.1）: collect の既定の範囲（COLLECT_WITHIN 歩・既定の種類）の内側で、
 * collect と同じ経路で着ける品（足元の見えている品を含む。敵や仲間が乗っている品は、乗っている間は拾えないので数えない）。
 * 観測の navigation.collectable と、valid_actions の collect の件数に使う（出ているのに collect が断る、を無くす）
 */
export function collectTargets(view: PlayerView, catalog: Catalog): string[] {
  if (!view.floor || !view.self.pos) return [];
  const list = collectableItems(view, catalog, { skipItems: [], pickUseful: true });
  if (!list.length) return [];
  const { grid, route } = macroRouting(view, catalog, 'collect', 'careful', undefined);
  const here = view.self.pos.y * grid.width + view.self.pos.x;
  const out: string[] = [];
  for (const x of list) {
    if (x.cell === here) { if (view.entities.some((e) => e.id === x.id)) out.push(x.id); continue; }
    if (grid.occupied[x.cell]) continue;
    const path = route([x.cell]);
    if (path && path.length <= COLLECT_WITHIN) out.push(x.id);
  }
  return out;
}

/**
 * collect what=items の拾う品（V3-8 §53.4）: 種類の絞り込み（種類 ID か区分）と、鑑定済みで今の装備より劣る装備を飛ばす
 * （記憶の品は種類の素の性能で比べる。all なら劣る装備も拾う）
 */
function collectableItems(view: PlayerView, catalog: Catalog, state: Pick<MacroState, 'skipItems' | 'pickUseful' | 'collectKinds' | 'collectAll'>): { id: string; cell: number }[] {
  const list = pickableItems(view, catalog, state.skipItems, !state.collectAll && state.pickUseful !== false);
  const kinds = state.collectKinds;
  const kindOf = (id: string) => view.entities.find((e) => e.id === id)?.kind ?? view.memory.remembered.find((r) => r.id === id)?.kind ?? null;
  // 未鑑定の品は種類が伏せてあるので、外見の区分（potion・scroll・amulet・ring）で比べる（S1c §14.4 の 6: kinds に potion を渡すと未鑑定の薬が「回収する物が無い」）
  const appOf = (id: string) => view.entities.find((e) => e.id === id)?.appearanceId ?? view.memory.remembered.find((r) => r.id === id)?.appearanceId ?? null;
  const visible = new Set(view.entities.map((e) => e.id));
  return list.filter((x) => {
    const k = kindOf(x.id);
    const app = k ? null : appOf(x.id);
    const cat = k ? catalog.items[k]?.category : app ? catalog.appearances[app]?.category : undefined;
    if (kinds && !((k && kinds.includes(k.replace(/^core:/, ''))) || (cat && kinds.includes(cat)))) return false;
    if (!state.collectAll && k && !visible.has(x.id) && catalog.items[k]?.slot && sameOrWorseEquip(view, catalog, { kind: k, affixes: [] })) return false;
    return true;
  });
}

/** 見えている・記憶しているアイテムのうち拾ってよいもの（id とセル）。useful（既定）なら種類の違う劣る装備も外す（V3-4b §28.7） */
export function pickableItems(view: PlayerView, catalog: Catalog, skip: readonly string[] = [], useful = true): { id: string; cell: number }[] {
  const f = view.floor;
  if (!f) return [];
  if (view.inventory.filter((i) => !(i.kind && catalog.items[i.kind]?.bound)).length >= view.self.capacity) return [];
  const out = new Map<string, number>();
  for (const e of view.entities) if (e.cat === 'item' && pickable(view, catalog, e, true, useful) && !skip.includes(e.id)) out.set(e.id, e.pos.y * f.width + e.pos.x);
  // 記憶の中のアイテムは接辞が分からないので、装備の比較はしない
  const visible = new Set(view.entities.map((e) => e.id));
  for (const r of view.memory.remembered) if (r.cat === 'item' && !visible.has(r.id) && !out.has(r.id) && pickable(view, catalog, r, false, useful) && !skip.includes(r.id)) out.set(r.id, r.pos.y * f.width + r.pos.x);
  return [...out.entries()].map(([id, cell]) => ({ id, cell })).sort((a, b) => a.cell - b.cell || (a.id < b.id ? -1 : 1));
}

function hostileIds(view: PlayerView): string[] {
  return view.entities.filter((e) => e.cat === 'monster').map((e) => e.id);
}

function itemIds(view: PlayerView): string[] {
  return [
    ...view.entities.filter((e) => e.cat === 'item').map((e) => e.id),
    ...view.memory.remembered.filter((r) => r.cat === 'item').map((r) => r.id),
  ];
}

function stairsCount(view: PlayerView, catalog: Catalog): number {
  let n = 0;
  for (const t of view.memory.terrain) if (t && catalog.terrain[view.terrainTable[t]]?.stairs) n++;
  return n;
}

function downStairsCount(view: PlayerView, catalog: Catalog): number {
  let n = 0;
  for (const t of view.memory.terrain) if (t && catalog.terrain[view.terrainTable[t]]?.stairs === 'down') n++;
  return n;
}

/** 投げられる品の射程（分からなければ null） */
function throwRangeOf(view: PlayerView, catalog: Catalog, slot: string): number | null {
  const it = view.inventory.find((i) => i.slot === slot);
  if (!it?.kind || it.equipped) return null;
  return catalog.items[it.kind]?.throwRange ?? null;
}

/** その方角と隣り合う 2 方角 */
/** explore の風の方角: 方角を問わない近くの境界より、これより多く遠回りになる風の方角の境界は後回し（V4-0b §1.4。計測で 8・12・20 を比べて 12） */
const DRAFT_DETOUR = 12;

export function nearDirs(d: Dir): Dir[] {
  const i = DIRS.indexOf(d);
  return [d, DIRS[(i + 1) % DIRS.length], DIRS[(i + DIRS.length - 1) % DIRS.length]];
}

/** その種族（守護者は別）から被弾した記録がある（fight は記録の無い種族の出現でだけ止まる。V3-4b §28.4） */
function hasHitRecord(view: PlayerView, h: EntityView, catalog?: Catalog): boolean {
  if (!h.kind) return false;
  const mem = view.monsterMemory[memoryKey(h.kind, h.role)];
  // 3 体以上倒した種族は、被弾の記録が無くても記録ありとして扱う（V3-3a §35.6: 何度も倒したジャッカルのたびに止まった）
  return (mem?.maxDamageToYou ?? 0) > 0 || (mem?.kills ?? 0) >= (catalog?.rules.fightRecordedKills ?? 3);
}

/** until: 'clear' の次の相手: 隣にいる追跡中の敵、いなければ最も近い追跡中の敵（逃走中を除く。動かない敵は隣にいるときだけ） */
function nextFightTarget(view: PlayerView, catalog: Catalog, pos: Pos, exclude: string | undefined): EntityView | null {
  const cands = view.entities.filter((e) => e.cat === 'monster' && e.id !== exclude && e.awareness === 'hunting' && !e.fleeing
    && (!isStationary(catalog, e) || cheb(e.pos, pos) <= 1));
  cands.sort((a, b) => cheb(a.pos, pos) - cheb(b.pos, pos) || (a.id < b.id ? -1 : 1));
  return cands[0] ?? null;
}

function retarget(state: MacroState, next: EntityView): void {
  state.fightTarget = next.id;
  state.targetSeenAt = { x: next.pos.x, y: next.pos.y };
  state.engaged = false;
  state.waits = 0;
  state.apart = 0;
  state.blocked = 0;
  state.lostTurns = 0;
  state.targetFleeing = !!next.fleeing;
  delete state.lastDist;
  state.noCloser = 0;
}

/** 動かない種族（公開のタグ） */
export function isStationary(catalog: Catalog, e: Pick<EntityView, 'kind'>): boolean {
  return !!e.kind && !!catalog.monsters[e.kind]?.tags.includes('stationary');
}

const HP_FLOOR_PCT: Record<string, number> = { careful: 0, steady: 50, flee: 25, fight: 50 };

export function macroStart(view: PlayerView, cmd: Command, catalog: Catalog): MacroState {
  const rules = catalog.rules;
  const kind = cmd.type as MacroState['kind'];
  const withSlot = cmd.type === 'fight' ? cmd.with : undefined;
  // with は品の種類でもよい（V3-3b §40.1）。種類なら所持品の先頭の同じ種類、無ければ（全部投げた）種類だけ覚える
  const withEntry = (w: string): { with: string; kind: string | null } => {
    const ka = w.length > 1 ? (w.startsWith('core:') ? w : `core:${w}`) : undefined;
    const it = ka ? view.inventory.find((i) => i.kind === ka) : view.inventory.find((i) => i.slot === w);
    return { with: w, kind: it ? (it.kind ?? it.appearanceId) : (ka ?? null) };
  };
  const withList = withSlot ? [withSlot, ...(cmd.type === 'fight' ? cmd.alsoWith ?? [] : [])].map(withEntry) : [];
  const mode: MacroMode = (cmd.type === 'explore' || cmd.type === 'travel' || cmd.type === 'collect') ? (cmd.mode ?? 'careful') : 'careful';
  const floorPct = kind === 'fight' ? HP_FLOOR_PCT.fight : HP_FLOOR_PCT[mode];
  const explicitFloor = 'hpFloor' in cmd ? cmd.hpFloor : undefined;
  const itemTarget = cmd.type === 'travel' && typeof cmd.to === 'string' && cmd.to.startsWith('e_')
    && (view.entities.some((e) => e.id === cmd.to && e.cat === 'item') || view.memory.remembered.some((r) => r.id === cmd.to && r.cat === 'item'));
  const st: MacroState = {
    kind,
    target: cmd.type === 'travel' ? cmd.to : undefined,
    mode,
    hpFloor: explicitFloor ?? ((): number => {
      const d = Math.trunc((view.self.stats.maxHp * floorPct) / 100);
      // 逃げ（flee）は、始める時点ですでに既定の hp_floor 以下なら 0（V3-5a 後の AI 評価: HP 7/36 で逃げのマクロが拒否された）
      return mode === 'flee' && kind !== 'fight' && view.self.stats.hp <= d ? 0 : d;
    })(),
    pickup: cmd.type === 'explore' ? (cmd.pickup ?? 'useful') !== false : cmd.type === 'travel' ? (cmd.pickup ?? itemTarget) !== false : cmd.type === 'collect' ? collectWhatOf(cmd) === 'items' : false,
    pickUseful: !((cmd.type === 'explore' || cmd.type === 'travel') && cmd.pickup === true),
    collectWhat: cmd.type === 'collect' ? collectWhatOf(cmd) : 'thrown',
    ...(cmd.type === 'collect' ? { collectWithin: cmd.within ?? COLLECT_WITHIN, ...(cmd.kinds?.length ? { collectKinds: cmd.kinds.map((k) => k.replace(/^core:/, '')) } : {}), ...(cmd.all ? { collectAll: true } : {}) } : {}),
    ...(cmd.type === 'fight' ? {
      fightTarget: cmd.target, engaged: false, waits: 0, apart: 0, blocked: 0,
      fightUntil: cmd.until ?? 'target', fightAdjacent: cmd.adjacent ?? 'stop', fightApproach: cmd.approach ?? 'wait', lostTurns: 0, cleared: 0,
      ...(cmd.lostOk ? { lostOk: true } : {}),
      ...(() => { const tg = view.entities.find((e) => e.id === cmd.target); return tg ? { targetFleeing: !!tg.fleeing, targetSeenAt: { x: tg.pos.x, y: tg.pos.y } } : {}; })(),
    } : {}),
    ...(withSlot ? { fightWith: withSlot, fightKind: withList[0].kind, fightRetrieve: cmd.type === 'fight' ? cmd.retrieve !== false : true, ...(withList.length > 1 ? { fightWithList: withList } : {}) } : {}),
    ...(cmd.type === 'fight' && cmd.collectAfter ? { collectAfter: true } : {}),
    ...(cmd.type === 'fight' && cmd.abilities?.length ? (() => {
      const r = resolveFightAbilities(view, catalog, cmd.abilities, withSlot);
      return { fightAbilities: r.ids, ...(r.error ? { fightAbilityError: r.error } : {}) };
    })() : {}),
    floorKey: view.floor?.key ?? '',
    lastHp: view.self.stats.hp,
    knownHostiles: hostileIds(view),
    // 守護者として見た種族も見た種族（思い出のキーは guardian|種族。V3-7 の評価: 大守護者が見えるたびに steady が止まった）
    knownKinds: [...new Set([...Object.values(view.monsterMemory).map((m) => m.kind), ...view.entities.filter((e) => e.cat === 'monster' && e.kind).map((e) => e.kind!)])],
    knownItems: itemIds(view),
    knownStairs: stairsCount(view, catalog),
    steps: 0,
    skipItems: [],
    limit: cmd.type === 'rest' ? (rules?.restMaxTurns ?? 400) : (rules?.macroStepLimit ?? MACRO_STEP_LIMIT),
    startHp: view.self.stats.hp,
    startTime: view.floor?.time ?? 0,
    startSeq: view.seq,
    aware: Object.fromEntries(view.entities.filter((e) => e.cat === 'monster').map((e) => [e.id, e.awareness ?? 'unaware'])),
    myStatuses: view.self.statuses.map((s) => s.id),
    everSeen: hostileIds(view),
    ...(cmd.type === 'explore' && cmd.toward ? { toward: cmd.toward } : {}),
    ...(cmd.type === 'fight' ? {
      unrecorded: view.entities.filter((e) => e.cat === 'monster' && e.kind && !hasHitRecord(view, e, catalog)).map((e) => memoryKey(e.kind!, e.role)),
    } : {}),
    knownDown: downStairsCount(view, catalog),
    adjacent: view.self.pos ? view.entities.filter((e) => e.cat === 'monster' && cheb(e.pos, view.self.pos!) <= 1).map((e) => e.id) : [],
    intents: intentKeys(view),
  };
  if (cmd.type === 'wait') st.maxTurns = cmd.turns ?? 1;
  if (cmd.type === 'explore' && cmd.maxSteps !== undefined) st.maxTurns = cmd.maxSteps;
  if (cmd.type === 'rest') {
    if (cmd.untilHp !== undefined) st.untilHp = cmd.untilHp;
    if (cmd.maxTurns !== undefined) st.maxTurns = cmd.maxTurns;
  }
  return st;
}

function resolveTravelGoal(view: PlayerView, catalog: Catalog, target: TravelTarget): { goals: number[]; adjacentOk: boolean } | null {
  const f = view.floor!;
  if (typeof target === 'object') {
    if (target.x < 0 || target.y < 0 || target.x >= f.width || target.y >= f.height) return null;
    const i = target.y * f.width + target.x;
    if (!view.memory.terrain[i]) return null;
    return { goals: [i], adjacentOk: false };
  }
  if (target === 'stairs_down' || target === 'stairs_up') {
    const want = target === 'stairs_down' ? 'down' : 'up';
    const goals: number[] = [];
    view.memory.terrain.forEach((t, i) => {
      if (t && catalog.terrain[view.terrainTable[t]]?.stairs === want) goals.push(i);
    });
    return goals.length ? { goals, adjacentOk: false } : null;
  }
  const e = view.entities.find((x) => x.id === target);
  if (e) return { goals: [e.pos.y * f.width + e.pos.x], adjacentOk: e.cat === 'monster' || e.cat === 'player' || e.cat === 'feature' };
  const r = view.memory.remembered.find((x) => x.id === target);
  // 地物（祭壇・泉・レバーなど）は隣に着けば到着（V3-8a §56.1 の 5。隣か足元で interact する）
  if (r) return { goals: [r.pos.y * f.width + r.pos.x], adjacentOk: r.cat === 'feature' };
  return null;
}

/** dir: trap_ahead のとき、罠のマスの方角（踏むなら move { dir }） */
/** blockedBy: じゃまをしている見えている敵（hostile_adjacent・blocked。V4-1a §12.3。拒否のエラーの details.blocked_by と hint の名前） */
/** traps: trap_ahead のとき、道の上の発見済みの罠（近い順。V4-1d §18.1。拒否のエラーの details.blocked_by_traps と hint の名前・位置） */
/** explored（S3a §27.6 の 7）: toward_exhausted で、その階に行ける未探索の境界がもう 1 つも無い（探索し終えている） */
/** obstacle: unreachable のとき、分かっている地図の上で道をふさいでいる地形（閉じた格子扉・鍵のかかった格子扉・本棚・瓦礫。S4 §42.3 の 2。拒否のエラーの details.blocked_by_terrain と hint） */
export type MacroDecision = { command: Command } | { stop: MacroStop; dir?: Dir; blockedBy?: { id: string; name: string }[]; traps?: MacroTrap[]; explored?: boolean; obstacle?: MacroObstacle };
/** 道をふさいでいる発見済みの罠（V4-1d §18.1） */
export interface MacroTrap { id: string; kind: string; name: string; pos: Pos }
/** 道をふさいでいる地形（S4 §42.3 の 2）: 地形の ID・名前・位置 */
export interface MacroObstacle { kind: string; name: string; pos: Pos }

/** 道をふさぐことのある地形（開ける・押す・どける必要がある。壁・柱は入らない）の印（地形のタグ） */
const OBSTACLE_TAGS: readonly string[] = ['grate', 'pushable', 'obstacle'];

/**
 * 道をふさいでいる地形（S4 §42.3 の 2）: 分かっている地図（プレイヤーの知っている地形だけ）の上で、格子扉・本棚・瓦礫を通れるものとして道を引き直し、
 * その道の上の最初のもの。そうしても届かない・そうした地形が道に無ければ null（すべてのプレイヤーに同じ。品ごとの道は計算しない）
 */
export function terrainBlockOn(view: PlayerView, catalog: Catalog, grid: NavGrid, from: Pos, goals: readonly number[]): MacroObstacle | null {
  if (!goals.length) return null;
  const passable = Uint8Array.from(grid.passable);
  const cells = new Set<number>();
  for (let i = 0; i < passable.length; i++) {
    if (passable[i] || !grid.known[i]) continue;
    const tid = view.terrainTable[view.memory.terrain[i] ?? 0];
    const tr = tid ? catalog.terrain[tid] : undefined;
    if (tr && OBSTACLE_TAGS.some((tag) => tr.tags.includes(tag))) { passable[i] = 1; cells.add(i); }
  }
  if (!cells.size) return null;
  const path = findPath({ ...grid, passable }, from, [...goals], 'none');
  const c = path?.find((p) => cells.has(p.y * grid.width + p.x));
  if (!c) return null;
  const tid = view.terrainTable[view.memory.terrain[c.y * grid.width + c.x]];
  return { kind: tid, name: nameOf(catalog.terrain[tid]?.name, view.locale, tid), pos: { x: c.x, y: c.y } };
}

/**
 * 次の基本行動を決める。events は直前の手で知覚したイベント（中断判定用）。
 * state は破壊的に更新される。
 */
/** 見えている予備動作（id:kind） */
/**
 * 動かない敵の隣を避けた遠回り（S1c §14.6 の 1）を覚える: 選んだ道が、その隣を通る近道より 10 歩を超えて長く、かつ 2 倍を超えるとき。
 * 呼び出しの間で、いちばん大きいものを残す（結果の文で、何を避けて何歩遠回りしたかを言う）
 */
/** 往復で止まる（S3c §33.3 の 2）。直近 window 手に近道をふさいだ動く敵がいれば、名指す */
function noProgress(state: MacroState, window: number): MacroDecision {
  const by = new Map<string, { id: string; name: string }>();
  for (const f of state.routeFoes ?? []) if (f.step > state.steps - window) by.set(f.id, { id: f.id, name: f.name });
  if (by.size) state.noProgressBy = [...by.values()];
  return { stop: 'no_progress' };
}

/** 選んだ道が、敵を無視した近道より長い: 近道の上にいる動く敵（逃げていない）を、道を変えさせた相手として覚える */
function noteRouteFoes(state: MacroState, view: PlayerView, catalog: Catalog, grid: NavGrid, pos: Pos, path: readonly Pos[], hostiles: readonly EntityView[]): void {
  const movers = hostiles.filter((h) => !isStationary(catalog, h) && !h.fleeing && h.awareness !== 'asleep');
  if (!movers.length || !path.length) return;
  const last = path[path.length - 1];
  const loose = findPath(grid, pos, [last.y * grid.width + last.x], 'none');
  if (!loose || loose.length >= path.length) return;
  const onPath = new Set(path.map((c) => c.y * grid.width + c.x));
  const list = state.routeFoes ?? [];
  for (const h of movers) {
    const i = h.pos.y * grid.width + h.pos.x;
    if (onPath.has(i) || !loose.some((c) => c.x === h.pos.x && c.y === h.pos.y)) continue;
    const at = list.findIndex((f) => f.id === h.id);
    const rec = { id: h.id, name: kindName(catalog, view.locale, h.kind), step: state.steps };
    if (at >= 0) list[at] = rec; else list.push(rec);
  }
  if (list.length) state.routeFoes = list.slice(-8);
}

function noteDetour(state: MacroState, view: PlayerView, catalog: Catalog, path: readonly Pos[], near: readonly Pos[] | null): void {
  if (!near || !(path.length > near.length + 10 && path.length > near.length * 2)) return;
  const extra = path.length - near.length;
  if (state.detour && state.detour.extra >= extra) return;
  const around = view.entities.filter((e) => e.cat === 'monster' && isStationary(catalog, e) && near.some((c) => cheb(c, e.pos) <= 1))
    .map((e) => ({ id: e.id, name: kindName(catalog, view.locale, e.kind) }));
  state.detour = { extra, around };
}

/** 見えている予備動作のうち、自分のマスを的にしたもの（大振りのマス・突進の直線の 6 マス以内）があるか（S1c §14.4 の 3） */
export function intentOnMe(view: PlayerView, pos: Pos): boolean {
  return view.entities.some((e) => {
    if (e.cat !== 'monster' || !e.intent) return false;
    if (e.intent.kind === 'swinging' && e.intent.pos) return e.intent.pos.x === pos.x && e.intent.pos.y === pos.y;
    if (e.intent.kind === 'winding_up' && e.intent.dir) {
      for (let k = 1; k <= 6; k++) if (e.pos.x + DIR_VEC[e.intent.dir][0] * k === pos.x && e.pos.y + DIR_VEC[e.intent.dir][1] * k === pos.y) return true;
    }
    return false;
  });
}

function intentKeys(view: PlayerView): string[] {
  return view.entities.filter((e) => e.cat === 'monster' && e.intent).map((e) => `${e.id}:${e.intent!.kind}`);
}

/** 足元の目的の品を拾ってから止まる、の対象にしない止まり方（V3-8a §56.1: HP・被弾の前の停止・予備動作と、もう動けないもの） */
const NO_PICK_STOPS: ReadonlySet<MacroStop> = new Set<MacroStop>(['hp_floor', 'hp_risk', 'intent', 'run_ended', 'dead', 'left_board', 'time_up', 'not_your_turn', 'floor_changed', 'error']);

/**
 * マクロの最初の一歩の見込み（S5c）: RunSession が手番を使わずに断るか（最初の一歩で止まるか）の判定と、valid_actions がその行を出すかの判定は、
 * これ 1 つ（「できること」に出ているのに断られる、を作らない。explore toward:draft・toward:sense）
 */
export function macroProbe(view: PlayerView, cmd: Command, catalog: Catalog): { state: MacroState; decision: MacroDecision } {
  const state = macroStart(view, cmd, catalog);
  return { state, decision: macroNext(state, view, catalog, []) };
}

export function macroNext(state: MacroState, view: PlayerView, catalog: Catalog, events: readonly ProjectedEvent[]): MacroDecision {
  // 拾う 1 手を挟んだ後は、そのときの理由で止まる
  if (state.pendingStop) { const s = state.pendingStop; delete state.pendingStop; return { stop: s }; }
  const d = macroStep(state, view, catalog, events);
  if (!('stop' in d) || NO_PICK_STOPS.has(d.stop)) return d;
  // collect（what: items）と、品を目的地にした travel_to: 品のマスに着いた手番に止まるなら、拾ってから止まる（V3-8a §56.1）
  if (view.status !== 'your_turn' || !view.floor || !view.self.pos || view.floor.key !== state.floorKey) return d;
  const here = view.self.pos.y * view.floor.width + view.self.pos.x;
  const visible = (id: string) => view.entities.some((e) => e.id === id && e.cat === 'item');
  let pick: string | undefined;
  if (state.kind === 'collect' && state.collectWhat === 'items') pick = collectableItems(view, catalog, state).find((x) => x.cell === here && visible(x.id))?.id;
  else if (state.kind === 'travel' && typeof state.target === 'string') {
    const t = view.entities.find((e) => e.id === state.target && e.cat === 'item');
    if (t && t.pos.y * view.floor.width + t.pos.x === here) pick = t.id;
  }
  if (!pick || state.skipItems.includes(pick)) return d;
  state.skipItems.push(pick);
  state.steps += 1;
  state.pendingStop = d.stop;
  return { command: { type: 'pickup', item: pick } };
}

function macroStep(state: MacroState, view: PlayerView, catalog: Catalog, events: readonly ProjectedEvent[]): MacroDecision {
  if (view.runStatus === 'ended') return { stop: 'run_ended' };
  if (view.status === 'dead') return { stop: 'dead' };
  if (view.status === 'at_camp') return { stop: 'left_board' };
  if (view.status !== 'your_turn') return { stop: 'not_your_turn' };
  if (!view.floor || !view.self.pos) return { stop: 'error' };
  if (view.floor.key !== state.floorKey) return { stop: 'floor_changed' };
  const me = view.self;
  const pos: Pos = me.pos!;
  const hp = me.stats.hp;
  const maxHp = Math.max(1, me.stats.maxHp);
  const mode = state.mode;
  const kind = state.kind;
  const ev = (type: string, f: (e: Record<string, unknown>) => boolean) => events.some((e) => e.type === type && f(e as unknown as Record<string, unknown>));
  // 決着（V3-3c §44.6）: collect_after なら、追跡中の敵（逃走中を除く）が見えていなければ自分の投擲物を拾う（collect と同じ止まり方）。
  // 拾い終えたら決着の理由で止まる。拾い始められなければ（隣に敵・拾う物が無い）そのまま決着で止まる
  const finishFight = (stop: MacroStop): MacroDecision => {
    if (!state.collectAfter || view.entities.some((h) => h.cat === 'monster' && h.awareness === 'hunting' && !h.fleeing)) return { stop };
    state.kind = 'collect';
    state.collectWhat = 'thrown';
    state.mode = 'careful';
    state.hpFloor = 0;
    state.pickup = false;
    state.fightDone = stop;
    state.knownHostiles = hostileIds(view);
    state.aware = Object.fromEntries(view.entities.filter((e) => e.cat === 'monster').map((e) => [e.id, e.awareness ?? 'unaware']));
    state.trail = [];
    delete state.goal;
    const d = macroNext(state, view, catalog, []);
    return 'stop' in d ? { stop } : d;
  };

  // 中断条件（最初の 1 手の前は判定しない項目もある）
  if (state.steps > 0) {
    const attacked = ev('attack', (e) => e.target === me.id);
    // 新しく掛かった状態異常だけ（掛かっている毒の延長・掛け直し、この呼び出しの中で一度掛かった状態の付き直しでは止まらない）。
    // 自分の特技が付けた状態（構え）と、いまの自分には効き目の無い修正（装甲 0 での錆）でも止まらない（V3-5a 後の AI 評価）
    const status = ev('status_applied', (e) => {
      const st = (e.status as { id?: string; source?: string | null }) ?? {};
      if (e.target !== me.id || !st.id || state.myStatuses.includes(st.id)) return false;
      if (st.source === me.id) return false;
      // 能力値の修正（錆）では止まらない（状態は観測と変化の欄に出る。V3-7a 後の評価: 錆が付くたびに止まった）
      if (catalog.statuses[st.id]?.armor !== undefined) return false;
      return true;
    });
    // 継続ダメージ（毒）は careful でも止めない（HP のしきい値をまたぐまで）
    const hurt = ev('damaged', (e) => e.target === me.id && e.via !== 'poison');
    if (kind === 'rest') {
      // 毒の継続ダメージでは止まらない（毒が抜けるまで休む。rest_estimate の文と同じ）
      if (hurt) return { stop: 'damaged' };
      if (attacked) return { stop: 'attacked' };
      if (status) return { stop: 'status_changed' };
    } else if (kind === 'fight') {
      if (ev('died', (e) => e.id === state.fightTarget)) {
        if (state.fightUntil !== 'clear') return finishFight('target_down');
        state.cleared = (state.cleared ?? 0) + 1;
        const next = nextFightTarget(view, catalog, pos, state.fightTarget);
        if (!next) return finishFight('cleared');
        retarget(state, next);
      }
      if (status) return { stop: 'status_changed' };
      // 待つ手番に、標的以外の射撃で被弾した: 1 回で止まる（撃たれ続けない。V3-4b §28.4）
      if (state.waited && ev('damaged', (e) => e.target === me.id && (e.via === 'ranged' || e.via === 'thrown') && e.source !== state.fightTarget)) return { stop: 'shot_while_waiting' };
      // 待つ手番に、標的以外の隣の敵に殴られた: until: clear ならその敵へ、そうでなければ止まる（V3-7a 後の評価: 4 手番待つ間に 19 被弾）
      if (state.waited) {
        const hitter = events.find((e) => e.type === 'attack' && (e as unknown as { target?: string }).target === me.id && (e as unknown as { attacker?: string }).attacker !== state.fightTarget && !(e as unknown as { ranged?: boolean }).ranged) as unknown as { attacker?: string } | undefined;
        const near = hitter?.attacker ? view.entities.find((h) => h.id === hitter.attacker && h.cat === 'monster' && cheb(h.pos, pos) <= 1) : undefined;
        if (hitter && state.fightUntil === 'clear' && near) retarget(state, near);
        else if (hitter) return { stop: 'hit_while_waiting' };
      }
      // 待つ手番に標的に殴られたのに、標的が隣にいない（当てて離れる速い相手）: 待ち続けずに止まる（V3-3 後の AI 評価: 10 手番待つ間に 9 回殴られた）
      if (state.waited && ev('attack', (e) => e.attacker === state.fightTarget && e.target === me.id)) {
        const t0 = view.entities.find((h) => h.id === state.fightTarget);
        // その場で撃つ相手（骨の射手。V3-8 §53.4）は離れないので、当てて離れる相手と分ける
        const shot = ev('attack', (e) => e.attacker === state.fightTarget && e.target === me.id && !!(e as unknown as { ranged?: boolean }).ranged);
        if (!t0 || cheb(t0.pos, pos) > 1) return { stop: shot ? 'target_shooting' : 'hit_and_run' };
      }
      // 被弾の記録が無い種族から初めて被弾した: 数字を見てから続けるかを決められるよう一度止まる（V3-2R3 §20.4）
      const firstHit = events.find((e) => {
        const x = e as unknown as Record<string, unknown>;
        if (e.type !== 'damaged' || x.target !== me.id || typeof x.sourceKind !== 'string') return false;
        const src = view.entities.find((h) => h.id === x.source);
        return (state.unrecorded ?? []).includes(memoryKey(x.sourceKind, src?.role));
      });
      if (firstHit) {
        const x = firstHit as unknown as Record<string, unknown>;
        const src = view.entities.find((h) => h.id === x.source);
        const key = memoryKey(x.sourceKind as string, src?.role);
        state.unrecorded = (state.unrecorded ?? []).filter((k) => k !== key);
        // 小さい初被弾では止めない（最大 HP の firstHitStopPct % 未満。記録は付けて続ける。V3-3a §35.6）
        const amount = typeof x.amount === 'number' ? x.amount : 0;
        if (amount * 100 >= maxHp * (catalog.rules.fightFirstHitStopPct ?? 0)) return { stop: 'first_hit' };
      }
    } else if (mode === 'steady' && (kind === 'explore' || kind === 'travel' || kind === 'collect')) {
      // 始めてからの被害の合計が最大 HP の 4 分の 1 を超えたら止まる（V3-8a §56.1。毒も数える。1 回ずつは小さい射撃が積み重なる）
      let got = 0;
      for (const e of events) {
        const x = e as unknown as { type: string; target?: string; amount?: number };
        if (x.type === 'damaged' && x.target === me.id && typeof x.amount === 'number') got += x.amount;
      }
      state.damageTaken = (state.damageTaken ?? 0) + got;
      if (state.damageTaken * 4 > maxHp) return { stop: 'damage_taken' };
    } else if (mode === 'careful') {
      if (attacked) return { stop: 'attacked' };
      if (hurt) return { stop: 'damaged' };
      if (status) return { stop: 'status_changed' };
      // HP が 50%・25% をまたいだ
      for (const pct of [50, 25]) {
        const line = Math.trunc((maxHp * pct) / 100);
        if (state.lastHp > line && hp <= line) return { stop: 'hp_threshold' };
      }
    }
  }
  // hp_floor ちょうども止まる（V3-2R3 §20.4）
  if ((kind === 'fight' || mode === 'steady' || mode === 'flee') && kind !== 'rest' && hp <= state.hpFloor) return { stop: 'hp_floor' };

  const hostiles = view.entities.filter((e) => e.cat === 'monster');
  // じゃまをしている敵（V4-1a §12.3）: 見えている敵だけ（view.entities は視界の判定を通った者だけ）
  const blockersOf = (hs: readonly EntityView[]) => hs.map((h) => ({ id: h.id, name: kindName(catalog, view.locale, h.kind) }));
  // この呼び出しの間に眠っているのを見た、いま見えていない敵も（S1b §12.4 の 3。道を引くときにふさいでいるものとした敵）
  const blockersOn = (cells: readonly Pos[] | null) => [
    ...blockersOf(cells ? hostiles.filter((h) => cells.some((c) => c.x === h.pos.x && c.y === h.pos.y)) : []),
    ...(cells ? (state.sleepers ?? []).filter((s) => !hostiles.some((h) => h.id === s.id) && cells.some((c) => c.x === s.x && c.y === s.y)).map((s) => ({ id: s.id, name: kindName(catalog, view.locale, s.kind) })) : []),
  ];
  // 届かない: 分かっている地図の上で道をふさいでいる地形があれば添える（S4 §42.3 の 2。travel_to・collect・fight の advance）
  const unreachable = (g: NavGrid, goals: readonly number[]): MacroDecision => {
    const obstacle = terrainBlockOn(view, catalog, g, pos, goals);
    return obstacle ? { stop: 'unreachable', obstacle } : { stop: 'unreachable' };
  };
  // 予備動作（V3-3 §3.1）: 見えている敵が新しく予備動作を見せたら、どのマクロも止まる（次の手番に大きな行動が来る）
  const intents = intentKeys(view);
  const newIntent = state.steps > 0 && intents.some((k) => !(state.intents ?? []).includes(k));
  state.intents = intents;
  if (newIntent) return { stop: 'intent' };
  // fight: 自分を的にした予備動作（大振りのマス・突進の直線）が見えている間は、続けて殴らない（S1c §14.4 の 3: 始めたときから見えていた構えは
  // 「新しく」ならないので、朦朧で大振りが遅れた間も殴り続け、4 手目に大振りを受けた）。始めの 1 手は、構えを見て決めた手として出す
  if (kind === 'fight' && state.steps > 0 && intentOnMe(view, pos)) return { stop: 'intent' };
  const before = new Set(state.knownHostiles);
  const pursuing = (h: EntityView) => h.awareness === 'hunting' && !h.fleeing;
  // 自分に届く: 動かない種族は隣にいるときだけ
  const reaches = (h: EntityView) => !isStationary(catalog, h) || cheb(h.pos, pos) <= 1;
  const newKind = (h: EntityView) => !!h.kind && !state.knownKinds.includes(h.kind);
  // 自分より遅く、射撃しない敵（V4-0b §1.4）
  const slowChaser = (h: EntityView) => h.speed !== undefined && h.speed < view.self.speed && !(h.kind && catalog.monsters[h.kind]?.tags.includes('ranged'));
  // 止まらずに続けた遅い追跡者が 2 マス以内に来たら止まる（隣なら hostile_adjacent）
  if (kind === 'explore' && mode === 'careful' && state.slowChasers?.length
    && hostiles.some((h) => state.slowChasers!.includes(h.id) && pursuing(h) && cheb(h.pos, pos) === 2)) return { stop: 'chaser_near' };
  for (const h of hostiles) {
    const isNew = !before.has(h.id);
    if (kind === 'rest') {
      // 報告済みの個体が逃げながら視界を出入りしても止まらない（V3-2R2 §18.5）
      if (isNew && !(h.fleeing && state.everSeen.includes(h.id))) return { stop: 'hostile_in_view' };
    } else if (kind === 'wait') {
      if (isNew) return { stop: 'hostile_in_view' };
    } else if (kind === 'fight') {
      // 被弾の記録がある種族の追跡中の敵が新しく見えても止まらない。止めるのは記録の無い種族だけ（V3-4b §28.4）
      if (isNew && h.id !== state.fightTarget && pursuing(h) && reaches(h) && !hasHitRecord(view, h, catalog)) return { stop: 'hostile_in_view' };
      if (isNew && h.kind && !hasHitRecord(view, h, catalog)) {
        const key = memoryKey(h.kind, h.role);
        if (!(state.unrecorded ?? []).includes(key)) state.unrecorded = [...(state.unrecorded ?? []), key];
      }
    } else if (mode === 'careful') {
      // 初見の種族、追跡中で届く敵の出現、見えている敵が追跡に変わった
      if (newKind(h)) return { stop: 'hostile_in_view' };
      // explore は、自分より遅く 3 マス以上離れた追跡中の敵（射撃しない）では止まらずに続ける（V4-0b §1.4: 遅い石皮の甲虫に追われているだけで止まった）
      const slowFar = kind === 'explore' && slowChaser(h) && cheb(h.pos, pos) >= 3;
      const appeared = isNew && pursuing(h) && reaches(h);
      const alerted = !isNew && state.aware[h.id] !== 'hunting' && pursuing(h) && reaches(h);
      if ((appeared || alerted) && slowFar) { if (!(state.slowChasers ?? []).includes(h.id)) state.slowChasers = [...(state.slowChasers ?? []), h.id]; continue; }
      if (appeared) return { stop: 'hostile_in_view' };
      if (alerted) return { stop: 'hostile_alerted' };
    } else if (mode === 'steady') {
      if (newKind(h)) return { stop: 'hostile_in_view' };
    }
  }
  state.knownHostiles = hostiles.map((h) => h.id);
  for (const h of hostiles) if (!state.everSeen.includes(h.id)) state.everSeen.push(h.id);
  state.aware = Object.fromEntries(hostiles.map((h) => [h.id, h.awareness ?? 'unaware']));
  state.myStatuses = [...new Set([...state.myStatuses, ...me.statuses.map((s) => s.id)])];
  for (const h of hostiles) if (h.kind && !state.knownKinds.includes(h.kind)) state.knownKinds.push(h.kind);

  // 待つ（wait { turns }）: 敵が見えた・隣に来た・被害で止まる
  if (kind === 'wait') {
    const adjNow = hostiles.filter((h) => cheb(h.pos, pos) <= 1 && h.awareness !== 'asleep').map((h) => h.id);
    if (state.steps > 0 && adjNow.some((id) => !state.adjacent.includes(id))) return { stop: 'hostile_adjacent' };
    state.adjacent = adjNow;
    state.lastHp = hp;
    if (state.steps >= (state.maxTurns ?? 1)) return { stop: 'max_turns' };
    state.steps += 1;
    return { command: { type: 'wait' } };
  }

  // 戦う（V3-2R2 §18.5）: 隣の相手を殴り続ける／そのスロットの品を投げ続ける。追跡中で届かない相手は待つ
  if (kind === 'fight') {
    if (state.fightAbilityError) return { stop: state.fightAbilityError === 'unknown' ? 'ability_unknown' : state.fightAbilityError === 'needs_with' ? 'ability_needs_with' : 'ability_not_allowed' };
    if (state.steps >= state.limit) return { stop: 'step_limit' };
    // 被弾の前に止まる（V3-2R3 §20.4）: 次の手番に届く追跡中の敵（隣・飛び道具）の被害の見込みを受けると hp_floor を割るなら止まる
    // 隣にいる逃走中の敵も数える（追い詰められると殴ってくる。V3-5a 後の AI 評価: 逃走中の小悪魔に殴られ続けて hp_floor を割った）
    // 見込みは、いちばん重い 1 体を記録の最大の一撃、残りを記録の平均の被害にした合計（S1c §14.4 の 1。全員が最大の一撃の「最悪」は文に並べる）
    // S1d §17.2: 死にうる（HP が最悪以下）なら hp_floor によらず止まり、hp_floor の判定は見込み（いちばん重い 1 体は会心でない最大の一撃）で
    const risk = threatEstimate(view, catalog, fightThreats(catalog, hostiles, pos));
    if (fightRiskStop(hp, state.hpFloor, risk)) return { stop: 'hp_risk' };
    state.lastHp = hp;
    state.waited = false;
    const wait = (): MacroDecision => { state.steps += 1; state.waited = true; return { command: { type: 'wait' } }; };
    let tg = hostiles.find((h) => h.id === state.fightTarget);
    if (!tg && state.fightUntil === 'clear') {
      // 標的が見えない: 届く追跡中の別の敵がいれば、そちらへ（隣にいる敵を待つ間に殴らせない）
      const next = nextFightTarget(view, catalog, pos, state.fightTarget);
      if (next) { retarget(state, next); tg = next; }
    }
    if (!tg) {
      // 最後に見た場所: 見えなくなる一歩の行き先が分かっていれば（草へ入るのを見ていた。V4-0c §4.2）そこ
      for (const e of events) {
        const x = e as unknown as { type: string; id?: string; to?: Pos | null };
        if (x.type === 'entity_moved' && x.id === state.fightTarget && x.to) state.targetSeenAt = { x: x.to.x, y: x.to.y };
      }
      // 見失った（V3-4b §28.4）: 逃げて見えなくなったなら止まる。追跡中で逃げていなかったなら、物陰から出てくるまで待つ
      if (state.targetFleeing === true) return { stop: 'target_fled' };
      if (state.targetFleeing === undefined && !state.lostOk) return { stop: 'target_gone' };
      // 待つのは最大 fightLostWait 手番（5）。ほかに届く追跡中の敵が見えている・この手番に被害を受けたなら待たない（V4-0b §1.4）
      if ((state.lostTurns ?? 0) >= (catalog.rules.fightLostWait ?? 5)) return { stop: 'target_gone' };
      if (hostiles.some((h) => h.id !== state.fightTarget && pursuing(h) && reaches(h))) return { stop: 'target_gone' };
      if (events.some((e) => e.type === 'damaged' && (e as unknown as { target?: string }).target === me.id)) return { stop: 'target_gone' };
      state.lostTurns = (state.lostTurns ?? 0) + 1;
      return wait();
    }
    state.lostTurns = 0;
    state.targetFleeing = !!tg.fleeing;
    state.targetSeenAt = { x: tg.pos.x, y: tg.pos.y };
    const d = cheb(tg.pos, pos);
    const hunting = tg.awareness === 'hunting';
    // with の相手が隣に来た: adjacent に従う（stop: 止まる / throw: 隣でも投げる / melee: 近接に切り替える）
    const throwing = !!state.fightWith && !(d <= 1 && state.fightAdjacent === 'melee');
    if (throwing && state.fightWith) {
      // 投げる品: 同じ種類の品（拾ってスロットが変わっても続ける。V3-3b §40.1）。種類が分からなければスロット。
      // 並びがあれば前から順に: 尽きたら、追跡中の敵の隣を通らずに届く自分の投擲物（同じ種類）を拾いに行き（踏めば拾う）、それも無ければ次の品（V3-3c §44.6）
      const list = state.fightWithList ?? [{ with: state.fightWith, kind: state.fightKind ?? null }];
      // 隣に追ってくる敵がいる間は、拾いに行かない（離れる 1 歩で背を向ける。S1b §12.4 の 5: adjacent: throw で隣の大守護者に投げるはずが、床の投げ槍へ歩いた）
      const adjPursuer = hostiles.some((h) => pursuing(h) && cheb(h.pos, pos) <= 1);
      let it: ItemView | undefined;
      for (const w of list) {
        const found = w.kind ? view.inventory.find((i) => (i.kind ?? i.appearanceId) === w.kind) : view.inventory.find((i) => i.slot === w.with);
        if (found) { it = found; state.fightWith = w.with; state.fightKind = w.kind; break; }
        const step = state.fightRetrieve !== false && w.kind && !adjPursuer ? retrieveStep(view, catalog, pos, hostiles, w.kind) : null;
        if (step) { state.steps += 1; state.retrieved = (state.retrieved ?? 0) + 1; return { command: { type: 'move', dir: step } }; }
        if (state.fightRetrieve !== false && w.kind && adjPursuer && retrieveStep(view, catalog, pos, hostiles, w.kind)) state.retrieveHeld = true;
      }
      if (!it) return { stop: 'out_of_ammo' };
      const slot = it.slot;
      const range = throwRangeOf(view, catalog, slot);
      if (range === null) return { stop: 'not_throwable' };
      if (d <= 1 && state.fightAdjacent !== 'throw') return { stop: 'target_adjacent' };
      if (tg.shot && d <= range) {
        state.blocked = 0;
        state.steps += 1;
        // 狙い撃ち（載せていて使えるなら。V3-4a §25.3）
        const aimed = (state.fightAbilities ?? []).find((id) => catalog.abilities[id]?.handler === 'aimed_throw' && abilityReady(view, catalog, id));
        if (aimed) return { command: { type: 'ability', id: aimed, target: tg.id, slot } };
        return { command: { type: 'throw', slot, target: tg.id } };
      }
      // 射程外か射線なし: 追跡中で近づいてくるなら待つ
      if (tg.fleeing && d > range) return { stop: 'target_moved' };
      if (!hunting) return { stop: 'target_not_hunting' };
      if (!tg.shot) {
        state.blocked = (state.blocked ?? 0) + 1;
        if (state.blocked >= FIGHT_BLOCKED_MAX) return { stop: 'no_line_of_sight' };
      }
      if ((state.waits ?? 0) >= FIGHT_WAIT_MAX || isStationary(catalog, tg)) return { stop: 'target_not_approaching' };
      state.waits = (state.waits ?? 0) + 1;
      return wait();
    }
    if (d <= 1) {
      state.engaged = true;
      state.apart = 0;
      const dir = dirBetween(pos, tg.pos);
      if (!dir) return { stop: 'error' };
      state.steps += 1;
      // 載せた能動技（V3-4a §25.3）: なぎ払いは起きている敵が隣に 2 体以上、強打は標的が隣にいて使える手番に。条件を満たさなければ通常の攻撃
      const abil = state.fightAbilities ?? [];
      const awakeAdj = hostiles.filter((h) => cheb(h.pos, pos) <= 1 && h.awareness !== 'asleep').length;
      const cleave = abil.find((id) => catalog.abilities[id]?.handler === 'cleave' && abilityReady(view, catalog, id));
      if (cleave && awakeAdj >= 2) return { command: { type: 'ability', id: cleave } };
      const strike = abil.find((id) => catalog.abilities[id]?.handler === 'strike' && abilityReady(view, catalog, id));
      if (strike) return { command: { type: 'ability', id: strike, target: tg.id } };
      return { command: { type: 'move', dir } };
    }
    // 長柄（V3-4 §4.4）: 直線で 2 マス先、間のマスが通れて誰もいなければ、そこから突く
    if (d === 2 && weaponReach(view, catalog) >= 2 && reachMidOpen(view, catalog, pos, tg.pos)) {
      state.engaged = true;
      state.apart = 0;
      state.steps += 1;
      return { command: { type: 'attack', target: tg.id } };
    }
    if (state.engaged && state.fightApproach !== 'advance') {
      // 当てて逃げる相手: 追跡中で 2 マス以内なら 2 手番まで待つ（追わない）
      if (hunting && !tg.fleeing && d <= 2 && (state.apart ?? 0) < FIGHT_APART_MAX) { state.apart = (state.apart ?? 0) + 1; return wait(); }
      return { stop: 'target_moved' };
    }
    // 迎え撃つ: 追跡中の相手が隣に来るまで待つ（最大 FIGHT_WAIT_MAX 手番。3 回続けて近づかなければ止まる）
    // 眠っている・気づいていない相手は待たない。approach: 'advance' なら寄って殴る（S1b §12.4 の 7: 眠っている守護者に断られて 1 歩ずつ寄っていた）
    if (!hunting && state.fightApproach !== 'advance') return { stop: 'target_not_hunting' };
    if (tg.fleeing) return { stop: 'target_moved' };
    // 寄っていく（approach: 'advance'。V4-1a §12.5）: 相手の隣のマスへ歩き、着いたら殴る。歩く間に撃たれても止まらない
    // （hp_risk・hp_floor・新しい敵・予備動作・状態異常・見失いの止まり方は上で効く）。3 手番続けて近づけなければ target_moved。
    // 途中で気づかれたら、そのまま追跡中の相手への advance として続ける（S1b §12.4 の 7）
    if (state.fightApproach === 'advance') {
      const g = buildNavGrid(view, catalog)!;
      const goals: number[] = [];
      for (const dd of DIRS) {
        const nx = tg.pos.x + DIR_VEC[dd][0], ny = tg.pos.y + DIR_VEC[dd][1];
        if (nx >= 0 && ny >= 0 && nx < g.width && ny < g.height && g.passable[ny * g.width + nx]) goals.push(ny * g.width + nx);
      }
      const path = findPath(g, pos, goals, 'strict') ?? findPath(g, pos, goals, 'actors');
      // 近づいたかは、追跡中の相手なら直線の距離、動かない（眠っている・気づいていない）相手なら道のりで数える
      // （壁を回る間に直線の距離が縮まず、寄れているのに止まらないように）。追跡中に変わったら数え直す
      const quiet = !hunting;
      if (state.advanceQuiet !== undefined && state.advanceQuiet !== quiet) { delete state.lastDist; state.noCloser = 0; }
      state.advanceQuiet = quiet;
      const dm = quiet ? (path ? path.length : d + 1000) : d;
      state.noCloser = state.lastDist !== undefined && dm >= state.lastDist ? (state.noCloser ?? 0) + 1 : 0;
      state.lastDist = dm;
      if (state.noCloser >= FIGHT_NO_CLOSER_MAX) return { stop: 'target_moved' };
      if (!path || !path.length) {
        const loose = findPath(g, pos, goals, 'none');
        return loose ? { stop: 'blocked', blockedBy: blockersOn(loose) } : unreachable(g, goals);
      }
      const dir = dirBetween(pos, path[0]);
      if (!dir) return { stop: 'error' };
      state.steps += 1;
      return { command: { type: 'move', dir } };
    }
    if ((state.waits ?? 0) >= FIGHT_WAIT_MAX || isStationary(catalog, tg)) return { stop: 'target_not_approaching' };
    state.noCloser = state.lastDist !== undefined && d >= state.lastDist ? (state.noCloser ?? 0) + 1 : 0;
    state.lastDist = d;
    if (state.noCloser >= FIGHT_NO_CLOSER_MAX) return { stop: 'target_not_approaching' };
    state.waits = (state.waits ?? 0) + 1;
    return wait();
  }

  // 同じ 2 マスを往復している（A→B→A→B→A）: 止まる（V3-3 後の bot の計測: travel が 200 手往復し、1 回で約 1 万件のイベントを出した）
  if (kind === 'travel' || kind === 'explore' || kind === 'collect') {
    const tr = state.trail ?? [];
    tr.push(pos.y * 100000 + pos.x);
    if (tr.length > 6) tr.shift();
    state.trail = tr;
    const n = tr.length;
    if (n >= 5 && tr[n - 1] !== tr[n - 2] && tr[n - 1] === tr[n - 3] && tr[n - 3] === tr[n - 5] && tr[n - 2] === tr[n - 4]) return noProgress(state, 6);
  }
  // 隣の敵: careful は起きている敵（逃走中を除く）、steady は追跡中の敵がいれば動かない。flee は動く。
  // 足元に拾う品があれば、止まる前に拾う（1 手番。品の上に着いたのに拾わずに止まった。V3-5a 後の AI 評価）
  const feetPick = (): MacroDecision | null => {
    if (!state.pickup || !view.floor) return null;
    const cell = pos.y * view.floor.width + pos.x;
    const it = pickableItems(view, catalog, state.skipItems, state.pickUseful !== false).find((x) => x.cell === cell && view.entities.some((e) => e.id === x.id));
    if (!it) return null;
    state.skipItems.push(it.id);
    state.steps += 1;
    return { command: { type: 'pickup', item: it.id } };
  };
  if (kind !== 'rest') {
    const adjCareful = hostiles.filter((h) => cheb(h.pos, pos) <= 1 && h.awareness !== 'asleep' && !h.fleeing);
    if (mode === 'careful' && adjCareful.length) return feetPick() ?? { stop: 'hostile_adjacent', blockedBy: blockersOf(adjCareful) };
    const adjSteady = hostiles.filter((h) => cheb(h.pos, pos) <= 1 && pursuing(h));
    if (mode === 'steady' && adjSteady.length) return feetPick() ?? { stop: 'hostile_adjacent', blockedBy: blockersOf(adjSteady) };
  }
  // 休憩: 自分に届く追跡中の敵（動かない敵は隣接していなければ妨げない）
  if (kind === 'rest' && hostiles.some((h) => pursuing(h) && reaches(h))) return { stop: 'hostile_in_view' };
  // 階段を見つけて止まる前に、足元の拾える品を拾う（1 手番。次の判断で止まる）
  const pickHere = (): MacroDecision | null => {
    if (!state.pickup || !view.floor) return null;
    const cell = pos.y * view.floor.width + pos.x;
    const it = pickableItems(view, catalog, state.skipItems, state.pickUseful !== false).find((x) => x.cell === cell && view.entities.some((e) => e.id === x.id));
    if (!it) return null;
    state.skipItems.push(it.id);
    state.steps += 1;
    return { command: { type: 'pickup', item: it.id } };
  };
  if (kind === 'explore' && mode === 'careful' && stairsCount(view, catalog) > state.knownStairs) return pickHere() ?? { stop: 'stairs_seen' };
  // その階の下り階段を初めて見た（踏破の判断の起点。steady も止まる。flee は止まらない。V3-2R2 §18.5）
  const downNow = downStairsCount(view, catalog);
  if (kind !== 'rest' && mode !== 'flee' && state.knownDown === 0 && downNow > 0) return pickHere() ?? { stop: 'stairs_seen' };
  // explore toward: draft で下への風が消えた（公開された階段を自分の目で見た。地図に載っていたので上の「初めて知った」では止まらない）:
  // 風の方角を失って、ほかの方角の探索を続けていた（S1b §12.4 の 4。試運転 t0: 階段の脇を通り過ぎて 30 歩西へ）
  if (kind === 'explore' && state.toward === 'draft' && view.floorHint) {
    const draftNow = !!view.floorHint.draft;
    if (mode !== 'flee' && state.steps > 0 && state.hadDraft && !draftNow) return pickHere() ?? { stop: 'stairs_seen' };
    state.hadDraft = draftNow;
  }
  state.knownDown = downNow;
  state.knownStairs = stairsCount(view, catalog);
  state.knownItems = itemIds(view);
  state.lastHp = hp;

  if (kind === 'rest') {
    const poisoned = me.statuses.some((s) => s.id === 'core:poison');
    if (hp >= me.stats.maxHp && !poisoned) return { stop: 'full_hp' };
    if (state.untilHp !== undefined && hp >= state.untilHp && !poisoned) return { stop: 'target_hp' };
    // 休憩で戻るのは最大 HP の rest.capPct % まで（それより上は薬・立て直し・泉・レベルアップ・キャンプで。V3-4b §28.3）
    if (hp >= restCapHp(catalog.rules, me.stats.maxHp) && !poisoned) return { stop: 'rest_cap' };
    if (state.maxTurns !== undefined && state.steps >= state.maxTurns) return { stop: 'max_turns' };
    if (state.steps >= state.limit) return { stop: 'step_limit' };
    state.steps += 1;
    return { command: { type: 'wait' } };
  }
  if (state.steps >= state.limit) return { stop: 'step_limit' };
  // explore の手数の上限（max_steps。S1b §12.4 の 9: 予算のあるシーズンで 1 回が 130 手番になった）
  if (kind === 'explore' && state.maxTurns !== undefined && state.steps >= state.maxTurns) return { stop: 'max_turns' };

  const routing = macroRouting(view, catalog, kind, mode, state.stationary, state.sleepers);
  const grid = routing.grid;
  state.stationary = routing.stationary;
  state.sleepers = routing.sleepers;
  const here = pos.y * grid.width + pos.x;
  const route = routing.route;
  // 発見済みの罠のマス（マクロは踏まない）。射影はそのプレイヤーが見つけた罠しか渡さない（見つけていない罠は view に無い）
  const knownTraps = [
    ...view.entities.filter((e) => e.cat === 'trap').map((e) => ({ id: e.id, kind: e.kind, pos: e.pos })),
    ...view.memory.remembered.filter((r) => r.cat === 'trap').map((r) => ({ id: r.id, kind: r.kind, pos: r.pos })),
  ];
  const trapCells = new Set<number>(knownTraps.map((tr) => tr.pos.y * grid.width + tr.pos.x));
  /** 道の上の発見済みの罠（近い順。同じマスは 1 つ） */
  const trapsOn = (cells: readonly Pos[]): MacroTrap[] => {
    const out: MacroTrap[] = [];
    for (const c of cells) {
      const tr = knownTraps.find((k) => k.pos.x === c.x && k.pos.y === c.y);
      if (tr && !out.some((o) => o.id === tr.id)) out.push({ id: tr.id, kind: tr.kind ?? 'trap', name: kindName(catalog, view.locale, tr.kind), pos: { x: tr.pos.x, y: tr.pos.y } });
    }
    return out;
  };
  const crossesTrap = (p: Pos[] | null) => !!p && p.some((c) => trapCells.has(c.y * grid.width + c.x));
  // 見えて「拾わない」と分かった品（同じか劣る装備・有害品）は、視界を出て記憶に戻っても、この呼び出しの間は行き先にしない
  // （記憶の中の品は接辞が分からないので拾える側に数えられ、見える・見えないの間を往復しないように）
  // （travel_to の目的地に指定した品は除く。明示した行き先は有害品・遺物でも拾う）
  {
    const ok = new Set(pickableItems(view, catalog, [], state.pickUseful !== false).map((x) => x.id));
    for (const e of view.entities) if (e.cat === 'item' && e.id !== state.target && !ok.has(e.id) && !state.skipItems.includes(e.id)) state.skipItems.push(e.id);
  }
  // 足元のアイテムを拾う（通り道と目的地。1 手番）
  if (state.pickup) {
    const items = pickableItems(view, catalog, state.skipItems, state.pickUseful !== false).filter((x) => x.cell === here && view.entities.some((e) => e.id === x.id));
    // travel_to の目的地に指定したアイテムは、有害品・遺物でも拾う（明示した行き先）
    const dest = kind === 'travel' && typeof state.target === 'string' && !state.skipItems.includes(state.target)
      ? view.entities.find((e) => e.id === state.target && e.cat === 'item' && e.pos.y * grid.width + e.pos.x === here) : undefined;
    if (dest && !items.some((x) => x.id === dest.id)) items.unshift({ id: dest.id, cell: here });
    if (items.length) {
      state.skipItems.push(items[0].id);
      state.steps += 1;
      return { command: { type: 'pickup', item: items[0].id } };
    }
  }
  let path: Pos[] | null;
  if (kind === 'explore' && state.toward === 'sense') {
    // 気配の元（遠征の目的の遺物・守護者）が見えた・覚えている: 探索を続けずに止まる（travel_to で向かう。V3-5a 後の AI 評価）。
    // 目的ではない守護者には反応しない（V3-7a 後の評価: 階に残っていた別の守護者で止まった）。
    // 目的でない遺物も数えない（V4-1j §30.5: 覚えているだけで断り、目的の守護者を探しに行けなかった）。目的かどうかは観測の objective（§12.2）
    const xo = view.expedition;
    const isObjectiveGuardian = (e: EntityView) => e.cat === 'monster' && e.role === 'guardian' && !!e.guardian
      && (xo?.objective.type === 'slay_warden' ? !!e.guardian.warden : !!xo?.guardian && e.guardian.name.ja === xo.guardian.name.ja && e.guardian.name.en === xo.guardian.name.en);
    const found = view.entities.some((e) => (e.cat === 'item' && e.role === 'relic' && !!e.objective) || (e.cat === 'monster' && !!e.objective) || isObjectiveGuardian(e))
      || view.memory.remembered.some((r) => r.role === 'relic' && !!r.objective);
    if (found) return { stop: 'sense_found' };
  }
  if (kind === 'explore') {
    // 行き先: 未見の区画との境界（＋拾うなら拾えるアイテム）
    let fr = findFrontiers(grid);
    const allFrontiers = fr;
    // 下への風の方角（と隣り合う方角）の未探索を優先する（V3-2R3 §20.5）
    // toward: draft は下への風、sense は遺物・守護者の気配の方角（V3-4b §28.7。同じ仕組み）
    const draft = state.toward === 'draft' ? view.floorHint?.draft ?? null : state.toward === 'sense' ? view.sense?.dir ?? null : null;
    const nearSet = draft ? new Set<Dir>(nearDirs(draft)) : null;
    const inDraft = (i: number) => { const d = compassDir(pos, { x: i % grid.width, y: Math.trunc(i / grid.width) }); return d !== null && !!nearSet?.has(d); };
    // 結果の文で、方角と違う向きに歩いた理由を言うために数える（S1b §12.4 の 4）
    if (state.toward && state.towardDir === undefined) state.towardDir = draft;
    if (draft) {
      const along = fr.filter(inDraft);
      if (along.length) fr = along;
      // その方角に行ける境界が無い: 止まる（S1c §14.6 の 2。方角を渡すのはその方角へ行きたいから。逃げる flee は今までどおり、ほかの方角の境界へ）
      else if (mode !== 'flee') return { stop: 'toward_exhausted', ...(allFrontiers.length ? {} : { explored: true }) };
      else state.towardNoAlong = (state.towardNoAlong ?? 0) + 1;
    }
    const itemCells = state.pickup && !draft ? pickableItems(view, catalog, state.skipItems, state.pickUseful !== false).map((x) => x.cell) : [];
    const targets = [...new Set([...fr, ...itemCells])];
    if (!targets.length) return { stop: 'explored' };
    path = null;
    // 決めた行き先は、境界である間は追い続ける（風の方角は歩くたびに変わるので、方角の絞り込みで外すと往復する）
    if (state.goal !== undefined && state.goal !== here && (targets.includes(state.goal) || (draft && allFrontiers.includes(state.goal)))) {
      path = route([state.goal]);
      // 追い続ける行き先への道が罠を通るようになったら（罠を見つけた）、選び直す
      if (crossesTrap(path)) path = null;
    }
    // 行き先の境界が見えて消えたら、そのすぐ近くの境界を続けて追う（通路を進むと境界は 1 マスずつ先へ下がる。
    // 方角の絞り込みで選び直すと、通路の先と遠い別の境界の間を往復する）
    if (path === null && draft && state.goal !== undefined) {
      const old = { x: state.goal % grid.width, y: Math.trunc(state.goal / grid.width) };
      // 続けて追うのは、風の方角にある境界だけ（V3-7a 後の評価: 西の境界に着いた後、通路をたどって南東・東へ 16 歩流れた）
      const nearOld = allFrontiers.filter((i) => i !== here && cheb({ x: i % grid.width, y: Math.trunc(i / grid.width) }, old) <= 3 && inDraft(i));
      if (nearOld.length) {
        path = route(nearOld);
        if (crossesTrap(path)) path = null;
        const last = path && path.length ? path[path.length - 1] : null;
        if (last) state.goal = last.y * grid.width + last.x;
      }
    }
    if (path === null) {
      const others = targets.filter((i) => i !== here);
      path = others.length ? route(others) : null;
      // 風の方角の境界が遠回り（方角を問わない近くの境界より DRAFT_DETOUR 歩より遠い）なら、近くを先に見る（V4-0b §1.4: 風の方角は立つ位置で
      // 変わるので、遠い 2 つの境界がかわるがわる風の方角に入り、その間を往復していた。聖域の階で 200 手を 5 回）
      if (draft && path && fr !== allFrontiers) {
        const any = [...new Set([...allFrontiers, ...itemCells])].filter((i) => i !== here);
        const near = any.length ? route(any) : null;
        if (near && near.length + DRAFT_DETOUR < path.length && !crossesTrap(near)) { path = near; state.towardDetour = (state.towardDetour ?? 0) + 1; }
      }
      // 風の方角の境界へは、敵にふさがれた道か罠を通る道しか無い: その方角に行ける境界が無いので止まる（S1c §14.6 の 2）。
      // flee は今までどおり、ほかの境界へ回る（方角の優先は、行ける境界の中での優先）
      if (draft && (path === null || crossesTrap(path)) && fr !== allFrontiers && mode !== 'flee') return { stop: 'toward_exhausted' };
      if (draft && (path === null || crossesTrap(path))) {
        const rest = [...new Set([...allFrontiers, ...itemCells])].filter((i) => i !== here && !others.includes(i));
        const alt = rest.length ? route(rest) : null;
        if (alt && (path === null || !crossesTrap(alt))) { path = alt; state.towardNoAlong = (state.towardNoAlong ?? 0) + 1; }
      }
      const last = path && path.length ? path[path.length - 1] : null;
      state.goal = last ? last.y * grid.width + last.x : undefined;
    }
    if (path === null || path.length === 0) {
      const loose = findPath(grid, pos, targets.filter((i) => i !== here), 'none');
      return loose ? { stop: 'blocked', blockedBy: blockersOn(loose) } : { stop: 'explored' };
    }
  } else if (kind === 'collect') {
    const goals = (state.collectWhat === 'items' ? collectableItems(view, catalog, state).map((x) => x.cell) : mineCells(view)).filter((i) => i !== here);
    // 決着の後に拾っていた（fight の collect_after）: 拾い終えたら決着の理由で止まる
    if (!goals.length) return { stop: state.fightDone ?? 'collected' };
    // 敵が乗っている品は後回し（経路探しは行き先のマスの敵を通すので、いちばん近い品が敵の足元だと 1 歩目でふさがれた。V3-5a 後の AI 評価）
    const free = goals.filter((i) => !grid.occupied[i]);
    path = route(free.length ? free : goals);
    if (path === null) {
      const loose = findPath(grid, pos, goals, 'none');
      return loose ? { stop: 'blocked', blockedBy: blockersOn(loose) } : unreachable(grid, goals);
    }
    if (path.length === 0) return { stop: 'collected' };
    noteDetour(state, view, catalog, path, routing.nearRoute(free.length ? free : goals));
    // 歩数の上限（V3-8 §53.4。いちばん近い品が上限より遠ければ、残りも遠い）
    if (state.collectWithin !== undefined && path.length > state.collectWithin) return { stop: state.fightDone ?? 'collect_far' };
  } else {
    // 目的地のアイテムを拾った（所持品に入った・同じ品の山に重なった）なら到着（V3-5a 後の AI 評価: 重なった薬で「相手が見えなくなった」と出た）
    if (typeof state.target === 'string' && view.inventory.some((i) => i.id === state.target)) return { stop: 'arrived' };
    if (typeof state.target === 'string' && ev('item_picked_up', (e) => e.item === state.target && e.actor === me.id)) return { stop: 'arrived' };
    const goal = resolveTravelGoal(view, catalog, state.target!);
    // 追っていた相手（エンティティ）が見えなくなった
    if (!goal) return { stop: state.steps > 0 && typeof state.target === 'string' && state.target.startsWith('e_') ? 'target_gone' : 'unknown_destination' };
    if (goal.goals.includes(here)) return { stop: 'arrived' };
    if (goal.adjacentOk && goal.goals.some((g) => cheb({ x: g % grid.width, y: Math.trunc(g / grid.width) }, pos) <= 1)) return { stop: 'arrived' };
    path = route(goal.goals);
    if (path === null) {
      const loose = findPath(grid, pos, goal.goals, 'none');
      return loose ? { stop: 'blocked', blockedBy: blockersOn(loose) } : unreachable(grid, goal.goals);
    }
    if (path.length === 0) return { stop: 'arrived' };
    noteDetour(state, view, catalog, path, routing.nearRoute(goal.goals));
    if (goal.adjacentOk && path.length === 1) return { stop: 'arrived' };
    // この呼び出しの間ずっと残る障害（動かない敵・眠っている敵・発見済みの罠）が新しく見えたら、道のりの最短を数え直す
    // （S1b §12.4 の 3: 通路をふさぐ毒カビが見えて遠回りに変わった後、前の短い道のりと比べて 20 手で no_progress になり、往復に見えた）
    // 比べるのは、この呼び出しの間に一度でも見た印（S1c §14.10 の 1: 背の高い草の中で眠る敵は隣でないと見えず、見えた → 空と見えて忘れる → また見える、
    // のたびに「1 手前の印」と比べて数え直していた。20 手の歯止めが効かず、1 回の上限 200 手までさまよえた）
    const keys = [...routing.stationary.map((q) => `s${q.x},${q.y}`), ...routing.sleepers.map((s) => `z${s.x},${s.y}`), ...[...trapCells].map((i) => `t${i}`)];
    if (state.obstacleKeys && keys.some((k) => !state.obstacleKeys!.includes(k))) { delete state.bestLen; delete state.sinceBest; }
    state.obstacleKeys = [...new Set([...(state.obstacleKeys ?? []), ...keys])];
    // 目的地までの道のりが TRAVEL_NO_PROGRESS 手のあいだ一度も縮まなければ止まる（2 マスの往復でない行き来も止める）
    if (state.bestLen === undefined || path.length < state.bestLen) { state.bestLen = path.length; state.sinceBest = 0; }
    else if ((state.sinceBest = (state.sinceBest ?? 0) + 1) >= TRAVEL_NO_PROGRESS) return noProgress(state, TRAVEL_NO_PROGRESS);
  }
  // 動く敵が近道をふさいで、道を変えさせた（S3c §33.3 の 2）: 往復で止まったときに名指すため、覚えておく（決める手は変えない）
  if (kind === 'travel' || kind === 'explore' || kind === 'collect') noteRouteFoes(state, view, catalog, grid, pos, path, hostiles);
  // マクロは発見済みの罠を踏まない: ほかに道が無く、次のマスが罠なら止まる（踏むなら move で）
  if (trapCells.has(path[0].y * grid.width + path[0].x)) return { stop: 'trap_ahead', dir: dirBetween(pos, path[0]) ?? undefined, traps: trapsOn(path) };
  // マクロは攻撃しない: 次のマスに敵がいたら止まる。ただし steady・flee で、ふさいでいる相手が逃走中なら攻撃して進む（V3-2R3 §20.6）
  const blocker = hostiles.find((h) => h.pos.x === path[0].x && h.pos.y === path[0].y);
  if (blocker) {
    if ((mode === 'steady' || mode === 'flee') && blocker.fleeing) {
      const d = dirBetween(pos, path[0]);
      if (!d) return { stop: 'error' };
      state.steps += 1;
      return { command: { type: 'move', dir: d } };
    }
    return { stop: 'blocked', blockedBy: blockersOf([blocker]) };
  }
  const dir = dirBetween(pos, path[0]);
  if (!dir) return { stop: 'error' };
  state.steps += 1;
  return { command: { type: 'move', dir } };
}

/**
 * 1 歩も進めないと分かったマクロの拒否（手番を使わない。V3-2R §14.2「0 歩で終わる呼び出しを作らない」）。
 * 最初の判断が停止なら、その理由をゲームのエラー形式で返す。
 */
export function macroStopError(L: Locale, stop: MacroStop, cmd: Command, dir?: Dir, blockedBy?: readonly { id: string; name: string }[], traps?: readonly MacroTrap[], explored?: boolean, obstacle?: MacroObstacle): ActionError {
  const e = macroStopErrorBase(L, stop, cmd, dir);
  // 届かない（S4 §42.3 の 2）: 分かっている地図の上で道をふさいでいる地形（閉じた格子扉・鍵のかかった格子扉など）を 1 つ、種類と場所で
  if (stop === 'unreachable' && obstacle) {
    const how = obstacle.kind === 'core:grate_locked' ? t(L, '（宝物庫の鍵を持って隣で interact すると開く）', ' (interact next to it with the vault key to open it)')
      : obstacle.kind === 'core:grate_closed' ? t(L, '（つながっているレバーを引くと開く）', ' (pull the lever it is linked to)')
        : obstacle.kind === 'core:bookshelf' ? t(L, '（向こうが空いていれば、押して動かせる）', ' (it can be pushed if the cell beyond is free)') : '';
    return {
      ...e,
      hint: `${t(L, `分かっている地図の上では、${obstacle.name} (${obstacle.pos.x},${obstacle.pos.y}) が道をふさいでいる${how}。`, `On your known map, the ${obstacle.name} at (${obstacle.pos.x},${obstacle.pos.y}) blocks the way${how}. `)}${e.hint}`,
      details: { blocked_by_terrain: { kind: obstacle.kind, pos: { x: obstacle.pos.x, y: obstacle.pos.y } } },
    };
  }
  // 探索し終えた階で toward を渡した（S3a §27.6 の 7）: 止まるのは今のまま。気配の方角へは座標を指して向かう
  if (stop === 'toward_exhausted' && explored) {
    e.message += t(L, ' この階は探索し終えている。', ' This floor has been fully explored.');
    e.hint = t(L, '気配の方角へは、travel_to で座標を指して向かう（self.sense の方角の、覚えている地図のマス）。', 'Head toward the sense with travel_to and a coordinate (a remembered cell in the self.sense direction).');
  }
  // 道をふさいでいる発見済みの罠（V4-1d §18.1）: details.blocked_by_traps と hint の名前・位置
  if (traps?.length && stop === 'trap_ahead') {
    const first = traps[0];
    const more = traps.length > 1 ? t(L, `（この道の先にも ${traps.slice(1).map((tr) => `${tr.name} (${tr.pos.x},${tr.pos.y})`).join('、')}）`, ` (further along: ${traps.slice(1).map((tr) => `${tr.name} (${tr.pos.x},${tr.pos.y})`).join(', ')})`) : '';
    const step = dir ? t(L, `踏むなら move { dir: '${dir}' }。`, `Step on it with move { dir: '${dir}' } if you mean to, `) : t(L, '踏むなら move。', 'Step on it with move if you mean to, ');
    return {
      ...e,
      hint: `${t(L, `${first.name} (${first.pos.x},${first.pos.y}) が道をふさいでいる${more}。`, `The ${first.name} at (${first.pos.x},${first.pos.y}) blocks the way${more}. `)}${step}${t(L, 'ほかの道を探すなら explore。', 'or explore for another way.')}`,
      details: { blocked_by_traps: traps.map((tr) => ({ id: tr.id, kind: tr.kind, pos: { x: tr.pos.x, y: tr.pos.y } })) },
    };
  }
  // じゃまをしている見えている敵（V4-1a §12.3）: details.blocked_by と hint の名前
  if (blockedBy?.length && (stop === 'hostile_adjacent' || stop === 'blocked')) {
    const names = blockedBy.map((b) => `${b.name} ${b.id}`).join(t(L, '、', ', '));
    return { ...e, hint: `${t(L, `じゃまをしている敵: ${names}。`, `In the way: ${names}. `)}${e.hint}`, details: { blocked_by: blockedBy.map((b) => b.id) } };
  }
  return e;
}

function macroStopErrorBase(L: Locale, stop: MacroStop, cmd: Command, dir?: Dir): ActionError {
  const flee = cmd.type === 'travel' || cmd.type === 'explore' || cmd.type === 'collect';
  switch (stop) {
    case 'sense_found':
      return actionError('nothing_to_do', t(L, '気配の元（この遠征の目的の遺物・守護者）はもう見えているか、覚えている。', 'The source of the sense (this expedition\'s relic or guardian) is already in view or remembered.'),
        t(L, 'travel_to { to: <遺物・守護者の ID> } で向かう（get_map で場所を見られる）。', 'Head there with travel_to { to: <relic or guardian id> } (get_map shows where).'));
    case 'hostile_adjacent':
      return actionError('hostile_adjacent', t(L, '隣に起きている敵がいるので、マクロは 1 歩も進めない。', 'An awake enemy is adjacent, so the macro cannot take a step.'),
        flee ? t(L, "振り切るなら mode: 'flee'（追跡中の敵が隣にいても進む。攻撃は受ける）、戦うなら fight { target }。追跡中でない隣の敵なら mode: 'steady' でも進める。", "To shake it off use mode: 'flee' (moves even with a hunter adjacent; you will be attacked); to fight use fight { target }. mode: 'steady' moves on past adjacent enemies that are not hunting you.")
          : t(L, '戦うなら fight { target }、離れるなら move。', 'Use fight { target } to fight, or move to step away.'));
    case 'hostile_in_view':
      return actionError('hostile_in_view', t(L, '追跡中の敵が見えているので始められない。', 'A hunting enemy is in view, so this cannot start.'),
        t(L, "先に対処する（fight・throw_item）か、mode: 'steady' / 'flee' で移動する。", "Deal with it first (fight, throw_item) or move with mode: 'steady' / 'flee'."));
    case 'hp_floor':
      return actionError('hp_floor', t(L, 'HP がすでに hp_floor 以下。', 'HP is already at or below hp_floor.'), t(L, 'hp_floor を下げるか、回復してから。', 'Lower hp_floor or heal first.'));
    case 'hp_risk':
      return actionError('hp_floor', t(L, '被弾の前の判定で止まった（次の手番に、届く敵の最悪の 1 手で倒れうるか、見込みの被害で hp_floor を割る）。', 'Stopped before being hit (one worst turn from enemies in reach could kill you, or the expected damage would drop you below hp_floor).'),
        t(L, 'それでも戦うなら hp_floor を下げる。退くなら mode: flee か帰還の綱。', 'Lower hp_floor to fight anyway, or retreat (mode: flee or the lifeline).'));
    case 'blocked':
      return actionError('blocked', t(L, '既知の経路が敵にふさがれていて進めない（マクロは攻撃しない）。', 'Your known route is blocked by a monster (macros never attack).'), t(L, 'fight で倒すか、別の経路を選ぶ。', 'Use fight, or choose another route.'));
    case 'unreachable':
      return actionError('unreachable', t(L, '既知の経路では到達できない。', 'Unreachable via the known map.'), t(L, 'explore で経路を探す。', 'Explore to find a route.'));
    case 'trap_ahead':
      return actionError('blocked', t(L, '既知の経路は発見済みの罠を通る（マクロは罠を踏まない）。', 'Your known route crosses a discovered trap (macros never step on traps).'),
        dir ? t(L, `踏むなら move { dir: '${dir}' }。ほかの道を探すなら explore。`, `Step on it with move { dir: '${dir}' } if you mean to, or explore for another way.`)
          : t(L, '踏むなら move で 1 歩ずつ。ほかの道を探すなら explore。', 'Step on it with move if you mean to, or explore for another way.'));
    case 'unknown_destination':
      return actionError('unknown_destination', t(L, '行き先が既知の地図に無い。', 'The destination is not on your known map.'), t(L, 'explore で見つけてから。', 'Find it with explore first.'));
    case 'target_fled':
      return actionError('no_target', t(L, 'その相手は逃げて見えなくなった。', 'That target fled out of sight.'), t(L, '追うなら travel_to で最後に見た位置へ。ほかの相手なら visible.monsters の id を指定する。', 'To chase it, travel_to where you last saw it; otherwise give an id from visible.monsters.'));
    case 'target_gone':
      return actionError('no_target', t(L, 'その相手は見えていない。', 'That target is not visible.'), t(L, 'visible.monsters の id を指定する。', 'Give an id from visible.monsters.'));
    case 'target_moved':
      // 見えているが逃げている相手（V4-0b §1.5: 直前の観測に見えていたのに「見えていない」と読めた）。fight の近接は逃げる相手を待たない
      return actionError('no_target', t(L, 'その相手は見えているが、逃げている（近接の fight は逃げる相手を待たない）。', 'That target is in view but fleeing (melee fight does not wait for a fleeing target).'),
        t(L, '追うなら travel_to { to: <id> }。投擲が届くなら fight { target, with }（逃げる相手にも投げる）。', 'Chase it with travel_to { to: <id> }, or if a throw reaches, fight { target, with } (throws at fleeing targets too).'));
    case 'target_not_hunting':
      return actionError('no_target', t(L, 'その相手はまだあなたを追っていない（眠っている・気付いていない）。fight は追跡中の相手を待つ。', 'That target is not hunting you yet (asleep or unaware). fight waits only for hunting targets.'),
        t(L, "寄って殴るなら fight { target, approach: 'advance' }（隣まで歩いて殴る。途中で気づかれても、そのまま戦う）。先手を取るなら throw_item。", "To walk up and strike, use fight { target, approach: 'advance' } (walks next to it and attacks; keeps fighting if it wakes). Or open with throw_item."));
    case 'target_not_approaching':
      return actionError('no_target', t(L, 'その相手は動かないので、待っても近づいてこない。', 'That target does not move, so waiting will not bring it closer.'), t(L, 'travel_to で隣へ行くか、投擲で戦う（fight { target, with }）。', 'Walk next to it with travel_to, or fight it with throws (fight { target, with }).'));
    case 'target_adjacent':
      return actionError('blocked', t(L, '相手は隣にいる（投擲の fight は隣に来た相手には止まる）。', 'The target is adjacent (throwing fight stops once it is next to you).'), t(L, '近接で戦うなら fight { target }（with なし）、それでも投げるなら throw_item。', 'Melee with fight { target } (no with), or throw once with throw_item.'));
    case 'ability_unknown':
      return actionError('cannot_use', t(L, 'abilities に、覚えていない能動技がある。', 'abilities lists an ability you do not know.'), t(L, 'self.abilities の id を並べる。', 'List ids from self.abilities.'));
    case 'ability_not_allowed':
      return actionError('cannot_use', t(L, 'fight に載せられるのは強打・なぎ払い・狙い撃ちだけ（立て直し・身をかわすは use_ability で使う）。', 'fight can only carry bash, cleave and aimed_throw (use second_wind and slip with use_ability).'), t(L, 'abilities から外す。', 'Remove it from abilities.'));
    case 'ability_needs_with':
      return actionError('cannot_use', t(L, '狙い撃ちは投擲で戦うときだけ載せられる。', 'aimed_throw can only be carried when fighting with a thrown item.'), t(L, 'fight { target, with: <スロット>, abilities: [aimed_throw] }。', 'Use fight { target, with: <slot>, abilities: [aimed_throw] }.'));
    case 'out_of_ammo':
      // 床の投げた物は、隣に追ってくる敵がいない間だけ拾いに行く（S1b §12.4 の 5）
      return actionError('cannot_use', t(L, 'そのスロットに投げられる物が無い。', 'There is nothing throwable in that slot.'),
        t(L, 'self.attack.throws のスロットを with に指定する（床の投げた物は、隣に追ってくる敵がいない間だけ拾いに行く。隣の相手と戦うなら fight { target }）。', 'Pass a slot from self.attack.throws as with (fight fetches your thrown items only while no hunter is adjacent; to fight the adjacent one, fight { target }).'));
    case 'not_throwable':
      return actionError('cannot_use', t(L, 'そのスロットに投げられる物が無い。', 'There is nothing throwable in that slot.'), t(L, 'self.attack.throws のスロットを with に指定する。', 'Pass a slot from self.attack.throws as with.'));
    case 'no_line_of_sight':
      return actionError('no_line_of_sight', t(L, '相手まで投擲の経路が通っていない。', 'No clear throwing line to the target.'), t(L, '位置を変えるか、近接で戦う。', 'Move, or fight in melee.'));
    case 'explored':
      return actionError('nothing_to_do', t(L, 'この階で辿り着ける未見の区画も、拾うアイテムも無い。', 'Nothing reachable left to explore or pick up on this floor.'), t(L, 'travel_to stairs_down か extract。', 'travel_to stairs_down, or extract.'));
    case 'toward_exhausted': {
      const what = cmd.type === 'explore' && cmd.toward === 'sense' ? t(L, '気配', 'the sense') : t(L, '下への風', 'the draft');
      return { ...actionError('nothing_to_do', t(L, `${what}の方角に、行ける未探索の境界が無い（ほかの方角は探さずに止まった）。`, `No reachable unexplored edge lies toward ${what} (stopped instead of searching other directions).`),
        t(L, 'ほかの方角も探すなら toward を付けない explore。分かっている場所へは travel_to。', 'To search other directions, explore without toward; to go somewhere known, travel_to.')), details: { stop: 'toward_exhausted' } };
    }
    case 'collected':
      return actionError('nothing_to_do', t(L, '回収する物が無い。', 'Nothing to collect.'), cmd.type === 'collect' && cmd.kinds?.length ? t(L, 'kinds の種類の品が見えていない・記憶に無い（kinds を外すと他の品も拾う。未鑑定の品は区分 potion・scroll・amulet・ring で指す）。', 'No item of those kinds is visible or remembered (drop kinds to pick up other items; name unidentified items by category: potion, scroll, amulet, ring).')
        // 既定の what は thrown（自分が投げた物だけ。S1c §14.4 の 6: 薬や宝が残っているのに「回収する物が無い」と読まれた）
        : cmd.type === 'collect' && collectWhatOf(cmd) === 'thrown' ? t(L, "既定の collect は自分が投げた物だけを拾う。ほかの品を拾うなら collect { what: 'items' }。", "Plain collect only picks up your own thrown items. For other items, collect { what: 'items' }.") : '');
    case 'collect_far': {
      const w = cmd.type === 'collect' ? (cmd.within ?? COLLECT_WITHIN) : COLLECT_WITHIN;
      return actionError('nothing_to_do', t(L, `${w} 歩以内に回収する物が無い。`, `Nothing to collect within ${w} steps.`), t(L, 'もっと遠くまで拾うなら within を大きくする（例 within: 40）。', 'Raise within to go farther (e.g. within: 40).'));
    }
    case 'arrived':
      return actionError('nothing_to_do', t(L, 'すでに目的地にいる。', 'You are already there.'), '');
    case 'full_hp':
    case 'target_hp':
      return actionError('nothing_to_do', t(L, '回復の必要が無い。', 'No need to rest.'), '');
    case 'rest_cap':
      return actionError('nothing_to_do', t(L, 'これ以上は休憩では戻らない（休憩と自然回復は最大 HP の一定の割合まで）。', 'Rest heals no further (rest and natural regeneration stop at a share of max HP).'),
        t(L, '上を戻すなら回復の薬・立て直し・泉。キャンプに戻れば全快する。', 'Above that, use a healing potion, second wind or a fountain; camp heals you fully.'));
    default:
      return actionError('bad_request', t(L, `始められない（${stop}）。`, `Cannot start (${stop}).`), '');
  }
}

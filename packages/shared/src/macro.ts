// マクロ行動（explore / travel / rest / collect / fight）の計画。PlayerView だけを入力に「次の基本行動」を決める。
// AI も人間も同じものを使う。展開はサーバーが行い、各手を source:'macro' の通常コマンドとして記録する。
// V3-2R §14.2: 1 回の呼び出しは 1 つの判断に対応させる。移動マクロは慎重さ（mode）を選べる。
import type { Catalog } from './catalog';
import type { ActionError, Command, MacroMode, TravelTarget } from './commands';
import { actionError } from './commands';
import type { ProjectedEvent } from './filter';
import { buildNavGrid, dirBetween, findFrontiers, findPath } from './nav';
import type { Pos } from './types';
import { cheb, t } from './util';
import type { Locale } from './types';
import type { EntityView, PlayerView } from './view';

/** 既定値（実際の上限は catalog.rules.macroStepLimit / restMaxTurns） */
export const MACRO_STEP_LIMIT = 200;

export type MacroStop =
  | 'hostile_in_view' | 'damaged' | 'item_seen' | 'stairs_seen' | 'arrived' | 'explored'
  | 'unreachable' | 'unknown_destination' | 'step_limit' | 'full_hp' | 'status_changed'
  | 'not_your_turn' | 'dead' | 'run_ended' | 'floor_changed' | 'blocked' | 'error'
  | 'target_hp' | 'max_turns' | 'left_board' | 'attacked' | 'collected' | 'hostile_adjacent'
  | 'hp_floor' | 'hp_threshold' | 'target_down' | 'target_gone' | 'target_moved' | 'hostile_alerted'
  // fight の拡張（V3-2R2 §18.5）
  | 'target_adjacent' | 'out_of_ammo' | 'no_line_of_sight' | 'target_not_approaching' | 'target_not_hunting' | 'not_throwable';

/** 自然に終わった（中断ではない）停止理由 */
export const MACRO_COMPLETED_STOPS: ReadonlySet<MacroStop> = new Set<MacroStop>(['arrived', 'explored', 'full_hp', 'target_hp', 'max_turns', 'collected', 'target_down']);

/** fight が相手を待つ最大の手番（近づいてくるまで・射程に入るまで） */
export const FIGHT_WAIT_MAX = 10;
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
  /** fight: 相手 */
  fightTarget?: string;
  /** fight: 投げる品のスロットと、開始時のその品の種類（尽きたら止まる） */
  fightWith?: string;
  fightKind?: string | null;
  /** fight: 一度でも隣で殴り合ったか・待った手番・隣から離れていた手番・射線が通らなかった手番 */
  engaged?: boolean;
  waits?: number;
  apart?: number;
  blocked?: number;
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
  /** 拾えなかったアイテム（同じ物を拾い直そうとしない） */
  skipItems: string[];
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
}

/** 既知の「自分が投げた物」の位置（セル index） */
function mineCells(view: PlayerView): number[] {
  const f = view.floor!;
  const cells = new Set<number>();
  for (const e of view.entities) if (e.cat === 'item' && e.mine) cells.add(e.pos.y * f.width + e.pos.x);
  for (const r of view.memory.remembered) if (r.cat === 'item' && r.mine) cells.add(r.pos.y * f.width + r.pos.x);
  return [...cells].sort((a, b) => a - b);
}

/** 既知の「自分が投げた物」の個数 */
export function mineCount(view: PlayerView): number {
  let n = 0;
  const seen = new Set<string>();
  for (const e of view.entities) if (e.cat === 'item' && e.mine) { n += e.qty ?? 1; seen.add(e.id); }
  for (const r of view.memory.remembered) if (r.cat === 'item' && r.mine && !seen.has(r.id)) n += r.qty;
  return n;
}

/** マクロが拾ってよいアイテムか（遺物と、鑑定済みの有害品は拾わない） */
function pickable(catalog: Catalog, it: { kind: string | null; role?: string }): boolean {
  if (it.role === 'relic') return false;
  if (it.kind && catalog.items[it.kind]?.harmful) return false;
  return true;
}

/** 見えている・記憶しているアイテムのうち拾ってよいもの（id とセル） */
export function pickableItems(view: PlayerView, catalog: Catalog, skip: readonly string[] = []): { id: string; cell: number }[] {
  const f = view.floor;
  if (!f) return [];
  if (view.inventory.filter((i) => !(i.kind && catalog.items[i.kind]?.bound)).length >= view.self.capacity) return [];
  const out = new Map<string, number>();
  for (const e of view.entities) if (e.cat === 'item' && pickable(catalog, e) && !skip.includes(e.id)) out.set(e.id, e.pos.y * f.width + e.pos.x);
  for (const r of view.memory.remembered) if (r.cat === 'item' && !out.has(r.id) && pickable(catalog, r) && !skip.includes(r.id)) out.set(r.id, r.pos.y * f.width + r.pos.x);
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

/** 動かない種族（公開のタグ） */
export function isStationary(catalog: Catalog, e: Pick<EntityView, 'kind'>): boolean {
  return !!e.kind && !!catalog.monsters[e.kind]?.tags.includes('stationary');
}

const HP_FLOOR_PCT: Record<string, number> = { careful: 0, steady: 50, flee: 25, fight: 50 };

export function macroStart(view: PlayerView, cmd: Command, catalog: Catalog): MacroState {
  const rules = catalog.rules;
  const kind = cmd.type as MacroState['kind'];
  const withSlot = cmd.type === 'fight' ? cmd.with : undefined;
  const withItem = withSlot ? view.inventory.find((i) => i.slot === withSlot) : undefined;
  const mode: MacroMode = (cmd.type === 'explore' || cmd.type === 'travel' || cmd.type === 'collect') ? (cmd.mode ?? 'careful') : 'careful';
  const floorPct = kind === 'fight' ? HP_FLOOR_PCT.fight : HP_FLOOR_PCT[mode];
  const explicitFloor = 'hpFloor' in cmd ? cmd.hpFloor : undefined;
  const itemTarget = cmd.type === 'travel' && typeof cmd.to === 'string' && cmd.to.startsWith('e_')
    && (view.entities.some((e) => e.id === cmd.to && e.cat === 'item') || view.memory.remembered.some((r) => r.id === cmd.to && r.cat === 'item'));
  const st: MacroState = {
    kind,
    target: cmd.type === 'travel' ? cmd.to : undefined,
    mode,
    hpFloor: explicitFloor ?? Math.trunc((view.self.stats.maxHp * floorPct) / 100),
    pickup: cmd.type === 'explore' ? (cmd.pickup ?? true) : cmd.type === 'travel' ? (cmd.pickup ?? itemTarget) : cmd.type === 'collect' ? (cmd.what ?? 'thrown') === 'items' : false,
    collectWhat: cmd.type === 'collect' ? (cmd.what ?? 'thrown') : 'thrown',
    ...(cmd.type === 'fight' ? { fightTarget: cmd.target, engaged: false, waits: 0, apart: 0, blocked: 0 } : {}),
    ...(withSlot ? { fightWith: withSlot, fightKind: withItem ? (withItem.kind ?? withItem.appearanceId) : null } : {}),
    floorKey: view.floor?.key ?? '',
    lastHp: view.self.stats.hp,
    knownHostiles: hostileIds(view),
    knownKinds: [...new Set([...Object.keys(view.monsterMemory), ...view.entities.filter((e) => e.cat === 'monster' && e.kind).map((e) => e.kind!)])],
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
    knownDown: downStairsCount(view, catalog),
    adjacent: view.self.pos ? view.entities.filter((e) => e.cat === 'monster' && cheb(e.pos, view.self.pos!) <= 1).map((e) => e.id) : [],
  };
  if (cmd.type === 'wait') st.maxTurns = cmd.turns ?? 1;
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
  if (e) return { goals: [e.pos.y * f.width + e.pos.x], adjacentOk: e.cat === 'monster' || e.cat === 'player' };
  const r = view.memory.remembered.find((x) => x.id === target);
  if (r) return { goals: [r.pos.y * f.width + r.pos.x], adjacentOk: false };
  return null;
}

export type MacroDecision = { command: Command } | { stop: MacroStop };

/**
 * 次の基本行動を決める。events は直前の手で知覚したイベント（中断判定用）。
 * state は破壊的に更新される。
 */
export function macroNext(state: MacroState, view: PlayerView, catalog: Catalog, events: readonly ProjectedEvent[]): MacroDecision {
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

  // 中断条件（最初の 1 手の前は判定しない項目もある）
  if (state.steps > 0) {
    const attacked = ev('attack', (e) => e.target === me.id);
    // 新しく掛かった状態異常だけ（掛かっている毒の延長・掛け直しでは止まらない）
    const status = ev('status_applied', (e) => e.target === me.id && !state.myStatuses.includes(((e.status as { id?: string }) ?? {}).id ?? ''));
    // 継続ダメージ（毒）は careful でも止めない（HP のしきい値をまたぐまで）
    const hurt = ev('damaged', (e) => e.target === me.id && e.via !== 'poison');
    if (kind === 'rest') {
      // 毒の継続ダメージでは止まらない（毒が抜けるまで休む。rest_estimate の文と同じ）
      if (hurt) return { stop: 'damaged' };
      if (attacked) return { stop: 'attacked' };
      if (status) return { stop: 'status_changed' };
    } else if (kind === 'fight') {
      if (ev('died', (e) => e.id === state.fightTarget)) return { stop: 'target_down' };
      if (status) return { stop: 'status_changed' };
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
  if ((kind === 'fight' || mode === 'steady' || mode === 'flee') && kind !== 'rest' && hp < state.hpFloor) return { stop: 'hp_floor' };

  const hostiles = view.entities.filter((e) => e.cat === 'monster');
  const before = new Set(state.knownHostiles);
  const pursuing = (h: EntityView) => h.awareness === 'hunting' && !h.fleeing;
  // 自分に届く: 動かない種族は隣にいるときだけ
  const reaches = (h: EntityView) => !isStationary(catalog, h) || cheb(h.pos, pos) <= 1;
  const newKind = (h: EntityView) => !!h.kind && !state.knownKinds.includes(h.kind);
  for (const h of hostiles) {
    const isNew = !before.has(h.id);
    if (kind === 'rest') {
      // 報告済みの個体が逃げながら視界を出入りしても止まらない（V3-2R2 §18.5）
      if (isNew && !(h.fleeing && state.everSeen.includes(h.id))) return { stop: 'hostile_in_view' };
    } else if (kind === 'wait') {
      if (isNew) return { stop: 'hostile_in_view' };
    } else if (kind === 'fight') {
      if (isNew && h.id !== state.fightTarget && pursuing(h) && reaches(h)) return { stop: 'hostile_in_view' };
    } else if (mode === 'careful') {
      // 初見の種族、追跡中で届く敵の出現、見えている敵が追跡に変わった
      if (newKind(h)) return { stop: 'hostile_in_view' };
      if (isNew && pursuing(h) && reaches(h)) return { stop: 'hostile_in_view' };
      if (!isNew && state.aware[h.id] !== 'hunting' && pursuing(h) && reaches(h)) return { stop: 'hostile_alerted' };
    } else if (mode === 'steady') {
      if (newKind(h)) return { stop: 'hostile_in_view' };
    }
  }
  state.knownHostiles = hostiles.map((h) => h.id);
  for (const h of hostiles) if (!state.everSeen.includes(h.id)) state.everSeen.push(h.id);
  state.aware = Object.fromEntries(hostiles.map((h) => [h.id, h.awareness ?? 'unaware']));
  state.myStatuses = me.statuses.map((s) => s.id);
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
    const tg = hostiles.find((h) => h.id === state.fightTarget);
    if (!tg) return { stop: 'target_gone' };
    if (state.steps >= state.limit) return { stop: 'step_limit' };
    const d = cheb(tg.pos, pos);
    const hunting = tg.awareness === 'hunting';
    state.lastHp = hp;
    const wait = (): MacroDecision => { state.steps += 1; return { command: { type: 'wait' } }; };
    if (state.fightWith) {
      const slot = state.fightWith;
      const it = view.inventory.find((i) => i.slot === slot);
      if (!it || (state.fightKind !== undefined && (it.kind ?? it.appearanceId) !== state.fightKind)) return { stop: 'out_of_ammo' };
      const range = throwRangeOf(view, catalog, slot);
      if (range === null) return { stop: 'not_throwable' };
      if (d <= 1) return { stop: 'target_adjacent' };
      if (tg.shot && d <= range) {
        state.blocked = 0;
        state.steps += 1;
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
      return { command: { type: 'move', dir } };
    }
    if (state.engaged) {
      // 当てて逃げる相手: 追跡中で 2 マス以内なら 2 手番まで待つ（追わない）
      if (hunting && !tg.fleeing && d <= 2 && (state.apart ?? 0) < FIGHT_APART_MAX) { state.apart = (state.apart ?? 0) + 1; return wait(); }
      return { stop: 'target_moved' };
    }
    // 迎え撃つ: 追跡中の相手が隣に来るまで待つ（最大 FIGHT_WAIT_MAX 手番）
    if (!hunting) return { stop: 'target_not_hunting' };
    if (tg.fleeing) return { stop: 'target_moved' };
    if ((state.waits ?? 0) >= FIGHT_WAIT_MAX || isStationary(catalog, tg)) return { stop: 'target_not_approaching' };
    state.waits = (state.waits ?? 0) + 1;
    return wait();
  }

  // 隣の敵: careful は起きている敵（逃走中を除く）、steady は追跡中の敵がいれば動かない。flee は動く
  if (kind !== 'rest') {
    if (mode === 'careful' && hostiles.some((h) => cheb(h.pos, pos) <= 1 && h.awareness !== 'asleep' && !h.fleeing)) return { stop: 'hostile_adjacent' };
    if (mode === 'steady' && hostiles.some((h) => cheb(h.pos, pos) <= 1 && pursuing(h))) return { stop: 'hostile_adjacent' };
  }
  // 休憩: 自分に届く追跡中の敵（動かない敵は隣接していなければ妨げない）
  if (kind === 'rest' && hostiles.some((h) => pursuing(h) && reaches(h))) return { stop: 'hostile_in_view' };
  if (kind === 'explore' && mode === 'careful' && stairsCount(view, catalog) > state.knownStairs) return { stop: 'stairs_seen' };
  // その階の下り階段を初めて見た（踏破の判断の起点。steady も止まる。flee は止まらない。V3-2R2 §18.5）
  const downNow = downStairsCount(view, catalog);
  if (kind !== 'rest' && mode !== 'flee' && state.knownDown === 0 && downNow > 0) return { stop: 'stairs_seen' };
  state.knownDown = downNow;
  state.knownStairs = stairsCount(view, catalog);
  state.knownItems = itemIds(view);
  state.lastHp = hp;

  if (kind === 'rest') {
    const poisoned = me.statuses.some((s) => s.id === 'core:poison');
    if (hp >= me.stats.maxHp && !poisoned) return { stop: 'full_hp' };
    if (state.untilHp !== undefined && hp >= state.untilHp && !poisoned) return { stop: 'target_hp' };
    if (state.maxTurns !== undefined && state.steps >= state.maxTurns) return { stop: 'max_turns' };
    if (state.steps >= state.limit) return { stop: 'step_limit' };
    state.steps += 1;
    return { command: { type: 'wait' } };
  }
  if (state.steps >= state.limit) return { stop: 'step_limit' };

  const grid = buildNavGrid(view, catalog)!;
  const here = pos.y * grid.width + pos.x;
  // 足元のアイテムを拾う（通り道と目的地。1 手番）
  if (state.pickup) {
    const items = pickableItems(view, catalog, state.skipItems).filter((x) => x.cell === here && view.entities.some((e) => e.id === x.id));
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
  if (kind === 'explore') {
    // 行き先: 未見の区画との境界（＋拾うなら拾えるアイテム）
    const fr = findFrontiers(grid);
    const itemCells = state.pickup ? pickableItems(view, catalog, state.skipItems).map((x) => x.cell) : [];
    const targets = [...new Set([...fr, ...itemCells])];
    if (!targets.length) return { stop: 'explored' };
    path = null;
    if (state.goal !== undefined && state.goal !== here && targets.includes(state.goal)) {
      path = findPath(grid, pos, [state.goal], 'strict') ?? findPath(grid, pos, [state.goal], 'actors');
    }
    if (path === null) {
      const others = targets.filter((i) => i !== here);
      path = others.length ? (findPath(grid, pos, others, 'strict') ?? findPath(grid, pos, others, 'actors')) : null;
      const last = path && path.length ? path[path.length - 1] : null;
      state.goal = last ? last.y * grid.width + last.x : undefined;
    }
    if (path === null || path.length === 0) return { stop: findPath(grid, pos, targets.filter((i) => i !== here), 'none') ? 'blocked' : 'explored' };
  } else if (kind === 'collect') {
    const goals = (state.collectWhat === 'items' ? pickableItems(view, catalog, state.skipItems).map((x) => x.cell) : mineCells(view)).filter((i) => i !== here);
    if (!goals.length) return { stop: 'collected' };
    path = findPath(grid, pos, goals, 'strict') ?? findPath(grid, pos, goals, 'actors');
    if (path === null) return { stop: findPath(grid, pos, goals, 'none') ? 'blocked' : 'unreachable' };
    if (path.length === 0) return { stop: 'collected' };
  } else {
    // 目的地のアイテムを拾った（所持品に入った）なら到着
    if (typeof state.target === 'string' && view.inventory.some((i) => i.id === state.target)) return { stop: 'arrived' };
    const goal = resolveTravelGoal(view, catalog, state.target!);
    // 追っていた相手（エンティティ）が見えなくなった
    if (!goal) return { stop: state.steps > 0 && typeof state.target === 'string' && state.target.startsWith('e_') ? 'target_gone' : 'unknown_destination' };
    if (goal.goals.includes(here)) return { stop: 'arrived' };
    if (goal.adjacentOk && goal.goals.some((g) => cheb({ x: g % grid.width, y: Math.trunc(g / grid.width) }, pos) <= 1)) return { stop: 'arrived' };
    path = findPath(grid, pos, goal.goals, 'strict') ?? findPath(grid, pos, goal.goals, 'actors');
    if (path === null) {
      const loose = findPath(grid, pos, goal.goals, 'none');
      return { stop: loose ? 'blocked' : 'unreachable' };
    }
    if (path.length === 0) return { stop: 'arrived' };
    if (goal.adjacentOk && path.length === 1) return { stop: 'arrived' };
  }
  // マクロは攻撃しない: 次のマスに敵がいたら止まる
  if (hostiles.some((h) => h.pos.x === path[0].x && h.pos.y === path[0].y)) return { stop: 'blocked' };
  const dir = dirBetween(pos, path[0]);
  if (!dir) return { stop: 'error' };
  state.steps += 1;
  return { command: { type: 'move', dir } };
}

/**
 * 1 歩も進めないと分かったマクロの拒否（手番を使わない。V3-2R §14.2「0 歩で終わる呼び出しを作らない」）。
 * 最初の判断が停止なら、その理由をゲームのエラー形式で返す。
 */
export function macroStopError(L: Locale, stop: MacroStop, cmd: Command): ActionError {
  const flee = cmd.type === 'travel' || cmd.type === 'explore' || cmd.type === 'collect';
  switch (stop) {
    case 'hostile_adjacent':
      return actionError('hostile_adjacent', t(L, '隣に起きている敵がいるので、マクロは 1 歩も進めない。', 'An awake enemy is adjacent, so the macro cannot take a step.'),
        flee ? t(L, "退くなら mode: 'flee'（隣に敵がいても動く。攻撃は受ける）。戦うなら fight { target }。", "To retreat use mode: 'flee' (moves even when adjacent; you will be attacked). To fight use fight { target }.")
          : t(L, '戦うなら fight { target }、離れるなら move。', 'Use fight { target } to fight, or move to step away.'));
    case 'hostile_in_view':
      return actionError('hostile_in_view', t(L, '追跡中の敵が見えているので始められない。', 'A hunting enemy is in view, so this cannot start.'),
        t(L, "先に対処する（fight・throw_item）か、mode: 'steady' / 'flee' で移動する。", "Deal with it first (fight, throw_item) or move with mode: 'steady' / 'flee'."));
    case 'hp_floor':
      return actionError('hp_floor', t(L, 'HP がすでに hp_floor を下回っている。', 'HP is already below hp_floor.'), t(L, 'hp_floor を下げるか、回復してから。', 'Lower hp_floor or heal first.'));
    case 'blocked':
      return actionError('blocked', t(L, '既知の経路が敵にふさがれていて進めない（マクロは攻撃しない）。', 'Your known route is blocked by a monster (macros never attack).'), t(L, 'fight で倒すか、別の経路を選ぶ。', 'Use fight, or choose another route.'));
    case 'unreachable':
      return actionError('unreachable', t(L, '既知の経路では到達できない。', 'Unreachable via the known map.'), t(L, 'explore で経路を探す。', 'Explore to find a route.'));
    case 'unknown_destination':
      return actionError('unknown_destination', t(L, '行き先が既知の地図に無い。', 'The destination is not on your known map.'), t(L, 'explore で見つけてから。', 'Find it with explore first.'));
    case 'target_gone':
    case 'target_moved':
      return actionError('no_target', t(L, 'その相手は見えていない（または逃げている）。', 'That target is not visible (or is fleeing).'), t(L, 'visible.monsters の id を指定する。', 'Give an id from visible.monsters.'));
    case 'target_not_hunting':
      return actionError('no_target', t(L, 'その相手はまだあなたを追っていない（眠っている・気付いていない）。fight は追跡中の相手を待つ。', 'That target is not hunting you yet (asleep or unaware). fight waits only for hunting targets.'),
        t(L, '近づくなら travel_to、先手を取るなら throw_item。隣に来れば fight で殴れる。', 'Approach with travel_to or open with throw_item. Once adjacent, fight works.'));
    case 'target_not_approaching':
      return actionError('no_target', t(L, 'その相手は動かないので、待っても近づいてこない。', 'That target does not move, so waiting will not bring it closer.'), t(L, 'travel_to で隣へ行くか、投擲で戦う（fight { target, with }）。', 'Walk next to it with travel_to, or fight it with throws (fight { target, with }).'));
    case 'target_adjacent':
      return actionError('blocked', t(L, '相手は隣にいる（投擲の fight は隣に来た相手には止まる）。', 'The target is adjacent (throwing fight stops once it is next to you).'), t(L, '近接で戦うなら fight { target }（with なし）、それでも投げるなら throw_item。', 'Melee with fight { target } (no with), or throw once with throw_item.'));
    case 'out_of_ammo':
    case 'not_throwable':
      return actionError('cannot_use', t(L, 'そのスロットに投げられる物が無い。', 'There is nothing throwable in that slot.'), t(L, 'self.attack.throws のスロットを with に指定する。', 'Pass a slot from self.attack.throws as with.'));
    case 'no_line_of_sight':
      return actionError('no_line_of_sight', t(L, '相手まで投擲の経路が通っていない。', 'No clear throwing line to the target.'), t(L, '位置を変えるか、近接で戦う。', 'Move, or fight in melee.'));
    case 'explored':
      return actionError('nothing_to_do', t(L, 'この階で辿り着ける未見の区画も、拾うアイテムも無い。', 'Nothing reachable left to explore or pick up on this floor.'), t(L, 'travel_to stairs_down か extract。', 'travel_to stairs_down, or extract.'));
    case 'collected':
      return actionError('nothing_to_do', t(L, '回収する物が無い。', 'Nothing to collect.'), '');
    case 'arrived':
      return actionError('nothing_to_do', t(L, 'すでに目的地にいる。', 'You are already there.'), '');
    case 'full_hp':
    case 'target_hp':
      return actionError('nothing_to_do', t(L, '回復の必要が無い。', 'No need to rest.'), '');
    default:
      return actionError('bad_request', t(L, `始められない（${stop}）。`, `Cannot start (${stop}).`), '');
  }
}

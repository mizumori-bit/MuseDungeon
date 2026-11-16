// マクロ行動（explore / travel / rest）の計画。PlayerView だけを入力に「次の基本行動」を決める。
// AI も人間も同じものを使う。展開はサーバーが行い、各手を source:'macro' の通常コマンドとして記録する。
import type { Catalog } from './catalog';
import type { Command, TravelTarget } from './commands';
import type { ProjectedEvent } from './filter';
import { buildNavGrid, dirBetween, findFrontiers, findPath } from './nav';
import type { Pos } from './types';
import { cheb } from './util';
import type { PlayerView } from './view';

/** 既定値（実際の上限は catalog.rules.macroStepLimit / restMaxTurns） */
export const MACRO_STEP_LIMIT = 200;

export type MacroStop =
  | 'hostile_in_view' | 'damaged' | 'item_seen' | 'stairs_seen' | 'arrived' | 'explored'
  | 'unreachable' | 'unknown_destination' | 'step_limit' | 'full_hp' | 'status_changed'
  | 'not_your_turn' | 'dead' | 'run_ended' | 'floor_changed' | 'blocked' | 'error'
  | 'target_hp' | 'max_turns' | 'left_board' | 'attacked' | 'collected' | 'hostile_adjacent';

/** 自然に終わった（中断ではない）停止理由 */
export const MACRO_COMPLETED_STOPS: ReadonlySet<MacroStop> = new Set<MacroStop>(['arrived', 'explored', 'full_hp', 'target_hp', 'max_turns', 'collected']);

export interface MacroState {
  kind: 'explore' | 'travel' | 'rest' | 'collect';
  target?: TravelTarget;
  floorKey: string;
  lastHp: number;
  knownHostiles: string[];
  knownItems: string[];
  knownStairs: number;
  steps: number;
  /** explore: 選んだフロンティア（到達するか、フロンティアでなくなるまで固定。同距離の振動を防ぐ） */
  goal?: number;
  /** 手数の上限 */
  limit: number;
  /** rest: この HP に達したら止まる */
  untilHp?: number;
  /** rest: この手数で止まる */
  maxTurns?: number;
  /** 開始時の HP とフロア時刻（結果の報告用） */
  startHp: number;
  startTime: number;
  /** 開始時の seq（「このランで初めて見る敵」の判定用） */
  startSeq: number;
  /** 直前の手で見えていた敵の覚醒状態（knownHostiles と同じ集合） */
  aware: Record<string, string>;
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

export function macroStart(view: PlayerView, cmd: Command, catalog: Catalog): MacroState {
  const rules = catalog.rules;
  const st: MacroState = {
    kind: cmd.type as MacroState['kind'],
    target: cmd.type === 'travel' ? cmd.to : undefined,
    floorKey: view.floor?.key ?? '',
    lastHp: view.self.stats.hp,
    knownHostiles: hostileIds(view),
    knownItems: itemIds(view),
    knownStairs: stairsCount(view, catalog),
    steps: 0,
    limit: cmd.type === 'rest' ? (rules?.restMaxTurns ?? 400) : (rules?.macroStepLimit ?? MACRO_STEP_LIMIT),
    startHp: view.self.stats.hp,
    startTime: view.floor?.time ?? 0,
    startSeq: view.seq,
    aware: Object.fromEntries(view.entities.filter((e) => e.cat === 'monster').map((e) => [e.id, e.awareness ?? 'unaware'])),
  };
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

  // 中断条件（最初の 1 手の前は判定しない項目もある）
  if (state.steps > 0) {
    if (me.stats.hp < state.lastHp) return { stop: 'damaged' };
    // 自分を狙った攻撃（外れても）
    if (events.some((e) => e.type === 'attack' && (e as any).target === me.id)) return { stop: 'attacked' };
    if (events.some((e) => e.type === 'status_applied' && (e as any).target === me.id)) return { stop: 'status_changed' };
  }
  const hostiles = view.entities.filter((e) => e.cat === 'monster');
  const before = new Set(state.knownHostiles);
  const pursuing = (h: typeof hostiles[number]) => h.awareness === 'hunting' && !h.fleeing;
  for (const h of hostiles) {
    if (!before.has(h.id)) {
      // 視界に入った: rest は状態によらず止まる。他は「このランで初めて見る敵」か「追跡中で逃げていない既知の敵」
      if (state.kind === 'rest') return { stop: 'hostile_in_view' };
      const newToRun = h.firstSeenSeq === undefined || h.firstSeenSeq > state.startSeq;
      if (newToRun || pursuing(h)) return { stop: 'hostile_in_view' };
    } else if (state.aware[h.id] !== 'hunting' && pursuing(h)) {
      // 見えている敵が追跡に変わった（起きた・気づかれた）
      return { stop: 'hostile_in_view' };
    }
  }
  state.knownHostiles = hostiles.map((h) => h.id);
  state.aware = Object.fromEntries(hostiles.map((h) => [h.id, h.awareness ?? 'unaware']));
  // 隣に起きている敵（逃走中を除く）がいる間はマクロで動かない（離れる一歩は move で選ぶ）
  if (hostiles.some((h) => cheb(h.pos, pos) <= 1 && h.awareness !== 'asleep' && !h.fleeing)) return { stop: 'hostile_adjacent' };
  if (state.kind === 'rest' && hostiles.some(pursuing)) return { stop: 'hostile_in_view' };
  if (state.kind === 'explore') {
    const items = itemIds(view);
    if (items.some((i) => !state.knownItems.includes(i))) return { stop: 'item_seen' };
    if (stairsCount(view, catalog) > state.knownStairs) return { stop: 'stairs_seen' };
  }
  state.lastHp = me.stats.hp;

  if (state.kind === 'rest') {
    const poisoned = me.statuses.some((s) => s.id === 'core:poison');
    if (me.stats.hp >= me.stats.maxHp && !poisoned) return { stop: 'full_hp' };
    if (state.untilHp !== undefined && me.stats.hp >= state.untilHp && !poisoned) return { stop: 'target_hp' };
    if (state.maxTurns !== undefined && state.steps >= state.maxTurns) return { stop: 'max_turns' };
    if (state.steps >= state.limit) return { stop: 'step_limit' };
    state.steps += 1;
    return { command: { type: 'wait' } };
  }
  if (state.steps >= state.limit) return { stop: 'step_limit' };

  const grid = buildNavGrid(view, catalog)!;
  let path: Pos[] | null;
  if (state.kind === 'explore') {
    const fr = findFrontiers(grid);
    if (!fr.length) return { stop: 'explored' };
    const here = pos.y * grid.width + pos.x;
    path = null;
    if (state.goal !== undefined && state.goal !== here && fr.includes(state.goal)) {
      path = findPath(grid, pos, [state.goal], 'strict') ?? findPath(grid, pos, [state.goal], 'actors');
    }
    if (path === null) {
      path = findPath(grid, pos, fr.filter((i) => i !== here), 'strict') ?? findPath(grid, pos, fr.filter((i) => i !== here), 'actors');
      if (path === null && fr.includes(here)) path = [];
      const last = path && path.length ? path[path.length - 1] : null;
      state.goal = last ? last.y * grid.width + last.x : undefined;
    }
    if (path === null) return { stop: findPath(grid, pos, fr, 'none') ? 'blocked' : 'explored' };
    if (path.length === 0) {
      // 自分がフロンティア上にいる（周囲に未知が残るが進めない）→ 他のフロンティアへ
      const others = fr.filter((i) => i !== pos.y * grid.width + pos.x);
      if (!others.length) return { stop: 'explored' };
      path = findPath(grid, pos, others, 'strict') ?? findPath(grid, pos, others, 'actors');
      if (!path || !path.length) return { stop: 'explored' };
    }
  } else if (state.kind === 'collect') {
    const goals = mineCells(view).filter((i) => i !== pos.y * grid.width + pos.x);
    if (!goals.length) return { stop: 'collected' };
    path = findPath(grid, pos, goals, 'strict') ?? findPath(grid, pos, goals, 'actors');
    if (path === null) return { stop: findPath(grid, pos, goals, 'none') ? 'blocked' : 'unreachable' };
    if (path.length === 0) return { stop: 'collected' };
  } else {
    const goal = resolveTravelGoal(view, catalog, state.target!);
    if (!goal) return { stop: 'unknown_destination' };
    const here = pos.y * grid.width + pos.x;
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

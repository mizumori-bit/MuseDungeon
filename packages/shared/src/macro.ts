// マクロ行動（explore / travel / rest）の計画。PlayerView だけを入力に「次の基本行動」を決める。
// AI も人間も同じものを使う。展開はサーバーが行い、各手を source:'macro' の通常コマンドとして記録する。
import type { Catalog } from './catalog';
import type { Command, TravelTarget } from './commands';
import type { ProjectedEvent } from './filter';
import { buildNavGrid, dirBetween, findFrontiers, findPath } from './nav';
import type { Pos } from './types';
import { cheb } from './util';
import type { PlayerView } from './view';

export const MACRO_STEP_LIMIT = 200;

export type MacroStop =
  | 'hostile_in_view' | 'damaged' | 'item_seen' | 'stairs_seen' | 'arrived' | 'explored'
  | 'unreachable' | 'unknown_destination' | 'step_limit' | 'full_hp' | 'status_changed'
  | 'not_your_turn' | 'dead' | 'run_ended' | 'floor_changed' | 'blocked' | 'error';

export interface MacroState {
  kind: 'explore' | 'travel' | 'rest';
  target?: TravelTarget;
  floorKey: string;
  lastHp: number;
  knownHostiles: string[];
  knownItems: string[];
  knownStairs: number;
  steps: number;
  /** explore: 選んだフロンティア（到達するか、フロンティアでなくなるまで固定。同距離の振動を防ぐ） */
  goal?: number;
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
  return {
    kind: cmd.type as MacroState['kind'],
    target: cmd.type === 'travel' ? cmd.to : undefined,
    floorKey: view.floor?.key ?? '',
    lastHp: view.self.stats.hp,
    knownHostiles: hostileIds(view),
    knownItems: itemIds(view),
    knownStairs: stairsCount(view, catalog),
    steps: 0,
  };
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
  if (view.status !== 'your_turn') return { stop: 'not_your_turn' };
  if (!view.floor || !view.self.pos) return { stop: 'error' };
  if (view.floor.key !== state.floorKey) return { stop: 'floor_changed' };
  const me = view.self;
  const pos: Pos = me.pos!;

  // 中断条件（最初の 1 手の前は判定しない項目もある）
  if (state.steps > 0) {
    if (me.stats.hp < state.lastHp) return { stop: 'damaged' };
    if (events.some((e) => e.type === 'status_applied' && (e as any).target === me.id)) return { stop: 'status_changed' };
  }
  const hostiles = view.entities.filter((e) => e.cat === 'monster');
  const newHostile = hostiles.some((h) => !state.knownHostiles.includes(h.id));
  if (newHostile) return { stop: 'hostile_in_view' };
  if (hostiles.some((h) => cheb(h.pos, pos) <= 1 && h.awareness !== 'asleep')) return { stop: 'hostile_in_view' };
  if (state.kind === 'rest' && hostiles.some((h) => h.awareness === 'hunting')) return { stop: 'hostile_in_view' };
  if (state.kind === 'explore') {
    const items = itemIds(view);
    if (items.some((i) => !state.knownItems.includes(i))) return { stop: 'item_seen' };
    if (stairsCount(view, catalog) > state.knownStairs) return { stop: 'stairs_seen' };
  }
  if (state.steps >= MACRO_STEP_LIMIT) return { stop: 'step_limit' };
  state.lastHp = me.stats.hp;

  if (state.kind === 'rest') {
    const poisoned = me.statuses.some((s) => s.id === 'core:poison');
    if (me.stats.hp >= me.stats.maxHp && !poisoned) return { stop: 'full_hp' };
    return { command: { type: 'wait' } };
  }

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
  const dir = dirBetween(pos, path[0]);
  if (!dir) return { stop: 'error' };
  state.steps += 1;
  return { command: { type: 'move', dir } };
}

// フロア生成パイプライン:
//   selectFloorType → selectBiome → layout → prefab配置 → バイオーム地形 → 階段/接続 → populate → validate
// 各段はレジストリのプラグイン。乱数は用途別の名前付きサブストリーム（地形はアイテム表の変更に影響されない）。
// 生成は純関数: (content, runSeed, branch, depth) → { floor, spawns }。World を読まない。
import type { BiomeDef, Content, FloorTypeDef, MonsterDef, PrefabDef } from '@muse/content';
import type { EntityRole, Floor, Pos, Region } from '@muse/shared';
import { cheb, DIRS, DIR_VEC, floorDiv, floorKey, Rng } from '@muse/shared';
import { Registry, roll } from '../registry';
import { DOOR, FLOOR, GenGrid, WALL } from './grid';
import { layoutGenerators } from './layouts';

export type SpawnSpec =
  | { type: 'monster'; kind: string; x: number; y: number; hp: number; affixes: string[]; tier: number; asleep: boolean; delay: number; role?: EntityRole; bounty?: number; minHp?: number; hpBonusPct?: number }
  | { type: 'item'; kind: string; x: number; y: number; qty: number; affixes: string[]; role?: EntityRole; value?: number; hidden?: string[] }
  | { type: 'feature'; kind: string; x: number; y: number };

/** 遠征の目標階に置くもの */
/** rank: 守護者の格（堅実 1・標準 2・野心 3）。guardianKind: 候補で決めた種族（無ければ生成時に格で選ぶ） */
export interface ObjectiveSpec { guardian: boolean; relic: boolean; rank?: 1 | 2 | 3; guardianKind?: string }

/** 遠征の条件による生成の修飾（目標階までの新しい階に効く） */
export interface GenMods { monstersPct: number; itemsPct: number; treasurePct: number; noFountain: boolean }

/** 深度帯ごとのテンポ（floorType.pacing の一致した帯、無ければ既定値） */
export interface Pacing {
  size: { w: number; h: number };
  stairsPath: { min: number; max: number } | null;
  monstersPer1000: number;
  itemsPer1000: number;
  trapsPer1000: number;
}

export function resolvePacing(ft: FloorTypeDef, depth: number): Pacing {
  const band = ft.pacing.find((p) => depth >= p.depth.min && (p.depth.max === undefined || depth <= p.depth.max));
  return {
    size: band?.size ?? ft.size,
    stairsPath: band?.stairsPath ?? null,
    monstersPer1000: band?.monsters?.per1000 ?? ft.monsters.per1000,
    itemsPer1000: band?.items?.per1000 ?? ft.items.per1000,
    trapsPer1000: band?.traps?.per1000 ?? ft.traps.per1000,
  };
}

export interface GeneratedFloor {
  floor: Floor;
  spawns: SpawnSpec[];
  attempts: number;
  layout: string;
}

export interface GenState {
  content: Content;
  seed: string;
  branch: string;
  depth: number;
  attempt: number;
  floorType: FloorTypeDef;
  biome: BiomeDef;
  pacing: Pacing;
  mods?: GenMods;
  grid: GenGrid;
  entry: Pos;
  up: Pos | null;
  down: Pos[];
  spawns: SpawnSpec[];
  stream(name: string): Rng;
  passable(i: number): boolean;
}

export type Validator = (s: GenState) => boolean;
export const validators = new Registry<Validator>('validator');

const streamFor = (seed: string, branch: string, depth: number, attempt: number) => {
  const cache = new Map<string, Rng>();
  return (name: string) => {
    let r = cache.get(name);
    if (!r) {
      r = Rng.fromSeed(`${seed}|${branch}|${depth}|${attempt}|${name}`);
      cache.set(name, r);
    }
    return r;
  };
};

const depthOk = (d: { min: number; max?: number }, depth: number) => depth >= d.min && (d.max === undefined || depth <= d.max);

export function selectFloorType(content: Content, seed: string, branch: string, depth: number): FloorTypeDef {
  const forced = content.lists.floorTypes.find((f) => f.every > 0 && depth >= f.depth.min && depth % f.every === 0);
  if (forced) return forced;
  if (depth === 1) return content.floorTypes['core:standard'] ?? content.lists.floorTypes[0];
  const rng = Rng.fromSeed(`${seed}|${branch}|${depth}|select|floorType`);
  return rng.weighted(content.lists.floorTypes.filter((f) => depthOk(f.depth, depth)), (f) => f.weight) ?? content.lists.floorTypes[0];
}

export function selectBiome(content: Content, seed: string, branch: string, depth: number): BiomeDef {
  const rng = Rng.fromSeed(`${seed}|${branch}|${depth}|select|biome`);
  return rng.weighted(content.lists.biomes.filter((b) => depthOk(b.depth, depth)), (b) => b.weight) ?? content.lists.biomes[0];
}

/** プレハブの回転・反転 */
export function transformPrefab(map: string[], rot: number, flip: boolean): string[] {
  let m = map.map((r) => r.split(''));
  if (flip) m = m.map((r) => [...r].reverse());
  for (let k = 0; k < rot; k++) {
    const h = m.length, w = m[0].length;
    const out: string[][] = [];
    for (let x = 0; x < w; x++) {
      const row: string[] = [];
      for (let y = h - 1; y >= 0; y--) row.push(m[y][x]);
      out.push(row);
    }
    m = out;
  }
  return m.map((r) => r.join(''));
}

function monsterWeight(m: MonsterDef, depth: number, biome: BiomeDef): number {
  if (!depthOk(m.depth, depth)) return 0;
  let w = floorDiv(120, m.rarity);
  const peak = m.depth.peak ?? m.depth.min;
  if (depth > peak) w = floorDiv(w * Math.max(15, 100 - (depth - peak) * 12), 100);
  for (const tag of m.tags) {
    const mod = biome.spawnTags[tag];
    if (mod !== undefined) w = floorDiv(w * mod, 100);
  }
  return Math.max(0, w);
}

export function pickMonster(s: Pick<GenState, 'content' | 'depth' | 'biome' | 'floorType'>, rng: Rng): { def: MonsterDef; tier: number } | null {
  const c = s.content;
  const table = c.spawnTables[s.floorType.monsters.table];
  const effective = Math.min(s.depth, c.deepestDefined);
  const tier = s.depth > c.deepestDefined ? floorDiv(s.depth - c.deepestDefined, 5) + 1 : 0;
  let d = effective;
  // 低確率で深層の敵が混ざる（浅い階では深度差を抑える）
  if (table && rng.chance(table.oodChancePct)) d = Math.min(c.deepestDefined, effective + Math.min(table.oodDepth, s.depth));
  const cands = c.lists.monsters.filter((m) =>
    (!table?.tagsAny.length || m.tags.some((t) => table.tagsAny.includes(t))) && !(table?.tagsNone ?? []).some((t) => m.tags.includes(t)));
  let def = rng.weighted(cands, (m) => monsterWeight(m, d, s.biome));
  if (!def) def = rng.weighted(cands, (m) => monsterWeight(m, effective, s.biome));
  return def ? { def, tier } : null;
}

export function rollMonsterAffixes(content: Content, depth: number, rng: Rng): string[] {
  const out: string[] = [];
  const chance = Math.min(45, depth * 3);
  const cands = content.lists.affixes.filter((a) => a.target === 'monster' && depth >= a.depth.min);
  if (cands.length && rng.chance(chance)) {
    const a = rng.weighted(cands, (x) => floorDiv(100, x.rarity));
    if (a) out.push(a.id);
    if (depth >= 10 && rng.chance(floorDiv(chance, 2))) {
      const b = rng.weighted(cands.filter((x) => !out.includes(x.id)), (x) => floorDiv(100, x.rarity));
      if (b) out.push(b.id);
    }
  }
  return out;
}

export function pickLoot(content: Content, tableId: string, depth: number, rng: Rng): { kind: string; qty: number; affixes: string[]; value?: number; hidden?: string[] } | null {
  const table = content.lootTables[tableId];
  if (!table) return null;
  const d = depth + table.depthBonus;
  for (let tries = 0; tries < 8; tries++) {
    const entry = rng.weighted(table.entries, (e) => e.weight);
    if (!entry) return null;
    let kind: string | null = null;
    if (entry.item) kind = entry.item;
    else {
      const cands = content.lists.items.filter((i) => i.category === entry.category && depthOk(i.depth, d));
      const it = rng.weighted(cands, (i) => floorDiv(100, i.rarity));
      kind = it?.id ?? null;
    }
    if (!kind) continue;
    const def = content.items[kind];
    let qty = 1;
    // 投擲用の品の 1 山（V3-4b §28.6 で 2〜6 → 1〜4）
    const ts = content.balance.loot;
    if (def.stack) qty = def.category === 'throwing' ? rng.range(ts.throwStackMin, Math.max(ts.throwStackMin, ts.throwStackMax)) : rng.chance(20) ? 2 : 1;
    const affixes: string[] = [];
    const good = () => rng.weighted(content.lists.affixes.filter((x) => x.target === 'item' && !x.cursed && x.categories.includes(def.category) && d >= x.depth.min), (x) => floorDiv(100, x.rarity));
    if (def.equip && rng.chance(table.affixChancePct)) {
      const a = good();
      if (a) affixes.push(a.id);
    }
    // 呪い（V3-4 §4.4）: 装備品が呪われる。呪いは見えない接辞（hidden）に入り、呪われた品は必ず良い接辞も持つ（「強いかもしれないが外せないかもしれない」）
    if (def.equip && rng.chance(content.balance.curse.chancePct)) {
      const c = rng.weighted(content.lists.affixes.filter((x) => x.target === 'item' && x.cursed && x.categories.includes(def.category) && d >= x.depth.min), (x) => floorDiv(100, x.rarity));
      if (c) {
        if (!affixes.length) { const a = good(); if (a) affixes.push(a.id); }
        return { kind, qty, affixes, hidden: [c.id] };
      }
    }
    if (def.value) {
      // 宝の価値: dice × mult を深さで伸ばす（見えた時点で分かる）
      const v = floorDiv(roll(rng, def.value.dice) * def.value.mult * (100 + depth * def.value.perDepthPct), 100);
      return { kind, qty, affixes, value: Math.max(1, v) };
    }
    return { kind, qty, affixes };
  }
  return null;
}

function placePrefabs(s: GenState): void {
  const rng = s.stream('prefab');
  const ft = s.floorType;
  const cands = s.content.lists.prefabs.filter((p) => depthOk(p.depth, s.depth) && p.tags.some((t) => ft.prefabs.tags.includes(t)));
  if (!cands.length) return;
  const count = rng.range(ft.prefabs.min, ft.prefabs.max);
  const g = s.grid;
  for (let k = 0; k < count; k++) {
    const pf = rng.weighted(cands, (p) => p.weight);
    if (!pf) break;
    const map = transformPrefab(pf.map, pf.rotate ? rng.int(4) : 0, pf.flip ? rng.chance(50) : false);
    const ph = map.length, pw = map[0].length;
    let placed = false;
    for (let tries = 0; tries < 40 && !placed; tries++) {
      // 部屋レイアウトなら部屋の内側を優先
      const rooms = g.regions.filter((r) => r.kind === 'room' && r.w >= pw && r.h >= ph);
      let x0: number, y0: number;
      if (rooms.length && tries < 25) {
        const r = rooms[rng.int(rooms.length)];
        x0 = r.x + rng.int(r.w - pw + 1);
        y0 = r.y + rng.int(r.h - ph + 1);
      } else {
        x0 = rng.range(2, g.w - pw - 2);
        y0 = rng.range(2, g.h - ph - 2);
      }
      if (x0 < 1 || y0 < 1 || x0 + pw > g.w - 1 || y0 + ph > g.h - 1) continue;
      let clash = false;
      for (let y = y0 - 1; y <= y0 + ph && !clash; y++) for (let x = x0 - 1; x <= x0 + pw; x++) if (g.protect[g.idx(x, y)]) { clash = true; break; }
      if (clash) continue;
      stampPrefab(s, pf, map, x0, y0);
      placed = true;
    }
  }
}

function stampPrefab(s: GenState, pf: PrefabDef, map: string[], x0: number, y0: number): void {
  const g = s.grid;
  const rng = s.stream('prefab');
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[0].length; x++) {
      const ch = map[y][x];
      if (ch === ' ') continue;
      const cell = pf.legend[ch];
      const gx = x0 + x, gy = y0 + y;
      const i = g.idx(gx, gy);
      g.protect[i] = 1;
      g.override.delete(i);
      const t = cell.terrain ?? '$floor';
      if (t === '$wall') g.cells[i] = WALL;
      else if (t === '$door') g.cells[i] = DOOR;
      else if (t === '$floor') g.cells[i] = FLOOR;
      else {
        g.cells[i] = FLOOR;
        g.override.set(i, t);
      }
      if (cell.feature) s.spawns.push({ type: 'feature', kind: cell.feature, x: gx, y: gy });
      if (cell.monster) {
        const mrng = s.stream('monsters');
        const pick = cell.monster === '$spawn' ? pickMonster(s, mrng) : { def: s.content.monsters[cell.monster], tier: 0 };
        if (pick) s.spawns.push(monsterSpec(s, pick.def, pick.tier, gx, gy, cell.asleep ?? mrng.chance(pick.def.sleepPct), mrng));
      }
      if (cell.item) {
        const irng = s.stream('items');
        if (cell.item === '$loot') {
          const l = pickLoot(s.content, cell.loot ?? 'core:common_loot', s.depth, irng);
          if (l) s.spawns.push({ type: 'item', kind: l.kind, x: gx, y: gy, qty: l.qty, affixes: l.affixes, value: l.value, ...(l.hidden ? { hidden: l.hidden } : {}) });
        } else s.spawns.push({ type: 'item', kind: cell.item, x: gx, y: gy, qty: 1, affixes: [] });
      }
    }
  }
  g.regions.push({ id: g.regions.length, kind: 'prefab', x: x0, y: y0, w: map[0].length, h: map.length, tags: [pf.id, ...pf.tags] });
  void rng;
}

function monsterSpec(s: Pick<GenState, 'content' | 'depth'>, def: MonsterDef, tier: number, x: number, y: number, asleep: boolean, rng: Rng): SpawnSpec {
  return {
    type: 'monster', kind: def.id, x, y, hp: Math.max(1, roll(rng, def.stats.hp)),
    affixes: rollMonsterAffixes(s.content, s.depth, rng), tier, asleep, delay: rng.int(100),
  };
}

function applyBiomeExtras(s: GenState): void {
  const g = s.grid;
  const rng = s.stream('features');
  const floorCount = g.floorCells().length;
  for (const ex of s.biome.palette.extra) {
    const target = floorDiv(floorCount * ex.pct, 100);
    if (target <= 0) continue;
    const tdef = s.content.terrain[s.content.terrainIndex[ex.terrain]];
    const blocking = !tdef.passable;
    const ok = (i: number) => {
      if (g.cells[i] !== FLOOR || g.protect[i] || g.override.has(i)) return false;
      if (!blocking) return true;
      const x = i % g.w, y = (i - x) / g.w;
      return DIRS.every((d) => g.get(x + DIR_VEC[d][0], y + DIR_VEC[d][1]) === FLOOR && !g.override.has(g.idx(x + DIR_VEC[d][0], y + DIR_VEC[d][1])));
    };
    let placed = 0;
    const clusters = Math.max(1, ex.clusters);
    for (let c = 0; c < clusters && placed < target; c++) {
      const cells = g.floorCells().filter(ok);
      if (!cells.length) break;
      let cur = cells[rng.int(cells.length)];
      const quota = floorDiv(target, clusters) + 1;
      for (let n = 0; n < quota * 4 && placed < target; n++) {
        if (ok(cur)) { g.override.set(cur, ex.terrain); placed++; }
        const x = cur % g.w, y = (cur - x) / g.w;
        const d = DIRS[rng.int(8)];
        const nx = x + DIR_VEC[d][0], ny = y + DIR_VEC[d][1];
        if (g.inside(nx, ny) && g.get(nx, ny) === FLOOR) cur = g.idx(nx, ny);
      }
    }
  }
}

function placeStairs(s: GenState): void {
  const g = s.grid;
  const rng = s.stream('layout');
  const cand = g.floorCells().filter((i) => !g.protect[i] && !g.override.has(i));
  if (!cand.length) return;
  const e = cand[rng.int(cand.length)];
  s.entry = { x: e % g.w, y: Math.trunc(e / g.w) };
  if (s.depth > 1) {
    s.up = { ...s.entry };
    g.override.set(e, 'core:stairs_up');
  }
  // 下り階段: 到着地点からの歩行距離が pacing.stairsPath に収まるセル（指定が無ければ入口から遠いセル）
  const dist = bfsDist(g, e, s.passable);
  const reach = cand.filter((i) => dist[i] > 0).sort((a, b) => dist[a] - dist[b] || a - b);
  if (!reach.length) return;
  const sp = s.pacing.stairsPath;
  const inRange = sp ? reach.filter((i) => dist[i] >= sp.min && dist[i] <= sp.max) : [];
  const pool = inRange.length ? inRange : reach.slice(Math.trunc(reach.length * 0.7));
  const d = pool[rng.int(pool.length)];
  s.down = [{ x: d % g.w, y: Math.trunc(d / g.w) }];
  g.override.set(d, 'core:stairs_down');
}

export function bfsDist(g: GenGrid, start: number, passable: (i: number) => boolean): Int32Array {
  const dist = new Int32Array(g.w * g.h).fill(-1);
  dist[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const cx = c % g.w, cy = (c - cx) / g.w;
    for (const d of DIRS) {
      const nx = cx + DIR_VEC[d][0], ny = cy + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= g.w || ny >= g.h) continue;
      const ni = ny * g.w + nx;
      if (dist[ni] >= 0 || !passable(ni)) continue;
      dist[ni] = dist[c] + 1;
      q.push(ni);
    }
  }
  return dist;
}

function populate(s: GenState): void {
  const g = s.grid;
  const ft = s.floorType;
  const dist = bfsDist(g, g.idx(s.entry.x, s.entry.y), s.passable);
  const occupied = new Set<number>(s.spawns.map((sp) => g.idx(sp.x, sp.y)));
  for (const p of [s.entry, ...s.down, ...(s.up ? [s.up] : [])]) occupied.add(g.idx(p.x, p.y));
  const isStairs = (i: number) => {
    const o = g.override.get(i);
    return o !== undefined && !!s.content.terrain[s.content.terrainIndex[o]].stairs;
  };
  const spawnable: number[] = [];
  for (let i = 0; i < g.cells.length; i++) {
    if (s.passable(i) && dist[i] > 0 && !g.protect[i] && !occupied.has(i) && !isStairs(i) && g.cells[i] !== DOOR) spawnable.push(i);
  }
  const spawnableSet = new Set(spawnable);
  const farFromEntry = spawnable.filter((i) => Math.max(Math.abs((i % g.w) - s.entry.x), Math.abs(Math.trunc(i / g.w) - s.entry.y)) > 7);
  const take = (pool: number[], rng: Rng): number | null => {
    for (let tries = 0; tries < 30 && pool.length; tries++) {
      const i = pool[rng.int(pool.length)];
      if (!occupied.has(i)) { occupied.add(i); return i; }
    }
    return null;
  };
  const floorCount = spawnable.length;

  // モンスター
  const mrng = s.stream('monsters');
  if (s.pacing.monstersPer1000 > 0) {
    let n = floorDiv(floorCount * s.pacing.monstersPer1000, 1000) + floorDiv(s.depth, 3) + mrng.range(-1, 2);
    if (s.mods) n = floorDiv(n * s.mods.monstersPct, 100);
    n = Math.max(1, n);
    for (let k = 0; k < n; k++) {
      const pick = pickMonster(s, mrng);
      if (!pick) break;
      const at = take(farFromEntry, mrng);
      if (at === null) break;
      const x = at % g.w, y = Math.trunc(at / g.w);
      const asleep = mrng.chance(pick.def.sleepPct);
      s.spawns.push(monsterSpec(s, pick.def, pick.tier, x, y, asleep, mrng));
      if (pick.def.group) {
        // 浅い階の群れは小さく: 群れの数の上限は min(種族の上限, 深度 + 1)（V3-2R2 §18.2）
        const cap = Math.max(1, s.depth + 1);
        const size = mrng.range(Math.min(pick.def.group.min, cap), Math.min(pick.def.group.max, cap)) - 1;
        for (let m = 0; m < size; m++) {
          const near = DIRS.map((d) => g.idx(x + DIR_VEC[d][0], y + DIR_VEC[d][1])).filter((i) => spawnableSet.has(i) && !occupied.has(i));
          if (!near.length) break;
          const ni = near[mrng.int(near.length)];
          occupied.add(ni);
          s.spawns.push(monsterSpec(s, pick.def, pick.tier, ni % g.w, Math.trunc(ni / g.w), asleep, mrng));
        }
      }
    }
  }

  // アイテム
  const irng = s.stream('items');
  let ni = floorDiv(floorCount * s.pacing.itemsPer1000, 1000) + irng.range(0, 2);
  if (s.mods) ni = floorDiv(ni * s.mods.itemsPct, 100);
  for (let k = 0; k < ni; k++) {
    const l = pickLoot(s.content, ft.items.table, s.depth, irng);
    if (!l) continue;
    const at = take(spawnable, irng);
    if (at === null) break;
    s.spawns.push({ type: 'item', kind: l.kind, x: at % g.w, y: Math.trunc(at / g.w), qty: l.qty, affixes: l.affixes, value: l.value, ...(l.hidden ? { hidden: l.hidden } : {}) });
  }
  // 条件「宝が多い」: 宝を追加で置く（treasurePct 150 で 1 個、以後 50 ごとに 1 個）
  if (s.mods && s.mods.treasurePct > 100) {
    const extra = 1 + floorDiv(Math.max(0, s.mods.treasurePct - 150), 50);
    for (let k = 0; k < extra; k++) {
      const l = pickLoot(s.content, 'core:treasure_loot', s.depth, irng);
      const at = take(spawnable, irng);
      if (!l || at === null) break;
      s.spawns.push({ type: 'item', kind: l.kind, x: at % g.w, y: Math.trunc(at / g.w), qty: l.qty, affixes: l.affixes, value: l.value });
    }
  }

  // 地物・罠
  const frng = s.stream('features');
  const feats: string[] = [...ft.guaranteedFeatures];
  for (const bf of s.biome.features) if (frng.chance(bf.chancePct)) feats.push(bf.feature);
  for (const f of feats) {
    const roomCells = spawnable.filter((i) => g.regions.some((r) => r.kind === 'room' && i % g.w >= r.x && i % g.w < r.x + r.w && Math.trunc(i / g.w) >= r.y && Math.trunc(i / g.w) < r.y + r.h));
    const at = take(roomCells.length ? roomCells : spawnable, frng);
    if (at !== null) s.spawns.push({ type: 'feature', kind: f, x: at % g.w, y: Math.trunc(at / g.w) });
  }
  const traps = s.content.lists.features.filter((f) => f.category === 'trap' && depthOk(f.depth, s.depth));
  const nt = s.pacing.trapsPer1000 > 0 ? floorDiv(floorCount * s.pacing.trapsPer1000, 1000) + frng.range(0, 1) : 0;
  for (let k = 0; k < nt && traps.length; k++) {
    const tr = frng.weighted(traps, (t) => floorDiv(100, t.rarity));
    const at = take(farFromEntry, frng);
    if (!tr || at === null) break;
    s.spawns.push({ type: 'feature', kind: tr.id, x: at % g.w, y: Math.trunc(at / g.w) });
  }
}

/** 守護者になれない行動様式（動かない・逃げ回るものは討伐目標に向かない） */
const GUARDIAN_EXCLUDED_ARCHETYPES = new Set(['stationary', 'skittish']);

/**
 * 守護者の候補（V3-2R3 §20.1）: その階の生成表のタグに合い、その深度の重みが正の種族から、vermin と動かない・逃げ回る型を除く。
 * 格 1 は経験値の下位半分（射撃して距離を取る型も除く）、格 2・3 は上位半分（切り上げ）
 */
export function guardianCandidates(content: Content, floorType: FloorTypeDef, biome: BiomeDef, depth: number, rank: 1 | 2 | 3): MonsterDef[] {
  // 格で引く表の深さを変える（格 1 は目標の深度の下位半分、格 2 は +1、格 3 は +2 の表の上位半分。V3-4b §28.2）
  const ranks = content.balance.guardian.ranks;
  const tableDepth = ranks[Math.min(ranks.length, rank) - 1]?.tableDepth ?? 0;
  const effective = Math.min(depth + tableDepth, content.deepestDefined);
  const table = content.spawnTables[floorType.monsters.table];
  let cands = content.lists.monsters
    .filter((m) => (!table?.tagsAny.length || m.tags.some((t) => table.tagsAny.includes(t))) && !(table?.tagsNone ?? []).some((t) => m.tags.includes(t)))
    .filter((m) => !GUARDIAN_EXCLUDED_ARCHETYPES.has(m.ai.archetype) && !m.tags.includes('vermin') && monsterWeight(m, effective, biome) > 0);
  if (rank === 1) cands = cands.filter((m) => m.ai.archetype !== 'ranged_kiter');
  cands.sort((a, b) => b.xp - a.xp || (a.id < b.id ? -1 : 1));
  const half = Math.max(1, Math.ceil(cands.length / 2));
  return rank === 1 ? cands.slice(cands.length - half) : cands.slice(0, half);
}

/** 守護者の種族を選ぶ（候補を作るときと生成時で同じ規則）。階の種類と地形は深度とシードから決まる */
export function pickGuardianKind(content: Content, seed: string, branch: string, depth: number, rank: 1 | 2 | 3, rng: Rng): string | null {
  const c = guardianCandidates(content, selectFloorType(content, seed, branch, depth), selectBiome(content, seed, branch, depth), depth, rank);
  if (c.length) return c[rng.int(c.length)].id;
  const def = content.lists.monsters.find((m) => !GUARDIAN_EXCLUDED_ARCHETYPES.has(m.ai.archetype) && depthOk(m.depth, Math.min(depth, content.deepestDefined)))
    ?? content.lists.monsters.find((m) => !GUARDIAN_EXCLUDED_ARCHETYPES.has(m.ai.archetype));
  return def?.id ?? null;
}

/** 守護者の生成仕様（生成時と、生成済みの階に遠征の開始時に置くときで共用）。格で体力の上乗せと下限が決まる */
export function guardianSpec(content: Content, depth: number, kind: string, rank: 1 | 2 | 3, x: number, y: number, rng: Rng): SpawnSpec {
  const def = content.monsters[kind];
  const tier = depth > content.deepestDefined ? floorDiv(depth - content.deepestDefined, 5) + 1 : 0;
  const spec = monsterSpec({ content, depth }, def, tier, x, y, false, rng);
  if (spec.type === 'monster') {
    const guardAffix = content.lists.affixes.find((a) => a.target === 'guardian');
    spec.affixes = [...(guardAffix ? [guardAffix.id] : []), ...spec.affixes];
    spec.role = 'guardian';
    const gb = content.balance.haul.guardianBounty;
    spec.bounty = gb.base + gb.perDepth * depth;
    const ranks = content.balance.guardian.ranks;
    const r = ranks[Math.min(ranks.length, rank) - 1];
    spec.hpBonusPct = r.hpPct;
    spec.minHp = r.minHpBase + r.minHpPerDepth * depth;
  }
  return spec;
}

/**
 * 遠征の目標階の専用段: 守護者・遺物を入口から離れた到達可能なセルに置く。
 * 乱数は 'objective' ストリームだけを使う（他の段の結果は変わらない）。
 */
function placeObjective(s: GenState, obj: ObjectiveSpec): boolean {
  const g = s.grid;
  const rng = s.stream('objective');
  const dist = bfsDist(g, g.idx(s.entry.x, s.entry.y), s.passable);
  const occupied = new Set<number>(s.spawns.map((sp) => g.idx(sp.x, sp.y)));
  for (const p of [s.entry, ...s.down, ...(s.up ? [s.up] : [])]) occupied.add(g.idx(p.x, p.y));
  const isStairs = (i: number) => {
    const o = g.override.get(i);
    return o !== undefined && !!s.content.terrain[s.content.terrainIndex[o]].stairs;
  };
  const ok = (i: number, minDist: number) => s.passable(i) && dist[i] >= minDist && !occupied.has(i) && !isStairs(i) && g.cells[i] !== DOOR
    && cheb({ x: i % g.w, y: Math.trunc(i / g.w) }, s.entry) > 7;
  let cands: number[] = [];
  for (const minDist of [12, 8, 1]) {
    cands = [];
    for (let i = 0; i < g.cells.length; i++) if (ok(i, minDist)) cands.push(i);
    if (cands.length) break;
  }
  if (!cands.length) return false;
  // 遠い側の半分から選ぶ
  cands.sort((a, b) => dist[a] - dist[b] || a - b);
  const far = cands.slice(Math.trunc(cands.length / 2));
  const at = far[rng.int(far.length)];
  const ax = at % g.w, ay = Math.trunc(at / g.w);
  occupied.add(at);
  if (obj.relic) s.spawns.push({ type: 'item', kind: 'core:relic', x: ax, y: ay, qty: 1, affixes: [], role: 'relic' });
  if (obj.guardian) {
    let gx = ax, gy = ay;
    if (obj.relic) {
      const near = DIRS.map((d) => g.idx(ax + DIR_VEC[d][0], ay + DIR_VEC[d][1])).filter((i) => ok(i, 1));
      if (!near.length) return false;
      const ni = near[rng.int(near.length)];
      gx = ni % g.w; gy = Math.trunc(ni / g.w);
    }
    // 守護者の種族と格（V3-2R3 §20.1）: 候補で決めた種族があればそれ、無ければ格の規則で選ぶ
    const rank = obj.rank ?? 2;
    const kind = obj.guardianKind && s.content.monsters[obj.guardianKind]
      ? obj.guardianKind
      : (() => {
        const c = guardianCandidates(s.content, s.floorType, s.biome, s.depth, rank);
        return c.length ? c[rng.int(c.length)].id : pickGuardianKind(s.content, s.seed, s.branch, s.depth, rank, rng);
      })();
    if (!kind) return false;
    s.spawns.push(guardianSpec(s.content, s.depth, kind, rank, gx, gy, rng));
  }
  return true;
}

// ---- validators ----
validators.register('stairs_connected', (s) => {
  const g = s.grid;
  if (!s.down.length) return false;
  const dist = bfsDist(g, g.idx(s.entry.x, s.entry.y), s.passable);
  return [...s.down, ...(s.up ? [s.up] : [])].every((p) => dist[g.idx(p.x, p.y)] >= 0);
});
validators.register('start_safe', (s) => {
  if (!s.passable(s.grid.idx(s.entry.x, s.entry.y))) return false;
  return !s.spawns.some((sp) => sp.type === 'monster' && Math.max(Math.abs(sp.x - s.entry.x), Math.abs(sp.y - s.entry.y)) <= 6);
});
validators.register('min_floor_area', (s) => {
  let n = 0;
  for (let i = 0; i < s.grid.cells.length; i++) if (s.passable(i)) n++;
  return n * 100 >= s.grid.w * s.grid.h * 15;
});
/** 到着地点から下り階段までの歩行距離が pacing.stairsPath に収まる（指定がある帯のみ。全ての階に暗黙に適用） */
validators.register('stairs_path', (s) => {
  const sp = s.pacing.stairsPath;
  if (!sp) return true;
  if (!s.down.length) return false;
  const dist = bfsDist(s.grid, s.grid.idx(s.entry.x, s.entry.y), s.passable);
  return s.down.every((p) => {
    const d = dist[s.grid.idx(p.x, p.y)];
    return d >= sp.min && d <= sp.max;
  });
});

export const MAX_ATTEMPTS = 8;

export function generateFloor(content: Content, seed: string, branch: string, depth: number, terrainTable: string[], objective?: ObjectiveSpec, mods?: GenMods): GeneratedFloor {
  const floorType = selectFloorType(content, seed, branch, depth);
  const biome = selectBiome(content, seed, branch, depth);
  const pacing = resolvePacing(floorType, depth);
  const { w, h } = pacing.size;
  for (let attempt = 0; attempt <= MAX_ATTEMPTS; attempt++) {
    const stream = streamFor(seed, branch, depth, attempt);
    const fallback = attempt === MAX_ATTEMPTS;
    const layoutRng = stream('layout');
    const layouts = floorType.layouts ?? biome.layouts;
    const layoutId = fallback ? 'core:fallback' : (layoutRng.weighted(Object.keys(layouts).sort(), (k) => layouts[k]) ?? 'core:rooms_corridors');
    const grid = layoutGenerators.get(layoutId)({ w, h, rng: layoutRng });
    const s: GenState = {
      content, seed, branch, depth, attempt, floorType, biome, pacing, grid, ...(mods ? { mods } : {}),
      entry: { x: 1, y: 1 }, up: null, down: [], spawns: [], stream,
      passable: (i: number) => {
        const o = grid.override.get(i);
        if (o !== undefined) return content.terrain[content.terrainIndex[o]].passable;
        return grid.cells[i] !== WALL;
      },
    };
    if (!fallback) placePrefabs(s);
    grid.connectAll(layoutRng, s.passable);
    if (!fallback) applyBiomeExtras(s);
    placeStairs(s);
    populate(s);
    if (objective && !placeObjective(s, objective) && !fallback) continue;
    // 条件「泉が無い」
    if (mods?.noFountain) s.spawns = s.spawns.filter((sp) => !(sp.type === 'feature' && sp.kind.includes('fountain')));
    const vs = fallback ? ['stairs_connected'] : [...floorType.validators, 'stairs_path'];
    if (!fallback && !vs.every((v) => validators.get(v)(s))) continue;
    // 地形 index へ変換
    const tIdx = (id: string) => {
      const i = terrainTable.indexOf(id);
      if (i < 0) throw new Error(`terrain ${id} not in table`);
      return i;
    };
    const pal = { [WALL]: tIdx(biome.palette.wall), [FLOOR]: tIdx(biome.palette.floor), [DOOR]: tIdx(biome.palette.doorClosed) } as Record<number, number>;
    const terrain = new Array<number>(w * h);
    for (let i = 0; i < w * h; i++) {
      const o = grid.override.get(i);
      terrain[i] = o !== undefined ? tIdx(o) : pal[grid.cells[i]];
    }
    const key = floorKey(branch, depth);
    const regions: Region[] = grid.regions.map((r) => ({ ...r, tags: [...r.tags] }));
    const floor: Floor = {
      key, branch, depth, biome: biome.id, floorType: floorType.id, width: w, height: h,
      time: 0, terrain, regions, entry: s.entry, stairs: { up: s.up, down: s.down },
      currentActor: null, nextWanderAt: content.balance.wander.firstAt, rules: { noWander: floorType.rules.noWander },
    };
    // 決定的な順序（生成順のまま）
    return { floor, spawns: s.spawns, attempts: attempt + 1, layout: layoutId };
  }
  throw new Error('unreachable: fallback must succeed');
}

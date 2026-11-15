// Observation: PlayerView に AI が使いやすい派生情報を足して整形したもの。
// 派生情報は PlayerView（とカタログ）だけから計算する。仕様: docs/PROTOCOL.md §3
import type { Catalog } from './catalog';
import { nameOf } from './catalog';
import type { PerceivedEvent } from './filter';
import { kindName } from './narrate';
import type { NavGrid } from './nav';
import { buildNavGrid, distanceField, findFrontiers } from './nav';
import type { Dir, Locale, Pos } from './types';
import { DIRS, DIR_VEC } from './types';
import { cheb, ceilDiv, dirTo, t } from './util';
import type { EntityView, HpState, ItemView, PlayerView, ViewStatus } from './view';
import { xpForLevel } from './view';

export interface Alert { code: string; text: string; entity?: string }

export interface ObsMonster {
  id: string; name: string; pos: Pos; dir: Dir | null; dist: number;
  hp_state: HpState; awareness: string; threat: 1 | 2 | 3 | 4 | 5; statuses: string[];
}
export interface ObsItem { id: string; name: string; pos: Pos; dir: Dir | null; dist: number; qty: number; remembered?: boolean }
export interface ObsPlayer { id: string; name: string; pos: Pos; dir: Dir | null; dist: number; hp_state: HpState }
export interface ObsFeature { type: string; name: string; pos: Pos; dir: Dir | null; dist: number; state?: string }
export interface ObsInvItem { slot: string; name: string; qty: number; category: string; identified: boolean; equipped: boolean }

export interface Observation {
  seq: number;
  status: ViewStatus;
  summary: string;
  alerts: Alert[];
  self: {
    name: string; class: string; level: number; xp: number; xp_next: number;
    hp: number; max_hp: number; statuses: { id: string; name: string; turns_left: number }[];
    pos: Pos | null; floor: { depth: number; biome_name: string; floor_type: string; time: number } | null;
    attack: { acc: number; dmg: string }; defense: { eva: number; armor: number };
    equipment: { weapon?: string; armor?: string; accessory?: string };
    inventory_count: number; inventory_capacity: number;
    inventory_brief?: string;
    inventory?: ObsInvItem[];
  };
  visible: { monsters: ObsMonster[]; items: ObsItem[]; players: ObsPlayer[]; features: ObsFeature[] };
  navigation: {
    here: string;
    passable_dirs: Dir[];
    frontiers: { pos: Pos; dir: Dir | null; dist: number }[];
    known_stairs: { type: 'down' | 'up'; pos: Pos; dist: number; reachable: boolean }[];
  };
  recent_events: string[];
  map?: { origin: Pos; rows: string[]; legend: Record<string, string> };
  valid_actions: string[];
}

export interface ObservationOptions {
  detail: 'brief' | 'full';
  map: boolean;
  mapWidth?: number;
  mapHeight?: number;
  recent?: PerceivedEvent[];
}

const DIR_JA: Record<Dir, string> = { n: '北', ne: '北東', e: '東', se: '南東', s: '南', sw: '南西', w: '西', nw: '北西' };

export function dirLabel(locale: Locale, d: Dir | null): string {
  if (!d) return t(locale, '足元', 'here');
  return locale === 'en' ? d : DIR_JA[d];
}

/** "東8南4" のような相対位置 */
export function relLabel(locale: Locale, from: Pos, to: Pos): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const parts: string[] = [];
  if (locale === 'en') {
    if (dy < 0) parts.push(`${-dy}N`);
    if (dy > 0) parts.push(`${dy}S`);
    if (dx > 0) parts.push(`${dx}E`);
    if (dx < 0) parts.push(`${-dx}W`);
    return parts.join(' ') || 'here';
  }
  if (dx > 0) parts.push(`東${dx}`);
  if (dx < 0) parts.push(`西${-dx}`);
  if (dy < 0) parts.push(`北${-dy}`);
  if (dy > 0) parts.push(`南${dy}`);
  return parts.join('') || '足元';
}

const HP_JA: Record<HpState, string> = { healthy: '健康', wounded: '軽傷', badly_wounded: '重傷', near_death: '瀕死' };
const AW_JA: Record<string, string> = { asleep: '睡眠中', unaware: '未察知', hunting: '追跡中' };

export function itemDisplayName(catalog: Catalog, locale: Locale, kind: string | null, appearanceId: string | null, affixes: readonly string[] = []): string {
  const base = kindName(catalog, locale, kind, appearanceId);
  if (!affixes.length || !kind) return base;
  const af = affixes.map((a) => nameOf(catalog.affixes[a]?.name, locale, a));
  return locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`;
}

export function monsterDisplayName(catalog: Catalog, locale: Locale, e: EntityView): string {
  const base = kindName(catalog, locale, e.kind);
  const af = (e.affixes ?? []).map((a) => nameOf(catalog.affixes[a]?.name, locale, a));
  const tier = e.tier ? `+${e.tier}` : '';
  if (!af.length) return base + tier;
  return (locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`) + tier;
}

function itemCategory(catalog: Catalog, kind: string | null, appearanceId: string | null): string {
  if (kind && catalog.items[kind]) return catalog.items[kind].category;
  if (appearanceId && catalog.appearances[appearanceId]) return catalog.appearances[appearanceId].category;
  return 'misc';
}

export function threatOf(view: PlayerView, e: EntityView): 1 | 2 | 3 | 4 | 5 {
  const mem = e.kind ? view.monsterMemory[e.kind] : undefined;
  const depth = view.floor?.depth ?? 1;
  let est = mem && mem.maxDamageToYou > 0 ? mem.maxDamageToYou : 2 + depth;
  if (e.tier) est += e.tier * 2;
  if (e.affixes?.length) est += e.affixes.length;
  const hits = ceilDiv(Math.max(1, view.self.stats.hp), Math.max(1, est));
  let th = hits <= 1 ? 5 : hits <= 2 ? 4 : hits <= 4 ? 3 : hits <= 7 ? 2 : 1;
  if (e.awareness === 'asleep' && th > 1) th -= 1;
  return th as 1 | 2 | 3 | 4 | 5;
}

const ITEM_GLYPH: Record<string, string> = { potion: '!', scroll: '?', weapon: ')', armor: '[', throwing: '/', accessory: '"' };

function terrainGlyph(catalog: Catalog, id: string | undefined): string {
  if (!id) return ' ';
  const tr = catalog.terrain[id];
  if (!tr) return '?';
  if (tr.stairs === 'down') return '>';
  if (tr.stairs === 'up') return '<';
  if (tr.door === 'closed') return '+';
  if (tr.door === 'open') return "'";
  if (tr.tags.includes('water')) return '~';
  if (tr.tags.includes('tall_grass')) return '%';
  if (tr.tags.includes('grass')) return ',';
  if (!tr.passable) return tr.opaque ? '#' : '0';
  return '.';
}

function monsterGlyph(catalog: Catalog, kind: string | null): string {
  const en = kind ? catalog.monsters[kind]?.name.en : undefined;
  return en ? en[0].toUpperCase() : 'M';
}

function featureGlyph(catalog: Catalog, kind: string | null): string {
  if (!kind) return '*';
  const f = catalog.features[kind];
  if (f?.category === 'trap') return '^';
  if (kind.includes('fountain')) return '{';
  if (kind.includes('altar')) return '_';
  return '*';
}

function termName(catalog: Catalog, locale: Locale, id: string | undefined): string {
  return id ? nameOf(catalog.terrain[id]?.name, locale, id) : t(locale, '未知', 'unknown');
}

interface MapResult { origin: Pos; rows: string[]; legend: Record<string, string> }

export function renderAsciiMap(view: PlayerView, catalog: Catalog, region: { x: number; y: number; w: number; h: number }): MapResult {
  const L = view.locale;
  const f = view.floor!;
  const legend: Record<string, string> = {};
  const addLegend = (ch: string, name: string) => {
    if (ch === ' ') return;
    const cur = legend[ch];
    if (!cur) legend[ch] = name;
    else if (!cur.split('/').includes(name)) legend[ch] = `${cur}/${name}`;
  };
  const overlay = new Map<number, { ch: string; name: string }>();
  for (const r of view.memory.remembered) {
    const i = r.pos.y * f.width + r.pos.x;
    if (r.cat === 'item') overlay.set(i, { ch: ITEM_GLYPH[itemCategory(catalog, r.kind, r.appearanceId)] ?? '*', name: itemDisplayName(catalog, L, r.kind, r.appearanceId) });
    else overlay.set(i, { ch: featureGlyph(catalog, r.kind), name: kindName(catalog, L, r.kind) });
  }
  const layerOrder: EntityView['cat'][] = ['feature', 'trap', 'item', 'monster', 'player'];
  for (const cat of layerOrder) {
    for (const e of view.entities) {
      if (e.cat !== cat) continue;
      const i = e.pos.y * f.width + e.pos.x;
      if (cat === 'item') overlay.set(i, { ch: ITEM_GLYPH[itemCategory(catalog, e.kind, e.appearanceId)] ?? '*', name: itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes) });
      else if (cat === 'feature' || cat === 'trap') overlay.set(i, { ch: featureGlyph(catalog, e.kind), name: kindName(catalog, L, e.kind) });
      else if (cat === 'monster') overlay.set(i, { ch: monsterGlyph(catalog, e.kind), name: kindName(catalog, L, e.kind) });
      else overlay.set(i, { ch: '&', name: e.name ?? t(L, '味方', 'ally') });
    }
  }
  if (view.self.pos) overlay.set(view.self.pos.y * f.width + view.self.pos.x, { ch: '@', name: t(L, '自分', 'you') });
  const rows: string[] = [];
  for (let y = region.y; y < region.y + region.h; y++) {
    let row = '';
    for (let x = region.x; x < region.x + region.w; x++) {
      if (x < 0 || y < 0 || x >= f.width || y >= f.height) { row += ' '; continue; }
      const i = y * f.width + x;
      const ov = overlay.get(i);
      if (ov && view.memory.terrain[i]) {
        row += ov.ch;
        addLegend(ov.ch, ov.name);
        continue;
      }
      const tid = view.terrainTable[view.memory.terrain[i] ?? 0];
      const ch = view.memory.terrain[i] ? terrainGlyph(catalog, tid) : ' ';
      row += ch;
      if (ch !== ' ') addLegend(ch, termName(catalog, L, tid));
    }
    rows.push(row.replace(/\s+$/, ''));
  }
  return { origin: { x: region.x, y: region.y }, rows, legend };
}

export interface ObservationContext {
  grid: NavGrid | null;
  dist: Int32Array | null;
}

export function buildObservation(view: PlayerView, catalog: Catalog, opts: ObservationOptions): Observation {
  const L = view.locale;
  const me = view.self;
  const pos = me.pos;
  const f = view.floor;
  const grid = buildNavGrid(view, catalog);
  const dist = grid && pos ? distanceField(grid, pos, false) : null;
  const pathDist = (p: Pos): number => (dist && f ? dist[p.y * f.width + p.x] : -1);

  const monsters: ObsMonster[] = [];
  const items: ObsItem[] = [];
  const players: ObsPlayer[] = [];
  const features: ObsFeature[] = [];
  const rel = (p: Pos) => ({ dir: pos ? dirTo(pos, p) : null, dist: pos ? cheb(pos, p) : 0 });
  for (const e of view.entities) {
    if (e.cat === 'monster') {
      monsters.push({
        id: e.id, name: monsterDisplayName(catalog, L, e), pos: e.pos, ...rel(e.pos),
        hp_state: e.hp ?? 'healthy', awareness: e.awareness ?? 'unaware', threat: threatOf(view, e),
        statuses: (e.statuses ?? []).map((s) => nameOf(catalog.statuses[s]?.name, L, s)),
      });
    } else if (e.cat === 'item') {
      items.push({ id: e.id, name: itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes), pos: e.pos, ...rel(e.pos), qty: e.qty ?? 1 });
    } else if (e.cat === 'player') {
      players.push({ id: e.id, name: e.name ?? '?', pos: e.pos, ...rel(e.pos), hp_state: e.hp ?? 'healthy' });
    } else {
      features.push({ type: e.kind ?? 'feature', name: kindName(catalog, L, e.kind), pos: e.pos, ...rel(e.pos), state: e.state });
    }
  }
  monsters.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  items.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  // 記憶しているアイテム（視界外）
  const visibleIds = new Set(view.entities.map((e) => e.id));
  for (const r of view.memory.remembered) {
    if (visibleIds.has(r.id)) continue;
    if (r.cat === 'item' && items.length < 12) items.push({ id: r.id, name: itemDisplayName(catalog, L, r.kind, r.appearanceId), pos: r.pos, ...rel(r.pos), qty: r.qty, remembered: true });
    if (r.cat !== 'item') features.push({ type: r.kind ?? 'feature', name: kindName(catalog, L, r.kind), pos: r.pos, ...rel(r.pos), state: r.state });
  }

  // 足元
  let here = '';
  const passable_dirs: Dir[] = [];
  const known_stairs: Observation['navigation']['known_stairs'] = [];
  let frontiers: Observation['navigation']['frontiers'] = [];
  let onStairs: 'up' | 'down' | null = null;
  if (f && pos && grid) {
    const hereIdx = pos.y * f.width + pos.x;
    const hereT = view.terrainTable[view.memory.terrain[hereIdx]];
    onStairs = catalog.terrain[hereT]?.stairs ?? null;
    const hereItems = view.entities.filter((e) => e.cat === 'item' && e.pos.x === pos.x && e.pos.y === pos.y);
    const hereFeat = view.entities.filter((e) => (e.cat === 'feature' || e.cat === 'trap') && e.pos.x === pos.x && e.pos.y === pos.y);
    here = [termName(catalog, L, hereT),
      ...hereFeat.map((e) => kindName(catalog, L, e.kind)),
      ...hereItems.map((e) => itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes) + ((e.qty ?? 1) > 1 ? ` x${e.qty}` : ''))].join(', ');
    for (const d of DIRS) {
      const nx = pos.x + DIR_VEC[d][0];
      const ny = pos.y + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
      if (grid.passable[ny * f.width + nx]) passable_dirs.push(d);
    }
    for (let i = 0; i < view.memory.terrain.length; i++) {
      const tid = view.terrainTable[view.memory.terrain[i]];
      const st = catalog.terrain[tid]?.stairs;
      if (!st) continue;
      const p = { x: i % f.width, y: Math.trunc(i / f.width) };
      const dd = pathDist(p);
      known_stairs.push({ type: st, pos: p, dist: dd >= 0 ? dd : cheb(pos, p), reachable: dd >= 0 });
    }
    known_stairs.sort((a, b) => a.dist - b.dist);
    const fr = findFrontiers(grid)
      .map((i) => ({ pos: { x: i % f.width, y: Math.trunc(i / f.width) }, d: dist ? dist[i] : -1 }))
      .filter((x) => x.d >= 0)
      .sort((a, b) => a.d - b.d || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    // 近接したフロンティアは間引く
    const picked: typeof fr = [];
    for (const c of fr) {
      if (picked.some((p) => cheb(p.pos, c.pos) <= 3)) continue;
      picked.push(c);
      if (picked.length >= 5) break;
    }
    frontiers = picked.map((c) => ({ pos: c.pos, dir: dirTo(pos, c.pos), dist: c.d }));
  }

  // アラート
  const alerts: Alert[] = [];
  const hpPct = me.stats.maxHp > 0 ? Math.trunc((me.stats.hp * 100) / me.stats.maxHp) : 0;
  const hostiles = monsters;
  const adjacent = hostiles.filter((m) => m.dist === 1);
  if (view.status === 'dead') alerts.push({ code: 'dead', text: t(L, 'あなたは死亡している', 'You are dead') });
  if (hpPct < 25) alerts.push({ code: 'critical_hp', text: t(L, `HP が危険域 (${me.stats.hp}/${me.stats.maxHp})`, `HP critical (${me.stats.hp}/${me.stats.maxHp})`) });
  else if (hpPct < 50) alerts.push({ code: 'low_hp', text: t(L, 'HP が半分以下', 'HP below half') });
  if (adjacent.length) {
    alerts.push({
      code: 'enemy_adjacent',
      text: t(L, '敵が隣接: ', 'Adjacent enemy: ') + adjacent.map((m) => `${m.name}(${dirLabel(L, m.dir)})`).join(', '),
      entity: adjacent[0].id,
    });
  }
  const hunting = hostiles.filter((m) => m.awareness === 'hunting');
  if (hunting.length >= 2) alerts.push({ code: 'multiple_enemies', text: t(L, `複数の敵が追跡中 (${hunting.length})`, `${hunting.length} enemies hunting you`) });
  else if (hostiles.length && !adjacent.length) alerts.push({ code: 'enemy_in_view', text: t(L, `敵が視界内: ${hostiles[0].name}`, `Enemy in view: ${hostiles[0].name}`), entity: hostiles[0].id });
  if (me.statuses.some((s) => s.id === 'core:poison')) alerts.push({ code: 'poisoned', text: t(L, '毒に冒されている', 'You are poisoned') });
  if (onStairs) alerts.push({ code: 'on_stairs', text: onStairs === 'down' ? t(L, '下り階段の上にいる', 'You are on stairs down') : t(L, '上り階段の上にいる', 'You are on stairs up') });
  const itemsHere = items.filter((i) => i.dist === 0 && !i.remembered);
  if (itemsHere.length) alerts.push({ code: 'item_here', text: t(L, '足元にアイテム: ', 'Item here: ') + itemsHere.map((i) => i.name).join(', ') });
  if (view.inventory.length >= me.capacity) alerts.push({ code: 'inventory_full', text: t(L, '所持品がいっぱい', 'Inventory full') });
  if ((opts.recent ?? []).some((e) => e.type === 'entity_changed_floor' && (e.event as any).id === me.id)) {
    alerts.push({ code: 'new_floor', text: t(L, '新しい階に到着した', 'Arrived on a new floor') });
  }

  // 自分
  const equipName = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const it = view.inventory.find((i) => i.id === id);
    return it ? itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes) : undefined;
  };
  const invItems: ObsInvItem[] = view.inventory.map((it) => ({
    slot: it.slot, name: itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes), qty: it.qty,
    category: itemCategory(catalog, it.kind, it.appearanceId), identified: it.kind !== null, equipped: it.equipped !== null,
  }));
  const invBrief = invItems.map((i) => `${i.slot})${i.name}${i.qty > 1 ? `x${i.qty}` : ''}${i.equipped ? '*' : ''}`).join(' ');

  const biomeName = f ? nameOf(catalog.biomes[f.biome]?.name, L, f.biome) : '';
  const valid_actions = buildValidActions(view, catalog, { passable_dirs, onStairs, itemsHere: itemsHere.length > 0, hostiles, frontiers: frontiers.length, known_stairs, grid });

  const statusLabel: Record<ViewStatus, [string, string]> = {
    your_turn: ['あなたの番', 'your turn'], waiting_others: ['他プレイヤー待ち', 'waiting for others'], dead: ['死亡', 'dead'], ended: ['ラン終了', 'run ended'],
  };
  const summaryParts = [
    f ? t(L, `地下${f.depth}階 ${biomeName}`, `Depth ${f.depth} ${biomeName}`) : '',
    `HP ${me.stats.hp}/${me.stats.maxHp}`,
    `Lv${me.level}`,
    hostiles.length ? t(L, `敵${hostiles.length}体が視界内`, `${hostiles.length} enemies in view`) : t(L, '敵影なし', 'no enemies in view'),
    statusLabel[view.status][L === 'en' ? 1 : 0],
  ].filter(Boolean);

  const obs: Observation = {
    seq: view.seq,
    status: view.status,
    summary: summaryParts.join(' | '),
    alerts,
    self: {
      name: me.name, class: kindName(catalog, L, me.classId), level: me.level, xp: me.xp, xp_next: xpForLevel(me.level),
      hp: me.stats.hp, max_hp: me.stats.maxHp,
      statuses: me.statuses.map((s) => ({ id: s.id, name: nameOf(catalog.statuses[s.id]?.name, L, s.id), turns_left: s.turnsLeft })),
      pos, floor: f ? { depth: f.depth, biome_name: biomeName, floor_type: nameOf(catalog.floorTypes[f.floorType]?.name, L, f.floorType), time: f.time } : null,
      attack: { acc: me.stats.acc, dmg: `${me.stats.dmg}${me.stats.might ? (me.stats.might > 0 ? `+${me.stats.might}` : `${me.stats.might}`) : ''}` },
      defense: { eva: me.stats.eva, armor: me.stats.armor },
      equipment: { weapon: equipName(me.equip.weapon), armor: equipName(me.equip.armor), accessory: equipName(me.equip.accessory) },
      inventory_count: view.inventory.length, inventory_capacity: me.capacity,
    },
    visible: { monsters, items, players, features },
    navigation: { here, passable_dirs, frontiers, known_stairs },
    recent_events: (opts.recent ?? []).map((e) => e.text).filter((s) => s.length > 0).slice(-10),
    valid_actions,
  };
  if (opts.detail === 'full') obs.self.inventory = invItems;
  else obs.self.inventory_brief = invBrief;
  if (opts.map && f && pos) {
    const w = opts.mapWidth ?? 21;
    const h = opts.mapHeight ?? 15;
    obs.map = renderAsciiMap(view, catalog, { x: pos.x - Math.trunc(w / 2), y: pos.y - Math.trunc(h / 2), w, h });
  }
  return obs;
}

interface VAInput {
  passable_dirs: Dir[]; onStairs: 'up' | 'down' | null; itemsHere: boolean; hostiles: ObsMonster[];
  frontiers: number; known_stairs: Observation['navigation']['known_stairs']; grid: NavGrid | null;
}

function buildValidActions(view: PlayerView, catalog: Catalog, x: VAInput): string[] {
  const L = view.locale;
  const out: string[] = [];
  if (view.status !== 'your_turn' || !view.self.pos || !view.floor) return view.status === 'dead' ? [] : ['observe'];
  const pos = view.self.pos;
  const f = view.floor;
  const byPos = new Map<number, EntityView>();
  for (const e of view.entities) if (e.cat === 'monster' || e.cat === 'player') byPos.set(e.pos.y * f.width + e.pos.x, e);
  for (const d of DIRS) {
    const nx = pos.x + DIR_VEC[d][0];
    const ny = pos.y + DIR_VEC[d][1];
    if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
    const i = ny * f.width + nx;
    const occ = byPos.get(i);
    if (occ?.cat === 'monster') { out.push(`move ${d} (${t(L, '攻撃', 'attack')}: ${monsterDisplayName(catalog, L, occ)})`); continue; }
    if (occ?.cat === 'player') { out.push(`move ${d} (${t(L, '位置交換', 'swap')}: ${occ.name})`); continue; }
    const tid = view.terrainTable[view.memory.terrain[i]];
    const tr = catalog.terrain[tid];
    if (tr?.door === 'closed') { out.push(`move ${d} (${t(L, '扉を開ける', 'open door')})`); continue; }
    if (x.passable_dirs.includes(d)) out.push(`move ${d}`);
  }
  out.push('wait');
  const hunting = x.hostiles.some((m) => m.awareness === 'hunting' || m.dist <= 2);
  if (view.self.stats.hp < view.self.stats.maxHp) out.push(hunting ? `rest (${t(L, '不可: 敵が近い', 'unavailable: enemy nearby')})` : 'rest');
  out.push(x.frontiers > 0 ? 'explore' : `explore (${t(L, '探索済み', 'fully explored')})`);
  if (x.known_stairs.some((s) => s.type === 'down')) out.push('travel_to stairs_down');
  if (x.known_stairs.some((s) => s.type === 'up')) out.push('travel_to stairs_up');
  if (x.onStairs) out.push(`use_stairs (${x.onStairs === 'down' ? t(L, '降りる', 'descend') : t(L, '上る', 'ascend')})`);
  if (x.itemsHere) out.push('pickup');
  for (const it of view.inventory) {
    const name = itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes);
    const cat = itemCategory(catalog, it.kind, it.appearanceId);
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    if (cat === 'potion' || cat === 'scroll' || ci?.usable) out.push(`use_item ${it.slot} (${name})`);
    if (ci?.slot && !it.equipped) out.push(`equip ${it.slot} (${name})`);
    if (x.hostiles.length && cat === 'throwing') out.push(`throw_item ${it.slot} (${name}) -> ${x.hostiles[0].id}`);
  }
  // 隣接する扉・地物
  for (const d of [null, ...DIRS] as (Dir | null)[]) {
    const nx = pos.x + (d ? DIR_VEC[d][0] : 0);
    const ny = pos.y + (d ? DIR_VEC[d][1] : 0);
    if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
    const i = ny * f.width + nx;
    const tr = catalog.terrain[view.terrainTable[view.memory.terrain[i]]];
    if (d && tr?.door === 'open' && !byPos.has(i)) out.push(`interact ${d} (${t(L, '扉を閉める', 'close door')})`);
    for (const e of view.entities) {
      if (e.cat !== 'feature' || e.pos.x !== nx || e.pos.y !== ny) continue;
      const fd = e.kind ? catalog.features[e.kind] : undefined;
      if (fd?.interactable && e.state !== 'used') out.push(`interact${d ? ' ' + d : ''} (${kindName(catalog, L, e.kind)})`);
    }
  }
  return out;
}

export function formatObservationText(obs: Observation, locale: Locale): string {
  const L = locale;
  const lines: string[] = [];
  const s = obs.self;
  const statusText: Record<ViewStatus, [string, string]> = {
    your_turn: ['あなたの番', 'your turn'], waiting_others: ['他プレイヤー待ち', 'waiting for others'], dead: ['死亡', 'dead'], ended: ['ラン終了', 'run ended'],
  };
  const floorText = s.floor ? t(L, `地下${s.floor.depth}階 ${s.floor.biome_name}`, `Depth ${s.floor.depth} ${s.floor.biome_name}`) : '-';
  const posText = s.pos ? t(L, `位置(${s.pos.x},${s.pos.y})`, `pos(${s.pos.x},${s.pos.y})`) : '';
  lines.push(`[seq ${obs.seq} | ${floorText} | HP ${s.hp}/${s.max_hp} | Lv${s.level} | ${posText} | ${statusText[obs.status][L === 'en' ? 1 : 0]}]`);
  if (obs.alerts.length) lines.push('!! ' + obs.alerts.map((a) => a.text).join(' / '));
  const st = s.statuses.length ? s.statuses.map((x) => `${x.name}(${x.turns_left})`).join(' ') : t(L, 'なし', 'none');
  lines.push(t(L,
    `能力: 命中+${s.attack.acc} ダメージ${s.attack.dmg} 回避${s.defense.eva} 装甲${s.defense.armor} XP ${s.xp}/${s.xp_next} 状態:${st}`,
    `Stats: acc+${s.attack.acc} dmg ${s.attack.dmg} eva ${s.defense.eva} armor ${s.defense.armor} XP ${s.xp}/${s.xp_next} status:${st}`));
  const vis = obs.visible;
  if (vis.monsters.length || vis.items.length || vis.players.length || vis.features.length) {
    lines.push(t(L, '見えるもの:', 'In view:'));
    const from = s.pos ?? { x: 0, y: 0 };
    for (const m of vis.monsters) {
      lines.push(L === 'en'
        ? `- ${m.name} ${m.id} (${m.pos.x},${m.pos.y}) ${relLabel(L, from, m.pos)} hp:${m.hp_state} ${m.awareness} threat:${m.threat}${m.statuses.length ? ' ' + m.statuses.join(',') : ''}`
        : `- ${m.name} ${m.id} (${m.pos.x},${m.pos.y}) ${relLabel(L, from, m.pos)}  負傷:${HP_JA[m.hp_state]}  状態:${AW_JA[m.awareness] ?? m.awareness}  脅威:${m.threat}${m.statuses.length ? '  ' + m.statuses.join(',') : ''}`);
    }
    for (const p of vis.players) lines.push(`- ${t(L, '味方', 'ally')} ${p.name} (${p.pos.x},${p.pos.y}) ${relLabel(L, from, p.pos)} ${L === 'en' ? p.hp_state : HP_JA[p.hp_state]}`);
    for (const it of vis.items) lines.push(`- ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''} ${it.id} (${it.pos.x},${it.pos.y}) ${relLabel(L, from, it.pos)}${it.remembered ? t(L, ' (記憶)', ' (remembered)') : ''}`);
    for (const ft of vis.features) lines.push(`- ${ft.name} (${ft.pos.x},${ft.pos.y}) ${relLabel(L, from, ft.pos)}${ft.state && ft.state !== 'idle' ? ` [${ft.state}]` : ''}`);
  }
  const nav = obs.navigation;
  for (const st2 of nav.known_stairs.slice(0, 3)) {
    const name = st2.type === 'down' ? t(L, '下り階段', 'stairs down') : t(L, '上り階段', 'stairs up');
    lines.push(`- ${name} (${st2.pos.x},${st2.pos.y}) ${t(L, '距離', 'dist')}${st2.dist} ${st2.reachable ? t(L, '到達可', 'reachable') : t(L, '到達不明', 'unknown path')}`);
  }
  lines.push(t(L, '足元: ', 'Here: ') + nav.here);
  if (nav.frontiers.length) {
    lines.push(t(L, '未探索: ', 'Unexplored: ') + nav.frontiers.map((fr) => `${dirLabel(L, fr.dir)}(${fr.pos.x},${fr.pos.y}) ${t(L, '距離', 'dist')}${fr.dist}`).join(' / '));
  } else {
    lines.push(t(L, '未探索: なし（このフロアは探索済み）', 'Unexplored: none (floor explored)'));
  }
  if (obs.recent_events.length) {
    lines.push(t(L, '直前の出来事:', 'Recent events:'));
    for (const e of obs.recent_events) lines.push(`- ${e}`);
  }
  const eq = s.equipment;
  lines.push(t(L, '装備: ', 'Equipment: ') + ([eq.weapon, eq.armor, eq.accessory].filter(Boolean).join(', ') || '-'));
  if (s.inventory) {
    lines.push(t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}):`, `Inventory (${s.inventory_count}/${s.inventory_capacity}):`));
    for (const it of s.inventory) lines.push(`  ${it.slot}) ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}${it.equipped ? t(L, ' [装備中]', ' [equipped]') : ''}${it.identified ? '' : t(L, ' (未鑑定)', ' (unidentified)')}`);
  } else {
    lines.push(t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}): `, `Inventory (${s.inventory_count}/${s.inventory_capacity}): `) + (s.inventory_brief || '-'));
  }
  if (obs.map) {
    lines.push(t(L, `地図(自分中心, 左上=(${obs.map.origin.x},${obs.map.origin.y})):`, `Map (centered, top-left=(${obs.map.origin.x},${obs.map.origin.y})):`));
    for (const r of obs.map.rows) lines.push('  ' + r);
    lines.push(t(L, '  凡例: ', '  Legend: ') + Object.entries(obs.map.legend).map(([k, v]) => `${k}=${v}`).join(' ') + t(L, ' (空白)=未知', ' (blank)=unknown'));
  }
  lines.push(t(L, 'できること: ', 'Actions: ') + compactActions(obs.valid_actions));
  return lines.join('\n');
}

function compactActions(actions: string[]): string {
  const plainMoves = actions.filter((a) => /^move [a-z]+$/.test(a)).map((a) => a.slice(5));
  const rest = actions.filter((a) => !/^move [a-z]+$/.test(a));
  const parts: string[] = [];
  const special = rest.filter((a) => a.startsWith('move '));
  parts.push(...special);
  if (plainMoves.length) parts.push(`move ${plainMoves.join(',')}`);
  parts.push(...rest.filter((a) => !a.startsWith('move ')));
  return parts.join(' / ');
}

/** 対象の説明（look）。視界内・記憶内の情報だけを使う */
export function describeTarget(view: PlayerView, catalog: Catalog, target: Pos | string): { text: string; data: Record<string, unknown> } {
  const L = view.locale;
  const f = view.floor;
  if (!f) return { text: t(L, 'フロア外', 'Not on a floor'), data: {} };
  let p: Pos | null = null;
  let ent: EntityView | undefined;
  if (typeof target === 'string') {
    ent = view.entities.find((e) => e.id === target);
    if (ent) p = ent.pos;
    else {
      const r = view.memory.remembered.find((x) => x.id === target);
      if (r) return { text: t(L, `${kindName(catalog, L, r.kind, r.appearanceId)}（最後に見た位置 ${r.pos.x},${r.pos.y}）`, `${kindName(catalog, L, r.kind, r.appearanceId)} (last seen at ${r.pos.x},${r.pos.y})`), data: { remembered: r } };
      if (target === view.self.id) p = view.self.pos;
      else return { text: t(L, 'それは見えない。', 'You cannot see that.'), data: { visible: false } };
    }
  } else p = target;
  if (!p || p.x < 0 || p.y < 0 || p.x >= f.width || p.y >= f.height) return { text: t(L, '範囲外', 'Out of bounds'), data: {} };
  const i = p.y * f.width + p.x;
  const known = view.memory.terrain[i] !== 0;
  const visible = view.visibleCells.includes(i);
  const parts: string[] = [];
  const data: Record<string, unknown> = { pos: p, known, visible };
  if (!known) return { text: t(L, 'まだ見たことのない場所だ。', 'An unexplored location.'), data };
  const tid = view.terrainTable[view.memory.terrain[i]];
  parts.push(termName(catalog, L, tid) + (visible ? '' : t(L, '（記憶）', ' (remembered)')));
  data.terrain = tid;
  const here = view.entities.filter((e) => e.pos.x === p!.x && e.pos.y === p!.y);
  const list: unknown[] = [];
  for (const e of here) {
    if (e.cat === 'monster') {
      const mem = e.kind ? view.monsterMemory[e.kind] : undefined;
      const name = monsterDisplayName(catalog, L, e);
      const memText = mem
        ? t(L, `遭遇${mem.encounters}回・撃破${mem.kills}回・受けた最大ダメージ${mem.maxDamageToYou}・与えた最大ダメージ${mem.maxDamageByYou}${mem.abilities.length ? '・能力:' + mem.abilities.join(',') : ''}`,
          `met ${mem.encounters}, killed ${mem.kills}, max dmg to you ${mem.maxDamageToYou}, max dmg by you ${mem.maxDamageByYou}${mem.abilities.length ? ', abilities: ' + mem.abilities.join(',') : ''}`)
        : t(L, '初めて見る相手だ', 'never seen before');
      parts.push(`${name} [${L === 'en' ? e.hp : HP_JA[e.hp ?? 'healthy']}, ${L === 'en' ? e.awareness : AW_JA[e.awareness ?? 'unaware']}] ${memText}`);
      list.push({ id: e.id, name, hp_state: e.hp, awareness: e.awareness, memory: mem ?? null, threat: threatOf(view, e) });
    } else if (e.cat === 'item') {
      const name = itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes);
      const desc = e.kind ? nameOf(catalog.items[e.kind]?.desc, L, '') : t(L, '正体不明', 'unidentified');
      parts.push(`${name}${(e.qty ?? 1) > 1 ? ` x${e.qty}` : ''}: ${desc}`);
      list.push({ id: e.id, name, qty: e.qty, desc });
    } else {
      const name = e.cat === 'player' ? (e.name ?? '?') : kindName(catalog, L, e.kind);
      parts.push(name + (e.state && e.state !== 'idle' ? ` [${e.state}]` : ''));
      list.push({ id: e.id, name, state: e.state });
    }
  }
  data.entities = list;
  return { text: parts.join(' / '), data };
}

export function describeInventory(view: PlayerView, catalog: Catalog): { text: string; items: (ObsInvItem & { desc: string; id: string })[] } {
  const L = view.locale;
  const items = view.inventory.map((it: ItemView) => {
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    return {
      id: it.id, slot: it.slot, name: itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes), qty: it.qty,
      category: itemCategory(catalog, it.kind, it.appearanceId), identified: it.kind !== null, equipped: it.equipped !== null,
      desc: ci ? nameOf(ci.desc, L, '') : t(L, '未鑑定。使うか鑑定するまで正体は分からない。', 'Unidentified. Use or identify it to learn what it is.'),
    };
  });
  const text = [
    t(L, `所持品 ${items.length}/${view.self.capacity}`, `Inventory ${items.length}/${view.self.capacity}`),
    ...items.map((i) => `${i.slot}) ${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}${i.equipped ? t(L, ' [装備中]', ' [equipped]') : ''} — ${i.desc}`),
  ].join('\n');
  return { text, items };
}

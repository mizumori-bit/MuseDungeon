// Scene の組み立て。(a) PlayerView（プレイ・追従観戦）と (b) World 全体（俯瞰）。
// プレイヤー視点では未知セルを描かない。未鑑定アイテムは外見 ID でしか描かない。
import type { Catalog, Pos, PlayerView, World } from '@muse/shared';
import { itemDisplayName, kindName, monsterDisplayName, nameOf } from '@muse/shared';
import type { AssetRef } from '../theme/types';
import { getLocale } from '../util';
import type { Scene, SceneEntity } from './types';

export const PLAYER_COLORS = ['#4fc3f7', '#ffb74d', '#ba68c8', '#81c784', '#f06292', '#fff176'];

function itemRef(catalog: Catalog, kind: string | null, appearanceId: string | null): AssetRef {
  const category = (kind ? catalog.items[kind]?.category : undefined) ?? (appearanceId ? catalog.appearances[appearanceId]?.category : undefined);
  if (kind) return { cls: 'item', id: kind, alt: appearanceId ? { cls: 'appearance', id: appearanceId } : undefined, category };
  return { cls: 'appearance', id: appearanceId ?? 'unknown', category };
}

const BUCKET_FRAC = { healthy: 1, wounded: 0.62, badly_wounded: 0.37, near_death: 0.15 } as const;
export function bucketFrac(b: keyof typeof BUCKET_FRAC): number {
  return BUCKET_FRAC[b];
}

function markStacks(ents: SceneEntity[]): void {
  const counts = new Map<string, number>();
  for (const e of ents) if (e.layer === 'item') counts.set(`${e.x},${e.y}`, (counts.get(`${e.x},${e.y}`) ?? 0) + 1);
  for (const e of ents) if (e.layer === 'item') e.stack = counts.get(`${e.x},${e.y}`) ?? 1;
}

export interface SceneExtras {
  cursor?: Pos | null;
  path?: Pos[] | null;
  bubbles?: { id: string; text: string }[];
}

export function sceneFromView(view: PlayerView, catalog: Catalog, extras: SceneExtras = {}): Scene | null {
  const f = view.floor;
  if (!f) return null;
  const L = getLocale();
  const n = f.width * f.height;
  const terrain: (string | null)[] = new Array(n);
  const vis = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const t = view.memory.terrain[i] ?? 0;
    terrain[i] = t ? view.terrainTable[t] ?? null : null;
    if (t) vis[i] = 1;
  }
  for (const i of view.visibleCells) if (terrain[i]) vis[i] = 2;
  const colorOf = (pid: string | undefined) => {
    const idx = view.party.findIndex((p) => p.playerId === pid);
    return PLAYER_COLORS[(idx < 0 ? 0 : idx) % PLAYER_COLORS.length];
  };
  const ents: SceneEntity[] = [];
  const visibleIds = new Set(view.entities.map((e) => e.id));
  for (const r of view.memory.remembered) {
    if (visibleIds.has(r.id)) continue;
    if (vis[r.pos.y * f.width + r.pos.x] === 2) continue;
    if (r.cat === 'item') {
      ents.push({ id: r.id, layer: 'item', ref: { ...itemRef(catalog, r.kind, r.appearanceId), x: r.pos.x, y: r.pos.y }, x: r.pos.x, y: r.pos.y, label: itemDisplayName(catalog, L, r.kind, r.appearanceId), statuses: [], affixes: [], remembered: true });
    } else {
      ents.push({ id: r.id, layer: 'feature', ref: { cls: 'feature', id: r.kind ?? 'unknown', state: r.state }, x: r.pos.x, y: r.pos.y, label: kindName(catalog, L, r.kind), statuses: [], affixes: [], remembered: true });
    }
  }
  for (const e of view.entities) {
    const base = { id: e.id, x: e.pos.x, y: e.pos.y, statuses: e.statuses ?? [], affixes: e.affixes ?? [] };
    if (e.cat === 'item') {
      ents.push({ ...base, layer: 'item', ref: { ...itemRef(catalog, e.kind, e.appearanceId), x: e.pos.x, y: e.pos.y }, label: itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes ?? []) + ((e.qty ?? 1) > 1 ? ` x${e.qty}` : '') });
    } else if (e.cat === 'feature' || e.cat === 'trap') {
      ents.push({ ...base, layer: 'feature', ref: { cls: 'feature', id: e.kind ?? 'unknown', state: e.state }, label: kindName(catalog, L, e.kind) });
    } else if (e.cat === 'monster') {
      ents.push({
        ...base, layer: 'actor', ref: { cls: 'actor', id: e.kind ?? 'unknown' }, label: monsterDisplayName(catalog, L, e),
        hpBucket: e.hp, hostile: true, asleep: e.awareness === 'asleep',
      });
    } else {
      ents.push({ ...base, layer: 'actor', ref: { cls: 'actor', id: e.kind ?? 'unknown' }, label: e.name ?? '?', hpBucket: e.hp, isPlayer: true, name: e.name, color: colorOf(e.playerId) });
    }
  }
  const me = view.self;
  if (me.pos) {
    ents.push({
      id: me.id, layer: 'actor', ref: { cls: 'actor', id: me.kind }, x: me.pos.x, y: me.pos.y, label: me.name,
      hpFrac: me.stats.maxHp > 0 ? me.stats.hp / me.stats.maxHp : 0, isPlayer: true, name: me.name, color: colorOf(view.playerId),
      statuses: me.statuses.map((s) => s.id), affixes: [],
    });
  }
  markStacks(ents);
  return {
    mode: 'player', floorKey: f.key, width: f.width, height: f.height, biome: f.biome, terrain, vis, entities: ents,
    focus: me.pos, focusId: me.id, cursor: extras.cursor ?? null, path: extras.path ?? null, bubbles: extras.bubbles ?? [], catalog,
  };
}

export function sceneFromWorld(world: World, catalog: Catalog, floorKey: string, focusId: string | null, extras: SceneExtras = {}): Scene | null {
  const f = world.floors[floorKey];
  if (!f) return null;
  const L = getLocale();
  const table = world.meta.terrainTable;
  const terrain = f.terrain.map((i) => table[i] ?? null);
  const vis = new Uint8Array(f.width * f.height).fill(2);
  const ents: SceneEntity[] = [];
  const order = world.playerOrder;
  for (const e of Object.values(world.entities).sort((a, b) => a.sid - b.sid)) {
    if (!e.pos || e.pos.floor !== floorKey) continue;
    const base = { id: e.id, x: e.pos.x, y: e.pos.y, statuses: (e.statuses ?? []).map((s) => s.id), affixes: e.scale?.affixes ?? [] };
    if (e.player) {
      const pr = world.players[e.player];
      if (pr?.state !== 'alive') continue;
      const idx = order.indexOf(e.player);
      ents.push({ ...base, layer: 'actor', ref: { cls: 'actor', id: e.kind }, label: pr.name, hpFrac: e.stats ? e.stats.hp / Math.max(1, e.stats.maxHp) : 1, isPlayer: true, name: pr.name, color: PLAYER_COLORS[(idx < 0 ? 0 : idx) % PLAYER_COLORS.length] });
    } else if (e.actor) {
      if ((e.stats?.hp ?? 1) <= 0) continue;
      const tier = e.scale?.tier ? `+${e.scale.tier}` : '';
      const af = (e.scale?.affixes ?? []).map((a) => nameOf(catalog.affixes[a]?.name, L, a)).join(L === 'en' ? ' ' : '');
      const nm = kindName(catalog, L, e.kind);
      ents.push({
        ...base, layer: 'actor', ref: { cls: 'actor', id: e.kind }, label: (af ? (L === 'en' ? `${af} ${nm}` : af + nm) : nm) + tier,
        hpFrac: e.stats ? e.stats.hp / Math.max(1, e.stats.maxHp) : 1, hostile: true,
        asleep: !!e.actor.dormant || e.actor.ai?.state === 'asleep' || (e.statuses ?? []).some((s) => s.id === 'core:sleep'),
      });
    } else if (e.item) {
      const app = world.secret.appearances[e.kind] ?? null;
      const category = catalog.items[e.kind]?.category;
      // 俯瞰でも未鑑定になり得る種別は外見で描く（画像から正体を漏らさない）
      const ref: AssetRef = app ? { cls: 'appearance', id: app, category, x: e.pos.x, y: e.pos.y } : { cls: 'item', id: e.kind, category, x: e.pos.x, y: e.pos.y };
      ents.push({ ...base, layer: 'item', ref, label: itemDisplayName(catalog, L, e.kind, null, e.item.affixes) + (e.item.qty > 1 ? ` x${e.item.qty}` : '') });
    } else if (e.trap) {
      ents.push({ ...base, layer: 'feature', ref: { cls: 'feature', id: e.kind }, label: kindName(catalog, L, e.kind), hidden: e.trap.revealedTo.length === 0 });
    } else if (e.feature) {
      ents.push({ ...base, layer: 'feature', ref: { cls: 'feature', id: e.kind, state: e.feature.state }, label: kindName(catalog, L, e.kind) });
    }
  }
  markStacks(ents);
  const fe = focusId ? world.entities[focusId] : undefined;
  const focus = fe?.pos && fe.pos.floor === floorKey ? { x: fe.pos.x, y: fe.pos.y } : f.entry;
  return {
    mode: 'director', floorKey, width: f.width, height: f.height, biome: f.biome, terrain, vis, entities: ents,
    focus, focusId: fe?.pos?.floor === floorKey ? focusId : null, cursor: extras.cursor ?? null, path: extras.path ?? null, bubbles: extras.bubbles ?? [], catalog,
  };
}

/** 俯瞰で表示するフロア: 追従対象 → 最初の生存プレイヤー → 生成済みの最初のフロア */
export function directorFloor(world: World, focusPlayer: string | null): { floorKey: string | null; focusId: string | null } {
  const tryPlayer = (pid: string | undefined) => {
    if (!pid) return null;
    const pr = world.players[pid];
    const e = pr ? world.entities[pr.entityId] : undefined;
    return e?.pos ? { floorKey: e.pos.floor, focusId: e.id } : null;
  };
  const fp = tryPlayer(focusPlayer ?? undefined);
  if (fp) return fp;
  for (const pid of world.playerOrder) {
    if (world.players[pid].state !== 'alive') continue;
    const r = tryPlayer(pid);
    if (r) return r;
  }
  const keys = Object.keys(world.floors);
  return { floorKey: keys[0] ?? null, focusId: null };
}

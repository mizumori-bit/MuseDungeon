// PlayerView: AI の Observation と人間のプレイ画面の共通の元データ。
// projectPlayerView はルール無しの純粋なフィルタ。仕様: docs/PROTOCOL.md §4
import type {
  Controller, Entity, EntityId, EquipSlot, FloorKey, Locale, MonsterMemory, PlayerId, Pos,
  RememberedEntity, Stats, StatusInst, World,
} from './types';

export type HpState = 'healthy' | 'wounded' | 'badly_wounded' | 'near_death';
export type Awareness = 'asleep' | 'unaware' | 'hunting';
export type ViewStatus = 'your_turn' | 'waiting_others' | 'dead' | 'ended';

export interface ItemView {
  id: EntityId;
  slot: string;
  /** 未鑑定なら null */
  kind: string | null;
  appearanceId: string | null;
  qty: number;
  affixes: string[];
  equipped: EquipSlot | null;
}

export interface EntityView {
  id: EntityId;
  cat: 'monster' | 'player' | 'item' | 'feature' | 'trap';
  kind: string | null;
  appearanceId: string | null;
  pos: Pos;
  hp?: HpState;
  awareness?: Awareness;
  statuses?: string[];
  affixes?: string[];
  tier?: number;
  qty?: number;
  state?: string;
  playerId?: PlayerId;
  name?: string;
}

export interface RememberedView {
  id: EntityId;
  cat: RememberedEntity['cat'];
  kind: string | null;
  appearanceId: string | null;
  pos: Pos;
  qty: number;
  ft: number;
  state?: string;
}

export interface SelfView {
  id: EntityId;
  kind: string;
  name: string;
  classId: string;
  controller: Controller;
  pos: Pos | null;
  stats: Stats;
  speed: number;
  level: number;
  xp: number;
  statuses: StatusInst[];
  equip: Partial<Record<EquipSlot, EntityId>>;
  capacity: number;
}

export interface PartyMemberView {
  playerId: PlayerId;
  entityId: EntityId;
  name: string;
  classId: string;
  controller: Controller;
  state: 'alive' | 'dead' | 'left';
  depth: number | null;
}

export interface PlayerView {
  runId: string;
  playerId: PlayerId;
  seq: number;
  status: ViewStatus;
  locale: Locale;
  terrainTable: string[];
  self: SelfView;
  inventory: ItemView[];
  floor: { key: FloorKey; depth: number; biome: string; floorType: string; width: number; height: number; time: number } | null;
  visibleCells: number[];
  entities: EntityView[];
  memory: { terrain: number[]; remembered: RememberedView[] };
  identified: string[];
  monsterMemory: Record<string, MonsterMemory>;
  notes: string[];
  party: PartyMemberView[];
  turn: { current: EntityId | null; mine: boolean };
  runStatus: 'active' | 'ended';
}

export function hpState(hp: number, maxHp: number): HpState {
  const pct = maxHp > 0 ? Math.trunc((hp * 100) / maxHp) : 0;
  if (pct >= 75) return 'healthy';
  if (pct >= 50) return 'wounded';
  if (pct >= 25) return 'badly_wounded';
  return 'near_death';
}

function awarenessOf(e: Entity): Awareness | undefined {
  const ai = e.actor?.ai;
  if (!ai) return undefined;
  if (e.statuses?.some((s) => s.id === 'core:sleep')) return 'asleep';
  if (ai.state === 'asleep') return 'asleep';
  if (ai.state === 'unaware') return 'unaware';
  return 'hunting';
}

/** 未鑑定なら kind を伏せて外見を返す */
export function maskKind(world: World, identified: readonly string[], kind: string): { kind: string | null; appearanceId: string | null } {
  const app = world.secret.appearances[kind];
  if (app === undefined) return { kind, appearanceId: null };
  if (identified.includes(kind)) return { kind, appearanceId: app };
  return { kind: null, appearanceId: app };
}

export function entityCat(e: Entity): EntityView['cat'] | null {
  if (e.player) return 'player';
  if (e.actor) return 'monster';
  if (e.item) return 'item';
  if (e.trap) return 'trap';
  if (e.feature) return 'feature';
  return null;
}

export function projectPlayerView(world: World, playerId: PlayerId): PlayerView {
  const rec = world.players[playerId];
  if (!rec) throw new Error(`no such player ${playerId}`);
  const me = world.entities[rec.entityId];
  const k = rec.knowledge;
  const floorKey = me.pos?.floor ?? null;
  const floor = floorKey ? world.floors[floorKey] : null;

  const inventory: ItemView[] = [];
  const equippedBy: Record<string, EquipSlot> = {};
  for (const [slotName, id] of Object.entries(me.equip ?? {})) if (id) equippedBy[id] = slotName as EquipSlot;
  for (const id of me.inv?.items ?? []) {
    const it = world.entities[id];
    if (!it?.item) continue;
    const mk = maskKind(world, k.identified, it.kind);
    inventory.push({
      id, slot: it.item.slot ?? '?', kind: mk.kind, appearanceId: mk.appearanceId,
      qty: it.item.qty, affixes: [...it.item.affixes], equipped: equippedBy[id] ?? null,
    });
  }
  inventory.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));

  const visibleSet = new Set(k.visible);
  const entities: EntityView[] = [];
  if (floor && floorKey) {
    const ordered: Entity[] = [];
    for (const e of Object.values(world.entities)) if (e.pos?.floor === floorKey) ordered.push(e);
    ordered.sort((a, b) => a.sid - b.sid);
    for (const e of ordered) {
      if (!e.pos || e.pos.floor !== floorKey || e.id === me.id) continue;
      if (!visibleSet.has(e.pos.y * floor.width + e.pos.x)) continue;
      const cat = entityCat(e);
      if (!cat) continue;
      if (cat === 'trap' && !e.trap!.revealedTo.includes(playerId)) continue;
      const pos = { x: e.pos.x, y: e.pos.y };
      if (cat === 'item') {
        const mk = maskKind(world, k.identified, e.kind);
        entities.push({ id: e.id, cat, kind: mk.kind, appearanceId: mk.appearanceId, pos, qty: e.item!.qty, affixes: [...e.item!.affixes] });
      } else if (cat === 'monster' || cat === 'player') {
        const v: EntityView = {
          id: e.id, cat, kind: e.kind, appearanceId: null, pos,
          hp: e.stats ? hpState(e.stats.hp, e.stats.maxHp) : undefined,
          statuses: (e.statuses ?? []).map((s) => s.id),
        };
        if (cat === 'monster') {
          v.awareness = awarenessOf(e);
          if (e.scale) {
            v.affixes = [...e.scale.affixes];
            if (e.scale.tier > 0) v.tier = e.scale.tier;
          }
        } else {
          const pr = world.players[e.player!];
          v.playerId = e.player;
          v.name = pr?.name;
        }
        entities.push(v);
      } else {
        entities.push({ id: e.id, cat, kind: e.kind, appearanceId: null, pos, state: e.feature?.state });
      }
    }
  }

  const fk = floorKey ? k.floors[floorKey] : undefined;
  const remembered: RememberedView[] = (fk?.remembered ?? []).map((r) => {
    const mk = r.cat === 'item' ? maskKind(world, k.identified, r.kind) : { kind: r.kind, appearanceId: null };
    return { id: r.id, cat: r.cat, kind: mk.kind, appearanceId: mk.appearanceId, pos: { ...r.pos }, qty: r.qty, ft: r.ft, state: r.state };
  });

  let status: ViewStatus;
  if (world.status === 'ended') status = 'ended';
  else if (rec.state !== 'alive') status = 'dead';
  else if (floor && floor.currentActor === me.id) status = 'your_turn';
  else status = 'waiting_others';

  const party: PartyMemberView[] = world.playerOrder.map((pid) => {
    const p = world.players[pid];
    const pe = world.entities[p.entityId];
    const depth = pe?.pos ? world.floors[pe.pos.floor]?.depth ?? null : null;
    return { playerId: pid, entityId: p.entityId, name: p.name, classId: p.classId, controller: { ...p.controller }, state: p.state, depth };
  });

  return {
    runId: world.meta.runId,
    playerId,
    seq: world.seq,
    status,
    locale: rec.locale,
    terrainTable: world.meta.terrainTable,
    self: {
      id: me.id, kind: me.kind, name: rec.name, classId: rec.classId, controller: { ...rec.controller },
      pos: me.pos ? { x: me.pos.x, y: me.pos.y } : null,
      stats: { ...me.stats! }, speed: me.actor?.speed ?? 100,
      level: me.level?.level ?? 1, xp: me.level?.xp ?? 0,
      statuses: (me.statuses ?? []).map((s) => ({ ...s })),
      equip: { ...(me.equip ?? {}) },
      capacity: me.inv?.capacity ?? 0,
    },
    inventory,
    floor: floor ? { key: floor.key, depth: floor.depth, biome: floor.biome, floorType: floor.floorType, width: floor.width, height: floor.height, time: floor.time } : null,
    visibleCells: [...k.visible],
    entities,
    memory: { terrain: fk ? [...fk.seen] : [], remembered },
    identified: [...k.identified],
    monsterMemory: structuredClone(k.monsterMemory),
    notes: [...k.notes],
    party,
    turn: { current: floor?.currentActor ?? null, mine: status === 'your_turn' },
    runStatus: world.status,
  };
}

/** 観戦用: secret の seed と rng を除去した World（外見表は追従視点の再射影に必要なので残す） */
export function stripSecret(world: World): World {
  const w = structuredClone(world);
  w.secret = { seed: world.status === 'ended' ? world.secret.seed : '', rng: {}, appearances: { ...world.secret.appearances } };
  return w;
}

/** 次の XP 閾値（表示用。engine と同じ表を使う） */
export function xpForLevel(level: number): number {
  return 15 * level * level;
}

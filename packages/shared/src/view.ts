// PlayerView: AI の Observation と人間のプレイ画面の共通の元データ。
// projectPlayerView はルール無しの純粋なフィルタ。仕様: docs/PROTOCOL.md §4
import type {
  CampState, Controller, Entity, EntityId, EntityRole, EquipSlot, Expedition, ExpeditionEndReason, ExpeditionResult, FloorKey,
  Locale, MonsterMemory, Objective, PlayerId, PlayerState, Pos, RememberedEntity, Stats, StatusInst, World,
} from './types';

export type HpState = 'healthy' | 'wounded' | 'badly_wounded' | 'near_death';
export type Awareness = 'asleep' | 'unaware' | 'hunting';
/** at_camp: 遠征と遠征の間（盤面にいない） */
export type ViewStatus = 'your_turn' | 'waiting_others' | 'dead' | 'ended' | 'at_camp';
/** 敵の HP 4 段階の境界（%）。公開ルール */
export const HP_BANDS: [number, number, number] = [75, 50, 25];

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
  /** 遠征の目的に関わる個体（守護者・遺物） */
  role?: EntityRole;
  /** 自分が見ている間にこの個体が受けた実ダメージの合計 */
  damageSeen?: number;
  /** 手負いで逃げている（追跡中でも extract・休息を妨げない） */
  fleeing?: boolean;
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
  role?: EntityRole;
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
  /** 自分が行動した手番数 */
  turns: number;
  /** 自然回復の蓄積値 */
  regen: number;
}

export interface PartyMemberView {
  playerId: PlayerId;
  entityId: EntityId;
  name: string;
  classId: string;
  controller: Controller;
  state: PlayerState;
  depth: number | null;
}

/** 遠征の事実（目的・進捗）。守護者や遺物の居場所は含まない */
export interface ExpeditionView {
  no: number;
  objective: Objective;
  points: number;
  relicGuarded: boolean;
  status: Expedition['status'];
  endReason: ExpeditionEndReason | null;
  progress: { reached: boolean; guardianSlain: boolean; relicHeld: boolean; relicHeldByYou: boolean };
  /** 自分が extract 済みか */
  extracted: boolean;
  result: ExpeditionResult | null;
  startSeq: number;
  endSeq: number | null;
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
  floor: { key: FloorKey; depth: number; biome: string; floorType: string; width: number; height: number; time: number; noWander: boolean } | null;
  visibleCells: number[];
  entities: EntityView[];
  memory: { terrain: number[]; remembered: RememberedView[] };
  identified: string[];
  monsterMemory: Record<string, MonsterMemory>;
  notes: string[];
  party: PartyMemberView[];
  turn: { current: EntityId | null; mine: boolean };
  runStatus: 'active' | 'ended';
  runMode: 'solo' | 'coop';
  /** 現在（または直前）の遠征。遠征の無い古いランでは null */
  expedition: ExpeditionView | null;
  /** 遠征と遠征の間の候補（キャンプ）。遠征中は null */
  camp: CampState | null;
  /** 最深到達階（パーティ全体の生成済み最深） */
  deepestDepth: number;
}

export function hpState(hp: number, maxHp: number): HpState {
  const pct = maxHp > 0 ? Math.trunc((hp * 100) / maxHp) : 0;
  if (pct >= HP_BANDS[0]) return 'healthy';
  if (pct >= HP_BANDS[1]) return 'wounded';
  if (pct >= HP_BANDS[2]) return 'badly_wounded';
  return 'near_death';
}

/** 現在（未終了）の遠征。無ければ null */
export function currentExpedition(world: World): Expedition | null {
  const list = world.expeditions;
  if (!list?.length) return null;
  const last = list[list.length - 1];
  return last.status === 'ended' ? null : last;
}

/** 最新の遠征（終了済みを含む） */
export function latestExpedition(world: World): Expedition | null {
  const list = world.expeditions;
  return list?.length ? list[list.length - 1] : null;
}

/** 生成済みの最深階（main 枝） */
export function deepestGenerated(world: World): number {
  let d = 1;
  for (const f of Object.values(world.floors)) if (f.branch === 'main' && f.depth > d) d = f.depth;
  return d;
}

/**
 * 手負いで逃げている（種族の逃走の閾値を下回っている）。逃走中の敵は「追跡中」として extract・休息を妨げない。
 * 閾値は wounded / near_death などの HP 4 段階と同じ程度の公開情報。
 */
export function isFleeing(e: Entity): boolean {
  const at = e.actor?.ai?.params.fleeBelowHpPct ?? 0;
  if (at <= 0 || !e.stats) return false;
  return Math.trunc((e.stats.hp * 100) / Math.max(1, e.stats.maxHp)) < at;
}

/** 追跡中で、逃げてもいない（extract と休息を妨げる敵）。観測と engine の判定で同じものを使う */
export function isPursuing(e: Entity): boolean {
  return awarenessOf(e) === 'hunting' && !isFleeing(e);
}

/** プレイヤーから見た覚醒状態（観測と engine の判定で同じものを使う） */
export function awarenessOf(e: Entity): Awareness | undefined {
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
        const iv: EntityView = { id: e.id, cat, kind: mk.kind, appearanceId: mk.appearanceId, pos, qty: e.item!.qty, affixes: [...e.item!.affixes] };
        if (e.role) iv.role = e.role;
        entities.push(iv);
      } else if (cat === 'monster' || cat === 'player') {
        const v: EntityView = {
          id: e.id, cat, kind: e.kind, appearanceId: null, pos,
          hp: e.stats ? hpState(e.stats.hp, e.stats.maxHp) : undefined,
          statuses: (e.statuses ?? []).map((s) => s.id),
        };
        if (cat === 'monster') {
          v.awareness = awarenessOf(e);
          if (v.awareness === 'hunting' && isFleeing(e)) v.fleeing = true;
          if (e.scale) {
            v.affixes = [...e.scale.affixes];
            if (e.scale.tier > 0) v.tier = e.scale.tier;
          }
          if (e.role) v.role = e.role;
          const ds = k.damageSeen?.[e.id];
          if (ds) v.damageSeen = ds;
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
    const rv: RememberedView = { id: r.id, cat: r.cat, kind: mk.kind, appearanceId: mk.appearanceId, pos: { ...r.pos }, qty: r.qty, ft: r.ft, state: r.state };
    // 役割は見た時点で分かる不変の性質
    const role = world.entities[r.id]?.role;
    if (role) rv.role = role;
    return rv;
  });

  let status: ViewStatus;
  if (world.status === 'ended') status = 'ended';
  else if (rec.state === 'at_camp') status = 'at_camp';
  else if (rec.state !== 'alive') status = 'dead';
  else if (floor && floor.currentActor === me.id) status = 'your_turn';
  else status = 'waiting_others';

  const latest = latestExpedition(world);
  let expedition: ExpeditionView | null = null;
  if (latest) {
    const held = latest.progress.relicHeldBy;
    expedition = {
      no: latest.no, objective: { ...latest.objective }, points: latest.points, relicGuarded: latest.relicGuarded,
      status: latest.status, endReason: latest.endReason,
      progress: { reached: latest.progress.reached, guardianSlain: latest.progress.guardianSlain, relicHeld: held !== null, relicHeldByYou: held === me.id },
      extracted: latest.extracted.some((x) => x.player === playerId),
      result: latest.result ? { ...latest.result } : null,
      startSeq: latest.startSeq, endSeq: latest.endSeq,
    };
  }

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
      turns: me.actor?.turns ?? 0,
      regen: me.actor?.regen ?? 0,
    },
    inventory,
    floor: floor ? {
      key: floor.key, depth: floor.depth, biome: floor.biome, floorType: floor.floorType, width: floor.width, height: floor.height,
      time: floor.time, noWander: floor.rules.noWander,
    } : null,
    visibleCells: [...k.visible],
    entities,
    memory: { terrain: fk ? [...fk.seen] : [], remembered },
    identified: [...k.identified],
    monsterMemory: structuredClone(k.monsterMemory),
    notes: [...k.notes],
    party,
    turn: { current: floor?.currentActor ?? null, mine: status === 'your_turn' },
    runStatus: world.status,
    runMode: world.meta.mode,
    expedition,
    camp: !currentExpedition(world) && world.camp ? structuredClone(world.camp) : null,
    deepestDepth: deepestGenerated(world),
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

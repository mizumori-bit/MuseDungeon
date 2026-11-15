// Event の型。仕様: docs/PROTOCOL.md §5
// 規約: イベントは結果値（after 値）を持ち、applyEvent は代入・追加・削除しかしない。
import type {
  AiState, BaseStats, Entity, EntityId, EquipSlot, Floor, FloorKey, FloorPos, MonsterMemory,
  PlayerId, PlayerRecord, PlayerStats, Pos, RememberedEntity, RngState, RunMeta, RunSummary,
  Stats, StatusInst, WorldSecret,
} from './types';

export const EVENT_VERSION = 1;

export interface EventBase {
  seq: number;
  /** 原因となった command の cseq */
  cause: number | null;
  floor: FloorKey | null;
  /** floor.time（発行時点のアクター時刻） */
  ft: number;
  /** 壁時計(ms)。再生ペース用。ルールでは使わない */
  wall: number;
  seenBy: PlayerId[] | 'all';
  /** プレイヤーごとに伏せるフィールド名（見えていないエンティティ参照など） */
  masks?: Record<PlayerId, string[]>;
  /** 汎用の after 値: 置き換える／追加するエンティティ全体 */
  put?: Entity[];
  /** 汎用の after 値: 削除するエンティティ */
  del?: EntityId[];
}

export type TerrainChangeReason = 'door_open' | 'door_close' | 'effect' | 'other';
export type MoveMode = 'walk' | 'teleport' | 'swap' | 'knockback';
export type DamageVia = 'melee' | 'ranged' | 'thrown' | 'poison' | 'trap' | 'effect' | 'other';

type E<T extends string, P> = EventBase & { type: T } & P;

export type GameEvent =
  // ラン
  | E<'run_started', { meta: RunMeta; secret: WorldSecret | null }>
  | E<'player_joined', { player: PlayerRecord; entity: Entity }>
  | E<'player_state', { player: PlayerId; state: PlayerRecord['state']; reason: string }>
  | E<'player_stats', { player: PlayerId; stats: PlayerStats }>
  | E<'run_ended', { reason: string; summary: RunSummary }>
  // フロア
  | E<'floor_generated', { floorData: Omit<Floor, 'terrain'>; terrainRle: number[] }>
  | E<'tile_changed', { x: number; y: number; terrain: number; reason: TerrainChangeReason; by: EntityId | null }>
  | E<'turn_began', { actor: EntityId; time: number }>
  | E<'floor_wander', { nextWanderAt: number }>
  // エンティティ
  | E<'entity_spawned', { entity: Entity; reason: string }>
  | E<'entity_removed', { id: EntityId; kind: string; reason: string }>
  | E<'entity_moved', { id: EntityId; kind: string; from: Pos; to: Pos; mode: MoveMode }>
  | E<'entity_changed_floor', { id: EntityId; kind: string; from: FloorPos; to: FloorPos; nextActAt: number; dir: 'up' | 'down' }>
  | E<'actor_scheduled', { id: EntityId; nextActAt: number; turns: number }>
  | E<'ai_state_changed', { id: EntityId; ai: AiState; dormant: boolean; nextActAt: number }>
  // 戦闘
  | E<'attack', {
      attacker: EntityId | null; attackerKind: string | null;
      target: EntityId | null; targetKind: string | null;
      roll: number; hit: boolean; crit: boolean; ranged: boolean;
      from: Pos | null; to: Pos;
    }>
  | E<'damaged', {
      target: EntityId; targetKind: string; amount: number; hpAfter: number;
      source: EntityId | null; sourceKind: string | null; via: DamageVia;
    }>
  | E<'healed', { target: EntityId; targetKind: string; amount: number; hpAfter: number; via: string }>
  | E<'max_hp_changed', { target: EntityId; targetKind: string; maxHpAfter: number; hpAfter: number }>
  | E<'died', { id: EntityId; kind: string; killer: EntityId | null; killerKind: string | null; via: DamageVia; pos: Pos }>
  | E<'status_applied', { target: EntityId; targetKind: string; status: StatusInst; statusesAfter: StatusInst[] }>
  | E<'status_expired', { target: EntityId; targetKind: string; statusId: string; statusesAfter: StatusInst[] }>
  | E<'status_ticked', { target: EntityId; statusesAfter: StatusInst[] }>
  | E<'stats_changed', { target: EntityId; statsAfter: Stats; baseAfter: BaseStats | null; speedAfter: number | null; reason: string }>
  | E<'xp_gained', { target: EntityId; amount: number; xpAfter: number }>
  | E<'level_up', { target: EntityId; levelAfter: number; xpAfter: number; statsAfter: Stats; baseAfter: BaseStats }>
  // アイテム（状態変化は put/del で表す）
  | E<'item_picked_up', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; qty: number; slot: string }>
  | E<'item_dropped', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; qty: number; pos: Pos }>
  | E<'item_equipped', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; slotName: EquipSlot }>
  | E<'item_unequipped', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; slotName: EquipSlot }>
  | E<'item_used', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; category: string; qtyAfter: number }>
  | E<'item_thrown', {
      actor: EntityId | null; actorKind: string | null; item: EntityId; kind: string | null; appearanceId: string | null;
      from: Pos; to: Pos; landed: Pos | null; hit: EntityId | null; hitKind: string | null; broke: boolean;
    }>
  | E<'item_identified', { player: PlayerId; kind: string; appearanceId: string | null }>
  // 地物・罠
  | E<'feature_state', { id: EntityId; kind: string; state: string }>
  | E<'trap_revealed', { trap: EntityId; kind: string; player: PlayerId; pos: Pos }>
  | E<'trap_triggered', { trap: EntityId; kind: string; by: EntityId; byKind: string; pos: Pos }>
  // 知識
  | E<'knowledge_updated', {
      player: PlayerId; floorKey: FloorKey;
      /** 現在の視界（[start,len,...] の区間表現）。null は変化なし */
      visible: number[] | null;
      /** [idx, terrain, idx, terrain, ...] */
      newlySeen: number[];
      rememberedSet: RememberedEntity[];
      rememberedDel: EntityId[];
      metAdd: EntityId[];
    }>
  | E<'monster_memory_updated', { player: PlayerId; kind: string; memoryAfter: MonsterMemory }>
  | E<'notes_updated', { player: PlayerId; notesAfter: string[] }>
  // 知覚（状態を変えない）
  | E<'noise', { pos: Pos; loudness: number; source: EntityId | null }>
  // メタ
  | E<'thought', { player: PlayerId; text: string }>
  | E<'chat', { player: PlayerId; name: string; text: string }>
  // 内部（プレイヤー・観戦者には渡さない）
  | E<'rng_advanced', { states: Record<string, RngState> }>;

export type EventType = GameEvent['type'];
export type EventOf<T extends EventType> = Extract<GameEvent, { type: T }>;

/** 発行時に engine が埋める前の形（seq/wall などは ctx が付与） */
export type EventDraft = GameEvent extends infer X
  ? X extends GameEvent ? Omit<X, 'seq' | 'cause' | 'wall' | 'floor' | 'ft'> & { floor?: FloorKey | null; ft?: number } : never
  : never;

/** 観戦者にもプレイヤーにも渡さない内部イベント */
export const INTERNAL_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>(['rng_advanced']);

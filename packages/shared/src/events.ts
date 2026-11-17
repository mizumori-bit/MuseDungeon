// Event の型。仕様: docs/PROTOCOL.md §5
// 規約: イベントは結果値（after 値）を持ち、applyEvent は代入・追加・削除しかしない。
import type {
  AiState, BaseStats, CampState, Dir, Entity, EntityId, EquipSlot, Expedition, ExpeditionHaul, ExpeditionEndReason, ExpeditionResult, Floor,
  FloorKey, FloorPos, MonsterMemory, Objective, ObjectiveProgress, PlayerId, PlayerRecord, PlayerStats, Pos,
  RememberedEntity, RngState, RunMeta, RunSummary, Sense, Stats, StatusInst, WorldSecret, FloorHint, Names,
} from './types';

/** 2: 遠征・実ダメージ・回復の蓄積値（IMPROVEMENTS_V2）。3: ビルド（特技・能動技・呪い。V3-4）。古いログもそのまま畳み込める */
export const EVENT_VERSION = 9;

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
  | E<'player_state', { player: PlayerId; state: PlayerRecord['state']; reason: string; extractPos?: FloorPos | null; /** 綱で戻り、持っていた遺物を失った（V3-4b §28.1） */ relicLost?: boolean }>
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
  | E<'actor_scheduled', { id: EntityId; nextActAt: number; turns: number; regenAfter?: number }>
  | E<'ai_state_changed', { id: EntityId; ai: AiState; dormant: boolean; nextActAt: number }>
  // 戦闘
  | E<'attack', {
      attacker: EntityId | null; attackerKind: string | null;
      target: EntityId | null; targetKind: string | null;
      /** 接辞（文章で「毒牙のゴブリン」と書くため。見えていない側は伏せる） */
      attackerAffixes?: string[] | null; targetAffixes?: string[] | null;
      roll: number; hit: boolean; crit: boolean; ranged: boolean;
      from: Pos | null; to: Pos;
      /** 攻撃者が見えていない被害者にだけ残す、攻撃が来た方向 */
      fromDir?: Dir | null;
    }>
  | E<'damaged', {
      /** amount は出目どおりのダメージ、dealt は実際に減った HP（とどめの超過分を含まない） */
      target: EntityId; targetKind: string; amount: number; hpAfter: number; dealt?: number;
      source: EntityId | null; sourceKind: string | null; via: DamageVia;
      targetAffixes?: string[] | null; sourceAffixes?: string[] | null;
      /** 見ていたプレイヤーごとの、その個体への累計実ダメージ（after 値。プレイヤーには渡さない） */
      seenTotals?: Record<PlayerId, number>;
      /** 攻撃元が見えていない被害者にだけ残す、攻撃が来た方向 */
      fromDir?: Dir | null;
    }>
  | E<'healed', { target: EntityId; targetKind: string; amount: number; hpAfter: number; via: string; resetSeen?: boolean }>
  | E<'max_hp_changed', { target: EntityId; targetKind: string; maxHpAfter: number; hpAfter: number }>
  | E<'died', { id: EntityId; kind: string; killer: EntityId | null; killerKind: string | null; via: DamageVia; pos: Pos; maxHp?: number | null; bounty?: number; affixes?: string[] }>
  | E<'status_applied', { target: EntityId; targetKind: string; status: StatusInst; statusesAfter: StatusInst[]; targetAffixes?: string[] | null }>
  | E<'status_expired', { target: EntityId; targetKind: string; statusId: string; statusesAfter: StatusInst[] }>
  | E<'status_ticked', { target: EntityId; statusesAfter: StatusInst[] }>
  | E<'stats_changed', { target: EntityId; statsAfter: Stats; baseAfter: BaseStats | null; speedAfter: number | null; reason: string }>
  | E<'xp_gained', { target: EntityId; amount: number; xpAfter: number }>
  | E<'level_up', { target: EntityId; levelAfter: number; xpAfter: number; statsAfter: Stats; baseAfter: BaseStats; gains?: { maxHp: number; acc: number; might: number; eva: number } }>
  // ビルド（V3-4。状態変化は put で表す）
  /** 特技の候補が出た（options が空なら前の候補を選んだ後に引く） */
  | E<'perk_offered', { target: EntityId; level: number; options: string[] }>
  /** 特技を取った。ability は覚えた能動技 */
  | E<'perk_chosen', { target: EntityId; perk: string; level: number; ability?: string | null }>
  /** 守護者の状態の書き換え（after 値は put。俯瞰専用） */
  | E<'guardian_state', { id: EntityId }>
  /** 守護者のしたこと（手下を呼んだ・突進した・突進が外れた・怒った。見えている者に） */
  | E<'guardian_acted', { id: EntityId; kind: string; guardianName: Names; act: 'summoned' | 'charged' | 'missed' | 'enraged'; count?: number }>
  /** 守護者が、相手が階を離れている間に回復した（V3-3a §35.1。戻ってきた本人に）。full: 全快して落ち着いた */
  | E<'guardian_rested', { id: EntityId; guardianName: Names; full: boolean; player: PlayerId }>
  /** 遺物を記録庫に納めた。記録庫が次の節目の大守護者の記憶を 1 つ返す（V3-3a §35.7。本人に）。memory: weakness / vitals / none */
  | E<'archive_recalled', { player: PlayerId; relic: string; depth: number; guardianName: Names; memory: 'weakness' | 'vitals' | 'none'; weakness?: string; hp?: number; maxHit?: number }>
  /** 物語の 1 文（V3-3 §3.4。全員に）。守護者・大守護者を倒した、遺物を納めた */
  | E<'story', { reason: 'guardian_slain' | 'warden_slain' | 'relic_delivered'; line: Names }>
  /** 節目の大守護者が倒れた（V3-3 §3.2。全員に） */
  | E<'warden_slain', { depth: number; id: EntityId; guardianName: Names; by: EntityId | null }>
  /** 加護の候補が出た（大守護者を倒した。本人だけ。候補は put の boonChoice） */
  | E<'boon_offered', { target: EntityId; options: string[]; source: string; depth: number }>
  /** 加護を得た（V3-3 §3.3。本人だけ）。source: 持ち帰った遺物の種類（大守護者なら 'warden'） */
  | E<'boon_granted', { target: EntityId; boon: string; source: string }>
  /** 加護が効いた（本人だけ）。effect: last_stand（致死を HP 1 で耐えた）/ returned（投げた物が戻った）/ haste（階段の後の加速） */
  | E<'boon_triggered', { actor: EntityId; boon: string; effect: 'last_stand' | 'returned' | 'haste'; item?: EntityId | null; itemKind?: string | null }>
  /** 守護者の弱点を知った（V3-3 §3.1。弱点が効いた場面を見た本人だけ） */
  | E<'guardian_intel', { player: PlayerId; guardian: EntityId; guardianName: Names; weakness: string; miss?: boolean }>
  /** 敵が目を覚ました・気づいた理由（V3-4b §28.8）。見えている者にだけ。reason: noise（音。by が音を立てた者、ring は欠点が効いた指輪）/ sight（姿）/ pack（仲間の声） */
  | E<'monster_woke', { id: EntityId; kind: string; reason: 'noise' | 'sight' | 'pack'; by: EntityId | null; ring: string | null; wasAsleep: boolean }>
  /** 条件付きの特技が効いた（V3-4b §28.6）。effect: not_woken（忍び足）/ crit（不意打ち）/ picked（回収の手）/ braced（盾の構え）/ might（踏みとどまる）/ poison_halved（鉄の胃）/ cowed（威圧） */
  | E<'perk_triggered', { actor: EntityId; perk: string; effect: 'not_woken' | 'crit' | 'picked' | 'braced' | 'might' | 'poison_halved' | 'cowed'; subject?: EntityId | null; subjectKind?: string | null; amount?: number }>
  /** 能動技を使った。cooldownLeft はこの手番の後の残り手番 */
  | E<'ability_used', { actor: EntityId; actorKind: string; ability: string; target: EntityId | null; targetKind: string | null; cooldownLeft: number }>
  /** 呪いが分かった（装備した・鑑定した）。affixes は見えるようになった呪いの接辞 */
  | E<'curse_revealed', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; affixes: string[]; via: 'equip' | 'identify' }>
  /** 呪いの有無を確かめた（呪いは無かった） */
  | E<'item_inspected', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; via: 'equip' | 'identify' }>
  /** 呪いが解けた（接辞が消えた） */
  | E<'curse_lifted', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; affixes: string[] }>
  // アイテム（状態変化は put/del で表す）
  | E<'item_picked_up', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; qty: number; slot: string; affixes?: string[]; auto?: boolean }>
  | E<'item_dropped', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; qty: number; pos: Pos; affixes?: string[] }>
  | E<'item_equipped', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; slotName: EquipSlot; affixes?: string[] }>
  | E<'item_unequipped', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; slotName: EquipSlot; affixes?: string[] }>
  | E<'item_used', { actor: EntityId; item: EntityId; kind: string | null; appearanceId: string | null; category: string; qtyAfter: number }>
  | E<'item_thrown', {
      actor: EntityId | null; actorKind: string | null; item: EntityId; kind: string | null; appearanceId: string | null;
      from: Pos; to: Pos; landed: Pos | null; hit: EntityId | null; hitKind: string | null; broke: boolean;
      /** 結果（v3）: hit 命中 / missed 外れ / blocked 途中で遮られた / fell_short 射程が足りない / no_target 狙った場所に誰もいない */
      outcome?: 'hit' | 'missed' | 'blocked' | 'fell_short' | 'no_target';
      blockedBy?: 'terrain' | 'actor' | null;
      /** 遮った・外れた相手（命中しなかった場合も含む） */
      reached?: EntityId | null; reachedKind?: string | null;
      /** 当たった・遮った相手の接辞 */
      reachedAffixes?: string[] | null;
    }>
  | E<'item_identified', { player: PlayerId; kind: string; appearanceId: string | null }>
  /** キャンプが持たせた品（帰還の綱。V3-2R2 §18.1）。状態変化は put/del */
  | E<'item_issued', { actor: EntityId; item: EntityId; kind: string; qty: number; reason: string }>
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
      /** 射線が通る視界内の敵（after 値。変化したときだけ） */
      shotsAfter?: EntityId[];
      /** metAdd の各個体を初めて見た seq（after 値。v3 以降） */
      metAtAfter?: Record<EntityId, number>;
      /** 地図の巻物などで地形だけ知ったセル（追加）と、自分の目で見たので外すセル（V3-2R） */
      mappedAdd?: number[];
      mappedDel?: number[];
      /** 目標の気配（after 値。変化したときだけ。null は気配なし） */
      senseAfter?: Sense | null;
      /** 今いる階の手がかり（after 値。変化したときだけ。V3-2R2） */
      hintAfter?: FloorHint | null;
    }>
  | E<'monster_memory_updated', { player: PlayerId; kind: string; memoryAfter: MonsterMemory }>
  | E<'notes_updated', { player: PlayerId; notesAfter: string[] }>
  // 遠征
  | E<'expedition_offered', { camp: CampState }>
  | E<'expedition_started', { expedition: Expedition }>
  | E<'objective_progress', {
      no: number; progressAfter: ObjectiveProgress; statusAfter: Expedition['status'];
      targetsAfter?: Expedition['targets']; extractedAfter?: Expedition['extracted'];
    }>
  | E<'objective_completed', { no: number; objective: Objective }>
  /** 戦利品の共有部分が増えた（after 値） */
  | E<'haul_changed', { no: number; haulAfter: ExpeditionHaul; gains: Partial<ExpeditionHaul>; reasons: string[] }>
  | E<'expedition_ended', { no: number; reason: ExpeditionEndReason; result: ExpeditionResult; summary: RunSummary }>
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

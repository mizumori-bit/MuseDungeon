// プレイヤー向けイベントフィルタ（ルール無し）。仕様: docs/PROTOCOL.md §5
// seenBy に含まれないものを落とし、見えていないエンティティ参照を null にし、内部用イベントを除く。
import type { GameEvent, EventType } from './events';
import { INTERNAL_EVENT_TYPES } from './events';
import type { PlayerId } from './types';
import type { PlayerView } from './view';

/** プレイヤーに渡してよいイベント種別（これ以外は内部・俯瞰専用） */
const PLAYER_VISIBLE: ReadonlySet<EventType> = new Set<EventType>([
  'player_joined', 'player_state', 'run_ended',
  'tile_changed', 'entity_moved', 'entity_changed_floor',
  'attack', 'damaged', 'healed', 'max_hp_changed', 'died',
  'status_applied', 'status_expired',
  'xp_gained', 'level_up',
  'item_picked_up', 'item_dropped', 'item_equipped', 'item_unequipped', 'item_used', 'item_thrown',
  'item_identified', 'feature_state', 'trap_revealed', 'trap_triggered',
  'noise', 'thought', 'chat', 'entity_removed',
]);

/** 自分に関するときだけ渡す種別 */
const SELF_ONLY: Partial<Record<EventType, (ev: any, playerId: PlayerId, selfId: string) => boolean>> = {
  xp_gained: (ev, _p, self) => ev.target === self,
  level_up: (ev, _p, self) => ev.target === self,
  item_identified: (ev, p) => ev.player === p,
  trap_revealed: (ev, p) => ev.player === p,
  thought: (ev, p) => ev.player === p,
};

/** プレイヤー向けに縮約したイベント（seenBy/masks/put/del を除去済み） */
export type ProjectedEvent = Omit<GameEvent, 'seenBy' | 'masks' | 'put' | 'del'> & Record<string, unknown>;

export interface PerceivedEvent {
  seq: number;
  type: EventType;
  text: string;
  event: ProjectedEvent;
}

export function eventVisibleTo(ev: GameEvent, playerId: PlayerId): boolean {
  if (INTERNAL_EVENT_TYPES.has(ev.type)) return false;
  if (ev.seenBy === 'all') return true;
  return ev.seenBy.includes(playerId);
}

export function filterEventsForPlayer(events: readonly GameEvent[], playerId: PlayerId, view: PlayerView): ProjectedEvent[] {
  const out: ProjectedEvent[] = [];
  const selfId = view.self.id;
  const identified = new Set(view.identified);
  for (const ev of events) {
    if (!PLAYER_VISIBLE.has(ev.type)) continue;
    if (!eventVisibleTo(ev, playerId)) continue;
    const selfOnly = SELF_ONLY[ev.type];
    if (selfOnly && !selfOnly(ev, playerId, selfId)) continue;
    const { seenBy: _s, masks, put: _p, del: _d, ...rest } = ev as GameEvent & Record<string, unknown>;
    const pe = structuredClone(rest) as Record<string, unknown>;
    const masked = masks?.[playerId] ?? [];
    for (const f of masked) {
      if (f in pe) pe[f] = null;
      if (`${f}Kind` in pe) pe[`${f}Kind`] = null;
    }
    switch (ev.type) {
      case 'damaged':
      case 'healed':
        if (ev.target !== selfId) delete pe.hpAfter;
        break;
      case 'max_hp_changed':
        if (ev.target !== selfId) continue;
        break;
      case 'player_joined':
        pe.player = { id: ev.player.id, name: ev.player.name, classId: ev.player.classId, controller: ev.player.controller };
        delete pe.entity;
        break;
      case 'entity_removed':
        // 視界内で消えたアイテム等のみ。理由だけ残す
        break;
      default:
        break;
    }
    if ('appearanceId' in pe && pe.appearanceId && typeof pe.kind === 'string' && !identified.has(pe.kind)) {
      pe.kind = null;
    }
    out.push(pe as ProjectedEvent);
  }
  return out;
}

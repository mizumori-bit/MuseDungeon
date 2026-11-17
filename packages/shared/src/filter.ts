// プレイヤー向けイベントフィルタ（ルール無し）。仕様: docs/PROTOCOL.md §5
// seenBy に含まれないものを落とし、見えていないエンティティ参照を null にし、内部用イベントを除く。
import { dirTo } from './util';
import type { GameEvent, EventType } from './events';
import { INTERNAL_EVENT_TYPES } from './events';
import type { PlayerId, Pos } from './types';
import type { PlayerView } from './view';

/** プレイヤーに渡してよいイベント種別（これ以外は内部・俯瞰専用） */
const PLAYER_VISIBLE: ReadonlySet<EventType> = new Set<EventType>([
  'player_joined', 'player_state', 'run_ended',
  'tile_changed', 'entity_moved', 'entity_changed_floor',
  'attack', 'damaged', 'healed', 'max_hp_changed', 'died',
  'status_applied', 'status_expired',
  'xp_gained', 'level_up', 'perk_offered', 'perk_chosen', 'perk_triggered', 'monster_woke', 'guardian_intel', 'guardian_acted', 'boon_granted', 'boon_triggered', 'ability_used', 'curse_revealed', 'item_inspected', 'curse_lifted',
  'item_picked_up', 'item_dropped', 'item_equipped', 'item_unequipped', 'item_used', 'item_thrown',
  'item_identified', 'item_issued', 'feature_state', 'trap_revealed', 'trap_triggered',
  'noise', 'thought', 'chat', 'entity_removed',
  // 遠征（objective_progress は守護者・遺物の ID を含むので俯瞰専用）
  'expedition_offered', 'expedition_started', 'objective_completed', 'expedition_ended', 'haul_changed',
]);

/** 自分に関するときだけ渡す種別 */
const SELF_ONLY: Partial<Record<EventType, (ev: any, playerId: PlayerId, selfId: string) => boolean>> = {
  xp_gained: (ev, _p, self) => ev.target === self,
  level_up: (ev, _p, self) => ev.target === self,
  perk_offered: (ev, _p, self) => ev.target === self,
  perk_chosen: (ev, _p, self) => ev.target === self,
  perk_triggered: (ev, _p, self) => ev.actor === self,
  item_inspected: (ev, _p, self) => ev.actor === self,
  curse_lifted: (ev, _p, self) => ev.actor === self,
  item_identified: (ev, p) => ev.player === p,
  trap_revealed: (ev, p) => ev.player === p,
  guardian_intel: (ev, p) => ev.player === p,
  boon_granted: (ev, _p, self) => ev.target === self,
  boon_triggered: (ev, _p, self) => ev.actor === self,
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
      if (`${f}Affixes` in pe) pe[`${f}Affixes`] = null;
    }
    // 見えていた個体が視界の外へ動いた: 行き先は伏せ、向きだけ残す（「北東へ」）
    if (ev.type === 'entity_moved' && masked.includes('to') && !masked.includes('from')) {
      const raw = ev as unknown as { from: Pos; to: Pos };
      const d = dirTo(raw.from, raw.to);
      if (d) pe.dirOut = d;
    }
    switch (ev.type) {
      case 'damaged':
        // 視界外の相手への毒（自分が毒を与えた）: 名前・体力・位置を出さない（V3-2R2 §18.7）。倒れたときだけ died で知らせる
        if (ev.via === 'poison' && ev.target !== selfId && masked.includes('target')) continue;
        delete pe.seenTotals;
        if (ev.target !== selfId) { delete pe.hpAfter; delete pe.fromDir; }
        break;
      case 'attack':
        if (ev.target !== selfId) delete pe.fromDir;
        break;
      case 'healed':
        if (ev.target !== selfId) delete pe.hpAfter;
        break;
      case 'expedition_offered': {
        // 候補の守護者の種族は会うまで渡さない（特徴だけ）
        const camp = pe.camp as { offers?: { guardianKind?: string }[] } | undefined;
        for (const o of camp?.offers ?? []) delete o.guardianKind;
        break;
      }
      case 'expedition_started': {
        // 開始時点の他プレイヤーの成績と目標の ID は渡さない
        const x = (pe.expedition ?? {}) as Record<string, unknown>;
        pe.expedition = { no: x.no, objective: x.objective, points: x.points, relicGuarded: x.relicGuarded, participants: x.participants };
        break;
      }
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

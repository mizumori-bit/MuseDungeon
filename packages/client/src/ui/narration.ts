// 観戦・リプレイ用の文章化。追従視点ではプレイヤー向けフィルタを通してから narrate する。
import type { Catalog, GameEvent, Locale, PerceivedEvent, PlayerView, ProjectedEvent, World } from '@muse/shared';
import { filterEventsForPlayer, narrate, projectPlayerView } from '@muse/shared';
import type { LogLine, ThoughtLine } from './panels';

export function namesFromWorld(world: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pid of world.playerOrder) {
    const p = world.players[pid];
    out[pid] = p.name;
    out[p.entityId] = p.name;
  }
  return out;
}

export function namesFromView(view: PlayerView): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of view.party) {
    out[p.playerId] = p.name;
    out[p.entityId] = p.name;
  }
  return out;
}

/** 俯瞰（全イベント）または追従（そのプレイヤーが知覚したもの）の文章 */
export function narrateWorld(events: readonly GameEvent[], world: World, catalog: Catalog, locale: Locale, follow: string | null): LogLine[] {
  const names = namesFromWorld(world);
  const out: LogLine[] = [];
  if (follow && world.players[follow]) {
    const view = projectPlayerView(world, follow);
    const ctx = { locale, catalog, selfId: view.self.id, selfPlayerId: view.playerId, playerNames: names, selfPos: view.self.pos };
    for (const ev of filterEventsForPlayer(events, follow, view)) {
      const text = narrate(ev, ctx);
      if (text) out.push({ seq: ev.seq, text, kind: ev.type === 'chat' ? 'chat' : undefined });
    }
    return out;
  }
  const ctx = { locale, catalog, selfId: null, playerNames: names };
  for (const ev of events) {
    if (ev.type === 'thought') {
      out.push({ seq: ev.seq, text: `💭 ${names[ev.player] ?? ev.player}: ${ev.text}`, kind: 'thought' });
      continue;
    }
    const text = narrate(ev as unknown as ProjectedEvent, ctx);
    if (text) out.push({ seq: ev.seq, text, kind: ev.type === 'chat' ? 'chat' : undefined });
  }
  return out;
}

export function perceivedLines(events: readonly PerceivedEvent[]): LogLine[] {
  return events.filter((e) => e.text).map((e) => ({ seq: e.seq, text: e.text, kind: e.type === 'chat' ? 'chat' as const : undefined }));
}

export function thoughtsFrom(events: readonly GameEvent[], world: World): ThoughtLine[] {
  const out: ThoughtLine[] = [];
  for (const ev of events) {
    if (ev.type !== 'thought') continue;
    out.push({ seq: ev.seq, player: ev.player, name: world.players[ev.player]?.name ?? ev.player, text: ev.text });
  }
  return out;
}

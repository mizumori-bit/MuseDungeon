// 観戦・リプレイ用の文章化。追従視点ではプレイヤー向けフィルタを通してから narrate する。
import type { Catalog, GameEvent, Locale, PerceivedEvent, PlayerView, ProjectedEvent, World } from '@muse/shared';
import { directiveItemsText, filterEventsForPlayer, narrate, projectPlayerView } from '@muse/shared';
import { getLocale, tr } from '../util';
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

/** 指図の握った項目の 1 行（伝言の行に添える） */
function holdSub(hold: readonly string[]): string {
  const held = directiveItemsText(getLocale(), hold);
  return held ? tr(`指図: ${held}は持ち主がキャンプで決める`, `Directive: the owner decides ${held} at camp`) : tr('指図: 何も握っていない（AI がすべて決める）', 'Directive: holds nothing (the AI decides everything)');
}

/**
 * 持ち主の決定と伝言（S8。SEASON.md §54.6）を、思考の欄の行に。owner_decided は narrate の文（「持ち主が、装備を変えた: …」）、
 * directive_set は伝言（無ければ握った項目）。ctx が無ければ（カタログを読む前）、決定の行は出さない
 */
function ownerLine(ev: { seq: number; type: string } & Record<string, unknown>, player: string, name: string, ctx: Parameters<typeof narrate>[1] | null): ThoughtLine | null {
  if (ev.type === 'owner_decided') {
    const text = ctx ? narrate(ev as unknown as ProjectedEvent, ctx) : null;
    return text ? { seq: ev.seq, player, name, text, kind: 'owner' } : null;
  }
  if (ev.type === 'directive_set') {
    const d = ev.directiveAfter as { hold?: string[]; message?: string } | undefined;
    const msg = (d?.message ?? '').trim();
    return msg
      ? { seq: ev.seq, player, name, text: msg, kind: 'owner_msg', sub: holdSub(d?.hold ?? []) }
      : { seq: ev.seq, player, name, text: holdSub(d?.hold ?? []), kind: 'owner_msg' };
  }
  return null;
}

/**
 * 思考の欄の行: AI の考え（thought）と、持ち主の決定・伝言（S8 §54.6。catalog があるとき決定の文も）。seq の順（出来事の順）。
 * 持ち主の行は、そのプレイヤーの出来事として World に載っている（俯瞰・リプレイ）
 */
export function thoughtsFrom(events: readonly GameEvent[], world: World, catalog?: Catalog | null): ThoughtLine[] {
  const out: ThoughtLine[] = [];
  let ctx: Parameters<typeof narrate>[1] | null | undefined;
  for (const ev of events) {
    if (ev.type === 'thought') {
      out.push({ seq: ev.seq, player: ev.player, name: world.players[ev.player]?.name ?? ev.player, text: ev.text });
      continue;
    }
    if (ev.type !== 'owner_decided' && ev.type !== 'directive_set') continue;
    if (ctx === undefined) ctx = catalog ? { locale: getLocale(), catalog, selfId: null, playerNames: namesFromWorld(world) } : null;
    const line = ownerLine(ev as unknown as { seq: number; type: string } & Record<string, unknown>, ev.player, world.players[ev.player]?.name ?? ev.player, ctx);
    if (line) out.push(line);
  }
  return out;
}

/**
 * 追従だけの観戦（World が来ない。view の枠の出来事だけ）の、持ち主の決定と伝言（S8 §54.6）。出来事は追従の相手に届いたもの（本人だけの出来事）。
 * 文は画面の言葉で narrate し直す（カタログが無ければサーバーの文）
 */
export function ownerLinesFromPerceived(events: readonly PerceivedEvent[], view: PlayerView, catalog: Catalog | null): ThoughtLine[] {
  const out: ThoughtLine[] = [];
  const ctx = catalog ? { locale: getLocale(), catalog, selfId: view.self.id, selfPlayerId: view.playerId, playerNames: namesFromView(view), selfPos: view.self.pos } : null;
  for (const pe of events) {
    if (pe.type !== 'owner_decided' && pe.type !== 'directive_set') continue;
    const ev = pe.event as unknown as { seq: number; type: string; player?: string } & Record<string, unknown>;
    const player = typeof ev.player === 'string' ? ev.player : view.playerId;
    const name = view.party.find((p) => p.playerId === player)?.name ?? view.self.name;
    const line = ownerLine({ ...ev, seq: pe.seq, type: pe.type }, player, name, ctx);
    if (line) out.push(line);
    else if (pe.type === 'owner_decided' && pe.text) out.push({ seq: pe.seq, player, name, text: pe.text, kind: 'owner' });
  }
  return out;
}

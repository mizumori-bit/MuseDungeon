// Scene の組み立て。(a) PlayerView（プレイ・追従観戦）と (b) World 全体（俯瞰）。
// プレイヤー視点では未知セルを描かない。未鑑定アイテムは外見 ID でしか描かない。
import type { Catalog, EntityView, MonsterTrait, ObsMonster, Pos, PlayerView, World } from '@muse/shared';
import {
  dealtText, hitsText, hpEstimateText, hpLeftEstimate, itemDisplayName, kindName, memoryOf, monsterDisplayName, monsterSpeedOf, nameOf, selfSpeed, threatOf, worstTurnOf,
} from '@muse/shared';
import type { AssetRef } from '../theme/types';
import { monsterLooksText, monsterSpeedLabel, threatText, worstTurnText } from '../ui/labels';
import { getLocale, tr } from '../util';
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

/** ツールチップ用: 役割の表示（守護者・遺物）。bounty があれば賞金も（守護者・名前付きの強敵） */
export function roleLabel(role: 'guardian' | 'relic' | 'elite' | undefined, bounty?: number): string {
  if (role === 'elite') return bounty ? tr(` ［強敵・賞金 ${bounty}］`, ` [elite, bounty ${bounty}]`) : tr(' ［強敵］', ' [elite]');
  if (role === 'guardian') return bounty ? tr(` ［守護者・賞金 ${bounty}］`, ` [guardian, bounty ${bounty}]`) : tr(' ［守護者］', ' [guardian]');
  if (role === 'relic') return tr(' ［遺物］', ' [relic]');
  if (bounty) return tr(` ［賞金 ${bounty}］`, ` [bounty ${bounty}]`);
  return '';
}

/** 名札用: この遠征の目的の相手・品の印（観測の文と同じ「［目的］」。V4-1a §12.2） */
export function objectiveTag(objective?: boolean): string {
  return objective ? tr('［目的］', ' [objective]') : '';
}

/** ツールチップ用: 宝の価値と、自分が投げた物の印 */
export function itemTags(p: { value?: number; mine?: boolean }): string {
  return (p.value !== undefined ? tr(` ［宝・価値 ${p.value}］`, ` [treasure ${p.value}]`) : '')
    + (p.mine ? tr(' ［自分が投げた］', ' [yours]') : '');
}

export interface SceneExtras {
  cursor?: Pos | null;
  path?: Pos[] | null;
  bubbles?: { id: string; text: string }[];
  /** 観測の visible.monsters（あればツールチップを観測と同じ値で作る: 速さ・特徴・初見・命中の記録） */
  monsters?: readonly ObsMonster[];
}

/** 見れば分かる特徴のうち、種族の公開タグから分かるもの（観測の traits と同じ。重装はカタログの armored から） */
const TAG_TRAITS: readonly MonsterTrait[] = ['pack', 'ranged', 'stationary'];

/** 「最大の一撃 5（1 手に最悪 10）」。記録が無ければ「一撃の大きさは不明」 */
function worstText(m: Pick<ObsMonster, 'worst_hit' | 'worst_turn'>): string {
  if (m.worst_hit === null) return tr('一撃の大きさは不明', 'hit size unknown');
  const per = worstTurnText(m);
  return tr(`最大の一撃 ${m.worst_hit}${per ? `（${per}）` : ''}`, `worst hit ${m.worst_hit}${per ? ` (${per})` : ''}`);
}

/**
 * ツールチップ用: 脅威・受けた最大の一撃と 1 手番あたりの最悪の被害・体格と速さと見れば分かる特徴・命中と通りの記録・
 * 見た被害（見ている間にその個体が受けた被害の合計。V4-0e §8.4）・推定残り HP・射線。
 * 観測の monster があればその値を使う。無ければ PlayerView の知識だけから（観測と同じ shared の式。守護者は守護者の記録 memoryOf）
 */
function monsterKnowledge(view: PlayerView, catalog: Catalog, e: EntityView, om?: ObsMonster): string {
  const L = getLocale();
  const parts: string[] = [];
  if (om) {
    parts.push(threatText(om.threat, om.first_seen));
    parts.push(worstText(om));
    const sp = monsterSpeedLabel(om.speed);
    if (sp) parts.push(sp);
    const looks = monsterLooksText(om);
    if (looks) parts.push(looks);
    const hits = hitsText(L, om.hits);
    if (hits) parts.push(hits);
    const dealt = dealtText(L, om.dealt);
    if (dealt) parts.push(dealt);
    if (om.damage_seen) parts.push(tr(`見た被害 ${om.damage_seen}`, `dmg seen ${om.damage_seen}`));
    if (om.hp_left_est) parts.push(`${tr('推定残りHP', 'est. HP left')} ${hpEstimateText(L, om.hp_left_est)}`);
    if (om.shot === 'blocked') parts.push(tr('射線: 通らない', 'shot: blocked'));
    return ` (${parts.join(', ')})`;
  }
  // 守護者は種族と別の記録（V3-2R3 §20.4）
  const mem = memoryOf(view, e);
  const threat = threatOf(view, e);
  // 本当に初めて見た種族（観測の first_seen と同じ規則: 撃破が無く、遭遇した個体の数がいま見えている数以下）
  const visibleOfKind = view.entities.filter((x) => x.cat === 'monster' && x.kind === e.kind).length;
  const firstSeen = !mem || (mem.kills === 0 && mem.encounters <= visibleOfKind);
  parts.push(threatText(threat, firstSeen));
  const worst = mem?.maxDamageToYou ?? 0;
  parts.push(worstText({ worst_hit: worst > 0 ? worst : null, worst_turn: worstTurnOf(view, catalog, e) }));
  // 速さ（自分の今の速さとの比較）と、見れば分かる体格・特徴（観測の speed / size / traits と同じ）
  const sp = monsterSpeedOf(catalog, e);
  const mine = selfSpeed(view, catalog);
  const spLabel = monsterSpeedLabel(sp === null || sp === mine ? 'normal' : sp > mine ? 'fast' : 'slow');
  if (spLabel) parts.push(spLabel);
  const cm = e.kind ? catalog.monsters[e.kind] : undefined;
  const looks = monsterLooksText({
    size: cm?.size === 'small' || cm?.size === 'large' ? cm.size : undefined,
    traits: [...TAG_TRAITS.filter((t) => cm?.tags.includes(t)), ...(cm?.armored ? ['armored' as const] : [])],
  });
  if (looks) parts.push(looks);
  const dealt = dealtText(L, mem?.dmgByYou);
  if (dealt) parts.push(dealt);
  if (e.damageSeen) parts.push(tr(`見た被害 ${e.damageSeen}`, `dmg seen ${e.damageSeen}`));
  // 推定残り HP（守護者は守護者の体力の記録から。観測の hp_left_est と同じ）
  const est = e.hp ? hpLeftEstimate(mem, e.hp, e.damageSeen ?? 0, catalog.rules?.estimateMinSamples ?? 5) : undefined;
  if (est) parts.push(`${tr('推定残りHP', 'est. HP left')} ${hpEstimateText(L, est)}`);
  if (e.shot === false) parts.push(tr('射線: 通らない', 'shot: blocked'));
  return parts.length ? ` (${parts.join(', ')})` : '';
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
  // 地形は知っているが、まだ目で見ていないセル（地図の巻物）。見たセルの記憶より暗く描く
  for (const i of view.memory.unsighted ?? []) if (vis[i] === 1) vis[i] = 3;
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
      ents.push({
        id: r.id, layer: 'item', ref: { ...itemRef(catalog, r.kind, r.appearanceId), x: r.pos.x, y: r.pos.y }, x: r.pos.x, y: r.pos.y,
        label: itemDisplayName(catalog, L, r.kind, r.appearanceId) + objectiveTag(r.objective) + (r.qty > 1 ? ` x${r.qty}` : '') + roleLabel(r.role) + itemTags(r),
        statuses: [], affixes: [], remembered: true, role: r.role, treasure: r.value !== undefined,
      });
    } else {
      ents.push({ id: r.id, layer: 'feature', ref: { cls: 'feature', id: r.kind ?? 'unknown', state: r.state }, x: r.pos.x, y: r.pos.y, label: kindName(catalog, L, r.kind), statuses: [], affixes: [], remembered: true });
    }
  }
  for (const e of view.entities) {
    const base = { id: e.id, x: e.pos.x, y: e.pos.y, statuses: e.statuses ?? [], affixes: e.affixes ?? [], role: e.role };
    if (e.cat === 'item') {
      ents.push({
        ...base, layer: 'item', ref: { ...itemRef(catalog, e.kind, e.appearanceId), x: e.pos.x, y: e.pos.y },
        label: itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes ?? []) + objectiveTag(e.objective) + ((e.qty ?? 1) > 1 ? ` x${e.qty}` : '') + roleLabel(e.role) + itemTags(e),
        treasure: e.value !== undefined,
      });
    } else if (e.cat === 'feature' || e.cat === 'trap') {
      ents.push({ ...base, layer: 'feature', ref: { cls: 'feature', id: e.kind ?? 'unknown', state: e.state }, label: kindName(catalog, L, e.kind) });
    } else if (e.cat === 'monster') {
      ents.push({
        ...base, layer: 'actor', ref: { cls: 'actor', id: e.kind ?? 'unknown' },
        label: monsterDisplayName(catalog, L, e) + objectiveTag(e.objective) + roleLabel(e.role, e.bounty) + monsterKnowledge(view, catalog, e, extras.monsters?.find((m) => m.id === e.id)),
        hpBucket: e.hp, hostile: true, asleep: e.awareness === 'asleep',
      });
    } else {
      ents.push({ ...base, layer: 'actor', ref: { cls: 'actor', id: e.kind ?? 'unknown' }, label: e.name ?? '?', hpBucket: e.hp, isPlayer: true, name: e.name, color: colorOf(e.playerId) });
    }
  }
  // 同じ階で見えていない仲間（V4-1k §32.3）: 位置に仲間の印だけを出す（覚えている物と同じく暗く。その場所の地形・敵は渡されない）
  for (const p of view.party) {
    if (p.playerId === view.playerId || !p.pos || visibleIds.has(p.entityId)) continue;
    ents.push({
      id: p.entityId, layer: 'actor', ref: { cls: 'actor', id: p.classId }, x: p.pos.x, y: p.pos.y,
      label: `${p.name}${L === 'ja' ? '（見えていない）' : ' (out of sight)'}`, isPlayer: true, name: p.name, color: colorOf(p.playerId),
      statuses: [], affixes: [], remembered: true,
    });
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
  // 目標の気配（遠征中、目標階にいる間だけ。観測の expedition.sense と同じ条件）
  const xv = view.expedition;
  const sense = view.sense && xv && xv.status !== 'ended' && view.status !== 'at_camp' ? { ...view.sense } : null;
  // 下への風（今いる階の下り階段が未発見の間だけ。観測の self.floor.draft と同じ）
  const draft = view.floorHint?.draft && view.status !== 'at_camp' ? view.floorHint.draft : null;
  return {
    mode: 'player', floorKey: f.key, width: f.width, height: f.height, biome: f.biome, terrain, vis, entities: ents,
    focus: me.pos, focusId: me.id, cursor: extras.cursor ?? null, path: extras.path ?? null, bubbles: extras.bubbles ?? [], catalog,
    sense, draft,
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
    const base = { id: e.id, x: e.pos.x, y: e.pos.y, statuses: (e.statuses ?? []).map((s) => s.id), affixes: e.scale?.affixes ?? [], role: e.role };
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
        ...base, layer: 'actor', ref: { cls: 'actor', id: e.kind }, label: (af ? (L === 'en' ? `${af} ${nm}` : af + nm) : nm) + tier + roleLabel(e.role, e.bounty),
        hpFrac: e.stats ? e.stats.hp / Math.max(1, e.stats.maxHp) : 1, hostile: true,
        asleep: !!e.actor.dormant || e.actor.ai?.state === 'asleep' || (e.statuses ?? []).some((s) => s.id === 'core:sleep'),
      });
    } else if (e.item) {
      const app = world.secret.appearances[e.kind] ?? null;
      const category = catalog.items[e.kind]?.category;
      // 俯瞰でも未鑑定になり得る種別は外見で描く（画像から正体を漏らさない）
      const ref: AssetRef = app ? { cls: 'appearance', id: app, category, x: e.pos.x, y: e.pos.y } : { cls: 'item', id: e.kind, category, x: e.pos.x, y: e.pos.y };
      const thrower = e.item.thrownBy ? world.players[e.item.thrownBy]?.name : undefined;
      ents.push({
        ...base, layer: 'item', ref,
        label: itemDisplayName(catalog, L, e.kind, null, e.item.affixes) + (e.item.qty > 1 ? ` x${e.item.qty}` : '') + roleLabel(e.role) + itemTags({ value: e.item.value })
          + (thrower ? tr(` ［${thrower} が投げた］`, ` [thrown by ${thrower}]`) : ''),
        treasure: e.item.value !== undefined,
      });
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

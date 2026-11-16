// Observation: PlayerView に AI が使いやすい派生情報を足して整形したもの。
// 派生情報は PlayerView（とカタログ）だけから計算する。仕様: docs/PROTOCOL.md §3
import type { Catalog } from './catalog';
import { dangerOf, haulTotal, nameOf, nextOverreach, overreachPoints, payoutOf, recommendedLevel, regenInterval, regenStep } from './catalog';
import { multText, objectiveText, offerText, partsText, progressText, resultText } from './expedition';
import type { PerceivedEvent } from './filter';
import { kindName } from './narrate';
import type { NavGrid } from './nav';
import { buildNavGrid, distanceField, findFrontiers } from './nav';
import type { Dir, EntityRole, Expedition, HaulParts, Locale, MonsterMemory, ObjectiveType, OfferSlot, Pos } from './types';
import { DIRS, DIR_VEC } from './types';
import { cheb, ceilDiv, dirTo, floorDiv, t } from './util';
import type { EntityView, HpState, ItemView, PlayerView, ViewStatus } from './view';
import { hpState, xpForLevel } from './view';

export interface Alert { code: string; text: string; entity?: string }

export interface ObsMonster {
  id: string; name: string; pos: Pos; dir: Dir | null; dist: number;
  hp_state: HpState; awareness: string; threat: 1 | 2 | 3 | 4 | 5; statuses: string[];
  /** 遠征の守護者 */
  role?: EntityRole;
  /** 手負いで逃げている（追跡中でも extract・休息を妨げない） */
  fleeing?: boolean;
  /** 自分が見ている間にこの個体が受けた実ダメージの合計 */
  damage_seen?: number;
  /**
   * 推定残り HP（思い出に体力の記録がある種族のみ。4 段階表示と damage_seen から計算）。
   * 記録が rules.estimateMinSamples 体未満の間は上限を出さない（max: null）
   */
  hp_left_est?: { min: number; max: number | null; samples: number };
  /** 自分のセルから投擲の経路が通るか */
  shot: 'clear' | 'blocked';
  /** 倒すと戦利品に入る賞金 */
  bounty?: number;
}
/** 同じセルの同種の物は 1 行にまとめる（ids に全て。id は先頭） */
export interface ObsItem { id: string; ids?: string[]; name: string; pos: Pos; dir: Dir | null; dist: number; qty: number; remembered?: boolean; role?: EntityRole; mine?: boolean; value?: number }

export interface RestEstimate {
  hp_to_full: number;
  /** 全快までの手番数（追跡中の敵が見えず毒も無いまま休み続けた場合） */
  turns: number;
  /** 経過するフロア時間 */
  time: number;
  /** その間に湧く徘徊モンスターの目安（公開ルールの湧き間隔から） */
  wander_expected: string;
  blocked_by?: 'hostile_hunting' | 'poisoned';
}

export interface ObsExpedition {
  no: number;
  objective: { type: ObjectiveType; target_depth: number | null; text: string };
  progress: { depth: number | null; target_depth: number | null; reached?: boolean; guardian_slain?: boolean; relic_held?: boolean };
  status: Expedition['status'];
  points: number;
  /** 今この場で extract できるか */
  can_extract: boolean;
  /** 今 extract したら: complete（達成して帰還）/ withdraw（撤退、confirm が必要） */
  extract_outcome: 'complete' | 'withdraw';
  extract_blocked_by?: 'not_on_stairs' | 'hostile_hunting' | 'not_your_turn' | 'ended';
  /** 1 行の要約 */
  text: string;
  /** 終了した遠征の結果 */
  result?: { reason: string; points: number; deepest: number; kills: number; turns: number; text: string };
  slot?: OfferSlot;
  traits?: string[];
  /** 未確定の戦利品（v3）。今 extract した場合の確定点と、次に深追いの点が入る階 */
  haul?: {
    total: number; multiplier_pct: number; parts: HaulParts;
    if_extract_now: number;
    next_overreach: { depth: number; points: number } | null;
    /** 1 行の要約 */
    text: string;
  };
}

export interface ObsCamp {
  next_no: number;
  offers: {
    index: number; type: ObjectiveType; target_depth: number | null; points: number; text: string;
    slot?: OfferSlot; traits?: string[]; multiplier_pct: number; danger: number | null; recommended_level: number | null;
  }[];
}
export interface ObsPlayer { id: string; name: string; pos: Pos; dir: Dir | null; dist: number; hp_state: HpState }
export interface ObsFeature { type: string; name: string; pos: Pos; dir: Dir | null; dist: number; state?: string }
export interface ObsInvItem { slot: string; name: string; qty: number; category: string; identified: boolean; equipped: boolean; value?: number }

export interface Observation {
  seq: number;
  status: ViewStatus;
  summary: string;
  alerts: Alert[];
  self: {
    name: string; class: string; level: number; xp: number; xp_next: number;
    hp: number; max_hp: number; statuses: { id: string; name: string; turns_left: number }[];
    pos: Pos | null; floor: { depth: number; biome_name: string; floor_type: string; time: number } | null;
    attack: { acc: number; dmg: string }; defense: { eva: number; armor: number };
    equipment: { weapon?: string; armor?: string; accessory?: string };
    inventory_count: number; inventory_capacity: number;
    inventory_brief?: string;
    inventory?: ObsInvItem[];
    /** 自分が行動した手番数 */
    turns: number;
    /** 実効の速さ（標準 100。状態異常込み） */
    speed: number;
    /** スコア版 2: 確定済みの点と達成した遠征の数 */
    score: { banked: number; expeditions_completed: number };
    /** HP が減っているときのみ: 全快まで休んだ場合の見積もり */
    rest_estimate?: RestEstimate;
  };
  /** items_omitted: 記憶の中の遠いアイテムのうち省いた件数 */
  visible: { monsters: ObsMonster[]; items: ObsItem[]; players: ObsPlayer[]; features: ObsFeature[]; items_omitted?: number };
  navigation: {
    here: string;
    passable_dirs: Dir[];
    frontiers: { pos: Pos; dir: Dir | null; dist: number }[];
    /** path_len: 既知地図上の経路長（不明なら null） */
    known_stairs: { type: 'down' | 'up'; pos: Pos; dist: number; reachable: boolean; path_len: number | null }[];
  };
  recent_events: string[];
  map?: { origin: Pos; rows: string[]; legend: Record<string, string> };
  valid_actions: string[];
  /** 遠征の目的と進捗（事実の表示。次の一手の指示ではない） */
  expedition?: ObsExpedition;
  /** キャンプの候補（遠征と遠征の間のみ） */
  camp?: ObsCamp;
}

export interface ObservationOptions {
  detail: 'brief' | 'full';
  map: boolean;
  mapWidth?: number;
  mapHeight?: number;
  recent?: PerceivedEvent[];
}

const DIR_JA: Record<Dir, string> = { n: '北', ne: '北東', e: '東', se: '南東', s: '南', sw: '南西', w: '西', nw: '北西' };

/** 地物の状態の表示名 */
function featureStateText(L: Locale, s: string): string {
  const m: Record<string, [string, string]> = { used: ['使用済み', 'used'], open: ['開', 'open'], closed: ['閉', 'closed'], revealed: ['発見済み', 'revealed'] };
  return m[s] ? t(L, m[s][0], m[s][1]) : s;
}

export function dirLabel(locale: Locale, d: Dir | null): string {
  if (!d) return t(locale, '足元', 'here');
  return locale === 'en' ? d : DIR_JA[d];
}

/** "東8南4" のような相対位置 */
export function relLabel(locale: Locale, from: Pos, to: Pos): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const parts: string[] = [];
  if (locale === 'en') {
    if (dy < 0) parts.push(`${-dy}N`);
    if (dy > 0) parts.push(`${dy}S`);
    if (dx > 0) parts.push(`${dx}E`);
    if (dx < 0) parts.push(`${-dx}W`);
    return parts.join(' ') || 'here';
  }
  if (dx > 0) parts.push(`東${dx}`);
  if (dx < 0) parts.push(`西${-dx}`);
  if (dy < 0) parts.push(`北${-dy}`);
  if (dy > 0) parts.push(`南${dy}`);
  return parts.join('') || '足元';
}

const HP_JA: Record<HpState, string> = { healthy: '健康', wounded: '軽傷', badly_wounded: '重傷', near_death: '瀕死' };
const AW_JA: Record<string, string> = { asleep: '睡眠中', unaware: '未察知', hunting: '追跡中' };

export function itemDisplayName(catalog: Catalog, locale: Locale, kind: string | null, appearanceId: string | null, affixes: readonly string[] = []): string {
  const base = kindName(catalog, locale, kind, appearanceId);
  if (!affixes.length || !kind) return base;
  const af = affixes.map((a) => nameOf(catalog.affixes[a]?.name, locale, a));
  return locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`;
}

export function monsterDisplayName(catalog: Catalog, locale: Locale, e: EntityView): string {
  const base = kindName(catalog, locale, e.kind);
  const af = (e.affixes ?? []).map((a) => nameOf(catalog.affixes[a]?.name, locale, a));
  const tier = e.tier ? `+${e.tier}` : '';
  if (!af.length) return base + tier;
  return (locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`) + tier;
}

function itemCategory(catalog: Catalog, kind: string | null, appearanceId: string | null): string {
  if (kind && catalog.items[kind]) return catalog.items[kind].category;
  if (appearanceId && catalog.appearances[appearanceId]) return catalog.appearances[appearanceId].category;
  return 'misc';
}

/**
 * 推定残り HP。思い出の体力の記録（倒した個体の最大 HP の範囲）と 4 段階表示と damage_seen だけから計算する。
 * 記録の範囲と矛盾する（接辞・深層強化で頑丈な）個体では undefined。
 */
export function hpLeftEstimate(mem: MonsterMemory | undefined, band: HpState, damageSeen: number, minSamples = 3): { min: number; max: number | null; samples: number } | undefined {
  const hs = mem?.hpSeen;
  if (!hs) return undefined;
  const lo = Math.max(hs.min, damageSeen + 1);
  if (hs.samples < minSamples) {
    // 記録が少ない間は最大値を上限として使わない: 最大 HP が lo 以上のどれかとして、下限だけを出す
    for (let m = lo; m <= lo * 4 + 10; m++) {
      for (let h = 1; h <= m - damageSeen; h++) {
        if (hpState(h, m) === band) return { min: h, max: null, samples: hs.samples };
      }
    }
    return undefined;
  }
  let mn = Number.MAX_SAFE_INTEGER;
  let mx = -1;
  for (let m = lo; m <= hs.max; m++) {
    for (let h = 1; h <= m - damageSeen; h++) {
      if (hpState(h, m) !== band) continue;
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  return mx < 0 ? undefined : { min: mn, max: mx, samples: hs.samples };
}

/** 推定残り HP の文章（「3」「3〜5」「3 以上（記録 1 体）」） */
export function hpEstimateText(locale: Locale, est: { min: number; max: number | null; samples: number }): string {
  if (est.max === null) return t(locale, `${est.min} 以上（記録 ${est.samples} 体）`, `>= ${est.min} (${est.samples} recorded)`);
  if (est.min === est.max) return `${est.min}`;
  return t(locale, `${est.min}〜${est.max}`, `${est.min}-${est.max}`);
}

/** 能力タグの表示名 */
export function abilityName(locale: Locale, a: string): string {
  const ja: Record<string, string> = { flees: '手負いで逃げる', ranged: '遠隔攻撃', fast: '速い', slow: '遅い', poison: '毒', stationary: '動かない', pack: '群れる' };
  const en: Record<string, string> = { flees: 'flees when hurt', ranged: 'ranged attack', fast: 'fast', slow: 'slow', poison: 'poison', stationary: 'stationary', pack: 'pack' };
  return (locale === 'en' ? en[a] : ja[a]) ?? a;
}

/** 思い出の戦闘情報の 1 行（look / recall で共用） */
export function memoryCombatText(locale: Locale, mem: MonsterMemory): string {
  const L = locale;
  const speed = mem.abilities.includes('fast') ? t(L, '速い', 'fast') : mem.abilities.includes('slow') ? t(L, '遅い', 'slow') : t(L, '普通（速さの違いは観測していない）', 'normal (no speed difference observed)');
  const ranged = mem.abilities.includes('ranged') ? t(L, `あり（観測した最長距離 ${mem.rangeMax ?? '?'}）`, `yes (longest seen ${mem.rangeMax ?? '?'})`) : t(L, '観測していない', 'not observed');
  const hp = mem.hpSeen ? t(L, `${mem.hpSeen.min}〜${mem.hpSeen.max}（${mem.hpSeen.samples}体）`, `${mem.hpSeen.min}-${mem.hpSeen.max} (${mem.hpSeen.samples})`) : t(L, '記録なし', 'none');
  const ab = mem.abilities.filter((a) => a !== 'fast' && a !== 'slow' && a !== 'ranged').map((a) => abilityName(L, a));
  return t(L,
    `遭遇${mem.encounters}回・撃破${mem.kills}回・速さ:${speed}・遠隔攻撃:${ranged}・受けた最大ダメージ${mem.maxDamageToYou}・与えた最大ダメージ${mem.maxDamageByYou}・体力の記録:${hp}${ab.length ? '・その他の能力:' + ab.join('、') : ''}`,
    `met ${mem.encounters}, killed ${mem.kills}, speed: ${speed}, ranged: ${ranged}, max dmg to you ${mem.maxDamageToYou}, max dmg by you ${mem.maxDamageByYou}, HP record: ${hp}${ab.length ? ', other: ' + ab.join(', ') : ''}`);
}

function effectiveSpeed(view: PlayerView, catalog: Catalog): number {
  let sp = view.self.speed;
  for (const st of view.self.statuses) {
    const pct = catalog.statuses[st.id]?.speedPct;
    if (pct !== undefined) sp = floorDiv(sp * pct, 100);
  }
  return Math.max(10, sp);
}

/** 全快まで休んだ場合の見積もり（engine の回復処理と同じ式・同じ蓄積値で数える） */
export function restEstimate(view: PlayerView, catalog: Catalog, huntingVisible: boolean): RestEstimate | undefined {
  const me = view.self;
  if (me.stats.hp >= me.stats.maxHp) return undefined;
  const rules = catalog.rules;
  const interval = regenInterval(rules, me.level);
  const mult = rules.regen.restMultiplier;
  let acc = me.regen;
  let hp = me.stats.hp;
  let turns = 0;
  const cap = Math.max(rules.restMaxTurns, 1) * 10;
  while (hp < me.stats.maxHp && turns < cap) {
    const r = regenStep(acc, hp, me.stats.maxHp, mult, interval);
    acc = r.acc;
    hp += r.heal;
    turns++;
  }
  const delay = Math.max(1, floorDiv(100 * 100, effectiveSpeed(view, catalog)));
  const time = turns * delay;
  let wander = '0';
  if (!view.floor?.noWander) {
    const lo = floorDiv(time, rules.wander.intervalMax);
    const hi = ceilDiv(time, rules.wander.intervalMin);
    wander = lo === hi ? `${lo}` : `${lo}〜${hi}`;
  }
  const est: RestEstimate = { hp_to_full: me.stats.maxHp - me.stats.hp, turns, time, wander_expected: wander };
  if (huntingVisible) est.blocked_by = 'hostile_hunting';
  else if (me.statuses.some((s) => s.id === 'core:poison')) est.blocked_by = 'poisoned';
  return est;
}

export function threatOf(view: PlayerView, e: EntityView): 1 | 2 | 3 | 4 | 5 {
  const mem = e.kind ? view.monsterMemory[e.kind] : undefined;
  const depth = view.floor?.depth ?? 1;
  let est = mem && mem.maxDamageToYou > 0 ? mem.maxDamageToYou : 2 + depth;
  if (e.tier) est += e.tier * 2;
  if (e.affixes?.length) est += e.affixes.length;
  const hits = ceilDiv(Math.max(1, view.self.stats.hp), Math.max(1, est));
  let th = hits <= 1 ? 5 : hits <= 2 ? 4 : hits <= 4 ? 3 : hits <= 7 ? 2 : 1;
  if (e.awareness === 'asleep' && th > 1) th -= 1;
  return th as 1 | 2 | 3 | 4 | 5;
}

const ITEM_GLYPH: Record<string, string> = { potion: '!', scroll: '?', weapon: ')', armor: '[', throwing: '/', accessory: '"', relic: '$' };

function terrainGlyph(catalog: Catalog, id: string | undefined): string {
  if (!id) return ' ';
  const tr = catalog.terrain[id];
  if (!tr) return '?';
  if (tr.stairs === 'down') return '>';
  if (tr.stairs === 'up') return '<';
  if (tr.door === 'closed') return '+';
  if (tr.door === 'open') return "'";
  if (tr.tags.includes('water')) return '~';
  if (tr.tags.includes('tall_grass')) return '%';
  if (tr.tags.includes('grass')) return ',';
  if (!tr.passable) return tr.opaque ? '#' : '0';
  return '.';
}

function monsterGlyph(catalog: Catalog, kind: string | null): string {
  return (kind ? catalog.monsters[kind]?.glyph : undefined) ?? 'M';
}

function featureGlyph(catalog: Catalog, kind: string | null): string {
  if (!kind) return '*';
  const f = catalog.features[kind];
  if (f?.category === 'trap') return '^';
  if (kind.includes('fountain')) return '{';
  if (kind.includes('altar')) return '_';
  return '*';
}

function termName(catalog: Catalog, locale: Locale, id: string | undefined): string {
  return id ? nameOf(catalog.terrain[id]?.name, locale, id) : t(locale, '未知', 'unknown');
}

interface MapResult { origin: Pos; rows: string[]; legend: Record<string, string> }

/** 目盛り付きの地図テキスト（上に列番号の 10 の位と 1 の位、左に行番号） */
export function mapTextLines(map: MapResult): string[] {
  const width = Math.max(1, ...map.rows.map((r) => r.length));
  const lastY = map.origin.y + map.rows.length - 1;
  const pad = String(Math.max(lastY, 0)).length;
  const tens: string[] = [];
  const ones: string[] = [];
  for (let i = 0; i < width; i++) {
    const x = map.origin.x + i;
    tens.push(x % 10 === 0 || i === 0 ? String(Math.trunc(x / 10) % 10) : ' ');
    ones.push(String(x % 10));
  }
  const lead = ' '.repeat(pad + 1);
  const out = [lead + tens.join('').replace(/\s+$/, ''), lead + ones.join('')];
  map.rows.forEach((r, i) => out.push(`${String(map.origin.y + i).padStart(pad, ' ')} ${r}`));
  return out;
}

export function renderAsciiMap(view: PlayerView, catalog: Catalog, region: { x: number; y: number; w: number; h: number }): MapResult {
  const L = view.locale;
  const f = view.floor!;
  const legend: Record<string, string> = {};
  const addLegend = (ch: string, name: string) => {
    if (ch === ' ') return;
    const cur = legend[ch];
    if (!cur) legend[ch] = name;
    else if (!cur.split('/').includes(name)) legend[ch] = `${cur}/${name}`;
  };
  const overlay = new Map<number, { ch: string; name: string }>();
  for (const r of view.memory.remembered) {
    const i = r.pos.y * f.width + r.pos.x;
    if (r.cat === 'item') overlay.set(i, { ch: ITEM_GLYPH[itemCategory(catalog, r.kind, r.appearanceId)] ?? '*', name: itemDisplayName(catalog, L, r.kind, r.appearanceId) });
    else overlay.set(i, { ch: featureGlyph(catalog, r.kind), name: kindName(catalog, L, r.kind) });
  }
  const layerOrder: EntityView['cat'][] = ['feature', 'trap', 'item', 'monster', 'player'];
  for (const cat of layerOrder) {
    for (const e of view.entities) {
      if (e.cat !== cat) continue;
      const i = e.pos.y * f.width + e.pos.x;
      if (cat === 'item') overlay.set(i, { ch: ITEM_GLYPH[itemCategory(catalog, e.kind, e.appearanceId)] ?? '*', name: itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes) });
      else if (cat === 'feature' || cat === 'trap') overlay.set(i, { ch: featureGlyph(catalog, e.kind), name: kindName(catalog, L, e.kind) });
      else if (cat === 'monster') overlay.set(i, { ch: monsterGlyph(catalog, e.kind), name: kindName(catalog, L, e.kind) });
      else overlay.set(i, { ch: '&', name: e.name ?? t(L, '味方', 'ally') });
    }
  }
  if (view.self.pos) overlay.set(view.self.pos.y * f.width + view.self.pos.x, { ch: '@', name: t(L, '自分', 'you') });
  // フロア外の行と列は出さない（負の座標を表示しない）
  const x0 = Math.max(0, region.x), y0 = Math.max(0, region.y);
  const x1 = Math.min(f.width, region.x + region.w), y1 = Math.min(f.height, region.y + region.h);
  region = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  const rows: string[] = [];
  for (let y = region.y; y < region.y + region.h; y++) {
    let row = '';
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = y * f.width + x;
      const ov = overlay.get(i);
      if (ov && view.memory.terrain[i]) {
        row += ov.ch;
        addLegend(ov.ch, ov.name);
        continue;
      }
      const tid = view.terrainTable[view.memory.terrain[i] ?? 0];
      const ch = view.memory.terrain[i] ? terrainGlyph(catalog, tid) : ' ';
      row += ch;
      if (ch !== ' ') addLegend(ch, termName(catalog, L, tid));
    }
    rows.push(row.replace(/\s+$/, ''));
  }
  return { origin: { x: region.x, y: region.y }, rows, legend };
}

export interface ObservationContext {
  grid: NavGrid | null;
  dist: Int32Array | null;
}

export function buildObservation(view: PlayerView, catalog: Catalog, opts: ObservationOptions): Observation {
  const L = view.locale;
  const me = view.self;
  const pos = me.pos;
  const f = view.floor;
  const grid = buildNavGrid(view, catalog);
  const dist = grid && pos ? distanceField(grid, pos, false) : null;
  const pathDist = (p: Pos): number => (dist && f ? dist[p.y * f.width + p.x] : -1);

  const monsters: ObsMonster[] = [];
  const items: ObsItem[] = [];
  const players: ObsPlayer[] = [];
  const features: ObsFeature[] = [];
  const rel = (p: Pos) => ({ dir: pos ? dirTo(pos, p) : null, dist: pos ? cheb(pos, p) : 0 });
  for (const e of view.entities) {
    if (e.cat === 'monster') {
      const m: ObsMonster = {
        id: e.id, name: monsterDisplayName(catalog, L, e), pos: e.pos, ...rel(e.pos),
        hp_state: e.hp ?? 'healthy', awareness: e.awareness ?? 'unaware', threat: threatOf(view, e),
        statuses: (e.statuses ?? []).map((s) => nameOf(catalog.statuses[s]?.name, L, s)),
        shot: e.shot ? 'clear' : 'blocked',
      };
      if (e.role) m.role = e.role;
      if (e.bounty) m.bounty = e.bounty;
      if (e.fleeing) m.fleeing = true;
      if (e.damageSeen) m.damage_seen = e.damageSeen;
      if (e.role !== 'guardian') {
        const est = hpLeftEstimate(e.kind ? view.monsterMemory[e.kind] : undefined, m.hp_state, e.damageSeen ?? 0, catalog.rules?.estimateMinSamples ?? 3);
        if (est) m.hp_left_est = est;
      }
      monsters.push(m);
    } else if (e.cat === 'item') {
      const name = itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes);
      // 同じセルの同種の物は 1 行にまとめる
      const same = items.find((x) => !x.remembered && x.pos.x === e.pos.x && x.pos.y === e.pos.y && x.name === name && x.role === e.role && !!x.mine === !!e.mine);
      if (same) {
        same.qty += e.qty ?? 1;
        same.ids = [...(same.ids ?? [same.id]), e.id];
        continue;
      }
      const it: ObsItem = { id: e.id, name, pos: e.pos, ...rel(e.pos), qty: e.qty ?? 1 };
      if (e.role) it.role = e.role;
      if (e.mine) it.mine = true;
      if (e.value !== undefined) it.value = e.value;
      items.push(it);
    } else if (e.cat === 'player') {
      players.push({ id: e.id, name: e.name ?? '?', pos: e.pos, ...rel(e.pos), hp_state: e.hp ?? 'healthy' });
    } else {
      features.push({ type: e.kind ?? 'feature', name: kindName(catalog, L, e.kind), pos: e.pos, ...rel(e.pos), state: e.state });
    }
  }
  monsters.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  items.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  // 記憶しているアイテム（視界外）
  const visibleIds = new Set(view.entities.map((e) => e.id));
  const rememberedItems: ObsItem[] = [];
  for (const r of view.memory.remembered) {
    if (visibleIds.has(r.id)) continue;
    if (r.cat === 'item') {
      const it: ObsItem = { id: r.id, name: itemDisplayName(catalog, L, r.kind, r.appearanceId), pos: r.pos, ...rel(r.pos), qty: r.qty, remembered: true };
      if (r.role) it.role = r.role;
      if (r.mine) it.mine = true;
      if (r.value !== undefined) it.value = r.value;
      rememberedItems.push(it);
    }
    if (r.cat !== 'item') features.push({ type: r.kind ?? 'feature', name: kindName(catalog, L, r.kind), pos: r.pos, ...rel(r.pos), state: r.state });
  }
  // 記憶の中のアイテムは近い順に 5 件まで（遺物と自分が投げた物は常に出す）。残りは件数だけ
  rememberedItems.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  let itemsOmitted = 0;
  let shown = 0;
  for (const it of rememberedItems) {
    if (it.role || it.mine || it.value !== undefined || shown < 5) {
      const same = items.find((x) => x.remembered && x.pos.x === it.pos.x && x.pos.y === it.pos.y && x.name === it.name && !!x.mine === !!it.mine);
      if (same) { same.qty += it.qty; same.ids = [...(same.ids ?? [same.id]), it.id]; continue; }
      items.push(it);
      if (!it.role && !it.mine && it.value === undefined) shown++;
    } else itemsOmitted++;
  }

  // 足元
  let here = '';
  const passable_dirs: Dir[] = [];
  const known_stairs: Observation['navigation']['known_stairs'] = [];
  let frontiers: Observation['navigation']['frontiers'] = [];
  let onStairs: 'up' | 'down' | null = null;
  if (f && pos && grid) {
    const hereIdx = pos.y * f.width + pos.x;
    const hereT = view.terrainTable[view.memory.terrain[hereIdx]];
    onStairs = catalog.terrain[hereT]?.stairs ?? null;
    const hereItems = view.entities.filter((e) => e.cat === 'item' && e.pos.x === pos.x && e.pos.y === pos.y);
    const hereFeat = view.entities.filter((e) => (e.cat === 'feature' || e.cat === 'trap') && e.pos.x === pos.x && e.pos.y === pos.y);
    here = [termName(catalog, L, hereT),
      ...hereFeat.map((e) => kindName(catalog, L, e.kind)),
      ...hereItems.map((e) => itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes) + ((e.qty ?? 1) > 1 ? ` x${e.qty}` : ''))].join(', ');
    for (const d of DIRS) {
      const nx = pos.x + DIR_VEC[d][0];
      const ny = pos.y + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
      if (grid.passable[ny * f.width + nx]) passable_dirs.push(d);
    }
    for (let i = 0; i < view.memory.terrain.length; i++) {
      const tid = view.terrainTable[view.memory.terrain[i]];
      const st = catalog.terrain[tid]?.stairs;
      if (!st) continue;
      const p = { x: i % f.width, y: Math.trunc(i / f.width) };
      const dd = pathDist(p);
      known_stairs.push({ type: st, pos: p, dist: dd >= 0 ? dd : cheb(pos, p), reachable: dd >= 0, path_len: dd >= 0 ? dd : null });
    }
    known_stairs.sort((a, b) => a.dist - b.dist);
    const fr = findFrontiers(grid)
      .map((i) => ({ pos: { x: i % f.width, y: Math.trunc(i / f.width) }, d: dist ? dist[i] : -1 }))
      .filter((x) => x.d >= 0)
      .sort((a, b) => a.d - b.d || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    // 近接したフロンティアは間引く
    const picked: typeof fr = [];
    for (const c of fr) {
      if (picked.some((p) => cheb(p.pos, c.pos) <= 3)) continue;
      picked.push(c);
      if (picked.length >= 5) break;
    }
    frontiers = picked.map((c) => ({ pos: c.pos, dir: dirTo(pos, c.pos), dist: c.d }));
  }

  // アラート
  const alerts: Alert[] = [];
  const hpPct = me.stats.maxHp > 0 ? Math.trunc((me.stats.hp * 100) / me.stats.maxHp) : 0;
  const hostiles = monsters;
  const adjacent = hostiles.filter((m) => m.dist === 1);
  if (view.status === 'dead') alerts.push({ code: 'dead', text: t(L, 'あなたは死亡している', 'You are dead') });
  if (hpPct < 25) alerts.push({ code: 'critical_hp', text: t(L, `HP が危険域 (${me.stats.hp}/${me.stats.maxHp})`, `HP critical (${me.stats.hp}/${me.stats.maxHp})`) });
  else if (hpPct < 50) alerts.push({ code: 'low_hp', text: t(L, 'HP が半分以下', 'HP below half') });
  if (adjacent.length) {
    alerts.push({
      code: 'enemy_adjacent',
      text: t(L, '敵が隣接: ', 'Adjacent enemy: ') + adjacent.map((m) => `${m.name}(${dirLabel(L, m.dir)})`).join(', '),
      entity: adjacent[0].id,
    });
  }
  const hunting = hostiles.filter((m) => m.awareness === 'hunting');
  if (hunting.length >= 2) alerts.push({ code: 'multiple_enemies', text: t(L, `複数の敵が追跡中 (${hunting.length})`, `${hunting.length} enemies hunting you`) });
  else if (hostiles.length && !adjacent.length) alerts.push({ code: 'enemy_in_view', text: t(L, `敵が視界内: ${hostiles[0].name}`, `Enemy in view: ${hostiles[0].name}`), entity: hostiles[0].id });
  if (me.statuses.some((s) => s.id === 'core:poison')) alerts.push({ code: 'poisoned', text: t(L, '毒に冒されている', 'You are poisoned') });
  if (onStairs) alerts.push({ code: 'on_stairs', text: onStairs === 'down' ? t(L, '下り階段の上にいる', 'You are on stairs down') : t(L, '上り階段の上にいる', 'You are on stairs up') });
  const itemsHere = items.filter((i) => i.dist === 0 && !i.remembered);
  if (itemsHere.length) alerts.push({ code: 'item_here', text: t(L, '足元にアイテム: ', 'Item here: ') + itemsHere.map((i) => i.name).join(', ') });
  if (view.inventory.length >= me.capacity) alerts.push({ code: 'inventory_full', text: t(L, '所持品がいっぱい', 'Inventory full') });
  if ((opts.recent ?? []).some((e) => e.type === 'entity_changed_floor' && (e.event as any).id === me.id)) {
    alerts.push({ code: 'new_floor', text: t(L, '新しい階に到着した', 'Arrived on a new floor') });
  }

  // 自分
  const equipName = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const it = view.inventory.find((i) => i.id === id);
    return it ? itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes) : undefined;
  };
  const invItems: ObsInvItem[] = view.inventory.map((it) => ({
    slot: it.slot, name: itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes), qty: it.qty,
    category: itemCategory(catalog, it.kind, it.appearanceId), identified: it.kind !== null, equipped: it.equipped !== null,
    ...(it.value !== undefined ? { value: it.value } : {}),
  }));
  const invBrief = invItems.map((i) => `${i.slot})${i.name}${i.qty > 1 ? `x${i.qty}` : ''}${i.equipped ? '*' : ''}${i.value !== undefined ? `(${i.value})` : ''}`).join(' ');

  const biomeName = f ? nameOf(catalog.biomes[f.biome]?.name, L, f.biome) : '';
  // 追跡中（逃走中を除く）の敵が見えているか: extract と休息の判定（engine と同じ）
  const huntingVisible = hostiles.some((m) => m.awareness === 'hunting' && !m.fleeing);
  const rest = restEstimate(view, catalog, huntingVisible);

  // 遠征
  let expedition: ObsExpedition | undefined;
  const xv = view.expedition;
  if (xv) {
    const active = xv.status !== 'ended' && view.status !== 'at_camp';
    const blocked: ObsExpedition['extract_blocked_by'] = !active ? 'ended' : view.status !== 'your_turn' ? 'not_your_turn' : !onStairs ? 'not_on_stairs' : huntingVisible ? 'hostile_hunting' : undefined;
    const prog: ObsExpedition['progress'] = { depth: f?.depth ?? null, target_depth: xv.objective.targetDepth };
    if (xv.objective.type === 'reach_depth') prog.reached = xv.progress.reached;
    if (xv.objective.type === 'slay_guardian') prog.guardian_slain = xv.progress.guardianSlain;
    if (xv.objective.type === 'retrieve_relic') prog.relic_held = xv.progress.relicHeldByYou;
    const extractText = blocked === undefined ? t(L, 'extract: 可', 'extract: possible')
      : blocked === 'ended' ? '' : t(L, `extract: 不可(${EXTRACT_BLOCK_JA[blocked]})`, `extract: not now (${blocked})`);
    const statusText = xv.status === 'objective_complete' ? t(L, '目的達成済み', 'objective complete') : xv.status === 'ended' ? t(L, '終了', 'ended') : t(L, '進行中', 'in progress');
    expedition = {
      no: xv.no,
      objective: { type: xv.objective.type, target_depth: xv.objective.targetDepth, text: objectiveText(L, xv.objective) },
      progress: prog, status: xv.status, points: xv.points,
      can_extract: blocked === undefined,
      // engine の wouldComplete と同じ規則（遺物は自分が持っていること）
      extract_outcome: xv.status === 'objective_complete' && (xv.objective.type !== 'retrieve_relic' || xv.progress.relicHeldByYou) ? 'complete' : 'withdraw',
      text: [t(L, `【遠征${xv.no}】${objectiveText(L, xv.objective)}`, `[Expedition ${xv.no}] ${objectiveText(L, xv.objective)}`), statusText, progressText(L, xv, f?.depth ?? null), extractText].filter(Boolean).join(' | '),
    };
    if (blocked !== undefined) expedition.extract_blocked_by = blocked;
    if (xv.result) expedition.result = { ...xv.result, text: resultText(L, xv) };
    if (xv.slot) expedition.slot = xv.slot;
    if (xv.traits.length) expedition.traits = [...xv.traits];
    if (active && catalog.rules?.haul) {
      const treasure = view.inventory.reduce((a, i) => a + (i.value ?? 0), 0);
      const parts: HaulParts = {
        objective: xv.status === 'objective_complete' ? xv.points : 0,
        overreach: overreachPoints(catalog.rules, xv.objective.targetDepth, xv.maxDepth),
        treasure, bounty: xv.haul.bounty, discovery: xv.haul.discovery, kills: xv.haul.kills,
      };
      const total = haulTotal(parts);
      const ifNow = payoutOf(catalog.rules, parts, expedition.extract_outcome === 'complete', xv.multiplierPct);
      const next = nextOverreach(catalog.rules, xv.objective.targetDepth, xv.maxDepth);
      const nextText = next ? t(L, ` / 地下${next.depth}階に着けば +${next.points}`, ` / reach depth ${next.depth} for +${next.points}`) : '';
      const status = xv.status === 'objective_complete' ? t(L, '達成', 'complete') : t(L, '未達成', 'incomplete');
      expedition.haul = {
        total, multiplier_pct: xv.multiplierPct, parts, if_extract_now: ifNow, next_overreach: next,
        text: t(L,
          `遠征${xv.no} [${status}] 戦利品 ${total}（${partsText(L, parts) || 'なし'}）${expedition.extract_outcome === 'complete' ? multText(xv.multiplierPct) : `撤退なら ${catalog.rules.haul.withdrawPct}%（目的を除く）`} → 今帰れば +${ifNow}${nextText} / 確定済み ${view.record.banked}`,
          `Expedition ${xv.no} [${status}] haul ${total} (${partsText(L, parts) || 'none'}) ${expedition.extract_outcome === 'complete' ? multText(xv.multiplierPct) : `withdraw ${catalog.rules.haul.withdrawPct}% without objective`} → extract now +${ifNow}${nextText} / banked ${view.record.banked}`),
      };
    }
  }
  let camp: ObsCamp | undefined;
  if (view.camp) {
    const rules = catalog.rules;
    camp = {
      next_no: view.camp.nextNo,
      offers: view.camp.offers.map((o) => ({
        index: o.index, type: o.objective.type, target_depth: o.objective.targetDepth, points: o.points,
        text: offerText(L, o, rules ? { rules, level: me.level } : undefined),
        ...(o.slot ? { slot: o.slot } : {}), ...(o.traits?.length ? { traits: [...o.traits] } : {}),
        multiplier_pct: o.multiplierPct ?? 100,
        danger: rules && o.objective.targetDepth !== null ? dangerOf(rules, o.objective.targetDepth, o.traits ?? [], me.level) : null,
        recommended_level: rules && o.objective.targetDepth !== null ? recommendedLevel(rules, o.objective.targetDepth) : null,
      })),
    };
  }
  if (view.status === 'at_camp') alerts.unshift({ code: 'at_camp', text: t(L, 'キャンプにいる（盤面にいない）', 'You are at camp (off the board)') });
  if (expedition?.can_extract && expedition.extract_outcome === 'complete') alerts.push({ code: 'can_extract', text: t(L, 'この場で extract すると帰還（達成）になる', 'extract here completes the expedition') });

  // 自分を攻撃している相手（投擲の候補で優先する）
  const attackers = new Set<string>();
  for (const e of opts.recent ?? []) {
    const ev = e.event as Record<string, unknown>;
    if (e.type === 'attack' && ev.target === me.id && typeof ev.attacker === 'string') attackers.add(ev.attacker);
  }
  const mineCount = items.filter((i) => i.mine).reduce((a, i) => a + i.qty, 0);
  const valid_actions = buildValidActions(view, catalog, {
    passable_dirs, onStairs, itemsHere: itemsHere.length > 0, hostiles, frontiers: frontiers.length, known_stairs, grid,
    canExtract: expedition?.can_extract ?? false, objectiveComplete: expedition?.extract_outcome === 'complete', restTurns: rest && !rest.blocked_by ? rest.turns : null,
    attackers, mineCount,
  });

  const statusLabel: Record<ViewStatus, [string, string]> = {
    your_turn: ['あなたの番', 'your turn'], waiting_others: ['他プレイヤー待ち', 'waiting for others'], dead: ['死亡', 'dead'], ended: ['ラン終了', 'run ended'],
    at_camp: ['キャンプ', 'at camp'],
  };
  const summaryParts = [
    f ? t(L, `地下${f.depth}階 ${biomeName}`, `Depth ${f.depth} ${biomeName}`) : '',
    `HP ${me.stats.hp}/${me.stats.maxHp}`,
    `Lv${me.level}`,
    hostiles.length ? t(L, `敵${hostiles.length}体が視界内`, `${hostiles.length} enemies in view`) : t(L, '敵影なし', 'no enemies in view'),
    statusLabel[view.status][L === 'en' ? 1 : 0],
  ].filter(Boolean);

  const obs: Observation = {
    seq: view.seq,
    status: view.status,
    summary: summaryParts.join(' | '),
    alerts,
    self: {
      name: me.name, class: kindName(catalog, L, me.classId), level: me.level, xp: me.xp, xp_next: xpForLevel(me.level),
      hp: me.stats.hp, max_hp: me.stats.maxHp,
      statuses: me.statuses.map((s) => ({ id: s.id, name: nameOf(catalog.statuses[s.id]?.name, L, s.id), turns_left: s.turnsLeft })),
      pos, floor: f ? { depth: f.depth, biome_name: biomeName, floor_type: nameOf(catalog.floorTypes[f.floorType]?.name, L, f.floorType), time: f.time } : null,
      attack: { acc: me.stats.acc, dmg: `${me.stats.dmg}${me.stats.might ? (me.stats.might > 0 ? `+${me.stats.might}` : `${me.stats.might}`) : ''}` },
      defense: { eva: me.stats.eva, armor: me.stats.armor },
      equipment: { weapon: equipName(me.equip.weapon), armor: equipName(me.equip.armor), accessory: equipName(me.equip.accessory) },
      inventory_count: view.inventory.length, inventory_capacity: me.capacity,
      turns: me.turns,
      speed: effectiveSpeed(view, catalog),
      score: { banked: view.record.banked, expeditions_completed: view.record.expeditions },
    },
    visible: { monsters, items, players, features, ...(itemsOmitted ? { items_omitted: itemsOmitted } : {}) },
    navigation: { here, passable_dirs, frontiers, known_stairs },
    recent_events: (opts.recent ?? []).map((e) => e.text).filter((s) => s.length > 0).slice(-10),
    valid_actions,
  };
  if (rest) obs.self.rest_estimate = rest;
  if (expedition) obs.expedition = expedition;
  if (camp) obs.camp = camp;
  if (opts.detail === 'full') obs.self.inventory = invItems;
  else obs.self.inventory_brief = invBrief;
  if (opts.map && f && pos) {
    const w = opts.mapWidth ?? 21;
    const h = opts.mapHeight ?? 15;
    obs.map = renderAsciiMap(view, catalog, { x: pos.x - Math.trunc(w / 2), y: pos.y - Math.trunc(h / 2), w, h });
  }
  return obs;
}

const EXTRACT_BLOCK_JA: Record<string, string> = { not_on_stairs: '階段の上ではない', hostile_hunting: '追跡中の敵が見えている', not_your_turn: '手番ではない', ended: '終了済み' };

interface VAInput {
  passable_dirs: Dir[]; onStairs: 'up' | 'down' | null; itemsHere: boolean; hostiles: ObsMonster[];
  frontiers: number; known_stairs: Observation['navigation']['known_stairs']; grid: NavGrid | null;
  canExtract: boolean; objectiveComplete: boolean; restTurns: number | null;
  /** 自分を攻撃している相手 */
  attackers: Set<string>;
  /** 既知の「自分が投げた物」の数 */
  mineCount: number;
}

function buildValidActions(view: PlayerView, catalog: Catalog, x: VAInput): string[] {
  const L = view.locale;
  const out: string[] = [];
  if (view.status === 'at_camp') {
    if (!view.camp) return ['wait_for_turn'];
    return [
      ...view.camp.offers.map((o) => `start_expedition ${o.index} (${objectiveText(L, o.objective)})`),
      'start_expedition endless', 'retire',
    ];
  }
  if (view.status !== 'your_turn' || !view.self.pos || !view.floor) return view.status === 'dead' || view.status === 'ended' ? [] : ['wait_for_turn'];
  const pos = view.self.pos;
  const f = view.floor;
  const byPos = new Map<number, EntityView>();
  for (const e of view.entities) if (e.cat === 'monster' || e.cat === 'player') byPos.set(e.pos.y * f.width + e.pos.x, e);
  for (const d of DIRS) {
    const nx = pos.x + DIR_VEC[d][0];
    const ny = pos.y + DIR_VEC[d][1];
    if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
    const i = ny * f.width + nx;
    const occ = byPos.get(i);
    if (occ?.cat === 'monster') { out.push(`move ${d} (${t(L, '攻撃', 'attack')}: ${monsterDisplayName(catalog, L, occ)})`); continue; }
    if (occ?.cat === 'player') { out.push(`move ${d} (${t(L, '位置交換', 'swap')}: ${occ.name})`); continue; }
    const tid = view.terrainTable[view.memory.terrain[i]];
    const tr = catalog.terrain[tid];
    if (tr?.door === 'closed') { out.push(`move ${d} (${t(L, '扉を開ける', 'open door')})`); continue; }
    if (x.passable_dirs.includes(d)) out.push(`move ${d}`);
  }
  out.push('wait');
  const hunting = x.hostiles.some((m) => m.awareness === 'hunting' && !m.fleeing);
  if (view.self.stats.hp < view.self.stats.maxHp) {
    out.push(hunting ? `rest (${t(L, '不可: 追跡中の敵が見えている', 'unavailable: a hunting enemy is in view')})` : x.restTurns !== null ? `rest (${t(L, `全快まで約${x.restTurns}手`, `~${x.restTurns} turns to full`)})` : 'rest');
  }
  if (x.canExtract) out.push(x.objectiveComplete ? `extract (${t(L, '帰還: 遠征達成', 'complete the expedition')})` : `extract confirm:true (${t(L, '撤退: 未達成のまま終える', 'withdraw without the reward')})`);
  out.push(x.frontiers > 0 ? 'explore' : `explore (${t(L, '探索済み', 'fully explored')})`);
  if (x.known_stairs.some((s) => s.type === 'down')) out.push('travel_to stairs_down');
  if (x.known_stairs.some((s) => s.type === 'up')) out.push('travel_to stairs_up');
  if (x.onStairs) out.push(`use_stairs (${x.onStairs === 'down' ? t(L, '降りる', 'descend') : t(L, '上る', 'ascend')})`);
  if (x.itemsHere) out.push('pickup');
  if (x.mineCount > 0) out.push(`collect (${t(L, `自分が投げた物 ${x.mineCount} 個を回収`, `pick up ${x.mineCount} thrown items`)})`);
  for (const it of view.inventory) {
    const name = itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes);
    const cat = itemCategory(catalog, it.kind, it.appearanceId);
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    const harmful = !!ci?.harmful;
    if ((cat === 'potion' || cat === 'scroll' || ci?.usable) && !harmful) out.push(`use_item ${it.slot} (${name})`);
    if (ci?.slot && !it.equipped) out.push(`equip ${it.slot} (${name})`);
    // 投擲: 射線が通る相手だけ（自分を攻撃している相手を先に、近い順に最大 3）
    const range = ci?.throwRange ?? null;
    if ((cat === 'throwing' || harmful) && range !== null && !it.equipped) {
      const targets = x.hostiles
        .filter((m) => m.shot === 'clear' && m.dist <= range)
        .sort((a, b) => Number(x.attackers.has(b.id)) - Number(x.attackers.has(a.id)) || a.dist - b.dist || (a.id < b.id ? -1 : 1))
        .slice(0, 3);
      for (const m of targets) out.push(`throw_item ${it.slot} (${name}) -> ${m.id}${x.attackers.has(m.id) ? t(L, '（あなたを攻撃中）', ' (attacking you)') : ''}`);
    }
  }
  // 隣接する扉・地物
  for (const d of [null, ...DIRS] as (Dir | null)[]) {
    const nx = pos.x + (d ? DIR_VEC[d][0] : 0);
    const ny = pos.y + (d ? DIR_VEC[d][1] : 0);
    if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
    const i = ny * f.width + nx;
    const tr = catalog.terrain[view.terrainTable[view.memory.terrain[i]]];
    if (d && tr?.door === 'open' && !byPos.has(i)) out.push(`interact ${d} (${t(L, '扉を閉める', 'close door')})`);
    for (const e of view.entities) {
      if (e.cat !== 'feature' || e.pos.x !== nx || e.pos.y !== ny) continue;
      const fd = e.kind ? catalog.features[e.kind] : undefined;
      if (fd?.interactable && e.state !== 'used') out.push(`interact${d ? ' ' + d : ''} (${kindName(catalog, L, e.kind)})`);
    }
  }
  return out;
}

/** テキスト整形の選択（ゲームには影響しない。プレイヤーごとの set_options） */
export interface TextFormat {
  /** false: 所持品の行を出さない */
  inventory?: boolean;
  /** 'unchanged': 地図の代わりに「地図: 変化なし」の 1 行 */
  map?: 'show' | 'unchanged';
}

export function formatObservationText(obs: Observation, locale: Locale, fmt: TextFormat = {}): string {
  const L = locale;
  const lines: string[] = [];
  const s = obs.self;
  const statusText: Record<ViewStatus, [string, string]> = {
    your_turn: ['あなたの番', 'your turn'], waiting_others: ['他プレイヤー待ち', 'waiting for others'], dead: ['死亡', 'dead'], ended: ['ラン終了', 'run ended'],
    at_camp: ['キャンプ', 'at camp'],
  };
  if (obs.status === 'at_camp') {
    // キャンプ専用の形: 成績と候補だけ
    lines.push(`[seq ${obs.seq} | ${t(L, 'キャンプ', 'Camp')} | HP ${s.hp}/${s.max_hp} | Lv${s.level} | ${statusText.at_camp[L === 'en' ? 1 : 0]}]`);
    if (obs.expedition?.result) lines.push(obs.expedition.result.text);
    lines.push(t(L, `確定済み ${s.score.banked} 点・達成した遠征 ${s.score.expeditions_completed}`, `Banked ${s.score.banked}, expeditions completed ${s.score.expeditions_completed}`));
    if (obs.alerts.length) lines.push('!! ' + obs.alerts.map((a) => a.text).join(' / '));
    if (obs.camp) {
      lines.push(t(L, `次の遠征の候補（遠征 ${obs.camp.next_no}）。start_expedition { offer } で始める:`, `Offers for expedition ${obs.camp.next_no} (start with start_expedition { offer }):`));
      for (const o of obs.camp.offers) lines.push('  ' + o.text);
      lines.push('  ' + t(L, 'endless) 目的なしでひたすら潜る（offer: "endless"）', 'endless) no objective, just descend (offer: "endless")'));
    }
    if (obs.recent_events.length) {
      lines.push(t(L, '直前の出来事:', 'Recent events:'));
      for (const e of obs.recent_events) lines.push(`- ${e}`);
    }
    lines.push(t(L, 'できること: ', 'Actions: ') + obs.valid_actions.join(' / '));
    return lines.join('\n');
  }
  const floorText = s.floor ? t(L, `地下${s.floor.depth}階 ${s.floor.biome_name}`, `Depth ${s.floor.depth} ${s.floor.biome_name}`) : '-';
  const posText = s.pos ? t(L, `位置(${s.pos.x},${s.pos.y})`, `pos(${s.pos.x},${s.pos.y})`) : '';
  lines.push(`[seq ${obs.seq} | ${floorText} | HP ${s.hp}/${s.max_hp} | Lv${s.level} | ${posText ? posText + ' | ' : ''}${statusText[obs.status][L === 'en' ? 1 : 0]}]`);
  if (obs.expedition) lines.push(obs.expedition.text);
  if (obs.expedition?.haul) lines.push(obs.expedition.haul.text);
  if (obs.alerts.length) lines.push('!! ' + obs.alerts.map((a) => a.text).join(' / '));
  const st = s.statuses.length ? s.statuses.map((x) => `${x.name}(${x.turns_left})`).join(' ') : t(L, 'なし', 'none');
  lines.push(t(L,
    `能力: 命中+${s.attack.acc} ダメージ${s.attack.dmg} 回避${s.defense.eva} 装甲${s.defense.armor} 速さ${s.speed} XP ${s.xp}/${s.xp_next} 状態:${st}`,
    `Stats: acc+${s.attack.acc} dmg ${s.attack.dmg} eva ${s.defense.eva} armor ${s.defense.armor} speed ${s.speed} XP ${s.xp}/${s.xp_next} status:${st}`));
  const re = s.rest_estimate;
  const alive = obs.status !== 'dead' && obs.status !== 'ended';
  if (re && alive) {
    const block = re.blocked_by === 'hostile_hunting' ? t(L, '（今は追跡中の敵が見えるので休めない）', ' (blocked: a hunting enemy is in view)')
      : re.blocked_by === 'poisoned' ? t(L, '（毒が抜けるまで休憩は続く）', ' (rest continues until the poison wears off)') : '';
    lines.push(t(L,
      `休憩の見積もり: 全快まで ${re.turns} 手（HP +${re.hp_to_full}、時間 ${re.time}、その間の徘徊の目安 ${re.wander_expected} 体）${block}`,
      `Rest estimate: ${re.turns} turns to full (HP +${re.hp_to_full}, time ${re.time}, wanderers expected ${re.wander_expected})${block}`));
  }
  if (obs.expedition?.result) lines.push(obs.expedition.result.text);
  const vis = obs.visible;
  const nav = obs.navigation;
  const stairsLines = nav.known_stairs.slice(0, 3);
  if (vis.monsters.length || vis.items.length || vis.players.length || vis.features.length || stairsLines.length || vis.items_omitted) {
    lines.push(t(L, '見えるもの:', 'In view:'));
    const from = s.pos ?? { x: 0, y: 0 };
    for (const m of vis.monsters) {
      const role = m.role === 'guardian' ? t(L, ` [守護者・賞金 ${m.bounty ?? 0}]`, ` [guardian, bounty ${m.bounty ?? 0}]`) : m.bounty ? t(L, ` [賞金 ${m.bounty}]`, ` [bounty ${m.bounty}]`) : '';
      const dmg = m.damage_seen ? t(L, `  与ダメ累計:${m.damage_seen}`, ` dmg_seen:${m.damage_seen}`) : '';
      const est = m.hp_left_est ? t(L, `  推定残りHP:${hpEstimateText(L, m.hp_left_est)}`, ` hp_left_est:${hpEstimateText(L, m.hp_left_est)}`) : '';
      const shot = m.shot === 'blocked' ? t(L, '  射線:通らない', ' shot:blocked') : '';
      lines.push(L === 'en'
        ? `- ${m.name}${role} ${m.id} (${m.pos.x},${m.pos.y}) ${relLabel(L, from, m.pos)} hp:${m.hp_state} ${m.awareness}${m.fleeing ? '(fleeing)' : ''} threat:${m.threat}${dmg}${est}${shot}${m.statuses.length ? ' ' + m.statuses.join(',') : ''}`
        : `- ${m.name}${role} ${m.id} (${m.pos.x},${m.pos.y}) ${relLabel(L, from, m.pos)}  負傷:${HP_JA[m.hp_state]}  状態:${AW_JA[m.awareness] ?? m.awareness}${m.fleeing ? '(逃走中)' : ''}  脅威:${m.threat}${dmg}${est}${shot}${m.statuses.length ? '  ' + m.statuses.join(',') : ''}`);
    }
    for (const p of vis.players) lines.push(`- ${t(L, '味方', 'ally')} ${p.name} (${p.pos.x},${p.pos.y}) ${relLabel(L, from, p.pos)} ${L === 'en' ? p.hp_state : HP_JA[p.hp_state]}`);
    for (const it of vis.items) {
      const tags = `${it.role === 'relic' ? t(L, ' [遺物]', ' [relic]') : ''}${it.mine ? t(L, ' [自分が投げた]', ' [yours]') : ''}${it.value !== undefined ? t(L, ` [宝・価値 ${it.value}]`, ` [treasure ${it.value}]`) : ''}`;
      lines.push(`- ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}${tags} ${it.id} (${it.pos.x},${it.pos.y}) ${relLabel(L, from, it.pos)}${it.remembered ? t(L, ' (記憶)', ' (remembered)') : ''}`);
    }
    if (vis.items_omitted) lines.push(`- ${t(L, `ほかに記憶しているアイテム ${vis.items_omitted} 件（get_map の注目点）`, `${vis.items_omitted} more remembered items (see get_map)`)}`);
    for (const ft of vis.features) lines.push(`- ${ft.name} (${ft.pos.x},${ft.pos.y}) ${relLabel(L, from, ft.pos)}${ft.state && ft.state !== 'idle' ? ` [${featureStateText(L, ft.state)}]` : ''}`);
    for (const st2 of stairsLines) {
      const name = st2.type === 'down' ? t(L, '下り階段', 'stairs down') : t(L, '上り階段', 'stairs up');
      lines.push(`- ${name} (${st2.pos.x},${st2.pos.y}) ${t(L, '距離', 'dist')}${st2.dist} ${st2.reachable ? t(L, '到達可', 'reachable') : t(L, '到達不明', 'unknown path')}`);
    }
  }
  if (alive) {
    lines.push(t(L, '足元: ', 'Here: ') + nav.here);
    if (nav.frontiers.length) {
      lines.push(t(L, '未探索: ', 'Unexplored: ') + nav.frontiers.map((fr) => `${dirLabel(L, fr.dir)}(${fr.pos.x},${fr.pos.y}) ${t(L, '距離', 'dist')}${fr.dist}`).join(' / '));
    } else {
      lines.push(t(L, '未探索: なし（このフロアは探索済み）', 'Unexplored: none (floor explored)'));
    }
  }
  if (obs.recent_events.length) {
    lines.push(t(L, '直前の出来事:', 'Recent events:'));
    for (const e of obs.recent_events) lines.push(`- ${e}`);
  }
  // 装備は所持品の * に一本化
  if (fmt.inventory !== false) {
    if (s.inventory) {
      lines.push(t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}、* は装備中):`, `Inventory (${s.inventory_count}/${s.inventory_capacity}, * = equipped):`));
      for (const it of s.inventory) lines.push(`  ${it.slot}) ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}${it.equipped ? '*' : ''}${it.identified ? '' : t(L, ' (未鑑定)', ' (unidentified)')}`);
    } else {
      lines.push(t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}、* は装備中): `, `Inventory (${s.inventory_count}/${s.inventory_capacity}, * = equipped): `) + (s.inventory_brief || '-'));
    }
  }
  if (obs.map) {
    lines.push(t(L, `地図（上の 2 行が x 座標の 10 の位と 1 の位、左が y 座標）:`, `Map (top rows: x tens/ones, left: y):`));
    for (const r of mapTextLines(obs.map)) lines.push(r);
    lines.push(t(L, '凡例: ', 'Legend: ') + Object.entries(obs.map.legend).map(([k, v]) => `${k}=${v}`).join(' ') + t(L, ' (空白)=未知', ' (blank)=unknown'));
  } else if (fmt.map === 'unchanged') {
    lines.push(t(L, '地図: 変化なし（get_map で全体）', 'Map: unchanged (get_map for the whole floor)'));
  }
  lines.push(t(L, 'できること: ', 'Actions: ') + compactActions(obs.valid_actions));
  return lines.join('\n');
}

function compactActions(actions: string[]): string {
  const plainMoves = actions.filter((a) => /^move [a-z]+$/.test(a)).map((a) => a.slice(5));
  const rest = actions.filter((a) => !/^move [a-z]+$/.test(a));
  const parts: string[] = [];
  const special = rest.filter((a) => a.startsWith('move '));
  parts.push(...special);
  if (plainMoves.length) parts.push(`move ${plainMoves.join(',')}`);
  parts.push(...rest.filter((a) => !a.startsWith('move ')));
  return parts.join(' / ');
}

/** 対象の説明（look）。視界内・記憶内の情報だけを使う */
export function describeTarget(view: PlayerView, catalog: Catalog, target: Pos | string): { text: string; data: Record<string, unknown> } {
  const L = view.locale;
  const f = view.floor;
  if (!f) return { text: t(L, 'フロア外', 'Not on a floor'), data: {} };
  let p: Pos | null = null;
  let ent: EntityView | undefined;
  if (typeof target === 'string') {
    ent = view.entities.find((e) => e.id === target);
    if (ent) p = ent.pos;
    else {
      const r = view.memory.remembered.find((x) => x.id === target);
      if (r) return { text: t(L, `${kindName(catalog, L, r.kind, r.appearanceId)}（最後に見た位置 ${r.pos.x},${r.pos.y}）`, `${kindName(catalog, L, r.kind, r.appearanceId)} (last seen at ${r.pos.x},${r.pos.y})`), data: { remembered: r } };
      if (target === view.self.id) p = view.self.pos;
      else return { text: t(L, 'それは見えない。', 'You cannot see that.'), data: { visible: false } };
    }
  } else p = target;
  if (!p || p.x < 0 || p.y < 0 || p.x >= f.width || p.y >= f.height) return { text: t(L, '範囲外', 'Out of bounds'), data: {} };
  const i = p.y * f.width + p.x;
  const known = view.memory.terrain[i] !== 0;
  const visible = view.visibleCells.includes(i);
  const parts: string[] = [];
  const data: Record<string, unknown> = { pos: p, known, visible };
  if (!known) return { text: t(L, 'まだ見たことのない場所だ。', 'An unexplored location.'), data };
  const tid = view.terrainTable[view.memory.terrain[i]];
  parts.push(termName(catalog, L, tid) + (visible ? '' : t(L, '（記憶）', ' (remembered)')));
  data.terrain = tid;
  const here = view.entities.filter((e) => e.pos.x === p!.x && e.pos.y === p!.y);
  const list: unknown[] = [];
  for (const e of here) {
    if (e.cat === 'monster') {
      const mem = e.kind ? view.monsterMemory[e.kind] : undefined;
      const name = monsterDisplayName(catalog, L, e);
      const memText = mem ? memoryCombatText(L, mem) : t(L, '初めて見る相手だ', 'never seen before');
      const hpText = '';
      const sturdy = e.role === 'guardian'
        ? t(L, '・守護者（通常の個体より大幅に頑丈）', ', guardian (far sturdier than a normal one)')
        : (e.affixes?.length || e.tier) ? t(L, '・接辞や深層強化があるので記録より頑丈なことがある', ', affixes/tier may make it sturdier than your records') : '';
      const ds = e.damageSeen ? t(L, `・この個体への与ダメ累計 ${e.damageSeen}`, `, damage you saw it take ${e.damageSeen}`) : '';
      const est = e.role !== 'guardian' ? hpLeftEstimate(mem, e.hp ?? 'healthy', e.damageSeen ?? 0, catalog.rules?.estimateMinSamples ?? 3) : undefined;
      const estText = est ? t(L, `・推定残りHP ${hpEstimateText(L, est)}`, `, estimated HP left ${hpEstimateText(L, est)}`) : '';
      const shotText = e.shot === false ? t(L, '・射線: 通らない', ', shot: blocked') : '';
      parts.push(`${name} [${L === 'en' ? e.hp : HP_JA[e.hp ?? 'healthy']}, ${L === 'en' ? e.awareness : AW_JA[e.awareness ?? 'unaware']}] ${memText}${hpText}${ds}${estText}${shotText}${sturdy}`);
      list.push({ id: e.id, name, hp_state: e.hp, awareness: e.awareness, memory: mem ?? null, threat: threatOf(view, e), role: e.role, damage_seen: e.damageSeen ?? 0, hp_left_est: est ?? null });
    } else if (e.cat === 'item') {
      const name = itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes);
      const desc = e.kind ? nameOf(catalog.items[e.kind]?.desc, L, '') : t(L, '正体不明', 'unidentified');
      parts.push(`${name}${(e.qty ?? 1) > 1 ? ` x${e.qty}` : ''}: ${desc}`);
      list.push({ id: e.id, name, qty: e.qty, desc });
    } else {
      const name = e.cat === 'player' ? (e.name ?? '?') : kindName(catalog, L, e.kind);
      parts.push(name + (e.state && e.state !== 'idle' ? ` [${e.state}]` : ''));
      list.push({ id: e.id, name, state: e.state });
    }
  }
  data.entities = list;
  return { text: parts.join(' / '), data };
}

export function describeInventory(view: PlayerView, catalog: Catalog): { text: string; items: (ObsInvItem & { desc: string; id: string })[] } {
  const L = view.locale;
  const items = view.inventory.map((it: ItemView) => {
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    return {
      id: it.id, slot: it.slot, name: itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes), qty: it.qty,
      category: itemCategory(catalog, it.kind, it.appearanceId), identified: it.kind !== null, equipped: it.equipped !== null,
      desc: ci ? nameOf(ci.desc, L, '') : t(L, '未鑑定。使うか鑑定するまで正体は分からない。', 'Unidentified. Use or identify it to learn what it is.'),
    };
  });
  const text = [
    t(L, `所持品 ${items.length}/${view.self.capacity}`, `Inventory ${items.length}/${view.self.capacity}`),
    ...items.map((i) => `${i.slot}) ${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}${i.equipped ? t(L, ' [装備中]', ' [equipped]') : ''} — ${i.desc}`),
  ].join('\n');
  return { text, items };
}

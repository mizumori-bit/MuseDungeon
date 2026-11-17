// 守護者の型・弱点・名前（V3-3 §3.1・§28.9）。
// 定義はデータ（guardianTypes / guardianWeaknesses / guardianNames）、振る舞いはここのレジストリ（type.handler・weakness.handler）。
// 種族・型・弱点・名前は候補を作る時点で seed|expedition|通番|guardian|枠 から決める（状態を持たない）。
import type { Content } from '@muse/content';
import type { Dir, Entity, GuardianInfo, Intent, Names, Pos } from '@muse/shared';
import { cheb, DIR_VEC, DIRS, floorDiv, Rng } from '@muse/shared';
import type { Ctx } from './ctx';
import { Registry } from './registry';

export interface GuardianTurnInput { target: Entity | null; params: Record<string, number> }

export interface GuardianTypeHandler {
  /** 自分の手番の初め（行動様式の前）。手番を使ったら行動コストを返す。null なら通常の行動様式へ */
  turn?(ctx: Ctx, m: Entity, input: GuardianTurnInput): number | null;
  /** 受けるダメージの修正（攻撃の種類・攻撃者との距離で） */
  incoming?(ctx: Ctx, m: Entity, dmg: number, via: 'melee' | 'thrown' | 'ranged', attacker: Entity | null, params: Record<string, number>): number;
  /** 装甲の上乗せ */
  armor?(ctx: Ctx, m: Entity, params: Record<string, number>): number;
  /** 生成時に眠らない */
  sleepless?: boolean;
}

export interface WeaknessHandler {
  /** 受けるダメージの修正。修正したら弱点を知らせる */
  incoming?(dmg: number, via: 'melee' | 'thrown' | 'ranged', params: Record<string, number>): number;
  /** 継続ダメージ（毒）の倍率 */
  dotMult?(params: Record<string, number>): number;
  /** 気づかれる前の一撃が必ず会心（眠りが深い） */
  critIfUnaware?: boolean;
  /** 生成時に眠っている */
  asleep?: boolean;
  /** 行動コストの倍率（%）。100 で変わらない */
  costPct?(ctx: Ctx, m: Entity, params: Record<string, number>): number;
  /** 棲み処に置く地形（浅い水） */
  lairTerrain?: string;
}

export const guardianTypeHandlers = new Registry<GuardianTypeHandler>('guardianType');
export const weaknessHandlers = new Registry<WeaknessHandler>('guardianWeakness');

// ---------------- 候補を作るとき ----------------

/** 守護者の型・弱点・名前を決める（候補の時点。状態を持たないハッシュ） */
export function rollGuardianInfo(content: Content, seed: string, no: number, slotIndex: number, rank: 1 | 2 | 3, typeCount?: number): GuardianInfo {
  const rng = Rng.fromSeed(`${seed}|expedition|${no}|guardian|${slotIndex}`);
  const ranks = content.balance.guardian.ranks;
  const count = typeCount ?? ranks[Math.min(ranks.length, rank) - 1]?.types ?? 0;
  const ws = content.lists.guardianWeaknesses;
  const name = makeName(content, rng);
  const types = pickTypes(content, count, rng);
  const weakness = ws.length ? ws[rng.int(ws.length)].id : null;
  const title = types.length ? content.guardianTypes[types[0]]?.name : undefined;
  return { name, ...(title ? { title: { ...title } } : {}), types, weakness };
}

/** 近接に強い型・投擲に強い型を半々に引く（2 つなら両方から 1 つずつ。§28.9） */
function pickTypes(content: Content, count: number, rng: Rng): string[] {
  const all = content.lists.guardianTypes;
  const groups: Record<'melee' | 'thrown', string[]> = {
    melee: all.filter((g) => g.strongVs === 'melee').map((g) => g.id),
    thrown: all.filter((g) => g.strongVs === 'thrown').map((g) => g.id),
  };
  const order: ('melee' | 'thrown')[] = rng.chance(50) ? ['melee', 'thrown'] : ['thrown', 'melee'];
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const g = groups[order[k % 2]].filter((id) => !out.includes(id));
    if (g.length) out.push(g[rng.int(g.length)]);
  }
  return out;
}

function makeName(content: Content, rng: Rng): Names {
  const table = Object.keys(content.guardianNames).sort().map((k) => content.guardianNames[k])[0];
  const parts = table?.parts ?? [];
  if (!parts.length) return { ja: '名無し', en: 'Nameless' };
  const n = rng.range(2, 3);
  const picked = Array.from({ length: n }, () => parts[rng.int(parts.length)]);
  const en = picked.map((p) => p.en).join('');
  return { ja: picked.map((p) => p.ja).join(''), en: en.charAt(0).toUpperCase() + en.slice(1) };
}

// ---------------- 戦闘の修正（combat・actions・statuses から呼ぶ） ----------------

function typesOf(ctx: Ctx, m: Entity | null | undefined): { id: string; h: GuardianTypeHandler; params: Record<string, number> }[] {
  if (!m?.guardian) return [];
  return m.guardian.types.flatMap((id) => {
    const def = ctx.content.guardianTypes[id];
    return def ? [{ id, h: guardianTypeHandlers.get(def.handler), params: def.params }] : [];
  });
}

function weaknessOf(ctx: Ctx, m: Entity | null | undefined): { id: string; h: WeaknessHandler; params: Record<string, number> } | null {
  const id = m?.guardian?.weakness;
  const def = id ? ctx.content.guardianWeaknesses[id] : undefined;
  return def && id ? { id, h: weaknessHandlers.get(def.handler), params: def.params } : null;
}

/** 装甲の上乗せ（護られし者の護りの火） */
export function guardianArmor(ctx: Ctx, m: Entity): number {
  return typesOf(ctx, m).reduce((a, t) => a + (t.h.armor?.(ctx, m, t.params) ?? 0), 0);
}

/** 実効の装甲（ダメージの計算で使う） */
export function armorOf(ctx: Ctx, e: Entity): number {
  return (e.stats?.armor ?? 0) + (e.guardian ? guardianArmor(ctx, e) : 0);
}

/** 受けるダメージの修正（弾く者・投擲に弱い）。弱点が効いたら見ている者に知らせる */
export function guardianIncoming(ctx: Ctx, m: Entity, dmg: number, via: 'melee' | 'thrown' | 'ranged', attacker: Entity | null): number {
  if (!m.guardian) return dmg;
  let d = dmg;
  for (const t of typesOf(ctx, m)) if (t.h.incoming) d = t.h.incoming(ctx, m, d, via, attacker, t.params);
  const w = weaknessOf(ctx, m);
  if (w?.h.incoming) {
    const after = w.h.incoming(d, via, w.params);
    if (after !== d) revealWeakness(ctx, m);
    d = after;
  }
  return Math.max(1, d);
}

/** 継続ダメージの倍率（毒に弱い）。効いたら知らせる */
export function guardianDotMult(ctx: Ctx, m: Entity, statusId: string): number {
  if (statusId !== 'core:poison') return 1;
  const w = weaknessOf(ctx, m);
  const mult = w?.h.dotMult?.(w.params) ?? 1;
  if (mult !== 1) revealWeakness(ctx, m);
  return mult;
}

/** 気づかれる前の一撃が必ず会心（眠りが深い）。会心になるなら知らせる */
export function guardianCritIfUnaware(ctx: Ctx, m: Entity): boolean {
  const w = weaknessOf(ctx, m);
  if (!w?.h.critIfUnaware) return false;
  revealWeakness(ctx, m);
  return true;
}

/** 行動コストの倍率（水場で遅い）。効いたら知らせる */
export function guardianCostPct(ctx: Ctx, m: Entity): number {
  const w = weaknessOf(ctx, m);
  const pct = w?.h.costPct?.(ctx, m, w.params) ?? 100;
  if (pct !== 100) revealWeakness(ctx, m);
  return pct;
}

/** 生成時に眠っているか（眠りが深い: 眠る。潜む者: 眠らない） */
export function guardianAsleep(content: Content, info: GuardianInfo, fallback: boolean): boolean {
  if (info.types.some((id) => { const d = content.guardianTypes[id]; return !!d && guardianTypeHandlers.get(d.handler).sleepless; })) return false;
  const w = info.weakness ? content.guardianWeaknesses[info.weakness] : undefined;
  if (w && weaknessHandlers.get(w.handler).asleep) return true;
  return fallback;
}

/** 弱点を知る（その守護者が見えている者のうち、まだ知らない者に） */
export function revealWeakness(ctx: Ctx, m: Entity): void {
  const w = m.guardian?.weakness;
  if (!w || !m.pos) return;
  const f = ctx.world.floors[m.pos.floor];
  if (!f) return;
  const cell = m.pos.y * f.width + m.pos.x;
  for (const pr of ctx.playersOn(m.pos.floor)) {
    if (pr.knowledge.guardianIntel?.[m.id]) continue;
    if (!ctx.visibleSet(pr.id).has(cell)) continue;
    ctx.emit({ type: 'guardian_intel', player: pr.id, guardian: m.id, guardianName: { ...m.guardian!.name }, weakness: w, seenBy: [pr.id], floor: m.pos.floor });
  }
}

// ---------------- 手番（ai.ts の monsterTurn から） ----------------

/** 型の手番（予備動作・突進・手下・怒り・潜む）。手番を使ったら行動コスト */
export function guardianTurn(ctx: Ctx, m: Entity, target: Entity | null): number | null {
  for (const t of typesOf(ctx, m)) {
    const cur = ctx.world.entities[m.id];
    if (!cur?.pos) return null;
    const cost = t.h.turn?.(ctx, cur, { target, params: t.params });
    if (cost !== null && cost !== undefined) return cost;
  }
  return null;
}

/** 予備動作を付ける・外す（AiState の after 値。見えていれば観測に出る） */
export function setIntent(ctx: Ctx, m: Entity, intent: Intent | null): void {
  const cur = ctx.world.entities[m.id];
  const ai = cur?.actor?.ai;
  if (!ai) return;
  const next = { ...ai, targetPos: ai.targetPos ? { ...ai.targetPos } : null };
  if (intent) next.intent = { ...intent }; else delete next.intent;
  ctx.emit({ type: 'ai_state_changed', id: m.id, ai: next, dormant: false, nextActAt: cur.actor!.nextActAt, seenBy: [], floor: cur.pos?.floor ?? null });
}

/** 守護者の状態を書き換える（after 値） */
export function setGuardian(ctx: Ctx, m: Entity, fn: (e: Entity) => void): void {
  const cur = ctx.world.entities[m.id];
  if (!cur) return;
  const e = structuredClone(cur);
  fn(e);
  ctx.emit({ type: 'guardian_state', id: m.id, put: [e], seenBy: [], floor: e.pos?.floor ?? null });
}

/** 向き（縦・横・斜めの直線上にあるとき） */
export function lineDir(from: Pos, to: Pos): Dir | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (!dx && !dy) return null;
  if (dx && dy && Math.abs(dx) !== Math.abs(dy)) return null;
  const sx = Math.sign(dx), sy = Math.sign(dy);
  return DIRS.find((d) => DIR_VEC[d][0] === sx && DIR_VEC[d][1] === sy) ?? null;
}

/** プレイヤーがそのマスを見ているか */
export function playerSees(ctx: Ctx, player: Entity, pos: Pos): boolean {
  if (!player.player || !player.pos) return false;
  const f = ctx.world.floors[player.pos.floor];
  return !!f && ctx.visibleSet(player.player).has(pos.y * f.width + pos.x);
}

/** 棲み処（生成時）: 型と弱点の読み合いが成立する地物・地形の置き場所。中心のまわりの開けたマスから選ぶ */
export function lairPlan(content: Content, info: GuardianInfo): { features: { kind: string; count: number }[]; terrain: { id: string; count: number }[] } {
  const features: { kind: string; count: number }[] = [];
  const terrain: { id: string; count: number }[] = [];
  for (const id of info.types) {
    const d = content.guardianTypes[id];
    if (!d) continue;
    if (d.handler === 'warded') features.push({ kind: 'core:ward_fire', count: d.params.fires ?? 2 });
    if (d.handler === 'charger') terrain.push({ id: 'core:pillar', count: 3 });
  }
  const w = info.weakness ? content.guardianWeaknesses[info.weakness] : undefined;
  const lt = w ? weaknessHandlers.get(w.handler).lairTerrain : undefined;
  if (lt) terrain.push({ id: lt, count: 6 });
  return { features, terrain };
}

export { floorDiv, cheb };

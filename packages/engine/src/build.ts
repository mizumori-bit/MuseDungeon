// ビルド（IMPROVEMENTS_V3 §4・V3-4）: 特技・能動技・習熟・武器の特性・装備の修正・呪い。
// 定義はデータ（perks / abilities / weaponTraits / affixes / items）、振る舞いはここのレジストリ。
import type { AbilityDef } from '@muse/content';
import type { ActionError, Entity, EquipSlot, PlayerBuild, PlayerRecord, Pos } from '@muse/shared';
import { actionError, cheb, DIR_VEC, DIRS, EQUIP_SLOTS, Rng, t } from '@muse/shared';
import type { Ctx } from './ctx';
import { Registry } from './registry';
import { recomputeStats } from './stats';

// ---------------- 状態 ----------------

export function buildOf(e: Entity): PlayerBuild {
  return e.build ?? { perks: [], pending: [], abilities: [] };
}

export function perkRanks(e: Entity, id: string): number {
  return (e.build?.perks ?? []).filter((p) => p === id).length;
}

/** その hook を持つ特技の ID（持っていなければ null） */
export function perkWithHook(ctx: Ctx, e: Entity | null | undefined, hook: string): string | null {
  if (!e?.build) return null;
  for (const id of e.build.perks) if ((ctx.content.perks[id]?.hooks ?? []).some((h) => h.hook === hook)) return id;
  return null;
}

export type PerkEffect = 'not_woken' | 'crit' | 'picked' | 'braced' | 'might' | 'poison_halved' | 'cowed';

/**
 * 条件付きの特技が効いた（V3-4b §28.6）。本人にだけ知らせる。相手が見えていなければ種族を伏せる
 */
export function notePerk(ctx: Ctx, actor: Entity, perk: string | null, effect: PerkEffect, o: { subject?: Entity | null; amount?: number } = {}): void {
  if (!perk || !actor.player) return;
  const pr = ctx.world.players[actor.player];
  if (!pr) return;
  const sub = o.subject ?? null;
  const f = sub?.pos ? ctx.world.floors[sub.pos.floor] : undefined;
  const seen = !!sub?.pos && !!f && sub.pos.floor === actor.pos?.floor && ctx.visibleSet(pr.id).has(sub.pos.y * f.width + sub.pos.x);
  ctx.emit({
    type: 'perk_triggered', actor: actor.id, perk, effect, subject: sub?.id ?? null, subjectKind: seen ? sub!.kind : null,
    ...(o.amount !== undefined ? { amount: o.amount } : {}), seenBy: [pr.id], floor: actor.pos?.floor ?? null,
  });
}

/** その特技の hook の引数（持っていなければ null。同じ hook は最初の 1 つ） */
export function perkHook(ctx: Ctx, e: Entity | null | undefined, hook: string): Record<string, number> | null {
  if (!e?.build) return null;
  for (const id of e.build.perks) {
    for (const h of ctx.content.perks[id]?.hooks ?? []) if (h.hook === hook) return h as unknown as Record<string, number>;
  }
  return null;
}

/** 自分の音で眠りが必ず覚める装備（静寂の指輪）の種類 */
export function noiseRingOf(ctx: Ctx, e: Entity): string | null {
  for (const slot of EQUIP_SLOTS) {
    const id = e.equip?.[slot];
    const it = id ? ctx.world.entities[id] : undefined;
    if (it && ctx.content.items[it.kind]?.equip?.noiseWakes) return it.kind;
  }
  return null;
}

/** 起こしにくさを上げる特技（忍び足）の ID */
export function firstStealthPerk(ctx: Ctx, e: Entity): string | null {
  return (e.build?.perks ?? []).find((id) => (ctx.content.perks[id]?.mods.stealthPct ?? 0) > 0) ?? null;
}

/** 特技の起こしにくさの合計（忍び足） */
export function perkStealth(ctx: Ctx, e: Entity): number {
  let s = 0;
  for (const id of e.build?.perks ?? []) s += ctx.content.perks[id]?.mods.stealthPct ?? 0;
  return s;
}

// ---------------- 装備の修正・習熟 ----------------

export interface Gear {
  meleeAcc: number; thrownAcc: number; stealthPct: number; wakePct: number; moveCost: number; noiseWakes: boolean;
  /** 装備中の武器の特性（ID） */
  traits: string[];
}

export function gearOf(ctx: Ctx, e: Entity): Gear {
  const g: Gear = { meleeAcc: 0, thrownAcc: 0, stealthPct: 0, wakePct: 0, moveCost: 100, noiseWakes: false, traits: [] };
  for (const slot of EQUIP_SLOTS) {
    const id = e.equip?.[slot];
    const it = id ? ctx.world.entities[id] : undefined;
    const def = it ? ctx.content.items[it.kind]?.equip : undefined;
    if (!def) continue;
    g.meleeAcc += def.meleeAcc ?? 0;
    g.thrownAcc += def.thrownAcc ?? 0;
    g.stealthPct += def.stealthPct ?? 0;
    g.wakePct += def.wakePct ?? 0;
    g.moveCost = Math.max(g.moveCost, def.moveCost ?? 100);
    if (def.noiseWakes) g.noiseWakes = true;
    if (slot === 'weapon') g.traits.push(...(def.traits ?? []));
  }
  return g;
}

/** 習熟（職業）＋装備の、近接・投擲の命中の修正（V3-4 §4.3） */
export function meleeAccOf(ctx: Ctx, e: Entity): number {
  if (!e.player) return 0;
  const cls = ctx.content.classes[ctx.world.players[e.player]?.classId ?? ''];
  return (cls?.proficiency.melee ?? 0) + gearOf(ctx, e).meleeAcc;
}

export function thrownAccOf(ctx: Ctx, e: Entity): number {
  if (!e.player) return 0;
  const cls = ctx.content.classes[ctx.world.players[e.player]?.classId ?? ''];
  return (cls?.proficiency.thrown ?? 0) + gearOf(ctx, e).thrownAcc;
}

/** プレイヤーの起こしにくさ（職業＋特技＋装備。0〜100） */
export function stealthOf(ctx: Ctx, pr: PlayerRecord): number {
  const e = ctx.world.entities[pr.entityId];
  const base = ctx.content.classes[pr.classId]?.stealthPct ?? 0;
  return Math.max(0, Math.min(100, base + (e ? perkStealth(ctx, e) + gearOf(ctx, e).stealthPct : 0)));
}

// ---------------- 武器の特性（レジストリ） ----------------

export interface WeaponTraitHandler {
  /** 近接攻撃の手番コスト */
  attackCost?: (p: Record<string, number>) => number;
  /** 近接の届く距離 */
  reach?: (p: Record<string, number>) => number;
  /** 対象と自分の両方に隣接する敵 1 体にも当たる */
  sweep?: boolean;
  /** 当たったとき（対象が生きていれば） */
  onHit?: (ctx: Ctx, attacker: Entity, target: Entity, p: Record<string, number>) => void;
}

export const weaponTraits = new Registry<WeaponTraitHandler>('weaponTrait');

function traitDefs(ctx: Ctx, e: Entity): { h: WeaponTraitHandler; p: Record<string, number> }[] {
  if (!e.player) return [];
  return gearOf(ctx, e).traits.map((id) => ctx.content.weaponTraits[id]).filter((d) => !!d).map((d) => ({ h: weaponTraits.get(d.handler), p: d.params }));
}

export function attackCostOf(ctx: Ctx, e: Entity): number {
  let c = 100;
  for (const { h, p } of traitDefs(ctx, e)) if (h.attackCost) c = Math.min(c, h.attackCost(p));
  return c;
}

export function reachOf(ctx: Ctx, e: Entity): number {
  let r = 1;
  for (const { h, p } of traitDefs(ctx, e)) if (h.reach) r = Math.max(r, h.reach(p));
  return r;
}

export function sweeps(ctx: Ctx, e: Entity): boolean {
  return traitDefs(ctx, e).some(({ h }) => !!h.sweep);
}

export function weaponOnHit(ctx: Ctx, attacker: Entity, target: Entity): void {
  for (const { h, p } of traitDefs(ctx, attacker)) {
    const cur = ctx.world.entities[target.id];
    if (!cur || (cur.stats?.hp ?? 0) <= 0) return;
    h.onHit?.(ctx, attacker, cur, p);
  }
}

/** 直線で 2 マス先（長柄）: 縦・横・斜めの直線上で、間のマスが通れて誰もいない */
export function reachLine(ctx: Ctx, from: Pos & { floor: string }, to: Pos): Pos | null {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (cheb(from, to) !== 2 || (dx !== 0 && Math.abs(dx) !== 2) || (dy !== 0 && Math.abs(dy) !== 2)) return null;
  const mid = { x: from.x + Math.sign(dx), y: from.y + Math.sign(dy) };
  const tr = ctx.terrainAt(from.floor, mid.x, mid.y);
  if (!tr.passable || tr.door === 'closed' || ctx.actorAt(from.floor, mid.x, mid.y)) return null;
  return mid;
}

// ---------------- 特技の候補と選択 ----------------

/** 候補を引く（状態を持たないハッシュ: seed|perk|プレイヤー|レベル。V3-4 §4.1）。取得済み（段階の上限）と前提を満たさないものは除く */
export function rollPerkOptions(ctx: Ctx, pr: PlayerRecord, level: number, owned: readonly string[]): string[] {
  const cls = ctx.content.classes[pr.classId];
  const lineages = new Set(['common', ...(cls?.lineages ?? []).map((l) => l.id)]);
  const count = (id: string) => owned.filter((x) => x === id).length;
  const cands = ctx.content.lists.perks
    .filter((pk) => lineages.has(pk.lineage) && count(pk.id) < pk.maxRanks && pk.requires.every((r) => owned.includes(r)))
    .map((pk) => pk.id);
  const rng = Rng.fromSeed(`${ctx.world.secret.seed}|perk|${pr.id}|${level}`);
  return rng.shuffle(cands).slice(0, ctx.content.balance.perks.options);
}

/** レベルアップ: 特技の候補を足す（前の候補を選んでいなければ、引くのは選んだ後） */
export function offerPerk(ctx: Ctx, e: Entity, level: number): void {
  const cur = ctx.world.entities[e.id];
  if (!cur?.player) return;
  const pr = ctx.world.players[cur.player];
  const b = buildOf(cur);
  const options = b.pending.length ? [] : rollPerkOptions(ctx, pr, level, b.perks);
  if (!b.pending.length && !options.length) return;
  const body = structuredClone(cur);
  body.build = { perks: [...b.perks], abilities: b.abilities.map((a) => ({ ...a })), pending: [...b.pending.map((o) => ({ ...o, options: [...o.options] })), { level, options }] };
  ctx.emit({ type: 'perk_offered', target: cur.id, level, options, put: [body], seenBy: [pr.id], floor: cur.pos?.floor ?? null });
}

/** 特技を取ったときの基本値・所持枠・能動技の変化を body に入れる */
function applyPerk(ctx: Ctx, body: Entity, id: string): string | null {
  const def = ctx.content.perks[id];
  const b = body.build!;
  b.perks.push(id);
  const m = def.mods;
  if (body.base) {
    body.base.maxHp += m.maxHp ?? 0;
    body.base.acc += m.acc ?? 0;
    body.base.eva += m.eva ?? 0;
    body.base.might += m.might ?? 0;
    body.base.armor += m.armor ?? 0;
  }
  if (body.stats && (m.maxHp ?? 0) > 0) body.stats.hp += m.maxHp;
  if (body.inv && m.capacity) body.inv.capacity = Math.min(26, body.inv.capacity + m.capacity);
  if (def.ability && !b.abilities.some((a) => a.id === def.ability)) {
    b.abilities.push({ id: def.ability, readyAt: 0 });
    return def.ability;
  }
  return null;
}

/** 参加時: 職業の Lv1 の特技（能動技を含む） */
export function initialBuild(ctx: Ctx, body: Entity, classId: string): void {
  body.build = { perks: [], pending: [], abilities: [] };
  for (const id of ctx.content.classes[classId]?.startPerks ?? []) applyPerk(ctx, body, id);
}

/** choose_perk（手番を消費しない。進行は止めない） */
export function choosePerk(ctx: Ctx, pr: PlayerRecord, option: number | string): ActionError | null {
  const L = pr.locale;
  if (pr.state !== 'alive' && pr.state !== 'at_camp') return actionError('dead', t(L, '既にランから外れている。', 'You are no longer in the run.'), '');
  const me = ctx.world.entities[pr.entityId];
  const b = buildOf(me);
  const offer = b.pending[0];
  if (!offer || !offer.options.length) return actionError('nothing_to_do', t(L, '選べる特技の候補は無い。', 'There is no perk to choose.'), t(L, 'レベルが上がると候補が出る（alerts の perk_pending）。', 'Leveling up offers perks (alerts: perk_pending).'));
  let id: string | undefined;
  if (typeof option === 'number') id = offer.options[option - 1];
  else id = offer.options.find((o) => o === option || o.split(':')[1] === option || o.replace(/^[^:]+:perk_/, '') === option);
  if (!id) {
    return actionError('bad_request', t(L, `候補に無い: ${option}`, `Not one of the options: ${option}`),
      t(L, `1〜${offer.options.length} の番号か、候補の ID（${offer.options.join(', ')}）を渡す。`, `Pass 1-${offer.options.length} or one of: ${offer.options.join(', ')}.`));
  }
  const body = structuredClone(me);
  body.build = { perks: [...b.perks], abilities: b.abilities.map((a) => ({ ...a })), pending: b.pending.slice(1).map((o) => ({ ...o, options: [...o.options] })) };
  const ability = applyPerk(ctx, body, id);
  // 次の候補（前の候補を選ぶまで引いていなかったもの）を、取った特技を除いて引く。引けなければ捨てる
  const nb = body.build;
  while (nb.pending.length && !nb.pending[0].options.length) {
    const opts = rollPerkOptions(ctx, pr, nb.pending[0].level, nb.perks);
    if (opts.length) { nb.pending[0].options = opts; break; }
    nb.pending.shift();
  }
  const fk = me.pos?.floor ?? null;
  ctx.emit({ type: 'perk_chosen', target: me.id, perk: id, level: offer.level, ability, put: [body], seenBy: [pr.id], floor: fk });
  if (nb.pending[0]?.options.length && nb.pending[0].level !== offer.level) {
    ctx.emit({ type: 'perk_offered', target: me.id, level: nb.pending[0].level, options: [...nb.pending[0].options], seenBy: [pr.id], floor: fk });
  }
  recomputeStats(ctx, ctx.world.entities[me.id], 'perk');
  return null;
}

// ---------------- 能動技 ----------------

export interface AbilityPrep { target: Entity | null; run: () => void }
export type AbilityHandler = (ctx: Ctx, e: Entity, pr: PlayerRecord, def: AbilityDef, cmd: { target?: unknown; slot?: string }) => { error: ActionError } | AbilityPrep;

export const abilityHandlers = new Registry<AbilityHandler>('ability');

/** ID の解決（'bash' でも 'core:bash' でもよい） */
export function resolveAbilityId(ctx: Ctx, e: Entity, id: string): string | null {
  const known = buildOf(e).abilities.map((a) => a.id);
  return known.find((k) => k === id || k.split(':')[1] === id) ?? null;
}

/** 残りの手番（0 なら使える）と、遠征ごとの回数の残り */
export function abilityState(ctx: Ctx, e: Entity, id: string): { cooldownLeft: number; usesLeft: number | null } {
  const st = buildOf(e).abilities.find((a) => a.id === id);
  const def = ctx.content.abilities[id];
  const turns = e.actor?.turns ?? 0;
  const left = Math.max(0, (st?.readyAt ?? 0) - turns);
  if (!def?.perExpedition) return { cooldownLeft: left, usesLeft: null };
  const no = currentExpeditionNo(ctx);
  const used = st && st.usedNo === no ? st.uses ?? 0 : 0;
  return { cooldownLeft: left, usesLeft: Math.max(0, def.perExpedition - used) };
}

function currentExpeditionNo(ctx: Ctx): number {
  const list = ctx.world.expeditions ?? [];
  return list.length ? list[list.length - 1].no : 0;
}

/** 使った後の状態（readyAt = 今の手番数 + 1 + cooldown） */
export function markAbilityUsed(ctx: Ctx, e: Entity, id: string): Entity {
  const body = structuredClone(ctx.world.entities[e.id]);
  const b = buildOf(body);
  const def = ctx.content.abilities[id];
  const no = currentExpeditionNo(ctx);
  body.build = {
    perks: [...b.perks], pending: b.pending.map((o) => ({ ...o, options: [...o.options] })),
    abilities: b.abilities.map((a) => a.id !== id ? { ...a } : {
      ...a, readyAt: (body.actor?.turns ?? 0) + 1 + (def?.cooldown ?? 0),
      ...(def?.perExpedition ? { usedNo: no, uses: (a.usedNo === no ? a.uses ?? 0 : 0) + 1 } : {}),
    }),
  };
  return body;
}

/** 隣の敵（ID・方向・省略時は隣にいる唯一の敵） */
export function adjacentFoe(ctx: Ctx, e: Entity, pr: PlayerRecord, target: unknown): Entity | ActionError {
  const L = pr.locale;
  const key = e.pos!.floor;
  const foes = DIRS.map((d) => ctx.actorAt(key, e.pos!.x + DIR_VEC[d][0], e.pos!.y + DIR_VEC[d][1])).filter((m): m is Entity => !!m && !m.player && !!m.actor);
  if (typeof target === 'string' && target in DIR_VEC) {
    const v = DIR_VEC[target as keyof typeof DIR_VEC];
    const m = ctx.actorAt(key, e.pos!.x + v[0], e.pos!.y + v[1]);
    if (m && !m.player && m.actor) return m;
  } else if (typeof target === 'string') {
    const m = foes.find((f) => f.id === target);
    if (m) return m;
  } else if (target === undefined && foes.length === 1) return foes[0];
  return actionError('no_target', t(L, '隣にその敵はいない。', 'No such enemy next to you.'), t(L, '隣にいる敵の ID（visible.monsters の dist 1）か方向を target に渡す。', 'Pass the id (visible.monsters with dist 1) or direction of an adjacent enemy as target.'));
}

/** 能動技を使える状態か（覚えている・再使用までの手番・遠征ごとの回数） */
export function abilityReadyError(ctx: Ctx, e: Entity, pr: PlayerRecord, id: string): ActionError | null {
  const L = pr.locale;
  const def = ctx.content.abilities[id];
  const s = abilityState(ctx, e, id);
  if (s.cooldownLeft > 0) return actionError('cannot_use', t(L, `${def.name.ja}はあと ${s.cooldownLeft} 手番使えない。`, `${def.name.en} is ready in ${s.cooldownLeft} turns.`), t(L, 'self.abilities の cooldown_left が 0 になるまで待つ。', 'Wait until self.abilities shows cooldown_left 0.'));
  if (s.usesLeft === 0) return actionError('cannot_use', t(L, `${def.name.ja}はこの遠征ではもう使えない。`, `${def.name.en} has been used up this expedition.`), t(L, '次の遠征で再び使える。', 'It is available again next expedition.'));
  return null;
}

/** 呪われた装備（見えている呪い）か */
export function isCursed(ctx: Ctx, it: Entity | undefined): boolean {
  return !!it?.item && it.item.affixes.some((a) => ctx.content.affixes[a]?.cursed);
}

/** 装備中の品の中で外せないもの（呪い）のスロット */
export function cursedSlot(ctx: Ctx, e: Entity, slot: EquipSlot): boolean {
  const id = e.equip?.[slot];
  return !!id && isCursed(ctx, ctx.world.entities[id]);
}

/** 呪いの有無を確かめる（装備・鑑定）。hidden を affixes へ移す。何も無ければ inspected にするだけ */
export function inspectItem(ctx: Ctx, holder: Entity, it: Entity, via: 'equip' | 'identify'): void {
  const cur = ctx.world.entities[it.id];
  if (!cur?.item || !ctx.content.items[cur.kind]?.equip) return;
  const hidden = cur.item.hidden ?? [];
  if (cur.item.inspected && !hidden.length) return;
  const body = structuredClone(cur);
  body.item!.affixes = [...body.item!.affixes, ...hidden];
  delete body.item!.hidden;
  body.item!.inspected = true;
  const app = ctx.world.secret.appearances[cur.kind] ?? null;
  const pid = holder.player;
  const seen = holder.pos ? ctx.perceive(holder.pos.floor, [{ field: 'actor', pos: holder.pos, entity: holder.id }], pid ? [pid] : []) : { seenBy: pid ? [pid] : [] };
  if (hidden.length) ctx.emit({ type: 'curse_revealed', actor: holder.id, item: cur.id, kind: cur.kind, appearanceId: app, affixes: [...hidden], via, put: [body], ...seen, floor: holder.pos?.floor ?? null });
  else ctx.emit({ type: 'item_inspected', actor: holder.id, item: cur.id, kind: cur.kind, appearanceId: app, via, put: [body], seenBy: pid ? [pid] : [], floor: holder.pos?.floor ?? null });
}

/** 呪いを解く（所持品すべて。見えていない呪いも消える） */
export function liftCurses(ctx: Ctx, holder: Entity): void {
  const pid = holder.player;
  for (const id of holder.inv?.items ?? []) {
    const it = ctx.world.entities[id];
    if (!it?.item) continue;
    const cursed = [...it.item.affixes, ...(it.item.hidden ?? [])].filter((a) => ctx.content.affixes[a]?.cursed);
    if (!cursed.length) continue;
    const body = structuredClone(it);
    body.item!.affixes = body.item!.affixes.filter((a) => !ctx.content.affixes[a]?.cursed);
    delete body.item!.hidden;
    body.item!.inspected = true;
    ctx.emit({ type: 'curse_lifted', actor: holder.id, item: it.id, kind: it.kind, appearanceId: ctx.world.secret.appearances[it.kind] ?? null, affixes: cursed, put: [body], seenBy: pid ? [pid] : [], floor: holder.pos?.floor ?? null });
  }
  recomputeStats(ctx, ctx.world.entities[holder.id], 'uncurse');
}

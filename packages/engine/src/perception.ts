// 知覚: プレイヤーの視界と知識（knowledge_updated）、モンスターの視認、騒音、起床、モンスターの思い出。
import type { Entity, FloorHint, FloorKey, MonsterMemory, PlayerId, PlayerRecord, Pos, RememberedEntity, Sense } from '@muse/shared';
import { cheb, compassDir, currentExpedition, inCover, indicesToRanges, memoryKey } from '@muse/shared';
import type { Ctx } from './ctx';
import { computeFov, hasLos, inCircle, line } from './geom';
import { firstStealthPerk, gearOf, noiseRingOf, notePerk, perkStealth, stealthOf } from './build';
import { boonHook } from './boons';
import { deepSleepStealth, restGuardian } from './guardians';
import { applyDamage } from './combat';
import { roll } from './registry';

/**
 * 投げ物・射撃の経路（始点を含まず終点を含む）。from→to の直線か、to→from の直線を逆にたどったもののうち、
 * 途中（終点を除く）が通行可能で他のアクターがいない方。どちらも通らなければ null。
 * 投擲と敵の射撃で同じものを使う（向きで射線が変わらない。V3-2R2 の評価の指摘）
 */
export function shotLine(ctx: Ctx, key: FloorKey, from: Pos, to: Pos): Pos[] | null {
  const ok = (path: Pos[]) => {
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      // 格子扉は投げた物を通す（V3-5 §5.2）
      const tr = ctx.terrainAt(key, p.x, p.y);
      if (!tr.passable && !tr.tags.includes('grate')) return false;
      if (i < path.length - 1 && ctx.actorAt(key, p.x, p.y)) return false;
    }
    return true;
  };
  const fwd = line(from, to);
  if (ok(fwd)) return fwd;
  // to→from の直線（from を含み to を含まない）を逆にして、from を除き to を足す
  const back = line(to, from).reverse().slice(1).concat([{ x: to.x, y: to.y }]);
  return ok(back) ? back : null;
}

/** 投擲の経路が通るか（shotLine の有無） */
export function shotClear(ctx: Ctx, key: FloorKey, from: Pos, to: Pos): boolean {
  return shotLine(ctx, key, from, to) !== null;
}

export function isOpaqueFn(ctx: Ctx, key: FloorKey): (x: number, y: number) => boolean {
  const f = ctx.world.floors[key];
  const table = ctx.world.meta.terrainTable;
  const cache = new Map<number, boolean>();
  return (x, y) => {
    if (x < 0 || y < 0 || x >= f.width || y >= f.height) return true;
    const t = f.terrain[y * f.width + x];
    let o = cache.get(t);
    if (o === undefined) {
      o = ctx.content.terrain[ctx.content.terrainIndex[table[t]]]?.opaque ?? true;
      cache.set(t, o);
    }
    return o;
  };
}

export function playerFov(ctx: Ctx, pr: PlayerRecord): number[] {
  const e = ctx.world.entities[pr.entityId];
  if (!e?.pos) return [];
  const key = `${e.pos.floor}|${e.pos.x},${e.pos.y}|${ctx.terrainVer.get(e.pos.floor) ?? 0}|${e.stats!.sight}`;
  const c = ctx.fovCache.get(pr.id);
  if (c && c.key === key) return c.cells;
  const f = ctx.world.floors[e.pos.floor];
  const cells = computeFov(f.width, f.height, isOpaqueFn(ctx, e.pos.floor), e.pos.x, e.pos.y, e.stats!.sight);
  ctx.fovCache.set(pr.id, { key, cells });
  return cells;
}

function sameArr(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 空の思い出。キーが guardian|種族 なら守護者の記録（V3-2R3 §20.4） */
export function emptyMemory(key: string): MonsterMemory {
  const g = key.startsWith('guardian|');
  return { kind: g ? key.slice('guardian|'.length) : key, encounters: 0, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...(g ? { guardian: true } : {}) };
}

/** モンスターの思い出を更新（変化があればイベント）。個体を渡すと、守護者は種族と別のキー（guardian|種族）に記録する */
export function updateMemory(ctx: Ctx, pid: PlayerId, who: string | Entity, fn: (m: MonsterMemory) => void): void {
  const pr = ctx.world.players[pid];
  if (!pr) return;
  const kind = typeof who === 'string' ? who : memoryKey(who.kind, who.role);
  const cur = pr.knowledge.monsterMemory[kind] ?? emptyMemory(kind);
  const next: MonsterMemory = { ...cur, abilities: [...cur.abilities] };
  fn(next);
  next.abilities = [...new Set(next.abilities)].sort();
  if (JSON.stringify(next) === JSON.stringify(cur) && pr.knowledge.monsterMemory[kind]) return;
  ctx.emit({ type: 'monster_memory_updated', player: pid, kind, memoryAfter: next, seenBy: [pid] });
}

const OBVIOUS_ABILITIES = ['fast', 'slow', 'stationary', 'pack'];

function visibleAbilities(ctx: Ctx, m: Entity): string[] {
  const def = ctx.content.monsters[m.kind];
  // 速さはその個体の速さから（大守護者は速さの下限で遅くない・俊敏な個体は速い。V3-7 の評価: 大守護者が「遅い」と出た）
  const out = (def?.abilities ?? []).filter((a) => OBVIOUS_ABILITIES.includes(a) && a !== 'fast' && a !== 'slow');
  for (const a of m.scale?.affixes ?? []) for (const ab of ctx.content.affixes[a]?.abilities ?? []) if (OBVIOUS_ABILITIES.includes(ab) && ab !== 'fast' && ab !== 'slow') out.push(ab);
  const speed = m.actor?.speed ?? def?.speed ?? 100;
  if (speed > 100) out.push('fast');
  else if (speed < 100) out.push('slow');
  return out;
}

/** フロア上の全生存プレイヤーの視界・記憶を更新する */
export function updateKnowledge(ctx: Ctx, key: FloorKey): void {
  const f = ctx.world.floors[key];
  if (!f) return;
  const players = ctx.playersOn(key);
  if (!players.length) return;
  const ents = ctx.entitiesOn(key);
  for (const pr of players) {
    seedPublicStairs(ctx, pr, key);
    const fov = playerFov(ctx, pr);
    const fovSet = new Set(fov);
    seedCampfires(ctx, pr, key, fovSet);
    const k = pr.knowledge;
    const fk = k.floors[key];
    const visChanged = !sameArr(fov, k.visible) || !fk;
    const newlySeen: number[] = [];
    for (const i of fov) if ((fk?.seen[i] ?? 0) !== f.terrain[i]) newlySeen.push(i, f.terrain[i]);
    const rememberedSet: RememberedEntity[] = [];
    const visibleIds = new Set<string>();
    const met: string[] = [];
    const metSet = new Set(k.met);
    const shots: string[] = [];
    const me = ctx.world.entities[pr.entityId];
    for (const e of ents) {
      if (!e.pos) continue;
      const idx = e.pos.y * f.width + e.pos.x;
      if (!fovSet.has(idx)) continue;
      if (e.actor && !e.player && (e.stats?.hp ?? 0) > 0) {
        // 背の高い草の中の者は隣からしか見えない（判定は actorSeen 1 つ。V4-0c §4.2）
        if (inCover(ctx.world, key, e.pos, me?.pos)) continue;
        if (!metSet.has(e.id)) met.push(e.id);
        if (me?.pos && shotClear(ctx, key, me.pos, e.pos)) shots.push(e.id);
        continue;
      }
      let cat: RememberedEntity['cat'] | null = null;
      if (e.item) cat = 'item';
      else if (e.trap) cat = e.trap.revealedTo.includes(pr.id) ? 'trap' : null;
      else if (e.feature) cat = 'feature';
      if (!cat) continue;
      visibleIds.add(e.id);
      const prev = fk?.remembered.find((r) => r.id === e.id);
      const state = e.feature?.state;
      const qty = e.item?.qty ?? 1;
      if (!prev || prev.pos.x !== e.pos.x || prev.pos.y !== e.pos.y || prev.qty !== qty || prev.state !== state || prev.kind !== e.kind) {
        const r: RememberedEntity = { id: e.id, kind: e.kind, cat, pos: { x: e.pos.x, y: e.pos.y }, qty, ft: f.time };
        if (state !== undefined) r.state = state;
        rememberedSet.push(r);
      }
    }
    const rememberedDel: string[] = [];
    for (const r of fk?.remembered ?? []) {
      if (fovSet.has(r.pos.y * f.width + r.pos.x) && !visibleIds.has(r.id)) rememberedDel.push(r.id);
    }
    const prevShots = k.shots ?? [];
    const shotsChanged = shots.length !== prevShots.length || shots.some((s, i) => s !== prevShots[i]);
    // 地図で知っていたセルを目で見た
    const mappedDel = fk?.mapped?.length ? fk.mapped.filter((i) => fovSet.has(i)) : [];
    // 目標の気配
    const sense = senseFor(ctx, pr, key);
    const prevSense = k.sense ?? null;
    const senseChanged = JSON.stringify(sense) !== JSON.stringify(prevSense);
    // 今いる階の手がかり（下への風・探索の進み具合。V3-2R2 §18.4）
    const hint = floorHintFor(ctx, pr, key, newlySeen, mappedDel);
    const hintChanged = JSON.stringify(hint) !== JSON.stringify(k.floorHint ?? null);
    if (visChanged || newlySeen.length || rememberedSet.length || rememberedDel.length || met.length || shotsChanged || mappedDel.length || senseChanged || hintChanged) {
      ctx.emit({
        type: 'knowledge_updated', player: pr.id, floorKey: key,
        visible: visChanged ? indicesToRanges(fov) : null,
        newlySeen, rememberedSet, rememberedDel, metAdd: met, ...(shotsChanged ? { shotsAfter: shots } : {}),
        ...(mappedDel.length ? { mappedDel } : {}), ...(senseChanged ? { senseAfter: sense } : {}), ...(hintChanged ? { hintAfter: hint } : {}),
        // このイベントの seq（emit が world.seq + 1 を振る）を初見の時点として記録する
        ...(met.length ? { metAtAfter: Object.fromEntries(met.map((id) => [id, ctx.world.seq + 1])) } : {}),
        seenBy: [pr.id], floor: key,
      });
    }
    for (const id of met) {
      const m = ctx.world.entities[id];
      updateMemory(ctx, pr.id, m, (mm) => {
        mm.encounters += 1;
        mm.abilities.push(...visibleAbilities(ctx, m));
        // 守護者の型（図鑑。V3-7 §7.2）
        if (m.guardian?.types.length) mm.types = [...new Set([...(mm.types ?? []), ...m.guardian.types])].sort();
      });
    }
    // 休んでいた守護者が見えた: 過ぎた手番の分だけ回復する（V3-3b §40.5。見えたときにまとめて）
    if (me?.pos) for (const g of ents) {
      if (!g.guardian?.awaySince || !g.pos || (g.stats?.hp ?? 0) <= 0) continue;
      if (!fovSet.has(g.pos.y * f.width + g.pos.x)) continue;
      restGuardian(ctx, g, ctx.world.entities[pr.entityId] ?? me);
    }
  }
}

/**
 * 公開された下り階段（S0。PROTOCOL §9.4）: キャンプで取り込んだ一覧にこの階があれば、その下り階段のマスを覚えている地図に載せる。
 * 地図の巻物と同じ「地形は分かっているが、まだ見ていない」マス（mapped）。途中の道は載せない。シーズンでないランには一覧が無い
 */
function seedPublicStairs(ctx: Ctx, pr: PlayerRecord, key: FloorKey): void {
  const f = ctx.world.floors[key];
  const ps = f && f.branch === 'main' ? ctx.world.season?.public.find((p) => p.depth === f.depth) : undefined;
  if (!f || !ps || !f.stairs.down.some((d) => d.x === ps.x && d.y === ps.y)) return;
  const i = ps.y * f.width + ps.x;
  if ((pr.knowledge.floors[key]?.seen[i] ?? 0) !== 0) return;
  ctx.emit({
    type: 'knowledge_updated', player: pr.id, floorKey: key, visible: null, newlySeen: [i, f.terrain[i]], rememberedSet: [], rememberedDel: [], metAdd: [],
    mappedAdd: [i], publicStairs: ps.by, seenBy: [pr.id], floor: key,
  });
}

/**
 * 野営の火（S1。PROTOCOL §9.10）: その階に入ると、まだ覚えていない火のマスが覚えている地図に載る（置いた者の名前つき。途中の道は載せない）。
 * いま見えている火は、目で見て覚える（この関数では載せない。自分で置いた火も）
 */
function seedCampfires(ctx: Ctx, pr: PlayerRecord, key: FloorKey, fovSet: ReadonlySet<number>): void {
  const f = ctx.world.floors[key];
  if (!f || !ctx.world.season) return;
  for (const e of ctx.entitiesOn(key)) {
    if (!e.campfire || !e.pos) continue;
    const i = e.pos.y * f.width + e.pos.x;
    if (fovSet.has(i)) continue;
    const fk = pr.knowledge.floors[key];
    if (fk?.remembered.some((r) => r.id === e.id)) continue;
    const unseen = (fk?.seen[i] ?? 0) === 0;
    ctx.emit({
      type: 'knowledge_updated', player: pr.id, floorKey: key, visible: null, newlySeen: unseen ? [i, f.terrain[i]] : [],
      rememberedSet: [{ id: e.id, kind: e.kind, cat: 'feature', pos: { x: e.pos.x, y: e.pos.y }, qty: 1, ft: f.time, state: e.feature?.state ?? 'lit' }],
      rememberedDel: [], metAdd: [], ...(unseen ? { mappedAdd: [i] } : {}), publicFire: e.campfire.by, seenBy: [pr.id], floor: key,
    });
  }
}

/**
 * 目標の気配（公開ルール）: 遠征の参加者が目標階にいる間、守護者（未討伐）か遺物（未入手）の方角と、10 マス以内かどうか。
 * 正確な位置は出さない。
 */
function senseFor(ctx: Ctx, pr: PlayerRecord, key: FloorKey): Sense | null {
  const x = currentExpedition(ctx.world);
  const me = ctx.world.entities[pr.entityId];
  if (!x || !me?.pos || !x.participants.includes(pr.id)) return null;
  if (x.objective.targetDepth === null || ctx.world.floors[key]?.depth !== x.objective.targetDepth) return null;
  let id: string | null = null;
  let what: Sense['what'] = 'guardian';
  if (x.objective.type === 'slay_guardian' && !x.progress.guardianSlain) id = x.targets.guardian;
  else if (x.objective.type === 'retrieve_relic' && !x.progress.relicHeldBy) { id = x.targets.relic; what = 'relic'; }
  const tgt = id ? ctx.world.entities[id] : undefined;
  if (!tgt?.pos || tgt.pos.floor !== key) return null;
  const dir = compassDir(me.pos, tgt.pos);
  if (!dir) return null;
  return { what, dir, range: cheb(me.pos, tgt.pos) <= 10 ? 'near' : 'far' };
}

/** 探索の進み具合の 4 段階の境界（見た割合 %）: 40 未満 = 約 1/4、65 未満 = 約半分、90 未満 = 約 3/4、それ以上 = ほぼ全て */
const EXPLORED_BANDS = [40, 65, 90];

/**
 * 今いる階の手がかり（公開ルール）: 下り階段をまだ見ていなければその 8 方向（遠近は出さない）と、
 * 通れるマスのうち自分の目で見た割合の 4 段階。未探索の地形そのものは渡さない
 */
function floorHintFor(ctx: Ctx, pr: PlayerRecord, key: FloorKey, newlySeen: number[], mappedDel: number[]): FloorHint | null {
  const me = ctx.world.entities[pr.entityId];
  const f = ctx.world.floors[key];
  if (!me?.pos || me.pos.floor !== key || !f) return null;
  const fk = pr.knowledge.floors[key];
  const fresh = new Set<number>();
  for (let j = 0; j < newlySeen.length; j += 2) fresh.add(newlySeen[j]);
  const known = (i: number) => (fk?.seen[i] ?? 0) !== 0 || fresh.has(i);
  // 公開された階段（S0 §9.4）は、自分の目で見るまで下への風を出し続ける（地図に載っているが、まだ見ていないマス）
  const sighted = new Set(mappedDel);
  const pub = ctx.world.season?.public.find((p) => p.depth === f.depth);
  const publicOnly = (sx: number, sy: number) => !!pub && f.branch === 'main' && pub.x === sx && pub.y === sy
    && (fk?.mapped ?? []).includes(sy * f.width + sx) && !sighted.has(sy * f.width + sx);
  let draft: FloorHint['draft'] = null;
  if (f.stairs.down.length && !f.stairs.down.some((s) => known(s.y * f.width + s.x) && !publicOnly(s.x, s.y))) {
    const near = [...f.stairs.down].sort((a, b) => cheb(me.pos!, a) - cheb(me.pos!, b) || a.y - b.y || a.x - b.x)[0];
    draft = compassDir(me.pos, near);
  }
  const prev = pr.knowledge.floorHint;
  let explored: FloorHint['explored'];
  if (prev && prev.floor === key && !newlySeen.length && !mappedDel.length) explored = prev.explored;
  else {
    const mapped = new Set(fk?.mapped ?? []);
    for (const i of mappedDel) mapped.delete(i);
    let total = 0, seen = 0;
    for (let i = 0; i < f.terrain.length; i++) {
      const x = i % f.width, y = Math.trunc(i / f.width);
      if (!ctx.terrainAt(key, x, y).passable && !ctx.terrainAt(key, x, y).door) continue;
      total++;
      if (known(i) && !mapped.has(i)) seen++;
    }
    const pct = total > 0 ? Math.trunc((seen * 100) / total) : 100;
    explored = pct < EXPLORED_BANDS[0] ? 1 : pct < EXPLORED_BANDS[1] ? 2 : pct < EXPLORED_BANDS[2] ? 3 : 4;
  }
  return { floor: key, draft, explored };
}

/**
 * モンスターがプレイヤーを視認できるか（プレイヤーの視界と対称、半径外は射線）。
 * 背の高い草の中の者は、隣からしか見えない（V3-5 §5.2。判定はプレイヤーの側と同じ inCover。V4-0c §4.2）
 */
export function monsterSees(ctx: Ctx, m: Entity, target: Entity): boolean {
  if (!m.pos || !target.pos || m.pos.floor !== target.pos.floor) return false;
  if (!inCircle(m.pos, target.pos, m.stats!.sight)) return false;
  if (inCover(ctx.world, target.pos.floor, target.pos, m.pos)) return false;
  const pr = target.player ? ctx.world.players[target.player] : undefined;
  if (pr) {
    const f = ctx.world.floors[m.pos.floor];
    const idx = m.pos.y * f.width + m.pos.x;
    if (ctx.visibleSet(pr.id).has(idx)) return true;
    if (inCircle(m.pos, target.pos, target.stats!.sight)) return false;
  }
  return hasLos(m.pos, target.pos, isOpaqueFn(ctx, m.pos.floor));
}

/** 睡眠中（休眠）のモンスターを起こす */
/** 起きた理由（V3-4b §28.8。見えている者に monster_woke で知らせる。無ければ知らせない） */
export interface WakeWhy { cause: 'noise' | 'sight' | 'pack' | 'floor'; by?: Entity | null; ring?: string | null }

export function wakeMonster(ctx: Ctx, m: Entity, targetPos: Pos | null, why?: WakeWhy): void {
  const ai = m.actor?.ai;
  if (!ai) return;
  if (!m.actor!.dormant && ai.state !== 'asleep' && ai.state !== 'unaware') {
    if (targetPos && ai.state === 'searching') {
      ctx.emit({ type: 'ai_state_changed', id: m.id, ai: { ...ai, targetPos: { ...targetPos } }, dormant: false, nextActAt: m.actor!.nextActAt, seenBy: [] });
    }
    return;
  }
  const f = ctx.world.floors[m.pos!.floor];
  const wasAsleep = !!m.actor!.dormant || ai.state === 'asleep';
  const nextActAt = m.actor!.dormant ? Math.max(m.actor!.nextActAt, f.time + ctx.rng('runtime').int(60)) : m.actor!.nextActAt;
  ctx.emit({
    type: 'ai_state_changed', id: m.id,
    ai: { ...ai, state: targetPos ? 'searching' : 'unaware', targetPos: targetPos ? { ...targetPos } : null, lostTurns: 0 },
    dormant: false, nextActAt, seenBy: [], floor: m.pos!.floor,
  });
  // 起きた理由を、その敵が見えている者に知らせる（V3-4b §28.8）
  if (why && m.pos) {
    const seen = ctx.perceive(m.pos.floor, [{ field: 'id', pos: m.pos, entity: m.id }], []);
    if (seen.seenBy.length) {
      ctx.emit({ type: 'monster_woke', id: m.id, kind: m.kind, reason: why.cause, by: why.by?.id ?? null, ring: why.ring ?? null, wasAsleep, ...seen, floor: m.pos.floor });
    }
  }
  // 階の異変「深い眠り」（V3-5 §5.3）: 1 体起きると全員が起きる
  if (wasAsleep && f.event?.handler === 'deep_sleep' && why?.cause !== 'floor' && m.pos) {
    for (const o of ctx.entitiesOn(m.pos.floor)) {
      if (o.id === m.id || !o.actor?.ai || o.player || o.guardian) continue;
      if (o.actor.dormant || o.actor.ai.state === 'asleep') wakeMonster(ctx, ctx.world.entities[o.id] ?? o, targetPos, { cause: 'floor' });
    }
  }
}

/** 脆い天井が崩れる（V3-5 §5.2）: trigger マス以内で loudness 以上の音。radius マスの者に dmg、真下は瓦礫 */
function collapseCeilings(ctx: Ctx, key: FloorKey, pos: Pos, loudness: number): void {
  for (const c of ctx.entitiesOn(key)) {
    const def = c.feature && c.pos ? ctx.content.features[c.kind]?.collapse : undefined;
    if (!def || c.feature!.state !== 'intact' || loudness < def.loudness || cheb(c.pos!, pos) > def.trigger) continue;
    const at = { x: c.pos!.x, y: c.pos!.y };
    ctx.emit({ type: 'feature_state', id: c.id, kind: c.kind, state: 'fallen', ...ctx.perceive(key, [{ field: 'id', pos: at }], []), floor: key });
    const rng = ctx.rng('runtime');
    for (const v of ctx.entitiesOn(key)) {
      if (!v.actor || !v.pos || cheb(v.pos, at) > def.radius || (v.stats?.hp ?? 0) <= 0) continue;
      applyDamage(ctx, v, Math.max(1, roll(rng, def.dmg)), null, 'effect');
    }
    if (!ctx.actorAt(key, at.x, at.y)) {
      const rubble = ctx.world.meta.terrainTable.indexOf('core:rubble');
      if (rubble >= 0) ctx.emit({ type: 'tile_changed', x: at.x, y: at.y, terrain: rubble, reason: 'collapse', by: null, ...ctx.tileSeen(key, at, null), floor: key });
    }
  }
}

/** 騒音: 聞こえたプレイヤーへのイベントと、周囲のモンスターの起床 */
export function makeNoise(ctx: Ctx, key: FloorKey, pos: Pos, loudness0: number, source: Entity | null): void {
  // 水の上の音は 2 倍遠くまで届く（V3-5 §5.2 湿った洞窟）
  const loudness = ctx.terrainAt(key, pos.x, pos.y).tags.includes('water') ? loudness0 * 2 : loudness0;
  // 脆い天井（V3-5 §5.2）: 近くで大きな音がすると崩れる
  collapseCeilings(ctx, key, pos, loudness);
  const hearers = ctx.playersOn(key).filter((pr) => {
    const e = ctx.world.entities[pr.entityId];
    return e.pos && inCircle(e.pos, pos, loudness) && e.id !== source?.id;
  }).map((p) => p.id);
  if (hearers.length) ctx.emit({ type: 'noise', pos: { ...pos }, loudness, source: null, seenBy: hearers, floor: key });
  const rng = ctx.rng('runtime');
  // 静寂の指輪の欠点: 自分の立てた音では、眠っている敵が必ず起きる（V3-4）
  const always = !!source?.player && gearOf(ctx, source).noiseWakes;
  const ring = always && source ? noiseRingOf(ctx, source) : null;
  for (const m of ctx.entitiesOn(key)) {
    if (!m.actor || m.player || m.id === source?.id || !m.pos) continue;
    const ai = m.actor.ai;
    if (!ai || (ai.state !== 'asleep' && ai.state !== 'unaware')) continue;
    if (!inCircle(m.pos, pos, loudness)) continue;
    // 加護（鎮め。V3-3 §3.3）: 自分の立てた音で眠っている敵が起きる確率を下げる（引く乱数は 1 回のまま）
    const calm = source?.player ? boonHook(ctx, source, 'soothe') : null;
    if (ai.state === 'asleep' && !always && !rng.chance(calm ? Math.trunc((50 * (calm.params.pct ?? 50)) / 100) : 50)) continue;
    // 欠点が効いたのは、眠っていた敵が「必ず起きる」で起きたときだけ
    wakeMonster(ctx, m, pos, { cause: 'noise', by: source, ring: ai.state === 'asleep' ? ring : null });
  }
}

/** プレイヤーの手番ごとに: 視界内の睡眠中モンスターが目を覚ますか */
export function wakeChecks(ctx: Ctx, key: FloorKey): void {
  const players = ctx.playersOn(key);
  if (!players.length) return;
  const rng = ctx.rng('runtime');
  for (const m of ctx.entitiesOn(key)) {
    if (!m.actor?.dormant || !m.pos) continue;
    for (const pr of players) {
      const pe = ctx.world.entities[pr.entityId];
      if (!pe.pos || !inCircle(m.pos, pe.pos, m.stats!.sight)) continue;
      if (!monsterSees(ctx, m, pe)) continue;
      // 起こしにくさ = 職業 + 特技（忍び足）+ 装備。重い鎧は起きる確率を足す（V3-4）。眠りが深い守護者は起きにくい（V3-3b §40.4）
      const stealth = Math.min(100, stealthOf(ctx, pr) + (m.guardian ? deepSleepStealth(ctx, m) : 0));
      // 加護（鎮め。V3-3 §3.3）: 起きる確率に pct % を掛ける（最小 1）
      const calm = boonHook(ctx, pe, 'soothe');
      const wakePct = (s: number) => {
        const v = Math.max(3, 20 - Math.trunc((20 * s) / 100)) + gearOf(ctx, pe).wakePct;
        return calm ? Math.max(1, Math.trunc((v * (calm.params.pct ?? 50)) / 100)) : v;
      };
      const pct = wakePct(stealth);
      // rng.chance(pct) と同じ引き方（1 回引いて比べる）。特技が無ければ起きていた目なら、忍び足が効いたと知らせる（V3-4b §28.6）
      const roll = pct >= 100 ? -1 : rng.int(100);
      if (roll < pct) {
        wakeMonster(ctx, m, { x: pe.pos.x, y: pe.pos.y }, { cause: 'sight', by: pe });
        break;
      }
      const perkS = perkStealth(ctx, pe);
      if (perkS > 0 && roll < wakePct(Math.max(0, stealth - perkS))) notePerk(ctx, pe, firstStealthPerk(ctx, pe), 'not_woken', { subject: m });
    }
  }
}

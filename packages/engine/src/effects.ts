// 効果 DSL のハンドラ（レジストリ登録）。データ（アイテム・地物・罠・攻撃時効果）から ID で参照される。
import type { EffectDef } from '@muse/content';
import type { Entity, Pos } from '@muse/shared';
import { cheb, isPursuing } from '@muse/shared';
import { applyDamage, heal } from './combat';
import type { Ctx } from './ctx';
import { hasLos, inCircle } from './geom';
import { isOpaqueFn, makeNoise, updateMemory } from './perception';
import { Registry, roll } from './registry';
import { lifelineReturn } from './expedition';
import { addStatus, removeStatus } from './statuses';
import { inspectItem, liftCurses } from './build';
import { pickLore } from './story';
import { recomputeStats } from './stats';
import { pickMonster } from './gen/generate';
import { spawnFromSpec } from './spawn';
import { wakeMonster } from './perception';

export interface EffectCtx {
  /** 効果の使い手（薬を飲んだ者、攻撃者、罠なら null） */
  user: Entity | null;
  /** 効果の対象 */
  target: Entity;
  pos: Pos;
  source: Entity | null;
  via: string;
  /** 鑑定などの対象スロット（use_item の target_slot） */
  itemSlot?: string;
  /** 使った品の種類（鑑定の既定の対象から除く） */
  usedKind?: string;
  /** 操作した地物（碑文。V3-5 §5.1） */
  feature?: Entity;
}

export type EffectHandler = (ctx: Ctx, params: EffectDef, ec: EffectCtx) => void;

export const effects = new Registry<EffectHandler>('effect');

const num = (v: unknown, d = 0) => (typeof v === 'number' ? v : d);
const dice = (ctx: Ctx, v: unknown, d = '1') => roll(ctx.rng('runtime'), typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);

// minPct: 最大 HP の minPct % を下回らない（回復の薬。V3-3a §35.4）
effects.register('heal', (ctx, p, ec) => {
  const n = dice(ctx, p.amount, '1d8');
  const floorHp = p.minPct !== undefined ? Math.trunc(((ec.target.stats?.maxHp ?? 0) * num(p.minPct, 0)) / 100) : 0;
  heal(ctx, ec.target, Math.max(n, floorHp), ec.via);
});

effects.register('cure', (ctx, p, ec) => { removeStatus(ctx, ec.target, String(p.status)); });

effects.register('status', (ctx, p, ec) => {
  const st = String(p.status);
  addStatus(ctx, ec.target, st, dice(ctx, p.turns, '5'), num(p.power, 1), ec.source?.id ?? null);
  if (st === 'core:poison' && ec.source && !ec.source.player && ec.target.player) {
    updateMemory(ctx, ec.target.player, ec.source, (m) => { m.abilities.push('poison'); });
  }
});

// pct: 今の HP の pct %（切り捨て。0 なら何もしない。賭けの祭壇の「HP が半分」。V3-5 §5.1）
effects.register('damage', (ctx, p, ec) => {
  if (typeof p.pct === 'number') {
    const n = Math.trunc(((ctx.world.entities[ec.target.id]?.stats?.hp ?? 0) * p.pct) / 100);
    if (n > 0) applyDamage(ctx, ec.target, n, ec.source, 'effect');
    return;
  }
  applyDamage(ctx, ec.target, Math.max(1, dice(ctx, p.amount, '1d4')), ec.source, ec.via === 'trap' ? 'trap' : 'effect');
});

effects.register('max_hp', (ctx, p, ec) => {
  const t = ctx.world.entities[ec.target.id];
  if (!t?.stats || !t.base) return;
  const n = num(p.amount, 1);
  const seen = t.pos ? ctx.perceive(t.pos.floor, [{ field: 'target', pos: t.pos, entity: t.id }], t.player ? [t.player] : []) : { seenBy: [] };
  ctx.emit({ type: 'max_hp_changed', target: t.id, targetKind: t.kind, maxHpAfter: t.stats.maxHp + n, hpAfter: t.stats.hp + n, ...seen });
  ctx.emit({ type: 'stats_changed', target: t.id, statsAfter: { ...ctx.world.entities[t.id].stats! }, baseAfter: { ...t.base, maxHp: t.base.maxHp + n }, speedAfter: null, reason: 'max_hp', seenBy: t.player ? [t.player] : [] });
});

/**
 * 転移（V3-2R2 §18.1）: 着地点は「元の位置から teleport.minDistance 以上、かつ追跡中の敵から見えないマス」から選ぶ。
 * 無ければ距離の条件だけ、それも無ければ通れるマス全体から。敵が転移する場合も同じ規則（敵から見て「追跡中の敵」はプレイヤー）
 */
effects.register('teleport', (ctx, _p, ec) => {
  const t = ctx.world.entities[ec.target.id];
  if (!t?.pos) return;
  const key = t.pos.floor;
  const f = ctx.world.floors[key];
  const from = { x: t.pos.x, y: t.pos.y };
  const minD = ctx.content.balance.teleport.minDistance;
  const opaque = isOpaqueFn(ctx, key);
  // 追ってくる相手の目: プレイヤーなら追跡中のモンスター、モンスターならプレイヤーの視界
  const hunters = t.player
    ? ctx.entitiesOn(key).filter((m) => m.actor && !m.player && m.pos && (m.stats?.hp ?? 0) > 0 && isPursuing(m))
    : [];
  const playerVis = t.player ? [] : ctx.playersOn(key).map((pr) => ctx.visibleSet(pr.id));
  const watched = (x: number, y: number): boolean => {
    if (t.player) return hunters.some((m) => inCircle(m.pos!, { x, y }, m.stats!.sight) && hasLos(m.pos!, { x, y }, opaque));
    return playerVis.some((v) => v.has(y * f.width + x));
  };
  const any: Pos[] = [];
  const far: Pos[] = [];
  const hidden: Pos[] = [];
  for (let y = 1; y < f.height - 1; y++) {
    for (let x = 1; x < f.width - 1; x++) {
      const tr = ctx.terrainAt(key, x, y);
      if (!tr.passable || tr.stairs || ctx.actorAt(key, x, y) || ctx.featureAt(key, x, y)?.trap) continue;
      any.push({ x, y });
      if (cheb(from, { x, y }) < minD) continue;
      far.push({ x, y });
      if (!watched(x, y)) hidden.push({ x, y });
    }
  }
  const pool = hidden.length ? hidden : far.length ? far : any;
  if (!pool.length) return;
  const to = pool[ctx.rng('runtime').int(pool.length)];
  const seen = ctx.perceive(key, [{ field: 'from', pos: from }, { field: 'to', pos: to }], t.player ? [t.player] : []);
  ctx.emit({ type: 'entity_moved', id: t.id, kind: t.kind, from, to: { ...to }, mode: 'teleport', ...seen });
});

// 帰還の綱: lifeline.turns が 0 なら使った手番でキャンプへ戻る（V3-2R3 §20.3）。1 以上ならその手番のあいだ行動できず、その後戻る
effects.register('recall', (ctx, _p, ec) => {
  const turns = ctx.content.balance.lifeline.turns;
  if (turns <= 0) { lifelineReturn(ctx, ec.target); return; }
  addStatus(ctx, ec.target, 'core:recall', turns, 1);
});

effects.register('identify', (ctx, p, ec) => {
  const user = ec.user ?? ec.target;
  if (!user.player) return;
  const pr = ctx.world.players[user.player];
  // 対象: target_slot があればその品。無ければスロット順で最初の「未鑑定の種類」か「呪いの有無を確かめていない装備品」（使った巻物自身の種類は除く。公開ルール）。
  // 1 品で 1 回: 未鑑定の種類なら正体が、装備品なら呪いの有無も分かる（V3-4 §4.4）
  const items = (user.inv?.items ?? []).map((id) => ctx.world.entities[id]).filter((it): it is Entity => !!it?.item)
    .sort((a, b) => (a.item!.slot ?? '').localeCompare(b.item!.slot ?? ''));
  const unknownKind = (it: Entity) => !!ctx.world.secret.appearances[it.kind] && !ctx.world.players[pr.id].knowledge.identified.includes(it.kind);
  const uninspected = (it: Entity) => !!ctx.content.items[it.kind]?.equip && !ctx.world.entities[it.id]?.item?.inspected;
  const picked: Entity[] = [];
  const kinds = new Set<string>();
  const pick = (it: Entity) => {
    if (picked.some((x) => x.id === it.id)) return;
    const k = unknownKind(it) && !kinds.has(it.kind);
    if (!k && !uninspected(it)) return;
    picked.push(it);
    if (k) kinds.add(it.kind);
  };
  if (ec.itemSlot) { const it = items.find((x) => x.item!.slot === ec.itemSlot); if (it) pick(it); }
  for (const it of items) if (it.kind !== ec.usedKind) pick(it);
  for (const it of picked.slice(0, num(p.count, 1))) {
    if (unknownKind(it)) ctx.emit({ type: 'item_identified', player: pr.id, kind: it.kind, appearanceId: ctx.world.secret.appearances[it.kind] ?? null, seenBy: [pr.id] });
    if (uninspected(it)) inspectItem(ctx, ctx.world.entities[user.id], ctx.world.entities[it.id], 'identify');
  }
});

// 呪いを解く（解呪の巻物・祭壇。V3-4 §4.4）: 所持品すべての呪いの接辞を消す
effects.register('uncurse', (ctx, _p, ec) => {
  const user = ec.user ?? ec.target;
  if (!user.player) return;
  liftCurses(ctx, ctx.world.entities[user.id]);
});

effects.register('map', (ctx, p, ec) => {
  const t = ec.target;
  if (!t.player || !t.pos) return;
  const key = t.pos.floor;
  const f = ctx.world.floors[key];
  const pr = ctx.world.players[t.player];
  const fk = pr.knowledge.floors[key];
  const newly: number[] = [];
  const wallIdx = ctx.world.meta.terrainTable.indexOf('core:wall');
  // radius: その距離までだけ（残り頁。V3-5 §5.2）
  const rad = typeof p.radius === 'number' ? p.radius : null;
  for (let y = 0; y < f.height; y++) {
    for (let x = 0; x < f.width; x++) {
      const i = y * f.width + x;
      const tv = f.terrain[i];
      if (rad !== null && Math.max(Math.abs(x - t.pos.x), Math.abs(y - t.pos.y)) > rad) continue;
      if ((fk?.seen[i] ?? 0) === tv) continue;
      if (tv === wallIdx) {
        // 床に接する壁だけ
        let touches = false;
        for (let dy = -1; dy <= 1 && !touches; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
          if (f.terrain[ny * f.width + nx] !== wallIdx) { touches = true; break; }
        }
        if (!touches) continue;
      }
      newly.push(i, tv);
    }
  }
  // 地形は分かったが目で見ていないセル（今の視界の外で、まだ記憶に無かったもの）
  const vis = new Set(pr.knowledge.visible);
  const already = new Set(fk?.mapped ?? []);
  const mappedAdd: number[] = [];
  for (let j = 0; j + 1 < newly.length; j += 2) {
    const i = newly[j];
    if (!vis.has(i) && !already.has(i) && (fk?.seen[i] ?? 0) === 0) mappedAdd.push(i);
  }
  ctx.emit({
    type: 'knowledge_updated', player: pr.id, floorKey: key, visible: null, newlySeen: newly, rememberedSet: [], rememberedDel: [], metAdd: [],
    ...(mappedAdd.length ? { mappedAdd } : {}), seenBy: [pr.id], floor: key,
  });
});

/**
 * 碑文・書き置き（V3-5 §5.1）: 記録の断章と、手がかり 1 つ（clue: 1 のときだけ）。手がかりは、この階の守護者の弱点（まだ知らない）→
 * この階の鍵のかかった宝物庫の場所（地図に記す）→ 未鑑定の品 1 種の正体（持っている物を先に）の順に、当てはまる最初のもの
 */
effects.register('inscription', (ctx, p, ec) => {
  const user = ec.user ?? ec.target;
  if (!user.player || !user.pos) return;
  const pr = ctx.world.players[user.player];
  const key = user.pos.floor;
  const note = num(p.clue, 1) === 0;
  const fid = ec.feature?.id ?? '';
  const lore = pickLore(ctx.content, ctx.world.secret.seed, `${note ? 'note' : 'inscription'}|${key}|${ec.pos.x},${ec.pos.y}`, note ? 'note' : 'inscription', {}, {});
  let clue: 'weakness' | 'vault' | 'identify' | 'none' = 'none';
  let clueText: { ja: string; en: string } | undefined;
  if (!note) {
    const g = ctx.entitiesOn(key).find((m) => m.guardian?.weakness && (m.stats?.hp ?? 0) > 0 && !pr.knowledge.guardianIntel?.[m.id]);
    const f = ctx.world.floors[key];
    const fk = pr.knowledge.floors[key];
    const vault = f.regions.find((r) => r.kind === 'prefab' && r.tags.includes('vault_locked') && !r.found);
    if (g) {
      clue = 'weakness';
      ctx.emit({ type: 'guardian_intel', player: pr.id, guardian: g.id, guardianName: { ...g.guardian!.name }, weakness: g.guardian!.weakness!, seenBy: [pr.id], floor: key });
    } else if (vault) {
      clue = 'vault';
      const newly: number[] = [];
      for (let y = vault.y - 1; y <= vault.y + vault.h; y++) for (let x = vault.x - 1; x <= vault.x + vault.w; x++) {
        if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
        const i = y * f.width + x;
        if ((fk?.seen[i] ?? 0) !== f.terrain[i]) newly.push(i, f.terrain[i]);
      }
      const vis = new Set(pr.knowledge.visible);
      const mappedAdd = newly.filter((_, j) => j % 2 === 0).filter((i) => !vis.has(i) && (fk?.seen[i] ?? 0) === 0);
      ctx.emit({ type: 'knowledge_updated', player: pr.id, floorKey: key, visible: null, newlySeen: newly, rememberedSet: [], rememberedDel: [], metAdd: [], ...(mappedAdd.length ? { mappedAdd } : {}), seenBy: [pr.id], floor: key });
      const cx = vault.x + Math.trunc(vault.w / 2), cy = vault.y + Math.trunc(vault.h / 2);
      clueText = { ja: `この階の施錠された宝物庫は (${cx},${cy}) のあたり（地図に記した。鍵はこの階の敵が持っている）`, en: `this floor's locked vault is around (${cx},${cy}) (marked on your map; a monster on this floor carries the key)` };
    } else {
      const known = new Set(pr.knowledge.identified);
      const held = (user.inv?.items ?? []).map((id) => ctx.world.entities[id]?.kind).filter((k): k is string => !!k && !!ctx.world.secret.appearances[k] && !known.has(k));
      const any = Object.keys(ctx.world.secret.appearances).filter((k) => !known.has(k)).sort();
      const pick = held[0] ?? (any.length ? any[ctx.rng('runtime').int(any.length)] : undefined);
      if (pick) {
        clue = 'identify';
        ctx.emit({ type: 'item_identified', player: pr.id, kind: pick, appearanceId: ctx.world.secret.appearances[pick] ?? null, seenBy: [pr.id] });
      }
    }
  }
  ctx.emit({ type: 'inscription_read', player: pr.id, feature: fid, note, lore, clue, ...(clueText ? { clueText } : {}), seenBy: [pr.id], floor: key });
});

/** 賭けの祭壇: 持ち物の装備 1 つ（装備中を先に）に、まだ付いていない良い接辞を 1 つ（V3-5 §5.1） */
effects.register('affix_item', (ctx, _p, ec) => {
  const user = ec.user ?? ec.target;
  if (!user.player) return;
  const rng = ctx.rng('runtime');
  const equipped = new Set(Object.values(user.equip ?? {}).filter(Boolean) as string[]);
  const items = (user.inv?.items ?? []).map((id) => ctx.world.entities[id]).filter((it): it is Entity => !!it?.item && !!ctx.content.items[it.kind]?.equip)
    .sort((a, b) => Number(equipped.has(b.id)) - Number(equipped.has(a.id)) || (a.item!.slot ?? '').localeCompare(b.item!.slot ?? ''));
  for (const it of items) {
    const cat = ctx.content.items[it.kind].category;
    const cands = ctx.content.lists.affixes.filter((a) => a.target === 'item' && !a.cursed && (a.categories ?? []).includes(cat) && !it.item!.affixes.includes(a.id));
    if (!cands.length) continue;
    const a = cands[rng.int(cands.length)];
    const body = structuredClone(it);
    body.item!.affixes = [...body.item!.affixes, a.id];
    ctx.emit({ type: 'item_altered', actor: user.id, item: it.id, kind: it.kind, affix: a.id, cursed: false, put: [body], seenBy: [user.player], floor: user.pos?.floor ?? null });
    if (equipped.has(it.id)) recomputeStats(ctx, ctx.world.entities[user.id], 'affix');
    return;
  }
});

/** 賭けの祭壇: 装備している品 1 つが呪われる（呪いの接辞が付き、外せなくなる。すぐ分かる。V3-5 §5.1） */
effects.register('curse_item', (ctx, _p, ec) => {
  const user = ec.user ?? ec.target;
  if (!user.player) return;
  const rng = ctx.rng('runtime');
  const worn = Object.values(user.equip ?? {}).filter(Boolean).map((id) => ctx.world.entities[id as string]).filter((it): it is Entity => !!it?.item);
  if (!worn.length) return;
  const it = worn[rng.int(worn.length)];
  const cat = ctx.content.items[it.kind]?.category;
  const cands = ctx.content.lists.affixes.filter((a) => a.target === 'item' && a.cursed && (a.categories ?? []).includes(cat) && !it.item!.affixes.includes(a.id));
  if (!cands.length) return;
  const a = cands[rng.int(cands.length)];
  const body = structuredClone(it);
  body.item!.affixes = [...body.item!.affixes, a.id];
  body.item!.inspected = true;
  ctx.emit({ type: 'item_altered', actor: user.id, item: it.id, kind: it.kind, affix: a.id, cursed: true, put: [body], seenBy: [user.player], floor: user.pos?.floor ?? null });
  recomputeStats(ctx, ctx.world.entities[user.id], 'curse');
});

/** 賭けの祭壇: その階の種族から count 体を隣に呼ぶ（起きていて、呼んだ相手を追う。V3-5 §5.1） */
effects.register('summon', (ctx, p, ec) => {
  const t = ec.target;
  if (!t.pos) return;
  const key = t.pos.floor;
  const f = ctx.world.floors[key];
  const biome = ctx.content.biomes[f.biome];
  const floorType = ctx.content.floorTypes[f.floorType];
  if (!biome || !floorType) return;
  const rng = ctx.rng('runtime');
  let n = 0;
  for (let dy = -1; dy <= 1 && n < num(p.count, 1); dy++) for (let dx = -1; dx <= 1 && n < num(p.count, 1); dx++) {
    const x = t.pos.x + dx, y = t.pos.y + dy;
    if ((!dx && !dy) || x < 0 || y < 0 || x >= f.width || y >= f.height || !ctx.terrainAt(key, x, y).passable || ctx.actorAt(key, x, y)) continue;
    const pick = pickMonster({ content: ctx.content, depth: f.depth, biome, floorType }, rng);
    if (!pick || pick.def.ai.archetype === 'stationary') continue;
    const s = spawnFromSpec(ctx, key, { type: 'monster', kind: pick.def.id, x, y, hp: Math.max(1, roll(rng, pick.def.stats.hp)), affixes: [], tier: pick.tier, asleep: false, delay: 0 }, 'summoned');
    if (s) wakeMonster(ctx, ctx.world.entities[s.id] ?? s, { x: t.pos.x, y: t.pos.y });
    n++;
  }
});

effects.register('noise', (ctx, p, ec) => {
  if (!ec.target.pos) return;
  makeNoise(ctx, ec.target.pos.floor, ec.pos, num(p.loudness, 10), null);
});

export function applyEffects(ctx: Ctx, list: readonly EffectDef[], ec: EffectCtx): void {
  const rng = ctx.rng('runtime');
  for (const e of list) {
    if (e.chancePct !== undefined && !rng.chance(e.chancePct)) continue;
    const target = ctx.world.entities[ec.target.id];
    if (!target || (target.stats && target.stats.hp <= 0)) return;
    effects.get(e.effect)(ctx, e, { ...ec, target });
  }
}

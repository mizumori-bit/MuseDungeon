// 補給の置き場（S3。SEASON.md §25.2・PROTOCOL.md §9.12）: 各階の上り階段・下り階段のマスと野営の火に、消耗品を預ける・取る。
// 置き場の中身はエンティティでなく、ランの写し（SeasonState の supplies・deposited・taken）にある（shared の cacheAt）。
// 取った品は、その場で持ち物に作る（エンティティの ID の乱数は使うが、生成の乱数は使わない。入口と階段はシードと版だけで決まる。§2.3）
import type { ActionError, Entity, PlayerRecord, SupplyPlace } from '@muse/shared';
import { actionError, cacheAt, currentExpedition, SUPPLY_CATEGORIES, supplyPlaceName, supplyTakenThis, t } from '@muse/shared';
import { campfireNear } from './campfire';
import type { Ctx } from './ctx';
import { invCount } from './expedition';

/** いる場所の置き場（階段の上なら階段が先。火は上か隣）。シーズンのランの主の枝だけ */
export function supplyPlaceOf(ctx: Ctx, e: Entity): { depth: number; x: number; y: number; place: SupplyPlace } | null {
  const p = e.pos;
  if (!p || !ctx.world.season) return null;
  const f = ctx.world.floors[p.floor];
  if (!f || f.branch !== 'main') return null;
  const tr = ctx.terrainAt(p.floor, p.x, p.y);
  if (tr.stairs) return { depth: f.depth, x: p.x, y: p.y, place: tr.stairs === 'up' ? 'stairs_up' : 'stairs_down' };
  const fire = campfireNear(ctx, e);
  return fire?.pos ? { depth: f.depth, x: fire.pos.x, y: fire.pos.y, place: 'fire' } : null;
}

function invItem(ctx: Ctx, e: Entity, slot: string): Entity | undefined {
  for (const id of e.inv?.items ?? []) {
    const it = ctx.world.entities[id];
    if (it?.item?.slot === slot) return it;
  }
  return undefined;
}

function freeSlot(ctx: Ctx, e: Entity): string | null {
  const used = new Set((e.inv?.items ?? []).map((id) => ctx.world.entities[id]?.item?.slot));
  for (let c = 97; c <= 122; c++) if (!used.has(String.fromCharCode(c))) return String.fromCharCode(c);
  return null;
}

const notPlace = (L: PlayerRecord['locale']): ActionError => actionError('cannot_use',
  t(L, '補給の置き場は、上り階段・下り階段のマスと、野営の火（火の上か隣）だけ。', 'Supply caches are only on stairs (up or down) and at campfires (on or next to one).'),
  t(L, '階段の上か、火のそばへ行ってから。', 'Go onto stairs or next to a campfire first.'));

/** 預けられるか（S3 §25.2）。手番を使わずに断るときは理由 */
export function depositCheck(ctx: Ctx, e: Entity, pr: PlayerRecord, slot: string): { item: Entity; at: NonNullable<ReturnType<typeof supplyPlaceOf>> } | { error: ActionError } {
  const L = pr.locale;
  const s = ctx.world.season;
  if (!ctx.world.meta.season || !s) return { error: actionError('bad_request', t(L, '補給の置き場は、シーズンのランだけ。', 'Supply caches exist only in season runs.'), '') };
  const at = supplyPlaceOf(ctx, e);
  if (!at) return { error: notPlace(L) };
  const it = invItem(ctx, e, slot);
  if (!it) return { error: actionError('no_such_item', t(L, `スロット ${slot} にアイテムは無い。`, `No item in slot ${slot}.`), t(L, 'inventory で所持品のスロットを確認する。', 'Check slots with inventory.')) };
  const def = ctx.content.items[it.kind];
  if (!def || def.bound || !SUPPLY_CATEGORIES.includes(def.category)) {
    return { error: actionError('cannot_use', t(L, '預けられるのは、消耗品（薬・巻物・投げる武器）だけ。装備・遺物・宝・鍵・帰還の綱は預けられない。', 'Only consumables (potions, scrolls, throwing weapons) can be deposited; not gear, relics, treasure, keys or the lifeline.'), t(L, '薬・巻物・投げる武器のスロットを選ぶ。', 'Pick a potion, scroll or throwing weapon.')) };
  }
  // 接辞・呪いの付いた品は預けない（S3a §27.9 の 5: 預けて取り返すと呪いが消える道をふさぐ。今の消耗品には付かない）
  if ((it.item?.affixes ?? []).length || (it.item?.hidden ?? []).length) {
    return { error: actionError('cannot_use', t(L, '接辞や呪いの付いた品は、預けられない。', 'Items with affixes or curses cannot be deposited.'), t(L, 'ほかの品を選ぶ。', 'Pick another item.')) };
  }
  const cap = ctx.content.balance.season.supplyCap;
  const n = cacheAt(s, at.depth, at.x, at.y).length;
  if (n >= cap) return { error: actionError('cannot_use', t(L, `この置き場（${supplyPlaceName(L, at.place)}）は、もういっぱい（${n}/${cap}）。`, `This cache (${supplyPlaceName(L, at.place)}) is full (${n}/${cap}).`), t(L, 'ほかの置き場に預ける。', 'Deposit at another cache.')) };
  return { item: it, at };
}

/** 預ける（1 手番）: 持ち物から 1 つ減らし（重ねた品は 1 つずつ）、このランで預けた品に足す。共有層へ載るのはキャンプに着いたとき（サーバー） */
export function depositSupply(ctx: Ctx, e: Entity, pr: PlayerRecord, it: Entity, at: NonNullable<ReturnType<typeof supplyPlaceOf>>): void {
  const me = ctx.world.entities[e.id];
  const key = me.pos!.floor;
  const s = ctx.world.season!;
  const app = ctx.world.secret.appearances[it.kind] ?? null;
  const identified = app === null || ctx.world.players[pr.id].knowledge.identified.includes(it.kind);
  const n = Math.max(0, ...(s.deposited ?? []).map((d) => d.n)) + 1;
  const no = currentExpedition(ctx.world)?.no ?? 0;
  const depositedAfter = [...(s.deposited ?? []).map((d) => ({ ...d })), { n, no, depth: at.depth, x: at.x, y: at.y, place: at.place, kind: it.kind, identified }];
  const body = { type: 'supply_deposited' as const, player: pr.id, depth: at.depth, x: at.x, y: at.y, place: at.place, n, kind: it.kind, appearanceId: app, identified, depositedAfter, seenBy: [pr.id], floor: key };
  if ((it.item?.qty ?? 1) > 1) {
    const stack = structuredClone(it);
    stack.item!.qty -= 1;
    ctx.emit({ ...body, put: [stack] });
  } else {
    const actor = structuredClone(me);
    actor.inv!.items = actor.inv!.items.filter((x) => x !== it.id);
    ctx.emit({ ...body, put: [actor], del: [it.id] });
  }
}

/** 取れるか（S3 §25.2）。id を省けるのは、置き場に品が 1 つだけのとき */
export function takeCheck(ctx: Ctx, e: Entity, pr: PlayerRecord, id: string | undefined): { pick: ReturnType<typeof cacheAt>[number]; at: NonNullable<ReturnType<typeof supplyPlaceOf>> } | { error: ActionError } {
  const L = pr.locale;
  const s = ctx.world.season;
  if (!ctx.world.meta.season || !s) return { error: actionError('bad_request', t(L, '補給の置き場は、シーズンのランだけ。', 'Supply caches exist only in season runs.'), '') };
  const at = supplyPlaceOf(ctx, e);
  if (!at) return { error: notPlace(L) };
  const no = currentExpedition(ctx.world)?.no ?? null;
  const per = ctx.content.balance.season.supplyTakesPerExpedition;
  // 遠征の外では取れない（上限を見られない所は、断る側に倒す。S3a §27.9 の 5）
  if (no === null) return { error: actionError('cannot_use', t(L, '遠征の外では、置き場から取れない。', 'You cannot take from a cache outside an expedition.'), '') };
  if (supplyTakenThis(s, no) && (s.taken ?? []).filter((x) => x.no === no).length >= per) {
    return { error: actionError('cannot_use', t(L, `この遠征では、もう置き場から ${per} つ取った（1 回の遠征で、どの置き場からも合わせて ${per} つまで）。`, `You have already taken ${per} item(s) from caches this expedition (${per} per expedition, from any cache).`), t(L, '次の遠征で。預けるのはできる。', 'Next expedition. You can still deposit.')) };
  }
  const items = cacheAt(s, at.depth, at.x, at.y);
  if (!items.length) return { error: actionError('nothing_here', t(L, `この置き場（${supplyPlaceName(L, at.place)}）には、預けられた品が無い。`, `Nothing has been deposited in this cache (${supplyPlaceName(L, at.place)}).`), t(L, '預けられた品は、取り込み（キャンプ・遠征の始め）で届く。', 'Deposits by others arrive with the sync at camp or when an expedition starts.')) };
  const pick = id ? items.find((x) => x.id === id) : items.length === 1 ? items[0] : undefined;
  if (!pick) {
    return { error: actionError('bad_request', id ? t(L, `この置き場に ${id} は無い（あるのは ${items.map((x) => x.id).join('・')}）。`, `No ${id} in this cache (it holds ${items.map((x) => x.id).join(', ')}).`) : t(L, `この置き場には品が ${items.length} つある。id で選ぶ（${items.map((x) => x.id).join('・')}）。`, `This cache holds ${items.length} items; pick one by id (${items.map((x) => x.id).join(', ')}).`), t(L, 'take_supply { id }（observe の season.supply の items）。', 'take_supply { id } (see season.supply.items in observe).')) };
  }
  const me = ctx.world.entities[e.id];
  const stack = ctx.content.items[pick.kind]?.stack && (me.inv?.items ?? []).some((x) => ctx.world.entities[x]?.kind === pick.kind && !(ctx.world.entities[x]?.item?.affixes ?? []).length);
  if (!stack && (invCount(ctx, me) >= me.inv!.capacity || freeSlot(ctx, me) === null)) {
    return { error: actionError('inventory_full', t(L, '所持品がいっぱいだ。', 'Your inventory is full.'), t(L, 'drop か deposit_supply で何かを手放してから取る。', 'Free a slot with drop or deposit_supply first.')) };
  }
  return { pick, at };
}

/** 取る（1 手番）: 持ち物に作り、このランで取った品に足す。鑑定済みで預けられた品なら、取った者も種類を知る。共有層から消えるのはキャンプに着いたとき（サーバー） */
export function takeSupply(ctx: Ctx, e: Entity, pr: PlayerRecord, pick: ReturnType<typeof cacheAt>[number], at: NonNullable<ReturnType<typeof supplyPlaceOf>>): void {
  const key = ctx.world.entities[e.id].pos!.floor;
  const app = ctx.world.secret.appearances[pick.kind] ?? null;
  if (pick.identified && app !== null && !ctx.world.players[pr.id].knowledge.identified.includes(pick.kind)) {
    ctx.emit({ type: 'item_identified', player: pr.id, kind: pick.kind, appearanceId: app, seenBy: [pr.id], floor: key });
  }
  const me = ctx.world.entities[e.id];
  const s = ctx.world.season!;
  const no = currentExpedition(ctx.world)?.no ?? 0;
  const takenAfter = [...(s.taken ?? []).map((x) => ({ ...x })), { no, id: pick.id, depth: pick.depth, x: pick.x, y: pick.y, place: pick.place, kind: pick.kind, identified: pick.identified, by: pick.by }];
  const base = { type: 'supply_taken' as const, player: pr.id, depth: at.depth, x: at.x, y: at.y, place: at.place, id: pick.id, kind: pick.kind, appearanceId: app, by: pick.by, takenAfter, seenBy: [pr.id], floor: key };
  const stackWith = ctx.content.items[pick.kind]?.stack ? (me.inv?.items ?? []).map((x) => ctx.world.entities[x]).find((x) => x?.kind === pick.kind && !(x.item?.affixes ?? []).length) : undefined;
  if (stackWith) {
    const merged = structuredClone(stackWith);
    merged.item!.qty += 1;
    ctx.emit({ ...base, slot: stackWith.item!.slot!, put: [merged] });
    return;
  }
  const slot = freeSlot(ctx, me)!;
  const id = ctx.newEntityId();
  const held: Entity = { id, kind: pick.kind, sid: ctx.nextSid(), item: { qty: 1, affixes: [], heldBy: e.id, slot } };
  const actor = structuredClone(me);
  actor.inv!.items.push(id);
  ctx.emit({ ...base, slot, put: [held, actor] });
}

// プレイヤーの基本行動。各ハンドラは「検証（イベント無し）→ 実行」の二段。
// 不正なコマンドはイベントを出さず時間も消費しない（ActionError を返す）。
import type { ActionError, Command, Entity, EquipSlot, PlayerRecord, Pos } from '@muse/shared';
import { actionError, cheb, currentExpedition, diceMax, DIR_VEC, DIRS, EQUIP_SLOTS, stepPos, t } from '@muse/shared';
import { endRun, grantXp, isHelpless, isUnaware, melee, recordHit, rollToHit, applyDamage, checkRunEnd } from './combat';
import {
  abilityHandlers, abilityReadyError, abilityState, attackCostOf, choosePerk, cursedSlot, gearOf, inspectItem, isCursed, markAbilityUsed,
  notePerk, perkHook, perkHookSum, perkWithHook, reachLine, reachOf, resolveAbilityId, thrownAccOf, thrownPierceOf,
} from './build';
import { armorOf, guardianCritIfUnaware, guardianIncoming, markGuardiansAway, noteTrial, restGuardians } from './guardians';
import { boonHook } from './boons';
import { chooseBoon, sealedFloor } from './warden';
import { huntingInView } from './expedition';
import { addStatus } from './statuses';
import type { Ctx } from './ctx';
import { applyEffects } from './effects';
import { doExtract, extractError, invCount, maybeEndExpedition } from './expedition';
import { ensureFloor, findFreeCell } from './floors';
import { line } from './geom';
import { makeNoise, shotClear, shotLine, updateKnowledge, wakeMonster } from './perception';
import { hasStatus, removeStatus } from './statuses';
import { Registry, roll } from './registry';
import { regenTick } from './scheduler';
import { recomputeStats } from './stats';
import { spawnFromSpec } from './spawn';
import { campfireCheck, placeFire, placeFireCheck, startFireReturn, useCampfire } from './campfire';
import { depositCheck, depositSupply, takeCheck, takeSupply } from './supply';

export interface ActionOutcome { cost: number; scheduled?: boolean }
export type Prepared = { error: ActionError } | { run: () => ActionOutcome };
export type ActionHandler = (ctx: Ctx, e: Entity, pr: PlayerRecord, cmd: any) => Prepared;

export const actions = new Registry<ActionHandler>('action');

const fail = (pr: PlayerRecord, code: ActionError['code'], ja: string, en: string, hja: string, hen: string): Prepared =>
  ({ error: actionError(code, t(pr.locale, ja, en), t(pr.locale, hja, hen)) });

function invItem(ctx: Ctx, e: Entity, slot: string): Entity | undefined {
  for (const id of e.inv?.items ?? []) {
    const it = ctx.world.entities[id];
    if (it?.item?.slot === slot) return it;
  }
  return undefined;
}

function equippedSlotOf(e: Entity, itemId: string): EquipSlot | null {
  for (const s of EQUIP_SLOTS) if (e.equip?.[s] === itemId) return s;
  return null;
}

function freeSlot(ctx: Ctx, e: Entity): string | null {
  const used = new Set((e.inv?.items ?? []).map((id) => ctx.world.entities[id]?.item?.slot));
  for (let c = 97; c <= 122; c++) {
    const s = String.fromCharCode(c);
    if (!used.has(s)) return s;
  }
  return null;
}

function appearanceOf(ctx: Ctx, kind: string): string | null {
  return ctx.world.secret.appearances[kind] ?? null;
}

function selfSeen(ctx: Ctx, e: Entity) {
  return ctx.perceive(e.pos!.floor, [{ field: 'actor', pos: e.pos, entity: e.id }], [e.player!]);
}

/** 罠を作動させる */
export function triggerTrap(ctx: Ctx, victim: Entity, trap: Entity): void {
  const key = trap.pos!.floor;
  const def = ctx.content.features[trap.kind];
  const pos = { x: trap.pos!.x, y: trap.pos!.y };
  ctx.emit({ type: 'trap_triggered', trap: trap.id, kind: trap.kind, by: victim.id, byKind: victim.kind, pos, ...ctx.perceive(key, [{ field: 'by', pos, entity: victim.id }], victim.player ? [victim.player] : []), floor: key });
  for (const pid of ctx.seersOf(key, pos)) {
    if (!ctx.world.entities[trap.id].trap!.revealedTo.includes(pid)) {
      ctx.emit({ type: 'trap_revealed', trap: trap.id, kind: trap.kind, player: pid, pos, seenBy: [pid], floor: key });
    }
  }
  applyEffects(ctx, def?.onEnter ?? [], { user: null, target: victim, pos, source: null, via: 'trap' });
}

/** レバーを引く（V3-5 §5.2）: つないだ格子扉を閉じる・開ける（閉じるマスに者か物があれば、そのマスは開いたまま） */
function pullLever(ctx: Ctx, e: Entity, lever: Entity): void {
  const key = lever.pos!.floor;
  const closed = ctx.world.meta.terrainTable.indexOf('core:grate_closed');
  const open = ctx.world.meta.terrainTable.indexOf('core:grate_open');
  const down = lever.feature!.state !== 'down';
  ctx.emit({ type: 'feature_state', id: lever.id, kind: lever.kind, state: down ? 'down' : 'up', ...ctx.perceive(key, [{ field: 'id', pos: lever.pos }], e.player ? [e.player] : []), floor: key });
  for (const q of lever.links ?? []) {
    const cur = ctx.terrainAt(key, q.x, q.y);
    if (down && cur.id === 'core:grate_open' && !ctx.actorAt(key, q.x, q.y) && !ctx.itemsAt(key, q.x, q.y).length) ctx.emit({ type: 'tile_changed', x: q.x, y: q.y, terrain: closed, reason: 'lever', by: e.id, ...ctx.tileSeen(key, q, e), floor: key });
    else if (!down && cur.id === 'core:grate_closed') ctx.emit({ type: 'tile_changed', x: q.x, y: q.y, terrain: open, reason: 'lever', by: e.id, ...ctx.tileSeen(key, q, e), floor: key });
  }
  makeNoise(ctx, key, lever.pos!, 4, e);
}

/** 胞子嚢が弾ける（V3-5 §5.2）: radius マスの者を毒にし、通れるマスに毒の雲を turns 手番残す */
export function burstPod(ctx: Ctx, pod: Entity): void {
  const def = ctx.content.features[pod.kind]?.burst;
  if (!def || !pod.pos || pod.feature?.state === 'burst') return;
  const key = pod.pos.floor;
  const at = { x: pod.pos.x, y: pod.pos.y };
  ctx.emit({ type: 'feature_state', id: pod.id, kind: pod.kind, state: 'burst', ...ctx.perceive(key, [{ field: 'id', pos: at }], []), floor: key });
  const f = ctx.world.floors[key];
  const cloudDef = ctx.content.features[def.cloud];
  for (let y = at.y - def.radius; y <= at.y + def.radius; y++) for (let x = at.x - def.radius; x <= at.x + def.radius; x++) {
    if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
    const v = ctx.actorAt(key, x, y);
    if (v && cloudDef) applyEffects(ctx, cloudDef.onEnter, { user: null, target: v, pos: { x, y }, source: null, via: 'feature' });
    if ((x === at.x && y === at.y) || !ctx.terrainAt(key, x, y).passable || ctx.featureAt(key, x, y)) continue;
    const c = spawnFromSpec(ctx, key, { type: 'feature', kind: def.cloud, x, y }, 'burst');
    const body = structuredClone(c);
    body.feature!.expiresAt = f.time + def.turns * 100;
    ctx.emit({ type: 'feature_state', id: c.id, kind: c.kind, state: c.feature!.state, put: [body], seenBy: [], floor: key });
  }
}

function openDoor(ctx: Ctx, e: Entity, p: Pos): void {
  const key = e.pos!.floor;
  const open = ctx.world.meta.terrainTable.indexOf('core:door_open');
  ctx.emit({ type: 'tile_changed', x: p.x, y: p.y, terrain: open, reason: 'door_open', by: e.id, ...ctx.tileSeen(key, p, e), floor: key });
  makeNoise(ctx, key, p, 3, e);
}

actions.register('move', (ctx, e, pr, cmd: Extract<Command, { type: 'move' }>) => {
  const key = e.pos!.floor;
  const f = ctx.world.floors[key];
  const to = stepPos(e.pos!, cmd.dir);
  if (to.x < 0 || to.y < 0 || to.x >= f.width || to.y >= f.height) return fail(pr, 'blocked', 'そちらはフロアの外だ。', 'That is outside the floor.', '別の方向を選ぶ（observe の passable_dirs）。', 'Pick another direction (see passable_dirs).');
  const occ = ctx.actorAt(key, to.x, to.y);
  if (occ && occ.player) {
    return {
      run: () => {
        const a = { x: e.pos!.x, y: e.pos!.y };
        ctx.emit({ type: 'entity_moved', id: e.id, kind: e.kind, from: a, to, mode: 'swap', ...ctx.perceiveMove(key, e, a, to, [e.player!]), floor: key });
        ctx.emit({ type: 'entity_moved', id: occ.id, kind: occ.kind, from: to, to: a, mode: 'swap', ...ctx.perceiveMove(key, occ, to, a, [occ.player!]), floor: key });
        return { cost: 100 };
      },
    };
  }
  // 武器の「速い」は攻撃の手番コストが下がる（V3-4 §4.4）
  if (occ) return { run: () => { melee(ctx, e, occ); return { cost: attackCostOf(ctx, e) }; } };
  const tr = ctx.terrainAt(key, to.x, to.y);
  if (tr.door === 'closed') return { run: () => { openDoor(ctx, e, to); return { cost: 100 }; } };
  // 押せる本棚（V3-5 §5.2 沈んだ書庫）: 向こうのマスが空いた床なら押して進む（手番 150）
  if (tr.tags.includes('pushable')) {
    const beyond = stepPos(to, cmd.dir);
    const bt = beyond.x >= 0 && beyond.y >= 0 && beyond.x < f.width && beyond.y < f.height ? ctx.terrainAt(key, beyond.x, beyond.y) : null;
    const free = !!bt && bt.passable && !bt.stairs && !bt.door && !ctx.actorAt(key, beyond.x, beyond.y) && !ctx.itemsAt(key, beyond.x, beyond.y).length && !ctx.featureAt(key, beyond.x, beyond.y);
    if (!free) return fail(pr, 'blocked', `${t(pr.locale, tr.name.ja, tr.name.en)}の向こうがふさがっていて押せない。`, `Something behind the ${tr.name.en} keeps it from moving.`, '別の向きから押すか、回り道する。', 'Push from another side or go around.');
    return {
      run: () => {
        const floorIdx = ctx.world.meta.terrainTable.indexOf('core:floor');
        const shelfIdx = f.terrain[to.y * f.width + to.x];
        ctx.emit({ type: 'tile_changed', x: beyond.x, y: beyond.y, terrain: shelfIdx, reason: 'push', by: e.id, ...ctx.tileSeen(key, beyond, e), floor: key });
        ctx.emit({ type: 'tile_changed', x: to.x, y: to.y, terrain: floorIdx, reason: 'push', by: e.id, ...ctx.tileSeen(key, to, e), floor: key });
        const from = { x: e.pos!.x, y: e.pos!.y };
        ctx.emit({ type: 'entity_moved', id: e.id, kind: e.kind, from, to, mode: 'walk', ...ctx.perceiveMove(key, e, from, to, [e.player!]), floor: key });
        makeNoise(ctx, key, to, 4, e);
        return { cost: 150 };
      },
    };
  }
  if (!tr.passable) {
    return fail(pr, 'blocked', `${t(pr.locale, tr.name.ja, tr.name.en)}があって進めない。`, `A ${tr.name.en} blocks the way.`, 'observe の navigation.passable_dirs から選ぶか、explore / travel_to を使う。', 'Choose from navigation.passable_dirs, or use explore / travel_to.');
  }
  return {
    run: () => {
      const from = { x: e.pos!.x, y: e.pos!.y };
      ctx.emit({ type: 'entity_moved', id: e.id, kind: e.kind, from, to, mode: 'walk', ...ctx.perceiveMove(key, e, from, to, [e.player!]), floor: key });
      const trap = ctx.featureAt(key, to.x, to.y);
      if (trap?.trap) triggerTrap(ctx, ctx.world.entities[e.id], trap);
      // 入ると効果のある地物（毒の雲。V3-5 §5.2）
      else if (trap?.feature && ctx.content.features[trap.kind]?.onEnter.length) applyEffects(ctx, ctx.content.features[trap.kind].onEnter, { user: null, target: ctx.world.entities[e.id], pos: to, source: null, via: 'feature' });
      // 自分が投げた物は、移動の一部として拾う（追加の手番なし。入らなければ拾わない）。回収の手なら隣のマスからも
      const me = ctx.world.entities[e.id];
      if (me?.pos && ctx.world.players[pr.id].state === 'alive') {
        const cells = perkHook(ctx, me, 'collect_adjacent') ? [null, ...DIRS] : [null];
        const mine = cells.flatMap((d) => ctx.itemsAt(key, me.pos!.x + (d ? DIR_VEC[d][0] : 0), me.pos!.y + (d ? DIR_VEC[d][1] : 0))).filter((it) => it.item?.thrownBy === pr.id);
        // 隣のマスから拾った分（回収の手が効いた。V3-4b §28.6）
        const fromNext = mine.filter((it) => it.pos && (it.pos.x !== me.pos!.x || it.pos.y !== me.pos!.y)).reduce((a, it) => a + (it.item?.qty ?? 1), 0);
        if (mine.length) { pickUpItems(ctx, me, mine, true); updateKnowledge(ctx, key); }
        if (fromNext > 0) notePerk(ctx, ctx.world.entities[me.id] ?? me, perkWithHook(ctx, me, 'collect_adjacent'), 'picked', { amount: fromNext });
      }
      // 重い鎧は歩く手番のコストが増える（V3-4 §14.5）。浅い水などは地形の倍率も掛かる（V3-5 §5.2）
      return { cost: Math.trunc((gearOf(ctx, ctx.world.entities[e.id] ?? e).moveCost * tr.moveCostPct) / 100) };
    },
  };
});

actions.register('wait', (ctx, e, pr) => ({
  run: () => {
    // 盾の構え: 追跡中の敵が見えているときの待機は、次の自分の手番までに受ける最初の一撃の装甲を上げる（V3-4 §4.1）
    const h = perkHook(ctx, e, 'brace');
    if (h && huntingInView(ctx, pr)) addStatus(ctx, ctx.world.entities[e.id], 'core:braced', 1, h.armor ?? 2, e.id);
    return { cost: 100 };
  },
}));

actions.register('pickup', (ctx, e, pr, cmd: Extract<Command, { type: 'pickup' }>) => {
  const key = e.pos!.floor;
  let items = ctx.itemsAt(key, e.pos!.x, e.pos!.y);
  if (cmd.item) items = items.filter((i) => i.id === cmd.item);
  // 引数なし: 足元にほかの品があれば、自分の置いた品は拾い直さない（S1c §14.4 の 6: 捨てたばかりの品を拾い直した）。置いた品だけなら拾う
  else if (items.some((i) => i.item?.droppedBy !== pr.id)) items = items.filter((i) => i.item?.droppedBy !== pr.id);
  if (!items.length) return fail(pr, 'nothing_here', '足元に拾えるものは無い。', 'There is nothing here to pick up.', 'visible.items の位置へ travel_to してから pickup する。', 'travel_to an item in visible.items first.');
  const canTakeAny = items.some((it) => {
    const def = ctx.content.items[it.kind];
    const stack = def?.stack && (e.inv?.items ?? []).some((id) => {
      const x = ctx.world.entities[id];
      return x?.kind === it.kind && JSON.stringify(x.item?.affixes) === JSON.stringify(it.item?.affixes);
    });
    return stack || (invCount(ctx, e) < e.inv!.capacity && freeSlot(ctx, e) !== null);
  });
  if (!canTakeAny) return fail(pr, 'inventory_full', '所持品がいっぱいだ。', 'Your inventory is full.', 'drop で何かを置いてから拾う。', 'drop something first.');
  return {
    run: () => {
      pickUpItems(ctx, e, items, false);
      updateKnowledge(ctx, key);
      return { cost: 100 };
    },
  };
});

/** 足元のアイテムを所持品へ（重ねられるものは重ねる。入らなければそこで止める）。拾った数を返す */
export function pickUpItems(ctx: Ctx, e: Entity, items: Entity[], auto: boolean): number {
  let n = 0;
  for (const it0 of items) {
    const me = ctx.world.entities[e.id];
    const it = ctx.world.entities[it0.id];
    if (!me?.pos || !it?.pos) continue;
    const key = me.pos.floor;
    const def = ctx.content.items[it.kind];
    const stackWith = def?.stack ? (me.inv?.items ?? []).map((id) => ctx.world.entities[id]).find((x) => x?.kind === it.kind && JSON.stringify(x.item?.affixes) === JSON.stringify(it.item?.affixes)) : undefined;
    const base = {
      type: 'item_picked_up' as const, actor: e.id, item: it.id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), qty: it.item!.qty,
      affixes: [...it.item!.affixes], ...(auto ? { auto: true } : {}), ...selfSeen(ctx, me), floor: key,
    };
    if (stackWith) {
      const merged = structuredClone(stackWith);
      merged.item!.qty += it.item!.qty;
      ctx.emit({ ...base, slot: stackWith.item!.slot!, put: [merged], del: [it.id] });
      n++;
      continue;
    }
    const slot = freeSlot(ctx, me);
    if (!slot || invCount(ctx, me) >= me.inv!.capacity) break;
    const held = structuredClone(it);
    delete held.pos;
    held.item!.heldBy = e.id;
    held.item!.slot = slot;
    delete held.item!.thrownBy;
    delete held.item!.droppedBy;
    const actor = structuredClone(me);
    actor.inv!.items.push(it.id);
    ctx.emit({ ...base, slot, put: [held, actor] });
    n++;
    // 遺物を拾うと、その階の眠っている・気づいていない敵が目を覚まし、遺物の場所へ向かう（公開ルール）
    if (it.role === 'relic') {
      for (const m of ctx.entitiesOn(key)) {
        if (!m.actor?.ai || m.player || !m.pos) continue;
        if (hasStatus(m, 'core:sleep')) removeStatus(ctx, m, 'core:sleep');
        wakeMonster(ctx, ctx.world.entities[m.id], { x: me.pos.x, y: me.pos.y });
      }
    }
  }
  return n;
}

function unequipEvents(ctx: Ctx, e: Entity, slotName: EquipSlot): void {
  const me = ctx.world.entities[e.id];
  const id = me.equip?.[slotName];
  if (!id) return;
  const it = ctx.world.entities[id];
  const actor = structuredClone(me);
  delete actor.equip![slotName];
  ctx.emit({ type: 'item_unequipped', actor: e.id, item: id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), slotName, affixes: [...(it.item?.affixes ?? [])], put: [actor], ...selfSeen(ctx, me), floor: me.pos!.floor });
  recomputeStats(ctx, ctx.world.entities[e.id], 'unequip');
}

actions.register('drop', (ctx, e, pr, cmd: Extract<Command, { type: 'drop' }>) => {
  const it = invItem(ctx, e, cmd.slot);
  if (!it) return fail(pr, 'no_such_item', `スロット ${cmd.slot} にアイテムは無い。`, `No item in slot ${cmd.slot}.`, 'inventory で所持品のスロットを確認する。', 'Check slots with inventory.');
  if (ctx.content.items[it.kind]?.bound) return fail(pr, 'cannot_use', 'それは手放せない。', 'You cannot let go of that.', '帰還の綱は所持数に数えない。使うなら use_item。', 'The lifeline does not count toward capacity. Use it with use_item.');
  if (equippedSlotOf(e, it.id) && isCursed(ctx, it)) return cursedFail(pr);
  return {
    run: () => {
      const eq = equippedSlotOf(ctx.world.entities[e.id], it.id);
      if (eq) unequipEvents(ctx, e, eq);
      const me = ctx.world.entities[e.id];
      const key = me.pos!.floor;
      const qty = Math.min(cmd.qty ?? it.item!.qty, it.item!.qty);
      const pos = { x: me.pos!.x, y: me.pos!.y };
      const base = { type: 'item_dropped' as const, actor: e.id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), qty, pos, affixes: [...it.item!.affixes], ...selfSeen(ctx, me), floor: key };
      if (qty < it.item!.qty) {
        const stack = structuredClone(it);
        stack.item!.qty -= qty;
        const id = ctx.newEntityId();
        const piece: Entity = { id, kind: it.kind, sid: ctx.nextSid(), pos: { floor: key, ...pos }, item: { qty, affixes: [...it.item!.affixes], droppedBy: pr.id } };
        ctx.emit({ ...base, item: id, put: [stack, piece] });
      } else {
        const dropped = structuredClone(it);
        delete dropped.item!.heldBy;
        delete dropped.item!.slot;
        dropped.item!.droppedBy = pr.id;
        dropped.pos = { floor: key, ...pos };
        const actor = structuredClone(me);
        actor.inv!.items = actor.inv!.items.filter((x) => x !== it.id);
        ctx.emit({ ...base, item: it.id, put: [dropped, actor] });
      }
      updateKnowledge(ctx, key);
      return { cost: 100 };
    },
  };
});

actions.register('equip', (ctx, e, pr, cmd: Extract<Command, { type: 'equip' }>) => {
  const it = invItem(ctx, e, cmd.slot);
  if (!it) return fail(pr, 'no_such_item', `スロット ${cmd.slot} にアイテムは無い。`, `No item in slot ${cmd.slot}.`, 'inventory で確認する。', 'Check with inventory.');
  const def = ctx.content.items[it.kind];
  if (!def?.equip) return fail(pr, 'cannot_use', 'それは装備できない。', 'You cannot equip that.', '武器・防具を選ぶ。薬や巻物は use_item。', 'Pick a weapon or armor. Use use_item for potions and scrolls.');
  if (equippedSlotOf(e, it.id)) return fail(pr, 'cannot_use', 'それは既に装備している。', 'Already equipped.', '別のアイテムを選ぶ。', 'Choose another item.');
  // 呪われた装備は外せないので、同じ場所に別の品も付けられない（V3-4 §4.4）
  if (cursedSlot(ctx, e, def.equip.slot)) return cursedFail(pr);
  // 呪いと分かっている品は確認してから付ける（V3-8 §53.4）
  if (isCursed(ctx, it) && !cmd.confirm) return fail(pr, 'confirm_required', 'その品は呪われている（装備すると、解呪するまで外せない）。', 'That item is cursed (once equipped it will not come off until the curse is lifted).', 'それでも付けるなら equip { slot, confirm: true }。', 'To wear it anyway, equip { slot, confirm: true }.');
  return {
    run: () => {
      const slotName = def.equip!.slot;
      if (ctx.world.entities[e.id].equip?.[slotName]) unequipEvents(ctx, e, slotName);
      const me = ctx.world.entities[e.id];
      const actor = structuredClone(me);
      actor.equip = { ...(actor.equip ?? {}), [slotName]: it.id };
      ctx.emit({ type: 'item_equipped', actor: e.id, item: it.id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), slotName, affixes: [...(it.item?.affixes ?? [])], put: [actor], ...selfSeen(ctx, me), floor: me.pos!.floor });
      // 装備すると正体（装飾品）と呪いの有無が分かる（呪われていれば外せなくなる。V3-4 §4.4）
      if (appearanceOf(ctx, it.kind) && !ctx.world.players[pr.id].knowledge.identified.includes(it.kind)) {
        ctx.emit({ type: 'item_identified', player: pr.id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), seenBy: [pr.id], floor: me.pos!.floor });
      }
      inspectItem(ctx, ctx.world.entities[e.id], ctx.world.entities[it.id], 'equip');
      recomputeStats(ctx, ctx.world.entities[e.id], 'equip');
      return { cost: 100 };
    },
  };
});

function cursedFail(pr: PlayerRecord): Prepared {
  return fail(pr, 'cannot_use', '呪われていて外せない。', 'It is cursed and will not come off.', '解呪の巻物か祭壇で呪いを解く。', 'Lift the curse with a scroll of remove curse or an altar.');
}

actions.register('unequip', (ctx, e, pr, cmd: Extract<Command, { type: 'unequip' }>) => {
  let slotName: EquipSlot | null = null;
  if ((EQUIP_SLOTS as readonly string[]).includes(cmd.slot)) slotName = cmd.slot as EquipSlot;
  else {
    const it = invItem(ctx, e, cmd.slot);
    if (it) slotName = equippedSlotOf(e, it.id);
  }
  if (!slotName || !e.equip?.[slotName]) return fail(pr, 'no_such_item', 'それは装備していない。', 'That is not equipped.', 'inventory で装備中のアイテムを確認する。', 'Check equipped items with inventory.');
  if (cursedSlot(ctx, e, slotName)) return cursedFail(pr);
  const sn = slotName;
  return { run: () => { unequipEvents(ctx, e, sn); return { cost: 100 }; } };
});

actions.register('use', (ctx, e, pr, cmd: Extract<Command, { type: 'use' }>) => {
  const it = invItem(ctx, e, cmd.slot);
  if (!it) return fail(pr, 'no_such_item', `スロット ${cmd.slot} にアイテムは無い。`, `No item in slot ${cmd.slot}.`, 'inventory で確認する。', 'Check with inventory.');
  const def = ctx.content.items[it.kind];
  if (!def || !def.onUse.length) {
    return fail(pr, 'cannot_use', 'それは使えない。', 'You cannot use that.', def?.equip ? '装備品は equip で装備する。' : def?.throw ? '投擲武器は throw_item で投げる。' : '別のアイテムを選ぶ。', def?.equip ? 'Equip it with equip.' : def?.throw ? 'Throw it with throw_item.' : 'Choose another item.');
  }
  // 帰還の綱は遠征の参加者だけが使える
  if (def.onUse.some((x) => x.effect === 'recall') && !currentExpedition(ctx.world)?.participants.includes(pr.id)) {
    return fail(pr, 'cannot_use', '進行中の遠征が無いので、帰還の綱は使えない。', 'There is no expedition to return from.', '', '');
  }
  // 鑑定の対象（target_slot）。手番を使う前に確かめる
  let identifySlot: string | undefined;
  if (cmd.targetSlot && def.onUse.some((x) => x.effect === 'identify')) {
    const tgt = invItem(ctx, e, cmd.targetSlot);
    if (!tgt) return fail(pr, 'no_such_item', `スロット ${cmd.targetSlot} にアイテムは無い。`, `No item in slot ${cmd.targetSlot}.`, 'inventory で確認する。', 'Check with inventory.');
    // 鑑定できるもの: 未鑑定の種類、または呪いの有無を確かめていない装備品（V3-4）
    const unknownKind = !!ctx.world.secret.appearances[tgt.kind] && !pr.knowledge.identified.includes(tgt.kind);
    const uninspected = !!ctx.content.items[tgt.kind]?.equip && !tgt.item?.inspected;
    if (!unknownKind && !uninspected) {
      return fail(pr, 'cannot_use', 'それは鑑定の必要が無い。', 'That needs no identification.', '未鑑定の品か、呪いの有無を確かめていない装備品のスロットを指定する。', 'Pick the slot of an unidentified item or of equipment whose curse is unchecked.');
    }
    identifySlot = cmd.targetSlot;
  }
  return {
    run: () => {
      const me = ctx.world.entities[e.id];
      const key = me.pos!.floor;
      const qtyAfter = it.item!.qty - 1;
      const put: Entity[] = [];
      const del: string[] = [];
      if (qtyAfter > 0) {
        const s = structuredClone(it);
        s.item!.qty = qtyAfter;
        put.push(s);
      } else {
        const actor = structuredClone(me);
        actor.inv!.items = actor.inv!.items.filter((x) => x !== it.id);
        put.push(actor);
        del.push(it.id);
      }
      ctx.emit({ type: 'item_used', actor: e.id, item: it.id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), category: def.category, qtyAfter, put, del, ...selfSeen(ctx, me), floor: key });
      applyEffects(ctx, def.onUse, { user: ctx.world.entities[e.id], target: ctx.world.entities[e.id], pos: { x: me.pos!.x, y: me.pos!.y }, source: me, via: 'item', ...(identifySlot ? { itemSlot: identifySlot } : {}), usedKind: it.kind });
      // 帰還の綱で盤面を離れた（即時）: 手番は doExtract が進めた
      if (!ctx.world.entities[e.id]?.pos) return { cost: 0, scheduled: true };
      const pNow = ctx.world.players[pr.id];
      if (appearanceOf(ctx, it.kind) && !pNow.knowledge.identified.includes(it.kind)) {
        ctx.emit({ type: 'item_identified', player: pr.id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), seenBy: [pr.id], floor: key });
      }
      return { cost: 100 };
    },
  };
});

/** 対象指定（方向・座標・エンティティ ID）→ 座標 */
function resolveTarget(ctx: Ctx, e: Entity, pr: PlayerRecord, target: unknown, range: number): Pos | ActionError {
  const key = e.pos!.floor;
  const f = ctx.world.floors[key];
  if (typeof target === 'string' && target in DIR_VEC) {
    const v = DIR_VEC[target as keyof typeof DIR_VEC];
    let p = { x: e.pos!.x, y: e.pos!.y };
    for (let i = 0; i < range; i++) {
      const n = { x: p.x + v[0], y: p.y + v[1] };
      if (!ctx.terrainAt(key, n.x, n.y).passable) break;
      p = n;
      if (ctx.actorAt(key, n.x, n.y)) break;
    }
    return p;
  }
  if (typeof target === 'string') {
    const te = ctx.world.entities[target];
    // 標的にできるのは見えている相手だけ（草の中の者は隣からだけ。V4-0c §4.2）
    if (!te?.pos || te.pos.floor !== key || !ctx.seesActorAt(pr.id, key, te.pos)) {
      return actionError('no_target', t(pr.locale, 'その対象は見えていない。', 'You cannot see that target.'), t(pr.locale, 'visible.monsters の id を指定する。', 'Use an id from visible.monsters.'));
    }
    // 射程外の対象（ID 指定）は拒否する。手番も品物も失わない（座標を狙えば手前に落ちる）
    if (line(e.pos!, te.pos).length > range) {
      return actionError('out_of_range', t(pr.locale, `射程（${range}）の外だ。`, `Out of range (${range}).`),
        t(pr.locale, '近づくか、visible.monsters の shots が clear の相手を選ぶ。', 'Move closer or pick a target whose shots entry is clear.'));
    }
    if (!shotClear(ctx, key, e.pos!, te.pos)) {
      return actionError('no_line_of_sight', t(pr.locale, 'そこまで投擲の経路が通っていない（壁か他の者に遮られる）。', 'No clear throwing line to that target (blocked by a wall or someone).'),
        t(pr.locale, 'visible.monsters の shot が clear の相手を選ぶか、位置を変える。', 'Pick a monster whose shot is clear, or move.'));
    }
    return { x: te.pos.x, y: te.pos.y };
  }
  const p = target as Pos;
  if (p.x < 0 || p.y < 0 || p.x >= f.width || p.y >= f.height) return actionError('out_of_range', t(pr.locale, '範囲外の座標だ。', 'Out of bounds.'), t(pr.locale, 'フロア内の座標を指定する。', 'Pick a position on this floor.'));
  // 座標を狙った投擲も、届かないときは先に拒否する（V3-3c §44.6: 護りの火を狙って「届かず」が続いた）
  if (line(e.pos!, p).length > range) {
    return actionError('out_of_range', t(pr.locale, `(${p.x},${p.y}) は射程（${range}）の外だ。`, `(${p.x},${p.y}) is out of range (${range}).`), t(pr.locale, '近づいてから投げる。', 'Move closer first.'));
  }
  if (!shotClear(ctx, key, e.pos!, p)) {
    return actionError('no_line_of_sight', t(pr.locale, `(${p.x},${p.y}) まで投擲の経路が通っていない（壁か他の者に遮られる）。`, `No clear throwing line to (${p.x},${p.y}) (blocked by a wall or someone).`), t(pr.locale, '位置を変えてから投げる。', 'Move to get a clear line first.'));
  }
  return { x: p.x, y: p.y };
}

actions.register('throw', (ctx, e, pr, cmd: Extract<Command, { type: 'throw' }>) => prepareThrow(ctx, e, pr, cmd.slot, cmd.target, {}));

export interface ThrowOpts {
  /** 命中の上乗せ（狙い撃ち） */
  accBonus?: number;
  /** 気づいていない・眠っている相手には会心（狙い撃ち） */
  critIfUnaware?: boolean;
  /** 実行の直前（能動技の使用を記録する） */
  before?: () => void;
}

/** 投擲の検証と実行（throw_item と狙い撃ち）。命中 = 品物の命中 + 習熟 + 装備（V3-4 §4.3） */
export function prepareThrow(ctx: Ctx, e: Entity, pr: PlayerRecord, slot: string, target: unknown, opts: ThrowOpts): Prepared {
  const cmd = { slot, target } as { slot: string; target: Extract<Command, { type: 'throw' }>['target'] };
  const it = invItem(ctx, e, cmd.slot);
  if (!it) return fail(pr, 'no_such_item', `スロット ${cmd.slot} にアイテムは無い。`, `No item in slot ${cmd.slot}.`, 'inventory で確認する。', 'Check with inventory.');
  if (equippedSlotOf(e, it.id)) return fail(pr, 'cannot_use', '装備中のものは投げられない。', 'You cannot throw an equipped item.', '先に unequip する。', 'unequip it first.');
  const def = ctx.content.items[it.kind];
  if (def?.bound) return fail(pr, 'cannot_use', 'それは投げられない。', 'You cannot throw that.', '帰還の綱は use_item で使う。', 'Use the lifeline with use_item.');
  const range = def?.throw?.range ?? 4;
  const tp = resolveTarget(ctx, e, pr, cmd.target, range);
  if ('code' in tp) return { error: tp };
  if (tp.x === e.pos!.x && tp.y === e.pos!.y) return fail(pr, 'no_target', '自分には投げられない。', 'You cannot throw at yourself.', '方向・座標・対象 ID を指定する。', 'Give a direction, position or target id.');
  return {
    run: () => {
      opts.before?.();
      const me = ctx.world.entities[e.id];
      const key = me.pos!.floor;
      const from = { x: me.pos!.x, y: me.pos!.y };
      // 経路は shots と同じ（双方向のうち通る方。どちらも通らなければ前向きの直線で、途中で遮られる）
      const full = shotLine(ctx, key, from, tp) ?? line(from, tp);
      const path = full.slice(0, range);
      let landed: Pos = from;
      let hitEnt: Entity | null = null;
      let wall = false;
      for (const p of path) {
        const tr = ctx.terrainAt(key, p.x, p.y);
        if (!tr.passable) { wall = true; break; }
        landed = p;
        const occ = ctx.actorAt(key, p.x, p.y);
        if (occ && occ.id !== me.id) { hitEnt = occ; break; }
      }
      let hit: Entity | null = null;
      let crit = false;
      if (hitEnt) {
        let o = rollToHit(ctx, me, hitEnt, (def?.throw?.acc ?? 0) + thrownAccOf(ctx, me) + (opts.accBonus ?? 0));
        // 狙い撃ち: 気づいていない・眠っている・朦朧（無防備）の相手には会心（V3-3b §40.1: 突進を外した突き進む者の「1 手無防備」）
        if (opts.critIfUnaware && (isUnaware(hitEnt) || isHelpless(ctx, hitEnt))) o = { hit: true, crit: true, roll: o.roll };
        // 眠りが深い守護者への、気づかれる前の一投は会心（V3-3）
        if (!o.crit && isUnaware(hitEnt) && hitEnt.guardian && guardianCritIfUnaware(ctx, hitEnt)) o = { hit: true, crit: true, roll: o.roll };
        if (o.hit && isUnaware(hitEnt) && hitEnt.guardian) noteTrial(ctx, hitEnt, 'unaware_hit');
        if (o.hit) { hit = hitEnt; crit = o.crit; }
        recordHit(ctx, me, hitEnt, o.hit, 'thrown');
      }
      // 結果の分類（文章で必ず伝える）
      const intended = typeof cmd.target === 'string' && cmd.target.startsWith('e_') ? cmd.target : (ctx.actorAt(key, tp.x, tp.y)?.id ?? null);
      let outcome: 'hit' | 'missed' | 'blocked' | 'fell_short' | 'no_target';
      let blockedBy: 'terrain' | 'actor' | null = null;
      if (hitEnt && intended && hitEnt.id !== intended) { outcome = 'blocked'; blockedBy = 'actor'; }
      else if (hitEnt) outcome = hit ? 'hit' : 'missed';
      else if (wall) { outcome = 'blocked'; blockedBy = 'terrain'; }
      else if (full.length > range) outcome = 'fell_short';
      else outcome = 'no_target';
      const broke = !!def?.shatter;
      const put: Entity[] = [];
      const del: string[] = [];
      let thrownId = it.id;
      if (it.item!.qty > 1) {
        const s = structuredClone(it);
        s.item!.qty -= 1;
        put.push(s);
        if (!broke) {
          thrownId = ctx.newEntityId();
          put.push({ id: thrownId, kind: it.kind, sid: ctx.nextSid(), pos: { floor: key, ...landed }, item: { qty: 1, affixes: [...it.item!.affixes], thrownBy: pr.id } });
        }
      } else {
        const actor = structuredClone(me);
        actor.inv!.items = actor.inv!.items.filter((x) => x !== it.id);
        put.push(actor);
        if (broke) del.push(it.id);
        else {
          const moved = structuredClone(it);
          delete moved.item!.heldBy;
          delete moved.item!.slot;
          moved.item!.thrownBy = pr.id;
          moved.pos = { floor: key, ...landed };
          put.push(moved);
        }
      }
      const seen = ctx.perceive(key, [
        { field: 'actor', pos: from, entity: me.id }, { field: 'from', pos: from, entity: me.id },
        { field: 'hit', pos: hitEnt?.pos ?? landed, entity: hitEnt?.id ?? null }, { field: 'landed', pos: landed },
        { field: 'reached', pos: hitEnt?.pos ?? landed, entity: hitEnt?.id ?? null },
      ], [pr.id]);
      ctx.emit({
        type: 'item_thrown', actor: me.id, actorKind: me.kind, item: thrownId, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind),
        from, to: tp, landed: broke ? null : landed, hit: hit?.id ?? null, hitKind: hit?.kind ?? null, broke, put, del, ...seen, floor: key,
        outcome, blockedBy, reached: hitEnt?.id ?? null, reachedKind: hitEnt?.kind ?? null,
        ...(hitEnt?.scale?.affixes?.length ? { reachedAffixes: [...hitEnt.scale.affixes] } : {}),
      });
      makeNoise(ctx, key, landed, 4, me);
      if (hit) {
        const dmgDice = def?.throw?.dmg ?? '1d2';
        // 急所狙い: 相手の装甲を無視する分（V3-3b §40.1）。弾く者の半減はこの後に掛かる
        const armorLeft = Math.max(0, armorOf(ctx, hit) - thrownPierceOf(ctx, me));
        // 強肩: 投擲のダメージの上乗せ（会心にも乗る。V3-3c §44.4）
        const arm = perkHookSum(ctx, me, 'thrown_dmg', 'dmg');
        const base = crit ? Math.max(1, diceMax(dmgDice) + arm) : Math.max(1, roll(ctx.rng('runtime'), dmgDice) + arm - armorLeft);
        // 守護者の受けるダメージの修正（弾く者・投擲に弱い。V3-3）
        const dmg = hit.guardian ? guardianIncoming(ctx, hit, base, 'thrown', ctx.world.entities[me.id] ?? me) : base;
        applyDamage(ctx, hit, dmg, ctx.world.entities[me.id], 'thrown');
        const stillThere = ctx.world.entities[hit.id];
        if (broke && def?.onUse.length && stillThere && (stillThere.stats?.hp ?? 0) > 0) {
          applyEffects(ctx, def.onUse, { user: ctx.world.entities[me.id], target: stillThere, pos: landed, source: ctx.world.entities[me.id], via: 'thrown' });
        }
        // 加護（狩人。V3-3 §3.3）: 当たった投げ物が pct % で手元に戻る（割れる物は除く）
        const hunter = !broke ? boonHook(ctx, ctx.world.entities[me.id], 'throw_return') : null;
        if (hunter && ctx.rng('runtime').chance(hunter.params.pct ?? 50)) returnThrown(ctx, me.id, thrownId, it.id, it.item!.slot!, hunter.boon);
      } else if (hitEnt) {
        // 外れても狙われたことには気づく
        applyDamage(ctx, hitEnt, 0, null, 'thrown');
      }
      // 護りの火に投げた物を当てると消える（V3-3）
      const fire = ctx.featureAt(key, landed.x, landed.y);
      if (fire?.kind === 'core:ward_fire' && fire.feature?.state === 'lit') {
        ctx.emit({ type: 'feature_state', id: fire.id, kind: fire.kind, state: 'out', ...ctx.perceive(key, [{ field: 'id', pos: landed }], [pr.id]), floor: key });
      }
      // 胞子嚢に当たると弾ける（V3-5 §5.2）
      const pod = fire && ctx.content.features[fire.kind]?.burst ? fire : null;
      if (pod) burstPod(ctx, pod);
      updateKnowledge(ctx, key);
      // 早投げ: 投擲の手番コストが下がる（V3-4 §4.1）
      return { cost: perkHook(ctx, me, 'throw_cost')?.cost ?? 100 };
    },
  };
}

/** 投げた物を手元に戻す（狩人の加護）。持っている同じ山があれば足し、無ければ元のスロットへ */
function returnThrown(ctx: Ctx, actorId: string, thrownId: string, stackId: string, slot: string, boon: string): void {
  const me = ctx.world.entities[actorId];
  const thrown = ctx.world.entities[thrownId];
  if (!me?.inv || !thrown?.item || !thrown.pos) return;
  const put: Entity[] = [];
  const del: string[] = [];
  const stack = thrownId !== stackId ? ctx.world.entities[stackId] : undefined;
  if (stack?.item && stack.item.heldBy === me.id) {
    const s = structuredClone(stack);
    s.item!.qty += 1;
    put.push(s);
    del.push(thrownId);
  } else {
    if (me.inv.items.some((id) => ctx.world.entities[id]?.item?.slot === slot)) return;
    const back = structuredClone(thrown);
    delete back.pos;
    delete back.item!.thrownBy;
    back.item!.heldBy = me.id;
    back.item!.slot = slot;
    const actor = structuredClone(me);
    actor.inv!.items.push(thrownId);
    put.push(back, actor);
  }
  ctx.emit({ type: 'boon_triggered', actor: me.id, boon, effect: 'returned', item: thrownId, itemKind: thrown.kind, put, ...(del.length ? { del } : {}), seenBy: me.player ? [me.player] : [], floor: thrown.pos.floor });
}

// 近接攻撃（V3-4）: 隣の敵、または長柄の武器なら直線で 2 マス先（間のマスが通れて誰もいない）
actions.register('attack', (ctx, e, pr, cmd: Extract<Command, { type: 'attack' }>) => {
  const key = e.pos!.floor;
  const te = ctx.world.entities[cmd.target];
  if (!te?.pos || te.pos.floor !== key || !te.actor || te.player || !ctx.seesActorAt(pr.id, key, te.pos)) {
    return fail(pr, 'no_target', 'その敵は見えていない。', 'You cannot see that enemy.', 'visible.monsters の id を指定する。', 'Use an id from visible.monsters.');
  }
  const d = cheb(e.pos!, te.pos);
  if (d > 1 && !(reachOf(ctx, e) >= 2 && reachLine(ctx, e.pos!, te.pos))) {
    return fail(pr, 'out_of_range', '近接攻撃が届かない。', 'Out of melee reach.',
      reachOf(ctx, e) >= 2 ? '長柄の武器は縦・横・斜めの直線で 2 マス先まで（間のマスが通れて誰もいないこと）。' : '隣の敵を指定するか、近づく（fight で決着まで）。',
      reachOf(ctx, e) >= 2 ? 'A reach weapon hits 2 cells away in a straight line if the cell between is open and empty.' : 'Pick an adjacent enemy or close in (fight).');
  }
  return { run: () => { melee(ctx, e, te); return { cost: attackCostOf(ctx, e) }; } };
});

// 能動技（V3-4 §4.2）: 再使用までの手番だけで管理する。使えない・対象が無いなら手番を使わずに拒否する
actions.register('ability', (ctx, e, pr, cmd: Extract<Command, { type: 'ability' }>) => {
  const id = resolveAbilityId(ctx, e, cmd.id);
  if (!id) {
    const known = (e.build?.abilities ?? []).map((a) => a.id.split(':')[1]).join(', ') || '-';
    return fail(pr, 'cannot_use', `その能動技は覚えていない: ${cmd.id}`, `You do not know that ability: ${cmd.id}`, `覚えている能動技: ${known}（self.abilities）`, `Known abilities: ${known} (self.abilities)`);
  }
  const notReady = abilityReadyError(ctx, e, pr, id);
  if (notReady) return { error: notReady };
  const def = ctx.content.abilities[id];
  const markUsed = (target: Entity | null) => {
    const body = markAbilityUsed(ctx, e, id);
    const after = abilityState(ctx, body, id);
    ctx.emit({
      type: 'ability_used', actor: e.id, actorKind: e.kind, ability: id, target: target?.id ?? null, targetKind: target?.kind ?? null,
      ...(target?.scale?.affixes?.length ? { targetAffixes: [...target.scale.affixes] } : {}),
      cooldownLeft: Math.max(0, after.cooldownLeft - 1), put: [body], ...selfSeen(ctx, ctx.world.entities[e.id]), floor: e.pos!.floor,
    });
  };
  // 狙い撃ち: 投擲と同じ検証（射程・射線）。品は slot か、投擲用の品の最初のスロット
  if (def.target === 'throw') {
    const slot = cmd.slot ?? (e.inv?.items ?? []).map((x) => ctx.world.entities[x]).filter((x) => x?.item && ctx.content.items[x.kind]?.category === 'throwing')
      .sort((a, b) => (a.item!.slot ?? '').localeCompare(b.item!.slot ?? ''))[0]?.item?.slot;
    if (!slot) return fail(pr, 'no_such_item', '投げる物を持っていない。', 'You have nothing to throw.', '投げナイフなどを拾う。', 'Pick up throwing weapons first.');
    if (typeof cmd.target !== 'string' || !cmd.target.startsWith('e_')) return fail(pr, 'no_target', '狙う相手の ID を target に渡す。', 'Pass the target id as target.', 'visible.monsters の shots が clear の相手。', 'A monster whose shots entry is clear.');
    return prepareThrow(ctx, e, pr, slot, cmd.target, { accBonus: def.params.acc ?? 0, critIfUnaware: true, before: () => markUsed(ctx.world.entities[cmd.target as string] ?? null) });
  }
  const prep = abilityHandlers.get(def.handler)(ctx, e, pr, def, cmd);
  if ('error' in prep) return { error: prep.error };
  return { run: () => { markUsed(prep.target); prep.run(); return { cost: 100 }; } };
});

// 野営の火を置く（S1。SEASON.md §8.2）: 自分のいるマスに。1 手番。費用はこのランの確定点から
actions.register('place_fire', (ctx, e, pr) => {
  const c = placeFireCheck(ctx, e, pr);
  if ('error' in c) return { error: c.error };
  return { run: () => { placeFire(ctx, ctx.world.entities[e.id], pr, c.cost); return { cost: 100 }; } };
});

// 補給の置き場（S3。SEASON.md §25.2）: 預ける・取る（どちらも 1 手番。預けるのは追ってくる敵が見えていてもできる）
actions.register('deposit_supply', (ctx, e, pr, cmd: Extract<Command, { type: 'deposit_supply' }>) => {
  const c = depositCheck(ctx, e, pr, cmd.slot);
  if ('error' in c) return c;
  return { run: () => { depositSupply(ctx, e, pr, c.item, c.at); return { cost: 100 }; } };
});
actions.register('take_supply', (ctx, e, pr, cmd: Extract<Command, { type: 'take_supply' }>) => {
  const c = takeCheck(ctx, e, pr, cmd.id);
  if ('error' in c) return c;
  return { run: () => { takeSupply(ctx, e, pr, c.pick, c.at); return { cost: 100 }; } };
});

actions.register('interact', (ctx, e, pr, cmd: Extract<Command, { type: 'interact' }>) => {
  const key = e.pos!.floor;
  const p = cmd.dir ? stepPos(e.pos!, cmd.dir) : { x: e.pos!.x, y: e.pos!.y };
  const tr = ctx.terrainAt(key, p.x, p.y);
  // 野営の火（S1。SEASON.md §8.1）: 今使えるなら火を使う。使えなければ、同じマスのその世界の扉・地物を今までどおり（ほかの世界の火と重なったとき。§9.4）
  const fire = ctx.campfireAt(key, p.x, p.y);
  const fireCheck = fire ? campfireCheck(ctx, e, pr, fire) : null;
  if (fire && fireCheck && 'amount' in fireCheck) {
    return { run: () => { useCampfire(ctx, ctx.world.entities[e.id], pr, fire, fireCheck.amount); return { cost: 100 }; } };
  }
  const fireErr = fireCheck && 'error' in fireCheck ? fireCheck.error : null;
  if (cmd.dir && tr.door === 'open') {
    if (ctx.actorAt(key, p.x, p.y) || ctx.itemsAt(key, p.x, p.y).length) return fail(pr, 'blocked', '扉の間に何かがあって閉められない。', 'Something is in the doorway.', '扉の上を空けてから閉める。', 'Clear the doorway first.');
    return {
      run: () => {
        const closed = ctx.world.meta.terrainTable.indexOf('core:door_closed');
        ctx.emit({ type: 'tile_changed', x: p.x, y: p.y, terrain: closed, reason: 'door_close', by: e.id, ...ctx.tileSeen(key, p, e), floor: key });
        makeNoise(ctx, key, p, 3, e);
        return { cost: 100 };
      },
    };
  }
  if (cmd.dir && tr.door === 'closed') return { run: () => { openDoor(ctx, e, p); return { cost: 100 }; } };
  // 鍵のかかった格子扉（V3-5 §5.1）: 宝物庫の鍵で開ける（鍵は無くなる）
  if (cmd.dir && tr.tags.includes('locked')) {
    const keyItem = (e.inv?.items ?? []).map((id) => ctx.world.entities[id]).find((it) => !!it?.item && ctx.content.items[it.kind]?.category === 'key');
    if (!keyItem) return fail(pr, 'cannot_use', '鍵がかかっている。宝物庫の鍵が要る（その階の敵が持っている）。', 'It is locked. You need the vault key (a monster on this floor carries it).', '鍵を持つ敵（visible.monsters の carries）を倒して鍵を拾う。', 'Defeat the monster carrying the key (carries in visible.monsters) and pick it up.');
    return {
      run: () => {
        const me = ctx.world.entities[e.id];
        const actor = structuredClone(me);
        actor.inv!.items = actor.inv!.items.filter((x) => x !== keyItem.id);
        ctx.emit({ type: 'item_used', actor: e.id, item: keyItem.id, kind: keyItem.kind, appearanceId: null, category: 'key', qtyAfter: 0, put: [actor], del: [keyItem.id], ...selfSeen(ctx, me), floor: key });
        const open = ctx.world.meta.terrainTable.indexOf('core:grate_open');
        ctx.emit({ type: 'tile_changed', x: p.x, y: p.y, terrain: open, reason: 'unlock', by: e.id, ...ctx.tileSeen(key, p, e), floor: key });
        makeNoise(ctx, key, p, 3, e);
        return { cost: 100 };
      },
    };
  }
  const feat = ctx.featureAt(key, p.x, p.y);
  // レバー（V3-5 §5.2）: つないだ格子扉を開け閉めする
  if (feat?.feature && ctx.content.features[feat.kind]?.lever) {
    return { run: () => { pullLever(ctx, ctx.world.entities[e.id], feat); return { cost: 100 }; } };
  }
  // 胞子嚢を突く（V3-5 §5.2）
  if (feat?.feature && ctx.content.features[feat.kind]?.burst) {
    if (feat.feature.state === 'burst') return fail(pr, 'cannot_use', 'もう弾けている。', 'It has already burst.', '他の地物を探す。', 'Look for another feature.');
    return { run: () => { burstPod(ctx, feat); return { cost: 100 }; } };
  }
  if (feat?.feature) {
    const def = ctx.content.features[feat.kind];
    // 効果は無くても、状態が変わる地物（護りの火を消す。V3-3）は操作できる
    if (!def?.onInteract.length && !def?.afterInteract && !def?.gamble) return fail(pr, 'cannot_use', 'それは操作できない。', 'Nothing happens.', '別の対象を選ぶ。', 'Try something else.');
    if (def.afterInteract && feat.feature.state === def.afterInteract) return fail(pr, 'cannot_use', 'もう力を失っている。', 'It has already been used.', '他の地物を探す。', 'Look for another feature.');
    return {
      run: () => {
        if (def.afterInteract) ctx.emit({ type: 'feature_state', id: feat.id, kind: feat.kind, state: def.afterInteract, ...ctx.perceive(key, [{ field: 'id', pos: p }], [pr.id]), floor: key });
        // 賭けの祭壇（V3-5 §5.1）: 公開の表から重みで 1 つ
        if (def.gamble?.length) {
          const total = def.gamble.reduce((a, g) => a + g.weight, 0);
          const g = ctx.rng('runtime').weighted(def.gamble, (x) => x.weight) ?? def.gamble[0];
          ctx.emit({ type: 'gamble_rolled', player: pr.id, feature: feat.id, outcome: { ...g.name }, pct: Math.trunc((g.weight * 100) / total), ...ctx.perceive(key, [{ field: 'feature', pos: p }], [pr.id]), floor: key });
          applyEffects(ctx, g.effects, { user: ctx.world.entities[e.id], target: ctx.world.entities[e.id], pos: p, source: null, via: 'feature' });
        }
        applyEffects(ctx, def.onInteract, { user: ctx.world.entities[e.id], target: ctx.world.entities[e.id], pos: p, source: null, via: 'feature', feature: feat });
        updateKnowledge(ctx, key);
        return { cost: 100 };
      },
    };
  }
  if (fireErr) return { error: fireErr };
  if (tr.stairs && !cmd.dir) return fail(pr, 'nothing_here', '階段を使うには use_stairs。', 'Use use_stairs for stairs.', 'use_stairs を呼ぶ。', 'Call use_stairs.');
  return fail(pr, 'nothing_here', 'そこには操作できるものが無い。', 'There is nothing to interact with there.', '扉や泉・祭壇に隣接して方向を指定する。', 'Stand next to a door or feature and give its direction.');
});

actions.register('stairs', (ctx, e, pr) => {
  const key = e.pos!.floor;
  const f = ctx.world.floors[key];
  const tr = ctx.terrainAt(key, e.pos!.x, e.pos!.y);
  if (!tr.stairs) return fail(pr, 'nothing_here', '足元に階段は無い。', 'There are no stairs here.', 'travel_to stairs_down で階段へ移動する。', 'Use travel_to stairs_down to reach the stairs.');
  const depth = tr.stairs === 'down' ? f.depth + 1 : f.depth - 1;
  if (depth < 1) return fail(pr, 'cannot_use', '地上への道は閉ざされている。', 'The way to the surface is sealed.', '下り階段を探す。', 'Find the stairs down.');
  // 節目の階の下り階段は、大守護者を倒すまで封じられている（V3-3 §3.2）。判定は表示と同じ（V4-0a §1.1: 節目の深さで、倒した記録が無い）
  if (tr.stairs === 'down' && sealedFloor(ctx, key)) return fail(pr, 'sealed', '下り階段は封じられている。この階の大守護者を倒すまで降りられない。', 'The stairs down are sealed until this floor\'s warden falls.', 'extract で帰るか、大守護者を倒す。', 'Extract to go home, or slay the warden.');
  return {
    run: () => {
      const regenAfter = regenTick(ctx, e, false);
      const me = ctx.world.entities[e.id];
      const toKey = `${f.branch}:${depth}`;
      const to = ensureFloor(ctx, toKey);
      const arrival = tr.stairs === 'down' ? (to.stairs.up ?? to.entry) : (to.stairs.down[0] ?? to.entry);
      const cell = findFreeCell(ctx, toKey, arrival);
      ctx.curFloor = key;
      ctx.emit({ type: 'actor_scheduled', id: me.id, nextActAt: me.actor!.nextActAt + 100, turns: me.actor!.turns + 1, ...(regenAfter !== undefined ? { regenAfter } : {}), seenBy: [pr.id], floor: key });
      const from = { floor: key, x: me.pos!.x, y: me.pos!.y };
      ctx.emit({
        type: 'entity_changed_floor', id: me.id, kind: me.kind, from, to: { floor: toKey, x: cell.x, y: cell.y }, nextActAt: to.time,
        dir: tr.stairs!, ...ctx.perceive(key, [{ field: 'from', pos: from, entity: me.id }], [pr.id]), floor: key,
      });
      // 守護者は、相手が階を離れている間に回復する（V3-3a §35.1）
      markGuardiansAway(ctx, key, ctx.world.entities[me.id]);
      restGuardians(ctx, toKey, ctx.world.entities[me.id]);
      const p = ctx.world.players[pr.id];
      if (depth > p.stats.deepest) {
        ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...p.stats, deepest: depth }, seenBy: [pr.id], floor: toKey });
        // 新しい深度に初めて着いた経験値（敵を避けて進んでも深度相応に育つ）
        grantXp(ctx, ctx.world.entities[me.id], ctx.content.balance.xp.perNewDepth * depth, { reason: 'depth', depth });
      }
      // 加護（俊足。V3-3 §3.3）: 階段を使った直後の N 手番、加速
      const swift = boonHook(ctx, ctx.world.entities[me.id], 'stairs_haste');
      if (swift) {
        addStatus(ctx, ctx.world.entities[me.id], 'core:haste', swift.params.turns ?? 10, 1);
        ctx.emit({ type: 'boon_triggered', actor: me.id, boon: swift.boon, effect: 'haste', seenBy: [pr.id], floor: toKey });
      }
      updateKnowledge(ctx, toKey);
      return { cost: 0, scheduled: true };
    },
  };
});

// 遠征: 階段の上で帰還（達成）または撤退（confirm）。盤面から外れてキャンプへ
actions.register('extract', (ctx, e, pr, cmd: Extract<Command, { type: 'extract' }>) => {
  const r = extractError(ctx, e, pr, cmd.confirm);
  if ('error' in r) return { error: r.error };
  // 野営の火から（S1c §14.3 の 1）: この手番から帰り支度。残りは行動できず、切れたら帰る（追ってくる敵が見えたら取りやめ）
  if (r.fire) { const fire = r.fire; return { run: () => startFireReturn(ctx, e, pr, fire, cmd.confirm === true, r.expedition) }; }
  return { run: () => { doExtract(ctx, e, pr, r.completed, r.expedition); return { cost: 0, scheduled: true }; } };
});

// ---- 手番を消費しない ----

export function freeCommand(ctx: Ctx, pr: PlayerRecord, cmd: Command): ActionError | null {
  if (cmd.type === 'say') {
    ctx.emit({ type: 'chat', player: pr.id, name: pr.name, text: cmd.text, seenBy: 'all', floor: null });
    return null;
  }
  if (cmd.type === 'note') {
    let notes = [...pr.knowledge.notes];
    if (cmd.remove !== undefined) {
      if (cmd.remove >= notes.length) return actionError('bad_request', t(pr.locale, 'そのメモは無い。', 'No such note.'), t(pr.locale, 'notes で番号を確認する。', 'Check numbers with notes.'));
      notes.splice(cmd.remove, 1);
    }
    if (cmd.add) notes.push(cmd.add);
    if (notes.length > 50) notes = notes.slice(-50);
    ctx.emit({ type: 'notes_updated', player: pr.id, notesAfter: notes, seenBy: [pr.id], floor: null });
    return null;
  }
  if (cmd.type === 'choose_perk') return choosePerk(ctx, pr, cmd.option);
  if (cmd.type === 'choose_boon') return chooseBoon(ctx, pr, cmd.option);
  if (cmd.type === 'retire') {
    if (pr.state !== 'alive' && pr.state !== 'at_camp') return actionError('dead', t(pr.locale, '既にランから外れている。', 'You are no longer in the run.'), '');
    const me = ctx.world.entities[pr.entityId];
    if (me.pos) {
      const body = structuredClone(me);
      delete body.pos;
      if (body.actor) body.actor.dormant = true;
      const fk = me.pos.floor;
      ctx.curFloor = fk;
      if (ctx.world.floors[fk].currentActor === me.id) {
        ctx.emit({ type: 'actor_scheduled', id: me.id, nextActAt: me.actor!.nextActAt, turns: me.actor!.turns, seenBy: [pr.id], floor: fk });
      }
      ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...pr.stats, deathCause: 'retired', endedSeq: ctx.world.seq + 1 }, seenBy: [pr.id], put: [body], floor: fk });
    } else {
      // キャンプで引退しても記録は「引退」（V3-3b の計測: キャンプでの引退だけ死因が空だった）
      ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...pr.stats, deathCause: 'retired', endedSeq: ctx.world.seq + 1 }, seenBy: [pr.id], floor: null });
    }
    ctx.emit({ type: 'player_state', player: pr.id, state: 'left', reason: 'retired', seenBy: 'all', floor: null });
    maybeEndExpedition(ctx);
    checkRunEnd(ctx);
    void endRun;
    return null;
  }
  return actionError('bad_request', 'unknown free command', '');
}

// プレイヤーの基本行動。各ハンドラは「検証（イベント無し）→ 実行」の二段。
// 不正なコマンドはイベントを出さず時間も消費しない（ActionError を返す）。
import type { ActionError, Command, Entity, EquipSlot, PlayerRecord, Pos } from '@muse/shared';
import { actionError, DIR_VEC, EQUIP_SLOTS, stepPos, t } from '@muse/shared';
import { endRun, melee, rollToHit, applyDamage, checkRunEnd } from './combat';
import type { Ctx } from './ctx';
import { applyEffects } from './effects';
import { doExtract, extractError, maybeEndExpedition } from './expedition';
import { ensureFloor, findFreeCell } from './floors';
import { line } from './geom';
import { makeNoise, shotClear, updateKnowledge, wakeMonster } from './perception';
import { hasStatus, removeStatus } from './statuses';
import { Registry, roll } from './registry';
import { regenTick } from './scheduler';
import { recomputeStats } from './stats';

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
        ctx.emit({ type: 'entity_moved', id: e.id, kind: e.kind, from: a, to, mode: 'swap', ...ctx.perceive(key, [{ field: 'from', pos: a }, { field: 'to', pos: to }], [e.player!]), floor: key });
        ctx.emit({ type: 'entity_moved', id: occ.id, kind: occ.kind, from: to, to: a, mode: 'swap', ...ctx.perceive(key, [{ field: 'from', pos: to }, { field: 'to', pos: a }], [occ.player!]), floor: key });
        return { cost: 100 };
      },
    };
  }
  if (occ) return { run: () => { melee(ctx, e, occ); return { cost: 100 }; } };
  const tr = ctx.terrainAt(key, to.x, to.y);
  if (tr.door === 'closed') return { run: () => { openDoor(ctx, e, to); return { cost: 100 }; } };
  if (!tr.passable) {
    return fail(pr, 'blocked', `${t(pr.locale, tr.name.ja, tr.name.en)}があって進めない。`, `A ${tr.name.en} blocks the way.`, 'observe の navigation.passable_dirs から選ぶか、explore / travel_to を使う。', 'Choose from navigation.passable_dirs, or use explore / travel_to.');
  }
  return {
    run: () => {
      const from = { x: e.pos!.x, y: e.pos!.y };
      ctx.emit({ type: 'entity_moved', id: e.id, kind: e.kind, from, to, mode: 'walk', ...ctx.perceive(key, [{ field: 'from', pos: from }, { field: 'to', pos: to }], [e.player!]), floor: key });
      const trap = ctx.featureAt(key, to.x, to.y);
      if (trap?.trap) triggerTrap(ctx, ctx.world.entities[e.id], trap);
      // 自分が投げた物は、移動の一部として拾う（追加の手番なし。入らなければ拾わない）
      const me = ctx.world.entities[e.id];
      if (me?.pos && ctx.world.players[pr.id].state === 'alive') {
        const mine = ctx.itemsAt(key, me.pos.x, me.pos.y).filter((it) => it.item?.thrownBy === pr.id);
        if (mine.length) { pickUpItems(ctx, me, mine, true); updateKnowledge(ctx, key); }
      }
      return { cost: 100 };
    },
  };
});

actions.register('wait', () => ({ run: () => ({ cost: 100 }) }));

actions.register('pickup', (ctx, e, pr, cmd: Extract<Command, { type: 'pickup' }>) => {
  const key = e.pos!.floor;
  let items = ctx.itemsAt(key, e.pos!.x, e.pos!.y);
  if (cmd.item) items = items.filter((i) => i.id === cmd.item);
  if (!items.length) return fail(pr, 'nothing_here', '足元に拾えるものは無い。', 'There is nothing here to pick up.', 'visible.items の位置へ travel_to してから pickup する。', 'travel_to an item in visible.items first.');
  const canTakeAny = items.some((it) => {
    const def = ctx.content.items[it.kind];
    const stack = def?.stack && (e.inv?.items ?? []).some((id) => {
      const x = ctx.world.entities[id];
      return x?.kind === it.kind && JSON.stringify(x.item?.affixes) === JSON.stringify(it.item?.affixes);
    });
    return stack || (e.inv!.items.length < e.inv!.capacity && freeSlot(ctx, e) !== null);
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
    if (!slot || me.inv!.items.length >= me.inv!.capacity) break;
    const held = structuredClone(it);
    delete held.pos;
    held.item!.heldBy = e.id;
    held.item!.slot = slot;
    delete held.item!.thrownBy;
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
        const piece: Entity = { id, kind: it.kind, sid: ctx.nextSid(), pos: { floor: key, ...pos }, item: { qty, affixes: [...it.item!.affixes] } };
        ctx.emit({ ...base, item: id, put: [stack, piece] });
      } else {
        const dropped = structuredClone(it);
        delete dropped.item!.heldBy;
        delete dropped.item!.slot;
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
  return {
    run: () => {
      const slotName = def.equip!.slot;
      if (ctx.world.entities[e.id].equip?.[slotName]) unequipEvents(ctx, e, slotName);
      const me = ctx.world.entities[e.id];
      const actor = structuredClone(me);
      actor.equip = { ...(actor.equip ?? {}), [slotName]: it.id };
      ctx.emit({ type: 'item_equipped', actor: e.id, item: it.id, kind: it.kind, appearanceId: appearanceOf(ctx, it.kind), slotName, affixes: [...(it.item?.affixes ?? [])], put: [actor], ...selfSeen(ctx, me), floor: me.pos!.floor });
      recomputeStats(ctx, ctx.world.entities[e.id], 'equip');
      return { cost: 100 };
    },
  };
});

actions.register('unequip', (ctx, e, pr, cmd: Extract<Command, { type: 'unequip' }>) => {
  let slotName: EquipSlot | null = null;
  if ((EQUIP_SLOTS as readonly string[]).includes(cmd.slot)) slotName = cmd.slot as EquipSlot;
  else {
    const it = invItem(ctx, e, cmd.slot);
    if (it) slotName = equippedSlotOf(e, it.id);
  }
  if (!slotName || !e.equip?.[slotName]) return fail(pr, 'no_such_item', 'それは装備していない。', 'That is not equipped.', 'inventory で装備中のアイテムを確認する。', 'Check equipped items with inventory.');
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
      applyEffects(ctx, def.onUse, { user: ctx.world.entities[e.id], target: ctx.world.entities[e.id], pos: { x: me.pos!.x, y: me.pos!.y }, source: me, via: 'item' });
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
    const vis = ctx.visibleSet(pr.id);
    if (!te?.pos || te.pos.floor !== key || !vis.has(te.pos.y * f.width + te.pos.x)) {
      return actionError('no_target', t(pr.locale, 'その対象は見えていない。', 'You cannot see that target.'), t(pr.locale, 'visible.monsters の id を指定する。', 'Use an id from visible.monsters.'));
    }
    if (!shotClear(ctx, key, e.pos!, te.pos)) {
      return actionError('no_line_of_sight', t(pr.locale, 'そこまで投擲の経路が通っていない（壁か他の者に遮られる）。', 'No clear throwing line to that target (blocked by a wall or someone).'),
        t(pr.locale, 'visible.monsters の shot が clear の相手を選ぶか、位置を変える。座標を狙えば遮られた位置に落ちる。', 'Pick a monster whose shot is clear, or move. Targeting a position lands where it is blocked.'));
    }
    return { x: te.pos.x, y: te.pos.y };
  }
  const p = target as Pos;
  if (p.x < 0 || p.y < 0 || p.x >= f.width || p.y >= f.height) return actionError('out_of_range', t(pr.locale, '範囲外の座標だ。', 'Out of bounds.'), t(pr.locale, 'フロア内の座標を指定する。', 'Pick a position on this floor.'));
  return { x: p.x, y: p.y };
}

actions.register('throw', (ctx, e, pr, cmd: Extract<Command, { type: 'throw' }>) => {
  const it = invItem(ctx, e, cmd.slot);
  if (!it) return fail(pr, 'no_such_item', `スロット ${cmd.slot} にアイテムは無い。`, `No item in slot ${cmd.slot}.`, 'inventory で確認する。', 'Check with inventory.');
  if (equippedSlotOf(e, it.id)) return fail(pr, 'cannot_use', '装備中のものは投げられない。', 'You cannot throw an equipped item.', '先に unequip する。', 'unequip it first.');
  const def = ctx.content.items[it.kind];
  const range = def?.throw?.range ?? 4;
  const tp = resolveTarget(ctx, e, pr, cmd.target, range);
  if ('code' in tp) return { error: tp };
  if (tp.x === e.pos!.x && tp.y === e.pos!.y) return fail(pr, 'no_target', '自分には投げられない。', 'You cannot throw at yourself.', '方向・座標・対象 ID を指定する。', 'Give a direction, position or target id.');
  return {
    run: () => {
      const me = ctx.world.entities[e.id];
      const key = me.pos!.floor;
      const from = { x: me.pos!.x, y: me.pos!.y };
      const full = line(from, tp);
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
        const o = rollToHit(ctx, me, hitEnt, def?.throw?.acc ?? 0);
        if (o.hit) { hit = hitEnt; crit = o.crit; }
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
      });
      makeNoise(ctx, key, landed, 4, me);
      if (hit) {
        const dmgDice = def?.throw?.dmg ?? '1d2';
        const dmg = Math.max(1, roll(ctx.rng('runtime'), dmgDice, crit) - (hit.stats?.armor ?? 0));
        applyDamage(ctx, hit, dmg, ctx.world.entities[me.id], 'thrown');
        const stillThere = ctx.world.entities[hit.id];
        if (broke && def?.onUse.length && stillThere && (stillThere.stats?.hp ?? 0) > 0) {
          applyEffects(ctx, def.onUse, { user: ctx.world.entities[me.id], target: stillThere, pos: landed, source: ctx.world.entities[me.id], via: 'thrown' });
        }
      } else if (hitEnt) {
        // 外れても狙われたことには気づく
        applyDamage(ctx, hitEnt, 0, null, 'thrown');
      }
      updateKnowledge(ctx, key);
      return { cost: 100 };
    },
  };
});

actions.register('interact', (ctx, e, pr, cmd: Extract<Command, { type: 'interact' }>) => {
  const key = e.pos!.floor;
  const p = cmd.dir ? stepPos(e.pos!, cmd.dir) : { x: e.pos!.x, y: e.pos!.y };
  const tr = ctx.terrainAt(key, p.x, p.y);
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
  const feat = ctx.featureAt(key, p.x, p.y);
  if (feat?.feature) {
    const def = ctx.content.features[feat.kind];
    if (!def?.onInteract.length) return fail(pr, 'cannot_use', 'それは操作できない。', 'Nothing happens.', '別の対象を選ぶ。', 'Try something else.');
    if (def.afterInteract && feat.feature.state === def.afterInteract) return fail(pr, 'cannot_use', 'もう力を失っている。', 'It has already been used.', '他の地物を探す。', 'Look for another feature.');
    return {
      run: () => {
        if (def.afterInteract) ctx.emit({ type: 'feature_state', id: feat.id, kind: feat.kind, state: def.afterInteract, ...ctx.perceive(key, [{ field: 'id', pos: p }], [pr.id]), floor: key });
        applyEffects(ctx, def.onInteract, { user: ctx.world.entities[e.id], target: ctx.world.entities[e.id], pos: p, source: null, via: 'feature' });
        updateKnowledge(ctx, key);
        return { cost: 100 };
      },
    };
  }
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
        dir: tr.stairs!, ...ctx.perceive(key, [{ field: 'from', pos: from }], [pr.id]), floor: key,
      });
      const p = ctx.world.players[pr.id];
      if (depth > p.stats.deepest) ctx.emit({ type: 'player_stats', player: pr.id, stats: { ...p.stats, deepest: depth }, seenBy: [pr.id], floor: toKey });
      updateKnowledge(ctx, toKey);
      return { cost: 0, scheduled: true };
    },
  };
});

// 遠征: 階段の上で帰還（達成）または撤退（confirm）。盤面から外れてキャンプへ
actions.register('extract', (ctx, e, pr, cmd: Extract<Command, { type: 'extract' }>) => {
  const r = extractError(ctx, e, pr, cmd.confirm);
  if ('error' in r) return { error: r.error };
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
    }
    ctx.emit({ type: 'player_state', player: pr.id, state: 'left', reason: 'retired', seenBy: 'all', floor: null });
    maybeEndExpedition(ctx);
    checkRunEnd(ctx);
    void endRun;
    return null;
  }
  return actionError('bad_request', 'unknown free command', '');
}

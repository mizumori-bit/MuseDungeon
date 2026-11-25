// World State を書き換える唯一の関数。ルール（計算）を持たない: 代入・追加・削除のみ。
// 仕様: docs/DESIGN.md §4.1
import type { GameEvent } from './events';
import type { Entity, Expedition, FloorKnowledge, World } from './types';
import { rangesToIndices, rleDecode } from './util';

const clone: <T>(v: T) => T = (v) => structuredClone(v);

export function emptyWorld(): World {
  return {
    meta: {
      runId: '', contentVersion: '', engineVersion: '', eventVersion: 0, mode: 'solo', createdSeq: 0,
      terrainTable: [], options: { turnTimeoutMs: null, maxPlayers: 1 },
    },
    secret: { seed: '', rng: {}, appearances: {} },
    seq: 0,
    status: 'active',
    endReason: null,
    floors: {},
    entities: {},
    players: {},
    playerOrder: [],
  };
}

function ent(world: World, id: string): Entity {
  const e = world.entities[id];
  if (!e) throw new Error(`applyEvent: unknown entity ${id}`);
  return e;
}

function expedition(world: World, no: number): Expedition {
  const x = world.expeditions?.find((e) => e.no === no);
  if (!x) throw new Error(`applyEvent: unknown expedition ${no}`);
  return x;
}

function floorKnowledge(world: World, playerId: string, key: string): FloorKnowledge {
  const p = world.players[playerId];
  let fk = p.knowledge.floors[key];
  if (!fk) {
    const f = world.floors[key];
    fk = { seen: new Array<number>(f.width * f.height).fill(0), remembered: [] };
    p.knowledge.floors[key] = fk;
  }
  return fk;
}

export function applyEvent(world: World, ev: GameEvent): void {
  switch (ev.type) {
    case 'run_started':
      world.meta = clone(ev.meta);
      world.secret = ev.secret ? clone(ev.secret) : { seed: '', rng: {}, appearances: {} };
      world.status = 'active';
      break;
    case 'player_joined':
      world.players[ev.player.id] = clone(ev.player);
      world.playerOrder.push(ev.player.id);
      world.entities[ev.entity.id] = clone(ev.entity);
      break;
    case 'player_state':
      world.players[ev.player].state = ev.state;
      if (ev.extractPos !== undefined) world.players[ev.player].extractPos = ev.extractPos ? clone(ev.extractPos) : null;
      break;
    case 'player_stats':
      world.players[ev.player].stats = clone(ev.stats);
      break;
    case 'run_ended':
      world.status = 'ended';
      world.endReason = ev.reason;
      if (ev.summary.seed) world.secret.seed = ev.summary.seed;
      break;
    case 'floor_generated':
      world.floors[ev.floorData.key] = { ...clone(ev.floorData), terrain: rleDecode(ev.terrainRle) };
      break;
    case 'tile_changed': {
      const f = world.floors[ev.floor!];
      f.terrain[ev.y * f.width + ev.x] = ev.terrain;
      break;
    }
    case 'turn_began': {
      const f = world.floors[ev.floor!];
      f.currentActor = ev.actor;
      f.time = ev.time;
      break;
    }
    case 'floor_wander':
      world.floors[ev.floor!].nextWanderAt = ev.nextWanderAt;
      break;
    case 'entity_spawned':
      world.entities[ev.entity.id] = clone(ev.entity);
      break;
    case 'entity_removed':
      delete world.entities[ev.id];
      break;
    case 'clue_noted': {
      const k = world.players[ev.player]?.knowledge;
      if (k) k.clueSince = { ...(k.clueSince ?? {}), [ev.appearanceId]: ev.turns };
      break;
    }
    case 'clue_learned': {
      const k = world.players[ev.player]?.knowledge;
      if (k) {
        k.clues = { ...(k.clues ?? {}), [ev.appearanceId]: clone(ev.clue) };
        if (k.clueSince) { const { [ev.appearanceId]: _d, ...rest } = k.clueSince; k.clueSince = rest; }
      }
      break;
    }
    case 'room_found': {
      const r = world.floors[ev.floorKey]?.regions.find((x) => x.id === ev.region);
      if (r) r.found = true;
      break;
    }
    case 'pace_seen': {
      const k = world.players[ev.player]?.knowledge;
      if (!k) break;
      k.paceSeen = { ...(k.paceSeen ?? {}) };
      for (const id of ev.ids) k.paceSeen[id] = ev.turn;
      break;
    }
    case 'floor_event_cleared': {
      const f = world.floors[ev.floorKey];
      if (f) delete f.event;
      break;
    }
    case 'guardian_departed': {
      // 去った守護者の棲み処の地物を記憶から消す（V3-3c §44.1）
      const fk = ev.floor ? world.players[ev.player]?.knowledge.floors[ev.floor] : undefined;
      if (fk && ev.forget.length) {
        const del = new Set(ev.forget);
        fk.remembered = fk.remembered.filter((r) => !del.has(r.id));
      }
      break;
    }
    case 'entity_moved': {
      const e = ent(world, ev.id);
      e.pos = { floor: e.pos!.floor, x: ev.to.x, y: ev.to.y };
      break;
    }
    case 'entity_changed_floor': {
      const e = ent(world, ev.id);
      e.pos = clone(ev.to);
      if (e.actor) e.actor.nextActAt = ev.nextActAt;
      break;
    }
    case 'actor_scheduled': {
      const e = ent(world, ev.id);
      e.actor!.nextActAt = ev.nextActAt;
      e.actor!.turns = ev.turns;
      if (ev.regenAfter !== undefined) e.actor!.regen = ev.regenAfter;
      if (ev.acted && e.player && world.players[e.player]) world.players[e.player]!.lastAct = ev.turns;
      if (ev.floor && world.floors[ev.floor]?.currentActor === ev.id) world.floors[ev.floor].currentActor = null;
      break;
    }
    case 'ai_state_changed': {
      const e = ent(world, ev.id);
      e.actor!.ai = clone(ev.ai);
      e.actor!.nextActAt = ev.nextActAt;
      if (ev.dormant) e.actor!.dormant = true;
      else delete e.actor!.dormant;
      break;
    }
    case 'attack':
    case 'noise':
    case 'thought':
    case 'chat':
    case 'trap_triggered':
    case 'item_picked_up':
    case 'item_dropped':
    case 'item_equipped':
    case 'item_unequipped':
    case 'item_used':
    case 'item_thrown':
    case 'perk_offered':
    case 'perk_chosen':
    case 'perk_triggered':
    case 'monster_woke':
    case 'guardian_state':
    case 'guardian_acted':
    case 'boon_granted':
    case 'boon_triggered':
    case 'boon_offered':
    case 'story':
    case 'guardian_rested':
    case 'monster_acted':
    case 'inscription_read':
    case 'gamble_rolled':
    case 'item_altered':
    case 'ability_used':
    case 'curse_revealed':
    case 'item_inspected':
    case 'curse_lifted':
      break;
    case 'died':
      // 生存中の個体だけを追う記録の後始末（削除のみ）
      for (const pid of world.playerOrder) {
        const ds = world.players[pid].knowledge.damageSeen;
        if (ds && ev.id in ds) delete ds[ev.id];
      }
      break;
    case 'damaged':
      ent(world, ev.target).stats!.hp = ev.hpAfter;
      if (ev.seenTotals) {
        for (const [pid, total] of Object.entries(ev.seenTotals)) {
          const k = world.players[pid]?.knowledge;
          if (!k) continue;
          if (!k.damageSeen) k.damageSeen = {};
          k.damageSeen[ev.target] = total;
        }
      }
      break;
    case 'healed':
      ent(world, ev.target).stats!.hp = ev.hpAfter;
      // キャンプにいる間に落ち着いた（全快した）敵は、見た被害の記憶も戻す（resetSeen の無い古いログは今までどおり）
      if (ev.resetSeen) for (const pr of Object.values(world.players)) if (pr.knowledge.damageSeen) delete pr.knowledge.damageSeen[ev.target];
      break;
    case 'max_hp_changed': {
      const s = ent(world, ev.target).stats!;
      s.maxHp = ev.maxHpAfter;
      s.hp = ev.hpAfter;
      break;
    }
    case 'status_applied':
    case 'status_expired':
    case 'status_ticked':
      ent(world, ev.target).statuses = clone(ev.statusesAfter);
      break;
    case 'stats_changed': {
      const e = ent(world, ev.target);
      e.stats = clone(ev.statsAfter);
      if (ev.baseAfter) e.base = clone(ev.baseAfter);
      if (ev.speedAfter !== null && e.actor) e.actor.speed = ev.speedAfter;
      break;
    }
    case 'xp_gained':
      ent(world, ev.target).level!.xp = ev.xpAfter;
      break;
    case 'level_up': {
      const e = ent(world, ev.target);
      e.level = { level: ev.levelAfter, xp: ev.xpAfter };
      e.stats = clone(ev.statsAfter);
      e.base = clone(ev.baseAfter);
      break;
    }
    case 'item_identified': {
      const k = world.players[ev.player].knowledge;
      if (!k.identified.includes(ev.kind)) k.identified.push(ev.kind);
      break;
    }
    case 'feature_state':
      ent(world, ev.id).feature = { state: ev.state };
      break;
    case 'trap_revealed': {
      const tr = ent(world, ev.trap).trap!;
      if (!tr.revealedTo.includes(ev.player)) tr.revealedTo.push(ev.player);
      break;
    }
    case 'guardian_intel': {
      const p = world.players[ev.player];
      // miss: 試して外れた弱点（V3-3a §35.3）
      if (p && ev.miss) p.knowledge.guardianTried = { ...(p.knowledge.guardianTried ?? {}), [ev.guardian]: [...new Set([...(p.knowledge.guardianTried?.[ev.guardian] ?? []), ev.weakness])] };
      else if (p) p.knowledge.guardianIntel = { ...(p.knowledge.guardianIntel ?? {}), [ev.guardian]: ev.weakness };
      break;
    }
    case 'knowledge_updated': {
      const p = world.players[ev.player];
      const fk = floorKnowledge(world, ev.player, ev.floorKey);
      if (ev.visible) p.knowledge.visible = rangesToIndices(ev.visible);
      for (let i = 0; i + 1 < ev.newlySeen.length; i += 2) fk.seen[ev.newlySeen[i]] = ev.newlySeen[i + 1];
      if (ev.rememberedDel.length) {
        const del = new Set(ev.rememberedDel);
        fk.remembered = fk.remembered.filter((r) => !del.has(r.id));
      }
      for (const r of ev.rememberedSet) {
        const i = fk.remembered.findIndex((x) => x.id === r.id);
        if (i >= 0) fk.remembered[i] = clone(r);
        else fk.remembered.push(clone(r));
      }
      for (const id of ev.metAdd) p.knowledge.met.push(id);
      if (ev.metAtAfter) {
        if (!p.knowledge.metAt) p.knowledge.metAt = {};
        for (const [id, s] of Object.entries(ev.metAtAfter)) p.knowledge.metAt[id] = s;
      }
      if (ev.shotsAfter) p.knowledge.shots = [...ev.shotsAfter];
      if (ev.mappedAdd?.length) fk.mapped = [...(fk.mapped ?? []), ...ev.mappedAdd];
      if (ev.mappedDel?.length && fk.mapped) {
        const del = new Set(ev.mappedDel);
        fk.mapped = fk.mapped.filter((i) => !del.has(i));
      }
      if (ev.senseAfter !== undefined) p.knowledge.sense = ev.senseAfter ? { ...ev.senseAfter } : null;
      if (ev.hintAfter !== undefined) p.knowledge.floorHint = ev.hintAfter ? { ...ev.hintAfter } : null;
      break;
    }
    case 'item_issued':
      break;
    case 'monster_memory_updated':
      world.players[ev.player].knowledge.monsterMemory[ev.kind] = clone(ev.memoryAfter);
      break;
    case 'season_synced':
      world.season = clone(ev.seasonAfter);
      break;
    case 'stairs_reported':
      break;
    // 野営の火（S1 §9.10）: このランで置いた火・使った遠征と階の after 値
    case 'fire_placed':
      if (world.season) world.season.placed = clone(ev.placedAfter);
      break;
    case 'fire_used':
      if (world.season) world.season.fireUses = clone(ev.usesAfter);
      break;
    // 補給の置き場（S3 §25.2）: 持ち物は put・del。このランで預けた品・取った品の after 値
    case 'supply_deposited':
      if (world.season) world.season.deposited = clone(ev.depositedAfter);
      break;
    case 'supply_taken':
      if (world.season) world.season.taken = clone(ev.takenAfter);
      break;
    // 火からの帰り支度（S1c）: 状態は status_applied・status_expired と player_state が持つ
    case 'fire_return':
      break;
    case 'notes_updated':
      world.players[ev.player].knowledge.notes = clone(ev.notesAfter);
      break;
    // 指図（S8。SEASON.md §54.2・§54.6）・支度の札と希望（S9 §58.1・§58.2）: after 値の代入だけ
    case 'directive_set':
    case 'directive_prep':
      world.players[ev.player].directive = clone(ev.directiveAfter);
      break;
    // 希望（S9c）: その項目の希望と数だけを置き換える（項目ごとに 1 つ。並びは項目の順）
    case 'directive_wish': {
      const d = world.players[ev.player].directive;
      if (!d) break;
      const order = ['objective', 'loadout', 'perk', 'boon'];
      d.wishes = [...(d.wishes ?? []).filter((x) => x.item !== ev.wish.item), clone(ev.wish)].sort((a, b) => order.indexOf(a.item) - order.indexOf(b.item));
      d.wishCount = { ...(d.wishCount ?? {}), [ev.wish.item]: ev.countAfter };
      break;
    }
    case 'owner_decided':
      world.players[ev.player].ownerDecided = [...ev.decidedAfter];
      break;
    case 'expedition_offered':
      world.camp = clone(ev.camp);
      break;
    case 'archive_recalled': {
      const p = world.players[ev.player];
      if (!p) break;
      p.knowledge.archive = [...(p.knowledge.archive ?? []), ev.relic];
      if (ev.memory !== 'none') {
        const key = String(ev.depth);
        const cur = { ...(p.knowledge.wardenIntel?.[key] ?? {}) };
        if (ev.memory === 'weakness' && ev.weakness) cur.weakness = ev.weakness;
        if (ev.memory === 'vitals') { cur.hp = ev.hp; cur.maxHit = ev.maxHit; if (ev.armor !== undefined) cur.armor = ev.armor; }
        p.knowledge.wardenIntel = { ...(p.knowledge.wardenIntel ?? {}), [key]: cur };
      }
      break;
    }
    case 'floor_traits_noted':
      for (const [key, tr] of Object.entries(ev.traits)) if (world.floors[key]) world.floors[key].genTraits = [...tr];
      break;
    case 'terrain_table_extended':
      world.meta.terrainTable = [...world.meta.terrainTable, ...ev.added];
      if (ev.concealAdded.length) world.meta.concealTerrain = [...new Set([...(world.meta.concealTerrain ?? []), ...ev.concealAdded])].sort((a, b) => a - b);
      break;
    case 'floor_reset': {
      // 階を捨てる（階のエンティティは ev.del で消える）。全員のその階の地図と記憶を消す（V4-0a §1.1）
      delete world.floors[ev.floorKey];
      for (const p of Object.values(world.players)) {
        if (p.knowledge.floors[ev.floorKey]) {
          const { [ev.floorKey]: _f, ...rest } = p.knowledge.floors;
          p.knowledge.floors = rest;
        }
        if (p.knowledge.floorHint?.floor === ev.floorKey) p.knowledge.floorHint = null;
      }
      break;
    }
    case 'warden_slain': {
      const cleared = new Set(world.milestones?.cleared ?? []);
      cleared.add(ev.depth);
      world.milestones = { cleared: [...cleared].sort((a, b) => a - b) };
      break;
    }
    case 'expedition_started':
      world.expeditions = [...(world.expeditions ?? []), clone(ev.expedition)];
      world.camp = null;
      break;
    case 'objective_progress': {
      const x = expedition(world, ev.no);
      x.progress = clone(ev.progressAfter);
      x.status = ev.statusAfter;
      if (ev.targetsAfter) x.targets = clone(ev.targetsAfter);
      if (ev.extractedAfter) x.extracted = clone(ev.extractedAfter);
      break;
    }
    case 'objective_completed':
      expedition(world, ev.no).status = 'objective_complete';
      break;
    case 'haul_changed':
      expedition(world, ev.no).haul = clone(ev.haulAfter);
      break;
    case 'expedition_ended': {
      const x = expedition(world, ev.no);
      x.status = 'ended';
      x.endSeq = ev.seq;
      x.endReason = ev.reason;
      x.result = clone(ev.result);
      break;
    }
    case 'rng_advanced':
      for (const k of Object.keys(ev.states)) world.secret.rng[k] = clone(ev.states[k]);
      break;
    // 食い違ったランの続き（S3f）: 番号だけを送る（下の world.seq = ev.seq）
    case 'seq_resumed':
      break;
    default: {
      const never: never = ev;
      throw new Error(`applyEvent: unknown event ${(never as { type: string }).type}`);
    }
  }
  if (ev.put) for (const e of ev.put) world.entities[e.id] = clone(e);
  if (ev.del) for (const id of ev.del) delete world.entities[id];
  world.seq = ev.seq;
}

export function foldEvents(world: World, events: readonly GameEvent[]): World {
  for (const ev of events) applyEvent(world, ev);
  return world;
}

/** 挿入順（sid 順）のエンティティ列 */
export function entitiesInOrder(world: World): Entity[] {
  return Object.values(world.entities).sort((a, b) => a.sid - b.sid || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// エンジンの公開 API: createRun / joinPlayer / step。
// 決定論: 同じシード＋同じコマンド列（wall を含む）→ 同じイベント列。
import type { Content } from '@muse/content';
import type {
  ActionError, Command, Entity, GameEvent, JoinCommand, PlayerId, PlayerRecord, RunMeta, RunOptions, World, WorldSecret,
} from '@muse/shared';
import { actionError, emptyWorld, EVENT_VERSION, FREE_COMMANDS, MACRO_COMMANDS, Rng, t } from '@muse/shared';
import { actions, freeCommand } from './actions';
import { Ctx } from './ctx';
import { ensureFloor, findFreeCell } from './floors';
import { updateKnowledge } from './perception';
import { advance, endTurn } from './scheduler';
import { recomputeStats } from './stats';

export const ENGINE_VERSION = '0.1.0';

export interface CreateRunParams {
  runId: string;
  seed: string;
  mode?: 'solo' | 'coop';
  options?: Partial<RunOptions>;
  wall?: number;
}

export interface EngineResult { events: GameEvent[] }
export type StepResult = { ok: true; events: GameEvent[] } | { ok: false; error: ActionError; events: GameEvent[] };

function shuffleAppearances(content: Content, seed: string): Record<string, string> {
  const rng = Rng.fromSeed(`${seed}|appearances`);
  const out: Record<string, string> = {};
  const cats = [...new Set(content.lists.items.filter((i) => i.unidentified).map((i) => i.category))].sort();
  for (const cat of cats) {
    const kinds = content.lists.items.filter((i) => i.unidentified && i.category === cat).map((i) => i.id);
    const looks = rng.shuffle(content.lists.appearances.filter((a) => a.category === cat).map((a) => a.id));
    kinds.forEach((k, i) => { out[k] = looks[i]; });
  }
  return out;
}

export function createRun(content: Content, p: CreateRunParams): { world: World; events: GameEvent[] } {
  const world = emptyWorld();
  const mode = p.mode ?? 'solo';
  const meta: RunMeta = {
    runId: p.runId,
    contentVersion: content.version,
    engineVersion: ENGINE_VERSION,
    eventVersion: EVENT_VERSION,
    mode,
    createdSeq: 1,
    terrainTable: content.terrain.map((tr) => tr.id),
    options: {
      turnTimeoutMs: p.options?.turnTimeoutMs !== undefined ? p.options.turnTimeoutMs : mode === 'coop' ? 30000 : null,
      maxPlayers: p.options?.maxPlayers ?? (mode === 'coop' ? 4 : 1),
    },
  };
  const secret: WorldSecret = {
    seed: p.seed,
    rng: { runtime: Rng.fromSeed(`${p.seed}|runtime`).state(), ids: Rng.fromSeed(`${p.seed}|ids`).state() },
    appearances: shuffleAppearances(content, p.seed),
  };
  const ctx = new Ctx(world, content, null, p.wall ?? 0);
  ctx.emit({ type: 'run_started', meta, secret, seenBy: 'all', floor: null, ft: 0 });
  ensureFloor(ctx, 'main:1');
  return { world, events: ctx.finish() };
}

export function joinPlayer(world: World, content: Content, join: JoinCommand, meta: { cseq: number | null; wall: number }): { ok: true; playerId: PlayerId; events: GameEvent[] } | { ok: false; error: ActionError; events: GameEvent[] } {
  const loc = join.locale ?? 'ja';
  if (world.status === 'ended') return { ok: false, error: actionError('run_ended', t(loc, 'ランは終了している。', 'The run has ended.'), t(loc, 'new_run で新しいランを始める。', 'Start a new run with new_run.')), events: [] };
  const activePlayers = world.playerOrder.filter((pid) => world.players[pid].state === 'alive').length;
  if (activePlayers >= world.meta.options.maxPlayers) return { ok: false, error: actionError('bad_request', t(loc, 'このランは満員だ。', 'This run is full.'), t(loc, '別のランに参加するか new_run。', 'Join another run or use new_run.')), events: [] };
  const classId = join.classId ?? 'core:warrior';
  const cls = content.classes[classId];
  if (!cls) return { ok: false, error: actionError('bad_request', `unknown class ${classId}`, `classes: ${Object.keys(content.classes).join(', ')}`), events: [] };
  const ctx = new Ctx(world, content, meta.cseq, meta.wall);
  const key = 'main:1';
  const floor = ensureFloor(ctx, key);
  ctx.curFloor = key;
  ctx.now = floor.time;
  const pid = ctx.newPlayerId();
  const eid = ctx.newEntityId();
  const pos = findFreeCell(ctx, key, floor.entry);
  // 初期装備
  const items: string[] = [];
  const equip: Entity['equip'] = {};
  let slotCode = 97;
  for (const si of cls.startItems) {
    const id = ctx.newEntityId();
    const slot = String.fromCharCode(slotCode++);
    const it: Entity = { id, kind: si.item, sid: ctx.nextSid(), item: { qty: si.qty, affixes: [], heldBy: eid, slot } };
    ctx.emit({ type: 'entity_spawned', entity: it, reason: 'start_item', seenBy: [], floor: key });
    items.push(id);
    const def = content.items[si.item];
    if (si.equip && def.equip) equip[def.equip.slot] = id;
  }
  const base = { maxHp: cls.stats.hp, acc: cls.stats.acc, eva: cls.stats.eva, might: cls.stats.might, armor: cls.stats.armor, sight: cls.stats.sight, dmg: cls.unarmed };
  const entity: Entity = {
    id: eid, kind: classId, sid: ctx.nextSid(),
    pos: { floor: key, x: pos.x, y: pos.y },
    actor: { speed: cls.speed, nextActAt: floor.time, faction: 'player', turns: 0 },
    stats: { hp: cls.stats.hp, ...base },
    base,
    inv: { items, capacity: cls.capacity },
    equip,
    statuses: [],
    player: pid,
    level: { level: 1, xp: 0 },
  };
  const record: PlayerRecord = {
    id: pid, name: join.name, classId, locale: loc, controller: { ...join.controller }, entityId: eid, state: 'alive',
    joinedSeq: world.seq + 1,
    stats: { kills: 0, deepest: 1, turns: 0, deathCause: null, endedSeq: null },
    knowledge: { floors: {}, visible: [], identified: [], monsterMemory: {}, notes: [], met: [] },
  };
  ctx.emit({ type: 'player_joined', player: record, entity, seenBy: 'all', floor: key });
  recomputeStats(ctx, world.entities[eid], 'join');
  // 初期所持の未鑑定品は正体を知っている
  for (const si of cls.startItems) {
    const app = world.secret.appearances[si.item];
    if (app && !world.players[pid].knowledge.identified.includes(si.item)) {
      ctx.emit({ type: 'item_identified', player: pid, kind: si.item, appearanceId: app, seenBy: [pid], floor: key });
    }
  }
  updateKnowledge(ctx, key);
  advance(ctx, key);
  return { ok: true, playerId: pid, events: ctx.finish() };
}

export function step(world: World, content: Content, playerId: PlayerId, cmd: Command, meta: { cseq: number | null; wall: number; thought?: string }): StepResult {
  const pr = world.players[playerId];
  if (!pr) return { ok: false, error: actionError('no_session', 'no such player', 'join_run / resume_run'), events: [] };
  const L = pr.locale;
  if (world.status === 'ended') return { ok: false, error: actionError('run_ended', t(L, 'ランは終了している。', 'The run has ended.'), t(L, 'new_run で新しいランを始める。', 'Start a new run with new_run.')), events: [] };
  if (MACRO_COMMANDS.has(cmd.type)) return { ok: false, error: actionError('bad_request', 'macro commands are expanded by the server', 'submit primitive commands'), events: [] };
  const ctx = new Ctx(world, content, meta.cseq, meta.wall);
  if (FREE_COMMANDS.has(cmd.type)) {
    const me = world.entities[pr.entityId];
    const fk = me.pos?.floor ?? null;
    const err = freeCommand(ctx, pr, cmd);
    if (err) return { ok: false, error: err, events: [] };
    if (fk) advance(ctx, fk);
    return { ok: true, events: ctx.finish() };
  }
  if (pr.state !== 'alive') return { ok: false, error: actionError('dead', t(L, 'あなたは既に死んでいる。', 'You are dead.'), t(L, 'new_run で新しいランを始める。', 'Start a new run with new_run.')), events: [] };
  const e = world.entities[pr.entityId];
  const key = e.pos!.floor;
  if (world.floors[key].currentActor !== e.id) {
    return { ok: false, error: actionError('not_your_turn', t(L, 'まだあなたの番ではない。', 'It is not your turn yet.'), t(L, 'observe で手番を待つ。', 'Call observe to wait for your turn.')), events: [] };
  }
  ctx.now = e.actor!.nextActAt;
  ctx.curFloor = key;
  try {
    const prep = actions.get(cmd.type)(ctx, e, pr, cmd);
    if ('error' in prep) return { ok: false, error: prep.error, events: [] };
    if (meta.thought) ctx.emit({ type: 'thought', player: playerId, text: meta.thought.slice(0, 280), seenBy: [playerId] });
    const r = prep.run();
    const cur = world.entities[e.id];
    if (!r.scheduled && cur?.pos && world.players[playerId].state === 'alive' && world.floors[key].currentActor === e.id) endTurn(ctx, cur, r.cost);
    const after = world.entities[e.id]?.pos?.floor ?? key;
    const touched = after === key ? [key] : [key, after];
    for (const k of touched) updateKnowledge(ctx, k);
    for (const k of touched) advance(ctx, k);
    return { ok: true, events: ctx.finish() };
  } catch (err) {
    const events = ctx.finish();
    return { ok: false, error: actionError('bad_request', `internal error: ${(err as Error).message}`, 'report this bug'), events };
  }
}

/** タイムアウトなどでサーバーが投入する wait（通常コマンドとして記録される） */
export function isPlayersTurn(world: World, playerId: PlayerId): boolean {
  const pr = world.players[playerId];
  if (!pr || pr.state !== 'alive' || world.status !== 'active') return false;
  const e = world.entities[pr.entityId];
  return !!e?.pos && world.floors[e.pos.floor]?.currentActor === e.id;
}

export { endTurn };

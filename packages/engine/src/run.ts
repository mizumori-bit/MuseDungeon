// エンジンの公開 API: createRun / joinPlayer / step。
// 決定論: 同じシード＋同じコマンド列（wall を含む）→ 同じイベント列。
import type { Content } from '@muse/content';
import type {
  ActionError, Command, Entity, GameEvent, JoinCommand, LegacyMonster, MonsterMemory, PlayerId, PlayerRecord, RunMeta, RunOptions, SeasonState, SeasonSyncCommand, World, WorldSecret,
} from '@muse/shared';
import { actionError, CAMP_COMMANDS, emptyWorld, EVENT_VERSION, FREE_COMMANDS, MACRO_COMMANDS, Rng, seasonBudgetLeft, t } from '@muse/shared';
import { actions, freeCommand } from './actions';
import './abilities';
import './guardianBehaviors';
import { initialBuild } from './build';
import { Ctx } from './ctx';
import { accrueHaul, noteRooms, checkObjective, huntingInView, offerExpeditions, startExpedition, timeUp } from './expedition';
import { noteClues } from './build';
import { ensureFloor, findFreeCell } from './floors';
import { updateKnowledge } from './perception';
import { placeSeasonFires } from './campfire';
import { advance, endTurn } from './scheduler';
import { recomputeStats } from './stats';

export const ENGINE_VERSION = '0.39.0';

export interface CreateRunParams {
  runId: string;
  seed: string;
  mode?: 'solo' | 'coop';
  options?: Partial<RunOptions>;
  wall?: number;
  /** シーズンのラン（S0。SEASON.md §2）。ソロだけ */
  season?: { id: string; name: string };
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
    concealTerrain: content.terrain.map((tr, i) => (tr.tags.includes('conceal') ? i : -1)).filter((i) => i >= 0),
    options: {
      turnTimeoutMs: p.options?.turnTimeoutMs !== undefined ? p.options.turnTimeoutMs : mode === 'coop' ? 30000 : null,
      maxPlayers: p.options?.maxPlayers ?? (mode === 'coop' ? 4 : 1),
    },
    ...(p.season ? { season: { id: p.season.id, name: p.season.name } } : {}),
  };
  const secret: WorldSecret = {
    seed: p.seed,
    rng: { runtime: Rng.fromSeed(`${p.seed}|runtime`).state(), ids: Rng.fromSeed(`${p.seed}|ids`).state() },
    appearances: shuffleAppearances(content, p.seed),
  };
  const ctx = new Ctx(world, content, null, p.wall ?? 0);
  ctx.emit({ type: 'run_started', meta, secret, seenBy: 'all', floor: null, ft: 0 });
  ensureFloor(ctx, 'main:1');
  // 最初の遠征の候補（参加後に start_expedition で始める）
  offerExpeditions(ctx);
  return { world, events: ctx.finish() };
}

export function joinPlayer(world: World, content: Content, join: JoinCommand, meta: { cseq: number | null; wall: number }): { ok: true; playerId: PlayerId; events: GameEvent[] } | { ok: false; error: ActionError; events: GameEvent[] } {
  const loc = join.locale ?? 'ja';
  if (world.status === 'ended') return { ok: false, error: actionError('run_ended', t(loc, 'ランは終了している。', 'The run has ended.'), t(loc, 'new_run で新しいランを始める。', 'Start a new run with new_run.')), events: [] };
  const activePlayers = world.playerOrder.filter((pid) => world.players[pid].state === 'alive' || world.players[pid].state === 'at_camp').length;
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
    // 初期装備は呪われていないと分かっている（V3-4 §4.4）
    if (content.items[si.item]?.equip) it.item!.inspected = true;
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
  // ビルド（V3-4 §4.1）: 職業の Lv1 の特技と能動技
  initialBuild(ctx, entity, classId);
  entity.stats = { hp: entity.base!.maxHp, ...entity.base! };
  const record: PlayerRecord = {
    id: pid, name: join.name, classId, locale: loc, controller: { ...join.controller }, entityId: eid, state: 'alive',
    joinedSeq: world.seq + 1,
    stats: { kills: 0, deepest: 1, turns: 0, deathCause: null, endedSeq: null },
    knowledge: { floors: {}, visible: [], identified: [], monsterMemory: legacyMemory(content, join.legacy?.monsters ?? []), notes: [], met: [] },
  };
  // 継承（V3-7 §7.3）: 前の潜る者の覚え書き。種族の知識だけ（外見・弱点・地図・強さは引き継がない）
  const inherited = Object.keys(record.knowledge.monsterMemory).length;
  if (inherited) record.legacy = { kinds: inherited };
  ctx.emit({ type: 'player_joined', player: record, entity, seenBy: 'all', floor: key });
  recomputeStats(ctx, world.entities[eid], 'join');
  // 初期所持の未鑑定品は正体を知っている
  for (const si of cls.startItems) {
    const app = world.secret.appearances[si.item];
    if (app && !world.players[pid].knowledge.identified.includes(si.item)) {
      ctx.emit({ type: 'item_identified', player: pid, kind: si.item, appearanceId: app, seenBy: [pid], floor: key });
    }
  }
  if (join.atCamp) {
    // キャンプから始める: 盤面から外れ、最初の遠征の候補を選ぶ（再開地点は入口）
    const body = structuredClone(world.entities[eid]);
    delete body.pos;
    body.actor = { ...body.actor!, dormant: true, regen: 0 };
    ctx.emit({ type: 'player_state', player: pid, state: 'at_camp', reason: 'joined', extractPos: { floor: key, x: pos.x, y: pos.y }, put: [body], seenBy: 'all', floor: key });
    return { ok: true, playerId: pid, events: ctx.finish() };
  }
  updateKnowledge(ctx, key);
  advance(ctx, key);
  return { ok: true, playerId: pid, events: ctx.finish() };
}

/**
 * 継承した種族の知識を思い出の形にする（V3-7 §7.3）。遭遇・撃破の数はこのランの分なので 0 から。
 * 知らない種族・守護者の記録は入れない（参加コマンドの中身はサーバーが作るが、ここでも確かめる）
 */
function legacyMemory(content: Content, list: readonly LegacyMonster[]): Record<string, MonsterMemory> {
  const out: Record<string, MonsterMemory> = {};
  for (const l of [...list].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))) {
    if (!content.monsters[l.kind] || out[l.kind]) continue;
    const m: MonsterMemory = { kind: l.kind, encounters: 0, kills: 0, maxDamageToYou: l.maxHit ?? 0, maxDamageByYou: 0, abilities: [...new Set(l.abilities)].sort(), legacy: { kills: l.kills } };
    if (l.hpSeen && l.hpSeen.samples > 0 && l.hpSeen.max >= l.hpSeen.min) m.hpSeen = { ...l.hpSeen };
    if (l.rangeMax) m.rangeMax = l.rangeMax;
    out[l.kind] = m;
  }
  return out;
}

/**
 * シーズンの取り込み（S0。PROTOCOL §9.7）: サーバーが記録したシステムの命令 season_sync を、出来事 season_synced（報告なら stairs_reported も）にする。
 * 予算の at は今の自分の手番で埋める。このランで報告した階は、前の写しに報告の分を足して持ち越す。再生は記録だけで一致する
 */
export function seasonSync(world: World, content: Content, playerId: PlayerId, cmd: SeasonSyncCommand, meta: { cseq: number | null; wall: number; thought?: string }): StepResult {
  const pr = world.players[playerId];
  if (!pr) return { ok: false, error: actionError('no_session', 'no such player', 'join_run / resume_run'), events: [] };
  if (!world.meta.season || world.meta.season.id !== cmd.season.id) return { ok: false, error: actionError('bad_request', 'not a run of this season', ''), events: [] };
  const ctx = new Ctx(world, content, meta.cseq, meta.wall);
  const me = world.entities[pr.entityId];
  const turns = me?.actor?.turns ?? 0;
  const reported = [...new Set([...(world.season?.reported ?? []), ...(cmd.report?.stairs ?? []).map((x) => x.depth)])].sort((a, b) => a - b);
  const after: SeasonState = {
    id: cmd.season.id, name: cmd.season.name,
    budget: { limit: cmd.season.budget.limit, left: cmd.season.budget.left, at: turns },
    ends_at: cmd.season.ends_at, ended: cmd.season.ended,
    public: cmd.season.public.map((x) => ({ ...x })), awards: cmd.season.awards.map((a) => ({ ...a, leader: a.leader ? { ...a.leader } : null })),
    contribution: cmd.season.contribution, died: cmd.season.died, reported,
    // 野営の火（S1 §9.10）: 取り込んだ共有層の火と表示名。このランで置いた火・使った遠征と階は持ち越す
    fires: (cmd.season.fires ?? []).map((x) => ({ ...x })),
    placed: (world.season?.placed ?? []).map((x) => ({ ...x })),
    fireUses: (world.season?.fireUses ?? []).map((x) => ({ ...x })),
    ...(cmd.season.self ? { self: cmd.season.self } : {}),
  };
  if (meta.thought) ctx.emit({ type: 'thought', player: playerId, text: meta.thought.slice(0, 280), seenBy: [playerId] });
  if (cmd.report) {
    const stairs = cmd.report.stairs.map((x) => ({ ...x }));
    ctx.emit({ type: 'stairs_reported', player: playerId, stairs, gained: stairs.filter((x) => x.first).length, seenBy: [playerId], floor: null });
  }
  ctx.emit({ type: 'season_synced', player: playerId, reason: cmd.reason, seasonAfter: after, seenBy: [playerId], floor: null });
  // 共有層の火を、作ってある階のすべてに置く（まだ作っていない階には、作ったときに置く）
  for (const key of Object.keys(world.floors).sort()) placeSeasonFires(ctx, key);
  return { ok: true, events: ctx.finish() };
}

/** meta.auto: 時間切れの待機・サーバーが代わりに出した命令（V4-1j §30.6。その手番は、仲間の last_act に数えない） */
export function step(world: World, content: Content, playerId: PlayerId, cmd: Command, meta: { cseq: number | null; wall: number; thought?: string; auto?: boolean }): StepResult {
  const pr = world.players[playerId];
  if (!pr) return { ok: false, error: actionError('no_session', 'no such player', 'join_run / resume_run'), events: [] };
  const L = pr.locale;
  if (world.status === 'ended') return { ok: false, error: actionError('run_ended', t(L, 'ランは終了している。', 'The run has ended.'), t(L, 'new_run で新しいランを始める。', 'Start a new run with new_run.')), events: [] };
  if (MACRO_COMMANDS.has(cmd.type)) return { ok: false, error: actionError('bad_request', 'macro commands are expanded by the server', 'submit primitive commands'), events: [] };
  const ctx = new Ctx(world, content, meta.cseq, meta.wall);
  if (!meta.auto) ctx.selfActor = pr.entityId;
  if (FREE_COMMANDS.has(cmd.type)) {
    const me = world.entities[pr.entityId];
    const fk = me.pos?.floor ?? null;
    const err = freeCommand(ctx, pr, cmd);
    if (err) return { ok: false, error: err, events: [] };
    if (fk) advance(ctx, fk);
    return { ok: true, events: ctx.finish() };
  }
  // 階段の報告（S0）はサーバーが共有層に問い合わせて season_sync にする。engine には来ない
  if (cmd.type === 'report_stairs') return { ok: false, error: actionError('bad_request', t(L, 'report_stairs はシーズンのランのキャンプでだけ使える。', 'report_stairs works only at camp in a season run.'), ''), events: [] };
  if (CAMP_COMMANDS.has(cmd.type) && cmd.type === 'start_expedition') {
    // シーズン（S0 §9.2）: 予算が残っていない・終わりの時刻を過ぎた（キャンプで取り込んだ写し）なら始めない
    if (world.season) {
      const left = seasonBudgetLeft(world, playerId) ?? 0;
      if (left <= 0) return { ok: false, error: actionError('budget_exhausted', t(L, `このシーズンの行動予算（${world.season.budget.limit} 手番）を使い切った。新しい遠征は始められない。`, `You have used up this season's budget (${world.season.budget.limit} turns). You cannot start another expedition.`), t(L, 'キャンプでは report_stairs で階段を報告できる。ここで終えてよい。', 'At camp you can still report stairs with report_stairs. It is fine to stop here.')), events: [] };
      if (world.season.ended) return { ok: false, error: actionError('season_ended', t(L, `シーズン「${world.season.name}」は終わりの時刻を過ぎた。新しい遠征は始められない。`, `Season "${world.season.name}" has passed its end time. You cannot start another expedition.`), t(L, 'キャンプでは report_stairs で階段を報告できる。ここで終えてよい。', 'At camp you can still report stairs with report_stairs. It is fine to stop here.')), events: [] };
    }
    const err = startExpedition(ctx, pr, cmd.offer);
    if (err) return { ok: false, error: err, events: [] };
    const floors = [...new Set(world.playerOrder.map((pid) => world.entities[world.players[pid].entityId]?.pos?.floor).filter((k): k is string => !!k))].sort();
    for (const k of floors) updateKnowledge(ctx, k);
    checkObjective(ctx);
    for (const k of floors) advance(ctx, k);
    checkObjective(ctx);
    return { ok: true, events: ctx.finish() };
  }
  if (pr.state === 'at_camp') {
    return { ok: false, error: actionError('at_camp', t(L, 'あなたはキャンプにいる（盤面にいない）。', 'You are at camp (off the board).'), t(L, 'start_expedition { offer } で次の遠征を始める。ここで終えてもよい。', 'Start the next expedition with start_expedition { offer }, or stop here.')), events: [] };
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
    // 休息: 追跡中の敵が見えない状態での wait は回復が速い
    const restful = cmd.type === 'wait' && !huntingInView(ctx, pr, true);
    const r = prep.run();
    const cur = world.entities[e.id];
    if (!r.scheduled && cur?.pos && world.players[playerId].state === 'alive' && world.floors[key].currentActor === e.id) endTurn(ctx, cur, r.cost, restful);
    // シーズンの行動予算（S0 §9.2）: 残りが 0 になった手番の終わりに、その遠征は時間切れで終わる（キャンプへ。倒れた扱いにしない）
    if (world.season && world.players[playerId].state === 'alive' && world.entities[e.id]?.pos && (seasonBudgetLeft(world, playerId) ?? 1) <= 0) {
      timeUp(ctx, world.entities[e.id], world.players[playerId]);
    }
    const after = world.entities[e.id]?.pos?.floor ?? key;
    const touched = after === key ? [key] : [key, after];
    for (const k of touched) updateKnowledge(ctx, k);
    checkObjective(ctx);
    for (const k of touched) advance(ctx, k);
    checkObjective(ctx);
    noteRooms(ctx);
    noteClues(ctx, playerId);
    accrueHaul(ctx);
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

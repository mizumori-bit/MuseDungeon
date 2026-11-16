// ベースライン bot（ランダム／貪欲）。AI と同じ PlayerPort・同じ Command・同じ観測だけを使う。
// 貪欲 bot は遠征を遊ぶ: 目的を追い、達成したら階段の上で extract、キャンプでは次の遠征を選ぶ。
import type { Command, Dir, ExpeditionEndReason, OfferSlot, PlayerView } from '@muse/shared';
import { cheb, dirTo, DIRS, Rng } from '@muse/shared';
import type { PlayerPort, SessionManager } from '@muse/server';

const WEAPON_RANK = ['core:dagger', 'core:short_sword', 'core:mace', 'core:war_axe'];
const ARMOR_RANK = ['core:leather_armor', 'core:scale_mail', 'core:plate_armor'];

export type BotKind = 'greedy' | 'random';

export interface BotFloorStat {
  depth: number;
  /** 到着から下り階段を初めて知るまでの自分の手番数（見つけなければ null） */
  turnsToStairs: number | null;
  /** 到着から次の階へ進むまでの手番数（進まなければ null） */
  turnsOnFloor: number | null;
}

export interface BotResult {
  runId: string;
  seed: string;
  depth: number;
  turns: number;
  kills: number;
  level: number;
  acts: number;
  cause: string | null;
  ms: number;
  obsBriefChars: number[];
  obsFullChars: number[];
  /** 遠征の結果（通番順） */
  expeditions: { no: number; type: string; targetDepth: number | null; reason: ExpeditionEndReason | null; turns: number | null; calls: number }[];
  /** マクロ 1 回あたりの手数（判断間隔の計測用） */
  macroSteps: number[];
  floors: BotFloorStat[];
  /** スコア版 2 の確定点 */
  banked: number;
  died: boolean;
}

function hpPct(v: PlayerView): number {
  return Math.trunc((v.self.stats.hp * 100) / Math.max(1, v.self.stats.maxHp));
}

export interface BotMemo {
  restFails: number; avoid: Set<string>; blocked: number; descend: boolean; gaveUp: number | null;
  /** 方針: 目的を達成した後、目標より何階深く潜ってから帰るか */
  overreach: number;
  /** 方針: キャンプで選ぶ枠（無ければ 1 番目） */
  offerSlot?: OfferSlot;
}

export function newMemo(policy: { overreach?: number; offerSlot?: OfferSlot } = {}): BotMemo {
  return { restFails: 0, avoid: new Set<string>(), blocked: 0, descend: false, gaveUp: null, overreach: policy.overreach ?? 0, offerSlot: policy.offerSlot };
}

/** 既知の階段のうち一番近い到達可能なものへの travel（無ければ null） */
function toNearestStairs(port: PlayerPort): Command | null {
  const ks = port.observe({ map: false }).observation.navigation.known_stairs.filter((s) => s.reachable);
  if (!ks.length) return null;
  return { type: 'travel', to: ks[0].type === 'down' ? 'stairs_down' : 'stairs_up' };
}

export function greedyDecide(port: PlayerPort, rng: Rng, memo: BotMemo): Command {
  const v = port.view();
  if (v.status === 'at_camp') {
    const o = (memo.offerSlot ? v.camp?.offers.find((x) => x.slot === memo.offerSlot) : undefined) ?? v.camp?.offers[0];
    return { type: 'start_expedition', offer: o?.index ?? 'endless' };
  }
  const me = v.self;
  const pos = me.pos!;
  const hostiles = v.entities.filter((e) => e.cat === 'monster').sort((a, b) => cheb(a.pos, pos) - cheb(b.pos, pos));
  const adj = hostiles.find((h) => cheb(h.pos, pos) === 1);
  const inv = v.inventory;
  const healing = inv.find((i) => i.kind === 'core:potion_healing');
  const unknownPotion = inv.find((i) => i.kind === null && i.appearanceId?.includes('potion'));
  const unknownScroll = inv.find((i) => i.kind === null && i.appearanceId?.includes('scroll'));
  const throwable = inv.find((i) => i.kind === 'core:throwing_knife' || i.kind === 'core:javelin');
  const hp = hpPct(v);
  const x = v.expedition && v.expedition.status !== 'ended' ? v.expedition : null;
  const complete = !!x && x.status === 'objective_complete' && (x.objective.type !== 'retrieve_relic' || x.progress.relicHeldByYou);
  // 深追いの方針: 目標より overreach 階深く着くまでは帰らない。ただし余力（HP 60% 以上）が無くなったらその場で帰る
  const done = complete && (x!.objective.targetDepth === null || x!.maxDepth >= x!.objective.targetDepth + memo.overreach || (x!.maxDepth > x!.objective.targetDepth && hp < 60));
  const onTarget = !!x && x.objective.targetDepth !== null && v.floor?.depth === x.objective.targetDepth;

  if (hp < 35 && healing && (adj || hostiles.length)) return { type: 'use', slot: healing.slot };
  if (hp < 25 && unknownPotion && adj) return { type: 'use', slot: unknownPotion.slot };
  if (adj && adj.awareness !== 'asleep' || adj && hp > 50) return { type: 'move', dir: dirTo(pos, adj.pos)! };
  const hunting = hostiles.filter((h) => h.awareness === 'hunting');
  if (hunting.length && throwable && cheb(hunting[0].pos, pos) <= 6 && cheb(hunting[0].pos, pos) > 1) return { type: 'throw', slot: throwable.slot, target: hunting[0].id };
  if (hunting.length && cheb(hunting[0].pos, pos) <= 8 && !memo.avoid.has(hunting[0].id)) return { type: 'travel', to: hunting[0].id };
  // 遠征の目的
  if (done || memo.gaveUp !== null) {
    const ex = port.observe({ map: false }).observation.expedition;
    if (ex?.can_extract) return done ? { type: 'extract' } : { type: 'extract', confirm: true };
    if (!hostiles.length && hp < 50 && memo.restFails < 3) { memo.restFails++; return { type: 'rest' }; }
    const go = toNearestStairs(port);
    if (go && ex?.extract_blocked_by === 'not_on_stairs') return go;
  }
  if (x && onTarget && !done) {
    if (x.objective.type === 'slay_guardian' && !x.progress.guardianSlain) {
      const g = hostiles.find((h) => h.role === 'guardian');
      if (g && hp >= 60 && !memo.avoid.has(g.id)) return { type: 'travel', to: g.id };
    }
    if (x.objective.type === 'retrieve_relic' && !x.progress.relicHeld) {
      const here = v.entities.find((e) => e.role === 'relic' && e.pos.x === pos.x && e.pos.y === pos.y);
      if (here) return { type: 'pickup', item: here.id };
      const seen = v.entities.find((e) => e.role === 'relic') ?? v.memory.remembered.find((r) => r.role === 'relic');
      if (seen && !memo.avoid.has(seen.id) && !hunting.length) return { type: 'travel', to: seen.id };
    }
  }
  // 足元のアイテム
  if (v.entities.some((e) => e.cat === 'item' && e.pos.x === pos.x && e.pos.y === pos.y) && inv.length < me.capacity) return { type: 'pickup' };
  // 装備の更新（公開情報: 名前の序列のみ）
  for (const it of inv) {
    if (!it.kind || it.equipped) continue;
    const wr = WEAPON_RANK.indexOf(it.kind);
    const cur = inv.find((i) => i.equipped === 'weapon');
    if (wr >= 0 && (!cur || WEAPON_RANK.indexOf(cur.kind ?? '') < wr)) return { type: 'equip', slot: it.slot };
    const ar = ARMOR_RANK.indexOf(it.kind);
    const curA = inv.find((i) => i.equipped === 'armor');
    if (ar >= 0 && (!curA || ARMOR_RANK.indexOf(curA.kind ?? '') < ar)) return { type: 'equip', slot: it.slot };
  }
  // 経路が塞がれていたら一番近い敵を排除しに行く／ランダムに動いて抜ける
  if (memo.blocked > 0) {
    memo.blocked--;
    const near = hostiles.find((h) => !memo.avoid.has(h.id));
    if (near && memo.blocked > 2) return { type: 'travel', to: near.id };
    const dirs = DIRS.filter((d) => port.observe({ map: false }).observation.navigation.passable_dirs.includes(d));
    if (dirs.length) return { type: 'move', dir: rng.pick(dirs) };
  }
  if (!hostiles.length && hp < 60 && memo.restFails < 3) { memo.restFails++; return { type: 'rest' }; }
  memo.restFails = 0;
  if (!hostiles.length && unknownScroll) return { type: 'use', slot: unknownScroll.slot };
  // 見えているアイテムへ
  const item = v.entities.find((e) => e.cat === 'item' && inv.length < me.capacity && !memo.avoid.has(e.id));
  if (item && !hostiles.some((h) => h.awareness === 'hunting')) return { type: 'travel', to: item.id };
  return { type: 'explore' };
}

export function randomDecide(port: PlayerPort, rng: Rng): Command {
  const v = port.view();
  if (v.status === 'at_camp') return { type: 'start_expedition', offer: 1 };
  const r = rng.int(100);
  if (r < 25) return { type: 'explore' };
  if (r < 30) return { type: 'wait' };
  if (r < 33) return { type: 'pickup' };
  if (r < 35) return { type: 'stairs' };
  if (r < 36) return { type: 'extract', confirm: rng.chance(50) };
  if (r < 38 && v.inventory.length) return { type: 'use', slot: rng.pick(v.inventory).slot };
  return { type: 'move', dir: rng.pick(DIRS) as Dir };
}

export interface BotOptions {
  kind: BotKind;
  seed: string;
  classId?: string;
  maxActs?: number;
  maxDepth?: number;
  measureObs?: boolean;
  /** この数の遠征が終わったらキャンプで止める（既定: 止めない） */
  maxExpeditions?: number;
  /** 最初の遠征の目的（既定 auto） */
  objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' | 'endless';
  /** 方針: 達成後に深追いする階数 */
  overreach?: number;
  /** 方針: キャンプで選ぶ枠 */
  offerSlot?: OfferSlot;
}

/** 1 ランを最後まで（死亡・終了・上限）bot で遊ぶ */
export async function runBot(manager: SessionManager, opts: BotOptions): Promise<BotResult> {
  const t0 = Date.now();
  // 最初の遠征も方針の枠で選ぶ（safe=到達、standard=守護者、ambitious=遺物）
  const first = opts.objective ?? (opts.offerSlot === 'standard' ? 'slay_guardian' : opts.offerSlot === 'ambitious' ? 'retrieve_relic' : undefined);
  const r = await manager.createRun({ name: `${opts.kind}-bot`, classId: opts.classId, seed: opts.seed, controller: { kind: 'agent', label: `${opts.kind}-bot` }, objective: first });
  if ('error' in r) throw new Error(r.error.message);
  const res = await playWithPort(r.port, opts);
  return { ...res, runId: r.session.runId, seed: opts.seed, ms: Date.now() - t0 };
}

export async function playWithPort(port: PlayerPort, opts: BotOptions): Promise<Omit<BotResult, 'runId' | 'seed' | 'ms'>> {
  const rng = Rng.fromSeed(`bot|${opts.seed}`);
  const memo = newMemo({ overreach: opts.overreach, offerSlot: opts.offerSlot });
  const maxActs = opts.maxActs ?? 2500;
  const brief: number[] = [];
  const full: number[] = [];
  const macroSteps: number[] = [];
  const floors: BotFloorStat[] = [];
  const expCalls = new Map<number, number>();
  const expTurns = new Map<number, { first: number; last: number }>();
  let floorKey: string | null = null;
  let floorStart = 0;
  let stairsAt: number | null = null;
  let acts = 0;
  let explored = false;
  for (; acts < maxActs; acts++) {
    const v = port.view();
    if (v.status === 'dead' || v.status === 'ended') break;
    if (v.status === 'at_camp') {
      const doneCount = (v.expedition?.no ?? 0);
      if (opts.kind === 'greedy' && opts.maxExpeditions !== undefined && doneCount >= opts.maxExpeditions) break;
      memo.gaveUp = null;
      memo.descend = false;
      memo.restFails = 0;
      explored = false;
    } else if (v.status !== 'your_turn') { await port.waitForTurn(2000); continue; }
    if (opts.maxDepth && (v.floor?.depth ?? 0) >= opts.maxDepth) break;
    // テンポの計測（自分の手番数で数える）
    if (v.floor && v.floor.key !== floorKey) {
      if (floorKey !== null && floors.length) floors[floors.length - 1].turnsOnFloor = v.self.turns - floorStart;
      floorKey = v.floor.key;
      floorStart = v.self.turns;
      stairsAt = null;
      floors.push({ depth: v.floor.depth, turnsToStairs: null, turnsOnFloor: null });
    }
    if (v.floor && stairsAt === null) {
      const known = v.memory.terrain.some((tt) => tt && port.catalog.terrain[v.terrainTable[tt]]?.stairs === 'down');
      if (known) { stairsAt = v.self.turns - floorStart; floors[floors.length - 1].turnsToStairs = stairsAt; }
    }
    if (opts.measureObs && acts % 10 === 0) {
      brief.push(JSON.stringify(port.observe({ detail: 'brief', map: true }).observation).length);
      full.push(JSON.stringify(port.observe({ detail: 'full', map: true }).observation).length);
    }
    let cmd: Command = opts.kind === 'greedy' ? greedyDecide(port, rng, memo) : randomDecide(port, rng);
    if (cmd.type === 'explore' && explored) {
      const x = v.expedition && v.expedition.status !== 'ended' ? v.expedition : null;
      const stuckOnTarget = !!x && x.objective.targetDepth !== null && (v.floor?.depth ?? 0) >= x.objective.targetDepth
        && x.status !== 'objective_complete' && (x.objective.type === 'slay_guardian' || x.objective.type === 'retrieve_relic');
      if (stuckOnTarget) {
        // 目標階を探索し尽くしても見つからない → 撤退する
        memo.gaveUp = x!.no;
        cmd = toNearestStairs(port) ?? { type: 'wait' };
      } else {
        memo.descend = true;
        cmd = { type: 'travel', to: 'stairs_down' };
      }
    }
    const xno = v.expedition?.no ?? 0;
    expCalls.set(xno, (expCalls.get(xno) ?? 0) + 1);
    if (v.status !== 'at_camp') {
      const tt = expTurns.get(xno);
      expTurns.set(xno, { first: tt?.first ?? v.self.turns, last: v.self.turns });
    }
    const out = await port.act(cmd, { source: 'bot' });
    if (out.ok && out.steps !== undefined && cmd.type !== 'rest') macroSteps.push(out.steps);
    if (out.ok && cmd.type === 'travel' && typeof cmd.to === 'string' && cmd.to.startsWith('e_') && (out.steps ?? 0) === 0 && out.interrupted_by !== 'arrived') memo.avoid.add(cmd.to);
    if (out.ok && cmd.type === 'rest' && (out.steps ?? 0) === 0) memo.restFails = 3;
    if (out.ok && out.interrupted_by === 'blocked') memo.blocked = 5;
    if (out.ok) {
      if (cmd.type === 'explore') explored = out.interrupted_by === 'explored';
      if (memo.descend && cmd.type === 'travel' && cmd.to === 'stairs_down' && (out.interrupted_by === 'arrived' || out.observation.alerts.some((a) => a.code === 'on_stairs'))) {
        const s = await port.act({ type: 'stairs' }, { source: 'bot' });
        if (s.ok) { explored = false; memo.descend = false; }
      }
      if (cmd.type === 'travel' && cmd.to === 'stairs_down' && (out.interrupted_by === 'unknown_destination' || out.interrupted_by === 'unreachable' || out.interrupted_by === 'blocked')) { explored = false; memo.descend = false; }
    } else if (opts.kind === 'greedy') {
      // 行き詰まったら探索に戻す
      if (cmd.type === 'travel' && cmd.to === 'stairs_down') { explored = false; memo.descend = false; }
      if (port.view().status === 'your_turn') await port.act({ type: 'wait' }, { source: 'bot' });
    }
  }
  const v = port.view();
  if (v.status !== 'dead' && v.status !== 'ended' && !(opts.maxExpeditions !== undefined && v.status === 'at_camp')) await port.act({ type: 'retire' }, { source: 'bot' });
  const summary = port.summary();
  const me = summary?.players.find((p) => p.id === port.playerId);
  const w = port.view();
  const exps = (summary?.expeditions ?? []).length ? summary!.expeditions! : [];
  const expeditions = (exps.length ? exps : (w.expedition ? [{ no: w.expedition.no, objective: w.expedition.objective, endReason: w.expedition.endReason, startSeq: w.expedition.startSeq, endSeq: w.expedition.endSeq }] : []))
    .map((x) => {
      const tt = expTurns.get(x.no);
      return { no: x.no, type: x.objective.type, targetDepth: x.objective.targetDepth, reason: x.endReason, turns: tt ? tt.last - tt.first : null, calls: expCalls.get(x.no) ?? 0 };
    });
  return {
    banked: w.record.banked,
    died: w.status === 'dead' || (me?.state === 'dead'),
    depth: me?.deepest ?? w.deepestDepth,
    turns: me?.turns ?? w.self.turns,
    kills: me?.kills ?? 0,
    level: me?.level ?? w.self.level,
    acts,
    cause: me?.deathCause ?? null,
    obsBriefChars: brief,
    obsFullChars: full,
    expeditions,
    macroSteps,
    floors,
  };
}

// ベースライン bot（ランダム／貪欲）。AI と同じ PlayerPort・同じ Command・同じ観測だけを使う。
import type { Command, Dir, PlayerView } from '@muse/shared';
import { cheb, dirTo, DIRS, Rng } from '@muse/shared';
import type { PlayerPort, SessionManager } from '@muse/server';

const WEAPON_RANK = ['core:dagger', 'core:short_sword', 'core:mace', 'core:war_axe'];
const ARMOR_RANK = ['core:leather_armor', 'core:scale_mail', 'core:plate_armor'];

export type BotKind = 'greedy' | 'random';

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
}

function hpPct(v: PlayerView): number {
  return Math.trunc((v.self.stats.hp * 100) / Math.max(1, v.self.stats.maxHp));
}

export interface BotMemo { restFails: number; avoid: Set<string>; blocked: number }

export function greedyDecide(port: PlayerPort, rng: Rng, memo: BotMemo): Command {
  const v = port.view();
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

  if (hp < 35 && healing && (adj || hostiles.length)) return { type: 'use', slot: healing.slot };
  if (hp < 25 && unknownPotion && adj) return { type: 'use', slot: unknownPotion.slot };
  if (adj && adj.awareness !== 'asleep' || adj && hp > 50) return { type: 'move', dir: dirTo(pos, adj.pos)! };
  const hunting = hostiles.filter((h) => h.awareness === 'hunting');
  if (hunting.length && throwable && cheb(hunting[0].pos, pos) <= 6 && cheb(hunting[0].pos, pos) > 1) return { type: 'throw', slot: throwable.slot, target: hunting[0].id };
  if (hunting.length && cheb(hunting[0].pos, pos) <= 8 && !memo.avoid.has(hunting[0].id)) return { type: 'travel', to: hunting[0].id };
  // 足元のアイテム
  if (v.entities.some((e) => e.cat === 'item' && e.pos.x === pos.x && e.pos.y === pos.y) && inv.length < me.capacity) return { type: 'pickup' };
  // 装備の更新（公開情報: 名前の序列のみ）
  for (const it of inv) {
    if (!it.kind || it.equipped) continue;
    const wr = WEAPON_RANK.indexOf(it.kind);
    const cur = inv.find((x) => x.equipped === 'weapon');
    if (wr >= 0 && (!cur || WEAPON_RANK.indexOf(cur.kind ?? '') < wr)) return { type: 'equip', slot: it.slot };
    const ar = ARMOR_RANK.indexOf(it.kind);
    const curA = inv.find((x) => x.equipped === 'armor');
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
  void rng;
  return { type: 'explore' };
}

export function randomDecide(port: PlayerPort, rng: Rng): Command {
  const v = port.view();
  const r = rng.int(100);
  if (r < 25) return { type: 'explore' };
  if (r < 30) return { type: 'wait' };
  if (r < 33) return { type: 'pickup' };
  if (r < 35) return { type: 'stairs' };
  if (r < 37 && v.inventory.length) return { type: 'use', slot: rng.pick(v.inventory).slot };
  return { type: 'move', dir: rng.pick(DIRS) as Dir };
}

export interface BotOptions {
  kind: BotKind;
  seed: string;
  classId?: string;
  maxActs?: number;
  maxDepth?: number;
  measureObs?: boolean;
}

/** 1 ランを最後まで（死亡・終了・上限）bot で遊ぶ */
export async function runBot(manager: SessionManager, opts: BotOptions): Promise<BotResult> {
  const t0 = Date.now();
  const r = await manager.createRun({ name: `${opts.kind}-bot`, classId: opts.classId, seed: opts.seed, controller: { kind: 'agent', label: `${opts.kind}-bot` } });
  if ('error' in r) throw new Error(r.error.message);
  const res = await playWithPort(r.port, opts);
  return { ...res, runId: r.session.runId, seed: opts.seed, ms: Date.now() - t0 };
}

export async function playWithPort(port: PlayerPort, opts: BotOptions): Promise<Omit<BotResult, 'runId' | 'seed' | 'ms'>> {
  const rng = Rng.fromSeed(`bot|${opts.seed}`);
  const memo: BotMemo = { restFails: 0, avoid: new Set<string>(), blocked: 0 };
  const maxActs = opts.maxActs ?? 2500;
  const brief: number[] = [];
  const full: number[] = [];
  let acts = 0;
  let explored = false;
  for (; acts < maxActs; acts++) {
    const v = port.view();
    if (v.status === 'dead' || v.status === 'ended') break;
    if (v.status !== 'your_turn') { await port.waitForTurn(2000); continue; }
    if (opts.maxDepth && (v.floor?.depth ?? 0) >= opts.maxDepth) break;
    if (opts.measureObs && acts % 10 === 0) {
      brief.push(JSON.stringify(port.observe({ detail: 'brief', map: true }).observation).length);
      full.push(JSON.stringify(port.observe({ detail: 'full', map: true }).observation).length);
    }
    let cmd: Command = opts.kind === 'greedy' ? greedyDecide(port, rng, memo) : randomDecide(port, rng);
    if (cmd.type === 'explore' && explored) cmd = { type: 'travel', to: 'stairs_down' };
    const out = await port.act(cmd, { source: 'bot' });
    if (out.ok && cmd.type === 'travel' && typeof cmd.to === 'string' && cmd.to.startsWith('e_') && (out.steps ?? 0) === 0 && out.interrupted_by !== 'arrived') memo.avoid.add(cmd.to);
    if (out.ok && cmd.type === 'rest' && (out.steps ?? 0) === 0) memo.restFails = 3;
    if (out.ok && out.interrupted_by === 'blocked') memo.blocked = 5;
    if (out.ok) {
      if (cmd.type === 'explore') explored = out.interrupted_by === 'explored';
      if (cmd.type === 'travel' && cmd.to === 'stairs_down' && (out.interrupted_by === 'arrived' || out.observation.alerts.some((a) => a.code === 'on_stairs'))) {
        const s = await port.act({ type: 'stairs' }, { source: 'bot' });
        if (s.ok) explored = false;
      }
      if (cmd.type === 'travel' && cmd.to === 'stairs_down' && (out.interrupted_by === 'unknown_destination' || out.interrupted_by === 'unreachable' || out.interrupted_by === 'blocked')) explored = false;
    } else if (opts.kind === 'greedy') {
      // 行き詰まったら探索に戻す
      if (cmd.type === 'travel' && cmd.to === 'stairs_down') explored = false;
      await port.act({ type: 'wait' }, { source: 'bot' });
    }
  }
  const v = port.view();
  if (v.status !== 'dead' && v.status !== 'ended') await port.act({ type: 'retire' }, { source: 'bot' });
  const summary = port.summary();
  const me = summary?.players.find((p) => p.id === port.playerId);
  return {
    depth: me?.deepest ?? v.floor?.depth ?? 0,
    turns: me?.turns ?? 0,
    kills: me?.kills ?? 0,
    level: me?.level ?? v.self.level,
    acts,
    cause: me?.deathCause ?? null,
    obsBriefChars: brief,
    obsFullChars: full,
  };
}

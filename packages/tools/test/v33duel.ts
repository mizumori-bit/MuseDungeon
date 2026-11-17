// V3-3 の対戦の道具（テストと計測で共用）: 決まった形の部屋（または通路）に守護者を置き、方針ごとに戦わせて勝ち負けを数える。
import { loadContent } from '@muse/content';
import type { Command, Dir, Entity, GameEvent, PlayerView } from '@muse/shared';
import { applyEvent, cheb, DIR_VEC, DIRS, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

export const content = loadContent();

export type Outcome = 'win' | 'lose' | 'draw';

export interface DuelSpec {
  classId?: string;
  /** 地図（# 壁、. 床、P 自分、G 守護者、w 浅い水の上の守護者、F 護りの火、O 柱、~ 浅い水）。左上は (2,2) に置く */
  map: string[];
  guardian: { kind: string; hp: number; dmg: string; acc?: number; might?: number; armor?: number; speed?: number; types: string[]; weakness?: string | null; state?: 'hunting' | 'unaware' | 'asleep'; archetype?: string };
  player?: { hp?: number; acc?: number; might?: number; items?: { kind: string; qty?: number }[] };
  maxActs?: number;
}

export type Policy = (v: PlayerView, ctx: { guardianId: string; me: Entity }) => Command;

let sid = 980000;

/** 決まった形の部屋（または通路）に自分と守護者を置いた場面を作る（手番は進めない） */
export async function arena(seed: string, spec: DuelSpec) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'D', seed, classId: spec.classId ?? 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: 'auto' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const key = world.entities[meId].pos!.floor;
  const f = world.floors[key];
  const tt = world.meta.terrainTable;
  const T = { wall: tt.indexOf('core:wall'), floor: tt.indexOf('core:floor'), pillar: tt.indexOf('core:pillar'), water: tt.indexOf('core:shallow_water') };
  const ox = 2, oy = 2;
  // 周りを壁で囲った地図を書き込む（その範囲の地物・アイテム・敵は消す）
  const H = spec.map.length, W = Math.max(...spec.map.map((l) => l.length));
  const inArea = (x: number, y: number) => x >= ox - 1 && y >= oy - 1 && x <= ox + W && y <= oy + H;
  inject({ del: Object.values(world.entities).filter((e) => e.pos?.floor === key && !e.player && (e.actor || e.item || e.feature || e.trap)).map((e) => e.id) });
  let pPos = { x: ox, y: oy }, gPos = { x: ox + 1, y: oy };
  const fires: { x: number; y: number }[] = [];
  for (let y = oy - 1; y <= oy + H; y++) for (let x = ox - 1; x <= ox + W; x++) {
    if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
    const ch = spec.map[y - oy]?.[x - ox] ?? '#';
    let t = T.wall;
    if (ch === '.' || ch === 'P' || ch === 'G' || ch === 'F') t = T.floor;
    if (ch === 'O') t = T.pillar;
    if (ch === '~' || ch === 'w') t = T.water;
    f.terrain[y * f.width + x] = t;
    if (ch === 'P') pPos = { x, y };
    if (ch === 'G' || ch === 'w') gPos = { x, y };
    if (ch === 'F') fires.push({ x, y });
  }
  void inArea;
  const me = structuredClone(world.entities[meId]);
  me.pos = { floor: key, x: pPos.x, y: pPos.y };
  const hp = spec.player?.hp ?? me.stats!.maxHp;
  me.stats!.hp = hp; me.stats!.maxHp = hp; me.base!.maxHp = hp;
  if (spec.player?.acc !== undefined) me.stats!.acc = spec.player.acc;
  if (spec.player?.might !== undefined) me.stats!.might = spec.player.might;
  const put: Entity[] = [me];
  for (const it of spec.player?.items ?? []) {
    const used = new Set(me.inv!.items.map((id) => world.entities[id]?.item?.slot));
    let slot = 'a';
    for (let c = 97; c <= 122; c++) if (!used.has(String.fromCharCode(c))) { slot = String.fromCharCode(c); break; }
    const id = `e_d${(++sid).toString(36).padStart(5, '0')}`;
    put.push({ id, kind: it.kind, sid: ++sid, item: { qty: it.qty ?? 1, affixes: [], heldBy: meId, slot, inspected: true } });
    me.inv!.items.push(id);
    world.players[pid].knowledge.identified = [...new Set([...world.players[pid].knowledge.identified, it.kind])];
  }
  const g = spec.guardian;
  const gId = 'e_gd0001';
  put.push({
    id: gId, kind: g.kind, sid: ++sid, pos: { floor: key, x: gPos.x, y: gPos.y }, role: 'guardian', home: { x: gPos.x, y: gPos.y },
    actor: { speed: g.speed ?? 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: g.archetype ?? 'melee_chaser', state: g.state ?? 'hunting', targetPos: null, lostTurns: 0, params: {} }, ...(g.state === 'asleep' ? { dormant: true } : {}) },
    stats: { hp: g.hp, maxHp: g.hp, acc: g.acc ?? 4, eva: 0, might: g.might ?? 0, armor: g.armor ?? 0, sight: 8, dmg: g.dmg },
    base: { maxHp: g.hp, acc: g.acc ?? 4, eva: 0, might: g.might ?? 0, armor: g.armor ?? 0, sight: 8, dmg: g.dmg },
    statuses: [],
    guardian: { name: { ja: '試し', en: 'Trial' }, types: [...g.types], weakness: g.weakness ?? null },
  });
  for (const fp of fires) put.push({ id: `e_fr${(++sid).toString(36).padStart(4, '0')}`, kind: 'core:ward_fire', sid: ++sid, pos: { floor: key, x: fp.x, y: fp.y }, feature: { state: 'lit' } });
  inject({ put });
  // 知っている地図を部屋だけにする（視界は最初の手で更新される）
  const fk = world.players[pid].knowledge.floors[key];
  for (let y = oy - 1; y <= oy + H; y++) for (let x = ox - 1; x <= ox + W; x++) if (x >= 0 && y >= 0 && x < f.width && y < f.height) fk.seen[y * f.width + x] = f.terrain[y * f.width + x];
  delete fk.mapped;
  return { manager, r, world, pid, meId, gId, key, inject, ox, oy, W, H };
}

export async function duel(seed: string, spec: DuelSpec, policy: Policy): Promise<{ outcome: Outcome; hpLeft: number; acts: number; crits: number }> {
  const { manager, r, world, pid, meId, gId, key, inject, ox, oy, W, H } = await arena(seed, spec);
  try {
    return await fight(r, world, pid, meId, gId, key, inject, ox, oy, W, H, spec, policy);
  } finally {
    manager.closeAll();
  }
}

type Arena = Awaited<ReturnType<typeof arena>>;
async function fight(r: Arena['r'], world: Arena['world'], pid: string, meId: string, gId: string, key: string, inject: Arena['inject'], ox: number, oy: number, W: number, H: number, spec: DuelSpec, policy: Policy): Promise<{ outcome: Outcome; hpLeft: number; acts: number; crits: number }> {
  const maxActs = spec.maxActs ?? 80;
  const h0 = r.session.history.length;
  const crits = () => r.session.history.slice(h0).filter((e) => e.type === 'attack' && (e as { attacker?: string }).attacker === gId && (e as { crit?: boolean }).crit).length;
  let acts = 0;
  for (; acts < maxActs; acts++) {
    const v = projectPlayerView(world, pid);
    const meNow = world.entities[meId];
    if (!world.entities[gId]) return { outcome: 'win', hpLeft: meNow?.stats?.hp ?? 0, acts, crits: crits() };
    if (v.status === 'dead' || v.status === 'at_camp' || !meNow?.stats || meNow.stats.hp <= 0) return { outcome: 'lose', hpLeft: 0, acts, crits: crits() };
    // 徘徊は湧かせない（部屋の外から来ないように）
    inject({ del: Object.values(world.entities).filter((e) => e.pos?.floor === key && e.actor && !e.player && e.id !== gId && !inBox(e.pos, ox, oy, W, H)).map((e) => e.id) });
    if (v.status !== 'your_turn') { await r.port.act({ type: 'wait' }, { source: 'bot' }); continue; }
    const cmd = policy(v, { guardianId: gId, me: meNow });
    const res = await r.port.act(cmd, { source: 'bot' });
    if (!res.ok) await r.port.act({ type: 'wait' }, { source: 'bot' });
  }
  const meEnd = world.entities[meId];
  if (!world.entities[gId]) return { outcome: 'win', hpLeft: meEnd?.stats?.hp ?? 0, acts, crits: crits() };
  return { outcome: projectPlayerView(world, pid).status === 'dead' ? 'lose' : 'draw', hpLeft: meEnd?.stats?.hp ?? 0, acts, crits: crits() };
}

function inBox(p: { x: number; y: number }, ox: number, oy: number, W: number, H: number): boolean {
  return p.x >= ox && p.y >= oy && p.x < ox + W && p.y < oy + H;
}

export function dirTowards(from: { x: number; y: number }, to: { x: number; y: number }): Dir | null {
  const sx = Math.sign(to.x - from.x), sy = Math.sign(to.y - from.y);
  return DIRS.find((d) => DIR_VEC[d][0] === sx && DIR_VEC[d][1] === sy) ?? null;
}

/** 隣の相手を殴る（いなければ null） */
export function hitAdjacent(v: PlayerView, id: string): Command | null {
  const e = v.entities.find((x) => x.id === id);
  if (!e || !v.self.pos || cheb(e.pos, v.self.pos) > 1) return null;
  const d = dirTowards(v.self.pos, e.pos);
  return d ? { type: 'move', dir: d } : null;
}

export async function tally(seeds: number, spec: DuelSpec, policy: Policy, prefix: string): Promise<{ win: number; lose: number; draw: number; hp: number; crits: number }> {
  const out = { win: 0, lose: 0, draw: 0, hp: 0, crits: 0 };
  for (let s = 0; s < seeds; s++) {
    const r = await duel(`${prefix}-${s}`, spec, policy);
    out[r.outcome]++;
    out.hp += r.hpLeft;
    out.crits += r.crits;
  }
  return out;
}

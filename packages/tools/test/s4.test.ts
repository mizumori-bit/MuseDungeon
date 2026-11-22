// S4（討伐の記録。SEASON.md §35.5）のテスト: 載る時機・載るもの・見える所・漏れ・再生
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, buildObservation, describeTarget, formatObservationText, projectPlayerView, slayGroupText, slayObs } from '@muse/shared';
import type { Command, CommandRecord, Entity, GameEvent, PlayerView, Pos, World } from '@muse/shared';
import { verifyRunDir } from '../src/replay';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's4t';

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir, waitOthersMs: 100 } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S4試し', seed: 's4-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 6000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
/** 招いた表示名 name で、キャラクターの名前 charName のランを始める（順位と記録の名前は招いた表示名） */
async function seasonRun(m: SessionManager, name: string, charName = name) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name: charName, controller: agent, season: SID, classId: 'core:scout', profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return Object.assign(r, { ptoken: inv.token! });
}
type Run = Awaited<ReturnType<typeof seasonRun>>;
const act = (r: { port: PlayerPort }, cmd: Command) => r.port.act(cmd, { source: 'bot' });

function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
const floorOf = (r: Run) => meOf(r.session.world, r.playerId).pos!.floor;
function edit(r: Run, id: string, fn: (e: Entity) => void): void { const e = structuredClone(r.session.world.entities[id]); fn(e); inject(r.session.world, { put: [e] }); }
function clearMonsters(w: World, keepWarden = false): void {
  inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player && !(keepWarden && e.guardian?.warden)).map((e) => e.id) });
}
async function startAndClear(r: Run): Promise<void> {
  const s = await act(r, { type: 'start_expedition', offer: 1 });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(r.session.world);
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
  await new Promise((res) => setTimeout(res, 5));
}
async function descend(r: Run, keepWarden = false): Promise<void> {
  const w = r.session.world;
  const d = w.floors[floorOf(r)].stairs.down[0];
  edit(r, meOf(w, r.playerId).id, (e) => { e.pos = { floor: e.pos!.floor, x: d.x, y: d.y }; });
  clearMonsters(w, keepWarden);
  expect((await act(r, { type: 'wait' })).ok).toBe(true);
  clearMonsters(w, keepWarden);
  const s = await act(r, { type: 'stairs' });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(w, keepWarden);
}
const DIRS8: [string, number, number][] = [['e', 1, 0], ['w', -1, 0], ['s', 0, 1], ['n', 0, -1], ['se', 1, 1], ['sw', -1, 1], ['ne', 1, -1], ['nw', -1, -1]];
function openNeighbor(r: Run, p: Pos): { dir: string; at: Pos } {
  const w = r.session.world;
  const key = floorOf(r);
  const f = w.floors[key];
  for (const [dir, dx, dy] of DIRS8) {
    const x = p.x + dx, y = p.y + dy;
    const tr = content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
    if (!tr.passable || tr.stairs || tr.door) continue;
    if (Object.values(w.entities).some((e) => e.actor && e.pos?.floor === key && e.pos.x === x && e.pos.y === y)) continue;
    return { dir, at: { x, y } };
  }
  throw new Error('no open neighbor');
}

/**
 * 地下 3 階で床の鎚矛（重厚な）を拾って装備し、地下 5 階の大守護者を、投げナイフ 2 本・回復の薬 1 つ・近接で倒す（自分の一手で。記録に残る命令だけ）。
 * 大守護者の体力と回避、自分の HP は書き換える（テストの書き換えは出来事の記録に残らない）
 */
async function slayWarden5(r: Run): Promise<{ wardenId: string }> {
  await startAndClear(r);
  await descend(r);
  await descend(r);
  expect(r.session.world.floors[floorOf(r)].depth).toBe(3);
  const w = r.session.world;
  const me = meOf(w, r.playerId);
  const mace: Entity = { id: 'e_s4mace', kind: 'core:mace', sid: 990001, pos: { ...me.pos! }, item: { qty: 1, affixes: ['core:heavy'] } } as Entity;
  inject(w, { put: [mace] });
  expect((await act(r, { type: 'pickup', item: 'e_s4mace' })).ok).toBe(true);
  const slot = r.port.view().inventory.find((i) => i.id === 'e_s4mace')!.slot;
  expect((await act(r, { type: 'equip', slot })).ok).toBe(true);
  await descend(r);
  await descend(r, true);
  const key = floorOf(r);
  expect(w.floors[key].floorType).toBe('core:warden_hall');
  const warden = Object.values(w.entities).find((e) => e.pos?.floor === key && e.guardian?.warden)!;
  expect(warden).toBeTruthy();
  edit(r, meOf(w, r.playerId).id, (e) => { e.stats!.hp = 900; e.stats!.maxHp = 999; e.stats!.acc = 99; });
  const near = () => {
    const p = meOf(w, r.playerId).pos!;
    const cur = w.entities[warden.id];
    if (cur?.pos && Math.max(Math.abs(cur.pos.x - p.x), Math.abs(cur.pos.y - p.y)) === 1) return Object.entries({ e: [1, 0], w: [-1, 0], s: [0, 1], n: [0, -1], se: [1, 1], sw: [-1, 1], ne: [1, -1], nw: [-1, -1] }).find(([, v]) => v[0] === cur.pos!.x - p.x && v[1] === cur.pos!.y - p.y)![0];
    const nb = openNeighbor(r, p);
    edit(r, warden.id, (e) => { e.pos = { floor: key, ...nb.at }; });
    return nb.dir;
  };
  // 投げナイフ 2 本（1 本 5 まで）では倒れない体力
  edit(r, warden.id, (e) => { e.stats!.hp = 16; e.stats!.eva = -99; });
  clearMonsters(w, true);
  // 投げナイフを 2 本（隣の大守護者の方角へ）
  for (let i = 0; i < 2 && w.entities[warden.id]; i++) {
    const k = r.port.view().inventory.find((it) => it.kind === 'core:throwing_knife')!;
    const res = await act(r, { type: 'throw', slot: k.slot, target: near() as never });
    expect(res.ok ? '' : JSON.stringify(res.error)).toBe('');
    clearMonsters(w, true);
  }
  // 回復の薬を 1 つ
  const pot = r.port.view().inventory.find((it) => it.kind === 'core:potion_healing')!;
  expect((await act(r, { type: 'use', slot: pot.slot })).ok).toBe(true);
  // 近接で倒す
  for (let i = 0; i < 40 && w.entities[warden.id]; i++) {
    expect((await act(r, { type: 'move', dir: near() as never })).ok).toBe(true);
    clearMonsters(w, true);
  }
  expect(w.entities[warden.id]).toBeUndefined();
  expect(w.milestones?.cleared).toEqual([5]);
  return { wardenId: warden.id };
}

/** 出来事の記録から、その大守護者との戦いを数え直す（記録の作り方とは別に。倒した遠征の、その階にいた間） */
function recount(r: Run, wardenId: string) {
  const h = r.session.history;
  const meId = meOf(r.session.world, r.playerId).id;
  const kill = h.find((e) => e.type === 'warden_slain' && e.id === wardenId)!;
  const start = [...h].filter((e) => e.type === 'expedition_started' && e.seq < kill.seq).at(-1)!;
  const span = h.filter((e) => e.seq > start.seq && e.seq <= kill.seq && e.floor === 'main:5');
  const dmg = (via: string, src: boolean) => span.filter((e) => e.type === 'damaged' && e.target === wardenId && e.via === via && (!src || e.source === meId)) as Extract<GameEvent, { type: 'damaged' }>[];
  const sum = (xs: Extract<GameEvent, { type: 'damaged' }>[]) => xs.reduce((a, e) => a + (e.dealt ?? e.amount), 0);
  const melee = dmg('melee', true);
  const thrown = dmg('thrown', true);
  const poison = dmg('poison', false).filter((e) => (e.dealt ?? e.amount) > 0);
  return {
    melee: { total: sum(melee), n: melee.length }, thrown: { total: sum(thrown), n: thrown.length }, poison: { total: sum(poison), n: poison.length },
    crits: span.filter((e) => e.type === 'attack' && e.attacker === meId && e.target === wardenId && e.hit && e.crit).length,
    taken: sum(span.filter((e) => e.type === 'damaged' && e.target === meId) as Extract<GameEvent, { type: 'damaged' }>[]),
    used: span.filter((e) => e.type === 'item_used' && e.actor === meId).length,
    thrownItems: span.filter((e) => e.type === 'item_thrown' && e.actor === meId).length,
  };
}

describe('S4 §35.5: warden kill records', () => {
  it('goes out only when the slayer reaches camp; carries the facts of the fight; shows in the archive and in the warden offer of those who have not slain it; replays from the records alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s4-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya', 'Ayame');
      const b = await seasonRun(m, 'Ben');
      const { wardenId } = await slayWarden5(a);
      // 倒した者は、まだ迷宮の中: 記録は外に出ない
      expect(m.seasons.get(SID)!.slays).toEqual([]);
      expect((await act(b, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      expect(b.port.view().season!.slays).toBeUndefined();
      await lifelineHome(b);
      expect(b.port.view().season!.slays).toBeUndefined();
      // 倒した者がキャンプに着くと載る
      await lifelineHome(a);
      const recs = m.seasons.get(SID)!.slays;
      expect(recs).toHaveLength(1);
      const rec = recs[0];
      expect(rec.name).toBe('Aya');
      expect(rec.depth).toBe(5);
      expect(rec.classId).toBe('core:scout');
      expect(rec.weapon).toEqual({ kind: 'core:mace', affixes: ['core:heavy'], got: 'picked', depth: 3 });
      expect(rec.armor).toEqual({ kind: 'core:leather_armor', affixes: [], got: 'start' });
      // 数は、出来事の記録を数え直したものと合う
      const c = recount(a, wardenId);
      expect(rec.dealt.melee).toEqual(c.melee);
      expect(rec.dealt.thrown).toEqual(c.thrown);
      expect(rec.dealt.poison).toEqual(c.poison);
      expect(rec.dealt.crits).toBe(c.crits);
      expect(rec.dealt.melee.n).toBeGreaterThan(0);
      expect(rec.dealt.thrown.n).toBe(2);
      expect(rec.taken).toBe(c.taken);
      expect(rec.used).toEqual([{ kind: 'core:potion_healing', n: 1 }]);
      expect(rec.thrown).toEqual([{ kind: 'core:throwing_knife', n: 2 }]);
      expect(c.used).toBe(1);
      expect(c.thrownItems).toBe(2);
      expect(rec.attempt).toBe(1);
      expect(rec.lowestPct).toBeGreaterThanOrEqual(0);
      expect(rec.lowestPct).toBeLessThanOrEqual(100);
      const kill = a.session.history.find((e) => e.type === 'warden_slain')!;
      const meId = meOf(a.session.world, a.playerId).id;
      const startTurns = [...a.session.history].filter((e) => e.seq < kill.seq && e.type === 'actor_scheduled' && e.id === meId).at(-1) as Extract<GameEvent, { type: 'actor_scheduled' }>;
      const x0 = [...a.session.history].filter((e) => e.type === 'expedition_started' && e.seq < kill.seq).at(-1)!;
      const before = [...a.session.history].filter((e) => e.seq < x0.seq && e.type === 'actor_scheduled' && e.id === meId).at(-1) as Extract<GameEvent, { type: 'actor_scheduled' }> | undefined;
      expect(rec.turns).toBe(startTurns.turns + 1 - (before?.turns ?? 0));
      // やり直しても同じ（もう一度キャンプの書き直しが走っても、増えない）
      m.seasons.onRecovered(a.session);
      expect(m.seasons.get(SID)!.slays).toHaveLength(1);
      // 倒した者のキャンプ: 記録庫に自分の記録（あなた）。自分はもう倒したので、大守護者の候補は無い
      const oa = a.port.observe().observation;
      expect(oa.camp!.archive!.slays![0].records[0].mine).toBe(true);
      expect(formatObservationText(oa, 'ja')).toContain('記録庫・討伐の記録 地下5階');
      expect(oa.camp!.offers.some((o) => o.slays)).toBe(false);
      // 倒していない者: 次の取り込み（遠征を始める・キャンプに着く）から届く
      expect((await act(b, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      expect(b.port.view().season!.slays).toHaveLength(1);
      await lifelineHome(b);
      const vb = b.port.view();
      const sl = vb.season!.slays!;
      expect(sl[0]).toMatchObject({ depth: 5, by: 'Aya', first: true, least: true, of: 1 });
      expect(sl[0].mine).toBeUndefined();
      // 名前は招いたときの表示名（キャラクターの名前ではない）。場所の座標・ほかの参加者の今の位置・トークンは無い
      const js = JSON.stringify(sl);
      expect(js).not.toContain('Ayame');
      expect(js).not.toMatch(/"x":|"y":|"pos"/);
      expect(js).not.toContain(a.ptoken);
      expect(js).not.toContain(a.token);
      const ob = b.port.observe().observation;
      const tb = formatObservationText(ob, 'ja');      expect(tb).toContain('記録庫・討伐の記録 地下5階の大守護者');
      expect(tb).toContain('先に倒した者（倒した記録 1 件）: Aya（Lv');
      expect(tb).toContain('重厚な鎚矛（地下3階で拾った）');
      expect(tb).toContain('革鎧（最初から持っていた）');
      expect(tb).toContain(`近接 ${c.melee.n} 回・1 回あたり`);
      expect(tb).toContain('投擲 2 回');
      expect(tb).toContain('使った品: 回復の薬 1');
      expect(tb).toContain('投げた品: 投げナイフ 2');
      expect(tb).toContain('このランで 1 回目の挑戦');
      expect(slayGroupText('en', [slayObs('en', catalog, sl[0])])).toContain('first to slay it (1 recorded kill): Aya (Lv');
      // 大守護者の候補（まだ倒していない者だけ）: 候補を 1 つ大守護者を倒す遠征に書き換えて、観測を作り直す
      const withOffer = (v: PlayerView, cleared: number[]): PlayerView => {
        const w = structuredClone(v);
        w.camp!.offers = [{ ...w.camp!.offers[0], objective: { type: 'slay_warden', targetDepth: 5 } }];
        w.milestonesCleared = cleared;
        return w;
      };
      const o1 = buildObservation(withOffer(vb, []), catalog, { detail: 'full', map: false });
      expect(o1.camp!.offers[0].slays).toHaveLength(1);
      expect(o1.camp!.offers[0].text).toContain('先に倒した者（倒した記録 1 件）: Aya');
      const o2 = buildObservation(withOffer(vb, [5]), catalog, { detail: 'full', map: false });
      expect(o2.camp!.offers[0].slays).toBeUndefined();
      expect(o2.camp!.offers[0].text).not.toContain('先に倒した者');
      // HTTP の順位の表にも（位置は無い）
      expect(m.seasons.standings(SID)!.slays!.map((x) => x.by)).toEqual(['Aya']);
      // 再生は記録だけで一致する（取り込みの命令に記録の中身がある）
      const cmds = readFileSync(join(dir, b.session.runId, 'commands.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CommandRecord);
      expect(cmds.some((x) => x.command.type === 'season_sync' && (x.command.season.slays?.length ?? 0) > 0)).toBe(true);
      const v = verifyRunDir(content, join(dir, b.session.runId));
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a slayer who never gets back still shares at the end of the run; an item not identified by then is left out; first and least damage both show', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const c = await seasonRun(m, 'Cid');
    await slayWarden5(a);
    await lifelineHome(a);
    await slayWarden5(c);
    // 回復の薬を、まだ鑑定していないことにする（テストの書き換え）
    const pc = c.session.world.players[c.playerId];
    pc.knowledge.identified = pc.knowledge.identified.filter((k) => k !== 'core:potion_healing');
    // 受けた被害を少なく見せるため、A の記録の被害を大きくしておく（どちらが「いちばん少ない被害」か決まるように）
    m.seasons.get(SID)!.slays[0].taken = 999;
    expect((await act(c, { type: 'retire' })).ok).toBe(true);
    const recs = m.seasons.get(SID)!.slays;
    expect(recs.map((x) => x.name)).toEqual(['Aya', 'Cid']);
    expect(recs[1].used).toEqual([]);
    // 見せるのは、最初の 1 件（Aya）といちばん少ない被害の 1 件（Cid）
    const view = m.seasons.standings(SID)!.slays!;
    expect(view.map((x) => `${x.by}:${x.first ? 'F' : ''}${x.least ? 'L' : ''}:${x.of}`)).toEqual(['Aya:F:2', 'Cid:L:2']);
    m.closeAll();
  }, 60_000);
});

describe('S4 §42.3 の 2: unreachable names what blocks the way on the known map', () => {
  it('a locked grate on the only known way goes into details.blocked_by_terrain and the hint; without one there is nothing', async () => {
    const a = await arena('s4-grate', { map: ['P.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId] });
    const f = a.world.floors[a.key];
    const i = a.oy * f.width + a.ox + 2;
    const grate = a.world.meta.terrainTable.indexOf('core:grate_locked');
    f.terrain[i] = grate;
    a.world.players[a.pid].knowledge.floors[a.key].seen[i] = grate;
    const act2 = (cmd: Command) => a.r.port.act(cmd, { source: 'bot' });
    await act2({ type: 'wait' });
    const res = await act2({ type: 'travel', to: { x: a.ox + 4, y: a.oy } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unreachable');
      expect(res.error.details?.blocked_by_terrain).toEqual({ kind: 'core:grate_locked', pos: { x: a.ox + 2, y: a.oy } });
      expect(res.error.hint).toContain(`鍵のかかった格子扉 (${a.ox + 2},${a.oy}) が道をふさいでいる（宝物庫の鍵を持って隣で interact すると開く）。`);
    }
    // 壁の向こう（地図に無い）: 何も添えない
    const far = await act2({ type: 'travel', to: { x: a.ox + 1, y: a.oy + 3 } });
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.error.details?.blocked_by_terrain).toBeUndefined();
    a.manager.closeAll();
  });
});

describe('S4 §35.6 の 5: the kind of a floor weapon shows by name once seen (and stays in the remembered map)', () => {
  it('mace, spear and short sword on the floor are named by kind, with their visible affix', async () => {
    const a = await arena('s4-floor-kinds', { map: ['P.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId] });
    const item = (id: string, kind: string, dx: number, affixes: string[] = []): Entity => ({ id, kind, sid: 991000 + dx, pos: { floor: a.key, x: a.ox + dx, y: a.oy }, item: { qty: 1, affixes } } as Entity);
    a.inject({ put: [item('e_s4fl01', 'core:mace', 2, ['core:heavy']), item('e_s4fl02', 'core:spear', 3), item('e_s4fl03', 'core:short_sword', 4)] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const o = a.r.port.observe({ map: false }).observation;
    const names = o.visible.items.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(['重厚な鎚矛', '槍', '小剣']));
    const v = projectPlayerView(a.world, a.pid);
    expect(v.memory.remembered.filter((r) => r.id.startsWith('e_s4fl')).map((r) => r.kind).sort()).toEqual(['core:mace', 'core:short_sword', 'core:spear']);
    a.manager.closeAll();
  });
});

describe('S4 §42.3 の 1・§42.2 の 4: look gives the rust and the pack call with the numbers of the data', () => {
  it('rust slime: armor −2 for 10 turns, weapon not damaged; jackal: 7 cells', async () => {
    for (const [kind, want] of [['core:rust_slime', '10 手番のあいだ装甲 -2'], ['core:jackal', '7 マス以内']] as const) {
      const a = await arena(`s4-look-${kind}`, { map: ['PG..'], guardian: { kind, hp: 20, dmg: '1d1', types: [], state: 'asleep' } });
      // 視界は最初の手で更新される
      await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      const v = projectPlayerView(a.world, a.pid);
      expect(describeTarget(v, catalog, a.gId).text).toContain(want);
      if (kind === 'core:rust_slime') expect(describeTarget(v, catalog, a.gId).text).toContain('武器・防具そのものは傷まない');
      a.manager.closeAll();
    }
  });
});

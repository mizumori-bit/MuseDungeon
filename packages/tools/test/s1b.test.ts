// S1b（SEASON.md §12.4・§12.7）のテスト: 道しるべ・予算の終わりぎわの知らせ（シーズンのランだけ）と、
// 試運転 t0 で見つかったマクロと文の直し（すべてのラン）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SessionManager, towardNote } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, buildObservation, findPath, macroNext, macroStart, macroStopError, mapTextLines, projectPlayerView } from '@muse/shared';
import type { Command, Entity, GameEvent, Pos, World } from '@muse/shared';
import { verifyRunDir } from '../src/replay';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's1bt';

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
function openSeason(m: SessionManager, seed = 's1b-season-1', budget = 3000): void {
  m.seasons.store.open({ id: SID, name: 'S1b試し', seed, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
async function seasonRun(m: SessionManager, name: string) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: SID, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof seasonRun>>;
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
function clearMonsters(w: World): void {
  inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r.port, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}

/** A が地下 1 階の下り階段を見て（テストの中だけの書き換え）報告し、公開する */
async function publishDepth1(m: SessionManager): Promise<{ a: Run; stairs: Pos }> {
  const a = await seasonRun(m, 'Aya');
  expect((await act(a.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
  clearMonsters(a.session.world);
  const w = a.session.world;
  const f = w.floors['main:1'];
  const s = f.stairs.down[0];
  w.players[a.playerId].knowledge.floors['main:1'].seen[s.y * f.width + s.x] = f.terrain[s.y * f.width + s.x];
  await lifelineHome(a);
  const rep = await act(a.port, { type: 'report_stairs' });
  expect(rep.ok ? '' : JSON.stringify(rep.error)).toBe('');
  return { a, stairs: { x: s.x, y: s.y } };
}

/** 入口から階段までのいちばん短い道（地形だけ。テストの側で引き直す） */
function expectedTrail(w: World, key: string, to: Pos): number[] {
  const f = w.floors[key];
  const n = f.width * f.height;
  const passable = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const tr = content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[i]]]];
    if (tr.passable || tr.door === 'closed') passable[i] = 1;
  }
  const zero = new Uint8Array(n);
  const p = findPath({ width: f.width, height: f.height, passable, known: passable, occupied: zero, hazard: zero, unsighted: zero }, f.entry, [to.y * f.width + to.x], 'none');
  return [f.entry.y * f.width + f.entry.x, ...(p ?? []).map((c) => c.y * f.width + c.x)];
}

describe('S1b §12.4 の 1: the trail to published stairs', () => {
  it('a published floor carries the shortest way from the entrance on the map; travel_to stairs_down works at once; unpublished floors do not', async () => {
    const m = manager();
    openSeason(m);
    const { stairs } = await publishDepth1(m);
    const b = await seasonRun(m, 'Ben');
    const st = await act(b.port, { type: 'start_expedition', offer: 1 });
    expect(st.ok).toBe(true);
    const w = b.session.world;
    const f = w.floors['main:1'];
    const fk = w.players[b.playerId].knowledge.floors['main:1'];
    const trail = expectedTrail(w, 'main:1', stairs);
    expect(trail.length).toBeGreaterThan(5);
    const ev = b.session.history.filter((e) => e.type === 'knowledge_updated' && e.publicStairs) as Extract<GameEvent, { type: 'knowledge_updated' }>[];
    expect(ev).toHaveLength(1);
    expect(ev[0].publicPath).toBe(true);
    // 載せたのは道のマスだけ（まだ見ていないもの）。地形は自分の世界のもの
    const added = new Set(ev[0].mappedAdd ?? []);
    for (const i of added) expect(trail).toContain(i);
    for (let j = 0; j < ev[0].newlySeen.length; j += 2) expect(ev[0].newlySeen[j + 1]).toBe(f.terrain[ev[0].newlySeen[j]]);
    // 道のすべてのマスを覚えている（見た・地図に載った）
    for (const i of trail) expect(fk.seen[i]).not.toBe(0);
    expect(fk.mapped ?? []).toContain(stairs.y * f.width + stairs.x);
    // 知らせの文
    expect(b.port.formatActionText(st)).toContain('入口から階段までの道しるべと一緒に地図に載せた');
    // travel_to stairs_down が最初から通る（断られない）
    clearMonsters(w);
    const tr = await act(b.port, { type: 'travel', to: 'stairs_down' });
    expect(tr.ok ? '' : JSON.stringify(tr.error)).toBe('');
    // 公開されていない階（地下 2 階）には載らない
    const me = structuredClone(meOf(w, b.playerId)); me.pos = { floor: 'main:1', x: stairs.x, y: stairs.y }; inject(w, { put: [me] });
    expect((await act(b.port, { type: 'stairs' })).ok).toBe(true);
    expect(b.session.history.some((e) => e.type === 'knowledge_updated' && e.publicStairs && e.floorKey === 'main:2')).toBe(false);
    const f2 = w.floors['main:2'];
    const fk2 = w.players[b.playerId].knowledge.floors['main:2'];
    expect((fk2.mapped ?? []).length).toBe(0);
    expect(fk2.seen[f2.stairs.down[0].y * f2.width + f2.stairs.down[0].x]).toBe(0);
    m.closeAll();
  });

  it('a hidden trap on the way does not change the trail; a blocked floor gets only the stairs cell and travel_to is refused with the draft hint', async () => {
    const m = manager();
    openSeason(m, 's1b-season-2');
    const { stairs } = await publishDepth1(m);
    // 隠れた罠: B の世界の地下 1 階の道の上に、まだ見つけていない罠を置いてから遠征を始める
    const b = await seasonRun(m, 'Ben');
    // 地下 1 階は参加の時点では作られていないことがあるので、作られていれば罠を置く
    const exp0 = b.session.world.floors['main:1'];
    if (exp0) {
      const trail0 = expectedTrail(b.session.world, 'main:1', stairs);
      const c = trail0[Math.trunc(trail0.length / 2)];
      inject(b.session.world, { put: [{ id: 'e_s1btr1', kind: 'core:trap_dart', sid: 997001, pos: { floor: 'main:1', x: c % exp0.width, y: Math.trunc(c / exp0.width) }, trap: { revealedTo: [] } } as unknown as Entity] });
    }
    expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const wb = b.session.world;
    const trail = expectedTrail(wb, 'main:1', stairs);
    const evB = b.session.history.find((e) => e.type === 'knowledge_updated' && e.publicStairs) as Extract<GameEvent, { type: 'knowledge_updated' }>;
    const fk = wb.players[b.playerId].knowledge.floors['main:1'];
    for (const i of trail) expect(fk.seen[i]).not.toBe(0);
    for (const i of evB.mappedAdd ?? []) expect(trail).toContain(i);
    // 道がふさがれた世界（テストで階段のまわりを壁にする）: 階段のマスだけ
    const c = await seasonRun(m, 'Cid');
    const wc = c.session.world;
    const cf = wc.floors['main:1'];
    if (!cf) throw new Error('main:1 not generated at join');
    const wall = wc.meta.terrainTable.indexOf('core:wall');
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = stairs.x + dx, y = stairs.y + dy;
      if (x >= 0 && y >= 0 && x < cf.width && y < cf.height) cf.terrain[y * cf.width + x] = wall;
    }
    const stC = await act(c.port, { type: 'start_expedition', offer: 1 });
    expect(stC.ok).toBe(true);
    const evC = c.session.history.find((e) => e.type === 'knowledge_updated' && e.publicStairs) as Extract<GameEvent, { type: 'knowledge_updated' }>;
    expect(evC.publicPath).toBeUndefined();
    expect(evC.mappedAdd).toEqual([stairs.y * cf.width + stairs.x]);
    expect(c.port.formatActionText(stC)).toContain('地図に載せた（途中の道はまだ分からない）');
    clearMonsters(wc);
    const tr = await act(c.port, { type: 'travel', to: 'stairs_down' });
    expect(!tr.ok && tr.error.code).toBe('unreachable');
    if (!tr.ok) expect(tr.error.hint).toContain("explore { toward: 'draft' }");
    m.closeAll();
  });

  it('published mid-expedition shows only from the next expedition; a season run with the trail replays from its records; a plain run has no trail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s1b-'));
    try {
      const m = manager(dir);
      openSeason(m, 's1b-season-3');
      const b = await seasonRun(m, 'Ben');
      expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      const { stairs } = await publishDepth1(m);
      // 遠征の途中の B にはまだ載らない
      expect(b.session.history.some((e) => e.type === 'knowledge_updated' && e.publicStairs)).toBe(false);
      // 綱で帰って、次の遠征で載る（記録に残る命令だけで遊ぶ）
      const life = b.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
      expect((await act(b.port, { type: 'use', slot: life.slot })).ok).toBe(true);
      for (let i = 0; i < 20 && b.port.view().status !== 'at_camp'; i++) await act(b.port, { type: 'wait' });
      expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      const f = b.session.world.floors['main:1'];
      const fk = b.session.world.players[b.playerId].knowledge.floors['main:1'];
      const seenBefore = (fk.seen[stairs.y * f.width + stairs.x] ?? 0) !== 0;
      if (!seenBefore || b.session.history.some((e) => e.type === 'knowledge_updated' && e.publicStairs)) {
        const ev = b.session.history.find((e) => e.type === 'knowledge_updated' && e.publicStairs) as Extract<GameEvent, { type: 'knowledge_updated' }> | undefined;
        expect(ev?.publicPath).toBe(true);
      }
      await act(b.port, { type: 'travel', to: 'stairs_down' });
      await b.port.act({ type: 'retire' }, { source: 'bot' });
      const v = verifyRunDir(content, join(dir, b.session.runId));
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
      // シーズンでないランには道しるべも公開の知らせも無い
      const plain = await m.createRun({ name: 'P', seed: 's1b-season-3', controller: agent });
      if ('error' in plain) throw new Error(plain.error.message);
      expect((await plain.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
      expect(plain.session.history.some((e) => e.type === 'knowledge_updated' && (e.publicStairs || e.publicPath))).toBe(false);
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S1b §12.4 の 2: the budget alert near the end', () => {
  it('shows below twice the steps to the nearest reachable stairs, or under 100 turns; says so when no stairs are reachable', async () => {
    const m = manager();
    openSeason(m, 's1b-season-1');
    const { stairs } = await publishDepth1(m);
    const b = await seasonRun(m, 'Ben');
    expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    clearMonsters(b.session.world);
    const base = b.port.view();
    const o0 = buildObservation(base, catalog, { detail: 'brief', map: false });
    const down = o0.navigation.known_stairs.find((s) => s.type === 'down' && s.path_len !== null)!;
    expect(down.pos).toEqual(stairs);
    const steps = down.path_len!;
    expect(steps * 2).toBeLessThan(100);
    const alertAt = (left: number, v = base) => {
      const view = structuredClone(v);
      view.season!.budgetLeft = left;
      return buildObservation(view, catalog, { detail: 'brief', map: false }).alerts.find((a) => a.code === 'budget_low');
    };
    // 100 を切ったら、いつも出る（階段までの歩数つき）。100 ちょうどなら出ない（ここでは階段までの歩数の 2 倍が 100 より小さい）
    const a99 = alertAt(99);
    expect(a99?.text).toBe(`予算の残り 99 手番。いちばん近い着ける階段（下り階段）まで ${steps} 歩（尽きると時間切れで、未確定の戦利品を失う）`);
    expect(a99?.data).toEqual({ left: 99, stairs: 'down', path_len: steps });
    expect(alertAt(100)).toBeUndefined();
    // 2 倍の決まり: 階段から遠い見え方（覚えている地図を、端から端へ折り返す長い通路だけにする）で、境目の前後
    const snake = structuredClone(base);
    const sf = snake.floor!;
    const T = (id: string) => snake.terrainTable.indexOf(id);
    snake.memory.terrain = new Array(sf.width * sf.height).fill(T('core:wall'));
    let end: Pos = { x: 1, y: 1 };
    for (let y = 1; y < sf.height - 1; y += 2) {
      for (let x = 1; x < sf.width - 1; x++) snake.memory.terrain[y * sf.width + x] = T('core:floor');
      end = { x: ((y - 1) / 2) % 2 === 0 ? sf.width - 2 : 1, y };
      if (y + 2 < sf.height - 1) snake.memory.terrain[(y + 1) * sf.width + end.x] = T('core:floor');
    }
    snake.memory.terrain[end.y * sf.width + end.x] = T('core:stairs_down');
    snake.self.pos = { x: 1, y: 1 };
    snake.entities = [];
    delete snake.memory.unsighted;
    const far = buildObservation(snake, catalog, { detail: 'brief', map: false }).navigation.known_stairs[0].path_len!;
    expect(far * 2).toBeGreaterThan(200);
    expect(alertAt(far * 2 - 1, snake)?.text).toContain(`まで ${far} 歩`);
    expect(alertAt(far * 2, snake)).toBeUndefined();
    // 着ける階段が分からない: 覚えている地図から階段を消した見え方
    const noStairs = structuredClone(base);
    const f = noStairs.floor!;
    noStairs.memory.terrain[stairs.y * f.width + stairs.x] = noStairs.terrainTable.indexOf('core:floor');
    const an = alertAt(80, noStairs);
    expect(an?.text).toBe('予算の残り 80 手番。着ける階段が分からない（既知の道で届く階段が無い。尽きると時間切れで、未確定の戦利品を失う）');
    expect(alertAt(150, noStairs)).toBeUndefined();
    // キャンプとシーズンでないランには出ない
    await lifelineHome(b);
    expect(b.port.observe().observation.alerts.some((a) => a.code === 'budget_low')).toBe(false);
    m.closeAll();
  });
});

// ---- すべてのランに同じに効く直し（§12.4 の 3〜9） ----

type Ar = Awaited<ReturnType<typeof arena>>;
let esid = 998000;
const monAt = (a: Ar, id: string, kind: string, x: number, y: number, state: 'hunting' | 'asleep' | 'unaware', o: { hp?: number; dmg?: string; archetype?: string } = {}): Entity => ({
  id, kind, sid: ++esid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y },
  actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: o.archetype ?? 'melee_chaser', state, targetPos: null, lostTurns: 0, params: {} }, ...(state === 'asleep' ? { dormant: true } : {}) },
  stats: { hp: o.hp ?? 20, maxHp: o.hp ?? 20, acc: 0, eva: 0, might: 0, armor: 0, sight: 2, dmg: o.dmg ?? '1d1' },
  base: { maxHp: o.hp ?? 20, acc: 0, eva: 0, might: 0, armor: 0, sight: 2, dmg: o.dmg ?? '1d1' },
  statuses: [],
} as unknown as Entity);
/** 種族を見たことにする（初見の種族で止まらないように） */
function knowKind(a: Ar, kind: string, maxDamageToYou = 0): void {
  a.world.players[a.pid].knowledge.monsterMemory[kind] = { kind, encounters: 1, kills: 0, maxDamageToYou, maxDamageByYou: 0, abilities: [] };
}
const posOf = (a: Ar) => ({ x: a.world.entities[a.meId].pos!.x - a.ox, y: a.world.entities[a.meId].pos!.y - a.oy });
/** 見え方から、その者を見えていないことにする（そのマスも視界から外す。見えなくなった、を作る） */
function hide(v: ReturnType<typeof projectPlayerView>, id: string, cellToo = true) {
  const out = structuredClone(v);
  const e = out.entities.find((x) => x.id === id)!;
  out.entities = out.entities.filter((x) => x.id !== id);
  if (cellToo) out.visibleCells = out.visibleCells.filter((i) => i !== e.pos.y * out.floor!.width + e.pos.x);
  return out;
}

describe('S1b §12.4 の 3: travel_to no longer stops halfway when a lasting obstacle turns the route', () => {
  it('a stationary monster seen in the short corridor: travel takes the long way to the end instead of no_progress after 20 steps (t0: Tokiwa, depth 4)', async () => {
    const W = 30;
    const a = await arena('s1b-mold', { map: ['P' + '.'.repeat(W - 1), '.' + '#'.repeat(W - 2) + '.', '.' + '#'.repeat(W - 2) + '.', '.'.repeat(W)], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId], put: [monAt(a, 'e_s1bm01', 'core:spore_mold', 25, 0, 'unaware', { archetype: 'stationary' })] });
    knowKind(a, 'core:spore_mold');
    const res = await a.r.port.act({ type: 'travel', to: { x: a.ox + W - 1, y: a.oy } }, { source: 'bot' });
    expect(res.ok ? res.interrupted_by : JSON.stringify(res.error)).toBe('arrived');
    expect(posOf(a)).toEqual({ x: W - 1, y: 0 });
    // 遠回りした（毒カビの手前で引き返し、下の通路を回った）
    expect(res.ok && res.steps!).toBeGreaterThan(W + 10);
    a.manager.closeAll();
  });

  it('a monster seen asleep keeps blocking its cell after it goes out of sight; forgotten once the cell is seen empty; blocked names it (t0: Ruri, depth 16)', async () => {
    const a = await arena('s1b-sleeper', { map: ['P...........', '.##########.', '............'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId], put: [monAt(a, 'e_s1bz01', 'core:cave_troll', 6, 0, 'asleep')] });
    knowKind(a, 'core:cave_troll');
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const goal = { x: a.ox + 11, y: a.oy };
    const v1 = projectPlayerView(a.world, a.pid);
    expect(v1.entities.some((e) => e.id === 'e_s1bz01' && e.awareness === 'asleep')).toBe(true);
    const st = macroStart(v1, { type: 'travel', to: goal }, catalog);
    // 見えている: 眠っている敵のマスを避けて、下の通路へ
    expect(macroNext(st, v1, catalog, [])).toEqual({ command: { type: 'move', dir: 's' } });
    // 見えなくなっても、そのマスをふさいでいるものとする（覚えていなければ、まっすぐ東へ戻っていた）
    const vGone = hide(v1, 'e_s1bz01');
    expect(macroNext(macroStart(vGone, { type: 'travel', to: goal }, catalog), vGone, catalog, [])).toEqual({ command: { type: 'move', dir: 'e' } });
    expect(macroNext(st, vGone, catalog, [])).toEqual({ command: { type: 'move', dir: 's' } });
    expect(st.sleepers?.map((s) => s.id)).toEqual(['e_s1bz01']);
    // そのマスが見えていて、いなければ忘れる
    const vEmpty = hide(v1, 'e_s1bz01', false);
    expect(macroNext(st, vEmpty, catalog, [])).toEqual({ command: { type: 'move', dir: 'e' } });
    expect(st.sleepers ?? []).toEqual([]);
    a.manager.closeAll();
  });

  it('when the sleeper is the only way, blocked names it even out of sight', async () => {
    const a = await arena('s1b-sleeper2', { map: ['P...........'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId], put: [monAt(a, 'e_s1bz02', 'core:cave_troll', 6, 0, 'asleep')] });
    knowKind(a, 'core:cave_troll');
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const goal = { x: a.ox + 11, y: a.oy };
    const v1 = projectPlayerView(a.world, a.pid);
    const st = macroStart(v1, { type: 'travel', to: goal }, catalog);
    const d1 = macroNext(st, v1, catalog, []);
    expect('stop' in d1 && d1.stop).toBe('blocked');
    const d2 = macroNext(st, hide(v1, 'e_s1bz02'), catalog, []);
    expect(d2).toEqual({ stop: 'blocked', blockedBy: [{ id: 'e_s1bz02', name: '洞窟トロル' }] });
    a.manager.closeAll();
  });
});

describe('S1b §12.4 の 4: explore toward', () => {
  /** 東半分をまだ見ていない部屋（境界は東だけ） */
  async function room(seed: string, west = false) {
    const a = await arena(seed, { map: Array.from({ length: 7 }, () => '.'.repeat(30)), guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId] });
    const me = structuredClone(a.world.entities[a.meId]); me.pos = { ...me.pos!, x: a.ox + 15, y: a.oy + 3 }; a.inject({ put: [me] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const f = a.world.floors[a.key];
    const fk = a.world.players[a.pid].knowledge.floors[a.key];
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
      const rx = x - a.ox;
      if (west ? rx < 8 : rx > 22) fk.seen[y * f.width + x] = 0;
    }
    return a;
  }
  const withDraft = (v: ReturnType<typeof projectPlayerView>, draft: 'e' | 'w' | null) => { const o = structuredClone(v); o.floorHint = { floor: o.floor!.key, draft, explored: 1 }; return o; };

  it('toward: draft stops (stairs_seen) once the draft vanishes, i.e. the published stairs were seen (t0: walked past them 30 steps west); flee and plain explore go on', async () => {
    const a = await room('s1b-draft');
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'explore', toward: 'draft' }, catalog);
    expect('command' in macroNext(st, withDraft(v, 'e'), catalog, [])).toBe(true);
    expect(macroNext(st, withDraft(v, null), catalog, [])).toEqual({ stop: 'stairs_seen' });
    const fl = macroStart(v, { type: 'explore', toward: 'draft', mode: 'flee' }, catalog);
    macroNext(fl, withDraft(v, 'e'), catalog, []);
    expect('command' in macroNext(fl, withDraft(v, null), catalog, [])).toBe(true);
    const plain = macroStart(v, { type: 'explore' }, catalog);
    macroNext(plain, withDraft(v, 'e'), catalog, []);
    expect('command' in macroNext(plain, withDraft(v, null), catalog, [])).toBe(true);
    a.manager.closeAll();
  });

  it('counts the steps with no reachable edge toward the hint, and the result says why it walked another way', async () => {
    const a = await room('s1b-toward', true);
    const v = withDraft(projectPlayerView(a.world, a.pid), 'e');
    const st = macroStart(v, { type: 'explore', toward: 'draft' }, catalog);
    const d = macroNext(st, v, catalog, []);
    expect('command' in d && d.command.type === 'move' && ['w', 'nw', 'sw'].includes(d.command.dir)).toBe(true);
    expect(st.towardNoAlong).toBe(1);
    expect(st.towardDir).toBe('e');
    const start = { x: 15, y: 3 };
    expect(towardNote('ja', { kind: 'draft', dir: 'e', start, noAlong: 4, detour: 0 }, { x: 10, y: 3 })).toBe('下への風の方角（東）に、行ける未探索の境界が無い手が 4 手あった（その間は、ほかの方角の近い境界を探した）。');
    expect(towardNote('ja', { kind: 'sense', dir: 'sw', start, noAlong: 0, detour: 2 }, { x: 18, y: 3 })).toBe('気配の方角（南西）の境界は遠回りなので、近くの境界を先に見た（2 回）。');
    expect(towardNote('ja', { kind: 'sense', dir: 'e', start, noAlong: 0, detour: 0 }, { x: 15, y: 0 })).toBe('気配の方角（東）の境界へは、分かっている道が回り込んでいるので、始めた所から北へ進んだ。');
    expect(towardNote('ja', { kind: 'sense', dir: 'e', start, noAlong: 0, detour: 0 }, { x: 19, y: 2 })).toBe('');
    // 実際の呼び出しの文にも出る
    const a2 = await room('s1b-toward2', true);
    const f = a2.world.floors[a2.key];
    a2.world.players[a2.pid].knowledge.floorHint = { floor: a2.key, draft: 'e', explored: 1 };
    void f;
    const res = await a2.r.port.act({ type: 'explore', toward: 'draft', maxSteps: 3 }, { source: 'bot' });
    expect(res.ok && res.outcome).toContain('行ける未探索の境界が無い手が');
    a.manager.closeAll();
    a2.manager.closeAll();
  });

  it('max_steps stops explore after that many steps (max_turns)', async () => {
    const a = await room('s1b-maxsteps');
    const res = await a.r.port.act({ type: 'explore', maxSteps: 3 }, { source: 'bot' });
    expect(res.ok && res.steps).toBe(3);
    expect(res.ok && res.interrupted_by).toBe('max_turns');
    expect(res.ok && res.outcome).toContain('指定した手数に達した');
    a.manager.closeAll();
  });
});

describe('S1b §12.4 の 5: fight with a thrown item does not walk away from an adjacent hunter to pick up', () => {
  it('out of ammo with the target adjacent: refuses (out_of_ammo) instead of stepping to the javelin on the floor; with nobody adjacent it still goes to fetch it', async () => {
    const a = await arena('s1b-retrieve', { map: ['..........', '....P.....', '..........'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { floor: a.key, x: a.ox + 5, y: a.oy + 1 };
    const jav: Entity = { id: 'e_s1bj01', kind: 'core:javelin', sid: ++esid, pos: { floor: a.key, x: a.ox + 0, y: a.oy + 1 }, item: { qty: 1, affixes: [], thrownBy: a.pid } } as unknown as Entity;
    a.inject({ put: [g, jav] });
    a.world.players[a.pid].knowledge.identified.push('core:javelin');
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const g2 = structuredClone(a.world.entities[a.gId]); g2.pos = { floor: a.key, x: a.ox + 5, y: a.oy + 1 }; g2.actor!.ai!.state = 'hunting'; a.inject({ put: [g2] });
    const me2 = structuredClone(a.world.entities[a.meId]); me2.pos = { floor: a.key, x: a.ox + 4, y: a.oy + 1 }; a.inject({ put: [me2] });
    const before = posOf(a);
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'fight', target: a.gId, with: 'javelin', adjacent: 'throw' }, catalog);
    expect(macroNext(st, v, catalog, [])).toEqual({ stop: 'out_of_ammo' });
    expect(st.retrieveHeld).toBe(true);
    const res = await a.r.port.act({ type: 'fight', target: a.gId, with: 'javelin', adjacent: 'throw' }, { source: 'bot' });
    expect(!res.ok && res.error.code).toBe('cannot_use');
    if (!res.ok) expect(res.error.hint).toContain('隣に追ってくる敵がいない間だけ拾いに行く');
    expect(posOf(a)).toEqual(before);
    // 隣にいなければ、今までどおり拾いに行く
    const g3 = structuredClone(a.world.entities[a.gId]); g3.pos = { floor: a.key, x: a.ox + 9, y: a.oy + 1 }; a.inject({ put: [g3] });
    const v3 = projectPlayerView(a.world, a.pid);
    const st3 = macroStart(v3, { type: 'fight', target: a.gId, with: 'javelin' }, catalog);
    const d3 = macroNext(st3, v3, catalog, []);
    expect('command' in d3 && d3.command.type === 'move' && ['w', 'nw', 'sw'].includes(d3.command.dir)).toBe(true);
    expect(macroStopError('ja', 'out_of_ammo', { type: 'fight', target: a.gId, with: 'javelin' }).hint).toContain('隣の相手と戦うなら fight { target }');
    a.manager.closeAll();
  });
});

describe('S1b §12.4 の 6: the map ruler', () => {
  it('writes the tens digit only over multiples of 10 (a map starting at x=1 had a 0 over its first column and was read one column off)', () => {
    const lines = mapTextLines({ origin: { x: 1, y: 0 }, rows: ['#'.repeat(25)], legend: {} });
    expect(lines[0]).toBe('  ' + ' '.repeat(9) + '1' + ' '.repeat(9) + '2');
    expect(lines[1]).toBe('  1234567890123456789012345');
    // 10 の倍数が無い狭い地図だけ、左端に 10 の位
    expect(mapTextLines({ origin: { x: 11, y: 0 }, rows: ['#'.repeat(8)], legend: {} })[0]).toBe('  1');
    expect(mapTextLines({ origin: { x: 20, y: 0 }, rows: ['#'.repeat(12)], legend: {} })[0]).toBe('  2         3');
  });
});

describe('S1b §12.4 の 7: fight approach advance on a target that has not noticed you', () => {
  it('without approach it refuses and says how; with approach: advance it walks up and strikes; if the target wakes on the way it goes on', async () => {
    const a = await arena('s1b-advance', { map: ['P......G'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    knowKind(a, 'core:goblin', 1);
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    sleepAgain(a);
    expect(projectPlayerView(a.world, a.pid).entities.find((e) => e.id === a.gId)?.awareness).toBe('asleep');
    const no = await a.r.port.act({ type: 'fight', target: a.gId }, { source: 'bot' });
    expect(!no.ok && no.error.code).toBe('no_target');
    if (!no.ok) expect(no.error.hint).toContain("fight { target, approach: 'advance' }");
    // 途中で気づかれても続ける（見え方だけを書き換えて判断を見る）
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'fight', target: a.gId, approach: 'advance' }, catalog);
    expect(macroNext(st, v, catalog, [])).toEqual({ command: { type: 'move', dir: 'e' } });
    const awake = structuredClone(v); awake.entities.find((e) => e.id === a.gId)!.awareness = 'hunting';
    expect(macroNext(st, awake, catalog, [])).toEqual({ command: { type: 'move', dir: 'e' } });
    // 実際に寄って殴る
    const n0 = a.r.session.history.length;
    const res = await a.r.port.act({ type: 'fight', target: a.gId, approach: 'advance' }, { source: 'bot' });
    expect(res.ok ? '' : JSON.stringify(res.error)).toBe('');
    expect(a.r.session.history.slice(n0).some((e) => e.type === 'attack' && (e as { attacker?: string }).attacker === a.meId && (e as { target?: string }).target === a.gId)).toBe(true);
    a.manager.closeAll();
  });

  it('measures getting closer to a quiet target along the path (walking around a wall is not target_moved)', async () => {
    const a = await arena('s1b-advance2', { map: ['P#....', '.#....', '.#.G..', '.#....', '......'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    knowKind(a, 'core:goblin', 1);
    // 壁の代わりに瓦礫（見通せるが通れない）にする: 相手は見えたまま、道は回り込む
    const f = a.world.floors[a.key];
    const fk = a.world.players[a.pid].knowledge.floors[a.key];
    const rubble = a.world.meta.terrainTable.indexOf('core:rubble');
    for (let y = 0; y < 4; y++) { const i = (a.oy + y) * f.width + a.ox + 1; f.terrain[i] = rubble; fk.seen[i] = rubble; }
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    sleepAgain(a);
    // 壁の脇を南へ下る間は直線の距離が縮まない（直線の距離で数えると 3 手で target_moved になっていた）
    let v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'fight', target: a.gId, approach: 'advance' }, catalog);
    for (let i = 0; i < 4; i++) {
      const d = macroNext(st, v, catalog, []);
      expect('command' in d ? d.command.type : d.stop).toBe('move');
      if (!('command' in d) || d.command.type !== 'move') break;
      const r = await a.r.port.act(d.command, { source: 'bot' });
      expect(r.ok).toBe(true);
      sleepAgain(a);
      v = projectPlayerView(a.world, a.pid);
    }
    a.manager.closeAll();
  });
});

/** 相手を眠らせ直す（テストの中だけ。待つ手で起きることがあるので） */
function sleepAgain(a: Ar): void {
  const g = structuredClone(a.world.entities[a.gId]);
  g.actor = { ...g.actor!, dormant: true, ai: { ...g.actor!.ai!, state: 'asleep', targetPos: null } } as never;
  a.inject({ put: [g] });
}

describe('S1b §12.4 の 8: texts', () => {
  it('the fountain says how much it restores; identify without target_slot says how to choose; the flee estimate counts the adjacent hitter; the expedition start says where you are and which way the objective is', async () => {
    const fd = catalog.features['core:fountain']?.desc;
    expect(fd?.ja).toContain('3d6+2');
    expect(fd?.ja).toContain('全快ではない');
    // 鑑定の巻物: 未鑑定の品が 2 つあるのに対象なしで読んだ
    const a = await arena('s1b-identify', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, items: [{ kind: 'core:scroll_identify' }, { kind: 'core:potion_haste' }, { kind: 'core:potion_vigor' }] } });
    a.inject({ del: [a.gId] });
    const pk = a.world.players[a.pid].knowledge;
    pk.identified = pk.identified.filter((k) => k !== 'core:potion_haste' && k !== 'core:potion_vigor');
    const scroll = projectPlayerView(a.world, a.pid).inventory.find((i) => i.kind === 'core:scroll_identify')!;
    const u = await a.r.port.act({ type: 'use', slot: scroll.slot }, { source: 'bot' });
    expect(u.ok && u.outcome).toContain('target_slot');
    a.manager.closeAll();
    // 逃げの見込み: 隣の追跡中の敵が離れぎわに殴る 1 回を含むと書く
    const b = await arena('s1b-flee', { map: ['P.......'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 100 } });
    knowKind(b, 'core:goblin', 3);
    b.world.players[b.pid].knowledge.monsterMemory['guardian|core:goblin'] = { kind: 'core:goblin', guardian: true, encounters: 1, kills: 0, maxDamageToYou: 3, maxDamageByYou: 0, abilities: [] } as never;
    const f = b.world.floors[b.key];
    const si = (b.oy) * f.width + b.ox + 7;
    f.terrain[si] = b.world.meta.terrainTable.indexOf('core:stairs_down');
    b.world.players[b.pid].knowledge.floors[b.key].seen[si] = f.terrain[si];
    const g = structuredClone(b.world.entities[b.gId]); g.pos = { floor: b.key, x: b.ox + 1, y: b.oy }; b.inject({ put: [g] });
    await b.r.port.act({ type: 'wait' }, { source: 'bot' });
    const va = buildObservation(projectPlayerView(b.world, b.pid), catalog, { detail: 'brief', map: false }).valid_actions;
    const line = va.find((x) => x.startsWith('travel_to stairs_down'));
    expect(line).toContain('いま隣の 1 体が離れぎわに殴る 1 回ずつを含む');
    b.manager.closeAll();
    // 遠征の開始: 今いる階と、目的の階が下か上か
    const m = manager();
    const r = await m.createRun({ name: 'S', seed: 's1b-start', controller: agent, classId: 'core:warrior' });
    if ('error' in r) throw new Error(r.error.message);
    const st = await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
    expect(r.port.formatActionText(st)).toMatch(/今いる階: 地下1階。目的の階: 地下(\d+)階（\d+ 階下。下り階段から降りる）。/);
    m.closeAll();
  });
});

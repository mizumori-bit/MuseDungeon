// S1c（SEASON.md §14）のテスト（§14.9）。シーズンのランだけに効くもの: 火の作り直し（§14.3）・火について足すもの（§14.4 の 7）・
// 貢献賞の対象を広げる（§14.5）・予算の知らせと道しるべの地形（§14.6 の 4・5）・検査の指摘（§14.10 の 2・3）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION, generateFloor } from '@muse/engine';
import { loadConfig, RunSession, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, buildObservation, findPath, isSeasonSpot, seasonReportableSpots } from '@muse/shared';
import type { Command, Entity, GameEvent, Pos, World } from '@muse/shared';
import { playWithPort } from '../src/bot';
import { verifyRunDir } from '../src/replay';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's1ct';
const N = content.balance.season.fireReturnTurns;

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
function openSeason(m: SessionManager, seed = 's1c-season-1', budget = 5000): void {
  m.seasons.store.open({ id: SID, name: 'S1c試し', seed, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
async function seasonRun(m: SessionManager, name: string, profileToken?: string) {
  let ptoken = profileToken;
  if (!ptoken) {
    const inv = m.seasons.invite(SID, name, m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    ptoken = inv.token!;
  }
  const r = await m.createRun({ name, controller: agent, season: SID, profileToken: ptoken });
  if ('error' in r) throw new Error(r.error.message);
  return Object.assign(r, { ptoken });
}
type Run = Awaited<ReturnType<typeof seasonRun>>;
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });

/** テストの中だけの書き換え（記録に残らない。再生を見ないテストだけ） */
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
function editMe(w: World, pid: string, fn: (e: Entity) => void): void { const e = structuredClone(meOf(w, pid)); fn(e); inject(w, { put: [e] }); }
const place = (r: Run, p: Pos) => editMe(r.session.world, r.playerId, (e) => { e.pos = { floor: e.pos!.floor, x: p.x, y: p.y }; });
const setHp = (r: Run, hp: number) => editMe(r.session.world, r.playerId, (e) => { e.stats!.hp = hp; });
function setBanked(w: World, pid: string, n: number): void {
  applyEvent(w, { type: 'player_stats', player: pid, stats: { ...w.players[pid].stats, banked: n }, seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [] } as unknown as GameEvent);
}
function clearMonsters(w: World): void {
  inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
}
const floorOf = (r: Run) => meOf(r.session.world, r.playerId).pos!.floor;
const firesOn = (w: World, key: string) => Object.values(w.entities).filter((e) => e.campfire && e.pos?.floor === key);
const turnsOf = (r: Run) => meOf(r.session.world, r.playerId).actor!.turns;
const T = (w: World, i: number) => content.terrain[content.terrainIndex[w.meta.terrainTable[i]]];

let sid = 995000;
function monster(id: string, floor: string, p: Pos, o: { state?: 'hunting' | 'asleep'; acc?: number; dmg?: string; hp?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind: 'core:goblin', sid, pos: { floor, x: p.x, y: p.y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.state ?? 'hunting', targetPos: null, lostTurns: 0, params: {} }, ...(o.state === 'asleep' ? { dormant: true } : {}) },
    stats: { hp, maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d1' },
    base: { maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d1' },
    statuses: [],
  };
}
/** 置ける・立てるマス（通れる床。階段・扉・格子扉・水でなく、何もいない）。avoid から gap マスより遠いもの */
function openCells(w: World, key: string, avoid: Pos[] = [], gap = 0): Pos[] {
  const f = w.floors[key];
  const out: Pos[] = [];
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    const tr = T(w, f.terrain[y * f.width + x]);
    if (!tr.passable || tr.stairs || tr.door || tr.tags.includes('grate') || tr.tags.includes('water')) continue;
    if (Object.values(w.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y)) continue;
    if (avoid.some((a) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) <= gap)) continue;
    out.push({ x, y });
  }
  return out;
}
const besideOf = (w: World, key: string, p: Pos): Pos => {
  const open = new Set(openCells(w, key).map((c) => `${c.x},${c.y}`));
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]]) if (open.has(`${p.x + dx},${p.y + dy}`)) return { x: p.x + dx, y: p.y + dy };
  throw new Error('no cell beside');
};
async function startAndClear(r: Run): Promise<void> {
  const s = await act(r.port, { type: 'start_expedition', offer: 1 });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(r.session.world);
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r.port, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
/** 地下 1 階で、入口と階段から離れたマスに火を置く（A が確定点を持っている前提で書き換える） */
async function fireOnDepth1(a: Run): Promise<Pos> {
  const w = a.session.world;
  setBanked(w, a.playerId, 5000);
  const k1 = floorOf(a);
  const c = openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 3).find((p) => openCells(w, k1).some((q) => Math.max(Math.abs(q.x - p.x), Math.abs(q.y - p.y)) === 1))!;
  place(a, c);
  const r = await act(a.port, { type: 'place_fire' });
  expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
  return c;
}

describe('S1c §14.3 の 1・2: returning home from a campfire', () => {
  it('next to a fire with no hunter in view: one extract spends 5 turns packing up, then withdraws (banking as on stairs); the next expedition starts from that cell', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const c = await fireOnDepth1(a);
    const side = besideOf(w, floorOf(a), c);
    place(a, side);
    // 観測: extract は火からできる（帰り支度の手番・次の遠征はこのマスから）
    const o = a.port.observe().observation;
    expect(o.expedition?.can_extract).toBe(true);
    expect(o.expedition?.extract_via).toEqual({ type: 'fire', by: 'Aya', turns: N });
    expect(o.valid_actions.find((x) => x.startsWith('extract'))).toContain(`Aya の野営の火から。帰り支度 ${N} 手番`);
    // 未達成: confirm が要る（階段と同じ）。手番は使わない
    const t0 = turnsOf(a);
    const r0 = await act(a.port, { type: 'extract' });
    expect(!r0.ok && r0.error.code).toBe('confirm_required');
    expect(turnsOf(a)).toBe(t0);
    // 撤退: 1 回の呼び出しで、帰り支度の 5 手番を過ごして帰る
    const r1 = await act(a.port, { type: 'extract', confirm: true });
    expect(r1.ok ? '' : JSON.stringify(r1.error)).toBe('');
    expect(a.port.view().status).toBe('at_camp');
    expect(turnsOf(a)).toBe(t0 + N);
    const fr = a.session.history.filter((e) => e.type === 'fire_return');
    expect(fr.map((e) => e.type === 'fire_return' && e.phase)).toEqual(['start', 'done']);
    expect(a.port.formatActionText(r1)).toContain('帰り支度を始めた');
    expect(a.port.formatActionText(r1)).toContain('野営の火から撤退した');
    const ended = a.session.history.filter((e) => e.type === 'expedition_ended').at(-1);
    expect(ended?.type === 'expedition_ended' && ended.reason).toBe('withdrawn');
    // 次の遠征は、帰ったマス（火の隣）から始まる
    expect((await act(a.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(meOf(w, a.playerId).pos).toMatchObject({ floor: 'main:1', x: side.x, y: side.y });
    m.closeAll();
  });

  it('completing the objective and returning from a fire on that floor counts as a completed return (not the lifeline)', async () => {
    const m = manager();
    openSeason(m, 's1c-season-2');
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const x = w.expeditions!.at(-1)!;
    // 目的を達成したことにする（テストの中だけ）。帰還の確定は階段と同じ
    applyEvent(w, { type: 'objective_progress', no: x.no, progressAfter: { ...x.progress, reached: true, guardianSlain: true }, statusAfter: 'objective_complete', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [] } as unknown as GameEvent);
    const c = await fireOnDepth1(a);
    place(a, c);
    expect(a.port.observe().observation.valid_actions.find((v) => v.startsWith('extract'))).toMatch(/^extract \(帰還: 遠征達成・Aya の野営の火から/);
    const r = await act(a.port, { type: 'extract' });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(a.port.view().status).toBe('at_camp');
    const ended = a.session.history.filter((e) => e.type === 'expedition_ended').at(-1);
    expect(ended?.type === 'expedition_ended' && ended.reason).toBe('completed');
    const done = a.session.history.find((e) => e.type === 'fire_return' && e.phase === 'done');
    expect(done?.type === 'fire_return' && done.completed).toBe(true);
    m.closeAll();
  });

  it('refuses with a hunter in view or too little budget; a hunter coming into view calls it off (turns spent stay spent) and gives the turn back; stairs still work while chased', async () => {
    const m = manager();
    openSeason(m, 's1c-season-3');
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const k1 = floorOf(a);
    const c = await fireOnDepth1(a);
    editMe(w, a.playerId, (e) => { e.stats!.hp = 999; e.stats!.maxHp = 999; });
    place(a, c);
    expect((await act(a.port, { type: 'wait' })).ok).toBe(true);
    // 見えている追ってくる敵: 断る（手番を使わない）
    const nb = besideOf(w, k1, c);
    inject(w, { put: [monster('e_s1chm1', k1, nb, { state: 'hunting' })] });
    let t0 = turnsOf(a);
    let r = await act(a.port, { type: 'extract', confirm: true });
    expect(!r.ok && r.error.code).toBe('hostile_in_view');
    expect(!r.ok && r.error.message).toContain('階段の上なら、追われていても帰れる');
    expect(turnsOf(a)).toBe(t0);
    expect(a.port.observe().observation.expedition?.extract_blocked_by).toBe('hunted_at_fire');
    clearMonsters(w);
    // 予算の残りが帰り支度に足りない
    const s0 = structuredClone(w.season!.budget);
    w.season!.budget = { ...s0, left: N - 1, at: turnsOf(a) };
    r = await act(a.port, { type: 'extract', confirm: true });
    expect(!r.ok && r.error.message).toContain(`帰り支度の ${N} 手番に足りない`);
    expect(a.port.observe().observation.expedition?.extract_blocked_by).toBe('budget_at_fire');
    w.season!.budget = s0;
    // 途中で追ってくる敵が見えた: 取りやめ。見えないマス（近いが視界の外）に追ってくる敵を置いてから帰り始める
    const vis = new Set(a.port.view().visibleCells);
    const f = w.floors[k1];
    const pass = new Uint8Array(f.width * f.height);
    for (let i = 0; i < pass.length; i++) pass[i] = T(w, f.terrain[i]).passable ? 1 : 0;
    const zero = new Uint8Array(pass.length);
    const grid = { width: f.width, height: f.height, passable: pass, known: pass, occupied: zero, hazard: zero, unsighted: zero };
    // 速い追ってくる敵（3 倍速）なら、帰り支度の間に視界へ入る
    const hidden = openCells(w, k1).filter((p) => !vis.has(p.y * f.width + p.x)).map((p) => ({ p, d: findPath(grid, c, [p.y * f.width + p.x], 'none')?.length ?? 999 }))
      .filter((x) => x.d >= 2 && x.d <= 3 * (N - 2)).sort((a1, b1) => a1.d - b1.d)[0];
    expect(hidden).toBeDefined();
    const fast = monster('e_s1chm2', k1, hidden.p, { state: 'hunting' });
    fast.actor = { ...fast.actor!, speed: 300, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: { x: c.x, y: c.y }, lostTurns: 0, params: {} } };
    inject(w, { put: [fast] });
    t0 = turnsOf(a);
    r = await act(a.port, { type: 'extract', confirm: true });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(a.port.view().status).toBe('your_turn');
    expect(turnsOf(a)).toBeGreaterThan(t0);
    expect(turnsOf(a)).toBeLessThan(t0 + N);
    const cancel = a.session.history.filter((e) => e.type === 'fire_return').at(-1);
    expect(cancel?.type === 'fire_return' && cancel.phase).toBe('cancel');
    // 速い敵は見えたその手番に殴ることがあるので、被害での取りやめ（S1d §17.3）にもなりうる
    expect(['hostile', 'damaged']).toContain(cancel?.type === 'fire_return' && cancel.reason);
    expect(a.port.formatActionText(r)).toMatch(/帰り支度を取りやめた（(追ってくる敵が見えた|被害を受けた)）/);
    expect(meOf(w, a.playerId).statuses!.some((s) => s.id === 'core:fire_return')).toBe(false);
    // 階段の上なら、追われていてもすぐ帰れる（今までどおり）
    const down = w.floors[k1].stairs.down[0];
    place(a, down);
    inject(w, { put: [monster('e_s1chm3', k1, besideOf(w, k1, down), { state: 'hunting' })] });
    t0 = turnsOf(a);
    r = await act(a.port, { type: 'extract', confirm: true });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(turnsOf(a)).toBe(t0 + 1);
    m.closeAll();
  });

  it('someone else\'s fire works the same; a return from it counts for the setter\'s support once per participant per fire (with a heal there, still once)', async () => {
    const m = manager();
    openSeason(m, 's1c-season-4');
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    await startAndClear(a);
    const c = await fireOnDepth1(a);
    await lifelineHome(a);
    const support = () => m.seasons.standings(SID)!.standings.find((x) => x.name === 'Aya')!.support!.value;
    expect(m.seasons.get(SID)!.fires.length).toBe(1);
    // B: 回復して、そのまま火から撤退する（同じ遠征。数えるのは 1 回）
    await startAndClear(b);
    const wb = b.session.world;
    expect(firesOn(wb, 'main:1').length).toBe(1);
    setHp(b, 3);
    place(b, c);
    expect((await act(b.port, { type: 'interact' })).ok).toBe(true);
    const side = besideOf(wb, 'main:1', c);
    place(b, side);
    expect(support()).toBe(0);
    const r = await act(b.port, { type: 'extract', confirm: true });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(b.port.view().status).toBe('at_camp');
    expect(support()).toBe(1);
    // B の次の遠征は、A の火のそばから。もう一度帰っても、同じ火で 2 回目は数えない
    expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    clearMonsters(wb);
    expect(meOf(wb, b.playerId).pos).toMatchObject({ floor: 'main:1', x: side.x, y: side.y });
    expect((await act(b.port, { type: 'extract', confirm: true })).ok).toBe(true);
    expect(support()).toBe(1);
    // 帰還による使用だけ（回復しない）: 何も持たずに撤退しただけ（確定 0）は数えない（S1d §17.5）。点を確定させて帰れば数える: C
    const cc = await seasonRun(m, 'Cid');
    await startAndClear(cc);
    place(cc, c);
    expect((await act(cc.port, { type: 'extract', confirm: true })).ok).toBe(true);
    expect(support()).toBe(1);
    await startAndClear(cc);
    const wcc = cc.session.world;
    const xc = wcc.expeditions!.at(-1)!;
    xc.objective = { ...xc.objective, type: 'reach_depth' };
    applyEvent(wcc, { type: 'objective_progress', no: xc.no, progressAfter: { ...xc.progress, reached: true, guardianSlain: true }, statusAfter: 'objective_complete', seq: wcc.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [] } as unknown as GameEvent);
    place(cc, c);
    expect((await act(cc.port, { type: 'extract' })).ok).toBe(true);
    expect(support()).toBe(2);
    // A 自身が自分の火から帰っても数えない
    await startAndClear(a);
    place(a, c);
    expect((await act(a.port, { type: 'extract', confirm: true })).ok).toBe(true);
    expect(support()).toBe(2);
    // 記録: via return
    const users = m.seasons.get(SID)!.fires[0].users;
    expect(users.length).toBe(2);
    // §14.4 の 7: A のキャンプの観測に、新しく使った者の知らせ。次のキャンプでは出ない
    const text = a.port.observe().text;
    expect(text).toContain(`知らせ: あなたの野営の火（地下1階 (${c.x},${c.y})）を Ben・Cid が使った（支援賞 +2）`);
    expect(text).toContain('支援賞: あなた 2 回（1位/3人）（あなたの火 1/3・あと 2 つ置ける）');
    await startAndClear(a);
    await lifelineHome(a);
    expect(a.port.observe().text).not.toContain('知らせ: あなたの野営の火');
    m.closeAll();
  });

  it('a run that returns from a fire and starts the next expedition there replays from its records alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s1c-'));
    try {
      const m = manager(dir);
      openSeason(m, 's1-replay-1');
      const a = await seasonRun(m, 'Rin');
      await playWithPort(a.port, { kind: 'greedy', seed: 'a', maxActs: 900, maxExpeditions: 1 });
      expect(a.port.view().status).toBe('at_camp');
      expect((await act(a.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      const o = a.port.observe().observation;
      const step1 = o.navigation.passable_dirs.find((d) => !o.valid_actions.some((v) => v.startsWith(`move ${d} (`) && v.includes('攻撃')));
      if (step1) await act(a.port, { type: 'move', dir: step1 });
      const pf = await act(a.port, { type: 'place_fire' });
      expect(pf.ok ? '' : pf.error.message).toBe('');
      const at = { ...meOf(a.session.world, a.playerId).pos! };
      // 帰り支度（敵が来たら取りやめなので、帰れるまでくり返す。記録に残る命令だけ）
      for (let i = 0; i < 6 && a.port.view().status !== 'at_camp'; i++) {
        const r = await act(a.port, { type: 'extract', confirm: true });
        if (!r.ok) await act(a.port, { type: 'wait' });
      }
      expect(a.port.view().status).toBe('at_camp');
      expect(a.session.history.some((e) => e.type === 'fire_return' && e.phase === 'done')).toBe(true);
      expect((await act(a.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      expect(meOf(a.session.world, a.playerId).pos).toMatchObject(at);
      await a.port.act({ type: 'retire' }, { source: 'bot' });
      const v = verifyRunDir(content, join(dir, a.session.runId));
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('outside a season nothing changes: extract off the stairs is refused as before', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'Solo', seed: 's1c-plain', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const pid = r.playerId;
    const k = w.entities[w.players[pid].entityId].pos!.floor;
    const cell = openCells(w, k, [...w.floors[k].stairs.down, ...(w.floors[k].stairs.up ? [w.floors[k].stairs.up] : [])], 1)[0];
    editMe(w, pid, (e) => { e.pos = { floor: k, x: cell.x, y: cell.y }; });
    const res = await r.port.act({ type: 'extract', confirm: true }, { source: 'bot' });
    expect(!res.ok && res.error.message).toBe('階段の上でないと extract できない。');
    expect(content.statuses['core:fire_return']).toBeDefined();
    m.closeAll();
  });
});

describe('S1c §14.4 の 7: the support line where a fire can be set', () => {
  it('in the dungeon, standing where place_fire is possible shows the support award line with your fire count; not where it is refused', async () => {
    const m = manager();
    openSeason(m, 's1c-season-5');
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    setBanked(w, a.playerId, 5000);
    const k1 = floorOf(a);
    const c = openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 3)[0];
    place(a, c);
    const o = a.port.observe();
    expect(o.observation.season?.support?.text).toBe('支援賞: あなた 0 回（1位/1人）（あなたの火 0/3・あと 3 つ置ける）');
    expect(o.text).toContain('（あなたの火 0/3・あと 3 つ置ける）');
    // 階段の上（置けない）では出ない
    place(a, w.floors[k1].stairs.down[0]);
    expect((await act(a.port, { type: 'wait' })).ok).toBe(true);
    expect(a.port.observe().observation.valid_actions.find((v) => v.startsWith('place_fire'))).toContain('不可');
    expect(a.port.observe().observation.season?.support).toBeUndefined();
    m.closeAll();
  });
});

// ---- §14.5 特別な場所 ----

/** シーズンの生成で、地下 d 階に部屋の作りの特別な場所があるシード */
function seedWithSpot(depths: number[]): { seed: string; depth: number } {
  const table = content.terrain.map((t) => t.id);
  for (let s = 0; s < 60; s++) {
    const seed = `s1c-spot-${s}`;
    for (const d of depths) {
      const g = generateFloor(content, seed, 'main', d, table, undefined, undefined, { season: true });
      const inPf = (x: number, y: number) => g.floor.regions.some((r) => r.kind === 'prefab' && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
      // 入口から見えない遠さ（入った時点で目で見てしまうと、公開の知らせが出ない）
      const far = (x: number, y: number) => Math.max(Math.abs(x - g.floor.entry.x), Math.abs(y - g.floor.entry.y)) > 10;
      if (g.spawns.some((sp) => sp.type === 'feature' && ['core:altar', 'core:gamble_altar', 'core:inscription'].includes(sp.kind) && inPf(sp.x, sp.y) && far(sp.x, sp.y))) return { seed, depth: d };
    }
  }
  throw new Error('no seed with a spot');
}

describe('S1c §14.5: special places count for contribution', () => {
  it('a built-in altar / altar of chance / inscription seen with your own eyes is reported with the stairs; the first reporter gets 1; others see it from their next expedition with the name; fountains and scattered altars do not count', async () => {
    const { seed, depth } = seedWithSpot([1, 2]);
    const m = manager();
    openSeason(m, seed);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    await startAndClear(b);
    await startAndClear(a);
    const wa = a.session.world;
    if (depth === 2) {
      const d = wa.floors['main:1'].stairs.down[0];
      place(a, d);
      expect((await act(a.port, { type: 'stairs' })).ok).toBe(true);
      clearMonsters(wa);
    }
    const key = `main:${depth}`;
    const f = wa.floors[key];
    const f0 = f;
    const spot = Object.values(wa.entities).filter((e) => e.pos?.floor === key && isSeasonSpot(wa, e)).sort((p, q) => Math.max(Math.abs(q.pos!.x - f0.entry.x), Math.abs(q.pos!.y - f0.entry.y)) - Math.max(Math.abs(p.pos!.x - f0.entry.x), Math.abs(p.pos!.y - f0.entry.y)))[0];
    expect(spot).toBeDefined();
    // 見ていなければ報告できない（テストの中だけ: そのマスを見ていないことにする。地図の巻物で知っただけのマスも同じ）
    const fk = wa.players[a.playerId].knowledge.floors[key];
    const si = spot.pos!.y * f.width + spot.pos!.x;
    fk.seen[si] = 0;
    expect(seasonReportableSpots(wa, a.playerId).length).toBe(0);
    fk.seen[si] = f.terrain[si];
    fk.mapped = [...(fk.mapped ?? []), si];
    expect(seasonReportableSpots(wa, a.playerId).length).toBe(0);
    // 目で見た（テストの中だけ: そのマスを見たことにする）
    fk.mapped = fk.mapped.filter((x) => x !== si);
    // ばらまかれた祭壇（部屋の作りの外）と泉: 見ていても対象外
    const outside = openCells(wa, key).find((p) => !f.regions.some((r) => r.kind === 'prefab' && p.x >= r.x - 1 && p.x <= r.x + r.w && p.y >= r.y - 1 && p.y <= r.y + r.h))!;
    inject(wa, { put: [
      { id: 'e_s1csa1', kind: 'core:altar', sid: ++sid, pos: { floor: key, x: outside.x, y: outside.y }, feature: { state: 'idle' } },
    ] });
    fk.seen[outside.y * f.width + outside.x] = f.terrain[outside.y * f.width + outside.x];
    expect(isSeasonSpot(wa, wa.entities.e_s1csa1)).toBe(false);
    expect(isSeasonSpot(wa, { ...spot, kind: 'core:fountain' })).toBe(false);
    expect(seasonReportableSpots(wa, a.playerId)).toEqual([{ depth, x: spot.pos!.x, y: spot.pos!.y, kind: spot.kind }]);
    await lifelineHome(a);
    const camp = a.port.observe();
    expect(camp.text).toContain('まだ報告していない特別な場所（祭壇・賭けの祭壇・碑文） 1（うち、まだだれも公開していないもの 1）');
    expect(camp.observation.valid_actions.find((v) => v.startsWith('report_stairs'))).toContain('報告していない特別な場所 1');
    const rep = await act(a.port, { type: 'report_stairs' });
    expect(rep.ok ? '' : JSON.stringify(rep.error)).toBe('');
    expect(a.port.formatActionText(rep)).toContain('最初の報告:');
    expect(a.port.formatActionText(rep)).toContain('（貢献 +1）');
    const row = () => m.seasons.standings(SID)!.standings.find((x) => x.name === 'Aya')!;
    expect(row().contribution.value).toBe(1);
    expect(m.seasons.get(SID)!.spots.map((s) => `${s.depth}:${s.x},${s.y}|${s.kind}|${s.by}`)).toEqual([`${depth}:${spot.pos!.x},${spot.pos!.y}|${spot.kind}|Aya`]);
    // 2 回目は送るものが無い
    const rep2 = await act(a.port, { type: 'report_stairs' });
    expect(!rep2.ok && rep2.error.code).toBe('nothing_to_do');
    // 遠征の途中の B にはまだ無い。次の遠征から、その階に入ると地図に載る（名前つき。地形は載らない）
    const wb = b.session.world;
    expect(b.session.history.some((e) => e.type === 'knowledge_updated' && e.publicSpot)).toBe(false);
    await lifelineHome(b);
    await startAndClear(b);
    if (depth === 2) {
      const d = wb.floors['main:1'].stairs.down[0];
      place(b, d);
      expect((await act(b.port, { type: 'stairs' })).ok).toBe(true);
    }
    const ev = b.session.history.find((e) => e.type === 'knowledge_updated' && e.publicSpot) as Extract<GameEvent, { type: 'knowledge_updated' }> | undefined;
    const bSpot = Object.values(wb.entities).find((e) => e.pos?.floor === key && e.pos.x === spot.pos!.x && e.pos.y === spot.pos!.y && e.kind === spot.kind)!;
    const bfk = wb.players[b.playerId].knowledge.floors[key];
    const i = spot.pos!.y * f.width + spot.pos!.x;
    // 入った時点では見えていない（このシードの特別な場所は入口から見えない。見えていれば、目で見て覚えるので公開の知らせは無い）
    const visibleNow = b.port.view().visibleCells.includes(i);
    expect(visibleNow).toBe(false);
    {
      expect(ev?.publicSpot).toBe('Aya');
      expect(ev?.newlySeen).toEqual([]);
      expect(bfk.remembered.some((r) => r.id === bSpot.id)).toBe(true);
      const feat = b.port.observe().observation.visible.features.find((x) => x.id === bSpot.id);
      expect(feat?.public_by).toBe('Aya');
      expect(b.port.observe({ detail: 'full' }).text).toContain('（公開: Aya が報告）');
      // 公開で知っただけでは報告できない
      expect(seasonReportableSpots(wb, b.playerId).length).toBe(0);
    }
    // B が目で見て報告しても、最初ではない
    bfk.seen[i] = wb.floors[key].terrain[i];
    expect(seasonReportableSpots(wb, b.playerId).length).toBe(1);
    await lifelineHome(b);
    const rb = await act(b.port, { type: 'report_stairs' });
    expect(rb.ok ? '' : JSON.stringify(rb.error)).toBe('');
    expect(b.port.formatActionText(rb)).toContain('すでに公開されていた');
    expect(m.seasons.standings(SID)!.standings.find((x) => x.name === 'Ben')!.contribution.value).toBe(0);
    m.closeAll();
  });
});

// ---- §14.6 の 5・§14.10 の 2: 道しるべのマスの地形 ----

/** A が地下 depth 階までの下り階段を見て（テストの中だけの書き換え）報告し、公開する */
async function publishStairs(m: SessionManager, depths: number[]): Promise<Run> {
  const a = await seasonRun(m, 'Aya');
  expect((await act(a.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
  const w = a.session.world;
  clearMonsters(w);
  for (const d of depths) {
    const key = `main:${d}`;
    while (meOf(w, a.playerId).pos!.floor !== key) {
      const cur = w.floors[meOf(w, a.playerId).pos!.floor];
      place(a, cur.stairs.down[0]);
      expect((await act(a.port, { type: 'stairs' })).ok).toBe(true);
      clearMonsters(w);
    }
    const f = w.floors[key];
    const s = f.stairs.down[0];
    w.players[a.playerId].knowledge.floors[key].seen[s.y * f.width + s.x] = f.terrain[s.y * f.width + s.x];
  }
  await lifelineHome(a);
  const rep = await act(a.port, { type: 'report_stairs' });
  expect(rep.ok ? '' : JSON.stringify(rep.error)).toBe('');
  return a;
}

describe('S1c §14.6 の 5・§14.10 の 2: trail cells are plain floor', () => {
  it('a door or shallow water on the trail in your world shows as plain floor until you see it; then the real terrain', async () => {
    const m = manager();
    openSeason(m, 's1c-season-6');
    await publishStairs(m, [1]);
    const b = await seasonRun(m, 'Ben');
    const wb = b.session.world;
    const f = wb.floors['main:1'];
    const s = f.stairs.down[0];
    // B の世界の、道しるべになるマスを 2 つ変える（扉と浅い水）
    const pass = new Uint8Array(f.width * f.height);
    for (let i = 0; i < pass.length; i++) { const tr = T(wb, f.terrain[i]); pass[i] = tr.passable || tr.door === 'closed' ? 1 : 0; }
    const zero = new Uint8Array(pass.length);
    const path = findPath({ width: f.width, height: f.height, passable: pass, known: pass, occupied: zero, hazard: zero, unsighted: zero }, f.entry, [s.y * f.width + s.x], 'none')!;
    expect(path.length).toBeGreaterThan(6);
    const doorAt = path[Math.trunc(path.length / 3)], waterAt = path[Math.trunc((2 * path.length) / 3)];
    const di = doorAt.y * f.width + doorAt.x, wi = waterAt.y * f.width + waterAt.x;
    f.terrain[di] = wb.meta.terrainTable.indexOf('core:door_closed');
    f.terrain[wi] = wb.meta.terrainTable.indexOf('core:shallow_water');
    expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const fk = wb.players[b.playerId].knowledge.floors['main:1'];
    const plain = wb.meta.terrainTable.indexOf('core:floor');
    const vis = new Set(b.port.view().visibleCells);
    for (const i of [di, wi]) if (!vis.has(i)) expect(fk.seen[i]).toBe(plain);
    // 階段のマスは本当の地形（階段はだれの世界でも同じ）
    expect(fk.seen[s.y * f.width + s.x]).toBe(f.terrain[s.y * f.width + s.x]);
    // 目で見たら本当の地形に直る
    clearMonsters(wb);
    place(b, besideOf(wb, 'main:1', waterAt));
    expect((await act(b.port, { type: 'wait' })).ok).toBe(true);
    expect(fk.seen[wi]).toBe(f.terrain[wi]);
    expect((fk.mapped ?? []).includes(wi)).toBe(false);
    m.closeAll();
  });
});

// ---- §14.10 の 3: 道しるべのあるシーズンのランの復旧・取り込みの後に初めて作られた階の道しるべ ----

describe('S1c §14.10 の 3: trails on a floor made after the sync, and recovery', () => {
  it('a floor first made after the sync gets its trail when entered; the run recovers with a matching hash and keeps the trail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s1c-tr-'));
    try {
      const m = manager(dir);
      openSeason(m, 's1c-season-7');
      await publishStairs(m, [1, 2]);
      const b = await seasonRun(m, 'Ben');
      expect(b.session.world.floors['main:2']).toBeUndefined();
      expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      // 記録に残る命令だけで、地下 1 階の道しるべで下り階段へ行き、降りる
      for (let i = 0; i < 40 && b.port.view().floor?.depth === 1 && b.port.view().status === 'your_turn'; i++) {
        const v = b.port.view();
        const here = v.self.pos!;
        const f = b.session.world.floors['main:1'];
        if (f.stairs.down.some((d) => d.x === here.x && d.y === here.y)) { await act(b.port, { type: 'stairs' }); continue; }
        const r = await act(b.port, { type: 'travel', to: 'stairs_down', mode: 'flee' });
        if (!r.ok) {
          const adj = b.port.observe().observation.visible.monsters.find((x) => x.dist <= 1);
          await act(b.port, adj ? { type: 'attack', target: adj.id } : { type: 'wait' });
        }
      }
      expect(b.port.view().floor?.depth).toBe(2);
      const ev2 = b.session.history.find((e) => e.type === 'knowledge_updated' && e.publicStairs && e.floorKey === 'main:2') as Extract<GameEvent, { type: 'knowledge_updated' }> | undefined;
      expect(ev2?.publicPath).toBe(true);
      const kn = JSON.stringify(b.session.world.players[b.playerId].knowledge.floors['main:2'].mapped);
      const season = JSON.stringify(b.session.world.season);
      m.closeAll();
      const m2 = manager(dir);
      const rec = RunSession.recover(m2.deps, b.session.runId);
      expect(rec.verified).toBe(true);
      const w2 = rec.session.world as World;
      expect(JSON.stringify(w2.season)).toBe(season);
      expect(JSON.stringify(w2.players[b.playerId].knowledge.floors['main:2'].mapped)).toBe(kn);
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ================= 2 つ目: すべてのランに同じに効く直し（§14.4 の 1〜6・§14.6 の 1〜3・§14.10 の 1） =================

describe('S1c §14.4 の 5: the expedition text says published stairs are published (not "not found")', () => {
  it('the next-overreach line names the reporter when the published stairs are on the map but the way is unknown', async () => {
    const m = manager();
    openSeason(m, 's1c-season-8');
    await publishStairs(m, [1]);
    const c = await seasonRun(m, 'Cid');
    const wc = c.session.world;
    const cf = wc.floors['main:1'];
    const s = cf.stairs.down[0];
    // 道しるべを引けない世界（階段のまわりを壁にする）: 階段のマスだけが載る
    const wall = wc.meta.terrainTable.indexOf('core:wall');
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const x = s.x + dx, y = s.y + dy;
      if (x >= 0 && y >= 0 && x < cf.width && y < cf.height) cf.terrain[y * cf.width + x] = wall;
    }
    expect((await act(c.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const v = structuredClone(c.port.view());
    // 次の踏破の階を今いる地下 1 階にする（見え方だけの書き換え）
    v.expedition!.objective = { ...v.expedition!.objective, targetDepth: 0 };
    v.expedition!.crossedDepth = 0;
    const o = buildObservation(v, catalog, { detail: 'brief', map: false });
    expect(o.navigation.known_stairs.find((k) => k.type === 'down')?.public_by).toBe('Aya');
    expect(o.expedition?.haul?.text).toContain(`地下1階の下り階段に着けば`);
    expect(o.expedition?.haul?.text).toContain(`（公開されている: Aya が報告 (${s.x},${s.y})。途中の道はまだ分からない`);
    expect(o.expedition?.haul?.text).not.toContain('（未発見');
    m.closeAll();
  });
});

describe('S1d §17.3〜§17.5: returning from a fire', () => {
  it('damage while packing up calls it off (poison too, or a shooter you cannot see)', async () => {
    const m = manager();
    openSeason(m, 's1d-season-1');
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const c = await fireOnDepth1(a);
    place(a, c);
    editMe(w, a.playerId, (e) => { e.stats!.hp = 200; e.stats!.maxHp = 200; e.statuses = [{ id: 'core:poison', turnsLeft: 9, power: 1 }]; });
    const t0 = turnsOf(a);
    const r = await act(a.port, { type: 'extract', confirm: true });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(a.port.view().status).toBe('your_turn');
    expect(turnsOf(a)).toBeLessThan(t0 + N);
    const cancel = a.session.history.filter((e) => e.type === 'fire_return').at(-1);
    expect(cancel?.type === 'fire_return' && cancel.phase).toBe('cancel');
    expect(cancel?.type === 'fire_return' && cancel.reason).toBe('damaged');
    expect(a.port.formatActionText(r)).toContain('帰り支度を取りやめた（被害を受けた）');
    m.closeAll();
  });

  it('a relic carried home from a fire is delivered as on stairs (the boon is granted)', async () => {
    const m = manager();
    openSeason(m, 's1d-season-2');
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const c = await fireOnDepth1(a);
    place(a, c);
    // 遺物を持って、目的（遺物を持ち帰る）を達成したことにする（テストの中だけ）
    const me = meOf(w, a.playerId);
    const relic = { id: 'e_s1drl1', kind: 'core:relic_breath', sid: ++sid, role: 'relic', item: { qty: 1, affixes: [], heldBy: me.id, slot: 'q' } } as unknown as Entity;
    editMe(w, a.playerId, (e) => { e.inv!.items.push(relic.id); });
    inject(w, { put: [relic] });
    const x = w.expeditions!.at(-1)!;
    x.objective = { ...x.objective, type: 'retrieve_relic' };
    x.targets = { ...x.targets, relic: relic.id };
    applyEvent(w, { type: 'objective_progress', no: x.no, progressAfter: { ...x.progress, relicHeldBy: me.id }, statusAfter: 'objective_complete', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [] } as unknown as GameEvent);
    const r = await act(a.port, { type: 'extract' });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(a.port.view().status).toBe('at_camp');
    expect(a.session.history.some((e) => e.type === 'boon_granted')).toBe(true);
    expect(meOf(w, a.playerId).inv!.items).not.toContain(relic.id);
    const ended = a.session.history.filter((e) => e.type === 'expedition_ended').at(-1);
    expect(ended?.type === 'expedition_ended' && ended.reason).toBe('completed');
    m.closeAll();
  });

  it('a run that returned from a fire recovers after the server stops, with a matching hash; the next expedition starts there', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s1d-'));
    try {
      const m = manager(dir);
      openSeason(m, 's1-replay-1');
      const a = await seasonRun(m, 'Rin');
      await playWithPort(a.port, { kind: 'greedy', seed: 'a', maxActs: 900, maxExpeditions: 1 });
      expect(a.port.view().status).toBe('at_camp');
      expect((await act(a.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      const o = a.port.observe().observation;
      const step1 = o.navigation.passable_dirs.find((d) => !o.valid_actions.some((v) => v.startsWith(`move ${d} (`) && v.includes('攻撃')));
      if (step1) await act(a.port, { type: 'move', dir: step1 });
      expect((await act(a.port, { type: 'place_fire' })).ok).toBe(true);
      const at = { ...meOf(a.session.world, a.playerId).pos! };
      for (let i = 0; i < 6 && a.port.view().status !== 'at_camp'; i++) {
        const r = await act(a.port, { type: 'extract', confirm: true });
        if (!r.ok) await act(a.port, { type: 'wait' });
      }
      expect(a.port.view().status).toBe('at_camp');
      const season = JSON.stringify(a.session.world.season);
      const runId = a.session.runId;
      m.closeAll();
      const m2 = manager(dir);
      const rec = RunSession.recover(m2.deps, runId);
      expect(rec.verified).toBe(true);
      expect(JSON.stringify((rec.session.world as World).season)).toBe(season);
      m2.closeAll();
      const m3 = manager(dir);
      m3.recoverAll();
      const live = m3.get(runId)!;
      const pid = live.world.playerOrder[0];
      const port = m3.portForToken(a.token)!;
      expect((await port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
      expect(live.world.entities[live.world.players[pid].entityId].pos).toMatchObject(at);
      m3.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S1d §17.4: special places on milestone floors do not count', () => {
  it('isSeasonSpot is false on a warden hall', () => {
    const table = content.terrain.map((t) => t.id);
    let checked = 0;
    for (let s = 0; s < 30 && !checked; s++) {
      const g = generateFloor(content, `s1d-ms-${s}`, 'main', 5, table, undefined, undefined, { season: true });
      expect(g.floor.floorType).toBe('core:warden_hall');
      const w = { floors: { 'main:5': g.floor }, entities: {} } as unknown as World;
      // 節目の階の部屋の作りの中に祭壇があったことにする
      const r = g.floor.regions.find((x) => x.kind === 'prefab') ?? { x: 1, y: 1, w: 1, h: 1, kind: 'prefab' };
      const e = { id: 'e_s1dms1', kind: 'core:altar', sid: 1, pos: { floor: 'main:5', x: r.x, y: r.y }, feature: { state: 'idle' } } as unknown as Entity;
      if (!g.floor.regions.some((x) => x.kind === 'prefab')) (g.floor.regions as unknown[]).push(r);
      expect(isSeasonSpot(w, e)).toBe(false);
      checked++;
    }
    expect(checked).toBe(1);
  });
});

// S1（野営の火と支援賞。SEASON.md §8・PROTOCOL.md §9.10）のテスト（SEASON.md §8.8）と、§8.9 の 2（経験値の理由を engine が持つ）
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { createRun, ENGINE_VERSION, generateFloor, joinPlayer, seasonSync, step } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, restCapHp } from '@muse/shared';
import type { Command, Entity, GameEvent, Pos, SeasonSyncCommand, World } from '@muse/shared';
import { playWithPort } from '../src/bot';
import { verifyRunDir } from '../src/replay';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's1t';
const capOf = (maxHp: number) => restCapHp({ restCapPct: content.balance.rest.capPct }, maxHp);

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}

function openSeason(m: SessionManager, seed = 's1-season-1'): void {
  m.seasons.store.open({ id: SID, name: 'S1試し', seed, engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
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
function clearMonsters(w: World, keep: string[] = []): void {
  inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player && !keep.includes(e.id)).map((e) => e.id) });
}
const floorOf = (r: Run) => meOf(r.session.world, r.playerId).pos!.floor;
const firesOn = (w: World, key: string) => Object.values(w.entities).filter((e) => e.campfire && e.pos?.floor === key);

let sid = 994000;
function monster(id: string, floor: string, p: Pos, o: { state?: 'hunting' | 'asleep'; acc?: number; dmg?: string; hp?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind: 'core:goblin', sid, pos: { floor, x: p.x, y: p.y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.state ?? 'hunting', targetPos: null, lostTurns: 0, params: {} }, ...(o.state === 'asleep' ? { dormant: true } : {}) },
    stats: { hp, maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d2' },
    base: { maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d2' },
    statuses: [],
  };
}

/** 置ける・立てるマス（通れる床。階段・扉・格子扉でなく、何もいない）。avoid から gap マスより遠いもの */
function openCells(w: World, key: string, avoid: Pos[] = [], gap = 0): Pos[] {
  const f = w.floors[key];
  const out: Pos[] = [];
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    const tr = content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
    if (!tr.passable || tr.stairs || tr.door || tr.tags.includes('grate') || tr.tags.includes('water')) continue;
    if (Object.values(w.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y)) continue;
    if (avoid.some((a) => Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) <= gap)) continue;
    out.push({ x, y });
  }
  return out;
}
/** p の隣の立てるマスと、そこから p への向き */
function besideOf(w: World, key: string, p: Pos): { at: Pos; dir: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw' } {
  const dirs = [['n', 0, -1], ['ne', 1, -1], ['e', 1, 0], ['se', 1, 1], ['s', 0, 1], ['sw', -1, 1], ['w', -1, 0], ['nw', -1, -1]] as const;
  const open = new Set(openCells(w, key).map((c) => `${c.x},${c.y}`));
  for (const [d, dx, dy] of dirs) {
    const at = { x: p.x - dx, y: p.y - dy };
    if (open.has(`${at.x},${at.y}`)) return { at, dir: d };
  }
  throw new Error('no cell beside');
}

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
async function descend(r: Run): Promise<void> {
  const w = r.session.world;
  const d = w.floors[floorOf(r)].stairs.down[0];
  place(r, d);
  const s = await act(r.port, { type: 'stairs' });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(w);
}
async function placeFireAt(r: Run, p: Pos) {
  place(r, p);
  return act(r.port, { type: 'place_fire' });
}

describe('S1 §8.1・§8.2: placing a campfire', () => {
  it('costs depth x 200 banked points (the survival number drops) and refuses stairs, features, nearby fires, hunters, a second one on the floor, too few points and a fourth one', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const pid = a.playerId;
    setBanked(w, pid, 1000);
    const k1 = floorOf(a);
    const c1 = openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 2)[0];
    const turns0 = meOf(w, pid).actor!.turns;
    // 観測に place_fire の行（費用・確定点・残りの数）
    expect(a.port.observe().observation.valid_actions.some((x) => x.startsWith('place_fire (野営の火を置く: 費用 200 点'))).toBe(true);
    const r1 = await placeFireAt(a, c1);
    expect(r1.ok ? r1.outcome : JSON.stringify(r1.error)).toContain('野営の火を置いた');
    expect(meOf(w, pid).actor!.turns).toBe(turns0 + 1);
    expect(w.players[pid].stats.banked).toBe(800);
    expect(firesOn(w, k1).map((e) => `${e.pos!.x},${e.pos!.y}|${e.campfire!.by}`)).toEqual([`${c1.x},${c1.y}|Aya`]);
    expect(w.season!.placed).toEqual([{ depth: 1, x: c1.x, y: c1.y }]);
    // 生還賞の数字（確定点）も下がる
    expect(m.seasons.standings(SID)!.standings[0].survival?.value).toBe(800);
    // 見えるもの: 置いた者の名前
    expect(a.port.observe().observation.visible.features.find((f) => f.type === 'core:camp_fire')?.by).toBe('Aya');
    const err = async (p: Pos) => { const r = await placeFireAt(a, p); return r.ok ? 'ok' : r.error.message; };
    // ほかの火から 5 マス以内（自分の火も）
    const near = openCells(w, k1).find((c) => Math.max(Math.abs(c.x - c1.x), Math.abs(c.y - c1.y)) === 3)!;
    expect(await err(near)).toContain('5 マス以内');
    // この階には 1 人 1 つ
    const far = openCells(w, k1, [c1], 6)[0];
    expect(await err(far)).toContain('この階には、もうあなたの火がある');
    // 階段の上
    expect(await err(w.floors[k1].stairs.down[0])).toContain('階段');
    // ほかの地物のあるマス
    inject(w, { put: [{ id: 'e_s1ft01', kind: 'core:fountain', sid: ++sid, pos: { floor: k1, x: far.x, y: far.y }, feature: { state: 'idle' } }] });
    expect(await err(far)).toContain('ほかの地物か罠');
    inject(w, { del: ['e_s1ft01'] });
    // 地下 2 階: 点が足りない → 足りれば置ける（400）
    await descend(a);
    const k2 = floorOf(a);
    setBanked(w, pid, 100);
    const c2 = openCells(w, k2, [w.floors[k2].entry, ...w.floors[k2].stairs.down], 2)[0];
    expect(await err(c2)).toContain('確定した点が足りない（費用 400 点');
    // 追ってくる敵が見えている
    setBanked(w, pid, 5000);
    const nb = besideOf(w, k2, c2).at;
    // 置いたマスから見えるように、一手待って視界を作ってから敵を置く
    place(a, c2);
    expect((await act(a.port, { type: 'wait' })).ok).toBe(true);
    inject(w, { put: [monster('e_s1hm01', k2, nb, { state: 'hunting' })] });
    const hr = await act(a.port, { type: 'place_fire' });
    expect(!hr.ok && hr.error.code).toBe('hostile_in_view');
    clearMonsters(w);
    expect(await err(c2)).toBe('ok');
    expect(w.players[pid].stats.banked).toBe(4600);
    // 3 つ目（地下 3 階）は置ける。4 つ目（地下 4 階）はシーズンの上限
    await descend(a);
    expect(await err(openCells(w, floorOf(a), [w.floors[floorOf(a)].entry, ...w.floors[floorOf(a)].stairs.down], 2)[0])).toBe('ok');
    await descend(a);
    expect(await err(openCells(w, floorOf(a), [w.floors[floorOf(a)].entry, ...w.floors[floorOf(a)].stairs.down], 2)[0])).toContain('3 つまで');
    expect(a.port.observe().observation.valid_actions.find((x) => x.startsWith('place_fire'))).toContain('不可');
    m.closeAll();
  });

  it('is only for season runs', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'Solo', seed: 's1-plain', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const res = await r.port.act({ type: 'place_fire' }, { source: 'bot' });
    expect(!res.ok && res.error.code).toBe('bad_request');
    expect(!res.ok && res.error.message).toContain('シーズンのランだけ');
    expect(r.port.observe().observation.valid_actions.some((x) => x.startsWith('place_fire'))).toBe(false);
    m.closeAll();
  });
});

describe('S1 §8.1・§8.3: using a campfire', () => {
  it('heals up to the rest cap in one turn; nothing (no turn) at the cap or with a hunter in view; once per floor per expedition; again on the next expedition', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const pid = a.playerId;
    setBanked(w, pid, 1000);
    const k1 = floorOf(a);
    const c1 = openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 2)[0];
    expect((await placeFireAt(a, c1)).ok).toBe(true);
    const maxHp = meOf(w, pid).stats!.maxHp;
    const cap = capOf(maxHp);
    const turns = () => meOf(w, pid).actor!.turns;
    // 上限ちょうど: 何も起きない（手番も使わない）
    setHp(a, cap);
    let t0 = turns();
    let r = await act(a.port, { type: 'interact' });
    expect(!r.ok && r.error.message).toContain('休憩の上限');
    expect(turns()).toBe(t0);
    // 追ってくる敵が見えている
    setHp(a, 5);
    const nb = besideOf(w, k1, c1).at;
    inject(w, { put: [monster('e_s1hm02', k1, nb, { state: 'hunting' })] });
    r = await act(a.port, { type: 'interact' });
    expect(!r.ok && r.error.code).toBe('hostile_in_view');
    clearMonsters(w);
    // 隣から（向きを渡す）使う: 休憩の上限まで、1 手番
    const side = besideOf(w, k1, c1);
    place(a, side.at);
    expect(a.port.observe().observation.valid_actions).toContain(`interact ${side.dir} (野営の火（Aya の火）: HP を ${cap} まで戻す（+${cap - 5}）)`);
    t0 = turns();
    r = await act(a.port, { type: 'interact', dir: side.dir });
    expect(r.ok ? r.outcome : JSON.stringify(r.error)).toContain('Aya の野営の火で休んだ');
    expect(meOf(w, pid).stats!.hp).toBe(cap);
    expect(turns()).toBe(t0 + 1);
    const used = a.session.history.filter((e) => e.type === 'fire_used');
    expect(used.length).toBe(1);
    expect(a.port.observe().text).toContain('この遠征で野営の火を使った階: 地下1階');
    // 同じ遠征で、同じ階の火はもう使えない
    setHp(a, 5);
    t0 = turns();
    r = await act(a.port, { type: 'interact', dir: side.dir });
    expect(!r.ok && r.error.message).toContain('この階の野営の火をもう使った');
    expect(turns()).toBe(t0);
    // 次の遠征では使える
    await lifelineHome(a);
    await startAndClear(a);
    expect(floorOf(a)).toBe(k1);
    setHp(a, 5);
    place(a, c1);
    r = await act(a.port, { type: 'interact' });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(meOf(w, pid).stats!.hp).toBe(cap);
    m.closeAll();
  });
});

describe('S1 §8.4: sharing', () => {
  it('a placed fire reaches the others from their next expedition (not mid-expedition), on the same cell of floors made before and after; the placer\'s own world gets no copy', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    // B は先に遠征に出ている
    await startAndClear(b);
    await startAndClear(a);
    const wa = a.session.world;
    setBanked(wa, a.playerId, 5000);
    const k1 = floorOf(a);
    const c1 = openCells(wa, k1, [wa.floors[k1].entry, ...wa.floors[k1].stairs.down], 2)[0];
    expect((await placeFireAt(a, c1)).ok).toBe(true);
    await descend(a);
    const k2 = floorOf(a);
    const c2 = openCells(wa, k2, [wa.floors[k2].entry, ...wa.floors[k2].stairs.down], 2)[0];
    expect((await placeFireAt(a, c2)).ok).toBe(true);
    // 置いただけでは載らない。キャンプに着くと載る
    expect(m.seasons.get(SID)!.fires.length).toBe(0);
    await lifelineHome(a);
    expect(m.seasons.get(SID)!.fires.map((f) => `${f.depth}:${f.x},${f.y}|${f.by}`)).toEqual([`1:${c1.x},${c1.y}|Aya`, `2:${c2.x},${c2.y}|Aya`]);
    // 自分の世界には写しを作らない（取り込んだ一覧には mine）
    expect(firesOn(wa, k1).length).toBe(1);
    expect(wa.season!.fires!.every((f) => f.mine)).toBe(true);
    expect(a.port.observe().text).toContain(`あなたの野営の火: 地下1階 (${c1.x},${c1.y}) 支援 0 回`);
    // 遠征の途中の B には、まだ無い
    const wb = b.session.world;
    expect(firesOn(wb, k1).length).toBe(0);
    expect(wb.season!.fires ?? []).toEqual([]);
    // B の世界で、火のマスに品と眠っている敵を置いておく（届いたマスに品や敵がいても置く）
    inject(wb, { put: [
      { id: 'e_s1it01', kind: 'core:potion_healing', sid: ++sid, pos: { floor: k1, x: c1.x, y: c1.y }, item: { qty: 1, affixes: [] } },
      monster('e_s1sl01', k1, c1, { state: 'asleep' }),
    ] });
    await lifelineHome(b);
    // キャンプで取り込む: 作ってある地下 1 階の同じマスに置く。地下 2 階は B はまだ作っていない
    expect(firesOn(wb, k1).map((e) => `${e.pos!.x},${e.pos!.y}|${e.campfire!.by}`)).toEqual([`${c1.x},${c1.y}|Aya`]);
    expect(wb.entities.e_s1it01?.pos).toMatchObject({ x: c1.x, y: c1.y });
    expect(wb.floors[k2]).toBeUndefined();
    // 次の遠征: 地図に載る（置いた者の名前つき）
    expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    clearMonsters(wb);
    const fk = wb.players[b.playerId].knowledge.floors[k1];
    const fire = firesOn(wb, k1)[0];
    expect(fk.remembered.some((r) => r.id === fire.id)).toBe(true);
    expect(b.port.observe().observation.visible.features.find((f) => f.type === 'core:camp_fire')?.by).toBe('Aya');
    // 地下 2 階は、作ったときに同じマスに置く
    await descend(b);
    expect(firesOn(wb, k2).map((e) => `${e.pos!.x},${e.pos!.y}`)).toEqual([`${c2.x},${c2.y}`]);
    // 入口と階段は、火があっても同じ（§2.3）
    for (const k of [k1, k2]) {
      expect(wb.floors[k].entry).toEqual(wa.floors[k].entry);
      expect(wb.floors[k].stairs).toEqual(wa.floors[k].stairs);
    }
    m.closeAll();
  });

  it('a placer who dies before getting home still shares the fire when the run ends; the season count carries over to the next run', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    setBanked(w, a.playerId, 5000);
    const k1 = floorOf(a);
    expect((await placeFireAt(a, openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 2)[0])).ok).toBe(true);
    await descend(a);
    const k2 = floorOf(a);
    const c2 = openCells(w, k2, [w.floors[k2].entry, ...w.floors[k2].stairs.down], 2)[0];
    expect((await placeFireAt(a, c2)).ok).toBe(true);
    // 隣に強い敵: 倒れる
    setHp(a, 1);
    inject(w, { put: [monster('e_s1kl01', k2, besideOf(w, k2, c2).at, { state: 'hunting', acc: 60, dmg: '9d9' })] });
    for (let i = 0; i < 5 && w.status !== 'ended'; i++) await act(a.port, { type: 'wait' });
    expect(w.players[a.playerId].state).toBe('dead');
    expect(m.seasons.get(SID)!.fires.length).toBe(2);
    // 同じ参加者の次のラン: 取り込んだ自分の火（2 つ）を数える。地下 3 階に 3 つ目、地下 4 階で上限
    const a2 = await seasonRun(m, 'Aya', a.ptoken);
    await startAndClear(a2);
    const w2 = a2.session.world;
    expect(w2.season!.fires!.filter((f) => f.mine).length).toBe(2);
    expect(firesOn(w2, floorOf(a2)).length).toBe(1);
    setBanked(w2, a2.playerId, 5000);
    await descend(a2);
    await descend(a2);
    const k3 = floorOf(a2);
    expect((await placeFireAt(a2, openCells(w2, k3, [w2.floors[k3].entry, ...w2.floors[k3].stairs.down], 2)[0])).ok).toBe(true);
    await descend(a2);
    const k4 = floorOf(a2);
    const r = await placeFireAt(a2, openCells(w2, k4, [w2.floors[k4].entry, ...w2.floors[k4].stairs.down], 2)[0]);
    expect(!r.ok && r.error.message).toContain('3 つまで（もう 3 つ置いた）');
    m.closeAll();
  });

  it('replays from its records alone (placing, sharing and syncing are all in the log)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s1-'));
    try {
      const m = manager(dir);
      openSeason(m, 's1-replay-1');
      const a = await seasonRun(m, 'Rin');
      await playWithPort(a.port, { kind: 'greedy', seed: 'a', maxActs: 900, maxExpeditions: 1 });
      expect(a.port.view().status).toBe('at_camp');
      expect((await act(a.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      // 階段の上から一歩出て置く（記録に残る命令だけで）
      const o = a.port.observe().observation;
      const step1 = o.navigation.passable_dirs.find((d) => !o.valid_actions.some((v) => v.startsWith(`move ${d} (`) && v.includes('攻撃')));
      if (step1) await act(a.port, { type: 'move', dir: step1 });
      const banked = a.session.world.players[a.playerId].stats.banked ?? 0;
      const depth = a.port.view().floor!.depth;
      expect(banked).toBeGreaterThanOrEqual(depth * 200);
      const pf = await act(a.port, { type: 'place_fire' });
      expect(pf.ok ? '' : pf.error.message).toBe('');
      await a.port.act({ type: 'retire' }, { source: 'bot' });
      const types = new Set(a.session.history.map((e) => e.type));
      expect(types.has('fire_placed')).toBe(true);
      // 経験値の理由は engine の出来事に入っている（§8.9 の 2）
      expect(a.session.history.filter((e) => e.type === 'xp_gained').every((e) => e.type === 'xp_gained' && !!e.reason)).toBe(true);
      const v = verifyRunDir(content, join(dir, a.session.runId));
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S1 §8.5: the support award', () => {
  it('counts a use by someone else once per participant per fire, only if it healed 10% or more; the setter\'s own use never counts; ties go to less budget used', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    const c = await seasonRun(m, 'Cid');
    await startAndClear(a);
    const wa = a.session.world;
    setBanked(wa, a.playerId, 1000);
    const k1 = floorOf(a);
    const c1 = openCells(wa, k1, [wa.floors[k1].entry, ...wa.floors[k1].stairs.down], 2)[0];
    expect((await placeFireAt(a, c1)).ok).toBe(true);
    await lifelineHome(a);
    const support = () => m.seasons.standings(SID)!.standings.find((x) => x.name === 'Aya')!.support!;
    const useFire = async (r: Run, hp: number) => {
      await startAndClear(r);
      setHp(r, hp);
      place(r, c1);
      const res = await act(r.port, { type: 'interact' });
      expect(res.ok ? '' : JSON.stringify(res.error)).toBe('');
    };
    // B: 使ったその場では数えない（S1a §10.1 の 1: 置いた者に、今その階にだれかいると分からないように）。キャンプに着いたときに数える
    await useFire(b, 3);
    expect(support().value).toBe(0);
    await lifelineHome(b);
    expect(support().value).toBe(1);
    // B の 2 回目（次の遠征）: 使えるが数えない
    await useFire(b, 3);
    await lifelineHome(b);
    expect(support().value).toBe(1);
    // C: 戻りが最大 HP の 10% 未満（上限の 1 つ下から）
    const maxC = meOf(c.session.world, c.playerId).stats!.maxHp;
    await useFire(c, capOf(maxC) - 1);
    await lifelineHome(c);
    expect(support().value).toBe(1);
    // A 自身: 数えない
    await useFire(a, 3);
    expect(support().value).toBe(1);
    expect(support().rank).toBe(1);
    // 支援 0 の B と C は、使った予算の少ないほうが上
    const rows = m.seasons.standings(SID)!.standings;
    const rb = rows.find((x) => x.name === 'Ben')!, rc = rows.find((x) => x.name === 'Cid')!;
    expect(rb.used).toBeGreaterThan(rc.used);
    expect(rc.support!.rank).toBeLessThan(rb.support!.rank);
    // キャンプの観測: 賞の 4 行目と、自分の火の使われた回数（取り込みの後）
    await lifelineHome(a);
    const text = a.port.observe().text;
    expect(text).toContain('支援賞: あなた 1 回（1位/3人）');
    expect(text).toContain(`あなたの野営の火: 地下1階 (${c1.x},${c1.y}) 支援 1 回`);
    expect(m.seasons.get(SID)!.fires[0].users).toEqual([m.seasons.get(SID)!.participants.find((p) => p.name === 'Ben')!.profileId]);
    m.closeAll();
  });
});

describe('S1 §9.4: a shared fire on a cell that differs in another world', () => {
  it('lands on the same cell next to that world\'s own feature, an item, a sleeping monster and on a pillar; those keep working, and the fire is used first only when it can heal', () => {
    const seed = 's1-overlap-1';
    const { world: w } = createRun(content, { runId: 'run_s1ovl', seed, season: { id: SID, name: 'S1試し' } });
    const j = joinPlayer(w, content, { type: 'join', name: 'Ben', controller: agent, locale: 'ja', atCamp: true }, { cseq: null, wall: 0 });
    if (!j.ok) throw new Error(j.error.message);
    const pid = j.playerId;
    const k1 = 'main:1';
    const f1 = w.floors[k1];
    const cells = openCells(w, k1, [f1.entry, ...f1.stairs.down], 2);
    const c1 = cells[0];
    const c3 = cells.find((c) => Math.max(Math.abs(c.x - c1.x), Math.abs(c.y - c1.y)) > 6)!;
    // 地下 2 階の火のマス（まだ作っていない階）。シーズンの生成で、目的なしの階の床
    const ref2 = generateFloor(content, seed, 'main', 2, w.meta.terrainTable, undefined, undefined, { season: true });
    const i2 = ref2.floor.terrain.findIndex((tv, i) => content.terrain[content.terrainIndex[w.meta.terrainTable[tv]]].passable && !content.terrain[content.terrainIndex[w.meta.terrainTable[tv]]].stairs && i > ref2.floor.width * 2);
    const c2 = { x: i2 % ref2.floor.width, y: Math.trunc(i2 / ref2.floor.width) };
    // この世界だけの違い: c1 に護りの火・品・眠っている敵、c3 は柱
    inject(w, { put: [
      { id: 'e_s1wf01', kind: 'core:ward_fire', sid: ++sid, pos: { floor: k1, x: c1.x, y: c1.y }, feature: { state: 'lit' } },
      { id: 'e_s1it02', kind: 'core:potion_healing', sid: ++sid, pos: { floor: k1, x: c1.x, y: c1.y }, item: { qty: 1, affixes: [] } },
      monster('e_s1sl02', k1, c1, { state: 'asleep' }),
    ] });
    f1.terrain[c3.y * f1.width + c3.x] = w.meta.terrainTable.indexOf('core:pillar');
    const sync: SeasonSyncCommand = {
      type: 'season_sync', reason: 'join',
      season: { id: SID, name: 'S1試し', budget: { limit: 5000, left: 5000 }, ends_at: Date.now() + 86_400_000, ended: false, public: [], awards: [], contribution: 0, died: false,
        fires: [{ depth: 1, x: c1.x, y: c1.y, by: 'Aya' }, { depth: 1, x: c3.x, y: c3.y, by: 'Cid' }, { depth: 2, x: c2.x, y: c2.y, by: 'Aya' }], self: 'Ben' },
    };
    expect(seasonSync(w, content, pid, sync, { cseq: null, wall: 0 }).ok).toBe(true);
    expect(firesOn(w, k1).map((e) => `${e.pos!.x},${e.pos!.y}|${e.campfire!.by}`).sort()).toEqual([`${c1.x},${c1.y}|Aya`, `${c3.x},${c3.y}|Cid`].sort());
    expect(w.entities.e_s1wf01.feature!.state).toBe('lit');
    expect(w.entities.e_s1it02.pos).toMatchObject(c1);
    // 取り込み直しても増えない
    expect(seasonSync(w, content, pid, { ...sync, reason: 'camp' }, { cseq: null, wall: 0 }).ok).toBe(true);
    expect(firesOn(w, k1).length).toBe(2);
    const go = (cmd: Command) => step(w, content, pid, cmd, { cseq: null, wall: 0 });
    expect(go({ type: 'start_expedition', offer: 1 }).ok).toBe(true);
    clearMonsters(w, ['e_s1sl02']);
    const maxHp = meOf(w, pid).stats!.maxHp;
    // 柱の上の火: 隣から使える
    const s3 = besideOf(w, k1, c3);
    editMe(w, pid, (e) => { e.pos = { floor: k1, x: s3.at.x, y: s3.at.y }; e.stats!.hp = 4; });
    const r3 = go({ type: 'interact', dir: s3.dir });
    expect(r3.ok ? '' : JSON.stringify(r3.error)).toBe('');
    expect(r3.events.some((e) => e.type === 'fire_used' && e.by === 'Cid')).toBe(true);
    expect(meOf(w, pid).stats!.hp).toBe(capOf(maxHp));
    // 護りの火と同じマスの火: この階の火はもう使ったので、その世界の地物（護りの火を消す）が今までどおり働く
    const s1 = besideOf(w, k1, c1);
    editMe(w, pid, (e) => { e.pos = { floor: k1, x: s1.at.x, y: s1.at.y }; e.stats!.hp = 4; });
    const r1 = go({ type: 'interact', dir: s1.dir });
    expect(r1.ok ? '' : JSON.stringify(r1.error)).toBe('');
    expect(r1.events.some((e) => e.type === 'fire_used')).toBe(false);
    expect(w.entities.e_s1wf01.feature!.state).toBe('out');
    expect(w.entities.e_s1sl02).toBeDefined();
    // まだ作っていなかった地下 2 階: 作ったときに同じマスに置く（柱・壁でも）。入口と階段は火の無い生成と同じ
    editMe(w, pid, (e) => { e.pos = { floor: k1, x: f1.stairs.down[0].x, y: f1.stairs.down[0].y }; });
    expect(go({ type: 'stairs' }).ok).toBe(true);
    expect(firesOn(w, 'main:2').map((e) => `${e.pos!.x},${e.pos!.y}|${e.campfire!.by}`)).toEqual([`${c2.x},${c2.y}|Aya`]);
    expect(w.floors['main:2'].entry).toEqual(ref2.floor.entry);
    expect(w.floors['main:2'].stairs).toEqual(ref2.floor.stairs);
  });
});

describe('S1 §8.9-2: the engine writes why XP was gained', () => {
  it('two kills in one fight each name their victim; a kill by poison out of sight hides the victim', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const k1 = floorOf(a);
    editMe(w, a.playerId, (e) => { e.stats!.acc = 60; e.stats!.hp = 500; e.stats!.maxHp = 500; });
    const me = meOf(w, a.playerId).pos!;
    const sides = openCells(w, k1).filter((c) => Math.max(Math.abs(c.x - me.x), Math.abs(c.y - me.y)) === 1).slice(0, 2);
    expect(sides.length).toBe(2);
    inject(w, { put: [{ ...monster('e_s1x001', k1, sides[0], { hp: 1 }), xp: 5 }, { ...monster('e_s1x002', k1, sides[1], { hp: 1 }), kind: 'core:cave_rat', xp: 3 }] });
    const seq0 = w.seq;
    const r = await act(a.port, { type: 'fight', target: 'e_s1x001', until: 'clear' });
    expect(r.ok ? r.outcome : JSON.stringify(r.error)).toContain('倒した');
    const xs = a.session.history.filter((e) => e.seq > seq0 && e.type === 'xp_gained') as Extract<GameEvent, { type: 'xp_gained' }>[];
    expect(xs.map((e) => `${e.reason}:${e.victimKind}`).sort()).toEqual(['kill:core:cave_rat', 'kill:core:goblin']);
    // 視界の外で毒が倒した相手: 種族を伏せる
    const far = openCells(w, k1).filter((c) => Math.max(Math.abs(c.x - me.x), Math.abs(c.y - me.y)) > 12)[0];
    const pm = { ...monster('e_s1x003', k1, far, { hp: 1, state: 'asleep' }), xp: 5 };
    pm.actor!.dormant = false;
    pm.actor!.ai!.state = 'unaware';
    pm.statuses = [{ id: 'core:poison', turnsLeft: 5, power: 1, source: meOf(w, a.playerId).id }];
    inject(w, { put: [pm] });
    const seq1 = w.seq;
    for (let i = 0; i < 5 && w.entities.e_s1x003; i++) await act(a.port, { type: 'wait' });
    const died = a.session.history.find((e) => e.seq > seq1 && e.type === 'died' && e.id === 'e_s1x003') as Extract<GameEvent, { type: 'died' }> | undefined;
    expect(died).toBeDefined();
    expect(died!.killer).toBe(meOf(w, a.playerId).id);
    const x3 = a.session.history.filter((e) => e.seq > seq1 && e.type === 'xp_gained') as Extract<GameEvent, { type: 'xp_gained' }>[];
    expect(x3.at(-1)?.reason).toBe('kill');
    expect(x3.at(-1)?.victimKind).toBeNull();
    expect(a.port.messages(0, 300).text).toContain('（何かを倒した）');
    m.closeAll();
  });
});

// ---- S1a（SEASON.md §10・§11）: 検査の指摘の直しと、テストの穴 ----

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'muse-s1a-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('S1a §10.1: fixes', () => {
  it('a run that receives someone else\'s fires replays from its records alone, on a floor made before the sync and on one made after', () => withDir(async (dir) => {
    const m = manager(dir);
    openSeason(m, 's1a-replay-1');
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const wa = a.session.world;
    setBanked(wa, a.playerId, 5000);
    const k1 = floorOf(a);
    expect((await placeFireAt(a, openCells(wa, k1, [wa.floors[k1].entry, ...wa.floors[k1].stairs.down], 2)[0])).ok).toBe(true);
    await descend(a);
    const k2 = floorOf(a);
    expect((await placeFireAt(a, openCells(wa, k2, [wa.floors[k2].entry, ...wa.floors[k2].stairs.down], 2)[0])).ok).toBe(true);
    await lifelineHome(a);
    // B は記録に残る命令だけで遊ぶ（参加の取り込みで地下 1 階に、地下 2 階は作ったときに置く）
    const b = await seasonRun(m, 'Ben');
    await playWithPort(b.port, { kind: 'greedy', seed: 'b', maxActs: 900, maxExpeditions: 1 });
    const spawned = b.session.history.filter((e) => e.type === 'entity_spawned' && e.reason === 'season_fire') as Extract<GameEvent, { type: 'entity_spawned' }>[];
    expect(spawned.map((e) => e.entity.pos!.floor).sort()).toEqual([k1, k2]);
    // 地下 1 階の火は取り込み（season_sync）で、地下 2 階の火は階を作ったとき（floor_generated の後）に置いた
    const at = (k: string) => b.session.history.findIndex((e) => e.type === 'entity_spawned' && e.reason === 'season_fire' && e.entity.pos?.floor === k);
    const gen2 = b.session.history.findIndex((e) => e.type === 'floor_generated' && e.floorData.key === k2);
    expect(at(k1)).toBeLessThan(gen2);
    expect(at(k2)).toBeGreaterThan(gen2);
    await b.port.act({ type: 'retire' }, { source: 'bot' });
    const v = verifyRunDir(content, join(dir, b.session.runId));
    expect(v.reexecMatches).toBe(true);
    expect(v.foldMatchesKeyframe).toBe(true);
    // 地図に載せるのは火があることだけ（そのマスの地形は載せない。S1a §10.1 の 2）
    const seeded = b.session.history.filter((e) => e.type === 'knowledge_updated' && e.publicFire) as Extract<GameEvent, { type: 'knowledge_updated' }>[];
    expect(seeded.length).toBeGreaterThan(0);
    for (const e of seeded) { expect(e.newlySeen).toEqual([]); expect(e.mappedAdd ?? []).toEqual([]); }
    m.closeAll();
  }));

  it('placing next to a far stationary enemy: the observation and the engine agree (as with rest)', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    setBanked(w, a.playerId, 1000);
    const k1 = floorOf(a);
    const c1 = openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 2)[0];
    place(a, c1);
    expect((await act(a.port, { type: 'wait' })).ok).toBe(true);
    const still = Object.values(content.monsters).find((d) => d.tags.includes('stationary'))!;
    const me = meOf(w, a.playerId).pos!;
    const spot = openCells(w, k1).find((c) => { const d = Math.max(Math.abs(c.x - me.x), Math.abs(c.y - me.y)); return d >= 3 && d <= 4; })!;
    const mo = { ...monster('e_s1amo1', k1, spot, { state: 'hunting' }), kind: still.id };
    mo.actor = { ...mo.actor!, speed: still.speed, ai: { ...mo.actor!.ai!, archetype: still.ai.archetype } };
    inject(w, { put: [mo] });
    expect(a.port.observe().observation.visible.monsters.find((x) => x.id === 'e_s1amo1')?.awareness).toBe('hunting');
    const line = a.port.observe().observation.valid_actions.find((x) => x.startsWith('place_fire'))!;
    expect(line).not.toContain('不可');
    const r = await act(a.port, { type: 'place_fire' });
    expect(r.ok ? '' : r.error.message).toBe('');
    m.closeAll();
  });

  it('a fire that lost its cell to someone else\'s still counts as the setter\'s (the limits, and its own use is no support); others still use the shared one', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    const c = await seasonRun(m, 'Cid');
    await startAndClear(a);
    await startAndClear(b);
    const wa = a.session.world, wb = b.session.world;
    setBanked(wa, a.playerId, 1000);
    setBanked(wb, b.playerId, 1000);
    const k1 = floorOf(a);
    const c1 = openCells(wa, k1, [wa.floors[k1].entry, ...wa.floors[k1].stairs.down], 2)
      .find((x) => openCells(wb, k1).some((y) => y.x === x.x && y.y === x.y))!;
    expect((await placeFireAt(a, c1)).ok).toBe(true);
    expect((await placeFireAt(b, c1)).ok).toBe(true);
    await lifelineHome(a);
    await lifelineHome(b);
    const fires = m.seasons.get(SID)!.fires;
    expect(fires.map((f) => `${f.by}${f.dup ? ':dup' : ''}`)).toEqual(['Aya', 'Ben:dup']);
    // B の火: シーズンの数にも、同じ階の 1 つにも数える
    expect(wb.season!.fires!.filter((f) => f.mine).map((f) => f.dup)).toEqual([true]);
    expect(b.port.observe().text).toContain('同じマスにほかの者の火が先に載った（あなたの火として数える）');
    await startAndClear(b);
    const far = openCells(wb, k1, [c1, wb.floors[k1].entry, ...wb.floors[k1].stairs.down], 6)[0];
    const r = await placeFireAt(b, far);
    expect(!r.ok && r.error.message).toContain('この階には、もうあなたの火がある');
    // B の世界のそのマスの火は B の火のまま（写しは作らない）。B が使っても、A の支援に数えない
    expect(firesOn(wb, k1).map((e) => e.campfire!.by)).toEqual(['Ben']);
    setHp(b, 3);
    place(b, c1);
    expect((await act(b.port, { type: 'interact' })).ok).toBe(true);
    await lifelineHome(b);
    const support = (name: string) => m.seasons.standings(SID)!.standings.find((x) => x.name === name)!.support!.value;
    expect(support('Aya')).toBe(0);
    expect(support('Ben')).toBe(0);
    // C の世界には A の火（共有された方）だけ。C が使うと A の支援
    await startAndClear(c);
    expect(firesOn(c.session.world, k1).map((e) => e.campfire!.by)).toEqual(['Aya']);
    setHp(c, 3);
    place(c, c1);
    expect((await act(c.port, { type: 'interact' })).ok).toBe(true);
    await lifelineHome(c);
    expect(support('Aya')).toBe(1);
    m.closeAll();
  });

  it('two different fires on one floor: the second is refused in the same expedition, also after leaving the floor and coming back; another floor\'s fire still works', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const c = await seasonRun(m, 'Cid');
    const b = await seasonRun(m, 'Ben');
    await startAndClear(a);
    await startAndClear(c);
    const wa = a.session.world, wc = c.session.world;
    setBanked(wa, a.playerId, 5000);
    setBanked(wc, c.playerId, 5000);
    const k1 = floorOf(a);
    const fa = openCells(wa, k1, [wa.floors[k1].entry, ...wa.floors[k1].stairs.down], 2)[0];
    const fc = openCells(wc, k1, [fa, wc.floors[k1].entry, ...wc.floors[k1].stairs.down], 6)[0];
    expect((await placeFireAt(a, fa)).ok).toBe(true);
    expect((await placeFireAt(c, fc)).ok).toBe(true);
    await descend(a);
    const k2 = floorOf(a);
    const fa2 = openCells(wa, k2, [wa.floors[k2].entry, ...wa.floors[k2].stairs.down], 2)[0];
    expect((await placeFireAt(a, fa2)).ok).toBe(true);
    await lifelineHome(a);
    await lifelineHome(c);
    await startAndClear(b);
    const wb = b.session.world;
    expect(firesOn(wb, k1).length).toBe(2);
    // 1 つ目（A の火）は使える。2 つ目（C の火）は同じ遠征の同じ階なので使えない
    setHp(b, 3);
    place(b, fa);
    expect((await act(b.port, { type: 'interact' })).ok).toBe(true);
    setHp(b, 3);
    place(b, fc);
    let r = await act(b.port, { type: 'interact' });
    expect(!r.ok && r.error.message).toContain('この階の野営の火をもう使った');
    // 下の階へ行って戻っても、同じ遠征なら地下 1 階は使えない。地下 2 階の火は使える
    await descend(b);
    setHp(b, 3);
    place(b, fa2);
    expect((await act(b.port, { type: 'interact' })).ok).toBe(true);
    const up = wb.floors[k2].stairs.up!;
    place(b, up);
    expect((await act(b.port, { type: 'stairs' })).ok).toBe(true);
    clearMonsters(wb);
    setHp(b, 3);
    place(b, fc);
    r = await act(b.port, { type: 'interact' });
    expect(!r.ok && r.error.message).toContain('この階の野営の火をもう使った');
    expect(b.port.observe().text).toContain('この遠征で野営の火を使った階: 地下1階・地下2階');
    m.closeAll();
  });

  it('support is counted after a restart: uses made before the crash, and uses whose count was not saved', () => withDir(async (dir) => {
    // 毎回キーフレームを書く（テストの中の書き換えもキーフレームに入り、復旧の後の記録に fire_used が残る）
    const mk = () => new SessionManager(content, loadConfig({ runsDir: dir, keyframeEvery: 1 }));
    const m = mk();
    openSeason(m, 's1a-restart-1');
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const wa = a.session.world;
    setBanked(wa, a.playerId, 1000);
    const k1 = floorOf(a);
    const c1 = openCells(wa, k1, [wa.floors[k1].entry, ...wa.floors[k1].stairs.down], 2)[0];
    expect((await placeFireAt(a, c1)).ok).toBe(true);
    await lifelineHome(a);
    // B は火を使った後、帰る前にサーバーが止まる（記録には fire_used が残る）
    const b = await seasonRun(m, 'Ben');
    await startAndClear(b);
    // HP を減らして火の上に立って使う（テストの中だけの書き換え。この後の復旧は、記録の再実行の照合が外れても続く）
    setHp(b, 3);
    place(b, c1);
    expect((await act(b.port, { type: 'interact' })).ok).toBe(true);
    m.closeAll();
    // 起動し直す: 復旧したランが帰ると、落ちる前の使用も数える
    const m2 = mk();
    m2.recoverAll();
    const b2 = m2.get(b.session.runId)!;
    const pid = b2.world.playerOrder[0];
    const life = b2.world.entities[b2.world.players[pid].entityId].inv!.items.map((id) => b2.world.entities[id]).find((it) => it?.kind === 'core:lifeline')!;
    expect((await b2.submit(pid, { type: 'use', slot: life.item!.slot! }, { source: 'bot' })).ok).toBe(true);
    for (let i = 0; i < 20 && b2.world.players[pid].state !== 'at_camp'; i++) await b2.submit(pid, { type: 'wait' }, { source: 'bot' });
    const support = (mm: SessionManager) => mm.seasons.standings(SID)!.standings.find((x) => x.name === 'Aya')!.support!.value;
    expect(support(m2)).toBe(1);
    // 数えた後、保存の前に落ちた: fires.json の数を消して起動し直すと、復旧のときに数え直す（やり直しても 1 回のまま）
    m2.closeAll();
    const fp = join(dir, 'seasons', SID, 'fires.json');
    const saved = JSON.parse(readFileSync(fp, 'utf8')) as { uses: number; users: string[] }[];
    saved[0].uses = 0;
    saved[0].users = [];
    writeFileSync(fp, JSON.stringify(saved));
    const m3 = mk();
    expect(support(m3)).toBe(0);
    m3.recoverAll();
    expect(support(m3)).toBe(1);
    m3.closeAll();
    const m4 = mk();
    m4.recoverAll();
    expect(support(m4)).toBe(1);
    m4.closeAll();
  }));

  it('the profile records banked points before the fire costs (the cost only lowers the survival award)', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    setBanked(w, a.playerId, 1000);
    const k1 = floorOf(a);
    expect((await placeFireAt(a, openCells(w, k1, [w.floors[k1].entry, ...w.floors[k1].stairs.down], 2)[0])).ok).toBe(true);
    expect(w.players[a.playerId].stats.banked).toBe(800);
    expect(m.seasons.standings(SID)!.standings[0].survival!.value).toBe(800);
    await lifelineHome(a);
    const prof = m.profiles.store.resolve(a.ptoken)!;
    const run = m.profiles.store.get(prof.id)!.runs.find((x) => x.runId === a.session.runId)!;
    expect(run.banked).toBe(1000);
    m.closeAll();
  });

  it('warns at start-up about open seasons opened on another version', () => {
    const m = manager();
    m.seasons.store.open({ id: 'old1', name: '古い', seed: 'x', engineVersion: '0.38.0', contentVersion: content.version, budget: 100, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    openSeason(m);
    const ws = m.seasons.versionWarnings();
    expect(ws.length).toBe(1);
    expect(ws[0]).toContain('シーズン old1');
    expect(ws[0]).toContain('新しいランを始められない');
    m.closeAll();
  });
});

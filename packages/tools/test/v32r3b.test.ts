// V3-2R3b（IMPROVEMENTS_V3 §23）の完了の定義: 守護者の持ち場（気づいていない間は持ち場の近くだけ・追跡は今までどおり・
// 階が落ち着くと持ち場へ戻る・持ち場は公開しない）、階段への移動の候補に歩数と「追われたままなら」の最悪の被害、危ないときは綱を先に。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { applyEvent, buildObservation, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
const leash = content.balance.guardian.leash;

async function newRun(seed: string, opts: { objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' | 'endless' } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, controller: { kind: 'agent', label: 't' }, objective: opts.objective ?? 'auto' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const place = (x: number, y: number, floor = me().pos!.floor) => { const e = structuredClone(me()); e.pos = { floor, x, y }; inject({ put: [e] }); };
  const setHp = (hp: number) => { const e = structuredClone(me()); e.stats!.hp = hp; inject({ put: [e] }); };
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  return { manager, r, world, pid, meId, inject, me, place, setHp, clearMonsters, act, obs };
}

let sid = 995000;
function monster(id: string, kind: string, floor: string, x: number, y: number, o: { state?: 'hunting' | 'unaware'; home?: { x: number; y: number }; hp?: number; speed?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed: o.speed ?? 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.state ?? 'hunting', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
    ...(o.home ? { role: 'guardian' as const, home: { ...o.home } } : {}),
  };
}

const cheb = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

function passable(world: World, key: string, x: number, y: number): boolean {
  const f = world.floors[key];
  return x >= 0 && y >= 0 && x < f.width && y < f.height && content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]].passable
    && !content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]].stairs
    && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
}

/** n マス先まで開けた直線（どのマスも from から minAway 以上離れている） */
function openLine(world: World, key: string, n: number, from?: { x: number; y: number }, minAway = 0): { p: { x: number; y: number }; dx: number; dy: number } {
  const f = world.floors[key];
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      let ok = true;
      for (let k = 0; k <= n && ok; k++) {
        const c = { x: x + dx * k, y: y + dy * k };
        if (!passable(world, key, c.x, c.y) || (from && cheb(c, from) < minAway)) ok = false;
      }
      if (ok) return { p: { x, y }, dx, dy };
    }
  }
  throw new Error('no open line');
}

function setMemory(t: Awaited<ReturnType<typeof newRun>>, key: string, mem: Record<string, unknown>) {
  applyEvent(t.world, { type: 'monster_memory_updated', player: t.pid, kind: key, memoryAfter: { kind: key.replace('guardian|', ''), encounters: 3, kills: 1, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...mem }, seq: t.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [t.pid] } as unknown as GameEvent);
}

describe('V3-2R3b guardians keep their post (§23.2)', () => {
  it('a generated guardian has its spawn cell as home; home never reaches the player', async () => {
    const t = await newRun('v32r3b-home-1', { objective: 'slay_guardian' });
    t.clearMonsters();
    const x = t.world.expeditions![0];
    expect(x.objective.type).toBe('slay_guardian');
    // 目標階まで降りる（目標階が生成されて守護者が置かれる）
    for (let d = 1; d < x.objective.targetDepth!; d++) {
      const f = t.world.floors[t.me().pos!.floor];
      t.place(f.stairs.down[0].x, f.stairs.down[0].y);
      await t.act({ type: 'wait' });
      expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    }
    const g = t.world.entities[t.world.expeditions![0].targets.guardian!];
    expect(g.role).toBe('guardian');
    expect(g.home).toBeTruthy();
    expect(cheb(g.pos!, g.home!)).toBeLessThanOrEqual(leash);
    // 見えていても持ち場は渡らない（PlayerView・観測とも）
    const view = projectPlayerView(t.world, t.pid);
    expect(JSON.stringify(view)).not.toContain('"home"');
    expect(JSON.stringify(t.obs())).not.toContain('"home"');
  });

  it('an unaware guardian walks back to its post and stays within the leash; a hunting one chases past it', async () => {
    // 自分から十分離れた直線がある階（生成が変わってもよいようにシードを探す）
    let t!: Awaited<ReturnType<typeof newRun>>;
    let ln: ReturnType<typeof openLine> | null = null;
    for (let k = 1; k < 12 && !ln; k++) {
      t = await newRun(`v32r3b-leash-${k}`);
      t.clearMonsters();
      try { ln = openLine(t.world, t.me().pos!.floor, 6, { ...t.me().pos! }, 16); } catch { ln = null; }
    }
    if (!ln) throw new Error('no open line');
    const key = t.me().pos!.floor;
    // 先頭が持ち場、6 マス先に気づいていない守護者
    const home = { x: ln.p.x, y: ln.p.y };
    t.inject({ put: [monster('e_r3bg01', 'core:goblin', key, ln.p.x + ln.dx * 6, ln.p.y + ln.dy * 6, { state: 'unaware', home })] });
    let back = -1;
    for (let i = 0; i < 40; i++) {
      await t.act({ type: 'wait' });
      const g = t.world.entities.e_r3bg01;
      expect(g.actor!.ai!.state).toBe('unaware');
      if (back < 0 && cheb(g.pos!, home) <= leash) back = i;
      if (back >= 0) expect(cheb(g.pos!, home) <= leash).toBe(true);
    }
    expect(back).toBeGreaterThanOrEqual(0);

    // 追跡中: 持ち場から離れていても獲物へ向かう
    const t2 = await newRun('v32r3b-leash-2');
    t2.clearMonsters();
    const key2 = t2.me().pos!.floor;
    const ln2 = openLine(t2.world, key2, 6);
    t2.place(ln2.p.x, ln2.p.y);
    // 持ち場は守護者の leash マス後ろ（獲物へ 1 歩でも寄れば範囲の外）
    const farHome = { x: ln2.p.x + ln2.dx * (3 + leash), y: ln2.p.y + ln2.dy * (3 + leash) };
    t2.inject({ put: [monster('e_r3bg02', 'core:goblin', key2, ln2.p.x + ln2.dx * 3, ln2.p.y + ln2.dy * 3, { state: 'hunting', home: farHome })] });
    await t2.act({ type: 'wait' });
    const g2 = t2.world.entities.e_r3bg02;
    expect(cheb(g2.pos!, t2.me().pos!)).toBeLessThan(3);
    expect(cheb(g2.pos!, farHome)).toBeGreaterThan(leash);
  });

  it('when the floor settles at the start of an expedition, guardians go back to their post, not to a far cell', async () => {
    const t = await newRun('v32r3b-settle-1');
    t.clearMonsters();
    const startPos = { ...t.world.expeditions![0].start[t.pid].pos! };
    const key = startPos.floor;
    // 持ち場は再開地点から離れた所。守護者は再開地点の 2 マス先にいて、手負いで追跡中
    const ln = openLine(t.world, key, 1, startPos, 14);
    const home = { x: ln.p.x, y: ln.p.y };
    let spot: { x: number; y: number } | null = null;
    for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) if (!spot && passable(t.world, key, startPos.x + dx, startPos.y + dy)) spot = { x: startPos.x + dx, y: startPos.y + dy };
    const g = monster('e_r3bg03', 'core:goblin', key, spot!.x, spot!.y, { state: 'hunting', home, hp: 30 });
    g.stats!.hp = 7;
    t.inject({ put: [g] });
    const slot = t.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    expect((await t.act({ type: 'use', slot })).ok).toBe(true);
    expect(t.r.port.view().status).toBe('at_camp');
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const after = t.world.entities.e_r3bg03;
    expect(after).toBeTruthy();
    expect(after.actor!.ai!.state).toBe('unaware');
    expect(after.stats!.hp).toBe(after.stats!.maxHp);
    // 持ち場へ戻った（ふさがっていれば範囲の中）。再開した直後の 1 手で動いていても範囲の中
    expect(cheb(after.pos!, home)).toBeLessThanOrEqual(leash);
  });
});

describe('V3-2R3b stairs travel shows the risk of being chased (§23.1)', () => {
  /** 下り階段から 2〜4 マスのマスに立ち（階段は視界に入る）、追跡中の敵を視界に入れる */
  async function chased(seed: string, mem: number | null, speed = 100) {
    const t = await newRun(seed);
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const start = { ...f.stairs.down[0] };
    // 下り階段から 2〜4 マスで、そこから 2 マス先（階段から遠い側）に敵を置けるマス
    let at: { x: number; y: number } | null = null, foe: { x: number; y: number } | null = null;
    for (let y = 1; y < f.height - 1 && !at; y++) for (let x = 1; x < f.width - 1 && !at; x++) {
      const c = { x, y };
      const d = cheb(c, start);
      if (d < 2 || d > 4 || !passable(t.world, key, x, y)) continue;
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
        const e = { x: x + dx, y: y + dy };
        if (!foe && cheb(e, start) > d && passable(t.world, key, e.x, e.y) && passable(t.world, key, x + dx / 2, y + dy / 2)) { at = c; foe = e; }
      }
    }
    expect(at).toBeTruthy();
    t.place(at!.x, at!.y);
    t.inject({ put: [monster('e_r3bc01', 'core:goblin', key, foe!.x, foe!.y, { state: 'hunting', speed })] });
    await t.act({ type: 'wait' }); // 視界を更新する
    if (mem !== null) setMemory(t, 'core:goblin', { maxDamageToYou: mem });
    return t;
  }

  it('the stairs candidate says how many steps and the worst damage if they keep chasing you (attacks while you walk × worst hit; V3-4b §28.5)', async () => {
    // 同じ速さの近接の敵は、歩く間に追いついて殴れない（隣にいれば 1 回だけ）
    const t = await chased('v32r3b-risk-1', 3);
    t.setHp(t.me().stats!.maxHp);
    const o = t.obs();
    const m = o.visible.monsters.find((x) => x.id === 'e_r3bc01');
    expect(m?.awareness).toBe('hunting');
    const st = o.navigation.known_stairs.filter((s) => s.path_len !== null).sort((a, b) => a.path_len! - b.path_len!)[0];
    expect(st).toBeTruthy();
    const line = o.valid_actions.find((a) => a.startsWith(`travel_to stairs_${st.type}`));
    const n = Math.min(...o.navigation.known_stairs.filter((s) => s.type === st.type && s.path_len !== null).map((s) => s.path_len!));
    const sameSpeed = (m!.dist <= 1 ? 1 : 0) * 3;
    expect(line).toContain(`階段まで ${n} 歩。追われたままなら最悪 ${sameSpeed} の被害（追いつけるのは 0 体・射撃 0 体。HP ${t.me().stats!.hp}）`);
    // 倍の速さの敵は、1 歩ごとに 1 回追加で殴れる
    const f = await chased('v32r3b-risk-1', 3, 200);
    f.setHp(f.me().stats!.maxHp);
    const of = f.obs();
    const mf = of.visible.monsters.find((x) => x.id === 'e_r3bc01')!;
    const stf = of.navigation.known_stairs.filter((s) => s.path_len !== null).sort((a, b) => a.path_len! - b.path_len!)[0];
    const nf = Math.min(...of.navigation.known_stairs.filter((s) => s.type === stf.type && s.path_len !== null).map((s) => s.path_len!));
    const lf = of.valid_actions.find((a) => a.startsWith(`travel_to stairs_${stf.type}`));
    expect(lf).toContain(`階段まで ${nf} 歩。追われたままなら最悪 ${(nf + (mf.dist <= 1 ? 1 : 0)) * 3} の被害（追いつけるのは 1 体・射撃 0 体`);
    // HP に余裕があれば綱は階段の後
    const iStairs = o.valid_actions.findIndex((a) => a.startsWith('travel_to stairs_'));
    const iLife = o.valid_actions.findIndex((a) => a.startsWith('use_item') && a.includes('綱'));
    expect(iLife).toBeGreaterThan(iStairs);
  });

  it('when even the nearest stairs could cost all your HP and you hold the lifeline, the lifeline comes first', async () => {
    // 倍の速さの敵（歩く 1 歩ごとに 1 回殴れる）
    const t = await chased('v32r3b-risk-2', 4, 200);
    const o0 = t.obs();
    const st = o0.navigation.known_stairs.filter((s) => s.path_len !== null).sort((a, b) => a.path_len! - b.path_len!)[0];
    expect(st).toBeTruthy();
    // 最悪の被害（歩数 × 4 以上）が HP 以上になるように
    t.setHp(Math.max(1, st.path_len! * 4));
    const view = projectPlayerView(t.world, t.pid);
    const o = buildObservation(view, catalog, { detail: 'brief', map: false });
    const iStairs = o.valid_actions.findIndex((a) => a.startsWith('travel_to stairs_'));
    const iLife = o.valid_actions.findIndex((a) => a.startsWith('use_item') && a.includes('綱'));
    expect(iStairs).toBeGreaterThanOrEqual(0);
    expect(iLife).toBeGreaterThanOrEqual(0);
    expect(iLife).toBeLessThan(iStairs);
  });

  it('with an unrecorded enemy the worst damage is “unknown”', async () => {
    // 階段が見える位置に置けた階（生成が変わってもよいようにシードを探す）
    let line: string | undefined;
    for (let k = 3; k < 12 && !line; k++) {
      const t = await chased(`v32r3b-risk-${k}`, null);
      line = t.obs().valid_actions.find((a) => a.startsWith('travel_to stairs_'));
    }
    expect(line).toContain('追われたままなら最悪の被害は不明');
  });
});

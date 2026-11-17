// V3-3 の 3 段目（IMPROVEMENTS_V3 §3.2・§28.9）の完了の定義: 深度 5 は必ず大守護者の階が生成され、到達できる。
// 大守護者は型 2 つ、倒すまで下り階段は封じられ（踏破にもならない）、倒すと節目が記録されて加護を選べる。
// 次の節目はキャンプと遠征に出て、遠征の目標は節目の階にならない。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor, isMilestoneDepth } from '@muse/engine';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { applyEvent, formatObservationText, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
const terrainTable = content.terrain.map((tt) => tt.id);

async function newRun(seed: string, objective: 'auto' | 'reach_depth' = 'reach_depth') {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, objective });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject({ put: [e] }); };
  const place = (x: number, y: number) => edit((e) => { e.pos = { floor: e.pos!.floor, x, y }; });
  const clearMonsters = (keepWarden = true) => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player && !(keepWarden && e.guardian?.warden)).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  const view = () => projectPlayerView(world, pid);
  const descend = async () => {
    const f = world.floors[me().pos!.floor];
    place(f.stairs.down[0].x, f.stairs.down[0].y);
    clearMonsters();
    await act({ type: 'wait' });
    const s = await act({ type: 'stairs' });
    clearMonsters();
    return s;
  };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, obs, view, descend };
}

/** 入口からの歩行距離（壁と通れない地形を除く。敵は無視） */
function walk(floor: ReturnType<typeof generateFloor>['floor'], from: { x: number; y: number }): Int32Array {
  const n = floor.width * floor.height;
  const dist = new Int32Array(n).fill(-1);
  const q = [from.y * floor.width + from.x];
  dist[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const cx = c % floor.width, cy = Math.trunc(c / floor.width);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= floor.width || ny >= floor.height) continue;
      const i = ny * floor.width + nx;
      if (dist[i] >= 0) continue;
      const t = content.terrain[content.terrainIndex[terrainTable[floor.terrain[i]]]];
      if (!t.passable && !t.door) continue;
      dist[i] = dist[c] + 1;
      q.push(i);
    }
  }
  return dist;
}

describe('V3-3 milestone floors (§3.2, §11)', () => {
  it('every multiple of 5 is a warden hall with one two-type warden between the entry and the stairs down, all reachable', () => {
    for (let i = 0; i < 30; i++) {
      for (const depth of [5, 10, 15, 30]) {
        const g = generateFloor(content, `v33w-gen-${i}`, 'main', depth, terrainTable);
        expect(g.floor.floorType).toBe('core:warden_hall');
        const wardens = g.spawns.filter((s) => s.type === 'monster' && s.role === 'guardian');
        expect(wardens).toHaveLength(1);
        const w = wardens[0];
        if (w.type !== 'monster') throw new Error('not a monster');
        expect(w.guardian?.warden).toBe(true);
        expect(w.guardian?.types).toHaveLength(2);
        expect(w.guardian?.types.map((id) => content.guardianTypes[id].strongVs).sort()).toEqual(['melee', 'thrown']);
        expect(w.bounty).toBeGreaterThan(0);
        const dist = walk(g.floor, g.floor.entry);
        const down = g.floor.stairs.down[0];
        expect(g.floor.stairs.up).toBeTruthy();
        expect(dist[down.y * g.floor.width + down.x]).toBeGreaterThan(0);
        expect(dist[w.y * g.floor.width + w.x]).toBeGreaterThan(0);
        // 大守護者は入口より下り階段に近い（広間の奥へは大守護者のそばを通る）
        expect(Math.max(Math.abs(w.x - down.x), Math.abs(w.y - down.y))).toBeLessThan(Math.max(Math.abs(w.x - g.floor.entry.x), Math.abs(w.y - g.floor.entry.y)));
      }
    }
    // 聖域（6 の倍数）はそのまま。30 は大守護者の間が優先
    expect(generateFloor(content, 'v33w-gen-s', 'main', 6, terrainTable).floor.floorType).toBe('core:sanctuary');
    expect(isMilestoneDepth(content, 5)).toBe(true);
    expect(isMilestoneDepth(content, 6)).toBe(false);
  });
});

describe('V3-3 the warden in play (§3.2)', () => {
  it('the stairs down are sealed while the warden lives (no crossing); slaying it clears the milestone and offers boons; choose_boon grants one', async () => {
    const t = await newRun('v33w-play-1');
    for (let d = 1; d < 5; d++) expect((await t.descend()).ok).toBe(true);
    const key = t.me().pos!.floor;
    expect(t.world.floors[key].floorType).toBe('core:warden_hall');
    const warden = Object.values(t.world.entities).find((e) => e.pos?.floor === key && e.guardian?.warden)!;
    expect(warden).toBeTruthy();
    // 封じられた下り階段
    const f = t.world.floors[key];
    t.place(f.stairs.down[0].x, f.stairs.down[0].y);
    t.edit((e) => { e.stats!.hp = 999; e.stats!.maxHp = 999; });
    await t.act({ type: 'wait' });
    expect(t.obs().valid_actions.join('\n')).toContain('下り階段は封じられている');
    const s = await t.act({ type: 'stairs' });
    expect(s.ok).toBe(false);
    if (!s.ok) expect(s.error.code).toBe('sealed');
    expect(t.world.expeditions![0].progress.crossedDepth ?? 0).toBeLessThan(5);
    // 大守護者を倒す（隣で殴る）
    const wNow = structuredClone(t.world.entities[warden.id]);
    wNow.stats!.hp = 1;
    wNow.stats!.eva = -99;
    const p = t.me().pos!;
    const nx = p.x - 1;
    wNow.pos = { floor: key, x: nx, y: p.y };
    t.inject({ put: [wNow] });
    t.edit((e) => { e.stats!.acc = 99; });
    for (let k = 0; k < 6 && t.world.entities[warden.id]; k++) await t.act({ type: 'move', dir: 'w' });
    expect(t.world.entities[warden.id]).toBeUndefined();
    expect(t.world.milestones?.cleared).toEqual([5]);
    expect(t.r.session.history.some((e) => e.type === 'warden_slain')).toBe(true);
    const o = t.obs();
    expect(o.self.boon_choice?.options).toHaveLength(content.balance.guardian.warden.boonOptions);
    expect(o.alerts.some((a) => a.code === 'boon_pending')).toBe(true);
    expect(o.valid_actions.some((v) => v.startsWith('choose_boon 1'))).toBe(true);
    // 選ぶ（手番を使わない）
    const turns0 = t.me().actor!.turns;
    const pick = o.self.boon_choice!.options[1].id;
    expect((await t.act({ type: 'choose_boon', option: 2 })).ok).toBe(true);
    expect(t.me().actor!.turns).toBe(turns0);
    expect(t.me().boons).toContain(pick);
    expect(t.me().boonChoice).toBeUndefined();
    const again = await t.act({ type: 'choose_boon', option: 1 });
    expect(again.ok).toBe(false);
    // 封印が解け、降りられる（踏破にもなる）
    t.clearMonsters(false);
    t.place(f.stairs.down[0].x, f.stairs.down[0].y);
    await t.act({ type: 'wait' });
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    expect(t.world.floors[t.me().pos!.floor].depth).toBe(6);
    t.manager.closeAll();
  });

  it('the warden shows as a warden in the observation; its weakness stays hidden', async () => {
    const t = await newRun('v33w-obs-1');
    for (let d = 1; d < 5; d++) expect((await t.descend()).ok).toBe(true);
    const key = t.me().pos!.floor;
    const warden = Object.values(t.world.entities).find((e) => e.pos?.floor === key && e.guardian?.warden)!;
    const p = warden.pos!;
    t.place(p.x - 2, p.y);
    await t.act({ type: 'wait' });
    const m = t.obs().visible.monsters.find((x) => x.id === warden.id);
    expect(m?.guardian?.warden).toBe(true);
    expect(m?.guardian?.types).toHaveLength(2);
    expect(m?.guardian?.weakness).toBeUndefined();
    expect(formatObservationText(t.obs(), 'ja')).toContain('[大守護者');
    expect(JSON.stringify(t.view())).not.toContain(warden.guardian!.weakness!);
    t.manager.closeAll();
  });
});

describe('V3-3 the next milestone at camp and in expeditions; offers skip milestone depths (§3.2, §28.9)', () => {
  it('camp and expedition show the next milestone; after depth 2 is achieved the offers are 3 / 4 / 6', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r0 = await manager.createRun({ name: 'R', seed: 'v33w-camp-0', controller: { kind: 'agent', label: 't' } });
    if ('error' in r0) throw new Error(r0.error.message);
    const c0 = r0.port.observe({ map: false }).observation;
    expect(c0.camp?.milestone?.depth).toBe(5);
    expect(formatObservationText(c0, 'ja')).toContain('次の節目: 地下5階の大守護者');
    manager.closeAll();

    const t = await newRun('v33w-camp-1');
    expect(t.obs().expedition?.milestone?.depth).toBe(5);
    expect(t.obs().expedition?.text).toContain('次の節目: 地下5階');
    // 地下 2 階の踏破を達成して帰る
    const target = t.world.expeditions![0].objective.targetDepth!;
    expect(target).toBe(2);
    expect((await t.descend()).ok).toBe(true);
    const f = t.world.floors[t.me().pos!.floor];
    t.place(f.stairs.down[0].x, f.stairs.down[0].y);
    await t.act({ type: 'wait' });
    expect((await t.act({ type: 'extract' })).ok).toBe(true);
    const offers = t.world.camp!.offers;
    const depths = offers.map((o) => o.objective.targetDepth);
    for (const d of depths) expect(d! % 5).not.toBe(0);
    expect(depths).toEqual([3, 4, 6]);
    expect(t.world.camp!.milestone?.depth).toBe(5);
    void catalog;
    t.manager.closeAll();
  });
});

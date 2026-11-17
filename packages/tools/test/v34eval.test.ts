// V3-4 の後の AI 評価（2026-11-17）で見つかった不具合の回帰テスト。
// explore { toward: 'draft' } が風の向きの変化で往復しない／steady・flee の移動マクロが、唯一の道をふさぐ逃走中の敵を攻撃して進む。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Dir, Entity, GameEvent, PlayerView, World } from '@muse/shared';
import { applyEvent, buildNavGrid, collapseRepeats, compassDir, describeInventory, DIRS, findFrontiers, macroNext, macroStart, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
/** 風の方角とその両隣（macro の絞り込みと同じ） */
const near3 = (d: Dir): Dir[] => { const i = DIRS.indexOf(d); return [d, DIRS[(i + 1) % DIRS.length], DIRS[(i + DIRS.length - 1) % DIRS.length]]; };

async function newRun(seed: string, classId = 'core:warrior') {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId, controller: { kind: 'agent', label: 't' }, objective: 'auto' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject({ put: [e] }); };
  const place = (x: number, y: number) => edit((e) => { e.pos = { floor: e.pos!.floor, x, y }; });
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  /** 所持品に品を足す（スロットを返す） */
  const give = (kind: string, o: { affixes?: string[] } = {}): string => {
    const used = new Set((me().inv!.items).map((id) => world.entities[id]?.item?.slot));
    let slot = 'a';
    for (let c = 97; c <= 122; c++) if (!used.has(String.fromCharCode(c))) { slot = String.fromCharCode(c); break; }
    const id = `e_g${(++sid).toString(36).padStart(5, '0')}`;
    const it: Entity = { id, kind, sid: ++sid, item: { qty: 1, affixes: o.affixes ?? [], heldBy: meId, slot } };
    const body = structuredClone(me());
    body.inv!.items.push(id);
    inject({ put: [it, body] });
    return slot;
  };
  /** 知っている地図を、指定したマスだけにする（すべて見えている） */
  const knowOnly = (cells: { x: number; y: number }[]) => {
    const key = me().pos!.floor;
    const f = world.floors[key];
    const fk = world.players[pid].knowledge.floors[key];
    fk.seen = f.terrain.map(() => 0);
    for (const c of cells) fk.seen[c.y * f.width + c.x] = f.terrain[c.y * f.width + c.x];
    delete fk.mapped;
    world.players[pid].knowledge.visible = cells.map((c) => c.y * f.width + c.x);
  };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, obs, give, knowOnly };
}

let sid = 996000;
function fleeingMonster(id: string, kind: string, floor: string, x: number, y: number): Entity {
  sid++;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: { fleeBelowHpPct: 50 } } },
    stats: { hp: 1, maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
  };
}

function passable(world: World, key: string, x: number, y: number): boolean {
  const f = world.floors[key];
  const t = content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]];
  return x >= 0 && y >= 0 && x < f.width && y < f.height && t.passable && !t.stairs
    && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
}

function openLine(world: World, key: string, n: number): { p: { x: number; y: number }; dx: number; dy: number } {
  const f = world.floors[key];
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      let ok = true;
      for (let k = 0; k <= n && ok; k++) if (!passable(world, key, x + dx * k, y + dy * k)) ok = false;
      if (ok) return { p: { x, y }, dx, dy };
    }
  }
  throw new Error('no open line');
}

describe('AI evaluation fixes after V3-4 (2026-11-17)', () => {
  it('steady travel_to attacks a fleeing enemy that blocks the only known path; careful stops as blocked', async () => {
    for (const mode of ['steady', 'careful'] as const) {
      const t = await newRun('v34eval-flee-1');
      t.clearMonsters();
      const key = t.me().pos!.floor;
      const ln = openLine(t.world, key, 4);
      const cells = [0, 1, 2, 3, 4].map((k) => ({ x: ln.p.x + ln.dx * k, y: ln.p.y + ln.dy * k }));
      t.place(cells[0].x, cells[0].y);
      t.inject({ put: [fleeingMonster('e_fl0001', 'core:goblin', key, cells[1].x, cells[1].y)] });
      // 知っている地図を 1 マス幅の通路だけにする（逃走中の敵のマスを通らなければ行き先に着けない）
      const f = t.world.floors[key];
      const fk = t.world.players[t.pid].knowledge.floors[key];
      fk.seen = f.terrain.map(() => 0);
      for (const c of cells) fk.seen[c.y * f.width + c.x] = f.terrain[c.y * f.width + c.x];
      delete fk.mapped;
      // 通路の全部が見えている（逃走中の敵が視界にいる）
      t.world.players[t.pid].knowledge.visible = cells.map((c) => c.y * f.width + c.x);
      const h0 = t.r.session.history.length;
      const r = await t.act({ type: 'travel', to: cells[4], mode });
      const attacked = t.r.session.history.slice(h0).some((e) => e.type === 'attack' && (e as { attacker?: string }).attacker === t.meId && (e as { target?: string }).target === 'e_fl0001');
      if (mode === 'steady') {
        expect(r.ok).toBe(true);
        expect(attacked).toBe(true);
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe('blocked');
        expect(attacked).toBe(false);
      }
    }
  });

  it('explore toward the draft reaches the stairs on a seed where it used to run out the step limit (corridor frontier receding)', async () => {
    // 修正前は地下4階で 200 手の上限まで往復した（通路の境界が 1 マスずつ下がるたびに、遠い別の境界へ選び直していた）
    const t = await newRun('v34eval-draft-29');
    for (let depth = 1; depth < 4; depth++) {
      const f = t.world.floors[t.me().pos!.floor];
      t.edit((e) => { e.pos = { floor: f.key, x: f.stairs.down[0].x, y: f.stairs.down[0].y }; e.stats!.hp = e.stats!.maxHp = 999; });
      t.clearMonsters();
      await t.act({ type: 'wait' });
      expect((await t.act({ type: 'stairs' })).ok).toBe(true);
      t.clearMonsters();
      const r = await t.act({ type: 'explore', toward: 'draft' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.interrupted_by).not.toBe('step_limit');
    }
  });

  it('explore toward the draft keeps its chosen frontier when the draft direction changes as it walks', async () => {
    // 風の方角は歩くたびに変わる。決めた行き先を方角の絞り込みで外すと、2 マスの間を手数の上限まで往復した（評価の地下4階・地下6階）
    let checked = 0;
    for (let s = 0; s < 8 && checked < 3; s++) {
      const t = await newRun(`v34eval-draft-${s}`);
      t.clearMonsters();
      await t.act({ type: 'wait' });
      const base = projectPlayerView(t.world, t.pid);
      const pos = base.self.pos!;
      const grid = buildNavGrid(base, catalog)!;
      const fr = findFrontiers(grid).map((i) => ({ i, d: compassDir(pos, { x: i % grid.width, y: Math.trunc(i / grid.width) }) }));
      const withDraft = (d: Dir) => ({ ...base, floorHint: { ...(base.floorHint ?? { floor: base.floor!.key, explored: 0 }), draft: d } }) as PlayerView;
      for (const d1 of DIRS) {
        const state = macroStart(base, { type: 'explore', toward: 'draft' }, catalog);
        const first = macroNext(state, withDraft(d1), catalog, []);
        if (!('command' in first) || state.goal === undefined) continue;
        const g = state.goal;
        const gd = compassDir(pos, { x: g % grid.width, y: Math.trunc(g / grid.width) });
        // 行き先が新しい方角の絞り込みから外れ、しかもその方角に別の境界がある向き
        const d2 = DIRS.find((d) => { const near = new Set(near3(d)); return gd !== null && !near.has(gd) && fr.some((f) => f.d !== null && near.has(f.d)); });
        if (!d2) continue;
        macroNext(state, withDraft(d2), catalog, []);
        expect(state.goal).toBe(g);
        checked++;
        break;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('movement macros stop before a discovered trap instead of stepping on it', async () => {
    for (const mode of ['careful', 'steady'] as const) {
      const t = await newRun('v34eval-trap-1');
      t.clearMonsters();
      const key = t.me().pos!.floor;
      const ln = openLine(t.world, key, 4);
      const cells = [0, 1, 2, 3, 4].map((k) => ({ x: ln.p.x + ln.dx * k, y: ln.p.y + ln.dy * k }));
      t.place(cells[0].x, cells[0].y);
      t.inject({ put: [{ id: 'e_tr0001', kind: 'core:trap_dart', sid: ++sid, pos: { floor: key, ...cells[1] }, trap: { revealedTo: [t.pid] } }] });
      t.knowOnly(cells);
      const r = await t.act({ type: 'travel', to: cells[4], mode });
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.error.code).toBe('blocked'); expect(r.error.message).toContain('罠'); expect(r.error.hint).toContain(`move { dir: '${ln.dx === 1 ? 'e' : ln.dx === -1 ? 'w' : ln.dy === 1 ? 's' : 'n'}' }`); }
      expect(t.me().pos).toMatchObject(cells[0]);
    }
  });

  it('a macro that stops on finding stairs first picks up the item at its feet', async () => {
    const t = await newRun('v34eval-pick-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x, ln.p.y);
    const here = { x: ln.p.x, y: ln.p.y };
    t.inject({ put: [{ id: 'e_pk0001', kind: 'core:potion_healing', sid: ++sid, pos: { floor: key, ...here }, item: { qty: 1, affixes: [] } }] });
    const st = f.stairs.down[0];
    // 階段を知らない状態で始め、次の判断で階段が見える
    t.knowOnly([here, { x: ln.p.x + ln.dx, y: ln.p.y + ln.dy }, { x: ln.p.x + ln.dx * 2, y: ln.p.y + ln.dy * 2 }]);
    const v1 = projectPlayerView(t.world, t.pid);
    const state = macroStart(v1, { type: 'explore', mode: 'steady' }, catalog);
    t.knowOnly([here, { x: ln.p.x + ln.dx, y: ln.p.y + ln.dy }, { x: ln.p.x + ln.dx * 2, y: ln.p.y + ln.dy * 2 }, st]);
    const v2 = projectPlayerView(t.world, t.pid);
    const d1 = macroNext(state, v2, catalog, []);
    expect(d1).toEqual({ command: { type: 'pickup', item: 'e_pk0001' } });
    const d2 = macroNext(state, v2, catalog, []);
    expect(d2).toEqual({ stop: 'stairs_seen' });
  });

  it('valid_actions offers equip for an unidentified ring; the inventory detail names weapon traits and shows affixed stats once', async () => {
    const t = await newRun('v34eval-obs-1');
    t.clearMonsters();
    const ring = t.give('core:ring_hunter');
    const dagger = t.give('core:dagger', { affixes: ['core:keen'] });
    await t.act({ type: 'wait' });
    expect(t.world.players[t.pid].knowledge.identified).not.toContain('core:ring_hunter');
    expect(t.obs().valid_actions.some((a) => a.startsWith(`equip ${ring} `))).toBe(true);
    const inv = describeInventory(projectPlayerView(t.world, t.pid), catalog);
    const line = inv.text.split('\n').find((l) => l.startsWith(`${dagger})`))!;
    expect(line).toContain('速い');
    expect(line).not.toContain('quick');
    expect(line).not.toContain(' / ダメージ');
  });

  it('repeated recent-event lines collapse into one with a count', () => {
    expect(collapseRepeats(['a', 'b', 'b', 'b', 'c', 'b'])).toEqual(['a', 'b ×3', 'c', 'b']);
  });

  it('a stationary monster seen during a macro keeps its neighbours avoided after it drops out of view, until its cell is seen empty', async () => {
    // 見えると遠回り・見えないと近道、を繰り返して 2 マスの間を往復した（bot の確認、地下14階）
    const t = await newRun('v34eval-mold-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 4);
    const cells = [0, 1, 2, 3, 4].map((k) => ({ x: ln.p.x + ln.dx * k, y: ln.p.y + ln.dy * k }));
    t.place(cells[0].x, cells[0].y);
    const mold = { id: 'e_md0001', kind: 'core:spore_mold', sid: ++sid, pos: { floor: key, ...cells[4] },
      actor: { speed: 100, nextActAt: 0, faction: 'monster' as const, turns: 0, ai: { archetype: 'stationary', state: 'unaware' as const, targetPos: null, lostTurns: 0, params: {} } },
      stats: { hp: 5, maxHp: 5, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' }, base: { hp: 5, maxHp: 5, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' }, statuses: [] } as unknown as Entity;
    t.inject({ put: [mold] });
    t.knowOnly(cells);
    const v1 = projectPlayerView(t.world, t.pid);
    expect(v1.entities.some((e) => e.id === 'e_md0001')).toBe(true);
    const state = macroStart(v1, { type: 'travel', to: cells[2], mode: 'steady' }, catalog);
    macroNext(state, v1, catalog, []);
    expect(state.stationary).toEqual([cells[4]]);
    // 見えなくなっても覚えている
    t.world.players[t.pid].knowledge.visible = cells.slice(0, 3).map((c) => c.y * t.world.floors[key].width + c.x);
    const v2 = projectPlayerView(t.world, t.pid);
    expect(v2.entities.some((e) => e.id === 'e_md0001')).toBe(false);
    macroNext(state, v2, catalog, []);
    expect(state.stationary).toEqual([cells[4]]);
    // そのマスが見えていて、もういなければ忘れる
    t.inject({ del: ['e_md0001'] });
    t.knowOnly(cells);
    macroNext(state, projectPlayerView(t.world, t.pid), catalog, []);
    expect(state.stationary).toEqual([]);
  });
});

// V3-5（IMPROVEMENTS_V3 §5.2）の確認: バイオームの仕掛け。浅い水の手番、脆い天井、胞子嚢と毒の雲、レバーと格子扉、背の高い草で隠れる、
// 押せる本棚、残り頁、生成（石の広間のレバー・湿った洞窟の天井・遺跡の胞子嚢・沈んだ書庫）。
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { Entity } from '@muse/shared';
import { projectPlayerView } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
let sid = 997000;
type A = Awaited<ReturnType<typeof arena>>;
const since = (a: A, n: number) => a.r.session.history.slice(n);
const setT = (a: A, x: number, y: number, id: string) => { const f = a.world.floors[a.key]; f.terrain[y * f.width + x] = a.world.meta.terrainTable.indexOf(id); };
const terr = (a: A, x: number, y: number) => { const f = a.world.floors[a.key]; return a.world.meta.terrainTable[f.terrain[y * f.width + x]]; };
const feature = (a: A, kind: string, x: number, y: number, state: string, extra: Partial<Entity> = {}): Entity => ({ id: `e_b${(++sid).toString(36).padStart(5, '0')}`, kind, sid: ++sid, pos: { floor: a.key, x, y }, feature: { state }, ...extra } as Entity);
const goblin = (a: A, id: string, x: number, y: number, o: { state?: 'hunting' | 'unaware' | 'asleep' } = {}): Entity => ({
  id, kind: 'core:goblin', sid: ++sid, pos: { floor: a.key, x, y },
  actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.state ?? 'unaware', targetPos: null, lostTurns: 0, params: {} }, ...(o.state === 'asleep' ? { dormant: true } : {}) },
  stats: { hp: 30, maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, base: { maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, statuses: [],
} as Entity);
const quiet = (a: A) => { const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + a.W - 1, y: a.oy + a.H - 1 }; a.inject({ put: [g] }); };

describe('V3-5 biome rules (§5.2): water, ceilings, spore pods', () => {
  it('entering shallow water costs 150', async () => {
    const a = await arena('v35e-water', { map: ['P~....', '......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    quiet(a);
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const t0 = a.world.entities[a.meId].actor!.nextActAt;
    await a.r.port.act({ type: 'move', dir: 'e' }, { source: 'bot' });
    const t1 = a.world.entities[a.meId].actor!.nextActAt;
    expect(terr(a, a.ox + 1, a.oy)).toBe('core:shallow_water');
    expect(t1 - t0).toBe(150);
    a.manager.closeAll();
  });

  it('a brittle ceiling falls on a loud noise nearby, hurting those under it and leaving rubble', async () => {
    const a = await arena('v35e-ceil', { map: ['P......', '.......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, items: [{ kind: 'core:throwing_knife', qty: 3 }] } });
    quiet(a);
    const c = feature(a, 'core:brittle_ceiling', a.ox + 4, a.oy, 'intact');
    a.inject({ put: [c, goblin(a, 'e_cv0001', a.ox + 4, a.oy + 1, { state: 'asleep' })] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const slot = a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:throwing_knife')!.item!.slot!;
    const hp0 = a.world.entities.e_cv0001.stats!.hp;
    await a.r.port.act({ type: 'throw', slot, target: { x: a.ox + 3, y: a.oy } }, { source: 'bot' });
    expect(a.world.entities[c.id].feature!.state).toBe('fallen');
    expect(terr(a, a.ox + 4, a.oy)).toBe('core:rubble');
    expect(a.world.entities.e_cv0001.stats!.hp).toBeLessThan(hp0);
    a.manager.closeAll();
  });

  it('poking a spore pod poisons everyone next to it and leaves a cloud that clears after 3 turns', async () => {
    const a = await arena('v35e-pod', { map: ['P.....', '......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    quiet(a);
    const pod = feature(a, 'core:spore_pod', a.ox + 1, a.oy, 'ripe');
    a.inject({ put: [pod] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect((await a.r.port.act({ type: 'interact', dir: 'e' }, { source: 'bot' })).ok).toBe(true);
    expect(a.world.entities[pod.id].feature!.state).toBe('burst');
    expect(a.world.entities[a.meId].statuses?.some((s) => s.id === 'core:poison')).toBe(true);
    const clouds = () => Object.values(a.world.entities).filter((e) => e.kind === 'core:spore_cloud' && e.pos?.floor === a.key);
    expect(clouds().length).toBeGreaterThan(0);
    for (let k = 0; k < 5; k++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(clouds().length).toBe(0);
    a.manager.closeAll();
  });
});

describe('V3-5 biome rules (§5.2): levers, tall grass, bookshelves, loose pages', () => {
  it('a lever closes and reopens its grate; a closed grate stops movement but not sight or throws', async () => {
    const a = await arena('v35e-lever', { map: ['P.....', '......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    quiet(a);
    setT(a, a.ox + 3, a.oy, 'core:grate_open');
    const lever = feature(a, 'core:lever', a.ox + 1, a.oy + 1, 'up', { links: [{ x: a.ox + 3, y: a.oy }] });
    a.inject({ put: [lever] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect((await a.r.port.act({ type: 'interact', dir: 'se' }, { source: 'bot' })).ok).toBe(true);
    expect(terr(a, a.ox + 3, a.oy)).toBe('core:grate_closed');
    const f = a.world.floors[a.key];
    expect(a.world.players[a.pid].knowledge.visible.includes(a.oy * f.width + a.ox + 4)).toBe(true);
    expect((await a.r.port.act({ type: 'interact', dir: 'se' }, { source: 'bot' })).ok).toBe(true);
    expect(terr(a, a.ox + 3, a.oy)).toBe('core:grate_open');
    a.manager.closeAll();
  });

  it('someone in tall grass is seen only from next to it', async () => {
    const a = await arena('v35e-grass', { map: ['P.....', '......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    quiet(a);
    for (const x of [a.ox + 3, a.ox + 1]) setT(a, x, a.oy + 1, 'core:tall_grass');
    a.inject({ put: [goblin(a, 'e_gr0001', a.ox + 3, a.oy + 1, { state: 'asleep' })] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(projectPlayerView(a.world, a.pid).entities.some((e) => e.id === 'e_gr0001')).toBe(false);
    const g = structuredClone(a.world.entities.e_gr0001); g.pos = { ...g.pos!, x: a.ox + 1 };
    a.inject({ put: [g] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(projectPlayerView(a.world, a.pid).entities.some((e) => e.id === 'e_gr0001')).toBe(true);
    a.manager.closeAll();
  });

  it('a bookshelf is pushed when the cell beyond is free floor; otherwise it does not move', async () => {
    const a = await arena('v35e-push', { map: ['P.....', '......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    quiet(a);
    setT(a, a.ox + 1, a.oy, 'core:bookshelf');
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const r = await a.r.port.act({ type: 'move', dir: 'e' }, { source: 'bot' });
    expect(r.ok).toBe(true);
    expect(terr(a, a.ox + 2, a.oy)).toBe('core:bookshelf');
    expect(terr(a, a.ox + 1, a.oy)).toBe('core:floor');
    expect(a.world.entities[a.meId].pos).toMatchObject({ x: a.ox + 1, y: a.oy });
    // 向こうが壁なら押せない
    setT(a, a.ox + 3, a.oy, 'core:wall');
    const no = await a.r.port.act({ type: 'move', dir: 'e' }, { source: 'bot' });
    expect(no.ok).toBe(false);
    a.manager.closeAll();
  });

  it('a loose page reveals only the layout within 10 cells', async () => {
    const a = await arena('v35e-page', { map: ['P..'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, items: [{ kind: 'core:loose_page', qty: 1 }] } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const slot = a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:loose_page')!.item!.slot!;
    const n = a.r.session.history.length;
    expect((await a.r.port.act({ type: 'use', slot }, { source: 'bot' })).ok).toBe(true);
    const ku = since(a, n).find((e) => e.type === 'knowledge_updated') as unknown as { newlySeen: number[] } | undefined;
    const f = a.world.floors[a.key];
    const me = a.world.entities[a.meId].pos!;
    const cells = (ku?.newlySeen ?? []).filter((_, i) => i % 2 === 0);
    expect(cells.length).toBeGreaterThan(0);
    for (const i of cells) expect(Math.max(Math.abs((i % f.width) - me.x), Math.abs(Math.trunc(i / f.width) - me.y))).toBeLessThanOrEqual(10);
    a.manager.closeAll();
  });
});

describe('V3-5 biome rules (§5.2): generation', () => {
  it('stone halls get levers on grates; damp caves get brittle ceilings; ruins get spore pods; the sunken archive has shelves and loose pages', async () => {
    const a = await arena('v35e-gen', { map: ['P.G'], guardian: { kind: 'core:goblin', hp: 5, dmg: '1d1', types: [], state: 'asleep' } });
    const tt = a.world.meta.terrainTable;
    const seen: Record<string, number> = {};
    for (let s = 0; s < 120; s++) for (const d of [3, 7]) {
      const g = generateFloor(content, `v35e-gen-${s}`, 'main', d, tt);
      const b = g.floor.biome;
      const kinds = new Set(g.spawns.filter((sp) => sp.type === 'feature' || sp.type === 'item').map((sp) => (sp as { kind: string }).kind));
      if (b === 'core:stone_halls' && kinds.has('core:lever')) {
        seen.lever = (seen.lever ?? 0) + 1;
        const lv = g.spawns.find((sp) => sp.type === 'feature' && sp.kind === 'core:lever') as { links?: { x: number; y: number }[] };
        const q = lv.links![0];
        expect(tt[g.floor.terrain[q.y * g.floor.width + q.x]]).toBe('core:grate_open');
      }
      if (b === 'core:damp_caves' && kinds.has('core:brittle_ceiling')) seen.ceiling = (seen.ceiling ?? 0) + 1;
      if (b === 'core:overgrown_ruins' && kinds.has('core:spore_pod')) seen.pod = (seen.pod ?? 0) + 1;
      if (b === 'core:sunken_archive') {
        seen.archive = (seen.archive ?? 0) + 1;
        expect(d).toBeGreaterThanOrEqual(6);
        if (kinds.has('core:loose_page')) seen.page = (seen.page ?? 0) + 1;
        if (g.floor.terrain.some((t) => tt[t] === 'core:bookshelf')) seen.shelf = (seen.shelf ?? 0) + 1;
      }
    }
    for (const k of ['lever', 'ceiling', 'pod', 'archive', 'page', 'shelf']) expect(seen[k] ?? 0).toBeGreaterThan(0);
    a.manager.closeAll();
  });
});

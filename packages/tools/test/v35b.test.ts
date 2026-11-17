// V3-5b（IMPROVEMENTS_V3 §44.7）の確認: 深層の敵（大鬼の大振り・血吸い蝙蝠の吸血・骨の射手はその場で撃つ）、
// 深さの上限と地下 18 階までの表、格 1 の守護者から射撃する型を除く、大振りの予備動作の文と外れる一歩。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor, guardianCandidates, guardianTraits } from '@muse/engine';
import type { Entity, GameEvent } from '@muse/shared';
import { buildObservation, projectPlayerView } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);

type A = Awaited<ReturnType<typeof arena>>;
/** arena の「守護者」を、その種族の普通の個体にする */
function asKind(a: A, kind: string, o: { hp?: number; acc?: number; dmg?: string; speed?: number } = {}): Entity {
  const g = structuredClone(a.world.entities[a.gId]);
  delete g.role; delete g.guardian; delete g.home;
  g.kind = kind;
  const def = content.monsters[kind];
  g.actor!.ai = { archetype: def.ai.archetype, state: 'hunting', targetPos: null, lostTurns: 0, params: Object.fromEntries(Object.entries(def.ai).filter(([k]) => k !== 'archetype')) as Record<string, number> };
  g.actor!.speed = o.speed ?? def.speed;
  if (o.hp !== undefined) { g.stats!.hp = o.hp; g.stats!.maxHp = o.hp; g.base!.maxHp = o.hp; }
  if (o.acc !== undefined) { g.stats!.acc = o.acc; g.base!.acc = o.acc; }
  if (o.dmg) { g.stats!.dmg = o.dmg; g.base!.dmg = o.dmg; }
  a.inject({ put: [g] });
  return a.world.entities[a.gId];
}
const since = (a: A, n: number) => a.r.session.history.slice(n);

describe('V3-5b deep monsters (§44.7)', () => {
  it('the ogre braces next to you, then strikes the cell you were on; stepping out makes it miss and stuns it', async () => {
    const a = await arena('v35b-ogre-1', { map: ['PG...', '.....'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 300 } });
    asKind(a, 'core:ogre', { hp: 300, acc: 99, dmg: '1d1' });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const o = a.world.entities[a.gId];
    expect(o.actor!.ai!.intent?.kind).toBe('swinging');
    const me = a.world.entities[a.meId];
    expect(o.actor!.ai!.intent?.pos).toEqual({ x: me.pos!.x, y: me.pos!.y });
    // 観測: 予備動作の文と、的から外れる一歩
    const obs = buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
    expect(obs.visible.monsters.find((m) => m.id === a.gId)?.intent?.text).toContain('大振りの構え');
    expect(obs.valid_actions.some((x) => x.includes('大振りの的から外れる'))).toBe(true);
    // 1 歩外れる → 空を切って朦朧
    const n = a.r.session.history.length;
    await a.r.port.act({ type: 'move', dir: 's' }, { source: 'bot' });
    expect(since(a, n).some((e) => e.type === 'monster_acted' && (e as { act?: string }).act === 'swing_missed')).toBe(true);
    expect(a.world.entities[a.gId].statuses?.some((s) => s.id === 'core:stun')).toBe(true);
    a.manager.closeAll();
  });

  it('staying on the cell takes a double hit', async () => {
    const a = await arena('v35b-ogre-2', { map: ['PG...'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 300 } });
    asKind(a, 'core:ogre', { hp: 300, acc: 99, dmg: '3d1' });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const n = a.r.session.history.length;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const ev = since(a, n);
    expect(ev.some((e) => e.type === 'monster_acted' && (e as { act?: string }).act === 'swing_hit')).toBe(true);
    const dmg = ev.filter((e) => e.type === 'damaged' && (e as { target?: string }).target === a.meId).map((e) => (e as { amount: number }).amount);
    // 3 − 装甲 の 2 倍（倍率は装甲を引いた後に掛かる。突進と同じ）
    const armor = a.world.entities[a.meId].stats!.armor;
    expect(Math.max(...dmg)).toBe(2 * Math.max(1, 3 - armor));
    a.manager.closeAll();
  });

  it('a blood bat heals by the damage it deals', async () => {
    const a = await arena('v35b-bat', { map: ['PG...'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 300 } });
    const b = asKind(a, 'core:blood_bat', { hp: 30, acc: 99, dmg: '4d1' });
    const hurt = structuredClone(b); hurt.stats!.hp = 10;
    a.inject({ put: [hurt] });
    const n = a.r.session.history.length;
    for (let k = 0; k < 3; k++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const heals = since(a, n).filter((e) => e.type === 'healed' && (e as { target?: string }).target === a.gId && (e as { via?: string }).via === 'drain') as unknown as GameEvent[];
    expect(heals.length).toBeGreaterThan(0);
    expect(a.world.entities[a.gId].stats!.hp).toBeGreaterThan(10);
    a.manager.closeAll();
  });

  it('a bone archer stands and shoots instead of backing away; adjacent, it fights', async () => {
    const a = await arena('v35b-archer', { map: ['P....G'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 300 } });
    asKind(a, 'core:bone_archer', { hp: 300 });
    const p0 = { ...a.world.entities[a.gId].pos! };
    const n = a.r.session.history.length;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(since(a, n).some((e) => e.type === 'attack' && (e as { attacker?: string }).attacker === a.gId && (e as { ranged?: boolean }).ranged)).toBe(true);
    expect(a.world.entities[a.gId].pos).toMatchObject({ x: p0.x, y: p0.y });
    // 隣にいても逃げない
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + 1, y: a.oy };
    a.inject({ put: [g] });
    const n2 = a.r.session.history.length;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(a.world.entities[a.gId].pos).toMatchObject({ x: a.ox + 1, y: a.oy });
    expect(since(a, n2).some((e) => e.type === 'attack' && (e as { attacker?: string }).attacker === a.gId && !(e as { ranged?: boolean }).ranged)).toBe(true);
    a.manager.closeAll();
  });
});

describe('V3-5b tables (§44.7)', () => {
  it('tables are defined to depth 18; deep floors have the new species and no orc brutes past 14', async () => {
    expect(content.deepestDefined).toBe(18);
    expect(content.monsters['core:orc_brute'].depth.max).toBe(14);
    const a = await arena('v35b-tbl', { map: ['P.G'], guardian: { kind: 'core:goblin', hp: 5, dmg: '1d1', types: [], state: 'asleep' } });
    const tt = a.world.meta.terrainTable;
    const seen = new Set<string>();
    for (let s = 0; s < 30; s++) for (const d of [15, 16, 17, 18]) {
      const g = generateFloor(content, `v35b-tbl-${s}`, 'main', d, tt);
      for (const sp of g.spawns) {
        if (sp.type !== 'monster' || sp.guardian) continue;
        seen.add(sp.kind);
        // 地下 18 階までは深層強化しない
        expect(sp.tier).toBe(0);
        const def = content.monsters[sp.kind];
        expect(def.depth.max === undefined || def.depth.max >= d).toBe(true);
      }
    }
    for (const k of ['core:ogre', 'core:blood_bat', 'core:bone_archer']) expect(seen.has(k)).toBe(true);
    expect(seen.has('core:orc_brute')).toBe(false);
    a.manager.closeAll();
  });

  it('rank-1 guardians exclude the standing shooter; offers show drain and heavy swing', () => {
    const ft = content.floorTypes['core:standard'];
    for (const b of Object.values(content.biomes)) {
      expect(guardianCandidates(content, ft, b, 12, 1).some((m) => m.id === 'core:bone_archer')).toBe(false);
    }
    expect(guardianTraits({ content } as never, 'core:ogre')).toContain('heavy_swing');
    expect(guardianTraits({ content } as never, 'core:blood_bat')).toContain('drain');
  });
});

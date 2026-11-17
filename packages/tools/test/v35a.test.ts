// V3-5a（IMPROVEMENTS_V3 §35.10）の確認: 弱い種族の深さの上限・地下 4〜14 階の 4 種・装甲を抜く射撃・状態異常「錆」・
// 見れば分かる特徴（錆びさせる・装甲を抜く）・守護者の表。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor, guardianCandidates, guardianTraits, selectBiome, selectFloorType } from '@muse/engine';
import type { Entity, GameEvent } from '@muse/shared';
import { armorWithStatuses, guardianForecastText } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
const table = content.terrain.map((t) => t.id);
const NEW = ['core:cave_wolf', 'core:rust_slime', 'core:hexfire_caster', 'core:stoneskin_beetle'];

describe('V3-5a monsters by depth (§35.10)', () => {
  it('weak species do not appear below their max depth; the four new species appear between depths 4 and 14', () => {
    const MAX: Record<string, number> = { 'core:cave_rat': 4, 'core:jackal': 6, 'core:goblin': 7, 'core:goblin_slinger': 9 };
    const bad: string[] = [];
    const seen = new Map<string, number[]>();
    for (let s = 0; s < 30; s++) {
      for (let d = 1; d <= 16; d++) {
        const g = generateFloor(content, `v35a-${s}`, 'main', d, table);
        for (const sp of g.spawns) {
          if (!content.monsters[sp.kind]) continue;
          if (MAX[sp.kind] !== undefined && d > MAX[sp.kind]) bad.push(`${sp.kind}@${d}`);
          if (NEW.includes(sp.kind)) seen.set(sp.kind, [...(seen.get(sp.kind) ?? []), d]);
        }
      }
    }
    expect(bad).toEqual([]);
    // 浅い階にも、低確率で深層の敵が混ざる（oodDepth 階まで深い表から引く。今までどおり）
    const ood = content.spawnTables['core:default']?.oodDepth ?? 3;
    for (const k of NEW) {
      const ds = seen.get(k) ?? [];
      const min = content.monsters[k].depth.min;
      expect(ds.length, k).toBeGreaterThan(0);
      expect(ds.every((d) => d + Math.min(ood, d) >= min), k).toBe(true);
      expect(ds.filter((d) => d >= min).length / ds.length, k).toBeGreaterThan(0.9);
      // deepestDefined より深い階はその階の表を強化して使う（今までどおり）ので、上限は実効の深さで比べる
      expect(Math.max(...ds.map((d) => Math.min(d, content.deepestDefined))), k).toBeLessThanOrEqual(content.monsters[k].depth.max!);
    }
  });

  it('they enter the guardian tables (rank 1 still leaves out the ranged kiter)', () => {
    const kinds = new Set<string>();
    const rank1 = new Set<string>();
    for (let s = 0; s < 20; s++) for (const d of [6, 7, 8, 9, 10]) {
      const ft = selectFloorType(content, `v35a-g-${s}`, 'main', d);
      const bi = selectBiome(content, `v35a-g-${s}`, 'main', d);
      for (const r of [2, 3] as const) for (const m of guardianCandidates(content, ft, bi, d, r)) kinds.add(m.id);
      for (const m of guardianCandidates(content, ft, bi, d, 1)) rank1.add(m.id);
    }
    expect(NEW.filter((k) => kinds.has(k)).length).toBeGreaterThanOrEqual(2);
    expect(rank1.has('core:hexfire_caster')).toBe(false);
  });
});

/** arena の「守護者」を、その種族の普通の個体にする */
function asMonster(a: Awaited<ReturnType<typeof arena>>, kind: string, o: { acc?: number; dmg?: string; archetype?: string; x?: number } = {}) {
  const g = structuredClone(a.world.entities[a.gId]);
  delete g.role; delete g.guardian; delete g.home;
  g.kind = kind;
  if (o.acc !== undefined) { g.stats!.acc = o.acc; g.base!.acc = o.acc; }
  if (o.dmg) { g.stats!.dmg = o.dmg; g.base!.dmg = o.dmg; }
  if (o.archetype && g.actor?.ai) g.actor.ai.archetype = o.archetype;
  if (o.x !== undefined) g.pos = { ...g.pos!, x: o.x };
  a.inject({ put: [g] });
}
function setArmor(a: Awaited<ReturnType<typeof arena>>, armor: number) {
  const me = structuredClone(a.world.entities[a.meId]);
  me.stats!.armor = armor; me.base!.armor = armor;
  a.inject({ put: [me] });
}
const myDamage = (h: GameEvent[], meId: string) => h.filter((e) => e.type === 'damaged' && e.target === meId).map((e) => (e as Extract<GameEvent, { type: 'damaged' }>).dealt ?? 0);
/** 会心でない命中の被害（会心は装甲を無視するルールなので除く） */
function plainHits(h: GameEvent[], meId: string): number[] {
  const out: number[] = [];
  let crit = false;
  for (const e of h) {
    if (e.type === 'attack' && e.target === meId) crit = e.crit;
    if (e.type === 'damaged' && e.target === meId && !crit) out.push(e.dealt ?? e.amount);
  }
  return out;
}

describe('V3-5a pierce and rust (§35.10)', () => {
  it('a hexfire caster\'s shots ignore armor; a slinger\'s do not', async () => {
    const shots = async (kind: string) => {
      const a = await arena(`v35a-pierce-${kind}`, { map: ['P....G'], guardian: { kind, hp: 500, dmg: '1d1', types: [], state: 'hunting', archetype: 'ranged_kiter' }, player: { hp: 500 } });
      asMonster(a, kind, { acc: 40 });
      setArmor(a, 10);
      const h0 = a.r.session.history.length;
      for (let i = 0; i < 25; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      const d = plainHits(a.r.session.history.slice(h0), a.meId);
      a.manager.closeAll();
      return d;
    };
    const pierce = await shots('core:hexfire_caster');
    expect(pierce.length).toBeGreaterThan(3);
    expect(Math.max(...pierce)).toBeGreaterThan(1);
    const sling = await shots('core:goblin_slinger');
    expect(sling.length).toBeGreaterThan(3);
    expect(Math.max(...sling)).toBe(1);
  });

  it('a rust slime\'s hit rusts your armor by 2 for 10 turns; it does not stack, never goes below 0, and shows in your defense', async () => {
    const a = await arena('v35a-rust', { map: ['PG'], guardian: { kind: 'core:rust_slime', hp: 500, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 500 } });
    asMonster(a, 'core:rust_slime', { acc: 40, dmg: '1d1+5' });
    setArmor(a, 4);
    const me = () => a.world.entities[a.meId] as Entity;
    const h0 = a.r.session.history.length;
    // 最初の一撃は錆びる前の装甲 4（6 − 4 = 2）、錆びた後は装甲 2（6 − 2 = 4）
    for (let i = 0; i < 6 && myDamage(a.r.session.history.slice(h0), a.meId).length < 3; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const dmg = myDamage(a.r.session.history.slice(h0), a.meId);
    expect(dmg[0]).toBe(2);
    expect(dmg.slice(1)).toEqual(dmg.slice(1).map(() => 4));
    const rust = me().statuses!.filter((s) => s.id === 'core:rust');
    expect(rust).toHaveLength(1);
    expect(rust[0].turnsLeft).toBeLessThanOrEqual(10);
    expect(rust[0].power).toBe(1);
    const obs = a.r.port.observe({ map: false }).observation;
    expect(obs.self.defense.armor).toBe(2);
    expect(obs.self.statuses.some((s) => s.id === 'core:rust')).toBe(true);
    // 0 未満にはならない（素の装甲 1 なら 0、もともと 0 なら 0）
    expect(armorWithStatuses(catalog.statuses, [{ id: 'core:rust' }], 1)).toBe(0);
    expect(armorWithStatuses(catalog.statuses, [{ id: 'core:rust' }], 0)).toBe(0);
    expect(armorWithStatuses(catalog.statuses, [{ id: 'core:rust' }, { id: 'core:poison' }], 7)).toBe(5);
    // 離れて 10 手番で切れる
    a.inject({ del: [a.gId] });
    for (let i = 0; i < 11; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(me().statuses!.some((s) => s.id === 'core:rust')).toBe(false);
    expect(a.r.port.observe({ map: false }).observation.self.defense.armor).toBe(4);
    a.manager.closeAll();
  });
});

describe('V3-5a visible traits (§35.10)', () => {
  it('rusting and pierce are seen at first sight, in the monster line and in look; guardian forecasts carry them', async () => {
    const a = await arena('v35a-traits', { map: ['P..G'], guardian: { kind: 'core:rust_slime', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    asMonster(a, 'core:rust_slime');
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const m = a.r.port.observe({ map: false }).observation.visible.monsters.find((x) => x.id === a.gId)!;
    expect(m.traits).toContain('rusting');
    expect(a.r.port.look(a.gId).text).toContain('見た目: 錆びさせる');
    a.manager.closeAll();
    expect(guardianTraits({ content } as never, 'core:hexfire_caster')).toEqual(expect.arrayContaining(['ranged', 'pierce']));
    expect(guardianTraits({ content } as never, 'core:stoneskin_beetle')).toEqual(expect.arrayContaining(['slow', 'armored']));
    expect(guardianTraits({ content } as never, 'core:rust_slime')).toContain('rusting');
    expect(guardianForecastText('ja', { rank: 2, traits: ['rusting', 'slow'] })).toBe('守護者: 格 2・錆びさせる・遅い');
    expect(guardianForecastText('ja', { rank: 3, traits: ['ranged', 'pierce'] })).toBe('守護者: 格 3・射撃する・装甲を抜く・普通の速さ');
  });
});

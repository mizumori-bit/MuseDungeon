// V3-5（IMPROVEMENTS_V3 §5.3・§5.4）の確認: 階の異変（到着の文だけ・深い眠り・巡回・賞金首・荒らされた跡）、名前付きの強敵、
// 未鑑定の手がかり（持って 30 手番・斥候は拾った時点）、初見の描写（changes の first_seen）。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { Entity, GameEvent } from '@muse/shared';
import { buildObservation, projectPlayerView } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 996000;
type A = Awaited<ReturnType<typeof arena>>;
const since = (a: A, n: number) => a.r.session.history.slice(n);
const goblin = (a: A, id: string, x: number, y: number, o: { asleep?: boolean; sight?: number; kind?: string } = {}): Entity => ({
  id, kind: o.kind ?? 'core:goblin', sid: ++sid, pos: { floor: a.key, x, y },
  actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.asleep ? 'asleep' : 'unaware', targetPos: null, lostTurns: 0, params: {} }, ...(o.asleep ? { dormant: true } : {}) },
  stats: { hp: 30, maxHp: 30, acc: 0, eva: -50, might: 0, armor: 0, sight: o.sight ?? 8, dmg: '1d1' }, base: { maxHp: 30, acc: 0, eva: -50, might: 0, armor: 0, sight: o.sight ?? 8, dmg: '1d1' }, statuses: [],
} as Entity);

describe('V3-5 floor events (§5.3)', () => {
  it('about a quarter of standard floors get an event; only the arrival text reaches the player', async () => {
    const a = await arena('v35d-gen', { map: ['P.G'], guardian: { kind: 'core:goblin', hp: 5, dmg: '1d1', types: [], state: 'asleep' } });
    const tt = a.world.meta.terrainTable;
    const by: Record<string, number> = {};
    let floors = 0;
    for (let s = 0; s < 120; s++) {
      const g = generateFloor(content, `v35d-ev-${s}`, 'main', 7, tt);
      if (!content.floorTypes[g.floor.floorType].rules.events) continue;
      floors++;
      const ev = g.floor.event;
      if (!ev) continue;
      by[ev.handler] = (by[ev.handler] ?? 0) + 1;
      expect(ev.arrival.ja.length).toBeGreaterThan(0);
      const mons = g.spawns.filter((sp) => sp.type === 'monster' && !sp.guardian);
      if (ev.handler === 'deep_sleep') for (const m of mons) expect(m.type === 'monster' && m.asleep).toBe(true);
      if (ev.handler === 'patrol' || ev.handler === 'bounty') expect(mons.some((m) => m.type === 'monster' && (m.route?.length ?? 0) >= 4 && !!m.elite)).toBe(true);
      if (ev.handler === 'ransacked') expect(g.floor.regions.some((r) => r.tags.includes('core:camp_remains'))).toBe(true);
    }
    const total = Object.values(by).reduce((x, y) => x + y, 0);
    expect(total * 100).toBeGreaterThan(floors * 12);
    expect(total * 100).toBeLessThan(floors * 40);
    expect(Object.keys(by).length).toBeGreaterThanOrEqual(4);
    // 観測には到着の文だけ（ID は出ない）
    const f = a.world.floors[a.key];
    f.event = { id: 'core:event_deep_sleep', handler: 'deep_sleep', arrival: { ja: 'この階は静まり返っている', en: 'This floor lies utterly still' } };
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const o = a.r.port.observe({ map: false });
    expect(o.observation.self.floor?.event_text).toBe('この階は静まり返っている');
    expect(o.text).toContain('この階は静まり返っている');
    expect(JSON.stringify(o.observation)).not.toContain('core:event_');
    a.manager.closeAll();
  });

  it('deep sleep: when one sleeper wakes, every sleeper on the floor wakes', async () => {
    const a = await arena('v35d-sleep', { map: ['PG........', '..........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, acc: 99 } });
    const f = a.world.floors[a.key];
    f.event = { id: 'core:event_deep_sleep', handler: 'deep_sleep', arrival: { ja: 'この階は静まり返っている', en: 'still' } };
    const g = structuredClone(a.world.entities[a.gId]); delete g.role; delete g.guardian; delete g.home; g.stats!.sight = 0; g.base!.sight = 0;
    a.inject({ put: [g, goblin(a, 'e_ds0001', a.ox + 8, a.oy + 1, { asleep: true, sight: 0 }), goblin(a, 'e_ds0002', a.ox + 9, a.oy, { asleep: true, sight: 0 })] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    for (const id of ['e_ds0001', 'e_ds0002']) expect(a.world.entities[id].actor!.dormant).toBe(true);
    expect((await a.r.port.act({ type: 'attack', target: a.gId }, { source: 'bot' })).ok).toBe(true);
    for (const id of ['e_ds0001', 'e_ds0002']) expect(a.world.entities[id].actor!.dormant ?? false).toBe(false);
    a.manager.closeAll();
  });

  it('a patroller walks its route while it has not seen you', async () => {
    const a = await arena('v35d-patrol', { map: ['P.........', '..........', '..........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const pm = goblin(a, 'e_pt0001', a.ox + 9, a.oy + 2, { sight: 1 });
    pm.actor!.ai = { ...pm.actor!.ai!, archetype: 'patrol', route: [{ x: a.ox + 9, y: a.oy + 2 }, { x: a.ox + 5, y: a.oy + 2 }], routeIdx: 1 };
    a.inject({ put: [pm] });
    for (let k = 0; k < 4; k++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(a.world.entities.e_pt0001.pos!.x).toBeLessThan(a.ox + 9);
    a.manager.closeAll();
  });
});

describe('V3-5 named elites (§5.4)', () => {
  it('a few ordinary monsters become named elites with affixes and a bounty; they show as elites', async () => {
    const a = await arena('v35d-elite', { map: ['P...G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    const tt = a.world.meta.terrainTable;
    let n = 0, elites = 0;
    for (let s = 0; s < 60; s++) {
      const g = generateFloor(content, `v35d-el-${s}`, 'main', 4, tt);
      for (const sp of g.spawns) {
        if (sp.type !== 'monster' || sp.guardian) continue;
        n++;
        if (!sp.elite) continue;
        elites++;
        expect(sp.affixes.length).toBe(content.balance.elite.affixes);
        expect(sp.bounty).toBe(content.balance.elite.bountyBase + content.balance.elite.bountyPerDepth * 4);
      }
    }
    expect(elites).toBeGreaterThan(0);
    expect(elites * 100).toBeLessThan(n * 10);
    const e = structuredClone(a.world.entities[a.gId]); delete e.guardian; delete e.home;
    e.role = 'elite'; e.named = { ja: 'ガロ', en: 'Garo' }; e.bounty = 300;
    a.inject({ put: [e] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(a.r.port.observe({ map: false }).text).toContain('強敵「ガロ」・賞金 300');
    a.manager.closeAll();
  });
});

describe('V3-5 clues and first sights (§5.4)', () => {
  const unidentified = (a: A, kind: string): Entity => ({ id: `e_u${(++sid).toString(36).padStart(5, '0')}`, kind, sid: ++sid, item: { qty: 1, affixes: [], heldBy: a.meId, slot: 'y' } } as Entity);

  it('carrying an unidentified potion for 30 turns reveals its clue; a scout notices at once', async () => {
    for (const cls of ['core:warrior', 'core:scout']) {
      const a = await arena(`v35d-clue-${cls}`, { classId: cls, map: ['P...G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
      const k = a.world.players[a.pid].knowledge;
      k.identified = k.identified.filter((x) => x !== 'core:potion_haste');
      const me = structuredClone(a.world.entities[a.meId]);
      const it = unidentified(a, 'core:potion_haste');
      me.inv!.items.push(it.id);
      a.inject({ put: [me, it] });
      const app = a.world.secret.appearances['core:potion_haste'];
      await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      if (cls === 'core:scout') {
        expect(k.clues?.[app]?.ja).toContain('刺すような匂い');
      } else {
        expect(k.clues?.[app]).toBeUndefined();
        expect(k.clueSince?.[app]).toBeDefined();
        await a.r.port.act({ type: 'wait', turns: 31 } as never, { source: 'bot' });
        for (let i = 0; i < 31 && !k.clues?.[app]; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
        expect(k.clues?.[app]?.ja).toContain('刺すような匂い');
      }
      const inv = buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
      expect(JSON.stringify(inv)).toContain('刺すような匂い');
      expect(a.r.port.inventory().text).toContain('手がかり: 刺すような匂い');
      a.manager.closeAll();
    }
  });

  it('the first sight of a species gives its description once in changes', async () => {
    const a = await arena('v35d-first', { map: ['P.....', '......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    a.inject({ put: [goblin(a, 'e_og0001', a.ox + 5, a.oy + 1, { asleep: true, kind: 'core:ogre' })] });
    const r = await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const changes = (r.ok ? r.turn.changes : []).filter((c) => c.code === 'first_seen');
    expect(changes.some((c) => c.text.includes('大鬼') && c.text.includes('構えを見たら'))).toBe(true);
    const r2 = await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect((r2.ok ? r2.turn.changes : []).some((c) => c.code === 'first_seen' && c.text.includes('大鬼'))).toBe(false);
    a.manager.closeAll();
    void since; void ({} as GameEvent);
  });
});

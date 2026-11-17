// V3-5（IMPROVEMENTS_V3 §5.1）の確認: 特殊部屋。施錠された宝物庫と鍵（鍵を持つ敵・格子扉・鍵は無くなる）、碑文（断章と手がかり）、
// 書き置き、賭けの祭壇（表から 1 つ・1 回だけ・表は look で読める）、部屋を見つけると発見の点。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { Entity, GameEvent } from '@muse/shared';
import { buildObservation, describeTarget, macroNext, macroStart, projectPlayerView } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 995000;
type A = Awaited<ReturnType<typeof arena>>;
const since = (a: A, n: number) => a.r.session.history.slice(n);
const item = (a: A, kind: string): Entity => {
  const id = `e_k${(++sid).toString(36).padStart(5, '0')}`;
  return { id, kind, sid: ++sid, item: { qty: 1, affixes: [], heldBy: a.meId, slot: 'z' } } as Entity;
};
const feature = (a: A, kind: string, x: number, y: number, state: string): Entity => ({ id: `e_f${(++sid).toString(36).padStart(5, '0')}`, kind, sid: ++sid, pos: { floor: a.key, x, y }, feature: { state } } as Entity);
const setTerrain = (a: A, x: number, y: number, id: string) => { const f = a.world.floors[a.key]; f.terrain[y * f.width + x] = a.world.meta.terrainTable.indexOf(id); };

describe('V3-5 special rooms (§5.1): the locked vault', () => {
  it('a generated locked vault has a locked grate and its key goes to a monster on the floor (or lies on the floor)', async () => {
    const a = await arena('v35c-gen', { map: ['P.G'], guardian: { kind: 'core:goblin', hp: 5, dmg: '1d1', types: [], state: 'asleep' } });
    const tt = a.world.meta.terrainTable;
    let vaults = 0;
    for (let s = 0; s < 80 && vaults < 3; s++) {
      for (const d of [3, 5, 7]) {
        const g = generateFloor(content, `v35c-vault-${s}`, 'main', d, tt);
        const v = g.floor.regions.filter((r) => r.tags.includes('vault_locked'));
        if (!v.length) continue;
        vaults++;
        expect(g.floor.terrain.some((t) => tt[t] === 'core:grate_locked')).toBe(true);
        const carriers = g.spawns.filter((sp) => sp.type === 'monster' && sp.carries === 'core:vault_key').length;
        const loose = g.spawns.filter((sp) => sp.type === 'item' && sp.kind === 'core:vault_key').length;
        expect(carriers + loose).toBe(v.length);
      }
    }
    expect(vaults).toBeGreaterThan(0);
    a.manager.closeAll();
  });

  it('the grate needs the key; with it, the grate opens and the key is used up; the carrier drops the key', async () => {
    const a = await arena('v35c-grate', { map: ['P.G..', '.....'], guardian: { kind: 'core:goblin', hp: 1, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 100, acc: 99 } });
    // 守護者を、鍵を持つ普通の敵にする
    const g = structuredClone(a.world.entities[a.gId]); delete g.role; delete g.guardian; delete g.home; g.carries = 'core:vault_key';
    a.inject({ put: [g] });
    setTerrain(a, a.ox, a.oy + 1, 'core:grate_locked');
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 鍵を持つ敵は見れば分かる
    const o = a.r.port.observe({ map: false });
    expect(o.observation.visible.monsters.find((m) => m.id === a.gId)?.carries).toBe('core:vault_key');
    expect(o.text).toContain('宝物庫の鍵を持っている');
    // 鍵が無いと開かない
    const no = await a.r.port.act({ type: 'interact', dir: 's' }, { source: 'bot' });
    expect(!no.ok && no.error.code).toBe('cannot_use');
    expect(o.observation.valid_actions.some((x) => x.startsWith('interact s') && x.includes('鍵が要る'))).toBe(true);
    // 倒すと鍵を落とす
    await a.r.port.act({ type: 'fight', target: a.gId, hpFloor: 0 }, { source: 'bot' });
    expect(a.world.entities[a.gId]).toBeUndefined();
    const key = Object.values(a.world.entities).find((e) => e.kind === 'core:vault_key' && e.pos?.floor === a.key);
    expect(key).toBeTruthy();
    // 鍵を持って格子扉を開ける（鍵は無くなる）
    const me = structuredClone(a.world.entities[a.meId]);
    const k = item(a, 'core:vault_key');
    me.inv!.items.push(k.id);
    a.inject({ put: [me, k] });
    const n = a.r.session.history.length;
    const yes = await a.r.port.act({ type: 'interact', dir: 's' }, { source: 'bot' });
    expect(yes.ok).toBe(true);
    const f = a.world.floors[a.key];
    expect(a.world.meta.terrainTable[f.terrain[(a.oy + 1) * f.width + a.ox]]).toBe('core:grate_open');
    expect(a.world.entities[k.id]).toBeUndefined();
    expect(since(a, n).some((e) => e.type === 'tile_changed' && (e as { reason?: string }).reason === 'unlock')).toBe(true);
    a.manager.closeAll();
  });
});

describe('V3-5 special rooms (§5.1): inscriptions, notes, the altar of chance', () => {
  it('an inscription gives a fragment and a clue (a guardian weakness first), once; a note gives only the fragment', async () => {
    const a = await arena('v35c-insc', { map: ['P.....G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep', weakness: 'core:weak_poison' }, player: { hp: 100 } });
    const ins = feature(a, 'core:inscription', a.ox + 1, a.oy, 'unread');
    a.inject({ put: [ins] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const n = a.r.session.history.length;
    const r = await a.r.port.act({ type: 'interact', dir: 'e' }, { source: 'bot' });
    expect(r.ok).toBe(true);
    const ev = since(a, n);
    const read = ev.find((e) => e.type === 'inscription_read') as unknown as { clue: string; lore: unknown } | undefined;
    expect(read?.clue).toBe('weakness');
    expect(read?.lore).toBeTruthy();
    expect(ev.some((e) => e.type === 'guardian_intel' && (e as { weakness?: string }).weakness === 'core:weak_poison')).toBe(true);
    expect(a.world.players[a.pid].knowledge.guardianIntel?.[a.gId]).toBe('core:weak_poison');
    // 2 回目は読めない
    const again = await a.r.port.act({ type: 'interact', dir: 'e' }, { source: 'bot' });
    expect(again.ok).toBe(false);
    // 書き置き: 断章だけ
    const note = feature(a, 'core:old_note', a.ox, a.oy, 'unread');
    a.inject({ put: [note] });
    const n2 = a.r.session.history.length;
    expect((await a.r.port.act({ type: 'interact' }, { source: 'bot' })).ok).toBe(true);
    const nr = since(a, n2).find((e) => e.type === 'inscription_read') as unknown as { clue: string; note: boolean } | undefined;
    expect(nr?.note).toBe(true);
    expect(nr?.clue).toBe('none');
    a.manager.closeAll();
  });

  it('the altar of chance rolls one outcome from its public table, once; look shows the table', async () => {
    const a = await arena('v35c-altar', { map: ['P....', '.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + 4, y: a.oy + 1 };
    const alt = feature(a, 'core:gamble_altar', a.ox + 1, a.oy, 'idle');
    a.inject({ put: [g, alt] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const view = projectPlayerView(a.world, a.pid);
    const look = describeTarget(view, catalog, { x: a.ox + 1, y: a.oy });
    expect(look.text).toContain('表: 最大 HP +3 20%');
    const va = buildObservation(view, catalog, { detail: 'brief', map: false }).valid_actions;
    expect(va.some((x) => x.startsWith('interact e') && x.includes('賭けの祭壇'))).toBe(true);
    const n = a.r.session.history.length;
    expect((await a.r.port.act({ type: 'interact', dir: 'e' }, { source: 'bot' })).ok).toBe(true);
    const rolled = since(a, n).find((e) => e.type === 'gamble_rolled') as unknown as { pct: number } | undefined;
    expect(rolled?.pct).toBeGreaterThan(0);
    expect((await a.r.port.act({ type: 'interact', dir: 'e' }, { source: 'bot' })).ok).toBe(false);
    a.manager.closeAll();
  });

  it('the curse and good-affix outcomes change one item; summon calls monsters next to you', async () => {
    const def = content.features['core:gamble_altar'];
    const saved = def.gamble;
    try {
      for (const [eff, check] of [['curse_item', 'cursed'], ['affix_item', 'good'], ['summon', 'summon']] as const) {
        def.gamble = [{ weight: 1, name: { ja: eff, en: eff }, effects: [eff === 'summon' ? { effect: 'summon', count: 2 } : { effect: eff }] }];
        const a = await arena(`v35c-eff-${eff}`, { map: ['P....', '.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
        const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + 4, y: a.oy + 1 };
        a.inject({ put: [g, feature(a, 'core:gamble_altar', a.ox + 1, a.oy, 'idle')] });
        await a.r.port.act({ type: 'wait' }, { source: 'bot' });
        const n = a.r.session.history.length;
        const before = Object.values(a.world.entities).filter((e) => e.actor && !e.player).length;
        expect((await a.r.port.act({ type: 'interact', dir: 'e' }, { source: 'bot' })).ok).toBe(true);
        const ev = since(a, n) as unknown as (GameEvent & { cursed?: boolean })[];
        if (check === 'summon') expect(Object.values(a.world.entities).filter((e) => e.actor && !e.player).length - before).toBeGreaterThan(0);
        else expect(ev.some((e) => e.type === 'item_altered' && e.cursed === (check === 'cursed'))).toBe(true);
        a.manager.closeAll();
      }
    } finally { def.gamble = saved; }
  });
});

describe('V3-5 special rooms (§5.1): finding a room', () => {
  it('seeing inside a special room for the first time gives discovery points once', async () => {
    const a = await arena('v35c-room', { map: ['P....', '.....', '.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const f = a.world.floors[a.key];
    f.regions.push({ id: 999, kind: 'prefab', x: a.ox + 2, y: a.oy, w: 3, h: 3, tags: ['core:inscription_hall', 'shrine', 'room'] });
    const x0 = a.world.expeditions?.[a.world.expeditions.length - 1];
    const disc0 = x0?.haul?.discovery ?? 0;
    const n = a.r.session.history.length;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const found = since(a, n).filter((e) => e.type === 'room_found');
    expect(found.length).toBe(1);
    expect(f.regions.find((r) => r.id === 999)?.found).toBe(true);
    const x1 = a.world.expeditions![a.world.expeditions!.length - 1];
    expect((x1.haul?.discovery ?? 0) - disc0).toBe(content.balance.haul.discovery.room);
    a.manager.closeAll();
  });
});

describe('V3-5c travel stops when it makes no progress', () => {
  it('travel stops with no_progress when the way to the goal does not get shorter for 20 steps', async () => {
    const a = await arena('v35c-np', { map: ['P..........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + 10, y: a.oy };
    a.inject({ put: [g] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'travel', to: { x: a.ox + 8, y: a.oy }, mode: 'steady' }, catalog);
    // 動かないまま（道のりが縮まない）呼び続ける
    let d = macroNext(st, v, catalog, []);
    let k = 0;
    for (; k < 30 && !('stop' in d); k++) d = macroNext(st, v, catalog, []);
    expect(d).toEqual({ stop: 'no_progress' });
    expect(k).toBeGreaterThanOrEqual(19);
    a.manager.closeAll();
  });
});

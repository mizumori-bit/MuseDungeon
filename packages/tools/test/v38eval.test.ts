// V3-8 の確認の評価（IMPROVEMENTS_V3 §55）で見つかった不具合の確認: 見つけた部屋の方角と歩数、
// 呪いの判定の文は接辞付きの名前、静寂の指輪の短い説明。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { itemStatsText, narrate } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);

describe('V3-8 confirmation evaluation fixes', () => {
  it('a found room says where the corner you saw is (its feature may not be in view yet)', async () => {
    const a = await arena('v38eval-room', { map: ['P.......', '........', '........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const f = a.world.floors[a.key];
    f.regions.push({ id: 998, kind: 'prefab', x: a.ox + 5, y: a.oy, w: 3, h: 3, tags: ['core:gamble_shrine', 'shrine', 'room'] });
    const n = a.r.session.history.length;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const found = a.r.session.history.slice(n).find((e) => e.type === 'room_found') as unknown as { at?: { x: number; y: number } } | undefined;
    expect(found?.at).toEqual({ x: a.ox + 5, y: a.oy });
    const me = a.world.entities[a.meId].pos!;
    const text = narrate(found as never, { locale: 'ja', catalog, selfId: a.meId, selfPlayerId: a.pid, playerNames: {}, selfPos: { x: me.x, y: me.y } });
    expect(text).toBe('「賭けの祭壇」を見つけた（発見。東・5 マス先に部屋の一角が見えた）。');
    // 位置が分からない古い出来事は今までどおり
    expect(narrate({ ...(found as object), at: undefined } as never, { locale: 'ja', catalog, selfId: a.meId, selfPlayerId: a.pid, playerNames: {} })).toBe('「賭けの祭壇」を見つけた（発見）。');
    a.manager.closeAll();
  });

  it('"not cursed" names the item with its affixes', async () => {
    const a = await arena('v38eval-inspect', { map: ['P.G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, items: [{ kind: 'core:leather_armor' }] } });
    const id = a.world.entities[a.meId].inv!.items.filter((x) => a.world.entities[x]?.kind === 'core:leather_armor').at(-1)!;
    const it = structuredClone(a.world.entities[id]);
    it.item!.affixes = ['core:reinforced'];
    it.item!.inspected = false;
    a.inject({ put: [it] });
    const n = a.r.session.history.length;
    expect((await a.r.port.act({ type: 'equip', slot: it.item!.slot! }, { source: 'bot' })).ok).toBe(true);
    const ev = a.r.session.history.slice(n).find((e) => e.type === 'item_inspected');
    expect(ev).toBeTruthy();
    expect(narrate(ev as never, { locale: 'ja', catalog, selfId: a.meId, selfPlayerId: a.pid, playerNames: {} })).toBe('補強された革鎧に呪いは無い。');
    a.manager.closeAll();
  });

  it('the ring of silence says that your own noise wakes sleeping enemies', () => {
    const s = itemStatsText('ja', { mods: { stealthPct: 30, noiseWakes: true } } as never, catalog);
    expect(s).toContain('自分の立てた音（攻撃・扉・投擲）で、眠っている敵が必ず起きる');
    expect(s).not.toContain('眠りが必ず覚める');
  });
});

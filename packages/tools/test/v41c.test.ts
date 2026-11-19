// V4-1c（IMPROVEMENTS_V4 §16）の確認: 観測の self.recovery（回復の手段）。効果の定義から決め、未鑑定の品は入れない。
// 能動技の ready は今の表示（abilities の「使える」）と一致する。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Entity, GameEvent } from '@muse/shared';
import { applyEvent, projectPlayerView } from '@muse/shared';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 997700;

async function newRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: 'auto' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  /** 所持品に品を足す（スロット q） */
  const give = (kind: string, qty = 1) => {
    const id = `e_q${(++sid).toString(36).padStart(5, '0')}`;
    const m = structuredClone(me());
    m.inv!.items.push(id);
    inject({ put: [m, { id, kind, sid: ++sid, item: { qty, affixes: [], heldBy: meId, slot: 'q' } } as Entity] });
    return id;
  };
  const obs = () => r.port.observe({ map: false }).observation;
  return { manager, r, world, pid, meId, inject, me, give, obs };
}

describe('V4-1c self.recovery (§16.2)', () => {
  it('an unidentified healing item is not listed; once identified it is, with the readable amount; items are chosen by their effect', async () => {
    const t = await newRun('v41c-item');
    const k = t.world.players[t.pid].knowledge;
    // 回復の薬の正体を知らないことにする（最初の所持品の薬も伏せられる）
    k.identified = k.identified.filter((x) => x !== 'core:potion_healing');
    t.give('core:potion_healing', 2);
    const o1 = t.obs();
    expect(o1.self.recovery.filter((r) => r.kind === 'item')).toEqual([]);
    expect(JSON.stringify(o1.self.recovery)).not.toContain('potion_healing');
    // 鑑定した: 入る（説明の文は効果の定義から）
    k.identified = [...k.identified, 'core:potion_healing'];
    const o2 = t.obs();
    const items = o2.self.recovery.filter((r) => r.kind === 'item');
    const q = items.find((r) => r.kind === 'item' && r.slot === 'q');
    expect(q).toMatchObject({ kind: 'item', slot: 'q', name: content.items['core:potion_healing'].name.ja, qty: 2, amount: '2d8+4（最大 HP の 30% を下回らない）' });
    // 効果の定義（onUse の heal）から決める: 回復しない品は入らない。回復する別の品（活力の薬）は入る
    for (const r of items) if (r.kind === 'item') {
      const it = projectPlayerView(t.world, t.pid).inventory.find((i) => i.slot === r.slot)!;
      expect(catalog.items[it.kind!]?.heal).toBeTruthy();
    }
    const healKinds = Object.entries(catalog.items).filter(([, v]) => v.heal).map(([id]) => id);
    expect(healKinds).toContain('core:potion_healing');
    expect(healKinds.length).toBeGreaterThan(1);
    expect(Object.entries(content.items).filter(([, v]) => v.onUse.some((e) => e.effect === 'heal')).map(([id]) => id).sort()).toEqual([...healKinds].sort());
    t.manager.closeAll();
  });

  it("a healing ability is listed; its ready matches the abilities list ('ready' = cooldown 0 and uses left), and turns false after use", async () => {
    const t = await newRun('v41c-ability');
    // 立て直しを覚えている
    const m = structuredClone(t.me());
    m.build!.abilities = [...m.build!.abilities.filter((a) => a.id !== 'core:second_wind'), { id: 'core:second_wind', readyAt: 0 }];
    m.stats!.hp = Math.floor(m.stats!.maxHp / 2);
    t.inject({ put: [m] });
    const o1 = t.obs();
    const ab = o1.self.recovery.find((r) => r.kind === 'ability');
    const shown = o1.self.abilities.find((a) => a.id === 'second_wind')!;
    expect(ab).toMatchObject({ kind: 'ability', id: 'second_wind', ready: true, amount: '最大 HP の 25%' });
    expect(ab?.kind === 'ability' && ab.ready).toBe(shown.cooldown_left === 0 && shown.uses_left !== 0);
    // 回復しない能動技（強打）は入らない
    expect(o1.self.recovery.some((r) => r.kind === 'ability' && r.id === 'bash')).toBe(false);
    // 使った: 遠征ごとの回数を使い切ったので ready でない（abilities の表示と同じ）
    expect((await t.r.port.act({ type: 'ability', id: 'core:second_wind' }, { source: 'bot' })).ok).toBe(true);
    const o2 = t.obs();
    const ab2 = o2.self.recovery.find((r) => r.kind === 'ability');
    const shown2 = o2.self.abilities.find((a) => a.id === 'second_wind')!;
    expect(ab2?.kind === 'ability' && ab2.ready).toBe(false);
    expect(shown2.uses_left).toBe(0);
    t.manager.closeAll();
  });

  it('no means of recovery gives an empty list; the engine version is raised', async () => {
    const t = await newRun('v41c-empty');
    const m = structuredClone(t.me());
    const potions = m.inv!.items.filter((id) => catalog.items[t.world.entities[id]?.kind ?? '']?.heal);
    m.inv!.items = m.inv!.items.filter((id) => !potions.includes(id));
    m.build!.abilities = m.build!.abilities.filter((a) => !catalog.abilities[a.id]?.heal);
    t.inject({ put: [m], del: potions });
    expect(t.obs().self.recovery).toEqual([]);
    expect(ENGINE_VERSION >= '0.31.0').toBe(true);
    t.manager.closeAll();
  });
});

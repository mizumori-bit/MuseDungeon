// V3-3 の 2 段目（IMPROVEMENTS_V3 §3.3・§28.9）の完了の定義: 持ち帰った遺物の加護が次の遠征で効く。
// 遺物は候補の時点で名前と加護を出し、まだ持っていない加護から引く。階段の上で持ち帰ると加護になり、綱では付かない。
// 加護の効き目（息吹・狩人・灯・鎮め・鋼・俊足・執念）と、観測の self.boons・候補とブリーフィングの文・拾う前の注記。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { applyEvent, boonHookSum, formatObservationText, projectPlayerView, regenInterval } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 970000;

async function newRun(seed: string, opts: { classId?: string; objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic' } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: opts.classId ?? 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: opts.objective ?? 'auto' });
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
  /** 遠征の目標階まで降り、遺物を拾って階段の上で持ち帰る（lifeline なら綱で戻る） */
  const fetchRelic = async (how: 'stairs' | 'lifeline' = 'stairs') => {
    const x = world.expeditions![world.expeditions!.length - 1];
    while (world.floors[me().pos!.floor].depth < x.objective.targetDepth!) expect((await descend()).ok).toBe(true);
    const relic = Object.values(world.entities).find((e) => e.role === 'relic' && e.pos?.floor === me().pos!.floor)!;
    expect(relic).toBeTruthy();
    place(relic.pos!.x, relic.pos!.y);
    clearMonsters();
    await act({ type: 'wait' });
    const vaText = obs().valid_actions.join('\n');
    expect((await act({ type: 'pickup', item: relic.id })).ok).toBe(true);
    clearMonsters();
    if (how === 'lifeline') {
      const slot = view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
      expect((await act({ type: 'use', slot })).ok).toBe(true);
    } else {
      const f = world.floors[me().pos!.floor];
      place(f.stairs.down[0].x, f.stairs.down[0].y);
      clearMonsters();
      await act({ type: 'wait' });
      expect((await act({ type: 'extract' })).ok).toBe(true);
    }
    return { relic, vaText };
  };
  /** 加護を直接付ける（効き目の試験用） */
  const giveBoon = (id: string) => edit((e) => { e.boons = [...(e.boons ?? []), id]; });
  /** 所持品に品を足す */
  const give = (kind: string, qty = 1): string => {
    const used = new Set((me().inv!.items).map((id) => world.entities[id]?.item?.slot));
    let slot = 'a';
    for (let c = 97; c <= 122; c++) if (!used.has(String.fromCharCode(c))) { slot = String.fromCharCode(c); break; }
    const id = `e_r${(++sid).toString(36).padStart(5, '0')}`;
    const body = structuredClone(me());
    body.inv!.items.push(id);
    inject({ put: [{ id, kind, sid: ++sid, item: { qty, affixes: [], heldBy: meId, slot, inspected: true } }, body] });
    world.players[pid].knowledge.identified = [...new Set([...world.players[pid].knowledge.identified, kind])];
    return slot;
  };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, obs, view, descend, fetchRelic, giveBoon, give };
}

let msid = 960000;
function monster(id: string, floor: string, x: number, y: number, o: { hp?: number; dmg?: string; acc?: number; asleep?: boolean } = {}): Entity {
  msid++;
  const hp = o.hp ?? 30;
  return {
    id, kind: 'core:goblin', sid: msid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.asleep ? 'asleep' : 'hunting', targetPos: null, lostTurns: 0, params: {} }, ...(o.asleep ? { dormant: true } : {}) },
    stats: { hp, maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d2' },
    base: { maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d2' },
    statuses: [],
  };
}

/** 自分の隣で、床のマス（敵を置ける） */
function openNeighbor(t: Awaited<ReturnType<typeof newRun>>): { x: number; y: number } {
  const p = t.me().pos!;
  const f = t.world.floors[p.floor];
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
    const x = p.x + dx, y = p.y + dy;
    const tt = content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[y * f.width + x]]]];
    if (tt?.passable && !tt.stairs && !Object.values(t.world.entities).some((e) => e.pos?.floor === p.floor && e.pos.x === x && e.pos.y === y)) return { x, y };
  }
  throw new Error('no open neighbor');
}

describe('V3-3 relics in offers (§3.3)', () => {
  it('retrieve_relic offers name the relic and its boon; other offers have none; the same seed gives the same relic', async () => {
    let seen = 0;
    // キャンプの候補（objective を選ばない run はキャンプから始まる）
    for (let i = 0; i < 12; i++) {
      const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
      const r = await manager.createRun({ name: 'R', seed: `v33r-camp-${i}`, controller: { kind: 'agent', label: 't' } });
      const r2 = await manager.createRun({ name: 'R', seed: `v33r-camp-${i}`, controller: { kind: 'agent', label: 't' } });
      if ('error' in r || 'error' in r2) throw new Error('createRun');
      for (const o of r.session.world.camp!.offers) {
        if (o.objective.type !== 'retrieve_relic') { expect(o.relic).toBeUndefined(); continue; }
        expect(o.relic).toBeTruthy();
        const it = content.items[o.relic!.kind];
        expect(it.category).toBe('relic');
        expect(o.relic!.boon).toBe(it.boon);
        expect(o.relic!.boonName).toEqual(content.boons[it.boon!].name);
        const text = r.port.observe({ map: false }).observation.camp!.offers.find((x) => x.index === o.index)!.text;
        expect(text).toContain(`遺物「${it.name.ja}」→ 加護「${content.boons[it.boon!].name.ja}」`);
        seen++;
      }
      expect(JSON.stringify(r2.session.world.camp!.offers)).toBe(JSON.stringify(r.session.world.camp!.offers));
      manager.closeAll();
    }
    expect(seen).toBeGreaterThan(3);
  });

  it('the relic placed on the target floor is the offered one; the briefing names it; pickup warns that the floor wakes', async () => {
    const t = await newRun('v33r-place-1', { objective: 'retrieve_relic' });
    const x = t.world.expeditions![0];
    expect(x.relic?.kind).toBeTruthy();
    expect(t.r.port.briefing('start').join('\n')).toContain(`遺物「${content.items[x.relic!.kind].name.ja}」`);
    const { relic, vaText } = await t.fetchRelic();
    expect(relic.kind).toBe(x.relic!.kind);
    expect(vaText).toContain('遺物を拾うと階が目覚める');
    t.manager.closeAll();
  });
});

describe('V3-3 boons from relics (§3.3, §11)', () => {
  it('a relic carried out on stairs becomes its boon, which works on the next expedition; the next offers skip boons you have', async () => {
    let checked = 0;
    for (let i = 0; i < 10 && checked < 3; i++) {
      const t = await newRun(`v33r-boon-${i}`, { objective: 'retrieve_relic' });
      const x = t.world.expeditions![0];
      const boon = content.items[x.relic!.kind].boon!;
      const base0 = structuredClone(t.me().base!);
      await t.fetchRelic();
      expect(t.view().status).toBe('at_camp');
      expect(t.me().boons).toEqual([boon]);
      expect(t.r.session.history.some((e) => e.type === 'boon_granted' && (e as { boon?: string }).boon === boon)).toBe(true);
      // 遺物は納めて所持品から消える
      expect(t.view().inventory.some((it) => content.items[it.kind ?? '']?.category === 'relic')).toBe(false);
      // 素の能力値の修正（灯・鋼）
      const m = content.boons[boon].mods;
      expect(t.me().base!.armor).toBe(base0.armor + m.armor);
      expect(t.me().base!.sight).toBe(base0.sight + m.sight);
      // キャンプの文と観測に加護が出る
      const o = t.obs();
      expect(o.self.boons.map((b) => b.id)).toEqual([boon]);
      expect(formatObservationText(o, 'ja')).toContain(`加護: ${content.boons[boon].name.ja}`);
      // 次の候補の遺物は、持っている加護を避ける
      for (const of of t.world.camp!.offers) if (of.relic) expect(of.relic.boon).not.toBe(boon);
      // 能力値に効いている（キャンプには条件が無いので、視界は素の値そのもの）
      if (m.sight) expect(t.me().stats!.sight).toBe(t.me().base!.sight);
      // 次の遠征でも残っている
      expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
      expect(t.me().boons).toEqual([boon]);
      t.manager.closeAll();
      checked++;
    }
    expect(checked).toBe(3);
  });

  it('a relic brought back by lifeline gives no boon', async () => {
    const t = await newRun('v33r-life-1', { objective: 'retrieve_relic' });
    await t.fetchRelic('lifeline');
    expect(t.view().status).toBe('at_camp');
    expect(t.me().boons ?? []).toEqual([]);
    expect(t.r.session.history.some((e) => e.type === 'boon_granted')).toBe(false);
    t.manager.closeAll();
  });

  it('when every boon is owned, the relic is drawn from all and marked owned', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await manager.createRun({ name: 'R', seed: 'v33r-owned-1', controller: { kind: 'agent', label: 't' }, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const { pickRelic } = await import('@muse/engine');
    const all = new Set(content.lists.relics.map((it) => it.boon!));
    const ri = pickRelic(content, 's', 3, 2, all)!;
    expect(ri.owned).toBe(true);
    const some = new Set([...all].slice(0, all.size - 1));
    const left = [...all].find((b) => !some.has(b));
    for (let k = 0; k < 10; k++) expect(pickRelic(content, `s${k}`, 3, 2, some)!.boon).toBe(left);
    manager.closeAll();
  });
});

describe('V3-3 boon effects (§3.3)', () => {
  it('Breath shortens natural regeneration (engine and the rest estimate use the same interval)', async () => {
    const gains: number[] = [];
    for (const withBoon of [false, true]) {
      const t = await newRun('v33r-breath-1');
      t.clearMonsters();
      if (withBoon) t.giveBoon('core:boon_breath');
      t.edit((e) => { e.stats!.hp = 2; e.actor!.regen = 0; });
      const est = t.obs().self.rest_estimate!;
      const lvl = t.me().level?.level ?? 1;
      expect(regenInterval(catalog.rules, lvl, boonHookSum(catalog.boons, t.me().boons, 'regen', 'interval'))).toBe(regenInterval(catalog.rules, lvl) + (withBoon ? -2 : 0) || 1);
      const r = await t.act({ type: 'rest' });
      expect(r.ok).toBe(true);
      // 中断が無ければ見積もりどおり
      if (r.ok && r.interrupted_by === 'rest_cap') expect(r.steps).toBe(est.turns);
      gains.push(est.turns);
      t.manager.closeAll();
    }
    expect(gains[1]).toBeLessThan(gains[0]);
  });

  it('Hunter brings a thrown item back about half the time when it hits', async () => {
    let returned = 0, hits = 0;
    for (let i = 0; i < 6; i++) {
      const t = await newRun(`v33r-hunter-${i}`, { classId: 'core:scout' });
      t.clearMonsters();
      t.giveBoon('core:boon_hunter');
      const slot = t.give('core:throwing_knife', 10);
      const p = t.me().pos!;
      const n = openNeighbor(t);
      t.inject({ put: [monster(`e_hm${i}`, p.floor, n.x, n.y, { hp: 200 })] });
      t.edit((e) => { e.stats!.acc = 30; });
      for (let k = 0; k < 8; k++) {
        const before = t.view().inventory.find((it) => it.slot === slot)?.qty ?? 0;
        const res = await t.act({ type: 'throw', slot, target: `e_hm${i}` });
        if (!res.ok) break;
        const hit = t.r.session.history.slice(-40).some((e) => e.type === 'item_thrown' && (e as { hit?: string | null }).hit);
        const after = t.view().inventory.find((it) => it.slot === slot)?.qty ?? 0;
        if (hit) hits++;
        if (after === before) returned++;
      }
      t.manager.closeAll();
    }
    expect(hits).toBeGreaterThan(10);
    expect(returned).toBeGreaterThan(hits * 0.25);
    expect(returned).toBeLessThan(hits * 0.75);
  });

  it('Lamp and Steel add sight and armor (carried out for real), and the armor shows in the observation', async () => {
    const want = new Set(['core:boon_lamp', 'core:boon_steel']);
    for (let i = 0; i < 60 && want.size; i++) {
      const t = await newRun(`v33r-stat-${i}`, { objective: 'retrieve_relic' });
      const boon = content.items[t.world.expeditions![0].relic!.kind].boon!;
      if (!want.has(boon)) { t.manager.closeAll(); continue; }
      want.delete(boon);
      const b0 = structuredClone(t.me().base!);
      const armorGap0 = t.me().stats!.armor - b0.armor;
      await t.fetchRelic();
      const me = t.me();
      if (boon === 'core:boon_steel') {
        expect(me.base!.armor).toBe(b0.armor + 1);
        expect(me.stats!.armor - me.base!.armor).toBe(armorGap0);
        expect(t.obs().self.defense.armor).toBe(me.stats!.armor);
      } else {
        expect(me.base!.sight).toBe(b0.sight + 1);
        expect(me.stats!.sight).toBe(me.base!.sight);
      }
      t.manager.closeAll();
    }
    expect([...want]).toEqual([]);
  });

  it('Calm halves how often a sleeping enemy in view wakes to you', async () => {
    // 1 体だけ置く（起きた敵の戦う音で、ほかの敵が起きる連鎖を数えないように）
    const woke: number[] = [];
    for (const withBoon of [false, true]) {
      let n = 0;
      for (let i = 0; i < 40; i++) {
        const t = await newRun(`v33r-calm-${i}`);
        t.clearMonsters();
        if (withBoon) t.giveBoon('core:boon_calm');
        const n1 = openNeighbor(t);
        const p = t.me().pos!;
        t.inject({ put: [monster(`e_cm${i}`, p.floor, n1.x, n1.y, { asleep: true })] });
        for (let k = 0; k < 5; k++) await t.act({ type: 'wait' });
        if (t.world.entities[`e_cm${i}`]?.actor?.ai?.state !== 'asleep') n++;
        t.manager.closeAll();
      }
      woke.push(n);
    }
    expect(woke[0]).toBeGreaterThan(12);
    expect(woke[1]).toBeLessThan(woke[0] * 0.8);
  });

  it('Swiftness hastes you for 10 turns after the stairs', async () => {
    const t = await newRun('v33r-swift-1');
    t.giveBoon('core:boon_swift');
    expect((await t.descend()).ok).toBe(true);
    const haste = t.me().statuses?.find((s) => s.id === 'core:haste');
    expect(haste).toBeTruthy();
    expect(haste!.turnsLeft).toBeGreaterThanOrEqual(9);
    expect(t.r.session.history.some((e) => e.type === 'boon_triggered' && (e as { effect?: string }).effect === 'haste')).toBe(true);
    t.manager.closeAll();
  });

  it('Tenacity survives one lethal blow per expedition with 1 HP, and works again on the next expedition', async () => {
    const t = await newRun('v33r-will-1', { objective: 'reach_depth' });
    t.clearMonsters();
    t.giveBoon('core:boon_will');
    const p = t.me().pos!;
    const n = openNeighbor(t);
    t.edit((e) => { e.stats!.hp = 5; e.stats!.eva = -50; });
    t.inject({ put: [monster('e_wm1', p.floor, n.x, n.y, { hp: 200, dmg: '20d1', acc: 40 })] });
    await t.act({ type: 'wait' });
    expect(t.me().stats!.hp).toBe(1);
    expect(t.view().status).not.toBe('dead');
    expect(t.r.session.history.some((e) => e.type === 'boon_triggered' && (e as { effect?: string }).effect === 'last_stand')).toBe(true);
    expect(t.obs().self.boons.find((b) => b.id === 'core:boon_will')?.used).toBe(true);
    // 次の遠征では、また 1 回だけ耐える（撤退してキャンプへ戻り、次の遠征を始める）
    t.inject({ del: ['e_wm1'] });
    const f = t.world.floors[t.me().pos!.floor];
    t.place(f.stairs.down[0].x, f.stairs.down[0].y);
    await t.act({ type: 'wait' });
    expect((await t.act({ type: 'extract', confirm: true })).ok).toBe(true);
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(t.obs().self.boons.find((b) => b.id === 'core:boon_will')?.used).toBeUndefined();
    t.clearMonsters();
    const p2 = t.me().pos!;
    const n2 = openNeighbor(t);
    t.edit((e) => { e.stats!.hp = 5; e.stats!.eva = -50; });
    const m2 = monster('e_wm2', p2.floor, n2.x, n2.y, { hp: 200, dmg: '20d1', acc: 40 });
    m2.actor!.nextActAt = t.world.floors[p2.floor].time;
    t.inject({ put: [m2] });
    await t.act({ type: 'wait' });
    expect(t.me().stats!.hp).toBe(1);
    // 同じ遠征の 2 度目は耐えない
    t.edit((e) => { e.stats!.hp = 5; });
    await t.act({ type: 'wait' });
    expect(t.world.players[t.pid].state).toBe('dead');
    t.manager.closeAll();
  });
});

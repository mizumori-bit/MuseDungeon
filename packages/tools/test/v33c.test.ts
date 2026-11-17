// V3-3c（IMPROVEMENTS_V3 §44.1〜§44.6）の確認: 目的でなくなった守護者は去る・再挑戦、型が打ち消す弱点は引かない・投擲に弱いは 1.5 倍、
// 大守護者は遅くならない・体力の幅と目安、要る命中の数、鎧さばき・強肩・重い一撃と候補の引き方、目標の行は 1 行、
// fight の with に複数の品・collect_after、座標の投擲は届かなければ拒否、護りの火の持ち主と残りの火の手がかり。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor, guardianTraits, rollGuardianInfo, rollWardenInfo, wardenHpRange, weaknessHandlers } from '@muse/engine';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { applyEvent, guardianForecastText, macroNext, macroStart, milestoneObs, projectPlayerView, xpForLevel } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 990000;

async function newRun(seed: string, opts: { classId?: string; onBoard?: boolean } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: opts.classId ?? 'core:warrior', controller: { kind: 'agent', label: 't' }, ...(opts.onBoard ? { objective: 'reach_depth' as const } : {}) });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  /** 目標の階まで降りる（階段の上へ置いて降りる。守護者以外の敵は消す） */
  const descendTo = async (depth: number) => {
    while (world.floors[me().pos!.floor].depth < depth) {
      const f = world.floors[me().pos!.floor];
      const m = structuredClone(me()); m.pos = { floor: m.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
      inject({ put: [m], del: Object.values(world.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
      await act({ type: 'wait' });
      expect((await act({ type: 'stairs' })).ok).toBe(true);
    }
  };
  const lifeline = async () => {
    const slot = r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    expect((await act({ type: 'use', slot })).ok).toBe(true);
    expect(r.port.view().status).toBe('at_camp');
  };
  return { manager, r, world, pid, meId, inject, me, act, descendTo, lifeline };
}

describe('V3-3c guardians that are no longer the objective (§44.1)', () => {
  it('leave their floor at the next start (with their fires and minions); the ones who met them are told; a slot on that floor becomes a rematch', async () => {
    let departed = 0, rematched = 0;
    for (let s = 0; s < 24 && (departed < 1 || rematched < 1); s++) {
      const t = await newRun(`v33c-depart-${s}`);
      const o = t.world.camp!.offers.find((x) => x.objective.type === 'slay_guardian')!;
      expect((await t.act({ type: 'start_expedition', offer: o.index })).ok).toBe(true);
      const depth = o.objective.targetDepth!;
      await t.descendTo(depth);
      const key = t.me().pos!.floor;
      const g = Object.values(t.world.entities).find((e) => e.pos?.floor === key && e.role === 'guardian' && !e.guardian?.warden)!;
      expect(g).toBeTruthy();
      // 会ったことにして、手下を 1 体付ける
      t.world.players[t.pid].knowledge.met.push(g.id);
      const minion: Entity = { ...structuredClone(g), id: `e_mn${(++sid).toString(36).slice(-4)}`, sid: ++sid, kind: 'core:goblin', minionOf: g.id, pos: { floor: key, x: g.home!.x, y: g.home!.y } } as Entity;
      delete minion.role; delete minion.guardian; delete minion.home;
      t.inject({ put: [minion] });
      const fires = Object.values(t.world.entities).filter((e) => e.lairOf === g.id).map((e) => e.id);
      await t.lifeline();
      const camp = t.world.camp!;
      // 守護者を倒す枠の目標がその階なら、再挑戦（同じ名前・繰り返しの減点なし）
      for (const x of camp.offers) {
        if (x.objective.type === 'slay_guardian' && x.objective.targetDepth === depth) {
          expect(x.rechallenge?.guardian).toBe(g.id);
          expect(x.guardian?.name).toEqual(g.guardian!.name);
          expect(x.repeatNo).toBeUndefined();
        }
      }
      const re = camp.offers.find((x) => x.rechallenge);
      if (re && rematched < 1) {
        const text = t.r.port.observe({ map: false }).text;
        expect(text).toContain('再挑戦');
        expect(text).toContain('この守護者とはまだ戦っていない');
        expect((await t.act({ type: 'start_expedition', offer: re.index })).ok).toBe(true);
        expect(t.world.entities[g.id]).toBeTruthy();
        const x = t.world.expeditions![t.world.expeditions!.length - 1];
        expect(x.targets.guardian).toBe(g.id);
        // 新しい守護者は置かない
        expect(Object.values(t.world.entities).filter((e) => e.pos?.floor === key && e.role === 'guardian').length).toBe(1);
        rematched++;
      } else if (!re && departed < 1) {
        const pick = camp.offers[0];
        const res = await t.act({ type: 'start_expedition', offer: pick.index });
        expect(res.ok).toBe(true);
        expect(t.world.entities[g.id]).toBeUndefined();
        expect(t.world.entities[minion.id]).toBeUndefined();
        for (const id of fires) expect(t.world.entities[id]).toBeUndefined();
        expect(t.r.session.history.some((e) => e.type === 'guardian_departed' && (e as { id?: string }).id === g.id)).toBe(true);
        // 記憶からも火が消える
        expect(t.world.players[t.pid].knowledge.floors[key]?.remembered.some((r) => fires.includes(r.id)) ?? false).toBe(false);
        departed++;
      }
      t.manager.closeAll();
    }
    expect(departed).toBeGreaterThan(0);
    expect(rematched).toBeGreaterThan(0);
  });
});

describe('V3-3c weaknesses and types, wardens (§44.2)', () => {
  it('a type never comes with the weakness it cancels; thrown weakness is 1.5x rounded up', () => {
    for (let s = 0; s < 300; s++) {
      for (const gi of [rollGuardianInfo(content, `v33c-w-${s}`, 2, s % 3, 2), rollWardenInfo(content, `v33c-w-${s}`, 5)]) {
        if (gi.types.includes('core:deflector')) expect(gi.weakness).not.toBe('core:weak_thrown');
        if (gi.types.includes('core:stalker')) expect(gi.weakness).not.toBe('core:weak_sleep');
      }
    }
    const h = weaknessHandlers.get('thrown');
    const p = content.guardianWeaknesses['core:weak_thrown'].params;
    expect([1, 2, 3, 4, 5].map((d) => h.incoming!(d, 'thrown', p))).toEqual([2, 3, 5, 6, 8]);
    expect(h.incoming!(5, 'melee', p)).toBe(5);
  });

  it('a warden is never slow; its offer shows the HP range from the formula; guardian offers show an HP estimate', async () => {
    // 遅い種族（洞窟トロル）でも、大守護者なら「遅い」にならない
    const slow = Object.values(content.monsters).find((m) => m.speed < 100)!;
    expect(guardianTraits({ content } as never, slow.id)).toContain('slow');
    expect(guardianTraits({ content } as never, slow.id, [], content.balance.guardian.warden.minSpeed)).not.toContain('slow');
    const t = await newRun('v33c-hp-1');
    const g = generateFloor(content, 'v33c-hp-1', 'main', 5, t.world.meta.terrainTable);
    const ws = g.spawns.find((x) => x.type === 'monster' && x.guardian?.warden);
    expect(ws && ws.type === 'monster' ? ws.minSpeed : null).toBe(100);
    expect(wardenHpRange(content, 5)).toEqual({ min: 50, max: 90 });
    expect(guardianForecastText('ja', { rank: 3, traits: [], hpRange: { min: 50, max: 90 } })).toContain('体力 50〜90');
    const o = t.world.camp!.offers.find((x) => x.objective.type === 'slay_guardian')!;
    expect(o.guardian?.hp).toBeGreaterThan(0);
    expect(t.r.port.observe({ map: false }).text).toContain(`体力はおよそ ${o.guardian!.hp}`);
    t.manager.closeAll();
  });

  it('the archive memory adds how many hits it takes', async () => {
    const t = await newRun('v33c-hits-1');
    const view = t.r.port.view();
    const ms = milestoneObs('ja', catalog, { depth: 5, name: { ja: 'テスト', en: 'Test' }, types: [] }, [], { hp: 90, armor: 2, maxHit: 12 }, view);
    expect(ms.text).toMatch(/およそ \d+ 回の命中/);
    t.manager.closeAll();
  });
});

describe('V3-3c perks (§44.3・§44.4)', () => {
  it('a warrior is offered Armor drill by Lv4 if never offered; it adds armor per rank', async () => {
    const t = await newRun('v33c-perk-1', { onBoard: true });
    const p = t.me().pos!;
    const f = t.world.floors[p.floor];
    t.inject({ del: Object.values(t.world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
    const cell = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy })).find((c) => content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[c.y * f.width + c.x]]]]?.passable)!;
    const e0 = structuredClone(t.me()); e0.level = { level: 3, xp: xpForLevel(3) - 1 }; e0.stats!.acc = 99; e0.build = { perks: [], pending: [], abilities: [], offered: [] };
    const m: Entity = { id: 'e_ad0001', kind: 'core:goblin', sid: ++sid, pos: { floor: p.floor, x: cell.x, y: cell.y }, xp: 50,
      actor: { speed: 100, nextActAt: f.time + 1000, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
      stats: { hp: 1, maxHp: 1, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' }, base: { maxHp: 1, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' }, statuses: [] } as Entity;
    t.inject({ put: [e0, m] });
    const dir = (['n', 'e', 's', 'w'] as const).find((d) => { const v = { n: [0, -1], e: [1, 0], s: [0, 1], w: [-1, 0] }[d]; return p.x + v[0] === cell.x && p.y + v[1] === cell.y; })!;
    for (let k = 0; k < 4 && t.world.entities.e_ad0001; k++) await t.act({ type: 'move', dir });
    const ev = t.r.session.history.filter((e) => e.type === 'perk_offered' && (e as { level?: number }).level === 4) as unknown as { options: string[] }[];
    expect(ev.length).toBe(1);
    expect(ev[0].options).toContain('core:perk_armor_drill');
    const armor0 = t.me().stats!.armor;
    expect((await t.act({ type: 'choose_perk', option: 'core:perk_armor_drill' })).ok).toBe(true);
    expect(t.me().stats!.armor).toBe(armor0 + 1);
    t.manager.closeAll();
  });

  it('Strong arm adds thrown damage (crits too); Heavy blow adds melee crit damage', async () => {
    const a = await arena('v33c-arm', { classId: 'core:scout', map: ['P..G'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 300, acc: 99, items: [{ kind: 'core:throwing_knife', qty: 5 }] } });
    const g = structuredClone(a.world.entities[a.gId]); delete g.role; delete g.guardian; delete g.home; g.stats!.eva = -99; g.stats!.armor = 0; g.base!.armor = 0;
    const me = structuredClone(a.world.entities[a.meId]);
    me.build = { perks: ['core:perk_strong_arm', 'core:perk_strong_arm', 'core:perk_strong_arm'], pending: [], abilities: [], offered: [] };
    a.inject({ put: [g, me] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const slot = a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:throwing_knife')!.item!.slot!;
    const dmg: number[] = [];
    for (let k = 0; k < 4; k++) {
      const r = await a.r.port.act({ type: 'throw', slot, target: a.gId }, { source: 'bot' });
      if (!r.ok) break;
      for (const e of a.r.session.history.slice(-40)) if (e.type === 'damaged' && (e as { target?: string }).target === a.gId && !dmg.includes(e.seq)) dmg.push(e.seq);
    }
    const amounts = a.r.session.history.filter((e) => e.type === 'damaged' && (e as { target?: string }).target === a.gId).map((e) => (e as { amount: number }).amount);
    // 投げナイフ 1d4+1 に強肩 3: 1 回 5 以上
    expect(amounts.length).toBeGreaterThan(0);
    for (const v of amounts) expect(v).toBeGreaterThanOrEqual(5);
    // 投擲の欄の威力にも乗る
    const th = a.r.port.observe({ map: false }).observation.self.attack.throws?.find((x) => x.kind === 'throwing_knife');
    expect(th?.dmg).toBe('1d4+4');
    a.manager.closeAll();
    const pk = content.perks['core:perk_heavy_blow'];
    expect(pk.lineage).toBe('warrior_front');
    expect(pk.maxRanks).toBe(3);
    expect(pk.hooks.some((h) => h.hook === 'melee_crit_dmg')).toBe(true);
  });
});

describe('V3-3c fight and texts (§44.5・§44.6)', () => {
  it('fight with several items moves on when one runs out; collect_after picks the throws back up', async () => {
    const a = await arena('v33c-with', { classId: 'core:scout', map: ['P.....G'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 300, acc: 99, items: [{ kind: 'core:javelin', qty: 1 }, { kind: 'core:throwing_knife', qty: 3 }] } });
    const g = structuredClone(a.world.entities[a.gId]); delete g.role; delete g.guardian; delete g.home; g.actor!.speed = 0;
    a.inject({ put: [g] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    const st = macroStart(v, { type: 'fight', target: a.gId, with: 'javelin', alsoWith: ['throwing_knife'], retrieve: false }, catalog);
    expect(st.fightWithList?.map((x) => x.kind)).toEqual(['core:javelin', 'core:throwing_knife']);
    // 投げ槍を持っていない状態: 次の品（投げナイフ）を投げる
    const v2 = { ...v, inventory: v.inventory.filter((i) => i.kind !== 'core:javelin') };
    const d = macroNext(st, v2, catalog, []);
    const knife = v.inventory.find((i) => i.kind === 'core:throwing_knife')!;
    expect(d).toEqual({ command: { type: 'throw', slot: knife.slot, target: a.gId } });
    // collect_after: 決着の後に拾う（追跡中の敵がいなければ）
    const st2 = macroStart(v, { type: 'fight', target: a.gId, with: 'throwing_knife', collectAfter: true }, catalog);
    expect(st2.collectAfter).toBe(true);
    a.manager.closeAll();
  });

  it('a coordinate throw that cannot reach is refused without spending the turn', async () => {
    const a = await arena('v33c-coord', { classId: 'core:scout', map: ['P..........'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 300, items: [{ kind: 'core:throwing_knife', qty: 5 }] } });
    const slot = a.world.entities[a.meId].inv!.items.map((id) => a.world.entities[id]).find((x) => x?.kind === 'core:throwing_knife')!.item!.slot!;
    const seq = a.world.seq;
    const r = await a.r.port.act({ type: 'throw', slot, target: { x: a.ox + 10, y: a.oy } }, { source: 'bot' });
    expect(!r.ok && r.error.code).toBe('out_of_range');
    expect(a.world.seq).toBe(seq);
    a.manager.closeAll();
  });

  it('the camp goal is one line; declare_goal with no arguments gives the options', async () => {
    const t = await newRun('v33c-goal-1');
    const o = t.r.port.observe({ map: false });
    expect(o.observation.camp?.goal?.lines).toHaveLength(1);
    expect(t.r.port.goalInfo().full?.some((l) => l.startsWith('目標の候補'))).toBe(true);
    t.manager.closeAll();
  });

  it('ward fires name their guardian; once one is seen, the others show a direction', async () => {
    const a = await arena('v33c-ward', { map: ['P.........', '..........', '..........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: ['core:warded'], state: 'asleep' }, player: { hp: 100 } });
    const fire = (id: string, x: number, y: number): Entity => ({ id, kind: 'core:ward_fire', sid: ++sid, pos: { floor: a.key, x, y }, feature: { state: 'lit' }, lairOf: a.gId } as Entity);
    // 1 基は見える所、もう 1 基は壁の向こう（見えない）
    const f = a.world.floors[a.key];
    let hidden: { x: number; y: number } | null = null;
    for (let y = 0; y < f.height && !hidden; y++) for (let x = 0; x < f.width && !hidden; x++) {
      if (Math.abs(x - a.ox) + Math.abs(y - a.oy) > 15 && content.terrain[content.terrainIndex[a.world.meta.terrainTable[f.terrain[y * f.width + x]]]]?.passable) hidden = { x, y };
    }
    a.inject({ put: [fire('e_wf0001', a.ox + 3, a.oy + 1), fire('e_wf0002', hidden!.x, hidden!.y)] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const o = a.r.port.observe({ map: false });
    const ft = o.observation.visible.features.find((x) => x.type === 'core:ward_fire');
    expect(ft?.lair).toContain('試し');
    const view = a.r.port.view();
    expect(view.wardHints?.length).toBe(1);
    a.manager.closeAll();
  });
});

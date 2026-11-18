// V3-8a（IMPROVEMENTS_V3 §56.1）の確認: 守護者の候補の装甲と通る目安、枠の規則の文、着いた品は拾ってから止まる、
// steady も累計の被害で止まる、地物の ID を travel_to で指す、加護の説明は持っている加護が変わったときだけ。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Entity, GameEvent } from '@muse/shared';
import { applyEvent, buildObservation, macroNext, macroStart, projectPlayerView } from '@muse/shared';
import { loadConfig, rulesText, SessionManager } from '@muse/server';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 993000;

describe('V3-8a guardian offers (§56.1 1・2)', () => {
  it('guardian offers carry an armor estimate and the per-hit text; the estimate matches the guardian that spawns', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    let checked = 0;
    for (let s = 0; s < 6 && checked < 2; s++) {
      const r = await m.createRun({ name: 'G', seed: `v38a-guard-${s}`, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
      if ('error' in r) throw new Error(r.error.message);
      const w = r.session.world;
      const o = w.camp!.offers.find((x) => x.objective.type === 'slay_guardian');
      if (!o?.guardian) continue;
      expect(o.guardian.armor).toBeTypeOf('number');
      const text = r.port.observe({ map: false }).text;
      const line = text.split('\n').find((l) => l.includes(`${o.index}) `) && l.includes('守護者「'))!;
      expect(line).toContain(`装甲はおよそ ${o.guardian.armor}`);
      expect(line).toContain('いまの持ち物で 1 回に通る目安');
      expect(line).toMatch(/およそ \d+ 回の命中/);
      // 出てきた守護者の装甲（型の効果を除く素の値）と同じ
      expect((await r.port.act({ type: 'start_expedition', offer: o.index }, { source: 'bot' })).ok).toBe(true);
      const pid = r.port.playerId;
      const meId = w.players[pid].entityId;
      const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
      while (w.floors[w.entities[meId].pos!.floor].depth < o.objective.targetDepth!) {
        const f = w.floors[w.entities[meId].pos!.floor];
        const me = structuredClone(w.entities[meId]); me.pos = { floor: me.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
        inject({ put: [me], del: Object.values(w.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
        await r.port.act({ type: 'wait' }, { source: 'bot' });
        expect((await r.port.act({ type: 'stairs' }, { source: 'bot' })).ok).toBe(true);
      }
      const g = Object.values(w.entities).find((e) => e.guardian && e.pos?.floor === w.entities[meId].pos!.floor && !e.guardian.warden)!;
      expect(g.stats!.armor).toBe(o.guardian.armor);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    m.closeAll();
  });

  it('get_rules says slots stand for distance and reward, and danger is read from each forecast', () => {
    const ja = rulesText('all', 'ja', catalog);
    expect(ja).toContain('枠（堅実・標準・野心）は、目標の遠さと見返りの大きさを表す。危険は、候補ごとの見立て（推奨レベルとの差・一撃の目安・通る目安）で読む');
    expect(rulesText('all', 'en', catalog)).toContain('stand for how far the target is and how big the reward is');
  });
});

describe('V3-8a macros (§56.1 3・4)', () => {
  it('travel_to an item that stops on arrival picks it up first, unless the stop is hp_floor', async () => {
    const a = await arena('v38a-pick', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + 4 }; a.inject({ put: [g] });
    const item = { id: `e_it${(++sid).toString(36).slice(-4)}`, kind: 'core:potion_healing', sid: ++sid, pos: { floor: a.key, x: a.ox, y: a.oy }, item: { qty: 1, affixes: [] } } as unknown as Entity;
    a.inject({ put: [item] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const view = projectPlayerView(a.world, a.pid);
    const st = macroStart(view, { type: 'travel', to: item.id, mode: 'careful' }, catalog);
    st.steps = 1;
    // 着いた手番に攻撃を受けた（careful なら attacked で止まる）→ 先に拾う
    const attack = [{ type: 'attack', attacker: a.gId, target: a.meId, hit: false, seq: 1 } as never];
    const d1 = macroNext(st, view, catalog, attack);
    expect(d1).toEqual({ command: { type: 'pickup', item: item.id } });
    expect(macroNext(st, view, catalog, [])).toEqual({ stop: 'attacked' });
    // hp_floor では拾わずに止まる
    const st2 = macroStart(view, { type: 'travel', to: item.id, mode: 'steady', hpFloor: 100 }, catalog);
    st2.steps = 1;
    expect(macroNext(st2, view, catalog, [])).toEqual({ stop: 'hp_floor' });
    a.manager.closeAll();
  });

  it('steady stops once the damage taken during the call passes a quarter of max HP', async () => {
    const a = await arena('v38a-steady', { map: ['P..........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + 10 }; a.inject({ put: [g] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const view = projectPlayerView(a.world, a.pid);
    const st = macroStart(view, { type: 'travel', to: { x: a.ox + 5, y: a.oy }, mode: 'steady', hpFloor: 1 }, catalog);
    st.steps = 1;
    const hit = (n: number) => [{ type: 'damaged', target: a.meId, amount: n, via: 'ranged', seq: 1 } as never];
    expect('command' in macroNext(st, view, catalog, hit(12))).toBe(true);
    expect('command' in macroNext(st, view, catalog, hit(13))).toBe(true);
    expect(macroNext(st, view, catalog, hit(1))).toEqual({ stop: 'damage_taken' });
    a.manager.closeAll();
  });
});

describe('V3-8a features and boons (§56.1 5)', () => {
  it('features show an id, and travel_to a feature id arrives next to it', async () => {
    const a = await arena('v38a-feature', { map: ['P....F'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId] }); // 敵はいらない
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const obs = buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
    const fire = obs.visible.features.find((f) => f.type === 'core:ward_fire')!;
    expect(fire.id).toMatch(/^e_/);
    const res = await a.r.port.act({ type: 'travel', to: fire.id!, mode: 'steady', hpFloor: 1 }, { source: 'bot' });
    expect(res.ok).toBe(true);
    const me = a.world.entities[a.meId].pos!;
    expect(Math.max(Math.abs(me.x - fire.pos.x), Math.abs(me.y - fire.pos.y))).toBe(1);
    a.manager.closeAll();
  });

  it('boon descriptions are shown once until the set of boons changes', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await m.createRun({ name: 'B', seed: 'v38a-boons', classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const pid = r.port.playerId;
    const meId = w.players[pid].entityId;
    const boon = Object.keys(catalog.boons ?? {})[0];
    const me = structuredClone(w.entities[meId]); me.boons = [boon];
    applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [me] } as unknown as GameEvent);
    const brief = (res: { ok: boolean }) => !!(res as unknown as { observation?: { self?: { boons_brief?: boolean } } }).observation?.self?.boons_brief;
    const s1 = await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
    expect(brief(s1)).toBe(false);
    expect(brief(await r.port.act({ type: 'wait' }, { source: 'bot' }))).toBe(true);
    const slot = r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    await r.port.act({ type: 'use', slot }, { source: 'bot' });
    // 次の遠征の最初の応答でも、加護が同じなら名前だけ
    expect(brief(await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' }))).toBe(true);
    m.closeAll();
  });
});

// V4-0a（IMPROVEMENTS_V4 §1.1・§1.3）の確認: 倒した記録の無い節目の階には必ず大守護者がいる（遠征の開始時に作り直す）、
// 最後の作り直しでも大守護者を置く、封印の規則と表示は同じ判定、レポートの大守護者は個体で決める。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Content } from '@muse/content';
import type { Entity, GameEvent, ProjectedEvent } from '@muse/shared';
import { applyEvent, buildExpeditionReport, cheb, guardianDisplayName } from '@muse/shared';
import { generateFloor, rollWardenInfo, validators } from '@muse/engine';
import { loadConfig, rulesText, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
const KEY = 'main:5';

/** 地下 5 階まで降りた場面（途中の敵は消す） */
async function toMilestone(seed: string) {
  const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await m.createRun({ name: 'W', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
  if ('error' in r) throw new Error(r.error.message);
  const w = r.session.world;
  const pid = r.port.playerId;
  const meId = w.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const moveTo = async (x: number, y: number) => {
    const me = structuredClone(w.entities[meId]); me.pos = { floor: me.pos!.floor, x, y };
    inject({ put: [me], del: Object.values(w.entities).filter((e) => e.actor && !e.player && !e.guardian && e.pos?.floor === me.pos!.floor).map((e) => e.id) });
    await r.port.act({ type: 'wait' }, { source: 'bot' });
  };
  const descend = async (depth: number) => {
    while (w.floors[w.entities[meId].pos!.floor].depth < depth) {
      const f = w.floors[w.entities[meId].pos!.floor];
      await moveTo(f.stairs.down[0].x, f.stairs.down[0].y);
      expect((await r.port.act({ type: 'stairs' }, { source: 'bot' })).ok).toBe(true);
    }
  };
  expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
  await descend(5);
  const wardenOn = () => Object.values(w.entities).find((e) => e.guardian?.warden && e.pos?.floor === KEY && (e.stats?.hp ?? 0) > 0);
  return { m, r, w, pid, meId, inject, moveTo, descend, wardenOn };
}

/** 古い版のランを写す: 節目の階から大守護者を消す（倒した記録は付かない）。床に品を 1 つ置く */
function makeOldFloor(a: Awaited<ReturnType<typeof toMilestone>>): Entity {
  const g = a.wardenOn()!;
  expect(g).toBeTruthy();
  const minions = Object.values(a.w.entities).filter((e) => e.pos?.floor === KEY && e.actor && !e.player).map((e) => e.id);
  a.inject({ del: [g.id, ...minions] });
  const me = a.w.entities[a.meId].pos!;
  const item = { id: 'e_v40old', kind: 'core:leather_armor', sid: a.w.seq + 1, pos: { floor: KEY, x: me.x, y: me.y }, item: { qty: 1, affixes: [] } } as unknown as Entity;
  a.inject({ put: [item] });
  expect(a.w.milestones?.cleared ?? []).not.toContain(5);
  return item;
}

describe('V4-0a milestone floors always hold a warden (§1.1)', () => {
  it('a warden-less milestone floor is rebuilt at the next start; the expedition resumes from its new stairs up and the warden is the one offered', async () => {
    const a = await toMilestone('v40a-reset');
    const item = makeOldFloor(a);
    const f0 = a.w.floors[KEY];
    // 規則と表示が同じ判定: 大守護者がいなくても、倒した記録が無ければ封じられている（前は規則だけ通していた）
    await a.moveTo(f0.stairs.down[0].x, f0.stairs.down[0].y);
    expect(a.r.port.observe({ map: false }).text).toContain('use_stairs (不可: 下り階段は封じられている');
    const st = await a.r.port.act({ type: 'stairs' }, { source: 'bot' }) as unknown as { ok: boolean; error?: { code: string } };
    expect(st.ok).toBe(false);
    expect(st.error?.code).toBe('sealed');
    // 上り階段で撤退 → 次の遠征はこの階から
    await a.moveTo(f0.stairs.up!.x, f0.stairs.up!.y);
    expect((await a.r.port.act({ type: 'extract', confirm: true }, { source: 'bot' })).ok).toBe(true);
    expect(a.w.players[a.pid].extractPos?.floor).toBe(KEY);
    const ms = a.w.camp!.milestone!;
    expect(ms.depth).toBe(5);
    const expectedKind = generateFloor(content, a.w.secret.seed, 'main', 5, a.w.meta.terrainTable).spawns.find((s) => s.type === 'monster' && s.guardian?.warden)!.kind;
    const n = a.r.session.history.length;
    const res = await a.r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' }) as unknown as { ok: boolean; turn?: { changes: { code: string; text: string }[] } };
    expect(res.ok).toBe(true);
    const evs = a.r.session.history.slice(n);
    const reset = evs.find((e) => e.type === 'floor_reset') as unknown as { floorKey: string; depth: number; del: string[] };
    expect(reset).toMatchObject({ floorKey: KEY, depth: 5 });
    expect(reset.del).toContain(item.id);
    // 開始の応答に 1 行
    const name = guardianDisplayName('ja', ms);
    expect(res.turn?.changes.find((c) => c.code === 'floor_reset')?.text).toBe(`地下5階は姿を変えた。大守護者「${name}」の間になっている（その階の地図と記憶は消え、床に残していた品は失われた）`);
    // 作り直した階の上り階段から始まる。大守護者は候補に出していたもの（名前・型・弱点・種族）
    const f1 = a.w.floors[KEY];
    const me = a.w.entities[a.meId].pos!;
    expect(me.floor).toBe(KEY);
    expect(cheb(me, f1.stairs.up!)).toBeLessThanOrEqual(1);
    const g = a.wardenOn()!;
    expect(g).toBeTruthy();
    expect(g.guardian!.name).toEqual(ms.name);
    expect(g.guardian!.types).toEqual(ms.types);
    expect(g.guardian!.weakness).toBe(rollWardenInfo(content, a.w.secret.seed, 5).weakness);
    expect(g.kind).toBe(expectedKind);
    // 床の品は失われ、前の階の記憶も消えた
    expect(a.w.entities[item.id]).toBeUndefined();
    expect(a.w.players[a.pid].knowledge.floors[KEY].remembered.some((x) => x.id === item.id)).toBe(false);
    // 倒した記録はまだ無い（封じられたまま。倒す相手がいる）
    expect(a.w.milestones?.cleared ?? []).not.toContain(5);
    a.m.closeAll();
  });

  it('when the expedition resumes elsewhere, the floor is dropped and generated as a warden hall on the next arrival', async () => {
    const a = await toMilestone('v40a-lazy');
    makeOldFloor(a);
    const slot = a.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    expect((await a.r.port.act({ type: 'use', slot }, { source: 'bot' })).ok).toBe(true);
    expect(a.w.players[a.pid].extractPos?.floor).not.toBe(KEY);
    expect((await a.r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    expect(a.w.floors[KEY]).toBeUndefined();
    expect(a.w.players[a.pid].knowledge.floors[KEY]).toBeUndefined();
    // 地下 4 階から降りると、大守護者の間として作られる
    await a.descend(5);
    expect(a.w.entities[a.meId].pos!.floor).toBe(KEY);
    expect(a.wardenOn()).toBeTruthy();
    a.m.closeAll();
  });

  it('a floor with a player body on it is not rebuilt; a cleared milestone is never rebuilt', async () => {
    const a = await toMilestone('v40a-keep');
    makeOldFloor(a);
    const slot = a.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    await a.r.port.act({ type: 'use', slot }, { source: 'bot' });
    // 協力の仲間がまだその階にいる場面を写す（自分の体をその階に置く）
    const me = structuredClone(a.w.entities[a.meId]); me.pos = { floor: KEY, x: a.w.floors[KEY].stairs.up!.x, y: a.w.floors[KEY].stairs.up!.y };
    a.inject({ put: [me] });
    const n = a.r.session.history.length;
    expect((await a.r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    expect(a.r.session.history.slice(n).some((e) => e.type === 'floor_reset')).toBe(false);
    expect(a.w.floors[KEY]).toBeTruthy();
    a.m.closeAll();
    // 倒した記録があれば、大守護者がいなくても作り直さない（封じられてもいない）
    const b = await toMilestone('v40a-cleared');
    const g = b.wardenOn()!;
    applyEvent(b.w, { type: 'warden_slain', depth: 5, id: g.id, guardianName: g.guardian!.name, by: null, seq: b.w.seq + 1, cause: null, floor: KEY, ft: 0, wall: 0, seenBy: [], del: [g.id] } as unknown as GameEvent);
    const slot2 = b.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    await b.r.port.act({ type: 'use', slot: slot2 }, { source: 'bot' });
    const n2 = b.r.session.history.length;
    expect((await b.r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    expect(b.r.session.history.slice(n2).some((e) => e.type === 'floor_reset')).toBe(false);
    expect(b.w.floors[KEY]).toBeTruthy();
    b.m.closeAll();
  });

  it('a run started on an old version gets the newer terrain appended to its table before a floor is made', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await m.createRun({ name: 'O', seed: 'v40a-terrain', classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    // 古い版の表を写す: 本棚の番号を、今のコンテンツに無い地形にする（地下 1 階は本棚を使っていない）
    const bi = w.meta.terrainTable.indexOf('core:bookshelf');
    expect(w.floors['main:1'].terrain.includes(bi)).toBe(false);
    w.meta.terrainTable = w.meta.terrainTable.map((id) => (id === 'core:bookshelf' ? 'core:retired_terrain' : id));
    const len = w.meta.terrainTable.length;
    expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    const pid = r.port.playerId;
    const meId = w.players[pid].entityId;
    const f1 = w.floors['main:1'];
    const me = structuredClone(w.entities[meId]); me.pos = { floor: 'main:1', x: f1.stairs.down[0].x, y: f1.stairs.down[0].y };
    applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [me], del: Object.values(w.entities).filter((e) => e.actor && !e.player && e.pos?.floor === 'main:1').map((e) => e.id) } as unknown as GameEvent);
    await r.port.act({ type: 'wait' }, { source: 'bot' });
    const n = r.session.history.length;
    expect((await r.port.act({ type: 'stairs' }, { source: 'bot' })).ok).toBe(true);
    const ext = r.session.history.slice(n).find((e) => e.type === 'terrain_table_extended') as unknown as { added: string[] };
    expect(ext.added).toEqual(['core:bookshelf']);
    // 後ろに足すだけ（作り済みの階の番号は変わらない）
    expect(w.meta.terrainTable.length).toBe(len + 1);
    expect(w.meta.terrainTable[len]).toBe('core:bookshelf');
    expect(w.floors['main:2']).toBeTruthy();
    m.closeAll();
  });

  it('get_rules says an uncleared milestone floor without a warden is rebuilt at the expedition start', () => {
    expect(rulesText('all', 'ja', catalog)).toContain('倒していない節目の階に大守護者がいなければ（古い版で作られた階など）、遠征の開始時にその階を大守護者の間として作り直す');
    expect(rulesText('all', 'en', catalog)).toContain("it is rebuilt as a warden's hall when an expedition starts");
  });

  it('the last-resort layout (fallback) of a milestone floor still holds the warden, near the stairs down', () => {
    const NEVER = 'test:v40a_never';
    if (!validators.has(NEVER)) validators.register(NEVER, () => false);
    const c2 = structuredClone(content) as Content;
    for (const ft of c2.lists.floorTypes) if (ft.rules.warden) ft.validators = [...ft.validators, NEVER];
    for (const id of Object.keys(c2.floorTypes)) if (c2.floorTypes[id].rules.warden) c2.floorTypes[id] = c2.lists.floorTypes.find((x) => x.id === id)!;
    const tt = content.terrain.map((tr) => tr.id);
    for (const seed of ['v40a-fb-1', 'v40a-fb-2', 'v40a-fb-3']) {
      const g = generateFloor(c2, seed, 'main', 5, tt);
      expect(g.layout).toBe('core:fallback');
      const sp = g.spawns.find((s) => s.type === 'monster' && s.guardian?.warden);
      expect(sp).toBeTruthy();
      expect(cheb(sp as { x: number; y: number }, g.floor.stairs.down[0])).toBeLessThanOrEqual(6);
      // 名前・型・弱点は候補（シードと深さ）と同じ
      expect((sp as { guardian?: { name: unknown } }).guardian!.name).toEqual(rollWardenInfo(content, seed, 5).name);
    }
  });
});

describe('V4-0a the report counts only the warden itself as a warden (§1.3)', () => {
  let seq = 0;
  const ME = 'e_me0001';
  const ev = (type: string, x: Record<string, unknown> = {}): ProjectedEvent => ({ type, seq: ++seq, cause: null, floor: 'main:5', ft: 0, wall: 0, ...x }) as unknown as ProjectedEvent;
  const events = () => {
    seq = 0;
    return [
      ev('expedition_started', { expedition: { no: 11, objective: { type: 'slay_warden', targetDepth: 5 }, self: { turns: 0, hp: 40, maxHp: 40 } } }),
      ev('damaged', { source: ME, target: 'e_sling1', targetKind: 'core:goblin_slinger', targetAffixes: ['core:guardian'], amount: 7, dealt: 7, via: 'melee' }),
      ev('died', { id: 'e_sling1', kind: 'core:goblin_slinger', killer: ME, via: 'melee', affixes: ['core:guardian'] }),
      ev('expedition_ended', { no: 11, reason: 'withdrawn', result: { reason: 'withdrawn', deepest: 5 } }),
    ];
  };
  it('a guardian fought on a milestone floor is a guardian, not the milestone warden', () => {
    const r = buildExpeditionReport({ locale: 'ja', catalog, selfId: ME, no: 11, events: events(), marks: [[2, 1], [3, 2]], calls: [], milestone: { every: 5, min: 5 }, guardianNames: { warden: { 5: 'オルオル' } } });
    const fight = r.moments.find((m) => m.kind === 'guardian_fight' || m.kind === 'warden_fight')!;
    expect(fight.kind).toBe('guardian_fight');
    expect(fight.text).not.toContain('大守護者');
    expect(fight.text).not.toContain('オルオル');
  });
  it('the warden individual (from the world or warden_slain) is still the warden', () => {
    const r = buildExpeditionReport({ locale: 'ja', catalog, selfId: ME, no: 11, events: events(), marks: [[2, 1], [3, 2]], calls: [], milestone: { every: 5, min: 5 }, guardianNames: { warden: { 5: 'オルオル' } }, wardenIds: ['e_sling1'] });
    expect(r.moments.find((m) => m.kind === 'warden_fight')?.text).toContain('大守護者「オルオル」');
  });
});

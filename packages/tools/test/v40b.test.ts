// V4-0b（IMPROVEMENTS_V4 §1.2・§1.4・§1.5）の確認: 古い版で始まったランの記録と 1 行、隠れる地形、
// explore の風の方角の往復、fight の見失い、遅い追跡者、表示の直し。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Entity, GameEvent, PerceivedEvent } from '@muse/shared';
import { applyEvent, buildObservation, diffChanges, hpEstimateText, macroNext, macroStart, macroStopError, memoryCombatText, projectPlayerView, turnSnapshot } from '@muse/shared';
import { checkRunGaps, compareVersions } from '@muse/engine';
import { loadConfig, rulesText, SessionManager } from '@muse/server';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);

async function newRun(seed: string) {
  const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await m.createRun({ name: 'B', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
  if ('error' in r) throw new Error(r.error.message);
  const w = r.session.world;
  const pid = r.port.playerId;
  const meId = w.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const clearFloor = () => inject({ del: Object.values(w.entities).filter((e) => e.actor && !e.player && e.pos?.floor === w.entities[meId].pos?.floor).map((e) => e.id) });
  /** 下り階段に置いて降りる（途中の敵は消す。節目は倒した記録を付ける） */
  const descend = async (depth: number) => {
    while (w.floors[w.entities[meId].pos!.floor].depth < depth) {
      const key = w.entities[meId].pos!.floor;
      const f = w.floors[key];
      const me = structuredClone(w.entities[meId]); me.pos = { floor: key, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
      inject({ put: [me] });
      clearFloor();
      if (f.floorType === 'core:warden_hall') applyEvent(w, { type: 'warden_slain', depth: f.depth, id: 'e_none', guardianName: { ja: '-', en: '-' }, by: null, seq: w.seq + 1, cause: null, floor: key, ft: 0, wall: 0, seenBy: [] } as unknown as GameEvent);
      await r.port.act({ type: 'wait' }, { source: 'bot' });
      expect((await r.port.act({ type: 'stairs' }, { source: 'bot' })).ok).toBe(true);
    }
  };
  return { m, r, w, pid, meId, inject, clearFloor, descend };
}

describe('V4-0b runs that began on an older version (§1.2)', () => {
  it('camp says once that the run began on an older version', async () => {
    const a = await newRun('v40b-old');
    a.w.meta.engineVersion = '0.8.0';
    const t1 = a.r.port.observeWithTurn('observed', {}).text;
    expect(t1).toContain('このランは古い版で始まった（engine 0.8.0）。階の一部が姿を変えることがある');
    expect(a.r.port.observeWithTurn('observed', {}).text).not.toContain('このランは古い版で始まった');
    expect(compareVersions('0.8.0', '0.25.0')).toBeLessThan(0);
    expect(compareVersions('0.25.0', '0.25.0')).toBe(0);
    a.m.closeAll();
  });

  it('the startup check lists known gaps without changing the world; the expedition start fills in the hiding terrain', async () => {
    const a = await newRun('v40b-gaps');
    expect(checkRunGaps(a.w, content)).toEqual([]);
    // 古い版のランを写す: 隠れる地形の番号が無い
    delete a.w.meta.concealTerrain;
    const gaps = checkRunGaps(a.w, content);
    expect(gaps.some((g) => g.includes('隠れる地形（背の高い草）の番号が無い'))).toBe(true);
    expect(a.w.meta.concealTerrain).toBeUndefined();
    expect((await a.r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    expect(a.w.meta.concealTerrain).toEqual([a.w.meta.terrainTable.indexOf('core:tall_grass')]);
    expect(checkRunGaps(a.w, content)).toEqual([]);
    a.m.closeAll();
  });
});

describe('V4-0b explore toward the draft does not swing between two frontiers (§1.4)', () => {
  it('a sanctuary that took 173 steps to find the stairs now takes far fewer', async () => {
    const a = await newRun('draft40-15');
    expect((await a.r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    await a.descend(6);
    const key = a.w.entities[a.meId].pos!.floor;
    expect(a.w.floors[key].floorType).toBe('core:sanctuary');
    const n = a.r.session.history.length;
    let found = false;
    for (let call = 0; call < 6 && !found; call++) {
      a.clearFloor();
      const me = structuredClone(a.w.entities[a.meId]); me.stats!.hp = me.stats!.maxHp; a.inject({ put: [me] });
      let res = await a.r.port.act({ type: 'explore', mode: 'steady', hpFloor: 1, toward: 'draft' }, { source: 'bot' });
      // 方角に行ける境界が無くなったら止まる（S1c §14.6 の 2）: ほかの方角は toward を付けない explore で探す（断りの文の勧め）
      if (!res.ok && res.error.details?.stop === 'toward_exhausted') res = await a.r.port.act({ type: 'explore', mode: 'steady', hpFloor: 1 }, { source: 'bot' });
      const hint = a.w.players[a.pid].knowledge.floorHint;
      found = !!hint && hint.floor === key && hint.draft === null;
      if (!res.ok) break;
    }
    const steps = a.r.session.history.slice(n).filter((e) => e.type === 'entity_moved' && (e as unknown as { id: string }).id === a.meId).length;
    expect(found).toBe(true);
    expect(steps).toBeLessThan(100);
    a.m.closeAll();
  });
});

describe('V4-0b fight and explore macros (§1.4)', () => {
  it('fight waits up to 5 turns for a hunting target that went out of sight, but not while another hunter is in view or you are hurt', async () => {
    const a = await arena('v40b-lost', { map: ['P....G....'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 100 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v0 = projectPlayerView(a.world, a.pid);
    const g = a.world.entities[a.gId];
    const gone = () => { a.inject({ del: [a.gId] }); return projectPlayerView(a.world, a.pid); };
    const st = macroStart(v0, { type: 'fight', target: a.gId }, catalog);
    const vLost = (() => { const keep = structuredClone(g); const v = gone(); a.inject({ put: [keep] }); return v; })();
    for (let i = 0; i < 5; i++) expect(macroNext(st, vLost, catalog, [])).toEqual({ command: { type: 'wait' } });
    expect(macroNext(st, vLost, catalog, [])).toEqual({ stop: 'target_gone' });
    // 被害を受けた手番は待たない
    const st2 = macroStart(v0, { type: 'fight', target: a.gId }, catalog);
    expect(macroNext(st2, vLost, catalog, [{ type: 'damaged', target: a.meId, amount: 1, via: 'melee', seq: 1 } as never])).toEqual({ stop: 'target_gone' });
    // ほかに届く追跡中の敵が見えていれば待たない
    const other = structuredClone(g); other.id = 'e_gd0002'; delete other.role; delete other.guardian; other.pos = { ...other.pos!, x: a.ox + 7 };
    a.inject({ put: [other] });
    const v1 = projectPlayerView(a.world, a.pid);
    const st3 = macroStart(v1, { type: 'fight', target: a.gId }, catalog);
    const keep = structuredClone(a.world.entities[a.gId]);
    const vLost2 = gone();
    a.inject({ put: [keep] });
    expect(macroNext(st3, vLost2, catalog, [])).toEqual({ stop: 'target_gone' });
    a.manager.closeAll();
  });

  it('explore keeps going while only slow hunters 3+ cells away follow; stops when one comes within 2; a normal-speed hunter still stops it', async () => {
    const a = await arena('v40b-slow', { map: ['.........................', '.....P...................', '.........................'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const base = structuredClone(a.world.entities[a.gId]);
    delete base.role; delete base.guardian; delete base.home;
    const beetle = (id: string, dx: number, state: 'hunting' | 'asleep') => {
      const b = structuredClone(base); b.id = id; b.kind = 'core:stoneskin_beetle'; b.actor = { ...b.actor!, speed: 70, ai: { ...b.actor!.ai!, state } };
      const me = a.world.entities[a.meId].pos!; b.pos = { floor: me.floor, x: me.x + dx, y: me.y };
      return b;
    };
    a.inject({ del: [a.gId], put: [beetle('e_bt0001', -5, 'asleep')] }); // 種族は知っている（初見で止まらない）
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 東の先はまだ見ていない（探索の境界を作る）
    const mp = a.world.entities[a.meId].pos!;
    const fl = a.world.floors[mp.floor];
    const fk = a.world.players[a.pid].knowledge.floors[mp.floor];
    for (let y = 0; y < fl.height; y++) for (let x = mp.x + 8; x < fl.width; x++) fk.seen[y * fl.width + x] = 0;
    const v0 = projectPlayerView(a.world, a.pid);
    const st = macroStart(v0, { type: 'explore' }, catalog);
    a.inject({ put: [beetle('e_bt0002', 4, 'hunting')] });
    const d1 = macroNext(st, projectPlayerView(a.world, a.pid), catalog, []);
    expect('command' in d1).toBe(true);
    expect(st.slowChasers).toEqual(['e_bt0002']);
    a.inject({ put: [beetle('e_bt0002', 2, 'hunting')] });
    expect(macroNext(st, projectPlayerView(a.world, a.pid), catalog, [])).toEqual({ stop: 'chaser_near' });
    // 速さが同じ追跡中の敵なら今までどおり止まる
    const st2 = macroStart(v0, { type: 'explore' }, catalog);
    const gob = structuredClone(beetle('e_bt0003', 4, 'hunting')); gob.kind = 'core:stoneskin_beetle'; gob.actor = { ...gob.actor!, speed: 100 };
    a.inject({ del: ['e_bt0002'], put: [gob] });
    expect(macroNext(st2, projectPlayerView(a.world, a.pid), catalog, [])).toEqual({ stop: 'hostile_in_view' });
    a.manager.closeAll();
  });

  it('refusals: an adjacent hunter says flee or fight; a fleeing target says it is fleeing, not out of sight', () => {
    expect(macroStopError('ja', 'hostile_adjacent', { type: 'explore' }).hint).toContain("振り切るなら mode: 'flee'");
    expect(macroStopError('ja', 'hostile_adjacent', { type: 'explore' }).hint).toContain('戦うなら fight { target }');
    const e = macroStopError('ja', 'target_moved', { type: 'fight', target: 'e_x' });
    expect(e.message).toContain('見えているが、逃げている');
    expect(rulesText('all', 'ja', catalog)).toContain('応答の時点の判定で、敵の射撃も同じ経路の判定');
  });
});

describe('V4-0b display fixes (§1.5)', () => {
  it('a finishing critical shows the rolled damage and what was left', async () => {
    const a = await arena('v40b-crit', { map: ['PG'], guardian: { kind: 'core:goblin', hp: 5, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 100 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v0 = projectPlayerView(a.world, a.pid);
    const prev = turnSnapshot(v0, buildObservation(v0, catalog, { detail: 'brief', map: false }));
    a.inject({ del: [a.gId] });
    const v1 = projectPlayerView(a.world, a.pid);
    const o1 = buildObservation(v1, catalog, { detail: 'brief', map: false });
    const cur = turnSnapshot(v1, o1);
    const pe = (seq: number, event: Record<string, unknown>): PerceivedEvent => ({ seq, type: event.type as never, text: '', event: { seq, ...event } as never });
    const s = prev.seq;
    const events = [
      pe(s + 1, { type: 'attack', attacker: a.meId, target: a.gId, hit: true, crit: true }),
      pe(s + 2, { type: 'damaged', source: a.meId, target: a.gId, amount: 12, dealt: 5, via: 'melee' }),
      pe(s + 3, { type: 'died', id: a.gId, killer: a.meId }),
    ];
    const ch = diffChanges(prev, cur, v1, o1, events, catalog);
    expect(ch.find((c) => c.code === 'killed')?.text).toMatch(/^倒した: .+（会心 12。残り 5 を倒した）$/);
    a.manager.closeAll();
  });

  it('HP estimates: an unhurt foe shows the record, not "left"; a lower bound says where it comes from; species records say they are plain individuals', () => {
    // 2 体以上は「およそ N（a〜b。M 体の記録）」、1 体だけなら「1 体の記録」（S4 §42.2 の 3）
    expect(hpEstimateText('ja', { min: 3, max: 8, samples: 6, record: { min: 3, max: 8 }, untouched: true })).toBe('体力の記録 およそ 5（3〜8。6 体の記録）／まだ傷を負っていない');
    expect(hpEstimateText('ja', { min: 3, max: null, samples: 1, record: { min: 8, max: 8 } })).toBe('記録どおりなら残り 3 以上（傷の具合と、体力の記録の最小 8 から）／体力の記録 8（1 体の記録。個体差あり）');
    expect(hpEstimateText('ja', { min: 6, max: 8, samples: 6, record: { min: 8, max: 8 } })).toBe('記録どおりなら残り 6〜8／体力の記録 8（6 体とも）');
    const mem = { kind: 'core:goblin', encounters: 3, kills: 3, maxDamageToYou: 2, maxDamageByYou: 5, abilities: [], hpSeen: { min: 5, max: 9, samples: 3 } };
    expect(memoryCombatText('ja', mem)).toContain('体力の記録:およそ 7（5〜9。3 体の記録。個体差あり）（これまでに見た素の個体の範囲。守護者と強敵はこれより多い）');
    expect(memoryCombatText('ja', { ...mem, hpSeen: { min: 7, max: 7, samples: 1 } })).toContain('体力の記録:7（1 体の記録。個体差あり）');
    expect(memoryCombatText('ja', { ...mem, guardian: true })).not.toContain('素の個体');
  });

  it('collect says the relic is not included instead of a bare "0 left"', async () => {
    const a = await arena('v40b-relic', { map: ['P...R'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId] });
    const me = a.world.entities[a.meId].pos!;
    const relic = { id: 'e_relic01', kind: 'core:relic', sid: a.world.seq + 1, role: 'relic', pos: { floor: me.floor, x: me.x + 4, y: me.y }, item: { qty: 1, affixes: [] } } as unknown as Entity;
    const potion = { id: 'e_pot001', kind: 'core:potion_healing', sid: a.world.seq + 2, pos: { floor: me.floor, x: me.x + 2, y: me.y }, item: { qty: 1, affixes: [] } } as unknown as Entity;
    a.inject({ put: [relic, potion] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const res = await a.r.port.act({ type: 'collect', what: 'items' }, { source: 'bot' }) as unknown as { ok: boolean; outcome?: string };
    expect(res.ok).toBe(true);
    expect(res.outcome).toContain('回収 1 個、残り 0 個。遺物は対象外（拾うと階の敵が目を覚ます。拾うなら travel_to e_relic01 で着いて pickup）。');
    a.manager.closeAll();
  });

  it('crossing deeper than the target says overreach and where the next points are', async () => {
    const a = await newRun('v40b-cross');
    const o = a.w.camp!.offers.find((x) => x.objective.type === 'reach_depth' || x.objective.type === 'retrieve_relic' || x.objective.type === 'slay_guardian')!;
    expect((await a.r.port.act({ type: 'start_expedition', offer: o.index }, { source: 'bot' })).ok).toBe(true);
    const td = o.objective.targetDepth!;
    await a.descend(td + 1);
    const key = a.w.entities[a.meId].pos!.floor;
    const f = a.w.floors[key];
    const me = structuredClone(a.w.entities[a.meId]); me.pos = { floor: key, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
    a.inject({ put: [me] });
    a.clearFloor();
    a.r.port.observe({ map: false });
    const res = await a.r.port.act({ type: 'wait' }, { source: 'bot' }) as unknown as { turn?: { changes: { code: string; text: string }[] } };
    const line = res.turn?.changes.find((c) => c.text.startsWith('深追い'))?.text ?? '';
    expect(line).toMatch(new RegExp(`^深追い: 地下${td + 1}階の下り階段に着いた（目標の地下${td}階より深い）。戦利品に深追いの点 \\+\\d+。次は地下${td + 2}階の下り階段で \\+\\d+$`));
    a.m.closeAll();
  });
});

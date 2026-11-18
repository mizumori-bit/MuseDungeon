// V3-6（IMPROVEMENTS_V3 §6・§35.9）の確認: 遠征レポート（知覚した出来事だけから集計、場面、死亡）・このランの中の比較・
// 遠征の終わりの応答・キャンプの比較の行・expedition の途中経過・review・復元後も同じ呼び出し数。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, ExpeditionReport, GameEvent, ProjectedEvent, ReportCall } from '@muse/shared';
import { applyEvent, buildExpeditionReport, compareReports, compareLines, reportLines } from '@muse/shared';
import { loadConfig, RunSession, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
let runsDir: string;
beforeAll(() => { runsDir = mkdtempSync(join(tmpdir(), 'muse-v36-')); });
afterAll(() => { rmSync(runsDir, { recursive: true, force: true }); });

const ME = 'e_me0001';
let seq = 0;
const ev = (type: string, p: Record<string, unknown> = {}): ProjectedEvent => ({ type, seq: ++seq, cause: null, floor: 'main:3', ft: 0, wall: 0, ...p } as unknown as ProjectedEvent);

function sample(): { events: ProjectedEvent[]; marks: [number, number][]; calls: ReportCall[] } {
  seq = 0;
  const events: ProjectedEvent[] = [
    ev('expedition_started', { expedition: { no: 1, objective: { type: 'slay_guardian', targetDepth: 3 }, self: { turns: 10, hp: 30, maxHp: 30 } } }),
    ev('attack', { attacker: ME, target: 'e_m00001', hit: true, crit: false }),
    ev('damaged', { source: ME, target: 'e_m00001', targetKind: 'core:goblin', amount: 5, dealt: 5, via: 'melee' }),
    ev('attack', { attacker: ME, target: 'e_m00001', hit: false, crit: false }),
    ev('damaged', { source: 'e_m00001', sourceKind: 'core:goblin', target: ME, amount: 4, dealt: 4, hpAfter: 26, via: 'melee' }),
    ev('died', { id: 'e_m00001', kind: 'core:goblin', killer: ME, via: 'melee' }),
    ev('item_used', { actor: ME, category: 'potion', kind: 'core:potion_healing' }),
    ev('item_picked_up', { actor: ME, appearanceId: 'core:scroll_look_01', kind: null }),
    ev('item_picked_up', { actor: ME, appearanceId: 'core:potion_look_02', kind: null }),
    ev('item_identified', { player: 'p_1', kind: 'core:potion_poison', appearanceId: 'core:potion_look_02' }),
    ev('damaged', { source: ME, target: 'e_g00001', targetKind: 'core:orc_brute', targetAffixes: ['core:guardian'], amount: 8, dealt: 8, via: 'melee' }),
    ev('attack', { attacker: 'e_g00001', target: ME, hit: true, crit: true }),
    ev('damaged', { source: 'e_g00001', sourceKind: 'core:orc_brute', sourceAffixes: ['core:guardian'], target: ME, amount: 20, dealt: 20, hpAfter: 6, via: 'melee' }),
    ev('died', { id: 'e_g00001', kind: 'core:orc_brute', affixes: ['core:guardian'], killer: ME, via: 'melee' }),
    ev('objective_completed', { no: 1 }),
    ev('level_up', { target: ME, levelAfter: 3, statsAfter: { hp: 10, maxHp: 34 } }),
    ev('haul_changed', { no: 1, gains: { discovery: 50 }, reasons: ['species:core:orc_brute'] }),
    ev('player_state', { player: 'p_1', state: 'at_camp', reason: 'extracted' }),
    ev('expedition_ended', { no: 1, reason: 'completed', result: { reason: 'completed', deepest: 3, payout: { banked: 1200, lost: 0, multiplierPct: 110, parts: { objective: 1000, overreach: 0, treasure: 40, bounty: 0, discovery: 50, kills: 20 }, players: [{ player: 'p_1', banked: 1200, lost: 0 }] } } }),
  ];
  const marks: [number, number][] = [[2, 11], [4, 12], [7, 13], [11, 14], [13, 15], [17, 16]];
  const calls: ReportCall[] = [
    { seq: 1, kind: 'call', type: 'start_expedition' },
    { seq: 2, kind: 'macro_call', type: 'fight' }, { seq: 2, kind: 'macro_step', type: 'attack', macro: 'fight' }, { seq: 4, kind: 'macro_step', type: 'attack', macro: 'fight' },
    { seq: 7, kind: 'call', type: 'use' },
    { seq: 8, kind: 'macro_call', type: 'rest' }, { seq: 8, kind: 'macro_step', type: 'rest', macro: 'rest' }, { seq: 9, kind: 'macro_step', type: 'rest', macro: 'rest' },
    { seq: 11, kind: 'call', type: 'attack' }, { seq: 18, kind: 'call', type: 'extract' },
  ];
  return { events, marks, calls };
}

describe('V3-6 expedition report (§6.1)', () => {
  it('counts only the perceived events: combat, items, tempo; picks moments; payout from the end event', () => {
    const s = sample();
    const r = buildExpeditionReport({ locale: 'ja', catalog, selfId: ME, no: 1, ...s, milestone: { every: 5, min: 5 }, guardianNames: { objective: 'ヤオルト' } });
    expect(r.status).toBe('ended');
    expect(r.reason).toBe('completed');
    // min_hp_pct: 最も下がった HP（6/30 = 20%。V3-7a の余力の目標）
    const { guardian_fights: gfights, ...combat } = r.combat;
    expect(combat).toEqual({ dealt: 13, taken: 24, hits: 1, misses: 1, crits: 0, kills: 2, melee_kills: 2, thrown_kills: 0, ability_uses: 0, min_hp_pct: 20 });
    // 守護者ごとの戦い（V3-3c §44.1: 再挑戦の候補の「前回は与 N・被 M」）
    expect(gfights?.length).toBe(1);
    expect(gfights?.[0].outcome).toBe('slain');
    // 薬の内訳（V3-3c §44.6）
    const { potions_detail: pd, ...economy } = r.economy;
    expect(economy).toEqual({ potions_used: 1, scrolls_read: 0, items_left_unidentified: 1, treasure_banked: 40 });
    expect(pd).toMatch(/ 1$/);
    // 手番は開始時点（10）から最後の記録（16）まで。呼び出しはマクロの 1 手を除く 6 件、手は 8 件のうちマクロが 4
    expect(r.tempo).toMatchObject({ turns: 6, turns_resting: 2, tool_calls: 6, macro_share_pct: 50, deepest: 3 });
    expect(r.payout).toEqual({ parts: { objective: 1000, overreach: 0, treasure: 40, bounty: 0, discovery: 50, kills: 20 }, multiplier_pct: 110, banked: 1200, lost: 0 });
    const kinds = r.moments.map((m) => m.kind);
    // 目的の守護者（倒れた直後に目的が達成された）には公開の名前が付く。HP の最低は死の際の場面と同じなので重ねない
    expect(kinds).toEqual(['guardian_fight', 'near_death_escape', 'big_hit_taken', 'level_up', 'discovery']);
    expect(r.moments[0].text).toBe('手番 14〜15: 守護者「ヤオルト」と戦った（与 8・被 20、倒した）');
    expect(r.moments.find((m) => m.kind === 'big_hit_taken')!.text).toBe('手番 15: 一撃で最大の 20 ダメージ（オークの荒くれ・近接・会心）');
    expect(r.moments.find((m) => m.kind === 'near_death_escape')!.text).toBe('手番 15: HP 6/30 まで減り、帰還した');
    expect(r.moments.find((m) => m.kind === 'discovery')!.text).toContain('初めて倒した: オークの荒くれ');
    const lines = reportLines('ja', r);
    expect(lines.length).toBeLessThanOrEqual(12);
    expect(lines[0]).toBe('振り返り（遠征 1・帰還・達成）:');
    expect(lines[1]).toBe('確定 +1200（目的1000・宝40・発見50・撃破20、倍率 ×1.1）');
    expect(lines.some((l) => l.startsWith('戦闘: 与ダメージ 13・被ダメージ 24・命中 1/2・撃破 2（近接 2・投擲 0）・能動技 0 回・最も下がった HP '))).toBe(true);
  });

  it('small dips are not moments; an unnamed guardian is written by its species; a warden takes the milestone name', () => {
    seq = 0;
    const events = [
      ev('expedition_started', { expedition: { no: 2, objective: { type: 'reach_depth', targetDepth: 5 }, self: { turns: 0, hp: 40, maxHp: 40 } } }),
      ev('damaged', { source: 'e_m00002', sourceKind: 'core:goblin', target: ME, amount: 3, dealt: 3, hpAfter: 37, via: 'melee' }),
      ev('damaged', { source: ME, target: 'e_g00002', targetKind: 'core:orc_brute', targetAffixes: ['core:guardian'], amount: 6, dealt: 6, via: 'melee', floor: 'main:4' }),
      ev('damaged', { source: ME, target: 'e_w00001', targetKind: 'core:cave_troll', targetAffixes: ['core:guardian'], amount: 9, dealt: 9, via: 'melee', floor: 'main:5' }),
      ev('expedition_ended', { no: 2, reason: 'withdrawn', result: { reason: 'withdrawn', deepest: 5 } }),
    ];
    const r = buildExpeditionReport({ locale: 'ja', catalog, selfId: ME, no: 2, events, marks: [[2, 1], [3, 2], [4, 3]], calls: [], milestone: { every: 5, min: 5 }, guardianNames: { warden: { 5: '呼び集める者ヤロ' } }, wardenIds: ['e_w00001'] });
    expect(r.moments.map((m) => m.kind)).toEqual(['guardian_fight', 'warden_fight']);
    expect(r.moments[0].text).toBe('手番 2: 守護者オークの荒くれと戦った（与 6・被 0、倒さずに離れた）');
    expect(r.moments[1].text).toBe('手番 3: 大守護者「呼び集める者ヤロ」と戦った（与 9・被 0、倒さずに離れた）');
  });

  it('death: the killer, the last 10 events and the HP of the last turns; self-inflicted poison is said so', () => {
    seq = 0;
    const events: ProjectedEvent[] = [ev('expedition_started', { expedition: { no: 1, objective: { type: 'reach_depth', targetDepth: 2 }, self: { turns: 0, hp: 20, maxHp: 20 } } })];
    const marks: [number, number][] = [];
    for (let i = 0; i < 12; i++) {
      events.push(ev('damaged', { source: 'e_m00003', sourceKind: 'core:jackal', target: ME, amount: 1, dealt: 1, hpAfter: 19 - i, via: 'melee' }));
      marks.push([seq + 1, i + 1]);
      events.push(ev('noise', { loudness: 1 }));
    }
    events.push(ev('damaged', { source: ME, sourceKind: 'core:warrior', target: ME, amount: 8, dealt: 8, hpAfter: 0, via: 'poison' }));
    events.push(ev('died', { id: ME, kind: 'core:warrior', killer: ME, killerKind: 'core:warrior', via: 'poison' }));
    events.push(ev('expedition_ended', { no: 1, reason: 'died', result: { reason: 'died', deepest: 2 } }));
    const r = buildExpeditionReport({ locale: 'ja', catalog, selfId: ME, no: 1, events, marks, calls: [], narrate: (e) => `#${e.seq} ${e.type}` });
    expect(r.death).toBeTruthy();
    expect(r.death!.killer).toBeNull();
    expect(r.death!.self_inflicted).toBe(true);
    expect(r.death!.last_events).toHaveLength(10);
    expect(r.death!.last_events[9]).toBe(`#${seq - 1} died`);
    expect(r.death!.hp_trace[r.death!.hp_trace.length - 1]).toBe(0);
    expect(r.death!.hp_trace.slice(-3)).toEqual([9, 8, 0]);
    expect(reportLines('ja', r).some((l) => l.startsWith('最期: 自分に付いた毒で倒れた。直近の HP: '))).toBe(true);
    // 死んだ遠征では「HP の最低」を出さない（最期の行がある）
    expect(r.moments.some((m) => m.kind === 'hp_min')).toBe(false);
  });
});

describe('V3-6 compare within the run (§35.9)', () => {
  const rep = (no: number, reason: ExpeditionReport['reason'], banked: number, taken: number, turns: number, kills = 3, calls = 20, deepest = 3): ExpeditionReport => ({
    no, objective: { type: 'reach_depth', target_depth: 3 }, status: 'ended', reason,
    payout: { parts: { objective: banked, overreach: 0, treasure: 0, bounty: 0, discovery: 0, kills: 0 }, multiplier_pct: 100, banked, lost: 0 },
    combat: { dealt: 30, taken, hits: 5, misses: 1, crits: 0, kills, melee_kills: kills, thrown_kills: 0, ability_uses: 0 },
    economy: { potions_used: 0, scrolls_read: 0, items_left_unidentified: 0, treasure_banked: 0 },
    tempo: { turns, turns_resting: 0, floors: 2, turns_per_floor: Math.round(turns / 2), deepest, tool_calls: calls, macro_share_pct: 50 },
    moments: [],
  });
  it('personal bests over earlier expeditions; least damage and fewest turns only among completed ones; the previous one as differences', () => {
    const prevs = [rep(1, 'completed', 2000, 40, 200), rep(2, 'lifeline', 50, 5, 30)];
    const cur = rep(3, 'completed', 5706, 20, 150, 2, 18, 4);
    const c = compareReports('ja', cur, prevs)!;
    expect(c.vs_previous).toEqual({ no: 2, banked: 5656, taken: 15, turns: 120, kills: -1, tool_calls: -2 });
    // 綱で戻った遠征（被ダメージ 5・手番 30）は最少・最短の比べる相手に入らない
    expect(c.personal_best).toEqual(['確定点が自己最高（+5706）', '最深が自己最高（地下4階）', '被ダメージが達成した遠征で最少（20）', '手番が達成した遠征で最短（150）', '呼び出しが達成した遠征で最少（18）']);
    cur.compare = c;
    expect(compareLines('ja', cur)).toEqual([
      '前回の遠征 3（帰還・達成）: 確定点が自己最高（+5706）・最深が自己最高（地下4階）・被ダメージが達成した遠征で最少（20）・手番が達成した遠征で最短（150）・呼び出しが達成した遠征で最少（18）',
      'その前（遠征 2）と比べて: 確定 +5656・被ダメージ +15・手番 +120・撃破 -1・呼び出し -2',
    ]);
    // 最初の遠征: 比べる記録はまだ無い（1 行）
    expect(compareReports('ja', prevs[0], [])).toBeUndefined();
    expect(compareLines('ja', prevs[0])).toEqual(['前回の遠征 1（帰還・達成）: 確定 +2000・被ダメージ 40・手番 200・撃破 3（比べる記録はまだ無い）']);
  });
});

async function newRun(seed: string, runsDirOpt: string | null = null) {
  const manager = new SessionManager(content, loadConfig({ runsDir: runsDirOpt, waitOthersMs: 100, keyframeEvery: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const place = (x: number, y: number) => { const e = structuredClone(me()); e.pos = { floor: e.pos!.floor, x, y }; inject({ put: [e] }); };
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
  let calls = 0;
  const act = (cmd: Command) => { calls++; return r.port.act(cmd, { source: 'bot' }); };
  const toDown = async () => { const f = world.floors[me().pos!.floor]; place(f.stairs.down[0].x, f.stairs.down[0].y); clearMonsters(); return act({ type: 'wait' }); };
  const descend = async () => { await toDown(); const s = await act({ type: 'stairs' }); clearMonsters(); return s; };
  return { manager, r, world, pid, me, act, toDown, descend, calls: () => calls, resetCalls: () => { calls = 0; } };
}

describe('V3-6 reports in the session (§6.1・§6.2・§35.9)', () => {
  it('the ending response carries the report; camp shows the comparison; expedition gives progress; review re-reads it', async () => {
    const t = await newRun('v36-flow-1');
    expect((await t.descend()).ok).toBe(true);
    await t.toDown();
    const end = await t.act({ type: 'extract' });
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    expect(end.report).toBeTruthy();
    expect(end.report!.no).toBe(1);
    expect(end.report!.reason).toBe('completed');
    // 最初の遠征は new_run で始まった（start_expedition の呼び出しは無い）: 呼び出しは送った行動の数
    expect(end.report!.tempo.tool_calls).toBe(t.calls());
    expect(end.report!.tempo.turns).toBe(t.me().actor!.turns);
    const text = t.r.port.formatActionText(end);
    expect(text).toContain('振り返り（遠征 1・帰還・達成）:');
    // キャンプの観測: 目標の宣言は外した（V3-8 §53.5）。比較は 1 行
    expect(text).not.toContain('目標:');
    const obs1 = t.r.port.observe({ map: false }).observation;
    expect(obs1.camp?.compare?.lines).toHaveLength(1);
    // キャンプの expedition: 直前の遠征のレポート
    expect(t.r.port.expeditionReportLines().lines[0]).toBe('振り返り（遠征 1・帰還・達成）:');

    // 2 回目の遠征: 途中経過、終わればキャンプに比較 2 行
    t.resetCalls();
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const prog = t.r.port.expeditionReportLines();
    expect(prog.lines[0]).toBe('途中経過（遠征 2）:');
    expect(prog.progress?.tempo.tool_calls).toBe(1);
    const target = t.world.expeditions![1].objective.targetDepth!;
    while (t.world.floors[t.me().pos!.floor].depth < target) expect((await t.descend()).ok).toBe(true);
    await t.toDown();
    const end2 = await t.act({ type: 'extract', confirm: true });
    expect(end2.ok && end2.report?.no).toBe(2);
    if (!end2.ok) return;
    expect(end2.report!.tempo.tool_calls).toBe(t.calls());
    expect(end2.report!.compare?.vs_previous?.no).toBe(1);
    const obs2 = t.r.port.observe({ map: false }).observation;
    expect(obs2.camp?.compare?.lines).toHaveLength(2);
    expect(obs2.camp!.compare!.lines[1]).toMatch(/^その前（遠征 1）と比べて: 確定 /);
    // review: 直前の遠征、番号指定、無い番号
    const rv = t.r.port.review();
    expect(rv.text.split('\n')[0]).toMatch(/^振り返り（遠征 2・(帰還・達成|撤退)）:$/);
    expect((rv.data as ExpeditionReport).compare?.vs_previous?.no).toBe(1);
    expect(t.r.port.review(1).text.split('\n')[0]).toBe('振り返り（遠征 1・帰還・達成）:');
    expect(t.r.port.review(9).text).toBe('遠征 9 は終わっていないか、参加していない。');
    t.manager.closeAll();
  });

  it('macro calls count once and their steps count toward the macro share; recovery rebuilds the same calls', async () => {
    const t = await newRun('v36-recover-1', runsDir);
    // rest（マクロ）と explore（マクロ）を混ぜる
    for (let i = 0; i < 6; i++) {
      const out = await t.act({ type: i % 2 === 0 ? 'explore' : 'wait' });
      if (!out.ok || t.r.port.view().status !== 'your_turn') break;
    }
    const live = t.r.port.report()!;
    expect(live.status).toBe('in_progress');
    expect(live.tempo.tool_calls).toBe(t.calls());
    expect(live.tempo.macro_share_pct).toBeGreaterThan(0);
    const config = loadConfig({ runsDir, waitOthersMs: 100, keyframeEvery: 100 });
    const rec = RunSession.recover({ content, catalog: t.manager.catalog, config }, t.r.session.runId);
    expect(rec.verified).toBe(true);
    const again = rec.session.expeditionReport(t.pid)!;
    expect(again.tempo).toEqual(live.tempo);
    expect(again.combat).toEqual(live.combat);
    rec.session.close();
    t.manager.closeAll();
  });
});

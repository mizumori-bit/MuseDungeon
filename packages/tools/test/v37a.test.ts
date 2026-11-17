// V3-7a（IMPROVEMENTS_V3 §40.8）の確認: 目標の候補（自己最高に並ぶ／少し超える／大きく超える、初期値）・判定・
// キャンプの文・遠征中の差・extract の差・遠征レポートの goal・記録・取り下げ・遠征中は宣言できない・復元。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import type { Command, Entity, ExpeditionReport, GameEvent, GoalRecord } from '@muse/shared';
import { applyEvent, goalCandidates, judgeGoal } from '@muse/shared';
import { loadConfig, RunSession, SessionManager } from '@muse/server';

const content = loadContent();
let runsDir: string;
beforeAll(() => { runsDir = mkdtempSync(join(tmpdir(), 'muse-v37a-')); });
afterAll(() => { rmSync(runsDir, { recursive: true, force: true }); });

const rep = (no: number, o: { reason?: ExpeditionReport['reason']; banked?: number; deepest?: number; minPct?: number } = {}): ExpeditionReport => ({
  no, objective: { type: 'reach_depth', target_depth: 2 }, status: 'ended', reason: o.reason ?? 'completed',
  payout: { parts: { objective: o.banked ?? 0, overreach: 0, treasure: 0, bounty: 0, discovery: 0, kills: 0 }, multiplier_pct: 100, banked: o.banked ?? 0, lost: 0 },
  combat: { dealt: 0, taken: 0, hits: 0, misses: 0, crits: 0, kills: 0, melee_kills: 0, thrown_kills: 0, ability_uses: 0, min_hp_pct: o.minPct ?? 50 },
  economy: { potions_used: 0, scrolls_read: 0, items_left_unidentified: 0, treasure_banked: 0 },
  tempo: { turns: 10, turns_resting: 0, floors: 1, turns_per_floor: 10, deepest: o.deepest ?? 2, tool_calls: 5, macro_share_pct: 0 },
  moments: [],
});

describe('V3-7a goal candidates and judging (§40.8)', () => {
  it('candidates match / beat / beat big your best in this run; start values without records', () => {
    const none = goalCandidates('ja', [], { depth: 5, name: 'ミセ' });
    expect(none.filter((c) => c.type === 'depth').map((c) => c.value)).toEqual([2, 3, 4]);
    expect(none.filter((c) => c.type === 'banked').map((c) => c.value)).toEqual([1500, 2500, 4000]);
    expect(none.filter((c) => c.type === 'milestone').map((c) => [c.value, c.within])).toEqual([[5, 3], [5, 2], [5, 1]]);
    const reps = [rep(1, { banked: 8821, deepest: 4, minPct: 40 }), rep(2, { banked: 2000, deepest: 5, minPct: 70, reason: 'lifeline' })];
    const c = goalCandidates('ja', reps, null);
    expect(c.filter((x) => x.type === 'depth').map((x) => x.value)).toEqual([5, 6, 7]);
    expect(c.filter((x) => x.type === 'banked').map((x) => x.value)).toEqual([8821, 9800, 11500]);
    // 余力は達成した遠征の「最も下がった HP」の最大（綱で帰った遠征は数えない）
    expect(c.filter((x) => x.type === 'margin').map((x) => x.value)).toEqual([40, 44, 52]);
    expect(c.some((x) => x.type === 'milestone')).toBe(false);
    expect(c.find((x) => x.type === 'banked' && x.value === 9800)!.text).toBe('1 回の遠征で確定 9800');
  });

  it('judging: depth counts any expedition in the window; banked and margin look at the next one; milestone at the cleared list', () => {
    const g = (type: GoalRecord['type'], value: number, within = 1): GoalRecord => ({ id: 1, player: 'p_1', type, value, within, fromNo: 3, best: 4, status: 'active' });
    expect(judgeGoal(g('depth', 6, 2), [rep(3, { deepest: 5 })], [])).toBe('active');
    expect(judgeGoal(g('depth', 6, 2), [rep(3, { deepest: 5 }), rep(4, { deepest: 6 })], [])).toBe('achieved');
    expect(judgeGoal(g('depth', 6, 2), [rep(3, { deepest: 5 }), rep(4, { deepest: 5 })], [])).toBe('missed');
    expect(judgeGoal(g('banked', 9000), [rep(3, { banked: 8999 })], [])).toBe('missed');
    expect(judgeGoal(g('banked', 9000), [rep(3, { banked: 9000 })], [])).toBe('achieved');
    expect(judgeGoal(g('margin', 40), [rep(3, { minPct: 60, reason: 'lifeline' })], [])).toBe('missed');
    expect(judgeGoal(g('margin', 40), [rep(3, { minPct: 41 })], [])).toBe('achieved');
    expect(judgeGoal(g('milestone', 5, 3), [rep(3)], [])).toBe('active');
    expect(judgeGoal(g('milestone', 5, 3), [rep(3), rep(4)], [5])).toBe('achieved');
    // 宣言より前の遠征は数えない
    expect(judgeGoal(g('depth', 6, 1), [rep(2, { deepest: 9 })], [])).toBe('active');
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
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const toDown = async () => { const f = world.floors[me().pos!.floor]; place(f.stairs.down[0].x, f.stairs.down[0].y); clearMonsters(); return act({ type: 'wait' }); };
  const descend = async () => { await toDown(); const s = await act({ type: 'stairs' }); clearMonsters(); return s; };
  return { manager, r, world, pid, me, act, toDown, descend };
}

describe('V3-7a goals in the session (§40.8)', () => {
  it('declare at camp; it shows at camp, during the expedition and on extract; the report and the record carry the result', async () => {
    const t = await newRun('v37a-flow-1', runsDir);
    expect((await t.descend()).ok).toBe(true);
    await t.toDown();
    expect((await t.act({ type: 'extract' })).ok).toBe(true);
    const camp = t.r.port.observe({ map: false });
    expect(camp.observation.camp?.goal?.lines[0]).toBe('目標: 未宣言（declare_goal で 1 つ選べる。点には影響しない）');
    expect(camp.text).toContain('目標の候補: 深さ 地下');
    // 自己最高（1 回目の確定）に並ぶ候補を宣言
    const best = t.r.port.goalInfo().candidates.find((c) => c.type === 'banked' && c.level === 'match')!;
    const d = t.r.port.declareGoal({ type: 'banked', value: best.value + 1, within: 1 });
    expect(d.text).toContain(`目標を宣言した: 1 回の遠征で確定 ${best.value + 1}（自己最高 ${best.value} +1）`);
    expect(t.r.port.observe({ map: false }).text).toContain(`目標: 1 回の遠征で確定 ${best.value + 1}`);
    // 遠征中: 目標の行と extract の差
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(t.r.port.declareGoal({ type: 'depth', value: 9, within: 1 }).text).toContain('キャンプで宣言する');
    const target = t.world.expeditions![1].objective.targetDepth!;
    while (t.world.floors[t.me().pos!.floor].depth < target) expect((await t.descend()).ok).toBe(true);
    await t.toDown();
    const obs = t.r.port.observe({ map: false });
    expect(obs.observation.expedition?.goal?.text).toMatch(/^目標: 1 回の遠征で確定 \d+（いま帰ると \d+。/);
    expect(obs.observation.valid_actions.some((a) => a.startsWith('extract') && a.includes('目標の確定'))).toBe(true);
    const end = await t.act({ type: 'extract', confirm: true });
    expect(end.ok).toBe(true);
    if (!end.ok) return;
    expect(end.report?.goal?.type).toBe('banked');
    expect(['achieved', 'missed']).toContain(end.report?.goal?.result);
    expect(t.r.port.formatActionText(end)).toContain('目標: 1 回の遠征で確定');
    const info = t.r.port.goalInfo();
    expect(info.active).toBeNull();
    expect(info.record.declared).toBe(1);
    expect(info.lines.some((l) => l.startsWith('目標の記録: 宣言 1・達成 '))).toBe(true);
    // 宣言し直しは取り下げ。復元しても同じ
    expect(t.r.port.declareGoal({ type: 'depth', value: 4, within: 2 }).text).toContain('目標を宣言した: 2 回の遠征のうちに地下4階に着く');
    expect(t.r.port.declareGoal({ type: 'depth', value: 5, within: 1 }).text).toContain('目標を宣言した: 次の遠征で地下5階に着く');
    const all = t.r.session.goalsOf(t.pid);
    expect(all.map((g) => g.status)).toEqual([end.report!.goal!.result, 'withdrawn', 'active']);
    const config = loadConfig({ runsDir, waitOthersMs: 100, keyframeEvery: 100 });
    const rec = RunSession.recover({ content, catalog: t.manager.catalog, config }, t.r.session.runId);
    expect(rec.session.goalsOf(t.pid).map((g) => [g.type, g.value, g.status])).toEqual(all.map((g) => [g.type, g.value, g.status]));
    rec.session.close();
    t.manager.closeAll();
  });

  it('a milestone goal must be the next uncleared milestone', async () => {
    const t = await newRun('v37a-ms-1');
    expect((await t.descend()).ok).toBe(true);
    await t.toDown();
    expect((await t.act({ type: 'extract' })).ok).toBe(true);
    const ms = t.r.port.goalInfo().candidates.filter((c) => c.type === 'milestone');
    expect(ms.map((c) => c.within)).toEqual([3, 2, 1]);
    expect(t.r.port.declareGoal({ type: 'milestone', value: ms[0].value + 5, within: 1 }).text).toContain('宣言できない');
    expect(t.r.port.declareGoal({ type: 'milestone', value: ms[0].value, within: 2 }).text).toContain(`目標を宣言した: 2 回の遠征のうちに地下${ms[0].value}階の大守護者を倒す`);
    t.manager.closeAll();
  });
});

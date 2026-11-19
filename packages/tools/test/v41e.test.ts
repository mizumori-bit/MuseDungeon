// V4-1e（IMPROVEMENTS_V4 §19）の確認（判断の表と返事役の見本）: 上げる段（escalate）、節目の大守護者（policy.warden）、
// 帰る順（階段が先、綱は着けないときだけ）、目的でない遺物・守護者の知らせはランを通して 1 回、pick_relics。
// pilot をサーバーにつないだ確かめ（空回りで止まる・記録が起動し直しても残る）は pilot.test.ts。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ObsMonster, Observation } from '@muse/shared';
import { decide, defaultOrders, homewardAction, newMemory, parseOrders } from '../src/index';
import type { DecideContext, PilotOrders, PilotState, WakeEvent } from '../src/index';
import { simpleResponder } from '../src/pilot/responder';
import { readOrders } from '../src/pilot/orders';

type Offer = NonNullable<Observation['camp']>['offers'][number];
const offer = (index: number, type: string, target_depth: number | null, over: Partial<Offer> = {}): Offer =>
  ({ index, type, target_depth, points: 100, text: `候補 ${index}（${type} 地下 ${target_depth} 階）`, multiplier_pct: 100, recommended_level: 6, level_gap: 1, trait_danger: 0, ...over } as Offer);
function campObs(offers: Offer[], milestone = { depth: 5, name: '石の番人', types: [], cleared: false, text: '次の節目: 地下5階の大守護者「石の番人」' }): Observation {
  return {
    status: 'at_camp', seq: 50, summary: 'キャンプ', alerts: [],
    self: { name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: 40, max_hp: 40, statuses: [], pos: null, floor: null, attack: { acc: 5, dmg: '1d6' }, defense: { eva: 0, armor: 0 }, recovery: [] },
    visible: { monsters: [], items: [], players: [], features: [] },
    navigation: { known_stairs: [], frontiers: [], collectable: { count: 0, ids: [] } },
    expedition: null,
    camp: { next_no: 7, offers, milestone },
  } as unknown as Observation;
}
function fieldObs(over: { depth?: number; monsters?: ObsMonster[]; stairs?: Observation['navigation']['known_stairs']; objective?: { type: string; target_depth: number | null }; status?: string; alerts?: Observation['alerts']; hp?: number; lifeline?: boolean; items?: Observation['visible']['items']; frontiers?: number } = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: over.alerts ?? [],
    self: { name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: over.hp ?? 40, max_hp: 40, statuses: [], pos: { x: 10, y: 10 }, floor: { depth: over.depth ?? 5 }, attack: { acc: 5, dmg: '1d6' }, defense: { eva: 0, armor: 0 }, recovery: [] },
    visible: { monsters: over.monsters ?? [], items: over.items ?? [], players: [], features: [] },
    navigation: { known_stairs: over.stairs ?? [], frontiers: Array.from({ length: over.frontiers ?? 1 }, () => ({ x: 1, y: 1 })), collectable: { count: 0, ids: [] } },
    expedition: {
      no: 6, objective: { type: over.objective?.type ?? 'slay_guardian', target_depth: over.objective?.target_depth ?? 5, text: '目的' }, progress: {}, status: over.status ?? 'in_progress', points: 0,
      can_extract: false, extract_outcome: 'withdraw', text: '遠征 6', milestone: { depth: 5, name: '石の番人', types: [], cleared: false, text: '次の節目: 地下5階の大守護者「石の番人」' },
      haul: { total: 300, multiplier_pct: 100, parts: {}, if_extract_now: 300, ...(over.lifeline ? { if_lifeline_now: 150 } : {}), next_overreach: null, next_camp: null, text: '戦利品 300（今帰れば 300）' },
    },
  } as unknown as Observation;
}
function mon(over: Partial<ObsMonster>): ObsMonster {
  return { id: 'e_aaaaaa', name: '敵', pos: { x: 14, y: 10 }, dir: 'e', dist: 4, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [], ...over } as ObsMonster;
}
const withPolicy = (p: Partial<PilotOrders['policy']>, mode: PilotOrders['mode'] = 'auto'): PilotOrders => { const o = defaultOrders(); return { ...o, mode, policy: { ...o.policy, ...p } }; };
const ctx = (orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext => ({ orders, coop: false, waiting: false, acked: new Set(), text: '', ...over });
const summary = (r: ReturnType<typeof decide>) => (r.decision.kind === 'wake' ? `${r.decision.wake.level}:${r.decision.wake.reason}:${r.decision.wake.key}` : r.decision.kind === 'act' ? `act:${r.decision.tool}:${JSON.stringify(r.decision.args)}` : r.decision.kind);
const warden = mon({ id: 'e_ward01', name: '石の番人', awareness: 'unaware', dist: 6, guardian: { name: '石の番人', types: [], warden: true }, role: 'guardian', objective: true });

describe('V4-1e policy defaults (§19)', () => {
  it('warden: escalate, stall_after: 3, pick_relics: false; mode: return parses', () => {
    const d = defaultOrders().policy;
    expect(d.warden).toBe('escalate');
    expect(d.stall_after).toBe(3);
    expect(d.pick_relics).toBe(false);
    expect(parseOrders({ rev: 1, mode: 'return' }).mode).toBe('return');
    expect(parseOrders({ rev: 1, policy: { warden: 'engage', pick_relics: true, stall_after: 0 } }).policy).toMatchObject({ warden: 'engage', pick_relics: true, stall_after: 0 });
    expect(parseOrders({ rev: 1, policy: { warden: 'x' } }).policy.warden).toBe('escalate');
  });
});

describe('V4-1e warden at camp (§19.2)', () => {
  const onlyWarden = [offer(1, 'slay_warden', 5, { scar: 2, rechallenge: { no: 4 } }), offer(2, 'reach_depth', 6), offer(3, 'slay_guardian', 7)];
  it('when only the warden or beyond-the-seal offers are left: escalates once with what the decision needs; never auto-starts them', () => {
    const o = campObs(onlyWarden);
    const r = decide(o, ctx(defaultOrders(), { wardenTries: { 5: 2 }, text: '所持品 (5/20、* は装備中): 投げ槍 x3' }));
    expect(summary(r)).toBe('escalate:warden_decision:warden_decision:5');
    if (r.decision.kind === 'wake') {
      const d = r.decision.wake.detail;
      expect(d).toContain('石の番人');
      expect(d).toContain('地下 5 階');
      expect(d).toContain('policy.warden を "engage"');
      expect(d).toContain('1. 候補 1');
      expect(d).toContain('（傷跡 2）（再挑戦）');
      expect(d).toContain('推奨レベル 6〜6');
      expect(d).toContain('レベル 5・HP 40/40・この大守護者に挑んだ遠征 2 回');
      expect(d).toContain('所持品 (5/20');
    }
    // 1 回上げた後（memory.json の鍵）・avoid: 大守護者の判断では上げない。候補が尽きたので空回りとして上げて止まる
    for (const c of [ctx(defaultOrders(), { once: new Set(['warden_decision:5']) }), ctx(withPolicy({ warden: 'avoid' }))]) {
      const r2 = decide(o, c);
      expect(summary(r2)).toBe('escalate:stalled:stalled:warden:7');
    }
    // 返事をもらった後は、キャンプで待つ（遠征を始めない）
    expect(decide(o, ctx(withPolicy({ warden: 'avoid' }), { acked: new Set(['stalled:warden:7']) })).decision.kind).toBe('idle');
    // 自動で出発する枠に大守護者の候補があっても、engage でなければ選ばない
    const auto = withPolicy({ warden: 'avoid' });
    auto.camp.auto_start = 'safe';
    const o2 = campObs([offer(1, 'slay_warden', 5, { slot: 'safe' } as Partial<Offer>), offer(2, 'slay_guardian', 4, { slot: 'standard' } as Partial<Offer>)]);
    expect(summary(decide(o2, ctx(auto)))).toBe('wake:camp:camp:7');
    // engage: 上げずに、いつもどおり（自動で出発するか、camp で起こす）
    const eng = withPolicy({ warden: 'engage' });
    eng.camp.auto_start = 'safe';
    expect(summary(decide(o2, ctx(eng)))).toBe('act:start_expedition:{"offer":1}');
    expect(summary(decide(o, ctx(withPolicy({ warden: 'engage' }))))).toBe('wake:camp:camp:7');
  });
  it('with other offers still open: no escalation (the camp wake as before)', () => {
    expect(summary(decide(campObs([offer(1, 'slay_warden', 5), offer(2, 'slay_guardian', 4)]), ctx()))).toBe('wake:camp:camp:7');
    // 節目を倒していれば、先の候補も大守護者に関わらない
    expect(summary(decide(campObs([offer(1, 'reach_depth', 7)], { depth: 5, name: '石の番人', types: [], cleared: true, text: '' }), ctx()))).toBe('wake:camp:camp:7');
  });
  it('sample responder never picks a warden or beyond-the-seal offer unless warden: engage; writes nothing when none is left', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41e-resp-'));
    const ordersPath = join(dir, 'orders.json');
    const state = (offers: { index: number; type: string; target_depth: number | null }[]) => ({ camp: { next_no: 7, offers, milestone: { depth: 5, name: '石の番人', cleared: false } }, hostiles: [], traps: [] } as unknown as PilotState);
    const ev = (st: PilotState, level: 'wake' | 'escalate' = 'wake', reason = 'camp'): WakeEvent => ({ level, reason, key: 'k', detail: '', state: st, statePath: join(dir, 'state.json'), ordersPath });
    writeFileSync(ordersPath, JSON.stringify(defaultOrders()));
    simpleResponder(ev(state([{ index: 1, type: 'slay_warden', target_depth: 5 }, { index: 2, type: 'reach_depth', target_depth: 6 }, { index: 3, type: 'slay_guardian', target_depth: 4 }])));
    expect(readOrders(ordersPath)!.queue).toEqual([{ tool: 'start_expedition', args: { offer: 3 } }]);
    const rev = readOrders(ordersPath)!.rev;
    simpleResponder(ev(state([{ index: 1, type: 'slay_warden', target_depth: 5 }, { index: 2, type: 'reach_depth', target_depth: 6 }])));
    expect(readOrders(ordersPath)!.rev).toBe(rev);
    // escalate には答えない（どの理由でも）
    for (const reason of ['warden_decision', 'stalled', 'safety', 'danger']) simpleResponder(ev(state([{ index: 3, type: 'slay_guardian', target_depth: 4 }]), 'escalate', reason));
    expect(readOrders(ordersPath)!.rev).toBe(rev);
    // engage なら大守護者の候補も選ぶ
    writeFileSync(ordersPath, JSON.stringify(withPolicy({ warden: 'engage' })));
    simpleResponder(ev(state([{ index: 1, type: 'slay_warden', target_depth: 5 }])));
    expect(readOrders(ordersPath)!.queue).toEqual([{ tool: 'start_expedition', args: { offer: 1 } }]);
  });
});

describe('V4-1e warden in the field (§19.2)', () => {
  it('a seen warden escalates once (warden_decision:<depth>); engage fights it without waking; escalate-after-asking and avoid never fight it', () => {
    const o = fieldObs({ monsters: [warden], objective: { type: 'slay_warden', target_depth: 5 } });
    expect(summary(decide(o, ctx()))).toBe('escalate:warden_decision:warden_decision:5');
    const e = decide(o, ctx(withPolicy({ warden: 'engage' })));
    expect(e.decision.kind === 'act' && e.decision.tool === 'fight' && e.decision.args.target).toBe('e_ward01');
    expect(e.notify.some((n) => n.level === 'wake' || n.level === 'escalate')).toBe(false);
    for (const c of [ctx(defaultOrders(), { once: new Set(['warden_decision:5']) }), ctx(withPolicy({ warden: 'avoid' }))]) {
      const r = decide(o, c);
      expect(r.decision.kind === 'act' && r.decision.tool === 'fight').toBe(false);
      expect(r.decision.kind === 'wake' && r.decision.wake.reason === 'warden_decision').toBe(false);
    }
  });
  it('the objective lies past a sealed stairs on this floor: escalates once; avoid heads home by the stairs', () => {
    const sealed = { type: 'down' as const, pos: { x: 12, y: 12 }, dist: 2, reachable: true, path_len: 2, sealed: true as const };
    const up = { type: 'up' as const, pos: { x: 4, y: 10 }, dist: 6, reachable: true, path_len: 6 };
    const o = fieldObs({ stairs: [sealed, up], objective: { type: 'reach_depth', target_depth: 7 } });
    expect(summary(decide(o, ctx()))).toBe('escalate:warden_decision:warden_decision:5');
    // 挑まない: 帰る（いちばん近い階段へ。綱は使わない）
    expect(summary(decide(o, ctx(withPolicy({ warden: 'avoid', allow_lifeline: true }, 'auto'), { once: new Set(['warden_decision:5']) })))).toBe('act:travel_to:{"to":"stairs_down"}');
  });
});

describe('V4-1e going home: stairs first, the lifeline only when the stairs cannot be reached (§19.4)', () => {
  const up = { type: 'up' as const, pos: { x: 4, y: 10 }, dist: 6, reachable: true, path_len: 6 };
  const chaser = mon({ id: 'e_foe001', dist: 3, worst_turn: 4 });
  const escape = (ok: boolean) => ({ code: 'escape', level: 'warn', text: ok ? '上り階段まで着ける' : '上り階段まで着けない', data: { stairs: 'up', worst_if_chased: ok ? 8 : 60, hp: 30 } }) as unknown as Observation['alerts'][number];
  it('objective done, HP low, chased, stairs reachable: walks to the stairs (never the lifeline, even with allow_lifeline)', () => {
    const p = withPolicy({ allow_lifeline: true });
    const o = fieldObs({ status: 'objective_complete', hp: 18, monsters: [chaser], stairs: [up], lifeline: true, alerts: [escape(true)] });
    const r = decide(o, ctx(p));
    expect(r.decision.kind === 'act' && r.decision.tool).toBe('travel_to');
    expect(r.decision.kind === 'act' && r.decision.args.to).toBe('stairs_up');
    // 追われていない・目的を果たした後: 階段へ
    const calm = fieldObs({ status: 'objective_complete', stairs: [up], lifeline: true });
    expect(summary(decide(calm, ctx(p)))).toBe('act:travel_to:{"to":"stairs_up"}');
    // 階段の上: 帰る（全額）
    const onIt = fieldObs({ status: 'objective_complete', stairs: [{ ...up, dist: 0, path_len: 0 }], lifeline: true, alerts: [{ code: 'on_stairs', level: 'info', text: '上り階段の上' } as never] });
    onIt.expedition!.can_extract = true; onIt.expedition!.extract_outcome = 'complete';
    expect(summary(decide(onIt, ctx(p)))).toBe('act:extract:{}');
  });
  it('mode: return and stop_at_camp use the same order; the lifeline only when chased and the stairs cannot be reached, with lifeline_used after it worked', () => {
    for (const mode of ['return', 'stop_at_camp'] as const) {
      const p = withPolicy({ allow_lifeline: true }, mode);
      // 着ける: 階段へ（以前の stop_at_camp は綱を先に使っていた）
      expect(summary(decide(fieldObs({ stairs: [up], lifeline: true }), ctx(p)))).toBe('act:travel_to:{"to":"stairs_up"}');
      // 追われていて着けない: 綱。使えたら理由と持ち帰っていない戦利品を知らせる
      const h = homewardAction(fieldObs({ stairs: [up], lifeline: true, monsters: [chaser], alerts: [escape(false)] }), p.policy, () => true);
      expect(h?.tool).toBe('use_item');
      expect(h?.why).toContain('着けない');
    }
    // decide の綱の手には done（lifeline_used）が付く。fight の行より後なので、追ってくる敵は相手にしない敵にしておく
    const p = withPolicy({ allow_lifeline: true }, 'return');
    const mem = newMemory(); mem.ignored = ['e_foe001'];
    const r = decide(fieldObs({ stairs: [up], lifeline: true, monsters: [chaser], alerts: [escape(false)] }), ctx(p, { mem }));
    expect(r.decision.kind === 'act' && r.decision.tool).toBe('use_item');
    if (r.decision.kind === 'act') {
      expect(r.decision.done?.reason).toBe('lifeline_used');
      expect(r.decision.done?.level).toBe('notify');
      expect(r.decision.done?.detail).toContain('持ち帰っていない戦利品: 戦利品 300');
    }
    // allow_lifeline: false なら綱は使わず、それでも階段へ向かう
    const r2 = decide(fieldObs({ stairs: [up], lifeline: true, monsters: [chaser], alerts: [escape(false)] }), ctx(withPolicy({}, 'return'), { mem }));
    expect(r2.decision.kind === 'act' && r2.decision.tool).toBe('travel_to');
  });
  it('sample responder goes home with mode: return (no lifeline in the queue)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41e-home-'));
    const ordersPath = join(dir, 'orders.json');
    writeFileSync(ordersPath, JSON.stringify(defaultOrders()));
    for (const reason of ['danger', 'nothing_to_do', 'stuck', 'gave_up']) {
      simpleResponder({ level: 'wake', reason, key: 'k', detail: '', state: { hostiles: [], traps: [] } as unknown as PilotState, statePath: join(dir, 'state.json'), ordersPath });
      const o = readOrders(ordersPath)!;
      expect(o.mode).toBe('return');
      expect(o.queue).toEqual([]);
      expect(o.policy.allow_lifeline).toBe(true);
    }
  });
});

describe('V4-1e relics and role enemies told once per run; pick_relics (§19.5)', () => {
  const relic = { id: 'e_relic7', name: '狩人の欠片', pos: { x: 12, y: 10 }, dir: 'e', dist: 2, qty: 1, role: 'relic' } as Observation['visible']['items'][number];
  it('a non-objective relic is told once with its position and how to pick it up; the run-wide record keeps it quiet on later floors', () => {
    const o = fieldObs({ items: [relic] });
    const r = decide(o, ctx());
    const n = r.notify.find((x) => x.reason === 'relic_seen')!;
    expect(n.level).toBe('notify');
    expect(n.key).toBe('relic_seen:e_relic7');
    expect(n.detail).toContain('(12,10)');
    expect(n.detail).toContain('pick_relics');
    expect(decide(o, ctx(defaultOrders(), { once: new Set(['relic_seen:e_relic7']) })).notify.some((x) => x.reason === 'relic_seen')).toBe(false);
    // 目的でない守護者も個体ごとに 1 回
    const g = mon({ id: 'e_grd009', role: 'guardian', guardian: { name: '別', types: [] }, awareness: 'unaware' });
    expect(decide(fieldObs({ monsters: [g] }), ctx()).notify.map((x) => x.key)).toContain('seen:e_grd009');
    expect(decide(fieldObs({ monsters: [{ ...g, awareness: 'hunting' }] }), ctx(defaultOrders(), { once: new Set(['seen:e_grd009']) })).notify.map((x) => x.key)).not.toContain('seen:e_grd009');
  });
  it('pick_relics: walks to a non-objective relic when no chaser is in view (relic: id on the decision); not while chased; not by default', () => {
    const p = withPolicy({ pick_relics: true });
    const r = decide(fieldObs({ items: [relic] }), ctx(p));
    expect(r.decision.kind === 'act' && `${r.decision.tool}:${JSON.stringify(r.decision.args)}:${r.decision.relic}`).toBe('travel_to:{"to":"e_relic7"}:e_relic7');
    const chased = decide(fieldObs({ items: [relic], monsters: [mon({ id: 'e_foe001', dist: 3 })] }), ctx(p));
    expect(chased.decision.kind === 'act' && chased.decision.relic).toBeFalsy();
    expect(decide(fieldObs({ items: [relic] }), ctx()).decision.kind === 'act' && (decide(fieldObs({ items: [relic] }), ctx()).decision as { relic?: string }).relic).toBeFalsy();
    // 拾えなかった遺物には、この階ではもう行かない
    const mem = newMemory(); mem.relicFailed = ['e_relic7'];
    expect((decide(fieldObs({ items: [relic] }), ctx(p, { mem })).decision as { relic?: string }).relic).toBeUndefined();
  });
});

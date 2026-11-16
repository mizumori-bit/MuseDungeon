// V3-2R・V3-2R2 の計測（IMPROVEMENTS_V3 §14.6 の 1・2、§18.8）。bot の方針比較は合格の根拠にしない。
// 1. 1 回ごとの判断: 踏破 1 階あたりの「綱か死」で終わる率、踏破の期待値 ÷ 即帰還の期待値（綱の 50% を含む）、
//    深度ごとのレベル − 推奨レベル、枠ごとの達成率
// 2. 呼び出しの予算: 0 歩のマクロ、5 歩未満で止まった移動マクロの割合、撃破 1 体あたり・アイテム 1 個あたりの呼び出し、
//    最初の遠征の呼び出し、斥候の bot の呼び出しに投擲が占める割合
import type { PlayerPort, SessionManager } from '@muse/server';
import type { Command, OfferSlot } from '@muse/shared';
import { buildObservation, recommendedLevel } from '@muse/shared';
import { playWithPort } from './bot';

export interface BudgetReport {
  runs: number;
  calls: {
    total: number; macroCalls: number; zeroStep: number;
    /** 5 歩未満で止まった移動マクロ（explore / travel / collect）の割合（%） */
    shortMovePct: number;
    /** 撃破 1 体に使った呼び出しの中央値 */
    callsPerKillMedian: number;
    /** アイテム 1 個を拾うのに使った呼び出しの平均（pickup と、アイテムへの travel） */
    callsPerPickup: number;
    /** 最初の遠征を帰還まで終えた呼び出しの中央値（達成したランのみ） */
    firstExpeditionCallsMedian: number | null;
    firstExpeditionCompleted: number;
    /** 遠征の終わり（帰還・死亡）に残っていた回復の薬の数の中央値 */
    healingLeftMedian: number;
    /** 敵へ近づく travel（含めない。参考に回数と 5 歩未満の割合） */
    approachCalls: number; approachShortPct: number;
    /** 5 歩未満で止まった移動マクロの内訳（コマンド:停止理由 → 回数） */
    shortBreakdown: Record<string, number>;
    /** 拾うための呼び出しの内訳 */
    pickupBreakdown: Record<string, number>;
  };
  /** 踏破 n 階目の試みと、綱・死で終わった数（ratePct は綱か死の率） */
  crossing: { floor: number; attempts: number; deaths: number; lifelines: number; ratePct: number }[];
  /** 枠ごとの達成率（その枠だけを選ぶ bot。遠征の数・達成・死亡・綱・撤退） */
  slots: { slot: OfferSlot; expeditions: number; completed: number; died: number; lifeline: number; withdrawn: number; ratePct: number }[];
  /** 斥候の bot: 呼び出しのうち投擲（throw と fight with）の割合 */
  scoutThrows: { calls: number; throws: number; pct: number };
  ev: { decisions: number; meanStake: number; meanOutcome: number; ratio: number };
  levels: { depth: number; n: number; median: number; recommended: number }[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

interface Tracker {
  calls: number; macroCalls: number; zeroStep: number; moveMacros: number; shortMoves: number;
  callsOnTarget: Map<string, number>; pickupCalls: number; shortBy: Record<string, number>; pickupBy: Record<string, number>;
  /** 敵へ近づく travel（短いのが自然なので別に数える） */
  approach: number; shortApproach: number;
  policy: number;
  firstExpCalls: number | null; firstExpDone: boolean;
  levelAt: Map<number, number>;
  // 踏破
  crossing: { floor: number; done: boolean; died: boolean; lifeline: boolean }[];
  /** 投擲の呼び出し（throw と fight with） */
  throws: number;
  // 期待値
  decisions: { stake: number; outcome: number | null; banked0: number }[];
}

/** 呼び出しを数える PlayerPort の代理（bot の判断には手を出さない） */
function instrument(port: PlayerPort, tr: Tracker): PlayerPort {
  return new Proxy(port, {
    get(target, prop) {
      if (prop === 'act') {
        return async (cmd: Command, meta: { source: 'bot' }) => {
          const v = target.view();
          tr.calls++;
          // 対象: fight / 敵への travel / 投擲 / 体当たり
          let tgt: string | null = null;
          if (cmd.type === 'fight') tgt = cmd.target;
          else if (cmd.type === 'throw' && typeof cmd.target === 'string' && cmd.target.startsWith('e_')) tgt = cmd.target;
          else if (cmd.type === 'travel' && typeof cmd.to === 'string' && v.entities.some((e) => e.id === cmd.to && e.cat === 'monster')) tgt = cmd.to;
          else if (cmd.type === 'move' && v.self.pos) {
            const d = { n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0], nw: [-1, -1] }[cmd.dir];
            const m = v.entities.find((e) => e.cat === 'monster' && e.pos.x === v.self.pos!.x + d[0] && e.pos.y === v.self.pos!.y + d[1]);
            if (m) tgt = m.id;
          }
          if (tgt) tr.callsOnTarget.set(tgt, (tr.callsOnTarget.get(tgt) ?? 0) + 1);
          if (cmd.type === 'throw' || (cmd.type === 'fight' && cmd.with)) tr.throws++;
          if (cmd.type === 'pickup' || (cmd.type === 'travel' && typeof cmd.to === 'string' && (v.entities.some((e) => e.id === cmd.to && e.cat === 'item') || v.memory.remembered.some((r) => r.id === cmd.to && r.cat === 'item')))) {
            tr.pickupCalls++;
            const k = cmd.type === 'pickup' ? `pickup${cmd.item ? '(id)' : ''}` : 'travel(item)';
            tr.pickupBy[k] = (tr.pickupBy[k] ?? 0) + 1;
          }
          // 踏破の判断: 目的達成後に階段の上で extract せずに下る
          const x = v.expedition && v.expedition.status !== 'ended' ? v.expedition : null;
          if (cmd.type === 'stairs' && x?.status === 'objective_complete' && x.objective.targetDepth !== null && v.floor && v.floor.depth >= x.objective.targetDepth
            && x.crossedDepth < v.floor.depth + 1 && v.floor.depth === Math.max(x.objective.targetDepth, x.crossedDepth)) {
            const o = buildObservation(v, target.catalog, { detail: 'brief', map: false });
            if (o.expedition?.can_extract && v.floor.depth === x.objective.targetDepth) tr.decisions.push({ stake: o.expedition.haul!.if_extract_now, outcome: null, banked0: v.record.banked });
          }
          const before = v;
          const out = await target.act(cmd, meta);
          const after = target.view();
          if (out.ok && out.steps !== undefined) {
            tr.macroCalls++;
            if (out.steps === 0) tr.zeroStep++;
            const toMonster = cmd.type === 'travel' && typeof cmd.to === 'string' && v.entities.some((e) => e.id === cmd.to && e.cat === 'monster');
            if (toMonster) { tr.approach++; if (out.steps < 5) tr.shortApproach++; }
            else if (cmd.type === 'explore' || cmd.type === 'travel' || cmd.type === 'collect') {
              tr.moveMacros++;
              if (out.steps < 5) {
                tr.shortMoves++;
                const k = `${cmd.type}${cmd.type === 'travel' ? (typeof cmd.to === 'string' ? (cmd.to.startsWith('e_') ? '(entity)' : `(${cmd.to})`) : '(pos)') : ''}:${out.interrupted_by}`;
                tr.shortBy[k] = (tr.shortBy[k] ?? 0) + 1;
              }
            }
          }
          // 深度ごとのレベル（初めて着いたとき）
          if (after.floor && !tr.levelAt.has(after.floor.depth)) tr.levelAt.set(after.floor.depth, after.self.level);
          // 最初の遠征の呼び出し
          const ax = after.expedition;
          if (!tr.firstExpDone && ax && ax.no === 1 && ax.status === 'ended') {
            tr.firstExpDone = true;
            if (ax.endReason === 'completed') tr.firstExpCalls = tr.calls;
          }
          // 踏破の試み（目的達成後に目標より深い階へ着いた）と、その結果
          const bx = before.expedition && before.expedition.status !== 'ended' ? before.expedition : null;
          if (bx && bx.status === 'objective_complete' && bx.objective.targetDepth !== null && after.floor && before.floor && after.floor.depth > before.floor.depth && after.floor.depth > bx.objective.targetDepth) {
            tr.crossing.push({ floor: after.floor.depth - bx.objective.targetDepth, done: false, died: false, lifeline: false });
          }
          const open = tr.crossing.find((c) => !c.done && !c.died && !c.lifeline);
          if (open && ax && ax.objective.targetDepth !== null) {
            if (ax.crossedDepth >= ax.objective.targetDepth + open.floor) open.done = true;
            else if (after.status === 'dead') open.died = true;
            else if ((after.status === 'at_camp' || ax.status === 'ended') && ax.endReason === 'lifeline') open.lifeline = true;
            else if (after.status === 'at_camp' || ax.status === 'ended') open.done = true; // 途中で帰った（試みとしては生還）
          }
          // 期待値の結果: 最初の踏破を終えた時点の今帰れば、死亡なら 0、途中で帰ったなら実際の確定点
          const dec = tr.decisions.find((d) => d.outcome === null);
          if (dec && ax && ax.objective.targetDepth !== null) {
            if (after.status === 'dead') dec.outcome = 0;
            else if (ax.crossedDepth >= ax.objective.targetDepth + 1) {
              const o = buildObservation(after, target.catalog, { detail: 'brief', map: false });
              dec.outcome = o.expedition?.haul?.if_extract_now ?? 0;
            } else if (after.status === 'at_camp') dec.outcome = after.record.banked - dec.banked0;
          }
          return out;
        };
      }
      const val = Reflect.get(target, prop, target) as unknown;
      return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
    },
  });
}

function newTracker(policy: number): Tracker {
  return {
    calls: 0, macroCalls: 0, zeroStep: 0, moveMacros: 0, shortMoves: 0, callsOnTarget: new Map(), pickupCalls: 0, shortBy: {}, pickupBy: {},
    approach: 0, shortApproach: 0, policy,
    firstExpCalls: null, firstExpDone: false, levelAt: new Map(), crossing: [], decisions: [], throws: 0,
  };
}

export async function budgetReport(manager: SessionManager, opts: { runs: number; maxActs: number; seed: string; log?: (s: string) => void }): Promise<BudgetReport> {
  const trackers: Tracker[] = [];
  const killsPer: number[] = [];
  const healingLeft: number[] = [];
  const closeAll = () => { for (const [id, s] of manager.sessions) { s.close(); manager.sessions.delete(id); } };
  // 即帰還（呼び出しの予算・最初の遠征）と、踏破に身を入れる方針（途中で引き返さない。踏破の死亡率と期待値）
  const policies: { overreach: number; offerSlot: OfferSlot; cautious: boolean }[] = [
    { overreach: 0, offerSlot: 'standard', cautious: true }, { overreach: 3, offerSlot: 'standard', cautious: false },
  ];
  for (const pol of policies) {
    for (let i = 0; i < opts.runs; i++) {
      const seed = `${opts.seed}-${pol.overreach}-${i}`;
      const r = await manager.createRun({ name: 'budget', seed, controller: { kind: 'agent', label: 'budget' } });
      if ('error' in r) throw new Error(r.error.message);
      const tr = newTracker(pol.overreach);
      await playWithPort(instrument(r.port, tr), { kind: 'greedy', seed, maxActs: opts.maxActs, ...pol });
      // 撃破に使った呼び出し・拾った数・残った回復の薬
      const pid = r.port.playerId;
      const meId = r.session.world.players[pid].entityId;
      for (const e of r.session.history) {
        if (e.type === 'died' && e.killer === meId && tr.callsOnTarget.has(e.id)) killsPer.push(tr.callsOnTarget.get(e.id)!);
      }
      const picked = r.session.history.filter((e) => e.type === 'item_picked_up' && e.actor === meId && !e.auto).length;
      (tr as Tracker & { picked?: number }).picked = picked;
      const me = r.session.world.entities[meId];
      healingLeft.push((me?.inv?.items ?? []).map((id) => r.session.world.entities[id]).filter((it) => it?.kind === 'core:potion_healing').reduce((a, it) => a + (it!.item?.qty ?? 0), 0));
      trackers.push(tr);
      closeAll();
      opts.log?.(`policy overreach=${pol.overreach} run ${i}: calls ${tr.calls}, crossings ${tr.crossing.length}`);
    }
  }
  // 枠ごとの達成率: その枠だけを選び、踏破せずに帰る bot（推奨レベルどおりに育つ）
  const slots: BudgetReport['slots'] = [];
  for (const slot of ['safe', 'standard', 'ambitious'] as OfferSlot[]) {
    let expeditions = 0, completed = 0, died = 0, lifeline = 0, withdrawn = 0;
    for (let i = 0; i < opts.runs; i++) {
      const seed = `${opts.seed}-slot-${slot}-${i}`;
      const r = await manager.createRun({ name: 'budget', seed, controller: { kind: 'agent', label: 'budget' } });
      if ('error' in r) throw new Error(r.error.message);
      await playWithPort(r.port, { kind: 'greedy', seed, maxActs: Math.max(opts.maxActs, 900), overreach: 0, offerSlot: slot, cautious: true, maxExpeditions: 4 });
      // その枠の遠征だけを数える（候補が足りず別の枠を選んだ遠征は除く）
      for (const x of r.session.world.expeditions ?? []) {
        if (!x.endReason || x.slot !== slot) continue;
        expeditions++;
        if (x.endReason === 'completed') completed++;
        else if (x.endReason === 'died') died++;
        else if (x.endReason === 'lifeline') lifeline++;
        else if (x.endReason === 'withdrawn') withdrawn++;
      }
      closeAll();
    }
    slots.push({ slot, expeditions, completed, died, lifeline, withdrawn, ratePct: expeditions ? Math.round((completed * 1000) / expeditions) / 10 : 0 });
    opts.log?.(`slot ${slot}: ${completed}/${expeditions}`);
  }
  // 斥候の bot の投擲の割合
  let scoutCalls = 0, scoutThrows = 0;
  for (let i = 0; i < opts.runs; i++) {
    const seed = `${opts.seed}-scout-${i}`;
    const r = await manager.createRun({ name: 'budget', classId: 'core:scout', seed, controller: { kind: 'agent', label: 'budget' } });
    if ('error' in r) throw new Error(r.error.message);
    const tr = newTracker(0);
    await playWithPort(instrument(r.port, tr), { kind: 'greedy', seed, maxActs: opts.maxActs, overreach: 0, offerSlot: 'standard', cautious: true });
    scoutCalls += tr.calls;
    scoutThrows += tr.throws;
    closeAll();
  }
  const all = (f: (t: Tracker) => number) => trackers.reduce((a, t) => a + f(t), 0);
  const picked = trackers.reduce((a, t) => a + ((t as Tracker & { picked?: number }).picked ?? 0), 0);
  // 最初の遠征の呼び出しは即帰還の方針だけで数える
  const firsts = trackers.filter((t) => t.policy === 0).map((t) => t.firstExpCalls).filter((x): x is number => x !== null);
  const crossing: BudgetReport['crossing'] = [];
  for (const k of [1, 2, 3]) {
    const cs = trackers.flatMap((t) => t.crossing.filter((c) => c.floor === k));
    const deaths = cs.filter((c) => c.died).length;
    const lifelines = cs.filter((c) => c.lifeline).length;
    crossing.push({ floor: k, attempts: cs.length, deaths, lifelines, ratePct: cs.length ? Math.round(((deaths + lifelines) * 1000) / cs.length) / 10 : 0 });
  }
  const decs = trackers.flatMap((t) => t.decisions.filter((d) => d.outcome !== null));
  const meanStake = decs.length ? decs.reduce((a, d) => a + d.stake, 0) / decs.length : 0;
  const meanOutcome = decs.length ? decs.reduce((a, d) => a + (d.outcome ?? 0), 0) / decs.length : 0;
  const levels: BudgetReport['levels'] = [];
  const maxD = Math.max(0, ...trackers.flatMap((t) => [...t.levelAt.keys()]));
  for (let d = 1; d <= maxD; d++) {
    const ls = trackers.map((t) => t.levelAt.get(d)).filter((x): x is number => x !== undefined);
    if (ls.length >= 3) levels.push({ depth: d, n: ls.length, median: median(ls), recommended: recommendedLevel(manager.catalog.rules, d) });
  }
  return {
    runs: trackers.length,
    calls: {
      total: all((t) => t.calls), macroCalls: all((t) => t.macroCalls), zeroStep: all((t) => t.zeroStep),
      shortMovePct: Math.round((all((t) => t.shortMoves) * 1000) / Math.max(1, all((t) => t.moveMacros))) / 10,
      callsPerKillMedian: median(killsPer),
      approachCalls: all((t) => t.approach), approachShortPct: Math.round((all((t) => t.shortApproach) * 1000) / Math.max(1, all((t) => t.approach))) / 10,
      callsPerPickup: Math.round((all((t) => t.pickupCalls) * 100) / Math.max(1, picked)) / 100,
      firstExpeditionCallsMedian: firsts.length ? median(firsts) : null,
      firstExpeditionCompleted: firsts.length,
      healingLeftMedian: median(healingLeft),
      shortBreakdown: trackers.reduce((acc, t) => { for (const [k, n] of Object.entries(t.shortBy)) acc[k] = (acc[k] ?? 0) + n; return acc; }, {} as Record<string, number>),
      pickupBreakdown: trackers.reduce((acc, t) => { for (const [k, n] of Object.entries(t.pickupBy)) acc[k] = (acc[k] ?? 0) + n; return acc; }, {} as Record<string, number>),
    },
    crossing,
    slots,
    scoutThrows: { calls: scoutCalls, throws: scoutThrows, pct: scoutCalls ? Math.round((scoutThrows * 1000) / scoutCalls) / 10 : 0 },
    ev: { decisions: decs.length, meanStake: Math.round(meanStake), meanOutcome: Math.round(meanOutcome), ratio: meanStake ? Math.round((meanOutcome / meanStake) * 100) / 100 : 0 },
    levels,
  };
}

export function formatBudget(r: BudgetReport): string {
  const c = r.calls;
  const ok = (b: boolean) => (b ? 'OK' : '目安外');
  const lines = [
    `ラン ${r.runs}（即帰還 / 3 階まで踏破（途中で引き返さない）の 2 方針。最初の遠征の呼び出しは即帰還の方針で数える）。ほかに枠ごと・斥候の bot`,
    '',
    '## 1. 1 回ごとの判断',
    '| 踏破する階 | 試み | 死亡 | 綱 | 綱か死の率 |',
    '|---|---|---|---|---|',
    ...r.crossing.map((x) => `| ${x.floor} 階目 | ${x.attempts} | ${x.deaths} | ${x.lifelines} | ${x.ratePct}% |`),
    `踏破 1 階目が綱か死で終わる率 ${r.crossing[0]?.ratePct ?? 0}%（目安 10〜25%）: ${ok((r.crossing[0]?.ratePct ?? 0) >= 10 && (r.crossing[0]?.ratePct ?? 0) <= 25)}`,
    '| 枠 | 遠征 | 達成 | 死亡 | 綱 | 撤退 | 達成率 | 目安 |',
    '|---|---|---|---|---|---|---|---|',
    ...r.slots.map((s) => {
      const [lo, hi] = s.slot === 'safe' ? [90, 100] : s.slot === 'standard' ? [60, 85] : [30, 60];
      return `| ${s.slot} | ${s.expeditions} | ${s.completed} | ${s.died} | ${s.lifeline} | ${s.withdrawn} | ${s.ratePct}% | ${lo}〜${hi}%: ${ok(s.ratePct >= lo && s.ratePct <= hi)} |`;
    }),
    `踏破の期待値 ÷ 即帰還の期待値 = ${r.ev.ratio}（判断 ${r.ev.decisions} 回、賭け金の平均 ${r.ev.meanStake}、結果の平均 ${r.ev.meanOutcome}。目安 0.9〜1.3）: ${ok(r.ev.ratio >= 0.9 && r.ev.ratio <= 1.3)}`,
    '| 深度 | 着いた数 | レベルの中央値 | 推奨 | 差 |',
    '|---|---|---|---|---|',
    ...r.levels.map((l) => `| ${l.depth} | ${l.n} | ${l.median} | ${l.recommended} | ${l.median - l.recommended >= 0 ? '+' : ''}${l.median - l.recommended} |`),
    `深度ごとのレベル − 推奨（目安 ±1）: ${ok(r.levels.every((l) => Math.abs(l.median - l.recommended) <= 1))}`,
    '',
    '## 2. 呼び出しの予算',
    `| 測るもの | 値 | 目安 |`,
    '|---|---|---|',
    `| 0 歩で終わったマクロの呼び出し | ${c.zeroStep}（マクロ ${c.macroCalls} 回中） | 0: ${ok(c.zeroStep === 0)} |`,
    `| 5 歩未満で止まった移動マクロの割合（敵へ近づく travel を除く） | ${c.shortMovePct}% | 20% 以下: ${ok(c.shortMovePct <= 20)} |`,
    `| （参考）敵へ近づく travel | ${c.approachCalls} 回、5 歩未満 ${c.approachShortPct}% | - |`,
    `| 敵 1 体を倒すのに使った呼び出しの中央値 | ${c.callsPerKillMedian} | 3 以下: ${ok(c.callsPerKillMedian <= 3)} |`,
    `| アイテム 1 個を拾うのに使った呼び出し | ${c.callsPerPickup} | 0.5 以下: ${ok(c.callsPerPickup <= 0.5)} |`,
    `| 最初の遠征を帰還まで終える呼び出しの中央値 | ${c.firstExpeditionCallsMedian ?? '-'}（達成 ${c.firstExpeditionCompleted} ラン） | 60 以下: ${ok((c.firstExpeditionCallsMedian ?? 999) <= 60)} |`,
    `| 遠征の終わりに残った回復の薬（中央値） | ${c.healingLeftMedian} | 参考 |`,
    `| 斥候の bot の呼び出しに投擲が占める割合 | ${r.scoutThrows.pct}%（${r.scoutThrows.throws}/${r.scoutThrows.calls}） | 30% 以下: ${ok(r.scoutThrows.pct <= 30)} |`,
    '',
    `5 歩未満の内訳: ${Object.entries(c.shortBreakdown).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `拾うための呼び出しの内訳: ${Object.entries(c.pickupBreakdown).map(([k, n]) => `${k} ${n}`).join(', ') || 'なし'}`,
  ];
  return lines.join('\n');
}

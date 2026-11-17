// 目標の宣言（IMPROVEMENTS_V3 §40.8・IDEAS §2.1。V3-7a）: キャンプで任意に 1 つ宣言する。点・経験値・戦利品には影響しない。
// World の外（遠征レポートと同じ層）に置く。候補は本人の遠征レポートの値だけから作る（他人・未探索・シードは入らない）。
import type { ExpeditionReport } from './expeditionStats';
import type { Locale, PlayerId } from './types';
import { t } from './util';

export type GoalType = 'depth' | 'banked' | 'milestone' | 'margin';
export const GOAL_TYPES: readonly GoalType[] = ['depth', 'banked', 'milestone', 'margin'];

/** 宣言の中身。within: 期限（遠征の数。深さと節目は 1〜3、確定点と余力は 1） */
export interface GoalDecl { type: GoalType; value: number; within: number }

export type GoalStatus = 'active' | 'achieved' | 'missed' | 'withdrawn';

export interface GoalRecord extends GoalDecl {
  id: number;
  player: PlayerId;
  /** 最初に数える遠征の番号（宣言したときの次の遠征） */
  fromNo: number;
  /** 宣言したときの自己最高（記録が無ければ null） */
  best: number | null;
  status: GoalStatus;
  /** 決着した遠征（取り下げなら、取り下げたときの次の遠征の前） */
  endedNo?: number;
}

/** 候補（遠征の枠と同じ 3 つの形）: 自己最高に並ぶ／少し超える／大きく超える。記録が無ければ初期値 */
export interface GoalCandidate extends GoalDecl { level: 'match' | 'beat' | 'beat_big' | 'start'; text: string }

/** キャンプと expedition に渡す目標の情報（AI にも人間にも同じもの） */
export interface GoalInfo {
  active: GoalRecord | null;
  candidates: GoalCandidate[];
  record: { declared: number; achieved: number };
  /** キャンプの観測に出す文（1 行。V3-3c §44.5） */
  lines: string[];
  /** 候補と記録を含む文（3 行以内。declare_goal を引数なしで呼ぶと出る・expedition・人間の画面） */
  full?: string[];
}

const START: Record<GoalType, [number, number, number]> = { depth: [2, 3, 4], banked: [1500, 2500, 4000], margin: [30, 40, 50], milestone: [3, 2, 1] };
const LEVELS = ['match', 'beat', 'beat_big'] as const;

/** 自己最高（遠征レポートから）。余力は達成した遠征の「最も下がった HP」の最大 */
export function goalBest(type: GoalType, reports: readonly ExpeditionReport[]): number | null {
  const ended = reports.filter((r) => r.status === 'ended');
  if (type === 'depth') return ended.length ? Math.max(...ended.map((r) => r.tempo.deepest)) : null;
  if (type === 'banked') { const v = ended.map((r) => r.payout?.banked ?? 0); return v.length && Math.max(...v) > 0 ? Math.max(...v) : null; }
  if (type === 'margin') { const v = ended.filter((r) => r.reason === 'completed').map((r) => r.combat.min_hp_pct ?? 0); return v.length ? Math.max(...v) : null; }
  return null;
}

const roundUp = (v: number, step: number) => Math.ceil(v / step) * step;

/** 候補を作る。milestone: 次の節目（未踏破）があるときだけ */
export function goalCandidates(L: Locale, reports: readonly ExpeditionReport[], nextMilestone: { depth: number; name: string } | null): GoalCandidate[] {
  const out: GoalCandidate[] = [];
  for (const type of GOAL_TYPES) {
    if (type === 'milestone') {
      if (!nextMilestone) continue;
      START.milestone.forEach((within, i) => out.push({ type, value: nextMilestone.depth, within, level: LEVELS[i], text: goalText(L, { type, value: nextMilestone.depth, within }) }));
      continue;
    }
    const best = goalBest(type, reports);
    const values = best === null || best <= 0
      ? START[type]
      : type === 'depth' ? [best, best + 1, best + 2]
        : type === 'banked' ? [best, roundUp(best * 1.1, 100), roundUp(best * 1.3, 100)]
          : [best, Math.min(100, Math.round(best * 1.1)), Math.min(100, Math.round(best * 1.3))];
    values.forEach((value, i) => {
      const level = best === null || best <= 0 ? 'start' : LEVELS[i];
      out.push({ type, value, within: 1, level, text: goalText(L, { type, value, within: 1 }) });
    });
  }
  return out;
}

/** 目標の文（「1 回の遠征で確定 9700」） */
export function goalText(L: Locale, g: GoalDecl): string {
  switch (g.type) {
    case 'depth': return g.within > 1 ? t(L, `${g.within} 回の遠征のうちに地下${g.value}階に着く`, `reach depth ${g.value} within ${g.within} expeditions`) : t(L, `次の遠征で地下${g.value}階に着く`, `reach depth ${g.value} next expedition`);
    case 'banked': return t(L, `1 回の遠征で確定 ${g.value}`, `bank ${g.value} in one expedition`);
    case 'milestone': return g.within > 1 ? t(L, `${g.within} 回の遠征のうちに地下${g.value}階の大守護者を倒す`, `slay the depth-${g.value} warden within ${g.within} expeditions`) : t(L, `次の遠征で地下${g.value}階の大守護者を倒す`, `slay the depth-${g.value} warden next expedition`);
    case 'margin': return t(L, `最も下がった HP を最大の ${g.value}% 以上に保って達成する`, `complete an expedition without dropping below ${g.value}% HP`);
  }
}

const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/** 宣言を確かめて、記録を作る（キャンプで。範囲の外は理由を返す） */
export function makeGoal(decl: GoalDecl, ctx: { id: number; player: PlayerId; fromNo: number; reports: readonly ExpeditionReport[]; nextMilestone: { depth: number } | null }): GoalRecord | { error: string } {
  if (!GOAL_TYPES.includes(decl.type)) return { error: 'unknown goal type' };
  if (!Number.isInteger(decl.value) || decl.value <= 0) return { error: 'value must be a positive integer' };
  const within = decl.type === 'depth' || decl.type === 'milestone' ? decl.within : 1;
  if (!Number.isInteger(within) || within < 1 || within > 3) return { error: 'within must be 1..3' };
  if (decl.type === 'milestone' && (!ctx.nextMilestone || decl.value !== ctx.nextMilestone.depth)) return { error: 'the milestone goal is the next uncleared milestone' };
  if (decl.type === 'margin' && decl.value > 100) return { error: 'margin is a percentage (1..100)' };
  const best = goalBest(decl.type, ctx.reports);
  return { id: ctx.id, player: ctx.player, type: decl.type, value: decl.value, within, fromNo: ctx.fromNo, best, status: 'active' };
}

/**
 * 終わった遠征 1 回ごとに判定する（V3-7a）。reports: 宣言の後に終わった、この目標の範囲の遠征（古い順）。
 * milestonesCleared: いまの踏破済みの節目
 */
export function judgeGoal(g: GoalRecord, reports: readonly ExpeditionReport[], milestonesCleared: readonly number[]): GoalStatus {
  if (g.status !== 'active') return g.status;
  const inRange = reports.filter((r) => r.status === 'ended' && r.no >= g.fromNo);
  if (!inRange.length) return 'active';
  const last = inRange[inRange.length - 1];
  let ok = false;
  if (g.type === 'depth') ok = inRange.some((r) => r.tempo.deepest >= g.value);
  else if (g.type === 'banked') ok = (last.payout?.banked ?? 0) >= g.value;
  else if (g.type === 'margin') ok = last.reason === 'completed' && (last.combat.min_hp_pct ?? 0) >= g.value;
  else ok = milestonesCleared.includes(g.value);
  if (ok) return 'achieved';
  return inRange.length >= g.within ? 'missed' : 'active';
}

/** 自己最高との差（記録の文に添える） */
export function goalDiffText(L: Locale, g: GoalRecord): string {
  if (g.type === 'milestone' || g.best === null) return '';
  return t(L, `自己最高 ${g.best} ${sign(g.value - g.best)}`, `best ${g.best} ${sign(g.value - g.best)}`);
}

/** キャンプの文（3 行以内）。比較の行（§35.9）はこの候補に吸収する */
export function goalCampLines(L: Locale, info: Omit<GoalInfo, 'lines' | 'full'>, expeditionsLeft?: number, opts: { compact?: boolean } = {}): string[] {
  const lines: string[] = [];
  const a = info.active;
  // キャンプの観測は 1 行（V3-3c §44.5: 応答の長さ）。候補は declare_goal を引数なしで呼ぶと出る
  if (opts.compact && !a) return [t(L, '目標: 未宣言（declare_goal で候補が出る。点には影響しない）', 'Goal: none (call declare_goal for options; it does not affect points)')];
  if (a) {
    const diff = goalDiffText(L, a);
    lines.push(t(L, `目標: ${goalText(L, a)}${diff ? `（${diff}）` : ''}${expeditionsLeft !== undefined && a.within > 1 ? `・あと ${expeditionsLeft} 回の遠征` : ''}。宣言し直すと取り下げになる`,
      `Goal: ${goalText(L, a)}${diff ? ` (${diff})` : ''}${expeditionsLeft !== undefined && a.within > 1 ? `, ${expeditionsLeft} expeditions left` : ''}; declaring again withdraws it`));
    if (opts.compact) return lines;
  } else {
    lines.push(t(L, '目標: 未宣言（declare_goal で 1 つ選べる。点には影響しない）', 'Goal: none (declare_goal picks one; it does not affect points)'));
  }
  const by = (type: GoalType) => info.candidates.filter((c) => c.type === type);
  const parts: string[] = [];
  const d = by('depth'), b = by('banked'), m = by('margin'), ms = by('milestone');
  const tag = (c: GoalCandidate[]) => (c[0]?.level === 'start' ? t(L, '（初期値）', ' (start)') : t(L, '（自己最高に並ぶ／+／++）', ' (match / beat / beat big)'));
  if (d.length) parts.push(t(L, `深さ 地下${d.map((c) => c.value).join('／')}階${tag(d)}`, `depth ${d.map((c) => c.value).join('/')}${tag(d)}`));
  if (b.length) parts.push(t(L, `確定 ${b.map((c) => c.value).join('／')}${tag(b)}`, `banked ${b.map((c) => c.value).join('/')}${tag(b)}`));
  if (m.length) parts.push(t(L, `余力 HP ${m.map((c) => c.value).join('／')}%${tag(m)}`, `margin ${m.map((c) => c.value).join('/')}% HP${tag(m)}`));
  if (ms.length) parts.push(t(L, `節目 地下${ms[0].value}階を ${ms.map((c) => c.within).join('／')} 回以内`, `milestone depth ${ms[0].value} within ${ms.map((c) => c.within).join('/')}`));
  if (parts.length) lines.push(t(L, `目標の候補: ${parts.join('・')}`, `Goal options: ${parts.join('; ')}`));
  if (info.record.declared > 0) lines.push(t(L, `目標の記録: 宣言 ${info.record.declared}・達成 ${info.record.achieved}`, `Goals: declared ${info.record.declared}, achieved ${info.record.achieved}`));
  return lines.slice(0, 3);
}

/** 遠征中の目標の行（「目標: 1 回の遠征で確定 9700（いま帰ると 6200。あと 3500）」）。live: いまの値 */
export function goalProgressText(L: Locale, g: GoalRecord, live: { ifExtractNow?: number; depthNow?: number; maxDepth?: number; minHpPct?: number; leftExpeditions?: number }): string {
  let now = '';
  if (g.type === 'banked' && live.ifExtractNow !== undefined) now = live.ifExtractNow >= g.value ? t(L, `いま帰ると ${live.ifExtractNow}。届いている`, `extract now: ${live.ifExtractNow}, reached`) : t(L, `いま帰ると ${live.ifExtractNow}。あと ${g.value - live.ifExtractNow}`, `extract now: ${live.ifExtractNow}, ${g.value - live.ifExtractNow} to go`);
  if (g.type === 'depth' && live.maxDepth !== undefined) now = live.maxDepth >= g.value ? t(L, '届いている', 'reached') : t(L, `いまの最深 地下${live.maxDepth}階。あと ${g.value - live.maxDepth} 階`, `deepest so far ${live.maxDepth}, ${g.value - live.maxDepth} to go`);
  if (g.type === 'margin' && live.minHpPct !== undefined) now = live.minHpPct >= g.value ? t(L, `いままでの最低 ${live.minHpPct}%。保てている`, `lowest so far ${live.minHpPct}%, holding`) : t(L, `いままでの最低 ${live.minHpPct}%。もう届かない`, `lowest so far ${live.minHpPct}%, already missed`);
  if (g.type === 'milestone' && live.leftExpeditions !== undefined) now = t(L, `この遠征を入れてあと ${live.leftExpeditions} 回`, `${live.leftExpeditions} expeditions left including this one`);
  return t(L, `目標: ${goalText(L, g)}${now ? `（${now}）` : ''}`, `Goal: ${goalText(L, g)}${now ? ` (${now})` : ''}`);
}

/** 遠征レポートの goal（V3-7a） */
export function goalReportOf(g: GoalRecord): { type: GoalType; value: number; within: number; diff_from_best: number | null; result: GoalStatus } {
  return { type: g.type, value: g.value, within: g.within, diff_from_best: g.best === null || g.type === 'milestone' ? null : g.value - g.best, result: g.status };
}

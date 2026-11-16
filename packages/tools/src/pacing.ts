// テンポの計測（IMPROVEMENTS_V2 §5.2）: 貪欲 bot を多数のシードで走らせ、調整の根拠となる指標を出す。
import type { BotResult } from './bot';

export interface PacingReport {
  runs: number;
  /** 到着から下り階段を見つけるまでの手番（中央値） */
  stairsFound: { band: string; median: number | null; n: number; target: number | null }[];
  /** マクロ 1 回あたりの手数（＝判断の無い移動の長さ）の平均 */
  decisionInterval: { avg: number; p50: number; n: number; target: number };
  /** 到着から次の階へ進むまでの手番（中央値） */
  turnsPerFloor: { median: number | null; n: number };
  /** 最初の遠征の長さ（手番と行動の呼び出し回数の中央値） */
  firstExpedition: { turnsMedian: number | null; callsMedian: number | null; completed: number; n: number };
}

const BANDS: { name: string; min: number; max: number; target: number | null }[] = [
  { name: '1-2', min: 1, max: 2, target: 60 },
  { name: '3-6', min: 3, max: 6, target: 90 },
  { name: '7+', min: 7, max: Number.MAX_SAFE_INTEGER, target: null },
];

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function pacingReport(results: BotResult[]): PacingReport {
  const floors = results.flatMap((r) => r.floors);
  const steps = results.flatMap((r) => r.macroSteps);
  const first = results.map((r) => r.expeditions.find((x) => x.no === 1)).filter((x): x is NonNullable<typeof x> => !!x);
  const avg = steps.length ? Math.round((steps.reduce((a, b) => a + b, 0) / steps.length) * 10) / 10 : 0;
  return {
    runs: results.length,
    stairsFound: BANDS.map((b) => {
      const xs = floors.filter((f) => f.depth >= b.min && f.depth <= b.max && f.turnsToStairs !== null).map((f) => f.turnsToStairs!);
      return { band: b.name, median: median(xs), n: xs.length, target: b.target };
    }),
    decisionInterval: { avg, p50: median(steps) ?? 0, n: steps.length, target: 20 },
    turnsPerFloor: (() => {
      const xs = floors.filter((f) => f.turnsOnFloor !== null).map((f) => f.turnsOnFloor!);
      return { median: median(xs), n: xs.length };
    })(),
    firstExpedition: {
      turnsMedian: median(first.filter((x) => x.turns !== null).map((x) => x.turns!)),
      callsMedian: median(first.map((x) => x.calls)),
      completed: first.filter((x) => x.reason === 'completed').length,
      n: first.length,
    },
  };
}

export function formatPacing(r: PacingReport): string {
  const ok = (v: number | null, target: number | null) => (v === null || target === null ? '' : v <= target ? ' OK' : ' 目安超過');
  const lines = [
    `テンポ計測（貪欲 bot ${r.runs} ラン）`,
    '| 指標 | 値 | 目安 |',
    '|---|---|---|',
    ...r.stairsFound.map((s) => `| 階段発見までの手番（深度 ${s.band}、中央値） | ${s.median ?? '-'}（n=${s.n}） | ${s.target ?? '記録のみ'}${ok(s.median, s.target)} |`),
    `| 判断間隔（マクロ 1 回の平均手数） | ${r.decisionInterval.avg}（中央値 ${r.decisionInterval.p50}、n=${r.decisionInterval.n}） | ${r.decisionInterval.target} 以下${ok(r.decisionInterval.avg, r.decisionInterval.target)} |`,
    `| 1 階あたりの手番（中央値） | ${r.turnsPerFloor.median ?? '-'}（n=${r.turnsPerFloor.n}） | 記録のみ |`,
    `| 最初の遠征の長さ（手番／行動の呼び出し、中央値） | ${r.firstExpedition.turnsMedian ?? '-'} 手番／${r.firstExpedition.callsMedian ?? '-'} 回（達成 ${r.firstExpedition.completed}/${r.firstExpedition.n}） | 記録のみ |`,
  ];
  return lines.join('\n');
}

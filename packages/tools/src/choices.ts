// 選択の計測（IMPROVEMENTS_V3 §10）: 方針の違う bot を同じシードで走らせ、確定点の中央値と死亡率を比べる。
// 「意味のある選択」かどうかを数字にする。目安を外したら balance.json とデータの値で調整する（式は変えない）。
import type { SessionManager } from '@muse/server';
import type { OfferSlot } from '@muse/shared';
import type { BotResult } from './bot';
import { runBot } from './bot';

export interface PolicyStats {
  name: string; runs: number; medianBanked: number; meanBanked: number; deathRate: number; expeditions: number;
  /** 始めた遠征のうち死亡で終わった割合（%） */
  deathPerExpedition: number;
  /** 確定点の四分位範囲（分散の目安） */
  iqr: number;
}

export interface ChoicesReport {
  /** 粘るか帰るか: 達成したら即帰還 / 1 階深追い / 2 階深追い（候補は標準枠） */
  stay: PolicyStats[];
  /** 遠征候補: 堅実 / 標準 / 野心 だけを選び続ける（即帰還） */
  offers: PolicyStats[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function quantile(xs: number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
}

function stats(name: string, rs: BotResult[]): PolicyStats {
  const started = rs.reduce((a, r) => a + r.expeditions.filter((x) => x.reason !== null).length, 0);
  const died = rs.reduce((a, r) => a + r.expeditions.filter((x) => x.reason === 'died').length, 0);
  const b = rs.map((r) => r.banked);
  return {
    name, runs: rs.length,
    medianBanked: median(rs.map((r) => r.banked)),
    meanBanked: Math.round(rs.reduce((a, r) => a + r.banked, 0) / Math.max(1, rs.length)),
    deathRate: Math.round((rs.filter((r) => r.died).length * 100) / Math.max(1, rs.length)),
    expeditions: Math.round((rs.reduce((a, r) => a + r.expeditions.filter((x) => x.reason === 'completed').length, 0) * 10) / Math.max(1, rs.length)) / 10,
    deathPerExpedition: Math.round((died * 100) / Math.max(1, started)),
    iqr: quantile(b, 0.75) - quantile(b, 0.25),
  };
}

export async function choicesReport(manager: SessionManager, opts: { runs: number; maxActs: number; seed: string; log?: (s: string) => void }): Promise<ChoicesReport> {
  const run = async (name: string, policy: { overreach: number; offerSlot: OfferSlot }) => {
    const rs: BotResult[] = [];
    for (let i = 0; i < opts.runs; i++) {
      rs.push(await runBot(manager, { kind: 'greedy', seed: `${opts.seed}-${i}`, maxActs: opts.maxActs, ...policy }));
      for (const [id, s] of manager.sessions) { s.close(); manager.sessions.delete(id); }
    }
    const st = stats(name, rs);
    opts.log?.(`${name}: median ${st.medianBanked} mean ${st.meanBanked} iqr ${st.iqr} death ${st.deathRate}% (per expedition ${st.deathPerExpedition}%) expeditions/run ${st.expeditions}`);
    return st;
  };
  const stay = [
    await run('即帰還', { overreach: 0, offerSlot: 'standard' }),
    await run('1 階深追い', { overreach: 1, offerSlot: 'standard' }),
    await run('2 階深追い', { overreach: 2, offerSlot: 'standard' }),
  ];
  const offers = [
    await run('堅実のみ', { overreach: 0, offerSlot: 'safe' }),
    await run('標準のみ', { overreach: 0, offerSlot: 'standard' }),
    await run('野心のみ', { overreach: 0, offerSlot: 'ambitious' }),
  ];
  return { stay, offers };
}

/** 中央値の比が最良／最悪で 1.25 以内（= どれも他の 0.8〜1.25 倍）か */
function ratioOk(ps: PolicyStats[]): { ok: boolean; ratio: number } {
  const v = ps.map((p) => Math.max(1, p.medianBanked));
  const ratio = Math.max(...v) / Math.min(...v);
  return { ok: ratio <= 1.25, ratio: Math.round(ratio * 100) / 100 };
}

export function formatChoices(r: ChoicesReport): string {
  const table = (title: string, ps: PolicyStats[]) => {
    const ro = ratioOk(ps);
    return [
      `${title}（最良/最悪の比 ${ro.ratio}、目安 1.25 以下: ${ro.ok ? 'OK' : '目安超過'}）`,
      '| 方針 | ラン | 確定点の中央値 | 平均 | 四分位範囲 | ランの死亡率 | 遠征あたりの死亡率 | 達成した遠征/ラン |',
      '|---|---|---|---|---|---|---|---|',
      ...ps.map((p) => `| ${p.name} | ${p.runs} | ${p.medianBanked} | ${p.meanBanked} | ${p.iqr} | ${p.deathRate}% | ${p.deathPerExpedition}% | ${p.expeditions} |`),
    ].join('\n');
  };
  return [table('粘るか帰るか', r.stay), '', table('遠征候補', r.offers)].join('\n');
}

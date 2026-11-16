// ビルドの計測（IMPROVEMENTS_V3 §10 の「特技」「投擲と近接」。V3-4）。
// 特技の系統ごとに、その系統を取り続ける bot を同じシードで走らせて到達深度を比べ、職業ごとに撃破に占める投擲の割合を出す。
import type { SessionManager } from '@muse/server';
import { runBot } from './bot';

export interface LineageStats {
  lineage: string; name: string; classId: string; runs: number;
  medianDepth: number; meanDepth: number; medianLevel: number; deaths: number;
  kills: number; thrownKills: number; meleeKills: number;
}

export interface BuildsReport {
  lineages: LineageStats[];
  /** 全系統の最良と最悪の到達深度（平均）の比（参考。職業の差を含む） */
  depthRatio: number;
  /** 同じ職業の中の系統の最良 ÷ 最悪（目安 1.3 倍以内。V3-4a §25.1） */
  classRatios: { classId: string; name: string; ratio: number }[];
  /** 職業ごとの撃破に占める投擲の割合（%。目安: 戦士 30% 以下、斥候 40% 以上） */
  thrownShare: { classId: string; name: string; pct: number; kills: number }[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function buildsReport(manager: SessionManager, opts: { runs: number; maxActs: number; seed: string; log?: (s: string) => void }): Promise<BuildsReport> {
  const content = manager.deps.content;
  const lineages: LineageStats[] = [];
  for (const cls of content.lists.classes) {
    for (const lin of cls.lineages) {
      const depths: number[] = [];
      const levels: number[] = [];
      let deaths = 0, kills = 0, thrown = 0, melee = 0;
      for (let i = 0; i < opts.runs; i++) {
        const r = await runBot(manager, { kind: 'greedy', seed: `${opts.seed}-${i}`, classId: cls.id, maxActs: opts.maxActs, perkLineage: lin.id });
        depths.push(r.depth);
        levels.push(r.level);
        if (r.died) deaths++;
        kills += r.killsBy?.total ?? r.kills;
        thrown += r.killsBy?.thrown ?? 0;
        melee += r.killsBy?.melee ?? 0;
        for (const [id, s] of manager.sessions) { s.close(); manager.sessions.delete(id); }
      }
      const st: LineageStats = {
        lineage: lin.id, name: lin.name.ja, classId: cls.id, runs: opts.runs,
        medianDepth: median(depths), meanDepth: Math.round((depths.reduce((a, b) => a + b, 0) * 10) / Math.max(1, depths.length)) / 10,
        medianLevel: median(levels), deaths, kills, thrownKills: thrown, meleeKills: melee,
      };
      opts.log?.(`${cls.name.ja}・${lin.name.ja}: 深度 中央値 ${st.medianDepth} 平均 ${st.meanDepth}、Lv 中央値 ${st.medianLevel}、死亡 ${deaths}/${opts.runs}、撃破 ${kills}（投擲 ${thrown}・近接 ${melee}）`);
      lineages.push(st);
    }
  }
  const ratioOf = (ls: LineageStats[]) => { const m = ls.map((l) => Math.max(0.1, l.meanDepth)); return Math.round((Math.max(...m) / Math.min(...m)) * 100) / 100; };
  const depthRatio = ratioOf(lineages);
  const classRatios = content.lists.classes.filter((c) => lineages.some((l) => l.classId === c.id))
    .map((c) => ({ classId: c.id, name: c.name.ja, ratio: ratioOf(lineages.filter((l) => l.classId === c.id)) }));
  const thrownShare = content.lists.classes.map((cls) => {
    const ls = lineages.filter((l) => l.classId === cls.id);
    const k = ls.reduce((a, l) => a + l.kills, 0);
    const t = ls.reduce((a, l) => a + l.thrownKills, 0);
    return { classId: cls.id, name: cls.name.ja, pct: Math.round((t * 1000) / Math.max(1, k)) / 10, kills: k };
  });
  return { lineages, depthRatio, classRatios, thrownShare };
}

export function formatBuilds(r: BuildsReport): string {
  const ok = (b: boolean) => (b ? 'OK' : '目安外');
  const lines = [
    '## 特技の系統ごとの到達深度（その系統を取り続ける bot。同じシード）',
    '| 職業 | 系統 | ラン | 深度の中央値 | 深度の平均 | Lv の中央値 | 死亡 | 撃破（投擲・近接） |',
    '|---|---|---|---|---|---|---|---|',
    ...r.lineages.map((l) => `| ${l.classId.split(':')[1]} | ${l.name}（${l.lineage}） | ${l.runs} | ${l.medianDepth} | ${l.meanDepth} | ${l.medianLevel} | ${l.deaths} | ${l.kills}（${l.thrownKills}・${l.meleeKills}） |`),
    ...r.classRatios.map((c) => `${c.name}: 系統の最良 ÷ 最悪（深度の平均）= ${c.ratio}（目安 1.3 以内）: ${ok(c.ratio <= 1.3)}`),
    `（参考）全系統の最良 ÷ 最悪 = ${r.depthRatio}（職業の差を含む）`,
    '',
    '## 撃破に占める投擲の割合',
    ...r.thrownShare.map((s) => {
      const target = s.classId === 'core:warrior' ? `目安 30% 以下: ${ok(s.pct <= 30)}` : s.classId === 'core:scout' ? `目安 40% 以上: ${ok(s.pct >= 40)}` : '参考';
      return `- ${s.name}: ${s.pct}%（撃破 ${s.kills}。${target}）`;
    }),
  ];
  return lines.join('\n');
}

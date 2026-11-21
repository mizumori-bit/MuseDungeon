// シーズン（S0。SEASON.md §2・PROTOCOL.md §9）の、World から読むだけの関数。engine・サーバー・観測が同じものを使う。
import type { Locale, PlayerId, SeasonAward, SeasonState, World } from './types';
import { t } from './util';

/** ランの中の予算の残り（取り込んだ残り − その後の自分の手番）。シーズンのランでなければ null */
export function seasonBudgetLeft(world: World, pid: PlayerId): number | null {
  const s = world.season;
  if (!s) return null;
  const pr = world.players[pid];
  const turns = pr ? world.entities[pr.entityId]?.actor?.turns ?? 0 : 0;
  return s.budget.left - Math.max(0, turns - s.budget.at);
}

/**
 * 報告できる下り階段（S0 §9.4）: このランで自分の目で見た（覚えている地図にあり、地図の巻物や公開で知っただけのマスでない）主の枝の下り階段のうち、
 * このランでまだ報告していないもの。深さの順
 */
export function seasonReportable(world: World, pid: PlayerId): { depth: number; x: number; y: number }[] {
  const s = world.season;
  const pr = world.players[pid];
  if (!s || !pr) return [];
  const done = new Set(s.reported);
  const out: { depth: number; x: number; y: number }[] = [];
  for (const [key, f] of Object.entries(world.floors)) {
    if (f.branch !== 'main' || done.has(f.depth)) continue;
    const fk = pr.knowledge.floors[key];
    if (!fk) continue;
    const mapped = new Set(fk.mapped ?? []);
    for (const d of f.stairs.down) {
      const i = d.y * f.width + d.x;
      if ((fk.seen[i] ?? 0) !== 0 && !mapped.has(i)) { out.push({ depth: f.depth, x: d.x, y: d.y }); break; }
    }
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** キャンプの「まだ報告していない階段 N（うち、まだだれも公開していないもの M）」の数。M は取り込んだ公開の一覧で数える */
export function seasonStairsCounts(world: World, pid: PlayerId): { unreported: number; unpublished: number } {
  const list = seasonReportable(world, pid);
  const pub = new Set((world.season?.public ?? []).map((p) => p.depth));
  return { unreported: list.length, unpublished: list.filter((x) => !pub.has(x.depth)).length };
}

/** 公開された下り階段（その深さ） */
export function publicStairsAt(state: SeasonState | null | undefined, depth: number): SeasonState['public'][number] | null {
  return state?.public.find((p) => p.depth === depth) ?? null;
}

const AWARD_NAME: Record<SeasonAward['id'], [string, string]> = {
  adventure: ['冒険賞', 'Adventure award'], contribution: ['貢献賞', 'Contribution award'], survival: ['生還賞', 'Survival award'],
};

export function awardName(L: Locale, id: SeasonAward['id']): string {
  return t(L, AWARD_NAME[id][0], AWARD_NAME[id][1]);
}

/** 賞の値の文（冒険は「地下 N 階」、貢献は「N」、生還は「N 点」） */
export function awardValueText(L: Locale, id: SeasonAward['id'], v: number): string {
  if (id === 'adventure') return t(L, `地下${v}階`, `depth ${v}`);
  if (id === 'survival') return t(L, `${v} 点`, `${v} pts`);
  return String(v);
}

/** 賞ごとの 1 行（自分の値と順位、1 位の名前と値、1 位との差。PROTOCOL §9.6） */
export function awardText(L: Locale, a: SeasonAward): string {
  const name = awardName(L, a.id);
  const lead = a.leader ? t(L, `1位 ${a.leader.name} ${awardValueText(L, a.id, a.leader.value)}`, `1st ${a.leader.name} ${awardValueText(L, a.id, a.leader.value)}`) : t(L, 'まだ記録が無い', 'no record yet');
  if (a.value === null || a.rank === null) {
    const why = a.id === 'survival' ? t(L, '倒れたので対象外', 'not eligible (you have fallen)') : t(L, '対象外', 'not eligible');
    return `${name}: ${why}・${lead}`;
  }
  const mine = t(L, `あなた ${awardValueText(L, a.id, a.value)}（${a.rank}位/${a.entrants}人）`, `you ${awardValueText(L, a.id, a.value)} (#${a.rank} of ${a.entrants})`);
  if (a.rank === 1) return `${name}: ${mine}`;
  const gap = a.gap !== null ? t(L, `（差 ${a.gap}）`, ` (behind by ${a.gap})`) : '';
  return `${name}: ${mine}・${lead}${gap}`;
}

/** 予算の 1 行（迷宮の中もキャンプも） */
export function seasonBudgetText(L: Locale, name: string, left: number, limit: number): string {
  return t(L, `シーズン「${name}」: 残りの予算 ${Math.max(0, left)}/${limit} 手番`, `Season "${name}": budget left ${Math.max(0, left)}/${limit} turns`);
}

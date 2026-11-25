// ホーム（S8 の H2。SEASON.md §54.7・HUMAN.md §5）の部品: シーズンの順位の表（自分の行・指図の印・リプレイの口）・共有層の出来事。
// 中身は GET /api/seasons/:id のものを並べるだけ。だれが何を見られるか（開催中は名前だけ・巻き戻しは同じ機械から: §25.1・§27）は変えない。
import type { ComponentChildren } from 'preact';
import type { Catalog, SeasonAward, SeasonStandingRow, SeasonStandingsResponse } from '@muse/shared';
import { kindName } from '@muse/shared';
import { getLocale, tr } from '../util';
import { DirectedTag } from './season';

/** 名前を比べる形（順位の表の名前・ランのプレイヤーの名前。サーバーの名前の比べ方に近く: NFKC・前後の空白・大文字小文字） */
export function normName(s: string): string {
  return s.normalize('NFKC').trim().toLowerCase();
}

export type StandingSort = SeasonAward['id'] | 'used';
export const STANDING_SORTS: StandingSort[] = ['adventure', 'contribution', 'survival', 'support', 'used'];

export function standingSortName(k: StandingSort): string {
  return k === 'adventure' ? tr('冒険賞の順', 'by Adventure') : k === 'contribution' ? tr('貢献賞の順', 'by Contribution')
    : k === 'survival' ? tr('生還賞の順', 'by Survival') : k === 'support' ? tr('支援賞の順', 'by Support') : tr('使った予算の少ない順', 'by budget used');
}

function rankOf(r: SeasonStandingRow, k: StandingSort): number {
  if (k === 'used') return r.used;
  const c = k === 'survival' ? r.survival : k === 'support' ? r.support ?? null : r[k];
  return c ? c.rank : Number.POSITIVE_INFINITY;
}

/** 並べ替え（賞ごとの順位。対象外は後ろ。同じなら名前の順） */
export function sortStandings(rows: readonly SeasonStandingRow[], k: StandingSort): SeasonStandingRow[] {
  return [...rows].sort((a, b) => rankOf(a, k) - rankOf(b, k) || a.name.localeCompare(b.name));
}

/**
 * 順位の表（4 つの賞）。mine: 自分の行の名前（normName）。replay: 行の終わりに出すもの（記録のタブのリプレイの口）。
 * 名前の横に称号と、指図の印（S8 §54.6）
 */
export function StandingsTable({ rows, mine, replay }: { rows: readonly SeasonStandingRow[]; mine: ReadonlySet<string>; replay?: (r: SeasonStandingRow) => ComponentChildren }) {
  const L = getLocale();
  return (
    <table class="board">
      <thead><tr>
        <th>{tr('名前', 'Name')}</th><th title={tr('いちばん深い階', 'Deepest floor')}>{tr('冒険', 'Adventure')}</th>
        <th title={tr('最初に報告した階段の数', 'Stairs reported first')}>{tr('貢献', 'Contribution')}</th>
        <th title={tr('一度も倒れていない者の確定点', 'Banked points of those who never died')}>{tr('生還', 'Survival')}</th>
        <th title={tr('自分の野営の火が、ほかの参加者に使われた回数（S1）', 'Uses of your campfires by others (S1)')}>{tr('支援', 'Support')}</th>
        <th>{tr('使った予算', 'Budget used')}</th><th>{tr('ラン', 'Runs')}</th>
        {replay && <th>{tr('リプレイ', 'Replay')}</th>}
      </tr></thead>
      <tbody>{rows.map((r) => {
        const me = mine.has(normName(r.name));
        return (
          <tr key={r.name} class={me ? 'mine' : ''}>
            <td>
              {r.name}{me && <span class="tag you">{tr('あなた', 'you')}</span>}
              {(r.titles ?? []).map((x, i) => <span key={i} class="tag title" title={x.seasonName}>{L === 'en' ? x.name.en : x.name.ja}</span>)}
              <DirectedTag items={r.directed} />
            </td>
            <td>{r.adventure.rank}. {tr(`地下${r.adventure.value}階`, `D${r.adventure.value}`)}</td>
            <td>{r.contribution.rank}. {r.contribution.value}</td>
            <td>{r.survival ? `${r.survival.rank}. ${r.survival.value}` : tr('対象外（倒れた）', 'out (fell)')}</td>
            <td>{r.support ? `${r.support.rank}. ${r.support.value}` : '-'}</td>
            <td>{r.used}</td><td>{r.runs}</td>
            {replay && <td class="replays">{replay(r)}</td>}
          </tr>
        );
      })}</tbody>
    </table>
  );
}

/**
 * 共有層の出来事（HUMAN.md §3.9・SEASON.md §54.7 の 3）。今の HTTP の口には時刻の付いた流れが無いので、坑の断面（公開された階段と特別な場所・
 * 共有層に載った火・補給の置き場の残り・初討伐）と、討伐の載った順を、階の順に並べる（時刻なし）
 */
export function SeasonSharedFlow({ data, catalog }: { data: SeasonStandingsResponse; catalog: Catalog | null }) {
  const L = getLocale();
  const lines: { depth: number; parts: string[] }[] = [];
  for (const row of data.section ?? []) {
    const parts: string[] = [];
    if (row.stairs) parts.push(tr(`下り階段を ${row.stairs.by} が公開`, `down stairs published by ${row.stairs.by}`));
    for (const s of row.spots) parts.push(tr(`${catalog ? kindName(catalog, L, s.kind) : s.kind}を ${s.by} が公開`, `${catalog ? kindName(catalog, L, s.kind) : s.kind} published by ${s.by}`));
    for (const f of row.fires) parts.push(tr(`${f.by} の野営の火（ほかの参加者に使われた ${f.uses} 回）`, `${f.by}'s campfire (used ${f.uses} times by others)`));
    if (row.supplies) parts.push(tr(`補給の置き場に ${row.supplies} 品`, `${row.supplies} items in the supply caches`));
    for (const b of (data.slaysBrief ?? []).filter((x) => x.depth === row.depth).sort((a, b2) => a.order - b2.order)) {
      parts.push(tr(`大守護者を ${b.by} が倒した（${b.order} 番目に記録${b.firstKill ? '・初討伐' : ''}）`, `warden slain by ${b.by} (recorded #${b.order}${b.firstKill ? ', first kill' : ''})`));
    }
    if (row.firstWarden && !(data.slaysBrief ?? []).some((x) => x.depth === row.depth)) parts.push(tr(`大守護者の初討伐: ${row.firstWarden}`, `first warden kill: ${row.firstWarden}`));
    if (parts.length) lines.push({ depth: row.depth, parts });
  }
  if (!lines.length) return <div class="muted small">{tr('まだ共有層に載ったものは無い。', 'Nothing has reached the shared layer yet.')}</div>;
  return (
    <ul class="sflow">
      {lines.map((x) => <li key={x.depth}><b>{tr(`地下${x.depth}階`, `D${x.depth}`)}</b>: {x.parts.join(tr('／', ' / '))}</li>)}
    </ul>
  );
}

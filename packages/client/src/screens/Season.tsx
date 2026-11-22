// シーズンの結果を見返す画面（S2。SEASON.md §18.3）: 4 つの賞の順位・称号・参加者ごとの最深と確定点と使った予算と倒れたか・坑の断面。
// 中身は GET /api/seasons/:id だけ（サーバーが公開されたものと順位の表の最深だけで作る。位置は来ない）。進行中のシーズンも同じ画面で見る。
import type { Catalog, SeasonAward, SeasonStandingRow, SeasonStandingsResponse } from '@muse/shared';
import { awardName, guardianDisplayName, kindName, nameOf, slayGroupText, slayObs } from '@muse/shared';
import { useEffect, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import { ErrorBanner, Header, useCatalog, useLocaleRefresh } from '../ui/common';
import { fmtTime, getLocale, tr } from '../util';

const AWARDS: SeasonAward['id'][] = ['adventure', 'contribution', 'survival', 'support'];

function awardCell(r: SeasonStandingRow, id: SeasonAward['id']): { value: number; rank: number } | null {
  if (id === 'survival') return r.survival;
  if (id === 'support') return r.support ?? null;
  return r[id];
}

function nameOfClass(catalog: Catalog, classId: string, L: 'ja' | 'en'): string {
  return nameOf(catalog.classes[classId]?.name, L, classId.split(':')[1] ?? classId);
}

function valueText(id: SeasonAward['id'], v: number): string {
  if (id === 'adventure') return tr(`地下${v}階`, `depth ${v}`);
  if (id === 'survival') return tr(`${v} 点`, `${v} pts`);
  if (id === 'support') return tr(`${v} 回`, `${v} uses`);
  return String(v);
}

export function Season({ id }: { id: string }) {
  useLocaleRefresh();
  const { catalog } = useCatalog();
  const [data, setData] = useState<SeasonStandingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const L = getLocale();
  useEffect(() => {
    let alive = true;
    let final = false;
    const load = () => api.season(id).then((d) => { if (alive) { final = d.season.status === 'final'; setData(d); setError(null); } }).catch((e) => { if (alive) setError(errorText(e)); });
    void load();
    // 進行中のシーズンは読み直す（公開や順位が動く）。確定したら読み直さない
    const t = setInterval(() => { if (!final) void load(); }, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  const s = data?.season;
  const rows = data?.standings ?? [];
  const nm = (x: { name: { ja: string; en: string } }) => (L === 'en' ? x.name.en : x.name.ja);
  const statusText = !s ? '' : s.status === 'open' ? tr(`開催中・${fmtTime(s.endsAt)} まで`, `open until ${fmtTime(s.endsAt)}`)
    : s.status === 'ended' ? tr('終わりの時刻を過ぎた（確定待ち）', 'past its end (awaiting results)')
      : tr(`確定（${data?.result ? fmtTime(data.result.finalizedAt) : ''}）`, `final (${data?.result ? fmtTime(data.result.finalizedAt) : ''})`);
  return (
    <div class="page">
      <Header title={s ? tr(`シーズン「${s.name}」`, `Season "${s.name}"`) : tr('シーズン', 'Season')}>
        <a class="button small" href="#/">{tr('ロビーへ', 'Lobby')}</a>
      </Header>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      {!data && !error && <div class="muted">{tr('読み込み中…', 'Loading…')}</div>}
      {s && data && (
        <div class="seasonpage">
          <section class="panel">
            <h3>{s.name} <small class="muted">{s.id}</small></h3>
            <p>{statusText}・{tr(`予算 ${s.budget} 手番・ランを始めた ${s.participants}（招いた ${s.invited}）`, `budget ${s.budget} turns, ${s.participants} started (${s.invited} invited)`)}</p>
            {s.status !== 'final' && <p class="muted">{tr('進行中: 出しているのは、今の順位の表と、もう公開された階段・特別な場所・共有層に載った野営の火・討伐の記録だけ。', 'In progress: only the current standings and what is already public (stairs, special places, shared campfires, warden kill records) are shown.')}</p>}
          </section>

          <section class="panel">
            <h3>{tr('賞の順位', 'Awards')}</h3>
            <div class="awardgrid">
              {AWARDS.map((aid) => {
                const ranked = rows.map((r) => ({ r, c: awardCell(r, aid) })).filter((x): x is { r: SeasonStandingRow; c: { value: number; rank: number } } => !!x.c)
                  .sort((a, b) => a.c.rank - b.c.rank || a.r.name.localeCompare(b.r.name));
                const out = rows.filter((r) => !awardCell(r, aid));
                return (
                  <div key={aid} class="awardcol">
                    <h4>{awardName(L, aid)}</h4>
                    <ol>
                      {ranked.map(({ r, c }) => <li key={r.name} class={c.rank === 1 ? 'lead' : ''}>{c.rank}. {r.name} — {valueText(aid, c.value)}</li>)}
                    </ol>
                    {out.length > 0 && <div class="muted small">{tr(`対象外（倒れた）: ${out.map((r) => r.name).join('・')}`, `Not eligible (fell): ${out.map((r) => r.name).join(', ')}`)}</div>}
                  </div>
                );
              })}
            </div>
            {data.result && (
              <div class="titles">
                <h4>{tr('称号', 'Titles')}</h4>
                {(data.result.titles ?? []).length === 0
                  ? <div class="muted">{tr('付いた称号は無い（ランを始めた参加者が 2 人に満たない・1 位の値が 0・初討伐が無い）', 'No titles (fewer than 2 starters, a zero value, or no first warden kill)')}</div>
                  : <ul>{data.result.titles!.map((x, i) => <li key={i}><b>{x.holder}</b> <span class="tag title">{nm(x)}</span></li>)}</ul>}
              </div>
            )}
          </section>

          <section class="panel">
            <h3>{tr('参加者', 'Participants')}</h3>
            <table class="board">
              <thead><tr>
                <th>{tr('名前', 'Name')}</th><th>{tr('最深', 'Deepest')}</th><th>{tr('確定点', 'Banked')}</th><th>{tr('使った予算', 'Budget used')}</th>
                <th>{tr('倒れた', 'Fell')}</th><th>{tr('ラン', 'Runs')}</th>
              </tr></thead>
              <tbody>{rows.map((r) => (
                <tr key={r.name}>
                  <td>{r.name} {(r.titles ?? []).map((x, i) => <span key={i} class="tag title" title={x.seasonName}>{nm(x)}</span>)}</td>
                  <td>{tr(`地下${r.adventure.value}階`, `D${r.adventure.value}`)}</td>
                  <td>{r.banked ?? '-'}</td><td>{r.used}</td>
                  <td>{r.died ? tr('倒れた', 'yes') : '-'}</td><td>{r.runs}</td>
                </tr>
              ))}</tbody>
            </table>
          </section>

          <section class="panel">
            <h3 title={tr('階を行に取り、参加者ごとの最深・公開された階段と特別な場所・野営の火を並べる。位置は出さない', 'Floors as rows: deepest marks, published stairs and special places, and campfires. No positions')}>{tr('坑の断面', 'Cross-section')}</h3>
            <table class="board section">
              <thead><tr>
                <th>{tr('階', 'Floor')}</th><th>{tr('最深', 'Deepest')}</th><th>{tr('下り階段（報告）', 'Down stairs (reported)')}</th>
                <th>{tr('特別な場所（報告）', 'Special places (reported)')}</th><th>{tr('野営の火（置いた者・使われた回数）', 'Campfires (by, uses)')}</th>
                {data.result && <th>{tr('初討伐', 'First warden kill')}</th>}
              </tr></thead>
              <tbody>{(data.section ?? []).map((row) => (
                <tr key={row.depth} class={row.depth % 5 === 0 ? 'milestone' : ''}>
                  <td>{tr(`地下${row.depth}階`, `D${row.depth}`)}</td>
                  <td>{row.deepest.map((n) => <span key={n} class="tag deep">{n}</span>)}</td>
                  <td>{row.stairs ? row.stairs.by : <span class="muted">-</span>}</td>
                  <td>{row.spots.length ? row.spots.map((x, i) => <span key={i} class="spot">{catalog ? kindName(catalog, L, x.kind) : x.kind}（{x.by}）</span>) : <span class="muted">-</span>}</td>
                  <td>{row.fires.length ? row.fires.map((x, i) => <span key={i} class="fire">{x.by} ×{x.uses}</span>) : <span class="muted">-</span>}</td>
                  {data.result && <td>{row.firstWarden ?? ''}</td>}
                </tr>
              ))}</tbody>
            </table>
          </section>

          {/* 討伐の記録（S4。SEASON.md §35.5）: 節目ごとに、最初の 1 件といちばん少ない被害の 1 件。中身はゲームの事実だけ（位置は無い） */}
          {catalog && (data.slays ?? []).length > 0 && (
            <section class="panel">
              <h3 title={tr('節目の大守護者を倒した者の、その戦いの記録（倒した者がキャンプに着いたときに載る）', 'The record of each milestone warden kill (shared once the slayer reached camp)')}>{tr('討伐の記録', 'Warden kills')}</h3>
              <ul class="slays">
                {[...new Set((data.slays ?? []).map((x) => x.depth))].sort((a, b) => a - b).map((depth) => {
                  const recs = (data.slays ?? []).filter((x) => x.depth === depth);
                  const warden = guardianDisplayName(L, { name: recs[0].warden });
                  const obs = recs.map((x) => slayObs(L, catalog, x)).sort((a, b) => Number(!!b.first) - Number(!!a.first));
                  return <li key={depth}><b>{tr(`地下${depth}階「${warden}」`, `Depth ${depth} "${warden}"`)}</b>{obs.map((r, i) => <div key={i} class="slay">{slayGroupText(L, [r])}</div>)}</li>;
                })}
              </ul>
            </section>
          )}
          {/* 開催中（S4a）: だれがどの節目を何番目に倒したかだけ。中身はシーズンが確定してから（参加者はキャンプの記録庫で読める） */}
          {(data.slaysBrief ?? []).length > 0 && (
            <section class="panel">
              <h3>{tr('討伐の記録', 'Warden kills')}</h3>
              <p class="muted">{tr('開催中は、だれがどの節目を倒したかだけを出す。戦いの中身（装備・被害・使った品など）は、シーズンが確定してから。参加者は、キャンプの記録庫で読める。', 'While the season is open only who slew which milestone is shown. The fight records (gear, damage, items...) come once the season is final; participants read them in the camp archive.')}</p>
              <ul class="slays">
                {[...new Set((data.slaysBrief ?? []).map((x) => x.depth))].sort((a, b) => a - b).map((depth) => {
                  const recs = (data.slaysBrief ?? []).filter((x) => x.depth === depth).sort((a, b) => a.order - b.order);
                  const warden = guardianDisplayName(L, { name: recs[0].warden });
                  return <li key={depth}><b>{tr(`地下${depth}階「${warden}」`, `Depth ${depth} "${warden}"`)}</b>: {recs.map((r) => tr(`${r.order} 番目に載った: ${r.by}（Lv${r.level}・${catalog ? nameOfClass(catalog, r.classId, L) : r.classId}）${r.firstKill ? '・初討伐' : ''}`, `recorded #${r.order}: ${r.by} (Lv${r.level} ${catalog ? nameOfClass(catalog, r.classId, L) : r.classId})${r.firstKill ? ', first kill' : ''}`)).join(tr('／', ' / '))}</li>;
                })}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

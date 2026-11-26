// シーズンのタブ（S16b。SEASON.md §70.4 の 2。#/season と #/season/<id>）: 見出しのプルダウンでシーズンを選び、順位の表（並べ替え・「自分だけ」・
// 行の「見守る」「見返す」）・称号・坑の断面・共有層の出来事・討伐の記録を 1 枚に出す。前の「記録」のタブのシーズンの一覧と、
// 前の結果を見返す画面（screens/Season.tsx。S2 §18.3）を、ここに 1 つにした。
// 中身は GET /api/seasons/:id のものを並べるだけ（サーバーが公開されたものと順位の表だけで作る。位置は来ない）。だれが何を見られるかは変えない（§25.1）。
import type { Catalog, RunListing, SeasonListing, SeasonStandingRow, SeasonStandingsResponse, SeasonWatchResponse } from '@muse/shared';
import { guardianDisplayName, kindName, nameOf, slayGroupText, slayObs } from '@muse/shared';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { fmtTime, getLocale, navigate, tr } from '../util';
import { pickSeasonId, runActions, runsForRows, seasonsNewestFirst, type RunAction } from './entrance';
import { normName, SeasonSharedFlow, sortStandings, STANDING_SORTS, standingSortName, StandingsTable, type StandingSort } from './home';

/** プルダウンと見出しの、シーズンの状態の短い言葉 */
export function seasonStatusWord(s: SeasonListing): string {
  return s.status === 'open' ? tr('開催中', 'open') : s.status === 'ended' ? tr('確定待ち', 'awaiting results') : tr('確定', 'final');
}

export interface SeasonViewProps {
  /** 読んだシーズン（順位の表つき）。loaded: 一覧を一度でも読んだ */
  seasons: readonly SeasonStandingsResponse[];
  loaded: boolean;
  /** 道のシーズンの ID（#/season なら null） */
  requested: string | null;
  /** いま観戦できるラン（シーズンごと。GET /api/seasons/:id/watch） */
  watch: Readonly<Record<string, SeasonWatchResponse>>;
  runs: readonly RunListing[] | null;
  catalog: Catalog | null;
  /** そのシーズンの、自分の行の名前（normName） */
  myNames: (sid: string, rows: readonly SeasonStandingRow[]) => Set<string>;
  /** ランの参加者の名前（順位の表の名前） */
  participantOf: (r: RunListing) => string;
  myRunIds: ReadonlySet<string>;
  onlyMine: boolean;
  setOnlyMine: (v: boolean) => void;
  sortBy: StandingSort;
  setSortBy: (k: StandingSort) => void;
}

export function SeasonView(p: SeasonViewProps) {
  const L = getLocale();
  const list = seasonsNewestFirst(p.seasons);
  const pick = pickSeasonId(list.map((x) => x.season), p.requested);
  const data = list.find((x) => x.season.id === pick.id) ?? null;
  if (!p.loaded) return <Shell><p class="hub-note">{tr('読み込み中…', 'Loading…')}</p></Shell>;
  if (!data) {
    return (
      <Shell>
        <section class="hub-empty">
          <h2 class="hub-keytitle">{tr('シーズンは、まだ無い', 'No seasons yet')}</h2>
          <p class="hub-note">{tr('シーズンが始まると、ここに順位と坑の断面が出る。', 'Once a season starts, its standings and cross-section appear here.')}</p>
        </section>
      </Shell>
    );
  }
  const s = data.season;
  const final = s.status === 'final';
  const rows0 = data.result?.standings ?? data.standings;
  const mine = p.myNames(s.id, rows0);
  const rows = sortStandings(p.onlyMine ? rows0.filter((r) => mine.has(normName(r.name))) : rows0, p.sortBy);
  const sw = p.watch[s.id];
  const seasonRuns = (p.runs ?? []).filter((r) => r.season === s.id);
  const { byRow, unmatched: unmatched0 } = runsForRows(rows0, seasonRuns, p.participantOf);
  const unmatched = unmatched0.filter((x) => !(p.onlyMine && !p.myRunIds.has(x.runId)));
  /** そのランのボタン（S17 で「見返す」が足される所） */
  const actionsOf = (x: RunListing | string): RunAction[] => runActions(typeof x === 'string'
    ? { season: s.id, final, local: !!sw?.local, runId: x, status: null, watchable: sw?.runs.map((r) => r.runId) ?? null }
    : { season: s.id, final, local: !!sw?.local, runId: x.runId, status: x.status, recoveryFailed: !!x.recoveryFailed, watchable: sw?.runs.map((r) => r.runId) ?? null });
  const rowButtons = (xs: readonly (RunListing | string)[]) => <RunButtons runs={xs} actionsOf={actionsOf} />;
  const titles = data.result?.titles ?? [];
  const nm = (x: { name: { ja: string; en: string } }) => (L === 'en' ? x.name.en : x.name.ja);
  return (
    <Shell>
      <header class="ent-head">
        <div class="ent-headtext">
          <h1 class="ent-title">{s.name} <small class="ent-id">{s.id}</small></h1>
          <div class="hub-sub">
            {seasonStatusWord(s)}
            <span class="hub-dot" />
            {s.status === 'open' ? tr(`${fmtTime(s.endsAt)} まで`, `until ${fmtTime(s.endsAt)}`) : final && data.result ? tr(`${fmtTime(data.result.finalizedAt)} に確定`, `final at ${fmtTime(data.result.finalizedAt)}`) : tr(`${fmtTime(s.endsAt)} に終わった`, `ended ${fmtTime(s.endsAt)}`)}
            <span class="hub-dot" />
            {tr(`予算 ${s.budget} 手番`, `${s.budget} turns`)}
            <span class="hub-dot" />
            {tr(`潜った ${s.participants}（招いた ${s.invited}）`, `${s.participants} dived (${s.invited} invited)`)}
          </div>
        </div>
        <label class="ent-pick">
          <span class="ent-picklabel">{tr('シーズン', 'Season')}</span>
          <select class="hub-input" value={s.id} onChange={(e) => navigate(`#/season/${encodeURIComponent((e.target as HTMLSelectElement).value)}`)}>
            {list.map((x) => <option key={x.season.id} value={x.season.id}>{`${x.season.name}（${seasonStatusWord(x.season)}）`}</option>)}
          </select>
        </label>
      </header>
      {pick.missing && <p class="hub-note warn">{tr(`シーズン「${p.requested}」は、見つからない。いちばん新しいシーズンを出している。`, `Season "${p.requested}" was not found; showing the latest one.`)}</p>}
      {/* 同じ PC からは、終わったランに「見返す」が出る（§25.1。runActions）: 注記を、そこに合わせる（S16d） */}
      {!final && <p class="hub-note">{sw?.local
        ? tr('開催中は、今の順位と、もう公開されたもの（階段・特別な場所・共有層に載った火・討伐）だけを出す。この PC はサーバーと同じなので、終わったランは、今も見返せる（ほかの PC からは、確定した後）。', 'While it runs, only the current standings and what is already public (stairs, special places, shared campfires, warden kills) are shown. This PC runs the server, so ended runs can be looked back on now (from other PCs, once it is final).')
        : tr('開催中は、今の順位と、もう公開されたもの（階段・特別な場所・共有層に載った火・討伐）だけを出す。ランを見返せるのは、確定した後。', 'While it runs, only the current standings and what is already public (stairs, special places, shared campfires, warden kills) are shown. Runs can be looked back on once it is final.')}</p>}

      <section class="ent-sec">
        <div class="ent-sechead">
          <h2 class="hub-sechead">{tr('順位', 'Standings')}</h2>
          <div class="ent-tools">
            <label class="ent-check"><input type="checkbox" checked={p.onlyMine} onChange={(e) => p.setOnlyMine((e.target as HTMLInputElement).checked)} />{tr('自分だけ', 'Only mine')}</label>
            <select class="hub-input ent-select" aria-label={tr('並べ替え', 'Sort')} value={p.sortBy} onChange={(e) => p.setSortBy((e.target as HTMLSelectElement).value as StandingSort)}>
              {STANDING_SORTS.map((k) => <option key={k} value={k}>{standingSortName(k)}</option>)}
            </select>
          </div>
        </div>
        {rows0.length === 0 && <p class="hub-note">{tr('まだ、だれも潜っていない。', 'Nobody has gone down yet.')}</p>}
        {rows0.length > 0 && !rows.length && <p class="hub-note">{tr('このシーズンに、自分と分かる行は無い（このブラウザの鍵と、このブラウザで遊んだ冒険から分かる範囲で）。', 'No row of yours in this season (as far as the keys in this browser and the adventures played here tell).')}</p>}
        {rows.length > 0 && <div class="hub-tablewrap"><StandingsTable rows={rows} mine={mine} banked replay={(r) => rowButtons(byRow.get(r.name) ?? [])} /></div>}
        {unmatched.length > 0 && (
          <p class="hub-note">
            {tr('順位の表の名前と結べなかった冒険（冒険の名前が、招いたときの名前と違う）: ', 'Adventures not matched to a row (named differently from the invitation): ')}
            {unmatched.map((x) => <span key={x.runId} class="ent-unrun">{p.participantOf(x) || x.runId} {rowButtons([x])}</span>)}
          </p>
        )}
      </section>

      {final && (
        <section class="ent-sec">
          <h2 class="hub-sechead">{tr('称号', 'Titles')}</h2>
          {titles.length === 0
            ? <p class="hub-note">{tr('付いた称号は無い（潜った参加者が 2 人に満たない・1 位の値が 0・初討伐が無い）。', 'No titles (fewer than 2 divers, a zero value, or no first warden kill).')}</p>
            : <ul class="ent-titles">{titles.map((x, i) => <li key={i}><span class="ent-holder">{x.holder}</span><span class="tag title">{nm(x)}</span></li>)}</ul>}
        </section>
      )}

      <section class="ent-sec">
        <h2 class="hub-sechead" title={tr('階を行に取り、参加者ごとの最深・公開された階段と特別な場所・野営の火を並べる。位置は出さない', 'Floors as rows: deepest marks, published stairs and special places, and campfires. No positions')}>{tr('坑の断面', 'Cross-section')}</h2>
        {(data.section ?? []).length === 0
          ? <p class="hub-note">{tr('まだ、だれも潜っていない。', 'Nobody has gone down yet.')}</p>
          : <CrossSection data={data} catalog={p.catalog} />}
      </section>

      <section class="ent-sec">
        <h2 class="hub-sechead" title={tr('時刻の順の記録は、今の口には無い。階ごとに、公開されたもの・共有層に載った火・討伐を並べる', 'There is no timestamped feed yet; this lists, by floor, what was published, shared campfires and warden kills')}>{tr('共有層の出来事', 'Shared layer')}</h2>
        <div class="ent-card"><SeasonSharedFlow data={data} catalog={p.catalog} /></div>
      </section>

      <Slays data={data} catalog={p.catalog} />
    </Shell>
  );
}

/** 入口のタブの地（拠点と同じ紺の地と、真ん中の列。表があるので、拠点より少し広い） */
export function Shell({ children }: { children: ComponentChildren }) {
  return <div class="hub"><div class="hub-col is-wide">{children}</div></div>;
}

/**
 * 行のボタン: いちばん新しいランのボタン（見守る・見返す）と、前のランはプルダウン（選ぶと開く）。どのランにもボタンが無ければ、何も出さない（§70.4 の 2）
 */
function RunButtons({ runs, actionsOf }: { runs: readonly (RunListing | string)[]; actionsOf: (x: RunListing | string) => RunAction[] }) {
  const all = runs.map((x, i) => ({ id: typeof x === 'string' ? x : x.runId, n: i + 1, at: typeof x === 'string' ? null : x.createdAt, acts: actionsOf(x) })).filter((x) => x.acts.length > 0);
  if (!all.length) return null;
  const newest = all[all.length - 1];
  const older = all.slice(0, -1).reverse();
  return (
    <span class="ent-runbtns">
      {newest.acts.map((a) => <a key={a.kind} class="hub-btn small" href={a.href} title={newest.at ? fmtTime(newest.at) : undefined}>{a.label}</a>)}
      {older.length > 0 && (
        <select class="hub-input ent-select ent-older" value="" aria-label={tr('前の冒険', 'Earlier adventures')} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) navigate(v); }}>
          <option value="">{tr(`前の冒険（${older.length}）`, `Earlier (${older.length})`)}</option>
          {older.flatMap((x) => x.acts.map((a) => <option key={`${x.id}-${a.kind}`} value={a.href}>{`${tr(`冒険 ${x.n}`, `#${x.n}`)}${x.at ? `（${fmtTime(x.at)}）` : ''}・${a.label}`}</option>))}
        </select>
      )}
    </span>
  );
}

/** 坑の断面（前の結果を見返す画面から移した。中身は同じ） */
function CrossSection({ data, catalog }: { data: SeasonStandingsResponse; catalog: Catalog | null }) {
  const L = getLocale();
  return (
    <div class="hub-tablewrap">
      <table class="board section">
        <thead><tr>
          <th>{tr('階', 'Floor')}</th><th>{tr('最深', 'Deepest')}</th><th>{tr('下り階段（報告）', 'Down stairs (reported)')}</th>
          <th>{tr('特別な場所（報告）', 'Special places (reported)')}</th><th>{tr('野営の火（置いた者・使われた回数）', 'Campfires (by, uses)')}</th>
          {data.result && <th>{tr('初討伐', 'First warden kill')}</th>}
        </tr></thead>
        <tbody>{(data.section ?? []).map((row) => (
          <tr key={row.depth} class={row.depth % 5 === 0 ? 'milestone' : ''}>
            <td>{tr(`地下 ${row.depth} 階`, `D${row.depth}`)}</td>
            <td class="wrap">{row.deepest.length ? row.deepest.map((n) => <span key={n} class="tag deep">{n}</span>) : <span class="muted">-</span>}</td>
            <td>{row.stairs ? row.stairs.by : <span class="muted">-</span>}</td>
            <td class="wrap">{row.spots.length ? row.spots.map((x, i) => <span key={i} class="spot">{catalog ? kindName(catalog, L, x.kind) : x.kind}（{x.by}）</span>) : <span class="muted">-</span>}</td>
            <td class="wrap">{row.fires.length ? row.fires.map((x, i) => <span key={i} class="fire">{x.by} ×{x.uses}</span>) : <span class="muted">-</span>}</td>
            {data.result && <td>{row.firstWarden ?? ''}</td>}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** 職の名前（討伐の記録の短い行） */
function nameOfClass(catalog: Catalog, classId: string, L: 'ja' | 'en'): string {
  return nameOf(catalog.classes[classId]?.name, L, classId.split(':')[1] ?? classId);
}

/**
 * 討伐の記録（S4。SEASON.md §35.5）: 確定の後か、同じ PC からは中身（節目ごとに、最初の 1 件といちばん少ない被害の 1 件）。
 * 開催中のほかの接続には、だれがどの節目を何番目に倒したかだけ（S4a）。長いので、畳んでおく
 */
function Slays({ data, catalog }: { data: SeasonStandingsResponse; catalog: Catalog | null }) {
  const L = getLocale();
  const [open, setOpen] = useState(false);
  const full = data.slays ?? [];
  const brief = data.slaysBrief ?? [];
  if (!(catalog && full.length) && !brief.length) return null;
  const depths = (xs: readonly { depth: number }[]) => [...new Set(xs.map((x) => x.depth))].sort((a, b) => a - b);
  return (
    <section class="ent-sec">
      <h2 class="hub-sechead" title={tr('節目の大守護者を倒した者の、その戦いの記録（倒した者がキャンプに着いたときに載る）', 'The record of each milestone warden kill (shared once the slayer reached camp)')}>{tr('討伐の記録', 'Warden kills')}</h2>
      {catalog && full.length > 0 && (
        <details class="ent-card ent-fold" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{tr(`節目 ${depths(full).length} つの記録`, `Records for ${depths(full).length} milestone(s)`)}</summary>
          <ul class="slays">
            {depths(full).map((depth) => {
              const recs = full.filter((x) => x.depth === depth);
              const warden = guardianDisplayName(L, { name: recs[0].warden });
              const obs = recs.map((x) => slayObs(L, catalog, x)).sort((a, b) => Number(!!b.first) - Number(!!a.first));
              return <li key={depth}><b>{tr(`地下${depth}階「${warden}」`, `Depth ${depth} "${warden}"`)}</b>{obs.map((r, i) => <div key={i} class="slay">{slayGroupText(L, [r])}</div>)}</li>;
            })}
          </ul>
        </details>
      )}
      {brief.length > 0 && (
        <div class="ent-card">
          <p class="hub-note">{tr('開催中は、だれがどの節目を倒したかだけ。戦いの中身は、シーズンが確定してから（参加者は、キャンプの記録庫で読める）。', 'While the season is open, only who slew which milestone. The fight records come once it is final (participants read them in the camp archive).')}</p>
          <ul class="slays">
            {depths(brief).map((depth) => {
              const recs = brief.filter((x) => x.depth === depth).sort((a, b) => a.order - b.order);
              const warden = guardianDisplayName(L, { name: recs[0].warden });
              return <li key={depth}><b>{tr(`地下${depth}階「${warden}」`, `Depth ${depth} "${warden}"`)}</b>: {recs.map((r) => tr(`${r.order} 番目: ${r.by}（Lv${r.level}・${catalog ? nameOfClass(catalog, r.classId, L) : r.classId}）${r.firstKill ? '・初討伐' : ''}`, `#${r.order}: ${r.by} (Lv${r.level} ${catalog ? nameOfClass(catalog, r.classId, L) : r.classId})${r.firstKill ? ', first kill' : ''}`)).join(tr('／', ' / '))}</li>;
            })}
          </ul>
        </div>
      )}
    </section>
  );
}

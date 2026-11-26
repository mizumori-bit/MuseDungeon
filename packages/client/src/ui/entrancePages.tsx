// 入口のタブの部品（S16b。SEASON.md §70.4 の 3・4）: リーダーボード（#/leaderboard）と図鑑（#/codex）。
// リーダーボードは、前の「記録」のタブの 3 つの表（確定点・継承ありのラン・旧スコア）を、そのまま移した（▶ は、今までどおり、巻き戻しを開く）。
// 図鑑は、この PC で遊んだ冒険者の発見を合わせたもの（合わせ方は ui/entrance.ts）。中身は、プロフィールの口が返しているものの範囲だけ。
import type { Catalog, LeaderboardEntry } from '@muse/shared';
import { kindName } from '@muse/shared';
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { getLocale, tr } from '../util';
import { featsByPerson, findersText, mergeCodexBooks, personRecordLine, type CodexBook, type PersonRecord } from './entrance';
import { Shell } from './seasonPage';

/** 表の行の数（それより多ければ「もっと見る」） */
const BOARD_ROWS = 20;
const CODEX_ITEMS = 30;

export function LeaderboardView({ board, catalog, myRunIds }: { board: readonly LeaderboardEntry[]; catalog: Catalog | null; myRunIds: ReadonlySet<string> }) {
  const L = getLocale();
  // スコアの版ごとに別の表（版 2: 確定点 → 達成した遠征の数 → 最深。版 1 は旧スコア）。継承したラン（V3-7 §7.3）は別の表
  const byScore = (a: LeaderboardEntry, b: LeaderboardEntry) => b.score - a.score || (b.expeditions ?? 0) - (a.expeditions ?? 0) || b.deepest - a.deepest;
  const v2 = board.filter((b) => b.scoreVersion === 2 && !b.legacy).sort(byScore);
  const v2Legacy = board.filter((b) => b.scoreVersion === 2 && b.legacy).sort(byScore);
  const v1 = board.filter((b) => b.scoreVersion !== 2); // 旧表はサーバーの並び順のまま
  const row = (b: LeaderboardEntry, i: number, isV2: boolean) => (
    <tr key={`${b.runId}-${b.playerId}`} class={`${b.ongoing ? 'ongoing' : ''} ${myRunIds.has(b.runId) ? 'mine' : ''}`}>
      <td class="num rank">{i + 1}</td>
      <td>
        <span class="ent-who">{b.name}</span>
        <span class={`tag ${b.controller.kind}`}>{b.controller.kind === 'agent' ? 'AI' : b.controller.kind === 'unknown' ? tr('不明', 'unknown') : tr('人間', 'human')}</span>
        <small class="ent-class">{catalog ? kindName(catalog, L, b.classId) : b.classId}</small>
        {b.ongoing && <span class="tag ongoing" title={tr('ランは終了していない（キャンプ中の記録）', 'The run has not ended (recorded at camp)')}>{tr('継続中', 'ongoing')}</span>}
      </td>
      {isV2 && <td class="num primary-col">{b.score}</td>}
      <td class={`num ${isV2 ? '' : 'primary-col'}`}>{b.expeditions ?? 0}</td>
      <td class="num">{b.deepest}</td><td class="num">{b.level}</td><td class="num">{b.kills}</td>
      {!isV2 && <td class="num">{b.score}</td>}
      <td><a class="hub-btn small" href={`#/replay/${b.runId}`} title={tr('巻き戻しを開く', 'Open the replay')} aria-label={tr('巻き戻しを開く', 'Open the replay')}>▶</a></td>
    </tr>
  );
  const head = (isV2: boolean) => (
    <thead><tr>
      <th class="num">#</th><th>{tr('名前', 'Name')}</th>
      {isV2 && <th class="num">{tr('確定点', 'Banked')}</th>}
      <th class="num" title={tr('達成した遠征の数', 'Completed expeditions')}>{tr('遠征', 'Exp.')}</th>
      <th class="num">{tr('到達', 'Depth')}</th><th class="num">Lv</th><th class="num">{tr('撃破', 'Kills')}</th>
      {!isV2 && <th class="num">{tr('スコア（版1）', 'Score (v1)')}</th>}
      <th><span class="sr-only">{tr('巻き戻し', 'Replay')}</span></th>
    </tr></thead>
  );
  return (
    <Shell>
      <header class="ent-head">
        <div class="ent-headtext">
          <h1 class="ent-title">{tr('リーダーボード', 'Leaderboard')}</h1>
          <div class="hub-sub">{tr('このサーバーの、すべての冒険の点。開催中のシーズンの冒険は、確定してから載る。', 'Scores of every adventure on this server. Adventures of a running season appear once it is final.')}</div>
        </div>
      </header>
      {board.length === 0 && <section class="hub-empty"><h2 class="hub-keytitle">{tr('まだ記録が無い', 'No records yet')}</h2></section>}
      {board.length > 0 && (
        <>
          <section class="ent-sec">
            <h2 class="hub-sechead" title={tr('持ち帰って確定した点の合計。同点なら達成した遠征の数、最深の順', 'Sum of banked points; ties by completed expeditions, then deepest')}>{tr('確定点', 'Banked points')}</h2>
            {v2.length === 0 ? <p class="hub-note">{tr('まだ記録が無い。', 'No records yet.')}</p> : <MoreTable rows={v2} head={head(true)} row={(b, i) => row(b, i, true)} />}
          </section>
          {v2Legacy.length > 0 && (
            <section class="ent-sec">
              <h2 class="hub-sechead">{tr('継承ありのラン', 'Runs with legacy')}</h2>
              <p class="hub-note">{tr('前のランの図鑑の知識を引き継いだラン。上の表とは分ける。', 'Runs that inherited codex knowledge; kept apart from the table above.')}</p>
              <MoreTable rows={v2Legacy} head={head(true)} row={(b, i) => row(b, i, true)} />
            </section>
          )}
          {v1.length > 0 && (
            <section class="ent-sec">
              <details class="ent-fold">
                <summary class="hub-sechead">{tr(`旧スコア（版1）の記録 ${v1.length} 件`, `Old score (v1): ${v1.length} records`)}</summary>
                <p class="hub-note">{tr('深さなどから計算した旧方式のスコア。確定点とは比べられない。', 'Depth-based old scoring; not comparable with banked points.')}</p>
                <MoreTable rows={v1} head={head(false)} row={(b, i) => row(b, i, false)} />
              </details>
            </section>
          )}
        </>
      )}
    </Shell>
  );
}

/** 表（BOARD_ROWS 行まで。多ければ「もっと見る」） */
function MoreTable<T>({ rows, head, row }: { rows: readonly T[]; head: JSX.Element; row: (x: T, i: number) => JSX.Element }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, BOARD_ROWS);
  return (
    <>
      <div class="hub-tablewrap"><table class="board">{head}<tbody>{shown.map(row)}</tbody></table></div>
      {rows.length > BOARD_ROWS && (
        <button type="button" class="hub-linkbtn ent-more" onClick={() => setAll(!all)}>
          {all ? tr('上位だけにする', 'Show the top only') : tr(`もっと見る（全 ${rows.length} 件）`, `Show more (${rows.length} in all)`)}
        </button>
      )}
    </>
  );
}

/**
 * 図鑑（#/codex）。books: 合わせる冒険者の図鑑（このブラウザの鍵の冒険者と、同じ PC からならサーバーの全員）。
 * local: サーバーと同じ PC から開いている。loading: まだ読んでいる。hasKeys: このブラウザに鍵がある
 */
export function CodexView({ books, local, loading, hasKeys }: { books: readonly CodexBook[]; local: boolean; loading: boolean; hasKeys: boolean }) {
  const cats = mergeCodexBooks(books);
  const people = featsByPerson(books);
  const found = cats.reduce((a, c) => a + c.entries.length, 0);
  const total = cats.reduce((a, c) => a + c.total, 0);
  const who = new Set(books.map((b) => b.id)).size;
  return (
    <Shell>
      <header class="ent-head">
        <div class="ent-headtext">
          <h1 class="ent-title">{tr('図鑑', 'Codex')}</h1>
          <div class="hub-sub">
            {local
              ? tr('この PC のサーバーの冒険者の全員が、見つけたものを合わせた。', 'What every adventurer on this PC\'s server has found, put together.')
              : tr('このブラウザで遊んだ冒険者（鍵を覚えている冒険者）が、見つけたものを合わせた。', 'What the adventurers played in this browser (whose keys it keeps) have found, put together.')}
          </div>
        </div>
        {found > 0 && (
          <div class="ent-count" aria-label={tr(`図鑑 ${found}/${total}`, `Codex ${found}/${total}`)}>
            <span class="ent-countnum">{found}</span><span class="ent-counttotal">/ {total}</span>
            <span class="ent-countwho">{tr(`${who} 人の発見`, `found by ${who}`)}</span>
          </div>
        )}
      </header>
      {loading && <p class="hub-note">{tr('読み込み中…', 'Loading…')}</p>}
      {!loading && found === 0 && (
        <section class="hub-empty">
          <h2 class="hub-keytitle">{tr('まだ、何も載っていない', 'Nothing here yet')}</h2>
          <p class="hub-note">{!local && !hasKeys
            ? tr('冒険者の鍵を、拠点で入れると、その冒険者の見つけたものが、ここに載る。', 'Enter an adventurer\'s key on the hub, and what they found shows up here.')
            : tr('冒険者が、種族に出会ったり、品を鑑定したりすると、ここに載る。', 'Once your adventurers meet creatures or identify items, they show up here.')}</p>
        </section>
      )}
      {found > 0 && cats.filter((c) => c.entries.length > 0).map((c) => <CodexCategoryCard key={c.id} cat={c} />)}
      {/* まだだれも見つけていない分類は、1 行にまとめる（空の札を並べない） */}
      {found > 0 && cats.some((c) => c.entries.length === 0) && (
        <p class="hub-note">{tr(`まだ、だれも見つけていない: ${cats.filter((c) => !c.entries.length).map((c) => `${c.name}（0 / ${c.total}）`).join('・')}`, `Nobody has found any yet: ${cats.filter((c) => !c.entries.length).map((c) => `${c.name} (0 / ${c.total})`).join(', ')}`)}</p>
      )}
      {people.length > 0 && (
        <section class="ent-sec">
          <h2 class="hub-sechead">{tr('実績と記録（冒険者ごと）', 'Feats and records (by adventurer)')}</h2>
          <div class="ent-feats">
            {people.map((p) => (
              <details key={p.id} class="ent-card ent-fold">
                <summary><span class="ent-who">{p.name}</span><span class="ent-meta">{tr(`実績 ${p.earned.length} / ${p.total}`, `Feats ${p.earned.length} / ${p.total}`)}</span></summary>
                {p.earned.length > 0 && (
                  <ul class="ent-featlist">
                    {p.earned.map((f) => <li key={f.id}><span class="ent-featname">{f.name}</span>{f.desc && <span class="ent-featdesc">{f.desc}</span>}</li>)}
                  </ul>
                )}
                {p.record && <PersonRecordBlock record={p.record} />}
              </details>
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}

/**
 * 1 人ずつの記録（S16d: 前の「記録」のタブにあったもの）: 1 行（ラン数・確定の最高・最深）と称号、「すべて見る」で records の全文（たたむ）。
 * 記録はシーズンで足りるので、目立たせない（無くさないだけ）
 */
function PersonRecordBlock({ record }: { record: PersonRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <div class="ent-record">
      <p class="hub-note">{personRecordLine(record)}</p>
      {record.titles.length > 0 && <p class="hub-note titles">{tr('称号', 'Titles')}: {record.titles.map((t, i) => <span key={i} class="tag title">{t}</span>)}</p>}
      {record.text && (
        <>
          <button type="button" class="hub-linkbtn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? tr('たたむ', 'Hide') : tr('すべて見る', 'Show all')}</button>
          {open && <pre class="records">{record.text}</pre>}
        </>
      )}
    </div>
  );
}

function CodexCategoryCard({ cat }: { cat: ReturnType<typeof mergeCodexBooks>[number] }) {
  const [all, setAll] = useState(false);
  const shown = all ? cat.entries : cat.entries.slice(0, CODEX_ITEMS);
  const pct = cat.total ? Math.round((cat.entries.length / cat.total) * 100) : 0;
  return (
    <section class="ent-sec">
      <div class="ent-sechead">
        <h2 class="hub-sechead">{cat.name}</h2>
        <span class="ent-meta">{cat.entries.length} / {cat.total}</span>
      </div>
      <div class="ent-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      {cat.entries.length === 0
        ? <p class="hub-note">{tr('まだ、だれも見つけていない。', 'Nobody has found any yet.')}</p>
        : (
          <ul class="ent-entries">
            {shown.map((e) => (
              <li key={e.id} class="ent-entry" title={e.details.length ? e.details.map((d) => `${d.who}: ${d.detail}`).join('\n') : undefined}>
                <span class="ent-entryname">{e.name}</span>
                <span class="ent-finders">{findersText(e.finders)}</span>
              </li>
            ))}
          </ul>
        )}
      {cat.entries.length > CODEX_ITEMS && (
        <button type="button" class="hub-linkbtn ent-more" onClick={() => setAll(!all)}>
          {all ? tr('たたむ', 'Show fewer') : tr(`もっと見る（全 ${cat.entries.length} 件）`, `Show more (${cat.entries.length} in all)`)}
        </button>
      )}
    </section>
  );
}

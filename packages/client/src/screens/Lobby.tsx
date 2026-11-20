// ロビー: 進行中のラン（観戦・参加・再開）、終了したラン（リプレイ）、リーダーボード、新規ラン。
import type { LeaderboardEntry, Locale, ProfileRecords, RunListing } from '@muse/shared';
import { endReasonText, kindName, nameOf, objectiveText } from '@muse/shared';
import { useEffect, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import { ErrorBanner, Header, useCatalog, useLocaleRefresh } from '../ui/common';
import { FIRST_EXPEDITION_CHOICES, playerStateLabel, type FirstExpeditionChoice } from '../ui/labels';
import { fmtTime, getLocale, getPref, getToken, navigate, saveToken, setPref, tr } from '../util';

function firstChoice(v: string): FirstExpeditionChoice {
  return FIRST_EXPEDITION_CHOICES.find((o) => o.id === v)?.id ?? 'camp';
}

export function Lobby() {
  useLocaleRefresh();
  const { catalog, error: catErr } = useCatalog();
  const [runs, setRuns] = useState<RunListing[] | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(getPref('name', 'Adventurer'));
  const [classId, setClassId] = useState(getPref('class', 'core:warrior'));
  const [seed, setSeed] = useState('');
  const [mode, setMode] = useState<'solo' | 'coop'>('solo');
  const [locale, setLoc] = useState<Locale>(getLocale());
  // 旧版の pref（'objective'。既定 auto で保存されている）は読まない: 既定は「キャンプで選ぶ」
  const [objective, setObjective] = useState<FirstExpeditionChoice>(firstChoice(getPref('firstExpedition', 'camp')));
  const [busy, setBusy] = useState(false);
  // プロフィール（V3-7 §7.1）: トークンはこのブラウザに残し、次のランに渡す（記録・図鑑・継承）
  const [profileToken, setProfileToken] = useState(getPref('profileToken', ''));
  const [legacy, setLegacy] = useState(getPref('legacy', 'on') !== 'off');
  const [records, setRecords] = useState<{ text: string; records: ProfileRecords } | null>(null);
  const [showRecords, setShowRecords] = useState(false);
  const L = getLocale();
  useEffect(() => {
    if (!profileToken) { setRecords(null); return; }
    api.records(profileToken, L).then(setRecords).catch(() => setRecords(null));
  }, [profileToken, L]);
  const keepProfile = (tok?: string) => { if (tok) { setPref('profileToken', tok); setProfileToken(tok); } };

  const refresh = () => {
    api.runs().then((r) => { setRuns(r); setError(null); }).catch((e) => setError(errorText(e)));
    api.leaderboard().then(setBoard).catch(() => undefined);
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  const start = async () => {
    setBusy(true);
    try {
      setPref('name', name);
      setPref('class', classId);
      setPref('firstExpedition', objective);
      // camp: objective を省くとキャンプから始まる（候補 3 つから最初の遠征を選ぶ）
      setPref('legacy', legacy ? 'on' : 'off');
      const r = await api.newRun({ name, classId, mode, seed: seed || undefined, locale, controller: { kind: 'human', label: 'browser' }, ...(objective === 'camp' ? {} : { objective }), ...(profileToken ? { profileToken } : {}), legacy });
      keepProfile(r.profileToken);
      saveToken(r.runId, { token: r.token, playerId: r.playerId, name });
      navigate(`#/play/${r.runId}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const join = async (runId: string) => {
    setBusy(true);
    try {
      const r = await api.joinRun(runId, { name, classId, locale, controller: { kind: 'human', label: 'browser' }, ...(profileToken ? { profileToken } : {}), legacy });
      keepProfile(r.profileToken);
      saveToken(r.runId, { token: r.token, playerId: r.playerId, name });
      navigate(`#/play/${r.runId}`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const active = (runs ?? []).filter((r) => r.status === 'active');
  const ended = (runs ?? []).filter((r) => r.status === 'ended').sort((a, b) => b.updatedAt - a.updatedAt);
  const classes = catalog ? Object.entries(catalog.classes) : [];

  const playersText = (r: RunListing) => r.players.map((p) => {
    const sp = r.summary?.players.find((x) => x.id === p.id);
    const banked = sp?.banked !== undefined ? tr(` 確定${sp.banked}`, ` banked ${sp.banked}`) : '';
    return `${p.name}(${p.controller.kind === 'agent' ? 'AI' : p.controller.kind === 'unknown' ? '?' : tr('人', 'H')}${p.depth ? ` B${p.depth}` : ''} Lv${p.level}${p.state !== 'alive' ? ` ${playerStateLabel(p.state)}` : ''}${banked})`;
  }).join(', ');

  // スコアの版ごとに別の表（版 2: 確定点 → 達成した遠征の数 → 最深。版 1 は旧スコア）
  // 継承したラン（V3-7 §7.3）は別の表
  const byScore = (a: LeaderboardEntry, b: LeaderboardEntry) => b.score - a.score || (b.expeditions ?? 0) - (a.expeditions ?? 0) || b.deepest - a.deepest;
  const boardV2 = board.filter((b) => b.scoreVersion === 2 && !b.legacy).sort(byScore);
  const boardV2Legacy = board.filter((b) => b.scoreVersion === 2 && b.legacy).sort(byScore);
  const boardV1 = board.filter((b) => b.scoreVersion !== 2); // 旧表はサーバーの並び順のまま

  const boardRow = (b: LeaderboardEntry, i: number, v2: boolean) => (
    <tr key={`${b.runId}-${b.playerId}`} class={b.ongoing ? 'ongoing' : ''}>
      <td>{i + 1}</td>
      <td>
        {b.name} <span class={`tag ${b.controller.kind}`}>{b.controller.kind === 'agent' ? 'AI' : b.controller.kind === 'unknown' ? tr('不明', 'unknown') : tr('人間', 'human')}</span> <small>{catalog ? kindName(catalog, L, b.classId) : b.classId}</small>
        {b.ongoing && <span class="tag ongoing" title={tr('ランは終了していない（キャンプ中の記録）', 'The run has not ended (recorded at camp)')}>{tr('継続中', 'ongoing')}</span>}
      </td>
      {v2 && <td class="primary-col">{b.score}</td>}
      <td class={v2 ? '' : 'primary-col'}>{b.expeditions ?? 0}</td>
      <td>{b.deepest}</td><td>{b.level}</td><td>{b.kills}</td>
      {!v2 && <td>{b.score}</td>}
      <td><a href={`#/replay/${b.runId}`}>▶</a></td>
    </tr>
  );

  /** 遠征の要約: 達成数と、今の遠征（またはキャンプ・最後の遠征の結果） */
  const expeditionText = (r: RunListing): string | null => {
    const xs = r.expeditions;
    if (!xs?.length) return null;
    const done = xs.filter((x) => x.endReason === 'completed').length;
    const last = xs[xs.length - 1];
    const cur = last.status !== 'ended'
      ? tr(`遠征 ${last.no} 進行中: ${objectiveText(L, last.objective)}`, `Expedition ${last.no} in progress: ${objectiveText(L, last.objective)}`)
      : r.status === 'active'
        ? tr(`キャンプ中（遠征 ${last.no} は${endReasonText(L, last.endReason)}）`, `At camp (expedition ${last.no}: ${endReasonText(L, last.endReason)})`)
        : tr(`最後: 遠征 ${last.no}（${endReasonText(L, last.endReason)}）`, `Last: expedition ${last.no} (${endReasonText(L, last.endReason)})`);
    return `${tr(`遠征達成 ${done}`, `${done} completed`)} / ${cur}`;
  };

  return (
    <div class="page">
      <Header title={tr('ロビー', 'Lobby')} />
      <ErrorBanner error={error ?? catErr} onClose={() => setError(null)} />
      <div class="lobby">
        <section class="panel">
          <h3>{tr('新しいラン', 'New run')}</h3>
          <div class="form">
            <label>{tr('名前', 'Name')}<input value={name} maxLength={32} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
            <label>{tr('クラス', 'Class')}
              <select value={classId} onChange={(e) => setClassId((e.target as HTMLSelectElement).value)}>
                {classes.map(([id, c]) => <option key={id} value={id}>{nameOf(c.name, L, id)}</option>)}
                {!classes.length && <option value="core:warrior">core:warrior</option>}
              </select>
            </label>
            {catalog?.classes[classId] && <p class="muted">{nameOf(catalog.classes[classId].desc, L, '')}</p>}
            <label>{tr('モード', 'Mode')}
              <select value={mode} onChange={(e) => setMode((e.target as HTMLSelectElement).value as 'solo' | 'coop')}>
                <option value="solo">{tr('ソロ', 'Solo')}</option>
                <option value="coop">COOP</option>
              </select>
            </label>
            <label>{tr('最初の遠征', 'First expedition')}
              <select value={objective} onChange={(e) => setObjective(firstChoice((e.target as HTMLSelectElement).value))}>
                {FIRST_EXPEDITION_CHOICES.map((o) => <option key={o.id} value={o.id}>{L === 'en' ? o.en : o.ja}</option>)}
              </select>
            </label>
            {objective === 'camp' && <p class="muted">{tr('キャンプから始まり、目標の深さ・推奨レベル・条件の違う 3 つの候補から最初の遠征を選ぶ。', 'You start at camp and choose the first expedition from 3 offers with different depths, recommended levels and traits.')}</p>}
            <label>{tr('シード（任意）', 'Seed (optional)')}<input value={seed} onInput={(e) => setSeed((e.target as HTMLInputElement).value)} /></label>
            <label>{tr('メッセージ言語', 'Message language')}
              <select value={locale} onChange={(e) => setLoc((e.target as HTMLSelectElement).value as Locale)}>
                <option value="ja">日本語</option><option value="en">English</option>
              </select>
            </label>
            <label class="check"><input type="checkbox" checked={legacy} onChange={(e) => setLegacy((e.target as HTMLInputElement).checked)} />{tr('図鑑の知識を引き継ぐ（継承）', 'Inherit codex knowledge (legacy)')}</label>
            <button class="primary" disabled={busy || !name.trim()} onClick={start}>{tr('冒険を始める', 'Start')}</button>
          </div>
        </section>

        <section class="panel">
          <h3>{tr('記録と図鑑', 'Records and codex')}</h3>
          {!profileToken && <p class="muted">{tr('最初のランを始めるとプロフィールが作られ、このブラウザに残る。次のランから記録・図鑑・実績が積まれる。', 'Your first run creates a profile kept in this browser; records, codex and feats stack from then on.')}</p>}
          {profileToken && !records && <div class="muted">{tr('読み込み中…', 'Loading…')}</div>}
          {records && (
            <div>
              <p>{records.records.profile.name} <small class="muted">{records.records.profile.id}</small></p>
              <p class="sub">{tr(`ラン ${records.records.runs.total}・確定の最高 ${records.records.banked.best}・最深 地下${records.records.deepest}階・図鑑 ${records.records.next.codex}・実績 ${records.records.next.feats}`, `${records.records.runs.total} runs, best banked ${records.records.banked.best}, deepest ${records.records.deepest}, codex ${records.records.next.codex}, feats ${records.records.next.feats}`)}</p>
              <div class="row">
                <button class="small" onClick={() => setShowRecords(!showRecords)}>{showRecords ? tr('閉じる', 'Hide') : tr('すべて見る', 'Show all')}</button>
                <button class="small" onClick={() => { if (confirm(tr('このブラウザのプロフィールを外す（記録はサーバーに残る）。次のランは新しいプロフィールになる。', 'Forget this profile in this browser (records stay on the server). Your next run starts a new profile.'))) { setPref('profileToken', ''); setProfileToken(''); } }}>{tr('新しいプロフィールにする', 'Start a new profile')}</button>
              </div>
              {showRecords && <pre class="records">{records.text}</pre>}
            </div>
          )}
        </section>

        <section class="panel">
          <h3>{tr('進行中のラン', 'Active runs')} <button class="tiny" onClick={refresh}>↻</button></h3>
          {runs === null && <div class="muted">{tr('読み込み中…', 'Loading…')}</div>}
          {runs !== null && active.length === 0 && <div class="muted">{tr('なし', 'None')}</div>}
          <ul class="runs">
            {active.map((r) => {
              const tok = getToken(r.runId);
              return (
                <li key={r.runId}>
                  <div><code>{r.runId}</code> <span class="tag">{r.mode}</span> <small>seq {r.seq}</small></div>
                  <div class="sub">{playersText(r)}</div>
                  {expeditionText(r) && <div class="sub exp">{expeditionText(r)}</div>}
                  <div class="row">
                    <a class="button small" href={`#/watch/${r.runId}`}>{tr('観戦', 'Watch')}</a>
                    <a class="button small" href={`#/replay/${r.runId}`}>{tr('巻き戻し', 'Rewind')}</a>
                    {tok && <a class="button small primary" href={`#/play/${r.runId}`}>{tr('再開', 'Resume')}</a>}
                    {r.joinable && !tok && <button class="small" disabled={busy} onClick={() => join(r.runId)}>{tr('参加', 'Join')}</button>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section class="panel">
          <h3>{tr('終了したラン', 'Finished runs')}</h3>
          {runs !== null && ended.length === 0 && <div class="muted">{tr('なし', 'None')}</div>}
          <ul class="runs">
            {ended.slice(0, 30).map((r) => (
              <li key={r.runId}>
                <div><code>{r.runId}</code> <small>{fmtTime(r.updatedAt)}</small></div>
                <div class="sub">{playersText(r)}</div>
                {expeditionText(r) && <div class="sub exp">{expeditionText(r)}</div>}
                <div class="row"><a class="button small" href={`#/replay/${r.runId}`}>{tr('リプレイ', 'Replay')}</a></div>
              </li>
            ))}
          </ul>
        </section>

        <section class="panel">
          <h3>{tr('リーダーボード', 'Leaderboard')}</h3>
          {board.length === 0 && <div class="muted">{tr('記録なし', 'No records')}</div>}
          {board.length > 0 && (
            <>
              <h4 title={tr('持ち帰って確定した点の合計。同点なら達成した遠征の数、最深の順', 'Sum of banked points; ties by completed expeditions, then deepest')}>
                {tr('スコア（確定点）', 'Score (banked points)')}
              </h4>
              {boardV2.length === 0 && <div class="muted">{tr('まだ記録なし', 'No records yet')}</div>}
              {boardV2.length > 0 && (
                <table class="board">
                  <thead><tr>
                    <th>#</th><th>{tr('名前', 'Name')}</th><th>{tr('確定点', 'Banked')}</th><th title={tr('達成した遠征の数', 'Completed expeditions')}>{tr('遠征', 'Exp.')}</th>
                    <th>{tr('到達', 'Depth')}</th><th>Lv</th><th>{tr('撃破', 'Kills')}</th><th></th>
                  </tr></thead>
                  <tbody>{boardV2.slice(0, 20).map((b, i) => boardRow(b, i, true))}</tbody>
                </table>
              )}
              {boardV2Legacy.length > 0 && (
                <details class="board-old" open>
                  <summary>{tr(`継承ありのラン ${boardV2Legacy.length} 件`, `Runs with legacy: ${boardV2Legacy.length}`)}</summary>
                  <p class="muted small">{tr('前のランの図鑑の知識を引き継いだラン。継承なしの表とは分ける。', 'Runs that inherited codex knowledge; kept apart from the table above.')}</p>
                  <table class="board">
                    <thead><tr>
                      <th>#</th><th>{tr('名前', 'Name')}</th><th>{tr('確定点', 'Banked')}</th><th title={tr('達成した遠征の数', 'Completed expeditions')}>{tr('遠征', 'Exp.')}</th>
                      <th>{tr('到達', 'Depth')}</th><th>Lv</th><th>{tr('撃破', 'Kills')}</th><th></th>
                    </tr></thead>
                    <tbody>{boardV2Legacy.slice(0, 20).map((b, i) => boardRow(b, i, true))}</tbody>
                  </table>
                </details>
              )}
              {boardV1.length > 0 && (
                <details class="board-old">
                  <summary>{tr(`旧スコア（版1）の記録 ${boardV1.length} 件`, `Old score (v1): ${boardV1.length} records`)}</summary>
                  <p class="muted small">{tr('深度などから計算した旧方式のスコア。確定点とは比べられない。', 'Depth-based old scoring; not comparable with banked points.')}</p>
                  <table class="board">
                    <thead><tr>
                      <th>#</th><th>{tr('名前', 'Name')}</th><th title={tr('達成した遠征の数', 'Completed expeditions')}>{tr('遠征', 'Exp.')}</th>
                      <th>{tr('到達', 'Depth')}</th><th>Lv</th><th>{tr('撃破', 'Kills')}</th><th>{tr('スコア（版1）', 'Score (v1)')}</th><th></th>
                    </tr></thead>
                    <tbody>{boardV1.slice(0, 20).map((b, i) => boardRow(b, i, false))}</tbody>
                  </table>
                </details>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

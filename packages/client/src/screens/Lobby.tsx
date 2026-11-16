// ロビー: 進行中のラン（観戦・参加・再開）、終了したラン（リプレイ）、リーダーボード、新規ラン。
import type { LeaderboardEntry, Locale, ObjectiveChoice, RunListing } from '@muse/shared';
import { endReasonText, kindName, nameOf, objectiveText } from '@muse/shared';
import { useEffect, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import { ErrorBanner, Header, useCatalog, useLocaleRefresh } from '../ui/common';
import { OBJECTIVE_CHOICES, playerStateLabel } from '../ui/labels';
import { fmtTime, getLocale, getPref, getToken, navigate, saveToken, setPref, tr } from '../util';

function objectiveChoice(v: string): ObjectiveChoice {
  return OBJECTIVE_CHOICES.find((o) => o.id === v)?.id ?? 'auto';
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
  const [objective, setObjective] = useState<ObjectiveChoice>(objectiveChoice(getPref('objective', 'auto')));
  const [busy, setBusy] = useState(false);
  const L = getLocale();

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
      setPref('objective', objective);
      const r = await api.newRun({ name, classId, mode, seed: seed || undefined, locale, controller: { kind: 'human', label: 'browser' }, objective });
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
      const r = await api.joinRun(runId, { name, classId, locale, controller: { kind: 'human', label: 'browser' } });
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

  const playersText = (r: RunListing) => r.players.map((p) => `${p.name}(${p.controller.kind === 'agent' ? 'AI' : tr('人', 'H')}${p.depth ? ` B${p.depth}` : ''} Lv${p.level}${p.state !== 'alive' ? ` ${playerStateLabel(p.state)}` : ''})`).join(', ');

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
            <label>{tr('最初の遠征の目的', 'First expedition objective')}
              <select value={objective} onChange={(e) => setObjective(objectiveChoice((e.target as HTMLSelectElement).value))}>
                {OBJECTIVE_CHOICES.map((o) => <option key={o.id} value={o.id}>{L === 'en' ? o.en : o.ja}</option>)}
              </select>
            </label>
            <label>{tr('シード（任意）', 'Seed (optional)')}<input value={seed} onInput={(e) => setSeed((e.target as HTMLInputElement).value)} /></label>
            <label>{tr('メッセージ言語', 'Message language')}
              <select value={locale} onChange={(e) => setLoc((e.target as HTMLSelectElement).value as Locale)}>
                <option value="ja">日本語</option><option value="en">English</option>
              </select>
            </label>
            <button class="primary" disabled={busy || !name.trim()} onClick={start}>{tr('冒険を始める', 'Start')}</button>
          </div>
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
            <table class="board">
              <thead><tr><th>#</th><th>{tr('名前', 'Name')}</th><th title={tr('達成した遠征の数', 'Completed expeditions')}>{tr('遠征', 'Exp.')}</th><th>{tr('到達', 'Depth')}</th><th>Lv</th><th>{tr('撃破', 'Kills')}</th><th>{tr('スコア', 'Score')}</th><th></th></tr></thead>
              <tbody>
                {board.slice(0, 20).map((b, i) => (
                  <tr key={`${b.runId}-${b.playerId}`} class={b.ongoing ? 'ongoing' : ''}>
                    <td>{i + 1}</td>
                    <td>
                      {b.name} <span class={`tag ${b.controller.kind}`}>{b.controller.kind === 'agent' ? 'AI' : tr('人間', 'human')}</span> <small>{catalog ? kindName(catalog, L, b.classId) : b.classId}</small>
                      {b.ongoing && <span class="tag ongoing" title={tr('ランは終了していない（キャンプ中の記録）', 'The run has not ended (recorded at camp)')}>{tr('継続中', 'ongoing')}</span>}
                    </td>
                    <td class="primary-col">{b.expeditions ?? 0}</td>
                    <td>{b.deepest}</td><td>{b.level}</td><td>{b.kills}</td><td>{b.score}</td>
                    <td><a href={`#/replay/${b.runId}`}>▶</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}

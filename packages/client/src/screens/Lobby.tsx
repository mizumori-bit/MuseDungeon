// ホーム（S8 の H2。SEASON.md §54.7・HUMAN.md §5）: タブ 2 つ。見た目（色・絵・演出）は変えず、何をどこに出すかだけを並べ替えた。
// 「出撃」（最初に開く。#/）: 今シーズンの自分のラン（持ち主の枠。無ければシーズンの参加）・今シーズンの順位・ほかのラン（畳む: 続きのある自分のラン・
//   シーズンでないラン・観戦できるラン・新しいラン）。
// 「記録」（#/records）: シーズンの一覧 → 順位 → 参加者ごとのリプレイ・結果の画面・共有層の出来事・称号・図鑑と実績・過去のラン・リーダーボード。
// 持ち主のラン（GET /api/owner/runs）は、このブラウザに覚えてあるトークン（プロフィールと、シーズンの招き）ごとに呼んで、ランの ID でまとめる。
// トークンは見出しでだけ渡し、画面・URL・console に出さない。
import type { LeaderboardEntry, Locale, OwnerRunRow, ProfileRecords, RunListing, SeasonListing, SeasonStandingRow, SeasonStandingsResponse, SeasonWatchResponse } from '@muse/shared';
import { endReasonText, kindName, nameOf, objectiveText } from '@muse/shared';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, errorText } from '../api';
import { ErrorBanner, Header, useCatalog, useLocaleRefresh } from '../ui/common';
import { normName, SeasonSharedFlow, sortStandings, STANDING_SORTS, standingSortName, StandingsTable, type StandingSort } from '../ui/home';
import { FIRST_EXPEDITION_CHOICES, playerStateLabel, type FirstExpeditionChoice } from '../ui/labels';
import { OwnerRunCard } from '../ui/owner';
import { fmtTime, getLocale, getPref, getToken, inLocale, navigate, saveToken, setPref, tr } from '../util';

export type HomeTab = 'sortie' | 'records';

function firstChoice(v: string): FirstExpeditionChoice {
  return FIRST_EXPEDITION_CHOICES.find((o) => o.id === v)?.id ?? 'camp';
}

/** 持ち主のラン: rows（ランの ID でまとめた行）・token（そのランを返したトークン。無ければ同じ機械から）・mine（外からトークンで認められた = 自分のもの） */
interface OwnerState { rows: OwnerRunRow[]; token: Record<string, string>; mine: Set<string>; local: boolean }

/** このブラウザに覚えてあるトークン（プロフィールと、シーズンごとの招き）。重ならないように */
function storedTokens(seasonIds: readonly string[]): string[] {
  const toks = [getPref('profileToken', ''), ...seasonIds.map((id) => getPref(`seasonToken.${id}`, ''))].filter(Boolean);
  return [...new Set(toks)];
}

/** シーズンの並び（開催中 → 確定待ち → 確定。その中は終わりの時刻の新しい順） */
const SEASON_ORDER: Record<SeasonListing['status'], number> = { open: 0, ended: 1, final: 2 };
const bySeason = (a: SeasonStandingsResponse, b: SeasonStandingsResponse) => SEASON_ORDER[a.season.status] - SEASON_ORDER[b.season.status] || b.season.endsAt - a.season.endsAt;

export function Lobby({ tab = 'sortie' }: { tab?: HomeTab }) {
  useLocaleRefresh();
  const { catalog, error: catErr } = useCatalog();
  const [runs, setRuns] = useState<RunListing[] | null>(null);
  const [board, setBoard] = useState<LeaderboardEntry[]>([]);
  // シーズン（S0。PROTOCOL §9.8）: 開いている・終わったシーズンの順位の表
  const [seasons, setSeasons] = useState<SeasonStandingsResponse[]>([]);
  // シーズンの一覧を一度でも読んだか（「ほかのラン」を既定で開くかを、読む前に決めない）
  const [seasonsLoaded, setSeasonsLoaded] = useState(false);
  // シーズンの参加（S2 §18.1）: 前の版では、招かれたプロフィールのトークンをシーズンごとに覚えた（seasonToken.<id>）。S8b からは
  // 「AI のランの持ち主になる」の 1 つの欄（profileToken）に覚える。前に覚えたものも読む（画面には伏せて出す。URL・記録には出さない）
  const [seasonTok, setSeasonTok] = useState<Record<string, string>>({});
  // 観戦できるラン（S3 §25.1）: 開催中のシーズンのランは、このブラウザに覚えてあるトークンのランか、同じ機械から開いているときだけ。
  // withTok: トークンを付けて訊いた（外からなら、返ったランはそのトークンのもの）
  const [watch, setWatch] = useState<Record<string, SeasonWatchResponse & { withTok: boolean }>>({});
  // 持ち主のラン（S8 §54.5）
  const [owner, setOwner] = useState<OwnerState>({ rows: [], token: {}, mine: new Set(), local: false });
  // プロフィールの記録の直近のラン（自分のランを見分ける。トークンごと）
  const [recentMine, setRecentMine] = useState<string[]>([]);
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
  // 称号（S2 §18.2）: プロフィールの表示（/api/profile）から
  const [titles, setTitles] = useState<string[]>([]);
  // 記録のタブ: 自分だけに絞る・並べ替え（このブラウザに覚える）
  const [onlyMine, setOnlyMineState] = useState(getPref('records.onlyMine', 'off') === 'on');
  const [sortBy, setSortByState] = useState<StandingSort>(STANDING_SORTS.find((k) => k === getPref('records.sort', 'adventure')) ?? 'adventure');
  const setOnlyMine = (v: boolean) => { setPref('records.onlyMine', v ? 'on' : 'off'); setOnlyMineState(v); };
  const setSortBy = (k: StandingSort) => { setPref('records.sort', k); setSortByState(k); };
  const L = getLocale();
  useEffect(() => {
    if (!profileToken) { setRecords(null); return; }
    api.records(profileToken, L).then(setRecords).catch(() => setRecords(null));
    api.profile(profileToken, L).then((p) => setTitles((p.titles ?? []).map((x) => x.name))).catch(() => setTitles([]));
  }, [profileToken, L]);
  const keepProfile = (tok?: string) => { if (tok) { setPref('profileToken', tok); setProfileToken(tok); } };
  // 「出撃」のプロフィールのトークンの欄（S8a §55.6 の 6）
  const [profDraft, setProfDraft] = useState('');
  // 自分のラン（記録のタブの「自分だけ」・順位の表の自分の行）: 覚えてあるトークンのプロフィールの直近のラン
  const tokKey = [profileToken, ...Object.values(seasonTok)].join('\u0000');
  useEffect(() => {
    const toks = [...new Set([profileToken, ...Object.values(seasonTok)].filter(Boolean))];
    if (!toks.length) { setRecentMine([]); return; }
    Promise.all(toks.map((t) => api.records(t, L).then((r) => r.records.recent.map((x) => x.run_id)).catch(() => [] as string[])))
      .then((xs) => setRecentMine([...new Set(xs.flat())]));
  }, [tokKey]);

  /** 持ち主のラン（S8）: トークンなしで 1 回（同じ機械なら全部返る）と、覚えてあるトークンごとに 1 回。ランの ID でまとめる */
  const refreshOwner = async (seasonIds: readonly string[]) => {
    const calls: (string | undefined)[] = [undefined, ...storedTokens(seasonIds)];
    const res = await Promise.all(calls.map((t) => api.ownerRuns(t).then((r) => ({ t, r })).catch(() => null)));
    const rows = new Map<string, OwnerRunRow>();
    const token: Record<string, string> = {};
    const mine = new Set<string>();
    let local = false;
    let any = false;
    for (const x of res) {
      if (!x) continue;
      any = true;
      local = local || x.r.local;
      for (const row of x.r.runs) {
        const prev = rows.get(row.runId);
        if (!prev || row.updatedAt >= prev.updatedAt) rows.set(row.runId, row);
        // 以後、そのランへの持ち主の呼び出しには、そのランを返したトークンを使う
        // 自分のラン（S8a）: サーバーが、送ったトークンのプレイヤーのランに mine を付ける（同じ機械からだけで認めたランは付かない）
        if (x.t && row.mine && !token[row.runId]) token[row.runId] = x.t;
        if (row.mine) mine.add(row.runId);
      }
    }
    if (!any) return;
    const list = [...rows.values()].sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.updatedAt - a.updatedAt);
    setOwner({ rows: list, token, mine, local });
  };

  const refresh = () => {
    api.runs().then((r) => { setRuns(r); setError(null); }).catch((e) => setError(errorText(e)));
    api.leaderboard().then(setBoard).catch(() => undefined);
    const seasonsP = api.seasons().then((list) => Promise.all(list.map((x) => api.season(x.id))));
    seasonsP.then(async (list) => {
      setSeasons(list);
      setSeasonsLoaded(true);
      const toks = Object.fromEntries(list.map((x) => [x.season.id, getPref(`seasonToken.${x.season.id}`, '')]).filter(([, v]) => v));
      setSeasonTok(toks);
      // 観戦の口は、シーズンの招きのトークン（無ければプロフィールのトークン）を見出しで
      const prof = getPref('profileToken', '');
      const ws = await Promise.all(list.map((x) => {
        const t = toks[x.season.id] || prof || undefined;
        return api.seasonWatch(x.season.id, t).then((r) => [x.season.id, { ...r, withTok: !!t }] as const).catch(() => null);
      }));
      setWatch(Object.fromEntries(ws.filter((x): x is readonly [string, SeasonWatchResponse & { withTok: boolean }] => !!x)));
    }).catch(() => setSeasonsLoaded(true));
    void seasonsP.catch(() => [] as SeasonStandingsResponse[]).then((list) => refreshOwner(list.map((x) => x.season.id)));
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  // 冒険者 1 人に続きは 1 つ（S9。SEASON.md §58.3）: run_in_progress を受けたら、画面の中の確かめの窓を出し、同意で endPrevious を付けて出し直す
  const [endPrev, setEndPrev] = useState<{ runId: string; retry: () => Promise<void> } | null>(null);
  const inProgressOf = (e: unknown): string | null => (e instanceof ApiError && e.error?.code === 'run_in_progress' ? e.error.details?.in_progress?.run_id ?? '' : null);

  const start = async (endPrevious = false) => {
    setBusy(true);
    try {
      setPref('name', name);
      setPref('class', classId);
      setPref('firstExpedition', objective);
      // camp: objective を省くとキャンプから始まる（候補 3 つから最初の遠征を選ぶ）
      setPref('legacy', legacy ? 'on' : 'off');
      const r = await api.newRun({ name, classId, mode, seed: seed || undefined, locale, controller: { kind: 'human', label: 'browser' }, ...(objective === 'camp' ? {} : { objective }), ...(profileToken ? { profileToken } : {}), legacy, ...(endPrevious ? { endPrevious: true } : {}) });
      keepProfile(r.profileToken);
      saveToken(r.runId, { token: r.token, playerId: r.playerId, name });
      navigate(`#/play/${r.runId}`);
    } catch (e) {
      const prev = inProgressOf(e);
      if (prev !== null && !endPrevious) setEndPrev({ runId: prev, retry: () => start(true) });
      else setError(errorText(e));
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

  /** シーズンのランを始める（AI の new_run { season, profile_token } と同じ POST /api/runs）。断られたらサーバーの理由をそのまま出す */
  /** そのシーズンで使うプロフィールのトークン（S8b: 前の版でシーズンごとに覚えたもの、無ければ「AI のランの持ち主になる」の欄で覚えたもの） */
  const seasonTokFor = (id: string): string => seasonTok[id] || profileToken;
  const joinSeason = async (id: string, endPrevious = false) => {
    const tok = seasonTokFor(id);
    if (!tok) { setError(tr('招かれたプロフィールのトークン（運用者から受け取ったもの）を、「AI のランの持ち主になる」の欄に入れる', 'Put the profile token the operator gave you in the "Become the owner" box')); return; }
    setBusy(true);
    try {
      setPref('name', name);
      setPref('class', classId);
      const r = await api.newRun({ name, classId, locale, controller: { kind: 'human', label: 'browser' }, season: id, profileToken: tok, ...(endPrevious ? { endPrevious: true } : {}) });
      saveToken(r.runId, { token: r.token, playerId: r.playerId, name });
      navigate(`#/play/${r.runId}`);
    } catch (e) {
      const prev = inProgressOf(e);
      if (prev !== null && !endPrevious) setEndPrev({ runId: prev, retry: () => joinSeason(id, true) });
      else setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  /** シーズンのラン（S3 §25.1）: 観戦できるか（確定する前は、覚えてあるトークンのランか、同じ機械からだけ）・巻き戻せるか（確定する前は、同じ機械から、ランが終わった後だけ） */
  const canWatch = (r: RunListing) => !r.season || !!watch[r.season]?.runs.some((x) => x.runId === r.runId);
  const canRewind = (r: RunListing) => {
    if (!r.season) return true;
    const sw = watch[r.season];
    return !!sw && (sw.final || (sw.local && r.status === 'ended'));
  };
  // 確定したシーズンのラン（S9a §57.3 の 4）: 命令を受けない記録。「出撃」には出さず（「再開」を出さない）、「記録」の終わったランに並べる
  const finalSeasons = new Set(seasons.filter((x) => x.season.status === 'final').map((x) => x.season.id));
  const closedRun = (r: RunListing) => !!r.season && finalSeasons.has(r.season);
  // シーズンの一覧を読み込むまでは、シーズンのランを「出撃」に出さない（S9b: 確定したランが、読み込みの前の一瞬だけ出ていた）
  const active = (runs ?? []).filter((r) => r.status === 'active' && !closedRun(r) && (seasonsLoaded || !r.season));
  const ended = (runs ?? []).filter((r) => r.status === 'ended' || closedRun(r)).sort((a, b) => b.updatedAt - a.updatedAt);
  const classes = catalog ? Object.entries(catalog.classes) : [];

  // ---- 自分のラン・自分の名前（分かる範囲で） ----
  // このブラウザで遊んでいるラン・外からトークンで認められた持ち主のラン・覚えてあるトークンのプロフィールの直近のラン
  const myRunIds = new Set<string>([...(runs ?? []).filter((r) => getToken(r.runId)).map((r) => r.runId), ...owner.mine, ...recentMine]);
  /** そのシーズンのランの参加者の名前（順位の表の名前。観戦の口が返した名前があればそれ、無ければランのプレイヤーの名前） */
  const participantOf = (r: RunListing): string => (r.season ? watch[r.season]?.runs.find((x) => x.runId === r.runId)?.name : undefined) ?? r.players[0]?.name ?? '';
  /**
   * そのシーズンの、自分の行の名前（normName）。持ち主のランのシーズンでの表示名（season.participant）と、順位の表の行のランの ID（runIds）で結ぶ。
   * どちらも無いときだけ、観戦の口の名前・ランの名前から推す
   */
  const myNames = (sid: string, rows: readonly SeasonStandingRow[]): Set<string> => {
    const out = new Set<string>();
    for (const row of owner.rows) {
      if (row.season?.id === sid && row.season.participant && (!owner.local || myRunIds.has(row.runId))) out.add(normName(row.season.participant));
    }
    for (const r of rows) if (r.runIds?.some((id) => myRunIds.has(id))) out.add(normName(r.name));
    if (out.size) return out;
    const sw = watch[sid];
    for (const x of sw?.runs ?? []) if ((sw!.withTok && !sw!.local) || myRunIds.has(x.runId)) out.add(normName(x.name));
    for (const r of runs ?? []) if (r.season === sid && myRunIds.has(r.runId)) out.add(normName(participantOf(r)));
    for (const row of owner.rows) if (row.season?.id === sid && myRunIds.has(row.runId)) out.add(normName(row.name));
    return out;
  };

  const playersText = (r: RunListing) => r.players.map((p) => {
    // 進行中のシーズンのラン（S2a）: サーバーが状態・階・レベルを伏せる。名前とシーズンのランであることだけ
    if (p.hidden) return `${p.name}(${p.controller.kind === 'agent' ? 'AI' : p.controller.kind === 'unknown' ? '?' : tr('人', 'H')} ${tr(`シーズン ${r.season ?? ''}`, `season ${r.season ?? ''}`)})`;
    const sp = r.summary?.players.find((x) => x.id === p.id);
    const banked = sp?.banked !== undefined ? tr(` 確定${sp.banked}`, ` banked ${sp.banked}`) : '';
    // 復旧できなかったラン（V4-1m §37.1）で要約が無い者は、状態が分からない（一覧の既定の「死亡」を出さない）
    const stateKnown = !(r.recoveryFailed && !sp);
    return `${p.name}(${p.controller.kind === 'agent' ? 'AI' : p.controller.kind === 'unknown' ? '?' : tr('人', 'H')}${p.depth ? ` B${p.depth}` : ''} Lv${p.level}${stateKnown && p.state !== 'alive' ? ` ${playerStateLabel(p.state)}` : ''}${banked})`;
  }).join(', ');

  // スコアの版ごとに別の表（版 2: 確定点 → 達成した遠征の数 → 最深。版 1 は旧スコア）
  // 継承したラン（V3-7 §7.3）は別の表
  const byScore = (a: LeaderboardEntry, b: LeaderboardEntry) => b.score - a.score || (b.expeditions ?? 0) - (a.expeditions ?? 0) || b.deepest - a.deepest;
  const boardV2 = board.filter((b) => b.scoreVersion === 2 && !b.legacy).sort(byScore);
  const boardV2Legacy = board.filter((b) => b.scoreVersion === 2 && b.legacy).sort(byScore);
  const boardV1 = board.filter((b) => b.scoreVersion !== 2); // 旧表はサーバーの並び順のまま

  const boardRow = (b: LeaderboardEntry, i: number, v2: boolean) => (
    <tr key={`${b.runId}-${b.playerId}`} class={`${b.ongoing ? 'ongoing' : ''} ${myRunIds.has(b.runId) ? 'mine' : ''}`}>
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

  const seasonHead = (s: SeasonListing) => (
    <>
      {s.name}（{s.status === 'open' ? tr(`開催中・${fmtTime(s.endsAt)} まで`, `open until ${fmtTime(s.endsAt)}`) : s.status === 'ended' ? tr('終わりの時刻を過ぎた（確定待ち）', 'past its end (awaiting results)') : tr('確定', 'final')}・{tr(`予算 ${s.budget} 手番・参加 ${s.participants}（招いた ${s.invited}）`, `budget ${s.budget} turns, ${s.participants} of ${s.invited} invited playing`)}）
    </>
  );

  /** 1 つの進行中のランの行（続きのある自分のラン・観戦できるラン） */
  const activeItem = (r: RunListing) => {
    const tok = getToken(r.runId);
    return (
      <li key={r.runId}>
        <div><code>{r.runId}</code> <span class="tag">{r.mode}</span> <small>seq {r.seq}</small></div>
        <div class="sub">{playersText(r)}</div>
        {expeditionText(r) && <div class="sub exp">{expeditionText(r)}</div>}
        {/* 起動時に復旧できなかったラン（V4-1m §37.1）: 理由を出し、観戦・再開は出さない（記録は残っているので巻き戻しは見られる） */}
        {r.recoveryFailed && <div class="sub warn">{tr(`サーバーの起動時に復旧できなかった（理由: ${inLocale(r.recoveryFailed.reason, 'ja')}）。記録は残っている`, `Could not be recovered at server start (${inLocale(r.recoveryFailed.reason, 'en')}); its records are kept`)}</div>}
        <div class="row">
          {!r.recoveryFailed && canWatch(r) && <a class="button small" href={`#/watch/${r.runId}`}>{tr('観戦', 'Watch')}</a>}
          {canRewind(r) && <a class="button small" href={`#/replay/${r.runId}`}>{tr('巻き戻し', 'Rewind')}</a>}
          {tok && !r.recoveryFailed && <a class="button small primary" href={`#/play/${r.runId}`}>{tr('再開', 'Resume')}</a>}
          {r.joinable && !tok && <button class="small" disabled={busy} onClick={() => join(r.runId)}>{tr('参加', 'Join')}</button>}
        </div>
      </li>
    );
  };

  /** 名前とクラス（新しいラン・シーズンの参加で使う） */
  const nameClassFields = () => (
    <>
      <label>{tr('名前', 'Name')}<input value={name} maxLength={32} onInput={(e) => setName((e.target as HTMLInputElement).value)} /></label>
      <label>{tr('クラス', 'Class')}
        <select value={classId} onChange={(e) => setClassId((e.target as HTMLSelectElement).value)}>
          {classes.map(([id, c]) => <option key={id} value={id}>{nameOf(c.name, L, id)}</option>)}
          {!classes.length && <option value="core:warrior">core:warrior</option>}
        </select>
      </label>
    </>
  );

  // ---- 出撃 ----
  const current = seasons.filter((x) => x.season.status !== 'final').sort(bySeason);
  const currentIds = new Set(current.map((x) => x.season.id));
  // 自分のラン（S8a §55.6 の 11）: このブラウザのトークンのプレイヤーのラン（サーバーの mine）と、このブラウザで遊んだラン。
  // 同じ機械からだけで認めたランは「この機械のほかのラン（運用者として）」に分けて出す（取り違えないように）
  const isMineRow = (row: OwnerRunRow) => myRunIds.has(row.runId);
  const mineRows = owner.rows.filter(isMineRow);
  const operatorRows = owner.rows.filter((row) => !isMineRow(row));
  const seasonRows = mineRows.filter((row) => row.season && currentIds.has(row.season.id))
    .sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.updatedAt - a.updatedAt);
  const otherRows = mineRows.filter((row) => !(row.season && currentIds.has(row.season.id)));
  const cardIds = new Set(owner.rows.map((x) => x.runId));
  const myActive = active.filter((r) => getToken(r.runId) && !cardIds.has(r.runId));
  const otherActive = active.filter((r) => !getToken(r.runId));
  const waitingCount = owner.rows.filter((x) => x.waiting).length;
  const otherWaiting = otherRows.filter((x) => x.waiting).length;
  const operatorWaiting = operatorRows.filter((x) => x.waiting).length;
  // 「この機械のほかのラン」の開け閉め（S8b）: 既定は、AI が決定を待っているランがあれば開く。操作したら、その向きを覚える。
  // 待っているランが増えたら、既定に戻す（開く）
  const [opOpen, setOpOpen] = useState<boolean | null>(null);
  const [opWaitSeen, setOpWaitSeen] = useState(0);
  useEffect(() => {
    if (operatorWaiting > opWaitSeen) setOpOpen(null);
    if (operatorWaiting !== opWaitSeen) setOpWaitSeen(operatorWaiting);
  }, [operatorWaiting]);
  /**
   * プロフィールのトークンを入れる欄（S8a §55.6 の 6・S8b で 1 つにまとめた）: 入れると、そのプロフィールのランの持ち主になる（シーズンのランも、シーズンでないランも）。
   * 覚えるのは profileToken。前の版でシーズンの参加の欄に覚えた seasonToken.<id> も、今までどおり読む（どちらに覚えていても働く）
   */
  const savedSeasonToks = Object.keys(seasonTok);
  const forgetTokens = () => {
    setPref('profileToken', '');
    setProfileToken('');
    for (const id of savedSeasonToks) setPref(`seasonToken.${id}`, '');
    setSeasonTok({});
    void refreshOwner(seasons.map((x) => x.season.id));
  };
  const ownerTokenBox = () => (
    <section class="panel seasonbox">
      <h3>{tr('AI のランの持ち主になる（プロフィールのトークン）', 'Become the owner of your AI\'s runs (profile token)')}</h3>
      <div class="sjoin">
        {profileToken || savedSeasonToks.length ? (
          <span class="muted">{tr('プロフィールのトークン: このブラウザに保存済み（••••）', 'Profile token: saved in this browser (••••)')} <button class="tiny" onClick={forgetTokens}>{tr('外す', 'Forget')}</button></span>
        ) : (
          <span class="row">
            <input type="password" autocomplete="off" placeholder={tr('プロフィールのトークン（profile_token）', 'profile token (profile_token)')} value={profDraft}
              onInput={(e) => setProfDraft((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') keepOwnerTok(); }} />
            <button class="small" onClick={keepOwnerTok}>{tr('覚える', 'Keep')}</button>
          </span>
        )}
      </div>
      <p class="muted small">{tr('AI を招いたときのトークン（招かれたプロフィールのトークン）を入れると、そのプロフィールのランの持ち主になる（シーズンのランも、シーズンでないランも、ここに自分のランとして出る。ほかの PC のブラウザからも）。トークンはこのブラウザにだけ覚え、画面と URL には出さない。', 'Enter the token you got when you invited your AI (the invited profile token) and you become the owner of that profile\'s runs (season runs and other runs both show up here as yours), from any PC\'s browser. The token is kept only in this browser and never shown on screen or in a URL.')}</p>
    </section>
  );
  const keepOwnerTok = () => {
    const tok = profDraft.trim();
    if (!tok) return;
    keepProfile(tok);
    setProfDraft('');
    void refreshOwner(seasons.map((x) => x.season.id));
  };
  const card = (row: OwnerRunRow) => <OwnerRunCard key={row.runId} row={row} token={owner.token[row.runId]} catalog={catalog} onChanged={() => void refreshOwner(seasons.map((x) => x.season.id))} />;

  /**
   * シーズンを自分で遊ぶ欄（人間のラン。今シーズンの自分のランが無いとき）。S8b: トークンの欄は持たない（上の「AI のランの持ち主になる」で覚えたものを使う）
   */
  const joinBox = (s: SeasonListing) => {
    // このブラウザで始めた、このシーズンの進行中のラン（続ける）
    const mine = active.find((r) => r.season === s.id && getToken(r.runId) && !r.recoveryFailed);
    const tok = seasonTokFor(s.id);
    return (
      <section key={`join-${s.id}`} class="panel seasonbox">
        <h3>{tr(`シーズン「${s.name}」を自分で遊ぶ（人間のラン）`, `Play the season "${s.name}" yourself (a human run)`)}</h3>
        {mine ? (
          <div class="sjoin">
            <a class="button small primary" href={`#/play/${mine.runId}`}>{tr('進行中のシーズンのランを続ける', 'Resume your season run')}</a>
          </div>
        ) : (
          <>
            <p class="muted small">{tok
              ? tr('名前とクラスを決めて参加する。トークンは、上の欄で覚えたプロフィールのトークンを使う。', 'Pick a name and class and join. It uses the profile token kept in the box above.')
              : tr('参加できるのは、招かれたプロフィールだけ。上の「AI のランの持ち主になる」の欄に、招かれたプロフィールのトークンを入れてから参加する。', 'Only invited profiles can join. Put the invited profile token in the "Become the owner" box above first.')}</p>
            <div class="form inline-form">
              {nameClassFields()}
              <button class="small primary" disabled={busy || !name.trim() || !tok} onClick={() => joinSeason(s.id)}
                title={tr('このシーズンのランを、自分で遊ぶ（人間のラン）。招かれたプロフィールだけが参加できる', 'Start a season run you play yourself (a human run). Only invited profiles can join')}>
                {tr('このシーズンに参加（自分で遊ぶ）', 'Join this season (play yourself)')}
              </button>
            </div>
          </>
        )}
      </section>
    );
  };

  const sortie = () => (
    <div class="home">
      <section class="homesec">
        <h2 class="hhead">{tr('今シーズンの自分のラン', 'Your run this season')}</h2>
        {seasonRows.map(card)}
        {!current.length && <p class="muted">{tr('開催中のシーズンは無い。続きのあるラン・新しいランは、下の「ほかのラン」から。過去のシーズンは「記録」のタブ。', 'No season is running. Other runs and new runs are under "Other runs" below; past seasons are in the Records tab.')}</p>}
        {ownerTokenBox()}
        {current.filter((x) => x.season.status === 'open' && !seasonRows.some((row) => row.season?.id === x.season.id)).map((x) => joinBox(x.season))}
      </section>

      {/* AI が決定を待っているランがあれば、最初から開く（S8b。畳んだ・開いた操作は覚える。待っているランが新しく出たら開き直す） */}
      {operatorRows.length > 0 && (
        <details class="panel others" open={opOpen ?? operatorWaiting > 0}
          onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== (opOpen ?? operatorWaiting > 0)) setOpOpen(o); }}>
          <summary>
            {tr('この機械のほかのラン（運用者として）', 'Other runs on this machine (as the operator)')}
            <small>{tr(`（${operatorRows.length}）`, ` (${operatorRows.length})`)}</small>
            {operatorWaiting > 0 && <span class="waitmark inline">{tr(`AI が、持ち主の決定を待っている ${operatorWaiting}`, `${operatorWaiting} AI waiting for a decision`)}</span>}
          </summary>
          <p class="muted small">{tr('サーバーと同じ機械から開いているので、このブラウザにトークンの無いランも、運用者として持ち主の操作ができる。自分のランと取り違えないこと。', 'Opened on the server machine, so you can act as the owner of runs this browser has no token for, as the operator. Do not mistake them for your own runs.')}</p>
          <div class="home inner">{operatorRows.map(card)}</div>
        </details>
      )}

      {current.map(({ season: s, standings }) => (
        <section key={`st-${s.id}`} class="panel seasonbox">
          <h3 title={tr('同着は、使った予算（手番）の少ないほうが上', 'Ties go to whoever used less budget (turns)')}>{tr('今シーズンの順位', 'Standings this season')}: {seasonHead(s)}</h3>
          <div class="row">
            <a class="button small" href={`#/season/${s.id}`}>{tr('順位と坑の断面', 'Standings and cross-section')}</a>
          </div>
          {standings.length === 0
            ? <div class="muted">{tr('まだだれもランを始めていない（参加は運用者に招かれた者だけ）', 'Nobody has started yet (invited players only)')}</div>
            : <StandingsTable rows={standings} mine={myNames(s.id, standings)} />}
        </section>
      ))}

      <details class="panel others" open={seasonsLoaded && !current.length && !owner.rows.length}>
        <summary>
          {tr('ほかのラン', 'Other runs')}
          <small>{tr(`（続きのある自分のラン ${myActive.length + otherRows.length}・進行中 ${otherActive.length}・新しいラン）`, ` (your runs ${myActive.length + otherRows.length}, active ${otherActive.length}, new run)`)}</small>
          {otherWaiting > 0 && <span class="waitmark inline">{tr(`AI が、あなたの決定を待っている ${otherWaiting}`, `${otherWaiting} AI waiting for your decision`)}</span>}
        </summary>
        {otherRows.length > 0 && <div class="home inner">{otherRows.map(card)}</div>}
        <div class="lobby">
          <section class="panel">
            <h3>{tr('続きのある自分のラン', 'Your runs to continue')} <button class="tiny" onClick={refresh}>↻</button></h3>
            {runs === null && <div class="muted">{tr('読み込み中…', 'Loading…')}</div>}
            {runs !== null && myActive.length === 0 && <div class="muted">{tr('なし（このブラウザで遊んでいるランは無い）', 'None (no run played from this browser)')}</div>}
            <ul class="runs">{myActive.map(activeItem)}</ul>
          </section>

          <section class="panel">
            <h3>{tr('進行中のラン（観戦・参加）', 'Active runs (watch or join)')}</h3>
            {runs !== null && otherActive.length === 0 && <div class="muted">{tr('なし', 'None')}</div>}
            <ul class="runs">{otherActive.map(activeItem)}</ul>
            {current.some((x) => watch[x.season.id] && !watch[x.season.id].local) && (
              <p class="muted small">{tr('開催中のシーズンのランを観戦できるのは、その参加者（招かれたプロフィールのトークンを覚えさせたブラウザ）と、サーバーと同じ機械からだけ。確定した後は、だれでも見返せる。', 'While the season is running, only its participant (a browser that keeps their invited profile token) and the server machine can watch a run. Once it is finalized, anyone can.')}</p>
            )}
          </section>

          <section class="panel">
            <h3>{tr('新しいラン（自分で遊ぶ）', 'New run (play yourself)')}</h3>
            <div class="form">
              {nameClassFields()}
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
              <button class="primary" disabled={busy || !name.trim()} onClick={() => void start()}>{tr('冒険を始める', 'Start')}</button>
            </div>
          </section>
        </div>
      </details>
    </div>
  );

  // ---- 記録 ----
  const allSeasons = [...seasons].sort(bySeason);
  /** その参加者の、そのシーズンのラン（古い順） */
  const seasonRuns = (sid: string) => (runs ?? []).filter((r) => r.season === sid).sort((a, b) => a.createdAt - b.createdAt);
  /**
   * ランへの口: 巻き戻せればリプレイ、進行中で観戦できれば観戦。どちらでもなければ出さない（だれが見られるかは変えない: §25.1）。
   * ID だけ（順位の表の runIds にあって一覧に無い）なら巻き戻しを開く（見られなければ、その画面にサーバーの断りの文が出る）
   */
  const runHref = (x: RunListing | string): string | null => {
    if (typeof x === 'string') return `#/replay/${x}`;
    if (canRewind(x)) return `#/replay/${x.runId}`;
    if (x.status === 'active' && canWatch(x) && !x.recoveryFailed) return `#/watch/${x.runId}`;
    return null;
  };
  /** 行のランの口（古い順に渡す）: いちばん新しいランを既定のボタンに。ほかのランはプルダウン（選ぶと開く） */
  const runPicker = (xs: readonly (RunListing | string)[]) => {
    const all = xs.map((x, i) => ({ id: typeof x === 'string' ? x : x.runId, n: i + 1, at: typeof x === 'string' ? null : x.createdAt, href: runHref(x) }))
      .filter((x): x is { id: string; n: number; at: number | null; href: string } => !!x.href);
    if (!all.length) return <span class="muted small">-</span>;
    const newest = all[all.length - 1];
    const older = all.slice(0, -1).reverse();
    const label = (x: typeof newest) => `${tr(`ラン ${x.n}`, `run ${x.n}`)}${x.at ? `（${fmtTime(x.at)}）` : ''}${x.href.startsWith('#/watch') ? tr('・観戦', ', watch') : ''}`;
    return (
      <span class="row">
        <a class="button tiny" href={newest.href} title={`${newest.id}${newest.at ? `・${fmtTime(newest.at)}` : ''}`}>
          {newest.href.startsWith('#/watch') ? tr('観戦', 'Watch') : '▶'}{all.length > 1 ? tr(' 最新', ' latest') : ''}
        </a>
        {older.length > 0 && (
          <select class="tiny" value="" title={tr('前のラン', 'Earlier runs')} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) navigate(v); }}>
            <option value="">{tr(`前のラン（${older.length}）`, `earlier (${older.length})`)}</option>
            {older.map((x) => <option key={x.id} value={x.href}>{label(x)}</option>)}
          </select>
        )}
      </span>
    );
  };

  const seasonRecord = (data: SeasonStandingsResponse, i: number) => {
    const s = data.season;
    const rows0 = data.result?.standings ?? data.standings;
    const mine = myNames(s.id, rows0);
    const rows = sortStandings(onlyMine ? rows0.filter((r) => mine.has(normName(r.name))) : rows0, sortBy);
    // 参加者（順位の表の名前）ごとの、そのシーズンのラン。行に runIds があればそれで結ぶ（確定したシーズンと、同じ機械から）。
    // 無ければ GET /api/runs のシーズンと名前から（分かる範囲で）
    const sr = seasonRuns(s.id);
    const listing = new Map(sr.map((x) => [x.runId, x]));
    const byIds = new Set(rows0.flatMap((r) => r.runIds ?? []));
    const byName = new Map<string, RunListing[]>();
    for (const x of sr) {
      if (byIds.has(x.runId)) continue;
      const k = normName(participantOf(x));
      byName.set(k, [...(byName.get(k) ?? []), x]);
    }
    const rowNames = new Set(rows0.filter((r) => !r.runIds?.length).map((r) => normName(r.name)));
    /** その行のラン（古い順）: runIds があればそれ（一覧に無いランは ID だけ） */
    const runsOfRow = (r: SeasonStandingRow): (RunListing | string)[] => (r.runIds?.length ? r.runIds.map((id) => listing.get(id) ?? id) : byName.get(normName(r.name)) ?? []);
    const replay = (r: SeasonStandingRow) => runPicker(runsOfRow(r));
    const sw = watch[s.id];
    const table = rows.length ? <StandingsTable rows={rows} mine={mine} replay={replay} /> : null;
    // 順位の表の行と結べなかったラン（runIds が無く、ランのプレイヤーの名前が招いたときの表示名と違う）
    const unmatched = sr.filter((x) => !byIds.has(x.runId) && !rowNames.has(normName(participantOf(x))) && !(onlyMine && !myRunIds.has(x.runId)));
    return (
      <details key={s.id} class="panel seasonbox recseason" open={i === 0}>
        <summary><b>{seasonHead(s)}</b></summary>
        <div class="row">
          <a class="button small" href={`#/season/${s.id}`}>{s.status === 'final' ? tr('結果と坑の断面・討伐の記録', 'Results, cross-section and warden kills') : tr('順位と坑の断面', 'Standings and cross-section')}</a>
        </div>
        {s.status !== 'final' && !sw?.local && (
          <p class="muted small">{tr('開催中のシーズンのランは、確定した後に、だれでも見返せる（それまでは、サーバーと同じ機械から、終わったランだけ。観戦は参加者と同じ機械から）。', 'Runs of a running season can be replayed by anyone once it is final (until then only finished runs, from the server machine; watching is for the participant and the server machine).')}</p>
        )}
        {rows0.length === 0 && <div class="muted">{tr('まだだれもランを始めていない', 'Nobody has started yet')}</div>}
        {rows0.length > 0 && !rows.length && <div class="muted">{tr('このシーズンに、自分と分かる行は無い', 'No row of yours in this season')}</div>}
        {table}
        {unmatched.length > 0 && (
          <div class="small">
            <span class="muted">{tr('順位の表の名前と結べなかったラン（ランの名前が招いたときの表示名と違う）', 'Runs not matched to a standings row (the run name differs from the invited name)')}: </span>
            {unmatched.map((x) => <span key={x.runId} class="unrun">{participantOf(x) || x.runId} {runPicker([x])}</span>)}
          </div>
        )}
        {(data.result?.titles ?? []).length > 0 && (
          <p class="titles">{tr('称号', 'Titles')}: {data.result!.titles!.map((x, j) => <span key={j}><b>{x.holder}</b> <span class="tag title">{L === 'en' ? x.name.en : x.name.ja}</span> </span>)}</p>
        )}
        <h4 title={tr('時刻の順の記録は、今の口には無い。階ごとに、公開されたもの・共有層に載った火・討伐を並べる', 'There is no timestamped feed yet; this lists, by floor, what was published, shared campfires and warden kills')}>{tr('共有層の出来事（階の順・時刻なし）', 'Shared layer (by floor, no times)')}</h4>
        <SeasonSharedFlow data={data} catalog={catalog} />
      </details>
    );
  };

  const recordsTab = () => (
    <div class="home">
      <div class="row recbar">
        <label class="check"><input type="checkbox" checked={onlyMine} onChange={(e) => setOnlyMine((e.target as HTMLInputElement).checked)} />{tr('自分だけ', 'Only mine')}</label>
        <label class="inline">{tr('並べ替え', 'Sort')}
          <select value={sortBy} onChange={(e) => setSortBy((e.target as HTMLSelectElement).value as StandingSort)}>
            {STANDING_SORTS.map((k) => <option key={k} value={k}>{standingSortName(k)}</option>)}
          </select>
        </label>
        <span class="muted small">{tr('自分の行は、このブラウザに覚えてあるトークンと、このブラウザで遊んだランから分かる範囲で。', 'Your rows are found from the tokens kept in this browser and the runs played here.')}</span>
      </div>
      <section class="homesec">
        <h2 class="hhead">{tr('シーズン', 'Seasons')}</h2>
        {allSeasons.length === 0 && <p class="muted">{tr('シーズンは、まだ無い', 'No seasons yet')}</p>}
        {allSeasons.map(seasonRecord)}
      </section>
      <div class="lobby">
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
              {titles.length > 0 && <p class="titles">{tr('称号', 'Titles')}: {titles.map((t, i) => <span key={i} class="tag title">{t}</span>)}</p>}
              {showRecords && <pre class="records">{records.text}</pre>}
            </div>
          )}
        </section>

        <section class="panel">
          <h3>{tr('終了したラン', 'Finished runs')}</h3>
          {(() => {
            const list = (onlyMine ? ended.filter((r) => myRunIds.has(r.runId)) : ended).slice(0, 30);
            return (
              <>
                {runs !== null && list.length === 0 && <div class="muted">{tr('なし', 'None')}</div>}
                <ul class="runs">
                  {list.map((r) => (
                    <li key={r.runId} class={myRunIds.has(r.runId) ? 'mine' : ''}>
                      <div><code>{r.runId}</code> <small>{fmtTime(r.updatedAt)}</small>{r.season && <span class="tag">{tr(`シーズン ${r.season}`, `season ${r.season}`)}</span>}</div>
                      <div class="sub">{playersText(r)}</div>
                      {expeditionText(r) && <div class="sub exp">{expeditionText(r)}</div>}
                      <div class="row">
                        {canRewind(r) ? <a class="button small" href={`#/replay/${r.runId}`}>{tr('リプレイ', 'Replay')}</a>
                          : <span class="muted small">{tr('シーズンの結果が確定した後に見返せる', 'Viewable once the season is finalized')}</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            );
          })()}
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

  return (
    <div class="page">
      <Header title={tr('ホーム', 'Home')} />
      <div class="toolbar hometabs">
        <span class="seg">
          <button class={`small ${tab === 'sortie' ? 'on' : ''}`} onClick={() => navigate('#/')}>
            {tr('出撃', 'Sortie')}{waitingCount > 0 && <span class="waitdot" title={tr('AI が、あなたの決定を待っている', 'An AI is waiting for your decision')}> ●{waitingCount}</span>}
          </button>
          <button class={`small ${tab === 'records' ? 'on' : ''}`} onClick={() => navigate('#/records')}>{tr('記録', 'Records')}</button>
        </span>
      </div>
      <ErrorBanner error={error ?? catErr} onClose={() => setError(null)} />
      {tab === 'records' ? recordsTab() : sortie()}
      {endPrev && (
        <div class="modal" onClick={() => setEndPrev(null)}>
          <div class="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setEndPrev(null); }}>
            <h3>{tr('続きのある冒険がある', 'There is an adventure to continue')}</h3>
            <p>{tr('この冒険者には、続きを遊べるランがある（冒険者 1 人に、続きは 1 つ）。新しく始めると、前の冒険は、ここで終わる。記録は、残る。', 'This adventurer already has a run to continue (one adventurer, one run to continue). Starting anew ends the previous adventure here. Its records stay.')}</p>
            {endPrev.runId && <p class="muted small"><code>{endPrev.runId}</code></p>}
            <div class="row">
              <button class="small primary" onClick={() => setEndPrev(null)}>{tr('やめる', 'Cancel')}</button>
              <button class="small" disabled={busy} onClick={() => { const r = endPrev.retry; setEndPrev(null); void r(); }}>{tr('前の冒険を終えて、新しく始める', 'End it and start anew')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

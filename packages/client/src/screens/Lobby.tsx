// ホーム（S10。SEASON.md §58.4。S16b §70.4 で入口を並べ替えた）: 上のタブは「拠点」「リーダーボード」「シーズン」「図鑑」の 4 つと、隅の歯車（設定）。
// 「拠点」（最初に開く。#/）: 考え方は 1 つ「あなたには、冒険者がいる。今シーズンの迷宮へ、送り出す」。冒険者の札（このブラウザに鍵を覚えてある冒険者ごとに 1 枚。
//   文とボタンは ui/hubState.ts）・鍵を入れる欄（鍵が無いとき）・この PC の冒険者（運用者として）・今シーズンの順位。「ラン」「トークン」の言葉を使わない。
// 「リーダーボード」（#/leaderboard）: 前の「記録」の 3 つの表（ui/entrancePages.tsx）。
// 「シーズン」（#/season・#/season/<id>）: プルダウンで選んだシーズンの順位・称号・坑の断面・共有層の出来事・討伐の記録（ui/seasonPage.tsx）。前の「記録」（#/records）はここへ送る。
// 「図鑑」（#/codex）: この PC で遊んだ冒険者の発見を合わせたもの（ui/entrancePages.tsx。合わせ方は ui/entrance.ts）。
// 「設定」（#/settings。前の #/ops はここへ送る）: 鍵と、呼び鈴だけ。
// 古い入口（#/legacy。どこからもリンクしない）: シーズンでない新しいラン・協力の参加・続きのある自分のラン・進行中と終わったランの一覧・この PC のほかのラン。
//   ここでは今までの言葉（ラン・トークン）を使う。コードもサーバーの口も残す（§70.4 の 6）。
// 持ち主のラン（GET /api/owner/runs）は、このブラウザに覚えてある鍵（プロフィールのトークンと、シーズンの招き）ごとに呼んで、ランの ID でまとめる。
// 鍵は見出しでだけ渡し、画面・URL・console に出さない。
import type { LeaderboardEntry, Locale, OpsRosterResponse, OwnerRunRow, ProfileSeasonEntry, RunListing, SeasonListing, SeasonStandingRow, SeasonStandingsResponse, SeasonWatchResponse } from '@muse/shared';
import { endReasonText, kindName, nameOf, objectiveText } from '@muse/shared';
import { useEffect, useState } from 'preact/hooks';
import { ApiError, api, errorText } from '../api';
import { bellOn, bellProblem, readBellConfig, type BellConfig } from '../ui/bell';
import { BellSettings } from '../ui/bellSettings';
import { ErrorBanner, Header, useCatalog, useLocaleRefresh } from '../ui/common';
import type { CodexBook, EntryPage } from '../ui/entrance';
import { CodexView, LeaderboardView } from '../ui/entrancePages';
import { normName, STANDING_SORTS, StandingsTable, type StandingSort } from '../ui/home';
import { SeasonView, Shell } from '../ui/seasonPage';
import { AddAdventurerDialog, AdventurerCard, DiveDialog, HubNav, KeyEntry, KeyOnceDialog, OpenSeasonDialog, UninviteDialog } from '../ui/hub';
import { hubCard, membershipFor, noSeasonText, participantName, pickSeason, seasonLeftText, type HubCardModel } from '../ui/hubState';
import { screenErr } from '../ui/screenErr';
import { addKey, forgetKeys, keepKey, primaryKey, retireMainKey, storedKeys } from '../ui/keys';
import { FIRST_EXPEDITION_CHOICES, playerStateLabel, type FirstExpeditionChoice } from '../ui/labels';
import { OwnerRunCard } from '../ui/owner';
import type { KgState } from '../ui/keepGoing';
import { KeepGoingBox, useKeepGoing } from '../ui/keepGoingUi';
import { SoundControls, useHubMusic } from '../ui/sound';
import { rewindAllowed, watchAllowed } from '../ui/replayGate';
import { fmtTime, getLocale, getPref, getToken, inLocale, navigate, saveToken, setPref, tr } from '../util';

export type HomeTab = EntryPage;

function firstChoice(v: string): FirstExpeditionChoice {
  return FIRST_EXPEDITION_CHOICES.find((o) => o.id === v)?.id ?? 'camp';
}

/**
 * 持ち主のラン: rows（ランの ID でまとめた行）・token（そのランを返したトークン。無ければ同じ PC から）・mine（外からトークンで認められた = 自分のもの）・
 * byToken（鍵ごとの、その鍵の冒険者のラン。拠点の札）
 */
interface OwnerState { rows: OwnerRunRow[]; token: Record<string, string>; mine: Set<string>; local: boolean; byToken: Record<string, OwnerRunRow[]> }

/**
 * 鍵の冒険者（S10）: token（このブラウザの鍵）・id（プロフィールの ID。読めなければ null）・name（プロフィールの表示名）・seasons（招かれたシーズン。読めなければ無い）・
 * ok（鍵が使えた: プロフィールか持ち主の口のどちらかが通った）
 */
interface Adventurer { token: string; id: string | null; name: string; seasons?: ProfileSeasonEntry[]; ok: boolean }

/** シーズンの並び（開催中 → 確定待ち → 確定。その中は終わりの時刻の新しい順） */
const SEASON_ORDER: Record<SeasonListing['status'], number> = { open: 0, ended: 1, final: 2 };
const bySeason = (a: SeasonStandingsResponse, b: SeasonStandingsResponse) => SEASON_ORDER[a.season.status] - SEASON_ORDER[b.season.status] || b.season.endsAt - a.season.endsAt;

/** seasonId: シーズンのタブの道の ID（#/season なら null） */
export function Lobby({ tab = 'hub', seasonId = null }: { tab?: HomeTab; seasonId?: string | null }) {
  useLocaleRefresh();
  // 拠点の曲（S15。SEASON.md §68.2 の 5）: 拠点・リーダーボード・シーズン・図鑑・設定のタブの間（S16b）
  useHubMusic();
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
  // 観戦できるラン（S3 §25.1）: 開催中のシーズンのランは、このブラウザに覚えてあるトークンのランか、同じ PC から開いているときだけ。
  // withTok: トークンを付けて訊いた（外からなら、返ったランはそのトークンのもの）
  const [watch, setWatch] = useState<Record<string, SeasonWatchResponse & { withTok: boolean }>>({});
  // 持ち主のラン（S8 §54.5）
  const [owner, setOwner] = useState<OwnerState>({ rows: [], token: {}, mine: new Set(), local: false, byToken: {} });
  // 鍵の冒険者（S10 の拠点の札）。null: まだ読んでいない
  const [advs, setAdvs] = useState<Adventurer[] | null>(null);
  // 自分で潜る窓（S10）: どのシーズンへ、どの鍵で
  const [dive, setDive] = useState<{ seasonId: string; token: string; name: string } | null>(null);
  const [diveErr, setDiveErr] = useState<string | null>(null);
  // 拠点の運用者の口（S12b。SEASON.md §63.7）: 名簿は、サーバーと同じ PC から開いているときだけ読む（ほかの PC からは呼ばない）
  const [roster, setRoster] = useState<OpsRosterResponse | null>(null);
  // 運用者の窓: 新しいシーズンを始める・冒険者を足す（seasonName: 足す先、lead: 窓の上の案内）
  // 窓は、開いたときの値を持つ（S12c: 名簿の読み直しが一時的に失敗しても、閉じない・入力が消えない）
  const [opsDlg, setOpsDlg] = useState<{ kind: 'open'; suggested: string; days: number; budget: number } | { kind: 'add'; seasonName: string; lead?: string } | { kind: 'uninvite'; profileId: string; name: string } | null>(null);
  const [opsErr, setOpsErr] = useState<string | null>(null);
  // 鍵を 1 回だけ見せる窓（AI に任せる冒険者を足した直後。このブラウザには覚えない。閉じたら消える）
  const [keyOnce, setKeyOnce] = useState<{ name: string; seasonId: string; key: string } | null>(null);
  // 呼び鈴の設定（S12b。SEASON.md §63.6。このブラウザにだけ覚える）
  // S15: 鳴らし方は、使わない・この PC の受け口の 2 つ（リンクは外した）
  const [bellCfg, setBellCfg] = useState<BellConfig>(readBellConfig());
  // 続けて遊ばせる（S14）: このブラウザに覚えてある状態（鳴らす役は、アプリの根の KeepGoingRunner）
  const kgStates = useKeepGoing();
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
  const [profileToken, setProfileToken] = useState(primaryKey());
  const [legacy, setLegacy] = useState(getPref('legacy', 'on') !== 'off');
  // シーズンのタブ: 自分だけに絞る・並べ替え（このブラウザに覚える。前の「記録」のタブと同じ覚え方）
  const [onlyMine, setOnlyMineState] = useState(getPref('records.onlyMine', 'off') === 'on');
  const [sortBy, setSortByState] = useState<StandingSort>(STANDING_SORTS.find((k) => k === getPref('records.sort', 'adventure')) ?? 'adventure');
  const setOnlyMine = (v: boolean) => { setPref('records.onlyMine', v ? 'on' : 'off'); setOnlyMineState(v); };
  const setSortBy = (k: StandingSort) => { setPref('records.sort', k); setSortByState(k); };
  // 図鑑（S16b。§70.4 の 4）: このブラウザの鍵の冒険者の図鑑（鍵ごとの GET /api/profile/records。null: まだ読んでいない）と、
  // サーバーと同じ PC から開いているときの、サーバーのプロフィールの全員（GET /api/ops/codex。ほかの PC からは呼ばない）
  const [keyBooks, setKeyBooks] = useState<CodexBook[] | null>(null);
  const [opsBooks, setOpsBooks] = useState<CodexBook[] | null>(null);
  const L = getLocale();
  const keepProfile = (tok?: string) => { if (tok) { setPref('profileToken', tok); setProfileToken(tok); } };
  // 自分のラン（シーズンのタブの「自分だけ」・順位の表の自分の行）: 覚えてある鍵の全部（S12c: 拠点で足した冒険者の鍵も）のプロフィールの直近のラン。
  // 同じ答えから、図鑑のタブの、鍵の冒険者の図鑑も作る（図鑑のタブを開いたら、読み直す）
  const tokKey = [profileToken, ...Object.values(seasonTok), ...storedKeys()].join('\u0000');
  useEffect(() => {
    const toks = storedKeys();
    if (!toks.length) { setRecentMine([]); setKeyBooks([]); return; }
    // 1 人ずつの記録（S16d: 前の「記録」のタブの 1 行・全文・称号）は、図鑑のタブの冒険者ごとの札に出す。称号はプロフィールの口から（図鑑のタブのときだけ呼ぶ）
    const withTitles = tab === 'codex';
    Promise.all(toks.map((t) => Promise.all([
      api.records(t, L).catch(() => null),
      withTitles ? api.profile(t, L).then((p) => (p.titles ?? []).map((x) => x.name)).catch(() => [] as string[]) : Promise.resolve([] as string[]),
    ]))).then((xs) => {
      const got = xs.filter((x): x is [NonNullable<(typeof x)[0]>, string[]] => !!x[0]?.records);
      setRecentMine([...new Set(got.flatMap(([r]) => r.records.recent.map((x) => x.run_id)))]);
      setKeyBooks(got.map(([{ text, records: r }, titles]) => ({
        id: r.profile.id, name: r.profile.name, codex: r.codex, feats: r.feats,
        record: { runs: r.runs.total, bestBanked: r.banked.best, deepest: r.deepest, text, titles },
      })));
    });
  }, [tokKey, L, tab === 'codex']);
  // 運用者の図鑑（S16b）: 図鑑のタブで、サーバーと同じ PC から開いているときだけ呼ぶ（判定は持ち主の口の一覧の local。サーバーも isLocalRequest で断る）
  useEffect(() => {
    if (tab !== 'codex' || !owner.local) return;
    let alive = true;
    api.opsCodex(L)
      .then((r) => { if (alive) setOpsBooks(r.profiles.map((p) => ({ id: p.profileId, name: p.name, codex: p.codex, feats: p.feats }))); })
      .catch(() => { if (alive) setOpsBooks([]); });
    return () => { alive = false; };
  }, [tab, owner.local, L]);

  /** 持ち主のラン（S8）: トークンなしで 1 回（同じ PC なら全部返る）と、覚えてあるトークンごとに 1 回。ランの ID でまとめる */
  const refreshOwner = async (seasonIds: readonly string[]) => {
    const keys = storedKeys(seasonIds);
    const calls: (string | undefined)[] = [undefined, ...keys];
    const [res, profs] = await Promise.all([
      Promise.all(calls.map((t) => api.ownerRuns(t).then((r) => ({ t, r })).catch(() => null))),
      // 鍵の冒険者（S10）: 表示名と、招かれたシーズン
      Promise.all(keys.map((t) => api.profile(t, getLocale()).catch(() => null))),
    ]);
    const rows = new Map<string, OwnerRunRow>();
    const token: Record<string, string> = {};
    const mine = new Set<string>();
    const byToken: Record<string, OwnerRunRow[]> = {};
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
        // 自分のラン（S8a）: サーバーが、送ったトークンのプレイヤーのランに mine を付ける（同じ PC からだけで認めたランは付かない）
        if (x.t && row.mine && !token[row.runId]) token[row.runId] = x.t;
        if (row.mine) mine.add(row.runId);
        if (x.t && row.mine) (byToken[x.t] ??= []).push(row);
      }
    }
    // 同じプロフィールの鍵は 1 つに（前の版でシーズンごとに覚えた鍵が、同じプロフィールのこともある）
    const seen = new Set<string>();
    const list: Adventurer[] = [];
    keys.forEach((t, i) => {
      const p = profs[i];
      const ok = !!p || (byToken[t]?.length ?? 0) > 0;
      const id = p?.profile_id ?? null;
      if (id && seen.has(id)) return;
      if (id) seen.add(id);
      list.push({ token: t, id, name: p?.name ?? byToken[t]?.[0]?.name ?? '', ...(p?.seasons ? { seasons: p.seasons } : {}), ok });
    });
    // 名簿（S12b）: サーバーと同じ PC から開いているときだけ、運用者の口を呼ぶ。一時的に読めなかったときは、前の名簿のまま（S12c: 開いている窓を閉じない）
    if (local) {
      const r = await api.opsRoster().catch(() => null);
      if (r) setRoster(r);
    } else if (any) setRoster(null);
    setAdvs(list);
    if (!any) return;
    const sorted = [...rows.values()].sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.updatedAt - a.updatedAt);
    setOwner({ rows: sorted, token, mine, local, byToken });
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
      // 観戦の口は、覚えてある鍵の全部（S12c: 拠点で足した冒険者の鍵も）で訊いて、ランをまとめる（鍵は見出しで）。鍵が無ければ鍵なしで 1 回
      const keys = storedKeys(list.map((x) => x.season.id));
      const ws = await Promise.all(list.map(async (x) => {
        const asks: (string | undefined)[] = keys.length ? keys : [undefined];
        const rs = (await Promise.all(asks.map((t) => api.seasonWatch(x.season.id, t).catch(() => null)))).filter((r): r is SeasonWatchResponse => !!r);
        if (!rs.length) return null;
        const runs = new Map(rs.flatMap((r) => r.runs).map((r) => [r.runId, r]));
        // 終わった自分のランの見返し（S17a の G）も、鍵ごとの答えをまとめる
        const review = new Map(rs.flatMap((r) => r.review ?? []).map((r) => [r.runId, r]));
        return [x.season.id, { ...rs[0], runs: [...runs.values()], ...(review.size ? { review: [...review.values()] } : {}), withTok: keys.length > 0 }] as const;
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

  /**
   * 自分で潜る（S10。拠点の札の「自分で潜る」の窓から）: シーズンのランを始める（AI の new_run { season, profile_token } と同じ POST /api/runs。今の参加の道）。
   * 断られたら、画面の言葉の文で（S10a §6。窓の中か、確かめの窓の後なら上の帯）。run_in_progress なら確かめの窓（S9 §58.3）
   */
  const joinSeason = async (id: string, tok: string, nm: string, cls: string, endPrevious = false) => {
    setBusy(true);
    setDiveErr(null);
    try {
      setPref('name', nm);
      setPref('class', cls);
      const r = await api.newRun({ name: nm, classId: cls, locale: getLocale(), controller: { kind: 'human', label: 'browser' }, season: id, profileToken: tok, ...(endPrevious ? { endPrevious: true } : {}) });
      saveToken(r.runId, { token: r.token, playerId: r.playerId, name: nm });
      setDive(null);
      navigate(`#/play/${r.runId}`);
    } catch (e) {
      const prev = inProgressOf(e);
      if (prev !== null && !endPrevious) { setDive(null); setEndPrev({ runId: prev, retry: () => joinSeason(id, tok, nm, cls, true) }); }
      else if (endPrevious) setError(screenErr(e));
      else setDiveErr(screenErr(e));
    } finally {
      setBusy(false);
    }
  };

  /** シーズンのラン（S3 §25.1）: 観戦できるか（確定する前は、覚えてあるトークンのランか、同じ PC からだけ）・巻き戻せるか（確定する前は、同じ PC から、ランが終わった後だけ） */
  const canWatch = (r: RunListing) => watchAllowed({ season: r.season, runId: r.runId, watchable: r.season ? watch[r.season]?.runs.map((x) => x.runId) ?? null : null });
  // 巻き戻しを開けるか（S15: 画面とサーバーの決まりを 1 つの関数に。ui/replayGate.ts）
  const canRewind = (r: RunListing) => {
    if (!r.season) return true;
    const sw = watch[r.season];
    return !!sw && rewindAllowed({ season: r.season, status: r.status, final: sw.final, local: sw.local });
  };
  // 確定したシーズンのラン（S9a §57.3 の 4）: 命令を受けない記録。「出撃」には出さず（「再開」を出さない）、古い入口の終わったランに並べる
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

  /** 1 つの進行中のランの行（古い入口の、続きのある自分のラン・観戦できるラン） */
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

  // ---- 拠点と運用で使う並べ ----
  const current = seasons.filter((x) => x.season.status !== 'final').sort(bySeason);
  const currentIds = new Set(current.map((x) => x.season.id));
  // 自分のラン（S8a §55.6 の 11）: このブラウザのトークンのプレイヤーのラン（サーバーの mine）と、このブラウザで遊んだラン。
  // 同じ PC からだけで認めたランは「この PC のほかのラン（運用者として）」に分けて出す（取り違えないように）
  const isMineRow = (row: OwnerRunRow) => myRunIds.has(row.runId);
  const mineRows = owner.rows.filter(isMineRow);
  const operatorRows = owner.rows.filter((row) => !isMineRow(row));
  const otherRows = mineRows.filter((row) => !(row.season && currentIds.has(row.season.id)));
  const cardIds = new Set(owner.rows.map((x) => x.runId));
  const myActive = active.filter((r) => getToken(r.runId) && !cardIds.has(r.runId));
  const otherActive = active.filter((r) => !getToken(r.runId));
  // 拠点に出す、札の無い、このブラウザで遊んでいる今シーズンの冒険（S16b。持ち主の口の一覧を読んだ後だけ。読む前の一瞬に出さない）
  const orphanRuns = advs === null ? [] : myActive.filter((r) => !!r.season && currentIds.has(r.season) && !r.recoveryFailed);
  const otherWaiting = otherRows.filter((x) => x.waiting).length;
  const operatorWaiting = operatorRows.filter((x) => x.waiting).length;
  // 「この PC のほかのラン」の開け閉め（S8b）: 既定は、AI が決定を待っているランがあれば開く。操作したら、その向きを覚える。
  // 待っているランが増えたら、既定に戻す（開く）
  const [opOpen, setOpOpen] = useState<boolean | null>(null);
  const [opWaitSeen, setOpWaitSeen] = useState(0);
  useEffect(() => {
    if (operatorWaiting > opWaitSeen) setOpOpen(null);
    if (operatorWaiting !== opWaitSeen) setOpWaitSeen(operatorWaiting);
  }, [operatorWaiting]);
  const savedSeasonToks = Object.keys(seasonTok);
  // S12b: 拠点で足した「自分で潜る」冒険者の鍵（ほかの鍵の並び）も数える
  const hasKey = !!profileToken || savedSeasonToks.length > 0 || storedKeys().length > 0;
  /** 鍵を外す（運用の画面から。S10 §58.4）。前の版でシーズンごとに覚えた鍵も外す */
  const forgetTokens = () => {
    forgetKeys();
    setProfileToken('');
    setSeasonTok({});
    setAdvs([]);
    setOwner((o) => ({ ...o, byToken: {} }));
    void refreshOwner(seasons.map((x) => x.season.id));
  };
  /** 鍵を入れる（拠点の真ん中の欄・運用の画面）。プロフィールが読めなければ覚えずに、断りの文を返す */
  const keepOwnerTok = async (tok: string): Promise<string | null> => {
    try {
      await api.profile(tok, getLocale());
    } catch (e) {
      return e instanceof ApiError && (e.status === 401 || e.status === 404)
        ? tr('その鍵は、見つからない。運用者から受け取ったものか、確かめる', 'That key was not found. Check it is the one the operator gave you')
        : screenErr(e);
    }
    keepKey(tok);
    setProfileToken(tok);
    void refreshOwner(seasons.map((x) => x.season.id));
    return null;
  };
  // ---- 拠点の運用者の口（S12b。サーバーと同じ PC から開いたときだけ。SEASON.md §63.7） ----
  /** 運用者の口の断りは、サーバーの文の画面の言葉の側（運用者に向けた文。置き換えない） */
  const opsErrText = (e: unknown) => (e instanceof ApiError && e.error ? inLocale(e.error.message) : screenErr(e));
  /** 新しいシーズンを始める。名前が空なら送らない（サーバーが、重ならない「シーズン N」を決める。S12c）。始めたら、そのまま「冒険者を足す」の窓へ */
  const openSeason = async (v: { name: string; days: number; budget: number }) => {
    setBusy(true);
    setOpsErr(null);
    try {
      const r = await api.opsOpenSeason({ ...(v.name.trim() ? { name: v.name.trim() } : {}), days: v.days, budget: v.budget });
      setOpsDlg({ kind: 'add', seasonName: r.season.name, lead: tr(`シーズン「${r.season.name}」を始めた（${fmtTime(r.season.endsAt)} まで）。次は、冒険者を足す。`, `Started "${r.season.name}" (until ${fmtTime(r.season.endsAt)}). Next, add an adventurer.`) });
      refresh();
    } catch (e) {
      setOpsErr(opsErrText(e));
    } finally {
      setBusy(false);
    }
  };
  /**
   * 冒険者を足す。AI に任せる: 鍵を 1 回だけ見せる窓（このブラウザには覚えない）。自分で潜る: ランのトークンと鍵を、今までと同じ場所に覚えて、遊ぶ画面へ
   * （鍵は、profileToken が空ならそこへ、別の鍵があれば上書きせずに、ほかの鍵の並びへ: keys.ts の addKey）
   */
  const addAdventurer = async (v: { kind: 'ai' | 'human'; name: string; classId: string }) => {
    setBusy(true);
    setOpsErr(null);
    try {
      const r = await api.opsAddAdventurer({ name: v.name, kind: v.kind, ...(v.kind === 'human' ? { classId: v.classId } : {}), locale: getLocale() });
      setOpsDlg(null);
      if (r.kind === 'human' && r.runId && r.token && r.playerId) {
        addKey(r.profileToken);
        setProfileToken(primaryKey());
        setPref('class', v.classId);
        saveToken(r.runId, { token: r.token, playerId: r.playerId, name: r.name });
        navigate(`#/play/${r.runId}`);
        return;
      }
      setKeyOnce({ name: r.name, seasonId: r.seasonId, key: r.profileToken });
      refresh();
    } catch (e) {
      setOpsErr(opsErrText(e));
    } finally {
      setBusy(false);
    }
  };
  /** 招きを取り消す（S12c。鍵を無くしたときの道。ランを 1 回も始めていない招きだけ。確かめの窓から） */
  const uninvite = async (profileId: string) => {
    setBusy(true);
    setOpsErr(null);
    try {
      await api.opsUninvite(profileId);
      setOpsDlg(null);
      refresh();
    } catch (e) {
      setOpsErr(opsErrText(e));
    } finally {
      setBusy(false);
    }
  };
  /** このブラウザの鍵の冒険者を、今のシーズンの名簿に加える（鍵は見出しで。表示名はプロフィールの名前） */
  const enroll = async (tok: string) => {
    setBusy(true);
    try {
      await api.opsEnroll(tok);
      refresh();
    } catch (e) {
      setError(opsErrText(e));
    } finally {
      setBusy(false);
    }
  };

  const card = (row: OwnerRunRow) => <OwnerRunCard key={row.runId} row={row} token={owner.token[row.runId]} catalog={catalog} onChanged={() => void refreshOwner(seasons.map((x) => x.season.id))} />;
  const classNameOf = (id: string | undefined) => (id ? (catalog ? kindName(catalog, L, id) : id) : null);

  // ---- 拠点（S10。SEASON.md §58.4） ----
  /** row: 持ち主の口の一覧の行（続けて遊ばせる（S14）が読む。無ければ null） */
  interface HubEntry { key: string; runId: string | null; row: OwnerRunRow | null; name: string; className: string | null; model: HubCardModel; participant: string | null; seasonId: string; onDive?: () => void; onEnroll?: () => void; onUninvite?: () => void }
  /** 今のシーズン（S12b: サーバーと同じ PC から開いていて、名簿を読めたときだけ。冒険者を足す先） */
  const rosterSeason = owner.local && roster?.season ? roster.season : null;
  /** 鍵の冒険者ごとの札（ふつうは 1 枚）。開催中のシーズンが無ければ無い */
  const myCards: HubEntry[] = [];
  for (const [i, a] of (advs ?? []).entries()) {
    if (!a.ok) continue;
    const rows = owner.byToken[a.token] ?? [];
    const sd = pickSeason(current.map((x) => x.season), rows, a.seasons);
    if (!sd) continue;
    const row = rows.find((r) => r.season?.id === sd.id) ?? null;
    const mem = membershipFor(a.seasons, sd.id);
    // 順位の表の自分の行（S10a §7）: ランか招きがあるときだけ。名前だけで、同じ名前の別人の行と結ばない
    const participant = participantName(row, mem);
    const st = current.find((x) => x.season.id === sd.id)?.standings.find((r) => participant && normName(r.name) === normName(participant));
    const nm = row?.name ?? mem?.name ?? a.name;
    myCards.push({
      key: `adv-${a.id ?? i}-${sd.id}`, runId: row?.runId ?? null, row, name: nm, className: classNameOf(row?.classId), participant, seasonId: sd.id,
      model: hubCard({ name: nm, season: sd, membership: mem, row, playable: !!(row && getToken(row.runId)), rank: st?.adventure.rank ?? null, banked: st?.banked, local: owner.local, canEnroll: rosterSeason?.id === sd.id }),
      onDive: () => { setDiveErr(null); setDive({ seasonId: sd.id, token: a.token, name: mem?.name ?? nm }); },
      onEnroll: () => void enroll(a.token),
    });
  }
  const myCardRuns = new Set(myCards.map((c) => c.runId).filter((x): x is string => !!x));
  /**
   * この PC の冒険者の名簿（S12b。SEASON.md §63.7 の 2）: 今のシーズンに招いた者の全部のうち、このブラウザの鍵の冒険者でないもの（運用者として）。
   * ランがあれば、持ち主の口の一覧の行で（今までの運用者の札と同じ）。まだ入っていない AI は「鍵を使って入ってくるのを、待っている」
   */
  const myProfileIds = new Set((advs ?? []).filter((a) => a.ok && a.id).map((a) => a.id!));
  const rosterCards: HubEntry[] = rosterSeason ? roster!.roster.filter((e) => !myProfileIds.has(e.profileId)).map((e) => {
    const sd = current.find((x) => x.season.id === rosterSeason.id)?.season ?? { id: rosterSeason.id, status: 'open' as const, budget: rosterSeason.budget };
    const row = e.runId ? owner.rows.find((r) => r.runId === e.runId && !owner.mine.has(r.runId) && !myCardRuns.has(r.runId)) ?? null : null;
    const st = current.find((x) => x.season.id === sd.id)?.standings.find((r) => normName(r.name) === normName(e.name));
    return {
      key: `ros-${e.profileId}`, runId: row?.runId ?? null, row, name: row?.name ?? e.name, className: classNameOf(row?.classId), participant: e.name, seasonId: sd.id,
      model: hubCard({
        name: row?.name ?? e.name, season: sd, membership: { used: e.used, budget: e.budget, died: e.died, runs: e.runs, ...(e.failed ? { failed: true as const } : {}) },
        row, playable: !!(row && getToken(row.runId)), rank: st?.adventure.rank ?? null, banked: st?.banked, local: true, roster: { kind: e.kind },
      }),
      // 招きを取り消す（S12c）: まだ 1 回も入っていない招きだけ（札のボタンは hubCard が決める）
      onUninvite: () => { setOpsErr(null); setOpsDlg({ kind: 'uninvite', profileId: e.profileId, name: e.name }); },
    };
  }) : [];
  const rosterRuns = new Set(rosterCards.map((c) => c.runId).filter((x): x is string => !!x));
  /** この PC の冒険者（運用者として。同じ PC から開いているときだけ）: 今シーズンのランで、このブラウザの鍵の冒険者でも、名簿の札でもないもの（確定待ちのシーズンなど） */
  const operatorCards: HubEntry[] = [...rosterCards, ...(owner.local ? owner.rows
    .filter((row) => row.season && currentIds.has(row.season.id) && !owner.mine.has(row.runId) && !myCardRuns.has(row.runId) && !rosterRuns.has(row.runId))
    .map((row) => {
      const sd = current.find((x) => x.season.id === row.season!.id)!.season;
      const participant = row.season?.participant ?? row.name;
      const st = current.find((x) => x.season.id === sd.id)?.standings.find((r) => normName(r.name) === normName(participant));
      return { key: row.runId, runId: row.runId, row, name: row.name, className: classNameOf(row.classId), participant, seasonId: sd.id, model: hubCard({ name: row.name, season: sd, row, playable: !!getToken(row.runId), rank: st?.adventure.rank ?? null }) };
    }) : [])];
  const waitingCount = [...myCards, ...operatorCards].filter((c) => c.model.state === 'camp_pending').length;
  // 続けて遊ばせる（S14。SEASON.md §65.4）: 札のランの状態。ランが終わって札にランが無いとき（倒れた など）は、同じシーズンの同じ名前の、止まった状態を出す（止まった理由の 1 行）
  const cardRunIds = new Set([...myCards, ...operatorCards].map((c) => c.runId).filter((x): x is string => !!x));
  const kgFor = (c: HubEntry): KgState | null => (c.runId ? kgStates[c.runId] : undefined)
    ?? Object.values(kgStates).find((s) => s.status === 'stopped' && s.seasonId === c.seasonId && s.name === c.name && !cardRunIds.has(s.runId)) ?? null;
  const kgBox = (c: HubEntry) => <KeepGoingBox row={c.row} name={c.name} bellOn={bellOn(bellCfg)} problem={bellProblem(bellCfg)} port={bellCfg.port} st={kgFor(c)} />;
  const badKeys = (advs ?? []).filter((a) => !a.ok).length;
  const needKey = !hasKey || (advs !== null && advs.length > 0 && advs.every((a) => !a.ok));
  /** 順位を出すシーズン: 札のシーズン（無ければ、いちばん上の開催中のシーズン） */
  const shownSeasons = current.filter((x) => myCards.some((c) => c.seasonId === x.season.id) || operatorCards.some((c) => c.seasonId === x.season.id));
  const standingSeasons = shownSeasons.length ? shownSeasons : current.slice(0, 1);
  const myParticipants = new Set(myCards.map((c) => c.participant).filter((x): x is string => !!x).map(normName));
  const now = Date.now();

  const hub = () => (
    <div class="hub">
      <div class="hub-col">
        {!seasonsLoaded && <p class="hub-note">{tr('読み込み中…', 'Loading…')}</p>}
        {seasonsLoaded && !current.length && (
          <section class="hub-empty">
            <h2 class="hub-keytitle">{tr('開催中のシーズンは無い', 'No season is running')}</h2>
            <p class="hub-note">{noSeasonText(owner.local, !!roster?.broken)}</p>
            <div class="hub-links">
              {/* S12b: サーバーと同じ PC からは、ここで始める（確定していないシーズン・読めない記録があれば出さない） */}
              {owner.local && roster?.canOpen && <button type="button" class="hub-btn primary" onClick={() => { setOpsErr(null); setOpsDlg({ kind: 'open', suggested: roster.next?.name ?? '', days: roster.next?.days ?? 7, budget: roster.next?.budget ?? 3000 }); }}>{tr('新しいシーズンを始める', 'Start a new season')}</button>}
              <a class={`hub-btn ${owner.local && roster?.canOpen ? '' : 'primary'}`} href="#/season">{tr('シーズンを見る', 'Seasons')}</a>
            </div>
          </section>
        )}
        {seasonsLoaded && current.length > 0 && (
          <>
            {/* 鍵が無い・覚えてある鍵がどれも使えない: 札も無く、冒険者を足せもしなければ、真ん中に鍵を入れる欄 1 つ。運用者として札が出ているか、
                冒険者を足せるなら、札の下に小さい 1 行（S10a b・S12b） */}
            {needKey && !operatorCards.length && !rosterSeason && <KeyEntry onKeep={keepOwnerTok} />}
            {hasKey && advs === null && <p class="hub-note">{tr('読み込み中…', 'Loading…')}</p>}
            {myCards.map((c) => <AdventurerCard key={c.key} name={c.name} className={c.className} model={c.model} onDive={c.onDive} onEnroll={c.onEnroll} busy={busy} extra={kgBox(c)} />)}
            {badKeys > 0 && <p class="hub-note warn">{tr('覚えてある鍵のうち、使えないものがある（右上の歯車の「設定」で外せる）。', 'A key kept in this browser does not work (remove it under the gear at the top right, Settings).')}</p>}
            {/* 続きのある、このブラウザで遊んでいるシーズンの冒険で、札に出ていないもの（鍵を外した・覚えていない）。前は、歯車の「続きのある自分のラン」にしか出なかった（S16b） */}
            {orphanRuns.length > 0 && (
              <section class="hub-operator">
                <h3 class="hub-sechead">{tr('このブラウザで遊んでいる冒険', 'Adventures played in this browser')}</h3>
                <div class="hub-grid">
                  {orphanRuns.map((r) => (
                    <article key={r.runId} class="hub-card is-operator">
                      <h2 class="hub-name">{r.players[0]?.name ?? r.runId}</h2>
                      <p class="hub-where">{tr('このブラウザで、自分で潜っている冒険（鍵を覚えていないので、札は出ない）', 'An adventure you play in this browser (no key is kept, so it has no card)')}</p>
                      <div class="hub-actions"><a class="hub-btn primary" href={`#/play/${r.runId}`}>{tr('続ける', 'Continue')}</a></div>
                    </article>
                  ))}
                </div>
              </section>
            )}
            {operatorCards.length > 0 && (
              <section class="hub-operator">
                <h3 class="hub-sechead">{tr('この PC の冒険者（運用者として）', 'Adventurers on this PC (as the operator)')}</h3>
                <p class="hub-note">{tr('サーバーと同じ PC から開いているので、鍵の無い冒険者も、支度ができる。自分の冒険者と、取り違えないこと。', 'Opened on the server PC, so you can prepare adventurers you hold no key for. Do not mistake them for your own.')}</p>
                <div class="hub-grid">
                  {operatorCards.map((c) => <AdventurerCard key={c.key} name={c.name} className={c.className} model={c.model} operator onUninvite={c.onUninvite} busy={busy} extra={kgBox(c)} />)}
                </div>
                {needKey && !rosterSeason && <KeyEntry compact onKeep={keepOwnerTok} />}
              </section>
            )}
            {/* 冒険者を足す（S12b。名簿の下。サーバーと同じ PC から、開催中のシーズンがあるとき） */}
            {rosterSeason && (
              <section class="hub-add">
                <button type="button" class="hub-btn primary" onClick={() => { setOpsErr(null); setOpsDlg({ kind: 'add', seasonName: rosterSeason.name }); }}>{tr('冒険者を足す', 'Add an adventurer')}</button>
                <p class="hub-note">{tr(`シーズン「${rosterSeason.name}」の名簿に入れる。AI に任せるか、自分で潜るか。`, `Puts them on the roster of "${rosterSeason.name}": leave it to an AI, or go down yourself.`)}</p>
              </section>
            )}
            {rosterSeason && needKey && <KeyEntry compact onKeep={keepOwnerTok} />}
            {owner.local && roster && !rosterSeason && (roster.pending.length > 0 || roster.broken) && (
              <p class="hub-note">{roster.broken
                ? tr('記録が読めないシーズンがあるので、新しいシーズンは始められない（運用の道具で、直してから）。', 'A season\'s records cannot be read, so a new season cannot be started (fix it with the operator tool first).')
                : tr(`シーズン「${roster.pending.map((x) => x.name).join('・')}」は、終わりの時刻を過ぎて、結果を待っている（全員が戻るか、1 時間たつと確定する）。確定したら、新しいシーズンを始められる。`, `"${roster.pending.map((x) => x.name).join('", "')}" is past its end and waiting for results (final once everyone is back, or after an hour). Then a new season can be started.`)}</p>
            )}
            {standingSeasons.map(({ season: s, standings }) => (
              <section key={`st-${s.id}`} class="hub-standings">
                <header class="hub-standhead">
                  <div>
                    <h3 class="hub-sechead">{tr('今シーズンの順位', 'Standings this season')}</h3>
                    <div class="hub-sub">{s.name}<span class="hub-dot" />{seasonLeftText(s, now)}{s.status === 'open' ? tr(`（${fmtTime(s.endsAt)} まで）`, ` (until ${fmtTime(s.endsAt)})`) : ''}</div>
                  </div>
                  <a class="hub-btn small" href={`#/season/${s.id}`}>{tr('シーズンを見る', 'See the season')}</a>
                </header>
                {standings.length === 0
                  ? <p class="hub-note">{tr('まだ、だれも潜っていない。', 'Nobody has gone down yet.')}</p>
                  : <div class="hub-tablewrap"><StandingsTable rows={standings} mine={myParticipants} /></div>}
              </section>
            ))}
          </>
        )}
      </div>
    </div>
  );

  // ---- 設定（S16b。§70.4 の 5。歯車。前の「運用」の、鍵と呼び鈴だけ） ----
  const [opsDraft, setOpsDraft] = useState('');
  const [opsKeyErr, setOpsKeyErr] = useState<string | null>(null);
  const keyCount = new Set(storedKeys()).size;
  const settings = () => (
    <Shell>
      <header class="ent-head">
        <div class="ent-headtext">
          <h1 class="ent-title">{tr('設定', 'Settings')}</h1>
          <div class="hub-sub">{tr('このブラウザにだけ覚える。サーバーへは送らない。', 'Kept only in this browser; never sent to the server.')}</div>
        </div>
      </header>
      <section class="ent-card ent-setting">
        <h2 class="prep-sectitle">{tr('冒険者の鍵', 'Adventurer keys')}</h2>
        <p class="hub-note">{tr('運用者から受け取った鍵。覚えると、その冒険者が、拠点に札として出る。画面と URL には出さない。', 'The key the operator gave you. With it, that adventurer shows up on the hub as a card. It is never shown on screen or in a URL.')}</p>
        {hasKey ? (
          <div class="ent-keyrow">
            <span class="ent-keystate">{tr(`覚えている鍵 ${keyCount}（••••）`, `${keyCount} key(s) kept (••••)`)}</span>
            <button type="button" class="hub-btn small" onClick={() => { if (window.confirm(tr('鍵を外すと、拠点に冒険者の札が出なくなる（記録はサーバーに残る。同じ鍵を入れ直せば戻る）。外しますか？', 'Without the key, the hub shows no adventurer (records stay on the server; enter the same key again to bring it back). Remove it?'))) forgetTokens(); }}>{tr('鍵をすべて外す', 'Remove all keys')}</button>
          </div>
        ) : (
          <form class="hub-keyform ent-keyform" onSubmit={(e) => { e.preventDefault(); const t = opsDraft.trim(); if (t) void keepOwnerTok(t).then((er) => { setOpsKeyErr(er); if (!er) setOpsDraft(''); }); }}>
            <input class="hub-input" type="password" autocomplete="off" aria-label={tr('鍵', 'Key')} placeholder={tr('鍵', 'Key')} value={opsDraft}
              onInput={(e) => setOpsDraft((e.target as HTMLInputElement).value)} />
            <button class="hub-btn primary" type="submit" disabled={!opsDraft.trim()}>{tr('覚える', 'Keep')}</button>
          </form>
        )}
        {opsKeyErr && <p class="hub-err">{opsKeyErr}</p>}
      </section>
      {/* 呼び鈴（S12b・S14a。SEASON.md §63.6・§65.4）: このブラウザにだけ覚える。サーバーへは送らない */}
      <section class="ent-card ent-setting ent-bell">
        <BellSettings cfg={bellCfg} onChange={setBellCfg} />
      </section>
    </Shell>
  );

  // ---- 古い入口（S16b。§70.4 の 6。#/legacy。どこからもリンクしない）: 前の「運用」の、シーズンでないランと協力の入口 ----
  // この PC のほかのラン（運用者として）のうち、今シーズンのものは、拠点の札にある（ここでは重ねない）
  const legacyOperatorRows = operatorRows.filter((row) => !(row.season && currentIds.has(row.season.id)));
  const legacyPage = () => (
    <div class="home">
      <p class="legacy-head">{tr('古い入口（シーズンでないラン・協力）。今の遊び方では、使わない', 'Old entrances (runs outside a season, co-op). Not used in the current way of playing')}</p>
      {/* AI が決定を待っているランがあれば、最初から開く（S8b。畳んだ・開いた操作は覚える。待っているランが新しく出たら開き直す） */}
      {legacyOperatorRows.length > 0 && (
        <details class="panel others" open={opOpen ?? operatorWaiting > 0}
          onToggle={(e) => { const o = (e.currentTarget as HTMLDetailsElement).open; if (o !== (opOpen ?? operatorWaiting > 0)) setOpOpen(o); }}>
          <summary>
            {tr('この PC のほかのラン（運用者として）', 'Other runs on this PC (as the operator)')}
            <small>{tr(`（${legacyOperatorRows.length}）`, ` (${legacyOperatorRows.length})`)}</small>
            {operatorWaiting > 0 && <span class="waitmark inline">{tr(`AI が、持ち主の決定を待っている ${operatorWaiting}`, `${operatorWaiting} AI waiting for a decision`)}</span>}
          </summary>
          <p class="muted small">{tr('サーバーと同じ PC から開いているので、このブラウザにトークンの無いランも、運用者として持ち主の操作ができる。自分のランと取り違えないこと。', 'Opened on the server PC, so you can act as the owner of runs this browser has no token for, as the operator. Do not mistake them for your own runs.')}</p>
          <div class="home inner">{legacyOperatorRows.map(card)}</div>
        </details>
      )}

      {otherRows.length > 0 && (
        <section class="homesec">
          <h2 class="hhead">
            {tr('シーズンでない、自分のラン（持ち主として）', 'Your runs outside the season (as the owner)')}
            {otherWaiting > 0 && <span class="waitmark inline">{tr(`AI が、あなたの決定を待っている ${otherWaiting}`, `${otherWaiting} AI waiting for your decision`)}</span>}
          </h2>
          <div class="home inner">{otherRows.map(card)}</div>
        </section>
      )}

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
            <p class="muted small">{tr('開催中のシーズンのランを観戦できるのは、その参加者（招かれたプロフィールのトークンを覚えさせたブラウザ）と、サーバーと同じ PC からだけ。確定した後は、だれでも見返せる。', 'While the season is running, only its participant (a browser that keeps their invited profile token) and the server PC can watch a run. Once it is finalized, anyone can.')}</p>
          )}
        </section>

        <section class="panel">
          <h3>{tr('新しいラン（自分で遊ぶ。シーズンでない）', 'New run (play yourself, outside the season)')}</h3>
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
            {/* 前の「記録と図鑑」の枠にあったもの（シーズンでないランのプロフィール。S12c） */}
            {profileToken && (
              <button class="small" onClick={() => { if (confirm(tr('次のランは、新しいプロフィールになる（記録はサーバーに残る）。今の鍵は捨てずに、拠点の冒険者の鍵として、このブラウザに残す（外すのは、設定の「鍵をすべて外す」）。', 'Your next run starts a new profile (records stay on the server). The current key is not thrown away: it stays in this browser as a hub adventurer\'s key (remove it with "Remove all keys" in Settings).'))) { retireMainKey(); setProfileToken(''); } }}>{tr('新しいプロフィールにする', 'Start a new profile')}</button>
            )}
          </div>
        </section>

        {/* 終了したラン（前の「記録」のタブから） */}
        <section class="panel">
          <h3>{tr('終了したラン', 'Finished runs')}</h3>
          {runs !== null && ended.length === 0 && <div class="muted">{tr('なし', 'None')}</div>}
          <ul class="runs">
            {ended.slice(0, 30).map((r) => (
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
        </section>
      </div>
    </div>
  );

  // ---- 図鑑（S16b。§70.4 の 4）: 同じ PC からはサーバーの全員と、このブラウザの鍵の冒険者。ほかの PC からは鍵の冒険者だけ ----
  const codexBooks: CodexBook[] = [...(owner.local ? opsBooks ?? [] : []), ...(keyBooks ?? [])];
  const codexLoading = keyBooks === null || advs === null || (owner.local && opsBooks === null);
  const codex = () => <CodexView books={codexBooks} local={owner.local} loading={codexLoading} hasKeys={hasKey} />;

  // ---- シーズン（S16b。§70.4 の 2） ----
  const seasonTab = () => (
    <SeasonView seasons={seasons} loaded={seasonsLoaded} requested={seasonId} watch={watch} runs={runs} catalog={catalog}
      myNames={myNames} participantOf={participantOf} myRunIds={myRunIds} onlyMine={onlyMine} setOnlyMine={setOnlyMine} sortBy={sortBy} setSortBy={setSortBy} />
  );

  // 見出しの題（拠点は題なし）。古い入口は、どのタブでもない
  const titleOf: Partial<Record<HomeTab, string>> = { leaderboard: tr('リーダーボード', 'Leaderboard'), season: tr('シーズン', 'Seasons'), codex: tr('図鑑', 'Codex'), settings: tr('設定', 'Settings'), legacy: tr('古い入口', 'Old entrances') };
  const body = tab === 'leaderboard' ? <LeaderboardView board={board} catalog={catalog} myRunIds={myRunIds} />
    : tab === 'season' ? seasonTab()
      : tab === 'codex' ? codex()
        : tab === 'settings' ? settings()
          : tab === 'legacy' ? legacyPage()
            : hub();
  return (
    <div class="page">
      {/* 「← 拠点へ」（S15）: 拠点のほかのタブでも、見出しの左に */}
      <Header title={titleOf[tab]} back={tab !== 'hub'}>
        <SoundControls />
      </Header>
      <HubNav tab={tab === 'legacy' ? null : tab} waiting={waitingCount} />
      <ErrorBanner error={error ?? catErr} onClose={() => setError(null)} />
      {body}
      {dive && (
        <DiveDialog name={dive.name} classId={classId} catalog={catalog} busy={busy} error={diveErr}
          onDive={(nm, cls) => { setClassId(cls); void joinSeason(dive.seasonId, dive.token, nm, cls); }} onClose={() => setDive(null)} />
      )}
      {opsDlg?.kind === 'open' && (
        <OpenSeasonDialog defaults={{ suggested: opsDlg.suggested, days: opsDlg.days, budget: opsDlg.budget }} busy={busy} error={opsErr}
          onOpen={(v) => void openSeason(v)} onClose={() => setOpsDlg(null)} />
      )}
      {opsDlg?.kind === 'uninvite' && (
        <UninviteDialog name={opsDlg.name} busy={busy} error={opsErr} onConfirm={() => void uninvite(opsDlg.profileId)} onClose={() => setOpsDlg(null)} />
      )}
      {opsDlg?.kind === 'add' && (
        <AddAdventurerDialog seasonName={opsDlg.seasonName} lead={opsDlg.lead} catalog={catalog} classId={classId} busy={busy} error={opsErr}
          onAdd={(v) => void addAdventurer(v)} onClose={() => setOpsDlg(null)} />
      )}
      {keyOnce && <KeyOnceDialog name={keyOnce.name} seasonId={keyOnce.seasonId} keyText={keyOnce.key} onClose={() => setKeyOnce(null)} />}
      {endPrev && (
        <div class="hub-modal" onClick={() => setEndPrev(null)}>
          <div class="hub-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Escape') setEndPrev(null); }}>
            <h2 class="hub-dtitle">{tr('続きのある冒険がある', 'There is an adventure to continue')}</h2>
            <p class="hub-text">{tr('この冒険者には、続きのある冒険がある（冒険者 1 人に、続きは 1 つ）。新しく始めると、前の冒険は、ここで終わる。記録は、残る。', 'This adventurer already has an adventure to continue (one adventurer, one to continue). Starting anew ends the previous adventure here. Its records stay.')}</p>
            {tab === 'legacy' && endPrev.runId && <p class="hub-note"><code>{endPrev.runId}</code></p>}
            <div class="hub-dactions">
              <button class="hub-btn primary" onClick={() => setEndPrev(null)}>{tr('やめる', 'Cancel')}</button>
              <button class="hub-btn" disabled={busy} onClick={() => { const r = endPrev.retry; setEndPrev(null); void r(); }}>{tr('前の冒険を終えて、新しく始める', 'End it and start anew')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

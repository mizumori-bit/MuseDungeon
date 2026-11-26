// ライブ観戦。スナップショット＋イベントを shared の applyEvent で畳む（リプレイと同じ経路）。
// 俯瞰: World そのまま。追従: projectPlayerView。spectatorPolicy=follow_only ではサーバーの PlayerView フレームのみ。
// 届いた歩は再生の列（ui/playback.ts。S13 §65.1）に入れ、決まった間隔で 1 歩ずつ描く。音・吹き出し・演出・思考の欄は、その歩を描いたときに出る
import type { AgentActivity, GameEvent, PerceivedEvent, PlayerView, RunListing, RunSummary, ServerMsg, SpectatorPolicy, World } from '@muse/shared';
import { applyEvent, buildObservation, filterEventsForPlayer, formatObservationText, ownerWaitOpen, projectPlayerView, seasonClosedView } from '@muse/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import { connectWs, type WsStatus } from '../net/ws';
import type { Canvas2DRenderer } from '../render/canvas2d';
import { toViewEvents } from '../render/events';
import { directorFloor, sceneFromView, sceneFromWorld } from '../render/scene';
import { soundDirector } from '../sound/director';
import { ErrorBanner, Header, MapView, ThemePicker, useCatalog, useLocaleRefresh, useTheme } from '../ui/common';
import { SoundControls } from '../ui/sound';
import { CampScene } from '../ui/camp';
import { keyForRun } from '../ui/keys';
import { AgentWaitBadge, directorExpInfo, ExpeditionStatusPanel, followExpInfo, NotesBlock, type ExpInfo } from '../ui/expedition';
import { narrateWorld, ownerLinesFromPerceived, perceivedLines, thoughtsFrom } from '../ui/narration';
import { AiPanel, MessageLog, PartyPanel, SummaryDialog, type LogLine, type ThoughtLine } from '../ui/panels';
import {
  animSpeed, CallRanges, DEFAULT_SPEED, HeldCalls, lagText, PlaybackQueue, readSpeed, sameThought, speedLabel, stepActor, waitText, WATCH_SPEEDS, type Delivery, type WatchSpeed,
} from '../ui/playback';
import { rewindAllowed } from '../ui/replayGate';
import { actionLine, BANNER_MAX, BANNER_MS, bannerSnap, insertBySeq, isWorldTool, returnedOf, sceneBanners, type BannerSnap, type SceneBanner } from '../ui/watchLines';
import { getLocale, getPref, setPref, tr } from '../util';

interface Bubble { id: string; text: string; until: number }
/** 描いた出来事の控え（命令の行の、結果の 1 文の重なりと、帰り方を見る。S15）。text: その出来事の、欄の文 */
interface RecentEv { seq: number; type: string; ev: Record<string, unknown>; text?: string }
/** 出している場面の帯（S15） */
type ShownBanner = SceneBanner & { id: number; until: number };

/**
 * 再生の列の 1 歩。events: 俯瞰つき（World と出来事）の 1 手番（同じ命令 cause の出来事）。view: 追従だけの観戦の 1 枠
 * （サーバーが、追従の相手が知覚した命令の確定 1 回ごとに送る。その時点の見え方と、届いた出来事）
 */
type Frame = { t: 'events'; events: GameEvent[] } | { t: 'view'; msg: Extract<ServerMsg, { t: 'view' }> };
/** 時間を使わない知らせ。agent の after: そのプレイヤーの前の呼び出しの番号（この命令の出来事は after より後） */
type Note = { t: 'agent'; activity: AgentActivity; after: number } | { t: 'macro'; playerId: string; text: string } | { t: 'ended'; summary: RunSummary };
/** 思考の欄の行（act: 呼び出しの知らせから作った行の、その命令の出来事の番号の幅。同じ考えを 2 回出さない） */
type WatchThought = ThoughtLine & { act?: { after: number; upTo: number } };

/** 同じ命令の出来事が 2 つの束に分かれて届いた（俯瞰の遅延）ときに、まだ描いていない歩へ足し込む */
const mergeFrames = (a: Frame, b: Frame): Frame => (a.t === 'events' && b.t === 'events' ? { t: 'events', events: [...a.events, ...b.events] } : b);

/** 出来事を 1 手番ずつに分ける（同じ命令 cause の、続いた出来事が 1 手番。プレイヤーの 1 手と、その後の敵の動き） */
function splitSteps(events: readonly GameEvent[]): GameEvent[][] {
  const out: GameEvent[][] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (last && ev.cause !== null && last[0].cause === ev.cause) last.push(ev);
    else out.push([ev]);
  }
  return out;
}

/** おくれ（1 秒を超えたら「3 秒おくれ」）と「今の所へ」。列を半秒ごとに読み直す */
function PlaybackLag({ queue, onJump }: { queue: { lag(now: number): number }; onJump: () => void }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);
  const text = lagText(queue.lag(performance.now()));
  // おくれが無いときも、場所は取っておく（S15: 出入りで上の段の高さ・地図の枠の大きさを変えない）
  return (
    <span class="playlag" style={{ visibility: text ? 'visible' : 'hidden' }} aria-hidden={!text}>
      <span class="tag lag">{text ?? lagText(2000)}</span>
      <button class="small" onClick={onJump} tabIndex={text ? 0 : -1}>{tr('今の所へ', 'Jump to now')}</button>
    </span>
  );
}

/** 場面の帯（S15。地図の上に重ねて、2.5 秒ほどで消える） */
function SceneBanners({ items }: { items: ShownBanner[] }) {
  if (!items.length) return null;
  return (
    <div class="scenebanners" aria-live="polite">
      {items.map((b) => <div key={b.id} class={`scenebanner tone-${b.tone}`} style={{ animationDuration: `${BANNER_MS}ms` }}>{b.text}</div>)}
    </div>
  );
}

export function Watch({ runId }: { runId: string }) {
  useLocaleRefresh();
  const { catalog, error: catErr } = useCatalog();
  const th = useTheme(catalog);
  const [policy, setPolicy] = useState<SpectatorPolicy | null>(null);
  const [listing, setListing] = useState<RunListing | null>(null);
  const [mode, setModeState] = useState<'director' | 'follow'>(getPref('watchMode', 'director') === 'follow' ? 'follow' : 'director');
  const [follow, setFollow] = useState<string | null>(null);
  const [floorSel, setFloorSel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<WsStatus>('connecting');
  const [log, setLog] = useState<LogLine[]>([]);
  const [thoughts, setThoughts] = useState<ThoughtLine[]>([]);
  const [activities, setActivities] = useState<AgentActivity[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [, setTick] = useState(0);
  const [macro, setMacro] = useState<Record<string, string>>({});
  const [speed, setSpeedState] = useState<WatchSpeed>(readSpeed(getPref('watchSpeed', DEFAULT_SPEED)));
  /** 場面の帯（S15） */
  const [banners, setBanners] = useState<ShownBanner[]>([]);
  /** 巻き戻しを開けるか（S15。§25.1 の決まりのとおり。開けないランには、ボタンを出さない） */
  const [canRewind, setCanRewind] = useState(false);

  const worldRef = useRef<World | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  const rRef = useRef<Canvas2DRenderer | null>(null);
  const catalogRef = useRef(catalog);
  const modeRef = useRef(mode);
  const followRef = useRef<string | null>(follow);
  const floorRef = useRef<string | null>(floorSel);
  const bubblesRef = useRef<Bubble[]>([]);
  const macroRef = useRef<Record<string, string>>({});
  /** 再生の列（S13）。描くまで、届いた歩と知らせを持つ */
  const queueRef = useRef<PlaybackQueue<Frame, Note> | null>(null);
  if (!queueRef.current) queueRef.current = new PlaybackQueue<Frame, Note>(speed, mergeFrames);
  /** 列を進める（速さを替えたとき）・今の所へ飛ぶ（ボタン・相手を替えたとき）。つないでいる間だけ */
  const pumpRef = useRef<(() => void) | null>(null);
  const jumpRef = useRef<(() => void) | null>(null);
  /** つないだ時点の番号（つなぐ前の考えの見分け）と、「考えている」の数え始め（つないだ時・相手を替えた時） */
  const connectSeqRef = useRef(0);
  const countFromRef = useRef(performance.now());
  /** つながっているか（つながっていない間は、待っている間の札を出さない） */
  const wsStatusRef = useRef<WsStatus>('connecting');
  /** サーバーの観戦の方針（welcome から）。delayed（遅らせる観戦）では、遅らせた所より先の呼び出しの記録を持っておく */
  const wsPolicyRef = useRef<SpectatorPolicy | null>(null);
  /** 呼び出しの知らせの、その命令の出来事の幅（つないだら数え直す）・プレイヤーごとの最後に届いた時刻・同じ知らせを 2 回入れない控え */
  const rangesRef = useRef(new CallRanges());
  const actAtRef = useRef<Record<string, number>>({});
  const actKeysRef = useRef<Set<string>>(new Set());
  /** 追従だけの観戦: 列に入れた最後の枠（次の枠の出来事は、この番号より後。この枠の手番の者が、次の枠で手番を打つ） */
  const lastViewRef = useRef<PlayerView | null>(null);
  /** 俯瞰つき: 体の ID → プレイヤー（歩で手番を打った者を見分ける） */
  const entityPlayerRef = useRef<Map<string, string>>(new Map());
  /** 思考の欄（同じ考えを 2 回出さないため、今の中身をすぐ読めるように持つ） */
  const thoughtsRef = useRef<WatchThought[]>([]);
  /** 開催中のシーズンのランの観戦に渡すトークン（S3 §25.1） */
  const seasonTokRef = useRef<string | null>(null);
  /** 描いた出来事の控え（新しい 800 件。命令の行に使う。S15） */
  const recentRef = useRef<RecentEv[]>([]);
  /** 場面の帯: 前に描いた歩の見え方（見ている相手の。つないだ最初・飛んだ後・相手を替えた後は null か、その時点の見え方） */
  const bannerPrevRef = useRef<BannerSnap | null>(null);
  const bannersRef = useRef<ShownBanner[]>([]);
  const bannerIdRef = useRef(0);
  catalogRef.current = catalog;
  modeRef.current = mode;
  followRef.current = follow;
  floorRef.current = floorSel;
  macroRef.current = macro;

  useEffect(() => {
    const conf = api.config().then((c) => c.spectatorPolicy).catch(() => 'omniscient' as SpectatorPolicy);
    api.runs().then(async (rs) => {
      const r = rs.find((x) => x.runId === runId) ?? null;
      setListing(r);
      if (r && !followRef.current) setFollow(r.players.find((p) => p.state === 'alive' || p.state === 'at_camp')?.id ?? r.players[0]?.id ?? null);
      // 開催中のシーズンのラン（S3 §25.1）: このブラウザに覚えてある鍵のうち、そのランの冒険者の鍵を hello に入れる（URL には出さない）。
      // S12c: 覚えてある鍵の全部から探す（keyForRun）。別の冒険者の鍵は入れない。無ければ鍵なし（同じ PC からなら、それで見られる）
      seasonTokRef.current = r?.season ? (await keyForRun(runId)) ?? null : null;
      // シーズンのラン（S0 §9.7）は、進行中はサーバーの設定によらず追従視点だけ。
      // 終わったランも、シーズンが確定する前で同じ PC からでなければ追従だけ（持ち主の観戦は俯瞰を送らない。S3）
      const server = await conf;
      let pol = server;
      const sw = r?.season ? await api.seasonWatch(r.season, seasonTokRef.current ?? undefined).catch(() => null) : null;
      if (r?.season) {
        if (r.status === 'active') pol = 'follow_only';
        else if (!sw || !(sw.final || sw.local)) pol = 'follow_only';
      }
      setPolicy(pol);
      // 巻き戻しのボタン（S15）: 開けるランだけ（確定したシーズンのランは、だれでも。確定する前は、同じ PC から、終わったランだけ。§25.1）
      setCanRewind(!!r && rewindAllowed({ season: r.season ?? null, status: r.status, final: !!sw?.final, local: !!sw?.local, policy: server }));
    }).catch(async (e) => { setError(errorText(e)); setPolicy(await conf); });
  }, [runId]);

  const followOnly = policy === 'follow_only';

  /** 表示中のフロア（追従中はそのプレイヤーのフロア、俯瞰は選択または自動） */
  const featuredFloor = (w: World): string | null => {
    const fpid = followRef.current;
    if (modeRef.current === 'follow' && fpid && w.players[fpid]?.state === 'alive') {
      const e = w.entities[w.players[fpid].entityId];
      if (e?.pos) return e.pos.floor;
    }
    const fk = floorRef.current;
    return fk && w.floors[fk] ? fk : directorFloor(w, fpid).floorKey;
  };

  /**
   * 待っている間の札（§65.1 の 4）: 列が空で、ランが続いていて、見ている相手が AI の冒険者で、その番（かキャンプ）のとき。
   * 「考えている… N 秒」（最後の呼び出しの知らせか、つないだ時・相手を替えた時の、新しいほうから）か、キャンプで持ち主の支度が「まだ」なら「持ち主の支度を、待っている」。
   * つながっていない間と、遅らせる観戦（delayed。呼び出しの知らせが届かず、見えている所は AI の今より前）では出さない
   */
  const waitProbe = (): string | null => {
    const q = queueRef.current;
    if (!q || wsPolicyRef.current === 'delayed') return null;
    let name: string, pid: string, agent: boolean, active = false, ownerPending = false;
    if (followOnly) {
      const v = viewRef.current;
      if (!v) return null;
      name = v.self.name;
      pid = v.playerId;
      agent = v.self.controller.kind === 'agent';
      active = v.runStatus !== 'ended' && (v.status === 'your_turn' || (v.status === 'at_camp' && !seasonClosedView(v)));
      ownerPending = ownerWaitOpen(v);
    } else {
      const w = worldRef.current, fp = followRef.current;
      const pr = w && fp ? w.players[fp] : undefined;
      if (!w || !fp || !pr) return null;
      name = pr.name;
      pid = fp;
      agent = pr.controller.kind === 'agent';
      if (w.status !== 'ended' && !macroRef.current[fp]) {
        if (pr.state === 'alive') {
          const e = w.entities[pr.entityId];
          active = !!e?.pos && w.floors[e.pos.floor]?.currentActor === e.id;
        } else if (pr.state === 'at_camp') {
          try {
            const v = projectPlayerView(w, fp);
            active = !seasonClosedView(v);
            ownerPending = ownerWaitOpen(v);
          } catch {
            active = false;
          }
        }
      }
    }
    const text = waitText({
      connected: wsStatusRef.current === 'open', queued: !q.empty, active, agent, ownerPending,
      lastAgentAt: actAtRef.current[pid] ?? null, countFrom: countFromRef.current, now: performance.now(),
    });
    return text ? `${text} — ${name}` : null;
  };

  /** 音: 見ている相手のプレイヤー（追従の相手。俯瞰でも選んでいる相手）の視界と、その人に届いた出来事から（観戦者だけに見える情報は使わない） */
  const sound = (events: GameEvent[], quiet = false) => {
    const w = worldRef.current, pid = followRef.current;
    if (!w || !pid || !w.players[pid]) return;
    try {
      const v = projectPlayerView(w, pid);
      soundDirector.update(v, events.length ? filterEventsForPlayer(events, pid, v) : [], catalogRef.current, { quiet });
    } catch {
      /* 視界を作れない（参加の前など）ときは鳴らさない */
    }
  };

  /** events: 俯瞰つきで畳んだ 1 手の出来事。perceived: 追従だけの枠の出来事（追従の相手に届いたもの。サーバーが絞ってある） */
  const render = (events?: GameEvent[], perceived?: readonly PerceivedEvent[]) => {
    const c = catalogRef.current, r = rRef.current;
    if (!c || !r) return;
    const now = performance.now();
    bubblesRef.current = bubblesRef.current.filter((b) => b.until > now);
    const bubbles = bubblesRef.current.map((b) => ({ id: b.id, text: b.text }));
    if (followOnly) {
      const v = viewRef.current;
      const sc = v ? sceneFromView(v, c, { bubbles }) : null;
      if (sc) {
        r.draw(sc);
        // 遊ぶ画面（Play.tsx）と同じ演出。古いサーバー（出来事が空の枠）では何もしない
        if (perceived?.length) void r.animate(toViewEvents(perceived.map((e) => e.event), c));
      }
      return;
    }
    const w = worldRef.current;
    if (!w) return;
    const fpid = followRef.current;
    if (modeRef.current === 'follow' && fpid && w.players[fpid]?.state === 'alive') {
      const v = projectPlayerView(w, fpid);
      const sc = sceneFromView(v, c, { bubbles });
      if (sc) {
        r.draw(sc);
        if (events?.length) void r.animate(toViewEvents(filterEventsForPlayer(events, fpid, v), c));
        return;
      }
    }
    const auto = directorFloor(w, fpid);
    const fk = floorRef.current && w.floors[floorRef.current] ? floorRef.current : auto.floorKey;
    if (!fk) return;
    const sc = sceneFromWorld(w, c, fk, fk === auto.floorKey ? auto.focusId : null, { bubbles });
    if (!sc) return;
    r.draw(sc);
    if (events?.length) void r.animate(toViewEvents(events.filter((e) => e.floor === fk), c, true));
  };

  /** 思考の欄に足す（同じ考えを 2 回出さない）。足した行を返す */
  const pushThoughts = (lines: WatchThought[]): WatchThought[] => {
    const cur = thoughtsRef.current;
    const recent = cur.slice(-60);
    const added: WatchThought[] = [];
    for (const l of lines) {
      if (recent.some((x) => sameThought(x, l)) || added.some((x) => sameThought(x, l))) continue;
      added.push(l);
    }
    if (added.length) {
      thoughtsRef.current = [...cur, ...added].sort((a, b) => a.seq - b.seq).slice(-100);
      setThoughts(thoughtsRef.current);
    }
    return added;
  };

  /** 場面の帯を出す（S15）。重ねるのは 3 つまで。2.5 秒で消す */
  const pushBanners = (list: SceneBanner[]) => {
    if (!list.length) return;
    const now = performance.now();
    bannersRef.current = [...bannersRef.current.filter((b) => b.until > now), ...list.map((b) => ({ ...b, id: ++bannerIdRef.current, until: now + BANNER_MS }))].slice(-BANNER_MAX);
    setBanners(bannersRef.current);
    setTimeout(() => {
      const t = performance.now();
      const left = bannersRef.current.filter((b) => b.until > t);
      if (left.length !== bannersRef.current.length) { bannersRef.current = left; setBanners(left); }
    }, BANNER_MS + 50);
  };

  useEffect(() => {
    if (policy === null) return;
    if (followOnly && !follow) return;
    worldRef.current = null;
    viewRef.current = null;
    lastViewRef.current = null;
    recentRef.current = [];
    bannerPrevRef.current = null;
    setLog([]);
    const queue = queueRef.current!;
    queue.clear();
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** 描いた出来事を控える（命令の行に使う。S15） */
    const remember = (items: RecentEv[]) => {
      if (!items.length) return;
      const r = recentRef.current;
      r.push(...items);
      if (r.length > 800) r.splice(0, r.length - 800);
    };
    /** 場面の帯（S15）: 見ている相手の、前の歩と今の歩の見え方から。quiet（飛ぶとき）は出さず、今の見え方だけ覚える */
    const banner = (cur: BannerSnap | null, quiet: boolean) => {
      if (!cur) return;
      if (!quiet) pushBanners(sceneBanners(bannerPrevRef.current, cur));
      bannerPrevRef.current = cur;
    };
    /** 俯瞰つき: 見ている相手の、今の見え方の縮め（作れなければ null） */
    const worldSnap = (): BannerSnap | null => {
      const w = worldRef.current, pid = followRef.current;
      if (!w || !pid || !w.players[pid]) return null;
      try {
        return bannerSnap(projectPlayerView(w, pid));
      } catch {
        return null;
      }
    };
    /** 遅らせる観戦: まだ届いていない所の呼び出しの記録と、届いた出来事のいちばん大きい番号 */
    const held = new HeldCalls<AgentActivity>();
    let reached = 0;
    const tok = seasonTokRef.current ? { profileToken: seasonTokRef.current } : {};
    const hello = followOnly
      ? { t: 'hello' as const, role: 'spectator' as const, runId, mode: 'follow' as const, follow: follow!, ...tok }
      : { t: 'hello' as const, role: 'spectator' as const, runId, mode: 'director' as const, ...tok };

    /** 俯瞰つき: 1 手番（か、飛ぶときは溜まった全部）を World に畳む。quiet: 飛ぶとき（描かない・音・吹き出し・演出なし。文と思考の欄には足す） */
    const applyEvents = (events: GameEvent[], quiet: boolean) => {
      const c = catalogRef.current;
      const w = worldRef.current;
      if (!w) return;
      const applied: GameEvent[] = [];
      for (const ev of events) {
        if (ev.seq <= w.seq) continue;
        try {
          applyEvent(w, ev);
          applied.push(ev);
        } catch (e) {
          setError(`${tr('イベント適用エラー', 'Failed to apply event')} #${ev.seq}: ${(e as Error).message}`);
          break;
        }
      }
      if (!applied.length) return;
      const lines = c ? narrateWorld(applied, w, c, getLocale(), modeRef.current === 'follow' ? followRef.current : null) : [];
      if (lines.length) setLog((l) => [...l, ...lines].slice(-400));
      remember([
        ...applied.map((ev) => ({ seq: ev.seq, type: ev.type, ev: ev as unknown as Record<string, unknown> })),
        ...lines.map((l) => ({ seq: l.seq, type: 'line', ev: {}, text: l.text })),
      ]);
      banner(worldSnap(), quiet);
      // AI の考えと、持ち主の決定・伝言（S8 §54.6）。吹き出しは AI の考えだけ
      const added = pushThoughts(thoughtsFrom(applied, w, c));
      if (!quiet) {
        let bubble = false;
        for (const t of added) {
          if (t.kind) continue;
          const eid = w.players[t.player]?.entityId;
          if (eid) { bubblesRef.current.push({ id: eid, text: t.text, until: performance.now() + 4000 }); bubble = true; }
        }
        if (bubble) setTimeout(() => render(), 4100);
      }
      setTick((n) => n + 1);
      if (!quiet) {
        render(applied);
        sound(applied);
      }
    };
    /** 追従だけ: 1 枠を見せる（見え方を替えて描く・文・持ち主の行・音）。quiet: 飛ぶとき */
    const applyView = (m: Extract<ServerMsg, { t: 'view' }>, quiet: boolean) => {
      viewRef.current = m.view;
      setLog((l) => [...l, ...perceivedLines(m.events)].slice(-400));
      remember(m.events.map((pe) => ({ seq: pe.seq, type: pe.type, ev: pe.event as unknown as Record<string, unknown>, text: pe.text })));
      banner(bannerSnap(m.view), quiet);
      // 持ち主の決定と伝言（S8 §54.6）: 追従だけの観戦では、view の枠の出来事から。AI の考えと seq の順に並べる
      pushThoughts(ownerLinesFromPerceived(m.events, m.view, catalogRef.current));
      setTick((n) => n + 1);
      if (!quiet) {
        render(undefined, m.events);
        soundDirector.update(m.view, m.events.map((e) => e.event), catalogRef.current);
      }
    };
    /**
     * 命令ごとの 1 行（S15。SEASON.md §68.2 の 2）: 「▶ 探索: 12 手進んだ。…」を、その命令の出来事の文の上（seq の位置）に差し込む。
     * 結果の 1 文から、もう欄に出ている（か、列に残っている同じ命令の歩で出る）出来事の文を除く。つなぐ前の命令・世界が動かない呼び出しは出さない
     */
    const addActLine = (n: Extract<Note, { t: 'agent' }>) => {
      const a = n.activity;
      if (!isWorldTool(a.tool)) return;
      if (followOnly ? a.seq < connectSeqRef.current : a.seq <= connectSeqRef.current) return;
      if (!followOnly && modeRef.current === 'follow' && followRef.current && a.playerId !== followRef.current) return;
      const lo = n.after, hi = a.seq;
      const evs: RecentEv[] = recentRef.current.filter((e) => e.seq > lo && e.seq <= hi);
      const queuedWorld: GameEvent[] = [];
      for (const f of queue.stepsIn(lo, hi)) {
        if (f.t === 'view') { for (const pe of f.msg.events) if (pe.seq > lo && pe.seq <= hi) evs.push({ seq: pe.seq, type: pe.type, ev: pe.event as unknown as Record<string, unknown>, text: pe.text }); }
        else for (const ev of f.events) if (ev.seq > lo && ev.seq <= hi) { evs.push({ seq: ev.seq, type: ev.type, ev: ev as unknown as Record<string, unknown> }); queuedWorld.push(ev); }
      }
      const w0 = worldRef.current;
      // 俯瞰つき: 列に残っている同じ命令の歩（マクロの続き）の文も、今の World で文にしておく（これから欄に出る文と、結果の 1 文で重ねない）
      const c0 = catalogRef.current;
      if (queuedWorld.length && w0 && c0) {
        try {
          for (const l of narrateWorld(queuedWorld, w0, c0, getLocale(), modeRef.current === 'follow' ? followRef.current : null)) evs.push({ seq: l.seq, type: 'line', ev: {}, text: l.text });
        } catch {
          /* 文にできなければ、重なりを除かないだけ */
        }
      }
      // 協力プレイ（俯瞰つきで、プレイヤーが 2 人以上）では、だれの命令か
      const who = !followOnly && w0 && w0.playerOrder.length > 1 ? w0.players[a.playerId]?.name ?? a.playerId : null;
      const line = actionLine({
        tool: a.tool, text: a.text, who,
        flags: { returned: returnedOf(evs.map((e) => e.ev as { type: string }), a.playerId) },
        dup: evs.map((e) => e.text).filter((x): x is string => !!x),
      });
      if (line) setLog((l) => insertBySeq(l, { seq: lo + 0.5, text: line, kind: 'act' as const }).slice(-400));
    };
    /** AI の呼び出しの知らせ（その命令の歩を描くとき・列の今の位置で）: 命令の 1 行・直前の命令と、考え（吹き出しも）。吹き出しを足したら true */
    const applyAgent = (n: Extract<Note, { t: 'agent' }>, quiet: boolean): boolean => {
      const a = n.activity;
      setActivities((xs) => [...xs, a].slice(-50));
      addActLine(n);
      const text = a.args?.thought;
      if (typeof text !== 'string' || !text) return false;
      // 名前と吹き出しの相手: 追従だけの観戦は、いま描いている view（追従の相手の PlayerView）から。俯瞰つきは World から
      let name = a.playerId;
      let eid: string | undefined;
      if (followOnly) {
        const v0 = viewRef.current;
        if (!v0) return false;
        const me = v0.party.find((p) => p.playerId === a.playerId);
        name = me?.name ?? a.playerId;
        eid = me?.entityId;
      } else {
        const w0 = worldRef.current;
        if (!w0) return false;
        name = w0.players[a.playerId]?.name ?? a.playerId;
        eid = w0.players[a.playerId]?.entityId;
      }
      // 俯瞰つきでは、同じ考えが出来事（thought）からも来る（その命令の幅の中なら、同じ考えとして 2 回出さない）。
      // 追従だけの観戦（SEASON.md §42.1）と、つなぐ前の考え・手番を使わない命令の考えは、ここからだけ分かる
      const added = pushThoughts([{ seq: a.seq + 1, player: a.playerId, name, text, act: { after: n.after, upTo: a.seq } }]);
      // つなぐ前の考え（俯瞰つきは、つないだときに直近の記録をまとめて受ける）は、欄にだけ出す（吹き出しを重ねない）
      if (!added.length || quiet || !eid || (!followOnly && a.seq < connectSeqRef.current)) return false;
      bubblesRef.current.push({ id: eid, text, until: performance.now() + 4000 });
      setTimeout(() => render(), 4100);
      return true;
    };
    const applyNote = (n: Note, quiet: boolean): boolean => {
      if (n.t === 'agent') return applyAgent(n, quiet);
      if (n.t === 'macro') setMacro((s) => ({ ...s, [n.playerId]: n.text }));
      else setSummary(n.summary);
      return false;
    };
    /**
     * 1 回の取り出しを出す（歩は描き、結んだ知らせも、このとき出す）。続けて出る印（手番を使わない呼び出しなど）は、
     * 吹き出しを最後の考えの 1 つだけにし、描き直しは最後に 1 回。静かな印（隠れていた間に溜まったもの）は、欄に文を足すだけ
     */
    const deliverAll = (out: Delivery<Frame, Note>[]) => {
      // 歩と歩の間に続けて出る印の、それぞれの続きの中で、最後の（静かでない）考えの印だけが吹き出しを出す
      const loud = new Set<number>();
      let lastOfRun = -1;
      for (let i = out.length - 1; i >= -1; i--) {
        const d = i >= 0 ? out[i] : null;
        if (!d || d.kind === 'step') {
          if (lastOfRun >= 0) loud.add(lastOfRun);
          lastOfRun = -1;
          continue;
        }
        if (lastOfRun < 0 && !d.quiet && d.note.t === 'agent' && typeof d.note.activity.args?.thought === 'string' && d.note.activity.args.thought) lastOfRun = i;
      }
      let bubble = false;
      out.forEach((d, i) => {
        if (d.kind === 'mark') {
          bubble = applyNote(d.note, !!d.quiet || (d.note.t === 'agent' && !loud.has(i))) || bubble;
          return;
        }
        // 演出の速さを、今の間に合わせる（間が短いときだけ速める）
        if (rRef.current) rRef.current.speed = animSpeed(queue.interval(performance.now()));
        if (d.step.t === 'events') applyEvents(d.step.events, false);
        else applyView(d.step.msg, false);
        for (const n of d.notes) bubble = applyNote(n, false) || bubble;
      });
      if (bubble) render();
    };
    /** 今の所へ飛ぶ: 途中は描かない・音も鳴らさない（文の記録と思考の欄には足す）。最後の状態を 1 回描き、音の状態だけ合わせる */
    const applyJump = (out: Delivery<Frame, Note>[]) => {
      if (!out.length) return;
      const evs: GameEvent[] = [];
      let lastView: PlayerView | null = null;
      const lines: LogLine[] = [];
      const owners: ThoughtLine[] = [];
      const notes: Note[] = [];
      for (const d of out) {
        if (d.kind === 'mark') { notes.push(d.note); continue; }
        if (d.step.t === 'events') evs.push(...d.step.events);
        else {
          const m = d.step.msg;
          viewRef.current = m.view;
          lastView = m.view;
          lines.push(...perceivedLines(m.events));
          owners.push(...ownerLinesFromPerceived(m.events, m.view, catalogRef.current));
          remember(m.events.map((pe) => ({ seq: pe.seq, type: pe.type, ev: pe.event as unknown as Record<string, unknown>, text: pe.text })));
        }
        notes.push(...d.notes);
      }
      if (evs.length) applyEvents(evs, true);
      // 飛んだときは、場面の帯を出さない（今の見え方だけ覚える）
      if (lastView) banner(bannerSnap(lastView), true);
      if (lines.length) setLog((l) => [...l, ...lines].slice(-400));
      if (owners.length) pushThoughts(owners);
      setTick((n) => n + 1);
      for (const n of notes) applyNote(n, true);
      if (rRef.current) rRef.current.speed = 1;
      render();
      if (followOnly) { if (lastView) soundDirector.update(lastView, [], catalogRef.current, { quiet: true }); }
      else sound([], true);
    };
    const stop = () => { if (timer) { clearTimeout(timer); timer = null; } };
    /** 列を進める: 出すものを出して、次に呼ぶ時刻を決める（隠れている間は溜めるだけ） */
    const pump = () => {
      stop();
      const t0 = performance.now();
      const r = queue.tick(t0, { hidden: document.hidden });
      if (r.jumped) applyJump(r.out);
      else deliverAll(r.out);
      // 間は、この歩を出した時刻から数える（描くのにかかった時間で、間が伸びていかないように）
      if (r.next !== null) timer = setTimeout(pump, Math.max(0, r.next - (performance.now() - t0)));
    };
    /** 足したとき: 待っている時計が無ければ、すぐ進める（しばらく何も無かった後の 1 歩は、すぐ描く） */
    const kick = () => { if (!timer) pump(); };
    pumpRef.current = pump;
    jumpRef.current = () => { stop(); applyJump(queue.flush(performance.now()).out); };
    const onVisible = () => { if (!document.hidden) pump(); };
    document.addEventListener('visibilitychange', onVisible);

    /** 呼び出しの知らせを、その命令の歩に結ぶ（この命令の出来事は、そのプレイヤーの前の呼び出しより後から、記録した時点の番号まで。協力プレイでは、そのプレイヤーの歩に） */
    const attachCall = (a: AgentActivity, now: number) => {
      const r = rangesRef.current.range(a.playerId, a.seq);
      queue.attach({ t: 'agent', activity: a, after: r.after }, { ...r, actor: a.playerId }, now);
    };
    /** 俯瞰つきの体の ID → プレイヤー（スナップショットと、参加の出来事から） */
    const learnPlayers = (w: World) => {
      const map = new Map<string, string>();
      for (const pid of w.playerOrder) { const p = w.players[pid]; if (p) map.set(p.entityId, pid); }
      entityPlayerRef.current = map;
    };

    const onMsg = (m: ServerMsg) => {
      const now = performance.now();
      switch (m.t) {
        case 'welcome':
          // つなぎ直し: 列を捨てて、今の所から（俯瞰つきは、この後のスナップショットから。追従だけは、次の枠から）。「考えている」も数え直す
          stop();
          queue.clear();
          held.clear();
          lastViewRef.current = null;
          recentRef.current = [];
          bannerPrevRef.current = null;
          countFromRef.current = now;
          wsPolicyRef.current = m.policy;
          break;
        case 'snapshot':
          stop();
          queue.clear();
          held.clear();
          worldRef.current = structuredClone(m.world);
          learnPlayers(worldRef.current);
          connectSeqRef.current = m.seq;
          rangesRef.current.reset(m.seq);
          reached = m.seq;
          recentRef.current = [];
          bannerPrevRef.current = worldSnap();
          if (worldRef.current.status === 'ended') setSummary(null);
          setTick((n) => n + 1);
          render();
          sound([], true);
          break;
        case 'events': {
          if (!worldRef.current) break;
          const map = entityPlayerRef.current;
          for (const events of splitSteps(m.events)) {
            for (const ev of events) if (ev.type === 'player_joined') map.set(ev.player.entityId, ev.player.id);
            const actor = stepActor(events as unknown as ({ type: string } & Record<string, unknown>)[], (id) => map.get(id));
            queue.push({ t: 'events', events }, now, { seqs: { first: events[0].seq, last: events[events.length - 1].seq }, key: events[0].cause, actor });
            reached = Math.max(reached, events[events.length - 1].seq);
          }
          // 遅らせる観戦: 届いた出来事が追いついた呼び出しの記録を、その歩に結ぶ（追いつかないまま古くなったものは捨てる）
          for (const a of held.release(reached, now)) attachCall(a, now);
          kick();
          break;
        }
        case 'view': {
          // 1 枠 = 追従の相手が知覚した確定 1 回（サーバーが分けて送る）。出来事の番号は、前の枠より後から、この枠の見え方の番号まで。
          // 手番を打った者は、前の枠で手番だった者（分かる範囲で。つないだ直後の枠・キャンプは分からない）
          const prev = lastViewRef.current;
          const seq = m.view.seq;
          if (!prev) { connectSeqRef.current = seq; rangesRef.current.reset(seq); }
          const cur = prev?.turn.current ?? null;
          const actor = cur ? prev?.party.find((p) => p.entityId === cur)?.playerId ?? null : null;
          queue.push({ t: 'view', msg: m }, now, { seqs: { first: prev ? Math.min(seq, prev.seq + 1) : seq, last: seq }, actor });
          lastViewRef.current = m.view;
          kick();
          break;
        }
        case 'agent': {
          const a = m.activity;
          // つなぎ直しで、同じ記録がもう一度届く（俯瞰つきは、つないだときに直近の記録を受ける）
          const k = `${a.playerId}|${a.seq}|${a.tool}|${a.wall}`;
          if (actKeysRef.current.has(k)) break;
          actKeysRef.current.add(k);
          if (actKeysRef.current.size > 500) actKeysRef.current = new Set([...actKeysRef.current].slice(-250));
          actAtRef.current[a.playerId] = now;
          // 遅らせる観戦（delayed）: つないだときに届く直近の記録には、遅らせた所より先のものがある。届いた出来事が追いつくまで持つ
          if (wsPolicyRef.current === 'delayed' && a.seq > reached) { held.hold(a, a.seq, now); break; }
          attachCall(a, now);
          kick();
          break;
        }
        case 'macro':
          // 遅らせる観戦では、マクロの知らせは今の AI のもので、見えている所より先なので出さない
          if (wsPolicyRef.current === 'delayed') break;
          queue.mark({ t: 'macro', playerId: m.playerId, text: m.state === 'running' ? `${m.kind} (${m.steps})` : '' }, now);
          kick();
          break;
        case 'ended':
          // ランの終わりは、列の最後に（後から来た歩は、この前に入る。先に「終わった」と出ない）
          queue.mark({ t: 'ended', summary: m.summary }, now, { final: true });
          kick();
          break;
        case 'error':
          setError(`${m.error.message}${m.error.hint ? ` — ${m.error.hint}` : ''}`);
          break;
        default:
          break;
      }
    };
    const ws = connectWs(hello, onMsg, (s) => { wsStatusRef.current = s; setWsStatus(s); });
    return () => {
      ws.close();
      stop();
      queue.clear();
      pumpRef.current = null;
      jumpRef.current = null;
      document.removeEventListener('visibilitychange', onVisible);
      soundDirector.leave();
    };
  }, [runId, policy, followOnly ? follow : null]);

  // 俯瞰つきで見ている相手を替えたら、列を今の所まで進め（途中は描かない。§65.1 の 5。追従だけの観戦は、つなぎ直しで列を捨てる）、「考えている」を数え直す
  useEffect(() => {
    countFromRef.current = performance.now();
    // 場面の帯は、新しい相手の次の歩から（前の相手の見え方と比べない）
    bannerPrevRef.current = null;
    if (!followOnly) jumpRef.current?.();
  }, [follow]);
  useEffect(() => { render(); }, [catalog, mode, follow, floorSel]);
  // 見ている相手が替わったら、その人の視界で音を作り直す（合図は鳴らさない）
  useEffect(() => { if (!followOnly) sound([], true); }, [catalog, follow]);

  const setMode = (m: 'director' | 'follow') => { setPref('watchMode', m); setModeState(m); setLog([]); };
  /** 速さ（§65.1 の 5。ブラウザに覚える）。「すぐに」に替えたら、溜まった分は今の所へ飛ぶ */
  const changeSpeed = (s: WatchSpeed) => {
    setPref('watchSpeed', s);
    setSpeedState(s);
    const q = queueRef.current!;
    q.speed = s;
    if (s === 'instant') jumpRef.current?.();
    else pumpRef.current?.();
  };

  const w = worldRef.current;
  let obsText: string | null = null;
  const obsPid = follow ?? (w ? w.playerOrder.find((p) => w.players[p].controller.kind === 'agent') ?? null : null);
  const lastAct = [...activities].reverse().find((a) => a.playerId === obsPid);
  if (lastAct?.text) obsText = lastAct.text;
  else if (catalog && obsPid) {
    try {
      const v = followOnly ? viewRef.current : w && w.players[obsPid] ? projectPlayerView(w, obsPid) : null;
      if (v) obsText = formatObservationText(buildObservation(v, catalog, { detail: 'brief', map: true }), v.locale);
    } catch {
      obsText = null;
    }
  }
  const floors = w ? Object.keys(w.floors).sort((a, b) => parseInt(a.split(':')[1], 10) - parseInt(b.split(':')[1], 10)) : [];
  // 遠征の目的と状態: 俯瞰は World の最新の遠征、追従は射影した PlayerView
  let expInfo: ExpInfo | null = null;
  let campNote: string | null = null;
  // キャンプにいる相手のメモ（S7 §52.2 の 4。読むだけ）
  let campNotes: { who: string; notes: string[] } | null = null;
  // 追従で見ている相手がキャンプにいれば、地図を隠してキャンプの絵（ASSET_SPEC §7.7）。俯瞰と終わったランは地図のまま
  const followCamp = followOnly
    ? viewRef.current?.status === 'at_camp'
    : mode === 'follow' && !!follow && !!w && w.status !== 'ended' && w.players[follow]?.state === 'at_camp';
  try {
    if (followOnly) {
      const v = viewRef.current;
      if (v) {
        expInfo = followExpInfo(v, catalog);
        if (v.status === 'at_camp') { campNote = tr(`${v.self.name} はキャンプにいる（盤面の外）`, `${v.self.name} is at camp (off the board)`); campNotes = { who: v.self.name, notes: v.notes }; }
      }
    } else if (w) {
      if (mode === 'follow' && follow && w.players[follow]) {
        expInfo = followExpInfo(projectPlayerView(w, follow), catalog);
        if (w.players[follow].state === 'at_camp') { campNote = tr(`${w.players[follow].name} はキャンプにいる（盤面の外）`, `${w.players[follow].name} is at camp (off the board)`); campNotes = { who: w.players[follow].name, notes: w.players[follow].knowledge.notes }; }
      } else {
        const fk = featuredFloor(w);
        expInfo = directorExpInfo(w, fk ? w.floors[fk]?.depth ?? null : null, catalog);
      }
    }
  } catch {
    expInfo = null;
  }
  const players = w ? w.playerOrder.map((pid) => ({ id: pid, name: w.players[pid].name })) : (listing?.players ?? []).map((p) => ({ id: p.id, name: p.name }));

  return (
    <div class="page watch">
      <Header title={`${tr('観戦', 'Spectate')} ${runId}`} back>
        <span class={`ws ${wsStatus}`}>{wsStatus}</span>
        <ThemePicker themes={th.themes} themeId={th.themeId} onChange={th.setThemeId} />
        <SoundControls />
        {/* 巻き戻しは、開けるランだけ（S15。開催中のシーズンの、終わっていないランは、確定するまで見返せない: §25.1） */}
        {canRewind && <a class="button small" href={`#/replay/${runId}`}>{tr('巻き戻し', 'Rewind')}</a>}
      </Header>
      <ErrorBanner error={error ?? catErr ?? th.error} onClose={() => setError(null)} />
      <div class="toolbar">
        {!followOnly && (
          <span class="seg">
            <button class={`small ${mode === 'director' ? 'on' : ''}`} onClick={() => setMode('director')}>{tr('俯瞰', 'Director')}</button>
            <button class={`small ${mode === 'follow' ? 'on' : ''}`} onClick={() => setMode('follow')}>{tr('追従', 'Follow')}</button>
          </span>
        )}
        {followOnly && <span class="muted">{tr('公開設定により追従視点のみ', 'Follow view only (server policy)')}</span>}
        <label class="inline">{tr('対象', 'Player')}
          <select value={follow ?? ''} onChange={(e) => setFollow((e.target as HTMLSelectElement).value || null)}>
            {players.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {!followOnly && mode === 'director' && floors.length > 1 && (
          <label class="inline">{tr('フロア', 'Floor')}
            <select value={floorSel ?? ''} onChange={(e) => setFloorSel((e.target as HTMLSelectElement).value || null)}>
              <option value="">{tr('自動', 'auto')}</option>
              {floors.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </label>
        )}
        <span class="seg playspeed" title={tr('再生の速さ（1 手番の間）。「すぐに」は、届いたときに描く', 'Playback speed (time per turn). "Instant" draws each turn as it arrives')}>
          <span class="muted">{tr('再生', 'Playback')}</span>
          {WATCH_SPEEDS.map((s) => <button key={s} class={`small ${speed === s ? 'on' : ''}`} onClick={() => changeSpeed(s)}>{speedLabel(s)}</button>)}
        </span>
        {speed !== 'instant' && <PlaybackLag queue={queueRef.current!} onJump={() => jumpRef.current?.()} />}
        {w && <span class="muted">seq {w.seq} {w.status === 'ended' ? tr('（終了）', '(ended)') : ''}</span>}
      </div>
      <div class="layout">
        <div class="main">
          <MapView
            theme={th.theme}
            onReady={(r) => { rRef.current = r; render(); }}
            overlay={
              <>
                {followCamp && <CampScene theme={th.theme} />}
                <AgentWaitBadge probe={waitProbe} />
                <SceneBanners items={banners} />
                {/* 自動行動の知らせは、地図の上に重ねる（S15: 上の段で出入りすると、地図の枠の高さが変わっていた） */}
                {campNote
                  ? <div class="macro">{campNote}</div>
                  : Object.values(macro).some(Boolean) && (
                    <div class="macro">{Object.entries(macro).filter(([, v]) => v).map(([pid, v]) => <span key={pid} class="tag">{w?.players[pid]?.name ?? pid}: {v}</span>)}</div>
                  )}
              </>
            }
          />
        </div>
        <aside class="side">
          <ExpeditionStatusPanel info={expInfo} />
          {campNotes && campNotes.notes.length > 0 && <section class="panel"><NotesBlock notes={campNotes.notes} who={campNotes.who} /></section>}
          {w && catalog && <PartyPanel world={w} catalog={catalog} follow={follow} onFollow={(pid) => setFollow(pid)} />}
          <AiPanel thoughts={thoughts} activities={activities} observationText={obsText} />
          <MessageLog lines={log} title={mode === 'follow' || followOnly ? tr('メッセージ（追従）', 'Messages (follow)') : tr('メッセージ（俯瞰）', 'Messages (director)')} />
        </aside>
      </div>
      {summary && <SummaryDialog summary={summary} catalog={catalog} onClose={() => setSummary(null)} />}
    </div>
  );
}

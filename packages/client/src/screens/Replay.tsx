// リプレイ: キーフレーム＋イベント列を shared の applyEvent で畳むだけ（ゲームロジック不要）。
// 再生/停止、0.25x〜16x、1 イベント／1 手番送り、シーク、マーカージャンプ、視点切替、thought 表示。
// 進行中のランも末尾を再取得して巻き戻し観戦できる。
import type { CommandRecord, ExpeditionBrief, GameEvent, Marker, RunIndex, RunMetaFile, World } from '@muse/shared';
import { applyEvent, buildObservation, emptyWorld, endReasonText, formatObservationText, objectiveText, projectPlayerView } from '@muse/shared';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import type { Canvas2DRenderer } from '../render/canvas2d';
import { toViewEvents } from '../render/events';
import { directorFloor, sceneFromView, sceneFromWorld } from '../render/scene';
import { ErrorBanner, Header, MapView, ThemePicker, useCatalog, useLocaleRefresh, useTheme } from '../ui/common';
import { directorExpInfo, ExpeditionStatusPanel, followExpInfo, type ExpInfo } from '../ui/expedition';
import { expStatusLabel } from '../ui/labels';
import { narrateWorld, thoughtsFrom } from '../ui/narration';
import { AiPanel, MessageLog, PartyPanel } from '../ui/panels';
import { clamp, getLocale, tr } from '../util';
import { filterEventsForPlayer } from '@muse/shared';
import { soundDirector } from '../sound/director';
import { SoundControls } from '../ui/sound';
import { CampScene } from '../ui/camp';

const CHUNK = 5000;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
const MARKER_LABEL: Record<string, [string, string]> = {
  join: ['参加', 'join'], floor: ['階移動', 'floor'], level_up: ['Lv up', 'level up'], kill: ['撃破', 'kill'],
  near_death: ['瀕死', 'near death'], death: ['死亡', 'death'], thought: ['思考', 'thought'], end: ['終了', 'end'],
  expedition_start: ['遠征開始', 'expedition start'], objective: ['目的達成', 'objective'], expedition_end: ['遠征終了', 'expedition end'],
};

/** seq を含む遠征（開始〜終了。終了前なら開始以降すべて） */
function expeditionAt(list: readonly ExpeditionBrief[], seq: number): ExpeditionBrief | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i];
    if (seq >= x.startSeq && (x.endSeq === null || seq <= x.endSeq)) return x;
  }
  return null;
}

interface Bubble { id: string; text: string; until: number }

/** 昇順の配列で seq より大きい最初の index */
function upperBound(events: GameEvent[], seq: number): number {
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].seq <= seq) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function Replay({ runId }: { runId: string }) {
  useLocaleRefresh();
  const { catalog, error: catErr } = useCatalog();
  const th = useTheme(catalog);
  const [index, setIndex] = useState<RunIndex | null>(null);
  const [meta, setMeta] = useState<RunMetaFile | null>(null);
  const [commands, setCommands] = useState<CommandRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const [seq, setSeq] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [realtime, setRealtime] = useState(false);
  const [mode, setMode] = useState<'director' | 'follow'>('director');
  const [follow, setFollow] = useState<string | null>(null);
  const [markerFilter, setMarkerFilter] = useState<string>('all');
  const [, setTick] = useState(0);

  const eventsRef = useRef<GameEvent[]>([]);
  const loadedToRef = useRef(0);
  const kfCache = useRef(new Map<number, World>());
  const worldRef = useRef<World | null>(null);
  const posRef = useRef(0);
  const rRef = useRef<Canvas2DRenderer | null>(null);
  const catalogRef = useRef(catalog);
  const bubblesRef = useRef<Bubble[]>([]);
  const indexRef = useRef<RunIndex | null>(null);
  const seekToken = useRef(0);
  /** 食い違いの後の続きの境目（seq_resumed）で、境目のキーフレームへ飛んでいる最中（S3h。その間は進めない） */
  const boundarySeek = useRef<number | null>(null);
  const stateRef = useRef({ mode, follow, speed, realtime, playing });
  catalogRef.current = catalog;
  stateRef.current = { mode, follow, speed, realtime, playing };

  const render = (applied?: GameEvent[]) => {
    const c = catalogRef.current, r = rRef.current, w = worldRef.current;
    if (!c || !r || !w) return;
    r.speed = stateRef.current.speed;
    const now = performance.now();
    bubblesRef.current = bubblesRef.current.filter((b) => b.until > now);
    const bubbles = bubblesRef.current.map((b) => ({ id: b.id, text: b.text }));
    const { mode: md, follow: fp } = stateRef.current;
    if (md === 'follow' && fp && w.players[fp]?.state === 'alive') {
      const v = projectPlayerView(w, fp);
      const sc = sceneFromView(v, c, { bubbles });
      if (sc) {
        r.draw(sc);
        if (applied?.length && stateRef.current.speed <= 8) void r.animate(toViewEvents(filterEventsForPlayer(applied, fp, v), c));
        return;
      }
    }
    const auto = directorFloor(w, fp);
    if (!auto.floorKey) return;
    const sc = sceneFromWorld(w, c, auto.floorKey, auto.focusId, { bubbles });
    if (!sc) return;
    r.draw(sc);
    if (applied?.length && stateRef.current.speed <= 8) void r.animate(toViewEvents(applied.filter((e) => e.floor === auto.floorKey), c, true));
  };

  /**
   * 音: 見ている相手のプレイヤー（選んでいる相手。いなければ最初のプレイヤー）の視界と、その人に届いた出来事から。
   * 飛んだとき（seek）と速い再生（×8 より速い）では合図を鳴らさない
   */
  const sound = (applied: GameEvent[], quiet = false) => {
    const w = worldRef.current;
    const pid = stateRef.current.follow ?? w?.playerOrder[0];
    if (!w || !pid || !w.players[pid]) return;
    try {
      const v = projectPlayerView(w, pid);
      soundDirector.update(v, applied.length ? filterEventsForPlayer(applied, pid, v) : [], catalogRef.current, { quiet: quiet || stateRef.current.speed > 8 });
    } catch {
      /* 視界を作れない（参加の前など）ときは鳴らさない */
    }
  };

  const keyframeWorld = async (kf: number): Promise<World> => {
    let w = kfCache.current.get(kf);
    if (!w) {
      w = await api.keyframe(runId, kf);
      kfCache.current.set(kf, w);
    }
    return structuredClone(w);
  };

  const seek = async (target: number) => {
    const token = ++seekToken.current;
    const kfs = (indexRef.current?.keyframes ?? []).filter((k) => k <= target).sort((a, b) => b - a);
    let w: World;
    let from = 0;
    if (kfs.length) {
      try {
        w = await keyframeWorld(kfs[0]);
        from = kfs[0];
      } catch (e) {
        setError(`${tr('キーフレーム取得失敗', 'Keyframe fetch failed')}: ${errorText(e)}`);
        w = emptyWorld();
      }
    } else w = emptyWorld();
    if (token !== seekToken.current) return;
    boundarySeek.current = null;
    const evs = eventsRef.current;
    let i = upperBound(evs, from);
    while (i < evs.length && evs[i].seq <= target) {
      try { applyEvent(w, evs[i]); } catch (e) { setError(`#${evs[i].seq}: ${(e as Error).message}`); break; }
      i++;
    }
    worldRef.current = w;
    posRef.current = i;
    bubblesRef.current = [];
    setSeq(w.seq);
    render();
    sound([], true);
  };

  /** n イベント、または次の手番開始（turn_began）まで進める */
  const advance = (byTurn: boolean, n = 1): GameEvent[] => {
    const w = worldRef.current;
    const evs = eventsRef.current;
    if (!w || boundarySeek.current !== null) return [];
    const applied: GameEvent[] = [];
    let count = 0;
    while (posRef.current < evs.length) {
      const ev = evs[posRef.current++];
      if (ev.seq <= w.seq) continue;
      // 食い違いの後の続きの境目（S3h。SEASON.md §41.10 の中 2）: 境目より前は前の版の出来事なので、境目のキーフレームから畳み直す
      if (ev.type === 'seq_resumed' && (indexRef.current?.keyframes ?? []).includes(ev.seq)) {
        posRef.current--;
        boundarySeek.current = ev.seq;
        void seek(ev.seq);
        break;
      }
      try { applyEvent(w, ev); } catch (e) { setError(`#${ev.seq}: ${(e as Error).message}`); break; }
      applied.push(ev);
      if (!byTurn && ++count >= n) break;
      if (byTurn && ev.type === 'turn_began') break;
    }
    if (applied.length) {
      const now = performance.now();
      for (const t of thoughtsFrom(applied, w)) {
        // 吹き出しは AI の考えだけ（持ち主の決定・伝言は思考の欄に出す。S8 §54.6）
        if (t.kind) continue;
        const eid = w.players[t.player]?.entityId;
        if (eid) bubblesRef.current.push({ id: eid, text: t.text, until: now + Math.max(600, 3500 / stateRef.current.speed) });
      }
      setSeq(w.seq);
      render(applied);
      sound(applied);
    }
    return applied;
  };

  // 読み込み
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const idx = await api.index(runId);
        if (!alive) return;
        indexRef.current = idx;
        setIndex(idx);
        api.meta(runId).then((m) => alive && setMeta(m)).catch(() => undefined);
        api.commands(runId).then((c) => alive && setCommands(c)).catch(() => undefined);
        let first = true;
        for (let from = 1; from <= idx.lastSeq; from += CHUNK) {
          const to = Math.min(idx.lastSeq, from + CHUNK - 1);
          const chunk = await api.events(runId, from, to);
          if (!alive) return;
          eventsRef.current.push(...chunk);
          loadedToRef.current = to;
          setLoaded(to);
          if (first) {
            first = false;
            const startSeq = idx.keyframes.length ? Math.min(...idx.keyframes) : (eventsRef.current[0]?.seq ?? 0);
            await seek(startSeq);
            const w = worldRef.current;
            if (w && !stateRef.current.follow) setFollow(w.playerOrder[0] ?? null);
          }
        }
        if (first) await seek(0);
      } catch (e) {
        if (alive) setError(errorText(e));
      }
    })();
    return () => { alive = false; };
  }, [runId]);

  // 進行中のランは末尾を追いかける
  useEffect(() => {
    const t = setInterval(async () => {
      const idx = indexRef.current;
      if (!idx || meta?.status === 'ended') return;
      try {
        const n = await api.index(runId);
        indexRef.current = n;
        setIndex(n);
        if (n.lastSeq > loadedToRef.current) {
          const chunk = await api.events(runId, loadedToRef.current + 1, n.lastSeq);
          eventsRef.current.push(...chunk);
          loadedToRef.current = n.lastSeq;
          setLoaded(n.lastSeq);
        }
        if (worldRef.current?.status === 'ended') api.meta(runId).then(setMeta).catch(() => undefined);
      } catch {
        /* 次回再試行 */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [runId, meta?.status]);

  // 再生ループ
  useEffect(() => {
    if (!playing) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      const before = eventsRef.current[posRef.current - 1]?.wall ?? 0;
      const applied = advance(true);
      const { speed: sp, realtime: rt } = stateRef.current;
      let delay = 280 / sp;
      if (rt && applied.length) {
        const after = applied[applied.length - 1].wall;
        delay = clamp((after - before) / sp, 16, 4000);
      }
      if (!applied.length) delay = 1000; // 末尾に到達: 追記を待つ
      timer = setTimeout(tick, delay);
    };
    tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [playing]);

  useEffect(() => { render(); }, [catalog, mode, follow, speed]);
  // 見ている相手が替わったら、その人の視界で音を作り直す（合図は鳴らさない）。画面を離れたら流れを切る
  useEffect(() => { sound([], true); }, [catalog, follow]);
  useEffect(() => () => soundDirector.leave(), [runId]);

  const w = worldRef.current;
  const lastSeq = index?.lastSeq ?? 0;
  const firstSeq = index?.keyframes.length ? Math.min(...index.keyframes) : 0;
  const markers: Marker[] = (index?.markers ?? []).filter((m) => markerFilter === 'all' || m.type === markerFilter);
  const L = getLocale();

  const recentLines = useMemo(() => {
    if (!w || !catalog) return [];
    const evs = eventsRef.current;
    const start = Math.max(0, posRef.current - 120);
    return narrateWorld(evs.slice(start, posRef.current), w, catalog, L, mode === 'follow' ? follow : null);
  }, [seq, mode, follow, catalog, L]);

  // AI の考えと、持ち主の決定・伝言（S8 §54.6。そのプレイヤーの出来事として World に載っている）を seq の順に
  const thoughts = useMemo(() => {
    if (!w) return [];
    const evs = eventsRef.current;
    const out = thoughtsFrom(evs.slice(Math.max(0, posRef.current - 3000), posRef.current), w, catalog);
    return follow && mode === 'follow' ? out.filter((t) => t.player === follow) : out;
  }, [seq, follow, mode, catalog, L]);

  const cmdView = useMemo(() => {
    const firstChild = new Map<number, number>();
    for (const c of commands) if (c.parent !== undefined && c.resultSeq) {
      const cur = firstChild.get(c.parent);
      if (cur === undefined || c.resultSeq[0] < cur) firstChild.set(c.parent, c.resultSeq[0]);
    }
    const startOf = (c: CommandRecord) => c.resultSeq?.[0] ?? firstChild.get(c.cseq) ?? Number.POSITIVE_INFINITY;
    return commands.filter((c) => c.source !== 'macro' && startOf(c) <= seq && (!follow || c.player === follow)).slice(-30);
  }, [commands, seq, follow]);

  const obsText = useMemo(() => {
    if (!w || !catalog) return null;
    const pid = follow ?? w.playerOrder[0];
    if (!pid || !w.players[pid]) return null;
    try {
      const v = projectPlayerView(w, pid);
      return formatObservationText(buildObservation(v, catalog, { detail: 'brief', map: true }), v.locale);
    } catch {
      return null;
    }
  }, [seq, follow, catalog]);

  const jump = (dir: 1 | -1) => {
    const list = markers.map((m) => m.seq).sort((a, b) => a - b);
    const target = dir > 0 ? list.find((s) => s > seq) : [...list].reverse().find((s) => s < seq);
    if (target !== undefined) void seek(target);
  };

  const pct = (s: number) => (lastSeq > firstSeq ? ((s - firstSeq) / (lastSeq - firstSeq)) * 100 : 0);
  const exps = index?.expeditions ?? [];
  const curExp = expeditionAt(exps, seq);
  /** 終了した遠征の確定・失った点（表示中の時点の World に結果があるときだけ。追従中はその人の分） */
  const payoutOfExp = (no: number): string => {
    const pay = w?.expeditions?.find((e) => e.no === no)?.result?.payout;
    if (!pay) return '';
    const p = mode === 'follow' && follow ? pay.players.find((pp) => pp.player === follow) : undefined;
    const banked = p ? p.banked : pay.banked;
    const lost = p ? p.lost : pay.lost;
    return tr(` 確定 +${banked}${lost ? `・失 ${lost}` : ''}`, ` banked +${banked}${lost ? `, lost ${lost}` : ''}`);
  };
  const expOption = (x: ExpeditionBrief) => `${tr(`遠征 ${x.no}`, `Expedition ${x.no}`)}: ${objectiveText(L, x.objective)} — ${x.status === 'ended' ? endReasonText(L, x.endReason) : expStatusLabel(x).text}${payoutOfExp(x.no)}`;
  const jumpExpedition = (no: number) => {
    const x = exps.find((e) => e.no === no);
    if (!x) return;
    setPlaying(false);
    void seek(Math.max(firstSeq, x.startSeq));
  };

  let expInfo: ExpInfo | null = null;
  if (w) {
    try {
      if (mode === 'follow' && follow && w.players[follow]) expInfo = followExpInfo(projectPlayerView(w, follow), catalog);
      else {
        const fk = directorFloor(w, follow).floorKey;
        expInfo = directorExpInfo(w, fk ? w.floors[fk]?.depth ?? null : null, catalog);
      }
    } catch {
      expInfo = null;
    }
  }

  return (
    <div class="page replay">
      <Header title={`${tr('リプレイ', 'Replay')} ${runId}`}>
        <ThemePicker themes={th.themes} themeId={th.themeId} onChange={th.setThemeId} />
        <SoundControls />
        {meta?.status === 'active' && <a class="button small" href={`#/watch/${runId}`}>{tr('ライブへ', 'Go live')}</a>}
      </Header>
      <ErrorBanner error={error ?? catErr ?? th.error} onClose={() => setError(null)} />
      <div class="toolbar">
        <button class="small" onClick={() => setPlaying((p) => !p)} disabled={!w}>{playing ? '⏸' : '▶'}</button>
        <button class="small" title={tr('1 イベント送り', 'Step one event')} onClick={() => { setPlaying(false); advance(false, 1); }} disabled={!w}>+1ev</button>
        <button class="small" title={tr('1 手番送り', 'Step one turn')} onClick={() => { setPlaying(false); advance(true); }} disabled={!w}>+1{tr('手', 'turn')}</button>
        <label class="inline">{tr('速度', 'Speed')}
          <select value={String(speed)} onChange={(e) => setSpeed(parseFloat((e.target as HTMLSelectElement).value))}>
            {SPEEDS.map((s) => <option key={s} value={String(s)}>{s}x</option>)}
          </select>
        </label>
        <label class="inline"><input type="checkbox" checked={realtime} onChange={(e) => setRealtime((e.target as HTMLInputElement).checked)} />{tr('実時間ペース', 'Real-time pace')}</label>
        <span class="seg">
          <button class={`small ${mode === 'director' ? 'on' : ''}`} onClick={() => setMode('director')}>{tr('俯瞰', 'Director')}</button>
          <button class={`small ${mode === 'follow' ? 'on' : ''}`} onClick={() => setMode('follow')}>{tr('追従', 'Follow')}</button>
        </span>
        {w && (
          <label class="inline">{tr('対象', 'Player')}
            <select value={follow ?? ''} onChange={(e) => setFollow((e.target as HTMLSelectElement).value || null)}>
              {w.playerOrder.map((pid) => <option key={pid} value={pid}>{w.players[pid].name}</option>)}
            </select>
          </label>
        )}
        <span class="muted">seq {seq} / {lastSeq}{loaded < lastSeq ? ` (${tr('読込', 'loading')} ${loaded})` : ''}</span>
        {exps.length > 0 && (
          <label class="inline">{tr('遠征', 'Expedition')}
            <select value={curExp ? String(curExp.no) : ''} onChange={(e) => { const v = (e.target as HTMLSelectElement).value; if (v) jumpExpedition(parseInt(v, 10)); }}>
              <option value="">{tr('（遠征の外）', '(between expeditions)')}</option>
              {exps.map((x) => <option key={x.no} value={String(x.no)}>{expOption(x)}</option>)}
            </select>
          </label>
        )}
        {curExp && (
          <span class="muted">
            #{curExp.startSeq}〜{curExp.endSeq !== null ? `#${curExp.endSeq}` : tr('進行中', 'ongoing')}
            {' '}{curExp.status === 'ended'
              ? `（${endReasonText(L, curExp.endReason)}${payoutOfExp(curExp.no) || (curExp.endReason === 'completed' ? ` +${curExp.points}` : '')}）`
              : ''}
          </span>
        )}
      </div>
      <div class="timeline">
        <div class="track">
          {exps.map((x) => {
            const a = pct(Math.max(firstSeq, x.startSeq));
            const b = pct(x.endSeq ?? lastSeq);
            return (
              <span key={`exp-${x.no}`} class={`expband ${x.endReason ?? 'ongoing'} ${curExp?.no === x.no ? 'cur' : ''}`}
                style={{ left: `${a}%`, width: `${Math.max(0.3, b - a)}%` }} title={`${expOption(x)}（#${x.startSeq}〜${x.endSeq ?? ''}）`} onClick={() => jumpExpedition(x.no)} />
            );
          })}
          {markers.slice(0, 600).map((m, i) => (
            <span key={`${m.seq}-${i}`} class={`marker ${m.type}`} style={{ left: `${pct(m.seq)}%` }} title={`#${m.seq} ${m.label}`} onClick={() => void seek(m.seq)} />
          ))}
          <input type="range" min={firstSeq} max={Math.max(firstSeq, lastSeq)} value={seq}
            onInput={(e) => { setPlaying(false); void seek(parseInt((e.target as HTMLInputElement).value, 10)); }} />
        </div>
        <div class="row">
          <button class="small" onClick={() => jump(-1)}>⏮ {tr('前のマーカー', 'Prev marker')}</button>
          <select value={markerFilter} onChange={(e) => setMarkerFilter((e.target as HTMLSelectElement).value)}>
            <option value="all">{tr('全マーカー', 'All markers')}</option>
            {Object.entries(MARKER_LABEL).map(([k, v]) => <option key={k} value={k}>{L === 'en' ? v[1] : v[0]}</option>)}
          </select>
          <button class="small" onClick={() => jump(1)}>{tr('次のマーカー', 'Next marker')} ⏭</button>
          <button class="small" onClick={() => void seek(firstSeq)}>{tr('先頭', 'Start')}</button>
          <button class="small" onClick={() => void seek(lastSeq)}>{tr('末尾', 'End')}</button>
        </div>
      </div>
      <div class="layout">
        <div class="main">
          <MapView theme={th.theme} onReady={(r) => { rRef.current = r; render(); setTick((n) => n + 1); }}
            overlay={mode === 'follow' && follow && w && w.status !== 'ended' && w.players[follow]?.state === 'at_camp' ? <CampScene theme={th.theme} /> : undefined} />
        </div>
        <aside class="side">
          <ExpeditionStatusPanel info={expInfo} />
          {w && catalog && <PartyPanel world={w} catalog={catalog} follow={follow} onFollow={(pid) => setFollow(pid)} />}
          <AiPanel thoughts={thoughts} commands={cmdView} observationText={obsText} />
          <MessageLog lines={recentLines} />
        </aside>
      </div>
    </div>
  );
}

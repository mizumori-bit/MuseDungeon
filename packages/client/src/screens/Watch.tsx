// ライブ観戦。スナップショット＋イベントを shared の applyEvent で畳む（リプレイと同じ経路）。
// 俯瞰: World そのまま。追従: projectPlayerView。spectatorPolicy=follow_only ではサーバーの PlayerView フレームのみ。
import type { AgentActivity, GameEvent, PlayerView, RunListing, RunSummary, ServerMsg, SpectatorPolicy, World } from '@muse/shared';
import { applyEvent, buildObservation, filterEventsForPlayer, formatObservationText, projectPlayerView } from '@muse/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, errorText } from '../api';
import { connectWs, type WsStatus } from '../net/ws';
import type { Canvas2DRenderer } from '../render/canvas2d';
import { toViewEvents } from '../render/events';
import { directorFloor, sceneFromView, sceneFromWorld } from '../render/scene';
import { soundDirector } from '../sound/director';
import { ErrorBanner, Header, MapView, ThemePicker, useCatalog, useLocaleRefresh, useTheme } from '../ui/common';
import { SoundControls } from '../ui/sound';
import { AgentWaitBadge, directorExpInfo, ExpeditionStatusPanel, followExpInfo, type ExpInfo } from '../ui/expedition';
import { narrateWorld, perceivedLines, thoughtsFrom } from '../ui/narration';
import { AiPanel, MessageLog, PartyPanel, SummaryDialog, type LogLine, type ThoughtLine } from '../ui/panels';
import { getLocale, getPref, setPref, tr } from '../util';

interface Bubble { id: string; text: string; until: number }

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

  const worldRef = useRef<World | null>(null);
  const viewRef = useRef<PlayerView | null>(null);
  const rRef = useRef<Canvas2DRenderer | null>(null);
  const catalogRef = useRef(catalog);
  const modeRef = useRef(mode);
  const followRef = useRef<string | null>(follow);
  const floorRef = useRef<string | null>(floorSel);
  const bubblesRef = useRef<Bubble[]>([]);
  /** 最後にイベント・AI の記録を受け取った時刻（「AI の応答待ち」の秒数） */
  const lastMsgRef = useRef<number>(performance.now());
  const macroRef = useRef<Record<string, string>>({});
  catalogRef.current = catalog;
  modeRef.current = mode;
  followRef.current = follow;
  floorRef.current = floorSel;
  macroRef.current = macro;

  useEffect(() => {
    api.config().then((c) => setPolicy(c.spectatorPolicy)).catch(() => setPolicy('omniscient'));
    api.runs().then((rs) => {
      const r = rs.find((x) => x.runId === runId) ?? null;
      setListing(r);
      if (r && !followRef.current) setFollow(r.players.find((p) => p.state === 'alive' || p.state === 'at_camp')?.id ?? r.players[0]?.id ?? null);
    }).catch((e) => setError(errorText(e)));
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

  /** 表示中のフロアの手番が AI 操作のプレイヤーなら、その名前（マクロ実行中は除く） */
  const agentTurn = (): { name: string } | null => {
    if (followOnly) {
      const v = viewRef.current;
      if (!v || v.runStatus === 'ended' || !v.turn.current) return null;
      const p = v.party.find((pp) => pp.entityId === v.turn.current);
      return p && p.controller.kind === 'agent' && p.state === 'alive' && !macroRef.current[p.playerId] ? { name: p.name } : null;
    }
    const w = worldRef.current;
    if (!w || w.status === 'ended') return null;
    const fk = featuredFloor(w);
    const cur = fk ? w.floors[fk]?.currentActor : null;
    const pid = cur ? w.entities[cur]?.player : undefined;
    const pr = pid ? w.players[pid] : undefined;
    if (!pid || !pr || pr.controller.kind !== 'agent' || pr.state !== 'alive' || macroRef.current[pid]) return null;
    return { name: pr.name };
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

  const render = (events?: GameEvent[]) => {
    const c = catalogRef.current, r = rRef.current;
    if (!c || !r) return;
    const now = performance.now();
    bubblesRef.current = bubblesRef.current.filter((b) => b.until > now);
    const bubbles = bubblesRef.current.map((b) => ({ id: b.id, text: b.text }));
    if (followOnly) {
      const v = viewRef.current;
      const sc = v ? sceneFromView(v, c, { bubbles }) : null;
      if (sc) r.draw(sc);
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

  useEffect(() => {
    if (policy === null) return;
    if (followOnly && !follow) return;
    worldRef.current = null;
    viewRef.current = null;
    setLog([]);
    const hello = followOnly
      ? { t: 'hello' as const, role: 'spectator' as const, runId, mode: 'follow' as const, follow: follow! }
      : { t: 'hello' as const, role: 'spectator' as const, runId, mode: 'director' as const };
    const onMsg = (m: ServerMsg) => {
      const c = catalogRef.current;
      if (m.t === 'snapshot' || m.t === 'events' || m.t === 'view' || m.t === 'agent' || m.t === 'macro') lastMsgRef.current = performance.now();
      switch (m.t) {
        case 'snapshot':
          worldRef.current = structuredClone(m.world);
          if (worldRef.current.status === 'ended') setSummary(null);
          setTick((n) => n + 1);
          render();
          sound([], true);
          break;
        case 'events': {
          const w = worldRef.current;
          if (!w) break;
          const applied: GameEvent[] = [];
          for (const ev of m.events) {
            if (ev.seq <= w.seq) continue;
            try {
              applyEvent(w, ev);
              applied.push(ev);
            } catch (e) {
              setError(`${tr('イベント適用エラー', 'Failed to apply event')} #${ev.seq}: ${(e as Error).message}`);
              break;
            }
          }
          if (!applied.length) break;
          if (c) setLog((l) => [...l, ...narrateWorld(applied, w, c, getLocale(), modeRef.current === 'follow' ? followRef.current : null)].slice(-400));
          const th2 = thoughtsFrom(applied, w);
          if (th2.length) {
            setThoughts((t) => [...t, ...th2].slice(-100));
            for (const t of th2) {
              const eid = w.players[t.player]?.entityId;
              if (eid) bubblesRef.current.push({ id: eid, text: t.text, until: performance.now() + 4000 });
            }
            setTimeout(() => render(), 4100);
          }
          setTick((n) => n + 1);
          render(applied);
          sound(applied);
          break;
        }
        case 'view':
          viewRef.current = m.view;
          setLog((l) => [...l, ...perceivedLines(m.events)].slice(-400));
          setTick((n) => n + 1);
          render();
          soundDirector.update(m.view, m.events.map((e) => e.event), catalogRef.current);
          break;
        case 'agent': {
          setActivities((a) => [...a, m.activity].slice(-50));
          // 接続前の thought はスナップショットに含まれないので、ツール呼び出し記録から補う
          const text = m.activity.args?.thought;
          const w0 = worldRef.current;
          if (typeof text === 'string' && text && w0 && m.activity.seq < w0.seq) {
            const line: ThoughtLine = { seq: m.activity.seq + 1, player: m.activity.playerId, name: w0.players[m.activity.playerId]?.name ?? m.activity.playerId, text };
            setThoughts((t) => (t.some((x) => x.text === line.text && x.seq === line.seq) ? t : [...t, line].sort((a, b) => a.seq - b.seq).slice(-100)));
          }
          break;
        }
        case 'macro':
          setMacro((s) => ({ ...s, [m.playerId]: m.state === 'running' ? `${m.kind} (${m.steps})` : '' }));
          break;
        case 'ended':
          setSummary(m.summary);
          break;
        case 'error':
          setError(`${m.error.message}${m.error.hint ? ` — ${m.error.hint}` : ''}`);
          break;
        default:
          break;
      }
    };
    const ws = connectWs(hello, onMsg, setWsStatus);
    return () => { ws.close(); soundDirector.leave(); };
  }, [runId, policy, followOnly ? follow : null]);

  useEffect(() => { render(); }, [catalog, mode, follow, floorSel]);
  // 見ている相手が替わったら、その人の視界で音を作り直す（合図は鳴らさない）
  useEffect(() => { if (!followOnly) sound([], true); }, [catalog, follow]);

  const setMode = (m: 'director' | 'follow') => { setPref('watchMode', m); setModeState(m); setLog([]); };

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
  try {
    if (followOnly) {
      const v = viewRef.current;
      if (v) {
        expInfo = followExpInfo(v, catalog);
        if (v.status === 'at_camp') campNote = tr(`${v.self.name} はキャンプにいる（盤面の外）`, `${v.self.name} is at camp (off the board)`);
      }
    } else if (w) {
      if (mode === 'follow' && follow && w.players[follow]) {
        expInfo = followExpInfo(projectPlayerView(w, follow), catalog);
        if (w.players[follow].state === 'at_camp') campNote = tr(`${w.players[follow].name} はキャンプにいる（盤面の外）`, `${w.players[follow].name} is at camp (off the board)`);
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
      <Header title={`${tr('観戦', 'Spectate')} ${runId}`}>
        <span class={`ws ${wsStatus}`}>{wsStatus}</span>
        <ThemePicker themes={th.themes} themeId={th.themeId} onChange={th.setThemeId} />
        <SoundControls />
        <a class="button small" href={`#/replay/${runId}`}>{tr('巻き戻し', 'Rewind')}</a>
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
        {w && <span class="muted">seq {w.seq} {w.status === 'ended' ? tr('（終了）', '(ended)') : ''}</span>}
        {Object.entries(macro).filter(([, v]) => v).map(([pid, v]) => <span key={pid} class="tag">{w?.players[pid]?.name ?? pid}: {v}</span>)}
      </div>
      <div class="layout">
        <div class="main">
          <MapView
            theme={th.theme}
            onReady={(r) => { rRef.current = r; render(); }}
            overlay={
              <>
                <AgentWaitBadge probe={agentTurn} lastRef={lastMsgRef} />
                {campNote && <div class="macro">{campNote}</div>}
              </>
            }
          />
        </div>
        <aside class="side">
          <ExpeditionStatusPanel info={expInfo} />
          {w && catalog && <PartyPanel world={w} catalog={catalog} follow={follow} onFollow={(pid) => setFollow(pid)} />}
          <AiPanel thoughts={thoughts} activities={activities} observationText={obsText} />
          <MessageLog lines={log} title={mode === 'follow' || followOnly ? tr('メッセージ（追従）', 'Messages (follow)') : tr('メッセージ（俯瞰）', 'Messages (director)')} />
        </aside>
      </div>
      {summary && <SummaryDialog summary={summary} catalog={catalog} onClose={() => setSummary(null)} />}
    </div>
  );
}

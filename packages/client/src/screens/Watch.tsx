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
import { ErrorBanner, Header, MapView, ThemePicker, useCatalog, useLocaleRefresh, useTheme } from '../ui/common';
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
  catalogRef.current = catalog;
  modeRef.current = mode;
  followRef.current = follow;
  floorRef.current = floorSel;

  useEffect(() => {
    api.config().then((c) => setPolicy(c.spectatorPolicy)).catch(() => setPolicy('omniscient'));
    api.runs().then((rs) => {
      const r = rs.find((x) => x.runId === runId) ?? null;
      setListing(r);
      if (r && !followRef.current) setFollow(r.players.find((p) => p.state === 'alive')?.id ?? r.players[0]?.id ?? null);
    }).catch((e) => setError(errorText(e)));
  }, [runId]);

  const followOnly = policy === 'follow_only';

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
      switch (m.t) {
        case 'snapshot':
          worldRef.current = structuredClone(m.world);
          if (worldRef.current.status === 'ended') setSummary(null);
          setTick((n) => n + 1);
          render();
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
          break;
        }
        case 'view':
          viewRef.current = m.view;
          setLog((l) => [...l, ...perceivedLines(m.events)].slice(-400));
          setTick((n) => n + 1);
          render();
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
    return () => ws.close();
  }, [runId, policy, followOnly ? follow : null]);

  useEffect(() => { render(); }, [catalog, mode, follow, floorSel]);

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
  const players = w ? w.playerOrder.map((pid) => ({ id: pid, name: w.players[pid].name })) : (listing?.players ?? []).map((p) => ({ id: p.id, name: p.name }));

  return (
    <div class="page watch">
      <Header title={`${tr('観戦', 'Spectate')} ${runId}`}>
        <span class={`ws ${wsStatus}`}>{wsStatus}</span>
        <ThemePicker themes={th.themes} themeId={th.themeId} onChange={th.setThemeId} />
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
          <MapView theme={th.theme} onReady={(r) => { rRef.current = r; render(); }} />
        </div>
        <aside class="side">
          {w && catalog && <PartyPanel world={w} catalog={catalog} follow={follow} onFollow={(pid) => setFollow(pid)} />}
          <AiPanel thoughts={thoughts} activities={activities} observationText={obsText} />
          <MessageLog lines={log} title={mode === 'follow' || followOnly ? tr('メッセージ（追従）', 'Messages (follow)') : tr('メッセージ（俯瞰）', 'Messages (director)')} />
        </aside>
      </div>
      {summary && <SummaryDialog summary={summary} catalog={catalog} onClose={() => setSummary(null)} />}
    </div>
  );
}

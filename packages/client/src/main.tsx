// エントリ: ハッシュルーティング。#/ ロビー、#/play/:runId、#/watch/:runId、#/replay/:runId
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Lobby } from './screens/Lobby';
import { Play } from './screens/Play';
import { Replay } from './screens/Replay';
import { Watch } from './screens/Watch';
import './styles.css';

function parse(hash: string): { page: string; runId: string | null } {
  const m = /^#\/(play|watch|replay)\/([^/?#]+)/.exec(hash);
  if (m) return { page: m[1], runId: decodeURIComponent(m[2]) };
  return { page: 'lobby', runId: null };
}

function App() {
  const [route, setRoute] = useState(parse(window.location.hash));
  useEffect(() => {
    const h = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  if (route.page === 'play' && route.runId) return <Play key={route.runId} runId={route.runId} />;
  if (route.page === 'watch' && route.runId) return <Watch key={route.runId} runId={route.runId} />;
  if (route.page === 'replay' && route.runId) return <Replay key={route.runId} runId={route.runId} />;
  return <Lobby />;
}

render(<App />, document.getElementById('app')!);

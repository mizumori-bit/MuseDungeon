// エントリ: ハッシュルーティング。#/ 拠点、#/records 記録、#/ops 運用、#/prepare/:runId 支度、#/play/:runId、#/watch/:runId、#/replay/:runId、#/season/:id
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Lobby } from './screens/Lobby';
import { Play } from './screens/Play';
import { Prepare } from './screens/Prepare';
import { Replay } from './screens/Replay';
import { Season } from './screens/Season';
import { Watch } from './screens/Watch';
import { KeepGoingRunner } from './ui/KeepGoingRunner';
import { SoundHint } from './ui/sound';
import './styles.css';

function parse(hash: string): { page: string; runId: string | null } {
  const m = /^#\/(play|watch|replay|season|prepare)\/([^/?#]+)/.exec(hash);
  if (m) return { page: m[1], runId: decodeURIComponent(m[2]) };
  // ホームの「記録」のタブ（S8 の H2。SEASON.md §54.7）と、運用（S10。§58.4。拠点の隅の歯車から）
  if (/^#\/records\/?$/.test(hash)) return { page: 'records', runId: null };
  if (/^#\/ops\/?$/.test(hash)) return { page: 'ops', runId: null };
  // それ以外（#/・前の「出撃」・知らない道）は拠点
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
  // シーズンの結果と坑の断面（S2 §18.3）。runId はシーズンの ID
  if (route.page === 'season' && route.runId) return <Season key={route.runId} id={route.runId} />;
  // 支度（S10。SEASON.md §58.4。ただ 1 つの出撃の窓口）
  if (route.page === 'prepare' && route.runId) return <Prepare key={route.runId} runId={route.runId} />;
  // 拠点・記録・運用は同じ画面のタブ（切り替えても読み込んだ中身を保つ）
  return <Lobby tab={route.page === 'records' ? 'records' : route.page === 'ops' ? 'ops' : 'hub'} />;
}

// 続けて遊ばせる（S14。SEASON.md §65.4）の鳴らす役は、画面の外（根）に置く: どの画面にいても、タブが開いていれば続く
// 音の案内（S16a。§70.3 の 1）も根に 1 つ: 音のある、どの画面でも出る
render(<><App /><KeepGoingRunner /><SoundHint /></>, document.getElementById('app')!);

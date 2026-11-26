// エントリ: ハッシュルーティング（道の読み方は ui/entrance.ts の parseRoute）。
// 上のタブ（S16b。SEASON.md §70.4）: #/ 拠点・#/leaderboard リーダーボード・#/season（#/season/:id）シーズン・#/codex 図鑑と、歯車の #/settings 設定。
// どこからもリンクしない古い入口: #/legacy（シーズンでないラン・協力）。前の道 #/records は #/season へ、#/ops は #/settings へ送る。
// ほかに #/prepare/:runId 支度、#/play/:runId、#/watch/:runId、#/replay/:runId
import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Lobby } from './screens/Lobby';
import { Play } from './screens/Play';
import { Prepare } from './screens/Prepare';
import { Replay } from './screens/Replay';
import { Watch } from './screens/Watch';
import { KeepGoingRunner } from './ui/KeepGoingRunner';
import { parseRoute, type Route } from './ui/entrance';
import { SoundHint } from './ui/sound';
import './styles.css';

/** 道を読む。前の道なら、履歴を増やさずに送り先へ書き換える（古いリンク・ブックマークを切らない） */
function current(): Route {
  const r = parseRoute(window.location.hash);
  if (r.redirect) window.history.replaceState(null, '', r.redirect);
  return r;
}

function App() {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const h = () => setRoute(current());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  if (route.page === 'play') return <Play key={route.id} runId={route.id} />;
  if (route.page === 'watch') return <Watch key={route.id} runId={route.id} />;
  if (route.page === 'replay') return <Replay key={route.id} runId={route.id} />;
  // 支度（S10。SEASON.md §58.4。ただ 1 つの出撃の窓口）
  if (route.page === 'prepare') return <Prepare key={route.id} runId={route.id} />;
  // 拠点・リーダーボード・シーズン・図鑑・設定・古い入口は同じ画面のタブ（切り替えても読み込んだ中身を保つ）。
  // シーズンの結果を見返す画面（S2 §18.3）は、シーズンのタブの中（S16b: 2 つの画面を別々に持たない）
  return <Lobby tab={route.page} seasonId={route.page === 'season' ? route.id : null} />;
}

// 続けて遊ばせる（S14。SEASON.md §65.4）の鳴らす役は、画面の外（根）に置く: どの画面にいても、タブが開いていれば続く
// 音の案内（S16a。§70.3 の 1）も根に 1 つ: 音のある、どの画面でも出る
render(<><App /><KeepGoingRunner /><SoundHint /></>, document.getElementById('app')!);

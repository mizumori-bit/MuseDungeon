// 音の設定（docs/SOUND_SPEC.md §6）: 音のテーマ（既定は切＝無音）、音量、音楽と合図を別に切る。設定は端末に覚える。
// 選んだ操作の中で音を始める（ブラウザは操作なしの再生を許さない）。
import { useEffect, useState } from 'preact/hooks';
import { soundDirector } from '../sound/director';
import { tr } from '../util';

/**
 * 拠点の曲（S15。SEASON.md §68.2 の 5）: 拠点・支度・記録・運用・シーズンの結果の画面にいる間、場面 hub の音の状態を渡す。
 * 観戦・遊ぶ・リプレイの画面へ移ると、その画面が、自分の音の状態を渡す（次の拍の頭で替わる）。
 * S15a: 離れるときは、拠点の曲を止める（次の画面が音の状態を渡すまで、無音。観戦が断られた・最初の見え方の前 などで、拠点の曲が残らない）。
 * 拠点の曲どうしの画面を移るとき（拠点 → 支度 → 記録）は、すぐ次の画面が hub() を呼ぶので、途切れない
 */
export function useHubMusic(): void {
  useEffect(() => {
    soundDirector.hub();
    return () => soundDirector.leaveHub();
  }, []);
}

export function SoundControls() {
  const [, force] = useState(0);
  useEffect(() => soundDirector.subscribe(() => force((n) => n + 1)), []);
  const s = soundDirector.settings;
  const on = s.theme !== 'none';
  const snap = soundDirector.snapshot();
  const waiting = on && !snap.running;
  return (
    <span class="soundctl" title={tr('音（演出だけ。情報は運ばない）。既定は切。設定はこの端末に覚える', 'Sound (presentation only; carries no information). Off by default; remembered on this device')}>
      <label class="inline">
        {tr('音', 'Sound')}
        <select value={s.theme} onChange={(e) => soundDirector.set({ theme: (e.target as HTMLSelectElement).value })}>
          <option value="none">{tr('切', 'off')}</option>
          {soundDirector.themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      {on && (
        <>
          <input type="range" min="0" max="1" step="0.05" value={String(s.volume)} aria-label={tr('音量', 'Volume')}
            onInput={(e) => soundDirector.set({ volume: Number((e.target as HTMLInputElement).value) })} />
          <label class="inline small"><input type="checkbox" checked={s.music} onChange={(e) => soundDirector.set({ music: (e.target as HTMLInputElement).checked })} />{tr('音楽', 'music')}</label>
          <label class="inline small"><input type="checkbox" checked={s.cues} onChange={(e) => soundDirector.set({ cues: (e.target as HTMLInputElement).checked })} />{tr('合図', 'cues')}</label>
          {waiting && <small class="muted">{tr('（画面を一度押すと鳴る）', '(click once to start)')}</small>}
          {soundDirector.error && <small class="error">{soundDirector.error}</small>}
        </>
      )}
    </span>
  );
}

// 音の設定（docs/SOUND_SPEC.md §6）: 音のテーマ（既定は切＝無音）、音量、音楽と合図を別に切る。設定は端末に覚える。
// 画面に出す言葉は「効果音」（英語は SFX。S18: SEASON.md §73.2 の 2）。コードと文書の中の呼び名は、合図（cues）のまま。
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
  // まだ鳴らせないことは、画面の下の札で知らせる（S16a。SoundHint。見出しの小さい字はやめた: 出入りで見出しの幅が変わり、折り返しが変わった）
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
          <label class="inline small"><input type="checkbox" checked={s.cues} onChange={(e) => soundDirector.set({ cues: (e.target as HTMLInputElement).checked })} />{tr('効果音', 'SFX')}</label>
          {soundDirector.error && <small class="error">{soundDirector.error}</small>}
        </>
      )}
    </span>
  );
}

/**
 * 音の案内（S16a。SEASON.md §70.3 の 1）: 音のテーマが入っていて、まだ鳴らせない（ブラウザは、人が 1 回操作するまで音を出させない）間、画面の下に出す札。
 * アプリの根に 1 つ置く（遊ぶ・観戦・リプレイ・拠点・支度、どの画面でも）。画面のどこかを押すか、キーを打つと、鳴りはじめて消える（札を押しても同じ）。
 * 画面に重ねて出すだけで、場所を取らない（地図の枠の高さを変えない。S15 の決まり）
 */
export function SoundHint() {
  const [, force] = useState(0);
  useEffect(() => soundDirector.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => {
    const h = () => force((n) => n + 1);
    window.addEventListener('muse-locale', h);
    return () => window.removeEventListener('muse-locale', h);
  }, []);
  if (!soundDirector.waitingForGesture) return null;
  return (
    <button type="button" class="soundhint" onClick={() => soundDirector.unlock()} aria-live="polite">
      <span class="soundhint-icon" aria-hidden="true">♪</span>
      {tr('音は、画面を 1 回押すと鳴る', 'Sound starts when you click the page once')}
    </button>
  );
}

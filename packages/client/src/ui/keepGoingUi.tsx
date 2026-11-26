// 続けて遊ばせる（S14。SEASON.md §65.2・§65.4）の、拠点の部品: 札の中の段・始める窓・上の帯の印。文と決める所は ui/keepGoing.ts。
// 見た目は新しい接頭辞（.kg-）のクラスだけ（ほかの画面の見た目を変えない）
import type { OwnerRunRow } from '@muse/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtTime, tr } from '../util';
import {
  KG, kgClampN, kgExplainLines, kgForget, kgLastRingText, kgLeft, kgOffer, kgReadAll, kgRunningText, kgStart, kgStopped, kgStoppedText, kgSubscribe, kgWrite,
  kgPortFailText, kgViaText, type KgState,
} from './keepGoing';
import { kgRingNow } from './keepGoingRing';

/** このブラウザに覚えてある「続けて遊ばせる」の状態（同じタブの変更と、ほかのタブの変更で描き直す） */
export function useKeepGoing(): Record<string, KgState> {
  const [s, set] = useState<Record<string, KgState>>(() => kgReadAll());
  useEffect(() => {
    const f = () => set(kgReadAll());
    const off = kgSubscribe(f);
    const onStorage = (e: StorageEvent) => { if (!e.key || e.key.startsWith('muse.pref.keepGoing')) f(); };
    window.addEventListener('storage', onStorage);
    return () => { off(); window.removeEventListener('storage', onStorage); };
  }, []);
  return s;
}

/** 動いている「続けて遊ばせる」の数（上の帯の印） */
export function KeepGoingNavMark() {
  const states = useKeepGoing();
  const running = Object.values(states).filter((s) => s.status === 'running');
  if (!running.length) return null;
  const alert = running.some((s) => s.portFail);
  return (
    <a class={`kg-navmark ${alert ? 'is-alert' : ''}`} href="#/" title={running.map((s) => s.name).join(tr('・', ', '))}>
      {tr(`続けて遊ばせている ${running.length}`, `Keeping going: ${running.length}`)}
    </a>
  );
}

/**
 * 札の中の段（拠点の冒険者の札）: 動いている間は「続けて遊ばせている（あと 2 回）」と「止める」、止まったら理由の 1 行、
 * 動いていなければ「続けて遊ばせる」（出せる冒険者だけ）か、握っている項目があるときの小さい 1 行
 */
export function KeepGoingBox({ row, name, bellOn, problem, port, st }: { row: OwnerRunRow | null; name: string; bellOn: boolean; problem?: string | null; port: number | null; st: KgState | null }) {
  const [dlg, setDlg] = useState<number | null>(null);
  const ended = row?.expeditionsEnded ?? st?.seen?.ended ?? 0;
  const offer = kgOffer({ row, bellOn });
  const start = (n: number) => {
    if (!row) return;
    const now = Date.now();
    kgWrite(kgStart({ runId: row.runId, seasonId: row.season?.id ?? null, name, total: n, ended: row.expeditionsEnded ?? 0, now, pace: row.pace ?? null }));
    setDlg(null);
  };
  let body = null;
  if (st?.status === 'running') {
    const last = kgLastRingText(st, fmtTime);
    body = (
      <div class={`kg-box is-running ${st.portFail ? 'is-alert' : ''}`}>
        <div class="kg-head">
          <span class="kg-title">{kgRunningText(kgLeft(st, ended))}</span>
          <button type="button" class="hub-btn small" onClick={() => kgWrite(kgStopped(st, 'by_owner', Date.now()))}>{tr('止める', 'Stop')}</button>
        </div>
        {st.portFail && (
          <div class="kg-alert">
            <p class="hub-note warn">{kgPortFailText(name, st.portFail.port)}</p>
            <button type="button" class="hub-btn primary" onClick={() => void kgRingNow(st)}>{tr('もう一度鳴らす', 'Ring again')}</button>
          </div>
        )}
        {last && <p class="hub-note">{last}</p>}
        <p class="hub-note">{kgViaText(port)}{tr('このタブ（このアプリのどれかのタブ）を開いている間だけ、動く。', ' It works only while a tab of this app stays open.')}</p>
      </div>
    );
  } else if (st?.status === 'stopped') {
    const again = st.stop?.reason === 'tabs_closed' && offer === 'start' && !problem;
    body = (
      <div class="kg-box is-stopped">
        <p class="hub-note">{kgStoppedText(st)}</p>
        {problem && offer === 'start' && <p class="hub-note warn">{problem}</p>}
        <div class="kg-head">
          {again && <button type="button" class="hub-btn small primary" onClick={() => setDlg(kgLeft(st, ended) || KG.N_DEFAULT)}>{tr('もう一度始める', 'Start again')}</button>}
          {!again && offer === 'start' && !problem && <button type="button" class="hub-btn small" onClick={() => setDlg(KG.N_DEFAULT)}>{tr('続けて遊ばせる', 'Keep them going')}</button>}
          <button type="button" class="hub-linkbtn" onClick={() => kgForget(st.runId)}>{tr('閉じる', 'Dismiss')}</button>
        </div>
      </div>
    );
  } else if (offer === 'start' && problem) {
    // 覚えた受け口の設定の形が違う（S14b）: 始めさせずに、見直すように出す
    body = <p class="hub-note warn kg-held">{problem}</p>;
  } else if (offer === 'start') {
    body = (
      <div class="kg-box">
        <button type="button" class="hub-btn small" onClick={() => setDlg(KG.N_DEFAULT)}>{tr('続けて遊ばせる', 'Keep them going')}</button>
      </div>
    );
  } else if (offer === 'held') {
    body = <p class="hub-note kg-held">{tr('握っている項目があるので、続けては呼ばない（キャンプごとに、支度を決める）', 'Something is held, so they are not called again and again (you prepare at each camp)')}</p>;
  }
  return (
    <>
      {body}
      {dlg !== null && <KeepGoingDialog name={name} initial={dlg} port={port} onStart={start} onClose={() => setDlg(null)} />}
    </>
  );
}

/** 始める窓: 「遠征を、あと N 回」（1〜10。既定 3）と「始める」。説明を 3 行 */
export function KeepGoingDialog({ name, initial, port, onStart, onClose }: { name: string; initial: number; port: number | null; onStart: (n: number) => void; onClose: () => void }) {
  const [n, setN] = useState(String(kgClampN(initial)));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const v = Number(n);
  const ok = Number.isInteger(v) && v >= KG.N_MIN && v <= KG.N_MAX;
  return (
    <div class="hub-modal" onClick={onClose}>
      <div class="hub-dialog" role="dialog" aria-modal="true" aria-label={tr('続けて遊ばせる', 'Keep them going')} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h2 class="hub-dtitle">{tr(`${name}を、続けて遊ばせる`, `Keep ${name} going`)}</h2>
        <form class="hub-form" onSubmit={(e) => { e.preventDefault(); if (ok) onStart(v); }}>
          <label class="hub-field">{tr(`遠征を、あと何回（${KG.N_MIN}〜${KG.N_MAX}）`, `How many more expeditions (${KG.N_MIN}-${KG.N_MAX})`)}
            <input ref={ref} class="hub-input" type="number" min={KG.N_MIN} max={KG.N_MAX} step={1} value={n} onInput={(e) => setN((e.target as HTMLInputElement).value)} />
          </label>
          {kgExplainLines(name, port).map((x, i) => <p key={i} class="hub-note">{x}</p>)}
          <div class="hub-dactions">
            <button type="button" class="hub-btn" onClick={onClose}>{tr('やめる', 'Cancel')}</button>
            <button type="submit" class="hub-btn primary" disabled={!ok}>{tr('始める', 'Start')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

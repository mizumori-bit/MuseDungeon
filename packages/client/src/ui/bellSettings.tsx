// 呼び鈴の設定（運用の画面。S12b・S14a。SEASON.md §63.6・§65.4）: 使わない（既定）・自分の道具を呼ぶ（リンク）・この PC の受け口を呼ぶ（ポートと合言葉）。
// このブラウザにだけ覚える（サーバーへは送らない）。受け口の送り先の名前は、いつも 127.0.0.1（変えられるのは、ポートだけ）。
import { useEffect, useState } from 'preact/hooks';
import { tr } from '../util';
import { BELL_HOST, BELL_PATH, BELL_PORT_MAX, BELL_PORT_MIN, bellKeyValid, bellPortValid, newBellKey, saveBellConfig, type BellConfig, type BellMode } from './bell';

/** 受け口の設定の入力を確かめる（画面から離した関数）。合えば設定、違えば断りの文 */
export function bellPortDraft(portText: string, keyText: string): { ok: true; port: number; key: string | null } | { ok: false; error: string } {
  const p = portText.trim();
  const port = /^\d+$/.test(p) ? Number(p) : NaN;
  if (!bellPortValid(port)) return { ok: false, error: tr(`ポートは ${BELL_PORT_MIN}〜${BELL_PORT_MAX} の数`, `The port is a number from ${BELL_PORT_MIN} to ${BELL_PORT_MAX}`) };
  const k = keyText.trim();
  if (k && !bellKeyValid(k)) return { ok: false, error: tr('合言葉は、英数字と - _ で 8〜64 字（空でもよい）', 'The passphrase is 8-64 letters, digits, - or _ (or empty)') };
  return { ok: true, port, key: k || null };
}

export function BellSettings({ cfg, onChange }: { cfg: BellConfig; onChange: (c: BellConfig) => void }) {
  // 受け口を選んでいる（まだ保存していない間も、入力の欄を出す）
  const [pick, setPick] = useState<BellMode>(cfg.mode);
  const [portText, setPortText] = useState(cfg.port ? String(cfg.port) : '');
  const [keyText, setKeyText] = useState(cfg.key ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setPick(cfg.mode); }, [cfg.mode]);
  const set = (c: BellConfig) => { saveBellConfig(c); onChange(c); };
  const choose = (m: BellMode) => {
    setPick(m);
    setErr(null);
    setSaved(false);
    // 使わない・リンクは、すぐ覚える。受け口は、ポートを決めて「覚える」まで、前の設定のまま
    if (m !== 'port') set({ ...cfg, mode: m });
  };
  const savePort = () => {
    const d = bellPortDraft(portText, keyText);
    if (!d.ok) { setErr(d.error); setSaved(false); return; }
    setErr(null);
    setKeyText(d.key ?? '');
    set({ mode: 'port', port: d.port, key: d.key });
    setSaved(true);
  };
  const shownPort = /^\d+$/.test(portText.trim()) ? portText.trim() : tr('<ポート>', '<port>');
  const shownKey = keyText.trim() && bellKeyValid(keyText.trim()) ? `&key=${keyText.trim()}` : '';
  return (
    <section class="panel seasonbox">
      <h3>{tr('呼び鈴', 'Bell')}</h3>
      <div class="row" role="radiogroup" aria-label={tr('呼び鈴', 'Bell')}>
        <label class="check"><input type="radio" name="bell" checked={pick === 'off'} onChange={() => choose('off')} />{tr('使わない', 'Off')}</label>
        <label class="check"><input type="radio" name="bell" checked={pick === 'tool'} onChange={() => choose('tool')} />{tr('自分の道具を呼ぶ（リンク）', 'Call your own tool (link)')}</label>
        <label class="check"><input type="radio" name="bell" checked={pick === 'port'} onChange={() => choose('port')} />{tr('この PC の受け口を呼ぶ', 'Call a receiver on this PC')}</label>
      </div>
      {pick === 'tool' && (
        <>
          <p class="muted small">{tr('「準備完了」を押したとき、このブラウザが、決まった文字列（musedungeon-bell://ready?season=…&run=…。入るのは、シーズンとランの ID だけ）を開く。動くのは、押した人の PC の上で、ゲームは、何も送らない。', 'When you press "Ready", this browser opens a fixed string (musedungeon-bell://ready?season=…&run=…, carrying only the season and run IDs). It runs on the PC of whoever pressed it; the game sends nothing.')}</p>
          <p class="muted small">{tr('ブラウザは、人の操作なしに、このリンクを続けて開かせない。「続けて遊ばせる」で席を外すなら、「この PC の受け口を呼ぶ」にする。', 'Browsers do not let a page open this link again and again without a person\'s action. To leave "Keep them going" running while you are away, choose "Call a receiver on this PC".')}</p>
        </>
      )}
      {pick === 'port' && (
        <form class="kg-bellform" onSubmit={(e) => { e.preventDefault(); savePort(); }}>
          <p class="muted small">{tr(`このブラウザが、この PC の受け口（http://${BELL_HOST}:<ポート>${BELL_PATH}）へ、1 行の本文を送る。人の操作は要らない。送り先の名前は、いつも ${BELL_HOST}（変えられるのは、ポートだけ）。応答は読まない。`, `This browser posts one line to a receiver on this PC (http://${BELL_HOST}:<port>${BELL_PATH}). No person's action is needed. The host is always ${BELL_HOST} (only the port can change). The reply is not read.`)}</p>
          <label class="inline">{tr(`ポート（${BELL_PORT_MIN}〜${BELL_PORT_MAX}）`, `Port (${BELL_PORT_MIN}-${BELL_PORT_MAX})`)}
            <input type="number" min={BELL_PORT_MIN} max={BELL_PORT_MAX} step={1} value={portText} onInput={(e) => { setPortText((e.target as HTMLInputElement).value); setSaved(false); }} />
          </label>
          <label class="inline">{tr('合言葉（任意。英数字と - _ で 8〜64 字）', 'Passphrase (optional; 8-64 letters, digits, - or _)')}
            <input type="text" autocomplete="off" spellcheck={false} maxLength={64} value={keyText} onInput={(e) => { setKeyText((e.target as HTMLInputElement).value); setSaved(false); }} />
          </label>
          <div class="row">
            <button type="button" class="small" onClick={() => { setKeyText(newBellKey()); setSaved(false); }}>{tr('作る', 'Generate')}</button>
            <button type="submit" class="small primary">{tr('覚える', 'Save')}</button>
            {saved && <span class="muted small">{tr('覚えた。', 'Saved.')}</span>}
          </div>
          {err && <div class="oerr">{err}</div>}
          <p class="muted small">{tr(`届く本文: season=<ID>&run=<ID>（pilot で進める冒険者は &mode=pilot）${shownKey ? '&key=（合言葉）' : ''}。送り先: http://${BELL_HOST}:${shownPort}${BELL_PATH}。つながらなければ「受け口が、動いていない」と出す。`, `Body: season=<ID>&run=<ID> (&mode=pilot for "With pilot")${shownKey ? '&key=(passphrase)' : ''}. Sent to http://${BELL_HOST}:${shownPort}${BELL_PATH}. If it cannot connect, you see "The receiver is not running".`)}</p>
          <p class="muted small">{tr('どのウェブのページからでも、この受け口に送れてしまう。受ける道具は、合言葉を確かめ、合わなければ何もしない（README の「呼び鈴」）。', 'Any web page can post to this receiver. Your receiving tool should check the passphrase and do nothing if it does not match (see "Bell" in the README).')}</p>
          {cfg.mode !== 'port' && <p class="muted small">{tr('「覚える」まで、前の設定のまま。', 'The previous setting stays until you press Save.')}</p>}
        </form>
      )}
      <p class="muted small">{tr('支度の「進め方」を「pilot で進める」にした冒険者は、&mode=pilot が付く（受ける道具が、使ってよい）。', 'For an adventurer whose "How to play" is "With pilot", &mode=pilot is added (your receiving tool may use it).')}</p>
      <p class="muted small">{tr('受け取って AI に知らせる道具は、自分で用意する（README の「呼び鈴」）。この設定は、このブラウザにだけ覚える。', 'You provide the tool that receives it and tells your AI (see "Bell" in the README). This setting is kept only in this browser.')}</p>
      <p class="muted small">{tr('「使わない」でないときだけ、拠点の札に「続けて遊ばせる」が出る（決めた回数の遠征まで、AI が黙ったら、このブラウザが呼び鈴を鳴らす。「使わない」にすると止まる）。', 'Unless the bell is Off, hub cards offer "Keep them going" (up to the number of expeditions you set, this browser rings the bell when your AI goes quiet; switching to Off stops it).')}</p>
    </section>
  );
}

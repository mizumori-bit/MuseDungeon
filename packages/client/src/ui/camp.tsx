// キャンプの絵（docs/ASSET_SPEC.md §7.7）: そのプレイヤーがキャンプにいる間、地図を描く場所の全体を覆い、地図を隠す。
// テーマに scene:camp があればその 1 枚絵（cover / contain、横に並べたフレームでループ）、無ければ背景色の無地と「キャンプ」の文字。
// 絵は情報を運ばない（到達した深さなどで変えない）。キャンプのパネルはこの上に重なる。出るときは短いフェード
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Theme } from '../theme';
import { tr } from '../util';

export function CampScene({ theme }: { theme: Theme | null }) {
  const art = theme?.sceneArt?.('scene:camp') ?? null;
  const url = art?.url ?? null;
  const fit = art?.fit ?? 'cover';
  const frames = art?.frames ?? 1;
  const frameMs = art?.frameMs ?? 200;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    setImg(null);
    if (!url) return;
    let alive = true;
    const im = new Image();
    im.onload = () => { if (alive) setImg(im); };
    im.onerror = () => { if (alive) setImg(null); };
    im.src = url;
    return () => { alive = false; };
  }, [url]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    let frame = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const W = Math.max(1, Math.round(c.clientWidth * dpr));
      const H = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const g = c.getContext('2d');
      if (!g) return;
      g.imageSmoothingEnabled = theme?.scaling !== 'nearest';
      g.fillStyle = theme?.background ?? '#000';
      g.fillRect(0, 0, W, H);
      const fw = img.naturalWidth / frames;
      const fh = img.naturalHeight;
      if (fw <= 0 || fh <= 0) return;
      // cover: 覆うように拡大し、はみ出しは中央基準で切る。contain: 全体を収め、余りは背景色
      const s = fit === 'contain' ? Math.min(W / fw, H / fh) : Math.max(W / fw, H / fh);
      const dw = fw * s, dh = fh * s;
      g.drawImage(img, frame * fw, 0, fw, fh, (W - dw) / 2, (H - dh) / 2, dw, dh);
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    const iv = frames > 1 ? setInterval(() => { frame = (frame + 1) % frames; draw(); }, frameMs) : null;
    return () => { ro.disconnect(); if (iv) clearInterval(iv); };
  }, [img, fit, frames, frameMs, theme]);

  return (
    <div class="campscene" style={{ background: theme?.background ?? '#000' }}>
      {img ? <canvas ref={canvasRef} /> : <div class="camplabel">{tr('キャンプ', 'Camp')}</div>}
    </div>
  );
}

// 画面共通: カタログ・テーマのフック、エラーバナー、ヘッダー、地図ビュー。
import type { Catalog, Pos } from '@muse/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { errorText, getCatalog } from '../api';
import { Canvas2DRenderer } from '../render/canvas2d';
import { listThemes, loadTheme, type ThemeInfo } from '../theme';
import type { Theme } from '../theme/types';
import { getLocale, getPref, setLocale, setPref, tr } from '../util';

export function useCatalog(): { catalog: Catalog | null; error: string | null } {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getCatalog().then((c) => { if (alive) setCatalog(c); }).catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, []);
  return { catalog, error };
}

export function useTheme(catalog: Catalog | null): { theme: Theme | null; themeId: string; setThemeId: (id: string) => void; themes: ThemeInfo[]; error: string | null } {
  const [themeId, setId] = useState(getPref('theme', 'glyph'));
  const [theme, setTheme] = useState<Theme | null>(null);
  const [themes, setThemes] = useState<ThemeInfo[]>([{ id: 'glyph', name: 'glyph' }]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { listThemes().then(setThemes).catch(() => undefined); }, []);
  useEffect(() => {
    if (!catalog) return;
    let alive = true;
    loadTheme(themeId, catalog)
      .then((t) => { if (alive) { setTheme(t); setError(null); } })
      .catch(async (e) => {
        if (!alive) return;
        setError(`${tr('テーマ読み込み失敗', 'Theme load failed')}: ${errorText(e)}`);
        setTheme(await loadTheme('glyph', catalog));
      });
    return () => { alive = false; };
  }, [catalog, themeId]);
  return { theme, themeId, setThemeId: (id) => { setPref('theme', id); setId(id); }, themes, error };
}

export function ErrorBanner({ error, onClose }: { error: string | null; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div class="banner error">
      <span>{error}</span>
      {onClose && <button class="link" onClick={onClose}>×</button>}
    </div>
  );
}

export function Header({ title, children }: { title?: string; children?: ComponentChildren }) {
  const [, force] = useState(0);
  return (
    <header class="topbar">
      <a class="brand" href="#/">MuseDungeon</a>
      {title && <span class="title">{title}</span>}
      <div class="spacer" />
      {children}
      <button class="small" title="UI language" onClick={() => { setLocale(getLocale() === 'ja' ? 'en' : 'ja'); force((n) => n + 1); window.dispatchEvent(new Event('muse-locale')); }}>
        {getLocale() === 'ja' ? 'EN' : '日本語'}
      </button>
    </header>
  );
}

export function ThemePicker({ themes, themeId, onChange }: { themes: ThemeInfo[]; themeId: string; onChange: (id: string) => void }) {
  return (
    <label class="inline">
      {tr('テーマ', 'Theme')}
      <select value={themeId} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
        {themes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );
}

interface MapViewProps {
  theme: Theme | null;
  onReady: (r: Canvas2DRenderer) => void;
  onCellClick?: (p: Pos, ev: MouseEvent) => void;
  onCellHover?: (p: Pos | null) => void;
  overlay?: ComponentChildren;
}

/** 地図キャンバス。Renderer はここで生成し、親に渡す（描画は親が命令的に行う） */
export function MapView({ theme, onReady, onCellClick, onCellHover, overlay }: MapViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rRef = useRef<Canvas2DRenderer | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    if (!canvasRef.current || !theme) return;
    if (!rRef.current) {
      const r = new Canvas2DRenderer();
      r.zoom = parseFloat(getPref('zoom', '1')) || 1;
      r.mount(canvasRef.current, theme);
      rRef.current = r;
      onReady(r);
    } else rRef.current.setTheme(theme);
  }, [theme]);
  useEffect(() => () => { rRef.current?.destroy(); rRef.current = null; }, []);
  const zoom = (f: number) => {
    const r = rRef.current;
    if (!r) return;
    r.setZoom(r.zoom * f);
    setPref('zoom', String(r.zoom));
  };
  return (
    <div class="mapwrap">
      <canvas
        ref={canvasRef}
        class="map"
        onMouseMove={(e) => {
          const r = rRef.current;
          if (!r) return;
          const p = r.cellAt(e.clientX, e.clientY);
          r.hover = p;
          r.markDirty();
          onCellHover?.(p);
          const ent = p ? r.entityAt(p) : null;
          const rect = (e.currentTarget as HTMLCanvasElement).getBoundingClientRect();
          setTip(ent ? { x: e.clientX - rect.left + 12, y: e.clientY - rect.top + 12, text: ent.label } : null);
        }}
        onMouseLeave={() => { const r = rRef.current; if (r) { r.hover = null; r.markDirty(); } onCellHover?.(null); setTip(null); }}
        onClick={(e) => {
          const p = rRef.current?.cellAt(e.clientX, e.clientY);
          if (p) onCellClick?.(p, e);
        }}
        onWheel={(e) => { e.preventDefault(); zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); }}
      />
      {tip && <div class="tooltip" style={{ left: `${tip.x}px`, top: `${tip.y}px` }}>{tip.text}</div>}
      <div class="zoom">
        <button class="small" onClick={() => zoom(1.25)}>＋</button>
        <button class="small" onClick={() => zoom(0.8)}>－</button>
      </div>
      {overlay}
    </div>
  );
}

/** UI 言語切替で再描画する */
export function useLocaleRefresh(): void {
  const [, force] = useState(0);
  useEffect(() => {
    const h = () => force((n) => n + 1);
    window.addEventListener('muse-locale', h);
    return () => window.removeEventListener('muse-locale', h);
  }, []);
}

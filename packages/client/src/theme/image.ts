// 画像テーマ: public/themes/<id>/theme.json（docs/ASSET_SPEC.md §7.2）。
// 解決順（§7.3）: 完全一致（地形は terrainId@biomeId → terrainId、鑑定済みアイテムは item → appearance）
//   → categoryFallbacks（item:<category> → item）→ fallbackTheme（glyph）→ 組み込みの「不明」表示。
// 画像は要求されたときに遅延読み込みし、読み込み中・失敗時は glyph で欠けずに描く。
import { visualHash } from '@muse/shared';
import type { AssetClass, AssetRef, Drawable, Theme } from './types';

interface AnimDef { file?: string; frames?: number; frameMs?: number; loop?: boolean }
interface AssetEntry {
  file?: string;
  variants?: number;
  autotile?: 'mask16' | string;
  layer?: 'ground' | 'object';
  frame?: { w: number; h: number };
  facings?: 1 | 2 | 4;
  anchor?: { x: number; y: number };
  anim?: Record<string, AnimDef>;
  states?: Record<string, { file: string }>;
  orient?: 'rotate' | 'none';
}

export interface ThemeManifest {
  id: string;
  name?: string;
  formatVersion: number;
  cellSize?: number;
  scaling?: 'nearest' | 'linear';
  background?: string;
  fallbackTheme?: string;
  assets?: Partial<Record<AssetClass, Record<string, AssetEntry>>>;
  categoryFallbacks?: Record<string, AssetEntry>;
}

type ImgState = { state: 'loading' } | { state: 'ok'; img: HTMLImageElement } | { state: 'error' };

const FACING_ROW4: Record<string, number> = { s: 0, w: 1, e: 2, n: 3 };

export function createImageTheme(manifest: ThemeManifest, baseUrl: string, fallback: Theme): Theme {
  const listeners = new Set<() => void>();
  const images = new Map<string, ImgState>();
  const cell = manifest.cellSize ?? 32;
  const assets = manifest.assets ?? {};
  const catFb = manifest.categoryFallbacks ?? {};
  const animated = Object.values(assets).some((group) => Object.values(group ?? {}).some((a) => Object.values(a.anim ?? {}).some((d) => (d.frames ?? 1) > 1)));

  const notify = () => { for (const l of listeners) l(); };

  const image = (file: string): ImgState => {
    let st = images.get(file);
    if (st) return st;
    st = { state: 'loading' };
    images.set(file, st);
    const img = new Image();
    img.onload = () => { images.set(file, { state: 'ok', img }); notify(); };
    img.onerror = () => { images.set(file, { state: 'error' }); notify(); };
    img.src = `${baseUrl}/${file}`;
    return st;
  };

  /** エントリ → 描画物。読み込み中は 'loading'、使えないなら null */
  const fromEntry = (entry: AssetEntry, ref: AssetRef, now: number): Drawable | 'loading' | null => {
    let file = entry.file;
    let frames = 1;
    let frameMs = 150;
    let loop = true;
    if (ref.state && entry.states?.[ref.state]) {
      file = entry.states[ref.state].file;
    } else if (entry.anim) {
      const a = entry.anim[ref.anim ?? 'idle'] ?? entry.anim.idle;
      if (a) {
        file = a.file ?? entry.file;
        frames = Math.max(1, a.frames ?? 1);
        frameMs = Math.max(16, a.frameMs ?? 150);
        loop = a.loop ?? true;
      }
    }
    if (!file) return null;
    const st = image(file);
    if (st.state === 'loading') return 'loading';
    if (st.state === 'error') return null;
    const w = entry.frame?.w ?? cell;
    const h = entry.frame?.h ?? cell;
    let col = 0;
    let row = 0;
    if (frames > 1) col = loop ? Math.floor(now / frameMs) % frames : frames - 1;
    const variants = Math.max(1, entry.variants ?? 1);
    if (variants > 1) {
      const v = visualHash(ref.x ?? 0, ref.y ?? 0, 7) % variants;
      if (frames > 1) row = v;
      else col = v;
    }
    if (entry.autotile === 'mask16' && ref.mask !== undefined) col = ref.mask & 15;
    let flipX = false;
    const facings = entry.facings ?? 1;
    if (facings === 2) flipX = ref.facing === 'w';
    else if (facings === 4) row = FACING_ROW4[ref.facing ?? 's'] ?? 0;
    // 寸法が足りないシートは使わない（欠けずに glyph へ）
    if ((col + 1) * w > st.img.naturalWidth || (row + 1) * h > st.img.naturalHeight) return null;
    return {
      kind: 'sprite', img: st.img, sx: col * w, sy: row * h, sw: w, sh: h,
      anchorX: entry.anchor?.x ?? 0.5, anchorY: entry.anchor?.y ?? 1, flipX,
    };
  };

  const candidates = (ref: AssetRef): AssetEntry[] => {
    const out: AssetEntry[] = [];
    const group = assets[ref.cls] ?? {};
    if (ref.cls === 'terrain' && ref.biome && group[`${ref.id}@${ref.biome}`]) out.push(group[`${ref.id}@${ref.biome}`]);
    if (group[ref.id]) out.push(group[ref.id]);
    if (ref.alt) {
      const g2 = assets[ref.alt.cls] ?? {};
      if (g2[ref.alt.id]) out.push(g2[ref.alt.id]);
    }
    const base = ref.cls === 'appearance' ? 'item' : ref.cls;
    if (ref.category && catFb[`${base}:${ref.category}`]) out.push(catFb[`${base}:${ref.category}`]);
    if (catFb[base]) out.push(catFb[base]);
    return out;
  };

  return {
    id: manifest.id,
    name: manifest.name ?? manifest.id,
    cellSize: cell,
    background: manifest.background ?? fallback.background,
    scaling: manifest.scaling ?? 'nearest',
    animated,
    resolve(ref, now) {
      for (const entry of candidates(ref)) {
        const d = fromEntry(entry, ref, now);
        if (d === 'loading') return fallback.resolve(ref, now);
        if (d) return d;
      }
      return fallback.resolve(ref, now);
    },
    usesMask(terrainId, biome) {
      const g = assets.terrain ?? {};
      const e = (biome && g[`${terrainId}@${biome}`]) || g[terrainId];
      return e?.autotile === 'mask16';
    },
    onChange(cb) {
      listeners.add(cb);
      const unsub = fallback.onChange(cb);
      return () => { listeners.delete(cb); unsub(); };
    },
  };
}

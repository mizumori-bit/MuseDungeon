// テーマの一覧と読み込み。glyph は組み込み、それ以外は public/themes/<id>/theme.json。
import type { Catalog } from '@muse/shared';
import { createGlyphTheme } from './glyph';
import { createImageTheme, type ThemeManifest } from './image';
import type { Theme } from './types';

export type { Theme } from './types';
export { createGlyphTheme } from './glyph';

/** kinds: そのテーマが持つもの（image＝theme.json、sound＝sound.json。docs/SOUND_SPEC.md §12）。無ければ image */
export interface ThemeInfo { id: string; name: string; kinds?: string[] }

const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

export async function listThemes(): Promise<ThemeInfo[]> {
  const out: ThemeInfo[] = [{ id: 'glyph', name: 'glyph（文字）' }];
  try {
    const res = await fetch(`${BASE}themes/index.json`);
    if (res.ok) {
      const list = (await res.json()) as ThemeInfo[];
      for (const t of list) if (t.id !== 'glyph' && (!t.kinds || t.kinds.includes('image'))) out.push(t);
    }
  } catch {
    /* 一覧が無くても glyph だけで動く */
  }
  return out;
}

export async function loadTheme(id: string, catalog: Catalog | null): Promise<Theme> {
  const glyph = createGlyphTheme(catalog);
  if (id === 'glyph') return glyph;
  const baseUrl = `${BASE}themes/${encodeURIComponent(id)}`;
  const res = await fetch(`${baseUrl}/theme.json`);
  if (!res.ok) throw new Error(`theme ${id}: HTTP ${res.status}`);
  const manifest = (await res.json()) as ThemeManifest;
  if (manifest.formatVersion !== 1) throw new Error(`theme ${id}: unsupported formatVersion ${manifest.formatVersion}`);
  // fallbackTheme は現状 glyph のみ（画像テーマの多段フォールバックは未対応）
  return createImageTheme(manifest, baseUrl, glyph);
}

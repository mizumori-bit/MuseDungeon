// アセット制作の発注表（assets:checklist）とテーマ検証（assets:check）。仕様: docs/ASSET_SPEC.md §9.1
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@muse/content';
import type { Catalog } from '@muse/shared';
import { readPng } from './png';

export interface AssetSlot { class: string; key: string; name: string; required: boolean }

export const FX_IDS = ['fx:hit', 'fx:crit', 'fx:miss', 'fx:heal', 'fx:status', 'fx:levelup', 'fx:teleport', 'fx:projectile', 'fx:trap'];
export const UI_IDS = ['ui:cursor', 'ui:target', 'ui:path', 'ui:stack'];

export function assetsChecklist(content: Content, catalog: Catalog): AssetSlot[] {
  const out: AssetSlot[] = [];
  for (const t of content.terrain) if (t.id !== 'core:unknown') out.push({ class: 'terrain', key: t.id, name: t.name.ja, required: true });
  for (const c of content.lists.classes) out.push({ class: 'actor', key: c.id, name: c.name.ja, required: true });
  for (const m of content.lists.monsters) out.push({ class: 'actor', key: m.id, name: m.name.ja, required: true });
  for (const it of content.lists.items) out.push({ class: 'item', key: it.id, name: it.name.ja, required: !it.unidentified });
  for (const a of content.lists.appearances) out.push({ class: 'appearance', key: a.id, name: a.name.ja, required: true });
  for (const f of content.lists.features) out.push({ class: 'feature', key: f.id, name: f.name.ja, required: true });
  for (const s of Object.values(content.statuses)) out.push({ class: 'status', key: s.id, name: s.name.ja, required: false });
  for (const a of content.lists.affixes) out.push({ class: 'affix', key: a.id, name: a.name.ja, required: false });
  for (const id of FX_IDS) out.push({ class: 'fx', key: id, name: id, required: false });
  for (const id of UI_IDS) out.push({ class: 'ui', key: id, name: id, required: false });
  void catalog;
  return out;
}

interface AnimDef { file?: string; frames?: number; frameMs?: number; loop?: boolean }
interface AssetDef {
  file?: string; frame?: { w: number; h: number }; facings?: 1 | 2 | 4; variants?: number;
  anim?: Record<string, AnimDef>; layer?: string; autotile?: string; orient?: string;
  states?: Record<string, { file: string }>;
}
interface ThemeManifest {
  id: string; formatVersion: number; cellSize: number; scaling?: string; background?: string; fallbackTheme?: string;
  assets: Record<string, Record<string, AssetDef>>;
  categoryFallbacks?: Record<string, { file: string }>;
}

export function assetsCheck(content: Content, themeDir: string): { lines: string[]; errors: number } {
  const lines: string[] = [];
  let errors = 0;
  const err = (s: string) => { errors++; lines.push(`ERROR  ${s}`); };
  const warn = (s: string) => lines.push(`WARN   ${s}`);
  const info = (s: string) => lines.push(`INFO   ${s}`);
  const manifestPath = join(themeDir, 'theme.json');
  if (!existsSync(manifestPath)) return { lines: [`ERROR  theme.json not found in ${themeDir}`], errors: 1 };
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as ThemeManifest;
  if (m.formatVersion !== 1) warn(`formatVersion ${m.formatVersion} (expected 1)`);
  const cell = m.cellSize ?? 32;
  if (![16, 24, 32, 48, 64].includes(cell)) warn(`cellSize ${cell} は標準外`);
  const checklist = assetsChecklist(content, { } as Catalog);
  const known = new Map<string, Set<string>>();
  for (const a of checklist) {
    if (!known.has(a.class)) known.set(a.class, new Set());
    known.get(a.class)!.add(a.key);
  }
  const biomes = new Set(content.lists.biomes.map((b) => b.id));
  // マニフェストにあるが content に無い ID
  for (const [cls, entries] of Object.entries(m.assets ?? {})) {
    for (const key of Object.keys(entries)) {
      const [base, biome] = key.split('@');
      const ok = cls === 'fx' || cls === 'ui' ? true : known.get(cls)?.has(base) && (!biome || biomes.has(biome) || cls === 'fx');
      if (!ok) warn(`${cls} ${key}: content に存在しない ID`);
    }
  }
  // 未提供の ID
  let provided = 0;
  for (const a of checklist) {
    const has = !!m.assets?.[a.class]?.[a.key];
    if (has) provided++;
    else if (a.required) info(`missing ${a.class} ${a.key} (${a.name}) → glyph で代替`);
  }
  // PNG 寸法・不透明
  const groundTerrain = new Set(content.terrain.filter((t) => t.layer === 'ground').map((t) => t.id));
  const checkFile = (cls: string, key: string, file: string, w: number, h: number, mustOpaque: boolean) => {
    const p = join(themeDir, file);
    if (!existsSync(p)) return err(`${cls} ${key}: file not found ${file}`);
    try {
      const png = readPng(p);
      if (png.width !== w || png.height !== h) err(`${cls} ${key}: ${file} is ${png.width}x${png.height}, expected ${w}x${h}`);
      if (mustOpaque && png.opaque === false) err(`${cls} ${key}: ${file} は地面タイルなので不透明であること`);
      if (mustOpaque && png.opaque === null) warn(`${cls} ${key}: ${file} の不透明性を検査できない形式（8bit RGBA/RGB 推奨）`);
    } catch (e) {
      err(`${cls} ${key}: ${file}: ${(e as Error).message}`);
    }
  };
  for (const [cls, entries] of Object.entries(m.assets ?? {})) {
    for (const [key, def] of Object.entries(entries)) {
      const fw = def.frame?.w ?? cell, fh = def.frame?.h ?? cell;
      const rows = def.facings === 4 ? 4 : 1;
      const variants = def.variants ?? 1;
      const mustOpaque = cls === 'terrain' && groundTerrain.has(key.split('@')[0]) && def.layer !== 'object';
      if (def.file) {
        const frames = def.anim ? Math.max(1, ...Object.values(def.anim).filter((a) => !a.file).map((a) => a.frames ?? 1)) : 1;
        const cols = def.autotile === 'mask16' ? 16 : frames * (def.anim ? 1 : variants);
        const height = (def.anim && variants > 1 ? variants : 1) * fh * rows;
        checkFile(cls, key, def.file, fw * cols, height, mustOpaque);
      }
      for (const [name, a] of Object.entries(def.anim ?? {})) {
        if (a.file) checkFile(cls, `${key}#${name}`, a.file, fw * (a.frames ?? 1), fh * rows, false);
      }
      for (const [st, sd] of Object.entries(def.states ?? {})) checkFile(cls, `${key}[${st}]`, sd.file, fw, fh, false);
      if (fw > cell * 2 || fh > cell * 2) err(`${cls} ${key}: frame ${fw}x${fh} exceeds 2x2 cells`);
    }
  }
  for (const [k, v] of Object.entries(m.categoryFallbacks ?? {})) if (!existsSync(join(themeDir, v.file))) err(`categoryFallbacks ${k}: file not found ${v.file}`);
  lines.unshift(`theme ${m.id}: provided ${provided}/${checklist.length} slots (required ${checklist.filter((a) => a.required).length})`);
  return { lines, errors };
}

// アセット制作の発注表（assets:checklist）とテーマ検証（assets:check）。仕様: docs/ASSET_SPEC.md §9.1
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@muse/content';
import type { Catalog } from '@muse/shared';
import { readPng } from './png';

/** supported: false はレンダラーが絵を使わない分類（fx・ui。ASSET_SPEC §6.4）。作っても表示されない */
export interface AssetSlot { class: string; key: string; name: string; required: boolean; supported: boolean }

/** 場面の 1 枚絵（ASSET_SPEC §7.7）。推奨の大きさ */
export const SCENE_IDS = ['scene:camp'];
export const SCENE_SIZE = { w: 1280, h: 720 };
/** レンダラーが図形で描く分類（絵を使わない。ASSET_SPEC §6.4） */
export const UNSUPPORTED_CLASSES = new Set(['fx', 'ui']);

export const FX_IDS = ['fx:hit', 'fx:crit', 'fx:miss', 'fx:heal', 'fx:status', 'fx:levelup', 'fx:teleport', 'fx:projectile', 'fx:trap'];
export const UI_IDS = ['ui:cursor', 'ui:target', 'ui:path', 'ui:stack'];

export function assetsChecklist(content: Content, catalog: Catalog): AssetSlot[] {
  const out: AssetSlot[] = [];
  const add = (cls: string, key: string, name: string, required: boolean) => out.push({ class: cls, key, name, required, supported: !UNSUPPORTED_CLASSES.has(cls) });
  for (const t of content.terrain) if (t.id !== 'core:unknown') add('terrain', t.id, t.name.ja, true);
  for (const c of content.lists.classes) add('actor', c.id, c.name.ja, true);
  for (const m of content.lists.monsters) add('actor', m.id, m.name.ja, true);
  for (const it of content.lists.items) add('item', it.id, it.name.ja, !it.unidentified);
  for (const a of content.lists.appearances) add('appearance', a.id, a.name.ja, true);
  for (const f of content.lists.features) add('feature', f.id, f.name.ja, true);
  // キャンプの絵（グリッドに乗らない 1 枚絵。推奨 1280×720・不透明。ASSET_SPEC §7.7）
  for (const id of SCENE_IDS) add('scene', id, `キャンプの絵（1 枚絵。推奨 ${SCENE_SIZE.w}×${SCENE_SIZE.h}・不透明）`, true);
  for (const s of Object.values(content.statuses)) add('status', s.id, s.name.ja, false);
  for (const a of content.lists.affixes) add('affix', a.id, a.name.ja, false);
  // エフェクトと UI 部品はレンダラーが図形で描く（未対応。作っても表示されない）
  for (const id of FX_IDS) add('fx', id, id, false);
  for (const id of UI_IDS) add('ui', id, id, false);
  void catalog;
  return out;
}

/** 発注表の「必須・任意・未対応」 */
export function slotStatus(a: AssetSlot): string {
  return !a.supported ? '未対応（作らない）' : a.required ? '必須' : '任意';
}

interface AnimDef { file?: string; frames?: number; frameMs?: number; loop?: boolean }
interface AssetDef {
  file?: string; frame?: { w: number; h: number }; facings?: 1 | 2 | 4; variants?: number;
  anim?: Record<string, AnimDef>; layer?: string; autotile?: string; orient?: string;
  states?: Record<string, { file: string }>; fit?: string;
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
      if (UNSUPPORTED_CLASSES.has(cls)) { warn(`${cls} ${key}: 未対応の分類。レンダラーが図形で描くので、この絵は表示されない（ASSET_SPEC §6.4）`); continue; }
      const ok = known.get(cls)?.has(base) && (!biome || biomes.has(biome));
      if (!ok) warn(`${cls} ${key}: content に存在しない ID`);
    }
  }
  // 未提供の ID（未対応の分類は数えない）
  const slots = checklist.filter((a) => a.supported);
  let provided = 0;
  for (const a of slots) {
    const has = !!m.assets?.[a.class]?.[a.key];
    if (has) provided++;
    else if (a.required) info(`missing ${a.class} ${a.key} (${a.name}) → ${a.class === 'scene' ? '背景色の無地と「キャンプ」の文字' : 'glyph'} で代替`);
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
  // 場面の 1 枚絵（ASSET_SPEC §7.7）: グリッドに乗らない。不透明。フレームは横に並べ、1 フレームは絵全体と同じ大きさ
  const checkScene = (key: string, def: AssetDef) => {
    if (def.fit !== undefined && def.fit !== 'cover' && def.fit !== 'contain') warn(`scene ${key}: fit "${def.fit}" は cover か contain`);
    const idle = def.anim?.idle;
    const file = idle?.file ?? def.file;
    if (!file) return err(`scene ${key}: file が無い`);
    const p = join(themeDir, file);
    if (!existsSync(p)) return err(`scene ${key}: file not found ${file}`);
    try {
      const png = readPng(p);
      const frames = Math.max(1, idle?.frames ?? 1);
      if (png.width % frames !== 0) err(`scene ${key}: ${file} の幅 ${png.width} がフレーム数 ${frames} で割り切れない`);
      const fw = Math.floor(png.width / frames);
      if (png.opaque === false) err(`scene ${key}: ${file} は不透明であること`);
      if (png.opaque === null) warn(`scene ${key}: ${file} の不透明性を検査できない形式（8bit RGBA/RGB 推奨）`);
      if (Math.abs(fw / png.height - SCENE_SIZE.w / SCENE_SIZE.h) > 0.02) warn(`scene ${key}: 1 フレーム ${fw}x${png.height} は 16:9 でない（推奨 ${SCENE_SIZE.w}x${SCENE_SIZE.h}。端は切れることがある）`);
      else if (fw !== SCENE_SIZE.w) info(`scene ${key}: 1 フレーム ${fw}x${png.height}（推奨 ${SCENE_SIZE.w}x${SCENE_SIZE.h}）`);
    } catch (e) {
      err(`scene ${key}: ${file}: ${(e as Error).message}`);
    }
  };
  for (const [cls, entries] of Object.entries(m.assets ?? {})) {
    if (UNSUPPORTED_CLASSES.has(cls)) continue;
    for (const [key, def] of Object.entries(entries)) {
      if (cls === 'scene') { checkScene(key, def); continue; }
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
  lines.unshift(`theme ${m.id}: provided ${provided}/${slots.length} slots (required ${slots.filter((a) => a.required).length}; fx・ui は未対応で数えない)`);
  return { lines, errors };
}

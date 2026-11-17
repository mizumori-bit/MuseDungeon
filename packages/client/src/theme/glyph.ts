// 既定テーマ glyph: 色付きタイル＋文字。画像アセット無しで全アセットの代替になる。
// 未知の新コンテンツもカタログの category / tags から描けるようにする。
import type { Catalog } from '@muse/shared';
import type { AssetRef, Drawable, GlyphDrawable, Theme } from './types';

const FLOOR_BG = '#17171d';

const TERRAIN: Record<string, GlyphDrawable> = {
  'core:unknown': { kind: 'glyph', ch: ' ', fg: '#000', bg: '#000' },
  'core:floor': { kind: 'glyph', ch: '·', fg: '#55555f', bg: FLOOR_BG },
  'core:floor@core:damp_caves': { kind: 'glyph', ch: '·', fg: '#4b5c66', bg: '#141a1f' },
  'core:floor@core:overgrown_ruins': { kind: 'glyph', ch: '·', fg: '#58664b', bg: '#161b14' },
  'core:wall': { kind: 'glyph', ch: '#', fg: '#a89f91', bg: '#3a342e' },
  'core:wall@core:damp_caves': { kind: 'glyph', ch: '#', fg: '#8da0a8', bg: '#26323a' },
  'core:wall@core:overgrown_ruins': { kind: 'glyph', ch: '#', fg: '#9aa58a', bg: '#2e3527' },
  'core:door_closed': { kind: 'glyph', ch: '+', fg: '#e0a845', bold: true },
  'core:door_open': { kind: 'glyph', ch: "'", fg: '#e0a845', bold: true },
  'core:stairs_down': { kind: 'glyph', ch: '>', fg: '#ffffff', bold: true },
  'core:stairs_up': { kind: 'glyph', ch: '<', fg: '#ffffff', bold: true },
  'core:shallow_water': { kind: 'glyph', ch: '~', fg: '#6cb6e0', bg: '#10283a' },
  'core:grass': { kind: 'glyph', ch: ',', fg: '#6fbf4a', bg: '#152015' },
  'core:tall_grass': { kind: 'glyph', ch: '"', fg: '#58a83a', bg: '#122012' },
  'core:rubble': { kind: 'glyph', ch: ':', fg: '#9a8f80', bg: FLOOR_BG },
  'core:pillar': { kind: 'glyph', ch: 'O', fg: '#c8c0b0', bg: '#2e2a25', bold: true },
};

const ACTOR: Record<string, GlyphDrawable> = {
  'core:warrior': { kind: 'glyph', ch: '@', fg: '#f2f2ff', bold: true },
  'core:scout': { kind: 'glyph', ch: '@', fg: '#a8f0a0', bold: true },
  'core:cave_rat': { kind: 'glyph', ch: 'r', fg: '#c09070', bold: true },
  'core:goblin': { kind: 'glyph', ch: 'g', fg: '#7ec850', bold: true },
  'core:jackal': { kind: 'glyph', ch: 'j', fg: '#d0a860', bold: true },
  'core:spore_mold': { kind: 'glyph', ch: 'm', fg: '#c0e860', bold: true },
  'core:goblin_slinger': { kind: 'glyph', ch: 'g', fg: '#d8c050', bold: true },
  'core:imp': { kind: 'glyph', ch: 'i', fg: '#f06060', bold: true },
  'core:orc_brute': { kind: 'glyph', ch: 'O', fg: '#70b050', bold: true },
  'core:cave_troll': { kind: 'glyph', ch: 'T', fg: '#a0b8a0', bold: true },
  'core:cave_wolf': { kind: 'glyph', ch: 'w', fg: '#a8a8b8', bold: true },
  'core:rust_slime': { kind: 'glyph', ch: 'u', fg: '#c87838', bold: true },
  'core:hexfire_caster': { kind: 'glyph', ch: 'c', fg: '#b060f0', bold: true },
  'core:stoneskin_beetle': { kind: 'glyph', ch: 'b', fg: '#9a9080', bold: true },
};

// relic: 遠征の遺物（core:relic）。目印の光と星はレンダラーが役割（role）から重ねる
// lifeline: 帰還の綱（core:lifeline。手放せないので床には落ちないが、所持品や投擲の演出で引かれたときの代替）
const ITEM_CH: Record<string, string> = { potion: '!', scroll: '?', weapon: ')', armor: '[', throwing: '/', accessory: '"', relic: '¤', lifeline: '§' };
const ITEM_FG: Record<string, string> = { potion: '#e070e0', scroll: '#e8dcb0', weapon: '#c8d0dc', armor: '#c09050', throwing: '#d8d8d8', accessory: '#f0d060', relic: '#ffd54f', lifeline: '#d7b47a' };

const APPEARANCE_FG: Record<string, string> = {
  'core:potion_look_01': '#ff5050',
  'core:potion_look_02': '#5080ff',
  'core:potion_look_03': '#50d050',
  'core:potion_look_04': '#9a8058',
  'core:potion_look_05': '#f0c838',
  'core:potion_look_06': '#a0f0f0',
  'core:scroll_look_01': '#d8d8e8',
  'core:scroll_look_02': '#b08860',
  'core:scroll_look_03': '#e88080',
  'core:scroll_look_04': '#90a8f0',
  'core:scroll_look_05': '#e0d0a0',
};

const FEATURE: Record<string, GlyphDrawable> = {
  'core:fountain': { kind: 'glyph', ch: '{', fg: '#60d0ff', bold: true },
  'core:altar': { kind: 'glyph', ch: '_', fg: '#f0d060', bold: true },
};

const STATUS: Record<string, GlyphDrawable> = {
  'core:poison': { kind: 'glyph', ch: '•', fg: '#7ee060' },
  'core:haste': { kind: 'glyph', ch: '»', fg: '#f0e060' },
  'core:slow': { kind: 'glyph', ch: '«', fg: '#60a0f0' },
  'core:sleep': { kind: 'glyph', ch: 'z', fg: '#c0c0ff' },
  // 帰還中（帰還の綱を使ってからキャンプへ戻るまで。動けない）
  'core:recall': { kind: 'glyph', ch: '§', fg: '#d7b47a' },
};

const UNKNOWN: GlyphDrawable = { kind: 'glyph', ch: '?', fg: '#ff40ff', bold: true };

/** ID 文字列 → 安定した色（見た目専用） */
export function hashColor(id: string, sat = 60, light = 62): string {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return `hsl(${(h >>> 0) % 360} ${sat}% ${light}%)`;
}

export function createGlyphTheme(catalog: Catalog | null): Theme {
  const listeners = new Set<() => void>();
  const terrain = (ref: AssetRef): Drawable => {
    if (ref.biome && TERRAIN[`${ref.id}@${ref.biome}`]) return TERRAIN[`${ref.id}@${ref.biome}`];
    if (TERRAIN[ref.id]) return TERRAIN[ref.id];
    const tr = catalog?.terrain[ref.id];
    if (!tr) return UNKNOWN;
    if (tr.stairs) return { kind: 'glyph', ch: tr.stairs === 'down' ? '>' : '<', fg: '#fff', bold: true };
    if (tr.door) return { kind: 'glyph', ch: tr.door === 'closed' ? '+' : "'", fg: '#e0a845', bold: true };
    if (tr.tags.includes('water')) return { kind: 'glyph', ch: '~', fg: '#6cb6e0', bg: '#10283a' };
    if (tr.tags.includes('grass') || tr.tags.includes('tall_grass')) return { kind: 'glyph', ch: tr.opaque ? '"' : ',', fg: '#6fbf4a', bg: '#152015' };
    if (!tr.passable) return tr.opaque ? { kind: 'glyph', ch: '#', fg: hashColor(ref.id, 15, 65), bg: '#34302b' } : { kind: 'glyph', ch: '0', fg: hashColor(ref.id, 20, 60), bg: FLOOR_BG };
    return { kind: 'glyph', ch: '·', fg: hashColor(ref.id, 15, 45), bg: FLOOR_BG };
  };
  const actor = (ref: AssetRef): Drawable => {
    if (ACTOR[ref.id]) return ACTOR[ref.id];
    if (catalog?.classes[ref.id]) return { kind: 'glyph', ch: '@', fg: hashColor(ref.id, 50, 80), bold: true };
    const m = catalog?.monsters[ref.id];
    if (m) return { kind: 'glyph', ch: m.name.en.charAt(0).toLowerCase() || 'm', fg: hashColor(ref.id), bold: true };
    return UNKNOWN;
  };
  const item = (ref: AssetRef): Drawable => {
    let cat = ref.category;
    if (!cat && ref.cls === 'item') cat = catalog?.items[ref.id]?.category;
    if (!cat && ref.cls === 'appearance') cat = catalog?.appearances[ref.id]?.category;
    const appId = ref.cls === 'appearance' ? ref.id : ref.alt?.cls === 'appearance' ? ref.alt.id : null;
    const ch = ITEM_CH[cat ?? ''] ?? '*';
    let fg = ITEM_FG[cat ?? ''] ?? '#e0e0e0';
    if (appId) fg = APPEARANCE_FG[appId] ?? hashColor(appId, 70, 60);
    return { kind: 'glyph', ch, fg, bold: true };
  };
  const feature = (ref: AssetRef): Drawable => {
    const base = FEATURE[ref.id];
    const def = catalog?.features[ref.id];
    let g: GlyphDrawable = base ?? (def?.category === 'trap' || ref.id.includes('trap') ? { kind: 'glyph', ch: '^', fg: '#ff5050', bold: true } : { kind: 'glyph', ch: '&', fg: hashColor(ref.id), bold: true });
    if (ref.state === 'used') g = { ...g, fg: '#707070' };
    return g;
  };
  return {
    id: 'glyph',
    name: 'glyph',
    cellSize: 24,
    background: '#000000',
    scaling: 'nearest',
    animated: false,
    resolve(ref) {
      switch (ref.cls) {
        case 'terrain': return terrain(ref);
        case 'actor': return actor(ref);
        case 'item':
        case 'appearance': return item(ref);
        case 'feature': return feature(ref);
        case 'status': return STATUS[ref.id] ?? { kind: 'glyph', ch: '•', fg: hashColor(ref.id) };
        case 'affix': return { kind: 'glyph', ch: '◆', fg: hashColor(ref.id, 80, 60) };
        case 'ui':
        case 'fx':
        default: return UNKNOWN;
      }
    },
    usesMask: () => false,
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

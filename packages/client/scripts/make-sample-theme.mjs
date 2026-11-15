// 検証用の最小画像テーマ public/themes/sample を生成する（ダミー画像。画風の提案ではない）。
// 一部の ID だけ画像を持ち、残りは glyph にフォールバックすることを確認するためのもの。
// 実行: node packages/client/scripts/make-sample-theme.mjs
/* global console */
import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'themes', 'sample');
const S = 32;

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA ピクセル配列 → PNG（32bit RGBA, 非乗算アルファ） */
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w * 4; x++) raw[y * (w * 4 + 1) + 1 + x] = px[y * w * 4 + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function canvas(w, h) {
  const px = new Uint8Array(w * h * 4);
  return {
    w, h, px,
    set(x, y, [r, g, b, a = 255]) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    },
    rect(x0, y0, rw, rh, c) { for (let y = y0; y < y0 + rh; y++) for (let x = x0; x < x0 + rw; x++) this.set(x, y, c); },
    circle(cx, cy, r, c) { for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r) this.set(cx + x, cy + y, c); },
  };
}
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

function floorSheet(base, variants) {
  const c = canvas(S * variants, S);
  for (let v = 0; v < variants; v++) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = Math.floor(rnd() * 14) - 7;
      c.set(v * S + x, y, [base[0] + n, base[1] + n, base[2] + n]);
    }
    for (let k = 0; k < 4; k++) c.rect(v * S + Math.floor(rnd() * 28), Math.floor(rnd() * 28), 2, 2, [base[0] - 18, base[1] - 18, base[2] - 18]);
  }
  return c;
}
function wallSheet(variants) {
  const c = canvas(S * variants, S);
  for (let v = 0; v < variants; v++) {
    c.rect(v * S, 0, S, S, [70, 62, 54]);
    for (let row = 0; row < 4; row++) {
      const off = (row + v) % 2 ? 8 : 0;
      for (let bx = -1; bx < 3; bx++) c.rect(v * S + bx * 16 + off + 1, row * 8 + 1, 14, 6, [120 + v * 8, 104, 88]);
    }
  }
  return c;
}
function goblinSheet() {
  // facings: 2（東向きで描く。西向きはレンダラーが反転）
  const c = canvas(S, S);
  c.circle(16, 20, 9, [70, 140, 50]);
  c.circle(17, 11, 7, [90, 170, 60]);
  c.rect(19, 9, 2, 2, [255, 230, 80]);
  c.rect(23, 11, 3, 2, [60, 120, 40]);
  c.rect(10, 28, 4, 4, [50, 90, 35]);
  c.rect(18, 28, 4, 4, [50, 90, 35]);
  return c;
}
function warriorSheet() {
  const c = canvas(S, S);
  c.rect(11, 12, 10, 12, [60, 100, 190]);
  c.circle(16, 8, 5, [235, 200, 170]);
  c.rect(11, 3, 10, 3, [170, 170, 185]);
  c.rect(11, 24, 4, 8, [60, 60, 80]);
  c.rect(17, 24, 4, 8, [60, 60, 80]);
  c.rect(22, 8, 2, 16, [210, 210, 220]);
  return c;
}
function potionSheet() {
  const c = canvas(S, S);
  c.circle(16, 21, 8, [220, 40, 40]);
  c.rect(13, 8, 6, 7, [200, 220, 230, 200]);
  c.rect(12, 5, 8, 3, [140, 90, 50]);
  c.rect(12, 17, 3, 3, [255, 170, 170]);
  return c;
}

mkdirSync(join(OUT, 'terrain'), { recursive: true });
mkdirSync(join(OUT, 'actors'), { recursive: true });
mkdirSync(join(OUT, 'items'), { recursive: true });
const files = {
  'terrain/floor.png': floorSheet([58, 58, 66], 3),
  'terrain/caves_floor.png': floorSheet([46, 60, 68], 2),
  'terrain/wall.png': wallSheet(2),
  'actors/goblin.png': goblinSheet(),
  'actors/warrior.png': warriorSheet(),
  'items/potion_01.png': potionSheet(),
};
for (const [name, c] of Object.entries(files)) writeFileSync(join(OUT, name), png(c.w, c.h, c.px));

const theme = {
  id: 'sample',
  name: 'sample（検証用ダミー画像）',
  formatVersion: 1,
  cellSize: 32,
  scaling: 'nearest',
  background: '#000000',
  fallbackTheme: 'glyph',
  assets: {
    terrain: {
      'core:floor': { file: 'terrain/floor.png', variants: 3 },
      'core:floor@core:damp_caves': { file: 'terrain/caves_floor.png', variants: 2 },
      'core:wall': { file: 'terrain/wall.png', variants: 2 },
    },
    actor: {
      'core:goblin': { file: 'actors/goblin.png', facings: 2 },
      'core:warrior': { file: 'actors/warrior.png' },
    },
    appearance: {
      'core:potion_look_01': { file: 'items/potion_01.png' },
    },
  },
  categoryFallbacks: {},
};
writeFileSync(join(OUT, 'theme.json'), JSON.stringify(theme, null, 2) + '\n');
writeFileSync(join(OUT, '..', 'index.json'), JSON.stringify([{ id: 'sample', name: theme.name }], null, 2) + '\n');
console.log(`wrote ${Object.keys(files).length} images + theme.json to ${OUT}`);

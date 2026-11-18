// 最小限の PNG 読み取り（寸法とアルファ検査用）。8bit RGBA / RGB のみデコードする。書き出しは 8bit RGB（検証用のダミー画像とテスト用）。
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** 8bit RGB（不透明）の PNG を書く。pixel(x, y) は [r, g, b] */
export function writePngRgb(path: string, width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): void {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[row + 1 + x * 3] = r; raw[row + 2 + x * 3] = g; raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

export interface PngInfo { width: number; height: number; colorType: number; bitDepth: number; opaque: boolean | null }

export function readPng(path: string): PngInfo {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  let hasTrns = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'tRNS') hasTrns = true;
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  let opaque: boolean | null = null;
  if (bitDepth === 8 && interlace === 0 && (colorType === 6 || colorType === 2)) {
    if (colorType === 2) opaque = !hasTrns;
    else {
      const raw = inflateSync(Buffer.concat(idat));
      const bpp = 4;
      const stride = width * bpp;
      const prev = Buffer.alloc(stride);
      const cur = Buffer.alloc(stride);
      opaque = true;
      for (let y = 0; y < height; y++) {
        const ft = raw[y * (stride + 1)];
        const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          let v = line[i];
          if (ft === 1) v += a;
          else if (ft === 2) v += b;
          else if (ft === 3) v += (a + b) >> 1;
          else if (ft === 4) {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          }
          cur[i] = v & 0xff;
        }
        for (let x = 0; x < width; x++) if (cur[x * 4 + 3] !== 255) { opaque = false; break; }
        if (!opaque) break;
        cur.copy(prev);
      }
    }
  }
  return { width, height, colorType, bitDepth, opaque };
}

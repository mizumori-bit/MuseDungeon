// 最小限の PNG 読み取り（寸法とアルファ検査用）。8bit RGBA / RGB のみデコードする。
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

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

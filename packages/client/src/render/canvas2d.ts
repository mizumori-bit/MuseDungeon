// Canvas 2D 実装。レイヤー L0〜L7（docs/ASSET_SPEC.md §4）の順に描く。
// 向き・補間・演出は見た目専用の状態で、イベントから導出する（World State には含めない）。
import type { Pos } from '@muse/shared';
import type { AssetRef, Drawable, Facing, GlyphDrawable, Theme } from '../theme/types';
import { bucketFrac } from './scene';
import type { Renderer, Scene, SceneEntity, ViewEvent } from './types';

type Fx =
  | { t: 'flash'; x: number; y: number; color: string; start: number; dur: number }
  | { t: 'text'; x: number; y: number; text: string; color: string; start: number; dur: number }
  | { t: 'proj'; from: Pos; to: Pos; ref?: AssetRef; start: number; dur: number }
  | { t: 'ghost'; ent: SceneEntity; x: number; y: number; start: number; dur: number }
  | { t: 'ring'; x: number; y: number; color: string; start: number; dur: number };

interface Tween { from: Pos; to: Pos; start: number; dur: number }
interface Bump { dx: number; dy: number; start: number; dur: number }

const FONT_STACK = '"Consolas","Menlo","DejaVu Sans Mono","Noto Sans Mono",monospace';
const STATUS_COLORS: Record<string, string> = { 'core:poison': '#7ee060', 'core:haste': '#f0e060', 'core:slow': '#60a0f0', 'core:sleep': '#c0c0ff' };

export class Canvas2DRenderer implements Renderer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private theme: Theme | null = null;
  private scene: Scene | null = null;
  private dirty = true;
  private raf = 0;
  private unsubTheme: (() => void) | null = null;
  private ro: ResizeObserver | null = null;
  private tweens = new Map<string, Tween>();
  private bumps = new Map<string, Bump>();
  private fx: Fx[] = [];
  private facing = new Map<string, Facing>();
  private known = new Map<string, SceneEntity>();
  private camX = 0;
  private camY = 0;
  private camInit = false;
  private originX = 0;
  private originY = 0;
  private cs = 24;
  zoom = 1;
  speed = 1;
  hover: Pos | null = null;

  mount(canvas: HTMLCanvasElement, theme: Theme): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.setTheme(theme);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const busy = this.fx.length > 0 || this.tweens.size > 0 || this.bumps.size > 0 || (this.theme?.animated ?? false) || this.camMoving();
      if (this.dirty || busy) {
        this.dirty = false;
        this.render(now);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  setTheme(theme: Theme): void {
    this.unsubTheme?.();
    this.theme = theme;
    this.unsubTheme = theme.onChange(() => { this.dirty = true; });
    this.dirty = true;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    this.unsubTheme?.();
    this.ro?.disconnect();
    this.canvas = null;
  }

  draw(scene: Scene): void {
    if (this.scene && this.scene.floorKey !== scene.floorKey) {
      this.tweens.clear();
      this.bumps.clear();
      this.fx = [];
      this.camInit = false;
    }
    if (this.known.size > 2000) this.known.clear();
    for (const e of scene.entities) this.known.set(e.id, e);
    this.scene = scene;
    this.dirty = true;
  }

  setZoom(z: number): void {
    this.zoom = Math.max(0.4, Math.min(4, z));
    this.dirty = true;
  }

  markDirty(): void {
    this.dirty = true;
  }

  animate(events: ViewEvent[]): Promise<void> {
    const now = performance.now();
    const k = 1 / Math.max(0.25, this.speed);
    const fast = this.speed >= 8;
    let maxDur = 0;
    const add = (f: Fx) => { this.fx.push(f); maxDur = Math.max(maxDur, f.dur); };
    const posOf = (id: string | null): Pos | null => {
      if (!id) return null;
      const e = this.scene?.entities.find((x) => x.id === id) ?? this.known.get(id);
      return e ? { x: e.x, y: e.y } : null;
    };
    for (const ev of events) {
      switch (ev.kind) {
        case 'move': {
          const dx = ev.to.x - ev.from.x;
          if (dx !== 0) this.facing.set(ev.id, dx > 0 ? 'e' : 'w');
          else if (ev.to.y !== ev.from.y) this.facing.set(ev.id, ev.to.y > ev.from.y ? 's' : 'n');
          if (ev.teleport) {
            if (!fast) { add({ t: 'ring', ...ev.from, color: '#c080ff', start: now, dur: 350 * k }); add({ t: 'ring', ...ev.to, color: '#c080ff', start: now, dur: 350 * k }); }
          } else if (!fast) {
            const dur = 110 * k;
            this.tweens.set(ev.id, { from: ev.from, to: ev.to, start: now, dur });
            maxDur = Math.max(maxDur, dur);
          }
          break;
        }
        case 'attack': {
          if (ev.from && ev.id) {
            const dx = Math.sign(ev.to.x - ev.from.x), dy = Math.sign(ev.to.y - ev.from.y);
            if (dx) this.facing.set(ev.id, dx > 0 ? 'e' : 'w');
            if (ev.ranged) { if (!fast) add({ t: 'proj', from: ev.from, to: ev.to, start: now, dur: 160 * k }); }
            else if (!fast) { this.bumps.set(ev.id, { dx, dy, start: now, dur: 140 * k }); maxDur = Math.max(maxDur, 140 * k); }
          }
          if (ev.hit) add({ t: 'flash', ...ev.to, color: ev.crit ? 'rgba(255,240,80,0.8)' : 'rgba(255,60,60,0.6)', start: now, dur: 220 * k });
          else if (!fast) add({ t: 'text', ...ev.to, text: 'miss', color: '#bbbbbb', start: now, dur: 600 * k });
          if (ev.crit) add({ t: 'text', ...ev.to, text: 'CRIT!', color: '#ffe060', start: now, dur: 700 * k });
          break;
        }
        case 'damage': {
          const p = posOf(ev.id);
          if (p) add({ t: 'text', ...p, text: `-${ev.amount}`, color: '#ff6060', start: now, dur: 750 * k });
          break;
        }
        case 'heal': {
          const p = posOf(ev.id);
          if (p) add({ t: 'text', ...p, text: `+${ev.amount}`, color: '#70ff90', start: now, dur: 750 * k });
          break;
        }
        case 'die': {
          const ent = this.known.get(ev.id);
          if (ent) add({ t: 'ghost', ent, x: ev.pos.x, y: ev.pos.y, start: now, dur: 450 * k });
          break;
        }
        case 'projectile':
          if (!fast) add({ t: 'proj', from: ev.from, to: ev.to, ref: ev.ref, start: now, dur: 200 * k });
          break;
        case 'levelup': {
          const p = posOf(ev.id);
          if (p) { add({ t: 'ring', ...p, color: '#ffd740', start: now, dur: 700 * k }); add({ t: 'text', ...p, text: 'LEVEL UP', color: '#ffd740', start: now, dur: 1200 * k }); }
          break;
        }
        case 'status': {
          const p = posOf(ev.id);
          if (p && !fast) add({ t: 'ring', ...p, color: STATUS_COLORS[ev.status] ?? '#ffffff', start: now, dur: 400 * k });
          break;
        }
        case 'trap':
          add({ t: 'flash', ...ev.pos, color: 'rgba(255,140,0,0.7)', start: now, dur: 400 * k });
          break;
      }
    }
    this.dirty = true;
    return new Promise((res) => setTimeout(res, Math.min(1500, maxDur)));
  }

  /** 画面座標 → セル座標 */
  cellAt(clientX: number, clientY: number): Pos | null {
    if (!this.canvas || !this.scene) return null;
    const r = this.canvas.getBoundingClientRect();
    const dpr = this.canvas.width / Math.max(1, r.width);
    const px = (clientX - r.left) * dpr;
    const py = (clientY - r.top) * dpr;
    const x = Math.floor(this.originX + px / this.cs);
    const y = Math.floor(this.originY + py / this.cs);
    if (x < 0 || y < 0 || x >= this.scene.width || y >= this.scene.height) return null;
    return { x, y };
  }

  entityAt(p: Pos): SceneEntity | null {
    if (!this.scene) return null;
    const list = this.scene.entities.filter((e) => e.x === p.x && e.y === p.y);
    return list.find((e) => e.layer === 'actor') ?? list.find((e) => e.layer === 'item') ?? list[0] ?? null;
  }

  private resize(): void {
    if (!this.canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.dirty = true;
  }

  private camMoving(): boolean {
    const s = this.scene;
    if (!s?.focus) return false;
    const t = this.focusPos(performance.now());
    return Math.abs(t.x - this.camX) > 0.01 || Math.abs(t.y - this.camY) > 0.01;
  }

  private entPos(e: SceneEntity, now: number): { x: number; y: number } {
    const tw = this.tweens.get(e.id);
    let x = e.x, y = e.y;
    if (tw) {
      const p = (now - tw.start) / tw.dur;
      if (p >= 1) this.tweens.delete(e.id);
      else if (tw.to.x === e.x && tw.to.y === e.y) {
        x = tw.from.x + (tw.to.x - tw.from.x) * p;
        y = tw.from.y + (tw.to.y - tw.from.y) * p;
      }
    }
    const b = this.bumps.get(e.id);
    if (b) {
      const p = (now - b.start) / b.dur;
      if (p >= 1) this.bumps.delete(e.id);
      else {
        const s = Math.sin(p * Math.PI) * 0.3;
        x += b.dx * s;
        y += b.dy * s;
      }
    }
    return { x, y };
  }

  private focusPos(now: number): { x: number; y: number } {
    const s = this.scene!;
    const fe = s.focusId ? s.entities.find((e) => e.id === s.focusId) : undefined;
    if (fe) return this.entPos(fe, now);
    return s.focus ?? { x: s.width / 2, y: s.height / 2 };
  }

  private render(now: number): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    const theme = this.theme;
    if (!ctx || !canvas || !theme) return;
    const W = canvas.width, H = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.imageSmoothingEnabled = theme.scaling === 'linear';
    ctx.fillStyle = theme.background;
    ctx.fillRect(0, 0, W, H);
    const s = this.scene;
    if (!s) return;
    const cs = Math.max(4, Math.round(theme.cellSize * this.zoom * dpr));
    this.cs = cs;
    // カメラ
    const target = this.focusPos(now);
    if (!this.camInit || Math.abs(target.x - this.camX) > 12 || Math.abs(target.y - this.camY) > 12) {
      this.camX = target.x; this.camY = target.y; this.camInit = true;
    } else {
      this.camX += (target.x - this.camX) * 0.3;
      this.camY += (target.y - this.camY) * 0.3;
    }
    const cols = W / cs, rows = H / cs;
    this.originX = this.camX + 0.5 - cols / 2;
    this.originY = this.camY + 0.5 - rows / 2;
    // フロアがビューポートより小さいときは中央寄せ
    if (s.width <= cols) this.originX = (s.width - cols) / 2;
    if (s.height <= rows) this.originY = (s.height - rows) / 2;
    const ox = this.originX, oy = this.originY;
    const x0 = Math.max(0, Math.floor(ox)), y0 = Math.max(0, Math.floor(oy));
    const x1 = Math.min(s.width - 1, Math.ceil(ox + cols)), y1 = Math.min(s.height - 1, Math.ceil(oy + rows));
    const sx = (x: number) => (x - ox) * cs;
    const sy = (y: number) => (y - oy) * cs;
    const cat = s.catalog;

    // L1 地面 / L2 地形オブジェクト
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * s.width + x;
        const tid = s.terrain[i];
        if (!tid || !s.vis[i]) continue; // L0: 未知は背景のまま
        const meta = cat.terrain[tid];
        const ref: AssetRef = { cls: 'terrain', id: tid, biome: s.biome, x, y };
        if (meta?.layer === 'object') {
          this.drawCell(ctx, theme.resolve({ cls: 'terrain', id: 'core:floor', biome: s.biome, x, y }, now), sx(x), sy(y), cs, true);
          this.drawCell(ctx, theme.resolve(ref, now), sx(x), sy(y), cs, false);
        } else {
          if (theme.usesMask(tid, s.biome)) ref.mask = this.mask(s, x, y, tid);
          this.drawCell(ctx, theme.resolve(ref, now), sx(x), sy(y), cs, true);
        }
      }
    }
    const inView = (e: { x: number; y: number }) => e.x >= x0 - 1 && e.x <= x1 + 1 && e.y >= y0 - 1 && e.y <= y1 + 1;
    // L3 地物 → アイテム（同一セルは最上位の 1 つ＋「複数あり」の印）
    const topItem = new Map<number, SceneEntity>();
    for (const e of s.entities) {
      if (e.layer !== 'item') continue;
      const k = e.y * s.width + e.x;
      // 遺物は同じセルの他のアイテムより優先して見せる
      if (topItem.get(k)?.role !== 'relic') topItem.set(k, e);
    }
    for (const layer of ['feature', 'item'] as const) {
      for (const e of s.entities) {
        if (e.layer !== layer || !inView(e)) continue;
        if (layer === 'item' && topItem.get(e.y * s.width + e.x) !== e) continue;
        if (e.role === 'relic') this.drawRelicGlow(ctx, sx(e.x), sy(e.y), cs);
        ctx.globalAlpha = e.hidden ? 0.45 : 1;
        this.drawEntity(ctx, theme.resolve({ ...e.ref, x: e.x, y: e.y }, now), sx(e.x), sy(e.y), cs);
        ctx.globalAlpha = 1;
        if (e.role === 'relic') this.drawRelicBadge(ctx, sx(e.x), sy(e.y), cs);
        if (layer === 'item' && (e.stack ?? 1) > 1) {
          ctx.fillStyle = '#ffffff';
          ctx.font = `bold ${Math.round(cs * 0.32)}px ${FONT_STACK}`;
          ctx.textAlign = 'right';
          ctx.textBaseline = 'top';
          ctx.fillText('+', sx(e.x) + cs - 1, sy(e.y) + 1);
        }
      }
    }
    // L4 アクター（y の小さい順）
    const actors = s.entities.filter((e) => e.layer === 'actor' && inView(e)).map((e) => ({ e, p: this.entPos(e, now) }))
      .sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x);
    for (const { e, p } of actors) {
      if (e.role === 'guardian') this.drawGuardianBase(ctx, sx(p.x), sy(p.y), cs);
      if (e.isPlayer && e.color) {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = Math.max(1, cs * 0.07);
        ctx.beginPath();
        ctx.ellipse(sx(p.x) + cs / 2, sy(p.y) + cs * 0.86, cs * 0.38, cs * 0.13, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = e.remembered ? 0.6 : 1;
      this.drawEntity(ctx, theme.resolve({ ...e.ref, facing: this.facing.get(e.id) ?? 'e' }, now), sx(p.x), sy(p.y), cs);
      ctx.globalAlpha = 1;
    }
    // L5 エフェクト
    this.fx = this.fx.filter((f) => now - f.start < f.dur);
    for (const f of this.fx) {
      const p = Math.max(0, Math.min(1, (now - f.start) / f.dur));
      if (f.t === 'flash') {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = f.color;
        ctx.fillRect(sx(f.x), sy(f.y), cs, cs);
        ctx.globalAlpha = 1;
      } else if (f.t === 'proj') {
        const x = f.from.x + (f.to.x - f.from.x) * p, y = f.from.y + (f.to.y - f.from.y) * p;
        if (f.ref) this.drawEntity(ctx, theme.resolve(f.ref, now), sx(x), sy(y), cs * 0.7, cs * 0.15);
        else {
          ctx.fillStyle = '#f0f0d0';
          ctx.beginPath();
          ctx.arc(sx(x) + cs / 2, sy(y) + cs / 2, cs * 0.12, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (f.t === 'ghost') {
        ctx.globalAlpha = 1 - p;
        this.drawEntity(ctx, theme.resolve(f.ent.ref, now), sx(f.x), sy(f.y), cs);
        ctx.globalAlpha = 1;
      } else if (f.t === 'ring') {
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = f.color;
        ctx.lineWidth = Math.max(1, cs * 0.08);
        ctx.beginPath();
        ctx.arc(sx(f.x) + cs / 2, sy(f.y) + cs / 2, cs * (0.3 + p * 0.5), 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    // L6 視界: 記憶セルの暗転
    ctx.fillStyle = 'rgba(0,0,10,0.55)';
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (s.vis[y * s.width + x] === 1) ctx.fillRect(sx(x), sy(y), cs + 0.5, cs + 0.5);
      }
    }
    // L7 オーバーレイ
    for (const { e, p } of actors) this.drawOverlay(ctx, e, sx(p.x), sy(p.y), cs, now);
    if (s.path) {
      ctx.fillStyle = 'rgba(120,200,255,0.55)';
      for (const c of s.path) {
        ctx.beginPath();
        ctx.arc(sx(c.x) + cs / 2, sy(c.y) + cs / 2, Math.max(1.5, cs * 0.1), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const cursor = s.cursor ?? this.hover;
    if (cursor) {
      ctx.strokeStyle = s.cursor ? '#ffeb3b' : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = Math.max(1, cs * 0.06);
      ctx.strokeRect(sx(cursor.x) + 1, sy(cursor.y) + 1, cs - 2, cs - 2);
    }
    for (const f of this.fx) {
      if (f.t !== 'text') continue;
      const p = (now - f.start) / f.dur;
      ctx.globalAlpha = Math.max(0, 1 - p);
      ctx.font = `bold ${Math.round(cs * 0.45)}px ${FONT_STACK}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      const tx = sx(f.x) + cs / 2, ty = sy(f.y) - p * cs * 0.8;
      ctx.strokeText(f.text, tx, ty);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, tx, ty);
      ctx.globalAlpha = 1;
    }
    for (const b of s.bubbles) {
      const e = s.entities.find((x) => x.id === b.id);
      if (!e || !inView(e)) continue;
      const p = this.entPos(e, now);
      this.drawBubble(ctx, b.text, sx(p.x) + cs / 2, sy(p.y) - cs * 0.2, cs, W);
    }
  }

  private mask(s: Scene, x: number, y: number, tid: string): number {
    const same = (nx: number, ny: number) => {
      if (nx < 0 || ny < 0 || nx >= s.width || ny >= s.height) return true;
      const t = s.terrain[ny * s.width + nx];
      return t === null || t === tid; // 未知は同じグループ扱い
    };
    return (same(x, y - 1) ? 1 : 0) | (same(x + 1, y) ? 2 : 0) | (same(x, y + 1) ? 4 : 0) | (same(x - 1, y) ? 8 : 0);
  }

  private drawCell(ctx: CanvasRenderingContext2D, d: Drawable, px: number, py: number, cs: number, ground: boolean): void {
    if (d.kind === 'sprite') {
      ctx.drawImage(d.img, d.sx, d.sy, d.sw, d.sh, px, py, cs + 0.5, cs + 0.5);
      return;
    }
    if (ground) {
      ctx.fillStyle = d.bg ?? '#17171d';
      ctx.fillRect(px, py, cs + 0.5, cs + 0.5);
    }
    this.glyph(ctx, d, px, py, cs, false);
  }

  private glyph(ctx: CanvasRenderingContext2D, g: GlyphDrawable, px: number, py: number, cs: number, outline: boolean): void {
    if (g.ch === ' ') return;
    ctx.font = `${g.bold ? 'bold ' : ''}${Math.round(cs * 0.78)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (outline) {
      ctx.lineWidth = Math.max(2, cs * 0.12);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(g.ch, px + cs / 2, py + cs / 2 + cs * 0.04);
    }
    ctx.fillStyle = g.fg;
    ctx.fillText(g.ch, px + cs / 2, py + cs / 2 + cs * 0.04);
  }

  /** エンティティ（アンカーは既定で下端中央をセル下端中央へ） */
  private drawEntity(ctx: CanvasRenderingContext2D, d: Drawable, px: number, py: number, cs: number, inset = 0): void {
    const size = cs - inset * 2;
    const x = px + inset, y = py + inset;
    if (d.kind === 'glyph') {
      this.glyph(ctx, d, x, y, size, true);
      return;
    }
    const scale = size / (this.theme?.cellSize ?? 32);
    const dw = d.sw * scale, dh = d.sh * scale;
    const ax = x + size / 2 - d.anchorX * dw;
    const ay = y + size - d.anchorY * dh;
    if (d.flipX) {
      ctx.save();
      ctx.translate(ax + dw, ay);
      ctx.scale(-1, 1);
      ctx.drawImage(d.img, d.sx, d.sy, d.sw, d.sh, 0, 0, dw, dh);
      ctx.restore();
    } else ctx.drawImage(d.img, d.sx, d.sy, d.sw, d.sh, ax, ay, dw, dh);
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, e: SceneEntity, px: number, py: number, cs: number, now: number): void {
    const theme = this.theme!;
    const frac = e.hpFrac ?? (e.hpBucket ? bucketFrac(e.hpBucket) : undefined);
    if (frac !== undefined && (frac < 0.999 || e.isPlayer)) {
      const w = cs * 0.8, h = Math.max(2, cs * 0.09);
      const bx = px + cs * 0.1, by = py + cs - h - 1;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(bx - 1, by - 1, w + 2, h + 2);
      ctx.fillStyle = frac > 0.6 ? '#4caf50' : frac > 0.35 ? '#ffc107' : frac > 0.2 ? '#ff7043' : '#e53935';
      ctx.fillRect(bx, by, w * Math.max(0, Math.min(1, frac)), h);
    }
    const icon = cs * 0.42;
    const statuses = [...e.statuses];
    if (e.asleep && !statuses.includes('core:sleep')) statuses.push('core:sleep');
    statuses.slice(0, 3).forEach((st, i) => {
      this.drawIcon(ctx, theme.resolve({ cls: 'status', id: st }, now), px + cs - icon * (i + 1), py, icon);
    });
    e.affixes.slice(0, 2).forEach((af, i) => {
      this.drawIcon(ctx, theme.resolve({ cls: 'affix', id: af }, now), px + icon * i, py, icon);
    });
    if (e.role === 'guardian') this.drawCrown(ctx, px + cs / 2, py - cs * 0.02, cs * 0.42);
    if (e.isPlayer && e.name) {
      ctx.font = `bold ${Math.max(9, Math.round(cs * 0.36))}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(e.name, px + cs / 2, py - 1);
      ctx.fillStyle = e.color ?? '#fff';
      ctx.fillText(e.name, px + cs / 2, py - 1);
    }
  }

  // ---- 遠征の目的に関わる個体の印（テーマ非依存のベクター描画。画像・glyph のどちらの上にも重ねる） ----

  /** 守護者: 足元の赤い輪と、セルの四隅の括弧 */
  private drawGuardianBase(ctx: CanvasRenderingContext2D, px: number, py: number, cs: number): void {
    ctx.save();
    ctx.fillStyle = 'rgba(255,70,40,0.22)';
    ctx.strokeStyle = 'rgba(255,90,50,0.95)';
    ctx.lineWidth = Math.max(1.5, cs * 0.07);
    ctx.beginPath();
    ctx.ellipse(px + cs / 2, py + cs * 0.84, cs * 0.44, cs * 0.16, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const k = cs * 0.24, m = Math.max(1, cs * 0.04);
    ctx.lineWidth = Math.max(1.5, cs * 0.06);
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of [[px + m, py + m, 1, 1], [px + cs - m, py + m, -1, 1], [px + m, py + cs - m, 1, -1], [px + cs - m, py + cs - m, -1, -1]]) {
      ctx.moveTo(cx + dx * k, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * k);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** 守護者: 頭上の冠 */
  private drawCrown(ctx: CanvasRenderingContext2D, cx: number, bottom: number, w: number): void {
    const h = w * 0.62;
    const l = cx - w / 2, r = cx + w / 2, top = bottom - h;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(l, bottom);
    ctx.lineTo(l, top + h * 0.15);
    ctx.lineTo(cx - w / 4, top + h * 0.55);
    ctx.lineTo(cx, top);
    ctx.lineTo(cx + w / 4, top + h * 0.55);
    ctx.lineTo(r, top + h * 0.15);
    ctx.lineTo(r, bottom);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, w * 0.14);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.stroke();
    ctx.fillStyle = '#ffb300';
    ctx.fill();
    ctx.restore();
  }

  /** 遺物: 背後の金色の光 */
  private drawRelicGlow(ctx: CanvasRenderingContext2D, px: number, py: number, cs: number): void {
    const cx = px + cs / 2, cy = py + cs / 2;
    ctx.save();
    const g = ctx.createRadialGradient(cx, cy, cs * 0.05, cx, cy, cs * 0.62);
    g.addColorStop(0, 'rgba(255,215,80,0.75)');
    g.addColorStop(1, 'rgba(255,215,80,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - cs * 0.15, py - cs * 0.15, cs * 1.3, cs * 1.3);
    ctx.strokeStyle = 'rgba(255,220,100,0.95)';
    ctx.lineWidth = Math.max(1.5, cs * 0.06);
    ctx.beginPath();
    ctx.arc(cx, cy, cs * 0.46, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** 遺物: 左上の四芒星 */
  private drawRelicBadge(ctx: CanvasRenderingContext2D, px: number, py: number, cs: number): void {
    const r = cs * 0.2, cx = px + r + 1, cy = py + r + 1, q = r * 0.32;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + q, cy - q);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx + q, cy + q);
    ctx.lineTo(cx, cy + r);
    ctx.lineTo(cx - q, cy + q);
    ctx.lineTo(cx - r, cy);
    ctx.lineTo(cx - q, cy - q);
    ctx.closePath();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.5, cs * 0.05);
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.stroke();
    ctx.fillStyle = '#fff59d';
    ctx.fill();
    ctx.restore();
  }

  private drawIcon(ctx: CanvasRenderingContext2D, d: Drawable, px: number, py: number, size: number): void {
    if (d.kind === 'sprite') {
      ctx.drawImage(d.img, d.sx, d.sy, d.sw, d.sh, px, py, size, size);
      return;
    }
    ctx.font = `bold ${Math.round(size * 0.9)}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.strokeText(d.ch, px + size / 2, py + size / 2);
    ctx.fillStyle = d.fg;
    ctx.fillText(d.ch, px + size / 2, py + size / 2);
  }

  private drawBubble(ctx: CanvasRenderingContext2D, text: string, cx: number, bottom: number, cs: number, W: number): void {
    const fs = Math.max(10, Math.round(cs * 0.4));
    ctx.font = `${fs}px sans-serif`;
    const maxW = Math.min(W * 0.6, fs * 18);
    const lines: string[] = [];
    let cur = '';
    for (const ch of text) {
      if (ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; if (lines.length >= 3) break; } else cur += ch;
    }
    if (lines.length < 3 && cur) lines.push(cur);
    if (lines.length === 3 && text.length > lines.join('').length) lines[2] = lines[2].slice(0, -1) + '…';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + fs;
    const h = lines.length * fs * 1.25 + fs * 0.5;
    let x = cx - w / 2;
    x = Math.max(2, Math.min(W - w - 2, x));
    const y = bottom - h - fs * 0.4;
    ctx.fillStyle = 'rgba(250,250,240,0.94)';
    ctx.strokeStyle = 'rgba(40,40,40,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, fs * 0.4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#222';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, x + fs / 2, y + fs * 0.25 + i * fs * 1.25));
  }
}

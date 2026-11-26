// 鳴らす仕組み（Web Audio。docs/SOUND_SPEC.md §4・§6・§12）。試聴ページ（docs/sound-audition/index.html）の読み方を本番に移したもの。
// 音楽は 16 分の格子で少し先まで予約する。音の状態の切り替えは定義の quantize（拍・小節）の頭で行い、型は通しの位置から乗り換える。
// 同時に鳴る音は MAX_VOICES まで（新しい音を置くたびに、ほかの音を早めに止める）。乱数は使わない（ノイズも決まった並び）。
import type { SoundState } from '@muse/shared';
import { degreeToFreq, MAX_CUE_SEC, MAX_VOICES, notesAt, resolveSound, TICKS, type NoteDef, type Resolved, type ScaleDef, type SoundDef, type VoiceDef } from './def';
import { planSteals, type VoiceSlot } from './voices';

interface Live extends VoiceSlot { gain: GainNode; src: AudioScheduledSourceNode }

/** 止める音の消え方（秒。クリックを出さない程度に短く） */
const STEAL_FADE = 0.006;
const STEAL_STOP = 0.04;

export interface EngineInfo { tick: number; scale: string; tempo: number; parts: string[]; voices: number; stolen: number }

export class SoundEngine {
  readonly master: GainNode;
  private readonly music: GainNode;
  private readonly cueBus: GainNode;
  private readonly partGain = new Map<string, GainNode>();
  private readonly noise: AudioBuffer;
  private readonly kit: Record<string, VoiceDef>;
  private tick = 0;
  private nextTime: number;
  private cur: Resolved | null = null;
  private state: SoundState | null = null;
  private voices: Live[] = [];
  private nextId = 1;
  /** 予約した拍の頭（合図の「次の拍」に使う） */
  private beats: number[] = [];
  /** 上限のために早めに止めた音の数（確かめ用） */
  stolen = 0;

  constructor(private readonly ctx: BaseAudioContext, private readonly def: SoundDef, dest: AudioNode) {
    this.master = ctx.createGain();
    this.master.connect(dest);
    this.music = ctx.createGain();
    this.music.connect(this.master);
    this.cueBus = ctx.createGain();
    this.cueBus.connect(this.master);
    for (const p of def.parts) {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.music);
      this.partGain.set(p.id, g);
    }
    // ノイズは決まった並び（乱数を使わない。SOUND_SPEC §3）
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let x = 12345;
    for (let i = 0; i < d.length; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; d[i] = x / 0x3fffffff - 1; }
    this.kit = def.parts.find((p) => p.kit)?.kit ?? {};
    this.nextTime = ctx.currentTime + 0.05;
  }

  /** 次の切り替えの頭で使う音の状態 */
  setState(s: SoundState): void { this.state = s; }

  /**
   * 音楽を止める（S15a: 拠点の曲の画面を離れ、次の画面が音の状態を渡すまで、無音）。パートの音量を短く絞り、予約をやめる。
   * 次に setState されたら、パートの出入りを最初から当て直す（cur を捨てる）
   */
  silence(): void {
    this.state = null;
    this.cur = null;
    const t = this.ctx.currentTime;
    const tau = Math.max(0.005, this.def.fade / 3);
    for (const g of this.partGain.values()) {
      g.gain.cancelScheduledValues(t);
      g.gain.setTargetAtTime(0, t, tau);
    }
  }

  /** 音楽・合図を出すか（バスの音量で。切っても予約は続けるので、入れ直すと位置がずれない） */
  setBus(which: 'music' | 'cues', on: boolean): void {
    const g = (which === 'music' ? this.music : this.cueBus).gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(on ? 1 : 0, t, 0.05);
  }

  /** until（AudioContext の時刻）まで音楽を予約する */
  advance(until: number): void {
    if (!this.state) return;
    // 遅れて呼ばれたら、過ぎた分は飛ばす（タブが裏にあった等）
    if (this.nextTime < this.ctx.currentTime - 0.5) this.nextTime = this.ctx.currentTime + 0.05;
    while (this.nextTime < until) this.scheduleTick(this.nextTime);
    const old = this.ctx.currentTime - 0.2;
    this.voices = this.voices.filter((v) => v.end > old);
    this.beats = this.beats.filter((b) => b > old);
  }

  /** 合図を鳴らす（定義に無い合図は鳴らさない）。start が beat なら次の拍の頭で */
  cue(name: string): void {
    const c = this.def.cues[name];
    if (!c) return;
    let t0 = this.ctx.currentTime + 0.02;
    if (c.start === 'beat') {
      const next = this.beats.find((b) => b > t0);
      if (next !== undefined) t0 = next;
    }
    const scale = this.scaleDef();
    const gain = c.gain ?? 0.4;
    for (const n of c.notes) {
      if (n.at >= MAX_CUE_SEC) continue;
      const t = t0 + n.at;
      if (n.hit) this.hit(n.hit, t, gain * (n.vel ?? 1), this.cueBus, 'cue');
      else {
        const degs = [n.degree ?? 1].flat();
        for (const deg of degs) {
          const len = Math.min(n.len ?? 0.2, MAX_CUE_SEC - n.at);
          this.tone(c.voice ?? {}, degreeToFreq(scale, deg, (c.octave ?? 0) + (n.oct ?? 0)), t, len, (gain * (n.vel ?? 1)) / Math.sqrt(degs.length), this.cueBus, 'cue');
        }
      }
    }
  }

  info(): EngineInfo {
    const now = this.ctx.currentTime;
    return {
      tick: this.tick, scale: this.cur?.scale ?? '', tempo: this.cur?.tempo ?? 1,
      parts: this.cur ? Object.entries(this.cur.parts).filter(([, p]) => p.on).map(([id, p]) => `${id}:${p.pattern ?? '-'}`) : [],
      voices: this.voices.filter((v) => v.start <= now && v.end > now).length, stolen: this.stolen,
    };
  }

  /** 鳴っている音を止めて、つながりを外す */
  dispose(): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices) { try { v.src.stop(t); } catch { /* 既に止まっている */ } }
    this.voices = [];
    this.master.disconnect();
  }

  // ---- 内部 ----

  private scaleDef(): ScaleDef {
    return this.def.scales[this.cur?.scale ?? ''] ?? Object.values(this.def.scales)[0];
  }

  private applyState(t: number): void {
    if (!this.state) return;
    const r = resolveSound(this.def, this.state);
    const tau = Math.max(0.005, this.def.fade / 3);
    for (const p of this.def.parts) {
      const ps = r.parts[p.id];
      const target = ps.on ? (p.gain ?? 1) * ps.gain : 0;
      const before = this.cur ? (this.cur.parts[p.id].on ? (p.gain ?? 1) * this.cur.parts[p.id].gain : 0) : -1;
      if (target === before) continue;
      const g = this.partGain.get(p.id)!.gain;
      g.cancelScheduledValues(t);
      g.setTargetAtTime(target, t, tau);
    }
    this.cur = r;
  }

  private scheduleTick(t: number): void {
    const beats = this.def.tempo.beats;
    const unit = this.def.quantize === 'bar' ? TICKS * beats : TICKS;
    if (!this.cur || this.tick % unit === 0) this.applyState(t);
    const cur = this.cur!;
    const spb = 60 / (this.def.tempo.bpm * cur.tempo);
    if (this.tick % TICKS === 0) this.beats.push(t);
    for (const p of this.def.parts) {
      const ps = cur.parts[p.id];
      if (!ps.on || !ps.pattern) continue;
      const pat = this.def.patterns[ps.pattern];
      if (!pat) continue;
      const dest = this.partGain.get(p.id)!;
      for (const n of notesAt(pat, this.tick, beats, ps.density)) this.playNote(n, p.voice, ps.voice, (p.octave ?? 0) + ps.octave, t, spb, dest);
    }
    this.nextTime = t + spb / TICKS;
    this.tick++;
  }

  private playNote(n: NoteDef, base: VoiceDef | undefined, over: VoiceDef, octave: number, t: number, spb: number, dest: AudioNode): void {
    const vel = n.vel ?? 1;
    if (n.hit) { this.hit(n.hit, t, vel, dest, 'music'); return; }
    const degs = [n.degree ?? 1].flat();
    for (const deg of degs) this.tone({ ...base, ...over }, degreeToFreq(this.scaleDef(), deg, octave + (n.oct ?? 0)), t, (n.len ?? 1) * spb, vel / Math.sqrt(degs.length), dest, 'music');
  }

  /** 新しい音の枠を取る（上限を超えるなら、ほかの音を早めに止める） */
  private reserve(start: number, holdEnd: number, end: number, kind: 'music' | 'cue'): VoiceSlot {
    const slot: VoiceSlot = { id: this.nextId++, start, holdEnd, end, kind };
    for (const s of planSteals(this.voices, slot, MAX_VOICES)) {
      const v = s.victim as Live;
      const g = v.gain.gain as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(s.at); else g.cancelScheduledValues(s.at);
      g.setTargetAtTime(0, s.at, STEAL_FADE);
      try { v.src.stop(s.at + STEAL_STOP); } catch { /* 既に止まっている */ }
      v.end = s.at;
      v.holdEnd = Math.min(v.holdEnd, s.at);
      this.stolen++;
    }
    return slot;
  }

  private tone(voice: VoiceDef, freq: number, t: number, dur: number, level: number, dest: AudioNode, kind: 'music' | 'cue'): void {
    const a = voice.attack ?? 0.01, d = voice.decay ?? 0.1, s = voice.sustain ?? 0.7, r = voice.release ?? 0.1;
    const hold = Math.max(dur, 0.01);
    const slot = this.reserve(t, t + hold, t + hold + r, kind);
    const o = this.ctx.createOscillator();
    o.type = voice.wave && voice.wave !== 'noise' ? voice.wave : 'sine';
    o.frequency.value = freq;
    const g = this.ctx.createGain();
    let node: AudioNode = o;
    if (voice.highpass) { const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = voice.highpass; node.connect(f); node = f; }
    if (voice.lowpass) { const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = voice.lowpass; node.connect(f); node = f; }
    node.connect(g);
    g.connect(dest);
    const p = g.gain;
    p.setValueAtTime(0, t);
    if (hold <= a) p.linearRampToValueAtTime((level * hold) / a, t + hold);
    else {
      p.linearRampToValueAtTime(level, t + a);
      const sus = level * s;
      if (hold <= a + d) p.linearRampToValueAtTime(level + ((sus - level) * (hold - a)) / d, t + hold);
      else { p.linearRampToValueAtTime(sus, t + a + d); p.setValueAtTime(sus, t + hold); }
    }
    p.linearRampToValueAtTime(0, t + hold + r);
    o.start(t);
    o.stop(t + hold + r + 0.02);
    this.voices.push({ ...slot, gain: g, src: o });
  }

  private hit(name: string, t: number, level: number, dest: AudioNode, kind: 'music' | 'cue'): void {
    const v = this.kit[name];
    if (!v) return;
    const a = v.attack ?? 0.002, d = v.decay ?? 0.1;
    const slot = this.reserve(t, t + a, t + a + d, kind);
    const g = this.ctx.createGain();
    g.connect(dest);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
    let src: AudioScheduledSourceNode;
    if (v.wave === 'noise') {
      const b = this.ctx.createBufferSource();
      b.buffer = this.noise;
      b.loop = true;
      let node: AudioNode = b;
      if (v.highpass) { const f = this.ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = v.highpass; node.connect(f); node = f; }
      if (v.lowpass) { const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = v.lowpass; node.connect(f); node = f; }
      node.connect(g);
      src = b;
    } else {
      const o = this.ctx.createOscillator();
      o.type = v.wave ?? 'sine';
      const f0 = v.freq ?? 80;
      o.frequency.setValueAtTime(f0 * 2, t);
      o.frequency.exponentialRampToValueAtTime(f0, t + 0.03);
      o.connect(g);
      src = o;
    }
    src.start(t);
    src.stop(t + a + d + 0.02);
    this.voices.push({ ...slot, gain: g, src });
  }
}

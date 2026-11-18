// 音のテーマの定義（sound.json）の形と読み方（docs/SOUND_SPEC.md §5・§12）。Web Audio に触れない純粋な部分。
// 形は音の担当の仮の形（SOUND_DIRECTION.md §9・§17）をそのまま「形の版 1」とした。知らない項目は無視する。
import type { SoundState } from '@muse/shared';

/** 合成音の作り。wave の noise は打楽器（kit）だけ。freq は打楽器の高さ（Hz） */
export interface VoiceDef {
  wave?: 'sine' | 'square' | 'triangle' | 'sawtooth' | 'noise';
  attack?: number; decay?: number; sustain?: number; release?: number;
  lowpass?: number; highpass?: number; freq?: number;
}
/** 型の 1 音。at・len は拍（合図では秒）。degree は 1 始まり（8 以上は上のオクターブ、配列なら和音）。hit は打楽器の音の名前 */
export interface NoteDef {
  at: number; degree?: number | number[]; len?: number; oct?: number; vel?: number; lvl?: number;
  only?: { every: number; phase: number }; hit?: string;
}
export interface PatternDef { bars: number; notes: NoteDef[] }
export interface PartDef { id: string; role?: string; octave?: number; gain?: number; voice?: VoiceDef; kit?: Record<string, VoiceDef> }
/** 規則がパートに書けること（項目ごとに上書き。voice も項目ごと） */
export interface PartSet { on?: boolean; pattern?: string; density?: number; octave?: number; gain?: number; voice?: VoiceDef }
export interface RuleDef { when?: Record<string, unknown>; set?: { scale?: string; tempo?: number; parts?: Record<string, PartSet> } }
export interface CueDef { start?: 'now' | 'beat'; gain?: number; octave?: number; voice?: VoiceDef; notes: NoteDef[] }
export interface ScaleDef { root: string; steps: number[] }
export interface SoundDef {
  id?: string;
  formatVersion?: number;
  tempo: { bpm: number; beats: number };
  quantize: 'beat' | 'bar';
  fade: number;
  scales: Record<string, ScaleDef>;
  parts: PartDef[];
  patterns: Record<string, PatternDef>;
  rules: RuleDef[];
  cues: Record<string, CueDef>;
}

/** 上限（SOUND_SPEC §6） */
export const MAX_PARTS = 6;
export const MAX_VOICES = 16;
/** 合図の長さの上限（秒。SOUND_SPEC §4） */
export const MAX_CUE_SEC = 1.5;
/** テンポの倍率の幅（SOUND_SPEC §3） */
export const TEMPO_MIN = 0.75;
export const TEMPO_MAX = 1.5;
/** 1 拍を 4 つに刻む（16 分）。型の at はこの格子に丸める */
export const TICKS = 4;

const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** 音名（D3・Bb2・C#3）を MIDI の番号へ。読めなければ null */
export function noteToMidi(name: string): number | null {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1] as 'C'] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return base + 12 * (Number(m[3]) + 1);
}

/** 音階の度数（1 始まり。8 以上・0 以下はオクターブをまたぐ）を周波数へ */
export function degreeToFreq(scale: ScaleDef, degree: number, octave: number): number {
  const i = Math.round(degree) - 1;
  const n = scale.steps.length;
  const midi = (noteToMidi(scale.root) ?? 62) + scale.steps[((i % n) + n) % n] + 12 * (Math.floor(i / n) + octave);
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * sound.json を読む。形が壊れていれば Error。直せるもの（7 つ目からのパート・壊れた音・知らない項目）は捨てて warnings に書く。
 * formatVersion は 0（仮の形）と 1 を同じに読む
 */
export function parseSoundDef(raw: unknown): { def: SoundDef; warnings: string[] } {
  const w: string[] = [];
  if (!raw || typeof raw !== 'object') throw new Error('sound.json is not an object');
  const r = raw as Record<string, unknown>;
  const fv = r.formatVersion;
  if (fv !== undefined && fv !== 0 && fv !== 1) throw new Error(`unsupported formatVersion ${String(fv)}`);
  const tempo = r.tempo as { bpm?: unknown; beats?: unknown } | undefined;
  if (!tempo || !num(tempo.bpm) || tempo.bpm <= 0) throw new Error('tempo.bpm is missing');
  const beats = num(tempo.beats) && tempo.beats > 0 ? Math.round(tempo.beats) : 4;
  const scales: Record<string, ScaleDef> = {};
  for (const [k, v] of Object.entries((r.scales ?? {}) as Record<string, { root?: unknown; steps?: unknown }>)) {
    if (typeof v?.root !== 'string' || noteToMidi(v.root) === null || !Array.isArray(v.steps) || !v.steps.length || !v.steps.every(num)) { w.push(`scale ${k} ignored`); continue; }
    scales[k] = { root: v.root, steps: v.steps as number[] };
  }
  if (!Object.keys(scales).length) throw new Error('no usable scale');
  const parts: PartDef[] = [];
  for (const p of (Array.isArray(r.parts) ? r.parts : []) as PartDef[]) {
    if (!p || typeof p.id !== 'string') { w.push('a part without id ignored'); continue; }
    if (parts.length >= MAX_PARTS) { w.push(`part ${p.id} ignored (more than ${MAX_PARTS} parts)`); continue; }
    parts.push(p);
  }
  const patterns: Record<string, PatternDef> = {};
  for (const [k, v] of Object.entries((r.patterns ?? {}) as Record<string, PatternDef>)) {
    if (!v || !num(v.bars) || v.bars <= 0 || !Array.isArray(v.notes)) { w.push(`pattern ${k} ignored`); continue; }
    patterns[k] = { bars: Math.round(v.bars), notes: v.notes.filter((n) => n && num(n.at) && (n.hit !== undefined || n.degree !== undefined)) };
  }
  const cues: Record<string, CueDef> = {};
  for (const [k, v] of Object.entries((r.cues ?? {}) as Record<string, CueDef>)) {
    if (!v || !Array.isArray(v.notes)) { w.push(`cue ${k} ignored`); continue; }
    cues[k] = { ...v, notes: v.notes.filter((n) => n && num(n.at) && n.at < MAX_CUE_SEC && (n.hit !== undefined || n.degree !== undefined)) };
  }
  const rules = (Array.isArray(r.rules) ? r.rules : []).filter((x): x is RuleDef => !!x && typeof x === 'object');
  return {
    def: {
      ...(typeof r.id === 'string' ? { id: r.id } : {}), ...(num(fv) ? { formatVersion: fv } : {}),
      tempo: { bpm: tempo.bpm, beats }, quantize: r.quantize === 'bar' ? 'bar' : 'beat', fade: num(r.fade) && r.fade >= 0 ? r.fade : 0.3,
      scales, parts, patterns, rules, cues,
    },
    warnings: w,
  };
}

/** 規則の when が知っている入力（音の状態と depth_band） */
const INPUTS = new Set<string>(['scene', 'threat', 'hp', 'depth_band', 'depth_tier', 'biome', 'floor_kind', 'telegraph', 'sense', 'stake', 'ailment', 'boost']);

/** 条件の 1 項目: 値、値の並び（どれか）、または { min, mod, rem }（数の入力。min 以上で、mod で割った余りが rem） */
export function matchCond(cond: unknown, x: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    const c = cond as { min?: unknown; max?: unknown; mod?: unknown; rem?: unknown };
    if (!num(x)) return false;
    if (num(c.min) && x < c.min) return false;
    if (num(c.max) && x > c.max) return false;
    if (num(c.mod) && c.mod > 0 && ((x % c.mod) + c.mod) % c.mod !== (num(c.rem) ? c.rem : 0)) return false;
    return true;
  }
  return (Array.isArray(cond) ? cond : [cond]).includes(x);
}

/** 規則の when が当てはまるか。項目は「かつ」。知らない入力を条件に持つ規則は当てない（新しいテーマを古い画面で鳴らしても、誤って当たらない） */
export function matchWhen(when: Record<string, unknown> | undefined, s: SoundState): boolean {
  for (const [k, v] of Object.entries(when ?? {})) {
    if (!INPUTS.has(k)) return false;
    if (!matchCond(v, (s as unknown as Record<string, unknown>)[k])) return false;
  }
  return true;
}

export interface ResolvedPart { on: boolean; pattern: string | null; density: number; octave: number; gain: number; voice: VoiceDef }
export interface Resolved { scale: string; tempo: number; parts: Record<string, ResolvedPart> }

/** 音の状態に規則を上から当てる（後の規則が、書いた項目だけを上書きする）。パートの既定は 切・密度 2・オクターブ 0・音量 1 */
export function resolveSound(def: SoundDef, s: SoundState): Resolved {
  const out: Resolved = { scale: Object.keys(def.scales)[0], tempo: 1, parts: {} };
  for (const p of def.parts) out.parts[p.id] = { on: false, pattern: null, density: 2, octave: 0, gain: 1, voice: {} };
  for (const rule of def.rules) {
    if (!matchWhen(rule.when, s)) continue;
    const set = rule.set ?? {};
    if (typeof set.scale === 'string' && def.scales[set.scale]) out.scale = set.scale;
    if (num(set.tempo)) out.tempo = set.tempo;
    for (const [id, pv] of Object.entries(set.parts ?? {})) {
      const cur = out.parts[id];
      if (!cur || !pv) continue;
      if (typeof pv.on === 'boolean') cur.on = pv.on;
      if (typeof pv.pattern === 'string') cur.pattern = pv.pattern;
      if (num(pv.density)) cur.density = pv.density;
      if (num(pv.octave)) cur.octave = pv.octave;
      if (num(pv.gain)) cur.gain = pv.gain;
      if (pv.voice && typeof pv.voice === 'object') cur.voice = { ...cur.voice, ...pv.voice };
    }
  }
  out.tempo = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, out.tempo));
  return out;
}

/**
 * 型の中で、通しの 16 分の位置 tick に鳴る音（密度と「N 回に 1 回」で絞る）。
 * 型は通しの位置から読む（切り替えても頭からやり直さない）。rep は型の繰り返しの回数
 */
export function notesAt(pat: PatternDef, tick: number, beats: number, density: number): NoteDef[] {
  const total = pat.bars * beats * TICKS;
  const pos = tick % total;
  const rep = Math.floor(tick / total);
  return pat.notes.filter((n) => Math.round(n.at * TICKS) === pos && (n.lvl ?? 1) <= density
    && !(n.only && n.only.every > 0 && rep % n.only.every !== n.only.phase));
}

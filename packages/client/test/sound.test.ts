// 鳴らす仕組みの確認（docs/SOUND_SPEC.md §4・§6・§12）: 定義の読み方（hollow の sound.json）、規則の当て方、
// 同時に鳴る音の上限（場面を切り替えた直後の余韻を含めて 16 を超えない）。Web Audio は偽物の AudioContext で数える。
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { SoundState } from '@muse/shared';
import { hubSoundState } from '@muse/shared';
import { degreeToFreq, matchCond, MAX_VOICES, notesAt, parseSoundDef, resolveSound } from '../src/sound/def';
import { SoundDirector } from '../src/sound/director';
import { SoundEngine } from '../src/sound/engine';
import { liveAt, planSteals, type VoiceSlot } from '../src/sound/voices';

const hollow = JSON.parse(readFileSync(new URL('../public/themes/hollow/sound.json', import.meta.url), 'utf-8')) as unknown;
const base: SoundState = { scene: 'explore', threat: 0, hp: 'healthy', depth_band: 0, depth_tier: 0, biome: 'core:stone_halls', floor_kind: 'standard', telegraph: false, sense: 'none', stake: 0, ailment: false, boost: false };

describe('sound definition (format 1)', () => {
  it('reads hollow without warnings; parts within the limit', () => {
    const { def, warnings } = parseSoundDef(hollow);
    expect(warnings).toEqual([]);
    expect(def.parts.length).toBeLessThanOrEqual(6);
    expect(def.quantize).toBe('beat');
    expect(Object.keys(def.scales)).toContain('abyss_b');
    expect(() => parseSoundDef({ tempo: {} })).toThrow();
    expect(() => parseSoundDef({ ...(hollow as object), formatVersion: 9 })).toThrow();
    // 知らない項目は無視する。7 つ目からのパートは捨てる
    const many = { ...(hollow as object), extra: 1, parts: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, voice: { wave: 'sine' } })) };
    const r = parseSoundDef(many);
    expect(r.def.parts.length).toBe(6);
    expect(r.warnings.length).toBe(2);
  });

  it('applies rules top to bottom, overriding only the fields written; voice per field', () => {
    const { def } = parseSoundDef(hollow);
    const camp = resolveSound(def, { ...base, scene: 'camp' });
    expect(camp.scale).toBe('light');
    expect(camp.tempo).toBe(0.8);
    expect(resolveSound(def, { ...base, depth_band: 3, depth_tier: 4 }).scale).toBe('abyss_b');
    expect(resolveSound(def, { ...base, depth_band: 3, depth_tier: 7 }).scale).toBe('abyss');
    expect(resolveSound(def, { ...base, depth_band: 2, depth_tier: 2 }).scale).toBe('deep');
    const ruins = resolveSound(def, { ...base, biome: 'core:overgrown_ruins' });
    expect(ruins.parts.lead.voice.wave).toBe('triangle');
    expect(ruins.parts.lead.gain).toBe(1.5);
    expect(resolveSound(def, { ...base, biome: 'core:unknown' }).parts.lead.voice).toEqual({});
    expect(resolveSound(def, { ...base, hp: 'near_death' }).parts.pad.on).toBe(false);
    expect(resolveSound(def, { ...base, telegraph: true }).parts.pad.pattern).toBe('pad_poise');
    expect(resolveSound(def, { ...base, scene: 'warden', threat: 3 }).tempo).toBeLessThanOrEqual(1.5);
    // 知らない入力を条件に持つ規則は当てない。テンポの倍率は 0.75〜1.5 に収める
    const odd = resolveSound({ ...def, rules: [...def.rules, { when: { weather: 'rain' }, set: { tempo: 1.2 } }, { when: {}, set: { tempo: 3 } }] }, base);
    expect(odd.tempo).toBe(1.5);
    const odd2 = resolveSound({ ...def, rules: [...def.rules, { when: { weather: 'rain' }, set: { tempo: 1.2 } }] }, base);
    expect(odd2.tempo).toBe(1);
  });

  it('S15: the hub scene (a provisional tune) is built from the camp tune, a little quieter and slower, with no drums', () => {
    const { def } = parseSoundDef(hollow);
    const hub = resolveSound(def, hubSoundState());
    const camp = resolveSound(def, { ...hubSoundState(), scene: 'camp' });
    expect(hubSoundState()).toMatchObject({ scene: 'hub', threat: 0, depth_band: 0, depth_tier: 0, biome: 'none', floor_kind: 'other', sense: 'none', stake: 0 });
    expect(hub.scale).toBe('light');
    expect(hub.tempo).toBeLessThan(camp.tempo);
    for (const p of ['bass', 'pad', 'lead'] as const) {
      expect(hub.parts[p].on).toBe(true);
      expect(hub.parts[p].pattern).toBe(camp.parts[p].pattern);
      expect(hub.parts[p].gain).toBeLessThan(camp.parts[p].gain);
    }
    expect(hub.parts.perc.on).toBe(false);
    expect(hub.parts.glint.on).toBe(false);
  });

  it('conditions, degrees and pattern positions', () => {
    expect(matchCond({ min: 4, mod: 4, rem: 0 }, 8)).toBe(true);
    expect(matchCond({ min: 4, mod: 4, rem: 0 }, 0)).toBe(false);
    expect(matchCond({ min: 4, mod: 4, rem: 1 }, 5)).toBe(true);
    expect(matchCond(['camp', 'explore'], 'explore')).toBe(true);
    expect(matchCond(true, true)).toBe(true);
    const d = { root: 'D3', steps: [0, 2, 3, 5, 7, 9, 10] };
    expect(degreeToFreq(d, 1, 0)).toBeCloseTo(146.83, 1);
    expect(degreeToFreq(d, 8, 0)).toBeCloseTo(293.66, 1);
    expect(degreeToFreq(d, 1, -1)).toBeCloseTo(73.42, 1);
    const pat = { bars: 1, notes: [{ at: 0, degree: 1 }, { at: 1.5, degree: 2, lvl: 2 }, { at: 2, degree: 3, only: { every: 2, phase: 1 } }] };
    expect(notesAt(pat, 0, 4, 2).length).toBe(1);
    expect(notesAt(pat, 6, 4, 1).length).toBe(0);
    expect(notesAt(pat, 6, 4, 2).length).toBe(1);
    expect(notesAt(pat, 8, 4, 2).length).toBe(0);
    expect(notesAt(pat, 16 + 8, 4, 2).length).toBe(1);
  });
});

describe('voice budget', () => {
  it('steals released music first, then older music; cues last', () => {
    const v = (id: number, start: number, holdEnd: number, end: number, kind: 'music' | 'cue' = 'music'): VoiceSlot => ({ id, start, holdEnd, end, kind });
    const live = [v(1, 0, 0.5, 2), v(2, 0.2, 3, 3), v(3, 0.1, 3, 3, 'cue')];
    const s = planSteals(live, v(9, 1, 1.2, 1.4), 3);
    expect(s.map((x) => x.victim.id)).toEqual([1]);
    expect(s[0].at).toBe(1);
    const s2 = planSteals([v(2, 0.2, 3, 3), v(3, 0.1, 3, 3, 'cue'), v(4, 0, 3, 3, 'cue')], v(9, 1, 1.2, 1.4), 3);
    expect(s2.map((x) => x.victim.id)).toEqual([2]);
    // 新しい音が鳴る間に、後から鳴り始める音の時点でも数える
    const s3 = planSteals([v(5, 0, 3, 3), v(6, 0.5, 3, 3)], v(9, 0.2, 1, 1.2), 2);
    expect(s3.map((x) => [x.victim.id, x.at])).toEqual([[5, 0.5]]);
    expect(liveAt(live, 1)).toBe(3);
  });
});

/** 数えるだけの偽物の AudioContext（時刻は手で進める） */
class FakeParam {
  value = 0;
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime() { return this; }
  cancelScheduledValues() { return this; }
  cancelAndHoldAtTime() { return this; }
}
class FakeNode { connect(n: unknown) { return n; } disconnect() { /* */ } }
class FakeSource extends FakeNode {
  startT = Number.NaN;
  stops: number[] = [];
  frequency = new FakeParam();
  type = '';
  buffer: unknown = null;
  loop = false;
  start(t: number) { this.startT = t; }
  stop(t: number) { this.stops.push(t); }
}
function fakeContext() {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 0, sampleRate: 8000, destination: new FakeNode(),
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createOscillator: () => { const s = new FakeSource(); sources.push(s); return s; },
    createBufferSource: () => { const s = new FakeSource(); sources.push(s); return s; },
    createBiquadFilter: () => Object.assign(new FakeNode(), { type: '', frequency: new FakeParam() }),
    createBuffer: (_c: number, n: number) => ({ getChannelData: () => new Float32Array(n) }),
  };
  return { ctx, sources };
}

/** 聞こえている間（止めの予約の余白を除く）が重なる数の最大 */
function maxOverlap(sources: FakeSource[]): number {
  const pts: [number, number][] = [];
  for (const s of sources) {
    if (Number.isNaN(s.startT) || !s.stops.length) continue;
    // 1 度目の止めは鳴り終わり + 0.02、2 度目（上限のために早めに止めた）は止めた時刻 + 0.04
    const end = s.stops.length > 1 ? Math.min(...s.stops) - 0.04 : s.stops[0] - 0.02;
    if (end <= s.startT) continue;
    pts.push([s.startT, 1], [end, -1]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0;
  for (const [, d] of pts) { cur += d; max = Math.max(max, cur); }
  return max;
}

describe('sound engine (Web Audio, faked)', () => {
  it('never has more than 16 voices at once, also right after scene switches with cues on top', () => {
    const { def } = parseSoundDef(hollow);
    const { ctx, sources } = fakeContext();
    const eng = new SoundEngine(ctx as unknown as BaseAudioContext, def, ctx.destination as unknown as AudioNode);
    const states: Partial<SoundState>[] = [
      { scene: 'camp', biome: 'none', floor_kind: 'other' }, { scene: 'explore' }, { scene: 'warden', threat: 3, sense: 'near' }, { scene: 'explore', hp: 'badly_wounded' },
      { scene: 'combat', threat: 3, telegraph: true }, { scene: 'guardian', threat: 2 }, { scene: 'alert', floor_kind: 'warden_hall' }, { scene: 'warden', threat: 3, depth_band: 3, depth_tier: 5 },
      { scene: 'camp', biome: 'none', floor_kind: 'other' }, { scene: 'combat', threat: 3, biome: 'core:sunken_archive' }, { scene: 'ended' },
    ];
    let k = 0;
    for (let t = 0; t < 110; t = Math.round((t + 0.05) * 100) / 100) {
      ctx.currentTime = t;
      if (Math.abs(t % 10) < 1e-9) eng.setState({ ...base, ...states[k++ % states.length] });
      // 切り替えの直後に合図を重ねる
      if (Math.abs((t % 10) - 0.5) < 1e-9) for (const c of ['hit_taken', 'crit_dealt', 'crit_taken', 'kill', 'level_up', 'objective', 'death']) eng.cue(c);
      eng.advance(t + 0.2);
    }
    expect(sources.length).toBeGreaterThan(500);
    expect(maxOverlap(sources)).toBeLessThanOrEqual(MAX_VOICES);
    // 上限のために早めに止めた音がある（間引きが働いた）
    expect(eng.stolen).toBeGreaterThan(0);
  });

  it('hollow has a provisional stairs cue: short (up to 0.5 s), 2-3 falling notes, quieter than the other cues; it sounds (S9a §57.3 の 3)', () => {
    const { def } = parseSoundDef(hollow);
    const c = def.cues.stairs;
    expect(c).toBeDefined();
    const notes = c.notes.filter((n) => n.degree !== undefined);
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.length).toBeLessThanOrEqual(3);
    const deg = notes.map((n) => (typeof n.degree === 'number' ? n.degree : 0));
    for (let i = 1; i < deg.length; i++) expect(deg[i]).toBeLessThan(deg[i - 1]);
    const end = Math.max(...c.notes.map((n) => n.at + (n.len ?? 0))) + (c.voice?.release ?? 0);
    expect(end).toBeLessThanOrEqual(0.5);
    for (const [k, o] of Object.entries(def.cues)) if (k !== 'stairs') expect(c.gain!).toBeLessThan(o.gain!);
    const { ctx, sources } = fakeContext();
    const eng = new SoundEngine(ctx as unknown as BaseAudioContext, def, ctx.destination as unknown as AudioNode);
    eng.setState(base);
    eng.advance(0.1);
    const before = sources.length;
    eng.cue('stairs');
    expect(sources.length - before).toBe(notes.length);
  });

  it('S16a: hollow has a provisional foe_down cue: short, quieter than kill, within the 16-voice limit; it sounds', () => {
    const { def } = parseSoundDef(hollow);
    const c = def.cues.foe_down;
    expect(c).toBeDefined();
    expect(c.gain!).toBeLessThan(def.cues.kill.gain!);
    const end = Math.max(...c.notes.map((n) => n.at + (n.len ?? 0))) + (c.voice?.release ?? 0);
    expect(end).toBeLessThanOrEqual(0.6);
    const { ctx, sources } = fakeContext();
    const eng = new SoundEngine(ctx as unknown as BaseAudioContext, def, ctx.destination as unknown as AudioNode);
    eng.setState(base);
    eng.advance(0.1);
    const before = sources.length;
    eng.cue('foe_down');
    expect(sources.length - before).toBe(c.notes.length);
  });

  it('S15a: silence stops scheduling music until the next state; the parts come back in on the next state', () => {
    const { def } = parseSoundDef(hollow);
    const { ctx, sources } = fakeContext();
    const eng = new SoundEngine(ctx as unknown as BaseAudioContext, def, ctx.destination as unknown as AudioNode);
    eng.setState(hubSoundState());
    ctx.currentTime = 0;
    eng.advance(2);
    expect(eng.info().parts.length).toBeGreaterThan(0);
    eng.silence();
    const n = sources.length;
    ctx.currentTime = 2;
    eng.advance(6);
    expect(sources.length).toBe(n);
    expect(eng.info().parts).toEqual([]);
    eng.setState({ ...base, scene: 'combat' });
    eng.advance(8);
    expect(sources.length).toBeGreaterThan(n);
    expect(eng.info().parts.some((p) => p.startsWith('bass:bass_combat'))).toBe(true);
  });

  it('S15a: leaving a hub screen stops the hub tune after a short wait, unless another hub screen opens first or the next screen gives its own state', () => {
    vi.useFakeTimers();
    try {
      const d = new SoundDirector();
      d.hub();
      expect(d.snapshot().state?.scene).toBe('hub');
      // 拠点 → 支度（拠点の曲どうし）: 止めない
      d.leaveHub();
      vi.advanceTimersByTime(100);
      d.hub();
      vi.advanceTimersByTime(5000);
      expect(d.snapshot().state?.scene).toBe('hub');
      // 拠点 → 観戦（断られて、音の状態が来ない）: 止まる（無音）
      d.leaveHub();
      vi.advanceTimersByTime(299);
      expect(d.snapshot().state?.scene).toBe('hub');
      vi.advanceTimersByTime(2);
      expect(d.snapshot().state).toBeNull();
      expect(d.snapshot().heard).toBeNull();
      // 戻ると、また鳴る
      d.hub();
      expect(d.snapshot().state?.scene).toBe('hub');
    } finally {
      vi.useRealTimers();
    }
  });

  it('S16a: the sound hint is up while a theme is on and the browser has not let it play; a click or key starts it; a later interruption brings the hint back', () => {
    const d = new SoundDirector();
    expect(d.waitingForGesture).toBe(false);
    d.settings = { ...d.settings, theme: 'hollow' };
    expect(d.waitingForGesture).toBe(true);
    class FakeCtx {
      state = 'suspended';
      onstatechange: (() => void) | null = null;
      resume() { this.state = 'running'; this.onstatechange?.(); return Promise.resolve(); }
      close() { this.state = 'closed'; return Promise.resolve(); }
    }
    const listeners: string[] = [];
    vi.stubGlobal('window', { AudioContext: FakeCtx, addEventListener: (t: string) => listeners.push(t), removeEventListener: () => undefined });
    try {
      let n = 0;
      d.subscribe(() => n++);
      d.unlock();
      expect(d.waitingForGesture).toBe(false);
      expect(d.snapshot().running).toBe(true);
      expect(n).toBeGreaterThan(0);
      // iOS の interrupted（裏のタブ・電話 など）: 札が戻り、次の操作で鳴らし直す
      const ctx = (d as unknown as { ctx: FakeCtx }).ctx;
      ctx.state = 'interrupted';
      ctx.onstatechange?.();
      expect(d.waitingForGesture).toBe(true);
      expect(listeners).toContain('pointerdown');
      expect(listeners).toContain('keydown');
      d.unlock();
      expect(d.waitingForGesture).toBe(false);
      // 読めなかったテーマ（error）では札を出さない（見出しに理由が出る）
      ctx.state = 'suspended';
      d.error = 'hollow: HTTP 404';
      expect(d.waitingForGesture).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('switches on the beat and keeps the running position (patterns are read from the global position)', () => {
    const { def } = parseSoundDef(hollow);
    const { ctx } = fakeContext();
    const eng = new SoundEngine(ctx as unknown as BaseAudioContext, def, ctx.destination as unknown as AudioNode);
    eng.setState(base);
    ctx.currentTime = 0;
    eng.advance(2);
    const t1 = eng.info().tick;
    eng.setState({ ...base, scene: 'combat' });
    eng.advance(4);
    const i = eng.info();
    expect(i.tick).toBeGreaterThan(t1);
    expect(i.parts.some((p) => p.startsWith('bass:bass_combat'))).toBe(true);
    expect(i.tempo).toBe(1.3);
  });
});

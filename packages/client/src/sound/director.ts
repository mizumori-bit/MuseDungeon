// 音の進行役（docs/SOUND_SPEC.md §4・§6・§12）。画面（遊ぶ・観戦・リプレイ）は、届いた視界と出来事を update に渡すだけ。
// 拠点・支度・記録・運用・シーズンの結果の画面は、hub（S15）で、決まった音の状態（場面 hub）を渡す。
// - 既定は無音。音を出すのは、利用者が画面で音のテーマを選んだときだけ（ブラウザも操作なしの再生を許さない）。設定は端末に覚える。
// - 音の状態は shared の soundStep（視界と届いた出来事だけから作る）。場面が 1 秒より短く行って戻るときは切り替えない。
// - 同じ合図が 0.15 秒以内に重なったら 1 つにまとめる。画面を開いた最初の視界（それまでの出来事がまとめて届く）では合図を鳴らさない。
import type { Catalog, PlayerView, ProjectedEvent, SoundCue, SoundMemory, SoundState } from '@muse/shared';
import { hubSoundState, soundStep } from '@muse/shared';
import { getPref, setPref } from '../util';
import { parseSoundDef, type SoundDef } from './def';
import { SoundEngine, type EngineInfo } from './engine';

export interface SoundSettings {
  /** 音のテーマの ID。'none' は無音 */
  theme: string;
  /** 0〜1 */
  volume: number;
  music: boolean;
  cues: boolean;
}
export interface SoundThemeInfo { id: string; name: string }

/** 場面が行って戻るとき、切り替えない長さ（SOUND_SPEC §4） */
const SCENE_HOLD_MS = 1000;
/** 同じ合図をまとめる長さ（SOUND_SPEC §4） */
const CUE_MERGE_MS = 150;
/** 予約の先読み（秒）と、予約の間隔（ミリ秒） */
const LOOKAHEAD = 0.2;
const TICK_MS = 50;
/** 拠点の曲の画面を離れてから、止めるまでの待ち（次の画面が開く間。拠点の曲どうしの画面なら、その間に取りやめる） */
const HUB_GRACE_MS = 300;
const BASE = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';

type Ctor = typeof AudioContext;

function readSettings(): SoundSettings {
  let s: Partial<SoundSettings> = {};
  try { s = JSON.parse(getPref('sound', '{}')) as Partial<SoundSettings>; } catch { /* 壊れていれば既定 */ }
  return {
    theme: typeof s.theme === 'string' ? s.theme : 'none',
    volume: typeof s.volume === 'number' && s.volume >= 0 && s.volume <= 1 ? s.volume : 0.6,
    music: s.music !== false,
    cues: s.cues !== false,
  };
}

export class SoundDirector {
  settings: SoundSettings = readSettings();
  themes: SoundThemeInfo[] = [];
  error: string | null = null;
  private def: SoundDef | null = null;
  private defId: string | null = null;
  private ctx: AudioContext | null = null;
  private engine: SoundEngine | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private memory: SoundMemory | null = null;
  private stream: string | null = null;
  private latest: SoundState | null = null;
  private committed: SoundState | null = null;
  private pending: { scene: SoundState['scene']; since: number } | null = null;
  private readonly lastCue = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private gestureHooked = false;
  /** 拠点の曲を止めるまでの待ち（S15a。leaveHub） */
  private hubTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    void this.listThemes();
    if (this.settings.theme !== 'none') {
      void this.loadDef(this.settings.theme);
      this.hookGesture();
    }
  }

  /** 設定と状態が変わったら呼ばれる（設定の画面の再描画） */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  /** 画面の操作から呼ぶ（ブラウザは操作の中でしか音を始めさせない） */
  set(patch: Partial<SoundSettings>): void {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    setPref('sound', JSON.stringify(this.settings));
    if (this.settings.theme !== before.theme) {
      if (this.settings.theme === 'none') this.stopAudio();
      else { this.ensureContext(); void this.loadDef(this.settings.theme); }
    } else if (this.settings.theme !== 'none') this.ensureContext();
    this.applyMix();
    this.emit();
  }

  /**
   * 届いた視界と出来事を渡す（遊ぶ画面は届くたび、観戦・リプレイは追う相手の視界が変わるたび）。
   * quiet: 合図を鳴らさない（巻き戻しで飛んだとき・画面を開いた最初）
   */
  update(view: PlayerView, events: readonly ProjectedEvent[], catalog: Catalog | null, opts: { quiet?: boolean } = {}): void {
    if (!catalog) return;
    const key = `${view.runId}|${view.playerId}`;
    const fresh = key !== this.stream;
    if (fresh) { this.stream = key; this.memory = null; this.committed = null; this.pending = null; }
    const step = soundStep(this.memory, view, events, catalog);
    this.memory = step.memory;
    this.latest = step.state;
    this.commit();
    if (!fresh && !opts.quiet) for (const c of step.cues) this.cue(c);
  }

  /**
   * 拠点・支度・記録・運用の画面にいる（S15。SOUND_SPEC §2.1 の hub）: 視界の無い、決まった音の状態を渡す。
   * 画面を移ったので、場面の揺れの待ち（1 秒）は使わず、次の拍の頭で替える（パートの出入りはフェード）。
   * 音を出すかどうかは今までどおり（音のテーマが「切」なら何もしない。ブラウザは、人が 1 回操作するまで鳴らさない）
   */
  hub(): void {
    // 拠点の曲どうしの画面を移った（拠点 → 支度 → 記録）: 止めるのを取りやめ、途切れずに続ける
    if (this.hubTimer) { clearTimeout(this.hubTimer); this.hubTimer = null; }
    if (this.stream === 'hub' && this.latest?.scene === 'hub') return;
    this.stream = 'hub';
    this.memory = null;
    this.committed = null;
    this.pending = null;
    this.latest = hubSoundState();
    this.commit();
  }

  /**
   * 拠点の曲の画面を離れた（S15a）: 少し待って（HUB_GRACE_MS）、その間に次の画面が音の状態を渡さず（観戦が断られた・鍵が無い・最初の見え方の前 など）、
   * 拠点の曲の画面にも戻らなければ、音楽を止める（次の画面が音の状態を渡すまで、無音）。拠点の曲どうしの画面を移るときは、hub() が取りやめる
   */
  leaveHub(): void {
    if (this.stream !== 'hub') return;
    if (this.hubTimer) clearTimeout(this.hubTimer);
    this.hubTimer = setTimeout(() => {
      this.hubTimer = null;
      if (this.stream !== 'hub') return;
      this.leave();
      this.engine?.silence();
    }, HUB_GRACE_MS);
  }

  /** 画面を離れた（次に開いた画面の最初の視界は、新しい流れとして扱う） */
  leave(): void {
    this.stream = null;
    this.memory = null;
    this.latest = null;
    this.committed = null;
    this.pending = null;
  }

  /** いま鳴らしている音の状態と、鳴らす仕組みの様子（確かめ用） */
  snapshot(): { state: SoundState | null; heard: SoundState | null; running: boolean; engine: EngineInfo | null } {
    return { state: this.latest, heard: this.committed, running: this.ctx?.state === 'running', engine: this.engine?.info() ?? null };
  }

  // ---- 内部 ----

  private emit(): void { for (const fn of this.listeners) fn(); }

  private async listThemes(): Promise<void> {
    try {
      const res = await fetch(`${BASE}themes/index.json`, { cache: 'no-cache' });
      if (!res.ok) return;
      const list = (await res.json()) as { id: string; name: string; kinds?: string[] }[];
      this.themes = list.filter((t) => t.kinds?.includes('sound')).map((t) => ({ id: t.id, name: t.name }));
      this.emit();
    } catch { /* 一覧が無ければ無音だけ */ }
  }

  private async loadDef(id: string): Promise<void> {
    try {
      const res = await fetch(`${BASE}themes/${encodeURIComponent(id)}/sound.json`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { def, warnings } = parseSoundDef(await res.json());
      if (warnings.length) console.warn(`sound theme ${id}:`, warnings);
      if (this.settings.theme !== id) return;
      this.def = def;
      this.defId = id;
      this.error = null;
      this.startEngine();
    } catch (e) {
      this.def = null;
      this.defId = null;
      this.error = `${id}: ${e instanceof Error ? e.message : String(e)}`;
      this.stopEngine();
    }
    this.emit();
  }

  /** 前に音を入れていたなら、最初の操作で音を始める（ページを開いただけでは鳴らさない） */
  private hookGesture(): void {
    if (this.gestureHooked || typeof window === 'undefined') return;
    this.gestureHooked = true;
    const on = () => {
      window.removeEventListener('pointerdown', on, true);
      window.removeEventListener('keydown', on, true);
      this.gestureHooked = false;
      if (this.settings.theme !== 'none') this.ensureContext();
    };
    window.addEventListener('pointerdown', on, true);
    window.addEventListener('keydown', on, true);
  }

  private ensureContext(): void {
    if (typeof window === 'undefined') return;
    const C = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext) as Ctor | undefined;
    if (!C) { this.error = 'Web Audio is not available'; return; }
    if (!this.ctx) {
      this.ctx = new C();
      this.ctx.onstatechange = () => this.emit();
    }
    if (this.ctx.state === 'suspended') {
      // ブラウザが操作の外だとみなしたら、次の操作で始める
      void this.ctx.resume().then(() => this.emit()).catch(() => undefined);
      if (this.ctx.state === 'suspended') this.hookGesture();
    }
    if (!this.engine) this.startEngine();
  }

  private startEngine(): void {
    if (!this.ctx || !this.def || this.defId !== this.settings.theme) return;
    this.stopEngine();
    this.engine = new SoundEngine(this.ctx, this.def, this.ctx.destination);
    this.applyMix();
    if (this.committed) this.engine.setState(this.committed);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stopEngine(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.engine?.dispose();
    this.engine = null;
  }

  private stopAudio(): void {
    this.stopEngine();
    this.def = null;
    this.defId = null;
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
  }

  private applyMix(): void {
    if (!this.engine || !this.ctx) return;
    this.engine.master.gain.setTargetAtTime(this.settings.volume, this.ctx.currentTime, 0.05);
    this.engine.setBus('music', this.settings.music);
    this.engine.setBus('cues', this.settings.cues);
  }

  private tick(): void {
    this.commit();
    if (this.engine && this.ctx?.state === 'running') this.engine.advance(this.ctx.currentTime + LOOKAHEAD);
  }

  /** 場面の揺れ（1 秒より短く行って戻る）では切り替えない。ほかの入力はすぐ渡す（切り替えは次の拍の頭） */
  private commit(): void {
    const s = this.latest;
    if (!s) return;
    const now = performance.now();
    if (!this.committed || s.scene === this.committed.scene) {
      this.pending = null;
      this.committed = s;
    } else {
      if (!this.pending || this.pending.scene !== s.scene) this.pending = { scene: s.scene, since: now };
      if (now - this.pending.since >= SCENE_HOLD_MS) { this.committed = s; this.pending = null; }
      else this.committed = { ...s, scene: this.committed.scene };
    }
    this.engine?.setState(this.committed);
  }

  private cue(name: SoundCue): void {
    if (!this.engine || !this.settings.cues || this.ctx?.state !== 'running') return;
    const now = performance.now();
    const last = this.lastCue.get(name);
    if (last !== undefined && now - last < CUE_MERGE_MS) return;
    this.lastCue.set(name, now);
    this.engine.cue(name);
  }
}

/** 画面をまたいで 1 つ（音は画面を移っても途切れない） */
export const soundDirector = new SoundDirector();
if (typeof window !== 'undefined') (window as unknown as { museSound?: SoundDirector }).museSound = soundDirector;

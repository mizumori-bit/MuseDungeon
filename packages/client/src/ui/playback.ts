// 観戦の再生の列（S13。SEASON.md §65.1）。画面（Watch.tsx）から離し、時刻は外から渡す（テストする: packages/client/test/playback.test.ts）。
// 届いた歩（プレイヤーの 1 手番ぶんの出来事と、その後の World／見え方）を、すぐには描かずに列に入れ、決まった間隔で 1 歩ずつ取り出す。
// おくれ（列のいちばん古い歩が届いてからの時間）が長くなったら間隔を縮め、もっと長ければ今の所へ飛ぶ（途中は描かない。音も鳴らさない）。
// 知らせ（AI の呼び出し・マクロ・ランの終わり）は時間を使わない「印」で、結んだ歩と一緒か、列の今の位置で出る（順番を崩さない）。
// 列が持つのは、届いたものだけ。画面の側で、届いていない情報は作らない
import { tr } from '../util';

/** 速さの設定。instant は「すぐに」: 列を使わず、届いたときに描く（S13 より前と同じ） */
export type WatchSpeed = 'slow' | 'normal' | 'fast' | 'instant';
export const WATCH_SPEEDS: readonly WatchSpeed[] = ['slow', 'normal', 'fast', 'instant'];
/** 1 歩の間（ミリ秒）。ふつうが既定 */
export const SPEED_MS: Readonly<Record<Exclude<WatchSpeed, 'instant'>, number>> = { slow: 320, normal: 180, fast: 90 };
export const DEFAULT_SPEED: WatchSpeed = 'normal';
/** おくれがこれを超えたら、間隔を縮め始める */
export const CATCHUP_FROM_MS = 8_000;
/** おくれがこれに達したら、間隔は下限（間は、おくれに応じて直線で縮める） */
export const CATCHUP_FULL_MS = 20_000;
/** 間隔の下限 */
export const MIN_STEP_MS = 40;
/** おくれがこれを超えたら、今の所へ飛ぶ */
export const JUMP_LAG_MS = 30_000;
/** 列の歩の上限。超えたら、今の所へ飛ぶ */
export const MAX_QUEUED_STEPS = 2_000;
/** おくれを画面に出す下限 */
export const LAG_SHOW_MS = 1_000;
/** 歩を出すのがこれ以内の遅れなら、出すはずだった時刻から次の間を数える（時計の遅れで間が伸びていかない） */
export const LATE_SLACK_MS = 30;
/** 列が空で、最後の AI の呼び出しの知らせからこれだけたったら「考えている… N 秒」 */
export const THINK_SHOW_MS = 5_000;

export function readSpeed(raw: string | null | undefined): WatchSpeed {
  return (WATCH_SPEEDS as readonly string[]).includes(raw ?? '') ? (raw as WatchSpeed) : DEFAULT_SPEED;
}

export function speedLabel(s: WatchSpeed): string {
  switch (s) {
    case 'slow': return tr('ゆっくり', 'Slow');
    case 'normal': return tr('ふつう', 'Normal');
    case 'fast': return tr('速い', 'Fast');
    default: return tr('すぐに', 'Instant');
  }
}

/** 1 歩の間（ミリ秒）。lagMs: おくれ。8 秒までは設定のまま、そこから 20 秒まで直線で縮めて、下限 40 */
export function stepInterval(speed: WatchSpeed, lagMs: number): number {
  if (speed === 'instant') return 0;
  const base = SPEED_MS[speed];
  if (lagMs <= CATCHUP_FROM_MS) return base;
  const f = Math.min(1, (lagMs - CATCHUP_FROM_MS) / (CATCHUP_FULL_MS - CATCHUP_FROM_MS));
  return Math.max(MIN_STEP_MS, Math.round(base - (base - MIN_STEP_MS) * f));
}

/** 描く演出（動き・矢・数字）の速さの倍率: 間が「ふつう」より短いときだけ、その分速める（1〜6。8 以上は演出を省くので届かせない） */
export function animSpeed(intervalMs: number): number {
  if (intervalMs <= 0) return 1;
  return Math.max(1, Math.min(6, SPEED_MS.normal / intervalMs));
}

/** 歩が持つ出来事の番号の幅（first から last まで。間に、観戦に来ない番号があってよい） */
export interface SeqRange { first: number; last: number }

type StepEntry<S, N> = { kind: 'step'; step: S; seqs: SeqRange | null; key: string | number | null; at: number; notes: N[] };
type MarkEntry<N> = { kind: 'mark'; note: N; at: number; final: boolean };
type Entry<S, N> = StepEntry<S, N> | MarkEntry<N>;

/** 取り出したもの。step の notes は、その歩に結んだ知らせ（歩を描くときに一緒に出す） */
export type Delivery<S, N> = { kind: 'step'; step: S; notes: N[] } | { kind: 'mark'; note: N };

export interface TickResult<S, N> {
  /** 今出すもの（順に） */
  out: Delivery<S, N>[];
  /** true: 今の所へ飛んだ（out の途中は描かない。音も鳴らさない。文の記録には足してよい） */
  jumped: boolean;
  /** 次に tick を呼ぶまで（ミリ秒）。null: 列が空か、隠れている（次に足したとき・表に戻ったときに呼ぶ） */
  next: number | null;
}

/**
 * 再生の列。S: 歩（画面が描くもの）、N: 知らせ。
 * - push: 歩を足す。key が同じで、まだ描いていない最後の歩には merge で足し込む（1 手番が 2 つの束に分かれて届いたとき）
 * - mark: 時間を使わない印。final（ランの終わり）は、後から来た歩より後ろに残す
 * - attach: 知らせを、その命令の出来事の番号の幅にかかる、列の最初の歩に結ぶ。無ければ列の今の位置（最後）に印として置く
 * - tick(now): 出すものと、次に呼ぶまでの時間
 */
export class PlaybackQueue<S, N> {
  private q: Entry<S, N>[] = [];
  private steps = 0;
  /** 次の間を数え始める時刻（最後に歩を出した時刻。数ミリ秒の遅れなら、出すはずだった時刻）。しばらく何も無かった後の 1 歩は、すぐ出る */
  private lastPlay = Number.NEGATIVE_INFINITY;
  /** 最後に歩を実際に出した時刻（間の下限は、ここから数える） */
  private lastShown = Number.NEGATIVE_INFINITY;
  speed: WatchSpeed;

  constructor(speed: WatchSpeed = DEFAULT_SPEED, private readonly merge?: (a: S, b: S) => S) {
    this.speed = speed;
  }

  /** 列にある歩の数 */
  get size(): number { return this.steps; }
  /** 列に何も無い（歩も印も） */
  get empty(): boolean { return this.q.length === 0; }

  /** おくれ: 列のいちばん古い歩が届いてからの時間（歩が無ければ 0） */
  lag(now: number): number {
    for (const e of this.q) if (e.kind === 'step') return Math.max(0, now - e.at);
    return 0;
  }

  /** いまの 1 歩の間（おくれで縮めた後） */
  interval(now: number): number {
    return stepInterval(this.speed, this.lag(now));
  }

  /** 終わりの印（final）より前の、最後の位置 */
  private insertAt(): number {
    let i = this.q.length;
    while (i > 0) {
      const e = this.q[i - 1];
      if (e.kind === 'mark' && e.final) i--;
      else break;
    }
    return i;
  }

  push(step: S, now: number, o: { seqs?: SeqRange | null; key?: string | number | null } = {}): void {
    const at = this.insertAt();
    const prev = at > 0 ? this.q[at - 1] : undefined;
    const key = o.key ?? null;
    if (this.merge && key !== null && prev?.kind === 'step' && prev.key === key) {
      prev.step = this.merge(prev.step, step);
      if (o.seqs) prev.seqs = prev.seqs ? { first: Math.min(prev.seqs.first, o.seqs.first), last: Math.max(prev.seqs.last, o.seqs.last) } : { ...o.seqs };
      return;
    }
    this.q.splice(at, 0, { kind: 'step', step, seqs: o.seqs ? { ...o.seqs } : null, key, at: now, notes: [] });
    this.steps++;
  }

  mark(note: N, now: number, o: { final?: boolean } = {}): void {
    const at = o.final ? this.q.length : this.insertAt();
    this.q.splice(at, 0, { kind: 'mark', note, at: now, final: !!o.final });
  }

  /**
   * 知らせを、その命令の歩に結ぶ。range: その命令の出来事の番号（after より後、upTo まで）。
   * 列にある歩のうち、幅にかかる最初の歩に結ぶ（'step'）。無ければ（もう描いた後・手番を使わない命令）、列の今の位置に印として置く（'tail'）
   */
  attach(note: N, range: { after: number; upTo: number }, now: number): 'step' | 'tail' {
    for (const e of this.q) {
      if (e.kind !== 'step' || !e.seqs) continue;
      if (e.seqs.last > range.after && e.seqs.first <= range.upTo) {
        e.notes.push(note);
        return 'step';
      }
    }
    this.mark(note, now);
    return 'tail';
  }

  /** 先頭の印を、次の歩の手前まで出す */
  private takeMarks(out: Delivery<S, N>[]): void {
    while (this.q.length && this.q[0].kind === 'mark') {
      const m = this.q.shift() as MarkEntry<N>;
      out.push({ kind: 'mark', note: m.note });
    }
  }

  private drain(): Delivery<S, N>[] {
    const out: Delivery<S, N>[] = this.q.map((e) => (e.kind === 'step' ? { kind: 'step' as const, step: e.step, notes: e.notes } : { kind: 'mark' as const, note: e.note }));
    this.q = [];
    this.steps = 0;
    return out;
  }

  /**
   * 出すもの。hidden: タブが隠れている（溜めるだけ。歩が上限を超えたときだけ飛ぶ。表に戻ったら、同じ決まりで: 多くは飛ぶ）。
   * 「すぐに」は、隠れていても、届いたものを全部、描く（S13 より前と同じ）
   */
  tick(now: number, o: { hidden?: boolean } = {}): TickResult<S, N> {
    if (!this.q.length) return { out: [], jumped: false, next: null };
    if (this.speed === 'instant') {
      const out = this.drain();
      if (out.some((d) => d.kind === 'step')) { this.lastPlay = now; this.lastShown = now; }
      return { out, jumped: false, next: null };
    }
    if (this.steps > MAX_QUEUED_STEPS || (!o.hidden && this.lag(now) > JUMP_LAG_MS)) return this.flush(now);
    if (o.hidden) return { out: [], jumped: false, next: null };
    const out: Delivery<S, N>[] = [];
    this.takeMarks(out);
    const head = this.q[0];
    if (!head || head.kind !== 'step') return { out, jumped: false, next: null };
    const due = this.dueAt(now);
    if (now < due) return { out, jumped: false, next: Math.max(1, Math.ceil(due - now)) };
    this.q.shift();
    this.steps--;
    out.push({ kind: 'step', step: head.step, notes: head.notes });
    // 時計の遅れ（数ミリ秒）で間が伸びていかないよう、少しの遅れなら、出すはずだった時刻を基にする。しばらく何も無かった後は、今から
    this.lastPlay = now - due <= LATE_SLACK_MS ? due : now;
    this.lastShown = now;
    this.takeMarks(out);
    return { out, jumped: false, next: this.q.length ? Math.max(1, Math.ceil(this.dueAt(now) - now)) : null };
  }

  /** 次の歩を出す時刻: 前の歩から今の間。ただし、実際に出した時刻から下限（40 ミリ秒）より早くはしない */
  private dueAt(now: number): number {
    return Math.max(this.lastPlay + this.interval(now), this.lastShown + MIN_STEP_MS);
  }

  /** 今の所へ（「今の所へ」のボタン・飛ぶとき）: 列の全部を、描かずに出す */
  flush(now: number): TickResult<S, N> {
    const out = this.drain();
    this.lastPlay = now;
    this.lastShown = now;
    return { out, jumped: true, next: null };
  }

  /** 列を捨てる（観戦する相手を替えた・つなぎ直した） */
  clear(): void {
    this.q = [];
    this.steps = 0;
    this.lastPlay = Number.NEGATIVE_INFINITY;
    this.lastShown = Number.NEGATIVE_INFINITY;
  }
}

/**
 * 思考の欄の 1 行の見分け（同じ考えを 2 回出さない）。act: AI の呼び出しの知らせから作った行の、その命令の出来事の番号の幅（after より後、upTo まで）。
 * 俯瞰つきの観戦では、同じ考えが、出来事（thought。その命令の最初の歩）と、呼び出しの知らせの両方から来る
 */
export interface ThoughtKey { seq: number; player: string; text: string; kind?: string; act?: { after: number; upTo: number } }

export function sameThought(a: ThoughtKey, b: ThoughtKey): boolean {
  if (a.kind || b.kind) return a.kind === b.kind && a.seq === b.seq;
  if (a.player !== b.player || a.text !== b.text) return false;
  if (a.act && b.act) return a.seq === b.seq;
  const act = a.act ? a : b.act ? b : null;
  if (!act) return a.seq === b.seq;
  const ev = act === a ? b : a;
  return ev.seq > act.act!.after && ev.seq <= act.act!.upTo;
}

/** 画面に出すおくれの文（1 秒以下は出さない） */
export function lagText(lagMs: number): string | null {
  if (lagMs <= LAG_SHOW_MS) return null;
  const s = Math.floor(lagMs / 1000);
  return tr(`${s} 秒おくれ`, `${s}s behind`);
}

/**
 * 待っている間の表示（§65.1 の 4）。列が空で、ランが続いていて、AI が操作する冒険者の番（かキャンプ）のときだけ。
 * ownerPending: キャンプで、持ち主の支度が「まだ」（見え方から分かる）。lastAgentAt: 最後に AI の呼び出しの知らせが届いた時刻（無ければ、つないだ時刻）
 */
export function waitText(o: { queued: boolean; active: boolean; agent: boolean; ownerPending: boolean; lastAgentAt: number; now: number }): string | null {
  if (o.queued || !o.active || !o.agent) return null;
  if (o.ownerPending) return tr('持ち主の支度を、待っている', 'Waiting for the owner\'s preparations');
  const ms = o.now - o.lastAgentAt;
  if (ms < THINK_SHOW_MS) return null;
  const s = Math.floor(ms / 1000);
  return tr(`考えている… ${s} 秒`, `Thinking… ${s}s`);
}

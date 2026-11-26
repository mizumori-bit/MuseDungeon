// S13（SEASON.md §65.1）・S13a（検査の指摘の直し）: 観戦の再生の列。画面から離した、時刻を外から渡す作りのテスト。
// 等間隔・しばらく何も無かった後の 1 歩はすぐ・追いつき（8 秒から縮めて下限 40）・飛ぶ（30 秒・上限 2,000（歩と印）・隠れていた後）・
// AI の考えはその命令の歩を描くときに出る（協力プレイでは、そのプレイヤーの歩に。もう描いた後・手番を使わない命令は、列の今の位置で）・
// 順番が崩れない・終わりは最後・「すぐに（届いたときに描く）」は列を使わない・つなぎ直し・遅らせる観戦・待っている間の表示
import { afterEach, describe, expect, it } from 'vitest';
import {
  animSpeed, CallRanges, CATCHUP_FROM_MS, HELD_STALE_MS, HeldCalls, JUMP_LAG_MS, lagText, MAX_QUEUED, MIN_STEP_MS, PlaybackQueue, readSpeed, sameThought, SPEED_MS, speedLabel,
  stepActor, stepInterval, waitText,
  type Delivery,
} from '../src/ui/playback';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

type S = { n: number };
type N = string;

/** 列を時刻の順に動かす（tick が返す next のとおりに呼ぶ）。until までに出たものを、出た時刻と一緒に返す */
function drive(q: PlaybackQueue<S, N>, from: number, until: number, arrivals: { at: number; fn: (now: number) => void }[] = []) {
  const got: { at: number; d: Delivery<S, N>; jumped: boolean }[] = [];
  const pending = [...arrivals].sort((a, b) => a.at - b.at);
  let now = from;
  let due: number | null = from;
  while (now <= until) {
    // 次の出来事: 届くもの か、列の時計
    const nextArrival = pending.length ? pending[0].at : Number.POSITIVE_INFINITY;
    const nextDue = due ?? Number.POSITIVE_INFINITY;
    now = Math.min(nextArrival, nextDue);
    if (!Number.isFinite(now) || now > until) break;
    if (nextArrival <= nextDue) {
      const a = pending.shift()!;
      a.fn(now);
      if (due === null) due = now; // 待っている時計が無ければ、すぐ進める（画面の kick と同じ）
      continue;
    }
    const r = q.tick(now);
    for (const d of r.out) got.push({ at: now, d, jumped: r.jumped });
    due = r.next === null ? null : now + r.next;
  }
  return got;
}

const stepsOf = <G extends { d: Delivery<S, N> }>(got: G[]): G[] => got.filter((g) => g.d.kind === 'step');

describe('S13 §65.1: the interval', () => {
  it('normal 180, slow 320, fast 90; shrinks linearly after 8 s of lag, floor 40; instant is 0', () => {
    expect(SPEED_MS).toEqual({ slow: 320, normal: 180, fast: 90 });
    expect(stepInterval('normal', 0)).toBe(180);
    expect(stepInterval('normal', CATCHUP_FROM_MS)).toBe(180);
    expect(stepInterval('normal', 14_000)).toBe(110);
    expect(stepInterval('normal', 20_000)).toBe(MIN_STEP_MS);
    expect(stepInterval('normal', 29_000)).toBe(MIN_STEP_MS);
    expect(stepInterval('slow', 14_000)).toBe(180);
    expect(stepInterval('slow', 20_000)).toBe(40);
    expect(stepInterval('fast', 14_000)).toBe(65);
    expect(stepInterval('instant', 0)).toBe(0);
    // 縮み方は、おくれに応じてなめらか（増えるほど短い・跳ばない）
    let prev = Number.POSITIVE_INFINITY;
    for (let lag = 0; lag <= 25_000; lag += 250) {
      const v = stepInterval('normal', lag);
      expect(v).toBeLessThanOrEqual(prev);
      expect(prev === Number.POSITIVE_INFINITY || prev - v <= 3).toBe(true);
      expect(v).toBeGreaterThanOrEqual(MIN_STEP_MS);
      prev = v;
    }
  });

  it('remembers only the four speeds (anything else is normal); animations speed up only when the interval is shorter than normal', () => {
    expect(readSpeed('slow')).toBe('slow');
    expect(readSpeed('instant')).toBe('instant');
    expect(readSpeed('turbo')).toBe('normal');
    expect(readSpeed(null)).toBe('normal');
    expect(animSpeed(320)).toBe(1);
    expect(animSpeed(180)).toBe(1);
    expect(animSpeed(90)).toBe(2);
    expect(animSpeed(40)).toBe(4.5);
    expect(animSpeed(10)).toBe(6);
    expect(animSpeed(0)).toBe(1);
  });
});

describe('S13 §65.1: evenly spaced steps', () => {
  it('a burst (an explore of 30 steps arriving within milliseconds) is drawn one step per 180 ms; the first at once', () => {
    const q = new PlaybackQueue<S, N>();
    const arrivals = Array.from({ length: 30 }, (_, i) => ({ at: i * 3, fn: (now: number) => q.push({ n: i }, now) }));
    const got = stepsOf(drive(q, 0, 60_000, arrivals));
    expect(got.map((g) => (g.d as { step: S }).step.n)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    expect(got[0].at).toBe(0);
    for (let i = 1; i < got.length; i++) expect(got[i].at - got[i - 1].at).toBe(180);
    expect(q.empty).toBe(true);
  });

  it('a browser timer that fires a few ms late does not stretch the spacing step after step', () => {
    const q = new PlaybackQueue<S, N>();
    for (let i = 0; i < 10; i++) q.push({ n: i }, 0);
    const at: number[] = [];
    let now = 0;
    for (let k = 0; k < 10; k++) {
      const r = q.tick(now);
      if (r.out.length) at.push(now);
      if (r.next === null) break;
      now += r.next + 8; // 毎回 8 ミリ秒遅れて呼ばれる
    }
    expect(at).toHaveLength(10);
    // 遅れは 1 回分（8 ミリ秒）にとどまり、積み重ならない
    for (let i = 1; i < at.length; i++) expect(at[i] - 180 * i).toBe(8);
  });

  it('after a quiet while, the next step is drawn at once; slow and fast keep their own spacing', () => {
    for (const [speed, ms] of [['slow', 320], ['fast', 90]] as const) {
      const q = new PlaybackQueue<S, N>(speed);
      const arrivals = [
        ...Array.from({ length: 5 }, (_, i) => ({ at: 0, fn: (now: number) => q.push({ n: i }, now) })),
        { at: 10_000, fn: (now: number) => q.push({ n: 99 }, now) },
      ];
      const got = stepsOf(drive(q, 0, 20_000, arrivals));
      expect(got.map((g) => g.at)).toEqual([0, ms, 2 * ms, 3 * ms, 4 * ms, 10_000]);
    }
  });

  it('catches up while the AI thinks: a burst of 30, a 20-second think, another burst; each burst is drawn before the next arrives', () => {
    const q = new PlaybackQueue<S, N>();
    const arrivals = [
      ...Array.from({ length: 30 }, (_, i) => ({ at: i * 2, fn: (now: number) => q.push({ n: i }, now) })),
      ...Array.from({ length: 30 }, (_, i) => ({ at: 20_000 + i * 2, fn: (now: number) => q.push({ n: 100 + i }, now) })),
    ];
    const got = stepsOf(drive(q, 0, 60_000, arrivals));
    expect(got).toHaveLength(60);
    expect(got[29].at).toBe(29 * 180);
    expect(got[30].at).toBe(20_000);
    expect(got.every((g) => !g.jumped)).toBe(true);
  });
});

describe('S13 §65.1: catching up and jumping', () => {
  it('a long backlog (a fast AI: 400 steps at once) draws at 180 until 8 s behind, then shorter and shorter, never under 40, without jumping', () => {
    const q = new PlaybackQueue<S, N>();
    const arrivals = Array.from({ length: 400 }, (_, i) => ({ at: i, fn: (now: number) => q.push({ n: i }, now) }));
    const got = drive(q, 0, 120_000, arrivals);
    const steps = stepsOf(got);
    expect(steps).toHaveLength(400);
    expect(got.some((g) => g.jumped)).toBe(false);
    const gaps = steps.slice(1).map((g, i) => g.at - steps[i].at);
    expect(gaps[0]).toBe(180);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(MIN_STEP_MS);
    // 8 秒おくれるまでは 180、その後は縮む
    const firstShort = gaps.findIndex((x) => x < 180);
    expect(firstShort).toBeGreaterThan(0);
    expect(gaps.slice(0, firstShort).every((x) => x === 180)).toBe(true);
    expect(steps[firstShort].at).toBeGreaterThan(CATCHUP_FROM_MS);
    expect(Math.min(...gaps)).toBe(MIN_STEP_MS);
    // 列が無いときの間隔より、ずっと早く見せ終える
    expect(steps[399].at).toBeLessThan(399 * 180);
  });

  it('jumps to now when 30 s behind: everything comes out at once, marked as a jump (not drawn, no sound)', () => {
    const q = new PlaybackQueue<S, N>();
    for (let i = 0; i < 10; i++) q.push({ n: i }, 0);
    q.mark('macro stopped', 0);
    expect(q.tick(0).out).toHaveLength(1);
    const r = q.tick(JUMP_LAG_MS + 1);
    expect(r.jumped).toBe(true);
    expect(r.out.map((d) => (d.kind === 'step' ? d.step.n : d.note))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 'macro stopped']);
    expect(r.next).toBeNull();
    expect(q.empty).toBe(true);
    // 飛んだ後に届いた歩は、ふつうに描く
    q.push({ n: 10 }, JUMP_LAG_MS + 500);
    const r2 = q.tick(JUMP_LAG_MS + 500);
    expect(r2.jumped).toBe(false);
    expect(r2.out).toHaveLength(1);
  });

  it('a tab that was hidden only collects; when shown again the same rules apply (mostly a jump)', () => {
    const q = new PlaybackQueue<S, N>();
    for (let i = 0; i < 50; i++) q.push({ n: i }, i * 100);
    expect(q.tick(0, { hidden: true })).toEqual({ out: [], jumped: false, next: null });
    expect(q.tick(20_000, { hidden: true }).out).toHaveLength(0);
    expect(q.size).toBe(50);
    const back = q.tick(40_000);
    expect(back.jumped).toBe(true);
    expect(back.out).toHaveLength(50);
    // 少しだけ隠れていた: 追いつきの間で続ける（飛ばない）
    const q2 = new PlaybackQueue<S, N>();
    for (let i = 0; i < 50; i++) q2.push({ n: i }, 0);
    expect(q2.tick(12_000, { hidden: true }).out).toHaveLength(0);
    const r = q2.tick(12_000);
    expect(r.jumped).toBe(false);
    expect(r.out).toHaveLength(1);
    expect(r.next).toBe(stepInterval('normal', 12_000));
    expect(r.next!).toBeLessThan(180);
  });

  it('more than 2,000 steps in the queue jumps, even while hidden', () => {
    const q = new PlaybackQueue<S, N>();
    for (let i = 0; i <= MAX_QUEUED; i++) q.push({ n: i }, 0);
    const r = q.tick(10, { hidden: true });
    expect(r.jumped).toBe(true);
    expect(r.out).toHaveLength(MAX_QUEUED + 1);
  });

  it('S13a: marks (calls that use no turn) count toward the limit too; past it, everything comes out quietly as a jump', () => {
    const q = new PlaybackQueue<S, N>();
    q.push({ n: 0 }, 0);
    for (let i = 0; i < MAX_QUEUED; i++) q.mark(`observe ${i}`, i);
    expect(q.size).toBe(1);
    const r = q.tick(10, { hidden: true });
    expect(r.jumped).toBe(true);
    expect(r.out).toHaveLength(MAX_QUEUED + 1);
    expect(q.empty).toBe(true);
  });

  it('S13a: marks piled up while hidden come out quietly when shown again (no burst of bubbles); later ones are as usual', () => {
    const q = new PlaybackQueue<S, N>();
    // 隠れている間に、手番を使わない呼び出しが 3 つ（歩は無い: おくれは 0 のまま）
    for (let i = 0; i < 3; i++) q.mark(`observe ${i}`, i * 1_000);
    expect(q.tick(2_500, { hidden: true }).out).toHaveLength(0);
    const back = q.tick(10_000);
    expect(back.jumped).toBe(false);
    expect(back.out).toEqual([0, 1, 2].map((i) => ({ kind: 'mark', note: `observe ${i}`, quiet: true })));
    // 表に戻った後に届いた印は、ふつうに出る
    q.mark('look', 11_000);
    expect(q.tick(11_000).out).toEqual([{ kind: 'mark', note: 'look' }]);
    // 隠れている間に歩と印が溜まり、飛ばない（30 秒より短い）ときも、先頭の印は静かに。歩はふつうに
    const q2 = new PlaybackQueue<S, N>();
    q2.mark('observe', 0);
    q2.push({ n: 1 }, 0);
    expect(q2.tick(1_000, { hidden: true }).out).toHaveLength(0);
    expect(q2.tick(5_000).out).toEqual([{ kind: 'mark', note: 'observe', quiet: true }, { kind: 'step', step: { n: 1 }, notes: [] }]);
  });

  it('"jump to now" (flush) hands over what is left; clear() throws the queue away (a new spectate target / a reconnect)', () => {
    const q = new PlaybackQueue<S, N>();
    for (let i = 0; i < 5; i++) q.push({ n: i }, 0);
    q.tick(0);
    expect(q.lag(1_500)).toBe(1_500);
    const r = q.flush(1_500);
    expect(r.jumped).toBe(true);
    expect(r.out.map((d) => (d.kind === 'step' ? d.step.n : -1))).toEqual([1, 2, 3, 4]);
    for (let i = 0; i < 5; i++) q.push({ n: i }, 2_000);
    q.mark('x', 2_000, { final: true });
    q.clear();
    expect(q.empty).toBe(true);
    expect(q.size).toBe(0);
    expect(q.lag(9_000)).toBe(0);
    expect(q.tick(9_000).out).toHaveLength(0);
  });
});

describe('S13 §65.1: AI thoughts come with the step of that command', () => {
  it('binds the call to the first queued step of the command; the thought comes out with that step, not when it arrived', () => {
    const q = new PlaybackQueue<S, N>();
    // 前の命令（seq 1〜3）と、explore の 3 歩（4〜6・7〜9・10〜12）が、ほぼ同時に届く
    q.push({ n: 0 }, 0, { seqs: { first: 1, last: 3 } });
    q.push({ n: 1 }, 1, { seqs: { first: 4, last: 6 } });
    q.push({ n: 2 }, 2, { seqs: { first: 7, last: 9 } });
    q.push({ n: 3 }, 3, { seqs: { first: 10, last: 12 } });
    expect(q.tick(3).out.map((d) => d.kind)).toEqual(['step']);
    // explore の呼び出しの知らせ（前の呼び出しは seq 3。記録した時点の番号は 12）
    expect(q.attach('explore: 東へ', { after: 3, upTo: 12 }, 4)).toBe('step');
    expect(q.tick(100).out).toHaveLength(0);
    const r = q.tick(183);
    expect(r.out).toEqual([{ kind: 'step', step: { n: 1 }, notes: ['explore: 東へ'] }]);
    expect(q.tick(363).out).toEqual([{ kind: 'step', step: { n: 2 }, notes: [] }]);
  });

  it('when the steps are already drawn, or the command used no turn (observe, refused, camp), it comes at the queue\'s current position: after what is queued, not before', () => {
    const q = new PlaybackQueue<S, N>();
    q.push({ n: 0 }, 0, { seqs: { first: 1, last: 5 } });
    q.push({ n: 1 }, 0, { seqs: { first: 6, last: 9 } });
    expect(q.tick(0).out).toHaveLength(1);
    // observe（手番を使わない。番号は 9 のまま）
    expect(q.attach('observe', { after: 9, upTo: 9 }, 10)).toBe('tail');
    // 列にある歩より先には出ない
    expect(q.tick(50).out).toHaveLength(0);
    const r = q.tick(180);
    expect(r.out).toEqual([{ kind: 'step', step: { n: 1 }, notes: [] }, { kind: 'mark', note: 'observe' }]);
    // 列が空なら、すぐ（取り残されない）
    expect(q.attach('look', { after: 9, upTo: 9 }, 5_000)).toBe('tail');
    expect(q.tick(5_000).out).toEqual([{ kind: 'mark', note: 'look' }]);
  });

  it('keeps the order of marks (macro notices) and keeps the end of the run last, even when a step arrives after it', () => {
    const q = new PlaybackQueue<S, N>();
    q.mark('macro running', 0);
    q.push({ n: 0 }, 0, { seqs: { first: 1, last: 1 } });
    q.push({ n: 1 }, 0, { seqs: { first: 2, last: 2 } });
    q.mark('ended', 1, { final: true });
    // 終わりの後に届いた枠（40ms でまとめた最後の枠）と、知らせ
    q.push({ n: 2 }, 2, { seqs: { first: 3, last: 3 } });
    q.mark('macro stopped', 3);
    q.attach('explore', { after: 0, upTo: 3 }, 4);
    const got = drive(q, 4, 10_000);
    expect(got.map((g) => (g.d.kind === 'step' ? `s${g.d.step.n}${g.d.notes.length ? `+${g.d.notes.join(',')}` : ''}` : g.d.note))).toEqual([
      'macro running', 's0+explore', 's1', 's2', 'macro stopped', 'ended',
    ]);
    // 結んだ知らせは、まだ描いていない最初の歩（s1 は先に描いた後なら s2）
    const q2 = new PlaybackQueue<S, N>();
    q2.push({ n: 0 }, 0, { seqs: { first: 1, last: 1 } });
    q2.push({ n: 1 }, 0, { seqs: { first: 2, last: 2 } });
    q2.tick(0);
    q2.attach('explore', { after: 0, upTo: 2 }, 1);
    expect(q2.tick(180).out).toEqual([{ kind: 'step', step: { n: 1 }, notes: ['explore'] }]);
  });

  it('merges two bundles of the same command (same key) while the first is not drawn yet; different keys stay apart', () => {
    const q = new PlaybackQueue<S, N>('normal', (a, b) => ({ n: a.n * 100 + b.n }));
    q.push({ n: 9 }, 0, { seqs: { first: 1, last: 2 }, key: 1 });
    q.tick(0);
    q.push({ n: 1 }, 1, { seqs: { first: 3, last: 4 }, key: 2 });
    q.push({ n: 2 }, 2, { seqs: { first: 5, last: 6 }, key: 2 });
    q.push({ n: 3 }, 3, { seqs: { first: 7, last: 7 }, key: 3 });
    expect(q.size).toBe(2);
    expect(q.attach('t', { after: 4, upTo: 6 }, 4)).toBe('step');
    expect(q.tick(180).out).toEqual([{ kind: 'step', step: { n: 102 }, notes: ['t'] }]);
  });

  it('"instant (draw on arrival)" does not use the queue: everything that arrived is drawn at once, with sound and no spacing', () => {
    expect(speedLabel('instant')).toBe('すぐに（届いたときに描く）');
    const q = new PlaybackQueue<S, N>('instant');
    for (let i = 0; i < 5; i++) q.push({ n: i }, 0);
    q.attach('explore', { after: 0, upTo: 5 }, 0);
    const r = q.tick(0);
    expect(r.jumped).toBe(false);
    expect(r.next).toBeNull();
    expect(r.out.map((d) => d.kind)).toEqual(['step', 'step', 'step', 'step', 'step', 'mark']);
    // 隠れていても、届いたときに描く
    q.push({ n: 5 }, 10);
    expect(q.tick(10, { hidden: true }).out).toHaveLength(1);
    setLocale('en');
    expect(speedLabel('instant')).toBe('Instant (draw on arrival)');
  });

  it('S13a: with an empty queue the first step is drawn at once; the call notice that comes after binds to the next queued step, or comes at once', () => {
    const q = new PlaybackQueue<S, N>();
    // explore の 3 歩が届く。1 歩目は、列が空なのですぐ描く
    q.push({ n: 1 }, 0, { seqs: { first: 11, last: 12 }, actor: 'p_1' });
    expect(q.tick(0).out).toEqual([{ kind: 'step', step: { n: 1 }, notes: [] }]);
    q.push({ n: 2 }, 2, { seqs: { first: 13, last: 14 }, actor: 'p_1' });
    q.push({ n: 3 }, 4, { seqs: { first: 15, last: 16 }, actor: 'p_1' });
    // その後に、呼び出しの知らせ（記録した時点の番号 16）: まだ描いていない、その命令の最初の歩（2 歩目）に
    expect(q.attach('explore', { after: 10, upTo: 16, actor: 'p_1' }, 6)).toBe('step');
    expect(q.tick(180).out).toEqual([{ kind: 'step', step: { n: 2 }, notes: ['explore'] }]);
    // 1 歩だけの命令は、知らせより先に描き終わっている: 知らせは、列が空ならすぐ
    q.tick(360);
    q.push({ n: 4 }, 2_000, { seqs: { first: 17, last: 18 }, actor: 'p_1' });
    expect(q.tick(2_000).out).toHaveLength(1);
    expect(q.attach('move', { after: 16, upTo: 18, actor: 'p_1' }, 2_005)).toBe('tail');
    expect(q.tick(2_005).out).toEqual([{ kind: 'mark', note: 'move' }]);
  });
});

describe('S13a: co-op — a thought is bound to a step of the player who called', () => {
  it('P1 / P2 / P1 steps interleaved: P1\'s call binds to P1\'s first step in range, not to P2\'s earlier step', () => {
    const q = new PlaybackQueue<S, N>();
    // 描いた後: P2 の手番（seq 1〜4）
    q.push({ n: 0 }, 0, { seqs: { first: 1, last: 4 }, actor: 'p_2' });
    q.tick(0);
    // 列: P2 の手番・P1 の手番・P2 の手番・P1 の手番
    q.push({ n: 1 }, 1, { seqs: { first: 5, last: 8 }, actor: 'p_2' });
    q.push({ n: 2 }, 1, { seqs: { first: 9, last: 12 }, actor: 'p_1' });
    q.push({ n: 3 }, 1, { seqs: { first: 13, last: 16 }, actor: 'p_2' });
    q.push({ n: 4 }, 1, { seqs: { first: 17, last: 20 }, actor: 'p_1' });
    // P1 の呼び出し（前の呼び出しは seq 4、記録したのは 20）: 幅にかかる最初の歩は P2 の n1 だが、P1 の n2 に結ぶ
    expect(q.attach('P1: explore', { after: 4, upTo: 20, actor: 'p_1' }, 2)).toBe('step');
    // P2 の呼び出し（前は 4、記録したのは 16）: P2 の n1 に
    expect(q.attach('P2: fight', { after: 4, upTo: 16, actor: 'p_2' }, 3)).toBe('step');
    const got = drive(q, 3, 10_000).filter((g) => g.d.kind === 'step').map((g) => g.d as { step: S; notes: N[] });
    expect(got.map((d) => [d.step.n, d.notes])).toEqual([[1, ['P2: fight']], [2, ['P1: explore']], [3, []], [4, []]]);
  });

  it('no step of that player in range (the actor is unknown): binds to the last step in range; no step in range: at the queue\'s position', () => {
    const q = new PlaybackQueue<S, N>();
    q.push({ n: 0 }, 0, { seqs: { first: 1, last: 1 } });
    q.tick(0);
    q.push({ n: 1 }, 0, { seqs: { first: 2, last: 3 }, actor: null });
    q.push({ n: 2 }, 0, { seqs: { first: 4, last: 5 }, actor: 'p_2' });
    q.push({ n: 3 }, 0, { seqs: { first: 6, last: 9 }, actor: 'p_2' });
    expect(q.attach('P1: wait', { after: 1, upTo: 5, actor: 'p_1' }, 1)).toBe('step');
    expect(q.attach('P1: observe', { after: 9, upTo: 9, actor: 'p_1' }, 1)).toBe('tail');
    const got = drive(q, 1, 10_000).map((g) => (g.d.kind === 'step' ? `s${g.d.step.n}${g.d.notes.length ? `+${g.d.notes.join(',')}` : ''}` : g.d.note));
    expect(got).toEqual(['s1', 's2+P1: wait', 's3', 'P1: observe']);
  });

  it('who moved in a director-view step: the thought, else the player body that ended its turn, else the event that names a player', () => {
    const playerOf = (id: string) => ({ e_a: 'p_1', e_b: 'p_2' } as Record<string, string>)[id];
    // P1 の手番: 自分が動き、手番が終わり、敵が動く
    expect(stepActor([{ type: 'entity_moved', id: 'e_a' }, { type: 'actor_scheduled', id: 'e_a', acted: true }, { type: 'actor_scheduled', id: 'e_m1' }], playerOf)).toBe('p_1');
    // 時間切れの待ち（acted が無い）も、その者の手番
    expect(stepActor([{ type: 'actor_scheduled', id: 'e_b' }, { type: 'entity_moved', id: 'e_m1' }], playerOf)).toBe('p_2');
    // 考えが付いていれば、それが先
    expect(stepActor([{ type: 'thought', player: 'p_2', text: 'x' }, { type: 'actor_scheduled', id: 'e_b' }], playerOf)).toBe('p_2');
    // 敵の手番で P2 が倒れても、手番を打ったのは P1
    expect(stepActor([{ type: 'actor_scheduled', id: 'e_a' }, { type: 'player_state', player: 'p_2', state: 'dead' }], playerOf)).toBe('p_1');
    // キャンプの命令・シーズンの取り込み（体の手番が無い）: 出来事が名指すプレイヤー
    expect(stepActor([{ type: 'season_synced', player: 'p_1' }], playerOf)).toBe('p_1');
    expect(stepActor([{ type: 'tile_changed', x: 1, y: 1 }], playerOf)).toBeNull();
  });
});

describe('S13a: call ranges across reconnects, and the delayed view', () => {
  it('the range is after the player\'s previous call up to this one; a reconnect forgets the old numbers (seq that went back or jumped ahead)', () => {
    const r = new CallRanges();
    r.reset(100);
    expect(r.range('p_1', 100)).toEqual({ after: 100, upTo: 100 }); // つなぐ前の記録: 幅は空
    expect(r.range('p_1', 130)).toEqual({ after: 100, upTo: 130 });
    expect(r.range('p_2', 140)).toEqual({ after: 100, upTo: 140 });
    expect(r.range('p_1', 150)).toEqual({ after: 130, upTo: 150 });
    // 順番の入れ替わった古い記録は、空の幅（前の番号を戻さない）
    expect(r.range('p_1', 120)).toEqual({ after: 120, upTo: 120 });
    expect(r.range('p_1', 160)).toEqual({ after: 150, upTo: 160 });
    // つなぎ直したら、番号が戻っていた（記録から復旧したサーバー）: 前の接続の 160 を引きずらない
    r.reset(80);
    expect(r.range('p_1', 95)).toEqual({ after: 80, upTo: 95 });
    // 番号が先へ飛んでいた
    r.reset(900);
    expect(r.range('p_1', 930)).toEqual({ after: 900, upTo: 930 });
  });

  it('a call ahead of the delayed view is held until the events reach it, and dropped when it never does', () => {
    const h = new HeldCalls<string>();
    h.hold('explore@320', 320, 0);
    h.hold('fight@350', 350, 10);
    h.hold('look@400', 400, 20);
    expect(h.release(300, 1_000)).toEqual([]);
    expect(h.release(330, 2_000)).toEqual(['explore@320']);
    expect(h.release(360, 3_000)).toEqual(['fight@350']);
    expect(h.size).toBe(1);
    // 追いつかないまま古くなった
    expect(h.release(370, 20 + HELD_STALE_MS + 1)).toEqual([]);
    expect(h.size).toBe(0);
    h.hold('x', 1, 0);
    h.clear();
    expect(h.size).toBe(0);
  });
});

describe('S13 §65.1: the same thought twice is shown once', () => {
  it('a thought from the event (the first step) and from the call notice are the same when the event is in that command\'s range', () => {
    const ev = { seq: 41, player: 'p_1', text: '東へ' };
    const act = { seq: 61, player: 'p_1', text: '東へ', act: { after: 40, upTo: 60 } };
    expect(sameThought(ev, act)).toBe(true);
    expect(sameThought(act, ev)).toBe(true);
    // 別の命令の同じ言葉（幅の外）・別のプレイヤー・別の言葉は、別の行
    expect(sameThought({ ...ev, seq: 62 }, act)).toBe(false);
    expect(sameThought({ ...ev, player: 'p_2' }, act)).toBe(false);
    expect(sameThought({ ...ev, text: '西へ' }, act)).toBe(false);
    // つなぎ直しで同じ知らせがまた来た（同じ番号）
    expect(sameThought(act, { ...act })).toBe(true);
    expect(sameThought(act, { ...act, seq: 70, act: { after: 61, upTo: 69 } })).toBe(false);
    // 持ち主の行は、種類と番号で
    expect(sameThought({ seq: 5, player: 'p_1', text: 'a', kind: 'owner' }, { seq: 5, player: 'p_1', text: 'b', kind: 'owner' })).toBe(true);
    expect(sameThought({ seq: 5, player: 'p_1', text: 'a', kind: 'owner' }, { seq: 5, player: 'p_1', text: 'a' })).toBe(false);
  });
});

describe('S13 §65.1: what the screen shows while waiting', () => {
  it('the lag appears after 1 s ("3 秒おくれ")', () => {
    expect(lagText(0)).toBeNull();
    expect(lagText(1_000)).toBeNull();
    expect(lagText(3_400)).toBe('3 秒おくれ');
    setLocale('en');
    expect(lagText(3_400)).toBe('3s behind');
  });

  it('S13a: not while disconnected; counts from the newer of the last call and the (re)connection or a change of target', () => {
    const base = { connected: true, queued: false, active: true, agent: true, ownerPending: false, lastAgentAt: 1_000, countFrom: 0, now: 20_000 };
    expect(waitText(base)).toBe('考えている… 19 秒');
    // 切れている間は出さない（持ち主の支度も）
    expect(waitText({ ...base, connected: false })).toBeNull();
    expect(waitText({ ...base, connected: false, ownerPending: true })).toBeNull();
    // つなぎ直した（15 秒の時点）: 切れる前から続けて数えない
    expect(waitText({ ...base, countFrom: 15_000 })).toBe('考えている… 5 秒');
    expect(waitText({ ...base, countFrom: 16_000 })).toBeNull();
    // つないだ後に呼び出しが来れば、そこから
    expect(waitText({ ...base, countFrom: 3_000, lastAgentAt: 12_000 })).toBe('考えている… 8 秒');
    // つないでから、まだ一度も呼び出しが来ていない
    expect(waitText({ ...base, lastAgentAt: null, countFrom: 9_000 })).toBe('考えている… 11 秒');
  });

  it('"thinking… N s" only with an empty queue, a live run, an AI adventurer, 5 s after the last call; the owner\'s preparations when known', () => {
    const base = { connected: true, queued: false, active: true, agent: true, ownerPending: false, lastAgentAt: 1_000, countFrom: 0, now: 1_000 };
    expect(waitText({ ...base, now: 5_999 })).toBeNull();
    expect(waitText({ ...base, now: 6_000 })).toBe('考えている… 5 秒');
    expect(waitText({ ...base, now: 13_400 })).toBe('考えている… 12 秒');
    expect(waitText({ ...base, now: 13_400, queued: true })).toBeNull();
    expect(waitText({ ...base, now: 13_400, active: false })).toBeNull();
    expect(waitText({ ...base, now: 13_400, agent: false })).toBeNull();
    expect(waitText({ ...base, now: 1_200, ownerPending: true })).toBe('持ち主の支度を、待っている');
    setLocale('en');
    expect(waitText({ ...base, now: 13_400 })).toBe('Thinking… 12s');
    expect(waitText({ ...base, ownerPending: true })).toBe('Waiting for the owner\'s preparations');
  });
});

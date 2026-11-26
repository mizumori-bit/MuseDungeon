// S17（SEASON.md §70.6）: 見返しの、画面から離した関数のテスト。
// 道（#/watch/<runId>?exp=N・last）／開く遠征の選び方／見返しの画面にするか（巻き戻しへ送るか）／取ってきたコマを、その場の観戦と同じ受け口に流す形と、
// 再生の列で、AI の考えが、その行動を描くときに出ること／見返しの列は追いつかない（一時停止で溜まっても、間を縮めない・飛ばない）／続きを取りにいく時・進み具合／
// 拠点の札の「見返す」（2 番目の、小さいボタン）とシーズンの表の行のボタン
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentActivity, OwnerRunRow, PerceivedEvent, PlayerView, ReviewExpedition, ServerMsg } from '@muse/shared';
import { parseRoute, runActions } from '../src/ui/entrance';
import { hubCard, hubReview } from '../src/ui/hubState';
import { CallRanges, PlaybackQueue, SPEED_MS, type Delivery } from '../src/ui/playback';
import {
  needMore, parseExpParam, pickReviewNo, REVIEW_PREFETCH_AT, reviewExpLabel, reviewHref, reviewInsteadOfRewind, reviewMessages, reviewNowText, reviewProgress, reviewSpeedOf, reviewTitle,
} from '../src/ui/review';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

const exp = (no: number, p: Partial<ReviewExpedition> = {}): ReviewExpedition => ({
  no, objective: { type: 'reach_depth', targetDepth: 2 } as ReviewExpedition['objective'], status: 'ended', endReason: 'lifeline', startSeq: no * 100, endSeq: no * 100 + 50, deepest: 1, banked: 0, ...p,
});

describe('S17: the route and which expedition to open', () => {
  it('#/watch/<runId>?exp=N or last; anything else is the live watch', () => {
    expect(parseRoute('#/watch/run_abc?exp=3')).toEqual({ page: 'watch', id: 'run_abc', exp: 3 });
    expect(parseRoute('#/watch/run_abc?exp=last')).toEqual({ page: 'watch', id: 'run_abc', exp: 'last' });
    expect(parseRoute('#/watch/run_abc')).toEqual({ page: 'watch', id: 'run_abc' });
    expect(parseRoute('#/watch/run_abc?exp=0')).toEqual({ page: 'watch', id: 'run_abc' });
    expect(parseRoute('#/watch/run_abc?exp=x')).toEqual({ page: 'watch', id: 'run_abc' });
    expect(parseRoute('#/watch/run_abc?exp=1.5')).toEqual({ page: 'watch', id: 'run_abc' });
    // ほかの画面は、問い合わせを見ない（今までどおり）
    expect(parseRoute('#/replay/run_abc?exp=3')).toEqual({ page: 'replay', id: 'run_abc' });
    expect(parseExpParam('?a=1&exp=12')).toBe(12);
    expect(parseExpParam(null)).toBeNull();
    // 道に鍵は入らない
    expect(reviewHref('run_abc', 4)).toBe('#/watch/run_abc?exp=4');
    expect(reviewHref('run_abc', 'last')).toBe('#/watch/run_abc?exp=last');
  });

  it('the requested expedition if it is in the list; last = the newest ended one; otherwise none', () => {
    const list = [exp(1), exp(2), exp(4)];
    expect(pickReviewNo(list, 2)).toBe(2);
    expect(pickReviewNo(list, 'last')).toBe(4);
    expect(pickReviewNo(list, 3)).toBeNull();
    expect(pickReviewNo([], 'last')).toBeNull();
    expect(pickReviewNo(list, null)).toBeNull();
  });

  it('look-back (adventurer\'s eyes) is for runs of a season in progress; others go to the rewind when it can open', () => {
    expect(reviewInsteadOfRewind({ season: 's4', final: false, rewind: false })).toBe(true);
    // 同じ PC からの、終わったランも、開催中のシーズンなら見返しのまま（入口は巻き戻しを出す）
    expect(reviewInsteadOfRewind({ season: 's4', final: false, rewind: true })).toBe(true);
    expect(reviewInsteadOfRewind({ season: 's3', final: true, rewind: true })).toBe(false);
    expect(reviewInsteadOfRewind({ season: null, final: false, rewind: true })).toBe(false);
    // 巻き戻しが開けない（方針 follow_only のサーバーの、進行中のシーズンでないラン）なら、見返しのまま
    expect(reviewInsteadOfRewind({ season: null, final: false, rewind: false })).toBe(true);
  });

  it('labels: the picker line, the title that cannot be mistaken for live, and the "now" notice', () => {
    expect(reviewExpLabel(exp(3, { banked: 120 }))).toBe('遠征 3 — 地下2階・踏破する — 帰還の綱（確定 +120）');
    expect(reviewExpLabel(exp(1, { endReason: 'died', objective: { type: 'endless' } as ReviewExpedition['objective'], banked: 0 }))).toBe('遠征 1 — 目的なし。できるだけ深く潜る — 倒れた');
    expect(reviewTitle(3, 'ミュゼ美')).toBe('見返し: 遠征 3 — ミュゼ美');
    expect(reviewNowText({ state: 'in_dungeon', expedition: 5 }, 'ミュゼ美')).toBe('今、ミュゼ美は、迷宮の中（遠征 5）');
    expect(reviewNowText({ state: 'at_camp', expedition: null }, 'ミュゼ美')).toBe('今、ミュゼ美は、キャンプにいる');
    setLocale('en');
    expect(reviewTitle(3)).toBe('Looking back: expedition 3');
  });
});

/** 見え方の最小の形（再生の列の決まりに要るものだけ） */
function view(seq: number, current: string | null): PlayerView {
  return { seq, playerId: 'p1', turn: { current }, party: [{ playerId: 'p1', entityId: 'e_me0001' }] } as unknown as PlayerView;
}
const ev = (seq: number): PerceivedEvent => ({ seq, type: 'entity_moved', text: '', event: { seq } as PerceivedEvent['event'] });
const act = (seq: number, thought: string): AgentActivity => ({ playerId: 'p1', seq, tool: 'explore', args: { thought }, text: '', wall: 0 });

/**
 * 画面（Watch.tsx の onMsg）と同じ決まりで、取ってきたコマを列に入れる: view は歩（前の枠で手番だった者が、この歩の打ち手）、agent はその命令の歩に結ぶ
 */
function feed(q: PlaybackQueue<{ seq: number }, string>, msgs: ServerMsg[], st: { prev: PlayerView | null; ranges: CallRanges }) {
  for (const m of msgs) {
    if (m.t === 'view') {
      const prev = st.prev;
      const seq = m.view.seq;
      if (!prev) st.ranges.reset(seq);
      const cur = prev?.turn.current ?? null;
      const actor = cur ? prev?.party.find((p) => p.entityId === cur)?.playerId ?? null : null;
      q.push({ seq }, 0, { seqs: { first: prev ? Math.min(seq, prev.seq + 1) : seq, last: seq }, actor });
      st.prev = m.view;
    } else if (m.t === 'agent') {
      const r = st.ranges.range(m.activity.playerId, m.activity.seq);
      q.attach(String(m.activity.args.thought), { ...r, actor: m.activity.playerId }, 0);
    }
  }
}

describe('S17: frames fetched from the look-back endpoint go into the same playback queue', () => {
  it('frames first, then the call records; each thought is shown with the first step of its command', () => {
    // 遠征を始める前のキャンプ（10）→ 出発（11〜12）→ 探索のマクロの手（13・14・15）→ 待つ（16）
    const page = {
      frames: [
        { view: view(10, null), events: [] }, { view: view(12, 'e_me0001'), events: [ev(12)] }, { view: view(13, 'e_me0001'), events: [ev(13)] },
        { view: view(14, 'e_me0001'), events: [ev(14)] }, { view: view(15, 'e_me0001'), events: [ev(15)] }, { view: view(16, 'e_me0001'), events: [] },
      ],
      agent: [act(12, '出る'), act(15, '探索する'), act(16, '待つ')],
    };
    const msgs = reviewMessages(page);
    expect(msgs.map((m) => m.t)).toEqual(['view', 'view', 'view', 'view', 'view', 'view', 'agent', 'agent', 'agent']);
    const q = new PlaybackQueue<{ seq: number }, string>('normal');
    q.catchUp = false;
    feed(q, msgs, { prev: null, ranges: new CallRanges() });
    const out: Delivery<{ seq: number }, string>[] = [];
    for (let now = 0; now < 5000 && !q.empty; now += 10) out.push(...q.tick(now).out);
    const steps = out.filter((d): d is Extract<typeof d, { kind: 'step' }> => d.kind === 'step');
    expect(steps.map((s) => s.step.seq)).toEqual([10, 12, 13, 14, 15, 16]);
    // 考えは、その命令の最初の歩（出発 = 12、探索 = 13、待つ = 16）を描くときに
    expect(steps.map((s) => s.notes)).toEqual([[], ['出る'], ['探索する'], [], [], ['待つ']]);
  });

  it('a look-back queue does not catch up: a long queue and a long pause keep the chosen interval and never jump', () => {
    const q = new PlaybackQueue<{ seq: number }, string>('normal');
    q.catchUp = false;
    for (let i = 0; i < 2500; i++) q.push({ seq: i + 1 }, 0, { seqs: { first: i + 1, last: i + 1 } });
    // 60 秒止めた（一時停止）後でも、飛ばずに、ふつうの間（180 ミリ秒）で 1 歩ずつ
    let r = q.tick(60_000);
    expect(r.jumped).toBe(false);
    expect(r.out.filter((d) => d.kind === 'step')).toHaveLength(1);
    expect(r.next).toBe(SPEED_MS.normal);
    r = q.tick(60_000 + SPEED_MS.normal);
    expect(r.jumped).toBe(false);
    expect(q.interval(120_000)).toBe(SPEED_MS.normal);
    // その場の観戦の列は、今までどおり追いつく
    const live = new PlaybackQueue<{ seq: number }, string>('normal');
    for (let i = 0; i < 10; i++) live.push({ seq: i + 1 }, 0, { seqs: { first: i + 1, last: i + 1 } });
    expect(live.tick(60_000).jumped).toBe(true);
  });

  it('fetch the next page when the queue runs low; progress through the expedition', () => {
    expect(needMore({ next: 50, fetching: false, queued: REVIEW_PREFETCH_AT - 1 })).toBe(true);
    expect(needMore({ next: 50, fetching: false, queued: REVIEW_PREFETCH_AT })).toBe(false);
    expect(needMore({ next: 50, fetching: true, queued: 0 })).toBe(false);
    expect(needMore({ next: null, fetching: false, queued: 0 })).toBe(false);
    expect(reviewProgress(150, { startSeq: 100, endSeq: 200 })).toBe(50);
    expect(reviewProgress(90, { startSeq: 100, endSeq: 200 })).toBe(0);
    expect(reviewProgress(250, { startSeq: 100, endSeq: 200 })).toBe(100);
    expect(reviewProgress(null, { startSeq: 100, endSeq: 200 })).toBe(0);
    // 見返しの速さに「すぐに」は無い（覚えていた速さが「すぐに」なら、ふつう）
    expect(reviewSpeedOf('instant')).toBe('normal');
    expect(reviewSpeedOf('fast')).toBe('fast');
  });
});

function row(p: Partial<OwnerRunRow> = {}): OwnerRunRow {
  return {
    runId: 'run_abc', playerId: 'p1', name: 'ミュゼ美', classId: 'core:warrior', season: { id: 's4', name: 'S4', participant: 'ミュゼ美' },
    status: 'at_camp', eligible: true, waiting: false, hold: [], message: '',
    level: 3, hp: 30, maxHp: 30, depth: null, banked: 120, budgetLeft: 820, budgetLimit: 1000, updatedAt: 1, expeditionsEnded: 2, ...p,
  };
}

describe('S17: the entrances ("Look back")', () => {
  const season = { id: 's4', status: 'open' as const, budget: 1000 };
  it('hub card: a small second button when an expedition has ended; the main button stays the only one', () => {
    for (const r of [row(), row({ status: 'in_dungeon', depth: 2 }), row({ hold: ['objective'], prep: { state: 'pending' } }), row({ eligible: false })]) {
      const m = hubCard({ name: 'ミュゼ美', season, playable: true, rank: 1, row: r });
      expect(m.action).not.toBeNull();
      expect(m.secondary).toEqual({ label: '見返す', href: '#/watch/run_abc?exp=last' });
      expect(m.action?.href).not.toBe(m.secondary?.href);
    }
    // 終わった遠征が無い・シーズンでないラン・確定したシーズン・ランが無い札には出さない
    expect(hubCard({ name: 'ミュゼ美', season, playable: false, rank: 1, row: row({ expeditionsEnded: 0 }) }).secondary).toBeUndefined();
    expect(hubReview(row({ season: undefined }), season)).toBeUndefined();
    expect(hubReview(row(), { status: 'final' })).toBeUndefined();
    expect(hubCard({ name: 'ミュゼ美', season, playable: false, rank: 1, row: null, membership: { used: 0, budget: 1000, died: false, runs: 0 } }).secondary).toBeUndefined();
  });

  it('season table: "Watch" and "Look back" on a watchable run of a season in progress with an ended expedition; the rewind as before', () => {
    const base = { season: 's4', local: false, runId: 'run_a', watchable: ['run_a'] };
    expect(runActions({ ...base, final: false, status: 'active', ended: 2 })).toEqual([
      { kind: 'watch', label: '見守る', href: '#/watch/run_a' },
      { kind: 'review', label: '見返す', href: '#/watch/run_a?exp=last' },
    ]);
    expect(runActions({ ...base, final: false, status: 'active', ended: 0 })).toEqual([{ kind: 'watch', label: '見守る', href: '#/watch/run_a' }]);
    // 見られないランには、どちらも出さない
    expect(runActions({ ...base, final: false, status: 'active', ended: 2, watchable: ['run_b'] })).toEqual([]);
    // 確定したシーズン: 巻き戻しの「見返す」だけ（全体が見える）
    expect(runActions({ ...base, final: true, status: 'active', ended: 2 })).toEqual([{ kind: 'rewind', label: '見返す', href: '#/replay/run_a' }]);
    // 同じ PC からの、終わったラン: 巻き戻し（今までどおり）
    expect(runActions({ ...base, local: true, final: false, status: 'ended', ended: 2 })).toEqual([{ kind: 'rewind', label: '見返す', href: '#/replay/run_a' }]);
    // 復旧できなかったラン: 見守る・冒険者の目線の見返しは出さない
    expect(runActions({ ...base, final: false, status: 'active', ended: 2, recoveryFailed: true })).toEqual([]);
  });
});

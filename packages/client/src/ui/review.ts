// 見返し（S17。SEASON.md §70.6）: 観戦の画面で、終わった遠征を、冒険者の目線で見返す。画面（screens/Watch.tsx）から離した、決める所だけ（テストする: test/review.test.ts）。
// - サーバーの見返しの口（GET /api/runs/:id/review・…/review/:no）が返すコマは、その場の観戦の追従だけの枠（{ t: 'view' }）と同じ中身。
//   それを、その場の観戦と同じ受け口（onMsg）に、同じ形の知らせとして流す（再生の列 ui/playback.ts も、描き方も、音も、そのまま）。
// - どの遠征を開くか・見返しの画面にするか（巻き戻しへ送るか）・選ぶ欄の文・進み具合・続きを取りにいく時。
// だれが何を見られるかは、サーバーが決める（§25.1）。ここは、開けないものにボタンを出さないだけ。
import type { ReviewExpedition, ReviewPageResponse, ServerMsg } from '@muse/shared';
import { tr } from '../util';
import { objectiveShort } from './objectiveCard';

/** 道の exp（#/watch/<runId>?exp=3 / ?exp=last）。無ければ null（その場の観戦） */
export type ExpParam = number | 'last' | null;

/** 道の問い合わせの exp を読む（数か last。ほかは null） */
export function parseExpParam(query: string | null | undefined): ExpParam {
  const m = /(?:^|[?&])exp=([^&#]*)/.exec(query ?? '');
  if (!m) return null;
  if (m[1] === 'last') return 'last';
  // 数字だけ（1e3・+5・0x10 などの書き方は受けない: その場の観戦になる）
  if (!/^[0-9]{1,6}$/.test(m[1])) return null;
  const n = Number(m[1]);
  return n >= 1 ? n : null;
}

/** 見返しの道（鍵は入れない） */
export function reviewHref(runId: string, no: number | 'last'): string {
  return `#/watch/${runId}?exp=${no}`;
}

/**
 * 開く遠征: 道の番号が一覧にあればそれ。last（拠点・シーズンの表の「見返す」）なら、いちばん新しい終わった遠征。
 * 一覧に無い番号・一覧が空なら null（画面は「見返せる遠征が無い」と出し、今に戻る道を出す）
 */
export function pickReviewNo(list: readonly Pick<ReviewExpedition, 'no'>[], requested: ExpParam): number | null {
  if (requested === null || !list.length) return null;
  if (requested === 'last') return list[list.length - 1].no;
  return list.some((x) => x.no === requested) ? requested : null;
}

/**
 * 見返す遠征を決める（S17a の A）。last で開いて、いったん決めた番号（pinned）は、その後に次の遠征が終わって一覧が読み直されても、替えない
 * （替えると、見ている途中で、新しい遠征の頭からやり直しになる）。決めた番号が一覧から消えたとき（読み直しで見返せなくなった）は、決め直す
 */
export function resolveReviewNo(list: readonly Pick<ReviewExpedition, 'no'>[], requested: ExpParam, pinned: number | null): number | null {
  if (requested === 'last' && pinned !== null && list.some((x) => x.no === pinned)) return pinned;
  return pickReviewNo(list, requested);
}

/**
 * 一覧を読み直した後の一覧（S17a の D）: 読めたら新しい一覧。読み直しが 1 回失敗しただけなら、前の一覧を残す（見返しを止めない）。
 * 最初の読み込みの失敗と、鍵が無くなった・認められなくなった（401・403）は、null（画面は「見返せない」と理由を出す）
 */
export function nextReviewList<T>(prev: T | null, r: { ok: true; list: T } | { ok: false; status: number }, first: boolean): T | null {
  if (r.ok) return r.list;
  if (first || r.status === 401 || r.status === 403) return null;
  return prev;
}

/**
 * 観戦の画面が、どこから見え方を取るか（S17a の H）: exp が無ければ WS（その場の観戦）。exp があれば、見返す遠征が決まったら見返しの口、
 * 一覧を読んでいる間は待つ（WS につながない）、読んだが見返せる遠征が無ければ、つながずに理由を出す（「今に戻る」で、その場の観戦へ）。
 * 道の exp が読めない書き方（?exp=でたらめ）は、parseRoute が exp を付けないので、その場の観戦になる
 */
export function watchSource(x: { exp: ExpParam; reviewNo: number | null; listLoaded: boolean }): 'ws' | 'review' | 'wait' | 'none' {
  if (x.exp === null) return 'ws';
  if (x.reviewNo !== null) return 'review';
  return x.listLoaded ? 'none' : 'wait';
}

/**
 * 見返しの画面にするか（S17 §70.6 の 10）: 開催中のシーズンのランだけ。シーズンでないラン・確定したシーズンのランは、巻き戻し（全体が見える「見返す」）が開ければ、そちらへ送る。
 * 巻き戻しが開けないとき（観戦の方針が follow_only のサーバーの、進行中のランなど）は、見返しのまま
 */
export function reviewInsteadOfRewind(x: { season: string | null | undefined; final: boolean; rewind: boolean }): boolean {
  if (x.season && !x.final) return true;
  return !x.rewind;
}

/** 終わり方の短い言葉 */
function endWord(r: ReviewExpedition['endReason']): string {
  switch (r) {
    case 'completed': return tr('達成して帰還', 'completed');
    case 'withdrawn': return tr('撤退', 'withdrew');
    case 'lifeline': return tr('帰還の綱', 'lifeline');
    case 'died': return tr('倒れた', 'fell');
    case 'retired': return tr('引退', 'retired');
    case 'time_up': return tr('時間切れ', 'time up');
    default: return tr('終わった', 'ended');
  }
}

/** 選ぶ欄の 1 行（「遠征 3 — 地下 2 階・踏破する — 帰還の綱（確定 +120）」） */
export function reviewExpLabel(x: ReviewExpedition): string {
  const depth = x.objective.targetDepth ? tr(`地下${x.objective.targetDepth}階・`, `D${x.objective.targetDepth} · `) : '';
  const gain = x.banked !== null && x.banked > 0 ? tr(`（確定 +${x.banked}）`, ` (banked +${x.banked})`) : '';
  return tr(`遠征 ${x.no} — ${depth}${objectiveShort(x.objective)} — ${endWord(x.endReason)}${gain}`, `Expedition ${x.no} — ${depth}${objectiveShort(x.objective)} — ${endWord(x.endReason)}${gain}`);
}

/** 見出しの印（「見返し: 遠征 3」。その場の観戦と、取り違えない） */
export function reviewTitle(no: number, name?: string | null): string {
  return name ? tr(`見返し: 遠征 ${no} — ${name}`, `Looking back: expedition ${no} — ${name}`) : tr(`見返し: 遠征 ${no}`, `Looking back: expedition ${no}`);
}

/** 見返している間の、今の冒険者の居場所の知らせ（「今、冒険者は、迷宮の中（遠征 5）」）。無ければ null */
export function reviewNowText(now: { state: 'at_camp' | 'in_dungeon' | 'dead' | 'ended'; expedition: number | null } | null | undefined, name: string): string | null {
  if (!now) return null;
  switch (now.state) {
    case 'in_dungeon': return now.expedition !== null ? tr(`今、${name}は、迷宮の中（遠征 ${now.expedition}）`, `Now ${name} is in the dungeon (expedition ${now.expedition})`) : tr(`今、${name}は、迷宮の中`, `Now ${name} is in the dungeon`);
    case 'at_camp': return tr(`今、${name}は、キャンプにいる`, `Now ${name} is at camp`);
    case 'dead': return tr(`${name}は、倒れた`, `${name} has fallen`);
    default: return tr('この冒険は、終わった', 'This adventure has ended');
  }
}

/**
 * 取ってきた 1 回分のコマを、その場の観戦の受け口に流す知らせにする: コマは `view`（追従だけの枠と同じ）、AI の呼び出しの記録は `agent`。
 * 順は、コマを先に全部、記録を後に（その場の観戦も、命令の後に呼び出しの記録が届く。記録は、列にある、その命令の歩に結ばれる: ui/playback.ts の attach）
 */
export function reviewMessages(page: Pick<ReviewPageResponse, 'frames' | 'agent'>): ServerMsg[] {
  return [
    ...page.frames.map((f) => ({ t: 'view' as const, view: f.view, events: f.events })),
    ...page.agent.map((a) => ({ t: 'agent' as const, activity: a })),
  ];
}

/** 列に残った歩がこれより少なくなったら、続きを取りにいく */
export const REVIEW_PREFETCH_AT = 40;

/** 続きを取りにいくか（取っていない続きがあり、取りにいっている最中でなく、列が少なくなった） */
export function needMore(x: { next: number | null; fetching: boolean; queued: number }): boolean {
  return x.next !== null && !x.fetching && x.queued < REVIEW_PREFETCH_AT;
}

/** 見返しの進み具合（0〜100。遠征の始まりから終わりまでの、今描いている所の出来事の番号で） */
export function reviewProgress(seq: number | null | undefined, range: { startSeq: number; endSeq: number } | null | undefined): number {
  if (seq === null || seq === undefined || !range || range.endSeq <= range.startSeq) return 0;
  return Math.max(0, Math.min(100, Math.round(((seq - range.startSeq) / (range.endSeq - range.startSeq)) * 100)));
}

/** 見返しの速さ（「すぐに」は出さない: 見返しは、いつも列で流す） */
export const REVIEW_SPEEDS = ['slow', 'normal', 'fast'] as const;
export type ReviewSpeed = (typeof REVIEW_SPEEDS)[number];
export function reviewSpeedOf(s: string): ReviewSpeed {
  return (REVIEW_SPEEDS as readonly string[]).includes(s) ? (s as ReviewSpeed) : 'normal';
}

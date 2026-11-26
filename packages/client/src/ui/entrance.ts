// 入口の並べ替え（S16b。SEASON.md §70.4）: 画面から離した関数（テストする: test/entrance.test.ts）。
// - 道（ハッシュ）を読む: 4 つのタブ（拠点・リーダーボード・シーズン・図鑑）と、設定（歯車）・古い入口（#/legacy）。前の道（#/records・#/ops）は送り先を返す
// - シーズンのタブ: どのシーズンを最初に選ぶか・並べる順・順位の表の行とランを結ぶ・行のボタンを出す決まり
// - 図鑑のタブ: この PC の冒険者の図鑑を合わせる・だれが見つけたか・実績を冒険者ごとに
// だれが何を見られるかは、サーバーが決める（§25.1）。ここは、開けないものにボタンを出さないだけ（決まりは ui/replayRule.ts）。
import type { ProfileRecords, RunListing, SeasonListing, SeasonStandingRow } from '@muse/shared';
import { tr } from '../util';
import { rewindAllowed, watchAllowed } from './replayRule';

// ---------------- 道 ----------------

export type EntryPage = 'hub' | 'leaderboard' | 'season' | 'codex' | 'settings' | 'legacy';
export type Route =
  | { page: EntryPage; id: string | null; redirect?: string }
  | { page: 'play' | 'watch' | 'replay' | 'prepare'; id: string; redirect?: undefined };

/**
 * ハッシュを読む。#/season と #/season/<id> はシーズンのタブ。前の道は redirect（そこへ送る。古いリンクを切らない）:
 * #/records → #/season、#/ops → #/settings。知らない道は拠点
 */
export function parseRoute(hash: string): Route {
  // 壊れた ID（%E0%A4%A など）は decodeURIComponent が例外を出す: 白い画面にせず、拠点へ送る（S16d）
  const toHub: Route = { page: 'hub', id: null, redirect: '#/' };
  const m = /^#\/(play|watch|replay|prepare)\/([^/?#]+)/.exec(hash);
  if (m) {
    const id = safeDecode(m[2]);
    return id === null ? toHub : { page: m[1] as 'play' | 'watch' | 'replay' | 'prepare', id };
  }
  // 末尾が違う形（#/season/s4/x・#/season/s4?x）も、前と同じに、その ID のシーズンを開く（S16d）
  const s = /^#\/season(?:\/([^/?#]+))?(?:[/?#].*)?$/.exec(hash);
  if (s) {
    if (!s[1]) return { page: 'season', id: null };
    const id = safeDecode(s[1]);
    return id === null ? toHub : { page: 'season', id };
  }
  if (/^#\/records\/?$/.test(hash)) return { page: 'season', id: null, redirect: '#/season' };
  if (/^#\/ops\/?$/.test(hash)) return { page: 'settings', id: null, redirect: '#/settings' };
  for (const p of ['leaderboard', 'codex', 'settings', 'legacy'] as const) if (new RegExp(`^#/${p}/?$`).test(hash)) return { page: p, id: null };
  return { page: 'hub', id: null };
}

/** 道の ID を戻す。壊れた書き方なら null */
function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

// ---------------- シーズンのタブ ----------------

/**
 * 開催の新しい順（S16d）: 開催中のシーズンが先頭。ほかは、開いた時刻（一覧の openedAt）の新しい順。
 * 開いた時刻の無いシーズン（古い記録）が 1 つでもあれば、ID の数の大きい順（s10 > s2）。
 * 終わりの時刻の順にはしない（期間の長いシーズンは、後から開いたものより遅く終わる: 依頼者のデータで s0 が s2 の前に来た）
 */
export function seasonsNewestFirst<T extends { season: SeasonListing }>(xs: readonly T[]): T[] {
  const byOpened = xs.every((x) => typeof x.season.openedAt === 'number');
  const open = (x: T) => (x.season.status === 'open' ? 0 : 1);
  return [...xs].sort((a, b) => open(a) - open(b)
    || (byOpened ? (b.season.openedAt as number) - (a.season.openedAt as number) : 0)
    || cmpId(b.season.id, a.season.id));
}

/** ID を比べる（s2 < s10。数の部分は数として） */
function cmpId(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

/**
 * 最初に選ぶシーズン: 道に ID があり、一覧にあればそれ。無ければ、開催中のシーズン（新しいもの）、それも無ければ、いちばん新しいもの。
 * missing: 道の ID が一覧に無かった（画面は 1 行で知らせて、既定のシーズンを出す）
 */
export function pickSeasonId(list: readonly SeasonListing[], requested: string | null): { id: string | null; missing: boolean } {
  if (requested && list.some((s) => s.id === requested)) return { id: requested, missing: false };
  const sorted = seasonsNewestFirst(list.map((season) => ({ season })));
  const open = sorted.find((x) => x.season.status === 'open');
  return { id: (open ?? sorted[0])?.season.id ?? null, missing: !!requested };
}

/** 行のボタン（S17 で、開催中の自分のランの「見返す」を足す。種類を足しやすいように、並びで返す） */
export interface RunAction { kind: 'watch' | 'rewind'; label: string; href: string }

/**
 * そのランに出すボタン。決まりは今のまま（§25.1。ui/replayRule.ts）:
 * - 確定する前のシーズンの、進行中のランで、観戦できるもの（`watchAllowed`）: 「見守る」（その場の観戦。拠点と同じ言葉）
 * - 巻き戻しを開けるもの（`rewindAllowed`。確定したシーズンのランと、同じ PC から開いたときの、終わったラン）: 「見返す」
 * - どちらでもないもの（開催中で、見られないラン）: 何も出さない
 * status: 一覧に無く、ID だけ分かるランは null（確定したシーズンなら巻き戻せる。そうでなければ出さない）。
 * recoveryFailed: 起動時に復旧できなかったラン（見守るは出さない。記録は残っているので、見返すは決まりのまま）
 */
export function runActions(x: { season: string; final: boolean; local: boolean; runId: string; status: 'active' | 'ended' | null; recoveryFailed?: boolean; watchable: readonly string[] | null }): RunAction[] {
  const out: RunAction[] = [];
  if (!x.final && x.status === 'active' && !x.recoveryFailed && watchAllowed({ season: x.season, runId: x.runId, watchable: x.watchable })) {
    out.push({ kind: 'watch', label: tr('見守る', 'Watch'), href: `#/watch/${x.runId}` });
  }
  const rewind = x.status === null ? x.final : rewindAllowed({ season: x.season, status: x.status, final: x.final, local: x.local });
  if (rewind) out.push({ kind: 'rewind', label: tr('見返す', 'Look back'), href: `#/replay/${x.runId}` });
  return out;
}

/** 順位の表の名前を比べる形（home.tsx の normName と同じ） */
const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/**
 * 順位の表の行と、そのシーズンのランを結ぶ（記録のタブから移したもの）。行に runIds があればそれで（確定したシーズンと、同じ PC から。一覧に無いランは ID だけ）。
 * 無ければ、ランの参加者の名前（participantOf）と行の名前で。どちらも古い順。
 * unmatched: どの行とも結べなかったラン（runIds が無く、ランの名前が招いたときの表示名と違う）
 */
export function runsForRows(rows: readonly SeasonStandingRow[], runs: readonly RunListing[], participantOf: (r: RunListing) => string): { byRow: Map<string, (RunListing | string)[]>; unmatched: RunListing[] } {
  const sorted = [...runs].sort((a, b) => a.createdAt - b.createdAt);
  const listing = new Map(sorted.map((x) => [x.runId, x]));
  const byIds = new Set(rows.flatMap((r) => r.runIds ?? []));
  const byName = new Map<string, RunListing[]>();
  for (const x of sorted) {
    if (byIds.has(x.runId)) continue;
    const k = norm(participantOf(x));
    byName.set(k, [...(byName.get(k) ?? []), x]);
  }
  const byRow = new Map<string, (RunListing | string)[]>();
  for (const r of rows) byRow.set(r.name, r.runIds?.length ? r.runIds.map((id) => listing.get(id) ?? id) : byName.get(norm(r.name)) ?? []);
  const rowNames = new Set(rows.filter((r) => !r.runIds?.length).map((r) => norm(r.name)));
  const unmatched = sorted.filter((x) => !byIds.has(x.runId) && !rowNames.has(norm(participantOf(x))));
  return { byRow, unmatched };
}

// ---------------- 図鑑のタブ ----------------

/** 1 人分の図鑑（鍵ごとの `GET /api/profile/records` か、運用者の `GET /api/ops/codex` から） */
export interface CodexBook { id: string; name: string; codex: ProfileRecords['codex']; feats: ProfileRecords['feats']; record?: PersonRecord }

/**
 * 1 人ずつの記録（S16d: 前の「記録」のタブにあったもの。図鑑のタブの、冒険者ごとの札に、目立たせずに残す）。
 * 鍵ごとの口（GET /api/profile/records・/api/profile）から来たときだけ（運用者の図鑑の口には無い）
 */
export interface PersonRecord { runs: number; bestBanked: number; deepest: number; text: string; titles: string[] }

/** 記録の 1 行（ラン数・確定の最高・最深） */
export function personRecordLine(r: PersonRecord): string {
  return tr(`ラン ${r.runs}・確定の最高 ${r.bestBanked}・最深 地下${r.deepest}階`, `${r.runs} runs, best banked ${r.bestBanked}, deepest B${r.deepest}`);
}

export interface MergedEntry { id: string; name: string; finders: string[]; details: { who: string; detail: string }[] }
export interface MergedCategory { id: string; name: string; total: number; entries: MergedEntry[] }

/** 同じプロフィールは 1 つに（鍵の口と運用者の口の両方から来たとき。先に来たもの） */
export function uniqueBooks(books: readonly CodexBook[]): CodexBook[] {
  const seen = new Set<string>();
  return books.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
}

/**
 * 図鑑を合わせる。分類は最初の 1 人の並び（どのプロフィールも、同じ図鑑の索引から作られる）。項目は、見つけた人の名前（重ねない）と、
 * 人ごとの書き添え（種族の遭遇・撃破の数など。detail のあるものだけ）。項目の並びは、索引の順を崩さないように、その人の前の項目の後ろに差し込む
 */
export function mergeCodexBooks(books0: readonly CodexBook[]): MergedCategory[] {
  const books = uniqueBooks(books0);
  const cats: MergedCategory[] = [];
  for (const b of books) {
    for (const c of b.codex.categories) {
      let cat = cats.find((x) => x.id === c.id);
      if (!cat) { cat = { id: c.id, name: c.name, total: c.total, entries: [] }; cats.push(cat); }
      let prev: string | null = null;
      for (const e of c.entries) {
        let at = cat.entries.findIndex((x) => x.id === e.id);
        if (at < 0) {
          const after = prev === null ? -1 : cat.entries.findIndex((x) => x.id === prev);
          at = after + 1;
          cat.entries.splice(at, 0, { id: e.id, name: e.name, finders: [], details: [] });
        }
        const m = cat.entries[at];
        if (!m.finders.includes(b.name)) m.finders.push(b.name);
        if (e.detail) m.details.push({ who: b.name, detail: e.detail });
        prev = e.id;
      }
    }
  }
  return cats;
}

/** だれが見つけたか（小さく添える）: max 人までは名前、それより多ければ「A・B ほか N 人」 */
export function findersText(names: readonly string[], max = 2): string {
  if (names.length <= max) return names.join(tr('・', ', '));
  const rest = names.length - max;
  return tr(`${names.slice(0, max).join('・')} ほか ${rest} 人`, `${names.slice(0, max).join(', ')} and ${rest} more`);
}

/**
 * 実績は、冒険者ごとに分けて（合わせない）。取った実績が 1 つ以上ある人と、1 人ずつの記録がある人（S16d）だけ、取った数の多い順（同じなら名前の順）。
 * 記録は、同じプロフィールのどの本から来てもよい（運用者の口が先に来て、鍵の口が後から来ても、記録を落とさない）
 */
export function featsByPerson(books0: readonly CodexBook[]): { id: string; name: string; earned: { id: string; name: string; desc: string | null }[]; total: number; record?: PersonRecord }[] {
  const recordOf = new Map<string, PersonRecord>();
  for (const b of books0) if (b.record && !recordOf.has(b.id)) recordOf.set(b.id, b.record);
  return uniqueBooks(books0)
    .map((b) => {
      const record = recordOf.get(b.id);
      return { id: b.id, name: b.name, earned: b.feats.list.filter((f) => f.earned).map((f) => ({ id: f.id, name: f.name, desc: f.desc })), total: b.feats.total, ...(record ? { record } : {}) };
    })
    .filter((x) => x.earned.length > 0 || !!x.record)
    .sort((a, b) => b.earned.length - a.earned.length || a.name.localeCompare(b.name));
}

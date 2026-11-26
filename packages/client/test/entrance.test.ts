// S16b（SEASON.md §70.4）: 入口の並べ替え。画面から離した関数のテスト。
// 道（4 つのタブ・設定・古い入口・前の道の送り先）／どのシーズンを最初に選ぶか・並べる順／行のボタンを出す決まり（§25.1 のまま）／
// 順位の表の行とランを結ぶ／図鑑を合わせる・だれが見つけたか・実績は冒険者ごと
import { describe, expect, it } from 'vitest';
import type { ProfileRecords, RunListing, SeasonListing, SeasonStandingRow } from '@muse/shared';
import { featsByPerson, findersText, mergeCodexBooks, parseRoute, pickSeasonId, runActions, runsForRows, seasonsNewestFirst, type CodexBook } from '../src/ui/entrance';

const season = (id: string, status: SeasonListing['status'], endsAt: number): SeasonListing => ({ id, name: id, budget: 3000, endsAt, status, participants: 1, invited: 1 });

describe('S16b §70.4 の 1: the routes', () => {
  it('four tabs, the gear and the hidden old entrance; the old routes are sent on', () => {
    expect(parseRoute('#/')).toEqual({ page: 'hub', id: null });
    expect(parseRoute('')).toEqual({ page: 'hub', id: null });
    expect(parseRoute('#/leaderboard')).toEqual({ page: 'leaderboard', id: null });
    expect(parseRoute('#/codex')).toEqual({ page: 'codex', id: null });
    expect(parseRoute('#/settings')).toEqual({ page: 'settings', id: null });
    expect(parseRoute('#/legacy')).toEqual({ page: 'legacy', id: null });
    expect(parseRoute('#/season')).toEqual({ page: 'season', id: null });
    expect(parseRoute('#/season/')).toEqual({ page: 'season', id: null });
    expect(parseRoute('#/season/s4')).toEqual({ page: 'season', id: 's4' });
    // 古いリンクを切らない: 記録はシーズンへ、運用は設定へ
    expect(parseRoute('#/records')).toEqual({ page: 'season', id: null, redirect: '#/season' });
    expect(parseRoute('#/ops')).toEqual({ page: 'settings', id: null, redirect: '#/settings' });
    // 遊ぶ・観戦・巻き戻し・支度は、そのまま
    expect(parseRoute('#/watch/run_abc')).toEqual({ page: 'watch', id: 'run_abc' });
    expect(parseRoute('#/replay/run_abc')).toEqual({ page: 'replay', id: 'run_abc' });
    expect(parseRoute('#/prepare/run_abc')).toEqual({ page: 'prepare', id: 'run_abc' });
    expect(parseRoute('#/play/run_abc')).toEqual({ page: 'play', id: 'run_abc' });
    // 知らない道は拠点
    expect(parseRoute('#/nowhere')).toEqual({ page: 'hub', id: null });
    expect(parseRoute('#/codexx')).toEqual({ page: 'hub', id: null });
  });
});

describe('S16b §70.4 の 2: which season the season tab shows', () => {
  const list = [season('s1', 'final', 100), season('s3', 'final', 300), season('s4', 'open', 400), season('s2', 'final', 200)];
  it('newest first by the time it runs; opens on the running season, else the newest; the requested one if it exists', () => {
    expect(seasonsNewestFirst(list.map((s) => ({ season: s }))).map((x) => x.season.id)).toEqual(['s4', 's3', 's2', 's1']);
    // 同じ終わりの時刻なら、ID の大きい順（s10 は s9 より後）
    expect(seasonsNewestFirst([season('s9', 'final', 5), season('s10', 'final', 5)].map((s) => ({ season: s }))).map((x) => x.season.id)).toEqual(['s10', 's9']);
    expect(pickSeasonId(list, null)).toEqual({ id: 's4', missing: false });
    expect(pickSeasonId(list, 's2')).toEqual({ id: 's2', missing: false });
    // 開催中が無ければ、いちばん新しいもの（確定待ちも含む）
    const closed = [season('s1', 'final', 100), season('s2', 'ended', 200)];
    expect(pickSeasonId(closed, null)).toEqual({ id: 's2', missing: false });
    // 知らない ID: 既定のシーズンを出して、知らせる
    expect(pickSeasonId(list, 'zz')).toEqual({ id: 's4', missing: true });
    expect(pickSeasonId([], null)).toEqual({ id: null, missing: false });
  });
});

describe('S16b §70.4 の 2: the buttons on a standings row (who can see what is unchanged: §25.1)', () => {
  const base = { season: 's4', local: false, runId: 'run_a', watchable: ['run_a'] as string[] | null };
  it('a running season: "Watch" only for a run you may watch; nothing for the others', () => {
    expect(runActions({ ...base, final: false, status: 'active' })).toEqual([{ kind: 'watch', label: '見守る', href: '#/watch/run_a' }]);
    expect(runActions({ ...base, final: false, status: 'active', watchable: ['run_b'] })).toEqual([]);
    // 観戦できるランの一覧が分からない
    expect(runActions({ ...base, final: false, status: 'active', watchable: null })).toEqual([]);
    // 終わったランは、外からは見返せない（巻き戻しは確定の後）
    expect(runActions({ ...base, final: false, status: 'ended' })).toEqual([]);
    // 起動時に復旧できなかったランは、見守らない
    expect(runActions({ ...base, final: false, status: 'active', recoveryFailed: true })).toEqual([]);
    // ID だけ分かるランは、確定の前は出さない
    expect(runActions({ ...base, final: false, status: null })).toEqual([]);
  });
  it('the server PC keeps what it has today: an ended run of a running season can be looked back on', () => {
    expect(runActions({ ...base, local: true, final: false, status: 'ended' })).toEqual([{ kind: 'rewind', label: '見返す', href: '#/replay/run_a' }]);
    expect(runActions({ ...base, local: true, final: false, status: 'active' }).map((a) => a.kind)).toEqual(['watch']);
  });
  it('a final season: "Look back" (the replay) for every run, also one known only by its ID; no "Watch"', () => {
    for (const status of ['active', 'ended', null] as const) {
      expect(runActions({ ...base, final: true, status })).toEqual([{ kind: 'rewind', label: '見返す', href: '#/replay/run_a' }]);
    }
  });
});

describe('S16b: matching standings rows to runs (moved from the records tab)', () => {
  const run = (runId: string, name: string, createdAt: number): RunListing => ({ runId, season: 's4', createdAt, players: [{ name }] } as unknown as RunListing);
  const row = (name: string, runIds?: string[]): SeasonStandingRow => ({ name, ...(runIds ? { runIds } : {}) } as unknown as SeasonStandingRow);
  it('by runIds when the row has them (an ID not in the listing stays an ID), else by the participant name; oldest first; the rest are unmatched', () => {
    const runs = [run('run_2', 'ミュゼ美', 20), run('run_1', 'ミュゼ美', 10), run('run_3', 'ツバキ', 30), run('run_4', 'だれか', 40)];
    const { byRow, unmatched } = runsForRows([row('ミュゼ美'), row('ツバキ', ['run_3', 'run_9'])], runs, (r) => r.players[0].name);
    expect(byRow.get('ミュゼ美')!.map((x) => (typeof x === 'string' ? x : x.runId))).toEqual(['run_1', 'run_2']);
    expect(byRow.get('ツバキ')!.map((x) => (typeof x === 'string' ? x : x.runId))).toEqual(['run_3', 'run_9']);
    expect(unmatched.map((x) => x.runId)).toEqual(['run_4']);
    // 名前は NFKC・大文字小文字をそろえて比べる
    expect(runsForRows([row('MUSE')], [run('run_5', 'ｍｕｓｅ', 1)], (r) => r.players[0].name).byRow.get('MUSE')!.length).toBe(1);
  });
});

describe('S16b §70.4 の 4: the codex of the adventurers on this PC, put together', () => {
  const codex = (cats: { id: string; entries: { id: string; name: string; detail?: string }[]; total?: number }[]): ProfileRecords['codex'] => ({
    found: cats.reduce((a, c) => a + c.entries.length, 0), total: 0,
    categories: cats.map((c) => ({ id: c.id as 'species', name: c.id, found: c.entries.length, total: c.total ?? 10, entries: c.entries })),
  });
  const feats = (earned: string[], total = 5): ProfileRecords['feats'] => ({
    earned: earned.length, total, list: [...earned.map((id) => ({ id, name: id, desc: `${id}の説明`, earned: true })), { id: 'x', name: 'x', desc: null, earned: false }],
  });
  const a: CodexBook = { id: 'prof_a', name: 'ミュゼ美', codex: codex([{ id: 'species', entries: [{ id: 'rat', name: 'ネズミ', detail: '遭遇 3' }, { id: 'bat', name: 'コウモリ' }] }, { id: 'items', entries: [] }]), feats: feats(['f1', 'f2']) };
  const b: CodexBook = { id: 'prof_b', name: 'ツバキ', codex: codex([{ id: 'species', entries: [{ id: 'rat', name: 'ネズミ', detail: '遭遇 1' }, { id: 'imp', name: '小悪魔' }, { id: 'bat', name: 'コウモリ' }] }, { id: 'items', entries: [{ id: 'pot', name: '薬' }] }]), feats: feats([]) };
  it('merges entries, notes who found each, keeps the index order, and counts one profile once', () => {
    const cats = mergeCodexBooks([a, b, a]);
    expect(cats.map((c) => c.id)).toEqual(['species', 'items']);
    const sp = cats[0];
    expect(sp.total).toBe(10);
    // 小悪魔は、ツバキの並びで「ネズミ」の後ろ（コウモリの前）に入る
    expect(sp.entries.map((e) => e.id)).toEqual(['rat', 'imp', 'bat']);
    expect(sp.entries[0]).toEqual({ id: 'rat', name: 'ネズミ', finders: ['ミュゼ美', 'ツバキ'], details: [{ who: 'ミュゼ美', detail: '遭遇 3' }, { who: 'ツバキ', detail: '遭遇 1' }] });
    expect(sp.entries[1].finders).toEqual(['ツバキ']);
    expect(cats[1].entries.map((e) => [e.id, e.finders])).toEqual([['pot', ['ツバキ']]]);
    expect(mergeCodexBooks([])).toEqual([]);
  });
  it('who found it: names up to two, then "and N more"', () => {
    expect(findersText(['A'])).toBe('A');
    expect(findersText(['A', 'B'])).toBe('A・B');
    expect(findersText(['A', 'B', 'C', 'D'])).toBe('A・B ほか 2 人');
  });
  it('feats stay per adventurer (not merged): only those with a feat, most first', () => {
    const c: CodexBook = { ...b, id: 'prof_c', name: 'カエデ', feats: feats(['f1']) };
    expect(featsByPerson([c, a, b, a])).toEqual([
      { id: 'prof_a', name: 'ミュゼ美', earned: [{ id: 'f1', name: 'f1', desc: 'f1の説明' }, { id: 'f2', name: 'f2', desc: 'f2の説明' }], total: 5 },
      { id: 'prof_c', name: 'カエデ', earned: [{ id: 'f1', name: 'f1', desc: 'f1の説明' }], total: 5 },
    ]);
  });
});

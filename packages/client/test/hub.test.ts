// S10（SEASON.md §58.4）: 拠点の冒険者の札（状態 → 文とボタン）と、支度の画面の上の状態・段ごとの 1 行。画面から離した関数のテスト。
// §58.4 の表の 6 つの状態・人間が自分で遊ぶ冒険者・運用者の札・招かれていない冒険者
import { describe, expect, it } from 'vitest';
import type { OwnerRunRow } from '@muse/shared';
import { hubCard, membershipFor, pickSeason, seasonLeftText } from '../src/ui/hubState';
import { prepHead, prepLine } from '../src/ui/prepState';

const season = { id: 's4', status: 'open' as const, budget: 1000 };
function row(p: Partial<OwnerRunRow> = {}): OwnerRunRow {
  return {
    runId: 'run_abc', playerId: 'p1', name: 'ミュゼ美', classId: 'core:warrior', season: { id: 's4', name: 'S4', participant: 'ミュゼ美' },
    status: 'at_camp', eligible: true, waiting: false, hold: [], message: '',
    level: 3, hp: 30, maxHp: 30, depth: null, banked: 120, budgetLeft: 820, budgetLimit: 1000, updatedAt: 1, ...p,
  };
}
const base = { name: 'ミュゼ美', season, playable: false, rank: 2 };

describe('S10 §58.4: the adventurer card on the hub', () => {
  it('not in the season yet: "let your AI know; you can go down yourself" and one button to go down yourself', () => {
    const m = hubCard({ ...base, row: null, membership: { used: 0, budget: 1000, died: false, runs: 0 }, rank: null });
    expect(m.state).toBe('not_joined');
    expect(m.where).toBe('まだ、このシーズンに入っていない');
    expect(m.text).toBe('AI に、声をかける（AI が、鍵を使って入ってくる）。自分で潜ることもできる');
    expect(m.action).toEqual({ label: '自分で潜る', dive: true });
    expect(m.stats).toEqual({ level: null, banked: 0, budget: { left: 1000, limit: 1000 }, rank: null });
    // 前の冒険が倒れて終わり、予算が残っている: もう一度入れる
    const fell = hubCard({ ...base, row: null, membership: { used: 300, budget: 1000, died: true, runs: 1 }, banked: 40 });
    expect(fell.state).toBe('not_joined');
    expect(fell.where).toBe('前の冒険は、倒れて終わった');
    expect(fell.stats.budget).toEqual({ left: 700, limit: 1000 });
    expect(fell.stats.banked).toBe(40);
    // 招きが分からない（読めなかった）ときも、まだ入っていない札
    expect(hubCard({ ...base, row: null, membership: undefined }).state).toBe('not_joined');
  });

  it('not invited: says so, no way to go down', () => {
    const m = hubCard({ ...base, row: null, membership: null });
    expect(m.state).toBe('not_invited');
    expect(m.where).toBe('このシーズンには、まだ招かれていない');
    expect(m.action.dive).toBeUndefined();
  });

  it('at camp, nothing held: the AI decides and sets out; the button is to prepare', () => {
    const m = hubCard({ ...base, row: row() });
    expect(m.state).toBe('camp_free');
    expect(m.where).toBe('キャンプにいる');
    expect(m.text).toBe('次の遠征は、ミュゼ美が、自分で決めて出発する');
    expect(m.action).toEqual({ label: '支度をする', href: '#/prepare/run_abc' });
    expect(m.highlight).toBe(false);
    expect(m.stats).toEqual({ level: 3, banked: 120, budget: { left: 820, limit: 1000 }, rank: 2 });
  });

  it('at camp, preparations not ready: stands out, says what is undecided and whether the AI is there', () => {
    const m = hubCard({ ...base, row: row({ hold: ['perks'], prep: { state: 'pending' }, waiting: true, undecided: { perk: { level: 2, options: 3, more: 0 }, text: '' }, ai: { lastCallAgoS: 5, waitingNow: true }, wishes: 1 }) });
    expect(m.state).toBe('camp_pending');
    expect(m.highlight).toBe(true);
    expect(m.pill).toEqual({ text: '支度: まだ', tone: 'amber' });
    expect(m.text).toBe('あなたの支度を、待っている');
    expect(m.notes).toEqual(['決めていないもの: 特技（Lv2 の候補 3 つ）', 'AI は、いま wait_for_turn で、あなたの支度を待っている']);
    expect(m.wish).toBe(true);
    expect(m.action).toEqual({ label: '支度をする', href: '#/prepare/run_abc' });
  });

  it('at camp, ready: "sets out when they come; let your AI know", the time since the AI\'s last call, and a button to review', () => {
    const m = hubCard({ ...base, row: row({ hold: ['objective'], prep: { state: 'ready', objective: 2 }, ai: { lastCallAgoS: 180, waitingNow: false } }) });
    expect(m.state).toBe('camp_ready');
    expect(m.pill).toEqual({ text: '準備完了', tone: 'green' });
    expect(m.text).toBe('準備完了。ミュゼ美が来たら、出発する。AI に、声をかける');
    expect(m.notes).toEqual(['AI の最後の呼び出し: 3 分前']);
    expect(m.action).toEqual({ label: '支度を見直す', href: '#/prepare/run_abc' });
    expect(m.wish).toBe(false);
  });

  it('in the dungeon: "making their way through depth 3" and a button to watch', () => {
    const m = hubCard({ ...base, row: row({ status: 'in_dungeon', depth: 3, hold: ['perks'] }) });
    expect(m.state).toBe('dungeon');
    expect(m.pill).toEqual({ text: '迷宮の中', tone: 'blue' });
    expect(m.where).toBe('地下3階を進んでいる');
    expect(m.text).toBeNull();
    expect(m.action).toEqual({ label: '見守る', href: '#/watch/run_abc' });
  });

  it('budget used up or the season is over: a result line and a button to see the results', () => {
    const used = hubCard({ ...base, row: row({ hold: ['perks'], prep: { state: 'pending' }, budgetLeft: 0 }) });
    expect(used.state).toBe('over');
    expect(used.text).toBe('このシーズンの手番を、使い切った。持ち帰った点 120');
    expect(used.action).toEqual({ label: '結果を見る', href: '#/season/s4' });
    expect(used.highlight).toBe(false);
    const ended = hubCard({ ...base, season: { ...season, status: 'ended' }, row: row() });
    expect(ended.state).toBe('over');
    expect(ended.text).toBe('シーズンが終わった。結果を待っている');
    // ランが無いとき
    expect(hubCard({ ...base, season: { ...season, status: 'ended' }, row: null, membership: { used: 10, budget: 1000, died: false, runs: 1 } }).state).toBe('over');
    const spent = hubCard({ ...base, row: null, membership: { used: 1000, budget: 1000, died: false, runs: 2 } });
    expect(spent.state).toBe('over');
    expect(spent.where).toBe('このシーズンの手番を、使い切った');
    expect(spent.stats.budget).toEqual({ left: 0, limit: 1000 });
  });

  it('an adventurer the person plays: "continue" (to the play screen), no directive; watch when this browser cannot play it', () => {
    const m = hubCard({ ...base, playable: true, row: row({ eligible: false }) });
    expect(m.state).toBe('human');
    expect(m.action).toEqual({ label: '続きを遊ぶ', href: '#/play/run_abc' });
    expect(m.notes).toEqual([]);
    const far = hubCard({ ...base, playable: false, row: row({ eligible: false, status: 'in_dungeon', depth: 2 }) });
    expect(far.action).toEqual({ label: '見守る', href: '#/watch/run_abc' });
    expect(far.where).toBe('地下2階を進んでいる');
    expect(far.notes).toEqual(['このブラウザでは、続きを遊べない（始めたブラウザで遊ぶ）']);
  });

  it('an operator\'s card (no membership known) works from the row alone', () => {
    const m = hubCard({ name: 'カエデ', season, row: row({ name: 'カエデ', hold: ['objective'], prep: { state: 'pending' }, undecided: { objective: true, text: '' } }), playable: false, rank: null });
    expect(m.state).toBe('camp_pending');
    expect(m.notes).toEqual(['決めていないもの: 次の遠征の目的']);
    expect(m.action.href).toBe('#/prepare/run_abc');
  });
});

describe('S10: which season a card shows, and the time left', () => {
  const cur = [{ id: 'a', status: 'open' as const }, { id: 'b', status: 'open' as const }, { id: 'c', status: 'ended' as const }];
  it('the season with the adventurer\'s run, then an open season they are invited to, then any invited, then the top one', () => {
    expect(pickSeason(cur, [{ season: { id: 'c', name: 'C' } }], [{ id: 'a' }])?.id).toBe('c');
    expect(pickSeason(cur, [], [{ id: 'c' }, { id: 'b' }])?.id).toBe('b');
    expect(pickSeason(cur, [], [{ id: 'c' }])?.id).toBe('c');
    expect(pickSeason(cur, [], undefined)?.id).toBe('a');
    expect(pickSeason([], [], undefined)).toBeNull();
    expect(membershipFor(undefined, 'a')).toBeUndefined();
    expect(membershipFor([{ id: 'b' }], 'a')).toBeNull();
    expect(membershipFor([{ id: 'a' }], 'a')).toEqual({ id: 'a' });
  });
  it('days, hours, minutes, past the end, final', () => {
    const now = 1_000_000_000_000;
    expect(seasonLeftText({ status: 'open', endsAt: now + 3 * 86_400_000 + 5 }, now)).toBe('あと 3 日');
    expect(seasonLeftText({ status: 'open', endsAt: now + 5 * 3_600_000 }, now)).toBe('あと 5 時間');
    expect(seasonLeftText({ status: 'open', endsAt: now + 90_000 }, now)).toBe('あと 1 分');
    expect(seasonLeftText({ status: 'ended', endsAt: now - 1 }, now)).toBe('終わりの時刻を過ぎた（結果を待っている）');
    expect(seasonLeftText({ status: 'final', endsAt: now - 1 }, now)).toBe('終わった（結果が出た）');
  });
});

describe('S10 §58.4: the preparations screen', () => {
  const head = { name: 'ミュゼ美', eligible: true, status: 'at_camp' as const, depth: null, hold: [] as ('objective' | 'loadout' | 'perks')[], prep: null, season: { budgetLeft: 500, ended: false } };
  it('the state at the top, and whether things can be decided', () => {
    expect(prepHead(head)).toMatchObject({ kind: 'free', editable: true, line: '全部、任せている。ミュゼ美は、自分で決めて出発する' });
    expect(prepHead({ ...head, hold: ['perks'], prep: 'pending' })).toMatchObject({ kind: 'pending', editable: true, pill: { text: '支度: まだ', tone: 'amber' } });
    expect(prepHead({ ...head, hold: ['perks'], prep: 'ready' })).toMatchObject({ kind: 'ready', editable: true, line: '準備完了。ミュゼ美が来たら、出発する' });
    expect(prepHead({ ...head, status: 'in_dungeon', depth: 3, hold: ['perks'] })).toMatchObject({ kind: 'watch', editable: false, line: '遠征の途中は、見守る。支度は、キャンプに戻ってから', pill: { text: '迷宮の中・地下3階', tone: 'blue' } });
    expect(prepHead({ ...head, season: { budgetLeft: 0, ended: false } })).toMatchObject({ kind: 'closed', editable: false, line: 'このシーズンの手番を、使い切った。もう出発しない' });
    expect(prepHead({ ...head, season: { budgetLeft: 10, ended: true } })).toMatchObject({ kind: 'closed', editable: false });
    expect(prepHead({ ...head, status: 'in_dungeon', season: { budgetLeft: 10, ended: true, final: true } })).toMatchObject({ kind: 'closed', line: 'このシーズンは終わった。記録は、見返せる' });
    expect(prepHead({ ...head, status: 'ended' })).toMatchObject({ kind: 'closed', editable: false });
    expect(prepHead({ ...head, eligible: false })).toMatchObject({ kind: 'human', editable: false });
    // シーズンでないラン
    expect(prepHead({ ...head, season: null, hold: ['objective'], prep: 'pending' }).kind).toBe('pending');
  });

  it('one line per section ("Muse decides", "mace and leather armor", "no perks — the 3 Lv2 options not chosen")', () => {
    const x = { name: 'ミュゼ美', held: false, equipment: ['鎚矛', '革の鎧'], perks: [], boons: [] };
    expect(prepLine('objective', x)).toBe('ミュゼ美が決める');
    expect(prepLine('objective', { ...x, held: true })).toBe('まだ選んでいない ― 候補から 1 つ選ぶ');
    expect(prepLine('objective', { ...x, held: true, chosen: '候補 2: 地下3階の遺物を見つけ、持ったまま階段から帰還する' })).toBe('選んだ: 候補 2: 地下3階の遺物を見つけ、持ったまま階段から帰還する');
    expect(prepLine('loadout', { ...x, held: true })).toBe('鎚矛・革の鎧');
    expect(prepLine('loadout', x)).toBe('鎚矛・革の鎧（ミュゼ美が決める）');
    expect(prepLine('loadout', { ...x, held: true, gear: 2 })).toBe('鎚矛・革の鎧 ― 新しく持ち物に入った装備 2 品を、まだ決めていない');
    expect(prepLine('loadout', { ...x, held: true, equipment: [] })).toBe('何も身に着けていない');
    expect(prepLine('perks', { ...x, held: true, perkPending: { level: 2, options: 3 } })).toBe('特技なし ― Lv2 の候補 3 つを選んでいない');
    expect(prepLine('perks', { ...x, held: true, perks: ['頑健'], boons: ['火の加護'], boonPending: { depth: 5, options: 3 } })).toBe('頑健・火の加護 ― 加護の候補 3 つを選んでいない');
    expect(prepLine('perks', { ...x, perks: ['頑健'] })).toBe('頑健（ミュゼ美が決める）');
  });
});

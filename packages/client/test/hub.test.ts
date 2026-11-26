// S10（SEASON.md §58.4）: 拠点の冒険者の札（状態 → 文とボタン）と、支度の画面の上の状態・段ごとの 1 行。画面から離した関数のテスト。
// §58.4 の表の 6 つの状態・人間が自分で遊ぶ冒険者・運用者の札・招かれていない冒険者
import { describe, expect, it } from 'vitest';
import type { OwnerRunRow } from '@muse/shared';
import { awardCell, hubCard, membershipFor, noSeasonText, participantName, pickSeason, seasonLeftText } from '../src/ui/hubState';
import { directiveToggle, messageSave, prepHead, prepLine, readyNudge, readyNudgeCopy } from '../src/ui/prepState';
import { screenErrOf } from '../src/ui/screenErr';

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

  it('not invited (S12a): says what is happening and what to do, without the word "not invited"; no way to go down', () => {
    const m = hubCard({ ...base, row: null, membership: null });
    expect(m.state).toBe('not_invited');
    expect(m.where).toBe('このシーズンの名簿に、まだ入っていない');
    expect(m.pill.text).toBe('名簿に無い');
    // ほかの PC から（local が無い・false）
    expect(m.text).toBe('このシーズンを開いた人に、加えてもらう');
    expect(m.action.dive).toBeUndefined();
    // サーバーと同じ PC から: 自分が開いたなら、運用の道具で招く
    const local = hubCard({ ...base, row: null, membership: null, local: true });
    expect(local.text).toBe('このシーズンを開いたのが自分なら、運用の道具で、冒険者を招く（README の「開発用コマンド」の season）');
    for (const x of [m, local]) {
      expect(`${x.pill.text} ${x.where} ${x.text}`).not.toContain('招かれていない');
      expect(`${x.pill.text} ${x.where} ${x.text}`).not.toContain('機械');
    }
  });

  it('no season running (S12a): from the server PC, how to open one; from another PC, who opens it', () => {
    expect(noSeasonText(true)).toBe('シーズンは、運用の道具で開く（README の「開発用コマンド」の season）。シーズンでない冒険は、右上の歯車（運用）から。');
    expect(noSeasonText(false)).toBe('シーズンを開いた人が、次のシーズンを開いたら、ここに冒険者の札が出る。シーズンでない冒険は、右上の歯車（運用）から。');
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
    expect(m.notes).toEqual(['決めていないもの: 特技（Lv2 の候補 3 つ）', 'ミュゼ美は、今、あなたの支度を待っている']);
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
    expect(prepLine('perks', { ...x, held: true, perks: ['頑健'], boons: ['火の加護'], boonPending: { depth: 5, options: 3 } })).toBe('特技: 頑健 ／ 加護: 火の加護 ― 加護の候補 3 つを選んでいない');
    expect(prepLine('perks', { ...x, perks: ['頑健'] })).toBe('特技: 頑健（ミュゼ美が決める）');
  });
});

describe('S10a: the inspection fixes', () => {
  it('§1: a switch adds or removes only the pressed item on top of the freshly read directive, and keeps the server message (never the stale screen values)', () => {
    // 画面は古い値（hold [], message 'A'）のまま。ほかのタブが loadout を握り、伝言を 'B' にした
    const fresh = { hold: ['loadout'] as ('objective' | 'loadout' | 'perks')[], message: 'B' };
    expect(directiveToggle(fresh, 'perks', true)).toEqual({ hold: ['loadout', 'perks'], message: 'B' });
    expect(directiveToggle(fresh, 'objective', true)).toEqual({ hold: ['objective', 'loadout'], message: 'B' });
    expect(directiveToggle(fresh, 'loadout', false)).toEqual({ hold: [], message: 'B' });
    // もうそうなっていれば送らない
    expect(directiveToggle(fresh, 'loadout', true)).toBeNull();
    expect(directiveToggle(fresh, 'perks', false)).toBeNull();
    expect(directiveToggle(undefined, 'perks', true)).toEqual({ hold: ['perks'], message: '' });
    // 伝言を残す: 握る項目は読み直した値のまま、伝言だけ
    expect(messageSave(fresh, 'C')).toEqual({ hold: ['loadout'], message: 'C' });
    expect(messageSave(fresh, 'B')).toBeNull();
    expect(messageSave({ hold: ['perks', 'objective'], message: '' }, 'x'.repeat(300))).toEqual({ hold: ['objective', 'perks'], message: 'x'.repeat(280) });
  });

  it('§3・§4: an older-version run and a run the server could not load get their own cards, with no way to go down', () => {
    const stale = hubCard({ ...base, row: row({ oldVersion: true, continuable: false, hold: ['objective'], prep: { state: 'pending' } }) });
    expect(stale.state).toBe('stale');
    expect(stale.where).toBe('前の版の冒険（続きは、遊べない）');
    expect(stale.action).toEqual({ label: '記録を見る', href: '#/records' });
    expect(stale.highlight).toBe(false);
    // 版が違えば、人間のランでも「続きを遊ぶ」は出さない
    expect(hubCard({ ...base, playable: true, row: row({ oldVersion: true, eligible: false }) }).state).toBe('stale');
    // 続きを遊べる・予算切れの continuable false は、今までどおり
    expect(hubCard({ ...base, row: row({ continuable: true }) }).state).toBe('camp_free');
    expect(hubCard({ ...base, row: row({ continuable: false, budgetLeft: 0 }) }).state).toBe('over');
    const failed = hubCard({ ...base, row: null, membership: { used: 10, budget: 1000, died: false, runs: 1, failed: true } });
    expect(failed.state).toBe('unreadable');
    expect(failed.where).toBe('前の冒険は、サーバーの起動時に読み込めなかった（運用者に知らせる）');
    expect(failed.action.dive).toBeUndefined();
    // 支度の画面も、見るだけ
    expect(prepHead({ name: 'ミュゼ美', eligible: true, status: 'at_camp', depth: null, hold: ['objective'], prep: 'pending', season: null, oldVersion: true }))
      .toMatchObject({ kind: 'closed', editable: false, line: '前の版で始まった冒険。このサーバーでは、続きを遊べない（記録は、見返せる）' });
  });

  it('§6: the server\'s refusals become words of the screen', () => {
    expect(screenErrOf(401, 'no_session', 'unknown or missing profile token')).toBe('その鍵は、見つからない。運用者から受け取ったものか、確かめる');
    expect(screenErrOf(403, 'bad_request', 'この口は、そのランのプレイヤーのプロフィールのトークンか… / owner access needs…')).toBe('この冒険者の鍵が、このブラウザに無い。拠点で、鍵を入れる');
    expect(screenErrOf(404, 'no_session', 'unknown or finished run')).toBe('この冒険者は、見つからない（冒険が終わったか、このサーバーに無い）');
    expect(screenErrOf(409, 'run_ended', '')).toBe('この冒険は、終わった。記録で見返せる');
    expect(screenErrOf(503, 'recovery_failed', '')).toBe('この冒険は、サーバーの起動時に読み込めなかった（運用者に知らせる）');
    expect(screenErrOf(409, 'season_unavailable', 'このプロフィール（prof_x）は、シーズン s4 に招かれていない。… / not invited')).toBe('この冒険者は、このシーズンの名簿に、まだ入っていない。このシーズンを開いた人に、加えてもらう');
    expect(screenErrOf(409, 'season_unavailable', 'このシーズンの行動予算（60 手番）を使い切っている / budget used up')).toBe('このシーズンの手番を、使い切った');
    expect(screenErrOf(409, 'season_unavailable', 'シーズン s4 は終わっている / season s4 has ended')).toBe('このシーズンは、終わった');
    expect(screenErrOf(409, 'season_unavailable', 'something else')).toBe('このシーズンには、いま入れない（運用者に確かめる）');
    expect(screenErrOf(400, 'bad_request', 'name is required')).toBeNull();
  });

  it('§7: without a run or an invitation, a name alone does not tie a standings row to the card', () => {
    expect(participantName(null, undefined)).toBeNull();
    expect(participantName(null, null)).toBeNull();
    expect(participantName(null, { name: 'ミナ' })).toBe('ミナ');
    expect(participantName(row({ name: 'Su', season: { id: 's4', name: 'S4', participant: 'ミナ' } }), null)).toBe('ミナ');
    expect(participantName(row({ name: 'Su', season: { id: 's4', name: 'S4' } }), undefined)).toBe('Su');
  });

  it('c: "1st  depth 1" — the rank small, the value first; a value of 0 shows "—" without a rank', () => {
    expect(awardCell({ value: 1, rank: 1 }, (v) => `地下 ${v} 階`)).toEqual({ rank: '1 位', value: '地下 1 階' });
    expect(awardCell({ value: 3, rank: 2 }, String)).toEqual({ rank: '2 位', value: '3' });
    expect(awardCell({ value: 0, rank: 1 }, String)).toEqual({ rank: null, value: '—' });
    expect(awardCell(undefined, String)).toEqual({ rank: null, value: '—' });
  });
});

describe('S12a §63.2 の 2: the window after "Ready"', () => {
  const x = { name: 'ミュゼ美', sent: true, ok: true, before: 'pending' as const, after: 'ready' as const, aiWaiting: false };
  it('pressing Ready and passing: "let (name) know", what to do, and a sentence to copy', () => {
    expect(readyNudge(x)).toEqual({
      title: 'ミュゼ美に、声をかける',
      body: '支度は済んだ。ミュゼ美が来たら、出発する。画面からは、ミュゼ美を呼べない。チャットなどで、遊ぶように伝える',
      copy: '支度ができたよ。MuseDungeon の続きを遊んで。',
    });
    expect(readyNudgeCopy()).toBe('支度ができたよ。MuseDungeon の続きを遊んで。');
  });
  it('the AI is already waiting: it sets out at once, nothing to copy', () => {
    expect(readyNudge({ ...x, aiWaiting: true })).toEqual({ title: 'ミュゼ美に、声をかける', body: 'ミュゼ美は、今、待っている。すぐに出発する', copy: null });
  });
  it('not shown: refused, not pressing Ready (review / choosing an objective), already ready, or still not ready', () => {
    expect(readyNudge({ ...x, ok: false })).toBeNull();
    expect(readyNudge({ ...x, sent: false })).toBeNull();
    // 決めるものが無くて、最初から準備完了だったキャンプ（押していない・押す前から準備完了）
    expect(readyNudge({ ...x, before: 'ready' })).toBeNull();
    expect(readyNudge({ ...x, after: 'pending' })).toBeNull();
    expect(readyNudge({ ...x, after: null })).toBeNull();
    // 前の読み込みが無くても、押して準備完了になったら出す
    expect(readyNudge({ ...x, before: null })).not.toBeNull();
  });
});
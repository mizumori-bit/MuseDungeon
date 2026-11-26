// S15（SEASON.md §68.2 の 2）: 観戦の、命令ごとの 1 行と、場面の帯。決める所（命令 → 1 行・前後の見え方 → 帯）は、画面から離した関数（ui/watchLines.ts）。
// 再生の列（ui/playback.ts）の stepsIn（命令の行を組むときに、列に残った同じ命令の歩を見る）も、ここで確かめる
import { afterEach, describe, expect, it } from 'vitest';
import type { PlayerView } from '@muse/shared';
import { PlaybackQueue } from '../src/ui/playback';
import { setLocale } from '../src/util';
import {
  ACT_RESULT_MAX, actionLabel, actionLine, actionResult, bannerSnap, insertBySeq, isWorldTool, returnedOf, sceneBanners, type BannerSnap,
} from '../src/ui/watchLines';

afterEach(() => setLocale('ja'));

describe('S15 §68.2 の 2: one line per command', () => {
  it('names the MCP tools in people\'s words (ja/en); unknown names as they are; calls that do not move the world are left out', () => {
    expect(actionLabel('explore')).toBe('探索');
    expect(actionLabel('fight')).toBe('戦う');
    expect(actionLabel('travel_to')).toBe('移動');
    expect(actionLabel('use_item')).toBe('使う');
    expect(actionLabel('throw_item')).toBe('投げる');
    expect(actionLabel('extract')).toBe('帰還');
    expect(actionLabel('start_expedition')).toBe('遠征を始める');
    expect(actionLabel('rest')).toBe('休む');
    // 帰り方が分かれば、言い換える（帰還の綱は use_item。撤退は extract）
    expect(actionLabel('use_item', { returned: 'lifeline' })).toBe('帰還の綱');
    expect(actionLabel('extract', { returned: 'withdrew' })).toBe('撤退');
    expect(actionLabel('extract', { returned: 'extracted' })).toBe('帰還');
    expect(actionLabel('brand_new_tool')).toBe('brand_new_tool');
    for (const t of ['observe', 'get_rules', 'notes', 'wait_for_turn', 'look', 'get_map', 'inventory', 'recall', 'get_messages', 'expedition', 'review', 'records', 'profile', 'say']) expect(isWorldTool(t)).toBe(false);
    for (const t of ['explore', 'fight', 'equip', 'choose_perk', 'use_item', 'extract', 'brand_new_tool']) expect(isWorldTool(t)).toBe(true);
    expect(actionLine({ tool: 'observe', text: '結果: 何か' })).toBeNull();
    setLocale('en');
    expect(actionLabel('explore')).toBe('Explore');
    expect(actionLabel('use_item', { returned: 'lifeline' })).toBe('Lifeline');
    expect(actionResult('Error [bad_request] Invalid argument: offer')).toBe('Refused: Invalid argument: offer');
  });

  it('the result is the "結果:" line (the command-type prefix of a macro dropped), or the first line; a refusal is "断られた: …"; cut at 120 chars', () => {
    const text = '結果: explore: 12 手進んだ（12 歩、時間 120）。停止: 敵が視界に入った。\n地下1階 石の広間\nHP 30/30';
    expect(actionResult(text)).toBe('12 手進んだ（12 歩、時間 120）。停止: 敵が視界に入った。');
    expect(actionLine({ tool: 'explore', text })).toBe('▶ 探索: 12 手進んだ（12 歩、時間 120）。停止: 敵が視界に入った。');
    expect(actionResult('Result: travel: 3 steps. Stopped: an enemy came into view.\n...')).toBe('3 steps. Stopped: an enemy came into view.');
    // 断られた命令（手番を使わない）
    const err = 'エラー [not_adjacent] 隣に敵がいない。\nヒント: travel_to で近づく\nできること: explore / rest';
    expect(actionLine({ tool: 'fight', text: err })).toBe('▶ 戦う: 断られた: 隣に敵がいない。');
    // 引数の形の断り（サーバーの記録は `code 文` の形）: 最初の 1 文だけ
    expect(actionLine({ tool: 'fight', text: 'bad_request fight には target が要る（渡されていない）。このツールの引数: 要る: target／要らない（任意）: with' }))
      .toBe('▶ 戦う: 断られた: fight には target が要る（渡されていない）。');
    expect(actionResult('no_such_item 種類 potion_x の品を持っていない（未鑑定の品はスロット文字で指定する）。')).toBe('断られた: 種類 potion_x の品を持っていない（未鑑定の品はスロット文字で指定する）。');
    // 頭の言葉は画面の言葉、中身は AI に届いた文のまま（プレイヤーの言葉）
    expect(actionResult('Error [bad_request] Invalid argument: offer\nHint: ...')).toBe('断られた: Invalid argument: offer');
    // 「結果:」が無ければ、最初の意味のある 1 行
    expect(actionResult('\n  \nキャンプに戻った。\n次の行')).toBe('キャンプに戻った。');
    // 長ければ 120 字で切る
    const long = `結果: ${'あ'.repeat(300)}`;
    const r = actionResult(long)!;
    expect([...r]).toHaveLength(ACT_RESULT_MAX);
    expect(r.endsWith('…')).toBe(true);
    expect(actionResult('')).toBeNull();
    expect(actionResult(null)).toBeNull();
  });

  it('does not say twice what the message log already says (event lines are dropped from the result; nothing left → the name alone)', () => {
    const text = '結果: ゴブリンに 5 のダメージ。 ゴブリンを倒した。\n...';
    expect(actionLine({ tool: 'attack', text, dup: ['ゴブリンに 5 のダメージ。', 'ゴブリンを倒した。'] })).toBe('▶ 攻撃');
    const macro = '結果: fight: 3 手進んだ。 ジャッカルを倒した。 レベルが上がった（Lv2）。\n...';
    expect(actionLine({ tool: 'fight', text: macro, dup: ['ジャッカルを倒した。'] })).toBe('▶ 戦う: 3 手進んだ。 レベルが上がった（Lv2）。');
    // 帰還の綱（use_item）: 名前を言い換え、結果の文から、もう出ている帰りの文を除く
    const ll = '結果: 帰還の綱を使った。 ミュゼ美 は帰還の綱でキャンプに戻った（全回復）。\n...';
    expect(actionLine({ tool: 'use_item', text: ll, flags: { returned: 'lifeline' }, dup: ['ミュゼ美 は帰還の綱でキャンプに戻った（全回復）。'] })).toBe('▶ 帰還の綱: 帰還の綱を使った。');
    // 協力プレイ: だれの命令か
    expect(actionLine({ tool: 'rest', text: '結果: rest: 5 手休んだ。HP +4。', who: 'カエデ' })).toBe('▶ カエデ: 休む: 5 手休んだ。HP +4。');
  });

  it('the line goes above the lines of its own events (seq after + 0.5); the way back is read from the events', () => {
    const lines = [{ seq: 10, text: 'a' }, { seq: 12, text: 'b' }, { seq: 13, text: 'c' }];
    expect(insertBySeq(lines, { seq: 11.5, text: '▶' }).map((l) => l.text)).toEqual(['a', '▶', 'b', 'c']);
    expect(insertBySeq(lines, { seq: 13.5, text: '▶' }).map((l) => l.text)).toEqual(['a', 'b', 'c', '▶']);
    expect(insertBySeq([], { seq: 1.5, text: '▶' }).map((l) => l.text)).toEqual(['▶']);
    const evs = [{ type: 'damaged' }, { type: 'player_state', player: 'p_x', state: 'at_camp', reason: 'lifeline' }];
    expect(returnedOf(evs, 'p_x')).toBe('lifeline');
    expect(returnedOf(evs, 'p_other')).toBeNull();
    expect(returnedOf([{ type: 'player_state', player: 'p_x', state: 'at_camp', reason: 'withdrew' }], 'p_x')).toBe('withdrew');
    expect(returnedOf([{ type: 'player_state', player: 'p_x', state: 'dead', reason: 'killed' }], 'p_x')).toBeNull();
  });

  it('the queue lends the steps still waiting in a seq range, without taking them', () => {
    const q = new PlaybackQueue<string, string>('normal');
    q.push('s1', 0, { seqs: { first: 11, last: 14 } });
    q.push('s2', 0, { seqs: { first: 15, last: 18 } });
    q.push('s3', 0, { seqs: { first: 19, last: 22 } });
    expect(q.stepsIn(14, 18)).toEqual(['s2']);
    expect(q.stepsIn(10, 30)).toEqual(['s1', 's2', 's3']);
    expect(q.stepsIn(22, 30)).toEqual([]);
    expect(q.size).toBe(3);
  });
});

/** 見え方の縮め（テスト用） */
const snap = (o: Partial<BannerSnap> = {}): BannerSnap => ({ where: 'dungeon', depth: 2, exp: { no: 3, status: 'in_progress', objective: { type: 'reach_depth', targetDepth: 3 }, endReason: null }, banked: 100, ...o });

describe('S15 §68.2 の 2: scene banners', () => {
  it('expedition start, a new floor, the objective, and the ways back (with the points banked); a fall', () => {
    expect(sceneBanners(null, snap())).toEqual([]);
    // 遠征を始めた（目的の 1 文）
    const start = sceneBanners(snap({ where: 'camp', depth: null }), snap({ depth: 1 }));
    expect(start).toEqual([{ tone: 'start', text: '遠征 3 を始めた — 地下3階を踏破し（その階の下り階段に着き）、階段から帰還する' }]);
    // 階を移った
    expect(sceneBanners(snap({ depth: 2 }), snap({ depth: 3 }))).toEqual([{ tone: 'floor', text: '地下 3 階へ' }]);
    expect(sceneBanners(snap(), snap())).toEqual([]);
    // 目的を達成した
    const done = snap({ depth: 3, exp: { ...snap().exp!, status: 'objective_complete' } });
    expect(sceneBanners(snap({ depth: 3 }), done)).toEqual([{ tone: 'objective', text: '目的を達成した' }]);
    // 帰還した（確定した点）・撤退した・帰還の綱で戻った
    const camp = (endReason: string, banked: number) => snap({ where: 'camp', depth: null, banked, exp: { ...snap().exp!, status: 'ended', endReason } });
    expect(sceneBanners(done, camp('completed', 1860))).toEqual([{ tone: 'return', text: '帰還した（確定 +1760）' }]);
    expect(sceneBanners(snap(), camp('withdrawn', 130))).toEqual([{ tone: 'withdraw', text: '撤退した（確定 +30）' }]);
    expect(sceneBanners(snap(), camp('lifeline', 100))).toEqual([{ tone: 'lifeline', text: '帰還の綱で戻った' }]);
    // 達成と帰還が同じ歩: 達成を先に
    expect(sceneBanners(snap(), camp('completed', 600)).map((b) => b.tone)).toEqual(['objective', 'return']);
    // 倒れた
    expect(sceneBanners(snap(), snap({ where: 'dead', depth: null }))).toEqual([{ tone: 'death', text: '倒れた' }]);
    expect(sceneBanners(snap({ where: 'dead', depth: null }), snap({ where: 'dead', depth: null }))).toEqual([]);
    // キャンプの中の動き（目的を選んだ など）は、帯を出さない
    expect(sceneBanners(snap({ where: 'camp', depth: null }), snap({ where: 'camp', depth: null }))).toEqual([]);
    setLocale('en');
    expect(sceneBanners(snap({ depth: 2 }), snap({ depth: 3 }))).toEqual([{ tone: 'floor', text: 'Down to depth 3' }]);
    expect(sceneBanners(snap(), camp('lifeline', 150))).toEqual([{ tone: 'lifeline', text: 'Pulled back by the lifeline (banked +50)' }]);
  });

  it('a PlayerView is squeezed to where, depth, expedition and banked points (nothing it does not already show)', () => {
    const v = {
      status: 'your_turn', runStatus: 'active', floor: { depth: 4 }, record: { banked: 250, lost: 0, expeditions: 2 },
      expedition: { no: 2, status: 'in_progress', objective: { type: 'slay_guardian', targetDepth: 4 }, endReason: null, result: null },
    } as unknown as PlayerView;
    expect(bannerSnap(v)).toEqual({ where: 'dungeon', depth: 4, exp: { no: 2, status: 'in_progress', objective: { type: 'slay_guardian', targetDepth: 4 }, endReason: null }, banked: 250 });
    expect(bannerSnap({ ...v, status: 'at_camp' } as PlayerView).where).toBe('camp');
    expect(bannerSnap({ ...v, status: 'at_camp' } as PlayerView).depth).toBeNull();
    expect(bannerSnap({ ...v, status: 'dead' } as PlayerView).where).toBe('dead');
    expect(bannerSnap({ ...v, runStatus: 'ended' } as PlayerView).where).toBe('ended');
  });
});

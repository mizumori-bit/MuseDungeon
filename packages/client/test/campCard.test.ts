// S16c（SEASON.md §70.5）: 目的の札（支度と、自分で潜るときのキャンプで同じ部品）の中身と、キャンプの主のボタンの決まり。画面から離した関数のテスト。
import { describe, expect, it } from 'vitest';
import type { CatalogRules, ExpeditionOffer } from '@muse/shared';
import { offerText } from '@muse/shared';
import { campClosedOf, campHeadline, campStart, dangerOf, levelText, objectiveCardModel, objectiveShort, pickFor } from '../src/ui/objectiveCard';

// 札に要る分だけのルール（推奨レベルの表と、条件 2 つ）
const rules = {
  recommendedLevel: { byDepth: [1, 2, 3, 4, 5, 6, 7, 8] },
  traits: {
    dark: { name: { ja: '暗い', en: 'Dark' }, desc: { ja: '視界が狭い', en: 'Short sight' }, multiplierPct: 120, danger: 1 },
    swarm: { name: { ja: '群れ', en: 'Swarm' }, desc: { ja: '敵が多い', en: 'More enemies' }, multiplierPct: 130, danger: 2 },
  },
} as unknown as CatalogRules;

function offer(p: Partial<ExpeditionOffer> = {}): ExpeditionOffer {
  return { index: 1, objective: { type: 'retrieve_relic', targetDepth: 4 }, points: 600, relicGuarded: false, slot: 'standard', traits: [], multiplierPct: 100, ...p } as ExpeditionOffer;
}

describe('S16c: the danger mark on an objective card', () => {
  it('uses the gap to the recommended level and the traits\' danger (the same numbers the AI gets)', () => {
    expect(dangerOf(null, 0)).toBeNull();
    expect(dangerOf(-1, 0)).toEqual({ tone: 'ok', label: '届いている' });
    expect(dangerOf(0, 0)?.tone).toBe('ok');
    expect(dangerOf(1, 0)).toEqual({ tone: 'warn', label: '背伸び' });
    expect(dangerOf(0, 1)?.tone).toBe('warn');
    expect(dangerOf(3, 0)).toEqual({ tone: 'high', label: '危険' });
    // 差と条件を合わせて 4 以上も「危険」
    expect(dangerOf(2, 2)?.tone).toBe('high');
    expect(dangerOf(2, 1)?.tone).toBe('warn');
    // 推奨が分からなくても、条件の危険度があれば出す
    expect(dangerOf(null, 1)?.tone).toBe('warn');
  });
});

describe('S16c: what an objective card shows large, small and folded', () => {
  it('large: where, what, base points, the recommended level against yours, the danger mark', () => {
    const m = objectiveCardModel(offer({ relicGuarded: true }), { level: 2, rules });
    expect(m.where).toBe('地下4階');
    expect(m.what).toBe('遺物を持ち帰る（守護者付き）');
    expect(m.points).toBe(600);
    expect(m.level).toEqual({ rec: 4, you: 2, gap: 2 });
    expect(levelText(m.level)).toBe('推奨 Lv4・あなた Lv2（差 +2）');
    expect(m.danger).toEqual({ tone: 'warn', label: '背伸び' });
    expect(m.slotLabel).toBe('標準');
    expect(m.how).toBe('地下4階の遺物を見つけ、持ったまま階段から帰還する');
  });

  it('small: the multiplier, the trait names and the forecasts in short; the danger counts the traits', () => {
    const m = objectiveCardModel(offer({
      objective: { type: 'slay_guardian', targetDepth: 3 }, traits: ['dark', 'swarm'], multiplierPct: 156,
      guardian: { rank: 2, traits: [] }, guardianBounty: 80, repeatNo: 2, repeatPct: 50, scar: 5,
    }), { level: 3, rules });
    expect(m.traitDanger).toBe(3);
    expect(m.danger?.tone).toBe('warn');
    expect(m.facts).toEqual(['倍率 ×1.56', '暗い', '群れ', '守護者 格 2', '守護者の賞金 +80', 'この階は 2 回目（50%）', '傷跡で体力 −5']);
  });

  it('a relic warns that picking it up wakes the floor (as the AI is told before choosing)', () => {
    expect(objectiveCardModel(offer(), { level: 4, rules }).facts).toContain('拾うと、階の敵が起きる');
  });

  it('folded: the full text the AI gets (from the observation when given; otherwise offerText)', () => {
    const o = offer({ traits: ['dark'] });
    expect(objectiveCardModel(o, { level: 2, rules }).full).toBe(offerText('ja', o, { rules, level: 2 }));
    expect(objectiveCardModel(o, { level: 2, rules, fullText: 'AI の文' }).full).toBe('AI の文');
  });

  it('without the public rules (an old server): no recommended level, only your level', () => {
    const m = objectiveCardModel(offer(), { level: 2 });
    expect(m.level).toEqual({ rec: null, you: 2, gap: null });
    expect(m.danger).toBeNull();
    expect(levelText(m.level)).toBe('あなた Lv2');
  });

  it('every objective type has a short "what"', () => {
    expect(objectiveShort({ type: 'reach_depth' })).toBe('踏破する');
    expect(objectiveShort({ type: 'slay_warden' })).toBe('大守護者を倒す（節目）');
    expect(objectiveShort({ type: 'slay_bounty' })).toBe('賞金首を討つ');
    expect(objectiveShort({ type: 'open_vault' })).toBe('宝物庫を開ける');
    expect(objectiveShort({ type: 'endless' })).toBe('目的なし。できるだけ深く潜る');
  });
});

describe('S16c: the one main button at camp ("set out with this objective")', () => {
  it('the pick belongs to one camp: a new camp (or an offer gone) clears it', () => {
    const offers = [{ index: 1 }, { index: 2 }];
    expect(pickFor(null, 3, offers)).toBeNull();
    expect(pickFor({ no: 3, pick: 2 }, 3, offers)).toBe(2);
    expect(pickFor({ no: 3, pick: 'endless' }, 3, offers)).toBe('endless');
    expect(pickFor({ no: 2, pick: 2 }, 3, offers)).toBeNull();
    expect(pickFor({ no: 3, pick: 4 }, 3, offers)).toBeNull();
    expect(pickFor({ no: 3, pick: 1 }, null, offers)).toBeNull();
  });

  it('cannot set out before choosing, while waiting for allies, or when the season is closed', () => {
    expect(campStart({ selected: null })).toEqual({ canStart: false, label: 'この目的で、出発', hint: '目的を 1 つ選ぶと、出発できる。', confirm: null });
    expect(campStart({ selected: 1, waiting: true }).canStart).toBe(false);
    expect(campStart({ selected: 1, closed: 'budget' }).hint).toBe('このシーズンの手番を、使い切った。もう出発できない（ここで終えてよい）。');
    expect(campStart({ selected: 1, closed: 'ended' }).canStart).toBe(false);
  });

  it('chosen: sets out; endless says so; an unchosen perk or boon asks first (as "ready" does on the preparations screen)', () => {
    expect(campStart({ selected: 2 })).toEqual({ canStart: true, label: 'この目的で、出発', hint: null, confirm: null });
    expect(campStart({ selected: 'endless' }).label).toBe('目的なしで、出発');
    const c = campStart({ selected: 1, perk: { level: 3, options: [1, 2, 3], more: 1 }, boon: { depth: 5, options: [1, 2] } });
    expect(c.canStart).toBe(true);
    expect(c.confirm).toEqual(['特技（Lv3 の候補 3 つ。ほかに 1 回分）', '加護（地下5階の大守護者。候補 2 つ）']);
    // 候補がまだ引かれていない（options が空）ときは、確かめない
    expect(campStart({ selected: 1, perk: { level: 3, options: [], more: 0 } }).confirm).toBeNull();
  });

  it('a season run is closed by an empty budget or the end time (the same rule as the AI\'s valid actions)', () => {
    expect(campClosedOf(undefined)).toBeNull();
    expect(campClosedOf({ budgetLeft: 10, ended: false })).toBeNull();
    expect(campClosedOf({ budgetLeft: 0, ended: false })).toBe('budget');
    expect(campClosedOf({ budgetLeft: 10, ended: true })).toBe('ended');
  });

  it('the headline says what to decide now', () => {
    expect(campHeadline({ first: true, waiting: false, closed: null, pendingChoice: false })).toBe('最初の遠征の目的を決める');
    expect(campHeadline({ first: false, waiting: false, closed: null, pendingChoice: false })).toBe('次の遠征の目的を決める');
    expect(campHeadline({ first: false, waiting: false, closed: null, pendingChoice: true })).toBe('特技を選んで、次の目的を決める');
    expect(campHeadline({ first: false, waiting: true, closed: null, pendingChoice: false })).toBe('仲間の遠征の終わりを待っている');
    expect(campHeadline({ first: false, waiting: false, closed: 'budget', pendingChoice: true })).toBe('このシーズンは、もう出発できない');
  });
});

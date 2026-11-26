// S16a（SEASON.md §70.3 の 2）: 出来事 → 演出（render/events.ts）。能動技の名前・攻撃の出来事が届かない当たりの踏み込み・見えていない者の分は作らない
import { afterEach, describe, expect, it } from 'vitest';
import type { Catalog } from '@muse/shared';
import { toViewEvents } from '../src/render/events';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

const catalog = { abilities: { 'core:bash': { name: { ja: '強打', en: 'Bash' } }, 'core:cleave': { name: { ja: 'なぎ払い', en: 'Cleave' } } }, appearances: {}, items: {} } as unknown as Catalog;

describe('S16a §70.3 の 2: abilities and blows on the map', () => {
  it('names the ability over the one who used it (catalog name, ja/en); not when the user is hidden', () => {
    const used = { type: 'ability_used', actor: 'e_me', ability: 'core:bash', target: 'e_g' };
    expect(toViewEvents([used], catalog)).toEqual([{ kind: 'ability', id: 'e_me', name: '強打' }]);
    setLocale('en');
    expect(toViewEvents([used], catalog)).toEqual([{ kind: 'ability', id: 'e_me', name: 'Bash' }]);
    // 見えていない使い手（actor が伏せてある）
    expect(toViewEvents([{ ...used, actor: null }], catalog)).toEqual([]);
    // カタログに無い技: ID の後ろ
    expect(toViewEvents([{ ...used, ability: 'core:mystery' }], catalog)).toEqual([{ kind: 'ability', id: 'e_me', name: 'mystery' }]);
  });

  it('foe moves (heavy swing, charge, call, rage) get short names; a missed charge and hidden foes get none', () => {
    expect(toViewEvents([{ type: 'monster_acted', id: 'e_o', act: 'swing_hit' }], catalog)).toEqual([{ kind: 'ability', id: 'e_o', name: '大振り' }]);
    expect(toViewEvents([{ type: 'guardian_acted', id: 'e_g', act: 'charged' }, { type: 'guardian_acted', id: 'e_g', act: 'summoned' }, { type: 'guardian_acted', id: 'e_g', act: 'enraged' }], catalog).map((v) => (v as { name: string }).name))
      .toEqual(['突進', '手下を呼ぶ', '怒り']);
    expect(toViewEvents([{ type: 'guardian_acted', id: 'e_g', act: 'missed' }, { type: 'monster_acted', id: null, act: 'swing_hit' }], catalog)).toEqual([]);
  });

  it('a hit whose attack event did not arrive (plain hits are not narrated, so the play and follow-only frames lack them) still steps in; no double step when the attack event is there', () => {
    const dmg = { type: 'damaged', target: 'e_g', source: 'e_me', via: 'melee', amount: 6 };
    // 遊ぶ画面・追従だけの観戦の枠（文になる出来事だけ）: 能動技 → 被害
    expect(toViewEvents([{ type: 'ability_used', actor: 'e_me', ability: 'core:bash', target: 'e_g' }, dmg], catalog)).toEqual([
      { kind: 'ability', id: 'e_me', name: '強打' },
      { kind: 'strike', id: 'e_me', target: 'e_g', ranged: false },
      { kind: 'damage', id: 'e_g', amount: 6 },
    ]);
    // 俯瞰・リプレイ（攻撃の出来事も届く）: 踏み込みは attack から 1 回だけ
    const attack = { type: 'attack', attacker: 'e_me', target: 'e_g', from: { x: 1, y: 1 }, to: { x: 2, y: 1 }, hit: true, crit: false, ranged: false };
    const v = toViewEvents([attack, dmg], catalog);
    expect(v.filter((e) => e.kind === 'strike')).toEqual([]);
    expect(v.filter((e) => e.kind === 'attack')).toHaveLength(1);
    // 射撃の当たり: 飛ぶもの
    expect(toViewEvents([{ ...dmg, source: 'e_o', target: 'e_me', via: 'ranged' }], catalog)[0]).toEqual({ kind: 'strike', id: 'e_o', target: 'e_me', ranged: true });
    // なぎ払い: 隣の 2 体にそれぞれ
    expect(toViewEvents([dmg, { ...dmg, target: 'e_h' }], catalog).filter((e) => e.kind === 'strike')).toHaveLength(2);
    // 見えていない打ち手（source が伏せてある）・毒・罠・投げた物（飛ぶものは item_thrown から）では作らない
    expect(toViewEvents([{ ...dmg, source: null }, { ...dmg, via: 'poison' }, { ...dmg, via: 'trap', source: null }, { ...dmg, via: 'thrown' }], catalog).filter((e) => e.kind === 'strike')).toEqual([]);
  });
});

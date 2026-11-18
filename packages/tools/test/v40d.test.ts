// V4-0d（IMPROVEMENTS_V4 §6）の確認: 体力の目安に幅を添える（格 1〜3 の守護者と賞金首）、
// 賞金首（目的・異変）と巡回の強敵にもその階の深層強化を掛ける（目安は生成と同じ式）。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { BountyInfo, ExpeditionOffer, World } from '@muse/shared';
import { bountyForecastText, diceMax, diceMin, floorDiv, guardianForecastText, hpAboutText } from '@muse/shared';
import { generateFloor, monsterFromSpec, previewBounty, previewGuardian, previewOffers } from '@muse/engine';
import type { SpawnSpec } from '@muse/engine';
import { loadConfig, rulesText, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
const tt = (content.terrain as unknown as { id: string }[]).map((t) => t.id);
type MSpec = Extract<SpawnSpec, { type: 'monster' }>;

async function newRun(seed = 'v40d') {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
  if ('error' in r) throw new Error(r.error.message);
  return { manager, r, world: r.session.world as World };
}

const monsters = (g: ReturnType<typeof generateFloor>) => g.spawns.filter((s): s is MSpec => s.type === 'monster');
/** 普通の個体（守護者・賞金首・巡回の強敵・名前付きの強敵でない） */
const plain = (g: ReturnType<typeof generateFloor>) => monsters(g).filter((s) => !s.guardian && !s.role && !s.objectiveBounty && !s.route && !s.elite);
/** 体力ダイスの最小・平均・最大を振った個体（同じ仕様で、振った値だけ替える） */
const rolled = (w: World, key: string, spec: MSpec) => {
  const dice = content.monsters[spec.kind].stats.hp;
  const at = (hp: number) => monsterFromSpec(w, content, key, { ...spec, hp }).stats!.maxHp;
  return { min: at(Math.max(1, diceMin(dice))), avg: at(floorDiv(diceMin(dice) + diceMax(dice), 2)), max: at(Math.max(1, diceMax(dice))) };
};

const ORRUNRO: BountyInfo = { kind: 'core:bone_archer', name: { ja: 'オルルンロ', en: 'Orrunro' }, affixes: ['core:ancient', 'core:swift'] };

describe('V4-0d: the HP estimate comes with its range', () => {
  it('texts: "about 20 HP (9-32)"; wardens keep their range; a collapsed range shows the estimate alone', () => {
    expect(hpAboutText('ja', 20, { min: 9, max: 32 })).toBe('体力はおよそ 20（9〜32）');
    expect(hpAboutText('en', 20, { min: 9, max: 32 })).toBe('about 20 HP (9-32)');
    expect(hpAboutText('ja', 26, { min: 26, max: 26 })).toBe('体力はおよそ 26');
    expect(hpAboutText('ja', 20)).toBe('体力はおよそ 20');
    expect(guardianForecastText('ja', { rank: 2, traits: [], hp: 33, hpRange: { min: 24, max: 46 } })).toContain('体力はおよそ 33（24〜46）');
    expect(guardianForecastText('ja', { rank: 3, traits: [], hpRange: { min: 50, max: 90 } })).toContain('体力 50〜90');
    expect(bountyForecastText('ja', { name: ORRUNRO.name, hp: 20, hpRange: { min: 9, max: 32 }, maxHit: 5 })).toContain('体力はおよそ 20（9〜32）・一撃は最大 5 まで');
    // 古い候補（幅が無い）は今までどおり
    expect(bountyForecastText('ja', { name: ORRUNRO.name, hp: 20, maxHit: 5 })).toContain('体力はおよそ 20・一撃');
  });

  it('the bounty of expedition 18 (bone archer, ancient + swift, depth 12): about 20 (9-32)', async () => {
    const { world, manager } = await newRun();
    const b = previewBounty(world, content, 12, ORRUNRO);
    expect(b.hp).toBe(20);
    expect(b.hpRange).toEqual({ min: 9, max: 32 });
    manager.closeAll();
  });

  it('bounty: the range is the lowest and highest roll through the generation formula; hit and armor match', async () => {
    const { world, manager } = await newRun();
    for (const [kind, affixes] of [['core:bone_archer', ['core:ancient', 'core:swift']], ['core:orc_brute', ['core:venomous']], ['core:cave_troll', []]] as const) {
      for (const d of [12, 19, 24]) {
        const b: BountyInfo = { kind, name: { ja: 'テスト', en: 'Test' }, affixes: [...affixes] };
        const key = `main:${d}`;
        const g = generateFloor(content, `v40d-${kind}-${d}`, 'main', d, tt, { guardian: false, relic: false, bounty: b });
        const spec = monsters(g).find((s) => s.objectiveBounty)!;
        expect(spec).toBeTruthy();
        const est = previewBounty(world, content, d, b);
        const r = rolled(world, key, spec);
        expect(r).toEqual({ min: est.hpRange!.min, avg: est.hp, max: est.hpRange!.max });
        const e = monsterFromSpec(world, content, key, spec);
        expect(e.stats!.maxHp).toBeGreaterThanOrEqual(est.hpRange!.min);
        expect(e.stats!.maxHp).toBeLessThanOrEqual(est.hpRange!.max);
        expect(diceMax(e.base!.dmg) + e.base!.might).toBe(est.maxHit);
        expect(e.base!.armor).toBe(est.armor);
      }
    }
    manager.closeAll();
  });

  it('guardians (ranks 1-3): the range follows the generation formula, floor included', async () => {
    const { world, manager } = await newRun();
    for (const [kind, rank, d] of [['core:orc_brute', 2, 8], ['core:cave_troll', 3, 22], ['core:bone_archer', 1, 12], ['core:cave_rat', 1, 11]] as const) {
      const key = `main:${d}`;
      const g = generateFloor(content, `v40d-g-${kind}-${d}`, 'main', d, tt, { guardian: true, relic: false, rank, guardianKind: kind, guardianAffixes: [] });
      const spec = monsters(g).find((s) => s.role === 'guardian')!;
      expect(spec?.kind).toBe(kind);
      const est = previewGuardian(world, content, d, kind, rank, []);
      expect(rolled(world, key, spec)).toEqual({ min: est.hpRange!.min, avg: est.hp, max: est.hpRange!.max });
    }
    // 下限で切られて幅が 1 点になる（洞窟ネズミの格 1、地下 11 階: 下限 6 + 2 × 11）: 括弧を付けない
    const rat = previewGuardian(world, content, 11, 'core:cave_rat', 1, []);
    expect(rat.hpRange).toEqual({ min: 28, max: 28 });
    expect(guardianForecastText('ja', { rank: 1, traits: [], hp: rat.hp, hpRange: rat.hpRange })).toMatch(/体力はおよそ 28$/);
    manager.closeAll();
  });

  it('offers and the camp observation carry the range (text and structured)', async () => {
    const { world, manager, r } = await newRun('v40d-camp');
    // 候補を作り直すと、格 1〜3 の守護者の候補は目安と幅を持つ
    for (let no = 2; no < 8; no++) {
      for (const o of previewOffers(world, content, no)) {
        if (o.guardian?.hp === undefined) continue;
        expect(o.guardian.hpRange!.min).toBeLessThanOrEqual(o.guardian.hp);
        expect(o.guardian.hpRange!.max).toBeGreaterThanOrEqual(o.guardian.hp);
      }
    }
    const bounty = previewBounty(world, content, 12, ORRUNRO);
    world.camp!.offers = [
      { index: 1, points: 500, relicGuarded: false, slot: 'safe', traits: [], multiplierPct: 100, objective: { type: 'slay_bounty', targetDepth: 12 }, bounty } as ExpeditionOffer,
      { index: 2, points: 600, relicGuarded: false, slot: 'standard', traits: [], multiplierPct: 100, objective: { type: 'slay_guardian', targetDepth: 4 }, guardian: { rank: 2, traits: [], hp: 33, hpRange: { min: 24, max: 46 }, maxHit: 6, armor: 1 } } as ExpeditionOffer,
    ];
    const ob = r.port.observe({ map: false });
    expect(ob.text).toContain('賞金首「オルルンロ」（骨の射手・古の・俊敏な）: 体力はおよそ 20（9〜32）');
    expect(ob.text).toContain('体力はおよそ 33（24〜46）');
    const offers = ob.observation.camp!.offers;
    expect(offers[0].bounty).toMatchObject({ hp: 20, hp_range: { min: 9, max: 32 } });
    expect(offers[1].guardian).toMatchObject({ hp: 33, hp_range: { min: 24, max: 46 } });
    manager.closeAll();
  });
});

describe('V4-0d: bounties and patrolling elites get the deep tier', () => {
  it('the objective bounty below the deepest defined depth has the same tier as the plain monsters there', () => {
    // 定義の最深は地下 18 階: 19〜23 階は 1 段、24〜28 階は 2〜3 段（5 階ごと）。地下 24 階のこのシードは聖域（普通の敵がいない）
    expect(content.deepestDefined).toBe(18);
    let compared = 0;
    for (const [d, want] of [[19, 1], [24, 2], [28, 3]] as const) {
      const g = generateFloor(content, `v40d-tier-${d}`, 'main', d, tt, { guardian: false, relic: false, bounty: ORRUNRO });
      const spec = monsters(g).find((s) => s.objectiveBounty)!;
      expect(spec.tier).toBe(want);
      for (const s of plain(g)) { expect(s.tier).toBe(want); compared++; }
    }
    expect(compared).toBeGreaterThan(20);
    // 定義の最深までは 0（今までどおり）
    const g = generateFloor(content, 'v40d-tier-16', 'main', 16, tt, { guardian: false, relic: false, bounty: ORRUNRO });
    expect(monsters(g).find((s) => s.objectiveBounty)!.tier).toBe(0);
  });

  it('a patrolling elite and a floor-event bounty get the tier of the plain monsters on their floor', () => {
    const seen = { patrol: 0, bounty: 0 };
    for (let i = 0; i < 400 && (seen.patrol < 2 || seen.bounty < 2); i++) {
      const g = generateFloor(content, `v40d-ev-${i}`, 'main', 21, tt);
      const h = g.floor.event?.handler;
      if (h !== 'patrol' && h !== 'bounty') continue;
      const el = monsters(g).find((s) => s.route && s.elite);
      if (!el) continue;
      seen[h]++;
      const tiers = new Set(plain(g).map((s) => s.tier));
      expect(tiers.size).toBe(1);
      expect(el.tier).toBe([...tiers][0]);
      expect(el.tier).toBeGreaterThan(0);
    }
    expect(seen.patrol).toBeGreaterThan(0);
    expect(seen.bounty).toBeGreaterThan(0);
  });
});

describe('V4-0d: rules', () => {
  it('get_rules explains the range in parentheses', () => {
    expect(rulesText('all', 'ja', catalog)).toContain('候補には幅を添える（「体力はおよそ 20（9〜32）」。括弧の中は、体力ダイスの最小と最大に同じ計算をした値');
    expect(rulesText('all', 'en', catalog)).toContain('Offers add the range ("about 20 HP (9-32)"');
  });
});

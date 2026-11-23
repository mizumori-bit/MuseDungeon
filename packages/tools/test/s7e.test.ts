// S7（SEASON.md §52.3 の 5・§53.6）のテスト: 見込み（真ん中の数）の数え方（E）。最悪と「死にうる」の判定は変えない
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { fightRiskStop, fightThreats, macroProbe, memoryKey, projectPlayerView, threatEstimate } from '@muse/shared';
import type { Command, Entity, EntityView, MonsterMemory, PlayerView } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
type A = Awaited<ReturnType<typeof arena>>;
const act = (a: A, cmd: Command) => a.r.port.act(cmd, { source: 'bot' });

/** その種族（守護者として置いた相手）の記録を、プレイヤーの知識に入れる（テストの書き換え） */
function remember(a: A, kind: string, m: Partial<MonsterMemory>): void {
  const k = a.world.players[a.pid].knowledge;
  const mem: MonsterMemory = { kind, encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...m };
  k.monsterMemory = { ...k.monsterMemory, [memoryKey(kind, 'guardian')]: { ...mem, guardian: true }, [kind]: mem };
}
function setMe(a: A, fn: (e: Entity) => void): void { const e = structuredClone(a.world.entities[a.meId]); fn(e); a.inject({ put: [e] }); }

/** 見えている者を書き換えた view（テスト用: 記録だけを差し替える） */
function withMemory(v: PlayerView, kind: string, m: Partial<MonsterMemory>): PlayerView {
  const o = structuredClone(v);
  const mem: MonsterMemory = { kind, encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...m };
  o.monsterMemory = { ...o.monsterMemory, [kind]: mem, [memoryKey(kind, 'guardian')]: { ...mem, guardian: true } };
  return o;
}

describe('S7 §52.3 の 5: the expected number uses your record of that species when it has attacked you often enough', () => {
  it('enough records (5 attacks, the HP-record rule): its average (hit rate × damage); fewer: as before (the heaviest at its worst non-crit hit). The worst is unchanged', async () => {
    const a = await arena('s7e-avg', { map: ['PG...'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    await act(a, { type: 'wait' });
    const v0 = projectPlayerView(a.world, a.pid);
    const th = (v: PlayerView) => fightThreats(catalog, v.entities.filter((e) => e.cat === 'monster'), v.self.pos!);
    // 5 回攻撃されて、2 回当たり、合わせて 10（1 回あたりの平均 2）。会心でない最大 8・最大 10
    const enough = withMemory(v0, 'core:goblin', { maxDamageToYou: 10, maxPlainToYou: 8, hitsOnYou: [2, 5], dmgOnYou: [10, 2, 5] });
    const few = withMemory(v0, 'core:goblin', { maxDamageToYou: 10, maxPlainToYou: 8, hitsOnYou: [2, 4], dmgOnYou: [10, 2, 4] });
    expect(threatEstimate(enough, catalog, th(enough))).toEqual({ expected: 2, worst: 10, unrecorded: 0 });
    expect(threatEstimate(few, catalog, th(few))).toEqual({ expected: 8, worst: 10, unrecorded: 0 });
    expect(catalog.rules.estimateMinSamples).toBe(5);
    // 死にうるかどうか（最悪）は変わらない
    expect(fightRiskStop(10, 0, threatEstimate(enough, catalog, th(enough)))).toBe('lethal');
    expect(fightRiskStop(10, 0, threatEstimate(few, catalog, th(few)))).toBe('lethal');
    // hp_floor の判定は見込みで: HP 20・hp_floor 15 なら、記録が足りれば 20 − 2 で続き、足りなければ 20 − 8 で止まる
    expect(fightRiskStop(20, 15, threatEstimate(enough, catalog, th(enough)))).toBeNull();
    expect(fightRiskStop(20, 15, threatEstimate(few, catalog, th(few)))).toBe('floor');
    a.manager.closeAll();
  });

  it('fight stops (hp_risk) or goes on by the same number in the macro', async () => {
    const a = await arena('s7e-fight', { map: ['PG...'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    await act(a, { type: 'wait' });
    setMe(a, (e) => { e.stats!.hp = 20; e.stats!.maxHp = 60; });
    remember(a, 'core:goblin', { maxDamageToYou: 10, maxPlainToYou: 8, hitsOnYou: [2, 4], dmgOnYou: [10, 2, 4] });
    const cmd: Command = { type: 'fight', target: a.gId, hpFloor: 15 };
    const d1 = macroProbe(projectPlayerView(a.world, a.pid), cmd, catalog).decision;
    expect('stop' in d1 && d1.stop).toBe('hp_risk');
    // 5 回目の攻撃の記録が入ると、記録の平均（2）で数える: 続ける
    remember(a, 'core:goblin', { maxDamageToYou: 10, maxPlainToYou: 8, hitsOnYou: [2, 5], dmgOnYou: [10, 2, 5] });
    const d2 = macroProbe(projectPlayerView(a.world, a.pid), cmd, catalog).decision;
    expect('command' in d2).toBe(true);
    a.manager.closeAll();
  });

  it('a shooter whose line to you is blocked is left out of the expected number, but stays in the worst', async () => {
    const a = await arena('s7e-shot', { map: ['P....G'], guardian: { kind: 'core:bone_archer', hp: 20, dmg: '1d4', types: [], state: 'hunting', archetype: 'ranged_stand' } });
    await act(a, { type: 'wait' });
    const v = withMemory(projectPlayerView(a.world, a.pid), 'core:bone_archer', { maxDamageToYou: 6, maxPlainToYou: 4, hitsOnYou: [1, 2], dmgOnYou: [4, 1, 2] });
    const archer = v.entities.find((e) => e.id === a.gId)!;
    expect(archer.cat).toBe('monster');
    const th = fightThreats(catalog, v.entities.filter((e) => e.cat === 'monster'), v.self.pos!);
    expect(th.map((e) => e.id)).toContain(a.gId);
    const open = threatEstimate(v, catalog, th.map((e) => ({ ...e, shot: true })));
    const blocked = threatEstimate(v, catalog, th.map((e): EntityView => ({ ...e, shot: false })));
    expect(open.expected).toBe(4);
    expect(blocked.expected).toBe(0);
    expect(blocked.worst).toBe(open.worst);
    expect(blocked.worst).toBe(6);
    a.manager.closeAll();
  });
});

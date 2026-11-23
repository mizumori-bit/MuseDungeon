// S7・S7a（SEASON.md §52.3 の 5・§53.6・§53.9 の 1・2）のテスト: 被害の 3 つの数。見込み（止まる判定）と最悪は S1d のまま。
// 「ふつう」（記録の平均）は表示に添えるだけで、マクロの止まり方・「できること」・pilot の判定には使わない
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { buildObservation, fightRiskStop, fightThreats, macroProbe, memoryKey, projectPlayerView, riskText, threatEstimate, usualEstimate } from '@muse/shared';
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

/** 見えている者の記録だけを差し替えた view（テスト用） */
function withMemory(v: PlayerView, kind: string, m: Partial<MonsterMemory>): PlayerView {
  const o = structuredClone(v);
  const mem: MonsterMemory = { kind, encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...m };
  o.monsterMemory = { ...o.monsterMemory, [kind]: mem, [memoryKey(kind, 'guardian')]: { ...mem, guardian: true } };
  return o;
}
const th = (v: PlayerView) => fightThreats(catalog, v.entities.filter((e) => e.cat === 'monster'), v.self.pos!);
// 5 回攻撃されて 2 回当たり、合わせて 10（1 回あたりの平均 2）。会心でない最大 8・最大 10
const ENOUGH = { maxDamageToYou: 10, maxPlainToYou: 8, hitsOnYou: [2, 5] as [number, number], dmgOnYou: [10, 2, 5] };
const FEW = { maxDamageToYou: 10, maxPlainToYou: 8, hitsOnYou: [2, 4] as [number, number], dmgOnYou: [10, 2, 4] };

describe('S7a §53.9 の 1・2: expected and worst stay as in S1d; "usually" is the average from your own record, shown only', () => {
  it('expected is the worst non-crit hit whatever the record; usually is the record average when it has 5+ attacks, else the same as expected', async () => {
    const a = await arena('s7e-avg', { map: ['PG...'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    await act(a, { type: 'wait' });
    const v0 = projectPlayerView(a.world, a.pid);
    const enough = withMemory(v0, 'core:goblin', ENOUGH);
    const few = withMemory(v0, 'core:goblin', FEW);
    expect(threatEstimate(enough, catalog, th(enough))).toEqual({ expected: 8, worst: 10, unrecorded: 0 });
    expect(threatEstimate(few, catalog, th(few))).toEqual({ expected: 8, worst: 10, unrecorded: 0 });
    expect(usualEstimate(enough, catalog, th(enough))).toBe(2);
    expect(usualEstimate(few, catalog, th(few))).toBe(8);
    expect(catalog.rules.estimateMinSamples).toBe(5);
    // 文: 「見込み 8・最悪 10（HP …・hp_floor …・ふつうは 2。…）」。ふつうが見込みと同じなら添えない
    expect(riskText(enough, catalog, 15)).toContain('見込み 8・最悪 10（HP');
    expect(riskText(enough, catalog, 15)).toContain('・ふつうは 2。');
    expect(riskText(few, catalog, 15)).not.toContain('ふつうは');
    a.manager.closeAll();
  });

  it('fight stops (hp_risk) by the expected number, not by usually; the action line and pilot\'s fight_risk do not use it', async () => {
    const a = await arena('s7e-fight', { map: ['PG...'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    await act(a, { type: 'wait' });
    setMe(a, (e) => { e.stats!.hp = 20; e.stats!.maxHp = 60; });
    remember(a, 'core:goblin', ENOUGH);
    const v = projectPlayerView(a.world, a.pid);
    // HP 20 − 見込み 8 = 12 < hp_floor 15 で止まる（ふつうの 2 なら続くが、使わない）
    const d = macroProbe(v, { type: 'fight', target: a.gId, hpFloor: 15 }, catalog).decision;
    expect('stop' in d && d.stop).toBe('hp_risk');
    expect(fightRiskStop(20, 15, threatEstimate(v, catalog, th(v)))).toBe('floor');
    // pilot が読む fight_risk は、今までの 3 つの数のまま（ふつうは入れない）
    const o = buildObservation(v, catalog, { detail: 'brief', map: false });
    expect(o.self.fight_risk).toEqual({ expected: 8, worst: 10, unrecorded: 0 });
    const r = await act(a, { type: 'fight', target: a.gId, hpFloor: 15 });
    expect(!r.ok && r.error.message).toContain('ふつうは 2');
    a.manager.closeAll();
  });

  it('usually leaves out a shooter whose line to you is blocked; expected and worst keep it', async () => {
    const a = await arena('s7e-shot', { map: ['P....G'], guardian: { kind: 'core:bone_archer', hp: 20, dmg: '1d4', types: [], state: 'hunting', archetype: 'ranged_stand' } });
    await act(a, { type: 'wait' });
    const v = withMemory(projectPlayerView(a.world, a.pid), 'core:bone_archer', { maxDamageToYou: 6, maxPlainToYou: 4, hitsOnYou: [1, 2], dmgOnYou: [4, 1, 2] });
    const t = th(v);
    expect(t.map((e) => e.id)).toContain(a.gId);
    const open = t.map((e) => ({ ...e, shot: true }));
    const blocked = t.map((e): EntityView => ({ ...e, shot: false }));
    expect(threatEstimate(v, catalog, blocked)).toEqual(threatEstimate(v, catalog, open));
    expect(threatEstimate(v, catalog, blocked)).toEqual({ expected: 4, worst: 6, unrecorded: 0 });
    expect(usualEstimate(v, catalog, open)).toBe(4);
    expect(usualEstimate(v, catalog, blocked)).toBe(0);
    a.manager.closeAll();
  });

  it('the pack alert and the stairs line add "usually M" when it differs, with the same number in their data', async () => {
    const a = await arena('s7e-pack', { map: ['.....', '..P..', '.....', '.....'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'hunting' } });
    const g2 = structuredClone(a.world.entities[a.gId]);
    g2.id = 'e_s7e002'; g2.sid += 100000; g2.pos = { ...g2.pos!, x: a.ox + 3, y: a.oy + 1 };
    const st = a.world.meta.terrainTable.indexOf('core:stairs_up');
    const f = a.world.floors[a.key];
    const si = (a.oy + 3) * f.width + a.ox + 2;
    f.terrain[si] = st;
    a.world.players[a.pid].knowledge.floors[a.key].seen[si] = st;
    a.inject({ put: [g2] });
    await act(a, { type: 'wait' });
    remember(a, 'core:goblin', ENOUGH);
    const o = buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
    const inc = o.alerts.find((x) => x.code === 'incoming');
    expect(inc?.text).toMatch(/1 手の被害の見込み \d+・最悪 \d+（全員が最大の一撃・ふつうは \d+）/);
    const data = inc?.data as { expected_sum: number; usual_sum: number };
    expect(data.usual_sum).toBeLessThan(data.expected_sum);
    const esc = o.alerts.find((x) => x.code === 'escape')?.data as { expected_if_chased: number | null; usual_if_chased: number | null } | undefined;
    if (esc && esc.expected_if_chased !== null) expect(esc.usual_if_chased).toBeLessThanOrEqual(esc.expected_if_chased);
    a.manager.closeAll();
  });
});

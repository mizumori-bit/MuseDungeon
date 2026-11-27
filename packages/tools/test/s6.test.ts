// S6（SEASON.md §49.6・§50.2）のテスト: 逃げる移動の「死にうる」・「できること」と断り・身かわし・look・脅威の文・装備の枠・頁・最大の一撃・眠りが深い。
// S6a（§50.4）: 逃げる移動の途中で止まる・着いた手番は arrived・階段の上の取れる手・階段の行（steady が断られたら flee）・死にうるときも move と綱の行が残る
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { buildObservation, describeTarget, fleeOptionsText, formatObservationText, macroProbe, memoryKey, projectPlayerView } from '@muse/shared';
import type { Command, Entity, MonsterMemory } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
type A = Awaited<ReturnType<typeof arena>>;

/** その種族（守護者として置いた相手）の記録を、プレイヤーの知識に入れる（テストの書き換え） */
function remember(a: A, kind: string, m: Partial<MonsterMemory>): void {
  const k = a.world.players[a.pid].knowledge;
  const mem: MonsterMemory = { kind, encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...m };
  k.monsterMemory = { ...k.monsterMemory, [memoryKey(kind, 'guardian')]: { ...mem, guardian: true }, [kind]: mem };
}
function setMe(a: A, fn: (e: Entity) => void): void { const e = structuredClone(a.world.entities[a.meId]); fn(e); a.inject({ put: [e] }); }
function setG(a: A, fn: (e: Entity) => void): void { const e = structuredClone(a.world.entities[a.gId]); fn(e); a.inject({ put: [e] }); }
/** 部屋のマスを下り階段にする（知っている地図にも） */
function stairsAt(a: A, x: number, y: number): void {
  const f = a.world.floors[a.key];
  const i = y * f.width + x;
  f.terrain[i] = a.world.meta.terrainTable.indexOf('core:stairs_down');
  a.world.players[a.pid].knowledge.floors[a.key].seen[i] = f.terrain[i];
}
const lines = (a: A) => buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false }).valid_actions;
const act = (a: A, cmd: Command) => a.r.port.act(cmd, { source: 'bot' });

describe('S6 §49.6 の 1: a flight (mode flee) stops when one worst turn could kill you, whatever hp_floor is', () => {
  it('refuses to start with the numbers and the options (the check runs before every step, so it also stops a flight on the way); with HP above the worst case it goes; steady is unchanged', async () => {
    const a = await arena('s6-flee', { map: ['.G.P.........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    // 隣にいる追跡中の相手の、記録の最大の一撃は 30
    setMe(a, (e) => { e.pos = { floor: a.key, x: a.ox + 2, y: a.oy }; e.stats!.hp = 20; e.stats!.maxHp = 60; });
    remember(a, 'core:goblin', { maxDamageToYou: 30, maxPlainToYou: 20, hitsOnYou: [1, 1], dmgOnYou: [30, 1, 1] });
    await act(a, { type: 'wait' });
    setMe(a, (e) => { e.stats!.hp = 20; });
    const to = { x: a.ox + 12, y: a.oy };
    const v = projectPlayerView(a.world, a.pid);
    expect(v.entities.some((e) => e.cat === 'monster' && e.awareness === 'hunting')).toBe(true);
    // 断る判定（valid_actions と同じ macroProbe）
    const d = macroProbe(v, { type: 'travel', to, mode: 'flee' }, catalog).decision;
    expect('stop' in d && d.stop).toBe('flee_lethal');
    const no = await act(a, { type: 'travel', to, mode: 'flee' });
    expect(no.ok).toBe(false);
    if (!no.ok) {
      expect(no.error.code).toBe('flee_lethal');
      expect(no.error.message).toContain('次の 1 歩の間の最悪の見込み 30');
      expect(no.error.message).toContain('いまの HP 20');
      expect(no.error.hint).toContain('帰還の綱');
    }
    // steady の移動には、この判定は入らない（今までどおり）
    expect('stop' in macroProbe(v, { type: 'travel', to, mode: 'steady' }, catalog).decision && (macroProbe(v, { type: 'travel', to, mode: 'steady' }, catalog).decision as { stop: string }).stop).not.toBe('flee_lethal');
    // 最悪の見込みより HP が多ければ、今までどおり逃げる
    setMe(a, (e) => { e.stats!.hp = 31; });
    const go = macroProbe(projectPlayerView(a.world, a.pid), { type: 'travel', to, mode: 'flee' }, catalog).decision;
    expect('command' in go).toBe(true);
    a.manager.closeAll();
  });
});

describe('S6a §50.4 の 2・4・7: a flight stops on the way once one worst turn could kill you; on the turn it arrives it says arrived', () => {
  it('on the way: a fast hunter catches up and the flight stops with the numbers and the options', async () => {
    const a = await arena('s6a-mid', { map: ['G......P.............'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting', speed: 200 } });
    setMe(a, (e) => { e.stats!.hp = 20; e.stats!.maxHp = 60; });
    remember(a, 'core:goblin', { maxDamageToYou: 30, maxPlainToYou: 20, hitsOnYou: [1, 1], dmgOnYou: [30, 1, 1] });
    await act(a, { type: 'wait' });
    setMe(a, (e) => { e.stats!.hp = 20; });
    const x0 = a.world.entities[a.meId].pos!.x;
    const r = await act(a, { type: 'travel', to: { x: a.ox + 20, y: a.oy }, mode: 'flee' });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    if (!r.ok) return;
    // 何歩か進んでから、追いつかれて止まった（始める前は届く敵がいない）
    expect(a.world.entities[a.meId].pos!.x).toBeGreaterThan(x0);
    expect(a.world.entities[a.meId].pos!.x).toBeLessThan(a.ox + 20);
    // 速さ 2 倍の相手は、次の 1 歩の間に 2 回殴れる（最悪 30 × 2）
    expect(r.outcome).toContain('停止: 次の 1 歩の間に、届く敵の最悪の 1 手で倒れうる');
    expect(r.outcome).toContain('次の 1 歩の間の最悪の見込み 60');
    expect(r.outcome).toMatch(/取れる手: 帰還の綱（use_item \{ slot: '.' \}）・.*向きを変える/);
    expect(r.outcome).not.toContain('use_stairs');
    a.manager.closeAll();
  });

  it('the turn it steps onto the stairs it reports arrived (not flee_lethal); on the stairs the options add use_stairs and extract', async () => {
    const a = await arena('s6a-arrive', { map: ['G.......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting', speed: 200 } });
    stairsAt(a, a.ox + 4, a.oy);
    setMe(a, (e) => { e.pos = { floor: a.key, x: a.ox + 3, y: a.oy }; e.stats!.hp = 20; e.stats!.maxHp = 60; });
    remember(a, 'core:goblin', { maxDamageToYou: 30, maxPlainToYou: 20, hitsOnYou: [1, 1], dmgOnYou: [30, 1, 1] });
    await act(a, { type: 'wait' });
    // 2 マス先（届かない）。1 歩で階段に着くと、速い相手が隣に来る
    setG(a, (e) => { e.pos = { floor: a.key, x: a.ox + 1, y: a.oy }; });
    setMe(a, (e) => { e.stats!.hp = 20; });
    const r = await act(a, { type: 'travel', to: 'stairs_down', mode: 'flee' });
    expect(r.ok ? '' : JSON.stringify(r.error)).toBe('');
    expect(a.world.entities[a.meId].pos).toMatchObject({ x: a.ox + 4, y: a.oy });
    expect(Math.abs(a.world.entities[a.gId].pos!.x - (a.ox + 4))).toBe(1);
    if (r.ok) expect(r.outcome).not.toContain('最悪の見込み');
    expect(JSON.stringify(r)).not.toContain('flee_lethal');
    const v = projectPlayerView(a.world, a.pid);
    const d = macroProbe(v, { type: 'travel', to: 'stairs_down', mode: 'flee' }, catalog).decision;
    expect('stop' in d && d.stop).toBe('arrived');
    // 階段の上で、ほかの行き先への逃げは断る（死にうる）。取れる手に、階段と extract
    const no = await act(a, { type: 'travel', to: { x: a.ox, y: a.oy }, mode: 'flee' });
    expect(!no.ok && no.error.code).toBe('flee_lethal');
    if (!no.ok) expect(no.error.hint).toMatch(/^取れる手: 階段を使う（use_stairs で降りる。敵は階段を追ってこないが、その階に残る。離れている間、その階の時間は止まり、戻ると同じ所にいる）・ここで帰る（extract。目的は未達: confirm: true で撤退）・帰還の綱（use_item \{ slot: '.' \}）・.*向きを変える/);
    expect(fleeOptionsText(v, catalog)).toContain('use_stairs');
    // 目的が未達なので、extract は confirm: true が無いと断られる（S6b: 取れる手にそう添える）
    expect(v.expedition!.status).not.toBe('objective_complete');
    const ex = await act(a, { type: 'extract' });
    expect(!ex.ok && ex.error.code).toBe('confirm_required');
    // 達成していれば、添えない
    const done = structuredClone(v);
    done.expedition!.status = 'objective_complete';
    if (done.expedition!.objective.type === 'retrieve_relic') done.expedition!.progress.relicHeldByYou = true;
    expect(fleeOptionsText(done, catalog)).toContain('・ここで帰る（extract）・');
    expect(fleeOptionsText({ ...done, locale: 'en' }, catalog)).toContain('go home from here (extract), ');
    expect(fleeOptionsText({ ...v, locale: 'en' }, catalog)).toContain('go home from here (extract; objective not met: withdraw with confirm: true), ');
    a.manager.closeAll();
  });

  it('a hunter with no record of its blows is left out of "could kill you" (the same as fight)', async () => {
    const a = await arena('s6a-unrec', { map: ['.G.P.........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    setMe(a, (e) => { e.pos = { floor: a.key, x: a.ox + 2, y: a.oy }; e.stats!.hp = 2; e.stats!.maxHp = 60; });
    await act(a, { type: 'wait' });
    setMe(a, (e) => { e.stats!.hp = 2; });
    const d = macroProbe(projectPlayerView(a.world, a.pid), { type: 'travel', to: { x: a.ox + 12, y: a.oy }, mode: 'flee' }, catalog).decision;
    expect('command' in d).toBe(true);
    a.manager.closeAll();
  });
});

describe('S6a §50.4 の 3・4: the stairs line falls back to flee when steady is refused; when both are refused, move and the lifeline stay', () => {
  it('HP at or below the steady hp_floor with an archer in sight: the line is the flee form; when the flight could kill you it says so and the move and lifeline lines remain', async () => {
    const a = await arena('s6a-stairs', { map: ['......P.G....'], guardian: { kind: 'core:bone_archer', hp: 50, dmg: '1d1', types: [], state: 'hunting', archetype: 'ranged_kiter' } });
    stairsAt(a, a.ox + 4, a.oy);
    setMe(a, (e) => { e.stats!.hp = 25; e.stats!.maxHp = 60; });
    remember(a, 'core:bone_archer', { encounters: 2, maxDamageToYou: 8, maxPlainToYou: 8, hitsOnYou: [3, 4], dmgOnYou: [18, 5, 6] });
    await act(a, { type: 'wait' });
    // 射手は 5 マス先、階段は 2 歩
    setG(a, (e) => { e.pos = { floor: a.key, x: a.ox + 11, y: a.oy }; e.actor!.ai = { ...e.actor!.ai!, state: 'hunting' }; });
    setMe(a, (e) => { e.pos = { floor: a.key, x: a.ox + 6, y: a.oy }; e.stats!.hp = 25; });
    const v = projectPlayerView(a.world, a.pid);
    expect(v.entities.find((e) => e.id === a.gId)?.awareness).toBe('hunting');
    const st = macroProbe(v, { type: 'travel', to: 'stairs_down', mode: 'steady' }, catalog).decision;
    expect('stop' in st && st.stop).toBe('hp_floor');
    const l1 = lines(a).filter((l) => l.startsWith('travel_to stairs_down'));
    expect(l1).toHaveLength(1);
    expect(l1[0]).toMatch(/^travel_to stairs_down mode:flee( \(|$)/);
    expect(l1[0]).not.toContain('不可');
    // 逃げも死にうる（最悪の一撃 30）: 不可の理由と、まだ取れる手。move の行と綱の行は残る
    remember(a, 'core:bone_archer', { encounters: 2, maxDamageToYou: 30, maxPlainToYou: 8, hitsOnYou: [3, 4], dmgOnYou: [40, 5, 30] });
    const l2 = lines(a);
    const sl = l2.find((l) => l.startsWith('travel_to stairs_down'))!;
    expect(sl).toMatch(/^travel_to stairs_down mode:flee \(不可: 次の 1 歩の間に、届く敵の最悪の 1 手で倒れうるので、逃げる移動を始めない（hp_floor によらない）/);
    expect(sl).toMatch(/。move で 1 歩ずつは動ける・帰還の綱（use_item \{ slot: '.' \}）\)$/);
    expect(l2.some((l) => l.startsWith('move '))).toBe(true);
    const life = a.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!;
    expect(l2.some((l) => l.startsWith(`use_item ${life.slot} `))).toBe(true);
    a.manager.closeAll();
  });
});

describe('S6 §49.6 の 2: valid_actions shows a macro line only when the command would not refuse it (macroProbe)', () => {
  it('fight against an adjacent hunter that could kill you in one worst turn is not offered (fight refuses with hp_risk); with enough HP it is', async () => {
    const a = await arena('s6-va', { map: ['.G.P......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    setMe(a, (e) => { e.pos = { floor: a.key, x: a.ox + 2, y: a.oy }; e.stats!.hp = 20; e.stats!.maxHp = 60; });
    remember(a, 'core:goblin', { maxDamageToYou: 30, maxPlainToYou: 20, hitsOnYou: [1, 1], dmgOnYou: [30, 1, 1] });
    await act(a, { type: 'wait' });
    setMe(a, (e) => { e.stats!.hp = 20; });
    const lines = () => buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false }).valid_actions;
    expect(lines().some((l) => l.startsWith(`fight ${a.gId}`))).toBe(false);
    const no = await act(a, { type: 'fight', target: a.gId });
    expect(!no.ok && no.error.code).toBe('hp_floor');
    setMe(a, (e) => { e.stats!.hp = 59; });
    expect(lines().some((l) => l.startsWith(`fight ${a.gId}`))).toBe(true);
    a.manager.closeAll();
  });
});

describe('S6 §49.6 の 4・5・6・8・9・10 and the deep sleeper text', () => {
  it('slip says how far it moves (2 cells, it does not stop on stairs one cell away)', async () => {
    const a = await arena('s6-slip', { map: ['.G.P......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' } });
    setMe(a, (e) => { e.pos = { floor: a.key, x: a.ox + 2, y: a.oy }; e.build = { perks: [], pending: [], abilities: [{ id: 'core:slip', readyAt: 0 }], offered: [] }; });
    await act(a, { type: 'wait' });
    expect(catalog.abilities['core:slip'].steps).toBe(2);
    const line = buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false }).valid_actions.find((l) => l.startsWith('use_ability slip') || l.startsWith('use_ability core:slip'));
    expect(line).toContain('2 マス動く（壁・閉じた扉・ほかの者の手前まで。罠を踏めばそこで止まる。1 マス先が階段でも止まらない）');
    a.manager.closeAll();
  });

  it('look by the id of a remembered altar of chance gives the same as by its cell (the table too)', async () => {
    const a = await arena('s6-look', { map: ['P.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId] });
    const at = { x: a.ox + 4, y: a.oy };
    const altar: Entity = { id: 'e_s6alt1', kind: 'core:gamble_altar', sid: 995001, pos: { floor: a.key, ...at }, feature: { state: 'idle' } } as Entity;
    a.inject({ put: [altar] });
    await act(a, { type: 'wait' });
    // 離れて見えなくなった（覚えている）
    const k = a.world.players[a.pid].knowledge;
    k.floors[a.key].remembered = [...k.floors[a.key].remembered.filter((x) => x.id !== altar.id), { id: altar.id, kind: altar.kind, cat: 'feature', pos: { ...at }, qty: 1, state: 'idle', seenAt: 0 } as never];
    k.visible = [];
    const v = projectPlayerView(a.world, a.pid);
    const byId = describeTarget(v, catalog, altar.id).text;
    const byPos = describeTarget(v, catalog, at).text;
    expect(byId).toBe(byPos);
    expect(byId).toContain('表: ');
    a.manager.closeAll();
  });

  it('threat of a species that attacked but never landed a hit reads "never landed a hit"; a worst hit that was a crit says so with the worst non-crit', async () => {
    const a = await arena('s6-threat', { map: ['P..G..'], guardian: { kind: 'core:bone_archer', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    remember(a, 'core:bone_archer', { encounters: 2, maxDamageToYou: 0, hitsOnYou: [0, 2] });
    await act(a, { type: 'wait' });
    let text = formatObservationText(a.r.port.observe().observation, 'ja');
    expect(text).toContain('不明（当てられた記録なし）');
    expect(text).not.toContain('被弾の記録なし');
    remember(a, 'core:bone_archer', { encounters: 2, maxDamageToYou: 8, maxPlainToYou: 1, hitsOnYou: [5, 6], dmgOnYou: [12, 5, 6] });
    const o = a.r.port.observe().observation;
    expect(o.visible.monsters[0].worst_hit).toBe(8);
    expect(o.visible.monsters[0].worst_plain_hit).toBe(1);
    text = formatObservationText(o, 'ja');
    expect(text).toContain('最大の一撃:8（会心。会心でない最大 1）');
    a.manager.closeAll();
  });

  it('equipping an amulet over a ring: the result names what came off and the shared slot first', async () => {
    const a = await arena('s6-equip', { map: ['P...'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { items: [{ kind: 'core:ring_vigilance' }, { kind: 'core:amulet_iron' }] } });
    a.inject({ del: [a.gId] });
    const inv = () => a.r.port.view().inventory;
    expect((await act(a, { type: 'equip', slot: inv().find((i) => i.kind === 'core:ring_vigilance')!.slot })).ok).toBe(true);
    const r = await act(a, { type: 'equip', slot: inv().find((i) => i.kind === 'core:amulet_iron')!.slot });
    expect(r.ok && r.outcome).toMatch(/^外れた品: 見張りの指輪（装飾品の枠は 1 つ: 指輪と護符は同時に付けられない）。 /);
    a.manager.closeAll();
  });

  it('reading a loose page says the terrain went onto the map (not just "used")', async () => {
    const a = await arena('s6-page', { map: ['P...'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { items: [{ kind: 'core:loose_page' }] } });
    a.inject({ del: [a.gId] });
    const page = a.r.port.view().inventory.find((i) => i.kind === 'core:loose_page')!;
    const r = await act(a, { type: 'use', slot: page.slot });
    expect(r.ok && r.outcome).toMatch(/地形が地図に載った（新しく \d+ マス。目で見たのではないので、敵と品はまだ分からない）。/);
    a.manager.closeAll();
  });

  it('the deep sleeper weakness text says the weakness is the blow before it notices you, not that it is hard to wake', () => {
    const w = catalog.guardianWeaknesses['core:weak_sleep'];
    expect(w.desc.ja).toContain('弱点は、この一撃の効き目のこと');
    expect(w.desc.ja).toContain('近づくうちに起きることがある');
    expect(w.desc.ja).not.toContain('起きにくい。');
  });
});

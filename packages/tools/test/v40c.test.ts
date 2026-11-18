// V4-0c（IMPROVEMENTS_V4 §4）の確認: 背の高い草の中の者は、攻撃しても隠れたまま。撃たれたら方角だけ。
// 見えるかどうかの判定は 1 つ（表示のリスト・記憶・出来事の伏せ方・敵の目・標的）。
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '@muse/content';
import type { Entity, GameEvent, PerceivedEvent } from '@muse/shared';
import { filterEventsForPlayer, macroNext, macroStart, projectPlayerView } from '@muse/shared';
import { actorPerceived } from '@muse/engine';
import { rulesText } from '@muse/server';
import { arena, content } from './v33duel';

const catalog = buildCatalog(content);
let sid = 996500;
type A = Awaited<ReturnType<typeof arena>>;
const grass = (a: A, cells: [number, number][]) => {
  const f = a.world.floors[a.key];
  const tg = a.world.meta.terrainTable.indexOf('core:tall_grass');
  for (const [x, y] of cells) f.terrain[(a.oy + y) * f.width + a.ox + x] = tg;
};
/** 守護者は部屋の隅で眠らせておく */
const quiet = (a: A) => { const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + a.W - 1, y: a.oy + a.H - 1 }; g.actor!.dormant = true; g.actor!.ai!.state = 'asleep'; a.inject({ put: [g] }); };
const monster = (a: A, id: string, kind: string, x: number, y: number, o: { state?: 'hunting' | 'unaware' | 'asleep'; archetype?: string; params?: Record<string, number>; hp?: number; maxHp?: number } = {}): Entity => {
  const me = a.world.entities[a.meId];
  const hp = o.hp ?? 30, maxHp = o.maxHp ?? hp;
  return {
    id, kind, sid: ++sid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: o.archetype ?? 'melee_chaser', state: o.state ?? 'hunting', targetPos: o.state === 'hunting' || !o.state ? { x: me.pos!.x, y: me.pos!.y } : null, lostTurns: 0, params: { ...(o.params ?? {}) } }, ...(o.state === 'asleep' ? { dormant: true } : {}) },
    stats: { hp, maxHp, acc: 5, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, base: { maxHp, acc: 5, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, statuses: [],
  } as Entity;
};
const archerName = content.monsters['core:bone_archer'].name.ja;

describe('V4-0c a shooter in tall grass stays hidden (§4.1, §4.4)', () => {
  it('list, memory, text and events carry no id, species, name or position; the direction is given', async () => {
    const a = await arena('v40c-shooter', { map: ['P.......', '........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200 } });
    quiet(a);
    grass(a, [[3, 0], [4, 0], [3, 1], [4, 1]]);
    a.inject({ put: [monster(a, 'e_sh0001', 'core:bone_archer', 3, 0, { archetype: 'ranged_stand' })] });
    const h0 = a.r.session.history.length;
    const hp0 = a.world.entities[a.meId].stats!.hp;
    const out: string[] = [];
    for (let i = 0; i < 5; i++) {
      out.push(JSON.stringify(await a.r.port.act({ type: 'wait' }, { source: 'bot' })));
      expect(projectPlayerView(a.world, a.pid).entities.some((e) => e.id === 'e_sh0001')).toBe(false);
    }
    // 撃たれている
    expect(a.world.entities[a.meId].stats!.hp).toBeLessThan(hp0);
    const evs = a.r.session.history.slice(h0) as GameEvent[];
    const pe = filterEventsForPlayer(evs, a.pid, projectPlayerView(a.world, a.pid));
    const atk = pe.filter((e) => e.type === 'attack' && (e as unknown as { target: string }).target === a.meId);
    expect(atk.length).toBeGreaterThan(0);
    for (const e of atk) expect(e).toMatchObject({ attacker: null, attackerKind: null, from: null, fromDir: 'e' });
    const all = JSON.stringify(pe) + out.join('');
    expect(all).not.toContain('e_sh0001');
    expect(all).not.toContain('core:bone_archer');
    expect(all).not.toContain(archerName);
    // 方角は出る。最悪の被害の見立てに入っていないと alerts に出る
    expect(out.join('')).toContain('東から');
    expect(out.join('')).toContain('unseen_shooter');
    // 種族の思い出にも残らない
    expect(a.world.players[a.pid].knowledge.monsterMemory['core:bone_archer']).toBeUndefined();
    expect(a.world.players[a.pid].knowledge.met).not.toContain('e_sh0001');
    a.manager.closeAll();
  });

  it('a macro stopped by a shot from the grass names the direction', async () => {
    const a = await arena('v40c-macro', { map: ['P.......', '........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200 } });
    quiet(a);
    grass(a, [[3, 0], [4, 0]]);
    a.inject({ put: [monster(a, 'e_sh0002', 'core:bone_archer', 3, 0, { archetype: 'ranged_stand' })] });
    // 休める HP にしておく（射手は撃つまで見えないので、休憩は始められる）
    const me = structuredClone(a.world.entities[a.meId]); me.stats!.hp = 100; a.inject({ put: [me] });
    const r = await a.r.port.act({ type: 'rest' }, { source: 'bot' });
    const s = JSON.stringify(r);
    expect(s).toContain('東から撃たれた。相手は見えていない。');
    expect(s).not.toContain('e_sh0002');
    a.manager.closeAll();
  });

  it('next to it, it is seen and can be targeted; two cells away in the grass it cannot', async () => {
    const a = await arena('v40c-adjacent', { map: ['P.......', '........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200, items: [{ kind: 'core:throwing_knife', qty: 3 }] } });
    quiet(a);
    grass(a, [[1, 1], [2, 0]]);
    a.inject({ put: [monster(a, 'e_ad0001', 'core:goblin', 1, 1, { state: 'asleep' }), monster(a, 'e_fa0001', 'core:goblin', 2, 0, { state: 'asleep' })] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    expect(v.entities.some((e) => e.id === 'e_ad0001')).toBe(true);
    expect(v.entities.some((e) => e.id === 'e_fa0001')).toBe(false);
    const knife = v.inventory.find((i) => i.kind === 'core:throwing_knife')!.slot;
    const far = await a.r.port.act({ type: 'throw', slot: knife, target: 'e_fa0001' }, { source: 'bot' });
    expect(far.ok).toBe(false);
    expect(JSON.stringify(far)).toContain('no_target');
    const farHit = await a.r.port.act({ type: 'attack', target: 'e_fa0001' }, { source: 'bot' });
    expect(farHit.ok).toBe(false);
    expect((await a.r.port.act({ type: 'throw', slot: knife, target: 'e_ad0001' }, { source: 'bot' })).ok).toBe(true);
    const fight = await a.r.port.act({ type: 'fight', target: 'e_ad0001', maxSteps: 3 } as never, { source: 'bot' });
    expect(fight.ok).toBe(true);
    a.manager.closeAll();
  });

  it('a monster hit by a throw from the grass does not learn where you are', async () => {
    const a = await arena('v40c-player-grass', { map: ['P.......', '........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200, items: [{ kind: 'core:throwing_knife', qty: 5 }] } });
    quiet(a);
    grass(a, [[0, 0]]);
    a.inject({ put: [monster(a, 'e_gb0001', 'core:goblin', 4, 0, { state: 'asleep', hp: 60 })] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const knife = projectPlayerView(a.world, a.pid).inventory.find((i) => i.kind === 'core:throwing_knife')!.slot;
    const me = a.world.entities[a.meId].pos!;
    for (let i = 0; i < 3; i++) {
      const r = await a.r.port.act({ type: 'throw', slot: knife, target: 'e_gb0001' }, { source: 'bot' });
      expect(r.ok).toBe(true);
      const g = a.world.entities.e_gb0001;
      // 起きても、居場所（草の中のプレイヤー）は知らない。見えたことにもならない
      expect(g.actor!.ai!.targetPos ?? null).not.toEqual({ x: me.x, y: me.y });
      expect(g.actor!.ai!.state).not.toBe('hunting');
    }
    a.manager.closeAll();
  });
});

describe('V4-0c one visibility judgment (§4.2)', () => {
  it('the event masking and the entity list agree on the same World', async () => {
    const a = await arena('v40c-agree', { map: ['P.......', '........', '........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200 } });
    quiet(a);
    grass(a, [[1, 1], [3, 0], [2, 2], [5, 2]]);
    a.inject({ put: [
      monster(a, 'e_ag0001', 'core:goblin', 1, 1, { state: 'asleep' }), // 草・隣
      monster(a, 'e_ag0002', 'core:goblin', 3, 0, { state: 'asleep' }), // 草・離れている
      monster(a, 'e_ag0003', 'core:goblin', 4, 1, { state: 'asleep' }), // 草でない
      monster(a, 'e_ag0004', 'core:goblin', 2, 2, { state: 'asleep' }), // 草・離れている
    ] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    const seen = new Map<string, boolean>();
    for (const id of ['e_ag0001', 'e_ag0002', 'e_ag0003', 'e_ag0004']) {
      const listed = v.entities.some((e) => e.id === id);
      seen.set(id, listed);
      expect(actorPerceived(a.world, content, a.pid, id)).toBe(listed);
    }
    expect([...seen.values()]).toEqual([true, false, true, false]);
    a.manager.closeAll();
  });

  it('stepping into the grass in view tells where it went; grass to grass is not told', async () => {
    const a = await arena('v40c-enter', { map: ['P.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200 } });
    quiet(a);
    grass(a, [[3, 0], [4, 0]]);
    // 視界を部屋の中で作り直してから、逃げる敵（HP が低い）を置く: 自分から遠ざかって草へ入る
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    a.inject({ put: [monster(a, 'e_en0001', 'core:goblin', 2, 0, { params: { fleeBelowHpPct: 50 }, hp: 5, maxHp: 30 })] });
    expect(a.r.port.observeWithTurn('observed').observation.visible.monsters.some((x) => x.id === 'e_en0001')).toBe(true);
    const h0 = a.r.session.history.length;
    const res: string[] = [];
    for (let i = 0; i < 3; i++) res.push(JSON.stringify(await a.r.port.act({ type: "wait" }, { source: "bot" })));
    const pe = filterEventsForPlayer(a.r.session.history.slice(h0) as GameEvent[], a.pid, projectPlayerView(a.world, a.pid));
    const moves = pe.filter((e) => e.type === 'entity_moved' && (e as unknown as { id: string }).id === 'e_en0001') as unknown as { from: { x: number } | null; to: { x: number; y: number } | null }[];
    // 見えていたマスから草へ: 行き先まで伝わる。草から草へ（行き来した分）は伝わらない
    const raw = a.r.session.history.slice(h0).filter((e) => e.type === 'entity_moved' && (e as unknown as { id: string }).id === 'e_en0001');
    expect(raw.length).toBeGreaterThanOrEqual(2);
    expect(moves.length).toBe(1);
    expect(moves[0].to).toEqual({ x: a.ox + 3, y: a.oy });
    expect(res.join('')).toContain(`見えなくなった敵: ゴブリン（最後に見た位置 (${a.ox + 3},${a.oy})・背の高い草の中）`);
    a.manager.closeAll();
  });

  it('fight remembers where the target was last seen when it steps into the grass', async () => {
    const a = await arena('v40c-fight', { map: ['P.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200 } });
    quiet(a);
    a.inject({ put: [monster(a, 'e_ft0001', 'core:goblin', 1, 0)] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const view = projectPlayerView(a.world, a.pid);
    const tg = view.entities.find((e) => e.id === 'e_ft0001')!;
    const st = macroStart(view, { type: 'fight', target: 'e_ft0001' }, catalog);
    expect(st.targetSeenAt).toEqual({ x: tg.pos.x, y: tg.pos.y });
    // 逃げて草へ入った（行き先が伝わった）: 最後に見た場所はその草のマス
    st.targetFleeing = true;
    const gone = { ...view, entities: view.entities.filter((e) => e.id !== 'e_ft0001') };
    const to = { x: tg.pos.x + 1, y: tg.pos.y };
    const ev = [{ type: 'entity_moved', id: 'e_ft0001', from: { x: tg.pos.x, y: tg.pos.y }, to, seq: view.seq + 1 }] as unknown as PerceivedEvent['event'][];
    expect(macroNext(st, gone, catalog, ev)).toMatchObject({ stop: 'target_fled' });
    expect(st.targetSeenAt).toEqual(to);
    a.manager.closeAll();
  });

  it('get_rules says that someone in tall grass stays hidden when attacking', () => {
    expect(rulesText('all', 'ja', catalog)).toContain('攻撃しても隠れたままである（あなたも敵も）。草の中から撃たれたときは、方角だけが分かる');
    expect(rulesText('all', 'en', catalog)).toContain('stays hidden even when it attacks');
  });
});

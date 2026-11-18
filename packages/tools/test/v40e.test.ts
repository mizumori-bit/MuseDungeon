// V4-0e（IMPROVEMENTS_V4 §8）の確認: 階は作られたときの性質を覚えていて見せる（候補の通り道・着いたとき・状態の行）、
// 階を作るときだけに効く条件は目的の階が新しい候補にだけ付く、遠征の間にすべての階の敵が落ち着く、「見た被害」。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, ExpeditionOffer, GameEvent } from '@muse/shared';
import { applyEvent, offerFloorTraitsText, offerGap, offerText } from '@muse/shared';
import { previewOffers } from '@muse/engine';
import { loadConfig, rulesText, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
const rules = catalog.rules!;
let sid = 994000;

async function newRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const place = (x: number, y: number) => { const m = structuredClone(me()); m.pos = { floor: m.pos!.floor, x, y }; inject({ put: [m] }); };
  const clearHere = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player && !e.guardian && e.role !== 'elite' && e.pos?.floor === me().pos?.floor).map((e) => e.id) });
  /** 下り階段から 1 階降りる（その階の敵は消してから。降りた先の応答を返す） */
  const descend = async () => {
    const f = world.floors[me().pos!.floor];
    place(f.stairs.down[0].x, f.stairs.down[0].y);
    clearHere();
    await act({ type: 'wait' });
    const res = await act({ type: 'stairs' }) as unknown as { ok: boolean; turn?: { changes: { code: string; text: string }[] } };
    expect(res.ok).toBe(true);
    return res;
  };
  /** 今いる階の階段の上で撤退する（次の遠征はこの階から） */
  const withdrawHere = async () => {
    const f = world.floors[me().pos!.floor];
    const st = f.stairs.up ?? f.stairs.down[0];
    place(st.x, st.y);
    clearHere();
    await act({ type: 'wait' });
    expect((await act({ type: 'extract', confirm: true })).ok).toBe(true);
  };
  /** キャンプの候補を差し替える（この offer で次の遠征を始める） */
  const offer = (o: Partial<ExpeditionOffer> & { objective: ExpeditionOffer['objective'] }) => {
    world.camp!.offers = [{ index: 1, points: 500, relicGuarded: false, slot: 'standard', traits: [], multiplierPct: 100, ...o } as ExpeditionOffer];
  };
  const obs = () => r.port.observe({ map: false });
  return { manager, r, world, pid, meId, inject, me, act, place, clearHere, descend, withdrawHere, offer, obs };
}

function monster(id: string, floor: string, x: number, y: number, o: { hp?: number; state?: 'hunting' | 'searching' | 'unaware' | 'asleep' } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind: 'core:goblin', sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.state ?? 'hunting', targetPos: { x, y }, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' },
    base: { maxHp: hp, acc: 0, eva: -50, might: 0, armor: 0, sight: 7, dmg: '1d1' },
    statuses: [],
  };
}

/** 階の通れるマスのうち、x の小さい順で最初のもの（階段・アクターのいるマスを除く） */
function openCell(t: Awaited<ReturnType<typeof newRun>>, key: string, skip = 0): { x: number; y: number } {
  const f = t.world.floors[key];
  let n = 0;
  for (let y = 1; y < f.height - 1; y++) {
    for (let x = 1; x < f.width - 1; x++) {
      const tr = content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[y * f.width + x]]]];
      if (!tr?.passable || tr.stairs) continue;
      if (Object.values(t.world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y)) continue;
      if (n++ === skip) return { x, y };
    }
  }
  throw new Error('no open cell');
}

describe('V4-0e floor traits (§8.1)', () => {
  it('floors made under "crowded" remember it, and show it on arrival and in the status line on a later expedition without traits', async () => {
    const t = await newRun('v40e-traits-1');
    t.offer({ objective: { type: 'reach_depth', targetDepth: 3 }, traits: ['core:crowded'], multiplierPct: 120 });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descend();
    await t.descend();
    // 地下 1 階はランの開始時に作った（条件は効いていない）。地下 2・3 階はこの遠征で作った
    expect(t.world.floors['main:1'].genTraits).toEqual([]);
    expect(t.world.floors['main:2'].genTraits).toEqual(['core:crowded']);
    expect(t.world.floors['main:3'].genTraits).toEqual(['core:crowded']);
    await t.descend();
    // 目標階（3）より深い階には条件が効かない
    expect(t.world.floors['main:4'].genTraits).toEqual([]);
    // 地下 1 階まで上がって撤退し、条件の無い遠征で地下 2 階へ
    for (let d = 4; d > 1; d--) {
      const f = t.world.floors[t.me().pos!.floor];
      t.place(f.stairs.up!.x, f.stairs.up!.y);
      t.clearHere();
      await t.act({ type: 'wait' });
      expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    }
    await t.withdrawHere();
    t.offer({ objective: { type: 'reach_depth', targetDepth: 5 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const res = await t.descend();
    expect(t.me().pos!.floor).toBe('main:2');
    expect(res.turn?.changes.find((c) => c.code === 'floor_changed')?.text).toBe('地下2階に移った。この階は群れている（敵と宝が多い）');
    const o = t.obs();
    expect(o.observation.self.floor?.traits).toEqual(['core:crowded']);
    expect(o.observation.self.floor?.trait_text).toBe('群れている（敵と宝が多い）');
    expect(o.text).toContain('この階: 群れている（敵と宝が多い）');
    // 性質の無い階には出ない
    await t.descend();
    await t.descend();
    expect(t.obs().observation.self.floor?.trait_text).toBeUndefined();
    t.manager.closeAll();
  });

  it('offers list the target and on-the-way floors that exist with a trait (not floors not made yet), and the danger counts a crowded floor once', async () => {
    const t = await newRun('v40e-offer-1');
    t.offer({ objective: { type: 'reach_depth', targetDepth: 4 }, traits: ['core:crowded'], multiplierPct: 120 });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descend();
    await t.descend();
    await t.descend();
    await t.withdrawHere();
    // 地下 4 階から再開する: 通り道は 4 から目標まで（目標が上なら、上がっていく階）。群れているのは 2〜4
    const offers = t.world.camp!.offers;
    let shown = 0;
    for (const o of offers) {
      const td = o.objective.targetDepth!;
      const want = [2, 3, 4].filter((d) => d >= Math.min(4, td) && d <= Math.max(4, td));
      if (!want.length) { expect(o.floorTraits).toBeUndefined(); continue; }
      expect(o.floorTraits).toEqual([{ trait: 'core:crowded', depths: want }]);
      // 階の性質の危険度（群れる階層と同じだけ。候補に群れる階層が付いていれば 2 回は数えない）
      const base = offerGap(rules, td, o.traits ?? [], 1).traitDanger;
      const g = offerGap(rules, td, o.traits ?? [], 1, { floorTraits: ['core:crowded'] }).traitDanger;
      expect(g - base).toBe((o.traits ?? []).includes('core:crowded') ? 0 : 1);
      shown++;
    }
    expect(shown).toBeGreaterThan(0);
    const camp = t.obs();
    const withFt = camp.observation.camp!.offers.find((o) => o.floor_traits);
    expect(withFt?.floor_traits?.[0]).toMatchObject({ trait: 'core:crowded', name: '群れている' });
    expect(camp.text).toMatch(/(目的の|目的と通り道の|通り道の)地下 [\d〜・]+ 階は群れている/);
    t.manager.closeAll();
  });

  it('the offer texts read as designed (path, target, both; ranges)', () => {
    const o = (td: number, depths: number[]) => ({ objective: { targetDepth: td }, floorTraits: [{ trait: 'core:crowded', depths }] });
    expect(offerFloorTraitsText('ja', rules, o(17, [13, 14, 15, 16]))).toBe('通り道の地下 13〜16 階は群れている');
    expect(offerFloorTraitsText('ja', rules, o(16, [16]))).toBe('目的の地下 16 階は群れている');
    expect(offerFloorTraitsText('ja', rules, o(16, [13, 14, 16]))).toBe('目的と通り道の地下 13〜14・16 階は群れている');
    expect(offerFloorTraitsText('en', rules, o(17, [13, 14, 15, 16]))).toBe('on the way, depths 13-16 are crowded');
    expect(offerFloorTraitsText('ja', rules, { objective: { targetDepth: 9 }, floorTraits: [{ trait: 'core:scarce', depths: [8] }, { trait: 'core:quiet', depths: [8] }] }))
      .toBe('通り道の地下 8 階は乏しい / 通り道の地下 8 階は泉が無い');
    // 候補の文の中
    const offer = { index: 1, objective: { type: 'reach_depth', targetDepth: 17 }, points: 100, relicGuarded: false, traits: [], multiplierPct: 100, floorTraits: [{ trait: 'core:crowded', depths: [14, 15, 16] }] } as ExpeditionOffer;
    const text = offerText('ja', offer, { rules, level: 20 });
    expect(text).toContain(' / 通り道の地下 14〜16 階は群れている');
    expect(text).toContain('／条件 +1');
    // 乏しい階は危険度を上げない
    expect(offerGap(rules, 9, [], 1, { floorTraits: ['core:scarce', 'core:quiet'] }).traitDanger).toBe(0);
  });

  it('old floors get their traits at the start of the next expedition (from the oldest monster or feature left on the floor)', async () => {
    const t = await newRun('v40e-migrate-1');
    t.offer({ objective: { type: 'reach_depth', targetDepth: 3 }, traits: ['core:crowded', 'core:dim'], multiplierPct: 150 });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descend();
    await t.descend();
    await t.descend();
    await t.withdrawHere();
    // 古い版のランのように、階の性質を消す。地下 3 階は、残っている者をすべて消す（深さで、初めて届いた遠征から決める）
    for (const f of Object.values(t.world.floors)) delete f.genTraits;
    t.inject({ del: Object.values(t.world.entities).filter((e) => e.pos?.floor === 'main:3' && !e.player && !e.item).map((e) => e.id) });
    const n0 = t.r.session.history.length;
    t.offer({ objective: { type: 'reach_depth', targetDepth: 6 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const noted = t.r.session.history.slice(n0).filter((e) => e.type === 'floor_traits_noted');
    expect(noted.length).toBe(1);
    expect(t.world.floors['main:1'].genTraits).toEqual([]);
    expect(t.world.floors['main:2'].genTraits).toEqual(['core:crowded']);
    expect(t.world.floors['main:3'].genTraits).toEqual(['core:crowded']);
    expect(t.world.floors['main:4'].genTraits).toEqual([]);
    // 2 回目からは足さない
    const n1 = t.r.session.history.length;
    await t.withdrawHere();
    t.offer({ objective: { type: 'reach_depth', targetDepth: 6 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(t.r.session.history.slice(n1).some((e) => e.type === 'floor_traits_noted')).toBe(false);
    t.manager.closeAll();
  });
});

describe('V4-0e traits only where they can work (§8.2)', () => {
  it('crowded and scarce are not offered when the target floor already exists; quiet still can be', async () => {
    let built = 0, fresh = 0, freshGen = 0, builtQuiet = 0;
    const count = (t: Awaited<ReturnType<typeof newRun>>) => {
      for (let no = 2; no < 60; no++) {
        for (const o of previewOffers(t.world, content, no)) {
          const has = !!t.world.floors[`main:${o.objective.targetDepth}`];
          const tr = o.traits ?? [];
          if (has) {
            built++;
            expect(tr.includes('core:crowded') || tr.includes('core:scarce')).toBe(false);
            if (tr.includes('core:quiet')) builtQuiet++;
          } else {
            fresh++;
            if (tr.includes('core:crowded') || tr.includes('core:scarce')) freshGen++;
          }
        }
      }
    };
    // 地下 1 階だけ（目標はほとんど作られていない）
    const a = await newRun('v40e-gen-1');
    count(a);
    a.manager.closeAll();
    // 地下 1〜5 階を作ったラン（目標はほとんど作られている。地下 5 階は節目なので、その先へは降りない）
    const b = await newRun('v40e-gen-2');
    b.offer({ objective: { type: 'reach_depth', targetDepth: 4 } });
    expect((await b.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    for (let k = 0; k < 4; k++) await b.descend();
    await b.withdrawHere();
    count(b);
    b.manager.closeAll();
    expect(built).toBeGreaterThan(20);
    expect(fresh).toBeGreaterThan(20);
    expect(freshGen).toBeGreaterThan(0);
    expect(builtQuiet).toBeGreaterThan(0);
  });
});

describe('V4-0e every floor settles between expeditions (§8.3)', () => {
  it('monsters on a floor that is not the restart floor stop hunting, heal, lose statuses, and your damage_seen is cleared', async () => {
    const t = await newRun('v40e-settle-1');
    t.offer({ objective: { type: 'reach_depth', targetDepth: 3 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descend();
    await t.descend();
    // 地下 1 階に、追跡中で傷と毒のある敵と、眠っていて傷のある敵。地下 2 階に、体力は満ちているが見た被害の記憶が残っている敵
    const c1 = openCell(t, 'main:1');
    const c2 = openCell(t, 'main:1', 5);
    const c3 = openCell(t, 'main:2');
    const a = monster('e_v40e01', 'main:1', c1.x, c1.y, { hp: 30 });
    a.stats!.hp = 12;
    a.statuses = [{ id: 'core:poison', turnsLeft: 9, power: 1, source: null }];
    a.actor!.ai!.intent = { kind: 'winding_up', dir: 'e' };
    const b = monster('e_v40e02', 'main:1', c2.x, c2.y, { hp: 30, state: 'asleep' });
    b.stats!.hp = 20;
    b.actor!.ai!.targetPos = null;
    b.actor!.dormant = true;
    const c = monster('e_v40e03', 'main:2', c3.x, c3.y, { hp: 30, state: 'searching' });
    t.inject({ put: [a, b, c] });
    t.world.players[t.pid].knowledge.damageSeen = { e_v40e01: 18, e_v40e02: 10, e_v40e03: 7 };
    // 地下 3 階で撤退する（再開する階は地下 3 階。地下 1・2 階は今までは落ち着かなかった）
    await t.withdrawHere();
    expect(t.world.players[t.pid].extractPos?.floor).toBe('main:3');
    t.offer({ objective: { type: 'reach_depth', targetDepth: 5 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const A = t.world.entities.e_v40e01, B = t.world.entities.e_v40e02, C = t.world.entities.e_v40e03;
    expect(A.actor!.ai!.state).toBe('unaware');
    expect(A.actor!.ai!.targetPos).toBeNull();
    expect(A.actor!.ai!.intent).toBeUndefined();
    expect(A.stats!.hp).toBe(30);
    expect(A.statuses ?? []).toEqual([]);
    expect(B.actor!.ai!.state).toBe('asleep');
    expect(B.actor!.dormant).toBe(true);
    expect(B.stats!.hp).toBe(30);
    expect(C.actor!.ai!.state).toBe('unaware');
    // 敵は動かない（離れた場所へ移すのは、再開する階で再開するマスが見える敵だけ）
    expect(A.pos).toMatchObject(c1);
    expect(C.pos).toMatchObject(c3);
    expect(t.world.players[t.pid].knowledge.damageSeen ?? {}).toEqual({});
    t.manager.closeAll();
  });

  it('a rematch guardian on the restart floor keeps its scar (it used to be healed fully first)', async () => {
    const t = await newRun('v40e-scar-1');
    t.offer({ objective: { type: 'slay_guardian', targetDepth: 2 }, guardian: { rank: 2, traits: [], name: { ja: '試し', en: 'Trial' }, types: [] } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descend();
    const key = t.me().pos!.floor;
    const g = structuredClone(Object.values(t.world.entities).find((e) => e.pos?.floor === key && e.guardian)!);
    const max = 200;
    g.stats!.maxHp = max; g.base!.maxHp = max;
    g.stats!.hp = max - 40;
    t.inject({ put: [g] });
    t.world.players[t.pid].knowledge.damageSeen = { [g.id]: 40 };
    // 守護者のいる階（地下 2 階）の階段で撤退する: 次の遠征はこの階から
    await t.withdrawHere();
    expect(t.world.players[t.pid].extractPos?.floor).toBe(key);
    t.offer({ objective: { type: 'slay_guardian', targetDepth: 2 }, rechallenge: { no: 1, guardian: g.id }, guardian: { rank: 2, traits: [], name: { ja: '試し', en: 'Trial' }, types: [] }, scar: 10 });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const after = t.world.entities[g.id];
    expect(after.scar).toBe(10);
    expect(after.stats!.hp).toBe(max - 10);
    expect(t.world.players[t.pid].knowledge.damageSeen?.[g.id]).toBeUndefined();
    t.manager.closeAll();
  });
});

describe('V4-0e "damage you saw" (§8.4)', () => {
  it('the observation says 見た被害, and get_rules explains it and the floor traits', async () => {
    const t = await newRun('v40e-seen-1');
    t.offer({ objective: { type: 'reach_depth', targetDepth: 3 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const p = t.me().pos!;
    const f = t.world.floors[p.floor];
    const near = [[2, 0], [0, 2], [-2, 0], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2]].map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }))
      .find((q) => q.x > 0 && q.y > 0 && q.x < f.width && q.y < f.height && content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[q.y * f.width + q.x]]]]?.passable)!;
    const m = monster('e_v40e09', p.floor, near.x, near.y, { hp: 30, state: 'unaware' });
    m.stats!.hp = 20;
    t.inject({ put: [m] });
    t.world.players[t.pid].knowledge.damageSeen = { e_v40e09: 10 };
    const text = t.obs().text;
    expect(text).toContain('見た被害:10');
    expect(text).not.toContain('与ダメ累計');
    expect(t.r.port.look('e_v40e09').text).toContain('見た被害 10');
    t.manager.closeAll();

    const all = rulesText('all', 'ja', catalog);
    expect(all).toContain('見た被害（damage_seen。見ている間に、その個体が受けた被害の合計。自分の攻撃のほか、罠やほかの敵の分も入る。遠征をまたぐと消える）');
    expect(all).toContain('階は、作られたときの条件の性質を覚えている');
    expect(all).toContain('作られているすべての階が落ち着く');
    expect(all).toContain('群れる階層）: この遠征で初めて入る階は、敵の数が 1.5 倍、宝も 1.5 倍');
    const en = rulesText('all', 'en', catalog);
    expect(en).toContain('A floor remembers the traits it was made under');
    expect(en).toContain('every floor that has been made settles');
  });
});

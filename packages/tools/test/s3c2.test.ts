// S3c（SEASON.md §33）のテスト: 再挑戦の残り（§33.2）・そのほか（§33.3）
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { previewOffers } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, guardianBountyFull, macroNext, macroStart, offerPoints, projectPlayerView } from '@muse/shared';
import type { Command, Entity, ExpeditionOffer, GameEvent, World } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const manager = () => new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}

/** 地下 4 階まで降りて、到達で帰ったキャンプ（安全の枠は、地下 5 階の節目の手前の「守護者を倒す」地下 4 階） */
async function campAt4(m: SessionManager, seed: string) {
  const r = await m.createRun({ name: 'R', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  const w = r.session.world;
  const pid = r.port.playerId;
  const me = () => w.entities[w.players[pid].entityId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject(w, { put: [e] }); };
  const clearMonsters = () => inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
  const toDown = async () => {
    const f = w.floors[me().pos!.floor];
    edit((e) => { e.pos = { floor: e.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y }; });
    clearMonsters();
    await act(r.port, { type: 'wait' });
  };
  const reach = w.expeditions!.at(-1)!;
  reach.objective.targetDepth = 4;
  for (let d = 1; d < 4; d++) { await toDown(); expect((await act(r.port, { type: 'stairs' })).ok).toBe(true); clearMonsters(); }
  await toDown();
  expect((await act(r.port, { type: 'extract' })).ok).toBe(true);
  expect(r.port.view().status).toBe('at_camp');
  const withdraw = async () => {
    clearMonsters();
    await toDown();
    const x = await act(r.port, { type: 'extract', confirm: true });
    expect(x.ok ? '' : JSON.stringify(x.error)).toBe('');
    expect(r.port.view().status).toBe('at_camp');
  };
  const reoffer = () => { w.camp!.offers = previewOffers(w, content, w.camp!.nextNo); };
  return { r, w, pid, reach, withdraw, reoffer };
}
const safeOf = (w: World) => w.camp!.offers.find((o) => o.slot === 'safe')!;
const guardianOn4 = (w: World) => Object.values(w.entities).find((e) => e.pos?.floor === 'main:4' && e.role === 'guardian' && !e.guardian?.warden)!;

describe('S3c §33.2: what a rechallenge keeps', () => {
  it('a rechallenge keeps the points, conditions and multiplier of the expedition that placed the guardian (full stays full)', async () => {
    const m = manager();
    const t = await campAt4(m, 'v33b-offer-1');
    // 到達の達成を数えない（初めての地下 4 階の守護者 = 満額）
    t.reach.endReason = 'withdrawn';
    t.reoffer();
    const first = safeOf(t.w);
    expect(first.objective).toEqual({ type: 'slay_guardian', targetDepth: 4 });
    expect(first.repeatNo).toBeUndefined();
    expect((await act(t.r.port, { type: 'start_expedition', offer: first.index })).ok).toBe(true);
    const origin = t.w.expeditions!.at(-1)!;
    expect(origin.points).toBe(first.points);
    // 安全の枠は条件が付かないことが多いので、置いた遠征に条件と倍率を持たせる（引き継ぎが効いているかを見る）
    const trait = content.lists.expeditionTraits.find((x) => { const e = x.effects as Record<string, unknown> | undefined; return !!e && (e.wanderIntervalPct !== undefined || e.sightDelta !== undefined || !!e.noWander); })!;
    origin.traits = [trait.id];
    origin.multiplierPct = 137;
    for (let k = 0; k < 3; k++) {
      await t.withdraw();
      const re = safeOf(t.w);
      expect(re.rechallenge?.inherits).toBe(true);
      expect(re.points).toBe(origin.points);
      expect(re.traits).toEqual(origin.traits);
      expect(re.multiplierPct).toBe(origin.multiplierPct);
      expect((await act(t.r.port, { type: 'start_expedition', offer: re.index })).ok).toBe(true);
      expect(t.w.expeditions!.at(-1)!.multiplierPct).toBe(origin.multiplierPct);
      expect(t.w.expeditions!.at(-1)!.traits).toEqual(origin.traits);
    }
    m.closeAll();
  });

  it('a guardian left by a relic expedition: the rechallenge counts the repeat, cuts the bounty by the same share, and the guardian keeps the cut bounty; an older full-price rechallenge in the chain is not inherited', async () => {
    const m = manager();
    const t = await campAt4(m, 'v33b-offer-1');
    t.reach.endReason = 'withdrawn';
    t.reoffer();
    expect((await act(t.r.port, { type: 'start_expedition', offer: safeOf(t.w).index })).ok).toBe(true);
    const placedBy = t.w.expeditions!.at(-1)!;
    const g = guardianOn4(t.w);
    const full = guardianBountyFull(content.balance.haul, 4);
    expect(g.bounty).toBe(full);
    await t.withdraw();
    // 置いた遠征を「遺物を取る」（達成）にする。到達の達成も数える → 地下 4 階の達成は 2 回 → 3 回目（25%）
    placedBy.objective = { type: 'retrieve_relic', targetDepth: 4 };
    placedBy.endReason = 'completed';
    t.reach.endReason = 'completed';
    // 前の版で満額のまま付いた「守護者を倒す」の再挑戦（鎖の途中）も足しておく: 置いた遠征ではないので、引き継がない
    t.w.expeditions!.push({ ...structuredClone(placedBy), no: placedBy.no + 50, objective: { type: 'slay_guardian', targetDepth: 4 }, endReason: 'withdrawn', points: 99_999 });
    t.reoffer();
    const re = safeOf(t.w);
    const pr = { expedition: content.balance.expedition, slots: content.balance.expedition.slots as never };
    const base = offerPoints(pr, 'safe', 'slay_guardian', false, 4);
    expect(re.rechallenge?.guardian).toBe(g.id);
    expect(re.rechallenge?.inherits).toBeUndefined();
    expect(re.repeatNo).toBe(3);
    expect(re.repeatPct).toBe(25);
    expect(re.points).toBe(Math.trunc((base * 25) / 100));
    expect(re.guardianBounty).toBe(Math.trunc((full * 25) / 100));
    const text = t.r.port.observe({ map: false }).observation.camp!.offers.find((o) => o.slot === 'safe')!.text;
    expect(text).toContain('基礎点と守護者の賞金が減っている（25%）');
    expect(text).toContain(`守護者の賞金 +${re.guardianBounty}`);
    expect(text).not.toContain('置いた遠征のまま');
    // 始めると、守護者の賞金が候補の額になる（倒したときに入るのは個体の賞金）
    expect((await act(t.r.port, { type: 'start_expedition', offer: re.index })).ok).toBe(true);
    expect(t.w.entities[g.id].bounty).toBe(re.guardianBounty);
    // 個体の賞金がもう低ければ、そのまま（低いほう）
    await t.withdraw();
    expect(safeOf(t.w).guardianBounty).toBe(t.w.entities[g.id].bounty);
    m.closeAll();
  });

  it('another offer in between sends the guardian away; the next one at that floor is a new guardian with the repeat cut', async () => {
    const m = manager();
    const t = await campAt4(m, 'v33b-offer-1');
    expect((await act(t.r.port, { type: 'start_expedition', offer: safeOf(t.w).index })).ok).toBe(true);
    const g = guardianOn4(t.w);
    await t.withdraw();
    expect(safeOf(t.w).rechallenge?.guardian).toBe(g.id);
    const other = t.w.camp!.offers.find((o) => o.slot !== 'safe')!;
    expect((await act(t.r.port, { type: 'start_expedition', offer: other.index })).ok).toBe(true);
    expect(t.w.entities[g.id]?.pos).toBeUndefined();
    await t.withdraw();
    const next = safeOf(t.w);
    expect(next.objective).toEqual({ type: 'slay_guardian', targetDepth: 4 });
    expect(next.rechallenge).toBeUndefined();
    expect(next.repeatNo).toBe(2);
    expect(next.repeatPct).toBe(50);
    m.closeAll();
  });

  it('a bounty rechallenge keeps the points, conditions and multiplier of the expedition that set the bounty', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'B', seed: 's3c-bounty-1', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const cur = w.expeditions!.at(-1)!;
    // 地下 7 階を目標にして帰ったことにする（候補は地下 8 階から。節目は越えたことにする）
    w.milestones = { cleared: [5, 10, 15] };
    w.expeditions!.unshift({ ...structuredClone(cur), no: 0, objective: { type: 'reach_depth', targetDepth: 7 }, endReason: 'completed', extracted: [{ player: r.port.playerId, completed: true, lifeline: false } as never] });
    // 階を作るときだけに効く条件でないもの
    const trait = content.lists.expeditionTraits.find((x) => { const e = x.effects as Record<string, unknown> | undefined; return !!e && (e.wanderIntervalPct !== undefined || e.sightDelta !== undefined || !!e.noWander); })!;
    expect(trait).toBeTruthy();
    const sample = Object.values(w.entities).find((e) => e.actor && !e.player)!;
    for (const d of [8, 9, 10, 11]) {
      const id = `e_s3cb${d}`;
      inject(w, { put: [{ ...structuredClone(sample), id, sid: 990000 + d, named: { ja: `首${d}`, en: `Head${d}` }, pos: { floor: `main:${d}`, x: 1, y: 1 } } as Entity] });
      w.expeditions!.push({ ...structuredClone(cur), no: 100 + d, objective: { type: 'slay_bounty', targetDepth: d }, endReason: 'withdrawn', points: 7000 + d, traits: [trait.id], multiplierPct: 137, targets: { guardian: null, relic: null, bounty: id } });
    }
    let found: ExpeditionOffer | undefined;
    for (let no = 2; no < 300 && !found; no++) found = previewOffers(w, content, no).find((o) => o.rechallenge?.bounty);
    expect(found).toBeTruthy();
    const d = found!.objective.targetDepth!;
    expect(found!.rechallenge!.guardian).toBe(`e_s3cb${d}`);
    expect(found!.rechallenge!.inherits).toBe(true);
    expect(found!.points).toBe(7000 + d);
    expect(found!.traits).toEqual([trait.id]);
    expect(found!.multiplierPct).toBe(137);
    m.closeAll();
  });
});

describe('S3c §33.3', () => {
  it('1: a remembered item keeps the affixes it had when seen (its curse found out of sight, or an ally holding it, does not change the map); old records show the name only', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'M', seed: 's3c-mem-1', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const pid = r.port.playerId;
    const meE = w.entities[w.players[pid].entityId];
    const key = meE.pos!.floor;
    const f = w.floors[key];
    const T = (x: number, y: number) => content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
    const occupied = (x: number, y: number) => Object.values(w.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y);
    const p = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dy]) => ({ x: meE.pos!.x + dx, y: meE.pos!.y + dy })).find((q) => T(q.x, q.y).passable && !T(q.x, q.y).door && !occupied(q.x, q.y))!;
    const id = 'e_s3cmem';
    inject(w, { put: [{ id, kind: 'core:short_sword', sid: 991234, pos: { floor: key, x: p.x, y: p.y }, item: { qty: 1, affixes: ['core:keen'] } } as Entity] });
    await act(r.port, { type: 'wait' });
    const rem = () => projectPlayerView(w, pid).memory.remembered.find((x) => x.id === id);
    const fk = () => w.players[pid].knowledge.floors[key].remembered.find((x) => x.id === id)!;
    // 見たときの接辞を覚えている
    expect(fk().affixes).toEqual(['core:keen']);
    // 見ていない間に、呪いが見つかった・仲間が持った: 覚えている地図は、見たときのまま
    const cursed = structuredClone(w.entities[id]);
    cursed.item!.affixes = ['core:keen', 'core:cursed'];
    cursed.item!.heldBy = 'e_other';
    delete cursed.pos;
    inject(w, { put: [cursed] });
    expect(rem()?.affixes).toEqual(['core:keen']);
    // 置き直された（見ていない）: まだ覚えたまま
    const back = structuredClone(w.entities[id]); delete back.item!.heldBy; back.pos = { floor: key, x: p.x, y: p.y }; inject(w, { put: [back] });
    expect(rem()?.affixes).toEqual(['core:keen']);
    // 接辞の無い古い記録: 名前だけ（今の World の接辞を出さない）
    delete fk().affixes;
    expect(rem()?.affixes).toBeUndefined();
    // 見直すと、そのときの接辞を覚え直す
    await act(r.port, { type: 'wait' });
    expect(fk().affixes).toEqual(['core:keen', 'core:cursed']);
    m.closeAll();
  });

  it('2: a move macro that stops going back and forth names the moving monster that kept changing the route (only the recent ones)', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'T', seed: 's3c-travel-1', classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
    if ('error' in r) throw new Error(r.error.message);
    const view = r.port.view();
    const st = macroStart(view, { type: 'travel', to: 'stairs_down' }, m.catalog);
    st.steps = 10;
    st.routeFoes = [{ id: 'e_imp', name: '小悪魔', step: 8 }, { id: 'e_old', name: '古い', step: 1 }];
    const here = view.self.pos!.y * 100000 + view.self.pos!.x;
    st.trail = [here, here + 1, here, here + 1];
    expect(macroNext(st, view, m.catalog, [])).toEqual({ stop: 'no_progress' });
    expect(st.noProgressBy).toEqual([{ id: 'e_imp', name: '小悪魔' }]);
    m.closeAll();
  });
});

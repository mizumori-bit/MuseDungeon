// S3b（SEASON.md §30）のテスト: 再挑戦の基礎点は引き継ぐ（§30.1）・くり返しの守護者の賞金（§30.2）・検査の指摘（§30.3）・小さいもの（§30.4）
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION, previewOffers } from '@muse/engine';
import { createApp, createMcpServer, loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, guardianBountyFull, offerPoints, projectPlayerView } from '@muse/shared';
import type { Command, Entity, Expedition, GameEvent, Pos, ServerMsg, World } from '@muse/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's3bt';
let sid = 997700;

function manager(): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });

/** ふつうのラン（遠征 1 は到達）。降りる・階段へ・敵を消す */
async function soloRun(m: SessionManager, seed: string) {
  const r = await m.createRun({ name: 'R', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  const w = r.session.world;
  const pid = r.port.playerId;
  const me = () => meOf(w, pid);
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject(w, { put: [e] }); };
  const clearMonsters = () => inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
  const toDown = async () => { const f = w.floors[me().pos!.floor]; edit((e) => { e.pos = { floor: e.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y }; }); clearMonsters(); await act(r.port, { type: 'wait' }); };
  const descend = async () => { await toDown(); const s = await act(r.port, { type: 'stairs' }); clearMonsters(); return s; };
  return { r, w, pid, me, edit, clearMonsters, toDown, descend };
}

describe('S3b §30.1・§30.2: repeats and rematches of a slay-guardian expedition', () => {
  it('a repeat cuts the guardian bounty like the base; a rematch after turning back keeps both (never back to full); the kill pays the cut bounty', async () => {
    const m = manager();
    const t = await soloRun(m, 'v33b-offer-1');
    const w = t.w;
    // 地下 4 階を目標にした達成が 2 回あったことにして、地下 4 階で達成して帰る（3 回目の達成 → 次の候補は 4 回目: 25%）
    const cur = w.expeditions![w.expeditions!.length - 1];
    for (const no of [90, 91]) w.expeditions!.push({ ...structuredClone(cur), no, status: 'ended', endReason: 'completed', objective: { type: 'reach_depth', targetDepth: 4 } });
    w.expeditions!.push(w.expeditions!.splice(w.expeditions!.indexOf(cur), 1)[0]);
    cur.objective.targetDepth = 4;
    for (let d = 1; d < 4; d++) expect((await t.descend()).ok).toBe(true);
    await t.toDown();
    expect((await act(t.r.port, { type: 'extract' })).ok).toBe(true);
    const full = guardianBountyFull(content.balance.haul, 4);
    const pr = { expedition: content.balance.expedition, slots: content.balance.expedition.slots as never };
    const base = offerPoints(pr, 'safe', 'slay_guardian', false, 4);
    const safe = w.camp!.offers.find((o) => o.slot === 'safe')!;
    expect(safe.objective).toEqual({ type: 'slay_guardian', targetDepth: 4 });
    expect(safe.repeatNo).toBe(4);
    expect(safe.repeatPct).toBe(25);
    expect(safe.points).toBe(Math.trunc((base * 25) / 100));
    expect(safe.guardianBounty).toBe(Math.trunc((full * 25) / 100));
    const text = t.r.port.observe({ map: false }).observation.camp!.offers.find((o) => o.slot === 'safe')!;
    expect(text.text).toContain('この階は 4 回目: 基礎点と守護者の賞金が減っている（25%）');
    expect(text.text).toContain(`守護者の賞金 +${safe.guardianBounty}`);
    expect(text.guardian_bounty).toBe(safe.guardianBounty);
    // 始めると、置かれた守護者の賞金が減っている
    expect((await act(t.r.port, { type: 'start_expedition', offer: safe.index })).ok).toBe(true);
    const first = w.expeditions!.at(-1)!;
    expect(first.guardianBounty).toBe(safe.guardianBounty);
    const g = Object.values(w.entities).find((e) => e.pos?.floor === 'main:4' && e.role === 'guardian' && !e.guardian?.warden)!;
    expect(g).toBeTruthy();
    expect(g.bounty).toBe(safe.guardianBounty);
    // 戦わずに撤退する → 再挑戦。基礎点と賞金は、置いた遠征のまま（前は満額に戻っていた）
    let points = safe.points;
    for (let k = 0; k < 2; k++) {
      t.clearMonsters();
      await t.toDown();
      const wd = await act(t.r.port, { type: 'extract', confirm: true });
      expect(wd.ok ? '' : JSON.stringify(wd.error)).toBe('');
      expect(t.r.port.view().status).toBe('at_camp');
      const re = w.camp!.offers.find((o) => o.slot === 'safe')!;
      expect(re.rechallenge?.guardian).toBe(g.id);
      expect(re.rechallenge?.inherits).toBe(true);
      expect(re.points).toBe(points);
      expect(re.points).toBeLessThan(base);
      expect(re.guardianBounty).toBe(safe.guardianBounty);
      expect(re.repeatNo).toBeUndefined();
      const rt = t.r.port.observe({ map: false }).observation.camp!.offers.find((o) => o.slot === 'safe')!.text;
      expect(rt).toContain('基礎点と賞金は、その守護者を置いた遠征のまま');
      expect(rt).not.toContain('減点なし');
      expect((await act(t.r.port, { type: 'start_expedition', offer: re.index })).ok).toBe(true);
      expect(w.expeditions!.at(-1)!.points).toBe(points);
      points = re.points;
    }
    // 倒すと、減った賞金が入る
    const gg = structuredClone(w.entities[g.id]);
    const mp = t.me().pos!;
    const f = w.floors[mp.floor];
    const T = (x: number, y: number) => content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
    const near = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dy]) => ({ x: mp.x + dx, y: mp.y + dy })).find((p) => T(p.x, p.y).passable && !T(p.x, p.y).door && !Object.values(w.entities).some((e) => e.pos?.floor === mp.floor && e.pos.x === p.x && e.pos.y === p.y))!;
    gg.pos = { floor: mp.floor, x: near.x, y: near.y };
    gg.stats!.hp = 1;
    inject(w, { put: [gg] });
    t.edit((e) => { e.stats!.hp = 999; e.stats!.maxHp = 999; e.stats!.acc = 99; });
    // fight で倒す: 止まった文の先頭に、目的の達成（S3b §30.4 の 1）
    let killText = '';
    for (let i = 0; i < 30 && w.entities[g.id]; i++) {
      const x = w.entities[g.id];
      if (!x) break;
      const h = structuredClone(x); h.stats!.hp = 1; h.pos = { floor: mp.floor, x: near.x, y: near.y }; inject(w, { put: [h] });
      t.edit((e) => { e.pos = { floor: mp.floor, x: mp.x, y: mp.y }; e.stats!.hp = 999; });
      const res = await act(t.r.port, { type: 'fight', target: g.id, hpFloor: 0 });
      if (!w.entities[g.id]) killText = res.ok ? res.outcome : '';
    }
    expect(w.entities[g.id]).toBeUndefined();
    expect(killText).toMatch(/^遠征の目的を達成した: /);
    expect(w.expeditions!.at(-1)!.haul?.bounty).toBe(safe.guardianBounty);
    // 綱の確定の文に、目的の分は入らないこと（S3b §30.4 の 2）
    t.clearMonsters();
    await act(t.r.port, { type: 'wait' });
    const ob = t.r.port.observe({ map: false }).observation;
    const objPts = ob.expedition!.haul!.parts.objective;
    expect(objPts).toBe(points);
    expect(ob.valid_actions.find((l) => l.includes('帰還の綱'))).toContain(`（目的の分 ${objPts} 点は入らない）`);
    expect(ob.expedition!.haul!.text).toContain(`（目的の分 ${objPts} 点は入らない）`);
    m.closeAll();
  });

  it('a first slay-guardian offer carries the full bounty; the rules text says repeats cut it and rematches keep it', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'F', seed: 's3b-first', controller: agent });
    if ('error' in r) throw new Error(r.error.message);
    const o = r.session.world.camp!.offers.find((x) => x.objective.type === 'slay_guardian')!;
    expect(o).toBeTruthy();
    expect(o.guardianBounty).toBe(guardianBountyFull(content.balance.haul, o.objective.targetDepth!));
    expect(o.repeatPct).toBeUndefined();
    const { rulesText } = await import('@muse/server');
    const ja = rulesText('all', 'ja', m.catalog);
    expect(ja).toContain('守護者の賞金も同じ割合で減る');
    expect(ja).toContain('再挑戦');
    expect(ja).toContain('その相手を置いた遠征のまま');
    expect(rulesText('all', 'en', m.catalog)).toContain('keeps the base and bounty of the expedition that placed it');
    m.closeAll();
  });
});

describe('S3b §30.3: review fixes', () => {
  it('1: a remembered item shows its affixes only while it lies where you remember it and nobody holds it', async () => {
    const m = manager();
    const t = await soloRun(m, 's3b-remember');
    const w = t.w;
    const key = t.me().pos!.floor;
    const id = 'e_s3brm1';
    const p: Pos = { x: t.me().pos!.x, y: t.me().pos!.y };
    inject(w, { put: [{ id, kind: 'core:short_sword', sid: ++sid, pos: { floor: key, x: p.x, y: p.y }, item: { qty: 1, affixes: ['core:keen'] } } as Entity] });
    w.players[t.pid].knowledge.floors[key].remembered.push({ id, kind: 'core:short_sword', cat: 'item', pos: { ...p }, qty: 1, ft: 0 });
    const rem = () => projectPlayerView(w, t.pid).memory.remembered.find((x) => x.id === id)!;
    expect(rem().affixes).toEqual(['core:keen']);
    // 仲間が拾った（持たれている）・ほかの場所へ動いた: 見ていないので、覚えた名前のまま（接辞を今の World から取らない）
    const held = structuredClone(w.entities[id]); held.item!.heldBy = 'e_other'; delete held.pos; inject(w, { put: [held] });
    expect(rem().affixes).toBeUndefined();
    const moved = structuredClone(w.entities[id]); delete moved.item!.heldBy; moved.pos = { floor: key, x: p.x + 1, y: p.y }; inject(w, { put: [moved] });
    expect(rem().affixes).toBeUndefined();
    m.closeAll();
  });

  it('3: a recovery failure of an unfinalized season run hides its reason (the operator reads the log)', () => {
    const m = manager();
    const failed = (m as unknown as { failed: Map<string, { reason: string; at: number; season?: string }> }).failed;
    failed.set('run_s3bhid', { reason: 'SECRET depth 7 e_abcdef', at: 1, season: 'nope' });
    failed.set('run_s3bopen', { reason: 'Unexpected token', at: 1 });
    const hid = m.recoveryFailedError('run_s3bhid')!;
    expect(hid.code).toBe('recovery_failed');
    expect(hid.message).toContain('復旧に失敗した');
    expect(JSON.stringify(hid)).not.toContain('SECRET');
    expect(m.recoveryFailedError('run_s3bopen')!.message).toContain('Unexpected token');
    m.closeAll();
  });

  it('4: a warden offer counts the hits when the archive knows its HP; a Warded foe gets the ward-fire line', async () => {
    const m = manager();
    const r = await m.createRun({ name: 'W', controller: agent, seed: 's3a-warden' });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const pid = r.playerId;
    w.expeditions = [{ no: 1, objective: { type: 'slay_guardian', targetDepth: 4 }, points: 0, relicGuarded: false, status: 'ended', startSeq: 1, endSeq: 2, endReason: 'completed', participants: [pid], start: {}, targets: { guardian: null, relic: null }, progress: { reached: true, guardianSlain: true, relicHeldBy: null }, extracted: [{ player: pid, completed: true }], result: null } as unknown as Expedition];
    let wo;
    for (let no = 2; no < 12 && !wo; no++) wo = previewOffers(w, content, no).find((o) => o.objective.type === 'slay_warden') ? previewOffers(w, content, no) : undefined;
    expect(wo).toBeTruthy();
    const camp = structuredClone(w.camp!);
    camp.offers = wo!;
    // 護られし者にして、記録庫が体力を返したことにする
    const wi = camp.offers.findIndex((o) => o.objective.type === 'slay_warden');
    camp.offers[wi] = { ...camp.offers[wi], guardian: { ...camp.offers[wi].guardian!, types: ['core:warded'] } };
    applyEvent(w, { type: 'expedition_offered', camp, seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: 'all' } as unknown as GameEvent);
    const line0 = r.port.observe({ map: false }).observation.camp!.offers[wi].text;
    expect(line0).toContain('いまの持ち物で 1 回に通る目安');
    expect(line0).not.toMatch(/回の命中/);
    expect(line0).toContain('護りの火が灯っている間は、装甲がさらに +4');
    w.players[pid].knowledge.wardenIntel = { '5': { hp: 80, maxHit: 12 } };
    const line1 = r.port.observe({ map: false }).observation.camp!.offers[wi].text;
    expect(line1).toMatch(/およそ \d+ 回の命中/);
    m.closeAll();
  });

  it('4: the warden offer armor equals the warden that is then made', async () => {
    const m = manager();
    const t = await soloRun(m, 's3a-warden');
    const w = t.w;
    const pid = t.pid;
    const done = { no: 1, objective: { type: 'slay_guardian', targetDepth: 4 }, points: 0, relicGuarded: false, status: 'ended', startSeq: 1, endSeq: 2, endReason: 'completed', participants: [pid], start: {}, targets: { guardian: null, relic: null }, progress: { reached: true, guardianSlain: true, relicHeldBy: null }, extracted: [{ player: pid, completed: true }], result: null } as unknown as Expedition;
    const offersOf = () => { const keep = w.expeditions!; w.expeditions = [done]; try { for (let no = 2; no < 12; no++) { const o = previewOffers(w, content, no).find((x) => x.objective.type === 'slay_warden'); if (o) return o; } return undefined; } finally { w.expeditions = keep; } };
    const before = offersOf()!;
    expect(before.guardian?.armor).toBeGreaterThanOrEqual(0);
    for (let d = 1; d < 5; d++) expect((await t.descend()).ok).toBe(true);
    const warden = Object.values(w.entities).find((e) => e.guardian?.warden && e.pos?.floor === 'main:5')!;
    expect(warden).toBeTruthy();
    expect(warden.stats!.armor).toBe(before.guardian!.armor);
    // 生きている個体があれば、その個体から（同じ値）
    expect(offersOf()!.guardian!.armor).toBe(warden.stats!.armor);
    m.closeAll();
  });
});

// ---- シーズンのランの指摘（§30.3 の 2・5） ----
function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S3b試し', seed: 's3-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
async function seasonRun(m: SessionManager, name: string) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: SID, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof seasonRun>>;
let nid = 0;
function give(r: Run, kind: string, qty = 1): string {
  const w = r.session.world;
  const me = structuredClone(meOf(w, r.playerId));
  const used = new Set(me.inv!.items.map((id) => w.entities[id]?.item?.slot));
  const slot = 'abcdefghijklmnopqrstuvwxyz'.split('').find((c) => !used.has(c))!;
  const id = `e_s3b${(nid++).toString(36).padStart(4, '0')}`;
  me.inv!.items.push(id);
  inject(w, { put: [{ id, kind, sid: 980000 + nid, item: { qty, affixes: [], heldBy: me.id, slot } } as Entity, me] });
  return slot;
}
async function placeAt(r: Run, p: Pos): Promise<void> {
  const w = r.session.world;
  const e = structuredClone(meOf(w, r.playerId));
  e.pos = { floor: e.pos!.floor, x: p.x, y: p.y };
  inject(w, { put: [e] });
  inject(w, { del: Object.values(w.entities).filter((x) => x.actor && !x.player).map((x) => x.id) });
  expect((await act(r.port, { type: 'wait' })).ok).toBe(true);
}
async function startAndClear(r: Run): Promise<void> {
  const s = await act(r.port, { type: 'start_expedition', offer: 1 });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  inject(r.session.world, { del: Object.values(r.session.world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r.port, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
  await new Promise((res) => setTimeout(res, 5));
}

describe('S3b §30.3: season caches and tokens', () => {
  it('2: with a full pack, a kind you have not identified needs a free slot even if it would stack (no free test of your own items)', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const c = await seasonRun(m, 'Cid');
    await startAndClear(a);
    const wa = a.session.world;
    const down = wa.floors[meOf(wa, a.playerId).pos!.floor].stairs.down[0];
    await placeAt(a, down);
    applyEvent(wa, { type: 'item_identified', player: a.playerId, kind: 'core:scroll_mapping', appearanceId: wa.secret.appearances['core:scroll_mapping'], seq: wa.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [a.playerId] } as unknown as GameEvent);
    expect((await act(a.port, { type: 'deposit_supply', slot: give(a, 'core:scroll_mapping') })).ok).toBe(true);
    await lifelineHome(a);
    await startAndClear(c);
    await placeAt(c, down);
    const wc = c.session.world;
    // C は同じ種類（未鑑定）を持っていて、持ち物はいっぱい
    give(c, 'core:scroll_mapping');
    const cap = meOf(wc, c.playerId).inv!.capacity;
    // 帰還の綱は数に入らない
    const counted = () => meOf(wc, c.playerId).inv!.items.filter((id) => !content.items[wc.entities[id]?.kind ?? '']?.bound).length;
    while (counted() < cap) give(c, 'core:dagger');
    const item = c.port.view().season!.cache!.find((x) => x.kind === 'core:scroll_mapping')!;
    const r1 = await act(c.port, { type: 'take_supply', id: item.id });
    expect(!r1.ok && r1.error.code).toBe('inventory_full');
    // 鑑定していれば、重なるので取れる
    applyEvent(wc, { type: 'item_identified', player: c.playerId, kind: 'core:scroll_mapping', appearanceId: wc.secret.appearances['core:scroll_mapping'], seq: wc.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [c.playerId] } as unknown as GameEvent);
    expect((await act(c.port, { type: 'take_supply', id: item.id })).ok).toBe(true);
    m.closeAll();
  });

  it('5: a run of an unfinalized season known only from its records (after a restart) is listed by name only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s3b-'));
    try {
      const m = new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100 }));
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      await startAndClear(a);
      await lifelineHome(a);
      await act(a.port, { type: 'retire' });
      const runId = a.session.runId;
      m.closeAll();
      // 起動し直したサーバー: 終わったランは記録だけ（動いているセッションに無い）
      const m2 = new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 100 }));
      m2.recoverAll();
      expect(m2.get(runId)).toBeUndefined();
      const row = m2.listRuns().find((x) => x.runId === runId)!;
      expect(row.live).toBe(false);
      expect(row.season).toBe(SID);
      expect(row.summary).toBeUndefined();
      expect(row.expeditions).toBeUndefined();
      expect(row.seq).toBe(0);
      expect(row.players[0].hidden).toBe(true);
      expect(row.players[0].name).toBe('Aya');
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('5: a take outside an expedition is refused', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await startAndClear(a);
    const w = a.session.world;
    const down = w.floors[meOf(w, a.playerId).pos!.floor].stairs.down[0];
    await placeAt(a, down);
    expect((await act(a.port, { type: 'deposit_supply', slot: give(a, 'core:javelin') })).ok).toBe(true);
    // 遠征が終わった形（盤面にいるまま）にする
    w.expeditions!.at(-1)!.status = 'ended';
    const r = await act(a.port, { type: 'take_supply' });
    expect(!r.ok && r.error.code).toBe('cannot_use');
    expect(!r.ok && r.error.message).toContain('遠征の外では');
    m.closeAll();
  });

  it('5: join_run and resume_run tokens never reach the activity log or a spectator (English too)', async () => {
    const m = manager();
    const pair = () => InMemoryTransport.createLinkedPair();
    const [x1, y1] = pair();
    const s1 = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await s1.connect(x1);
    const c1 = new Client({ name: 's3b-1', version: '0' });
    await c1.connect(y1);
    const nr = (await c1.callTool({ name: 'new_run', arguments: { character_name: 'Host', objective: 'auto', mode: 'coop', locale: 'en' } })) as unknown as { structuredContent: { run_id: string; player_token: string } };
    const { run_id, player_token } = nr.structuredContent;
    await c1.callTool({ name: 'resume_run', arguments: { player_token } });
    const [x2, y2] = pair();
    const s2 = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await s2.connect(x2);
    const c2 = new Client({ name: 's3b-2', version: '0' });
    await c2.connect(y2);
    const jr = (await c2.callTool({ name: 'join_run', arguments: { run_id, character_name: 'Guest', locale: 'en' } })) as unknown as { structuredContent: { player_token?: string; profile_token?: string } };
    const tokens = [player_token, jr.structuredContent.player_token, jr.structuredContent.profile_token].filter((s): s is string => !!s && s.length >= 8);
    expect(tokens.length).toBeGreaterThanOrEqual(2);
    const acts = m.get(run_id)!.agentActivity;
    expect(acts.some((a) => a.tool === 'join_run')).toBe(true);
    expect(acts.some((a) => a.tool === 'resume_run')).toBe(true);
    for (const a of acts) {
      for (const tk of tokens) { expect(a.text).not.toContain(tk); expect(JSON.stringify(a.args)).not.toContain(tk); }
      expect(a.text).not.toMatch(/(player|profile)_token\s*:/);
    }
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const port = (app.server.address() as AddressInfo).port;
    try {
      const msgs = await new Promise<ServerMsg[]>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        const got: ServerMsg[] = [];
        const done = () => { clearTimeout(timer); try { ws.close(); } catch { /* 閉じている */ } resolve(got); };
        const timer = setTimeout(done, 1500);
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', role: 'spectator', runId: run_id, mode: 'director' })));
        ws.on('message', (raw) => { got.push(JSON.parse(String(raw)) as ServerMsg); if (got.length >= 8) done(); });
        ws.on('error', reject);
      });
      expect(msgs.some((x) => x.t === 'agent')).toBe(true);
      for (const tk of tokens) expect(JSON.stringify(msgs)).not.toContain(tk);
    } finally {
      await app.close();
      await c1.close();
      await c2.close();
    }
  });
});

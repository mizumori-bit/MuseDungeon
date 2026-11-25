// S9c（S9 の検査の指摘の直し）のテスト: MCP から希望の理由が届く・同時の new_run で続きのあるランが 2 つにならない・
// 続きを遊べないシーズンのランを数えない（canStart と同じ数え方）・希望は中身が同じなら足さない／キャンプからキャンプまで項目ごとに 8 回まで／
// 出来事は希望の分だけ・札の無い World は決めるものを数えて読む
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createMcpServer, loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, ownerWaitOpen, prepStateView, WISH_LIMIT } from '@muse/shared';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { rulesText } from '../../server/src/mcp/rules';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };

function manager(): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
async function campRun(m: SessionManager, seed: string, extra: { profileToken?: string; endPrevious?: boolean } = {}) {
  const r = await m.createRun({ name: 'Sc', seed, controller: agent, ...extra });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof campRun>>;
const act = (port: PlayerPort, cmd: Command, thought?: string) => port.act(cmd, { source: 'bot', ...(thought !== undefined ? { thought } : {}) });
const owner = (r: Run, cmd: Command) => r.session.submit(r.playerId, cmd, { source: 'owner' });
const errCode = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? 'ok' : x.error!.code);
function inject(w: World, p: { put?: Entity[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
function offerPerks(w: World, pid: string, n = 3): string[] {
  const opts = Object.entries(catalog.perks).filter(([id, p]) => p.lineage === 'common' && !p.requires.length && !meOf(w, pid).build?.perks.includes(id)).slice(0, n).map(([id]) => id);
  const e = structuredClone(meOf(w, pid));
  e.build = { ...e.build!, pending: [{ level: 2, options: opts }] };
  inject(w, { put: [e] });
  return opts;
}
function offerBoons(w: World, pid: string): string[] {
  const opts = Object.keys(catalog.boons).slice(0, 2);
  const e = structuredClone(meOf(w, pid));
  e.boonChoice = { options: opts, source: 'warden', depth: 5 };
  inject(w, { put: [e] });
  return opts;
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect(errCode(await act(r.port, { type: 'use', slot: life.slot }))).toBe('ok');
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
const wishesOf = (r: Run) => r.session.world.players[r.playerId].directive?.wishes ?? [];

describe('S9c の 1: wishes from MCP carry the thought as the reason', () => {
  it('choose_perk, choose_boon, equip, unequip and start_expedition over MCP all pass the thought; choose_boon says it becomes a wish', async () => {
    const m = manager();
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 's9c', version: '0' });
    await client.connect(y);
    type R = { structuredContent: { error?: { code: string; details?: { wish?: boolean } }; run_id?: string; player_token?: string; player_id?: string } };
    const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as unknown as R;
    const nr = await call('new_run', { character_name: 'Mc' });
    const { run_id, player_token, player_id } = nr.structuredContent as { run_id: string; player_token: string; player_id: string };
    const s = m.get(run_id)!;
    expect(errCode(await s.submit(player_id, { type: 'set_directive', hold: ['objective', 'loadout', 'perks'] }, { source: 'owner' }))).toBe('ok');
    const perks = offerPerks(s.world, player_id, 2);
    const boons = offerBoons(s.world, player_id);
    const wishes = () => s.world.players[player_id].directive?.wishes ?? [];
    const p = await call('choose_perk', { player_token, option: 2, thought: '特技の理由' });
    expect(p.structuredContent.error?.code).toBe('held_by_owner');
    expect(p.structuredContent.error?.details?.wish).toBe(true);
    expect(wishes().find((w) => w.item === 'perk')).toEqual({ item: 'perk', perk: perks[1], level: 2, reason: '特技の理由' });
    const b = await call('choose_boon', { player_token, option: 1, thought: '加護の理由' });
    expect(b.structuredContent.error?.code).toBe('held_by_owner');
    expect(wishes().find((w) => w.item === 'boon')).toEqual({ item: 'boon', boon: boons[0], depth: 5, reason: '加護の理由' });
    const armor = s.view(player_id).inventory.find((i) => i.equipped === 'armor')!;
    await call('unequip', { player_token, slot: armor.slot, thought: '外す理由' });
    expect(wishes().find((w) => w.item === 'loadout')).toMatchObject({ act: 'unequip', target: armor.id, reason: '外す理由' });
    await call('start_expedition', { player_token, offer: 2, thought: '目的の理由' });
    expect(wishes().find((w) => w.item === 'objective')).toMatchObject({ offer: 2, reason: '目的の理由' });
    // 装備の希望を、着ける希望に替える（品を外してから）
    expect(errCode(await s.submit(player_id, { type: 'unequip', slot: armor.slot }, { source: 'owner' }))).toBe('ok');
    await call('equip', { player_token, slot: armor.slot, thought: '着る理由' });
    expect(wishes().find((w) => w.item === 'loadout')).toMatchObject({ act: 'equip', target: armor.id, reason: '着る理由' });
    // 説明
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'choose_boon')?.description).toContain('希望として持ち主に伝わる');
    expect(tools.find((t) => t.name === 'choose_perk')?.description).toContain('希望として持ち主に伝わる');
    for (const name of ['choose_perk', 'choose_boon']) expect(Object.keys((tools.find((t) => t.name === name)?.inputSchema as { properties: Record<string, unknown> }).properties)).toContain('thought');
    await client.close();
    m.closeAll();
  });
});

describe('S9c の 4: wishes do not grow without bound', () => {
  it('the same content adds nothing and keeps the first reason; up to WISH_LIMIT per item between camps; the event holds only the wish; the count resets at camp', async () => {
    expect(WISH_LIMIT).toBe(8);
    const m = manager();
    const r = await campRun(m, 's9c-wish-1');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    const opts = offerPerks(r.session.world, r.playerId, 2);
    const name = (i: number) => catalog.perks[opts[i]].name.ja;
    const t0 = meOf(r.session.world, r.playerId).actor?.turns;
    expect(errCode(await act(r.port, { type: 'choose_perk', option: 1 }, '最初の理由'))).toBe('held_by_owner');
    // 中身が同じ（理由だけ違う）: 出来事を足さない。理由は最初のもの。応答は「もう伝えてある」
    const seq1 = r.session.world.seq;
    const again = await act(r.port, { type: 'choose_perk', option: opts[0] }, '別の理由');
    expect(errCode(again)).toBe('held_by_owner');
    if (!again.ok) expect(again.error.message).toBe(`その希望（${name(0)}）は、もう持ち主に伝えてある（持ち主が決めるのは、キャンプで）。`);
    expect(r.session.world.seq).toBe(seq1);
    expect(wishesOf(r)).toEqual([{ item: 'perk', perk: opts[0], level: 2, reason: '最初の理由' }]);
    // 出来事は、希望の分だけ（指図の全部を持たない）
    const ev = r.session.history.filter((e) => e.type === 'directive_wish').at(-1) as unknown as Record<string, unknown>;
    expect(ev.directiveAfter).toBeUndefined();
    expect(ev.wish).toEqual({ item: 'perk', perk: opts[0], level: 2, reason: '最初の理由' });
    expect(ev.countAfter).toBe(1);
    // 中身を替えて覚え直す: 8 回まで（最初の 1 回を含む）
    for (let i = 2; i <= WISH_LIMIT; i++) expect(errCode(await act(r.port, { type: 'choose_perk', option: i % 2 === 0 ? 2 : 1 }))).toBe('held_by_owner');
    expect(r.session.world.players[r.playerId].directive?.wishCount).toEqual({ perk: WISH_LIMIT });
    const current = wishesOf(r)[0];
    const seq8 = r.session.world.seq;
    const over = await act(r.port, { type: 'choose_perk', option: current.item === 'perk' && current.perk === opts[0] ? 2 : 1 });
    expect(errCode(over)).toBe('held_by_owner');
    if (!over.ok) expect(over.error.message).toBe(`希望は、もう伝えてある（次のキャンプまで、これ以上は変えられない。今の希望: ${catalog.perks[(current as { perk: string }).perk].name.ja}）。`);
    expect(r.session.world.seq).toBe(seq8);
    expect(wishesOf(r)[0]).toEqual(current);
    // 項目ごと: 加護は別に数える
    offerBoons(r.session.world, r.playerId);
    const seqB = r.session.world.seq;
    expect(errCode(await act(r.port, { type: 'choose_boon', option: 1 }))).toBe('held_by_owner');
    expect(r.session.world.seq).toBeGreaterThan(seqB);
    expect(meOf(r.session.world, r.playerId).actor?.turns).toBe(t0);
    // キャンプに着くと数え直す
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    await lifelineHome(r);
    expect(r.session.world.players[r.playerId].directive?.wishCount).toBeUndefined();
    const seqC = r.session.world.seq;
    const cur2 = wishesOf(r).find((w) => w.item === 'perk') as { perk: string };
    expect(errCode(await act(r.port, { type: 'choose_perk', option: cur2.perk === opts[0] ? 2 : 1 }))).toBe('held_by_owner');
    expect(r.session.world.seq).toBeGreaterThan(seqC);
    expect(r.session.world.players[r.playerId].directive?.wishCount).toEqual({ perk: 1 });
    // 規則の文
    expect(rulesText('directive', 'ja', catalog)).toContain(`項目ごとに ${WISH_LIMIT} 回まで覚え直せる`);
    expect(rulesText('directive', 'en', catalog)).toContain(`up to ${WISH_LIMIT} times`);
    m.closeAll();
  });
});

describe('S9c の 5: a World with no card reads the card by counting what is left to decide', () => {
  it('no card: nothing to decide is ready (engine gate, wait and observation agree); an offer or the objective makes it "not ready"; gear without a baseline is not counted', async () => {
    const m = manager();
    const r = await campRun(m, 's9c-nocard-1');
    const w = r.session.world;
    const drop = () => { delete w.players[r.playerId].directive!.prep; };
    // 特技と加護だけ・候補なし → 準備完了と読む
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['perks', 'loadout'] }))).toBe('ok');
    drop();
    // 持っていた品を外しても（札が無いので、新しいかどうかの覚えが無い）数えない
    const e = structuredClone(meOf(w, r.playerId));
    const gid = 'e_s9cg01';
    inject(w, { put: [{ id: gid, kind: 'core:dagger', sid: 9997, item: { qty: 1, affixes: [], heldBy: e.id, slot: 'q', inspected: true } } as Entity, { ...e, inv: { ...e.inv!, items: [...e.inv!.items, gid] } }] });
    expect(prepStateView(r.port.view())).toBe('ready');
    expect(ownerWaitOpen(r.port.view())).toBe(false);
    let o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.state).toBe('ready');
    expect(o.observation.self.directive?.undecided).toBeUndefined();
    expect(o.turn.awaiting).toBe('camp_choice');
    // 候補が出ている → 「まだ」と読む（engine の門も、観測も）
    offerPerks(w, r.playerId, 2);
    expect(prepStateView(r.port.view())).toBe('pending');
    expect(ownerWaitOpen(r.port.view())).toBe(true);
    o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text.startsWith('持ち主の支度: まだ（決めていないもの: 特技（Lv2 の候補 2 つ））')).toBe(true);
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('held_by_owner');
    // 候補を消す（持ち主が選んだ扱いでなく、記録の外で）と、また準備完了: AI は出発できる
    const e2 = structuredClone(meOf(w, r.playerId));
    e2.build = { ...e2.build!, pending: [] };
    inject(w, { put: [e2] });
    expect(prepStateView(r.port.view())).toBe('ready');
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    // 目的を握っていて札が無い → 「まだ」（目的は持ち主が選ぶもの）
    const r2 = await campRun(m, 's9c-nocard-2');
    expect(errCode(await owner(r2, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    delete r2.session.world.players[r2.playerId].directive!.prep;
    expect(prepStateView(r2.port.view())).toBe('pending');
    expect(errCode(await act(r2.port, { type: 'start_expedition', offer: 1 }))).toBe('held_by_owner');
    // 持ち主が目的を選んで準備完了にすれば（札ができる）、出発できる
    expect(errCode(await owner(r2, { type: 'prepare', objective: 1, ready: true }))).toBe('ok');
    expect(errCode(await act(r2.port, { type: 'start_expedition', offer: 2 }))).toBe('ok');
    m.closeAll();
  });
});

describe('S9c の 2: concurrent new_run for one profile', () => {
  it('two at once make one run (the other is refused); with end_previous both go through in turn and one run is left; a failure lets the next through', async () => {
    const m = manager();
    const a = await campRun(m, 's9c-con-0');
    const tok = a.profile.token!;
    expect(errCode(await act(a.port, { type: 'retire' }))).toBe('ok');
    const [x, y] = await Promise.all([
      m.createRun({ name: 'Sc', seed: 's9c-con-1', controller: agent, profileToken: tok }),
      m.createRun({ name: 'Sc', seed: 's9c-con-2', controller: agent, profileToken: tok }),
    ]);
    const codes = [x, y].map((r) => ('error' in r ? r.error.code : 'ok')).sort();
    expect(codes).toEqual(['ok', 'run_in_progress']);
    expect(m.liveRunsOf(a.profile.id)).toHaveLength(1);
    const [p, q] = await Promise.all([
      m.createRun({ name: 'Sc', seed: 's9c-con-3', controller: agent, profileToken: tok, endPrevious: true }),
      m.createRun({ name: 'Sc', seed: 's9c-con-4', controller: agent, profileToken: tok, endPrevious: true }),
    ]);
    expect('error' in p || 'error' in q).toBe(false);
    expect(m.liveRunsOf(a.profile.id)).toHaveLength(1);
    // 失敗（知らない職業で断られる）の後も、次が流れる
    const [bad, good] = await Promise.all([
      m.createRun({ name: 'Sc', seed: 's9c-con-5', controller: agent, profileToken: tok, endPrevious: true, classId: 'core:nobody' }),
      m.createRun({ name: 'Sc', seed: 's9c-con-6', controller: agent, profileToken: tok, endPrevious: true }),
    ]);
    expect('error' in bad && bad.error.code).toBe('bad_request');
    expect('error' in good).toBe(false);
    expect(m.liveRunsOf(a.profile.id)).toHaveLength(1);
    // 待ち行列は、例外で終わっても次を流す
    const byProfile = (m as unknown as { byProfile<T>(id: string, fn: () => Promise<T>): Promise<T> }).byProfile.bind(m);
    const r1 = byProfile('prof_x', async () => { throw new Error('boom'); });
    const r2 = byProfile('prof_x', async () => 'next');
    await expect(r1).rejects.toThrow('boom');
    await expect(r2).resolves.toBe('next');
    // シーズンのランも、同時に 2 つ来ても 1 つ
    m.seasons.store.open({ id: 's9cs', name: 'S9c試し', seed: 's9c-season', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite('s9cs', 'カノ', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const [s1, s2] = await Promise.all([
      m.createRun({ name: 'カノ', controller: agent, season: 's9cs', profileToken: inv.token! }),
      m.createRun({ name: 'カノ', controller: agent, season: 's9cs', profileToken: inv.token! }),
    ]);
    expect([s1, s2].map((r) => ('error' in r ? r.error.code : 'ok')).sort()).toEqual(['ok', 'run_in_progress']);
    expect(m.seasons.standings('s9cs')!.standings[0].runs).toBe(1);
    m.closeAll();
  });
});

describe('S9c の 3: season runs that cannot go on are not counted (one rule for new_run and canStart)', () => {
  it('a camp in a season past its end or with the budget used up does not count; a run still inside does; canStart counts the same', async () => {
    const m = manager();
    m.seasons.store.open({ id: 's9ce', name: 'S9c終', seed: 's9c-season-e', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite('s9ce', 'トワ', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const tok = inv.token!;
    const s = await m.createRun({ name: 'トワ', controller: agent, season: 's9ce', profileToken: tok });
    if ('error' in s) throw new Error(s.error.message);
    const pid = s.playerId;
    expect(m.continuable(s.session, pid)).toBe(true);
    // 迷宮の中: 終わりの時刻を過ぎても、帰るか倒れるまで続けられるので数える
    expect(errCode(await act(s.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    m.seasons.get('s9ce')!.def.endsAt = Date.now() - 1000;
    expect(m.continuable(s.session, pid)).toBe(true);
    const n0 = await m.createRun({ name: 'トワ', seed: 's9c-e-n0', controller: agent, profileToken: tok });
    expect('error' in n0 && n0.error.code).toBe('run_in_progress');
    // キャンプに戻った: 新しい遠征は始められないので、数えない（end_previous なしで、シーズンでないランを始められる。シーズンのランは終わらせない）
    const life = s.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
    expect(errCode(await act(s.port, { type: 'use', slot: life.slot }))).toBe('ok');
    for (let i = 0; i < 20 && s.port.view().status !== 'at_camp'; i++) await act(s.port, { type: 'wait' });
    expect(s.port.view().status).toBe('at_camp');
    expect(m.continuable(s.session, pid)).toBe(false);
    const n1 = await m.createRun({ name: 'トワ', seed: 's9c-e-n1', controller: agent, profileToken: tok });
    expect('error' in n1).toBe(false);
    expect(s.session.world.status).toBe('active');
    // 予算を使い切った参加者のキャンプも数えない（参加者の記録の手番を書き換える。記録の外）
    m.seasons.store.open({ id: 's9cb', name: 'S9c予', seed: 's9c-season-b', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 300, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv2 = m.seasons.invite('s9cb', 'ユラ', m.profiles.store);
    if ('error' in inv2) throw new Error(inv2.error);
    const b = await m.createRun({ name: 'ユラ', controller: agent, season: 's9cb', profileToken: inv2.token! });
    if ('error' in b) throw new Error(b.error.message);
    expect(m.continuable(b.session, b.playerId)).toBe(true);
    // canStart も同じ数え方: キャンプにいて続けられるランがあれば、進行中（end_previous で通る）
    const cs = m.seasons.canStart('s9cb', b.session.profileOf(b.playerId));
    expect('reason' in cs && cs.inProgress).toBe(b.session.runId);
    m.seasons.get('s9cb')!.participants[0].runs[0].turns = 300;
    expect(m.continuable(b.session, b.playerId)).toBe(false);
    expect(m.liveRunsOf(b.session.profileOf(b.playerId)!)).toEqual([]);
    const n2 = await m.createRun({ name: 'ユラ', seed: 's9c-b-n2', controller: agent, profileToken: inv2.token! });
    expect('error' in n2).toBe(false);
    expect(b.session.world.status).toBe('active');
    m.closeAll();
  });
});

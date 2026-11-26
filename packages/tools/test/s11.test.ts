// S11（配下のプレイヤーの「支度と準備完了・希望」の試しを受けた、応答の文の直し。版・World・出来事・命令の形・内容のデータは変えない）のテスト:
// 1 準備完了の後の start_expedition は引数なしで通る（MCP）・2 待っている AI に持ち主の様子（時刻を差し替えて 3 つの文）・
// 3 持ち主の決定が「変化」に出て、希望と並ぶ・4 前のキャンプと同じ伝言・6 札の行の希望の出し方・版の 3 つの値
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, createMcpServer, loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, EVENT_VERSION, nameOf, objectiveText, ownerPresenceText, withoutOwnerPresence } from '@muse/shared';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { ownerView } from '../../server/src/session/OwnerPort';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };

function manager(): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
async function campRun(m: SessionManager, seed: string) {
  const r = await m.createRun({ name: 'Su', seed, controller: agent });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof campRun>>;
const act = (port: PlayerPort, cmd: Command, thought?: string) => port.act(cmd, { source: 'bot', ...(thought !== undefined ? { thought } : {}) });
const owner = (r: Run, cmd: Command) => r.session.submit(r.playerId, cmd, { source: 'owner' });
const errCode = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? 'ok' : x.error!.code);
const ownerLines = (r: { turn: { changes: { code: string; text: string }[] } }) => r.turn.changes.filter((c) => c.code === 'owner').map((c) => c.text);
function inject(w: World, p: { put?: Entity[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
/** 特技の候補を足す（記録の外。再生しないテストだけ） */
function offerPerks(r: Run, n = 3): string[] {
  const opts = Object.entries(catalog.perks).filter(([id, p]) => p.lineage === 'common' && !p.requires.length && !meOf(r.session.world, r.playerId).build?.perks.includes(id)).slice(0, n).map(([id]) => id);
  const e = structuredClone(meOf(r.session.world, r.playerId));
  e.build = { ...e.build!, pending: [{ level: 2, options: opts }] };
  inject(r.session.world, { put: [e] });
  return opts;
}
/** 持ち物に装備できる品を 1 つ足す（記録の外。再生しないテストだけ） */
function giveGear(r: Run, kind = 'core:dagger'): { id: string; slot: string } {
  const w = r.session.world;
  const me = structuredClone(meOf(w, r.playerId));
  const used = new Set(me.inv!.items.map((id) => w.entities[id]?.item?.slot));
  let slot = 'a';
  for (let c = 97; c <= 122; c++) { const s = String.fromCharCode(c); if (!used.has(s)) { slot = s; break; } }
  const id = `e_g${String(Object.keys(w.entities).length).padStart(5, '0')}`.slice(0, 8);
  const it: Entity = { id, kind, sid: 9999, item: { qty: 1, affixes: [], heldBy: me.id, slot, inspected: true } };
  me.inv!.items = [...me.inv!.items, id];
  inject(w, { put: [it, me] });
  return { id, slot };
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect(errCode(await act(r.port, { type: 'use', slot: life.slot }))).toBe('ok');
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
const perkName = (id: string) => nameOf(catalog.perks[id]?.name, 'ja', id);
const PRESENCE_TAIL = '。持ち主は人で、決めるのに数分かかることがある。wait_for_turn timeout_s=60 を、くり返してよい';
// main（e601bd1）の start_expedition の引数の断り（offer が要る引数だった版の、args.ts と onBad の文）
const MAIN_LIST = '要る: offer／要らない（任意）: なし／共通: player_token・thought・expect_seq・map・inventory・status_line';
const MAIN_MISSING = `start_expedition には offer が要る（渡されていない）。このツールの引数: ${MAIN_LIST}。`;
const MAIN_OPTION = `start_expedition には offer が要る（渡されていない）。start_expedition に option という名前の引数は無い。このツールの引数: ${MAIN_LIST}。`;
const MAIN_HINT = '例: start_expedition { offer: 1 }（valid_actions の行は、書いてある形のまま呼べる。別の名前は受け付けない。thought・player_token など共通の名前は、どのツールにも付けてよい）';

async function mcpClient(m: SessionManager) {
  const [x, y] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
  await server.connect(x);
  const client = new Client({ name: 's11', version: '0' });
  await client.connect(y);
  return client;
}
type T = { structuredContent: { ok?: boolean; error?: { code: string; message: string; hint: string }; turn: { reason: string; changes: { code: string; text: string }[] }; observation: { valid_actions: string[] } }; content: { text: string }[]; isError?: boolean };

describe('S11 の 1: start_expedition with no arguments after the preparations are ready (MCP)', () => {
  it('objective held: no arguments is the argument refusal (as on main) until ready; starts with the owner\'s choice once ready; the action line and ▶ say "no arguments"', async () => {
    expect(ENGINE_VERSION).toBe('0.49.0');
    expect(EVENT_VERSION).toBe(37);
    const m = manager();
    const client = await mcpClient(m);
    const nr = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Mw' } })) as unknown as { structuredContent: { run_id: string; player_token: string; player_id: string } };
    const { run_id, player_token, player_id } = nr.structuredContent;
    const s = m.get(run_id)!;
    // 目的を握られていない: main（e601bd1）と 1 字も違わない引数の断り（引数なし・名前違い）
    const n0 = (await client.callTool({ name: 'start_expedition', arguments: { player_token } })) as unknown as T;
    expect(n0.structuredContent.error).toEqual({ code: 'bad_request', message: MAIN_MISSING, hint: MAIN_HINT });
    const n0b = (await client.callTool({ name: 'start_expedition', arguments: { player_token, option: 1 } })) as unknown as T;
    expect(n0b.structuredContent.error).toEqual({ code: 'bad_request', message: MAIN_OPTION, hint: MAIN_HINT });
    expect(s.view(player_id).status).toBe('at_camp');
    // 目的を握られていて、まだ準備完了でない: 同じ引数の断り（希望にはならない。手番も出来事も無い）
    expect(errCode(await s.submit(player_id, { type: 'set_directive', hold: ['objective'] }, { source: 'owner' }))).toBe('ok');
    const seq0 = s.world.seq;
    const turns0 = meOf(s.world, player_id).actor?.turns ?? 0;
    const n1 = (await client.callTool({ name: 'start_expedition', arguments: { player_token } })) as unknown as T;
    expect(n1.structuredContent.error).toEqual({ code: 'bad_request', message: MAIN_MISSING, hint: MAIN_HINT });
    expect(s.world.seq).toBe(seq0);
    expect(s.world.players[player_id].directive?.wishes).toBeUndefined();
    expect(meOf(s.world, player_id).actor?.turns ?? 0).toBe(turns0);
    // 目的を選んだが、まだ準備完了でない: 同じ
    expect(errCode(await s.submit(player_id, { type: 'prepare', objective: 2 }, { source: 'owner' }))).toBe('ok');
    expect(((await client.callTool({ name: 'start_expedition', arguments: { player_token } })) as unknown as T).structuredContent.error?.message).toBe(MAIN_MISSING);
    // 準備完了: 「できること」と ▶ 行は、引数なし
    expect(errCode(await s.submit(player_id, { type: 'prepare', objective: 2, ready: true }, { source: 'owner' }))).toBe('ok');
    const offer2 = s.view(player_id).camp!.offers.find((o) => o.index === 2)!;
    const ob = (await client.callTool({ name: 'observe', arguments: { player_token } })) as unknown as T;
    expect(ob.structuredContent.observation.valid_actions.filter((l) => l.startsWith('start_expedition'))).toEqual([`start_expedition (引数なし。持ち主が選んだ目的で始まる: 候補 2: ${objectiveText('ja', offer2.objective)})`]);
    expect(ob.content[0].text).toContain('start_expedition（引数なし）で出発する（持ち主が選んだ目的で始まる）');
    expect(ob.content[0].text.split('\n').at(-1)).toContain('▶ キャンプにいます。持ち主の支度は準備完了。start_expedition（引数なし）で出発する（持ち主が選んだ目的: 候補 2');
    // 準備完了の後は、持ち主の様子を出さない
    expect(ob.content[0].text).not.toContain('支度の画面を開');
    const st = (await client.callTool({ name: 'start_expedition', arguments: { player_token } })) as unknown as T;
    expect(st.isError).toBeFalsy();
    expect(s.view(player_id).expedition?.objective).toEqual(offer2.objective);
    // 引数なしなので、「あなたが指した候補 N ではなく」は出ない
    const own = ownerLines(st.structuredContent);
    expect(own[0]).toBe(`持ち主が決めた目的で始めた: 遠征 1（${objectiveText('ja', offer2.objective)}）`);
    // 記録の命令は、持ち主が選んだ候補（engine の命令の形は変えない）
    const od = [...s.history].reverse().find((e) => e.type === 'owner_decided');
    expect(od).toMatchObject({ act: 'start_expedition', offer: 2, asked: 2 });
    await client.close();
    m.closeAll();
  });

  it('the rules and the tool description say start_expedition needs no arguments once ready', async () => {
    const m = manager();
    const client = await mcpClient(m);
    const tools = (await client.listTools()).tools;
    const se = tools.find((x) => x.name === 'start_expedition')!;
    expect(se.description).toContain('offer: 候補の番号（目的を持ち主が決めていて、支度が準備完了のときだけ、省ける）');
    expect((se.inputSchema as { required?: string[] }).required ?? []).not.toContain('offer');
    const rules = (await client.callTool({ name: 'get_rules', arguments: { topic: 'directive' } })) as unknown as { content: { text: string }[] };
    expect(rules.content[0].text).toContain('準備完了の後は、引数なしの start_expedition で、持ち主が選んだ目的で始まる');
    const en = (await client.callTool({ name: 'get_rules', arguments: { topic: 'directive', locale: 'en' } })) as unknown as { content: { text: string }[] };
    expect(en.content[0].text).toContain('start_expedition with no arguments starts the objective your owner chose');
    await client.close();
    m.closeAll();
  });
});

describe('S11 の 2: telling a waiting AI how its owner is doing', () => {
  it('three sentences by the time since the owner last called (the clock is swapped in)', () => {
    expect(ownerPresenceText('ja', null)).toBe(`持ち主は、まだ、支度の画面を開いていない（このサーバーが起動してから）${PRESENCE_TAIL}`);
    expect(ownerPresenceText('ja', 4_000)).toBe(`持ち主は、今、支度の画面を開いている${PRESENCE_TAIL}`);
    expect(ownerPresenceText('ja', 15_000)).toBe(`持ち主は、今、支度の画面を開いている${PRESENCE_TAIL}`);
    expect(ownerPresenceText('ja', 15_001)).toBe(`持ち主が、最後に支度の画面を開いたのは、1 分前${PRESENCE_TAIL}`);
    expect(ownerPresenceText('ja', 7 * 60_000 + 5_000)).toBe(`持ち主が、最後に支度の画面を開いたのは、7 分前${PRESENCE_TAIL}`);
    expect(ownerPresenceText('ja', 2 * 3_600_000 + 1)).toBe(`持ち主が、最後に支度の画面を開いたのは、2 時間前${PRESENCE_TAIL}`);
    expect(ownerPresenceText('en', null)).toBe('Your owner has not opened the preparations screen yet (since this server started). Your owner is a person and may take a few minutes to decide. You may repeat wait_for_turn timeout_s=60');
    expect(ownerPresenceText('en', 1_000)).toContain('Your owner has the preparations screen open right now. ');
    expect(ownerPresenceText('en', 180_000)).toContain('Your owner last opened the preparations screen 3 min ago. ');
    // 観戦に流す文からは除ける（行ごと・hint の後ろ）
    for (const ms of [null, 4_000, 7 * 60_000, 3 * 3_600_000]) {
      expect(withoutOwnerPresence(`a\n${ownerPresenceText('ja', ms)}\nb`)).toBe('a\nb');
      expect(withoutOwnerPresence(`Hint: 待てる。${ownerPresenceText('ja', ms)}。`)).toBe('Hint: 待てる。');
      expect(withoutOwnerPresence(`Hint: wait. ${ownerPresenceText('en', ms)}.`)).toBe('Hint: wait.');
    }
    expect(withoutOwnerPresence('a\n\nb')).toBe('a\n\nb');
  });

  it('the line follows the preparations line, only while not ready, only in the player\'s own responses; the owner\'s endpoint marks the time (memory only)', async () => {
    const m = manager();
    const r = await campRun(m, 's11-presence');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    const pid = r.playerId;
    // まだ呼び出しが無い
    let o = r.port.observeWithTurn('observed');
    const lines = o.text.split('\n');
    const iPrep = lines.findIndex((l) => l.startsWith('持ち主の支度: まだ'));
    expect(lines[iPrep + 1]).toBe(`持ち主は、まだ、支度の画面を開いていない（このサーバーが起動してから）${PRESENCE_TAIL}`);
    // 時刻を差し替えて: 今・N 分前
    const t0 = Date.now();
    r.session.noteOwnerCall(pid, t0 - 5_000);
    expect(r.port.ownerPresence(r.port.view(), t0)).toBe(`持ち主は、今、支度の画面を開いている${PRESENCE_TAIL}`);
    expect(r.port.ownerPresence(r.port.view(), t0 + 4 * 60_000)).toBe(`持ち主が、最後に支度の画面を開いたのは、4 分前${PRESENCE_TAIL}`);
    o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.owner_presence).toBe(`持ち主は、今、支度の画面を開いている${PRESENCE_TAIL}`);
    // held_by_owner の断りの hint にも
    const refused = await act(r.port, { type: 'start_expedition', offer: 1 });
    expect(errCode(refused)).toBe('held_by_owner');
    if (!refused.ok) expect(refused.error.hint).toContain(`持ち主は、今、支度の画面を開いている${PRESENCE_TAIL}`);
    // 持ち主の画面の写し（観測だけを作る）には出さない
    expect(ownerView(r.session, pid).text).not.toContain('支度の画面を開');
    // World にも、記録にも入らない
    expect(JSON.stringify(r.session.world)).not.toContain('支度の画面');
    expect(r.session.history.some((e) => JSON.stringify(e).includes('支度の画面'))).toBe(false);
    // 準備完了になったら、出さない
    expect(errCode(await owner(r, { type: 'prepare', objective: 1, ready: true }))).toBe('ok');
    o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.owner_presence).toBeUndefined();
    expect(o.text).not.toContain('支度の画面を開');
    m.closeAll();
  });

  it('HTTP: only an accepted owner call marks the time; wait_for_turn\'s timed-out response carries the line', async () => {
    const m = manager();
    const r = await campRun(m, 's11-http');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const v = `/api/runs/${r.session.runId}/owner/view`;
      // 外から（認められない）: 控えない
      expect((await fetch(base + v, { headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(403);
      expect(r.session.lastOwnerCallAt(r.playerId)).toBeNull();
      // 同じ機械から、印の無い読み込み（拠点・運用の札の自動の読み直し）: 控えない（S11a）
      expect((await fetch(base + v)).status).toBe(200);
      expect(r.session.lastOwnerCallAt(r.playerId)).toBeNull();
      // 支度の画面の読み込み（?at=prepare）: 控える
      const before = Date.now();
      expect((await fetch(base + v + '?at=prepare')).status).toBe(200);
      const t1 = r.session.lastOwnerCallAt(r.playerId)!;
      expect(t1).toBeGreaterThanOrEqual(before);
      // 持ち主の決定（POST）: 控える
      await new Promise((res) => setTimeout(res, 5));
      const pd = await fetch(base + `/api/runs/${r.session.runId}/owner/directive`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hold: ['objective'], message: 'よろしく' }) });
      expect(pd.status).toBe(200);
      expect(r.session.lastOwnerCallAt(r.playerId)!).toBeGreaterThan(t1);
      // AI の wait_for_turn（時間切れ）の応答に
      const client = await mcpClient(m);
      const w = (await client.callTool({ name: 'wait_for_turn', arguments: { player_token: r.token, timeout_s: 1 } })) as unknown as T;
      expect(w.structuredContent.turn.reason).toBe('wait_timeout');
      expect(w.content[0].text).toContain(`持ち主は、今、支度の画面を開いている${PRESENCE_TAIL}`);
      // 観戦に流す「AI の呼び出しの記録」には入らない（本人の応答にだけ）
      const recorded = r.session.agentActivity.filter((x) => x.tool === 'wait_for_turn').at(-1)!;
      expect(recorded.text).toContain('持ち主の支度: まだ');
      expect(recorded.text).not.toContain('支度の画面');
      expect(recorded.text).not.toContain('くり返してよい');
      await client.close();
    } finally {
      await new Promise<void>((res) => app.server.close(() => res()));
      m.closeAll();
    }
  });
});

describe('S11 の 3: the owner\'s decisions show in the changes, with the AI\'s wish', () => {
  it('wait_for_turn returning at "ready" lists what the owner decided; a perk unlike the wish says what was wished; a perk as wished says so', async () => {
    const m = manager();
    const client = await mcpClient(m);
    const r = await campRun(m, 's11-wish-perk');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    const opts = offerPerks(r, 3);
    // キャンプに着いたときの置き直しの代わりに、持ち主が「まだ」に戻す
    expect(errCode(await owner(r, { type: 'prepare', ready: false }))).toBe('ok');
    r.port.observeWithTurn('observed');
    // AI の希望: 2 番目
    const wished = await act(r.port, { type: 'choose_perk', option: 2 }, '群れに耐えたい');
    expect(errCode(wished)).toBe('held_by_owner');
    const pending = client.callTool({ name: 'wait_for_turn', arguments: { player_token: r.token, timeout_s: 20 } }) as unknown as Promise<T>;
    await new Promise((res) => setTimeout(res, 80));
    // 持ち主は 1 番目を選んで、準備完了
    expect(errCode(await owner(r, { type: 'choose_perk', option: 1 }))).toBe('ok');
    expect(errCode(await owner(r, { type: 'prepare', ready: true }))).toBe('ok');
    const t1 = await pending;
    const own = t1.structuredContent.turn.changes.filter((c) => c.code === 'owner').map((c) => c.text);
    expect(own).toContain(`持ち主が、特技を選んだ: ${perkName(opts[0])}（あなたの希望は、${perkName(opts[1])}）`);
    expect(own.some((x) => x.startsWith('持ち主の支度が、準備完了になった'))).toBe(true);
    // 希望どおり
    const b = await campRun(m, 's11-wish-perk-2');
    expect(errCode(await owner(b, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    const opts2 = offerPerks(b, 3);
    b.port.observeWithTurn('observed');
    expect(errCode(await act(b.port, { type: 'choose_perk', option: 3 }))).toBe('held_by_owner');
    expect(errCode(await owner(b, { type: 'choose_perk', option: 3 }))).toBe('ok');
    expect(ownerLines(b.port.observeWithTurn('observed'))).toContain(`持ち主が、特技を選んだ: ${perkName(opts2[2])}（あなたの希望どおり）`);
    // 希望が無ければ、添えない
    const c = await campRun(m, 's11-wish-perk-3');
    expect(errCode(await owner(c, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    const opts3 = offerPerks(c, 3);
    c.port.observeWithTurn('observed');
    expect(errCode(await owner(c, { type: 'choose_perk', option: 1 }))).toBe('ok');
    expect(ownerLines(c.port.observeWithTurn('observed'))).toContain(`持ち主が、特技を選んだ: ${perkName(opts3[0])}`);
    // 決めた後の、次のキャンプの新しい決定には、前の希望を添えない（S11a の 9: 実際に、次のキャンプで別の決定をして）
    expect(errCode(await owner(b, { type: 'prepare', ready: true }))).toBe('ok');
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    const opts4 = offerPerks(b, 3);
    await lifelineHome(b);
    expect(b.port.observeWithTurn('observed').observation.self.directive?.prep?.state).toBe('pending');
    expect(errCode(await owner(b, { type: 'choose_perk', option: 2 }))).toBe('ok');
    expect(ownerLines(b.port.observeWithTurn('observed'))).toEqual([`持ち主が、特技を選んだ: ${perkName(opts4[1])}`]);
    await client.close();
    m.closeAll();
  });

  it('equipment: the gear summary says whether it was as wished; the objective: the start line says what was wished', async () => {
    const m = manager();
    const a = await campRun(m, 's11-wish-gear');
    expect(errCode(await owner(a, { type: 'set_directive', hold: ['loadout'] }))).toBe('ok');
    const g = giveGear(a);
    a.port.observeWithTurn('observed');
    expect(errCode(await act(a.port, { type: 'equip', slot: g.slot }))).toBe('held_by_owner');
    expect(errCode(await owner(a, { type: 'equip', slot: g.slot }))).toBe('ok');
    const gear = ownerLines(a.port.observeWithTurn('observed'));
    expect(gear.find((x) => x.startsWith('持ち主が、装備を決めた。'))).toMatch(/（あなたの希望どおり）$/);
    // 希望と違う品: 何を希望していたか
    const b = await campRun(m, 's11-wish-gear-2');
    expect(errCode(await owner(b, { type: 'set_directive', hold: ['loadout'] }))).toBe('ok');
    const g1 = giveGear(b, 'core:dagger');
    b.port.observeWithTurn('observed');
    expect(errCode(await act(b.port, { type: 'equip', slot: g1.slot }))).toBe('held_by_owner');
    const armor = b.port.view().inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await owner(b, { type: 'unequip', slot: armor.slot }))).toBe('ok');
    const gear2 = ownerLines(b.port.observeWithTurn('observed'));
    expect(gear2.find((x) => x.startsWith('持ち主が、装備を決めた。'))).toMatch(/（あなたの希望は、.+を装備する）$/);
    // 目的
    const c = await campRun(m, 's11-wish-obj');
    expect(errCode(await owner(c, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    c.port.observeWithTurn('observed');
    expect(errCode(await act(c.port, { type: 'start_expedition', offer: 1 }))).toBe('held_by_owner');
    expect(errCode(await owner(c, { type: 'prepare', objective: 1, ready: true }))).toBe('ok');
    const offer1 = c.port.view().camp!.offers.find((o) => o.index === 1)!;
    const st = await act(c.port, { type: 'start_expedition', offer: 1 });
    expect(errCode(st)).toBe('ok');
    if (st.ok) expect(ownerLines(st)[0]).toBe(`持ち主が決めた目的で始めた: 遠征 1（${objectiveText('ja', offer1.objective)}）（あなたの希望どおり）`);
    m.closeAll();
  });
});

describe('S11 の 4: a message unchanged since the last camp', () => {
  it('"(same message as at the last camp)" at the next camp; "(new)" once rewritten; nothing at the first camp', async () => {
    const m = manager();
    const r = await campRun(m, 's11-msg');
    expect(errCode(await owner(r, { type: 'set_directive', hold: [], message: '深追いはしない' }))).toBe('ok');
    r.port.observeWithTurn('observed');
    // 最初のキャンプ: 前のキャンプが無いので、添えない
    let o = r.port.observeWithTurn('observed');
    expect(o.text).toContain('持ち主から: 深追いはしない');
    expect(o.observation.self.directive?.message_kept).toBeUndefined();
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    await lifelineHome(r);
    // 次のキャンプ: 同じ伝言
    o = r.port.observeWithTurn('observed');
    expect(o.text).toContain('持ち主から（前のキャンプと同じ伝言）: 深追いはしない');
    expect(o.observation.self.directive?.message_kept).toBe(true);
    // 書き換えた: 新しい（1 回）。その後は、ただの「持ち主から」（このキャンプで書かれたので、前のキャンプと同じではない）
    expect(errCode(await owner(r, { type: 'set_directive', hold: [], message: '薬を惜しまない' }))).toBe('ok');
    o = r.port.observeWithTurn('observed');
    expect(o.text).toContain('持ち主から（新しい）: 薬を惜しまない');
    o = r.port.observeWithTurn('observed');
    expect(o.text).toContain('持ち主から: 薬を惜しまない');
    expect(o.text).not.toContain('前のキャンプと同じ伝言');
    m.closeAll();
  });
});

describe('S11 の 6: one way to wish, on the not-ready line', () => {
  it('lists the commands of the held items only (perk and boon only with offers; equip only with gear to wear); the directive line drops its own wish clause meanwhile; English too', async () => {
    const m = manager();
    const r = await campRun(m, 's11-howto');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'perks'] }))).toBe('ok');
    let o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text).toMatch(/。決めてほしいものがあれば、その命令を出す（断られるが、希望として持ち主に届く）: start_expedition offer=N$/);
    offerPerks(r, 3);
    o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text).toMatch(/: start_expedition offer=N・choose_perk option=N$/);
    expect(o.observation.self.directive?.text).not.toContain('希望として持ち主に伝わる');
    // 準備完了: 札の行に出し方は無く、指図の行に戻る
    expect(errCode(await owner(r, { type: 'prepare', objective: 1, ready: true }))).toBe('ok');
    o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text).not.toContain('決めてほしいもの');
    expect(o.observation.self.directive?.text).toContain('あなたが choose_perk・choose_boon を出すと、希望として持ち主に伝わる');
    // 英語
    const e = await m.createRun({ name: 'En', seed: 's11-howto-en', controller: agent, locale: 'en' });
    if ('error' in e) throw new Error(e.error.message);
    expect(errCode(await e.session.submit(e.playerId, { type: 'set_directive', hold: ['loadout', 'objective'] }, { source: 'owner' }))).toBe('ok');
    const oe = e.port.observeWithTurn('observed');
    expect(oe.observation.self.directive?.prep?.text).toMatch(/\. If you want something decided, send that command \(it is refused, but reaches your owner as a wish\): start_expedition offer=N, unequip slot=x$/);
    expect(oe.text).toContain('Your owner has not opened the preparations screen yet (since this server started).');
    m.closeAll();
  });
});

describe('S11: the versions stay', () => {
  it('engine, event and content are unchanged', () => {
    expect(ENGINE_VERSION).toBe('0.49.0');
    expect(EVENT_VERSION).toBe(37);
    expect(content.version).toBe('cff6932f0071');
  });
});

describe('S11a: the inspection fixes', () => {
  it('3: a wish dropped by releasing the objective is not added to the decision after holding it again', async () => {
    const m = manager();
    const r = await campRun(m, 's11a-rehold');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    r.port.observeWithTurn('observed');
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 3 }))).toBe('held_by_owner');
    expect(r.session.world.players[r.playerId].directive?.wishes?.length).toBe(1);
    expect(errCode(await owner(r, { type: 'set_directive', hold: [] }))).toBe('ok');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    // 握り直した後に伝言だけを変えても、止まるのは握るのをやめた所
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'], message: 'よろしく' }))).toBe('ok');
    expect(errCode(await owner(r, { type: 'prepare', objective: 2, ready: true }))).toBe('ok');
    const offer2 = r.port.view().camp!.offers.find((o) => o.index === 2)!;
    const st = await act(r.port, { type: 'start_expedition', offer: 2 });
    expect(errCode(st)).toBe('ok');
    if (st.ok) expect(ownerLines(st)[0]).toBe(`持ち主が決めた目的で始めた: 遠征 1（${objectiveText('ja', offer2.objective)}）`);
    // 目的を選んだ後に伝言を変えても、その遠征の希望は添える（握るのをやめていない）
    const c = await campRun(m, 's11a-rehold-2');
    expect(errCode(await owner(c, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    c.port.observeWithTurn('observed');
    expect(errCode(await act(c.port, { type: 'start_expedition', offer: 3 }))).toBe('held_by_owner');
    expect(errCode(await owner(c, { type: 'prepare', objective: 2 }))).toBe('ok');
    expect(errCode(await owner(c, { type: 'set_directive', hold: ['objective'], message: '静かに' }))).toBe('ok');
    expect(errCode(await owner(c, { type: 'prepare', ready: true }))).toBe('ok');
    const sc = await act(c.port, { type: 'start_expedition', offer: 2 });
    expect(errCode(sc)).toBe('ok');
    if (sc.ok) expect(ownerLines(sc)[0]).toMatch(/（あなたの希望は、候補 3: [^）]+）$/);
    m.closeAll();
  });

  it('4: a message rewritten at this camp (cleared and set again, or changed and changed back) is not "the same as at the last camp"', async () => {
    const m = manager();
    for (const [seed, steps] of [['s11a-msg-clear', ['', 'A']], ['s11a-msg-back', ['B', 'A']]] as const) {
      const r = await campRun(m, seed);
      expect(errCode(await owner(r, { type: 'set_directive', hold: [], message: 'A' }))).toBe('ok');
      r.port.observeWithTurn('observed');
      expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
      await lifelineHome(r);
      for (const msg of steps) expect(errCode(await owner(r, { type: 'set_directive', hold: [], message: msg }))).toBe('ok');
      const o = r.port.observeWithTurn('observed');
      expect(o.text).toContain('持ち主から: A');
      expect(o.text).not.toContain('前のキャンプと同じ伝言');
      expect(o.observation.self.directive?.message_kept).toBeUndefined();
    }
    m.closeAll();
  });

  it('5: "as you wished" for gear only for the very item wished (another of the same kind says what was wished)', async () => {
    const m = manager();
    const r = await campRun(m, 's11a-gear');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['loadout'] }))).toBe('ok');
    const a = giveGear(r, 'core:dagger');
    const b = giveGear(r, 'core:dagger');
    r.port.observeWithTurn('observed');
    expect(errCode(await act(r.port, { type: 'equip', slot: a.slot }))).toBe('held_by_owner');
    expect(errCode(await owner(r, { type: 'equip', slot: b.slot }))).toBe('ok');
    expect(r.port.view().inventory.find((i) => i.id === b.id)?.equipped).toBe('weapon');
    const line = ownerLines(r.port.observeWithTurn('observed')).find((x) => x.startsWith('持ち主が、装備を決めた。'))!;
    expect(line).not.toContain('希望どおり');
    expect(line).toMatch(/（あなたの希望は、.+を装備する）$/);
    m.closeAll();
  });

  it('6: the not-ready line does not offer a wish that cannot reach the owner (used up for this camp; no gear to wear)', async () => {
    const m = manager();
    const r = await campRun(m, 's11a-howto');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    offerPerks(r, 3);
    expect(errCode(await owner(r, { type: 'prepare', ready: false }))).toBe('ok');
    expect(r.port.observeWithTurn('observed').observation.self.directive?.prep?.text).toMatch(/: choose_perk option=N$/);
    // 覚え直せる回数（8 回）を使い切る
    for (let i = 0; i < 8; i++) expect(errCode(await act(r.port, { type: 'choose_perk', option: (i % 2) + 1 }))).toBe('held_by_owner');
    expect(r.session.world.players[r.playerId].directive?.wishCount?.perk).toBe(8);
    const t = r.port.observeWithTurn('observed').observation.self.directive?.prep?.text ?? '';
    expect(t).toContain('持ち主の支度: まだ');
    expect(t).not.toContain('決めてほしいもの');
    // 装備: 着けられる品が無ければ equip は言わない。持ち帰れば言う
    const g = await campRun(m, 's11a-howto-gear');
    expect(errCode(await owner(g, { type: 'set_directive', hold: ['loadout', 'objective'] }))).toBe('ok');
    expect(g.port.observeWithTurn('observed').observation.self.directive?.prep?.text).toMatch(/: start_expedition offer=N・unequip slot=x$/);
    giveGear(g);
    expect(g.port.observeWithTurn('observed').observation.self.directive?.prep?.text).toMatch(/: start_expedition offer=N・equip slot=x・unequip slot=x$/);
    m.closeAll();
  });

  it('7・8: with no arguments, the queue checks again (refused with no wish and no event if the owner went back to "not ready"; the current choice is used); outside camp, the same refusal as with an offer', async () => {
    const m = manager();
    const r = await campRun(m, 's11a-race');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'] }))).toBe('ok');
    expect(errCode(await owner(r, { type: 'prepare', objective: 2, ready: true }))).toBe('ok');
    expect(r.port.bareStartOk()).toBe(true);
    // 確かめた後、列に入る前に、持ち主が「まだ」に戻した
    expect(errCode(await owner(r, { type: 'prepare', ready: false }))).toBe('ok');
    const seq0 = r.session.world.seq;
    const x = await r.port.act({ type: 'start_expedition', offer: 2 }, { source: 'mcp', bareStart: true });
    expect(errCode(x)).toBe('held_by_owner');
    expect(r.session.world.seq).toBe(seq0);
    expect(r.session.world.players[r.playerId].directive?.wishes).toBeUndefined();
    expect(r.port.view().status).toBe('at_camp');
    // 持ち主が目的を選び直して準備完了: 列の中で、今の選択を入れる（確かめた時の候補ではない）
    expect(errCode(await owner(r, { type: 'prepare', objective: 3, ready: true }))).toBe('ok');
    const y = await r.port.act({ type: 'start_expedition', offer: 2 }, { source: 'mcp', bareStart: true });
    expect(errCode(y)).toBe('ok');
    expect([...r.session.history].reverse().find((e) => e.type === 'owner_decided')).toMatchObject({ offer: 3, asked: 3 });
    // 迷宮の中: offer を渡したときと同じ断り
    const a = await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'mcp' });
    const b = await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'mcp', bareStart: true });
    expect(errCode(a)).not.toBe('ok');
    expect(errCode(b)).toBe(errCode(a));
    if (!a.ok && !b.ok) expect(b.error.message).toBe(a.error.message);
    // 引退した後: 同じ
    expect(errCode(await act(r.port, { type: 'retire' }))).toBe('ok');
    const c = await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'mcp' });
    const d = await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'mcp', bareStart: true });
    expect(errCode(c)).not.toBe('ok');
    expect(errCode(d)).toBe(errCode(c));
    m.closeAll();
  });
});

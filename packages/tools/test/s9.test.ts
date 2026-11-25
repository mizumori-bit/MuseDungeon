// S9（SEASON.md §58.1〜§58.3。§58.7）のテスト: 支度の札（キャンプに着くと「まだ」・決めるものが無ければ最初から準備完了・断りと通り・
// 支度を変えると戻る）・持ち主が選んだ目的で始まる・持ち主の口から直に始められない・希望（覚える・手番なし・見える者・消える）・
// 冒険者 1 人に続きは 1 つ（断り・end_previous・数えないもの・握る項目の引き継ぎ）・再生が記録だけで一致・起動し直した前後で同じ観測
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, createMcpServer, loadConfig, RunSession, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { activeWishes, applyEvent, buildObservation, EVENT_VERSION, narrate, objectiveText, projectPlayerView, wishCommand } from '@muse/shared';
import type { Command, CommandRecord, Entity, GameEvent, OwnerViewResponse, World } from '@muse/shared';
import { ownerRow, ownerView } from '../../server/src/session/OwnerPort';
import { rulesText } from '../../server/src/mcp/rules';
import { verifyRunDir } from '../src/replay';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };

function manager(dir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(dir
    ? { runsDir: join(dir, 'runs'), profilesDir: join(dir, 'profiles'), seasonsDir: join(dir, 'seasons'), waitOthersMs: 100 }
    : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
async function campRun(m: SessionManager, seed: string, extra: { profileToken?: string; endPrevious?: boolean; mode?: 'solo' | 'coop'; objective?: 'auto' } = {}) {
  const r = await m.createRun({ name: 'Su', seed, controller: agent, ...extra });
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
const prepOf = (r: Run) => r.session.world.players[r.playerId].directive?.prep;
const turnsOf = (r: Run) => meOf(r.session.world, r.playerId).actor?.turns ?? 0;
/** 特技の候補を足す（記録の外。再生しないテストだけ） */
function offerPerks(r: Run, n = 3): string[] {
  const opts = Object.entries(catalog.perks).filter(([id, p]) => p.lineage === 'common' && !p.requires.length && !meOf(r.session.world, r.playerId).build?.perks.includes(id)).slice(0, n).map(([id]) => id);
  const e = structuredClone(meOf(r.session.world, r.playerId));
  e.build = { ...e.build!, pending: [{ level: 2, options: opts }] };
  inject(r.session.world, { put: [e] });
  return opts;
}
/** 持ち物に装備できる品を 1 つ足す（記録の外。再生しないテストだけ） */
function giveGear(r: Run, kind = 'core:dagger'): string {
  const w = r.session.world;
  const me = structuredClone(meOf(w, r.playerId));
  const used = new Set(me.inv!.items.map((id) => w.entities[id]?.item?.slot));
  let slot = 'a';
  for (let c = 97; c <= 122; c++) { const s = String.fromCharCode(c); if (!used.has(s)) { slot = s; break; } }
  const id = `e_g${String(Object.keys(w.entities).length).padStart(5, '0')}`.slice(0, 8);
  const it: Entity = { id, kind, sid: 9999, item: { qty: 1, affixes: [], heldBy: me.id, slot, inspected: true } };
  me.inv!.items = [...me.inv!.items, id];
  inject(w, { put: [it, me] });
  return id;
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect(errCode(await act(r.port, { type: 'use', slot: life.slot }))).toBe('ok');
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) out.push(...filesUnder(p)); else out.push(p); }
  return out;
}
const hashes = (dir: string) => Object.fromEntries(filesUnder(dir).filter((p) => !p.endsWith('.server.lock')).map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]));
const S9_TYPES = new Set(['directive_prep', 'directive_wish', 'directive_set', 'owner_decided']);

describe('S9 §58.7: with nothing held, nothing changes', () => {
  it('no card, no wish, no new events through a camp, an expedition and the next camp; start_expedition goes through as before', async () => {
    expect(ENGINE_VERSION).toBe('0.49.0');
    expect(EVENT_VERSION).toBe(37);
    const m = manager();
    const r = await campRun(m, 's9-none-1');
    const o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive).toBeUndefined();
    expect(o.text).not.toContain('持ち主の支度');
    expect(o.turn.awaiting).toBe('camp_choice');
    expect(o.observation.valid_actions.filter((l) => l.startsWith('start_expedition')).length).toBeGreaterThan(1);
    // 握っていないときの choose_perk は、今までどおり nothing_to_do（希望にならない）
    expect(errCode(await act(r.port, { type: 'choose_perk', option: 1 }))).toBe('nothing_to_do');
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    await lifelineHome(r);
    expect(r.session.history.some((e) => S9_TYPES.has(e.type))).toBe(false);
    expect(r.session.world.players[r.playerId].directive).toBeUndefined();
    expect(r.port.observeWithTurn('observed').turn.awaiting).toBe('camp_choice');
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    // 持ち主の口から prepare は、握っていなければ断る（出来事を出さない）
    await lifelineHome(r);
    const seq = r.session.world.seq;
    expect(errCode(await owner(r, { type: 'prepare', ready: true }))).toBe('bad_request');
    expect(r.session.world.seq).toBe(seq);
    m.closeAll();
  });
});

describe('S9 §58.1: the preparations card', () => {
  it('objective held: "not ready" at every camp; ready needs the objective; start is refused while not ready (no turn); the owner\'s choice is used whatever the AI passes; the owner cannot start', async () => {
    const m = manager();
    const r = await campRun(m, 's9-card-obj');
    r.port.observeWithTurn('observed');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'], message: '静かに' }))).toBe('ok');
    expect(prepOf(r)).toEqual({ state: 'pending', seen: expect.any(Array) });
    // 観測の 1 行・「できること」・▶ 行・待ち方
    let o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep).toEqual({ state: 'pending', text: '持ち主の支度: まだ（決めていないもの: 次の遠征の目的）。準備完了になるまで、start_expedition は断られる。待つなら wait_for_turn' });
    const lines = o.text.split('\n');
    expect(lines[lines.findIndex((l) => l.startsWith('指図: ')) + 1]).toBe(o.observation.self.directive!.prep!.text);
    expect(o.observation.valid_actions.some((l) => l.startsWith('start_expedition'))).toBe(false);
    expect(o.observation.valid_actions).toContain('wait_for_turn（待つ: 持ち主の支度が、準備完了になるまで待つ。準備完了になったら、start_expedition で出発する。observe で確かめてもよい。手番は減らない）');
    expect(o.turn.awaiting).toBe('nothing');
    expect(o.turn.owner_wait).toBeDefined();
    expect(o.text.split('\n').at(-1)).toBe('▶ キャンプにいます。持ち主の支度を待つ。準備完了になったら、あなたが start_expedition で出発する（wait_for_turn で待てる。手番は減らない）。');
    // 持ち主の口から直に始められない（S9: 遠征を始めるのはプレイヤー）
    const seq0 = r.session.world.seq;
    const os = await owner(r, { type: 'start_expedition', offer: 1 });
    expect(errCode(os)).toBe('bad_request');
    if (!os.ok) expect(os.error.message).toContain('遠征を始めるのは、プレイヤー。目的を選んで（prepare { objective }）、準備完了を出す（prepare { ready: true }）');
    // 目的を選ばないと準備完了にできない
    expect(errCode(await owner(r, { type: 'prepare', ready: true }))).toBe('objective_unchosen');
    expect(r.session.world.seq).toBe(seq0);
    // 目的を選ぶ（まだ準備完了ではない）→ AI はまだ断られる
    expect(errCode(await owner(r, { type: 'prepare', objective: 2 }))).toBe('ok');
    expect(prepOf(r)).toMatchObject({ state: 'pending', objective: 2 });
    expect(errCode(await owner(r, { type: 'prepare', objective: 2 }))).toBe('nothing_to_do');
    const t0 = turnsOf(r);
    const refused = await act(r.port, { type: 'start_expedition', offer: 3 });
    expect(errCode(refused)).toBe('held_by_owner');
    expect(turnsOf(r)).toBe(t0);
    expect(r.session.world.status).toBe('active');
    // 準備完了
    expect(errCode(await owner(r, { type: 'prepare', ready: true }))).toBe('ok');
    expect(prepOf(r)).toMatchObject({ state: 'ready', objective: 2 });
    o = r.port.observeWithTurn('observed');
    const offer2 = r.port.view().camp!.offers.find((x) => x.index === 2)!;
    expect(o.observation.self.directive?.prep).toEqual({ state: 'ready', objective: 2, text: `持ち主の支度: 準備完了（目的: 候補 2: ${objectiveText('ja', offer2.objective)}）。start_expedition で出発する（offer に何を渡しても、持ち主が選んだ目的で始まる）` });
    expect(ownerLines(o)).toEqual([`持ち主の支度が、準備完了になった（目的: 候補 2: ${objectiveText('ja', offer2.objective)}）。start_expedition で出発する`]);
    const starts = o.observation.valid_actions.filter((l) => l.startsWith('start_expedition'));
    expect(starts).toEqual([`start_expedition 2 (持ち主が選んだ目的: 候補 2: ${objectiveText('ja', offer2.objective)}。offer に何を渡しても、この目的で始まる)`]);
    expect(o.turn.awaiting).toBe('camp_choice');
    expect(o.turn.owner_wait).toBeUndefined();
    expect(o.text.split('\n').at(-1)).toContain('▶ キャンプにいます。持ち主の支度は準備完了。start_expedition で出発する（持ち主が選んだ目的: 候補 2');
    // AI が別の候補を指して始める → 持ち主が選んだ目的で始まる
    const s = await act(r.port, { type: 'start_expedition', offer: 1 });
    expect(errCode(s)).toBe('ok');
    expect(r.port.view().expedition?.objective).toEqual(offer2.objective);
    if (s.ok) {
      const own = ownerLines(s);
      expect(own[0]).toBe(`持ち主が決めた目的で始めた: 遠征 1（${objectiveText('ja', offer2.objective)}）。あなたが指した候補 1 ではなく、持ち主の選んだ目的で始まった`);
      expect(own).toContain('持ち主から: 静かに');
    }
    expect(r.session.world.players[r.playerId].ownerDecided).toEqual(['objective']);
    const od = [...r.session.history].reverse().find((e) => e.type === 'owner_decided');
    expect(od).toMatchObject({ act: 'start_expedition', offer: 2, asked: 1, no: 1 });
    // 迷宮の中: 札は出さない。持ち主の prepare は not_at_camp
    expect(r.port.observeWithTurn('observed').observation.self.directive?.prep).toBeUndefined();
    expect(errCode(await owner(r, { type: 'prepare', ready: false }))).toBe('not_at_camp');
    // 帰る: キャンプに着くと、また「まだ」（前のキャンプの目的は消える）
    await lifelineHome(r);
    expect(prepOf(r)).toEqual({ state: 'pending', seen: expect.any(Array) });
    expect(r.session.history.filter((e) => e.type === 'directive_prep' && (e as { why?: string }).why === 'camp').length).toBeGreaterThanOrEqual(1);
    // 握るのを、すべてやめると、札は消える（AI は待たずに出発できる）
    expect(errCode(await owner(r, { type: 'set_directive', hold: [] }))).toBe('ok');
    expect(prepOf(r)).toBeUndefined();
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    m.closeAll();
  });

  it('nothing to decide means ready from the start (perks held with no offer, equipment held with nothing new); an offer or new gear at camp arrival makes it "not ready"', async () => {
    const m = manager();
    // 特技と加護: 候補が無ければ準備完了。AI は待たずに出発できる
    const a = await campRun(m, 's9-card-perks');
    expect(errCode(await owner(a, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    expect(prepOf(a)?.state).toBe('ready');
    let o = a.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text).toBe('持ち主の支度: 準備完了（特技と加護は、決めてある）。start_expedition で出発する（次の遠征は、あなたが選ぶ）');
    expect(o.observation.valid_actions.filter((l) => l.startsWith('start_expedition')).length).toBeGreaterThan(1);
    expect(o.observation.valid_actions.some((l) => l.includes('持ち主が特技を選ぶ前に'))).toBe(false);
    expect(errCode(await act(a.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    // 遠征の間に候補が出た（記録の外で足す）→ キャンプに着くと「まだ」
    offerPerks(a, 3);
    await lifelineHome(a);
    expect(prepOf(a)?.state).toBe('pending');
    o = a.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text).toBe('持ち主の支度: まだ（決めていないもの: 特技（Lv2 の候補 3 つ））。準備完了になるまで、start_expedition は断られる。待つなら wait_for_turn');
    const r1 = await act(a.port, { type: 'start_expedition', offer: 1 });
    expect(errCode(r1)).toBe('held_by_owner');
    if (!r1.ok) {
      expect(r1.error.message).toBe('持ち主の支度が、まだ（決めていないもの: 特技（Lv2 の候補 3 つ））。準備完了になるまで、start_expedition は断られる。');
      expect(r1.error.hint).toContain('wait_for_turn');
    }
    // 持ち主が選ばないまま準備完了 → AI は出発でき、候補は次のキャンプまで保留（始めた直後の「変化」に 1 回）
    expect(errCode(await owner(a, { type: 'prepare', ready: true }))).toBe('ok');
    o = a.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text).toBe('持ち主の支度: 準備完了（特技は、選ばないまま（次のキャンプまで保留））。start_expedition で出発する（次の遠征は、あなたが選ぶ）');
    const st = await act(a.port, { type: 'start_expedition', offer: 1 });
    expect(errCode(st)).toBe('ok');
    if (st.ok) expect(ownerLines(st)).toContain('特技を選ばないまま、遠征を始めた（持ち主が選べるのは、次のキャンプ）');
    await lifelineHome(a);
    expect(prepOf(a)?.state).toBe('pending');
    // 準備完了の後の変更で「まだ」に戻る: 持ち主が特技を選んだ
    expect(errCode(await owner(a, { type: 'prepare', ready: true }))).toBe('ok');
    expect(errCode(await owner(a, { type: 'choose_perk', option: 1 }))).toBe('ok');
    expect(prepOf(a)?.state).toBe('pending');
    // 決めるものが無くても、持ち主が「まだ」に戻したら AI は待つ（持ち主が、支度を見直している）
    o = a.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.prep?.text).toBe('持ち主の支度: まだ（持ち主が、支度を見直している）。準備完了になるまで、start_expedition は断られる。待つなら wait_for_turn');

    // 装備: 何も新しくなければ準備完了。遠征で装備できる品を持ち帰ると「まだ」。準備完了で覚え直す
    const b = await campRun(m, 's9-card-gear');
    expect(errCode(await owner(b, { type: 'set_directive', hold: ['loadout'] }))).toBe('ok');
    expect(prepOf(b)?.state).toBe('ready');
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    const gid = giveGear(b);
    await lifelineHome(b);
    expect(prepOf(b)?.state).toBe('pending');
    o = b.port.observeWithTurn('observed');
    expect(o.observation.self.directive?.undecided?.gear).toBe(1);
    expect(o.observation.self.directive?.prep?.text).toBe('持ち主の支度: まだ（決めていないもの: 新しく持ち物に入った装備 1 品）。準備完了になるまで、start_expedition は断られる。待つなら wait_for_turn');
    expect(m.ownerRuns({ local: true }).runs.find((x) => x.runId === b.session.runId)?.prep).toEqual({ state: 'pending' });
    expect(errCode(await owner(b, { type: 'prepare', ready: true }))).toBe('ok');
    expect(prepOf(b)?.seen).toContain(gid);
    expect(b.port.observeWithTurn('observed').observation.self.directive?.undecided).toBeUndefined();
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    await lifelineHome(b);
    // 前の準備完了の後に入った品が無いので、最初から準備完了
    expect(prepOf(b)?.state).toBe('ready');
    // 装備を変えたら「まだ」に戻る・握る項目を変えたら「まだ」に戻る
    const armor = b.port.view().inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await owner(b, { type: 'unequip', slot: armor.slot }))).toBe('ok');
    expect(prepOf(b)?.state).toBe('pending');
    expect(errCode(await owner(b, { type: 'prepare', ready: true }))).toBe('ok');
    expect(errCode(await owner(b, { type: 'set_directive', hold: ['loadout', 'perks'] }))).toBe('ok');
    expect(prepOf(b)?.state).toBe('pending');
    // 伝言だけを変えても、札は変わらない
    expect(errCode(await owner(b, { type: 'prepare', ready: true }))).toBe('ok');
    expect(errCode(await owner(b, { type: 'set_directive', hold: ['loadout', 'perks'], message: 'よろしく' }))).toBe('ok');
    expect(prepOf(b)?.state).toBe('ready');
    m.closeAll();
  });

  it('MCP wait_for_turn waits while not ready and returns when the owner marks it ready; the timeout text says what to do', async () => {
    const m = manager();
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 's9', version: '0' });
    await client.connect(y);
    type T = { structuredContent: { turn: { reason: string; owner_wait?: unknown; changes: { code: string; text: string }[] }; observation: { self: { directive?: { prep?: { state: string } } } } }; content: { text: string }[] };
    const nr = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Mw' } })) as unknown as { structuredContent: { run_id: string; player_token: string; player_id: string } };
    const { run_id, player_token, player_id } = nr.structuredContent;
    const s = m.get(run_id)!;
    expect(errCode(await s.submit(player_id, { type: 'set_directive', hold: ['objective'] }, { source: 'owner' }))).toBe('ok');
    const t0 = (await client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 1 } })) as unknown as T;
    expect(t0.structuredContent.turn.reason).toBe('wait_timeout');
    expect(t0.content[0].text.split('\n').at(-1)).toBe('▶ キャンプにいます。持ち主の支度は、まだ準備完了でない（この待ちで 1 秒待った）。準備完了になったら、次の応答で分かる（そのあと、あなたが start_expedition で出発する）。もう一度 wait_for_turn で待てる（何回待ってもよい。手番は減らない）。待つのをやめてもよい（やめると、準備完了になっても、だれも出発しない。次に呼んだときに、start_expedition で出発できる）。');
    // 待っている間は、持ち主の一覧に「いま待っている」
    const pending = client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 20 } }) as unknown as Promise<T>;
    await new Promise((res) => setTimeout(res, 80));
    const row = m.ownerRuns({ local: true }).runs.find((r0) => r0.runId === run_id)!;
    expect(row.ai?.waitingNow).toBe(true);
    expect(row.ai?.lastCallAgoS).toBeLessThan(5);
    expect(errCode(await s.submit(player_id, { type: 'prepare', objective: 'endless', ready: true }, { source: 'owner' }))).toBe('ok');
    const t1 = await pending;
    expect(t1.structuredContent.turn.reason).toBe('observed');
    expect(t1.structuredContent.observation.self.directive?.prep?.state).toBe('ready');
    expect(t1.structuredContent.turn.changes.some((c) => c.code === 'owner' && c.text.startsWith('持ち主の支度が、準備完了になった（目的: 目的なし（endless））'))).toBe(true);
    expect(m.ownerRuns({ local: true }).runs.find((r0) => r0.runId === run_id)!.ai?.waitingNow).toBe(false);
    // 出発するのは AI
    const st = (await client.callTool({ name: 'start_expedition', arguments: { player_token, offer: 1 } })) as unknown as T;
    expect(st.structuredContent.turn.changes.some((c) => c.text.startsWith('持ち主が決めた目的で始めた: 遠征 1（目的なし。できるだけ深く潜る）。あなたが指した候補 1 ではなく'))).toBe(true);
    expect(s.view(player_id).expedition?.objective.type).toBe('endless');
    await client.close();
    m.closeAll();
  });
});

describe('S9 §58.2: wishes', () => {
  it('a held command becomes a wish (no turn, an event, the reason cleaned); the same wish twice adds nothing; the owner sees it and can do as wished; it goes away when decided or released', async () => {
    const m = manager();
    const r = await campRun(m, 's9-wish-1');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'loadout', 'perks'] }))).toBe('ok');
    const opts = offerPerks(r, 3);
    const t0 = turnsOf(r);
    const seq0 = r.session.world.seq;
    // 特技の希望（理由つき。制御文字は落とし、280 字まで）
    const why = `装甲 1 では\n群れに\u0007耐えられない${'。'.repeat(400)}`;
    const w1 = await act(r.port, { type: 'choose_perk', option: 2 }, why);
    expect(errCode(w1)).toBe('held_by_owner');
    const perkName = catalog.perks[opts[1]].name.ja;
    if (!w1.ok) {
      expect(w1.error.message).toBe(`これは、持ち主が決める。あなたの希望（${perkName}）は、持ち主に伝えた（持ち主が決めるのは、キャンプで）。`);
      expect(w1.error.details?.wish).toBe(true);
    }
    expect(turnsOf(r)).toBe(t0);
    expect(r.session.world.seq).toBeGreaterThan(seq0);
    const wishes = () => r.session.world.players[r.playerId].directive?.wishes ?? [];
    expect(wishes()).toHaveLength(1);
    const w = wishes()[0];
    expect(w).toMatchObject({ item: 'perk', perk: opts[1], level: 2 });
    expect(w.reason?.startsWith('装甲 1 では 群れに耐えられない')).toBe(true);
    expect([...w.reason!].length).toBe(280);
    // 同じ希望のくり返しは、出来事を足さない（断りの文は同じ）
    const seq1 = r.session.world.seq;
    const w2 = await act(r.port, { type: 'choose_perk', option: opts[1] }, why);
    expect(errCode(w2)).toBe('held_by_owner');
    expect(r.session.world.seq).toBe(seq1);
    // 別の項目の希望（目的・装備）。成り立たない命令（候補に無い）は希望にならない
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 3 }, '深いほうへ'))).toBe('held_by_owner');
    const armor = r.port.view().inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await act(r.port, { type: 'unequip', slot: armor.slot }))).toBe('held_by_owner');
    const seq2 = r.session.world.seq;
    expect(errCode(await act(r.port, { type: 'choose_boon', option: 1 }))).toBe('held_by_owner');
    expect(errCode(await act(r.port, { type: 'equip', slot: 'z' }))).toBe('held_by_owner');
    expect(r.session.world.seq).toBe(seq2);
    expect(wishes().map((x) => x.item)).toEqual(['objective', 'loadout', 'perk']);
    // 持ち主に見える（PlayerView から。成り立つものだけ）。一覧の数・観測の「直前の出来事」
    const ov = ownerView(r.session, r.playerId);
    expect(activeWishes(ov.view).map((x) => x.item)).toEqual(['objective', 'loadout', 'perk']);
    expect(ownerRow(r.session, r.playerId).wishes).toBe(3);
    const pe = r.port.pending().find((e) => e.type === 'directive_wish');
    expect(pe?.text).toContain(`希望を持ち主に伝えた: ${perkName}（装甲 1 では 群れに耐えられない`);
    // 思考の欄の文（narrate。観戦・リプレイと同じ）
    const ev = r.session.history.find((e) => e.type === 'directive_wish' && (e as { wish: { item: string } }).wish.item === 'objective')!;
    expect(narrate(ev as never, { locale: 'ja', catalog, selfId: null, playerNames: {} })).toBe(`希望を持ち主に伝えた: 候補 3: ${objectiveText('ja', r.port.view().camp!.offers.find((o) => o.index === 3)!.objective)}（深いほうへ）。`);
    // 「希望どおりにする」: 特技は、その命令を持ち主の口から。希望は消え、札は「まだ」のまま
    const pw = activeWishes(ov.view).find((x) => x.item === 'perk')!;
    expect(wishCommand(ov.view, pw)).toEqual({ type: 'choose_perk', option: opts[1] });
    expect(errCode(await owner(r, wishCommand(ov.view, pw)!))).toBe('ok');
    expect(meOf(r.session.world, r.playerId).build?.perks).toContain(opts[1]);
    expect(wishes().map((x) => x.item)).toEqual(['objective', 'loadout']);
    // 目的は、選ぶだけ（prepare { objective }）
    const ow = activeWishes(ownerView(r.session, r.playerId).view).find((x) => x.item === 'objective')!;
    expect(wishCommand(ownerView(r.session, r.playerId).view, ow)).toEqual({ type: 'prepare', objective: 3 });
    expect(errCode(await owner(r, { type: 'prepare', objective: 3 }))).toBe('ok');
    expect(wishes().map((x) => x.item)).toEqual(['loadout']);
    expect(prepOf(r)).toMatchObject({ state: 'pending', objective: 3 });
    // 成り立たなくなった希望は、持ち主の画面に出さない（着けている品を外す希望で、持ち主が先に外した）
    expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('ok');
    expect(wishes()).toEqual([]);
    expect(errCode(await act(r.port, { type: 'equip', slot: armor.slot }, 'やっぱり着たい'))).toBe('held_by_owner');
    expect(wishes().map((x) => x.item)).toEqual(['loadout']);
    // 握るのをやめた項目の希望は消える
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'perks'] }))).toBe('ok');
    expect(wishes()).toEqual([]);
    // 迷宮の中でも出せる（キャンプで決める）
    expect(errCode(await owner(r, { type: 'prepare', ready: true }))).toBe('ok');
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    const opts2 = offerPerks(r, 2);
    const t1 = turnsOf(r);
    const wd = await act(r.port, { type: 'choose_perk', option: 1 }, 'いま欲しい');
    expect(errCode(wd)).toBe('held_by_owner');
    if (!wd.ok) expect(wd.error.hint).toBe('そのまま続けてよい（身につけるのは、キャンプに戻ってから）。');
    expect(turnsOf(r)).toBe(t1);
    expect(wishes()).toEqual([{ item: 'perk', perk: opts2[0], level: 2, reason: 'いま欲しい' }]);
    // 英語
    r.session.world.players[r.playerId].locale = 'en';
    const we = await act(r.port, { type: 'choose_perk', option: 2 });
    if (!we.ok) expect(we.error.message).toBe(`This is your owner's call. Your wish (${catalog.perks[opts2[1]].name.en}) has been passed to your owner (they decide at camp).`);
    r.session.world.players[r.playerId].locale = 'ja';
    m.closeAll();
  });

  it('only the player and its owner see wishes: another participant\'s world, view and the season standings carry none', async () => {
    const m = manager();
    m.seasons.store.open({ id: 's9w', name: 'S9試し', seed: 's9-season-w', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const join1 = async (name: string) => {
      const inv = m.seasons.invite('s9w', name, m.profiles.store);
      if ('error' in inv) throw new Error(inv.error);
      const r = await m.createRun({ name, controller: agent, season: 's9w', profileToken: inv.token! });
      if ('error' in r) throw new Error(r.error.message);
      return { ...r, ptoken: inv.token! };
    };
    const a = await join1('アオ');
    const b = await join1('ベニ');
    expect(errCode(await a.session.submit(a.playerId, { type: 'set_directive', hold: ['objective'] }, { source: 'owner' }))).toBe('ok');
    // シーズンのランでも、希望は取り込みを記録する前に（取り込みをせずに）覚える
    const syncs = () => a.session.history.filter((e) => e.type === 'season_synced').length;
    const s0 = syncs();
    expect(errCode(await act(a.port, { type: 'start_expedition', offer: 2 }, 'ひみつの理由'))).toBe('held_by_owner');
    expect(syncs()).toBe(s0);
    expect(a.session.world.players[a.playerId].directive?.wishes?.[0]).toMatchObject({ item: 'objective', offer: 2, reason: 'ひみつの理由' });
    // 準備完了の後の出発では、取り込みを記録してから始める
    expect(errCode(await a.session.submit(a.playerId, { type: 'prepare', objective: 1, ready: true }, { source: 'owner' }))).toBe('ok');
    expect(errCode(await act(a.port, { type: 'start_expedition', offer: 3 }))).toBe('ok');
    expect(syncs()).toBe(s0 + 1);
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    await lifelineHome(b);
    await lifelineHome(a);
    const bw = JSON.stringify(b.session.world);
    expect(bw.includes('ひみつの理由')).toBe(false);
    expect(bw.includes('directive')).toBe(false);
    expect(b.port.view().directive).toBeUndefined();
    expect(JSON.stringify(m.seasons.standings('s9w'))).not.toContain('ひみつの理由');
    // 持ち主の口は、トークンの持ち主のランだけ（B のトークンで A の希望は見えない）
    const acc = m.ownerAccess(a.session.runId, { local: false, profileToken: b.ptoken });
    expect('error' in acc).toBe(true);
    m.closeAll();
  });
});

describe('S9 §58.3: one adventurer, one run to continue', () => {
  it('refuses a second new_run for the same profile (run_in_progress, with the run id and how to go on); end_previous retires the previous run first; no token still makes a new profile', async () => {
    const m = manager();
    const a = await campRun(m, 's9-one-1');
    const ptok = a.profile.token!;
    expect(errCode(await act(a.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    // 続きのあるラン（迷宮の中）がある
    const b0 = await m.createRun({ name: 'Su', seed: 's9-one-2', controller: agent, profileToken: ptok });
    expect('error' in b0 && b0.error.code).toBe('run_in_progress');
    if ('error' in b0) {
      expect(b0.error.message).toContain(a.session.runId);
      expect(b0.error.message).toContain('resume_run');
      expect(b0.error.message).toContain('end_previous: true');
      expect(b0.error.details?.in_progress).toEqual({ run_id: a.session.runId });
    }
    expect(m.sessions.size).toBe(1);
    expect(a.session.world.status).toBe('active');
    // 新しいランの参加が断られると分かっている（知らない職業）なら、end_previous でも前のランを終わらせない
    const bad = await m.createRun({ name: 'Su', seed: 's9-one-2', controller: agent, profileToken: ptok, endPrevious: true, classId: 'core:nobody' });
    expect('error' in bad && bad.error.code).toBe('bad_request');
    expect(a.session.world.status).toBe('active');
    expect(m.sessions.size).toBe(1);
    // end_previous: 前のランを引退と同じに終える（迷宮の中でも）。記録には引退の命令（出どころは new_run と同じ口）
    const b = await campRun(m, 's9-one-2', { profileToken: ptok, endPrevious: true });
    expect(a.session.world.players[a.playerId].state).toBe('left');
    expect(a.session.world.players[a.playerId].stats.deathCause).toBe('retired');
    expect(a.session.world.status).toBe('ended');
    expect(b.profile).toEqual({ id: a.profile.id });
    // 終わったランは数えない
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    // トークンなしの new_run は、今までどおり（新しいプロフィール）
    const c = await campRun(m, 's9-one-3');
    expect(c.profile.id).not.toBe(a.profile.id);
    expect(c.profile.token).toBeTruthy();
    // 数えないもの: 版が違うラン（この版の engine で始まっていない。記録の外で版の欄を書き換える）
    const bv = b.session.world.meta.engineVersion;
    b.session.world.meta.engineVersion = '0.48.0';
    const d = await campRun(m, 's9-one-4', { profileToken: ptok });
    expect(b.session.world.status).toBe('active');
    b.session.world.meta.engineVersion = bv;
    // d が続きのあるランになった（b も数えると 2 つ: end_previous は両方を終える）
    const e0 = await m.createRun({ name: 'Su', seed: 's9-one-5', controller: agent, profileToken: ptok });
    expect('error' in e0 && e0.error.code).toBe('run_in_progress');
    const e = await campRun(m, 's9-one-5', { profileToken: ptok, endPrevious: true });
    expect(b.session.world.status).toBe('ended');
    expect(d.session.world.status).toBe('ended');
    expect(e.session.world.status).toBe('active');
    m.closeAll();
  });

  it('a finalized season\'s run does not count; a co-op run counts; season runs take end_previous too', async () => {
    const m = manager();
    m.seasons.store.open({ id: 's9o', name: 'S9一', seed: 's9-season-o', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite('s9o', 'オト', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const tok = inv.token!;
    const s1 = await m.createRun({ name: 'オト', controller: agent, season: 's9o', profileToken: tok });
    if ('error' in s1) throw new Error(s1.error.message);
    // シーズンのランが続きのあるラン: シーズンの new_run も、シーズンでない new_run も run_in_progress
    const s2 = await m.createRun({ name: 'オト', controller: agent, season: 's9o', profileToken: tok });
    expect('error' in s2 && s2.error.code).toBe('run_in_progress');
    if ('error' in s2) expect(s2.error.details?.in_progress).toEqual({ run_id: s1.session.runId, season: 's9o' });
    const n1 = await m.createRun({ name: 'オト', seed: 's9-o-n1', controller: agent, profileToken: tok });
    expect('error' in n1 && n1.error.code).toBe('run_in_progress');
    // end_previous で、同じシーズンの新しいランを始められる（予算は続きから。前のランは引退で終わる。倒れた扱いにしない）
    const s3 = await m.createRun({ name: 'オト', controller: agent, season: 's9o', profileToken: tok, endPrevious: true });
    if ('error' in s3) throw new Error(s3.error.message);
    expect(s1.session.world.status).toBe('ended');
    const row = m.seasons.standings('s9o')!.standings.find((x) => x.name === 'オト')!;
    expect(row.runs).toBe(2);
    expect(row.died).toBe(false);
    // 確定したシーズンのランは数えない（終わりの扱いにせず、そのまま記録に残る）
    m.seasons.finalize(m.seasons.get('s9o')!, 'operator');
    const n2 = await campRun(m, 's9-o-n2', { profileToken: tok });
    expect(s3.session.world.status).toBe('active');
    // 協力プレイのランも数える（その者の引退として終える）
    const co = await m.createRun({ name: 'オト', seed: 's9-o-co', controller: agent, mode: 'coop', profileToken: tok, endPrevious: true });
    if ('error' in co) throw new Error(co.error.message);
    expect(n2.session.world.status).toBe('ended');
    const n3 = await m.createRun({ name: 'オト', seed: 's9-o-n3', controller: agent, profileToken: tok });
    expect('error' in n3 && n3.error.code).toBe('run_in_progress');
    const n4 = await campRun(m, 's9-o-n3', { profileToken: tok, endPrevious: true });
    expect(co.session.world.players[co.playerId].state).toBe('left');
    expect(n4.session.world.status).toBe('active');
    m.closeAll();
  });

  it('what the owner holds is kept on the profile and carried to the next run as an owner command (from camp, even with a first objective); the message is not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s9-hold-'));
    try {
      const m = manager(dir);
      const a = await campRun(m, 's9-hold-1');
      const ptok = a.profile.token!;
      expect(errCode(await owner(a, { type: 'set_directive', hold: ['objective', 'perks'], message: 'ひみつ' }))).toBe('ok');
      expect(m.profiles.store.get(a.profile.id)?.hold).toEqual(['objective', 'perks']);
      expect(readFileSync(join(dir, 'profiles', `${a.profile.id}.json`), 'utf8')).not.toContain('ひみつ');
      const b = await campRun(m, 's9-hold-2', { profileToken: ptok, endPrevious: true, objective: 'auto' });
      expect(b.inherited).toEqual({ hold: ['objective', 'perks'], objectiveIgnored: true });
      expect(b.port.view().status).toBe('at_camp');
      expect(b.session.world.players[b.playerId].directive).toMatchObject({ hold: ['objective', 'perks'], message: '', prep: { state: 'pending' } });
      const recs = readFileSync(join(dir, 'runs', b.session.runId, 'commands.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CommandRecord);
      expect(recs.filter((x) => x.source === 'owner').map((x) => x.command)).toEqual([{ type: 'set_directive', hold: ['objective', 'perks'] }]);
      // 握るのをやめたら、プロフィールからも消える。次のランは握らない
      expect(errCode(await owner(b, { type: 'set_directive', hold: [] }))).toBe('ok');
      expect(m.profiles.store.get(a.profile.id)?.hold).toBeUndefined();
      const c = await campRun(m, 's9-hold-3', { profileToken: ptok, endPrevious: true, objective: 'auto' });
      expect(c.inherited).toBeUndefined();
      expect(c.port.view().status).toBe('your_turn');
      expect(c.session.world.players[c.playerId].directive).toBeUndefined();
      // 人間が自分で遊ぶランには、引き継がない（指図の対象でない）
      m.profiles.noteHold(a.profile.id, ['objective']);
      const h = await m.createRun({ name: 'Su', seed: 's9-hold-4', controller: { kind: 'human', label: 'browser' }, profileToken: ptok, endPrevious: true, objective: 'auto' });
      if ('error' in h) throw new Error(h.error.message);
      expect(h.inherited).toBeUndefined();
      expect(h.session.world.players[h.playerId].directive).toBeUndefined();
      expect(h.port.view().status).toBe('your_turn');
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('MCP and HTTP: run_in_progress with how to go on, end_previous / endPrevious, and the inherited-hold line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s9-api-'));
    try {
      const m = manager(dir);
      const [x, y] = InMemoryTransport.createLinkedPair();
      const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
      await server.connect(x);
      const client = new Client({ name: 's9-api', version: '0' });
      await client.connect(y);
      type R = { isError?: boolean; structuredContent: { run_id?: string; player_id?: string; profile_token?: string; inherited_hold?: string[]; error?: { code: string; message: string; hint: string } }; content: { text: string }[] };
      const n1 = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Ai' } })) as unknown as R;
      const ptok = n1.structuredContent.profile_token!;
      const s1 = m.get(n1.structuredContent.run_id!)!;
      expect(errCode(await s1.submit(n1.structuredContent.player_id!, { type: 'set_directive', hold: ['loadout'] }, { source: 'owner' }))).toBe('ok');
      const n2 = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Ai', profile_token: ptok } })) as unknown as R;
      // ゲームの断りの形（season_unavailable と同じ。isError にはしない）
      expect(n2.structuredContent.error?.code).toBe('run_in_progress');
      expect(n2.content[0].text).toContain('Error [run_in_progress]');
      expect(n2.content[0].text).toContain(s1.runId);
      const n3 = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Ai', profile_token: ptok, end_previous: true, objective: 'auto' } })) as unknown as R;
      expect(n3.isError).toBeFalsy();
      expect(n3.structuredContent.inherited_hold).toEqual(['loadout']);
      expect(n3.content[0].text).toContain('持ち主が握っている項目（装備）を、このプロフィールから引き継いだ。キャンプから始め、持ち主の支度を待つ（渡された最初の遠征の目的は、使わなかった）。');
      expect(s1.world.status).toBe('ended');
      // 装備だけなら、決めるものが無いので準備完了（AI は待たずに出発できる）
      const s3 = m.get(n3.structuredContent.run_id!)!;
      expect(s3.world.players[s3.world.playerOrder[0]].directive?.prep?.state).toBe('ready');
      await client.close();
      // HTTP: 409 と、endPrevious で通る
      const app = createApp(m, m.config);
      await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const post = async (body: unknown) => { const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, json: await res.json() as Record<string, unknown> }; };
      const h1 = await post({ name: 'Ai', profileToken: ptok, controller: { kind: 'agent', label: 'http' } });
      expect(h1.status).toBe(409);
      expect((h1.json.error as { code: string }).code).toBe('run_in_progress');
      const h2 = await post({ name: 'Ai', profileToken: ptok, controller: { kind: 'agent', label: 'http' }, endPrevious: true });
      expect(h2.status).toBe(200);
      expect(s3.world.status).toBe('ended');
      // 応答にトークンの値以外のトークンを出さない（プロフィールのトークンは、新しく作ったときだけ）
      expect(JSON.stringify(h2.json)).not.toContain(ptok);
      await new Promise<void>((res) => app.server.close(() => res()));
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S9 §58.7: replay from the records alone, and the same observation across a restart', () => {
  it('card, wishes, the owner\'s choice and the AI\'s start re-execute to the same events; recovery is verified and leaves the files as they are', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s9-replay-'));
    try {
      const m = manager(dir);
      const r = await campRun(m, 's9-replay-1');
      const pid = r.playerId;
      expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'loadout'], message: '慎重に' }))).toBe('ok');
      expect(errCode(await act(r.port, { type: 'start_expedition', offer: 2 }, '二番目がよい'))).toBe('held_by_owner');
      const armor = r.port.view().inventory.find((i) => i.equipped === 'armor')!;
      expect(errCode(await act(r.port, { type: 'unequip', slot: armor.slot }, '軽くしたい'))).toBe('held_by_owner');
      expect(errCode(await owner(r, { type: 'prepare', objective: 2 }))).toBe('ok');
      expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('ok');
      expect(errCode(await owner(r, { type: 'prepare', ready: true }))).toBe('ok');
      expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
      await lifelineHome(r);
      // 次のキャンプ: 「まだ」。希望をもう 1 つ
      expect(errCode(await act(r.port, { type: 'equip', slot: armor.slot }, '戻したい'))).toBe('held_by_owner');
      expect(r.session.world.players[pid].directive?.prep?.state).toBe('pending');
      const before = JSON.stringify(buildObservation(projectPlayerView(r.session.world, pid), catalog, { detail: 'full', map: false }));
      const ov0 = ownerView(r.session, pid);
      const runId = r.session.runId;
      m.closeAll();
      const runDir = join(dir, 'runs', runId);
      // 記録だけからの再実行（初めから）
      const v = verifyRunDir(content, runDir);
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
      // 起動し直す: 一致し、記録を変えない。観測は同じ
      const h0 = hashes(runDir);
      const m2 = manager(dir);
      const rec = RunSession.recover(m2.deps, runId);
      expect(rec.verified).toBe(true);
      expect(JSON.stringify(buildObservation(projectPlayerView(rec.session.world, pid), catalog, { detail: 'full', map: false }))).toBe(before);
      const ov1 = ownerView(rec.session, pid);
      expect(JSON.stringify((ov1 as OwnerViewResponse).view.directive)).toBe(JSON.stringify(ov0.view.directive));
      // 起動し直した後も、札は「まだ」で、start_expedition は断られる（同じ希望なら出来事を足さない）
      const seqR = rec.session.world.seq;
      expect(errCode(await rec.session.submit(pid, { type: 'equip', slot: armor.slot }, { source: 'mcp', thought: '戻したい' }))).toBe('held_by_owner');
      expect(rec.session.world.seq).toBe(seqR);
      rec.session.close();
      m2.closeAll();
      const h1 = hashes(runDir);
      for (const [p, h] of Object.entries(h0)) if (!p.endsWith('meta.json')) expect(h1[p]).toBe(h);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the rules describe the card, wishes and one run per adventurer (ja and en)', () => {
    const ja = rulesText('directive', 'ja', catalog);
    const en = rulesText('directive', 'en', catalog);
    expect(ja).toContain('遠征の途中は、止まらない。キャンプでは、持ち主の支度を待つ');
    expect(ja).toContain('持ち主の支度（S9）');
    expect(ja).toContain('希望（S9）');
    expect(ja).toContain('冒険者 1 人に、続きは 1 つ（S9）');
    expect(ja).not.toContain('選ぶまで、進行は止まらない');
    expect(en).toContain('Your owner\'s preparations (S9)');
    expect(en).toContain('Wishes (S9)');
    expect(en).toContain('One adventurer, one run to continue (S9)');
    expect(JSON.stringify(ja)).not.toContain('鑑定');
  });
});

// S8b（SEASON.md §55.7）のテスト: 持ち主を待つ応答の文（時間切れ・やめてよい）・伝言が新しくなったこと・装備のまとめの 1 行・
// 予算切れ・時間切れのキャンプでは待たない
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createMcpServer, loadConfig, RunSession, SessionManager, SessionPlayerPort } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, buildTurnBlock, EVENT_VERSION, projectPlayerView, seasonBudgetLeft, turnLine } from '@muse/shared';
import type { Command, GameEvent, TurnBlock, World } from '@muse/shared';

const content = loadContent();
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's8b';

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir, waitOthersMs: 100 } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
async function campRun(m: SessionManager, seed: string) {
  const r = await m.createRun({ name: 'Ow', seed, controller: agent });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof campRun>>;
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const owner = (r: Run, cmd: Command) => r.session.submit(r.playerId, cmd, { source: 'owner' });
const errCode = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? 'ok' : x.error!.code);
const ownerLines = (b: TurnBlock) => b.changes.filter((c) => c.code === 'owner').map((c) => c.text);

type ToolResult = { structuredContent: { turn: TurnBlock; run_id?: string; player_token?: string; player_id?: string }; content: { text: string }[] };
async function mcp(m: SessionManager) {
  const [x, y] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
  await server.connect(x);
  const client = new Client({ name: 's8b', version: '0' });
  await client.connect(y);
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  return { client, call };
}

describe('S8b の 1: the waiting response says what is going on', () => {
  it('a timed-out wait_for_turn says the owner has not decided, how long it waited, that waiting again is fine and that stopping is fine; after stopping, the owner\'s start is picked up on the next call', async () => {
    expect(ENGINE_VERSION).toBe('0.48.0');
    expect(EVENT_VERSION).toBe(36);
    const m = manager();
    const { client, call } = await mcp(m);
    const nr = await call('new_run', { character_name: 'Mw' });
    const { run_id, player_token, player_id } = nr.structuredContent as { run_id: string; player_token: string; player_id: string };
    const s = m.get(run_id)!;
    expect(errCode(await s.submit(player_id, { type: 'set_directive', hold: ['objective'] }, { source: 'owner' }))).toBe('ok');
    const seq0 = s.world.seq;
    const t0 = await call('wait_for_turn', { player_token, timeout_s: 1 });
    expect(t0.structuredContent.turn.reason).toBe('wait_timeout');
    expect(t0.structuredContent.turn.owner_wait).toEqual({ decided: false, waited_s: 1, may_wait_again: true, turns_spent: 0 });
    const line = t0.content[0].text.split('\n').at(-1)!;
    expect(line).toBe('▶ キャンプにいます。持ち主は、まだ次の遠征を決めていない（この待ちで 1 秒待った）。決めたら、次の応答で、迷宮の中に変わる。もう一度 wait_for_turn で待てる（何回待ってもよい。手番は減らない）。待つのをやめてもよい（やめても、持ち主が始めれば遠征は始まり、次に呼んだときに続きから遊べる）。');
    // もう一度待っても、手番は減らない
    const t1 = await call('wait_for_turn', { player_token, timeout_s: 1 });
    expect(t1.structuredContent.turn.reason).toBe('wait_timeout');
    expect(t1.structuredContent.turn.turn_no).toBe(t0.structuredContent.turn.turn_no);
    expect(s.world.seq).toBe(seq0);
    // observe（待たない）: 待ち方の行。待った秒数は無い
    const ob = await call('observe', { player_token });
    expect(ob.structuredContent.turn.owner_wait).toEqual({ decided: false, may_wait_again: true, turns_spent: 0 });
    expect(ob.content[0].text).toContain('▶ キャンプにいます。持ち主が、次の遠征を決めるのを待つ。');
    // 待つのをやめた（呼ばない）間に、持ち主が始める → 次に呼んだとき、迷宮の中から続けて遊べる
    expect(errCode(await s.submit(player_id, { type: 'start_expedition', offer: 1 }, { source: 'owner' }))).toBe('ok');
    const o2 = await call('observe', { player_token });
    expect(o2.structuredContent.turn.state).toBe('your_turn');
    expect(o2.structuredContent.turn.owner_wait).toBeUndefined();
    expect(ownerLines(o2.structuredContent.turn).some((x) => x.startsWith('持ち主が、遠征 1 を始めた'))).toBe(true);
    const turns0 = s.view(player_id).self.turns;
    await call('wait', { player_token });
    expect(s.view(player_id).self.turns).toBe(turns0 + 1);
    await client.close();
    m.closeAll();
  });
});

describe('S8b の 2: a new message stands out', () => {
  it('the first response after the owner writes or rewrites it has the change and the (new) mark, once; the first dungeon response after the owner starts has the message again; the same from the same World and baseline after a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s8b-'));
    try {
      const m = manager(dir);
      const r = await campRun(m, 's8b-msg-1');
      const pid = r.playerId;
      r.port.observeWithTurn('observed');
      expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'], message: '薬は温存' }))).toBe('ok');
      const a = r.port.observeWithTurn('observed');
      expect(ownerLines(a.turn)).toEqual(['持ち主が、伝言を書いた: 薬は温存']);
      expect(a.text).toContain('持ち主から（新しい）: 薬は温存');
      expect(a.text).toContain('変化: 持ち主が、伝言を書いた: 薬は温存');
      expect(a.observation.self.directive?.message_new).toBe(true);
      // 同じ伝言は 2 回「新しい」にならない
      const b = r.port.observeWithTurn('observed');
      expect(ownerLines(b.turn)).toEqual([]);
      expect(b.text).toContain('持ち主から: 薬は温存');
      expect(b.text).not.toContain('（新しい）');
      expect(b.observation.self.directive?.message_new).toBeUndefined();
      // 書き換えた
      expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'], message: '地下3階で帰る' }))).toBe('ok');
      // 起動し直した前後で同じ（World と、応答の基準だけで決まる）: 基準を控えて、同じ基準で比べる（peek は基準を進めない）
      const base = structuredClone(r.session.turnSnapshot(pid)!);
      const peek = r.port.observeWithTurn('observed', { changes: 'peek' });
      expect(ownerLines(peek.turn)).toEqual(['持ち主が、伝言を書いた: 地下3階で帰る']);
      const runId = r.session.runId;
      m.closeAll();
      const m2 = manager(dir);
      const rec = RunSession.recover(m2.deps, runId);
      expect(rec.verified).toBe(true);
      rec.session.setTurnSnapshot(pid, base);
      const port2 = new SessionPlayerPort(rec.session, pid);
      const after = port2.observeWithTurn('observed');
      expect(after.turn.changes).toEqual(peek.turn.changes);
      // 文の持ち主の行も同じ（「直前の出来事」は、サーバーが既読を覚える別のもので、起動し直すと出直す。ここでは比べない）
      const ownerText = (s: string) => s.split('\n').filter((l) => l.includes('持ち主') && !l.startsWith('- '));
      expect(ownerText(after.text)).toEqual(ownerText(peek.text));
      expect(ownerText(after.text)).toContain('持ち主から（新しい）: 地下3階で帰る');
      // 持ち主が遠征を始めた直後の、最初の迷宮の中の応答に、伝言がもう 1 回（前の応答で読んだ伝言は「持ち主から」）
      expect(errCode(await rec.session.submit(pid, { type: 'start_expedition', offer: 1 }, { source: 'owner' }))).toBe('ok');
      const d = port2.observeWithTurn('turn_arrived');
      expect(d.turn.state).toBe('your_turn');
      const own = ownerLines(d.turn);
      expect(own[0]).toMatch(/^持ち主が、遠征 1 を始めた: /);
      expect(own).toContain('持ち主から: 地下3階で帰る');
      expect(own.some((x) => x.startsWith('持ち主が、伝言を書いた'))).toBe(false);
      expect(d.text).toContain('持ち主から: 地下3階で帰る');
      // 次の応答には出ない
      expect(ownerLines(port2.observeWithTurn('observed').turn)).toEqual([]);
      rec.session.close();
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a message rewritten just before the start shows once, in full, as written (not twice)', async () => {
    const m = manager();
    const r = await campRun(m, 's8b-msg-2');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'], message: 'はじめ' }))).toBe('ok');
    r.port.observeWithTurn('observed');
    const long = '深追いはしない。HP が半分を切ったら帰る。'.repeat(5);
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'], message: long }))).toBe('ok');
    expect(errCode(await owner(r, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    const d = r.port.observeWithTurn('turn_arrived');
    const own = ownerLines(d.turn);
    expect(own.filter((x) => x.includes(long))).toEqual([`持ち主が、伝言を書いた: ${long}`]);
    expect(own.indexOf(`持ち主が、伝言を書いた: ${long}`)).toBeGreaterThan(own.findIndex((x) => x.startsWith('持ち主が、遠征 1 を始めた')));
    m.closeAll();
  });
});

describe('S8b の 3: one line sums up the gear the owner settled on', () => {
  it('after the steps, the last gear line says what is worn now (weapon, armor, accessory)', async () => {
    const m = manager();
    const r = await campRun(m, 's8b-gear-1');
    r.port.observeWithTurn('observed');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'loadout'] }))).toBe('ok');
    const armor = r.port.view().inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('ok');
    const mid = r.port.observeWithTurn('observed');
    const eq0 = mid.observation.self.equipment;
    expect(eq0.armor).toBeUndefined();
    expect(ownerLines(mid.turn).at(-1)).toBe(`持ち主が、装備を決めた。今の装備: 武器 ${eq0.weapon ?? 'なし'}・防具 なし・装飾 なし`);
    expect(errCode(await owner(r, { type: 'equip', slot: armor.slot }))).toBe('ok');
    expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('ok');
    expect(errCode(await owner(r, { type: 'equip', slot: armor.slot }))).toBe('ok');
    const o = r.port.observeWithTurn('observed');
    const eq = o.observation.self.equipment;
    expect(eq.armor).toBeTruthy();
    const own = ownerLines(o.turn);
    // 途中の経過は 3 行まで（ここでは 3 行）、まとめが最後
    expect(own.filter((x) => x.startsWith('持ち主が、装備を変えた:'))).toHaveLength(3);
    expect(own.at(-1)).toBe(`持ち主が、装備を決めた。今の装備: 武器 ${eq.weapon ?? 'なし'}・防具 ${eq.armor}・装飾 なし`);
    m.closeAll();
  });
});

describe('S8b の 4: a camp whose season budget is used up (or past its end) does not wait for the owner', () => {
  it('no waiting line, the ending text agrees with the body, and wait_for_turn returns at once', async () => {
    const m = manager();
    m.seasons.store.open({ id: SID, name: 'S8b試し', seed: 's8b-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 30, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const inv = m.seasons.invite(SID, 'T', m.profiles.store);
    if ('error' in inv) throw new Error(inv.error);
    const r = await m.createRun({ name: 'T', controller: agent, season: SID, profileToken: inv.token! });
    if ('error' in r) throw new Error(r.error.message);
    const w: World = r.session.world;
    expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    // 待っている間に倒されないよう HP を大きくする（記録に残らない書き換え。再生は見ないテスト）
    const pe = structuredClone(w.entities[w.players[r.playerId].entityId]);
    pe.stats!.maxHp = 999; pe.stats!.hp = 999; pe.base!.maxHp = 999;
    applyEvent(w, { type: 'thought', player: r.playerId, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [pe] } as unknown as GameEvent);
    for (let i = 0; i < 80 && r.port.view().status !== 'at_camp'; i++) {
      const left = seasonBudgetLeft(w, r.playerId)!;
      await act(r.port, left > 4 ? { type: 'wait' } : { type: 'wait', turns: 10 });
    }
    expect(r.port.view().status).toBe('at_camp');
    expect(seasonBudgetLeft(w, r.playerId)).toBeLessThanOrEqual(0);
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective'], message: 'おつかれ' }))).toBe('ok');
    const o = r.port.observeWithTurn('observed');
    const last = o.text.split('\n').at(-1)!;
    expect(last).toBe('▶ キャンプにいます（遠征は終了済み）。このシーズンの行動予算を使い切ったので、新しい遠征は始められない。ここで終えてかまいません。');
    expect(o.text).toContain('このシーズンの行動予算を使い切った。新しい遠征は始められない（報告と引退はできる。ここで終えてよい）');
    expect(o.text).not.toContain('持ち主が始めたら');
    expect(o.observation.valid_actions.some((l) => l.startsWith('wait_for_turn'))).toBe(false);
    expect(o.turn.owner_wait).toBeUndefined();
    // 時間切れのシーズンも同じ（終わりの時刻を過ぎた）
    const v = projectPlayerView(w, r.playerId);
    const ended = { ...v, season: { ...v.season!, budgetLeft: 10, ended: true } };
    expect(turnLine(ended, buildTurnBlock(ended, { reason: 'wait_timeout', changes: [], waitedMs: 20000 }))).toBe('▶ キャンプにいます（遠征は終了済み）。シーズンは終わりの時刻を過ぎたので、新しい遠征は始められない。ここで終えてかまいません。');
    expect(turnLine(ended, buildTurnBlock(ended, { reason: 'action_completed', changes: [], expeditionEndedNow: true }))).not.toContain('持ち主');
    // wait_for_turn は、すぐ返す（持ち主を待たない）
    const { client, call } = await mcp(m);
    const t0 = Date.now();
    const res = await call('wait_for_turn', { player_token: r.token, timeout_s: 20 });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.structuredContent.turn.reason).not.toBe('wait_timeout');
    expect(res.content[0].text).not.toContain('持ち主が始めたら');
    await client.close();
    m.closeAll();
  });
});

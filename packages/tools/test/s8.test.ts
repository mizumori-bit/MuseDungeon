// S8（SEASON.md §54。指図 H1）のテスト: 持ち主の口・set_directive・held_by_owner・キャンプでの付け替え・保留の特技・
// プレイヤーへの見え方（観測の行・「できること」・伝言・「変化」・wait_for_turn）・順位の印・再生と起動し直し・トークンの漏れ
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, createMcpServer, loadConfig, RunSession, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { rulesText } from '../../server/src/mcp/rules';
import { applyEvent, buildObservation, EVENT_VERSION, projectPlayerView } from '@muse/shared';
import type { Command, CommandRecord, Entity, GameEvent, OwnerRunsResponse, OwnerViewResponse, World } from '@muse/shared';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir, waitOthersMs: 100 } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
async function campRun(m: SessionManager, seed: string, controller: { kind: 'agent' | 'human' | 'unknown'; label: string } = agent, mode: 'solo' | 'coop' = 'solo') {
  const r = await m.createRun({ name: 'Ow', seed, controller, mode });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof campRun>>;
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const owner = (r: Run, cmd: Command) => r.session.submit(r.playerId, cmd, { source: 'owner' });
const errCode = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? 'ok' : x.error!.code);
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
/** 特技の候補を足す（記録の外。再生しないテストだけ） */
function offerPerks(r: Run): string[] {
  const opts = Object.entries(catalog.perks).filter(([id, p]) => p.lineage === 'common' && !p.requires.length && !meOf(r.session.world, r.playerId).build?.perks.includes(id)).slice(0, 2).map(([id]) => id);
  const e = structuredClone(meOf(r.session.world, r.playerId));
  e.build = { ...e.build!, pending: [{ level: 2, options: opts }] };
  inject(r.session.world, { put: [e] });
  return opts;
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

describe('S8 §54.9: with nothing held, nothing changes (the default)', () => {
  it('no directive line, the offers and camp_choice stay, a camp equip is still at_camp, set_directive from the player is refused with no events', async () => {
    expect(ENGINE_VERSION).toBe('0.48.0');
    expect(EVENT_VERSION).toBe(36);
    const m = manager();
    const r = await campRun(m, 's8-none-1');
    const v = r.port.view();
    expect(v.status).toBe('at_camp');
    expect(v.directive).toBeUndefined();
    const o = r.port.observeWithTurn('observed');
    expect(o.observation.self.directive).toBeUndefined();
    expect(o.text).not.toContain('指図');
    expect(o.observation.valid_actions.some((l) => l.startsWith('start_expedition 1'))).toBe(true);
    expect(o.observation.valid_actions.some((l) => l.startsWith('wait_for_turn'))).toBe(false);
    expect(o.turn.awaiting).toBe('camp_choice');
    const armor = v.inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await act(r.port, { type: 'unequip', slot: armor.slot }))).toBe('at_camp');
    const seq = r.session.world.seq;
    for (const source of ['mcp', 'ws', 'bot'] as const) {
      const x = await r.session.submit(r.playerId, { type: 'set_directive', hold: ['objective'] }, { source });
      expect(errCode(x)).toBe('bad_request');
    }
    expect(r.session.world.seq).toBe(seq);
    expect(r.session.world.players[r.playerId].directive).toBeUndefined();
    // 持ち主の口から、握っていない項目の命令は通らない
    expect(errCode(await owner(r, { type: 'start_expedition', offer: 1 }))).toBe('bad_request');
    expect(errCode(await owner(r, { type: 'explore' }))).toBe('bad_request');
    expect(errCode(await owner(r, { type: 'report_stairs' }))).toBe('bad_request');
    expect(r.session.world.seq).toBe(seq);
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    m.closeAll();
  });

  it('the rules have the directive topic in Japanese and English', () => {
    expect(rulesText('directive', 'ja', catalog)).toContain('握られた項目の命令は、あなたからは通らない（断りの code は held_by_owner');
    expect(rulesText('directive', 'en', catalog)).toContain('refusal code held_by_owner');
    expect(rulesText('all', 'ja', catalog)).toContain('# 指図（S8');
  });
});

describe('S8 §54.3・§54.4: objective and equipment held by the owner (records, replay and restart)', () => {
  it('the player is refused without turns; the owner changes gear at camp and starts; the player sees the line, the message and the changes; nobody re-gears inside; replay and restart agree', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s8-'));
    try {
      const m = manager(dir);
      const r = await campRun(m, 's8-hold-1');
      const pid = r.playerId;
      const w = () => r.session.world;
      // 迷宮にいないと持ち主しか決められない: まず指図
      expect(errCode(await owner(r, { type: 'set_directive', hold: ['loadout', 'objective', 'objective'], message: '深追いはしない\n無理せず\u0007‮' }))).toBe('ok');
      expect(w().players[pid].directive).toEqual({ hold: ['objective', 'loadout'], message: '深追いはしない 無理せず' });
      expect(errCode(await owner(r, { type: 'set_directive', hold: ['objective', 'loadout'], message: '深追いはしない 無理せず' }))).toBe('nothing_to_do');
      // プレイヤーの口: 握られた項目は断る（手番を使わない・World を変えない）
      const seq0 = w().seq;
      const refused = await act(r.port, { type: 'start_expedition', offer: 1 });
      expect(errCode(refused)).toBe('held_by_owner');
      if (!refused.ok) {
        expect(refused.error.message).toContain('持ち主がキャンプで決める');
        expect(refused.error.hint).toContain('wait_for_turn');
        expect(refused.valid_actions.some((l) => l.startsWith('start_expedition'))).toBe(false);
        expect(refused.valid_actions.some((l) => l.startsWith('wait_for_turn（待つ: 持ち主が、次の遠征を決める'))).toBe(true);
      }
      expect(errCode(await act(r.port, { type: 'start_expedition', offer: 'endless' }))).toBe('held_by_owner');
      const armor = r.port.view().inventory.find((i) => i.equipped === 'armor')!;
      expect(errCode(await act(r.port, { type: 'unequip', slot: armor.slot }))).toBe('held_by_owner');
      expect(w().seq).toBe(seq0);
      // 観測の行・「できること」・伝言（区切りの段の前）・待ち方
      const o = r.port.observeWithTurn('observed');
      expect(o.observation.self.directive?.text).toBe('指図: 目的と装備は、持ち主がキャンプで決める（迷宮で手に入れた装備は、キャンプで確かめるまで身に着けない。あなたの start_expedition・equip・unequip は断られる）。特技と加護は、あなたが決める');
      expect(o.observation.self.directive?.message).toBe('深追いはしない 無理せず');
      expect(o.text).toContain('持ち主が、この中から決める（指図。あなたの start_expedition は断られる）');
      const iMsg = o.text.indexOf('持ち主から: 深追いはしない 無理せず');
      expect(iMsg).toBeGreaterThan(o.text.indexOf('できること: '));
      expect(iMsg).toBeLessThan(o.text.indexOf('区切り: '));
      expect(o.observation.valid_actions.some((l) => /^(start_expedition|equip|unequip)\b/.test(l))).toBe(false);
      expect(o.turn.awaiting).toBe('nothing');
      expect(o.text).toContain('次の遠征は持ち主が決めます。wait_for_turn で');
      // 持ち主: キャンプで付け替える（盤面にいないので手番は無い）
      const seqA = w().seq;
      expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('ok');
      const evs = r.session.history.filter((e) => e.seq > seqA);
      const ue = evs.find((e) => e.type === 'item_unequipped')!;
      expect(ue.floor).toBeNull();
      expect(evs.some((e) => e.type === 'actor_scheduled')).toBe(false);
      expect(w().players[pid].ownerDecided).toEqual(['loadout']);
      expect(errCode(await owner(r, { type: 'equip', slot: armor.slot }))).toBe('ok');
      // 持ち主が遠征を始めるまで待つ（wait_for_turn の中身）。時間が来たら timeout
      expect(await r.port.waitForOwner(30)).toBe('timeout');
      const waiting = r.port.waitForOwner(5000);
      expect(errCode(await owner(r, { type: 'start_expedition', offer: 1 }))).toBe('ok');
      expect(await waiting).toBe('started');
      expect(w().players[pid].ownerDecided).toEqual(['objective', 'loadout']);
      // 持ち主が決めた後の最初の応答の「変化」: 付け替え・遠征の開始・伝言をもう 1 回
      const o2 = r.port.observeWithTurn('turn_arrived');
      const own = o2.turn.changes.filter((c) => c.code === 'owner').map((c) => c.text);
      expect(own.some((x) => x.startsWith('持ち主が、装備を変えた:') && x.endsWith('を外した'))).toBe(true);
      expect(own.some((x) => x.startsWith('持ち主が、装備を変えた:') && x.endsWith('を装備'))).toBe(true);
      expect(own.some((x) => x.startsWith('持ち主が、遠征 1 を始めた: '))).toBe(true);
      expect(own).toContain('持ち主から: 深追いはしない 無理せず');
      expect(o2.turn.changes[0].code).toBe('owner');
      // 迷宮の中: 指図の行（装備はだれも付け替えられない）。持ち主の口は not_at_camp、プレイヤーは held_by_owner（装備中の品を捨てるのも）
      expect(o2.observation.self.directive?.text).toContain('迷宮で手に入れた装備は、キャンプで確かめるまで身に着けない');
      expect(o2.observation.self.directive?.message).toBeUndefined();
      expect(o2.observation.valid_actions.some((l) => /^(equip|unequip)\b/.test(l))).toBe(false);
      const seqB = w().seq;
      expect(errCode(await owner(r, { type: 'set_directive', hold: [] }))).toBe('not_at_camp');
      expect(errCode(await owner(r, { type: 'unequip', slot: armor.slot }))).toBe('not_at_camp');
      expect(errCode(await act(r.port, { type: 'unequip', slot: armor.slot }))).toBe('held_by_owner');
      expect(errCode(await act(r.port, { type: 'drop', slot: armor.slot }))).toBe('held_by_owner');
      expect(w().seq).toBe(seqB);
      // 帰る（迷宮の中はプレイヤーが決める）。振り返りに、持ち主が決めた項目の 1 行
      await lifelineHome(r);
      expect(r.port.review().text).toContain('指図: 目的と装備は、持ち主が決めた');
      expect(r.port.report(1)?.owner).toEqual(['objective', 'loadout']);
      // 記録: 持ち主の命令は source: owner。プレイヤーの呼び出しに数えない
      const recs = readFileSync(join(dir, r.session.runId, 'commands.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as CommandRecord);
      const ownRecs = recs.filter((x) => x.source === 'owner');
      expect(ownRecs.map((x) => x.command.type)).toEqual(['set_directive', 'unequip', 'equip', 'start_expedition']);
      expect(r.port.report(1)?.tempo.tool_calls).toBe(recs.filter((x) => x.source === 'bot' && x.player === pid && x.resultSeq).length);
      // 起動し直した前後で同じ観測（再生は記録だけで一致）
      const before = JSON.stringify(buildObservation(projectPlayerView(w(), pid), catalog, { detail: 'full', map: false }));
      const runId = r.session.runId;
      m.closeAll();
      const m2 = manager(dir);
      const rec = RunSession.recover(m2.deps, runId);
      expect(rec.verified).toBe(true);
      expect(JSON.stringify(buildObservation(projectPlayerView(rec.session.world, pid), catalog, { detail: 'full', map: false }))).toBe(before);
      expect(rec.session.world.players[pid].directive?.hold).toEqual(['objective', 'loadout']);
      // 起動し直した後も、握られた項目は断られる
      const seqR = rec.session.world.seq;
      expect(errCode(await rec.session.submit(pid, { type: 'start_expedition', offer: 1 }, { source: 'mcp' }))).toBe('held_by_owner');
      expect(rec.session.world.seq).toBe(seqR);
      rec.session.close();
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S8 §54.3: perks and boons held — offers wait until the owner picks at camp', () => {
  it('the player is refused in the dungeon and at camp; the alert says the owner picks; the owner picks at camp only', async () => {
    const m = manager();
    const r = await campRun(m, 's8-perks-1');
    expect(errCode(await owner(r, { type: 'set_directive', hold: ['perks'] }))).toBe('ok');
    expect(errCode(await act(r.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    const opts = offerPerks(r);
    const seq = r.session.world.seq;
    expect(errCode(await act(r.port, { type: 'choose_perk', option: 1 }))).toBe('held_by_owner');
    expect(errCode(await owner(r, { type: 'choose_perk', option: 1 }))).toBe('not_at_camp');
    expect(r.session.world.seq).toBe(seq);
    const o = r.port.observeWithTurn('observed').observation;
    expect(o.alerts.find((a) => a.code === 'perk_pending')?.text).toContain('覚えられる特技が増えた（Lv2）');
    expect(o.valid_actions.some((l) => l.startsWith('choose_perk'))).toBe(false);
    expect(o.self.directive?.text).toContain('遠征の間に強くなって覚えられることが増えても、身につけるのはキャンプに戻ってから');
    expect(o.alerts.find((a) => a.code === 'perk_pending')?.text).toContain('身につけるのは、キャンプに戻ってから（持ち主が選ぶ');
    expect(JSON.stringify(o)).not.toContain('鑑定');
    // 選ぶまで、進行は止まらない（候補は残る）
    expect(errCode(await act(r.port, { type: 'wait' }))).toBe('ok');
    expect(meOf(r.session.world, r.playerId).build?.pending[0]?.options).toEqual(opts);
    await lifelineHome(r);
    expect(errCode(await act(r.port, { type: 'choose_perk', option: 1 }))).toBe('held_by_owner');
    expect(errCode(await owner(r, { type: 'choose_perk', option: 2 }))).toBe('ok');
    expect(meOf(r.session.world, r.playerId).build?.perks.includes(opts[1])).toBe(true);
    expect(r.session.world.players[r.playerId].ownerDecided).toEqual(['perks']);
    const ch = r.port.observeWithTurn('observed').turn.changes.filter((c) => c.code === 'owner').map((c) => c.text);
    expect(ch.some((x) => x.startsWith('持ち主が、特技を選んだ: '))).toBe(true);
    m.closeAll();
  });
});

describe('S8 §54.1: no directive for runs played by a human, or in co-op', () => {
  it('set_directive is refused for a human run and a co-op run', async () => {
    const m = manager();
    const h = await campRun(m, 's8-human-1', { kind: 'human', label: 'browser' });
    expect(errCode(await owner(h, { type: 'set_directive', hold: ['objective'] }))).toBe('bad_request');
    const c = await campRun(m, 's8-coop-1', agent, 'coop');
    expect(errCode(await owner(c, { type: 'set_directive', hold: ['objective'] }))).toBe('bad_request');
    m.closeAll();
  });
});

describe('S8 §54.4 の 5: wait_for_turn at camp waits for the owner to start (MCP)', () => {
  it('returns when the owner starts, with the changes; times out with the camp observation otherwise', async () => {
    const m = manager();
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 's8', version: '0' });
    await client.connect(y);
    const nr = (await client.callTool({ name: 'new_run', arguments: { character_name: 'Mw' } })) as unknown as { structuredContent: { run_id: string; player_token: string; player_id: string } };
    const { run_id, player_token, player_id } = nr.structuredContent;
    const s = m.get(run_id)!;
    expect(errCode(await s.submit(player_id, { type: 'set_directive', hold: ['objective'], message: '静かに' }, { source: 'owner' }))).toBe('ok');
    const t0 = (await client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 1 } })) as unknown as { structuredContent: { turn: { reason: string; state: string } }; content: { text: string }[] };
    expect(t0.structuredContent.turn.reason).toBe('wait_timeout');
    expect(t0.structuredContent.turn.state).toBe('at_camp');
    expect(t0.content[0].text).toContain('持ち主から: 静かに');
    const pending = client.callTool({ name: 'wait_for_turn', arguments: { player_token, timeout_s: 20 } }) as unknown as Promise<{ structuredContent: { turn: { reason: string; changes: { code: string; text: string }[] } } }>;
    await new Promise((res) => setTimeout(res, 50));
    expect(errCode(await s.submit(player_id, { type: 'start_expedition', offer: 1 }, { source: 'owner' }))).toBe('ok');
    const t1 = await pending;
    expect(t1.structuredContent.turn.reason).toBe('turn_arrived');
    expect(t1.structuredContent.turn.changes.some((c) => c.code === 'owner' && c.text.startsWith('持ち主が、遠征 1 を始めた'))).toBe(true);
    expect(t1.structuredContent.turn.changes.some((c) => c.text === '持ち主から: 静かに')).toBe(true);
    // 握られた start_expedition の MCP の断り
    await client.close();
    m.closeAll();
  });
});

describe('S8 §54.1・§54.8: the owner endpoint (HTTP) — who may use it, and no token leaks', () => {
  it('local or the player\'s profile token only; never via ?token=; tokens appear in no response, log or record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s8h-'));
    const logged: string[] = [];
    const spy = [vi.spyOn(console, 'log').mockImplementation((...a) => { logged.push(a.join(' ')); }), vi.spyOn(console, 'error').mockImplementation((...a) => { logged.push(a.join(' ')); })];
    try {
      const m = manager(dir);
      const r = await campRun(m, 's8-http-1');
      const ptok = r.profile.token!;
      const other = await campRun(m, 's8-http-2');
      const otok = other.profile.token!;
      expect(ptok && otok && ptok !== otok).toBeTruthy();
      const app = createApp(m, m.config);
      await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const ext = { 'x-forwarded-for': '203.0.113.9' };
      const bodies: string[] = [];
      const call = async (path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
        const res = await fetch(base + path, { method: o.method ?? 'GET', headers: { 'content-type': 'application/json', ...(o.headers ?? {}) }, ...(o.body ? { body: JSON.stringify(o.body) } : {}) });
        const text = await res.text();
        bodies.push(text);
        return { status: res.status, json: JSON.parse(text) as Record<string, unknown> };
      };
      // 一覧: 同じ機械からはすべて、外からはトークンの持ち主のランだけ
      expect(((await call('/api/owner/runs')).json as unknown as OwnerRunsResponse).runs.map((x) => x.runId).sort()).toEqual([r.session.runId, other.session.runId].sort());
      expect(((await call('/api/owner/runs', { headers: ext })).json as unknown as OwnerRunsResponse).runs).toEqual([]);
      const mine = (await call('/api/owner/runs', { headers: { ...ext, authorization: `Bearer ${ptok}` } })).json as unknown as OwnerRunsResponse;
      expect(mine.runs.map((x) => x.runId)).toEqual([r.session.runId]);
      expect(mine.runs[0].eligible && !mine.runs[0].waiting && mine.runs[0].status === 'at_camp').toBe(true);
      const v = `/api/runs/${r.session.runId}/owner`;
      // 認められない者: 外から・違うトークン・URL のトークン
      expect((await call(`${v}/view`, { headers: ext })).status).toBe(403);
      expect((await call(`${v}/view`, { headers: { ...ext, authorization: `Bearer ${otok}` } })).status).toBe(403);
      expect((await call(`${v}/view?token=${encodeURIComponent(ptok)}`, { headers: ext })).status).toBe(403);
      expect((await call(`${v}/directive`, { method: 'POST', headers: ext, body: { hold: ['objective'], profileToken: otok } })).status).toBe(403);
      expect(r.session.world.players[r.playerId].directive).toBeUndefined();
      // 持ち主: 見出しのトークンで見る・本文のトークンで指図・握った項目の命令
      const view = (await call(`${v}/view`, { headers: { ...ext, authorization: `Bearer ${ptok}` } })).json as unknown as OwnerViewResponse;
      expect(view.playerId).toBe(r.playerId);
      expect(view.observation.camp?.offers.length).toBeGreaterThan(0);
      expect(view.text).toContain('次の遠征の候補');
      const d = (await call(`${v}/directive`, { method: 'POST', headers: ext, body: { hold: ['objective'], message: 'まず地下2階', profileToken: ptok } })).json as unknown as OwnerViewResponse;
      expect(d.result).toEqual({ ok: true });
      expect(d.waiting).toBe(true);
      expect(d.view.directive).toEqual({ hold: ['objective'], message: 'まず地下2階', decided: [] });
      const bad = (await call(`${v}/act`, { method: 'POST', headers: { ...ext, authorization: `Bearer ${ptok}` }, body: { command: { type: 'explore' } } })).json as unknown as OwnerViewResponse;
      expect(bad.result?.ok).toBe(false);
      const start = (await call(`${v}/act`, { method: 'POST', headers: { ...ext, authorization: `Bearer ${ptok}` }, body: { command: { type: 'start_expedition', offer: 1 } } })).json as unknown as OwnerViewResponse;
      expect(start.result).toEqual({ ok: true });
      expect(start.view.status).toBe('your_turn');
      const late = (await call(`${v}/directive`, { method: 'POST', headers: { authorization: `Bearer ${ptok}` }, body: { hold: [] } })).json as unknown as OwnerViewResponse;
      expect(late.result?.ok === false && late.result.error.code).toBe('not_at_camp');
      // 持ち主の口は MCP のツールに無い
      const { tools } = await (async () => { const [x, y] = InMemoryTransport.createLinkedPair(); const sv = createMcpServer({ manager: m, boundToken: null, briefMap: true, clientLabel: 'test' }); await sv.connect(x); const c = new Client({ name: 's8l', version: '0' }); await c.connect(y); const l = await c.listTools(); await c.close(); return l; })();
      expect(tools.some((t) => /directive|owner/.test(t.name))).toBe(false);
      await new Promise<void>((res) => app.server.close(() => res()));
      m.closeAll();
      // 漏れ: プロフィールのトークンとプレイヤーのトークンが、応答・ログ・記録（ランと、プロフィール）に出ない
      const playerToks = Object.keys(JSON.parse(readFileSync(join(dir, r.session.runId, 'tokens.json'), 'utf8')));
      for (const tok of [ptok, otok, ...playerToks]) {
        for (const b of bodies) expect(b.includes(tok)).toBe(false);
        for (const l of logged) expect(l.includes(tok)).toBe(false);
      }
      for (const f of filesUnder(dir)) {
        if (f.endsWith('tokens.json')) continue;
        const txt = readFileSync(f, 'utf8');
        for (const tok of [ptok, otok, ...playerToks]) expect(txt.includes(tok)).toBe(false);
      }
      expect(readFileSync(join(dir, r.session.runId, 'events.jsonl'), 'utf8')).toContain('"directive_set"');
    } finally {
      for (const s of spy) s.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S8 §54.6・§54.8: other participants never get directives or messages; the standings mark updates at camp', () => {
  it('only the decided items are a mark in the standings (not merely held); B\'s world has no trace of A\'s directive', async () => {
    const m = manager();
    m.seasons.store.open({ id: 's8t', name: 'S8試し', seed: 's8-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
    const join1 = async (name: string) => {
      const inv = m.seasons.invite('s8t', name, m.profiles.store);
      if ('error' in inv) throw new Error(inv.error);
      const r = await m.createRun({ name, controller: agent, season: 's8t', profileToken: inv.token! });
      if ('error' in r) throw new Error(r.error.message);
      return r;
    };
    const a = await join1('アカネ');
    const b = await join1('ボタン');
    const rowOf = (name: string) => m.seasons.standings('s8t')!.standings.find((x) => x.name === name)!;
    expect(errCode(await a.session.submit(a.playerId, { type: 'set_directive', hold: ['loadout', 'objective'], message: 'ひみつの伝言' }, { source: 'owner' }))).toBe('ok');
    // 握っただけでは、印は付かない
    expect(rowOf('アカネ').directed).toBeUndefined();
    const armor = a.port.view().inventory.find((i) => i.equipped === 'armor')!;
    expect(errCode(await a.session.submit(a.playerId, { type: 'unequip', slot: armor.slot }, { source: 'owner' }))).toBe('ok');
    // キャンプで決めた: 印が付く（順位は分けない）
    expect(rowOf('アカネ').directed).toEqual(['loadout']);
    expect(rowOf('ボタン').directed).toBeUndefined();
    // 目的を握られた参加者の start_expedition は、取り込みを記録する前に断る
    const seqA = a.session.world.seq;
    expect(errCode(await act(a.port, { type: 'start_expedition', offer: 1 }))).toBe('held_by_owner');
    expect(a.session.world.seq).toBe(seqA);
    expect(errCode(await a.session.submit(a.playerId, { type: 'start_expedition', offer: 1 }, { source: 'owner' }))).toBe('ok');
    expect(rowOf('アカネ').directed).toEqual(['loadout']);
    // B は遠征を始め、帰って取り込む
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    await lifelineHome(b);
    await lifelineHome(a);
    expect(rowOf('アカネ').directed).toEqual(['objective', 'loadout']);
    expect(errCode(await act(b.port, { type: 'start_expedition', offer: 1 }))).toBe('ok');
    const bw = JSON.stringify(b.session.world);
    expect(bw.includes('ひみつの伝言')).toBe(false);
    expect(bw.includes('directive')).toBe(false);
    expect(b.port.view().directive).toBeUndefined();
    expect(JSON.stringify(m.seasons.standings('s8t'))).not.toContain('ひみつの伝言');
    m.closeAll();
  });
});

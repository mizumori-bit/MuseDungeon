// V4-1m（IMPROVEMENTS_V4 §37）の確認。サーバー: 長いランの復旧・復旧に失敗したランを見えるように（§37.1）。
// pilot: 不具合 C1〜C6（party_down は 1 回・返事待ちに safety を重ねない・特技の重複・殴ってきた隣の敵と戦う・HP で断られる fight を出さない）と party_apart（§37.5）
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Entity, GameEvent, ObsMonster, ObsPartyMember, Observation } from '@muse/shared';
import { applyEvent, hitsText } from '@muse/shared';
import { createApp, createMcpServer, loadConfig, rulesText, SessionManager } from '@muse/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decide, defaultOrders, fightRefusal, newMemory, PARTY_APART_TURNS, runPilot } from '../src/index';
import type { DecideContext, PilotOrders, WakeEvent } from '../src/index';

const content = loadContent();
const catalog = buildCatalog(content);
const FULL = process.env.MUSE_FULL === '1' || (import.meta as { env?: { MODE?: string } }).env?.MODE === 'full';
/**
 * サーバーの起動時と同じ recoverAll を、別のプロセス（既定のスタックの大きさ）で動かす。vitest の worker はスタックが大きく、
 * 本番で落ちた push(...) の溢れが、この中では起きない（直す前のコードでも通ってしまった）
 */
function recoverInChild(runsDir: string): { logs: string[]; runs: { runId: string; live: boolean; recoveryFailed: { reason: string } | null; history: number | null }[]; ms: number } {
  const child = fileURLToPath(new URL('./recover-child.ts', import.meta.url));
  const r = spawnSync(process.execPath, ['--import', 'tsx', child, runsDir], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`recover-child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** runsDir に、実際に遊んだ短いランを作る（敵を消して、HP を 1 にして休むのを rests 回くり返す。記録はサーバーと同じに書かれる） */
async function playedRun(runsDir: string, seed: string, rests: number) {
  const m = new SessionManager(content, loadConfig({ runsDir, profilesDir: null, waitOthersMs: 100 }));
  const r = await m.createRun({ name: 'L', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: 'auto' });
  if ('error' in r) throw new Error(r.error.message);
  const w = r.session.world;
  const pid = r.port.playerId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  for (let i = 0; i < rests; i++) {
    const me = structuredClone(w.entities[w.players[pid]!.entityId]!);
    me.stats!.hp = 1;
    inject({ put: [me], del: Object.values(w.entities).filter((e) => e.actor && !e.player && e.pos?.floor === me.pos!.floor).map((e) => e.id) });
    // 記録に無い書き換えなので、キーフレームを書いて、復旧の再実行がここから始まるようにする（記録の再生と食い違わない）
    (r.session as unknown as { writeKeyframe(): void }).writeKeyframe();
    expect((await r.port.act({ type: 'rest' }, { source: 'bot' })).ok).toBe(true);
  }
  // 最後に 1 手（キーフレームの後に再実行する命令を残す）
  await r.port.act({ type: 'wait' }, { source: 'bot' });
  const runId = r.session.runId;
  const token = r.token;
  const seq = w.seq;
  m.closeAll();
  return { runId, token, seq };
}

async function mcpOf(manager: SessionManager) {
  const [x, y] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ manager, boundToken: null, briefMap: true, clientLabel: 'test' });
  await server.connect(x);
  const client = new Client({ name: 'v41m', version: '0' });
  await client.connect(y);
  return async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean };
}

describe('V4-1m §37.1: 長いランの復旧・復旧に失敗したランを見えるように（サーバー）', () => {
  it('a run whose log holds more events than push(...) can take (200k+) recovers, and the same token resumes it (resume_run, act)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41m-'));
    const run = await playedRun(dir, 'v41m-long', 3);
    // 記録を、本番の失敗（run_e3300b7ac8: 出来事 178,030 件）より大きくする: キーフレームより前の出来事を、20 万件を超えるまで繰り返して足す
    // （復旧は、最後のキーフレームより前の出来事を履歴に積む。そこで push(...) の引数の上限を超えて落ちていた）
    const evPath = join(dir, run.runId, 'events.jsonl');
    const kf = Math.max(...readdirSync(join(dir, run.runId, 'keyframes')).map((f) => parseInt(f, 10)));
    const before = readFileSync(evPath, 'utf8').split('\n').filter((l) => l && (JSON.parse(l) as GameEvent).seq <= kf);
    const lines: string[] = [];
    while (lines.length < 210_000) lines.push(...before);
    const all = readFileSync(evPath, 'utf8');
    writeFileSync(evPath, lines.join('\n') + '\n' + all);
    // サーバーと同じ大きさのスタックで復旧する（直す前は、ここで「Maximum call stack size exceeded」になった）
    const c = recoverInChild(dir);
    expect(c.logs.some((s) => s.startsWith('failed'))).toBe(false);
    expect(c.logs[0]).toContain(`recovered ${run.runId}`);
    expect(c.logs[0]).toContain('hash ok');
    expect(c.runs.find((x) => x.runId === run.runId)?.history).toBeGreaterThan(210_000);
    // 同じトークンで再開できる（このプロセスでも復旧して、MCP の resume_run と行動）
    const m = new SessionManager(content, loadConfig({ runsDir: dir, profilesDir: null, waitOthersMs: 100 }));
    const logs: string[] = [];
    m.recoverAll((s) => logs.push(s));
    expect(m.listRuns().find((x) => x.runId === run.runId)).toMatchObject({ live: true });
    expect(m.listRuns().find((x) => x.runId === run.runId)?.recoveryFailed).toBeUndefined();
    const call = await mcpOf(m);
    const res = await call('resume_run', { player_token: run.token });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent?.run_id).toBe(run.runId);
    expect(logs[0]).toContain('hash ok');
    expect((await m.portForToken(run.token)!.act({ type: 'wait' }, { source: 'bot' })).ok).toBe(true);
    m.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it.skipIf(!FULL)('full: a genuinely long run (7,000+ turns, 178k+ events) recovers with the hash verified, and resumes (time is logged)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41m-full-'));
    const run = await playedRun(dir, 'v41m-full', 1100);
    expect(run.seq).toBeGreaterThan(178_030);
    const c = recoverInChild(dir);
    console.log(`[v41m] recovered ${run.seq} events in ${c.ms} ms (child process): ${c.logs[0]}`);
    expect(c.logs[0]).toContain('hash ok');
    const m = new SessionManager(content, loadConfig({ runsDir: dir, profilesDir: null, waitOthersMs: 100 }));
    m.recoverAll(() => undefined);
    const s = m.get(run.runId)!;
    const turns = s.world.entities[s.world.players[s.world.playerOrder[0]!]!.entityId]!.actor!.turns;
    console.log(`[v41m] turns ${turns}`);
    expect(turns).toBeGreaterThan(7044);
    expect((await m.portForToken(run.token)!.act({ type: 'wait' }, { source: 'bot' })).ok).toBe(true);
    m.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }, 600_000);

  it('a run that fails to recover shows in the run list with the reason; its token gets recovery_failed (MCP, feed, join) instead of "not found"', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41m-fail-'));
    const run = await playedRun(dir, 'v41m-fail', 1);
    // キーフレームを壊す（復旧が例外で落ちる）
    for (const f of readdirSync(join(dir, run.runId, 'keyframes'))) writeFileSync(join(dir, run.runId, 'keyframes', f), '{ broken');
    const m = new SessionManager(content, loadConfig({ runsDir: dir, profilesDir: null, waitOthersMs: 100 }));
    const logs: string[] = [];
    m.recoverAll((s) => logs.push(s));
    expect(logs.some((s) => s.startsWith(`failed to recover ${run.runId}`))).toBe(true);
    const row = m.listRuns().find((x) => x.runId === run.runId)!;
    expect(row.live).toBe(false);
    expect(row.joinable).toBe(false);
    expect(row.recoveryFailed?.reason).toMatch(/JSON|Unexpected|Expected/);
    expect(m.portForToken(run.token)).toBeNull();
    // MCP: resume_run と、トークンを使うツール
    const call = await mcpOf(m);
    const res = await call('resume_run', { player_token: run.token });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.structuredContent ?? res.content)).toContain('recovery_failed');
    expect(res.content[0]!.text).toContain(`ラン ${run.runId} は、サーバーの起動時に復旧できなかった`);
    const obs = await call('observe', { player_token: run.token });
    expect(JSON.stringify(obs.structuredContent ?? obs.content)).toContain('recovery_failed');
    // 知らないトークンは、今までどおり no_session
    const unknown = await call('resume_run', { player_token: 'tok_nope' });
    expect(JSON.stringify(unknown.structuredContent ?? unknown.content)).toContain('no_session');
    // 参加
    const j = await m.joinRun(run.runId, { name: 'X', controller: { kind: 'agent', label: 'x' } });
    expect('error' in j && j.error.code).toBe('recovery_failed');
    // HTTP: 一覧・ターンフィード
    const app = createApp(m, loadConfig({ port: 0, runsDir: dir, profilesDir: null }));
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const list = await (await fetch(`${base}/api/runs`)).json() as { runs: { runId: string; recoveryFailed?: { reason: string } }[] };
    expect(list.runs.find((x) => x.runId === run.runId)?.recoveryFailed?.reason).toBeTruthy();
    const feed = await fetch(`${base}/api/player/feed`, { headers: { authorization: `Bearer ${run.token}` } });
    expect(feed.status).toBe(503);
    expect(((await feed.json()) as { error: { code: string } }).error.code).toBe('recovery_failed');
    const feed2 = await fetch(`${base}/api/player/feed`, { headers: { authorization: 'Bearer tok_nope' } });
    expect(feed2.status).toBe(401);
    await new Promise<void>((r) => app.server.close(() => r()));
    m.closeAll();
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('the rules text says what dying costs (everything carried, nothing dropped, the others go on)', () => {
    expect(rulesText('all', 'ja', catalog)).toContain('死ぬと、その者はランから外れ、持ち物（装備・品・帰還の綱）と、その遠征の戦利品をすべて失う');
    expect(rulesText('all', 'en', catalog)).toContain('When you die you leave the run and lose everything you carry');
  });
});

// ---- pilot の判断（観測は最小限の写し） ----
type Over = { monsters?: ObsMonster[]; party?: ObsPartyMember[]; hp?: number; alerts?: Observation['alerts']; frontiers?: number; stairs?: Observation['navigation']['known_stairs']; depth?: number };
function fieldObs(o: Over = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: o.alerts ?? [],
    self: { name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: o.hp ?? 40, max_hp: 40, statuses: [], pos: { x: 20, y: 10 }, floor: { depth: o.depth ?? 3 }, attack: { acc: 5, dmg: '1d6', throws: [] }, defense: { eva: 0, armor: 0 }, recovery: [], inventory: [] },
    visible: { monsters: o.monsters ?? [], items: [], players: [], features: [] },
    party: o.party ?? [],
    navigation: { known_stairs: o.stairs ?? [], frontiers: Array.from({ length: o.frontiers ?? 0 }, () => ({ pos: { x: 1, y: 1 }, dir: 'w', dist: 3 })), collectable: { count: 0, ids: [] } },
    expedition: { no: 6, objective: { type: 'reach_depth', target_depth: 6, text: '目的' }, progress: {}, status: 'in_progress', points: 0, can_extract: false, extract_outcome: 'withdraw', text: '遠征 6', haul: { total: 0, multiplier_pct: 100, parts: {}, if_extract_now: 0, next_overreach: null, next_camp: null, text: '戦利品 0' } },
  } as unknown as Observation;
}
function mon(over: Partial<ObsMonster>): ObsMonster {
  return { id: 'e_aaaaaa', name: '敵', pos: { x: 21, y: 10 }, dir: 'e', dist: 1, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [], ...over } as ObsMonster;
}
const ctx = (orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext => ({ orders, coop: false, waiting: false, acked: new Set(), text: '', ...over });
const summary = (r: ReturnType<typeof decide>) => (r.decision.kind === 'wake' ? `${r.decision.wake.level}:${r.decision.wake.reason}` : r.decision.kind === 'act' ? `act:${r.decision.tool}:${JSON.stringify(r.decision.args)}` : `${r.decision.kind}${r.decision.kind === 'idle' && r.decision.wait ? `:${r.decision.wait}` : ''}`);
const member = (o: Partial<ObsPartyMember>): ObsPartyMember => ({ id: 'p_h', name: 'H', controller: 'agent', order: 1, status: 'in_dungeon', floor: 3, hp: 'healthy', last_act: 0, ...o });
const camp = (party: ObsPartyMember[], alerts: Observation['alerts'] = []) => {
  const o = { ...fieldObs({ alerts }), status: 'at_camp', self: { ...fieldObs().self, pos: null, floor: null }, party, camp: { next_no: 7, offers: [{ index: 1, type: 'slay_guardian', target_depth: 3, points: 100, text: '1', multiplier_pct: 100, recommended_level: 2, level_gap: 0, trait_danger: 0, slot: 'safe' }] } } as unknown as Observation;
  o.expedition = { ...o.expedition!, status: 'ended' };
  return o;
};
const perk = { code: 'perk_pending', level: 'info', text: '特技を選べる', data: { options: ['core:perk_a', 'core:perk_b'] } } as unknown as Observation['alerts'][number];

describe('V4-1m C1・C3: 倒れた仲間 1 人につき、ランを通して party_down は 1 回', () => {
  it('raised once; after the reply the ally is in once (party_down:<id>) and later camps raise camp only (no party_down, no wait_for_join)', () => {
    const down = [member({ status: 'down', floor: undefined, hp: undefined })];
    const r = decide(camp(down), ctx(defaultOrders(), { coop: true }));
    expect(summary(r)).toBe('escalate:party_down');
    // 返事が来た後（pilot.ts が once に party_down:p_h を足す）: 遠征を重ねても、もう上げない。ふだんの camp だけ
    for (const next of [7, 8, 9]) {
      const o = camp(down); o.camp!.next_no = next;
      expect(summary(decide(o, ctx(defaultOrders(), { coop: true, once: new Set(['party_down:p_h']) })))).toBe('wake:camp');
    }
    // 別の仲間が新しく倒れたら、その仲間について 1 回
    const two = [...down, member({ id: 'p_k', name: 'K', status: 'down', floor: undefined, hp: undefined })];
    const r2 = decide(camp(two), ctx(defaultOrders(), { coop: true, once: new Set(['party_down:p_h']) }));
    expect(summary(r2)).toBe('escalate:party_down');
    expect(r2.decision.kind === 'wake' && r2.decision.wake.key).toBe('party_down:camp:p_k');
  });
  it('while waiting for the party_down reply at camp, no camp wake (C3)', () => {
    const down = [member({ status: 'down', floor: undefined, hp: undefined })];
    expect(summary(decide(camp(down), ctx(defaultOrders(), { coop: true, waiting: true })))).toMatch(/^idle/);
  });
});

describe('V4-1m C2: 上げた（escalate）返事を待つ間は「黙って止まる」に数えない', () => {
  it('stalled escalated at camp and 3 minutes of silence: no safety (the reason is already raised)', async () => {
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const manager = new SessionManager(content, config);
    const app = createApp(manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const r = await manager.createRun({ name: 'P', seed: 'v41m-c2', classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' } });
    if ('error' in r) throw new Error(r.error.message);
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41m-c2-'));
    // 直近 3 回の遠征がどれも確定 0（空回り）: キャンプで stalled を上げて（escalate）返事を待つ
    const row = (no: number) => JSON.stringify({ no, slot: 'safe', objective: { type: 'reach_depth', target_depth: 2 }, turns: 30, banked: 0, end: 'withdrawn', last_wake: null });
    writeFileSync(join(dir, 'history.jsonl'), `${[1, 2, 3].map(row).join('\n')}\n`);
    let t = 1_000_000;
    const wakes: WakeEvent[] = [];
    const ac = new AbortController();
    const done = runPilot({ baseUrl: base, token: r.token, dir, pollMs: 20, log: () => {}, signal: ac.signal, now: () => t, onWake: (ev) => { wakes.push(ev); } });
    const t0 = Date.now();
    while (!wakes.some((w) => w.reason === 'stalled') && Date.now() - t0 < 20000) await new Promise((res) => setTimeout(res, 20));
    expect(wakes.find((w) => w.reason === 'stalled')?.level).toBe('escalate');
    t += 3 * 60000;
    await new Promise((res) => setTimeout(res, 500));
    expect(wakes.some((w) => w.reason === 'safety')).toBe(false);
    ac.abort();
    await done;
    manager.closeAll();
    await new Promise<void>((res) => app.server.close(() => res()));
  }, 40000);
});

describe('V4-1m C4: 特技の選択はキャンプでも遠征を選ぶ前に（camp と perk_pending の両方に choose_perk が入らない）', () => {
  it('at camp with a perk pending: perk_pending first (not camp); once answered and chosen, camp', () => {
    const r = decide(camp([], [perk]), ctx());
    expect(summary(r)).toBe('wake:perk_pending');
    const key = r.decision.kind === 'wake' ? r.decision.wake.key : '';
    // 起こして返事を待つ間（迷宮で上げた鍵でも）、キャンプでも鍵は成り立っている: 返事をもらった記録から外れない
    const w = decide(camp([], [perk]), ctx(defaultOrders(), { waiting: true }));
    expect(w.active).toContain(key);
    // 選び終えた: ふだんの camp
    expect(summary(decide(camp([]), ctx()))).toBe('wake:camp');
    // perk: first ならキャンプで選んでから
    const first = defaultOrders(); first.policy.perk = 'first';
    expect(summary(decide(camp([], [perk]), ctx(first)))).toBe('act:choose_perk:{"option":1}');
  });
});

describe('V4-1m C5: 待つ間に殴ってきた隣の敵と戦う', () => {
  it('hitBy set: the next fight is at the hitter (not the old target); gone → forgotten', () => {
    const target = mon({ id: 'e_tgt001', dist: 3, pos: { x: 23, y: 10 } });
    const hitter = mon({ id: 'e_hit001', name: 'ゴブリン', dist: 1 });
    const m = newMemory(); m.hitBy = 'e_hit001';
    const r = decide(fieldObs({ monsters: [target, hitter] }), ctx(defaultOrders(), { mem: m }));
    expect(summary(r)).toMatch(/^act:fight:\{"target":"e_hit001"/);
    // 殴ってきた敵がもう隣にいない: 忘れる（ふだんの行へ）
    const r2 = decide(fieldObs({ monsters: [target] }), ctx(defaultOrders(), { mem: m }));
    expect(r2.update?.hitBy).toBeNull();
  });
});

describe('V4-1m C6: HP で断られる fight は出さない（立て直しの段へ）', () => {
  it('fightRefusal mirrors the macro: hp at/below hp_floor; worst one-turn damage of reaching hunters would drop below hp_floor', () => {
    expect(fightRefusal(fieldObs({ hp: 20 }), 20)).toBe('hp_floor');
    expect(fightRefusal(fieldObs({ hp: 30, monsters: [mon({ worst_turn: 12 })] }), 20)).toBe('hp_risk');
    expect(fightRefusal(fieldObs({ hp: 30, monsters: [mon({ worst_turn: 9 })] }), 20)).toBeNull();
    // 離れていて飛び道具の無い敵・逃げている離れた敵は数えない。飛び道具の敵は離れていても数える
    expect(fightRefusal(fieldObs({ hp: 30, monsters: [mon({ dist: 3, worst_turn: 12 })] }), 20)).toBeNull();
    expect(fightRefusal(fieldObs({ hp: 30, monsters: [mon({ dist: 3, worst_turn: 12, traits: ['ranged'] })] }), 20)).toBe('hp_risk');
    expect(fightRefusal(fieldObs({ hp: 30, monsters: [mon({ dist: 3, worst_turn: 12, fleeing: true })] }), 20)).toBeNull();
  });
  it('a chaser in reach with hp_risk: no fight is sent; the recovery ladder takes over (recovering)', () => {
    // HP 30/40（wake_hp_pct 50 の線 20 より上）、隣で追ってくる敵の 1 手の最悪 12 → 30 - 12 < 20 で fight は断られる
    const o = fieldObs({ hp: 30, monsters: [mon({ worst_turn: 12 })], stairs: [{ type: 'up', pos: { x: 5, y: 10 }, dist: 15, reachable: true, path_len: 15 } as never] });
    const r = decide(o, ctx());
    // 立て直しの段へ（recovering）。出す fight があっても、その hp_floor では断られない（立て直しの 3 は低い線で殴る）
    expect(r.update?.recovering).toBe(true);
    if (r.decision.kind === 'act' && r.decision.tool === 'fight') expect(fightRefusal(o, r.decision.args.hp_floor as number)).toBeNull();
    // 断られない HP なら、いつもどおり fight
    const r2 = decide(fieldObs({ hp: 40, monsters: [mon({ worst_turn: 12 })] }), ctx());
    expect(summary(r2)).toMatch(/^act:fight:/);
  });
});

describe('V4-1m §37.5: party_apart（ついていく相手と別の階のまま 30 手番）', () => {
  it('starts the clock when apart, notifies once after 30 turns (per expedition), and resets if they meet before', () => {
    const lead = member({ id: 'p_h', floor: 5 });
    const following = () => { const m = newMemory(); m.follow = { id: 'p_h', exp: 6, met: true, inDungeon: true, lastPos: null, lastFloor: 5, floorAtStart: 3, startTurn: 0 }; return m; };
    const m = following();
    const r = decide(fieldObs({ party: [lead], frontiers: 1 }), ctx(defaultOrders(), { coop: true, mem: m, turnNo: 100 }));
    expect(r.update?.apart).toEqual({ exp: 6, since: 100, noted: false });
    m.apart = { exp: 6, since: 100, noted: false };
    expect(decide(fieldObs({ party: [lead], frontiers: 1 }), ctx(defaultOrders(), { coop: true, mem: m, turnNo: 100 + PARTY_APART_TURNS - 1 })).notify.some((n) => n.reason === 'party_apart')).toBe(false);
    const r3 = decide(fieldObs({ party: [lead], frontiers: 1 }), ctx(defaultOrders(), { coop: true, mem: m, turnNo: 100 + PARTY_APART_TURNS }));
    const n = r3.notify.find((x) => x.reason === 'party_apart');
    expect(n?.detail).toBe('H は地下 5 階、自分は地下 3 階。30 手番たっても同じ階になれない');
    expect(r3.update?.apart?.noted).toBe(true);
    // 知らせた後は、この遠征ではもう出さない
    m.apart = { exp: 6, since: 100, noted: true };
    expect(decide(fieldObs({ party: [lead], frontiers: 1 }), ctx(defaultOrders(), { coop: true, mem: m, turnNo: 300 })).notify.some((x) => x.reason === 'party_apart')).toBe(false);
    // 知らせる前に同じ階になった: 数え直す
    const m2 = following(); m2.apart = { exp: 6, since: 100, noted: false };
    const r4 = decide(fieldObs({ party: [member({ id: 'p_h', floor: 3, pos: [22, 10] })], frontiers: 1 }), ctx(defaultOrders(), { coop: true, mem: m2, turnNo: 120 }));
    expect(r4.update?.apart).toBeNull();
  });
});

describe('V4-1m §39.1: 命中の記録の文に「この種族」を添える（観測の文・人間の画面・規則の文）', () => {
  it('the hit record text says it is the species record (the guardians of the species for a guardian), in both languages', () => {
    const h = { your_melee: [331, 450] as [number, number], theirs: [3, 5] as [number, number] };
    expect(hitsText('ja', h)).toBe('この種族の記録: あなたの命中 近接331/450・相手の命中 3/5');
    expect(hitsText('ja', h, true)).toBe('この種族の守護者の記録: あなたの命中 近接331/450・相手の命中 3/5');
    expect(hitsText('en', h)).toBe("this species' record: your hits melee 331/450, its hits 3/5");
    expect(hitsText('en', h, true)).toBe("record for this species' guardians: your hits melee 331/450, its hits 3/5");
    expect(hitsText('ja', { your_thrown: [2, 4] })).toBe('この種族の記録: あなたの命中 投擲2/4');
    expect(hitsText('ja', undefined)).toBe('');
    expect(hitsText('ja', {})).toBe('');
    expect(rulesText('all', 'ja', catalog)).toContain('（「この種族の記録: あなたの命中 近接1/6・相手の命中 3/5」。目の前の 1 体の数ではない）');
    expect(rulesText('all', 'en', catalog)).toContain("this species' record: your hits melee 1/6, its hits 3/5");
  });
});

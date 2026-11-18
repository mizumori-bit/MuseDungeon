// V3-7（IMPROVEMENTS_V3 §7・§16.3）の確認: プロフィール（作成・トークン・積み上げ）、継承（種族の知識だけ・legacy:false・
// legacyPolicy・commands.jsonl だけで再実行できる）、記録と図鑑（本人の知識だけ・完成度）、実績（条件・伏せる）、
// records が MCP と HTTP で同じ、トークンがログに出ない。（目標の宣言は V3-8 §53.5 で外した）
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import type { FeatContext, ProfileRun } from '@muse/shared';
import { emptyCodex, evalFeatCond, floorsUnhurt, legacyFrom, memoryCombatText } from '@muse/shared';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { playWithPort, verifyRunDir } from '../src/index';

const content = loadContent();
let runsDir: string;
beforeAll(() => { runsDir = mkdtempSync(join(tmpdir(), 'muse-v37-')); });
afterAll(() => { rmSync(runsDir, { recursive: true, force: true }); });

const agent = { kind: 'agent' as const, label: 't' };

/** 前のランの記録（図鑑の種族）を直接積む */
function priorRun(runId: string, species: ProfileRun['codex']['species'], o: Partial<ProfileRun> = {}): ProfileRun {
  return {
    runId, character: 'Old', classId: 'core:warrior', legacy: false, legacyKinds: 0, startedAt: 1, endedAt: 2, status: 'ended', end: 'died', deathCause: 'core:goblin',
    level: 3, banked: 500, deepest: 3, expeditions: 2, completed: 1, withdrawn: 0, wardens: [], streakMax: 1, best: { depth: 3, banked: 400, margin: 40 },
    codex: { ...emptyCodex(), species }, ...o,
  };
}

describe('V3-7 profiles (§7.1・§16.3)', () => {
  it('new_run creates a profile and returns its token once; the token stacks the next run; an unknown token is refused', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 50 }));
    const a = await m.createRun({ name: 'A', seed: 'v37-p1', controller: agent });
    if ('error' in a) throw new Error(a.error.message);
    expect(a.profile.token).toBeTruthy();
    const b = await m.createRun({ name: 'B', seed: 'v37-p2', controller: agent, profileToken: a.profile.token });
    if ('error' in b) throw new Error(b.error.message);
    expect(b.profile).toEqual({ id: a.profile.id });
    expect(m.profilePort(a.profile.id)!.records('ja')!.data.runs.total).toBe(2);
    const bad = await m.createRun({ name: 'C', seed: 'v37-p3', controller: agent, profileToken: 'nope' });
    expect('error' in bad && bad.error.code).toBe('no_session');
    // プロフィールのトークンはランの記録に入らない（ID だけ）
    const join = (a.session.world.players[a.playerId] as unknown as Record<string, unknown>);
    expect(JSON.stringify(join)).not.toContain(a.profile.token!);
    m.closeAll();
  });

  it('profiles are files with only a token hash; the token never reaches commands.jsonl, meta or the activity log', async () => {
    const dir = join(runsDir, 'files');
    const m = new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 50 }));
    const a = await m.createRun({ name: 'A', seed: 'v37-f1', controller: agent });
    if ('error' in a) throw new Error(a.error.message);
    const tok = a.profile.token!;
    const pdir = join(dir, 'profiles');
    expect(readdirSync(pdir)).toContain(`${a.profile.id}.json`);
    const file = readFileSync(join(pdir, `${a.profile.id}.json`), 'utf8');
    expect(file).not.toContain(tok);
    const runDir = join(dir, a.session.runId);
    for (const f of ['commands.jsonl', 'meta.json', 'events.jsonl']) expect(readFileSync(join(runDir, f), 'utf8')).not.toContain(tok);
    expect(readFileSync(join(runDir, 'commands.jsonl'), 'utf8')).toContain(a.profile.id);
    // サーバーを作り直してもトークンで引ける
    m.closeAll();
    const m2 = new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 50 }));
    expect(m2.profilePortForToken(tok)?.id).toBe(a.profile.id);
    m2.closeAll();
  });
});

describe('V3-7 legacy (§7.3)', () => {
  const goblin = { met: 7, kills: 6, abilities: ['flees'], hpSeen: { min: 4, max: 10, samples: 6 }, maxHit: 6 };
  const rat = { met: 3, kills: 3, abilities: ['fast'], hpSeen: { min: 2, max: 5, samples: 3 }, maxHit: 2 };

  it('species slain minKills+ times carry over as notes (abilities, HP record, worst hit); counts start at 0; nothing else carries', async () => {
    expect(legacyFrom([priorRun('r1', { 'core:goblin': goblin, 'core:cave_rat': rat })], 5).map((l) => l.kind)).toEqual(['core:goblin']);
    // 2 ランに分かれていても合計で数える
    expect(legacyFrom([priorRun('r1', { 'core:cave_rat': rat }), priorRun('r2', { 'core:cave_rat': rat })], 5).map((l) => l.kind)).toEqual(['core:cave_rat']);
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 50 }));
    const c = m.profiles.store.create('P', 1);
    c.profile.runs.push(priorRun('run_old', { 'core:goblin': goblin, 'core:cave_rat': rat }, { codex: { ...emptyCodex(), species: { 'core:goblin': goblin }, items: ['core:scroll_teleport'], weaknesses: ['core:weak_poison'] } }));
    m.profiles.store.save(c.profile);
    const r = await m.createRun({ name: 'Heir', seed: 'v37-l1', controller: agent, profileToken: c.token });
    if ('error' in r) throw new Error(r.error.message);
    const pr = r.session.world.players[r.playerId];
    expect(pr.legacy).toEqual({ kinds: 1 });
    const mem = pr.knowledge.monsterMemory['core:goblin'];
    expect(mem).toMatchObject({ encounters: 0, kills: 0, maxDamageToYou: 6, abilities: ['flees'], hpSeen: { min: 4, max: 10, samples: 6 }, legacy: { kills: 6 } });
    expect(pr.knowledge.monsterMemory['core:cave_rat']).toBeUndefined();
    // 鑑定・弱点は引き継がない
    expect(pr.knowledge.identified).not.toContain('core:scroll_teleport');
    expect(pr.knowledge.guardianIntel ?? {}).toEqual({});
    // 文章では覚え書きとして区別する
    expect(memoryCombatText('ja', mem)).toContain('覚え書きより');
    // 同じプロフィールでも legacy: false なら無し
    const off = await m.createRun({ name: 'Fresh', seed: 'v37-l2', controller: agent, profileToken: c.token, legacy: false });
    if ('error' in off) throw new Error(off.error.message);
    expect(off.session.world.players[off.playerId].legacy).toBeUndefined();
    expect(off.session.world.players[off.playerId].knowledge.monsterMemory).toEqual({});
    m.closeAll();
    // サーバーの legacyPolicy: off
    const m2 = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 50, legacyPolicy: 'off' }));
    const c2 = m2.profiles.store.create('P', 1);
    c2.profile.runs.push(priorRun('run_old', { 'core:goblin': goblin }));
    m2.profiles.store.save(c2.profile);
    const r2 = await m2.createRun({ name: 'Heir', seed: 'v37-l3', controller: agent, profileToken: c2.token });
    if ('error' in r2) throw new Error(r2.error.message);
    expect(r2.session.world.players[r2.playerId].legacy).toBeUndefined();
    m2.closeAll();
  });

  it('a legacy run re-executes from commands.jsonl alone, with the profile files deleted', async () => {
    const dir = join(runsDir, 'replay');
    const m = new SessionManager(content, loadConfig({ runsDir: dir, waitOthersMs: 50, keyframeEvery: 200 }));
    const c = m.profiles.store.create('P', 1);
    c.profile.runs.push(priorRun('run_old', { 'core:goblin': goblin, 'core:jackal': { ...goblin, abilities: ['fast', 'pack'] } }));
    m.profiles.store.save(c.profile);
    const r = await m.createRun({ name: 'Heir', seed: 'v37-replay', controller: agent, profileToken: c.token });
    if ('error' in r) throw new Error(r.error.message);
    await playWithPort(r.port, { kind: 'greedy', seed: 'v37-replay', maxActs: 120 });
    m.closeAll();
    rmSync(join(dir, 'profiles'), { recursive: true, force: true });
    expect(existsSync(join(dir, 'profiles'))).toBe(false);
    const v = verifyRunDir(content, join(dir, r.session.runId));
    expect(v.reexecMatches).toBe(true);
    expect(v.foldMatchesKeyframe).toBe(true);
  }, 60000);
});

describe('V3-7 records, codex and feats (§7.2・§7.4)', () => {
  it('a played run fills records and the codex from the player\'s own knowledge; feats are judged and stored; hidden ones keep their condition', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 50 }));
    const r = await m.createRun({ name: 'A', seed: 'v37-rec', controller: agent });
    if ('error' in r) throw new Error(r.error.message);
    await playWithPort(r.port, { kind: 'greedy', seed: 'v37-rec', maxActs: 400, maxExpeditions: 2 });
    const rec = m.profilePort(r.profile.id)!.records('ja')!;
    const d = rec.data;
    expect(d.runs.total).toBe(1);
    const k = r.session.world.players[r.playerId].knowledge;
    // 図鑑の種族 = 本人が遭遇した種族
    const met = new Set(Object.values(k.monsterMemory).filter((x) => x.encounters > 0).map((x) => x.kind));
    const sp = d.codex.categories.find((x) => x.id === 'species')!;
    expect(new Set(sp.entries.map((e) => e.id))).toEqual(met);
    expect(sp.total).toBe(content.lists.monsters.length);
    expect(d.codex.total).toBe(d.codex.categories.reduce((a, x) => a + x.total, 0));
    expect(d.next.codex).toBe(`${d.codex.found}/${d.codex.total}`);
    // 1 回でも達成していれば「初めての帰還」
    const completed = r.session.endedReports(r.playerId).some((x) => x.reason === 'completed');
    expect(d.feats.list.find((f) => f.id === 'core:feat_first_return')!.earned).toBe(completed);
    // 伏せた実績は取るまで条件が出ない
    const hidden = d.feats.list.find((f) => f.id === 'core:feat_same_death3')!;
    expect(hidden.earned).toBe(false);
    expect(hidden.desc).toBeNull();
    expect(rec.text).toContain('（条件は取るまで伏せる）');
    // キャンプの観測に 1 行
    if (r.port.view().status === 'at_camp') expect(r.port.observe({ map: false }).text).toContain('次の節目:');
    m.closeAll();
  }, 60000);

  it('feat conditions compare report and record values; floorsUnhurt counts floors left downward without damage', () => {
    const ctx = { report: { reason: 'completed', combat: { min_hp_pct: 85 } }, expedition: null, run: { completed: 3 }, profile: {} } as unknown as FeatContext;
    expect(evalFeatCond({ all: [{ path: 'report.reason', op: '==', value: 'completed' }, { path: 'report.combat.min_hp_pct', op: '>=', value: 80 }] }, ctx)).toBe(true);
    expect(evalFeatCond({ path: 'report.combat.min_hp_pct', op: '<=', value: 10 }, ctx)).toBe(false);
    expect(evalFeatCond({ any: [{ path: 'run.completed', op: '>=', value: 5 }, { path: 'run.completed', op: '==', value: 3 }] }, ctx)).toBe(true);
    // 無い値は偽
    expect(evalFeatCond({ path: 'expedition.floors_unhurt', op: '>=', value: 0 }, ctx)).toBe(false);
    const ev = (type: string, o: Record<string, unknown>) => ({ type, seq: 0, ...o }) as never;
    expect(floorsUnhurt([
      ev('entity_changed_floor', { id: 'me', dir: 'down' }),
      ev('damaged', { target: 'me', amount: 3, dealt: 3 }),
      ev('entity_changed_floor', { id: 'me', dir: 'down' }),
      ev('damaged', { target: 'other', amount: 3 }),
      ev('entity_changed_floor', { id: 'me', dir: 'down' }),
    ], 'me')).toBe(2);
    // すべての実績の条件がスキーマで読めている
    expect(content.lists.feats.length).toBeGreaterThanOrEqual(30);
  });

  it('records over MCP and over HTTP are the same', async () => {
    const config = loadConfig({ runsDir: join(runsDir, 'http'), waitOthersMs: 100 });
    const app = createApp(new SessionManager(content, config), config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const client = new Client({ name: 't', version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const nr = (await client.callTool({ name: 'new_run', arguments: { character_name: 'M' } })) as unknown as { structuredContent: { profile_token: string; profile_id: string; player_token: string }; content: { text: string }[] };
      const tok = nr.structuredContent.profile_token;
      expect(nr.content[0].text).toContain('profile_token:');
      const viaMcp = (await client.callTool({ name: 'records', arguments: { profile_token: tok } })) as unknown as { structuredContent: { records: unknown }; content: { text: string }[] };
      const viaHttp = await (await fetch(`${base}/api/profile/records`, { headers: { authorization: `Bearer ${tok}` } })).json() as { records: unknown; text: string };
      expect(viaHttp.records).toEqual(viaMcp.structuredContent.records);
      expect(viaHttp.text).toBe(viaMcp.content[0].text);
      // profile ツール: 進行中のランは run_id だけ
      const pf = (await client.callTool({ name: 'profile', arguments: { profile_token: tok } })) as unknown as { structuredContent: { runs: { run_id: string; resumable: boolean }[] } };
      expect(pf.structuredContent.runs[0].resumable).toBe(true);
      expect(JSON.stringify(pf)).not.toContain(nr.structuredContent.player_token);
      // 2 本目のランをトークンで始めると、新しいトークンは返らない
      const nr2 = (await client.callTool({ name: 'new_run', arguments: { character_name: 'M2', profile_token: tok } })) as unknown as { structuredContent: Record<string, unknown> };
      expect(nr2.structuredContent.profile_id).toBe(nr.structuredContent.profile_id);
      expect(nr2.structuredContent.profile_token).toBeUndefined();
      // 観戦向けの AI の呼び出し記録にもトークンは出ない
      const runId = nr2.structuredContent.run_id as string;
      expect(JSON.stringify(app.manager.get(runId)!.agentActivity)).not.toContain(tok);
      await client.close();
    } finally {
      await app.close();
    }
  }, 30000);
});

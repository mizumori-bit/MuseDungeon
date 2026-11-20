// V4-1g（IMPROVEMENTS_V4 §24）の確認: 途中で入った者はキャンプから（G1）、参加者の種類の既定（G2）、仲間の HP の段階（G3。漏洩テストは v41f）、
// 協力プレイの確定の表示（G4）、valid_actions の行がそのまま呼べること（G5）、地物の説明（G6）。pilot の危ないときの順序・協力プレイ・記録（§24.2〜§24.5）
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, ObsMonster, ObsPartyMember, Observation } from '@muse/shared';
import { applyEvent, buildObservation, diffChanges, MAX_CHANGES, projectPlayerView, turnSnapshot } from '@muse/shared';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { decide, defaultOrders, newMemory } from '../src/index';
import type { DecideContext, PilotOrders, PilotState, WakeEvent } from '../src/index';
import { simpleResponder } from '../src/pilot/responder';
import { readOrders } from '../src/pilot/orders';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 998800;
type A = Awaited<ReturnType<typeof arena>>;

async function coop(seed: string, opts: { objective?: 'auto' } = {}) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 300 }));
  const a = await manager.createRun({ name: 'A', mode: 'coop', seed, controller: { kind: 'agent', label: 'a' }, ...opts });
  if ('error' in a) throw new Error(a.error.message);
  return { manager, a, world: a.session.world };
}

describe('V4-1g G1: joining a co-op run mid-expedition starts at camp', () => {
  it('the joiner is put at camp while the expedition is under way, sees who is inside, and goes out with the next expedition', async () => {
    const t = await coop('v41g-join', { objective: 'auto' });
    expect(t.a.port.view().status).not.toBe('at_camp');
    const b = await t.manager.joinRun(t.a.session.runId, { name: 'B', controller: { kind: 'human', label: 'b' } });
    if ('error' in b) throw new Error(b.error.message);
    expect(b.port.view().status).toBe('at_camp');
    const o = b.port.observe({});
    expect(o.observation.party[0]).toMatchObject({ name: 'A', status: 'in_dungeon', floor: 1 });
    expect(o.text).toContain('遠征 1 が進んでいる（仲間がまだ迷宮にいる）。全員が戻ったら、次の遠征を選べる');
    // 進んでいる遠征には入れない（still_inside）
    const r = await b.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.details?.still_inside?.map((x) => x.name)).toEqual(['A']);
    // A が帰る（階段の上で撤退）→ 遠征が終わる → 次の遠征に B も出る
    const w = t.world;
    const aE = structuredClone(w.entities[w.players[t.a.port.playerId]!.entityId]!);
    const f = w.floors[aE.pos!.floor]!;
    const i = f.terrain.findIndex((v) => v === w.meta.terrainTable.indexOf('core:stairs_down'));
    aE.pos = { floor: aE.pos!.floor, x: i % f.width, y: Math.trunc(i / f.width) };
    applyEvent(w, { type: 'thought', player: t.a.port.playerId, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [aE] } as unknown as GameEvent);
    expect((await t.a.port.act({ type: 'extract', confirm: true }, { source: 'bot' })).ok).toBe(true);
    expect((await b.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    expect(b.port.view().status).not.toBe('at_camp');
    expect(t.a.port.view().status).not.toBe('at_camp');
    t.manager.closeAll();
  });
});

describe('V4-1g G2: who is playing', () => {
  it('HTTP create/join without controller is unknown (shown as such in party); the browser sends human; MCP is agent', async () => {
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const manager = new SessionManager(content, config);
    const app = createApp(manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const post = async (u: string, b: unknown) => (await fetch(new URL(u, base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json() as Promise<{ runId: string; playerId: string }>;
    const run = await post('/api/runs', { name: 'A', mode: 'coop' });
    await post(`/api/runs/${run.runId}/join`, { name: 'B' });
    await post(`/api/runs/${run.runId}/join`, { name: 'C', controller: { kind: 'human', label: 'browser' } });
    const s = manager.get(run.runId)!;
    expect(Object.values(s.world.players).map((p) => `${p.name}:${p.controller.kind}`).sort()).toEqual(['A:unknown', 'B:unknown', 'C:human']);
    // party の controller
    const view = projectPlayerView(s.world, run.playerId);
    const obs = buildObservation(view, catalog, { detail: 'brief', map: false });
    expect(obs.party.map((m) => `${m.name}:${m.controller}`)).toEqual(['B:unknown', 'C:human']);
    manager.closeAll();
    await new Promise<void>((r) => app.server.close(() => r()));
  });
});

describe('V4-1g G4: co-op banked text says total and yours, and who got what', () => {
  it('result.banked / party_banked / shares and the text; the co-op haul text says when it is banked', async () => {
    const t = await coop('v41g-banked');
    const b = await t.manager.joinRun(t.a.session.runId, { name: 'B', controller: { kind: 'human', label: 'b' } });
    if ('error' in b) throw new Error(b.error.message);
    expect((await t.a.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    const w = t.world;
    // 遠征の途中: 戦利品の文に、協力プレイの確定の時
    const haul = t.a.port.observe({}).observation.expedition?.haul?.text ?? '';
    expect(haul).toContain('協力プレイ: 帰った者の点は、全員が戻って遠征が終わったときに確定する');
    // 2 人とも階段の上で撤退
    for (const port of [t.a.port, b.port]) {
      const e = structuredClone(w.entities[w.players[port.playerId]!.entityId]!);
      const f = w.floors[e.pos!.floor]!;
      const idx = [...f.terrain.keys()].filter((k) => f.terrain[k] === w.meta.terrainTable.indexOf('core:stairs_down'))[0]!;
      e.pos = { floor: e.pos!.floor, x: idx % f.width, y: Math.trunc(idx / f.width) };
      applyEvent(w, { type: 'thought', player: port.playerId, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [e] } as unknown as GameEvent);
    }
    for (const port of [t.a.port, b.port]) {
      for (let k = 0; k < 20 && port.view().status !== 'your_turn' && port.view().status !== 'at_camp'; k++) {
        const other = port === t.a.port ? b.port : t.a.port;
        if (other.view().status === 'your_turn') await other.act({ type: 'wait' }, { source: 'bot' }); else await new Promise((r) => setTimeout(r, 20));
      }
      expect((await port.act({ type: 'extract', confirm: true }, { source: 'bot' })).ok).toBe(true);
    }
    const x = t.a.port.observe({}).observation.expedition!;
    expect(x.status).toBe('ended');
    expect(x.result!.shares?.map((sh) => `${sh.name}:${sh.how}`).sort()).toEqual(['A:withdrawn', 'B:withdrawn']);
    expect(x.result!.party_banked).toBe(x.result!.shares!.reduce((a2, sh) => a2 + sh.banked, 0));
    expect(x.result!.banked).toBe(x.result!.shares!.find((sh) => sh.name === 'A')!.banked);
    expect(x.result!.text).toContain(`確定 +${x.result!.party_banked}（あなたの分 +${x.result!.banked}）`);
    expect(x.result!.text).toContain('だれの分: A +');
    t.manager.closeAll();
  });
});

describe('V4-1g G6: every feature has a one-line description', () => {
  it('content: every feature has desc in both languages; the observation carries it on visible.features', async () => {
    for (const [id, f] of Object.entries(catalog.features)) {
      expect(f.desc?.ja, id).toBeTruthy();
      expect(f.desc?.en, id).toBeTruthy();
    }
    const a = await arena('v41g-desc', { map: ['P.......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId], put: [{ id: 'e_altar1', kind: 'core:altar', sid: ++sid, pos: { floor: a.key, x: a.ox + 1, y: a.oy }, feature: { state: 'idle' } } as unknown as Entity] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const o = a.r.port.observe({});
    const alt = o.observation.visible.features.find((f) => f.id === 'e_altar1')!;
    expect(alt.desc).toContain('祈ると（interact）');
    // 使える地物の隣では、valid_actions に使う命令の行
    expect(o.observation.valid_actions.some((v) => v.startsWith('interact e '))).toBe(true);
    a.manager.closeAll();
  });

  it('the first-sight line is never dropped by the change limit (it used to be marked seen and then cut)', async () => {
    const a = await arena('v41g-first', { map: ['P.........', '..........', '..........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v0 = projectPlayerView(a.world, a.pid);
    const prev = turnSnapshot(v0, buildObservation(v0, catalog, { detail: 'brief', map: false }));
    // 変化を上限より多く起こす: 見える所に敵を 10 体と、初めて見る祭壇
    const mons: Entity[] = [];
    for (let k = 0; k < 10; k++) mons.push({ id: `e_mn${String(k).padStart(4, '0')}`, kind: 'core:goblin', sid: ++sid, pos: { floor: a.key, x: a.ox + 2 + (k % 8), y: a.oy + 1 + Math.trunc(k / 8) }, actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'asleep', targetPos: null, lostTurns: 0, params: {} }, dormant: true }, stats: { hp: 5, maxHp: 5, acc: 1, eva: 0, might: 0, armor: 0, sight: 4, dmg: '1d1' }, base: { maxHp: 5, acc: 1, eva: 0, might: 0, armor: 0, sight: 4, dmg: '1d1' }, statuses: [] } as unknown as Entity);
    mons.push({ id: 'e_altar2', kind: 'core:altar', sid: ++sid, pos: { floor: a.key, x: a.ox + 1, y: a.oy + 2 }, feature: { state: 'idle' } } as unknown as Entity);
    a.inject({ put: mons });
    const v1 = projectPlayerView(a.world, a.pid);
    const o1 = buildObservation(v1, catalog, { detail: 'brief', map: false });
    const cur = turnSnapshot(v1, o1);
    const ch = diffChanges(prev, cur, v1, o1, [], catalog);
    expect(ch.filter((c) => c.code !== 'first_seen').length).toBe(MAX_CHANGES);
    expect(ch.some((c) => c.code === 'first_seen' && c.text.includes('祭壇'))).toBe(true);
    a.manager.closeAll();
  });
});

// ---- G5: valid_actions の全部の行を、書いてある形のまま MCP で呼ぶ ----
const MAIN: Record<string, string> = { move: 'dir', interact: 'dir', fight: 'target', attack: 'target', travel_to: 'to', use_item: 'slot', equip: 'slot', throw_item: 'slot', use_ability: 'ability' };
/** valid_actions の 1 行を、ツールと引数にする（PROTOCOL.md の形のとおり）。説明が「不可」の行は null */
function parseLine(line: string): { tool: string; args: Record<string, unknown> } | null {
  const cut = line.indexOf(' (');
  const head = (cut >= 0 ? line.slice(0, cut) : line).trim();
  if (cut >= 0 && /^(不可|unavailable)/.test(line.slice(cut + 2))) return null;
  const toks = head.split(/\s+/).filter(Boolean);
  const tool = toks[0]!;
  const pick = (v: string) => { const m = /^<([^>]+)>$/.exec(v); return m ? m[1]!.split('|')[0]! : v; };
  const args: Record<string, unknown> = {};
  for (const tk of toks.slice(1)) {
    const i = tk.indexOf(':');
    if (i < 0) { args[MAIN[tool] ?? 'arg'] = pick(tk); continue; }
    const k = tk.slice(0, i);
    const raw = pick(tk.slice(i + 1));
    // 並べた値（[a,b]・a,b）も、書いてある文字列のまま渡す（サーバーが配列にする）
    args[k] = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
  }
  return { tool, args };
}

async function scenario(kind0: 'warrior' | 'scout' | 'scout_adj') {
  // scout_adj: 斥候で、守護者が隣にいる（slip の行）
  const kind = kind0 === 'warrior' ? 'warrior' : 'scout';
  const far = kind0 === 'scout';
  const items = kind === 'scout' ? [{ kind: 'core:throwing_knife', qty: 3 }, { kind: 'core:javelin', qty: 2 }, { kind: 'core:potion_healing', qty: 1 }] : [{ kind: 'core:potion_healing', qty: 1 }];
  const a = await arena(`v41g-va-${kind}`, { classId: kind === 'scout' ? 'core:scout' : 'core:warrior', map: far ? ['.......', '.P...G.', '.......', '....O..'] : ['......', '.PG...', '......', '....O.'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'hunting', ...(far ? { archetype: 'ranged_stand' } : {}) }, player: { hp: 200, items } });
  const me = structuredClone(a.world.entities[a.meId]!);
  me.build!.abilities = (kind === 'scout' ? ['core:aimed_throw', 'core:slip', 'core:second_wind'] : ['core:bash', 'core:cleave', 'core:second_wind']).map((id) => ({ id, readyAt: 0 }));
  me.stats!.hp = 150;
  a.inject({ put: [me, { id: 'e_altar3', kind: 'core:altar', sid: ++sid, pos: { floor: a.key, x: a.ox, y: a.oy }, feature: { state: 'idle' } } as unknown as Entity] });
  // 視界は最初の手で更新される: 1 手番待ってから見る（隣の守護者が見え、能動技・投擲・地物の行が出る）
  await a.r.port.act({ type: 'wait' }, { source: 'bot' });
  const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
  const app = createApp(a.manager, config);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const client = new Client({ name: 'v41g', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`)));
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: { ok?: boolean; error?: { code: string; message: string }; observation?: Observation }; content?: { text?: string }[] };
  await call('resume_run', { player_token: a.r.token });
  return { a, call, close: async () => { await client.close(); a.manager.closeAll(); await new Promise<void>((r) => app.server.close(() => r())); } };
}

describe('V4-1g G5: every valid_actions line can be called as written', () => {
  for (const kind of ['warrior', 'scout', 'scout_adj'] as const) {
    it(`${kind}: each line parses to a tool call that the MCP tool accepts and the game carries out`, async () => {
      const s0 = await scenario(kind);
      const lines = (await s0.call('observe', {})).structuredContent!.observation!.valid_actions;
      await s0.close();
      expect(lines.some((l) => l.startsWith('use_ability'))).toBe(true);
      // 並べた値の行（能動技を載せた fight・2 種類以上の投げる品）も入っている
      if (kind !== 'scout_adj') expect(lines.some((l) => l.startsWith('fight') && l.includes(kind === 'scout' ? 'with:' : 'abilities:'))).toBe(true);
      const callable = lines.map((l) => [l, parseLine(l)] as const).filter((x): x is readonly [string, NonNullable<ReturnType<typeof parseLine>>] => !!x[1]);
      expect(callable.length).toBeGreaterThan(12);
      const wants = { scout: ['use_ability aimed_throw', 'fight e_gd0001 with:[', 'throw_item', 'interact'], scout_adj: ['use_ability slip target:', 'fight e_gd0001', 'interact'], warrior: ['use_ability bash', 'use_ability cleave', 'fight e_gd0001', 'interact'] }[kind];
      for (const want of wants) expect(lines.some((l) => l.startsWith(want)), want).toBe(true);
      const failed: string[] = [];
      for (const [line, c] of callable) {
        const s = await scenario(kind);
        const r = await s.call(c.tool, c.args);
        const ok = !r.isError && r.structuredContent?.ok !== false;
        if (!ok) failed.push(`${line} → ${c.tool} ${JSON.stringify(c.args)}: ${r.structuredContent?.error?.code ?? ''} ${r.structuredContent?.error?.message ?? (r.content ?? []).map((x) => x.text).join(' ')}`);
        await s.close();
      }
      expect(failed).toEqual([]);
    }, 120000);
  }

  it('use_ability accepts ability (and id); with neither, the error names the argument', async () => {
    const s = await scenario('warrior');
    const r1 = await s.call('use_ability', { ability: 'bash', target: s.a.gId });
    expect(r1.structuredContent?.ok).not.toBe(false);
    const r2 = await s.call('use_ability', {});
    expect(r2.structuredContent?.ok).toBe(false);
    expect(r2.structuredContent?.error?.message).toContain('use_ability には ability が要る');
    await s.close();
  }, 30000);
});

// ---- pilot の判断（観測は最小限の写し） ----
type Over = { depth?: number; monsters?: ObsMonster[]; stairs?: Observation['navigation']['known_stairs']; objective?: { type: string; target_depth: number | null }; party?: ObsPartyMember[]; status?: string; hp?: number; alerts?: Observation['alerts']; frontiers?: number };
function fieldObs(o: Over = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: o.alerts ?? [],
    self: { name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: o.hp ?? 40, max_hp: 40, statuses: [], pos: { x: 20, y: 10 }, floor: { depth: o.depth ?? 3 }, attack: { acc: 5, dmg: '1d6' }, defense: { eva: 0, armor: 0 }, recovery: [] },
    visible: { monsters: o.monsters ?? [], items: [], players: [], features: [] },
    party: o.party ?? [],
    navigation: { known_stairs: o.stairs ?? [], frontiers: Array.from({ length: o.frontiers ?? 0 }, () => ({ pos: { x: 1, y: 1 }, dir: 'w', dist: 3 })), collectable: { count: 0, ids: [] } },
    expedition: {
      no: 6, objective: { type: o.objective?.type ?? 'reach_depth', target_depth: o.objective?.target_depth ?? 6, text: '目的' }, progress: {}, status: o.status ?? 'in_progress', points: 0,
      can_extract: false, extract_outcome: 'withdraw', text: '遠征 6', haul: { total: 0, multiplier_pct: 100, parts: {}, if_extract_now: 0, next_overreach: null, next_camp: null, text: '戦利品 0' },
    },
  } as unknown as Observation;
}
function mon(over: Partial<ObsMonster>): ObsMonster {
  return { id: 'e_aaaaaa', name: '敵', pos: { x: 21, y: 10 }, dir: 'e', dist: 1, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [], ...over } as ObsMonster;
}
const ctx = (orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext => ({ orders, coop: false, waiting: false, acked: new Set(), text: '', ...over });
const withPolicy = (p: Partial<PilotOrders['policy']>, mode: PilotOrders['mode'] = 'auto'): PilotOrders => { const o = defaultOrders(); return { ...o, mode, policy: { ...o.policy, ...p } }; };
const summary = (r: ReturnType<typeof decide>) => (r.decision.kind === 'wake' ? `${r.decision.wake.level}:${r.decision.wake.reason}` : r.decision.kind === 'act' ? `act:${r.decision.tool}:${JSON.stringify(r.decision.args)}` : r.decision.kind === 'end' ? `end:${r.decision.wake.level}` : `${r.decision.kind}${r.decision.kind === 'idle' && r.decision.wait ? `:${r.decision.wait}` : ''}`);
const member = (o: Partial<ObsPartyMember>): ObsPartyMember => ({ id: 'p_h', name: 'H', controller: 'human', order: 1, status: 'in_dungeon', floor: 3, hp: 'healthy', ...o });
const upSt = { type: 'up' as const, pos: { x: 5, y: 10 }, dist: 15, reachable: true, path_len: 15 };

describe('V4-1g pilot: the order when it is dangerous (§24.2)', () => {
  it('on the way home it does not hit an adjacent enemy unless it blocks the way; it moves with flee', () => {
    const o = fieldObs({ monsters: [mon({ id: 'e_adj001' })], stairs: [upSt] });
    const r = decide(o, ctx(withPolicy({}, 'return')));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"stairs_up","mode":"flee"/);
    expect(r.decision.kind === 'act' && r.decision.why).toBe('return');
    const rb = decide(o, ctx(withPolicy({}, 'return'), { refused: new Set(['travel_to']), refusal: { code: 'blocked', text: 'x', blockedBy: ['e_adj001'] } }));
    expect(summary(rb)).toBe('act:attack:{"target":"e_adj001"}');
  });
  it('danger and the end of the run reach the AI (escalate); the pilot still retreats on its own', () => {
    const lethal = { code: 'lethal_range', level: 'danger', text: '1 手で倒されうる' } as unknown as Observation['alerts'][number];
    expect(summary(decide(fieldObs({ alerts: [lethal], monsters: [mon({})] }), ctx()))).toBe('escalate:danger');
    const ended = { ...fieldObs(), status: 'dead' } as unknown as Observation;
    expect(summary(decide(ended, ctx()))).toBe('end:escalate');
  });
  it('after being shot by an ignored enemy: leaves the floor by the stairs; never comes back this expedition (target_blocked if the objective is beyond)', () => {
    const mem = newMemory(); mem.leaveFloor = true;
    const r = decide(fieldObs({ monsters: [mon({ id: 'e_arch01', dist: 5, traits: ['ranged'] })], stairs: [upSt] }), ctx(defaultOrders(), { mem }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"stairs_up","mode":"flee"/);
    expect(r.decision.kind === 'act' && r.decision.why).toBe('leave_floor');
    // 出た階（地下 3 階）が目的の階への道にある: 起こす
    const o2 = fieldObs({ depth: 2, objective: { type: 'reach_depth', target_depth: 4 }, stairs: [{ type: 'down', pos: { x: 30, y: 10 }, dist: 10, reachable: true, path_len: 10 }] });
    expect(summary(decide(o2, ctx(defaultOrders(), { avoidDepths: new Set([3]) })))).toBe('wake:target_blocked');
    // 立て直しで階を移った後も、出た階には戻らない
    const m3 = newMemory(); m3.crossed = 'down';
    const r3 = decide(fieldObs({ depth: 2, objective: { type: 'reach_depth', target_depth: 2 }, stairs: [{ type: 'down', pos: { x: 30, y: 10 }, dist: 10, reachable: true, path_len: 10 }] }), ctx(defaultOrders(), { mem: m3, avoidDepths: new Set([3]) }));
    expect(r3.update?.crossed).toBeNull();
  });
});

describe('V4-1g pilot: co-op (§24.4)', () => {
  const camp = (party: ObsPartyMember[]) => {
    const o = { ...fieldObs(), status: 'at_camp', self: { ...fieldObs().self, pos: null, floor: null }, party, camp: { next_no: 7, offers: [{ index: 1, type: 'slay_guardian', target_depth: 3, points: 100, text: '1', multiplier_pct: 100, recommended_level: 2, level_gap: 0, trait_danger: 0, slot: 'safe' }] } } as unknown as Observation;
    o.expedition = { ...o.expedition!, status: 'ended' };
    return o;
  };
  it('wait_for_join: in a co-op run with nobody else, waits at camp (no start, no camp wake)', () => {
    const auto = defaultOrders(); auto.camp.auto_start = 'safe';
    expect(summary(decide(camp([]), ctx(auto, { coop: true })))).toBe('idle:join');
    expect(summary(decide(camp([member({ status: 'at_camp', floor: undefined })]), ctx(auto, { coop: true })))).toBe('act:start_expedition:{"offer":1}');
    expect(summary(decide(camp([]), ctx(withPolicy({ coop: { ...defaultOrders().policy.coop, wait_for_join: false } }), { coop: true })))).toBe('wake:camp');
    // ソロでは待たない
    expect(summary(decide(camp([]), ctx(auto)))).toBe('act:start_expedition:{"offer":1}');
  });
  const leaderMem = () => { const m = newMemory(); m.follow = { id: 'p_h', exp: 6, met: true, inDungeon: true, lastPos: null, lastFloor: 3, floorAtStart: 3, startTurn: 0 }; return m; };
  it('assist: the ally badly wounded far away: stops exploring and goes there (flee), then fights the enemy nearest to the ally; tells assist and assist_arrived', () => {
    const far = member({ hp: 'badly_wounded', pos: [5, 10], entity: 'e_h00001' });
    const r = decide(fieldObs({ party: [far], frontiers: 2, monsters: [mon({ id: 'e_far001', pos: { x: 40, y: 10 }, dist: 20 })] }), ctx(defaultOrders(), { coop: true, mem: leaderMem() }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"e_h00001","mode":"flee"/);
    expect(r.decision.kind === 'act' && r.decision.why).toBe('assist');
    expect(r.notify.map((n) => n.reason)).toContain('assist');
    const near = member({ hp: 'near_death', pos: [22, 10], entity: 'e_h00001' });
    const m2 = leaderMem(); m2.assisting = true;
    const foeNearAlly = mon({ id: 'e_foe0a1', pos: { x: 23, y: 10 }, dist: 3 });
    const foeNearMe = mon({ id: 'e_foe0b2', pos: { x: 17, y: 10 }, dist: 3 });
    const r2 = decide(fieldObs({ party: [near], monsters: [foeNearMe, foeNearAlly] }), ctx(defaultOrders(), { coop: true, mem: m2 }));
    expect(r2.decision.kind === 'act' && `${r2.decision.tool}:${r2.decision.args.target}`).toBe('fight:e_foe0a1');
    expect(r2.notify.map((n) => n.reason)).toContain('assist_arrived');
  });
  it('assist: arriving is told even when the next command is a fight with an adjacent enemy (the fight row comes first)', () => {
    const near = member({ hp: 'badly_wounded', pos: [21, 11], entity: 'e_h00001' });
    const m = leaderMem(); m.assisting = true;
    const r = decide(fieldObs({ party: [near], monsters: [mon({ id: 'e_adj0a1' })] }), ctx(defaultOrders(), { coop: true, mem: m }));
    expect(r.decision.kind === 'act' && `${r.decision.tool}:${r.decision.args.target}`).toBe('fight:e_adj0a1');
    expect(r.notify.map((n) => n.reason)).toContain('assist_arrived');
  });
  it('assist: the ally badly wounded on this floor but out of sight (last seen spot already visited): patrols to find them instead of waiting', () => {
    const hid = member({ hp: 'badly_wounded', floor: 3 });
    const m = leaderMem(); m.assisting = true;
    const r = decide(fieldObs({ party: [hid] }), ctx(defaultOrders(), { coop: true, mem: m, walked: [{ x: 5, y: 10 }, { x: 18, y: 10 }] }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":\{"x":5,"y":10\},"mode":"flee"/);
    expect(r.decision.kind === 'act' && r.decision.why).toBe('assist');
    // 助けに行くのでなければ、今までどおり待つ
    expect(summary(decide(fieldObs({ party: [member({ floor: 3 })] }), ctx(defaultOrders(), { coop: true, mem: leaderMem(), walked: [{ x: 5, y: 10 }] })))).toBe('act:wait:{}');
  });
  it('on_party_down: the ally fell: heads home (return) or carries on (continue)', () => {
    const down = member({ status: 'down', floor: undefined, hp: undefined });
    const r = decide(fieldObs({ party: [down], stairs: [upSt], frontiers: 2 }), ctx(defaultOrders(), { coop: true, mem: leaderMem() }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"stairs_up"/);
    expect(r.notify.map((n) => n.reason)).toContain('party_down');
    const cont = withPolicy({ coop: { ...defaultOrders().policy.coop, on_party_down: 'continue' } });
    expect(summary(decide(fieldObs({ party: [down], stairs: [upSt], frontiers: 2 }), ctx(cont, { coop: true, mem: leaderMem() })))).toBe('act:explore:{"pickup":"useful"}');
  });
});

describe('V4-1g sample responder (§24.3)', () => {
  it('does not give the same reply to the same reason twice in a row: the second time it goes home', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41g-resp-'));
    const ordersPath = join(dir, 'orders.json');
    writeFileSync(ordersPath, JSON.stringify(defaultOrders()));
    const state = { hostiles: [{ id: 'e_foe001', name: '敵', pos: [1, 1], dist: 1, hp_state: 'healthy', hunting: true, role: null, objective: false, ignored: false }], traps: [] } as unknown as PilotState;
    const ev = (): WakeEvent => ({ level: 'wake', reason: 'refused_blocked', key: 'k', detail: '- 敵 e_foe001 (1,1)', state, statePath: join(dir, 'state.json'), ordersPath });
    simpleResponder(ev());
    expect(readOrders(ordersPath)!.queue).toEqual([{ tool: 'fight', args: { target: 'e_foe001', until: 'clear' } }]);
    simpleResponder(ev());
    expect(readOrders(ordersPath)!.mode).toBe('return');
    expect(ENGINE_VERSION).toBe('0.34.0');
  });
});

void (null as unknown as A);
void (null as unknown as Command);

describe('V4-1g pilot: cornered (found by the measurement)', () => {
  it('recovering with no way to flee (no stairs, travel_to refused): hits the adjacent chaser instead of raising danger over and over', () => {
    const o = fieldObs({ hp: 10, monsters: [mon({ id: 'e_cor001' })] });
    const r = decide(o, ctx(defaultOrders(), { refused: new Set(['travel_to']) }));
    expect(summary(r)).toBe('act:attack:{"target":"e_cor001"}');
    expect(r.decision.kind === 'act' && r.decision.why).toBe('cornered');
    expect(r.notify.map((n) => n.reason)).toContain('cornered');
    // 逃げる手があれば殴らない（着ける階段へ: 観測の escape）
    const esc = { code: 'escape', level: 'info', text: '逃げ道', data: { stairs: 'up', worst_if_chased: 4, hp: 10 } } as unknown as Observation['alerts'][number];
    expect(summary(decide(fieldObs({ hp: 10, monsters: [mon({ id: 'e_cor001' })], stairs: [upSt], alerts: [esc] }), ctx()))).toMatch(/^act:travel_to:\{"to":"stairs_up","mode":"flee"/);
  });
  it('on the way home with the way refused: hits the adjacent chaser (cornered)', () => {
    const o = fieldObs({ monsters: [mon({ id: 'e_cor002' })], stairs: [upSt] });
    const r = decide(o, ctx(withPolicy({}, 'return'), { refused: new Set(['travel_to']) }));
    expect(summary(r)).toBe('act:attack:{"target":"e_cor002"}');
    expect(r.decision.kind === 'act' && r.decision.why).toBe('cornered');
  });
});

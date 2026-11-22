// S0b（SEASON.md §6.2・§7）: 経験値の理由・戦いのまとめのとどめの超過分・引数の名前を間違えたときのエラー・階は作られたまま残る（規則の文）・
// 招きの取り消し・試運転の道具 call（トークンを保存して伏せる）。
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { applyEvent, buildObservation, filterEventsForPlayer, lastWithoutXp, nameOf, narrate, projectPlayerView } from '@muse/shared';
import { createApp, loadConfig, rulesText, SessionManager } from '@muse/server';
import { fightNumbers } from '../src/index';
import { maskTokens, mcpCall, mcpUrl, parsePairs, parseValue, tokenFiles } from '../src/mcp-call';
import { seasonCli } from '../src/season';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };
const goblin = nameOf(catalog.monsters['core:goblin'].name, 'ja', 'goblin');

async function newRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: agent, objective: 'reach_depth' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject({ put: [e] }); };
  const place = (x: number, y: number, floor = me().pos!.floor) => edit((e) => { e.pos = { floor, x, y }; });
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const messages = () => r.port.messages(0, 200).text;
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, messages };
}

let sid = 996000;
function monster(id: string, kind: string, floor: string, x: number, y: number, o: { hp?: number; xp?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 1;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp, maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: hp, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
    ...(o.xp !== undefined ? { xp: o.xp } : {}),
  };
}

/** 自分の隣の空いた床（東西南北） */
function besideMe(t: Awaited<ReturnType<typeof newRun>>): { x: number; y: number; dir: 'n' | 'e' | 's' | 'w' } {
  const p = t.me().pos!;
  const f = t.world.floors[p.floor];
  for (const [dx, dy, dir] of [[1, 0, 'e'], [-1, 0, 'w'], [0, 1, 's'], [0, -1, 'n']] as const) {
    const x = p.x + dx, y = p.y + dy;
    const tt = content.terrain[content.terrainIndex[t.world.meta.terrainTable[f.terrain[y * f.width + x]]]];
    if (tt.passable && !tt.stairs && !Object.values(t.world.entities).some((e) => e.pos?.floor === p.floor && e.pos.x === x && e.pos.y === y)) return { x, y, dir };
  }
  throw new Error('no free cell beside me');
}

describe('S0b §6.2-1: XP gains say why', () => {
  it('a kill, the first arrival at a new depth and the objective each come with their reason; the engine event stays as it was', async () => {
    const t = await newRun('s0b-xp-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    // 敵を倒す（レベルアップの直前にしておく: レベルアップの文も結果に残る）
    t.edit((e) => { e.stats!.acc = 60; e.level = { level: 1, xp: 14 }; });
    const b = besideMe(t);
    t.inject({ put: [monster('e_s0bk01', 'core:goblin', key, b.x, b.y, { xp: 5 })] });
    const seq0 = t.world.seq;
    const k = await t.act({ type: 'move', dir: b.dir });
    expect(k.ok).toBe(true);
    expect(t.messages()).toContain(`経験値 +5（${goblin}を倒した）。`);
    expect(k.ok && k.outcome).toContain(`経験値 +5（${goblin}を倒した）`);
    // 経験値の文は結果の 3 件の枠を使わない（S0b §7.9）: 経験値でない最初の 3 件（会心・ダメージ・倒した・レベルアップ…）は、そのまま結果に残る
    const mine = t.r.session.messages(t.pid).filter((m) => m.seq > seq0 && !(m.type === 'damaged' && (m.event as Record<string, unknown>).target === t.meId));
    const firstOthers = mine.filter((m) => m.type !== 'xp_gained').slice(0, 3);
    expect(firstOthers.length).toBe(3);
    for (const m of firstOthers) expect(k.ok && k.outcome).toContain(m.text);
    expect(t.messages()).toContain('レベル 2 に上がった');
    // 新しい深さに初めて着く
    t.clearMonsters();
    const down = t.world.floors[key].stairs.down[0];
    t.place(down.x, down.y);
    const s = await t.act({ type: 'stairs' });
    expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
    const nd = content.balance.xp.perNewDepth * 2;
    expect(t.messages()).toContain(`経験値 +${nd}（初めて地下2階に着いた）。`);
    expect(s.ok && s.outcome).toContain(`経験値 +${nd}（初めて地下2階に着いた）`);
    // 階を移った知らせは「新しい階」と書かない（前に来た階でも出る。S0b §6.2 の 4）
    const moved = t.r.session.history.filter((e) => e.type === 'entity_changed_floor').at(-1)!;
    const obs = buildObservation(projectPlayerView(t.world, t.pid), catalog, { detail: 'brief', map: false, recent: [{ seq: moved.seq, type: moved.type, text: '', event: moved as never }] });
    expect(obs.alerts.find((a) => a.code === 'new_floor')?.text).toBe('階を移った（地下2階）');
    expect(JSON.stringify(obs.alerts)).not.toContain('新しい階');
    // 遠征の目的を達成する（目標の階の下り階段に立つ）
    t.clearMonsters();
    const key2 = t.me().pos!.floor;
    const target = t.world.expeditions!.at(-1)!.objective.targetDepth!;
    expect(target).toBe(2);
    const down2 = t.world.floors[key2].stairs.down[0];
    t.place(down2.x, down2.y);
    expect((await t.act({ type: 'wait' })).ok).toBe(true);
    const ob = content.balance.xp.perObjective * target;
    expect(t.messages()).toContain(`経験値 +${ob}（遠征の目的を達成した）。`);
    // 理由は engine の出来事が持つ（S1 §8.9 の 2。S0b では射影が出来事の順から決めていた）。射影はそのまま渡す
    const raw = t.r.session.history.filter((e) => e.type === 'xp_gained');
    expect(raw.length).toBe(3);
    expect(raw.map((e) => e.type === 'xp_gained' && e.reason)).toEqual(['kill', 'depth', 'objective']);
    const view = projectPlayerView(t.world, t.pid);
    const pe = filterEventsForPlayer(t.r.session.history, t.pid, view).filter((e) => e.type === 'xp_gained') as unknown as Record<string, unknown>[];
    expect(pe.map((e) => e.reason)).toEqual(['kill', 'depth', 'objective']);
    expect(pe[0].victimKind).toBe('core:goblin');
    expect(pe[1].depth).toBe(2);
    // 前に来た深さに戻っても経験値は入らない
    const up = t.world.floors[key2].stairs.up!;
    t.place(up.x, up.y);
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    t.clearMonsters();
    t.place(down.x, down.y);
    expect((await t.act({ type: 'stairs' })).ok).toBe(true);
    expect(t.r.session.history.filter((e) => e.type === 'xp_gained').length).toBe(3);
    t.manager.closeAll();
  });

  it('an XP gain without a known reason still reads as a gain (no reason is made up); spectators get no XP line', () => {
    const ev = { type: 'xp_gained', target: 'e_aaaaaa', amount: 3, xpAfter: 9, seq: 5, cause: 2, floor: 'main:1', ft: 0, wall: 0 };
    const view = { self: { id: 'e_aaaaaa' } } as unknown as Parameters<typeof filterEventsForPlayer>[2];
    const pe = filterEventsForPlayer([{ ...ev, seenBy: ['p_1'] } as unknown as GameEvent], 'p_1', view);
    expect((pe[0] as Record<string, unknown>).reason).toBeUndefined();
    const ctx = { locale: 'ja' as const, catalog, selfId: 'e_aaaaaa', playerNames: {} };
    expect(narrate(pe[0], ctx)).toBe('経験値 +3。');
    // 俯瞰（自分のいない観戦）では文にしない
    expect(narrate(pe[0], { ...ctx, selfId: null })).toBeNull();
  });

  it('the projection passes the engine\'s reasons through and makes none up (S1 §8.9-2: no more guessing from the order of events)', () => {
    const me = 'e_me0001';
    const view = { self: { id: me } } as unknown as Parameters<typeof filterEventsForPlayer>[2];
    let seq = 0;
    const ev = (o: Record<string, unknown>, cause = 7) => ({ seq: ++seq, cause, floor: 'main:3', ft: 0, wall: 0, seenBy: ['p_1'], ...o }) as unknown as GameEvent;
    const died = ev({ type: 'died', id: 'e_m00001', kind: 'core:goblin', killer: me, killerKind: 'core:warrior', via: 'melee', pos: { x: 1, y: 1 } });
    const reasons = (events: GameEvent[]) => (filterEventsForPlayer(events, 'p_1', view).filter((e) => e.type === 'xp_gained') as unknown as Record<string, unknown>[])
      .map((e) => `${e.reason ?? '-'}:${e.victimKind ?? e.depth ?? ''}`);
    // 理由の無い古い出来事は、直前に倒した文があっても理由を付けない
    expect(reasons([died, ev({ type: 'xp_gained', target: me, amount: 3, xpAfter: 50 })])).toEqual(['-:']);
    // engine の理由はそのまま（伏せた相手は null で「何かを倒した」）
    expect(reasons([ev({ type: 'xp_gained', target: me, amount: 3, xpAfter: 50, reason: 'kill', victimKind: 'core:goblin', victimAffixes: null })])).toEqual(['kill:core:goblin']);
    const px = filterEventsForPlayer([ev({ type: 'xp_gained', target: me, amount: 3, xpAfter: 53, reason: 'kill', victimKind: null, victimAffixes: null })], 'p_1', view)[0];
    expect(narrate(px, { locale: 'ja', catalog, selfId: me, playerNames: {} })).toBe('経験値 +3（何かを倒した）。');
    expect(reasons([ev({ type: 'xp_gained', target: me, amount: 12, xpAfter: 60, reason: 'depth', depth: 3 })])).toEqual(['depth:3']);
  });

  it('XP lines do not take the slots of capped lists (the recent events of the observation)', async () => {
    const items = [{ type: 'a' }, { type: 'xp_gained' }, { type: 'b' }, { type: 'xp_gained' }, { type: 'c' }];
    expect(lastWithoutXp(items, 2).map((x) => x.type)).toEqual(['b', 'xp_gained', 'c']);
    expect(lastWithoutXp(items, 9).length).toBe(5);
    // 観測の直前の出来事: 経験値でない 10 件は、経験値の文が混ざっても全部残る
    const t = await newRun('s0b-recent-1');
    const recent = Array.from({ length: 12 }, (_, i) => ({ seq: i * 2 + 1, type: 'item_picked_up' as const, text: `知らせ ${i}`, event: {} as never }))
      .flatMap((e, i) => (i % 3 === 0 ? [e, { seq: e.seq + 1, type: 'xp_gained' as const, text: `経験値 +${i}。`, event: {} as never }] : [e]));
    const obs = buildObservation(projectPlayerView(t.world, t.pid), catalog, { detail: 'brief', map: false, recent });
    expect(obs.recent_events.filter((s) => s.startsWith('知らせ'))).toEqual(Array.from({ length: 10 }, (_, i) => `知らせ ${i + 2}`));
    expect(obs.recent_events).toContain('経験値 +3。');
    t.manager.closeAll();
  });
});

describe('S0b §6.2-2: the fight total and the killing-blow line do not look inconsistent', () => {
  it('the total counts HP actually removed and names the overkill of the finishing blow; the pilot still reads the numbers', async () => {
    const t = await newRun('s0b-fight-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    t.edit((e) => { e.stats!.acc = 60; });
    const b = besideMe(t);
    t.inject({ put: [monster('e_s0bf01', 'core:goblin', key, b.x, b.y, { hp: 1, xp: 1 })] });
    const r = await t.act({ type: 'fight', target: 'e_s0bf01' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dmg = t.r.session.history.find((e) => e.type === 'damaged' && e.target === 'e_s0bf01');
    expect(dmg && dmg.type === 'damaged' && dmg.dealt).toBe(1);
    const amount = dmg && dmg.type === 'damaged' ? dmg.amount : 0;
    expect(amount).toBeGreaterThan(1);
    expect(t.messages()).toContain(`${amount} ダメージを与えた（とどめ。残りは 1 だった）`);
    expect(r.outcome).toContain(`合計 1 ダメージを与えた（実際に減らした HP。とどめの一撃の超過分 ${amount - 1} は含まない）`);
    expect(fightNumbers(r.outcome)).toMatchObject({ hits: 1, dealt: 1 });
    t.manager.closeAll();
  });

  it('a fight without overkill has no note', async () => {
    const t = await newRun('s0b-fight-2');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    t.edit((e) => { e.stats!.acc = 60; });
    const b = besideMe(t);
    // 倒れない相手（体力が多い）: 超過は無い。fight はほかの理由（hp_floor など）で止まる
    t.inject({ put: [monster('e_s0bf02', 'core:goblin', key, b.x, b.y, { hp: 5000, xp: 1 })] });
    const r = await t.act({ type: 'fight', target: 'e_s0bf02' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(t.world.entities.e_s0bf02).toBeDefined();
    expect(r.outcome).toMatch(/合計 \d+ ダメージを与えた/);
    expect(r.outcome).not.toContain('超過分');
    t.manager.closeAll();
  });

  it('a fight without overkill keeps the old sentence', () => {
    expect(fightNumbers('fight: 3 手進んだ。 3 回攻撃し 2 回命中・合計 9 ダメージを与えた（実際に減らした HP。とどめの一撃の超過分 2 は含まない）（待った手番 1）。')).toEqual({ melee: 3, throws: 0, hits: 2, dealt: 9 });
    expect(fightNumbers('Swung 3 times, 2 hit for 9 total (HP actually removed; the finishing blow\'s 2 overkill is not counted).')).toEqual({ melee: 3, throws: 0, hits: 2, dealt: 9 });
  });
});

describe('S0b §6.2-1・§6.2-4: the rules text', () => {
  it('XP is explained in one place; floors persist for the run (and are the same for everyone in a season)', () => {
    for (const L of ['ja', 'en'] as const) {
      const all = rulesText('all', L, catalog);
      const head = L === 'ja' ? '## 経験値とレベル' : '## XP and levels';
      expect(all.split(head).length - 1).toBe(1);
      expect(rulesText('combat', L, catalog)).toContain(head);
      // 入り方の数は 1 か所だけ（ほかの話題は、そこを指す）
      const per = L === 'ja' ? `${content.balance.xp.perNewDepth} × その深さ` : `${content.balance.xp.perNewDepth} x that depth`;
      expect(all.split(per).length - 1).toBe(1);
      expect(all).not.toContain(L === 'ja' ? '撃破の経験値は深いほど多い' : 'Kill XP grows with depth');
      expect(rulesText('overview', L, catalog)).toContain(L === 'ja' ? '階は、ランの間、作られたまま残る。' : 'Floors persist for the whole run.');
      expect(rulesText('season', L, catalog)).toContain(L === 'ja' ? '作られたまま残る' : 'Floors persist for the whole run');
      expect(rulesText('combat', L, catalog)).toContain(L === 'ja' ? 'とどめの一撃の超過分' : "finishing blow's 1 overkill");
    }
  });
});

describe('S0b §6.2-5: cancelling an invitation', () => {
  it('only invitees who never started a run can be uninvited; the profile then cannot start a season run and the name is free again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s0b-'));
    try {
      const m = new SessionManager(content, loadConfig({ runsDir: dir }));
      m.seasons.store.open({ id: 's0b', name: 'S0b', seed: 's0b-season', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 300, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
      const cli = (a: Record<string, unknown>) => { const out: string[] = []; const code = seasonCli(content, { dir: join(dir, 'seasons'), profilesDir: join(dir, 'profiles'), id: 's0b', ...a } as Parameters<typeof seasonCli>[1], (x) => out.push(x)); return { code, out: out.join('\n') }; };
      const tokenOf = (s: string) => /profile_token: (\S+)/.exec(s)![1];
      const a = cli({ sub: 'invite', name: 'Alice' });
      const b = cli({ sub: 'invite', name: 'Bob' });
      expect(a.code + b.code).toBe(0);
      const started = await m.createRun({ name: 'A', controller: agent, season: 's0b', profileToken: tokenOf(a.out) });
      if ('error' in started) throw new Error(started.error.message);
      // ランを始めた者は取り消せない
      const refused = cli({ sub: 'uninvite', name: 'alice' });
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('1 回始めている');
      // 取り消す（プロフィールの ID で）
      const bobId = m.seasons.store.invites('s0b').find((x) => x.name === 'Bob')!.profileId;
      const ok = cli({ sub: 'uninvite', profileId: bobId });
      expect(ok.code).toBe(0);
      expect(ok.out).toContain('招きを取り消した');
      expect(m.seasons.store.invites('s0b').map((x) => x.name)).toEqual(['Alice']);
      // そのプロフィールでは始められない（動いているサーバーはファイルを読み直す）
      const denied = await m.createRun({ name: 'B', controller: agent, season: 's0b', profileToken: tokenOf(b.out) });
      expect('error' in denied && denied.error.code).toBe('season_unavailable');
      expect('error' in denied && denied.error.message).toContain('招かれていない');
      // 表示名はまた使える。知らない名前・引数の無い取り消しは断る
      expect(cli({ sub: 'invite', name: 'bob' }).code).toBe(0);
      expect(cli({ sub: 'uninvite', name: 'Carol' }).code).toBe(1);
      expect(cli({ sub: 'uninvite' }).out).toContain('--name');
      expect(readFileSync(join(dir, 'seasons', 's0b', 'log.jsonl'), 'utf8')).toContain('"uninvited"');
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S0b §6.2-6: the call tool', () => {
  it('parses values by the tool schema (and the quote-less JSON PowerShell leaves)', () => {
    expect(parseValue('1')).toBe(1);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('{"x":3,"y":4}')).toEqual({ x: 3, y: 4 });
    expect(parseValue('{x:3,y:4}')).toEqual({ x: 3, y: 4 });
    expect(parseValue('[javelin,core:throwing_knife]')).toEqual(['javelin', 'core:throwing_knife']);
    expect(parseValue('stairs_down')).toBe('stairs_down');
    // 文字列しか受け取らない引数は、数字に見えても文字列
    expect(parseValue('123', { type: 'string' })).toBe('123');
    expect(parseValue('7', { anyOf: [{ type: 'integer' }, { type: 'string' }] })).toBe(7);
    expect(parsePairs(['dir=n', 'oops'])).toEqual({ args: { dir: 'n' }, bad: ['oops'] });
    expect(maskTokens('player_token: abcdefghij\nx', [{ value: 'abcdefghij', file: join(process.cwd(), 'trial-runs', 't', 'player-token.txt') }])).toBe(`player_token: ［伏せた: ${join('trial-runs', 't', 'player-token.txt')}］\nx`);
    const f = tokenFiles({ MUSE_TOKEN_DIR: 'trial-runs/p2' }, '/repo');
    expect(f.player.replace(/\\/g, '/')).toMatch(/trial-runs\/p2\/player-token\.txt$/);
    expect(f.profile.replace(/\\/g, '/')).toMatch(/trial-runs\/p2\/profile-token\.txt$/);
    expect(tokenFiles({ MUSE_TOKEN_FILE: 'a.txt', MUSE_PROFILE_TOKEN_FILE: 'b.txt' }, '/repo').profile.replace(/\\/g, '/')).toMatch(/\/b\.txt$/);
  });

  it('saves the tokens to files and masks them; later calls (resume_run too) carry them; a season run takes the saved profile token; wrong argument names get the game-form error that names the right argument', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-call-'));
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
    try {
      const env = { MUSE_MCP_URL: url, MUSE_TOKEN_DIR: join(dir, 'p1') };
      const call = async (...argv: string[]) => { const out: string[] = []; const code = await mcpCall(argv, env, (s) => out.push(s)); return { code, text: out.join('\n') }; };
      const nr = await call('new_run', 'character_name=Aki', 'objective=reach_depth');
      expect(nr.code).toBe(0);
      const files = tokenFiles(env);
      const ptok = readFileSync(files.player, 'utf8').trim();
      const prof = readFileSync(files.profile, 'utf8').trim();
      expect(ptok.length).toBeGreaterThan(10);
      expect(prof.length).toBeGreaterThan(10);
      expect(nr.text).toContain('player_token: ［伏せた:');
      expect(nr.text).toContain('profile_token: ［伏せた:');
      expect(nr.text).not.toContain(ptok);
      expect(nr.text).not.toContain(prof);
      // 次の呼び出しには保存したトークンが付く（resume_run も）
      const ob = await call('observe');
      expect(ob.code).toBe(0);
      expect(ob.text).toContain('あなたの番');
      const rs = await call('resume_run');
      expect(rs.code).toBe(0);
      expect(rs.text).toContain('現在地');
      expect(rs.text).not.toContain(ptok);
      const tools = await call('--tools');
      expect(tools.text).toContain('## travel_to');
      // §6.2 の 3（S1c §14.4 の 2 で改めた）: 引数の名前を間違えると、ゲームの断りの形で、無い名前と正しい名前と呼び方の例が出る
      const bad1 = await call('travel_to', 'target=stairs_down');
      expect(bad1.code).toBe(1);
      expect(bad1.text).toContain('travel_to には to が要る（渡されていない）。travel_to に target という名前の引数は無い。このツールの引数: 要る: to');
      expect(bad1.text).toContain("例: travel_to { to: 'stairs_down' }");
      const bad2 = await call('choose_perk', 'choice=1');
      expect(bad2.text).toContain('choose_perk には option が要る（渡されていない）。choose_perk に choice という名前の引数は無い。このツールの引数: 要る: option');
      // 2 つ目のラン: 上書きする前のトークンは *.old.txt に残る
      expect((await call('new_run', 'character_name=Aki2')).code).toBe(0);
      expect(readFileSync(files.player.replace(/\.txt$/, '.old.txt'), 'utf8')).toContain(ptok);
      // シーズン: 運用者から受け取ったプロフィールのトークンを profile-token.txt に置くと、new_run に付く
      m.seasons.store.open({ id: 's0c', name: 'S0c', seed: 's0c-season', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 300, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
      const inv = m.seasons.invite('s0c', 'Bee', m.profiles.store);
      if ('error' in inv) throw new Error(inv.error);
      const env2 = { MUSE_MCP_URL: url, MUSE_TOKEN_DIR: join(dir, 'p2') };
      mkdirSync(join(dir, 'p2'), { recursive: true });
      writeFileSync(tokenFiles(env2).profile, `${inv.token}\n`);
      const out2: string[] = [];
      expect(await mcpCall(['new_run', 'character_name=Bee', 'season=s0c'], env2, (s) => out2.push(s))).toBe(0);
      expect(out2.join('\n')).toContain('シーズン「S0c」');
      expect(out2.join('\n')).not.toContain(inv.token!);
      expect(existsSync(tokenFiles(env2).player)).toBe(true);
      // プレイヤーごとの置き場所は別（p1 のトークンは変わらない）
      expect(readdirSync(join(dir, 'p2')).sort()).toEqual(['player-token.txt', 'profile-token.txt']);
      // 呼んだ後にサーバーにセッションが残らない（セッションの終わりを送る。S0b §7.9）
      expect(app.mcp.sessionCount).toBe(0);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses without MUSE_PORT / MUSE_MCP_URL (7777 is the operator\'s server); error texts are masked too', async () => {
    const out: string[] = [];
    expect(await mcpCall(['observe'], { MUSE_TOKEN_DIR: 'x' }, (s) => out.push(s))).toBe(1);
    expect(out.join('\n')).toContain('MUSE_PORT');
    expect(out.join('\n')).toContain("$env:MUSE_PORT='7790'");
    expect(mcpUrl({ MUSE_PORT: '7795' })).toBe('http://127.0.0.1:7795/mcp');
    expect(mcpUrl({})).toBeNull();
    // エラーの文の中のトークンも伏せる（サーバーが本文にトークンを返す、行儀の悪い相手）
    const dir = mkdtempSync(join(tmpdir(), 'muse-call-'));
    const env = { MUSE_TOKEN_DIR: join(dir, 'p') } as Record<string, string>;
    mkdirSync(join(dir, 'p'), { recursive: true });
    const secret = 'secret-player-token-123456';
    writeFileSync(tokenFiles(env).player, `${secret}\n`);
    const bad = createServer((_req, res) => { res.writeHead(500); res.end(`broken ${secret}`); });
    await new Promise<void>((res) => bad.listen(0, '127.0.0.1', () => res()));
    try {
      env.MUSE_MCP_URL = `http://127.0.0.1:${(bad.address() as AddressInfo).port}/mcp`;
      const out2: string[] = [];
      expect(await mcpCall(['observe'], env, (s) => out2.push(s))).toBe(1);
      expect(out2.join('\n')).toContain('broken ［伏せた:');
      expect(out2.join('\n')).not.toContain(secret);
    } finally {
      await new Promise<void>((res) => bad.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S0b §7.9: idle MCP sessions are swept', () => {
  it('a client that never ends its session is swept after the idle time; its old session id gets 404 and a new connection can resume; open streams and bound sessions are kept longer', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    const connect = async (sessionId?: string) => {
      const transport = new StreamableHTTPClientTransport(url, sessionId ? { sessionId } : undefined);
      const client = new Client({ name: 'test', version: '0' });
      await client.connect(transport);
      return { client, transport };
    };
    const waitFor = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); };
    try {
      // 束縛しないクライアント（呼び出しごとに player_token を渡す）。終わりを送らずに切る
      const a = await connect();
      const nr = await a.client.callTool({ name: 'new_run', arguments: { character_name: 'Sweep', objective: 'reach_depth' } }) as unknown as { structuredContent: { player_token: string } };
      const token = nr.structuredContent.player_token;
      const b = await connect();
      await b.client.callTool({ name: 'observe', arguments: { player_token: token } });
      const bId = b.transport.sessionId!;
      // 開いたままの受信の流れ（GET の SSE）があるあいだは、何時間たっても掃除しない
      await waitFor(() => app.mcp.sessionInfo().some((s) => s.id === bId && s.active > 0));
      expect(app.mcp.sessionInfo().find((s) => s.id === bId)!.active).toBeGreaterThan(0);
      expect(app.mcp.sweep(Date.now() + 24 * 3600_000)).toBe(0);
      await b.transport.close();
      await a.transport.close();
      await waitFor(() => app.mcp.sessionInfo().every((s) => s.active === 0));
      expect(app.mcp.sessionCount).toBe(2);
      // 束縛していないものは 30 分、束縛した（new_run の）ものは 6 時間
      const info = app.mcp.sessionInfo();
      expect(info.find((s) => s.id === bId)!.bound).toBe(false);
      expect(info.find((s) => s.id === a.transport.sessionId)!.bound).toBe(true);
      expect(app.mcp.sweep(Date.now() + m.config.mcpIdleMs - 60_000)).toBe(0);
      expect(app.mcp.sweep(Date.now() + m.config.mcpIdleMs + 1000)).toBe(1);
      expect(app.mcp.sweep(Date.now() + m.config.mcpBoundIdleMs + 1000)).toBe(1);
      expect(app.mcp.sessionCount).toBe(0);
      // 掃除したセッションの ID で呼ぶ: MCP の決まりどおり 404（クライアントは新しい initialize でつなぎ直す）
      const stale = await connect(bId);
      const err = await stale.client.callTool({ name: 'observe', arguments: { player_token: token } }).then(() => null, (e: unknown) => e as { code?: number; message?: string });
      expect(err?.code).toBe(404);
      expect(err?.message).toContain('Unknown MCP session');
      await stale.transport.close();
      // つなぎ直して resume_run で戻れる
      const c = await connect();
      const rs = await c.client.callTool({ name: 'resume_run', arguments: { player_token: token } }) as unknown as { content: { text: string }[]; isError?: boolean };
      expect(rs.isError).toBeFalsy();
      expect(rs.content[0].text).toContain('現在地');
      await c.transport.terminateSession();
      await c.client.close();
      expect(app.mcp.sessionCount).toBe(0);
    } finally {
      await app.close();
    }
  });
});

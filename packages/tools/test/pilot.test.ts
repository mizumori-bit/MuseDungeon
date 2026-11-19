// V4-1（IMPROVEMENTS_V4 §10.8）: 代行 bot の作例 pilot。判断の表（純粋な関数）と、プロセスの中に立てたサーバーで動かした確認。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import type { ObsItem, ObsMonster, Observation } from '@muse/shared';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { afterAction, decide, DEFAULT_POLICY, defaultOrders, parseOrders, PILOT_TOOLS, retreat, runPilot } from '../src/index';
import type { DecideContext, PilotOrders, WakeEvent } from '../src/index';
import { simpleResponder } from '../src/pilot/responder';

const content = loadContent();

/** 遠征を始めたところの観測（判断の表の確認に使う。写しを書き換える） */
async function expeditionObs(seed = 'pilot-t'): Promise<{ obs: Observation; text: string }> {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'P', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
  if ('error' in r) throw new Error(r.error.message);
  expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
  const o = r.port.observe({});
  manager.closeAll();
  return { obs: structuredClone(o.observation), text: o.text };
}
function monster(over: Partial<ObsMonster>): ObsMonster {
  return {
    id: 'e_aaaaaa', name: 'テストの敵', pos: { x: 1, y: 1 }, dir: 'e', dist: 1, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [],
    worst_hit: 3, speed: 'normal', traits: [], worst_turn: 3, shot: 'clear', shots: [], ...over,
  } as ObsMonster;
}
function ctxOf(orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext {
  return { orders, coop: false, waiting: false, acked: new Set(), text: '', ...over };
}

describe('pilot の判断の表（§10.4〜§10.6）', () => {
  it('役割のある敵が見えたら、挑まずに起こす（返事の後は、役割の無い追ってくる敵とだけ戦う）', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = obs.alerts.filter((a) => a.code !== 'perk_pending' && a.code !== 'boon_pending');
    const g = monster({ id: 'e_guard1', role: 'guardian', guardian: { name: '荒ぶる者', types: [] }, dist: 1 });
    const foe = monster({ id: 'e_foe001', dist: 2 });
    obs.visible.monsters = [g, foe];
    const r1 = decide(obs, ctxOf());
    expect(r1.decision.kind).toBe('wake');
    if (r1.decision.kind === 'wake') { expect(r1.decision.wake.reason).toBe('guardian_seen_hunting'); expect(r1.decision.wake.key).toBe('guardian_seen_hunting:e_guard1'); }
    // 返事をもらった: 守護者には挑まず、役割の無い敵と戦う
    const r2 = decide(obs, ctxOf(defaultOrders(), { acked: new Set(['guardian_seen_hunting:e_guard1']) }));
    expect(r2.decision.kind).toBe('act');
    if (r2.decision.kind === 'act') { expect(r2.decision.tool).toBe('fight'); expect(r2.decision.args.target).toBe('e_foe001'); }
    // 賞金首・名前付きの強敵・大守護者も役割のある敵
    for (const [m, reason] of [[monster({ id: 'e_boun01', bounty: 300 }), 'elite_seen_hunting'], [monster({ id: 'e_name01', role: 'elite', named: '名' }), 'elite_seen_hunting'],
      [monster({ id: 'e_ward01', guardian: { name: '番人', types: [], warden: true }, awareness: 'unaware' }), 'warden_seen']] as const) {
      obs.visible.monsters = [m];
      const r = decide(obs, ctxOf());
      expect(r.decision.kind === 'wake' && r.decision.wake.reason).toBe(reason);
    }
  });

  it('遺物が見えたら、拾わずに起こす（いっぺんに見えた遺物はまとめて 1 回）', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = obs.alerts.filter((a) => a.code !== 'perk_pending' && a.code !== 'boon_pending');
    obs.visible.monsters = [];
    const relic = (id: string, dist: number): ObsItem => ({ id, name: '欠片', pos: { x: 2, y: 2 }, dir: 'e', dist, qty: 1, role: 'relic' });
    obs.visible.items = [relic('e_relic2', 5), relic('e_relic1', 2)];
    const r = decide(obs, ctxOf());
    expect(r.decision.kind).toBe('wake');
    if (r.decision.kind === 'wake') {
      expect(r.decision.wake.reason).toBe('relic_seen');
      expect(r.decision.wake.key).toBe('relic_seen:e_relic1');
      expect(r.decision.wake.also).toEqual(['relic_seen:e_relic2']);
    }
    // 返事の後も、遺物は拾いに行かない（collect は遺物を拾わない。探索などの表の次の行へ）
    const r2 = decide(obs, ctxOf(defaultOrders(), { acked: new Set(['relic_seen:e_relic1', 'relic_seen:e_relic2']) }));
    expect(r2.decision.kind === 'act' && r2.decision.tool === 'travel_to' && String(r2.decision.args.to).startsWith('e_relic')).toBe(false);
  });

  it('自分から使う道具は §10.4 の一覧の中。既定の方針では綱を使わず、遠征を選ばない', async () => {
    const { obs } = await expeditionObs();
    // 危ない（lethal_range）で綱を持っていても、既定の方針では綱を使わない
    obs.alerts = [{ code: 'lethal_range', text: '危ない', level: 'danger' } as Observation['alerts'][number]];
    obs.self.inventory = [...(obs.self.inventory ?? []), { slot: 'z', kind: 'core:lifeline', name: '帰還の綱', qty: 1 } as never];
    const rt = retreat(obs, DEFAULT_POLICY);
    expect(rt?.tool).not.toBe('use_item');
    const r = decide(obs, ctxOf());
    expect(r.decision.kind === 'act' && r.decision.tool === 'use_item').toBe(false);
    // 許したときだけ綱
    expect(retreat(obs, { ...DEFAULT_POLICY, allow_lifeline: true })?.tool).toBe('use_item');
    // 既定の方針: 綱は使わない・キャンプでは起こす
    const d = parseOrders({ rev: 1 });
    expect(d.policy.allow_lifeline).toBe(false);
    expect(d.camp.auto_start).toBeNull();
    expect(d.policy.after_objective).toBe('wake');
    for (const t of PILOT_TOOLS) expect(['observe', 'explore', 'travel_to', 'collect', 'fight', 'wait', 'use_stairs', 'extract', 'use_item', 'attack', 'move', 'start_expedition']).toContain(t);
  });

  it('知らない止まり方は unknown_stop。fight は倒した以外で止まったら起こす', () => {
    expect(afterAction('explore', 'brand_new_stop')).toEqual({ wake: true, reason: 'unknown_stop' });
    expect(afterAction('fight', 'brand_new_stop')).toEqual({ wake: true, reason: 'unknown_stop' });
    expect(afterAction('fight', 'target_down')).toEqual({ wake: false });
    expect(afterAction('fight', 'cleared')).toEqual({ wake: false });
    expect(afterAction('fight', 'target_shooting')).toEqual({ wake: true, reason: 'fight_target_shooting' });
    expect(afterAction('explore', 'hostile_in_view')).toEqual({ wake: false });
    expect(afterAction('travel_to', 'blocked')).toEqual({ wake: true, reason: 'blocked' });
    expect(afterAction('explore', undefined)).toEqual({ wake: false });
  });

  it('壊れた orders.json は Error（pilot は読まずに前の方針のまま起こす）。知らない項目は無視、型の違う項目は既定値', () => {
    expect(() => parseOrders('x')).toThrow();
    expect(() => parseOrders({ queue: [] })).toThrow();
    expect(() => parseOrders({ rev: 1, queue: [{ args: {} }] })).toThrow();
    const o = parseOrders({ rev: 2, mode: 'nonsense', extra: 1, policy: { wake_hp_pct: 'x', fight: false, unknown: true } });
    expect(o.mode).toBe('auto');
    expect(o.policy.wake_hp_pct).toBe(DEFAULT_POLICY.wake_hp_pct);
    expect(o.policy.fight).toBe(false);
  });
});

// ---- プロセスの中のサーバーで動かす ----

interface Harness { base: string; token: string; dir: string; wakes: WakeEvent[]; close: () => Promise<void> }
async function harness(mode: 'solo' | 'coop' = 'solo', orders?: unknown): Promise<Harness> {
  const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
  const manager = new SessionManager(content, config);
  const app = createApp(manager, config);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const r = await manager.createRun({ name: 'Pilot', seed: `pilot-test-${mode}`, classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' }, mode });
  if ('error' in r) throw new Error(r.error.message);
  const dir = mkdtempSync(join(tmpdir(), 'muse-pilot-test-'));
  if (orders !== undefined) writeFileSync(join(dir, 'orders.json'), typeof orders === 'string' ? orders : JSON.stringify(orders));
  return { base, token: r.token, dir, wakes: [], close: async () => { manager.closeAll(); await new Promise<void>((r2) => app.server.close(() => r2())); } };
}
const rows = (dir: string): Record<string, unknown>[] => (existsSync(join(dir, 'log.jsonl')) ? readFileSync(join(dir, 'log.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
async function until(cond: () => boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
function start(h: Harness, opts: { responder?: (ev: WakeEvent) => void; mode?: 'solo' | 'coop'; maxActions?: number } = {}) {
  const ac = new AbortController();
  const done = runPilot({
    baseUrl: h.base, token: h.token, dir: h.dir, pollMs: 20, log: () => {}, signal: ac.signal, maxActions: opts.maxActions ?? 5000, ...(opts.mode ? { mode: opts.mode } : {}),
    onWake: (ev) => { h.wakes.push(ev); opts.responder?.(ev); },
  });
  return { stop: async () => { ac.abort(); return done; }, done };
}
const writeOrders = (h: Harness, o: unknown) => writeFileSync(join(h.dir, 'orders.json'), JSON.stringify(o));

describe('pilot をサーバーにつないで動かす（§10.8）', () => {
  it('簡単な返事の相手と組ませる: pilot が自分から出す命令は既定の方針の道具だけ（綱・遠征の選択・1 手の攻撃と移動は出さない）', async () => {
    const h = await harness();
    const p = start(h, { responder: simpleResponder, maxActions: 250 });
    const res = await p.done;
    expect(res.outcome).toBe('safety');
    const own = rows(h.dir).filter((r) => r.source === 'pilot').map((r) => r.tool as string);
    expect(own.length).toBeGreaterThan(20);
    for (const t of own) expect(['explore', 'travel_to', 'collect', 'fight', 'wait', 'use_stairs', 'extract']).toContain(t);
    // 遠征は返事の相手が queue で選ぶ
    expect(rows(h.dir).some((r) => r.source === 'queue' && r.tool === 'start_expedition')).toBe(true);
    // state.json と命令ごとの記録
    const st = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
    expect(st.run_id).toMatch(/.+/);
    expect(typeof st.summary).toBe('string');
    for (const r of rows(h.dir).filter((x) => x.tool)) expect(typeof r.turn).toBe('number');
    await h.close();
  }, 60000);

  it('ソロ: 起こしたら rev が変わるまで次の命令を出さない', async () => {
    const h = await harness();
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'camp'));
    // 既定の方針（camp.auto_start: null）: キャンプで起こして、出発しない
    expect(existsSync(join(h.dir, 'orders.json'))).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(rows(h.dir).filter((r) => r.tool)).toHaveLength(0);
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).status).toBe('camp');
    // 返事: rev を上げて、出発の命令
    writeOrders(h, { ...defaultOrders(), rev: 2, queue: [{ tool: 'start_expedition', args: { offer: 1 } }] });
    await until(() => rows(h.dir).some((r) => r.tool === 'start_expedition' && r.source === 'queue' && r.ok === true));
    await until(() => rows(h.dir).some((r) => r.source === 'pilot'));
    const res = await p.stop();
    expect(res.outcome).toBe('stopped');
    await h.close();
  }, 30000);

  it('queue は方針より先に実行し、失敗したら残りを捨てて起こす', async () => {
    const h = await harness('solo', { rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }, { tool: 'use_item', args: { slot: 'z' } }, { tool: 'wait', args: {} }] });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'queue_failed'));
    await new Promise((r) => setTimeout(r, 200));
    const cmds = rows(h.dir).filter((r) => r.tool);
    expect(cmds.map((r) => `${r.source}:${r.tool}:${r.ok}`)).toEqual(['queue:start_expedition:true', 'queue:use_item:false']);
    await p.stop();
    await h.close();
  }, 30000);

  it('壊れた orders.json は読まずに起こす（orders_invalid）。前の方針のまま、直ったら続ける', async () => {
    const h = await harness('solo', '{ broken');
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'orders_invalid'));
    // 起こしたので、直るまで（rev が変わるまで）待つ
    await new Promise((r) => setTimeout(r, 300));
    expect(h.wakes.some((w) => w.reason === 'camp')).toBe(false);
    const rev0 = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).orders_rev;
    writeOrders(h, { rev: rev0 + 1 });
    await until(() => h.wakes.some((w) => w.reason === 'camp'));
    // 途中で壊れた: もう一度 orders_invalid。rev は前のまま
    const before = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).orders_rev;
    expect(before).toBe(rev0 + 1);
    writeFileSync(join(h.dir, 'orders.json'), '{ "rev": ');
    await until(() => h.wakes.filter((w) => w.reason === 'orders_invalid').length >= 2);
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).orders_rev).toBe(before);
    expect(rows(h.dir).filter((r) => r.tool)).toHaveLength(0);
    writeOrders(h, { rev: before + 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }] });
    await until(() => rows(h.dir).some((r) => r.tool === 'start_expedition'));
    await p.stop();
    await h.close();
  }, 30000);

  it('協力プレイ: 起こして待っている間も、毎手番すぐに持ち場の動きで答え、hold_max_turns ごとに起こし直す', async () => {
    // wake_hp_pct 101: 遠征が始まるとすぐ low_hp で起こす。返事はしない
    const h = await harness('coop', { rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }], policy: { wake_hp_pct: 101, hold_max_turns: 5 } });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'low_hp'));
    const t0 = Date.now();
    const after = () => { const rs = rows(h.dir); const i = rs.findIndex((r) => r.wake === 'low_hp'); return rs.slice(i + 1).filter((r) => r.tool); };
    await until(() => after().length >= 12, 20000);
    const elapsed = Date.now() - t0;
    // 1 手番あたり、時間切れ（30 秒）より十分に早い
    expect(elapsed / 12).toBeLessThan(1500);
    for (const r of after()) {
      expect(r.source).toBe('pilot');
      expect(['wait', 'attack', 'move', 'extract', 'travel_to']).toContain(r.tool);
    }
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).status).toBe('holding');
    expect(h.wakes.some((w) => w.reason === 'still_waiting')).toBe(true);
    await p.stop();
    await h.close();
  }, 40000);

  it('mode: stop で終える', async () => {
    const h = await harness('solo', { rev: 1, mode: 'stop' });
    const res = await start(h).done;
    expect(res.outcome).toBe('stopped');
    await h.close();
  }, 20000);
});

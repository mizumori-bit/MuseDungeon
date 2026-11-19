// V4-1（IMPROVEMENTS_V4 §10.8）・V4-1b（§14.8）: 代行 bot の作例 pilot。判断の表（純粋な関数）と、プロセスの中に立てたサーバーで動かした確認。
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import type { Entity, ObsItem, ObsMonster, Observation } from '@muse/shared';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { afterAction, decide, DEFAULT_POLICY, defaultOrders, holdAction, newMemory, parseOrders, PILOT_TOOLS, retreat, runPilot } from '../src/index';
import type { DecideContext, PilotMemory, PilotOrders, WakeEvent } from '../src/index';
import { simpleResponder } from '../src/pilot/responder';
import { arena } from './v33duel';

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
  it('目的の役割のある敵が見えたら、挑まずに起こす（返事の後は、役割の無い追ってくる敵とだけ戦う）。目的でなければ 1 回知らせて続ける', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = obs.alerts.filter((a) => a.code !== 'perk_pending' && a.code !== 'boon_pending');
    const g = monster({ id: 'e_guard1', role: 'guardian', guardian: { name: '荒ぶる者', types: [] }, dist: 1, objective: true });
    const foe = monster({ id: 'e_foe001', dist: 2 });
    obs.visible.monsters = [g, foe];
    const r1 = decide(obs, ctxOf());
    expect(r1.decision.kind).toBe('wake');
    if (r1.decision.kind === 'wake') { expect(r1.decision.wake.reason).toBe('guardian_seen_hunting'); expect(r1.decision.wake.key).toBe('guardian_seen_hunting:e_guard1'); }
    // 返事をもらった: 守護者には挑まず、役割の無い敵と戦う
    const r2 = decide(obs, ctxOf(defaultOrders(), { acked: new Set(['guardian_seen_hunting:e_guard1']) }));
    expect(r2.decision.kind).toBe('act');
    if (r2.decision.kind === 'act') { expect(r2.decision.tool).toBe('fight'); expect(r2.decision.args.target).toBe('e_foe001'); }
    // 賞金首・名前付きの強敵・大守護者も役割のある敵（目的なら起こす）
    for (const [m, reason] of [[monster({ id: 'e_boun01', bounty: 300, objective: true }), 'elite_seen_hunting'], [monster({ id: 'e_name01', role: 'elite', named: '名', objective: true }), 'elite_seen_hunting'],
      [monster({ id: 'e_ward01', guardian: { name: '番人', types: [], warden: true }, awareness: 'unaware', objective: true }), 'warden_seen']] as const) {
      obs.visible.monsters = [m];
      const r = decide(obs, ctxOf());
      expect(r.decision.kind === 'wake' && r.decision.wake.reason).toBe(reason);
    }
    // 目的でない守護者（V4-1a §12.6）: 止まらずに 1 回知らせ、挑まない（役割の無い敵と戦う）
    const other = monster({ id: 'e_guard2', role: 'guardian', guardian: { name: '別の守護者', types: [] }, dist: 1 });
    obs.visible.monsters = [other, foe];
    const r3 = decide(obs, ctxOf());
    expect(r3.decision.kind === 'act' && r3.decision.tool === 'fight' && r3.decision.args.target).toBe('e_foe001');
    expect(r3.notify.map((n) => `${n.level}:${n.reason}:${n.key}`)).toEqual(['notify:guardian_seen_hunting:guardian_seen_hunting:e_guard2']);
    // 知らせた後は、同じ階にいる間は知らせない
    expect(decide(obs, ctxOf(defaultOrders(), { notified: new Set(['guardian_seen_hunting:e_guard2']) })).notify).toEqual([]);
    // 守護者しかいなければ、挑まずに表の先へ（fight を出さない）
    obs.visible.monsters = [other];
    const r4 = decide(obs, ctxOf());
    expect(r4.decision.kind === 'act' && r4.decision.tool === 'fight').toBe(false);
  });

  it('目的の遺物が見えたら、拾わずに起こす（いっぺんに見えた遺物はまとめて 1 回）。目的でない遺物は 1 回知らせて続ける', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = obs.alerts.filter((a) => a.code !== 'perk_pending' && a.code !== 'boon_pending');
    obs.visible.monsters = [];
    const relic = (id: string, dist: number, objective = true): ObsItem => ({ id, name: '欠片', pos: { x: 2, y: 2 }, dir: 'e', dist, qty: 1, role: 'relic', ...(objective ? { objective: true as const } : {}) });
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
    // 前の遠征の遺物（目的でない）: 起こさずに 1 回知らせる（V4-1a §12.6）
    obs.visible.items = [relic('e_oldrl1', 3, false), relic('e_oldrl2', 6, false)];
    const r3 = decide(obs, ctxOf());
    expect(r3.decision.kind).toBe('act');
    expect(r3.notify.map((n) => `${n.level}:${n.key}`)).toEqual(['notify:relic_seen:e_oldrl1']);
    expect(r3.notify[0]!.also).toEqual(['relic_seen:e_oldrl2']);
  });

  it('移動が断られて何も残らないときは refused_<code> で起こし、じゃまをしている敵（blocked_by）の観測の行を detail の先頭に添える（自分からは戦わない）', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = [];
    obs.visible.items = [];
    obs.self.hp = obs.self.max_hp;
    obs.navigation.collectable = { count: 0, ids: [] };
    obs.navigation.known_stairs = [];
    obs.visible.monsters = [monster({ id: 'e_near01', dist: 1, awareness: 'unaware' }), monster({ id: 'e_block1', dist: 3, awareness: 'asleep' })];
    const text = [obs.summary, '- 近くの敵 e_near01 (1,1) 東1', '- ふさぐ敵 e_block1 (3,1) 東3'].join('\n');
    const r = decide(obs, ctxOf(defaultOrders(), { text, refused: new Set(['explore']), refusal: { code: 'blocked', text: 'blocked: 既知の経路が敵にふさがれていて進めない', blockedBy: ['e_block1'] } }));
    expect(r.decision.kind).toBe('wake');
    if (r.decision.kind === 'wake') {
      expect(r.decision.wake.reason).toBe('refused_blocked');
      const lines = r.decision.wake.detail.split('\n');
      expect(lines[0]).toBe('- ふさぐ敵 e_block1 (3,1) 東3');
      expect(lines[1]).toBe(obs.summary);
      // ほかの見えている者は後ろに（じゃまをしている敵は二度書かない）
      expect(lines.filter((l) => l.includes('e_block1'))).toHaveLength(1);
      expect(lines.at(-1)).toContain('e_near01');
    }
  });

  it('封じられた下り階段へは下りに行かない。拾える品は navigation.collectable で見る。方針の approach を fight に渡す', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = obs.alerts.filter((a) => a.code !== 'perk_pending' && a.code !== 'boon_pending');
    obs.visible.monsters = [];
    obs.visible.items = [];
    obs.self.hp = obs.self.max_hp;
    obs.navigation.frontiers = [];
    obs.navigation.unsighted = 0;
    obs.navigation.collectable = { count: 0, ids: [] };
    obs.expedition = { ...obs.expedition!, status: 'in_progress', objective: { ...obs.expedition!.objective, type: 'slay_guardian', target_depth: 5 } };
    obs.self.floor = { ...obs.self.floor!, depth: 3 };
    const st = { type: 'down' as const, pos: { x: 9, y: 9 }, dist: 4, reachable: true, path_len: 4 };
    obs.navigation.known_stairs = [st];
    const r1 = decide(obs, ctxOf());
    expect(r1.decision.kind === 'act' && r1.decision.tool).toBe('travel_to');
    obs.navigation.known_stairs = [{ ...st, sealed: true }];
    const r2 = decide(obs, ctxOf());
    expect(r2.decision.kind === 'act' && r2.decision.tool === 'travel_to').toBe(false);
    // collect は collectable の数だけで決める（valid_actions の文字列は見ない）
    obs.valid_actions = [...obs.valid_actions, 'collect what:items (x)'];
    expect(decide(obs, ctxOf()).decision.kind === 'act' && (decide(obs, ctxOf()).decision as { tool: string }).tool === 'collect').toBe(false);
    obs.navigation.collectable = { count: 2, ids: ['e_a', 'e_b'] };
    const r3 = decide(obs, ctxOf());
    expect(r3.decision.kind === 'act' && r3.decision.tool).toBe('collect');
    // approach: 方針のまま fight に渡す（pilot は自分で切り替えない）
    obs.visible.monsters = [monster({ id: 'e_foe002', dist: 4 })];
    const r4 = decide(obs, ctxOf());
    expect(r4.decision.kind === 'act' && r4.decision.args.approach).toBeUndefined();
    const o = defaultOrders();
    o.policy.approach = 'advance';
    const r5 = decide(obs, ctxOf(o));
    expect(r5.decision.kind === 'act' && r5.decision.args.approach).toBe('advance');
    expect(parseOrders({ rev: 1, policy: { approach: 'x' } }).policy.approach).toBe('auto');
    // auto: 寄ってやり直すと決めた相手（pilot の記録）だけ advance
    const mem: PilotMemory = { ...newMemory(), advance: ['e_foe002'] };
    const r6 = decide(obs, ctxOf(defaultOrders(), { mem }));
    expect(r6.decision.kind === 'act' && r6.decision.args.approach).toBe('advance');
  });

  it('自分から使う道具は §10.4 の一覧の中。既定の方針では綱を使わず、遠征を選ばない', async () => {
    const { obs } = await expeditionObs();
    // 危ない（lethal_range）で綱を持っていても、既定の方針では綱を使わない
    obs.alerts = [{ code: 'lethal_range', text: '危ない', level: 'danger' } as Observation['alerts'][number]];
    obs.self.inventory = [...(obs.self.inventory ?? []), { slot: 'z', kind: 'core:lifeline', name: '帰還の綱', qty: 1 } as never];
    const rt = retreat(obs, DEFAULT_POLICY);
    expect(rt?.tool).not.toBe('use_item');
    const r = decide(obs, ctxOf());
    // 回復の品（最初の所持品の薬。観測の self.recovery）は使ってよいが、綱は使わない
    expect(r.decision.kind === 'act' && r.decision.tool === 'use_item' && r.decision.args.slot === 'lifeline').toBe(false);
    obs.self.recovery = [];
    const r0 = decide(obs, ctxOf());
    expect(r0.decision.kind === 'act' && r0.decision.tool === 'use_item').toBe(false);
    // 許したときだけ綱
    expect(retreat(obs, { ...DEFAULT_POLICY, allow_lifeline: true })?.tool).toBe('use_item');
    // 既定の方針: 綱は使わない・キャンプでは起こす
    const d = parseOrders({ rev: 1 });
    expect(d.policy.allow_lifeline).toBe(false);
    expect(d.camp.auto_start).toBeNull();
    // §14.1: 目的を果たしたら帰る・目的の相手と特技では起こす・決着しない戦いは 2 回で諦める・寄り方は auto
    expect(d.policy.after_objective).toBe('extract');
    expect(d.policy.engage_objective).toBe(false);
    expect(d.policy.perk).toBe('wake');
    expect(d.policy.give_up_after).toBe(2);
    expect(d.policy.approach).toBe('auto');
    expect(d.policy.queue_on_fail).toBe('discard');
    expect(d.policy.retreat_via_stairs).toBeNull();
    expect(parseOrders({ rev: 1, mode: 'stop_at_camp' }).mode).toBe('stop_at_camp');
    expect(d.policy.allow_heal).toBe(true);
    for (const t of PILOT_TOOLS) expect(['observe', 'explore', 'travel_to', 'collect', 'fight', 'wait', 'rest', 'use_stairs', 'extract', 'use_item', 'use_ability', 'attack', 'move', 'start_expedition', 'choose_perk', 'choose_boon']).toContain(t);
  });

  it('止まり方の扱い（§14.1）: 知らない止まり方だけ起こす。fight が倒す前に止まった・移動が止まったは知らせて続ける', () => {
    expect(afterAction('explore', 'brand_new_stop')).toEqual({ kind: 'wake', reason: 'unknown_stop' });
    expect(afterAction('fight', 'brand_new_stop')).toEqual({ kind: 'wake', reason: 'unknown_stop' });
    expect(afterAction('fight', 'target_down')).toEqual({ kind: 'ok', killed: true });
    expect(afterAction('fight', 'cleared')).toEqual({ kind: 'ok', killed: true });
    expect(afterAction('fight', 'target_shooting')).toEqual({ kind: 'fight', reason: 'fight_target_shooting', recover: false, advance: true, count: true });
    // HP の止まり方は立て直しへ（諦める回数に数えない）。割り込み（状態異常など）も数えない
    expect(afterAction('fight', 'hp_risk')).toEqual({ kind: 'fight', reason: 'fight_hp_risk', recover: true, advance: false, count: false });
    expect(afterAction('fight', 'status_changed')).toEqual({ kind: 'fight', reason: 'fight_status_changed', recover: false, advance: false, count: false });
    expect(afterAction('fight', 'waiting_others')).toEqual({ kind: 'ok' });
    expect(afterAction('explore', 'hostile_in_view')).toEqual({ kind: 'ok' });
    expect(afterAction('travel_to', 'blocked')).toEqual({ kind: 'notify', reason: 'blocked' });
    expect(afterAction('explore', 'damage_taken')).toEqual({ kind: 'recover', reason: 'damage_taken' });
    expect(afterAction('explore', undefined)).toEqual({ kind: 'ok' });
  });

  it('特技は perk: first なら起こさずに最初の候補を選ぶ。目的の相手は engage_objective なら起こさずに挑む・拾う', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = [{ code: 'perk_pending', text: '特技を選べる', data: { level: 2, options: ['a', 'b'] } } as unknown as Observation['alerts'][number]];
    obs.visible.monsters = [];
    expect(decide(obs, ctxOf()).decision.kind).toBe('wake');
    const o = defaultOrders(); o.policy.perk = 'first';
    const r = decide(obs, ctxOf(o));
    expect(r.decision.kind === 'act' && `${r.decision.tool}:${r.decision.args.option}`).toBe('choose_perk:1');
    obs.alerts = [];
    obs.visible.monsters = [monster({ id: 'e_goal01', role: 'guardian', guardian: { name: '守', types: [] }, dist: 4, objective: true })];
    expect(decide(obs, ctxOf()).decision.kind).toBe('wake');
    const e = defaultOrders(); e.policy.engage_objective = true;
    const r2 = decide(obs, ctxOf(e));
    expect(r2.decision.kind === 'act' && r2.decision.tool).toBe('fight');
    if (r2.decision.kind === 'act') { expect(r2.decision.args.target).toBe('e_goal01'); expect(r2.decision.args.hp_floor).toBe(Math.floor(obs.self.max_hp / 2)); }
    obs.visible.monsters = [];
    obs.visible.items = [{ id: 'e_relic9', name: '欠片', pos: { x: 2, y: 2 }, dir: 'e', dist: 3, qty: 1, role: 'relic', objective: true }];
    const r3 = decide(obs, ctxOf(e));
    expect(r3.decision.kind === 'act' && `${r3.decision.tool}:${r3.decision.args.to}`).toBe('travel_to:e_relic9');
  });

  it('HP が減ったら起こさずに立て直しの段を上から試す（§14.3）: 休む → 階段へ行って階を移る → 仲間へ寄る → 来た道を戻る → 退く・起こす', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = [];
    obs.visible.items = [];
    obs.self.hp = Math.floor(obs.self.max_hp * 0.3);
    obs.visible.monsters = [];
    obs.navigation.known_stairs = [];
    // 1) 追ってくる敵がいない: 休む（知らせるだけ）
    const r1 = decide(obs, ctxOf());
    expect(r1.decision.kind === 'act' && r1.decision.tool).toBe('rest');
    expect(r1.notify.map((n) => `${n.level}:${n.reason}`)).toEqual(['notify:recovering']);
    expect(r1.update?.recovering).toBe(true);
    const mem: PilotMemory = { ...newMemory(), recovering: true, trail: [{ x: 1, y: 1 }, { x: 9, y: 9 }, { x: obs.self.pos!.x + 8, y: obs.self.pos!.y }] };
    // 2) 追ってくる敵がいて、階段へ「着ける」: 階段へ（追われたまま、flee）
    obs.visible.monsters = [monster({ id: 'e_chase1', dist: 3 })];
    obs.alerts = [{ code: 'escape', text: '階段まで 4 歩', data: { stairs: 'up', path_len: 4, worst_if_chased: 3, hp: obs.self.hp } } as unknown as Observation['alerts'][number]];
    const r2 = decide(obs, ctxOf(defaultOrders(), { mem }));
    expect(r2.decision.kind === 'act' && `${r2.decision.tool}:${r2.decision.args.to}:${r2.decision.args.mode}`).toBe('travel_to:stairs_up:flee');
    // 逃げる間の HP の下限: 見えている追跡中の敵の最悪の被害の 2 倍（最大 HP の 4 分の 1 より下げない・今の HP より 1 少ない所まで）
    if (r2.decision.kind === 'act') expect(r2.decision.args.hp_floor).toBe(Math.min(obs.self.hp - 1, Math.max(Math.floor(obs.self.max_hp / 4), 3 * 2)));
    // 階段の上: 階を移る（戻る階段を覚える）
    obs.navigation.known_stairs = [{ type: 'up', pos: obs.self.pos!, dist: 0, reachable: true, path_len: 0 }];
    const r3 = decide(obs, ctxOf(defaultOrders(), { mem }));
    expect(r3.decision.kind === 'act' && r3.decision.tool).toBe('use_stairs');
    expect(r3.update).toMatchObject({ crossed: 'down', stairRetreats: 1 });
    // 同じ階で 2 回退いた・協力プレイ（既定では階段を使わない）: 仲間の隣へ
    obs.navigation.known_stairs = [];
    obs.visible.players = [{ id: 'e_ally01', name: 'B', pos: { x: 0, y: 0 }, dir: 'w', dist: 5, hp_state: 'healthy' }];
    const r4 = decide(obs, ctxOf(defaultOrders(), { mem, coop: true }));
    expect(r4.decision.kind === 'act' && `${r4.decision.tool}:${r4.decision.args.to}`).toBe('travel_to:e_ally01');
    // 4) ソロで階段が無い: 来た道を戻る（6 マス以上離れた、歩いた跡のいちばん新しいマス）
    obs.visible.players = [];
    obs.alerts = [];
    const r5 = decide(obs, ctxOf(defaultOrders(), { mem }));
    expect(r5.decision.kind === 'act' && r5.decision.tool).toBe('travel_to');
    if (r5.decision.kind === 'act') expect(r5.decision.args.to).toEqual({ x: obs.self.pos!.x + 8, y: obs.self.pos!.y });
    // 隣に起きている敵がいて、階段にも仲間にも行けない: 殴る
    obs.visible.monsters = [monster({ id: 'e_chase1', dist: 1 })];
    const r6 = decide(obs, ctxOf(defaultOrders(), { mem }));
    expect(r6.decision.kind === 'act' && `${r6.decision.tool}:${r6.decision.args.target}`).toBe('attack:e_chase1');
    // 5) どれもできない: 起こす（danger）
    obs.visible.monsters = [monster({ id: 'e_chase1', dist: 3 })];
    const r7 = decide(obs, ctxOf(defaultOrders(), { mem: { ...mem, trail: [] } }));
    expect(r7.decision.kind === 'wake' && r7.decision.wake.reason).toBe('danger');
    // 休んで戻った: 立て直しは終わり、階を移っていたら戻る
    obs.self.hp = obs.self.max_hp;
    obs.visible.monsters = [];
    obs.navigation.known_stairs = [{ type: 'down', pos: obs.self.pos!, dist: 0, reachable: true, path_len: 0 }];
    const r8 = decide(obs, ctxOf(defaultOrders(), { mem: { ...mem, crossed: 'down' } }));
    expect(r8.update).toMatchObject({ recovering: false, crossed: null });
    expect(r8.decision.kind === 'act' && r8.decision.tool).toBe('use_stairs');
  });

  it('回復の手段（§16.3）: 退く手が無く倒されうるときだけ、鑑定済みの回復の品を使ってから起こす。能動技は品より先・立て直しの最初。未鑑定・allow_heal: false では使わない', async () => {
    const { obs } = await expeditionObs();
    obs.visible.items = [];
    obs.navigation.known_stairs = [];
    obs.self.hp = Math.floor(obs.self.max_hp * 0.2);
    obs.visible.monsters = [monster({ id: 'e_biter1', dist: 1, worst_turn: 99 })];
    obs.alerts = [{ code: 'lethal_range', text: '1 手で倒されうる', level: 'danger' } as unknown as Observation['alerts'][number]];
    const potion = { kind: 'item' as const, slot: 'c', name: '回復の薬', qty: 2, amount: '2d8+4' };
    const wind = { kind: 'ability' as const, id: 'second_wind', name: '立て直し', ready: true, amount: '最大 HP の 25%' };
    // 観測に回復の手段が無い（未鑑定の品は観測に入らない）: 使わずに起こす
    obs.self.recovery = [];
    expect(decide(obs, ctxOf()).decision.kind === 'wake' && (decide(obs, ctxOf()).decision as { wake: { reason: string } }).wake.reason).toBe('danger');
    // 鑑定済みの回復の品: 使って知らせ、使った後に起こす
    obs.self.recovery = [potion];
    const r1 = decide(obs, ctxOf());
    expect(r1.decision.kind === 'act' && `${r1.decision.tool}:${r1.decision.args.slot}`).toBe('use_item:c');
    expect(r1.decision.kind === 'act' && r1.decision.then?.reason).toBe('danger');
    expect(r1.notify.find((n) => n.reason === 'healed')?.detail).toBe('回復の薬 を使った（残り 1）');
    // allow_heal: false: 使わない
    const off = defaultOrders(); off.policy.allow_heal = false;
    expect(decide(obs, ctxOf(off)).decision.kind).toBe('wake');
    // 能動技は品より先（使っても減らない。使った後は起こさない）
    obs.self.recovery = [potion, wind];
    const r2 = decide(obs, ctxOf());
    expect(r2.decision.kind === 'act' && `${r2.decision.tool}:${r2.decision.args.id}`).toBe('use_ability:second_wind');
    expect(r2.decision.kind === 'act' && r2.decision.then).toBeUndefined();
    // 持ち場の動き（起こして待つ間）の 1 も同じ
    obs.self.recovery = [potion];
    expect(holdAction(obs, ctxOf(defaultOrders(), { waiting: true }))).toEqual({ tool: 'use_item', args: { slot: 'c' } });
    // 退く手があれば、品は使わない（階段の上: 階を移る）
    obs.navigation.known_stairs = [{ type: 'up', pos: obs.self.pos!, dist: 0, reachable: true, path_len: 0 }];
    const r3 = decide(obs, ctxOf());
    expect(r3.decision.kind === 'act' && r3.decision.tool).toBe('use_stairs');
    // 立て直しの最初（倒されうるほどでない）: 能動技だけ使う。品は使わない
    obs.navigation.known_stairs = [];
    obs.alerts = [];
    obs.visible.monsters = [monster({ id: 'e_biter1', dist: 3 })];
    obs.self.recovery = [potion, wind];
    const r4 = decide(obs, ctxOf());
    expect(r4.decision.kind === 'act' && r4.decision.tool).toBe('use_ability');
    obs.self.recovery = [potion];
    const r5 = decide(obs, ctxOf(defaultOrders(), { mem: { ...newMemory(), recovering: true } }));
    expect(r5.decision.kind === 'act' && r5.decision.tool === 'use_item').toBe(false);
  });

  it('起こして待つ間（§14.4）: 隣でない相手から被害を受けたら留まらない。追ってくる敵がいなければソロは何もしない。hold_max_turns の後は階段へ', async () => {
    const { obs } = await expeditionObs();
    obs.alerts = [];
    obs.visible.monsters = [];
    obs.navigation.known_stairs = [];
    const far = { x: obs.self.pos!.x + 7, y: obs.self.pos!.y };
    const mem: PilotMemory = { ...newMemory(), trail: [far] };
    expect(holdAction(obs, ctxOf(defaultOrders(), { waiting: true, mem }))).toBeNull();
    expect(holdAction(obs, ctxOf(defaultOrders(), { waiting: true, mem, coop: true }))?.tool).toBe('wait');
    const hurt = holdAction(obs, ctxOf(defaultOrders(), { waiting: true, mem: { ...mem, hurtFarAgo: 0 } }));
    expect(hurt?.tool).toBe('travel_to');
    expect(hurt?.args.to).toEqual(far);
    // 隣に起きている敵: 殴る
    obs.visible.monsters = [monster({ id: 'e_adj002', dist: 1 })];
    expect(holdAction(obs, ctxOf(defaultOrders(), { waiting: true, mem }))).toEqual({ tool: 'attack', args: { target: 'e_adj002' } });
    // hold_max_turns の後: 知っている階段へ。階段の上なら帰る
    obs.visible.monsters = [];
    obs.navigation.known_stairs = [{ type: 'up', pos: { x: 1, y: 1 }, dist: 6, reachable: true, path_len: 6 }];
    expect(holdAction(obs, ctxOf(defaultOrders(), { waiting: true, homeward: true, mem }))).toEqual({ tool: 'travel_to', args: { to: 'stairs_up', mode: 'flee', hp_floor: Math.min(obs.self.hp - 1, Math.floor(obs.self.max_hp / 4)) } });
    obs.navigation.known_stairs = [{ type: 'up', pos: obs.self.pos!, dist: 0, reachable: true, path_len: 0 }];
    obs.alerts = [{ code: 'on_stairs', text: '階段の上' } as unknown as Observation['alerts'][number]];
    obs.expedition = { ...obs.expedition!, can_extract: true, extract_outcome: 'withdraw' };
    expect(holdAction(obs, ctxOf(defaultOrders(), { waiting: true, homeward: true, mem }))).toEqual({ tool: 'extract', args: { confirm: true } });
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
type Ar = Awaited<ReturnType<typeof arena>>;
let esid = 999500;
const actor = (a: Ar, id: string, kind: string, x: number, y: number, o: { archetype: string; hp: number; dmg: string; state?: string }): Entity => ({
  id, kind, sid: ++esid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y },
  actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: o.archetype, state: o.state ?? 'hunting', targetPos: { x: a.ox, y: a.oy }, lostTurns: 0, params: {} } },
  stats: { hp: o.hp, maxHp: o.hp, acc: 3, eva: 0, might: 0, armor: 0, sight: 9, dmg: o.dmg }, base: { maxHp: o.hp, acc: 3, eva: 0, might: 0, armor: 0, sight: 9, dmg: o.dmg }, statuses: [],
} as unknown as Entity);
/** その場で撃つ骨の射手（体力は多め: 寄って殴っても 2 回のうちには倒れない） */
const shooter = (a: Ar, id: string, x: number, y: number) => actor(a, id, 'core:bone_archer', x, y, { archetype: 'ranged_stand', hp: 400, dmg: '1d1' });
const weakFoe = (a: Ar, id: string, x: number, y: number) => actor(a, id, 'core:goblin', x, y, { archetype: 'melee_chaser', hp: 3, dmg: '1d1' });
/** 決まった形の部屋に置いた場面に pilot をつなぐ（守護者は消す。部屋の右の壁を知らないことにして、探索できる所を残す） */
async function arenaHarness(seed: string, map: string[], put: (a: Ar) => Entity[], orders?: unknown | ((a: Ar) => unknown), o: { rubbleX?: number; unknown?: 'left' | 'right'; hp?: number; stairs?: [number, number] } = {}): Promise<{ h: Harness; a: Ar }> {
  const a = await arena(seed, { map, guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: o.hp ?? 400 } });
  a.inject({ del: [a.gId] });
  const f = a.world.floors[a.key];
  const fk = a.world.players[a.pid].knowledge.floors[a.key];
  // 上り階段（帰る側へ倒すときの行き先）
  if (o.stairs) {
    const st = a.world.meta.terrainTable.indexOf('core:stairs_up');
    const i = (a.oy + o.stairs[1]) * f.width + a.ox + o.stairs[0];
    f.terrain[i] = st; fk.seen[i] = st;
  }
  // 瓦礫の列（見通せるが通れない）
  if (o.rubbleX !== undefined) {
    const rb = a.world.meta.terrainTable.indexOf('core:rubble');
    for (let y = a.oy; y < a.oy + a.H; y++) { const i = y * f.width + a.ox + o.rubbleX; f.terrain[i] = rb; fk.seen[i] = rb; }
  }
  a.inject({ put: put(a) });
  await a.r.port.act({ type: 'wait' }, { source: 'bot' });
  // left: 部屋の左の 3 列を知らないことにする（視界の外なので、近づくまで知らないまま）。right: 部屋の右の壁を知らないことにする
  const cols = o.unknown === 'left' ? [a.ox, a.ox + 1, a.ox + 2] : [a.ox + a.W];
  for (let y = a.oy; y < a.oy + a.H; y++) for (const x of cols) fk.seen[y * f.width + x] = 0;
  const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
  const app = createApp(a.manager, config);
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const dir = mkdtempSync(join(tmpdir(), 'muse-pilot-test-'));
  if (orders !== undefined) writeFileSync(join(dir, 'orders.json'), JSON.stringify(typeof orders === 'function' ? (orders as (a: Ar) => unknown)(a) : orders));
  const h: Harness = { base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token: a.r.token, dir, wakes: [], close: async () => { a.manager.closeAll(); await new Promise<void>((r2) => app.server.close(() => r2())); } };
  return { h, a };
}

describe('pilot をサーバーにつないで動かす（§10.8）', () => {
  it('簡単な返事の相手と組ませる: pilot が自分から出す命令は既定の方針の道具だけ（綱・遠征の選択・特技の選択は出さない）。state.json に敵・階段・相手にしない敵', async () => {
    const h = await harness();
    const p = start(h, { responder: simpleResponder, maxActions: 250 });
    const res = await p.done;
    expect(res.outcome).toBe('safety');
    const own = rows(h.dir).filter((r) => r.source === 'pilot').map((r) => r.tool as string);
    expect(own.length).toBeGreaterThan(20);
    for (const t of own) expect(['explore', 'travel_to', 'collect', 'fight', 'wait', 'rest', 'use_stairs', 'extract', 'attack', 'use_ability', 'use_item']).toContain(t);
    // 綱は使わない（既定の allow_lifeline: false）。品は回復の手段だけ（観測の self.recovery。V4-1c）
    for (const r of rows(h.dir).filter((x) => x.source === 'pilot' && x.tool === 'use_item')) expect((r.args as { slot?: string }).slot).not.toBe('lifeline');
    // 遠征は返事の相手が queue で選ぶ
    expect(rows(h.dir).some((r) => r.source === 'queue' && r.tool === 'start_expedition')).toBe(true);
    // state.json と命令ごとの記録
    const st = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
    expect(st.run_id).toMatch(/.+/);
    expect(typeof st.summary).toBe('string');
    expect(Array.isArray(st.hostiles)).toBe(true);
    expect(Array.isArray(st.stairs)).toBe(true);
    expect(Array.isArray(st.ignored)).toBe(true);
    expect('target' in st).toBe(true);
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

  it('queue は方針より先に実行し、失敗したら残りを捨てて知らせる（止まらない）。skip ならその命令だけ捨てる', async () => {
    const h = await harness('solo', { rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }, { tool: 'use_item', args: { slot: 'z' } }, { tool: 'wait', args: {} }] });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'queue_failed'));
    await until(() => rows(h.dir).some((r) => r.source === 'pilot'));
    const cmds = rows(h.dir).filter((r) => r.tool);
    expect(cmds.slice(0, 2).map((r) => `${r.source}:${r.tool}:${r.ok}`)).toEqual(['queue:start_expedition:true', 'queue:use_item:false']);
    expect(cmds.some((r) => r.source === 'queue' && r.tool === 'wait')).toBe(false);
    expect(h.wakes.find((w) => w.reason === 'queue_failed')?.level).toBe('notify');
    await p.stop();
    await h.close();
    const h2 = await harness('solo', { rev: 1, policy: { queue_on_fail: 'skip' }, queue: [{ tool: 'start_expedition', args: { offer: 1 } }, { tool: 'use_item', args: { slot: 'z' } }, { tool: 'wait', args: {} }] });
    const p2 = start(h2);
    await until(() => rows(h2.dir).some((r) => r.source === 'queue' && r.tool === 'wait'));
    await p2.stop();
    await h2.close();
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

  it('起こして返事が無いとき（協力プレイ）: 毎手番すぐに持ち場の動きで答え、hold_max_turns の後は still_waiting をくり返さずに階段へ向かう', async () => {
    const h = await harness('coop', { rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }], policy: { hold_max_turns: 4 } });
    const p = start(h);
    await until(() => rows(h.dir).some((r) => r.source === 'pilot'));
    // 壊れた方針で起こす（返事はしない）
    writeFileSync(join(h.dir, 'orders.json'), '{ broken');
    await until(() => h.wakes.some((w) => w.reason === 'orders_invalid'));
    const t0 = Date.now();
    await until(() => h.wakes.some((w) => w.reason === 'no_reply'), 20000);
    const after = () => { const rs = rows(h.dir); const i = rs.findIndex((r) => r.wake === 'no_reply'); return rs.slice(i + 1).filter((r) => r.tool); };
    await until(() => after().length >= 1 || h.wakes.some((w) => w.reason === 'camp'), 20000);
    expect(Date.now() - t0).toBeLessThan(15000);
    expect(h.wakes.filter((w) => w.reason === 'no_reply')).toHaveLength(1);
    expect(h.wakes.find((w) => w.reason === 'no_reply')?.level).toBe('notify');
    expect(h.wakes.some((w) => w.reason === 'still_waiting')).toBe(false);
    // 帰る側へ: 階段へ向かう（着いていれば帰る）
    const first = after()[0];
    if (first) expect(first.tool === 'extract' || (first.tool === 'travel_to' && String((first.args as { to: unknown }).to).startsWith('stairs_')) || first.tool === 'attack').toBe(true);
    await p.stop();
    await h.close();
  }, 40000);

  it('じゃまをされて起こすとき: 断りのエラーの blocked_by の敵の行が wake.detail の先頭に来る。その敵には自分から挑まない', async () => {
    // 隣に動かない敵（気づいていない毒カビ）。部屋の右の壁を知らないことにして、探索できる所を残す
    const a = await arena('pilot-blocked-by', { map: ['P.......', '........'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId] });
    const me = a.world.entities[a.meId];
    const mold = { id: 'e_mold01', kind: 'core:spore_mold', sid: 999401, pos: { floor: a.key, x: a.ox + 1, y: a.oy }, actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'stationary', state: 'unaware', targetPos: null, lostTurns: 0, params: {} } }, stats: { hp: 12, maxHp: 12, acc: 3, eva: 0, might: 0, armor: 0, sight: 4, dmg: '1d1' }, base: { maxHp: 12, acc: 3, eva: 0, might: 0, armor: 0, sight: 4, dmg: '1d1' }, statuses: [] } as unknown as Entity;
    a.inject({ put: [mold] });
    expect(me.pos).toBeTruthy();
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 待つ間に気づかれていたら、気づいていないことに戻す（追ってくる敵なら、身を守るために殴るのは正しい。§14.4）
    const m2 = structuredClone(a.world.entities['e_mold01']); m2.actor!.ai!.state = 'unaware'; m2.actor!.ai!.targetPos = null; a.inject({ put: [m2] });
    // 視界の更新の後に、部屋の右の壁を知らないことにする（探索できる所が残る）
    const f = a.world.floors[a.key];
    const fk = a.world.players[a.pid].knowledge.floors[a.key];
    for (const y of [a.oy, a.oy + 1]) fk.seen[y * f.width + a.ox + a.W] = 0;
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const app = createApp(a.manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const h: Harness = { base: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token: a.r.token, dir: mkdtempSync(join(tmpdir(), 'muse-pilot-test-')), wakes: [], close: async () => { a.manager.closeAll(); await new Promise<void>((r2) => app.server.close(() => r2())); } };
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason.startsWith('refused_')));
    const w = h.wakes.find((x) => x.reason.startsWith('refused_'))!;
    expect(w.reason).toBe('refused_hostile_adjacent');
    const first = w.detail.split('\n')[0];
    expect(first).toContain('e_mold01');
    expect(first).toContain(content.monsters['core:spore_mold'].name.ja);
    // state.json の wake.detail も同じ
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).wake.detail.split('\n')[0]).toBe(first);
    // じゃまをしている敵に、自分から fight を仕掛けていない
    expect(rows(h.dir).some((r) => r.tool === 'fight' || r.tool === 'attack')).toBe(false);
    await p.stop();
    await h.close();
  }, 30000);

  it('fight が倒す前に止まっても起こさずに続け（§14.2）、auto なら寄ってやり直し、同じ相手に 2 回で諦めて steady で探索へ戻る', async () => {
    const { h, a } = await arenaHarness('pilot-giveup', ['....................P.....', '..........................'], (ar) => [shooter(ar, 'e_arch01', 24, 0)], undefined, { rubbleX: 22, unknown: 'left' });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'gave_up'), 20000);
    const fights = rows(h.dir).filter((r) => r.tool === 'fight' && (r.args as { target?: string }).target === 'e_arch01');
    // 最初は待ち受け、離れて撃ってくるので寄ってやり直す
    expect((fights[0]!.args as { approach?: string }).approach).toBeUndefined();
    expect(fights.some((r) => (r.args as { approach?: string }).approach === 'advance')).toBe(true);
    // どの止まり方でも起こさない
    expect(h.wakes.filter((w) => w.level === 'wake').map((w) => w.reason).filter((r) => r.startsWith('fight_') || r.startsWith('refused_'))).toEqual([]);
    expect(h.wakes.find((w) => w.reason === 'gave_up')?.level).toBe('notify');
    await until(() => JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).ignored.includes('e_arch01'));
    // 相手にしない敵がいる間は steady で探索
    await until(() => rows(h.dir).some((r) => r.tool === 'explore' && (r.args as { mode?: string }).mode === 'steady'), 20000);
    await p.stop();
    await h.close();
    expect(a).toBeTruthy();
  }, 40000);

  it('queue の命令が敵のせいで断られたら、敵に対応してからやり直す（§14.5）', async () => {
    const { h } = await arenaHarness('pilot-qretry', ['P......', '.......'], (ar) => [weakFoe(ar, 'e_foe901', 1, 0)], (ar: Ar) => ({ rev: 1, queue: [{ tool: 'travel_to', args: { to: { x: ar.ox + 6, y: ar.oy + 1 } } }] }));
    const p = start(h);
    await until(() => rows(h.dir).some((r) => r.source === 'queue' && r.tool === 'travel_to' && r.ok === true), 20000);
    const rs = rows(h.dir).filter((r) => r.tool);
    const firstQ = rs.findIndex((r) => r.source === 'queue' && r.tool === 'travel_to');
    expect(rs[firstQ]!.ok).toBe(false);
    expect(rs.slice(firstQ).some((r) => r.source === 'pilot' && (r.tool === 'fight' || r.tool === 'attack'))).toBe(true);
    expect(h.wakes.some((w) => w.reason === 'queue_retry' && w.level === 'notify')).toBe(true);
    expect(h.wakes.some((w) => w.reason === 'queue_failed')).toBe(false);
    await p.stop();
    await h.close();
  }, 30000);

  it('起こして待つ間に隣でない相手から撃たれ続けたら（最大 HP の 4 分の 1 を超えたら）、hold_max_turns を待たずに under_fire を知らせて階段へ向かう（§17.4）', async () => {
    // 壊れた方針で起こし、返事はしない。離れた所から撃つ射手。協力プレイの持ち場の動き（毎手番すぐに答える）
    const { h } = await arenaHarness('pilot-underfire', ['....P.....', '..........'], (ar) => [shooter(ar, 'e_arch02', 8, 0)], 'broken', { hp: 40, stairs: [0, 1] });
    const p = start(h, { mode: 'coop' });
    await until(() => h.wakes.some((w) => w.reason === 'orders_invalid'));
    await until(() => h.wakes.some((w) => w.reason === 'under_fire'), 20000);
    const uf = h.wakes.find((w) => w.reason === 'under_fire')!;
    expect(uf.level).toBe('notify');
    // hold_max_turns（既定 40）より前: no_reply ではない
    expect(h.wakes.some((w) => w.reason === 'no_reply')).toBe(false);
    // 帰る側へ: 階段へ向かう（着いたら帰る）
    await until(() => rows(h.dir).some((r) => (r.tool === 'travel_to' && String((r.args as { to: unknown }).to).startsWith('stairs_')) || r.tool === 'extract'), 20000);
    // 起こしたのは orders_invalid の 1 回だけ（撃たれても起こし直さない）
    expect(h.wakes.filter((w) => w.level === 'wake').map((w) => w.reason)).toEqual(['orders_invalid']);
    await p.stop();
    await h.close();
  }, 40000);

  it("mode: stop_at_camp は帰ってから終える（§14.7）", async () => {
    const h = await harness('solo', { rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }] });
    const p = start(h);
    await until(() => rows(h.dir).some((r) => r.source === 'pilot'));
    writeOrders(h, { rev: 2, mode: 'stop_at_camp', policy: { allow_lifeline: true } });
    const res = await p.done;
    expect(res).toMatchObject({ outcome: 'stopped', reason: 'stop_at_camp' });
    expect(rows(h.dir).some((r) => (r.tool === 'use_item' || r.tool === 'extract') && r.ok === true)).toBe(true);
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).status).toBe('ended');
    await h.close();
  }, 30000);

  it('mode: stop で終える', async () => {
    const h = await harness('solo', { rev: 1, mode: 'stop' });
    const res = await start(h).done;
    expect(res.outcome).toBe('stopped');
    await h.close();
  }, 20000);
});

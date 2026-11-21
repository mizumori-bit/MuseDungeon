// V4-1（IMPROVEMENTS_V4 §10.8）・V4-1b（§14.8）: 代行 bot の作例 pilot。判断の表（純粋な関数）と、プロセスの中に立てたサーバーで動かした確認。
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import type { Entity, GameEvent, ObsItem, ObsMonster, Observation } from '@muse/shared';
import { applyEvent } from '@muse/shared';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import { afterAction, decide, DEFAULT_POLICY, defaultOrders, holdAction, newMemory, parseOrders, PILOT_TOOLS, retreat, runPilot } from '../src/index';
import type { DecideContext, PilotMemory, PilotOrders, WakeEvent } from '../src/index';
import { simpleResponder } from '../src/pilot/responder';
import { readOrders } from '../src/pilot/orders';
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
      [monster({ id: 'e_ward01', guardian: { name: '番人', types: [], warden: true }, awareness: 'unaware', objective: true }), 'warden_decision']] as const) {
      obs.visible.monsters = [m];
      const r = decide(obs, ctxOf());
      expect(r.decision.kind === 'wake' && r.decision.wake.reason).toBe(reason);
    }
    // 目的でない守護者（V4-1a §12.6）: 止まらずに 1 回知らせ、挑まない（役割の無い敵と戦う）
    const other = monster({ id: 'e_guard2', role: 'guardian', guardian: { name: '別の守護者', types: [] }, dist: 1 });
    obs.visible.monsters = [other, foe];
    const r3 = decide(obs, ctxOf());
    expect(r3.decision.kind === 'act' && r3.decision.tool === 'fight' && r3.decision.args.target).toBe('e_foe001');
    // 鍵は個体ごと（気づいていない・追ってくるで分けない。ランを通して 1 回。V4-1e §19.5）
    expect(r3.notify.map((n) => `${n.level}:${n.reason}:${n.key}`)).toEqual(['notify:guardian_seen_hunting:seen:e_guard2']);
    // 知らせた後は知らせない（同じ階の記録でも、ランを通しての記録でも）
    expect(decide(obs, ctxOf(defaultOrders(), { notified: new Set(['seen:e_guard2']) })).notify).toEqual([]);
    expect(decide(obs, ctxOf(defaultOrders(), { once: new Set(['seen:e_guard2']) })).notify).toEqual([]);
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
    // 目的の階が封じられた階段の先: 既定（warden: escalate）では、その大守護者につき 1 回上げる（V4-1e §19.2）
    expect(r2.decision.kind === 'wake' && `${r2.decision.wake.level}:${r2.decision.wake.reason}:${r2.decision.wake.key}`).toBe('escalate:warden_decision:warden_decision:3');
    // 以下は挑むと決めた後（warden: engage）: 封じられた階段へは下りに行かず、表の先へ
    const ctxOfE = (o: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}) => ctxOf({ ...o, policy: { ...o.policy, warden: 'engage' } }, over);
    // 挑むと決めた後、大守護者が見えていない: 封じられた階段のある広間へ向かう（V4-1f §22.1 の 3）
    const rs = decide(obs, ctxOfE());
    expect(rs.decision.kind === 'act' && `${rs.decision.tool}:${JSON.stringify(rs.decision.args.to)}:${rs.decision.seek}`).toBe('travel_to:{"x":9,"y":9}:true');
    // 以下は広間の近くに着いた後
    obs.navigation.known_stairs = [{ ...st, dist: 2, path_len: 2, sealed: true }];
    // collect は collectable の数だけで決める（valid_actions の文字列は見ない）
    obs.valid_actions = [...obs.valid_actions, 'collect what:items (x)'];
    expect(decide(obs, ctxOfE()).decision.kind === 'act' && (decide(obs, ctxOfE()).decision as { tool: string }).tool === 'collect').toBe(false);
    obs.navigation.collectable = { count: 2, ids: ['e_a', 'e_b'] };
    const r3 = decide(obs, ctxOfE());
    expect(r3.decision.kind === 'act' && r3.decision.tool).toBe('collect');
    // approach: 方針のまま fight に渡す（pilot は自分で切り替えない）
    obs.visible.monsters = [monster({ id: 'e_foe002', dist: 4 })];
    const r4 = decide(obs, ctxOfE());
    expect(r4.decision.kind === 'act' && r4.decision.args.approach).toBeUndefined();
    const o = defaultOrders();
    o.policy.approach = 'advance';
    const r5 = decide(obs, ctxOfE(o));
    expect(r5.decision.kind === 'act' && r5.decision.args.approach).toBe('advance');
    expect(parseOrders({ rev: 1, policy: { approach: 'x' } }).policy.approach).toBe('auto');
    // auto: 寄ってやり直すと決めた相手（pilot の記録）だけ advance
    const mem: PilotMemory = { ...newMemory(), advance: ['e_foe002'] };
    const r6 = decide(obs, ctxOfE(defaultOrders(), { mem }));
    expect(r6.decision.kind === 'act' && r6.decision.args.approach).toBe('advance');
  });

  it('自分から使う道具は §10.4 の一覧の中。既定の方針では綱を使わず（危ないときの「帰る」を除く）、遠征を選ばない', async () => {
    const { obs } = await expeditionObs();
    // 退く手（retreat）は方針の allow_lifeline を守る: 既定では綱を使わない（追われていて階段へ着けない場面）
    obs.alerts = [{ code: 'lethal_range', text: '危ない', level: 'danger' } as Observation['alerts'][number]];
    obs.self.inventory = [...(obs.self.inventory ?? []), { slot: 'z', kind: 'core:lifeline', name: '帰還の綱', qty: 1 } as never];
    obs.visible.monsters = [monster({ id: 'e_lth001', dist: 1 })];
    obs.navigation.known_stairs = [];
    const rt = retreat(obs, DEFAULT_POLICY);
    expect(rt?.tool).not.toBe('use_item');
    // 許したときだけ綱
    expect(retreat(obs, { ...DEFAULT_POLICY, allow_lifeline: true })?.tool).toBe('use_item');
    // 危ない（danger）で帰ると決めたときは、階段へ着けなければ、既定の方針でも綱を使う（V4-1i §28.2 の 1「着けなければ綱」。
    // 測り直しで、綱を許していないまま追われて階段へ歩き、倒れた本が 2 本あった）
    obs.self.recovery = [];
    const r0 = decide(obs, ctxOf());
    expect(r0.decision.kind === 'act' && `${r0.decision.tool}:${r0.decision.args.slot}`).toBe('use_item:lifeline');
    // 危なくないとき（帰ると決めていない）は使わない
    obs.alerts = [];
    const r1 = decide(obs, ctxOf());
    expect(r1.decision.kind === 'act' && r1.decision.tool === 'use_item' && r1.decision.args.slot === 'lifeline').toBe(false);
    // 既定の方針: 綱は使わない・キャンプでは起こす
    const d = parseOrders({ rev: 1 });
    expect(d.policy.allow_lifeline).toBe(false);
    expect(d.camp.auto_start).toBeNull();
    // §14.1: 目的を果たしたら帰る・目的の相手と特技では起こす・決着しない戦いは 2 回で諦める・寄り方は auto
    expect(d.policy.after_objective).toBe('extract');
    expect(d.policy.engage_objective).toBe(false);
    expect(d.policy.perk).toBe('wake');
    expect(d.policy.give_up_after).toBe(3);
    expect(d.policy.allow_throw).toBe(true);
    expect(d.policy.step_on_traps).toBe(false);
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
    // 3) 隣で追ってくる役割の無い敵がいて、階段にも仲間にも行けない: 殴る（撃ってくる相手がいない。V4-1h §26.1）
    //    V4-1m C6: その fight が HP で断られる（1 手の最悪の被害で hp_floor を割る）なら出さない。ここでは断られない相手（1 手の最悪 1）
    obs.visible.monsters = [monster({ id: 'e_chase1', dist: 1, worst_turn: 1 })];
    const r6 = decide(obs, ctxOf(defaultOrders(), { mem }));
    // 殴るのはマクロの fight（hp_floor は critical_hp の線。V4-1h の続き §27.5）
    expect(r6.decision.kind === 'act' && `${r6.decision.tool}:${r6.decision.args.target}:${r6.decision.args.hp_floor}`).toBe(`fight:e_chase1:${Math.ceil(obs.self.max_hp / 4) - 1}`);
    // この数手番に隣でない相手から被害を受けている（撃たれている）: 殴らずに離れる（来た道を戻る）
    const r6s = decide(obs, ctxOf(defaultOrders(), { mem: { ...mem, hurtFarAgo: 0 } }));
    expect(r6s.decision.kind === 'act' && r6s.decision.tool).toBe('travel_to');
    // 帰ると決めた後（mode: return）: 殴らない
    const r6r = decide(obs, ctxOf({ ...defaultOrders(), mode: 'return' }, { mem }));
    expect(r6r.decision.kind === 'act' && r6r.decision.tool).toBe('travel_to');
    // 道をふさいでいる（断りの blocked_by）なら、撃たれていても殴る
    const r6b = decide(obs, ctxOf(defaultOrders(), { mem: { ...mem, hurtFarAgo: 0 }, refused: new Set(['travel_to']), refusal: { code: 'blocked', text: 'x', blockedBy: ['e_chase1'] } }));
    expect(r6b.decision.kind === 'act' && `${r6b.decision.tool}:${r6b.decision.args.target}`).toBe('attack:e_chase1');
    // 5) 手が尽きた（まだ倒されうる状態ではない）: 帰らずに起こす（recover_failed。V4-1h §26.2）
    obs.visible.monsters = [monster({ id: 'e_chase1', dist: 3 })];
    const r7 = decide(obs, ctxOf(defaultOrders(), { mem: { ...mem, trail: [] } }));
    expect(r7.decision.kind === 'wake' && `${r7.decision.wake.level}:${r7.decision.wake.reason}`).toBe('wake:recover_failed');
    if (r7.decision.kind === 'wake') expect(r7.decision.wake.detail).toContain('試した手');
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
    // 綱を持っていない場面（危ないときの「帰る」は、着けなければ綱を回復の品より先に使う。V4-1i §28.2 の 1）
    if (obs.expedition?.haul) delete (obs.expedition.haul as { if_lifeline_now?: number }).if_lifeline_now;
    obs.self.inventory = (obs.self.inventory ?? []).filter((i) => (i as { kind?: string }).kind !== 'core:lifeline');
    obs.self.hp = Math.floor(obs.self.max_hp * 0.2);
    obs.visible.monsters = [monster({ id: 'e_biter1', dist: 1, worst_turn: 99 })];
    obs.alerts = [{ code: 'lethal_range', text: '1 手で倒されうる', level: 'danger' } as unknown as Observation['alerts'][number]];
    const potion = { kind: 'item' as const, slot: 'c', name: '回復の薬', qty: 2, amount: '2d8+4' };
    const wind = { kind: 'ability' as const, id: 'second_wind', name: '立て直し', ready: true, amount: '最大 HP の 25%' };
    // 観測に回復の手段が無い（未鑑定の品は観測に入らない）: 使わない。危ない（danger）は命令の前に上げる（V4-1i §28.2 の 1・B4: 返事は待たずに帰る側の手を出す）
    obs.self.recovery = [];
    const r0 = decide(obs, ctxOf());
    expect(r0.notify.find((n) => n.reason === 'danger')?.level).toBe('escalate');
    expect(r0.decision.kind === 'act' && r0.decision.tool).not.toBe('use_item');
    // 鑑定済みの回復の品: 使って知らせる。上げるのは使う前（起こすと決めた時点の写しと説明。V4-1i B4）
    obs.self.recovery = [potion];
    const r1 = decide(obs, ctxOf());
    expect(r1.decision.kind === 'act' && `${r1.decision.tool}:${r1.decision.args.slot}`).toBe('use_item:c');
    expect(r1.decision.kind === 'act' && r1.decision.then).toBeUndefined();
    expect(r1.notify.find((n) => n.reason === 'danger')?.level).toBe('escalate');
    expect(r1.notify.find((n) => n.reason === 'healed')?.detail).toBe('回復の薬 を使った（残り 1）');
    // allow_heal: false: 使わない
    const off = defaultOrders(); off.policy.allow_heal = false;
    const roff = decide(obs, ctxOf(off));
    expect(roff.decision.kind === 'act' && roff.decision.tool === 'use_item' && roff.decision.args.slot === 'c').toBe(false);
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
function start(h: Harness, opts: { responder?: (ev: WakeEvent) => void; mode?: 'solo' | 'coop'; maxActions?: number; wakeCmd?: string; wakeUrl?: string; now?: () => number } = {}) {
  const ac = new AbortController();
  const done = runPilot({
    baseUrl: h.base, token: h.token, dir: h.dir, pollMs: 20, log: () => {}, signal: ac.signal, maxActions: opts.maxActions ?? 5000, ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.wakeCmd ? { wakeCmd: opts.wakeCmd } : {}), ...(opts.wakeUrl ? { wakeUrl: opts.wakeUrl } : {}), ...(opts.now ? { now: opts.now } : {}),
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
/** 罠（found: そのプレイヤーが見つけている） */
const trapAt = (a: Ar, id: string, kind: string, x: number, y: number, found = true): Entity => ({ id, kind, sid: ++esid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y }, trap: { revealedTo: found ? [a.pid] : [] } } as unknown as Entity);
/** 離れたままの相手への fight の引数の並び（V4-1d §18.2） */
const fightArgsOf = (dir: string, target: string) => rows(dir).filter((r) => r.source === 'pilot' && r.tool === 'fight' && (r.args as { target?: string }).target === target).map((r) => r.args as { approach?: string; with?: string | string[]; adjacent?: string });
/** 決まった形の部屋に置いた場面に pilot をつなぐ（守護者は消す。部屋の右の壁を知らないことにして、探索できる所を残す） */
async function arenaHarness(seed: string, map: string[], put: (a: Ar) => Entity[], orders?: unknown | ((a: Ar) => unknown), o: { rubbleX?: number; unknown?: 'left' | 'right'; hp?: number; stairs?: [number, number]; items?: { kind: string; qty?: number }[] } = {}): Promise<{ h: Harness; a: Ar }> {
  const a = await arena(seed, { map, guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: o.hp ?? 400, ...(o.items ? { items: o.items } : {}) } });
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
    // 返事役が答えない段（escalate: 安全装置・空回りなど。V4-1e §19.1）に上がるまで回す。上げたら pilot は返事を待つ
    // danger は V4-1i から返事を待たない上げ方（帰る側へ進む）なので、それ以外の上げる段まで回す
    await until(() => h.wakes.some((w) => w.level === 'escalate' && w.reason !== 'danger'), 55000);
    await p.stop();
    const own = rows(h.dir).filter((r) => r.source === 'pilot').map((r) => r.tool as string);
    expect(own.length).toBeGreaterThan(20);
    for (const t of own) expect(['explore', 'travel_to', 'collect', 'fight', 'wait', 'rest', 'use_stairs', 'extract', 'attack', 'use_ability', 'use_item']).toContain(t);
    // 綱を使うのは、返事役が帰る（mode: return・allow_lifeline: true）と書いた後だけ（V4-1e §19.4）。使ったら lifeline_used で知らせる
    const lifeRows = rows(h.dir).filter((x) => x.source === 'pilot' && x.tool === 'use_item' && (x.args as { slot?: string }).slot === 'lifeline');
    if (lifeRows.length) expect(h.wakes.some((w) => w.reason === 'lifeline_used')).toBe(true);
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
    // 諦める回数を 2 にして確かめる（既定は 3。V4-1d §18.2: 3 回目は投げる品で。投げる品は持っていない）
    const { h, a } = await arenaHarness('pilot-giveup', ['....................P.....', '..........................'], (ar) => [shooter(ar, 'e_arch01', 24, 0)], { rev: 1, policy: { give_up_after: 2 } }, { rubbleX: 22, unknown: 'left' });
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

  it('V4-1d §18.2: 離れたままの相手には 待つ → 寄る → 投げる の順でやり直す（投げるのは分類が「投げる武器」の品だけ。隣に来たら近接）。3 回目でも決着しなければ諦める', async () => {
    // 瓦礫の向こうの射手（寄れない・投げれば届く）。投げ槍と、投げても割れる薬（分類は薬）を持つ
    const { h } = await arenaHarness('pilot-throw', ['....................P.....', '..........................'], (ar) => [shooter(ar, 'e_arch01', 24, 0)], undefined,
      { rubbleX: 22, unknown: 'left', items: [{ kind: 'core:javelin', qty: 2 }, { kind: 'core:potion_poison', qty: 2 }] });
    const p = start(h);
    await until(() => fightArgsOf(h.dir, 'e_arch01').length >= 3, 20000);
    const fs = fightArgsOf(h.dir, 'e_arch01');
    expect(fs[0]!.approach).toBeUndefined();
    expect(fs[0]!.with).toBeUndefined();
    expect(fs[1]!.approach).toBe('advance');
    expect(fs[1]!.with).toBeUndefined();
    // 3 回目: 投げる武器（投げ槍）だけを with に。薬（観測の self.attack.throws には入っている）は渡さない
    expect(fs[2]!.with).toBe('javelin');
    expect(fs[2]!.adjacent).toBe('melee');
    expect(JSON.stringify(fs)).not.toContain('potion');
    // 投げても倒れない（体力 400）: 3 回目を数に入れて、既定の give_up_after 3 で諦める（起こさない）
    await until(() => h.wakes.some((w) => w.reason === 'gave_up'), 20000);
    expect(h.wakes.find((w) => w.reason === 'gave_up')?.level).toBe('notify');
    await p.stop();
    await h.close();
  }, 40000);

  it('V4-1d §18.2: allow_throw: false なら投げない。投げる武器が無ければ（薬だけ）投げない', async () => {
    for (const [seed, items, orders] of [
      ['pilot-nothrow', [{ kind: 'core:javelin', qty: 2 }], { rev: 1, policy: { allow_throw: false } }],
      ['pilot-potiononly', [{ kind: 'core:potion_poison', qty: 2 }], undefined],
    ] as const) {
      const { h } = await arenaHarness(seed, ['....................P.....', '..........................'], (ar) => [shooter(ar, 'e_arch01', 24, 0)], orders, { rubbleX: 22, unknown: 'left', items: [...items] });
      const p = start(h);
      // 待つ・寄る（届かないので断られる）の 2 回の後、3 回目は投げずに、射手の見えない所へ探索に出る（起こして止まる）
      await until(() => fightArgsOf(h.dir, 'e_arch01').length >= 2 && h.wakes.some((w) => w.level === 'wake'), 20000);
      const fs = fightArgsOf(h.dir, 'e_arch01');
      expect(fs[1]!.approach).toBe('advance');
      expect(fs.every((f) => f.with === undefined)).toBe(true);
      expect(rows(h.dir).some((r) => r.tool === 'throw_item')).toBe(false);
      await p.stop();
      await h.close();
    }
  }, 60000);

  it('V4-1d §18.1: step_on_traps: false では罠を踏まずに起こし、wake.detail の先頭に罠の行・位置・方角。state.json に traps', async () => {
    // 1 列の通路。隣に見つけている罠、部屋の右の壁を知らない（探索できる所が罠の先に残る）
    const { h, a } = await arenaHarness('pilot-trap-wake', ['P.......'], (ar) => [trapAt(ar, 'e_trp001', 'core:trap_dart', 1, 0)], undefined, { unknown: 'right' });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'refused_blocked'), 20000);
    const w = h.wakes.find((x) => x.reason === 'refused_blocked')!;
    expect(w.level).toBe('wake');
    const first = w.detail.split('\n')[0]!;
    expect(first).toContain('道をふさぐ罠');
    expect(first).toContain('毒矢の罠');
    expect(first).toContain('e_trp001');
    expect(first).toContain(`(${a.ox + 1},${a.oy})`);
    expect(first).toContain('方角 e・隣');
    const st = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
    expect(st.traps).toEqual([{ id: 'e_trp001', name: '毒矢の罠', pos: [a.ox + 1, a.oy], dist: 1 }]);
    expect(st.wake.detail.split('\n')[0]).toBe(first);
    // 踏んでいない
    expect(rows(h.dir).some((r) => r.tool === 'move')).toBe(false);
    expect(a.world.entities[a.meId]!.pos!.x).toBe(a.ox);
    await p.stop();
    await h.close();
  }, 30000);

  it('V4-1d §18.1: step_on_traps: true では、ふさいでいる隣の罠を 1 歩の move で踏み（stepped_on_trap で知らせる）、起こさずに先へ進む', async () => {
    const { h, a } = await arenaHarness('pilot-trap-step', ['P.......'], (ar) => [trapAt(ar, 'e_trp002', 'core:trap_alarm', 1, 0)], { rev: 1, policy: { step_on_traps: true } }, { unknown: 'right' });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'stepped_on_trap'), 20000);
    const n = h.wakes.find((w) => w.reason === 'stepped_on_trap')!;
    expect(n.level).toBe('notify');
    expect(n.detail).toContain('e_trp002');
    expect(n.detail).toContain(`(${a.ox + 1},${a.oy})`);
    await until(() => rows(h.dir).some((r) => r.tool === 'move' && r.ok === true), 20000);
    const mv = rows(h.dir).find((r) => r.tool === 'move')!;
    expect(mv.source).toBe('pilot');
    expect(mv.args).toEqual({ dir: 'e' });
    // 罠のマスに立った。罠のことで起こしていない（通路の先は、踏んだ 1 歩で見えて探索し終わる）
    expect(a.world.entities[a.meId]!.pos!.x).toBe(a.ox + 1);
    expect(h.wakes.some((w) => w.level === 'wake' && w.reason === 'refused_blocked')).toBe(false);
    await p.stop();
    await h.close();
  }, 30000);

  it('V4-1e §19.3: 確定 0 の遠征が 3 回続いたら、次を始めずにキャンプで stalled を上げて待つ（返事役の見本は escalate に答えない）。history.jsonl に 1 遠征 1 行', async () => {
    const h = await harness();
    // 返事役: キャンプでは出発してすぐ（入口の階段の上で）帰る。危ない（danger。V4-1g から上げる段）は AI の代わりに帰ると答える。ほかは見本のまま
    const responder = (ev: WakeEvent) => {
      if (ev.level === 'escalate' && ev.reason === 'danger') { simpleResponder({ ...ev, level: 'wake' }); return; }
      if (ev.level !== 'wake' || ev.reason !== 'camp') { simpleResponder(ev); return; }
      const cur = readOrders(ev.ordersPath) ?? defaultOrders();
      const offer = ev.state.camp!.offers.find((o) => o.type !== 'slay_warden')!;
      writeOrders(h, { ...cur, rev: cur.rev + 1, queue: [{ tool: 'start_expedition', args: { offer: offer.index } }, { tool: 'extract', args: { confirm: true } }] });
    };
    const p = start(h, { responder });
    await until(() => h.wakes.some((w) => w.level === 'escalate' && w.reason !== 'danger'), 30000);
    const esc = h.wakes.find((w) => w.level === 'escalate' && w.reason !== 'danger')!;
    expect(esc.reason).toBe('stalled');
    expect(esc.detail).toContain('直近 3 回の遠征');
    const starts = () => rows(h.dir).filter((r) => r.source === 'queue' && r.tool === 'start_expedition' && r.ok === true).length;
    // 1 遠征 1 行（番号・枠と目的・手番・確定した点・終わり方）。上げたのは、直近の 3 回が空になった、その最初のキャンプ（入口が階段でない遠征は、ふつうに遊ぶ）
    const hist = readFileSync(join(h.dir, 'history.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { no: number; banked: number; turns: number; objective: { type: string }; end: string });
    const empty = (x: { banked: number; turns: number }) => x.banked === 0 || x.turns <= 10;
    expect(hist.map((x) => x.no)).toEqual(hist.map((_, i) => i + 1));
    expect(hist.slice(-3).every(empty)).toBe(true);
    for (let k = 3; k < hist.length; k++) expect(hist.slice(k - 3, k).every(empty)).toBe(false);
    for (const x of hist) { expect(typeof x.turns).toBe('number'); expect(typeof x.banked).toBe('number'); expect(x.objective.type).toMatch(/.+/); expect(x.end).toMatch(/.+/); }
    // 確定した点は、キャンプの文の「確定 +N」と同じ（達成したときの基礎点ではない）。上げた文にも同じ数
    let checked = 0;
    for (const w of h.wakes.filter((x) => x.reason === 'camp')) {
      const m = /遠征 (\d+) は終了した[^\n]*確定 \+(\d+)/.exec(w.detail);
      if (!m) continue;
      expect(hist.find((x) => x.no === Number(m[1]))?.banked).toBe(Number(m[2]));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    for (const x of hist.slice(-3)) expect(esc.detail).toContain(`遠征 ${x.no}（`);
    expect(esc.detail).toContain(`: ${hist.at(-1)!.turns} 手番・確定 ${hist.at(-1)!.banked}・`);
    expect(starts()).toBe(hist.length);
    // 上げた後は、遠征を始めずに待つ（返事役は escalate に答えないので rev も変わらない）
    const rev = readOrders(join(h.dir, 'orders.json'))!.rev;
    await new Promise((r) => setTimeout(r, 600));
    expect(starts()).toBe(hist.length);
    expect(h.wakes.filter((w) => w.level === 'escalate' && w.reason !== 'danger')).toHaveLength(1);
    expect(readOrders(join(h.dir, 'orders.json'))!.rev).toBe(rev);
    const st = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
    expect(st.status).toBe('camp');
    expect(st.wake).toMatchObject({ level: 'escalate', reason: 'stalled' });
    await p.stop();
    // 起動し直しても、記録から空回りと分かる（すぐに上げる）
    const n0 = h.wakes.filter((w) => w.level === 'escalate').length;
    const p2 = start(h, { responder });
    await until(() => h.wakes.filter((w) => w.level === 'escalate').length > n0, 20000);
    expect(h.wakes.filter((w) => w.level === 'escalate').at(-1)!.reason).toBe('stalled');
    expect(starts()).toBe(hist.length);
    // 再開は rev を上げるだけ（V4-1f §22.3）: queue を書かなくても、camp.auto_start のとおりに pilot が出発する。空回りの数えは 0 に戻る
    const cur = readOrders(join(h.dir, 'orders.json'))!;
    writeOrders(h, { ...cur, rev: cur.rev + 1, queue: [], camp: { auto_start: 'safe' } });
    await until(() => rows(h.dir).some((r) => r.source === 'pilot' && r.tool === 'start_expedition' && r.ok === true), 20000);
    expect(JSON.parse(readFileSync(join(h.dir, 'memory.json'), 'utf-8')).stall_base).toBe(hist.length);
    await p2.stop();
    await h.close();
  }, 60000);

  it('V4-1f §22.5: キャンプで仲間がまだ迷宮にいる間は、遠征を始めずに waiting_party で待つ（stuck・stalled にしない）。仲間が戻ったら camp で起こす', async () => {
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const manager = new SessionManager(content, config);
    const app = createApp(manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // キャンプから作り、仲間が入ってから遠征を始める（V4-1g G1）
    const r = await manager.createRun({ name: 'Pilot', seed: 'pilot-wait-party', classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' }, mode: 'coop' });
    if ('error' in r) throw new Error(r.error.message);
    r.session.world.meta.options.turnTimeoutMs = 200;
    const b = await manager.joinRun(r.session.runId, { name: 'Ally', controller: { kind: 'human', label: 'ally' } });
    if ('error' in b) throw new Error(b.error.message);
    expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'muse-pilot-test-'));
    // pilot は最初から帰る（mode: return）。仲間は迷宮に残る
    writeFileSync(join(dir, 'orders.json'), JSON.stringify({ rev: 1, mode: 'return', policy: { allow_lifeline: true } }));
    const h: Harness = { base, token: r.token, dir, wakes: [], close: async () => { manager.closeAll(); await new Promise<void>((r2) => app.server.close(() => r2())); } };
    const p = start(h, { mode: 'coop' });
    const w = r.session.world;
    await until(() => w.players[r.port.playerId]!.state === 'at_camp', 30000);
    await until(() => JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).status === 'waiting_party', 10000);
    const st = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8'));
    expect(st.summary).toContain('仲間: Ally［人間］（地下 1 階・健康）');
    expect(st.party[0]).toMatchObject({ name: 'Ally', status: 'in_dungeon', floor: 1 });
    const n0 = h.wakes.length;
    await new Promise((res) => setTimeout(res, 800));
    // 待つ間: 遠征を始めない・起こさない（camp・stuck・stalled も無い）
    expect(rows(h.dir).some((x) => x.tool === 'start_expedition')).toBe(false);
    expect(h.wakes.slice(n0).filter((x) => x.level !== 'notify')).toEqual([]);
    // 仲間が戻る（階段の上で帰る）: 遠征が終わり、キャンプの候補で起こす
    const bE = structuredClone(w.entities[w.players[b.port.playerId]!.entityId]!);
    const f = w.floors[bE.pos!.floor]!;
    const tv = w.meta.terrainTable.indexOf('core:stairs_down');
    const i = f.terrain.findIndex((v) => v === tv);
    bE.pos = { floor: bE.pos!.floor, x: i % f.width, y: Math.trunc(i / f.width) };
    applyEvent(w, { type: 'thought', player: b.port.playerId, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [bE] } as unknown as GameEvent);
    await until(() => b.port.view().status === 'your_turn', 5000);
    expect((await b.port.act({ type: 'extract', confirm: true }, { source: 'bot' })).ok).toBe(true);
    await until(() => h.wakes.some((x) => x.reason === 'camp' && x.level === 'wake'), 15000);
    await p.stop();
    await h.close();
  }, 60000);

  /** 協力プレイ: pilot と、地下 2 階で何もしない人間の仲間（pilot は遠征の最初に、仲間が同じ階に来るのを待つ） */
  async function waitingForAlly(seed: string, policy: Record<string, unknown>) {
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const manager = new SessionManager(content, config);
    const app = createApp(manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // キャンプから作り、仲間が入ってから遠征を始める（V4-1g G1）
    const r = await manager.createRun({ name: 'Pilot', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' }, mode: 'coop' });
    if ('error' in r) throw new Error(r.error.message);
    r.session.world.meta.options.turnTimeoutMs = 50;
    const b = await manager.joinRun(r.session.runId, { name: 'Ally', controller: { kind: 'human', label: 'ally' } });
    if ('error' in b) throw new Error(b.error.message);
    expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    // 仲間を下り階段の上に置いて、地下 2 階へ下ろす（その後は何もしない）
    const w = r.session.world;
    const bE = structuredClone(w.entities[w.players[b.port.playerId]!.entityId]!);
    const f = w.floors[bE.pos!.floor]!;
    const tv = w.meta.terrainTable.indexOf('core:stairs_down');
    const i = f.terrain.findIndex((v) => v === tv);
    bE.pos = { floor: bE.pos!.floor, x: i % f.width, y: Math.trunc(i / f.width) };
    applyEvent(w, { type: 'thought', player: b.port.playerId, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [bE] } as unknown as GameEvent);
    for (let k = 0; k < 20 && b.port.view().status !== 'your_turn'; k++) {
      if (r.port.view().status === 'your_turn') await r.port.act({ type: 'wait' }, { source: 'bot' });
      else await new Promise((res) => setTimeout(res, 20));
    }
    expect((await b.port.act({ type: 'stairs' }, { source: 'bot' })).ok).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'muse-pilot-test-'));
    writeFileSync(join(dir, 'orders.json'), JSON.stringify({ rev: 1, policy: { hold_max_turns: 1000, ...policy } }));
    const h: Harness = { base, token: r.token, dir, wakes: [], close: async () => { manager.closeAll(); await new Promise<void>((r2) => app.server.close(() => r2())); } };
    return h;
  }

  it('V4-1f §23.8: 遅い仲間を待つ間の「待つ」は命令の上限に数えない（上限 15 でも、待ち続けて safety で終わらない）', async () => {
    const h = await waitingForAlly('pilot-wait-uncounted', {});
    const p = start(h, { mode: 'coop', maxActions: 15 });
    await until(() => rows(h.dir).filter((x) => x.source === 'pilot' && x.tool === 'wait').length >= 40, 30000);
    expect(h.wakes.some((w) => w.reason === 'safety')).toBe(false);
    const res = await p.stop();
    expect(res.outcome).toBe('stopped');
    expect(res.actions).toBeLessThan(15);
    await h.close();
  }, 40000);

  it('V4-1f §23.8: 仲間が実時間で 10 分何もしなければ party_idle で上げる（時計を差し替えて確かめる）。上げた後も待ち続け、自分からは帰らない', async () => {
    const h = await waitingForAlly('pilot-party-idle', {});
    const clock = { t: 1_000_000 };
    const p = start(h, { mode: 'coop', now: () => clock.t });
    await until(() => rows(h.dir).filter((x) => x.source === 'pilot' && x.tool === 'wait').length >= 5, 20000);
    // 9 分では上げない
    clock.t += 9 * 60000;
    const n9 = rows(h.dir).filter((x) => x.tool === 'wait').length;
    await until(() => rows(h.dir).filter((x) => x.tool === 'wait').length >= n9 + 5, 20000);
    expect(h.wakes.some((w) => w.reason === 'party_idle')).toBe(false);
    // 10 分を過ぎた: 上げる（返事役は答えない段）
    clock.t += 2 * 60000;
    await until(() => h.wakes.some((w) => w.reason === 'party_idle'), 20000);
    const e = h.wakes.find((w) => w.reason === 'party_idle')!;
    expect(e.level).toBe('escalate');
    expect(e.detail).toContain('仲間が 11 分、何もしていない');
    // 同じ階の仲間は、見えていなくても位置が付く（V4-1k §32.3）
    expect(e.detail).toMatch(/仲間: Ally［人間］（地下 2 階・健康(・[^）]*)?）/);
    expect(h.wakes.filter((w) => w.reason === 'party_idle')).toHaveLength(1);
    // 上げた後も、その場で待ち続ける（階段へ行かない・帰らない・返事が無くても no_reply で帰る側へ倒さない）
    const n = rows(h.dir).length;
    await until(() => rows(h.dir).slice(n).filter((x) => x.tool === 'wait').length >= 10, 20000);
    expect(rows(h.dir).slice(n).some((x) => x.tool === 'travel_to' || x.tool === 'use_stairs' || x.tool === 'extract' || x.tool === 'use_item')).toBe(false);
    expect(h.wakes.some((w) => w.reason === 'no_reply')).toBe(false);
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).wake).toMatchObject({ level: 'escalate', reason: 'party_idle' });
    await p.stop();
    await h.close();
  }, 60000);

  it('V4-1f §22.5: 協力プレイの pilot 2 体（参加の順で 2 番目が 1 番目についていく）は、お互いを追って止まらず、後の者は先の階へ進まない', async () => {
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const manager = new SessionManager(content, config);
    const app = createApp(manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    // キャンプから作り、2 体とも入ってから、どちらかの返事役が遠征を始める（V4-1g G1・wait_for_join）
    const a = await manager.createRun({ name: 'A', seed: 'pilot-two', classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' }, mode: 'coop' });
    if ('error' in a) throw new Error(a.error.message);
    a.session.world.meta.options.turnTimeoutMs = 2000;
    const b = await manager.joinRun(a.session.runId, { name: 'B', classId: 'core:scout', controller: { kind: 'agent', label: 'pilot' } });
    if ('error' in b) throw new Error(b.error.message);
    const mk = (token: string): Harness => ({ base, token, dir: mkdtempSync(join(tmpdir(), 'muse-pilot-test-')), wakes: [], close: async () => undefined });
    const ha = mk(a.token), hb = mk(b.token);
    const w = a.session.world;
    const depthOf = (pid: string) => { const e = w.entities[w.players[pid]!.entityId]; return w.players[pid]!.state === 'alive' && e?.pos ? w.floors[e.pos.floor]!.depth : null; };
    // B の手番ごとに、A と B の階を見る（実時間の間隔で見ると、重いときに数が減る）
    const samples: { a: number | null; b: number | null }[] = [];
    let bTurns = -1;
    const timer = setInterval(() => {
      const t = w.entities[w.players[b.port.playerId]!.entityId]?.actor?.turns ?? -1;
      if (t === bTurns) return;
      bTurns = t;
      samples.push({ a: depthOf(a.port.playerId), b: depthOf(b.port.playerId) });
    }, 2);
    // AI の代わり: 上げる段（escalate）にも、見本と同じ決まりで答える（確かめたいのは、ついていく動き）
    const ai = (ev: WakeEvent) => simpleResponder(ev.level === 'escalate' ? { ...ev, level: 'wake' } : ev);
    const pa = start(ha, { responder: ai, mode: 'coop', maxActions: 300 });
    const pb = start(hb, { responder: ai, mode: 'coop', maxActions: 300 });
    await until(() => rows(ha.dir).filter((x) => x.tool).length >= 60 && rows(hb.dir).filter((x) => x.tool).length >= 60, 50000);
    clearInterval(timer);
    await pa.stop();
    await pb.stop();
    // B の state.json: ついていく相手は A
    expect(JSON.parse(readFileSync(join(hb.dir, 'state.json'), 'utf-8')).follow).toBe(a.port.playerId);
    expect(JSON.parse(readFileSync(join(ha.dir, 'state.json'), 'utf-8')).follow).toBeNull();
    // B は自分から A より深い階へ進まない: B が迷宮の中で深い階へ移って A より深くなったのは、B の立て直しで階段を移ったときだけ。
    // （ほかに B が A より深くなるのは、A が立て直しで上の階へ移ったとき（V4-1h §26.2）と、遠征の始まりにそれぞれの再開する場所から出るとき（§26.5）。
    //  V4-1g までは「B が深い手番が 1 割未満」を見ていたが、A が立て直しで撤退せずに階段で上へ移るようになり、この 2 つで 1 割を超えた）
    const both = samples.filter((x) => x.a !== null && x.b !== null);
    const deeper = both.filter((x) => x.b! > x.a!).length;
    const wentDeeper = samples.filter((x, i) => i > 0 && samples[i - 1]!.b !== null && x.b !== null && x.a !== null && x.b > samples[i - 1]!.b! && x.b > x.a).length;
    const recoverCross = rows(hb.dir).filter((r) => r.tool === 'use_stairs' && (r.why === 'recover' || r.why === 'recover_return')).length;
    const followDeeper = rows(hb.dir).filter((r) => r.tool === 'use_stairs' && (r.why === 'descend' || r.why === 'explore')).length;
    const info = `B の手番 ${samples.length}、両方が迷宮 ${both.length}、B が深い ${deeper}、B が A より深くへ移った ${wentDeeper}（B の立て直しで階段を移った ${recoverCross}）`;
    expect(both.length, info).toBeGreaterThan(10);
    expect(wentDeeper, info).toBeLessThanOrEqual(recoverCross);
    // ついていく間、B は自分の判断で下りない（下りる use_stairs は、ついていく行か立て直しの行だけ）
    expect(followDeeper, info).toBe(0);
    manager.closeAll();
    await new Promise<void>((r2) => app.server.close(() => r2()));
  }, 60000);

  it('V4-1e §19.5: 目的でない遺物は、ランを通して 1 回だけ知らせる（pilot を起動し直しても、memory.json の記録で知らせない）', async () => {
    const relicAt = (ar: Ar, x: number, y: number): Entity => ({ id: 'e_rlc001', kind: 'core:relic_hunter', sid: ++esid, role: 'relic', pos: { floor: ar.key, x: ar.ox + x, y: ar.oy + y }, item: { qty: 1, affixes: [] } } as unknown as Entity);
    const { h } = await arenaHarness('pilot-relic-once', ['P.......', '........'], (ar) => [relicAt(ar, 5, 1)], undefined, { unknown: 'right' });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'relic_seen'), 20000);
    const n = h.wakes.find((w) => w.reason === 'relic_seen')!;
    expect(n.level).toBe('notify');
    expect(n.detail).toContain('pick_relics');
    await until(() => h.wakes.some((w) => w.level === 'wake'), 20000);
    await p.stop();
    expect(JSON.parse(readFileSync(join(h.dir, 'memory.json'), 'utf-8')).once).toContain('relic_seen:e_rlc001');
    // 起動し直す: 遺物はまだ見えているが、知らせない
    const before = h.wakes.length;
    writeOrders(h, { ...defaultOrders(), rev: 50 });
    const p2 = start(h);
    await until(() => h.wakes.length > before + 0 && h.wakes.slice(before).some((w) => w.level === 'wake'), 20000);
    expect(h.wakes.slice(before).some((w) => w.reason === 'relic_seen')).toBe(false);
    await p2.stop();
    await h.close();
  }, 40000);

  it('V4-1e §19.5: pick_relics: true なら、追ってくる敵が見えていないときに目的でない遺物を拾い、relic_picked で知らせる', async () => {
    const relicAt = (ar: Ar, x: number, y: number): Entity => ({ id: 'e_rlc002', kind: 'core:relic_hunter', sid: ++esid, role: 'relic', pos: { floor: ar.key, x: ar.ox + x, y: ar.oy + y }, item: { qty: 1, affixes: [] } } as unknown as Entity);
    const { h, a } = await arenaHarness('pilot-relic-pick', ['P.......', '........'], (ar) => [relicAt(ar, 5, 1)], { rev: 1, policy: { pick_relics: true } }, { unknown: 'right' });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'relic_picked'), 20000);
    expect(h.wakes.find((w) => w.reason === 'relic_picked')!.level).toBe('notify');
    expect(rows(h.dir).some((r) => r.source === 'pilot' && r.tool === 'travel_to' && (r.args as { to?: unknown }).to === 'e_rlc002')).toBe(true);
    expect(a.world.entities['e_rlc002']?.item?.heldBy).toBe(a.meId);
    await p.stop();
    await h.close();
  }, 30000);

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

  it('--wake-cmd: 起こすたびにコマンドを起動する（標準入力に summary、環境変数に state.json・orders.json のパスと段と理由）。コマンドが書いた orders.json の返事で動き出す', async () => {
    const h = await harness();
    // 別の機械の AI の代わり: 起こされたら記録を残し、キャンプなら orders.json に出発の命令を書く（rev を上げる。別の名前で書いてから置き換える）
    const tools = mkdtempSync(join(tmpdir(), 'muse-pilot-wake-'));
    const script = join(tools, 'ai.mjs');
    const marker = join(tools, 'calls.jsonl');
    writeFileSync(script, [
      "import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (d) => { input += d; });",
      "process.stdin.on('end', () => {",
      "  const e = process.env;",
      "  appendFileSync(process.argv[2], JSON.stringify({ level: e.MUSE_PILOT_LEVEL, reason: e.MUSE_PILOT_REASON, state: e.MUSE_PILOT_STATE, orders: e.MUSE_PILOT_ORDERS, stdin: input }) + '\\n');",
      "  if (e.MUSE_PILOT_LEVEL !== 'wake' || e.MUSE_PILOT_REASON !== 'camp') return;",
      "  const st = JSON.parse(readFileSync(e.MUSE_PILOT_STATE, 'utf8'));",
      "  const cur = JSON.parse(readFileSync(e.MUSE_PILOT_ORDERS, 'utf8'));",
      "  const next = { ...cur, rev: cur.rev + 1, queue: [{ tool: 'start_expedition', args: { offer: st.camp.offers[0].index } }] };",
      "  writeFileSync(e.MUSE_PILOT_ORDERS + '.ai.tmp', JSON.stringify(next));",
      "  renameSync(e.MUSE_PILOT_ORDERS + '.ai.tmp', e.MUSE_PILOT_ORDERS);",
      "});",
    ].join('\n'));
    const p = start(h, { wakeCmd: `node ${JSON.stringify(script)} ${JSON.stringify(marker)}` });
    // コマンドの返事（orders.json）で、遠征を始めて動き出す
    await until(() => rows(h.dir).some((r) => r.source === 'queue' && r.tool === 'start_expedition' && r.ok === true), 20000);
    await until(() => rows(h.dir).some((r) => r.source === 'pilot'), 20000);
    const calls = readFileSync(marker, 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { level: string; reason: string; state: string; orders: string; stdin: string });
    const camp = calls.find((c) => c.reason === 'camp')!;
    expect(camp).toBeTruthy();
    expect(camp.level).toBe('wake');
    expect(camp.state).toBe(join(h.dir, 'state.json'));
    expect(camp.orders).toBe(join(h.dir, 'orders.json'));
    // 標準入力の summary は state.json の summary と同じ形（観測の要約の行から始まる）
    expect(camp.stdin.trim().length).toBeGreaterThan(0);
    expect(camp.stdin).toContain('キャンプ');
    await p.stop();
    await h.close();
  }, 40000);

  it('--wake-url: 起こすたびに JSON を POST する（段・理由・summary・2 つのファイルのパス・state）。受け口が書いた orders.json の返事で動き出す', async () => {
    const h = await harness();
    const got: { level: string; reason: string; summary: string; state_path: string; orders_path: string; state: { run_id: string; status: string; camp?: { offers: { index: number }[] } } }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const j = JSON.parse(body) as (typeof got)[number];
        got.push(j);
        // AI の代わり: キャンプで起こされたら、出発の命令を書く
        if (j.level === 'wake' && j.reason === 'camp') {
          const cur = JSON.parse(readFileSync(j.orders_path, 'utf-8'));
          writeFileSync(j.orders_path, JSON.stringify({ ...cur, rev: cur.rev + 1, queue: [{ tool: 'start_expedition', args: { offer: j.state.camp!.offers[0]!.index } }] }));
        }
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/wake`;
    const p = start(h, { wakeUrl: url });
    await until(() => rows(h.dir).some((r) => r.source === 'queue' && r.tool === 'start_expedition' && r.ok === true), 20000);
    const camp = got.find((g) => g.reason === 'camp')!;
    expect(camp).toMatchObject({ level: 'wake', reason: 'camp', state_path: join(h.dir, 'state.json'), orders_path: join(h.dir, 'orders.json') });
    expect(camp.summary.length).toBeGreaterThan(0);
    expect(camp.state.status).toBe('camp');
    expect(camp.state.run_id).toMatch(/^run_/);
    // 知らせ（notify）も同じ受け口に届く（段で見分ける）
    await until(() => rows(h.dir).some((r) => r.source === 'pilot'), 20000);
    await p.stop();
    await new Promise<void>((r) => server.close(() => r()));
    await h.close();
  }, 40000);

  it('mode: stop で終える', async () => {
    const h = await harness('solo', { rev: 1, mode: 'stop' });
    const res = await start(h).done;
    expect(res.outcome).toBe('stopped');
    await h.close();
  }, 20000);
});

// ---- V4-1g（IMPROVEMENTS_V4 §24.2〜§24.5）: サーバーにつないで ----
describe('V4-1g: pilot の危ないときの順序・協力プレイ・記録・通信のやり直し', () => {
  it('相手にしないと決めた敵に撃たれたら、階段でその階を出る（leave_floor を知らせる。行の why は leave_floor）', async () => {
    const { h } = await arenaHarness('v41g-leave', ['....P.....', '..........'], (ar) => [shooter(ar, 'e_arch03', 8, 0)], { rev: 1, policy: { ignore: ['e_arch03'] } }, { hp: 60, stairs: [0, 1] });
    const p = start(h);
    await until(() => h.wakes.some((w) => w.reason === 'leave_floor'), 20000);
    await until(() => rows(h.dir).some((r) => r.why === 'leave_floor'), 20000);
    expect(h.wakes.find((w) => w.reason === 'leave_floor')!.level).toBe('notify');
    // 出るまで、相手にしない射手は殴らない
    expect(rows(h.dir).some((r) => r.source === 'pilot' && (r.args as { target?: string }).target === 'e_arch03')).toBe(false);
    await p.stop();
    await h.close();
  }, 40000);

  it('起こすたびに wakes/<連番>.json に写しを残す（手番・HP・理由・state）。log.jsonl の pilot の行に why（queue の行は queue）', async () => {
    const h = await harness('solo', { rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }] });
    const p = start(h, { maxActions: 30, responder: simpleResponder });
    const res = await p.done;
    expect(res.outcome).toBe('safety');
    const files = readdirSync(join(h.dir, 'wakes')).sort();
    expect(files.length).toBeGreaterThan(0);
    const last = JSON.parse(readFileSync(join(h.dir, 'wakes', files.at(-1)!), 'utf-8')) as { n: number; level: string; reason: string; turn: number; hp: number; max_hp: number; state: { run_id: string } };
    expect(last).toMatchObject({ n: files.length, level: 'escalate', reason: 'safety' });
    expect(last.turn).toBeGreaterThan(0);
    expect(last.max_hp).toBeGreaterThan(0);
    expect(last.state.run_id).toMatch(/^run_/);
    expect(h.wakes.at(-1)!.wakePath).toBe(join(h.dir, 'wakes', files.at(-1)!));
    const own = rows(h.dir).filter((r) => r.source === 'pilot');
    expect(own.length).toBeGreaterThan(5);
    for (const r of own) expect(typeof r.why).toBe('string');
    expect(rows(h.dir).filter((r) => r.source === 'queue').every((r) => r.why === 'queue')).toBe(true);
    await h.close();
  }, 40000);

  it('協力プレイで迷宮にいるときに安全装置に達したら、帰ってから終える（closing を知らせ、safety は「帰ってから終えた」）', async () => {
    const h = await harness('coop', { rev: 1, policy: { allow_lifeline: true, coop: { wait_for_join: false } }, queue: [{ tool: 'start_expedition', args: { offer: 1 } }] });
    const p = start(h, { maxActions: 25 });
    const res = await p.done;
    expect(res.outcome).toBe('safety');
    expect(h.wakes.some((w) => w.reason === 'closing' && w.level === 'notify')).toBe(true);
    const safety = h.wakes.find((w) => w.reason === 'safety')!;
    expect(safety.level).toBe('escalate');
    expect(safety.detail).toContain('帰ってから終えた');
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).camp).toBeTruthy();
    await h.close();
  }, 60000);

  it('通信が切れたら間を空けてやり直し、つながったら続ける。つながらないまま retryMaxMs を過ぎたら safety（connection）で上げて終える', async () => {
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const manager = new SessionManager(content, config);
    let app = createApp(manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const port = (app.server.address() as AddressInfo).port;
    const r = await manager.createRun({ name: 'Pilot', seed: 'v41g-net', classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' } });
    if ('error' in r) throw new Error(r.error.message);
    const dir = mkdtempSync(join(tmpdir(), 'muse-pilot-test-'));
    writeFileSync(join(dir, 'orders.json'), JSON.stringify({ rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }] }));
    const wakes: WakeEvent[] = [];
    const ac = new AbortController();
    const done = runPilot({ baseUrl: `http://127.0.0.1:${port}`, token: r.token, dir, pollMs: 20, log: () => {}, signal: ac.signal, maxActions: 5000, retryBaseMs: 50, retryMaxMs: 1500, onWake: (ev) => wakes.push(ev) });
    const down = async () => { app.server.closeAllConnections(); await new Promise<void>((r2) => app.server.close(() => r2())); };
    // 1 回目: 切って、すぐに同じ番地で開き直す
    await until(() => rows(dir).filter((x) => x.source === 'pilot').length >= 3, 20000);
    await down();
    await new Promise((r2) => setTimeout(r2, 200));
    app = createApp(manager, config);
    await new Promise<void>((r2) => app.server.listen(port, '127.0.0.1', () => r2()));
    const n0 = rows(dir).length;
    await until(() => rows(dir).length >= n0 + 5, 20000);
    expect(wakes.some((w) => w.reason === 'safety')).toBe(false);
    // 2 回目: 切ったまま。retryMaxMs を過ぎたら、上げて終える
    await down();
    const res = await done;
    expect(res).toMatchObject({ outcome: 'safety', reason: 'connection' });
    const safety = wakes.find((w) => w.reason === 'safety')!;
    expect(safety.level).toBe('escalate');
    expect(safety.detail).toContain('つながらない');
    manager.closeAll();
  }, 60000);
});

// ---- V4-1i（IMPROVEMENTS_V4 §28）: サーバーにつないで ----
describe('V4-1i: 黙って止まらない・危ないときは帰る・断られた命令をくり返さない', () => {
  /** HP を変える（最大はそのまま） */
  const setHp = (a: Ar, hp: number) => { const me = structuredClone(a.world.entities[a.meId]!); me.stats!.hp = hp; a.inject({ put: [me] }); };

  it('B1: 立て直しの 3 の fight が hp_floor で断られたら、同じ手番に出し直さず、段の次の手へ移る（5 命令以内）', async () => {
    const { h, a } = await arenaHarness('v41i-b1', ['P.........', '..........'], (ar) => [actor(ar, 'e_bru001', 'core:goblin', 1, 0, { archetype: 'melee_chaser', hp: 300, dmg: '1d10' })], undefined, { hp: 40 });
    // fight が始める前に断る（hp_risk）のは、被弾の記録のある相手だけ: 先に 1 回は当たってもらう
    for (let k = 0; k < 20 && a.world.entities[a.meId]!.stats!.hp >= 40; k++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 始める前に断られる HP: 立て直しの線（20）未満、危険域（10）以上、記録された最悪の 1 手を受けると fight の hp_floor（9）を割る
    const worst = a.r.port.observe({}).observation.visible.monsters.find((m) => m.id === 'e_bru001')!.worst_turn ?? 0;
    expect(worst).toBeGreaterThan(1);
    setHp(a, Math.max(10, 8 + worst));
    const p = start(h, { maxActions: 40 });
    await until(() => rows(h.dir).filter((r) => r.source === 'pilot' && r.tool).length >= 5, 20000);
    await p.stop();
    const own = rows(h.dir).filter((r) => r.source === 'pilot' && r.tool).slice(0, 5);
    const fights = own.filter((r) => r.tool === 'fight' && r.ok === false);
    expect(fights.length, JSON.stringify(own.map((r) => `${r.tool}:${r.ok}:${r.why}`))).toBeLessThanOrEqual(2);
    expect(own.some((r) => r.tool !== 'fight'), JSON.stringify(own.map((r) => `${r.tool}:${r.ok}:${r.why}`))).toBe(true);
    await h.close();
  }, 40000);

  it('§28.2 の 1: danger を上げたら（escalate・返事は待たない）、HP が戻っても、その遠征は帰る（探索に戻らない）。写しの HP は起こすと決めた時点のもの（B4）', async () => {
    const { h, a } = await arenaHarness('v41i-danger', ['........P.', '..........'], () => [], undefined, { hp: 60, stairs: [0, 1] });
    setHp(a, 10);
    let healed = false;
    const p = start(h, { maxActions: 60, responder: (ev) => { if (ev.reason === 'danger' && !healed) { healed = true; setHp(a, 60); } } });
    await until(() => rows(h.dir).some((r) => r.tool === 'extract' && r.ok === true), 30000);
    await p.stop();
    const all = rows(h.dir);
    const di = all.findIndex((r) => r.wake === 'danger');
    expect(all[di]!.level).toBe('escalate');
    const after = all.slice(di).filter((r) => r.source === 'pilot' && r.tool);
    expect(after.some((r) => r.tool === 'explore'), JSON.stringify(after.map((r) => `${r.tool}:${r.why}`))).toBe(false);
    // 写し（wakes/）の HP と、説明（HP が危険域 (10/60)）は同じ時点
    const snap = readdirSync(join(h.dir, 'wakes')).map((f) => JSON.parse(readFileSync(join(h.dir, 'wakes', f), 'utf-8')) as { reason: string; hp: number; detail: string }).find((s) => s.reason === 'danger')!;
    expect(snap.hp).toBe(10);
    expect(snap.detail).toContain('(10/60)');
    await h.close();
  }, 50000);

  it('B4: 薬を使う前に上げる: danger の写しの HP は使う前のもの（説明と同じ時点）', async () => {
    const { h, a } = await arenaHarness('v41i-b4', ['P.........', '..........'], () => [], undefined, { hp: 60, items: [{ kind: 'core:potion_healing', qty: 1 }] });
    setHp(a, 10);
    const p = start(h, { maxActions: 20 });
    await until(() => rows(h.dir).some((r) => r.tool === 'use_item' && r.ok === true), 20000);
    await p.stop();
    const snaps = readdirSync(join(h.dir, 'wakes')).map((f) => JSON.parse(readFileSync(join(h.dir, 'wakes', f), 'utf-8')) as { reason: string; hp: number; detail: string; level: string });
    const d = snaps.find((s) => s.reason === 'danger')!;
    expect(d.level).toBe('escalate');
    expect(d.hp).toBe(10);
    expect(d.detail).toContain('(10/60)');
    await h.close();
  }, 40000);

  it('B7: キャンプで返事を待ったまま 2 分黙ったら、いまの状態を添えて上げる（safety。pilot は止めない）', async () => {
    const h = await harness();
    let t = 1_000_000;
    const p = start(h, { now: () => t });
    await until(() => h.wakes.some((w) => w.reason === 'camp'), 20000);
    t += 3 * 60000;
    await until(() => h.wakes.some((w) => w.reason === 'safety'), 20000);
    const s = h.wakes.find((w) => w.reason === 'safety')!;
    expect(s.level).toBe('escalate');
    expect(s.detail).toContain('命令も知らせも出していない');
    expect(s.detail).toContain('camp の返事を待っている');
    // 終えていない（上げるのは 1 回）
    t += 3 * 60000;
    await new Promise((r) => setTimeout(r, 300));
    expect(h.wakes.filter((w) => w.reason === 'safety')).toHaveLength(1);
    await p.stop();
    await h.close();
  }, 40000);

  it('B7: 協力プレイで待つ理由（waiting_join）を知らせに出す', async () => {
    const h = await harness('coop');
    const p = start(h, { mode: 'coop' });
    await until(() => h.wakes.some((w) => w.reason === 'waiting_join'), 20000);
    expect(h.wakes.find((w) => w.reason === 'waiting_join')!.level).toBe('notify');
    expect(JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf-8')).status).toBe('waiting_join');
    await p.stop();
    await h.close();
  }, 30000);

  it('B5: pilot が探索している間でも、仲間が idle_minutes 動かなければ party_idle を上げる', async () => {
    const config = loadConfig({ port: 0, runsDir: null, profilesDir: null, waitOthersMs: 100 });
    const manager = new SessionManager(content, config);
    const app = createApp(manager, config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const r = await manager.createRun({ name: 'Pilot', seed: 'v41i-b5', classId: 'core:warrior', controller: { kind: 'agent', label: 'pilot' }, mode: 'coop' });
    if ('error' in r) throw new Error(r.error.message);
    r.session.world.meta.options.turnTimeoutMs = 50;
    const b = await manager.joinRun(r.session.runId, { name: 'Idle', controller: { kind: 'human', label: 'idle' } });
    if ('error' in b) throw new Error(b.error.message);
    expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'muse-pilot-test-'));
    // ついていかずに自分で探索する（follow: none）
    writeFileSync(join(dir, 'orders.json'), JSON.stringify({ rev: 1, policy: { coop: { follow: 'none', idle_minutes: 10 } } }));
    const h: Harness = { base, token: r.token, dir, wakes: [], close: async () => { manager.closeAll(); await new Promise<void>((r2) => app.server.close(() => r2())); } };
    let t = 5_000_000;
    const p = start(h, { mode: 'coop', now: () => t });
    await until(() => rows(dir).filter((x) => x.source === 'pilot' && (x.tool === 'explore' || x.tool === 'collect' || x.tool === 'fight')).length >= 2, 30000);
    t += 11 * 60000;
    await until(() => h.wakes.some((w) => w.reason === 'party_idle'), 20000);
    expect(h.wakes.find((w) => w.reason === 'party_idle')!.level).toBe('escalate');
    await p.stop();
    await h.close();
  }, 60000);

  it('§28.2 の 4: トークンは pilot の記録・写し・知らせに出ない', async () => {
    const h = await harness('solo', { rev: 1, queue: [{ tool: 'start_expedition', args: { offer: 1 } }] });
    const p = start(h, { maxActions: 15, responder: simpleResponder });
    await p.done;
    const files: string[] = [];
    const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) { const fp = join(d, f.name); if (f.isDirectory()) walk(fp); else files.push(fp); } };
    walk(h.dir);
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) expect(readFileSync(f, 'utf-8').includes(h.token), f).toBe(false);
    for (const w of h.wakes) expect(JSON.stringify(w).includes(h.token)).toBe(false);
    await h.close();
  }, 40000);
});

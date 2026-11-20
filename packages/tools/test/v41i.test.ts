// V4-1i（IMPROVEMENTS_V4 §28）の判断の確かめ（観測は最小限の写し）。サーバーにつないで動かすものは pilot.test.ts の V4-1i の節
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ObsMonster, ObsPartyMember, Observation } from '@muse/shared';
import { decide, defaultOrders, fightArgs, newMemory, pilotToken } from '../src/index';
import type { DecideContext, PilotOrders, PilotState, WakeEvent } from '../src/index';
import { simpleResponder } from '../src/pilot/responder';
import { readOrders } from '../src/pilot/orders';

type Over = { depth?: number; monsters?: ObsMonster[]; stairs?: Observation['navigation']['known_stairs']; objective?: { type: string; target_depth: number | null }; party?: ObsPartyMember[]; status?: string; hp?: number; alerts?: Observation['alerts']; frontiers?: number; sense?: boolean };
function fieldObs(o: Over = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: o.alerts ?? [],
    self: { name: 'P', class: 'x', level: 5, xp: 0, xp_next: 10, hp: o.hp ?? 40, max_hp: 40, statuses: [], pos: { x: 20, y: 10 }, floor: { depth: o.depth ?? 3 }, attack: { acc: 5, dmg: '1d6', throws: [{ slot: 'k', kind: 'core:throwing_knife', name: '投げナイフ', qty: 3 }] }, defense: { eva: 0, armor: 0 }, recovery: [] },
    visible: { monsters: o.monsters ?? [], items: [], players: [], features: [] },
    party: o.party ?? [],
    navigation: { known_stairs: o.stairs ?? [], frontiers: Array.from({ length: o.frontiers ?? 0 }, () => ({ pos: { x: 1, y: 1 }, dir: 'w', dist: 3 })), collectable: { count: 0, ids: [] } },
    expedition: {
      no: 6, objective: { type: o.objective?.type ?? 'reach_depth', target_depth: o.objective?.target_depth ?? 6, text: '目的' }, progress: {}, status: o.status ?? 'in_progress', points: 0,
      can_extract: false, extract_outcome: 'withdraw', text: '遠征 6', haul: { total: 0, multiplier_pct: 100, parts: {}, if_extract_now: 0, next_overreach: null, next_camp: null, text: '戦利品 0' },
      ...(o.sense ? { sense: { what: 'guardian', dir: 'se', range: 'far', text: '気配: 守護者は南東・遠い' } } : {}),
    },
  } as unknown as Observation;
}
function mon(over: Partial<ObsMonster>): ObsMonster {
  return { id: 'e_aaaaaa', name: '敵', pos: { x: 21, y: 10 }, dir: 'e', dist: 1, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [], ...over } as ObsMonster;
}
const ctx = (orders: PilotOrders = defaultOrders(), over: Partial<DecideContext> = {}): DecideContext => ({ orders, coop: false, waiting: false, acked: new Set(), text: '', ...over });
const summary = (r: ReturnType<typeof decide>) => (r.decision.kind === 'wake' ? `${r.decision.wake.level}:${r.decision.wake.reason}` : r.decision.kind === 'act' ? `act:${r.decision.tool}:${JSON.stringify(r.decision.args)}` : r.decision.kind === 'end' ? `end:${r.decision.wake.level}` : `${r.decision.kind}${r.decision.kind === 'idle' && r.decision.wait ? `:${r.decision.wait}` : ''}`);
const member = (o: Partial<ObsPartyMember>): ObsPartyMember => ({ id: 'p_h', name: 'H', controller: 'agent', order: 1, status: 'in_dungeon', floor: 3, hp: 'healthy', last_act: 0, ...o });
const lethal = { code: 'lethal_range', level: 'danger', text: '1 手で倒されうる: 追跡中の敵の 1 手の最悪の被害の合計 30 ≥ HP 12' } as unknown as Observation['alerts'][number];
const upSt = { type: 'up' as const, pos: { x: 5, y: 10 }, dist: 15, reachable: true, path_len: 15 };
const leaderMem = () => { const m = newMemory(); m.follow = { id: 'p_h', exp: 6, met: true, inDungeon: true, lastPos: null, lastFloor: 3, floorAtStart: 3, startTurn: 0 }; return m; };

describe('V4-1i §28.2 の 1: danger は上げて、その遠征は帰る（B2: ソロでも escalate。B4: 命令の前に上げる）', () => {
  it('solo: escalate danger (not notify), switch home (dangerHome = rev), and take the home-side step', () => {
    const o = fieldObs({ hp: 12, alerts: [lethal], stairs: [upSt], monsters: [mon({ dist: 3, pos: { x: 23, y: 10 } })] });
    const r = decide(o, ctx());
    expect(r.notify.find((n) => n.reason === 'danger')?.level).toBe('escalate');
    expect(r.update?.dangerHome).toBe(1);
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"stairs_up","mode":"flee"/);
    // 2 回目（もう帰ると決めた）: 知らせだけ（上げ直さない）
    const m = newMemory(); m.dangerHome = 1;
    const r2 = decide(o, ctx(defaultOrders(), { mem: m }));
    expect(r2.notify.find((n) => n.reason === 'danger')?.level).toBe('notify');
  });
  it('co-op: with the ally on this floor in sight, first goes to the ally once (escalate says so); HP falling further on the way, or joined and still in danger: home', () => {
    const ally = member({ pos: [26, 10], entity: 'e_h00001' });
    const o = fieldObs({ hp: 12, alerts: [lethal], stairs: [upSt], party: [ally], monsters: [mon({ dist: 3, pos: { x: 17, y: 10 } })] });
    const r = decide(o, ctx(defaultOrders(), { coop: true, mem: leaderMem() }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"e_h00001","mode":"flee"/);
    expect(r.update?.dangerJoin).toBe('going');
    expect(r.notify.find((n) => n.reason === 'danger')?.detail).toContain('H の所へ寄る');
    // 寄る途中で HP がさらに減った: 帰る
    const m = leaderMem(); m.dangerJoin = 'going'; m.dangerJoinHp = 12;
    const r2 = decide(fieldObs({ hp: 9, alerts: [lethal], stairs: [upSt], party: [ally], monsters: [mon({ dist: 3, pos: { x: 17, y: 10 } })] }), ctx(defaultOrders(), { coop: true, mem: m }));
    expect(r2.update?.dangerHome).toBe(1);
    expect(summary(r2)).toMatch(/^act:travel_to:\{"to":"stairs_up"/);
    // 合流した（隣）のにまだ危ない: 帰る（寄るのは 1 回）
    const near = member({ pos: [21, 11], entity: 'e_h00001' });
    const r3 = decide(fieldObs({ hp: 12, alerts: [lethal], stairs: [upSt], party: [near], monsters: [mon({ dist: 3, pos: { x: 17, y: 10 } })] }), ctx(defaultOrders(), { coop: true, mem: leaderMem() }));
    expect(r3.update).toMatchObject({ dangerJoin: 'done', dangerHome: 1 });
  });
  it('co-op: the ally on this floor but out of sight: goes to where the ally was last seen; arrived and still unseen, or never seen here: home', () => {
    // §28.2 の 1 は「同じ階で生きているとき」（見えているときに限らない）。協力の測り直しで、相方が見えていなかったので寄らずに綱で帰り、
    // 残った相方が倒れた本があった
    const unseen = member({});
    const o = fieldObs({ hp: 12, alerts: [lethal], stairs: [upSt], party: [unseen], monsters: [mon({ dist: 3, pos: { x: 17, y: 10 } })] });
    const m = leaderMem(); m.follow!.lastPos = { x: 30, y: 4 };
    const r = decide(o, ctx(defaultOrders(), { coop: true, mem: m }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":\{"x":30,"y":4\},"mode":"flee"/);
    expect(r.update?.dangerJoin).toBe('going');
    expect(r.notify.find((n) => n.reason === 'danger')?.detail).toContain('最後に見た位置へ');
    // 最後に見た位置に着いたが、見えない: 帰る（寄るのは 1 回）
    const at = fieldObs({ hp: 12, alerts: [lethal], stairs: [upSt], party: [unseen], monsters: [mon({ dist: 3, pos: { x: 17, y: 10 } })] });
    at.self.pos = { x: 30, y: 5 };
    const m2 = leaderMem(); m2.follow!.lastPos = { x: 30, y: 4 }; m2.dangerJoin = 'going'; m2.dangerJoinHp = 12;
    const r2 = decide(at, ctx(defaultOrders(), { coop: true, mem: m2 }));
    expect(r2.update).toMatchObject({ dangerJoin: 'done', dangerHome: 1 });
    // この階で一度も見ていない（最後に見た位置が無い）: 寄らずに帰る
    const r3 = decide(o, ctx(defaultOrders(), { coop: true, mem: leaderMem() }));
    expect(r3.update?.dangerJoin).toBeUndefined();
    expect(r3.update?.dangerHome).toBe(1);
    // 別の階で最後に見た位置は使わない
    const m4 = leaderMem(); m4.follow!.lastPos = { x: 30, y: 4 }; m4.follow!.lastFloor = 2;
    const r4 = decide(o, ctx(defaultOrders(), { coop: true, mem: m4 }));
    expect(r4.update?.dangerJoin).toBeUndefined();
  });
});

describe('V4-1i B1: 断られた fight を同じ手番に出し続けない', () => {
  it('recovery step 3 skips a target refused this turn; a rule (why) with 3 turnless commands this turn is not used', () => {
    const o = fieldObs({ hp: 15, monsters: [mon({ id: 'e_chs001' })] });
    expect(summary(decide(o, ctx(defaultOrders(), { mem: { ...newMemory(), stairRetreats: 2 } })))).toBe('act:fight:{"target":"e_chs001","hp_floor":9}');
    const r = decide(o, ctx(defaultOrders(), { mem: { ...newMemory(), stairRetreats: 2 }, refusedTargets: new Set(['e_chs001']) }));
    expect(r.decision.kind === 'act' && r.decision.tool).not.toBe('fight');
    const rb = decide(o, ctx(defaultOrders(), { mem: { ...newMemory(), stairRetreats: 2 }, blockedWhys: new Set(['recover']) }));
    expect(rb.decision.kind === 'act' && rb.decision.why).not.toBe('recover');
  });
});

describe('V4-1i B3: ついていく間は、相手が階段の上・隣にいても先に階を移らない', () => {
  it('leader standing next to the down stairs (objective deeper): no travel to the stairs, no use_stairs; even when standing on the stairs', () => {
    const lead = member({ pos: [22, 10], entity: 'e_h00001', floor: 3 });
    const down = { type: 'down' as const, pos: { x: 23, y: 10 }, dist: 3, reachable: true, path_len: 3 };
    const r = decide(fieldObs({ party: [lead], stairs: [down], objective: { type: 'reach_depth', target_depth: 5 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem() }));
    expect(r.decision.kind === 'act' && (r.decision.tool === 'use_stairs' || (r.decision.tool === 'travel_to' && r.decision.args.to === 'stairs_down'))).toBe(false);
    const onDown = { ...down, pos: { x: 20, y: 10 }, dist: 0, path_len: 0 };
    const r2 = decide(fieldObs({ party: [lead], stairs: [onDown], objective: { type: 'reach_depth', target_depth: 5 } }), ctx(defaultOrders(), { coop: true, mem: leaderMem() }));
    expect(r2.decision.kind === 'act' && r2.decision.tool).not.toBe('use_stairs');
  });
});

describe('V4-1i B6: 助けに行く（先頭のときも。探索・拾うをやめる）', () => {
  it('the pilot leads (no one to follow): a badly wounded ally in sight far away → go there (why assist); near with no foe → wait beside (not explore)', () => {
    const hurt = member({ id: 'p_m', name: 'M', order: 2, hp: 'badly_wounded', pos: [28, 10], entity: 'e_m00001' });
    const o = fieldObs({ party: [hurt], frontiers: 3 });
    // 自分が先頭（参加がいちばん早い）: ついていく相手はいない
    const r = decide(o, ctx(defaultOrders(), { coop: true }));
    expect(summary(r)).toMatch(/^act:travel_to:\{"to":"e_m00001","mode":"flee"/);
    expect(r.decision.kind === 'act' && r.decision.why).toBe('assist');
    expect(r.notify.map((n) => n.reason)).toContain('assist');
    const near = member({ id: 'p_m', name: 'M', order: 2, hp: 'near_death', pos: [21, 11], entity: 'e_m00001' });
    const r2 = decide(fieldObs({ party: [near], frontiers: 3 }), ctx(defaultOrders(), { coop: true, mem: { ...newMemory(), assisting: true } }));
    expect(summary(r2)).toBe('act:wait:{}');
    expect(r2.decision.kind === 'act' && r2.decision.why).toBe('assist');
    // 毒などで、相手を追っている敵がいなくても行く（上の 2 つは敵なし）。別の階: 相手の階への階段へ
    const below = member({ id: 'p_m', name: 'M', order: 2, hp: 'badly_wounded', floor: 4 });
    const r3 = decide(fieldObs({ party: [below], frontiers: 3, stairs: [{ type: 'down', pos: { x: 30, y: 10 }, dist: 10, reachable: true, path_len: 10 }] }), ctx(defaultOrders(), { coop: true }));
    expect(summary(r3)).toMatch(/^act:travel_to:\{"to":"stairs_down","mode":"flee"/);
  });
});

describe('V4-1i §28.2 の 2: 仲間が倒れた後', () => {
  const camp = (party: ObsPartyMember[]) => {
    const o = { ...fieldObs(), status: 'at_camp', self: { ...fieldObs().self, pos: null, floor: null }, party, camp: { next_no: 7, offers: [{ index: 1, type: 'slay_guardian', target_depth: 3, points: 100, text: '1', multiplier_pct: 100, recommended_level: 2, level_gap: 0, trait_danger: 0, slot: 'safe' }] } } as unknown as Observation;
    o.expedition = { ...o.expedition!, status: 'ended' };
    return o;
  };
  it('at camp: escalate party_down once and wait; after the reply (acked), carries on alone (no wait_for_join); continue: no escalate', () => {
    const auto = defaultOrders(); auto.camp.auto_start = 'safe';
    const down = [member({ status: 'down', floor: undefined, hp: undefined })];
    const r = decide(camp(down), ctx(auto, { coop: true }));
    expect(summary(r)).toBe('escalate:party_down');
    const key = r.decision.kind === 'wake' ? r.decision.wake.key : '';
    expect(summary(decide(camp(down), ctx(auto, { coop: true, acked: new Set([key]) })))).toBe('act:start_expedition:{"offer":1}');
    const cont = defaultOrders(); cont.camp.auto_start = 'safe'; cont.policy.coop.on_party_down = 'continue';
    expect(summary(decide(camp(down), ctx(cont, { coop: true })))).toBe('act:start_expedition:{"offer":1}');
    // 倒れた仲間はついていく相手にもならない（迷宮で: ついていかずに自分で動く）
    expect(decide(fieldObs({ party: down, frontiers: 2 }), ctx(defaultOrders(), { coop: true })).decision.kind === 'act').toBe(true);
  });
});

describe('V4-1i §28.2 の 3: 逃げた相手には投げる', () => {
  it('after target_fled, the next fight carries the throwing weapon (with), not only on the last retry', () => {
    const o = fieldObs({ monsters: [mon({ id: 'e_run001', dist: 4, pos: { x: 24, y: 10 } })] });
    const p = defaultOrders().policy;
    expect(fightArgs(o, p, newMemory(), 'e_run001', new Set(['core:throwing_knife'])).with).toBeUndefined();
    const m = newMemory(); m.fled = ['e_run001'];
    expect(fightArgs(o, p, m, 'e_run001', new Set(['core:throwing_knife'])).with).toBe('core:throwing_knife');
  });
});

describe('V4-1i B9: toward: sense が断られる階では、方角なしで探す', () => {
  it('seeking the objective guardian: explore toward sense; with senseOff, explore without toward', () => {
    const o = fieldObs({ depth: 4, objective: { type: 'slay_guardian', target_depth: 4 }, frontiers: 3, sense: true });
    const r = decide(o, ctx());
    expect(summary(r)).toBe('act:explore:{"pickup":"useful","toward":"sense"}');
    const m = newMemory(); m.senseOff = true;
    expect(summary(decide(o, ctx(defaultOrders(), { mem: m })))).toBe('act:explore:{"pickup":"useful"}');
  });
});

describe('V4-1i B8: 見本の返事役は、自分が変える項目だけを書き換える', () => {
  it('keeps ignore/unignore and policy written by a person or the AI; keeps a queue the pilot has not loaded yet (and appends its own after it)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41i-resp-'));
    const ordersPath = join(dir, 'orders.json');
    const cur = defaultOrders(); cur.rev = 5; cur.policy.ignore = ['e_ign001']; cur.policy.unignore = ['e_uig001']; cur.policy.wake_hp_pct = 40;
    cur.queue = [{ tool: 'equip', args: { slot: 'd' } }];
    writeFileSync(ordersPath, JSON.stringify(cur));
    const ev = (ordersRev: number, reason = 'perk_pending'): WakeEvent => ({ level: 'wake', reason, key: 'k', detail: 'x', state: { orders_rev: ordersRev, hostiles: [], traps: [], party: [] } as unknown as PilotState, statePath: join(dir, 'state.json'), ordersPath });
    // pilot はまだ rev 4 を読んでいる（rev 5 は AI が書いたばかり）: AI の queue を残して、見本の命令を後ろに足す
    simpleResponder(ev(4));
    const o1 = readOrders(ordersPath)!;
    expect(o1.policy.ignore).toEqual(['e_ign001']);
    expect(o1.policy.unignore).toEqual(['e_uig001']);
    expect(o1.policy.wake_hp_pct).toBe(40);
    expect(o1.queue).toEqual([{ tool: 'equip', args: { slot: 'd' } }, { tool: 'choose_perk', args: { option: 1 } }]);
    // pilot が読み込んだ rev（6）への返事: 済んだ queue は残さない（残すと、rev を上げたときにもう一度出す）。ignore は残す
    simpleResponder(ev(6));
    const o2 = readOrders(ordersPath)!;
    expect(o2.queue).toEqual([{ tool: 'choose_perk', args: { option: 1 } }]);
    expect(o2.policy.ignore).toEqual(['e_ign001']);
  });
});

describe('V4-1i §28.2 の 4: トークンの渡し方', () => {
  it('--token-file (first line), then MUSE_PLAYER_TOKEN, then --token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41i-tok-'));
    const f = join(dir, 'token.txt');
    writeFileSync(f, 'tok_from_file\r\nsecond line\n');
    expect(pilotToken({ tokenFile: f, env: { MUSE_PLAYER_TOKEN: 'tok_env' }, token: 'tok_arg' })).toBe('tok_from_file');
    expect(pilotToken({ env: { MUSE_PLAYER_TOKEN: ' tok_env ' }, token: 'tok_arg' })).toBe('tok_env');
    expect(pilotToken({ env: {}, token: 'tok_arg' })).toBe('tok_arg');
    expect(pilotToken({ env: {} })).toBeUndefined();
    writeFileSync(f, '\n');
    expect(() => pilotToken({ tokenFile: f })).toThrow(/empty/);
  });
});

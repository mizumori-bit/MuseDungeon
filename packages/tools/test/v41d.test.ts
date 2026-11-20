// V4-1d（IMPROVEMENTS_V4 §18）の確認: 道をふさぐ罠を断りのエラーに入れる（details.blocked_by_traps。見つけていない罠は入らない）、
// pilot の離れたままの相手への投げる品（構造化された項目と公開カタログの分類だけで選ぶ）、待つ間に撃ってきた相手への付け替え、返事役の見本は罠なら帰る。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Command, Entity, ObsMonster, Observation } from '@muse/shared';
import { projectPlayerView } from '@muse/shared';
import { ENGINE_VERSION } from '@muse/engine';
import { decide, defaultOrders, fightArgs, newMemory, throwKindsOf } from '../src/index';
import type { DecideContext, PilotState, WakeEvent } from '../src/index';
import { simpleResponder } from '../src/pilot/responder';
import { readOrders } from '../src/pilot/orders';
import { arena } from './v33duel';

let sid = 997700;
type A = Awaited<ReturnType<typeof arena>>;
const act = (a: A, cmd: Command) => a.r.port.act(cmd, { source: 'bot' });
const trap = (a: A, id: string, kind: string, x: number, y: number, found: boolean): Entity =>
  ({ id, kind, sid: ++sid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y }, trap: { revealedTo: found ? [a.pid] : [] } } as unknown as Entity);
const corridor = async (seed: string) => {
  const a = await arena(seed, { map: ['P.......'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
  a.inject({ del: [a.gId] });
  return a;
};

describe('V4-1d blocked_by_traps (§18.1)', () => {
  it('a route that must cross a found trap is refused with that trap in details.blocked_by_traps and the hint; a trap not found is never named', async () => {
    const a = await corridor('v41d-trap-leak');
    // 隣に見つけている毒矢の罠、その先（隣でないので見つからない）に見つけていない警報の罠
    a.inject({ put: [trap(a, 'e_trf001', 'core:trap_dart', 1, 0, true), trap(a, 'e_trh001', 'core:trap_alarm', 3, 0, false)] });
    await act(a, { type: 'wait' });
    expect(projectPlayerView(a.world, a.pid).entities.some((e) => e.id === 'e_trh001')).toBe(false);
    expect(a.world.entities['e_trh001']!.trap!.revealedTo).toEqual([]);
    for (const cmd of [{ type: 'travel', to: { x: a.ox + 6, y: a.oy } }, { type: 'travel', to: { x: a.ox + 7, y: a.oy }, mode: 'steady' }] as Command[]) {
      const res = await act(a, cmd);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('blocked');
        expect(res.error.details?.blocked_by_traps).toEqual([{ id: 'e_trf001', kind: 'core:trap_dart', pos: { x: a.ox + 1, y: a.oy } }]);
        expect(res.error.details?.blocked_by).toBeUndefined();
        expect(res.error.hint).toContain(`毒矢の罠 (${a.ox + 1},${a.oy}) が道をふさいでいる。`);
        expect(res.error.hint).toContain("踏むなら move { dir: 'e' }");
      }
      // 見つけていない罠は、ID も名前も位置も出ない
      expect(JSON.stringify(res)).not.toContain('e_trh001');
      expect(JSON.stringify(res)).not.toContain('警報の罠');
    }
    // 手番を使わない
    expect(a.world.entities[a.meId]!.pos!.x).toBe(a.ox);
    a.manager.closeAll();
  });

  it('two found traps on the only route: nearest first in details, and the hint names the farther one too', async () => {
    const a = await corridor('v41d-trap-two');
    a.inject({ put: [trap(a, 'e_trf002', 'core:trap_dart', 1, 0, true), trap(a, 'e_trf003', 'core:trap_teleport', 4, 0, true)] });
    await act(a, { type: 'wait' });
    const res = await act(a, { type: 'travel', to: { x: a.ox + 6, y: a.oy } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.details?.blocked_by_traps?.map((t) => t.id)).toEqual(['e_trf002', 'e_trf003']);
      expect(res.error.hint).toContain(`毒矢の罠 (${a.ox + 1},${a.oy}) が道をふさいでいる（この道の先にも 転移の罠 (${a.ox + 4},${a.oy})）。`);
    }
    a.manager.closeAll();
  });

  it('English hint, and the macro still never steps on the trap by itself; engineVersion is bumped', async () => {
    const a = await corridor('v41d-trap-en');
    a.world.players[a.pid].locale = 'en';
    a.inject({ put: [trap(a, 'e_trf004', 'core:trap_dart', 1, 0, true)] });
    await act(a, { type: 'wait' });
    const res = await act(a, { type: 'travel', to: { x: a.ox + 6, y: a.oy } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.hint).toContain(`The poison dart trap at (${a.ox + 1},${a.oy}) blocks the way.`);
    expect(ENGINE_VERSION >= '0.32.0').toBe(true);
    a.manager.closeAll();
  });
});

/** 判断の表に渡す観測（最小限。決める行だけを確かめる） */
function obsOf(over: { monsters?: ObsMonster[]; throws?: NonNullable<Observation['self']['attack']['throws']> } = {}): Observation {
  return {
    status: 'your_turn', seq: 100, summary: 's', alerts: [],
    self: { name: 'P', class: 'x', level: 1, xp: 0, xp_next: 10, hp: 40, max_hp: 40, statuses: [], pos: { x: 10, y: 10 }, floor: { depth: 1 }, attack: { acc: 5, dmg: '1d6', ...(over.throws ? { throws: over.throws } : {}) }, defense: { eva: 0, armor: 0 }, recovery: [] },
    visible: { monsters: over.monsters ?? [], items: [], players: [], features: [] },
    navigation: { known_stairs: [], frontiers: [{ x: 1, y: 1 }], collectable: { count: 0, ids: [] } },
    expedition: null,
  } as unknown as Observation;
}
function mon(over: Partial<ObsMonster>): ObsMonster {
  return { id: 'e_aaaaaa', name: '敵', pos: { x: 14, y: 10 }, dir: 'e', dist: 4, hp_state: 'healthy', awareness: 'hunting', threat: 1, statuses: [], worst_hit: 2, speed: 'normal', traits: [], worst_turn: 2, shot: 'clear', shots: [], ...over } as ObsMonster;
}
const ctx = (over: Partial<DecideContext> = {}): DecideContext => ({ orders: defaultOrders(), coop: false, waiting: false, acked: new Set(), text: '', ...over });
const KINDS = new Set(['core:javelin', 'javelin', 'core:throwing_knife', 'throwing_knife']);
const THROWS = [{ slot: 'b', kind: 'potion_poison', name: '毒薬', dmg: null, acc: 5, range: 4 }, { slot: 'c', kind: 'javelin', name: '投げ槍', dmg: '1d8+1', acc: 5, range: 6 }, { slot: 'd', kind: 'throwing_knife', name: '投げナイフ', dmg: '1d4+1', acc: 6, range: 7 }];

describe('V4-1d pilot: throwing on the last retry, retargeting the shooter (§18.2)', () => {
  it('throwKindsOf picks only items the public catalog classes as throwing weapons (never a potion, never by name)', () => {
    expect(throwKindsOf(obsOf({ throws: THROWS }), KINDS)).toEqual(['javelin', 'throwing_knife']);
    expect(throwKindsOf(obsOf({ throws: [THROWS[0]!] }), KINDS)).toEqual([]);
    // 名前が投げ槍でも、種類が分からない（未鑑定）・分類が投げる武器でない品は選ばない
    expect(throwKindsOf(obsOf({ throws: [{ slot: 'e', name: '投げ槍', dmg: '1d8+1', acc: 5, range: 6 }] }), KINDS)).toEqual([]);
    expect(throwKindsOf(obsOf({ throws: THROWS }), new Set())).toEqual([]);
  });

  it('fightArgs: wait → advance → throw (the last retry before give_up_after) for a target that stayed away; allow_throw: false never throws', () => {
    const o = obsOf({ throws: THROWS });
    const p = defaultOrders().policy;
    const mem = newMemory();
    expect(fightArgs(o, p, mem, 'e_arch01', KINDS)).toEqual({ target: 'e_arch01', hp_floor: 20 });
    mem.stops['e_arch01'] = 1; mem.advance.push('e_arch01'); mem.away.push('e_arch01');
    expect(fightArgs(o, p, mem, 'e_arch01', KINDS)).toEqual({ target: 'e_arch01', hp_floor: 20, approach: 'advance' });
    mem.stops['e_arch01'] = 2;
    expect(fightArgs(o, p, mem, 'e_arch01', KINDS)).toEqual({ target: 'e_arch01', hp_floor: 20, with: ['javelin', 'throwing_knife'], adjacent: 'melee' });
    expect(fightArgs(o, { ...p, allow_throw: false }, mem, 'e_arch01', KINDS)).toEqual({ target: 'e_arch01', hp_floor: 20, approach: 'advance' });
    // 離れたままでない相手（ほかの止まり方）には投げない
    const m2 = newMemory(); m2.stops['e_foe001'] = 2;
    expect(fightArgs(o, p, m2, 'e_foe001', KINDS).with).toBeUndefined();
    // 投げる武器を持っていなければ、寄るやり直しのまま
    expect(fightArgs(obsOf({ throws: [THROWS[0]!] }), p, mem, 'e_arch01', KINDS).with).toBeUndefined();
  });

  it('after shot_while_waiting: fights the seen shooter first; with no shooter seen, backs off once along the trail', () => {
    const near = mon({ id: 'e_near01', dist: 2, pos: { x: 12, y: 10 } });
    const shooter = mon({ id: 'e_shot01', dist: 5, pos: { x: 15, y: 10 }, traits: ['ranged'] });
    const o = obsOf({ monsters: [near, shooter] });
    const mem = newMemory();
    expect(decide(o, ctx({ mem })).decision).toMatchObject({ kind: 'act', tool: 'fight', args: { target: 'e_near01' } });
    mem.shotBy = 'e_shot01';
    expect(decide(o, ctx({ mem })).decision).toMatchObject({ kind: 'act', tool: 'fight', args: { target: 'e_shot01' } });
    // 撃ってきた相手が見えない: 来た道を 1 回戻る（記録を消す）
    const m2 = newMemory();
    m2.backOff = true;
    m2.trail = [{ x: 2, y: 10 }, { x: 6, y: 10 }, { x: 10, y: 10 }];
    const r = decide(obsOf({ monsters: [near] }), ctx({ mem: m2 }));
    expect(r.decision).toMatchObject({ kind: 'act', tool: 'travel_to', args: { to: { x: 2, y: 10 }, mode: 'flee' } });
    expect(r.update?.backOff).toBe(false);
  });

  it('step_on_traps: an adjacent blocking trap is stepped on with one move (notify stepped_on_trap); a far one is walked up to; false leaves it', () => {
    const o = obsOf();
    const tb = { tool: 'explore', traps: [{ id: 'e_trp001', kind: 'core:trap_dart', pos: { x: 11, y: 9 } }] };
    const on = { ...defaultOrders(), policy: { ...defaultOrders().policy, step_on_traps: true } };
    const r = decide(o, ctx({ orders: on, trapBlock: tb, refused: new Set(['explore']), refusal: { code: 'blocked', text: 'x', traps: tb.traps } }));
    expect(r.decision).toMatchObject({ kind: 'act', tool: 'move', args: { dir: 'ne' } });
    expect(r.notify.map((n) => `${n.level}:${n.reason}`)).toEqual(['notify:stepped_on_trap']);
    expect(r.notify[0]!.detail).toContain('e_trp001 (11,9)');
    const far = { tool: 'explore', traps: [{ id: 'e_trp002', kind: 'core:trap_dart', pos: { x: 13, y: 10 } }] };
    expect(decide(o, ctx({ orders: on, trapBlock: far, refused: new Set(['explore']) })).decision).toMatchObject({ kind: 'act', tool: 'travel_to', args: { to: { x: 13, y: 10 } } });
    // 既定（false）: 踏まずに、断りの理由で起こす（detail の先頭に罠の行・位置・方角）
    const w = decide(o, ctx({ trapBlock: tb, refused: new Set(['explore']), refusal: { code: 'blocked', text: '道が罠にふさがれている', traps: tb.traps } }));
    expect(w.decision.kind).toBe('wake');
    if (w.decision.kind === 'wake') {
      expect(w.decision.wake.reason).toBe('refused_blocked');
      expect(w.decision.wake.detail.split('\n')[0]).toBe('道をふさぐ罠: core:trap_dart e_trp001 (11,9)（方角 ne・隣）');
    }
  });
});

describe('V4-1d sample responder (§18.1)', () => {
  it('goes home when a trap blocks the way (never fights a trap id); still fights a plain blocking enemy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-v41d-resp-'));
    const ordersPath = join(dir, 'orders.json');
    const base = { hostiles: [{ id: 'e_foe001', name: '敵', pos: [1, 1], dist: 1, hp_state: 'healthy', hunting: true, role: null, objective: false, ignored: false }], traps: [{ id: 'e_trp001', name: '毒矢の罠', pos: [3, 2], dist: 1 }] } as unknown as PilotState;
    const ev = (detail: string): WakeEvent => ({ level: 'wake', reason: 'refused_blocked', key: 'k', detail, state: base, statePath: join(dir, 'state.json'), ordersPath });
    writeFileSync(ordersPath, JSON.stringify(defaultOrders()));
    simpleResponder(ev('道をふさぐ罠: 毒矢の罠 e_trp001 (3,2) 東1（方角 e・隣）\ns\nblocked: ...'));
    // 帰る: mode return（綱を queue に書かない。V4-1e §19.4）
    expect(readOrders(ordersPath)!.queue).toEqual([]);
    expect(readOrders(ordersPath)!.mode).toBe('return');
    simpleResponder(ev('- 敵 e_foe001 (1,1)\ns'));
    expect(readOrders(ordersPath)!.queue).toEqual([{ tool: 'fight', args: { target: 'e_foe001', until: 'clear' } }]);
  });
});

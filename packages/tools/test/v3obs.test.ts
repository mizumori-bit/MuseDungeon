// V3-1（観測と操作の修正）: 報告 6 章の 15 項目と、投擲・回収・推定・地図・変化欄のテスト。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { computeFov, createRun, joinPlayer, line, step } from '@muse/engine';
import type { Entity, GameEvent, Observation, PerceivedEvent, PlayerView, World } from '@muse/shared';
import {
  applyEvent, buildObservation, diffChanges, filterEventsForPlayer, formatObservationText, hpEstimateText, hpLeftEstimate, macroNext,
  macroStart, mapTextLines, narrate, projectPlayerView, renderAsciiMap, turnSnapshot,
} from '@muse/shared';
import { DIR_VEC } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { rulesText } from '../../server/src/mcp/rules';

const content = loadContent();
const catalog = buildCatalog(content);

// ---------- 盤面を組み立てる道具（applyEvent 経由でだけ書き換える） ----------
interface Scene { world: World; pid: string; me: string; cseq: number }

function newScene(seed: string, classId = 'core:scout'): Scene {
  const { world } = createRun(content, { runId: 'run_v3test', seed, wall: 1 });
  const j = joinPlayer(world, content, { type: 'join', name: 'T', classId, controller: { kind: 'agent', label: 't' }, locale: 'ja' }, { cseq: 1, wall: 2 });
  if (!j.ok) throw new Error('join failed');
  const sc: Scene = { world, pid: j.playerId, me: world.players[j.playerId].entityId, cseq: 10 };
  // 既存のモンスターを片付ける
  const del = Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id);
  inject(sc, { del });
  return sc;
}

function inject(sc: Scene, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(sc.world, { type: 'thought', player: sc.pid, text: '', seq: sc.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}

let sidN = 900000;
function goblin(id: string, x: number, y: number): Entity {
  sidN++;
  return {
    id, kind: 'core:goblin', sid: sidN, pos: { floor: 'main:1', x, y },
    actor: { speed: 100, nextActAt: 1e9, faction: 'monster', turns: 0, dormant: true, ai: { archetype: 'melee_chaser', state: 'asleep', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp: 30, maxHp: 30, acc: 2, eva: 1, might: 0, armor: 0, sight: 7, dmg: '1d6' },
    base: { maxHp: 30, acc: 2, eva: 1, might: 0, armor: 0, sight: 7, dmg: '1d6' },
    statuses: [],
  };
}

function act(sc: Scene, cmd: Parameters<typeof step>[3]) {
  return step(sc.world, content, sc.pid, cmd, { cseq: sc.cseq++, wall: 3 });
}

function moveMe(sc: Scene, x: number, y: number): void {
  const me = structuredClone(sc.world.entities[sc.me]);
  me.pos = { floor: 'main:1', x, y };
  inject(sc, { put: [me] });
  act(sc, { type: 'wait' }); // 視界と射線を更新
}

const floor = (sc: Scene) => sc.world.floors['main:1'];
const passable = (sc: Scene, x: number, y: number) => {
  const f = floor(sc);
  if (x < 0 || y < 0 || x >= f.width || y >= f.height) return false;
  return content.terrain[content.terrainIndex[sc.world.meta.terrainTable[f.terrain[y * f.width + x]]]].passable;
};
const opaque = (sc: Scene) => (x: number, y: number) => {
  const f = floor(sc);
  if (x < 0 || y < 0 || x >= f.width || y >= f.height) return true;
  return content.terrain[content.terrainIndex[sc.world.meta.terrainTable[f.terrain[y * f.width + x]]]].opaque;
};
const occupied = (sc: Scene, x: number, y: number) => Object.values(sc.world.entities).some((e) => e.pos?.floor === 'main:1' && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));

/** 見えるが投擲の経路が地形で切れる組（P から M） */
function findWallPair(sc: Scene): { p: { x: number; y: number }; m: { x: number; y: number } } {
  const f = floor(sc);
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    if (!passable(sc, x, y) || occupied(sc, x, y)) continue;
    const fov = computeFov(f.width, f.height, opaque(sc), x, y, 9);
    for (const i of fov) {
      const mx = i % f.width, my = Math.trunc(i / f.width);
      const d = Math.max(Math.abs(mx - x), Math.abs(my - y));
      if (d < 2 || d > 6 || !passable(sc, mx, my) || occupied(sc, mx, my)) continue;
      // 射線は双方向（どちらかの直線が通れば通る。V3-2R2）なので、両方向とも壁に当たる組を探す
      const path = line({ x, y }, { x: mx, y: my });
      const back = line({ x: mx, y: my }, { x, y });
      if (path.slice(0, -1).some((c) => !passable(sc, c.x, c.y)) && back.slice(0, -1).some((c) => !passable(sc, c.x, c.y))) return { p: { x, y }, m: { x: mx, y: my } };
    }
  }
  throw new Error('no wall pair');
}

/** P から方向 (dx,dy) に n マス以上まっすぐ通れる開けた直線 */
function findOpenLine(sc: Scene, n: number): { p: { x: number; y: number }; dx: number; dy: number } {
  const f = floor(sc);
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      let ok = true;
      for (let k = 0; k <= n && ok; k++) if (!passable(sc, x + dx * k, y + dy * k) || occupied(sc, x + dx * k, y + dy * k)) ok = false;
      if (ok) return { p: { x, y }, dx, dy };
    }
  }
  throw new Error('no open line');
}

const knifeSlot = (sc: Scene) => projectPlayerView(sc.world, sc.pid).inventory.find((i) => i.kind === 'core:throwing_knife')!.slot;
const lastThrow = (evs: GameEvent[]) => evs.filter((e) => e.type === 'item_thrown').pop() as Extract<GameEvent, { type: 'item_thrown' }>;
const say = (sc: Scene, evs: GameEvent[]) => {
  const view = projectPlayerView(sc.world, sc.pid);
  return filterEventsForPlayer(evs, sc.pid, view).map((e) => narrate(e, { locale: 'ja', catalog, selfId: view.self.id, playerNames: {} })).filter(Boolean).join(' ');
};

describe('V3-1 throwing (report 1, 2, 11)', () => {
  it('a monster behind a wall is shot-blocked, not a throw candidate, and an id throw is refused without spending a turn', () => {
    // 射線は双方向なので「見えるのに両方向とも壁に当たる」組はまれ。見つかるシードを探す
    let found: { sc: Scene; p: { x: number; y: number }; m: { x: number; y: number } } | null = null;
    for (let i = 1; i <= 40 && !found; i++) {
      const s = newScene(`v3-wall-${i}`);
      try { found = { sc: s, ...findWallPair(s) }; } catch { /* 次のシード */ }
    }
    expect(found).not.toBeNull();
    const { sc, p, m } = found!;
    moveMe(sc, p.x, p.y);
    inject(sc, { put: [goblin('e_tstw01', m.x, m.y)] });
    act(sc, { type: 'wait' });
    const view = projectPlayerView(sc.world, sc.pid);
    const gv = view.entities.find((e) => e.id === 'e_tstw01');
    expect(gv).toBeTruthy();
    expect(gv!.shot).toBe(false);
    const obs = buildObservation(view, catalog, { detail: 'brief', map: false });
    expect(obs.visible.monsters[0].shot).toBe('blocked');
    expect(obs.valid_actions.some((a) => a.startsWith('throw_item') && a.includes('e_tstw01'))).toBe(false);
    const seq = sc.world.seq;
    const r = act(sc, { type: 'throw', slot: knifeSlot(sc), target: 'e_tstw01' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('no_line_of_sight');
    expect(sc.world.seq).toBe(seq);
    // 座標を狙っても、経路が通らなければ同じく拒否する（V3-3c §44.6: 護りの火を狙って「届かず」が続いた）
    const r2 = act(sc, { type: 'throw', slot: knifeSlot(sc), target: { x: m.x, y: m.y } });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error.code).toBe('no_line_of_sight');
    expect(sc.world.seq).toBe(seq);
  });

  it('every throw outcome is narrated with the landing spot (hit/missed, blocked by actor, fell short, no target)', () => {
    const sc = newScene('v3-open-1');
    const { p, dx, dy } = findOpenLine(sc, 9);
    moveMe(sc, p.x, p.y);
    // 遮る者: 1 マス先に A、2 マス先に B。B の座標を狙うと A に遮られる
    inject(sc, { put: [goblin('e_tsta01', p.x + dx, p.y + dy), goblin('e_tstb01', p.x + 2 * dx, p.y + 2 * dy)] });
    act(sc, { type: 'wait' });
    // 座標を狙っても、途中の者に遮られるなら拒否する（V3-3c §44.6）
    const blocked = act(sc, { type: 'throw', slot: knifeSlot(sc), target: { x: p.x + 2 * dx, y: p.y + 2 * dy } });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('no_line_of_sight');
    // A を ID で狙う: 命中か外れのどちらか（どちらも文章と落下地点）
    const direct = act(sc, { type: 'throw', slot: knifeSlot(sc), target: 'e_tsta01' });
    const dev = lastThrow(direct.events);
    expect(['hit', 'missed']).toContain(dev.outcome);
    expect(say(sc, direct.events)).toMatch(dev.outcome === 'hit' ? /ゴブリンに命中した。\(\d+,\d+\) に落ちた/ : /ゴブリンには当たらず、\(\d+,\d+\) に落ちた/);
    // 誰もいない場所・射程の外
    inject(sc, { del: ['e_tsta01', 'e_tstb01'] });
    act(sc, { type: 'wait' });
    const empty = act(sc, { type: 'throw', slot: knifeSlot(sc), target: { x: p.x + 3 * dx, y: p.y + 3 * dy } });
    expect(lastThrow(empty.events).outcome).toBe('no_target');
    expect(say(sc, empty.events)).toMatch(/\(\d+,\d+\) に落ちた/);
    // 射程の外の座標は拒否する（V3-3c §44.6）
    const far = act(sc, { type: 'throw', slot: knifeSlot(sc), target: { x: p.x + 9 * dx, y: p.y + 9 * dy } });
    expect(far.ok).toBe(false);
    if (!far.ok) expect(far.error.code).toBe('out_of_range');
  });

  it('throw candidates are clear shots in range, attackers first (report 11); harmful potions are thrown, not drunk', () => {
    const sc = newScene('v3-open-2');
    const { p, dx, dy } = findOpenLine(sc, 6);
    moveMe(sc, p.x, p.y);
    inject(sc, { put: [goblin('e_tstn01', p.x + 2 * dx, p.y + 2 * dy), goblin('e_tstf01', p.x + 5 * dx, p.y + 5 * dy)] });
    act(sc, { type: 'wait' });
    const view = projectPlayerView(sc.world, sc.pid);
    const recent: PerceivedEvent[] = [{ seq: 1, type: 'attack', text: '', event: { type: 'attack', attacker: 'e_tstf01', target: view.self.id, hit: false } as never }];
    const obs = buildObservation(view, catalog, { detail: 'brief', map: false, recent });
    const throws = obs.valid_actions.filter((a) => a.startsWith('throw_item'));
    // 近い方は遠い方を遮るので、射線が通るのは近い方だけ。遠い方を攻撃者にしても候補にならない
    expect(throws.some((a) => a.includes('e_tstf01'))).toBe(false);
    expect(throws.some((a) => a.includes('e_tstn01'))).toBe(true);
    // 遮りを外すと、攻撃者（遠い方）が先頭に来る
    inject(sc, { del: ['e_tstn01'] });
    inject(sc, { put: [goblin('e_tstn02', p.x + 2 * dx + (dy !== 0 ? 1 : 0), p.y + 2 * dy + (dx !== 0 ? 1 : 0))] });
    act(sc, { type: 'wait' });
    const v2 = projectPlayerView(sc.world, sc.pid);
    const o2 = buildObservation(v2, catalog, { detail: 'brief', map: false, recent });
    const t2 = o2.valid_actions.filter((a) => a.startsWith('throw_item'));
    if (v2.entities.find((e) => e.id === 'e_tstn02')?.shot) expect(t2[0]).toContain('e_tstf01');
    expect(t2[0]).toContain('あなたを攻撃中');
    // 鑑定済みの毒薬は use_item の候補に出ない
    const harmful = catalog.items['core:potion_poison'];
    expect(harmful.harmful).toBe(true);
  });

  it('your own thrown items are picked up by stepping on them, and collect gathers the rest', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await manager.createRun({ name: 'C', classId: 'core:scout', seed: 'v3-collect-1', controller: { kind: 'agent', label: 't' }, objective: 'endless' });
    if ('error' in r) throw new Error(r.error.message);
    const v0 = r.port.view();
    const pos = v0.self.pos!;
    const knife = v0.inventory.find((i) => i.kind === 'core:throwing_knife')!;
    // 近くの通れるマスへ 2 本投げる
    const f = v0.floor!;
    const targets: { x: number; y: number }[] = [];
    for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
      const x = pos.x + dx, y = pos.y + dy;
      const i = y * f.width + x;
      if (x < 0 || y < 0 || x >= f.width || y >= f.height || !v0.memory.terrain[i]) continue;
      if (!catalog.terrain[v0.terrainTable[v0.memory.terrain[i]]]?.passable) continue;
      targets.push({ x, y });
      if (targets.length === 2) break;
    }
    expect(targets.length).toBeGreaterThan(0);
    for (const tp of targets) await r.port.act({ type: 'throw', slot: knife.slot, target: tp }, { source: 'bot' });
    const v1 = r.port.view();
    const mineSeen = v1.entities.filter((e) => e.cat === 'item' && e.mine).length + v1.memory.remembered.filter((x) => x.cat === 'item' && x.mine).length;
    expect(mineSeen).toBeGreaterThan(0);
    const before = v1.inventory.find((i) => i.kind === 'core:throwing_knife')?.qty ?? 0;
    const out = await r.port.act({ type: 'collect' }, { source: 'bot' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.collected?.picked).toBeGreaterThan(0);
      expect(out.observation.valid_actions.some((a) => a.startsWith('collect ('))).toBe(out.collected!.remaining > 0);
    }
    const after = r.port.view().inventory.find((i) => i.kind === 'core:throwing_knife')?.qty ?? 0;
    expect(after).toBeGreaterThan(before);
    manager.closeAll();
  });
});

describe('V3-1 changes, macros and outcome (report 3, 4, 5, 10, 15)', () => {
  const base = (): { view: PlayerView; obs: Observation } => {
    const sc = newScene('v3-diff-1', 'core:warrior');
    const view = projectPlayerView(sc.world, sc.pid);
    return { view, obs: buildObservation(view, catalog, { detail: 'brief', map: false }) };
  };

  it('a kill is reported as killed (not hostile_gone); a known monster coming back is reappeared (report 4, 5)', () => {
    const { view, obs } = base();
    const prev = turnSnapshot(view, obs);
    prev.hostiles = { e_kill01: 'ゴブリン', e_gone01: '大ネズミ' };
    const cur = turnSnapshot(view, obs);
    const events: PerceivedEvent[] = [{ seq: prev.seq + 1, type: 'died', text: '', event: { type: 'died', id: 'e_kill01', killer: view.self.id } as never }];
    const ch = diffChanges(prev, cur, view, obs, events);
    expect(ch.find((c) => c.code === 'killed')?.entity).toBe('e_kill01');
    expect(ch.filter((c) => c.code === 'hostile_gone').map((c) => c.text)).toEqual(['見えなくなった敵: 大ネズミ']);
    // 再出現
    const v2: PlayerView = structuredClone(view);
    v2.entities.push({ id: 'e_back01', cat: 'monster', kind: 'core:goblin', appearanceId: null, pos: { x: 1, y: 1 }, hp: 'healthy', awareness: 'unaware', firstSeenSeq: 1 });
    const o2 = buildObservation(v2, catalog, { detail: 'brief', map: false });
    const p2 = turnSnapshot(view, obs);
    p2.seq = 50;
    p2.reported = ['e_back01']; // 前の応答で報告した個体（V3-2R: 報告した個体だけを「再び見えた」にする）
    const c2 = diffChanges(p2, turnSnapshot(v2, o2), v2, o2, []);
    expect(c2.some((c) => c.code === 'reappeared' && c.entity === 'e_back01')).toBe(true);
    expect(c2.some((c) => c.code === 'new_hostile')).toBe(false);
  });

  it('macros: fleeing monsters do not stop them; a visible monster turning hunting does (report 15); rest stops for any newcomer (report 10)', () => {
    const { view } = base();
    const v: PlayerView = structuredClone(view);
    // ゴブリンは既知の種族（初見の種族では止まるので、ここでは個体の振る舞いだけを見る）
    v.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [] };
    const mk = (id: string, awareness: 'asleep' | 'unaware' | 'hunting', fleeing = false, first = 1) =>
      ({ id, cat: 'monster' as const, kind: 'core:goblin', appearanceId: null, pos: { x: (v.self.pos!.x + 5), y: v.self.pos!.y }, hp: 'healthy' as const, awareness, fleeing, firstSeenSeq: first });
    // travel 中に既知の逃走中の個体が入っても止まらない
    const st = macroStart(v, { type: 'travel', to: 'stairs_up' }, catalog);
    st.steps = 1;
    st.startSeq = 100;
    const v1 = structuredClone(v);
    v1.entities.push(mk('e_flee01', 'hunting', true, 5));
    const d1 = macroNext(st, v1, catalog, []);
    expect('stop' in d1 && d1.stop === 'hostile_in_view').toBe(false);
    // 見えている敵が追跡に変わると止まる
    const st2 = macroStart(v1, { type: 'explore' }, catalog);
    st2.steps = 1;
    st2.aware = { e_flee01: 'asleep' };
    const v2 = structuredClone(v1);
    v2.entities = v2.entities.map((e) => (e.id === 'e_flee01' ? { ...e, awareness: 'hunting' as const, fleeing: false } : e));
    const d2 = macroNext(st2, v2, catalog, []);
    expect('stop' in d2 && d2.stop).toBe('hostile_alerted');
    // rest は状態によらず、視界に入ったら止まる（ルール文も同じ）
    const hurt = structuredClone(v);
    hurt.self.stats.hp = 1;
    const st3 = macroStart(hurt, { type: 'rest' }, catalog);
    st3.steps = 1;
    const v3 = structuredClone(hurt);
    v3.entities.push(mk('e_late01', 'unaware', false, 2));
    const d3 = macroNext(st3, v3, catalog, []);
    expect('stop' in d3 && d3.stop).toBe('hostile_in_view');
    expect(rulesText('actions', 'ja', catalog)).toContain('敵が視界に入ると（状態によらず）止まる');
    // 自分を狙った攻撃は外れても止まる
    const st4 = macroStart(v, { type: 'explore' }, catalog);
    st4.steps = 1;
    const d4 = macroNext(st4, v, catalog, [{ type: 'attack', target: v.self.id, hit: false } as never]);
    expect('stop' in d4 && d4.stop).toBe('attacked');
  });

  it('macros never attack: an enemy on the next cell stops them (blocked); an awake adjacent enemy stops them at once (hostile_adjacent)', () => {
    const { view, obs } = base();
    const v: PlayerView = structuredClone(view);
    const d = obs.navigation.passable_dirs[0];
    const p = { x: v.self.pos!.x + DIR_VEC[d][0], y: v.self.pos!.y + DIR_VEC[d][1] };
    v.entities.push({ id: 'e_nap001', cat: 'monster', kind: 'core:goblin', appearanceId: null, pos: p, hp: 'healthy', awareness: 'asleep', firstSeenSeq: 1 } as PlayerView['entities'][number]);
    // 眠っている敵のマスへ travel しても、殴らずに止まる（評価で explore が経路上の敵を攻撃した）
    const st = macroStart(v, { type: 'travel', to: p }, catalog);
    const d1 = macroNext(st, v, catalog, []);
    expect('stop' in d1 && d1.stop).toBe('blocked');
    // 隣に起きている敵がいると、理由を hostile_adjacent として動かない（「視界に入った」ではない）
    const v2: PlayerView = structuredClone(v);
    v2.entities = v2.entities.map((e) => (e.id === 'e_nap001' ? { ...e, awareness: 'hunting' as const } : e));
    const st2 = macroStart(v2, { type: 'explore' }, catalog);
    const d2 = macroNext(st2, v2, catalog, []);
    expect('stop' in d2 && d2.stop).toBe('hostile_adjacent');
    expect(rulesText('actions', 'ja', catalog)).toContain('hostile_adjacent');
  });

  it('the action outcome always totals the damage taken until your next turn, matching the HP change (report 3)', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    let checked = 0;
    let hitsChecked = 0;
    for (let s = 0; s < 8 && (checked < 3 || hitsChecked < 1); s++) {
      const r = await manager.createRun({ name: 'H', seed: `v3-harm-${s}`, controller: { kind: 'agent', label: 't' }, objective: 'endless' });
      if ('error' in r) throw new Error(r.error.message);
      for (let i = 0; i < 300 && (checked < 3 || hitsChecked < 1); i++) {
        const v = r.port.view();
        if (v.status !== 'your_turn') break;
        const adj = v.entities.find((e) => e.cat === 'monster' && Math.max(Math.abs(e.pos.x - v.self.pos!.x), Math.abs(e.pos.y - v.self.pos!.y)) === 1);
        const startSeq = v.seq;
        const out = await r.port.act(adj ? { type: 'wait' } : { type: 'explore' }, { source: 'bot' });
        if (!out.ok) continue;
        const m = /合計 (\d+) ダメージ(?:を受けた)?（(?:攻撃 \d+・毒など \d+、)?HP (\d+)→(\d+)(?:、回復 \+(\d+))?）/.exec(out.outcome);
        if (!m) continue;
        const since = r.session.history.filter((e) => e.seq > startSeq);
        const dealt = since.filter((e) => e.type === 'damaged' && e.target === v.self.id)
          .reduce((a, e) => a + ((e as Extract<GameEvent, { type: 'damaged' }>).dealt ?? 0), 0);
        const healed = since.filter((e) => e.type === 'healed' && e.target === v.self.id)
          .reduce((a, e) => a + (e as Extract<GameEvent, { type: 'healed' }>).amount, 0);
        expect(Number(m[1])).toBe(dealt);
        expect(Number(m[2]) - Number(m[3])).toBe(dealt - healed);
        expect(Number(m[4] ?? 0)).toBe(healed);
        // 攻撃の回数と命中の数は、通常の命中（文章を持たない）も含めて実際の attack と一致する（V3-2 評価の不具合）
        const attacks = since.filter((e) => e.type === 'attack' && e.target === v.self.id) as Extract<GameEvent, { type: 'attack' }>[];
        const c = /(\d+) 回攻撃を受け、(\d+) 回命中/.exec(out.outcome);
        if (attacks.length) {
          expect(c).not.toBeNull();
          expect(Number(c![1])).toBe(attacks.length);
          expect(Number(c![2])).toBe(attacks.filter((a) => a.hit).length);
          if (attacks.some((a) => a.hit && !a.crit)) hitsChecked++;
        }
        checked++;
      }
      r.session.close();
    }
    expect(checked).toBeGreaterThan(0);
    expect(hitsChecked).toBeGreaterThan(0);
    manager.closeAll();
  });
});

describe('V3-1 text and map (report 6, 7, 8, 9, 12, 13, 14)', () => {
  it('estimates with few records give only a lower bound; equal bounds print one number (report 6)', () => {
    const mem = { kind: 'core:cave_rat', encounters: 1, kills: 1, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], hpSeen: { min: 3, max: 3, samples: 1 } };
    const e1 = hpLeftEstimate(mem, 'healthy', 0, 3)!;
    expect(e1.max).toBeNull();
    // 記録は標本なので「記録どおりなら」と言い、記録の体力を添える（V3-2R §14.3）
    // 記録が 5 体未満の間は幅を確定値のように見せない（V3-3 の設計の指示）
    // まだ当てていない相手には「残り」と言わず、体力の記録を出す（V4-0b §1.5）
    // 1 体だけの記録は「1 体の記録」と添える（S4 §42.2 の 3）
    expect(hpEstimateText('ja', e1)).toBe('体力の記録 3（1 体の記録。個体差あり）／まだ傷を負っていない');
    // 最大 HP 4（記録 5 体で確定）、見ている間に 3 与えて重傷 → 残り 1
    const e3 = hpLeftEstimate({ ...mem, hpSeen: { min: 4, max: 4, samples: 5 } }, 'badly_wounded', 3, 5)!;
    expect(e3.min).toBe(e3.max);
    expect(hpEstimateText('ja', e3)).toBe(`記録どおりなら残り ${e3.min}／体力の記録 4（5 体とも）`);
  });

  it('pick-up and equip texts keep affixes (report 7); ranged hits use the same verb as misses (report 13); unseen attackers give a direction', () => {
    const ctx = { locale: 'ja' as const, catalog, selfId: 'e_me0001', playerNames: {} };
    const pick = narrate({ type: 'item_picked_up', actor: 'e_me0001', item: 'e_x', kind: 'core:leather_armor', appearanceId: null, qty: 1, slot: 'g', affixes: ['core:reinforced'] } as never, ctx);
    expect(pick).toContain('補強された革鎧');
    const eq = narrate({ type: 'item_equipped', actor: 'e_me0001', item: 'e_x', kind: 'core:leather_armor', appearanceId: null, slotName: 'armor', affixes: ['core:reinforced'] } as never, ctx);
    expect(eq).toContain('補強された革鎧');
    const hit = narrate({ type: 'damaged', target: 'e_me0001', targetKind: 'core:scout', amount: 2, dealt: 2, source: 'e_s', sourceKind: 'core:goblin_slinger', via: 'ranged' } as never, ctx);
    expect(hit).toBe('ゴブリンの投石兵の射撃。あなたは 2 ダメージを受けた。');
    const miss = narrate({ type: 'attack', attacker: 'e_s', attackerKind: 'core:goblin_slinger', target: 'e_me0001', targetKind: 'core:scout', hit: false, crit: false, ranged: true } as never, ctx);
    expect(miss).toContain('ゴブリンの投石兵の射撃');
    const unseen = narrate({ type: 'damaged', target: 'e_me0001', targetKind: 'core:scout', amount: 3, dealt: 3, source: null, sourceKind: null, via: 'ranged', fromDir: 'se' } as never, ctx);
    expect(unseen).toContain('南東から');
    // fromDir は被害者にだけ残る
    const ev = { type: 'damaged', seq: 5, cause: null, floor: 'main:1', ft: 0, wall: 0, seenBy: ['p_a', 'p_b'], masks: { p_a: ['source'], p_b: ['source'] }, target: 'e_vict01', targetKind: 'core:scout', amount: 3, hpAfter: 5, dealt: 3, source: 'e_s', sourceKind: 'core:goblin_slinger', via: 'ranged', fromDir: 'se' } as unknown as GameEvent;
    const mkView = (selfId: string) => ({ self: { id: selfId }, identified: [] }) as unknown as PlayerView;
    expect((filterEventsForPlayer([ev], 'p_a', mkView('e_vict01'))[0] as Record<string, unknown>).fromDir).toBe('se');
    expect((filterEventsForPlayer([ev], 'p_b', mkView('e_other1'))[0] as Record<string, unknown>).fromDir).toBeUndefined();
  });

  it('the "見えるもの" header appears even when only stairs are listed (report 8); camp text has no floor-only fields (report 14)', () => {
    const sc = newScene('v3-text-1', 'core:warrior');
    const view = projectPlayerView(sc.world, sc.pid);
    const obs = buildObservation(view, catalog, { detail: 'brief', map: false });
    obs.visible = { monsters: [], items: [], players: [], features: [] };
    obs.navigation.known_stairs = [{ type: 'down', pos: { x: 3, y: 4 }, dist: 9, reachable: true, path_len: 9 }];
    const text = formatObservationText(obs, 'ja');
    expect(text).toMatch(/見えるもの:\n- 下り階段/);
    const camp = structuredClone(obs);
    camp.status = 'at_camp';
    const ct = formatObservationText(camp, 'ja');
    expect(ct).not.toContain('足元');
    expect(ct).not.toContain('未探索');
    expect(ct).not.toContain('地下-');
  });

  it('every species has its own map letter (report 9); the map is clipped to the floor and carries a coordinate ruler', () => {
    const glyphs = Object.values(catalog.monsters).map((m) => m.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    const sc = newScene('v3-map-1', 'core:warrior');
    const view = projectPlayerView(sc.world, sc.pid);
    const m = renderAsciiMap(view, catalog, { x: -5, y: -5, w: 21, h: 15 });
    expect(m.origin.x).toBeGreaterThanOrEqual(0);
    expect(m.origin.y).toBeGreaterThanOrEqual(0);
    const lines = mapTextLines(m);
    expect(lines[1].trim().startsWith(String(m.origin.x % 10))).toBe(true);
    expect(lines[2].trim().startsWith(String(m.origin.y))).toBe(true);
  });

  it('items in the same cell are listed once with a count (report 12)', () => {
    const sc = newScene('v3-items-1', 'core:warrior');
    const me = sc.world.entities[sc.me];
    const knives: Entity[] = [1, 2, 3].map((n) => ({ id: `e_knf00${n}`, kind: 'core:throwing_knife', sid: 950000 + n, pos: { floor: 'main:1', x: me.pos!.x, y: me.pos!.y }, item: { qty: 1, affixes: [] } }));
    inject(sc, { put: knives });
    act(sc, { type: 'wait' });
    const obs = buildObservation(projectPlayerView(sc.world, sc.pid), catalog, { detail: 'brief', map: false });
    const k = obs.visible.items.filter((i) => i.name === '投げナイフ' && !i.remembered);
    expect(k).toHaveLength(1);
    expect(k[0].qty).toBe(3);
    expect(formatObservationText(obs, 'ja')).toContain('投げナイフ x3');
  });
});

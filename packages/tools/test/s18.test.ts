// S18（SEASON.md §73.2 の 5〜8）の確かめ:
// 5. 進め方の希望（pilot）を取り下げたら、その後の最初の本人の応答に 1 回だけ知らせる（取り下げ → 1 回 → 次は出ない・pilot に戻す → 今までどおり・
//    古いプロフィール（控えが無い）では出さない・人間の冒険者には出さない・観戦の先読みでは控えを進めない）
// 6. 階段で階を移ったとき、前の階の時間は止まる（敵は動かず、散らない）・戻ると、離れたときの所に、追ったまま・次の遠征では落ち着く（engine の事実。engine は変えない）。
//    use_stairs の応答に、追っていた（見えていた）敵の数の 1 行。規則・「取れる手」・階段までの見込みの文
// 7. wait { turns } は、見えている敵に撃たれても止まる。待つ応答の頭に、被害の内訳（だれから・いくつ）と HP
// 8. 帰還の綱を持っていないキャンプの観測に 1 行（遠征を始めると、1 本持たされる）
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { applyEvent, fleeOptionsText, ownerPaceRevokedText, ownerPaceText, STAIRS_STAY_JA, stairsLeftBehindText } from '@muse/shared';
import { loadConfig, rulesText, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 't' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
const REVOKED_JA = ownerPaceRevokedText('ja');
const REVOKED_EN = ownerPaceRevokedText('en');
const PACE_JA = ownerPaceText('ja');

function manager(): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
async function newRun(m: SessionManager, seed: string, o: { controller?: typeof agent | { kind: 'human'; label: string }; locale?: 'ja' | 'en' } = {}) {
  const r = await m.createRun({ name: 'S', seed, classId: 'core:warrior', controller: o.controller ?? agent, ...(o.locale ? { locale: o.locale } : {}) });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof newRun>>;
const campResp = (r: Run) => r.port.observeWithTurn('observed', { detail: 'full' });
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r.port, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}
const inject = (r: Run, p: { put?: Entity[]; del?: string[] }) =>
  applyEvent(r.session.world, { type: 'thought', player: r.playerId, text: '', seq: r.session.world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);

describe('S18 §73.2 の 5: tell the AI once when the owner withdraws the pilot wish', () => {
  it('withdrawn → once (camp text and owner_pace) → not again; back to pilot → as before', async () => {
    const m = manager();
    const r = await newRun(m, 's18-pace-1');
    // 何も伝えていない（控えが無い）: self のままなら、何も出ない
    expect(m.profiles.paceToldOf(r.profile.id)).toBeNull();
    expect(campResp(r).text).not.toContain(REVOKED_JA);
    // pilot にして、本人の応答に出す → 控えは pilot
    m.profiles.setPace(r.profile.id, 'pilot');
    const o1 = campResp(r);
    expect(o1.text).toContain(PACE_JA);
    expect(m.profiles.paceToldOf(r.profile.id)).toBe('pilot');
    // 取り下げる（キャンプの持ち主の口と同じ）→ 次の本人の応答に 1 回だけ
    m.profiles.setPace(r.profile.id, 'self');
    // 観戦の先読み（peek）には出てよいが、控えは進めない
    expect(r.port.observeWithTurn('turn_arrived', { changes: 'peek' }).text).toContain(REVOKED_JA);
    expect(m.profiles.paceToldOf(r.profile.id)).toBe('pilot');
    const o2 = campResp(r);
    const lines = o2.text.split('\n');
    expect(lines.filter((l) => l === REVOKED_JA)).toHaveLength(1);
    // 伝言と同じ場所（「できること」の後）
    expect(lines[lines.findIndex((l) => l.startsWith('できること')) + 1]).toBe(REVOKED_JA);
    expect(o2.observation.self.owner_pace).toEqual({ pace: 'self', text: REVOKED_JA });
    expect(o2.text).not.toContain(PACE_JA);
    expect(m.profiles.paceToldOf(r.profile.id)).toBe('self');
    // 2 回目は出ない
    const o3 = campResp(r);
    expect(o3.text).not.toContain(REVOKED_JA);
    expect(o3.observation.self.owner_pace).toBeUndefined();
    // 遠征を始めた応答にも出ない（もう伝えた）
    const st = await act(r.port, { type: 'start_expedition', offer: 1 });
    expect(r.port.formatActionText(st)).not.toContain(REVOKED_JA);
    await lifelineHome(r);
    // pilot に戻す → 今までどおり（キャンプの観測に 1 行）
    m.profiles.setPace(r.profile.id, 'pilot');
    const o4 = campResp(r);
    expect(o4.text).toContain(PACE_JA);
    expect(o4.observation.self.owner_pace).toEqual({ pace: 'pilot', text: PACE_JA });
  });

  it('withdrawn, and the next response is the start of an expedition: the line goes there (once); English', async () => {
    const m = manager();
    const r = await newRun(m, 's18-pace-2', { locale: 'en' });
    m.profiles.setPace(r.profile.id, 'pilot');
    campResp(r);
    m.profiles.setPace(r.profile.id, 'self');
    const st = await act(r.port, { type: 'start_expedition', offer: 1 });
    const text = r.port.formatActionText(st);
    expect(text.split('\n').filter((l) => l === REVOKED_EN)).toHaveLength(1);
    expect(st.ok && st.observation.self.owner_pace).toEqual({ pace: 'self', text: REVOKED_EN });
    const w = await act(r.port, { type: 'wait' });
    expect(r.port.formatActionText(w)).not.toContain(REVOKED_EN);
    expect(w.ok && w.observation.self.owner_pace).toBeUndefined();
  });

  it('an old profile (no record of what was told) gets nothing; nor does a human adventurer', async () => {
    const m = manager();
    const r = await newRun(m, 's18-pace-3');
    // 古いプロフィール: pilot の控えはあるが、伝えたかの控えが無い（S18 より前）。取り下げても何も出さない
    const prof = m.profiles.store.get(r.profile.id)!;
    prof.pace = 'pilot';
    m.profiles.store.save(prof);
    expect(m.profiles.paceToldOf(r.profile.id)).toBeNull();
    m.profiles.setPace(r.profile.id, 'self');
    expect(campResp(r).text).not.toContain(REVOKED_JA);
    // 人間が自分で遊ぶ冒険者（指図を出せない）: 控えがあっても出さない
    const h = await newRun(m, 's18-pace-4', { controller: { kind: 'human', label: 'browser' } });
    const hp = m.profiles.store.get(h.profile.id)!;
    hp.paceTold = 'pilot';
    m.profiles.store.save(hp);
    expect(campResp(h).text).not.toContain(REVOKED_JA);
    expect(m.profiles.paceToldOf(h.profile.id)).toBe('pilot');
  });

  it('the rules still describe the pilot wish (unchanged)', () => {
    expect(rulesText('directive', 'ja', catalog)).toContain('self.owner_pace');
  });
});

/** 地下 1 階の下り階段の上に立ち、隣に追跡中の敵を n 体置いた場面（ほかの敵は消す） */
async function atStairsWithHunters(seed: string, n: number) {
  const m = manager();
  const r = await newRun(m, seed);
  const w = r.session.world;
  const meId = w.players[r.playerId].entityId;
  expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
  const key = w.entities[meId].pos!.floor;
  const f = w.floors[key];
  const st = f.stairs.down[0];
  const me = structuredClone(w.entities[meId]);
  me.pos = { floor: key, x: st.x, y: st.y };
  const mons = Object.values(w.entities).filter((e) => e.actor && !e.player && e.pos?.floor === key);
  const proto = mons.find((e) => !e.guardian && e.actor?.ai && e.actor.ai.archetype !== 'stationary' && !(e.actor.ai.params.fleeBelowHpPct ?? 0))
    ?? mons.find((e) => !e.guardian && e.actor?.ai && e.actor.ai.archetype !== 'stationary')!;
  const terrainOf = (x: number, y: number) => content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
  const cells: { x: number; y: number }[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const x = st.x + dx, y = st.y + dy;
    const t = terrainOf(x, y);
    if (t?.passable && !t.stairs && !Object.values(w.entities).some((e) => e.id !== meId && e.pos?.floor === key && e.pos.x === x && e.pos.y === y)) cells.push({ x, y });
  }
  expect(cells.length).toBeGreaterThanOrEqual(n);
  const hunters: Entity[] = cells.slice(0, n).map((c, i) => {
    const e = structuredClone(proto);
    e.id = `e_s18h${i}`;
    e.sid = 90_000 + i;
    e.pos = { floor: key, x: c.x, y: c.y };
    e.actor!.ai = { ...e.actor!.ai!, state: 'hunting', targetPos: { x: st.x, y: st.y }, lostTurns: 0 };
    e.actor!.dormant = false;
    return e;
  });
  inject(r, { put: [me, ...hunters], del: mons.map((e) => e.id) });
  // 見え方を今の場面にそろえる（1 手待つ。追っ手は隣で殴ってくる）
  await act(r.port, { type: 'wait' });
  return { m, r, w, meId, key, st };
}
const huntersOf = (w: Run['session']['world']) => Object.values(w.entities).filter((e) => e.id.startsWith('e_s18h') && (e.stats?.hp ?? 0) > 0)
  .map((e) => ({ id: e.id, pos: { ...e.pos! }, state: e.actor?.ai?.state, next: e.actor?.nextActAt }));

describe('S18 §73.2 の 6: pursuers stay on the floor you leave, and that floor\'s time stops', () => {
  it('the facts: frozen while away (waiting upstairs does not scatter them), the same place and state when you return; calm at the next expedition', async () => {
    const { r, w, meId, key, st } = await atStairsWithHunters('s18-stairs-1', 2);
    const seen = r.port.view().entities.filter((e) => e.cat === 'monster' && e.awareness === 'hunting');
    expect(seen).toHaveLength(2);
    const t0 = w.floors[key].time;
    const left = huntersOf(w);
    const down = await act(r.port, { type: 'stairs' });
    expect(down.ok).toBe(true);
    expect(w.entities[meId].pos!.floor).not.toBe(key);
    // 応答に 1 行（見えていた追っ手の数）
    expect(down.ok && down.outcome).toContain('追っていた敵 2 体は、前の階の階段のそばに残っている');
    // 下の階で 6 手番待つ: 前の階の時間は止まったまま、追っ手は同じ所に、追ったまま
    for (let i = 0; i < 6; i++) expect((await act(r.port, { type: 'wait' })).ok).toBe(true);
    expect(w.floors[key].time).toBe(t0);
    expect(huntersOf(w)).toEqual(left);
    expect(left.every((h) => h.state === 'hunting')).toBe(true);
    // 戻ると、階段の上（離れたときのマス）に着き、追っ手はまた隣
    const up = await act(r.port, { type: 'stairs' });
    expect(up.ok).toBe(true);
    const me = w.entities[meId].pos!;
    expect({ floor: me.floor, x: me.x, y: me.y }).toEqual({ floor: key, x: st.x, y: st.y });
    expect(huntersOf(w).every((h) => Math.max(Math.abs(h.pos.x - st.x), Math.abs(h.pos.y - st.y)) <= 1 && h.state === 'hunting')).toBe(true);
    // 次の遠征: すべての階が落ち着く（追跡をやめる。再開するマスが見える敵は離れる）
    expect((await act(r.port, { type: 'extract', confirm: true })).ok).toBe(true);
    expect(r.port.view().status).toBe('at_camp');
    // キャンプにいる間は、まだ前のまま（落ち着くのは遠征を始めたとき）
    expect(huntersOf(w).every((h) => h.state === 'hunting')).toBe(true);
    expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(huntersOf(w).every((h) => h.state !== 'hunting')).toBe(true);
  });

  it('the line counts only hunters that were in view; nothing when no one was hunting you', () => {
    const base = { locale: 'ja' as const, self: { pos: { x: 5, y: 5 } }, floor: { key: 'main:1' }, entities: [] as unknown[] };
    const after = { ...base, self: { pos: { x: 9, y: 9 } }, floor: { key: 'main:2' } };
    const mon = (id: string, x: number, y: number, awareness: string, fleeing = false) => ({ id, cat: 'monster', pos: { x, y }, awareness, ...(fleeing ? { fleeing } : {}) });
    type V = Parameters<typeof stairsLeftBehindText>[1];
    const b1 = { ...base, entities: [mon('a', 5, 6, 'hunting'), mon('b', 9, 9, 'hunting'), mon('c', 6, 6, 'unaware'), mon('d', 4, 4, 'hunting', true)] } as unknown as V;
    expect(stairsLeftBehindText('ja', b1, after as unknown as V)).toBe('追っていた敵 2 体は、前の階に（うち 1 体は階段のそば）残っている（離れている間、その階の時間は止まる。戻ると、離れたときの所にいる。階段のそばの敵とは、また隣り合う）。');
    expect(stairsLeftBehindText('en', b1, after as unknown as V)).toContain('The 2 enemies hunting you stay on the floor you left (1 of them by the stairs)');
    // 追っ手がいない・同じ階のまま
    expect(stairsLeftBehindText('ja', { ...base, entities: [mon('c', 6, 6, 'unaware')] } as unknown as V, after as unknown as V)).toBeNull();
    expect(stairsLeftBehindText('ja', b1, base as unknown as V)).toBeNull();
  });

  it('the rules, the escape options and the stairs estimate say they stay and that the floor\'s time stops', async () => {
    const ja = rulesText('all', 'ja', catalog);
    const en = rulesText('all', 'en', catalog);
    expect(ja).toContain('あなたのいない階の時間は止まるので、離れている間、敵は動かず、散らない（上の階で待っても、散らない）');
    expect(en).toContain('time stops on a floor with no player, so while you are away they do not move or scatter');
    const { r } = await atStairsWithHunters('s18-stairs-2', 2);
    expect(fleeOptionsText(r.port.view(), catalog)).toContain(STAIRS_STAY_JA);
  });
});

describe('S18 §73.2 の 7: waiting while being shot', () => {
  /** 地下 1 階で、見えている射手（投石兵）に撃たれる場面 */
  async function underFire(seed: string) {
    const m = manager();
    const r = await newRun(m, seed);
    const w = r.session.world;
    const meId = w.players[r.playerId].entityId;
    expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const key = w.entities[meId].pos!.floor;
    const f = w.floors[key];
    const me = w.entities[meId].pos!;
    const terrainOf = (x: number, y: number) => content.terrain[content.terrainIndex[w.meta.terrainTable[f.terrain[y * f.width + x]]]];
    // 自分から一直線に 3 マス（間も通れる）のマスを探す
    let at: { x: number; y: number } | null = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const cs = [1, 2, 3].map((k) => ({ x: me.x + dx * k, y: me.y + dy * k }));
      if (cs.every((c) => c.x > 0 && c.y > 0 && c.x < f.width - 1 && c.y < f.height - 1 && terrainOf(c.x, c.y)?.passable && !terrainOf(c.x, c.y)?.stairs)) { at = cs[2]; break; }
    }
    expect(at).not.toBeNull();
    const mons = Object.values(w.entities).filter((e) => e.actor && !e.player && e.pos?.floor === key);
    // engine の makeMonster と同じ形（格 0・接辞なし。体力は多めにして倒れないように）
    const def = content.monsters['core:goblin_slinger'];
    const { archetype, ...params } = def.ai;
    const base = { maxHp: 60, acc: def.stats.acc + 10, eva: def.stats.eva, might: def.stats.might, armor: def.stats.armor, sight: def.stats.sight, dmg: def.attack.dice };
    const sl: Entity = {
      id: 'e_s18sl', kind: def.id, sid: 91_000, pos: { floor: key, x: at!.x, y: at!.y },
      actor: { speed: def.speed, nextActAt: f.time + 1, faction: 'monster', turns: 0, ai: { archetype, state: 'hunting', targetPos: { x: me.x, y: me.y }, lostTurns: 0, params: params as Record<string, number> } },
      stats: { hp: 60, ...base }, base, statuses: [], xp: def.xp,
    } as Entity;
    inject(r, { put: [sl], del: mons.map((e) => e.id) });
    await act(r.port, { type: 'wait' });
    return { m, r, w, meId };
  }

  it('wait { turns } stops when a monster already in view shoots you; the head of the response says who and how much', async () => {
    // 撃たれるまで、いくつかの種で試す（当たるかは出目による）
    let checked = false;
    for (const seed of ['s18-wait-1', 's18-wait-2', 's18-wait-3', 's18-wait-4', 's18-wait-5']) {
      const { r } = await underFire(seed);
      const res = await act(r.port, { type: 'wait', turns: 8 });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      const hit = res.events.some((e) => e.type === 'damaged');
      if (!hit) continue;
      // 撃たれたら止まる（8 手数を待ち切らない）
      expect(res.interrupted_by === 'attacked' || res.interrupted_by === 'damaged').toBe(true);
      expect((res.steps ?? 0)).toBeLessThan(8);
      const head = r.port.formatActionText(res).split('\n')[0];
      expect(head).toMatch(/^結果: wait: \d+ 手待った（時間 \d+）。停止: 攻撃を受けた。/);
      expect(head).toMatch(/回攻撃を受け、\d+ 回命中・合計 \d+ ダメージ（HP \d+→\d+）/);
      expect(head).toMatch(/被害の内訳: [^ ]+ e_s18sl \d+。/);
      checked = true;
      break;
    }
    expect(checked).toBe(true);
  });

  it('a single wait (one turn) also says who hit you, at the head', async () => {
    let checked = false;
    for (const seed of ['s18-w1-1', 's18-w1-2', 's18-w1-3', 's18-w1-4', 's18-w1-5', 's18-w1-6']) {
      const { r } = await underFire(seed);
      for (let i = 0; i < 4 && !checked; i++) {
        const res = await act(r.port, { type: 'wait' });
        if (!res.ok || !res.events.some((e) => e.type === 'damaged')) continue;
        const head = r.port.formatActionText(res).split('\n')[0];
        expect(head).toMatch(/^結果: 待機した。.*回攻撃を受け、.*（HP \d+→\d+）.*被害の内訳: .+ e_s18sl \d+。/);
        checked = true;
      }
      if (checked) break;
    }
    expect(checked).toBe(true);
  });
});

describe('S18 §73.2 の 8: the lifeline at camp', () => {
  it('no lifeline at camp → one line after the offers; with one → none', async () => {
    const m = manager();
    const r = await newRun(m, 's18-rope');
    // 最初のキャンプ（まだ持っていない）
    const c0 = campResp(r);
    const line = '帰還の綱は持っていない。次の遠征を始めると、キャンプが 1 本持たせる（費用なし。持てるのは 1 本まで）';
    const has = r.port.view().inventory.some((it) => it.kind === 'core:lifeline');
    if (!has) expect(c0.text.split('\n')).toContain(line);
    // 遠征を始めると、1 本持たされる
    expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(r.port.view().inventory.filter((it) => it.kind === 'core:lifeline')).toHaveLength(1);
    // 使って帰ったキャンプ: 持っていない → 1 行（候補の並びのすぐ後）
    await lifelineHome(r);
    const c1 = campResp(r);
    const lines = c1.text.split('\n');
    const i = lines.indexOf(line);
    expect(i).toBeGreaterThan(-1);
    expect(lines[i - 1]).toContain('endless)');
    expect(c1.observation.camp?.lifeline_text).toBe(line);
    // 次の遠征を始めると、また 1 本
    expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(r.port.view().inventory.filter((it) => it.kind === 'core:lifeline')).toHaveLength(1);
    // 持ったまま（階段で撤退して）帰ったキャンプには出ない
    const w = r.session.world;
    const meId = w.players[r.playerId].entityId;
    const f = w.floors[w.entities[meId].pos!.floor];
    const me = structuredClone(w.entities[meId]);
    me.pos = { ...me.pos!, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
    inject(r, { put: [me], del: Object.values(w.entities).filter((e) => e.actor && !e.player && e.pos?.floor === me.pos!.floor).map((e) => e.id) });
    await act(r.port, { type: 'wait' });
    const ex = await act(r.port, { type: 'extract', confirm: true });
    expect(ex.ok).toBe(true);
    expect(r.port.view().status).toBe('at_camp');
    expect(campResp(r).text).not.toContain(line);
  });
});

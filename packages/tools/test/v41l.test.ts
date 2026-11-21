// V4-1l（IMPROVEMENTS_V4 §34）: やめるのは「倒すまでの見込み」で決める（give_up_hits）・装甲の高い相手に「投擲に弱い」を引かない
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Entity, GameEvent } from '@muse/shared';
import { applyEvent } from '@muse/shared';
import { createRun, ENGINE_VERSION, generateFloor, previewOffers, previewWarden, rollGuardianInfo, rollWardenInfo, specArmor } from '@muse/engine';
import { loadConfig, rulesText, SessionManager } from '@muse/server';
import type { FightStat } from '../src/index';
import { defaultOrders, giveUpText, hitsNeeded, hitsSinceDrop, noteStage, parseOrders, throughVerdict } from '../src/index';

const content = loadContent();
const catalog = buildCatalog(content);
const TH = 'core:weak_thrown';
const tt = content.terrain.map((t) => t.id);
const stat = (o: Partial<FightStat>): FightStat => ({ id: 'e_grd001', name: 'キモルヤ', exp: 6, depth: 5, warden: true, objective: true, stage0: 'healthy', stageM0: 'healthy', stageT0: null, stage: 'healthy', mHits: 0, mDealt: 0, tHits: 0, tDealt: 0, selfHp0: 60, selfHp: 40, ...o });
const pol = (policy: Record<string, unknown> = {}) => parseOrders({ rev: 1, policy }).policy;

describe('V4-1l §34.1: switch by count, give up by the estimate of hits still needed', () => {
  it('give_up_hits is a policy (default 30, at least 1)', () => {
    expect(defaultOrders().policy.give_up_hits).toBe(30);
    expect(pol({ give_up_hits: 45 }).give_up_hits).toBe(45);
    expect(pol({ give_up_hits: 0 }).give_up_hits).toBe(30);
  });
  it('the estimate: hp_left_est (the upper bound, else the lower) ÷ the better per-hit damage of the methods with 6 or more hits', () => {
    expect(hitsNeeded(stat({ mHits: 6, mDealt: 15 }), { min: 70, max: 84 })).toEqual({ need: 34, hp: 84, per: 2.5, floorOnly: false });
    expect(hitsNeeded(stat({ mHits: 6, mDealt: 15 }), { min: 70, max: null })).toMatchObject({ need: 28, hp: 70, floorOnly: true });
    // 投擲は 6 回当てるまで使わない（落ち着くまで待つ）。6 回当てたら大きいほう
    expect(hitsNeeded(stat({ mHits: 7, mDealt: 14, tHits: 3, tDealt: 15 }), { min: 60, max: 60 })).toMatchObject({ per: 2, need: 30 });
    expect(hitsNeeded(stat({ mHits: 7, mDealt: 14, tHits: 6, tDealt: 24 }), { min: 60, max: 60 })).toMatchObject({ per: 4, need: 15 });
    expect(hitsNeeded(stat({ mHits: 5, mDealt: 10 }), { min: 60, max: 60 })).toBeNull();
    expect(hitsNeeded(stat({ mHits: 9, mDealt: 18 }), null)).toBeNull();
  });
  it('more than 30 hits needed: give up even before the stage drops; within 30: keep going past 6 hits without a drop', () => {
    const p = defaultOrders().policy;
    // 体力の目安 84・1 回 2.5 → あと 34 回（30 回を超える）: 段階が下がる前でもやめる（6 回当てた時点から見る）
    expect(throughVerdict(stat({ mHits: 6, mDealt: 15 }), p, false, { min: 70, max: 84 })).toBe('give_up');
    expect(throughVerdict(stat({ mHits: 5, mDealt: 12 }), p, false, { min: 70, max: 84 })).toBe('ok');
    // あと 20 回: 6 回を超えて段階が下がらなくても続ける（投げられれば投げる。手を替えるのは今までどおり回数で）
    expect(throughVerdict(stat({ mHits: 7, mDealt: 18 }), p, false, { min: 40, max: 50 })).toBe('ok');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 18 }), p, true, { min: 40, max: 50 })).toBe('throw');
    expect(throughVerdict(stat({ mHits: 20, mDealt: 50 }), p, false, { min: 40, max: 50 })).toBe('ok');
    // give_up_hits を上げれば続ける
    expect(throughVerdict(stat({ mHits: 6, mDealt: 15 }), pol({ give_up_hits: 40 }), false, { min: 70, max: 84 })).toBe('ok');
  });
  it('after switching to throws, the estimate waits for 6 throw hits (and then uses the better of the two)', () => {
    const p = defaultOrders().policy;
    const est = { min: 80, max: 84 };
    // 近接 7 回（1 回 2）で段階が下がらない → 投げる。投げて 3 回の間は、見込みが大きくてもやめない
    expect(throughVerdict(stat({ mHits: 7, mDealt: 14 }), p, true, est)).toBe('throw');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 14, tHits: 3, tDealt: 9, stageT0: 'healthy' }), p, true, est)).toBe('throw');
    // 投げて 6 回: 大きいほう（投擲 3.0）で あと 28 回 → 続ける。投擲 2.5 なら あと 34 回 → やめる
    expect(throughVerdict(stat({ mHits: 7, mDealt: 14, tHits: 6, tDealt: 18, stageT0: 'healthy' }), p, true, est)).toBe('throw');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 14, tHits: 6, tDealt: 15, stageT0: 'healthy' }), p, true, est)).toBe('give_up');
    // 投げても近接より通らない（3 回当てて）: 近接に戻す（やめるのは見込みで）
    expect(throughVerdict(stat({ mHits: 7, mDealt: 21, tHits: 3, tDealt: 6, stageT0: 'healthy' }), p, true, { min: 30, max: 30 })).toBe('ok');
  });
  it('no hp_left_est (guardians, wardens, kinds without records): give up after 12 hits with no stage drop since the last drop', () => {
    const p = defaultOrders().policy;
    expect(throughVerdict(stat({ mHits: 11, mDealt: 22 }), p, false)).toBe('ok');
    expect(throughVerdict(stat({ mHits: 12, mDealt: 24 }), p, false)).toBe('give_up');
    expect(throughVerdict(stat({ mHits: 12, mDealt: 24 }), pol({ fight_with: 'melee' }), true)).toBe('give_up');
    // 段階が下がったら数え直す（8 回目で下がった → その後 6 回）
    expect(throughVerdict(stat({ mHits: 14, mDealt: 28, stage: 'wounded', dropHits: 8 }), p, false)).toBe('ok');
    expect(throughVerdict(stat({ mHits: 20, mDealt: 40, stage: 'wounded', dropHits: 8 }), p, false)).toBe('give_up');
    // 投げ始めたら、投げて 6 回当てるまではやめない（近接 7・投擲 5 で合わせて 12 でも）
    expect(throughVerdict(stat({ mHits: 7, mDealt: 14, tHits: 5, tDealt: 12, stageT0: 'healthy' }), p, true)).toBe('throw');
    expect(throughVerdict(stat({ mHits: 7, mDealt: 14, tHits: 6, tDealt: 13, stageT0: 'healthy' }), p, true)).toBe('give_up');
    // 先に投げる: 投げて 12 回当てても下がらなければやめる
    expect(throughVerdict(stat({ stageM0: null, tHits: 12, tDealt: 24, stageT0: 'healthy' }), pol({ fight_with: 'throw_first' }), true)).toBe('give_up');
    expect(throughVerdict(stat({ stageM0: null, tHits: 9, tDealt: 18, stageT0: 'healthy' }), pol({ fight_with: 'throw_first' }), true)).toBe('throw');
  });
  it('noteStage remembers the hit count of the last drop', () => {
    const st = stat({ mHits: 9, mDealt: 20 });
    noteStage(st, 'healthy');
    expect(st.dropHits).toBeUndefined();
    expect(hitsSinceDrop(st)).toBe(9);
    noteStage(st, 'wounded');
    expect(st.dropHits).toBe(9);
    st.mHits = 13;
    expect(hitsSinceDrop(st)).toBe(4);
  });
  it('the not_getting_through detail carries the estimate and the numbers it came from', () => {
    const p = defaultOrders().policy;
    const a = giveUpText(stat({ mHits: 6, mDealt: 15 }), p, { min: 70, max: 84 }, false);
    expect(a).toContain('倒すまでにあと 34 回ほど当てる見込み（残りの体力の目安 84 ÷ 1 回あたり 2.5）');
    expect(a).toContain('give_up_hits（30 回）を超える');
    expect(giveUpText(stat({ mHits: 6, mDealt: 15 }), p, { min: 70, max: null }, false)).toContain('残りの体力の目安 70 以上');
    const b = giveUpText(stat({ mHits: 12, mDealt: 24 }), pol({ fight_with: 'melee' }), null, true);
    expect(b).toContain('残りの体力の目安が無い相手に、12 回当てても HP の段階が下がらない（12 回でやめる）');
    expect(b).toContain('fight_with: melee');
  });
});

describe('V4-1l §34.2: no "weak to thrown" on a guardian with an armor estimate of 5 or more', () => {
  it('the data and the rules text carry the cap', () => {
    expect(content.guardianWeaknesses[TH].maxArmor).toBe(4);
    expect(catalog.guardianWeaknesses[TH].maxArmor).toBe(4);
    expect(catalog.guardianWeaknesses['core:weak_poison'].maxArmor).toBeUndefined();
    expect(rulesText('classes', 'ja', catalog)).toContain('投擲に弱い: 投擲のダメージが 1.5 倍（端数は切り上げ）（装甲の目安が 4 を超える相手には付かない）');
    expect(rulesText('classes', 'en', catalog)).toContain('never on a guardian whose armor estimate exceeds 4');
    expect(ENGINE_VERSION >= '0.37.0').toBe(true);
  });
  it('rolling: armor 4 or less (or no armor given) gives the same weakness as before; armor 5+ re-rolls only when the pick was thrown', () => {
    let rerolled = 0;
    for (let s = 0; s < 200; s++) {
      const seed = `v41l-r-${s}`;
      const base = rollGuardianInfo(content, seed, 3, s % 3, 2).weakness;
      expect(rollGuardianInfo(content, seed, 3, s % 3, 2, { armor: 4 }).weakness).toBe(base);
      const heavy = rollGuardianInfo(content, seed, 3, s % 3, 2, { armor: 7 }).weakness;
      expect(heavy).not.toBe(TH);
      if (base !== TH) expect(heavy).toBe(base);
      else rerolled++;
      const wb = rollWardenInfo(content, seed, 5).weakness;
      expect(rollWardenInfo(content, seed, 5, 3).weakness).toBe(wb);
      const wh = rollWardenInfo(content, seed, 5, 6).weakness;
      expect(wh).not.toBe(TH);
      if (wb !== TH) expect(wh).toBe(wb);
    }
    expect(rerolled).toBeGreaterThan(0);
  });
  it('guardian offers: armor 5+ never weak to thrown; 4 or less still can be', () => {
    let heavy = 0, lightThrown = 0;
    for (let s = 0; s < 40; s++) {
      const world = createRun(content, { runId: 'run_v41l', seed: `v41l-o-${s}`, wall: 1 }).world;
      for (let no = 2; no <= 6; no++) {
        for (const o of previewOffers(world, content, no)) {
          if (!o.guardianKind || !o.guardian || o.rechallenge) continue;
          const armor = o.guardian.armor ?? 0;
          if (armor >= 5) { heavy++; expect(o.guardianWeakness).not.toBe(TH); } else if (o.guardianWeakness === TH) lightThrown++;
          // 引いた弱点が付けられる相手は、今までと同じ
          const before = rollGuardianInfo(content, world.secret.seed, no, o.index - 1, o.guardian.rank).weakness;
          if (armor < 5 || before !== TH) expect(o.guardianWeakness).toBe(before);
        }
      }
    }
    expect(heavy).toBeGreaterThan(0);
    expect(lightThrown).toBeGreaterThan(0);
  });
  it('milestone wardens: the generated weakness fits the armor; the preview (archive memory) is the same as the generated one', () => {
    let heavy = 0, lightThrown = 0;
    const world = createRun(content, { runId: 'run_v41l', seed: 'v41l-w', wall: 1 }).world;
    for (let s = 0; s < 60; s++) {
      const seed = `v41l-w-${s}`;
      const g = generateFloor(content, seed, 'main', 5, tt);
      const sp = g.spawns.find((x) => x.type === 'monster' && x.guardian?.warden);
      if (!sp || sp.type !== 'monster') continue;
      const armor = specArmor(content, sp);
      if (armor >= 5) { heavy++; expect(sp.guardian!.weakness).not.toBe(TH); } else if (sp.guardian!.weakness === TH) lightThrown++;
      expect(sp.guardian!.weakness).toBe(rollWardenInfo(content, seed, 5, armor).weakness);
      // 下見（記録庫の記憶が使う）は、生成と同じ弱点・装甲
      world.secret.seed = seed;
      const pv = previewWarden(world, content, 5);
      expect(pv).toMatchObject({ kind: sp.kind, armor, weakness: sp.guardian!.weakness });
    }
    expect(heavy).toBeGreaterThan(0);
    expect(lightThrown).toBeGreaterThan(0);
  });
  it('a warden that already exists keeps its weakness (an old Kimoruya: armor 7, weak to thrown) across the next expedition, and the preview reports it', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await m.createRun({ name: 'W', seed: 'v41l-live', classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
    if ('error' in r) throw new Error(r.error.message);
    const w = r.session.world;
    const pid = r.port.playerId;
    const meId = w.players[pid].entityId;
    const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
    const moveTo = async (x: number, y: number) => {
      const me = structuredClone(w.entities[meId]); me.pos = { floor: me.pos!.floor, x, y };
      inject({ put: [me], del: Object.values(w.entities).filter((e) => e.actor && !e.player && !e.guardian && e.pos?.floor === me.pos!.floor).map((e) => e.id) });
      await r.port.act({ type: 'wait' }, { source: 'bot' });
    };
    expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    while (w.floors[w.entities[meId].pos!.floor].depth < 5) {
      const f = w.floors[w.entities[meId].pos!.floor];
      await moveTo(f.stairs.down[0].x, f.stairs.down[0].y);
      expect((await r.port.act({ type: 'stairs' }, { source: 'bot' })).ok).toBe(true);
    }
    const wardenOn = () => Object.values(w.entities).find((e) => e.guardian?.warden && e.pos?.floor === 'main:5' && (e.stats?.hp ?? 0) > 0);
    const g0 = structuredClone(wardenOn()!);
    g0.guardian!.weakness = TH;
    g0.stats!.armor = 7;
    inject({ put: [g0] });
    expect(previewWarden(w, content, 5)).toMatchObject({ armor: 7, weakness: TH });
    const f = w.floors['main:5'];
    await moveTo(f.stairs.up!.x, f.stairs.up!.y);
    expect((await r.port.act({ type: 'extract', confirm: true }, { source: 'bot' })).ok).toBe(true);
    expect((await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
    const g1 = wardenOn()!;
    expect(g1.id).toBe(g0.id);
    expect(g1.guardian!.weakness).toBe(TH);
    m.closeAll();
  });
});

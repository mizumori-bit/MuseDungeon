// V3-2（戦利品と確定）: 払い戻しの規則、観測の if_extract_now と実際の確定額の一致、候補の枠・条件・危険度、宝、積み上げ、スコア版 2。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { createRun, generateFloor, joinPlayer, step } from '@muse/engine';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { applyEvent, buildObservation, haulTotal, payoutOf, projectPlayerView, Rng } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { greedyDecide, newMemo, playWithPort } from '../src/index';

const content = loadContent();
const catalog = buildCatalog(content);

describe('V3-2 payout rules', () => {
  it('extract banks haul × multiplier; withdraw banks (haul − objective) × withdrawPct; the multiplier only applies to extraction', () => {
    const parts = { objective: 3000, overreach: 600, treasure: 180, bounty: 400, discovery: 80, kills: 70 };
    expect(haulTotal(parts)).toBe(4330);
    expect(payoutOf(catalog.rules, parts, true, 120)).toBe(Math.trunc((4330 * 120) / 100));
    expect(payoutOf(catalog.rules, parts, false, 120)).toBe(Math.trunc(((4330 - 3000) * catalog.rules.haul.withdrawPct) / 100));
  });

  it('the observed if_extract_now equals what extract actually banks (several seeds, completed and withdrawn)', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const checks: { outcome: string; expected: number; got: number }[] = [];
    for (let s = 0; s < 6; s++) {
      const r = await manager.createRun({ name: 'P', seed: `v3-pay-${s}`, controller: { kind: 'agent', label: 't' } });
      if ('error' in r) throw new Error(r.error.message);
      const port = r.port;
      // extract の直前の観測を控え、実際に増えた確定点と比べる（bot の判断には手を出さない）
      const spy = new Proxy(port, {
        get(target, prop) {
          if (prop === 'act') {
            return async (cmd: Command, meta: { source: 'bot' }) => {
              if (cmd.type !== 'extract' || target.view().status !== 'your_turn') return target.act(cmd, meta);
              const o = buildObservation(target.view(), catalog, { detail: 'brief', map: false });
              const before = target.view().record.banked;
              const out = await target.act(cmd, meta);
              if (out.ok && o.expedition?.can_extract) checks.push({ outcome: o.expedition.extract_outcome, expected: o.expedition.haul!.if_extract_now, got: target.view().record.banked - before });
              return out;
            };
          }
          const val = Reflect.get(target, prop, target) as unknown;
          return typeof val === 'function' ? (val as (...a: unknown[]) => unknown).bind(target) : val;
        },
      });
      await playWithPort(spy, { kind: 'greedy', seed: `v3-pay-${s}`, maxActs: 1500, maxExpeditions: 3 });
      r.session.close();
    }
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) expect(c.got).toBe(c.expected);
    expect(checks.some((c) => c.outcome === 'complete' && c.got > 0)).toBe(true);
    manager.closeAll();
  }, 120000);
});

describe('V3-2 offers, treasure, haul', () => {
  it('new_run without objective starts at camp; offers are 3 slots with distinct types and non-overlapping depths, level gap and trait danger (V3-2R §14.4)', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await manager.createRun({ name: 'O', seed: 'v3-offers-1', controller: { kind: 'agent', label: 't' } });
    if ('error' in r) throw new Error(r.error.message);
    const view = r.port.view();
    expect(view.status).toBe('at_camp');
    expect(r.session.world.expeditions ?? []).toHaveLength(0);
    const o = r.port.observeWithTurn('observed', { map: false });
    expect(o.turn.awaiting).toBe('camp_choice');
    const offers = o.observation.camp!.offers;
    expect(offers.map((x) => x.slot)).toEqual(['safe', 'standard', 'ambitious']);
    // 最初の候補は浅い（堅実 地下2階、標準・野心 地下3階）。種類は 3 枠で別
    expect(offers.map((x) => x.target_depth)).toEqual([2, 3, 3]);
    expect(new Set(offers.map((x) => x.type)).size).toBe(3);
    for (const x of offers) {
      expect(x.level_gap).toBe(x.recommended_level! - view.self.level);
      expect(x.text).toMatch(/推奨 Lv\d+・あなた Lv\d+（差 [+-]?\d+）/);
    }
    const amb = r.session.world.camp!.offers[2];
    expect(amb.traits!.length).toBeGreaterThanOrEqual(1);
    expect(offers[2].trait_danger).toBe(amb.traits!.reduce((a, id) => a + content.expeditionTraits[id].danger, 0));
    expect(amb.multiplierPct).toBe(amb.traits!.reduce((m, id) => Math.trunc((m * content.expeditionTraits[id].multiplierPct) / 100), 100));
    expect(offers[0].text).toContain('[堅実]');
    // 候補を選ぶと最初の遠征が始まり、入口から盤面に出る
    const st = await r.port.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' });
    expect(st.ok).toBe(true);
    expect(r.port.view().status).toBe('your_turn');
    expect(r.session.world.expeditions![0].slot).toBe('safe');
    // 2 回目以降も枠の深さは重ならない（堅実 +1・標準 +2・野心 +3〜4）
    const rules = content.balance.expedition.slots;
    expect([rules.safe.aheadMax < rules.standard.aheadMin, rules.standard.aheadMax < rules.ambitious.aheadMin]).toEqual([true, true]);
    manager.closeAll();
  });

  it('treasure shows its value when seen; extract removes it from the inventory and banks it', () => {
    // 宝の価値は生成の時点で決まり、同じシードなら同じ
    const table = content.terrain.map((t) => t.id);
    let found = 0;
    for (let s = 0; s < 40 && found < 3; s++) {
      const g = generateFloor(content, `tr-${s}`, 'main', 3, table);
      for (const sp of g.spawns) if (sp.type === 'item' && content.items[sp.kind].category === 'treasure') { expect(sp.value).toBeGreaterThan(0); found++; }
      expect(JSON.stringify(generateFloor(content, `tr-${s}`, 'main', 3, table))).toBe(JSON.stringify(g));
    }
    expect(found).toBeGreaterThan(0);
  });

  it('a carried treasure counts in the haul, shows its value, and is removed from the inventory and banked on extract', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const run = await manager.createRun({ name: 'T', seed: 'v3-treasure-1', controller: { kind: 'agent', label: 't' }, objective: 'auto' });
    if ('error' in run) throw new Error(run.error.message);
    const world = run.session.world;
    const pid = run.port.playerId;
    const meId = world.players[pid].entityId;
    const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
    // 敵を片付け、宝を 1 つ持たせ、階段の上に立たせる
    inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
    const gem: Entity = { id: 'e_gem1', kind: 'core:gem_necklace', sid: 990101, item: { qty: 1, affixes: [], value: 240 } };
    const me = structuredClone(world.entities[meId]);
    me.inv = { ...me.inv!, items: [...me.inv!.items, 'e_gem1'] };
    const fk = me.pos!.floor;
    const f = world.floors[fk];
    let stairs = -1;
    for (let i = 0; i < f.terrain.length && stairs < 0; i++) if (content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[i]]]].stairs) stairs = i;
    me.pos = { floor: fk, x: stairs % f.width, y: Math.trunc(stairs / f.width) };
    inject({ put: [gem, me] });
    await run.port.act({ type: 'wait' }, { source: 'bot' }); // 視界と記憶を更新
    const o = buildObservation(run.port.view(), catalog, { detail: 'full', map: false });
    expect(o.self.inventory!.find((i) => i.category === 'treasure')!.value).toBe(240);
    expect(o.expedition!.haul!.parts.treasure).toBe(240);
    expect([o.expedition!.can_extract, o.expedition!.extract_blocked_by]).toEqual([true, undefined]);
    const expected = o.expedition!.haul!.if_extract_now;
    // 目的は未達成なので撤退: (戦利品 − 目的) × withdrawPct
    expect(o.expedition!.extract_outcome).toBe('withdraw');
    expect(expected).toBe(Math.trunc(((haulTotal(o.expedition!.haul!.parts) - o.expedition!.haul!.parts.objective) * content.balance.haul.withdrawPct) / 100));
    expect(expected).toBeGreaterThanOrEqual(120);
    const r = await run.port.act({ type: 'extract', confirm: true }, { source: 'bot' });
    expect(r.ok).toBe(true);
    expect(world.players[pid].stats.banked).toBe(expected);
    expect(world.entities.e_gem1).toBeUndefined();
    expect(world.entities[meId].inv!.items).not.toContain('e_gem1');
    const x = world.expeditions![0];
    expect(x.extracted.find((e) => e.player === pid)!.treasure).toBe(240);
    expect(x.result!.payout!.players.find((p) => p.player === pid)!.banked).toBe(expected);
    expect(x.result!.payout!.banked).toBe(expected);
    manager.closeAll();
  });

  it('kills and first discoveries accrue into the shared haul as the expedition goes', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await manager.createRun({ name: 'K', seed: 'v3-haul-1', controller: { kind: 'agent', label: 't' }, objective: 'endless' });
    if ('error' in r) throw new Error(r.error.message);
    const rng = Rng.fromSeed('v3-haul-1');
    const memo = newMemo();
    const pid = r.port.playerId;
    const k0 = r.session.world.players[pid].stats.kills;
    for (let i = 0; i < 300; i++) {
      if (r.port.view().status !== 'your_turn') break;
      await r.port.act(greedyDecide(r.port, rng, memo), { source: 'bot' });
    }
    const w = r.session.world;
    const x = w.expeditions![w.expeditions!.length - 1];
    const kills = w.players[pid].stats.kills - k0;
    expect(x.haul!.kills).toBe(kills * content.balance.haul.perKill);
    // 発見: このランで初めて倒した種族ごとに 1 回、初めて鑑定したアイテム種ごとに 1 回（同じ種族の 2 体目では付かない）
    const species = Object.values(w.players[pid].knowledge.monsterMemory).filter((m) => m.kills > 0).length;
    // 参加時に職業の知識で判明する分（遠征の開始前）は数えない
    const identified = r.session.history.filter((e) => e.type === 'item_identified' && e.player === pid && e.seq >= x.startSeq).length;
    expect(Object.values(w.players[pid].knowledge.monsterMemory).some((m) => m.kills >= 2)).toBe(true);
    expect(x.haul!.discovery).toBe(species * content.balance.haul.discovery.species + identified * content.balance.haul.discovery.identify);
    const obs = r.port.observe({ map: false }).observation;
    if (r.port.view().status === 'your_turn') expect(obs.expedition!.haul!.parts.kills).toBe(x.haul!.kills);
    manager.closeAll();
  });

  it('retiring mid-expedition loses the haul (recorded as lost, nothing banked) and the summary is score version 2', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await manager.createRun({ name: 'L', seed: 'v3-lost-1', controller: { kind: 'agent', label: 't' }, objective: 'endless' });
    if ('error' in r) throw new Error(r.error.message);
    const rng = Rng.fromSeed('v3-lost-1');
    const memo = newMemo();
    for (let i = 0; i < 300 && (r.session.world.expeditions![0].haul?.kills ?? 0) === 0; i++) {
      if (r.port.view().status !== 'your_turn') break;
      await r.port.act(greedyDecide(r.port, rng, memo), { source: 'bot' });
    }
    if (r.port.view().status === 'your_turn') await r.port.act({ type: 'retire' }, { source: 'bot' });
    const pr = r.session.world.players[r.port.playerId];
    const summary = r.session.summary()!;
    expect(summary.scoreVersion).toBe(2);
    expect(summary.players[0].score).toBe(pr.stats.banked ?? 0);
    if ((r.session.world.expeditions![0].haul?.kills ?? 0) > 0) {
      expect(pr.stats.banked ?? 0).toBe(0);
      expect(pr.stats.lost ?? 0).toBeGreaterThan(0);
    }
    manager.closeAll();
  });

  it('picking up the relic wakes the floor (public rule)', () => {
    const { world } = createRun(content, { runId: 'run_relic', seed: 'v3-relic-1', wall: 1 });
    const j = joinPlayer(world, content, { type: 'join', name: 'R', classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, locale: 'ja' }, { cseq: 1, wall: 2 });
    if (!j.ok) throw new Error('join');
    const me = world.entities[world.players[j.playerId].entityId];
    const sleeper = Object.values(world.entities).find((e) => e.actor?.dormant && !e.player && e.pos?.floor === 'main:1');
    expect(sleeper).toBeTruthy();
    const relic: Entity = { id: 'e_relic1', kind: 'core:relic', sid: 990001, role: 'relic', pos: { floor: 'main:1', x: me.pos!.x, y: me.pos!.y }, item: { qty: 1, affixes: [] } };
    applyEvent(world, { type: 'thought', player: j.playerId, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [relic] } as unknown as GameEvent);
    const r = step(world, content, j.playerId, { type: 'pickup', item: 'e_relic1' }, { cseq: 5, wall: 3 });
    expect(r.ok).toBe(true);
    const after = (world as World).entities[sleeper!.id];
    if (after) expect(after.actor!.dormant ?? false).toBe(false);
    const view = projectPlayerView(world, j.playerId);
    expect(view.inventory.some((i) => i.kind === 'core:relic')).toBe(true);
  });
});

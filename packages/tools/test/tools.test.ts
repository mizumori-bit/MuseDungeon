import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { GameEvent } from '@muse/shared';
import {
  buildObservation, canonicalHash, DIRS, DIR_VEC, filterEventsForPlayer, formatObservationText, hpLeftEstimate, narrate, rangesToIndices, Rng,
} from '@muse/shared';
import { createApp, loadConfig, RunSession, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { assetsCheck, assetsChecklist, drive, dummyInvoker, foldAll, greedyDecide, newMemo, playWithPort, runBot } from '../src/index';
import { checkFloorForTest } from './genCheck';

const content = loadContent();
const catalog = buildCatalog(content);
const FULL = process.env.MUSE_FULL === '1' || (import.meta as { env?: { MODE?: string } }).env?.MODE === 'full';

describe('generation invariants', () => {
  it(`${FULL ? 1000 : 60} seeds × depth 1–50 pass validation, stairs reachable, start safe`, () => {
    const table = content.terrain.map((t) => t.id);
    const seeds = FULL ? 1000 : 60;
    const failures: string[] = [];
    let worst = 0;
    for (let s = 0; s < seeds; s++) {
      for (let d = 1; d <= 50; d++) {
        const t0 = performance.now();
        const g = generateFloor(content, `inv-${s}`, 'main', d, table);
        worst = Math.max(worst, performance.now() - t0);
        const errs = checkFloorForTest(content, g, d, table);
        if (errs.length) failures.push(`inv-${s}@${d}: ${errs.join(',')}`);
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(worst).toBeLessThan(500);
  }, FULL ? 900_000 : 120_000);

  it('same seed → identical floor; deep floors are scaled', () => {
    const table = content.terrain.map((t) => t.id);
    const a = generateFloor(content, 'same', 'main', 7, table);
    const b = generateFloor(content, 'same', 'main', 7, table);
    expect(canonicalHash(a)).toBe(canonicalHash(b));
    const deep = generateFloor(content, 'deep', 'main', 40, table);
    const monsters = deep.spawns.filter((s) => s.type === 'monster');
    expect(monsters.length).toBeGreaterThan(0);
    expect(monsters.every((m) => m.type === 'monster' && m.tier > 0)).toBe(true);
  });
});

describe('information hiding (leak property test)', () => {
  it('observations never contain unknown terrain, unseen entities, secrets or unidentified kinds', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    for (let run = 0; run < (FULL ? 20 : 4); run++) {
      const seed = `LEAKSEED-${run}-qx7`;
      const r = await manager.createRun({ name: 'Leak', seed, controller: { kind: 'agent', label: 'leak' }, objective: 'auto' });
      if ('error' in r) throw new Error(r.error.message);
      const world = r.session.world;
      const port: PlayerPort = r.port;
      const rng = Rng.fromSeed(seed);
      const memo = newMemo();
      for (let i = 0; i < 120; i++) {
        const v = port.view();
        if (v.status !== 'your_turn') break;
        const { observation, text: obsText, turn } = port.observeWithTurn('observed', { detail: 'full', map: true });
        const briefing = port.briefing('resume');
        const text = obsText + briefing.join('\n');
        const json = JSON.stringify({ observation, turn, briefing, view: v, pending: port.pending().map((p) => p.event) });
        // 俯瞰専用（守護者・遺物の ID を含む）イベントはプレイヤーに渡らない
        expect(port.pending().some((p) => p.type === 'objective_progress')).toBe(false);
        // (b) 視界外エンティティの ID
        const visibleIds = new Set([v.self.id, ...v.entities.map((e) => e.id), ...v.inventory.map((i) => i.id), ...v.memory.remembered.map((m) => m.id)]);
        for (const e of Object.values(world.entities)) {
          if (visibleIds.has(e.id)) continue;
          expect(json.includes(e.id)).toBe(false);
        }
        // (c) secret
        expect(json.includes(seed)).toBe(false);
        for (const st of Object.values(world.secret.rng)) for (const n of st) expect(json.includes(String(n))).toBe(false);
        // (d) 未鑑定 kind
        const idf = new Set(world.players[port.playerId].knowledge.identified);
        for (const kind of Object.keys(world.secret.appearances)) {
          if (idf.has(kind)) continue;
          expect(json.includes(`"${kind}"`)).toBe(false);
          const n = content.items[kind].name;
          expect(text.includes(n.ja)).toBe(false);
        }
        // (e) 見えていない呪い（V3-4）: 装備・鑑定する前の呪いの接辞は、ID も名前も出ない（同じ呪いが見えている品が無い限り）
        const shownAffixes = new Set(Object.values(world.entities).flatMap((e) => e.item?.affixes ?? []));
        for (const e of Object.values(world.entities)) {
          for (const a of e.item?.hidden ?? []) {
            if (shownAffixes.has(a)) continue;
            expect(json.includes(a)).toBe(false);
            expect(text.includes(content.affixes[a].name.ja)).toBe(false);
          }
        }
        const cmd = greedyDecide(port, rng, memo);
        const out = await port.act(cmd, { source: 'bot' });
        if (out.ok) expect(JSON.stringify(out).includes(seed)).toBe(false);
      }
      // (a) 未知セルの地形: 記憶に書かれる地形は、その時点の視界内（または地図の巻物）に限られる
      const visibleNow = new Map<string, Set<number>>();
      let mappingCause: number | null = null;
      for (const ev of r.session.history) {
        if (ev.type === 'item_used' && ev.kind === 'core:scroll_mapping') mappingCause = ev.cause;
        if (ev.type !== 'knowledge_updated' || ev.player !== port.playerId) continue;
        if (ev.visible) visibleNow.set(ev.player, new Set(rangesToIndices(ev.visible)));
        const vis = visibleNow.get(ev.player) ?? new Set<number>();
        const isMapping = ev.visible === null && mappingCause !== null && ev.cause === mappingCause;
        for (let k = 0; k + 1 < ev.newlySeen.length; k += 2) {
          if (!isMapping) expect(vis.has(ev.newlySeen[k])).toBe(true);
        }
      }
      // PlayerView の記憶は knowledge の seen そのもの（未知は 0）
      const v = port.view();
      const fk = v.floor?.key;
      if (fk) expect(v.memory.terrain).toEqual(world.players[port.playerId].knowledge.floors[fk].seen);
      r.session.close();
    }
    manager.closeAll();
  });

  it('player-filtered events hide unseen actors and monster HP', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null }));
    const r = await manager.createRun({ name: 'F', seed: 'filter-1', controller: { kind: 'agent', label: 'f' }, objective: 'auto' });
    if ('error' in r) throw new Error(r.error.message);
    for (let i = 0; i < 60; i++) {
      const out = await r.port.act({ type: 'explore' }, { source: 'bot' });
      if (!out.ok || r.port.view().status !== 'your_turn') break;
      if (out.observation.visible.monsters.length) await r.port.act({ type: 'wait' }, { source: 'bot' });
    }
    const v = r.port.view();
    const evs = filterEventsForPlayer(r.session.history, r.port.playerId, v);
    for (const e of evs as Record<string, unknown>[]) {
      expect(e.seenBy).toBeUndefined();
      expect(e.put).toBeUndefined();
      expect(['floor_generated', 'rng_advanced', 'knowledge_updated', 'run_started', 'ai_state_changed', 'actor_scheduled']).not.toContain(e.type);
      if (e.type === 'damaged' && e.target !== v.self.id) expect(e.hpAfter).toBeUndefined();
    }
    const texts = evs.map((e) => narrate(e, { locale: 'ja', catalog, selfId: v.self.id, playerNames: {} })).filter(Boolean);
    expect(texts.length).toBeGreaterThan(0);
    manager.closeAll();
  });
});

describe('baseline bots', () => {
  it(`greedy bot completes ${FULL ? 100 : 12} runs without crashing`, async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null }));
    const n = FULL ? 100 : 12;
    const depths: number[] = [];
    const briefChars: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await runBot(manager, { kind: 'greedy', seed: `ci-${i}`, maxActs: FULL ? 2500 : 600, measureObs: i < 3 });
      depths.push(res.depth);
      briefChars.push(...res.obsBriefChars);
      for (const [id, s] of manager.sessions) if (s.world.status === 'ended') { s.close(); manager.sessions.delete(id); }
    }
    const avg = depths.reduce((a, b) => a + b, 0) / depths.length;
    console.log(`greedy bot: runs=${n} avgDepth=${avg.toFixed(2)} max=${Math.max(...depths)} briefObsChars(avg)=${Math.round(briefChars.reduce((a, b) => a + b, 0) / Math.max(1, briefChars.length))}`);
    expect(avg).toBeGreaterThanOrEqual(1);
  });

  it('random bot does not crash the engine', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null }));
    for (let i = 0; i < 4; i++) await runBot(manager, { kind: 'random', seed: `rnd-${i}`, maxActs: 300 });
  });
});

describe('golden replay', () => {
  it('saved events.jsonl replays with the current reducer to the recorded hash', () => {
    const dir = resolve(__dirname, 'fixtures', 'golden');
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as GameEvent);
    const expected = JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { finalHash: string; lastSeq: number };
    const w = foldAll(events);
    expect(w.seq).toBe(expected.lastSeq);
    expect(canonicalHash(w)).toBe(expected.finalHash);
  });
});

describe('assets', () => {
  it('checklist covers all content and the sample theme validates', () => {
    const list = assetsChecklist(content, catalog);
    expect(list.filter((a) => a.required).length).toBeGreaterThanOrEqual(35);
    expect(list.some((a) => a.class === 'appearance' && a.key === 'core:potion_look_01')).toBe(true);
    const r = assetsCheck(content, resolve(__dirname, '..', '..', 'client', 'public', 'themes', 'sample'));
    expect(r.lines.filter((l) => l.startsWith('ERROR'))).toEqual([]);
  });
});

describe('expeditions (V2-2)', () => {
  it('greedy bot goes expedition → objective → extract → camp → next expedition; folds and recovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-exp-'));
    const config = loadConfig({ runsDir: dir, keyframeEvery: 200 });
    const manager = new SessionManager(content, config);
    let looped = 0;
    const reasons = new Set<string>();
    for (let i = 0; i < 6 && looped < 2; i++) {
      const r = await manager.createRun({ name: 'Exp', seed: `exp-loop-${i}`, controller: { kind: 'agent', label: 'bot' } });
      if ('error' in r) throw new Error(r.error.message);
      await playWithPort(r.port, { kind: 'greedy', seed: `exp-loop-${i}`, maxActs: 1500, maxExpeditions: 2 });
      const w = r.session.world;
      for (const x of w.expeditions ?? []) if (x.endReason) reasons.add(x.endReason);
      const first = w.expeditions?.[0];
      if (first?.endReason === 'completed' && (w.expeditions?.length ?? 0) >= 2) looped++;
      // 畳み込み等価とクラッシュ復旧（キャンプ・再開を含む）
      expect(canonicalHash(r.session.foldHistory())).toBe(canonicalHash(w));
      if (w.status === 'active') {
        const rec = RunSession.recover({ content, catalog: manager.catalog, config }, r.session.runId);
        expect(rec.verified).toBe(true);
        expect(canonicalHash(rec.session.world)).toBe(canonicalHash(w));
        rec.session.close();
      }
      r.session.close();
    }
    expect(looped).toBeGreaterThanOrEqual(2);
    expect(reasons.has('completed')).toBe(true);
    manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });

  it(`target floors always contain a reachable guardian / relic (${FULL ? 300 : 40} seeds × depth 3–12)`, () => {
    const table = content.terrain.map((t) => t.id);
    const bad: string[] = [];
    for (let s = 0; s < (FULL ? 300 : 40); s++) {
      for (let d = 3; d <= 12; d++) {
        for (const obj of [{ guardian: true, relic: false }, { guardian: false, relic: true }, { guardian: true, relic: true }]) {
          const g = generateFloor(content, `obj-${s}`, 'main', d, table, obj);
          const f = g.floor;
          const pass = (i: number) => { const t = content.terrain[content.terrainIndex[table[f.terrain[i]]]]; return t.passable || t.door === 'closed'; };
          const dist = new Int32Array(f.width * f.height).fill(-1);
          const start = f.entry.y * f.width + f.entry.x;
          dist[start] = 0;
          const q = [start];
          for (let h = 0; h < q.length; h++) {
            const c = q[h];
            const cx = c % f.width, cy = (c - cx) / f.width;
            for (const dd of DIRS) {
              const nx = cx + DIR_VEC[dd][0], ny = cy + DIR_VEC[dd][1];
              if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
              const ni = ny * f.width + nx;
              if (dist[ni] < 0 && pass(ni)) { dist[ni] = dist[c] + 1; q.push(ni); }
            }
          }
          const guardians = g.spawns.filter((x) => x.type === 'monster' && x.role === 'guardian');
          const relics = g.spawns.filter((x) => x.type === 'item' && x.role === 'relic');
          if (guardians.length !== (obj.guardian ? 1 : 0) || relics.length !== (obj.relic ? 1 : 0)) bad.push(`obj-${s}@${d} ${JSON.stringify(obj)}: count`);
          for (const x of [...guardians, ...relics]) {
            if (dist[x.y * f.width + x.x] < 0) bad.push(`obj-${s}@${d}: unreachable ${x.kind}`);
            if (Math.max(Math.abs(x.x - f.entry.x), Math.abs(x.y - f.entry.y)) <= 6) bad.push(`obj-${s}@${d}: too close`);
          }
          for (const gd of guardians) {
            if (gd.type === 'monster' && !gd.affixes.includes('core:guardian')) bad.push(`obj-${s}@${d}: no guardian affix`);
            const arch = content.monsters[gd.kind]?.ai.archetype;
            if (arch === 'stationary' || arch === 'skittish') bad.push(`obj-${s}@${d}: bad archetype ${arch}`);
          }
          // 目的の段は他のストリームをずらさない（地形と通常のスポーンは同じ）
          const plain = generateFloor(content, `obj-${s}`, 'main', d, table);
          if (plain.attempts === g.attempts && canonicalHash(plain.floor) !== canonicalHash(g.floor)) bad.push(`obj-${s}@${d}: terrain changed`);
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('rest and enemy durability (V2-4)', () => {
  it('rest_estimate turns match the actual rest when not interrupted', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null }));
    let checked = 0;
    for (let s = 0; s < 12 && checked < 3; s++) {
      const r = await manager.createRun({ name: 'Rest', seed: `rest-${s}`, controller: { kind: 'agent', label: 'r' }, objective: 'auto' });
      if ('error' in r) throw new Error(r.error.message);
      const rng = Rng.fromSeed(`rest-${s}`);
      const memo = newMemo();
      memo.restFails = 99; // bot 自身には休ませない
      for (let i = 0; i < 400 && checked < 3; i++) {
        const v = r.port.view();
        if (v.status !== 'your_turn') break;
        const o = r.port.observe({ map: false }).observation;
        const est = o.self.rest_estimate;
        if (est && !est.blocked_by && !o.visible.monsters.length && est.turns <= content.balance.rest.maxTurns) {
          const out = await r.port.act({ type: 'rest' }, { source: 'bot' });
          if (out.ok && out.interrupted_by === 'full_hp') {
            expect(out.rest?.turns).toBe(est.turns);
            expect(out.rest?.hp_gained).toBe(est.hp_to_full);
            expect(out.rest?.time_elapsed).toBe(est.time);
            checked++;
          }
          continue;
        }
        await r.port.act(greedyDecide(r.port, rng, memo), { source: 'bot' });
      }
      r.session.close();
    }
    expect(checked).toBeGreaterThanOrEqual(1);
    manager.closeAll();
  });

  it('kills show actual damage, record hp_seen, and estimates use it', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null }));
    let overkillChecked = false;
    let hpSeen = false;
    for (let s = 0; s < 6 && !(overkillChecked && hpSeen); s++) {
      const r = await runBot(manager, { kind: 'greedy', seed: `dur-${s}`, maxActs: 300, objective: 'endless' });
      const sess = manager.get(r.runId)!;
      const pid = sess.world.playerOrder[0];
      const view = sess.view(pid);
      for (const ev of sess.history) {
        if (ev.type !== 'damaged' || ev.hpAfter !== 0 || ev.dealt === undefined || ev.dealt >= ev.amount || ev.source !== view.self.id) continue;
        const pe = filterEventsForPlayer([ev], pid, view)[0];
        const text = narrate(pe, { locale: 'ja', catalog, selfId: view.self.id, playerNames: {} })!;
        expect(text).toContain(`${ev.dealt} ダメージ`);
        expect(text).not.toContain(`${ev.amount} ダメージ`);
        overkillChecked = true;
      }
      if (Object.values(view.monsterMemory).some((m) => m.hpSeen && m.hpSeen.samples > 0)) hpSeen = true;
      sess.close();
    }
    expect(overkillChecked).toBe(true);
    expect(hpSeen).toBe(true);
    // 推定残り HP: 記録 4〜10、damage_seen 3、wounded（50〜74%）
    const est = hpLeftEstimate({ kind: 'k', encounters: 1, kills: 1, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], hpSeen: { min: 4, max: 10, samples: 5 } }, 'wounded', 3)!;
    expect(est.min).toBeGreaterThanOrEqual(2);
    expect(est.max).toBeLessThanOrEqual(7);
    expect(hpLeftEstimate({ kind: 'k', encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [] }, 'healthy', 0)).toBeUndefined();
    manager.closeAll();
  });
});

describe('host drive (V2-3)', () => {
  it('drive + dummy agent runs an expedition unattended; stopping and re-running continues it', async () => {
    const config = loadConfig({ runsDir: null, idleNoticeMs: 1500 });
    const app = createApp(new SessionManager(content, config), config);
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Drive', seed: 'drive-1', controller: { kind: 'agent', label: 'dummy' } }) });
    const j = await res.json() as { token: string; runId: string };
    const first = await drive({ baseUrl: base, token: j.token, invoker: dummyInvoker(), maxTurns: 10 });
    expect(first.outcome).toBe('interrupted');
    expect(first.reason).toBe('max_turns');
    expect(app.manager.get(j.runId)!.world.expeditions?.[0].status).not.toBe('ended');
    const second = await drive({ baseUrl: base, token: j.token, invoker: dummyInvoker(), maxTurns: 3000 });
    expect(second.outcome).toBe('ended');
    const x = app.manager.get(j.runId)!.world.expeditions![0];
    expect(x.status).toBe('ended');
    expect(['completed', 'withdrawn', 'died']).toContain(x.endReason);
    await app.close();
  });
});

describe('observation size', () => {
  it('brief observation text stays compact', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null }));
    const r = await manager.createRun({ name: 'S', seed: 'size-1', controller: { kind: 'agent', label: 's' }, objective: 'auto' });
    if ('error' in r) throw new Error(r.error.message);
    const sizes: number[] = [];
    for (let i = 0; i < 30; i++) {
      const out = await r.port.act({ type: 'explore' }, { source: 'bot' });
      if (!out.ok) break;
      sizes.push(formatObservationText(buildObservation(r.port.view(), catalog, { detail: 'brief', map: true }), 'ja').length);
      if (r.port.view().status !== 'your_turn') break;
    }
    const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    console.log(`brief observation text chars avg=${Math.round(avg)} max=${Math.max(...sizes)}`);
    expect(avg).toBeLessThan(2500);
    manager.closeAll();
  });
});

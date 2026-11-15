import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { GameEvent } from '@muse/shared';
import { buildObservation, canonicalHash, filterEventsForPlayer, formatObservationText, narrate, rangesToIndices, Rng } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { assetsCheck, assetsChecklist, foldAll, greedyDecide, runBot } from '../src/index';
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
  });

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
      const r = await manager.createRun({ name: 'Leak', seed, controller: { kind: 'agent', label: 'leak' } });
      if ('error' in r) throw new Error(r.error.message);
      const world = r.session.world;
      const port: PlayerPort = r.port;
      const rng = Rng.fromSeed(seed);
      const memo = { restFails: 0, avoid: new Set<string>(), blocked: 0 };
      for (let i = 0; i < 120; i++) {
        const v = port.view();
        if (v.status !== 'your_turn') break;
        const { observation, text } = port.observe({ detail: 'full', map: true });
        const json = JSON.stringify({ observation, view: v, pending: port.pending().map((p) => p.event) });
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
    const r = await manager.createRun({ name: 'F', seed: 'filter-1', controller: { kind: 'agent', label: 'f' } });
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

describe('observation size', () => {
  it('brief observation text stays compact', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null }));
    const r = await manager.createRun({ name: 'S', seed: 'size-1', controller: { kind: 'agent', label: 's' } });
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

import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, GameEvent, World } from '@muse/shared';
import { applyEvent, canonicalHash, emptyWorld, macroNext, macroStart, projectPlayerView, Rng, DIRS } from '@muse/shared';
import { computeFov, createRun, joinPlayer, step, validateContentHandlers } from '../src/index';

const content = loadContent();
const catalog = buildCatalog(content);

function fold(events: GameEvent[]): World {
  const w = emptyWorld();
  for (const e of events) applyEvent(w, e);
  return w;
}

/** View だけを見て決める決定的なプレイ。コマンド列を返す */
function play(seed: string, n: number, commands?: { player: string; cmd: Command }[]) {
  const { world, events } = createRun(content, { runId: 'run_test', seed, wall: 1 });
  const all = [...events];
  const j = joinPlayer(world, content, { type: 'join', name: 'T', classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, locale: 'ja' }, { cseq: 1, wall: 2 });
  if (!j.ok) throw new Error('join failed');
  all.push(...j.events);
  const rng = Rng.fromSeed(`play|${seed}`);
  const issued: { player: string; cmd: Command }[] = [];
  for (let i = 0; i < n && world.status === 'active'; i++) {
    let cmd: Command;
    if (commands) {
      if (i >= commands.length) break;
      cmd = commands[i].cmd;
    } else {
      const v = projectPlayerView(world, j.playerId);
      if (v.status !== 'your_turn') break;
      const st = macroStart(v, { type: 'explore' }, catalog);
      const d = macroNext(st, v, catalog, []);
      cmd = 'command' in d && rng.chance(80) ? d.command : { type: 'move', dir: rng.pick(DIRS) };
    }
    issued.push({ player: j.playerId, cmd });
    const r = step(world, content, j.playerId, cmd, { cseq: i + 2, wall: 100 + i });
    all.push(...r.events);
  }
  return { world, events: all, issued, playerId: j.playerId };
}

describe('engine', () => {
  it('all content handler references resolve', () => {
    expect(validateContentHandlers(content)).toEqual([]);
  });

  it('is deterministic: same seed + same commands → same events', () => {
    const a = play('det-1', 400);
    const b = play('det-1', 400, a.issued);
    expect(canonicalHash(b.events)).toBe(canonicalHash(a.events));
    expect(canonicalHash(b.world)).toBe(canonicalHash(a.world));
  });

  it('fold(events) equals the live world (fold equivalence)', () => {
    for (const seed of ['fold-1', 'fold-2', 'fold-3']) {
      const r = play(seed, 300);
      expect(canonicalHash(fold(r.events))).toBe(canonicalHash(r.world));
      // 途中の時点でも一致（イベント列の接頭辞の畳み込み）
      const half = r.events.slice(0, Math.floor(r.events.length / 2));
      const w = fold(half);
      expect(w.seq).toBe(half[half.length - 1].seq);
    }
  });

  it('invalid commands emit nothing and do not consume time', () => {
    const r = play('invalid-1', 5);
    const before = canonicalHash(r.world);
    const res = step(r.world, content, r.playerId, { type: 'use', slot: 'z' }, { cseq: 99, wall: 0 });
    expect(res.ok).toBe(false);
    expect(res.events).toHaveLength(0);
    expect(canonicalHash(r.world)).toBe(before);
    if (!res.ok) expect(res.error.code).toBe('no_such_item');
  });

  it('floor terrain does not depend on actions taken (named sub-streams)', () => {
    const a = play('streams-1', 50);
    const b = play('streams-1', 10);
    expect(a.world.floors['main:1'].terrain).toEqual(b.world.floors['main:1'].terrain);
  });

  it('entity ids are opaque, not sequential', () => {
    const r = play('ids-1', 1);
    const ids = Object.keys(r.world.entities);
    expect(ids.every((id) => /^e_[0-9a-z]{6}$/.test(id))).toBe(true);
  });

  it('symmetric shadowcasting FOV is symmetric', () => {
    const w = 30, h = 20;
    const rng = Rng.fromSeed('fov');
    const walls = new Set<number>();
    for (let i = 0; i < 120; i++) walls.add(rng.int(w * h));
    const opaque = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || walls.has(y * w + x);
    for (let k = 0; k < 40; k++) {
      const a = { x: rng.range(1, w - 2), y: rng.range(1, h - 2) };
      const b = { x: rng.range(1, w - 2), y: rng.range(1, h - 2) };
      if (opaque(a.x, a.y) || opaque(b.x, b.y)) continue;
      const fa = new Set(computeFov(w, h, opaque, a.x, a.y, 8));
      const fb = new Set(computeFov(w, h, opaque, b.x, b.y, 8));
      expect(fa.has(b.y * w + b.x)).toBe(fb.has(a.y * w + a.x));
    }
  });
});

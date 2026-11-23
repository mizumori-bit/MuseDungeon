// S7b（SEASON.md §53.10）のテスト: 検査の指摘の直し。explore toward の行き来・起動し直した直後の区切り・先読みの応答・
// 「ふつう」は見込みを超えない・自分の置いた品の印・呼び出しの控えのツール名
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { step } from '@muse/engine';
import { loadConfig, RunSession, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { CallLog } from '../../server/src/mcp/calls';
import { buildObservation, filterEventsForPlayer, formatObservationText, macroNext, macroStart, projectPlayerView, threatEstimate, usualEstimate, fightThreats } from '@muse/shared';
import type { Command, Dir, GameEvent, MonsterMemory, PlayerView } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });

/**
 * 1 本の通路で、下への風が立つ位置で変わる（検査担当の形: 南北の通路と東の風。東西の通路では、北東 ↔ 北西に変わる風）。
 * 知っている地図は自分から 3 マスまで（歩いて見る）。マクロを 1 手ずつ進め、入ったマスの回数を数える
 */
async function windCorridor(seed: string, o: { vertical: boolean; len: number; at: number; split: number }) {
  const map = o.vertical ? Array.from({ length: o.len }, (_, y) => (y === o.at ? 'P' : '.')) : ['.'.repeat(o.at) + 'P' + '.'.repeat(o.len - o.at - 1)];
  const a = await arena(seed, { map, guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' } });
  a.inject({ del: [a.gId] });
  const f = a.world.floors[a.key];
  const fk = a.world.players[a.pid].knowledge.floors[a.key];
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const d = o.vertical ? Math.abs(y - (a.oy + o.at)) : Math.abs(x - (a.ox + o.at));
    if (d > 3) fk.seen[y * f.width + x] = 0;
  }
  const s = (o.vertical ? a.oy : a.ox) + o.at + o.split;
  const wind = (v: PlayerView): Dir => {
    const c = o.vertical ? v.self.pos!.y : v.self.pos!.x;
    return o.vertical ? (c < s ? 'se' : c > s ? 'ne' : 'e') : (c < s ? 'ne' : c > s ? 'nw' : 'n');
  };
  const drive = (cmd: Command) => {
    const world = structuredClone(a.world);
    const hinted = () => { const v = projectPlayerView(world, a.pid); v.floorHint = { floor: v.floor!.key, draft: wind(v), explored: 1 }; return v; };
    const st = macroStart(hinted(), cmd, catalog);
    let last: GameEvent[] = [];
    const visits = new Map<string, number>();
    let stop = 'limit';
    for (let k = 0; k < 80; k++) {
      const v = hinted();
      const d = macroNext(st, v, catalog, filterEventsForPlayer(last, a.pid, v));
      if ('stop' in d) { stop = d.stop; break; }
      const r = step(world, content, a.pid, d.command, { cseq: 900000 + k, wall: 0 });
      if (!r.ok) { stop = 'error'; break; }
      last = r.events;
      const p = world.entities[a.meId].pos!;
      visits.set(`${p.x},${p.y}`, (visits.get(`${p.x},${p.y}`) ?? 0) + 1);
    }
    return { steps: st.steps, max: Math.max(0, ...visits.values()), stop, st };
  };
  return { a, drive };
}

describe('S7b §53.10 の 1: a widened explore toward does not sweep the same corridor back and forth', () => {
  it('east-west corridor, the draft flipping ne / nw: no cell entered 3 times, no more turns than plain explore (S7a: 80 turns, one cell 11 times)', async () => {
    const { a, drive } = await windCorridor('s7b-sweep-h', { vertical: false, len: 50, at: 20, split: 0 });
    const tw = drive({ type: 'explore', toward: 'draft' });
    const plain = drive({ type: 'explore' });
    expect(tw.max).toBeLessThan(3);
    expect(tw.steps).toBeLessThanOrEqual(plain.steps + 5);
    // 方角は呼び出しの初めのもの（n）に固定、幅は横まで広げたまま
    expect(tw.st.towardDir).toBe('n');
    expect(tw.st.towardWidth).toBe(1);
    a.manager.closeAll();
  });

  it('north-south corridor and an east draft (e / se / ne by position): no cell entered 3 times', async () => {
    const { a, drive } = await windCorridor('s7b-sweep-v', { vertical: true, len: 18, at: 8, split: 1 });
    const tw = drive({ type: 'explore', toward: 'draft' });
    const plain = drive({ type: 'explore' });
    expect(tw.max).toBeLessThan(3);
    expect(tw.steps).toBeLessThanOrEqual(plain.steps + 5);
    a.manager.closeAll();
  });

  it('when it would enter the same cell a third time, it stops as no_progress and says so (the A-B-A-B watch did not catch end-to-end sweeps)', async () => {
    const { a } = await windCorridor('s7b-revisit', { vertical: false, len: 30, at: 15, split: 0 });
    const v = projectPlayerView(a.world, a.pid);
    v.floorHint = { floor: v.floor!.key, draft: 'n', explored: 1 };
    const st = macroStart(v, { type: 'explore', toward: 'draft' }, catalog);
    const first = macroNext(st, v, catalog, []);
    expect('command' in first).toBe(true);
    // 次に入るマスに、もう 2 回入った（テストの書き換え）
    const d = 'command' in first && first.command.type === 'move' ? first.command.dir : 'e';
    const nx = v.self.pos!.x + (d.includes('e') ? 1 : d.includes('w') ? -1 : 0);
    st.visits = { ...(st.visits ?? {}), [v.self.pos!.y * v.floor!.width + nx]: 2 };
    st.visitLast = v.self.pos!.y * v.floor!.width + v.self.pos!.x;
    expect(macroNext(st, v, catalog, [])).toEqual({ stop: 'no_progress' });
    expect(st.revisit).toEqual({ x: nx, y: v.self.pos!.y });
    a.manager.closeAll();
  });
});

describe('S7b §53.10 の 2・3: the checkpoint is not shown again after a restart, nor on a peek', () => {
  it('shown once on turn 100+; after recovering from the record, resume_run (no turn snapshot) does not show it again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s7b-cp-'));
    try {
      const m = new SessionManager(content, loadConfig({ runsDir: dir }));
      const r = await m.createRun({ name: 'R', seed: 's7b-restart', controller: agent, objective: 'reach_depth' });
      if ('error' in r) throw new Error(r.error.message);
      const pid = r.port.playerId;
      expect(r.session.checkpointTurns(pid)).toEqual([]);
      // 区切りが出るまで、1 手ずつ待つ（敵が見えれば、近くの敵を殴る）
      let shownAt = -1;
      for (let i = 0; i < 400 && shownAt < 0 && r.port.view().status === 'your_turn'; i++) {
        const near = r.port.view().entities.find((e) => e.cat === 'monster' && Math.max(Math.abs(e.pos.x - r.port.view().self.pos!.x), Math.abs(e.pos.y - r.port.view().self.pos!.y)) <= 1);
        const res = await act(r.port, near ? { type: 'attack', target: near.id } : { type: 'wait' });
        if (res.turn.changes.some((c) => c.code === 'checkpoint')) shownAt = res.turn.turn_no;
      }
      expect(shownAt).toBeGreaterThanOrEqual(100);
      // 先読み（ターンフィードの peek）にも、同じ手番の observe にも出ない
      expect(r.port.observeWithTurn('turn_arrived', { changes: 'peek' }).turn.changes.some((c) => c.code === 'checkpoint')).toBe(false);
      expect(r.port.observeWithTurn('observed').turn.changes.some((c) => c.code === 'checkpoint')).toBe(false);
      const runId = r.session.runId;
      m.closeAll();
      const m2 = new SessionManager(content, loadConfig({ runsDir: dir }));
      const rec = RunSession.recover(m2.deps, runId);
      expect(rec.verified).toBe(true);
      // 前の応答の控えが無い（since が null）: いまの手番を作った呼び出しが記録にあるので、出したことにする
      expect(rec.session.checkpointDue(pid, null)).toBe(false);
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S7b §53.10 の 6: "usually" never exceeds the expected number', () => {
  it('a recorded species at its average plus an unrecorded heavier one: usually is cut at expected', async () => {
    const a = await arena('s7b-usual', { map: ['.....', '..P..', '.....'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'hunting' } });
    const g2 = structuredClone(a.world.entities[a.gId]);
    g2.id = 'e_s7b002'; g2.sid += 100000; g2.kind = 'core:cave_wolf'; g2.pos = { ...g2.pos!, x: a.ox + 3, y: a.oy + 1 };
    a.inject({ put: [g2] });
    const g1 = structuredClone(a.world.entities[a.gId]); g1.pos = { ...g1.pos!, x: a.ox + 1, y: a.oy + 1 }; a.inject({ put: [g1] });
    await act(a.r.port, { type: 'wait' });
    const v = structuredClone(projectPlayerView(a.world, a.pid));
    const mem = (kind: string, m: Partial<MonsterMemory>): MonsterMemory => ({ kind, encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [], ...m });
    // 記録の足りるゴブリン（平均 6: 会心の分で、会心でない最大 5 より大きい）と、記録の足りない狼（会心でない最大 4・平均 1）
    v.monsterMemory = { ...v.monsterMemory, 'core:goblin': mem('core:goblin', { maxDamageToYou: 12, maxPlainToYou: 5, hitsOnYou: [5, 5], dmgOnYou: [30, 5, 5] }), 'core:cave_wolf': mem('core:cave_wolf', { maxDamageToYou: 4, maxPlainToYou: 4, hitsOnYou: [1, 4], dmgOnYou: [4, 1, 4] }) };
    const th = fightThreats(catalog, v.entities.filter((e) => e.cat === 'monster'), v.self.pos!);
    expect(th.length).toBe(2);
    const est = threatEstimate(v, catalog, th);
    expect(usualEstimate(v, catalog, th)).toBeLessThanOrEqual(est.expected);
    a.manager.closeAll();
  });
});

describe('S7b §53.10 の 7: items you dropped are marked "(you dropped it)", only yours', () => {
  it('the item line says so; an item dropped by someone else is not marked', async () => {
    const a = await arena('s7b-drop', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { items: [{ kind: 'core:scroll_identify' }] } });
    a.inject({ del: [a.gId] });
    const slot = projectPlayerView(a.world, a.pid).inventory.find((x) => x.kind === 'core:scroll_identify')!.slot;
    expect((await act(a.r.port, { type: 'drop', slot })).ok).toBe(true);
    expect((await act(a.r.port, { type: 'move', dir: 'e' })).ok).toBe(true);
    const o = buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
    const it = o.visible.items.find((x) => x.name.includes('鑑定の巻物'))!;
    expect(it.dropped).toBe(true);
    expect(formatObservationText(o, 'ja')).toMatch(/鑑定の巻物（あなたが置いた）/);
    // 仲間が置いた品（droppedBy がほかの者）には付かない
    const e = structuredClone(a.world.entities[it.id]); e.item!.droppedBy = 'p_other'; a.inject({ put: [e] });
    const o2 = buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
    expect(o2.visible.items.find((x) => x.id === it.id)?.dropped).toBeUndefined();
    expect(formatObservationText(o2, 'ja')).not.toContain('（あなたが置いた）');
    a.manager.closeAll();
  });
});

describe('S7b §53.10 の 8: the call log keeps only well-formed tool names', () => {
  it('a tool name the client sent with odd characters is kept as ?', () => {
    const out: string[] = [];
    const log = new CallLog(-1, 10, (l) => out.push(l));
    log.record({ at: 'x', tool: 'wait', run: null, ms: 1 });
    log.record({ at: 'x', tool: 'wait\n[mcp] 偽の行', run: null, ms: 1 });
    log.record({ at: 'x', tool: 'a'.repeat(41), run: null, ms: 1 });
    expect(log.list().map((c) => c.tool)).toEqual(['?', '?', 'wait']);
    expect(out.every((l) => !l.includes('偽の行'))).toBe(true);
  });
});

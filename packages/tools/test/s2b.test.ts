// S2b（SEASON.md §22・§23）のテスト: 道具の close の後のサーバーの断面と書き戻し・確定後の registerRun・道しるべの知らせ・
// HP がもう hp_floor 以下で死にうるときの fight の断り
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SeasonService, SeasonStore, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import type { Command, Entity, GameEvent, Pos, World } from '@muse/shared';
import { applyEvent } from '@muse/shared';
import { arena, content } from './v33duel';

const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's2bt';
function manager(seasonsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir, waitOthersMs: 100 }));
}
function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S2b試し', seed: 's2b-season', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
async function seasonRun(m: SessionManager, name: string) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: SID, profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof seasonRun>>;
const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });
function inject(w: World, p: { put?: Entity[]; del?: string[] }): void {
  applyEvent(w, { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
}
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
const place = (r: Run, p: Pos) => { const w = r.session.world; const e = structuredClone(meOf(w, r.playerId)); e.pos = { floor: e.pos!.floor, x: p.x, y: p.y }; inject(w, { put: [e] }); };
const clear = (w: World) => inject(w, { del: Object.values(w.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
async function start(r: Run) { const s = await act(r.port, { type: 'start_expedition', offer: 1 }); expect(s.ok).toBe(true); clear(r.session.world); return s; }
async function descend(r: Run) {
  const w = r.session.world;
  place(r, w.floors[meOf(w, r.playerId).pos!.floor].stairs.down[0]);
  clear(w);
  await act(r.port, { type: 'wait' });
  clear(w);
  expect((await act(r.port, { type: 'stairs' })).ok).toBe(true);
  clear(w);
}
async function lifelineHome(r: Run) {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r.port, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
}

describe('S2b §22 の 1: after the operator tool closes, the running server uses the closed result and does not write back', () => {
  it('the cross-section comes from the result, participants.json keeps the closed values, and no run is added afterwards', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2b-close-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      await seasonRun(m, 'Bo');
      // Aya は地下 2 階にいる（帰っていない）: サーバーの公開の値は地下 1 階のまま
      await start(a);
      await descend(a);
      await act(a.port, { type: 'wait' });
      expect(m.seasons.standings(SID)!.section.find((x) => x.deepest.includes('Aya'))?.depth).toBe(1);
      // 別のプロセスで確定する（確定は全員の今の値: Aya は地下 2 階）
      const cli = new SeasonService(new SeasonStore(dir), { engineVersion: ENGINE_VERSION, contentVersion: content.version }, () => null, Date.now, 10, content.lists.seasonTitles);
      cli.finalize(cli.get(SID)!, 'operator');
      const st = m.seasons.standings(SID)!;
      expect(st.result!.standings.find((x) => x.name === 'Aya')!.adventure.value).toBe(2);
      expect(st.section.find((x) => x.deepest.includes('Aya'))?.depth).toBe(2);
      expect(JSON.stringify(st.section)).toBe(JSON.stringify(cli.standings(SID)!.section));
      // 確定の後のランの登録は足さない（canStart の後に確定された場合）
      m.seasons.registerRun(SID, a.session.profileOf(a.playerId)!, 'Aya', 'run_late00000');
      expect(m.seasons.get(SID)!.participants.find((p) => p.name === 'Aya')!.runs.some((r) => r.runId === 'run_late00000')).toBe(false);
      // 迷宮で動いても、保存待ちで書き戻さない
      await act(a.port, { type: 'wait' });
      m.closeAll();
      const onDisk = JSON.parse(readFileSync(join(dir, SID, 'participants.json'), 'utf8')) as { name: string; shown?: { best: { depth: number } }; runs: { runId: string }[] }[];
      const aya = onDisk.find((p) => p.name === 'Aya')!;
      expect(aya.shown!.best.depth).toBe(2);
      expect(aya.runs.some((r) => r.runId === 'run_late00000')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S2b: the trail notice on arrival (S2a §20.6 の 1)', () => {
  it('the floor change says the down stairs are published and the trail is on the map', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Bo');
    await start(a);
    await descend(a);
    await lifelineHome(a);
    expect((await act(a.port, { type: 'report_stairs' })).ok).toBe(true);
    // Bo は遠征を始めるときの取り込みで公開を知り、地下 1 階に着いた変化の文で知らされる（キャンプの観測を 1 回見た後。new_run の応答と同じ）
    b.port.observe();
    const s = await start(b);
    const fc = s.ok ? s.turn.changes.find((c) => c.code === 'floor_changed') : undefined;
    expect(fc?.text).toContain('この階の下り階段は公開されている（Aya が報告）');
    expect(fc?.text).toMatch(/入口からの道しるべが地図にある|途中の道はまだ分からない/);
    m.closeAll();
  });
});

describe('S2b: fight refused because HP is already at hp_floor, while one worst turn could kill you', () => {
  it('says lowering hp_floor does not help', async () => {
    const a = await arena('s2b-floor-lethal', { map: ['.....', '..P..', '.....'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 40 } });
    a.inject({ del: [a.gId] });
    a.inject({ put: [{
      id: 'e_s2bl01', kind: 'core:goblin', sid: 998001, pos: { floor: a.key, x: a.ox + 1, y: a.oy + 1 },
      actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
      stats: { hp: 20, maxHp: 20, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d1' }, base: { maxHp: 20, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d1' }, statuses: [],
    } as unknown as Entity] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 1, kills: 0, maxDamageToYou: 15, maxPlainToYou: 10, maxDamageByYou: 0, abilities: [], hitsOnYou: [5, 10], dmgOnYou: [30, 5, 10] };
    const me = structuredClone(a.world.entities[a.meId]); me.stats!.hp = 12; a.inject({ put: [me] });
    // HP 12 ≤ hp_floor 20（先に効く判定）で、しかも最悪の 1 手 15 で倒れうる
    const r = await a.r.port.act({ type: 'fight', target: 'e_s2bl01', hpFloor: 20 }, { source: 'bot' });
    expect(!r.ok && r.error.code).toBe('hp_floor');
    expect(!r.ok && r.error.message).toContain('hp_floor を下げても戦えない');
    expect(!r.ok && r.error.hint).toContain('hp_floor によらず始められない');
    a.manager.closeAll();
  });
});

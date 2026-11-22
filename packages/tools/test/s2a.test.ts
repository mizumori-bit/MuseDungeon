// S2a（SEASON.md §20.6・§20.10）のテスト: 確定は 1 回だけ・公開の値はキャンプで・ランの一覧で伏せる・死にうるときの文・pilot の判定・冒険賞の称号・初討伐の順
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SeasonService, SeasonStore, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import type { Command, Entity, GameEvent, Pos, World } from '@muse/shared';
import { applyEvent, buildObservation, projectPlayerView, threatEstimate } from '@muse/shared';
import { fightRefusal } from '../src/pilot/decide';
import { arena, content } from './v33duel';

const catalog = buildCatalog(content);
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's2at';

function manager(seasonsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir, waitOthersMs: 100 }));
}
function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S2a試し', seed: 's2a-season', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 5000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
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
async function start(r: Run) { expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true); clear(r.session.world); }
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

describe('S2a §20.10 の 1: finalizing happens once, even across processes', () => {
  it('the running server takes the operator tool\'s result.json as final and does not finalize again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2a-close-'));
    try {
      const m = manager(dir);
      openSeason(m);
      const a = await seasonRun(m, 'Aya');
      const b = await seasonRun(m, 'Bo');
      await start(a);
      await descend(a);
      await lifelineHome(a);
      // 運用の道具（別のプロセス）が確定する
      const cli = new SeasonService(new SeasonStore(dir), { engineVersion: ENGINE_VERSION, contentVersion: content.version }, () => null, Date.now, 10, content.lists.seasonTitles);
      const r1 = cli.finalize(cli.get(SID)!, 'operator');
      expect(r1.titles!.map((x) => x.holder)).toEqual(['Aya']);
      // 動いているサーバー: 確定済みとして扱う（参加・遠征の開始を断り、終わりの時刻の後も確定し直さない）
      expect(m.seasons.status(m.seasons.get(SID)!)).toBe('final');
      const cs = m.seasons.canStart(SID, a.session.profileOf(a.playerId));
      expect('reason' in cs && cs.reason).toContain('終わっている');
      const s = await act(b.port, { type: 'start_expedition', offer: 1 });
      expect(!s.ok && s.error.code).toBe('season_ended');
      m.seasons.get(SID)!.def.endsAt = Date.now() - 1000;
      m.seasons.tick();
      const fin = m.seasons.standings(SID)!.result!;
      expect(fin.reason).toBe('operator');
      expect(fin.finalizedAt).toBe(r1.finalizedAt);
      expect(m.seasons.finalize(m.seasons.get(SID)!, 'all_back').reason).toBe('operator');
      m.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S2a §20.10 の 2: public values change only at camp; the run list hides season runs in progress', () => {
  it('deepest, budget used and banked show the last camp, and list_runs gives only the name', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    await seasonRun(m, 'Bo');
    await start(a);
    await descend(a);
    const row = () => m.seasons.standings(SID)!.standings.find((r) => r.name === 'Aya')!;
    // 迷宮の中: 地下 2 階に着いても、順位の表・断面は参加したとき（キャンプ）の値
    expect(row().adventure.value).toBe(1);
    expect(row().used).toBe(0);
    expect(m.seasons.standings(SID)!.section.map((x) => x.depth)).toEqual([1]);
    // 自分の予算の残り（内部の値）は減っている
    expect(m.seasons.sync(a.session, a.playerId)!.budget.left).toBeLessThan(5000);
    // ランの一覧: 進行中のシーズンのランは、名前とシーズンだけ
    const listed = m.listRuns().find((x) => x.runId === a.session.runId)!;
    expect(listed.season).toBe(SID);
    expect(listed.players[0]).toMatchObject({ name: 'Aya', depth: null, hidden: true });
    expect(listed.expeditions).toBeUndefined();
    expect(listed.summary).toBeUndefined();
    // キャンプに着くと出る
    await lifelineHome(a);
    expect(row().adventure.value).toBe(2);
    expect(row().used).toBeGreaterThan(0);
    m.closeAll();
  });
});

describe('S2a §20.10 の 6・4: the adventure title needs depth 2+, and the first warden kill goes by the recorded camp arrival', () => {
  it('no adventure title when nobody went down; an earlier recorded arrival wins on recovery', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Bo');
    await start(a);
    await start(b);
    // Bo が先にキャンプへ着いて記録される（今の時刻）
    b.session.world.milestones = { cleared: [5] };
    await lifelineHome(b);
    expect(m.seasons.get(SID)!.deeds.map((x) => x.name)).toEqual(['Bo']);
    // Aya のランの記録には、それより前に倒してキャンプへ着いた跡がある（S2 の前に戻っていたラン）。起動し直したときの復旧で、記録の時刻で入れ替わる
    await lifelineHome(a);
    const pid = a.playerId;
    a.session.world.milestones = { cleared: [5] };
    const h = a.session.history as GameEvent[];
    h.push({ type: 'warden_slain', depth: 5, seq: 1, cause: null, floor: null, ft: 0, wall: 1000, seenBy: [] } as unknown as GameEvent);
    h.push({ type: 'player_state', player: pid, state: 'at_camp', seq: 2, cause: null, floor: null, ft: 0, wall: 2000, seenBy: [] } as unknown as GameEvent);
    m.seasons.onRecovered(a.session);
    expect(m.seasons.get(SID)!.deeds.map((x) => `${x.name}:${x.wall}`)).toEqual(['Aya:2000']);
    m.seasons.finalize(m.seasons.get(SID)!, 'operator');
    const titles = m.seasons.get(SID)!.result!.titles!.map((x) => `${x.holder}:${x.name.ja}`);
    // 2 人とも地下 1 階のまま: 冒険賞は付かない
    expect(titles).toEqual(['Aya:地下5階の初討伐（S2a試し）']);
    m.closeAll();
  });
});

describe('S2a §20.10 の 3・5: the lethal refusal text, and pilot uses the macro\'s check', () => {
  it('does not tell you to lower hp_floor when one worst turn could kill you; pilot\'s fightRefusal matches fightRiskStop', async () => {
    const a = await arena('s2a-lethal', { map: ['.....', '..P..', '.....'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 40 } });
    a.inject({ del: [a.gId] });
    let sid = 997000;
    const mon = (id: string, x: number, y: number): Entity => ({
      id, kind: 'core:goblin', sid: ++sid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y },
      actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
      stats: { hp: 20, maxHp: 20, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d1' }, base: { maxHp: 20, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d1' }, statuses: [],
    } as unknown as Entity);
    a.inject({ put: [mon('e_s2al01', 1, 1), mon('e_s2al02', 3, 1)] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 2, kills: 0, maxDamageToYou: 10, maxPlainToYou: 6, maxDamageByYou: 0, abilities: [], hitsOnYou: [5, 10], dmgOnYou: [20, 5, 10] };
    const setHp = (hp: number) => { const me = structuredClone(a.world.entities[a.meId]); me.stats!.hp = hp; a.inject({ put: [me] }); };
    const obsOf = () => buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
    // 観測の fight_risk は、マクロと同じ threatEstimate
    setHp(35);
    const v = projectPlayerView(a.world, a.pid);
    expect(obsOf().self.fight_risk).toEqual(threatEstimate(v, catalog, v.entities.filter((e) => e.cat === 'monster')));
    expect(obsOf().self.fight_risk).toEqual({ expected: 8, worst: 20, unrecorded: 0 });
    // pilot: 見込み 8 なら HP 35・hp_floor 25 で始める（前の式は最悪の合計 20 で断っていた）。HP 20 は死にうるので hp_floor 0 でも断る
    expect(fightRefusal(obsOf(), 25)).toBeNull();
    setHp(20);
    expect(fightRefusal(obsOf(), 0)).toBe('hp_risk');
    setHp(21);
    expect(fightRefusal(obsOf(), 0)).toBeNull();
    // 死にうるときの断り: hp_floor を下げるとは言わない
    setHp(20);
    const r = await a.r.port.act({ type: 'fight', target: 'e_s2al01', hpFloor: 0 }, { source: 'bot' });
    expect(!r.ok && r.error.message).toContain('死にうるので止まった');
    expect(!r.ok && r.error.hint).toContain('hp_floor によらず始められない');
    expect(!r.ok && r.error.hint).not.toContain('hp_floor を下げる');
    a.manager.closeAll();
  });
});

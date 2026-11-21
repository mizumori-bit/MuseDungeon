// S0（シーズン。SEASON.md §2・PROTOCOL.md §9）のテスト（SEASON.md §2.10）
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadContent } from '@muse/content';
import { ENGINE_VERSION, generateFloor, previewOffers } from '@muse/engine';
import type { AddressInfo } from 'node:net';
import { computeStandings, createApp, loadConfig, RunSession, SessionManager } from '@muse/server';
import type { Participant, PlayerPort } from '@muse/server';
import { applyEvent, seasonBudgetLeft, seasonReportable } from '@muse/shared';
import type { Command, Expedition, GameEvent, World } from '@muse/shared';
import { playWithPort } from '../src/bot';
import { verifyRunDir } from '../src/replay';
import { seasonCli } from '../src/season';

const content = loadContent();
const table = content.terrain.map((t) => t.id);
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's0t';

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir } : { runsDir: null, profilesDir: null, seasonsDir: null }));
}

function openSeason(m: SessionManager, over: Partial<{ budget: number; endsAt: number; seed: string }> = {}): void {
  m.seasons.store.open({
    id: SID, name: 'S0試し', seed: over.seed ?? 'season-test-1', engineVersion: ENGINE_VERSION, contentVersion: content.version,
    budget: over.budget ?? 3000, endsAt: over.endsAt ?? Date.now() + 86_400_000, openedAt: Date.now(),
  });
}

/** 招く（S0a: 招かれたプロフィールだけが参加できる）。新しいプロフィールのトークンを返す */
function invite(m: SessionManager, name: string): string {
  const r = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in r) throw new Error(r.error);
  return r.token!;
}

/** 招いて参加する（profileToken を渡せば、そのプロフィールで） */
async function seasonRun(m: SessionManager, name: string, extra: { classId?: string; profileToken?: string } = {}) {
  const ptoken = extra.profileToken ?? invite(m, name);
  const r = await m.createRun({ name, controller: agent, season: SID, ...(extra.classId ? { classId: extra.classId } : {}), profileToken: ptoken });
  if ('error' in r) throw new Error(r.error.message);
  return Object.assign(r, { ptoken });
}

const act = (port: PlayerPort, cmd: Command) => port.act(cmd, { source: 'bot' });

/** テストの中だけ: 待っている間に倒されないよう、HP を大きくする（記録に残らない書き換え。再生は見ないテストだけ） */
function tough(w: World, pid: string): void {
  const pe = structuredClone(w.entities[w.players[pid].entityId]);
  pe.stats!.maxHp = 999; pe.stats!.hp = 999; pe.base!.maxHp = 999;
  applyEvent(w, { type: 'thought', player: pid, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [pe] } as unknown as GameEvent);
}

/** 作られた階の入口・下り階段（生成時の floor_generated。作り直しは最初の 1 つ） */
function stairsOf(history: readonly GameEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of history) {
    if (e.type !== 'floor_generated' || out.has(e.floorData.key)) continue;
    const f = e.floorData;
    out.set(f.key, `${f.entry.x},${f.entry.y}|${f.stairs.up ? `${f.stairs.up.x},${f.stairs.up.y}` : '-'}|${f.stairs.down.map((d) => `${d.x},${d.y}`).join(' ')}`);
  }
  return out;
}

describe('S0 §2.3: the stairs are in the same place in every season run', () => {
  it('season generation: objectives and conditions never move the entry or the down stairs (non-season bounty does)', () => {
    const name = { ja: '試し', en: 'test' };
    type Obj = Parameters<typeof generateFloor>[5];
    type Mods = Parameters<typeof generateFloor>[6];
    const crowded = { monstersPct: 150, itemsPct: 100, treasurePct: 150, noFountain: false };
    const variants: [string, Obj, Mods][] = [
      ['guardian with lair terrain', { guardian: true, relic: false, rank: 2, info: { name, types: ['core:charger'], weakness: 'core:weak_water' } }, undefined],
      ['guarded relic', { guardian: true, relic: true, rank: 3, info: { name, types: ['core:charger'], weakness: 'core:weak_water' } }, crowded],
      ['bounty', { guardian: false, relic: false, bounty: { kind: 'core:orc_brute', name, affixes: [] } }, undefined],
      ['bounty, crowded', { guardian: false, relic: false, bounty: { kind: 'core:orc_brute', name, affixes: [] } }, crowded],
      ['scarce', undefined, { monstersPct: 100, itemsPct: 50, treasurePct: 100, noFountain: false }],
      ['quiet', undefined, { monstersPct: 100, itemsPct: 100, treasurePct: 100, noFountain: true }],
    ];
    const key = (g: ReturnType<typeof generateFloor>) => `${g.floor.entry.x},${g.floor.entry.y}|${g.floor.stairs.down.map((d) => `${d.x},${d.y}`).join(' ')}`;
    let floors = 0, nonSeasonMoved = 0;
    for (let s = 0; s < 24; s++) {
      for (let d = 1; d <= 20; d++) {
        const seed = `s0-gen-${s}`;
        const base = generateFloor(content, seed, 'main', d, table);
        if (base.floor.floorType === 'core:warden_hall') continue;
        floors++;
        for (const [label, obj, mods] of variants) {
          const g = generateFloor(content, seed, 'main', d, table, obj, mods, { season: true });
          expect(key(g), `${seed} depth ${d}: ${label}`).toBe(key(base));
        }
        const ns = generateFloor(content, seed, 'main', d, table, variants[2][1]);
        if (key(ns) !== key(base)) nonSeasonMoved++;
      }
    }
    expect(floors).toBe(384);
    // 決まりが要ること: シーズンでない生成では、賞金首の目標階の階段が動くことがある
    expect(nonSeasonMoved).toBeGreaterThan(0);
  });

  it('season runs never offer the vault expedition (non-season runs do)', async () => {
    const m = manager();
    const counts = { season: 0, plain: 0 };
    for (let s = 0; s < 20; s++) {
      const r = await m.createRun({ name: 'O', seed: `s0-offers-${s}`, controller: agent });
      if ('error' in r) throw new Error(r.error.message);
      const w = r.session.world;
      const pid = r.playerId;
      w.expeditions = [{ no: 1, objective: { type: 'slay_guardian', targetDepth: 8 }, points: 0, relicGuarded: false, status: 'ended', startSeq: 1, endSeq: 2, endReason: 'completed', participants: [pid], start: {}, targets: { guardian: null, relic: null }, progress: { reached: true, guardianSlain: true, relicHeldBy: null }, extracted: [{ player: pid, completed: true }], result: null } as unknown as Expedition];
      w.milestones = { cleared: [5, 10, 15] };
      counts.plain += previewOffers(w, content, 2).filter((o) => o.objective.type === 'open_vault').length;
      w.meta.season = { id: SID, name: 'S0' };
      const offers = previewOffers(w, content, 2);
      counts.season += offers.filter((o) => o.objective.type === 'open_vault').length;
    }
    expect(counts.plain).toBeGreaterThan(0);
    expect(counts.season).toBe(0);
    m.closeAll();
  });

  it('two season runs played differently put every shared floor\'s entry and stairs in the same place', async () => {
    const m = manager();
    openSeason(m, { budget: 2500, seed: 'season-stairs-1' });
    const a = await seasonRun(m, 'A', { classId: 'core:warrior' });
    await playWithPort(a.port, { kind: 'greedy', seed: 'a', maxActs: 3000, offerSlot: 'standard', levelAware: true });
    const b = await seasonRun(m, 'B', { classId: 'core:scout' });
    await playWithPort(b.port, { kind: 'greedy', seed: 'b', maxActs: 3000, offerSlot: 'ambitious', levelAware: true, direct: true, cautious: false });
    const sa = stairsOf(a.session.history), sb = stairsOf(b.session.history);
    const common = [...sa.keys()].filter((k) => sb.has(k));
    expect(common.length).toBeGreaterThanOrEqual(4);
    for (const k of common) expect(sb.get(k), k).toBe(sa.get(k));
    // どちらも同じシーズンのシードで、版も同じ
    expect(a.session.world.secret.seed).toBe(b.session.world.secret.seed);
    m.closeAll();
  });
});

describe('S0 §2.2: the budget', () => {
  it('time up: back to camp, not dead, haul lost, items kept, no further expedition; a macro stops with time_up', async () => {
    const m = manager();
    openSeason(m, { budget: 30 });
    const r = await seasonRun(m, 'T');
    const w = r.session.world;
    expect(r.port.observe().text).toContain('残りの予算 30/30');
    expect((await act(r.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    tough(w, r.playerId);
    expect(r.port.observe().text).toContain('シーズン「S0試し」: 残りの予算');
    const before = r.port.view().inventory.map((i) => i.id).sort();
    let macroTimeUp = false;
    for (let i = 0; i < 80 && r.port.view().status !== 'at_camp'; i++) {
      const left = seasonBudgetLeft(w, r.playerId)!;
      const res = await act(r.port, left > 4 ? { type: 'wait' } : { type: 'wait', turns: 10 });
      if (res.ok && res.interrupted_by === 'time_up') macroTimeUp = true;
    }
    const pr = w.players[r.playerId];
    expect(pr.state).toBe('at_camp');
    const x = w.expeditions!.at(-1)!;
    expect(x.endReason).toBe('time_up');
    expect(x.result?.payout?.players[0]?.banked).toBe(0);
    expect(pr.stats.banked ?? 0).toBe(0);
    expect(macroTimeUp).toBe(true);
    // 持ち物は残る（帰還の綱も）
    expect(r.port.view().inventory.map((i) => i.id).sort()).toEqual(before);
    expect(seasonBudgetLeft(w, r.playerId)).toBeLessThanOrEqual(0);
    // 次の遠征は始められない
    const st = await act(r.port, { type: 'start_expedition', offer: 1 });
    expect(st.ok).toBe(false);
    if (!st.ok) expect(st.error.code).toBe('budget_exhausted');
    const o = r.port.observe();
    expect(o.observation.valid_actions.some((v) => v.startsWith('start_expedition'))).toBe(false);
    expect(o.text).toContain('行動予算を使い切った');
    // 新しいランも始められない（同じ参加者）
    const again = await m.createRun({ name: 'T2', controller: agent, season: SID, profileToken: r.ptoken });
    expect('error' in again && again.error.code).toBe('season_unavailable');
    m.closeAll();
  });

  it('the budget is one across runs: a new run after the first one ends starts with what is left', async () => {
    const m = manager();
    openSeason(m, { budget: 500 });
    const r1 = await seasonRun(m, 'R');
    expect((await act(r1.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    tough(r1.session.world, r1.playerId);
    for (let i = 0; i < 25; i++) await act(r1.port, { type: 'wait' });
    const used1 = r1.session.world.entities[r1.session.world.players[r1.playerId].entityId].actor!.turns;
    expect(used1).toBeGreaterThanOrEqual(25);
    // 進行中のシーズンのランがある間は、新しいランを始められない
    const busy = await m.createRun({ name: 'R2', controller: agent, season: SID, profileToken: r1.ptoken });
    expect('error' in busy && busy.error.message).toContain('進行中');
    expect((await r1.port.act({ type: 'retire' }, { source: 'bot' })).ok).toBe(true);
    const r2 = await seasonRun(m, 'R2', { profileToken: r1.ptoken });
    expect(r2.profile.id).toBe(r1.profile.id);
    expect(seasonBudgetLeft(r2.session.world, r2.playerId)).toBe(500 - used1);
    expect(r2.port.observe().text).toContain(`残りの予算 ${500 - used1}/500`);
    // シーズンのランは継承を受けない
    expect(r2.session.world.players[r2.playerId].legacy).toBeUndefined();
    m.closeAll();
  });

  it('after the end time no new expedition starts; new runs are refused', async () => {
    const m = manager();
    openSeason(m, { budget: 500 });
    const r = await seasonRun(m, 'E');
    m.seasons.get(SID)!.def.endsAt = Date.now() - 1000;
    const st = await act(r.port, { type: 'start_expedition', offer: 1 });
    expect(st.ok).toBe(false);
    if (!st.ok) expect(st.error.code).toBe('season_ended');
    const again = await m.createRun({ name: 'E2', controller: agent, season: SID, profileToken: invite(m, 'E2') });
    expect('error' in again && again.error.code).toBe('season_unavailable');
    m.closeAll();
  });
});

describe('S0 §2.4: reporting and published stairs', () => {
  it('first reporter only; published stairs show from the next expedition (not mid-expedition); seeded stairs are not reportable; an ended run cannot report', async () => {
    const m = manager();
    openSeason(m, { budget: 3000, seed: 'season-report-1' });
    const a = await seasonRun(m, 'Aya');
    await playWithPort(a.port, { kind: 'greedy', seed: 'a', maxActs: 600, maxExpeditions: 1 });
    expect(a.port.view().status).toBe('at_camp');
    const found = seasonReportable(a.session.world, a.playerId);
    expect(found.length).toBeGreaterThan(0);
    expect(a.port.observe().text).toContain(`まだ報告していない階段 ${found.length}`);
    // B は遠征に出てから、A が報告する
    const b = await seasonRun(m, 'Ben');
    expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    const rep = await act(a.port, { type: 'report_stairs' });
    expect(rep.ok).toBe(true);
    expect(a.session.world.season!.contribution).toBe(found.length);
    expect(a.session.world.season!.reported).toEqual(found.map((x) => x.depth));
    expect(a.port.observe().text).toContain('貢献賞: あなた');
    const again = await act(a.port, { type: 'report_stairs' });
    expect(!again.ok && again.error.code).toBe('nothing_to_do');
    // 遠征の途中の B には、まだ見えない
    expect(b.session.world.season!.public.length).toBe(0);
    const k1 = 'main:1';
    const f1 = b.session.world.floors[k1];
    const i1 = f1.stairs.down[0].y * f1.width + f1.stairs.down[0].x;
    const bMem = () => b.session.world.players[b.playerId].knowledge.floors[k1];
    const sawBefore = (bMem()?.seen[i1] ?? 0) !== 0;
    // 綱は入口のそばで使うので、B はまだ地下 1 階の下り階段を見ていない（下の枝を必ず通る）
    expect(sawBefore).toBe(false);
    // B は綱で帰る（キャンプで取り込む）→ 次の遠征で地下 1 階に入ると、下り階段が地図に載る
    const life = b.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
    expect((await act(b.port, { type: 'use', slot: life.slot })).ok).toBe(true);
    for (let i = 0; i < 20 && b.port.view().status !== 'at_camp'; i++) await act(b.port, { type: 'wait' });
    expect(b.port.view().status).toBe('at_camp');
    expect(b.session.world.season!.public.map((x) => x.depth)).toEqual(found.map((x) => x.depth));
    expect(b.session.world.season!.public[0].by).toBe('Aya');
    expect((await act(b.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    if (!sawBefore) {
      expect(bMem()!.seen[i1]).not.toBe(0);
      expect(bMem()!.mapped ?? []).toContain(i1);
      const o = b.port.observe();
      const st = o.observation.navigation.known_stairs.find((s) => s.type === 'down');
      expect(st?.public_by).toBe('Aya');
      expect(o.text).toContain('（公開: Aya が報告。まだ見ていない）');
      // travel_to stairs_down は途中の道が分からないので断られ、下への風を探す手を出す
      const tr = await act(b.port, { type: 'travel', to: 'stairs_down' });
      expect(!tr.ok && tr.error.code).toBe('unreachable');
      if (!tr.ok) expect(tr.error.hint).toContain("explore { toward: 'draft' }");
      // 下への風は、自分の目で見るまで出続ける
      expect(o.observation.self.floor?.draft).toBeTruthy();
      // 公開で知っただけの階段は報告できない
      expect(seasonReportable(b.session.world, b.playerId).some((x) => x.depth === 1)).toBe(false);
    }
    // B が同じ階段を報告しても、最初の報告にはならない
    const bw = b.session.world;
    // 綱でもう一度帰る（遠征を終える）
    const life2 = b.port.view().inventory.find((it) => it.kind === 'core:lifeline');
    if (life2) { await act(b.port, { type: 'use', slot: life2.slot }); for (let i = 0; i < 20 && b.port.view().status !== 'at_camp'; i++) await act(b.port, { type: 'wait' }); }
    const bList = seasonReportable(bw, b.playerId);
    if (bList.length) {
      const r2 = await act(b.port, { type: 'report_stairs' });
      expect(r2.ok).toBe(true);
      const ev = b.session.history.filter((e) => e.type === 'stairs_reported').at(-1) as Extract<GameEvent, { type: 'stairs_reported' }>;
      for (const s of ev.stairs) if (found.some((x) => x.depth === s.depth)) expect(s.first).toBe(false);
    }
    // 終わったラン（引退・死亡）は報告できない
    const c = await seasonRun(m, 'Cid');
    await playWithPort(c.port, { kind: 'greedy', seed: 'c', maxActs: 600, maxExpeditions: 1 });
    expect((await c.port.act({ type: 'retire' }, { source: 'bot' })).ok).toBe(true);
    const cr = await act(c.port, { type: 'report_stairs' });
    expect(cr.ok).toBe(false);
    // シーズンでないランでは使えない
    const plain = await m.createRun({ name: 'P', controller: agent });
    if ('error' in plain) throw new Error(plain.error.message);
    const pr = await act(plain.port, { type: 'report_stairs' });
    expect(!pr.ok && pr.error.code).toBe('bad_request');
    m.closeAll();
  });
});

describe('S0 §2.5: awards and ties', () => {
  const P = (name: string, o: Partial<Participant> & { used?: number; banked?: number }): Participant => ({
    profileId: `prof_${name}`, name, joinedAt: 0, runs: [{ runId: `run_${name}`, startedAt: 0, turns: o.used ?? 0, deepest: o.best?.depth ?? 1, banked: o.banked ?? 0, died: !!o.died, ended: false }],
    best: o.best ?? { depth: 1, used: 0 }, firstReports: o.firstReports ?? 0, lastFirstUsed: o.lastFirstUsed ?? 0, died: !!o.died,
  });
  it('deeper wins, ties go to less budget used, identical ties share a rank, the fallen leave the survival award', () => {
    const a = P('a', { best: { depth: 5, used: 900 }, firstReports: 2, lastFirstUsed: 600, used: 1500, banked: 4000 });
    const b = P('b', { best: { depth: 5, used: 800 }, firstReports: 2, lastFirstUsed: 500, used: 1400, banked: 4000 });
    const c = P('c', { best: { depth: 7, used: 2000 }, firstReports: 0, used: 2100, banked: 9000, died: true });
    const d = P('d', { best: { depth: 5, used: 800 }, firstReports: 1, lastFirstUsed: 100, used: 1400, banked: 4000 });
    const st = computeStandings([a, b, c, d]);
    const adv = (p: Participant) => st.award(p, 'adventure');
    expect(adv(c).rank).toBe(1);
    expect(adv(b).rank).toBe(2);
    expect(adv(d).rank).toBe(2);
    expect(adv(a).rank).toBe(4);
    expect(adv(a).leader).toEqual({ name: 'c', value: 7 });
    expect(adv(a).gap).toBe(2);
    const con = (p: Participant) => st.award(p, 'contribution');
    expect(con(b).rank).toBe(1);
    expect(con(a).rank).toBe(2);
    expect(con(d).rank).toBe(3);
    const sur = (p: Participant) => st.award(p, 'survival');
    expect(sur(c).value).toBeNull();
    expect(sur(c).rank).toBeNull();
    expect(sur(b).rank).toBe(1);
    expect(sur(d).rank).toBe(1);
    expect(sur(a).rank).toBe(3);
    expect(sur(a).entrants).toBe(3);
  });

  it('a time-up participant stays in the survival award; a dead one drops out', async () => {
    const m = manager();
    openSeason(m, { budget: 20 });
    const r = await seasonRun(m, 'U');
    await act(r.port, { type: 'start_expedition', offer: 1 });
    tough(r.session.world, r.playerId);
    for (let i = 0; i < 40 && r.port.view().status !== 'at_camp'; i++) await act(r.port, { type: 'wait' });
    const sv = r.session.world.season!.awards.find((x) => x.id === 'survival')!;
    expect(r.session.world.season!.died).toBe(false);
    expect(sv.rank).toBe(1);
    m.closeAll();
  });
});

describe('S0 §2.6: records and replay', () => {
  it('a season run replays from its records alone, and hides the seed; spectators follow only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-season-'));
    try {
      const m = manager(dir);
      openSeason(m, { budget: 400, seed: 'season-replay-1' });
      const a = await seasonRun(m, 'Rin');
      // 観戦: シーズンのランは、サーバーの設定（既定 omniscient）によらず follow_only（進行中の記録は出さない）
      {
        const app = createApp(m, m.config);
        await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
        const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
        expect((await fetch(`${base}/api/runs/${a.session.runId}/events`)).status).toBe(403);
        const seasons = (await (await fetch(`${base}/api/seasons`)).json()) as { seasons: { id: string; participants: number }[] };
        expect(seasons.seasons.map((x) => x.id)).toEqual([SID]);
        const st = (await (await fetch(`${base}/api/seasons/${SID}`)).json()) as { standings: { name: string }[] };
        expect(st.standings.map((x) => x.name)).toEqual(['Rin']);
        // 公開された階段の位置は出さない
        expect(JSON.stringify(st)).not.toContain('"public"');
        await new Promise<void>((res) => app.server.close(() => res()));
      }
      await playWithPort(a.port, { kind: 'greedy', seed: 'a', maxActs: 900 });
      if (a.port.view().status === 'at_camp' && seasonReportable(a.session.world, a.playerId).length) expect((await act(a.port, { type: 'report_stairs' })).ok).toBe(true);
      await a.port.act({ type: 'retire' }, { source: 'bot' });
      const runId = a.session.runId;
      const types = new Set(a.session.history.map((e) => e.type));
      expect(types.has('season_synced')).toBe(true);
      // 記録だけで再生が一致する（シーズンの記録は読まない）
      const v = verifyRunDir(content, join(dir, runId));
      expect(v.reexecMatches).toBe(true);
      expect(v.foldMatchesKeyframe).toBe(true);
      // シードを出さない
      expect(a.session.summary()?.seed).toBe('');
      expect(a.session.meta().seed).toBeUndefined();
      expect(a.session.meta().season).toBe(SID);
      // 参加者の記録
      const st = m.seasons.standings(SID)!;
      expect(st.standings[0].name).toBe('Rin');
      expect(st.standings[0].used).toBeGreaterThan(0);
      m.closeAll();
      // 起動し直したサーバーが、シーズンの記録を読み直す
      const m2 = manager(dir);
      expect(m2.seasons.list().map((x) => x.id)).toEqual([SID]);
      expect(m2.seasons.standings(SID)!.standings[0].used).toBe(st.standings[0].used);
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a live season run recovers with a matching hash (season_sync re-executes from the log)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-season-'));
    try {
      const m = manager(dir);
      openSeason(m, { budget: 300, seed: 'season-replay-2' });
      const a = await seasonRun(m, 'Kai');
      await playWithPort(a.port, { kind: 'greedy', seed: 'k', maxActs: 400, maxExpeditions: 2 });
      if (a.port.view().status === 'at_camp' && seasonReportable(a.session.world, a.playerId).length) await act(a.port, { type: 'report_stairs' });
      const hash = JSON.stringify(a.session.world.season);
      m.closeAll();
      const m2 = manager(dir);
      const rec = RunSession.recover(m2.deps, a.session.runId);
      expect(rec.verified).toBe(true);
      expect(JSON.stringify((rec.session.world as World).season)).toBe(hash);
      // 復旧したランでも参加者が分かり、取り込みが続く（キーフレームより前の参加の命令も読む）
      expect(rec.session.profileOf(a.playerId)).toBe(a.profile.id);
      const synced = await rec.session.syncSeason(a.playerId, 'camp');
      expect(synced.ok).toBe(true);
      m2.closeAll();
      // サーバーの起動（recoverAll）でも同じ
      const m3 = manager(dir);
      m3.recoverAll();
      const live = m3.get(a.session.runId)!;
      expect(live.profileOf(a.playerId)).toBe(a.profile.id);
      m3.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S0: the operator tool', () => {
  it('says which arguments went unused (PowerShell npm run drops named arguments; unquoted commas split values)', () => {
    const out: string[] = [];
    // npm run が --id・--seed・--ends を消した形
    expect(seasonCli(content, { sub: 'open', dir: null, stray: ['s0', 's0-a', '2026-12-01T21:00:00+09:00'] }, (x) => out.push(x))).toBe(1);
    expect(out[0]).toContain('使われなかった引数: s0 s0-a');
    expect(out[0]).toContain('npm.cmd run season');
    expect(out.at(-1)).toContain('--id が要る');
    // 正しい形なら知らせない
    const ok: string[] = [];
    expect(seasonCli(content, { sub: 'wardens', dir: null, seeds: ['s0-a', 's0-b'], stray: [] }, (x) => ok.push(x))).toBe(0);
    expect(ok.join(' ')).not.toContain('使われなかった引数');
    expect(ok.length).toBe(4);
  });
});

describe('S0a §4.1: only profiles the operator invited may start season runs', () => {
  it('refuses a request without a token, with an unknown token, and with an uninvited profile; the reasons say so', async () => {
    const m = manager();
    openSeason(m);
    const none = await m.createRun({ name: 'N', controller: agent, season: SID });
    expect('error' in none && none.error.code).toBe('season_unavailable');
    expect('error' in none && none.error.message).toContain('profile_token が要る');
    const unknown = await m.createRun({ name: 'U', controller: agent, season: SID, profileToken: 'no-such-token' });
    expect('error' in unknown && unknown.error.code).toBe('season_unavailable');
    expect('error' in unknown && unknown.error.message).toContain('トークンは見つからない');
    // シーズンでないランで作ったプロフィールは、招かれていない
    const plain = await m.createRun({ name: 'Plain', controller: agent });
    if ('error' in plain) throw new Error(plain.error.message);
    const uninvited = await m.createRun({ name: 'Plain', controller: agent, season: SID, profileToken: plain.profile.token });
    expect('error' in uninvited && uninvited.error.code).toBe('season_unavailable');
    expect('error' in uninvited && uninvited.error.message).toContain('招かれていない');
    expect('error' in uninvited && uninvited.error.message).toContain('運用者');
    // 断ったときにランは残らない
    expect([...m.sessions.values()].filter((x) => x.world.meta.season).length).toBe(0);
    // 今あるプロフィールを招けば、そのトークンのまま参加できる（招いた表示名で順位に載る）
    const inv = m.seasons.invite(SID, 'Plainly', m.profiles.store, plain.profile.token);
    expect('error' in inv).toBe(false);
    expect('token' in inv && inv.token).toBeFalsy();
    const ok = await m.createRun({ name: 'キャラ名', controller: agent, season: SID, profileToken: plain.profile.token });
    if ('error' in ok) throw new Error(ok.error.message);
    expect(m.seasons.standings(SID)!.standings.map((x) => x.name)).toEqual(['Plainly']);
    m.closeAll();
  });

  it('a new run after falling is the same participant and the budget carries on', async () => {
    const m = manager();
    // このシードの地下 1 階で待ち続けると、ゴブリンに倒される（V4-1m の時点の版）
    openSeason(m, { budget: 500, seed: 'season-test-1' });
    const r1 = await seasonRun(m, 'Fall');
    expect((await act(r1.port, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    for (let i = 0; i < 200 && r1.port.view().status === 'your_turn'; i++) await act(r1.port, { type: 'wait' });
    expect(r1.session.world.players[r1.playerId].state).toBe('dead');
    const used1 = r1.session.world.entities[r1.session.world.players[r1.playerId].entityId].actor!.turns;
    const r2 = await seasonRun(m, 'Fall2', { profileToken: r1.ptoken });
    expect(r2.profile.id).toBe(r1.profile.id);
    expect(seasonBudgetLeft(r2.session.world, r2.playerId)).toBe(500 - used1);
    const st = m.seasons.standings(SID)!;
    expect(st.standings.length).toBe(1);
    expect(st.standings[0]).toMatchObject({ name: 'Fall', runs: 2, died: true, survival: null });
    // 倒れたので生還賞の対象外（キャンプの写しにも）
    expect(r2.session.world.season!.died).toBe(true);
    expect(r2.session.world.season!.awards.find((a) => a.id === 'survival')!.value).toBeNull();
    m.closeAll();
  });

  it('a display name cannot be invited twice in a season (spaces, case and full-width do not make it different); a profile cannot be invited twice', () => {
    const m = manager();
    openSeason(m);
    const a = m.seasons.invite(SID, 'Muse', m.profiles.store);
    expect('token' in a && a.token).toBeTruthy();
    for (const name of ['Muse', ' muse ', 'ＭＵＳＥ']) {
      const b = m.seasons.invite(SID, name, m.profiles.store);
      expect('error' in b && b.error).toContain('すでに使われている');
    }
    const again = m.seasons.invite(SID, 'Muse2', m.profiles.store, 'token' in a ? a.token : '');
    expect('error' in again && again.error).toContain('もう招いてある');
    expect(m.seasons.store.invites(SID).map((x) => x.name)).toEqual(['Muse']);
    m.closeAll();
  });

  it('the operator tool invites through files the running server reads; the token is shown once and appears in no record, observation or standings', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-season-'));
    try {
      const m = manager(dir);
      openSeason(m, { budget: 300, seed: 'season-token-1' });
      // 運用の道具（別のプロセスと同じく、ファイルだけを通す）
      const out: string[] = [];
      const code = seasonCli(content, { sub: 'invite', dir: join(dir, 'seasons'), profilesDir: join(dir, 'profiles'), id: SID, name: 'Tok' }, (x) => out.push(x));
      expect(code).toBe(0);
      const line = out.find((x) => x.startsWith('profile_token: '))!;
      const token = line.slice('profile_token: '.length);
      expect(token.length).toBeGreaterThan(10);
      expect(out.filter((x) => x.includes(token)).length).toBe(1);
      // 同じ表示名は断る
      const dup: string[] = [];
      expect(seasonCli(content, { sub: 'invite', dir: join(dir, 'seasons'), profilesDir: join(dir, 'profiles'), id: SID, name: 'tok' }, (x) => dup.push(x))).toBe(1);
      // 一覧にトークンは出ない
      const list: string[] = [];
      seasonCli(content, { sub: 'invites', dir: join(dir, 'seasons'), id: SID }, (x) => list.push(x));
      expect(list.join(' ')).toContain('Tok');
      expect(list.join(' ')).not.toContain(token);
      // 動いているサーバー（先に作った manager）が、道具の作ったプロフィールと招きを読む
      const r = await m.createRun({ name: 'Hero', controller: agent, season: SID, profileToken: token });
      if ('error' in r) throw new Error(r.error.message);
      await playWithPort(r.port, { kind: 'greedy', seed: 't', maxActs: 300, maxExpeditions: 1 });
      if (r.port.view().status === 'at_camp' && seasonReportable(r.session.world, r.playerId).length) await act(r.port, { type: 'report_stairs' });
      const obs = r.port.observe().text;
      const st = JSON.stringify(m.seasons.standings(SID));
      expect(st).toContain('"Tok"');
      expect(st).not.toContain(token);
      expect(obs).not.toContain(token);
      m.closeAll();
      // 記録のどのファイルにも出ない（プロフィールにはハッシュだけ）
      const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
      const files = walk(dir);
      expect(files.some((f) => f.endsWith('invites.json'))).toBe(true);
      for (const f of files) expect(readFileSync(f, 'utf8').includes(token), f).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

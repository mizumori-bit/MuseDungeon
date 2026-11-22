// S5（SEASON.md §47.4・§47.5）のテスト: 討伐の記録の予備動作と動けなかった手番・退いた後のキャンプの並べ・古い形の記録・文の直し
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, buildObservation, emptyWorld, formatObservationText, SeasonSlaySchema, SeasonSyncSchema, slayObs } from '@muse/shared';
import type { Command, Entity, GameEvent, SeasonSlay, World } from '@muse/shared';
import { buildAttempts, buildSlays, incapStatuses } from '../../server/src/season/slays';
import { rulesText } from '../../server/src/mcp/rules';

const content = loadContent();
const catalog = buildCatalog(content);
const incap = incapStatuses(content);
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's5t';

function manager(runsDir: string | null = null): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir, waitOthersMs: 100 } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
}
function openSeason(m: SessionManager): void {
  m.seasons.store.open({ id: SID, name: 'S5試し', seed: 's4-season-1', engineVersion: ENGINE_VERSION, contentVersion: content.version, budget: 6000, endsAt: Date.now() + 86_400_000, openedAt: Date.now() });
}
async function seasonRun(m: SessionManager, name: string) {
  const inv = m.seasons.invite(SID, name, m.profiles.store);
  if ('error' in inv) throw new Error(inv.error);
  const r = await m.createRun({ name, controller: agent, season: SID, classId: 'core:warrior', profileToken: inv.token! });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
async function plainRun(m: SessionManager, name: string) {
  const r = await m.createRun({ name, seed: 's4-season-1', controller: agent, classId: 'core:warrior' });
  if ('error' in r) throw new Error(r.error.message);
  return r;
}
type Run = Awaited<ReturnType<typeof plainRun>>;
const act = (r: { port: PlayerPort }, cmd: Command) => r.port.act(cmd, { source: 'bot' });
const meOf = (w: World, pid: string) => w.entities[w.players[pid].entityId];
const floorOf = (r: Run) => meOf(r.session.world, r.playerId).pos!.floor;

/** テストの書き換え。履歴にも足す（畳んだ World が今の World と合うように。記録のファイルには書かない） */
function rec(r: Run, p: { put?: Entity[]; del?: string[] }): void {
  const w = r.session.world;
  const ev = { type: 'thought', player: w.playerOrder[0], text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent;
  applyEvent(w, ev);
  r.session.history.push(ev);
}
function edit(r: Run, id: string, fn: (e: Entity) => void): void { const e = structuredClone(r.session.world.entities[id]); fn(e); rec(r, { put: [e] }); }
function clearMonsters(r: Run, keepWarden = false): void {
  const w = r.session.world;
  rec(r, { del: Object.values(w.entities).filter((e) => e.actor && !e.player && !(keepWarden && e.guardian?.warden)).map((e) => e.id) });
}
async function lifelineHome(r: Run): Promise<void> {
  const life = r.port.view().inventory.find((it) => it.kind === 'core:lifeline')!;
  expect((await act(r, { type: 'use', slot: life.slot })).ok).toBe(true);
  for (let i = 0; i < 20 && r.port.view().status !== 'at_camp'; i++) await act(r, { type: 'wait' });
  expect(r.port.view().status).toBe('at_camp');
  await new Promise((res) => setTimeout(res, 5));
}
async function descend(r: Run, keepWarden = false): Promise<void> {
  const w = r.session.world;
  const d = w.floors[floorOf(r)].stairs.down[0];
  edit(r, meOf(w, r.playerId).id, (e) => { e.pos = { floor: e.pos!.floor, x: d.x, y: d.y }; });
  clearMonsters(r, keepWarden);
  expect((await act(r, { type: 'wait' })).ok).toBe(true);
  clearMonsters(r, keepWarden);
  const s = await act(r, { type: 'stairs' });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(r, keepWarden);
}
async function toWarden(r: Run): Promise<string> {
  const s = await act(r, { type: 'start_expedition', offer: 1 });
  expect(s.ok ? '' : JSON.stringify(s.error)).toBe('');
  clearMonsters(r);
  for (let i = 0; i < 4; i++) await descend(r, i === 3);
  const key = floorOf(r);
  expect(r.session.world.floors[key].depth).toBe(5);
  return Object.values(r.session.world.entities).find((e) => e.pos?.floor === key && e.guardian?.warden)!.id;
}

const CARD: [string, number, number, string, number, number][] = [['e', 1, 0, 's', 0, 1], ['w', -1, 0, 'n', 0, -1], ['s', 0, 1, 'w', -1, 0], ['n', 0, -1, 'e', 1, 0]];
/**
 * 突進を 1 回外させて、外させた手番に 1 回殴る。大守護者を突き進む者にして、自分の後ろが壁のマス P に置き、大守護者を P から 3 マス先に置く。
 * 構えを見たら横へ 1 歩外れる（突進は P で壁に止まり、隣で朦朧になる）
 */
async function chargeMiss(r: Run, wid: string): Promise<void> {
  const w = r.session.world;
  const key = floorOf(r);
  const f = w.floors[key];
  const tt = w.meta.terrainTable;
  const conceal = new Set(w.meta.concealTerrain ?? []);
  const open = (x: number, y: number) => {
    if (x < 1 || y < 1 || x >= f.width - 1 || y >= f.height - 1) return false;
    const i = y * f.width + x;
    const tr = content.terrain[content.terrainIndex[tt[f.terrain[i]]]];
    if (!tr.passable || tr.opaque || tr.stairs || tr.door || conceal.has(f.terrain[i])) return false;
    return !Object.values(w.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && e.id !== wid && e.id !== meOf(w, r.playerId).id);
  };
  const blocked = (x: number, y: number) => !content.terrain[content.terrainIndex[tt[f.terrain[y * f.width + x]]]].passable;
  let spot: { p: { x: number; y: number }; dir: string; dx: number; dy: number; side: string } | null = null;
  for (let y = 2; y < f.height - 2 && !spot; y++) for (let x = 2; x < f.width - 2 && !spot; x++) {
    for (const [dir, dx, dy, side, sx, sy] of CARD) {
      if (!blocked(x - dx, y - dy) || ![0, 1, 2, 3].every((k) => open(x + dx * k, y + dy * k)) || !open(x + sx, y + sy)) continue;
      spot = { p: { x, y }, dir, dx, dy, side };
      break;
    }
  }
  expect(spot).toBeTruthy();
  const { p, dx, dy, side } = spot!;
  edit(r, meOf(w, r.playerId).id, (e) => { e.pos = { floor: key, ...p }; e.stats!.hp = 900; e.stats!.maxHp = 999; e.stats!.acc = 99; });
  edit(r, wid, (e) => {
    e.pos = { floor: key, x: p.x + dx * 3, y: p.y + dy * 3 };
    e.guardian!.types = ['core:charger'];
    e.stats!.hp = 500; e.stats!.maxHp = 500; e.stats!.eva = -99;
    e.actor!.ai = { ...e.actor!.ai!, state: 'hunting', targetPos: { ...p }, lostTurns: 0 };
    delete e.actor!.ai.intent;
    delete e.actor!.dormant;
  });
  // 構えるまで待つ（追跡中で直線の 3 マス先）
  for (let i = 0; i < 3 && !w.entities[wid].actor!.ai!.intent; i++) expect((await act(r, { type: 'wait' })).ok).toBe(true);
  expect(w.entities[wid].actor!.ai!.intent?.kind).toBe('winding_up');
  // 横へ外れる: 突進は空を切って P で止まり、朦朧になる
  expect((await act(r, { type: 'move', dir: side as never })).ok).toBe(true);
  const g = w.entities[wid];
  expect(g.pos).toMatchObject(p);
  expect(g.statuses?.some((s) => s.id === 'core:stun')).toBe(true);
  // 外させた手番に殴る
  const res = await act(r, { type: 'attack', target: wid });
  expect(res.ok ? '' : JSON.stringify(res.error)).toBe('');
}

describe('S5 §47.4 の 1: telegraphs and the turns the warden could not act, counted from the event log', () => {
  it('a plain history: seen, missed and hit by kind; the missed turn, a sleeping turn and the rest; an expedition that was not won is an attempt', () => {
    let seq = 0;
    const ev = (type: string, floor: string | null, p: Record<string, unknown>) => ({ type, seq: ++seq, cause: seq, floor, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
    const F = 'main:5';
    const ai = (state: string, intent?: Record<string, unknown>) => ({ archetype: 'melee_chaser', state, targetPos: null, lostTurns: 0, params: {}, ...(intent ? { intent } : {}) });
    const myTurn = (n: number) => [ev('turn_began', F, { actor: 'e_me0001', time: n }), ev('actor_scheduled', F, { id: 'e_me0001', nextActAt: n + 100, turns: n })];
    const h: GameEvent[] = [
      ev('player_joined', null, { player: { id: 'p1' }, entity: { id: 'e_me0001', pos: { floor: 'main:1', x: 1, y: 1 } } }),
      ev('expedition_started', null, { expedition: { no: 1 } }),
      ev('entity_changed_floor', F, { id: 'e_me0001', to: { floor: F, x: 1, y: 1 } }),
      ev('entity_spawned', F, { entity: { id: 'e_ward01', kind: 'core:orc_brute', pos: { floor: F, x: 4, y: 1 }, guardian: { name: { ja: '試し', en: 'Trial' }, types: ['core:charger'], warden: true }, actor: { ai: ai('asleep') }, statuses: [] } }),
      // 眠っている相手を見ているだけの 2 手番（戦いが始まる前なので数えない。S5a）
      ev('turn_began', F, { actor: 'e_me0001', time: 0 }), ev('actor_scheduled', F, { id: 'e_me0001', nextActAt: 0, turns: 0 }),
      ev('turn_began', F, { actor: 'e_me0001', time: 0 }), ev('actor_scheduled', F, { id: 'e_me0001', nextActAt: 0, turns: 0 }),
      // 眠っている相手を、自分の手番に殴る（眠りなどの手番。戦いを始めた一手の手番は数える。強打で 4）
      ev('turn_began', F, { actor: 'e_me0001', time: 1 }),
      ev('attack', F, { attacker: 'e_me0001', target: 'e_ward01', hit: true, crit: true }),
      ev('damaged', F, { target: 'e_ward01', via: 'melee', source: 'e_me0001', amount: 4, dealt: 4 }),
      ev('actor_scheduled', F, { id: 'e_me0001', nextActAt: 100, turns: 1 }),
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting') }),
      // 1 回目の構え → 見る → 外れて朦朧 → 外させた手番に 5
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting', { kind: 'winding_up', dir: 'w' }) }),
      ...myTurn(2),
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting') }),
      ev('status_applied', F, { target: 'e_ward01', status: { id: 'core:stun', turnsLeft: 1, power: 0 }, statusesAfter: [{ id: 'core:stun', turnsLeft: 1, power: 0 }] }),
      ev('actor_scheduled', F, { id: 'e_ward01', nextActAt: 300, turns: 3 }),
      ev('turn_began', F, { actor: 'e_me0001', time: 3 }),
      ev('damaged', F, { target: 'e_ward01', via: 'melee', source: 'e_me0001', amount: 5, dealt: 5 }),
      ev('actor_scheduled', F, { id: 'e_me0001', nextActAt: 400, turns: 3 }),
      ev('status_expired', F, { target: 'e_ward01', statusId: 'core:stun', statusesAfter: [] }),
      // 2 回目の構え → 突進を受ける（8）
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting', { kind: 'winding_up', dir: 'w' }) }),
      ...myTurn(4),
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting') }),
      ev('attack', F, { attacker: 'e_ward01', target: 'e_me0001', hit: true, crit: false }),
      ev('damaged', F, { target: 'e_me0001', via: 'melee', source: 'e_ward01', amount: 8, dealt: 8 }),
      ev('actor_scheduled', F, { id: 'e_ward01', nextActAt: 500, turns: 5 }),
      ...myTurn(5),
    ];
    const live = {
      players: { p1: { entityId: 'e_me0001', classId: 'core:warrior', knowledge: { identified: [] } } },
      entities: { e_me0001: { id: 'e_me0001', level: { level: 3, xp: 0 } } },
      secret: { appearances: {} },
    } as unknown as World;
    const none = { world: emptyWorld(), from: Number.MAX_SAFE_INTEGER };
    const end = [...h, ev('player_state', null, { player: 'p1', state: 'at_camp' }), ev('expedition_ended', null, { no: 1 })];
    // 倒さずに帰った: 挑戦（同じ作り方）
    const [a] = buildAttempts(end, none, 'p1', live, 1, incap);
    expect(a.warden).toEqual({ ja: '試し', en: 'Trial' });
    expect(a.tells).toEqual([{ kind: 'winding_up', n: 2, seen: 2, missed: 1, hit: 1 }]);
    expect(a.openings).toEqual({ missed: { turns: 1, dealt: 5, hitTurns: 1, taken: 0 }, other: { turns: 1, dealt: 4, hitTurns: 1, taken: 0 } });
    expect(a.taken).toBe(8);
    expect(a.dealt.melee).toEqual({ total: 9, n: 2 });
    expect(a.attempt).toBe(1);
    // 倒した記録にも同じ項目（倒した一手は手番に数える）
    const kill = [...h, ev('turn_began', F, { actor: 'e_me0001', time: 6 }), ev('damaged', F, { target: 'e_ward01', via: 'melee', source: 'e_me0001', amount: 3, dealt: 3 }),
      ev('warden_slain', F, { depth: 5, id: 'e_ward01', guardianName: { ja: '試し', en: 'Trial' }, by: 'e_me0001' })];
    const [s] = buildSlays(kill, none, 'p1', live, new Set(), incap);
    expect(s.tells).toEqual(a.tells);
    expect(s.openings).toEqual(a.openings);
    expect(s.turns).toBe(6);
    expect(buildAttempts([...kill, ev('expedition_ended', null, { no: 1 })], none, 'p1', live, 1, incap)).toEqual([]);
    // 文: 数と事実だけ
    const text = slayObs('ja', catalog, { ...s, by: 'X', of: 1 }).text;
    expect(text).toContain('突進の構えを 2 回見て、1 回外させ、1 回受けた');
    expect(text).toContain('予備動作を外させた後の 1 手番: 与えた被害 5（当てた手番 1）・受けた被害 0。眠りなどで相手が動けなかった 1 手番: 与えた被害 4（当てた手番 1）・受けた被害 0。それ以外の手番: 与えた被害 3・受けた被害 8');
    expect(SeasonSlaySchema.parse({ ...s, by: 'X', of: 1 })).toMatchObject({ tells: s.tells, openings: s.openings });
    // 手番が 0 の区分は文に出さない（S5a）。どちらも 0 なら文ごと出さない
    const z = { missed: s.openings!.missed, other: { turns: 0, dealt: 0, hitTurns: 0, taken: 0 } };
    const t1 = slayObs('ja', catalog, { ...s, openings: z, by: 'X', of: 1 }).text;
    expect(t1).toContain('予備動作を外させた後の 1 手番');
    expect(t1).not.toContain('眠りなど');
    const t0 = slayObs('ja', catalog, { ...s, openings: { missed: z.other, other: z.other }, by: 'X', of: 1 }).text;
    expect(t0).not.toContain('手番: 与えた被害');
    expect(t0).not.toContain('それ以外の手番');
  });

  it('a record from before S5 (no telegraph items) still reads: the schema takes it, and the text leaves the items out', () => {
    const old = {
      depth: 5, warden: { ja: '試し', en: 'Trial' }, by: 'Old', of: 1, first: true, least: true, level: 6, classId: 'core:warrior',
      weapon: null, armor: null, dealt: { melee: { total: 90, n: 9 }, thrown: { total: 0, n: 0 }, poison: { total: 0, n: 0 }, feature: { total: 0, n: 0 }, crits: 0 },
      taken: 40, used: [], thrown: [], abilities: [], wardFires: 0, attempt: 1, turns: 50,
    } satisfies SeasonSlay;
    expect(SeasonSlaySchema.parse(old)).toEqual(old);
    expect(SeasonSyncSchema.safeParse({ type: 'season_sync', reason: 'camp', season: { id: 's', name: 's', budget: { limit: 1, left: 1 }, ends_at: 0, ended: false, public: [], awards: [], contribution: 0, died: false, slays: [old] } }).success).toBe(true);
    const o = slayObs('ja', catalog, old);
    expect(o.tells).toBeUndefined();
    expect(o.openings).toBeUndefined();
    expect(o.text).not.toContain('予備動作');
    expect(o.text).not.toContain('動けなかった');
    expect(o.text).toContain('与えた被害 90');
  });
});

describe('S5 §47.4 の 2: after coming back from a warden without slaying it, camp shows your attempt beside the kill records', () => {
  it('season: your numbers, then the first slayer in the same order; once only (gone after the next expedition); the record itself carries the telegraphs', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    // Aya: 突進を 1 回外させ、外させた手番に殴ってから倒す
    const wa = await toWarden(a);
    await chargeMiss(a, wa);
    edit(a, wa, (e) => { e.stats!.hp = 1; });
    for (let i = 0; i < 10 && a.session.world.entities[wa]; i++) await act(a, { type: 'attack', target: wa });
    expect(a.session.world.entities[wa]).toBeUndefined();
    await lifelineHome(a);
    const recs = m.seasons.get(SID)!.slays;
    expect(recs).toHaveLength(1);
    expect(recs[0].tells).toEqual([{ kind: 'winding_up', n: 1, seen: 1, missed: 1, hit: 0 }]);
    expect(recs[0].openings!.missed.turns).toBe(1);
    expect(recs[0].openings!.missed.dealt).toBeGreaterThan(0);
    expect(recs[0].openings!.missed.hitTurns).toBe(1);
    // slays.json を消して起動し直したのと同じ: キャンプにいる、終わっていないランの記録が、新しい項目で作り直される
    const before = structuredClone(recs[0]);
    m.seasons.get(SID)!.slays.length = 0;
    m.seasons.onRecovered(a.session);
    const again = m.seasons.get(SID)!.slays;
    expect(again).toHaveLength(1);
    expect({ ...again[0], wall: 0 }).toEqual({ ...before, wall: 0 });

    // Ben: 突進を 1 回外させて殴り、倒さずに綱で帰る
    const wb = await toWarden(b);
    await chargeMiss(b, wb);
    await lifelineHome(b);
    const ob = b.port.observe().observation;
    const cmp = ob.camp!.compare!;
    expect(cmp.wardens).toHaveLength(1);
    const x = cmp.wardens![0];
    expect(x.depth).toBe(5);
    expect(x.attempt.tells).toEqual([{ kind: 'winding_up', name: '突進の構え', n: 1, seen: 1, missed: 1, hit: 0 }]);
    expect(x.attempt.openings!.missed.turns).toBe(1);
    expect(x.attempt.openings!.missed.dealt).toBeGreaterThan(0);
    expect(x.records.map((r) => r.by)).toEqual(['Aya']);
    expect(x.lines).toHaveLength(2);
    expect(x.lines[0]).toMatch(/^大守護者「.+」（地下5階）への遠征 \d+ の挑戦（倒さずに帰った）: あなた（Lv\d+・戦士）: /);
    expect(x.lines[0]).toContain('突進の構えを 1 回見て、1 回外させ、0 回受けた');
    expect(x.lines[0]).toContain('このランの中で 1 回目の挑戦');
    expect(x.lines[1]).toMatch(/^ {2}先に倒した者（倒した記録 1 件）: Aya（Lv\d+・戦士）: /);
    expect(x.lines[1]).toContain('突進の構えを 1 回見て、1 回外させ、0 回受けた');
    // 同じ項目の並び: 2 つの文の「与えた被害 → 受けた被害 → 予備動作 → 動けなかった手番」の順が同じ
    const order = (s: string) => ['与えた被害', '受けた被害', '突進の構え', '予備動作を外させた後の 1 手番: 与えた被害', 'それ以外の手番'].map((k) => s.indexOf(k));
    expect(order(x.lines[0]).every((v, i, xs) => v > 0 && (i === 0 || v > xs[i - 1]))).toBe(true);
    expect(order(x.lines[1]).every((v, i, xs) => v > 0 && (i === 0 || v > xs[i - 1]))).toBe(true);
    const text = formatObservationText(ob, 'ja');
    expect(text).toContain(x.lines[0]);
    expect(text).toContain(x.lines[1]);
    // 同じ記録の全文は 1 回だけ（S5a）: 記録庫の側は 1 行
    const arch = ob.camp!.archive!.slays!.find((s) => s.depth === 5)!;
    expect(arch.text).toBe(`記録庫・討伐の記録 地下5階の大守護者「${x.warden}」: （上の挑戦の並べに出している）`);
    expect(arch.records.map((r) => r.by)).toEqual(['Aya']);
    expect(text.split(x.records[0].text).length - 1).toBe(1);
    // 大守護者の候補は短い形（候補を 1 つ大守護者を倒す遠征に書き換えて、観測を作り直す）。構造化した slays は全部
    const vb = structuredClone(b.port.view());
    vb.camp!.offers = [{ ...vb.camp!.offers[0], objective: { type: 'slay_warden', targetDepth: 5 } }];
    vb.milestonesCleared = [];
    const offer = buildObservation(vb, catalog, { detail: 'full', map: false }).camp!.offers[0];
    expect(offer.slays![0].text).toBe(x.records[0].text);
    expect(offer.text).toMatch(/ \/ 先に倒した者（倒した記録 1 件）: Aya（Lv\d+・戦士・小剣）。与えた被害 \d+・受けた被害 \d+・突進の構えを 1 回見て 1 回外させた・\d+ 手番目に倒した。詳しくは記録庫$/);
    expect(offer.text).not.toContain('使った品');
    // 共有しない: シーズンの記録は Aya の 1 件だけ（Ben の挑戦は外へ出ない）
    expect(m.seasons.get(SID)!.slays.map((s) => s.name)).toEqual(['Aya']);
    // observe し直しても出る
    expect(b.port.observe().observation.camp!.compare!.wardens).toHaveLength(1);
    // 次の遠征（大守護者と戦わない）の後には出ない
    expect((await act(b, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    clearMonsters(b);
    await lifelineHome(b);
    const ob2 = b.port.observe().observation;
    expect(ob2.camp!.compare).toBeTruthy();
    expect(ob2.camp!.compare!.wardens).toBeUndefined();
    expect(formatObservationText(ob2, 'ja')).not.toContain('の挑戦（倒さずに帰った）');
    // 並べが無ければ、記録庫は全文
    expect(ob2.camp!.archive!.slays![0].text).toContain(`: 先に倒した者（倒した記録 1 件）: ${x.records[0].text}`);
    m.closeAll();
  }, 120_000);

  it('with no kill record (season with no slayer, and a run outside a season) only your own line', async () => {
    const m = manager();
    openSeason(m);
    for (const r of [await seasonRun(m, 'Cid'), await plainRun(m, 'Dee')]) {
      const wid = await toWarden(r);
      await chargeMiss(r, wid);
      await lifelineHome(r);
      const x = r.port.observe().observation.camp!.compare!.wardens!;
      expect(x).toHaveLength(1);
      expect(x[0].records).toEqual([]);
      expect(x[0].lines).toHaveLength(1);
      expect(x[0].lines[0]).toContain('あなた（Lv');
      expect(x[0].attempt.tells![0]).toMatchObject({ kind: 'winding_up', missed: 1 });
    }
    m.closeAll();
  }, 120_000);

  it('a restart writes nothing (S5a: no intake at start-up); a participant at camp keeps the previous records until the next intake (starting an expedition)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s5-'));
    try {
      const m = manager(dir);
      openSeason(m);
      // 書き換えをしないラン（再生が記録と一致する）: 遠征を始めて、綱で帰る
      const b = await seasonRun(m, 'Ben');
      expect((await act(b, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
      await lifelineHome(b);
      expect(b.port.view().season!.slays).toBeUndefined();
      // 止まっている間に、別の参加者の記録が（S5 の項目つきで）載ったことにする
      const d = m.seasons.get(SID)!;
      const facts = {
        depth: 5, warden: { ja: '試し', en: 'Trial' }, level: 6, classId: 'core:warrior', weapon: null, armor: null,
        dealt: { melee: { total: 90, n: 9 }, thrown: { total: 0, n: 0 }, poison: { total: 0, n: 0 }, feature: { total: 0, n: 0 }, crits: 0 },
        taken: 61, used: [], thrown: [], abilities: [], wardFires: 0, attempt: 1, turns: 79,
        tells: [{ kind: 'winding_up' as const, n: 11, seen: 11, missed: 11, hit: 0 }],
        openings: { missed: { turns: 11, dealt: 23, hitTurns: 7, taken: 0 }, other: { turns: 6, dealt: 0, hitTurns: 0, taken: 0 } },
      };
      d.slays.push({ ...facts, order: 1, profileId: 'prof_other0001', runId: 'run_other00001', name: 'Aya', budgetUsed: 0, wall: 0 });
      m.seasons.store.saveSlays(d);
      m.closeAll();
      const cmds = () => readFileSync(join(dir, b.session.runId, 'commands.jsonl'), 'utf8').trim().split('\n').length;
      const n0 = cmds();
      const m2 = manager(dir);
      m2.recoverAll();
      await new Promise((res) => setTimeout(res, 20));
      const s2 = m2.get(b.session.runId)!;
      expect(s2).toBeTruthy();
      // 起動では書かない。キャンプにいる参加者には、前の記録（ここでは無し）のまま
      expect(cmds()).toBe(n0);
      expect(s2.world.season!.slays).toBeUndefined();
      // 次の取り込み（遠征を始める）で届く
      const p2 = m2.portForToken(b.token)!;
      expect((await p2.act({ type: 'start_expedition', offer: 1 }, { source: 'bot' })).ok).toBe(true);
      expect(s2.world.season!.slays!.map((x) => [x.by, x.tells?.[0].missed])).toEqual([['Aya', 11]]);
      m2.closeAll();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('S5 §47.5: rule texts', () => {
  it('collect within is the distance to the nearest item, counted again after each pickup (not a total); camp settling says enemies go back to unaware, not to sleep', () => {
    for (const L of ['ja', 'en'] as const) {
      const all = rulesText('all', L, catalog);
      expect(all).toContain(L === 'ja' ? 'いま居るマスからいちばん近い品までの歩数の上限' : 'within caps the walk from where you stand to the nearest item');
      expect(all).toContain(L === 'ja' ? '合計の歩数の上限ではない' : 'it is not a cap on the total');
      expect(all).toContain(L === 'ja' ? '気づいていない状態（unaware）に戻り（眠りには戻らない' : 'go back to unaware (they do not go back to sleep');
    }
  });
});

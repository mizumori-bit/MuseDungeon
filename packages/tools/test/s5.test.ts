// S5（SEASON.md §47.4・§47.5）のテスト: 討伐の記録の予備動作と動けなかった手番・退いた後のキャンプの並べ・古い形の記録・文の直し
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { ENGINE_VERSION } from '@muse/engine';
import { createApp, loadConfig, SessionManager } from '@muse/server';
import type { PlayerPort } from '@muse/server';
import { applyEvent, buildObservation, emptyWorld, formatObservationText, macroProbe, projectPlayerView, SeasonSlaySchema, SeasonSyncSchema, slayObs, slayShortText } from '@muse/shared';
import { arena } from './v33duel';
import type { Command, Entity, GameEvent, SeasonSlay, World } from '@muse/shared';
import { buildAttempts, buildSlays, incapStatuses } from '../../server/src/season/slays';
import { rulesText } from '../../server/src/mcp/rules';

const content = loadContent();
const catalog = buildCatalog(content);
const incap = incapStatuses(content);
const agent = { kind: 'agent' as const, label: 'test' };
const SID = 's5t';

function manager(runsDir: string | null = null, extra: { keyframeEvery?: number } = {}): SessionManager {
  return new SessionManager(content, loadConfig(runsDir ? { runsDir, waitOthersMs: 100, ...extra } : { runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
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

/**
 * テストの書き換え。履歴にも足す（畳んだ World が今の World と合うように。記録のファイルには書かない）。
 * recordEdits が false なら履歴に足さない（起動し直すテスト: 履歴と記録のファイルを同じにする）
 */
let recordEdits = true;
function rec(r: Run, p: { put?: Entity[]; del?: string[] }): void {
  recEv(r, { type: 'thought', player: r.session.world.playerOrder[0], text: '', floor: null, ...p });
}
function recEv(r: Run, p: Record<string, unknown>): void {
  const w = r.session.world;
  const ev = { seq: w.seq + 1, cause: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent;
  applyEvent(w, ev);
  if (recordEdits) r.session.history.push(ev);
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
async function chargeMiss(r: Run, wid: string, opts: { grass?: boolean; scar?: number; placed?: (at: { key: string; p: { x: number; y: number }; line: { x: number; y: number }[]; dodge: { x: number; y: number }; open: (x: number, y: number) => boolean }) => void } = {}): Promise<void> {
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
  let spot: { p: { x: number; y: number }; dir: string; dx: number; dy: number; side: string; sx: number; sy: number } | null = null;
  for (let y = 2; y < f.height - 2 && !spot; y++) for (let x = 2; x < f.width - 2 && !spot; x++) {
    for (const [dir, dx, dy, side, sx, sy] of CARD) {
      if (!blocked(x - dx, y - dy) || ![0, 1, 2, 3].every((k) => open(x + dx * k, y + dy * k)) || !open(x + sx, y + sy)) continue;
      spot = { p: { x, y }, dir, dx, dy, side, sx, sy };
      break;
    }
  }
  expect(spot).toBeTruthy();
  const { p, dx, dy, side, sx, sy } = spot!;
  edit(r, meOf(w, r.playerId).id, (e) => { e.pos = { floor: key, ...p }; e.stats!.hp = 900; e.stats!.maxHp = 999; e.stats!.acc = 99; });
  edit(r, wid, (e) => {
    e.pos = { floor: key, x: p.x + dx * 3, y: p.y + dy * 3 };
    e.guardian!.types = ['core:charger'];
    e.stats!.hp = 500 - (opts.scar ?? 0); e.stats!.maxHp = 500; e.stats!.eva = -99;
    if (opts.scar) e.scar = opts.scar;
    e.actor!.ai = { ...e.actor!.ai!, state: 'hunting', targetPos: { ...p }, lostTurns: 0 };
    delete e.actor!.ai.intent;
    delete e.actor!.dormant;
  });
  // grass: 大守護者のマスを背の高い草にする（構えが、こちらから見えない。草は中の者を隠し、隣でなければ見えない）
  if (opts.grass) {
    const g = tt.indexOf('core:tall_grass');
    expect(g).toBeGreaterThanOrEqual(0);
    expect(w.meta.concealTerrain ?? []).toContain(g);
    recEv(r, { type: 'tile_changed', floor: key, x: p.x + dx * 3, y: p.y + dy * 3, terrain: g, reason: 'other', by: null });
  }
  // placed: 位置が決まった後に、テストが地物などを置く（S6a: 護りの火）
  opts.placed?.({ key, p, line: [0, 1, 2, 3].map((k) => ({ x: p.x + dx * k, y: p.y + dy * k })), dodge: { x: p.x + sx, y: p.y + sy }, open });
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
    expect(o.text).not.toContain('戦い始めの相手');
    expect(o.text).toContain('与えた被害 90');
    // S6 §49.5 の 1・2: 候補の短い形は「何で倒したか」「護りの火」から。傷跡から始めた相手は、そう書く（アオイの 5 回目の形）
    const aoi = {
      ...old, by: 'アオイ', level: 7, weapon: { kind: 'core:short_sword', affixes: [], got: 'start' as const },
      dealt: { melee: { total: 51, n: 9 }, thrown: { total: 0, n: 0 }, poison: { total: 0, n: 0 }, feature: { total: 0, n: 0 }, crits: 0 }, taken: 51, attempt: 5,
      tells: [{ kind: 'winding_up' as const, n: 5, seen: 5, missed: 5, hit: 0 }], wardenStart: { scar: 39, firesLit: 0 },
    };
    expect(SeasonSlaySchema.parse(aoi)).toEqual(aoi);
    const so = slayObs('ja', catalog, aoi);
    // S6a §50.4: 始めの体力は出さない（傷跡だけ）。護りの火は数だけ（「消してから」などの評価の言葉は付けない）。前の挑戦で消えたままなら「灯っていた火 0」
    expect(slayShortText('ja', so)).toBe('アオイ（Lv7・戦士）。小剣の近接だけ・品なし。護りの火: 戦い始めに灯っていた火 0。突進の構えを 5 回外させた。与 51・受 51（相手は、傷跡で体力 −39 から）。5 回目の挑戦');
    expect(so.text).toContain('。相手は、傷跡で体力 −39 から。');
    expect(so.text).toContain('護りの火: 戦い始めに灯っていた火 0');
    expect(so.warden_start).toEqual({ scar: 39, fires_lit: 0 });
    expect(slayShortText('en', slayObs('en', catalog, aoi))).toContain('. Ward fires: none lit when the fight began. ');
    // 灯っていた火と消した火・いろいろな出どころ。傷跡が無ければ、傷跡の句は出ない
    const mix = { ...aoi, dealt: { ...aoi.dealt, poison: { total: 11, n: 11 }, thrown: { total: 1, n: 1 } }, used: [{ kind: 'core:potion_healing', n: 1 }], wardFires: 1, wardenStart: { scar: 0, firesLit: 1 } };
    const mixText = slayShortText('ja', slayObs('ja', catalog, mix));
    expect(mixText).toMatch(/^アオイ（Lv7・戦士）。小剣の近接 51・投擲 1・毒 11・品: 回復の薬 1。護りの火: 戦い始めに 1 つ灯っていた・この挑戦で 1 つ消した。/);
    expect(mixText).not.toContain('相手は');
    expect(slayObs('ja', catalog, mix).text).not.toContain('傷跡');
    // 見た火が無い（戦い始めの数が無い）古い形: 消した数だけ
    expect(slayShortText('ja', slayObs('ja', catalog, { ...mix, wardenStart: { scar: 0 } }))).toContain('・品: 回復の薬 1。護りの火: この挑戦で 1 つ消した。');
    for (const x of [so.text, slayShortText('ja', so), mixText]) expect(x).not.toMatch(/始めの体力|消してから|先に消した|灯ったまま/);
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
    // S6 §49.5 の 2: 戦いが始まったときの相手（傷跡なし。この大守護者の棲み処には護りの火が無い）。S6a: 始めの体力は持たない
    expect(recs[0].wardenStart).toEqual({ scar: 0 });
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
    // S5b: 項目ごとに 1 行の表（左に自分・右に先に倒した者）
    expect(x.lines[0]).toMatch(/^大守護者「.+」（地下5階）への挑戦（遠征 \d+・倒さずに帰った）を、先に倒した者の記録と並べる:$/);
    expect(x.lines[1]).toMatch(/^ {2}（項目: あなた Lv\d+・戦士・小剣 ／ Aya Lv\d+・戦士・小剣）$/);
    const at = (label: string) => x.lines.findIndex((l) => l.startsWith(`  ${label}: `));
    expect(x.lines[at('突進の構えを外させた')]).toBe('  突進の構えを外させた: 1 回（見た 1・受けた 0） ／ 1 回（見た 1・受けた 0）');
    // 予備動作の行のすぐ下に、その予備動作を出す型の説明（知っている型だけ。データの名前と説明）
    const ch = catalog.guardianTypes['core:charger'];
    expect(ch.intent).toBe('winding_up');
    // このテストの大守護者の型は、生成のときのもの（突進を出す型ではない）なので、説明は出ない
    expect(b.port.view().camp!.milestone!.types).not.toContain('core:charger');
    expect(x.lines.some((l) => l.includes('型「'))).toBe(false);
    // 突進を出す型を知っていれば（キャンプの節目の型）、行のすぐ下に、その型の名前と説明。知らなければ出さない
    const withTypes = (types: string[]) => {
      const v = structuredClone(b.port.view());
      v.camp!.milestone = { ...v.camp!.milestone!, types };
      for (const o of v.camp!.offers) delete o.warden;
      return buildObservation(v, catalog, { detail: 'brief', map: false, campCompare: { no: cmp.no, lines: [], wardens: [b.session.wardenAttempts(b.playerId, cmp.no)[0]] } }).camp!.compare!.wardens![0].lines;
    };
    const lk = withTypes(['core:charger', 'core:warded']);
    const ik = lk.findIndex((l) => l.startsWith('  突進の構えを外させた: '));
    expect(lk[ik + 1]).toBe(`    型「${ch.name.ja}」: ${ch.desc.ja}`);
    expect(lk.filter((l) => l.includes('型「'))).toHaveLength(1);
    expect(withTypes([]).some((l) => l.includes('型「'))).toBe(false);
    expect(x.lines[at('外させた後の動けない手番')]).toMatch(/^ {2}外させた後の動けない手番: 1 手番で 与えた \d+（当てた 1）・受けた 0 ／ 1 手番で 与えた \d+（当てた 1）・受けた 0$/);
    // 並べる順（予備動作 → 動けない手番 → それ以外 → 与えた内訳 → 受けた → 手番）。両方とも 0・なしの行は無い
    const rows = ['突進の構えを外させた', '外させた後の動けない手番', 'それ以外の手番', '与えた被害の内訳', '手番'].map(at);
    expect(rows.every((v, i, xs) => v > 1 && (i === 0 || v > xs[i - 1]))).toBe(true);
    expect(at('護りの火')).toBe(-1);
    // 傷跡がどの列にも無ければ、戦い始めの相手の行は無い（S6a）
    expect(at('戦い始めの相手')).toBe(-1);
    expect(at('眠りなどの動けない手番')).toBe(-1);
    expect(x.lines[at('手番')]).toMatch(/^ {2}手番: \d+ 手番目まで戦って帰った（このランで 1 回目の挑戦） ／ \d+ 手番目に倒した（倒したランで 1 回目の挑戦）$/);
    expect(x.lines.join('\n')).not.toMatch(/べき|足りない/);
    const text = formatObservationText(ob, 'ja');
    for (const l of x.lines) expect(text).toContain(l);
    // 同じ記録の全文は 1 回だけ（S5a）: 記録庫の側は 1 行
    const arch = ob.camp!.archive!.slays!.find((s) => s.depth === 5)!;
    expect(arch.text).toBe(`記録庫・討伐の記録 地下5階の大守護者「${x.warden}」: （上の挑戦の並べに出している）`);
    expect(arch.records.map((r) => r.by)).toEqual(['Aya']);
    expect(text).not.toContain(x.records[0].text);
    // 初めて受け取った討伐の記録の知らせ（S5b）: Ben は遠征を始めるときに Aya の記録を受け取り、キャンプで初めて見る
    expect(ob.season!.slay_news!.map((n) => n.by)).toEqual(['Aya']);
    expect(ob.season!.slay_news![0].text).toMatch(/^新しい討伐の記録: 地下5階の大守護者「.+」を、Aya（Lv\d+・戦士・小剣）が倒した（与えた被害 \d+・受けた被害 \d+・突進の構えを 1 回外させた）$/);
    expect(text).toContain(ob.season!.slay_news![0].text);
    // 倒した本人には、自分の記録の知らせは出ない
    expect(a.port.observe().observation.season!.slay_news).toBeUndefined();
    // 大守護者の候補は短い形（候補を 1 つ大守護者を倒す遠征に書き換えて、観測を作り直す）。構造化した slays は全部。
    // S5b: そのランで退いた、いちばん新しい挑戦を同じ 3 項目で添える
    const prev = b.session.lastWardenAttempt(b.playerId, 5)!;
    expect(prev.no).toBe(cmp.no);
    const vb = structuredClone(b.port.view());
    vb.camp!.offers = [{ ...vb.camp!.offers[0], objective: { type: 'slay_warden', targetDepth: 5 } }];
    vb.milestonesCleared = [];
    const offer = buildObservation(vb, catalog, { detail: 'full', map: false, wardenPrev: { 5: prev } }).camp!.offers[0];
    expect(offer.slays![0].text).toBe(x.records[0].text);
    // S6: 何で倒したか・護りの火から始める短い形（この大守護者の棲み処には火が無い）
    expect(offer.text).toMatch(new RegExp(` / 先に倒した者（倒した記録 1 件）: Aya（Lv\\d+・戦士）。小剣の近接だけ・品なし。突進の構えを 1 回外させた。与 \\d+・受 \\d+。1 回目の挑戦。／あなたの前の挑戦（遠征 ${cmp.no}）: 与えた被害 \\d+・受けた被害 \\d+・突進の構えを 1 回見て 1 回外させた。全文は records$`));
    expect(offer.text).not.toContain('使った品');
    // 2 人の列（最初の 1 人・いちばん少ない被害の 1 人）。S5 より前の記録の列は「記録に無い」
    const ws = b.session.wardenAttempts(b.playerId, cmp.no);
    const v2 = structuredClone(b.port.view());
    const aya = v2.season!.slays![0];
    const { tells: _t, openings: _o, ...oldShape } = aya;
    v2.season!.slays = [{ ...aya, least: undefined, of: 2 }, { ...oldShape, by: 'Zed', first: undefined, least: true, of: 2, taken: 0 }];
    const l2 = buildObservation(v2, catalog, { detail: 'brief', map: false, campCompare: { no: cmp.no, lines: [], wardens: ws } }).camp!.compare!.wardens![0].lines;
    expect(l2[1]).toMatch(/^ {2}（項目: あなた Lv\d+・戦士・小剣 ／ Aya（先に倒した） Lv\d+・戦士・小剣 ／ Zed（いちばん少ない被害） Lv\d+・戦士・小剣）$/);
    expect(l2.find((l) => l.startsWith('  突進の構えを外させた: '))).toBe('  突進の構えを外させた: 1 回（見た 1・受けた 0） ／ 1 回（見た 1・受けた 0） ／ 記録に無い');
    expect(l2.find((l) => l.startsWith('  それ以外の手番: '))).toMatch(/ ／ 記録に無い$/);
    // 英語: 表・候補・知らせ（単数・複数、読める形）
    const ve = structuredClone(b.port.view());
    ve.locale = 'en';
    ve.camp!.offers = [{ ...ve.camp!.offers[0], objective: { type: 'slay_warden', targetDepth: 5 } }];
    ve.milestonesCleared = [];
    const oe = buildObservation(ve, catalog, { detail: 'full', map: false, campCompare: { no: cmp.no, lines: [], wardens: ws }, wardenPrev: { 5: prev }, slayNews: ve.season!.slays });
    const le = oe.camp!.compare!.wardens![0].lines;
    expect(le[0]).toMatch(/^Your attempt on the warden ".+" \(depth 5; expedition \d+, came back without slaying it\), beside the kill record:$/);
    expect(le.find((l) => l.includes('made to miss'))).toBe('  charge wind-ups made to miss: 1 (saw 1, 0 hit you) / 1 (saw 1, 0 hit you)');
    expect(le.find((l) => l.startsWith('  turns it could not act after a missed wind-up: '))).toMatch(/: 1 turn: dealt \d+ \(landed in 1\), took 0 \/ 1 turn: dealt \d+ \(landed in 1\), took 0$/);
    expect(le.join('\n')).not.toMatch(/\b1 turns\b|wind-ups miss/);
    expect(oe.camp!.offers[0].text).toMatch(new RegExp(`your last attempt \\(expedition ${cmp.no}\\): dealt \\d+, took \\d+, charge wind-ups: saw 1, 1 missed\\. Full text: records$`));
    expect(oe.camp!.offers[0].text).toContain('charge wind-ups: saw 1, 1 missed');
    expect(oe.season!.slay_news![0].text).toMatch(/^New warden kill record: Aya \(Lv\d+ .+, .+\) slew ".+" on depth 5 \(dealt \d+, took \d+, charge wind-ups: 1 missed\)$/);
    // 記録が無くても、自分の前の挑戦は出す
    const vn = structuredClone(vb);
    vn.season!.slays = [];
    expect(buildObservation(vn, catalog, { detail: 'full', map: false, wardenPrev: { 5: prev } }).camp!.offers[0].text).toMatch(new RegExp(` / あなたの前の挑戦（遠征 ${cmp.no}）: 与えた被害 \\d+・受けた被害 \\d+・突進の構えを 1 回見て 1 回外させた$`));
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
    // 並べも新しい記録も無いキャンプでは、記録庫は 1 行（S6 §49.5 の 4）。全文は records で読める。知らせは 2 度出ない
    expect(ob2.camp!.archive!.slays![0].text).toBe(`記録庫・討伐の記録 地下5階の大守護者「${x.warden}」: 倒した記録 1 件（最初で、いちばん少ない被害: Aya）。全文は records`);
    expect(ob2.camp!.archive!.slays![0].records[0].text).toBe(x.records[0].text);
    const sa = b.port.slayArchive();
    expect(sa.lines.some((l) => l.includes(x.records[0].text))).toBe(true);
    expect(sa.data[0].records[0].text).toBe(x.records[0].text);
    expect(ob2.season!.slay_news).toBeUndefined();
    // 倒した者のキャンプ: もう倒した大守護者の記録は 1 行（S6 §49.5 の 3）
    expect(a.port.observe().observation.camp!.archive!.slays![0].text).toMatch(/: 倒した記録 1 件（最初で、いちばん少ない被害: Aya）。全文は records$/);
    // 記録を初めて見るキャンプ（並べが無い）では全文、その次のキャンプからは 1 行（S6 §49.5 の 4）。後から参加した者は、最初のキャンプで全文
    const c = await seasonRun(m, 'Cal');
    const oc = c.port.observe().observation;
    expect(oc.season!.slay_news).toBeUndefined();
    expect(oc.camp!.archive!.slays![0].text).toContain(`: 先に倒した者（倒した記録 1 件）: ${x.records[0].text}`);
    expect((await act(c, { type: 'start_expedition', offer: 1 })).ok).toBe(true);
    clearMonsters(c);
    await lifelineHome(c);
    expect(c.port.observe().observation.camp!.archive!.slays![0].text).toMatch(/: 倒した記録 1 件（.+）。全文は records$/);
    // 前の挑戦は、何回前の遠征でも（いちばん新しいもの）
    expect(b.session.lastWardenAttempt(b.playerId, 5)?.no).toBe(cmp.no);
    m.closeAll();
  }, 120_000);

  it('with no kill record (season with no slayer, and a run outside a season) only your own line', async () => {
    const m = manager();
    openSeason(m);
    for (const r of [await seasonRun(m, 'Cid'), await plainRun(m, 'Dee')]) {
      const wid = await toWarden(r);
      // 前の挑戦で傷跡 −39 が残っている相手（S6 §49.5 の 2）
      await chargeMiss(r, wid, { scar: 39 });
      await lifelineHome(r);
      const x = r.port.observe().observation.camp!.compare!.wardens!;
      expect(x[0].attempt.warden_start).toEqual({ scar: 39 });
      expect(x[0].lines).toContain('  戦い始めの相手: 傷跡で体力 −39');
      expect(x).toHaveLength(1);
      expect(x[0].records).toEqual([]);
      // 自分の列だけ
      expect(x[0].lines[0]).toMatch(/^大守護者「.+」（地下5階）への挑戦（遠征 \d+・倒さずに帰った）:$/);
      expect(x[0].lines[1]).toMatch(/^ {2}（項目: あなた Lv\d+・戦士・小剣）$/);
      expect(x[0].lines.some((l) => l.includes(' ／ '))).toBe(false);
      expect(x[0].lines.some((l) => l.startsWith('  突進の構えを外させた: 1 回（見た 1・受けた 0）'))).toBe(true);
      expect(x[0].attempt.tells![0]).toMatchObject({ kind: 'winding_up', missed: 1 });
    }
    m.closeAll();
  }, 120_000);

  it('after a restart (recovered with a matching replay) the last attempt on the warden is rebuilt from the run records to the same facts; nothing is written; the attempt reaches neither the season files nor HTTP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-s5b-'));
    // 書き換えを履歴に足さない（履歴と記録のファイルを同じにする）。キーフレームを命令ごとに書く（書き換えの後のキーフレームから再生するので、一致して復旧する）
    recordEdits = false;
    try {
      const m = manager(dir, { keyframeEvery: 1 });
      openSeason(m);
      const c = await seasonRun(m, 'Cid');
      const wid = await toWarden(c);
      await chargeMiss(c, wid);
      await lifelineHome(c);
      const before = c.session.lastWardenAttempt(c.playerId, 5)!;
      expect(before).toBeTruthy();
      expect(before.facts.dealt.melee.n).toBeGreaterThan(0);
      m.closeAll();
      const files = () => ['commands.jsonl', 'events.jsonl'].map((f) => readFileSync(join(dir, c.session.runId, f), 'utf8').length);
      const f0 = files();
      const m2 = manager(dir, { keyframeEvery: 1 });
      const log: string[] = [];
      m2.recoverAll((s) => log.push(s));
      // 再生が記録と一致して復旧した
      expect(log.some((l) => l.includes(`recovered ${c.session.runId}`) && l.includes('hash ok'))).toBe(true);
      expect(log.some((l) => l.includes('食い違'))).toBe(false);
      const s2 = m2.get(c.session.runId)!;
      const after = s2.lastWardenAttempt(c.playerId, 5)!;
      expect(after).toEqual(before);
      // 観測を作っても、記録には書かない
      m2.portForToken(c.token)!.observe();
      expect(files()).toEqual(f0);
      // 挑戦の数は、シーズンのファイルにも HTTP にも出ない（記録が無いので、項目の名前も出ない）
      const sdir = join(dir, 'seasons', SID);
      for (const f of readdirSync(sdir)) {
        const s = readFileSync(join(sdir, f), 'utf8');
        for (const k of ['"tells"', '"openings"', '"attempt"']) expect(s.includes(k), `${f} ${k}`).toBe(false);
      }
      const app = createApp(m2, m2.config);
      await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
      try {
        const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
        for (const path of [`/api/seasons/${SID}`, `/api/runs/${c.session.runId}`]) {
          const body = await (await fetch(`${base}${path}`)).text();
          for (const k of ['"tells"', '"openings"', 'wardenAttempt']) expect(body.includes(k), `${path} ${k}`).toBe(false);
        }
      } finally {
        await app.close();
      }
      m2.closeAll();
    } finally {
      recordEdits = true;
      rmSync(dir, { recursive: true, force: true });
    }
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

describe('S6a (SEASON.md §50.4): an unslain warden\'s HP shows nowhere; ward fires only as far as you saw them', () => {
  it('your attempt, the table, the offer and the kill record carry the scar only (texts and fields); the fire count at the start is the fires you saw; a fire put out out of sight is not counted', async () => {
    const m = manager();
    openSeason(m);
    const a = await seasonRun(m, 'Aya');
    const b = await seasonRun(m, 'Ben');
    // Ben: 傷跡 −39 の相手を倒す（ほかの者の討伐の記録）
    const wb = await toWarden(b);
    await chargeMiss(b, wb, { scar: 39 });
    edit(b, wb, (e) => { e.stats!.hp = 1; });
    for (let i = 0; i < 10 && b.session.world.entities[wb]; i++) await act(b, { type: 'attack', target: wb });
    expect(b.session.world.entities[wb]).toBeUndefined();
    await lifelineHome(b);
    const recs = m.seasons.get(SID)!.slays;
    expect(recs.map((x) => x.name)).toEqual(['Ben']);
    expect(recs[0].wardenStart).toEqual({ scar: 39 });
    // Aya: 傷跡 −39 の相手に、棲み処の護りの火 3 つ（1 つは近くで見える・1 つは遠くで見えない・1 つは見た後に、見えない所で消える）。
    // 突進を外させて殴り、倒さずに帰る
    const wa = await toWarden(a);
    const w = a.session.world;
    // 見た後に、見えない所で消える火（S6b）: 遠い隅で見てから離れ、見えない間に消える。最後に見た「灯っている」で数え、消した数には入れない
    const key5 = floorOf(a);
    const f5 = w.floors[key5];
    const tt5 = w.meta.terrainTable;
    const free = (x: number, y: number) => {
      const tr = content.terrain[content.terrainIndex[tt5[f5.terrain[y * f5.width + x]]]];
      return tr.passable && !tr.opaque && !tr.stairs && !tr.door && !Object.values(w.entities).some((e) => e.pos?.floor === key5 && e.pos.x === x && e.pos.y === y);
    };
    let corner = { x: 0, y: 0 };
    let cfire = { x: 0, y: 0 };
    for (let y = 1; y < f5.height - 1; y++) for (let x = 1; x < f5.width - 1; x++) {
      if (x + y <= corner.x + corner.y || !free(x, y)) continue;
      const n = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => ({ x: x + dx, y: y + dy })).find((c) => free(c.x, c.y));
      if (n) { corner = { x, y }; cfire = n; }
    }
    edit(a, meOf(w, a.playerId).id, (e) => { e.pos = { floor: key5, ...corner }; });
    rec(a, { put: [{ id: 'e_s6afir3', kind: 'core:ward_fire', sid: Math.max(...Object.values(w.entities).map((e) => e.sid ?? 0)) + 1, pos: { floor: key5, ...cfire }, feature: { state: 'lit' }, lairOf: wa } as Entity] });
    expect((await act(a, { type: 'wait' })).ok).toBe(true);
    expect(w.players[a.playerId].knowledge.visible.includes(cfire.y * f5.width + cfire.x)).toBe(true);
    let near = { x: 0, y: 0 };
    let far = { x: 0, y: 0 };
    await chargeMiss(a, wa, {
      scar: 39,
      placed: ({ key, p, line, dodge, open }) => {
        const f = w.floors[key];
        const skip = (x: number, y: number) => [...line, dodge].some((c) => c.x === x && c.y === y);
        const cells: { x: number; y: number; d: number }[] = [];
        for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) if (open(x, y) && !skip(x, y)) cells.push({ x, y, d: Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) });
        near = cells.filter((c) => c.d === 1 || c.d === 2).sort((u, v) => u.d - v.d)[0];
        far = cells.sort((u, v) => v.d - u.d)[0];
        let sid = Math.max(...Object.values(w.entities).map((e) => e.sid ?? 0));
        const fire = (id: string, c: { x: number; y: number }) => ({ id, kind: 'core:ward_fire', sid: ++sid, pos: { floor: key, x: c.x, y: c.y }, feature: { state: 'lit' }, lairOf: wa } as Entity);
        rec(a, { put: [fire('e_s6afir1', near), fire('e_s6afir2', far)] });
        // 隅から離れた（視界を空にする。次の手番に、P からの視界で数え直す）。見えない間に、隅の火が消える
        recEv(a, { type: 'knowledge_updated', player: a.playerId, floorKey: key, visible: [], newlySeen: [], rememberedSet: [], rememberedDel: [], metAdd: [], floor: key });
        recEv(a, { type: 'feature_state', floor: key, id: 'e_s6afir3', kind: 'core:ward_fire', state: 'out' });
      },
    });
    const f = w.floors[floorOf(a)];
    const vis = w.players[a.playerId].knowledge.visible;
    expect(vis.includes(near.y * f.width + near.x)).toBe(true);
    expect(vis.includes(far.y * f.width + far.x)).toBe(false);
    expect(vis.includes(cfire.y * f.width + cfire.x)).toBe(false);
    expect(w.entities['e_s6afir3'].feature!.state).toBe('out');
    // 見えている火が消えた（数える）・見えていない火が消えた（数えない）
    recEv(a, { type: 'feature_state', floor: floorOf(a), id: 'e_s6afir1', kind: 'core:ward_fire', state: 'out' });
    recEv(a, { type: 'feature_state', floor: floorOf(a), id: 'e_s6afir2', kind: 'core:ward_fire', state: 'out' });
    const startHp = 500 - 39;
    const leftHp = w.entities[wa].stats!.hp;
    expect(leftHp).toBeLessThan(startHp);
    await lifelineHome(a);
    const ob = a.port.observe().observation;
    const x = ob.camp!.compare!.wardens![0];
    // 灯っていた火: 近くの火と、最後に見たときに灯っていた隅の火（見ていない遠くの火は入らない）。消した火: 見えていた近くの火だけ
    expect(x.attempt.warden_start).toEqual({ scar: 39, fires_lit: 2 });
    expect(x.attempt.ward_fires).toBe(1);
    expect(x.attempt.text).toContain('。相手は、傷跡で体力 −39 から。');
    expect(x.attempt.text).toContain('護りの火: 戦い始めに 2 つ灯っていた・この挑戦で 1 つ消した');
    const at = (label: string) => x.lines.find((l) => l.startsWith(`  ${label}: `));
    expect(at('戦い始めの相手')).toBe('  戦い始めの相手: 傷跡で体力 −39 ／ 傷跡で体力 −39');
    expect(at('護りの火')).toBe('  護りの火: 戦い始めに 2 つ灯っていた・この挑戦で 1 つ消した ／ なし');
    // 候補（大守護者を倒す遠征）の記録の短い形と、前の挑戦
    const prev = a.session.lastWardenAttempt(a.playerId, 5)!;
    const v = structuredClone(a.port.view());
    v.camp!.offers = [{ ...v.camp!.offers[0], objective: { type: 'slay_warden', targetDepth: 5 } }];
    v.milestonesCleared = [];
    const offer = buildObservation(v, catalog, { detail: 'full', map: false, wardenPrev: { 5: prev } }).camp!.offers[0];
    expect(offer.text).toContain('（相手は、傷跡で体力 −39 から）');
    // 文: 始めの体力も、残りの体力も無い
    const recText = offer.text.slice(offer.text.indexOf('先に倒した者'));
    // 構造化した知らせ・記録庫（S6b）
    expect(ob.season!.slay_news!.map((n) => n.by)).toEqual(['Ben']);
    const archive = ob.camp!.archive!.slays!;
    expect(archive.length).toBeGreaterThan(0);
    const texts = [x.attempt.text, ...x.lines, ...x.records.map((r) => r.text), recText, ...offer.slays!.map((r) => r.text), ...a.port.slayArchive().lines,
      ...ob.season!.slay_news!.map((n) => n.text), ...archive.flatMap((s) => [s.text, ...s.records.map((r) => r.text)])];
    for (const t of texts) {
      expect(t).not.toMatch(/始めの体力|started at/);
      expect(t).not.toContain(String(startHp));
      expect(t).not.toContain(String(leftHp));
    }
    expect(formatObservationText(ob, 'ja')).not.toMatch(/始めの体力/);
    // 項目: 体力の項目は無い（挑戦・並べの記録・候補の記録・見える討伐の記録・シーズンの置き場所）
    const fields = [x.attempt, ...x.records, ...offer.slays!, a.port.view().season!.slays, prev.facts, m.seasons.get(SID)!.slays, ob.season!.slay_news, archive];
    for (const o of fields) expect(JSON.stringify(o)).not.toMatch(/"(hp|max_?hp|maxHp)"\s*:/);
    // HTTP の順位の表（同じ機械からなので、開催中でも記録の中身まで出る）
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    try {
      const body = await (await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/seasons/${SID}`)).text();
      expect(body).toContain('"wardenStart":{"scar":39}');
      expect(body).not.toMatch(/"(hp|max_?hp|maxHp)"\s*:|始めの体力/);
    } finally {
      await app.close();
    }
    // S6b: 古い形の記録（始めの体力 wardenStart.hp・形に無い項目）が World にあっても、PlayerView には出ない（射影の側で落とす。World は変えない）。
    // 形に合わない記録は渡さない
    const w2 = structuredClone(a.session.world);
    const base = w2.season!.slays![0];
    w2.season!.slays = [
      { ...structuredClone(base), wardenStart: { scar: 39, hp: 461, firesLit: 1 }, secretHp: 461 } as unknown as SeasonSlay,
      { ...structuredClone(base), depth: -1 },
    ];
    const pv = projectPlayerView(w2, a.playerId);
    expect(pv.season!.slays).toHaveLength(1);
    expect(pv.season!.slays![0].wardenStart).toEqual({ scar: 39, firesLit: 1 });
    expect(JSON.stringify(pv.season)).not.toMatch(/"hp"\s*:|secretHp/);
    expect((w2.season!.slays![0].wardenStart as { hp?: number }).hp).toBe(461);
    const ob2 = buildObservation(pv, catalog, { detail: 'full', map: false });
    expect(JSON.stringify(ob2)).not.toMatch(/secretHp|始めの体力/);
    m.closeAll();
  }, 120_000);
});

describe('S5c (SEASON.md §48.11): only your own fight, only what you saw', () => {
  const F = 'main:5';
  const mk = () => {
    let seq = 0;
    const ev = (type: string, floor: string | null, p: Record<string, unknown>) => ({ type, seq: ++seq, cause: seq, floor, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
    const ai = (state: string, intent?: Record<string, unknown>) => ({ archetype: 'melee_chaser', state, targetPos: null, lostTurns: 0, params: {}, ...(intent ? { intent } : {}) });
    const turn = (n: number) => [ev('turn_began', F, { actor: 'e_me0001', time: n }), ev('actor_scheduled', F, { id: 'e_me0001', nextActAt: n + 100, turns: n })];
    const head = (meFloor = F) => [
      ev('player_joined', null, { player: { id: 'p1' }, entity: { id: 'e_me0001', pos: { floor: 'main:1', x: 1, y: 1 } } }),
      ev('expedition_started', null, { expedition: { no: 1 } }),
      ev('entity_changed_floor', meFloor, { id: 'e_me0001', to: { floor: meFloor, x: 1, y: 1 } }),
      ev('entity_spawned', F, { entity: { id: 'e_ward01', kind: 'core:orc_brute', pos: { floor: F, x: 4, y: 1 }, guardian: { name: { ja: '試し', en: 'Trial' }, types: ['core:charger'], warden: true }, actor: { ai: ai('hunting') }, statuses: [] } }),
    ];
    const tail = () => [ev('player_state', null, { player: 'p1', state: 'at_camp' }), ev('expedition_ended', null, { no: 1 })];
    return { ev, ai, turn, head, tail };
  };
  const live = {
    players: { p1: { entityId: 'e_me0001', classId: 'core:warrior', knowledge: { identified: [] } } },
    entities: { e_me0001: { id: 'e_me0001', level: { level: 3, xp: 0 } } },
    secret: { appearances: {} },
  } as unknown as World;
  const none = { world: emptyWorld(), from: Number.MAX_SAFE_INTEGER };

  it('co-op: a charge aimed at an ally and the ally dodging it are not yours; with no blows of your own there is no attempt; blows on another floor do not count', () => {
    const { ev, ai, turn, head, tail } = mk();
    const toAlly = [
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting', { kind: 'winding_up', dir: 'w', hold: { id: 'e_pal0001', turns: 0 } }) }),
      ...turn(1),
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting') }),
      ev('status_applied', F, { target: 'e_ward01', status: { id: 'core:stun', turnsLeft: 1, power: 0 }, statusesAfter: [{ id: 'core:stun', turnsLeft: 1, power: 0 }] }),
      ev('actor_scheduled', F, { id: 'e_ward01', nextActAt: 200, turns: 2 }),
      // 仲間が殴る（自分は殴らない）
      ev('attack', F, { attacker: 'e_pal0001', target: 'e_ward01', hit: true, crit: false }),
      ev('damaged', F, { target: 'e_ward01', via: 'melee', source: 'e_pal0001', amount: 5, dealt: 5 }),
      ...turn(2),
    ];
    expect(buildAttempts([...head(), ...toAlly, ...tail()], none, 'p1', live, 1, incap)).toEqual([]);
    // 自分も 1 回殴った: 挑戦になるが、仲間に向いた構えと仲間の外れは入らない
    const mine = [...head(), ...toAlly, ev('turn_began', F, { actor: 'e_me0001', time: 3 }),
      ev('attack', F, { attacker: 'e_me0001', target: 'e_ward01', hit: true, crit: false }), ev('damaged', F, { target: 'e_ward01', via: 'melee', source: 'e_me0001', amount: 4, dealt: 4 }),
      ev('actor_scheduled', F, { id: 'e_me0001', nextActAt: 400, turns: 3 }), ...tail()].map((e, i) => ({ ...e, seq: i + 1 }) as GameEvent);
    const [a] = buildAttempts(mine, none, 'p1', live, 1, incap);
    expect(a.tells).toEqual([]);
    expect(a.attempt).toBe(1);
    expect(a.dealt.melee).toEqual({ total: 4, n: 1 });
    // 別の階にいる間に仲間が戦った遠征は、挑戦にならない
    const away = [...head('main:4'), ev('attack', F, { attacker: 'e_pal0001', target: 'e_ward01', hit: true, crit: false }), ev('damaged', F, { target: 'e_ward01', via: 'melee', source: 'e_pal0001', amount: 5, dealt: 5 }), ...tail()];
    expect(buildAttempts(away, none, 'p1', live, 1, incap)).toEqual([]);
    // S6a §50.4 の 6: 別の階にいる間に仲間が倒した遠征も、挑んだ回数に数えない（自分の 1 回目の挑戦の後、2 回目の遠征で仲間が倒した: 1 回目の挑戦のまま）
    const slainAway = [...mine,
      ev('expedition_started', null, { expedition: { no: 2 } }),
      ev('player_state', 'main:4', { player: 'p1', state: 'alive', put: [{ id: 'e_me0001', pos: { floor: 'main:4', x: 1, y: 1 } }] }),
      ev('attack', F, { attacker: 'e_pal0001', target: 'e_ward01', hit: true, crit: false }),
      ev('warden_slain', F, { depth: 5, id: 'e_ward01', guardianName: { ja: '試し', en: 'Trial' }, by: 'e_pal0001' }),
    ].map((e, i) => ({ ...e, seq: i + 1 }) as GameEvent);
    expect(buildSlays(slainAway, none, 'p1', live, new Set(), incap)[0].attempt).toBe(1);
    // 同じ階にいれば、倒れた遠征は数える（自分が殴っていなくても）
    const slainHere = [...slainAway.slice(0, -3), ev('entity_changed_floor', F, { id: 'e_me0001', to: { floor: F, x: 1, y: 1 } }), ...slainAway.slice(-2)].map((e, i) => ({ ...e, seq: i + 1 }) as GameEvent);
    expect(buildSlays(slainHere, none, 'p1', live, new Set(), incap)[0].attempt).toBe(2);
  });

  it('a heavy swing aimed at you that misses its blow is not "took"; one that lands is; a rage sign (no target) counts once seen', () => {
    const { ev, ai, turn, head, tail } = mk();
    const swing = (hit: boolean) => [
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting', { kind: 'swinging', pos: { x: 1, y: 1 }, hold: { id: 'e_me0001', turns: 0 } }) }),
      ...turn(1),
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting') }),
      ev('attack', F, { attacker: 'e_ward01', target: 'e_me0001', hit, crit: false }),
      ...(hit ? [ev('damaged', F, { target: 'e_me0001', via: 'melee', source: 'e_ward01', amount: 9, dealt: 9 })] : []),
      ev('actor_scheduled', F, { id: 'e_ward01', nextActAt: 200, turns: 2 }),
    ];
    const h = [...head(), ...swing(false), ...swing(true),
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting', { kind: 'enraging' }) }), ...turn(3),
      ev('ai_state_changed', F, { id: 'e_ward01', ai: ai('hunting') }), ...tail()].map((e, i) => ({ ...e, seq: i + 1 }) as GameEvent);
    const [a] = buildAttempts(h, none, 'p1', live, 1, incap);
    expect(a.tells).toEqual([{ kind: 'swinging', n: 2, seen: 2, missed: 0, hit: 1 }, { kind: 'enraging', n: 1, seen: 1, missed: 0, hit: 0 }]);
    const text = slayObs('ja', catalog, { ...a, by: 'X', of: 1 }).text;
    expect(text).toContain('大振りの構えを 2 回見て、0 回外させ、1 回受けた・怒りの予兆を 1 回見た');
    expect(slayObs('en', catalog, { ...a, by: 'X', of: 1 }).text).toContain('heavy-swing wind-ups: saw 2, 0 missed, 1 hit you; rage signs: saw 1');
  });

  it('a wind-up you could not see (the warden in tall grass) is not counted, nor its miss; the text never says how many you did not see', async () => {
    const m = manager();
    const r = await plainRun(m, 'Eve');
    const wid = await toWarden(r);
    await chargeMiss(r, wid, { grass: true });
    await lifelineHome(r);
    const [a] = r.session.wardenAttempts(r.playerId, r.port.observe().observation.camp!.compare!.no);
    expect(a.tells).toEqual([]);
    expect(a.openings!.missed.turns).toBe(0);
    // 外れた後の朦朧は見えている（草の外。隣）: 殴った手番は「眠りなど」の動けない手番
    expect(a.openings!.other.turns).toBe(1);
    const lines = r.port.observe().observation.camp!.compare!.wardens![0].lines.join('\n');
    expect(lines).not.toMatch(/構えた|見えていた|突進の構え/);
    m.closeAll();
  }, 120_000);

  it('valid_actions offers explore toward:draft / toward:sense only when the command would not refuse at the first step (the same macroProbe)', async () => {
    // 壁に囲まれた部屋で、東の端の 1 マスだけが開いていて、その先がまだ見ていない（境界は東にだけある）
    const a = await arena('s5c-toward', { map: ['P.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId] });
    const f = a.world.floors[a.key];
    const fl = a.world.meta.terrainTable.indexOf('core:floor');
    const i = a.oy * f.width + a.ox + a.W;
    f.terrain[i] = fl;
    a.world.players[a.pid].knowledge.floors[a.key].seen[i] = fl;
    const seen = { draft: new Set<boolean>(), sense: new Set<boolean>() };
    for (const dir of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const) {
      for (const toward of ['draft', 'sense'] as const) {
        const v = projectPlayerView(a.world, a.pid);
        if (toward === 'draft') v.floorHint = { ...(v.floorHint ?? {}), draft: dir } as typeof v.floorHint;
        else v.sense = { what: 'guardian', dir } as typeof v.sense;
        const shown = buildObservation(v, catalog, { detail: 'brief', map: false }).valid_actions.some((l) => l.startsWith(`explore toward:${toward} `));
        const refused = 'stop' in macroProbe(v, { type: 'explore', toward }, catalog).decision;
        expect(shown, `${toward} ${dir}`).toBe(!refused);
        seen[toward].add(shown);
      }
    }
    // 出る方角も、出ない方角もある（その方角に行ける未探索の境界が無い方角では、前は出ていて断られた）
    expect([...seen.draft].sort()).toEqual([false, true]);
    expect([...seen.sense].sort()).toEqual([false, true]);
    a.manager.closeAll();
  }, 60_000);
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

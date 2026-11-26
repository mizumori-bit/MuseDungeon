// S14（SEASON.md §65.2・§65.4）: 続けて遊ばせる。決める所（いつ鳴らすか・止まるか・数え方・2 つのタブ）と、呼び鈴の文字列の添え書き、支度の「進め方」の文。
// 時刻は外から渡す。画面とブラウザ（localStorage・呼び鈴を開く所）は使わない（覚える所は、差し替えた localStorage で確かめる）
import { afterEach, describe, expect, it } from 'vitest';
import { bellUrl } from '../src/ui/bell';
import {
  KG, kgAlive, kgBeat, kgClampN, kgExplainLines, kgForget, kgLastRingText, kgLeader, kgLeft, kgMaybeBlocked, kgOffer, kgOnOpen, kgPortFailed, kgPortFailText, kgPortOk, kgRang, kgRead, kgReadAll, kgRunningText, kgViaText,
  kgStart, kgStep, kgStoppedText, kgStopText, kgWrite, type KgObs, type KgRow, type KgState,
} from '../src/ui/keepGoing';
import { paceLine, paceNote, paceSavedNote } from '../src/ui/prepState';
import { setLocale } from '../src/util';

afterEach(() => setLocale('ja'));

const S = 1000;
const MIN = 60 * S;
const T0 = 1_800_000_000_000;
const base = (o: Partial<KgRow> = {}): KgRow => ({ status: 'at_camp', eligible: true, hold: [], budgetLeft: 2000, continuable: true, ai: { lastCallAgoS: 0, waitingNow: false }, expeditionsEnded: 0, ...o });
const row = (o: Partial<KgRow> = {}): KgObs => ({ kind: 'row', row: base(o) });
const silentFor = (ms: number) => ({ lastCallAgoS: Math.floor(ms / S), waitingNow: false });
const on = (now: number) => ({ now, bellOn: true });
const start = (o: { total?: number; ended?: number } = {}) => kgStart({ runId: 'run_ab12', seasonId: 's5', name: 'ミュゼ美', total: o.total ?? 3, ended: o.ended ?? 0, now: T0 });

/** 鳴らす役のつもりで 1 回: 鳴らすなら、鳴らしたことを覚える */
function tick(st: KgState, obs: KgObs, now: number, blocked = false): { st: KgState; ring: string | null } {
  const r = kgStep(st, obs, on(now));
  return { st: r.ring ? kgRang(r.state, r.ring, now, blocked) : r.state, ring: r.ring };
}

describe('S14 §65.2: when to ring at camp', () => {
  it('30 s after the AI\'s last call; every 2 min at the same camp, 3 times; then stops with "does not wake"', () => {
    let st = start();
    // 呼び出しの直後は、鳴らさない
    let r = tick(st, row({ ai: silentFor(10 * S) }), T0 + 10 * S);
    expect(r.ring).toBeNull();
    // 30 秒たった: 1 回目
    r = tick(r.st, row({ ai: silentFor(30 * S) }), T0 + 30 * S);
    expect(r.ring).toBe('camp');
    expect(r.st.campRings).toBe(1);
    expect(r.st.rings).toBe(1);
    st = r.st;
    // 2 分たつまでは、鳴らさない
    r = tick(st, row({ ai: silentFor(90 * S) }), T0 + 90 * S);
    expect(r.ring).toBeNull();
    r = tick(r.st, row({ ai: silentFor(2 * MIN + 29 * S) }), T0 + 2 * MIN + 29 * S);
    expect(r.ring).toBeNull();
    // 2 回目・3 回目
    r = tick(r.st, row({ ai: silentFor(2 * MIN + 30 * S) }), T0 + 2 * MIN + 30 * S);
    expect(r.ring).toBe('camp');
    r = tick(r.st, row({ ai: silentFor(4 * MIN + 30 * S) }), T0 + 4 * MIN + 30 * S);
    expect(r.ring).toBe('camp');
    expect(r.st.campRings).toBe(3);
    // 3 回鳴らしても、遠征が始まらない: 2 分後に止まる（4 回目は鳴らさない）
    r = tick(r.st, row({ ai: silentFor(5 * MIN + 30 * S) }), T0 + 5 * MIN + 30 * S);
    expect(r.ring).toBeNull();
    expect(r.st.status).toBe('running');
    r = tick(r.st, row({ ai: silentFor(6 * MIN + 30 * S) }), T0 + 6 * MIN + 30 * S);
    expect(r.ring).toBeNull();
    expect(r.st.status).toBe('stopped');
    expect(r.st.stop?.reason).toBe('no_wake');
    expect(kgStoppedText(r.st)).toBe('続けて遊ばせる、は止まった: ミュゼ美が、起きない（同じキャンプで、呼び鈴を 3 回鳴らしても、遠征が始まらなかった）。');
  });

  it('never while the AI is calling or waiting; a never-called AI (since the server started) counts as silent', () => {
    const st = start();
    expect(tick(st, row({ ai: { lastCallAgoS: 600, waitingNow: true } }), T0).ring).toBeNull();
    expect(tick(st, row({ ai: { lastCallAgoS: null, waitingNow: false } }), T0).ring).toBe('camp');
    expect(tick(st, row({ ai: undefined }), T0).ring).toBe('camp');
  });

  it('the AI waking after a ring clears the warning; a new camp starts the count again', () => {
    let r = tick(start(), row({ ai: silentFor(40 * S) }), T0, true);
    expect(r.st.attention).toEqual({ at: T0, where: 'camp' });
    // 鳴らした後に呼び出した（黙っている時間が、鳴らしてからの時間より短い）: 起きた
    r = tick(r.st, row({ ai: silentFor(5 * S) }), T0 + 20 * S);
    expect(r.st.attention).toBeNull();
    // 遠征を始めて、終えて、キャンプに戻った（終わった遠征が 1 つ増えた）: 数え直す
    r = tick(r.st, row({ status: 'in_dungeon', ai: silentFor(3 * S) }), T0 + 5 * MIN);
    r = tick(r.st, row({ expeditionsEnded: 1, ai: silentFor(31 * S) }), T0 + 30 * MIN);
    expect(r.ring).toBe('camp');
    expect(r.st.campKey).toBe(1);
    expect(r.st.campRings).toBe(1);
  });
});

describe('S14 §65.2: in the dungeon, counting, and stopping', () => {
  it('in the dungeon: once after 5 min of silence, once per expedition', () => {
    let r = tick(start(), row({ status: 'in_dungeon', ai: silentFor(4 * MIN) }), T0);
    expect(r.ring).toBeNull();
    r = tick(r.st, row({ status: 'in_dungeon', ai: silentFor(5 * MIN) }), T0 + MIN);
    expect(r.ring).toBe('dungeon');
    r = tick(r.st, row({ status: 'in_dungeon', ai: silentFor(20 * MIN) }), T0 + 20 * MIN);
    expect(r.ring).toBeNull();
    // 次の遠征では、また 1 回
    r = tick(r.st, row({ status: 'in_dungeon', expeditionsEnded: 1, ai: silentFor(6 * MIN) }), T0 + 60 * MIN);
    expect(r.ring).toBe('dungeon');
  });

  it('counts expeditions that ended since it started (one under way counts); stops when the count is reached', () => {
    // キャンプで始めた: あと 2 回
    let st = start({ total: 2, ended: 4 });
    expect(kgLeft(st, 4)).toBe(2);
    let r = tick(st, row({ expeditionsEnded: 5, ai: silentFor(31 * S) }), T0 + 40 * MIN);
    expect(r.ring).toBe('camp');
    expect(kgLeft(r.st, 5)).toBe(1);
    expect(kgRunningText(kgLeft(r.st, 5))).toBe('続けて遊ばせている（あと 1 回）');
    r = tick(r.st, row({ expeditionsEnded: 6, ai: silentFor(31 * S) }), T0 + 80 * MIN);
    expect(r.ring).toBeNull();
    expect(r.st.stop?.reason).toBe('done');
    expect(kgStopText('done', 'ミュゼ美', 2)).toBe('決めた回数（2 回）の遠征が終わった。');
    // 迷宮の中で始めた: その遠征も 1 回に数える
    st = start({ total: 1, ended: 0 });
    r = tick(st, row({ status: 'in_dungeon', ai: silentFor(10 * S) }), T0);
    expect(r.st.status).toBe('running');
    r = tick(r.st, row({ expeditionsEnded: 1, ai: silentFor(40 * S) }), T0 + 20 * MIN);
    expect(r.ring).toBeNull();
    expect(r.st.stop?.reason).toBe('done');
  });

  it('stops: fell or retired, budget, season over, a held item, the bell off, no longer the owner; nothing on a read error', () => {
    const st = start();
    const reason = (obs: KgObs, bellOn = true) => kgStep(st, obs, { now: T0, bellOn }).state.stop?.reason ?? null;
    expect(reason({ kind: 'gone', why: 'ended' })).toBe('ended');
    expect(reason(row({ status: 'ended' }))).toBe('ended');
    expect(reason({ kind: 'gone', why: 'season_over' })).toBe('season_over');
    expect(reason(row({ budgetLeft: 0 }))).toBe('budget');
    expect(reason(row({ continuable: false }))).toBe('season_over');
    // 迷宮の中なら、終わりの時刻を過ぎても、帰るか倒れるまで続ける（continuable はキャンプだけで見る）
    expect(reason(row({ status: 'in_dungeon', continuable: false }))).toBeNull();
    expect(reason(row({ hold: ['perks'] }))).toBe('held');
    expect(reason(row(), false)).toBe('bell_off');
    expect(reason(row({ eligible: false }))).toBe('not_owner');
    expect(kgStep(st, { kind: 'error' }, on(T0)).state).toBe(st);
    // 一覧に無い（持ち主と認められないかもしれない）: 続けて 2 回で止める
    const g1 = kgStep(st, { kind: 'gone', why: 'unknown' }, on(T0)).state;
    expect(g1.status).toBe('running');
    expect(kgStep(g1, row(), on(T0)).state.missing).toBe(0);
    expect(kgStep(g1, { kind: 'gone', why: 'unknown' }, on(T0)).state.stop?.reason).toBe('not_owner');
    // 止まったものは、何もしない
    const stopped = kgStep(st, row({ hold: ['loadout'] }), on(T0)).state;
    expect(kgStep(stopped, row({ ai: silentFor(MIN) }), on(T0 + MIN))).toEqual({ state: stopped, ring: null });
  });
});

describe('S14 §65.4 の 3: where the button shows', () => {
  it('only for an owned AI adventurer with nothing held, with the bell set to call your own tool', () => {
    expect(kgOffer({ row: base(), bellOn: true })).toBe('start');
    expect(kgOffer({ row: base({ status: 'in_dungeon' }), bellOn: true })).toBe('start');
    expect(kgOffer({ row: base({ hold: ['objective'] }), bellOn: true })).toBe('held');
    expect(kgOffer({ row: base(), bellOn: false })).toBeNull();
    expect(kgOffer({ row: null, bellOn: true })).toBeNull();
    expect(kgOffer({ row: base({ eligible: false }), bellOn: true })).toBeNull();
    expect(kgOffer({ row: base({ status: 'ended' }), bellOn: true })).toBeNull();
    expect(kgOffer({ row: base({ oldVersion: true }), bellOn: true })).toBeNull();
    expect(kgOffer({ row: base({ budgetLeft: 0 }), bellOn: true })).toBeNull();
    expect(kgOffer({ row: base({ continuable: false }), bellOn: true })).toBeNull();
    expect(kgClampN(0)).toBe(1);
    expect(kgClampN(11)).toBe(10);
    expect(kgClampN('x')).toBe(KG.N_DEFAULT);
    // リンク: 知らせるので押す・席を外すなら受け口、の 1 行（S14a）。受け口: 自動で鳴らす
    const link = kgExplainLines('ミュゼ美', 'link');
    expect(link).toHaveLength(4);
    expect(link[1]).toContain('AI の利用枠を使う');
    expect(link[1]).toContain('鳴らす時が来たら、知らせるので、押す');
    expect(link[2]).toBe('席を外すなら、運用の画面で、呼び鈴を「この PC の受け口を呼ぶ」にする。');
    const port = kgExplainLines('ミュゼ美', 'port', 47123);
    expect(port).toHaveLength(3);
    expect(port[1]).toContain('自動で鳴らす（この PC の受け口、ポート 47123）');
    expect(port.join('')).not.toContain('席を外すなら');
    expect(kgViaText('port', 47123)).toBe('自動で鳴らす（この PC の受け口、ポート 47123）。');
  });
});

describe('S14 §65.4 の 3: two tabs never ring twice; closing every tab stops it', () => {
  it('the leader is the alive tab with the smallest ID (every tab gets the same answer); stale tabs drop out', () => {
    let tabs = kgBeat({}, 'b', T0);
    tabs = kgBeat(tabs, 'a', T0 + S);
    expect(kgLeader(tabs, T0 + 2 * S)).toBe('a');
    // 2 つのタブが、同じ時に様子を見ても、鳴らすのは 1 つ
    const st = start();
    const rings = ['a', 'b'].filter((me) => kgLeader(tabs, T0 + 40 * S) === me && kgStep(st, row({ ai: silentFor(40 * S) }), on(T0 + 40 * S)).ring);
    expect(rings).toEqual(['a']);
    // a が、閉じるときの知らせ（pagehide）を出さずに消えた: 印が 30 秒より古くなれば、b が鳴らす役になる（捨てるのは 3 分後）
    const t1 = T0 + KG.TAB_FRESH_MS + 5 * S;
    tabs = kgBeat(tabs, 'b', t1);
    expect(kgLeader(tabs, t1)).toBe('b');
    expect(Object.keys(tabs).sort()).toEqual(['a', 'b']);
    // どのタブも隠れていて、時計が遅い（どの印も 30 秒より古い）: 捨てていないタブから選ぶ
    expect(kgLeader({ b: T0, c: T0 - 10 * S }, T0 + 70 * S)).toBe('b');
    const t2 = T0 + KG.TAB_TTL_MS + 5 * S;
    tabs = kgBeat(tabs, 'b', t2);
    expect(kgAlive(tabs, t2)).toEqual(['b']);
    expect(Object.keys(tabs)).toEqual(['b']);
    expect(kgLeader({}, t2)).toBeNull();
  });

  it('a ring written by one tab keeps the other from ringing again soon (the cooldown)', () => {
    const rung = kgRang(start(), 'dungeon', T0, false);
    // 迷宮の中で鳴らした直後に、キャンプに戻っても、60 秒は鳴らさない
    expect(kgStep(rung, row({ expeditionsEnded: 0, ai: silentFor(10 * MIN) }), on(T0 + 30 * S)).ring).toBeNull();
    expect(kgStep(rung, row({ expeditionsEnded: 0, ai: silentFor(10 * MIN) }), on(T0 + KG.RING_COOLDOWN_MS)).ring).toBe('camp');
  });

  it('on opening: no other live tab and not a reload means every tab was closed (it does not restart by itself)', () => {
    const st = start();
    const closed = kgOnOpen(st, { a: T0 - KG.TAB_OPEN_MS - S }, null, T0);
    expect(closed.status).toBe('stopped');
    expect(closed.stop?.reason).toBe('tabs_closed');
    expect(kgStoppedText(closed)).toBe('続けて遊ばせる、は止まっている（タブを閉じたため）。もう一度始める？');
    expect(kgOnOpen(st, {}, null, T0).stop?.reason).toBe('tabs_closed');
    // ほかのタブが生きている・このタブの読み直し: 続ける
    expect(kgOnOpen(st, { a: T0 - 30 * S }, null, T0)).toBe(st);
    expect(kgOnOpen(st, {}, T0 - 5 * S, T0)).toBe(st);
    expect(kgOnOpen(st, {}, T0 - KG.RELOAD_GRACE_MS - S, T0).stop?.reason).toBe('tabs_closed');
    const stopped = { ...st, status: 'stopped' as const, stop: { reason: 'by_owner' as const, at: T0 } };
    expect(kgOnOpen(stopped, {}, null, T0)).toBe(stopped);
    setLocale('en');
    expect(kgStoppedText(closed)).toBe('"Keep them going" is stopped (The tab was closed). Start it again?');
  });
});

describe('S14 §65.4 の 5: the browser may stop the bell', () => {
  it('Chromium lets one such link through per user action: a second launch with no action in between may be stopped', () => {
    expect(kgMaybeBlocked({ activation: null, lastLaunchAt: null, lastInputAt: null })).toBe(false);
    expect(kgMaybeBlocked({ activation: false, lastLaunchAt: T0, lastInputAt: T0 + S })).toBe(false);
    expect(kgMaybeBlocked({ activation: false, lastLaunchAt: T0, lastInputAt: T0 - S })).toBe(true);
    expect(kgMaybeBlocked({ activation: null, lastLaunchAt: T0, lastInputAt: null })).toBe(true);
    expect(kgMaybeBlocked({ activation: true, lastLaunchAt: T0, lastInputAt: null })).toBe(false);
    const r = kgRang(start(), 'camp', T0, true);
    expect(r.attention).toEqual({ at: T0, where: 'camp' });
    expect(r.log).toEqual([{ at: T0, where: 'camp', maybeBlocked: true }]);
    expect(kgLastRingText(r, () => '12:00')).toBe('最後に呼び鈴を鳴らした: 12:00（キャンプ。全部で 1 回）');
  });

  it('S14a: the receiver on this PC needs no action, so it never asks to be pressed; a failed post says the receiver is not running, until it gets through or the AI wakes', () => {
    // 受け口は、止めたかもしれない扱いにしない（光らせない）
    // 鳴らしたキャンプ（終わった遠征 0）
    const p = kgRang({ ...start(), campKey: 0, campRings: 1 }, 'camp', T0, true, 'port');
    expect(p.attention).toBeNull();
    expect(p.log).toEqual([{ at: T0, where: 'camp', maybeBlocked: false, via: 'port' }]);
    const f = kgPortFailed(p, 47123, T0 + S);
    expect(f.portFail).toEqual({ at: T0 + S, port: 47123 });
    expect(f.log.at(-1)).toEqual({ at: T0, where: 'camp', maybeBlocked: false, via: 'port', failed: true });
    expect(kgPortFailText('ミュゼ美', 47123)).toBe('ミュゼ美の呼び鈴を、受け口に送れなかった。受け口が、動いていない（ポート 47123）。受ける道具を起こしてから、「もう一度鳴らす」。');
    expect(kgPortOk(f).portFail).toBeNull();
    // AI が起きた（鳴らした後に呼び出した）: 消える
    expect(kgStep(f, row({ ai: silentFor(0) }), on(T0 + 20 * S)).state.portFail).toBeNull();
    // まだ黙っている: 残る
    expect(kgStep(f, row({ ai: silentFor(5 * MIN) }), on(T0 + 20 * S)).state.portFail).toEqual({ at: T0 + S, port: 47123 });
  });
});

describe('S14 §65.4 の 2: the bell string carries the pace only as one fixed word', () => {
  it('&mode=pilot for pilot; the same string as before for self or none', () => {
    expect(bellUrl('tool', { season: 's5', run: 'run_ab12cd', pace: 'pilot' })).toBe('musedungeon-bell://ready?season=s5&run=run_ab12cd&mode=pilot');
    expect(bellUrl('tool', { season: null, run: 'run_ab12cd', pace: 'pilot' })).toBe('musedungeon-bell://ready?run=run_ab12cd&mode=pilot');
    expect(bellUrl('tool', { season: 's5', run: 'run_ab12cd', pace: 'self' })).toBe('musedungeon-bell://ready?season=s5&run=run_ab12cd');
    expect(bellUrl('tool', { season: 's5', run: 'run_ab12cd', pace: null })).toBe('musedungeon-bell://ready?season=s5&run=run_ab12cd');
    expect(bellUrl('tool', { season: 's5', run: 'run_ab12cd' })).toBe('musedungeon-bell://ready?season=s5&run=run_ab12cd');
    expect(bellUrl('off', { season: 's5', run: 'run_ab12cd', pace: 'pilot' })).toBeNull();
    // 値の形の違う進め方は、添えない（決まった 1 語だけ）
    expect(bellUrl('tool', { season: 's5', run: 'run_ab12cd', pace: 'pilot&x=1' as never })).toBe('musedungeon-bell://ready?season=s5&run=run_ab12cd');
  });

  it('the "How to play" section lines (ja/en)', () => {
    expect(paceLine('self', 'ミュゼ美')).toBe('ミュゼ美が、自分で考えて進む（既定）');
    expect(paceLine(undefined, 'ミュゼ美')).toBe('ミュゼ美が、自分で考えて進む（既定）');
    expect(paceLine('pilot', 'ミュゼ美')).toBe('pilot で進めてほしい、とミュゼ美に伝えている（希望）');
    expect(paceNote('ミュゼ美')).toBe('希望として、ミュゼ美に伝わる。どう進めるかは、ミュゼ美の側が決める。pilot は、AI の側に置く道具（README）');
    expect(paceSavedNote('self', 'ミュゼ美')).toContain('何も伝えない');
    setLocale('en');
    expect(paceLine('pilot', 'Mu')).toBe('You have asked Mu to play with pilot (a wish)');
    expect(paceNote('Mu')).toContain('pilot is a tool kept on the AI\'s side');
  });
});

describe('S14: kept in this browser (localStorage)', () => {
  it('writes, reads, and forgets per run; unreadable entries are dropped', () => {
    const g = globalThis as { window?: unknown };
    const had = Object.getOwnPropertyDescriptor(g, 'window');
    const mem = new Map<string, string>();
    const ls = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k), key: (i: number) => [...mem.keys()][i] ?? null, get length() { return mem.size; } };
    try {
      Object.defineProperty(g, 'window', { value: { localStorage: ls }, configurable: true });
      expect(kgRead('run_ab12')).toBeNull();
      const st = start();
      kgWrite(st);
      expect(kgRead('run_ab12')).toEqual(st);
      // 鍵は覚えない（状態に入るのは、ID・名前・数と時刻だけ）
      expect(JSON.stringify(kgReadAll())).not.toMatch(/token|Bearer/i);
      mem.set('muse.pref.keepGoing', JSON.stringify({ ...JSON.parse(mem.get('muse.pref.keepGoing')!), broken: { v: 2 } }));
      expect(Object.keys(kgReadAll())).toEqual(['run_ab12']);
      kgForget('run_ab12');
      expect(kgRead('run_ab12')).toBeNull();
    } finally {
      if (had) Object.defineProperty(g, 'window', had);
      else delete g.window;
    }
  });
});

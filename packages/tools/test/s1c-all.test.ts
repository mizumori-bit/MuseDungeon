// S1c（SEASON.md §14）のテスト（§14.9）の 2 つ目: すべてのランに同じに効く直し。
// fight の見込み（§14.4 の 1）・引数の名前の断り（§14.4 の 2）・大振りの構え（§14.4 の 3・4）・公開された階段の文（§14.4 の 5）・
// collect と pickup（§14.4 の 6）・遠回りの文・explore toward の止まり方・覚える敵（§14.6 の 1〜3）・数え直し（§14.10 の 1）
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildCatalog } from '@muse/content';
import { createApp, intentStopText, loadConfig, SessionManager } from '@muse/server';
import type { Entity } from '@muse/shared';
import { buildObservation, collectWhatOf, intentOnMe, macroNext, macroStart, projectPlayerView, riskText, threatEstimate } from '@muse/shared';
import { arena, content } from './v33duel';
import { dummyInvoker } from '../src/drive';

const catalog = buildCatalog(content);
type Ar = Awaited<ReturnType<typeof arena>>;
let esid = 996000;
const monAt = (a: Ar, id: string, kind: string, x: number, y: number, state: 'hunting' | 'asleep' | 'unaware', o: { hp?: number; dmg?: string; speed?: number; acc?: number; role?: string; archetype?: string } = {}): Entity => ({
  id, kind, sid: ++esid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y }, ...(o.role ? { role: o.role } : {}),
  actor: { speed: o.speed ?? 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: o.archetype ?? 'melee_chaser', state, targetPos: null, lostTurns: 0, params: {} }, ...(state === 'asleep' ? { dormant: true } : {}) },
  stats: { hp: o.hp ?? 20, maxHp: o.hp ?? 20, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d1' },
  base: { maxHp: o.hp ?? 20, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: o.dmg ?? '1d1' },
  statuses: [],
} as unknown as Entity);
const setMe = (a: Ar, fn: (e: Entity) => void) => { const me = structuredClone(a.world.entities[a.meId]); fn(me); a.inject({ put: [me] }); };
const view = (a: Ar) => projectPlayerView(a.world, a.pid);

describe('S1c §14.4 の 1: the fight estimate (the heaviest at its worst hit, the rest at their average)', () => {
  it('stops and refuses on the expected damage, shows both numbers and the hp_floor actually used', async () => {
    const a = await arena('s1c-risk', { map: ['.....', '..P..', '.....'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 40 } });
    a.inject({ del: [a.gId] });
    a.inject({ put: [monAt(a, 'e_s1cr01', 'core:goblin', 1, 1, 'hunting'), monAt(a, 'e_s1cr02', 'core:goblin', 3, 1, 'hunting')] });
    // 種族の記録: 最大の一撃 10、攻撃された 10 回のうち 5 回当たって合計 20（平均 2。外れは 0）
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 2, kills: 0, maxDamageToYou: 10, maxDamageByYou: 0, abilities: [], hitsOnYou: [5, 10], dmgOnYou: [20, 5, 10] };
    setMe(a, (e) => { e.stats!.hp = 40; });
    const v = view(a);
    const threats = v.entities.filter((e) => e.cat === 'monster');
    expect(threatEstimate(v, catalog, threats)).toEqual({ expected: 12, worst: 20, unrecorded: 0 });
    // 見込み（12）なら HP 40 − 12 = 28 ≥ 25 で続ける。最悪（20）だった今までなら止まっていた（40 − 20 < 25）
    const st = macroStart(v, { type: 'fight', target: 'e_s1cr01', hpFloor: 25 }, catalog);
    const d = macroNext(st, v, catalog, []);
    expect('command' in d).toBe(true);
    // HP 35: 35 − 12 = 23 < 25 で止まる・断る。文に 2 つの数と、渡した hp_floor
    setMe(a, (e) => { e.stats!.hp = 35; });
    const v2 = view(a);
    expect(macroNext(macroStart(v2, { type: 'fight', target: 'e_s1cr01', hpFloor: 25 }, catalog), v2, catalog, [])).toEqual({ stop: 'hp_risk' });
    expect(riskText(v2, catalog, 25)).toContain('見込み 12・最悪 20（HP 35・hp_floor 25');
    const r = await a.r.port.act({ type: 'fight', target: 'e_s1cr01', hpFloor: 25 }, { source: 'bot' });
    expect(!r.ok && r.error.code).toBe('hp_floor');
    expect(!r.ok && r.error.message).toContain('見込みの被害');
    expect(!r.ok && r.error.message).toContain('見込み 12・最悪 20（HP 35・hp_floor 25');
    // 観測: 追跡中 2 体の知らせに 2 つの数。既定の hp_floor の行は「既定」と書く
    const o = buildObservation(v2, catalog, { detail: 'brief', map: false });
    expect(o.alerts.find((x) => x.code === 'incoming')?.text).toContain('1 手の被害の見込み 12・最悪 20');
    expect(o.valid_actions.find((x) => x.startsWith('fight e_s1cr01'))).toContain('以下で止まる（既定の hp_floor。HP の値）');
    // 平均の記録が無い（S1c より前の記録）・0.42.0 の 2 つの欄の記録（攻撃された回数が昔から）: 残りの敵も最大で数える（重い側。S1d §17.2）
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 2, kills: 0, maxDamageToYou: 10, maxDamageByYou: 0, abilities: [] };
    expect(threatEstimate(view(a), catalog, view(a).entities.filter((e) => e.cat === 'monster'))).toEqual({ expected: 20, worst: 20, unrecorded: 0 });
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 2, kills: 0, maxDamageToYou: 10, maxDamageByYou: 0, abilities: [], hitsOnYou: [5, 100], dmgOnYou: [20, 5] };
    expect(threatEstimate(view(a), catalog, view(a).entities.filter((e) => e.cat === 'monster'))).toEqual({ expected: 20, worst: 20, unrecorded: 0 });
    // S1d §17.2: いちばん重い 1 体は会心でない最大の一撃（6）。最悪は会心を含む最大（10）のまま
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 2, kills: 0, maxDamageToYou: 10, maxPlainToYou: 6, maxDamageByYou: 0, abilities: [], hitsOnYou: [5, 10], dmgOnYou: [20, 5, 10] };
    expect(threatEstimate(view(a), catalog, view(a).entities.filter((e) => e.cat === 'monster'))).toEqual({ expected: 8, worst: 20, unrecorded: 0 });
    // 死にうるなら止まる: HP が最悪（20）以下なら、hp_floor が 0 でも止まる・始めない。文に「死にうるので止まった」
    setMe(a, (e) => { e.stats!.hp = 20; });
    const v3 = view(a);
    expect(macroNext(macroStart(v3, { type: 'fight', target: 'e_s1cr01', hpFloor: 0 }, catalog), v3, catalog, [])).toEqual({ stop: 'hp_risk' });
    expect(riskText(v3, catalog, 0)).toContain('死にうるので止まった: HP 20 が最悪 20 以下');
    setMe(a, (e) => { e.stats!.hp = 21; });
    const v4 = view(a);
    expect('command' in macroNext(macroStart(v4, { type: 'fight', target: 'e_s1cr01', hpFloor: 0 }, catalog), v4, catalog, [])).toBe(true);
    expect(riskText(v2, catalog, 25)).toContain('hp_floor で止まった');
    a.manager.closeAll();
  });

  it('the engine records the damage of attacks (not poison) against the number of attacks', async () => {
    const a = await arena('s1c-dmgrec', { map: ['..P..'], guardian: { kind: 'core:goblin', hp: 300, dmg: '2d2', acc: 40, types: [], state: 'hunting' }, player: { hp: 300 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { floor: a.key, x: a.ox + 3, y: a.oy }; delete g.role; delete g.guardian; a.inject({ put: [g] });
    for (let i = 0; i < 12; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const mem = a.world.players[a.pid].knowledge.monsterMemory['core:goblin'];
    const hits = a.r.session.history.filter((e) => e.type === 'damaged' && e.target === a.meId && e.via === 'melee');
    expect(hits.length).toBeGreaterThan(0);
    // [合計, 当たった回数, 攻撃された回数]（S1d §17.2: 攻撃された回数を同じ時から数える）
    expect(mem.dmgOnYou).toEqual([hits.reduce((s, e) => s + (e.type === 'damaged' ? e.amount : 0), 0), hits.length, mem.hitsOnYou![1]]);
    expect(mem.hitsOnYou![0]).toBe(hits.length);
    expect(mem.maxPlainToYou).toBeLessThanOrEqual(mem.maxDamageToYou);
    a.manager.closeAll();
  });
});

describe('S1c §14.4 の 2: wrong argument names get a game-form refusal with the right names', () => {
  it('an unknown name and a missing required argument are refused before the SDK check; the tool list still marks the required arguments', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const url = new URL(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    try {
      await client.callTool({ name: 'new_run', arguments: { character_name: 'Arg', objective: 'reach_depth' } });
      type Res = { content: { text: string }[]; isError?: boolean; structuredContent?: { ok: boolean; error: { code: string; message: string; hint: string }; valid_actions: string[]; turn?: unknown } };
      const bad = await client.callTool({ name: 'travel_to', arguments: { target: 'stairs_down' } }) as unknown as Res;
      expect(bad.isError).toBe(true);
      expect(bad.structuredContent?.error.code).toBe('bad_request');
      // 要る引数が足りない（to）のを先に言い、知らない名前（target）もあわせて書く（S1d §17.1）
      expect(bad.structuredContent?.error.message).toContain('travel_to には to が要る（渡されていない）。travel_to に target という名前の引数は無い。このツールの引数: 要る: to／要らない（任意）: mode・hp_floor・pickup');
      expect(bad.structuredContent?.error.hint).toContain("travel_to { to: 'stairs_down' }");
      expect(bad.structuredContent?.valid_actions.length).toBeGreaterThan(0);
      expect(bad.structuredContent?.turn).toBeDefined();
      const miss = await client.callTool({ name: 'move', arguments: {} }) as unknown as Res;
      expect(miss.structuredContent?.error.message).toContain('move には dir が要る（渡されていない）');
      expect(miss.structuredContent?.error.hint).toContain("move { dir: 'n' }");
      const perk = await client.callTool({ name: 'choose_perk', arguments: { choice: 1 } }) as unknown as Res;
      expect(perk.structuredContent?.error.message).toContain('choose_perk には option が要る（渡されていない）。choose_perk に choice という名前の引数は無い');
      expect(perk.structuredContent?.error.message).toContain('要る: option');
      // 共通の名前（thought・player_token など）は、定義に無いツールでも受ける（S1d §17.1: AI はどのツールにも thought を付ける）
      const okCommon = [
        await client.callTool({ name: 'get_rules', arguments: { topic: 'season', player_token: 'x', thought: 't' } }),
        await client.callTool({ name: 'list_runs', arguments: { thought: 't', map: 'never' } }),
        await client.callTool({ name: 'observe', arguments: { thought: 't' } }),
        await client.callTool({ name: 'inventory', arguments: { thought: 't' } }),
        await client.callTool({ name: 'records', arguments: { thought: 't' } }),
      ] as unknown as Res[];
      for (const r of okCommon) expect(r.structuredContent?.error?.code ?? 'ok', JSON.stringify(r.content?.[0]?.text?.slice(0, 120))).not.toBe('bad_request');
      // 共通でない知らない名前は断り、その値は活動の記録に残さない（名前違いでトークンを渡された場合のため）
      const seen: string[] = [];
      const orig = m.recordActivity.bind(m);
      m.recordActivity = (runId, a) => { seen.push(JSON.stringify(a.args)); orig(runId, a); };
      const leak = await client.callTool({ name: 'wait', arguments: { token: 'secret-value-123' } }) as unknown as Res;
      expect(leak.structuredContent?.error.message).toContain('wait に token という名前の引数は無い');
      expect(seen.some((x) => x.includes('unknown_args'))).toBe(true);
      expect(seen.some((x) => x.includes('secret-value-123'))).toBe(false);
      m.recordActivity = orig;
      // 実際には要る引数（throw_item の target）は、一覧の「要る」に書く
      const thr = await client.callTool({ name: 'throw_item', arguments: { slot: 'a', targte: 'n' } }) as unknown as Res;
      expect(thr.structuredContent?.error.message).toContain('要る: slot・target');
      // 形の違い（型）は、今までどおり SDK が断る
      const typ = await client.callTool({ name: 'move', arguments: { dir: 'north' } }) as unknown as Res;
      expect(typ.isError).toBe(true);
      expect(typ.content[0].text).toContain('Invalid arguments for tool move');
      // 正しい呼び出しは通る
      const ok = await client.callTool({ name: 'wait', arguments: {} }) as unknown as Res;
      expect(ok.isError).toBeFalsy();
      // ツール一覧の「要る引数」は変わらない
      const list = await client.listTools();
      const req = (n: string) => (list.tools.find((x) => x.name === n)?.inputSchema as { required?: string[] }).required ?? [];
      expect(req('travel_to')).toContain('to');
      expect(req('move')).toContain('dir');
      expect(req('choose_perk')).toContain('option');
    } finally {
      await client.close();
      m.closeAll();
      await new Promise<void>((r2) => app.server.close(() => r2()));
    }
  });
});

describe('S1c §14.4 の 3・4: telegraphs', () => {
  it('a fast monster holds its heavy swing until the player has acted once (t1: a fast ogre wound up and swung in one gap, never seen)', async () => {
    const a = await arena('s1c-fastswing', { map: ['..P..'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 300 } });
    a.inject({ del: [a.gId] });
    const ogre = monAt(a, 'e_s1cog1', 'core:ogre', 3, 0, 'hunting', { hp: 300, speed: 300, dmg: '1d2', acc: 60 });
    ogre.actor!.ai!.params = { swingEvery: 3, swingMult: 2 };
    a.inject({ put: [ogre] });
    a.world.players[a.pid].knowledge.monsterMemory['core:ogre'] = { kind: 'core:ogre', encounters: 1, kills: 0, maxDamageToYou: 2, maxDamageByYou: 0, abilities: [] };
    // 構えが見えた手番が、どの大振りの前にも少なくとも 1 回ある
    let seenBeforeSwing = 0, swings = 0;
    for (let i = 0; i < 30; i++) {
      const v = view(a);
      const og = v.entities.find((e) => e.id === 'e_s1cog1');
      const winding = og?.intent?.kind === 'swinging';
      // 構えた相手と手番の数（hold）は、プレイヤーに出さない（S1d §17.4）
      if (og?.intent) expect('hold' in og.intent).toBe(false);
      const n0 = a.r.session.history.length;
      await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      const swung = a.r.session.history.slice(n0).some((e) => e.type === 'monster_acted' && e.id === 'e_s1cog1' && (e.act === 'swing_hit' || e.act === 'swing_missed'));
      if (swung) { swings++; if (winding) seenBeforeSwing++; }
    }
    expect(swings).toBeGreaterThan(0);
    expect(seenBeforeSwing).toBe(swings);
    a.manager.closeAll();
  });

  it('fight stops while a visible windup targets your cell, even one that was there when it started (t1: the warden stunned three times, then swung); the stop says the target cells', async () => {
    const a = await arena('s1c-windup', { map: ['.....', '..P..', '.....'], guardian: { kind: 'core:goblin', hp: 300, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 200 } });
    a.inject({ del: [a.gId] });
    const me = a.world.entities[a.meId].pos!;
    const ogre = monAt(a, 'e_s1cog2', 'core:ogre', 3, 1, 'hunting', { hp: 300 });
    a.inject({ put: [ogre] });
    a.world.players[a.pid].knowledge.monsterMemory['core:ogre'] = { kind: 'core:ogre', encounters: 1, kills: 0, maxDamageToYou: 2, maxDamageByYou: 0, abilities: [] };
    // 視界を作ってから、構えを付ける（テストの中だけの書き換え）
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const og = structuredClone(a.world.entities.e_s1cog2);
    og.pos = { floor: a.key, x: a.ox + 3, y: a.oy + 1 };
    og.actor!.ai = { ...og.actor!.ai!, intent: { kind: 'swinging', pos: { x: me.x, y: me.y } } };
    a.inject({ put: [og] });
    const v = view(a);
    expect(intentOnMe(v, v.self.pos!)).toBe(true);
    const st = macroStart(v, { type: 'fight', target: 'e_s1cog2' }, catalog);
    // 始めの 1 手は出す（構えを見て決めた手）。2 手目からは、構えが自分のマスを的にしている間は止まる
    expect('command' in macroNext(st, v, catalog, [])).toBe(true);
    expect(macroNext(st, v, catalog, [])).toEqual({ stop: 'intent' });
    // 的から外れていれば止まらない
    const off = structuredClone(v);
    off.entities.find((e) => e.id === 'e_s1cog2')!.intent = { kind: 'swinging', pos: { x: me.x, y: me.y + 1 } };
    expect(intentOnMe(off, off.self.pos!)).toBe(false);
    // 止まった文: だれが・打つマス・自分がそこにいるか・外れる一歩
    const text = intentStopText('ja', v, catalog);
    expect(text).toContain(`大振りの構え: 打つマス (${me.x},${me.y})。あなたはそのマスにいる`);
    expect(text).toMatch(/外れる一歩: move [a-z]+/);
    // 突進の構え: 直線の始めと終わり
    const ch = structuredClone(v);
    ch.entities.find((e) => e.id === 'e_s1cog2')!.intent = { kind: 'winding_up', dir: 'w' };
    expect(intentStopText('ja', ch, catalog)).toMatch(/突進の構え: 西の直線 \(\d+,\d+\)〜\(\d+,\d+\)。あなたはその直線の上にいる/);
    a.manager.closeAll();
  });
});

describe('S1c §14.4 の 6: collect and pickup', () => {
  it('kinds matches unidentified items by their category; kinds without what means items; the thrown-only collect says other items remain', async () => {
    const a = await arena('s1c-collect', { map: ['.........'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId] });
    const me = a.world.entities[a.meId].pos!;
    // 未鑑定の薬（区分 potion）を 3 マス先に
    const pot: Entity = { id: 'e_s1cpt1', kind: 'core:potion_haste', sid: ++esid, pos: { floor: a.key, x: me.x + 3, y: me.y }, item: { qty: 1, affixes: [] } } as unknown as Entity;
    a.inject({ put: [pot] });
    a.world.players[a.pid].knowledge.identified = a.world.players[a.pid].knowledge.identified.filter((k) => k !== 'core:potion_haste');
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = view(a);
    expect(v.entities.find((e) => e.id === 'e_s1cpt1')?.kind).toBeNull();
    expect(collectWhatOf({ kinds: ['potion'] })).toBe('items');
    expect(collectWhatOf({})).toBe('thrown');
    const st = macroStart(v, { type: 'collect', kinds: ['potion'] }, catalog);
    const d = macroNext(st, v, catalog, []);
    expect(d).toEqual({ command: { type: 'move', dir: 'e' } });
    // 既定（thrown）: 自分の投げた物だけ。ほかに拾える品があると書く
    const r = await a.r.port.act({ type: 'collect' }, { source: 'bot' });
    expect(!r.ok && r.error.code).toBe('nothing_to_do');
    expect(!r.ok && r.error.hint).toContain("既定の collect は自分が投げた物だけを拾う。ほかの品を拾うなら collect { what: 'items' }");
    a.manager.closeAll();
  });

  it('pickup without item does not take back what you just dropped when something else lies there; with only your dropped item it takes it', async () => {
    const a = await arena('s1c-pickup', { map: ['..P..'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, items: [{ kind: 'core:javelin' }] } });
    a.inject({ del: [a.gId] });
    const jav = view(a).inventory.find((i) => i.kind === 'core:javelin')!;
    expect((await a.r.port.act({ type: 'drop', slot: jav.slot }, { source: 'bot' })).ok).toBe(true);
    const dropped = Object.values(a.world.entities).find((e) => e.kind === 'core:javelin' && e.pos)!;
    expect(dropped.item!.droppedBy).toBe(a.pid);
    // 足元にほかの品（薬）: 引数なしの pickup は薬だけ拾う
    const me = a.world.entities[a.meId].pos!;
    a.inject({ put: [{ id: 'e_s1cpk1', kind: 'core:potion_healing', sid: ++esid, pos: { floor: a.key, x: me.x, y: me.y }, item: { qty: 1, affixes: [] } } as unknown as Entity] });
    expect((await a.r.port.act({ type: 'pickup' }, { source: 'bot' })).ok).toBe(true);
    expect(a.world.entities.e_s1cpk1?.pos).toBeUndefined();
    expect(a.world.entities[dropped.id].pos).toBeDefined();
    // 置いた品だけなら拾う（拾うと droppedBy は消える）
    expect((await a.r.port.act({ type: 'pickup' }, { source: 'bot' })).ok).toBe(true);
    expect(a.world.entities[dropped.id].pos).toBeUndefined();
    expect(a.world.entities[dropped.id].item!.droppedBy).toBeUndefined();
    a.manager.closeAll();
  });
});

describe('S1c §14.6 の 2 (widened in S7): explore toward goes round when no reachable edge lies that way', () => {
  it('widens to the sides and behind when the hinted direction has no edge; flee goes on as before', async () => {
    const a = await arena('s1c-toward', { map: Array.from({ length: 7 }, () => '.'.repeat(30)), guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId] });
    const me = structuredClone(a.world.entities[a.meId]); me.pos = { ...me.pos!, x: a.ox + 15, y: a.oy + 3 }; a.inject({ put: [me] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 西の半分だけ未知にする: 東（風の方角）には境界が無い
    const f = a.world.floors[a.key];
    const fk = a.world.players[a.pid].knowledge.floors[a.key];
    for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) if (x - a.ox < 8) fk.seen[y * f.width + x] = 0;
    const v = view(a);
    const hinted = structuredClone(v);
    hinted.floorHint = { ...(hinted.floorHint ?? { floor: v.floor!.key, explored: 2 }), floor: v.floor!.key, draft: 'e' } as never;
    // S7（SEASON.md §52.3 の 4）: その方角（と両隣）に行ける境界が無ければ、幅を広げる（横 → 後ろ）。ここでは西（後ろ）の境界へ回る
    const st = macroStart(hinted, { type: 'explore', toward: 'draft' }, catalog);
    const d = macroNext(st, hinted, catalog, []);
    expect('command' in d && d.command.type === 'move' && ['w', 'nw', 'sw'].includes(d.command.dir)).toBe(true);
    expect(st.towardWiden?.level).toBe(2);
    expect(['w', 'nw', 'sw']).toContain(st.towardWiden?.dir);
    expect('command' in macroNext(macroStart(hinted, { type: 'explore', toward: 'draft', mode: 'flee' }, catalog), hinted, catalog, [])).toBe(true);
    expect('command' in macroNext(macroStart(hinted, { type: 'explore' }, catalog), hinted, catalog, [])).toBe(true);
    a.manager.closeAll();
  });
});

describe('S1c §14.6 の 3: an unaware guardian at its post is remembered like a sleeper', () => {
  it('keeps blocking (and the 2-cell berth) after it goes out of sight', async () => {
    const a = await arena('s1c-post', { map: Array.from({ length: 5 }, () => '.'.repeat(20)), guardian: { kind: 'core:goblin', hp: 30, dmg: '1d1', types: [], state: 'unaware' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { floor: a.key, x: a.ox + 5, y: a.oy + 2 }; a.inject({ put: [g] });
    const me0 = structuredClone(a.world.entities[a.meId]); me0.pos = { floor: a.key, x: a.ox + 1, y: a.oy + 2 }; a.inject({ put: [me0] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 見えた後、気づいていない（持ち場にいる）ことにする（テストの中だけ）
    const g2 = structuredClone(a.world.entities[a.gId]); g2.pos = { floor: a.key, x: a.ox + 5, y: a.oy + 2 }; g2.actor!.ai = { ...g2.actor!.ai!, state: 'unaware', targetPos: null }; a.inject({ put: [g2] });
    const v = view(a);
    expect(v.entities.find((e) => e.id === a.gId)?.awareness).toBe('unaware');
    const st = macroStart(v, { type: 'travel', to: { x: a.ox + 19, y: a.oy + 2 } }, catalog);
    macroNext(st, v, catalog, []);
    expect(st.sleepers?.some((s) => s.id === a.gId && s.guardian)).toBe(true);
    // 見えなくした見え方: 覚えたまま
    const hid = structuredClone(v);
    hid.entities = hid.entities.filter((e) => e.id !== a.gId);
    hid.visibleCells = hid.visibleCells.filter((i) => i !== g.pos!.y * hid.floor!.width + g.pos!.x);
    macroNext(st, hid, catalog, []);
    expect(st.sleepers?.some((s) => s.id === a.gId)).toBe(true);
    a.manager.closeAll();
  });
});

describe('S1c §14.6 の 1: a long way round a stationary enemy is told', () => {
  it('travel says what it kept away from and how many steps longer the way is (more than 10 steps and twice the shortcut)', async () => {
    // 短い道（y=2 の通路）は、壁のくぼみの毒カビの隣を通る。長い道は上を回る
    const a = await arena('s1c-detour', {
      map: ['#########...##########', '.......P..............', '.####################.', '......................'],
      guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 },
    });
    a.inject({ del: [a.gId] });
    a.inject({ put: [monAt(a, 'e_s1cmd1', 'core:spore_mold', 10, 0, 'unaware', { archetype: 'stationary' })] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = view(a);
    expect(v.entities.some((e) => e.id === 'e_s1cmd1')).toBe(true);
    const goal = { x: a.ox + 12, y: a.oy + 1 };
    const st = macroStart(v, { type: 'travel', to: goal }, catalog);
    const d = macroNext(st, v, catalog, []);
    expect('command' in d).toBe(true);
    expect(st.detour?.extra).toBeGreaterThan(10);
    expect(st.detour?.around).toEqual([{ id: 'e_s1cmd1', name: '毒カビ' }]);
    const r = await a.r.port.act({ type: 'travel', to: goal }, { source: 'bot' });
    expect(r.ok && r.outcome).toMatch(/動かない 毒カビ e_s1cmd1 の隣を通らない道を選んだ（隣を通る近道より \d+ 歩長い）/);
    a.manager.closeAll();
  });
});

describe('S1c §14.10 の 1: travel recounts only for obstacles never seen in the call', () => {
  it('an obstacle that blinks in and out of sight resets the no-progress count once, not every time', async () => {
    const a = await arena('s1c-recount', { map: Array.from({ length: 5 }, () => '.'.repeat(20)), guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    a.inject({ del: [a.gId] });
    a.inject({ put: [monAt(a, 'e_s1crc1', 'core:spore_mold', 10, 0, 'unaware', { archetype: 'stationary' })] });
    setMe(a, (e) => { e.pos = { floor: a.key, x: a.ox + 8, y: a.oy + 2 }; });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = view(a);
    const st = macroStart(v, { type: 'travel', to: { x: a.ox + 19, y: a.oy + 4 } }, catalog);
    const d0 = macroNext(st, v, catalog, []);
    expect('command' in d0).toBe(true);
    const keys = [...(st.obstacleKeys ?? [])];
    expect(keys.some((k) => k.startsWith('s'))).toBe(true);
    // 見えなくなった（記憶も消えた）見え方の後に、また見えても、一度見た印なので数え直さない
    st.bestLen = 5; st.sinceBest = 7;
    st.stationary = [];
    const hidden = structuredClone(v); hidden.entities = hidden.entities.filter((e) => e.id !== 'e_s1crc1');
    hidden.visibleCells = hidden.visibleCells.filter((i) => i !== (a.oy + 0) * hidden.floor!.width + a.ox + 10);
    macroNext(st, hidden, catalog, []);
    const before = st.sinceBest;
    macroNext(st, v, catalog, []);
    expect(st.sinceBest).toBeGreaterThan(before ?? 0);
    expect(st.obstacleKeys).toEqual(expect.arrayContaining(keys));
    a.manager.closeAll();
  });
});

describe('S1d §17.1: the sample agent in drive is not refused', () => {
  it('the dummy invoker (thought on every call) gets through on every call', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const app = createApp(m, m.config);
    await new Promise<void>((res) => app.server.listen(0, '127.0.0.1', () => res()));
    const mcpUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/mcp`;
    try {
      const r = await m.createRun({ name: 'Dum', seed: 's1d-drive', controller: { kind: 'agent', label: 'dummy' }, atCamp: true } as never);
      if ('error' in r) throw new Error(r.error.message);
      const texts: string[] = [];
      const orig = m.recordActivity.bind(m);
      m.recordActivity = (runId, a) => { texts.push(`${a.tool} ${a.text.slice(0, 80)}`); orig(runId, a); };
      const inv = dummyInvoker();
      for (let i = 0; i < 6; i++) await inv.invoke({ event: 'turn', token: r.token, mcpUrl, turn: {} as never, observationText: '', seq: 0 });
      expect(texts.length).toBeGreaterThan(5);
      expect(texts.filter((x) => x.includes('bad_request'))).toEqual([]);
      m.recordActivity = orig;
    } finally {
      m.closeAll();
      await new Promise<void>((r2) => app.server.close(() => r2()));
    }
  });
});

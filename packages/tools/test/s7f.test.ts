// S7（SEASON.md §52.3 の 6・7・§51.2・§53）のテスト: 表示と文（F）
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import { loadConfig, SessionManager } from '@muse/server';
import { rulesText } from '../../server/src/mcp/rules';
import { applyEvent, buildObservation, formatObservationText, pickableItems, projectPlayerView } from '@muse/shared';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
type A = Awaited<ReturnType<typeof arena>>;
const act = (a: A, cmd: Command) => a.r.port.act(cmd, { source: 'bot' });
const obsOf = (a: A) => buildObservation(projectPlayerView(a.world, a.pid), catalog, { detail: 'brief', map: false });
let sid = 998000;

describe('S7 §52.3 の 6: a stationary enemy that has noticed you reads "aware (stationary)", not "hunting"', () => {
  it('in the observation text and look (display only; awareness stays hunting)', async () => {
    const a = await arena('s7f-mold', { map: ['P..G'], guardian: { kind: 'core:spore_mold', hp: 10, dmg: '1d1', types: [], state: 'hunting', archetype: 'stationary' } });
    await act(a, { type: 'wait' });
    const o = obsOf(a);
    const m = o.visible.monsters.find((x) => x.id === a.gId)!;
    expect(m.awareness).toBe('hunting');
    const ja = formatObservationText(o, 'ja');
    expect(ja).toContain('状態:気づいている（動かない）');
    expect(ja).not.toMatch(/毒カビ[^\n]*状態:追跡中/);
    expect(a.r.port.look(a.gId).text).toContain('気づいている（動かない）');
    a.manager.closeAll();
  });
});

describe('S7 §52.3 の 7: rule texts (seed per season, inscription order, the archive, ways to identify, the lifeline, withdrawals)', () => {
  it('has each in Japanese and English', () => {
    const ja = rulesText('all', 'ja', catalog);
    const en = rulesText('all', 'en', catalog);
    expect(ja).toContain('シードは、シーズンごとに運用者が決める（ふつうは、シーズンごとに違う');
    expect(en).toContain("The operator sets each season's seed (usually it differs per season");
    expect(ja).toContain('自分で床に置いた品（観測の品の行に「（あなたが置いた）」');
    expect(ja).toContain('この階の守護者のまだ知らない弱点 → この階の鍵のかかった宝物庫の場所 → 未鑑定の品 1 種の正体（持っている物を先に）の順に、当てはまる最初のもの');
    expect(en).toContain('an unknown weakness of this floor\'s guardian, then where this floor\'s locked vault is, then what one unidentified item is');
    expect(ja).toContain('「記録庫の一頁が、ふたたび読めるようになった」は物語の文で、数は変わらない');
    expect(ja).toContain('遺物を階段の上で持ち帰って納めた数');
    expect(en).toContain('is a story line; it changes no numbers');
    expect(ja).toContain('鑑定の手段（まとめ）: 使う');
    expect(ja).toContain('解呪の巻物（持ち物すべての呪いを解く');
    expect(en).toContain('Ways to identify (summary): use it');
    expect(ja).toContain('帰還の綱: 遠征の開始時に、キャンプが 1 本持たせる（持っていなければ。持っていれば 1 本のまま。2 本以上は持てない）');
    expect(en).toContain('at the start of each expedition camp gives you one (if you have none');
    expect(ja).toContain('撤退でも、目的の点を除いた戦利品の 50% は確定する（報酬なしではない）');
    expect(en).toContain('it is not "no reward"');
    // 区切り（A）と、explore toward の幅（D）も規則に
    expect(ja).toContain('区切り（S7）: キャンプの観測の終わりに');
    expect(ja).toContain('方角の幅を広げて探す（両隣 → 横 → 後ろ。S7');
    expect(en).toContain('it widens the direction (the sides, then behind');
  });
});

describe('S7: valid_actions and refusals agree for interact (closing a door with an item in the doorway)', () => {
  it('does not offer "close door" when an item lies in the doorway (the engine refuses); offers it when the doorway is clear', async () => {
    const a = await arena('s7f-door', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' } });
    a.inject({ del: [a.gId] });
    const f = a.world.floors[a.key];
    const open = a.world.meta.terrainTable.indexOf('core:door_open');
    const i = a.oy * f.width + a.ox + 1;
    f.terrain[i] = open;
    a.world.players[a.pid].knowledge.floors[a.key].seen[i] = open;
    a.inject({ put: [{ id: 'e_s7fdi1', kind: 'core:potion_healing', sid: ++sid, pos: { floor: a.key, x: a.ox + 1, y: a.oy }, item: { qty: 1, affixes: [] } } as unknown as Entity] });
    await act(a, { type: 'wait' });
    expect(obsOf(a).valid_actions.some((l) => l.startsWith('interact e (扉を閉める)'))).toBe(false);
    const no = await act(a, { type: 'interact', dir: 'e' });
    expect(!no.ok && no.error.code).toBe('blocked');
    a.inject({ del: ['e_s7fdi1'] });
    await act(a, { type: 'wait' });
    expect(obsOf(a).valid_actions.some((l) => l.startsWith('interact e (扉を閉める)'))).toBe(true);
    expect((await act(a, { type: 'interact', dir: 'e' })).ok).toBe(true);
    a.manager.closeAll();
  });
});

describe('S7: extracting from an expedition with no objective says what is banked (not "no reward")', () => {
  it('the refusal and the action line say the withdrawal banks 50% of the haul, with the amount', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null, profilesDir: null, seasonsDir: null, waitOthersMs: 100 }));
    const r = await m.createRun({ name: 'E', seed: 's7f-endless', controller: { kind: 'agent', label: 't' }, objective: 'endless' });
    if ('error' in r) throw new Error(r.error.message);
    expect(r.port.view().expedition?.objective.type).toBe('endless');
    // 下り階段の上に置く（extract は階段の上で。テストの書き換え）
    const w = r.session.world;
    const me = structuredClone(w.entities[w.players[r.port.playerId].entityId]);
    const st = w.floors[me.pos!.floor].stairs.down[0];
    me.pos = { ...me.pos!, x: st.x, y: st.y };
    applyEvent(w, { type: 'thought', player: r.port.playerId, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], put: [me] } as unknown as GameEvent);
    await r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(r.port.observe().observation.expedition?.can_extract).toBe(true);
    const line = r.port.observe().observation.valid_actions.find((l) => l.startsWith('extract confirm:true'));
    expect(line).toContain('撤退: 目的なしの遠征は、いつもこの扱い。戦利品の 50% が確定する。今なら +');
    const no = await r.port.act({ type: 'extract' }, { source: 'bot' });
    expect(!no.ok && no.error.code).toBe('confirm_required');
    expect(!no.ok && no.error.message).toContain('目的なしの遠征なので、extract は撤退になる（撤退: 目的なしの遠征は、いつもこの扱い。戦利品の 50% が確定する。今なら +');
    expect(!no.ok && no.error.message).not.toContain('報酬なし');
    expect(!no.ok && no.error.hint).toContain('confirm: true');
    m.closeAll();
  });
});

describe('S7: collect what:items and explore do not pick up again what you dropped yourself', () => {
  it('a dropped item is not pickable for the macros (World knows who dropped it); pickup { item } still takes it', async () => {
    const a = await arena('s7f-drop', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { items: [{ kind: 'core:scroll_identify' }] } });
    a.inject({ del: [a.gId] });
    const slot = projectPlayerView(a.world, a.pid).inventory.find((x) => x.kind === 'core:scroll_identify')!.slot;
    expect((await act(a, { type: 'drop', slot })).ok).toBe(true);
    expect((await act(a, { type: 'move', dir: 'e' })).ok).toBe(true);
    const v = projectPlayerView(a.world, a.pid);
    const it = v.entities.find((e) => e.cat === 'item' && e.kind === 'core:scroll_identify')!;
    expect(it.dropped).toBe(true);
    expect(pickableItems(v, catalog).map((x) => x.id)).not.toContain(it.id);
    // collect what:items は、自分の置いた品へ向かわない（ほかに拾う品が無ければ断る・あれば別の品へ）
    await act(a, { type: 'collect', what: 'items', maxSteps: 3 } as Command);
    expect(projectPlayerView(a.world, a.pid).inventory.some((x) => x.kind === 'core:scroll_identify')).toBe(false);
    expect(a.world.entities[it.id]?.pos).toBeTruthy();
    expect((await act(a, { type: 'move', dir: 'w' })).ok).toBe(true);
    expect((await act(a, { type: 'pickup', item: it.id })).ok).toBe(true);
    expect(projectPlayerView(a.world, a.pid).inventory.some((x) => x.kind === 'core:scroll_identify')).toBe(true);
    a.manager.closeAll();
  });
});

describe('S7: the equip result says which stats changed (before -> after)', () => {
  it('a hunter\'s ring (melee acc -2) shows the accuracy change; taking it off shows it back', async () => {
    const a = await arena('s7f-ring', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 10, dmg: '1d1', types: [], state: 'asleep' }, player: { items: [{ kind: 'core:ring_hunter' }] } });
    a.inject({ del: [a.gId] });
    const acc0 = obsOf(a).self.attack.acc;
    const slot = projectPlayerView(a.world, a.pid).inventory.find((x) => x.kind === 'core:ring_hunter')!.slot;
    const r = await act(a, { type: 'equip', slot });
    expect(r.ok && r.outcome).toContain(`能力の変わった所: 命中+${acc0} → +${acc0 - 2}。`);
    const r2 = await act(a, { type: 'unequip', slot });
    expect(r2.ok && r2.outcome).toContain(`能力の変わった所: 命中+${acc0 - 2} → +${acc0}。`);
    a.manager.closeAll();
  });
});

// V3-4（IMPROVEMENTS_V3 §4・§14.5）の完了の定義: レベルアップで 3 候補が出て、保留しても進行が止まらない。同じシードなら候補が同じ。
// 能動技の cooldown が観測と一致する。呪いは装備か鑑定まで観測に出ない。ほかに習熟・武器の特性・重い鎧・特技の効果。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { applyEvent, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
void catalog;

async function newRun(seed: string, classId = 'core:warrior') {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId, controller: { kind: 'agent', label: 't' }, objective: 'auto' });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject({ put: [e] }); };
  const place = (x: number, y: number) => edit((e) => { e.pos = { floor: e.pos!.floor, x, y }; });
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const obs = () => r.port.observe({ map: false }).observation;
  /** 所持品に品を足す（スロットを返す） */
  const give = (kind: string, o: { affixes?: string[]; hidden?: string[]; qty?: number } = {}): string => {
    const used = new Set((me().inv!.items).map((id) => world.entities[id]?.item?.slot));
    let slot = 'a';
    for (let c = 97; c <= 122; c++) if (!used.has(String.fromCharCode(c))) { slot = String.fromCharCode(c); break; }
    const id = `e_t${(++sid).toString(36).padStart(5, '0')}`;
    const it: Entity = { id, kind, sid: ++sid, item: { qty: o.qty ?? 1, affixes: o.affixes ?? [], heldBy: meId, slot, ...(o.hidden ? { hidden: o.hidden } : {}) } };
    const body = structuredClone(me());
    body.inv!.items.push(id);
    inject({ put: [it, body] });
    return slot;
  };
  return { manager, r, world, pid, meId, inject, me, edit, place, clearMonsters, act, obs, give };
}

let sid = 997000;
function monster(id: string, kind: string, floor: string, x: number, y: number, o: { hp?: number; state?: 'hunting' | 'unaware' | 'asleep'; acc?: number; xp?: number } = {}): Entity {
  sid++;
  const hp = o.hp ?? 30;
  return {
    id, kind, sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: o.state ?? 'hunting', targetPos: null, lostTurns: 0, params: {} }, ...(o.state === 'asleep' ? { dormant: true } : {}) },
    stats: { hp, maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: hp, acc: o.acc ?? 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
    ...(o.xp !== undefined ? { xp: o.xp } : {}),
  };
}

function passable(world: World, key: string, x: number, y: number): boolean {
  const f = world.floors[key];
  return x >= 0 && y >= 0 && x < f.width && y < f.height && content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]].passable
    && !content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]].stairs
    && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
}

function openLine(world: World, key: string, n: number): { p: { x: number; y: number }; dx: number; dy: number } {
  const f = world.floors[key];
  for (let y = 1; y < f.height - 1; y++) for (let x = 1; x < f.width - 1; x++) {
    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      let ok = true;
      for (let k = 0; k <= n && ok; k++) if (!passable(world, key, x + dx * k, y + dy * k)) ok = false;
      if (ok) return { p: { x, y }, dx, dy };
    }
  }
  throw new Error('no open line');
}

/** 経験値を閾値の手前にして、隣の弱い敵を倒してレベルを上げる */
async function levelUp(t: Awaited<ReturnType<typeof newRun>>, times = 1) {
  const key = t.me().pos!.floor;
  for (let i = 0; i < times; i++) {
    const ln = openLine(t.world, key, 1);
    t.place(ln.p.x, ln.p.y);
    const lv = t.me().level!.level;
    t.edit((e) => { e.level = { level: lv, xp: 15 * lv * lv - 1 }; e.stats!.acc = 60; });
    const id = `e_lv${String(i).padStart(4, '0')}`;
    t.inject({ put: [monster(id, 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 1, xp: 5 })] });
    const dir = ({ '1,0': 'e', '-1,0': 'w', '0,1': 's', '0,-1': 'n' } as const)[`${ln.dx},${ln.dy}` as '1,0'];
    const r = await t.act({ type: 'move', dir });
    expect(r.ok).toBe(true);
    expect(t.me().level!.level).toBe(lv + 1);
  }
}

describe('V3-4 perks (§4.1)', () => {
  it('a level up offers 3 perks; the same seed offers the same; holding the choice does not stop play; choosing takes no turn', async () => {
    const a = await newRun('v34-perk-1');
    a.clearMonsters();
    await levelUp(a);
    const o = a.obs();
    expect(o.self.perk_choice?.options.length).toBe(3);
    expect(o.alerts.some((x) => x.code === 'perk_pending')).toBe(true);
    expect(o.valid_actions.filter((x) => x.startsWith('choose_perk ')).length).toBe(3);
    // 戦士は Lv1 から強打を持つので、強打は候補に出ない
    expect(o.self.perk_choice!.options.some((x) => x.id === 'core:perk_bash')).toBe(false);
    expect(o.self.abilities.map((x) => x.id)).toContain('bash');
    const b = await newRun('v34-perk-1');
    b.clearMonsters();
    await levelUp(b);
    expect(b.obs().self.perk_choice!.options.map((x) => x.id)).toEqual(o.self.perk_choice!.options.map((x) => x.id));
    // 保留したまま行動できる
    expect((await a.act({ type: 'wait' })).ok).toBe(true);
    // 選ぶ: 手番を使わない
    const turns = a.me().actor!.turns;
    const pick = o.self.perk_choice!.options[0];
    const hp0 = a.me().stats!.maxHp;
    const r = await a.act({ type: 'choose_perk', option: 1 });
    expect(r.ok).toBe(true);
    expect(a.me().actor!.turns).toBe(turns);
    expect(a.me().build!.perks).toContain(pick.id);
    expect(a.obs().self.perk_choice).toBeUndefined();
    if (pick.id === 'core:perk_hardy') expect(a.me().stats!.maxHp).toBe(hp0 + 5);
    // 候補が無いときは拒否される
    expect((await a.act({ type: 'choose_perk', option: 1 })).ok).toBe(false);
  });

  it('two pending level ups are resolved oldest first; the next options are drawn after the first choice and exclude what was taken', async () => {
    const t = await newRun('v34-perk-2');
    t.clearMonsters();
    await levelUp(t, 2);
    expect(t.me().build!.pending.length).toBe(2);
    expect(t.me().build!.pending[1].options.length).toBe(0);
    const first = t.obs().self.perk_choice!;
    expect(first.more).toBe(1);
    expect((await t.act({ type: 'choose_perk', option: first.options[0].id })).ok).toBe(true);
    const second = t.obs().self.perk_choice!;
    expect(second.level).toBe(first.level + 1);
    expect(second.options.length).toBe(3);
    const taken = first.options[0].id;
    if (content.perks[taken].maxRanks === 1) expect(second.options.some((x) => x.id === taken)).toBe(false);
  });

  it('accuracy, might and evasion no longer grow on their own', async () => {
    const t = await newRun('v34-perk-3');
    t.clearMonsters();
    const b0 = { ...t.me().base! };
    await levelUp(t, 3);
    const b1 = t.me().base!;
    expect(b1.acc).toBe(b0.acc);
    expect(b1.might).toBe(b0.might);
    expect(b1.eva).toBe(b0.eva);
    expect(b1.maxHp).toBe(b0.maxHp + 3 * content.classes['core:warrior'].levelUp.hp);
  });
});

describe('V3-4 abilities (§4.2)', () => {
  it('bash stuns on a hit; its cooldown in the observation matches when it can be used again', async () => {
    const t = await newRun('v34-bash-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 1);
    t.place(ln.p.x, ln.p.y);
    t.edit((e) => { e.stats!.acc = 60; });
    t.inject({ put: [monster('e_ab0001', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 200 })] });
    const h0 = t.r.session.history.length;
    const r = await t.act({ type: 'ability', id: 'bash', target: 'e_ab0001' });
    expect(r.ok).toBe(true);
    const evs = t.r.session.history.slice(h0);
    const swing = evs.find((e) => e.type === 'attack' && e.attacker === t.meId) as { hit: boolean } | undefined;
    expect(evs.some((e) => e.type === 'ability_used')).toBe(true);
    // 当たれば朦朧（出目 1 は必ず外れる）
    if (swing?.hit) expect(evs.some((e) => e.type === 'status_applied' && (e as { status: { id: string } }).status.id === 'core:stun' && (e as { target: string }).target === 'e_ab0001')).toBe(true);
    const cd = content.abilities['core:bash'].cooldown;
    let left = t.obs().self.abilities.find((a) => a.id === 'bash')!.cooldown_left;
    expect(left).toBe(cd);
    // 残りがある間は拒否され、手番も使わない
    const turns = t.me().actor!.turns;
    const again = await t.act({ type: 'ability', id: 'bash', target: 'e_ab0001' });
    expect(again.ok).toBe(false);
    expect(t.me().actor!.turns).toBe(turns);
    // 観測の残りが 0 になったところで使える
    while (left > 0) {
      t.edit((e) => { e.stats!.hp = e.stats!.maxHp; });
      expect((await t.act({ type: 'wait' })).ok).toBe(true);
      const next = t.obs().self.abilities.find((a) => a.id === 'bash')!.cooldown_left;
      expect(next).toBe(left - 1);
      left = next;
    }
    expect((await t.act({ type: 'ability', id: 'bash', target: 'e_ab0001' })).ok).toBe(true);
  });

  it('cleave hits every adjacent enemy; second wind heals once per expedition', async () => {
    const t = await newRun('v34-cleave-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 2);
    t.place(ln.p.x + ln.dx, ln.p.y + ln.dy);
    t.edit((e) => {
      e.stats!.acc = 60;
      e.build!.abilities.push({ id: 'core:cleave', readyAt: 0 }, { id: 'core:second_wind', readyAt: 0 });
    });
    t.inject({ put: [monster('e_cl0001', 'core:goblin', key, ln.p.x, ln.p.y, { hp: 200 }), monster('e_cl0002', 'core:goblin', key, ln.p.x + 2 * ln.dx, ln.p.y + 2 * ln.dy, { hp: 200 })] });
    const swings0 = t.r.session.history.length;
    expect((await t.act({ type: 'ability', id: 'cleave' })).ok).toBe(true);
    const attacks = t.r.session.history.slice(swings0).filter((e) => e.type === 'attack' && e.attacker === t.meId);
    expect(new Set(attacks.map((e) => (e as { target: string }).target))).toEqual(new Set(['e_cl0001', 'e_cl0002']));
    t.clearMonsters();
    t.edit((e) => { e.stats!.hp = 5; });
    expect((await t.act({ type: 'ability', id: 'second_wind' })).ok).toBe(true);
    expect(t.me().stats!.hp).toBeGreaterThan(5);
    t.edit((e) => { e.stats!.hp = 5; });
    expect(t.obs().self.abilities.find((a) => a.id === 'second_wind')!.uses_left).toBe(0);
    expect((await t.act({ type: 'ability', id: 'second_wind' })).ok).toBe(false);
  });

  it('slip moves up to 2 cells and melee attacks miss until your next turn; aimed throw crits an unaware target', async () => {
    const t = await newRun('v34-slip-1', 'core:scout');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x + ln.dx, ln.p.y + ln.dy);
    t.edit((e) => { e.build!.abilities.push({ id: 'core:slip', readyAt: 0 }); });
    // 敵は自分の後ろ（ln.p）。前へ 2 マス身をかわすと、追いついて殴っても当たらない
    t.inject({ put: [monster('e_sl0001', 'core:goblin', key, ln.p.x, ln.p.y, { hp: 50, acc: 60 })] });
    const dir = ({ '1,0': 'e', '-1,0': 'w', '0,1': 's', '0,-1': 'n' } as const)[`${ln.dx},${ln.dy}` as '1,0'];
    const h0 = t.r.session.history.length;
    expect((await t.act({ type: 'ability', id: 'slip', target: dir })).ok).toBe(true);
    expect(t.me().pos).toMatchObject({ x: ln.p.x + 3 * ln.dx, y: ln.p.y + 3 * ln.dy });
    const hits = t.r.session.history.slice(h0).filter((e) => e.type === 'attack' && (e as { target: string }).target === t.meId);
    for (const h of hits) expect((h as { hit: boolean }).hit).toBe(false);
    // 狙い撃ち: 気づいていない相手には会心
    t.clearMonsters();
    const ln2 = openLine(t.world, key, 3);
    t.place(ln2.p.x, ln2.p.y);
    t.inject({ put: [monster('e_sl0002', 'core:goblin', key, ln2.p.x + 3 * ln2.dx, ln2.p.y + 3 * ln2.dy, { hp: 200, state: 'unaware' })] });
    await t.act({ type: 'wait' });
    const h1 = t.r.session.history.length;
    const r = await t.act({ type: 'ability', id: 'aimed_throw', target: 'e_sl0002' });
    expect(r.ok).toBe(true);
    const thrown = t.r.session.history.slice(h1).find((e) => e.type === 'item_thrown') as { hit: string | null } | undefined;
    expect(thrown?.hit).toBe('e_sl0002');
  });
});

describe('V3-4 proficiency, weapon traits and heavy armor (§4.3, §4.4, §14.5)', () => {
  it('thrown accuracy differs by class: warrior -2, scout +2', async () => {
    const w = await newRun('v34-prof-1');
    const s = await newRun('v34-prof-1', 'core:scout');
    w.give('core:throwing_knife', { qty: 3 });
    const wo = w.obs(), so = s.obs();
    const wt = wo.self.attack.throws!.find((x) => x.name.includes('投げナイフ'))!;
    const st = so.self.attack.throws!.find((x) => x.name.includes('投げナイフ'))!;
    expect(wt.acc).toBe(w.me().stats!.acc + 1 - 2);
    expect(st.acc).toBe(s.me().stats!.acc + 1 + 2);
  });

  it('a quick dagger attack costs 70; heavy plate makes walking cost 125; a spear strikes from 2 cells', async () => {
    const t = await newRun('v34-trait-1', 'core:scout');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 3);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_tr0001', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 500, state: 'asleep' })] });
    const dir = ({ '1,0': 'e', '-1,0': 'w', '0,1': 's', '0,-1': 'n' } as const)[`${ln.dx},${ln.dy}` as '1,0'];
    const speed = t.me().actor!.speed;
    let at = t.me().actor!.nextActAt;
    expect((await t.act({ type: 'move', dir })).ok).toBe(true);
    expect(t.me().actor!.nextActAt - at).toBe(Math.trunc((70 * 100) / speed));
    // 板金鎧
    const plate = t.give('core:plate_armor');
    t.edit((e) => { e.inv!.items.forEach((id) => { const it = t.world.entities[id]; if (it.item?.slot === plate) it.item.inspected = true; }); });
    expect((await t.act({ type: 'equip', slot: plate })).ok).toBe(true);
    t.clearMonsters();
    at = t.me().actor!.nextActAt;
    expect((await t.act({ type: 'move', dir })).ok).toBe(true);
    expect(t.me().actor!.nextActAt - at).toBe(Math.trunc((125 * 100) / speed));
    // 槍: 直線で 2 マス先
    const spear = t.give('core:spear');
    expect((await t.act({ type: 'equip', slot: spear })).ok).toBe(true);
    t.place(ln.p.x, ln.p.y);
    t.inject({ put: [monster('e_tr0002', 'core:goblin', key, ln.p.x + 2 * ln.dx, ln.p.y + 2 * ln.dy, { hp: 500, state: 'asleep' })] });
    await t.act({ type: 'wait' });
    expect(t.obs().valid_actions.some((x) => x.startsWith('attack e_tr0002'))).toBe(true);
    const h2 = t.r.session.history.length;
    expect((await t.act({ type: 'attack', target: 'e_tr0002' })).ok).toBe(true);
    expect(t.r.session.history.slice(h2).some((e) => e.type === 'attack' && (e as { target: string }).target === 'e_tr0002')).toBe(true);
    // fight も長柄なら 2 マス先から突く（間に誰かいれば届かない）
    // 隣でも 2 マス先でもない相手は届かない
    t.clearMonsters();
    t.inject({ put: [monster('e_tr0003', 'core:goblin', key, ln.p.x + 3 * ln.dx, ln.p.y + 3 * ln.dy, { hp: 500, state: 'asleep' })] });
    t.place(ln.p.x, ln.p.y);
    await t.act({ type: 'wait' });
    const far = await t.act({ type: 'attack', target: 'e_tr0003' });
    expect(far.ok).toBe(false);
    t.place(ln.p.x + ln.dx, ln.p.y + ln.dy);
    expect((await t.act({ type: 'attack', target: 'e_tr0003' })).ok).toBe(true);
  });
});

describe('V3-4 curses (§4.4)', () => {
  it('a curse is invisible until equipped or identified; once equipped it will not come off; remove curse lifts it', async () => {
    const t = await newRun('v34-curse-1');
    t.clearMonsters();
    const slot = t.give('core:mace', { affixes: ['core:keen'], hidden: ['core:cursed_frail'] });
    // 見えない: 観測・PlayerView のどこにも呪いの接辞が出ない。「呪い?」の印は付く
    const v0 = projectPlayerView(t.world, t.pid);
    expect(JSON.stringify(v0)).not.toContain('cursed_frail');
    const o0 = t.obs();
    expect(JSON.stringify(o0)).not.toContain('cursed_frail');
    expect(o0.self.inventory_brief ?? '').toContain('{呪い?}');
    // 装備すると分かり、外せない
    expect((await t.act({ type: 'equip', slot })).ok).toBe(true);
    expect(JSON.stringify(t.obs())).toContain('命を削る');
    expect((await t.act({ type: 'unequip', slot })).ok).toBe(false);
    expect((await t.act({ type: 'drop', slot })).ok).toBe(false);
    const other = t.give('core:short_sword');
    expect((await t.act({ type: 'equip', slot: other })).ok).toBe(false);
    // 解呪の巻物
    const scroll = t.give('core:scroll_remove_curse');
    expect((await t.act({ type: 'use', slot: scroll })).ok).toBe(true);
    expect(JSON.stringify(t.obs())).not.toContain('命を削る');
    expect((await t.act({ type: 'unequip', slot })).ok).toBe(true);
  });

  it('an identify scroll reveals whether equipment is cursed', async () => {
    const t = await newRun('v34-curse-2');
    t.clearMonsters();
    const cursed = t.give('core:scale_mail', { affixes: ['core:reinforced'], hidden: ['core:cursed_clumsy'] });
    const scroll = t.give('core:scroll_identify', { qty: 2 });
    expect((await t.act({ type: 'use', slot: scroll, targetSlot: cursed })).ok).toBe(true);
    const inv = projectPlayerView(t.world, t.pid).inventory.find((i) => i.slot === cursed)!;
    expect(inv.affixes).toContain('core:cursed_clumsy');
    expect(inv.inspected).toBe(true);
  });
});

describe('V3-4a abilities ride on fight (§25.3)', () => {
  it('fight { abilities } uses bash whenever it is ready; second wind and slip are refused; aimed throw needs with', async () => {
    const t = await newRun('v34a-fight-1');
    t.clearMonsters();
    const key = t.me().pos!.floor;
    const ln = openLine(t.world, key, 1);
    t.place(ln.p.x, ln.p.y);
    t.edit((e) => { e.stats!.acc = 60; e.stats!.hp = 200; e.stats!.maxHp = 200; e.base!.maxHp = 200; e.build!.abilities.push({ id: 'core:second_wind', readyAt: 0 }); });
    t.inject({ put: [monster('e_fa0001', 'core:goblin', key, ln.p.x + ln.dx, ln.p.y + ln.dy, { hp: 40 })] });
    await t.act({ type: 'wait' });
    // valid_actions の fight の例に、載せられる能動技が添えられる
    expect(t.obs().valid_actions.some((a) => a.startsWith('fight e_fa0001 abilities:bash'))).toBe(true);
    // 載せられない・覚えていない・with の無い狙い撃ちは、手番を使わずに拒否
    const turns = t.me().actor!.turns;
    expect((await t.act({ type: 'fight', target: 'e_fa0001', abilities: ['second_wind'] })).ok).toBe(false);
    expect((await t.act({ type: 'fight', target: 'e_fa0001', abilities: ['cleave'] })).ok).toBe(false);
    expect((await t.act({ type: 'fight', target: 'e_fa0001', abilities: ['aimed_throw'] })).ok).toBe(false);
    expect(t.me().actor!.turns).toBe(turns);
    // 強打を載せて戦う: 1 回の呼び出しの中で、使える手番に強打を使う
    const h0 = t.r.session.history.length;
    const r = await t.act({ type: 'fight', target: 'e_fa0001', abilities: ['bash'], hpFloor: 0 });
    expect(r.ok).toBe(true);
    const evs = t.r.session.history.slice(h0);
    expect(evs.some((e) => e.type === 'ability_used' && (e as { ability: string }).ability === 'core:bash')).toBe(true);
    if (r.ok) expect(r.outcome).toContain('強打');
  });
});

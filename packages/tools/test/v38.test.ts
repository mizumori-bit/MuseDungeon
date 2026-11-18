// V3-8（IMPROVEMENTS_V3 §53）の確認: 守護者の重い一撃、深い階の新しい目的（賞金首・宝物庫）、目的でない強敵が去る・異変の文が消える、
// 傷跡、hp_risk の数え直し、collect の絞り込み、投げた物の在りか、目標の宣言を外した、前のランまでの記録の 1 行。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, Expedition, ExpeditionOffer, GameEvent, MonsterMemory } from '@muse/shared';
import { applyEvent, attacksPerTurn } from '@muse/shared';
import { previewOffers } from '@muse/engine';
import { createMcpServer, loadConfig, SessionManager } from '@muse/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 991000;

async function newRun(seed: string) {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const descendTo = async (depth: number) => {
    while (world.floors[me().pos!.floor].depth < depth) {
      const f = world.floors[me().pos!.floor];
      const m = structuredClone(me()); m.pos = { floor: m.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
      inject({ put: [m], del: Object.values(world.entities).filter((e) => e.actor && !e.player && !e.guardian && e.role !== 'elite').map((e) => e.id) });
      await act({ type: 'wait' });
      expect((await act({ type: 'stairs' })).ok).toBe(true);
    }
  };
  /** キャンプの候補を差し替える（この offer で次の遠征を始める） */
  const offer = (o: Partial<ExpeditionOffer> & { objective: ExpeditionOffer['objective'] }) => {
    world.camp!.offers = [{ index: 1, points: 500, relicGuarded: false, slot: 'standard', traits: [], multiplierPct: 100, ...o } as ExpeditionOffer];
  };
  return { manager, r, world, pid, meId, inject, me, act, descendTo, offer };
}

describe('V3-8 heavy blows (§53.1)', () => {
  it('a heavy guardian hit is cut by armor to at most half; a rank 1 guardian is not', async () => {
    for (const heavy of [true, false]) {
      const a = await arena(`v38-heavy-${heavy}`, { map: ['PG'], guardian: { kind: 'core:goblin', hp: 300, dmg: '20', acc: 60, types: [], state: 'hunting' }, player: { hp: 500 } });
      const g = structuredClone(a.world.entities[a.gId]);
      if (heavy) g.guardian!.heavy = true; else delete g.guardian!.heavy;
      const me = structuredClone(a.world.entities[a.meId]);
      me.stats!.armor = 15; me.base!.armor = 15; me.stats!.eva = -50;
      a.inject({ put: [g, me] });
      const n0 = a.r.session.history.length;
      for (let i = 0; i < 6; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      // 会心（気づく前の一撃など）は装甲を無視するので除く
      const hist = a.r.session.history.slice(n0);
      const hits: { amount: number }[] = [];
      let crit = false;
      for (const e of hist) {
        if (e.type === 'attack' && (e as { attacker?: string }).attacker === a.gId) crit = !!(e as { crit?: boolean }).crit;
        if (e.type === 'damaged' && (e as { target?: string }).target === a.meId && (e as { via?: string }).via === 'melee' && !crit) hits.push(e as unknown as { amount: number });
      }
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) expect(h.amount).toBe(heavy ? 10 : 5);
      a.manager.closeAll();
    }
  });
});

describe('V3-8 deep objectives (§53.2)', () => {
  it('deep reach slots draw from reach / bounty / vault; no reach right after a reach', () => {
    const counts: Record<string, number> = {};
    const m = new SessionManager(content, loadConfig({ runsDir: null }));
    return (async () => {
      for (let s = 0; s < 20; s++) {
        const r = await m.createRun({ name: 'O', seed: `v38-offers-${s}`, controller: { kind: 'agent', label: 't' } });
        if ('error' in r) throw new Error(r.error.message);
        const w = r.session.world;
        const pid = r.playerId;
        const lastType = s % 2 ? 'reach_depth' : 'slay_guardian';
        w.expeditions = [{ no: 1, objective: { type: lastType, targetDepth: 8 }, points: 0, relicGuarded: false, status: 'ended', startSeq: 1, endSeq: 2, endReason: 'completed', participants: [pid], start: {}, targets: { guardian: null, relic: null }, progress: { reached: true, guardianSlain: true, relicHeldBy: null }, extracted: [{ player: pid, completed: true }], result: null } as unknown as Expedition];
        w.milestones = { cleared: [5, 10, 15] };
        for (const o of previewOffers(w, content, 2)) {
          if ((o.objective.targetDepth ?? 0) <= 6) continue;
          counts[o.objective.type] = (counts[o.objective.type] ?? 0) + 1;
          if (lastType === 'reach_depth') expect(o.objective.type).not.toBe('reach_depth');
          if (o.objective.type === 'slay_bounty') { expect(o.bounty?.name).toBeTruthy(); expect(o.bounty!.hp).toBeGreaterThan(0); }
          if (o.objective.type === 'open_vault') expect(o.vault).toBe(true);
        }
      }
      expect(counts.slay_bounty ?? 0).toBeGreaterThan(0);
      expect(counts.open_vault ?? 0).toBeGreaterThan(0);
      m.closeAll();
    })();
  });

  it('slay_bounty: the target floor gets the bounty event and the named elite; slaying it completes the objective', async () => {
    const t = await newRun('v38-bounty-1');
    t.offer({ objective: { type: 'slay_bounty', targetDepth: 3 }, bounty: { kind: 'core:orc_brute', name: { ja: 'ギルガ', en: 'Girga' }, affixes: ['core:swift'], kindName: { ja: 'オークの荒くれ', en: 'orc brute' }, affixNames: [{ ja: '俊敏な', en: 'swift' }], hp: 20, maxHit: 10, armor: 1 } });
    expect(t.r.port.observe({ map: false }).text).toContain('賞金首「ギルガ」');
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descendTo(3);
    const x = t.world.expeditions!.at(-1)!;
    const key = t.me().pos!.floor;
    expect(t.world.floors[key].event?.handler).toBe('bounty');
    const b = t.world.entities[x.targets.bounty!];
    expect(b.named?.ja).toBe('ギルガ');
    expect(b.kind).toBe('core:orc_brute');
    t.inject({ del: [b.id] });
    await t.act({ type: 'wait' });
    expect(t.world.expeditions!.at(-1)!.status).toBe('objective_complete');
    t.manager.closeAll();
  });

  it('open_vault: the target floor gets a locked vault; opening its grate completes the objective', async () => {
    const t = await newRun('v38-vault-1');
    t.offer({ objective: { type: 'open_vault', targetDepth: 3 }, vault: true });
    expect(t.r.port.observe({ map: false }).text).toContain('鍵を持つ敵が階にいる');
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descendTo(3);
    const x = t.world.expeditions!.at(-1)!;
    expect(x.targets.vaultLocks).toBeGreaterThan(0);
    const f = t.world.floors[t.me().pos!.floor];
    const li = t.world.meta.terrainTable.indexOf('core:grate_locked');
    const oi = t.world.meta.terrainTable.indexOf('core:grate_open');
    f.terrain[f.terrain.indexOf(li)] = oi;
    await t.act({ type: 'wait' });
    expect(t.world.expeditions!.at(-1)!.status).toBe('objective_complete');
    t.manager.closeAll();
  });
});

describe('V3-8 lingering elites and scars (§53.3)', () => {
  it('a named elite that is not the objective leaves at the next start; its bounty event text goes too', async () => {
    const t = await newRun('v38-elite-1');
    t.offer({ objective: { type: 'reach_depth', targetDepth: 2 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descendTo(2);
    const key = t.me().pos!.floor;
    const f = t.world.floors[key];
    const near = { x: f.stairs.down[0].x, y: f.stairs.down[0].y };
    const el = { id: `e_el${(++sid).toString(36).slice(-4)}`, kind: 'core:goblin', sid: ++sid, role: 'elite', named: { ja: 'ヤラ', en: 'Yara' }, pos: { floor: key, x: near.x, y: near.y + 1 },
      actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'asleep', targetPos: null, lostTurns: 0, params: {}, route: [near, near], routeIdx: 0 }, dormant: true },
      stats: { hp: 30, maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, base: { maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, statuses: [] } as unknown as Entity;
    t.inject({ put: [el] });
    f.event = { id: 'core:event_bounty', handler: 'bounty', arrival: { ja: '大きなもの', en: 'large' } };
    t.world.players[t.pid].knowledge.met.push(el.id);
    const slot = t.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    expect((await t.act({ type: 'use', slot })).ok).toBe(true);
    t.offer({ objective: { type: 'reach_depth', targetDepth: 3 } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    expect(t.world.entities[el.id]).toBeUndefined();
    expect(t.world.floors[key].event).toBeUndefined();
    expect(t.r.session.history.some((e) => e.type === 'guardian_departed' && (e as { elite?: boolean }).elite)).toBe(true);
    t.manager.closeAll();
  });

  it('a quarter of the wound stays on a rematch guardian (shown on the offer); healing at camp stops there', async () => {
    const t = await newRun('v38-scar-1');
    t.offer({ objective: { type: 'slay_guardian', targetDepth: 2 }, guardian: { rank: 2, traits: [], name: { ja: '試し', en: 'Trial' }, types: [] } });
    expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    await t.descendTo(2);
    const key = t.me().pos!.floor;
    const g0 = Object.values(t.world.entities).find((e) => e.pos?.floor === key && e.guardian)!;
    const g = structuredClone(g0);
    const max = 200;
    g.stats!.maxHp = max; g.base!.maxHp = max;
    g.stats!.hp = max - 40;
    t.inject({ put: [g] });
    const slot = t.r.port.view().inventory.find((i) => i.kind === 'core:lifeline')!.slot;
    expect((await t.act({ type: 'use', slot })).ok).toBe(true);
    const re = t.world.camp!.offers.find((o) => o.rechallenge?.guardian === g.id);
    if (re) {
      expect(re.scar).toBe(10);
      expect(t.r.port.observe({ map: false }).text).toContain('傷跡で体力 −10');
      expect((await t.act({ type: 'start_expedition', offer: re.index })).ok).toBe(true);
    } else {
      // 候補の目標階が 2 に当たらなかった: 再挑戦の候補を差し込む（候補の傷跡の表示はここで見る）
      t.offer({ objective: { type: 'slay_guardian', targetDepth: 2 }, rechallenge: { no: 1, guardian: g.id }, guardian: { rank: 2, traits: [], name: { ja: '試し', en: 'Trial' }, types: [] }, scar: 10 });
      expect(t.r.port.observe({ map: false }).text).toContain('傷跡で体力 −10');
      expect((await t.act({ type: 'start_expedition', offer: 1 })).ok).toBe(true);
    }
    const after = t.world.entities[g.id];
    expect(after.scar).toBe(10);
    expect(after.stats!.hp).toBe(max - 10);
    t.manager.closeAll();
  });
});

describe('V3-8 macros (§53.4)', () => {
  it('a fast enemy seen acting twice counts as one attack for the next turns', () => {
    const view = { self: { speed: 100, statuses: [] } } as never;
    const e = (paceAgo?: number) => ({ speed: 120, statuses: [], ...(paceAgo !== undefined ? { paceAgo } : {}) });
    expect(attacksPerTurn(view, catalog, e())).toBe(2);
    expect(attacksPerTurn(view, catalog, e(0))).toBe(1);
    expect(attacksPerTurn(view, catalog, e(2))).toBe(1);
    expect(attacksPerTurn(view, catalog, e(3))).toBe(2);
    expect(attacksPerTurn(view, catalog, { speed: 200, statuses: [], paceAgo: 0 })).toBe(2);
  });

  it('the engine records when a visible monster acted twice in one of your turns', async () => {
    const a = await arena('v38-pace', { map: ['P...G'], guardian: { kind: 'core:jackal', hp: 300, dmg: '1d1', speed: 130, types: [], state: 'unaware' } });
    for (let i = 0; i < 8; i++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    expect(Object.keys(a.world.players[a.pid].knowledge.paceSeen ?? {})).toContain(a.gId);
    a.manager.closeAll();
  });

  it('collect skips items beyond within and filters by kinds', async () => {
    const a = await arena('v38-collect', { map: ['P......................', '.......................'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]); g.pos = { ...g.pos!, x: a.ox + 22, y: a.oy + 1 }; a.inject({ put: [g] });
    const item = (kind: string, x: number, y = 0) => ({ id: `e_it${(++sid).toString(36).slice(-4)}`, kind, sid: ++sid, pos: { floor: a.key, x: a.ox + x, y: a.oy + y }, item: { qty: 1, affixes: [] } }) as unknown as Entity;
    const far = item('core:potion_healing', 6);
    const nearScroll = item('core:scroll_teleport', 1, 1); // 道の脇（通り道の上の品は踏めば拾う）
    a.inject({ put: [far, nearScroll] });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 6 歩先の薬は within 3 では遠い（拒否の文に within を広げる手が出る）
    const r1 = await a.r.port.act({ type: 'collect', what: 'items', kinds: ['potion'], within: 3 }, { source: 'bot' });
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.error.message).toContain('3 歩以内に回収する物が無い');
    expect(a.world.entities[far.id]?.pos).toBeTruthy();
    // 種類で絞る: 薬だけ拾い、手前の巻物は拾わない
    const r2 = await a.r.port.act({ type: 'collect', what: 'items', kinds: ['potion'] }, { source: 'bot' });
    expect(r2.ok).toBe(true);
    expect(a.world.entities[far.id]?.pos).toBeFalsy();
    expect(a.world.entities[nearScroll.id]?.pos).toBeTruthy();
    a.manager.closeAll();
  });

  it('fight with throwables reports what is in hand and on the floor', async () => {
    const a = await arena('v38-throws', { map: ['P.....G'], guardian: { kind: 'core:goblin', hp: 200, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 200, items: [{ kind: 'core:throwing_knife', qty: 3 }] } });
    a.world.players[a.pid].knowledge.monsterMemory['guardian|core:goblin'] = { kind: 'core:goblin', guardian: true, encounters: 1, kills: 0, maxDamageToYou: 1, maxDamageByYou: 0, abilities: [] } as MonsterMemory;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const res = await a.r.port.act({ type: 'fight', target: a.gId, with: 'throwing_knife', retrieve: false }, { source: 'bot' });
    expect(res.ok && res.outcome).toMatch(/投げ物: 手元 \d+・床に \d+/);
    a.manager.closeAll();
  });
});

describe('V3-8 optional macros (§53.4)', () => {
  it('equipping gear known to be cursed asks for confirm', async () => {
    const a = await arena('v38-curse', { map: ['P.G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, items: [{ kind: 'core:leather_armor' }] } });
    const me = a.world.entities[a.meId];
    const id = me.inv!.items.filter((x) => a.world.entities[x]?.kind === 'core:leather_armor').at(-1)!; // 足した方（初期装備ではない）
    const it = structuredClone(a.world.entities[id]);
    it.item!.affixes = ['core:cursed_frail'];
    a.inject({ put: [it] });
    const slot = it.item!.slot!;
    const r1 = await a.r.port.act({ type: 'equip', slot }, { source: 'bot' });
    expect(r1.ok).toBe(false);
    expect(!r1.ok && r1.error.code).toBe('confirm_required');
    const r2 = await a.r.port.act({ type: 'equip', slot, confirm: true }, { source: 'bot' });
    expect(r2.ok).toBe(true);
    expect(a.world.entities[a.meId].equip?.armor).toBe(id);
    a.manager.closeAll();
  });

  it('use_item takes an identified kind id in place of the slot letter', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const [x, y] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ manager, boundToken: null, briefMap: true, clientLabel: 'test' });
    await server.connect(x);
    const client = new Client({ name: 'v38', version: '0' });
    await client.connect(y);
    const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { structuredContent?: Record<string, unknown>; content: { text: string }[] };
    await call('new_run', { character_name: 'K', class: 'warrior', objective: 'auto' });
    const bad = await call('use_item', { slot: 'scroll_magic_mapping' });
    expect(bad.content[0].text).toContain('種類 scroll_magic_mapping の品を持っていない');
    const ok = await call('use_item', { slot: 'lifeline' });
    expect(['at_camp', 'expedition_ended']).toContain((ok.structuredContent?.turn as { state?: string })?.state);
    manager.closeAll();
  });
});

describe('V3-8 goals removed and records first (§53.5)', () => {
  it('no declare_goal; the first camp of a later run starts with the earlier runs\' best', async () => {
    const m = new SessionManager(content, loadConfig({ runsDir: null }));
    const a = await m.createRun({ name: 'A', seed: 'v38-rec-1', controller: { kind: 'agent', label: 't' } });
    if ('error' in a) throw new Error(a.error.message);
    expect(a.port.observe({ map: false }).text).not.toContain('前のランまで');
    expect((await a.port.act({ type: 'retire' }, { source: 'bot' })).ok).toBe(true);
    const b = await m.createRun({ name: 'B', seed: 'v38-rec-2', controller: { kind: 'agent', label: 't' }, profileToken: a.profile.token });
    if ('error' in b) throw new Error(b.error.message);
    const text = b.port.observe({ map: false }).text;
    expect(text).toContain('前のランまで: 確定の最高 0・最深 地下1階（1 ラン）。');
    expect(text).not.toContain('目標:');
    m.closeAll();
  });
});

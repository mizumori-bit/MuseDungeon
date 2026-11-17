// 最後の AI 評価（IMPROVEMENTS_V3 §51）で見つかった不具合の確認: hp_risk の提案が致命の一撃を勧めない、振り返りの最大 HP が特技・加護の
// 変化に追いつく、ソロで「仲間が見つけた」と出ない、守護者として見た種族で steady が止まらない、図鑑の「速い・遅い」。
import { describe, expect, it } from 'vitest';
import { loadContent, buildCatalog } from '@muse/content';
import type { GameEvent, MonsterMemory } from '@muse/shared';
import { buildExpeditionReport, buildRecords, clueText, describeTarget, emptyCodex, filterEventsForPlayer, macroStart, narrate } from '@muse/shared';
import { generateFloor } from '@muse/engine';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);

describe('final AI evaluation fixes (§51)', () => {
  it('hp_risk does not suggest an hp_floor that the next worst turn would kill through', async () => {
    const a = await arena('vfin-risk', { map: ['PG'], guardian: { kind: 'core:goblin', hp: 300, dmg: '22', acc: 50, types: [], state: 'hunting' }, player: { hp: 52 } });
    // この守護者の一撃（22）は記録済み（初被弾では止まらない）
    const pr = a.world.players[a.pid];
    pr.knowledge.monsterMemory['guardian|core:goblin'] = { kind: 'core:goblin', guardian: true, encounters: 1, kills: 0, maxDamageToYou: 22, maxDamageByYou: 0, abilities: [] } as MonsterMemory;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const res = await a.r.port.act({ type: 'fight', target: a.gId, hpFloor: 2 }, { source: 'bot' });
    const hp = a.world.entities[a.meId].stats!.hp;
    expect(res.ok).toBe(true);
    if (res.ok && res.interrupted_by === 'hp_risk' && hp <= 22) {
      expect(res.outcome).not.toMatch(/hp_floor を 0 にすれば/);
      expect(res.outcome).toContain('倒れうる');
    } else {
      // 守護者が外し続けた・別の理由で止まった: 少なくとも「0 にすれば」は出ない
      expect(res.ok ? res.outcome : res.error.message).not.toMatch(/hp_floor を 0 にすれば/);
    }
    a.manager.closeAll();
  });

  it('the report follows max HP changes from perks and boons (own stats_changed is passed to the player)', () => {
    const ev = (o: Record<string, unknown>, seq: number) => ({ seq, cause: null, floor: 'main:1', ft: 0, wall: 0, seenBy: ['p_1'], ...o }) as unknown as GameEvent;
    const events = [
      ev({ type: 'expedition_started', expedition: { no: 1, objective: { type: 'reach_depth', targetDepth: 2 }, self: { turns: 0, hp: 30, maxHp: 30 } } }, 1),
      ev({ type: 'stats_changed', target: 'e_me', statsAfter: { hp: 30, maxHp: 40 }, baseAfter: null, speedAfter: null, reason: 'perk' }, 2),
      ev({ type: 'damaged', target: 'e_me', targetKind: 'core:warrior', amount: 26, dealt: 26, hpAfter: 4, source: 'e_x', sourceKind: 'core:goblin', via: 'melee' }, 3),
    ];
    // 本人の能力値の変化だけが渡る
    const view = { playerId: 'p_1', self: { id: 'e_me' } } as never;
    expect(filterEventsForPlayer([events[1]], 'p_1', view).map((e) => e.type)).toEqual(['stats_changed']);
    const other = ev({ type: 'stats_changed', target: 'e_other', statsAfter: { hp: 1, maxHp: 2 }, baseAfter: null, speedAfter: null, reason: 'perk' }, 4);
    expect(filterEventsForPlayer([other], 'p_1', view)).toEqual([]);
    const r = buildExpeditionReport({ locale: 'ja', catalog, selfId: 'e_me', no: 1, events: filterEventsForPlayer(events, 'p_1', { ...(view as object), self: { id: 'e_me' } } as never), marks: [], calls: [] });
    expect(r.combat.min_hp_pct).toBe(10);
    expect(r.moments.map((m) => m.text).join(' ')).toContain('4/40');
  });

  it('a room you found yourself is not "found by an ally" in a solo run', () => {
    const e = { type: 'room_found', player: 'p_1', floorKey: 'main:3', region: 1, room: 'core:gamble_shrine', name: { ja: '賭けの祭壇', en: 'shrine of chance' }, seq: 1 } as never;
    expect(narrate(e, { locale: 'ja', catalog, selfId: 'e_me', selfPlayerId: 'p_1', playerNames: {} })).toBe('「賭けの祭壇」を見つけた（発見）。');
    expect(narrate(e, { locale: 'ja', catalog, selfId: 'e_me', selfPlayerId: 'p_2', playerNames: {} })).toContain('仲間が');
  });

  it('a species seen only as a guardian counts as known for the macros (steady does not stop on it)', async () => {
    const a = await arena('vfin-kinds', { map: ['P....G'], guardian: { kind: 'core:cave_troll', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    a.world.players[a.pid].knowledge.monsterMemory['guardian|core:cave_troll'] = { kind: 'core:cave_troll', guardian: true, encounters: 1, kills: 0, maxDamageToYou: 0, maxDamageByYou: 0, abilities: [] } as MonsterMemory;
    const st = macroStart(a.r.port.view(), { type: 'explore', mode: 'steady' } as never, catalog) as unknown as { knownKinds: string[] };
    expect(st.knownKinds).toContain('core:cave_troll');
    a.manager.closeAll();
  });

  it('the codex shows "speed varies" instead of "fast, slow"', () => {
    const data = { id: 'prof_x', name: 'P', createdAt: 0, updatedAt: 0, feats: [], runs: [{
      runId: 'r', character: 'C', classId: 'core:scout', legacy: false, legacyKinds: 0, startedAt: 0, endedAt: 1, status: 'ended' as const, end: 'retired' as const, deathCause: null,
      level: 1, banked: 0, deepest: 1, expeditions: 0, completed: 0, withdrawn: 0, wardens: [], streakMax: 0, best: { depth: null, banked: null, margin: null },
      codex: { ...emptyCodex(), species: { 'core:cave_troll': { met: 2, kills: 1, abilities: ['fast', 'slow'] } } },
    }] };
    const idx = { species: [{ id: 'core:cave_troll', name: { ja: '洞窟トロル', en: 'cave troll' } }], items: [], relics: [], guardians: [], fragments: [], rooms: [] };
    const r = buildRecords('ja', data, idx, [], { milestone: null, kindName: (k) => k, abilityName: (x) => (x === 'fast' ? '速い' : x === 'slow' ? '遅い' : x) });
    const d = r.codex.categories[0].entries[0].detail!;
    expect(d).toContain('速さは個体で違う');
    expect(d).not.toContain('速い・遅い');
  });

  it('a warden with its speed floor is not remembered as slow', async () => {
    const a = await arena('vfin-speed', { map: ['P..G'], guardian: { kind: 'core:cave_troll', hp: 50, dmg: '1d1', speed: 100, types: [], state: 'asleep' } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const mem = a.world.players[a.pid].knowledge.monsterMemory['guardian|core:cave_troll'];
    expect(mem?.encounters).toBe(1);
    expect(mem.abilities).not.toContain('slow');
    a.manager.closeAll();
  });

  it('retire tells the run total; a clue narrows when the other candidate is known', async () => {
    const a = await arena('vfin-retire', { map: ['P..G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    const res = await a.r.port.act({ type: 'retire' }, { source: 'bot' });
    expect(res.ok && res.outcome).toContain('ランの確定点の合計 0');
    a.manager.closeAll();
    const clue = catalog.items['core:potion_poison'].clue!;
    expect(clueText('ja', catalog, { identified: [] }, clue)).toBe('刺すような匂い（毒薬か加速の薬）');
    expect(clueText('ja', catalog, { identified: ['core:potion_haste'] }, clue)).toBe('刺すような匂い（毒薬か加速の薬）。加速の薬は判明済みなので、毒薬のはず');
  });

  it('every locked vault grate can be reached from the entry (40 seeds × depth 3–12)', () => {
    const tt = (content.terrain as unknown as { id: string }[]).map((x) => x.id);
    let grates = 0;
    for (let sd = 0; sd < 40; sd++) for (let d = 3; d <= 12; d++) {
      const g = generateFloor(content, `vfin-vault-${sd}`, 'main', d, tt);
      const f = g.floor; const W = f.width, H = f.height;
      const at = (x: number, y: number) => tt[f.terrain[y * W + x]];
      const pass = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && (content.terrain[content.terrainIndex[at(x, y)]].passable || at(x, y).includes('door'));
      const seen = new Set<number>([f.entry.y * W + f.entry.x]);
      const q = [f.entry.y * W + f.entry.x];
      while (q.length) {
        const i = q.pop()!; const x = i % W, y = Math.trunc(i / W);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) { const j = (y + dy) * W + x + dx; if (!seen.has(j) && pass(x + dx, y + dy)) { seen.add(j); q.push(j); } }
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (at(x, y) !== 'core:grate_locked') continue;
        grates++;
        expect([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => seen.has((y + dy) * W + x + dx)), `vfin-vault-${sd} d${d} (${x},${y})`).toBe(true);
      }
    }
    expect(grates).toBeGreaterThan(10);
  }, 120000);

  it('look at a remembered feature out of sight reads it (and the gamble table); a falling ceiling is narrated', async () => {
    const a = await arena('vfin-look', { map: ['P....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' } });
    const v = a.r.port.view();
    const pos = { x: a.ox + 3, y: a.oy + 5 };
    const fk = { ...v, memory: { ...v.memory, remembered: [...v.memory.remembered, { id: 'e_zzzzzz', cat: 'feature' as const, kind: 'core:gamble_altar', appearanceId: null, pos, qty: 1, ft: 0, state: 'ready' }], terrain: v.memory.terrain.map((tv, i) => (i === pos.y * v.floor!.width + pos.x ? tv || 1 : tv)) } };
    const r = describeTarget(fk as never, catalog, pos);
    expect(r.text).toContain('賭けの祭壇');
    expect(r.text).toContain('表:');
    a.manager.closeAll();
    const ev = { type: 'feature_state', id: 'e_c', kind: 'core:brittle_ceiling', state: 'fallen', seq: 1 } as never;
    expect(narrate(ev, { locale: 'ja', catalog, selfId: 'e_me', playerNames: {} })).toContain('天井が崩れ落ちた');
    const dmg = { type: 'damaged', target: 'e_me', targetKind: 'core:warrior', amount: 5, dealt: 5, hpAfter: 10, source: null, sourceKind: null, via: 'effect', seq: 2 } as never;
    expect(narrate(dmg, { locale: 'ja', catalog, selfId: 'e_me', playerNames: {} })).not.toContain('何か');
  });

  it('floor event arrival texts say what they imply (deep sleep: one commotion wakes them all)', () => {
    expect(content.floorEvents['core:event_deep_sleep'].arrival.ja).toContain('目を覚まし');
    expect(content.floorEvents['core:event_glut'].arrival.ja).toContain('宝が多');
  });
});

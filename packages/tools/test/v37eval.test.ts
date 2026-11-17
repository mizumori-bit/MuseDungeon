// V3-3b・V3-7a の後の AI 評価で見つかった不具合の確認: fight の待つ手番に隣の別の敵に殴られる、explore toward:sense は目的だけ、
// 候補の守護者の接辞（見込みと実物が一致する）、投擲が見えない所に落ちた文、大守護者の弱点は記録庫の記憶から、速さの倍率、致死の警告の回復の手段。
// 斥候の報告から: 階段の上の敵、同じ遺物を 2 枠に出さない、品の種類 ID、風の方角から外れた境界を続けて追わない。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, MonsterMemory, ProjectedEvent } from '@muse/shared';
import { applyEvent, macroNext, macroStart, narrate, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { pickRelic } from '@muse/engine';
import { arena } from './v33duel';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 970000;

function goblin(a: Awaited<ReturnType<typeof arena>>, id: string, x: number, y: number, o: { speed?: number } = {}): Entity {
  return {
    id, kind: 'core:goblin', sid: ++sid, pos: { floor: a.key, x, y },
    actor: { speed: o.speed ?? 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp: 30, maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, base: { maxHp: 30, acc: 0, eva: 0, might: 0, armor: 0, sight: 8, dmg: '1d1' }, statuses: [],
  } as Entity;
}

describe('V3-7a evaluation fixes: fight and explore', () => {
  it('a non-target enemy hitting you while fight waits stops it; with until: clear the fight switches to it', async () => {
    const a = await arena('v37e-hit', { map: ['P....G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]);
    delete g.role; delete g.guardian; delete g.home;
    a.inject({ put: [g, goblin(a, 'e_h00001', a.ox + 1, a.oy)] });
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 3, kills: 3, maxDamageToYou: 1, maxDamageByYou: 5, abilities: [], hpSeen: { min: 6, max: 10, samples: 3 } } as MonsterMemory;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const v = projectPlayerView(a.world, a.pid);
    const hitEv = { type: 'attack', seq: 1, cause: null, floor: null, ft: 0, wall: 0, attacker: 'e_h00001', target: v.self.id, hit: true, crit: false, ranged: false } as unknown as ProjectedEvent;
    const st = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 1 }, catalog);
    st.steps = 1; st.waited = true;
    expect(macroNext(st, v, catalog, [hitEv])).toEqual({ stop: 'hit_while_waiting' });
    const st2 = macroStart(v, { type: 'fight', target: a.gId, hpFloor: 1, until: 'clear' }, catalog);
    st2.steps = 1; st2.waited = true;
    const d = macroNext(st2, v, catalog, [hitEv]);
    expect(st2.fightTarget).toBe('e_h00001');
    expect(d).toEqual({ command: { type: 'move', dir: 'e' } });
    a.manager.closeAll();
  });

  it('explore toward: sense ignores a guardian that is not this expedition\'s objective', async () => {
    const a = await arena('v37e-sense', { map: ['P...G', '.....'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100 } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const out = await a.r.port.act({ type: 'explore', toward: 'sense' }, { source: 'bot' });
    // arena の守護者「試し」は遠征の目的の守護者ではない（目的の守護者は名前で見分ける）。部屋が小さいので「未見の区画が無い」で止まる
    expect(!out.ok && out.error.message.includes('気配の元')).toBe(false);
    // 目的の守護者にすると、気配の元として止まる
    const x = a.world.expeditions![a.world.expeditions!.length - 1];
    x.objective = { type: 'slay_guardian', targetDepth: a.world.floors[a.key].depth };
    x.guardianName = { ja: '試し', en: 'Trial' };
    const out2 = await a.r.port.act({ type: 'explore', toward: 'sense' }, { source: 'bot' });
    expect(!out2.ok && out2.error.message.includes('気配の元')).toBe(true);
    a.manager.closeAll();
  });
});

describe('V3-7a evaluation fixes: scout report', () => {
  it('stairs with an enemy standing on them are not offered as a way out', async () => {
    const a = await arena('v37e-stairs', { map: ['P.G', '...'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 100 } });
    const g = structuredClone(a.world.entities[a.gId]);
    delete g.role; delete g.guardian; delete g.home;
    a.inject({ put: [g] });
    const f = a.world.floors[a.key];
    const at = { ...g.pos! };
    f.terrain[at.y * f.width + at.x] = a.world.meta.terrainTable.indexOf('core:stairs_down');
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 3, kills: 3, maxDamageToYou: 1, maxDamageByYou: 5, abilities: [], hpSeen: { min: 6, max: 10, samples: 3 } } as MonsterMemory;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    // 待つ間に寄ってきたので、階段の上へ戻す
    const g2 = structuredClone(a.world.entities[a.gId]); g2.pos = { ...g2.pos!, x: at.x, y: at.y };
    a.inject({ put: [g2] });
    const o = a.r.port.observe({ map: false }).observation;
    const st = o.navigation.known_stairs.find((s) => s.type === 'down');
    expect(st?.occupied_by).toBe(a.gId);
    const line = o.valid_actions.find((l) => l.startsWith('travel_to stairs_down'));
    expect(line).toContain('不可: 階段の上に');
    a.manager.closeAll();
  });

  it('one camp never offers the same relic in two slots', async () => {
    // 同じ番号・別の枠で同じ遺物を引く種を探し、避ける集合を渡すと別の遺物になる
    let found = 0;
    for (let s = 0; s < 60 && found < 3; s++) {
      const a = pickRelic(content, `v37e-relic-${s}`, 5, 0, new Set());
      const b = pickRelic(content, `v37e-relic-${s}`, 5, 2, new Set());
      if (!a || !b || a.kind !== b.kind) continue;
      found++;
      expect(pickRelic(content, `v37e-relic-${s}`, 5, 2, new Set(), new Set([a.kind]))!.kind).not.toBe(a.kind);
    }
    expect(found).toBeGreaterThan(0);
  });

  it('identified items carry their kind ID (usable as fight with)', async () => {
    const a = await arena('v37e-kind', { map: ['P...G'], classId: 'core:scout', guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'asleep' }, player: { hp: 100, items: [{ kind: 'core:javelin', qty: 3 }] } });
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const o = a.r.port.observe({ map: false });
    const jav = o.observation.self.attack.throws?.find((x) => x.kind === 'javelin');
    expect(jav).toBeTruthy();
    expect(o.text).toContain('{with:javelin}');
    const inv = a.r.port.inventory();
    expect(inv.text).toContain('（種類 javelin）');
    a.manager.closeAll();
  });
});

describe('V3-7a evaluation fixes: offers carry the guardian affixes', () => {
  it('the guardian that is placed has the affixes the offer forecast was made from', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    let checked = 0;
    for (let s = 0; s < 12 && checked < 3; s++) {
      const r = await manager.createRun({ name: 'R', seed: `v37e-affix-${s}`, classId: 'core:warrior', controller: { kind: 'agent', label: 't' } });
      if ('error' in r) throw new Error(r.error.message);
      const w = r.session.world;
      const o = w.camp!.offers.find((x) => x.guardianKind);
      if (!o) continue;
      expect(Array.isArray(o.guardianAffixes)).toBe(true);
      // 見込みの特徴は接辞込み（俊敏なら速い、毒牙なら毒）
      if (o.guardianAffixes!.includes('core:swift')) expect(o.guardian!.traits).toContain('fast');
      if (o.guardianAffixes!.includes('core:venomous')) expect(o.guardian!.traits).toContain('poison');
      // プレイヤーには接辞を渡さない
      expect(projectPlayerView(w, r.port.playerId).camp!.offers.find((x) => x.index === o.index)!.guardianAffixes).toBeUndefined();
      // 遠征を始め、目標階まで降りると、置かれた守護者の接辞が候補と同じ
      expect((await r.port.act({ type: 'start_expedition', offer: o.index }, { source: 'bot' })).ok).toBe(true);
      const meId = w.players[r.port.playerId].entityId;
      const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(w, { type: 'thought', player: r.port.playerId, text: '', seq: w.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
      while (w.floors[w.entities[meId].pos!.floor].depth < o.objective.targetDepth!) {
        const f = w.floors[w.entities[meId].pos!.floor];
        const me = structuredClone(w.entities[meId]); me.pos = { floor: me.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
        inject({ put: [me], del: Object.values(w.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
        await r.port.act({ type: 'wait' } as Command, { source: 'bot' });
        expect((await r.port.act({ type: 'stairs' } as Command, { source: 'bot' })).ok).toBe(true);
      }
      const key = w.entities[meId].pos!.floor;
      const gEnt = Object.values(w.entities).find((e) => e.pos?.floor === key && e.role === 'guardian' && e.kind === o.guardianKind && !e.guardian?.warden);
      expect(gEnt).toBeTruthy();
      expect((gEnt!.scale?.affixes ?? []).filter((x) => x !== 'core:guardian').sort()).toEqual([...o.guardianAffixes!].sort());
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    manager.closeAll();
  });
});

describe('V3-7a evaluation fixes: texts', () => {
  it('a throw that lands out of sight says so', () => {
    const ctx = { locale: 'ja' as const, catalog, selfId: 'e_me0001', playerNames: {} };
    const ev = { type: 'item_thrown', seq: 1, cause: null, floor: null, ft: 0, wall: 0, actor: 'e_me0001', actorKind: 'core:warrior', item: 'e_k00001', kind: 'core:throwing_knife', appearanceId: null, from: { x: 1, y: 1 }, to: { x: 9, y: 1 }, landed: null, hit: null, hitKind: null, broke: false, outcome: 'fell_short' } as unknown as ProjectedEvent;
    expect(narrate(ev, ctx)).toBe('あなたは投げナイフを投げた。届かず、見えない所に落ちた。');
  });

  it('monsters show a speed factor; the lethal warning lists your healing', async () => {
    const a = await arena('v37e-speed', { map: ['P.G'], guardian: { kind: 'core:goblin', hp: 50, dmg: '1d1', types: [], state: 'hunting' }, player: { hp: 10, items: [{ kind: 'core:potion_healing', qty: 2 }] } });
    const g = structuredClone(a.world.entities[a.gId]);
    delete g.role; delete g.guardian; delete g.home;
    g.actor!.speed = 80;
    a.inject({ put: [g] });
    a.world.players[a.pid].knowledge.monsterMemory['core:goblin'] = { kind: 'core:goblin', encounters: 3, kills: 3, maxDamageToYou: 12, maxDamageByYou: 5, abilities: [], hpSeen: { min: 6, max: 10, samples: 3 } } as MonsterMemory;
    await a.r.port.act({ type: 'wait' }, { source: 'bot' });
    const o = a.r.port.observe({ map: false });
    const m = o.observation.visible.monsters.find((x) => x.id === a.gId)!;
    expect(m.speed).toBe('slow');
    expect(m.speed_ratio).toBe(0.8);
    expect(o.text).toContain('遅い×0.8');
    const lethal = o.observation.alerts.find((x) => x.code === 'lethal_range');
    expect(lethal?.text).toContain('回復の薬 ');
    a.manager.closeAll();
  });
});

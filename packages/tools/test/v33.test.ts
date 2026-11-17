// V3-3（IMPROVEMENTS_V3 §3.1・§28.9）の完了の定義のうち、型と予備動作・弱点・棲み処・名前:
// 型ごとに「型を読む方針」が「読まない方針」より勝つ、弱点は分かるまで観測に出ない（漏れの試験）、弱点は効いた場面を見ると分かる、
// 予備動作が見える、棲み処の地物と地形、候補は名前と型を出すが弱点と種族は出さない。
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '@muse/content';
import { generateFloor } from '@muse/engine';
import type { Command, Entity, GameEvent, GuardianInfo } from '@muse/shared';
import { applyEvent } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import type { DuelSpec } from './v33duel';
import { arena, content, tally } from './v33duel';
import { MATCHUPS } from './v33policies';

const catalog = buildCatalog(content);
const terrainTable = content.terrain.map((tt) => tt.id);

describe('V3-3 guardian types: reading the type wins more (§11)', () => {
  for (const m of MATCHUPS) {
    it(`${m.type}: the bot that reads the type wins more than the one that does not`, async () => {
      const a = await tally(16, m.naive.spec, m.naive.policy, `duel-${m.type}`);
      const b = await tally(16, m.reader.spec, m.reader.policy, `duel-${m.type}`);
      expect(b.win).toBeGreaterThan(a.win);
    }, 60000);
  }
});

describe('V3-3 offers and names (§3.1)', () => {
  it('offers carry the guardian name and its type, never the weakness or the species; the same seed gives the same guardians', async () => {
    // 最初のキャンプの堅実（格 1・型なし）は到達の目的なので、ここで数えるのは型のある守護者
    let typed = 0;
    for (let i = 0; i < 8; i++) {
      const runs = [];
      for (let k = 0; k < 2; k++) {
        const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
        const r = await manager.createRun({ name: 'R', seed: `v33-offer-${i}`, controller: { kind: 'agent', label: 't' } });
        if ('error' in r) throw new Error(r.error.message);
        runs.push({ manager, r });
      }
      const [{ r }, { r: r2 }] = runs;
      const offers = r.session.world.camp!.offers;
      expect(JSON.stringify(r2.session.world.camp!.offers)).toBe(JSON.stringify(offers));
      for (const o of offers) {
        if (!o.guardian) continue;
        expect(o.guardian.name?.ja).toBeTruthy();
        const want = content.balance.guardian.ranks[o.guardian.rank - 1].types ?? 0;
        expect(o.guardian.types ?? []).toHaveLength(want);
        for (const ty of o.guardian.types ?? []) expect(content.guardianTypes[ty]).toBeTruthy();
        expect(o.guardianWeakness && content.guardianWeaknesses[o.guardianWeakness]).toBeTruthy();
        if (want) typed++;
      }
      const camp = JSON.stringify(r.port.view().camp);
      expect(camp).not.toContain('guardianWeakness');
      expect(camp).not.toContain('core:weak_');
      expect(camp).not.toContain('guardianKind');
      const text = r.port.observe({ map: false }).observation.camp!.offers.map((o) => o.text).join('\n');
      for (const o of offers) if (o.guardian?.name) expect(text).toContain(o.guardian.name.ja);
      for (const w of content.lists.guardianWeaknesses) expect(text).not.toContain(w.name.ja);
      for (const { manager } of runs) manager.closeAll();
    }
    expect(typed).toBeGreaterThan(0);
    // 格 1 にも型を 1 つ付ける（V3-3a §35.5）
    expect(content.balance.guardian.ranks[0].types ?? 0).toBe(1);
  });

  it('the guardian placed by an expedition has the offer’s name, types and weakness; the briefing names it', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    let done = 0;
    for (let i = 0; i < 6; i++) {
      const r = await manager.createRun({ name: 'R', seed: `v33-start-${i}`, controller: { kind: 'agent', label: 't' } });
      if ('error' in r) throw new Error(r.error.message);
      const world = r.session.world;
      const pid = r.port.playerId;
      const meId = world.players[pid].entityId;
      const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
      const o = world.camp!.offers.find((x) => x.objective.type === 'slay_guardian' && (x.guardian?.types ?? []).length > 0);
      if (!o) continue;
      const s = await r.port.act({ type: 'start_expedition', offer: o.index }, { source: 'bot' });
      expect(s.ok).toBe(true);
      if (s.ok) expect((s.briefing ?? []).join('\n')).toContain(o.guardian!.name!.ja);
      const x = world.expeditions![world.expeditions!.length - 1];
      expect(x.guardianName).toEqual(o.guardian!.name);
      expect(x.guardianTypes).toEqual(o.guardian!.types);
      // 目標階まで階段で降りる（守護者は目標階を作るときに置かれる）
      for (let k = 0; k < 6 && !x.targets.guardian; k++) {
        inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
        const me = structuredClone(world.entities[meId]);
        const f = world.floors[me.pos!.floor];
        me.pos = { floor: me.pos!.floor, x: f.stairs.down[0].x, y: f.stairs.down[0].y };
        inject({ put: [me] });
        await r.port.act({ type: 'wait' }, { source: 'bot' });
        await r.port.act({ type: 'stairs' }, { source: 'bot' });
      }
      const g = world.entities[world.expeditions![world.expeditions!.length - 1].targets.guardian!];
      expect(g?.guardian).toBeTruthy();
      expect(g.guardian!.name).toEqual(o.guardian!.name);
      expect(g.guardian!.types).toEqual(o.guardian!.types);
      expect(g.guardian!.weakness).toBe(o.guardianWeakness);
      expect(g.pos!.floor).toBe(`main:${o.objective.targetDepth}`);
      // 遠征の観測: 守護者の名前と型、弱点は知るまで出ない（「弱点: 不明」）。知れば【遠征】の行にも出る
      const ex0 = r.port.observe({ map: false }).observation.expedition!;
      expect(ex0.guardian?.name).toContain(o.guardian!.name!.ja);
      expect(ex0.guardian?.weakness).toBeUndefined();
      expect(ex0.text).toContain('弱点: 不明');
      expect(JSON.stringify(r.port.view())).not.toContain(o.guardianWeakness!);
      applyEvent(world, { type: 'guardian_intel', player: pid, guardian: g.id, guardianName: g.guardian!.name, weakness: g.guardian!.weakness, seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [pid] } as unknown as GameEvent);
      const ex1 = r.port.observe({ map: false }).observation.expedition!;
      expect(ex1.guardian?.weakness?.id).toBe(o.guardianWeakness);
      expect(ex1.text).toContain(content.guardianWeaknesses[o.guardianWeakness!].name.ja);
      done++;
    }
    expect(done).toBeGreaterThan(2);
    manager.closeAll();
  });
});

describe('V3-3 weaknesses stay hidden until they work (§3.1 leak test)', () => {
  const big = { hp: 60, dmg: '1d1', acc: 0 };
  const cases: { w: string; spec: DuelSpec; trigger: (a: Awaited<ReturnType<typeof arena>>) => Promise<void> }[] = [
    {
      w: 'core:weak_thrown',
      spec: { map: ['P...G'], guardian: { kind: 'core:goblin', ...big, types: [], weakness: 'core:weak_thrown', state: 'unaware' }, player: { hp: 60, acc: 20, items: [{ kind: 'core:throwing_knife', qty: 10 }] } },
      trigger: async (a) => {
        const slot = a.r.port.view().inventory.find((i) => i.kind === 'core:throwing_knife')!.slot;
        for (let k = 0; k < 8 && !known(a); k++) await a.r.port.act({ type: 'throw', slot, target: a.gId }, { source: 'bot' });
      },
    },
    {
      w: 'core:weak_poison',
      spec: { map: ['P...G'], guardian: { kind: 'core:goblin', ...big, types: [], weakness: 'core:weak_poison', state: 'unaware' }, player: { hp: 60 } },
      trigger: async (a) => {
        const g = structuredClone(a.world.entities[a.gId]);
        g.statuses = [{ id: 'core:poison', turnsLeft: 5, power: 1, source: null }];
        a.inject({ put: [g] });
        for (let k = 0; k < 4 && !known(a); k++) await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      },
    },
    {
      w: 'core:weak_sleep',
      spec: { map: ['PG'], guardian: { kind: 'core:goblin', ...big, types: [], weakness: 'core:weak_sleep', state: 'asleep' }, player: { hp: 60 } },
      trigger: async (a) => { await a.r.port.act({ type: 'move', dir: 'e' }, { source: 'bot' }); },
    },
    {
      w: 'core:weak_water',
      spec: { map: ['P..~~~', '...~w~', '...~~~'], guardian: { kind: 'core:goblin', ...big, types: [], weakness: 'core:weak_water', state: 'hunting' }, player: { hp: 60 } },
      trigger: async (a) => { for (let k = 0; k < 4 && !known(a); k++) await a.r.port.act({ type: 'wait' }, { source: 'bot' }); },
    },
  ];
  const known = (a: Awaited<ReturnType<typeof arena>>) => !!a.world.players[a.pid].knowledge.guardianIntel?.[a.gId];

  for (const c of cases) {
    it(`${c.w}: not in the view, observation or look before it works; shown after`, async () => {
      const a = await arena(`v33-weak-${c.w}`, c.spec);
      const name = content.guardianWeaknesses[c.w].name.ja;
      // 視界を作る 1 手の間は守護者を眠らせておき（その間に弱点が効かないように）、その後で場面の状態に戻す
      const setState = (state: 'hunting' | 'unaware' | 'asleep') => {
        const g = structuredClone(a.world.entities[a.gId]);
        g.actor!.ai!.state = state;
        if (state === 'asleep') g.actor!.dormant = true; else delete g.actor!.dormant;
        a.inject({ put: [g] });
      };
      setState('asleep');
      await a.r.port.act({ type: 'wait' }, { source: 'bot' });
      setState(c.spec.guardian.state ?? 'hunting');
      // 漏れの試験: 弱点は World には有るが、射影・観測・look のどこにも出ない
      expect(a.world.entities[a.gId].guardian!.weakness).toBe(c.w);
      expect(known(a)).toBe(false);
      const v0 = a.r.port.view();
      expect(JSON.stringify(v0)).not.toContain(c.w);
      expect(v0.entities.find((e) => e.id === a.gId)?.guardian?.weakness).toBeUndefined();
      const o0 = a.r.port.observe({ map: false });
      expect(JSON.stringify(o0.observation)).not.toContain(name);
      expect(o0.text).not.toContain(name);
      const l0 = a.r.port.look(a.gId).text;
      expect(l0).not.toContain(name);
      expect(l0).toContain('弱点: 不明');
      // 効いた場面を見ると分かる
      await c.trigger(a);
      expect(a.world.players[a.pid].knowledge.guardianIntel?.[a.gId]).toBe(c.w);
      const v1 = a.r.port.view();
      expect(v1.entities.find((e) => e.id === a.gId)?.guardian?.weakness).toBe(c.w);
      const m = a.r.port.observe({ map: false }).observation.visible.monsters.find((x) => x.id === a.gId);
      expect(m?.guardian?.weakness?.id).toBe(c.w);
      expect(a.r.port.look(a.gId).text).toContain(name);
      expect(a.r.session.history.some((e) => e.type === 'guardian_intel' && (e as { weakness?: string }).weakness === c.w)).toBe(true);
      a.manager.closeAll();
    });
  }
});

describe('V3-3 intents and type behaviour (§3.1)', () => {
  const wait: Command = { type: 'wait' };

  it('a charger braces on a line (intent with on_line in the observation and alerts), and misses when you step off it', async () => {
    const a = await arena('v33-charge', { map: ['P.....G', '.......'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d4', types: ['core:charger'] }, player: { hp: 40 } });
    await a.r.port.act(wait, { source: 'bot' });
    const ob = a.r.port.observe({ map: false }).observation;
    const m = ob.visible.monsters.find((x) => x.id === a.gId)!;
    expect(m.intent?.code).toBe('winding_up');
    expect(m.intent?.on_line).toBe(true);
    expect(m.intent?.dir).toBe('w');
    expect(ob.alerts.some((x) => x.code === 'intent' && x.entity === a.gId)).toBe(true);
    // 軸をずらす: 直線から外れると突進は外れ、1 手無防備になる
    await a.r.port.act({ type: 'move', dir: 's' }, { source: 'bot' });
    const g = a.world.entities[a.gId];
    expect(g.actor!.ai!.intent).toBeUndefined();
    expect(a.r.session.history.some((e) => e.type === 'guardian_acted' && (e as { act?: string }).act === 'missed')).toBe(true);
    expect(g.statuses?.some((s) => s.id === 'core:stun')).toBe(true);
    a.manager.closeAll();
  });

  it('a summoner shows its intent below 75% and then calls minions', async () => {
    const a = await arena('v33-summon', { map: ['.......', 'P..G...', '.......'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', types: ['core:summoner'] }, player: { hp: 60 } });
    const g = structuredClone(a.world.entities[a.gId]);
    g.stats!.hp = 29;
    a.inject({ put: [g] });
    await a.r.port.act(wait, { source: 'bot' });
    expect(a.r.port.observe({ map: false }).observation.visible.monsters.find((x) => x.id === a.gId)?.intent?.code).toBe('summoning');
    const before = Object.values(a.world.entities).filter((e) => e.pos?.floor === a.key && e.actor && !e.player).length;
    await a.r.port.act(wait, { source: 'bot' });
    const after = Object.values(a.world.entities).filter((e) => e.pos?.floor === a.key && e.actor && !e.player).length;
    expect(after - before).toBe(2);
    expect(a.world.entities[a.gId].guardian!.summoned).toBe(1);
    a.manager.closeAll();
  });

  it('an enrager shows its intent at half HP and then gets faster and stronger', async () => {
    const a = await arena('v33-rage', { map: ['.......', 'P.....G', '.......'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', might: 1, types: ['core:enrager'], state: 'unaware' }, player: { hp: 60 } });
    const g = structuredClone(a.world.entities[a.gId]);
    g.stats!.hp = 20;
    a.inject({ put: [g] });
    const speed0 = g.actor!.speed, might0 = g.stats!.might;
    await a.r.port.act(wait, { source: 'bot' });
    expect(a.r.port.observe({ map: false }).observation.visible.monsters.find((x) => x.id === a.gId)?.intent?.code).toBe('enraging');
    await a.r.port.act(wait, { source: 'bot' });
    const e = a.world.entities[a.gId];
    expect(e.guardian!.enraged).toBe(true);
    expect(e.actor!.speed).toBe(speed0 + 30);
    expect(e.stats!.might).toBe(might0 + 2);
    a.manager.closeAll();
  });

  it('macros stop when a visible enemy newly shows an intent (fight waiting for a charger)', async () => {
    const a = await arena('v33-macro-intent', { map: ['P......G'], guardian: { kind: 'core:goblin', hp: 30, dmg: '1d4', types: ['core:charger'] }, player: { hp: 40 } });
    await a.r.port.act(wait, { source: 'bot' });
    expect(a.world.entities[a.gId].actor!.ai!.intent).toBeUndefined();
    const r = await a.r.port.act({ type: 'fight', target: a.gId }, { source: 'bot' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.interrupted_by).toBe('intent');
    expect(a.world.entities[a.gId].actor!.ai!.intent?.kind).toBe('winding_up');
    a.manager.closeAll();
  });

  it('intents are not shown for enemies you cannot see', async () => {
    const a = await arena('v33-hidden-intent', { map: ['P#....G', '.......'], guardian: { kind: 'core:goblin', hp: 40, dmg: '1d1', types: ['core:summoner'], state: 'unaware' }, player: { hp: 60 } });
    const g = structuredClone(a.world.entities[a.gId]);
    g.actor!.ai!.intent = { kind: 'summoning' };
    a.inject({ put: [g] });
    const v = a.r.port.view();
    const seen = v.entities.find((e) => e.id === a.gId);
    if (seen) expect(seen.intent).toBeDefined();
    else expect(JSON.stringify(v)).not.toContain('summoning');
    a.manager.closeAll();
  });
});

describe('V3-3 lairs (§3.1)', () => {
  const info = (types: string[], weakness: string): GuardianInfo => ({ name: { ja: '試し', en: 'Trial' }, types, weakness });
  const guardianAt = (spawns: ReturnType<typeof generateFloor>['spawns']) => spawns.find((s) => s.type === 'monster' && s.role === 'guardian');

  it('warded lairs get two lit ward fires; charger lairs get pillars; water-slow lairs get shallow water near the guardian', () => {
    const pillar = terrainTable.indexOf('core:pillar');
    const water = terrainTable.indexOf('core:shallow_water');
    let fires = 0, pillars = 0, pools = 0, n = 0;
    for (let i = 0; i < 10; i++) {
      const gw = generateFloor(content, `v33-lair-${i}`, 'main', 3, terrainTable, { guardian: true, relic: false, rank: 2, info: info(['core:warded'], 'core:weak_poison') });
      if (!guardianAt(gw.spawns)) continue;
      n++;
      fires += gw.spawns.filter((s) => s.type === 'feature' && s.kind === 'core:ward_fire').length;
      const gc = generateFloor(content, `v33-lair-${i}`, 'main', 3, terrainTable, { guardian: true, relic: false, rank: 2, info: info(['core:charger'], 'core:weak_water') });
      const s = guardianAt(gc.spawns);
      if (!s || s.type !== 'monster') continue;
      const f = gc.floor;
      for (let y = s.y - 4; y <= s.y + 4; y++) for (let x = s.x - 4; x <= s.x + 4; x++) {
        if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
        if (f.terrain[y * f.width + x] === pillar) pillars++;
        if (f.terrain[y * f.width + x] === water) pools++;
      }
    }
    expect(n).toBeGreaterThan(5);
    expect(fires).toBeGreaterThanOrEqual(n * 2 - 2);
    expect(pillars).toBeGreaterThanOrEqual(n * 2);
    expect(pools).toBeGreaterThanOrEqual(n * 4);
  });

  it('a stalker never sleeps; a deep sleeper always starts asleep', () => {
    for (let i = 0; i < 6; i++) {
      const st = guardianAt(generateFloor(content, `v33-sleep-${i}`, 'main', 3, terrainTable, { guardian: true, relic: false, rank: 2, info: info(['core:stalker'], 'core:weak_sleep') }).spawns);
      if (st?.type === 'monster') expect(st.asleep).toBe(false);
      const ds = guardianAt(generateFloor(content, `v33-sleep-${i}`, 'main', 3, terrainTable, { guardian: true, relic: false, rank: 2, info: info(['core:charger'], 'core:weak_sleep') }).spawns);
      if (ds?.type === 'monster') expect(ds.asleep).toBe(true);
    }
  });
});

describe('V3-3 rules and catalog (§3.1)', () => {
  it('the public catalog lists the types and weaknesses, and nothing per guardian', () => {
    for (const g of content.lists.guardianTypes) expect(catalog.guardianTypes[g.id]?.name.ja).toBe(g.name.ja);
    for (const w of content.lists.guardianWeaknesses) expect(catalog.guardianWeaknesses[w.id]?.name.ja).toBe(w.name.ja);
  });
});

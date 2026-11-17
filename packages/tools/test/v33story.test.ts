// V3-3 の 4 段目（IMPROVEMENTS_V3 §3.4・§16.2・§28.9）: 物語の文。ブリーフィングに 1 文、守護者・大守護者を倒したときと遺物を納めたときに由来の 1 文。
// 文面はデータ（lore.json）。同じシードなら同じ文。伏せている情報（弱点）は文に出ない。get_rules の先頭に世界の枠。
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent } from '@muse/shared';
import { applyEvent, guardianDisplayName } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';
import { rulesText } from '../../server/src/mcp/rules';

const content = loadContent();
const catalog = buildCatalog(content);
const weaknessNames = content.lists.guardianWeaknesses.flatMap((w) => [w.name.ja, w.name.en]);

async function newRun(seed: string, objective?: 'auto' | 'reach_depth' | 'slay_guardian' | 'retrieve_relic') {
  const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
  // objective を省くとキャンプから始まる
  const r = await manager.createRun({ name: 'R', seed, classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, ...(objective ? { objective } : {}) });
  if ('error' in r) throw new Error(r.error.message);
  const world = r.session.world;
  const pid = r.port.playerId;
  const meId = world.players[pid].entityId;
  const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
  const me = () => world.entities[meId];
  const edit = (fn: (e: Entity) => void) => { const e = structuredClone(me()); fn(e); inject({ put: [e] }); };
  const place = (x: number, y: number) => edit((e) => { e.pos = { floor: e.pos!.floor, x, y }; });
  const clearMonsters = () => inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player && !e.guardian).map((e) => e.id) });
  const act = (cmd: Command) => r.port.act(cmd, { source: 'bot' });
  const descend = async () => {
    const f = world.floors[me().pos!.floor];
    place(f.stairs.down[0].x, f.stairs.down[0].y);
    clearMonsters();
    await act({ type: 'wait' });
    const s = await act({ type: 'stairs' });
    clearMonsters();
    return s;
  };
  /** 隣に置いて、体力 1 にして殴り倒す */
  const slay = async (id: string) => {
    const g = structuredClone(world.entities[id]);
    const p = me().pos!;
    g.pos = { floor: p.floor, x: p.x - 1, y: p.y };
    g.stats!.hp = 1;
    g.stats!.eva = -99;
    inject({ put: [g] });
    edit((e) => { e.stats!.acc = 99; e.stats!.hp = 999; e.stats!.maxHp = 999; });
    for (let k = 0; k < 6 && world.entities[id]; k++) await act({ type: 'move', dir: 'w' });
  };
  const stories = () => r.session.history.filter((e) => e.type === 'story') as unknown as { reason: string; line: { ja: string; en: string } }[];
  return { manager, r, world, pid, me, edit, place, clearMonsters, act, descend, slay, stories };
}

describe('V3-3 story lines (§3.4)', () => {
  it('the briefing carries one story sentence from lore.json, filled in, the same for the same seed, never naming the weakness', async () => {
    for (const obj of ['reach_depth', 'slay_guardian', 'retrieve_relic'] as const) {
      const a = await newRun(`v33s-brief-${obj}`, obj);
      const b = await newRun(`v33s-brief-${obj}`, obj);
      const x = a.world.expeditions![0];
      expect(x.story?.ja).toBeTruthy();
      expect(x.story!.ja).not.toMatch(/[{}]/);
      expect(x.story!.en).not.toMatch(/[{}]/);
      expect(b.world.expeditions![0].story).toEqual(x.story);
      const text = a.r.port.briefing('start').join('\n');
      expect(text).toContain(x.story!.ja);
      for (const w of weaknessNames) expect(x.story!.ja + x.story!.en).not.toContain(w);
      if (obj === 'slay_guardian') expect(x.story!.ja).toContain(x.guardianName!.ja);
      if (obj === 'retrieve_relic') expect(x.story!.ja).toContain(x.relic!.name.ja);
      a.manager.closeAll();
      b.manager.closeAll();
    }
  });

  it('a typed guardian gets the line written for its type', async () => {
    let checked = 0;
    for (let i = 0; i < 20 && checked < 2; i++) {
      const t = await newRun(`v33s-type-${i}`);
      const o = t.world.camp?.offers.find((x) => x.objective.type === 'slay_guardian' && (x.guardian?.types ?? []).length);
      if (!o) { t.manager.closeAll(); continue; }
      expect((await t.act({ type: 'start_expedition', offer: o.index })).ok).toBe(true);
      const x = t.world.expeditions![t.world.expeditions!.length - 1];
      const typed = content.lists.lore.find((l) => l.kind === 'briefing' && l.when.objective === 'slay_guardian' && l.when.guardianType === o.guardian!.types![0]);
      if (typed) {
        const want = typed.text.ja.replace('{depth}', String(o.objective.targetDepth)).replace('{guardian}', guardianDisplayName('ja', { name: o.guardian!.name!, ...(o.guardian!.title ? { title: o.guardian!.title } : {}) }));
        expect(x.story!.ja).toBe(want);
        checked++;
      }
      t.manager.closeAll();
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('slaying the expedition guardian and delivering a relic each tell one line; the relic line carries its origin', async () => {
    const t = await newRun('v33s-slay-1', 'slay_guardian');
    const x = t.world.expeditions![0];
    while (t.world.floors[t.me().pos!.floor].depth < x.objective.targetDepth!) expect((await t.descend()).ok).toBe(true);
    const gid = t.world.expeditions![0].targets.guardian!;
    await t.slay(gid);
    const s1 = t.stories().filter((s) => s.reason === 'guardian_slain');
    expect(s1).toHaveLength(1);
    expect(s1[0].line.ja).toContain(x.guardianName!.ja);
    t.manager.closeAll();

    const u = await newRun('v33s-relic-1', 'retrieve_relic');
    const y = u.world.expeditions![0];
    while (u.world.floors[u.me().pos!.floor].depth < y.objective.targetDepth!) expect((await u.descend()).ok).toBe(true);
    const relic = Object.values(u.world.entities).find((e) => e.role === 'relic' && e.pos?.floor === u.me().pos!.floor)!;
    u.place(relic.pos!.x, relic.pos!.y);
    await u.act({ type: 'wait' });
    expect((await u.act({ type: 'pickup', item: relic.id })).ok).toBe(true);
    u.clearMonsters();
    const f = u.world.floors[u.me().pos!.floor];
    u.place(f.stairs.down[0].x, f.stairs.down[0].y);
    await u.act({ type: 'wait' });
    expect((await u.act({ type: 'extract' })).ok).toBe(true);
    const s2 = u.stories().filter((s) => s.reason === 'relic_delivered');
    expect(s2).toHaveLength(1);
    expect(s2[0].line.ja).toContain(content.items[relic.kind].origin!.ja);
    expect(s2[0].line.ja).toContain(content.items[relic.kind].name.ja);
    // 遺物の説明にも由来の文が付く
    expect(catalog.items[relic.kind].desc.ja.startsWith(content.items[relic.kind].origin!.ja)).toBe(true);
    u.manager.closeAll();
  });

  it('the warden tells its own line; get_rules opens with the frame of the world', async () => {
    const t = await newRun('v33s-warden-1', 'reach_depth');
    for (let d = 1; d < 5; d++) expect((await t.descend()).ok).toBe(true);
    const w = Object.values(t.world.entities).find((e) => e.pos?.floor === t.me().pos!.floor && e.guardian?.warden)!;
    await t.slay(w.id);
    const s = t.stories().filter((x) => x.reason === 'warden_slain');
    expect(s).toHaveLength(1);
    expect(s[0].line.ja).toContain(w.guardian!.name.ja);
    t.manager.closeAll();
    const frame = content.lists.lore.find((l) => l.kind === 'frame')!;
    expect(rulesText('all', 'ja', catalog).startsWith(frame.text.ja)).toBe(true);
    expect(rulesText('all', 'en', catalog).startsWith(frame.text.en)).toBe(true);
  });
});

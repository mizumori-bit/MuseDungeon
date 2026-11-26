// S16a（SEASON.md §70.3 の 2）: 本物の engine で強打を使い、遊ぶ画面・追従だけの観戦の枠に届く出来事（文になる出来事だけ: perceivedSince）と、
// 俯瞰・リプレイの出来事（filterEventsForPlayer）の中身を確かめる（能動技が動かないように見えた原因: 会心でない当たりの attack は文にならず、枠に届かない）
import { describe, expect, it } from 'vitest';
import { buildCatalog, loadContent } from '@muse/content';
import type { Command, Entity, GameEvent, World } from '@muse/shared';
import { applyEvent, filterEventsForPlayer, projectPlayerView } from '@muse/shared';
import { loadConfig, SessionManager } from '@muse/server';

const content = loadContent();
const catalog = buildCatalog(content);
let sid = 995000;

function goblin(id: string, floor: string, x: number, y: number): Entity {
  sid++;
  return {
    id, kind: 'core:goblin', sid, pos: { floor, x, y },
    actor: { speed: 100, nextActAt: 0, faction: 'monster', turns: 0, ai: { archetype: 'melee_chaser', state: 'hunting', targetPos: null, lostTurns: 0, params: {} } },
    stats: { hp: 40, maxHp: 40, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    base: { maxHp: 40, acc: 0, eva: 0, might: 0, armor: 0, sight: 7, dmg: '1d2' },
    statuses: [],
  };
}

function open(world: World, key: string, x: number, y: number): boolean {
  const f = world.floors[key];
  const tr = content.terrain[content.terrainIndex[world.meta.terrainTable[f.terrain[y * f.width + x]]]];
  return x >= 0 && y >= 0 && x < f.width && y < f.height && tr.passable && !tr.stairs
    && !Object.values(world.entities).some((e) => e.pos?.floor === key && e.pos.x === x && e.pos.y === y && (e.actor || e.feature || e.trap));
}

describe('S16a §70.3 の 2: an ability that hits shows its name and a step-in on every screen', () => {
  it('bash: the narrated frame (no plain-hit attack event) and the full events both give one ability label and one step-in by the user', async () => {
    const manager = new SessionManager(content, loadConfig({ runsDir: null, waitOthersMs: 100 }));
    const r = await manager.createRun({ name: 'R', seed: 'v34a-fight-1', classId: 'core:warrior', controller: { kind: 'agent', label: 't' }, objective: 'auto' });
    if ('error' in r) throw new Error(r.error.message);
    const world = r.session.world;
    const pid = r.port.playerId;
    const meId = world.players[pid].entityId;
    const inject = (p: { put?: Entity[]; del?: string[] }) => applyEvent(world, { type: 'thought', player: pid, text: '', seq: world.seq + 1, cause: null, floor: null, ft: 0, wall: 0, seenBy: [], ...p } as unknown as GameEvent);
    inject({ del: Object.values(world.entities).filter((e) => e.actor && !e.player).map((e) => e.id) });
    const key = world.entities[meId].pos!.floor;
    const f = world.floors[key];
    let at: { x: number; y: number } | null = null;
    for (let y = 1; y < f.height - 1 && !at; y++) for (let x = 1; x < f.width - 2 && !at; x++) if (open(world, key, x, y) && open(world, key, x + 1, y)) at = { x, y };
    const me = structuredClone(world.entities[meId]);
    me.pos = { floor: key, ...at! };
    me.stats!.acc = 60;
    inject({ put: [me, goblin('e_fb0001', key, at!.x + 1, at!.y)] });
    await r.port.act({ type: 'wait' }, { source: 'bot' });
    const s0 = world.seq;
    const h0 = r.session.history.length;
    const res = await r.port.act({ type: 'ability', id: 'bash', target: 'e_fb0001' } as Command, { source: 'bot' });
    expect(res.ok).toBe(true);
    const full = r.session.history.slice(h0);
    // この手は、会心でない当たり（同じシードで決まる）: 遊ぶ画面の枠には attack が届かない
    const hitEv = full.find((e) => e.type === 'attack') as unknown as { hit: boolean; crit: boolean };
    expect(hitEv.hit && !hitEv.crit).toBe(true);
    // 遊ぶ画面・追従だけの観戦の枠（文になる出来事だけ）: attack は届かず、能動技と、自分からの近接の被害は届く（画面は、この被害から踏み込みを作る:
    // client/test/renderEvents.test.ts。client の描画のコードは DOM の型を使うので、ここからは読み込まない）
    const frame = r.port.perceivedSince(s0).map((p) => p.event as unknown as Record<string, unknown>);
    expect(frame.some((e) => e.type === 'attack')).toBe(false);
    expect(frame.filter((e) => e.type === 'ability_used').map((e) => [e.actor, e.ability])).toEqual([[meId, 'core:bash']]);
    expect(frame.some((e) => e.type === 'damaged' && e.source === meId && e.target === 'e_fb0001' && e.via === 'melee')).toBe(true);
    expect(catalog.abilities['core:bash'].name.ja).toBe('強打');
    // 俯瞰・リプレイ（filterEventsForPlayer）: attack も届く（画面は、攻撃の出来事があれば、その被害から踏み込みを重ねない）
    const all = filterEventsForPlayer(full, pid, projectPlayerView(world, pid)) as unknown as Record<string, unknown>[];
    expect(all.some((e) => e.type === 'attack' && e.attacker === meId && e.target === 'e_fb0001')).toBe(true);
    manager.closeAll();
  });
});

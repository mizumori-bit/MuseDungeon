// 節目の大守護者（V3-3 §3.2）: 深度 5 の倍数の「大守護者の間」に置かれ、倒すまでその階の下り階段を封じる。
// 倒すと大きな賞金と、加護の選択（choose_boon。手番を消費しない）。次の節目はキャンプと遠征に出す。
import type { Content } from '@muse/content';
import type { ActionError, Entity, FloorKey, MilestoneInfo, PlayerRecord } from '@muse/shared';
import { actionError, Rng, t } from '@muse/shared';
import { grantBoon } from './boons';
import type { Ctx } from './ctx';
import { rollWardenInfo } from './guardians';
import { generateFloor } from './gen/generate';
import { addDiceBonus, diceMax, floorDiv } from '@muse/shared';
import { sumAffixMods } from './spawn';

/** 節目の間隔と最初の深さ（大守護者の間の floorType から。無ければ null） */
export function milestoneRule(content: Content): { every: number; min: number } | null {
  const f = content.lists.floorTypes.find((x) => x.rules.warden && x.every > 0);
  return f ? { every: f.every, min: f.depth.min } : null;
}

/** 次の節目: まだ倒していない、最も浅い大守護者の階 */
export function nextMilestone(ctx: Ctx): MilestoneInfo | null {
  const rule = milestoneRule(ctx.content);
  if (!rule) return null;
  const cleared = new Set(ctx.world.milestones?.cleared ?? []);
  for (let d = rule.every; d <= 1000; d += rule.every) {
    if (d < rule.min || cleared.has(d)) continue;
    const gi = rollWardenInfo(ctx.content, ctx.world.secret.seed, d);
    return { depth: d, name: { ...gi.name }, ...(gi.title ? { title: { ...gi.title } } : {}), types: [...gi.types] };
  }
  return null;
}

/**
 * 大守護者の下見（V3-3a §35.2・§35.7）: その深さの階を生成したときの大守護者の種族・体力・最大の一撃。
 * 生成は決定的なので、階を作らずに同じ値が分かる（階が既にあればその個体の値）
 */
export function wardenPreview(ctx: Ctx, depth: number): { kind: string; hp: number; maxHit: number } | null {
  const key = `main:${depth}`;
  const live = ctx.world.floors[key] ? ctx.entitiesOn(key).find((e) => e.guardian?.warden) : undefined;
  if (live?.stats) return { kind: live.kind, hp: live.stats.maxHp, maxHit: diceMax(live.stats.dmg) + live.stats.might };
  const g = generateFloor(ctx.content, ctx.world.secret.seed, 'main', depth, ctx.world.meta.terrainTable);
  const sp = g.spawns.find((x) => x.type === 'monster' && x.guardian?.warden);
  if (!sp || sp.type !== 'monster') return null;
  // makeMonster と同じ式（spawn.ts）
  const def = ctx.content.monsters[sp.kind];
  const mods = sumAffixMods(ctx.content, sp.affixes);
  const raw = Math.max(1, sp.minHp ?? 0, floorDiv(sp.hp * (100 + 50 * sp.tier + mods.hpPct + (sp.hpBonusPct ?? 0)), 100));
  const hp = sp.maxHp !== undefined ? Math.max(1, Math.min(raw, sp.maxHp)) : raw;
  const might = (def?.stats.might ?? 0) + sp.tier + mods.might;
  return { kind: sp.kind, hp, maxHit: diceMax(addDiceBonus(def?.attack.dice ?? '1d2', mods.dmgBonus)) + might };
}

/** その階で生きている大守護者（いれば下り階段は封じられている） */
export function livingWarden(ctx: Ctx, key: FloorKey): Entity | null {
  return ctx.entitiesOn(key).find((e) => !!e.guardian?.warden && (e.stats?.hp ?? 0) > 0) ?? null;
}

/** 加護の候補（seed|warden|深さ|boon|プレイヤー。持っていない加護から boonOptions 個） */
export function wardenBoonOptions(content: Content, seed: string, depth: number, playerId: string, owned: readonly string[]): string[] {
  const rng = Rng.fromSeed(`${seed}|warden|${depth}|boon|${playerId}`);
  const pool = rng.shuffle(content.lists.boons.map((b) => b.id).filter((id) => !owned.includes(id)));
  return pool.slice(0, content.balance.guardian.warden.boonOptions);
}

/** 大守護者が倒れた（combat の kill から）: 節目を記録し、その階にいる生きているプレイヤーに加護の候補を出す */
export function wardenSlain(ctx: Ctx, victim: Entity, killer: Entity | null, key: FloorKey): void {
  const depth = ctx.world.floors[key]?.depth ?? 0;
  ctx.emit({ type: 'warden_slain', depth, id: victim.id, guardianName: { ...victim.guardian!.name }, by: killer?.id ?? null, seenBy: 'all', floor: key });
  for (const pr of ctx.playersOn(key)) {
    const me = ctx.world.entities[pr.entityId];
    if (!me || pr.state !== 'alive') continue;
    const options = wardenBoonOptions(ctx.content, ctx.world.secret.seed, depth, pr.id, me.boons ?? []);
    if (!options.length) continue;
    const body = structuredClone(me);
    body.boonChoice = { options, source: 'warden', depth };
    ctx.emit({ type: 'boon_offered', target: me.id, options: [...options], source: 'warden', depth, put: [body], seenBy: [pr.id], floor: key });
  }
}

/** choose_boon（手番を消費しない）: 候補の番号（1 から）か加護の ID（'calm' でも 'core:boon_calm' でもよい） */
export function chooseBoon(ctx: Ctx, pr: PlayerRecord, option: number | string): ActionError | null {
  const L = pr.locale;
  const me = ctx.world.entities[pr.entityId];
  const ch = me?.boonChoice;
  if (!me || !ch || !ch.options.length) return actionError('nothing_to_do', t(L, '選べる加護の候補は無い。', 'There is no boon to choose.'), t(L, '節目の大守護者を倒すと候補が出る（alerts の boon_pending）。', 'Slaying a milestone warden offers boons (alerts: boon_pending).'));
  const id = typeof option === 'number' ? ch.options[option - 1]
    : ch.options.find((o) => o === option || o.split(':')[1] === option || o.replace(/^[^:]+:boon_/, '') === option);
  if (!id) {
    return actionError('bad_request', t(L, `候補に無い: ${option}`, `Not one of the options: ${option}`),
      t(L, `1〜${ch.options.length} の番号か、候補の ID（${ch.options.join(', ')}）を渡す。`, `Pass 1-${ch.options.length} or one of: ${ch.options.join(', ')}.`));
  }
  grantBoon(ctx, me, id, 'warden', (b) => { delete b.boonChoice; });
  return null;
}

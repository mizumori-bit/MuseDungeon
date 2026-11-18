// engine: ルール。決定論的（Math.random・Date・浮動小数・I/O 禁止）。状態はイベント経由でのみ変わる。
import type { Content } from '@muse/content';
import { actions } from './actions';
import { archetypes } from './ai';
import { effects } from './effects';
import { validators } from './gen/generate';
import { layoutGenerators } from './gen/layouts';
import { statusHandlers } from './statuses';
import { abilityHandlers, weaponTraits } from './build';
import './abilities';
import './guardianBehaviors';
import { guardianTypeHandlers, weaknessHandlers } from './guardians';

export { createRun, joinPlayer, step, isPlayersTurn, ENGINE_VERSION } from './run';
export type { CreateRunParams, StepResult } from './run';
export { generateFloor, guardianCandidates, selectBiome, selectFloorType } from './gen/generate';
export type { GeneratedFloor, SpawnSpec } from './gen/generate';
export { computeFov, hasLos, line } from './geom';
export { shotLine } from './perception';
export { pickRelic, relicInfo } from './boons';
export { isMilestoneDepth } from './gen/generate';
export { guardianTraits } from './expedition';
import { bountyOffer, guardianHpEstimate, guardianHpRange, guardianMaxHit, makeOffers, monsterArmorEstimate } from './expedition';
import { makeMonster } from './spawn';
import type { SpawnSpec } from './gen/generate';
import { Ctx } from './ctx';
import type { BountyInfo, Entity, ExpeditionOffer, FloorKey, World } from '@muse/shared';
/** 候補を作って返す（World は変えない。テストと計測用） */
export function previewOffers(world: World, content: Content, no: number): ExpeditionOffer[] {
  return makeOffers(new Ctx(world, content, null, 0), no);
}
export { rollGuardianInfo, rollWardenInfo, weaknessHandlers } from './guardians';
export { wardenHpRange } from './warden';
import { runGaps } from './warden';
/** 続いているランの不整合（World は変えない。サーバーの起動時のログ用。V4-0b §1.2） */
export function checkRunGaps(world: World, content: Content): string[] {
  return runGaps(new Ctx(world, content, null, 0));
}
/**
 * その者がいる場所で出来事が起きたら、そのプレイヤーに主体として伝わるか（出来事の伏せ方。World は変えない。
 * 表示のリストと食い違わないかを確かめるテスト用。V4-0c §4.4）
 */
export function actorPerceived(world: World, content: Content, pid: string, entityId: string): boolean {
  const e = world.entities[entityId];
  if (!e?.pos) return false;
  const s = new Ctx(world, content, null, 0).perceive(e.pos.floor, [{ field: 'x', pos: e.pos, entity: e.id }]);
  return s.seenBy.includes(pid) && !s.masks?.[pid]?.includes('x');
}
/**
 * 候補の目安（賞金首・格 1〜3 の守護者）と、生成の仕様から作った敵（どちらも World を変えない。
 * 生成された個体が目安と幅に入るかを確かめるテスト用。V4-0d §6）
 */
export function previewBounty(world: World, content: Content, depth: number, b: BountyInfo): NonNullable<ExpeditionOffer['bounty']> {
  return bountyOffer(new Ctx(world, content, null, 0), depth, b);
}
export function previewGuardian(world: World, content: Content, depth: number, kind: string, rank: 1 | 2 | 3, affixes: string[] = []): { hp: number; hpRange?: { min: number; max: number }; maxHit: number; armor: number } {
  const ctx = new Ctx(world, content, null, 0);
  return { hp: guardianHpEstimate(ctx, depth, kind, rank, affixes), hpRange: guardianHpRange(ctx, depth, kind, rank, affixes), maxHit: guardianMaxHit(ctx, depth, kind, affixes), armor: monsterArmorEstimate(ctx, depth, kind, affixes) };
}
export function monsterFromSpec(world: World, content: Content, floor: FloorKey, spec: Extract<SpawnSpec, { type: 'monster' }>): Entity {
  return makeMonster(new Ctx(world, content, null, 0), floor, spec, 'e_preview', 0);
}
/** 版の新旧（'0.8.0' と '0.25.0' を数で比べる。a が古ければ負） */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0), pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
export { actions, archetypes, effects, validators, layoutGenerators, statusHandlers, abilityHandlers, weaponTraits };

/** コンテンツが参照するハンドラ ID が全てレジストリに登録されているか検証する */
export function validateContentHandlers(content: Content): string[] {
  const errs: string[] = [];
  // 守護者の型・弱点（V3-3）
  for (const g of content.lists.guardianTypes) if (!guardianTypeHandlers.has(g.handler)) errs.push(`${g.id}: 未登録の guardian type handler ${g.handler}`);
  for (const w of content.lists.guardianWeaknesses) if (!weaknessHandlers.has(w.handler)) errs.push(`${w.id}: 未登録の weakness handler ${w.handler}`);
  const eff = (list: { effect: string }[], where: string) => {
    for (const e of list) if (!effects.has(e.effect)) errs.push(`${where}: 未登録の effect ${e.effect}`);
  };
  for (const m of content.lists.monsters) {
    if (!archetypes.has(m.ai.archetype)) errs.push(`${m.id}: 未登録の archetype ${m.ai.archetype}`);
    eff(m.attack.onHit, m.id);
  }
  for (const it of content.lists.items) eff(it.onUse, it.id);
  for (const a of content.lists.affixes) eff(a.onHit, a.id);
  for (const f of content.lists.features) { eff(f.onInteract, f.id); eff(f.onEnter, f.id); }
  for (const s of Object.values(content.statuses)) if (!statusHandlers.has(s.handler)) errs.push(`${s.id}: 未登録の status handler ${s.handler}`);
  for (const b of content.lists.biomes) for (const l of Object.keys(b.layouts)) if (!layoutGenerators.has(l)) errs.push(`${b.id}: 未登録の layout ${l}`);
  for (const ab of content.lists.abilities) if (ab.target !== 'throw' && !abilityHandlers.has(ab.handler)) errs.push(`${ab.id}: 未登録の ability handler ${ab.handler}`);
  for (const w of content.lists.weaponTraits) if (!weaponTraits.has(w.handler)) errs.push(`${w.id}: 未登録の weaponTrait handler ${w.handler}`);
  for (const ft of content.lists.floorTypes) {
    for (const l of Object.keys(ft.layouts ?? {})) if (!layoutGenerators.has(l)) errs.push(`${ft.id}: 未登録の layout ${l}`);
    for (const v of ft.validators) if (!validators.has(v)) errs.push(`${ft.id}: 未登録の validator ${v}`);
  }
  return errs;
}

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
import { makeOffers } from './expedition';
import { Ctx } from './ctx';
import type { ExpeditionOffer, World } from '@muse/shared';
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

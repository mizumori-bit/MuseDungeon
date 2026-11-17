// 物語の文（V3-3 §3.4・§16.2）: 文面はデータ（lore.json）。状態を持たないハッシュ（seed|lore|鍵）で選び、{depth} {guardian} {relic} {origin} を埋める。
// 物語は判断を指示しない（事実だけ）。弱点など伏せている情報は埋めない。
import type { Content, LoreDef } from '@muse/content';
import type { Names } from '@muse/shared';
import { Rng } from '@muse/shared';
import type { Ctx } from './ctx';

export interface LoreWhen { objective?: string; guarded?: boolean; guardianTypes?: string[] }

function matches(l: LoreDef, w: LoreWhen): boolean {
  if (l.when.objective !== undefined && l.when.objective !== w.objective) return false;
  if (l.when.guarded !== undefined && l.when.guarded !== !!w.guarded) return false;
  if (l.when.guardianType !== undefined && !(w.guardianTypes ?? []).includes(l.when.guardianType)) return false;
  return true;
}

const specificity = (l: LoreDef) => Object.values(l.when).filter((v) => v !== undefined).length;

/** 合う文のうち、条件の多いものから weight で 1 つ選び、埋めた文を返す（無ければ null） */
export function pickLore(content: Content, seed: string, key: string, kind: LoreDef['kind'], when: LoreWhen, vars: Record<string, Names>): Names | null {
  const cands = content.lists.lore.filter((l) => l.kind === kind && matches(l, when));
  if (!cands.length) return null;
  const top = Math.max(...cands.map(specificity));
  const pool = cands.filter((l) => specificity(l) === top);
  const pick = Rng.fromSeed(`${seed}|lore|${key}`).weighted(pool, (l) => l.weight) ?? pool[0];
  const fill = (s: string, lang: 'ja' | 'en') => s.replace(/\{(\w+)\}/g, (_, k: string) => vars[k]?.[lang] ?? '').replace(/\s+$/, '');
  return { ja: fill(pick.text.ja, 'ja'), en: fill(pick.text.en, 'en') };
}

/** 物語の 1 文を全員に出す（倒した・納めた） */
export function tellStory(ctx: Ctx, reason: 'guardian_slain' | 'warden_slain' | 'relic_delivered', line: Names | null, floor: string | null): void {
  if (!line) return;
  ctx.emit({ type: 'story', reason, line, seenBy: 'all', floor });
}

/** 数字を Names に */
export const num = (n: number): Names => ({ ja: String(n), en: String(n) });

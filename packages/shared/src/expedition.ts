// 遠征の文章化（目的・達成条件・進捗・結果・候補）。入力は PlayerView 由来の事実だけ。
// 仕様: docs/IMPROVEMENTS_V2.md §2.6。「次に何をすべきか」の提案は書かない（事実とルールのみ）。
import type { CatalogRules } from './catalog';
import { dangerOf, recommendedLevel } from './catalog';
import type { ExpeditionEndReason, ExpeditionOffer, Locale, Objective, OfferSlot } from './types';
import { t } from './util';
import type { ExpeditionView, PlayerView } from './view';

export function objectiveText(L: Locale, o: Objective): string {
  const d = o.targetDepth;
  switch (o.type) {
    case 'reach_depth': return t(L, `地下${d}階に到達し、階段から帰還する`, `Reach depth ${d}, then extract from any stairs`);
    case 'slay_guardian': return t(L, `地下${d}階の守護者を倒し、階段から帰還する`, `Slay the guardian on depth ${d}, then extract from any stairs`);
    case 'retrieve_relic': return t(L, `地下${d}階の遺物を見つけ、持ったまま階段から帰還する`, `Find the relic on depth ${d} and extract from any stairs while carrying it`);
    default: return t(L, '目的なし。できるだけ深く潜る', 'No objective: descend as deep as you can');
  }
}

export function conditionText(L: Locale, o: Objective): string {
  switch (o.type) {
    case 'reach_depth': return t(L, `地下${o.targetDepth}階に着く → いずれかの階段の上で extract`, `Arrive on depth ${o.targetDepth} → extract while standing on any stairs`);
    case 'slay_guardian': return t(L, '守護者を倒す → いずれかの階段の上で extract', 'Slay the guardian → extract while standing on any stairs');
    case 'retrieve_relic': return t(L, '遺物を拾う → 持ったままいずれかの階段の上で extract', 'Pick up the relic → extract on any stairs while carrying it');
    default: return t(L, '達成条件なし（階段の上で extract(confirm) すると撤退として終わる）', 'No completion condition (extract(confirm) on stairs ends it as a withdrawal)');
  }
}

export function endReasonText(L: Locale, r: ExpeditionEndReason | null): string {
  switch (r) {
    case 'completed': return t(L, '達成して帰還', 'completed and extracted');
    case 'withdrawn': return t(L, '撤退', 'withdrawn');
    case 'died': return t(L, '死亡', 'died');
    case 'retired': return t(L, '引退', 'retired');
    default: return t(L, '進行中', 'in progress');
  }
}

/** 開始時・再開時のブリーフィング（§2.6） */
export function briefingLines(L: Locale, x: ExpeditionView, rules?: Pick<CatalogRules, 'traits'>): string[] {
  const lines = [
    t(L, `【遠征 ${x.no}】目的: ${objectiveText(L, x.objective)}`, `[Expedition ${x.no}] Objective: ${objectiveText(L, x.objective)}`),
    t(L, `達成条件: ${conditionText(L, x.objective)}`, `Completion: ${conditionText(L, x.objective)}`),
    t(L, '撤退: 階段の上で extract(confirm) すると、未達成のまま生還して遠征を終えられる', 'Withdraw: extract(confirm) on stairs ends the expedition alive, without the reward'),
    t(L, '終了理由: 達成して帰還 / 撤退 / 死亡 / 引退(retire)', 'It ends by: completion + extract / withdrawal / death / retire'),
  ];
  if (x.objective.type !== 'endless') {
    lines.push(t(L,
      `報酬: 遠征中に積み上げた戦利品（目的 +${x.points}・深追い・宝・賞金・発見・撃破）が、帰還で ${multText(x.multiplierPct)} されて確定する。撤退は目的を除いた半分、死亡すると全て失う。キャンプで全回復し、次の遠征を選べる`,
      `Reward: the haul you build (objective +${x.points}, overreach, treasure, bounty, discovery, kills) is banked ${multText(x.multiplierPct)} when you extract. Withdrawal banks half without the objective; death loses it all. At camp you are healed and choose the next expedition`));
  }
  if (x.traits.length) lines.push(t(L, `条件: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`, `Traits: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`));
  if (x.objective.type === 'retrieve_relic' && x.relicGuarded) lines.push(t(L, '情報: 遺物は守護者が守っている', 'Note: the relic is guarded'));
  return lines;
}

export function progressText(L: Locale, x: ExpeditionView, depth: number | null): string {
  const o = x.objective;
  const parts: string[] = [];
  if (o.targetDepth !== null) parts.push(t(L, `地下${depth ?? '-'}/${o.targetDepth}階`, `depth ${depth ?? '-'}/${o.targetDepth}`));
  else if (depth !== null) parts.push(t(L, `地下${depth}階`, `depth ${depth}`));
  if (o.type === 'reach_depth') parts.push(x.progress.reached ? t(L, '目標階に到達済み', 'target reached') : t(L, '目標階に未到達', 'target not reached'));
  if (o.type === 'slay_guardian') parts.push(x.progress.guardianSlain ? t(L, '守護者: 討伐済み', 'guardian: slain') : t(L, '守護者: 未討伐', 'guardian: alive'));
  if (o.type === 'retrieve_relic') {
    parts.push(x.progress.relicHeldByYou ? t(L, '遺物: 所持', 'relic: carried') : x.progress.relicHeld ? t(L, '遺物: 仲間が所持', 'relic: carried by an ally') : t(L, '遺物: 未入手', 'relic: not held'));
  }
  return parts.join(' | ');
}

export function slotName(L: Locale, s: OfferSlot | null | undefined): string {
  if (!s) return '';
  const ja: Record<OfferSlot, string> = { safe: '堅実', standard: '標準', ambitious: '野心' };
  return L === 'en' ? s : ja[s];
}

/** 倍率（%）の表示: ×1.2 */
export function multText(pct: number): string {
  return `×${(pct / 100).toFixed(pct % 10 === 0 ? 1 : 2)}`;
}

export function traitsText(L: Locale, rules: Pick<CatalogRules, 'traits'> | undefined, traits: readonly string[]): string {
  if (!traits.length || !rules) return '';
  return traits.map((id) => {
    const tr = rules.traits[id];
    return tr ? `${L === 'en' ? tr.name.en : tr.name.ja}: ${L === 'en' ? tr.desc.en : tr.desc.ja}` : id;
  }).join(' / ');
}

/** 候補の文章。rules と level があれば危険度と推奨レベルも付ける（公開の式だけで計算） */
export function offerText(L: Locale, o: ExpeditionOffer, ctx?: { rules: Pick<CatalogRules, 'traits' | 'recommendedLevel'>; level: number }): string {
  const guard = o.objective.type === 'retrieve_relic' && o.relicGuarded ? t(L, '（守護者付き）', ' (guarded)') : '';
  const slot = o.slot ? `[${slotName(L, o.slot)}] ` : '';
  const head = `${o.index}) ${slot}${objectiveText(L, o.objective)}${guard}`;
  const mult = o.multiplierPct ?? 100;
  const traits = traitsText(L, ctx?.rules, o.traits ?? []);
  const danger = ctx && o.objective.targetDepth !== null
    ? t(L, ` / 危険度 ${dangerOf(ctx.rules, o.objective.targetDepth, o.traits ?? [], ctx.level)}（推奨 Lv${recommendedLevel(ctx.rules, o.objective.targetDepth)}、あなたは Lv${ctx.level}）`,
      ` / danger ${dangerOf(ctx.rules, o.objective.targetDepth, o.traits ?? [], ctx.level)} (recommended Lv${recommendedLevel(ctx.rules, o.objective.targetDepth)}, you are Lv${ctx.level})`)
    : '';
  return t(L, `${head} — 基礎 +${o.points} / 倍率 ${multText(mult)}${traits ? `（${traits}）` : ''}${danger}`,
    `${head} — base +${o.points} / multiplier ${multText(mult)}${traits ? ` (${traits})` : ''}${danger}`);
}

export function campLines(L: Locale, view: PlayerView, rules?: Pick<CatalogRules, 'traits' | 'recommendedLevel'>): string[] {
  const camp = view.camp;
  if (!camp) return [];
  const lines = [
    t(L, `確定済み ${view.record.banked} 点・達成した遠征 ${view.record.expeditions}${view.record.lost ? `・失った戦利品 ${view.record.lost}` : ''}`,
      `Banked ${view.record.banked}, expeditions completed ${view.record.expeditions}${view.record.lost ? `, lost ${view.record.lost}` : ''}`),
    t(L, `次の遠征の候補（遠征 ${camp.nextNo}）。start_expedition { offer } で始める:`, `Offers for expedition ${camp.nextNo} (start with start_expedition { offer }):`),
  ];
  for (const o of camp.offers) lines.push('  ' + offerText(L, o, rules ? { rules, level: view.self.level } : undefined));
  lines.push('  ' + t(L, 'endless) 目的なしでひたすら潜る（offer: "endless"）', 'endless) no objective, just descend (offer: "endless")'));
  return lines;
}

export function partsText(L: Locale, p: { objective: number; overreach: number; treasure: number; bounty: number; discovery: number; kills: number }): string {
  const ja: [number, string][] = [[p.objective, '目的'], [p.overreach, '深追い'], [p.treasure, '宝'], [p.bounty, '賞金'], [p.discovery, '発見'], [p.kills, '撃破']];
  const en: [number, string][] = [[p.objective, 'objective'], [p.overreach, 'overreach'], [p.treasure, 'treasure'], [p.bounty, 'bounty'], [p.discovery, 'discovery'], [p.kills, 'kills']];
  return (L === 'en' ? en : ja).filter(([v]) => v > 0).map(([v, n]) => (L === 'en' ? `${n} ${v}` : `${n}${v}`)).join(L === 'en' ? ', ' : '・');
}

export function resultText(L: Locale, x: ExpeditionView): string {
  const r = x.result;
  if (!r) return '';
  const pay = r.payout;
  if (pay) {
    const mine = pay.players.length === 1 ? pay.players[0] : null;
    const banked = mine ? mine.banked : pay.banked;
    const lost = mine ? mine.lost : pay.lost;
    return t(L,
      `遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）。確定 +${banked}${lost ? `（失った戦利品 ${lost}）` : ''}。内訳: ${partsText(L, pay.parts) || 'なし'}、倍率 ${multText(pay.multiplierPct)}。この遠征: 最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`,
      `Expedition ${x.no} ended (${endReasonText(L, r.reason)}). Banked +${banked}${lost ? ` (lost ${lost})` : ''}. Parts: ${partsText(L, pay.parts) || 'none'}, multiplier ${multText(pay.multiplierPct)}. Deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`);
  }
  return t(L,
    `遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）。獲得 +${r.points} 点。この遠征: 最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`,
    `Expedition ${x.no} ended (${endReasonText(L, r.reason)}). +${r.points} points. This expedition: deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`);
}

/** 遠征の候補の基礎点（engine の候補生成とルールブックで共用） */
export function offerPoints(rules: Pick<CatalogRules, 'expedition'>, type: Objective['type'], targetDepth: number, deepest: number): number {
  const base = rules.expedition.points[type] ?? 0;
  const extra = Math.max(0, targetDepth - deepest - rules.expedition.aheadMin);
  return base + extra * rules.expedition.pointsPerExtraDepth;
}

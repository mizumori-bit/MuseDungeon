// 遠征の文章化（目的・達成条件・進捗・結果・候補）。入力は PlayerView 由来の事実だけ。
// 仕様: docs/IMPROVEMENTS_V2.md §2.6。「次に何をすべきか」の提案は書かない（事実とルールのみ）。
import type { CatalogRules } from './catalog';
import type { ExpeditionEndReason, ExpeditionOffer, Locale, Objective } from './types';
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
export function briefingLines(L: Locale, x: ExpeditionView): string[] {
  const lines = [
    t(L, `【遠征 ${x.no}】目的: ${objectiveText(L, x.objective)}`, `[Expedition ${x.no}] Objective: ${objectiveText(L, x.objective)}`),
    t(L, `達成条件: ${conditionText(L, x.objective)}`, `Completion: ${conditionText(L, x.objective)}`),
    t(L, '撤退: 階段の上で extract(confirm) すると、未達成のまま生還して遠征を終えられる', 'Withdraw: extract(confirm) on stairs ends the expedition alive, without the reward'),
    t(L, '終了理由: 達成して帰還 / 撤退 / 死亡 / 引退(retire)', 'It ends by: completion + extract / withdrawal / death / retire'),
  ];
  if (x.objective.type !== 'endless') {
    lines.push(t(L, `報酬: 達成 +${x.points} 点、キャンプで全回復し、次の遠征を選べる`, `Reward: +${x.points} points on completion; at camp you are fully healed and choose the next expedition`));
  }
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

export function offerText(L: Locale, o: ExpeditionOffer): string {
  const guard = o.objective.type === 'retrieve_relic' && o.relicGuarded ? t(L, '（守護者付き）', ' (guarded)') : '';
  return t(L, `${o.index}) ${objectiveText(L, o.objective)}${guard} — 達成 +${o.points} 点`, `${o.index}) ${objectiveText(L, o.objective)}${guard} — +${o.points} points`);
}

export function campLines(L: Locale, view: PlayerView): string[] {
  const camp = view.camp;
  if (!camp) return [];
  const lines = [t(L, `次の遠征の候補（遠征 ${camp.nextNo}）。start_expedition { offer } で始める:`, `Offers for expedition ${camp.nextNo} (start with start_expedition { offer }):`)];
  for (const o of camp.offers) lines.push('  ' + offerText(L, o));
  lines.push('  ' + t(L, 'endless) 目的なしでひたすら潜る（offer: "endless"）', 'endless) no objective, just descend (offer: "endless")'));
  return lines;
}

export function resultText(L: Locale, x: ExpeditionView): string {
  const r = x.result;
  if (!r) return '';
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

// 遠征の文章化（目的・達成条件・進捗・結果・候補）。入力は PlayerView 由来の事実だけ。
// 仕様: docs/IMPROVEMENTS_V2.md §2.6。「次に何をすべきか」の提案は書かない（事実とルールのみ）。
import type { CatalogRules } from './catalog';
import { offerGap } from './catalog';
import type { ExpeditionEndReason, ExpeditionOffer, Locale, Objective, OfferSlot } from './types';
import { t } from './util';
import type { ExpeditionView, PlayerView } from './view';

export function objectiveText(L: Locale, o: Objective): string {
  const d = o.targetDepth;
  switch (o.type) {
    case 'reach_depth': return t(L, `地下${d}階を踏破し（その階の下り階段に着き）、階段から帰還する`, `Cross depth ${d} (reach its down stairs), then extract from any stairs`);
    case 'slay_guardian': return t(L, `地下${d}階の守護者を倒し、階段から帰還する`, `Slay the guardian on depth ${d}, then extract from any stairs`);
    case 'retrieve_relic': return t(L, `地下${d}階の遺物を見つけ、持ったまま階段から帰還する`, `Find the relic on depth ${d} and extract from any stairs while carrying it`);
    default: return t(L, '目的なし。できるだけ深く潜る', 'No objective: descend as deep as you can');
  }
}

export function conditionText(L: Locale, o: Objective): string {
  switch (o.type) {
    case 'reach_depth': return t(L, `地下${o.targetDepth}階の下り階段に着く（着いただけでは達成しない）→ いずれかの階段の上で extract`, `Stand on the down stairs of depth ${o.targetDepth} (arriving is not enough) → extract while standing on any stairs`);
    case 'slay_guardian': return t(L, '守護者を倒す → いずれかの階段の上で extract', 'Slay the guardian → extract while standing on any stairs');
    case 'retrieve_relic': return t(L, '遺物を拾う → 持ったままいずれかの階段の上で extract', 'Pick up the relic → extract on any stairs while carrying it');
    default: return t(L, '達成条件なし（階段の上で extract(confirm) すると撤退として終わる）', 'No completion condition (extract(confirm) on stairs ends it as a withdrawal)');
  }
}

export function endReasonText(L: Locale, r: ExpeditionEndReason | null): string {
  switch (r) {
    case 'completed': return t(L, '達成して帰還', 'completed and extracted');
    case 'withdrawn': return t(L, '撤退', 'withdrawn');
    case 'lifeline': return t(L, '帰還の綱で帰還', 'returned by lifeline');
    case 'died': return t(L, '死亡', 'died');
    case 'retired': return t(L, '引退', 'retired');
    default: return t(L, '進行中', 'in progress');
  }
}

/** 開始時・再開時のブリーフィング（§2.6） */
export function briefingLines(L: Locale, x: ExpeditionView, rules?: Pick<CatalogRules, 'traits'> & Partial<Pick<CatalogRules, 'lifeline'>>): string[] {
  const lt = rules?.lifeline?.turns ?? 0;
  const lines = [
    t(L, `【遠征 ${x.no}】目的: ${objectiveText(L, x.objective)}`, `[Expedition ${x.no}] Objective: ${objectiveText(L, x.objective)}`),
    t(L, `達成条件: ${conditionText(L, x.objective)}`, `Completion: ${conditionText(L, x.objective)}`),
    t(L, '撤退: 階段の上で extract(confirm) すると、未達成のまま生還して遠征を終えられる（追跡中の敵が見えていてもよい）', 'Withdraw: extract(confirm) on stairs ends the expedition alive, without the reward (even with hunters in view)'),
    t(L, `帰還の綱: 階段から遠くても use_item で使えば${lt > 0 ? ` ${lt} 手番後に` : 'その場で'}キャンプへ戻る（命と、目的を除く戦利品の半分を持ち帰る。遺物は運べない。達成した遠征には数えない）`,
      `Lifeline: use_item it anywhere to return to camp${lt > 0 ? ` after ${lt} turns` : ' at once'} (you keep your life and half the haul without the objective; a relic cannot come along; not a completed expedition)`),
    t(L, '終了理由: 達成して帰還 / 帰還の綱で帰還 / 撤退 / 死亡 / 引退(retire)', 'It ends by: completion + extract / lifeline / withdrawal / death / retire'),
  ];
  if (x.objective.type !== 'endless') {
    lines.push(t(L,
      `報酬: 遠征中に積み上げた戦利品（目的 +${x.points}・深追い・宝・賞金・発見・撃破）が、帰還で ${multText(x.multiplierPct)} されて確定する。撤退は目的を除いた半分、死亡すると全て失う。キャンプで全回復し、次の遠征を選べる`,
      `Reward: the haul you build (objective +${x.points}, overreach, treasure, bounty, discovery, kills) is banked ${multText(x.multiplierPct)} when you extract. Withdrawal banks half without the objective; death loses it all. At camp you are healed and choose the next expedition`));
  }
  if (x.traits.length) lines.push(t(L, `条件: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`, `Traits: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`));
  if (x.objective.type === 'retrieve_relic') lines.push(x.relicGuarded ? t(L, '情報: 遺物は守護者が守っている', 'Note: the relic is guarded') : t(L, '情報: 遺物に守護者はいない', 'Note: the relic is unguarded'));
  return lines;
}

/** 2 回目以降の遠征の開始時の説明（1 行。V3-2R3 §20.6） */
export function briefingShort(L: Locale, x: ExpeditionView, rules?: Pick<CatalogRules, 'traits'>): string {
  const tr = x.traits.length ? t(L, `・条件: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`, `, traits: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`) : '';
  const guard = x.objective.type === 'retrieve_relic' ? (x.relicGuarded ? t(L, '（守護者付き）', ' (guarded)') : t(L, '（守護者なし）', ' (unguarded)')) : '';
  return t(L, `【遠征 ${x.no}】${objectiveText(L, x.objective)}${guard}・目的 +${x.points}・帰還で ${multText(x.multiplierPct)}${tr}`,
    `[Expedition ${x.no}] ${objectiveText(L, x.objective)}${guard}, objective +${x.points}, ${multText(x.multiplierPct)} on extract${tr}`);
}

export function progressText(L: Locale, x: ExpeditionView, depth: number | null): string {
  const o = x.objective;
  const parts: string[] = [];
  if (o.targetDepth !== null) parts.push(t(L, `地下${depth ?? '-'}/${o.targetDepth}階`, `depth ${depth ?? '-'}/${o.targetDepth}`));
  else if (depth !== null) parts.push(t(L, `地下${depth}階`, `depth ${depth}`));
  if (o.type === 'reach_depth') parts.push(x.progress.reached ? t(L, '目標階を踏破済み', 'target crossed') : t(L, '目標階の下り階段に未到達', 'target not crossed yet'));
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

const GUARD_TRAIT_JA: Record<string, string> = { fast: '速い', slow: '遅い', ranged: '射撃する', large: '大柄', armored: '重装' };

/** 守護者の見込みの文（「守護者: 格 2・射撃する・速い」。種族名は出さない。V3-2R3 §20.1） */
export function guardianForecastText(L: Locale, g: { rank: number; traits: string[] } | undefined): string {
  if (!g) return '';
  // 速さは必ず書く（速い・遅いが無ければ「普通の速さ」）
  const speed = g.traits.includes('fast') || g.traits.includes('slow') ? [] : [t(L, '普通の速さ', 'normal speed')];
  const tr = [...g.traits.map((x) => (L === 'en' ? x : GUARD_TRAIT_JA[x] ?? x)), ...speed];
  return t(L, `守護者: 格 ${g.rank}・${tr.join('・')}`, `guardian: rank ${g.rank}, ${tr.join(', ')}`);
}

/** 候補の文章。rules と level があれば推奨レベルとの差と条件の危険度も付ける（公開の表と式だけで計算） */
export function offerText(L: Locale, o: ExpeditionOffer, ctx?: { rules: Pick<CatalogRules, 'traits' | 'recommendedLevel'>; level: number }): string {
  const guard = o.objective.type === 'retrieve_relic' && o.relicGuarded ? t(L, '（守護者付き）', ' (guarded)') : '';
  const slot = o.slot ? `[${slotName(L, o.slot)}] ` : '';
  const head = `${o.index}) ${slot}${objectiveText(L, o.objective)}${guard}`;
  const mult = o.multiplierPct ?? 100;
  const traits = traitsText(L, ctx?.rules, o.traits ?? []);
  let danger = '';
  if (ctx && o.objective.targetDepth !== null) {
    const g = offerGap(ctx.rules, o.objective.targetDepth, o.traits ?? [], ctx.level);
    const gap = g.levelGap! > 0 ? `+${g.levelGap}` : `${g.levelGap}`;
    const td = g.traitDanger ? t(L, `／条件 ${g.traitDanger > 0 ? '+' : ''}${g.traitDanger}`, ` / traits ${g.traitDanger > 0 ? '+' : ''}${g.traitDanger}`) : '';
    danger = t(L, ` / 推奨 Lv${g.recommendedLevel}・あなた Lv${ctx.level}（差 ${gap}）${td}`, ` / recommended Lv${g.recommendedLevel}, you Lv${ctx.level} (gap ${gap})${td}`);
  }
  const gf = o.guardian ? ` / ${guardianForecastText(L, o.guardian)}` : '';
  return t(L, `${head} — 基礎 +${o.points} / 倍率 ${multText(mult)}${traits ? `（${traits}）` : ''}${danger}${gf}`,
    `${head} — base +${o.points} / multiplier ${multText(mult)}${traits ? ` (${traits})` : ''}${danger}${gf}`);
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

export function resultText(L: Locale, x: ExpeditionView, rules?: Partial<Pick<CatalogRules, 'haul' | 'lifeline'>>): string {
  const r = x.result;
  if (!r) return '';
  const pay = r.payout;
  if (pay) {
    const mine = pay.players.length === 1 ? pay.players[0] : null;
    const banked = mine ? mine.banked : pay.banked;
    const lost = mine ? mine.lost : pay.lost;
    // 倍率が掛かるのは帰還（達成）だけ。撤退と綱はそれぞれの割合（倍率なし）
    const how = r.reason === 'completed' ? t(L, `倍率 ${multText(pay.multiplierPct)}`, `multiplier ${multText(pay.multiplierPct)}`)
      : r.reason === 'lifeline' ? t(L, `帰還の綱で ${rules?.lifeline?.pct ?? 50}%（倍率なし）`, `lifeline ${rules?.lifeline?.pct ?? 50}% (no multiplier)`)
        : r.reason === 'withdrawn' ? t(L, `撤退で目的を除いて ${rules?.haul?.withdrawPct ?? 50}%（倍率なし）`, `withdrawal ${rules?.haul?.withdrawPct ?? 50}% without the objective (no multiplier)`)
          : t(L, '確定なし', 'nothing banked');
    return t(L,
      `遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）。確定 +${banked}${lost ? `（失った戦利品 ${lost}）` : ''}。内訳: ${partsText(L, pay.parts) || 'なし'}、${how}。この遠征: 最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`,
      `Expedition ${x.no} ended (${endReasonText(L, r.reason)}). Banked +${banked}${lost ? ` (lost ${lost})` : ''}. Parts: ${partsText(L, pay.parts) || 'none'}, ${how}. Deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`);
  }
  return t(L,
    `遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）。獲得 +${r.points} 点。この遠征: 最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`,
    `Expedition ${x.no} ended (${endReasonText(L, r.reason)}). +${r.points} points. This expedition: deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`);
}

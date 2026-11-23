// 遠征まわりの表示部品: 目的と進捗、戦利品（未確定の点）、ブリーフィング、手番の状態行と変化、休憩の見積もり、キャンプ、観戦用の要約、AI の応答待ち。
// 文章と数値は shared の expedition.ts / turn.ts / catalog.ts / observation.ts で作る。ここでは並べて見せるだけで、ゲームの判定はしない。
import type {
  Catalog, CatalogRules, Change, Dir, Expedition, ExpeditionOffer, ExpeditionView, HaulParts, ObsExpedition, ObsSeason, Observation, OfferSlot, PlayerView,
  RestEstimate, World,
} from '@muse/shared';
import {
  bountyForecastText, briefingLines, buildObservation, campDepthOf, CHECKPOINT_NOTES, gearVsArmorText, offerGuardianHp, currentExpedition, dirLabel, endReasonText, guardianForecastText, haulTotal, latestExpedition, multText, nameOf,
  nextCampOf, nextOverreach, objectiveText, offerFloorTraitsText, offerGap, offerText, offerWardenExtra, overreachPoints, partsText, progressText, recordsCampLine, resultText, slaysAt, slayGroupText, slayShortGroupText, slotName,
} from '@muse/shared';
import { api } from '../api';
import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getLocale, getPref, tr } from '../util';
import { DIR_ARROW, expStatusLabel, extractBlockLabel, lifelineEffectText, worstTurnText } from './labels';
import { SeasonCampPanel } from './season';

/** 守護者を倒す・遺物を持ち帰る等の目的を、自分が extract したら達成になる状態か（表示用。最終判定はサーバー） */
export function completesOnExtract(x: ExpeditionView): boolean {
  if (x.status !== 'objective_complete') return false;
  return x.objective.type !== 'retrieve_relic' || x.progress.relicHeldByYou;
}

/** カタログの公開ルール（古いサーバーで条件・戦利品の定義が無ければ undefined） */
export function rulesOf(catalog: Catalog | null | undefined): CatalogRules | undefined {
  const r = catalog?.rules;
  return r?.traits && r.haul && r.recommendedLevel ? r : undefined;
}

// ---- 共通の小部品 ----

export function SlotBadge({ slot }: { slot: OfferSlot | null | undefined }) {
  if (!slot) return null;
  return <span class={`slot-badge ${slot}`}>{slotName(getLocale(), slot)}</span>;
}

const signed = (n: number): string => (n > 0 ? `+${n}` : `${n}`);

/**
 * 候補の難しさ（V3-2R §14.4）: 推奨レベルと自分のレベルの差、条件の危険度の合計。段階に丸めない。
 * 「推奨 Lv6・あなた Lv2（差 +4）／条件 +1」。差が正（推奨より低い）なら強調する
 */
export function OfferGap({ rec, level, gap, traitDanger }: { rec: number | null; level: number; gap: number | null; traitDanger: number }) {
  if (rec === null && !traitDanger) return null;
  const cls = gap === null ? '' : gap >= 3 ? 'over far' : gap > 0 ? 'over' : 'ok';
  return (
    <span class={`ogap ${cls}`} title={tr('推奨レベル: その深さに着いたときのレベルの目安（公開の表）。差が正なら推奨より低い。条件: 遠征の条件の危険度の合計',
      'Recommended level: the typical level on arrival at that depth (public table). A positive gap means you are below it. Traits: sum of the traits\' danger')}>
      {rec !== null && (
        <>
          {tr(`推奨 Lv${rec}・あなた Lv${level}`, `recommended Lv${rec}, you Lv${level}`)}
          {gap !== null && <b class="gapn">{tr(`（差 ${signed(gap)}）`, ` (gap ${signed(gap)})`)}</b>}
        </>
      )}
      {traitDanger !== 0 && <span class="tdanger">{rec !== null ? tr('／', ' / ') : ''}{tr(`条件 ${signed(traitDanger)}`, `traits ${signed(traitDanger)}`)}</span>}
    </span>
  );
}

/** 条件（traits）: 名前と倍率を並べ、説明は本文に出す */
export function TraitList({ traits, rules, compact }: { traits: readonly string[]; rules: CatalogRules | undefined; compact?: boolean }) {
  if (!traits.length) return null;
  const L = getLocale();
  return (
    <ul class={`traits ${compact ? 'compact' : ''}`}>
      {traits.map((id) => {
        const t = rules?.traits[id];
        const name = t ? nameOf(t.name, L, id) : id;
        const desc = t ? nameOf(t.desc, L, '') : '';
        return (
          <li key={id} title={desc}>
            <b>{name}</b>{t ? <span class="tmult"> {multText(t.multiplierPct)}</span> : null}
            {!compact && desc ? <span class="tdesc"> — {desc}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

// ---- 戦利品（未確定の点） ----

/** 戦利品の表示用の要約。プレイヤー視点は観測の expedition.haul から、俯瞰は World から作る */
export interface HaulInfo {
  total: number;
  parts: HaulParts;
  multiplierPct: number;
  /** 今 extract したら確定する点（プレイヤー視点のみ） */
  ifExtractNow?: number;
  /** 今 extract すると撤退になる（目的の基礎点を除いて withdrawPct %、倍率なし） */
  withdraw?: boolean;
  withdrawPct?: number;
  /** 今ここで帰還の綱を使ったら確定する点（綱を持っているときだけ。プレイヤー視点のみ。V3-2R2 §18.1） */
  ifLifelineNow?: number;
  /** 綱で確定する割合（%）と、戻るまでの手番（0 ならその場で戻る。V3-2R3 §20.3） */
  lifelinePct?: number;
  lifelineTurns?: number;
  /**
   * 次の踏破: その階の下り階段に立てば点が入る（V3-2R §14.1）。
   * here: 今その階にいる（pathLen が null なら下り階段は未発見）。俯瞰では here を付けない。
   * dir: 下り階段が未発見のときの「下への風」の方角（V3-2R2 §18.4）
   */
  next: { depth: number; points: number; pathLen?: number | null; here?: boolean; dir?: Dir } | null;
  /**
   * 今帰った場合の次の候補の下限と推奨レベル。目標として達成した最深の階から数える
   * （目的を達成して帰れば深くなる。踏破で先まで降りても深くならない。V3-2R3 §20.2）
   */
  nextCamp?: { minTargetDepth: number; recommendedLevel: number } | null;
  /** 自分のレベル（次の候補の推奨レベルと比べる。プレイヤー視点のみ） */
  level?: number;
  /** 確定済みの点（プレイヤー視点のみ） */
  banked?: number;
}

export function haulFromObs(ox: ObsExpedition | undefined, banked: number, rules: CatalogRules | undefined, level?: number): HaulInfo | null {
  const h = ox?.haul;
  if (!ox || !h) return null;
  const nx = h.next_overreach;
  const nc = h.next_camp;
  return {
    total: h.total, parts: h.parts, multiplierPct: h.multiplier_pct, ifExtractNow: h.if_extract_now,
    withdraw: ox.extract_outcome === 'withdraw', withdrawPct: rules?.haul.withdrawPct,
    ...(h.if_lifeline_now !== undefined ? { ifLifelineNow: h.if_lifeline_now, lifelinePct: rules?.lifeline?.pct, lifelineTurns: rules?.lifeline?.turns } : {}),
    next: nx ? { depth: nx.depth, points: nx.points, pathLen: nx.path_len, here: ox.progress.depth === nx.depth, ...(nx.dir ? { dir: nx.dir } : {}) } : null,
    nextCamp: nc ? { minTargetDepth: nc.min_target_depth, recommendedLevel: nc.recommended_level } : null,
    level, banked,
  };
}

/** 「地下4階の下り階段に着けば +600（経路 23）」「（未発見・下への風は南東 ↘）」 */
export function nextOverreachText(n: NonNullable<HaulInfo['next']>): string {
  const L = getLocale();
  const where = !n.here ? ''
    : n.pathLen !== null && n.pathLen !== undefined ? tr(`（経路 ${n.pathLen}）`, ` (path ${n.pathLen})`)
      : n.dir ? tr(`（未発見・下への風は${dirLabel(L, n.dir)} ${DIR_ARROW[n.dir]}）`, ` (not found yet; the draft blows ${dirLabel(L, n.dir)} ${DIR_ARROW[n.dir]})`)
        : tr('（未発見）', ' (not found yet)');
  return tr(`地下${n.depth}階の下り階段に着けば +${n.points}${where}`, `Reach the down stairs of depth ${n.depth}: +${n.points}${where}`);
}

/** 「帰ると次の候補は地下5階以上・推奨 Lv4」 */
export function nextCampText(c: NonNullable<HaulInfo['nextCamp']>): string {
  return tr(`帰ると次の候補は地下${c.minTargetDepth}階以上・推奨 Lv${c.recommendedLevel}`, `If you extract now, next offers start at depth ${c.minTargetDepth} (recommended Lv${c.recommendedLevel})`);
}

/** 「帰還の綱なら +120（戦利品の 50%・その場でキャンプへ）」。戻るまでに手番がかかるルールなら「2 手番動けない」 */
export function lifelineNowText(h: Pick<HaulInfo, 'ifLifelineNow' | 'lifelinePct' | 'lifelineTurns'>): string {
  const pct = h.lifelinePct ?? 50;
  const turns = h.lifelineTurns ?? 0;
  return turns > 0
    ? tr(`帰還の綱なら +${h.ifLifelineNow}（目的を除く戦利品の ${pct}%・${turns} 手番動けない）`, `Lifeline now: +${h.ifLifelineNow} (${pct}% of the haul without the objective, ${turns} turns helpless)`)
    : tr(`帰還の綱なら +${h.ifLifelineNow}（目的を除く戦利品の ${pct}%・その場でキャンプへ）`, `Lifeline now: +${h.ifLifelineNow} (${pct}% of the haul without the objective, back to camp at once)`);
}

export function HaulBlock({ h }: { h: HaulInfo }) {
  const L = getLocale();
  const parts = partsText(L, h.parts);
  const pct = h.withdrawPct ?? 50;
  return (
    <div class="haul">
      <div class="haul-total">
        <span class="lbl" title={tr('持ち帰って初めて確定する。死ぬと失う', 'Banked only when you extract; lost on death')}>{tr('戦利品（未確定）', 'Haul (unbanked)')}</span>
        <b>{h.total}</b>
        <span class="mult" title={tr('帰還（達成）したときに掛かる倍率', 'Multiplier applied when you extract with the objective complete')}>{multText(h.multiplierPct)}</span>
        {h.banked !== undefined && <span class="banked">{tr(`確定済み ${h.banked}`, `banked ${h.banked}`)}</span>}
      </div>
      <div class="haul-parts">{parts || tr('まだ無い', 'nothing yet')}</div>
      {(h.ifExtractNow !== undefined || h.ifLifelineNow !== undefined || h.next) && (
        <div class="haul-now">
          {h.ifExtractNow !== undefined && (
            <span class={`now ${h.withdraw ? 'withdraw' : 'complete'}`} title={tr('階段の上で extract したとき（追跡中の敵が見えていてもよい）', 'When you extract on stairs (even with hunters in view)')}>
              {h.withdraw
                ? tr(`今撤退すれば +${h.ifExtractNow}（目的を除いた ${pct}%・倍率なし）`, `Withdraw now: +${h.ifExtractNow} (${pct}% without the objective, no multiplier)`)
                : tr(`今帰れば +${h.ifExtractNow}`, `Extract now: +${h.ifExtractNow}`)}
            </span>
          )}
          {h.ifLifelineNow !== undefined && (
            <span class="life" title={tr(`帰還の綱（L）: 階段から遠くても使える。${lifelineEffectText(h.lifelineTurns)}。倍率は掛からない`, `Lifeline (L): usable anywhere; ${lifelineEffectText(h.lifelineTurns)}. No multiplier`)}>
              {lifelineNowText(h)}
            </span>
          )}
          {h.next && (
            <span class="next" title={tr('踏破: 目標より深い階の下り階段に立ったときに点が入る（着いただけでは入らない）', 'Crossing: points are added when you stand on the down stairs of a floor deeper than the target (arriving is not enough)')}>
              {nextOverreachText(h.next)}
            </span>
          )}
        </div>
      )}
      {h.nextCamp && (
        <div class={`haul-camp ${h.level !== undefined && h.nextCamp.recommendedLevel > h.level ? 'over' : ''}`}
          title={tr('次の遠征の候補の目標深度は、目標として達成した最深の階が基準になる（目的を達成して帰ると深くなる。踏破で先まで降りても深くならない）',
            'Next offers count from the deepest target you have completed (completing this objective moves them deeper; crossing further floors does not)')}>
          {nextCampText(h.nextCamp)}{h.level !== undefined ? tr(`（あなた Lv${h.level}）`, ` (you Lv${h.level})`) : ''}
        </div>
      )}
    </div>
  );
}

/** extract の確認文。確定する点（if_extract_now）と、撤退なら目的を除いた withdrawPct % だけが確定することを書く */
export function extractConfirmText(ox: ObsExpedition | undefined, complete: boolean, rules: CatalogRules | undefined): string {
  const h = ox?.haul;
  const pct = rules?.haul.withdrawPct ?? 50;
  const info = haulFromObs(ox, 0, rules);
  const refs = [info?.next ? nextOverreachText(info.next) : '', info?.nextCamp ? nextCampText(info.nextCamp) : ''].filter(Boolean);
  const next = refs.length ? tr(`\n（参考: ${refs.join(' / ')}）`, `\n(For reference: ${refs.join(' / ')})`) : '';
  // 帰還する階段から次の遠征が始まる（V3-2R3 §20.6）
  // 野営の火から帰るとき（シーズン。S1c §14.3）は、帰り支度の手番と、次はそのマスから
  const via = ox?.extract_via;
  const from = via?.type === 'fire'
    ? tr(`\n${via.by} の野営の火から帰る: 帰り支度 ${via.turns} 手番（この手番を含む。その間に追ってくる敵が見えたり、被害を受けたりしたら取りやめ。過ごした手番は戻らない）。次の遠征は、このマスから始まる。`,
      `\nReturning from ${via.by}'s campfire: ${via.turns} turns packing up (this one included; cancelled if a hunter comes into view or you are hurt, and the turns spent are not refunded). The next expedition starts from this cell.`)
    : tr('\n次の遠征はこの階段から始まる。その階の敵は追跡をやめて全快する。', '\nThe next expedition starts from these stairs; monsters there stop hunting and heal fully.');
  if (complete) {
    const pay = h ? tr(`\n確定する点: +${h.if_extract_now}（戦利品 ${h.total} ${multText(h.multiplier_pct)}）`, `\nBanked: +${h.if_extract_now} (haul ${h.total} ${multText(h.multiplier_pct)})`) : '';
    return tr(`帰還して遠征${ox ? ` ${ox.no}` : ''}を終えますか？${pay}${from}${next}`, `Extract and end the expedition?${pay}${from}${next}`);
  }
  const pay = h
    ? tr(`\n撤退で確定するのは、目的の基礎点を除いた戦利品の ${pct}% だけ（倍率なし）: +${h.if_extract_now}`, `\nA withdrawal banks only ${pct}% of the haul without the objective (no multiplier): +${h.if_extract_now}`)
    : tr(`\n撤退では目的の基礎点は入らず、戦利品の ${pct}% だけが確定する。`, `\nA withdrawal banks only ${pct}% of the haul, without the objective.`);
  return tr(`目的は未達成です。今 extract すると撤退になり、この遠征は終わります。${pay}${from}${next}\n撤退しますか？`,
    `The objective is not complete. Extracting now withdraws and ends this expedition.${pay}${from}${next}\nWithdraw?`);
}

/**
 * 帰還の綱の確認文（V3-2R2 §18.1・V3-2R3 §20.3）: 戻り方（lifeline.turns が 0 ならその場で戻る）・確定する点（if_lifeline_now）・
 * 今の追跡中の敵の被害見込み（押し切るか半分で帰るかを比べる材料）・参考の階段の extract。
 * 文と数値は観測から並べるだけ（判定はサーバー）
 */
export function lifelineConfirmText(obs: Observation | null, rules: CatalogRules | undefined, itemName: string): string {
  const ox = obs?.expedition;
  const h = ox?.haul;
  const turns = rules?.lifeline?.turns ?? 0;
  const pct = rules?.lifeline?.pct ?? 50;
  const lines = [
    tr(`${itemName}を使いますか？`, `Use the ${itemName}?`),
    turns > 0
      ? tr(`${turns} 手番のあいだ動けず（その間も攻撃は受ける）、その後キャンプへ戻ってこの遠征を終える。達成した遠征には数えない。`,
        `You cannot act for ${turns} turns (you are still attacked), then return to camp and this expedition ends. It does not count as a completed expedition.`)
      : tr('使った手番でその場からキャンプへ戻り、この遠征を終える。達成した遠征には数えない。',
        'You return to camp from here this turn and this expedition ends. It does not count as a completed expedition.'),
  ];
  if (h?.if_lifeline_now !== undefined) {
    lines.push(tr(`確定する点: +${h.if_lifeline_now}（戦利品 ${h.total} の ${pct}%・倍率なし${ox?.extract_outcome === 'complete' ? '' : '・目的は未達成なので目的の点は入らない'}）`,
      `Banked: +${h.if_lifeline_now} (${pct}% of the haul ${h.total}, no multiplier${ox?.extract_outcome === 'complete' ? '' : '; the objective is not complete, so its points are not included'})`));
  }
  // 1 手・2 手で倒されうる（worst_turn から。V3-2R3 §20.4）と群れの見込み
  const lethal = obs?.alerts.find((a) => a.code === 'lethal_range' || a.code === 'lethal_2turns');
  if (lethal) lines.push(`⚠ ${lethal.text}`);
  const incoming = obs?.alerts.find((a) => a.code === 'incoming');
  const hunters = obs?.visible.monsters.filter((m) => m.awareness === 'hunting' && !m.fleeing) ?? [];
  if (incoming) lines.push(tr(`今の群れ: ${incoming.text}`, `Pursuers: ${incoming.text}`));
  else if (hunters.length) {
    const m = hunters[0];
    const per = worstTurnText(m);
    lines.push(tr(`追跡中: ${m.name}（${m.worst_hit !== null ? `最大の一撃 ${m.worst_hit}${per ? `・${per}` : ''}` : '一撃の大きさは不明'}）・あなたの HP ${obs?.self.hp ?? '?'}`,
      `Hunting you: ${m.name} (${m.worst_hit !== null ? `worst hit ${m.worst_hit}${per ? `, ${per}` : ''}` : 'hit size unknown'}), your HP ${obs?.self.hp ?? '?'}`));
  }
  const st = obs?.navigation.known_stairs.filter((s) => s.path_len !== null).sort((a, b) => a.path_len! - b.path_len!)[0];
  if (h && st) {
    lines.push(tr(`（参考: 階段の上で extract すれば +${h.if_extract_now}${ox?.extract_outcome === 'complete' ? '' : '（撤退）'}。最寄りの階段まで ${st.path_len} 歩）`,
      `(For reference: extracting on stairs banks +${h.if_extract_now}${ox?.extract_outcome === 'complete' ? '' : ' (withdrawal)'}; nearest stairs ${st.path_len} steps away)`));
  }
  return lines.join('\n');
}

// ---- 結果（払い戻し） ----

/** 終了した遠征の結果。payout があれば確定点と内訳、無ければ従来の文章 */
export function ResultBlock({ x, playerId, rules }: { x: ExpeditionView; playerId?: string; rules?: CatalogRules }) {
  const L = getLocale();
  const r = x.result;
  if (!r) return null;
  const pay = r.payout;
  if (!pay) return <div class="result">{resultText(L, x)}</div>;
  const mine = playerId ? pay.players.find((p) => p.player === playerId) : pay.players.length === 1 ? pay.players[0] : undefined;
  const banked = mine ? mine.banked : pay.banked;
  const lost = mine ? mine.lost : pay.lost;
  const parts = partsText(L, pay.parts);
  const how = r.reason === 'completed' ? `${tr('倍率', 'multiplier')} ${multText(pay.multiplierPct)}`
    : r.reason === 'withdrawn' ? tr(`撤退: 目的を除いて ${rules?.haul.withdrawPct ?? 50}%`, `withdrawal: ${rules?.haul.withdrawPct ?? 50}% without the objective`)
      : r.reason === 'lifeline' ? tr(`帰還の綱: 戦利品の ${rules?.lifeline?.pct ?? 50}%（倍率なし）`, `lifeline: ${rules?.lifeline?.pct ?? 50}% of the haul (no multiplier)`)
        : tr('死亡・引退では確定しない', 'nothing is banked on death or retirement');
  return (
    <div class={`result payout ${r.reason}`}>
      <div class="rhead">
        {tr(`遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）`, `Expedition ${x.no} ended (${endReasonText(L, r.reason)})`)}
      </div>
      <div class="rpay">
        <span class="gain">{tr(`確定 +${banked}`, `Banked +${banked}`)}</span>
        {lost > 0 && <span class="lost">{tr(`失った戦利品 ${lost}`, `lost ${lost}`)}</span>}
      </div>
      <div class="rparts muted">{tr('内訳', 'Parts')}: {parts || tr('なし', 'none')} / {how}</div>
      <div class="muted">{tr(`この遠征: 最深 地下${r.deepest}階・撃破 ${r.kills}・手番 ${r.turns}`, `This expedition: deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`)}</div>
    </div>
  );
}

// ---- プレイ画面 ----

/** onLifeline: 帰還の綱を持っていれば extract の行に「帰還の綱を使う」を添える（確認は呼び出し側） */
export function ExpeditionPanel({ view, obs, catalog, onBriefing, onLifeline }: {
  view: PlayerView; obs: Observation | null; catalog?: Catalog | null; onBriefing?: () => void; onLifeline?: () => void;
}) {
  const x = view.expedition;
  if (!x) return null;
  const L = getLocale();
  const rules = rulesOf(catalog);
  const st = expStatusLabel(x);
  const ox = obs?.expedition;
  const active = x.status !== 'ended' && view.status !== 'at_camp';
  const done = completesOnExtract(x);
  const haul = active ? haulFromObs(ox, view.record.banked, rules, view.self.level) : null;
  const now = ox?.haul?.if_extract_now;
  const sense = active ? ox?.sense : undefined;
  return (
    <section class="panel exp">
      <h3>
        {tr(`遠征 ${x.no}`, `Expedition ${x.no}`)}
        <SlotBadge slot={x.slot} />
        <span class={`badge ${st.key}`}>{st.text}</span>
        {x.objective.type !== 'endless' && <small>{tr(`目的 +${x.points}`, `objective +${x.points}`)}</small>}
        {onBriefing && <button class="tiny right" onClick={onBriefing}>{tr('ブリーフィング', 'Briefing')}</button>}
      </h3>
      <div class="objective">{objectiveText(L, x.objective)}</div>
      <div class="progress">{progressText(L, x, view.floor?.depth ?? null)}</div>
      {sense && <SenseLine sense={sense} />}
      {x.traits.length > 0 && <TraitList traits={x.traits} rules={rules} compact />}
      {haul && <HaulBlock h={haul} />}
      {active && ox && (
        <div class={`extract ${ox.can_extract ? 'ok' : 'no'}`}
          title={ox.can_extract ? tr('次の遠征はこの階段から始まる（その階の敵は追跡をやめて全快する）', 'The next expedition starts from these stairs (monsters there stop hunting and heal fully)') : undefined}>
          {ox.can_extract && ox.extract_via?.type === 'fire' && <span class="svia">{tr(`${ox.extract_via.by} の野営の火から・帰り支度 ${ox.extract_via.turns} 手番。`, `From ${ox.extract_via.by}'s campfire, ${ox.extract_via.turns} turns packing up. `)}</span>}
          {ox.can_extract
            ? (done
              ? tr(`extract 可（E）: 今 extract すると帰還（達成）${now !== undefined ? `・+${now} 確定` : ''}`, `extract possible (E): completes the expedition${now !== undefined ? `, banks +${now}` : ''}`)
              : tr(`extract 可（E）: 今 extract すると撤退（目的を除く ${rules?.haul.withdrawPct ?? 50}%${now !== undefined ? `・+${now} 確定` : ''}）`,
                `extract possible (E): withdraw (${rules?.haul.withdrawPct ?? 50}% without the objective${now !== undefined ? `, banks +${now}` : ''})`))
            : `${tr('extract 不可', 'cannot extract')}（${extractBlockLabel(ox.extract_blocked_by)}）`}
          {/* 階段の上なら extract の方が得か同じで手番もかからないので、綱は階段から離れているときだけ出す */}
          {onLifeline && !ox.can_extract && ox.haul?.if_lifeline_now !== undefined && (
            <button class="tiny lifeline right" onClick={onLifeline}
              title={tr('階段から遠くても使える退却。確定する点と手番の数を確認してから使う', 'A retreat usable anywhere. Shows the banked points and turns before using it')}>
              {tr(`帰還の綱を使う（L）+${ox.haul.if_lifeline_now}`, `Use lifeline (L) +${ox.haul.if_lifeline_now}`)}
            </button>
          )}
        </div>
      )}
      {x.status === 'ended' && x.result && <ResultBlock x={x} playerId={view.playerId} rules={rules} />}
    </section>
  );
}

/** 目標の気配（目標階にいる間。方角と 10 マス以内かどうか。地図では自分の横に矢印を出す） */
export function SenseLine({ sense }: { sense: NonNullable<ObsExpedition['sense']> }) {
  return (
    <div class={`sense ${sense.what} ${sense.range}`} title={tr('正確な位置は、見るまで分からない', 'The exact position is unknown until you see it')}>
      <span class="sarrow">{DIR_ARROW[sense.dir] ?? '?'}</span> {sense.text}
    </div>
  );
}

export function BriefingCard({ x, catalog, onClose }: { x: ExpeditionView; catalog?: Catalog | null; onClose: () => void }) {
  const lines = briefingLines(getLocale(), x, rulesOf(catalog));
  return (
    <div class="briefing">
      {lines.map((l, i) => <div key={i} class={i === 0 ? 'head' : ''}>{l}</div>)}
      <div class="row end"><button class="small primary" onClick={onClose}>{tr('閉じる', 'Close')}</button></div>
    </div>
  );
}

/** ▶ の状態行と、前回の自分の手番以降の変化。守護者が倒れたことは、ほかの変化と別の行で先頭に出す（V3-2R2 §18.6） */
export function TurnBar({ line, changes }: { line: string; changes: Change[] }) {
  if (!line && !changes.length) return null;
  const head = changes.filter((c) => c.code === 'guardian_slain');
  const rest = changes.filter((c) => c.code !== 'guardian_slain');
  return (
    <div class="turnbar">
      {line && <div class="turnline">{line}</div>}
      {head.map((c, i) => <div key={`head-${i}`} class="chg-head guardian_slain">{c.text}</div>)}
      {rest.length > 0 && (
        <div class="changes">
          <span class="lbl">{tr('前の手番からの変化', 'Since your last turn')}:</span>
          {rest.map((c, i) => <span key={`${c.code}-${i}`} class={`chg ${c.code}`}>{c.text}</span>)}
        </div>
      )}
    </div>
  );
}

export function RestEstimateLine({ est }: { est: RestEstimate }) {
  const block = est.blocked_by === 'hostile_hunting' ? tr('（今は追跡中の敵が見えるので休めない）', ' (blocked: a hunting enemy is in view)')
    : est.blocked_by === 'poisoned' ? tr('（毒が抜けるまで休憩は続く）', ' (rest continues until the poison wears off)') : '';
  return (
    <div class={`restest ${est.blocked_by ? 'blocked' : ''}`}>
      {tr(`休憩の見積もり: HP ${est.cap_hp} まで ${est.turns} 手（HP +${est.hp_to_full}・時間 ${est.time}・その間の徘徊の目安 ${est.wander_expected} 体。休憩で戻るのはここまで）`,
        `Rest estimate: ${est.turns} turns to ${est.cap_hp} HP (HP +${est.hp_to_full}, time ${est.time}, wanderers expected ${est.wander_expected}; rest heals no further)`)}
      {block}
    </div>
  );
}

function OfferCard({ o, rules, level, onStart, view, catalog }: { o: ExpeditionOffer; rules: CatalogRules | undefined; level: number; onStart: (offer: number) => void; view?: PlayerView; catalog?: Catalog | null }) {
  const L = getLocale();
  // 大守護者と、通り道の群れている階も危険度に入れる（AI の候補と同じ。V4-0e §8.1）
  const g = rules ? offerGap(rules, o.objective.targetDepth, o.traits ?? [], level, offerWardenExtra(o)) : null;
  const ft = offerFloorTraitsText(L, rules, o);
  const guarded = o.objective.type === 'retrieve_relic' && o.relicGuarded ? tr('（守護者付き）', ' (guarded)') : '';
  return (
    <li class={`offer ${o.slot ?? ''}`}>
      <div class="ohead">
        <span class="oidx">{o.index})</span>
        <SlotBadge slot={o.slot} />
        <span class="otext">{objectiveText(L, o.objective)}{guarded}</span>
        <button class="small primary" onClick={() => onStart(o.index)}>{tr('この遠征に出る', 'Start')}</button>
      </div>
      <div class="ometa">
        <span>{tr(`基礎 +${o.points}`, `base +${o.points}`)}</span>
        <span class="omult" title={tr('帰還（達成）したとき戦利品に掛かる倍率', 'Multiplier on the haul when you extract with the objective complete')}>
          {tr('倍率', 'multiplier')} {multText(o.multiplierPct ?? 100)}
        </span>
        {g && <OfferGap rec={g.recommendedLevel} level={level} gap={g.levelGap} traitDanger={g.traitDanger} />}
        {o.guardian && (
          <span class={`oguard r${o.guardian.rank}`}
            title={tr('守護者の見込み: 格（枠で決まる。格が高いほど体力が多い）と見れば分かる特徴。種族は会うまで分からない', 'Guardian forecast: rank (set by the slot; higher ranks have more HP) and visible traits. The species stays unknown until you meet it')}>
            {guardianForecastText(L, o.guardian)}
          </span>
        )}
        {o.bounty && (
          <span class="oguard r2" title={tr('賞金首: 名前付きの強敵。種族・接辞・名前は候補の時点で分かる', 'Bounty: a named elite. Its kind, affixes and name are known from the offer')}>
            {bountyForecastText(L, o.bounty)}
          </span>
        )}
        {o.vault && <span class="oguard">{tr('宝物庫: 鍵を持つ敵が階にいる', 'vault: a monster on the floor carries the key')}</span>}
        {o.scar ? <span class="oguard" title={tr('前の挑戦で与えたダメージの 4 分の 1 が残っている', 'A quarter of the damage you dealt last time stays')}>{tr(`傷跡で体力 −${o.scar}`, `scars: −${o.scar} HP`)}</span> : null}
        {ft ? <span class="oguard" title={tr('前の遠征の条件で作られた階は、その性質のまま残っている（まだ作られていない階については出ない）', 'Floors made under an earlier expedition\'s traits keep them (floors not made yet are not listed)')}>{ft}</span> : null}
      </div>
      {/* いまの持ち物で 1 回に通る目安（守護者・賞金首。AI の候補の文と同じ。V3-8a §56.1） */}
      {/* 大守護者も（S3a）。記録庫で体力が分かっていれば命中の回数・護られし者は火の間の装甲（S3b §30.3 の 4） */}
      {view && catalog && (o.bounty || o.guardian?.armor !== undefined) && (
        <div class="ometa"><span>{o.bounty
          ? gearVsArmorText(L, catalog, view, o.bounty.armor, Math.max(1, o.bounty.hp - (o.scar ?? 0)))
          : gearVsArmorText(L, catalog, view, o.guardian!.armor!, offerGuardianHp(view, o), o.guardian!.types ?? [])}</span></div>
      )}
      {/* 討伐の記録（S4 §35.5）: まだ倒していない大守護者を倒す候補に、先に倒した参加者の戦いの事実（AI の候補の文と同じ短い形。S5a。全文はキャンプの記録庫の枠） */}
      {view && catalog && o.objective.type === 'slay_warden' && o.objective.targetDepth !== null && !(view.milestonesCleared ?? []).includes(o.objective.targetDepth)
        && slaysAt(L, catalog, view, o.objective.targetDepth).length > 0 && (
        <div class="ometa slay"><span>{slayShortGroupText(L, slaysAt(L, catalog, view, o.objective.targetDepth))}</span></div>
      )}
      <TraitList traits={o.traits ?? []} rules={rules} />
    </li>
  );
}

/**
 * プロフィールの記録の 1 行（V3-7 §7.2。AI のキャンプの観測と同じ文）。トークンはロビーで作ったランのものがブラウザに残っている。
 * 遠征が終わるたび（nextNo が変わる）に読み直す
 */
function CampRecords({ nextNo }: { nextNo: number }) {
  const [line, setLine] = useState<string | null>(null);
  useEffect(() => {
    const tok = getPref('profileToken', '');
    if (!tok) { setLine(null); return; }
    const L = getLocale();
    api.records(tok, L).then((r) => setLine(recordsCampLine(L, r.records))).catch(() => setLine(null));
  }, [nextNo]);
  if (!line) return null;
  return <p class="muted records-line">{line} <a href="#/">{tr('（ロビーで全文）', '(full text in the lobby)')}</a></p>;
}

/**
 * 今あるメモ（S7。SEASON.md §52.2 の 4）: キャンプで、自分用メモを新しい順に読むだけで出す（AI のキャンプの観測と同じ 8 件まで）。
 * 観戦（追従）でも、持ち主と同じ機械からの観戦（開催中のシーズンの決まりのまま）で、相手のメモが読める
 */
export function NotesBlock({ notes, who }: { notes: readonly string[]; who?: string }) {
  if (!notes.length) return null;
  const shown = notes.map((text, index) => ({ index, text })).reverse().slice(0, CHECKPOINT_NOTES);
  return (
    <div class="notes">
      <h3>{who ? tr(`${who} のメモ（新しい順）`, `${who}'s notes (newest first)`) : tr('あなたのメモ（新しい順）', 'Your notes (newest first)')}{notes.length > shown.length ? tr(`・全 ${notes.length} 件のうち ${shown.length} 件`, ` — ${shown.length} of ${notes.length}`) : ''}</h3>
      <ul>{shown.map((n) => <li key={n.index}><small>{n.index}</small> {n.text}</li>)}</ul>
    </div>
  );
}

/** キャンプ（遠征と遠征の間）。成績・前の遠征の払い戻し・候補を出し、次の遠征を選ぶか、ここで終える */
export function CampPanel({ view, catalog, onStart, onRetire, season, canReport, onReport }: {
  view: PlayerView; catalog?: Catalog | null; onStart: (offer: number | 'endless') => void; onRetire: () => void;
  /** シーズン（S2 §18.1）: キャンプの観測の賞・報告・自分の火。報告は AI と同じ report_stairs */
  season?: ObsSeason; canReport?: boolean; onReport?: () => void;
}) {
  const x = view.expedition;
  const camp = view.camp;
  const rules = rulesOf(catalog);
  const rec = view.record;
  // 最初のキャンプ（new_run で objective を省いた）: 前の遠征も成績もまだ無い
  const first = !x;
  return (
    <div class="campbox">
      <h2>{first ? tr('キャンプ — 最初の遠征を選ぶ', 'Camp — choose your first expedition') : tr('キャンプ', 'Camp')}</h2>
      {!first && (
        <div class="record">
          <span>{tr('確定点', 'Banked')} <b>{rec.banked}</b></span>
          <span>{tr('達成した遠征', 'Expeditions completed')} <b>{rec.expeditions}</b></span>
          {rec.lost > 0 && <span class="lost">{tr('失った戦利品', 'Haul lost')} <b>{rec.lost}</b></span>}
        </div>
      )}
      {x?.result && <ResultBlock x={x} playerId={view.playerId} rules={rules} />}
      <p class="muted">
        {first
          ? tr(`盤面の外にいる（時間は進まない）。HP ${view.self.stats.hp}/${view.self.stats.maxHp}・Lv${view.self.level}。目標の深さ・推奨レベル・条件を比べて、3 つの候補から最初の遠征を選ぶ。`,
            `You are off the board (time does not pass). HP ${view.self.stats.hp}/${view.self.stats.maxHp}, Lv${view.self.level}. Compare depth, recommended level and traits, and pick your first expedition.`)
          : tr(`盤面の外にいる（時間は進まない）。HP ${view.self.stats.hp}/${view.self.stats.maxHp}・Lv${view.self.level}。最深到達: 地下${view.deepestDepth}階。ここで終えてもよい。`,
            `You are off the board (time does not pass). HP ${view.self.stats.hp}/${view.self.stats.maxHp}, Lv${view.self.level}. Deepest: ${view.deepestDepth}. You may stop here.`)}
      </p>
      {camp && <CampRecords nextNo={camp.nextNo} />}
      <NotesBlock notes={view.notes} />
      {season && <SeasonCampPanel season={season} canReport={!!canReport} onReport={() => onReport?.()} />}
      {/* 討伐の記録（S4 §35.5）: キャンプの記録庫の行（節目ごと。AI のキャンプの観測と同じ文） */}
      {catalog && (view.season?.slays ?? []).length > 0 && (
        <div class="slays">
          <h3>{tr('記録庫・討伐の記録', 'Archive: warden kills')}</h3>
          <ul>{[...new Set((view.season?.slays ?? []).map((s) => s.depth))].sort((a, b) => a - b).map((depth) => (
            <li key={depth}><b>{tr(`地下${depth}階`, `Depth ${depth}`)}</b>{slaysAt(getLocale(), catalog, view, depth).map((r, i) => <div key={i} class="slay">{slayGroupText(getLocale(), [r])}</div>)}</li>
          ))}</ul>
        </div>
      )}
      {camp ? (
        <>
          <h3>{first ? tr(`最初の遠征の候補（遠征 ${camp.nextNo}）`, `Offers for expedition ${camp.nextNo}`) : tr(`次の遠征の候補（遠征 ${camp.nextNo}）`, `Offers for expedition ${camp.nextNo}`)}</h3>
          <ul class="offers cards">
            {camp.offers.map((o) => <OfferCard key={o.index} o={o} rules={rules} level={view.self.level} onStart={onStart} view={view} catalog={catalog} />)}
            <li class="offer endless">
              <div class="ohead">
                <span class="otext">{tr('endless) 目的なし。できるだけ深く潜る', 'endless) No objective: descend as deep as you can')}</span>
                <button class="small" onClick={() => onStart('endless')}>{tr('目的なしで出る', 'Start endless')}</button>
              </div>
            </li>
          </ul>
        </>
      ) : (
        <p>{tr('仲間の遠征が終わるまで、次の遠征は選べない。', 'The next expedition can be chosen when your allies finish.')}</p>
      )}
      <div class="row">
        <button class="small danger" onClick={onRetire}>{tr('引退してランを終える', 'Retire (end the run)')}</button>
      </div>
    </div>
  );
}

// ---- 観戦・リプレイ ----

export interface ExpInfo {
  title: string;
  status: { key: string; text: string };
  slot?: OfferSlot | null;
  traits?: string[];
  rules?: CatalogRules;
  progress: string;
  haul?: HaulInfo | null;
  /** 終了した遠征（結果の表示用）と、結果を誰の視点で見せるか */
  ended?: ExpeditionView;
  playerId?: string;
  note?: string;
  offers?: string[];
  /** 追従しているプレイヤーの気配（その人の知識。俯瞰では出さない） */
  sense?: NonNullable<ObsExpedition['sense']>;
}

function viewOf(x: Expedition): ExpeditionView {
  return {
    no: x.no, objective: x.objective, points: x.points, relicGuarded: x.relicGuarded, status: x.status, endReason: x.endReason,
    progress: { reached: x.progress.reached, guardianSlain: x.progress.guardianSlain, relicHeld: x.progress.relicHeldBy !== null, relicHeldByYou: false, ...(x.progress.vaultOpened ? { vaultOpened: true } : {}) },
    extracted: false, returns: x.extracted.map((r) => ({ player: r.player, completed: r.completed, lifeline: !!r.lifeline })), result: x.result, startSeq: x.startSeq, endSeq: x.endSeq,
    slot: x.slot ?? null, traits: [...(x.traits ?? [])], multiplierPct: x.multiplierPct ?? 100,
    haul: { ...(x.haul ?? { bounty: 0, discovery: 0, kills: 0 }) }, maxDepth: x.progress.maxDepth ?? 0, crossedDepth: x.progress.crossedDepth ?? 0,
  };
}

function titleOf(x: { no: number; objective: ExpeditionView['objective'] }): string {
  return `${tr(`遠征 ${x.no}`, `Expedition ${x.no}`)}: ${objectiveText(getLocale(), x.objective)}`;
}

/**
 * 俯瞰の戦利品: 共有分（賞金・発見・撃破）＋目的＋踏破＋参加者が持っている宝。
 * 踏破の点は参加者が下り階段に立った最も深い階（progress.crossedDepth）で数える（着いただけでは入らない。V3-2R §14.1）。
 * 払い戻しはプレイヤーごとなので「今帰れば」は出さない（式は shared の overreachPoints / haulTotal / nextCampOf / campDepthOf）。
 */
function directorHaul(world: World, x: Expedition, rules: CatalogRules | undefined): HaulInfo | null {
  if (x.status === 'ended' || !rules) return null;
  let treasure = 0;
  for (const pid of x.participants) {
    const pr = world.players[pid];
    const me = pr ? world.entities[pr.entityId] : undefined;
    if (!me || pr.state !== 'alive') continue;
    for (const id of me.inv?.items ?? []) treasure += world.entities[id]?.item?.value ?? 0;
  }
  const shared = x.haul ?? { bounty: 0, discovery: 0, kills: 0 };
  const crossed = x.progress.crossedDepth ?? 0;
  // 踏破の点は目的の点（条件の倍率をかける前の x.points）に比例する（V3-2R2 §18.4）
  const parts: HaulParts = {
    objective: x.status === 'objective_complete' ? x.points : 0,
    overreach: overreachPoints(rules, x.objective.targetDepth, crossed, x.points),
    treasure, bounty: shared.bounty, discovery: shared.discovery, kills: shared.kills,
  };
  // 次の候補は目標として達成した最深の階から数える（達成済みならこの遠征の目標階も含める。踏破では深くならない。V3-2R3 §20.2）
  const campDepth = campDepthOf(world);
  const reached = x.status === 'objective_complete' && x.objective.targetDepth !== null ? Math.max(campDepth, x.objective.targetDepth) : campDepth;
  const nc = rules.slots?.safe ? nextCampOf(rules, reached) : null;
  return { total: haulTotal(parts), parts, multiplierPct: x.multiplierPct ?? 100, next: nextOverreach(rules, x.objective.targetDepth, crossed, x.points), nextCamp: nc };
}

/** 俯瞰: World の最新の遠征。depth は表示中のフロアの深さ */
export function directorExpInfo(world: World, depth: number | null, catalog?: Catalog | null): ExpInfo | null {
  const x = latestExpedition(world);
  if (!x) return null;
  const rules = rulesOf(catalog);
  const o = x.objective;
  const parts: string[] = [];
  if (o.targetDepth !== null) parts.push(tr(`表示中 地下${depth ?? '-'}階 / 目標 地下${o.targetDepth}階`, `showing depth ${depth ?? '-'} / target ${o.targetDepth}`));
  // 踏破: 目標階の下り階段に立つと達成（V3-2R3 §20.1。文は shared の progressText と同じ）
  if (o.type === 'reach_depth') parts.push(x.progress.reached ? tr('目標階を踏破済み', 'target crossed') : tr('目標階の下り階段に未到達', 'target not crossed yet'));
  if (o.type === 'slay_warden') parts.push(x.progress.guardianSlain ? tr('大守護者: 討伐済み', 'warden: slain') : tr('大守護者: 未討伐', 'warden: alive'));
  if (o.type === 'slay_guardian') parts.push(x.progress.guardianSlain ? tr('守護者: 討伐済み', 'guardian: slain') : tr('守護者: 未討伐', 'guardian: alive'));
  if (o.type === 'slay_bounty') parts.push(x.progress.guardianSlain ? tr('賞金首: 討伐済み', 'bounty: slain') : tr('賞金首: 未討伐', 'bounty: alive'));
  if (o.type === 'open_vault') parts.push(x.progress.vaultOpened ? tr('宝物庫: 開けた', 'vault: opened') : tr('宝物庫: まだ開けていない', 'vault: still locked'));
  if (o.type === 'retrieve_relic') {
    const holder = x.progress.relicHeldBy ? world.entities[x.progress.relicHeldBy]?.player : undefined;
    const name = holder ? world.players[holder]?.name ?? holder : null;
    parts.push(name ? tr(`遺物: ${name} が所持`, `relic: carried by ${name}`) : tr('遺物: 未入手', 'relic: not held'));
  }
  const info: ExpInfo = {
    title: titleOf(x), status: expStatusLabel(x), slot: x.slot ?? null, traits: x.traits ?? [], rules, progress: parts.join(' | '),
    haul: directorHaul(world, x, rules),
  };
  if (x.result) info.ended = viewOf(x);
  if (!currentExpedition(world) && world.status === 'active') {
    info.note = world.camp
      ? tr(`キャンプ中: 次の遠征（遠征 ${world.camp.nextNo}）はまだ選ばれていない`, `At camp: expedition ${world.camp.nextNo} not chosen yet`)
      : tr('キャンプ中', 'At camp');
    if (world.camp) info.offers = world.camp.offers.map((c) => offerText(getLocale(), c));
  }
  return info;
}

/** 追従: 射影した PlayerView の遠征。catalog があれば観測と同じ計算で戦利品を出す */
export function followExpInfo(view: PlayerView, catalog?: Catalog | null): ExpInfo | null {
  const x = view.expedition;
  if (!x) return null;
  const L = getLocale();
  const rules = rulesOf(catalog);
  const info: ExpInfo = { title: titleOf(x), status: expStatusLabel(x), slot: x.slot, traits: x.traits, rules, progress: progressText(L, x, view.floor?.depth ?? null) };
  if (catalog && x.status !== 'ended' && view.status !== 'at_camp') {
    try {
      const ox = buildObservation(view, catalog, { detail: 'brief', map: false }).expedition;
      info.haul = haulFromObs(ox, view.record.banked, rules, view.self.level);
      if (ox?.sense) info.sense = ox.sense;
    } catch {
      info.haul = null;
    }
  }
  if (x.result) { info.ended = x; info.playerId = view.playerId; }
  if (view.status === 'at_camp') {
    info.note = view.camp
      ? tr(`${view.self.name} はキャンプにいる（確定 ${view.record.banked}）: 次の遠征（遠征 ${view.camp.nextNo}）はまだ選ばれていない`, `${view.self.name} is at camp (banked ${view.record.banked}): expedition ${view.camp.nextNo} not chosen yet`)
      : tr(`${view.self.name} はキャンプにいる（仲間の遠征の終了待ち）`, `${view.self.name} is at camp (waiting for allies)`);
    if (view.camp) info.offers = view.camp.offers.map((c) => offerText(L, c, rules ? { rules, level: view.self.level } : undefined));
  }
  return info;
}

export function ExpeditionStatusPanel({ info }: { info: ExpInfo | null }) {
  if (!info) return null;
  return (
    <section class="panel exp">
      <h3>{info.title} <SlotBadge slot={info.slot} /> <span class={`badge ${info.status.key}`}>{info.status.text}</span></h3>
      {info.progress && <div class="progress">{info.progress}</div>}
      {info.sense && <SenseLine sense={info.sense} />}
      {info.traits && info.traits.length > 0 && <TraitList traits={info.traits} rules={info.rules} compact />}
      {info.haul && <HaulBlock h={info.haul} />}
      {info.ended && <ResultBlock x={info.ended} playerId={info.playerId} rules={info.rules} />}
      {info.note && <div class="note">{info.note}</div>}
      {info.offers && info.offers.length > 0 && (
        <ul class="offers compact">{info.offers.map((o, i) => <li key={i}>{o}</li>)}</ul>
      )}
    </section>
  );
}

/**
 * 「AI の応答待ち（n 秒）」。probe は今の手番が AI 操作のプレイヤーならその名前を返す。
 * lastRef は最後にイベント・AI の記録を受け取った時刻（performance.now）。1 秒ごとに更新する。
 */
export function AgentWaitBadge({ probe, lastRef, thresholdS = 3 }: { probe: () => { name: string } | null; lastRef: RefObject<number>; thresholdS?: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const info = probe();
  if (!info || lastRef.current === null) return null;
  const s = Math.floor((performance.now() - lastRef.current) / 1000);
  if (s < thresholdS) return null;
  return <div class="aiwait">{tr(`AI の応答待ち（${s} 秒）`, `Waiting for the AI (${s}s)`)} — {info.name}</div>;
}

// 遠征まわりの表示部品: 目的と進捗、戦利品（未確定の点）、ブリーフィング、手番の状態行と変化、休憩の見積もり、キャンプ、観戦用の要約、AI の応答待ち。
// 文章と数値は shared の expedition.ts / turn.ts / catalog.ts / observation.ts で作る。ここでは並べて見せるだけで、ゲームの判定はしない。
import type {
  Catalog, CatalogRules, Change, Expedition, ExpeditionOffer, ExpeditionView, HaulParts, ObsExpedition, Observation, OfferSlot, PlayerView,
  RestEstimate, World,
} from '@muse/shared';
import {
  briefingLines, buildObservation, currentExpedition, dangerOf, endReasonText, haulTotal, latestExpedition, multText, nameOf, nextOverreach,
  objectiveText, offerText, overreachPoints, partsText, progressText, recommendedLevel, resultText, slotName,
} from '@muse/shared';
import type { RefObject } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { getLocale, tr } from '../util';
import { expStatusLabel, extractBlockLabel } from './labels';

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

/** 危険度 1〜5 を点で表す */
export function DangerPips({ n }: { n: number }) {
  return (
    <span class={`danger d${n}`} title={tr(`危険度 ${n}（1〜5。推奨レベルとの差と条件から公開の式で計算）`, `Danger ${n} (1-5, from the recommended level and traits)`)}>
      {tr('危険度', 'Danger')} {[1, 2, 3, 4, 5].map((i) => <i key={i} class={i <= n ? 'on' : ''} />)} {n}
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
  next: { depth: number; points: number } | null;
  /** 確定済みの点（プレイヤー視点のみ） */
  banked?: number;
}

export function haulFromObs(ox: ObsExpedition | undefined, banked: number, rules: CatalogRules | undefined): HaulInfo | null {
  const h = ox?.haul;
  if (!ox || !h) return null;
  return {
    total: h.total, parts: h.parts, multiplierPct: h.multiplier_pct, ifExtractNow: h.if_extract_now,
    withdraw: ox.extract_outcome === 'withdraw', withdrawPct: rules?.haul.withdrawPct, next: h.next_overreach, banked,
  };
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
      {(h.ifExtractNow !== undefined || h.next) && (
        <div class="haul-now">
          {h.ifExtractNow !== undefined && (
            <span class={`now ${h.withdraw ? 'withdraw' : 'complete'}`}>
              {h.withdraw
                ? tr(`今撤退すれば +${h.ifExtractNow}（目的を除いた ${pct}%・倍率なし）`, `Withdraw now: +${h.ifExtractNow} (${pct}% without the objective, no multiplier)`)
                : tr(`今帰れば +${h.ifExtractNow}`, `Extract now: +${h.ifExtractNow}`)}
            </span>
          )}
          {h.next && <span class="next">{tr(`地下${h.next.depth}階に着けば +${h.next.points}`, `Reach depth ${h.next.depth}: +${h.next.points}`)}</span>}
        </div>
      )}
    </div>
  );
}

/** extract の確認文。確定する点（if_extract_now）と、撤退なら目的を除いた withdrawPct % だけが確定することを書く */
export function extractConfirmText(ox: ObsExpedition | undefined, complete: boolean, rules: CatalogRules | undefined): string {
  const h = ox?.haul;
  const pct = rules?.haul.withdrawPct ?? 50;
  const next = h?.next_overreach ? tr(`\n（参考: 地下${h.next_overreach.depth}階に着けば戦利品に +${h.next_overreach.points}）`, `\n(For reference: reaching depth ${h.next_overreach.depth} adds +${h.next_overreach.points} to the haul)`) : '';
  if (complete) {
    const pay = h ? tr(`\n確定する点: +${h.if_extract_now}（戦利品 ${h.total} ${multText(h.multiplier_pct)}）`, `\nBanked: +${h.if_extract_now} (haul ${h.total} ${multText(h.multiplier_pct)})`) : '';
    return tr(`帰還して遠征${ox ? ` ${ox.no}` : ''}を終えますか？${pay}${next}`, `Extract and end the expedition?${pay}${next}`);
  }
  const pay = h
    ? tr(`\n撤退で確定するのは、目的の基礎点を除いた戦利品の ${pct}% だけ（倍率なし）: +${h.if_extract_now}`, `\nA withdrawal banks only ${pct}% of the haul without the objective (no multiplier): +${h.if_extract_now}`)
    : tr(`\n撤退では目的の基礎点は入らず、戦利品の ${pct}% だけが確定する。`, `\nA withdrawal banks only ${pct}% of the haul, without the objective.`);
  return tr(`目的は未達成です。今 extract すると撤退になり、この遠征は終わります。${pay}${next}\n撤退しますか？`,
    `The objective is not complete. Extracting now withdraws and ends this expedition.${pay}${next}\nWithdraw?`);
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

export function ExpeditionPanel({ view, obs, catalog, onBriefing }: { view: PlayerView; obs: Observation | null; catalog?: Catalog | null; onBriefing?: () => void }) {
  const x = view.expedition;
  if (!x) return null;
  const L = getLocale();
  const rules = rulesOf(catalog);
  const st = expStatusLabel(x);
  const ox = obs?.expedition;
  const active = x.status !== 'ended' && view.status !== 'at_camp';
  const done = completesOnExtract(x);
  const haul = active ? haulFromObs(ox, view.record.banked, rules) : null;
  const now = ox?.haul?.if_extract_now;
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
      {x.traits.length > 0 && <TraitList traits={x.traits} rules={rules} compact />}
      {haul && <HaulBlock h={haul} />}
      {active && ox && (
        <div class={`extract ${ox.can_extract ? 'ok' : 'no'}`}>
          {ox.can_extract
            ? (done
              ? tr(`extract 可（E）: 今 extract すると帰還（達成）${now !== undefined ? `・+${now} 確定` : ''}`, `extract possible (E): completes the expedition${now !== undefined ? `, banks +${now}` : ''}`)
              : tr(`extract 可（E）: 今 extract すると撤退（目的を除く ${rules?.haul.withdrawPct ?? 50}%${now !== undefined ? `・+${now} 確定` : ''}）`,
                `extract possible (E): withdraw (${rules?.haul.withdrawPct ?? 50}% without the objective${now !== undefined ? `, banks +${now}` : ''})`))
            : `${tr('extract 不可', 'cannot extract')}（${extractBlockLabel(ox.extract_blocked_by)}）`}
        </div>
      )}
      {x.status === 'ended' && x.result && <ResultBlock x={x} playerId={view.playerId} rules={rules} />}
    </section>
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

/** ▶ の状態行と、前回の自分の手番以降の変化 */
export function TurnBar({ line, changes }: { line: string; changes: Change[] }) {
  if (!line && !changes.length) return null;
  return (
    <div class="turnbar">
      {line && <div class="turnline">{line}</div>}
      {changes.length > 0 && (
        <div class="changes">
          <span class="lbl">{tr('前の手番からの変化', 'Since your last turn')}:</span>
          {changes.map((c, i) => <span key={`${c.code}-${i}`} class={`chg ${c.code}`}>{c.text}</span>)}
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
      {tr(`休憩の見積もり: 全快まで ${est.turns} 手（HP +${est.hp_to_full}・時間 ${est.time}・その間の徘徊の目安 ${est.wander_expected} 体）`,
        `Rest estimate: ${est.turns} turns to full (HP +${est.hp_to_full}, time ${est.time}, wanderers expected ${est.wander_expected})`)}
      {block}
    </div>
  );
}

function OfferCard({ o, rules, level, onStart }: { o: ExpeditionOffer; rules: CatalogRules | undefined; level: number; onStart: (offer: number) => void }) {
  const L = getLocale();
  const td = o.objective.targetDepth;
  const danger = rules && td !== null ? dangerOf(rules, td, o.traits ?? [], level) : null;
  const rec = rules && td !== null ? recommendedLevel(rules, td) : null;
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
        {danger !== null && <DangerPips n={danger} />}
        {rec !== null && (
          <span class={`olevel ${level < rec ? 'under' : ''}`}>{tr(`推奨 Lv${rec}（あなたは Lv${level}）`, `recommended Lv${rec} (you are Lv${level})`)}</span>
        )}
      </div>
      <TraitList traits={o.traits ?? []} rules={rules} />
    </li>
  );
}

/** キャンプ（遠征と遠征の間）。成績・前の遠征の払い戻し・候補を出し、次の遠征を選ぶか、ここで終える */
export function CampPanel({ view, catalog, onStart, onRetire }: { view: PlayerView; catalog?: Catalog | null; onStart: (offer: number | 'endless') => void; onRetire: () => void }) {
  const x = view.expedition;
  const camp = view.camp;
  const rules = rulesOf(catalog);
  const rec = view.record;
  return (
    <div class="campbox">
      <h2>{tr('キャンプ', 'Camp')}</h2>
      <div class="record">
        <span>{tr('確定点', 'Banked')} <b>{rec.banked}</b></span>
        <span>{tr('達成した遠征', 'Expeditions completed')} <b>{rec.expeditions}</b></span>
        {rec.lost > 0 && <span class="lost">{tr('失った戦利品', 'Haul lost')} <b>{rec.lost}</b></span>}
      </div>
      {x?.result && <ResultBlock x={x} playerId={view.playerId} rules={rules} />}
      <p class="muted">
        {tr(`盤面の外にいる（時間は進まない）。HP ${view.self.stats.hp}/${view.self.stats.maxHp}・Lv${view.self.level}。最深到達: 地下${view.deepestDepth}階。ここで終えてもよい。`,
          `You are off the board (time does not pass). HP ${view.self.stats.hp}/${view.self.stats.maxHp}, Lv${view.self.level}. Deepest: ${view.deepestDepth}. You may stop here.`)}
      </p>
      {camp ? (
        <>
          <h3>{tr(`次の遠征の候補（遠征 ${camp.nextNo}）`, `Offers for expedition ${camp.nextNo}`)}</h3>
          <ul class="offers cards">
            {camp.offers.map((o) => <OfferCard key={o.index} o={o} rules={rules} level={view.self.level} onStart={onStart} />)}
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
}

function viewOf(x: Expedition): ExpeditionView {
  return {
    no: x.no, objective: x.objective, points: x.points, relicGuarded: x.relicGuarded, status: x.status, endReason: x.endReason,
    progress: { reached: x.progress.reached, guardianSlain: x.progress.guardianSlain, relicHeld: x.progress.relicHeldBy !== null, relicHeldByYou: false },
    extracted: false, result: x.result, startSeq: x.startSeq, endSeq: x.endSeq,
    slot: x.slot ?? null, traits: [...(x.traits ?? [])], multiplierPct: x.multiplierPct ?? 100,
    haul: { ...(x.haul ?? { bounty: 0, discovery: 0, kills: 0 }) }, maxDepth: x.progress.maxDepth ?? 0,
  };
}

function titleOf(x: { no: number; objective: ExpeditionView['objective'] }): string {
  return `${tr(`遠征 ${x.no}`, `Expedition ${x.no}`)}: ${objectiveText(getLocale(), x.objective)}`;
}

/**
 * 俯瞰の戦利品: 共有分（賞金・発見・撃破）＋目的＋深追い＋参加者が持っている宝。
 * 払い戻しはプレイヤーごとなので「今帰れば」は出さない（式は shared の overreachPoints / haulTotal）。
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
  const maxDepth = x.progress.maxDepth ?? 0;
  const parts: HaulParts = {
    objective: x.status === 'objective_complete' ? x.points : 0,
    overreach: overreachPoints(rules, x.objective.targetDepth, maxDepth),
    treasure, bounty: shared.bounty, discovery: shared.discovery, kills: shared.kills,
  };
  return { total: haulTotal(parts), parts, multiplierPct: x.multiplierPct ?? 100, next: nextOverreach(rules, x.objective.targetDepth, maxDepth) };
}

/** 俯瞰: World の最新の遠征。depth は表示中のフロアの深さ */
export function directorExpInfo(world: World, depth: number | null, catalog?: Catalog | null): ExpInfo | null {
  const x = latestExpedition(world);
  if (!x) return null;
  const rules = rulesOf(catalog);
  const o = x.objective;
  const parts: string[] = [];
  if (o.targetDepth !== null) parts.push(tr(`表示中 地下${depth ?? '-'}階 / 目標 地下${o.targetDepth}階`, `showing depth ${depth ?? '-'} / target ${o.targetDepth}`));
  if (o.type === 'reach_depth') parts.push(x.progress.reached ? tr('目標階に到達済み', 'target reached') : tr('目標階に未到達', 'target not reached'));
  if (o.type === 'slay_guardian') parts.push(x.progress.guardianSlain ? tr('守護者: 討伐済み', 'guardian: slain') : tr('守護者: 未討伐', 'guardian: alive'));
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
      info.haul = haulFromObs(ox, view.record.banked, rules);
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

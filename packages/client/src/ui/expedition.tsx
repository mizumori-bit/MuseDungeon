// 遠征まわりの表示部品: 目的と進捗、ブリーフィング、手番の状態行と変化、休憩の見積もり、キャンプ、観戦用の要約、AI の応答待ち。
// 文章は shared の expedition.ts / turn.ts の関数で作る。ここでは並べて見せるだけで、ゲームの判定はしない。
import type { Change, Expedition, ExpeditionView, Observation, PlayerView, RestEstimate, World } from '@muse/shared';
import {
  briefingLines, currentExpedition, latestExpedition, objectiveText, offerText, progressText, resultText,
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

// ---- プレイ画面 ----

export function ExpeditionPanel({ view, obs, onBriefing }: { view: PlayerView; obs: Observation | null; onBriefing?: () => void }) {
  const x = view.expedition;
  if (!x) return null;
  const L = getLocale();
  const st = expStatusLabel(x);
  const ox = obs?.expedition;
  const active = x.status !== 'ended' && view.status !== 'at_camp';
  const done = completesOnExtract(x);
  return (
    <section class="panel exp">
      <h3>
        {tr(`遠征 ${x.no}`, `Expedition ${x.no}`)}
        <span class={`badge ${st.key}`}>{st.text}</span>
        {x.objective.type !== 'endless' && <small>{tr(`達成 +${x.points} 点`, `+${x.points} pts`)}</small>}
        {onBriefing && <button class="tiny right" onClick={onBriefing}>{tr('ブリーフィング', 'Briefing')}</button>}
      </h3>
      <div class="objective">{objectiveText(L, x.objective)}</div>
      <div class="progress">{progressText(L, x, view.floor?.depth ?? null)}</div>
      {active && ox && (
        <div class={`extract ${ox.can_extract ? 'ok' : 'no'}`}>
          {ox.can_extract
            ? (done ? tr('extract 可（E）: 今 extract すると帰還（達成）', 'extract possible (E): completes the expedition')
              : tr('extract 可（E）: 今 extract すると撤退（未達成・報酬なし）', 'extract possible (E): withdraw without the reward'))
            : `${tr('extract 不可', 'cannot extract')}（${extractBlockLabel(ox.extract_blocked_by)}）`}
        </div>
      )}
      {x.status === 'ended' && x.result && <div class="muted">{resultText(L, x)}</div>}
    </section>
  );
}

export function BriefingCard({ x, onClose }: { x: ExpeditionView; onClose: () => void }) {
  const lines = briefingLines(getLocale(), x);
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

/** キャンプ（遠征と遠征の間）。候補から次の遠征を選ぶか、ここで終える */
export function CampPanel({ view, onStart, onRetire }: { view: PlayerView; onStart: (offer: number | 'endless') => void; onRetire: () => void }) {
  const L = getLocale();
  const x = view.expedition;
  const camp = view.camp;
  return (
    <div class="campbox">
      <h2>{tr('キャンプ', 'Camp')}</h2>
      {x?.result && <p class="result">{resultText(L, x)}</p>}
      <p class="muted">
        {tr(`盤面の外にいる（時間は進まない）。HP ${view.self.stats.hp}/${view.self.stats.maxHp}。最深到達: 地下${view.deepestDepth}階。ここで終えてもよい。`,
          `You are off the board (time does not pass). HP ${view.self.stats.hp}/${view.self.stats.maxHp}. Deepest: ${view.deepestDepth}. You may stop here.`)}
      </p>
      {camp ? (
        <>
          <h3>{tr(`次の遠征の候補（遠征 ${camp.nextNo}）`, `Offers for expedition ${camp.nextNo}`)}</h3>
          <ul class="offers">
            {camp.offers.map((o) => (
              <li key={o.index}>
                <span class="otext">{offerText(L, o)}</span>
                <button class="small primary" onClick={() => onStart(o.index)}>{tr('この遠征に出る', 'Start')}</button>
              </li>
            ))}
            <li>
              <span class="otext">{tr('endless) 目的なし。できるだけ深く潜る（報酬なし）', 'endless) No objective: descend as deep as you can (no reward)')}</span>
              <button class="small" onClick={() => onStart('endless')}>{tr('目的なしで出る', 'Start endless')}</button>
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
  progress: string;
  result?: string;
  note?: string;
  offers?: string[];
}

function viewOf(x: Expedition): ExpeditionView {
  return {
    no: x.no, objective: x.objective, points: x.points, relicGuarded: x.relicGuarded, status: x.status, endReason: x.endReason,
    progress: { reached: x.progress.reached, guardianSlain: x.progress.guardianSlain, relicHeld: x.progress.relicHeldBy !== null, relicHeldByYou: false },
    extracted: false, result: x.result, startSeq: x.startSeq, endSeq: x.endSeq,
  };
}

function titleOf(x: { no: number; objective: ExpeditionView['objective'] }): string {
  return `${tr(`遠征 ${x.no}`, `Expedition ${x.no}`)}: ${objectiveText(getLocale(), x.objective)}`;
}

/** 俯瞰: World の最新の遠征。depth は表示中のフロアの深さ */
export function directorExpInfo(world: World, depth: number | null): ExpInfo | null {
  const x = latestExpedition(world);
  if (!x) return null;
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
  const info: ExpInfo = { title: titleOf(x), status: expStatusLabel(x), progress: parts.join(' | ') };
  if (x.result) info.result = resultText(getLocale(), viewOf(x));
  if (!currentExpedition(world) && world.status === 'active') {
    info.note = world.camp
      ? tr(`キャンプ中: 次の遠征（遠征 ${world.camp.nextNo}）はまだ選ばれていない`, `At camp: expedition ${world.camp.nextNo} not chosen yet`)
      : tr('キャンプ中', 'At camp');
    if (world.camp) info.offers = world.camp.offers.map((c) => offerText(getLocale(), c));
  }
  return info;
}

/** 追従: 射影した PlayerView の遠征 */
export function followExpInfo(view: PlayerView): ExpInfo | null {
  const x = view.expedition;
  if (!x) return null;
  const L = getLocale();
  const info: ExpInfo = { title: titleOf(x), status: expStatusLabel(x), progress: progressText(L, x, view.floor?.depth ?? null) };
  if (x.result) info.result = resultText(L, x);
  if (view.status === 'at_camp') {
    info.note = view.camp
      ? tr(`${view.self.name} はキャンプにいる: 次の遠征（遠征 ${view.camp.nextNo}）はまだ選ばれていない`, `${view.self.name} is at camp: expedition ${view.camp.nextNo} not chosen yet`)
      : tr(`${view.self.name} はキャンプにいる（仲間の遠征の終了待ち）`, `${view.self.name} is at camp (waiting for allies)`);
    if (view.camp) info.offers = view.camp.offers.map((c) => offerText(L, c));
  }
  return info;
}

export function ExpeditionStatusPanel({ info }: { info: ExpInfo | null }) {
  if (!info) return null;
  return (
    <section class="panel exp">
      <h3>{info.title} <span class={`badge ${info.status.key}`}>{info.status.text}</span></h3>
      {info.progress && <div class="progress">{info.progress}</div>}
      {info.result && <div class="muted">{info.result}</div>}
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

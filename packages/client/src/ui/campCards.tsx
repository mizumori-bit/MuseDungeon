// 札の部品（S16c。SEASON.md §70.5）: 支度の画面（持ち主が AI のために決める）と、自分で潜るときのキャンプ（自分で決める）の、両方で使う。
// 違いは、押したときにすること（支度: 持ち主の口へ。キャンプ: start_expedition の命令）と、ボタンの言葉だけ。札の中身は ui/objectiveCard.ts が決める。
// 見た目は、拠点と支度の接頭辞（.hub- / .prep-）と、札の接頭辞（.ocard-）のクラスだけ。
import type { Catalog, CatalogRules, ExpeditionOffer, PlayerView } from '@muse/shared';
import { bountyForecastText, conditionText, gearVsArmorText, guardianForecastText, offerFloorTraitsText, offerGuardianHp, relicText, slaysAt, slayShortGroupText } from '@muse/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { getLocale, tr } from '../util';
import { TraitList } from './expedition';
import { dangerTitle, levelText, objectiveCardModel } from './objectiveCard';

/**
 * 決める段の札（支度の「目的」「装備」「特技と加護」の段と、キャンプの段）。aside: 見出しの右（支度の「任せる／自分で」など）。
 * line: 今の状態の 1 行。held: 決める側にいる（金の縁）。locked: 押せない（薄く）
 */
export function DecideCard({ title, aside, line, held, locked, extraClass, children }: {
  title: string; aside?: ComponentChildren; line?: string | null; held?: boolean; locked?: boolean; extraClass?: string; children?: ComponentChildren;
}) {
  return (
    <section class={`prep-sec ${held ? 'is-held' : ''} ${locked ? 'is-locked' : ''} ${extraClass ?? ''}`}>
      <header class="prep-sechead">
        <h3 class="prep-sectitle">{title}</h3>
        {aside}
      </header>
      {line && <p class="prep-line">{line}</p>}
      {children}
    </section>
  );
}

/** 見るだけの札（たたむ）。summary: たたんだまま読める 1 行 */
export function FoldCard({ title, summary, open, children }: { title: string; summary?: string | null; open?: boolean; children?: ComponentChildren }) {
  return (
    <details class="prep-sec camp-fold" open={open}>
      <summary class="camp-foldhead">
        <span class="camp-foldtitle">{title}</span>
        {summary && <span class="camp-foldsum">{summary}</span>}
      </summary>
      <div class="prep-body">{children}</div>
    </details>
  );
}

/**
 * 目的の札 1 枚。大きく: 枠・危険の印・どこで・何を・基礎点・推奨のレベルと自分のレベル。小さく: 倍率・条件の名前・守護者の格など・いまの持ち物で通る目安・討伐の記録。
 * たたむ（「くわしく」）: どう達成するか・守護者や賞金首の見込みの文・階の性質・条件の説明・AI に届くのと同じ全文。
 * 札を押すと選ぶ（onSelect）。chosen: 選んでいる。selectLabel: 選ぶ前の小さい字（支度「この目的にする」・キャンプ「この目的を選ぶ」）
 */
export function ObjectiveCard({ o, rules, level, view, catalog, fullText, chosen, disabled, selectLabel, onSelect }: {
  o: ExpeditionOffer; rules: CatalogRules | undefined; level: number; view?: PlayerView; catalog?: Catalog | null; fullText?: string;
  chosen?: boolean; disabled?: boolean; selectLabel: string; onSelect: (offer: number) => void;
}) {
  const L = getLocale();
  const m = objectiveCardModel(o, { level, rules, fullText });
  const ft = offerFloorTraitsText(L, rules, o);
  // いまの持ち物で 1 回に通る目安（守護者・賞金首・大守護者。AI の候補の文と同じ。V3-8a §56.1・S3a・S3b §30.3 の 4）
  const gear = view && catalog && (o.bounty || o.guardian?.armor !== undefined)
    ? (o.bounty
      ? gearVsArmorText(L, catalog, view, o.bounty.armor, Math.max(1, o.bounty.hp - (o.scar ?? 0)))
      : gearVsArmorText(L, catalog, view, o.guardian!.armor!, offerGuardianHp(view, o), o.guardian!.types ?? []))
    : '';
  // 討伐の記録（S4 §35.5・S5a）: まだ倒していない大守護者を倒す候補に、先に倒した参加者の戦いの事実（短い形。全文はキャンプの記録庫の札）
  const td = o.objective.targetDepth;
  const slays = view && catalog && o.objective.type === 'slay_warden' && td !== null && !(view.milestonesCleared ?? []).includes(td) ? slaysAt(L, catalog, view, td) : [];
  const gapCls = m.level.gap === null ? '' : m.level.gap >= 3 ? 'over far' : m.level.gap > 0 ? 'over' : 'ok';
  return (
    <li class={`ocard ${m.slot ?? ''} ${chosen ? 'is-chosen' : ''}`}>
      <button type="button" class="ocard-pick" aria-pressed={!!chosen} disabled={disabled} onClick={() => onSelect(o.index)}>
        <span class="ocard-top">
          <span class="ocard-no">{m.index}</span>
          {m.slotLabel && <span class={`slot-badge ${m.slot ?? ''}`}>{m.slotLabel}</span>}
          {m.danger && <span class={`ocard-danger tone-${m.danger.tone}`} title={dangerTitle()}>{m.danger.label}</span>}
          <span class="ocard-sel">{chosen ? tr('選んだ', 'Chosen') : selectLabel}</span>
        </span>
        {m.where && <span class="ocard-where">{m.where}</span>}
        <span class="ocard-what">{m.what}</span>
        <span class="ocard-stats">
          <span class="ocard-pts">{tr(`基礎 +${m.points}`, `base +${m.points}`)}</span>
          <span class={`ocard-lv ${gapCls}`}>{levelText(m.level)}</span>
          {m.traitDanger !== 0 && <span class="ocard-td">{tr(`条件 ${m.traitDanger > 0 ? '+' : ''}${m.traitDanger}`, `traits ${m.traitDanger > 0 ? '+' : ''}${m.traitDanger}`)}</span>}
        </span>
      </button>
      <p class="ocard-facts">{m.facts.join(tr('・', ' · '))}</p>
      {gear && <p class="ocard-note">{gear}</p>}
      {slays.length > 0 && <p class="ocard-note slay">{slayShortGroupText(L, slays)}</p>}
      <details class="ocard-more">
        <summary>{tr('くわしく', 'Details')}</summary>
        <p class="ocard-note">{m.how}</p>
        {o.guardian && <p class="ocard-note">{guardianForecastText(L, o.guardian)}</p>}
        {o.bounty && <p class="ocard-note">{bountyForecastText(L, o.bounty)}</p>}
        {o.relic && <p class="ocard-note">{relicText(L, o.relic)}</p>}
        {ft && <p class="ocard-note">{ft}</p>}
        <TraitList traits={o.traits ?? []} rules={rules} />
        <p class="ocard-full" title={tr('AI に届く候補の文と同じ', 'The same text the AI gets for this offer')}>{m.full}</p>
      </details>
    </li>
  );
}

/** 目的なし（endless）の札 */
export function EndlessCard({ chosen, disabled, selectLabel, onSelect }: { chosen?: boolean; disabled?: boolean; selectLabel: string; onSelect: () => void }) {
  return (
    <li class={`ocard endless ${chosen ? 'is-chosen' : ''}`}>
      <button type="button" class="ocard-pick" aria-pressed={!!chosen} disabled={disabled} onClick={onSelect}>
        <span class="ocard-top">
          <span class="ocard-no">∞</span>
          <span class="ocard-sel">{chosen ? tr('選んだ', 'Chosen') : selectLabel}</span>
        </span>
        <span class="ocard-what">{tr('目的なし。できるだけ深く潜る', 'No objective: descend as deep as you can')}</span>
        <span class="ocard-stats"><span class="ocard-note">{conditionText(getLocale(), { type: 'endless', targetDepth: null })}</span></span>
      </button>
    </li>
  );
}

/**
 * 目的の候補の並び（候補の札と、目的なしの札）。chosen: 選んでいる候補（番号か 'endless'）。fullTexts: 観測の camp.offers[].text（番号 → 文）
 */
export function ObjectiveList({ offers, rules, level, view, catalog, fullTexts, chosen, disabled, selectLabel, onSelect }: {
  offers: readonly ExpeditionOffer[]; rules: CatalogRules | undefined; level: number; view?: PlayerView; catalog?: Catalog | null;
  fullTexts?: ReadonlyMap<number, string>; chosen: number | 'endless' | null | undefined; disabled?: boolean; selectLabel: string;
  onSelect: (offer: number | 'endless') => void;
}) {
  return (
    <ul class="ocards">
      {offers.map((o) => (
        <ObjectiveCard key={o.index} o={o} rules={rules} level={level} view={view} catalog={catalog} fullText={fullTexts?.get(o.index)}
          chosen={chosen === o.index} disabled={disabled} selectLabel={selectLabel} onSelect={onSelect} />
      ))}
      <EndlessCard chosen={chosen === 'endless'} disabled={disabled} selectLabel={selectLabel} onSelect={() => onSelect('endless')} />
    </ul>
  );
}

/** 観測の camp.offers から、番号 → AI に届く候補の文 */
export function offerTextsOf(camp: { offers: readonly { index: number; text: string }[] } | undefined | null): Map<number, string> {
  return new Map((camp?.offers ?? []).map((o) => [o.index, o.text]));
}

/**
 * まだ決めていないものの確かめの窓（支度の「準備完了」と同じ見た目）。primary は「戻って決める」
 */
export function UndecidedDialog({ items, note, goLabel, busy, onBack, onGo }: { items: readonly string[]; note: string; goLabel: string; busy?: boolean; onBack: () => void; onGo: () => void }) {
  const backRef = useRef<HTMLButtonElement>(null);
  // 開いたときに 1 回だけ、既定のボタンへ
  useEffect(() => { backRef.current?.focus(); }, []);
  return (
    <div class="hub-modal" onClick={onBack}>
      <div class="hub-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onBack(); }}>
        <h2 class="hub-dtitle">{tr('まだ決めていないものがある', 'Some things are not decided yet')}</h2>
        <ul class="prep-list">{items.map((x) => <li key={x}>{x}</li>)}</ul>
        <p class="hub-note">{note}</p>
        <div class="hub-dactions">
          <button ref={backRef} class="hub-btn primary" onClick={onBack}>{tr('戻って決める', 'Go back and decide')}</button>
          <button class="hub-btn" disabled={busy} onClick={onGo}>{goLabel}</button>
        </div>
      </div>
    </div>
  );
}

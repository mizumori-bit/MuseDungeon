// 拠点と支度の部品（S10。SEASON.md §58.4）: 上のタブ（拠点・記録と、隅の歯車）・冒険者の札・鍵を入れる欄・自分で潜る窓。
// 見た目は新しい接頭辞（.hub-）のクラスだけ（ほかの画面の見た目を変えない）。札の文とボタンは hubState.ts が決める。
import type { Catalog } from '@muse/shared';
import { nameOf } from '@muse/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getLocale, tr } from '../util';
import type { HubCardModel, HubTone } from './hubState';

export type HubTab = 'hub' | 'records' | 'ops' | null;

/** 歯車（運用）。絵文字を使わず、線で描く */
export function GearIcon() {
  return (
    <svg class="hub-gearicon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.5 5.5l-1.8 1.8M7.3 16.7l-1.8 1.8M18.5 18.5l-1.8-1.8M7.3 7.3 5.5 5.5" />
      <circle cx="12" cy="12" r="6.6" />
    </svg>
  );
}

/** 上のタブ: 拠点・記録の 2 つと、隅の歯車（運用）。waiting: 支度を待っている冒険者の数（拠点のタブに印） */
export function HubNav({ tab, waiting = 0 }: { tab: HubTab; waiting?: number }) {
  return (
    <nav class="hub-nav" aria-label={tr('画面', 'Screens')}>
      <a class={`hub-tab ${tab === 'hub' ? 'on' : ''}`} href="#/">
        {tr('拠点', 'Hub')}
        {waiting > 0 && <span class="hub-count" title={tr('あなたの支度を待っている冒険者', 'Adventurers waiting for your preparations')}>{waiting}</span>}
      </a>
      <a class={`hub-tab ${tab === 'records' ? 'on' : ''}`} href="#/records">{tr('記録', 'Records')}</a>
      <span class="hub-navspace" />
      <a class={`hub-gear ${tab === 'ops' ? 'on' : ''}`} href="#/ops" title={tr('運用', 'Operations')} aria-label={tr('運用', 'Operations')}><GearIcon /></a>
    </nav>
  );
}

export function HubPill({ text, tone }: { text: string; tone: HubTone }) {
  return <span class={`hub-pill tone-${tone}`}>{text}</span>;
}

/**
 * 冒険者の札。model: hubState.hubCard の結果。className: 職の名前（分からなければ null）。operator: 運用者として見る札（小さめ・取り違えない見た目）。
 * onDive: 「自分で潜る」のとき
 */
export function AdventurerCard({ name, className, model, operator, onDive }: { name: string; className: string | null; model: HubCardModel; operator?: boolean; onDive?: () => void }) {
  const st = model.stats;
  const sub = [className, st.level !== null ? `Lv${st.level}` : null].filter(Boolean).join(' · ');
  return (
    <article class={`hub-card ${model.highlight ? 'is-pending' : ''} ${operator ? 'is-operator' : ''} state-${model.state}`}>
      <header class="hub-cardhead">
        <div class="hub-who">
          <h2 class="hub-name">{name}</h2>
          {sub && <div class="hub-sub">{sub}</div>}
        </div>
        <div class="hub-pills">
          <HubPill text={model.pill.text} tone={model.pill.tone} />
          {model.wish && <HubPill text={tr('希望が届いている', 'A wish came in')} tone="gold" />}
        </div>
      </header>
      <p class="hub-where">{model.where}</p>
      {model.text && <p class="hub-text">{model.text}</p>}
      {model.notes.map((x, i) => <p key={i} class="hub-note">{x}</p>)}
      <dl class="hub-stats">
        <div><dt>{tr('持ち帰った点', 'Points home')}</dt><dd>{st.banked}</dd></div>
        {st.budget && <div><dt>{tr('残りの手番', 'Turns left')}</dt><dd class={st.budget.left < Math.min(100, Math.ceil(st.budget.limit / 10)) ? 'low' : ''}>{st.budget.left}<small> / {st.budget.limit}</small></dd></div>}
        <div><dt>{tr('冒険賞', 'Adventure')}</dt><dd>{st.rank !== null ? tr(`${st.rank} 位`, `#${st.rank}`) : '-'}</dd></div>
      </dl>
      <div class="hub-actions">
        {model.action.href
          ? <a class="hub-btn primary" href={model.action.href}>{model.action.label}</a>
          : <button class="hub-btn primary" onClick={onDive}>{model.action.label}</button>}
      </div>
    </article>
  );
}

/** 鍵を入れる欄（鍵が無いとき、画面の真ん中に 1 つ）。onKeep が Promise で失敗の文を返せば、その文を出す */
export function KeyEntry({ onKeep }: { onKeep: (tok: string) => Promise<string | null> }) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const tok = draft.trim();
    if (!tok || busy) return;
    setBusy(true);
    const e = await onKeep(tok);
    setBusy(false);
    if (e) setErr(e);
    else { setDraft(''); setErr(null); }
  };
  return (
    <section class="hub-keybox">
      <h2 class="hub-keytitle">{tr('冒険者の鍵を入れる', 'Enter your adventurer\'s key')}</h2>
      <p class="hub-note">{tr('運用者から受け取った鍵。このブラウザにだけ覚える。', 'The key the operator gave you. It is kept only in this browser.')}</p>
      <form class="hub-keyform" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <input class="hub-input" type="password" autocomplete="off" aria-label={tr('鍵', 'Key')} placeholder={tr('鍵', 'Key')} value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)} />
        <button class="hub-btn primary" type="submit" disabled={busy || !draft.trim()}>{tr('入れる', 'Enter')}</button>
      </form>
      {err && <p class="hub-err">{err}</p>}
    </section>
  );
}

/** 自分で潜る窓（名前と職を選ぶ）。onDive で今の参加の道（シーズンのランを始める） */
export function DiveDialog({ name: name0, classId: class0, catalog, busy, onDive, onClose }: {
  name: string; classId: string; catalog: Catalog | null; busy: boolean; onDive: (name: string, classId: string) => void; onClose: () => void;
}) {
  const L = getLocale();
  const [name, setName] = useState(name0);
  const [classId, setClassId] = useState(class0);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);
  const classes = catalog ? Object.entries(catalog.classes) : [];
  const desc = catalog?.classes[classId] ? nameOf(catalog.classes[classId].desc, L, '') : '';
  return (
    <div class="hub-modal" onClick={onClose}>
      <div class="hub-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <h2 class="hub-dtitle">{tr('自分で潜る', 'Go down yourself')}</h2>
        <p class="hub-note">{tr('あなたが、この冒険者として遊ぶ。AI は、この冒険には入らない。', 'You play as this adventurer. Your AI does not join this adventure.')}</p>
        <form class="hub-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onDive(name.trim(), classId); }}>
          <label class="hub-field">{tr('名前', 'Name')}
            <input ref={firstRef} class="hub-input" value={name} maxLength={32} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          </label>
          <label class="hub-field">{tr('職', 'Class')}
            <select class="hub-input" value={classId} onChange={(e) => setClassId((e.target as HTMLSelectElement).value)}>
              {classes.map(([id, c]) => <option key={id} value={id}>{nameOf(c.name, L, id)}</option>)}
              {!classes.length && <option value={classId}>{classId}</option>}
            </select>
          </label>
          {desc && <p class="hub-note">{desc}</p>}
          <div class="hub-dactions">
            <button type="button" class="hub-btn" onClick={onClose}>{tr('やめる', 'Cancel')}</button>
            <button type="submit" class="hub-btn primary" disabled={busy || !name.trim()}>{tr('潜る', 'Go down')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

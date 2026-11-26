// 拠点と支度の部品（S10。SEASON.md §58.4）: 上のタブ（拠点・記録と、隅の歯車）・冒険者の札・鍵を入れる欄・自分で潜る窓。
// S12b（§63.7）: サーバーと同じ PC から開いたときの、新しいシーズンを始める窓・冒険者を足す窓・鍵を 1 回だけ見せる窓。
// 見た目は新しい接頭辞（.hub-）のクラスだけ（ほかの画面の見た目を変えない）。札の文とボタンは hubState.ts が決める。
import type { Catalog } from '@muse/shared';
import { nameOf } from '@muse/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { getLocale, tr } from '../util';
import type { HubCardModel, HubTone } from './hubState';
import { KeepGoingNavMark } from './keepGoingUi';

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
      {/* 続けて遊ばせている冒険者がいれば、上の帯にも（S14） */}
      <KeepGoingNavMark />
      <a class={`hub-gear ${tab === 'ops' ? 'on' : ''}`} href="#/ops" title={tr('運用', 'Operations')} aria-label={tr('運用', 'Operations')}><GearIcon /></a>
    </nav>
  );
}

export function HubPill({ text, tone }: { text: string; tone: HubTone }) {
  return <span class={`hub-pill tone-${tone}`}>{text}</span>;
}

/**
 * 冒険者の札。model: hubState.hubCard の結果。className: 職の名前（分からなければ null）。operator: 運用者として見る札（小さめ・取り違えない見た目）。
 * onDive: 「自分で潜る」のとき。onEnroll: 「このシーズンに加える」のとき（S12b）。busy: 押した後、終わるまで
 */
export function AdventurerCard({ name, className, model, operator, onDive, onEnroll, onUninvite, busy, extra, alert }: { name: string; className: string | null; model: HubCardModel; operator?: boolean; onDive?: () => void; onEnroll?: () => void; onUninvite?: () => void; busy?: boolean; extra?: ComponentChildren; alert?: boolean }) {
  const st = model.stats;
  const sub = [className, st.level !== null ? `Lv${st.level}` : null].filter(Boolean).join(' · ');
  return (
    <article class={`hub-card ${model.highlight ? 'is-pending' : ''} ${operator ? 'is-operator' : ''} ${alert ? 'kg-alertcard' : ''} state-${model.state}`}>
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
      {model.action && (
        <div class="hub-actions">
          {model.action.href
            ? <a class="hub-btn primary" href={model.action.href}>{model.action.label}</a>
            : model.action.uninvite
              ? (onUninvite ? <button class="hub-btn small" disabled={busy} onClick={onUninvite}>{model.action.label}</button> : null)
              : <button class="hub-btn primary" disabled={busy} onClick={model.action.enroll ? onEnroll : onDive}>{model.action.label}</button>}
        </div>
      )}
      {/* 続けて遊ばせる（S14。ui/keepGoingUi.tsx の KeepGoingBox） */}
      {extra}
    </article>
  );
}

/** 窓の枠（外を押すか Escape で閉じる。sticky: 外を押しても、Escape でも閉じない。S12b: 鍵を 1 回だけ見せる窓） */
function Modal({ title, onClose, sticky, children }: { title: string; onClose: () => void; sticky?: boolean; children: ComponentChildren }) {
  return (
    <div class="hub-modal" onClick={sticky ? undefined : onClose}>
      <div class="hub-dialog" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape' && !sticky) onClose(); }}>
        <h2 class="hub-dtitle">{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** 職を選ぶ欄（自分で潜る窓・冒険者を足す窓） */
function ClassField({ catalog, classId, onChange }: { catalog: Catalog | null; classId: string; onChange: (id: string) => void }) {
  const L = getLocale();
  const classes = catalog ? Object.entries(catalog.classes) : [];
  const desc = catalog?.classes[classId] ? nameOf(catalog.classes[classId].desc, L, '') : '';
  return (
    <>
      <label class="hub-field">{tr('職', 'Class')}
        <select class="hub-input" value={classId} onChange={(e) => onChange((e.target as HTMLSelectElement).value)}>
          {classes.map(([id, c]) => <option key={id} value={id}>{nameOf(c.name, L, id)}</option>)}
          {!classes.length && <option value={classId}>{classId}</option>}
        </select>
      </label>
      {desc && <p class="hub-note">{desc}</p>}
    </>
  );
}

/**
 * 新しいシーズンを始める窓（S12b。SEASON.md §63.7 の 1。サーバーと同じ PC から開いたときだけ）。日数・予算は既定の値を入れておく。
 * 名前は空のまま（S12c: 空なら、サーバーが重ならない「シーズン N」を決める。suggested はその見込みで、欄の薄い文字に出すだけ）。
 * シードはサーバーが乱数で決める（画面には出ない）。閉じるのは、運用の道具で（画面からは閉じられない）
 */
export function OpenSeasonDialog({ defaults, busy, error, onOpen, onClose }: {
  defaults: { suggested: string; days: number; budget: number }; busy: boolean; error?: string | null;
  onOpen: (v: { name: string; days: number; budget: number }) => void; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [days, setDays] = useState(String(defaults.days));
  const [budget, setBudget] = useState(String(defaults.budget));
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, []);
  const d = Number(days);
  const b = Number(budget);
  const ok = Number.isInteger(d) && d >= 1 && d <= 60 && Number.isInteger(b) && b >= 100 && b <= 20000;
  return (
    <Modal title={tr('新しいシーズンを始める', 'Start a new season')} onClose={onClose}>
      <p class="hub-note">{tr('この PC のサーバーで、シーズンを始める。名簿の冒険者は、同じ迷宮に潜り、手番の予算の中で、深さと点を競う。迷宮の種（シード）は、サーバーが決める（画面には出ない）。', 'Starts a season on this PC\'s server. The adventurers on its roster dive the same dungeon and compete on depth and points within a turn budget. The server picks the dungeon seed (it is never shown).')}</p>
      <form class="hub-form" onSubmit={(e) => { e.preventDefault(); if (ok) onOpen({ name: name.trim(), days: d, budget: b }); }}>
        <label class="hub-field">{tr('名前（空なら、サーバーが決める）', 'Name (blank: the server picks one)')}
          <input ref={firstRef} class="hub-input" value={name} maxLength={32} placeholder={defaults.suggested} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        <label class="hub-field">{tr('日数（1〜60）', 'Days (1-60)')}
          <input class="hub-input" type="number" min={1} max={60} step={1} value={days} onInput={(e) => setDays((e.target as HTMLInputElement).value)} />
        </label>
        <label class="hub-field">{tr('1 人の手番の予算（100〜20,000）', 'Turn budget per adventurer (100-20,000)')}
          <input class="hub-input" type="number" min={100} max={20000} step={100} value={budget} onInput={(e) => setBudget((e.target as HTMLInputElement).value)} />
        </label>
        <p class="hub-note">{tr('始めたシーズンを、画面から閉じることはできない（終わりの時刻に、結果が出る。早く閉じるのは、運用の道具で）。', 'A started season cannot be closed from the screen (results come at its end time; to close it early, use the operator tool).')}</p>
        {error && <p class="hub-err">{error}</p>}
        <div class="hub-dactions">
          <button type="button" class="hub-btn" onClick={onClose}>{tr('やめる', 'Cancel')}</button>
          <button type="submit" class="hub-btn primary" disabled={busy || !ok}>{tr('始める', 'Start')}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 冒険者を足す窓（S12b。SEASON.md §63.7 の 1）: 「AI に任せる」（足した後に、鍵を 1 回だけ見せる）か「自分で潜る」（名前と職。足したら、すぐ遊ぶ）。
 * lead: 窓の上の 1 行（シーズンを始めた直後の案内など）
 */
export function AddAdventurerDialog({ seasonName, lead, catalog, classId: class0, busy, error, onAdd, onClose }: {
  seasonName: string; lead?: string | null; catalog: Catalog | null; classId: string; busy: boolean; error?: string | null;
  onAdd: (v: { kind: 'ai' | 'human'; name: string; classId: string }) => void; onClose: () => void;
}) {
  const [kind, setKind] = useState<'ai' | 'human'>('ai');
  const [name, setName] = useState('');
  const [classId, setClassId] = useState(class0);
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => { firstRef.current?.focus(); }, [kind]);
  return (
    <Modal title={tr('冒険者を足す', 'Add an adventurer')} onClose={onClose}>
      {lead && <p class="hub-text">{lead}</p>}
      <p class="hub-note">{tr(`シーズン「${seasonName}」の名簿に入れる。`, `Puts them on the roster of "${seasonName}".`)}</p>
      <div class="prep-toggle hub-kind" role="group" aria-label={tr('だれが潜るか', 'Who goes down')}>
        <button type="button" class={kind === 'ai' ? 'on' : ''} aria-pressed={kind === 'ai'} onClick={() => setKind('ai')}>{tr('AI に任せる', 'Leave it to an AI')}</button>
        <button type="button" class={kind === 'human' ? 'on' : ''} aria-pressed={kind === 'human'} onClick={() => setKind('human')}>{tr('自分で潜る', 'Go down yourself')}</button>
      </div>
      <p class="hub-note">{kind === 'ai'
        ? tr('名前を決めると、鍵が 1 回だけ出る。それを写して、AI に渡す。AI は、その鍵で入ってくる。', 'Pick a name and a key is shown once. Copy it and hand it to your AI, which comes in with it.')
        : tr('名前と職を決めると、すぐ遊ぶ画面へ。', 'Pick a name and a class, and the play screen opens at once.')}</p>
      <form class="hub-form" onSubmit={(e) => { e.preventDefault(); if (name.trim()) onAdd({ kind, name: name.trim(), classId }); }}>
        <label class="hub-field">{tr('名前（このシーズンの順位の表の名前）', 'Name (as shown in this season\'s standings)')}
          <input ref={firstRef} class="hub-input" value={name} maxLength={32} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        </label>
        {kind === 'human' && <ClassField catalog={catalog} classId={classId} onChange={setClassId} />}
        {error && <p class="hub-err">{error}</p>}
        <div class="hub-dactions">
          <button type="button" class="hub-btn" onClick={onClose}>{tr('やめる', 'Cancel')}</button>
          <button type="submit" class="hub-btn primary" disabled={busy || !name.trim()}>{kind === 'ai' ? tr('足して、鍵を出す', 'Add and show the key') : tr('足して、潜る', 'Add and go down')}</button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * 招きを取り消す確かめの窓（S12c。鍵を無くしたときの道）: まだ 1 回も入っていない招きだけ。取り消すと、その鍵ではこのシーズンに入れない。
 * 足し直すと、新しい鍵が出る。既定のボタンは「やめる」
 */
export function UninviteDialog({ name, busy, error, onConfirm, onClose }: { name: string; busy: boolean; error?: string | null; onConfirm: () => void; onClose: () => void }) {
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { backRef.current?.focus(); }, []);
  return (
    <Modal title={tr(`${name}の招きを取り消す`, `Withdraw ${name}'s invitation`)} onClose={onClose}>
      <p class="hub-text">{tr(`${name}は、まだ、このシーズンに 1 回も入っていない。招きを取り消すと、足したときの鍵では、このシーズンに入れなくなる。`, `${name} has not entered this season yet. Once withdrawn, the key from when you added them no longer gets into this season.`)}</p>
      <p class="hub-note">{tr('鍵を無くしたときは、取り消してから、同じ名前で足し直す（新しい鍵が出る）。', 'If the key is lost, withdraw it, then add them again under the same name (a new key is shown).')}</p>
      {error && <p class="hub-err">{error}</p>}
      <div class="hub-dactions">
        <button ref={backRef} type="button" class="hub-btn primary" onClick={onClose}>{tr('やめる', 'Cancel')}</button>
        <button type="button" class="hub-btn" disabled={busy} onClick={onConfirm}>{tr('取り消す', 'Withdraw')}</button>
      </div>
    </Modal>
  );
}

/**
 * 鍵を 1 回だけ見せる窓（S12b）: AI に任せる冒険者を足した直後だけ。写すボタン・AI への渡し方・閉じたら、もう出せない。
 * 鍵は、このブラウザには覚えない（持ち主になりたければ、鍵の欄に入れる）。外を押しても、Escape でも閉じない（取り落とさないように）
 */
export function KeyOnceDialog({ name, seasonId, keyText, onClose }: { name: string; seasonId: string; keyText: string; onClose: () => void }) {
  const [copied, setCopied] = useState<'ok' | 'no' | null>(null);
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(keyText);
      setCopied('ok');
    } catch {
      setCopied('no');
    }
  };
  return (
    <Modal title={tr(`${name}の鍵`, `${name}'s key`)} onClose={onClose} sticky>
      <p class="hub-text">{tr('この鍵を、AI に渡す。AI は、new_run の season と profile_token に使う。', 'Hand this key to your AI. It uses it as profile_token, with season, in new_run.')}</p>
      <div class="prep-nudge">
        <p class="prep-nudgetext hub-key">{keyText}</p>
        {canCopy && copied !== 'no' && <button type="button" class="prep-btn small" onClick={() => void copy()}>{copied === 'ok' ? tr('写した', 'Copied') : tr('鍵を写す', 'Copy the key')}</button>}
        {(!canCopy || copied === 'no') && <p class="hub-note">{tr('鍵を選んで、写す。', 'Select the key and copy it.')}</p>}
      </div>
      <p class="hub-note">{tr(`season は ${seasonId}。例: new_run { character_name: "${name}", season: "${seasonId}", profile_token: "（この鍵）" }`, `season is ${seasonId}. e.g. new_run { character_name: "${name}", season: "${seasonId}", profile_token: "(this key)" }`)}</p>
      <p class="hub-note warn">{tr('この窓を閉じたら、鍵は、もう出せない。無くしたら、この冒険者の札の「招きを取り消す」から、足し直す。', 'Once this window is closed, the key cannot be shown again. If it is lost, use "Withdraw the invitation" on this adventurer\'s card and add them again.')}</p>
      <p class="hub-note">{tr('鍵は、このブラウザには覚えない。このブラウザで、この冒険者の持ち主になりたければ、鍵の欄に入れる。', 'The key is not kept in this browser. To be this adventurer\'s owner in this browser, enter it in the key box.')}</p>
      <div class="hub-dactions">
        <button type="button" class="hub-btn primary" onClick={onClose}>{tr('写した。閉じる', 'Copied it. Close')}</button>
      </div>
    </Modal>
  );
}

/**
 * 鍵を入れる欄（鍵が無いとき、画面の真ん中に 1 つ）。onKeep が Promise で失敗の文を返せば、その文を出す。
 * compact（S10a b）: 運用者として冒険者の札がもう出ているとき。札の下に小さい 1 行（押すと欄が開く）
 */
export function KeyEntry({ onKeep, compact }: { onKeep: (tok: string) => Promise<string | null>; compact?: boolean }) {
  const [draft, setDraft] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(!compact);
  const submit = async () => {
    const tok = draft.trim();
    if (!tok || busy) return;
    setBusy(true);
    const e = await onKeep(tok);
    setBusy(false);
    if (e) setErr(e);
    else { setDraft(''); setErr(null); }
  };
  if (compact && !open) {
    return <p class="hub-keyline"><button type="button" class="hub-linkbtn" onClick={() => setOpen(true)}>{tr('自分の冒険者の鍵を入れる', 'Enter your own adventurer\'s key')}</button></p>;
  }
  return (
    <section class={`hub-keybox ${compact ? 'is-compact' : ''}`}>
      <h2 class="hub-keytitle">{compact ? tr('自分の冒険者の鍵を入れる', 'Enter your own adventurer\'s key') : tr('冒険者の鍵を入れる', 'Enter your adventurer\'s key')}</h2>
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

/** 自分で潜る窓（名前と職を選ぶ）。onDive で今の参加の道（シーズンのランを始める）。error: 断られたとき（画面の言葉の文。S10a §6） */
export function DiveDialog({ name: name0, classId: class0, catalog, busy, error, onDive, onClose }: {
  name: string; classId: string; catalog: Catalog | null; busy: boolean; error?: string | null; onDive: (name: string, classId: string) => void; onClose: () => void;
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
          {error && <p class="hub-err">{error}</p>}
          <div class="hub-dactions">
            <button type="button" class="hub-btn" onClick={onClose}>{tr('やめる', 'Cancel')}</button>
            <button type="submit" class="hub-btn primary" disabled={busy || !name.trim()}>{tr('潜る', 'Go down')}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

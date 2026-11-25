// 支度（S10。SEASON.md §58.4。#/prepare/<runId>）: ただ 1 つの出撃の窓口。1 枚の画面に、冒険者・目的・装備・特技と加護（段ごとに「任せる／自分で」）・伝言・「準備完了」。
// 見えるものは、そのプレイヤーの PlayerView と、AI に届くのと同じ観測（持ち主の口の …/owner/view）だけ（持ち主に、プレイヤーより多くを見せない）。
// 命令は、プレイヤーと同じ Command を持ち主の口へ送る（通るか・断るかはサーバー（engine）が決め、断りの文はそのまま出す）。
// 鍵は、そのランを返したもの（このブラウザに覚えてある鍵のうち、そのランの冒険者のもの）を Authorization の見出しでだけ渡す。無ければ同じ機械から。
// 5 秒ごとに読み直す。開いている段（「自分で」にした段）と、書きかけの伝言は、読み直しで消えない。
import type { ActionError, Command, DirectiveItem, DirectiveWish, OwnerViewResponse } from '@muse/shared';
import { DIRECTIVE_ITEMS, activeWishes, itemDisplayName, kindName, nameOf, ownerOfferText, prepStateView, wishCommand, wishItemOf, wishLabel } from '@muse/shared';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api } from '../api';
import { ErrorBanner, Header, useCatalog, useLocaleRefresh } from '../ui/common';
import { BoonChoicePanel, PerkChoicePanel } from '../ui/build';
import { OfferCard, rulesOf } from '../ui/expedition';
import { HubNav, HubPill } from '../ui/hub';
import { storedKeys } from '../ui/keys';
import { statChangeText } from '../ui/owner';
import { aiPresenceText, readyCheck } from '../ui/ownerCheck';
import { InventoryPanel, type InvAction } from '../ui/panels';
import { directiveToggle, messageSave, prepHead, prepItemCost, prepItemName, prepLine } from '../ui/prepState';
import { screenErr } from '../ui/screenErr';
import { getLocale, getToken, tr } from '../util';

/** 読み直しの間 */
const POLL_MS = 5000;
/** 伝言の長さの上限（SEASON.md §54.2） */
const MESSAGE_MAX = 280;

const ordered = (xs: readonly DirectiveItem[]): DirectiveItem[] => DIRECTIVE_ITEMS.filter((x) => xs.includes(x));

/** HTTP の断り（401・403・404・起動時に読み込めなかった など）は、画面の言葉の文に置き換える（S10a §6。ui/screenErr.ts） */
const httpErrText = screenErr;
const actionErrText = (err: ActionError) => `${err.message}${err.hint ? ` — ${err.hint}` : ''}`;

/** 希望の項目 → 段 */
const wishSection = (w: DirectiveWish): DirectiveItem => (w.item === 'objective' ? 'objective' : w.item === 'loadout' ? 'loadout' : 'perks');

/**
 * 段: 見出し・「任せる／自分で」の切り替え・今の状態の 1 行・希望・（自分でにしたとき）決める所。
 * locked（S10a §2）: 準備完了の間は、切り替えも決める操作も押せない（薄く。変えるには、先に「支度を見直す」）
 */
function PrepSection({ item, held, line, editable, locked, busy, onToggle, wish, children }: {
  item: DirectiveItem; held: boolean; line: string; editable: boolean; locked: boolean; busy: boolean; onToggle: (held: boolean) => void;
  wish?: ComponentChildren; children?: ComponentChildren;
}) {
  const can = editable && !locked && !busy;
  return (
    <section class={`prep-sec ${held ? 'is-held' : ''} ${locked ? 'is-locked' : ''}`}>
      <header class="prep-sechead">
        <h3 class="prep-sectitle">{prepItemName(item)}</h3>
        <div class="prep-toggle" role="group" aria-label={prepItemName(item)}>
          <button type="button" class={!held ? 'on' : ''} aria-pressed={!held} disabled={!can || !held} onClick={() => onToggle(false)}>{tr('任せる', 'Leave it')}</button>
          <button type="button" class={held ? 'on' : ''} aria-pressed={held} disabled={!can || held} onClick={() => onToggle(true)}>{tr('自分で', 'Decide')}</button>
        </div>
      </header>
      <p class="prep-line">{line}</p>
      {!held && editable && !locked && <p class="prep-cost">{prepItemCost(item)}</p>}
      {wish && <div class={locked ? 'prep-locked' : ''} inert={locked}>{wish}</div>}
      {children && <div class={`prep-body ${locked ? 'prep-locked' : ''}`} inert={locked}>{children}</div>}
    </section>
  );
}

export function Prepare({ runId }: { runId: string }) {
  useLocaleRefresh();
  const { catalog, error: catErr } = useCatalog();
  const L = getLocale();
  // 鍵: undefined = 同じ機械から（鍵なし）、null = まだ探している
  const [tok, setTok] = useState<string | undefined | null>(null);
  const [data, setData] = useState<OwnerViewResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);
  // 切り替えを送っている間の、握る項目（読み直しで段が閉じたり開いたりしないように）
  const [optHold, setOptHold] = useState<DirectiveItem[] | null>(null);
  const [confirmReady, setConfirmReady] = useState<string[] | null>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmReady) backRef.current?.focus(); }, [confirmReady]);

  // そのランの冒険者の鍵を探す（持ち主の口の一覧で、その鍵の冒険者のランとして返るもの）。無ければ鍵なし（同じ機械から）
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const t of storedKeys()) {
        try {
          const r = await api.ownerRuns(t);
          if (r.runs.some((x) => x.runId === runId && x.mine)) { if (alive) setTok(t); return; }
        } catch { /* 次の鍵 */ }
      }
      if (alive) setTok(undefined);
    })();
    return () => { alive = false; };
  }, [runId]);

  const load = async () => {
    if (tok === null) return;
    try {
      const d = await api.ownerView(runId, tok);
      if (!aliveRef.current || busyRef.current) return;
      setData(d);
      setLoadErr(null);
    } catch (e) {
      if (aliveRef.current) setLoadErr(httpErrText(e));
    }
  };
  useEffect(() => {
    if (tok === null) return;
    void load();
    const t = setInterval(() => { if (!busyRef.current) void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [tok, runId]);

  // 伝言の下書き: 書きかけでなければ、サーバーの値に合わせる
  const serverMsg = data?.view.directive?.message ?? '';
  const [msg, setMsg] = useState('');
  const baseMsg = useRef<string | null>(null);
  useEffect(() => {
    if (baseMsg.current === null || msg === baseMsg.current) setMsg(serverMsg);
    baseMsg.current = serverMsg;
  }, [serverMsg]);
  const dirty = msg !== serverMsg;

  /** POST の結果を受ける。断りなら文をそのまま、通れば ok を呼ぶ */
  const post = async (f: () => Promise<OwnerViewResponse>, ok?: (before: OwnerViewResponse | null, after: OwnerViewResponse) => void): Promise<OwnerViewResponse | null> => {
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setNote(null);
    const before = data;
    try {
      const r = await f();
      if (!aliveRef.current) return r;
      setData(r);
      if (r.result && !r.result.ok) setErr(actionErrText(r.result.error));
      else ok?.(before, r);
      return r;
    } catch (e) {
      if (aliveRef.current) setErr(httpErrText(e));
      return null;
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };
  const failed = (r: OwnerViewResponse | null) => !r || (!!r.result && !r.result.ok);

  const view = data?.view;
  const obs = data?.observation;
  const name = view?.self.name ?? '';
  const serverHold = ordered(view?.directive?.hold ?? []);
  const hold = optHold ?? serverHold;

  /**
   * 握る・やめる（すぐ送る）。S10a §1: 送る直前に読み直し、サーバーの今の握る項目に、押した 1 つだけを足す・外す（directiveToggle）。
   * 伝言は読み直したサーバーの値のまま（書きかけは送らない: 下書きのまま残す。ほかのタブの変更を、古い値で上書きしない）
   */
  const toggle = (x: DirectiveItem, on: boolean) => {
    if (!data || busyRef.current) return;
    setOptHold(on ? ordered([...serverHold, x]) : serverHold.filter((y) => y !== x));
    void post(async () => {
      const fresh = await api.ownerView(runId, tok ?? undefined);
      const d = directiveToggle(fresh.view.directive, x, on);
      return d ? api.ownerDirective(runId, d, tok ?? undefined) : fresh;
    }, () => {
      setNote(on
        ? tr(`${prepItemName(x)}は、あなたが決める。`, `You decide: ${prepItemName(x)}.`)
        : tr(`${prepItemName(x)}は、${name}に任せる。`, `${prepItemName(x)} is left to ${name}.`));
    }).finally(() => setOptHold(null));
  };

  /** 握った項目の命令・支度（prepare）。装備で呪いと分かっている品は、断りの文を見せて確かめてから confirm: true で送り直す */
  const act = async (command: Command): Promise<void> => {
    const r = await post(() => api.ownerAct(runId, command, tok ?? undefined), (before, after) => {
      if (command.type === 'equip' || command.type === 'unequip') {
        const t = before ? statChangeText(before.observation.self, after.observation.self) : '';
        setNote(t || tr('能力は変わらない。', 'No stat changed.'));
      } else if (command.type === 'prepare') {
        setNote(command.ready === true
          ? tr(`準備完了。${name}が来たら、出発する。AI に、声をかける。`, `Ready. ${name} sets out when they come. Let your AI know.`)
          : command.ready === false ? tr('「まだ」に戻した。決め直したら、もう一度「準備完了」。', 'Back to not ready. Mark ready again when you are done.')
            : tr('目的を選んだ。', 'Objective chosen.'));
      } else {
        setNote(tr('選んだ。', 'Chosen.'));
      }
    });
    if (command.type === 'equip' && !command.confirm && r?.result && !r.result.ok && r.result.error.code === 'confirm_required') {
      if (window.confirm(`${r.result.error.message}\n${tr('それでも装備しますか？', 'Equip it anyway?')}`)) await act({ ...command, confirm: true });
    }
  };
  const invAction = (a: InvAction, slot: string) => {
    if (busyRef.current) return;
    if (a === 'equip') void act({ type: 'equip', slot });
    else if (a === 'unequip') void act({ type: 'unequip', slot });
  };

  /** 伝言を残す（S10a §1: 握る項目は、送る直前に読み直したサーバーの値のまま。準備完了の間も残せる: 札は戻らない） */
  const saveMessage = async (): Promise<boolean> => {
    const r = await post(async () => {
      const fresh = await api.ownerView(runId, tok ?? undefined);
      const d = messageSave(fresh.view.directive, msg, MESSAGE_MAX);
      return d ? api.ownerDirective(runId, d, tok ?? undefined) : fresh;
    }, () => {
      setNote(tr(`伝言を残した。${name}には、キャンプで届く。`, `Message left. ${name} reads it at camp.`));
    });
    return !failed(r);
  };
  /** 準備完了（書きかけの伝言があれば、先に残す） */
  const doReady = async () => {
    if (dirty && !(await saveMessage())) return;
    await act({ type: 'prepare', ready: true });
  };
  const markReady = () => {
    const items = readyCheck(obs?.self.directive?.undecided);
    if (items) setConfirmReady(items);
    else void doReady();
  };

  // ---- 見るもの ----
  const status = view ? (view.status === 'at_camp' ? 'at_camp' : view.status === 'dead' || view.status === 'ended' || view.runStatus === 'ended' ? 'ended' : 'in_dungeon') : 'in_dungeon';
  const season = view?.season ? { budgetLeft: view.season.budgetLeft, ended: !!view.season.ended, final: !!view.season.final } : null;
  const prepSt = view ? prepStateView(view) : null;
  const head = view ? prepHead({ name, eligible: !!data?.eligible, status, depth: view.floor?.depth ?? null, hold, prep: prepSt, season, oldVersion: !!data?.oldVersion }) : null;
  const editable = !!head?.editable;
  // 準備完了の間は、段の切り替えと決める操作を押せない（S10a §2）。伝言だけは残せる
  const locked = head?.kind === 'ready';
  // 運用者として開いている（鍵が無く、同じ機械から。S10a §5）
  const asOperator = tok === undefined;
  const chosen = hold.includes('objective') ? view?.directive?.prep?.objective : undefined;
  const wishes: DirectiveWish[] = view && status === 'at_camp' ? activeWishes(view) : [];
  const und = obs?.self.directive?.undecided;
  const equipNames = view && catalog
    ? (['weapon', 'armor', 'accessory'] as const).map((s) => view.inventory.find((i) => i.equipped === s)).filter((i): i is NonNullable<typeof i> => !!i)
      .map((i) => itemDisplayName(catalog, L, i.kind, i.appearanceId, i.affixes))
    : [];
  const perkNames = view && catalog ? view.self.build.perks.map((id) => nameOf(catalog.perks[id]?.name, L, id.split(':').pop() ?? id)) : [];
  const boonNames = view && catalog ? view.self.boons.map((id) => nameOf(catalog.boons?.[id]?.name, L, id.split(':').pop() ?? id)) : [];
  const pend = view?.self.build.pending[0];
  const lineOf = (item: DirectiveItem) => prepLine(item, {
    name, held: hold.includes(item),
    chosen: chosen !== undefined && view ? ownerOfferText(L, view, chosen) : null,
    equipment: equipNames, gear: und?.gear,
    perks: perkNames, boons: boonNames,
    perkPending: pend ? { level: pend.level, options: pend.options.length } : null,
    boonPending: view?.self.boonChoice ? { depth: view.self.boonChoice.depth, options: view.self.boonChoice.options.length } : null,
  });
  const decideHere = (item: DirectiveItem) => editable && hold.includes(item) && serverHold.includes(item);
  const wishOf = (item: DirectiveItem) => {
    const ws = wishes.filter((w) => wishSection(w) === item);
    if (!ws.length || !view || !catalog) return null;
    return (
      <ul class="prep-wishes">
        {ws.map((w) => {
          const c = editable && !locked ? wishCommand(view, w) : null;
          return (
            <li key={w.item}>
              <span class="prep-wish">{tr(`${name}の希望: ${wishLabel(L, catalog, w, wishItemOf(view, w))}`, `${name}'s wish: ${wishLabel(L, catalog, w, wishItemOf(view, w))}`)}</span>
              {w.reason && <span class="prep-reason"> ―「{w.reason}」</span>}
              {c && <button class="prep-btn small" disabled={busy} onClick={() => void act(c)}>{tr('希望どおりにする', 'Do as wished')}</button>}
            </li>
          );
        })}
      </ul>
    );
  };
  const rules = rulesOf(catalog);
  const className = view && catalog ? kindName(catalog, L, view.self.classId) : view?.self.classId ?? '';
  const ai = data?.eligible ? aiPresenceText(data.ai, name) : null;
  const objectiveUnchosen = hold.includes('objective') && chosen === undefined;

  return (
    <div class="page">
      <Header title={tr('支度', 'Preparations')} />
      <HubNav tab={null} />
      <ErrorBanner error={catErr} />
      <div class="hub prep">
        <div class="hub-col">
          <a class="prep-back" href="#/">{tr('← 拠点へ', '← Back to the hub')}</a>
          {!data && !loadErr && <p class="hub-note">{tr('読み込み中…', 'Loading…')}</p>}
          {!data && loadErr && (
            <section class="hub-empty">
              <h2 class="hub-keytitle">{tr('この冒険者の支度は、開けない', 'These preparations cannot be opened')}</h2>
              <p class="hub-note">{loadErr}</p>
              <div class="hub-links"><a class="hub-btn primary" href="#/">{tr('拠点へ', 'Back to the hub')}</a></div>
            </section>
          )}
          {data && view && obs && head && (
            <>
              <section class="prep-hero">
                <header class="hub-cardhead">
                  <div class="hub-who">
                    <h1 class="hub-name">{name}</h1>
                    <div class="hub-sub">{[className, `Lv${view.self.level}`, `HP ${view.self.stats.hp}/${view.self.stats.maxHp}`].filter(Boolean).join(' · ')}</div>
                  </div>
                  <div class="hub-pills">
                    <HubPill text={head.pill.text} tone={head.pill.tone} />
                    {asOperator && <HubPill text={tr('運用者として', 'As the operator')} tone="operator" />}
                  </div>
                </header>
                <p class="hub-note">{tr('装備', 'Gear')}: {equipNames.length ? equipNames.join(tr('・', ', ')) : tr('何も身に着けていない', 'nothing worn')}</p>
                <p class={`prep-headline tone-${head.pill.tone}`}>{head.line}</p>
                {asOperator && <p class="hub-note">{tr('この冒険者の鍵は、このブラウザに無い。サーバーと同じ機械から、運用者として開いている。', 'This browser has no key for this adventurer. You opened it as the operator, on the server machine.')}</p>}
                {locked && <p class="hub-note">{tr('準備完了の間は、変えられない。変えるには、先に「支度を見直す」', 'While ready, nothing can be changed. To change something, first "Review the preparations"')}</p>}
                {head.kind === 'watch' && <div class="hub-actions"><a class="hub-btn primary" href={`#/watch/${runId}`}>{tr('見守る', 'Watch')}</a></div>}
                {head.kind === 'human' && (
                  <div class="hub-actions">
                    {getToken(runId)
                      ? <a class="hub-btn primary" href={`#/play/${runId}`}>{tr('続きを遊ぶ', 'Continue')}</a>
                      : <a class="hub-btn primary" href={`#/watch/${runId}`}>{tr('見守る', 'Watch')}</a>}
                  </div>
                )}
              </section>

              {data.eligible && (
                <>
                  <PrepSection item="objective" held={hold.includes('objective')} line={lineOf('objective')} editable={editable} locked={locked} busy={busy} onToggle={(on) => toggle('objective', on)} wish={wishOf('objective')}>
                    {decideHere('objective') && view.camp && (
                      <ul class="offers cards prep-offers">
                        {view.camp.offers.map((o) => (
                          <OfferCard key={o.index} o={o} rules={rules} level={view.self.level} view={view} catalog={catalog} chosen={chosen === o.index} disabled={busy}
                            actionLabel={tr('この目的にする', 'Choose this')} onStart={(i) => void act({ type: 'prepare', objective: i })} />
                        ))}
                        <li class={`offer endless ${chosen === 'endless' ? 'chosen' : ''}`}>
                          <div class="ohead">
                            <span class="otext">{tr('endless) 目的なし。できるだけ深く潜る', 'endless) No objective: descend as deep as you can')}</span>
                            {chosen === 'endless'
                              ? <span class="tag chosen">{tr('選んだ', 'Chosen')}</span>
                              : <button class="small" disabled={busy} onClick={() => void act({ type: 'prepare', objective: 'endless' })}>{tr('目的なしにする', 'Choose endless')}</button>}
                          </div>
                        </li>
                      </ul>
                    )}
                  </PrepSection>

                  <PrepSection item="loadout" held={hold.includes('loadout')} line={lineOf('loadout')} editable={editable} locked={locked} busy={busy} onToggle={(on) => toggle('loadout', on)} wish={wishOf('loadout')}>
                    {decideHere('loadout') && catalog && (
                      <>
                        <p class="prep-cost">{tr(`命中+${obs.self.attack.acc}・ダメージ${obs.self.attack.dmg}・回避${obs.self.defense.eva}・装甲${obs.self.defense.armor}・速さ${obs.self.speed}`, `acc +${obs.self.attack.acc}, dmg ${obs.self.attack.dmg}, eva ${obs.self.defense.eva}, armor ${obs.self.defense.armor}, speed ${obs.self.speed}`)}</p>
                        <InventoryPanel view={view} catalog={catalog} actions={['equip', 'unequip']} onAction={invAction} />
                      </>
                    )}
                  </PrepSection>

                  <PrepSection item="perks" held={hold.includes('perks')} line={lineOf('perks')} editable={editable} locked={locked} busy={busy} onToggle={(on) => toggle('perks', on)} wish={wishOf('perks')}>
                    {decideHere('perks') && (
                      <>
                        {obs.self.perk_choice && (
                          <PerkChoicePanel choice={obs.self.perk_choice} catalog={catalog} classId={view.self.classId} sent={busy}
                            note={tr(`あなたが選ぶ。${name}が選びたいものは、希望としてここに届く`, `You choose; what ${name} would pick reaches you here as a wish`)}
                            onChoose={(option) => void act({ type: 'choose_perk', option })} />
                        )}
                        {view.self.boonChoice && <BoonChoicePanel choice={view.self.boonChoice} catalog={catalog} onChoose={(option) => void act({ type: 'choose_boon', option })} />}
                        {!obs.self.perk_choice && !view.self.boonChoice && <p class="prep-cost">{tr('いま身につけられるものは無い（レベルが上がる・大守護者を倒すと増える）。', 'Nothing to take up now (level-ups and warden kills add some).')}</p>}
                      </>
                    )}
                  </PrepSection>

                  <section class="prep-final">
                    <label class="prep-msglabel" for="prep-msg">{tr(`${name}への伝言`, `Message to ${name}`)}</label>
                    <textarea id="prep-msg" class="prep-msg" rows={3} maxLength={MESSAGE_MAX} value={msg} disabled={!editable || busy}
                      placeholder={tr(`キャンプで、${name}に届く。聞くかどうかは、${name}が決める`, `Reaches ${name} at camp. Whether to follow it is up to them`)}
                      onInput={(e) => setMsg((e.target as HTMLTextAreaElement).value)} />
                    <div class="prep-msgrow">
                      <small>{msg.length}/{MESSAGE_MAX}</small>
                      {dirty && editable && (
                        <span class="prep-msgacts">
                          <button class="prep-btn small" disabled={busy} onClick={() => setMsg(serverMsg)}>{tr('戻す', 'Revert')}</button>
                          <button class="prep-btn small" disabled={busy} onClick={() => void saveMessage()}>{tr('伝言を残す', 'Leave the message')}</button>
                        </span>
                      )}
                    </div>
                    {err && <p class="hub-err">{err}</p>}
                    {note && <p class="prep-ok">{note}</p>}
                    {head.kind === 'pending' && (
                      <>
                        <button class="hub-btn primary big" disabled={busy || objectiveUnchosen} onClick={markReady}>{tr('準備完了', 'Ready')}</button>
                        {objectiveUnchosen && <p class="hub-note">{tr('目的を選ぶと、準備完了にできる。', 'Choose an objective to mark ready.')}</p>}
                        <p class="hub-note">{tr(`${name}は、それまで出発しない。`, `${name} does not set out until then.`)}</p>
                      </>
                    )}
                    {head.kind === 'ready' && (
                      <>
                        <p class="hub-note">{tr('変えるには、「支度を見直す」（「まだ」に戻る）', 'To change anything, press "Review the preparations" (it goes back to not ready)')}</p>
                        <button class="hub-btn primary big" disabled={busy} onClick={() => void act({ type: 'prepare', ready: false })}>{tr('支度を見直す', 'Review the preparations')}</button>
                      </>
                    )}
                    {head.kind === 'free' && <p class="hub-note">{tr(`全部、任せている。${name}は、自分で決めて出発する。決めたい段を「自分で」にすると、ここで決められる。`, `Everything is left to ${name}, who decides and sets out on their own. Switch a section to "Decide" to decide it here.`)}</p>}
                    {ai && head.editable && <p class="hub-note">{ai}</p>}
                  </section>
                </>
              )}
              {loadErr && <p class="hub-err">{loadErr}</p>}
            </>
          )}
        </div>
      </div>
      {confirmReady && (
        <div class="hub-modal" onClick={() => setConfirmReady(null)}>
          <div class="hub-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') setConfirmReady(null); }}>
            <h2 class="hub-dtitle">{tr('まだ決めていないものがある', 'Some things are not decided yet')}</h2>
            <ul class="prep-list">{confirmReady.map((x) => <li key={x}>{x}</li>)}</ul>
            <p class="hub-note">{tr('このまま準備完了にすると、冒険者が来たら出発し、決められるのは次のキャンプになる（遠征の間は、だれも選べない・付け替えられない）。', 'If you mark ready now, they set out when they come and these wait until the next camp (nobody can choose or change them during the expedition).')}</p>
            <div class="hub-dactions">
              <button ref={backRef} class="hub-btn primary" onClick={() => setConfirmReady(null)}>{tr('戻って決める', 'Go back and decide')}</button>
              <button class="hub-btn" disabled={busy} onClick={() => { setConfirmReady(null); void doReady(); }}>{tr('このまま準備完了', 'Ready anyway')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// 持ち主の枠（S8。SEASON.md §54.5）: ホームの「出撃」の、自分のランの 1 枠。状態・握る項目のスイッチと伝言・握った項目の決定。
// 見えるものは、そのプレイヤーの PlayerView と、AI に届くのと同じ観測（GET …/owner/view）だけ。持ち主に、プレイヤーより多くを見せない。
// 命令は、プレイヤーと同じ Command を持ち主の口（POST …/owner/act）へ送る。通るか・断るかを決めるのはサーバー（engine）で、断りの文はそのまま出す。
// プロフィールのトークンは、そのランを返したもの（呼び出し側が覚えている）を Authorization の見出しでだけ渡す（画面・URL・console に出さない）。
import type { ActionError, Catalog, Command, DirectiveItem, Observation, OwnerRunRow, OwnerViewResponse } from '@muse/shared';
import { DIRECTIVE_ITEMS, directiveItemsText, kindName } from '@muse/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, api, errorText } from '../api';
import { getLocale, getToken, inLocale, tr } from '../util';
import { BoonChoicePanel, PerkChoicePanel } from './build';
import { InventoryPanel, type InvAction } from './panels';

/** 持ち主の枠の読み直しの間（キャンプにいる間だけ） */
const OWNER_POLL_MS = 4000;
/** 伝言の長さの上限（SEASON.md §54.2） */
const MESSAGE_MAX = 280;

/** HTTP の断り（403 など。サーバーの文は「日本語 / English」を並べたものがある）を画面の言葉で */
function httpErrText(e: unknown): string {
  if (e instanceof ApiError && e.error) return `${inLocale(e.error.message)}${e.error.hint ? ` — ${inLocale(e.error.hint)}` : ''}`;
  return errorText(e);
}

/** engine の断り（そのまま。message と hint） */
function actionErrText(err: ActionError): string {
  return `${err.message}${err.hint ? ` — ${err.hint}` : ''}`;
}

/**
 * 装備を替えたときの能力の変わった所（SEASON.md §53 の「前 → 後」。サーバーの装備の結果の文と同じ項目: 命中・ダメージ・回避・装甲・速さ）。
 * 変わっていなければ空
 */
export function statChangeText(a: Observation['self'], b: Observation['self']): string {
  const sg = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  const parts = [
    a.attack.acc !== b.attack.acc ? tr(`命中${sg(a.attack.acc)} → ${sg(b.attack.acc)}`, `acc ${sg(a.attack.acc)} -> ${sg(b.attack.acc)}`) : '',
    a.attack.dmg !== b.attack.dmg ? tr(`ダメージ${a.attack.dmg} → ${b.attack.dmg}`, `dmg ${a.attack.dmg} -> ${b.attack.dmg}`) : '',
    a.defense.eva !== b.defense.eva ? tr(`回避${a.defense.eva} → ${b.defense.eva}`, `eva ${a.defense.eva} -> ${b.defense.eva}`) : '',
    a.defense.armor !== b.defense.armor ? tr(`装甲${a.defense.armor} → ${b.defense.armor}`, `armor ${a.defense.armor} -> ${b.defense.armor}`) : '',
    a.speed !== b.speed ? tr(`速さ${a.speed} → ${b.speed}`, `speed ${a.speed} -> ${b.speed}`) : '',
  ].filter(Boolean);
  return parts.length ? tr(`能力の変わった所: ${parts.join('・')}。`, `Stats changed: ${parts.join(', ')}.`) : '';
}

/** 握る項目の名前と、握ることの代価（SEASON.md §54.3） */
function itemLabel(x: DirectiveItem): { name: string; cost: string } {
  if (x === 'objective') {
    return {
      name: tr('目的', 'Objective'),
      cost: tr('次の遠征の目的は、あなたがキャンプで選ぶ。決めるまで、AI は待つ。迷宮の中のこと（帰還・撤退を含む）は AI が決める', 'You pick the next expedition at camp; the AI waits until you do. Everything inside the dungeon (including extracting) stays with the AI'),
    };
  }
  if (x === 'loadout') {
    return {
      name: tr('装備', 'Equipment'),
      cost: tr('装備は、あなたがキャンプで決める。迷宮で手に入れた装備は、キャンプで確かめるまで身に着けない（拾った良い武器も、持ち帰って次のキャンプで。キャンプは品の正体や呪いを明かさない）', 'You set the equipment at camp. Gear found in the dungeon is not worn until it is looked over at camp (even a good weapon found inside waits for the next camp; camp does not reveal what an item is or whether it is cursed)'),
    };
  }
  return {
    name: tr('特技と加護', 'Perks and boons'),
    cost: tr('特技と加護は、あなたがキャンプで選ぶ。遠征の間に強くなって覚えられることが増えても、身につけるのはキャンプに戻ってから（効き目が遅れる）', 'You choose perks and boons at camp. What the AI grows able to learn during an expedition is taken up only back at camp (the effect comes later)'),
  };
}

const ordered = (xs: readonly DirectiveItem[]): DirectiveItem[] => DIRECTIVE_ITEMS.filter((x) => xs.includes(x));

/**
 * 持ち主の枠。row: GET /api/owner/runs の 1 行（親が数秒ごとに読み直す）。token: そのランを返したトークン（無ければ同じ機械から）。
 * onChanged: 指図・命令が通ったとき（親が一覧を読み直す）
 */
export function OwnerRunCard({ row, token, catalog, onChanged }: { row: OwnerRunRow; token?: string; catalog: Catalog | null; onChanged: () => void }) {
  const L = getLocale();
  const [open, setOpen] = useState(row.waiting);
  const [data, setData] = useState<OwnerViewResponse | null>(null);
  /** err: 断り（指図・命令）。loadErr: 中身を読めなかった（認められない・ランが無い） */
  const [err, setErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // 新しいほうを使う: 読んだ中身（開いている間・命令の応答）と、一覧の行（親が数秒ごとに読み直す）。受け取った時刻で比べる
  const dataAtRef = useRef(0);
  const rowSeen = useRef<{ row: OwnerRunRow; at: number }>({ row, at: Date.now() });
  if (rowSeen.current.row !== row) rowSeen.current = { row, at: Date.now() };
  const fresh = data && data.runId === row.runId ? data : null;
  const cur = fresh && dataAtRef.current >= rowSeen.current.at ? fresh : null;
  // サーバーの今の指図・状態
  const serverHold = ordered(cur ? cur.view.directive?.hold ?? [] : row.hold);
  const serverMsg = cur ? cur.view.directive?.message ?? '' : row.message;
  const status = cur ? (cur.view.status === 'at_camp' ? 'at_camp' : cur.view.status === 'dead' || cur.view.status === 'ended' ? 'ended' : 'in_dungeon') : row.status;
  const atCamp = status === 'at_camp';
  const eligible = cur ? cur.eligible : row.eligible;
  const waiting = cur ? cur.waiting : row.waiting;

  // 下書き（握る項目と伝言）。書きかけでなければ、サーバーの値に合わせる
  const [hold, setHold] = useState<DirectiveItem[]>(serverHold);
  const [msg, setMsg] = useState(serverMsg);
  const baseRef = useRef({ hold: serverHold.join(','), msg: serverMsg });
  const serverKey = `${serverHold.join(',')}\u0000${serverMsg}`;
  useEffect(() => {
    const clean = ordered(hold).join(',') === baseRef.current.hold && msg === baseRef.current.msg;
    baseRef.current = { hold: serverHold.join(','), msg: serverMsg };
    if (clean) { setHold(serverHold); setMsg(serverMsg); }
  }, [serverKey]);
  const dirty = ordered(hold).join(',') !== serverHold.join(',') || msg !== serverMsg;

  // AI が待ち始めたら、枠を開く
  useEffect(() => { if (row.waiting) setOpen(true); }, [row.waiting]);

  const load = async () => {
    try {
      const d = await api.ownerView(row.runId, token);
      if (!aliveRef.current || busyRef.current) return;
      dataAtRef.current = Date.now();
      setData(d);
      setLoadErr(null);
    } catch (e) {
      if (aliveRef.current) setLoadErr(httpErrText(e));
    }
  };
  const statusRef = useRef(status);
  statusRef.current = status;
  useEffect(() => {
    if (!open) return;
    void load();
    const t = setInterval(() => { if (statusRef.current === 'at_camp' && !busyRef.current) void load(); }, OWNER_POLL_MS);
    return () => clearInterval(t);
  }, [open, row.runId, token, row.status]);
  // 指図の対象でないラン: 理由（サーバーの文）を 1 回だけ読む
  useEffect(() => { if (!row.eligible && !open) void load(); }, [row.runId, row.eligible]);

  /** POST の結果を受ける。断りなら文をそのまま、通れば ok を呼ぶ */
  const post = async (f: () => Promise<OwnerViewResponse>, ok?: (before: OwnerViewResponse | null, after: OwnerViewResponse) => void): Promise<OwnerViewResponse | null> => {
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    setNote(null);
    const before = fresh;
    try {
      const r = await f();
      if (!aliveRef.current) return r;
      dataAtRef.current = Date.now();
      setData(r);
      if (r.result && !r.result.ok) setErr(actionErrText(r.result.error));
      else { ok?.(before, r); onChanged(); }
      return r;
    } catch (e) {
      if (aliveRef.current) setErr(httpErrText(e));
      return null;
    } finally {
      busyRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  };

  const saveDirective = () => {
    void post(() => api.ownerDirective(row.runId, { hold: ordered(hold), message: msg.slice(0, MESSAGE_MAX) }, token), () => {
      setNote(tr('指図を保存した。AI には、次の観測で届く。', 'Directive saved. The AI sees it in its next observation.'));
    });
  };

  /** 握った項目の命令。装備で呪いと分かっている品は、断りの文を見せて確かめてから confirm: true で送り直す */
  const act = async (command: Command) => {
    const r = await post(() => api.ownerAct(row.runId, command, token), (before, after) => {
      if (command.type === 'equip' || command.type === 'unequip') {
        const t = before ? statChangeText(before.observation.self, after.observation.self) : '';
        setNote(t || tr('能力は変わらない。', 'No stat changed.'));
      } else if (command.type === 'start_expedition') {
        setNote(tr('遠征を始めた。遠征の途中は、見守る。', 'Expedition started. Watch it from here on.'));
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

  const toggle = (x: DirectiveItem) => setHold((h) => (h.includes(x) ? h.filter((y) => y !== x) : ordered([...h, x])));

  const className = catalog ? kindName(catalog, L, row.classId) : row.classId;
  const playable = !!getToken(row.runId);
  const obs = fresh?.observation;
  const view = fresh?.view;
  const heldNow = ordered(view?.directive?.hold ?? []);
  const decided = view?.directive?.decided ?? [];
  const seasonOver = !!obs?.season && (obs.season.budget.left <= 0 || obs.season.ended);
  // 数字も、新しいほうから
  const cv = cur?.view;
  const hp = cv ? cv.self.stats.hp : row.hp;
  const maxHp = cv ? cv.self.stats.maxHp : row.maxHp;
  const level = cv ? cv.self.level : row.level;
  const banked = cv ? cv.record.banked : row.banked;
  const depth = cv ? cv.floor?.depth ?? null : row.depth;
  const cs = cur?.observation.season;
  const budget = cs ? { left: Math.max(0, cs.budget.left), limit: cs.budget.limit }
    : row.budgetLeft !== undefined && row.budgetLimit !== undefined ? { left: row.budgetLeft, limit: row.budgetLimit } : null;
  const where = status === 'at_camp' ? tr('キャンプにいる', 'At camp') : status === 'ended' ? tr('終わった', 'Ended') : depth !== null ? tr(`遠征の途中・地下${depth}階`, `On an expedition, depth ${depth}`) : tr('遠征の途中', 'On an expedition');

  return (
    <section class={`panel owner ${waiting ? 'waiting' : ''}`}>
      <h3>
        {row.name} <small>{className}</small>
        {row.season && <span class="tag">{tr(`シーズン「${row.season.name}」`, `Season "${row.season.name}"`)}</span>}
        {/* 順位の表の名前（招いたときの表示名）がランの名前と違うとき */}
        {row.season?.participant && row.season.participant !== row.name && <small>{tr(`順位の表では「${row.season.participant}」`, `"${row.season.participant}" in the standings`)}</small>}
        <span class={`tag vstatus ${status === 'at_camp' ? 'at_camp' : status === 'ended' ? 'ended' : 'your_turn'}`}>{where}</span>
        <span class="oacts">
          <a class="button small" href={`#/watch/${row.runId}`}>{tr('観戦', 'Watch')}</a>
          {playable && <a class="button small primary" href={`#/play/${row.runId}`}>{tr('自分で遊ぶ', 'Play')}</a>}
        </span>
      </h3>
      {waiting && <div class="waitmark">{tr('AI が、あなたの決定を待っている（次の遠征の目的）', 'The AI is waiting for your decision (the next expedition)')}</div>}
      <div class="ostat">
        <span>HP {hp}/{maxHp}</span>
        <span>Lv{level}</span>
        {depth !== null && status === 'in_dungeon' && <span>{tr(`地下${depth}階`, `depth ${depth}`)}</span>}
        <span>{tr(`確定 ${banked}`, `banked ${banked}`)}</span>
        {budget && <span class={budget.left < 100 ? 'low' : ''}>{tr(`予算の残り ${budget.left}/${budget.limit} 手番`, `budget left ${budget.left}/${budget.limit} turns`)}</span>}
      </div>
      {loadErr && <div class="oerr">⚠ {loadErr}</div>}
      {!eligible ? (
        <p class="muted">{fresh?.reason ?? tr('このランは指図の対象ではない（人間が自分で遊ぶラン）。自分で遊ぶか、観戦する。', 'This run takes no directives (a human plays it). Play it yourself or watch it.')}</p>
      ) : (
        <>
          <div class="directive">
            <div class="row">
              <span class="lbl">{tr('持ち主が決める', 'You decide')}:</span>
              {DIRECTIVE_ITEMS.map((x) => {
                const it = itemLabel(x);
                return (
                  <label key={x} class="check ohold" title={it.cost}>
                    <input type="checkbox" checked={hold.includes(x)} disabled={!atCamp || busy} onChange={() => toggle(x)} />{it.name}
                  </label>
                );
              })}
            </div>
            {hold.length > 0 && <ul class="ocost muted small">{ordered(hold).map((x) => <li key={x}>{itemLabel(x).cost}</li>)}</ul>}
            {!hold.length && <p class="muted small">{tr('何も握っていない: AI がすべて決める（既定）。', 'Nothing held: the AI decides everything (the default).')}</p>}
            <textarea class="omsg" rows={2} maxLength={MESSAGE_MAX} value={msg} disabled={!atCamp || busy}
              placeholder={tr('伝言（AI に書く文。キャンプの観測に「持ち主から」として届く。聞くかどうかは AI が決める）', 'Message to your AI (shown in its camp observation as "From your owner"; whether to follow it is up to the AI)')}
              onInput={(e) => setMsg((e.target as HTMLTextAreaElement).value)} />
            <div class="row">
              <small>{msg.length}/{MESSAGE_MAX}</small>
              <button class="small primary" disabled={!atCamp || !dirty || busy} onClick={saveDirective}>{tr('指図を保存', 'Save directive')}</button>
              {dirty && atCamp && <button class="small" disabled={busy} onClick={() => { setHold(serverHold); setMsg(serverMsg); }}>{tr('戻す', 'Revert')}</button>}
            </div>
            <p class="muted small">{row.season
              ? tr('伝言は、観戦している人にも見える（AI の考えと同じ。開催中のシーズンのランを観戦できるのは、持ち主とサーバーと同じ機械だけ）。', 'The message is visible to spectators too (like the AI\'s thoughts; a run of a season in progress can be watched only by its owner and from the server machine).')
              : tr('伝言は、観戦している人にも見える（AI の考えと同じ）。', 'The message is visible to spectators too (like the AI\'s thoughts).')}</p>
            {!atCamp && status !== 'ended' && (
              <p class="muted">{tr('遠征の途中は、見守る（指図と伝言はキャンプでだけ変えられる）。', 'During an expedition, you watch (directives and messages change only at camp).')} <a class="button small" href={`#/watch/${row.runId}`}>{tr('観戦する', 'Watch')}</a></p>
            )}
            {decided.length > 0 && <p class="muted small">{tr(`このランで持ち主が決めた項目: ${directiveItemsText(L, decided)}（順位の表に印が付く。順位は分けない）`, `Decided by the owner in this run: ${directiveItemsText(L, decided)} (marked in the standings; ranks are not split)`)}</p>}
          </div>
          {err && <div class="oerr">⚠ {err}</div>}
          {note && <div class="onote">{note}</div>}
          <div class="row">
            <button class="small" onClick={() => setOpen(!open)}>{open ? tr('畳む', 'Collapse') : tr('詳しく（候補・持ち物・特技）', 'Details (offers, gear, perks)')}</button>
          </div>
          {open && !fresh && !loadErr && <div class="muted">{tr('読み込み中…', 'Loading…')}</div>}
          {open && fresh && obs && view && (
            <div class="odetail">
              {!atCamp && <p class="muted">{obs.summary}</p>}
              {atCamp && heldNow.length === 0 && <p class="muted small">{tr('握っている項目が無い（AI が決める）。上のスイッチで握って、指図を保存すると、ここで決められる。', 'Nothing is held (the AI decides). Tick an item above and save the directive to decide it here.')}</p>}
              {atCamp && heldNow.includes('objective') && (
                <div class="oblock">
                  <h4>{obs.camp ? tr(`次の遠征の候補（遠征 ${obs.camp.next_no}。AI に見えているのと同じ文）`, `Offers for expedition ${obs.camp.next_no} (the same text the AI sees)`) : tr('次の遠征の候補', 'Next offers')}</h4>
                  {seasonOver ? (
                    <p class="muted">{obs.season!.budget.left <= 0 ? tr('このシーズンの行動予算を使い切った。新しい遠征は始められない。', 'This season\'s budget is used up; no new expeditions.') : tr('シーズンは終わりの時刻を過ぎた。新しい遠征は始められない。', 'The season is past its end; no new expeditions.')}</p>
                  ) : obs.camp ? (
                    <ul class="offers ooffers">
                      {obs.camp.offers.map((o) => (
                        <li key={o.index}>
                          <div class="otext">
                            {o.text}
                            {(o.slays ?? []).map((s, i) => <div key={i} class="muted small oslay">{s.text}</div>)}
                          </div>
                          <button class="small primary" disabled={busy} onClick={() => void act({ type: 'start_expedition', offer: o.index })}>{tr('この目的で出撃', 'Start with this')}</button>
                        </li>
                      ))}
                      <li>
                        <div class="otext">{tr('endless) 目的なしでひたすら潜る', 'endless) no objective, just descend')}</div>
                        <button class="small" disabled={busy} onClick={() => void act({ type: 'start_expedition', offer: 'endless' })}>{tr('目的なしで出撃', 'Start endless')}</button>
                      </li>
                    </ul>
                  ) : <p class="muted">{tr('今は次の遠征を選べない。', 'No expedition can be chosen right now.')}</p>}
                </div>
              )}
              {atCamp && heldNow.includes('loadout') && catalog && (
                <div class="oblock">
                  <h4>{tr('持ち物と装備', 'Inventory and equipment')}</h4>
                  <p class="muted small">
                    {tr(`いまの装備: 武器 ${obs.self.equipment.weapon ?? 'なし'}・防具 ${obs.self.equipment.armor ?? 'なし'}・装飾 ${obs.self.equipment.accessory ?? 'なし'}`, `Equipped: weapon ${obs.self.equipment.weapon ?? 'none'}, armor ${obs.self.equipment.armor ?? 'none'}, accessory ${obs.self.equipment.accessory ?? 'none'}`)}
                    {' / '}{tr(`命中+${obs.self.attack.acc}・ダメージ${obs.self.attack.dmg}・回避${obs.self.defense.eva}・装甲${obs.self.defense.armor}・速さ${obs.self.speed}`, `acc +${obs.self.attack.acc}, dmg ${obs.self.attack.dmg}, eva ${obs.self.defense.eva}, armor ${obs.self.defense.armor}, speed ${obs.self.speed}`)}
                  </p>
                  <InventoryPanel view={view} catalog={catalog} actions={['equip', 'unequip']} onAction={invAction} />
                </div>
              )}
              {atCamp && heldNow.includes('perks') && (
                <div class="oblock">
                  <h4>{tr('身につけられる特技と加護（遠征の間に覚えられることが増えた分）', 'Perks and boons to take up (what the AI grew able to learn)')}</h4>
                  {obs.self.perk_choice && (
                    <PerkChoicePanel choice={obs.self.perk_choice} catalog={catalog} classId={view.self.classId} sent={busy}
                      note={tr('持ち主が選ぶ（指図）。AI の choose_perk は断られる', 'You choose (directive); the AI\'s choose_perk is refused')}
                      onChoose={(option) => void act({ type: 'choose_perk', option })} />
                  )}
                  {view.self.boonChoice && <BoonChoicePanel choice={view.self.boonChoice} catalog={catalog} onChoose={(option) => void act({ type: 'choose_boon', option })} />}
                  {!obs.self.perk_choice && !view.self.boonChoice && <p class="muted small">{tr('いま身につけられるものは無い（レベルが上がる・大守護者を倒すと増える）。', 'Nothing to take up now (level-ups and warden kills add some).')}</p>}
                </div>
              )}
              <details class="otext-all">
                <summary title={tr('AI に届く応答には、ほかに末尾の ▶ 行・変化・区切りの段などが付く', 'The AI\'s responses also carry the ▶ line, changes and the break section')}>{tr('観測（状態）', 'Observation (state)')}</summary>
                <pre class="records">{fresh.text}</pre>
              </details>
            </div>
          )}
        </>
      )}
    </section>
  );
}

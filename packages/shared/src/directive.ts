// 支度の札と希望（S9。SEASON.md §58.1・§58.2）の、engine・観測・持ち主の画面で共通に使う文と判定。
// 名前の表は、Catalog でも Content でも渡せる（どちらも ID → { name } の表を持つ）。World を読まない（engine は World から、観測は PlayerView から数えて渡す）。
import type { DirectiveWish, Locale, Names } from './types';
import type { Command } from './commands';
import type { PlayerView } from './view';
import { nameOf } from './catalog';
import { objectiveText } from './expedition';
import { t } from './util';

/** 名前の表（Catalog・Content のどちらでもよい） */
export interface DirectiveNames {
  items: Record<string, { name: Names }>;
  appearances: Record<string, { name: Names }>;
  perks: Record<string, { name: Names }>;
  boons?: Record<string, { name: Names }>;
}

/**
 * 支度で、持ち主がまだ決めていないもの（S9 §58.1）。objective: 目的を握っていて、まだ選んでいない。perk・boon: 握られた特技・加護の保留の候補。
 * gear: 装備を握っていて、前の準備完了（か札ができた）の後に持ち物に入った、身に着けていない装備できる品の数
 */
export interface PrepNeeds {
  objective?: true;
  perk?: { level: number; options: number; more: number };
  boon?: { depth: number; options: number };
  gear?: number;
}

export function prepNeedsAny(n: PrepNeeds | null | undefined): boolean {
  return !!n && (!!n.objective || !!n.perk || !!n.boon || !!n.gear);
}

/** 決めていないものの名前の並び（「次の遠征の目的」「特技（Lv2 の候補 3 つ）」「新しく持ち物に入った装備 1 品」） */
export function prepNeedsParts(L: Locale, n: PrepNeeds): string[] {
  return [
    n.objective ? t(L, '次の遠征の目的', 'the next expedition') : '',
    n.perk ? t(L, `特技（Lv${n.perk.level} の候補 ${n.perk.options} つ${n.perk.more ? `。ほかに ${n.perk.more} 回分` : ''}）`, `a perk (Lv${n.perk.level}, ${n.perk.options} options${n.perk.more ? `; ${n.perk.more} more after it` : ''})`) : '',
    n.boon ? t(L, `加護（地下${n.boon.depth}階の大守護者。候補 ${n.boon.options} つ）`, `a boon (warden of depth ${n.boon.depth}; ${n.boon.options} options)`) : '',
    n.gear ? t(L, `新しく持ち物に入った装備 ${n.gear} 品`, `${n.gear} new piece${n.gear > 1 ? 's' : ''} of gear in your pack`) : '',
  ].filter(Boolean);
}

/** 品の名前（未鑑定なら外見） */
function itemName(L: Locale, names: DirectiveNames, item: { kind: string | null; appearanceId: string | null } | null | undefined): string {
  if (item?.kind && names.items[item.kind]) return nameOf(names.items[item.kind].name, L);
  if (item?.appearanceId && names.appearances[item.appearanceId]) return nameOf(names.appearances[item.appearanceId].name, L);
  return t(L, 'その品', 'that item');
}

/**
 * 希望の短い名前（S9 §58.2。応答の文・持ち主の画面・思考の欄）。特技・加護はその名前、目的は候補と目的、装備は品の名前と、着けるか外すか。
 * item: 装備の希望の品（プレイヤーに見えている種類と外見。未鑑定なら種類は null）
 */
export function wishLabel(L: Locale, names: DirectiveNames, wish: DirectiveWish, item?: { kind: string | null; appearanceId: string | null } | null): string {
  switch (wish.item) {
    case 'objective':
      return wish.offer === 'endless' ? t(L, '目的なし（endless）', 'no objective (endless)') : t(L, `候補 ${wish.offer}: ${objectiveText(L, wish.objective)}`, `offer ${wish.offer}: ${objectiveText(L, wish.objective)}`);
    case 'loadout':
      return wish.act === 'equip' ? t(L, `${itemName(L, names, item)}を装備する`, `wear ${itemName(L, names, item)}`) : t(L, `${itemName(L, names, item)}を外す`, `take off ${itemName(L, names, item)}`);
    case 'perk':
      return nameOf(names.perks[wish.perk]?.name, L, wish.perk.split(':').pop() ?? wish.perk);
    case 'boon':
      return nameOf(names.boons?.[wish.boon]?.name, L, wish.boon.split(':').pop() ?? wish.boon);
  }
}

/** 希望を覚えた応答の文（S9 §58.2）: 「これは、持ち主が決める。あなたの希望（鎧さばき）は、持ち主に伝えた（持ち主が決めるのは、キャンプで）」 */
export function wishToldText(L: Locale, label: string): string {
  return t(L, `これは、持ち主が決める。あなたの希望（${label}）は、持ち主に伝えた（持ち主が決めるのは、キャンプで）。`,
    `This is your owner's call. Your wish (${label}) has been passed to your owner (they decide at camp).`);
}

/** 理由（命令の thought）を希望に添える形に: 制御文字・書式の文字を落とし、改行は空白に、前後の空白を除いて 280 字まで。空なら undefined */
export function wishReason(clean: (s: string) => string, thought: string | undefined): string | undefined {
  if (!thought) return undefined;
  const s = [...clean(thought)].slice(0, 280).join('').trim();
  return s || undefined;
}

/** 2 つの希望の中身が同じか（項目と中身。理由は見ない。S9c: 中身が同じなら出来事を足さず、理由は最初のものを残す） */
export function sameWish(a: DirectiveWish | undefined, b: DirectiveWish): boolean {
  if (!a) return false;
  const { reason: _ra, ...ra } = a;
  const { reason: _rb, ...rb } = b;
  return JSON.stringify(ra) === JSON.stringify(rb);
}

/** 希望をもう伝えてある（同じ中身）ときの応答の文（S9c） */
export function wishAlreadyText(L: Locale, label: string): string {
  return t(L, `その希望（${label}）は、もう持ち主に伝えてある（持ち主が決めるのは、キャンプで）。`, `That wish (${label}) has already been passed to your owner (they decide at camp).`);
}

/**
 * 持ち主が決めたものに添える、希望との並べ（S11）: 「（あなたの希望どおり）」「（あなたの希望は、頑健）」。
 * 希望は、持ち主が決めた時点で World から消えるので、サーバーがランの記録（決める前の希望の出来事）から決めて渡す
 */
export function wishNoteText(L: Locale, same: boolean, label: string): string {
  return same ? t(L, '（あなたの希望どおり）', ' (as you wished)') : t(L, `（あなたの希望は、${label}）`, ` (your wish was: ${label})`);
}

/** 「持ち主は、今、支度の画面を開いている」と言える間（S11。持ち主の画面は 5 秒ごとに読み直す） */
export const OWNER_PRESENCE_NOW_MS = 15_000;

/**
 * 待っている AI に、持ち主の様子を伝える 1 行（S11）。agoMs: 持ち主の口が最後に来てからの時間（サーバーのメモリの控え。このサーバーの起動の後に無ければ null）。
 * 本人の応答にだけ、サーバーが足す（World に入れない。観戦・ほかの参加者には出さない）
 */
export function ownerPresenceText(L: Locale, agoMs: number | null): string {
  const head = agoMs === null
    ? t(L, '持ち主は、まだ、支度の画面を開いていない（このサーバーが起動してから）', 'Your owner has not opened the preparations screen yet (since this server started)')
    : agoMs <= OWNER_PRESENCE_NOW_MS
      ? t(L, '持ち主は、今、支度の画面を開いている', 'Your owner has the preparations screen open right now')
      : agoMs < 3_600_000
        ? t(L, `持ち主が、最後に支度の画面を開いたのは、${Math.max(1, Math.floor(agoMs / 60_000))} 分前`, `Your owner last opened the preparations screen ${Math.max(1, Math.floor(agoMs / 60_000))} min ago`)
        : t(L, `持ち主が、最後に支度の画面を開いたのは、${Math.floor(agoMs / 3_600_000)} 時間前`, `Your owner last opened the preparations screen ${Math.floor(agoMs / 3_600_000)} h ago`);
  return t(L, `${head}。持ち主は人で、決めるのに数分かかることがある。wait_for_turn timeout_s=60 を、くり返してよい`,
    `${head}. Your owner is a person and may take a few minutes to decide. You may repeat wait_for_turn timeout_s=60`);
}

/**
 * 進め方（S14。SEASON.md §65.4 の 2）: 持ち主の希望。self 自分で考えて進む（既定）・pilot pilot で進めてほしい。
 * 握る項目ではない（伝言と同じ扱い）。プロフィールに覚える（World に入れない。決まりに効かない）。ゲームは、AI が pilot を使ったかを確かめない
 */
export type OwnerPace = 'self' | 'pilot';
export const OWNER_PACES: readonly OwnerPace[] = ['self', 'pilot'];

/** 進め方の希望が pilot のとき、本人の応答に足す 1 行（S14。キャンプの観測と、遠征を始めた直後の応答。self のときは何も出さない） */
export function ownerPaceText(L: Locale): string {
  return t(L, '持ち主の希望（進め方）: pilot で進めてほしい（pilot は、AI の側の道具。持っていなければ、自分で進めてよい。ゲームは、どちらも同じに扱う）',
    'Your owner\'s wish (how to play): please play with pilot (pilot is a tool on the AI\'s side; if you do not have it, play on your own. The game treats both the same)');
}

/**
 * 持ち主が、進め方の希望（pilot）を取り下げた後の、最初の本人の応答に 1 回だけ足す 1 行（S18。SEASON.md §73.2 の 5。
 * 希望が変わったのか、表示の仕様が変わったのかを、AI が見分けられるように）
 */
export function ownerPaceRevokedText(L: Locale): string {
  return t(L, '持ち主は、進め方の希望（pilot）を取り下げた。自分で進めてよい',
    'Your owner withdrew the wish on how to play (pilot). You may play on your own');
}

/** ownerPresenceText の文（日英。後ろの句点まで）に当たる正規表現（観戦に流す文から除く） */
const PRESENCE_RE = new RegExp([
  '(持ち主は、今、支度の画面を開いている|持ち主が、最後に支度の画面を開いたのは、[0-9]+ (分|時間)前|持ち主は、まだ、支度の画面を開いていない（このサーバーが起動してから）)。持ち主は人で、決めるのに数分かかることがある。wait_for_turn timeout_s=60 を、くり返してよい。?',
  '(Your owner has the preparations screen open right now|Your owner last opened the preparations screen [0-9]+ (min|h) ago|Your owner has not opened the preparations screen yet \\(since this server started\\))\\. Your owner is a person and may take a few minutes to decide\\. You may repeat wait_for_turn timeout_s=60\\.?',
].join('|'), 'g');

/**
 * 応答の文から、持ち主の様子（ownerPresenceText）を除く（S11）。本人にだけ出す文なので、観戦の「AI の呼び出しの記録」に流す文からは外す。
 * その文だけの行は、行ごと落とす
 */
export function withoutOwnerPresence(text: string): string {
  if (!text.includes('支度の画面') && !text.includes('preparations screen')) return text;
  const out: string[] = [];
  for (const l of text.split('\n')) {
    const r = l.replace(PRESENCE_RE, '').replace(/ +$/, '');
    if (r.length || !l.length) out.push(r);
  }
  return out.join('\n');
}

/** 希望を覚え直せる回数を使い切ったときの応答の文（S9c） */
export function wishLimitText(L: Locale, current: string | null): string {
  return t(L, `希望は、もう伝えてある（次のキャンプまで、これ以上は変えられない${current ? `。今の希望: ${current}` : ''}）。`, `Your wish has already been passed on (it cannot change again until the next camp${current ? `; current wish: ${current}` : ''}).`);
}

/**
 * 希望が、今も成り立つか（S9 §58.2: 成り立たない希望は、持ち主の画面に出さない）。目的: このキャンプの候補にある。装備: その品を持っていて、
 * 着ける希望なら身に着けていない・外す希望なら身に着けている。特技・加護: 今の候補にある
 */
export function wishValid(view: PlayerView, w: DirectiveWish): boolean {
  switch (w.item) {
    case 'objective':
      return view.status === 'at_camp' && !!view.camp && view.camp.nextNo === w.no && (w.offer === 'endless' || view.camp.offers.some((o) => o.index === w.offer));
    case 'loadout': {
      const it = view.inventory.find((i) => i.id === w.target);
      return !!it && (w.act === 'equip' ? !it.equipped : !!it.equipped);
    }
    case 'perk':
      return !!view.self.build.pending[0]?.options.includes(w.perk);
    case 'boon':
      return !!view.self.boonChoice?.options.includes(w.boon);
  }
}

/** 持ち主の画面に出す希望（握っている項目の、今も成り立つもの。項目の順） */
export function activeWishes(view: PlayerView): DirectiveWish[] {
  const hold = view.directive?.hold ?? [];
  const held = (w: DirectiveWish) => hold.includes(w.item === 'objective' ? 'objective' : w.item === 'loadout' ? 'loadout' : 'perks');
  return (view.directive?.wishes ?? []).filter((w) => held(w) && wishValid(view, w));
}

/** 「希望どおりにする」で持ち主の口から出す命令（S9 §58.2。目的は選ぶだけ: prepare { objective }）。成り立たなければ null */
export function wishCommand(view: PlayerView, w: DirectiveWish): Command | null {
  if (!wishValid(view, w)) return null;
  switch (w.item) {
    case 'objective': return { type: 'prepare', objective: w.offer };
    case 'loadout': {
      const it = view.inventory.find((i) => i.id === w.target);
      return it ? { type: w.act, slot: it.slot } : null;
    }
    case 'perk': return { type: 'choose_perk', option: w.perk };
    case 'boon': return { type: 'choose_boon', option: w.boon };
  }
}

/** 希望の品（装備の希望のとき、プレイヤーに見えている種類と外見。wishLabel に渡す） */
export function wishItemOf(view: PlayerView, w: DirectiveWish): { kind: string | null; appearanceId: string | null } | null {
  if (w.item !== 'loadout') return null;
  const it = view.inventory.find((i) => i.id === w.target);
  return it ? { kind: it.kind, appearanceId: it.appearanceId } : null;
}

/** 希望を、項目ごとに最新の 1 つにして並べる（特技と加護は別の項目） */
export function putWish(list: readonly DirectiveWish[] | undefined, w: DirectiveWish): DirectiveWish[] {
  const order: DirectiveWish['item'][] = ['objective', 'loadout', 'perk', 'boon'];
  return [...(list ?? []).filter((x) => x.item !== w.item), w].sort((a, b) => order.indexOf(a.item) - order.indexOf(b.item));
}

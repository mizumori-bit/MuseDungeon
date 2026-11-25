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

/** 2 つの希望が同じか（項目・中身・理由。同じ希望のくり返しは出来事を足さない） */
export function sameWish(a: DirectiveWish | undefined, b: DirectiveWish): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
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

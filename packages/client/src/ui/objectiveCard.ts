// 目的の札（S16c。SEASON.md §70.5）: 支度の画面（持ち主が AI のために選ぶ）と、自分で潜るときのキャンプ（自分で選ぶ）の、両方で使う札の中身。
// 画面から離した関数（テストする）。札に大きく出すもの（どこで・何を・基礎点・推奨のレベルと自分のレベル・危険の印）と、小さく出すもの・たたむものを分ける。
// 中身は、AI の候補の文（観測の camp.offers[].text = shared の offerText）と同じ数から作る（プレイヤーより多くを見せない・少なくも見せない）。
// 全文（AI に届くのと同じ文）は、札の「くわしく」の中にそのまま出す。
import type { CatalogRules, ExpeditionOffer, Objective, OfferSlot } from '@muse/shared';
import { guardianDisplayName, multText, nameOf, objectiveText, offerGap, offerText, offerWardenExtra, slotName } from '@muse/shared';
import { getLocale, tr } from '../util';

/** 危険の印の段: ok 推奨に届いている・warn 背伸び・high 危険 */
export type DangerTone = 'ok' | 'warn' | 'high';

/**
 * 危険の印（推奨レベルとの差と、条件の危険度の合計から。AI の候補の recommended_level・level_gap・trait_danger と同じ数）。
 * 差が 3 以上か、差と条件の合計が 4 以上なら「危険」、差か条件が正なら「背伸び」、それ以外は「届いている」。数が無ければ null
 */
export function dangerOf(gap: number | null, traitDanger: number): { tone: DangerTone; label: string } | null {
  if (gap === null && !traitDanger) return null;
  const g = gap ?? 0;
  const tone: DangerTone = g >= 3 || g + traitDanger >= 4 ? 'high' : g > 0 || traitDanger > 0 ? 'warn' : 'ok';
  const label = tone === 'high' ? tr('危険', 'Dangerous') : tone === 'warn' ? tr('背伸び', 'A stretch') : tr('届いている', 'Within reach');
  return { tone, label };
}

/** 危険の印に添える説明（指を置くと出る） */
export function dangerTitle(): string {
  return tr('推奨レベルとの差と、条件の危険度の合計から（札に出している数と同じ）。差が 3 以上か、合わせて 4 以上で「危険」',
    'From the gap to the recommended level and the traits\' danger (the numbers on the card). "Dangerous" at a gap of 3 or more, or 4 or more together');
}

/** 札の大きい字の「何を」（短く。どう達成するかの文は how に） */
export function objectiveShort(o: Pick<Objective, 'type'>, guarded = false): string {
  switch (o.type) {
    case 'reach_depth': return tr('踏破する', 'Cross the floor');
    case 'slay_guardian': return tr('守護者を倒す', 'Slay the guardian');
    case 'retrieve_relic': return guarded ? tr('遺物を持ち帰る（守護者付き）', 'Bring back the relic (guarded)') : tr('遺物を持ち帰る', 'Bring back the relic');
    case 'slay_warden': return tr('大守護者を倒す（節目）', 'Slay the warden (milestone)');
    case 'slay_bounty': return tr('賞金首を討つ', 'Hunt the bounty');
    case 'open_vault': return tr('宝物庫を開ける', 'Open the vault');
    default: return tr('目的なし。できるだけ深く潜る', 'No objective: descend as deep as you can');
  }
}

export interface ObjectiveCardModel {
  /** start_expedition の offer（1 始まり） */
  index: number;
  slot: OfferSlot | null;
  /** 枠の名前（堅実・標準・野心）。古いランは空 */
  slotLabel: string;
  /** 大きい字: 「地下4階」（深さの無い目的は null） */
  where: string | null;
  /** 大きい字: 「遺物を持ち帰る（守護者付き）」 */
  what: string;
  /** 小さい字: どう達成するか（shared の objectiveText のまま） */
  how: string;
  /** 大きい字: 基礎点 */
  points: number;
  /** 推奨のレベルと自分のレベルと差（正なら推奨より低い）。推奨が分からなければ rec と gap が null */
  level: { rec: number | null; you: number; gap: number | null };
  /** 条件の危険度の合計（AI の trait_danger） */
  traitDanger: number;
  danger: { tone: DangerTone; label: string } | null;
  /** 小さい字の並び（倍率・条件の名前・守護者の格・くり返し・再挑戦 など）。詳しい文は「くわしく」の中（full） */
  facts: string[];
  /** AI に届くのと同じ、候補の全文（観測の camp.offers[].text。無ければ offerText で作る） */
  full: string;
}

/**
 * 目的の札の中身。rules: カタログの公開ルール（古いサーバーで無ければ、推奨のレベルと条件の名前を出さない）。
 * fullText: 観測の camp.offers[].text（AI に届く文。サーバーの観測なら記録庫の行などが足されている）。省くと offerText
 */
export function objectiveCardModel(o: ExpeditionOffer, x: { level: number; rules?: CatalogRules; fullText?: string }): ObjectiveCardModel {
  const L = getLocale();
  const r = x.rules;
  const d = o.objective.targetDepth;
  const guarded = o.objective.type === 'retrieve_relic' && o.relicGuarded;
  const g = r ? offerGap(r, d, o.traits ?? [], x.level, offerWardenExtra(o)) : { recommendedLevel: null, levelGap: null, traitDanger: 0 };
  const facts: string[] = [tr(`倍率 ${multText(o.multiplierPct ?? 100)}`, `multiplier ${multText(o.multiplierPct ?? 100)}`)];
  for (const id of o.traits ?? []) facts.push(r?.traits[id] ? nameOf(r.traits[id].name, L, id) : id);
  if (o.warden) facts.push(tr(`大守護者「${guardianDisplayName(L, o.warden)}」（型 ${o.warden.types.length}）`, `warden "${guardianDisplayName(L, o.warden)}" (${o.warden.types.length} types)`));
  if (o.guardian) {
    const nm = o.guardian.name ? guardianDisplayName(L, { name: o.guardian.name, title: o.guardian.title }) : '';
    facts.push(nm ? tr(`守護者「${nm}」格 ${o.guardian.rank}`, `guardian "${nm}" rank ${o.guardian.rank}`) : tr(`守護者 格 ${o.guardian.rank}`, `guardian rank ${o.guardian.rank}`));
  }
  if (o.bounty) facts.push(tr(`賞金首「${nameOf(o.bounty.name, L, '?')}」`, `bounty "${nameOf(o.bounty.name, L, '?')}"`));
  if (o.objective.type === 'slay_guardian' && o.guardianBounty !== undefined) facts.push(tr(`守護者の賞金 +${o.guardianBounty}`, `guardian bounty +${o.guardianBounty}`));
  if ((o.repeatNo ?? 1) > 1) facts.push(tr(`この階は ${o.repeatNo} 回目${o.repeatPct !== undefined ? `（${o.repeatPct}%）` : ''}`, `attempt ${o.repeatNo} here${o.repeatPct !== undefined ? ` (${o.repeatPct}%)` : ''}`));
  if (o.rechallenge) facts.push(tr('再挑戦', 'rematch'));
  if (o.scar) facts.push(tr(`傷跡で体力 −${o.scar}`, `scars −${o.scar} HP`));
  if (o.vault) facts.push(tr('鍵を持つ敵が階にいる', 'a monster carries the key'));
  if (o.relic) facts.push(tr(`遺物「${nameOf(o.relic.name, L, o.relic.kind)}」`, `relic "${nameOf(o.relic.name, L, o.relic.kind)}"`));
  if (o.objective.type === 'retrieve_relic') facts.push(tr('拾うと、階の敵が起きる', 'picking it up wakes the floor'));
  if (o.passesWarden) facts.push(tr(`途中の地下${o.passesWarden.depth}階で大守護者を倒す`, `slay the warden on depth ${o.passesWarden.depth} on the way`));
  return {
    index: o.index,
    slot: o.slot ?? null,
    slotLabel: slotName(L, o.slot),
    where: d !== null ? tr(`地下${d}階`, `Depth ${d}`) : null,
    what: objectiveShort(o.objective, guarded),
    how: objectiveText(L, o.objective),
    points: o.points,
    level: { rec: g.recommendedLevel, you: x.level, gap: g.levelGap },
    traitDanger: g.traitDanger,
    danger: dangerOf(g.levelGap, g.traitDanger),
    facts,
    full: x.fullText ?? offerText(L, o, r ? { rules: r, level: x.level } : undefined),
  };
}

/** 「推奨 Lv6・あなた Lv4（差 +2）」（推奨が分からなければ「あなた Lv4」） */
export function levelText(l: ObjectiveCardModel['level']): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);
  if (l.rec === null) return tr(`あなた Lv${l.you}`, `you Lv${l.you}`);
  return tr(`推奨 Lv${l.rec}・あなた Lv${l.you}${l.gap !== null ? `（差 ${signed(l.gap)}）` : ''}`, `recommended Lv${l.rec}, you Lv${l.you}${l.gap !== null ? ` (gap ${signed(l.gap)})` : ''}`);
}

// ---- キャンプで出発するまで（自分で潜るとき） ----

/** 選んだ目的（キャンプの番号 nextNo ごとに覚える。キャンプが替わったら選び直す） */
export interface CampPick { no: number; pick: number | 'endless' }

/** 今のキャンプで選んでいる目的。キャンプが替わった・候補から消えたら null */
export function pickFor(p: CampPick | null, nextNo: number | null, offers: readonly { index: number }[]): number | 'endless' | null {
  if (!p || nextNo === null || p.no !== nextNo) return null;
  if (p.pick === 'endless') return 'endless';
  return offers.some((o) => o.index === p.pick) ? p.pick : null;
}

/** シーズンの写しから、新しい遠征を始められない理由（予算を使い切った・終わりの時刻を過ぎた。AI の valid_actions と同じ決まり） */
export function campClosedOf(season: { budgetLeft: number; ended?: boolean } | null | undefined): 'budget' | 'ended' | null {
  if (!season) return null;
  if (season.budgetLeft <= 0) return 'budget';
  return season.ended ? 'ended' : null;
}

export interface CampStartInput {
  /** 選んでいる目的 */
  selected: number | 'endless' | null;
  /** 候補が無い（仲間の遠征の終わりを待っている） */
  waiting?: boolean;
  closed?: 'budget' | 'ended' | null;
  /** 選んでいない特技の候補（観測の self.perk_choice） */
  perk?: { level: number; options: readonly unknown[]; more: number } | null;
  /** 選んでいない加護の候補 */
  boon?: { depth: number; options: readonly unknown[] } | null;
}

export interface CampStart {
  /** 主のボタンを押せる */
  canStart: boolean;
  /** 主のボタンの文 */
  label: string;
  /** ボタンの下の 1 行（押せない理由など）。無ければ null */
  hint: string | null;
  /** 押したときに確かめる、まだ決めていないもの（無ければ null。支度の「準備完了」の確かめと同じ窓） */
  confirm: string[] | null;
}

/**
 * キャンプの主のボタン（S16c）: 「この目的で、出発」。押せるか・文・下の 1 行・確かめ。
 * 確かめは、特技・加護の候補を選んでいないとき（自分で潜るときは、遠征の中でも p で選べる。窓でそう伝える）
 */
export function campStart(x: CampStartInput): CampStart {
  const label = x.selected === 'endless' ? tr('目的なしで、出発', 'Set out with no objective') : tr('この目的で、出発', 'Set out with this objective');
  if (x.waiting) return { canStart: false, label, hint: tr('仲間の遠征が終わるまで、次の遠征は選べない。', 'The next expedition can be chosen when your allies finish.'), confirm: null };
  if (x.closed === 'budget') return { canStart: false, label, hint: tr('このシーズンの手番を、使い切った。もう出発できない（ここで終えてよい）。', 'All of this season\'s turns are used. No more expeditions (you may stop here).'), confirm: null };
  if (x.closed === 'ended') return { canStart: false, label, hint: tr('シーズンの終わりの時刻を過ぎた。新しい遠征は始められない。', 'The season is past its end. No new expedition can start.'), confirm: null };
  if (x.selected === null) return { canStart: false, label, hint: tr('目的を 1 つ選ぶと、出発できる。', 'Choose an objective to set out.'), confirm: null };
  const confirm = [
    x.perk && x.perk.options.length ? tr(`特技（Lv${x.perk.level} の候補 ${x.perk.options.length} つ${x.perk.more ? `。ほかに ${x.perk.more} 回分` : ''}）`, `a perk (Lv${x.perk.level}, ${x.perk.options.length} options${x.perk.more ? `; ${x.perk.more} more after it` : ''})`) : '',
    x.boon && x.boon.options.length ? tr(`加護（地下${x.boon.depth}階の大守護者。候補 ${x.boon.options.length} つ）`, `a boon (warden of depth ${x.boon.depth}; ${x.boon.options.length} options)`) : '',
  ].filter(Boolean);
  return { canStart: true, label, hint: null, confirm: confirm.length ? confirm : null };
}

/** キャンプの見出しの 1 行（いちばん上の札の、目立つ字） */
export function campHeadline(x: { first: boolean; waiting: boolean; closed: 'budget' | 'ended' | null; pendingChoice: boolean }): string {
  if (x.closed) return tr('このシーズンは、もう出発できない', 'No more expeditions this season');
  if (x.waiting) return tr('仲間の遠征の終わりを待っている', 'Waiting for your allies to finish');
  if (x.pendingChoice) return tr('特技を選んで、次の目的を決める', 'Choose a perk, then the next objective');
  return x.first ? tr('最初の遠征の目的を決める', 'Choose your first objective') : tr('次の遠征の目的を決める', 'Choose the next objective');
}

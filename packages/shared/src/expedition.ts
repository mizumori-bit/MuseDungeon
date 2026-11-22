// 遠征の文章化（目的・達成条件・進捗・結果・候補）。入力は PlayerView 由来の事実だけ。
// 仕様: docs/IMPROVEMENTS_V2.md §2.6。「次に何をすべきか」の提案は書かない（事実とルールのみ）。
import type { CatalogRules } from './catalog';
import { nameOf, offerGap, offerWardenExtra } from './catalog';
import type { ExpeditionEndReason, ExpeditionOffer, Locale, Names, Objective, OfferSlot, RelicInfo } from './types';
import { ceilDiv, t } from './util';
import type { ExpeditionView, PlayerView } from './view';

export function objectiveText(L: Locale, o: Objective): string {
  const d = o.targetDepth;
  switch (o.type) {
    case 'reach_depth': return t(L, `地下${d}階を踏破し（その階の下り階段に着き）、階段から帰還する`, `Cross depth ${d} (reach its down stairs), then extract from any stairs`);
    case 'slay_guardian': return t(L, `地下${d}階の守護者を倒し、階段から帰還する`, `Slay the guardian on depth ${d}, then extract from any stairs`);
    case 'retrieve_relic': return t(L, `地下${d}階の遺物を見つけ、持ったまま階段から帰還する`, `Find the relic on depth ${d} and extract from any stairs while carrying it`);
    case 'slay_warden': return t(L, `節目に挑む: 地下${d}階の大守護者を倒し、階段から帰還する`, `Challenge the milestone: slay the warden on depth ${d}, then extract from any stairs`);
    case 'slay_bounty': return t(L, `賞金首を討つ: 地下${d}階の名前付きの強敵を倒し、階段から帰還する`, `Hunt the bounty: slay the named elite on depth ${d}, then extract from any stairs`);
    case 'open_vault': return t(L, `宝物庫を開ける: 地下${d}階の施錠された宝物庫の格子扉を開け、階段から帰還する`, `Open the vault: unlock the locked vault's grate on depth ${d}, then extract from any stairs`);
    default: return t(L, '目的なし。できるだけ深く潜る', 'No objective: descend as deep as you can');
  }
}

export function conditionText(L: Locale, o: Objective): string {
  switch (o.type) {
    case 'reach_depth': return t(L, `地下${o.targetDepth}階の下り階段に着く（着いただけでは達成しない）→ いずれかの階段の上で extract`, `Stand on the down stairs of depth ${o.targetDepth} (arriving is not enough) → extract while standing on any stairs`);
    case 'slay_guardian': return t(L, '守護者を倒す → いずれかの階段の上で extract', 'Slay the guardian → extract while standing on any stairs');
    case 'retrieve_relic': return t(L, '遺物を拾う → 持ったままいずれかの階段の上で extract。拾うと、その階の眠っている・気づいていない敵が目を覚まして遺物の場所へ向かい、その遠征の間は徘徊も増える（帰り道に備えてから拾う）', 'Pick up the relic → extract on any stairs while carrying it. Picking it up wakes every sleeping or unaware monster on the floor and sends them toward it, and wanderers come more often for the rest of the expedition (prepare the way back before you take it)');
    case 'slay_warden': return t(L, '大守護者を倒す → いずれかの階段の上で extract（広間の下り階段でも、前室の上り階段でもよい）', 'Slay the warden → extract while standing on any stairs (the hall\'s stairs down or the antechamber\'s stairs up)');
    case 'slay_bounty': return t(L, '名前付きの強敵（賞金首）を倒す → いずれかの階段の上で extract（賞金は別に入る）', 'Slay the named elite (the bounty) → extract while standing on any stairs (its bounty is paid separately)');
    case 'open_vault': return t(L, '宝物庫の鍵を手に入れ（鍵を持つ敵を倒すか、床で拾う）、鍵のかかった格子扉を隣で interact して開ける → いずれかの階段の上で extract（中身は別に入る）', 'Get the vault key (slay its carrier or pick it up), interact with the locked grate next to it → extract while standing on any stairs (the loot inside counts separately)');
    default: return t(L, '達成条件なし（階段の上で extract(confirm) すると撤退として終わる）', 'No completion condition (extract(confirm) on stairs ends it as a withdrawal)');
  }
}

export function endReasonText(L: Locale, r: ExpeditionEndReason | null): string {
  switch (r) {
    case 'completed': return t(L, '達成して帰還', 'completed and extracted');
    case 'withdrawn': return t(L, '撤退', 'withdrawn');
    case 'lifeline': return t(L, '帰還の綱で帰還', 'returned by lifeline');
    case 'died': return t(L, '死亡', 'died');
    case 'retired': return t(L, '引退', 'retired');
    case 'time_up': return t(L, '時間切れ（シーズンの予算が尽きた）', 'time up (season budget used up)');
    default: return t(L, '進行中', 'in progress');
  }
}

/** 開始時・再開時のブリーフィング（§2.6） */
export function briefingLines(L: Locale, x: ExpeditionView, rules?: Pick<CatalogRules, 'traits'> & Partial<Pick<CatalogRules, 'lifeline'>>): string[] {
  const lt = rules?.lifeline?.turns ?? 0;
  const lines = [
    t(L, `【遠征 ${x.no}】目的: ${objectiveText(L, x.objective)}`, `[Expedition ${x.no}] Objective: ${objectiveText(L, x.objective)}`),
    // 物語の 1 文（V3-3 §3.4）
    ...(x.story ? [nameOf(x.story, L, '')] : []),
    t(L, `達成条件: ${conditionText(L, x.objective)}`, `Completion: ${conditionText(L, x.objective)}`),
    t(L, '撤退: 階段の上で extract(confirm) すると、未達成のまま生還して遠征を終えられる（追跡中の敵が見えていてもよい）', 'Withdraw: extract(confirm) on stairs ends the expedition alive, without the reward (even with hunters in view)'),
    t(L, `帰還の綱: 階段から遠くても use_item で使えば${lt > 0 ? ` ${lt} 手番後に` : 'その場で'}キャンプへ戻る（命と、目的を除く戦利品の半分を持ち帰る。遺物は運べない。達成した遠征には数えない）`,
      `Lifeline: use_item it anywhere to return to camp${lt > 0 ? ` after ${lt} turns` : ' at once'} (you keep your life and half the haul without the objective; a relic cannot come along; not a completed expedition)`),
    t(L, '終了理由: 達成して帰還 / 帰還の綱で帰還 / 撤退 / 死亡 / 引退(retire)', 'It ends by: completion + extract / lifeline / withdrawal / death / retire'),
  ];
  // 守護者の名前と型（V3-3 §3.1）。型の振る舞いは look で読める。弱点は試して分かるまで出さない
  if (x.guardian) lines.push(t(L, `守護者: 「${guardianDisplayName(L, x.guardian)}」（格 ${x.guardian.rank}${x.guardian.types.length ? '。型は look で確かめられる' : '。型なし'}。弱点は試して確かめる）`, `Guardian: "${guardianDisplayName(L, x.guardian)}" (rank ${x.guardian.rank}${x.guardian.types.length ? '; look at it for its type' : '; no type'}; find its weakness by trying)`));
  if (x.objective.type !== 'endless') {
    lines.push(t(L,
      `報酬: 遠征中に積み上げた戦利品（目的 +${x.points}・深追い・宝・賞金・発見・撃破）が、帰還で ${multText(x.multiplierPct)} されて確定する。撤退は目的を除いた半分、死亡すると全て失う。キャンプで全回復し、次の遠征を選べる`,
      `Reward: the haul you build (objective +${x.points}, overreach, treasure, bounty, discovery, kills) is banked ${multText(x.multiplierPct)} when you extract. Withdrawal banks half without the objective; death loses it all. At camp you are healed and choose the next expedition`));
  }
  if (x.traits.length) lines.push(t(L, `条件: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`, `Traits: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`));
  if (x.objective.type === 'retrieve_relic') lines.push(x.relicGuarded ? t(L, '情報: 遺物は守護者が守っている', 'Note: the relic is guarded') : t(L, '情報: 遺物に守護者はいない', 'Note: the relic is unguarded'));
  // 遺物と加護（V3-3 §3.3）: 階段の上で持ち帰ると加護になる。綱では持ち帰れない。拾うと階が目覚める
  if (x.relic) lines.push(t(L, `${relicText(L, x.relic)}。階段の上で持ち帰ると加護になり、ランの終わりまで残る（綱では持ち帰れない）。拾うと階の眠っている敵がすべて起きる`,
    `${relicText(L, x.relic)}. Carried out on stairs it becomes a boon for the rest of the run (not by lifeline). Picking it up wakes every sleeping enemy on the floor`));
  return lines;
}

/** 2 回目以降の遠征の開始時の説明（1 行。V3-2R3 §20.6） */
export function briefingShort(L: Locale, x: ExpeditionView, rules?: Pick<CatalogRules, 'traits'>): string {
  const tr = x.traits.length ? t(L, `・条件: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`, `, traits: ${traitsText(L, rules, x.traits) || x.traits.join(', ')}`) : '';
  const guard = x.objective.type === 'retrieve_relic' ? (x.relicGuarded ? t(L, '（守護者付き）', ' (guarded)') : t(L, '（守護者なし）', ' (unguarded)')) : '';
  const story = x.story ? ` ${nameOf(x.story, L, '')}` : '';
  return t(L, `【遠征 ${x.no}】${objectiveText(L, x.objective)}${guard}・目的 +${x.points}・帰還で ${multText(x.multiplierPct)}${tr}。${story.trim()}`,
    `[Expedition ${x.no}] ${objectiveText(L, x.objective)}${guard}, objective +${x.points}, ${multText(x.multiplierPct)} on extract${tr}.${story}`);
}

export function progressText(L: Locale, x: ExpeditionView, depth: number | null): string {
  const o = x.objective;
  const parts: string[] = [];
  if (o.targetDepth !== null) parts.push(t(L, `地下${depth ?? '-'}/${o.targetDepth}階`, `depth ${depth ?? '-'}/${o.targetDepth}`));
  else if (depth !== null) parts.push(t(L, `地下${depth}階`, `depth ${depth}`));
  if (o.type === 'reach_depth') parts.push(x.progress.reached ? t(L, '目標階を踏破済み', 'target crossed') : t(L, '目標階の下り階段に未到達', 'target not crossed yet'));
  if (o.type === 'slay_guardian') parts.push(x.progress.guardianSlain ? t(L, '守護者: 討伐済み', 'guardian: slain') : t(L, '守護者: 未討伐', 'guardian: alive'));
  if (o.type === 'slay_warden') parts.push(x.progress.guardianSlain ? t(L, '大守護者: 討伐済み', 'warden: slain') : t(L, '大守護者: 未討伐', 'warden: alive'));
  if (o.type === 'slay_bounty') parts.push(x.progress.guardianSlain ? t(L, '賞金首: 討伐済み', 'bounty: slain') : t(L, '賞金首: 未討伐', 'bounty: alive'));
  if (o.type === 'open_vault') parts.push(x.progress.vaultOpened ? t(L, '宝物庫: 開けた', 'vault: opened') : t(L, '宝物庫: まだ開けていない', 'vault: still locked'));
  if (o.type === 'retrieve_relic') {
    parts.push(x.progress.relicHeldByYou ? t(L, '遺物: 所持', 'relic: carried') : x.progress.relicHeld ? t(L, '遺物: 仲間が所持', 'relic: carried by an ally') : t(L, '遺物: 未入手', 'relic: not held'));
  }
  return parts.join(' | ');
}

export function slotName(L: Locale, s: OfferSlot | null | undefined): string {
  if (!s) return '';
  const ja: Record<OfferSlot, string> = { safe: '堅実', standard: '標準', ambitious: '野心' };
  return L === 'en' ? s : ja[s];
}

/** 倍率（%）の表示: ×1.2 */
export function multText(pct: number): string {
  return `×${(pct / 100).toFixed(pct % 10 === 0 ? 1 : 2)}`;
}

/** 階の性質の文（V4-0e §8.1）: 「群れている（敵と宝が多い）・泉が無い」。detail: 括弧の中を付けるか */
export function floorTraitsText(L: Locale, rules: Pick<CatalogRules, 'traits'> | undefined, traits: readonly string[], detail = true): string {
  return traits.map((id) => {
    const f = rules?.traits[id]?.floor;
    if (!f) return id;
    const d = detail && f.detail ? t(L, `（${nameOf(f.detail, L, '')}）`, ` (${nameOf(f.detail, L, '')})`) : '';
    return nameOf(f.name, L, id) + d;
  }).join(t(L, '・', ', '));
}

/** 深さの並びを範囲で（14・15・16・18 → 「14〜16・18」） */
function depthRanges(L: Locale, depths: readonly number[]): string {
  const ds = [...new Set(depths)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < ds.length;) {
    let j = i;
    while (j + 1 < ds.length && ds[j + 1] === ds[j] + 1) j++;
    out.push(j > i ? `${ds[i]}${t(L, '〜', '-')}${ds[j]}` : `${ds[i]}`);
    i = j + 1;
  }
  return out.join(t(L, '・', ', '));
}

/**
 * 候補の目的の階と通り道の階の性質（V4-0e §8.1）: 「通り道の地下 14〜16 階は群れている」。作られている階だけ（まだ作られていない階については何も言わない）
 */
export function offerFloorTraitsText(L: Locale, rules: Pick<CatalogRules, 'traits'> | undefined, o: { objective: { targetDepth: number | null }; floorTraits?: readonly { trait: string; depths: readonly number[] }[] }): string {
  const td = o.objective.targetDepth;
  return (o.floorTraits ?? []).map((g) => {
    const name = floorTraitsText(L, rules, [g.trait], false);
    const hasTarget = td !== null && g.depths.includes(td);
    const way = g.depths.filter((d) => d !== td);
    const ds = depthRanges(L, g.depths);
    if (hasTarget && !way.length) return t(L, `目的の地下 ${ds} 階は${name}`, `the target depth ${ds} is ${name}`);
    if (hasTarget) return t(L, `目的と通り道の地下 ${ds} 階は${name}`, `depths ${ds} (the target and on the way) are ${name}`);
    return t(L, `通り道の地下 ${ds} 階は${name}`, `on the way, depth${way.length > 1 ? 's' : ''} ${ds} ${way.length > 1 ? 'are' : 'is'} ${name}`);
  }).join(' / ');
}

export function traitsText(L: Locale, rules: Pick<CatalogRules, 'traits'> | undefined, traits: readonly string[]): string {
  if (!traits.length || !rules) return '';
  return traits.map((id) => {
    const tr = rules.traits[id];
    return tr ? `${L === 'en' ? tr.name.en : tr.name.ja}: ${L === 'en' ? tr.desc.en : tr.desc.ja}` : id;
  }).join(' / ');
}

const GUARD_TRAIT_JA: Record<string, string> = { fast: '速い', slow: '遅い', ranged: '射撃する', large: '大柄', armored: '重装', rusting: '錆びさせる', pierce: '装甲を抜く', evasive: '回避が高い', poison: '毒', drain: '血を吸う', heavy_swing: '大振り', heavy_blow: '重い一撃（装甲で半分までしか減らない）' };

/** 守護者の見込みの文（「守護者: 格 2・射撃する・速い」。種族名は出さない。V3-2R3 §20.1） */
/** 守護者の呼び名（称号＋名前。V3-3）: 「呼び集める者ヴォルン」/ "Volun the Summoner" */
export function guardianDisplayName(L: Locale, g: { name: Names; title?: Names }): string {
  if (L === 'en') return g.title ? `${g.name.en} ${g.title.en}` : g.name.en;
  return `${g.title?.ja ?? ''}${g.name.ja}`;
}

export function guardianForecastText(L: Locale, g: { rank: number; traits: string[]; name?: Names; title?: Names; types?: string[]; maxHit?: number; hp?: number; hpRange?: { min: number; max: number }; armor?: number } | undefined): string {
  if (!g) return '';
  // 名前と称号（型）は公開。種族は会うまで出さない（V3-3）
  const who = g.name ? t(L, `「${guardianDisplayName(L, { name: g.name, title: g.title })}」`, ` "${guardianDisplayName(L, { name: g.name, title: g.title })}"`) : '';
  // 速さは必ず書く（速い・遅いが無ければ「普通の速さ」）
  const speed = g.traits.includes('fast') || g.traits.includes('slow') ? [] : [t(L, '普通の速さ', 'normal speed')];
  // 型の無い守護者（格 1）は「型なし」と書く（見落としと区別できるように）
  const noType = g.name && g.types && !g.types.length ? [t(L, '型なし', 'no type')] : [];
  const tr = [...noType, ...g.traits.map((x) => (L === 'en' ? x : GUARD_TRAIT_JA[x] ?? x)), ...speed];
  // 一撃の目安（V3-3b §40.6。装甲で減る前）
  // 重い一撃（V3-8 §53.1）: 装甲で減っても一撃の半分より下がらない
  const floorHit = g.traits.includes('heavy_blow') && g.maxHit ? ceilDiv(g.maxHit, 2) : null;
  const hit = g.maxHit ? [floorHit !== null
    ? t(L, `一撃は最大 ${g.maxHit} まで（装甲で減る前。装甲で減っても ${floorHit} より下がらない）`, `hits up to ${g.maxHit} (before armor; armor cannot bring it below ${floorHit})`)
    : t(L, `一撃は最大 ${g.maxHit} まで（装甲で減る前）`, `hits up to ${g.maxHit} (before armor)`)] : [];
  // 体力の目安（V3-3c §44.2）: 格 1〜3 はおよその値に幅を添える（V4-0d §6.1）、大守護者は式の幅
  if (g.hp) hit.unshift(hpAboutText(L, g.hp, g.hpRange));
  else if (g.hpRange) hit.unshift(t(L, `体力 ${g.hpRange.min}〜${g.hpRange.max}`, `HP ${g.hpRange.min}-${g.hpRange.max}`));
  // 装甲の目安（V3-8a §56.1。型の効果を除く）
  if (g.armor !== undefined) hit.push(t(L, `装甲はおよそ ${g.armor}`, `about ${g.armor} armor`));
  return t(L, `守護者${who}: 格 ${g.rank}・${[...tr, ...hit].join('・')}`, `guardian${who}: rank ${g.rank}, ${[...tr, ...hit].join(', ')}`);
}

/**
 * 賞金首の見込みの文（V3-8 §53.2。守護者の候補と同じ並び）: 種族・接辞・体力の目安・一撃の目安。
 * 名前付きの強敵は種族を隠さない（異変の賞金首と同じく、見れば分かる）。通る目安はキャンプの観測が添える
 */
/** 体力の目安と幅（V4-0d §6.1）: 「体力はおよそ 20（9〜32）」。幅が無い（古い候補）・幅が 1 点なら目安だけ */
export function hpAboutText(L: Locale, hp: number, range?: { min: number; max: number }): string {
  const r = range && range.min !== range.max ? t(L, `（${range.min}〜${range.max}）`, ` (${range.min}-${range.max})`) : '';
  return t(L, `体力はおよそ ${hp}${r}`, `about ${hp} HP${r}`);
}

export function bountyForecastText(L: Locale, b: { name: Names; kindName?: Names; affixNames?: Names[]; hp: number; hpRange?: { min: number; max: number }; maxHit: number }): string {
  const who = nameOf(b.name, L, '?');
  const kn = b.kindName ? nameOf(b.kindName, L, '') : '';
  const an = (b.affixNames ?? []).map((n) => nameOf(n, L, ''));
  const kind = kn ? t(L, `（${kn}${an.length ? `・${an.join('・')}` : ''}）`, ` (${kn}${an.length ? `, ${an.join(', ')}` : ''})`) : '';
  return t(L, `賞金首「${who}」${kind}: ${hpAboutText(L, b.hp, b.hpRange)}・一撃は最大 ${b.maxHit} まで（装甲で減る前）`, `bounty "${who}"${kind}: ${hpAboutText(L, b.hp, b.hpRange)}, hits up to ${b.maxHit} (before armor)`);
}

/** 遺物の文（「遺物「息吹の欠片」→ 加護「息吹」: 自然回復の間隔 −2」。V3-3 §3.3） */
export function relicText(L: Locale, r: RelicInfo): string {
  const nm = nameOf(r.name, L, r.kind);
  if (!r.boon || !r.boonName) return t(L, `遺物「${nm}」`, `relic "${nm}"`);
  const own = r.owned ? t(L, '（もう持っている加護。新しくは付かない）', ' (a boon you already have; no new boon)') : '';
  return t(L, `遺物「${nm}」→ 加護「${nameOf(r.boonName, L, '')}」: ${nameOf(r.boonDesc, L, '')}${own}`, `relic "${nm}" -> boon ${nameOf(r.boonName, L, '')}: ${nameOf(r.boonDesc, L, '')}${own}`);
}

/** 候補の文章。rules と level があれば推奨レベルとの差と条件の危険度も付ける（公開の表と式だけで計算） */
export function offerText(L: Locale, o: ExpeditionOffer, ctx?: { rules: Pick<CatalogRules, 'traits' | 'recommendedLevel'>; level: number }): string {
  const guard = o.objective.type === 'retrieve_relic' && o.relicGuarded ? t(L, '（守護者付き）', ' (guarded)') : '';
  const slot = o.slot ? `[${slotName(L, o.slot)}] ` : '';
  const head = `${o.index}) ${slot}${objectiveText(L, o.objective)}${guard}`;
  const mult = o.multiplierPct ?? 100;
  const traits = traitsText(L, ctx?.rules, o.traits ?? []);
  let danger = '';
  if (ctx && o.objective.targetDepth !== null) {
    const g = offerGap(ctx.rules, o.objective.targetDepth, o.traits ?? [], ctx.level, offerWardenExtra(o));
    const gap = g.levelGap! > 0 ? `+${g.levelGap}` : `${g.levelGap}`;
    const td = g.traitDanger ? t(L, `／条件 ${g.traitDanger > 0 ? '+' : ''}${g.traitDanger}`, ` / traits ${g.traitDanger > 0 ? '+' : ''}${g.traitDanger}`) : '';
    danger = t(L, ` / 推奨 Lv${g.recommendedLevel}・あなた Lv${ctx.level}（差 ${gap}）${td}`, ` / recommended Lv${g.recommendedLevel}, you Lv${ctx.level} (gap ${gap})${td}`);
  }
  // 節目に挑む: 大守護者の名前と型（V3-3a §35.2）。同じ階の繰り返しは基礎点が減る
  const wd = o.warden ? t(L, ` / 大守護者「${guardianDisplayName(L, o.warden)}」（型: ${o.warden.types.length}）`, ` / warden "${guardianDisplayName(L, o.warden)}" (${o.warden.types.length} types)`) : '';
  // くり返し（S3b §30.2）: 守護者を倒す遠征では、守護者の賞金も基礎点と同じ割合に減る
  const repPct = o.repeatPct !== undefined ? `${o.repeatPct}%` : '';
  const rep = (o.repeatNo ?? 1) <= 1 ? ''
    : o.objective.type === 'slay_guardian' ? t(L, ` / この階は ${o.repeatNo} 回目: 基礎点と守護者の賞金が減っている${repPct ? `（${repPct}）` : ''}`, ` / attempt ${o.repeatNo} at this depth: reduced base and guardian bounty${repPct ? ` (${repPct})` : ''}`)
      : t(L, ` / この階は ${o.repeatNo} 回目: 基礎点が減っている${repPct ? `（${repPct}）` : ''}`, ` / attempt ${o.repeatNo} at this depth: reduced base${repPct ? ` (${repPct})` : ''}`);
  // 守護者の賞金の額（S3b §30.2。守護者を倒す遠征。基礎点と別に、倒したときに戦利品に入る）
  const gb = o.objective.type === 'slay_guardian' && o.guardianBounty !== undefined ? t(L, ` / 守護者の賞金 +${o.guardianBounty}`, ` / guardian bounty +${o.guardianBounty}`) : '';
  // 再挑戦（V3-3c §44.1）: 階に残っている守護者をもう一度目的にする（同じ名前・型・弱点）。基礎点と賞金は、その相手を置いた遠征のまま（S3b §30.1）
  const rc = !o.rechallenge ? ''
    : o.rechallenge.bounty ? t(L, ` / 再挑戦: ${o.rechallenge.no ? `遠征 ${o.rechallenge.no} で倒せなかった` : '階に残っている'}賞金首（同じ名前・接辞${o.rechallenge.inherits ? '。基礎点は、その相手を目的にした最初の遠征のまま（条件と倍率も）' : ''}）`, ` / rematch: the bounty ${o.rechallenge.no ? `left standing in expedition ${o.rechallenge.no}` : 'still on that floor'} (same name and affixes${o.rechallenge.inherits ? '; the base stays as in the first expedition against it, conditions and multiplier too' : ''})`)
    : t(L, ` / 再挑戦: ${o.rechallenge.no ? `遠征 ${o.rechallenge.no} で倒せなかった` : '階に残っている'}守護者（同じ名前・型・弱点${o.rechallenge.inherits ? '。基礎点と賞金は、その守護者を置いた遠征のまま（条件と倍率も）' : ''}）`, ` / rematch: the guardian ${o.rechallenge.no ? `left standing in expedition ${o.rechallenge.no}` : 'still on that floor'} (same name, type and weakness${o.rechallenge.inherits ? '; base and bounty stay as in the expedition that placed it, conditions and multiplier too' : ''})`);
  // 賞金首と宝物庫（V3-8 §53.2）・傷跡（§53.3）
  const bt = o.bounty ? ` / ${bountyForecastText(L, o.bounty)}` : '';
  const vt = o.vault ? t(L, ' / 宝物庫: 鍵を持つ敵が階にいる', ' / vault: an enemy on the floor carries the key') : '';
  const sc = o.scar ? t(L, ` / 傷跡で体力 −${o.scar}`, ` / scars: −${o.scar} HP`) : '';
  // 目的の階と通り道の階のうち、作られていて性質のある階（V4-0e §8.1）
  const ft = offerFloorTraitsText(L, ctx?.rules, o);
  // 遺物（S3a §27.6 の 2）: 拾うと階じゅうの敵が起きることを、選ぶ前に
  const rw = o.objective.type === 'retrieve_relic' ? t(L, ' / 遺物を拾うと、その階の敵が目を覚まして集まり、徘徊も増える', ' / picking up the relic wakes the floor and draws more wanderers') : '';
  const gf = (ft ? ` / ${ft}` : '') + wd + rep + gb + rc + sc + bt + vt + (o.guardian ? ` / ${guardianForecastText(L, o.guardian)}` : '') + (o.relic ? ` / ${relicText(L, o.relic)}` : '') + rw
    + (o.passesWarden ? t(L, ` / 途中の地下${o.passesWarden.depth}階で大守護者「${guardianDisplayName(L, o.passesWarden)}」を倒す必要がある（倒すまで下り階段が封じられている）`, ` / you must slay the warden "${guardianDisplayName(L, o.passesWarden)}" on depth ${o.passesWarden.depth} on the way (its stairs down are sealed until then)`) : '');
  return t(L, `${head} — 基礎 +${o.points} / 倍率 ${multText(mult)}${traits ? `（${traits}）` : ''}${danger}${gf}`,
    `${head} — base +${o.points} / multiplier ${multText(mult)}${traits ? ` (${traits})` : ''}${danger}${gf}`);
}

export function campLines(L: Locale, view: PlayerView, rules?: Pick<CatalogRules, 'traits' | 'recommendedLevel'>): string[] {
  const camp = view.camp;
  if (!camp) return [];
  const lines = [
    t(L, `確定済み ${view.record.banked} 点・達成した遠征 ${view.record.expeditions}${view.record.lost ? `・失った戦利品 ${view.record.lost}` : ''}`,
      `Banked ${view.record.banked}, expeditions completed ${view.record.expeditions}${view.record.lost ? `, lost ${view.record.lost}` : ''}`),
    t(L, `次の遠征の候補（遠征 ${camp.nextNo}）。start_expedition { offer } で始める:`, `Offers for expedition ${camp.nextNo} (start with start_expedition { offer }):`),
  ];
  for (const o of camp.offers) lines.push('  ' + offerText(L, o, rules ? { rules, level: view.self.level } : undefined));
  lines.push('  ' + t(L, 'endless) 目的なしでひたすら潜る（offer: "endless"）', 'endless) no objective, just descend (offer: "endless")'));
  return lines;
}

export function partsText(L: Locale, p: { objective: number; overreach: number; treasure: number; bounty: number; discovery: number; kills: number }): string {
  const ja: [number, string][] = [[p.objective, '目的'], [p.overreach, '深追い'], [p.treasure, '宝'], [p.bounty, '賞金'], [p.discovery, '発見'], [p.kills, '撃破']];
  const en: [number, string][] = [[p.objective, 'objective'], [p.overreach, 'overreach'], [p.treasure, 'treasure'], [p.bounty, 'bounty'], [p.discovery, 'discovery'], [p.kills, 'kills']];
  return (L === 'en' ? en : ja).filter(([v]) => v > 0).map(([v, n]) => (L === 'en' ? `${n} ${v}` : `${n}${v}`)).join(L === 'en' ? ', ' : '・');
}

/**
 * 遠征の終わりの文。me: 読む人のプレイヤー ID と、参加者の名前（協力プレイで「確定 +合計（あなたの分 +N）」と、だれの分かを書く。V4-1g G4）
 */
export function resultText(L: Locale, x: ExpeditionView, rules?: Partial<Pick<CatalogRules, 'haul' | 'lifeline'>>, me?: { id: string; names: Readonly<Record<string, string>> }): string {
  const r = x.result;
  if (!r) return '';
  const pay = r.payout;
  if (pay && pay.players.length > 1) {
    // 協力プレイ: 全員の合計と、自分の分。だれの分かと帰り方
    const mine = me ? pay.players.find((p) => p.player === me.id) : undefined;
    const how = (pid: string, lost: number) => {
      if (lost > 0) return t(L, '失った', 'lost');
      const ret = x.returns?.find((q) => q.player === pid);
      return ret?.lifeline ? t(L, `綱 ${rules?.lifeline?.pct ?? 50}%`, `lifeline ${rules?.lifeline?.pct ?? 50}%`) : ret?.completed ? t(L, '帰還', 'returned') : t(L, `撤退 ${rules?.haul?.withdrawPct ?? 50}%`, `withdrew ${rules?.haul?.withdrawPct ?? 50}%`);
    };
    const shares = pay.players.map((p) => `${me?.names[p.player] ?? p.player} ${p.lost > 0 ? `-${p.lost}` : `+${p.banked}`}（${how(p.player, p.lost)}）`).join(t(L, '・', ', '));
    const mineText = mine ? t(L, `（あなたの分 +${mine.banked}${mine.lost ? `・失った ${mine.lost}` : ''}）`, ` (yours +${mine.banked}${mine.lost ? `, lost ${mine.lost}` : ''})`) : '';
    return t(L,
      `遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）。確定 +${pay.banked}${mineText}${pay.lost ? `（失った戦利品 ${pay.lost}）` : ''}。だれの分: ${shares}。内訳（共有の分は全員に同じ・宝は持ち帰った人の分）: ${partsText(L, pay.parts) || 'なし'}、倍率 ${multText(pay.multiplierPct)}（帰還のみ）。この遠征: 最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`,
      `Expedition ${x.no} ended (${endReasonText(L, r.reason)}). Banked +${pay.banked}${mineText}${pay.lost ? ` (lost ${pay.lost})` : ''}. Shares: ${shares}. Parts (shared parts are the same for everyone, treasure goes to who carried it): ${partsText(L, pay.parts) || 'none'}, multiplier ${multText(pay.multiplierPct)} (returns only). Deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`);
  }
  if (pay) {
    const mine = pay.players.length === 1 ? pay.players[0] : null;
    const banked = mine ? mine.banked : pay.banked;
    const lost = mine ? mine.lost : pay.lost;
    // 倍率が掛かるのは帰還（達成）だけ。撤退と綱はそれぞれの割合（倍率なし）
    const how = r.reason === 'completed' ? t(L, `倍率 ${multText(pay.multiplierPct)}`, `multiplier ${multText(pay.multiplierPct)}`)
      : r.reason === 'lifeline' ? t(L, `帰還の綱で ${rules?.lifeline?.pct ?? 50}%（倍率なし）`, `lifeline ${rules?.lifeline?.pct ?? 50}% (no multiplier)`)
        : r.reason === 'withdrawn' ? t(L, `撤退で目的を除いて ${rules?.haul?.withdrawPct ?? 50}%（倍率なし）`, `withdrawal ${rules?.haul?.withdrawPct ?? 50}% without the objective (no multiplier)`)
          : t(L, '確定なし', 'nothing banked');
    return t(L,
      `遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）。確定 +${banked}${lost ? `（失った戦利品 ${lost}）` : ''}。内訳: ${partsText(L, pay.parts) || 'なし'}、${how}。この遠征: 最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`,
      `Expedition ${x.no} ended (${endReasonText(L, r.reason)}). Banked +${banked}${lost ? ` (lost ${lost})` : ''}. Parts: ${partsText(L, pay.parts) || 'none'}, ${how}. Deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`);
  }
  return t(L,
    `遠征 ${x.no} は終了した（${endReasonText(L, r.reason)}）。獲得 +${r.points} 点。この遠征: 最深 地下${r.deepest}階、撃破 ${r.kills}、手番 ${r.turns}`,
    `Expedition ${x.no} ended (${endReasonText(L, r.reason)}). +${r.points} points. This expedition: deepest ${r.deepest}, kills ${r.kills}, turns ${r.turns}`);
}

// 表示用ラベル（UI 言語）。状態・遠征・extract の可否などの事実を短く言い換えるだけで、判定はしない。
import type { Dir, ExpeditionBrief, ExpeditionView, MonsterTrait, ObjectiveChoice, ObsExpedition, ObsMonster, Observation, PlayerState, ViewStatus } from '@muse/shared';
import { endReasonText } from '@muse/shared';
import { getLocale, tr } from '../util';

export function playerStateLabel(state: PlayerState): string {
  switch (state) {
    case 'alive': return tr('探索中', 'exploring');
    case 'at_camp': return tr('キャンプ', 'at camp');
    case 'dead': return tr('死亡', 'dead');
    default: return tr('離脱', 'left');
  }
}

export function viewStatusLabel(status: ViewStatus): string {
  switch (status) {
    case 'your_turn': return tr('あなたの番', 'your turn');
    case 'waiting_others': return tr('他プレイヤー待ち', 'waiting for others');
    case 'at_camp': return tr('キャンプ', 'at camp');
    case 'dead': return tr('死亡', 'dead');
    default: return tr('ラン終了', 'run ended');
  }
}

/** 遠征の状態（CSS クラス名と表示） */
export function expStatusLabel(x: Pick<ExpeditionView | ExpeditionBrief, 'status' | 'endReason'>): { key: string; text: string } {
  if (x.status === 'objective_complete') return { key: 'complete', text: tr('目的達成（帰還待ち）', 'objective complete') };
  if (x.status === 'ended') return { key: `ended ${x.endReason ?? ''}`, text: `${tr('終了', 'ended')}: ${endReasonText(getLocale(), x.endReason)}` };
  return { key: 'progress', text: tr('進行中', 'in progress') };
}

// 階段の上なら追跡中の敵が見えていても extract できる（V3-2R2 §18.1）ので、追跡中の敵は理由に無い
const EXTRACT_BLOCK: Record<NonNullable<ObsExpedition['extract_blocked_by']>, [string, string]> = {
  not_on_stairs: ['階段の上ではない', 'not on stairs'],
  not_your_turn: ['手番ではない', 'not your turn'],
  ended: ['遠征は終了済み', 'the expedition is over'],
};

export function extractBlockLabel(code: ObsExpedition['extract_blocked_by']): string {
  const v = code ? EXTRACT_BLOCK[code] : undefined;
  return v ? tr(v[0], v[1]) : (code ?? '');
}

/** 敵の速さ（自分の今の速さとの比較。見れば分かる。V3-2R2 §18.2）。普通は空 */
export function monsterSpeedLabel(speed: ObsMonster['speed']): string {
  if (speed === 'fast') return tr('あなたより速い', 'faster than you');
  if (speed === 'slow') return tr('あなたより遅い', 'slower than you');
  return '';
}

const TRAIT_LABEL: Record<MonsterTrait, [string, string]> = {
  pack: ['群れる', 'pack'], ranged: ['飛び道具', 'ranged'], stationary: ['動かない', 'stationary'], armored: ['重装', 'armored'],
  rusting: ['錆びさせる', 'rusts armor'], pierce: ['装甲を抜く', 'pierces armor'],
};

/** 見れば分かる特徴（群れる・飛び道具・動かない・重装） */
export function monsterTraitLabel(trait: MonsterTrait): string {
  const v = TRAIT_LABEL[trait];
  return v ? tr(v[0], v[1]) : trait;
}

/** 体格（小柄・大柄。並は空。見れば分かる。V3-2R3 §20.4） */
export function monsterSizeLabel(size: ObsMonster['size']): string {
  if (size === 'large') return tr('大柄', 'large');
  if (size === 'small') return tr('小柄', 'small');
  return '';
}

/** 見れば分かる性質を 1 つの並びに: 体格 → 特徴（群れる・飛び道具・動かない・重装） */
export function monsterLooksText(m: Pick<ObsMonster, 'size' | 'traits'>): string {
  return [monsterSizeLabel(m.size), ...m.traits.map(monsterTraitLabel)].filter(Boolean).join(tr('・', ', '));
}

/** 1 手番あたりの最悪の被害（worst_hit × 自分の 1 手番に相手が行動する回数）。最大の一撃と同じなら空 */
export function worstTurnText(m: Pick<ObsMonster, 'worst_hit' | 'worst_turn'>): string {
  if (m.worst_turn === null || m.worst_turn === m.worst_hit) return '';
  return tr(`1 手に最悪 ${m.worst_turn}`, `worst ${m.worst_turn}/turn`);
}

/**
 * 帰還の綱の効き方（公開ルールの lifeline.turns から。0 ならその場で戻る。V3-2R3 §20.3）。
 * 達成した遠征の数には入らない（確定は lifeline.pct %・倍率なし）
 */
export function lifelineEffectText(turns: number | undefined): string {
  const n = turns ?? 0;
  return n <= 0
    ? tr('その場でキャンプへ戻る・達成した遠征には数えない・次の遠征はこの遠征を始めた階段から', 'returns you to camp at once; not counted as a completed expedition; the next expedition starts where this one began')
    : tr(`${n} 手番動けず（その間も攻撃は受ける）、その後キャンプへ戻る・達成した遠征には数えない・次の遠征はこの遠征を始めた階段から`, `helpless for ${n} turns (still attacked), then back to camp; not counted as a completed expedition; the next expedition starts where this one began`);
}

/** 脅威の表示。記録が無い種族は、本当に初めて見たなら「不明（初見）」、そうでなければ「不明（被弾の記録なし）」（V3-2R2 §18.2） */
export function threatText(threat: ObsMonster['threat'], firstSeen?: boolean): string {
  if (threat !== null) return tr(`脅威 ${threat}/5`, `threat ${threat}/5`);
  return firstSeen ? tr('脅威: 不明（初見）', 'threat: unknown (first sighting)') : tr('脅威: 不明（被弾の記録なし）', 'threat: unknown (never hit by it)');
}

const EXPLORED_LABEL: Record<number, [string, string]> = { 1: ['約 1/4', 'about 1/4'], 2: ['約半分', 'about half'], 3: ['約 3/4', 'about 3/4'], 4: ['ほぼ全て', 'nearly all'] };

/** この階の探索の進み具合（4 段階。V3-2R2 §18.4） */
export function exploredLabel(band: 1 | 2 | 3 | 4): string {
  const v = EXPLORED_LABEL[band];
  return v ? tr(v[0], v[1]) : String(band);
}

/** 方角の矢印（気配・下への風） */
export const DIR_ARROW: Record<Dir, string> = { n: '↑', ne: '↗', e: '→', se: '↘', s: '↓', sw: '↙', w: '←', nw: '↖' };

export const OBJECTIVE_CHOICES: { id: ObjectiveChoice; ja: string; en: string }[] = [
  { id: 'auto', ja: 'おまかせ（最初の候補）', en: 'Auto (first offer)' },
  { id: 'reach_depth', ja: '目標の階を踏破して帰還（その階の下り階段に着く）', en: 'Cross the target depth (reach its down stairs)' },
  { id: 'slay_guardian', ja: '守護者を倒して帰還', en: 'Slay the guardian' },
  { id: 'slay_warden', ja: '節目に挑む（大守護者を倒して帰還）', en: 'Challenge the milestone (slay the warden)' },
  { id: 'retrieve_relic', ja: '遺物を持ち帰る', en: 'Retrieve the relic' },
  { id: 'endless', ja: '目的なし（endless: ひたすら潜る）', en: 'Endless (no objective)' },
];

/** 新しいランの最初の遠征: camp はキャンプから始めて 3 候補から選ぶ（objective を省く。V3-2R §14.4） */
export type FirstExpeditionChoice = 'camp' | ObjectiveChoice;

export const FIRST_EXPEDITION_CHOICES: { id: FirstExpeditionChoice; ja: string; en: string }[] = [
  { id: 'camp', ja: 'キャンプで選ぶ（3 候補から）', en: 'Choose at camp (from 3 offers)' },
  ...OBJECTIVE_CHOICES,
];

// ---- ビルド（V3-4）: 特技・能動技・長柄・呪い ----

export type ObsAbility = Observation['self']['abilities'][number];
export type AbilityTarget = ObsAbility['target'];

/** 能動技が今使えるか（残りの手番が 0 で、遠征ごとの回数が残っている） */
export function abilityReady(a: Pick<ObsAbility, 'cooldown_left' | 'uses_left'>): boolean {
  return a.uses_left !== 0 && a.cooldown_left <= 0;
}

/** 能動技の状態（使える・あと N 手番・この遠征では使い切った。遠征ごとの回数があれば残りも） */
export function abilityStateLabel(a: Pick<ObsAbility, 'cooldown_left' | 'uses_left'>): string {
  if (a.uses_left === 0) return tr('使い切った', 'used up');
  if (a.cooldown_left > 0) return tr(`あと ${a.cooldown_left} 手番`, `${a.cooldown_left} turns`);
  return a.uses_left !== undefined ? tr(`使える・残り ${a.uses_left} 回`, `ready, ${a.uses_left} left`) : tr('使える', 'ready');
}

/** 能動技の対象の取り方（ボタンの説明） */
export function abilityTargetLabel(target: AbilityTarget): string {
  switch (target) {
    case 'adjacent': return tr('対象: 隣の敵（1 体ならそのまま、複数なら選ぶ）', 'Target: an adjacent enemy (used at once if only one, otherwise pick)');
    case 'throw': return tr('対象: 投擲用の品で射線が通り射程内の敵（品を 1 つ投げる）', 'Target: an enemy in range with a clear line for a throwing item (throws one)');
    case 'dir': return tr('対象: 方向（方向キーか、出てくるボタンで選ぶ）', 'Target: a direction (pick with a direction key or the buttons)');
    default: return tr('対象なし（押すとすぐ使う）', 'No target (used at once)');
  }
}

/** 能動技の対象を選んでいる間の案内（地図の上） */
export function abilityPickHint(name: string, target: AbilityTarget): string {
  if (target === 'dir') return tr(`${name}: 方向キーで向きを選ぶ（ボタンでもよい。Esc 取消）`, `${name}: pick a direction with a direction key or a button (Esc cancels)`);
  if (target === 'adjacent') {
    return tr(`${name}: 隣の敵を選ぶ — 方向キーでその向きの敵、Tab で切り替え・Enter で決定、地図やボタンのクリックでもよい（Esc 取消）`,
      `${name}: pick an adjacent enemy — a direction key picks the one that way; Tab cycles, Enter confirms; or click it on the map or a button (Esc cancels)`);
  }
  return tr(`${name}: 狙う敵を選ぶ — Tab で切り替え・Enter で決定、地図やボタンのクリックでもよい（Esc 取消）`,
    `${name}: pick the enemy to throw at — Tab cycles, Enter confirms; or click it on the map or a button (Esc cancels)`);
}

/** 能動技の対象に選べる相手がいないとき */
export function abilityNoTargetText(name: string, target: AbilityTarget): string {
  if (target === 'throw') return tr(`${name}: 狙える敵がいない（投擲用の品で、射線が通り射程内の相手）。`, `${name}: no enemy to throw at (needs a throwing item with range and a clear line).`);
  return tr(`${name}: 隣に敵がいない。`, `${name}: no adjacent enemy.`);
}

/** 能動技を使えないときの理由 */
export function abilityNotReadyText(name: string, a: Pick<ObsAbility, 'cooldown_left' | 'uses_left'>): string {
  if (a.uses_left === 0) return tr(`${name}: この遠征では使い切った。`, `${name}: used up for this expedition.`);
  return tr(`${name}: あと ${a.cooldown_left} 手番で使える。`, `${name}: ready in ${a.cooldown_left} turns.`);
}

/** 特技の候補の見出し（後に控えている候補の数も） */
export function perkChoiceHead(level: number, more: number): string {
  return tr(`特技を選ぶ（Lv${level}）${more > 0 ? `・あと ${more} 件` : ''}`, `Choose a perk (Lv${level})${more > 0 ? ` — ${more} more after this` : ''}`);
}

/** 特技の候補の補足（手番を使わない・保留できる） */
export function perkChoiceNote(): string {
  return tr('手番を使わない。選ぶまで進行は止まらない（保留できる）。キーボード: p を押してから 1〜9', 'Takes no turn and nothing waits for it (you may hold it). Keyboard: press p, then 1-9');
}

/** 特技の候補・能動技の並びにキーボードを向けている間の案内（地図の上） */
export function perkModeHint(): string {
  return tr('特技: 番号キー（1〜9）で選ぶ。手番は使わない（p/Esc で戻る）', 'Perk: press 1-9 to choose; takes no turn (p/Esc to exit)');
}

export function abilityModeHint(): string {
  return tr('能動技: 番号キー（1〜9）で使う（a/Esc で戻る）', 'Abilities: press 1-9 to use one (a/Esc to exit)');
}

/** 長柄で 2 マス先の敵を突く */
export function reachAttackLabel(name: string): string {
  return tr(`突く: ${name}`, `Strike: ${name}`);
}

export function reachAttackTitle(): string {
  return tr('長柄の武器で、縦・横・斜めの直線で 2 マス先の敵を攻撃する（間のマスが空いているとき。A）', 'Attack an enemy 2 cells away in a straight line with your reach weapon (the cell between must be open; A)');
}

/**
 * 呪いの印（V3-4）。unknown: 呪いの有無をまだ確かめていない装備品（呪われていれば装備すると外せない）。
 * cursed: 呪われている（装備中なら外せない）
 */
export function curseLabel(curse: 'unknown' | 'cursed', equipped: boolean): { text: string; title: string } {
  if (curse === 'cursed') {
    return equipped
      ? { text: tr('呪い: 外せない', 'cursed'), title: tr('呪われている。装備中は外せない', 'Cursed: it cannot be removed while equipped') }
      : { text: tr('呪い', 'cursed'), title: tr('呪われている。装備すると外せない', 'Cursed: once equipped it cannot be removed') };
  }
  return { text: tr('呪い?', 'curse?'), title: tr('呪いの有無をまだ確かめていない（装備するか鑑定すると分かる）。呪われていれば、装備すると外せない', 'Not yet checked for a curse (equip or identify it to find out). If cursed, it cannot be removed once equipped') };
}

/** 呪われた装備を外そうとしたとき */
export function cursedRemoveText(): string {
  return tr('呪われていて外せない。', 'It is cursed and cannot be removed.');
}

/** 状態パネルの見出し・空の表示 */
export function buildRowLabels(): { perks: string; abilities: string; bonus: string; bonusTitle: string } {
  return {
    perks: tr('特技', 'Perks'),
    abilities: tr('能動技', 'Abilities'),
    bonus: tr('命中の修正', 'Acc bonus'),
    bonusTitle: tr('職業の習熟と装備による命中の修正（近接・投擲）', 'Accuracy bonus from class proficiency and equipment (melee, thrown)'),
  };
}

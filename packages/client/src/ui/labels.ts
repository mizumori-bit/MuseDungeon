// 表示用ラベル（UI 言語）。状態・遠征・extract の可否などの事実を短く言い換えるだけで、判定はしない。
import type { ExpeditionBrief, ExpeditionView, ObjectiveChoice, PlayerState, ViewStatus } from '@muse/shared';
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

const EXTRACT_BLOCK: Record<string, [string, string]> = {
  not_on_stairs: ['階段の上ではない', 'not on stairs'],
  hostile_hunting: ['追跡中の敵が見えている', 'a hunting enemy is in view'],
  not_your_turn: ['手番ではない', 'not your turn'],
  ended: ['遠征は終了済み', 'the expedition is over'],
};

export function extractBlockLabel(code: string | undefined): string {
  const v = code ? EXTRACT_BLOCK[code] : undefined;
  return v ? tr(v[0], v[1]) : (code ?? '');
}

export const OBJECTIVE_CHOICES: { id: ObjectiveChoice; ja: string; en: string }[] = [
  { id: 'auto', ja: 'おまかせ（最初の候補）', en: 'Auto (first offer)' },
  { id: 'reach_depth', ja: '目標の階に到達して帰還', en: 'Reach the target depth' },
  { id: 'slay_guardian', ja: '守護者を倒して帰還', en: 'Slay the guardian' },
  { id: 'retrieve_relic', ja: '遺物を持ち帰る', en: 'Retrieve the relic' },
  { id: 'endless', ja: '目的なし（endless: ひたすら潜る）', en: 'Endless (no objective)' },
];

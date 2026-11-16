// ターン契約（IMPROVEMENTS_V2 §1.2）: 全応答に付ける turn ブロックと、テキスト末尾の状態行。
// state / awaiting は事実の通知であり、行動の提案ではない。changes は PlayerView と観測だけから作る。
import type { Observation } from './observation';
import { endReasonText } from './expedition';
import type { Locale } from './types';
import { t } from './util';
import { dirLabel } from './observation';
import type { PlayerView } from './view';

export type TurnState = 'your_turn' | 'waiting_others' | 'at_camp' | 'expedition_ended' | 'run_ended';
export type TurnReason =
  | 'run_started' | 'resumed' | 'action_completed' | 'macro_interrupted' | 'action_rejected' | 'turn_arrived' | 'expedition_started'
  /** observe など手番を進めない照会 */
  | 'observed'
  /** wait_for_turn がタイムアウトした */
  | 'wait_timeout';
export type Awaiting = 'action' | 'camp_choice' | 'nothing';

export type ChangeCode =
  | 'new_hostile' | 'hostile_gone' | 'hp_dropped' | 'hp_low' | 'status_gained' | 'status_lost' | 'level_up'
  | 'item_found' | 'stairs_found' | 'floor_changed' | 'objective_progress' | 'objective_complete' | 'can_extract';

export interface Change { code: ChangeCode; text: string; entity?: string }

export interface TurnBlock {
  state: TurnState;
  /** 自分の手番の通番（行動した手番数） */
  turn_no: number;
  reason: TurnReason;
  interrupted_by?: string;
  awaiting: Awaiting;
  /** 前回の応答以降の重要な変化（事実のみ。最大 MAX_CHANGES 件） */
  changes: Change[];
}

export const MAX_CHANGES = 8;

/** 差分計算用の要約（前回の応答時点の観測） */
export interface TurnSnapshot {
  floorKey: string | null;
  depth: number | null;
  hp: number;
  maxHp: number;
  level: number;
  statuses: string[];
  hostiles: Record<string, string>;
  items: Record<string, string>;
  stairs: string[];
  expNo: number | null;
  expStatus: string | null;
  progress: string;
  relicHeld: boolean;
  reached: boolean;
  canExtract: boolean;
}

export function turnSnapshot(view: PlayerView, obs: Observation): TurnSnapshot {
  const x = view.expedition;
  return {
    floorKey: view.floor?.key ?? null,
    depth: view.floor?.depth ?? null,
    hp: view.self.stats.hp,
    maxHp: view.self.stats.maxHp,
    level: view.self.level,
    statuses: view.self.statuses.map((s) => s.id).sort(),
    hostiles: Object.fromEntries(obs.visible.monsters.map((m) => [m.id, m.name])),
    items: Object.fromEntries(obs.visible.items.map((i) => [i.id, i.name])),
    stairs: obs.navigation.known_stairs.map((s) => `${s.type}@${s.pos.x},${s.pos.y}`).sort(),
    expNo: x?.no ?? null,
    expStatus: x?.status ?? null,
    progress: x ? JSON.stringify(x.progress) : '',
    relicHeld: x?.progress.relicHeldByYou ?? false,
    reached: x?.progress.reached ?? false,
    canExtract: obs.expedition?.can_extract ?? false,
  };
}

const PRIORITY: ChangeCode[] = [
  'floor_changed', 'objective_complete', 'objective_progress', 'can_extract', 'hp_low', 'hp_dropped', 'new_hostile',
  'level_up', 'status_gained', 'status_lost', 'item_found', 'stairs_found', 'hostile_gone',
];

/** 前回の要約からの変化。prev が無ければ空 */
export function diffChanges(prev: TurnSnapshot | null, cur: TurnSnapshot, view: PlayerView, obs: Observation): Change[] {
  if (!prev) return [];
  const L = view.locale;
  const out: Change[] = [];
  const sameFloor = prev.floorKey === cur.floorKey;
  if (!sameFloor && cur.depth !== null) out.push({ code: 'floor_changed', text: t(L, `地下${cur.depth}階に移った`, `Now on depth ${cur.depth}`) });
  if (cur.expNo !== null && cur.expNo === prev.expNo) {
    if (cur.expStatus === 'objective_complete' && prev.expStatus !== 'objective_complete') {
      out.push({ code: 'objective_complete', text: t(L, '遠征の目的を達成した（いずれかの階段の上で extract すると帰還になる）', 'Objective complete (extract on any stairs to finish the expedition)') });
    }
    if (cur.reached && !prev.reached) out.push({ code: 'objective_progress', text: t(L, '目標の階に到達した', 'Reached the target depth') });
    if (cur.relicHeld && !prev.relicHeld) out.push({ code: 'objective_progress', text: t(L, '遺物を手に入れた', 'You now carry the relic') });
    if (!cur.relicHeld && prev.relicHeld) out.push({ code: 'objective_progress', text: t(L, '遺物を手放した', 'You no longer carry the relic') });
    if (cur.progress !== prev.progress && view.expedition?.progress.guardianSlain && !JSON.parse(prev.progress || '{}').guardianSlain) {
      out.push({ code: 'objective_progress', text: t(L, '守護者が倒れた', 'The guardian has fallen') });
    }
  }
  if (cur.canExtract && !prev.canExtract) out.push({ code: 'can_extract', text: t(L, 'この場で extract できる', 'You can extract here') });
  const pct = (hp: number, max: number) => (max > 0 ? Math.trunc((hp * 100) / max) : 0);
  if (cur.hp < prev.hp) {
    out.push({ code: 'hp_dropped', text: t(L, `HP ${prev.hp}→${cur.hp}（-${prev.hp - cur.hp}）`, `HP ${prev.hp}→${cur.hp} (-${prev.hp - cur.hp})`) });
    const a = pct(prev.hp, prev.maxHp), b = pct(cur.hp, cur.maxHp);
    if (a >= 25 && b < 25) out.push({ code: 'hp_low', text: t(L, 'HP が 25% を下回った', 'HP fell below 25%') });
    else if (a >= 50 && b < 50) out.push({ code: 'hp_low', text: t(L, 'HP が半分を下回った', 'HP fell below half') });
  }
  if (sameFloor) {
    for (const m of obs.visible.monsters) {
      if (m.id in prev.hostiles) continue;
      out.push({ code: 'new_hostile', text: t(L, `新たな敵: ${m.name}(${m.id}) ${dirLabel(L, m.dir)}${m.dist}マス`, `New hostile: ${m.name} (${m.id}) ${dirLabel(L, m.dir)} ${m.dist}`), entity: m.id });
    }
    for (const [id, name] of Object.entries(prev.hostiles)) {
      if (id in cur.hostiles) continue;
      out.push({ code: 'hostile_gone', text: t(L, `見えなくなった敵: ${name}`, `Out of sight: ${name}`) });
    }
    const newItems = Object.entries(cur.items).filter(([id]) => !(id in prev.items));
    if (newItems.length) out.push({ code: 'item_found', text: t(L, `アイテムを見つけた: ${newItems.map(([, n]) => n).join(', ')}`, `Found: ${newItems.map(([, n]) => n).join(', ')}`), entity: newItems[0][0] });
    if (cur.stairs.some((s) => !prev.stairs.includes(s))) out.push({ code: 'stairs_found', text: t(L, '階段を見つけた', 'Found stairs') });
  }
  if (cur.level > prev.level) out.push({ code: 'level_up', text: t(L, `レベル ${cur.level} になった`, `Reached level ${cur.level}`) });
  for (const s of cur.statuses) if (!prev.statuses.includes(s)) out.push({ code: 'status_gained', text: t(L, `状態異常: ${statusName(obs, s)}`, `Status: ${statusName(obs, s)}`) });
  for (const s of prev.statuses) if (!cur.statuses.includes(s)) out.push({ code: 'status_lost', text: t(L, `状態異常が解けた: ${s.split(':')[1] ?? s}`, `Status ended: ${s.split(':')[1] ?? s}`) });
  out.sort((a, b) => PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code));
  return out.slice(0, MAX_CHANGES);
}

function statusName(obs: Observation, id: string): string {
  return obs.self.statuses.find((s) => s.id === id)?.name ?? id;
}

/** 状態と、ゲームがあなたに何を待っているか */
export function turnStateOf(view: PlayerView, expeditionEndedNow: boolean): { state: TurnState; awaiting: Awaiting } {
  if (view.status === 'ended' || view.status === 'dead') return { state: 'run_ended', awaiting: 'nothing' };
  if (view.status === 'at_camp') {
    if (expeditionEndedNow) return { state: 'expedition_ended', awaiting: 'nothing' };
    return { state: 'at_camp', awaiting: view.camp ? 'camp_choice' : 'nothing' };
  }
  if (view.status === 'your_turn') return { state: 'your_turn', awaiting: 'action' };
  return { state: 'waiting_others', awaiting: 'nothing' };
}

export function buildTurnBlock(view: PlayerView, p: { reason: TurnReason; interruptedBy?: string; changes: Change[]; expeditionEndedNow?: boolean }): TurnBlock {
  const s = turnStateOf(view, p.expeditionEndedNow ?? false);
  const b: TurnBlock = { state: s.state, turn_no: view.self.turns, reason: p.reason, awaiting: s.awaiting, changes: p.changes };
  if (p.interruptedBy) b.interrupted_by = p.interruptedBy;
  return b;
}

/** テキスト応答の末尾に付ける 1 行 */
export function turnLine(view: PlayerView, b: TurnBlock): string {
  const L: Locale = view.locale;
  const x = view.expedition;
  const inExp = x && x.status !== 'ended';
  switch (b.state) {
    case 'your_turn': {
      const coop = view.runMode === 'coop';
      const exp = inExp ? t(L, '遠征は進行中で、', 'The expedition is in progress; ') : '';
      return coop
        ? t(L, `▶ あなたの番です（手番 ${b.turn_no}）。${exp}あなたが行動ツールを呼ぶまで待っています（COOP では一定時間で待機扱い）。`, `▶ Your turn (turn ${b.turn_no}). ${exp}The game waits for your action tool (in COOP it times out to a wait).`)
        : t(L, `▶ あなたの番です（手番 ${b.turn_no}）。${exp}あなたが行動ツールを呼ぶまで世界は止まっています。`, `▶ Your turn (turn ${b.turn_no}). ${exp}The world is paused until you call an action tool.`);
    }
    case 'waiting_others':
      return t(L, '▶ 他のプレイヤーの手番です。遠征は進行中です。wait_for_turn で自分の番を待てます。', '▶ Another player is acting. The expedition continues; wait_for_turn waits for your turn.');
    case 'expedition_ended':
      return t(L,
        `▶ 遠征は終了しました（${endReasonText(L, x?.endReason ?? null)}）。これ以上の行動は不要です。次の遠征は start_expedition で選べます。`,
        `▶ The expedition has ended (${endReasonText(L, x?.endReason ?? null)}). No further action is required. You can choose the next one with start_expedition.`);
    case 'at_camp':
      return view.camp
        ? t(L, '▶ キャンプにいます（遠征は終了済み）。ここで終えてもかまいません。続けるなら start_expedition で次の遠征を選びます。', '▶ You are at camp (the expedition is over). It is fine to stop here. To continue, choose the next expedition with start_expedition.')
        : t(L, '▶ キャンプにいます。仲間の遠征が終わるまで次の遠征は選べません。', '▶ You are at camp. The next expedition can be chosen when your allies finish.');
    default: {
      const why = view.status === 'dead' ? t(L, '死亡', 'died') : t(L, '終了', 'ended');
      return t(L, `▶ ランは終了しました（${why}）。これ以上の行動はできません。`, `▶ The run has ended (${why}). No further actions are possible.`);
    }
  }
}

export function changesLine(L: Locale, changes: Change[]): string {
  if (!changes.length) return '';
  return t(L, '変化: ', 'Changes: ') + changes.map((c) => c.text).join(' / ');
}

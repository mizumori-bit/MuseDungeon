// ターン契約（IMPROVEMENTS_V2 §1.2）: 全応答に付ける turn ブロックと、テキスト末尾の状態行。
// state / awaiting は事実の通知であり、行動の提案ではない。changes は PlayerView と観測だけから作る。
import type { Observation } from './observation';
import { endReasonText } from './expedition';
import type { PerceivedEvent } from './filter';
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
  | 'new_hostile' | 'reappeared' | 'hostile_gone' | 'killed' | 'died_seen' | 'hp_dropped' | 'hp_low' | 'status_gained' | 'status_lost' | 'level_up'
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
  /** この要約を作った時点の seq（以降に知覚した出来事が差分の対象） */
  seq: number;
  state: TurnState | null;
  /** 既知のセル数（地図の変化の判定用） */
  knownCells: number;
  /** 所持品の要約（所持品の行の変化の判定用） */
  inv: string;
  floorKey: string | null;
  depth: number | null;
  hp: number;
  maxHp: number;
  level: number;
  statuses: string[];
  /** 状態異常の表示名（解けた後の文章に使う） */
  statusNames?: Record<string, string>;
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

export function turnSnapshot(view: PlayerView, obs: Observation, state: TurnState | null = null): TurnSnapshot {
  const x = view.expedition;
  let known = 0;
  for (const c of view.memory.terrain) if (c) known++;
  return {
    seq: view.seq,
    state,
    knownCells: known,
    inv: view.inventory.map((i) => `${i.slot}:${i.kind ?? i.appearanceId}:${i.qty}:${i.equipped ?? ''}`).join(','),
    floorKey: view.floor?.key ?? null,
    depth: view.floor?.depth ?? null,
    hp: view.self.stats.hp,
    maxHp: view.self.stats.maxHp,
    level: view.self.level,
    statuses: view.self.statuses.map((s) => s.id).sort(),
    statusNames: Object.fromEntries(obs.self.statuses.map((s) => [s.id, s.name])),
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
  'floor_changed', 'objective_complete', 'objective_progress', 'can_extract', 'hp_low', 'killed', 'died_seen', 'hp_dropped', 'new_hostile',
  'level_up', 'status_gained', 'status_lost', 'item_found', 'stairs_found', 'reappeared', 'hostile_gone',
];

/**
 * 前回の要約からの変化。prev が無ければ空。
 * events: 前回の要約以降に知覚した出来事（撃破・死亡の区別に使う）
 */
export function diffChanges(prev: TurnSnapshot | null, cur: TurnSnapshot, view: PlayerView, obs: Observation, events: readonly PerceivedEvent[] = []): Change[] {
  if (!prev) return [];
  const L = view.locale;
  const out: Change[] = [];
  const sameFloor = prev.floorKey === cur.floorKey;
  if (!sameFloor && cur.depth !== null) out.push({ code: 'floor_changed', text: t(L, `地下${cur.depth}階に移った`, `Now on depth ${cur.depth}`) });
  if (cur.expNo !== null && cur.expNo === prev.expNo) {
    if (cur.expStatus === 'objective_complete' && prev.expStatus !== 'objective_complete') {
      const ot = view.expedition?.objective.type;
      const pressure = ot === 'slay_guardian' || ot === 'retrieve_relic';
      out.push({
        code: 'objective_complete',
        text: pressure
          ? t(L, '遠征の目的を達成した（いずれかの階段の上で extract すると帰還になる）。坑が騒がしくなった: この遠征の間、徘徊の湧き間隔が半分になる',
            'Objective complete (extract on any stairs to finish). The pit grows restless: wanderers spawn twice as often for the rest of this expedition')
          : t(L, '遠征の目的を達成した（いずれかの階段の上で extract すると帰還になる）', 'Objective complete (extract on any stairs to finish the expedition)'),
      });
    }
    if (cur.reached && !prev.reached) out.push({ code: 'objective_progress', text: t(L, '目標の階に到達した', 'Reached the target depth') });
    if (cur.relicHeld && !prev.relicHeld) out.push({ code: 'objective_progress', text: t(L, '遺物を手に入れた（この階の眠っていた敵が目を覚ました）', 'You now carry the relic (the sleepers on this floor have woken)') });
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
  // 目の前の死（撃破か、他の理由か）
  const dead = new Map<string, boolean>();
  for (const e of events) {
    if (e.seq <= prev.seq || e.type !== 'died') continue;
    const ev = e.event as Record<string, unknown>;
    if (typeof ev.id !== 'string' || ev.id === view.self.id) continue;
    dead.set(ev.id, ev.killer === view.self.id);
  }
  for (const [id, byYou] of dead) {
    const name = prev.hostiles[id] ?? cur.hostiles[id];
    if (!name) continue;
    out.push(byYou
      ? { code: 'killed', text: t(L, `倒した: ${name}`, `Killed: ${name}`), entity: id }
      : { code: 'died_seen', text: t(L, `目の前で倒れた: ${name}`, `Died in front of you: ${name}`), entity: id });
  }
  if (sameFloor) {
    for (const m of obs.visible.monsters) {
      if (m.id in prev.hostiles) continue;
      const first = view.entities.find((e) => e.id === m.id)?.firstSeenSeq;
      if (first !== undefined && first <= prev.seq) {
        out.push({ code: 'reappeared', text: t(L, `再び見えた: ${m.name}(${m.id}) ${dirLabel(L, m.dir)}${m.dist}マス`, `Back in sight: ${m.name} (${m.id}) ${dirLabel(L, m.dir)} ${m.dist}`), entity: m.id });
        continue;
      }
      out.push({ code: 'new_hostile', text: t(L, `新たな敵: ${m.name}(${m.id}) ${dirLabel(L, m.dir)}${m.dist}マス`, `New hostile: ${m.name} (${m.id}) ${dirLabel(L, m.dir)} ${m.dist}`), entity: m.id });
    }
    for (const [id, name] of Object.entries(prev.hostiles)) {
      if (id in cur.hostiles || dead.has(id)) continue;
      out.push({ code: 'hostile_gone', text: t(L, `見えなくなった敵: ${name}`, `Out of sight: ${name}`) });
    }
    const newItems = Object.entries(cur.items).filter(([id]) => !(id in prev.items));
    if (newItems.length) out.push({ code: 'item_found', text: t(L, `アイテムを見つけた: ${newItems.map(([, n]) => n).join(', ')}`, `Found: ${newItems.map(([, n]) => n).join(', ')}`), entity: newItems[0][0] });
    if (cur.stairs.some((s) => !prev.stairs.includes(s))) out.push({ code: 'stairs_found', text: t(L, '階段を見つけた', 'Found stairs') });
  }
  if (cur.level > prev.level) out.push({ code: 'level_up', text: t(L, `レベル ${cur.level} になった`, `Reached level ${cur.level}`) });
  for (const s of cur.statuses) if (!prev.statuses.includes(s)) out.push({ code: 'status_gained', text: t(L, `状態異常: ${statusName(obs, s)}`, `Status: ${statusName(obs, s)}`) });
  for (const s of prev.statuses) if (!cur.statuses.includes(s)) out.push({ code: 'status_lost', text: t(L, `状態異常が解けた: ${prev.statusNames?.[s] ?? s.split(':')[1] ?? s}`, `Status ended: ${prev.statusNames?.[s] ?? s.split(':')[1] ?? s}`) });
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

/** テキスト応答の末尾に付ける 1 行。short: 状態が変わらない間の短い形（set_options の status_line） */
export function turnLine(view: PlayerView, b: TurnBlock, short = false): string {
  const L: Locale = view.locale;
  const x = view.expedition;
  const inExp = x && x.status !== 'ended';
  if (short && b.state === 'your_turn') return t(L, `▶ あなたの番（手番 ${b.turn_no}）`, `▶ Your turn (turn ${b.turn_no})`);
  if (short && b.state === 'waiting_others') return t(L, '▶ 他のプレイヤーの手番（wait_for_turn で待てる）', '▶ Another player is acting (wait_for_turn)');
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

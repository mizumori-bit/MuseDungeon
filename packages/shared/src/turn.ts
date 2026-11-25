// ターン契約（IMPROVEMENTS_V2 §1.2）: 全応答に付ける turn ブロックと、テキスト末尾の状態行。
// state / awaiting は事実の通知であり、行動の提案ではない。changes は PlayerView と観測だけから作る。
import type { Observation } from './observation';
import { endReasonText, objectiveText } from './expedition';
import type { PerceivedEvent } from './filter';
import type { Dir, Locale, Names } from './types';
import type { Catalog } from './catalog';
import { nameOf, nextOverreach, overreachStepPoints } from './catalog';
import { t } from './util';
import { dirLabel, ownerWaitOpen, seasonClosedView, undecidedStartedTexts } from './observation';
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
  | 'item_found' | 'stairs_found' | 'floor_changed' | 'objective_progress' | 'objective_complete' | 'can_extract' | 'next_camp'
  /** 守護者が倒れた（ほかの変化と別の行で先頭に出す。V3-2R2 §18.6） */
  | 'guardian_slain'
  /** 条件付きの特技が効いた（V3-4b §28.6）・敵が目を覚ました理由（§28.8） */
  | 'perk' | 'woke'
  /** 守護者のしたこと・分かった弱点（V3-3） */
  | 'guardian' | 'intel'
  /** 得た加護・効いた加護（V3-3 §3.3）・物語の 1 文（§3.4） */
  | 'boon' | 'story'
  /** このランで初めて見た種族・地物・バイオームの描写（V3-5 §5.4） */
  | 'first_seen'
  /** 節目の階が作り直された（V4-0a §1.1。遠征の開始の応答） */
  | 'floor_reset'
  /** 遠征の途中の区切り（S7。SEASON.md §52.2 の 2）: 自分の手番で 100 手番ごとに、敵が見えていない手番に 1 回だけ */
  | 'checkpoint'
  /** 持ち主が決めた（S8。SEASON.md §54.4 の 4）・持ち主が始めた遠征の伝言（§54.4 の 3）。ほかの変化より先に出す */
  | 'owner';

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
  /**
   * 持ち主の決定を待っている（S8b。キャンプで目的を握られていて、次の遠征を始められるときだけ）。decided は常に false（決めたら、次の応答で迷宮の中に変わる）。
   * waited_s: この wait_for_turn で待った秒数（時間切れで返ったとき）。何回待ってもよく、手番は減らない
   */
  owner_wait?: { decided: false; waited_s?: number; may_wait_again: true; turns_spent: 0 };
}

export const MAX_CHANGES = 8;

/** 差分計算用の要約（前回の応答時点の観測） */
export interface TurnSnapshot {
  /** この要約を作った時点の seq（以降に知覚した出来事が差分の対象） */
  seq: number;
  /** 帰還の綱の長い説明を出した遠征の通番（V3-3a §35.8） */
  lifeNo?: number;
  /** 加護の説明を出した遠征（2 回目からは名前だけ。V3-3c §44.6） */
  /** 説明を出した加護の組（ID を並べたもの。V3-8a） */
  boonKey?: string;
  /** 古い版で始まったランの 1 行を出した（V4-0b §1.2。最初の 1 度だけ） */
  versionNoted?: boolean;
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
  /** これまでの応答で報告した敵（「再び見えた」の判定。diffChanges が引き継ぐ） */
  reported?: string[];
  /** 見えていた敵の位置（消えたときに「最後に見た位置」を添える） */
  hostilePos?: Record<string, { x: number; y: number }>;
  /** 【遠征】の見出し（前の応答と同じなら短くする。V3-4b §28.8） */
  expHead?: string;
  /** 見えていた敵のうち逃走中だったもの（fight の標的が見えなくなったとき「逃げた」と「物陰に入った」を分ける。V3-4b §28.4） */
  hostileFleeing?: string[];
  items: Record<string, string>;
  /** これまでの応答で報告したアイテム（同じ階。記憶の一覧に出入りしても「見つけた」を繰り返さない） */
  reportedItems?: string[];
  /** 描写を出した種族・地物・バイオーム（V3-5 §5.4。diffChanges が引き継ぐ） */
  seenKinds?: string[];
  stairs: string[];
  expNo: number | null;
  expStatus: string | null;
  progress: string;
  relicHeld: boolean;
  reached: boolean;
  canExtract: boolean;
  /** 今帰った場合の次の候補の下限（変わったら changes に出す） */
  nextCampMin?: number | null;
  /** 踏破した最も深い階 */
  crossed?: number;
  /** 持ち主の伝言（S8b。前の応答から変わったかの判定。無ければ空） */
  ownerMsg?: string;
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
    hostilePos: Object.fromEntries(obs.visible.monsters.map((m) => [m.id, { x: m.pos.x, y: m.pos.y }])),
    hostileFleeing: obs.visible.monsters.filter((m) => m.fleeing).map((m) => m.id),
    ...(obs.expedition ? { expHead: obs.expedition.text } : {}),
    items: Object.fromEntries(obs.visible.items.flatMap((i) => (i.ids ?? [i.id]).map((id) => [id, i.name]))),
    stairs: obs.navigation.known_stairs.map((s) => `${s.type}@${s.pos.x},${s.pos.y}`).sort(),
    expNo: x?.no ?? null,
    expStatus: x?.status ?? null,
    progress: x ? JSON.stringify(x.progress) : '',
    relicHeld: x?.progress.relicHeldByYou ?? false,
    reached: x?.progress.reached ?? false,
    canExtract: obs.expedition?.can_extract ?? false,
    nextCampMin: obs.expedition?.haul?.next_camp?.min_target_depth ?? null,
    crossed: x?.crossedDepth ?? 0,
    ownerMsg: view.directive?.message ?? '',
  };
}

/** 伝言が、前の応答の後に書かれた・書き換えられた（S8b）。前の応答が無ければ（つないだ最初・起動し直した後）、新しいとは言わない */
export function ownerMessageIsNew(prev: TurnSnapshot | null, view: PlayerView): boolean {
  const m = view.directive?.message ?? '';
  return !!prev && !!m && prev.ownerMsg !== undefined && prev.ownerMsg !== m;
}

const PRIORITY: ChangeCode[] = [
  'owner', 'floor_reset', 'guardian_slain', 'guardian', 'intel', 'boon', 'story', 'floor_changed', 'objective_complete', 'objective_progress', 'next_camp', 'can_extract', 'hp_low', 'killed', 'died_seen', 'hp_dropped', 'new_hostile',
  'level_up', 'status_gained', 'status_lost', 'woke', 'perk', 'item_found', 'stairs_found', 'reappeared', 'hostile_gone', 'first_seen',
];

/** 初めて見たものの描写（V3-5 §5.4）: このランで初めて見た種族・地物・バイオーム・鑑定済みのアイテムの種類に 1 回だけ（1 回の応答で 3 件まで） */
function firstSeen(prev: TurnSnapshot, cur: TurnSnapshot, view: PlayerView, catalog: Catalog): Change[] {
  const L = view.locale;
  const seen = new Set(prev.seenKinds ?? []);
  const out: Change[] = [];
  const note = (key: string, name: string, desc: Names | undefined) => {
    // 3 件を超えた分は覚えず、次の応答に回す
    if (seen.has(key) || (desc && out.length >= 3)) return;
    seen.add(key);
    if (desc) out.push({ code: 'first_seen', text: t(L, `初めて見る: ${name} — ${nameOf(desc, L, '')}`, `First sight: ${name} — ${nameOf(desc, L, '')}`) });
  };
  if (view.floor) note(`biome:${view.floor.biome}`, nameOf(catalog.biomes[view.floor.biome]?.name, L, view.floor.biome), catalog.biomes[view.floor.biome]?.desc);
  for (const e of view.entities) {
    if (!e.kind) continue;
    if (e.cat === 'monster') note(e.kind, nameOf(catalog.monsters[e.kind]?.name, L, e.kind), catalog.monsters[e.kind]?.desc);
    else if (e.cat === 'feature') note(e.kind, nameOf(catalog.features[e.kind]?.name, L, e.kind), catalog.features[e.kind]?.desc);
    else if (e.cat === 'item' && catalog.items[e.kind]?.note) note(e.kind, nameOf(catalog.items[e.kind]?.name, L, e.kind), catalog.items[e.kind]?.note);
  }
  cur.seenKinds = [...seen];
  return out;
}

/**
 * 前回の要約からの変化。prev が無ければ空。
 * events: 前回の要約以降に知覚した出来事（撃破・死亡の区別に使う）
 */
export function diffChanges(prev: TurnSnapshot | null, cur: TurnSnapshot, view: PlayerView, obs: Observation, events: readonly PerceivedEvent[] = [], catalog?: Catalog): Change[] {
  const L = view.locale;
  // 公開された下り階段（シーズン。S2a §20.6 の 1）: 着いたとき・遠征を始めたときに、道しるべが地図にあることを 1 回言う（自分の目で見る前だけ）
  const ks = cur.depth !== null ? obs.navigation.known_stairs.find((s) => s.type === 'down' && s.public_by) : undefined;
  const pub = !ks ? ''
    : ks.path_len !== null
      ? t(L, `この階の下り階段は公開されている（${ks.public_by} が報告）。入口からの道しるべが地図にある（travel_to stairs_down で向かえる。経路 ${ks.path_len}）`, `This floor's down stairs are published (reported by ${ks.public_by}); a trail from the entrance is on your map (travel_to stairs_down goes there; path ${ks.path_len})`)
      : t(L, `この階の下り階段は公開されている（${ks.public_by} が報告）。地図に載っているが、途中の道はまだ分からない（explore { toward: 'draft' }）`, `This floor's down stairs are published (reported by ${ks.public_by}); they are on your map, but the way there is unknown (explore { toward: 'draft' })`);
  // 前の要約が無い（キャンプで観測を見ずに遠征を始めた・つなぎ直した）: 公開の知らせだけ（S2b）
  if (!prev) return pub ? [{ code: 'floor_changed', text: pub }] : [];
  const firsts = catalog ? firstSeen(prev, cur, view, catalog) : [];
  const out: Change[] = [];
  // 持ち主が決めた（S8 §54.4 の 4）: 遠征を始めた・装備を変えた・特技を選んだ。持ち主が始めた遠征には、伝言をもう 1 回（§54.4 の 3）。
  // 伝言を書いた・書き換えた（S8b）: 前の応答の基準と比べる（World と基準だけで決まる）。全文を 1 回。遠征の開始の「持ち主から」と重ねない
  const msgNew = ownerMessageIsNew(prev, view);
  const msg = view.directive?.message ?? '';
  // 並び: 特技と加護 → 装備の経過とまとめ → 遠征の開始 → 伝言（どれも code owner。ほかの変化より先）
  const gear: Change[] = [];
  const started: Change[] = [];
  for (const e of events) {
    if (e.seq <= prev.seq || e.type !== 'owner_decided' || !e.text) continue;
    const ev = e.event as { act?: string; no?: number };
    if (ev.act === 'start_expedition') {
      const xo = view.expedition && view.expedition.no === ev.no ? objectiveText(L, view.expedition.objective) : '';
      started.push({ code: 'owner', text: t(L, `持ち主が、遠征 ${ev.no ?? '?'} を始めた${xo ? `: ${xo}` : ''}`, `Your owner started expedition ${ev.no ?? '?'}${xo ? `: ${xo}` : ''}`) });
    } else if (ev.act === 'equip' || ev.act === 'unequip') gear.push({ code: 'owner', text: e.text.replace(/[。.]$/, '') });
    else out.push({ code: 'owner', text: e.text.replace(/[。.]$/, '') });
  }
  // 装備のまとめ（S8b）: 途中の経過（3 行まで。多ければまとめだけ）の後に、今の装備を 1 行
  if (gear.length) {
    if (gear.length <= 3) out.push(...gear);
    const eq = obs.self.equipment;
    const none = t(L, 'なし', 'none');
    out.push({ code: 'owner', text: t(L, `持ち主が、装備を決めた。今の装備: 武器 ${eq.weapon ?? none}・防具 ${eq.armor ?? none}・装飾 ${eq.accessory ?? none}`,
      `Your owner settled your gear. Now wearing: weapon ${eq.weapon ?? none}, armor ${eq.armor ?? none}, accessory ${eq.accessory ?? none}`) });
  }
  out.push(...started);
  // 決めていないものを残して遠征を始めた（S9a §57.3 の 1）: 始めた直後の応答に 1 回（だれが始めても）
  if (cur.expNo !== null && cur.expNo !== prev.expNo && view.status !== 'at_camp' && view.expedition?.status !== 'ended') {
    for (const text of undecidedStartedTexts(view, catalog)) out.push({ code: 'owner', text });
  }
  if (msgNew) out.push({ code: 'owner', text: t(L, `持ち主が、伝言を書いた: ${msg}`, `Your owner wrote a message: ${msg}`) });
  else if (started.length && msg) out.push({ code: 'owner', text: t(L, `持ち主から: ${msg}`, `From your owner: ${msg}`) });
  const sameFloor = prev.floorKey === cur.floorKey;
  if (!sameFloor && cur.depth !== null) {
    // この階を作ったときに効いた条件（V4-0e §8.1）: 着いたときに 1 回
    const tt = obs.self.floor?.trait_text;
    out.push({ code: 'floor_changed', text: t(L, `地下${cur.depth}階に移った${tt ? `。この階は${tt}` : ''}${pub ? `。${pub}` : ''}`, `Now on depth ${cur.depth}${tt ? `. This floor: ${tt}` : ''}${pub ? `. ${pub}` : ''}`) });
  } else if (pub && cur.expNo !== null && cur.expNo !== prev.expNo) {
    // 遠征を始めた階が、キャンプの前と同じ階（階が変わらない）: 公開の知らせだけ（S2b）
    out.push({ code: 'floor_changed', text: pub });
  }
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
    if (cur.reached && !prev.reached && view.expedition?.objective.type === 'reach_depth') out.push({ code: 'objective_progress', text: t(L, '目標の階を踏破した（下り階段に着いた）', 'Crossed the target depth (reached its down stairs)') });
    if ((cur.crossed ?? 0) > (prev.crossed ?? 0)) {
      // 深追い（目標より深い階の下り階段に立った）。目的の達成とは別で、次の点は次の階の下り階段で入る（V4-0b §1.5: 遺物の遠征で「目標の階を踏破」と読めた）
      const xv = view.expedition;
      const td = xv?.objective.targetDepth ?? null;
      const got = xv && td !== null && catalog ? overreachStepPoints(catalog.rules, xv.points, (cur.crossed ?? 0) - td) : null;
      const nx = xv && td !== null && catalog ? nextOverreach(catalog.rules, td, cur.crossed ?? 0, xv.points) : null;
      out.push({ code: 'objective_progress', text: t(L,
        `深追い: 地下${cur.crossed}階の下り階段に着いた（目標の地下${td ?? '?'}階より深い）。戦利品に深追いの点${got !== null ? ` +${got}` : ''}${nx ? `。次は地下${nx.depth}階の下り階段で +${nx.points}` : ''}`,
        `Overreach: reached the down stairs of depth ${cur.crossed} (deeper than the target depth ${td ?? '?'}); overreach points${got !== null ? ` +${got}` : ''} added to the haul${nx ? `. Next: +${nx.points} on the down stairs of depth ${nx.depth}` : ''}`) });
    }
    const nc = obs.expedition?.haul?.next_camp;
    if (nc && prev.nextCampMin != null && cur.nextCampMin != null && cur.nextCampMin !== prev.nextCampMin) {
      out.push({ code: 'next_camp', text: t(L, `今帰ると、次の候補は地下${nc.min_target_depth}階以上・推奨 Lv${nc.recommended_level} になった`, `If you extract now, next offers start at depth ${nc.min_target_depth} (recommended Lv${nc.recommended_level})`) });
    }
    if (cur.relicHeld && !prev.relicHeld) out.push({ code: 'objective_progress', text: t(L, '遺物を手に入れた（この階の眠っていた敵が目を覚ました）', 'You now carry the relic (the sleepers on this floor have woken)') });
    if (!cur.relicHeld && prev.relicHeld) out.push({ code: 'objective_progress', text: t(L, '遺物を手放した', 'You no longer carry the relic') });
    if (cur.progress !== prev.progress && view.expedition?.progress.guardianSlain && !JSON.parse(prev.progress || '{}').guardianSlain) {
      out.push({ code: 'guardian_slain', text: t(L, '★ 守護者が倒れた', '★ The guardian has fallen') });
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
    // 会心のとどめは、出た目のダメージと残りを添える（V4-0b §1.5: とどめでは残りの HP しか見えず、会心が効いたか確かめられなかった）
    let finish = '';
    if (byYou) {
      const dmg = [...events].reverse().find((e) => e.type === 'damaged' && (e.event as { target?: string }).target === id && (e.event as { source?: string }).source === view.self.id);
      const dv = dmg?.event as { amount?: number; dealt?: number } | undefined;
      const crit = !!dmg && events.some((e) => e.type === 'attack' && e.seq < dmg.seq && dmg.seq - e.seq <= 3 && (e.event as { target?: string }).target === id
        && (e.event as { attacker?: string }).attacker === view.self.id && !!(e.event as { crit?: boolean }).crit);
      if (crit && dv?.amount !== undefined) finish = dv.dealt !== undefined && dv.dealt < dv.amount
        ? t(L, `（会心 ${dv.amount}。残り ${dv.dealt} を倒した）`, ` (critical ${dv.amount}; it had ${dv.dealt} left)`)
        : t(L, `（会心 ${dv.amount}）`, ` (critical ${dv.amount})`);
    }
    out.push(byYou
      ? { code: 'killed', text: t(L, `倒した: ${name}${finish}`, `Killed: ${name}${finish}`), entity: id }
      : { code: 'died_seen', text: t(L, `目の前で倒れた: ${name}`, `Died in front of you: ${name}`), entity: id });
  }
  // 報告済みの個体は階・遠征をまたいで引き継ぐ（一度見た個体が後の遠征で「新たな敵」にならない）
  const reported = new Set([...(prev.reported ?? []), ...Object.keys(prev.hostiles)]);
  cur.reported = [...new Set([...reported, ...Object.keys(cur.hostiles)])];
  const seenItems = new Set([...(prev.reportedItems ?? []), ...Object.keys(prev.items)]);
  cur.reportedItems = [...new Set([...seenItems, ...Object.keys(cur.items)])];
  if (sameFloor) {
    for (const m of obs.visible.monsters) {
      if (m.id in prev.hostiles) continue;
      // 前の応答で一度でも報告した個体だけを「再び見えた」にする（マクロの途中で一瞬見えただけの個体は「新たな敵」）
      if (reported.has(m.id)) {
        out.push({ code: 'reappeared', text: t(L, `再び見えた: ${m.name}(${m.id}) ${dirLabel(L, m.dir)}${m.dist}マス`, `Back in sight: ${m.name} (${m.id}) ${dirLabel(L, m.dir)} ${m.dist}`), entity: m.id });
        continue;
      }
      out.push({ code: 'new_hostile', text: t(L, `新たな敵: ${m.name}(${m.id}) ${dirLabel(L, m.dir)}${m.dist}マス`, `New hostile: ${m.name} (${m.id}) ${dirLabel(L, m.dir)} ${m.dist}`), entity: m.id });
    }
    for (const [id, name] of Object.entries(prev.hostiles)) {
      if (id in cur.hostiles || dead.has(id)) continue;
      // 最後に見た位置と、視界の外へ出た一歩の向き（知覚した移動の向きだけ。行き先は分からない）。
      // 見えなくなる一歩の行き先が分かっているとき（草へ入るのを見ていた。V4-0c §4.2）は、そこが最後に見た位置
      let lp: { x: number; y: number } | undefined = prev.hostilePos?.[id];
      let out1: string | null = null;
      for (const e of events) {
        const ev = e.event as Record<string, unknown>;
        if (e.type !== 'entity_moved' || ev.id !== id) continue;
        const to = ev.to as { x: number; y: number } | null | undefined;
        const from = ev.from as { x: number; y: number } | null | undefined;
        if (to) { lp = { x: to.x, y: to.y }; out1 = null; } else if (from) lp = { x: from.x, y: from.y };
        if (typeof ev.dirOut === 'string') out1 = ev.dirOut;
      }
      // 最後に見た位置が背の高い草なら、そう書く（草に入って見えなくなった）
      const w = view.floor?.width;
      const lt = lp && w && catalog ? catalog.terrain[view.terrainTable[view.memory.terrain[lp.y * w + lp.x] ?? 0]] : undefined;
      const inGrass = !out1 && !!lt?.tags.includes('conceal');
      const where = [lp ? t(L, `最後に見た位置 (${lp.x},${lp.y})`, `last seen (${lp.x},${lp.y})`) : '', inGrass ? t(L, '背の高い草の中', 'in the tall grass') : '', out1 ? t(L, `${dirLabel(L, out1 as Dir)}へ`, `heading ${out1}`) : ''].filter(Boolean).join(L === 'en' ? ', ' : '・');
      out.push({ code: 'hostile_gone', text: t(L, `見えなくなった敵: ${name}${where ? `（${where}）` : ''}`, `Out of sight: ${name}${where ? ` (${where})` : ''}`), entity: id });
    }
    const newItems = Object.entries(cur.items).filter(([id]) => !seenItems.has(id));
    if (newItems.length) out.push({ code: 'item_found', text: t(L, `アイテムを見つけた: ${newItems.map(([, n]) => n).join(', ')}`, `Found: ${newItems.map(([, n]) => n).join(', ')}`), entity: newItems[0][0] });
    if (cur.stairs.some((s) => !prev.stairs.includes(s))) out.push({ code: 'stairs_found', text: t(L, '階段を見つけた', 'Found stairs') });
  }
  if (cur.level > prev.level) out.push({ code: 'level_up', text: t(L, `レベル ${cur.level} になった`, `Reached level ${cur.level}`) });
  // 物語の 1 文（V3-3 §3.4）
  for (const e of events) if (e.seq > prev.seq && e.type === 'story' && e.text) out.push({ code: 'story', text: e.text.replace(/。$/, '') });
  // 得た加護・効いた加護（V3-3 §3.3）
  for (const e of events) if (e.seq > prev.seq && (e.type === 'boon_granted' || e.type === 'boon_triggered' || e.type === 'boon_offered' || e.type === 'warden_slain' || e.type === 'archive_recalled') && e.text) out.push({ code: 'boon', text: e.text.replace(/。$/, '') });
  // 守護者のしたこと・分かった弱点（V3-3）
  for (const e of events) if (e.seq > prev.seq && (e.type === 'guardian_acted' || e.type === 'guardian_intel' || e.type === 'guardian_rested' || e.type === 'guardian_departed') && e.text) out.push({ code: e.type === 'guardian_intel' ? 'intel' : 'guardian', text: e.text.replace(/。$/, '') });
  // 節目の階の作り直し（V4-0a §1.1）
  for (const e of events) if (e.seq > prev.seq && e.type === 'floor_reset' && e.text) out.push({ code: 'floor_reset', text: e.text.replace(/。$/, '') });
  // 敵が目を覚ました理由（V3-4b §28.8）: 同じ文は ×N にまとめる
  const wokeCount = new Map<string, number>();
  for (const e of events) if (e.seq > prev.seq && e.type === 'monster_woke' && e.text) { const s = e.text.replace(/。$/, ''); wokeCount.set(s, (wokeCount.get(s) ?? 0) + 1); }
  for (const [s, n] of wokeCount) out.push({ code: 'woke', text: n > 1 ? `${s} ×${n}` : s });
  // 効いた特技（V3-4b §28.6）: 同じ文は ×N にまとめる
  const perkTexts = events.filter((e) => e.seq > prev.seq && e.type === 'perk_triggered' && e.text).map((e) => e.text.replace(/。$/, ''));
  const perkCount = new Map<string, number>();
  for (const s of perkTexts) perkCount.set(s, (perkCount.get(s) ?? 0) + 1);
  for (const [s, n] of perkCount) out.push({ code: 'perk', text: n > 1 ? `${s} ×${n}` : s });
  for (const s of cur.statuses) if (!prev.statuses.includes(s)) out.push({ code: 'status_gained', text: t(L, `状態異常: ${statusName(obs, s)}`, `Status: ${statusName(obs, s)}`) });
  for (const s of prev.statuses) if (!cur.statuses.includes(s)) out.push({ code: 'status_lost', text: t(L, `状態異常が解けた: ${prev.statusNames?.[s] ?? s.split(':')[1] ?? s}`, `Status ended: ${prev.statusNames?.[s] ?? s.split(':')[1] ?? s}`) });
  // 初めて見たときの 1 行（最大 3 件）は、上限の外で必ず渡す（「見た」と記録した後に上限で切ると、二度と出なかった。V4-1g G6）
  out.sort((a, b) => PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code));
  return [...out.slice(0, MAX_CHANGES), ...firsts];
}

/**
 * 遠征の途中の区切り（S7。SEASON.md §52.2 の 2）の控え。自分の手番の初め（engine の turn_began）ごとに、その手番の数と、
 * 敵が見えていないか（monsterInView）を渡して進める。区切りは、自分の手番の数が 100 の倍数を越えた後の、敵が見えていない最初の手番。
 * 戦いの最中（敵が見えている手番）は出さず、見えなくなった最初の手番に回す。前の区切りの後に、もう敵の見えない手番があったら、その 100 手番の分は出した。
 * World（手番の数）と視界だけから決まるので、ランの記録を畳めば同じに作り直せる（サーバーは覚えているだけ。起動し直したら畳み直す）
 */
export interface CheckpointLedger {
  /** 敵が見えていなかった、最後の自分の手番の数（まだ無ければ -1） */
  lastCalm: number;
  /** 区切りの手番（その手番の初めの seq と、手番の数）。新しいものだけ残す */
  due: { seq: number; turn: number }[];
  /**
   * S7a（SEASON.md §53.9 の 4）: いちばん新しい区切りの手番から後の、敵の見えていない自分の手番の初めの seq（区切りの手番を含む）。
   * 区切りを出すのは、この中の、応答の終わり（マクロの途中でない手番）の最初。出した・キャンプに着いた後は、もう足さない
   */
  calm?: number[];
  /** いちばん新しい区切りの手番の後に、キャンプに着いた（キャンプの区切りの段で、出したことにする） */
  camped?: boolean;
  /** 出したと分かった（応答の終わりの、敵の見えていない手番があった。記録から分かることを覚えておくだけ） */
  shown?: boolean;
}

export function checkpointStep(l: CheckpointLedger, turn: number, calm: boolean, seq: number, every = 100): void {
  if (!calm) return;
  const block = Math.trunc(turn / every) * every;
  if (turn >= every && l.lastCalm < block) {
    l.due.push({ seq, turn });
    if (l.due.length > 16) l.due.splice(0, l.due.length - 16);
    l.calm = [seq];
    l.camped = false;
    l.shown = false;
  } else if (l.due.length && !l.camped && !l.shown && l.calm) {
    l.calm.push(seq);
    if (l.calm.length > 4000) l.calm.splice(1, l.calm.length - 4000);
  }
  l.lastCalm = turn;
}

/** キャンプに着いた（S7）: キャンプそのものが区切り（キャンプの観測に区切りの段が出る）なので、その手番までの 100 手番の分は出したことにする */
export function checkpointCamp(l: CheckpointLedger, turn: number): void {
  l.lastCalm = Math.max(l.lastCalm, turn);
  if (l.due.length) l.camped = true;
}

function statusName(obs: Observation, id: string): string {
  return obs.self.statuses.find((s) => s.id === id)?.name ?? id;
}

/** 状態と、ゲームがあなたに何を待っているか */
export function turnStateOf(view: PlayerView, expeditionEndedNow: boolean): { state: TurnState; awaiting: Awaiting } {
  if (view.status === 'ended' || view.status === 'dead') return { state: 'run_ended', awaiting: 'nothing' };
  if (view.status === 'at_camp') {
    if (expeditionEndedNow) return { state: 'expedition_ended', awaiting: 'nothing' };
    // 目的を持ち主が握っている（S8 §54.4）: 次の遠征はあなたの選ぶことではない
    return { state: 'at_camp', awaiting: view.camp && !view.directive?.hold.includes('objective') ? 'camp_choice' : 'nothing' };
  }
  if (view.status === 'your_turn') return { state: 'your_turn', awaiting: 'action' };
  return { state: 'waiting_others', awaiting: 'nothing' };
}

/** waitedMs: 持ち主を待った wait_for_turn が時間切れで返ったときの、待った時間（S8b） */
export function buildTurnBlock(view: PlayerView, p: { reason: TurnReason; interruptedBy?: string; changes: Change[]; expeditionEndedNow?: boolean; waitedMs?: number }): TurnBlock {
  const s = turnStateOf(view, p.expeditionEndedNow ?? false);
  const b: TurnBlock = { state: s.state, turn_no: view.self.turns, reason: p.reason, awaiting: s.awaiting, changes: p.changes };
  if (p.interruptedBy) b.interrupted_by = p.interruptedBy;
  if (s.state === 'at_camp' && ownerWaitOpen(view)) {
    b.owner_wait = { decided: false, ...(p.reason === 'wait_timeout' && p.waitedMs !== undefined ? { waited_s: Math.round(p.waitedMs / 1000) } : {}), may_wait_again: true, turns_spent: 0 };
  }
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
      // シーズンの予算を使い切った・終わりの時刻を過ぎた（S8b: 持ち主を待つ文を出さない）
      if (seasonClosedView(view)) {
        return t(L,
          `▶ 遠征は終了しました（${endReasonText(L, x?.endReason ?? null)}）。これ以上の行動は不要です。${seasonClosedText(view)}`,
          `▶ The expedition has ended (${endReasonText(L, x?.endReason ?? null)}). No further action is required. ${seasonClosedText(view)}`);
      }
      // 目的を持ち主が握っている（S8a §55.6 の 8: ここでやめると、持ち主が始めた遠征を、だれも遊ばない）
      if (view.directive?.hold.includes('objective')) {
        return t(L,
          `▶ 遠征は終了しました（${endReasonText(L, x?.endReason ?? null)}）。${ownerWaitText(L)}`,
          `▶ The expedition has ended (${endReasonText(L, x?.endReason ?? null)}). ${ownerWaitText(L)}`);
      }
      return t(L,
        `▶ 遠征は終了しました（${endReasonText(L, x?.endReason ?? null)}）。これ以上の行動は不要です。次の遠征は start_expedition で選べます。`,
        `▶ The expedition has ended (${endReasonText(L, x?.endReason ?? null)}). No further action is required. You can choose the next one with start_expedition.`);
    case 'at_camp':
      // シーズンの予算を使い切った・終わりの時刻を過ぎた（S8b: 目的を握られていても、待つ文を出さない。本文の終わりの文とそろえる）
      if (view.camp && seasonClosedView(view)) {
        return t(L, `▶ キャンプにいます（遠征は終了済み）。${seasonClosedText(view)}`, `▶ You are at camp (the expedition is over). ${seasonClosedText(view)}`);
      }
      // 目的を持ち主が握っている（S8 §54.4 の 5）: 待ち方。持ち主を待った wait_for_turn が時間切れで返ったときは、今の状態をはっきり（S8b）
      if (ownerWaitOpen(view)) {
        if (b.reason === 'wait_timeout') return t(L, `▶ キャンプにいます。${ownerTimeoutText(L, b.owner_wait?.waited_s)}`, `▶ You are at camp. ${ownerTimeoutText(L, b.owner_wait?.waited_s)}`);
        return t(L, `▶ キャンプにいます。${ownerWaitText(L)}`, `▶ You are at camp. ${ownerWaitText(L)}`);
      }
      if (view.camp && !view.expedition) {
        return t(L, '▶ キャンプにいます。最初の遠征を 3 つの候補から start_expedition { offer } で選びます（目標の深さ・推奨レベル・条件を比べて）。',
          '▶ You are at camp. Choose the first expedition from the 3 offers with start_expedition { offer } (compare depth, recommended level and traits).');
      }
      return view.camp
        ? t(L, '▶ キャンプにいます（遠征は終了済み）。ここで終えてもかまいません。続けるなら start_expedition で次の遠征を選びます。', '▶ You are at camp (the expedition is over). It is fine to stop here. To continue, choose the next expedition with start_expedition.')
        : t(L, '▶ キャンプにいます。仲間の遠征が終わるまで次の遠征は選べません。', '▶ You are at camp. The next expedition can be chosen when your allies finish.');
    default: {
      const why = view.status === 'dead' ? t(L, '死亡', 'died') : t(L, '終了', 'ended');
      return t(L, `▶ ランは終了しました（${why}）。これ以上の行動はできません。`, `▶ The run has ended (${why}). No further actions are possible.`);
    }
  }
}

/** 目的を持ち主が握っているキャンプの待ち方（S8a §55.6 の 8。▶ 行と「できること」の待つ行で同じ言い方） */
export function ownerWaitText(L: Locale): string {
  return t(L, '持ち主が、次の遠征を決めるのを待つ。持ち主が始めたら、あなたが迷宮を進める（wait_for_turn で待てる。手番は減らない）。',
    'Wait for your owner to decide the next expedition. Once they start it, you play the dungeon (wait_for_turn waits; no turns are spent).');
}

/**
 * 持ち主を待った wait_for_turn が時間切れで返ったとき（S8b）: まだ決めていないこと・決めたら何が変わるか・何回待ってもよいこと・やめてもよいこと
 */
export function ownerTimeoutText(L: Locale, waitedS?: number): string {
  const w = waitedS !== undefined ? t(L, `（この待ちで ${waitedS} 秒待った）`, ` (waited ${waitedS} s this time)`) : '';
  return t(L,
    `持ち主は、まだ次の遠征を決めていない${w}。決めたら、次の応答で、迷宮の中に変わる。もう一度 wait_for_turn で待てる（何回待ってもよい。手番は減らない）。待つのをやめてもよい（やめても、持ち主が始めれば遠征は始まり、次に呼んだときに続きから遊べる）。`,
    `Your owner has not decided the next expedition yet${w}. Once they do, your next response shows you inside the dungeon. You can wait again with wait_for_turn (as many times as you like; no turns are spent). You may also stop waiting (if your owner starts the expedition meanwhile, it begins and you continue from there the next time you call).`);
}

/** 予算切れ・時間切れのキャンプの終わりの文（S8b。本文の「新しい遠征は始められない」とそろえる） */
function seasonClosedText(view: PlayerView): string {
  const L = view.locale;
  return (view.season?.budgetLeft ?? 1) <= 0
    ? t(L, 'このシーズンの行動予算を使い切ったので、新しい遠征は始められない。ここで終えてかまいません。', 'This season\'s budget is used up, so no new expedition can start. It is fine to stop here.')
    : t(L, 'シーズンは終わりの時刻を過ぎたので、新しい遠征は始められない。ここで終えてかまいません。', 'The season has passed its end time, so no new expedition can start. It is fine to stop here.');
}

export function changesLine(L: Locale, changes: Change[]): string {
  if (!changes.length) return '';
  // 守護者の撃破は別の行で先頭に（ほかの変化に埋もれさせない）
  const head = changes.filter((c) => c.code === 'guardian_slain').map((c) => c.text);
  const rest = changes.filter((c) => c.code !== 'guardian_slain');
  return [...head, rest.length ? t(L, '変化: ', 'Changes: ') + rest.map((c) => c.text).join(' / ') : ''].filter(Boolean).join('\n');
}

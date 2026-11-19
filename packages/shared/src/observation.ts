// Observation: PlayerView に AI が使いやすい派生情報を足して整形したもの。
// 派生情報は PlayerView（とカタログ）だけから計算する。仕様: docs/PROTOCOL.md §3
import type { Catalog, CatalogEquipStats } from './catalog';
import { abilityStatus, accBonuses, curseUnknown, isCursedItem, perkChoice, shortId, weaponReach } from './build';
import { armorWithStatuses, boonHookSum, haulTotal, nameOf, nextCampOf, nextOverreach, offerGap, offerWardenExtra, overreachPoints, payoutOf, regenInterval, regenStep, restCapHp, stairsSealed } from './catalog';
import { floorTraitsText, guardianDisplayName, multText, objectiveText, offerText, partsText, progressText, resultText } from './expedition';
import { COLLECT_WITHIN, collectTargets, isStationary, pickableItems, sameOrWorseEquip, worseEquip } from './macro';
import { attacksPerTurn, chaseAttacks, memoryOf, monsterSpeedOf, selfSpeed } from './danger';
import type { PerceivedEvent } from './filter';
import type { ReportCompare } from './expeditionStats';
import { kindName } from './narrate';
import type { NavGrid } from './nav';
import { buildNavGrid, distanceField, findFrontiers } from './nav';
import type { Dir, EntityRole, Expedition, HaulParts, Locale, MonsterMemory, Names, ObjectiveType, OfferSlot, Pos } from './types';
import { DIRS, DIR_VEC } from './types';
import { addDiceBonus, cheb, ceilDiv, compassDir, damageRangeVs, dirTo, floorDiv, formatDice, parseDice, t } from './util';
import type { EntityView, HpState, ItemView, PlayerView, ViewStatus } from './view';
import { hpState, xpForLevel } from './view';

/** data: 警告ごとの数値（incoming: 群れの被害見込み、escape: 逃げ道の見込み。V3-2R2 §18.1・§18.2） */
export interface Alert { code: string; text: string; entity?: string; data?: Record<string, unknown> }

/** 見れば分かる特徴（V3-2R2 §18.2）: 群れる・飛び道具・動かない。種族の公開タグから */
export type MonsterTrait = 'pack' | 'ranged' | 'stationary' | 'armored' | 'rusting' | 'pierce' | 'evasive' | 'drain' | 'heavy_swing' | 'heavy_blow';
/** 錆びさせる・装甲を抜く（V3-5a §35.10）も種族の公開タグから */
const OBVIOUS_TRAITS: readonly MonsterTrait[] = ['pack', 'ranged', 'stationary', 'rusting', 'pierce', 'drain', 'heavy_swing'];

/** 回復の手段（V4-1c §16.2）。ability: use_ability の id で使う。item: use_item の slot で使う */
export type ObsRecovery =
  | { kind: 'ability'; id: string; name: string; ready: boolean; amount: string }
  | { kind: 'item'; slot: string; name: string; qty: number; amount: string };

/**
 * そのプレイヤーがいま知っている回復の手段（V4-1c §16.2）。能動技は効果（handler）が最大 HP の割合の回復のもの、
 * 品は効果の定義に HP の回復（catalog の heal）があるもの。品の種類は視界の投影で、鑑定するまで伏せられている（kind が null）ので、未鑑定の品は入らない
 */
export function recoveryOf(view: PlayerView, catalog: Catalog, L: Locale): ObsRecovery[] {
  const out: ObsRecovery[] = [];
  for (const a of view.self.build.abilities) {
    const def = catalog.abilities[a.id];
    if (!def?.heal) continue;
    const st = abilityStatus(view, catalog, a.id);
    out.push({ kind: 'ability', id: shortId(a.id), name: nameOf(def.name, L, shortId(a.id)), ready: st.cooldownLeft === 0 && st.usesLeft !== 0, amount: t(L, `最大 HP の ${def.heal.pct}%`, `${def.heal.pct}% of max HP`) });
  }
  for (const it of view.inventory) {
    const heal = it.kind ? catalog.items[it.kind]?.heal : undefined;
    if (!heal) continue;
    const min = heal.minPct ? t(L, `（最大 HP の ${heal.minPct}% を下回らない）`, ` (at least ${heal.minPct}% of max HP)`) : '';
    out.push({ kind: 'item', slot: it.slot, name: itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes), qty: it.qty, amount: `${heal.amount}${min}` });
  }
  return out;
}

export interface ObsMonster {
  id: string; name: string; pos: Pos; dir: Dir | null; dist: number;
  /** 持っている品（倒すと落とす。宝物庫の鍵。V3-5 §5.1）と、その名前 */
  carries?: string; carries_name?: string;
  hp_state: HpState; awareness: string;
  /** 脅威。その種族から攻撃を受けた記録が無ければ null（不明・初見。V3-2R §14.3） */
  threat: 1 | 2 | 3 | 4 | 5 | null;
  statuses: string[];
  /** その種族から受けた最大の一撃（会心を見ていれば会心の値）。記録が無ければ null */
  worst_hit: number | null;
  /** 速さ: 自分の今の速さとの比較（見れば分かる。V3-2R2 §18.2） */
  speed: 'slow' | 'normal' | 'fast';
  /** 自分の速さに対する倍率（速い・遅いときだけ。0.8 なら、あなたの 1 手に 0.8 手。V3-7a 後の評価） */
  speed_ratio?: number;
  /** 見れば分かる特徴（群れる・飛び道具・動かない・重装＝素の装甲 3 以上） */
  traits: MonsterTrait[];
  /** 体格（小柄・大柄。並は出さない。V3-2R3 §20.4） */
  size?: 'small' | 'large';
  /** 1 手番あたりの最悪の被害 = worst_hit × 自分の 1 手番に相手が行動する回数（記録が無ければ null） */
  worst_turn: number | null;
  /** 通りの記録: 自分の攻撃が当たったときの実ダメージの [合計, 回数]（近接・投擲） */
  dealt?: { melee?: [number, number]; thrown?: [number, number] };
  /** 本当に初めて見た種族（このランで遭遇した個体がいま見えているものだけ） */
  first_seen?: boolean;
  /** 命中の記録 [命中, 回数]（記録が無ければ出さない）。確率そのものは出さない（相手の回避は伏せた情報） */
  hits?: { your_melee?: [number, number]; your_thrown?: [number, number]; theirs?: [number, number] };
  /** 遠征の守護者 */
  role?: EntityRole;
  /** この遠征の目的の相手（目的の守護者・大守護者・賞金首。V4-1a §12.2。文は名前の後ろに「［目的］」） */
  objective?: true;
  /** 名前付きの強敵の名前（V3-5 §5.4。role: elite） */
  named?: string;
  /** 手負いで逃げている（追跡中でも extract・休息を妨げない） */
  fleeing?: boolean;
  /** 自分が見ている間にこの個体が受けた実ダメージの合計 */
  damage_seen?: number;
  /**
   * 推定残り HP（思い出に体力の記録がある種族のみ。4 段階表示と damage_seen から計算）。
   * 記録が rules.estimateMinSamples 体未満の間は上限を出さない（max: null）
   */
  hp_left_est?: HpEstimate;
  /** 自分のセルから投擲の経路が通るか */
  shot: 'clear' | 'blocked';
  /** 投げられる持ち物ごとの射線と射程（V3-2R §14.3） */
  shots: { slot: string; state: 'clear' | 'blocked' | 'out_of_range' }[];
  /** 倒すと戦利品に入る賞金 */
  bounty?: number;
  /** 守護者の呼び名・型・分かった弱点（V3-3 §3.1。弱点は試して分かったものだけ） */
  guardian?: { name: string; types: { id: string; name: string }[]; weakness?: { id: string; name: string }; warden?: boolean; not_weak?: { id: string; name: string }[] };
  /** 予備動作（見えていれば出る。V3-3 §3.1）。on_line: 突進の直線の上に自分がいる */
  /** swinging（大振りの構え。V3-5b）: pos は打つマス、on_line はあなたがそのマスにいる */
  intent?: { code: 'winding_up' | 'summoning' | 'enraging' | 'swinging'; dir?: Dir; pos?: Pos; on_line?: boolean; text: string };
}
/** 同じセルの同種の物は 1 行にまとめる（ids に全て。id は先頭） */
export interface ObsItem { id: string; ids?: string[]; name: string; pos: Pos; dir: Dir | null; dist: number; qty: number; remembered?: boolean; role?: EntityRole; /** この遠征の目的の遺物（V4-1a §12.2） */ objective?: true; mine?: boolean; value?: number; /** まとめた「自分が投げた物」の、最寄りのマスの本数 */ near_qty?: number }

export interface RestEstimate {
  /** 休憩で戻る HP（上限 cap_hp まで。V3-4b §28.3） */
  hp_to_full: number;
  /** 休憩と自然回復で戻る上限の HP（最大 HP × rest.capPct %） */
  cap_hp: number;
  /** 全快までの手番数（追跡中の敵が見えず毒も無いまま休み続けた場合） */
  turns: number;
  /** 経過するフロア時間 */
  time: number;
  /** その間に湧く徘徊モンスターの目安（公開ルールの湧き間隔から） */
  wander_expected: string;
  blocked_by?: 'hostile_hunting' | 'poisoned';
  /** 毒のとき: 毒が抜けるまでの間の最低 HP の見込み */
  lowest_hp?: number;
}

export interface ObsExpedition {
  no: number;
  /** 次の節目（V3-3 §3.2） */
  milestone?: ObsMilestone;
  /** この遠征の守護者の「称号＋名前」・型・分かった弱点（V3-3。弱点は試して分かったときだけ） */
  guardian?: { name: string; types: { id: string; name: string }[]; weakness?: { id: string; name: string } };
  objective: { type: ObjectiveType; target_depth: number | null; text: string };
  progress: { depth: number | null; target_depth: number | null; reached?: boolean; guardian_slain?: boolean; relic_held?: boolean };
  status: Expedition['status'];
  points: number;
  /** 今この場で extract できるか */
  can_extract: boolean;
  /** 今 extract したら: complete（達成して帰還）/ withdraw（撤退、confirm が必要） */
  extract_outcome: 'complete' | 'withdraw';
  extract_blocked_by?: 'not_on_stairs' | 'not_your_turn' | 'ended';
  /** 1 行の要約 */
  text: string;
  /** 終了した遠征の結果 */
  result?: { reason: string; points: number; deepest: number; kills: number; turns: number; text: string };
  slot?: OfferSlot;
  traits?: string[];
  /** 目標の気配（目標階にいる間。方角と 10 マス以内かどうか。V3-2R §14.2） */
  sense?: { what: 'guardian' | 'relic'; dir: Dir; range: 'far' | 'near'; text: string };
  /** 護りの火の手がかり（V3-3c §44.6）: 同じ守護者の火を 1 基見ていれば、まだ見ていない灯っている火の方角と遠さ */
  ward_fires?: { guardian: string; dir: Dir; range: 'far' | 'near'; text: string }[];
  /** 未確定の戦利品（v3）。今 extract した場合の確定点と、次に踏破の点が入る階 */
  haul?: {
    total: number; multiplier_pct: number; parts: HaulParts;
    if_extract_now: number;
    /** 今ここで帰還の綱を使った場合の確定点（綱を持っているときだけ。V3-2R2 §18.1） */
    if_lifeline_now?: number;
    /**
     * 次の踏破: その階の下り階段に立てば点が入る（V3-2R）。path_len は今いる階がその階で、下り階段を知っているときの経路長。
     * dir は下り階段が未発見のときの「下への風」の方角（V3-2R2 §18.4）
     */
    next_overreach: { depth: number; points: number; at: 'stairs_down'; path_len: number | null; dir?: Dir } | null;
    /** 今帰った場合の次の候補の下限と推奨レベル（目標として達成した最深の階から。踏破では深くならない。V3-2R3 §20.2） */
    next_camp: { min_target_depth: number; recommended_level: number } | null;
    /** 1 行の要約 */
    text: string;
  };
}

export interface ObsCamp {
  next_no: number;
  offers: {
    index: number; type: ObjectiveType; target_depth: number | null; points: number; text: string;
    slot?: OfferSlot; traits?: string[]; multiplier_pct: number;
    /** 再挑戦（V3-3c §44.1）: その守護者を目的にした遠征の番号 */
    rechallenge?: { no: number | null };
    /** 推奨レベルと、自分のレベルとの差（正なら推奨より低い）。条件の危険度の合計は別に出す（V3-2R §14.4） */
    recommended_level: number | null; level_gap: number | null; trait_danger: number;
    /** 守護者の見込み（格と見れば分かる特徴。種族名は会うまで出さない。V3-2R3 §20.1）。hp: 体力の目安（格 1〜3）、hp_range: 体力の幅（V4-0d §6.1。大守護者は式の幅）、armor: 装甲の目安 */
    guardian?: { rank: 1 | 2 | 3; traits: string[]; armor?: number; hp?: number; hp_range?: { min: number; max: number } };
    /** 賞金首の見込み（V3-8 §53.2）。hp_range: 体力の幅（V4-0d §6.1。古い候補には無い） */
    bounty?: { kind: string; name: string; hp: number; hp_range?: { min: number; max: number }; max_hit: number };
    vault?: boolean; scar?: number;
    /** 目的の階と通り道の階のうち、作られていて性質のある階（V4-0e §8.1。条件の ID・性質の名前・深さ。まだ作られていない階は入らない） */
    floor_traits?: { trait: string; name: string; depths: number[] }[];
    /** 遺物の名前と、持ち帰るとなる加護（V3-3 §3.3）。owned: もう持っている加護（新しくは付かない） */
    relic?: { kind: string; name: string; boon: string | null; boon_name?: string; boon_desc?: string; owned?: boolean };
  }[];
  /** 次の節目（V3-3 §3.2）: まだ倒していない最も浅い大守護者の階 */
  milestone?: ObsMilestone;
  /** 記録庫に納めた欠片の数（V3-3a §35.7） */
  archive?: { delivered: number; total: number };
  /** 直前の遠征の比較（2 行以内。V3-6 §35.9: 候補を選ぶ画面で自分の記録が目に入る） */
  compare?: { no: number; lines: string[] } & ReportCompare;
  /** プロフィールの記録の要約と次の節目（1 行。V3-7 §7.2）・直前の遠征で取った実績 */
  records?: { line: string; feats_new?: string[] };
  /** 古い版で始まったラン（V4-0b §1.2。最初の 1 度だけ） */
  version_note?: string;
}

/** 節目の大守護者（V3-3 §3.2）。弱点と種族は伏せる */
export interface ObsMilestone { depth: number; name: string; types: { id: string; name: string }[]; cleared: boolean; text: string; memory?: { weakness?: string; hp?: number; max_hit?: number; armor?: number } }

/** 加護の一覧（V3-3 §3.3）。used: 遠征に 1 回の加護をこの遠征で使った */
export interface ObsBoon { id: string; name: string; desc: string; used?: boolean }
export interface ObsPlayer { id: string; name: string; pos: Pos; dir: Dir | null; dist: number; hp_state: HpState }
/** lair: 棲み処の地物（護りの火）の持ち主の守護者の呼び名（V3-3c §44.6） */
/** id: travel_to で指せる（V3-8a §56.1 の 5） */
export interface ObsFeature { id?: string; type: string; name: string; pos: Pos; dir: Dir | null; dist: number; state?: string; lair?: string }
/**
 * 自分の持ち物の性能（鑑定済みのみ。接辞込み）。weapon.traits は武器の特性（V3-4）、armor の move_cost / wake_pct は重い鎧、
 * mods は装飾品の修正と、接辞による追加の修正（最大 HP・視界など）
 */
export interface ItemStats {
  weapon?: { dmg: string; acc: number; traits?: string[] };
  armor?: { armor: number; eva: number; move_cost?: number; wake_pct?: number };
  throw?: { dmg: string | null; acc: number; range: number };
  mods?: CatalogEquipStats;
}
/** curse: 'unknown' は呪いの有無をまだ確かめていない装備品、'cursed' は呪われている（外せない。V3-4） */
/** kind: 鑑定済みの品の種類 ID（fight の with に渡せる。スロット文字は拾い物で変わる。V3-7a 後の評価）。clue: 未鑑定の手がかり（V3-5 §5.4） */
export interface ObsInvItem { slot: string; name: string; qty: number; category: string; identified: boolean; equipped: boolean; kind?: string; value?: number; stats?: ItemStats; curse?: 'unknown' | 'cursed'; clue?: string }
/** 推定残り HP。record は記録した個体の体力の範囲（標本であって種族の範囲ではない） */
/** untouched: まだ誰からも傷を負わされていない（残り HP は最大 HP そのもの。文は「残り」と言わず記録の範囲を出す。V4-0b §1.5） */
export interface HpEstimate { min: number; max: number | null; samples: number; record: { min: number; max: number }; untouched?: true }

export interface Observation {
  seq: number;
  status: ViewStatus;
  summary: string;
  alerts: Alert[];
  self: {
    name: string; class: string; level: number; xp: number; xp_next: number;
    hp: number; max_hp: number; statuses: { id: string; name: string; turns_left: number }[];
    /** draft: 下り階段が未発見のときの方角（下への風）。explored: 見た割合の 4 段階（1 約 1/4 … 4 ほぼ全て。V3-2R2 §18.4） */
    /** event_text: 階の異変の到着の文（V3-5 §5.3。ID と中身は出さない） */
    /** traits・trait_text: この階を作ったときに効いた条件（V4-0e §8.1。作られた階に残る性質。「群れている（敵と宝が多い）」） */
    pos: Pos | null; floor: { depth: number; biome_name: string; floor_type: string; floor_type_id?: string; time: number; draft?: Dir; explored?: 1 | 2 | 3 | 4; hint_text?: string; event_text?: string; traits?: string[]; trait_text?: string } | null;
    /** throws: 投げられる持ち物（命中は自分の命中値込み） */
    attack: { acc: number; dmg: string; throws?: { slot: string; kind?: string; name: string; dmg: string | null; acc: number; range: number }[] }; defense: { eva: number; armor: number };
    equipment: { weapon?: string; armor?: string; accessory?: string };
    inventory_count: number; inventory_capacity: number;
    inventory_brief?: string;
    inventory?: ObsInvItem[];
    /** 自分が行動した手番数 */
    turns: number;
    /** 実効の速さ（標準 100。状態異常込み） */
    speed: number;
    /** スコア版 2: 確定済みの点と達成した遠征の数 */
    score: { banked: number; expeditions_completed: number };
    /** HP が減っているときのみ: 全快まで休んだ場合の見積もり */
    rest_estimate?: RestEstimate;
    /** ビルド（V3-4）: 取った特技（ranks は段階）・覚えた能動技（cooldown_left 0 なら使える。uses_left は遠征ごとの回数の残り） */
    perks: { id: string; name: string; ranks: number }[];
    abilities: { id: string; name: string; cooldown_left: number; uses_left?: number; target: 'adjacent' | 'throw' | 'dir' | 'none' }[];
    /**
     * 回復の手段（V4-1c §16.2）: 使うと自分の HP が回復する能動技と、正体の分かっている品。効果の定義から決める（未鑑定の品は入らない）。
     * ability の ready は abilities の「使える」と同じ。amount は説明の文。無ければ空
     */
    recovery: ObsRecovery[];
    /** 選べる特技の候補（choose_perk { option }）。more は後に控えている候補の数 */
    perk_choice?: { level: number; options: { option: number; id: string; name: string; desc: string; lineage: string }[]; more: number };
    /** 加護（V3-3 §3.3）: 持ち帰った遺物から。ランの終わりまで残る */
    boons: ObsBoon[];
    /** 文の加護の行は名前だけ（説明はこの遠征で出した） */
    boons_brief?: boolean;
    /** 選べる加護の候補（大守護者を倒した。choose_boon { option }。V3-3 §3.2） */
    boon_choice?: { depth: number; options: { option: number; id: string; name: string; desc: string }[] };
  };
  /** items_omitted: 記憶の中の遠いアイテムのうち省いた件数 */
  visible: { monsters: ObsMonster[]; items: ObsItem[]; players: ObsPlayer[]; features: ObsFeature[]; items_omitted?: number };
  navigation: {
    here: string;
    passable_dirs: Dir[];
    frontiers: { pos: Pos; dir: Dir | null; dist: number }[];
    /** path_len: 既知地図上の経路長（不明なら null） */
    /** occupied_by: 階段の上に見えている敵の ID（travel_to はふさがれて止まる。V3-7a 後の評価） */
    /** sealed: 大守護者を倒していない節目の下り階段（V4-1a §12.4） */
    known_stairs: { type: 'down' | 'up'; pos: Pos; dist: number; reachable: boolean; path_len: number | null; occupied_by?: string; sealed?: true }[];
    /** 引数なしの collect（what: items）が拾いに行く品（V4-1a §12.1）: 既定の範囲（15 歩）の内側で、collect と同じ経路で着ける品。valid_actions の件数はこれ */
    collectable: { count: number; ids: string[] };
    /** 地形は判明しているが、まだ見ていないセルの数（地図の巻物の後。explore はそこへ向かう） */
    unsighted?: number;
  };
  recent_events: string[];
  map?: { origin: Pos; rows: string[]; legend: Record<string, string> };
  valid_actions: string[];
  /** 遠征の目的と進捗（事実の表示。次の一手の指示ではない） */
  expedition?: ObsExpedition;
  /** キャンプの候補（遠征と遠征の間のみ） */
  camp?: ObsCamp;
}

export interface ObservationOptions {
  detail: 'brief' | 'full';
  map: boolean;
  mapWidth?: number;
  mapHeight?: number;
  recent?: PerceivedEvent[];
  /** 帰還の綱の長い説明はこの遠征で出した（以降は短い行。V3-3a §35.8） */
  lifelineShort?: boolean;
  /** 加護の行は名前だけ（この遠征で説明を出した。V3-3c §44.6） */
  boonsShort?: boolean;
  /** キャンプ: 直前の遠征の比較（遠征レポートから。V3-6 §35.9） */
  campCompare?: { no: number; lines: string[]; compare?: ReportCompare };
  /** キャンプ: 候補に添える注記（候補の番号 → 文。再挑戦の前回の戦い。V3-3c §44.1） */
  offerNotes?: Record<number, string>;
  /** キャンプ: プロフィールの記録の 1 行と、直前の遠征で取った実績（V3-7 §7.2・§7.4） */
  records?: { line: string; featsNew?: string[] };
  /** キャンプ: 古い版で始まったランの 1 行（V4-0b §1.2。サーバーが版を比べて渡す） */
  versionNote?: string;
  /** この応答の間に、見えていない相手から撃たれた方角（古い順。V4-0c §4.3） */
  unseenShots?: Dir[];
}

const DIR_JA: Record<Dir, string> = { n: '北', ne: '北東', e: '東', se: '南東', s: '南', sw: '南西', w: '西', nw: '北西' };

/** 地物の状態の表示名 */
function featureStateText(L: Locale, s: string): string {
  const m: Record<string, [string, string]> = { used: ['使用済み', 'used'], open: ['開', 'open'], closed: ['閉', 'closed'], revealed: ['発見済み', 'revealed'] };
  return m[s] ? t(L, m[s][0], m[s][1]) : s;
}

export function dirLabel(locale: Locale, d: Dir | null): string {
  if (!d) return t(locale, '足元', 'here');
  return locale === 'en' ? d : DIR_JA[d];
}

/** "東8南4" のような相対位置 */
export function relLabel(locale: Locale, from: Pos, to: Pos): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const parts: string[] = [];
  if (locale === 'en') {
    if (dy < 0) parts.push(`${-dy}N`);
    if (dy > 0) parts.push(`${dy}S`);
    if (dx > 0) parts.push(`${dx}E`);
    if (dx < 0) parts.push(`${-dx}W`);
    return parts.join(' ') || 'here';
  }
  if (dx > 0) parts.push(`東${dx}`);
  if (dx < 0) parts.push(`西${-dx}`);
  if (dy < 0) parts.push(`北${-dy}`);
  if (dy > 0) parts.push(`南${dy}`);
  return parts.join('') || '足元';
}

const HP_JA: Record<HpState, string> = { healthy: '健康', wounded: '軽傷', badly_wounded: '重傷', near_death: '瀕死' };
const AW_JA: Record<string, string> = { asleep: '睡眠中', unaware: '未察知', hunting: '追跡中' };

export function itemDisplayName(catalog: Catalog, locale: Locale, kind: string | null, appearanceId: string | null, affixes: readonly string[] = []): string {
  const base = kindName(catalog, locale, kind, appearanceId);
  if (!affixes.length || !kind) return base;
  const af = affixes.map((a) => nameOf(catalog.affixes[a]?.name, locale, a));
  return locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`;
}

export function monsterDisplayName(catalog: Catalog, locale: Locale, e: EntityView): string {
  const base = kindName(catalog, locale, e.kind);
  const af = (e.affixes ?? []).map((a) => nameOf(catalog.affixes[a]?.name, locale, a));
  const tier = e.tier ? `+${e.tier}` : '';
  if (!af.length) return base + tier;
  return (locale === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`) + tier;
}

function itemCategory(catalog: Catalog, kind: string | null, appearanceId: string | null): string {
  if (kind && catalog.items[kind]) return catalog.items[kind].category;
  if (appearanceId && catalog.appearances[appearanceId]) return catalog.appearances[appearanceId].category;
  return 'misc';
}

/**
 * 推定残り HP。思い出の体力の記録（倒した個体の最大 HP の範囲）と 4 段階表示と damage_seen だけから計算する。
 * 記録の範囲と矛盾する（接辞・深層強化で頑丈な）個体では undefined。
 */
export function hpLeftEstimate(mem: MonsterMemory | undefined, band: HpState, damageSeen: number, minSamples = 5): HpEstimate | undefined {
  const hs = mem?.hpSeen;
  if (!hs) return undefined;
  const record = { min: hs.min, max: hs.max };
  const lo = Math.max(hs.min, damageSeen + 1);
  // まだ誰からも傷を負わされていない（見た被害 0・無傷の帯）なら、残り HP は最大 HP そのもの: 記録の範囲を出す
  // （「無傷の帯」の下限まで広げると、1 発も当てていない相手に「残り 3 以上」と出た。Muse の実プレイ、V3-4b §28.11）
  if (damageSeen <= 0 && band === 'healthy') return { min: hs.min, max: hs.samples >= minSamples ? hs.max : null, samples: hs.samples, record, untouched: true };
  if (hs.samples < minSamples) {
    // 記録が少ない間は最大値を上限として使わない: 最大 HP が lo 以上のどれかとして、下限だけを出す
    for (let m = lo; m <= lo * 4 + 10; m++) {
      for (let h = 1; h <= m - damageSeen; h++) {
        if (hpState(h, m) === band) return { min: h, max: null, samples: hs.samples, record };
      }
    }
    return undefined;
  }
  let mn = Number.MAX_SAFE_INTEGER;
  let mx = -1;
  for (let m = lo; m <= hs.max; m++) {
    for (let h = 1; h <= m - damageSeen; h++) {
      if (hpState(h, m) !== band) continue;
      if (h < mn) mn = h;
      if (h > mx) mx = h;
    }
  }
  return mx < 0 ? undefined : { min: mn, max: mx, samples: hs.samples, record };
}

/**
 * 推定残り HP の文章（V3-2R §14.3）。記録は標本なので「記録どおりなら」と言う。
 * 「記録どおりなら残り 6〜8（記録 3 体: 体力 8〜8）」「記録どおりなら残り 3 以上（記録 1 体: 体力 8）」
 */
/** 体力の記録を「確かな幅」として扱える標本の数（これ未満は上限を出さず、「個体差あり」を添える） */
export const HP_RECORD_SURE = 5;

export function hpEstimateText(locale: Locale, est: { min: number; max: number | null; samples: number; record?: { min: number; max: number }; untouched?: boolean }): string {
  const rec = est.record ? (est.record.min === est.record.max ? `${est.record.min}` : t(locale, `${est.record.min}〜${est.record.max}`, `${est.record.min}-${est.record.max}`)) : '';
  const few = est.samples < HP_RECORD_SURE;
  // まだ当てていない相手には「残り」と言わない（V4-0b §1.5）: 体力の記録の範囲をそのまま出す
  if (est.untouched && rec) return t(locale, `体力の記録 ${rec}（まだ傷を負っていない。記録 ${est.samples} 体${few ? '。個体差あり' : ''}）`, `HP record ${rec} (unhurt so far; ${est.samples} recorded${few ? '; individuals vary' : ''})`);
  // 上限を出さないとき（記録が少ない）は根拠を添える: 見えている傷の具合と、体力の記録の最小から
  if (est.max === null && est.record) {
    return t(locale, `記録どおりなら残り ${est.min} 以上（傷の具合と、体力の記録の最小 ${est.record.min} から。記録 ${est.samples} 体${few ? '。個体差あり' : ''}）`,
      `if typical, >= ${est.min} left (from its wounds and the smallest HP on record, ${est.record.min}; ${est.samples} recorded${few ? '; individuals vary' : ''})`);
  }
  const recText = t(locale, `（記録 ${est.samples} 体${rec ? `: 体力 ${rec}` : ''}${few ? '。個体差あり' : ''}）`, ` (${est.samples} recorded${rec ? `, HP ${rec}` : ''}${few ? '; individuals vary' : ''})`);
  const range = est.max === null ? t(locale, `${est.min} 以上`, `>= ${est.min}`) : est.min === est.max ? `${est.min}` : t(locale, `${est.min}〜${est.max}`, `${est.min}-${est.max}`);
  return t(locale, `記録どおりなら残り ${range}${recText}`, `if typical, ${range} left${recText}`);
}

/** 自分の持ち物の性能（鑑定済みの品だけ。接辞の効果を足す） */
export function itemStats(catalog: Catalog, kind: string | null, affixes: readonly string[] = []): ItemStats | undefined {
  if (!kind) return undefined;
  const ci = catalog.items[kind];
  if (!ci) return undefined;
  let acc = 0, dmgBonus = 0, armor = 0, eva = 0, might = 0, maxHp = 0, sight = 0;
  for (const a of affixes) {
    const m = catalog.affixes[a]?.itemMods;
    if (m) { acc += m.acc; dmgBonus += m.dmgBonus; armor += m.armor; eva += m.eva ?? 0; might += m.might ?? 0; maxHp += m.maxHp ?? 0; sight += m.sight ?? 0; }
  }
  const es = ci.equipStats ?? {};
  const out: ItemStats = {};
  if (ci.weapon) {
    const d = parseDice(ci.weapon.dmg);
    out.weapon = { dmg: formatDice({ ...d, bonus: d.bonus + dmgBonus }), acc: ci.weapon.acc + acc, ...(es.traits?.length ? { traits: [...es.traits] } : {}) };
  }
  if (ci.armorStats) {
    out.armor = { armor: ci.armorStats.armor + armor, eva: ci.armorStats.eva + eva, ...(es.moveCost ? { move_cost: es.moveCost } : {}), ...(es.wakePct ? { wake_pct: es.wakePct } : {}) };
  }
  if (ci.throwStats) out.throw = { dmg: ci.throwStats.dmg, acc: ci.throwStats.acc, range: ci.throwStats.range };
  else if (ci.throwRange !== null && ci.category === 'potion') out.throw = { dmg: null, acc: 0, range: ci.throwRange };
  // 装飾品の修正と、接辞による追加の修正（武器の命中・ダメージ、防具の装甲・回避は上に含めた）
  const mods: CatalogEquipStats = {};
  const add = (k: keyof CatalogEquipStats, v: number) => { if (v) (mods as Record<string, number>)[k] = ((mods as Record<string, number>)[k] ?? 0) + v; };
  if (ci.slot === 'accessory') {
    for (const k of ['acc', 'eva', 'might', 'armor', 'maxHp', 'sight', 'meleeAcc', 'thrownAcc', 'stealthPct'] as const) add(k, (es[k] as number | undefined) ?? 0);
    if (es.noiseWakes) mods.noiseWakes = true;
    add('acc', acc); add('armor', armor); add('eva', eva);
  } else if (ci.weapon) {
    // 武器: 命中・ダメージは weapon に含めた
    add('armor', armor); add('eva', eva);
  } else if (ci.armorStats) {
    // 防具: 装甲・回避は armor に含めた
    add('acc', acc);
  } else { add('acc', acc); add('armor', armor); add('eva', eva); }
  add('might', might); add('maxHp', maxHp); add('sight', sight);
  if (Object.keys(mods).length) out.mods = mods;
  return out.weapon || out.armor || out.throw || out.mods ? out : undefined;
}

const sgn = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** 性能の短い文章（「1d6・命中+1」「装甲3・回避-1」「投擲1d4+1・射程7・命中+1」） */
export function itemStatsText(L: Locale, s: ItemStats | undefined, catalog?: Catalog): string {
  if (!s) return '';
  const parts: string[] = [];
  const traits = (s.weapon?.traits ?? []).map((id) => nameOf(catalog?.weaponTraits[id]?.name, L, id.split(':')[1] ?? id));
  if (s.weapon) parts.push(t(L, `${s.weapon.dmg}・命中${sgn(s.weapon.acc)}${traits.length ? `・${traits.join('・')}` : ''}`, `${s.weapon.dmg}, acc ${sgn(s.weapon.acc)}${traits.length ? `, ${traits.join(', ')}` : ''}`));
  if (s.armor) {
    const heavy = s.armor.move_cost ? t(L, `・歩く手番${s.armor.move_cost}`, `, move cost ${s.armor.move_cost}`) : '';
    const wake = s.armor.wake_pct ? t(L, `・起こしやすい+${s.armor.wake_pct}%`, `, wakes sleepers +${s.armor.wake_pct}%`) : '';
    parts.push(t(L, `装甲${s.armor.armor}${s.armor.eva ? `・回避${sgn(s.armor.eva)}` : ''}${heavy}${wake}`, `armor ${s.armor.armor}${s.armor.eva ? `, eva ${sgn(s.armor.eva)}` : ''}${heavy}${wake}`));
  }
  if (s.mods) {
    const m = s.mods;
    const ja: string[] = [], en: string[] = [];
    const push = (v: number | undefined, j: string, e: string) => { if (v) { ja.push(`${j}${sgn(v)}`); en.push(`${e} ${sgn(v)}`); } };
    push(m.acc, '命中', 'acc'); push(m.eva, '回避', 'eva'); push(m.might, '威力', 'might'); push(m.armor, '装甲', 'armor');
    push(m.maxHp, '最大HP', 'max HP'); push(m.sight, '視界', 'sight'); push(m.meleeAcc, '近接の命中', 'melee acc'); push(m.thrownAcc, '投擲の命中', 'thrown acc');
    push(m.stealthPct, '起こしにくさ', 'stealth');
    if (m.noiseWakes) { ja.push('自分の立てた音（攻撃・扉・投擲）で、眠っている敵が必ず起きる'); en.push('noise you make (attacks, doors, throws) always wakes sleeping enemies'); }
    if (ja.length) parts.push(L === 'en' ? en.join(', ') : ja.join('・'));
  }
  if (s.throw) parts.push(s.throw.dmg ? t(L, `投擲${s.throw.dmg}・射程${s.throw.range}・命中${sgn(s.throw.acc)}`, `thrown ${s.throw.dmg}, range ${s.throw.range}, acc ${sgn(s.throw.acc)}`)
    : t(L, `投げると割れる・射程${s.throw.range}`, `shatters when thrown, range ${s.throw.range}`));
  return parts.join(' / ');
}

/**
 * 未鑑定の手がかりの文。同じ手がかりの 2 種のうち 1 種を鑑定済みなら、残りの 1 種に絞る（V3-7 の評価: 片方が分かっても 2 択のままだった）。
 * 手がかりの組は公開カタログ、鑑定済みは本人の知識だけから
 */
export function clueText(L: Locale, catalog: Catalog, view: Pick<PlayerView, 'identified'>, clue: Names): string {
  const base = nameOf(clue, L, '');
  const cands = Object.entries(catalog.items).filter(([, it]) => it.clue?.ja === clue.ja).map(([id]) => id);
  const known = cands.filter((id) => view.identified.includes(id));
  const left = cands.filter((id) => !view.identified.includes(id));
  if (cands.length < 2 || !known.length || left.length !== 1) return base;
  const nm = (id: string) => nameOf(catalog.items[id].name, L, id);
  return t(L, `${base}。${known.map(nm).join('・')}は判明済みなので、${nm(left[0])}のはず`, `${base}; ${known.map(nm).join(', ')} is known, so this should be ${nm(left[0])}`);
}

const MOD_JA: Record<string, string> = { hpPct: '体力', speed: '速さ', acc: '命中', eva: '回避', might: '威力', armor: '装甲', dmgBonus: 'ダメージ', maxHp: '最大 HP', sight: '視界' };
/** 敵の接辞の効き目の文（「古の（体力 +60%・命中 +2・威力 +1）」。V3-8 §53.3） */
export function monsterAffixText(L: Locale, catalog: Catalog, ids: readonly string[]): string {
  return ids.map((id) => {
    const a = catalog.affixes[id];
    if (!a) return id;
    const mods = Object.entries(a.monsterMods ?? {}).map(([k, v]) => `${L === 'en' ? k : MOD_JA[k] ?? k} ${v > 0 ? '+' : ''}${v}${k === 'hpPct' ? '%' : ''}`);
    return `${nameOf(a.name, L, id)}${mods.length ? (L === 'en' ? ` (${mods.join(', ')})` : `（${mods.join('・')}）`) : ''}`;
  }).join(L === 'en' ? '; ' : '、');
}

/** 能力タグの表示名 */
export function abilityName(locale: Locale, a: string): string {
  const ja: Record<string, string> = { flees: '手負いで逃げる', ranged: '遠隔攻撃', fast: '速い', slow: '遅い', poison: '毒', stationary: '動かない', pack: '群れる', armored: '重装', rusting: '錆びさせる', pierce: '装甲を抜く', evasive: '回避が高い', drain: '血を吸う', heavy_swing: '大振り', heavy_blow: '重い一撃（装甲で半分までしか減らない）' };
  const en: Record<string, string> = { flees: 'flees when hurt', ranged: 'ranged attack', fast: 'fast', slow: 'slow', poison: 'poison', stationary: 'stationary', pack: 'pack', armored: 'armored', rusting: 'rusts armor', pierce: 'pierces armor', evasive: 'evasive', drain: 'drains blood', heavy_swing: 'heavy swing', heavy_blow: 'heavy blow (armor cuts at most half)' };
  return (locale === 'en' ? en[a] : ja[a]) ?? a;
}

/** 思い出の戦闘情報の 1 行（look / recall で共用） */
export function memoryCombatText(locale: Locale, mem: MonsterMemory): string {
  const L = locale;
  const speed = mem.abilities.includes('fast') ? t(L, '速い', 'fast') : mem.abilities.includes('slow') ? t(L, '遅い', 'slow') : t(L, '普通（速さの違いは観測していない）', 'normal (no speed difference observed)');
  const ranged = mem.abilities.includes('ranged') ? t(L, `あり（観測した最長距離 ${mem.rangeMax ?? '?'}）`, `yes (longest seen ${mem.rangeMax ?? '?'})`) : t(L, '観測していない', 'not observed');
  // 記録が 5 体未満の間は、幅を確定値のように見せない（種族の体力はダイスで振られる。V3-3 の設計の指示）
  const few = !!mem.hpSeen && mem.hpSeen.samples < HP_RECORD_SURE;
  const hp = mem.hpSeen ? t(L, `${mem.hpSeen.min === mem.hpSeen.max ? mem.hpSeen.min : `${mem.hpSeen.min}〜${mem.hpSeen.max}`}（${mem.hpSeen.samples} 体${few ? '。個体差あり' : ''}）`, `${mem.hpSeen.min === mem.hpSeen.max ? mem.hpSeen.min : `${mem.hpSeen.min}-${mem.hpSeen.max}`} (${mem.hpSeen.samples} seen${few ? '; individuals vary' : ''})`) : t(L, '記録なし', 'none');
  const ab = mem.abilities.filter((a) => a !== 'fast' && a !== 'slow' && a !== 'ranged').map((a) => abilityName(L, a));
  // 種族の体力の記録は素の個体だけ（接辞付きは混ぜない）。守護者・強敵はこれより多い（V4-0b §1.5）
  const hpNote = mem.hpSeen && !mem.guardian ? t(L, '（これまでに見た素の個体の範囲。守護者と強敵はこれより多い）', ' (plain individuals seen so far; guardians and elites have more)') : '';
  // 継承（V3-7 §7.3・§16.2）: 前の潜る者の覚え書きを含む（自分で確かめた記録と区別する）
  const legacy = mem.legacy ? t(L, `（覚え書きより: 前の潜る者が ${mem.legacy.kills} 体倒した記録を含む。能力・体力・受けた最大ダメージ）`, ` (from the notes: includes a previous delver's record of ${mem.legacy.kills} slain — abilities, HP, worst hit)`) : '';
  return legacy + t(L,
    `遭遇${mem.encounters}回・撃破${mem.kills}回・速さ:${speed}・遠隔攻撃:${ranged}・受けた最大ダメージ${mem.maxDamageToYou}・与えた最大ダメージ${mem.maxDamageByYou}・体力の記録:${hp}${hpNote}${ab.length ? '・その他の能力:' + ab.join('、') : ''}`,
    `met ${mem.encounters}, killed ${mem.kills}, speed: ${speed}, ranged: ${ranged}, max dmg to you ${mem.maxDamageToYou}, max dmg by you ${mem.maxDamageByYou}, HP record: ${hp}${hpNote}${ab.length ? ', other: ' + ab.join(', ') : ''}`);
}

/** 通りの記録の文（「近接の通り 平均 2.5／13 回」） */
export function dealtText(L: Locale, d: ObsMonster['dealt']): string {
  if (!d) return '';
  const avg = (x: [number, number]) => { const a10 = Math.trunc((x[0] * 10) / Math.max(1, x[1])); return `${Math.trunc(a10 / 10)}.${a10 % 10}`; };
  const parts: string[] = [];
  if (d.melee) parts.push(t(L, `近接の通り 平均${avg(d.melee)}／${d.melee[1]}回`, `melee avg ${avg(d.melee)} over ${d.melee[1]}`));
  if (d.thrown) parts.push(t(L, `投擲の通り 平均${avg(d.thrown)}／${d.thrown[1]}回`, `thrown avg ${avg(d.thrown)} over ${d.thrown[1]}`));
  return parts.join(L === 'en' ? ', ' : '・');
}

/** 命中の記録の文（「あなたの命中 近接 1/6・相手の命中 3/5」） */
export function hitsText(L: Locale, h: ObsMonster['hits']): string {
  if (!h) return '';
  const parts: string[] = [];
  if (h.your_melee) parts.push(t(L, `あなたの命中 近接${h.your_melee[0]}/${h.your_melee[1]}`, `your hits melee ${h.your_melee[0]}/${h.your_melee[1]}`));
  if (h.your_thrown) parts.push(t(L, `${h.your_melee ? '投擲' : 'あなたの命中 投擲'}${h.your_thrown[0]}/${h.your_thrown[1]}`, `${h.your_melee ? 'thrown' : 'your hits thrown'} ${h.your_thrown[0]}/${h.your_thrown[1]}`));
  if (h.theirs) parts.push(t(L, `相手の命中 ${h.theirs[0]}/${h.theirs[1]}`, `its hits ${h.theirs[0]}/${h.theirs[1]}`));
  return parts.join(L === 'en' ? ', ' : '・');
}

const EXPLORED_JA: Record<number, string> = { 1: '約 1/4', 2: '約半分', 3: '約 3/4', 4: 'ほぼ全て' };
const EXPLORED_EN: Record<number, string> = { 1: 'about a quarter', 2: 'about half', 3: 'about three quarters', 4: 'nearly all' };

function effectiveSpeed(view: PlayerView, catalog: Catalog): number {
  return selfSpeed(view, catalog);
}

/** 休憩の上限（最大 HP の rest.capPct %）まで休んだ場合の見積もり（engine の回復処理と同じ式・同じ蓄積値で数える） */
export function restEstimate(view: PlayerView, catalog: Catalog, huntingVisible: boolean): RestEstimate | undefined {
  const me = view.self;
  const rules = catalog.rules;
  const limit = restCapHp(rules, me.stats.maxHp);
  const poisoned = me.statuses.some((s) => s.id === 'core:poison');
  if (me.stats.hp >= limit && !poisoned) return undefined;
  const interval = regenInterval(rules, me.level, boonHookSum(catalog.boons ?? {}, me.boons, 'regen', 'interval'));
  const mult = rules.regen.restMultiplier;
  let acc = me.regen;
  let hp = me.stats.hp;
  let turns = 0;
  const cap = Math.max(rules.restMaxTurns, 1) * 10;
  // 毒: 残りの手番のあいだ毎手番 power のダメージ（rest は毒が抜けるまで続く）
  const poison = me.statuses.find((s) => s.id === 'core:poison');
  let poisonLeft = poison?.turnsLeft ?? 0;
  const poisonPower = Math.max(1, poison?.power ?? 1);
  let lowest = hp;
  while ((hp < limit || poisonLeft > 0) && turns < cap) {
    if (poisonLeft > 0) { hp -= poisonPower; poisonLeft--; lowest = Math.min(lowest, hp); }
    if (hp <= 0) break;
    const r = regenStep(acc, hp, limit, mult, interval);
    acc = r.acc;
    hp += r.heal;
    turns++;
  }
  const delay = Math.max(1, floorDiv(100 * 100, effectiveSpeed(view, catalog)));
  const time = turns * delay;
  let wander = '0';
  if (!view.floor?.noWander) {
    const lo = floorDiv(time, rules.wander.intervalMax);
    const hi = ceilDiv(time, rules.wander.intervalMin);
    wander = lo === hi ? `${lo}` : `${lo}〜${hi}`;
  }
  const est: RestEstimate = { hp_to_full: Math.max(0, limit - me.stats.hp), cap_hp: limit, turns, time, wander_expected: wander, ...(poison ? { lowest_hp: lowest } : {}) };
  if (huntingVisible) est.blocked_by = 'hostile_hunting';
  else if (me.statuses.some((s) => s.id === 'core:poison')) est.blocked_by = 'poisoned';
  return est;
}

export interface ChaseEstimate {
  /** 記録のある敵だけの最悪の被害（記録の無い敵がいても下限として使える） */
  recordedWorst: number;
  worst: number;
  /** 自分の歩く速さより速い近接の敵の数 */
  catchers: number;
  shooters: number;
}

/** 階段まで steps 歩く間の最悪の被害（V3-4b §28.5）: 敵ごとに「歩く間の攻撃回数 × 受けた最大の一撃」の合計 */
export function chaseEstimate(view: PlayerView, catalog: Catalog, hunters: readonly ObsMonster[], steps: number): ChaseEstimate {
  let worst = 0, catchers = 0, shooters = 0;
  for (const m of hunters) {
    const e = view.entities.find((x) => x.id === m.id);
    if (!e) continue;
    const ranged = m.traits.includes('ranged');
    if (ranged) shooters++;
    const extra = chaseAttacks(view, catalog, e, steps, { ranged, adjacent: false });
    if (!ranged && extra > 0) catchers++;
    const hits = chaseAttacks(view, catalog, e, steps, { ranged, adjacent: m.dist <= 1 });
    const mem = memoryOf(view, e);
    if (mem && mem.maxDamageToYou > 0) worst += hits * mem.maxDamageToYou;
  }
  return { recordedWorst: worst, worst, catchers, shooters };
}

/** 節目の文（「次の節目: 地下5階の大守護者「呼び集める者ヴォルン」（型: 呼び集める者・突き進む者。未踏破）」） */
/** いまの持ち物で、その装甲に 1 回に通るダメージの目安（近接の武器と、持っている投擲物。急所狙いの分を引く。V3-3b §40.1） */
export function gearVsArmorText(L: Locale, catalog: Catalog, view: PlayerView, armor: number, hp?: number): string {
  const parts: string[] = [];
  const me = view.self;
  // 体力が分かっていれば、倒すのに要る命中の数（平均で。V3-3c §44.2）
  const hits = (r: { min: number; max: number }) => (hp !== undefined && r.max > 0 ? t(L, `（およそ ${Math.trunc((hp * 2 + Math.max(1, r.min + r.max) - 1) / Math.max(1, r.min + r.max))} 回の命中）`, ` (~${Math.trunc((hp * 2 + Math.max(1, r.min + r.max) - 1) / Math.max(1, r.min + r.max))} hits)`) : '');
  const melee = damageRangeVs(me.stats.dmg, me.stats.might, armor);
  const wid = view.inventory.find((i) => i.equipped === 'weapon');
  const wname = wid ? itemDisplayName(catalog, L, wid.kind, wid.appearanceId, wid.affixes) : t(L, '素手', 'bare hands');
  parts.push(`${wname} ${melee.min}〜${melee.max}${hits(melee)}`);
  let pierce = 0;
  let arm = 0;
  for (const id of me.build.perks) { pierce += catalog.perks[id]?.thrownPierce ?? 0; arm += catalog.perks[id]?.thrownDmg ?? 0; }
  const seen = new Set<string>();
  for (const it of view.inventory) {
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    if (!ci || ci.category !== 'throwing' || !ci.throwStats?.dmg || seen.has(it.kind!)) continue;
    seen.add(it.kind!);
    const r = damageRangeVs(ci.throwStats.dmg, arm, Math.max(0, armor - pierce));
    parts.push(`${nameOf(ci.name, L, it.kind!)} ${r.min}〜${r.max}${hits(r)}`);
  }
  return t(L, `いまの持ち物で 1 回に通る目安: ${parts.join('・')}（会心・型の効果を除く）`, `per hit with your gear: ${parts.join(', ')} (before crits and type effects)`);
}

export function milestoneObs(L: Locale, catalog: Catalog, m: { depth: number; name: Names; title?: Names; types: string[] }, cleared: readonly number[], intel?: { weakness?: string; hp?: number; maxHit?: number; armor?: number }, view?: PlayerView): ObsMilestone {
  const name = guardianDisplayName(L, m);
  const types = m.types.map((id) => ({ id, name: nameOf(catalog.guardianTypes[id]?.name, L, id) }));
  const done = cleared.includes(m.depth);
  // 候補の数は、まだ持っていない加護の数まで（V3-7 の評価: 「3 つの候補」と出て 2 つだった）
  const unowned = Object.keys(catalog.boons ?? {}).filter((id) => !(view?.self.boons ?? []).includes(id)).length;
  const opts = Math.min(catalog.rules?.milestone?.boonOptions ?? 3, Math.max(1, unowned || (catalog.rules?.milestone?.boonOptions ?? 3)));
  // 記録庫が返した記憶（V3-3a §35.7）
  const mem = [
    intel?.weakness ? t(L, `弱点 ${nameOf(catalog.guardianWeaknesses[intel.weakness]?.name, L, intel.weakness)}${intel.weakness === 'core:weak_sleep' ? '（キャンプの後は眠りに戻る）' : ''}`, `weakness: ${nameOf(catalog.guardianWeaknesses[intel.weakness]?.name, L, intel.weakness)}${intel.weakness === 'core:weak_sleep' ? ' (back asleep after camp)' : ''}`) : '',
    intel?.hp !== undefined ? t(L, `体力およそ ${intel.hp}・一撃 ${intel.maxHit} まで（重い一撃: 装甲で減っても ${ceilDiv(intel.maxHit ?? 0, 2)} より下がらない）`, `about ${intel.hp} HP, hits up to ${intel.maxHit} (heavy blow: armor cannot bring it below ${ceilDiv(intel.maxHit ?? 0, 2)})`) : '',
    intel?.armor !== undefined ? t(L, `装甲 ${intel.armor}`, `armor ${intel.armor}`) : '',
  ].filter(Boolean);
  // 装甲が分かっていれば、いまの持ち物で通る目安（V3-3b §40.1）
  const gear = intel?.armor !== undefined && view && !cleared.includes(m.depth) ? t(L, `。${gearVsArmorText(L, catalog, view, intel.armor, intel.hp)}`, `; ${gearVsArmorText(L, catalog, view, intel.armor, intel.hp)}`) : '';
  const memText = mem.length ? t(L, `。記録庫の記憶: ${mem.join('・')}${gear}`, `; the archive remembers: ${mem.join(', ')}${gear}`) : '';
  return {
    depth: m.depth, name, types, cleared: done,
    ...(intel && (intel.weakness || intel.hp !== undefined) ? { memory: { ...(intel.weakness ? { weakness: intel.weakness } : {}), ...(intel.hp !== undefined ? { hp: intel.hp, max_hit: intel.maxHit } : {}), ...(intel.armor !== undefined ? { armor: intel.armor } : {}) } } : {}),
    text: t(L, `次の節目: 地下${m.depth}階の大守護者「${name}」（型: ${types.map((x) => x.name).join('・') || 'なし'}。${done ? '踏破済み' : `未踏破。倒すまでその階の下り階段は封じられている。倒すと加護を ${opts} つの候補から 1 つ選べる`}${memText}）`,
      `Next milestone: the warden "${name}" on depth ${m.depth} (types: ${types.map((x) => x.name).join('/') || 'none'}; ${done ? 'cleared' : `not cleared; its stairs down stay sealed until it falls; slay it to choose 1 of ${opts} boons`}${memText})`),
  };
}

/** 加護の一覧（V3-3 §3.3）。遠征に 1 回の加護（執念）は、進行中の遠征で使っていれば used */
export function boonsOf(view: PlayerView, catalog: Catalog, L: Locale): ObsBoon[] {
  const xNo = view.expedition && view.expedition.status !== 'ended' ? view.expedition.no : null;
  return (view.self.boons ?? []).map((id) => {
    const b = catalog.boons?.[id];
    const used = xNo !== null && view.self.boonUsed?.[id] === xNo;
    return { id, name: nameOf(b?.name, L, shortId(id)), desc: nameOf(b?.desc, L, ''), ...(used ? { used: true } : {}) };
  });
}

/** 加護の 1 行（「加護: 息吹（自然回復の間隔 −2）・鋼（装甲 +1）」） */
export function boonsText(L: Locale, boons: readonly ObsBoon[], brief = false): string {
  if (!boons.length) return t(L, '加護: なし（遺物を階段の上で持ち帰ると付く）', 'Boons: none (carry a relic out on stairs to gain one)');
  if (brief) return t(L, `加護: ${boons.map((b) => `${b.name}${b.used ? '（使った）' : ''}`).join('・')}`, `Boons: ${boons.map((b) => `${b.name}${b.used ? ' (used)' : ''}`).join(', ')}`);
  return t(L, `加護: ${boons.map((b) => `${b.name}（${b.desc}${b.used ? '。この遠征では使った' : ''}）`).join('・')}`,
    `Boons: ${boons.map((b) => `${b.name} (${b.desc}${b.used ? '; used this expedition' : ''})`).join(', ')}`);
}

/** 予備動作の文（V3-3 §3.1）。突進は向きと、自分がその直線の上にいるか（6 マス以内） */
function intentOf(L: Locale, e: EntityView, me: Pos | null): NonNullable<ObsMonster['intent']> {
  const it = e.intent!;
  if (it.kind === 'winding_up' && it.dir) {
    let on = false;
    if (me) for (let k = 1; k <= 6; k++) if (e.pos.x + DIR_VEC[it.dir][0] * k === me.x && e.pos.y + DIR_VEC[it.dir][1] * k === me.y) on = true;
    return { code: it.kind, dir: it.dir, on_line: on, text: t(L, `突進の構え（${DIR_JA[it.dir]}の直線。次の手番に突進する${on ? '。あなたは線の上にいる' : ''}）`, `bracing to charge (${it.dir} line; charges next turn${on ? '; you are on the line' : ''})`) };
  }
  if (it.kind === 'swinging' && it.pos) {
    const on = !!me && me.x === it.pos.x && me.y === it.pos.y;
    return { code: it.kind, pos: { ...it.pos }, on_line: on, text: t(L, `大振りの構え（次の手番に (${it.pos.x},${it.pos.y}) を 2 倍で打つ。外れると 1 手朦朧${on ? '。あなたはそのマスにいる' : ''}）`, `winding up a heavy swing (next turn it strikes (${it.pos.x},${it.pos.y}) for double; a miss stuns it for a turn${on ? '; you are on that cell' : ''})`) };
  }
  if (it.kind === 'summoning') return { code: it.kind, text: t(L, '手下を呼ぶ構え（次の手番に呼ぶ）', 'about to call minions (next turn)') };
  return { code: it.kind, text: t(L, '怒りの予兆（次の手番に速さと威力が上がる）', 'about to rage (faster and stronger next turn)') };
}

export function threatOf(view: PlayerView, e: EntityView): 1 | 2 | 3 | 4 | 5 | null {
  const mem = memoryOf(view, e);
  // 攻撃を受けた記録が無い種族は「不明（初見）」。深度からの推定で低く見せない（V3-2R §14.3）
  if (!mem || mem.maxDamageToYou <= 0) return null;
  let est = mem.maxDamageToYou;
  if (e.tier) est += e.tier * 2;
  if (e.affixes?.length) est += e.affixes.length;
  const hits = ceilDiv(Math.max(1, view.self.stats.hp), Math.max(1, est));
  let th = hits <= 1 ? 5 : hits <= 2 ? 4 : hits <= 4 ? 3 : hits <= 7 ? 2 : 1;
  if (e.awareness === 'asleep' && th > 1) th -= 1;
  return th as 1 | 2 | 3 | 4 | 5;
}

const ITEM_GLYPH: Record<string, string> = { potion: '!', scroll: '?', weapon: ')', armor: '[', throwing: '/', accessory: '"', relic: '$' };

function terrainGlyph(catalog: Catalog, id: string | undefined): string {
  if (!id) return ' ';
  const tr = catalog.terrain[id];
  if (!tr) return '?';
  if (tr.stairs === 'down') return '>';
  if (tr.stairs === 'up') return '<';
  if (tr.door === 'closed') return '+';
  if (tr.door === 'open') return "'";
  if (tr.tags.includes('water')) return '~';
  if (tr.tags.includes('tall_grass')) return '%';
  if (tr.tags.includes('grass')) return ',';
  if (!tr.passable) return tr.opaque ? '#' : '0';
  return '.';
}

function monsterGlyph(catalog: Catalog, kind: string | null): string {
  return (kind ? catalog.monsters[kind]?.glyph : undefined) ?? 'M';
}

function featureGlyph(catalog: Catalog, kind: string | null): string {
  if (!kind) return '*';
  const f = catalog.features[kind];
  if (f?.category === 'trap') return '^';
  if (kind.includes('fountain')) return '{';
  if (kind.includes('altar')) return '_';
  return '*';
}

function termName(catalog: Catalog, locale: Locale, id: string | undefined): string {
  return id ? nameOf(catalog.terrain[id]?.name, locale, id) : t(locale, '未知', 'unknown');
}

interface MapResult { origin: Pos; rows: string[]; legend: Record<string, string> }

/** 目盛り付きの地図テキスト（上に列番号の 10 の位と 1 の位、左に行番号） */
export function mapTextLines(map: MapResult): string[] {
  const width = Math.max(1, ...map.rows.map((r) => r.length));
  const lastY = map.origin.y + map.rows.length - 1;
  const pad = String(Math.max(lastY, 0)).length;
  const tens: string[] = [];
  const ones: string[] = [];
  for (let i = 0; i < width; i++) {
    const x = map.origin.x + i;
    tens.push(x % 10 === 0 || i === 0 ? String(Math.trunc(x / 10) % 10) : ' ');
    ones.push(String(x % 10));
  }
  const lead = ' '.repeat(pad + 1);
  const out = [lead + tens.join('').replace(/\s+$/, ''), lead + ones.join('')];
  map.rows.forEach((r, i) => out.push(`${String(map.origin.y + i).padStart(pad, ' ')} ${r}`));
  return out;
}

export function renderAsciiMap(view: PlayerView, catalog: Catalog, region: { x: number; y: number; w: number; h: number }): MapResult {
  const L = view.locale;
  const f = view.floor!;
  const legend: Record<string, string> = {};
  const addLegend = (ch: string, name: string) => {
    if (ch === ' ') return;
    const cur = legend[ch];
    if (!cur) legend[ch] = name;
    else if (!cur.split('/').includes(name)) legend[ch] = `${cur}/${name}`;
  };
  const overlay = new Map<number, { ch: string; name: string }>();
  for (const r of view.memory.remembered) {
    const i = r.pos.y * f.width + r.pos.x;
    if (r.cat === 'item') overlay.set(i, { ch: ITEM_GLYPH[itemCategory(catalog, r.kind, r.appearanceId)] ?? '*', name: itemDisplayName(catalog, L, r.kind, r.appearanceId) });
    else overlay.set(i, { ch: featureGlyph(catalog, r.kind), name: kindName(catalog, L, r.kind) });
  }
  const layerOrder: EntityView['cat'][] = ['feature', 'trap', 'item', 'monster', 'player'];
  for (const cat of layerOrder) {
    for (const e of view.entities) {
      if (e.cat !== cat) continue;
      const i = e.pos.y * f.width + e.pos.x;
      if (cat === 'item') overlay.set(i, { ch: ITEM_GLYPH[itemCategory(catalog, e.kind, e.appearanceId)] ?? '*', name: itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes) });
      else if (cat === 'feature' || cat === 'trap') overlay.set(i, { ch: featureGlyph(catalog, e.kind), name: kindName(catalog, L, e.kind) });
      else if (cat === 'monster') overlay.set(i, { ch: monsterGlyph(catalog, e.kind), name: kindName(catalog, L, e.kind) });
      else overlay.set(i, { ch: '&', name: e.name ?? t(L, '味方', 'ally') });
    }
  }
  if (view.self.pos) overlay.set(view.self.pos.y * f.width + view.self.pos.x, { ch: '@', name: t(L, '自分', 'you') });
  // フロア外の行と列は出さない（負の座標を表示しない）
  const x0 = Math.max(0, region.x), y0 = Math.max(0, region.y);
  const x1 = Math.min(f.width, region.x + region.w), y1 = Math.min(f.height, region.y + region.h);
  region = { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
  const rows: string[] = [];
  for (let y = region.y; y < region.y + region.h; y++) {
    let row = '';
    for (let x = region.x; x < region.x + region.w; x++) {
      const i = y * f.width + x;
      const ov = overlay.get(i);
      if (ov && view.memory.terrain[i]) {
        row += ov.ch;
        addLegend(ov.ch, ov.name);
        continue;
      }
      const tid = view.terrainTable[view.memory.terrain[i] ?? 0];
      const ch = view.memory.terrain[i] ? terrainGlyph(catalog, tid) : ' ';
      row += ch;
      if (ch !== ' ') addLegend(ch, termName(catalog, L, tid));
    }
    rows.push(row.replace(/\s+$/, ''));
  }
  return { origin: { x: region.x, y: region.y }, rows, legend };
}

export interface ObservationContext {
  grid: NavGrid | null;
  dist: Int32Array | null;
}

export function buildObservation(view: PlayerView, catalog: Catalog, opts: ObservationOptions): Observation {
  const L = view.locale;
  const me = view.self;
  const pos = me.pos;
  const f = view.floor;
  const grid = buildNavGrid(view, catalog);
  const dist = grid && pos ? distanceField(grid, pos, false) : null;
  const pathDist = (p: Pos): number => (dist && f ? dist[p.y * f.width + p.x] : -1);

  // 投げられる持ち物（射程が分かるもの。装備中は除く）
  // 強肩: 投擲のダメージの上乗せ（V3-3c §44.4）
  const armBonus = me.build.perks.reduce((a, id) => a + (catalog.perks[id]?.thrownDmg ?? 0), 0);
  const throwables = view.inventory
    .filter((it) => !it.equipped)
    .map((it) => ({ slot: it.slot, item: it, stats: itemStats(catalog, it.kind, it.affixes) }))
    .filter((x) => !!x.stats?.throw)
    .map((x) => ({ slot: x.slot, item: x.item, range: x.stats!.throw!.range, dmg: x.stats!.throw!.dmg && armBonus ? addDiceBonus(x.stats!.throw!.dmg, armBonus) : x.stats!.throw!.dmg, acc: x.stats!.throw!.acc }));
  const monsters: ObsMonster[] = [];
  const items: ObsItem[] = [];
  const players: ObsPlayer[] = [];
  const features: ObsFeature[] = [];
  const rel = (p: Pos) => ({ dir: pos ? compassDir(pos, p) : null, dist: pos ? cheb(pos, p) : 0 });
  // 敵の速さの表示は、加速・減速を除いた自分の速さと比べる（V3-3a §35.8: 加速中は普通のゴブリンが「遅い」と出た）
  const mySpeed = view.self.speed;
  const visibleOfKind = new Map<string, number>();
  for (const e of view.entities) if (e.cat === 'monster' && e.kind) visibleOfKind.set(e.kind, (visibleOfKind.get(e.kind) ?? 0) + 1);
  for (const e of view.entities) {
    if (e.cat === 'monster') {
      // 守護者は守護者の記録（種族の記録と分ける。V3-2R3 §20.4）
      const mem = memoryOf(view, e);
      const sp = monsterSpeedOf(catalog, e);
      const cm = e.kind ? catalog.monsters[e.kind] : undefined;
      const tags = cm?.tags ?? [];
      const m: ObsMonster = {
        id: e.id, name: monsterDisplayName(catalog, L, e), pos: e.pos, ...rel(e.pos),
        hp_state: e.hp ?? 'healthy', awareness: e.awareness ?? 'unaware', threat: threatOf(view, e),
        statuses: (e.statuses ?? []).map((s) => nameOf(catalog.statuses[s]?.name, L, s)),
        worst_hit: mem && mem.maxDamageToYou > 0 ? mem.maxDamageToYou : null,
        worst_turn: mem && mem.maxDamageToYou > 0 ? mem.maxDamageToYou * attacksPerTurn(view, catalog, e) : null,
        speed: sp === null || sp === mySpeed ? 'normal' : sp > mySpeed ? 'fast' : 'slow',
        ...(sp !== null && sp !== mySpeed && mySpeed > 0 ? { speed_ratio: Math.round((sp * 10) / mySpeed) / 10 } : {}),
        traits: [...OBVIOUS_TRAITS.filter((tr) => tags.includes(tr)), ...(cm?.armored ? ['armored' as const] : []), ...(cm?.evasive ? ['evasive' as const] : []), ...(e.guardian?.heavy ? ['heavy_blow' as const] : [])],
        shot: e.shot ? 'clear' : 'blocked',
        shots: throwables.map((tw) => ({ slot: tw.slot, state: !e.shot ? 'blocked' as const : pos && cheb(pos, e.pos) > tw.range ? 'out_of_range' as const : 'clear' as const })),
      };
      if (cm?.size === 'small' || cm?.size === 'large') m.size = cm.size;
      if (e.carries) { m.carries = e.carries; m.carries_name = kindName(catalog, L, e.carries); }
      // 本当に初めて見た種族: 撃破が無く、遭遇した個体の数がいま見えている数以下
      // 守護者は記録を分けるが、同じ種族の通常の個体を見たことがあれば初見ではない（V3-3 後の AI 評価）
      const baseMem = e.role === 'guardian' && e.kind ? view.monsterMemory[e.kind] : undefined;
      if ((!mem || (mem.kills === 0 && mem.encounters <= (visibleOfKind.get(e.kind ?? '') ?? 0))) && !(baseMem && (baseMem.kills > 0 || baseMem.encounters > 0))) m.first_seen = true;
      if (mem?.dmgByYou?.melee || mem?.dmgByYou?.thrown) {
        m.dealt = {
          ...(mem.dmgByYou?.melee ? { melee: [...mem.dmgByYou.melee] as [number, number] } : {}),
          ...(mem.dmgByYou?.thrown ? { thrown: [...mem.dmgByYou.thrown] as [number, number] } : {}),
        };
      }
      if (mem?.hitsByYou?.melee || mem?.hitsByYou?.thrown || mem?.hitsOnYou) {
        m.hits = {
          ...(mem.hitsByYou?.melee ? { your_melee: [...mem.hitsByYou.melee] as [number, number] } : {}),
          ...(mem.hitsByYou?.thrown ? { your_thrown: [...mem.hitsByYou.thrown] as [number, number] } : {}),
          ...(mem.hitsOnYou ? { theirs: [...mem.hitsOnYou] as [number, number] } : {}),
        };
      }
      if (e.role) m.role = e.role;
      if (e.objective) m.objective = true;
      if (e.named) m.named = nameOf(e.named, L, '?');
      if (e.bounty) m.bounty = e.bounty;
      if (e.fleeing) m.fleeing = true;
      if (e.damageSeen) m.damage_seen = e.damageSeen;
      // 守護者の呼び名・型・分かった弱点、予備動作（V3-3 §3.1）
      if (e.guardian) {
        const w = e.guardian.weakness;
        m.guardian = {
          name: guardianDisplayName(L, e.guardian),
          types: e.guardian.types.map((id) => ({ id, name: nameOf(catalog.guardianTypes[id]?.name, L, id) })),
          ...(w ? { weakness: { id: w, name: nameOf(catalog.guardianWeaknesses[w]?.name, L, w) } } : {}),
          ...(e.guardian.warden ? { warden: true } : {}),
          ...(e.guardian.notWeak?.length ? { not_weak: e.guardian.notWeak.map((id) => ({ id, name: nameOf(catalog.guardianWeaknesses[id]?.short ?? catalog.guardianWeaknesses[id]?.name, L, id) })) } : {}),
        };
      }
      if (e.intent) m.intent = intentOf(L, e, pos);
      // 推定残り HP（守護者は守護者の体力の記録から）
      // 守護者は出さない（格で体力の上乗せが違い、別の守護者の記録では読み違える。V3-3 後の AI 評価）
      const est = e.role === 'guardian' ? undefined : hpLeftEstimate(mem, m.hp_state, e.damageSeen ?? 0, catalog.rules?.estimateMinSamples ?? 5);
      if (est) m.hp_left_est = est;
      monsters.push(m);
    } else if (e.cat === 'item') {
      const name = itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes);
      // 同じセルの同種の物は 1 行にまとめる
      const same = items.find((x) => !x.remembered && x.pos.x === e.pos.x && x.pos.y === e.pos.y && x.name === name && x.role === e.role && !!x.mine === !!e.mine);
      if (same) {
        same.qty += e.qty ?? 1;
        same.ids = [...(same.ids ?? [same.id]), e.id];
        continue;
      }
      const it: ObsItem = { id: e.id, name, pos: e.pos, ...rel(e.pos), qty: e.qty ?? 1 };
      if (e.role) it.role = e.role;
      if (e.objective) it.objective = true;
      if (e.mine) it.mine = true;
      if (e.value !== undefined) it.value = e.value;
      items.push(it);
    } else if (e.cat === 'player') {
      players.push({ id: e.id, name: e.name ?? '?', pos: e.pos, ...rel(e.pos), hp_state: e.hp ?? 'healthy' });
    } else {
      features.push({ id: e.id, type: e.kind ?? 'feature', name: kindName(catalog, L, e.kind), pos: e.pos, ...rel(e.pos), state: e.state, ...(e.lair ? { lair: guardianDisplayName(L, e.lair) } : {}) });
    }
  }
  monsters.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  items.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  // 記憶しているアイテム（視界外）
  const visibleIds = new Set(view.entities.map((e) => e.id));
  const rememberedItems: ObsItem[] = [];
  for (const r of view.memory.remembered) {
    if (visibleIds.has(r.id)) continue;
    if (r.cat === 'item') {
      const it: ObsItem = { id: r.id, name: itemDisplayName(catalog, L, r.kind, r.appearanceId), pos: r.pos, ...rel(r.pos), qty: r.qty, remembered: true };
      if (r.role) it.role = r.role;
      if (r.objective) it.objective = true;
      if (r.mine) it.mine = true;
      if (r.value !== undefined) it.value = r.value;
      rememberedItems.push(it);
    }
    if (r.cat !== 'item') features.push({ id: r.id, type: r.kind ?? 'feature', name: kindName(catalog, L, r.kind), pos: r.pos, ...rel(r.pos), state: r.state, ...(r.lair ? { lair: guardianDisplayName(L, r.lair) } : {}) });
  }
  // 記憶の中のアイテムは近い順に 3 件まで（遺物は常に出す）。戦闘中（追跡中の敵が見えている間）は出さない。残りは件数だけ（V3-2R §14.2）
  rememberedItems.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
  const inCombat = monsters.some((m) => m.awareness === 'hunting' && !m.fleeing);
  const cap = inCombat ? 0 : 3;
  let itemsOmitted = 0;
  let shown = 0;
  for (const it of rememberedItems) {
    if ((it.role && !inCombat) || shown < cap) {
      const same = items.find((x) => x.remembered && x.pos.x === it.pos.x && x.pos.y === it.pos.y && x.name === it.name && !!x.mine === !!it.mine);
      if (same) { same.qty += it.qty; same.ids = [...(same.ids ?? [same.id]), it.id]; continue; }
      items.push(it);
      if (!it.role) shown++;
    } else itemsOmitted++;
  }
  // 自分が投げた物（見えている・記憶）は 1 行にまとめる: 本数と最寄りの位置（V3-2R2 §18.5）。記憶の件数制限とは別に出す
  {
    const mineAll = [...items.filter((i) => i.mine)];
    for (const r of view.memory.remembered) {
      if (r.cat !== 'item' || !r.mine || visibleIds.has(r.id) || mineAll.some((x) => x.id === r.id || x.ids?.includes(r.id))) continue;
      mineAll.push({ id: r.id, name: itemDisplayName(catalog, L, r.kind, r.appearanceId), pos: r.pos, ...rel(r.pos), qty: r.qty, remembered: true, mine: true });
    }
    if (mineAll.length > 1) {
      mineAll.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
      const near = mineAll[0];
      const names = new Set(mineAll.map((i) => i.name));
      const merged: ObsItem = {
        id: near.id, ids: mineAll.flatMap((i) => i.ids ?? [i.id]), name: names.size === 1 ? near.name : t(L, '自分が投げた物', 'your thrown items'),
        pos: near.pos, dir: near.dir, dist: near.dist, qty: mineAll.reduce((a, i) => a + i.qty, 0), near_qty: near.qty, mine: true,
        ...(mineAll.every((i) => i.remembered) ? { remembered: true } : {}),
      };
      for (let i = items.length - 1; i >= 0; i--) if (items[i].mine) items.splice(i, 1);
      items.push(merged);
      items.sort((a, b) => a.dist - b.dist || (a.id < b.id ? -1 : 1));
    }
  }

  // 足元
  let here = '';
  const passable_dirs: Dir[] = [];
  const known_stairs: Observation['navigation']['known_stairs'] = [];
  let frontiers: Observation['navigation']['frontiers'] = [];
  let onStairs: 'up' | 'down' | null = null;
  if (f && pos && grid) {
    const hereIdx = pos.y * f.width + pos.x;
    const hereT = view.terrainTable[view.memory.terrain[hereIdx]];
    onStairs = catalog.terrain[hereT]?.stairs ?? null;
    const hereItems = view.entities.filter((e) => e.cat === 'item' && e.pos.x === pos.x && e.pos.y === pos.y);
    const hereFeat = view.entities.filter((e) => (e.cat === 'feature' || e.cat === 'trap') && e.pos.x === pos.x && e.pos.y === pos.y);
    here = [termName(catalog, L, hereT),
      ...hereFeat.map((e) => kindName(catalog, L, e.kind)),
      ...hereItems.map((e) => itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes) + ((e.qty ?? 1) > 1 ? ` x${e.qty}` : ''))].join(', ');
    for (const d of DIRS) {
      const nx = pos.x + DIR_VEC[d][0];
      const ny = pos.y + DIR_VEC[d][1];
      if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
      if (grid.passable[ny * f.width + nx]) passable_dirs.push(d);
    }
    // 封じられた下り階段（大守護者を倒していない節目の階。V4-1a §12.4。判定は stairsSealed 1 つ）
    const sealedDown = stairsSealed(catalog.rules?.milestone, view.floor?.depth ?? 0, view.milestonesCleared ?? []);
    for (let i = 0; i < view.memory.terrain.length; i++) {
      const tid = view.terrainTable[view.memory.terrain[i]];
      const st = catalog.terrain[tid]?.stairs;
      if (!st) continue;
      const p = { x: i % f.width, y: Math.trunc(i / f.width) };
      const dd = pathDist(p);
      const occ = view.entities.find((e) => e.cat === 'monster' && e.pos.x === p.x && e.pos.y === p.y && e.id !== view.self.id);
      known_stairs.push({ type: st, pos: p, dist: dd >= 0 ? dd : cheb(pos, p), reachable: dd >= 0, path_len: dd >= 0 ? dd : null, ...(occ ? { occupied_by: occ.id } : {}), ...(st === 'down' && sealedDown ? { sealed: true as const } : {}) });
    }
    known_stairs.sort((a, b) => a.dist - b.dist);
    const fr = findFrontiers(grid)
      .map((i) => ({ pos: { x: i % f.width, y: Math.trunc(i / f.width) }, d: dist ? dist[i] : -1 }))
      .filter((x) => x.d >= 0)
      .sort((a, b) => a.d - b.d || a.pos.y - b.pos.y || a.pos.x - b.pos.x);
    // 近接したフロンティアは間引く
    const picked: typeof fr = [];
    for (const c of fr) {
      if (picked.some((p) => cheb(p.pos, c.pos) <= 3)) continue;
      picked.push(c);
      if (picked.length >= 5) break;
    }
    frontiers = picked.map((c) => ({ pos: c.pos, dir: dirTo(pos, c.pos), dist: c.d }));
  }

  // アラート
  const alerts: Alert[] = [];
  const hpPct = me.stats.maxHp > 0 ? Math.trunc((me.stats.hp * 100) / me.stats.maxHp) : 0;
  const hostiles = monsters;
  const adjacent = hostiles.filter((m) => m.dist === 1);
  if (view.status === 'dead') alerts.push({ code: 'dead', text: t(L, 'あなたは死亡している', 'You are dead') });
  if (hpPct < 25) alerts.push({ code: 'critical_hp', text: t(L, `HP が危険域 (${me.stats.hp}/${me.stats.maxHp})`, `HP critical (${me.stats.hp}/${me.stats.maxHp})`) });
  else if (hpPct < 50) alerts.push({ code: 'low_hp', text: t(L, 'HP が半分以下', 'HP below half') });
  if (adjacent.length) {
    alerts.push({
      code: 'enemy_adjacent',
      text: t(L, '敵が隣接: ', 'Adjacent enemy: ') + adjacent.map((m) => `${m.name}(${dirLabel(L, m.dir)})`).join(', '),
      entity: adjacent[0].id,
    });
  }
  // 自分に届く追跡中の敵（逃走中は隣にいるときだけ: 追い詰められると殴る。動かない敵は隣にいるときだけ）
  // 致死の警告に添える回復の手段（V3-7a 後の評価: 薬と立て直しを残したまま綱や瀕死になった）
  const potionN = view.inventory.filter((i) => i.kind === 'core:potion_healing').reduce((a, i) => a + (i.qty ?? 1), 0);
  const healAbility = view.self.build.abilities.map((a) => ({ a, def: catalog.abilities[a.id] })).find((x) => x.def?.handler === 'heal_pct');
  const healReady = healAbility ? abilityStatus(view, catalog, healAbility.a.id) : null;
  const heals = [potionN ? t(L, `回復の薬 ${potionN}`, `${potionN} healing potions`) : '', healAbility && healReady && healReady.cooldownLeft === 0 && healReady.usesLeft !== 0 ? t(L, `${nameOf(healAbility.def!.name, L, healAbility.a.id)} 使える`, `${nameOf(healAbility.def!.name, L, healAbility.a.id)} ready`) : ''].filter(Boolean);
  const healNote = heals.length ? t(L, `（${heals.join('・')}）`, ` (${heals.join(', ')})`) : '';
  const huntingReach = hostiles.filter((m) => m.awareness === 'hunting' && (!m.fleeing || m.dist === 1) && !(m.traits.includes('stationary') && m.dist > 1));
  // 階段まで steps 歩く間の最悪の被害（V3-4b §28.5）: 敵ごとに「攻撃できる回数 × 受けた最大の一撃」。記録の無い敵がいれば null
  const chaseOf = (steps: number) => chaseEstimate(view, catalog, huntingReach, steps);
  // 1 手番あたりの最悪の被害（worst_hit × 行動の回数。V3-2R3 §20.4）で群れの見込みと致死を計算する
  const recorded = huntingReach.filter((m) => m.worst_turn !== null);
  const worstSum = recorded.reduce((a, m) => a + m.worst_turn!, 0);
  const unrecorded = huntingReach.length - recorded.length;
  if (huntingReach.length >= 2 && view.status !== 'dead') {
    // 群れ全体の被害見込み（思い出の記録だけから。V3-2R2 §18.2）
    alerts.push({
      code: 'incoming',
      text: t(L, `追跡中 ${huntingReach.length} 体。1 手の最悪の被害の合計 ${worstSum}${unrecorded ? `、ほかに記録のない ${unrecorded} 体` : ''}。あなたの HP ${me.stats.hp}`,
        `${huntingReach.length} hunting you. Worst damage per turn sums to ${worstSum}${unrecorded ? `, plus ${unrecorded} with no record` : ''}. Your HP ${me.stats.hp}`),
      data: { hunting: huntingReach.length, worst_sum: worstSum, unrecorded, hp: me.stats.hp },
    });
  } else if (hostiles.length && !adjacent.length) alerts.push({ code: 'enemy_in_view', text: t(L, `敵が視界内: ${hostiles[0].name}`, `Enemy in view: ${hostiles[0].name}`), entity: hostiles[0].id });
  // 1 手で倒されうる: 1 体の worst_turn、または合計が今の HP 以上。2 手で倒されうる: 合計の 2 倍が HP 以上
  const lethal = huntingReach.filter((m) => m.worst_turn !== null && m.worst_turn >= me.stats.hp);
  if (lethal.length && view.status !== 'dead') {
    alerts.push({ code: 'lethal_range', text: t(L, `1 手で倒されうる: ${lethal.map((m) => `${m.name}(最悪 ${m.worst_turn})`).join(', ')}${healNote}`, `One turn could kill you: ${lethal.map((m) => `${m.name} (worst ${m.worst_turn})`).join(', ')}${healNote}`), entity: lethal[0].id });
  } else if (recorded.length >= 2 && worstSum >= me.stats.hp && view.status !== 'dead') {
    alerts.push({ code: 'lethal_range', text: t(L, `1 手で倒されうる: 追跡中の敵の 1 手の最悪の被害の合計 ${worstSum} ≥ HP ${me.stats.hp}${healNote}`, `One turn could kill you: worst damage per turn of hunting enemies sums to ${worstSum} >= HP ${me.stats.hp}${healNote}`), entity: recorded[0].id });
  } else if (recorded.length && worstSum * 2 >= me.stats.hp && view.status !== 'dead') {
    alerts.push({ code: 'lethal_2turns', text: t(L, `2 手で倒されうる: 1 手の最悪の被害 ${worstSum} × 2 ≥ HP ${me.stats.hp}`, `Two turns could kill you: worst damage per turn ${worstSum} x 2 >= HP ${me.stats.hp}`), entity: recorded[0].id });
  }
  // 見えていない相手に撃たれた（草の中の射手など）: 最悪の被害の見立ては見えている敵からなので、入っていないと言う（V4-0c §4.3）
  if (opts.unseenShots?.length && view.status !== 'dead') {
    const dirs = [...new Set(opts.unseenShots)].map((d) => dirLabel(L, d)).join(L === 'en' ? ', ' : '・');
    alerts.push({ code: 'unseen_shooter', text: t(L, `見えていない相手に撃たれている（${dirs}から）。最悪の被害の見立てに入っていない`, `Shot by something you cannot see (from ${dirs}); it is not in the worst-damage estimates`) });
  }
  if (me.statuses.some((s) => s.id === 'core:poison')) alerts.push({ code: 'poisoned', text: t(L, '毒に冒されている', 'You are poisoned') });
  if (onStairs) alerts.push({ code: 'on_stairs', text: onStairs === 'down' ? t(L, '下り階段の上にいる', 'You are on stairs down') : t(L, '上り階段の上にいる', 'You are on stairs up') });
  // 予備動作（V3-3 §3.1）: 見えている敵が次の手番に大きな行動を取る
  for (const m of hostiles) if (m.intent) alerts.push({ code: 'intent', text: t(L, `予備動作: ${m.guardian?.name ?? m.name}が${m.intent.text}`, `Intent: ${m.guardian?.name ?? m.name} is ${m.intent.text}`), entity: m.id, data: { kind: m.intent.code, ...(m.intent.dir ? { dir: m.intent.dir } : {}), ...(m.intent.on_line !== undefined ? { on_line: m.intent.on_line } : {}) } });
  const itemsHere = items.filter((i) => i.dist === 0 && !i.remembered);
  if (itemsHere.length) alerts.push({ code: 'item_here', text: t(L, '足元にアイテム: ', 'Item here: ') + itemsHere.map((i) => i.name).join(', ') });
  const carried = view.inventory.filter((i) => !(i.kind && catalog.items[i.kind]?.bound)).length;
  if (carried >= me.capacity) alerts.push({ code: 'inventory_full', text: t(L, '所持品がいっぱい', 'Inventory full') });
  // 逃げ道の見込み（V3-2R2 §18.1）: 追跡中の敵が見えていて、既知の階段に辿り着けるとき
  if (huntingReach.length && !onStairs && view.status !== 'dead') {
    const st = known_stairs.filter((s) => s.path_len !== null).sort((a, b) => a.path_len! - b.path_len! || (a.type === 'up' ? -1 : 1))[0];
    if (st) {
      // いまの自分の速さ（加速を含む）と比べる（V3-7 の評価: 加速中なのに「あなたより速い」と出た）
      const eff = selfSpeed(view, catalog);
      const faster = huntingReach.filter((m) => (m.speed_ratio ?? 1) * view.self.speed > eff).length;
      alerts.push({
        code: 'escape',
        text: t(L, `${st.type === 'up' ? '上り' : '下り'}階段まで ${st.path_len} 歩。${faster ? `追ってくる敵のうち ${faster} 体はあなたより速い` : '追ってくる敵にあなたより速いものはいない'}（階段の上なら extract できる・階を移れば敵は追ってこない）${st.occupied_by ? `。ただし階段の上に ${(hostiles.find((m) => m.id === st.occupied_by)?.name ?? st.occupied_by)} がいて、ふさがれている` : ''}`,
          `${st.path_len} steps to the stairs ${st.type}. ${faster ? `${faster} of your pursuers are faster than you` : 'none of your pursuers is faster than you'} (on stairs you can extract; enemies do not follow you between floors)${st.occupied_by ? `. But ${(hostiles.find((m) => m.id === st.occupied_by)?.name ?? st.occupied_by)} stands on the stairs and blocks them` : ''}`),
        // worst_if_chased: 追われたままなら最悪の被害（敵ごとに歩く間の攻撃回数 × 受けた最大の一撃。記録の無い敵がいれば null。V3-4b §28.5）
        data: { stairs: st.type, path_len: st.path_len, faster, worst_if_chased: unrecorded ? null : chaseOf(st.path_len!).worst, hp: me.stats.hp },
      });
    }
  }
  if ((opts.recent ?? []).some((e) => e.type === 'entity_changed_floor' && (e.event as any).id === me.id)) {
    alerts.push({ code: 'new_floor', text: t(L, '新しい階に到着した', 'Arrived on a new floor') });
  }

  // 自分
  const equipName = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const it = view.inventory.find((i) => i.id === id);
    return it ? itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes) : undefined;
  };
  const invItems: ObsInvItem[] = view.inventory.map((it) => {
    const st = itemStats(catalog, it.kind, it.affixes);
    const curse = isCursedItem(catalog, it.affixes) ? 'cursed' as const : curseUnknown(catalog, it) ? 'unknown' as const : undefined;
    return {
      slot: it.slot, name: itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes), qty: it.qty,
      category: itemCategory(catalog, it.kind, it.appearanceId), identified: it.kind !== null, equipped: it.equipped !== null,
      ...(it.kind ? { kind: shortId(it.kind) } : {}),
      ...(!it.kind && it.appearanceId && view.clues?.[it.appearanceId] ? { clue: clueText(L, catalog, view, view.clues[it.appearanceId]) } : {}),
      ...(it.value !== undefined ? { value: it.value } : {}),
      ...(st ? { stats: st } : {}),
      ...(curse ? { curse } : {}),
    };
  });
  const invBrief = invItems.map((i) => {
    const st = itemStatsText(L, i.stats, catalog);
    const cu = i.curse === 'cursed' ? t(L, '{呪い:外せない}', '{cursed}') : i.curse === 'unknown' ? t(L, '{呪い?}', '{curse?}') : '';
    // 投げられる物には種類 ID（fight の with に使う）
    const kd = i.stats?.throw && i.kind && !i.equipped ? `{with:${i.kind}}` : '';
    const cl = i.clue ? t(L, `{手がかり:${i.clue}}`, `{clue: ${i.clue}}`) : '';
    return `${i.slot})${i.name}${i.qty > 1 ? `x${i.qty}` : ''}${i.equipped ? '*' : ''}${i.value !== undefined ? `(${i.value})` : ''}${st ? `[${st}]` : ''}${kd}${cl}${cu}`;
  }).join(' ');

  const biomeName = f ? nameOf(catalog.biomes[f.biome]?.name, L, f.biome) : '';
  // 休息の判定（engine と同じ）: 追跡中（逃走中を除く）の敵。動かない敵は隣接していなければ数えない
  const stationaryIds = new Set(view.entities.filter((e) => e.cat === 'monster' && isStationary(catalog, e)).map((e) => e.id));
  const restBlocked = hostiles.some((m) => m.awareness === 'hunting' && !m.fleeing && !(stationaryIds.has(m.id) && m.dist > 1));
  const rest = restEstimate(view, catalog, restBlocked);

  // 遠征
  let expedition: ObsExpedition | undefined;
  const xv = view.expedition;
  if (xv) {
    const active = xv.status !== 'ended' && view.status !== 'at_camp';
    // 階段の上なら追跡中の敵が見えていても extract できる（V3-2R2 §18.1）
    const blocked: ObsExpedition['extract_blocked_by'] = !active ? 'ended' : view.status !== 'your_turn' ? 'not_your_turn' : !onStairs ? 'not_on_stairs' : undefined;
    const prog: ObsExpedition['progress'] = { depth: f?.depth ?? null, target_depth: xv.objective.targetDepth };
    if (xv.objective.type === 'reach_depth') prog.reached = xv.progress.reached;
    if (xv.objective.type === 'slay_guardian' || xv.objective.type === 'slay_warden') prog.guardian_slain = xv.progress.guardianSlain;
    if (xv.objective.type === 'retrieve_relic') prog.relic_held = xv.progress.relicHeldByYou;
    const extractText = blocked === undefined ? t(L, 'extract: 可', 'extract: possible')
      : blocked === 'ended' ? '' : t(L, `extract: 不可(${EXTRACT_BLOCK_JA[blocked]})`, `extract: not now (${blocked})`);
    const statusText = xv.status === 'objective_complete' ? t(L, '目的達成済み', 'objective complete') : xv.status === 'ended' ? t(L, '終了', 'ended') : t(L, '進行中', 'in progress');
    expedition = {
      no: xv.no,
      objective: { type: xv.objective.type, target_depth: xv.objective.targetDepth, text: objectiveText(L, xv.objective) },
      progress: prog, status: xv.status, points: xv.points,
      can_extract: blocked === undefined,
      // engine の wouldComplete と同じ規則（遺物は自分が持っていること）
      extract_outcome: xv.status === 'objective_complete' && (xv.objective.type !== 'retrieve_relic' || xv.progress.relicHeldByYou) ? 'complete' : 'withdraw',
      text: [t(L, `【遠征${xv.no}】${objectiveText(L, xv.objective)}`, `[Expedition ${xv.no}] ${objectiveText(L, xv.objective)}`), statusText, progressText(L, xv, f?.depth ?? null), extractText].filter(Boolean).join(' | '),
    };
    if (blocked !== undefined) expedition.extract_blocked_by = blocked;
    // 守護者（V3-3 §3.1）: 名前・型・分かった弱点。生きている間は【遠征】の行に「守護者「名」（弱点: …）」
    if (xv.guardian) {
      const g = xv.guardian;
      const w = g.weakness;
      expedition.guardian = {
        name: guardianDisplayName(L, g),
        types: g.types.map((id) => ({ id, name: nameOf(catalog.guardianTypes[id]?.name, L, id) })),
        ...(w ? { weakness: { id: w, name: nameOf(catalog.guardianWeaknesses[w]?.name, L, w) } } : {}),
      };
      if (active && !xv.progress.guardianSlain) {
        // 節目に挑む遠征: 試して分かる前でも、記録庫の記憶で分かっていればそれを出す（V3-7a 後の評価: 状況行だけ「不明」だった）
        const mem = xv.objective.type === 'slay_warden' && xv.objective.targetDepth !== null ? view.wardenIntel?.[String(xv.objective.targetDepth)]?.weakness : undefined;
        const wt = expedition.guardian.weakness ? expedition.guardian.weakness.name
          : mem ? t(L, `${nameOf(catalog.guardianWeaknesses[mem]?.name, L, mem)}（記録庫の記憶）`, `${nameOf(catalog.guardianWeaknesses[mem]?.name, L, mem)} (archive memory)`) : t(L, '不明', 'unknown');
        expedition.text += t(L, ` | 守護者「${expedition.guardian.name}」（弱点: ${wt}）`, ` | guardian "${expedition.guardian.name}" (weakness: ${wt})`);
      }
    }
    // 次の節目（V3-3 §3.2）: 戦利品の行の近くに常に出す
    if (xv.milestone) {
      expedition.milestone = milestoneObs(L, catalog, xv.milestone, view.milestonesCleared ?? [], view.wardenIntel?.[String(xv.milestone.depth)], view);
      if (active) expedition.text += ` | ${expedition.milestone.cleared ? t(L, `節目: 地下${expedition.milestone.depth}階 踏破済み`, `milestone: depth ${expedition.milestone.depth} cleared`) : t(L, `次の節目: 地下${expedition.milestone.depth}階の大守護者「${expedition.milestone.name}」（未踏破）`, `next milestone: warden "${expedition.milestone.name}" on depth ${expedition.milestone.depth} (not cleared)`)}`;
    }
    if (xv.result) expedition.result = { ...xv.result, text: resultText(L, xv, catalog.rules) };
    if (xv.slot) expedition.slot = xv.slot;
    if (xv.traits.length) expedition.traits = [...xv.traits];
    // 護りの火の手がかり（V3-3c §44.6）
    if (view.wardHints?.length && active) {
      expedition.ward_fires = view.wardHints.map((h) => {
        const nm = guardianDisplayName(L, h.guardian);
        return { guardian: nm, dir: h.dir, range: h.range, text: t(L, `まだ見ていない護りの火（${nm}）: ${DIR_JA[h.dir]}・${h.range === 'near' ? '近い（10 マス以内）' : '遠い'}`, `unseen ward fire (${nm}): ${h.dir}, ${h.range === 'near' ? 'near (within 10)' : 'far'}`) };
      });
    }
    if (view.sense && active) {
      const sv = view.sense;
      const who = sv.what === 'relic' ? t(L, '遺物', 'The relic') : t(L, '守護者', 'The guardian');
      expedition.sense = {
        ...sv,
        text: t(L, `気配: ${who}は${DIR_JA[sv.dir]}・${sv.range === 'near' ? '近い（10 マス以内）' : '遠い'}`, `Sense: ${who.toLowerCase()} lies ${sv.dir}, ${sv.range === 'near' ? 'near (within 10)' : 'far'}`),
      };
    }
    if (active && catalog.rules?.haul) {
      const treasure = view.inventory.reduce((a, i) => a + (i.value ?? 0), 0);
      const parts: HaulParts = {
        objective: xv.status === 'objective_complete' ? xv.points : 0,
        overreach: overreachPoints(catalog.rules, xv.objective.targetDepth, xv.crossedDepth, xv.points),
        treasure, bounty: xv.haul.bounty, discovery: xv.haul.discovery, kills: xv.haul.kills,
      };
      const total = haulTotal(parts);
      const ifNow = payoutOf(catalog.rules, parts, expedition.extract_outcome === 'complete', xv.multiplierPct);
      // 帰還の綱を持っていれば、今使った場合の確定点（目的を除く戦利品の lifeline.pct %。V3-4b §28.1）
      const hasLifeline = view.inventory.some((i) => !!i.kind && !!catalog.items[i.kind]?.bound);
      const ifLifeline = hasLifeline ? payoutOf(catalog.rules, parts, expedition.extract_outcome === 'complete', xv.multiplierPct, true) : undefined;
      const nx = nextOverreach(catalog.rules, xv.objective.targetDepth, xv.crossedDepth, xv.points);
      let next: NonNullable<ObsExpedition['haul']>['next_overreach'] = null;
      let nextText = '';
      if (nx) {
        // 今いる階が次の踏破の階なら、既知の下り階段までの経路長（未発見なら下への風の方角）
        const here = f?.depth === nx.depth;
        const down = here ? known_stairs.filter((s) => s.type === 'down' && s.path_len !== null).sort((a, b) => a.path_len! - b.path_len!)[0] : undefined;
        const draft = here && !down ? view.floorHint?.draft ?? undefined : undefined;
        next = { depth: nx.depth, points: nx.points, at: 'stairs_down', path_len: down ? down.path_len : null, ...(draft ? { dir: draft } : {}) };
        const where = here ? (down ? t(L, `（経路 ${down.path_len}）`, ` (path ${down.path_len})`) : draft ? t(L, `（未発見・下への風は${DIR_JA[draft]}）`, ` (not found yet; the draft blows ${draft})`) : t(L, '（未発見）', ' (not found yet)')) : '';
        // 節目の階で大守護者が生きていれば、下り階段は封じられている（V3-3 後の AI 評価）
        const sealedNx = stairsSealed(catalog.rules?.milestone, nx.depth, view.milestonesCleared ?? []);
        const sealNote = sealedNx ? t(L, '（大守護者を倒すまで封じられている）', ' (sealed until the warden falls)') : '';
        nextText = t(L, ` / 地下${nx.depth}階の下り階段に着けば +${nx.points}${where}${sealNote}`, ` / reach the down stairs of depth ${nx.depth} for +${nx.points}${where}${sealNote}`);
      }
      // 次の候補の下限は「目標として達成した最深の階」から（踏破しても深くならない。V3-2R3 §20.2）
      const reachedCamp = expedition.extract_outcome === 'complete' && xv.objective.targetDepth !== null ? Math.max(view.campDepth, xv.objective.targetDepth) : view.campDepth;
      const nc = catalog.rules.recommendedLevel ? nextCampOf(catalog.rules, reachedCamp, view.milestonesCleared ?? []) : null;
      const campText = nc ? t(L, ` / 帰ると次の候補は地下${nc.minTargetDepth}階以上（推奨 Lv${nc.recommendedLevel}）`, ` / next offers from depth ${nc.minTargetDepth} (recommended Lv${nc.recommendedLevel})`) : '';
      // 綱は目的の点を運ばない。遺物を持っていれば失う（V3-4b §28.1）
      const relicNote = xv.objective.type === 'retrieve_relic' && xv.progress.relicHeldByYou ? t(L, '（遺物は失う）', ' (the relic is lost)') : '';
      const lifeText = ifLifeline !== undefined ? t(L, `・綱なら +${ifLifeline}${relicNote}`, `, lifeline +${ifLifeline}${relicNote}`) : '';
      expedition.haul = {
        total, multiplier_pct: xv.multiplierPct, parts, if_extract_now: ifNow, ...(ifLifeline !== undefined ? { if_lifeline_now: ifLifeline } : {}), next_overreach: next,
        next_camp: nc ? { min_target_depth: nc.minTargetDepth, recommended_level: nc.recommendedLevel } : null,
        text: t(L,
          `戦利品 ${total}（${partsText(L, parts) || 'なし'}）${expedition.extract_outcome === 'complete' ? multText(xv.multiplierPct) : `撤退なら ${catalog.rules.haul.withdrawPct}%（目的を除く）`} → 今帰れば +${ifNow}${lifeText}${nextText}${campText} / 確定済み ${view.record.banked}`,
          `haul ${total} (${partsText(L, parts) || 'none'}) ${expedition.extract_outcome === 'complete' ? multText(xv.multiplierPct) : `withdraw ${catalog.rules.haul.withdrawPct}% without objective`} → extract now +${ifNow}${lifeText}${nextText}${campText} / banked ${view.record.banked}`),
      };
    }
  }
  let camp: ObsCamp | undefined;
  if (view.camp) {
    const rules = catalog.rules;
    camp = {
      ...(view.camp.milestone ? { milestone: milestoneObs(L, catalog, view.camp.milestone, view.milestonesCleared ?? [], view.wardenIntel?.[String(view.camp.milestone.depth)], view) } : {}),
      ...(opts.campCompare && view.status === 'at_camp' ? { compare: { no: opts.campCompare.no, lines: opts.campCompare.lines.slice(0, 2), ...(opts.campCompare.compare ?? {}) } } : {}),
      ...(opts.versionNote && view.status === 'at_camp' ? { version_note: opts.versionNote } : {}),
      ...(opts.records && view.status === 'at_camp' ? { records: { line: opts.records.line, ...(opts.records.featsNew?.length ? { feats_new: [...opts.records.featsNew] } : {}) } } : {}),
      // 記録庫に納めた欠片の数（V3-3a §35.7）
      archive: { delivered: view.archive?.length ?? 0, total: Object.values(catalog.items).filter((it) => it.category === 'relic' && it.boon).length },
      next_no: view.camp.nextNo,
      offers: view.camp.offers.map((o) => ({
        index: o.index, type: o.objective.type, target_depth: o.objective.targetDepth, points: o.points,
        ...(o.rechallenge ? { rechallenge: { no: o.rechallenge.no } } : {}),
        text: offerText(L, o, rules ? { rules, level: me.level } : undefined) + (opts.offerNotes?.[o.index] ? ` / ${opts.offerNotes[o.index]}` : '') + ((): string => {
          // 遺物を納めると、記録庫が次の節目の番人の記憶を 1 つ返す（V3-3a §35.7）
          const msd = view.camp?.milestone?.depth;
          if (!o.relic || msd === undefined) return '';
          const kn = view.wardenIntel?.[String(msd)] ?? {};
          const left = 2 - (kn.weakness ? 1 : 0) - (kn.hp !== undefined ? 1 : 0);
          return left > 0 ? t(L, ` / 納めると、記録庫が地下${msd}階の番人の記憶を 1 つ返す（残り ${left}）`, ` / delivering it makes the archive recall one memory of the depth-${msd} keeper (${left} left)`) : '';
        })() + (o.bounty ? ` / ${gearVsArmorText(L, catalog, view, o.bounty.armor, Math.max(1, o.bounty.hp - (o.scar ?? 0)))}` : '')
          // 守護者の候補（格 1〜3。再挑戦を含む）にも通る目安（V3-8a §56.1。大守護者は記録庫の記憶の装甲で出す）
          + (o.guardian?.armor !== undefined && o.objective.type !== 'slay_warden' ? ` / ${gearVsArmorText(L, catalog, view, o.guardian.armor, o.guardian.hp !== undefined ? Math.max(1, o.guardian.hp - (o.scar ?? 0)) : undefined)}` : ''),
        ...(o.bounty ? { bounty: { kind: o.bounty.kind, name: nameOf(o.bounty.name, L, ''), hp: o.bounty.hp, ...(o.bounty.hpRange ? { hp_range: { ...o.bounty.hpRange } } : {}), max_hit: o.bounty.maxHit } } : {}),
        ...(o.vault ? { vault: true } : {}), ...(o.scar ? { scar: o.scar } : {}),
        ...(o.slot ? { slot: o.slot } : {}), ...(o.traits?.length ? { traits: [...o.traits] } : {}),
        ...(o.floorTraits?.length ? { floor_traits: o.floorTraits.map((g) => ({ trait: g.trait, name: floorTraitsText(L, rules, [g.trait], false), depths: [...g.depths] })) } : {}),
        ...(o.guardian ? { guardian: {
          rank: o.guardian.rank, traits: [...o.guardian.traits], ...(o.guardian.armor !== undefined ? { armor: o.guardian.armor } : {}),
          ...(o.guardian.hp !== undefined ? { hp: o.guardian.hp } : {}), ...(o.guardian.hpRange ? { hp_range: { ...o.guardian.hpRange } } : {}),
        } } : {}),
        ...(o.relic ? { relic: {
          kind: o.relic.kind, name: nameOf(o.relic.name, L, o.relic.kind), boon: o.relic.boon,
          ...(o.relic.boonName ? { boon_name: nameOf(o.relic.boonName, L, '') } : {}), ...(o.relic.boonDesc ? { boon_desc: nameOf(o.relic.boonDesc, L, '') } : {}),
          ...(o.relic.owned ? { owned: true } : {}),
        } } : {}),
        multiplier_pct: o.multiplierPct ?? 100,
        ...((): { recommended_level: number | null; level_gap: number | null; trait_danger: number } => {
          if (!rules?.recommendedLevel) return { recommended_level: null, level_gap: null, trait_danger: 0 };
          const g = offerGap(rules, o.objective.targetDepth, o.traits ?? [], me.level, offerWardenExtra(o));
          return { recommended_level: g.recommendedLevel, level_gap: g.levelGap, trait_danger: g.traitDanger };
        })(),
      })),
    };
  }
  if (view.status === 'at_camp') alerts.unshift({ code: 'at_camp', text: t(L, 'キャンプにいる（盤面にいない）', 'You are at camp (off the board)') });
  if (expedition?.can_extract && expedition.extract_outcome === 'complete') alerts.push({ code: 'can_extract', text: t(L, 'この場で extract すると帰還（達成）になる', 'extract here completes the expedition') });

  // 自分を攻撃している相手（投擲の候補で優先する）
  const attackers = new Set<string>();
  for (const e of opts.recent ?? []) {
    const ev = e.event as Record<string, unknown>;
    if (e.type === 'attack' && ev.target === me.id && typeof ev.attacker === 'string') attackers.add(ev.attacker);
  }
  // ビルド（V3-4）: 特技・能動技・特技の候補
  const bonuses = accBonuses(view, catalog);
  const rankCount = new Map<string, number>();
  for (const id of view.self.build.perks) rankCount.set(id, (rankCount.get(id) ?? 0) + 1);
  const perksList = [...rankCount].map(([id, ranks]) => ({ id, name: nameOf(catalog.perks[id]?.name, L, shortId(id)), ranks }));
  const abilitiesList: Observation['self']['abilities'] = view.self.build.abilities.map((a) => {
    const st = abilityStatus(view, catalog, a.id);
    const def = catalog.abilities[a.id];
    return { id: shortId(a.id), name: nameOf(def?.name, L, shortId(a.id)), cooldown_left: st.cooldownLeft, ...(st.usesLeft !== null ? { uses_left: st.usesLeft } : {}), target: def?.target ?? 'none' };
  });
  const offer = perkChoice(view);
  const lineageName = (lid: string) => {
    if (lid === 'common') return t(L, '共通', 'common');
    const l = catalog.classes[view.self.classId]?.lineages?.find((x) => x.id === lid);
    return l ? nameOf(l.name, L, lid) : lid;
  };
  const perkChoiceObs = offer ? {
    level: offer.level,
    options: offer.options.map((id, i) => ({ option: i + 1, id, name: nameOf(catalog.perks[id]?.name, L, shortId(id)), desc: nameOf(catalog.perks[id]?.desc, L, ''), lineage: lineageName(catalog.perks[id]?.lineage ?? '') })),
    more: view.self.build.pending.length - 1,
  } : undefined;
  // 加護の候補（大守護者を倒した。V3-3 §3.2）
  const bc = view.self.boonChoice;
  const boonChoiceObs = bc ? { depth: bc.depth, options: bc.options.map((id, i) => ({ option: i + 1, id, name: nameOf(catalog.boons?.[id]?.name, L, shortId(id)), desc: nameOf(catalog.boons?.[id]?.desc, L, '') })) } : undefined;
  if (boonChoiceObs && view.status !== 'dead' && view.status !== 'ended') {
    alerts.push({
      code: 'boon_pending',
      text: t(L, `加護を選べる（地下${bc!.depth}階の大守護者）: ${boonChoiceObs.options.map((o) => `${o.option} ${o.name}`).join(' / ')}（choose_boon。手番は使わない）`,
        `Boon to choose (warden of depth ${bc!.depth}): ${boonChoiceObs.options.map((o) => `${o.option} ${o.name}`).join(' / ')} (choose_boon; takes no turn)`),
      data: { depth: bc!.depth, options: [...bc!.options] },
    });
  }
  if (perkChoiceObs && view.status !== 'dead' && view.status !== 'ended') {
    alerts.push({
      code: 'perk_pending',
      text: t(L, `特技を選べる（Lv${offer!.level}）: ${perkChoiceObs.options.map((o) => `${o.option} ${o.name}`).join(' / ')}（choose_perk。手番は使わない）`,
        `Perk to choose (Lv${offer!.level}): ${perkChoiceObs.options.map((o) => `${o.option} ${o.name}`).join(' / ')} (choose_perk; takes no turn)`),
      data: { level: offer!.level, options: [...offer!.options], more: perkChoiceObs.more },
    });
  }
  const mineCount = items.filter((i) => i.mine).reduce((a, i) => a + i.qty, 0);
  const pickables = pickableItems(view, catalog).length;
  const collectIds = collectTargets(view, catalog);
  const valid_actions = buildValidActions(view, catalog, {
    passable_dirs, onStairs, itemsHere: itemsHere.length > 0, relicHere: itemsHere.some((i) => i.role === 'relic'), hostiles, frontiers: frontiers.length, known_stairs, grid,
    canExtract: expedition?.can_extract ?? false, objectiveComplete: expedition?.extract_outcome === 'complete', restTurns: rest && !rest.blocked_by ? rest.turns : null,
    attackers, mineCount, pickables, collectable: collectIds.length, huntingReach, worstSum, unrecorded, chaseOf, lifelineShort: !!opts.lifelineShort,
    draft: view.floorHint?.draft ?? null,
    ifLifeline: expedition?.haul?.if_lifeline_now,
    perkChoice: perkChoiceObs, boonChoice: boonChoiceObs, abilities: abilitiesList, bonuses,
  });

  const statusLabel: Record<ViewStatus, [string, string]> = {
    your_turn: ['あなたの番', 'your turn'], waiting_others: ['他プレイヤー待ち', 'waiting for others'], dead: ['死亡', 'dead'], ended: ['ラン終了', 'run ended'],
    at_camp: ['キャンプ', 'at camp'],
  };
  const summaryParts = [
    f ? t(L, `地下${f.depth}階 ${biomeName}`, `Depth ${f.depth} ${biomeName}`) : '',
    `HP ${me.stats.hp}/${me.stats.maxHp}`,
    `Lv${me.level}`,
    hostiles.length ? t(L, `敵${hostiles.length}体が視界内`, `${hostiles.length} enemies in view`) : t(L, '敵影なし', 'no enemies in view'),
    statusLabel[view.status][L === 'en' ? 1 : 0],
  ].filter(Boolean);

  const obs: Observation = {
    seq: view.seq,
    status: view.status,
    summary: summaryParts.join(' | '),
    alerts,
    self: {
      name: me.name, class: kindName(catalog, L, me.classId), level: me.level, xp: me.xp, xp_next: xpForLevel(me.level),
      hp: me.stats.hp, max_hp: me.stats.maxHp,
      statuses: me.statuses.map((s) => ({ id: s.id, name: nameOf(catalog.statuses[s.id]?.name, L, s.id), turns_left: s.turnsLeft })),
      pos, floor: f ? {
        depth: f.depth, biome_name: biomeName, floor_type: nameOf(catalog.floorTypes[f.floorType]?.name, L, f.floorType), floor_type_id: f.floorType, time: f.time,
        ...(view.floorEvent ? { event_text: nameOf(view.floorEvent, L, '') } : {}),
        ...(f.traits?.length ? { traits: [...f.traits], trait_text: floorTraitsText(L, catalog.rules, f.traits) } : {}),
        ...(view.floorHint?.draft ? { draft: view.floorHint.draft } : {}),
        ...(view.floorHint ? { explored: view.floorHint.explored } : {}),
        ...(view.floorHint ? {
          hint_text: [
            t(L, `探索 ${EXPLORED_JA[view.floorHint.explored]}`, `explored ${EXPLORED_EN[view.floorHint.explored]}`),
            view.floorHint.draft ? t(L, `下への風: ${DIR_JA[view.floorHint.draft]}`, `draft toward the way down: ${view.floorHint.draft}`) : '',
          ].filter(Boolean).join(L === 'en' ? ', ' : '・'),
        } : {}),
      } : null,
      attack: {
        acc: me.stats.acc + bonuses.melee, dmg: `${me.stats.dmg}${me.stats.might ? (me.stats.might > 0 ? `+${me.stats.might}` : `${me.stats.might}`) : ''}`,
        ...(throwables.length ? { throws: throwables.map((tw) => ({ slot: tw.slot, ...(tw.item.kind ? { kind: shortId(tw.item.kind) } : {}), name: itemDisplayName(catalog, L, tw.item.kind, tw.item.appearanceId, tw.item.affixes), dmg: tw.dmg, acc: me.stats.acc + tw.acc + bonuses.thrown, range: tw.range })) } : {}),
      },
      // 装甲は状態異常（錆）の修正込み（V3-5a）
      defense: { eva: me.stats.eva, armor: armorWithStatuses(catalog.statuses, me.statuses, me.stats.armor) },
      equipment: { weapon: equipName(me.equip.weapon), armor: equipName(me.equip.armor), accessory: equipName(me.equip.accessory) },
      inventory_count: carried, inventory_capacity: me.capacity,
      turns: me.turns,
      speed: effectiveSpeed(view, catalog),
      score: { banked: view.record.banked, expeditions_completed: view.record.expeditions },
      perks: perksList,
      abilities: abilitiesList,
      recovery: recoveryOf(view, catalog, L),
      ...(perkChoiceObs ? { perk_choice: perkChoiceObs } : {}),
      boons: boonsOf(view, catalog, L),
      ...(opts.boonsShort ? { boons_brief: true } : {}),
      ...(boonChoiceObs ? { boon_choice: boonChoiceObs } : {}),
    },
    visible: { monsters, items, players, features, ...(itemsOmitted ? { items_omitted: itemsOmitted } : {}) },
    navigation: { here, passable_dirs, frontiers, known_stairs, collectable: { count: collectIds.length, ids: collectIds }, ...(view.memory.unsighted?.length ? { unsighted: view.memory.unsighted.length } : {}) },
    recent_events: (opts.recent ?? []).map((e) => e.text).filter((s) => s.length > 0).slice(-10),
    valid_actions,
  };
  if (rest && rest.blocked_by !== 'hostile_hunting') obs.self.rest_estimate = rest;
  if (expedition) obs.expedition = expedition;
  if (camp) obs.camp = camp;
  if (opts.detail === 'full') obs.self.inventory = invItems;
  else obs.self.inventory_brief = invBrief;
  if (opts.map && f && pos) {
    const w = opts.mapWidth ?? 21;
    const h = opts.mapHeight ?? 15;
    obs.map = renderAsciiMap(view, catalog, { x: pos.x - Math.trunc(w / 2), y: pos.y - Math.trunc(h / 2), w, h });
  }
  return obs;
}

const EXTRACT_BLOCK_JA: Record<string, string> = { not_on_stairs: '階段の上ではない', not_your_turn: '手番ではない', ended: '終了済み' };

interface VAInput {
  lifelineShort?: boolean;
  passable_dirs: Dir[]; onStairs: 'up' | 'down' | null; itemsHere: boolean; relicHere?: boolean; hostiles: ObsMonster[]; pickables: number;
  /** 引数なしの collect が拾いに行く品の数（V4-1a §12.1） */
  collectable: number;
  frontiers: number; known_stairs: Observation['navigation']['known_stairs']; grid: NavGrid | null;
  canExtract: boolean; objectiveComplete: boolean; restTurns: number | null;
  /** 自分を攻撃している相手 */
  attackers: Set<string>;
  /** 既知の「自分が投げた物」の数 */
  mineCount: number;
  /** 自分に届く追跡中の敵と、記録の最大被害の合計・記録の無い数 */
  huntingReach: ObsMonster[]; worstSum: number; unrecorded: number;
  /** 階段まで steps 歩く間の最悪の被害（V3-4b §28.5） */
  chaseOf: (steps: number) => ChaseEstimate;
  /** 帰還の綱を今使った場合の確定点 */
  ifLifeline?: number;
  /** 下への風（今いる階の下り階段が未発見のとき） */
  draft: Dir | null;
  /** ビルド（V3-4） */
  perkChoice?: Observation['self']['perk_choice'];
  /** 加護の候補（V3-3 §3.2） */
  boonChoice?: Observation['self']['boon_choice'];
  abilities: Observation['self']['abilities'];
  bonuses: { melee: number; thrown: number };
}

/** 能動技の振る舞い（短い ID からも引く） */
function abilityHandlerOf(catalog: Catalog, id: string): string | undefined {
  return Object.entries(catalog.abilities).find(([k]) => k === id || k.endsWith(`:${id}`))?.[1].handler;
}

function buildValidActions(view: PlayerView, catalog: Catalog, x: VAInput): string[] {
  const L = view.locale;
  const out: string[] = [];
  // 特技の候補（手番を消費しない。V3-4 §4.1）
  const perkLines = [
    ...(x.boonChoice?.options ?? []).map((o) => `choose_boon ${o.option} (${o.name}: ${o.desc})`),
    ...(x.perkChoice?.options ?? []).map((o) => `choose_perk ${o.option} (${o.name}: ${o.desc})`),
  ];
  if (view.status === 'at_camp') {
    if (!view.camp) return [...perkLines, 'wait_for_turn'];
    return [
      ...perkLines,
      ...view.camp.offers.map((o) => `start_expedition ${o.index} (${objectiveText(L, o.objective)})`),
      'start_expedition endless', 'retire',
    ];
  }
  if (view.status !== 'your_turn' || !view.self.pos || !view.floor) return view.status === 'dead' || view.status === 'ended' ? [] : [...perkLines, 'wait_for_turn'];
  const pos = view.self.pos;
  const f = view.floor;
  const byPos = new Map<number, EntityView>();
  for (const e of view.entities) if (e.cat === 'monster' || e.cat === 'player') byPos.set(e.pos.y * f.width + e.pos.x, e);
  // 突進の構えの直線（6 マス以内）。自分が線の上にいれば、外れる向きの move に添える（V3-3b §40.7）
  const chargeLines = new Set<number>();
  for (const e of view.entities) {
    if (e.cat !== 'monster' || e.intent?.kind !== 'winding_up' || !e.intent.dir) continue;
    for (let k = 1; k <= 6; k++) {
      const lx = e.pos.x + DIR_VEC[e.intent.dir][0] * k, ly = e.pos.y + DIR_VEC[e.intent.dir][1] * k;
      if (lx >= 0 && ly >= 0 && lx < f.width && ly < f.height) chargeLines.add(ly * f.width + lx);
    }
  }
  // 大振りの的（V3-5b §44.7）: 構えたときに自分がいたマス。外れる一歩に印を付ける
  const swingCells = new Set<number>();
  for (const e of view.entities) if (e.cat === 'monster' && e.intent?.kind === 'swinging' && e.intent.pos) swingCells.add(e.intent.pos.y * f.width + e.intent.pos.x);
  const onSwing = swingCells.has(pos.y * f.width + pos.x);
  const onLine = chargeLines.has(pos.y * f.width + pos.x);
  for (const d of DIRS) {
    const nx = pos.x + DIR_VEC[d][0];
    const ny = pos.y + DIR_VEC[d][1];
    if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
    const i = ny * f.width + nx;
    const occ = byPos.get(i);
    if (occ?.cat === 'monster') { out.push(`move ${d} (${t(L, '攻撃', 'attack')}: ${monsterDisplayName(catalog, L, occ)})`); continue; }
    if (occ?.cat === 'player') { out.push(`move ${d} (${t(L, '位置交換', 'swap')}: ${occ.name})`); continue; }
    const tid = view.terrainTable[view.memory.terrain[i]];
    const tr = catalog.terrain[tid];
    if (tr?.door === 'closed') { out.push(`move ${d} (${t(L, '扉を開ける', 'open door')})`); continue; }
    if (x.passable_dirs.includes(d)) out.push(onLine && !chargeLines.has(i) ? `move ${d} (${t(L, '突進の直線から外れる', 'step off the charge line')})`
      : onSwing && !swingCells.has(i) ? `move ${d} (${t(L, '大振りの的から外れる', 'step out of the heavy swing')})` : `move ${d}`);
  }
  out.push('wait');
  const hunting = x.hostiles.some((m) => m.awareness === 'hunting' && !m.fleeing && !(isStationary(catalog, view.entities.find((e) => e.id === m.id) ?? { kind: null }) && m.dist > 1));
  if (view.self.stats.hp < view.self.stats.maxHp) {
    // 休憩で戻るのは最大 HP の rest.capPct % まで（V3-4b §28.3）
    const capPct = catalog.rules.restCapPct ?? 100;
    const capHp = restCapHp(catalog.rules, view.self.stats.maxHp);
    const poisoned = view.self.statuses.some((s) => s.id === 'core:poison');
    if (view.self.stats.hp >= capHp && !poisoned) out.push(`rest (${t(L, `不可: これ以上は休憩では戻らない（HP ${capPct}% まで）`, `unavailable: rest does not heal past ${capPct}% HP`)})`);
    else out.push(hunting ? `rest (${t(L, '不可: 追跡中の敵が見えている', 'unavailable: a hunting enemy is in view')})` : x.restTurns !== null ? `rest (${t(L, `休憩（HP ${capPct}% の ${capHp} まで）約${x.restTurns}手`, `rest to ${capHp} (${capPct}% HP) in ~${x.restTurns} turns`)})` : 'rest');
  }
  // 帰還する階段: 次の遠征はこの階段から始まる（V3-2R3 §20.6）。封じられた下り階段なら、次もこの大守護者の間から（V3-5a 後の AI 評価）
  const sealedHere = x.onStairs === 'down' && stairsSealed(catalog.rules?.milestone, view.floor?.depth ?? 0, view.milestonesCleared ?? []);
  const fromHere = sealedHere
    ? t(L, '・次の遠征はこの階の上り階段から始まる（封じられた下り階段なので）。階の敵は追跡をやめて全快する', '; the next expedition starts from this floor\'s stairs up (these stairs down are sealed); monsters stop hunting and heal fully')
    : t(L, '・次の遠征はこの階段から始まる。階の敵は追跡をやめて全快する', '; the next expedition starts from these stairs, where monsters stop hunting and heal fully');
  // 投げた物が床に残っている（V3-8 §53.3。止めはしない）
  const leftBehind = x.mineCount > 0 ? t(L, `・投げた物が ${x.mineCount} 個、この階の床に残っている`, `; ${x.mineCount} of your thrown items are still on this floor`) : '';
  if (x.canExtract) out.push(x.objectiveComplete ? `extract (${t(L, '帰還: 遠征達成', 'complete the expedition')}${fromHere}${leftBehind})` : `extract confirm:true (${t(L, '撤退: 未達成のまま終える', 'withdraw without the reward')}${fromHere}${leftBehind})`);
  // 移動マクロはその場で進める mode だけを出す（V3-2R §14.2）。隣に起きている敵がいれば careful では動かないので flee を出す
  const adjAwake = x.hostiles.filter((m) => m.dist <= 1 && m.awareness !== 'asleep' && !m.fleeing);
  // 既定の hp_floor の実数（steady・fight は最大 HP の 50%。V3-2R2 §18.5）
  const floor50 = Math.trunc((view.self.stats.maxHp * 50) / 100);
  const stopText = t(L, `HP ${floor50} 未満で止まる`, `stops below HP ${floor50}`);
  // 階段への移動の見込み（V3-2R3b §23.1）: 追跡中の敵が届くなら、歩数と「追われたままなら」の最悪の被害（歩数 × worst_turn の合計）。
  // 記録の無い敵がいれば「不明」
  const hpNow = view.self.stats.hp;
  const nearestStairs = (type?: 'down' | 'up') => x.known_stairs.filter((s) => (!type || s.type === type) && s.path_len !== null).sort((a, b) => a.path_len! - b.path_len!)[0];
  const stairsRisk = (type: 'down' | 'up'): string => {
    const st = x.huntingReach.length ? nearestStairs(type) : undefined;
    if (!st) return '';
    const n = st.path_len!;
    return x.unrecorded
      ? t(L, `階段まで ${n} 歩。追われたままなら最悪の被害は不明（記録のない敵がいる。HP ${hpNow}）`, `${n} steps to the stairs. If they keep chasing you, worst damage unknown (an enemy has no record; HP ${hpNow})`)
      : (() => {
        const c = x.chaseOf(n);
        return t(L, `階段まで ${n} 歩。追われたままなら最悪 ${c.worst} の被害（追いつけるのは ${c.catchers} 体・射撃 ${c.shooters} 体。HP ${hpNow}）`,
          `${n} steps to the stairs. If they keep chasing you, worst ${c.worst} damage (${c.catchers} can catch you, ${c.shooters} shooting; HP ${hpNow})`);
      })();
  };
  const stairsLine = (type: 'down' | 'up'): string => {
    // 最寄りの階段の上に敵がいる: travel_to はふさがれて止まる（V3-7a 後の評価: 「階段まで 1 歩」と勧めて blocked になった）
    const near = nearestStairs(type);
    if (near?.occupied_by) {
      const who = x.hostiles.find((h) => h.id === near.occupied_by)?.name ?? near.occupied_by;
      return `travel_to stairs_${type} (${t(L, `不可: 階段の上に ${who} がいる（倒すか、どくのを待つ）`, `unavailable: ${who} stands on the stairs (defeat it or wait for it to move)`)})`;
    }
    const risk = stairsRisk(type);
    const sep = t(L, '・', '; ');
    if (adjAwake.length) return `travel_to stairs_${type} mode:flee${risk ? ` (${risk})` : ''}`;
    if (x.huntingReach.length) return `travel_to stairs_${type} mode:steady (${stopText}${risk ? sep + risk : ''})`;
    return `travel_to stairs_${type}`;
  };
  // fight に載せられる能動技（強打・なぎ払い。使える手番ごとに使う。V3-4a §25.3）
  const meleeAb = x.abilities.filter((a) => { const h = abilityHandlerOf(catalog, a.id); return (h === 'strike' || h === 'cleave') && a.uses_left !== 0; });
  const abArg = meleeAb.length ? ` abilities:${meleeAb.map((a) => a.id).join(',')}` : '';
  const abNote = meleeAb.length ? t(L, `・${meleeAb.map((a) => `${a.name}${a.cooldown_left ? `(あと${a.cooldown_left})` : ''}`).join('・')}を使える手番に使う`, `, uses ${meleeAb.map((a) => `${a.name}${a.cooldown_left ? ` (in ${a.cooldown_left})` : ''}`).join(', ')} when ready`) : '';
  for (const m of x.hostiles.filter((h) => h.dist <= 1)) out.push(`fight ${m.id}${abArg} (${m.name}・${stopText}${abNote})`);
  // 群れ: 追跡中の敵が 2 体以上なら、倒したら次の相手へ続ける形（V3-4b §28.4）
  const pack = x.hostiles.filter((h) => h.awareness === 'hunting' && !h.fleeing).sort((a, b) => a.dist - b.dist);
  if (pack.length >= 2) out.push(`fight ${pack[0].id} until:clear${abArg} (${t(L, `追跡中の ${pack.length} 体と決着まで: 倒したら次の相手へ・${stopText}`, `settle all ${pack.length} hunters: next one after each kill, ${stopText}`)}${abNote})`);
  out.unshift(...perkLines);
  // 長柄: 直線で 2 マス先の敵を突ける（間のマスが通れて誰もいない。V3-4 §4.4）
  if (weaponReach(view, catalog) >= 2) {
    for (const m of x.hostiles) {
      if (m.dist !== 2) continue;
      const dx = m.pos.x - pos.x, dy = m.pos.y - pos.y;
      if ((dx !== 0 && Math.abs(dx) !== 2) || (dy !== 0 && Math.abs(dy) !== 2)) continue;
      const mid = { x: pos.x + Math.sign(dx), y: pos.y + Math.sign(dy) };
      const mi = mid.y * f.width + mid.x;
      const mt = catalog.terrain[view.terrainTable[view.memory.terrain[mi]]];
      if (!mt?.passable || mt.door === 'closed' || byPos.has(mi)) continue;
      out.push(`attack ${m.id} (${t(L, `${m.name} を 2 マス先から突く`, `strike ${m.name} from 2 cells`)})`);
    }
  }
  // 能動技（V3-4 §4.2）: 使えるものは対象付き、使えないものは残りの手番付き
  const adjFoes = x.hostiles.filter((h) => h.dist <= 1);
  for (const a of x.abilities) {
    const def = Object.entries(catalog.abilities).find(([k]) => k === a.id || k.endsWith(`:${a.id}`))?.[1];
    // 使い切った能動技は出さない（V3-3b §40.7。self.abilities の uses_left で分かる）
    if (a.uses_left === 0) continue;
    if (a.cooldown_left > 0) { out.push(`use_ability ${a.id} (${t(L, `${a.name}: あと ${a.cooldown_left} 手番`, `${a.name}: ready in ${a.cooldown_left} turns`)})`); continue; }
    const desc = def ? nameOf(def.desc, L, '') : '';
    if (a.target === 'adjacent') {
      for (const m of adjFoes.slice(0, 2)) out.push(`use_ability ${a.id} -> ${m.id} (${a.name}: ${m.name}・${desc})`);
    } else if (a.target === 'throw') {
      const tg = x.hostiles.filter((m) => m.shots.some((s) => s.state === 'clear')).sort((p1, p2) => Number(x.attackers.has(p2.id)) - Number(x.attackers.has(p1.id)) || p1.dist - p2.dist).slice(0, 2);
      for (const m of tg) out.push(`use_ability ${a.id} -> ${m.id} (${a.name}: ${m.name}${m.awareness !== 'hunting' ? t(L, '・気づいていないので会心', ', unaware: a critical hit') : ''}・${desc})`);
    } else if (a.target === 'dir') {
      // 身をかわす: 隣に起きている敵がいるときだけ、離れる向きを例に出す
      const near = adjFoes.find((m) => m.awareness !== 'asleep');
      if (near) {
        // 離れる向きはすべて 1 行に（V3-3 後の AI 評価: 2 つだけ出していたので、ほかの向きは使えないと読めた）
        const away = x.passable_dirs.filter((d) => { const v = DIR_VEC[d]; return cheb({ x: pos.x + v[0], y: pos.y + v[1] }, near.pos) > 1; });
        if (away.length) out.push(`use_ability ${a.id} <${away.join('|')}> (${a.name}: ${desc})`);
      }
    } else if (def && a.target === 'none') {
      if (def.handler === 'cleave') { if (adjFoes.length) out.push(`use_ability ${a.id} (${t(L, `${a.name}: 隣の ${adjFoes.length} 体`, `${a.name}: ${adjFoes.length} adjacent`)})`); }
      else if (def.handler !== 'heal_pct' || view.self.stats.hp < view.self.stats.maxHp) out.push(`use_ability ${a.id} (${a.name}: ${desc})`);
    }
  }
  // 迎え撃つ: 追跡中で届かない相手は、隣に来るまで待って戦う（最大 10 手番）。射撃する相手は待ち受けない（V3-2R3a §22.2）
  if (!adjAwake.length) {
    const comer = x.huntingReach.filter((m) => m.dist > 1 && !m.traits.includes('stationary') && !m.traits.includes('ranged'))[0];
    if (comer) out.push(`fight ${comer.id}${abArg} (${t(L, `${comer.name} を迎え撃つ: 隣に来るまで待つ・${stopText}`, `meet ${comer.name}: waits until it is adjacent, ${stopText}`)}${abNote})`);
    const shooter = x.huntingReach.filter((m) => m.dist > 1 && m.traits.includes('ranged'))[0];
    if (shooter) out.push(`travel_to ${shooter.id} (${t(L, `${shooter.name}: 近づく（寄られると下がり、下がる間は撃たない）／視線を切る`, `${shooter.name}: close in (it backs off when approached and does not shoot while backing off) / break line of sight`)})`);
  }
  if (!adjAwake.length) {
    if (x.frontiers > 0 || x.pickables > 0) out.push(x.pickables > 0 ? `explore (${t(L, `拾えるアイテム ${x.pickables} 個も拾う`, `also picks up ${x.pickables} items`)})` : 'explore');
    else out.push(`explore (${t(L, '不可: 探索済み・拾う物なし', 'unavailable: explored, nothing to pick up')})`);
    // 下への風の方角の未探索を優先する（V3-2R3 §20.5）
    if (x.frontiers > 0 && x.draft) out.push(`explore toward:draft (${t(L, `下への風の${DIR_JA[x.draft]}を優先`, `prefer the draft (${x.draft})`)})`);
    // 遺物・守護者の気配の方角の未探索を優先する（V3-4b §28.7）
    if (x.frontiers > 0 && view.sense) out.push(`explore toward:sense (${t(L, `${view.sense.what === 'relic' ? '遺物' : '守護者'}の気配の${DIR_JA[view.sense.dir]}を優先`, `prefer the ${view.sense.what} you sense (${view.sense.dir})`)})`);
  }
  // 既知の経路で届かない階段は「不可」と書く（V3-3 後の AI 評価: 出ていた travel_to が unreachable で断られた）
  const reachable = (type: 'down' | 'up') => x.known_stairs.some((s) => s.type === type && s.path_len !== null);
  const stairsOrNote = (type: 'down' | 'up') => (reachable(type) ? stairsLine(type) : `travel_to stairs_${type} (${t(L, '不可: 既知の経路では届かない。explore で道を探す', 'unavailable: no known path; explore to find one')})`);
  if (x.known_stairs.some((s) => s.type === 'down' && !(x.onStairs === 'down'))) out.push(stairsOrNote('down'));
  if (x.known_stairs.some((s) => s.type === 'up' && !(x.onStairs === 'up'))) out.push(stairsOrNote('up'));
  // 節目の階の下り階段は、大守護者を倒すまで封じられている（V3-3 §3.2）
  const sealed = stairsSealed(catalog.rules?.milestone, view.floor?.depth ?? 0, view.milestonesCleared ?? []);
  // 守護者に気づかれているときは、階を離れている間に守護者が回復することを添える（V3-3a §35.1）
  const guardWatch = x.hostiles.some((m) => m.role === 'guardian' && m.awareness === 'hunting') ? t(L, '。階を離れている間、守護者は回復する', '; guardians heal while you are away') : '';
  if (x.onStairs) out.push(x.onStairs === 'down' && sealed
    ? `use_stairs (${t(L, '不可: 下り階段は封じられている。この階の大守護者を倒すまで降りられない', 'unavailable: the stairs down are sealed until this floor\'s warden falls')})`
    : `use_stairs (${x.onStairs === 'down' ? t(L, '降りる', 'descend') : t(L, '上る', 'ascend')}${guardWatch}${x.mineCount > 0 ? t(L, `・投げた物が ${x.mineCount} 個、この階の床に残っている`, `; ${x.mineCount} of your thrown items are still on this floor`) : ''})`);
  if (x.itemsHere) out.push(x.relicHere ? `pickup (${t(L, '遺物を拾うと階が目覚める: 眠っている敵がすべて起き、遺物の場所へ向かう', 'picking up the relic wakes the floor: every sleeping enemy wakes and heads for it')})` : 'pickup');
  if (x.mineCount > 0 && !adjAwake.length) out.push(`collect (${t(L, `自分が投げた物 ${x.mineCount} 個を回収`, `pick up ${x.mineCount} thrown items`)})`);
  if (x.collectable > 0 && !adjAwake.length) out.push(`collect what:items (${t(L, `見えている・記憶したアイテム ${x.collectable} 個を拾って回る（${COLLECT_WITHIN} 歩以内。遺物は除く）`, `pick up ${x.collectable} known items (within ${COLLECT_WITHIN} steps; not the relic)`)})`);
  const throwGroups: { key: string; slots: string[]; targets: ObsMonster[] }[] = [];
  const lifelineLines: string[] = [];
  for (const it of view.inventory) {
    const name = itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes);
    const cat = itemCategory(catalog, it.kind, it.appearanceId);
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    const harmful = !!ci?.harmful;
    if (ci?.bound && ci.usable) {
      // 帰還の綱: 手番の数・今の群れの被害見込み・確定点（V3-2R2 §18.1）。危なくないとき（追跡中の敵がおらず HP が半分超）は短い行だけ
      if (!x.huntingReach.length && view.self.stats.hp * 2 > view.self.stats.maxHp) {
        out.push(`use_item ${it.slot} (${name}${x.ifLifeline !== undefined ? t(L, `・+${x.ifLifeline} 確定`, `, banks +${x.ifLifeline}`) : ''})`);
        continue;
      }
      const turns = catalog.rules?.lifeline?.turns ?? 0;
      const risk = x.huntingReach.length
        ? t(L, `・追跡中 ${x.huntingReach.length} 体の 1 手の最悪の被害 ${x.worstSum}${x.unrecorded ? `＋記録なし ${x.unrecorded} 体` : ''}`, `, ${x.huntingReach.length} hunting: worst ${x.worstSum}/turn${x.unrecorded ? ` + ${x.unrecorded} unrecorded` : ''}`) : '';
      const how = x.lifelineShort ? t(L, 'キャンプへ戻る', 'back to camp') : (turns > 0 ? t(L, `${turns} 手番動けずにキャンプへ戻る`, `${turns} turns helpless, then back to camp`) : t(L, 'その場でキャンプへ戻る（命と、目的を除く戦利品の半分を持ち帰る）', 'back to camp at once (you keep your life and half the haul without the objective)'))
        + (x.lifelineShort ? '' : t(L, '・次の遠征はこの遠征を始めた階段から', '; the next expedition starts from where this one began'));
      const left = x.mineCount > 0 ? t(L, `・投げた物が ${x.mineCount} 個、この階の床に残っている`, `; ${x.mineCount} of your thrown items are still on this floor`) : '';
      const line = `use_item ${it.slot} (${t(L, `${name}: ${how}${x.ifLifeline !== undefined ? `・+${x.ifLifeline} 確定` : ''}${risk}${left}`, `${name}: ${how}${x.ifLifeline !== undefined ? `, banks +${x.ifLifeline}` : ''}${risk}${left}`)})`;
      out.push(line);
      lifelineLines.push(line);
      continue;
    }
    // 隣に起きている追跡中の敵がいれば、使う間にその敵が行動する（V3-2R3 §20.4）
    const exposed = adjAwake.some((m) => m.awareness === 'hunting') ? t(L, '・使う間に隣の敵が行動する', '; adjacent enemies act while you use it') : '';
    if ((cat === 'potion' || cat === 'scroll' || ci?.usable) && !harmful) out.push(`use_item ${it.slot} (${name}${exposed})`);
    // 同じか劣る装備は勧めない（V3-2R3 §20.6）。未鑑定の品は外見の種類から装備の枠を引く（未鑑定の指輪・首飾り）
    const eqSlot = ci?.slot ?? (!it.kind && cat ? Object.values(catalog.items).find((c) => c.category === cat && c.slot)?.slot : undefined);
    if (eqSlot && !it.equipped && !sameOrWorseEquip(view, catalog, it) && !worseEquip(view, catalog, it)) out.push(`equip ${it.slot} (${name})`);
    // 投擲: 射程内で経路の通る相手だけ（自分を攻撃している相手を先に、近い順に最大 3）。対象が同じ品目はまとめる
    if ((cat === 'throwing' || harmful) && ci?.throwRange != null && !it.equipped) {
      const targets = x.hostiles
        .filter((m) => m.shots.some((s) => s.slot === it.slot && s.state === 'clear'))
        .sort((a, b) => Number(x.attackers.has(b.id)) - Number(x.attackers.has(a.id)) || a.dist - b.dist || (a.id < b.id ? -1 : 1))
        .slice(0, 3);
      if (targets.length) {
        const key = targets.map((m) => m.id).join(',');
        const g = throwGroups.find((tg) => tg.key === key);
        if (g) g.slots.push(it.slot); else throwGroups.push({ key, slots: [it.slot], targets });
      }
    }
  }
  for (const g of throwGroups) {
    out.push(`throw_item ${g.slots.join('|')} -> ${g.targets.map((m) => `${m.id}${x.attackers.has(m.id) && !m.fleeing ? t(L, '（あなたを攻撃中）', ' (attacking you)') : ''}`).join(', ')}`);
  }
  // 投擲で決着まで（相手が射程に入るまで待つ。V3-2R2 §18.5）。隣の相手には出さない（投擲の fight は隣に来ると止まる）
  const thrownProf = catalog.classes[view.self.classId]?.proficiency.thrown ?? 0;
  for (const g of thrownProf < 0 ? [] : throwGroups) {
    const far = g.targets.find((m) => m.dist > 1);
    if (!far) continue;
    const withKind = view.inventory.find((i) => i.slot === g.slots[0])?.kind;
    const aimed = x.abilities.find((a) => abilityHandlerOf(catalog, a.id) === 'aimed_throw' && a.uses_left !== 0);
    // 投げられる種類がほかにもあれば並べる（前の品が尽きたら次へ。V3-3c §44.6）
    const kinds = [...new Set([withKind, ...view.inventory.filter((i) => !i.equipped && i.kind && catalog.items[i.kind]?.category === 'throwing').map((i) => i.kind)].filter((k): k is string => !!k))].map(shortId);
    const withArg = withKind && kinds.length > 1 ? `[${kinds.join(',')}]` : withKind ? shortId(withKind) : g.slots[0];
    out.push(`fight ${far.id} with:${withArg}${aimed ? ` abilities:${aimed.id}` : ''} (${t(L, `投擲で決着まで・${stopText}`, `throw until it falls, ${stopText}`)}${kinds.length > 1 ? t(L, '・前の品が尽きたら次の品', ', next item when one runs out') : ''}${aimed ? t(L, `・${aimed.name}を使える手番に使う`, `, uses ${aimed.name} when ready`) : ''})`);
    break;
  }
  // 隣接する扉・地物
  for (const d of [null, ...DIRS] as (Dir | null)[]) {
    const nx = pos.x + (d ? DIR_VEC[d][0] : 0);
    const ny = pos.y + (d ? DIR_VEC[d][1] : 0);
    if (nx < 0 || ny < 0 || nx >= f.width || ny >= f.height) continue;
    const i = ny * f.width + nx;
    const tr = catalog.terrain[view.terrainTable[view.memory.terrain[i]]];
    if (d && tr?.door === 'open' && !byPos.has(i)) out.push(`interact ${d} (${t(L, '扉を閉める', 'close door')})`);
    // 鍵のかかった格子扉（V3-5 §5.1）
    if (d && tr?.tags.includes('locked')) {
      const hasKey = view.inventory.some((it) => it.kind && catalog.items[it.kind]?.category === 'key');
      out.push(`interact ${d} (${hasKey ? t(L, '格子扉を鍵で開ける', 'unlock the grate') : t(L, '不可: 鍵が要る（その階の敵が持っている）', 'unavailable: needs the key (a monster on this floor has it)')})`);
    }
    for (const e of view.entities) {
      if (e.cat !== 'feature' || e.pos.x !== nx || e.pos.y !== ny) continue;
      const fd = e.kind ? catalog.features[e.kind] : undefined;
      if (fd?.interactable && e.state !== 'used' && (!fd.afterInteract || e.state !== fd.afterInteract)) out.push(`interact${d ? ' ' + d : ''} (${kindName(catalog, L, e.kind)})`);
    }
  }
  // 一番近い階段でも、追われたままなら最悪の被害が今の HP 以上: 綱の候補を階段より前に並べる（V3-2R3b §23.1）。
  // 記録の無い敵がいるときは、記録のある分だけの見込み（下限）で判断する
  const near = x.huntingReach.length ? nearestStairs() : undefined;
  if (near && lifelineLines.length && x.chaseOf(near.path_len!).recordedWorst >= hpNow) {
    const first = out.findIndex((s) => s.startsWith('travel_to stairs_'));
    if (first >= 0) {
      const rest = out.filter((s) => !lifelineLines.includes(s));
      const at = rest.findIndex((s) => s.startsWith('travel_to stairs_'));
      return [...rest.slice(0, at), ...lifelineLines, ...rest.slice(at)];
    }
  }
  return out;
}

/** テキスト整形の選択（ゲームには影響しない。プレイヤーごとの set_options） */
export interface TextFormat {
  /** false: 所持品の行を出さない */
  inventory?: boolean;
  /** 'short': 【遠征】の見出しが前の応答から変わっていない（戦利品と extract の可否だけ出す。V3-4b §28.8） */
  expedition?: 'full' | 'short';
  /** 'unchanged': 地図の代わりに「地図: 変化なし」の 1 行 */
  map?: 'show' | 'unchanged';
}

export function formatObservationText(obs: Observation, locale: Locale, fmt: TextFormat = {}): string {
  const L = locale;
  const lines: string[] = [];
  const s = obs.self;
  const statusText: Record<ViewStatus, [string, string]> = {
    your_turn: ['あなたの番', 'your turn'], waiting_others: ['他プレイヤー待ち', 'waiting for others'], dead: ['死亡', 'dead'], ended: ['ラン終了', 'run ended'],
    at_camp: ['キャンプ', 'at camp'],
  };
  if (obs.status === 'at_camp') {
    // キャンプ専用の形: 成績と候補だけ
    lines.push(`[seq ${obs.seq} | ${t(L, 'キャンプ', 'Camp')} | HP ${s.hp}/${s.max_hp} | Lv${s.level} | ${statusText.at_camp[L === 'en' ? 1 : 0]}]`);
    if (obs.expedition?.result) lines.push(obs.expedition.result.text);
    // 直前の遠征の比較（1 行。目標の宣言は V3-8 §53.5 で外した）
    if (obs.camp?.compare?.lines.length) lines.push(obs.camp.compare.lines[0]);
    lines.push(t(L, `確定済み ${s.score.banked} 点・達成した遠征 ${s.score.expeditions_completed}`, `Banked ${s.score.banked}, expeditions completed ${s.score.expeditions_completed}`));
    lines.push(boonsText(L, s.boons ?? []));
    if (obs.camp?.milestone) lines.push(obs.camp.milestone.text);
    if (obs.camp?.archive) lines.push(t(L, `記録庫: 欠片 ${obs.camp.archive.delivered}/${obs.camp.archive.total}`, `Archive: shards ${obs.camp.archive.delivered}/${obs.camp.archive.total}`));
    // プロフィール（V3-7 §7.2・§7.4）: 記録の要約と次の節目、直前の遠征で取った実績
    if (obs.camp?.records?.feats_new?.length) lines.push(t(L, `新しい実績: ${obs.camp.records.feats_new.join('・')}`, `New feats: ${obs.camp.records.feats_new.join(', ')}`));
    if (obs.camp?.records) lines.push(obs.camp.records.line);
    if (obs.camp?.version_note) lines.push(obs.camp.version_note);
    if (obs.alerts.length) lines.push('!! ' + obs.alerts.map((a) => a.text).join(' / '));
    if (obs.camp) {
      lines.push(t(L, `次の遠征の候補（遠征 ${obs.camp.next_no}）。start_expedition { offer } で始める:`, `Offers for expedition ${obs.camp.next_no} (start with start_expedition { offer }):`));
      for (const o of obs.camp.offers) lines.push('  ' + o.text);
      lines.push('  ' + t(L, 'endless) 目的なしでひたすら潜る（offer: "endless"）', 'endless) no objective, just descend (offer: "endless")'));
    }
    if (obs.recent_events.length) {
      lines.push(t(L, '直前の出来事:', 'Recent events:'));
      for (const e of collapseRepeats(obs.recent_events)) lines.push(`- ${e}`);
    }
    lines.push(t(L, 'できること: ', 'Actions: ') + obs.valid_actions.join(' / '));
    return lines.join('\n');
  }
  // 通常の階でなければ階の種類も（聖域・大守護者の間など。V3-3 後の AI 評価: 敵のいない階が聖域と分からなかった）
  const ftText = s.floor?.floor_type_id && s.floor.floor_type_id !== 'core:standard' ? t(L, `（${s.floor.floor_type}）`, ` (${s.floor.floor_type})`) : '';
  const floorText = s.floor ? t(L, `地下${s.floor.depth}階 ${s.floor.biome_name}${ftText}`, `Depth ${s.floor.depth} ${s.floor.biome_name}${ftText}`) : '-';
  const posText = s.pos ? t(L, `位置(${s.pos.x},${s.pos.y})`, `pos(${s.pos.x},${s.pos.y})`) : '';
  lines.push(`[seq ${obs.seq} | ${floorText} | HP ${s.hp}/${s.max_hp} | Lv${s.level} | ${posText ? posText + ' | ' : ''}${statusText[obs.status][L === 'en' ? 1 : 0]}]`);
  // 遠征は 1 行（目的・進捗・extract の可否 | 戦利品 | 気配）
  if (obs.expedition) {
    const x = obs.expedition;
    const head = fmt.expedition === 'short'
      ? t(L, `【遠征${x.no}】${x.can_extract ? 'この場で extract できる' : 'extract は階段の上で'}`, `[Expedition ${x.no}] ${x.can_extract ? 'you can extract here' : 'extract on stairs'}`)
      : x.text;
    lines.push([head, x.haul?.text, x.sense?.text, ...(x.ward_fires ?? []).map((w) => w.text)].filter(Boolean).join(' | '));
  }
  if (obs.alerts.length) lines.push('!! ' + obs.alerts.map((a) => a.text).join(' / '));
  const st = s.statuses.length ? s.statuses.map((x) => `${x.name}(${x.turns_left})`).join(' ') : t(L, 'なし', 'none');
  lines.push(t(L,
    `能力: 命中+${s.attack.acc} ダメージ${s.attack.dmg} 回避${s.defense.eva} 装甲${s.defense.armor} 速さ${s.speed} XP ${s.xp}/${s.xp_next} 状態:${st}`,
    `Stats: acc+${s.attack.acc} dmg ${s.attack.dmg} eva ${s.defense.eva} armor ${s.defense.armor} speed ${s.speed} XP ${s.xp}/${s.xp_next} status:${st}`));
  if (s.abilities.length || s.perks.length) {
    const ab = s.abilities.map((a) => `${a.name}(${a.id}${a.uses_left === 0 ? t(L, '・使い切った', ', used up') : a.cooldown_left ? t(L, `・あと${a.cooldown_left}`, `, ${a.cooldown_left} left`) : t(L, '・使える', ', ready')})`).join(' ');
    const pk = s.perks.map((x) => `${x.name}${x.ranks > 1 ? `×${x.ranks}` : ''}`).join(t(L, '・', ', '));
    lines.push(t(L, `能動技: ${ab || 'なし'} | 特技: ${pk || 'なし'}`, `Abilities: ${ab || 'none'} | Perks: ${pk || 'none'}`));
  }
  if (s.boons?.length) lines.push(boonsText(L, s.boons, !!s.boons_brief));
  const re = s.rest_estimate;
  const alive = obs.status !== 'dead' && obs.status !== 'ended';
  if (re && alive) {
    const block = re.blocked_by === 'hostile_hunting' ? t(L, '（今は追跡中の敵が見えるので休めない）', ' (blocked: a hunting enemy is in view)')
      : re.blocked_by === 'poisoned' ? t(L, `（毒が抜けるまで休憩は続く。その間の最低 HP ${re.lowest_hp ?? '?'}）`, ` (rest continues until the poison wears off; lowest HP ${re.lowest_hp ?? '?'})`) : '';
    lines.push(t(L,
      `休憩の見積もり: HP ${re.cap_hp} まで ${re.turns} 手（HP +${re.hp_to_full}、時間 ${re.time}、その間の徘徊の目安 ${re.wander_expected} 体。休憩で戻るのはここまで）${block}`,
      `Rest estimate: ${re.turns} turns to ${re.cap_hp} HP (HP +${re.hp_to_full}, time ${re.time}, wanderers expected ${re.wander_expected}; rest heals no further)${block}`));
  }
  if (obs.expedition?.result) lines.push(obs.expedition.result.text);
  const vis = obs.visible;
  const nav = obs.navigation;
  const stairsLines = nav.known_stairs.slice(0, 3);
  if (vis.monsters.length || vis.items.length || vis.players.length || vis.features.length || stairsLines.length || vis.items_omitted) {
    lines.push(t(L, '見えるもの:', 'In view:'));
    const from = s.pos ?? { x: 0, y: 0 };
    for (const m of vis.monsters) {
      const role = m.role === 'guardian' ? (m.guardian?.warden ? t(L, ` [大守護者・賞金 ${m.bounty ?? 0}]`, ` [warden, bounty ${m.bounty ?? 0}]`) : t(L, ` [守護者・賞金 ${m.bounty ?? 0}]`, ` [guardian, bounty ${m.bounty ?? 0}]`))
        : m.role === 'elite' ? t(L, ` [強敵「${m.named ?? '?'}」・賞金 ${m.bounty ?? 0}・宝を必ず落とす]`, ` [elite "${m.named ?? '?'}", bounty ${m.bounty ?? 0}, always drops treasure]`)
          : m.bounty ? t(L, ` [賞金 ${m.bounty}]`, ` [bounty ${m.bounty}]`) : '';
      const dmg = m.damage_seen ? t(L, `  見た被害:${m.damage_seen}`, ` dmg_seen:${m.damage_seen}`) : '';
      const est = m.hp_left_est ? t(L, `  推定残りHP:${hpEstimateText(L, m.hp_left_est)}`, ` hp_left_est:${hpEstimateText(L, m.hp_left_est)}`) : '';
      // 眠っている敵と 8 マスより遠い敵は、名前・位置・脅威・体力の目安だけ（命中と通りの記録・射線は省く。V3-4b §28.8）
      const brief = m.awareness === 'asleep' || m.dist > 8;
      const outOf = m.shots.filter((x) => x.state === 'out_of_range').map((x) => x.slot);
      const shot = brief ? '' : m.shot === 'blocked' ? t(L, '  射線:通らない', ' shot:blocked') : outOf.length && outOf.length === m.shots.length ? t(L, '  射程外', ' out of range') : outOf.length ? t(L, `  射程外:${outOf.join(',')}`, ` out of range:${outOf.join(',')}`) : '';
      const threat = m.threat === null ? (m.first_seen ? t(L, '不明（初見）', 'unknown (first sighting)') : t(L, '不明（被弾の記録なし）', 'unknown (never hit by it)')) : String(m.threat);
      const perTurn = m.worst_turn !== null && m.worst_turn !== m.worst_hit ? t(L, `（1 手に最悪 ${m.worst_turn}）`, ` (worst ${m.worst_turn}/turn)`) : '';
      const worst = m.worst_hit !== null ? t(L, `  最大の一撃:${m.worst_hit}${perTurn}`, ` worst_hit:${m.worst_hit}${perTurn}`) : '';
      // 見れば分かる特徴（速さは自分との比較）と命中の記録
      const looks = [m.size === 'large' ? t(L, '大柄', 'large') : m.size === 'small' ? t(L, '小柄', 'small') : '', m.speed === 'fast' ? t(L, `速い×${m.speed_ratio ?? ''}`, `fast x${m.speed_ratio ?? ''}`) : m.speed === 'slow' ? t(L, `遅い×${m.speed_ratio ?? ''}`, `slow x${m.speed_ratio ?? ''}`) : '', ...m.traits.map((tr) => abilityName(L, tr))].filter(Boolean);
      const looksText = looks.length ? (L === 'en' ? ` [${looks.join(', ')}]` : `  [${looks.join('・')}]`) : '';
      const hitLine = [hitsText(L, m.hits), dealtText(L, m.dealt)].filter(Boolean).join(L === 'en' ? ', ' : '・');
      const hits = hitLine && !brief ? (L === 'en' ? ` ${hitLine}` : `  ${hitLine}`) : '';
      // 守護者の呼び名・型・分かった弱点、予備動作（V3-3）
      const gtext = m.guardian ? (L === 'en'
        ? ` "${m.guardian.name}"${m.guardian.types.length ? ` type:${m.guardian.types.map((x) => x.name).join('/')}` : ''}${m.guardian.weakness ? ` weakness:${m.guardian.weakness.name}` : ''}`
        : `  「${m.guardian.name}」${m.guardian.types.length ? `  型:${m.guardian.types.map((x) => x.name).join('・')}` : ''}${m.guardian.weakness ? `  弱点:${m.guardian.weakness.name}` : m.guardian.not_weak?.length ? `  弱点:不明（${m.guardian.not_weak.map((x) => x.name).join('ではない・')}ではない）` : ''}`) : '';
      const itext = m.intent ? (L === 'en' ? ` INTENT:${m.intent.text}` : `  予備動作:${m.intent.text}`) : '';
      // 持っている品（宝物庫の鍵。V3-5 §5.1）
      const carry = m.carries ? t(L, ` [${m.carries_name ?? m.carries}を持っている]`, ` [carries the ${m.carries_name ?? m.carries}]`) : '';
      lines.push(L === 'en'
        ? `- ${m.name}${m.objective ? ' [objective]' : ''}${role}${carry}${gtext} ${m.id} (${m.pos.x},${m.pos.y}) ${relLabel(L, from, m.pos)} hp:${m.hp_state} ${m.awareness}${m.fleeing ? '(fleeing)' : ''}${looksText} threat:${threat}${worst}${hits}${dmg}${est}${shot}${m.statuses.length ? ' ' + m.statuses.join(',') : ''}${itext}`
        : `- ${m.name}${m.objective ? '［目的］' : ''}${role}${carry}${gtext} ${m.id} (${m.pos.x},${m.pos.y}) ${relLabel(L, from, m.pos)}  負傷:${HP_JA[m.hp_state]}  状態:${AW_JA[m.awareness] ?? m.awareness}${m.fleeing ? '(逃走中)' : ''}${looksText}  脅威:${threat}${worst}${hits}${dmg}${est}${shot}${m.statuses.length ? '  ' + m.statuses.join(',') : ''}${itext}`);
    }
    for (const p of vis.players) lines.push(`- ${t(L, '味方', 'ally')} ${p.name} (${p.pos.x},${p.pos.y}) ${relLabel(L, from, p.pos)} ${L === 'en' ? p.hp_state : HP_JA[p.hp_state]}`);
    for (const it of vis.items) {
      const tags = `${it.role === 'relic' ? t(L, ' [遺物]', ' [relic]') : ''}${it.mine ? t(L, ' [自分が投げた]', ' [yours]') : ''}${it.value !== undefined ? t(L, ` [宝・価値 ${it.value}]`, ` [treasure ${it.value}]`) : ''}`;
      // まとめた「自分が投げた物」は合計の本数と、最寄りのマスの本数
      const qtyText = it.near_qty !== undefined ? t(L, ` 合計${it.qty}（最寄りのマスに${it.near_qty}）`, ` ${it.qty} in all (${it.near_qty} at the nearest)`) : it.qty > 1 ? ` x${it.qty}` : '';
      lines.push(`- ${it.name}${it.objective ? t(L, '［目的］', ' [objective]') : ''}${qtyText}${tags} ${it.id} (${it.pos.x},${it.pos.y}) ${relLabel(L, from, it.pos)}${it.remembered ? t(L, ' (記憶)', ' (remembered)') : ''}`);
    }
    if (vis.items_omitted) lines.push(`- ${t(L, `ほかに記憶しているアイテム ${vis.items_omitted} 件（get_map の注目点）`, `${vis.items_omitted} more remembered items (see get_map)`)}`);
    for (const ft of vis.features) lines.push(`- ${ft.name}${ft.lair ? t(L, `（${ft.lair}の棲み処）`, ` (${ft.lair}'s lair)`) : ''}${ft.id ? ` ${ft.id}` : ''} (${ft.pos.x},${ft.pos.y}) ${relLabel(L, from, ft.pos)}${ft.state && ft.state !== 'idle' ? ` [${featureStateText(L, ft.state)}]` : ''}`);
    for (const st2 of stairsLines) {
      const name = st2.type === 'down' ? t(L, '下り階段', 'stairs down') : t(L, '上り階段', 'stairs up');
      lines.push(`- ${name} (${st2.pos.x},${st2.pos.y}) ${t(L, '距離', 'dist')}${st2.dist} ${st2.reachable ? t(L, '到達可', 'reachable') : t(L, '到達不明', 'unknown path')}`);
    }
  }
  if (alive) {
    lines.push(t(L, '足元: ', 'Here: ') + nav.here);
    // この階の性質（V4-0e §8.1）・異変・手がかり
    const fl = [s.floor?.trait_text, s.floor?.event_text, s.floor?.hint_text].filter(Boolean);
    const hint = fl.length ? t(L, `（この階: ${fl.join('・')}）`, ` (this floor: ${fl.join(', ')})`) : '';
    if (nav.frontiers.length) {
      const mapped = obs.navigation.unsighted ? t(L, '（地形は判明・未見の区画あり）', ' (layout known, unseen areas remain)') : '';
      lines.push(t(L, '未探索: ', 'Unexplored: ') + nav.frontiers.map((fr) => `${dirLabel(L, fr.dir)}(${fr.pos.x},${fr.pos.y}) ${t(L, '距離', 'dist')}${fr.dist}`).join(' / ') + mapped + hint);
    } else {
      lines.push(t(L, '未探索: なし（このフロアは探索済み）', 'Unexplored: none (floor explored)') + hint);
    }
  }
  if (obs.recent_events.length) {
    lines.push(t(L, '直前の出来事:', 'Recent events:'));
    for (const e of collapseRepeats(obs.recent_events)) lines.push(`- ${e}`);
  }
  // 装備は所持品の * に一本化
  if (fmt.inventory !== false) {
    if (s.inventory) {
      lines.push(t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}、* は装備中):`, `Inventory (${s.inventory_count}/${s.inventory_capacity}, * = equipped):`));
      for (const it of s.inventory) lines.push(`  ${it.slot}) ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}${it.equipped ? '*' : ''}${it.identified ? '' : t(L, ' (未鑑定)', ' (unidentified)')}${it.curse === 'cursed' ? t(L, ' {呪い:外せない}', ' {cursed}') : it.curse === 'unknown' ? t(L, ' {呪い?}', ' {curse?}') : ''}`);
    } else {
      lines.push(t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}、* は装備中): `, `Inventory (${s.inventory_count}/${s.inventory_capacity}, * = equipped): `) + (s.inventory_brief || '-'));
    }
  }
  if (obs.map) {
    lines.push(t(L, `地図（上の 2 行が x 座標の 10 の位と 1 の位、左が y 座標）:`, `Map (top rows: x tens/ones, left: y):`));
    for (const r of mapTextLines(obs.map)) lines.push(r);
    lines.push(t(L, '凡例: ', 'Legend: ') + Object.entries(obs.map.legend).map(([k, v]) => `${k}=${v}`).join(' ') + t(L, ' (空白)=未知', ' (blank)=unknown'));
  } else if (fmt.map === 'unchanged') {
    lines.push(t(L, '地図: 変化なし（get_map で全体）', 'Map: unchanged (get_map for the whole floor)'));
  }
  lines.push(t(L, 'できること: ', 'Actions: ') + compactActions(obs.valid_actions));
  return lines.join('\n');
}

function compactActions(actions: string[]): string {
  const plainMoves = actions.filter((a) => /^move [a-z]+$/.test(a)).map((a) => a.slice(5));
  const rest = actions.filter((a) => !/^move [a-z]+$/.test(a));
  const parts: string[] = [];
  const special = rest.filter((a) => a.startsWith('move '));
  parts.push(...special);
  if (plainMoves.length) parts.push(`move ${plainMoves.join(',')}`);
  parts.push(...rest.filter((a) => !a.startsWith('move ')));
  return parts.join(' / ');
}

/** 対象の説明（look）。視界内・記憶内の情報だけを使う */
export function describeTarget(view: PlayerView, catalog: Catalog, target: Pos | string): { text: string; data: Record<string, unknown> } {
  const L = view.locale;
  const f = view.floor;
  if (!f) return { text: t(L, 'フロア外', 'Not on a floor'), data: {} };
  let p: Pos | null = null;
  let ent: EntityView | undefined;
  if (typeof target === 'string') {
    ent = view.entities.find((e) => e.id === target);
    if (ent) p = ent.pos;
    else {
      const r = view.memory.remembered.find((x) => x.id === target);
      if (r) return { text: t(L, `${kindName(catalog, L, r.kind, r.appearanceId)}（最後に見た位置 ${r.pos.x},${r.pos.y}）`, `${kindName(catalog, L, r.kind, r.appearanceId)} (last seen at ${r.pos.x},${r.pos.y})`), data: { remembered: r } };
      if (target === view.self.id) p = view.self.pos;
      else return { text: t(L, 'それは見えない。', 'You cannot see that.'), data: { visible: false } };
    }
  } else p = target;
  if (!p || p.x < 0 || p.y < 0 || p.x >= f.width || p.y >= f.height) return { text: t(L, '範囲外', 'Out of bounds'), data: {} };
  const i = p.y * f.width + p.x;
  const known = view.memory.terrain[i] !== 0;
  const visible = view.visibleCells.includes(i);
  const parts: string[] = [];
  const data: Record<string, unknown> = { pos: p, known, visible };
  if (!known) return { text: t(L, 'まだ見たことのない場所だ。', 'An unexplored location.'), data };
  const tid = view.terrainTable[view.memory.terrain[i]];
  parts.push(termName(catalog, L, tid) + (visible ? '' : t(L, '（記憶）', ' (remembered)')));
  data.terrain = tid;
  const here = view.entities.filter((e) => e.pos.x === p!.x && e.pos.y === p!.y);
  const list: unknown[] = [];
  for (const e of here) {
    if (e.cat === 'monster') {
      const mem = memoryOf(view, e);
      const name = monsterDisplayName(catalog, L, e);
      const memText = mem ? memoryCombatText(L, mem) : t(L, '初めて見る相手だ', 'never seen before');
      const hpText = '';
      const sturdy = e.role === 'guardian'
        ? t(L, '・守護者（通常の個体より大幅に頑丈）', ', guardian (far sturdier than a normal one)')
        : (e.affixes?.length || e.tier) ? t(L, '・接辞や深層強化があるので記録より頑丈なことがある', ', affixes/tier may make it sturdier than your records') : '';
      const ds = e.damageSeen ? t(L, `・見た被害 ${e.damageSeen}`, `, damage you saw it take ${e.damageSeen}`) : '';
      const est = e.role === 'guardian' ? undefined : hpLeftEstimate(mem, e.hp ?? 'healthy', e.damageSeen ?? 0, catalog.rules?.estimateMinSamples ?? HP_RECORD_SURE);
      const estText = est ? t(L, `・推定残りHP ${hpEstimateText(L, est)}`, `, estimated HP left ${hpEstimateText(L, est)}`) : '';
      const shotText = e.shot === false ? t(L, '・射線: 通らない', ', shot: blocked') : '';
      // 見れば分かる特徴（初見でも分かる。V3-2R2 §18.2・V3-5a §35.10: 錆びさせる・装甲を抜く）
      const cmLook = e.kind ? catalog.monsters[e.kind] : undefined;
      const lookTraits = [...OBVIOUS_TRAITS.filter((tr) => cmLook?.tags.includes(tr)), ...(cmLook?.armored ? ['armored'] : []), ...(cmLook?.evasive ? ['evasive'] : [])].map((tr) => abilityName(L, tr));
      const traitText = lookTraits.length ? t(L, `・見た目: ${lookTraits.join('・')}`, `, looks: ${lookTraits.join(', ')}`) : '';
      // 接辞の効き目（V3-8 §53.3: 強敵の見立て）
      const affText = (e.affixes ?? []).length ? t(L, `・接辞: ${monsterAffixText(L, catalog, e.affixes ?? [])}`, `, affixes: ${monsterAffixText(L, catalog, e.affixes ?? [])}`) : '';
      // 守護者の呼び名・型の説明・分かった弱点（V3-3）。弱点は試して分かるまで「不明」
      const g = e.guardian;
      const gText = g ? t(L,
        `・「${guardianDisplayName(L, g)}」${g.types.map((id) => `・型「${nameOf(catalog.guardianTypes[id]?.name, L, id)}」: ${nameOf(catalog.guardianTypes[id]?.desc, L, '')}`).join('')}・弱点: ${g.weakness ? `${nameOf(catalog.guardianWeaknesses[g.weakness]?.name, L, g.weakness)}${g.weakness === 'core:weak_sleep' ? (e.awareness === 'asleep' ? '（いまは眠っている）' : '（いまは起きている）') : ''}（${nameOf(catalog.guardianWeaknesses[g.weakness]?.desc, L, '')}）` : g.notWeak?.length ? `不明（${g.notWeak.map((id) => nameOf(catalog.guardianWeaknesses[id]?.short ?? catalog.guardianWeaknesses[id]?.name, L, id)).join('ではない・')}ではない。試して確かめる）` : '不明（試して確かめる）'}`,
        `, "${guardianDisplayName(L, g)}"${g.types.map((id) => `, type ${nameOf(catalog.guardianTypes[id]?.name, L, id)}: ${nameOf(catalog.guardianTypes[id]?.desc, L, '')}`).join('')}, weakness: ${g.weakness ? `${nameOf(catalog.guardianWeaknesses[g.weakness]?.name, L, g.weakness)} (${nameOf(catalog.guardianWeaknesses[g.weakness]?.desc, L, '')})` : 'unknown (try things to find out)'}`) : '';
      // 大守護者: 記録庫の記憶（体力と最大の一撃の目安。V3-3a §35.7）
      const wi = g?.warden && view.floor ? view.wardenIntel?.[String(view.floor.depth)] : undefined;
      const wiText = wi?.hp !== undefined ? t(L, `・記録庫の記憶: 体力およそ ${wi.hp}・一撃 ${wi.maxHit} まで`, `, the archive remembers: about ${wi.hp} HP, hits up to ${wi.maxHit}`) : '';
      parts.push(`${name} [${L === 'en' ? e.hp : HP_JA[e.hp ?? 'healthy']}, ${L === 'en' ? e.awareness : AW_JA[e.awareness ?? 'unaware']}] ${memText}${hpText}${traitText}${affText}${ds}${estText}${shotText}${sturdy}${gText}${wiText}`);
      list.push({ id: e.id, name, hp_state: e.hp, awareness: e.awareness, memory: mem ?? null, threat: threatOf(view, e), role: e.role, damage_seen: e.damageSeen ?? 0, hp_left_est: est ?? null });
    } else if (e.cat === 'item') {
      const name = itemDisplayName(catalog, L, e.kind, e.appearanceId, e.affixes);
      const desc = e.kind ? nameOf(catalog.items[e.kind]?.desc, L, '') : t(L, '正体不明', 'unidentified');
      parts.push(`${name}${(e.qty ?? 1) > 1 ? ` x${e.qty}` : ''}: ${desc}`);
      list.push({ id: e.id, name, qty: e.qty, desc });
    } else {
      const name = e.cat === 'player' ? (e.name ?? '?') : kindName(catalog, L, e.kind);
      // 地物の説明と、賭けの祭壇の表（V3-5 §5.1）
      const fd = e.cat === 'feature' && e.kind ? catalog.features[e.kind] : undefined;
      const fdesc = fd?.desc ? `: ${nameOf(fd.desc, L, '')}` : '';
      const table = fd?.gamble ? t(L, `。表: ${fd.gamble.map((g) => `${nameOf(g.name, L, '')} ${g.pct}%`).join('・')}`, `. Table: ${fd.gamble.map((g) => `${nameOf(g.name, L, '')} ${g.pct}%`).join(', ')}`) : '';
      parts.push(name + (e.state && e.state !== 'idle' ? ` [${e.state}]` : '') + fdesc + table);
      list.push({ id: e.id, name, state: e.state });
    }
  }
  // 見えていないマス: 覚えている地物・アイテム（V3-7 の評価: 離れた賭けの祭壇を look すると「床（記憶）」だけだった）
  if (!visible) {
    for (const r of view.memory.remembered.filter((x) => x.pos.x === p!.x && x.pos.y === p!.y)) {
      const name = kindName(catalog, L, r.kind, r.appearanceId);
      const fd = r.cat === 'feature' && r.kind ? catalog.features[r.kind] : undefined;
      const fdesc = fd?.desc ? `: ${nameOf(fd.desc, L, '')}` : '';
      const table = fd?.gamble ? t(L, `。表: ${fd.gamble.map((g) => `${nameOf(g.name, L, '')} ${g.pct}%`).join('・')}`, `. Table: ${fd.gamble.map((g) => `${nameOf(g.name, L, '')} ${g.pct}%`).join(', ')}`) : '';
      parts.push(name + (r.state && r.state !== 'idle' ? ` [${r.state}]` : '') + (r.qty > 1 ? ` x${r.qty}` : '') + t(L, '（記憶）', ' (remembered)') + fdesc + table);
      list.push({ id: r.id, name, state: r.state, remembered: true });
    }
  }
  data.entities = list;
  return { text: parts.join(' / '), data };
}

/** 続けて同じ文が並ぶときは 1 行にまとめて「×N」を添える（回収の繰り返しなど） */
export function collapseRepeats(lines: readonly string[]): string[] {
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    n++;
    if (lines[i + 1] === lines[i]) continue;
    out.push(n > 1 ? `${lines[i]} ×${n}` : lines[i]);
    n = 0;
  }
  return out;
}

export function describeInventory(view: PlayerView, catalog: Catalog): { text: string; items: (ObsInvItem & { desc: string; id: string })[] } {
  const L = view.locale;
  const items = view.inventory.map((it: ItemView) => {
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    return {
      id: it.id, slot: it.slot, name: itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes), qty: it.qty,
      category: itemCategory(catalog, it.kind, it.appearanceId), identified: it.kind !== null, equipped: it.equipped !== null,
      ...(it.kind ? { kind: shortId(it.kind) } : {}),
      desc: (() => {
        const st = itemStats(catalog, it.kind, it.affixes);
        const stText = st ? itemStatsText(L, st, catalog) : '';
        if (!ci) {
          // 未鑑定の手がかり（V3-5 §5.4）
          const clue = it.appearanceId ? view.clues?.[it.appearanceId] : undefined;
          return clue ? t(L, `未鑑定。手がかり: ${clueText(L, catalog, view, clue)}`, `Unidentified. Clue: ${clueText(L, catalog, view, clue)}`) : t(L, '未鑑定。使うか鑑定するまで正体は分からない（拾ってしばらく持つと手がかりに気づく）。', 'Unidentified. Use or identify it to learn what it is (carry it a while and you notice a clue).');
        }
        return [stText, stText ? (ci.note ? nameOf(ci.note, L, '') : '') : nameOf(ci.desc, L, '')].filter(Boolean).join(' — ');
      })(),
    };
  });
  const text = [
    t(L, `所持品 ${view.inventory.filter((i) => !(i.kind && catalog.items[i.kind]?.bound)).length}/${view.self.capacity}`, `Inventory ${view.inventory.filter((i) => !(i.kind && catalog.items[i.kind]?.bound)).length}/${view.self.capacity}`),
    ...items.map((i) => `${i.slot}) ${i.name}${i.qty > 1 ? ` x${i.qty}` : ''}${i.equipped ? t(L, ' [装備中]', ' [equipped]') : ''}${i.kind ? t(L, `（種類 ${i.kind}）`, ` (kind ${i.kind})`) : ''} — ${i.desc}`),
  ].join('\n');
  return { text, items };
}

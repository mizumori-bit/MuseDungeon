// Observation: PlayerView に AI が使いやすい派生情報を足して整形したもの。
// 派生情報は PlayerView（とカタログ）だけから計算する。仕様: docs/PROTOCOL.md §3
import type { Catalog, CatalogEquipStats } from './catalog';
import { abilityStatus, accBonuses, curseUnknown, isCursedItem, perkChoice, shortId, weaponReach } from './build';
import { armorWithStatuses, boonHookSum, haulTotal, isMilestoneOf, nameOf, nextCampOf, nextOverreach, offerGap, offerWardenExtra, overreachPoints, payoutOf, regenInterval, regenStep, restCapHp, stairsSealed } from './catalog';
import { floorTraitsText, guardianDisplayName, multText, objectiveText, offerText, partsText, progressText, resultText } from './expedition';
import { COLLECT_WITHIN, collectTargets, isStationary, macroProbe, macroStopError, pickableItems, sameOrWorseEquip, worseEquip } from './macro';
import type { MacroStop } from './macro';
import type { Command } from './commands';
import { attacksPerTurn, avgHitsOf, chaseAttacks, fightThreats, memoryOf, monsterSpeedOf, selfSpeed, threatEstimate } from './danger';
import type { PerceivedEvent } from './filter';
import { lastWithoutXp } from './filter';
import type { ReportCompare } from './expeditionStats';
import { kindName } from './narrate';
import type { NavGrid } from './nav';
import { buildNavGrid, distanceField, findFrontiers } from './nav';
import type { Dir, EntityRole, Expedition, ExpeditionOffer, HaulParts, Locale, MonsterMemory, Names, ObjectiveType, OfferSlot, Pos, SeasonAward, SeasonSlay, SeasonSlayFacts, SlayOpening, SupplyPlace } from './types';
import { awardName, awardText, fireUsedDepths, myCampfires, publicSpotAt, publicStairsAt, seasonBudgetText, SUPPLY_CATEGORIES, supplyPlaceName } from './season';
import type { SupplyView } from './season';
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
  /** 会心でない最大の一撃（S6 §49.6 の 10。worst_hit が会心の値で、会心でない一撃の記録もあるときだけ） */
  worst_plain_hit?: number;
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
  /**
   * hunted_at_fire: 野営の火のそばだが、追ってくる敵が見えている（火からは帰れない。S1c §14.3 の 1）、
   * budget_at_fire: 野営の火のそばだが、予算の残りが帰り支度の手番に足りない
   */
  extract_blocked_by?: 'not_on_stairs' | 'not_your_turn' | 'ended' | 'hunted_at_fire' | 'budget_at_fire';
  /** fire: 階段でなく、足元か隣の野営の火から帰る（帰り支度 turns 手番。S1c §14.3 の 1） */
  extract_via?: { type: 'fire'; by: string; turns: number };
  /** 1 行の要約 */
  text: string;
  /** 終了した遠征の結果 */
  /**
   * banked: あなたの確定、party_banked: 全員の合計（協力プレイ）、shares: だれの分か（how: completed / withdrawn / lifeline / lost。V4-1g G4）
   */
  result?: { reason: string; points: number; deepest: number; kills: number; turns: number; text: string; banked?: number; party_banked?: number; shares?: { id: string; name: string; banked: number; lost: number; how: 'completed' | 'withdrawn' | 'lifeline' | 'lost' }[] };
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
    /** 守護者を倒す遠征の、守護者の賞金（S3b §30.2。くり返しで基礎点と同じ割合に減る）・くり返しで掛けた割合 % */
    guardian_bounty?: number; repeat_pct?: number;
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
    /** 討伐の記録（S4。SEASON.md §35.5。シーズンのランで、まだ倒していない大守護者を倒す遠征の候補だけ）: 先に倒した参加者の戦いの事実 */
    slays?: ObsSlay[];
  }[];
  /** 次の節目（V3-3 §3.2）: まだ倒していない最も浅い大守護者の階 */
  milestone?: ObsMilestone;
  /**
   * 記録庫に納めた欠片の数（V3-3a §35.7）。slays: 討伐の記録（S4 §35.5。シーズンのランだけ。節目ごとに、最初の 1 件といちばん少ない被害の 1 件。
   * count はその階に載った記録の数）
   */
  archive?: { delivered: number; total: number; slays?: { depth: number; warden: string; count: number; records: ObsSlay[]; text: string }[] };
  /**
   * 直前の遠征の比較（2 行以内。V3-6 §35.9: 候補を選ぶ画面で自分の記録が目に入る）。
   * wardens（S5 §47.4 の 2）: その遠征で節目の大守護者と戦って、倒さずに帰ったときだけ。自分の挑戦（attempt。そのランの記録から。共有しない）と、
   * シーズンのランでは先に倒した者の記録（records。最初の 1 件といちばん少ない被害の 1 件。同じ項目の並び）。lines: 文（自分の挑戦が先）
   */
  compare?: { no: number; lines: string[]; wardens?: { depth: number; warden: string; attempt: ObsSlayAttempt; records: ObsSlay[]; lines: string[] }[] } & ReportCompare;
  /** プロフィールの記録の要約と次の節目（1 行。V3-7 §7.2）・直前の遠征で取った実績 */
  records?: { line: string; feats_new?: string[] };
  /** 古い版で始まったラン（V4-0b §1.2。最初の 1 度だけ） */
  version_note?: string;
}

/**
 * 討伐の記録（S4。SEASON.md §35.5。PlayerView の season.slays から）: 名前は招いたときの表示名、ほかはゲームの事実だけ。
 * weapon・armor: 種類と名前（接辞つき）と、手に入れた方法（picked: 拾った・supply: 補給の置き場から取った・start: 最初から持っていた）と階。null は装備なし（hidden なら未鑑定で載せていないものがある）
 */
export interface ObsSlay {
  depth: number; by: string; mine?: boolean; first?: boolean; least?: boolean; of: number;
  level: number; class: string;
  weapon: { kind: string; name: string; got: 'picked' | 'supply' | 'start'; depth?: number } | null;
  armor: { kind: string; name: string; got: 'picked' | 'supply' | 'start'; depth?: number } | null;
  hidden?: boolean;
  dealt: { melee: { total: number; n: number }; thrown: { total: number; n: number }; poison: { total: number; n: number }; feature: { total: number; n: number }; crits: number };
  taken: number; lowest_pct?: number;
  used: { kind: string; name: string; n: number }[]; thrown: { kind: string; name: string; n: number }[]; abilities: { id: string; name: string; n: number }[];
  ward_fires: number; attempt: number; turns: number;
  /** 予備動作への対し方（S5。予備動作の種類ごと。S5 より前の記録には無い）。name: 「突進の構え」など */
  tells?: { kind: string; name: string; n: number; seen: number; missed: number; hit: number }[];
  /**
   * 相手が動けなかった手番（S5。S5 より前の記録には無い）: missed: 予備動作を外させた後・other: 眠りなど。
   * rest: それ以外の手番（相手が動けた手番）に与えた被害（毒の目盛りを含む）・受けた被害（記録の合計から 2 つを引いた残り）
   */
  openings?: { missed: ObsOpening; other: ObsOpening; rest: { dealt: number; taken: number } };
  /**
   * 戦いが始まったときの相手（S6）: 傷跡・灯っていた護りの火（その遠征で見た火だけ。見ていなければ無い）。S6 より前の記録には無い。
   * 始めの体力は出さない（S6a §50.4: 倒していない相手の体力になる）
   */
  warden_start?: { scar: number; fires_lit?: number };
  text: string;
}
/** 相手が動けなかった手番の数（S5）: turns・その手番の自分の行動で与えた被害・被害を与えた手番の数・その手番に受けた被害 */
export interface ObsOpening { turns: number; dealt: number; hit_turns: number; taken: number }
/** 倒さずに帰った自分の挑戦（S5 §47.4 の 2）: 討伐の記録と同じ項目（だれ・選ばれ方を除く） */
export type ObsSlayAttempt = Omit<ObsSlay, 'by' | 'mine' | 'first' | 'least' | 'of'>;

/** 節目の大守護者（V3-3 §3.2）。弱点と種族は伏せる */
export interface ObsMilestone { depth: number; name: string; types: { id: string; name: string }[]; cleared: boolean; text: string; memory?: { weakness?: string; hp?: number; max_hit?: number; armor?: number } }

/** 加護の一覧（V3-3 §3.3）。used: 遠征に 1 回の加護をこの遠征で使った */
export interface ObsBoon { id: string; name: string; desc: string; used?: boolean }
export interface ObsPlayer { id: string; name: string; pos: Pos; dir: Dir | null; dist: number; hp_state: HpState }
/**
 * 自分以外の参加者（V4-1f §22.4。参加の順）。仲間のいる階とキャンプにいるかどうかは、いつでも分かる（同じ遠征を一緒に進める相手で、隠す理由が無い）。
 * pos・hp・entity は、同じ階にいて見えているときだけ（entity は visible.players の id）。order: 参加の順（1 から。自分の番号は抜けている番号）。
 * 仲間のいる階の地形・敵は渡さない
 */
export interface ObsPartyMember {
  id: string; name: string; controller: 'human' | 'agent' | 'unknown'; order: number;
  status: 'in_dungeon' | 'at_camp' | 'down' | 'left';
  floor?: number; pos?: [number, number]; hp?: HpState; entity?: string;
  /**
   * その仲間が自分で最後に行動した時点（V4-1j §30.6。その仲間の手番数で数える。ゲームの中の数えで、実時間ではない）。時間切れでゲームが代わりに
   * 待たせた手番は数えない。見えていなくても出す。何をしたか・どこにいるかは出さない
   */
  last_act: number;
}
/** lair: 棲み処の地物（護りの火）の持ち主の守護者の呼び名（V3-3c §44.6） */
/** id: travel_to で指せる（V3-8a §56.1 の 5） */
/** desc: 何であるか・どう使うかの 1 行（V4-1g G6。すべての地物にある） */
/** by: 野営の火を置いた者（S1 §9.10） */
/** public_by: シーズンで公開された特別な場所（祭壇・賭けの祭壇・碑文。S1c §14.5）で、まだ自分の目で見ていない（報告した者の名前） */
export interface ObsFeature { id?: string; type: string; name: string; pos: Pos; dir: Dir | null; dist: number; state?: string; lair?: string; desc?: string; by?: string; public_by?: string }
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
    /**
     * fight の被弾の前の判定の数（S2a §20.10 の 5。迷宮で、fight の脅威（追跡中の隣か飛び道具）がいるときだけ）。マクロの fight と同じ shared の threatEstimate:
     * worst＝全員が記録の最大の一撃（会心を含む）、expected＝いちばん重い 1 体は会心でない最大・残りは平均、unrecorded＝記録の無い敵の数。判定は fightRiskStop
     */
    fight_risk?: { expected: number; worst: number; unrecorded: number };
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
  /** 自分以外の参加者（V4-1f §22.4。ソロのランでは空の配列） */
  party: ObsPartyMember[];
  navigation: {
    here: string;
    passable_dirs: Dir[];
    frontiers: { pos: Pos; dir: Dir | null; dist: number }[];
    /** path_len: 既知地図上の経路長（不明なら null） */
    /** occupied_by: 階段の上に見えている敵の ID（travel_to はふさがれて止まる。V3-7a 後の評価） */
    /** sealed: 大守護者を倒していない節目の下り階段（V4-1a §12.4） */
    /** public_by: シーズンで公開された下り階段で、まだ自分の目で見ていない（S0 §9.4。途中の道は分からない） */
    known_stairs: { type: 'down' | 'up'; pos: Pos; dist: number; reachable: boolean; path_len: number | null; occupied_by?: string; sealed?: true; public_by?: string }[];
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
  /** シーズン（S0。PROTOCOL §9.6。シーズンのランだけ）。賞と報告していない階段はキャンプでだけ */
  season?: ObsSeason;
  /** 区切り（S7。SEASON.md §52.2 の 1。キャンプにいるときだけ）: 決まった 1 段・覚え書きの定型（項目の名前だけ）・今あるメモ */
  checkpoint?: ObsCheckpoint;
}

/**
 * 区切り（S7 §52.2 の 1）。すべてのプレイヤーに同じ文。text: 決まった 1 段。template: 覚え書きの定型の項目の名前（中身は書かない）。
 * notes: 今あるメモを新しい順に CHECKPOINT_NOTES 件まで（index は notes ツールの番号。remove に使える）。notes_total: メモの全部の数
 */
export interface ObsCheckpoint { text: string; template: string[]; notes: { index: number; text: string }[]; notes_total: number }

/** キャンプの観測に出すメモの数（新しい順。S7 §52.2 の 1） */
export const CHECKPOINT_NOTES = 8;

/** 覚え書きの定型の項目の名前（S7 §52.2 の 1。notes の add の文の先頭に付けて書ける） */
export function checkpointTemplate(L: Locale): string[] {
  return L === 'en'
    ? ['next aim', 'learned (foes, items, terrain)', 'still unknown', 'what you gave up on before, and why (does it still hold?)']
    : ['次のねらい', '分かったこと（相手・品・地形）', 'まだ分からないこと', '前にやめたことと、その根拠（今も成り立つか）'];
}

/** 区切り（S7 §52.2 の 1）: キャンプの観測の終わりの 1 段と、覚え書きの定型と、今あるメモ（新しい順に 8 件まで） */
export function checkpointObs(L: Locale, notes: readonly string[]): ObsCheckpoint {
  const shown = notes.map((text, index) => ({ index, text })).reverse().slice(0, CHECKPOINT_NOTES);
  return {
    text: t(L,
      'ここは遠征の区切り。今の状態は、この表示が正本（持ち物・装備・能力・順位・次の候補）。これより前の経過は、次の判断に要らない。次の遠征に持ち越したいことは、notes に書けば、キャンプと resume_run で返す',
      'This is a break between expeditions. This display is the source of truth for where you stand now (inventory, equipment, stats, standings, next offers). What happened before is not needed for your next decision. Anything you want to carry into the next expedition, write with notes: camp and resume_run give it back'),
    template: checkpointTemplate(L),
    notes: shown,
    notes_total: notes.length,
  };
}

/** キャンプの「できること」の notes の行（S7 §52.2 の 1。そのまま呼べる形） */
export function notesActionLine(L: Locale): string {
  return t(L,
    'notes { add: "次のねらい: …" }（自分用メモを書く。手番を使わない。先頭に覚え書きの定型の項目の名前。キャンプと resume_run で返る。消すのは notes { remove: 番号 }）',
    'notes { add: "next aim: ..." } (write a note for yourself; free; start it with a template item name; camp and resume_run give it back; delete with notes { remove: number })');
}

/** 遠征の途中の区切り（S7 §52.2 の 2）: 自分の手番で 100 手番ごとに、敵が見えていないときに 1 回だけ、観測の「変化」の行に出す文 */
export const CHECKPOINT_EVERY = 100;
export function checkpointChangeText(L: Locale): string {
  return t(L, `区切り（${CHECKPOINT_EVERY} 手番）。今の観測が正本。これより前の経過は、要らない`, `Checkpoint (${CHECKPOINT_EVERY} turns). This observation is the source of truth; what came before is not needed`);
}

export interface ObsSeason {
  id: string;
  name: string;
  budget: { left: number; limit: number };
  /** 終わりの時刻を過ぎた（新しい遠征は始められない） */
  ended: boolean;
  awards?: (SeasonAward & { text: string })[];
  /** まだ報告していない階段と、そのうちまだだれも公開していないもの */
  stairs?: { unreported: number; unpublished: number };
  /** まだ報告していない特別な場所（祭壇・賭けの祭壇・碑文。S1c §14.5）と、そのうちまだだれも公開していないもの（キャンプだけ） */
  spots?: { unreported: number; unpublished: number };
  /** 前の取り込みから新しく自分の野営の火を使った者（キャンプだけ。S1c §14.4 の 7） */
  fire_news?: { depth: number; x: number; y: number; names: string[]; text: string }[];
  /** 迷宮で、いま火を置けるマスにいるとき: 支援賞の行と自分の火の数（S1c §14.4 の 7） */
  support?: { placed: number; limit: number; text: string };
  /** 自分の野営の火（キャンプだけ。S1 §9.10）: uses は支援賞に数えた回数、まだ共有層に載っていない火は null */
  fires?: { depth: number; x: number; y: number; uses: number | null; dup?: true }[];
  fires_text?: string;
  /** この遠征で野営の火を使った階（迷宮の中。S1 §8.3） */
  fire_used?: { depths: number[]; text: string };
  /**
   * 補給の置き場（S3。SEASON.md §25.2）。迷宮で、置き場（階段の上・火の上か隣）にいるとき: 置き場・中身（id・名前・預けた者）・上限・この遠征で取ったか。
   * 中身の名前は、預けた者か自分が鑑定済みなら種類、ほかは外見
   */
  supply?: { place: SupplyPlace; at: [number, number]; items: { id: string; name: string; by: string; mine: boolean }[]; count: number; cap: number; taken_this_expedition: boolean; text: string };
  /** 迷宮で、この階の知っている置き場のうち、品のあるもの（S3）。hidden: まだ場所を知らない置き場（下り階段）にある品の数 */
  caches?: { place: SupplyPlace; at: [number, number]; items: { id: string; name: string; by: string }[] }[];
  caches_hidden?: number;
  caches_text?: string;
  /** キャンプ（S3）: 自分の預けた品のうち、まだだれも取っていないもの（まだ共有層に載っていない品は local） */
  deposits?: { depth: number; place: SupplyPlace; name: string; local: boolean }[];
  deposits_text?: string;
  /** キャンプ（S3）: 前の取り込みから、ほかの参加者が取った自分の品 */
  supply_news?: { depth: number; place: SupplyPlace; name: string; taker: string; text: string }[];
  /** キャンプ（S5b）: 前のキャンプの後に初めて受け取った討伐の記録（そのキャンプの間だけ。次の遠征の後には出ない） */
  slay_news?: { depth: number; by: string; text: string }[];
  /** 予算の 1 行 */
  text: string;
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
  /**
   * キャンプ: 直前の遠征の比較（遠征レポートから。V3-6 §35.9）。wardens: その遠征で戦って倒さずに帰った節目の大守護者への自分の挑戦
   * （S5 §47.4 の 2。サーバーがそのランの出来事の記録から、討伐の記録と同じ作り方で作る。共有しない）
   */
  campCompare?: { no: number; lines: string[]; compare?: ReportCompare; wardens?: SeasonSlayFacts[] };
  /**
   * キャンプ: 大守護者の候補に添える、そのランでその大守護者に挑んで退いた、いちばん新しい挑戦（S5b。深さごと。サーバーがそのランの記録から作る。共有しない）
   */
  wardenPrev?: Record<number, { no: number; facts: SeasonSlayFacts }>;
  /** キャンプ: 前のキャンプの後に初めて受け取った討伐の記録（S5b。サーバーがそのランの取り込みの記録から決める。1 つのキャンプの間だけ） */
  slayNews?: SeasonSlay[];
  /**
   * キャンプ: 記録庫の討伐の記録を全文で出す節目（S6 §49.5 の 3・4）。そのキャンプで初めて見る記録のある、まだ倒していない節目
   * （知らせの出る記録と、ランの最初のキャンプで取り込んであった記録）。ほかは 1 行にたたむ
   */
  slayFullDepths?: number[];
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

/** 自分以外の参加者（V4-1f §22.4）。階・状態・HP の段階は view.party（いつでも）。位置は同じ階なら見えていなくても（V4-1k §32.3）。エンティティは見えている者（view.entities）からだけ */
export function partyOf(view: PlayerView): ObsPartyMember[] {
  const out: ObsPartyMember[] = [];
  view.party.forEach((p, i) => {
    if (p.playerId === view.playerId) return;
    const status: ObsPartyMember['status'] = p.state === 'alive' ? 'in_dungeon' : p.state === 'at_camp' ? 'at_camp' : p.state === 'dead' ? 'down' : 'left';
    const seen = status === 'in_dungeon' ? view.entities.find((e) => e.cat === 'player' && e.id === p.entityId) : undefined;
    out.push({
      id: p.playerId, name: p.name, controller: p.controller.kind, order: i + 1, status,
      ...(status === 'in_dungeon' && p.depth !== null ? { floor: p.depth } : {}),
      // HP の段階は、迷宮にいれば見えていなくても（V4-1g G3）。位置とエンティティは見えているときだけ
      ...(status === 'in_dungeon' && (p.hp ?? seen?.hp) ? { hp: (p.hp ?? seen?.hp)! } : {}),
      // 位置は同じ階なら見えていなくても（V4-1k §32.3）。エンティティ ID は見えているときだけ
      ...(status === 'in_dungeon' && (seen?.pos ?? p.pos) ? { pos: [(seen?.pos ?? p.pos)!.x, (seen?.pos ?? p.pos)!.y] as [number, number] } : {}),
      ...(seen ? { entity: seen.id } : {}),
      last_act: p.lastAct,
    });
  });
  return out;
}

/** 「（あなたの火 1/3・あと 2 つ置ける）」（S1c §14.4 の 7） */
function fireCountText(L: Locale, n: number, limit: number): string {
  return t(L, `（あなたの火 ${n}/${limit}・あと ${Math.max(0, limit - n)} つ置ける）`, ` (your campfires ${n}/${limit}; ${Math.max(0, limit - n)} left to set)`);
}

/** シーズン（S0。PROTOCOL §9.6）: 予算はいつも、賞と報告していない階段はキャンプでだけ。fireLimit: シーズンで置ける火の数（catalog の rules.seasonFire） */
export function seasonObs(view: PlayerView, fireLimit?: number): ObsSeason | null {
  const s = view.season;
  if (!s) return null;
  const L = view.locale;
  const camp = view.status === 'at_camp';
  // 野営の火（S1 §9.10）: キャンプでは自分の火と使われた回数、迷宮ではこの遠征で火を使った階
  const fires = camp ? myCampfires(s) : [];
  const xno = view.expedition && view.expedition.status !== 'ended' ? view.expedition.no : null;
  const used = camp ? [] : fireUsedDepths(s, xno);
  const fireText = (f: { depth: number; x: number; y: number; uses: number | null; dup?: true }) => f.dup
    ? t(L, `地下${f.depth}階 (${f.x},${f.y}) 同じマスにほかの者の火が先に載った（あなたの火として数える）`, `depth ${f.depth} (${f.x},${f.y}) another participant's campfire was shared there first (still counts as yours)`)
    : f.uses === null
    ? t(L, `地下${f.depth}階 (${f.x},${f.y}) まだ載っていない`, `depth ${f.depth} (${f.x},${f.y}) not yet shared`)
    : t(L, `地下${f.depth}階 (${f.x},${f.y}) 支援 ${f.uses} 回`, `depth ${f.depth} (${f.x},${f.y}) supported ${f.uses}`);
  // 支援賞の行に、自分の火の数と残り（S1c §14.4 の 7）
  const limit = fireLimit ?? null;
  const supportText = (a: SeasonAward) => (a.id === 'support' && limit !== null ? `${awardText(L, a)}${fireCountText(L, myCampfires(s).length, limit)}` : awardText(L, a));
  const news = camp ? (s.fireNews ?? []).map((n) => ({ ...n, names: [...n.names], text: t(L, `知らせ: あなたの野営の火（地下${n.depth}階 (${n.x},${n.y})）を ${n.names.join('・')} が使った（支援賞 +${n.names.length}）`, `News: ${n.names.join(', ')} used your campfire (depth ${n.depth} (${n.x},${n.y})) (support +${n.names.length})`) })) : [];
  return {
    id: s.id, name: s.name, budget: { left: Math.max(0, s.budgetLeft), limit: s.budget.limit }, ended: s.ended,
    ...(camp ? { awards: s.awards.map((a) => ({ ...a, leader: a.leader ? { ...a.leader } : null, text: supportText(a) })), stairs: { unreported: s.unreported, unpublished: s.unpublished }, spots: { unreported: s.spotsUnreported ?? 0, unpublished: s.spotsUnpublished ?? 0 } } : {}),
    ...(news.length ? { fire_news: news } : {}),
    ...(fires.length ? { fires, fires_text: t(L, `あなたの野営の火: ${fires.map(fireText).join('／')}`, `Your campfires: ${fires.map(fireText).join(' / ')}`) } : {}),
    ...(used.length ? { fire_used: { depths: used, text: t(L, `この遠征で野営の火を使った階: ${used.map((d) => `地下${d}階`).join('・')}（その階の火は、もう使えない）`, `Campfires used this expedition on: ${used.map((d) => `depth ${d}`).join(', ')} (no more there)`) } } : {}),
    text: seasonBudgetText(L, s.name, s.budgetLeft, s.budget.limit),
  };
}

/** 仲間の 1 行（V4-1f §22.4。「仲間: ○○（地下 1 階）、△△（キャンプ）」） */
export function partyText(L: Locale, party: readonly ObsPartyMember[]): string {
  if (!party.length) return '';
  const one = (m: ObsPartyMember) => {
    const where = m.status === 'in_dungeon' ? (m.floor !== undefined ? t(L, `地下 ${m.floor} 階`, `depth ${m.floor}`) : t(L, '迷宮', 'in the dungeon'))
      : m.status === 'at_camp' ? t(L, 'キャンプ', 'at camp') : m.status === 'down' ? t(L, '倒れている', 'down') : t(L, 'ランを抜けた', 'left the run');
    const hp = m.hp ? t(L, `・${HP_JA[m.hp]}`, `, ${m.hp}`) : '';
    // 見えている（entity がある）か、同じ階で見えていないか（位置だけ。V4-1k §32.3）
    const seen = m.pos ? (m.entity ? t(L, `・見えている (${m.pos[0]},${m.pos[1]})`, `, in view (${m.pos[0]},${m.pos[1]})`) : t(L, `・(${m.pos[0]},${m.pos[1]})`, `, at (${m.pos[0]},${m.pos[1]})`)) : '';
    return `${m.name}${m.controller === 'human' ? t(L, '［人間］', ' [human]') : m.controller === 'unknown' ? t(L, '［不明］', ' [unknown]') : ''}（${where}${hp}${seen}）`;
  };
  return t(L, `仲間: ${party.map(one).join('、')}`, `Party: ${party.map(one).join(', ')}`);
}
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

/**
 * 種族の体力の記録の文（S4 §42.2 の 3）: 2 体以上は「およそ N（a〜b。M 体の記録）」（N は幅のまん中。守護者の候補の「およそ」と同じ形）、
 * 全部同じなら「7（2 体とも）」、1 体だけなら「7（1 体の記録）」。記録が HP_RECORD_SURE 体未満なら「個体差あり」を添える
 */
export function hpRecordText(L: Locale, hs: { min: number; max: number; samples: number }): string {
  const few = hs.samples < HP_RECORD_SURE;
  const fewJa = few ? '。個体差あり' : '';
  const fewEn = few ? '; individuals vary' : '';
  if (hs.samples <= 1) return t(L, `${hs.max}（1 体の記録${fewJa}）`, `${hs.max} (one recorded${fewEn})`);
  if (hs.min === hs.max) return t(L, `${hs.min}（${hs.samples} 体とも${fewJa}）`, `${hs.min} (all ${hs.samples} recorded${fewEn})`);
  const mid = Math.trunc((hs.min + hs.max) / 2);
  return t(L, `およそ ${mid}（${hs.min}〜${hs.max}。${hs.samples} 体の記録${fewJa}）`, `about ${mid} (${hs.min}-${hs.max}; ${hs.samples} recorded${fewEn})`);
}

export function hpEstimateText(locale: Locale, est: { min: number; max: number | null; samples: number; record?: { min: number; max: number }; untouched?: boolean }): string {
  const recText = est.record ? hpRecordText(locale, { ...est.record, samples: est.samples }) : '';
  const few = est.samples < HP_RECORD_SURE;
  // まだ当てていない相手には「残り」と言わない（V4-0b §1.5）: 体力の記録の範囲をそのまま出す
  if (est.untouched && recText) return t(locale, `体力の記録 ${recText}／まだ傷を負っていない`, `HP record ${recText} / unhurt so far`);
  // 上限を出さないとき（記録が少ない）は根拠を添える: 見えている傷の具合と、体力の記録の最小から
  if (est.max === null && est.record) {
    return t(locale, `記録どおりなら残り ${est.min} 以上（傷の具合と、体力の記録の最小 ${est.record.min} から）／体力の記録 ${recText}`,
      `if typical, >= ${est.min} left (from its wounds and the smallest HP on record, ${est.record.min}) / HP record ${recText}`);
  }
  const tail = recText ? t(locale, `／体力の記録 ${recText}`, ` / HP record ${recText}`) : t(locale, `（記録 ${est.samples} 体${few ? '。個体差あり' : ''}）`, ` (${est.samples} recorded${few ? '; individuals vary' : ''})`);
  const range = est.max === null ? t(locale, `${est.min} 以上`, `>= ${est.min}`) : est.min === est.max ? `${est.min}` : t(locale, `${est.min}〜${est.max}`, `${est.min}-${est.max}`);
  return t(locale, `記録どおりなら残り ${range}${tail}`, `if typical, ${range} left${tail}`);
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
  // 記録が 5 体未満の間は、幅を確定値のように見せない（種族の体力はダイスで振られる。V3-3 の設計の指示）。
  // 2 体以上は「およそ N（a〜b）」、1 体だけなら「1 体の記録」と添える（S4 §42.2 の 3）
  const hp = mem.hpSeen ? hpRecordText(L, mem.hpSeen) : t(L, '記録なし', 'none');
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

/**
 * 命中の記録の文（「この種族の記録: あなたの命中 近接1/6・相手の命中 3/5」）。記録は種族ごと（守護者なら守護者のその種族）の、ランを通した数で、
 * 目の前の 1 体の数ではない。文の頭でそう分かるようにする（V4-1m §39.1: 「1 体に 350〜390 回当てた」と読まれた）。guardian: 守護者の記録（role が guardian）
 */
export function hitsText(L: Locale, h: ObsMonster['hits'], guardian = false): string {
  if (!h) return '';
  const parts: string[] = [];
  if (h.your_melee) parts.push(t(L, `あなたの命中 近接${h.your_melee[0]}/${h.your_melee[1]}`, `your hits melee ${h.your_melee[0]}/${h.your_melee[1]}`));
  if (h.your_thrown) parts.push(t(L, `${h.your_melee ? '投擲' : 'あなたの命中 投擲'}${h.your_thrown[0]}/${h.your_thrown[1]}`, `${h.your_melee ? 'thrown' : 'your hits thrown'} ${h.your_thrown[0]}/${h.your_thrown[1]}`));
  if (h.theirs) parts.push(t(L, `相手の命中 ${h.theirs[0]}/${h.theirs[1]}`, `its hits ${h.theirs[0]}/${h.theirs[1]}`));
  if (!parts.length) return '';
  const head = guardian ? t(L, 'この種族の守護者の記録: ', "record for this species' guardians: ") : t(L, 'この種族の記録: ', "this species' record: ");
  return head + parts.join(L === 'en' ? ', ' : '・');
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
  /** 被害の見込み（S1c §14.4 の 1。いちばん重い 1 体は最大の一撃、残りは平均の被害。平均の記録が無ければ最大） */
  expected: number;
  /** 自分の歩く速さより速い近接の敵の数 */
  catchers: number;
  shooters: number;
}

/** 階段まで steps 歩く間の最悪の被害（V3-4b §28.5）: 敵ごとに「歩く間の攻撃回数 × 受けた最大の一撃」の合計 */
export function chaseEstimate(view: PlayerView, catalog: Catalog, hunters: readonly ObsMonster[], steps: number): ChaseEstimate {
  let worst = 0, catchers = 0, shooters = 0;
  const per: { w: number; p: number; a: number }[] = [];
  for (const m of hunters) {
    const e = view.entities.find((x) => x.id === m.id);
    if (!e) continue;
    const ranged = m.traits.includes('ranged');
    if (ranged) shooters++;
    const extra = chaseAttacks(view, catalog, e, steps, { ranged, adjacent: false });
    if (!ranged && extra > 0) catchers++;
    const hits = chaseAttacks(view, catalog, e, steps, { ranged, adjacent: m.dist <= 1 });
    const mem = memoryOf(view, e);
    if (mem && mem.maxDamageToYou > 0) {
      const w = hits * mem.maxDamageToYou;
      // 会心でない最大（S6 §49.6 の 10。fight の見込みと同じ: S1d §17.2）
      const p = hits * (mem.maxPlainToYou && mem.maxPlainToYou > 0 ? mem.maxPlainToYou : mem.maxDamageToYou);
      worst += w;
      per.push({ w, p, a: Math.min(p, avgHitsOf(view, e, hits) ?? p) });
    }
  }
  // 見込み（S1c §14.4 の 1・S6: fight の見込みと同じ）: いちばん重い 1 体は会心でない最大の一撃、残りは平均の被害。最悪は全員が最大の一撃（会心を含む）
  per.sort((a, b) => b.p - a.p);
  const expected = per.length ? per[0].p + per.slice(1).reduce((s, x) => s + x.a, 0) : 0;
  return { recordedWorst: worst, worst, expected, catchers, shooters };
}

/**
 * 候補の守護者の、通る目安に使う体力（傷跡の分を引く）。格 1〜3 は候補の目安、大守護者は記録庫の記憶（V3-3a §35.7）で分かっていれば。
 * 分からなければ undefined（命中の回数を出さない）
 */
export function offerGuardianHp(view: PlayerView, o: ExpeditionOffer): number | undefined {
  const hp = o.guardian?.hp ?? (o.objective.type === 'slay_warden' && o.objective.targetDepth !== null ? view.wardenIntel?.[String(o.objective.targetDepth)]?.hp : undefined);
  return hp !== undefined ? Math.max(1, hp - (o.scar ?? 0)) : undefined;
}

/** 節目の文（「次の節目: 地下5階の大守護者「呼び集める者ヴォルン」（型: 呼び集める者・突き進む者。未踏破）」） */
/** いまの持ち物で、その装甲に 1 回に通るダメージの目安（近接の武器と、持っている投擲物。急所狙いの分を引く。V3-3b §40.1） */
/** types: 相手の型（護られし者なら、護りの火が灯っている間に装甲が上がることを 1 句添える。S3b §30.3 の 4） */
export function gearVsArmorText(L: Locale, catalog: Catalog, view: PlayerView, armor: number, hp?: number, types: readonly string[] = []): string {
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
  const ward = types.map((id) => catalog.guardianTypes[id]).find((g) => g?.handler === 'warded');
  const wardText = ward ? t(L, `。護りの火が灯っている間は、装甲がさらに +${ward.armor ?? 4}（その間の通りは、これより少ない）`, `; while a ward fire burns its armor is +${ward.armor ?? 4} more (less gets through meanwhile)`) : '';
  return t(L, `いまの持ち物で 1 回に通る目安: ${parts.join('・')}（会心・型の効果を除く）${wardText}`, `per hit with your gear: ${parts.join(', ')} (before crits and type effects)${wardText}`);
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
  const gear = intel?.armor !== undefined && view && !cleared.includes(m.depth) ? t(L, `。${gearVsArmorText(L, catalog, view, intel.armor, intel.hp, m.types)}`, `; ${gearVsArmorText(L, catalog, view, intel.armor, intel.hp, m.types)}`) : '';
  const memText = mem.length ? t(L, `。記録庫の記憶: ${mem.join('・')}${gear}`, `; the archive remembers: ${mem.join(', ')}${gear}`) : '';
  return {
    depth: m.depth, name, types, cleared: done,
    ...(intel && (intel.weakness || intel.hp !== undefined) ? { memory: { ...(intel.weakness ? { weakness: intel.weakness } : {}), ...(intel.hp !== undefined ? { hp: intel.hp, max_hit: intel.maxHit } : {}), ...(intel.armor !== undefined ? { armor: intel.armor } : {}) } } : {}),
    text: t(L, `次の節目: 地下${m.depth}階の大守護者「${name}」（型: ${types.map((x) => x.name).join('・') || 'なし'}。${done ? '踏破済み' : `未踏破。倒すまでその階の下り階段は封じられている。倒すと加護を ${opts} つの候補から 1 つ選べる`}${memText}）`,
      `Next milestone: the warden "${name}" on depth ${m.depth} (types: ${types.map((x) => x.name).join('/') || 'none'}; ${done ? 'cleared' : `not cleared; its stairs down stay sealed until it falls; slay it to choose 1 of ${opts} boons`}${memText})`),
  };
}

/** 1 回あたり（小数 1 桁。整数で数える） */
function perHit(total: number, n: number): string {
  const t10 = Math.trunc((total * 10 + Math.trunc(n / 2)) / Math.max(1, n));
  return `${Math.trunc(t10 / 10)}.${t10 % 10}`;
}

/** 予備動作の名前（S5。Intent の kind ごと。観測の intent の文と同じ呼び方） */
function tellName(L: Locale, kind: string): string {
  return kind === 'winding_up' ? t(L, '突進の構え', 'charge wind-up') : kind === 'swinging' ? t(L, '大振りの構え', 'heavy-swing wind-up')
    : kind === 'summoning' ? t(L, '手下を呼ぶ構え', 'minion call') : kind === 'enraging' ? t(L, '怒りの予兆', 'rage sign') : kind;
}

/** 予備動作への対し方の文（S5）。記録に項目が無ければ空 */
/** 予備動作の名前の複数形（英語の見出し用。S5c） */
function tellPlural(L: Locale, kind: string): string {
  return L === 'en' ? `${tellName(L, kind)}s` : tellName(L, kind);
}
const isStrike = (kind: string) => kind === 'winding_up' || kind === 'swinging';

/** 予備動作への対し方の文（S5・S5c）: 見えていた構え（seen）だけで書く（見えていなかった構えのことは言わない）。記録に項目が無ければ空 */
function tellsText(L: Locale, tells: SeasonSlayFacts['tells']): string {
  if (!tells) return '';
  const xs = tells.filter((x) => x.seen > 0);
  if (!xs.length) return t(L, '予備動作の構え 0 回', 'no wind-ups');
  return xs.map((x) => isStrike(x.kind)
    ? t(L, `${tellName(L, x.kind)}を ${x.seen} 回見て、${x.missed} 回外させ、${x.hit} 回受けた`, `${tellPlural(L, x.kind)}: saw ${x.seen}, ${x.missed} missed, ${x.hit} hit you`)
    : t(L, `${tellName(L, x.kind)}を ${x.seen} 回見た`, `${tellPlural(L, x.kind)}: saw ${x.seen}`)).join(t(L, '・', '; '));
}

/**
 * 相手が動けなかった手番の文（S5・S5a）: 「予備動作を外させた後の 11 手番: 与えた被害 23（当てた手番 7）・受けた被害 0。それ以外の手番: 与えた被害 67・受けた被害 61」。
 * 手番が 0 の区分は出さない（どちらも 0 なら文ごと出さない）。記録に項目が無ければ空
 */
function openingsText(L: Locale, op: ObsSlay['openings']): string {
  if (!op || (!op.missed.turns && !op.other.turns)) return '';
  const one = (o: ObsOpening) => t(L, `与えた被害 ${o.dealt}${o.hit_turns ? `（当てた手番 ${o.hit_turns}）` : ''}・受けた被害 ${o.taken}`, `dealt ${o.dealt}${o.hit_turns ? ` (landed in ${o.hit_turns})` : ''}, took ${o.taken}`);
  const parts = [
    op.missed.turns ? t(L, `予備動作を外させた後の ${op.missed.turns} 手番: ${one(op.missed)}`, `${op.missed.turns} turn${op.missed.turns > 1 ? 's' : ''} after a missed wind-up: ${one(op.missed)}`) : '',
    op.other.turns ? t(L, `眠りなどで相手が動けなかった ${op.other.turns} 手番: ${one(op.other)}`, `${op.other.turns} turn${op.other.turns > 1 ? 's' : ''} it could not act otherwise (asleep etc.): ${one(op.other)}`) : '',
    t(L, `それ以外の手番: 与えた被害 ${op.rest.dealt}・受けた被害 ${op.rest.taken}`, `other turns: dealt ${op.rest.dealt}, took ${op.rest.taken}`),
  ].filter(Boolean);
  return parts.join(t(L, '。', '. '));
}

/** 記録庫の、たたんだ 1 行（S6 §49.5 の 3・4）: 「倒した記録 3 件（最初: アオイ・いちばん少ない被害: ナズナ）。全文は records」 */
function slayFoldText(L: Locale, recs: readonly ObsSlay[]): string {
  if (!recs.length) return '';
  const first = recs.find((r) => r.first);
  const least = recs.find((r) => r.least);
  const who = first && least && first === least
    ? t(L, `最初で、いちばん少ない被害: ${first.by}`, `first and least damage taken: ${first.by}`)
    : [first ? t(L, `最初: ${first.by}`, `first: ${first.by}`) : '', least ? t(L, `いちばん少ない被害: ${least.by}`, `least damage taken: ${least.by}`) : ''].filter(Boolean).join(t(L, '・', ', '));
  return t(L, `倒した記録 ${recs[0].of} 件（${who}）。全文は records`, `${recs[0].of} kill record${recs[0].of > 1 ? 's' : ''} (${who}). Full text: records`);
}

/**
 * 討伐の記録と自分の挑戦に共通の中身（S4・S5）: 装備・与えた被害・受けた被害・予備動作・動けなかった手番・品。
 * body は「鎚矛（地下3階で拾った）・革鎧（最初から持っていた）。与えた被害 92（…）。受けた被害 …。…」
 */
function fightCore(L: Locale, catalog: Catalog, s: SeasonSlayFacts): { obs: ObsSlayAttempt; cls: string; body: string } {
  const cls = nameOf(catalog.classes[s.classId]?.name, L, shortId(s.classId));
  const gear = (g: SeasonSlay['weapon']) => (g ? { kind: g.kind, name: itemDisplayName(catalog, L, g.kind, null, g.affixes), got: g.got, ...(g.depth !== undefined ? { depth: g.depth } : {}) } : null);
  const weapon = gear(s.weapon);
  const armor = gear(s.armor);
  const gotText = (g: NonNullable<ReturnType<typeof gear>>) => g.got === 'picked'
    ? t(L, `地下${g.depth ?? '?'}階で拾った`, `picked up on depth ${g.depth ?? '?'}`)
    : g.got === 'supply' ? t(L, `地下${g.depth ?? '?'}階の補給の置き場から取った`, `taken from a supply cache on depth ${g.depth ?? '?'}`)
      : t(L, '最初から持っていた', 'carried from the start');
  const wText = weapon ? `${weapon.name}（${gotText(weapon)}）` : t(L, '素手', 'bare hands');
  const aText = armor ? `${armor.name}（${gotText(armor)}）` : t(L, '鎧なし', 'no armor');
  const hiddenText = s.hidden ? t(L, '（未鑑定の装備は載せていない）', ' (unidentified gear not recorded)') : '';
  const d = s.dealt;
  const dealtParts: string[] = [];
  if (d.melee.n) dealtParts.push(t(L, `近接 ${d.melee.n} 回・1 回あたり ${perHit(d.melee.total, d.melee.n)}`, `melee ${d.melee.n} hits, ${perHit(d.melee.total, d.melee.n)} each`));
  if (d.thrown.n) dealtParts.push(t(L, `投擲 ${d.thrown.n} 回・1 回あたり ${perHit(d.thrown.total, d.thrown.n)}`, `thrown ${d.thrown.n} hits, ${perHit(d.thrown.total, d.thrown.n)} each`));
  if (d.poison.n) dealtParts.push(t(L, `毒 ${d.poison.total}（${d.poison.n} 回）`, `poison ${d.poison.total} (${d.poison.n} ticks)`));
  if (d.feature.n) dealtParts.push(t(L, `地物（脆い天井など） ${d.feature.total}（${d.feature.n} 回）`, `features (brittle ceilings etc.) ${d.feature.total} (${d.feature.n})`));
  if (d.crits) dealtParts.push(t(L, `近接の会心 ${d.crits}`, `${d.crits} melee crits`));
  const total = d.melee.total + d.thrown.total + d.poison.total + d.feature.total;
  const names = (xs: { kind: string; n: number }[]) => xs.map((x) => ({ kind: x.kind, name: nameOf(catalog.items[x.kind]?.name, L, shortId(x.kind)), n: x.n }));
  const used = names(s.used);
  const thrown = names(s.thrown);
  const abilities = s.abilities.map((x) => ({ id: x.id, name: nameOf(catalog.abilities[x.id]?.name, L, shortId(x.id)), n: x.n }));
  const list = (xs: { name: string; n: number }[]) => xs.map((x) => `${x.name} ${x.n}`).join(t(L, '・', ', '));
  const extra = [
    wardFireText(L, s.wardenStart?.firesLit, s.wardFires),
    used.length ? t(L, `使った品: ${list(used)}`, `used: ${list(used)}`) : t(L, '使った品なし', 'no items used'),
    thrown.length ? t(L, `投げた品: ${list(thrown)}`, `thrown: ${list(thrown)}`) : '',
    abilities.length ? t(L, `能動技: ${list(abilities)}`, `abilities: ${list(abilities)}`) : '',
  ].filter(Boolean);
  // 予備動作と、相手が動けなかった手番（S5）: 記録に項目が無ければ（S5 より前の記録）出さない
  const tells = s.tells?.map((x) => ({ kind: x.kind, name: tellName(L, x.kind), n: x.n, seen: x.seen, missed: x.missed, hit: x.hit }));
  const op = s.openings;
  const ob = (o: SlayOpening): ObsOpening => ({ turns: o.turns, dealt: o.dealt, hit_turns: o.hitTurns, taken: o.taken });
  const openings = op ? {
    missed: ob(op.missed), other: ob(op.other),
    rest: { dealt: Math.max(0, total - op.missed.dealt - op.other.dealt), taken: Math.max(0, s.taken - op.missed.taken - op.other.taken) },
  } : undefined;
  const fight = [scarText(L, s.wardenStart), tellsText(L, s.tells), openingsText(L, openings)].filter(Boolean);
  const body = t(L,
    `${wText}・${aText}${hiddenText}。与えた被害 ${total}（${dealtParts.join('、') || 'なし'}）。受けた被害 ${s.taken}${s.lowestPct !== undefined ? `（HP がいちばん減って ${s.lowestPct}%）` : ''}。${fight.map((x) => `${x}。`).join('')}${extra.join('。')}`,
    `${wText}, ${aText}${hiddenText}. Dealt ${total} (${dealtParts.join(', ') || 'none'}). Took ${s.taken}${s.lowestPct !== undefined ? ` (lowest HP ${s.lowestPct}%)` : ''}. ${fight.map((x) => `${x}. `).join('')}${extra.join('. ')}`);
  const ws = s.wardenStart;
  return {
    cls, body,
    obs: {
      depth: s.depth, level: s.level, class: cls, weapon, armor, ...(s.hidden ? { hidden: true } : {}),
      dealt: { melee: { ...d.melee }, thrown: { ...d.thrown }, poison: { ...d.poison }, feature: { ...d.feature }, crits: d.crits },
      taken: s.taken, ...(s.lowestPct !== undefined ? { lowest_pct: s.lowestPct } : {}), used, thrown, abilities, ward_fires: s.wardFires, attempt: s.attempt, turns: s.turns,
      ...(tells ? { tells } : {}), ...(openings ? { openings } : {}),
      ...(ws ? { warden_start: { scar: ws.scar, ...(ws.firesLit !== undefined ? { fires_lit: ws.firesLit } : {}) } } : {}), text: '',
    },
  };
}

/**
 * 戦いが始まったときの相手の傷跡の句（S6・S6a）: 「相手は、傷跡で体力 −39 から」。傷跡が無い・記録に項目が無ければ空。
 * 始めの体力は出さない（S6a §50.4: 倒していない相手の体力になる）
 */
function scarText(L: Locale, ws: SeasonSlayFacts['wardenStart']): string {
  return ws && ws.scar > 0 ? t(L, `相手は、傷跡で体力 −${ws.scar} から`, `it started scarred −${ws.scar} HP`) : '';
}

/**
 * 護りの火の句（S6a §50.4）: 「戦い始めに 1 つ灯っていた・この挑戦で 1 つ消した」（前の挑戦で消えたままなら「戦い始めに灯っていた火 0」）。
 * 戦い始めの数は、その遠征で自分が見た火だけ（見ていなければ省く）。どちらも無ければ空。評価の言葉（「消してから」など）は付けない
 */
function wardFireParts(L: Locale, lit: number | undefined, out: number): string {
  return [
    lit === undefined ? '' : lit === 0 ? t(L, '戦い始めに灯っていた火 0', 'none lit when the fight began') : t(L, `戦い始めに ${lit} つ灯っていた`, `${lit} lit when the fight began`),
    out ? t(L, `この挑戦で ${out} つ消した`, `${out} put out in this attempt`) : '',
  ].filter(Boolean).join(t(L, '・', ', '));
}
function wardFireText(L: Locale, lit: number | undefined, out: number): string {
  const p = wardFireParts(L, lit, out);
  return p ? t(L, `護りの火: ${p}`, `ward fires: ${p}`) : '';
}

/** 討伐の記録の 1 件の観測（S4。SEASON.md §35.5）。文は「Aya（Lv6・戦士）: 鎚矛（地下3階で拾った）・革鎧（最初から持っていた）。与えた被害 92（近接 11 回・1 回あたり 8.2…）…」 */
export function slayObs(L: Locale, catalog: Catalog, s: SeasonSlay): ObsSlay {
  const c = fightCore(L, catalog, s);
  const who = `${s.by}${s.mine ? t(L, '（あなた）', ' (you)') : ''}`;
  const text = t(L,
    `${who}（Lv${s.level}・${c.cls}）: ${c.body}。倒したランの中で ${s.attempt} 回目の挑戦（それより前のランの挑戦は数えない）・遠征の ${s.turns} 手番目に倒した`,
    `${who} (Lv${s.level} ${c.cls}): ${c.body}. Slain on attempt ${s.attempt} within that run (attempts in earlier runs not counted), ${s.turns} turns into the expedition`);
  return { ...c.obs, by: s.by, ...(s.mine ? { mine: true } : {}), ...(s.first ? { first: true } : {}), ...(s.least ? { least: true } : {}), of: s.of, text };
}

/** 倒さずに帰った自分の挑戦の観測（S5 §47.4 の 2）。文は討伐の記録と同じ並び（「あなた（Lv6・戦士）: …。このランの中で 1 回目の挑戦・遠征の 78 手番目まで戦い、倒さずに帰った」） */
export function slayAttemptObs(L: Locale, catalog: Catalog, s: SeasonSlayFacts): ObsSlayAttempt {
  const c = fightCore(L, catalog, s);
  const text = t(L,
    `あなた（Lv${s.level}・${c.cls}）: ${c.body}。このランの中で ${s.attempt} 回目の挑戦・遠征の ${s.turns} 手番目まで戦い、倒さずに帰った`,
    `You (Lv${s.level} ${c.cls}): ${c.body}. Attempt ${s.attempt} in this run; fought until turn ${s.turns} of the expedition and came back without slaying it`);
  return { ...c.obs, text };
}

/** 討伐の記録 1 件の見出し（「先に倒した者（倒した記録 2 件）」「いちばん少ない被害で倒した者」） */
function slayLabel(L: Locale, r: ObsSlay): string {
  const of = r.of;
  const count = t(L, `（倒した記録 ${of} 件）`, ` (${of} recorded kill${of > 1 ? 's' : ''})`);
  const label = r.first && r.least && of > 1 ? t(L, '先に倒した者（いちばん少ない被害でもある）', 'first to slay it (also the least damage taken)')
    : r.first ? t(L, '先に倒した者', 'first to slay it') : t(L, 'いちばん少ない被害で倒した者', 'slew it taking the least damage');
  return `${label}${r.first ? count : ''}`;
}

/** その節目の討伐の記録の文（最初の 1 件と、いちばん少ない被害の 1 件）。「先に倒した者（倒した記録 2 件）: …／いちばん少ない被害で倒した者: …」 */
export function slayGroupText(L: Locale, recs: readonly ObsSlay[]): string {
  if (!recs.length) return '';
  return recs.map((r) => `${slayLabel(L, r)}: ${r.text}`).join(t(L, '／', ' / '));
}

/**
 * 討伐の記録 1 件の短い文（S5a・S6・S6a。大守護者の候補に出す）。何で倒したか・護りの火から始める:
 * 「アオイ（Lv7・戦士）。小剣の近接だけ・品なし。護りの火: 戦い始めに灯っていた火 0。突進の構えを 5 回外させた。与 51・受 51（相手は、傷跡で体力 −39 から）。5 回目の挑戦」
 */
export function slayShortText(L: Locale, r: ObsSlay): string {
  const d = r.dealt;
  const total = d.melee.total + d.thrown.total + d.poison.total + d.feature.total;
  const who = `${r.by}${r.mine ? t(L, '（あなた）', ' (you)') : ''}`;
  const weapon = r.weapon ? r.weapon.name : t(L, '素手', 'bare hands');
  // 何で倒したか: 与えた被害の出どころ（1 つだけなら「…だけ」）
  const srcs = [
    d.melee.total ? { only: t(L, `${weapon}の近接だけ`, `${weapon} melee only`), part: t(L, `${weapon}の近接 ${d.melee.total}`, `${weapon} melee ${d.melee.total}`) } : null,
    d.thrown.total ? { only: t(L, '投擲だけ', 'thrown only'), part: t(L, `投擲 ${d.thrown.total}`, `thrown ${d.thrown.total}`) } : null,
    d.poison.total ? { only: t(L, '毒だけ', 'poison only'), part: t(L, `毒 ${d.poison.total}`, `poison ${d.poison.total}`) } : null,
    d.feature.total ? { only: t(L, '地物だけ', 'features only'), part: t(L, `地物 ${d.feature.total}`, `features ${d.feature.total}`) } : null,
  ].filter((x): x is { only: string; part: string } => !!x);
  const how = srcs.length === 1 ? srcs[0].only : srcs.map((x) => x.part).join(t(L, '・', ', '));
  const items = [...r.used, ...r.thrown];
  const itemText = items.length ? t(L, `品: ${items.map((x) => `${x.name} ${x.n}`).join('・')}`, `items: ${items.map((x) => `${x.name} ${x.n}`).join(', ')}`) : t(L, '品なし', 'no items');
  // 護りの火（S6a: 戦い始めに灯っていた数・この挑戦で消した数。評価の言葉は付けない）
  const ws = r.warden_start;
  const fires = wardFireText(L, ws?.fires_lit, r.ward_fires);
  const tells = (r.tells ?? []).filter((x) => x.seen > 0).map((x) => (isStrike(x.kind) && x.missed
    ? t(L, `${x.name}を ${x.missed} 回外させた`, `${tellPlural(L, x.kind)}: ${x.missed} missed`)
    : t(L, `${x.name}を ${x.seen} 回見た`, `${tellPlural(L, x.kind)}: saw ${x.seen}`))).join(t(L, '・', '; '));
  const scar = ws && ws.scar > 0 ? t(L, `（${scarText(L, ws)}）`, ` (${scarText(L, ws)})`) : '';
  return t(L,
    `${who}（Lv${r.level}・${r.class}）。${how}・${itemText}。${fires ? `${fires}。` : ''}${tells ? `${tells}。` : ''}与 ${total}・受 ${r.taken}${scar}。${r.attempt} 回目の挑戦`,
    `${who} (Lv${r.level} ${r.class}): ${how}, ${itemText}. ${fires ? `${fires[0].toUpperCase()}${fires.slice(1)}. ` : ''}${tells ? `${tells}. ` : ''}Dealt ${total}, took ${r.taken}${scar}. Attempt ${r.attempt}`);
}

/** 初めて受け取った討伐の記録の知らせ（S5b）: 「新しい討伐の記録: 地下5階の大守護者「キモルカ」を、アカネ（Lv6・戦士・鋭い小剣）が倒した（与えた被害 90・受けた被害 61・突進の構えを 11 回外させた）」 */
export function slayNewsItem(L: Locale, catalog: Catalog, s: SeasonSlay): { depth: number; by: string; text: string } {
  const r = slayObs(L, catalog, s);
  const warden = guardianDisplayName(L, { name: s.warden });
  const total = s.dealt.melee.total + s.dealt.thrown.total + s.dealt.poison.total + s.dealt.feature.total;
  const tells = (s.tells ?? []).filter((x) => isStrike(x.kind) && x.missed > 0)
    .map((x) => t(L, `${tellName(L, x.kind)}を ${x.missed} 回外させた`, `${tellPlural(L, x.kind)}: ${x.missed} missed`));
  const who = `${s.by}${s.mine ? t(L, '（あなた）', ' (you)') : ''}`;
  const text = t(L,
    `新しい討伐の記録: 地下${s.depth}階の大守護者「${warden}」を、${who}（Lv${s.level}・${r.class}${r.weapon ? `・${r.weapon.name}` : ''}）が倒した（与えた被害 ${total}・受けた被害 ${s.taken}${tells.map((x) => `・${x}`).join('')}）`,
    `New warden kill record: ${who} (Lv${s.level} ${r.class}${r.weapon ? `, ${r.weapon.name}` : ''}) slew "${warden}" on depth ${s.depth} (dealt ${total}, took ${s.taken}${tells.map((x) => `, ${x}`).join('')})`);
  return { depth: s.depth, by: s.by, text };
}

/** 大守護者の候補に出す短い文（S5a・S6）:「先に倒した者（倒した記録 2 件）: …／いちばん少ない被害で倒した者: …。全文は records」。全文は records ツールと offers[].slays */
export function slayShortGroupText(L: Locale, recs: readonly ObsSlay[]): string {
  return wardenOfferText(L, recs);
}

/**
 * 大守護者の候補の文（S5a・S5b）: 先に倒した者の短い形と、そのランでその大守護者に挑んで退いた、いちばん新しい挑戦（prev。同じ 3 項目:
 * 与えた被害・受けた被害・予備動作。予備動作は、記録と自分のどちらかに構えのあった種類を、0 でも出す）。どちらも無ければ空
 */
export function wardenOfferText(L: Locale, recs: readonly ObsSlay[], prev?: { no: number; facts: SeasonSlayFacts }): string {
  const parts: string[] = [];
  if (recs.length) parts.push(recs.map((r) => `${slayLabel(L, r)}: ${slayShortText(L, r)}`).join(t(L, '／', ' / ')));
  if (prev) {
    const s = prev.facts;
    const total = s.dealt.melee.total + s.dealt.thrown.total + s.dealt.poison.total + s.dealt.feature.total;
    const kinds: string[] = [];
    for (const x of [...recs.flatMap((r) => r.tells ?? []), ...(s.tells ?? [])]) if (x.seen > 0 && !kinds.includes(x.kind)) kinds.push(x.kind);
    const tells = s.tells ? kinds.map((kind) => {
      const x = s.tells!.find((y) => y.kind === kind) ?? { seen: 0, missed: 0 };
      return isStrike(kind)
        ? t(L, `${tellName(L, kind)}を ${x.seen} 回見て ${x.missed} 回外させた`, `${tellPlural(L, kind)}: saw ${x.seen}, ${x.missed} missed`)
        : t(L, `${tellName(L, kind)}を ${x.seen} 回見た`, `${tellPlural(L, kind)}: saw ${x.seen}`);
    }) : [];
    parts.push(t(L, `あなたの前の挑戦（遠征 ${prev.no}）: 与えた被害 ${total}・受けた被害 ${s.taken}${tells.map((x) => `・${x}`).join('')}`,
      `your last attempt (expedition ${prev.no}): dealt ${total}, took ${s.taken}${tells.map((x) => `, ${x}`).join('')}`));
  }
  if (!parts.length) return '';
  return `${parts.join(t(L, '。／', '. / '))}${recs.length ? t(L, '。全文は records', '. Full text: records') : ''}`;
}

/**
 * 退いた後のキャンプの並べ（S5 §47.4 の 2）: 自分の挑戦の行と、その下に先に倒した者の記録の行（シーズンのランで、記録があれば。最初の 1 件といちばん少ない被害の 1 件）
 */
export function wardenAttemptCompare(L: Locale, catalog: Catalog, view: PlayerView, no: number, s: SeasonSlayFacts): { depth: number; warden: string; attempt: ObsSlayAttempt; records: ObsSlay[]; lines: string[] } {
  const warden = guardianDisplayName(L, { name: s.warden });
  const attempt = slayAttemptObs(L, catalog, s);
  const records = view.season ? slaysAt(L, catalog, view, s.depth) : [];
  const raw = view.season ? (view.season.slays ?? []).filter((x) => x.depth === s.depth).sort((a, b) => Number(!!b.first) - Number(!!a.first)) : [];
  return { depth: s.depth, warden, attempt, records, lines: compareTable(L, catalog, view, no, warden, s, raw) };
}

/** 節目の大守護者の型のうち、そのプレイヤーが知っているもの（キャンプの次の節目・大守護者の候補に出ている型。公開の情報。S5b） */
function knownWardenTypes(view: PlayerView, depth: number): string[] {
  const out = new Set<string>();
  if (view.camp?.milestone?.depth === depth) for (const id of view.camp.milestone.types) out.add(id);
  for (const o of view.camp?.offers ?? []) if (o.warden?.depth === depth) for (const id of o.warden.types) out.add(id);
  return [...out];
}

/**
 * 退いた後のキャンプの並べの表（S5b）: 項目ごとに 1 行、左に自分・右に先に倒した者（2 人なら「／」で 2 人）。
 * 予備動作の行のすぐ下に、その予備動作を出す型の説明（知っている型だけ）。全部の列が 0・なしの行は省く。評価・助言の文は付けない
 */
function compareTable(L: Locale, catalog: Catalog, view: PlayerView, no: number, warden: string, mine: SeasonSlayFacts, recs: readonly SeasonSlay[]): string[] {
  const sep = t(L, ' ／ ', ' / ');
  const cols: { s: SeasonSlayFacts; rec: boolean }[] = [{ s: mine, rec: false }, ...recs.map((s) => ({ s, rec: true }))];
  type Cell = { text: string; zero: boolean };
  const none = (): Cell => ({ text: t(L, '記録に無い', 'not recorded'), zero: true });
  const out: string[] = [];
  const row = (label: string, f: (s: SeasonSlayFacts, rec: boolean) => Cell): boolean => {
    const cells = cols.map((c) => f(c.s, c.rec));
    if (cells.every((c) => c.zero)) return false;
    out.push(`  ${label}: ${cells.map((c) => c.text).join(sep)}`);
    return true;
  };
  // 見出し: 列の名前（レベル・職業・武器）
  const weaponOf = (s: SeasonSlayFacts) => (s.weapon ? itemDisplayName(catalog, L, s.weapon.kind, null, s.weapon.affixes) : s.hidden ? t(L, '武器は未鑑定で載っていない', 'weapon unidentified') : t(L, '素手', 'bare hands'));
  const clsOf = (s: SeasonSlayFacts) => nameOf(catalog.classes[s.classId]?.name, L, shortId(s.classId));
  const who = (c: { s: SeasonSlayFacts; rec: boolean }) => {
    const r = c.s as SeasonSlay;
    const role = recs.length > 1 && c.rec ? (r.first ? t(L, '（先に倒した）', ' (first)') : t(L, '（いちばん少ない被害）', ' (least damage)')) : '';
    const name = c.rec ? `${r.by}${r.mine ? t(L, '（あなた）', ' (you)') : ''}${role}` : t(L, 'あなた', 'you');
    return t(L, `${name} Lv${c.s.level}・${clsOf(c.s)}・${weaponOf(c.s)}`, `${name} Lv${c.s.level} ${clsOf(c.s)}, ${weaponOf(c.s)}`);
  };
  out.push(recs.length
    ? t(L, `大守護者「${warden}」（地下${mine.depth}階）への挑戦（遠征 ${no}・倒さずに帰った）を、先に倒した者の記録と並べる:`, `Your attempt on the warden "${warden}" (depth ${mine.depth}; expedition ${no}, came back without slaying it), beside the kill record${recs.length > 1 ? 's' : ''}:`)
    : t(L, `大守護者「${warden}」（地下${mine.depth}階）への挑戦（遠征 ${no}・倒さずに帰った）:`, `Your attempt on the warden "${warden}" (depth ${mine.depth}; expedition ${no}, came back without slaying it):`));
  out.push(t(L, `  （項目: ${cols.map(who).join(sep)}）`, `  (columns: ${cols.map(who).join(sep)})`));
  // 予備動作（種類ごと。構えた列が 1 つでもある種類）。その下に、その予備動作を出す型の説明（知っている型だけ）
  const known = knownWardenTypes(view, mine.depth);
  const kinds: string[] = [];
  // 見えていた構えだけ（S5c）
  for (const c of cols) for (const x of c.s.tells ?? []) if (x.seen > 0 && !kinds.includes(x.kind)) kinds.push(x.kind);
  for (const kind of kinds) {
    const name = tellName(L, kind);
    const strike = isStrike(kind);
    const shown = row(strike ? t(L, `${name}を外させた`, `${tellPlural(L, kind)} made to miss`) : t(L, `${name}を見た`, `${tellPlural(L, kind)} seen`), (s) => {
      if (!s.tells) return none();
      const x = s.tells.find((y) => y.kind === kind) ?? { kind, n: 0, seen: 0, missed: 0, hit: 0 };
      return strike
        ? { text: t(L, `${x.missed} 回（見た ${x.seen}・受けた ${x.hit}）`, `${x.missed} (saw ${x.seen}, ${x.hit} hit you)`), zero: x.seen === 0 }
        : { text: t(L, `${x.seen} 回`, `${x.seen}`), zero: x.seen === 0 };
    });
    if (!shown) continue;
    for (const id of known) {
      const g = catalog.guardianTypes[id];
      if (g?.intent === kind) out.push(t(L, `    型「${nameOf(g.name, L, id)}」: ${nameOf(g.desc, L, '')}`, `    type ${nameOf(g.name, L, id)}: ${nameOf(g.desc, L, '')}`));
    }
  }
  // 動けなかった手番（外させた後・眠りなど）と、それ以外の手番
  const opening = (pick: 'missed' | 'other') => (s: SeasonSlayFacts): Cell => {
    if (!s.openings) return none();
    const o = s.openings[pick];
    return { text: t(L, `${o.turns} 手番${o.turns ? `で 与えた ${o.dealt}${o.hitTurns ? `（当てた ${o.hitTurns}）` : ''}・受けた ${o.taken}` : ''}`, `${o.turns} turn${o.turns === 1 ? '' : 's'}${o.turns ? `: dealt ${o.dealt}${o.hitTurns ? ` (landed in ${o.hitTurns})` : ''}, took ${o.taken}` : ''}`), zero: o.turns === 0 };
  };
  const totalOf = (s: SeasonSlayFacts) => s.dealt.melee.total + s.dealt.thrown.total + s.dealt.poison.total + s.dealt.feature.total;
  const a = row(t(L, '外させた後の動けない手番', 'turns it could not act after a missed wind-up'), opening('missed'));
  const b = row(t(L, '眠りなどの動けない手番', 'turns it could not act otherwise (asleep etc.)'), opening('other'));
  if (a || b) {
    row(t(L, 'それ以外の手番', 'other turns'), (s) => {
      if (!s.openings) return none();
      const d = Math.max(0, totalOf(s) - s.openings.missed.dealt - s.openings.other.dealt);
      const k = Math.max(0, s.taken - s.openings.missed.taken - s.openings.other.taken);
      return { text: t(L, `与えた ${d}・受けた ${k}`, `dealt ${d}, took ${k}`), zero: d === 0 && k === 0 };
    });
  }
  // 与えた被害の内訳・受けた被害・仕掛け・品・能動技・手番
  row(t(L, '与えた被害の内訳', 'damage dealt'), (s) => {
    const d = s.dealt;
    const parts = [
      d.melee.n ? t(L, `近接 ${d.melee.total}（${d.melee.n} 回）`, `melee ${d.melee.total} (${d.melee.n})`) : '',
      d.thrown.n ? t(L, `投擲 ${d.thrown.total}（${d.thrown.n} 回）`, `thrown ${d.thrown.total} (${d.thrown.n})`) : '',
      d.poison.n ? t(L, `毒 ${d.poison.total}`, `poison ${d.poison.total}`) : '',
      d.feature.n ? t(L, `地物 ${d.feature.total}（${d.feature.n} 回）`, `features ${d.feature.total} (${d.feature.n})`) : '',
      d.crits ? t(L, `近接の会心 ${d.crits}`, `${d.crits} melee crits`) : '',
    ].filter(Boolean);
    return { text: parts.join(t(L, '・', ', ')) || t(L, 'なし', 'none'), zero: !parts.length };
  });
  row(t(L, '受けた被害', 'damage taken'), (s) => ({ text: `${s.taken}${s.lowestPct !== undefined ? t(L, `（HP の底 ${s.lowestPct}%）`, ` (lowest HP ${s.lowestPct}%)`) : ''}`, zero: s.taken === 0 }));
  // 戦い始めの相手（S6・S6a）: 傷跡だけ（始めの体力は出さない）。どの列も傷跡が無ければ、行ごと省く
  row(t(L, '戦い始めの相手', 'the warden when the fight began'), (s) => {
    const ws = s.wardenStart;
    if (!ws) return none();
    return ws.scar > 0 ? { text: t(L, `傷跡で体力 −${ws.scar}`, `scarred −${ws.scar} HP`), zero: false } : { text: t(L, '傷跡なし', 'no scar'), zero: true };
  });
  // 護りの火（S6a）: 戦い始めに灯っていた数（その遠征で見た火だけ）・その挑戦で消した数
  row(t(L, '護りの火', 'ward fires'), (s) => {
    const p = wardFireParts(L, s.wardenStart?.firesLit, s.wardFires);
    return p ? { text: p, zero: false } : { text: t(L, 'なし', 'none'), zero: true };
  });
  const itemList = (xs: readonly { kind: string; n: number }[]) => xs.map((x) => `${nameOf(catalog.items[x.kind]?.name, L, shortId(x.kind))} ${x.n}`);
  row(t(L, '使った品・投げた品', 'items used and thrown'), (s) => {
    const xs = [...itemList(s.used), ...itemList(s.thrown)];
    return { text: xs.join(t(L, '・', ', ')) || t(L, 'なし', 'none'), zero: !xs.length };
  });
  row(t(L, '能動技', 'abilities'), (s) => {
    const xs = s.abilities.map((x) => `${nameOf(catalog.abilities[x.id]?.name, L, shortId(x.id))} ${x.n}`);
    return { text: xs.join(t(L, '・', ', ')) || t(L, 'なし', 'none'), zero: !xs.length };
  });
  row(t(L, '手番', 'turns'), (s, rec) => ({
    text: rec ? t(L, `${s.turns} 手番目に倒した（倒したランで ${s.attempt} 回目の挑戦）`, `slain ${s.turns} turns in (attempt ${s.attempt} in that run)`)
      : t(L, `${s.turns} 手番目まで戦って帰った（このランで ${s.attempt} 回目の挑戦）`, `fought until turn ${s.turns}, then came back (attempt ${s.attempt} in this run)`),
    zero: false,
  }));
  return out;
}

/** 討伐の記録（S4）: その深さの記録（PlayerView の season.slays から。最初の 1 件が先） */
export function slaysAt(L: Locale, catalog: Catalog, view: PlayerView, depth: number): ObsSlay[] {
  return (view.season?.slays ?? []).filter((s) => s.depth === depth).map((s) => slayObs(L, catalog, s)).sort((a, b) => Number(!!b.first) - Number(!!a.first));
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
  if (f?.campfire) return '=';
  return '*';
}

/** 火を置けない理由（S1 §8.2。置けるなら null。engine と同じ順） */
function placeFireWhy(view: PlayerView, catalog: Catalog, hunting: boolean): string | null {
  const L = view.locale;
  const r = catalog.rules.seasonFire!;
  const f = view.floor!;
  const pos = view.self.pos!;
  const mine = myCampfires(view.season);
  const tr = catalog.terrain[view.terrainTable[view.memory.terrain[pos.y * f.width + pos.x]]];
  const fires = [...view.entities.filter((e) => e.campfire), ...view.memory.remembered.filter((m) => m.campfire && !view.entities.some((e) => e.id === m.id))];
  const near = fires.find((e) => cheb(e.pos, pos) <= r.spacing);
  const cost = f.depth * r.costPerDepth;
  const why = isMilestoneOf(catalog.rules.milestone, f.depth) ? t(L, '大守護者の間の階には置けない', 'not on a warden floor')
    : tr?.stairs || tr?.door || tr?.tags.includes('grate') ? t(L, '階段・扉・格子扉の上には置けない', 'not on stairs, doors or grates')
      : view.entities.some((e) => (e.cat === 'feature' || e.cat === 'trap') && !e.campfire && e.pos.x === pos.x && e.pos.y === pos.y) ? t(L, 'ほかの地物のあるマスには置けない', 'not on another feature')
        : near ? t(L, `ほかの火（${near.campfire!.by} の火・(${near.pos.x},${near.pos.y})）から ${r.spacing} マス以内`, `within ${r.spacing} cells of ${near.campfire!.by}'s campfire at (${near.pos.x},${near.pos.y})`)
          : hunting ? t(L, '追跡中の敵が見えている', 'a hunting enemy is in view')
            : mine.some((x) => x.depth === f.depth) ? t(L, 'この階にはもうあなたの火がある', 'you already have one on this floor')
              : mine.length >= r.perSeason ? t(L, `シーズンで置ける ${r.perSeason} つを置いた`, `you have set all ${r.perSeason} for the season`)
                : view.record.banked < cost ? t(L, `確定点が足りない（費用 ${cost}・確定点 ${view.record.banked}）`, `not enough banked points (cost ${cost}, banked ${view.record.banked})`) : null;
  return why;
}

/** place_fire の行（S1 §8.2）。置けないときは「不可」と理由。置いた本人の得を先に、ほかの者に使われると支援賞に数えることを後に（S1c §14.3 の 7） */
function placeFireLine(view: PlayerView, catalog: Catalog, hunting: boolean): string {
  const L = view.locale;
  const r = catalog.rules.seasonFire!;
  const why = placeFireWhy(view, catalog, hunting);
  if (why) return `place_fire (${t(L, `不可: ${why}`, `unavailable: ${why}`)})`;
  const cost = view.floor!.depth * r.costPerDepth;
  const left = r.perSeason - myCampfires(view.season).length;
  const n = r.returnTurns ?? 5;
  return `place_fire (${t(L, `野営の火を置く: そこから帰れる（帰り支度 ${n} 手番）・次の遠征はそこから始まる・休憩の上限まで回復（1 回の遠征で 1 つの階に 1 回）。費用 ${cost} 点（このランの確定点 ${view.record.banked} から）・シーズンで残り ${left} つ。キャンプに着くと、ほかの参加者の世界にも現れ、使われると支援賞に数える`, `set a campfire: you can return home from it (${n} turns packing up), the next expedition starts there, and it heals to the rest cap (once per floor per expedition). Costs ${cost} of your ${view.record.banked} banked points; ${left} left this season. It reaches the others once you are back at camp, and their uses count for your support award`)})`;
}

/** いる場所の補給の置き場（S3 §25.2。engine の supplyPlaceOf と同じ: 階段の上なら階段、ほかは上か隣の野営の火） */
export function supplyPlaceInView(view: PlayerView, catalog: Catalog): { place: SupplyPlace; x: number; y: number } | null {
  const f = view.floor;
  const pos = view.self.pos;
  if (!view.season || !f || !pos || !f.key.startsWith('main:')) return null;
  const tr = catalog.terrain[view.terrainTable[view.memory.terrain[pos.y * f.width + pos.x]]];
  if (tr?.stairs) return { place: tr.stairs === 'up' ? 'stairs_up' : 'stairs_down', x: pos.x, y: pos.y };
  const fire = view.entities.filter((e) => e.campfire && cheb(e.pos, pos) <= 1).sort((a, b) => cheb(a.pos, pos) - cheb(b.pos, pos))[0];
  return fire ? { place: 'fire', x: fire.pos.x, y: fire.pos.y } : null;
}

const supplyName = (catalog: Catalog, L: Locale, c: { kind: string | null; appearanceId: string | null }) => itemDisplayName(catalog, L, c.kind, c.appearanceId);

/** 預けられる品か（区分。未鑑定なら外見の区分） */
function depositable(catalog: Catalog, it: { kind: string | null; appearanceId: string | null; equipped?: unknown }): boolean {
  const cat = it.kind ? catalog.items[it.kind]?.category : it.appearanceId ? catalog.appearances?.[it.appearanceId]?.category : undefined;
  return !!cat && SUPPLY_CATEGORIES.includes(cat) && !it.equipped && !(it.kind && catalog.items[it.kind]?.bound);
}

/** 補給の置き場の観測（S3 §25.2）: 置き場にいるときの中身、この階の知っている置き場、キャンプの自分の品と知らせ */
function supplyObs(view: PlayerView, catalog: Catalog): Partial<ObsSeason> {
  const s = view.season!;
  const L = view.locale;
  const r = catalog.rules.seasonSupply!;
  const out: Partial<ObsSeason> = {};
  if (view.status === 'at_camp') {
    const mine = s.myDeposits ?? [];
    if (mine.length) {
      out.deposits = mine.map((x) => ({ depth: x.depth, place: x.place, name: supplyName(catalog, L, x), local: x.local }));
      out.deposits_text = t(L, `あなたの預けた品（まだだれも取っていない）: ${mine.map((x) => `地下${x.depth}階の${supplyPlaceName(L, x.place)} ${supplyName(catalog, L, x)}${x.local ? '（まだ載っていない）' : ''}`).join('・')}`,
        `Your deposits not yet taken: ${mine.map((x) => `${supplyName(catalog, L, x)} at the ${supplyPlaceName(L, x.place)} on depth ${x.depth}${x.local ? ' (not yet shared)' : ''}`).join(', ')}`);
    }
    const news = s.cacheNews ?? [];
    if (news.length) {
      out.supply_news = news.map((x) => ({ depth: x.depth, place: x.place, name: supplyName(catalog, L, x), taker: x.taker,
        text: t(L, `知らせ: あなたが地下${x.depth}階の${supplyPlaceName(L, x.place)}に預けた${supplyName(catalog, L, x)}を、${x.taker} が取った（支援賞 +1）`, `News: ${x.taker} took the ${supplyName(catalog, L, x)} you deposited at the ${supplyPlaceName(L, x.place)} on depth ${x.depth} (support +1)`) }));
    }
    return out;
  }
  const f = view.floor;
  if (!f) return out;
  const cache = (s.cache ?? []).filter((c) => c.depth === f.depth);
  // この階の知っている置き場（品のあるもの）
  const byCell = new Map<string, SupplyView[]>();
  for (const c of cache) { const k = `${c.x},${c.y}`; byCell.set(k, [...(byCell.get(k) ?? []), c]); }
  const caches = [...byCell.values()].map((list) => ({ place: list[0].place, at: [list[0].x, list[0].y] as [number, number], items: list.map((c) => ({ id: c.id, name: supplyName(catalog, L, c), by: c.by })) }));
  const hiddenList = (s.cacheHidden ?? []).filter((h) => h.depth === f.depth);
  const hidden = hiddenList.reduce((a, h) => a + h.count, 0);
  if (caches.length || hidden) {
    out.caches = caches;
    if (hidden) out.caches_hidden = hidden;
    const parts = caches.map((c) => t(L, `${supplyPlaceName(L, c.place)} (${c.at[0]},${c.at[1]}): ${c.items.map((x) => `${x.name}（${x.by}）`).join('・')}`, `${supplyPlaceName(L, c.place)} (${c.at[0]},${c.at[1]}): ${c.items.map((x) => `${x.name} (${x.by})`).join(', ')}`));
    // 場所を知らない置き場（S3a §27.9 の 5: 置き場の種類ごと。覚えていない火を「下り階段」と書かない）
    for (const h of hiddenList) {
      parts.push(h.place === 'stairs_down'
        ? t(L, `まだ見ていない下り階段の置き場にも ${h.count} つ（階段を見つけると分かる）`, `${h.count} more at the stairs down you have not seen (find them to learn more)`)
        : t(L, `まだ場所を知らない${supplyPlaceName(L, h.place)}の置き場にも ${h.count} つ`, `${h.count} more at a ${supplyPlaceName(L, h.place)} whose place you do not know yet`));
    }
    out.caches_text = t(L, `補給の置き場（この階）: ${parts.join('／')}`, `Supply caches on this floor: ${parts.join(' / ')}`);
  }
  const at = supplyPlaceInView(view, catalog);
  if (at) {
    const here = cache.filter((c) => c.x === at.x && c.y === at.y);
    const xno = view.expedition && view.expedition.status !== 'ended' ? view.expedition.no : null;
    const took = xno !== null && (s.supplyTaken ?? []).filter((x) => x.no === xno).length >= r.perExpedition;
    const items = here.map((c) => ({ id: c.id, name: supplyName(catalog, L, c), by: c.by, mine: c.mine }));
    out.supply = {
      place: at.place, at: [at.x, at.y], items, count: here.length, cap: r.cap, taken_this_expedition: took,
      text: t(L, `ここは補給の置き場（${supplyPlaceName(L, at.place)}。${here.length}/${r.cap}）: ${items.length ? items.map((x) => `${x.id} ${x.name}（${x.by}）`).join('・') : '品は無い'}。預けられるのは消耗品（薬・巻物・投げる武器）${took ? '。この遠征では、もう置き場から取った' : `。取れるのは 1 回の遠征で ${r.perExpedition} つまで（どの置き場でも）`}`,
        `This is a supply cache (${supplyPlaceName(L, at.place)}; ${here.length}/${r.cap}): ${items.length ? items.map((x) => `${x.id} ${x.name} (${x.by})`).join(', ') : 'empty'}. Consumables (potions, scrolls, throwing weapons) can be deposited${took ? '; you have already taken from a cache this expedition' : `; you can take ${r.perExpedition} per expedition (from any cache)`}`),
    };
  }
  return out;
}

/** 置き場の行（S3 §25.2。置き場にいるときだけ）: deposit_supply <slot>（預けられる品ごと）・take_supply <id>（取れる品ごと）。engine と同じ順の見込み（最後に決めるのは engine） */
function supplyLines(view: PlayerView, catalog: Catalog): string[] {
  const at = supplyPlaceInView(view, catalog);
  if (!at || view.status !== 'your_turn') return [];
  const L = view.locale;
  const r = catalog.rules.seasonSupply!;
  const s = view.season!;
  const f = view.floor!;
  const here = (s.cache ?? []).filter((c) => c.depth === f.depth && c.x === at.x && c.y === at.y);
  const out: string[] = [];
  const dep = view.inventory.filter((it) => depositable(catalog, it));
  if (dep.length) {
    if (here.length >= r.cap) out.push(`deposit_supply (${t(L, `不可: この置き場はいっぱい（${here.length}/${r.cap}）`, `unavailable: this cache is full (${here.length}/${r.cap})`)})`);
    else for (const it of dep) out.push(`deposit_supply ${it.slot} (${t(L, `預ける: ${supplyName(catalog, L, it)} を 1 つ（${supplyPlaceName(L, at.place)}の置き場 ${here.length}/${r.cap}）。キャンプに着くと、ほかの参加者の世界にも現れ、取られると支援賞に数える`, `deposit one ${supplyName(catalog, L, it)} (${supplyPlaceName(L, at.place)} cache ${here.length}/${r.cap}); it reaches the others once you are back at camp, and their takes count for your support award`)})`);
  }
  if (here.length) {
    const xno = view.expedition && view.expedition.status !== 'ended' ? view.expedition.no : null;
    const took = xno !== null && (s.supplyTaken ?? []).filter((x) => x.no === xno).length >= r.perExpedition;
    if (took) out.push(`take_supply (${t(L, `不可: この遠征では、もう置き場から ${r.perExpedition} つ取った`, `unavailable: already took ${r.perExpedition} from caches this expedition`)})`);
    else for (const c of here) out.push(`take_supply ${c.id} (${t(L, `取る: ${supplyName(catalog, L, c)}（${c.mine ? 'あなたが' : `${c.by} が`}預けた）。1 回の遠征で置き場から取れるのは ${r.perExpedition} つまで`, `take ${supplyName(catalog, L, c)} (deposited by ${c.mine ? 'you' : c.by}); ${r.perExpedition} take per expedition`)})`);
  }
  return out;
}

/** 地物の名前。野営の火は置いた者の名前を添える（S1 §9.10） */
function campfireName(catalog: Catalog, L: Locale, kind: string | null, fire: { by: string } | undefined): string {
  const base = kindName(catalog, L, kind);
  return fire ? t(L, `${base}（${fire.by} の火）`, `${base} (${fire.by}'s)`) : base;
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
  // 10 の位は 10 の倍数の列にだけ書く（S1b §12.4 の 6: 左端が 10 の倍数でない地図で、左端にも 10 の位の「0」を書いていたので、
  // その列を x=0 と読んで 1 列ずれた）。範囲に 10 の倍数が無いときだけ、左端に書く
  const hasTen = Array.from({ length: width }, (_, i) => map.origin.x + i).some((x) => x % 10 === 0);
  for (let i = 0; i < width; i++) {
    const x = map.origin.x + i;
    tens.push(x % 10 === 0 || (i === 0 && !hasTen) ? String(Math.trunc(x / 10) % 10) : ' ');
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
  /** 地物の 1 行の説明（V4-1g G6。内容のデータの desc） */
  const featureDesc = (kind: string | null | undefined) => { const d = kind ? catalog.features[kind]?.desc : undefined; return d ? { desc: nameOf(d, L, '') } : {}; };
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
        ...(mem && mem.maxPlainToYou && mem.maxPlainToYou > 0 && mem.maxPlainToYou < mem.maxDamageToYou ? { worst_plain_hit: mem.maxPlainToYou } : {}),
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
      features.push({ id: e.id, type: e.kind ?? 'feature', name: campfireName(catalog, L, e.kind, e.campfire), pos: e.pos, ...rel(e.pos), state: e.state, ...(e.lair ? { lair: guardianDisplayName(L, e.lair) } : {}), ...(e.campfire ? { by: e.campfire.by } : {}), ...featureDesc(e.kind) });
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
      const it: ObsItem = { id: r.id, name: itemDisplayName(catalog, L, r.kind, r.appearanceId, r.affixes ?? []), pos: r.pos, ...rel(r.pos), qty: r.qty, remembered: true };
      if (r.role) it.role = r.role;
      if (r.objective) it.objective = true;
      if (r.mine) it.mine = true;
      if (r.value !== undefined) it.value = r.value;
      rememberedItems.push(it);
    }
    // 公開された特別な場所（S1c §14.5）: そのマスをまだ自分の目で見ていなければ、報告した者の名前
    const spot = r.cat === 'feature' && f && !view.memory.terrain[r.pos.y * f.width + r.pos.x] ? publicSpotAt(view.season, f.depth, r.pos.x, r.pos.y) : null;
    if (r.cat !== 'item') features.push({ id: r.id, type: r.kind ?? 'feature', name: campfireName(catalog, L, r.kind, r.campfire), pos: r.pos, ...rel(r.pos), state: r.state, ...(r.lair ? { lair: guardianDisplayName(L, r.lair) } : {}), ...(r.campfire ? { by: r.campfire.by } : {}), ...(spot ? { public_by: spot.by } : {}), ...featureDesc(r.kind) });
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
      // 公開された下り階段（S0 §9.4）: まだ自分の目で見ていない間は、公開した者の名前を添える
      const pub = st === 'down' && view.floor ? publicStairsAt(view.season, view.floor.depth) : null;
      const pubBy = pub && pub.x === p.x && pub.y === p.y && (view.memory.unsighted ?? []).includes(i) ? pub.by : undefined;
      known_stairs.push({ type: st, pos: p, dist: dd >= 0 ? dd : cheb(pos, p), reachable: dd >= 0, path_len: dd >= 0 ? dd : null, ...(occ ? { occupied_by: occ.id } : {}), ...(st === 'down' && sealedDown ? { sealed: true as const } : {}), ...(pubBy ? { public_by: pubBy } : {}) });
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
    // 群れ全体の被害見込み（思い出の記録だけから。V3-2R2 §18.2）。fight の見込み（S1c §14.4 の 1: いちばん重い 1 体は最大の一撃、残りは平均）も並べる
    const ents = huntingReach.map((m) => view.entities.find((e) => e.id === m.id)).filter((e): e is EntityView => !!e);
    const est = threatEstimate(view, catalog, ents);
    const both = est.expected < worstSum ? t(L, `1 手の被害の見込み ${est.expected}・最悪 ${worstSum}（全員が最大の一撃）`, `expected damage per turn ${est.expected}, worst ${worstSum} (everyone at their worst)`)
      : t(L, `1 手の最悪の被害の合計 ${worstSum}`, `worst damage per turn sums to ${worstSum}`);
    alerts.push({
      code: 'incoming',
      text: t(L, `追跡中 ${huntingReach.length} 体。${both}${unrecorded ? `、ほかに記録のない ${unrecorded} 体` : ''}。あなたの HP ${me.stats.hp}`,
        `${huntingReach.length} hunting you. ${both[0].toUpperCase()}${both.slice(1)}${unrecorded ? `, plus ${unrecorded} with no record` : ''}. Your HP ${me.stats.hp}`),
      data: { hunting: huntingReach.length, worst_sum: worstSum, expected_sum: est.expected, unrecorded, hp: me.stats.hp },
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
        // expected_if_chased: 被害の見込み（S1c §14.4 の 1）
        data: { stairs: st.type, path_len: st.path_len, faster, worst_if_chased: unrecorded ? null : chaseOf(st.path_len!).worst, expected_if_chased: unrecorded ? null : chaseOf(st.path_len!).expected, hp: me.stats.hp },
      });
    }
  }
  // 予算の終わりぎわ（S1b §12.4 の 2。シーズンのランの迷宮の中）: 残りが、いちばん近い着ける階段までの歩数の 2 倍を下回ったか、100 を切った
  if (view.season && f && pos && view.status !== 'dead' && view.status !== 'at_camp') {
    const left = Math.max(0, view.season.budgetLeft);
    const near = known_stairs.filter((s) => s.path_len !== null).sort((a, b) => a.path_len! - b.path_len! || (a.type === 'up' ? -1 : 1))[0];
    const steps = near ? near.path_len! : null;
    if (left < 100 || (steps !== null && left < steps * 2)) {
      // 帰還の綱を持っていれば 1 句（S1c §14.6 の 4）
      const rope = view.inventory.some((it) => it.kind === 'core:lifeline') ? t(L, '。綱なら、その場で帰れる（確定は戦利品の半分）', '; the lifeline takes you home from here (half the haul is banked)') : '';
      const tail = t(L, `尽きると時間切れで、未確定の戦利品を失う${rope}`, `running out is time up and loses the unbanked haul${rope}`);
      const name = near ? (near.type === 'up' ? t(L, '上り階段', 'stairs up') : t(L, '下り階段', 'stairs down')) : '';
      const text = steps === null
        ? t(L, `予算の残り ${left} 手番。着ける階段が分からない（既知の道で届く階段が無い。${tail}）`, `Budget: ${left} turns left. No stairs you can reach on the known map (${tail})`)
        : steps === 0
          ? t(L, `予算の残り ${left} 手番。いま${name}の上にいる（ここで extract できる。${tail}）`, `Budget: ${left} turns left. You are on the ${name} (you can extract here; ${tail})`)
          : t(L, `予算の残り ${left} 手番。いちばん近い着ける階段（${name}）まで ${steps} 歩（${tail}）`, `Budget: ${left} turns left. ${steps} steps to the nearest reachable stairs (${name}; ${tail})`);
      alerts.push({ code: 'budget_low', text, data: { left, stairs: near?.type ?? null, path_len: steps } });
    }
  }
  if ((opts.recent ?? []).some((e) => e.type === 'entity_changed_floor' && (e.event as any).id === me.id)) {
    // 前に来た階でも出るので「新しい階」とは書かない（S0b §6.2 の 4: 階は遠征ごとに作り直されると読まれた。階はランの間、作られたまま残る）
    const d = view.floor?.depth;
    alerts.push({ code: 'new_floor', text: t(L, `階を移った${d ? `（地下${d}階）` : ''}`, `Moved to another floor${d ? ` (depth ${d})` : ''}`) });
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
    // 野営の火の上か隣（S1c §14.3 の 1）: 追ってくる敵が見えていなければ（休憩と同じ判定）、帰り支度の後に帰れる。階段の上なら階段が先
    const fireNear = !onStairs && view.season && pos ? view.entities.filter((e) => e.campfire && cheb(e.pos, pos) <= 1).sort((a, b) => cheb(a.pos, pos) - cheb(b.pos, pos))[0] : undefined;
    const returnTurns = catalog.rules.seasonFire?.returnTurns ?? 5;
    const fireBlock: ObsExpedition['extract_blocked_by'] = fireNear ? (restBlocked ? 'hunted_at_fire' : (view.season?.budgetLeft ?? 0) < returnTurns ? 'budget_at_fire' : undefined) : 'not_on_stairs';
    const blocked: ObsExpedition['extract_blocked_by'] = !active ? 'ended' : view.status !== 'your_turn' ? 'not_your_turn' : !onStairs ? fireBlock : undefined;
    const prog: ObsExpedition['progress'] = { depth: f?.depth ?? null, target_depth: xv.objective.targetDepth };
    if (xv.objective.type === 'reach_depth') prog.reached = xv.progress.reached;
    if (xv.objective.type === 'slay_guardian' || xv.objective.type === 'slay_warden') prog.guardian_slain = xv.progress.guardianSlain;
    if (xv.objective.type === 'retrieve_relic') prog.relic_held = xv.progress.relicHeldByYou;
    const extractText = blocked === undefined ? (fireNear ? t(L, `extract: 可（野営の火から。帰り支度 ${returnTurns} 手番）`, `extract: possible (from the campfire; ${returnTurns} turns packing up)`) : t(L, 'extract: 可', 'extract: possible'))
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
    if (blocked === undefined && fireNear) expedition.extract_via = { type: 'fire', by: fireNear.campfire!.by, turns: returnTurns };
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
    if (xv.result) {
      // あなたの分・全員の合計・だれの分か（V4-1g G4）
      const names = Object.fromEntries(view.party.map((p) => [p.playerId, p.name]));
      const pay = xv.result.payout;
      const mine = pay ? (pay.players.find((p) => p.player === view.playerId) ?? (pay.players.length === 1 ? pay.players[0] : undefined)) : undefined;
      const shares = pay && pay.players.length > 1 ? pay.players.map((p) => {
        const ret = xv.returns?.find((q) => q.player === p.player);
        const how: 'completed' | 'withdrawn' | 'lifeline' | 'lost' = p.lost > 0 ? 'lost' : ret?.lifeline ? 'lifeline' : ret?.completed ? 'completed' : 'withdrawn';
        return { id: p.player, name: names[p.player] ?? p.player, banked: p.banked, lost: p.lost, how };
      }) : undefined;
      expedition.result = {
        ...xv.result, text: resultText(L, xv, catalog.rules, { id: view.playerId, names }),
        ...(pay ? { banked: mine?.banked ?? 0 } : {}), ...(shares ? { party_banked: pay!.banked, shares } : {}),
      };
    }
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
        // 公開された下り階段（S1c §14.4 の 5: 地図には「公開: ○○ が報告」と載っているのに「未発見」と書いていた）。場所は分かっていて、道が分からない
        const pubDown = here && !down ? known_stairs.find((s) => s.type === 'down' && s.public_by) : undefined;
        const where = here ? (down ? t(L, `（経路 ${down.path_len}）`, ` (path ${down.path_len})`)
          : pubDown ? t(L, `（公開されている: ${pubDown.public_by} が報告 (${pubDown.pos.x},${pubDown.pos.y})。途中の道はまだ分からない${draft ? `・下への風は${DIR_JA[draft]}` : ''}）`, ` (published by ${pubDown.public_by} at (${pubDown.pos.x},${pubDown.pos.y}); the way there is still unknown${draft ? `; the draft blows ${draft}` : ''})`)
            : draft ? t(L, `（未発見・下への風は${DIR_JA[draft]}）`, ` (not found yet; the draft blows ${draft})`) : t(L, '（未発見）', ' (not found yet)')) : '';
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
      // 目的の分は綱では入らない（S3b §30.4 の 2）
      const lifeObj = ifLifeline !== undefined && parts.objective > 0 ? t(L, `（目的の分 ${parts.objective} 点は入らない）`, ` (without the objective's ${parts.objective})`) : '';
      const lifeText = ifLifeline !== undefined ? t(L, `・綱なら +${ifLifeline}${lifeObj}${relicNote}`, `, lifeline +${ifLifeline}${lifeObj}${relicNote}`) : '';
      // 協力プレイ: 帰った者の点は、遠征の終わり（全員が戻ったとき）に確定する。共有の分はそのときの値で数える（帰った後に仲間が稼いだ分も入る）。V4-1g G4
      const coopNote = view.runMode === 'coop' && view.party.length > 1
        ? t(L, '（協力プレイ: 帰った者の点は、全員が戻って遠征が終わったときに確定する。目的・踏破・発見・撃破・賞金の分はそのときの値で数え、宝は持ち帰った人の分）', ' (co-op: what you bring back is banked when everyone is back and the expedition ends; objective, overreach, discovery, kills and bounty count at that time, treasure goes to who carried it)')
        : '';
      expedition.haul = {
        total, multiplier_pct: xv.multiplierPct, parts, if_extract_now: ifNow, ...(ifLifeline !== undefined ? { if_lifeline_now: ifLifeline } : {}), next_overreach: next,
        next_camp: nc ? { min_target_depth: nc.minTargetDepth, recommended_level: nc.recommendedLevel } : null,
        text: t(L,
          `戦利品 ${total}（${partsText(L, parts) || 'なし'}）${expedition.extract_outcome === 'complete' ? multText(xv.multiplierPct) : `撤退なら ${catalog.rules.haul.withdrawPct}%（目的を除く）`} → 今帰れば +${ifNow}${lifeText}${coopNote}${nextText}${campText} / 確定済み ${view.record.banked}`,
          `haul ${total} (${partsText(L, parts) || 'none'}) ${expedition.extract_outcome === 'complete' ? multText(xv.multiplierPct) : `withdraw ${catalog.rules.haul.withdrawPct}% without objective`} → extract now +${ifNow}${lifeText}${coopNote}${nextText}${campText} / banked ${view.record.banked}`),
      };
    }
  }
  let camp: ObsCamp | undefined;
  if (view.camp) {
    const rules = catalog.rules;
    // 討伐の記録（S4 §35.5）: まだ倒していない節目の大守護者を倒す候補だけ（シーズンのランで、記録が載っていれば）
    const slayCache = new Map<number, ObsSlay[]>();
    const offerSlays = (o: ExpeditionOffer): ObsSlay[] => {
      const dep = o.objective.targetDepth;
      if (o.objective.type !== 'slay_warden' || dep === null || (view.milestonesCleared ?? []).includes(dep) || !view.season?.slays?.length) return [];
      if (!slayCache.has(dep)) slayCache.set(dep, slaysAt(L, catalog, view, dep));
      return slayCache.get(dep)!;
    };
    // 倒さずに帰った節目の大守護者への挑戦と、先に倒した者の記録（S5 §47.4 の 2）
    const cmpWardens = opts.campCompare?.wardens?.length && view.status === 'at_camp'
      ? opts.campCompare.wardens.map((s) => wardenAttemptCompare(L, catalog, view, opts.campCompare!.no, s)) : undefined;
    // 並べに記録の全文を出している節目（S5a: 記録庫の側は 1 行にする）
    const inCompare = new Set((cmpWardens ?? []).filter((x) => x.records.length).map((x) => x.depth));
    camp = {
      ...(view.camp.milestone ? { milestone: milestoneObs(L, catalog, view.camp.milestone, view.milestonesCleared ?? [], view.wardenIntel?.[String(view.camp.milestone.depth)], view) } : {}),
      ...(opts.campCompare && view.status === 'at_camp' ? { compare: {
        no: opts.campCompare.no, lines: opts.campCompare.lines.slice(0, 2), ...(opts.campCompare.compare ?? {}),
        ...(cmpWardens ? { wardens: cmpWardens } : {}),
      } } : {}),
      ...(opts.versionNote && view.status === 'at_camp' ? { version_note: opts.versionNote } : {}),
      ...(opts.records && view.status === 'at_camp' ? { records: { line: opts.records.line, ...(opts.records.featsNew?.length ? { feats_new: [...opts.records.featsNew] } : {}) } } : {}),
      // 記録庫に納めた欠片の数（V3-3a §35.7）。討伐の記録（S4 §35.5。シーズンのランだけ）も節目ごとに
      archive: {
        delivered: view.archive?.length ?? 0, total: Object.values(catalog.items).filter((it) => it.category === 'relic' && it.boon).length,
        ...((): { slays?: NonNullable<ObsCamp['archive']>['slays'] } => {
          const depths = [...new Set((view.season?.slays ?? []).map((s) => s.depth))].sort((a, b) => a - b);
          if (!depths.length) return {};
          return { slays: depths.map((depth) => {
            const records = slaysAt(L, catalog, view, depth);
            const s0 = (view.season?.slays ?? []).find((s) => s.depth === depth)!;
            const warden = guardianDisplayName(L, { name: s0.warden });
            // 同じ観測の並べ（退いた後のキャンプ）に全文を出していれば、ここは 1 行（S5a）。全文を出すのは、まだ倒していない大守護者の記録が
            // 新しく届いたキャンプ（知らせの出るキャンプ）だけ。ほかは 1 行にたたむ（S6 §49.5 の 3・4。構造化した records は全部持つ。全文は records ツール）
            const news = !(view.milestonesCleared ?? []).includes(depth) && (opts.slayFullDepths ?? []).includes(depth);
            const body = inCompare.has(depth) ? t(L, '（上の挑戦の並べに出している）', '(shown with your attempt above)') : news ? slayGroupText(L, records) : slayFoldText(L, records);
            return { depth, warden, count: records[0]?.of ?? 0, records, text: t(L, `記録庫・討伐の記録 地下${depth}階の大守護者「${warden}」: ${body}`, `Archive, warden kills on depth ${depth} ("${warden}"): ${body}`) };
          }) };
        })(),
      },
      next_no: view.camp.nextNo,
      offers: view.camp.offers.map((o) => ({
        index: o.index, type: o.objective.type, target_depth: o.objective.targetDepth, points: o.points,
        ...(o.rechallenge ? { rechallenge: { no: o.rechallenge.no } } : {}),
        ...(o.guardianBounty !== undefined ? { guardian_bounty: o.guardianBounty } : {}), ...(o.repeatPct !== undefined ? { repeat_pct: o.repeatPct } : {}),
        text: offerText(L, o, rules ? { rules, level: me.level } : undefined) + (opts.offerNotes?.[o.index] ? ` / ${opts.offerNotes[o.index]}` : '') + ((): string => {
          // 遺物を納めると、記録庫が次の節目の番人の記憶を 1 つ返す（V3-3a §35.7）
          const msd = view.camp?.milestone?.depth;
          if (!o.relic || msd === undefined) return '';
          const kn = view.wardenIntel?.[String(msd)] ?? {};
          const left = 2 - (kn.weakness ? 1 : 0) - (kn.hp !== undefined ? 1 : 0);
          return left > 0 ? t(L, ` / 納めると、記録庫が地下${msd}階の番人の記憶を 1 つ返す（残り ${left}）`, ` / delivering it makes the archive recall one memory of the depth-${msd} keeper (${left} left)`) : '';
        })() + (o.bounty ? ` / ${gearVsArmorText(L, catalog, view, o.bounty.armor, Math.max(1, o.bounty.hp - (o.scar ?? 0)))}` : '')
          // 守護者の候補（格 1〜3。再挑戦を含む）にも通る目安（V3-8a §56.1。大守護者は記録庫の記憶の装甲で出す）
          // 大守護者は、記録庫で体力が分かっていれば命中の回数も（S3b §30.3 の 4）。護られし者は、火が灯っている間の装甲を 1 句
          + (o.guardian?.armor !== undefined ? ` / ${gearVsArmorText(L, catalog, view, o.guardian.armor, offerGuardianHp(view, o), o.guardian.types ?? [])}` : '')
          // 討伐の記録（S4 §35.5）: まだ倒していない大守護者を倒す候補に、先に倒した参加者の戦いの事実。
          // 文は短い形（S5a: 全文は記録庫に。同じ記録の全文を 1 つの観測に 3 回出さない）。offers[].slays は全部持つ
          + ((): string => {
            // S5b: そのランで、その大守護者に挑んで退いたことがあれば、いちばん新しい挑戦を同じ 3 項目で（記録が無くても）
            const dep = o.objective.targetDepth;
            const prev = o.objective.type === 'slay_warden' && dep !== null && !(view.milestonesCleared ?? []).includes(dep) ? opts.wardenPrev?.[dep] : undefined;
            const s = wardenOfferText(L, offerSlays(o), prev);
            return s ? ` / ${s}` : '';
          })(),
        ...(offerSlays(o).length ? { slays: offerSlays(o) } : {}),
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
  // 拾えるアイテムは、辿り着ける所のものだけ数える（V4-1g G5: 壁の向こうに覚えている品で explore の行を出し、呼ぶと nothing_to_do になっていた）
  const pickables = pickableItems(view, catalog).filter((x) => !dist || dist[x.cell]! >= 0).length;
  const collectIds = collectTargets(view, catalog);
  const valid_actions = buildValidActions(view, catalog, {
    passable_dirs, onStairs, itemsHere: itemsHere.length > 0, relicHere: itemsHere.some((i) => i.role === 'relic'), hostiles, frontiers: frontiers.length, known_stairs, grid,
    canExtract: expedition?.can_extract ?? false, objectiveComplete: expedition?.extract_outcome === 'complete', extractVia: expedition?.extract_via, restTurns: rest && !rest.blocked_by ? rest.turns : null,
    attackers, mineCount, pickables, collectable: collectIds.length, huntingReach, worstSum, unrecorded, chaseOf, lifelineShort: !!opts.lifelineShort,
    draft: view.floorHint?.draft ?? null,
    ifLifeline: expedition?.haul?.if_lifeline_now, lifelineObjective: expedition?.haul?.parts.objective ?? 0,
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
    party: partyOf(view),
    navigation: { here, passable_dirs, frontiers, known_stairs, collectable: { count: collectIds.length, ids: collectIds }, ...(view.memory.unsighted?.length ? { unsighted: view.memory.unsighted.length } : {}) },
    // 経験値の文は 10 件の枠に数えない（ほかの知らせを押し出さない。S0b §7.9）
    recent_events: lastWithoutXp((opts.recent ?? []).filter((e) => e.text.length > 0), 10).map((e) => e.text),
    valid_actions,
  };
  if (rest && rest.blocked_by !== 'hostile_hunting') obs.self.rest_estimate = rest;
  // fight の被弾の前の判定の数（S2a §20.10 の 5: pilot がマクロと同じ判定をするため）
  if (me.pos && view.status !== 'at_camp') {
    const threats = fightThreats(catalog, view.entities.filter((e) => e.cat === 'monster'), me.pos);
    if (threats.length) obs.self.fight_risk = threatEstimate(view, catalog, threats);
  }
  if (expedition) obs.expedition = expedition;
  if (camp) obs.camp = camp;
  // 区切り（S7 §52.2 の 1）: キャンプにいるときだけ。協力プレイで仲間を待っている（候補がまだ無い）キャンプも
  if (view.status === 'at_camp') obs.checkpoint = checkpointObs(L, view.notes);
  const season = seasonObs(view, catalog.rules.seasonFire?.perSeason);
  if (season) {
    // 迷宮で、いま火を置けるマスにいる: 支援賞の行（キャンプで取り込んだもの）と自分の火の数（S1c §14.4 の 7）
    if (view.status === 'your_turn' && f && pos && catalog.rules.seasonFire && !placeFireWhy(view, catalog, restBlocked)) {
      const a = view.season?.awards.find((x) => x.id === 'support');
      const n = myCampfires(view.season).length;
      const lim = catalog.rules.seasonFire.perSeason;
      season.support = { placed: n, limit: lim, text: `${a ? awardText(L, a) : awardName(L, 'support')}${fireCountText(L, n, lim)}` };
    }
    // 補給の置き場（S3 §25.2）
    if (catalog.rules.seasonSupply) Object.assign(season, supplyObs(view, catalog));
    // 前のキャンプの後に初めて受け取った討伐の記録（S5b。キャンプだけ。サーバーが取り込みの記録から決める）
    if (view.status === 'at_camp' && opts.slayNews?.length) season.slay_news = opts.slayNews.map((s) => slayNewsItem(L, catalog, s));
    obs.season = season;
  }
  if (opts.detail === 'full') obs.self.inventory = invItems;
  else obs.self.inventory_brief = invBrief;
  if (opts.map && f && pos) {
    const w = opts.mapWidth ?? 21;
    const h = opts.mapHeight ?? 15;
    obs.map = renderAsciiMap(view, catalog, { x: pos.x - Math.trunc(w / 2), y: pos.y - Math.trunc(h / 2), w, h });
  }
  return obs;
}

const EXTRACT_BLOCK_JA: Record<string, string> = {
  not_on_stairs: '階段の上ではない', not_your_turn: '手番ではない', ended: '終了済み',
  hunted_at_fire: '野営の火のそばだが、追ってくる敵が見えている', budget_at_fire: '野営の火のそばだが、予算の残りが帰り支度に足りない',
};

interface VAInput {
  lifelineShort?: boolean;
  passable_dirs: Dir[]; onStairs: 'up' | 'down' | null; itemsHere: boolean; relicHere?: boolean; hostiles: ObsMonster[]; pickables: number;
  /** 引数なしの collect が拾いに行く品の数（V4-1a §12.1） */
  collectable: number;
  frontiers: number; known_stairs: Observation['navigation']['known_stairs']; grid: NavGrid | null;
  canExtract: boolean; objectiveComplete: boolean; restTurns: number | null;
  /** 野営の火から帰る（S1c §14.3 の 1） */
  extractVia?: ObsExpedition['extract_via'];
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
  /** 戦利品のうち目的の分（綱では入らない。S3b §30.4 の 2） */
  lifelineObjective?: number;
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
    // シーズン（S0 §9.4）: 報告できる階段があれば report_stairs。予算が無いか終わりの時刻を過ぎたら、遠征は始められない
    // 特別な場所（S1c §14.5）も同じ命令で報告する
    const ss = view.season;
    const reportWhat = ss ? [ss.unreported > 0 ? t(L, `報告していない階段 ${ss.unreported}`, `${ss.unreported} unreported stairs`) : '', (ss.spotsUnreported ?? 0) > 0 ? t(L, `報告していない特別な場所 ${ss.spotsUnreported}`, `${ss.spotsUnreported} unreported special places`) : ''].filter(Boolean) : [];
    const report = reportWhat.length ? [`report_stairs (${reportWhat.join(t(L, '・', ', '))})`] : [];
    const closed = !!view.season && (view.season.budgetLeft <= 0 || view.season.ended);
    // 覚え書き（S7 §52.2 の 1）: キャンプの区切りで書けるように、呼べる形で 1 行（プレイする AI に届くのは応答の文だけのことがある。§53）
    const note = notesActionLine(L);
    if (!view.camp || closed) return [...perkLines, ...report, note, ...(view.camp ? ['retire'] : ['wait_for_turn'])];
    return [
      ...perkLines,
      ...report,
      ...view.camp.offers.map((o) => `start_expedition ${o.index} (${objectiveText(L, o.objective)})`),
      'start_expedition endless', note, 'retire',
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
  // 野営の火から（S1c §14.3 の 1）: 帰り支度の手番・取りやめ・次の遠征はこの火のそばから
  const viaFire = x.extractVia;
  const fromFire = viaFire ? t(L, `・${viaFire.by} の野営の火から。帰り支度 ${viaFire.turns} 手番（この手番を含む。その間に追ってくる敵が見えたら取りやめ）・次の遠征はこのマスから始まる`, `; from ${viaFire.by}'s campfire: ${viaFire.turns} turns packing up (including this one; called off if a hunting enemy comes into view); the next expedition starts from this cell`) : '';
  if (x.canExtract) out.push(x.objectiveComplete ? `extract (${t(L, '帰還: 遠征達成', 'complete the expedition')}${viaFire ? fromFire : fromHere}${leftBehind})` : `extract confirm:true (${t(L, '撤退: 未達成のまま終える', 'withdraw without the reward')}${viaFire ? fromFire : fromHere}${leftBehind})`);
  // 移動マクロはその場で進める mode だけを出す（V3-2R §14.2）。隣に起きている敵がいれば careful では動かないので flee を出す
  const adjAwake = x.hostiles.filter((m) => m.dist <= 1 && m.awareness !== 'asleep' && !m.fleeing);
  // 既定の hp_floor の実数（steady・fight は最大 HP の 50%。V3-2R2 §18.5）
  const floor50 = Math.trunc((view.self.stats.maxHp * 50) / 100);
  // 既定の hp_floor であることを書く（S1c §14.4 の 1: hp_floor を渡して呼んだ後も、この行は既定の値のままなので、食い違って読まれた）
  // hp_floor は HP の値（割合ではない。S4 §35.6 の 3）。止まるのは「以下」（マクロの判定と同じ）
  const stopText = t(L, `HP ${floor50} 以下で止まる（既定の hp_floor。HP の値）`, `stops at HP ${floor50} or below (default hp_floor, an HP value)`);
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
        // いま隣にいる近接の敵は、離れる前に相手の手番が来れば 1 回殴りうる（最悪の被害に入れてある。engine に離れぎわの攻撃の規則は無い: S6 §49.6 の 3。「追いつけるのは 0 体」を安全と読まれた。S1b §12.4 の 8）
        const adj = x.huntingReach.filter((m) => m.dist <= 1 && !m.traits.includes('ranged')).length;
        // 見込みと最悪を並べる（S1c §14.4 の 1。見込みは、いちばん重い 1 体を最大の一撃、残りを平均の被害で数える）
        const both = c.expected < c.worst ? t(L, `被害の見込み ${c.expected}・最悪 ${c.worst}`, `expected ${c.expected}, worst ${c.worst} damage`) : t(L, `最悪 ${c.worst} の被害`, `worst ${c.worst} damage`);
        return t(L, `階段まで ${n} 歩。追われたままなら${both}（追いつけるのは ${c.catchers} 体・射撃 ${c.shooters} 体${adj ? `・いま隣の ${adj} 体は、離れる前に相手の手番が来れば殴られる（最悪の見込みに 1 回ずつ入れてある）` : ''}。HP ${hpNow}）`,
          `${n} steps to the stairs. If they keep chasing you, ${both} (${c.catchers} can catch you, ${c.shooters} shooting${adj ? `; the worst case includes one hit each from the ${adj} adjacent, if they act before you get away` : ''}; HP ${hpNow})`);
      })();
  };
  // マクロの行は、命令が最初の一歩で断らないときだけ出す（S5c・S6 §49.6 の 2: 断る判定と同じ macroProbe）
  const refused = (cmd: Command): MacroStop | null => { const d = macroProbe(view, cmd, catalog).decision; return 'stop' in d ? d.stop : null; };
  const stairsLine = (type: 'down' | 'up'): string => {
    // 最寄りの階段の上に敵がいる: travel_to はふさがれて止まる（V3-7a 後の評価: 「階段まで 1 歩」と勧めて blocked になった）
    const near = nearestStairs(type);
    if (near?.occupied_by) {
      const who = x.hostiles.find((h) => h.id === near.occupied_by)?.name ?? near.occupied_by;
      return `travel_to stairs_${type} (${t(L, `不可: 階段の上に ${who} がいる（倒すか、どくのを待つ）`, `unavailable: ${who} stands on the stairs (defeat it or wait for it to move)`)})`;
    }
    const risk = stairsRisk(type);
    const sep = t(L, '・', '; ');
    const mode = adjAwake.length ? 'flee' : x.huntingReach.length ? 'steady' : undefined;
    // 断られる形なら、断りの理由を「不可」として出す（S6 §49.6 の 2。逃げる移動が死にうる: flee_lethal など）
    const stop = refused({ type: 'travel', to: `stairs_${type}`, ...(mode ? { mode } : {}) });
    // steady が断られても（HP がすでに hp_floor 以下など）、flee が通るなら flee の行を出す（S6a §50.4 の 3。前の形）
    const fleeStop = stop && mode === 'steady' ? refused({ type: 'travel', to: `stairs_${type}`, mode: 'flee' }) : stop;
    if (stop && !fleeStop) return `travel_to stairs_${type} mode:flee${risk ? ` (${risk})` : ''}`;
    if (fleeStop) {
      // 両方断られる: 理由（flee まで試したなら flee の理由）と、まだ取れる手（move で 1 歩ずつ・帰還の綱）
      const shown = mode === 'steady' ? 'flee' : mode;
      const life = view.inventory.find((i) => !!i.kind && !!catalog.items[i.kind]?.bound);
      const still = mode ? t(L, `。move で 1 歩ずつは動ける${life ? `・帰還の綱（use_item { slot: '${life.slot}' }）` : ''}`, `; you can still step with move${life ? ` or use the lifeline (use_item { slot: '${life.slot}' })` : ''}`) : '';
      const why = macroStopError(L, fleeStop, { type: 'travel', to: `stairs_${type}` }).message.replace(/[。.]$/, '');
      return `travel_to stairs_${type}${shown ? ` mode:${shown}` : ''} (${t(L, '不可: ', 'unavailable: ')}${why}${risk ? sep + risk : ''}${still})`;
    }
    if (adjAwake.length) return `travel_to stairs_${type} mode:flee${risk ? ` (${risk})` : ''}`;
    if (x.huntingReach.length) return `travel_to stairs_${type} mode:steady (${stopText}${risk ? sep + risk : ''})`;
    return `travel_to stairs_${type}`;
  };
  // fight に載せられる能動技（強打・なぎ払い。使える手番ごとに使う。V3-4a §25.3）
  const meleeAb = x.abilities.filter((a) => { const h = abilityHandlerOf(catalog, a.id); return (h === 'strike' || h === 'cleave') && a.uses_left !== 0; });
  const abArg = meleeAb.length ? ` abilities:${meleeAb.map((a) => a.id).join(',')}` : '';
  const abNote = meleeAb.length ? t(L, `・${meleeAb.map((a) => `${a.name}${a.cooldown_left ? `(あと${a.cooldown_left})` : ''}`).join('・')}を使える手番に使う`, `, uses ${meleeAb.map((a) => `${a.name}${a.cooldown_left ? ` (in ${a.cooldown_left})` : ''}`).join(', ')} when ready`) : '';
  const abCmd = meleeAb.length ? { abilities: meleeAb.map((a) => a.id) } : {};
  for (const m of x.hostiles.filter((h) => h.dist <= 1)) if (!refused({ type: 'fight', target: m.id, ...abCmd })) out.push(`fight ${m.id}${abArg} (${m.name}・${stopText}${abNote})`);
  // 群れ: 追跡中の敵が 2 体以上なら、倒したら次の相手へ続ける形（V3-4b §28.4）
  const pack = x.hostiles.filter((h) => h.awareness === 'hunting' && !h.fleeing).sort((a, b) => a.dist - b.dist);
  if (pack.length >= 2 && !refused({ type: 'fight', target: pack[0].id, until: 'clear', ...abCmd })) out.push(`fight ${pack[0].id} until:clear${abArg} (${t(L, `追跡中の ${pack.length} 体と決着まで: 倒したら次の相手へ・${stopText}`, `settle all ${pack.length} hunters: next one after each kill, ${stopText}`)}${abNote})`);
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
    if (a.cooldown_left > 0) { out.push(`use_ability ${a.id} (${t(L, `不可: ${a.name}はあと ${a.cooldown_left} 手番`, `unavailable: ${a.name} is ready in ${a.cooldown_left} turns`)})`); continue; }
    const desc = def ? nameOf(def.desc, L, '') : '';
    if (a.target === 'adjacent') {
      for (const m of adjFoes.slice(0, 2)) out.push(`use_ability ${a.id} target:${m.id} (${a.name}: ${m.name}・${desc})`);
    } else if (a.target === 'throw') {
      const tg = x.hostiles.filter((m) => m.shots.some((s) => s.state === 'clear')).sort((p1, p2) => Number(x.attackers.has(p2.id)) - Number(x.attackers.has(p1.id)) || p1.dist - p2.dist).slice(0, 2);
      for (const m of tg) out.push(`use_ability ${a.id} target:${m.id} (${a.name}: ${m.name}${m.awareness !== 'hunting' ? t(L, '・気づいていないので会心', ', unaware: a critical hit') : ''}・${desc})`);
    } else if (a.target === 'dir') {
      // 身をかわす: 隣に起きている敵がいるときだけ、離れる向きを例に出す
      const near = adjFoes.find((m) => m.awareness !== 'asleep');
      if (near) {
        // 離れる向きはすべて 1 行に（V3-3 後の AI 評価: 2 つだけ出していたので、ほかの向きは使えないと読めた）
        const away = x.passable_dirs.filter((d) => { const v = DIR_VEC[d]; return cheb({ x: pos.x + v[0], y: pos.y + v[1] }, near.pos) > 1; });
        // 動くマスの数を先に（S6 §49.6 の 4: 1 歩のつもりで、階段を通り越した。1 マス先が階段でも止まらない）
        const steps = def?.steps;
        // 罠を踏めばそこで止まる（S6a §50.4 の 5）
        const stepNote = steps && steps > 1 ? t(L, `${steps} マス動く（壁・閉じた扉・ほかの者の手前まで。罠を踏めばそこで止まる。1 マス先が階段でも止まらない）。`, `moves ${steps} cells (up to a wall, closed door or someone in the way; stepping on a trap stops it there; it does not stop on stairs one cell away). `) : '';
        if (away.length) out.push(`use_ability ${a.id} target:${away.length > 1 ? `<${away.join('|')}>` : away[0]} (${a.name}: ${stepNote}${desc})`);
      }
    } else if (def && a.target === 'none') {
      if (def.handler === 'cleave') { if (adjFoes.length) out.push(`use_ability ${a.id} (${t(L, `${a.name}: 隣の ${adjFoes.length} 体`, `${a.name}: ${adjFoes.length} adjacent`)})`); }
      else if (def.handler !== 'heal_pct' || view.self.stats.hp < view.self.stats.maxHp) out.push(`use_ability ${a.id} (${a.name}: ${desc})`);
    }
  }
  // 迎え撃つ: 追跡中で届かない相手は、隣に来るまで待って戦う（最大 10 手番）。射撃する相手は待ち受けない（V3-2R3a §22.2）
  if (!adjAwake.length) {
    const comer = x.huntingReach.filter((m) => m.dist > 1 && !m.traits.includes('stationary') && !m.traits.includes('ranged'))[0];
    if (comer && !refused({ type: 'fight', target: comer.id, ...abCmd })) out.push(`fight ${comer.id}${abArg} (${t(L, `${comer.name} を迎え撃つ: 隣に来るまで待つ・${stopText}`, `meet ${comer.name}: waits until it is adjacent, ${stopText}`)}${abNote})`);
    const shooter = x.huntingReach.filter((m) => m.dist > 1 && m.traits.includes('ranged'))[0];
    // 寄られると下がるのは、すぐ近く（数マス以内）に寄られたときだけ。それより遠い間と、下がれないときは撃ってくる（S3a §27.6 の 5。ai の ranged_kiter）
    if (shooter && !refused({ type: 'travel', to: shooter.id })) out.push(`travel_to ${shooter.id} (${t(L, `${shooter.name}: 近づく（すぐ近くまで寄られると下がり、下がる間は撃たない。それより遠い間と、下がれないときは撃ってくる）／視線を切る`, `${shooter.name}: close in (it backs off once you are right next to it and does not shoot while backing off; it shoots while you are farther away or when it cannot back off) / break line of sight`)})`);
  }
  if (!adjAwake.length) {
    const exStop = x.frontiers > 0 || x.pickables > 0 ? refused({ type: 'explore' }) : 'explored';
    if (!exStop) out.push(x.pickables > 0 ? `explore (${t(L, `拾えるアイテム ${x.pickables} 個も拾う`, `also picks up ${x.pickables} items`)})` : 'explore');
    else if (exStop === 'explored') out.push(`explore (${t(L, '不可: 探索済み・拾う物なし', 'unavailable: explored, nothing to pick up')})`);
    // ほかの理由で断られる（S6 §49.6 の 2）: 理由を「不可」として
    else out.push(`explore (${t(L, '不可: ', 'unavailable: ')}${macroStopError(L, exStop, { type: 'explore' }).message})`);
    // 方角を優先する探索は、命令が最初の一歩で断らないときだけ出す（S5c: 断る判定と同じ macroProbe。前は「境界がある」だけを見ていて、
    // その方角に行ける境界が無いと toward_exhausted で断られた）
    const towardOk = (toward: 'draft' | 'sense') => !('stop' in macroProbe(view, { type: 'explore', toward }, catalog).decision);
    // 下への風の方角の未探索を優先する（V3-2R3 §20.5）
    if (x.frontiers > 0 && x.draft && towardOk('draft')) out.push(`explore toward:draft (${t(L, `下への風の${DIR_JA[x.draft]}を優先`, `prefer the draft (${x.draft})`)})`);
    // 遺物・守護者の気配の方角の未探索を優先する（V3-4b §28.7）
    if (x.frontiers > 0 && view.sense && towardOk('sense')) out.push(`explore toward:sense (${t(L, `${view.sense.what === 'relic' ? '遺物' : '守護者'}の気配の${DIR_JA[view.sense.dir]}を優先`, `prefer the ${view.sense.what} you sense (${view.sense.dir})`)})`);
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
  if (x.mineCount > 0 && !adjAwake.length && !refused({ type: 'collect' })) out.push(`collect (${t(L, `自分が投げた物 ${x.mineCount} 個を回収`, `pick up ${x.mineCount} thrown items`)})`);
  if (x.collectable > 0 && !adjAwake.length && !refused({ type: 'collect', what: 'items' })) out.push(`collect what:items (${t(L, `見えている・記憶したアイテム ${x.collectable} 個を拾って回る（数は、いま居るマスから ${COLLECT_WITHIN} 歩以内の品。1 つ拾うと、そこから次の品までを数え直して続ける。遺物は除く）`, `pick up ${x.collectable} known items (counting those within ${COLLECT_WITHIN} steps of where you stand; after each pickup it counts again from there; not the relic)`)})`);
  const throwGroups: { key: string; slots: string[]; targets: ObsMonster[] }[] = [];
  const lifelineLines: string[] = [];
  /** 綱の確定（協力プレイでは、全員が戻ったときに確定し、共有の分はそのときの値。V4-1g G4） */
  // 目的を達成していれば、綱の確定に目的の分が入らないことを添える（S3b §30.4 の 2: 「+N 確定」が目的を除いた額だと一目で分からなかった）
  const objNote = (x.lifelineObjective ?? 0) > 0 ? t(L, `（目的の分 ${x.lifelineObjective} 点は入らない）`, ` (the objective's ${x.lifelineObjective} is not included)`) : '';
  const lifeBank = (n: number) => (view.runMode === 'coop' && view.party.length > 1
    ? t(L, `・+${n}${objNote}（協力プレイ: 全員が戻ったときに確定。共有の分はそのときの値）`, `, +${n}${objNote} (co-op: banked when everyone is back; shared parts count then)`)
    : t(L, `・+${n} 確定${objNote}`, `, banks +${n}${objNote}`));
  for (const it of view.inventory) {
    const name = itemDisplayName(catalog, L, it.kind, it.appearanceId, it.affixes);
    const cat = itemCategory(catalog, it.kind, it.appearanceId);
    const ci = it.kind ? catalog.items[it.kind] : undefined;
    const harmful = !!ci?.harmful;
    if (ci?.bound && ci.usable) {
      // 帰還の綱: 手番の数・今の群れの被害見込み・確定点（V3-2R2 §18.1）。危なくないとき（追跡中の敵がおらず HP が半分超）は短い行だけ
      if (!x.huntingReach.length && view.self.stats.hp * 2 > view.self.stats.maxHp) {
        out.push(`use_item ${it.slot} (${name}${x.ifLifeline !== undefined ? lifeBank(x.ifLifeline) : ''})`);
        continue;
      }
      const turns = catalog.rules?.lifeline?.turns ?? 0;
      const risk = x.huntingReach.length
        ? t(L, `・追跡中 ${x.huntingReach.length} 体の 1 手の最悪の被害 ${x.worstSum}${x.unrecorded ? `＋記録なし ${x.unrecorded} 体` : ''}`, `, ${x.huntingReach.length} hunting: worst ${x.worstSum}/turn${x.unrecorded ? ` + ${x.unrecorded} unrecorded` : ''}`) : '';
      const how = x.lifelineShort ? t(L, 'キャンプへ戻る', 'back to camp') : (turns > 0 ? t(L, `${turns} 手番動けずにキャンプへ戻る`, `${turns} turns helpless, then back to camp`) : t(L, 'その場でキャンプへ戻る（命と、目的を除く戦利品の半分を持ち帰る）', 'back to camp at once (you keep your life and half the haul without the objective)'))
        + (x.lifelineShort ? '' : t(L, '・次の遠征はこの遠征を始めた階段から', '; the next expedition starts from where this one began'));
      const left = x.mineCount > 0 ? t(L, `・投げた物が ${x.mineCount} 個、この階の床に残っている`, `; ${x.mineCount} of your thrown items are still on this floor`) : '';
      const line = `use_item ${it.slot} (${t(L, `${name}: ${how}${x.ifLifeline !== undefined ? lifeBank(x.ifLifeline) : ''}${risk}${left}`, `${name}: ${how}${x.ifLifeline !== undefined ? lifeBank(x.ifLifeline) : ''}${risk}${left}`)})`;
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
    // 呼べる形（V4-1g G5）: throw_item <slot> target:<id>。どちらも <a|b> はどれか 1 つ
    const alt = (xs: string[]) => (xs.length > 1 ? `<${xs.join('|')}>` : xs[0]!);
    const attacking = g.targets.filter((m) => x.attackers.has(m.id) && !m.fleeing).map((m) => m.id);
    out.push(`throw_item ${alt(g.slots)} target:${alt(g.targets.map((m) => m.id))}${attacking.length ? t(L, ` (${attacking.join('・')} はあなたを攻撃中)`, ` (${attacking.join(', ')} attacking you)`) : ''}`);
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
    // 断られる形なら出さない（S6 §49.6 の 2）
    const withCmd = withKind && kinds.length > 1 ? { with: kinds[0], alsoWith: kinds.slice(1) } : { with: withKind ? shortId(withKind) : g.slots[0] };
    if (refused({ type: 'fight', target: far.id, ...withCmd, ...(aimed ? { abilities: [aimed.id] } : {}) })) continue;
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
      // 野営の火（S1 §8.1・§8.3）: engine の判定と同じ順（この階で使った・追跡中の敵・休憩の上限）
      if (e.campfire) {
        const capHp = restCapHp(catalog.rules, view.self.stats.maxHp);
        const xno = view.expedition && view.expedition.status !== 'ended' ? view.expedition.no : 0;
        const why = fireUsedDepths(view.season, xno).includes(f.depth) ? t(L, '不可: この遠征では、この階の火をもう使った', 'unavailable: already used a campfire on this floor this expedition')
          : hunting ? t(L, '不可: 追跡中の敵が見えている', 'unavailable: a hunting enemy is in view')
            : view.self.stats.hp >= capHp ? t(L, `不可: HP はもう休憩の上限（${capHp}）`, `unavailable: HP is at the rest cap (${capHp})`) : null;
        out.push(`interact${d ? ' ' + d : ''} (${why ?? t(L, `${campfireName(catalog, L, e.kind, e.campfire)}: HP を ${capHp} まで戻す（+${capHp - view.self.stats.hp}）`, `${campfireName(catalog, L, e.kind, e.campfire)}: heal to ${capHp} (+${capHp - view.self.stats.hp})`)})`);
        continue;
      }
      if (fd?.interactable && e.state !== 'used' && (!fd.afterInteract || e.state !== fd.afterInteract)) out.push(`interact${d ? ' ' + d : ''} (${kindName(catalog, L, e.kind)})`);
    }
  }
  // 野営の火を置く（S1 §8.2）: シーズンのランだけ。engine の判定と同じ順で、見えている分から（最後に決めるのは engine）
  if (view.season && catalog.rules.seasonFire) out.push(placeFireLine(view, catalog, hunting));
  // 補給の置き場（S3 §25.2）: 置き場にいるときだけ。預けられる品と、取れる品
  if (view.season && catalog.rules.seasonSupply) out.push(...supplyLines(view, catalog));
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

/** 能力の行（迷宮の観測と、区切りのあるキャンプの観測で同じ。S7） */
function statsLine(obs: Observation, L: Locale): string {
  const s = obs.self;
  const st = s.statuses.length ? s.statuses.map((x) => `${x.name}(${x.turns_left})`).join(' ') : t(L, 'なし', 'none');
  return t(L,
    `能力: 命中+${s.attack.acc} ダメージ${s.attack.dmg} 回避${s.defense.eva} 装甲${s.defense.armor} 速さ${s.speed} XP ${s.xp}/${s.xp_next} 状態:${st}`,
    `Stats: acc+${s.attack.acc} dmg ${s.attack.dmg} eva ${s.defense.eva} armor ${s.defense.armor} speed ${s.speed} XP ${s.xp}/${s.xp_next} status:${st}`);
}

/** 所持品の行（装備は * に一本化。迷宮の観測と、区切りのあるキャンプの観測で同じ。S7） */
function inventoryLines(obs: Observation, L: Locale): string[] {
  const s = obs.self;
  if (!s.inventory) return [t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}、* は装備中): `, `Inventory (${s.inventory_count}/${s.inventory_capacity}, * = equipped): `) + (s.inventory_brief || '-')];
  return [
    t(L, `所持品 (${s.inventory_count}/${s.inventory_capacity}、* は装備中):`, `Inventory (${s.inventory_count}/${s.inventory_capacity}, * = equipped):`),
    ...s.inventory.map((it) => `  ${it.slot}) ${it.name}${it.qty > 1 ? ` x${it.qty}` : ''}${it.equipped ? '*' : ''}${it.identified ? '' : t(L, ' (未鑑定)', ' (unidentified)')}${it.curse === 'cursed' ? t(L, ' {呪い:外せない}', ' {cursed}') : it.curse === 'unknown' ? t(L, ' {呪い?}', ' {curse?}') : ''}`),
  ];
}

/** キャンプの区切りの観測の能力と所持品（S7 §52.2 の 1: 「この表示が正本（持ち物・装備・能力…）」と言うので、キャンプにも出す） */
function statsAndInventoryLines(obs: Observation, L: Locale): string[] {
  return [statsLine(obs, L), ...inventoryLines(obs, L)];
}

/** 区切りの段（S7 §52.2 の 1）: 今あるメモ（新しい順に 8 件まで）・決まった 1 段・覚え書きの定型 */
export function checkpointLines(L: Locale, c: ObsCheckpoint): string[] {
  const out: string[] = [];
  if (c.notes.length) {
    out.push(c.notes_total > c.notes.length
      ? t(L, `あなたのメモ（新しい順に ${c.notes.length} 件。全部で ${c.notes_total} 件は notes で）:`, `Your notes (newest ${c.notes.length} of ${c.notes_total}; all with notes):`)
      : t(L, 'あなたのメモ（新しい順）:', 'Your notes (newest first):'));
    for (const n of c.notes) out.push(`- ${n.index}: ${n.text}`);
  }
  out.push(t(L, `区切り: ${c.text}`, `Break: ${c.text}`));
  out.push(t(L, `覚え書きの定型（項目の名前だけ。中身はあなたが書く）: ${c.template.join('／')}`, `Note template (item names only; you write the content): ${c.template.join(' / ')}`));
  out.push(t(L, `書き方: notes { add: "${c.template[0]}: …" }（1 件 280 字まで。項目ごとに 1 件ずつ。手番を使わない）`, `How: notes { add: "${c.template[0]}: ..." } (up to 280 characters each; one note per item; free)`));
  return out;
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
    const pt = partyText(L, obs.party ?? []);
    if (pt) lines.push(pt);
    // シーズン（S0 §9.6）: 予算・賞ごとの順位・報告していない階段
    if (obs.season) {
      lines.push(obs.season.text);
      for (const a of obs.season.awards ?? []) lines.push(a.text);
      if (obs.season.fires_text) lines.push(obs.season.fires_text);
      for (const n of obs.season.fire_news ?? []) lines.push(n.text);
      // 補給の置き場（S3 §25.2）: 自分の預けた品と、取られた知らせ
      if (obs.season.deposits_text) lines.push(obs.season.deposits_text);
      for (const n of obs.season.supply_news ?? []) lines.push(n.text);
      // 初めて受け取った討伐の記録（S5b）
      for (const n of obs.season.slay_news ?? []) lines.push(n.text);
      if (obs.season.stairs) lines.push(t(L, `まだ報告していない階段 ${obs.season.stairs.unreported}（うち、まだだれも公開していないもの ${obs.season.stairs.unpublished}）${obs.season.stairs.unreported ? '。report_stairs で報告できる' : ''}`, `Unreported stairs ${obs.season.stairs.unreported} (not yet published by anyone: ${obs.season.stairs.unpublished})${obs.season.stairs.unreported ? '. Report them with report_stairs' : ''}`));
      // 特別な場所（S1c §14.5）: 見つけたものがあるときだけ
      if (obs.season.spots?.unreported) lines.push(t(L, `まだ報告していない特別な場所（祭壇・賭けの祭壇・碑文） ${obs.season.spots.unreported}（うち、まだだれも公開していないもの ${obs.season.spots.unpublished}）。report_stairs で一緒に報告できる`, `Unreported special places (altars, altars of chance, inscriptions) ${obs.season.spots.unreported} (not yet published by anyone: ${obs.season.spots.unpublished}). report_stairs reports them too`));
    }
    // 遠征が進んでいる（仲間がまだ迷宮にいる）: 全員が戻ったら、次の遠征を選べる（V4-1g G1）
    if (obs.expedition && obs.expedition.status !== 'ended') lines.push(t(L, `遠征 ${obs.expedition.no} が進んでいる（仲間がまだ迷宮にいる）。全員が戻ったら、次の遠征を選べる`, `Expedition ${obs.expedition.no} is still under way (allies are still inside). You can choose the next one when everyone is back`));
    if (obs.expedition?.result) lines.push(obs.expedition.result.text);
    // 直前の遠征の比較（1 行。目標の宣言は V3-8 §53.5 で外した）
    if (obs.camp?.compare?.lines.length) lines.push(obs.camp.compare.lines[0]);
    // 倒さずに帰った節目の大守護者への挑戦と、先に倒した者の記録（S5 §47.4 の 2。その遠征の後のキャンプだけ）
    for (const x of obs.camp?.compare?.wardens ?? []) lines.push(...x.lines);
    lines.push(t(L, `確定済み ${s.score.banked} 点・達成した遠征 ${s.score.expeditions_completed}`, `Banked ${s.score.banked}, expeditions completed ${s.score.expeditions_completed}`));
    lines.push(boonsText(L, s.boons ?? []));
    // 区切り（S7 §52.2 の 1）: 「この表示が正本（持ち物・装備・能力…）」と言うので、能力と所持品もキャンプの表示に出す
    if (obs.checkpoint) lines.push(...statsAndInventoryLines(obs, L));
    if (obs.camp?.milestone) lines.push(obs.camp.milestone.text);
    if (obs.camp?.archive) lines.push(t(L, `記録庫: 欠片 ${obs.camp.archive.delivered}/${obs.camp.archive.total}`, `Archive: shards ${obs.camp.archive.delivered}/${obs.camp.archive.total}`));
    // 討伐の記録（S4 §35.5）: 節目ごとに 1 行
    for (const s of obs.camp?.archive?.slays ?? []) lines.push(s.text);
    // プロフィール（V3-7 §7.2・§7.4）: 記録の要約と次の節目、直前の遠征で取った実績
    if (obs.camp?.records?.feats_new?.length) lines.push(t(L, `新しい実績: ${obs.camp.records.feats_new.join('・')}`, `New feats: ${obs.camp.records.feats_new.join(', ')}`));
    if (obs.camp?.records) lines.push(obs.camp.records.line);
    if (obs.camp?.version_note) lines.push(obs.camp.version_note);
    if (obs.alerts.length) lines.push('!! ' + obs.alerts.map((a) => a.text).join(' / '));
    const seasonClosed = obs.season && (obs.season.budget.left <= 0 || obs.season.ended);
    if (obs.camp && seasonClosed) {
      lines.push(obs.season!.budget.left <= 0
        ? t(L, 'このシーズンの行動予算を使い切った。新しい遠征は始められない（報告と引退はできる。ここで終えてよい）', 'You have used up this season\'s budget. No more expeditions (you can still report and retire; it is fine to stop here)')
        : t(L, 'シーズンは終わりの時刻を過ぎた。新しい遠征は始められない（報告と引退はできる。ここで終えてよい）', 'The season has passed its end time. No more expeditions (you can still report and retire; it is fine to stop here)'));
    } else if (obs.camp) {
      lines.push(t(L, `次の遠征の候補（遠征 ${obs.camp.next_no}）。start_expedition { offer } で始める:`, `Offers for expedition ${obs.camp.next_no} (start with start_expedition { offer }):`));
      for (const o of obs.camp.offers) lines.push('  ' + o.text);
      lines.push('  ' + t(L, 'endless) 目的なしでひたすら潜る（offer: "endless"）', 'endless) no objective, just descend (offer: "endless")'));
    }
    if (obs.recent_events.length) {
      lines.push(t(L, '直前の出来事:', 'Recent events:'));
      for (const e of collapseRepeats(obs.recent_events)) lines.push(`- ${e}`);
    }
    lines.push(t(L, 'できること: ', 'Actions: ') + obs.valid_actions.join(' / '));
    if (obs.checkpoint) lines.push(...checkpointLines(L, obs.checkpoint));
    return lines.join('\n');
  }
  // 通常の階でなければ階の種類も（聖域・大守護者の間など。V3-3 後の AI 評価: 敵のいない階が聖域と分からなかった）
  const ftText = s.floor?.floor_type_id && s.floor.floor_type_id !== 'core:standard' ? t(L, `（${s.floor.floor_type}）`, ` (${s.floor.floor_type})`) : '';
  const floorText = s.floor ? t(L, `地下${s.floor.depth}階 ${s.floor.biome_name}${ftText}`, `Depth ${s.floor.depth} ${s.floor.biome_name}${ftText}`) : '-';
  const posText = s.pos ? t(L, `位置(${s.pos.x},${s.pos.y})`, `pos(${s.pos.x},${s.pos.y})`) : '';
  lines.push(`[seq ${obs.seq} | ${floorText} | HP ${s.hp}/${s.max_hp} | Lv${s.level} | ${posText ? posText + ' | ' : ''}${statusText[obs.status][L === 'en' ? 1 : 0]}]`);
  // シーズン（S0 §9.6）: 迷宮の中は予算の残りだけ（順位は出さない）
  if (obs.season) lines.push(obs.season.text);
  if (obs.season?.fire_used) lines.push(obs.season.fire_used.text);
  if (obs.season?.support) lines.push(obs.season.support.text);
  // 補給の置き場（S3 §25.2）: この階の置き場と、いる置き場
  if (obs.season?.caches_text) lines.push(obs.season.caches_text);
  if (obs.season?.supply) lines.push(obs.season.supply.text);
  // 仲間（V4-1f §22.4）
  {
    const pt = partyText(L, obs.party ?? []);
    if (pt) lines.push(pt);
  }
  // 遠征は 1 行（目的・進捗・extract の可否 | 戦利品 | 気配）
  if (obs.expedition) {
    const x = obs.expedition;
    const head = fmt.expedition === 'short'
      ? t(L, `【遠征${x.no}】${x.can_extract ? 'この場で extract できる' : 'extract は階段の上で'}`, `[Expedition ${x.no}] ${x.can_extract ? 'you can extract here' : 'extract on stairs'}`)
      : x.text;
    lines.push([head, x.haul?.text, x.sense?.text, ...(x.ward_fires ?? []).map((w) => w.text)].filter(Boolean).join(' | '));
  }
  if (obs.alerts.length) lines.push('!! ' + obs.alerts.map((a) => a.text).join(' / '));
  lines.push(statsLine(obs, L));
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
      // あなたの投擲の射線と射程（S3a §27.6 の 5: 「射程外」を相手の射程と読まれた。相手の射撃は、相手の射程で届く）
      const shot = brief ? '' : m.shot === 'blocked' ? t(L, '  あなたの投擲の射線:通らない', ' your throw: line blocked') : outOf.length && outOf.length === m.shots.length ? t(L, '  あなたの投擲の射程外', ' out of your throwing range') : outOf.length ? t(L, `  あなたの投擲の射程外:${outOf.join(',')}`, ` out of your throwing range:${outOf.join(',')}`) : '';
      const threat = m.threat === null ? (m.first_seen ? t(L, '不明（初見）', 'unknown (first sighting)') : t(L, '不明（当てられた記録なし）', 'unknown (it has never landed a hit on you)')) : String(m.threat);
      const perTurn = m.worst_turn !== null && m.worst_turn !== m.worst_hit ? t(L, `（1 手に最悪 ${m.worst_turn}）`, ` (worst ${m.worst_turn}/turn)`) : '';
      // 最大の一撃が会心の値なら、そう書き、会心でない最大を添える（S6 §49.6 の 10: 骨の射手の 1 が会心で 8 に変わって見えた）
      const plain = m.worst_plain_hit !== undefined ? t(L, `（会心。会心でない最大 ${m.worst_plain_hit}）`, ` (a crit; worst non-crit ${m.worst_plain_hit})`) : '';
      const worst = m.worst_hit !== null ? t(L, `  最大の一撃:${m.worst_hit}${plain}${perTurn}`, ` worst_hit:${m.worst_hit}${plain}${perTurn}`) : '';
      // 見れば分かる特徴（速さは自分との比較）と命中の記録
      const looks = [m.size === 'large' ? t(L, '大柄', 'large') : m.size === 'small' ? t(L, '小柄', 'small') : '', m.speed === 'fast' ? t(L, `速い×${m.speed_ratio ?? ''}`, `fast x${m.speed_ratio ?? ''}`) : m.speed === 'slow' ? t(L, `遅い×${m.speed_ratio ?? ''}`, `slow x${m.speed_ratio ?? ''}`) : '', ...m.traits.map((tr) => abilityName(L, tr))].filter(Boolean);
      const looksText = looks.length ? (L === 'en' ? ` [${looks.join(', ')}]` : `  [${looks.join('・')}]`) : '';
      const hitLine = [hitsText(L, m.hits, m.role === 'guardian'), dealtText(L, m.dealt)].filter(Boolean).join(L === 'en' ? ', ' : '・');
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
    for (const ft of vis.features) lines.push(`- ${ft.name}${ft.lair ? t(L, `（${ft.lair}の棲み処）`, ` (${ft.lair}'s lair)`) : ''}${ft.id ? ` ${ft.id}` : ''} (${ft.pos.x},${ft.pos.y}) ${relLabel(L, from, ft.pos)}${ft.state && ft.state !== 'idle' ? ` [${featureStateText(L, ft.state)}]` : ''}${ft.public_by ? t(L, `（公開: ${ft.public_by} が報告）`, ` (published by ${ft.public_by})`) : ''}`);
    for (const st2 of stairsLines) {
      const name = st2.type === 'down' ? t(L, '下り階段', 'stairs down') : t(L, '上り階段', 'stairs up');
      // 公開された階段（S0 §9.4）: まだ自分の目で見ていない。途中の道は分からない
      const pub = st2.public_by ? t(L, `（公開: ${st2.public_by} が報告。まだ見ていない）`, ` (published by ${st2.public_by}; not yet seen)`) : '';
      lines.push(`- ${name} (${st2.pos.x},${st2.pos.y}) ${t(L, '距離', 'dist')}${st2.dist} ${st2.reachable ? t(L, '到達可', 'reachable') : t(L, '到達不明', 'unknown path')}${pub}`);
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
  if (fmt.inventory !== false) lines.push(...inventoryLines(obs, L));
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
      // 覚えている地物・品・罠（いま見えていない）: 座標で呼んだときと同じもの（説明・賭けの祭壇の表）を出す（S6 §49.6 の 5: 賭けの祭壇を ID で呼ぶと名前しか出なかった）
      if (r) p = r.pos;
      else if (target === view.self.id) p = view.self.pos;
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
      // 群れる（呼び声の届く広さ。S4 §42.2 の 4）・錆びさせる（効き目。S4 §42.3 の 1）は、公開カタログの数で中身を添える
      const traitDetail = (tr: string): string => {
        if (tr === 'pack' && cmLook?.packRadius) return t(L, `（1 体が気づくと、${cmLook.packRadius} マス以内の眠っている・気づいていない同じ種族も目を覚まして集まる）`, ` (when one notices you, others of its kind within ${cmLook.packRadius} cells that are asleep or unaware wake and gather)`);
        if (tr === 'rusting') {
          const st = cmLook?.onHitStatus?.find((s) => catalog.statuses[s.status]?.armor !== undefined);
          const arm = st ? catalog.statuses[st.status]!.armor! : undefined;
          if (st && arm !== undefined) return t(L, `（殴られて当たると、${st.turns} 手番のあいだ装甲 ${arm}。0 より下にはならず、重ならない（当たるたびに ${st.turns} 手番に戻る）。武器・防具そのものは傷まない）`, ` (a hit from it: armor ${arm} for ${st.turns} turns; not below 0, does not stack (each hit resets it to ${st.turns} turns); your weapon and armor themselves are not damaged)`);
        }
        return '';
      };
      const lookTraits = [...OBVIOUS_TRAITS.filter((tr) => cmLook?.tags.includes(tr)), ...(cmLook?.armored ? ['armored'] : []), ...(cmLook?.evasive ? ['evasive'] : [])].map((tr) => abilityName(L, tr) + traitDetail(tr));
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

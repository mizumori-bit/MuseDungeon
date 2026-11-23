// PlayerView: AI の Observation と人間のプレイ画面の共通の元データ。
// projectPlayerView はルール無しの純粋なフィルタ。仕様: docs/PROTOCOL.md §4
import type {
  CampState, Controller, Entity, EntityId, EntityRole, EquipSlot, Expedition, ExpeditionEndReason, ExpeditionResult, FloorKey,
  Locale, MonsterMemory, Objective, OfferSlot, PlayerBuild, PlayerId, PlayerState, Pos, RememberedEntity, SeasonState, Stats, StatusInst, World, Sense, FloorHint, Names, Intent, RelicInfo, MilestoneInfo,
} from './types';
import type { Dir } from './types';
import { cheb, compassDir } from './util';
import { projectSupplies, seasonBudgetLeft, seasonStairsCounts } from './season';
import type { SupplyTakenView, SupplyView } from './season';
import type { SeasonSlay, SupplyPlace } from './types';
import { SeasonSlaySchema } from './commands';

const clone = <T>(x: T): T => structuredClone(x);

export type HpState = 'healthy' | 'wounded' | 'badly_wounded' | 'near_death';
export type Awareness = 'asleep' | 'unaware' | 'hunting';
/** at_camp: 遠征と遠征の間（盤面にいない） */
export type ViewStatus = 'your_turn' | 'waiting_others' | 'dead' | 'ended' | 'at_camp';
/** 敵の HP 4 段階の境界（%）。公開ルール */
export const HP_BANDS: [number, number, number] = [75, 50, 25];

export interface ItemView {
  id: EntityId;
  slot: string;
  /** 未鑑定なら null */
  kind: string | null;
  appearanceId: string | null;
  qty: number;
  affixes: string[];
  equipped: EquipSlot | null;
  /** 宝の価値（見えた時点で分かる） */
  value?: number;
  /** 呪いの有無を確かめた（装備・鑑定・初期装備。V3-4）。見えていない呪いそのものは渡さない */
  inspected?: boolean;
}

export interface EntityView {
  id: EntityId;
  cat: 'monster' | 'player' | 'item' | 'feature' | 'trap';
  kind: string | null;
  appearanceId: string | null;
  pos: Pos;
  hp?: HpState;
  awareness?: Awareness;
  statuses?: string[];
  affixes?: string[];
  tier?: number;
  qty?: number;
  state?: string;
  playerId?: PlayerId;
  name?: string;
  /** 遠征の目的に関わる個体（守護者・遺物） */
  role?: EntityRole;
  /** 自分が見ている間にこの個体が受けた実ダメージの合計 */
  damageSeen?: number;
  /** 手負いで逃げている（追跡中でも extract・休息を妨げない） */
  fleeing?: boolean;
  /** 自分のセルから投擲の経路が通る（モンスター） */
  shot?: boolean;
  /** この個体を初めて見た seq（モンスター） */
  firstSeenSeq?: number;
  /** 自分が投げた物（アイテム） */
  mine?: boolean;
  /** 宝の価値（アイテム） */
  value?: number;
  /** 倒すと戦利品に入る賞金（守護者・名前付きの強敵） */
  bounty?: number;
  /** 速さ（モンスター。状態異常を除く素の値。見れば分かる性質。観測では自分との比較の 3 段階にする。V3-2R2 §18.2） */
  speed?: number;
  /** 自分の 1 手番に 2 回動いたのを見てから過ぎた手番（V3-8 §53.4）。見ていなければ無い */
  paceAgo?: number;
  /** 守護者の名前と型（公開）。weakness は試して分かったときだけ（V3-3 §3.1） */
  guardian?: { name: Names; title?: Names; types: string[]; weakness?: string; warden?: boolean; notWeak?: string[]; heavy?: boolean };
  /** 予備動作（見えていれば公開。V3-3 §3.1） */
  intent?: Intent;
  /** 棲み処の地物（護りの火）の持ち主の守護者の呼び名（V3-3c §44.6） */
  lair?: { name: Names; title?: Names };
  /** 野営の火（S1 §9.10）: 置いた者の名前 */
  campfire?: { by: string };
  /** 持っている品（倒すと落とす。宝物庫の鍵。V3-5 §5.1） */
  carries?: string;
  /** 名前付きの強敵の名前（V3-5 §5.4） */
  named?: Names;
  /** この遠征の目的の相手・品（目的の守護者・大守護者・賞金首・遺物。V4-1a §12.2） */
  objective?: true;
}

export interface RememberedView {
  id: EntityId;
  cat: RememberedEntity['cat'];
  kind: string | null;
  appearanceId: string | null;
  pos: Pos;
  qty: number;
  ft: number;
  state?: string;
  role?: EntityRole;
  /** 自分が投げた物 */
  mine?: boolean;
  value?: number;
  /** 品の接辞（S3a §27.6 の 6: 見えたときに分かる不変の性質。見えている品と同じ。「補強された革鎧」が覚えている地図で「革鎧」と出た） */
  affixes?: string[];
  /** 棲み処の地物の持ち主の守護者（V3-3c §44.6） */
  lair?: { name: Names; title?: Names };
  /** この遠征の目的の遺物（V4-1a §12.2） */
  objective?: true;
  /** 野営の火（S1 §9.10）: 置いた者の名前 */
  campfire?: { by: string };
}

/** 護りの火の手がかり（V3-3c §44.6）: 同じ守護者の火を 1 基でも見ていれば、まだ見ていない灯っている火の方角と遠さ（気配と同じ形） */
export interface WardHint { guardian: { name: Names; title?: Names }; dir: Dir; range: 'far' | 'near' }

export interface SelfView {
  id: EntityId;
  kind: string;
  name: string;
  classId: string;
  controller: Controller;
  pos: Pos | null;
  stats: Stats;
  speed: number;
  level: number;
  xp: number;
  statuses: StatusInst[];
  equip: Partial<Record<EquipSlot, EntityId>>;
  capacity: number;
  /** 自分が行動した手番数 */
  turns: number;
  /** 自然回復の蓄積値 */
  regen: number;
  /** ビルド（V3-4）: 取った特技・選んでいない候補・覚えた能動技（readyAt は手番数 turns と比べる） */
  build: PlayerBuild;
  /** 加護（V3-3 §3.3）と、遠征に 1 回の加護を使った遠征の通番 */
  boons: string[];
  boonUsed: Record<string, number>;
  /** 選べる加護の候補（大守護者を倒した。V3-3 §3.2） */
  boonChoice?: { options: string[]; source: string; depth: number };
}

export interface PartyMemberView {
  playerId: PlayerId;
  entityId: EntityId;
  name: string;
  classId: string;
  controller: Controller;
  state: PlayerState;
  depth: number | null;
  /** 迷宮にいる仲間の HP の段階（見えていなくても・別の階でも。V4-1g G3）。迷宮にいなければ null */
  hp: HpState | null;
  /** その仲間が自分で出した命令で最後に行動したときの手番数（V4-1j §30.6。時間切れの待機は数えない。見えていなくても・別の階・キャンプでも） */
  lastAct: number;
  /** 同じ階にいる仲間の位置（見えていなくても。V4-1k §32.3）。別の階・迷宮にいなければ null。位置だけで、その場所の地形・敵は渡さない */
  pos: Pos | null;
}

/** 遠征の事実（目的・進捗）。守護者や遺物の居場所は含まない */
export interface ExpeditionView {
  no: number;
  objective: Objective;
  points: number;
  relicGuarded: boolean;
  status: Expedition['status'];
  endReason: ExpeditionEndReason | null;
  progress: { reached: boolean; guardianSlain: boolean; relicHeld: boolean; relicHeldByYou: boolean; vaultOpened?: boolean };
  /** 自分が extract 済みか */
  extracted: boolean;
  /** 帰った参加者と帰り方（V4-1g G4: 協力プレイの確定の、だれの分か） */
  returns: { player: PlayerId; completed: boolean; lifeline: boolean }[];
  result: ExpeditionResult | null;
  startSeq: number;
  endSeq: number | null;
  slot: OfferSlot | null;
  traits: string[];
  multiplierPct: number;
  /** 共有の戦利品（賞金・発見・撃破）。目的・深追い・宝は観測で計算する */
  haul: { bounty: number; discovery: number; kills: number };
  /** この遠征で到達した最深階 */
  maxDepth: number;
  /** この遠征で下り階段に立った最も深い階（踏破） */
  crossedDepth: number;
  /** 守護者の名前と型（公開。V3-3）。弱点と種族は渡さない */
  /** 守護者（V3-3）。weakness は試して分かったときだけ */
  guardian?: { rank: 1 | 2 | 3; name: Names; title?: Names; types: string[]; weakness?: string };
  /** 遺物の名前と加護（V3-3 §3.3。公開） */
  relic?: RelicInfo;
  /** 開始時点の次の節目（V3-3 §3.2） */
  milestone?: MilestoneInfo;
  /** ブリーフィングの物語の 1 文（V3-3 §3.4） */
  story?: Names;
}

export interface PlayerView {
  runId: string;
  playerId: PlayerId;
  seq: number;
  status: ViewStatus;
  locale: Locale;
  terrainTable: string[];
  self: SelfView;
  inventory: ItemView[];
  /** traits: 今いる階を作ったときに効いた条件（V4-0e §8.1。群れる・乏しい・静かの「泉なし」。作られた階に残る性質） */
  floor: { key: FloorKey; depth: number; biome: string; floorType: string; width: number; height: number; time: number; noWander: boolean; traits?: string[] } | null;
  visibleCells: number[];
  entities: EntityView[];
  /** unsighted: 地形は知っているが、まだ目で見ていないセル（地図の巻物で知った区画） */
  memory: { terrain: number[]; remembered: RememberedView[]; unsighted?: number[] };
  /** 目標の気配（遠征の目標階にいる間） */
  sense: Sense | null;
  /** 護りの火の手がかり（V3-3c §44.6） */
  wardHints?: WardHint[];
  /** 未鑑定の手がかり（V3-5 §5.4）: 見た目 → 手がかり */
  clues?: Record<string, Names>;
  /** 今いる階の異変の到着の文（V3-5 §5.3。ID と中身は渡さない） */
  floorEvent?: Names;
  /** 今いる階の手がかり（下への風・探索の進み具合）。今いる階のものだけ */
  floorHint: FloorHint | null;
  identified: string[];
  monsterMemory: Record<string, MonsterMemory>;
  /** 記録庫が返した節目の大守護者の記憶と、納めた遺物（V3-3a §35.7） */
  wardenIntel: Record<string, { weakness?: string; hp?: number; maxHit?: number; armor?: number }>;
  archive: string[];
  notes: string[];
  party: PartyMemberView[];
  turn: { current: EntityId | null; mine: boolean };
  runStatus: 'active' | 'ended';
  runMode: 'solo' | 'coop';
  /** 現在（または直前）の遠征。遠征の無い古いランでは null */
  expedition: ExpeditionView | null;
  /** 遠征と遠征の間の候補（キャンプ）。遠征中は null */
  camp: CampState | null;
  /** 最深到達階（パーティ全体の生成済み最深） */
  deepestDepth: number;
  /** 目標として達成した最深の階（次の候補の基準。V3-2R3 §20.2） */
  campDepth: number;
  /** 倒した節目の大守護者の深さ（V3-3 §3.2） */
  milestonesCleared: number[];
  /** 自分の成績（スコア版 2 の確定点・失った戦利品・達成した遠征の数） */
  record: { banked: number; lost: number; expeditions: number };
  /**
   * シーズンの写し（S0。PROTOCOL §9.6。シーズンのランだけ）。budgetLeft: 今の予算の残り。
   * unreported・unpublished: まだ報告していない階段と、そのうち取り込んだ一覧でまだだれも公開していないもの
   */
  season?: Omit<SeasonState, 'supplies' | 'deposited' | 'taken' | 'mineTaken' | 'supplyNews'> & {
    budgetLeft: number; unreported: number; unpublished: number; spotsUnreported: number; spotsUnpublished: number;
    /**
     * 補給の置き場（S3。SEASON.md §25.2）。cache: 場所を知っている置き場の今の中身、cacheHidden: 場所をまだ知らない置き場（まだ見ていない下り階段）の深さごとの数、
     * supplyTaken: このランで取った品（no は遠征）、myDeposits: 自分の預けた品で、まだだれも取っていないもの、cacheNews: 前の取り込みから、ほかの者が取った自分の品。
     * 種類は、預けた者か見る者が鑑定済みのときだけ（ほかは外見だけ）
     */
    cache?: SupplyView[]; cacheHidden?: { depth: number; count: number; place: SupplyPlace }[]; supplyTaken?: (SupplyView & { no: number })[]; myDeposits?: SupplyView[]; cacheNews?: SupplyTakenView[];
  };
}

export function hpState(hp: number, maxHp: number): HpState {
  const pct = maxHp > 0 ? Math.trunc((hp * 100) / maxHp) : 0;
  if (pct >= HP_BANDS[0]) return 'healthy';
  if (pct >= HP_BANDS[1]) return 'wounded';
  if (pct >= HP_BANDS[2]) return 'badly_wounded';
  return 'near_death';
}

/** 現在（未終了）の遠征。無ければ null */
export function currentExpedition(world: World): Expedition | null {
  const list = world.expeditions;
  if (!list?.length) return null;
  const last = list[list.length - 1];
  return last.status === 'ended' ? null : last;
}

/**
 * この遠征の目的の相手・品の ID（V4-1a §12.2）: 目的の守護者・賞金首・遺物と、目的の節目の階の大守護者。
 * プレイヤーは目的（種類・階・名前）を知っているので、照らし合わせを観測の側で済ませるだけ。参加していない遠征なら空
 */
export function objectiveEntityIds(world: World, playerId: PlayerId): Set<EntityId> {
  const out = new Set<EntityId>();
  const x = currentExpedition(world);
  if (!x || !x.participants.includes(playerId)) return out;
  const t = x.objective.type;
  if (t === 'slay_guardian' && x.targets.guardian) out.add(x.targets.guardian);
  if (t === 'retrieve_relic' && x.targets.relic) out.add(x.targets.relic);
  if (t === 'slay_bounty' && x.targets.bounty) out.add(x.targets.bounty);
  if (t === 'slay_warden' && x.objective.targetDepth !== null) {
    const fk = `main:${x.objective.targetDepth}`;
    for (const e of Object.values(world.entities)) if (e.guardian?.warden && e.pos?.floor === fk) out.add(e.id);
  }
  return out;
}

/** 最新の遠征（終了済みを含む） */
export function latestExpedition(world: World): Expedition | null {
  const list = world.expeditions;
  return list?.length ? list[list.length - 1] : null;
}

/**
 * 目標として達成した最深の階（V3-2R3 §20.2）: 階段の上で目的を達成して帰った遠征の目標深度の最大（綱では上がらない。V3-4b §28.1）。無ければ 0。
 * 次の候補の深さはここから数える（踏破で先まで降りても深くならない）
 */
export function campDepthOf(world: World): number {
  let d = 0;
  for (const x of world.expeditions ?? []) {
    if (x.objective.targetDepth !== null && x.extracted.some((r) => r.completed && !r.lifeline)) d = Math.max(d, x.objective.targetDepth);
  }
  return d;
}

/** 候補から、プレイヤーに渡さない守護者の種族を外す */
export function stripCamp(camp: CampState): CampState {
  const c = structuredClone(camp);
  for (const o of c.offers) { delete o.guardianKind; delete o.guardianWeakness; delete o.guardianAffixes; }
  return c;
}

/** 生成済みの最深階（main 枝） */
export function deepestGenerated(world: World): number {
  let d = 1;
  for (const f of Object.values(world.floors)) if (f.branch === 'main' && f.depth > d) d = f.depth;
  return d;
}

/**
 * 手負いで逃げている（種族の逃走の閾値を下回っている）。逃走中の敵は「追跡中」として extract・休息を妨げない。
 * 閾値は wounded / near_death などの HP 4 段階と同じ程度の公開情報。
 */
export function isFleeing(e: Entity): boolean {
  // 怯え（威圧。V3-4）は閾値に power を足す
  const at = (e.actor?.ai?.params.fleeBelowHpPct ?? 0) + ((e.statuses ?? []).find((s) => s.id === 'core:cowed')?.power ?? 0);
  if (at <= 0 || !e.stats) return false;
  return Math.trunc((e.stats.hp * 100) / Math.max(1, e.stats.maxHp)) < at;
}

/** 追跡中で、逃げてもいない（extract と休息を妨げる敵）。観測と engine の判定で同じものを使う */
export function isPursuing(e: Entity): boolean {
  return awarenessOf(e) === 'hunting' && !isFleeing(e);
}

/** プレイヤーから見た覚醒状態（観測と engine の判定で同じものを使う） */
export function awarenessOf(e: Entity): Awareness | undefined {
  const ai = e.actor?.ai;
  if (!ai) return undefined;
  if (e.statuses?.some((s) => s.id === 'core:sleep')) return 'asleep';
  if (ai.state === 'asleep') return 'asleep';
  if (ai.state === 'unaware') return 'unaware';
  return 'hunting';
}

/** 未鑑定なら kind を伏せて外見を返す */
export function maskKind(world: World, identified: readonly string[], kind: string): { kind: string | null; appearanceId: string | null } {
  const app = world.secret.appearances[kind];
  if (app === undefined) return { kind, appearanceId: null };
  if (identified.includes(kind)) return { kind, appearanceId: app };
  return { kind: null, appearanceId: app };
}

/**
 * 背の高い草（中にいる者を隠す地形。world.meta.concealTerrain）の中にいて、viewer の隣でない（V3-5 §5.2・V4-0c §4.2）。
 * 隠れるのは者（モンスター・プレイヤー）だけ。品や地物は隠れない
 */
export function inCover(world: World, floor: FloorKey, at: Pos, viewer: Pos | null | undefined): boolean {
  const f = world.floors[floor];
  const conceal = world.meta.concealTerrain;
  if (!f || !viewer || !conceal?.length || cheb(viewer, at) <= 1) return false;
  return conceal.includes(f.terrain[at.y * f.width + at.x]);
}

/**
 * その者が viewer から見えるか（V4-0c §4.2: 見えるかどうかの判定は 1 つ）。条件: at のマスが視界にあり（cellInView）、
 * かつ草の中でないか隣にいる。表示のリスト・記憶・出来事の伏せ方・敵の目・射線・fight と投擲の標的が、すべてこれを使う
 */
export function actorSeen(world: World, floor: FloorKey, at: Pos, viewer: Pos | null | undefined, cellInView: boolean): boolean {
  return cellInView && !inCover(world, floor, at, viewer);
}

/**
 * そのプレイヤーに、いま敵（モンスター）が 1 体でも見えているか（S7。SEASON.md §52.2 の 2: 遠征の途中の区切りは、敵が見えていない手番に出す）。
 * 見え方は projectPlayerView と同じ（今いる階で、視界のマスにいて、草の中なら隣だけ。判定は actorSeen 1 つ）
 */
export function monsterInView(world: World, playerId: PlayerId): boolean {
  const rec = world.players[playerId];
  const me = rec ? world.entities[rec.entityId] : undefined;
  const fk = me?.pos?.floor;
  const floor = fk ? world.floors[fk] : undefined;
  if (!rec || !me?.pos || !fk || !floor) return false;
  const visible = new Set(rec.knowledge.visible);
  for (const e of Object.values(world.entities)) {
    if (e.id === me.id || e.pos?.floor !== fk || entityCat(e) !== 'monster') continue;
    if (!visible.has(e.pos.y * floor.width + e.pos.x)) continue;
    if (actorSeen(world, fk, e.pos, me.pos, true)) return true;
  }
  return false;
}

export function entityCat(e: Entity): EntityView['cat'] | null {
  if (e.player) return 'player';
  if (e.actor) return 'monster';
  if (e.item) return 'item';
  if (e.trap) return 'trap';
  if (e.feature) return 'feature';
  return null;
}

export function projectPlayerView(world: World, playerId: PlayerId): PlayerView {
  const rec = world.players[playerId];
  if (!rec) throw new Error(`no such player ${playerId}`);
  const me = world.entities[rec.entityId];
  const k = rec.knowledge;
  const floorKey = me.pos?.floor ?? null;
  const floor = floorKey ? world.floors[floorKey] : null;

  const inventory: ItemView[] = [];
  const equippedBy: Record<string, EquipSlot> = {};
  for (const [slotName, id] of Object.entries(me.equip ?? {})) if (id) equippedBy[id] = slotName as EquipSlot;
  for (const id of me.inv?.items ?? []) {
    const it = world.entities[id];
    if (!it?.item) continue;
    const mk = maskKind(world, k.identified, it.kind);
    const iv: ItemView = {
      id, slot: it.item.slot ?? '?', kind: mk.kind, appearanceId: mk.appearanceId,
      qty: it.item.qty, affixes: [...it.item.affixes], equipped: equippedBy[id] ?? null,
    };
    if (it.item.value !== undefined) iv.value = it.item.value;
    if (it.item.inspected) iv.inspected = true;
    inventory.push(iv);
  }
  inventory.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));

  const visibleSet = new Set(k.visible);
  const shots = new Set(k.shots ?? []);
  const objectiveIds = objectiveEntityIds(world, playerId);
  const entities: EntityView[] = [];
  if (floor && floorKey) {
    const ordered: Entity[] = [];
    for (const e of Object.values(world.entities)) if (e.pos?.floor === floorKey) ordered.push(e);
    ordered.sort((a, b) => a.sid - b.sid);
    for (const e of ordered) {
      if (!e.pos || e.pos.floor !== floorKey || e.id === me.id) continue;
      if (!visibleSet.has(e.pos.y * floor.width + e.pos.x)) continue;
      const cat = entityCat(e);
      if (!cat) continue;
      // 背の高い草の中の者は、隣からしか見えない（V3-5 §5.2。判定は actorSeen 1 つ。V4-0c §4.2）
      if ((cat === 'monster' || cat === 'player') && !actorSeen(world, floorKey, e.pos, me.pos, true)) continue;
      if (cat === 'trap' && !e.trap!.revealedTo.includes(playerId)) continue;
      const pos = { x: e.pos.x, y: e.pos.y };
      if (cat === 'item') {
        const mk = maskKind(world, k.identified, e.kind);
        const iv: EntityView = { id: e.id, cat, kind: mk.kind, appearanceId: mk.appearanceId, pos, qty: e.item!.qty, affixes: [...e.item!.affixes] };
        if (e.role) iv.role = e.role;
        if (objectiveIds.has(e.id)) iv.objective = true;
        if (e.item!.thrownBy === playerId) iv.mine = true;
        if (e.item!.value !== undefined) iv.value = e.item!.value;
        entities.push(iv);
      } else if (cat === 'monster' || cat === 'player') {
        const v: EntityView = {
          id: e.id, cat, kind: e.kind, appearanceId: null, pos,
          hp: e.stats ? hpState(e.stats.hp, e.stats.maxHp) : undefined,
          statuses: (e.statuses ?? []).map((s) => s.id),
        };
        if (cat === 'monster') {
          v.awareness = awarenessOf(e);
          if (v.awareness === 'hunting' && isFleeing(e)) v.fleeing = true;
          if (e.scale) {
            v.affixes = [...e.scale.affixes];
            if (e.scale.tier > 0) v.tier = e.scale.tier;
          }
          if (e.role) v.role = e.role;
          if (objectiveIds.has(e.id)) v.objective = true;
          if (e.bounty) v.bounty = e.bounty;
          const ds = k.damageSeen?.[e.id];
          if (ds) v.damageSeen = ds;
          v.shot = shots.has(e.id);
          if (e.actor) v.speed = e.actor.speed;
          // 2 回動いたのを見てから過ぎた手番（V3-8 §53.4）
          const ps = k.paceSeen?.[e.id];
          const myTurns = me?.actor?.turns;
          if (ps !== undefined && myTurns !== undefined) v.paceAgo = Math.max(0, myTurns - ps);
          // 守護者の名前と型は公開。弱点は試して分かったものだけ（V3-3 §3.1）
          if (e.guardian) {
            // 大守護者の弱点は、記録庫の記憶からも分かる（V3-3a §35.7）
            const known = k.guardianIntel?.[e.id] ?? (e.guardian.warden && e.pos ? k.wardenIntel?.[String(world.floors[e.pos.floor]?.depth ?? 0)]?.weakness : undefined);
            const tried = k.guardianTried?.[e.id];
            v.guardian = { name: { ...e.guardian.name }, ...(e.guardian.title ? { title: { ...e.guardian.title } } : {}), types: [...e.guardian.types], ...(known ? { weakness: known } : {}), ...(e.guardian.warden ? { warden: true } : {}), ...(e.guardian.heavy ? { heavy: true } : {}), ...(!known && tried?.length ? { notWeak: [...tried] } : {}) };
          }
          // hold（構えた相手と手番の数。S1c）はプレイヤーに出さない（S1d §17.4）
          if (e.actor?.ai?.intent) { const { hold: _hold, ...intent } = e.actor.ai.intent; v.intent = intent; }
          // 持っている品（宝物庫の鍵。見れば分かる。V3-5 §5.1）
          if (e.carries) v.carries = e.carries;
          // 名前付きの強敵（V3-5 §5.4）
          if (e.named) v.named = { ...e.named };
          const met = k.metAt?.[e.id];
          if (met !== undefined) v.firstSeenSeq = met;
        } else {
          const pr = world.players[e.player!];
          v.playerId = e.player;
          v.name = pr?.name;
        }
        entities.push(v);
      } else {
        const fv: EntityView = { id: e.id, cat, kind: e.kind, appearanceId: null, pos, state: e.feature?.state };
        const lg = e.lairOf ? world.entities[e.lairOf]?.guardian : undefined;
        if (lg) fv.lair = { name: { ...lg.name }, ...(lg.title ? { title: { ...lg.title } } : {}) };
        if (e.campfire) fv.campfire = { by: e.campfire.by };
        entities.push(fv);
      }
    }
  }

  const fk = floorKey ? k.floors[floorKey] : undefined;
  const remembered: RememberedView[] = (fk?.remembered ?? []).map((r) => {
    const mk = r.cat === 'item' ? maskKind(world, k.identified, r.kind) : { kind: r.kind, appearanceId: null };
    const rv: RememberedView = { id: r.id, cat: r.cat, kind: mk.kind, appearanceId: mk.appearanceId, pos: { ...r.pos }, qty: r.qty, ft: r.ft, state: r.state };
    // 役割は見た時点で分かる不変の性質
    const we = world.entities[r.id];
    if (we?.role) rv.role = we.role;
    if (objectiveIds.has(r.id)) rv.objective = true;
    if (r.cat === 'item' && we?.item?.thrownBy === playerId && !we.item.heldBy) rv.mine = true;
    if (r.cat === 'item' && we?.item?.value !== undefined) rv.value = we.item.value;
    // 接辞は、見たときに覚えたもの（S3c §33.3 の 1。覚えている地図は見たときのまま。今の World からは取らない: 協力プレイで、仲間が拾った・呪いが見つかったことが、
    // 名前の変わり方から分かっていた）。種類が伏せられている品は、今までどおり出さない。接辞の無い古い記録は、名前だけ
    if (r.cat === 'item' && rv.kind && r.affixes?.length) rv.affixes = [...r.affixes];
    const lg = we?.lairOf ? world.entities[we.lairOf]?.guardian : undefined;
    if (lg) rv.lair = { name: { ...lg.name }, ...(lg.title ? { title: { ...lg.title } } : {}) };
    if (we?.campfire) rv.campfire = { by: we.campfire.by };
    return rv;
  });
  // 護りの火の手がかり（V3-3c §44.6）: 同じ守護者の火を見た（見えている・覚えている）なら、まだ見ていない灯っている火の方角と遠さ
  const wardHints: WardHint[] = [];
  if (floor && floorKey && me.pos) {
    const known = new Set<string>([...entities.filter((e) => e.cat === 'feature').map((e) => e.id), ...remembered.map((r) => r.id)]);
    const lairFeatures = Object.values(world.entities).filter((e) => e.pos?.floor === floorKey && e.feature && e.lairOf);
    const owners = new Set(lairFeatures.filter((e) => known.has(e.id)).map((e) => e.lairOf!));
    for (const e of lairFeatures.sort((a, b) => a.sid - b.sid)) {
      if (!owners.has(e.lairOf!) || known.has(e.id) || e.feature!.state !== 'lit') continue;
      const lg = world.entities[e.lairOf!]?.guardian;
      const d = compassDir(me.pos, e.pos!);
      if (!lg || !d) continue;
      wardHints.push({ guardian: { name: { ...lg.name }, ...(lg.title ? { title: { ...lg.title } } : {}) }, dir: d, range: cheb(me.pos, e.pos!) <= 10 ? 'near' : 'far' });
    }
  }

  let status: ViewStatus;
  if (world.status === 'ended') status = 'ended';
  else if (rec.state === 'at_camp') status = 'at_camp';
  else if (rec.state !== 'alive') status = 'dead';
  else if (floor && floor.currentActor === me.id) status = 'your_turn';
  else status = 'waiting_others';

  const latest = latestExpedition(world);
  let expedition: ExpeditionView | null = null;
  if (latest) {
    const held = latest.progress.relicHeldBy;
    expedition = {
      no: latest.no, objective: { ...latest.objective }, points: latest.points, relicGuarded: latest.relicGuarded,
      status: latest.status, endReason: latest.endReason,
      progress: { reached: latest.progress.reached, guardianSlain: latest.progress.guardianSlain, relicHeld: held !== null, relicHeldByYou: held === me.id, ...(latest.progress.vaultOpened ? { vaultOpened: true } : {}) },
      extracted: latest.extracted.some((x) => x.player === playerId),
      returns: latest.extracted.map((r) => ({ player: r.player, completed: r.completed, lifeline: !!r.lifeline })),
      result: latest.result ? structuredClone(latest.result) : null,
      startSeq: latest.startSeq, endSeq: latest.endSeq,
      slot: latest.slot ?? null, traits: [...(latest.traits ?? [])], multiplierPct: latest.multiplierPct ?? 100,
      haul: { ...(latest.haul ?? { bounty: 0, discovery: 0, kills: 0 }) }, maxDepth: latest.progress.maxDepth ?? 0, crossedDepth: latest.progress.crossedDepth ?? 0,
      ...(latest.guardianName ? { guardian: {
        rank: latest.guardianRank ?? 2, name: { ...latest.guardianName }, ...(latest.guardianTitle ? { title: { ...latest.guardianTitle } } : {}), types: [...(latest.guardianTypes ?? [])],
        ...(latest.targets.guardian && k.guardianIntel?.[latest.targets.guardian] ? { weakness: k.guardianIntel[latest.targets.guardian] } : {}),
      } } : {}),
      ...(latest.relic ? { relic: structuredClone(latest.relic) } : {}),
      ...(latest.milestone ? { milestone: structuredClone(latest.milestone) } : {}),
      ...(latest.story ? { story: { ...latest.story } } : {}),
    };
  }

  const party: PartyMemberView[] = world.playerOrder.map((pid) => {
    const p = world.players[pid];
    const pe = world.entities[p.entityId];
    const depth = pe?.pos ? world.floors[pe.pos.floor]?.depth ?? null : null;
    const hp = p.state === 'alive' && pe?.pos && pe.stats ? hpState(pe.stats.hp, pe.stats.maxHp) : null;
    const sameFloor = p.state === 'alive' && !!pe?.pos && !!floorKey && pe.pos.floor === floorKey;
    return { playerId: pid, entityId: p.entityId, name: p.name, classId: p.classId, controller: { ...p.controller }, state: p.state, depth, hp, lastAct: p.lastAct ?? 0, pos: sameFloor ? { x: pe!.pos!.x, y: pe!.pos!.y } : null };
  });

  return {
    runId: world.meta.runId,
    playerId,
    seq: world.seq,
    status,
    locale: rec.locale,
    terrainTable: world.meta.terrainTable,
    self: {
      id: me.id, kind: me.kind, name: rec.name, classId: rec.classId, controller: { ...rec.controller },
      pos: me.pos ? { x: me.pos.x, y: me.pos.y } : null,
      stats: { ...me.stats! }, speed: me.actor?.speed ?? 100,
      level: me.level?.level ?? 1, xp: me.level?.xp ?? 0,
      statuses: (me.statuses ?? []).map((s) => ({ ...s })),
      equip: { ...(me.equip ?? {}) },
      capacity: me.inv?.capacity ?? 0,
      turns: me.actor?.turns ?? 0,
      regen: me.actor?.regen ?? 0,
      build: me.build ? structuredClone(me.build) : { perks: [], pending: [], abilities: [] },
      boons: [...(me.boons ?? [])],
      boonUsed: { ...(me.boonUsed ?? {}) },
      ...(me.boonChoice ? { boonChoice: structuredClone(me.boonChoice) } : {}),
    },
    inventory,
    floor: floor ? {
      key: floor.key, depth: floor.depth, biome: floor.biome, floorType: floor.floorType, width: floor.width, height: floor.height,
      time: floor.time, noWander: floor.rules.noWander,
      ...(floor.genTraits?.length ? { traits: [...floor.genTraits] } : {}),
    } : null,
    visibleCells: [...k.visible],
    entities,
    memory: { terrain: fk ? [...fk.seen] : [], remembered, ...(fk?.mapped?.length ? { unsighted: [...fk.mapped] } : {}) },
    sense: k.sense ? { ...k.sense } : null,
    ...(wardHints.length ? { wardHints } : {}),
    ...(k.clues && Object.keys(k.clues).length ? { clues: structuredClone(k.clues) } : {}),
    ...(floor?.event ? { floorEvent: { ...floor.event.arrival } } : {}),
    floorHint: k.floorHint && k.floorHint.floor === floorKey ? { ...k.floorHint } : null,
    identified: [...k.identified],
    monsterMemory: structuredClone(k.monsterMemory),
    wardenIntel: structuredClone(k.wardenIntel ?? {}),
    archive: [...(k.archive ?? [])],
    notes: [...k.notes],
    party,
    turn: { current: floor?.currentActor ?? null, mine: status === 'your_turn' },
    runStatus: world.status,
    runMode: world.meta.mode,
    expedition,
    camp: !currentExpedition(world) && world.camp ? stripCamp(world.camp) : null,
    deepestDepth: deepestGenerated(world),
    campDepth: campDepthOf(world),
    milestonesCleared: [...(world.milestones?.cleared ?? [])],
    record: { banked: rec.stats.banked ?? 0, lost: rec.stats.lost ?? 0, expeditions: rec.stats.expeditions ?? 0 },
    ...(world.season ? { season: seasonView(world, playerId) } : {}),
  };
}

/** 観戦用: secret の seed と rng を除去した World（外見表は追従視点の再射影に必要なので残す） */
export function stripSecret(world: World): World {
  const w = structuredClone(world);
  w.secret = { seed: world.status === 'ended' ? world.secret.seed : '', rng: {}, appearances: { ...world.secret.appearances } };
  return w;
}

/** 次の XP 閾値（表示用。engine と同じ表を使う） */
export function xpForLevel(level: number): number {
  return 15 * level * level;
}

/**
 * PlayerView のシーズン（S0）。補給の置き場の品（S3）は、鑑定の決まりで種類を伏せ、場所を知っている置き場だけにする（projectSupplies）。
 * 討伐の記録（S6b）は、取り込みの決まった形（SeasonSlaySchema。サーバーの見せる分 slaysView と同じ）に通して、形に無い項目を落とす
 * （古い形の記録の始めの体力 wardenStart.hp などを渡さない）。形に合わない記録は渡さない。World の中身は変えない（射影の側だけ）
 */
function seasonView(world: World, playerId: PlayerId): NonNullable<PlayerView['season']> {
  const { supplies: _s, deposited: _d, taken: _t, mineTaken: _m, supplyNews: _n, depositsPublished: _p, slays, ...rest } = world.season!;
  const sup = projectSupplies(world, playerId);
  const has = !!(_s?.length || _d?.length || _t?.length || _n?.length);
  const shownSlays = slays?.flatMap((x): SeasonSlay[] => { const r = SeasonSlaySchema.safeParse(x); return r.success ? [r.data as SeasonSlay] : []; });
  return {
    ...clone(rest), ...(shownSlays ? { slays: shownSlays } : {}), budgetLeft: seasonBudgetLeft(world, playerId) ?? 0, ...seasonStairsCounts(world, playerId),
    ...(has ? { cache: sup.cache, cacheHidden: sup.hidden, supplyTaken: sup.taken, myDeposits: sup.mine, cacheNews: sup.news } : {}),
  };
}

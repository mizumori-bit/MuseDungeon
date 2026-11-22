// シーズン（S0。SEASON.md §2・PROTOCOL.md §9）の、World から読むだけの関数。engine・サーバー・観測が同じものを使う。
import type { Entity, Locale, PlayerId, SeasonAward, SeasonSpot, SeasonState, SeasonSupplyTaken, SupplyPlace, World } from './types';
import { floorKey } from './types';
import { t } from './util';

/** ランの中の予算の残り（取り込んだ残り − その後の自分の手番）。シーズンのランでなければ null */
export function seasonBudgetLeft(world: World, pid: PlayerId): number | null {
  const s = world.season;
  if (!s) return null;
  const pr = world.players[pid];
  const turns = pr ? world.entities[pr.entityId]?.actor?.turns ?? 0 : 0;
  return s.budget.left - Math.max(0, turns - s.budget.at);
}

/**
 * 報告できる下り階段（S0 §9.4）: このランで自分の目で見た（覚えている地図にあり、地図の巻物や公開で知っただけのマスでない）主の枝の下り階段のうち、
 * このランでまだ報告していないもの。深さの順
 */
export function seasonReportable(world: World, pid: PlayerId): { depth: number; x: number; y: number }[] {
  const s = world.season;
  const pr = world.players[pid];
  if (!s || !pr) return [];
  const done = new Set(s.reported);
  const out: { depth: number; x: number; y: number }[] = [];
  for (const [key, f] of Object.entries(world.floors)) {
    if (f.branch !== 'main' || done.has(f.depth)) continue;
    const fk = pr.knowledge.floors[key];
    if (!fk) continue;
    const mapped = new Set(fk.mapped ?? []);
    for (const d of f.stairs.down) {
      const i = d.y * f.width + d.x;
      if ((fk.seen[i] ?? 0) !== 0 && !mapped.has(i)) { out.push({ depth: f.depth, x: d.x, y: d.y }); break; }
    }
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/**
 * 報告できる特別な場所の種類（S1c §14.5）。泉は対象にしない（条件「静か」で、その遠征で初めて作る階から消える。だれの世界にもあるとは限らない）。
 * 祭壇は、部屋の作り（prefab。祠など）に組み込まれたものだけ（ばらまかれる祭壇は、条件の敵・品の数で場所が変わる）。賭けの祭壇と碑文は、どれも部屋の作りにある
 */
export const SEASON_SPOT_KINDS: readonly string[] = ['core:altar', 'core:gamble_altar', 'core:inscription'];
/** 節目の階（大守護者の間）の階の種類（コンテンツの floorTypes。節目の深さの階は、いつもこの種類） */
const MILESTONE_FLOOR_TYPE = 'core:warden_hall';

/** その地物が、報告できる特別な場所か（種類・部屋の作りの中・守護者の棲み処の地物でない） */
export function isSeasonSpot(world: World, e: Entity): boolean {
  if (!e.feature || !e.pos || e.lairOf || e.campfire || !SEASON_SPOT_KINDS.includes(e.kind)) return false;
  const f = world.floors[e.pos.floor];
  // 節目の階（大守護者の間。5 の倍数の深さ）は外す（S1d §17.4: 倒していない節目の階は作り直されることがある）
  if (!f || f.branch !== 'main' || f.floorType === MILESTONE_FLOOR_TYPE) return false;
  const { x, y } = e.pos;
  return f.regions.some((r) => r.kind === 'prefab' && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);
}

/**
 * 報告できる特別な場所（S1c §14.5）: このランで自分の目で見た（そのマスを見た。地図の巻物や公開で知っただけでない）もののうち、
 * このランでまだ報告していないもの。深さ・y・x の順
 */
export function seasonReportableSpots(world: World, pid: PlayerId): { depth: number; x: number; y: number; kind: string }[] {
  const s = world.season;
  const pr = world.players[pid];
  if (!s || !pr) return [];
  const done = s.reportedSpots ?? [];
  const out: { depth: number; x: number; y: number; kind: string }[] = [];
  for (const e of Object.values(world.entities)) {
    if (!isSeasonSpot(world, e)) continue;
    const f = world.floors[e.pos!.floor];
    const fk = pr.knowledge.floors[f.key];
    if (!fk) continue;
    const i = e.pos!.y * f.width + e.pos!.x;
    if ((fk.seen[i] ?? 0) === 0 || (fk.mapped ?? []).includes(i)) continue;
    if (done.some((d) => d.depth === f.depth && d.x === e.pos!.x && d.y === e.pos!.y)) continue;
    out.push({ depth: f.depth, x: e.pos!.x, y: e.pos!.y, kind: e.kind });
  }
  return out.sort((a, b) => a.depth - b.depth || a.y - b.y || a.x - b.x);
}

/** 公開された特別な場所（その深さと座標） */
export function publicSpotAt(state: SeasonState | null | undefined, depth: number, x: number, y: number): SeasonSpot | null {
  return state?.spots?.find((p) => p.depth === depth && p.x === x && p.y === y) ?? null;
}

/**
 * キャンプの「まだ報告していない階段 N（うち、まだだれも公開していないもの M）」の数。M は取り込んだ公開の一覧で数える。
 * 特別な場所（S1c §14.5）も同じ形で数える（spotsUnreported・spotsUnpublished）
 */
export function seasonStairsCounts(world: World, pid: PlayerId): { unreported: number; unpublished: number; spotsUnreported: number; spotsUnpublished: number } {
  const list = seasonReportable(world, pid);
  const pub = new Set((world.season?.public ?? []).map((p) => p.depth));
  const spots = seasonReportableSpots(world, pid);
  const spotPub = world.season?.spots ?? [];
  return {
    unreported: list.length, unpublished: list.filter((x) => !pub.has(x.depth)).length,
    spotsUnreported: spots.length, spotsUnpublished: spots.filter((x) => !spotPub.some((p) => p.depth === x.depth && p.x === x.x && p.y === x.y)).length,
  };
}

/** 公開された下り階段（その深さ） */
export function publicStairsAt(state: SeasonState | null | undefined, depth: number): SeasonState['public'][number] | null {
  return state?.public.find((p) => p.depth === depth) ?? null;
}

const AWARD_NAME: Record<SeasonAward['id'], [string, string]> = {
  adventure: ['冒険賞', 'Adventure award'], contribution: ['貢献賞', 'Contribution award'], survival: ['生還賞', 'Survival award'],
  support: ['支援賞', 'Support award'],
};

export function awardName(L: Locale, id: SeasonAward['id']): string {
  return t(L, AWARD_NAME[id][0], AWARD_NAME[id][1]);
}

/** 賞の値の文（冒険は「地下 N 階」、貢献は「N」、生還は「N 点」） */
export function awardValueText(L: Locale, id: SeasonAward['id'], v: number): string {
  if (id === 'adventure') return t(L, `地下${v}階`, `depth ${v}`);
  if (id === 'survival') return t(L, `${v} 点`, `${v} pts`);
  if (id === 'support') return t(L, `${v} 回`, `${v} uses`);
  return String(v);
}

/** 賞ごとの 1 行（自分の値と順位、1 位の名前と値、1 位との差。PROTOCOL §9.6） */
export function awardText(L: Locale, a: SeasonAward): string {
  const name = awardName(L, a.id);
  const lead = a.leader ? t(L, `1位 ${a.leader.name} ${awardValueText(L, a.id, a.leader.value)}`, `1st ${a.leader.name} ${awardValueText(L, a.id, a.leader.value)}`) : t(L, 'まだ記録が無い', 'no record yet');
  if (a.value === null || a.rank === null) {
    const why = a.id === 'survival' ? t(L, '倒れたので対象外', 'not eligible (you have fallen)') : t(L, '対象外', 'not eligible');
    return `${name}: ${why}・${lead}`;
  }
  const mine = t(L, `あなた ${awardValueText(L, a.id, a.value)}（${a.rank}位/${a.entrants}人）`, `you ${awardValueText(L, a.id, a.value)} (#${a.rank} of ${a.entrants})`);
  if (a.rank === 1) return `${name}: ${mine}`;
  const gap = a.gap !== null ? t(L, `（差 ${a.gap}）`, ` (behind by ${a.gap})`) : '';
  return `${name}: ${mine}・${lead}${gap}`;
}

/** 予算の 1 行（迷宮の中もキャンプも） */
export function seasonBudgetText(L: Locale, name: string, left: number, limit: number): string {
  return t(L, `シーズン「${name}」: 残りの予算 ${Math.max(0, left)}/${limit} 手番`, `Season "${name}": budget left ${Math.max(0, left)}/${limit} turns`);
}

/** 自分の野営の火（S1 §9.10）: 取り込んだ自分の火（使われた回数つき）と、このランで置いてまだ載っていない火 */
/** uses: 支援賞に数えた回数（まだ載っていない火は null）、dup: 同じマスの取り合いで、ほかの者の火が先に載った（自分の火として数える。S1a） */
export function myCampfires(state: SeasonState | null | undefined): { depth: number; x: number; y: number; uses: number | null; dup?: true }[] {
  if (!state) return [];
  const mine = (state.fires ?? []).filter((f) => f.mine);
  const out: { depth: number; x: number; y: number; uses: number | null; dup?: true }[] = mine.map((f) => ({ depth: f.depth, x: f.x, y: f.y, uses: f.dup ? null : f.uses ?? 0, ...(f.dup ? { dup: true as const } : {}) }));
  for (const p of state.placed ?? []) if (!mine.some((f) => f.depth === p.depth && f.x === p.x && f.y === p.y)) out.push({ ...p, uses: null });
  return out.sort((a, b) => a.depth - b.depth);
}

/** この遠征で火を使った階の深さ（S1 §8.3。1 回の遠征で、1 つの階につき 1 回） */
export function fireUsedDepths(state: SeasonState | null | undefined, expeditionNo: number | null): number[] {
  if (!state || expeditionNo === null) return [];
  return [...new Set((state.fireUses ?? []).filter((u) => u.no === expeditionNo).map((u) => u.depth))].sort((a, b) => a - b);
}

// ---- 補給の置き場（S3。SEASON.md §25.2・PROTOCOL §9.12） ----

/** 預けられる品の区分（消耗品だけ: 薬・巻物・投げる武器。毒薬も薬として預けられる）。装備・遺物・宝・鍵・帰還の綱・頁は預けられない */
export const SUPPLY_CATEGORIES: readonly string[] = ['potion', 'scroll', 'throwing'];

/** 置き場の品（その世界の今の中身）。mine: 自分が預けた品。local: このランで預けて、まだ共有層に載っていない品（id 'l<n>'） */
export interface CacheItem { id: string; depth: number; x: number; y: number; place: SupplyPlace; kind: string; identified: boolean; by: string; mine: boolean; local: boolean }

/**
 * その世界の置き場の中身（engine と観測が同じものを使う）: 取り込んだ共有層の品のうち、このランで取っていないもの ＋
 * このランで預けた品のうち、まだ共有層に載っていない（取り込みに同じ番号 n が無い）・取り返していないもの。共有層の品が先、預けた順
 */
export function cacheItems(s: SeasonState | null | undefined): CacheItem[] {
  if (!s) return [];
  const taken = new Set((s.taken ?? []).map((x) => x.id));
  const published = new Set([...(s.supplies ?? []).filter((x) => x.n !== undefined).map((x) => x.n!), ...(s.depositsPublished ?? [])]);
  const out: CacheItem[] = [];
  for (const x of s.supplies ?? []) {
    if (taken.has(x.id)) continue;
    out.push({ id: x.id, depth: x.depth, x: x.x, y: x.y, place: x.place, kind: x.kind, identified: x.identified, by: x.by, mine: !!x.mine, local: false });
  }
  for (const d of s.deposited ?? []) {
    const id = `l${d.n}`;
    if (published.has(d.n) || taken.has(id)) continue;
    out.push({ id, depth: d.depth, x: d.x, y: d.y, place: d.place, kind: d.kind, identified: d.identified, by: s.self ?? '', mine: true, local: true });
  }
  return out;
}

/** その置き場（深さと座標）の中身 */
export function cacheAt(s: SeasonState | null | undefined, depth: number, x: number, y: number): CacheItem[] {
  return cacheItems(s).filter((c) => c.depth === depth && c.x === x && c.y === y);
}

/** この遠征で、置き場から取ったか（1 回の遠征で 1 つまで） */
export function supplyTakenThis(s: SeasonState | null | undefined, expeditionNo: number | null): boolean {
  return expeditionNo !== null && (s?.taken ?? []).some((x) => x.no === expeditionNo);
}

/** PlayerView の置き場の品（S3）: 種類は、預けた者が鑑定済みか、見る者が鑑定済みのときだけ（ほかは外見だけ） */
export interface SupplyView { id: string; depth: number; x: number; y: number; place: SupplyPlace; kind: string | null; appearanceId: string | null; by: string; mine: boolean; local: boolean }
export interface SupplyTakenView { id: string; depth: number; x: number; y: number; place: SupplyPlace; kind: string | null; appearanceId: string | null; taker: string }

/**
 * PlayerView の補給の置き場（S3 §25.2）。cache: 見る者が場所を知っている置き場の中身（その階のそのマスの地形を知っている（見た・地図に載った）か、火を覚えている。
 * 下り階段をまだ知らない階の置き場は、場所が分かってしまうので出さず、hidden に深さごとの数だけ）。種類は鑑定の決まりで伏せる
 */
export function projectSupplies(world: World, pid: PlayerId): { cache: SupplyView[]; hidden: { depth: number; count: number }[]; taken: (SupplyView & { no: number })[]; mine: SupplyView[]; news: SupplyTakenView[] } {
  const s = world.season;
  const pr = world.players[pid];
  const empty = { cache: [], hidden: [], taken: [], mine: [], news: [] };
  if (!s || !pr) return empty;
  const known = new Set(pr.knowledge.identified);
  const mask = (kind: string, identified: boolean): { kind: string | null; appearanceId: string | null } => {
    const app = world.secret.appearances[kind];
    if (app === undefined) return { kind, appearanceId: null };
    return identified || known.has(kind) ? { kind, appearanceId: app } : { kind: null, appearanceId: app };
  };
  const view = (c: CacheItem): SupplyView => ({ id: c.id, depth: c.depth, x: c.x, y: c.y, place: c.place, ...mask(c.kind, c.identified), by: c.by, mine: c.mine, local: c.local });
  const knows = (c: { depth: number; x: number; y: number }) => {
    const key = floorKey('main', c.depth);
    const f = world.floors[key];
    const fk = pr.knowledge.floors[key];
    if (!f || !fk || c.x < 0 || c.y < 0 || c.x >= f.width || c.y >= f.height) return false;
    if ((fk.seen[c.y * f.width + c.x] ?? 0) !== 0) return true;
    return fk.remembered.some((r) => r.pos.x === c.x && r.pos.y === c.y && r.kind === 'core:camp_fire');
  };
  const all = cacheItems(s);
  const cache = all.filter(knows).map(view);
  const hiddenBy = new Map<number, number>();
  for (const c of all) if (!knows(c) && world.floors[floorKey('main', c.depth)]) hiddenBy.set(c.depth, (hiddenBy.get(c.depth) ?? 0) + 1);
  const taken = (s.taken ?? []).map((x) => ({ ...view({ ...x, mine: false, local: x.id.startsWith('l') }), no: x.no }));
  const mine = all.filter((c) => c.mine).map(view);
  const news = (s.supplyNews ?? []).map((x: SeasonSupplyTaken) => ({ id: x.id, depth: x.depth, x: x.x, y: x.y, place: x.place, ...mask(x.kind, x.identified), taker: x.taker }));
  return { cache, hidden: [...hiddenBy.entries()].sort((a, b) => a[0] - b[0]).map(([depth, count]) => ({ depth, count })), taken, mine, news };
}

/** 置き場の名前（「上り階段」「下り階段」「野営の火」） */
export function supplyPlaceName(L: Locale, p: SupplyPlace): string {
  return p === 'stairs_up' ? t(L, '上り階段', 'stairs up') : p === 'stairs_down' ? t(L, '下り階段', 'stairs down') : t(L, '野営の火', 'campfire');
}

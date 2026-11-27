// プロフィール（IMPROVEMENTS_V3 §7・§16.3。V3-7）: ランをまたぐ記録・図鑑・継承・実績。
// プロフィールは World の外にあり、サーバーが profiles/<id>.json に持つ。ここは純粋な計算だけを置く
// （記録の集計・図鑑の完成度・継承する知識・実績の条件）。AI（MCP の records）と人間（画面）に同じものを出す。
import type { LegacyMonster } from './commands';
import type { ExpeditionReport } from './expeditionStats';
import type { ProjectedEvent } from './filter';
import type { DirectiveItem, Locale, Names } from './types';
import type { OwnerPace } from './directive';
import { t } from './util';

// ---------------- 図鑑 ----------------

export interface CodexSpecies {
  /** 遭遇した個体の数・倒した数（守護者を含む） */
  met: number;
  kills: number;
  abilities: string[];
  hpSeen?: { min: number; max: number; samples: number };
  /** その種族から一撃で受けた最大のダメージ */
  maxHit?: number;
  rangeMax?: number;
}

/** 1 ランで分かったこと（そのプレイヤー本人の知識と出来事だけから作る） */
export interface CodexRun {
  species: Record<string, CodexSpecies>;
  /** 鑑定した品の種類（未鑑定の見た目がある種類だけ） */
  items: string[];
  /** 記録庫に納めた遺物 */
  relics: string[];
  guardianTypes: string[];
  weaknesses: string[];
  /** 読んだ断章（碑文・書き置き）の ID */
  fragments: string[];
  /** 見つけた特殊部屋（prefab の ID） */
  rooms: string[];
}

export function emptyCodex(): CodexRun {
  return { species: {}, items: [], relics: [], guardianTypes: [], weaknesses: [], fragments: [], rooms: [] };
}

const uniq = (xs: readonly string[]) => [...new Set(xs)].sort();

/** 図鑑を重ねる（集合は和、数は和、体力の記録は範囲の和、最大の一撃は最大） */
export function mergeCodex(list: readonly CodexRun[]): CodexRun {
  const out = emptyCodex();
  for (const c of list) {
    for (const [kind, s] of Object.entries(c.species)) {
      const cur = out.species[kind];
      if (!cur) { out.species[kind] = { ...s, abilities: [...s.abilities], ...(s.hpSeen ? { hpSeen: { ...s.hpSeen } } : {}) }; continue; }
      cur.met += s.met;
      cur.kills += s.kills;
      cur.abilities = uniq([...cur.abilities, ...s.abilities]);
      if (s.hpSeen) cur.hpSeen = cur.hpSeen ? { min: Math.min(cur.hpSeen.min, s.hpSeen.min), max: Math.max(cur.hpSeen.max, s.hpSeen.max), samples: cur.hpSeen.samples + s.hpSeen.samples } : { ...s.hpSeen };
      if (s.maxHit !== undefined) cur.maxHit = Math.max(cur.maxHit ?? 0, s.maxHit);
      if (s.rangeMax !== undefined) cur.rangeMax = Math.max(cur.rangeMax ?? 0, s.rangeMax);
    }
    out.items = uniq([...out.items, ...c.items]);
    out.relics = uniq([...out.relics, ...c.relics]);
    out.guardianTypes = uniq([...out.guardianTypes, ...c.guardianTypes]);
    out.weaknesses = uniq([...out.weaknesses, ...c.weaknesses]);
    out.fragments = uniq([...out.fragments, ...c.fragments]);
    out.rooms = uniq([...out.rooms, ...c.rooms]);
  }
  return out;
}

export interface CodexEntry { id: string; name: Names }
/** 図鑑の項目の一覧（コンテンツから。サーバーが作る）。guardians は型と弱点の両方 */
export interface CodexIndex {
  species: CodexEntry[];
  items: CodexEntry[];
  relics: CodexEntry[];
  guardians: CodexEntry[];
  fragments: CodexEntry[];
  rooms: CodexEntry[];
}
export type CodexCategory = keyof CodexIndex;
export const CODEX_CATEGORIES: readonly CodexCategory[] = ['species', 'items', 'relics', 'guardians', 'fragments', 'rooms'];
const CATEGORY_NAMES: Record<CodexCategory, Names> = {
  species: { ja: '種族', en: 'Species' },
  items: { ja: '品（鑑定）', en: 'Items (identified)' },
  relics: { ja: '遺物（納めた）', en: 'Relics (delivered)' },
  guardians: { ja: '守護者の型と弱点', en: 'Guardian types and weaknesses' },
  fragments: { ja: '断章', en: 'Fragments' },
  rooms: { ja: '特殊部屋', en: 'Special rooms' },
};

/** 図鑑の各分類で見つけた項目（index の順） */
function codexFound(c: CodexRun, idx: CodexIndex): Record<CodexCategory, CodexEntry[]> {
  const has = (list: readonly string[]) => { const s = new Set(list); return (e: CodexEntry) => s.has(e.id); };
  return {
    species: idx.species.filter((e) => (c.species[e.id]?.met ?? 0) > 0),
    items: idx.items.filter(has(c.items)),
    relics: idx.relics.filter(has(c.relics)),
    guardians: idx.guardians.filter(has([...c.guardianTypes, ...c.weaknesses])),
    fragments: idx.fragments.filter(has(c.fragments)),
    rooms: idx.rooms.filter(has(c.rooms)),
  };
}

export function codexCount(c: CodexRun, idx: CodexIndex): { found: number; total: number } {
  const f = codexFound(c, idx);
  return { found: CODEX_CATEGORIES.reduce((a, k) => a + f[k].length, 0), total: CODEX_CATEGORIES.reduce((a, k) => a + idx[k].length, 0) };
}

// ---------------- プロフィールの中身 ----------------

/** 遠征 1 回の自己最高（目標の宣言の比べる相手。V3-7a §40.8） */
export interface ProfileBest { depth: number | null; banked: number | null; margin: number | null }

/** プロフィールに積むラン 1 本の記録（進行中のランは遠征が終わるたびに書き直す） */
export interface ProfileRun {
  runId: string;
  character: string;
  classId: string;
  /** シーズンのラン（S0）。継承に使わない（SEASON.md §2.1: 継承は受けないし、残さない） */
  season?: string;
  /** 継承したか（記録の表を分ける。§7.3） */
  legacy: boolean;
  legacyKinds: number;
  startedAt: number;
  endedAt: number | null;
  status: 'active' | 'ended';
  end: 'died' | 'retired' | null;
  deathCause: string | null;
  level: number;
  /** 確定点の合計（スコア版 2） */
  banked: number;
  deepest: number;
  /** 遠征の数（終わったもの）・達成・撤退 */
  expeditions: number;
  completed: number;
  withdrawn: number;
  /** 倒した節目の大守護者の深さ */
  wardens: number[];
  /** 続けて達成した遠征の最長 */
  streakMax: number;
  best: ProfileBest;
  codex: CodexRun;
}

export interface FeatRecord { id: string; runId: string; no: number | null; wall: number }

export interface ProfileData {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  runs: ProfileRun[];
  feats: FeatRecord[];
  /**
   * 持ち主が握る項目（S9。SEASON.md §58.3）: 持ち主が set_directive で握る項目を変えるたびに、サーバーが控える（伝言は控えない）。
   * このプロフィールの新しいランは、作った直後に、これを持ち主の口の命令として入れる。握っていなければ無い
   */
  hold?: DirectiveItem[];
  /**
   * 進め方の希望（S14。SEASON.md §65.4 の 2）: 持ち主の口（…/owner/pace）で、キャンプでだけ変わる。無ければ self（自分で考えて進む）。
   * 握る項目ではない。World に入れない（決まりに効かない）。このプロフィールの新しいランにも、そのまま効く
   */
  pace?: OwnerPace;
  /**
   * 進め方の希望を、最後に AI に伝えたのは、どちらか（S18。SEASON.md §73.2 の 5）: pilot の 1 行を AI 本人の応答に出したら pilot、
   * 取り下げの 1 行（1 回だけ）を出したら self。無ければ「まだ、何も伝えていない」（取り下げの知らせは出さない。古いプロフィールも同じ）。
   * World・出来事には入れない
   */
  paceTold?: OwnerPace;
}

// ---------------- 継承（§7.3） ----------------

/** 図鑑で minKills 以上倒した種族の知識（能力・体力の記録・最大の一撃・射程）。守護者・外見・弱点・地図は入れない */
export function legacyFrom(runs: readonly ProfileRun[], minKills: number): LegacyMonster[] {
  const c = mergeCodex(runs.map((r) => r.codex));
  const out: LegacyMonster[] = [];
  for (const kind of Object.keys(c.species).sort()) {
    const s = c.species[kind];
    if (s.kills < minKills) continue;
    out.push({ kind, kills: s.kills, abilities: [...s.abilities], ...(s.hpSeen ? { hpSeen: { ...s.hpSeen } } : {}), ...(s.maxHit ? { maxHit: s.maxHit } : {}), ...(s.rangeMax ? { rangeMax: s.rangeMax } : {}) });
  }
  return out;
}

// ---------------- 実績の条件（§7.4） ----------------

export type FeatOp = '==' | '!=' | '>=' | '<=' | '>' | '<';
export type FeatCond = { all: FeatCond[] } | { any: FeatCond[] } | { path: string; op: FeatOp; value: number | string | boolean };

/** 実績の判定に渡す値（遠征レポートと要約の値。表示用の文は使わない） */
export interface FeatContext {
  /** この遠征のレポート（ランの終わりの判定では最後の遠征。無ければ null） */
  report: ExpeditionReport | null;
  expedition: { slot: string | null; trait_danger: number; rechallenge: boolean; objective: string; guardian_slain: boolean; warden_slain: boolean; floors_unhurt: number } | null;
  run: { ended: boolean; end: string | null; expeditions: number; completed: number; withdrawn: number; lifeline: number; streak: number; banked: number; deepest: number; level: number; kills: number; legacy: boolean };
  profile: { runs: number; same_death_max: number; codex_found: number; codex_total: number; codex_pct: number; species_met: number; species_total: number; species_left: number; wardens: number };
}

function pathValue(ctx: unknown, path: string): unknown {
  let cur: unknown = ctx;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

export function evalFeatCond(c: FeatCond, ctx: FeatContext): boolean {
  if ('all' in c) return c.all.every((x) => evalFeatCond(x, ctx));
  if ('any' in c) return c.any.some((x) => evalFeatCond(x, ctx));
  const v = pathValue(ctx, c.path);
  if (v === undefined || v === null) return false;
  switch (c.op) {
    case '==': return v === c.value;
    case '!=': return v !== c.value;
    case '>=': return typeof v === 'number' && typeof c.value === 'number' && v >= c.value;
    case '<=': return typeof v === 'number' && typeof c.value === 'number' && v <= c.value;
    case '>': return typeof v === 'number' && typeof c.value === 'number' && v > c.value;
    case '<': return typeof v === 'number' && typeof c.value === 'number' && v < c.value;
  }
}

/** 無傷で抜けた階の数（その階に着いてから下り階段で離れるまで、HP が減らなかった）。遠征の出来事から */
export function floorsUnhurt(events: readonly ProjectedEvent[], selfId: string): number {
  let hurt = false;
  let n = 0;
  for (const e of events) {
    if (e.type === 'damaged' && e.target === selfId && ((e.dealt as number | undefined) ?? (e.amount as number)) > 0) hurt = true;
    if (e.type === 'entity_changed_floor' && e.id === selfId) {
      if (e.dir === 'down' && !hurt) n++;
      hurt = false;
    }
  }
  return n;
}

/** 実績の定義（コンテンツの feats.json の形。表示に要る分だけ） */
export interface FeatDefLite { id: string; name: Names; desc: Names; hidden: boolean }

// ---------------- 記録（records。§7.2） ----------------

export interface RecordsRunLine { run_id: string; character: string; class_id: string; legacy: boolean; status: 'active' | 'ended'; end: string | null; death_cause: string | null; banked: number; deepest: number; completed: number; level: number }

export interface ProfileRecords {
  profile: { id: string; name: string };
  runs: { total: number; ended: number; with_legacy: number; without_legacy: number };
  /** 確定点（ランの合計）の最高・平均。終わったランから。継承の有無で表を分ける */
  banked: { best: number; avg: number; legacy: { best: number; avg: number; runs: number }; fresh: { best: number; avg: number; runs: number } };
  deepest: number;
  completed: number;
  wardens: number[];
  /** 死因の内訳（上位 5） */
  deaths: { cause: string; name: string; count: number }[];
  /** 直近 5 ラン（新しい順） */
  recent: RecordsRunLine[];
  codex: { found: number; total: number; categories: { id: CodexCategory; name: string; found: number; total: number; entries: { id: string; name: string; detail?: string }[] }[] };
  feats: { earned: number; total: number; list: { id: string; name: string; desc: string | null; earned: boolean }[] };
  /** 次の節目（未踏破の大守護者・図鑑・実績） */
  next: { warden: number | null; codex: string; feats: string };
  /** 遠征の自己最高（目標の宣言の比べる相手） */
  best: ProfileBest;
}

export interface RecordsOptions {
  milestone: { every: number; min: number } | null;
  /** 種族・死因の表示名 */
  kindName: (kind: string) => string;
  /** 能力の表示名 */
  abilityName?: (a: string) => string;
}

const avg = (xs: readonly number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const maxOr0 = (xs: readonly number[]) => (xs.length ? Math.max(...xs) : 0);

/** 1 ランの遠征レポートから、遠征 1 回の自己最高（深さ・確定点・達成した遠征の「最も下がった HP」の最大） */
export function expeditionBest(reports: readonly ExpeditionReport[]): ProfileBest {
  const ended = reports.filter((r) => r.status === 'ended');
  const banked = ended.map((r) => r.payout?.banked ?? 0);
  const margin = ended.filter((r) => r.reason === 'completed').map((r) => r.combat.min_hp_pct ?? 0);
  return {
    depth: ended.length ? Math.max(...ended.map((r) => r.tempo.deepest)) : null,
    banked: banked.length && Math.max(...banked) > 0 ? Math.max(...banked) : null,
    margin: margin.length ? Math.max(...margin) : null,
  };
}

/** プロフィールの自己最高（進行中のランも含む。遠征 1 回の値） */
export function profileBest(runs: readonly ProfileRun[], exceptRun?: string): ProfileBest {
  const rs = runs.filter((r) => r.runId !== exceptRun);
  const pick = (k: keyof ProfileBest) => { const v = rs.map((r) => r.best[k]).filter((x): x is number => x !== null && x > 0); return v.length ? Math.max(...v) : null; };
  return { depth: pick('depth'), banked: pick('banked'), margin: pick('margin') };
}

/** 次の節目の大守護者（どのランでも倒していない最も浅いもの） */
export function nextWarden(runs: readonly ProfileRun[], ms: { every: number; min: number } | null): number | null {
  if (!ms) return null;
  const cleared = new Set(runs.flatMap((r) => r.wardens));
  for (let d = Math.ceil(ms.min / ms.every) * ms.every; d < 1000; d += ms.every) if (!cleared.has(d)) return d;
  return null;
}

export function buildRecords(L: Locale, data: ProfileData, idx: CodexIndex, feats: readonly FeatDefLite[], opts: RecordsOptions): ProfileRecords {
  const runs = data.runs;
  const ended = runs.filter((r) => r.status === 'ended');
  const group = (rs: readonly ProfileRun[]) => ({ best: maxOr0(rs.map((r) => r.banked)), avg: avg(rs.map((r) => r.banked)), runs: rs.length });
  const deathCount = new Map<string, number>();
  for (const r of ended) if (r.end === 'died' && r.deathCause) deathCount.set(r.deathCause, (deathCount.get(r.deathCause) ?? 0) + 1);
  const deaths = [...deathCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5).map(([cause, count]) => ({ cause, name: opts.kindName(cause), count }));
  const codex = mergeCodex(runs.map((r) => r.codex));
  const found = codexFound(codex, idx);
  const nm = (n: Names) => (L === 'en' ? n.en : n.ja);
  const categories = CODEX_CATEGORIES.map((id) => ({
    id, name: nm(CATEGORY_NAMES[id]), found: found[id].length, total: idx[id].length,
    entries: found[id].map((e) => {
      if (id !== 'species') return { id: e.id, name: nm(e.name) };
      const s = codex.species[e.id];
      const parts = [t(L, `遭遇 ${s.met}・撃破 ${s.kills}`, `met ${s.met}, slain ${s.kills}`)];
      if (s.hpSeen) parts.push(t(L, `体力 ${s.hpSeen.min === s.hpSeen.max ? s.hpSeen.min : `${s.hpSeen.min}〜${s.hpSeen.max}`}`, `HP ${s.hpSeen.min === s.hpSeen.max ? s.hpSeen.min : `${s.hpSeen.min}-${s.hpSeen.max}`}`));
      if (s.maxHit) parts.push(t(L, `最大の一撃 ${s.maxHit}`, `worst hit ${s.maxHit}`));
      // 速い個体（接辞）と遅い種族が並ぶときは 1 つにまとめる（V3-7 の評価: 「速い・遅い」）
      const both = s.abilities.includes('fast') && s.abilities.includes('slow');
      const abs = both ? s.abilities.filter((a) => a !== 'fast' && a !== 'slow') : s.abilities;
      const abText = [...(both ? [t(L, '速さは個体で違う', 'speed varies')] : []), ...abs.map((a) => opts.abilityName?.(a) ?? a)];
      if (abText.length) parts.push(abText.join('・'));
      return { id: e.id, name: nm(e.name), detail: parts.join(t(L, '・', ', ')) };
    }),
  }));
  const cc = codexCount(codex, idx);
  const earned = new Set(data.feats.map((f) => f.id));
  const featList = feats.map((f) => ({ id: f.id, name: nm(f.name), desc: earned.has(f.id) || !f.hidden ? nm(f.desc) : null, earned: earned.has(f.id) }));
  const featEarned = featList.filter((f) => f.earned).length;
  const recent = [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 5).map((r): RecordsRunLine => ({
    run_id: r.runId, character: r.character, class_id: r.classId, legacy: r.legacy, status: r.status, end: r.end, death_cause: r.deathCause,
    banked: r.banked, deepest: r.deepest, completed: r.completed, level: r.level,
  }));
  return {
    profile: { id: data.id, name: data.name },
    runs: { total: runs.length, ended: ended.length, with_legacy: runs.filter((r) => r.legacy).length, without_legacy: runs.filter((r) => !r.legacy).length },
    banked: { best: maxOr0(ended.map((r) => r.banked)), avg: avg(ended.map((r) => r.banked)), legacy: group(ended.filter((r) => r.legacy)), fresh: group(ended.filter((r) => !r.legacy)) },
    deepest: maxOr0(runs.map((r) => r.deepest)),
    completed: runs.reduce((a, r) => a + r.completed, 0),
    wardens: uniq(runs.flatMap((r) => r.wardens.map(String))).map(Number).sort((a, b) => a - b),
    deaths,
    recent,
    codex: { found: cc.found, total: cc.total, categories },
    feats: { earned: featEarned, total: featList.length, list: featList },
    next: { warden: nextWarden(runs, opts.milestone), codex: `${cc.found}/${cc.total}`, feats: `${featEarned}/${featList.length}` },
    best: profileBest(runs),
  };
}

/** 「次の節目: 地下5階の大守護者（未踏破）／図鑑 32/61／実績 7/30」 */
export function nextMilestonesLine(L: Locale, r: ProfileRecords): string {
  const w = r.next.warden !== null ? t(L, `地下${r.next.warden}階の大守護者（未踏破）／`, `the depth-${r.next.warden} warden (never slain) / `) : '';
  return t(L, `次の節目: ${w}図鑑 ${r.next.codex}／実績 ${r.next.feats}`, `Next milestones: ${w}codex ${r.next.codex} / feats ${r.next.feats}`);
}

/** キャンプの観測に出す 1 行（記録の要約） */
export function recordsCampLine(L: Locale, r: ProfileRecords): string {
  const head = r.runs.ended
    ? t(L, `記録: ラン ${r.runs.total}（終了 ${r.runs.ended}）・確定の最高 ${r.banked.best}・最深 地下${r.deepest}階`, `Records: ${r.runs.total} runs (${r.runs.ended} ended), best banked ${r.banked.best}, deepest ${r.deepest}`)
    : r.runs.total > 1 ? t(L, `記録: ラン ${r.runs.total}（終了 0）`, `Records: ${r.runs.total} runs (none ended)`) : t(L, `記録: 最初のラン`, `Records: first run`);
  return `${head}。${nextMilestonesLine(L, r)}`;
}

const END_JA: Record<string, string> = { died: '死亡', retired: '引退' };

/** records の文（AI にも人間にも同じ） */
export function recordsLines(L: Locale, r: ProfileRecords, opts: { kindName: (k: string) => string; className?: (k: string) => string }): string[] {
  const out: string[] = [];
  out.push(t(L, `プロフィール: ${r.profile.name}（${r.profile.id}）`, `Profile: ${r.profile.name} (${r.profile.id})`));
  out.push(t(L, `ラン ${r.runs.total}（終了 ${r.runs.ended}・継承あり ${r.runs.with_legacy}・なし ${r.runs.without_legacy}）・達成した遠征 ${r.completed}・最深 地下${r.deepest}階`,
    `${r.runs.total} runs (${r.runs.ended} ended; ${r.runs.with_legacy} with legacy, ${r.runs.without_legacy} without), ${r.completed} expeditions completed, deepest ${r.deepest}`));
  out.push(t(L, `確定点（ランの合計）: 最高 ${r.banked.best}・平均 ${r.banked.avg}（継承あり 最高 ${r.banked.legacy.best}・平均 ${r.banked.legacy.avg}／継承なし 最高 ${r.banked.fresh.best}・平均 ${r.banked.fresh.avg}）`,
    `Banked (run total): best ${r.banked.best}, average ${r.banked.avg} (with legacy best ${r.banked.legacy.best} avg ${r.banked.legacy.avg} / without best ${r.banked.fresh.best} avg ${r.banked.fresh.avg})`));
  const b = r.best;
  out.push(t(L, `遠征 1 回の自己最高: 最深 ${b.depth ?? '—'}・確定 ${b.banked ?? '—'}・余力 ${b.margin === null ? '—' : `${b.margin}%`}`, `Best single expedition: depth ${b.depth ?? '-'}, banked ${b.banked ?? '-'}, margin ${b.margin === null ? '-' : `${b.margin}%`}`));
  out.push(t(L, `倒した大守護者: ${r.wardens.length ? r.wardens.map((d) => `地下${d}階`).join('・') : 'なし'}`, `Wardens slain: ${r.wardens.length ? r.wardens.map((d) => `depth ${d}`).join(', ') : 'none'}`));
  if (r.deaths.length) out.push(t(L, `死因: ${r.deaths.map((d) => `${d.name} ${d.count}`).join('・')}`, `Deaths: ${r.deaths.map((d) => `${d.name} ${d.count}`).join(', ')}`));
  if (r.recent.length) {
    out.push(t(L, '直近のラン:', 'Recent runs:'));
    for (const x of r.recent) {
      const end = x.status === 'active' ? t(L, '進行中', 'in progress') : x.end === 'died' ? t(L, `死亡（${x.death_cause ? opts.kindName(x.death_cause) : '—'}）`, `died (${x.death_cause ? opts.kindName(x.death_cause) : '-'})`) : t(L, END_JA[x.end ?? ''] ?? (x.end ?? ''), x.end ?? '');
      out.push(t(L, `- ${x.run_id} ${x.character}（${opts.className?.(x.class_id) ?? x.class_id}・Lv${x.level}${x.legacy ? '・継承あり' : ''}）: 確定 ${x.banked}・最深 地下${x.deepest}階・達成 ${x.completed}・${end}`,
        `- ${x.run_id} ${x.character} (${opts.className?.(x.class_id) ?? x.class_id}, Lv${x.level}${x.legacy ? ', legacy' : ''}): banked ${x.banked}, deepest ${x.deepest}, completed ${x.completed}, ${end}`));
    }
  }
  out.push(t(L, `図鑑 ${r.codex.found}/${r.codex.total}`, `Codex ${r.codex.found}/${r.codex.total}`));
  for (const c of r.codex.categories) {
    const names = c.entries.map((e) => (e.detail ? `${e.name}（${e.detail}）` : e.name));
    out.push(`- ${c.name} ${c.found}/${c.total}${names.length ? t(L, `: ${names.join('、')}`, `: ${names.join('; ')}`) : ''}`);
  }
  out.push(t(L, `実績 ${r.feats.earned}/${r.feats.total}`, `Feats ${r.feats.earned}/${r.feats.total}`));
  // 取った実績を先に
  for (const f of [...r.feats.list.filter((x) => x.earned), ...r.feats.list.filter((x) => !x.earned)]) out.push(`- ${f.earned ? '★' : '☆'} ${f.name}${f.desc ? t(L, `: ${f.desc}`, `: ${f.desc}`) : t(L, '（条件は取るまで伏せる）', ' (condition hidden until earned)')}`);
  out.push(nextMilestonesLine(L, r));
  return out;
}

// 遠征レポート（IMPROVEMENTS_V3 §6・§35.9）: 助言はせず、自分のプレイを事実で振り返る材料を出す。
// 集計はルールを含まない。入力はそのプレイヤーが知覚した出来事（filterEventsForPlayer を通したもの）と、
// 自分の手番の記録（自分の actor_scheduled）と、自分が送ったコマンドの記録だけ。見ていないものは数えない。
import type { Catalog } from './catalog';
import { nameOf } from './catalog';
import type { GameEvent } from './events';
import { partsText, multText } from './expedition';
import type { ProjectedEvent } from './filter';
import { kindName } from './narrate';
import type { ExpeditionEndReason, HaulParts, Locale, Names } from './types';
import { t } from './util';

export type MomentKind = 'hp_min' | 'big_hit_taken' | 'near_death_escape' | 'guardian_fight' | 'warden_fight' | 'level_up' | 'discovery';
export interface ReportMoment { seq: number; turn_no: number; kind: MomentKind; text: string }

/** 自分が送ったコマンド 1 件（call: 基本行動、macro_call: マクロの呼び出し、macro_step: マクロが展開した 1 手） */
export interface ReportCall { seq: number; kind: 'call' | 'macro_call' | 'macro_step'; type: string; macro?: string }

export interface ReportCompare {
  /** 直前の遠征との差（この遠征 − 直前） */
  vs_previous?: { no: number; banked: number; taken: number; turns: number; kills: number; tool_calls: number };
  /** このランの中での自己最高（事実の列挙） */
  personal_best?: string[];
}

export interface ExpeditionReport {
  no: number;
  objective: { type: string; target_depth: number | null };
  status: 'in_progress' | 'ended';
  reason: ExpeditionEndReason | null;
  payout?: { parts: HaulParts; multiplier_pct: number; banked: number; lost: number };
  compare?: ReportCompare;
  /** min_hp_pct: この遠征で最も下がった HP（最大 HP に対する %。目標の「余力」。V3-7a） */
  /** guardian_fights: 守護者ごとの戦い（与えた・受けた・結末。再挑戦の候補の「前回は与 3・被 22」に使う。V3-3c §44.1） */
  combat: { dealt: number; taken: number; hits: number; misses: number; crits: number; kills: number; melee_kills: number; thrown_kills: number; ability_uses: number; min_hp_pct?: number;
    guardian_fights?: { id: string; dealt: number; taken: number; outcome: 'slain' | 'slain_by_other' | 'left' | 'died' | 'ongoing' }[];
    /** bounty_fights: 目的の賞金首との戦い（与えた・受けた。再挑戦の候補の「前回は与 N・被 M」に使う。V3-8 §53.3） */
    bounty_fights?: { id: string; dealt: number; taken: number }[] };
  /** potions_detail: 飲んだ薬の内訳（「回復の薬 2・加速の薬 1」。V3-3c §44.6） */
  economy: { potions_used: number; scrolls_read: number; items_left_unidentified: number; treasure_banked: number; potions_detail?: string };
  tempo: { turns: number; turns_resting: number; floors: number; turns_per_floor: number; deepest: number; tool_calls: number; macro_share_pct: number };
  /** 場面（最大 8 件、seq 順。seq でリプレイのその場面へ飛べる） */
  moments: ReportMoment[];
  /** 死亡したとき: 倒した相手、直前 10 件の出来事、直近 20 手番の HP */
  death?: { killer: string | null; via: string; self_inflicted?: boolean; last_events: string[]; hp_trace: number[] };
}

export interface ReportInput {
  locale: Locale;
  catalog: Catalog;
  selfId: string;
  no: number;
  /** この遠征の間（expedition_started から expedition_ended まで）に知覚した出来事 */
  events: readonly ProjectedEvent[];
  /** 自分の手番の記録 [seq, その時点の手番数]（selfTurnMarks） */
  marks: readonly (readonly [number, number])[];
  /** この遠征の間に送ったコマンド */
  calls: readonly ReportCall[];
  /** 遠征の前から正体を知っていた見た目（未鑑定のまま、の数から除く） */
  knownAppearances?: ReadonlySet<string>;
  /** 節目の階（大守護者の判定。rules.milestone） */
  milestone?: { every: number; min: number };
  /** 出来事の文（死亡の直前 10 件に使う） */
  narrate?: (e: ProjectedEvent) => string;
  /** 公開されている守護者の名前（表示用）: 節目の階の大守護者、この遠征の目的の守護者 */
  guardianNames?: { warden?: Record<number, string>; objective?: string };
  /** この遠征の目的の賞金首（与えた・受けたを数える。V3-8 §53.3） */
  bountyIds?: readonly string[];
}

/** 自分の手番の記録（自分の actor_scheduled の after 値だけを読む） */
export function selfTurnMarks(events: readonly GameEvent[], selfId: string): [number, number][] {
  const out: [number, number][] = [];
  for (const e of events) if (e.type === 'actor_scheduled' && e.id === selfId) out.push([e.seq, e.turns]);
  return out;
}

const VIA_JA: Record<string, string> = { melee: '近接', ranged: '射撃', thrown: '投擲', poison: '毒', trap: '罠', effect: '効果', other: 'その他' };
const viaText = (L: Locale, via: string) => (L === 'en' ? via : VIA_JA[via] ?? via);
const REASON_JA: Record<string, string> = { completed: '帰還・達成', withdrawn: '撤退', lifeline: '帰還の綱', died: '死亡', retired: '引退' };
const reasonText = (L: Locale, r: string | null) => (r === null ? t(L, '進行中', 'in progress') : L === 'en' ? r : REASON_JA[r] ?? r);
const depthOf = (key: unknown): number | null => {
  if (typeof key !== 'string') return null;
  const m = /:(\d+)$/.exec(key);
  return m ? parseInt(m[1], 10) : null;
};
const sign = (n: number) => (n > 0 ? `+${n}` : `${n}`);
/** 場面に出す目安（表示だけ。ルールではない）: HP の最低は最大の半分以下、最大の一撃は最大 HP の 15% 以上 */
const HP_MIN_MOMENT_PCT = 50;
const BIG_HIT_MOMENT_PCT = 15;

interface Fight { id: string; kind: string | null; name?: Names; depth: number | null; warden: boolean; first: number; last: number; dealt: number; taken: number; outcome: 'slain' | 'slain_by_other' | 'left' | 'died' | 'ongoing' }

/** 遠征 1 回分のレポートを作る（compare は compareReports で別に付ける） */
export function buildExpeditionReport(inp: ReportInput): ExpeditionReport {
  const L = inp.locale;
  const self = inp.selfId;
  const cat = inp.catalog;
  const ms = inp.milestone;
  const isMilestone = (d: number | null) => !!ms && d !== null && d >= ms.min && d % ms.every === 0;
  const name = (kind: string | null | undefined) => (kind ? kindName(cat, L, kind) : t(L, '見えない何か', 'something unseen'));
  const combat: ExpeditionReport['combat'] = { dealt: 0, taken: 0, hits: 0, misses: 0, crits: 0, kills: 0, melee_kills: 0, thrown_kills: 0, ability_uses: 0 };
  let minPct = 100;
  const economy: ExpeditionReport['economy'] = { potions_used: 0, scrolls_read: 0, items_left_unidentified: 0, treasure_banked: 0 };
  const potionKinds = new Map<string, number>();
  let objective: ExpeditionReport['objective'] = { type: 'unknown', target_depth: null };
  let reason: ExpeditionEndReason | null = null;
  let payout: ExpeditionReport['payout'];
  let startTurns: number | null = null;
  let hp: number | null = null;
  let maxHp: number | null = null;
  let deepest = 0;
  const floors = new Set<string>();
  const picked = new Set<string>();
  const identified = new Set<string>(inp.knownAppearances ?? []);
  // 手番: その seq の時点で終えていた手番数
  const marks = inp.marks;
  const turnAt = (seq: number): number => {
    let lo = 0, hi = marks.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (marks[mid][0] <= seq) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans >= 0 ? marks[ans][1] : (startTurns ?? 0);
  };
  // HP の推移（手番ごと。死亡の直前 20 手番に使う）
  const trace: number[] = [];
  let mi = 0;
  const flushMarks = (seq: number) => {
    while (mi < marks.length && marks[mi][0] < seq) { if (hp !== null) trace.push(hp); if (trace.length > 40) trace.shift(); mi++; }
  };
  const damageLog: { seq: number; turn: number; src: string | null; kind: string | null; via: string; amt: number }[] = [];
  let lastAtkOnMe: { attacker: string | null; crit: boolean } | null = null;
  let big: { seq: number; amt: number; kind: string | null; via: string; crit: boolean } | null = null;
  let low: { seq: number; hp: number; maxHp: number } | null = null;
  let minHp: { seq: number; hp: number; maxHp: number | null } | null = null;
  const escapes: { seq: number; hp: number; maxHp: number; how: 'stairs' | 'lifeline' | 'extract' | 'withdraw' }[] = [];
  const levelUps: { seq: number; level: number }[] = [];
  const discoveries: { seq: number; amount: number; reasons: string[] }[] = [];
  const fights = new Map<string, Fight>();
  const bounties = new Set(inp.bountyIds ?? []);
  const bountyFights = new Map<string, { id: string; dealt: number; taken: number }>();
  const bountyOf = (id: string) => { let b = bountyFights.get(id); if (!b) { b = { id, dealt: 0, taken: 0 }; bountyFights.set(id, b); } return b; };
  const names = new Map<string, Names>();
  const wardens = new Set<string>();
  let death: { seq: number; killer: string | null; selfHarm: boolean; via: string } | null = null;
  // 目的の守護者: 倒れた直後に目的が達成された守護者（名前は遠征の公開情報から）
  let lastGuardianDeath: string | null = null;
  let objectiveGuardian: string | null = null;
  const fightOf = (id: string, kind: string | null, seq: number, floor: unknown): Fight => {
    let f = fights.get(id);
    if (!f) { f = { id, kind, depth: depthOf(floor), warden: isMilestone(depthOf(floor)), first: seq, last: seq, dealt: 0, taken: 0, outcome: 'ongoing' }; fights.set(id, f); }
    f.last = seq;
    return f;
  };
  const isGuardian = (aff: unknown) => Array.isArray(aff) && aff.includes('core:guardian');

  for (const ev of inp.events) {
    const e = ev as Record<string, any> & { type: string; seq: number; floor?: unknown };
    flushMarks(e.seq);
    if (typeof e.guardianName === 'object' && e.guardianName) {
      const id = (e.guardian ?? e.id) as string | undefined;
      if (id) names.set(id, e.guardianName as Names);
    }
    switch (e.type) {
      case 'expedition_started': {
        if (e.expedition?.no !== inp.no) break;
        objective = { type: e.expedition.objective?.type ?? 'unknown', target_depth: e.expedition.objective?.targetDepth ?? null };
        const st = e.expedition.self as { turns?: number; hp?: number; maxHp?: number } | undefined;
        if (st) { startTurns = st.turns ?? null; hp = st.hp ?? hp; maxHp = st.maxHp ?? maxHp; }
        break;
      }
      case 'entity_moved':
        if (e.id === self && typeof e.floor === 'string') floors.add(e.floor);
        break;
      case 'entity_changed_floor':
        if (e.id !== self) break;
        if (e.from?.floor) floors.add(e.from.floor);
        if (e.to?.floor) floors.add(e.to.floor);
        if (low) { escapes.push({ ...low, how: 'stairs' }); low = null; }
        break;
      case 'attack':
        if (e.attacker === self) { if (e.hit) combat.hits++; else combat.misses++; if (e.crit) combat.crits++; }
        if (e.target === self) lastAtkOnMe = { attacker: e.attacker ?? null, crit: !!e.crit };
        break;
      case 'damaged': {
        const amt = (e.dealt ?? e.amount ?? 0) as number;
        if (e.target === self) {
          combat.taken += amt;
          hp = e.hpAfter ?? hp;
          const crit = !!lastAtkOnMe && lastAtkOnMe.attacker === e.source && lastAtkOnMe.crit;
          lastAtkOnMe = null;
          damageLog.push({ seq: e.seq, turn: turnAt(e.seq), src: e.source ?? null, kind: e.sourceKind ?? null, via: e.via, amt });
          if (!big || amt > big.amt) big = { seq: e.seq, amt, kind: e.sourceKind ?? null, via: e.via, crit };
          if (hp !== null && hp > 0 && (!minHp || hp < minHp.hp)) minHp = { seq: e.seq, hp, maxHp };
          if (hp !== null && maxHp) minPct = Math.min(minPct, Math.max(0, Math.trunc((hp * 100) / maxHp)));
          if (hp !== null && hp > 0 && maxHp && hp * 100 <= maxHp * 25 && (!low || hp < low.hp)) low = { seq: e.seq, hp, maxHp };
          if (e.source && isGuardian(e.sourceAffixes)) fightOf(e.source, e.sourceKind ?? null, e.seq, e.floor).taken += amt;
          else if (e.source && bounties.has(e.source)) bountyOf(e.source).taken += amt;
        } else if (e.source === self) {
          combat.dealt += amt;
          if (e.target && isGuardian(e.targetAffixes)) fightOf(e.target, e.targetKind ?? null, e.seq, e.floor).dealt += amt;
          else if (e.target && bounties.has(e.target)) bountyOf(e.target).dealt += amt;
        }
        break;
      }
      case 'healed':
        if (e.target !== self) break;
        hp = e.hpAfter ?? hp;
        if (low && hp !== null && maxHp && hp * 100 > maxHp * 50) low = null;
        break;
      case 'max_hp_changed':
        if (e.target !== self) break;
        maxHp = e.maxHpAfter ?? maxHp;
        hp = e.hpAfter ?? hp;
        break;
      case 'stats_changed':
        if (e.target !== self) break;
        if (e.statsAfter) { maxHp = e.statsAfter.maxHp ?? maxHp; hp = e.statsAfter.hp ?? hp; }
        break;
      case 'level_up':
        if (e.target !== self) break;
        if (e.statsAfter) { maxHp = e.statsAfter.maxHp ?? maxHp; hp = e.statsAfter.hp ?? hp; }
        levelUps.push({ seq: e.seq, level: e.levelAfter });
        break;
      case 'died':
        if (e.id === self) { death = { seq: e.seq, killer: e.killerKind ?? null, selfHarm: e.killer === self, via: e.via }; for (const f of fights.values()) if (f.outcome === 'ongoing') f.outcome = 'died'; break; }
        if (e.killer === self) { combat.kills++; if (e.via === 'melee') combat.melee_kills++; else if (e.via === 'thrown') combat.thrown_kills++; }
        if (e.id && (isGuardian(e.affixes) || fights.has(e.id))) {
          const f = fightOf(e.id, e.kind ?? null, e.seq, e.floor);
          f.outcome = e.killer === self ? 'slain' : 'slain_by_other';
          lastGuardianDeath = e.id;
        }
        break;
      case 'warden_slain':
        if (e.id) { wardens.add(e.id); if (e.guardianName) names.set(e.id, e.guardianName); }
        break;
      case 'ability_used':
        if (e.actor === self) combat.ability_uses++;
        break;
      case 'item_thrown':
        // 投擲の当たり外れも命中に数える（V3-5a 後の AI 評価: 斥候の命中が近接だけで 1/8 と出た）
        if (e.actor !== self) break;
        if (e.outcome === 'hit') combat.hits++;
        else if (e.outcome === 'missed') combat.misses++;
        break;
      case 'objective_completed':
        if (e.no === inp.no && lastGuardianDeath && (objective.type === 'slay_guardian' || objective.type === 'retrieve_relic')) objectiveGuardian = lastGuardianDeath;
        break;
      case 'item_used':
        if (e.actor !== self) break;
        if (e.category === 'potion') { economy.potions_used++; const k = e.kind ? kindName(cat, L, e.kind) : t(L, '未鑑定の薬', 'unidentified potion'); potionKinds.set(k, (potionKinds.get(k) ?? 0) + 1); }
        else if (e.category === 'scroll') economy.scrolls_read++;
        break;
      case 'item_picked_up':
        if (e.actor === self && e.appearanceId) picked.add(e.appearanceId);
        break;
      case 'item_identified':
        if (e.appearanceId) identified.add(e.appearanceId);
        break;
      case 'haul_changed':
        if (e.gains?.discovery) discoveries.push({ seq: e.seq, amount: e.gains.discovery, reasons: (e.reasons ?? []).filter((r: string) => r.startsWith('identify:') || r.startsWith('species:')) });
        break;
      case 'player_state':
        if (e.state !== 'at_camp' || !low) break;
        escapes.push({ ...low, how: e.reason === 'lifeline' ? 'lifeline' : e.reason === 'withdrew' ? 'withdraw' : 'extract' });
        low = null;
        break;
      case 'expedition_ended': {
        if (e.no !== inp.no) break;
        reason = e.reason ?? e.result?.reason ?? null;
        const r = e.result;
        if (r?.deepest) deepest = Math.max(deepest, r.deepest);
        const pay = r?.payout;
        if (pay) {
          const mine = pay.players?.length === 1 ? pay.players[0] : null;
          payout = { parts: pay.parts, multiplier_pct: pay.multiplierPct, banked: mine ? mine.banked : pay.banked, lost: mine ? mine.lost : pay.lost };
          economy.treasure_banked = pay.parts?.treasure ?? 0;
        }
        break;
      }
      default:
        break;
    }
  }
  flushMarks(Number.MAX_SAFE_INTEGER);
  for (const f of fights.values()) {
    if (wardens.has(f.id)) f.warden = true;
    if (!f.name && names.has(f.id)) f.name = names.get(f.id);
    if (f.outcome === 'ongoing' && reason !== null) f.outcome = 'left';
  }
  for (const k of floors) deepest = Math.max(deepest, depthOf(k) ?? 0);
  for (const a of picked) if (!identified.has(a)) economy.items_left_unidentified++;

  // 進み
  const lastTurn = marks.length ? marks[marks.length - 1][1] : (startTurns ?? 0);
  const turns = Math.max(0, lastTurn - (startTurns ?? (marks.length ? marks[0][1] - 1 : 0)));
  const toolCalls = inp.calls.filter((c) => c.kind !== 'macro_step').length;
  const steps = inp.calls.filter((c) => c.kind !== 'macro_call');
  const macroSteps = steps.filter((c) => c.kind === 'macro_step').length;
  const resting = steps.filter((c) => c.kind === 'macro_step' && (c.macro === 'rest' || c.macro === 'wait')).length;
  const floorN = Math.max(1, floors.size);
  const tempo = {
    turns, turns_resting: resting, floors: floors.size, turns_per_floor: Math.round(turns / floorN), deepest,
    tool_calls: toolCalls, macro_share_pct: steps.length ? Math.round((macroSteps * 100) / steps.length) : 0,
  };

  // 場面（優先: 大守護者 > 守護者 > 死の際から逃れた > HP の最低 > 最大の一撃 > 発見 > レベル。最大 8 件を seq 順に）
  const cand: (ReportMoment & { pri: number })[] = [];
  const at = (seq: number) => turnAt(seq);
  for (const f of [...fights.values()].sort((a, b) => a.first - b.first)) {
    if (!f.dealt && !f.taken) continue;
    const known = f.name ? nameOf(f.name, L)
      : f.warden && f.depth !== null && inp.guardianNames?.warden?.[f.depth] ? inp.guardianNames.warden[f.depth]
        : f.id === objectiveGuardian && inp.guardianNames?.objective ? inp.guardianNames.objective : null;
    // 名前が分からない守護者は種族で書く（「守護者オークの荒くれ」）
    const who = known ? t(L, `${f.warden ? '大守護者' : '守護者'}「${known}」`, `${f.warden ? 'the warden' : 'the guardian'} "${known}"`)
      : t(L, `${f.warden ? '大守護者' : '守護者'}${name(f.kind)}`, `${f.warden ? 'the warden' : 'the guardian'} ${name(f.kind)}`);
    const out = { slain: t(L, '倒した', 'slain'), slain_by_other: t(L, '仲間が倒した', 'slain by an ally'), left: t(L, '倒さずに離れた', 'left it standing'), died: t(L, 'あなたが倒れた', 'you fell'), ongoing: t(L, '戦っている', 'ongoing') }[f.outcome];
    const t0 = at(f.first), t1 = at(f.last);
    const span = t0 === t1 ? `${t0}` : `${t0}〜${t1}`;
    cand.push({
      seq: f.first, turn_no: t0, kind: f.warden ? 'warden_fight' : 'guardian_fight', pri: f.warden ? 0 : 1,
      text: t(L, `手番 ${span}: ${who}と戦った（与 ${f.dealt}・被 ${f.taken}、${out}）`, `Turns ${span}: fought ${who} (dealt ${f.dealt}, took ${f.taken}; ${out})`),
    });
  }
  for (const x of escapes.slice(0, 2)) {
    const how = { stairs: t(L, '階段で離れた', 'left by the stairs'), lifeline: t(L, '帰還の綱で逃れた', 'escaped with the lifeline'), extract: t(L, '帰還した', 'extracted'), withdraw: t(L, '撤退した', 'withdrew') }[x.how];
    cand.push({ seq: x.seq, turn_no: at(x.seq), kind: 'near_death_escape', pri: 2, text: t(L, `手番 ${at(x.seq)}: HP ${x.hp}/${x.maxHp} まで減り、${how}`, `Turn ${at(x.seq)}: down to ${x.hp}/${x.maxHp} HP, then ${how}`) });
  }
  if (minHp && !death && !escapes.some((x) => x.seq === minHp!.seq) && (!minHp.maxHp || minHp.hp * 100 <= minHp.maxHp * HP_MIN_MOMENT_PCT)) {
    const m = minHp;
    const turn = at(m.seq);
    // その手番までの 3 手番に受けた被害の出どころ
    const recent = damageLog.filter((d) => d.seq <= m.seq && d.turn >= turn - 2);
    const bySrc = new Map<string, { kind: string | null; via: string; ids: Set<string> }>();
    for (const d of recent) {
      const key = `${d.kind}|${d.via}`;
      const g = bySrc.get(key) ?? { kind: d.kind, via: d.via, ids: new Set<string>() };
      g.ids.add(d.src ?? '?');
      bySrc.set(key, g);
    }
    // 出どころの見えない罠・毒・効果は種類だけ（「罠」「毒」）
    const src = [...bySrc.values()].map((g) => (!g.kind && g.via !== 'melee' && g.via !== 'ranged' && g.via !== 'thrown')
      ? viaText(L, g.via)
      : `${name(g.kind)}${g.ids.size > 1 ? ` ${g.ids.size} ${t(L, '体', '')}`.trimEnd() : ''}${t(L, 'の', ' ')}${viaText(L, g.via)}`).join(t(L, '・', ', '));
    cand.push({
      seq: m.seq, turn_no: turn, kind: 'hp_min', pri: 3,
      text: t(L, `手番 ${turn}: HP が最低の ${m.hp}${m.maxHp ? `/${m.maxHp}` : ''} になった${src ? `（${src}を受けていた）` : ''}`, `Turn ${turn}: HP hit its low of ${m.hp}${m.maxHp ? `/${m.maxHp}` : ''}${src ? ` (taking ${src})` : ''}`),
    });
  }
  if (big && big.amt > 0 && (!maxHp || big.amt * 100 >= maxHp * BIG_HIT_MOMENT_PCT)) {
    const b = big;
    cand.push({ seq: b.seq, turn_no: at(b.seq), kind: 'big_hit_taken', pri: 4, text: t(L, `手番 ${at(b.seq)}: 一撃で最大の ${b.amt} ダメージ（${name(b.kind)}・${viaText(L, b.via)}${b.crit ? '・会心' : ''}）`, `Turn ${at(b.seq)}: the biggest single hit, ${b.amt} (${name(b.kind)}, ${b.via}${b.crit ? ', critical' : ''})`) });
  }
  for (const d of discoveries.slice(0, 2)) {
    const what = d.reasons.map((r) => {
      const [k, kind] = [r.slice(0, r.indexOf(':')), r.slice(r.indexOf(':') + 1)];
      return k === 'identify' ? t(L, `鑑定: ${name(kind)}`, `identified ${name(kind)}`) : t(L, `初めて倒した: ${name(kind)}`, `first kill: ${name(kind)}`);
    }).join(t(L, '・', ', '));
    cand.push({ seq: d.seq, turn_no: at(d.seq), kind: 'discovery', pri: 5, text: t(L, `手番 ${at(d.seq)}: 発見 +${d.amount}${what ? `（${what}）` : ''}`, `Turn ${at(d.seq)}: discovery +${d.amount}${what ? ` (${what})` : ''}`) });
  }
  for (const u of levelUps.slice(0, 3)) cand.push({ seq: u.seq, turn_no: at(u.seq), kind: 'level_up', pri: 6, text: t(L, `手番 ${at(u.seq)}: レベル ${u.level} になった`, `Turn ${at(u.seq)}: reached level ${u.level}`) });
  const moments = cand.sort((a, b) => a.pri - b.pri || a.seq - b.seq).slice(0, 8).sort((a, b) => a.seq - b.seq).map(({ pri: _p, ...m }) => m);

  combat.min_hp_pct = minPct;
  const gf = [...fights.values()].filter((f) => f.dealt || f.taken).sort((a, b) => a.first - b.first).map((f) => ({ id: f.id, dealt: f.dealt, taken: f.taken, outcome: f.outcome }));
  if (gf.length) (combat as ExpeditionReport['combat']).guardian_fights = gf;
  const bf = [...bountyFights.values()].filter((f) => f.dealt || f.taken);
  if (bf.length) (combat as ExpeditionReport['combat']).bounty_fights = bf;
  if (potionKinds.size) economy.potions_detail = [...potionKinds].map(([k, n]) => `${k} ${n}`).join(t(L, '・', ', '));
  const report: ExpeditionReport = {
    no: inp.no, objective, status: reason === null ? 'in_progress' : 'ended', reason,
    ...(payout ? { payout } : {}),
    combat, economy, tempo, moments,
  };
  if (death) {
    const d = death;
    const before = inp.events.filter((e) => e.seq <= d.seq);
    const texts: string[] = [];
    if (inp.narrate) for (let i = before.length - 1; i >= 0 && texts.length < 10; i--) { const s = inp.narrate(before[i]); if (s) texts.unshift(s); }
    report.death = { killer: d.selfHarm || d.killer === null ? null : name(d.killer), via: d.via, ...(d.selfHarm ? { self_inflicted: true } : {}), last_events: texts, hp_trace: [...trace.slice(-19), 0] };
  }
  return report;
}

/** このランの中の前の遠征と比べる（vs_previous: 直前の遠征との差、personal_best: 自己最高の事実）。最少・最短は達成した遠征どうしで比べる */
export function compareReports(L: Locale, cur: ExpeditionReport, prevs: readonly ExpeditionReport[]): ReportCompare | undefined {
  const ended = prevs.filter((p) => p.status === 'ended' && p.no < cur.no);
  if (!ended.length) return undefined;
  const prev = ended[ended.length - 1];
  const banked = (r: ExpeditionReport) => r.payout?.banked ?? 0;
  const out: ReportCompare = {
    vs_previous: { no: prev.no, banked: banked(cur) - banked(prev), taken: cur.combat.taken - prev.combat.taken, turns: cur.tempo.turns - prev.tempo.turns, kills: cur.combat.kills - prev.combat.kills, tool_calls: cur.tempo.tool_calls - prev.tempo.tool_calls },
  };
  const best: string[] = [];
  const maxOf = (f: (r: ExpeditionReport) => number) => Math.max(...ended.map(f));
  if (banked(cur) > 0 && banked(cur) > maxOf(banked)) best.push(t(L, `確定点が自己最高（+${banked(cur)}）`, `best banked (+${banked(cur)})`));
  if (cur.tempo.deepest > maxOf((r) => r.tempo.deepest)) best.push(t(L, `最深が自己最高（地下${cur.tempo.deepest}階）`, `deepest yet (depth ${cur.tempo.deepest})`));
  if (cur.combat.kills > 0 && cur.combat.kills > maxOf((r) => r.combat.kills)) best.push(t(L, `撃破が最多（${cur.combat.kills}）`, `most kills (${cur.combat.kills})`));
  if (cur.combat.dealt > 0 && cur.combat.dealt > maxOf((r) => r.combat.dealt)) best.push(t(L, `与ダメージが最多（${cur.combat.dealt}）`, `most damage dealt (${cur.combat.dealt})`));
  const done = ended.filter((r) => r.reason === 'completed');
  if (cur.reason === 'completed' && done.length) {
    const minOf = (f: (r: ExpeditionReport) => number) => Math.min(...done.map(f));
    // 最少・最短は達成した遠征どうしで比べた（文にもそう書く。V3-5a 後の AI 評価）
    if (cur.combat.taken < minOf((r) => r.combat.taken)) best.push(t(L, `被ダメージが達成した遠征で最少（${cur.combat.taken}）`, `least damage taken among completed expeditions (${cur.combat.taken})`));
    if (cur.tempo.turns < minOf((r) => r.tempo.turns)) best.push(t(L, `手番が達成した遠征で最短（${cur.tempo.turns}）`, `fewest turns among completed expeditions (${cur.tempo.turns})`));
    if (cur.tempo.tool_calls < minOf((r) => r.tempo.tool_calls)) best.push(t(L, `呼び出しが達成した遠征で最少（${cur.tempo.tool_calls}）`, `fewest calls among completed expeditions (${cur.tempo.tool_calls})`));
  }
  if (best.length) out.personal_best = best;
  return out;
}

function vsText(L: Locale, v: NonNullable<ReportCompare['vs_previous']>): string {
  return t(L,
    `確定 ${sign(v.banked)}・被ダメージ ${sign(v.taken)}・手番 ${sign(v.turns)}・撃破 ${sign(v.kills)}・呼び出し ${sign(v.tool_calls)}`,
    `banked ${sign(v.banked)}, damage taken ${sign(v.taken)}, turns ${sign(v.turns)}, kills ${sign(v.kills)}, calls ${sign(v.tool_calls)}`);
}

/** キャンプに出す直前の遠征の比較（2 行以内。§35.9: 候補を選ぶ画面で自分の記録が目に入る） */
export function compareLines(L: Locale, r: ExpeditionReport): string[] {
  const head = t(L, `前回の遠征 ${r.no}（${reasonText(L, r.reason)}）`, `Last expedition ${r.no} (${reasonText(L, r.reason)})`);
  const c = r.compare;
  if (!c?.vs_previous) {
    return [t(L, `${head}: 確定 +${r.payout?.banked ?? 0}・被ダメージ ${r.combat.taken}・手番 ${r.tempo.turns}・撃破 ${r.combat.kills}（比べる記録はまだ無い）`, `${head}: banked +${r.payout?.banked ?? 0}, damage taken ${r.combat.taken}, turns ${r.tempo.turns}, kills ${r.combat.kills} (nothing to compare yet)`)];
  }
  return [
    `${head}: ${c.personal_best?.length ? c.personal_best.join(t(L, '・', ', ')) : t(L, '自己最高は無し', 'no personal bests')}`,
    t(L, `その前（遠征 ${c.vs_previous.no}）と比べて: ${vsText(L, c.vs_previous)}`, `Versus expedition ${c.vs_previous.no}: ${vsText(L, c.vs_previous)}`),
  ];
}

function combatLine(L: Locale, r: ExpeditionReport): string {
  const c = r.combat;
  return t(L,
    `戦闘: 与ダメージ ${c.dealt}・被ダメージ ${c.taken}・命中 ${c.hits}/${c.hits + c.misses}${c.crits ? `（会心 ${c.crits}）` : ''}・撃破 ${c.kills}（近接 ${c.melee_kills}・投擲 ${c.thrown_kills}）・能動技 ${c.ability_uses} 回${c.min_hp_pct !== undefined ? `・最も下がった HP ${c.min_hp_pct}%` : ''}`,
    `Combat: dealt ${c.dealt}, took ${c.taken}, hit ${c.hits}/${c.hits + c.misses}${c.crits ? ` (${c.crits} crits)` : ''}, kills ${c.kills} (melee ${c.melee_kills}, thrown ${c.thrown_kills}), abilities ${c.ability_uses}${c.min_hp_pct !== undefined ? `, lowest HP ${c.min_hp_pct}%` : ''}`);
}

function tempoLine(L: Locale, r: ExpeditionReport): string {
  const p = r.tempo;
  return t(L, `進み: 手番 ${p.turns}（休憩 ${p.turns_resting}）・${p.floors} 階（1 階あたり ${p.turns_per_floor} 手番）・最深 地下${p.deepest}階・呼び出し ${p.tool_calls}（マクロの手 ${p.macro_share_pct}%）`,
    `Tempo: ${p.turns} turns (${p.turns_resting} resting), ${p.floors} floors (${p.turns_per_floor} turns each), deepest ${p.deepest}, ${p.tool_calls} calls (${p.macro_share_pct}% of steps by macros)`);
}

/** 進行中の遠征の途中経過（戦闘と進み。V3-6 §6.2: expedition ツール） */
export function progressLines(L: Locale, r: ExpeditionReport): string[] {
  return [t(L, `途中経過（遠征 ${r.no}）:`, `Progress so far (expedition ${r.no}):`), combatLine(L, r), tempoLine(L, r)];
}

/** レポートの文（12 行以内）。payout / compare を他の行で出しているときは省ける */
export function reportLines(L: Locale, r: ExpeditionReport, opts: { payout?: boolean; compare?: boolean } = {}): string[] {
  const lines: string[] = [];
  lines.push(r.status === 'in_progress'
    ? t(L, `途中経過（遠征 ${r.no}）:`, `Progress so far (expedition ${r.no}):`)
    : t(L, `振り返り（遠征 ${r.no}・${reasonText(L, r.reason)}）:`, `Review (expedition ${r.no}, ${reasonText(L, r.reason)}):`));
  if (opts.payout !== false && r.payout) {
    lines.push(t(L, `確定 +${r.payout.banked}（${partsText(L, r.payout.parts) || 'なし'}、倍率 ${multText(r.payout.multiplier_pct)}）${r.payout.lost ? `／失った ${r.payout.lost}` : ''}`,
      `Banked +${r.payout.banked} (${partsText(L, r.payout.parts) || 'none'}, ${multText(r.payout.multiplier_pct)})${r.payout.lost ? `; lost ${r.payout.lost}` : ''}`));
  }
  lines.push(combatLine(L, r));
  const e = r.economy;
  const pd = e.potions_detail ? t(L, `（${e.potions_detail}）`, ` (${e.potions_detail})`) : '';
  lines.push(t(L, `道具: 薬 ${e.potions_used}${pd}・巻物 ${e.scrolls_read}・未鑑定のまま ${e.items_left_unidentified} 種／宝の確定 ${e.treasure_banked}`,
    `Items: potions ${e.potions_used}${pd}, scrolls ${e.scrolls_read}, still unidentified ${e.items_left_unidentified} kinds; treasure banked ${e.treasure_banked}`));
  lines.push(tempoLine(L, r));
  if (opts.compare !== false && r.compare) {
    const parts = [r.compare.personal_best?.join(t(L, '・', ', ')), r.compare.vs_previous ? t(L, `前回（遠征 ${r.compare.vs_previous.no}）より ${vsText(L, r.compare.vs_previous)}`, `vs expedition ${r.compare.vs_previous.no}: ${vsText(L, r.compare.vs_previous)}`) : ''].filter(Boolean);
    if (parts.length) lines.push(t(L, `比較: ${parts.join('／')}`, `Compare: ${parts.join('; ')}`));
  }

  if (r.death) {
    const d = r.death;
    const how = d.killer ? t(L, `${d.killer}の${viaText(L, d.via)}で倒れた`, `fell to ${d.killer} (${d.via})`)
      : d.self_inflicted ? t(L, `自分に付いた${viaText(L, d.via)}で倒れた`, `fell to ${d.via} on yourself`) : t(L, `${viaText(L, d.via)}で倒れた`, `fell to ${d.via}`);
    lines.push(t(L, `最期: ${how}。直近の HP: ${d.hp_trace.slice(-8).join('→')}`, `Death: ${how}. Recent HP: ${d.hp_trace.slice(-8).join(' → ')}`));
  }
  const room = 12 - lines.length - 1;
  if (r.moments.length && room > 0) {
    lines.push(t(L, '場面:', 'Moments:'));
    // 場面が入りきらないときは、優先の高いもの（守護者・死の際）を残す
    const order: MomentKind[] = ['warden_fight', 'guardian_fight', 'near_death_escape', 'hp_min', 'big_hit_taken', 'discovery', 'level_up'];
    const keep = new Set([...r.moments].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.seq - b.seq).slice(0, room));
    for (const m of r.moments) if (keep.has(m)) lines.push(`- ${m.text}`);
  }
  return lines.slice(0, 12);
}

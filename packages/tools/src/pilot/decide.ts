// pilot の判断（IMPROVEMENTS_V4 §10.4〜§10.6）。観測の構造化された項目（alerts・visible・navigation・expedition・camp）だけから、
// 「方針の範囲で続ける」（1 つの道具）か「起こす」かを決める純粋な関数。規則の知識（種族の名前や数値）は持たない。迷ったら起こす。
// #3（rev の読み直し）と #4（queue）は呼ぶ側（pilot.ts）が先に済ませる。
import type { ObsMonster, Observation } from '@muse/shared';
import type { PilotOrders, PilotPolicy } from './orders';

export type WakeLevel = 'wake' | 'notify';
/** key: 同じ理由・同じ相手で何度も起こさないための鍵（AI が返事をしたら、その条件が続く間は起こさない） */
export interface Wake {
  level: WakeLevel; reason: string; key: string; detail: string;
  /** 一緒に返事をもらったことにする鍵（いっぺんに見えた遺物をまとめて 1 回で起こすとき） */
  also?: string[];
}

export type Decision =
  /** 道具を 1 つ使う。then があれば、使った後に起こす（退いてから起こす） */
  | { kind: 'act'; tool: string; args: Record<string, unknown>; then?: Wake }
  /** 起こす（ソロは止まって待つ。協力プレイは次の手番から持ち場の動き）。もう返事をもらった鍵なら、起こし直さずに待つ */
  | { kind: 'wake'; wake: Wake }
  /** pilot を終える（ランが終わった） */
  | { kind: 'end'; wake: Wake };

export interface DecideContext {
  orders: PilotOrders;
  coop: boolean;
  /** 起こして返事（orders の rev の変化）を待っている */
  waiting: boolean;
  /** AI が返事をした起こし方の鍵 */
  acked: ReadonlySet<string>;
  /** 観測の文（wake.detail には該当する行をそのまま使う） */
  text: string;
  /** この手番で断られた移動の道具（collect・explore・travel_to・use_stairs）。表の次の行へ進む */
  refused?: ReadonlySet<string>;
  /** 最後に断られたときのエラーの code と文と、じゃまをしている見えている敵（details.blocked_by。何も残っていないとき、#18 の理由と detail に使う） */
  refusal?: { code: string; text: string; blockedBy?: readonly string[] } | null;
  /** この遠征のこの階で、もう知らせた鍵（目的でない遺物・役割のある敵は 1 回だけ知らせる。V4-1a §12.6） */
  notified?: ReadonlySet<string>;
}

/**
 * decide の結果と、いま成り立っている起こし方の鍵（成り立たなくなった鍵は、返事をした記録から外す）。
 * notify: 止まらずに知らせるもの（目的でない遺物・役割のある敵。V4-1a §12.6）。decision の前に知らせる
 */
export interface DecideResult { decision: Decision; active: string[]; notify: Wake[] }

/** 断られたら、起こさずに表の次の行へ進む道具（その手番の間だけ外す） */
export const MOVE_TOOLS = new Set(['collect', 'explore', 'travel_to', 'use_stairs']);

/** pilot が自分から使う道具（§10.4。queue は除く）。持ち場の動きの attack・move を含む */
export const PILOT_TOOLS = new Set(['observe', 'explore', 'travel_to', 'collect', 'fight', 'wait', 'use_stairs', 'extract', 'use_item', 'attack', 'move', 'start_expedition']);

const hpPct = (obs: Observation) => Math.floor((obs.self.hp * 100) / Math.max(1, obs.self.max_hp));
const alert = (obs: Observation, code: string) => obs.alerts.find((a) => a.code === code);
/** 観測の文のうち、needle を含む最初の行（無ければ fallback） */
export function lineWith(text: string, needle: string, fallback = ''): string {
  if (!needle) return fallback;
  return text.split('\n').find((l) => l.includes(needle))?.trim() ?? fallback;
}

/** 役割のある敵（守護者・大守護者・名前付きの強敵・賞金首）。挑まない */
export function isRoleEnemy(m: ObsMonster): boolean {
  return m.role === 'guardian' || m.role === 'elite' || !!m.guardian || !!m.named || (m.bounty ?? 0) > 0;
}
function roleReason(m: ObsMonster): string {
  const r = m.guardian?.warden ? 'warden_seen' : m.role === 'guardian' || m.guardian ? 'guardian_seen' : 'elite_seen';
  return m.awareness === 'hunting' ? `${r}_hunting` : r;
}
/** 追ってくる敵（追跡中で、逃げていなくて、動ける。見れば分かる特徴の「動かない」は追ってこない） */
export function chasers(obs: Observation): ObsMonster[] {
  return obs.visible.monsters.filter((m) => m.awareness === 'hunting' && !m.fleeing && !m.traits?.includes('stationary'));
}

/** 退く（§10.6）。できる手が無ければ null */
export function retreat(obs: Observation, p: PilotPolicy): { tool: string; args: Record<string, unknown> } | null {
  const x = obs.expedition;
  const onStairs = !!alert(obs, 'on_stairs');
  if (onStairs && p.allow_extract && x?.can_extract) return { tool: 'extract', args: x.extract_outcome === 'complete' ? {} : { confirm: true } };
  if (p.allow_lifeline && (obs.self.inventory ?? []).some((i) => i.kind === 'core:lifeline')) return { tool: 'use_item', args: { slot: 'lifeline' } };
  // 知っている階段までの見込み（観測の escape）が「着ける」: 追われたままの最悪の被害が分かっていて、HP より小さい
  const esc = alert(obs, 'escape')?.data as { stairs?: 'up' | 'down'; worst_if_chased?: number | null; hp?: number } | undefined;
  if (esc?.stairs && typeof esc.worst_if_chased === 'number' && typeof esc.hp === 'number' && esc.worst_if_chased < esc.hp) {
    return { tool: 'travel_to', args: { to: `stairs_${esc.stairs}`, mode: 'flee' } };
  }
  return null;
}

/** 持ち場の動き（§10.5。協力プレイで起こして待っている間・mode: hold）。毎手番すぐに答える */
export function holdAction(obs: Observation, p: PilotPolicy): { tool: string; args: Record<string, unknown> } {
  if (alert(obs, 'lethal_range') || alert(obs, 'critical_hp')) {
    const r = retreat(obs, p);
    if (r) return r;
  }
  const adj = obs.visible.monsters.filter((m) => m.dist <= 1 && m.awareness !== 'asleep').sort((a, b) => a.dist - b.dist)[0];
  if (adj) return { tool: 'attack', args: { target: adj.id } };
  const ally = (obs.visible.players ?? []).filter((pl) => pl.dist > 1 && pl.dir).sort((a, b) => a.dist - b.dist)[0];
  if (chasers(obs).length && ally?.dir) return { tool: 'move', args: { dir: ally.dir } };
  return { tool: 'wait', args: {} };
}

export function decide(obs: Observation, ctx: DecideContext): DecideResult {
  const p = ctx.orders.policy;
  const active: string[] = [];
  const W = (reason: string, key: string, detail: string, level: WakeLevel = 'wake'): Wake => ({ level, reason, key, detail });
  /** 起こし方の鍵が、まだ返事をもらっていないか（成り立っている鍵は active に積む） */
  const fresh = (key: string) => { if (!active.includes(key)) active.push(key); return !ctx.acked.has(key); };
  const notify: Wake[] = [];
  const act = (tool: string, args: Record<string, unknown>, then?: Wake): DecideResult => ({ decision: { kind: 'act', tool, args, ...(then ? { then } : {}) }, active, notify });
  const wake = (w: Wake): DecideResult => { if (!active.includes(w.key)) active.push(w.key); return { decision: { kind: 'wake', wake: w }, active, notify }; };
  const x = obs.expedition;
  const can = (tool: string) => !ctx.refused?.has(tool);

  // 1. ランが終わった
  if (obs.status === 'ended' || obs.status === 'dead') return { decision: { kind: 'end', wake: W('ended', 'ended', obs.summary) }, active, notify };
  // 2. キャンプ: その枠の候補で自動で出発するか、起こす（遠征のレポートの要点を添える）
  if (obs.status === 'at_camp') {
    const slot = ctx.orders.camp.auto_start;
    const offer = slot ? obs.camp?.offers.find((o) => o.slot === slot) : undefined;
    if (offer) return act('start_expedition', { offer: offer.index });
    return wake(W('camp', `camp:${obs.camp?.next_no ?? ''}`, x?.result?.text ?? obs.summary));
  }
  // いま成り立っている条件の鍵を、表のどの行で決まるかに関わらず先に数える（成り立たなくなった鍵だけが、返事をした記録から外れる）
  for (const code of ['perk_pending', 'boon_pending']) { const a = alert(obs, code); if (a) active.push(`${code}:${JSON.stringify(a.data ?? '')}`); }
  if (hpPct(obs) < p.wake_hp_pct) active.push('low_hp');
  for (const m of obs.visible.monsters.filter(isRoleEnemy)) active.push(`${roleReason(m)}:${m.id}`);
  for (const it of obs.visible.items.filter((i) => i.role === 'relic')) active.push(`relic_seen:${it.id}`);
  const ch = chasers(obs);
  if (ch.length > p.max_chasers) active.push(`too_many:${ch.length}`);
  if (!p.fight && ch.length) active.push('chased');
  if (x?.status === 'objective_complete') active.push(`objective_done:${x.no}`);
  // 5. 持ち場の動き（mode: hold、または協力プレイで起こして待っている）
  if (ctx.orders.mode === 'hold' || (ctx.coop && ctx.waiting)) {
    const h = holdAction(obs, p);
    return act(h.tool, h.args);
  }
  // 6. 特技・加護の選択が待っている（選ばない）
  for (const code of ['perk_pending', 'boon_pending']) {
    const a = alert(obs, code);
    const key = `${code}:${JSON.stringify(a?.data ?? '')}`;
    if (a && fresh(key)) return wake(W(code, key, a.text));
  }
  // 7. 危ない: 退いてから起こす（退く手が無ければ起こすだけ）
  const danger = alert(obs, 'lethal_range') ?? alert(obs, 'critical_hp');
  if (danger) {
    const key = `danger:${obs.self.hp}:${obs.seq}`;
    fresh(key);
    const r = retreat(obs, p);
    const w = W('danger', key, danger.text);
    return r ? act(r.tool, r.args, w) : wake(w);
  }
  // 8. HP が wake_hp_pct を切った
  if (hpPct(obs) < p.wake_hp_pct && fresh('low_hp')) return wake(W('low_hp', 'low_hp', alert(obs, 'low_hp')?.text ?? obs.summary));
  // 9. 役割のある敵が見えている（挑まない）。この遠征の目的の相手なら起こし、目的でなければ同じ階にいる間に 1 回だけ知らせる（V4-1a §12.6）
  for (const m of obs.visible.monsters.filter(isRoleEnemy).sort((a, b) => a.dist - b.dist)) {
    const reason = roleReason(m);
    const key = `${reason}:${m.id}`;
    if (!m.objective) {
      if (!ctx.notified?.has(key)) notify.push(W(reason, key, lineWith(ctx.text, m.id, m.name), 'notify'));
      continue;
    }
    if (fresh(key)) return wake(W(reason, key, lineWith(ctx.text, m.id, m.name)));
  }
  // 10. 遺物（遠征の目的の品）が見えている（拾わない）
  // いっぺんに見えた遺物は、まとめて 1 回で起こす（鍵は近い順の最初の遺物。ほかの遺物の鍵も一緒に返事をもらったことにする）。
  // この遠征の目的でない遺物（前の遠征の遺物など）は、同じ階にいる間に 1 回だけ知らせる（V4-1a §12.6）
  const others = obs.visible.items.filter((i) => i.role === 'relic' && !i.objective && !ctx.notified?.has(`relic_seen:${i.id}`)).sort((a, b) => a.dist - b.dist);
  if (others.length) {
    const n = W('relic_seen', `relic_seen:${others[0]!.id}`, others.map((it) => lineWith(ctx.text, it.id, it.name)).join('\n'), 'notify');
    if (others.length > 1) n.also = others.slice(1).map((it) => `relic_seen:${it.id}`);
    notify.push(n);
  }
  const relics = obs.visible.items.filter((i) => i.role === 'relic' && i.objective).sort((a, b) => a.dist - b.dist).filter((it) => fresh(`relic_seen:${it.id}`));
  if (relics.length) {
    const w = W('relic_seen', `relic_seen:${relics[0]!.id}`, relics.map((it) => lineWith(ctx.text, it.id, it.name)).join('\n'));
    if (relics.length > 1) w.also = relics.slice(1).map((it) => `relic_seen:${it.id}`);
    return wake(w);
  }
  // 11. 追ってくる敵が多い、または戦わない方針で追われている
  if (ch.length > p.max_chasers && fresh(`too_many:${ch.length}`)) return wake(W('too_many', `too_many:${ch.length}`, alert(obs, 'enemy_adjacent')?.text ?? alert(obs, 'enemy_in_view')?.text ?? obs.summary));
  if (!p.fight && ch.length && fresh('chased')) return wake(W('chased', 'chased', alert(obs, 'enemy_in_view')?.text ?? obs.summary));
  // 12. 追ってくる役割の無い敵と戦う（hp_floor は wake_hp_pct の値）
  const target = p.fight ? ch.filter((m) => !isRoleEnemy(m)).sort((a, b) => a.dist - b.dist)[0] : undefined;
  if (target) return act('fight', { target: target.id, hp_floor: Math.floor((obs.self.max_hp * p.wake_hp_pct) / 100), ...(p.approach === 'advance' ? { approach: 'advance' } : {}) });
  // 13. 敵がいなくて HP が rest_below_pct を切っている: 10 手番待つ（休息）
  if (!ch.length && hpPct(obs) < p.rest_below_pct) return act('wait', { turns: 10 });
  const depth = obs.self.floor?.depth ?? 0;
  const targetDepth = x?.objective.target_depth ?? null;
  const stairs = obs.navigation.known_stairs.filter((s) => s.reachable);
  // 封じられた下り階段（大守護者を倒していない節目の階。V4-1a §12.4）へは下りに行かない
  const down = stairs.find((s) => s.type === 'down' && !s.sealed);
  // 14. 遠征の目的を果たした
  if (x && x.status === 'objective_complete') {
    if (p.after_objective === 'wake') {
      const key = `objective_done:${x.no}`;
      if (fresh(key)) return wake(W('objective_done', key, x.text));
    } else {
      if (x.can_extract) return act('extract', {});
      const near = [...stairs].sort((a, b) => (a.path_len ?? a.dist) - (b.path_len ?? b.dist))[0];
      if (near && can('travel_to')) return act('travel_to', { to: `stairs_${near.type}` });
    }
  }
  // 15. 目的の階へ下りる（目的が「踏破」なら、目的の階の下り階段に着くまで）
  if (p.descend && x && x.status === 'in_progress') {
    const below = targetDepth === null || depth < targetDepth;
    const crossing = x.objective.type === 'reach_depth' && targetDepth !== null && depth === targetDepth;
    if ((below || crossing) && down) {
      if (down.dist === 0 && below && can('use_stairs')) return act('use_stairs', {});
      if (down.dist > 0 && can('travel_to')) return act('travel_to', { to: 'stairs_down' });
    }
  }
  // 16. 引数なしの collect が拾いに行く品がある（観測の navigation.collectable。遺物は collect が拾わない。V4-1a §12.1）
  if (p.collect && can('collect') && (obs.navigation.collectable?.count ?? 0) > 0) return act('collect', { what: 'items' });
  // 17. 探索できる所が残っている（目的の階より浅く、下り階段を知らなければ、下への風の方角へ）
  if (can('explore') && (obs.navigation.frontiers.length || (obs.navigation.unsighted ?? 0) > 0)) {
    const toward = (targetDepth === null || depth < targetDepth) && !down && obs.self.floor?.draft ? { toward: 'draft' } : {};
    return act('explore', { pickup: p.collect ? 'useful' : false, ...toward });
  }
  // 18. 何も残っていない。移動の道具が断られて残らなかったなら、その理由（refused_<code>）で起こす。
  //     じゃまをしている敵（エラーの blocked_by）の観測の行を detail の先頭に、ほかの見えている者の行を近い順に後ろに添える（V4-1a §13.8。pilot は自分からは戦わない）
  const rf = ctx.refusal;
  if (rf && rf.code !== 'nothing_to_do') {
    const blockers = (rf.blockedBy ?? []).map((id) => lineWith(ctx.text, id));
    const near = [...obs.visible.monsters].filter((m) => !rf.blockedBy?.includes(m.id)).sort((a, b) => a.dist - b.dist).map((m) => lineWith(ctx.text, m.id));
    return wake(W(`refused_${rf.code}`, `refused:${rf.code}:${depth}:${obs.self.pos ? `${obs.self.pos.x},${obs.self.pos.y}` : ''}`, [...blockers, obs.summary, rf.text, ...near].filter(Boolean).join('\n')));
  }
  return wake(W('nothing_to_do', `nothing_to_do:${depth}`, rf ? `${obs.summary}\n${rf.text}` : obs.summary));
}

/** マクロの止まり方（interrupted_by）のうち、表を上から見直せば済むもの。ここに無い止まり方は起こす（知らないものは unknown_stop） */
export const CONTINUE_STOPS = new Set([
  'hostile_in_view', 'hostile_adjacent', 'hostile_alerted', 'attacked', 'damaged', 'item_seen', 'stairs_seen', 'explored', 'step_limit',
  'arrived', 'collected', 'collect_far', 'chaser_near', 'intent', 'sense_found', 'status_changed', 'floor_changed', 'hp_threshold',
  'hp_floor', 'hp_risk', 'first_hit', 'damage_taken', 'max_turns', 'full_hp', 'rest_cap', 'target_hp', 'hit_while_waiting', 'shot_while_waiting',
]);
/** 知っている止まり方（起こすときは、その名前を理由にする） */
export const KNOWN_STOPS = new Set([
  ...CONTINUE_STOPS, 'unreachable', 'unknown_destination', 'not_your_turn', 'dead', 'run_ended', 'blocked', 'error', 'left_board',
  'target_down', 'target_gone', 'target_moved', 'target_adjacent', 'out_of_ammo', 'no_line_of_sight', 'target_not_approaching', 'target_not_hunting',
  'not_throwable', 'ability_unknown', 'ability_not_allowed', 'ability_needs_with', 'trap_ahead', 'target_fled', 'cleared', 'hit_and_run',
  'target_shooting', 'no_progress',
]);

/**
 * 道具を使った後に起こすか。fight は「倒した」（target_down・cleared）以外で止まったら起こす。
 * ほかの道具は CONTINUE_STOPS なら続け、知っている止まり方ならその名前で、知らない止まり方は unknown_stop で起こす
 */
export function afterAction(tool: string, stop: string | undefined): { wake: false } | { wake: true; reason: string } {
  if (!stop) return { wake: false };
  if (tool === 'fight') return stop === 'target_down' || stop === 'cleared' ? { wake: false } : { wake: true, reason: KNOWN_STOPS.has(stop) ? `fight_${stop}` : 'unknown_stop' };
  if (CONTINUE_STOPS.has(stop)) return { wake: false };
  return { wake: true, reason: KNOWN_STOPS.has(stop) ? stop : 'unknown_stop' };
}

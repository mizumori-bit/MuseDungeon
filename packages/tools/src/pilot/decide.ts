// pilot の判断（IMPROVEMENTS_V4 §10.4〜§10.6、§14 で見直し）。観測の構造化された項目（alerts・visible・navigation・expedition・camp）と、
// pilot 自身の記録（PilotMemory: 歩いた跡・同じ相手に倒す前に止まった回数・相手にしない敵・立て直しの段）だけから決める純粋な関数。
// 規則の知識（種族の名前や数値）は持たない。決められることは決めて知らせ（notify）、AI にしか決められないことだけ起こす（wake。§14.0）。
// #3（rev の読み直し）と #4（queue）は呼ぶ側（pilot.ts）が先に済ませる。
import type { ObsMonster, Observation, Pos } from '@muse/shared';
import type { PilotOrders, PilotPolicy } from './orders';

export type WakeLevel = 'wake' | 'notify';
/** key: 同じ理由・同じ相手で何度も起こさないための鍵（AI が返事をしたら、その条件が続く間は起こさない） */
export interface Wake {
  level: WakeLevel; reason: string; key: string; detail: string;
  /** 一緒に返事をもらったことにする鍵（いっぺんに見えた遺物をまとめて 1 回で起こすとき） */
  also?: string[];
}

export type Decision =
  /** 道具を 1 つ使う */
  | { kind: 'act'; tool: string; args: Record<string, unknown> }
  /** 起こす（返事を待つ間は持ち場の動き。§14.4） */
  | { kind: 'wake'; wake: Wake }
  /** 何もしない（ソロで起こして待つ間、追ってくる敵も被害も無い） */
  | { kind: 'idle' }
  /** pilot を終える（ランが終わった） */
  | { kind: 'end'; wake: Wake };

/** pilot 自身の記録（観測ではない。pilot.ts が手番ごとに更新する。階を移ると、立て直しの段と階段の記録のほかは数え直す） */
export interface PilotMemory {
  /** この階で、命令の後に立っていたマス（古い順） */
  trail: Pos[];
  /** 相手ごとの、倒す前に止まった・断られた回数（この階。§14.2） */
  stops: Record<string, number>;
  /** approach: auto で、寄ってやり直す相手（離れて撃ってくる・寄ってこない。§14.2） */
  advance: string[];
  /** 相手にしない敵（この階で諦めた敵と、AI が ignore に書いた敵。§14.2・§14.6） */
  ignored: string[];
  /** 立て直しの段の途中（HP が減った・fight が hp_floor で止まった・断られた・steady が被害で止まった。§14.3） */
  recovering: boolean;
  /** 立て直しで階を移った: 戻るときに使う階段（移った先の、着いた階段の種類） */
  crossed: 'up' | 'down' | null;
  /** この階（この遠征）で、立て直しで階段へ退いた回数（2 回まで） */
  stairRetreats: number;
  /** 隣でない相手から被害を受けてから過ぎた手番（受けていなければ null。§14.4） */
  hurtFarAgo: number | null;
}

export function newMemory(): PilotMemory {
  return { trail: [], stops: {}, advance: [], ignored: [], recovering: false, crossed: null, stairRetreats: 0, hurtFarAgo: null };
}

export interface DecideContext {
  orders: PilotOrders;
  coop: boolean;
  /** 起こして返事（orders の rev の変化）を待っている */
  waiting: boolean;
  /** 起こしてから hold_max_turns が過ぎた: 帰る側へ倒す（§14.4） */
  homeward?: boolean;
  /** AI が返事をした起こし方の鍵 */
  acked: ReadonlySet<string>;
  /** 観測の文（wake.detail には該当する行をそのまま使う） */
  text: string;
  /** この手番で断られた道具と、断られた fight の相手（表の次の行へ進む） */
  refused?: ReadonlySet<string>;
  refusedTargets?: ReadonlySet<string>;
  /** 最後に断られたときのエラーの code と文と、じゃまをしている見えている敵（details.blocked_by。何も残っていないとき、#18 の理由と detail に使う） */
  refusal?: { code: string; text: string; blockedBy?: readonly string[] } | null;
  /** この遠征のこの階で、もう知らせた鍵（目的でない遺物・役割のある敵・追ってくる敵が多い は 1 回だけ知らせる） */
  notified?: ReadonlySet<string>;
  /** pilot 自身の記録（省くと空） */
  mem?: PilotMemory;
}

/**
 * decide の結果と、いま成り立っている起こし方の鍵（成り立たなくなった鍵は、返事をした記録から外す）。
 * notify: 止まらずに知らせるもの。decision の前に知らせる。update: pilot の記録に書き込むこと
 */
export interface DecideResult { decision: Decision; active: string[]; notify: Wake[]; update?: Partial<PilotMemory> }

/** 断られたら、起こさずに表の次の行へ進む道具（その手番の間だけ外す） */
export const MOVE_TOOLS = new Set(['collect', 'explore', 'travel_to', 'use_stairs', 'rest', 'move', 'attack']);

/** pilot が自分から使う道具（§10.4・§14。queue は除く） */
export const PILOT_TOOLS = new Set(['observe', 'explore', 'travel_to', 'collect', 'fight', 'wait', 'rest', 'use_stairs', 'extract', 'use_item', 'attack', 'move', 'start_expedition', 'choose_perk', 'choose_boon']);

const hpPct = (obs: Observation) => Math.floor((obs.self.hp * 100) / Math.max(1, obs.self.max_hp));
const alert = (obs: Observation, code: string) => obs.alerts.find((a) => a.code === code);
/** 観測の文のうち、needle を含む最初の行（無ければ fallback） */
export function lineWith(text: string, needle: string, fallback = ''): string {
  if (!needle) return fallback;
  return text.split('\n').find((l) => l.includes(needle))?.trim() ?? fallback;
}

/** 役割のある敵（守護者・大守護者・名前付きの強敵・賞金首） */
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
/** 隣にいる起きている敵（近い順） */
function adjacentAwake(obs: Observation): ObsMonster[] {
  return obs.visible.monsters.filter((m) => m.dist <= 1 && m.awareness !== 'asleep').sort((a, b) => a.dist - b.dist);
}
/** 隣にいて追ってきている敵（身を守るために殴る相手。気づいていない敵には、自分からは挑まない: V4-1a §13.8） */
function adjacentHunting(obs: Observation): ObsMonster[] {
  return obs.visible.monsters.filter((m) => m.dist <= 1 && m.awareness === 'hunting').sort((a, b) => a.dist - b.dist);
}
const cheb = (a: Pos, b: Pos) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
const onStairs = (obs: Observation, type?: 'up' | 'down') => obs.navigation.known_stairs.find((s) => s.dist === 0 && (!type || s.type === type) && !(s.type === 'down' && s.sealed));
const nearestStairs = (obs: Observation) => obs.navigation.known_stairs.filter((s) => s.reachable).sort((a, b) => (a.path_len ?? a.dist) - (b.path_len ?? b.dist))[0];

/**
 * 帰還の綱を持っているか。短い観測では所持品が文だけなので、遠征の戦利品の「綱なら今これだけ確定する」（綱を持っているときだけある）で見る
 */
export function hasLifeline(obs: Observation): boolean {
  return (obs.self.inventory ?? []).some((i) => i.kind === 'core:lifeline') || obs.expedition?.haul?.if_lifeline_now !== undefined;
}

/** 知っている階段までの見込み（観測の escape）が「着ける」: 追われたままの最悪の被害が分かっていて、HP より小さい */
function escapeStairs(obs: Observation): 'up' | 'down' | null {
  const esc = alert(obs, 'escape')?.data as { stairs?: 'up' | 'down'; worst_if_chased?: number | null; hp?: number } | undefined;
  return esc?.stairs && typeof esc.worst_if_chased === 'number' && typeof esc.hp === 'number' && esc.worst_if_chased < esc.hp ? esc.stairs : null;
}

/** 退く（§10.6）。できる手が無ければ null */
export function retreat(obs: Observation, p: PilotPolicy): { tool: string; args: Record<string, unknown> } | null {
  const x = obs.expedition;
  if (alert(obs, 'on_stairs') && p.allow_extract && x?.can_extract) return { tool: 'extract', args: x.extract_outcome === 'complete' ? {} : { confirm: true } };
  if (p.allow_lifeline && hasLifeline(obs)) return { tool: 'use_item', args: { slot: 'lifeline' } };
  // 階段の上なら、階を移る（モンスターは階を移らない。§14.3）
  if (onStairs(obs)) return { tool: 'use_stairs', args: {} };
  const esc = escapeStairs(obs);
  if (esc) return { tool: 'travel_to', args: { to: `stairs_${esc}`, mode: 'flee' } };
  return null;
}

/** 来た道を戻る先（§14.3 の 4）: 歩いた跡のうち、いまのマスから 6 マス以上離れた最も新しいマス。無ければ最も離れたマス（2 マス以上） */
export function backtrackTarget(obs: Observation, mem: PilotMemory): Pos | null {
  const here = obs.self.pos;
  if (!here) return null;
  for (let i = mem.trail.length - 1; i >= 0; i--) if (cheb(mem.trail[i]!, here) >= 6) return mem.trail[i]!;
  let best: Pos | null = null;
  for (const t of mem.trail) if (cheb(t, here) >= 2 && (!best || cheb(t, here) > cheb(best, here))) best = t;
  return best;
}

/** 見えている仲間のうち、いちばん近い隣でない者 */
function farAlly(obs: Observation) {
  return (obs.visible.players ?? []).filter((pl) => pl.dist > 1).sort((a, b) => a.dist - b.dist)[0];
}

/**
 * 離れる・寄るときの進み方: 追われていても進む（flee）。HP の下限は、見えている追跡中の敵の 1 手番の最悪の被害（観測の worst_turn）の合計の 2 倍
 * （最大 HP の 4 分の 1 より下げない・今の HP より 1 少ない所まで）。何体にも撃たれながら逃げて、1 回の呼び出しの中で倒れたため（V4-1b の計測）。
 * 止まれば、次の判断で退くか起こす
 */
export function fleeArgs(obs: Observation): { mode: 'flee'; hp_floor: number } {
  const incoming = obs.visible.monsters.filter((m) => m.awareness === 'hunting' && !m.fleeing).reduce((a, m) => a + (m.worst_turn ?? 0), 0);
  return { mode: 'flee', hp_floor: Math.max(0, Math.min(obs.self.hp - 1, Math.max(Math.floor(obs.self.max_hp / 4), incoming * 2))) };
}

/** 離れる（§14.3 の 3・4）: 協力プレイで仲間が見えていれば仲間の隣へ、そうでなければ来た道を戻る */
function moveAway(obs: Observation, ctx: DecideContext, mem: PilotMemory): { tool: string; args: Record<string, unknown> } | null {
  const ally = ctx.coop ? farAlly(obs) : undefined;
  if (ally) return { tool: 'travel_to', args: { to: ally.id, ...fleeArgs(obs) } };
  const back = backtrackTarget(obs, mem);
  if (back) return { tool: 'travel_to', args: { to: { x: back.x, y: back.y }, ...fleeArgs(obs) } };
  return null;
}

/**
 * 起こして待つ間・mode: hold の動き（§14.4。§10.5 を置き換える）。毎手番すぐに答える。null は何もしない（ソロで待つだけ）。
 * homeward: hold_max_turns が過ぎた。知っている階段へ行き、allow_extract なら帰る。帰れなければ階段の上で待つ
 */
export function holdAction(obs: Observation, ctx: DecideContext): { tool: string; args: Record<string, unknown> } | null {
  const p = ctx.orders.policy;
  const mem = ctx.mem ?? newMemory();
  const can = (tool: string) => !ctx.refused?.has(tool);
  const idle = () => (ctx.coop ? { tool: 'wait', args: {} } : null);
  if (alert(obs, 'lethal_range') || alert(obs, 'critical_hp')) {
    const r = retreat(obs, p);
    if (r && can(r.tool)) return r;
  }
  const adj = adjacentHunting(obs)[0];
  if (adj && can('attack')) return { tool: 'attack', args: { target: adj.id } };
  if (ctx.homeward) {
    const x = obs.expedition;
    if (alert(obs, 'on_stairs') && p.allow_extract && x?.can_extract && can('extract')) return { tool: 'extract', args: x.extract_outcome === 'complete' ? {} : { confirm: true } };
    const near = nearestStairs(obs);
    if (near && near.dist > 0 && can('travel_to')) return { tool: 'travel_to', args: { to: `stairs_${near.type}`, ...fleeArgs(obs) } };
    return idle();
  }
  // この数手番に隣でない相手から被害を受けた・追ってくる敵が見えている: 同じ場所に留まらない
  const hurtFar = mem.hurtFarAgo !== null && mem.hurtFarAgo <= 2;
  if ((hurtFar || chasers(obs).length > 0) && can('travel_to')) {
    const m = moveAway(obs, ctx, mem);
    if (m) return m;
  }
  return idle();
}

/** pilot の fight の引数: hp_floor は wake_hp_pct、寄り方は方針（auto なら、寄ってやり直すと決めた相手だけ advance） */
export function fightArgs(obs: Observation, p: PilotPolicy, mem: PilotMemory, id: string): Record<string, unknown> {
  const advance = p.approach === 'advance' || (p.approach === 'auto' && mem.advance.includes(id));
  return { target: id, hp_floor: Math.floor((obs.self.max_hp * p.wake_hp_pct) / 100), ...(advance ? { approach: 'advance' } : {}) };
}

export function decide(obs: Observation, ctx: DecideContext): DecideResult {
  const p = ctx.orders.policy;
  const mem = ctx.mem ?? newMemory();
  const active: string[] = [];
  const W = (reason: string, key: string, detail: string, level: WakeLevel = 'wake'): Wake => ({ level, reason, key, detail });
  /** 起こし方の鍵が、まだ返事をもらっていないか（成り立っている鍵は active に積む） */
  const fresh = (key: string) => { if (!active.includes(key)) active.push(key); return !ctx.acked.has(key); };
  const notify: Wake[] = [];
  let update: Partial<PilotMemory> | undefined;
  const upd = (u: Partial<PilotMemory>) => { update = { ...(update ?? {}), ...u }; };
  const out = (decision: Decision): DecideResult => ({ decision, active, notify, ...(update ? { update } : {}) });
  const act = (tool: string, args: Record<string, unknown>) => out({ kind: 'act', tool, args });
  const wake = (w: Wake) => { if (!active.includes(w.key)) active.push(w.key); return out({ kind: 'wake', wake: w }); };
  /** 同じ階にいる間に 1 回だけ知らせる */
  const noteOnce = (w: Wake) => { if (!ctx.notified?.has(w.key)) notify.push(w); };
  const x = obs.expedition;
  const can = (tool: string) => !ctx.refused?.has(tool);
  const ignored = new Set(mem.ignored);
  const pct = hpPct(obs);

  // 1. ランが終わった
  if (obs.status === 'ended' || obs.status === 'dead') return out({ kind: 'end', wake: W('ended', 'ended', obs.summary) });
  // 2. キャンプ: その枠の候補で自動で出発するか、起こす（遠征のレポートの要点を添える）。起こして返事を待っている間は、何もしない
  if (obs.status === 'at_camp' && ctx.waiting) return out({ kind: 'idle' });
  if (obs.status === 'at_camp') {
    const slot = ctx.orders.camp.auto_start;
    const offer = slot ? obs.camp?.offers.find((o) => o.slot === slot) : undefined;
    if (offer) return act('start_expedition', { offer: offer.index });
    // detail: 遠征のレポートの要点と、候補の文（観測の文のまま。番号は start_expedition の offer）
    return wake(W('camp', `camp:${obs.camp?.next_no ?? ''}`, [x?.result?.text ?? obs.summary, ...(obs.camp?.offers ?? []).map((o) => `${o.index}. ${o.text}`)].join('\n')));
  }
  // いま成り立っている条件の鍵を、表のどの行で決まるかに関わらず先に数える（成り立たなくなった鍵だけが、返事をした記録から外れる）
  for (const code of ['perk_pending', 'boon_pending']) { const a = alert(obs, code); if (a) active.push(`${code}:${JSON.stringify(a.data ?? '')}`); }
  for (const m of obs.visible.monsters.filter(isRoleEnemy)) active.push(`${roleReason(m)}:${m.id}`);
  for (const it of obs.visible.items.filter((i) => i.role === 'relic')) active.push(`relic_seen:${it.id}`);
  if (x?.status === 'objective_complete') active.push(`objective_done:${x.no}`);
  // 5. 起こして待っている・mode: hold: 持ち場の動き（§14.4）
  if (ctx.orders.mode === 'hold' || ctx.waiting) {
    const h = holdAction(obs, ctx);
    return h ? act(h.tool, h.args) : out({ kind: 'idle' });
  }
  // 6. 特技・加護の選択: perk: first なら最初の候補を選ぶ（手番を使わない）。そうでなければ起こす
  for (const code of ['perk_pending', 'boon_pending'] as const) {
    const a = alert(obs, code);
    if (!a) continue;
    const tool = code === 'perk_pending' ? 'choose_perk' : 'choose_boon';
    if (p.perk === 'first' && can(tool)) return act(tool, { option: 1 });
    const key = `${code}:${JSON.stringify(a.data ?? '')}`;
    if (fresh(key)) return wake(W(code, key, a.text));
  }
  // 7. 危ない（lethal_range・critical_hp）: 退いて知らせる。退く手が無ければ起こす（§14.3 の 5）
  const danger = alert(obs, 'lethal_range') ?? alert(obs, 'critical_hp');
  if (danger) {
    const r = retreat(obs, p);
    const key = `danger:${obs.self.hp}:${obs.seq}`;
    if (r && can(r.tool)) {
      notify.push(W('danger', key, danger.text, 'notify'));
      if (r.tool === 'use_stairs') upd({ crossed: onStairs(obs)?.type === 'up' ? 'down' : 'up' });
      return act(r.tool, r.args);
    }
    fresh(key);
    return wake(W('danger', key, danger.text));
  }
  const ch = chasers(obs);
  const activeCh = ch.filter((m) => !ignored.has(m.id));
  // 8. 立て直しの段（§14.3）: HP が wake_hp_pct を切った、または fight が hp_floor で止まった・断られた、steady が被害で止まった
  const needRecovery = pct < p.wake_hp_pct || mem.recovering;
  if (needRecovery) {
    if (mem.recovering && pct >= p.rest_below_pct && !activeCh.length) upd({ recovering: false });
    else {
      if (!mem.recovering) { upd({ recovering: true }); notify.push(W('recovering', `recovering:${obs.seq}`, alert(obs, 'low_hp')?.text ?? obs.summary, 'notify')); }
      // 1) 追ってくる敵が見えていない: 休む
      if (!ch.length && can('rest')) return act('rest', {});
      // 2) 知っている階段へ「着ける」: 階段へ行き、階を移って休む（モンスターは階を移らない）。同じ階で 2 回まで。
      //    協力プレイの既定は「仲間を置いていかない」: 仲間が見えている間は使わない（見えていなければ使う）
      const viaStairs = p.retreat_via_stairs ?? (!ctx.coop || !farAlly(obs) && !(obs.visible.players ?? []).length);
      if (ch.length && viaStairs && mem.stairRetreats < 2) {
        const st = onStairs(obs);
        if (st && can('use_stairs')) { upd({ crossed: st.type === 'up' ? 'down' : 'up', stairRetreats: mem.stairRetreats + 1 }); return act('use_stairs', {}); }
        const esc = escapeStairs(obs);
        if (esc && can('travel_to')) return act('travel_to', { to: `stairs_${esc}`, ...fleeArgs(obs) });
      }
      // 隣に起きている敵がいて、階段へも仲間へも行けない: 殴る（離れても付いてくる。来た道を戻るのは、離れて撃たれているとき）
      const adj = adjacentHunting(obs).filter((m) => !isRoleEnemy(m) || m.objective)[0];
      const ally = ctx.coop ? farAlly(obs) : undefined;
      if (adj && !ally && can('attack')) return act('attack', { target: adj.id });
      // 3) 4) 仲間の隣へ寄る・来た道を戻る
      if (can('travel_to')) {
        const m = moveAway(obs, ctx, mem);
        if (m) return act(m.tool, m.args);
      }
      // 5) どれもできない: 退く。それもできなければ起こす
      const r = retreat(obs, p);
      if (r && can(r.tool)) return act(r.tool, r.args);
      const key = `danger:recovery:${obs.self.hp}:${obs.seq}`;
      fresh(key);
      return wake(W('danger', key, alert(obs, 'low_hp')?.text ?? obs.summary));
    }
  }
  // 立て直しで階を移って休んだ: 戻る
  if (mem.crossed && !activeCh.length && pct >= p.rest_below_pct) {
    if (onStairs(obs, mem.crossed) && can('use_stairs')) { upd({ crossed: null }); return act('use_stairs', {}); }
    if (can('travel_to') && obs.navigation.known_stairs.some((s) => s.type === mem.crossed && s.reachable)) return act('travel_to', { to: `stairs_${mem.crossed}` });
    upd({ crossed: null });
  }
  // 9. 役割のある敵が見えている。この遠征の目的の相手なら起こす（engage_objective なら起こさずに挑む）。目的でなければ同じ階で 1 回知らせる
  for (const m of obs.visible.monsters.filter(isRoleEnemy).sort((a, b) => a.dist - b.dist)) {
    const reason = roleReason(m);
    const key = `${reason}:${m.id}`;
    if (!m.objective) { noteOnce(W(reason, key, lineWith(ctx.text, m.id, m.name), 'notify')); continue; }
    if (p.engage_objective) {
      if (ctx.refusedTargets?.has(m.id) || ignored.has(m.id)) continue;
      notify.push(W(reason, `${key}:engage:${obs.seq}`, lineWith(ctx.text, m.id, m.name), 'notify'));
      return act('fight', fightArgs(obs, p, mem, m.id));
    }
    if (fresh(key)) return wake(W(reason, key, lineWith(ctx.text, m.id, m.name)));
  }
  // 10. 遺物。目的の遺物なら起こす（engage_objective なら起こさずに拾いに行く）。目的でない遺物は同じ階で 1 回知らせる
  const others = obs.visible.items.filter((i) => i.role === 'relic' && !i.objective && !ctx.notified?.has(`relic_seen:${i.id}`)).sort((a, b) => a.dist - b.dist);
  if (others.length) {
    const n = W('relic_seen', `relic_seen:${others[0]!.id}`, others.map((it) => lineWith(ctx.text, it.id, it.name)).join('\n'), 'notify');
    if (others.length > 1) n.also = others.slice(1).map((it) => `relic_seen:${it.id}`);
    notify.push(n);
  }
  const objRelics = obs.visible.items.filter((i) => i.role === 'relic' && i.objective).sort((a, b) => a.dist - b.dist);
  if (objRelics.length && p.engage_objective && can('travel_to')) {
    const it = objRelics[0]!;
    notify.push(W('relic_seen', `relic_seen:${it.id}:engage:${obs.seq}`, lineWith(ctx.text, it.id, it.name), 'notify'));
    return act('travel_to', { to: it.id });
  }
  const relics = objRelics.filter((it) => fresh(`relic_seen:${it.id}`));
  if (relics.length && !p.engage_objective) {
    const w = W('relic_seen', `relic_seen:${relics[0]!.id}`, relics.map((it) => lineWith(ctx.text, it.id, it.name)).join('\n'));
    if (relics.length > 1) w.also = relics.slice(1).map((it) => `relic_seen:${it.id}`);
    return wake(w);
  }
  // 11. 追ってくる敵が多い（相手にしない敵は数えない）・戦わない方針で追われている: 知らせるだけ（§14.1）
  if (activeCh.length > p.max_chasers) noteOnce(W('too_many', 'too_many', alert(obs, 'enemy_adjacent')?.text ?? alert(obs, 'enemy_in_view')?.text ?? obs.summary, 'notify'));
  if (!p.fight && activeCh.length) noteOnce(W('chased', 'chased', alert(obs, 'enemy_in_view')?.text ?? obs.summary, 'notify'));
  // 相手にしない敵でも、起きていて隣にいるなら殴る（§14.2）
  const adjIgnored = adjacentAwake(obs).find((m) => ignored.has(m.id));
  if (adjIgnored && can('attack')) return act('attack', { target: adjIgnored.id });
  // 12. 追ってくる役割の無い敵と戦う（相手にしない敵・この手番に断られた相手を除く）
  const target = p.fight ? activeCh.filter((m) => !isRoleEnemy(m) && !ctx.refusedTargets?.has(m.id)).sort((a, b) => a.dist - b.dist)[0] : undefined;
  if (target) return act('fight', fightArgs(obs, p, mem, target.id));
  // 13. 敵がいなくて HP が rest_below_pct を切っている: 休む
  if (!ch.length && pct < p.rest_below_pct && can('rest')) return act('rest', {});
  const depth = obs.self.floor?.depth ?? 0;
  const targetDepth = x?.objective.target_depth ?? null;
  const stairs = obs.navigation.known_stairs.filter((s) => s.reachable);
  // 封じられた下り階段（大守護者を倒していない節目の階。V4-1a §12.4）へは下りに行かない
  const down = stairs.find((s) => s.type === 'down' && !s.sealed);
  // 相手にしない敵が見えている間は、被害を受けても止まらない進み方（§14.2）
  const steady = obs.visible.monsters.some((m) => ignored.has(m.id)) ? { mode: 'steady' } : {};
  // 14. 帰る（目的を果たした後の既定・mode: stop_at_camp）。after_objective: wake なら起こす、continue なら先へ
  const complete = x?.status === 'objective_complete';
  const homeward = ctx.orders.mode === 'stop_at_camp' || (complete && p.after_objective === 'extract');
  if (complete && p.after_objective === 'wake' && ctx.orders.mode !== 'stop_at_camp') {
    const key = `objective_done:${x!.no}`;
    if (fresh(key)) return wake(W('objective_done', key, x!.text));
  }
  if (homeward && x) {
    if (x.can_extract && can('extract')) return act('extract', x.extract_outcome === 'complete' ? {} : { confirm: true });
    if (ctx.orders.mode === 'stop_at_camp' && p.allow_lifeline && hasLifeline(obs) && can('use_item')) return act('use_item', { slot: 'lifeline' });
    const near = [...stairs].sort((a, b) => (a.path_len ?? a.dist) - (b.path_len ?? b.dist))[0];
    if (near && can('travel_to')) return act('travel_to', { to: `stairs_${near.type}`, ...steady });
  }
  // 帰りたいのに、着ける階段をまだ知らない: 階段を探して探索する（#17）
  const seekStairs = homeward && !stairs.length;
  // 15. 目的の階へ向かう。目的の階より深い所から始まった遠征（前の遠征で止まった階段から再開する）なら、上り階段で上がる
  if (p.descend && x && !homeward && x.status === 'in_progress' && targetDepth !== null && depth > targetDepth) {
    const up = stairs.find((s) => s.type === 'up');
    if (up) {
      if (up.dist === 0 && can('use_stairs')) return act('use_stairs', {});
      if (up.dist > 0 && can('travel_to')) return act('travel_to', { to: 'stairs_up', ...steady });
    }
  }
  //     目的の階へ下りる（目的が「踏破」なら、目的の階の下り階段に着くまで。continue なら目的の後も下りる）
  if (p.descend && x && !homeward && (x.status === 'in_progress' || (complete && p.after_objective === 'continue'))) {
    const below = targetDepth === null || depth < targetDepth || complete;
    const crossing = x.objective.type === 'reach_depth' && targetDepth !== null && depth === targetDepth;
    if ((below || crossing) && down) {
      if (down.dist === 0 && below && can('use_stairs')) return act('use_stairs', {});
      if (down.dist > 0 && can('travel_to')) return act('travel_to', { to: 'stairs_down', ...steady });
    }
  }
  // 16. 引数なしの collect が拾いに行く品がある（観測の navigation.collectable。遺物は collect が拾わない。V4-1a §12.1）
  if (!homeward && p.collect && can('collect') && (obs.navigation.collectable?.count ?? 0) > 0) return act('collect', { what: 'items', ...steady });
  // 17. 探索できる所が残っている（目的の階より浅く、下り階段を知らなければ、下への風の方角へ）
  if ((!homeward || seekStairs) && can('explore') && (obs.navigation.frontiers.length || (obs.navigation.unsighted ?? 0) > 0)) {
    const toward = (targetDepth === null || depth < targetDepth) && !down && obs.self.floor?.draft ? { toward: 'draft' } : {};
    return act('explore', { pickup: p.collect ? 'useful' : false, ...toward, ...steady });
  }
  // 18. 何も残っていない。命令が断られて残らなかったなら、その理由（refused_<code>）で起こす。
  //     じゃまをしている敵（エラーの blocked_by）の観測の行を detail の先頭に、ほかの見えている者の行を近い順に後ろに添える（V4-1a §13.8。pilot は自分からは戦わない）
  const rf = ctx.refusal;
  if (rf && rf.code !== 'nothing_to_do') {
    const blockers = (rf.blockedBy ?? []).map((id) => lineWith(ctx.text, id));
    const near = [...obs.visible.monsters].filter((m) => !rf.blockedBy?.includes(m.id)).sort((a, b) => a.dist - b.dist).map((m) => lineWith(ctx.text, m.id));
    return wake(W(`refused_${rf.code}`, `refused:${rf.code}:${depth}:${obs.self.pos ? `${obs.self.pos.x},${obs.self.pos.y}` : ''}`, [...blockers, obs.summary, rf.text, ...near].filter(Boolean).join('\n')));
  }
  return wake(W('nothing_to_do', `nothing_to_do:${depth}`, rf ? `${obs.summary}\n${rf.text}` : obs.summary));
}

/** マクロの止まり方（interrupted_by）のうち、表を上から見直せば済むもの */
export const CONTINUE_STOPS = new Set([
  'hostile_in_view', 'hostile_adjacent', 'hostile_alerted', 'attacked', 'damaged', 'item_seen', 'stairs_seen', 'explored', 'step_limit',
  'arrived', 'collected', 'collect_far', 'chaser_near', 'intent', 'sense_found', 'status_changed', 'floor_changed', 'hp_threshold',
  'hp_floor', 'hp_risk', 'first_hit', 'max_turns', 'full_hp', 'rest_cap', 'target_hp', 'hit_while_waiting', 'shot_while_waiting',
  'not_your_turn', 'dead', 'run_ended', 'left_board',
]);
/** 移動のマクロの止まり方のうち、知らせて表を続けるもの（くり返せば行き詰まり stuck になる。§14.1） */
export const NOTIFY_STOPS = new Set(['blocked', 'no_progress', 'unreachable', 'unknown_destination', 'trap_ahead', 'target_gone', 'error']);
/** fight の止まり方（倒した以外は、相手ごとに数えて知らせる） */
export const FIGHT_STOPS = new Set([
  'target_gone', 'target_moved', 'target_adjacent', 'out_of_ammo', 'no_line_of_sight', 'target_not_approaching', 'target_not_hunting',
  'not_throwable', 'ability_unknown', 'ability_not_allowed', 'ability_needs_with', 'target_fled', 'hit_and_run', 'target_shooting',
  'hp_floor', 'hp_risk', 'first_hit', 'hostile_in_view', 'hit_while_waiting', 'shot_while_waiting', 'status_changed', 'intent', 'step_limit',
  'blocked', 'unreachable', 'error', 'not_your_turn', 'dead', 'run_ended', 'left_board', 'floor_changed',
]);
/** approach: auto で、寄ってやり直す止まり方（離れて撃ってくる・寄ってこない。§14.2） */
export const ADVANCE_STOPS = new Set(['target_shooting', 'target_not_approaching']);
/**
 * 「決着しない」止まり方（§14.2 の諦める回数に数える）: 相手が離れる・撃ってくる・寄ってこない・見えなくなる・届かない。
 * HP の止まり方（hp_floor・hp_risk）は立て直しへ回し、割り込み（新しい敵・予備動作・状態異常・初めての被弾）は数えない
 * （隣で噛んでくる群れの敵を、毒と hp_risk の 2 回で諦めて倒れたため。V4-1b の計測）
 */
export const UNSETTLED_STOPS = new Set([
  'target_moved', 'target_shooting', 'target_not_approaching', 'hit_and_run', 'target_gone', 'target_fled', 'no_line_of_sight', 'out_of_ammo',
  'target_adjacent', 'target_not_hunting', 'unreachable', 'blocked', 'step_limit', 'no_target', 'out_of_range',
]);

/** 道具を使った後の扱い（§14.1）。ok: 続ける / notify: 知らせて続ける / fight: 倒す前に止まった（数える）/ recover: 立て直しへ / wake: 起こす */
export type After =
  | { kind: 'ok'; killed?: boolean }
  | { kind: 'notify'; reason: string }
  | { kind: 'fight'; reason: string; recover: boolean; advance: boolean; count: boolean }
  | { kind: 'recover'; reason: string }
  | { kind: 'wake'; reason: string };

export function afterAction(tool: string, stop: string | undefined): After {
  // 協力プレイで、ほかの人の手番を待つ間に止まった（どの道具でも、表を見直すだけ）
  if (!stop || stop === 'waiting_others') return { kind: 'ok' };
  if (tool === 'fight') {
    if (stop === 'target_down' || stop === 'cleared') return { kind: 'ok', killed: true };
    if (!FIGHT_STOPS.has(stop)) return { kind: 'wake', reason: 'unknown_stop' };
    return { kind: 'fight', reason: `fight_${stop}`, recover: stop === 'hp_floor' || stop === 'hp_risk', advance: ADVANCE_STOPS.has(stop), count: UNSETTLED_STOPS.has(stop) };
  }
  // steady が被害で止まった（1 回の呼び出しの被害が最大 HP の 4 分の 1 を超えた）
  if (stop === 'damage_taken') return { kind: 'recover', reason: 'damage_taken' };
  if (CONTINUE_STOPS.has(stop)) return { kind: 'ok' };
  if (NOTIFY_STOPS.has(stop)) return { kind: 'notify', reason: stop };
  return { kind: 'wake', reason: 'unknown_stop' };
}

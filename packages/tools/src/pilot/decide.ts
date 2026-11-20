// pilot の判断（IMPROVEMENTS_V4 §10.4〜§10.6、§14 で見直し）。観測の構造化された項目（alerts・visible・navigation・expedition・camp）と、
// pilot 自身の記録（PilotMemory: 歩いた跡・同じ相手に倒す前に止まった回数・相手にしない敵・立て直しの段）だけから決める純粋な関数。
// 規則の知識（種族の名前や数値）は持たない。決められることは決めて知らせ（notify）、AI にしか決められないことだけ起こす（wake。§14.0）。
// #3（rev の読み直し）と #4（queue）は呼ぶ側（pilot.ts）が先に済ませる。
import type { Dir, ObsMonster, ObsPartyMember, Observation, Pos } from '@muse/shared';
import type { PilotOrders, PilotPolicy } from './orders';

/**
 * notify: 止まらずに知らせる / wake: 起こして返事を待つ（プログラムの返事役が答えてよい）/
 * escalate: 起こして返事を待つ。プログラムの返事役は答えてはいけない（後ろにいる AI か人間へ回す。V4-1e §19.1）
 */
export type WakeLevel = 'wake' | 'notify' | 'escalate';
/** key: 同じ理由・同じ相手で何度も起こさないための鍵（AI が返事をしたら、その条件が続く間は起こさない） */
export interface Wake {
  level: WakeLevel; reason: string; key: string; detail: string;
  /** 一緒に返事をもらったことにする鍵（いっぺんに見えた遺物をまとめて 1 回で起こすとき） */
  also?: string[];
}

export type Decision =
  /**
   * 道具を 1 つ使う。then があれば、使った後に起こす（回復の品を使った後の danger。§16.3）。done があれば、うまくいった後に知らせる
   * （綱を使った lifeline_used。V4-1e §19.4）。relic: 拾いに行く目的でない遺物（pick_relics。着いて拾えたら relic_picked。§19.5）。
   * seek: 目的の相手・品を探す手（V4-1f §22.1。使った手番を seek_max_turns に数える）
   */
  | { kind: 'act'; tool: string; args: Record<string, unknown>; then?: Wake; done?: Wake; relic?: string; seek?: boolean }
  /** 起こす（返事を待つ間は持ち場の動き。§14.4） */
  | { kind: 'wake'; wake: Wake }
  /** 何もしない（ソロで起こして待つ間、追ってくる敵も被害も無い）。wait: party＝キャンプで、仲間が迷宮から戻るのを待つ（V4-1f §22.5） */
  | { kind: 'idle'; wait?: 'party' }
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
  /** 離れたままの相手（fight が target_shooting・target_not_approaching で止まった。最後のやり直しで投げる品を使う。V4-1d §18.2） */
  away: string[];
  /** fight を待つ間に撃ってきた、見えている相手（次の fight の標的にする。V4-1d §18.2） */
  shotBy: string | null;
  /** fight を待つ間に、見えない相手に撃たれた: 1 回、来た道を戻る（立て直しの段の 4。V4-1d §18.2） */
  backOff: boolean;
  /** 拾いに行って拾えなかった目的でない遺物（この階では、もう拾いに行かない。V4-1e §19.5） */
  relicFailed: string[];
  /** 目的の相手・品を探した手番（この遠征のこの階。V4-1f §22.1）と、探す間に立ったマス・着けなかった見回り先 */
  seekTurns: number;
  seekVisited: Pos[];
  patrolFailed: Pos[];
  /** ついていく相手の記録（V4-1f §22.5。遠征ごと。階を移っても残す） */
  follow: FollowMemory | null;
}

/**
 * ついていく相手の記録（V4-1f §22.5）。met: この遠征で同じ階にいたことがある。inDungeon: この遠征で迷宮にいた（その後キャンプなら、帰った）。
 * lastPos: 同じ階で最後に見た位置。floorAtStart・startTurn: 遠征の最初に相手がいた階と、記録を始めた手番（最初に待つ長さを決める）
 */
export interface FollowMemory { id: string; exp: number | null; met: boolean; inDungeon: boolean; lastPos: Pos | null; lastFloor: number | null; floorAtStart: number | null; startTurn: number }

export function newMemory(): PilotMemory {
  return { trail: [], stops: {}, advance: [], ignored: [], recovering: false, crossed: null, stairRetreats: 0, hurtFarAgo: null, away: [], shotBy: null, backOff: false, relicFailed: [], seekTurns: 0, seekVisited: [], patrolFailed: [], follow: null };
}

/** 道をふさいでいる罠（断りのエラーの details.blocked_by_traps。V4-1d §18.1） */
export interface TrapRef { id: string; kind: string; pos: Pos }
/** この手番に、罠にふさがれて断られた道具と、その罠（近い順） */
export interface TrapBlock { tool: string; traps: TrapRef[] }

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
  /** 最後に断られたときのエラーの code と文と、じゃまをしている見えている敵（details.blocked_by）・罠（details.blocked_by_traps）。何も残っていないとき、#18 の理由と detail に使う */
  refusal?: { code: string; text: string; blockedBy?: readonly string[]; traps?: readonly TrapRef[] } | null;
  /** この手番に罠にふさがれて断られた（step_on_traps なら踏む。V4-1d §18.1） */
  trapBlock?: TrapBlock | null;
  /** 分類が「投げる武器」の品の種類（公開カタログの分類。種類 ID と、名前空間を外した ID。V4-1d §18.2） */
  throwKinds?: ReadonlySet<string>;
  /**
   * ランを通して 1 回だけの鍵（pilot の --dir の memory.json に残る。V4-1e §19.2・§19.5）: 上げた大守護者（warden_decision:<階>）、
   * 知らせた目的でない遺物（relic_seen:<ID>）・守護者・強敵（seen:<ID>）
   */
  once?: ReadonlySet<string>;
  /** 空回り（直近の遠征がどれも空だった。§19.3）: キャンプで上げる detail（pilot.ts が history.jsonl から決める） */
  stalled?: string | null;
  /** 大守護者の階ごとの、それまでに挑んだ遠征の数（history.jsonl から。§19.2 の detail） */
  wardenTries?: Readonly<Record<string, number>>;
  /** この階で、pilot がこれまでに立ったマス（遠征をまたいだ pilot の記録。見回りの行き先。V4-1f §22.1） */
  walked?: readonly Pos[];
  /** いまの手番の通番（遠征の最初に仲間を待つ長さ。V4-1f §22.5） */
  turnNo?: number;
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
export const PILOT_TOOLS = new Set(['observe', 'explore', 'travel_to', 'collect', 'fight', 'wait', 'rest', 'use_stairs', 'extract', 'use_item', 'use_ability', 'attack', 'move', 'start_expedition', 'choose_perk', 'choose_boon']);

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
const DIR_OF: Record<string, Dir> = { '0,-1': 'n', '1,-1': 'ne', '1,0': 'e', '1,1': 'se', '0,1': 's', '-1,1': 'sw', '-1,0': 'w', '-1,-1': 'nw' };
/** a から b への 8 方位（同じマスなら null） */
export function dirTo(a: Pos, b: Pos): Dir | null {
  return DIR_OF[`${Math.sign(b.x - a.x)},${Math.sign(b.y - a.y)}`] ?? null;
}
/**
 * 道をふさいでいる罠の行（起こす・知らせるときの detail の先頭。V4-1d §18.1）: 観測の文の行（無ければ名前・ID・位置）と、自分から見た方角・距離
 */
export function trapLines(obs: Observation, text: string, traps: readonly TrapRef[]): string[] {
  const here = obs.self.pos;
  return traps.map((tr) => {
    const f = obs.visible.features.find((x) => x.id === tr.id);
    const line = lineWith(text, tr.id).replace(/^-\s*/, '') || `${f?.name ?? tr.kind} ${tr.id} (${tr.pos.x},${tr.pos.y})`;
    const d = here ? dirTo(here, tr.pos) : null;
    const dist = here ? cheb(here, tr.pos) : null;
    return `道をふさぐ罠: ${line}${d ? `（方角 ${d}・${dist === 1 ? '隣' : `${dist} マス`}）` : ''}`;
  });
}
/**
 * 投げる品（V4-1d §18.2）: 観測の self.attack.throws のうち、公開カタログの分類が「投げる武器」の品の種類（重ねず、4 つまで）。
 * 品の名前では探さない。薬など、ほかの分類の品は投げない
 */
export function throwKindsOf(obs: Observation, kinds: ReadonlySet<string> | undefined): string[] {
  if (!kinds?.size) return [];
  const out: string[] = [];
  for (const tw of obs.self.attack.throws ?? []) if (tw.kind && kinds.has(tw.kind) && !out.includes(tw.kind)) out.push(tw.kind);
  return out.slice(0, 4);
}
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

/** 退く（§10.6）。順は階段の上で帰る → 階段の上なら階を移る → 着ける階段へ → 綱（V4-1e §19.4）。できる手が無ければ null。why: 綱を使うときの理由（lifeline_used の detail） */
export function retreat(obs: Observation, p: PilotPolicy): { tool: string; args: Record<string, unknown>; why?: string } | null {
  const x = obs.expedition;
  if (alert(obs, 'on_stairs') && p.allow_extract && x?.can_extract) return { tool: 'extract', args: x.extract_outcome === 'complete' ? {} : { confirm: true } };
  // 階段の上なら、階を移る（モンスターは階を移らない。§14.3）
  if (onStairs(obs)) return { tool: 'use_stairs', args: {} };
  // 知っている階段へ「着ける」（観測の escape）なら、綱より先に階段へ（V4-1e §19.4: 綱を先に使わない。今までは allow_lifeline なら綱が先だった）
  const esc = escapeStairs(obs);
  if (esc) return { tool: 'travel_to', args: { to: `stairs_${esc}`, ...fleeArgs(obs) } };
  // 危ないのに、階段へ着けない: 綱（§19.4 の 2）
  if (p.allow_lifeline && hasLifeline(obs)) return { tool: 'use_item', args: { slot: 'lifeline' }, why: `危なくて、知っている階段へ着けない（観測の escape）: ${(alert(obs, 'lethal_range') ?? alert(obs, 'critical_hp'))?.text ?? obs.summary}` };
  return null;
}

/**
 * 帰る（V4-1e §19.4。mode: return・stop_at_camp・after_objective: extract・待つ間の no_reply・under_fire で共通）:
 * 1) 階段の上なら帰る（全額が確定）2) 知っている階段へ行く（追われていれば、観測の escape で「着ける」ときだけ。flee）
 * 3) 着けない（追われたままでは着けない・知っている階段へ道が無い）なら、allow_lifeline のとき綱（半分が確定。why に理由）
 * 4) 追われていて綱も無ければ、それでも階段へ向かう（今までどおり）。null: 知っている階段が無い（呼ぶ側が探索する）
 * 綱を先に使わない
 */
export function homewardAction(obs: Observation, p: PilotPolicy, can: (tool: string) => boolean, moveArgs: Record<string, unknown> = {}): { tool: string; args: Record<string, unknown>; why?: string } | null {
  const x = obs.expedition;
  if (alert(obs, 'on_stairs') && x?.can_extract && can('extract')) return { tool: 'extract', args: x.extract_outcome === 'complete' ? {} : { confirm: true } };
  const lifeline = p.allow_lifeline && hasLifeline(obs) && can('use_item');
  const near = nearestStairs(obs);
  const hunted = chasers(obs).length > 0;
  if (near && near.dist > 0) {
    if (!hunted && can('travel_to')) return { tool: 'travel_to', args: { to: `stairs_${near.type}`, ...moveArgs } };
    const esc = escapeStairs(obs);
    if (esc && can('travel_to')) return { tool: 'travel_to', args: { to: `stairs_${esc}`, ...fleeArgs(obs) } };
    if (lifeline) return { tool: 'use_item', args: { slot: 'lifeline' }, why: `追われたままでは、知っている階段へ着けない（観測の escape）: ${alert(obs, 'escape')?.text ?? obs.summary}` };
    if (can('travel_to')) return { tool: 'travel_to', args: { to: `stairs_${near.type}`, ...fleeArgs(obs) } };
  }
  if (!near && obs.navigation.known_stairs.length && lifeline) return { tool: 'use_item', args: { slot: 'lifeline' }, why: '知っている階段へ道が無い' };
  return null;
}

/** 自分の参加の順（観測の party に無い番号のうち、いちばん小さいもの） */
export function selfOrder(party: readonly ObsPartyMember[]): number {
  const taken = new Set(party.map((m) => m.order));
  for (let i = 1; ; i++) if (!taken.has(i)) return i;
}
/**
 * ついていく相手（V4-1f §22.5）: follow が名前か ID ならその仲間。auto なら人間の仲間（参加の順で最初）、いなければ参加がいちばん早い者
 * （自分がそれなら、だれにもついていかない。pilot 同士がお互いを追わない）。倒れた・抜けた仲間にはついていかない
 */
export function leaderOf(obs: Observation, p: PilotPolicy): ObsPartyMember | null {
  const party = obs.party ?? [];
  if (!party.length || p.coop.follow === 'none') return null;
  const present = party.filter((m) => m.status === 'in_dungeon' || m.status === 'at_camp').sort((a, b) => a.order - b.order);
  if (p.coop.follow !== 'auto') return present.find((m) => m.id === p.coop.follow || m.name === p.coop.follow) ?? null;
  const human = present.find((m) => m.controller === 'human');
  if (human) return human;
  const first = present[0];
  return first && first.order < selfOrder(party) ? first : null;
}
const NEAR_DIRS: Record<Dir, Dir[]> = { n: ['nw', 'n', 'ne'], ne: ['n', 'ne', 'e'], e: ['ne', 'e', 'se'], se: ['e', 'se', 's'], s: ['se', 's', 'sw'], sw: ['s', 'sw', 'w'], w: ['sw', 'w', 'nw'], nw: ['w', 'nw', 'n'] };
/**
 * 見回る先（V4-1f §22.1 の 4）: この階で pilot が立ったことのあるマス（遠征をまたいだ記録）と、知っている階段のうち、
 * 探し始めてから立ったマスと今いるマスから 6 マス以上離れた、いちばん遠い所。気配があれば、その方角（near なら 10 マス以内）を先に
 */
export function patrolTarget(obs: Observation, mem: PilotMemory, walked: readonly Pos[]): Pos | null {
  const here = obs.self.pos;
  if (!here) return null;
  const sense = obs.expedition?.sense;
  const cands = [...walked, ...obs.navigation.known_stairs.filter((st) => st.reachable).map((st) => st.pos)];
  const avoid = [...mem.seekVisited, here];
  let list = cands.filter((c) => avoid.every((a) => cheb(a, c) > 5) && !mem.patrolFailed.some((f) => f.x === c.x && f.y === c.y));
  if (sense) {
    const nd = NEAR_DIRS[sense.dir];
    const inDir = list.filter((c) => { const d = dirTo(here, c); return !!d && nd.includes(d) && (sense.range !== 'near' || cheb(here, c) <= 10); });
    if (inDir.length) list = inDir;
  }
  return list.sort((a, b) => cheb(here, b) - cheb(here, a) || a.y - b.y || a.x - b.x)[0] ?? null;
}
/** 探す目的（V4-1f §22.1）: 目的の相手（守護者・大守護者・賞金首）か目的の品 */
const SEEK_TYPES = new Set(['slay_guardian', 'slay_warden', 'slay_bounty', 'retrieve_relic']);

/** 来た道を戻る先（§14.3 の 4）: 歩いた跡のうち、いまのマスから 6 マス以上離れた最も新しいマス。無ければ最も離れたマス（2 マス以上） */
export function backtrackTarget(obs: Observation, mem: PilotMemory): Pos | null {
  const here = obs.self.pos;
  if (!here) return null;
  for (let i = mem.trail.length - 1; i >= 0; i--) if (cheb(mem.trail[i]!, here) >= 6) return mem.trail[i]!;
  let best: Pos | null = null;
  for (const t of mem.trail) if (cheb(t, here) >= 2 && (!best || cheb(t, here) > cheb(best, here))) best = t;
  return best;
}

/**
 * 回復の手段（観測の self.recovery。V4-1c §16.3）: 使える能動技を先に、無ければ品（使うと減る）。allow_heal: false なら無し。
 * 観測にあるものだけを使う（未鑑定の品は観測に入らないので、触れない）
 */
export function healAction(obs: Observation, p: PilotPolicy, o: { items: boolean }): { tool: string; args: Record<string, unknown>; name: string; item: boolean; left?: number } | null {
  if (!p.allow_heal) return null;
  const rec = obs.self.recovery ?? [];
  const ab = rec.find((r) => r.kind === 'ability' && r.ready);
  if (ab && ab.kind === 'ability') return { tool: 'use_ability', args: { id: ab.id }, name: ab.name, item: false };
  const it = o.items ? rec.find((r) => r.kind === 'item' && r.qty > 0) : undefined;
  if (it && it.kind === 'item') return { tool: 'use_item', args: { slot: it.slot }, name: it.name, item: true, left: it.qty - 1 };
  return null;
}
const healedText = (h: { name: string; item: boolean; left?: number }) => (h.item ? `${h.name} を使った（残り ${h.left}）` : `${h.name} を使った`);

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
export function holdAction(obs: Observation, ctx: DecideContext): { tool: string; args: Record<string, unknown>; why?: string } | null {
  const p = ctx.orders.policy;
  const mem = ctx.mem ?? newMemory();
  const can = (tool: string) => !ctx.refused?.has(tool);
  const idle = () => (ctx.coop ? { tool: 'wait', args: {} } : null);
  if (alert(obs, 'lethal_range') || alert(obs, 'critical_hp')) {
    const r = retreat(obs, p);
    if (r && can(r.tool)) return r;
    // 退く手が無い: 回復の手段（能動技を先に、品は最後の手。§16.3）
    const h = healAction(obs, p, { items: true });
    if (h && can(h.tool)) return { tool: h.tool, args: h.args };
  }
  const adj = adjacentHunting(obs)[0];
  if (adj && can('attack')) return { tool: 'attack', args: { target: adj.id } };
  if (ctx.homeward) {
    // 帰る順は §19.4 で共通（階段が先、綱は着けないときだけ）。allow_extract: false なら、階段の上で待つ
    const h = homewardAction(obs, p, (tool) => can(tool) && (tool !== 'extract' || p.allow_extract), fleeArgs(obs));
    return h ?? idle();
  }
  // この数手番に隣でない相手から被害を受けた・追ってくる敵が見えている: 同じ場所に留まらない
  const hurtFar = mem.hurtFarAgo !== null && mem.hurtFarAgo <= 2;
  if ((hurtFar || chasers(obs).length > 0) && can('travel_to')) {
    const m = moveAway(obs, ctx, mem);
    if (m) return m;
  }
  return idle();
}

/**
 * pilot の fight の引数: hp_floor は wake_hp_pct、寄り方は方針（auto なら、寄ってやり直すと決めた相手だけ advance）。
 * 離れたままの相手への最後のやり直し（諦める前の 1 回。既定の give_up_after 3 なら 3 回目）は、allow_throw なら投げる品を with に渡す
 * （隣に来たら近接に切り替える。V4-1d §18.2）
 */
export function fightArgs(obs: Observation, p: PilotPolicy, mem: PilotMemory, id: string, throwKinds?: ReadonlySet<string>): Record<string, unknown> {
  const hp_floor = Math.floor((obs.self.max_hp * p.wake_hp_pct) / 100);
  const last = (mem.stops[id] ?? 0) >= Math.max(1, p.give_up_after - 1);
  const kinds = p.allow_throw && last && mem.away.includes(id) ? throwKindsOf(obs, throwKinds) : [];
  if (kinds.length) return { target: id, hp_floor, with: kinds.length === 1 ? kinds[0] : kinds, adjacent: 'melee' };
  const advance = p.approach === 'advance' || (p.approach === 'auto' && mem.advance.includes(id));
  return { target: id, hp_floor, ...(advance ? { approach: 'advance' } : {}) };
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
  const act = (tool: string, args: Record<string, unknown>, then?: Wake) => out({ kind: 'act', tool, args, ...(then ? { then } : {}) });
  const wake = (w: Wake) => { if (!active.includes(w.key)) active.push(w.key); return out({ kind: 'wake', wake: w }); };
  /** 同じ階にいる間に 1 回だけ知らせる */
  const noteOnce = (w: Wake) => { if (!ctx.notified?.has(w.key) && !ctx.once?.has(w.key)) notify.push(w); };
  /** 綱を使うときは、使えた後に理由と持ち帰っていない戦利品を知らせる（V4-1e §19.4） */
  const lifelineDone = (why: string | undefined): Wake => W('lifeline_used', `lifeline_used:${obs.seq}`, [why ?? '', obs.expedition?.haul ? `持ち帰っていない戦利品: ${obs.expedition.haul.text}` : ''].filter(Boolean).join('\n'), 'notify');
  const actR = (r: { tool: string; args: Record<string, unknown>; why?: string }) =>
    r.tool === 'use_item' && r.args.slot === 'lifeline' ? out({ kind: 'act', tool: r.tool, args: r.args, done: lifelineDone(r.why) }) : act(r.tool, r.args);
  /** 大守護者の判断に要る情報（V4-1e §19.2。どれも観測とキャンプの候補にある、プレイヤーがすでに読める情報） */
  const wardenDetail = (wdepth: number, lines: string[]): string => {
    const ms = obs.camp?.milestone ?? obs.expedition?.milestone;
    const tries = ctx.wardenTries?.[String(wdepth)] ?? 0;
    return [
      `節目の大守護者「${ms?.name ?? '?'}」（地下 ${wdepth} 階）に挑むかを決めてほしい。挑むなら orders.json の policy.warden を "engage"、挑まないなら "avoid" にする`,
      ms?.text ?? '',
      ...lines,
      `レベル ${obs.self.level}・HP ${obs.self.hp}/${obs.self.max_hp}・この大守護者に挑んだ遠征 ${tries} 回`,
      lineWith(ctx.text, '所持品 ('),
    ].filter(Boolean).join('\n');
  };
  const x = obs.expedition;
  const can = (tool: string) => !ctx.refused?.has(tool);
  const ignored = new Set(mem.ignored);
  const pct = hpPct(obs);

  // 1. ランが終わった
  if (obs.status === 'ended' || obs.status === 'dead') return out({ kind: 'end', wake: W('ended', 'ended', obs.summary) });
  // 2. キャンプ: その枠の候補で自動で出発するか、起こす（遠征のレポートの要点を添える）。起こして返事を待っている間は、何もしない
  if (obs.status === 'at_camp' && ctx.waiting) return out({ kind: 'idle' });
  if (obs.status === 'at_camp') {
    const nextNo = obs.camp?.next_no ?? '';
    // 遠征の途中で、仲間がまだ迷宮にいる（V4-1f §22.5）: 遠征を始めようとせずに待つ（行き詰まりにも空回りにも数えない）。
    // 遠征が進んでいないとき（終わった・まだ無い）は、始められるので待たない
    if (x && x.status !== 'ended' && (obs.party ?? []).some((m) => m.status === 'in_dungeon')) return out({ kind: 'idle', wait: 'party' });
    // 空回り（§19.3）: 直近の遠征がどれも空だった。遠征を自動で始めずに上げる（返事の後は、いつもどおり）
    if (ctx.stalled && fresh(`stalled:${nextNo}`)) return wake(W('stalled', `stalled:${nextNo}`, ctx.stalled, 'escalate'));
    // 節目の大守護者（§19.2）: 大守護者に挑む候補と、節目の先（封じられた階段の先）が要る候補
    const offers = obs.camp?.offers ?? [];
    const ms = obs.camp?.milestone;
    const wardenOffer = (o: (typeof offers)[number]) => o.type === 'slay_warden' || (!!ms && !ms.cleared && o.target_depth !== null && o.target_depth > ms.depth);
    if (offers.length && offers.every(wardenOffer) && p.warden !== 'engage') {
      const wkey = `warden_decision:${ms?.depth ?? ''}`;
      // その大守護者につき 1 回だけ上げる
      if (p.warden === 'escalate' && !ctx.once?.has(wkey) && fresh(wkey)) {
        const rec = offers.map((o) => o.recommended_level).filter((v): v is number => v !== null);
        return wake(W('warden_decision', wkey, wardenDetail(ms?.depth ?? 0, [
          '選べる候補が、大守護者に挑むか、その先へ行くものしか残っていない:',
          ...offers.map((o) => `${o.index}. ${o.text}${o.scar ? `（傷跡 ${o.scar}）` : ''}${o.rechallenge ? '（再挑戦）' : ''}`),
          rec.length ? `推奨レベル ${Math.min(...rec)}〜${Math.max(...rec)}` : '',
        ]), 'escalate'));
      }
      // 挑まない（avoid）・上げた後も決まっていない: 選べる候補が尽きた空回りとして上げて止まる（キャンプは安全なので待つ）
      const skey = `stalled:warden:${nextNo}`;
      if (fresh(skey)) return wake(W('stalled', skey, `節目の大守護者「${ms?.name ?? '?'}」（地下 ${ms?.depth ?? '?'} 階）に挑まない方針（warden: ${p.warden}）で、選べる候補が無い。挑むなら policy.warden を "engage" に、ほかに決めることがあれば queue に書く`, 'escalate'));
      return out({ kind: 'idle' });
    }
    const slot = ctx.orders.camp.auto_start;
    // 自動で出発する枠の候補でも、大守護者に関わる候補は warden: engage のときだけ選ぶ
    const offer = slot ? offers.find((o) => o.slot === slot && (p.warden === 'engage' || !wardenOffer(o))) : undefined;
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
    if (h && (h.tool === 'use_item' || h.tool === 'use_ability')) {
      const r = (obs.self.recovery ?? []).find((x) => (x.kind === 'item' && x.slot === h.args.slot) || (x.kind === 'ability' && x.id === h.args.id));
      if (r) notify.push(W('healed', `healed:${obs.seq}`, healedText(r.kind === 'item' ? { name: r.name, item: true, left: r.qty - 1 } : { name: r.name, item: false }), 'notify'));
    }
    // 綱を使ったら、待つ間でも lifeline_used で知らせる（V4-1e §19.4）
    return h ? actR(h) : out({ kind: 'idle' });
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
      return actR(r);
    }
    // 退く手がどれも無い: 回復の手段（能動技を先に。品は使ってから起こす。§16.3）
    const h = healAction(obs, p, { items: true });
    if (h && can(h.tool)) {
      notify.push(W('healed', `healed:${obs.seq}`, healedText(h), 'notify'));
      fresh(key);
      return act(h.tool, h.args, h.item ? W('danger', key, danger.text) : undefined);
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
      // 0) HP が wake_hp_pct を切っていて、回復の能動技が使える: 使う（使っても減らない。追ってくる敵がいてもいなくても。§16.3）
      const hab = pct < p.wake_hp_pct ? healAction(obs, p, { items: false }) : null;
      if (hab && can(hab.tool)) { notify.push(W('healed', `healed:${obs.seq}`, healedText(hab), 'notify')); return act(hab.tool, hab.args); }
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
      // 役割のある敵（目的の相手も）とは、HP が減ったまま殴り合わない（離れる・退く・起こす）
      const adj = adjacentHunting(obs).filter((m) => !isRoleEnemy(m))[0];
      const ally = ctx.coop ? farAlly(obs) : undefined;
      if (adj && !ally && can('attack')) return act('attack', { target: adj.id });
      // 3) 4) 仲間の隣へ寄る・来た道を戻る
      if (can('travel_to')) {
        const m = moveAway(obs, ctx, mem);
        if (m) return act(m.tool, m.args);
      }
      // 5) どれもできない: 退く。それもできなければ起こす
      const r = retreat(obs, p);
      if (r && can(r.tool)) return actR(r);
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
  const depth = obs.self.floor?.depth ?? 0;
  const targetDepth = x?.objective.target_depth ?? null;
  // 節目の大守護者（V4-1e §19.2）: この階に大守護者が見えている・目的の階が封じられた下り階段の先にある・目的が大守護者
  const wardenM = obs.visible.monsters.find((m) => m.guardian?.warden);
  const sealedHere = obs.navigation.known_stairs.some((st) => st.type === 'down' && st.sealed);
  const inProgress = x?.status === 'in_progress';
  const wardenNeeded = inProgress && ((x!.objective.type === 'slay_warden' && targetDepth === depth) || (targetDepth !== null && targetDepth > depth && sealedHere));
  const wkey = `warden_decision:${depth}`;
  if ((wardenM || wardenNeeded) && p.warden === 'escalate' && !ctx.once?.has(wkey) && fresh(wkey)) {
    const lines = wardenM ? [lineWith(ctx.text, wardenM.id, wardenM.name)] : [`目的の階（地下 ${targetDepth} 階）へは、この階の封じられた下り階段の先へ行く（大守護者を倒すまで開かない）`];
    return wake(W('warden_decision', wkey, wardenDetail(depth, [...lines, x?.text ?? '']), 'escalate'));
  }
  /** 大守護者が要るのに、挑むと決まっていない（avoid・上げた後も escalate のまま）: 帰る */
  const avoidWarden = wardenNeeded && p.warden !== 'engage';
  // 9. 役割のある敵が見えている。この遠征の目的の相手なら起こす（engage_objective なら起こさずに挑む）。目的でなければ同じ個体で 1 回だけ知らせる（V4-1e §19.5）
  //    大守護者は warden の方針で決める（engage: 目的か、先へ行くのに要るなら起こさずに挑む。ほかは挑まずに 1 回知らせる）
  for (const m of obs.visible.monsters.filter(isRoleEnemy).sort((a, b) => a.dist - b.dist)) {
    const reason = roleReason(m);
    const key = `${reason}:${m.id}`;
    if (m.guardian?.warden) {
      if (p.warden === 'engage' && (m.objective || wardenNeeded) && !ctx.refusedTargets?.has(m.id) && !ignored.has(m.id)) {
        notify.push(W(reason, `${key}:engage:${obs.seq}`, lineWith(ctx.text, m.id, m.name), 'notify'));
        return act('fight', fightArgs(obs, p, mem, m.id, ctx.throwKinds));
      }
      noteOnce(W(reason, `seen:${m.id}`, lineWith(ctx.text, m.id, m.name), 'notify'));
      continue;
    }
    if (!m.objective) { noteOnce(W(reason, `seen:${m.id}`, lineWith(ctx.text, m.id, m.name), 'notify')); continue; }
    if (p.engage_objective) {
      if (ctx.refusedTargets?.has(m.id) || ignored.has(m.id)) continue;
      notify.push(W(reason, `${key}:engage:${obs.seq}`, lineWith(ctx.text, m.id, m.name), 'notify'));
      return act('fight', fightArgs(obs, p, mem, m.id, ctx.throwKinds));
    }
    if (fresh(key)) return wake(W(reason, key, lineWith(ctx.text, m.id, m.name)));
  }
  // 10. 遺物。目的の遺物なら起こす（engage_objective なら起こさずに拾いに行く）。目的でない遺物は、同じ遺物につきランを通して 1 回だけ知らせる（V4-1e §19.5）
  const others = obs.visible.items.filter((i) => i.role === 'relic' && !i.objective && !ctx.notified?.has(`relic_seen:${i.id}`) && !ctx.once?.has(`relic_seen:${i.id}`)).sort((a, b) => a.dist - b.dist);
  if (others.length) {
    const n = W('relic_seen', `relic_seen:${others[0]!.id}`, [...others.map((it) => lineWith(ctx.text, it.id, `${it.name} ${it.id} (${it.pos.x},${it.pos.y})`)), p.pick_relics ? '追ってくる敵が見えていなければ拾う（pick_relics）' : '拾うなら policy.pick_relics: true か、queue に travel_to { to: <遺物の ID> }'].join('\n'), 'notify');
    if (others.length > 1) n.also = others.slice(1).map((it) => `relic_seen:${it.id}`);
    notify.push(n);
  }
  // 目的でない遺物を拾う（pick_relics。追ってくる敵が見えていないとき。拾うと階が起きる。§19.5）
  if (p.pick_relics && !ch.length && can('travel_to')) {
    const it = obs.visible.items.filter((i) => i.role === 'relic' && !i.objective && !mem.relicFailed.includes(i.id)).sort((a, b) => a.dist - b.dist)[0];
    if (it) return out({ kind: 'act', tool: 'travel_to', args: { to: it.id }, relic: it.id });
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
  // fight を待つ間に、見えない相手に撃たれた: 1 回、来た道を戻る（立て直しの段の 4。V4-1d §18.2）
  if (mem.backOff) {
    upd({ backOff: false });
    const back = backtrackTarget(obs, mem);
    if (back && can('travel_to')) return act('travel_to', { to: { x: back.x, y: back.y }, ...fleeArgs(obs) });
  }
  // 12. 追ってくる役割の無い敵と戦う（相手にしない敵・この手番に断られた相手を除く）。fight を待つ間に撃ってきた見えている相手がいれば、その相手から（V4-1d §18.2）
  const fightable = activeCh.filter((m) => !isRoleEnemy(m) && !ctx.refusedTargets?.has(m.id));
  const target = p.fight ? fightable.find((m) => m.id === mem.shotBy) ?? fightable.sort((a, b) => a.dist - b.dist)[0] : undefined;
  if (target) return act('fight', fightArgs(obs, p, mem, target.id, ctx.throwKinds));
  // 罠にふさがれて断られた（V4-1d §18.1）: step_on_traps なら、隣の罠は 1 歩で踏む（知らせる）。隣でなければ罠の隣まで行く。
  // 立て直しの段の途中（HP が減っている）では踏まない（立て直しの表のほかの手へ進む）
  const tb = ctx.trapBlock;
  if (tb && p.step_on_traps && obs.self.pos && tb.traps.length) {
    const tr = tb.traps[0]!;
    const dist = cheb(obs.self.pos, tr.pos);
    const d = dirTo(obs.self.pos, tr.pos);
    if (dist === 1 && d && can('move')) {
      notify.push(W('stepped_on_trap', `stepped_on_trap:${tr.id}:${obs.seq}`, [...trapLines(obs, ctx.text, [tr]), `${tb.tool} が罠にふさがれたので、踏んで通る（move ${d}）`].join('\n'), 'notify'));
      return act('move', { dir: d });
    }
    if (dist > 1 && can('travel_to')) return act('travel_to', { to: { x: tr.pos.x, y: tr.pos.y } });
  }
  const stairs = obs.navigation.known_stairs.filter((s) => s.reachable);
  // 封じられた下り階段（大守護者を倒していない節目の階。V4-1a §12.4）へは下りに行かない
  const down = stairs.find((s) => s.type === 'down' && !s.sealed);
  // 相手にしない敵が見えている間は、被害を受けても止まらない進み方（§14.2）
  const steady = obs.visible.monsters.some((m) => ignored.has(m.id)) ? { mode: 'steady' } : {};
  // 協力プレイで、仲間についていく（V4-1f §22.5）。危ない・HP・敵への対応（上の行）が先。following の間は、自分から階を移らない（#15 を飛ばす）
  const leader = x && x.status !== 'ended' ? leaderOf(obs, p) : null;
  const fm = mem.follow && leader && mem.follow.id === leader.id ? mem.follow : null;
  let following = false;
  /** 相手がキャンプに帰った（この遠征で迷宮にいた後）: 自分も帰る */
  let followHome = false;
  if (leader && leader.status === 'at_camp' && fm?.inDungeon) followHome = true;
  if (leader && leader.status === 'in_dungeon' && obs.self.pos && !(ctx.orders.mode === 'stop_at_camp' || ctx.orders.mode === 'return')) {
    following = true;
    if (leader.floor !== undefined && leader.floor !== depth) {
      // 遠征の最初に、相手がまだ同じ階にいない: その場で待つ（持ち場の動き）。相手が階を移るか、hold_max_turns が過ぎたら、相手の階へ向かう
      const waitStart = p.coop.wait_for_party && !!fm && !fm.met && fm.lastFloor === fm.floorAtStart && (ctx.turnNo ?? 0) - fm.startTurn < p.hold_max_turns;
      if (waitStart) {
        const h = holdAction(obs, { ...ctx, homeward: false });
        return h ? actR(h) : act('wait', {});
      }
      // 相手のいる階へ行く（深ければ下りる、浅ければ上る。階段を知らなければ探索する）
      const way = leader.floor > depth ? 'down' : 'up';
      const st = stairs.find((x2) => x2.type === way && !(way === 'down' && x2.sealed));
      if (st) {
        if (st.dist === 0 && can('use_stairs')) return act('use_stairs', {});
        if (st.dist > 0 && can('travel_to')) return act('travel_to', { to: `stairs_${way}`, ...steady });
      }
      if (can('explore') && (obs.navigation.frontiers.length || (obs.navigation.unsighted ?? 0) > 0)) {
        return act('explore', { pickup: p.collect ? 'useful' : false, ...(way === 'down' && obs.self.floor?.draft ? { toward: 'draft' } : {}), ...steady });
      }
    } else if (leader.pos) {
      // 同じ階で見えていて、follow_distance より離れている: 相手の隣へ
      if (cheb(obs.self.pos, { x: leader.pos[0], y: leader.pos[1] }) > p.coop.follow_distance && can('travel_to')) return act('travel_to', { to: leader.entity ?? { x: leader.pos[0], y: leader.pos[1] }, ...steady });
    } else if (fm?.lastPos) {
      // 同じ階で見えていない: 最後に見た位置へ（着いても見えなければ、記録を消して探索へ）
      if (cheb(obs.self.pos, fm.lastPos) > 1 && can('travel_to')) return act('travel_to', { to: { x: fm.lastPos.x, y: fm.lastPos.y }, ...steady });
      upd({ follow: { ...fm, lastPos: null } });
    }
  }
  // 13. 敵がいなくて HP が rest_below_pct を切っている: 休む
  if (!ch.length && pct < p.rest_below_pct && can('rest')) return act('rest', {});
  // 14. 帰る（mode: return・stop_at_camp・目的を果たした後の既定・大守護者に挑まないと決めた）。after_objective: wake なら起こす、continue なら先へ。
  //     帰る順は §19.4（階段が先、綱は階段へ着けないときだけ）
  const complete = x?.status === 'objective_complete';
  const leaving = ctx.orders.mode === 'stop_at_camp' || ctx.orders.mode === 'return';
  // ついていく間は、目的を果たした・大守護者に挑まない、では帰らない（相手が帰ったら帰る。mode の return・stop_at_camp は帰る）
  const homeward = leaving || followHome || (!following && ((complete && p.after_objective === 'extract') || avoidWarden));
  if (complete && p.after_objective === 'wake' && !leaving) {
    const key = `objective_done:${x!.no}`;
    if (fresh(key)) return wake(W('objective_done', key, x!.text));
  }
  if (homeward && x) {
    const h = homewardAction(obs, p, can, steady);
    if (h) return actR(h);
  }
  // 帰りたいのに、着ける階段をまだ知らない: 階段を探して探索する（#17）
  const seekStairs = homeward && !stairs.length;
  // 探す（V4-1f §22.1）: 目的の階で、目的の相手・品がまだ見えていない（覚えてもいない）。大守護者が要るのに見えていない（挑むと決めた後）も同じ。
  //     ついていく間は探さない（相手が行き先を決める）
  const objSeen = obs.visible.monsters.some((m) => m.objective) || obs.visible.items.some((i) => i.objective);
  const seekObjective = !!x && inProgress && SEEK_TYPES.has(x.objective.type) && depth === targetDepth && !objSeen;
  const seekWarden = wardenNeeded && p.warden === 'engage' && !wardenM;
  const seeking = !homeward && !following && (seekObjective || seekWarden);
  if (seeking && mem.seekTurns >= p.seek_max_turns) {
    const key = `target_not_found:${x!.no}:${depth}`;
    if (fresh(key)) return wake(W('target_not_found', key, [`目的の相手・品を ${mem.seekTurns} 手番探したが見つからない（seek_max_turns ${p.seek_max_turns}）`, x!.objective.text, x!.sense?.text ?? '', obs.summary].filter(Boolean).join('\n')));
  }
  // 3) 大守護者: 封じられた下り階段のある広間へ（観測の「封じられている」から分かる。種族の知識ではない）
  const sealedSt = obs.navigation.known_stairs.find((st) => st.type === 'down' && st.sealed && st.reachable);
  if (seeking && (x!.objective.type === 'slay_warden' || seekWarden) && sealedSt && sealedSt.dist > 2 && !mem.patrolFailed.some((f) => f.x === sealedSt.pos.x && f.y === sealedSt.pos.y) && can('travel_to')) {
    return out({ kind: 'act', tool: 'travel_to', args: { to: { x: sealedSt.pos.x, y: sealedSt.pos.y }, ...steady }, seek: true });
  }
  // 15. 目的の階へ向かう。目的の階より深い所から始まった遠征（前の遠征で止まった階段から再開する）なら、上り階段で上がる
  if (p.descend && x && !homeward && !following && x.status === 'in_progress' && targetDepth !== null && depth > targetDepth) {
    const up = stairs.find((s) => s.type === 'up');
    if (up) {
      if (up.dist === 0 && can('use_stairs')) return act('use_stairs', {});
      if (up.dist > 0 && can('travel_to')) return act('travel_to', { to: 'stairs_up', ...steady });
    }
  }
  //     目的の階へ下りる（目的が「踏破」なら、目的の階の下り階段に着くまで。continue なら目的の後も下りる）
  if (p.descend && x && !homeward && !following && (x.status === 'in_progress' || (complete && p.after_objective === 'continue'))) {
    const below = targetDepth === null || depth < targetDepth || complete;
    const crossing = x.objective.type === 'reach_depth' && targetDepth !== null && depth === targetDepth;
    if ((below || crossing) && down) {
      if (down.dist === 0 && below && can('use_stairs')) return act('use_stairs', {});
      if (down.dist > 0 && can('travel_to')) return act('travel_to', { to: 'stairs_down', ...steady });
    }
  }
  // 16. 引数なしの collect が拾いに行く品がある（観測の navigation.collectable。遺物は collect が拾わない。V4-1a §12.1）
  if (!homeward && p.collect && can('collect') && (obs.navigation.collectable?.count ?? 0) > 0) return act('collect', { what: 'items', ...steady });
  // 17. 探索できる所が残っている（目的の階より浅く、下り階段を知らなければ、下への風の方角へ。探す間は、気配の方角へ: §22.1 の 2）
  if ((!homeward || seekStairs) && can('explore') && (obs.navigation.frontiers.length || (obs.navigation.unsighted ?? 0) > 0)) {
    const toward = seeking && x?.sense ? { toward: 'sense' } : (targetDepth === null || depth < targetDepth) && !down && obs.self.floor?.draft ? { toward: 'draft' } : {};
    return out({ kind: 'act', tool: 'explore', args: { pickup: p.collect ? 'useful' : false, ...toward, ...steady }, ...(seeking ? { seek: true } : {}) });
  }
  // 探す（§22.1 の 4）: 探索し終えた階を見回る（この階で立ったことのあるマスのうち、探し始めてから行っていない、いちばん遠い所。気配の方角を先に）
  if (seeking && can('travel_to')) {
    const t2 = patrolTarget(obs, mem, ctx.walked ?? []);
    if (t2) return out({ kind: 'act', tool: 'travel_to', args: { to: { x: t2.x, y: t2.y }, ...steady }, seek: true });
    const key = `target_not_found:${x!.no}:${depth}`;
    if (fresh(key)) return wake(W('target_not_found', key, [`目的の相手・品を探したが、見回る所が残っていない（${mem.seekTurns} 手番）`, x!.objective.text, x!.sense?.text ?? '', obs.summary].filter(Boolean).join('\n')));
  }
  // 帰りたいのに、知っている階段が無く、探索できる所も残っていない: 綱（allow_lifeline のとき。§19.4）
  if (homeward && x && p.allow_lifeline && hasLifeline(obs) && can('use_item')) return actR({ tool: 'use_item', args: { slot: 'lifeline' }, why: '帰りたいが、知っている階段が無く、探索できる所も残っていない' });
  // ついていく間に、やることが残っていない（相手が同じ階で見えない・相手の階への階段も探索できる所も無い）: 起こさずに待つ（持ち場の動き。V4-1f §22.5）
  if (following) {
    const h = holdAction(obs, { ...ctx, homeward: false });
    return h ? actR(h) : act('wait', {});
  }
  // 18. 何も残っていない。命令が断られて残らなかったなら、その理由（refused_<code>）で起こす。
  //     じゃまをしている敵（エラーの blocked_by）の観測の行を detail の先頭に、ほかの見えている者の行を近い順に後ろに添える（V4-1a §13.8。pilot は自分からは戦わない）
  const rf = ctx.refusal;
  if (rf && rf.code !== 'nothing_to_do') {
    // 道をふさいでいる罠（details.blocked_by_traps）の行と位置・方角を先頭に（V4-1d §18.1）
    const blockers = [...trapLines(obs, ctx.text, rf.traps ?? []), ...(rf.blockedBy ?? []).map((id) => lineWith(ctx.text, id))];
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

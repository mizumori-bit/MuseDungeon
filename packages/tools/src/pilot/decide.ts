// pilot の判断（IMPROVEMENTS_V4 §10.4〜§10.6、§14 で見直し）。観測の構造化された項目（alerts・visible・navigation・expedition・camp）と、
// pilot 自身の記録（PilotMemory: 歩いた跡・同じ相手に倒す前に止まった回数・相手にしない敵・立て直しの段）だけから決める純粋な関数。
// 規則の知識（種族の名前や数値）は持たない。決められることは決めて知らせ（notify）、AI にしか決められないことだけ起こす（wake。§14.0）。
// #3（rev の読み直し）と #4（queue）は呼ぶ側（pilot.ts）が先に済ませる。
import type { Dir, ObsMonster, ObsPartyMember, Observation, Pos } from '@muse/shared';
import { compassDir } from '@muse/shared';
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
   * seek: 目的の相手・品を探す手（V4-1f §22.1。使った手番を seek_max_turns に数える）。
   * partyWait: 仲間を待つ手（follow: ついていく相手の近くで待つ / start: 遠征の最初に相手が同じ階に来るのを待つ）。待つ命令は命令の上限に数えない（§23.8）。
   * why: どの決まりで出した命令か（log.jsonl に残す。V4-1g §24.5）
   */
  | { kind: 'act'; tool: string; args: Record<string, unknown>; then?: Wake; done?: Wake; relic?: string; seek?: boolean; partyWait?: 'follow' | 'start'; why?: string }
  /** 起こす（返事を待つ間は持ち場の動き。§14.4） */
  | { kind: 'wake'; wake: Wake }
  /**
   * 何もしない（ソロで起こして待つ間、追ってくる敵も被害も無い）。wait: party＝キャンプで、仲間が迷宮から戻るのを待つ（V4-1f §22.5）/
   * join＝協力プレイのランに、ほかの参加者がまだいない（V4-1g §24.4 wait_for_join）
   */
  | { kind: 'idle'; wait?: 'party' | 'join' }
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
  /** 相手にしないと決めた敵に撃たれた: 階段で階を出る（V4-1g §24.2 の 2。階を移ったら消える） */
  leaveFloor: boolean;
  /** 立て直しの 3 で fight したが、倒す前に止まった相手（この立て直しの間は、もう fight しない。V4-1h の続き） */
  recoverFought: string[];
  /** 危ない（danger）を上げて「帰る」に切り替えた（そのときの orders の rev。AI が rev を上げたら、そちらに従う。V4-1i §28.2 の 1。遠征ごと） */
  dangerHome: number | null;
  /** 協力プレイで、危ないときに帰る前に相手の所へ寄る（1 回だけ）: none → going（寄っている。始めた時点の HP）→ done（遠征ごと） */
  dangerJoin: 'none' | 'going' | 'done';
  dangerJoinHp: number;
  /** on_danger: recover（V4-1j §30.3）: この遠征の 1 回目の danger で立て直している（on）・もう使った（used） */
  dangerRecover: 'none' | 'on' | 'used';
  /** 協力プレイで自分が先頭: 下り階段の上で仲間を待ち始めた階と手番（V4-1j §30.1。hold_max_turns まで） */
  stairHold: { depth: number; since: number } | null;
  /** 逃げた（fight が target_fled で止まった）相手: 次は投げる武器を持たせてやり直す（V4-1i §28.2 の 3） */
  fled: string[];
  /** この階では explore の toward: sense が sense_found で断られる（目的でない遺物を覚えているため。V4-1i B9）: 方角なしで探索する */
  senseOff: boolean;
  /** 相手を助けに行っている・着いた（V4-1g §24.4 assist。知らせを 1 回にするため。階を移っても残す） */
  assisting: boolean;
  assistArrived: boolean;
}

/**
 * ついていく相手の記録（V4-1f §22.5）。met: この遠征で同じ階にいたことがある。inDungeon: この遠征で迷宮にいた（その後キャンプなら、帰った）。
 * lastPos: 同じ階で最後に見た位置。floorAtStart・startTurn: 遠征の最初に相手がいた階と、記録を始めた手番（最初に待つ長さを決める）
 */
export interface FollowMemory { id: string; exp: number | null; met: boolean; inDungeon: boolean; lastPos: Pos | null; lastFloor: number | null; floorAtStart: number | null; startTurn: number }

export function newMemory(): PilotMemory {
  return { trail: [], stops: {}, advance: [], ignored: [], recovering: false, crossed: null, stairRetreats: 0, hurtFarAgo: null, away: [], shotBy: null, backOff: false, relicFailed: [], seekTurns: 0, seekVisited: [], patrolFailed: [], follow: null, leaveFloor: false, recoverFought: [], dangerHome: null, dangerJoin: 'none', dangerJoinHp: 0, dangerRecover: 'none', stairHold: null, fled: [], senseOff: false, assisting: false, assistArrived: false };
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
  /** この手番で、手番が進まない命令を 3 回出した決まり（why）。その手番では、その決まりを使わない（V4-1i B1） */
  /** 覚えている地図の通れるマス（探していて探索できる所が無いとき、pilot が get_map で取る。見回り先の候補。V4-1k §32.2） */
  mapCells?: readonly Pos[];
  /** 相手ごとの戦いの記録（V4-1k §32.1。キーは「遠征:相手」） */
  fightStats?: ReadonlyMap<string, FightStat>;
  /** 通っていないのでやめた目的の相手（この遠征。挑まない。pilot は帰る。V4-1k §32.1） */
  noThrough?: ReadonlySet<string>;
  blockedWhys?: ReadonlySet<string>;
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
  /** この遠征で、相手にしない敵に撃たれて出た階（戻らない。V4-1g §24.2 の 2） */
  avoidDepths?: ReadonlySet<number>;
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
  // 追ってくる敵がいない（観測の escape は追われているときだけ出る）: 知っている階段へ歩いてよい（V4-1i の確かめで分かった: 敵のいない危険域の HP で、
  // 階段へ着けないとみなして綱を使っていた）
  const near = nearestStairs(obs);
  if (near && !chasers(obs).length) return { tool: 'travel_to', args: { to: `stairs_${near.type}`, ...fleeArgs(obs) } };
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
 * 探し始めてから立ったマスと今いるマスから 6 マス以上離れた、いちばん遠い所。気配があれば、その方角（near なら 10 マス以内）を先に。
 * mapCells: 覚えている地図の通れるマス（get_map。V4-1k §32.2: 立ったマスの記録だけでは、記録に無い部屋に入らない。Muse のランで、
 * 階を見終えた後、目的の守護者のいる部屋が立ったマスの記録に無く、気配の方角が合っていても 13 回見つけられなかった）
 */
export function patrolTarget(obs: Observation, mem: PilotMemory, walked: readonly Pos[], mapCells: readonly Pos[] = []): Pos | null {
  const here = obs.self.pos;
  if (!here) return null;
  const sense = obs.expedition?.sense;
  const cands = [...walked, ...obs.navigation.known_stairs.filter((st) => st.reachable).map((st) => st.pos), ...mapCells];
  const avoid = [...mem.seekVisited, here];
  let list = cands.filter((c) => avoid.every((a) => cheb(a, c) > 5) && !mem.patrolFailed.some((f) => f.x === c.x && f.y === c.y));
  if (sense) {
    const nd = NEAR_DIRS[sense.dir];
    // 方角は、気配と同じ 8 方位の分け方（compassDir）で見る（V4-1k: 符号だけの dirTo では、1 マスでも南なら「南」になり、西の端を選んでいた）
    // 気配と同じ方角を先に、無ければ両隣（両隣まで入れていちばん遠い所を選ぶと、方角の端へずれる）
    const inRange = (c: Pos) => sense.range !== 'near' || cheb(here, c) <= 10;
    const exact = list.filter((c) => compassDir(here, c) === sense.dir && inRange(c));
    const inDir = list.filter((c) => { const d = compassDir(here, c); return !!d && nd.includes(d) && inRange(c); });
    if (exact.length) list = exact;
    else if (inDir.length) list = inDir;
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
/** 立て直しの 3 の fight の hp_floor: critical_hp（HP が最大の 25% 未満。観測の判定は trunc(HP×100/最大) < 25）になる HP の上限 */
export function criticalFloor(obs: Observation): number {
  return Math.max(0, Math.ceil(obs.self.max_hp / 4) - 1);
}

function stairsOf(obs: Observation) {
  return obs.navigation.known_stairs ?? [];
}

/**
 * ついていく相手の所へ行く（立て直しの手が尽きたとき。V4-1h §26.2）: 見えていれば相手へ、別の階なら相手の階への階段へ（上なら上る）、
 * 見えていなければ最後に見た位置へ。行けなければ null
 */
/**
 * 同じ階の仲間へ向かう行き先（V4-1k §32.3）: 見えていれば仲間（エンティティ）、見えていなければ今の位置（観測の party[].pos。同じ階なら見えていなくても出る）。
 * そのマスを覚えていなければ（覚えている地図 mapCells に無い。まだ見ていない所。travel_to は覚えていない行き先を断る）、覚えているマスのうち、いちばん近い所
 */
export function allyDest(ally: ObsPartyMember, mapCells?: readonly Pos[]): string | Pos | null {
  if (ally.entity) return ally.entity;
  if (!ally.pos) return null;
  const p = { x: ally.pos[0], y: ally.pos[1] };
  if (!mapCells?.length || mapCells.some((c) => c.x === p.x && c.y === p.y)) return p;
  let best: Pos | null = null;
  let bd = Infinity;
  for (const c of mapCells) { const d = cheb(c, p); if (d < bd) { bd = d; best = c; } }
  return best ?? p;
}
/** 行き先へ行く手（覚えている近い所に着いても相手が見えなければ、探索で見に行く。V4-1k §32.3） */
function toAlly(obs: Observation, ally: ObsPartyMember, mapCells: readonly Pos[] | undefined, can: (tool: string) => boolean, moveArgs: Record<string, unknown>, near = 1): { tool: string; args: Record<string, unknown> } | null {
  if (!obs.self.pos || !ally.pos) return null;
  const lp = { x: ally.pos[0], y: ally.pos[1] };
  if (cheb(obs.self.pos, lp) <= near) return null;
  const dest = allyDest(ally, mapCells);
  if (typeof dest === 'object' && dest && cheb(obs.self.pos, dest) <= 1) {
    // 覚えているいちばん近い所にいる: 探索で見に行く（相手はまだ見ていない所にいる）
    if (can('explore') && (obs.navigation.frontiers.length || (obs.navigation.unsighted ?? 0) > 0)) return { tool: 'explore', args: { pickup: false } };
    return null;
  }
  if (dest && can('travel_to')) return { tool: 'travel_to', args: { to: dest, ...moveArgs } };
  return null;
}
/** 休めるか（ゲームの rest と同じ: 自分に届く追跡中の敵がいない。動かない敵は隣でなければ妨げない。V4-1k §32.4） */
function restBlocked(obs: Observation): boolean {
  return obs.visible.monsters.some((m) => m.awareness === 'hunting' && !m.fleeing && (!m.traits?.includes('stationary') || m.dist <= 1));
}

function toLeader(obs: Observation, leader: ObsPartyMember, fm: PilotMemory['follow'] | null, stairs: Observation['navigation']['known_stairs'], depth: number, can: (tool: string) => boolean, mapCells?: readonly Pos[]): { tool: string; args: Record<string, unknown> } | null {
  if (!obs.self.pos) return null;
  if (leader.pos && leader.floor === depth) return toAlly(obs, leader, mapCells, can, fleeArgs(obs));
  if (leader.floor !== undefined && leader.floor !== depth) {
    const way = leader.floor > depth ? 'down' : 'up';
    const st = stairs.find((s) => s.type === way && s.reachable && !(way === 'down' && s.sealed));
    if (st?.dist === 0 && can('use_stairs')) return { tool: 'use_stairs', args: {} };
    if (st && can('travel_to')) return { tool: 'travel_to', args: { to: `stairs_${way}`, ...fleeArgs(obs) } };
    return null;
  }
  if (fm?.lastPos && cheb(obs.self.pos, fm.lastPos) > 1 && can('travel_to')) return { tool: 'travel_to', args: { to: { x: fm.lastPos.x, y: fm.lastPos.y }, ...fleeArgs(obs) } };
  return null;
}

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
  // 帰る途中は、隣の敵を殴らない。殴るのは道をふさいでいる敵（断りの blocked_by）だけ（V4-1g §24.2 の 1）
  const blocker = (ctx.refusal?.blockedBy ?? []).map((id) => obs.visible.monsters.find((m) => m.id === id && m.dist <= 1)).find((m) => !!m);
  if (ctx.homeward && blocker && can('attack')) return { tool: 'attack', args: { target: blocker.id } };
  const adj = adjacentHunting(obs)[0];
  if (adj && can('attack') && !ctx.homeward) return { tool: 'attack', args: { target: adj.id } };
  if (ctx.homeward) {
    // 帰る順は §19.4 で共通（階段が先、綱は着けないときだけ）。allow_extract: false なら、階段の上で待つ
    const h = homewardAction(obs, p, (tool) => can(tool) && (tool !== 'extract' || p.allow_extract), fleeArgs(obs));
    if (h) return h;
    // 帰る手が無い（追い詰められた）: 隣で追ってくる敵は、道をふさいでいるのと同じなので殴る（V4-1g の測り直しで分かった: 待つだけで撃たれ続けた）
    if (adj && can('attack')) return { tool: 'attack', args: { target: adj.id }, why: 'cornered' };
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

/** 相手ごとの戦いの記録（V4-1k §32.1。pilot が fight の結果の文から数える。遠征と相手の組ごと） */
export interface FightStat {
  id: string; name: string; exp: number | null; depth: number | null; warden: boolean; objective: boolean;
  /** 初めて当てた時点・近接で初めて当てた時点・投げて初めて当てた時点・いまの相手の HP の段階（観測の 4 段階） */
  stage0: HpStateName | null; stageM0: HpStateName | null; stageT0: HpStateName | null; stage: HpStateName | null;
  /** 近接・投擲それぞれの当てた回数と与えた被害 */
  mHits: number; mDealt: number; tHits: number; tDealt: number;
  /** 初めて戦った時点と、いまの自分の HP */
  selfHp0: number | null; selfHp: number | null;
}
type HpStateName = 'healthy' | 'wounded' | 'badly_wounded' | 'near_death';
const STAGES: HpStateName[] = ['healthy', 'wounded', 'badly_wounded', 'near_death'];
const STAGE_JA: Record<HpStateName, string> = { healthy: '健康', wounded: '軽傷', badly_wounded: '重傷', near_death: '瀕死' };
/** 「通っていない」とみなす当てた回数（これを超えても、相手の HP の段階が 1 つも下がらない。V4-1k §32.1） */
export const NOT_THROUGH_HITS = 6;
/**
 * fight の結果の文（PlayerPort の要約）から、近接・投擲の回数と、当てた回数・与えた被害を読む（V4-1k §32.1）。
 * 「N 回攻撃し M 回命中・合計 D ダメージを与えた」「N 回投げ …」「近接 a 回・投擲 b 回、M 回命中・合計 D …」と、英語の同じ形
 */
export function fightNumbers(text: string): { melee: number; throws: number; hits: number; dealt: number } | null {
  const n = (v: string | undefined) => Number(v ?? 0);
  let m = text.match(/近接 (\d+) 回・投擲 (\d+) 回、(\d+) 回命中・合計 (\d+) ダメージを与えた/) ?? text.match(/(\d+) melee and (\d+) throws, (\d+) hit for (\d+) total/);
  if (m) return { melee: n(m[1]), throws: n(m[2]), hits: n(m[3]), dealt: n(m[4]) };
  m = text.match(/(\d+) 回投げ (\d+) 回命中・合計 (\d+) ダメージを与えた/) ?? text.match(/Threw (\d+) times, (\d+) hit for (\d+) total/);
  if (m) return { melee: 0, throws: n(m[1]), hits: n(m[2]), dealt: n(m[3]) };
  m = text.match(/(\d+) 回攻撃し (\d+) 回命中・合計 (\d+) ダメージを与えた/) ?? text.match(/Swung (\d+) times, (\d+) hit for (\d+) total/);
  if (m) return { melee: n(m[1]), throws: 0, hits: n(m[2]), dealt: n(m[3]) };
  return null;
}
/**
 * 通っているか（V4-1k §32.1。pilot の記録と、観測の HP の段階だけで決める。弱点の文は読まない）:
 * ok＝今のまま / throw＝投げる（投げてやり直す・投げ続ける）/ give_up＝やめる（目的なら帰って起こす。目的でなければ相手にしない）
 */
export function throughVerdict(st: FightStat, p: PilotPolicy, canThrow: boolean): 'ok' | 'throw' | 'give_up' {
  const idx = (x: HpStateName | null) => (x ? STAGES.indexOf(x) : -1);
  const dropped = (from: HpStateName | null) => from !== null && st.stage !== null && idx(st.stage) > idx(from);
  const throwOk = canThrow && p.allow_throw && p.fight_with !== 'melee';
  const meleeStuck = st.mHits > NOT_THROUGH_HITS && !dropped(st.stageM0);
  // 先に投げる（AI が決めた）: 投げる物がある間は投げ、無くなったら近接（近接が通らなければやめる）
  if (p.fight_with === 'throw_first') return throwOk ? 'throw' : meleeStuck ? 'give_up' : 'ok';
  // 近接で戦っている（まだ投げていない）
  if (st.tHits === 0) {
    if (meleeStuck) return throwOk ? 'throw' : 'give_up';
    return 'ok';
  }
  // 投げている（近接が通らなかったので）: 投げてからも段階が下がらない（6 回を超えて）・近接より通らない、ならやめる
  const mAvg = st.mHits ? st.mDealt / st.mHits : 0;
  const tAvg = st.tDealt / st.tHits;
  if (st.tHits > NOT_THROUGH_HITS && !dropped(st.stageT0)) return 'give_up';
  if (st.mHits > 0 && st.tHits >= 3 && tAvg <= mAvg && !dropped(st.stageT0)) return 'give_up';
  if (throwOk) return 'throw';
  // 投げる物が無くなった: 投げて段階が下がっていれば近接で続ける。下がっていなければやめる
  return dropped(st.stageT0) ? 'ok' : 'give_up';
}
/** 戦いの記録の 1 行（not_getting_through・warden_decision の detail。V4-1k §32.1） */
export function fightStatText(st: FightStat): string {
  const avg = (d: number, h: number) => (h ? (d / h).toFixed(1) : '-');
  return `${st.name} ${st.id}${st.exp !== null ? `（遠征 ${st.exp}）` : ''}: 近接 当てた ${st.mHits} 回・1 回あたり ${avg(st.mDealt, st.mHits)}、投擲 当てた ${st.tHits} 回・1 回あたり ${avg(st.tDealt, st.tHits)}。相手の HP の段階 ${st.stage0 ? STAGE_JA[st.stage0] : '?'} → ${st.stage ? STAGE_JA[st.stage] : '?'}${st.selfHp0 !== null && st.selfHp !== null ? `。自分の HP ${st.selfHp0} → ${st.selfHp}` : ''}`;
}

/**
 * pilot の fight の引数: hp_floor は wake_hp_pct、寄り方は方針（auto なら、寄ってやり直すと決めた相手だけ advance）。
 * 離れたままの相手への最後のやり直し（諦める前の 1 回。既定の give_up_after 3 なら 3 回目）は、allow_throw なら投げる品を with に渡す
 * （隣に来たら近接に切り替える。V4-1d §18.2）。
 * 戦い方（fight_with。V4-1k §32.1）: throw_first なら先に投げる。auto で通っていない（stats の throughVerdict が throw）なら投げる。
 * この 2 つは、隣に来ても投げ続ける（adjacent: throw。近接が通らない相手のため）。melee なら投げない
 */
export function fightArgs(obs: Observation, p: PilotPolicy, mem: PilotMemory, id: string, throwKinds?: ReadonlySet<string>, stats?: ReadonlyMap<string, FightStat>): Record<string, unknown> {
  const hp_floor = Math.floor((obs.self.max_hp * p.wake_hp_pct) / 100);
  const all = p.allow_throw && p.fight_with !== 'melee' ? throwKindsOf(obs, throwKinds) : [];
  const withThrow = (kinds: string[], adjacent: 'melee' | 'throw') => ({ target: id, hp_floor, with: kinds.length === 1 ? kinds[0] : kinds, adjacent });
  if (all.length && p.fight_with === 'throw_first') return withThrow(all, 'throw');
  const st = stats ? [...stats.values()].find((x) => x.id === id && x.exp === (obs.expedition?.no ?? null)) : undefined;
  if (all.length && st && throughVerdict(st, p, true) === 'throw') return withThrow(all, 'throw');
  const last = (mem.stops[id] ?? 0) >= Math.max(1, p.give_up_after - 1);
  // 逃げた相手（target_fled で止まった）は、次から投げる武器でやり直す（V4-1i §28.2 の 3）
  const kinds = all.length && ((last && mem.away.includes(id)) || mem.fled.includes(id)) ? all : [];
  if (kinds.length) return withThrow(kinds, 'melee');
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
  /** いまの行の名前（act の命令の why。V4-1g §24.5） */
  let why = 'start';
  const out = (decision: Decision): DecideResult => {
    if (decision.kind === 'act' && !decision.why) decision.why = why;
    return { decision, active, notify, ...(update ? { update } : {}) };
  };
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
    // 前の戦いの数字（近接・投擲の当てた回数と 1 回あたりの被害、相手の HP の段階。V4-1k §32.1）。弱点を読んで fight_with を決めるのは AI
    const fought = [...(ctx.fightStats?.values() ?? [])].filter((st) => st.warden && st.depth === wdepth).slice(-3);
    lines = [...lines, ...(fought.length ? ['前の戦い（戦い方を先に決めるなら policy.fight_with: "throw_first"・"melee"・"auto"）:', ...fought.map((st) => `- ${fightStatText(st)}`)] : [])];
    return [
      `節目の大守護者「${ms?.name ?? '?'}」（地下 ${wdepth} 階）に挑むかを決めてほしい。挑むなら orders.json の policy.warden を "engage"、挑まないなら "avoid" にする`,
      ms?.text ?? '',
      ...lines,
      `レベル ${obs.self.level}・HP ${obs.self.hp}/${obs.self.max_hp}・この大守護者に挑んだ遠征 ${tries} 回`,
      lineWith(ctx.text, '所持品 ('),
    ].filter(Boolean).join('\n');
  };
  const x = obs.expedition;
  // 断られた道具と、この手番で手番が進まない命令を 3 回出した決まり（why）は使わない（V4-1i B1）
  const can = (tool: string) => !ctx.refused?.has(tool) && !ctx.blockedWhys?.has(why);
  const ignored = new Set(mem.ignored);
  const pct = hpPct(obs);
  const depthNow = obs.self.floor?.depth ?? 0;

  // 1. ランが終わった
  // ランが終わった（死んだ・引退した）: AI か人間に届ける（V4-1g §24.2 の 4）
  if (obs.status === 'ended' || obs.status === 'dead') return out({ kind: 'end', wake: W('ended', 'ended', obs.summary, 'escalate') });
  // 2. キャンプ: その枠の候補で自動で出発するか、起こす（遠征のレポートの要点を添える）。起こして返事を待っている間は、何もしない
  // 起こして返事を待つ間も、遠征の途中で仲間が迷宮にいれば、仲間を待つ（観測を取り直して、仲間が戻ったのに気づく。§23.8）
  why = 'camp';
  // 協力プレイのランに、ほかの参加者がまだいない（V4-1g §24.4 wait_for_join）: 遠征を始めずに待つ（空回り・行き詰まりに数えない）
  // 倒れた仲間（down）は「いる」に数えない（V4-1i §28.2 の 2）。倒れた仲間がいて、キャンプで 1 回上げた返事が来た（または on_party_down: continue）なら、
  // 1 人で続ける（wait_for_join で待たない）
  const downs = (obs.party ?? []).filter((m) => m.status === 'down');
  const downKey = downs.length ? `party_down:camp:${downs.map((m) => m.id).sort().join(',')}` : '';
  const soloAfterDown = !!downKey && (p.coop.on_party_down === 'continue' || ctx.acked.has(downKey));
  const noOneJoined = ctx.coop && p.coop.wait_for_join && !soloAfterDown && !(obs.party ?? []).some((m) => m.status !== 'left' && m.status !== 'down');
  if (obs.status === 'at_camp' && ctx.waiting) return out({ kind: 'idle', ...(x && x.status !== 'ended' && (obs.party ?? []).some((m) => m.status === 'in_dungeon') ? { wait: 'party' as const } : noOneJoined ? { wait: 'join' as const } : {}) });
  if (obs.status === 'at_camp') {
    const nextNo = obs.camp?.next_no ?? '';
    // 遠征の途中で、仲間がまだ迷宮にいる（V4-1f §22.5）: 遠征を始めようとせずに待つ（行き詰まりにも空回りにも数えない）。
    // 遠征が進んでいないとき（終わった・まだ無い）は、始められるので待たない
    if (x && x.status !== 'ended' && (obs.party ?? []).some((m) => m.status === 'in_dungeon')) return out({ kind: 'idle', wait: 'party' });
    // 仲間が倒れた（V4-1i §28.2 の 2）: キャンプで 1 回上げて待つ。1 人で続けるかは AI が決める（rev が上がったら 1 人で続ける）
    if (ctx.coop && downs.length && p.coop.on_party_down === 'return' && fresh(downKey)) {
      return wake(W('party_down', downKey, [`仲間（${downs.map((m) => m.name).join('・')}）が倒れた。キャンプに戻った。1 人で続けるなら rev を上げる（遠征を選ぶなら queue に start_expedition）、やめるなら mode: "stop"`, x?.result?.text ?? '', obs.summary].filter(Boolean).join('\n'), 'escalate'));
    }
    if (noOneJoined) return out({ kind: 'idle', wait: 'join' });
    // 空回り（§19.3）: 直近の遠征がどれも空だった。遠征を自動で始めずに上げる（返事の後は、いつもどおり）
    // キャンプで上げるときも、その遠征の結果（終わり方・確定した点）を detail に入れる（V4-1k §32.4 の ★4: camp が出ないので、結果が分からなかった）
    const resultLine = x?.result?.text ?? '';
    if (ctx.stalled && fresh(`stalled:${nextNo}`)) return wake(W('stalled', `stalled:${nextNo}`, [resultLine, ctx.stalled].filter(Boolean).join('\n'), 'escalate'));
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
          resultLine,
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
    // detail: 遠征のレポートの要点と、候補の文（観測の文のまま。番号は start_expedition の offer）。
    // 遠征の終わりにつき 1 回だけ（返事が来た後は出し直さない。V4-1k §32.4 の ★4）
    const ckey = `camp:${obs.camp?.next_no ?? ''}`;
    if (!fresh(ckey)) return out({ kind: 'idle' });
    return wake(W('camp', ckey, [x?.result?.text ?? obs.summary, ...(obs.camp?.offers ?? []).map((o) => `${o.index}. ${o.text}`)].join('\n')));
  }
  // いま成り立っている条件の鍵を、表のどの行で決まるかに関わらず先に数える（成り立たなくなった鍵だけが、返事をした記録から外れる）
  for (const code of ['perk_pending', 'boon_pending']) { const a = alert(obs, code); if (a) active.push(`${code}:${JSON.stringify(a.data ?? '')}`); }
  for (const m of obs.visible.monsters.filter(isRoleEnemy)) active.push(`${roleReason(m)}:${m.id}`);
  for (const it of obs.visible.items.filter((i) => i.role === 'relic')) active.push(`relic_seen:${it.id}`);
  if (x?.status === 'objective_complete') active.push(`objective_done:${x.no}`);
  // 5. 起こして待っている・mode: hold: 持ち場の動き（§14.4）
  why = 'hold';
  if (ctx.orders.mode === 'hold' || ctx.waiting) {
    const h = holdAction(obs, ctx);
    if (h && (h.tool === 'use_item' || h.tool === 'use_ability')) {
      const r = (obs.self.recovery ?? []).find((x) => (x.kind === 'item' && x.slot === h.args.slot) || (x.kind === 'ability' && x.id === h.args.id));
      if (r) notify.push(W('healed', `healed:${obs.seq}`, healedText(r.kind === 'item' ? { name: r.name, item: true, left: r.qty - 1 } : { name: r.name, item: false }), 'notify'));
    }
    // 綱を使ったら、待つ間でも lifeline_used で知らせる（V4-1e §19.4）
    return h ? actR(h) : out({ kind: 'idle' });
  }
  why = 'perk';
  // 6. 特技・加護の選択: perk: first なら最初の候補を選ぶ（手番を使わない）。そうでなければ起こす
  for (const code of ['perk_pending', 'boon_pending'] as const) {
    const a = alert(obs, code);
    if (!a) continue;
    const tool = code === 'perk_pending' ? 'choose_perk' : 'choose_boon';
    if (p.perk === 'first' && can(tool)) return act(tool, { option: 1 });
    const key = `${code}:${JSON.stringify(a.data ?? '')}`;
    if (fresh(key)) return wake(W(code, key, a.text));
  }
  why = 'danger';
  // 7. 危ない（lethal_range・critical_hp）: AI に上げて（escalate。返事は待たない）、その場で「帰る」に切り替える（V4-1i §28.2 の 1）。
  //    回復で HP が戻っても、この遠征は帰る（AI が rev を上げたら、そちらに従う）。協力プレイで、ついていく相手が同じ階で生きていれば、
  //    帰る前に 1 回だけ相手の所へ寄る（見えていなければ最後に見た位置へ。寄る途中で HP がさらに減った・合流してもまだ危ない・
  //    最後に見た位置に着いても見えないなら、帰る。最後に見た位置も無ければ、寄らずに帰る）。
  //    知らせは起こすと決めた時点のもの（命令の前に出す。V4-1i B4: 薬を使った後の写しと、使う前の説明が食い違っていた）
  const danger = alert(obs, 'lethal_range') ?? alert(obs, 'critical_hp');
  // on_danger: recover（V4-1j §30.3）: 1 回目の danger で立て直している間に、倒されうる状態でなくなった: 続ける（この遠征の 1 回は使った）
  if (!danger && mem.dangerRecover === 'on') upd({ dangerRecover: 'used' });
  // on_danger: recover の 1 回目の danger（V4-1j §30.3）: 帰らずに立て直す。倒されうる間の立て直しは、階段で階を移る（階段の上・着ける階段。
  // 協力プレイで同じ階に仲間が生きている間は移らない: §30.4）か、回復の手段（能動技が先）。どちらも無ければ、この遠征は帰る（下の帰り方）。
  // 測り直しで分かった: 倒されうるまま立て直しの段（来た道を戻る）へ回すと、速い敵に追われて歩き、10 本すべてが倒れた
  /** recover で、立て直す手が無かったので帰る */
  let recoverNoMeans = false;
  if (danger) {
    const xno = x?.no ?? 0;
    const homeAlready = mem.dangerHome !== null && mem.dangerHome === ctx.orders.rev;
    const leaving7 = ctx.orders.mode === 'return' || ctx.orders.mode === 'stop_at_camp';
    if (p.on_danger === 'recover' && !homeAlready && !leaving7 && mem.dangerRecover !== 'used') {
      const allyHere7 = (obs.party ?? []).some((m) => m.status === 'in_dungeon' && m.floor === depthNow) || (obs.visible.players ?? []).length > 0;
      const viaStairs7 = (p.retreat_via_stairs ?? (!ctx.coop || !allyHere7)) && mem.stairRetreats < 2;
      const st7 = onStairs(obs);
      const esc7 = escapeStairs(obs);
      const h7 = healAction(obs, p, { items: true });
      const step: { tool: string; args: Record<string, unknown>; up?: Partial<PilotMemory>; healed?: boolean } | null =
        viaStairs7 && st7 && can('use_stairs') ? { tool: 'use_stairs', args: {}, up: { crossed: st7.type === 'up' ? 'down' : 'up', stairRetreats: mem.stairRetreats + 1 } }
        : viaStairs7 && esc7 && can('travel_to') ? { tool: 'travel_to', args: { to: `stairs_${esc7}`, ...fleeArgs(obs) } }
        : h7 && can(h7.tool) ? { tool: h7.tool, args: h7.args, healed: true } : null;
      if (step) {
        if (mem.dangerRecover !== 'on') {
          upd({ dangerRecover: 'on' });
          notify.push(W('danger', `danger:${xno}:recover`, `${danger.text}\n立て直す（on_danger: recover。階を移るか回復の手段で。返事は待たない。この遠征でもう一度危なくなったら帰る）`, 'escalate'));
        }
        upd({ recovering: true, ...(step.up ?? {}) });
        if (step.healed) notify.push(W('healed', `healed:${obs.seq}`, healedText(h7!), 'notify'));
        return act(step.tool, step.args);
      }
      recoverNoMeans = true;
    }
  }
  if (danger) {
    const xno = x?.no ?? 0;
    const homeAlready = mem.dangerHome !== null && mem.dangerHome === ctx.orders.rev;
    const lead7 = x && x.status !== 'ended' ? leaderOf(obs, p) : null;
    const leaving7 = ctx.orders.mode === 'return' || ctx.orders.mode === 'stop_at_camp';
    const onFloor7 = !!lead7 && lead7.status === 'in_dungeon' && lead7.floor === depthNow && !!obs.self.pos;
    // 寄るのは、見えているか、follow_distance の内にいる相手（V4-1k: 仲間の位置がいつでも分かるようになったので、見えていない遠くの相手へ、
    // 倒されうるまま歩いて倒れた。遠ければ寄らずに帰る）
    const near7 = onFloor7 && !!lead7!.pos && (!!lead7!.entity || cheb(obs.self.pos!, { x: lead7!.pos[0], y: lead7!.pos[1] }) <= p.coop.follow_distance);
    const seen7 = near7 ? { x: lead7!.pos![0], y: lead7!.pos![1] } : null;
    // 位置が出ない（古いサーバー）: 最後に見た位置（ついていく記録。同じ階のときだけ）
    const fm7 = mem.follow;
    const last7 = !seen7 && onFloor7 && !lead7!.pos && fm7 && fm7.id === lead7!.id && fm7.lastFloor === depthNow && fm7.lastPos ? fm7.lastPos : null;
    const lp7 = seen7 ?? last7;
    if (ctx.coop && lead7 && lp7 && !leaving7 && !homeAlready && mem.dangerJoin !== 'done' && !(mem.dangerJoin === 'going' && obs.self.hp < mem.dangerJoinHp)) {
      if (cheb(obs.self.pos!, lp7) > 1 && can('travel_to')) {
        if (mem.dangerJoin !== 'going') {
          upd({ dangerJoin: 'going', dangerJoinHp: obs.self.hp });
          notify.push(W('danger', `danger:${xno}:join`, `${danger.text}\n帰る前に、${lead7.name} の所へ寄る（1 回だけ${seen7 ? '' : '。見えていないので最後に見た位置へ'}。寄る途中で HP がさらに減ったら帰る）`, 'escalate'));
        }
        return act('travel_to', { to: seen7 ? (allyDest(lead7, ctx.mapCells) ?? lp7) : { x: lp7.x, y: lp7.y }, ...fleeArgs(obs) });
      }
      // 合流した（まだ危ない）: 寄るのはこれで使った。下で帰る
      upd({ dangerJoin: 'done' });
    }
    if (!homeAlready) upd({ dangerHome: ctx.orders.rev });
    notify.push(W('danger', `danger:${xno}:${ctx.orders.rev}:${obs.seq}`, `${danger.text}\n${homeAlready ? '帰る途中' : `${recoverNoMeans ? '立て直す手が無い（階を移れない・回復の手段が無い。on_danger: recover）。' : ''}この遠征は帰る（返事は待たない。rev が上がったら、そちらに従う）`}`, homeAlready ? 'notify' : 'escalate'));
    // 帰り方（V4-1j §30.2。薬が先）: 階段の上なら帰る・階を移る → 着ける階段へ → 回復の手段（能動技が先、品が後。使った後は、次の判断で
    // 階段へ着けるかを見直す）→ 綱 → 追われていても階段へ → 逃げ道が無ければ殴る。
    // 綱は、危ないときの「帰る」では allow_lifeline に関わらず使ってよい（§28.2 の 1「着けなければ綱」。V4-1i の測り直しで、綱を使えないまま
    // 追われて階段へ歩き、倒れた本があった。§30.7 で残す）。綱は半分しか確定しないので、薬で余裕を作って階段へ歩くのが先（§30.2）
    const pd = { ...p, allow_lifeline: false };
    const r = retreat(obs, pd);
    if (r && can(r.tool)) { if (r.tool === 'use_stairs') upd({ crossed: null }); return actR(r); }
    const h = healAction(obs, p, { items: true });
    if (h && can(h.tool)) { notify.push(W('healed', `healed:${obs.seq}`, healedText(h), 'notify')); return act(h.tool, h.args); }
    if (hasLifeline(obs) && can('use_item')) return actR({ tool: 'use_item', args: { slot: 'lifeline' }, why: `危なくて、知っている階段へ着けない（観測の escape）。回復の手段も無い: ${danger.text}` });
    const hw = homewardAction(obs, pd, can, fleeArgs(obs));
    if (hw) return actR(hw);
    const corner7 = adjacentHunting(obs)[0];
    if (corner7 && can('attack')) { why = 'cornered'; return act('attack', { target: corner7.id }); }
    // 何もできない（逃げ道も、殴る相手も無い）: 上げて待つ
    const key = `danger:${xno}:none:${obs.self.hp}:${obs.seq}`;
    fresh(key);
    return wake(W('danger', key, danger.text, 'escalate'));
  }
  const ch = chasers(obs);
  const activeCh = ch.filter((m) => !ignored.has(m.id));
  // 協力プレイ（V4-1f §22.5・V4-1g §24.4）: ついていく相手の状態を先に決める（帰るかどうかは、戦う行より前に要る）
  const leader = x && x.status !== 'ended' ? leaderOf(obs, p) : null;
  const fm = mem.follow && leader && mem.follow.id === leader.id ? mem.follow : null;
  const leaving = ctx.orders.mode === 'stop_at_camp' || ctx.orders.mode === 'return';
  const following = !!leader && leader.status === 'in_dungeon' && !!obs.self.pos && !leaving;
  /** ついていった相手が倒れた（on_party_down） */
  const downLeader = mem.follow && x && x.status !== 'ended' ? (obs.party ?? []).find((m) => m.id === mem.follow!.id && m.status === 'down') : undefined;
  if (downLeader) noteOnce(W('party_down', `party_down:${downLeader.id}:${x?.no ?? ''}`, [lineWith(ctx.text, '仲間: '), `${downLeader.name} が倒れた（on_party_down: ${p.coop.on_party_down}）`].filter(Boolean).join('\n'), 'notify'));
  /** 相手がキャンプに帰った（この遠征で迷宮にいた後）・倒れた（on_party_down: return）: 自分も帰る */
  const followHome = (!!leader && leader.status === 'at_camp' && !!fm?.inDungeon) || (!!downLeader && p.coop.on_party_down === 'return');
  /**
   * 相手を助けに行く（V4-1g §24.4 assist）: ついていく相手の HP が重傷以下。ついていく相手がいない（自分が先頭）ときは、迷宮にいる仲間のうち
   * HP が重傷以下の者（同じ階を先に）。V4-1i B6: Muse の協力では pilot が先頭だったので、助けに行く決まりが働かなかった
   */
  const badHp = (m: ObsPartyMember) => m.hp === 'badly_wounded' || m.hp === 'near_death';
  const assistee: ObsPartyMember | undefined = !p.coop.assist || leaving || !obs.self.pos ? undefined
    : following && leader ? (badHp(leader) ? leader : undefined)
    : ctx.coop ? (obs.party ?? []).filter((m) => m.status === 'in_dungeon' && badHp(m)).sort((a, b) => (a.floor === depthNow ? 0 : 1) - (b.floor === depthNow ? 0 : 1))[0] : undefined;
  const assisting = !!assistee;
  if (assisting && !mem.assisting) { upd({ assisting: true, assistArrived: false }); notify.push(W('assist', `assist:${assistee!.id}:${obs.seq}`, [lineWith(ctx.text, '仲間: '), `${assistee!.name} の HP が ${assistee!.hp === 'near_death' ? '瀕死' : '重傷'}: 探索と拾うのをやめて、助けに行く`].filter(Boolean).join('\n'), 'notify')); }
  if (!assisting && mem.assisting) upd({ assisting: false, assistArrived: false });
  // 着いた（相手が見えていて 2 マス以内）: どの行の命令を出すかにかかわらず、1 回知らせる（隣の敵と戦う行が先に来ても数える。V4-1g の測り直しで分かった）
  const assistDist = assisting && assistee!.pos && assistee!.floor === depthNow && obs.self.pos ? cheb(obs.self.pos, { x: assistee!.pos[0], y: assistee!.pos[1] }) : null;
  if (assistDist !== null && assistDist <= 2 && !mem.assistArrived && !(update?.assistArrived)) { upd({ assistArrived: true }); notify.push(W('assist_arrived', `assist_arrived:${assistee!.id}:${obs.seq}`, `${assistee!.name} の所に着いた（${assistDist} マス）`, 'notify')); }
  /** 道をふさいでいる隣の敵（断りの blocked_by）: 逃げる途中でも、この敵だけは殴る（V4-1g §24.2 の 1） */
  const blockerAdj = (ctx.refusal?.blockedBy ?? []).map((id) => obs.visible.monsters.find((m) => m.id === id && m.dist <= 1)).find((m): m is ObsMonster => !!m);
  // 相手が帰った・倒れた（帰る）: 戦わず休まずに、すぐ帰る（帰る順。道をふさぐ敵だけ殴る。V4-1k §32.3 の 4: ふだんの表のまま、戦いと休みを挟んでいた）。
  // 自分が倒されうるときは、上の 7 が先
  if (followHome && x && x.status !== 'ended') {
    why = 'return';
    if (blockerAdj && can('attack')) return act('attack', { target: blockerAdj.id });
    const hf = homewardAction(obs, p, can, fleeArgs(obs));
    if (hf) return actR(hf);
  }
  // 相手にしないと決めた敵に撃たれた（V4-1g §24.2 の 2）: 立て直しの段の 2 へ直に行く（階段で階を出る）。この遠征では、この階に戻らない
  if (mem.leaveFloor) {
    why = 'leave_floor';
    if (blockerAdj && can('attack')) return act('attack', { target: blockerAdj.id });
    const st0 = onStairs(obs);
    // 1 回目は、休んだ後に戻る（crossed）。同じ相手にまた撃たれた 2 回目（avoidDepths に入った）は戻らない（V4-1h §26.3）
    if (st0 && can('use_stairs')) { upd({ crossed: ctx.avoidDepths?.has(depthNow) ? null : st0.type === 'up' ? 'down' : 'up' }); return act('use_stairs', {}); }
    const to = escapeStairs(obs) ?? nearestStairs(obs)?.type;
    if (to && can('travel_to')) return act('travel_to', { to: `stairs_${to}`, ...fleeArgs(obs) });
  }
  why = 'recover';
  /** 帰ると決めた後（V4-1h §26.1）: mode return・stop_at_camp、相手が帰った・倒れたので帰る、目的の後の帰還 */
  const decidedHome = leaving || followHome || (!following && x?.status === 'objective_complete' && p.after_objective === 'extract');
  /** この数手番に、隣でない相手から被害を受けている（撃たれている） */
  const shotAt = mem.hurtFarAgo !== null && mem.hurtFarAgo <= 2;
  // 8. 立て直しの段（§14.3）: HP が wake_hp_pct を切った、または fight が hp_floor で止まった・断られた、steady が被害で止まった
  const needRecovery = pct < p.wake_hp_pct || mem.recovering;
  // 協力プレイで、ついていく相手（か、ついてくる相手）が重傷以下: 休むより先に助けに行く（自分の HP が減っていても。離れて休むより、一緒にいる
  // ほうが両方にとって安全）。自分が倒されうるときだけ、上の 7 の退く手が先（V4-1j §31.6 の 3。協力の測り直しで、pilot が休んでいる間に、
  // 見えない所で重傷の相方が倒れた）。回復の能動技だけは先に使う（使っても離れない）。助けに行くのは下の「助けに行く」の行
  const assistFirst = assisting && !decidedHome;
  if (needRecovery && assistFirst) {
    const hab = pct < p.wake_hp_pct ? healAction(obs, p, { items: false }) : null;
    if (hab && can(hab.tool)) { notify.push(W('healed', `healed:${obs.seq}`, healedText(hab), 'notify')); return act(hab.tool, hab.args); }
  }
  if (needRecovery && !assistFirst) {
    if (mem.recovering && pct >= p.rest_below_pct && !activeCh.length) upd({ recovering: false, recoverFought: [] });
    else {
      if (!mem.recovering) { upd({ recovering: true }); notify.push(W('recovering', `recovering:${obs.seq}`, alert(obs, 'low_hp')?.text ?? obs.summary, 'notify')); }
      // 0) HP が wake_hp_pct を切っていて、回復の能動技が使える: 使う（使っても減らない。追ってくる敵がいてもいなくても。§16.3）
      const hab = pct < p.wake_hp_pct ? healAction(obs, p, { items: false }) : null;
      if (hab && can(hab.tool)) { notify.push(W('healed', `healed:${obs.seq}`, healedText(hab), 'notify')); return act(hab.tool, hab.args); }
      // 1) 追ってくる敵が見えていない: 休む
      if (!ch.length && !restBlocked(obs) && can('rest')) return act('rest', {});
      // 帰ると決めた後（mode: return・危ないときの帰る・相手が帰った等）: 階を移って休む・来た道を戻るより、帰る手が先（V4-1i の測り直しで分かった:
      // danger で帰ると決めた後、HP が半分を切ったままなので立て直しの「来た道を戻る」を続け、階段へ向かわなかった）
      if (decidedHome) {
        if (blockerAdj && can('attack')) return act('attack', { target: blockerAdj.id });
        const hh = homewardAction(obs, p, can, fleeArgs(obs));
        if (hh) { why = 'return'; return actR(hh); }
        why = 'recover';
      }
      // 2) 知っている階段へ「着ける」: 階段へ行き、階を移って休む（モンスターは階を移らない）。同じ階で 2 回まで。
      //    協力プレイの既定は「仲間を置いていかない」: 同じ階に仲間（ついていく相手・自分についてくる相手）が生きている間は使わない。見えていなくても
      //    （V4-1j §30.4: 見えていない重傷の相方を置いて階を移り、その間に相方が倒れた。§14.3 の決まりを §26 で書き直したときに落としていた）。
      //    retreat_via_stairs: true と書けば移ってよい
      const allyHere = (obs.party ?? []).some((m) => m.status === 'in_dungeon' && m.floor === depthNow) || (obs.visible.players ?? []).length > 0;
      const viaStairs = p.retreat_via_stairs ?? (!ctx.coop || !allyHere);
      if (ch.length && viaStairs && mem.stairRetreats < 2) {
        const st = onStairs(obs);
        if (st && can('use_stairs')) { upd({ crossed: st.type === 'up' ? 'down' : 'up', stairRetreats: mem.stairRetreats + 1 }); return act('use_stairs', {}); }
        const esc = escapeStairs(obs);
        if (esc && can('travel_to')) return act('travel_to', { to: `stairs_${esc}`, ...fleeArgs(obs) });
      }
      // 道をふさいでいる敵（断りの blocked_by）は、どの場面でも殴る
      if (blockerAdj && can('attack')) return act('attack', { target: blockerAdj.id });
      // 3) 隣で追ってくる役割の無い敵がいて、階段へも仲間へも行けない: 殴る（逃げても追ってくる。V4-1h §26.1）。
      //    ただし、帰ると決めた後と、この数手番に隣でない相手から被害を受けている（撃たれている）ときは殴らない（離れるのが先）。
      //    役割のある敵（目的の相手も）とは、HP が減ったまま殴り合わない
      //    殴るのはマクロの fight（決着まで。V4-1h の続き §27.5: 1 手ずつ殴ると命令が多く、行き詰まりに届きやすかった）。hp_floor は、1 手ずつ殴るのを
      //    やめていた線（critical_hp: HP が最大の 25% 未満）と同じ。倒す前に止まったら、この立て直しの間はその相手と fight せず、続き（4 以降）へ進む
      // 断られた相手（refusedTargets）も外す（V4-1i B1: hp_floor で断られた fight を、手番が進まないまま 469 回出し続けた）
      const adjR = adjacentHunting(obs).filter((m) => !isRoleEnemy(m) && !mem.recoverFought.includes(m.id) && !ctx.refusedTargets?.has(m.id))[0];
      if (adjR && !decidedHome && !shotAt && !(ctx.coop && farAlly(obs)) && can('fight')) return act('fight', { target: adjR.id, hp_floor: criticalFloor(obs) });
      // 4) 仲間の隣へ寄る・来た道を戻る
      if (can('travel_to')) {
        const m = moveAway(obs, ctx, mem);
        if (m) return act(m.tool, m.args);
      }
      // 5) 手が尽きた。手が尽きただけでは帰らない（自分から帰るのは lethal_range・critical_hp の「退く」だけ。V4-1h §26.2）。
      //    帰ると決めた後なら、帰る順のとおりに帰る
      if (decidedHome) {
        const h = homewardAction(obs, p, can, fleeArgs(obs));
        if (h) { why = 'return'; return actR(h); }
        why = 'recover';
      }
      //    協力プレイで、ついていく相手が迷宮にいる: 相手の所へ行く（仲間を置いて帰らない）
      const tl = following && leader ? toLeader(obs, leader, fm, stairsOf(obs), depthNow, can, ctx.mapCells) : null;
      if (tl) { why = 'recover_ally'; return act(tl.tool, tl.args); }
      //    相手のそばにいる（または相手の所へ行く手が無い）: 起こさずに、相手のそばで持ち場の動き（隣で追ってくる敵は 1 回殴る・撃たれていれば離れる・
      //    ほかは待つ）。§26.2 の協力プレイは「相手の所へ行く」までで、起こさない（V4-1h の続きの測り直しで分かった: 相手の隣で recover_failed を起こし、
      //    見本が「帰る」と答えて仲間を置いて帰った）
      if (following && leader) {
        why = 'recover_ally';
        const h = holdAction(obs, { ...ctx, homeward: false });
        const r = h ? actR(h) : act('wait', {});
        if (r.decision.kind === 'act' && r.decision.tool === 'wait') r.decision.partyWait = 'follow';
        return r;
      }
      //    追い詰められた（逃げる手がまったく無い）: 隣で追ってくる敵は、道をふさいでいるのと同じなので殴る（cornered を知らせる）。
      //    階段の上にいる・着ける階段がある（この階で階を移る回数を使い切っただけ）なら、逃げ道はある: 殴らずに起こす（V4-1h の測り直しで分かった:
      //    回数を使い切った後に、隣の守護者と HP が減ったまま殴り合っていた）
      const corner = !onStairs(obs) && !escapeStairs(obs) ? adjacentHunting(obs)[0] : undefined;
      if (corner && can('attack')) {
        why = 'cornered';
        notify.push(W('cornered', `cornered:${corner.id}:${obs.seq}`, [lineWith(ctx.text, corner.id), `逃げる手が無い（階段へも、来た道へも行けない）。隣で追ってくる ${corner.name} を殴る`].filter(Boolean).join('\n'), 'notify'));
        return act('attack', { target: corner.id });
      }
      //    それ以外: 起こす（recover_failed）。帰るかどうかは返事役か AI が決める。今の HP・追ってくる敵・試した手を添える
      const key = `recover_failed:${x?.no ?? 0}:${depthNow}`;
      if (fresh(key)) {
        const tried = [
          `HP ${obs.self.hp}/${obs.self.max_hp}（立て直しの線 ${p.wake_hp_pct}%）`,
          `試した手: 休む（追ってくる敵がいてできない）・階段で階を移る（この階で ${mem.stairRetreats} 回${mem.stairRetreats >= 2 ? '。使い切った' : viaStairs ? '。着ける階段が無い' : '。同じ階に仲間がいるので使わない'}）・来た道を戻る（行ける所が無い）`,
          ...activeCh.map((m) => lineWith(ctx.text, m.id) || `- ${m.name} ${m.id}`),
        ];
        return wake(W('recover_failed', key, [`立て直しの手が尽きた（まだ倒されうる状態ではない）。帰るか、続けるかを決めてほしい`, ...tried].join('\n')));
      }
    }
  }
  // 立て直しで階を移って休んだ: 戻る（相手にしない敵に撃たれて出た階には戻らない。V4-1g §24.2 の 2）
  why = 'recover_return';
  if (mem.crossed && ctx.avoidDepths?.has(mem.crossed === 'up' ? depthNow - 1 : depthNow + 1)) upd({ crossed: null });
  else if (mem.crossed && !activeCh.length && pct >= p.rest_below_pct) {
    if (onStairs(obs, mem.crossed) && can('use_stairs')) { upd({ crossed: null }); return act('use_stairs', {}); }
    if (can('travel_to') && obs.navigation.known_stairs.some((s) => s.type === mem.crossed && s.reachable)) return act('travel_to', { to: `stairs_${mem.crossed}` });
    upd({ crossed: null });
  }
  const depth = depthNow;
  const targetDepth = x?.objective.target_depth ?? null;
  why = 'warden';
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
  const complete = x?.status === 'objective_complete';
  // 帰る（mode: return・stop_at_camp・目的を果たした後の既定・大守護者に挑まない・相手が帰った・倒れた）。帰ると決めたら戦わない（V4-1g §24.2 の 1）。
  // ついていく間は、目的を果たした・大守護者に挑まない、では帰らない（相手が帰ったら帰る）
  const homeward = leaving || followHome || (!following && ((complete && p.after_objective === 'extract') || avoidWarden));
  why = 'objective';
  // 9. 役割のある敵が見えている。この遠征の目的の相手なら起こす（engage_objective なら起こさずに挑む）。目的でなければ同じ個体で 1 回だけ知らせる（V4-1e §19.5）
  //    大守護者は warden の方針で決める（engage: 目的か、先へ行くのに要るなら起こさずに挑む。ほかは挑まずに 1 回知らせる）
  /**
   * 挑む: 眠っている・気付いていない相手が離れていれば、先に隣へ寄る（fight は追ってくる相手を待つ手で、追っていない相手には始まらない:
   * no_target「隣に来れば fight で殴れる」。V4-1j の測り直しで分かった: 眠っている目的の守護者に fight を出しては断られ、nothing_to_do で
   * 起こして帰るのを、1 本で 33 回くり返した。ゲームの側の explore の直し（§30.5）で、眠っている守護者を見つけられるようになって表に出た）
   */
  const engage = (m: ObsMonster) => (m.awareness !== 'hunting' && m.dist > 1 && can('travel_to')
    ? act('travel_to', { to: m.id }) : act('fight', fightArgs(obs, p, mem, m.id, ctx.throwKinds, ctx.fightStats)));
  for (const m of obs.visible.monsters.filter(isRoleEnemy).sort((a, b) => a.dist - b.dist)) {
    const reason = roleReason(m);
    const key = `${reason}:${m.id}`;
    if (m.guardian?.warden) {
      if (p.warden === 'engage' && (m.objective || wardenNeeded) && !ctx.refusedTargets?.has(m.id) && !ignored.has(m.id) && !ctx.noThrough?.has(m.id)) {
        notify.push(W(reason, `${key}:engage:${obs.seq}`, lineWith(ctx.text, m.id, m.name), 'notify'));
        return engage(m);
      }
      noteOnce(W(reason, `seen:${m.id}`, lineWith(ctx.text, m.id, m.name), 'notify'));
      continue;
    }
    if (!m.objective) { noteOnce(W(reason, `seen:${m.id}`, lineWith(ctx.text, m.id, m.name), 'notify')); continue; }
    if (p.engage_objective) {
      if (ctx.refusedTargets?.has(m.id) || ignored.has(m.id) || ctx.noThrough?.has(m.id)) continue;
      notify.push(W(reason, `${key}:engage:${obs.seq}`, lineWith(ctx.text, m.id, m.name), 'notify'));
      return engage(m);
    }
    if (fresh(key)) return wake(W(reason, key, lineWith(ctx.text, m.id, m.name)));
  }
  why = 'relic';
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
  why = 'defend';
  if (adjIgnored && can('attack') && !homeward) return act('attack', { target: adjIgnored.id });
  why = 'back_off';
  // fight を待つ間に、見えない相手に撃たれた: 1 回、来た道を戻る（立て直しの段の 4。V4-1d §18.2）
  if (mem.backOff) {
    upd({ backOff: false });
    const back = backtrackTarget(obs, mem);
    if (back && can('travel_to')) return act('travel_to', { to: { x: back.x, y: back.y }, ...fleeArgs(obs) });
  }
  // 12. 追ってくる役割の無い敵と戦う（相手にしない敵・この手番に断られた相手を除く）。fight を待つ間に撃ってきた見えている相手がいれば、その相手から（V4-1d §18.2）
  //     帰ると決めたら戦わない（道をふさぐ敵は帰る行で殴る）。仲間を助けに行く間は、隣の敵とだけ戦う（V4-1g §24.2・§24.4）
  why = assisting ? 'assist' : 'fight';
  const fightable = activeCh.filter((m) => !isRoleEnemy(m) && !ctx.refusedTargets?.has(m.id) && !ctx.noThrough?.has(m.id) && (!assisting || m.dist <= 1));
  const target = p.fight && !homeward ? fightable.find((m) => m.id === mem.shotBy) ?? fightable.sort((a, b) => a.dist - b.dist)[0] : undefined;
  if (target) return act('fight', fightArgs(obs, p, mem, target.id, ctx.throwKinds, ctx.fightStats));
  why = 'trap';
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
  why = assisting ? 'assist' : 'follow';
  /** 仲間を待つ（持ち場の動き。待つ命令には partyWait の印を付ける） */
  const partyWait = (kind: 'follow' | 'start') => {
    const h = holdAction(obs, { ...ctx, homeward: false });
    const r = h ? actR(h) : act('wait', {});
    if (r.decision.kind === 'act') r.decision.partyWait = kind;
    return r;
  };
  // 助けに行く（V4-1g §24.4・V4-1i B6）: 探索と拾うのをやめて、相手の所へ行く（相手を追っている敵がいなくても行く。毒などで弱っていることもある）。
  // 別の階なら相手の階への階段へ、見えていなければ最後に見た位置へ（ついていく相手のとき）、それも無ければこの階で歩いた所を見回る。
  // 着いたら、相手にいちばん近い追ってくる敵と戦う。戦う相手がいなければ、相手のそばで待つ（探索に戻らない）
  if (assisting && assistee && obs.self.pos && !homeward) {
    why = 'assist';
    if (assistee.floor !== undefined && assistee.floor !== depth) {
      const way = assistee.floor > depth ? 'down' : 'up';
      const st = stairs.find((x2) => x2.type === way && x2.reachable && !(way === 'down' && x2.sealed));
      if (st?.dist === 0 && can('use_stairs')) return act('use_stairs', {});
      if (st && can('travel_to')) return act('travel_to', { to: `stairs_${way}`, ...fleeArgs(obs) });
    } else if (assistee.pos) {
      const ap = { x: assistee.pos[0], y: assistee.pos[1] };
      if (cheb(obs.self.pos, ap) > 2) {
        const ta = toAlly(obs, assistee, ctx.mapCells, can, fleeArgs(obs), 2);
        if (ta) return act(ta.tool, ta.args);
      }
      const foe = activeCh.filter((m) => !isRoleEnemy(m) && !ctx.refusedTargets?.has(m.id)).sort((a, b) => cheb(a.pos, ap) - cheb(b.pos, ap))[0];
      if (foe && p.fight && can('fight')) return act('fight', fightArgs(obs, p, mem, foe.id, ctx.throwKinds, ctx.fightStats));
      return partyWait('follow');
    } else {
      const lastPos = following && leader && assistee.id === leader.id ? fm?.lastPos : null;
      if (lastPos && cheb(obs.self.pos, lastPos) > 1 && can('travel_to')) return act('travel_to', { to: { x: lastPos.x, y: lastPos.y }, ...fleeArgs(obs) });
      const t2 = can('travel_to') ? patrolTarget(obs, mem, ctx.walked ?? [], ctx.mapCells ?? []) : null;
      if (t2) return act('travel_to', { to: { x: t2.x, y: t2.y }, ...fleeArgs(obs) });
    }
    return partyWait('follow');
  }
  why = 'follow';
  if (following && leader && obs.self.pos && !homeward) {
    if (leader.floor !== undefined && leader.floor !== depth) {
      // 相手がもう迷宮の別の階にいる: 待たずに、その階へ行く（V4-1k §32.3 の 3。wait_for_party で待つのは、相手がまだキャンプにいる間だけ。
      // 今までは、遠征の最初に hold_max_turns まで待ってから動いていた）
      // 相手にしない敵に撃たれて出た階には戻らない（相手がその階にいる間は、待つ。V4-1g §24.2 の 2）
      if (ctx.avoidDepths?.has(leader.floor)) return partyWait('follow');
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
      // 相手の今の位置（同じ階なら見えていなくても出る。V4-1k §32.3 の 1。最後に見た位置は使わない）
      const lp = { x: leader.pos[0], y: leader.pos[1] };
      const ld = cheb(obs.self.pos, lp);
      if (assisting) {
        // 助けに行く（V4-1g §24.4）: 2 マス以内まで寄る（撃たれても止まらない）。着いたら、相手を追っている敵（相手に近い順）と戦う。
        // 戦い方は、ふだんと同じやり直し（待つ → 寄る → 投げる。fightArgs。V4-1k §32.3 の 5）
        if (ld > 2) { const ta = toAlly(obs, leader, ctx.mapCells, can, fleeArgs(obs), 2); if (ta) return act(ta.tool, ta.args); }
        const foe = activeCh.filter((m) => !isRoleEnemy(m) && !ctx.refusedTargets?.has(m.id)).sort((a, b) => cheb(a.pos, lp) - cheb(b.pos, lp))[0];
        if (foe && p.fight) return act('fight', fightArgs(obs, p, mem, foe.id, ctx.throwKinds, ctx.fightStats));
      }
      // 相手が階段の上に立っている: 移りたいという合図。follow_distance の内でも、隣まで行く。その間、探索と拾うのはやめる（V4-1k §32.3 の 2）
      const onStairs2 = obs.navigation.known_stairs.some((st) => st.pos.x === lp.x && st.pos.y === lp.y);
      if (onStairs2) {
        if (ld > 1) {
          noteOnce(W('leader_on_stairs', `leader_on_stairs:${x?.no ?? 0}:${depth}:${lp.x},${lp.y}`, `${leader.name} が階段の上 (${lp.x},${lp.y}) にいる。隣まで行く`, 'notify'));
          const ts = toAlly(obs, leader, ctx.mapCells, can, steady);
          if (ts) return act(ts.tool, ts.args);
        }
        return partyWait('follow');
      }
      // follow_distance より離れている: 相手の今の位置へ（見ていない所なら、覚えているいちばん近い所へ）
      if (ld > p.coop.follow_distance) {
        const tf = toAlly(obs, leader, ctx.mapCells, can, steady);
        if (tf) return act(tf.tool, tf.args);
      }
    } else if (fm?.lastPos) {
      // 同じ階で見えていない: 最後に見た位置へ（着いても見えなければ、記録を消して探索へ）
      if (cheb(obs.self.pos, fm.lastPos) > 1 && can('travel_to')) return act('travel_to', { to: { x: fm.lastPos.x, y: fm.lastPos.y }, ...(assisting ? fleeArgs(obs) : steady) });
      upd({ follow: { ...fm, lastPos: null } });
    }
  }
  // 13. 敵がいなくて HP が rest_below_pct を切っている: 休む
  why = 'rest';
  if (!ch.length && !restBlocked(obs) && pct < p.rest_below_pct && can('rest')) return act('rest', {});
  // 14. 帰る（homeward は上で決めた）。after_objective: wake なら起こす、continue なら先へ。帰る順は §19.4（階段が先、綱は階段へ着けないときだけ）
  why = 'return';
  if (complete && p.after_objective === 'wake' && !leaving) {
    const key = `objective_done:${x!.no}`;
    if (fresh(key)) return wake(W('objective_done', key, x!.text));
  }
  if (homeward && x) {
    // 道をふさいでいる敵だけは殴る。移動は撃たれても止まらない進み方（flee。V4-1g §24.2 の 1）
    if (blockerAdj && can('attack')) return act('attack', { target: blockerAdj.id });
    const h = homewardAction(obs, p, can, fleeArgs(obs));
    if (h) return actR(h);
    // 帰る手が無い（追い詰められた）: 隣で追ってくる敵は殴る（上の立て直しの段の終わりと同じ）
    const corner = adjacentHunting(obs)[0];
    if (corner && can('attack') && !can('travel_to')) {
      why = 'cornered';
      notify.push(W('cornered', `cornered:${corner.id}:${obs.seq}`, [lineWith(ctx.text, corner.id), `帰る道が無い。隣で追ってくる ${corner.name} を殴る`].filter(Boolean).join('\n'), 'notify'));
      return act('attack', { target: corner.id });
    }
  }
  // 帰りたいのに、着ける階段をまだ知らない: 階段を探して探索する（#17）
  const seekStairs = homeward && !stairs.length;
  // 探す（V4-1f §22.1）: 目的の階で、目的の相手・品がまだ見えていない（覚えてもいない）。大守護者が要るのに見えていない（挑むと決めた後）も同じ。
  //     ついていく間は探さない（相手が行き先を決める）
  const objSeen = obs.visible.monsters.some((m) => m.objective) || obs.visible.items.some((i) => i.objective);
  const seekObjective = !!x && inProgress && SEEK_TYPES.has(x.objective.type) && depth === targetDepth && !objSeen;
  const seekWarden = wardenNeeded && p.warden === 'engage' && !wardenM;
  const seeking = !homeward && !following && (seekObjective || seekWarden);
  why = 'seek';
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
  why = 'descend';
  // 目的の階（か、そこまでの道の階）が、相手にしない敵に撃たれて出た階（V4-1g §24.2 の 2）: 起こす
  if (p.descend && x && !homeward && !following && x.status === 'in_progress' && targetDepth !== null && targetDepth !== depth && ctx.avoidDepths?.size) {
    const lo = Math.min(depth, targetDepth), hi = Math.max(depth, targetDepth);
    const blocked = [...ctx.avoidDepths].filter((d) => d >= lo && d <= hi && d !== depth);
    if (blocked.length) {
      const key = `target_blocked:${x.no}`;
      if (fresh(key)) return wake(W('target_blocked', key, [`目的の階（地下 ${targetDepth} 階）へは、相手にしない敵に撃たれて出た階（地下 ${blocked.join('・')} 階）を通る。この遠征では、その階に戻らない`, x.objective.text, obs.summary].join('\n')));
    }
  }
  // 協力プレイで自分が先頭（ついていく相手がいない）でも、同じ階に仲間が生きている間は、先に階を移らない（V4-1j §30.1）: 階段の上で、
  // 仲間が隣に来るまで待つ（hold_max_turns まで。過ぎたら移る）
  const holdForAlly = (): ReturnType<typeof act> | null => {
    if (!ctx.coop || !obs.self.pos) return null;
    const here = (obs.party ?? []).filter((m) => m.status === 'in_dungeon' && m.floor === depth);
    const away = here.filter((m) => !m.pos || cheb(obs.self.pos!, { x: m.pos[0], y: m.pos[1] }) > 1);
    if (!away.length) return null;
    const since = mem.stairHold && mem.stairHold.depth === depth ? mem.stairHold.since : (ctx.turnNo ?? 0);
    if ((ctx.turnNo ?? 0) - since >= p.hold_max_turns) {
      // 待ち切った: 1 人で階を移る（置いていったのか、待ったうえで進んだのかが、記録で分かるように知らせる。V4-1j §31.6 の 4）
      notify.push(W('moved_without_party', `moved_without_party:${x?.no ?? 0}:${depth}:${ctx.turnNo ?? 0}`, `${away.map((m) => m.name).join('・')} が ${p.hold_max_turns} 手番待っても隣に来なかったので、1 人で階を移る（地下 ${depth} 階から）`, 'notify'));
      return null;
    }
    if (!mem.stairHold || mem.stairHold.depth !== depth) {
      upd({ stairHold: { depth, since } });
      notify.push(W('stairs_hold', `stairs_hold:${x?.no ?? 0}:${depth}`, `階段の上で、${away.map((m) => m.name).join('・')} が隣に来るまで待つ（自分が先頭でも、先に階を移らない。${p.hold_max_turns} 手番まで）`, 'notify'));
    }
    // 待つ命令の理由も stairs_hold（記録 log.jsonl の why で、階段の上で待っていたと分かるように。V4-1k §32.4 の ★8）
    why = 'stairs_hold';
    return partyWait('follow');
  };
  if (p.descend && x && !homeward && !following && x.status === 'in_progress' && targetDepth !== null && depth > targetDepth && !ctx.avoidDepths?.has(depth - 1)) {
    const up = stairs.find((s) => s.type === 'up');
    if (up) {
      if (up.dist === 0 && can('use_stairs')) return holdForAlly() ?? act('use_stairs', {});
      if (up.dist > 0 && can('travel_to')) return act('travel_to', { to: 'stairs_up', ...steady });
    }
  }
  //     目的の階へ下りる（目的が「踏破」なら、目的の階の下り階段に着くまで。continue なら目的の後も下りる）
  if (p.descend && x && !homeward && !following && (x.status === 'in_progress' || (complete && p.after_objective === 'continue'))) {
    const below = targetDepth === null || depth < targetDepth || complete;
    const crossing = x.objective.type === 'reach_depth' && targetDepth !== null && depth === targetDepth;
    if ((below || crossing) && down && !ctx.avoidDepths?.has(depth + 1)) {
      if (down.dist === 0 && below && can('use_stairs')) return holdForAlly() ?? act('use_stairs', {});
      if (down.dist > 0 && can('travel_to')) return act('travel_to', { to: 'stairs_down', ...steady });
    }
  }
  why = 'collect';
  // 16. 引数なしの collect が拾いに行く品がある（観測の navigation.collectable。遺物は collect が拾わない。V4-1a §12.1）
  if (!homeward && p.collect && can('collect') && (obs.navigation.collectable?.count ?? 0) > 0) return act('collect', { what: 'items', ...steady });
  why = seeking ? 'seek' : 'explore';
  // 17. 探索できる所が残っている（目的の階より浅く、下り階段を知らなければ、下への風の方角へ。探す間は、気配の方角へ: §22.1 の 2）
  if ((!homeward || seekStairs) && can('explore') && (obs.navigation.frontiers.length || (obs.navigation.unsighted ?? 0) > 0)) {
    const toward = seeking && x?.sense && !mem.senseOff ? { toward: 'sense' } : (targetDepth === null || depth < targetDepth) && !down && obs.self.floor?.draft ? { toward: 'draft' } : {};
    return out({ kind: 'act', tool: 'explore', args: { pickup: p.collect ? 'useful' : false, ...toward, ...steady }, ...(seeking ? { seek: true } : {}) });
  }
  // 探す（§22.1 の 4）: 探索し終えた階を見回る（この階で立ったことのあるマスのうち、探し始めてから行っていない、いちばん遠い所。気配の方角を先に）
  if (seeking && can('travel_to')) {
    const t2 = patrolTarget(obs, mem, ctx.walked ?? [], ctx.mapCells ?? []);
    if (t2) return out({ kind: 'act', tool: 'travel_to', args: { to: { x: t2.x, y: t2.y }, ...steady }, seek: true });
    const key = `target_not_found:${x!.no}:${depth}`;
    if (fresh(key)) return wake(W('target_not_found', key, [`目的の相手・品を探したが、見回る所が残っていない（${mem.seekTurns} 手番）`, x!.objective.text, x!.sense?.text ?? '', obs.summary].filter(Boolean).join('\n')));
  }
  // 帰りたいのに、知っている階段が無く、探索できる所も残っていない: 綱（allow_lifeline のとき。§19.4）
  if (homeward && x && p.allow_lifeline && hasLifeline(obs) && can('use_item')) return actR({ tool: 'use_item', args: { slot: 'lifeline' }, why: '帰りたいが、知っている階段が無く、探索できる所も残っていない' });
  // ついていく間に、やることが残っていない（相手が同じ階で見えない・相手の階への階段も探索できる所も無い）: 起こさずに待つ（持ち場の動き。V4-1f §22.5）
  why = 'follow';
  if (following) return partyWait('follow');
  why = 'none';
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

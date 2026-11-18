// 音の状態（docs/SOUND_SPEC.md §2）: その人間の画面にすでに出ている情報だけから作る純粋な関数。
// 引数はプレイヤーの視界（PlayerView）と、そのプレイヤーに届いた出来事と、公開のカタログと、前の呼び出しが返した記憶だけ。
// World を受け取らない（未探索・視界の外・シードには触れられない）。同じ入力から同じ音の状態と合図になる。
// 音は演出だけの層で、AI のプレイヤーには何も渡さない（サーバー・MCP・エンジンは使わない）。
import type { Catalog } from './catalog';
import { haulTotal, overreachPoints } from './catalog';
import type { ProjectedEvent } from './filter';
import type { HpState, PlayerView } from './view';
import { hpState } from './view';
import { cheb } from './util';

export type SoundScene = 'camp' | 'explore' | 'alert' | 'combat' | 'guardian' | 'warden' | 'ended';
export type SoundFloorKind = 'standard' | 'sanctuary' | 'warden_hall' | 'other';

/** 続く状態（SOUND_SPEC §2.1）。音のテーマの規則の when はこの名前で書く（depth_band を含む） */
export interface SoundState {
  scene: SoundScene;
  /** 見えている追跡中の敵（逃げている者を除く）の数: 0 体＝0、1 体＝1、2〜3 体＝2、4 体以上＝3 */
  threat: 0 | 1 | 2 | 3;
  hp: HpState;
  /** 地下 1〜4 階＝0、5〜9 階＝1、10〜14 階＝2、15 階より深い＝3 */
  depth_band: 0 | 1 | 2 | 3;
  /** 階の深さ ÷ 5（切り捨て。上限なし） */
  depth_tier: number;
  /** バイオームの ID。キャンプでは none */
  biome: string;
  floor_kind: SoundFloorKind;
  /** 見えている敵が予備動作（構え）を見せている */
  telegraph: boolean;
  /** 目標の気配（画面の気配の表示の遠近） */
  sense: 'none' | 'far' | 'near';
  /** 持ち帰っていない戦利品: 0＝無い、1＝ある、2＝これまでの遠征 1 回の確定の最高を超えている */
  stake: 0 | 1 | 2;
  /** 自分に悪い状態が付いている（状態異常の tone が bad） */
  ailment: boolean;
  /** 自分に良い状態が付いている（状態異常の tone が good） */
  boost: boolean;
}

/** 一度きりの合図（SOUND_SPEC §2.2） */
export const SOUND_CUES = [
  'hit_dealt', 'hit_taken', 'miss', 'crit_dealt', 'crit_taken', 'kill', 'telegraph_start', 'pickup', 'treasure', 'discovery',
  'level_up', 'stairs', 'objective', 'extract', 'lifeline', 'guardian_down', 'warden_down', 'boon', 'near_death', 'death',
] as const;
export type SoundCue = (typeof SOUND_CUES)[number];

/**
 * 前の呼び出しから引き継ぐもの（どれも、それまでに届いた視界と出来事から作ったもの）。
 * 別のプレイヤーの視界に替わったら、前の記憶は使わない（null を渡したのと同じ）
 */
export interface SoundMemory {
  playerId: string;
  /** 最後に自分が攻撃した・攻撃された時点の自分の手番数（直前の 3 手番の戦い） */
  fightTurns: number | null;
  /** 前の体力の帯（瀕死に入った合図） */
  hp: HpState | null;
  /** 前に見えていた、構えている敵（構え始めた合図） */
  telegraphs: string[];
  /** 前に見えていた守護者・大守護者（倒した合図） */
  guardians: string[];
  wardens: string[];
  /** 届いた遠征の終わりで見た、遠征 1 回の確定の最高（stake の 2）。まだ見ていなければ null */
  bestBanked: number | null;
  /** 最後にいた階（ended はこの値のまま） */
  place: { depth: number; biome: string; floorKind: SoundFloorKind } | null;
}

export interface SoundStep { state: SoundState; cues: SoundCue[]; memory: SoundMemory }

/** 「直前の 3 手番のうちに攻撃したか攻撃された」の 3 */
const FIGHT_TURNS = 3;

/** 階の種類の ID から音の状態の階の種類へ（core:standard・core:sanctuary・core:warden_hall。ほかは other） */
export function soundFloorKind(floorType: string): SoundFloorKind {
  const k = floorType.split(':').pop();
  return k === 'standard' || k === 'sanctuary' || k === 'warden_hall' ? k : 'other';
}

/** 階の深さから depth_band と depth_tier */
export function soundDepth(depth: number): { depth_band: 0 | 1 | 2 | 3; depth_tier: number } {
  const tier = Math.max(0, Math.floor(depth / 5));
  return { depth_band: Math.min(3, tier) as 0 | 1 | 2 | 3, depth_tier: tier };
}

/**
 * 音の状態と合図を作る。prev: 前の呼び出しが返した記憶（最初は null）。events: 前の呼び出しの後に、このプレイヤーに届いた出来事（プレイヤー向けに伏せたもの）。
 * 合図は出来事の順。同じ一撃から「当たった」と「会心」は両方は出ない
 */
export function soundStep(prev: SoundMemory | null, view: PlayerView, events: readonly ProjectedEvent[], catalog: Pick<Catalog, 'statuses' | 'items'> & { rules?: Catalog['rules'] }): SoundStep {
  const p = prev && prev.playerId === view.playerId ? prev : null;
  const me = view.self.id;
  const turnsNow = view.self.turns;
  const cues: SoundCue[] = [];
  const once = new Set<string>();
  const push = (c: SoundCue, key?: string) => {
    if (key) { if (once.has(key)) return; once.add(key); }
    cues.push(c);
  };
  let fightTurns = p?.fightTurns ?? null;
  let bestBanked = p?.bestBanked ?? null;
  // 倒した守護者・大守護者: 前に見えていたか、いま見えている（記憶に残すのは、いま見えている者だけ）
  const seenG = view.entities.filter((e) => e.cat === 'monster' && !!e.guardian && !e.guardian.warden).map((e) => e.id).sort();
  const seenW = view.entities.filter((e) => e.cat === 'monster' && !!e.guardian?.warden).map((e) => e.id).sort();
  const guardians = new Set([...(p?.guardians ?? []), ...seenG]);
  const wardens = new Set([...(p?.wardens ?? []), ...seenW]);

  // ---- 届いた出来事から（合図と、直前の戦い） ----
  let last: ProjectedEvent | null = null;
  for (const pe of events) {
    const ev = pe as unknown as Record<string, unknown> & { type: string };
    switch (ev.type) {
      case 'attack': {
        const a = ev as unknown as { attacker: string | null; target: string | null; hit: boolean; crit: boolean };
        if (a.attacker === me) {
          fightTurns = turnsNow;
          push(!a.hit ? 'miss' : a.crit ? 'crit_dealt' : 'hit_dealt');
        } else if (a.target === me) {
          fightTurns = turnsNow;
          if (a.hit) push(a.crit ? 'crit_taken' : 'hit_taken');
        }
        break;
      }
      case 'damaged': {
        const d = ev as unknown as { target: string; source: string | null; via: string };
        const prevAttack = last && (last as { type: string }).type === 'attack' ? (last as unknown as { attacker: string | null; target: string | null }) : null;
        // 攻撃の出来事が無い被害（投げた物・罠など）。毒の刻みでは鳴らさない
        if (d.target === me && d.via !== 'poison' && !(prevAttack && prevAttack.target === me)) {
          if (d.via === 'melee' || d.via === 'ranged' || d.via === 'thrown') fightTurns = turnsNow;
          push('hit_taken');
        } else if (d.source === me && d.target !== me && d.via === 'thrown' && !(prevAttack && prevAttack.attacker === me)) {
          fightTurns = turnsNow;
          push('hit_dealt');
        }
        break;
      }
      case 'item_thrown': {
        const t = ev as unknown as { actor: string | null; outcome?: string };
        if (t.actor === me) { fightTurns = turnsNow; if (t.outcome === 'missed') push('miss'); }
        break;
      }
      case 'died': {
        const d = ev as unknown as { id: string; killer: string | null };
        if (d.id === me) { push('death', 'death'); break; }
        if (d.killer === me) push('kill');
        if (wardens.has(d.id)) push('warden_down', `warden:${d.id}`);
        else if (guardians.has(d.id)) push('guardian_down', `guardian:${d.id}`);
        break;
      }
      case 'warden_slain': push('warden_down', `warden:${(ev as unknown as { id: string }).id}`); break;
      case 'level_up': if ((ev as unknown as { target: string }).target === me) push('level_up', 'level_up'); break;
      case 'item_picked_up': {
        const it = ev as unknown as { actor: string; kind: string | null };
        if (it.actor === me) push(it.kind && catalog.items[it.kind]?.category === 'treasure' ? 'treasure' : 'pickup');
        break;
      }
      case 'haul_changed': if (((ev as unknown as { gains: { discovery?: number } }).gains.discovery ?? 0) > 0) push('discovery'); break;
      case 'entity_changed_floor': if ((ev as unknown as { id: string }).id === me) push('stairs', 'stairs'); break;
      case 'objective_completed': push('objective', 'objective'); break;
      case 'player_state': {
        const s = ev as unknown as { player: string; state: string; reason: string };
        if (s.player !== view.playerId) break;
        if (s.state === 'dead') push('death', 'death');
        else if (s.state === 'at_camp' && s.reason === 'lifeline') push('lifeline', 'lifeline');
        else if (s.state === 'at_camp' && (s.reason === 'extracted' || s.reason === 'withdrew')) push('extract', 'extract');
        break;
      }
      case 'boon_granted': if ((ev as unknown as { target: string }).target === me) push('boon'); break;
      case 'expedition_ended': {
        const r = ev as unknown as { result: { payout?: { players: { player: string; banked: number }[] } } };
        const mine = r.result.payout?.players.find((x) => x.player === view.playerId);
        if (mine) bestBanked = Math.max(bestBanked ?? 0, mine.banked);
        break;
      }
      default: break;
    }
    last = pe;
  }

  // ---- 視界から（続く状態） ----
  const status = view.status;
  const ended = status === 'ended' || status === 'dead' || view.runStatus === 'ended';
  const camp = !ended && status === 'at_camp';
  const pos = view.self.pos;
  const visible = view.entities.filter((e) => e.cat === 'monster');
  const hunting = visible.filter((e) => e.awareness === 'hunting' && !e.fleeing);
  const telegraphs = visible.filter((e) => !!e.intent).map((e) => e.id).sort();
  const seenWarden = visible.some((e) => !!e.guardian?.warden);
  const seenGuardian = visible.some((e) => !!e.guardian && !e.guardian.warden);
  const adjacent = !!pos && hunting.some((e) => cheb(e.pos, pos) <= 1);
  const recentFight = fightTurns !== null && turnsNow - fightTurns < FIGHT_TURNS;
  const scene: SoundScene = ended ? 'ended' : camp ? 'camp' : seenWarden ? 'warden' : seenGuardian ? 'guardian'
    : adjacent || recentFight ? 'combat' : hunting.length ? 'alert' : 'explore';
  const n = hunting.length;
  const threat = (n >= 4 ? 3 : n >= 2 ? 2 : n) as 0 | 1 | 2 | 3;
  const hp = hpState(view.self.stats.hp, view.self.stats.maxHp);
  const f = view.floor;
  const here = f ? { depth: f.depth, biome: f.biome, floorKind: soundFloorKind(f.floorType) } : null;
  const place = camp ? (p?.place ?? null) : here ?? p?.place ?? null;
  const at = camp ? null : place;
  const depth = soundDepth(at?.depth ?? 0);
  const tones = view.self.statuses.map((s) => catalog.statuses[s.id]?.tone);
  // 持ち帰っていない戦利品（観測の戦利品と同じ数え方。遠征の中で、まだ帰っていないとき）
  const x = view.expedition;
  let stake: 0 | 1 | 2 = 0;
  if (x && !camp && !ended && x.status !== 'ended' && !x.extracted) {
    const treasure = view.inventory.reduce((a, i) => a + (i.value ?? 0), 0);
    const total = haulTotal({
      objective: x.status === 'objective_complete' ? x.points : 0,
      overreach: catalog.rules ? overreachPoints(catalog.rules, x.objective.targetDepth, x.crossedDepth, x.points) : 0,
      treasure, bounty: x.haul.bounty, discovery: x.haul.discovery, kills: x.haul.kills,
    });
    // 最高がまだ分からないとき: 確定点が 0 なら最高も 0、そうでなければ「ある」までにとどめる
    const best = bestBanked ?? (view.record.banked === 0 ? 0 : null);
    stake = total <= 0 ? 0 : best !== null && total > best ? 2 : 1;
  }
  const state: SoundState = {
    scene, threat, hp,
    ...depth,
    biome: at?.biome ?? 'none',
    floor_kind: at?.floorKind ?? 'other',
    telegraph: telegraphs.length > 0,
    sense: !camp && !ended && view.sense ? view.sense.range : 'none',
    stake,
    ailment: tones.includes('bad'),
    boost: tones.includes('good'),
  };

  // ---- 状態の移り変わりからの合図 ----
  if (p) {
    for (const id of telegraphs) if (!p.telegraphs.includes(id)) { push('telegraph_start', 'telegraph_start'); break; }
    if (p.hp !== null && p.hp !== 'near_death' && hp === 'near_death' && !camp && !ended) push('near_death', 'near_death');
  }

  const memory: SoundMemory = {
    playerId: view.playerId, fightTurns, hp: camp || ended ? null : hp, telegraphs,
    guardians: seenG, wardens: seenW, bestBanked, place,
  };
  return { state, cues, memory };
}

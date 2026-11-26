// 見返し（S17。SEASON.md §70.6・PROTOCOL §9.16）: 持ち主が、自分の冒険者の、終わった遠征を、シーズンが確定する前でも見返す。
// 見え方は、その場の観戦（追従だけの枠）と同じ: その時点の World を記録（キーフレームと出来事）から作り直し、projectPlayerView を通した見え方と、
// その冒険者に届いた出来事（文になったもの）を、その場の観戦と同じ決まり（session/followFrames.ts）でコマにする。
// - 門は、その場の観戦と同じ関数（SessionManager.seasonWatchAccess。記録だけの終わったランは、同じ中身の watchAccess に記録の参加者を渡す）。
// - World・シード・乱数の状態・歩いていない所・ほかのプレイヤーにしか見えなかったものは、渡さない（巻き戻しの口とは別の口。巻き戻しの守りは変えない）。
// - 読むだけ: ランの記録・プロフィール・シーズンの記録に、何も書かない。作り直しは、ランの本体の World に触らない（キーフレームの写しの上で applyEvent）。
// - 量と負荷: 1 回の求めはコマ pageFrames まで（大きさも pageBytes まで）。作り直した World は少しの間だけ覚える（次の求めを頭から作り直さない）。
//   同時に作るのは concurrent まで（待つのは queued まで。それより多ければ断る）。長い作り直しは sliceMs ごとに譲る（動いているランの命令を待たせない）。
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActionError, AgentActivity, Catalog, CommandRecord, Expedition, GameEvent, PerceivedEvent, PlayerId, ReviewExpedition, ReviewFrame, ReviewListResponse,
  SpectatorPolicy, World,
} from '@muse/shared';
import { actionError, applyEvent, emptyWorld, stripTokenArgs } from '@muse/shared';
import type { RunStore } from '../log/RunStore';
import { logBounds } from '../log/repair';
import { followFlushAtMacroEnd, followFrameDue, followViewOf, livePolicyFor, liveVisibleUpTo, perceiveCommit, splitCommits, withSeasonClosed } from './followFrames';
import type { RunSession } from './RunSession';
import type { WatchAccess, WatchSubject } from './SessionManager';

export interface ReviewLimits {
  /** 1 回の求めで返すコマの数（最初の求めのキャンプの 1 コマは数えない） */
  pageFrames: number;
  /** 1 回の求めの、コマの大きさ（JSON の文字数）。超えたら、そこで区切る（少なくとも 1 コマは返す） */
  pageBytes: number;
  /** 覚えておく、作り直した World の数と、時間 */
  cacheEntries: number;
  cacheMs: number;
  /** 同時に作る数と、待たせる数（それより多ければ 503 で断る） */
  concurrent: number;
  queued: number;
  /** 続けて作る時間（ミリ秒）。これを超えたら、ほかの処理（AI の命令）に譲る */
  sliceMs: number;
  /** 覚えておく、記録だけのランの数（命令の記録と最後のキーフレーム） */
  storedRuns: number;
}

export const REVIEW_LIMITS: ReviewLimits = { pageFrames: 120, pageBytes: 2_000_000, cacheEntries: 6, cacheMs: 90_000, concurrent: 2, queued: 4, sliceMs: 8, storedRuns: 2 };

/** 見返しが要るもの（SessionManager から。循環を避けて、関数で渡す） */
export interface ReviewDeps {
  catalog: Catalog;
  store: RunStore | null;
  policy: SpectatorPolicy;
  delaySeq: number;
  live(runId: string): RunSession | undefined;
  /** その場の観戦の門（動いているラン） */
  gateLive(session: RunSession, o: ReviewAsk): WatchAccess;
  /** 同じ門の中身（記録だけの終わったラン） */
  gateStored(subject: WatchSubject, o: ReviewAsk): WatchAccess;
  seasonFinal(seasonId: string | null | undefined): boolean;
  recoveryFailed(runId: string): ActionError | null;
}

export interface ReviewAsk { local: boolean; profileToken?: string }
export type ReviewResult<T> = { ok: true; body: T } | { ok: false; status: number; error: ActionError };

/** 見返す相手（動いているランか、記録だけの終わったラン）。どれも読むだけ */
interface Subject {
  runId: string;
  session: RunSession | null;
  season: string | null;
  /** 一覧と名前を取る World（動いているランは本体の World: 読むだけで、書き換えない。記録だけのランは最後のキーフレーム） */
  world: World;
  final: boolean;
  /** その場の観戦が、もう見せた所 */
  upTo: number;
  pid: PlayerId;
  /** AI の呼び出しの記録から伏せるトークン（このランのプレイヤーのトークンと、求めの鍵） */
  secrets: string[];
}

/** 記録だけのランの、読んだもの（覚えておく。ファイルの大きさが変われば読み直す） */
interface StoredInfo { at: number; size: number; commands: CommandRecord[]; profiles: Map<PlayerId, string>; world: World | null; covers: (seq: number) => boolean; tokens: string[] }

/** 覚えておく、作り直した World（その遠征の、続きの求めの after の所） */
interface CacheEntry { key: string; world: World; at: number }

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** 命令の種類 → MCP のツールの名前（その場の観戦の、AI の呼び出しの記録の tool と同じ名前） */
const TOOL_OF: Record<string, string> = {
  move: 'move', wait: 'wait', pickup: 'pickup', drop: 'drop', equip: 'equip', unequip: 'unequip', use: 'use_item', throw: 'throw_item', interact: 'interact',
  stairs: 'use_stairs', explore: 'explore', travel: 'travel_to', rest: 'rest', collect: 'collect', fight: 'fight', attack: 'attack', ability: 'use_ability',
  extract: 'extract', start_expedition: 'start_expedition', say: 'say', note: 'notes', retire: 'retire', choose_perk: 'choose_perk', choose_boon: 'choose_boon',
  report_stairs: 'report_stairs', place_fire: 'place_fire', deposit_supply: 'deposit_supply', take_supply: 'take_supply',
};

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** 命令の中身 → MCP の引数の形（名前を snake_case に。fight の with と alsoWith は 1 つの並びに。サーバーが足す lostOk は落とす） */
function argsOf(cmd: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cmd)) {
    if (k === 'type' || k === 'lostOk' || k === 'alsoWith' || v === undefined) continue;
    if (k === 'id' && cmd.type === 'ability') { out.ability = v; continue; }
    out[snake(k)] = v;
  }
  if (cmd.type === 'fight' && Array.isArray(cmd.alsoWith) && cmd.with !== undefined) out.with = [cmd.with, ...cmd.alsoWith];
  return out;
}

/**
 * 命令の記録から、AI の呼び出しの記録（その場の観戦の `agent` と同じ形）を作る: MCP から来た、そのプレイヤーの命令（マクロは元の呼び出し 1 件）。
 * seq は、その命令の出来事の最後の番号（マクロは最後の手の）。thought は記録のもの。応答の文（text）は記録に無いので空。
 * 世界が動かない呼び出し（observe など）は、命令の記録に無いので、出ない
 */
export function activitiesFrom(commands: readonly CommandRecord[], pid: PlayerId, secrets: readonly string[]): (AgentActivity & { first: number })[] {
  const ofParent = new Map<number, [number, number]>();
  const before = new Map<number, number>();
  let last = 0;
  for (const r of commands) {
    before.set(r.cseq, last);
    if (r.resultSeq) {
      last = Math.max(last, r.resultSeq[1]);
      if (r.parent !== undefined) {
        const p = ofParent.get(r.parent);
        ofParent.set(r.parent, p ? [Math.min(p[0], r.resultSeq[0]), Math.max(p[1], r.resultSeq[1])] : [r.resultSeq[0], r.resultSeq[1]]);
      }
    }
  }
  const out: (AgentActivity & { first: number })[] = [];
  for (const r of commands) {
    if (r.player !== pid || r.source !== 'mcp' || r.parent !== undefined) continue;
    const cmd = r.command as unknown as Record<string, unknown>;
    const tool = cmd.type === 'season_sync' ? ((cmd as { reason?: string }).reason === 'report' ? 'report_stairs' : null) : TOOL_OF[String(cmd.type)] ?? null;
    if (!tool) continue;
    const span = r.macro ? ofParent.get(r.cseq) ?? null : r.resultSeq ?? null;
    const b = before.get(r.cseq) ?? 0;
    const args = cmd.type === 'season_sync' ? {} : argsOf(cmd);
    if (r.thought) args.thought = r.thought;
    out.push({ playerId: pid, seq: span ? span[1] : b, first: span ? span[0] : b + 1, tool, args: stripTokenArgs(args, secrets) as Record<string, unknown>, text: '', wall: r.wall });
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** 見返せる遠征（そのプレイヤーが参加して、終わり、その場の観戦がもう見せたもの）。中身は PlayerView の expedition に出ているものだけ */
export function reviewExpeditions(world: World, pid: PlayerId, upTo: number): ReviewExpedition[] {
  return (world.expeditions ?? [])
    .filter((x): x is Expedition & { endSeq: number } => x.participants.includes(pid) && x.endSeq !== null && x.endSeq <= upTo)
    .map((x) => {
      const pay = x.result?.payout;
      const banked = pay ? pay.players.find((p) => p.player === pid)?.banked ?? (x.participants.length === 1 ? pay.banked : null) : null;
      return {
        no: x.no, objective: structuredClone(x.objective), status: x.status, endReason: x.endReason,
        startSeq: x.startSeq, endSeq: x.endSeq, deepest: x.result?.deepest ?? null, banked,
      };
    });
}

/** 同時に作る数の上限（待つのは queued まで） */
class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly limits: () => ReviewLimits) {}

  /** 枠を取る（取れたら、終わったら release を呼ぶ）。待つ列も一杯なら false */
  async acquire(): Promise<boolean> {
    const l = this.limits();
    if (this.active < l.concurrent && !this.waiting.length) { this.active++; return true; }
    if (this.waiting.length >= l.queued) return false;
    // 待つ: 枠は、返した者から、そのまま渡される（数え直す間に、ほかの求めが割り込まない）
    await new Promise<void>((r) => this.waiting.push(r));
    return true;
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  get busy(): number { return this.active + this.waiting.length; }
}

export class ReviewService {
  limits: ReviewLimits = { ...REVIEW_LIMITS };
  private readonly cache: CacheEntry[] = [];
  private readonly stored = new Map<string, StoredInfo>();
  private readonly commandsCache = new Map<string, { size: number; records: CommandRecord[] }>();
  private readonly limiter = new Limiter(() => this.limits);

  constructor(private readonly deps: ReviewDeps) {}

  /** いま作っている・待っている求めの数（テストと運用の確かめ用） */
  get inFlight(): number { return this.limiter.busy; }

  /** 覚えている、作り直した World の数（テスト用） */
  get cached(): number { this.sweep(); return this.cache.length; }

  /** GET /api/runs/:id/review: 見返せる遠征の一覧と、今の居場所（作り直さない。軽い） */
  async list(runId: string, o: ReviewAsk & { follow?: string }): Promise<ReviewResult<ReviewListResponse>> {
    const s = await this.subject(runId, o);
    if (!s.ok) return s;
    const sub = s.body;
    const w = sub.world;
    const pr = w.players[sub.pid];
    const latest = (w.expeditions ?? []).filter((x) => x.participants.includes(sub.pid)).at(-1);
    const state: ReviewListResponse['now']['state'] = w.status === 'ended' ? 'ended' : pr?.state === 'at_camp' ? 'at_camp' : pr?.state === 'alive' ? 'in_dungeon' : 'dead';
    return {
      ok: true,
      body: {
        runId, playerId: sub.pid, name: pr?.name ?? sub.pid, season: sub.season, final: sub.final,
        expeditions: reviewExpeditions(w, sub.pid, sub.upTo),
        now: { state, expedition: state === 'in_dungeon' && latest && latest.endSeq === null ? latest.no : null },
        pageFrames: this.limits.pageFrames,
      },
    };
  }

  /** GET /api/runs/:id/review/:no: 遠征 1 つのコマ（after より後。省けば頭から）。body は応答の JSON の文（ReviewPageResponse） */
  async page(runId: string, no: number, o: ReviewAsk & { follow?: string; after?: number }): Promise<ReviewResult<string>> {
    const s = await this.subject(runId, o);
    if (!s.ok) return s;
    const sub = s.body;
    const x = reviewExpeditions(sub.world, sub.pid, sub.upTo).find((e) => e.no === no);
    if (!x) return fail(404, 'bad_request', `見返せる遠征 ${no} が無い（終わった遠征だけ。進行中の遠征は、その場の観戦で見る） / no expedition ${no} to look back on (only ended ones; watch the one in progress live)`, 'GET /api/runs/:id/review');
    if (o.after !== undefined && (!Number.isInteger(o.after) || o.after < x.startSeq - 1 || o.after > x.endSeq + 1000)) return fail(400, 'bad_request', 'after は、前の応答の next の値 / after must be the previous response\'s next', '');
    if (!(await this.limiter.acquire())) return fail(503, 'bad_request', '見返しの求めが混んでいる。少し待って、もう一度 / too many look-back requests right now; try again shortly', '');
    try {
      return await this.build(sub, x, o.after);
    } finally {
      this.limiter.release();
    }
  }

  // ---------- 見返す相手 ----------

  private async subject(runId: string, o: ReviewAsk & { follow?: string }): Promise<ReviewResult<Subject>> {
    const live = this.deps.live(runId);
    let gate: WatchAccess;
    let world: World;
    let season: string | null;
    let secrets: string[];
    let upTo: number;
    if (live) {
      // その場の観戦の門と同じ関数（ws/hub.ts と同じ）
      gate = this.deps.gateLive(live, o);
      world = live.world;
      season = world.meta.season?.id ?? null;
      secrets = live.knownTokens();
      upTo = liveVisibleUpTo(world, livePolicyFor(world, this.deps.policy), this.deps.delaySeq);
    } else {
      const store = this.deps.store;
      if (!store?.exists(runId)) {
        const f = this.deps.recoveryFailed(runId);
        return f ? { ok: false, status: 503, error: f } : fail(404, 'no_session', `unknown run ${runId}`, '');
      }
      const meta = store.meta(runId);
      // 記録だけで、終わっていないラン（起動時に復旧できなかった）: その場の観戦も開けないので、見返しも開かない
      if (!meta || meta.status !== 'ended') {
        const f = this.deps.recoveryFailed(runId);
        return f ? { ok: false, status: 503, error: f } : fail(404, 'no_session', 'run is not live', '');
      }
      const info = await this.storedInfo(runId);
      if (!info.world) return fail(503, 'bad_request', '記録から作り直せない（読めるキーフレームが無い） / cannot rebuild this run from its records', '');
      season = meta.season ?? null;
      gate = this.deps.gateStored({ seasonId: season, players: meta.players.map((p) => p.id), profileOf: (p) => info.profiles.get(p) ?? null }, o);
      world = info.world;
      secrets = info.tokens;
      upTo = world.seq;
    }
    if ('error' in gate) return { ok: false, status: 403, error: gate.error };
    // 追う相手: 持ち主の鍵なら、その冒険者（その場の観戦と同じ。follow は見ない）。ほかは follow（そのランのプレイヤー）か、最初のプレイヤー
    let pid: PlayerId | undefined;
    if (gate.access === 'owner') pid = gate.pid;
    else if (o.follow !== undefined) {
      if (!world.playerOrder.includes(o.follow) || !Object.hasOwn(world.players, o.follow)) return fail(400, 'bad_request', 'follow is not a player of this run', 'follow を省くか、そのランのプレイヤーの ID（p_…）を渡す');
      pid = o.follow;
    } else pid = world.playerOrder[0];
    if (!pid) return fail(404, 'no_session', 'no player in this run', '');
    if (o.profileToken) secrets = [...secrets, o.profileToken];
    return { ok: true, body: { runId, session: live ?? null, season, world, final: this.deps.seasonFinal(season), upTo, pid, secrets } };
  }

  /** 記録だけの終わったランの、命令の記録（参加者のプロフィール）・最後のキーフレーム・トークン。覚えておく（命令の記録の大きさが変われば読み直す） */
  private async storedInfo(runId: string): Promise<StoredInfo> {
    const store = this.deps.store!;
    const dir = store.dir(runId);
    const size = await stat(join(dir, 'commands.jsonl')).then((st) => st.size, () => 0);
    const hit = this.stored.get(runId);
    if (hit && hit.size === size && Date.now() - hit.at < this.limits.cacheMs) return hit;
    const commands = await readJsonlAsync<CommandRecord>(join(dir, 'commands.jsonl'), this.limits.sliceMs);
    const profiles = new Map<PlayerId, string>();
    for (const r of commands) if (r.command.type === 'join' && r.assigned && (r.command as { profile?: string }).profile) profiles.set(r.assigned, (r.command as { profile: string }).profile);
    const b = logBounds([], commands);
    // 最後の、読めて、記録が覆っているキーフレーム（名前を替えたり、消したりしない）
    let world: World | null = null;
    for (const k of store.keyframeSeqs(runId).reverse()) {
      if (k > b.covered) continue;
      const kf = store.keyframe(runId, k);
      if (kf && kf.seq === k && kf.world?.seq === k) { world = kf.world; break; }
    }
    const info: StoredInfo = { at: Date.now(), size, commands, profiles, world, covers: b.covers, tokens: Object.keys(store.tokens(runId)) };
    this.stored.set(runId, info);
    while (this.stored.size > this.limits.storedRuns) this.stored.delete(this.stored.keys().next().value!);
    return info;
  }

  /** 命令の記録（動いているランは、追記されていくので、大きさが変われば読み直す） */
  private async commandsOf(sub: Subject): Promise<CommandRecord[]> {
    const store = this.deps.store;
    if (!store) return [];
    if (!sub.session) return (await this.storedInfo(sub.runId)).commands;
    const path = join(store.dir(sub.runId), 'commands.jsonl');
    const size = await stat(path).then((st) => st.size, () => 0);
    const hit = this.commandsCache.get(sub.runId);
    if (hit && hit.size === size) return hit.records;
    const records = await readJsonlAsync<CommandRecord>(path, this.limits.sliceMs);
    this.commandsCache.set(sub.runId, { size, records });
    while (this.commandsCache.size > this.limits.storedRuns + 2) this.commandsCache.delete(this.commandsCache.keys().next().value!);
    return records;
  }

  // ---------- 作り直す ----------

  /** その遠征の、出来事の番号の (from, to] の出来事（動いているランは履歴から。記録だけのランは、命令の記録が覆っているものだけ） */
  private async eventsIn(sub: Subject, from: number, to: number): Promise<GameEvent[]> {
    if (sub.session) {
      const h = sub.session.history;
      let lo = 0, hi = h.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (h[mid].seq <= from) lo = mid + 1; else hi = mid; }
      const out: GameEvent[] = [];
      for (let i = lo; i < h.length && h[i].seq <= to; i++) out.push(h[i]);
      return out;
    }
    const info = await this.storedInfo(sub.runId);
    return readEventsRange(join(this.deps.store!.dir(sub.runId), 'events.jsonl'), from, to, info.covers, this.limits.sliceMs);
  }

  /**
   * 作り直しの出発点: seq 以下の、いちばん新しい、読めるキーフレームの World（読んだ写し。無ければ空の World）。
   * キーフレームは読むだけ（読めないものの名前を替えたり、消したりしない）
   */
  private async keyframeAtOrBefore(sub: Subject, seq: number): Promise<World> {
    const store = this.deps.store;
    if (store) {
      for (const k of store.keyframeSeqs(sub.runId).reverse()) {
        if (k > seq) continue;
        try {
          const kf = JSON.parse(await readFile(join(store.dir(sub.runId), 'keyframes', `${k}.json`), 'utf8')) as { seq?: number; world?: World };
          if (kf && kf.seq === k && kf.world?.seq === k) return kf.world;
        } catch { /* 読めない: 1 つ前へ（境目をまたぐなら、後で断る） */ }
      }
    }
    return emptyWorld();
  }

  private async build(sub: Subject, x: ReviewExpedition, after: number | undefined): Promise<ReviewResult<string>> {
    const L = this.limits;
    const target = after ?? x.startSeq - 1;
    // 前の求めの続きなら、覚えておいた World（after の所）から。無ければ、キーフレームから作り直す
    const cached = after !== undefined ? this.takeCached(`${sub.runId}|${sub.pid}|${x.no}|${after}`) : null;
    let t0 = performance.now();
    const pause = async () => { if (performance.now() - t0 >= L.sliceMs) { await yieldNow(); t0 = performance.now(); } };
    const world = cached ?? await this.keyframeAtOrBefore(sub, target);
    // その遠征の終わりの確定まで（終わりの確定には、遠征の終わりの後の出来事も入る: ランの終わりなど）
    const events = await this.eventsIn(sub, world.seq, x.endSeq + 2000);
    const commits = splitCommits(events);
    const endAt = commits.findIndex((c) => c[0].seq <= x.endSeq && c[c.length - 1].seq >= x.endSeq);
    const startAt = commits.findIndex((c) => c[c.length - 1].seq >= x.startSeq);
    if (endAt < 0 || startAt < 0) return fail(503, 'bad_request', '記録から作り直せない（遠征の始まりか終わりの出来事が無い） / cannot rebuild this expedition from its records', '');
    // 食い違いの後の続きの境目（S3h）をまたいで畳まない（境目のキーフレームが読めないとき）
    if (events.some((e) => e.type === 'seq_resumed' && e.seq <= target)) return fail(503, 'bad_request', '記録から作り直せない（境目のキーフレームが読めない） / cannot rebuild this run from its records (a boundary keyframe is unreadable)', '');
    // 出発の所まで畳む（after なら、after で終わる確定まで。頭からなら、遠征を始めた確定の手前まで）
    const stopBefore = after === undefined ? startAt : commits.findIndex((c) => c[0].seq > after);
    const prevEnd = stopBefore > 0 ? commits[stopBefore - 1][commits[stopBefore - 1].length - 1].seq : world.seq;
    if (stopBefore < 0 || stopBefore > endAt || (after !== undefined && prevEnd !== after)) return fail(400, 'bad_request', 'after は、前の応答の next の値 / after must be the previous response\'s next', '');
    let i = 0;
    for (; i < stopBefore; i++) {
      for (const ev of commits[i]) applyEvent(world, ev);
      await pause();
    }
    const frames: string[] = [];
    let bytes = 0;
    const base = world.seq;
    if (after === undefined) {
      // 遠征を始める前（キャンプ）の見え方（出来事なし）: その場の観戦の、つないだ直後の枠と同じ
      const s0 = JSON.stringify({ view: followViewOf(world, sub.pid, sub.final), events: [] } satisfies ReviewFrame);
      frames.push(s0);
      bytes += s0.length;
    }
    const records = await this.commandsOf(sub);
    // 確定（命令の番号 = 出来事の cause）→ マクロの元の呼び出しの番号（マクロの途中の手だけ）
    const parents = new Map<number, number>();
    for (const r of records) if (r.parent !== undefined) parents.set(r.cseq, r.parent);
    const parentOf = (c: readonly GameEvent[] | undefined) => (c && c[0].cause !== null ? parents.get(c[0].cause) : undefined);
    let pending: PerceivedEvent[] = [];
    let unsent = false;
    let count = 0;
    let lastFrameSeq = base;
    for (; i <= endAt; i++) {
      const c = commits[i];
      for (const ev of c) applyEvent(world, ev);
      // 1 コマの区切りは、その場の観戦と同じ関数（followFrameDue・followFlushAtMacroEnd）。コマの出来事は、前のコマより後に届いた、文になったもの（perceiveCommit。
      // RunSession のメッセージの記録と同じ関数）。コマの見え方は、その確定の後の見え方（RunSession.view と同じ: 確定したシーズンは「閉じた」見え方）
      const { view, perceived, messages } = perceiveCommit(world, sub.pid, c, this.deps.catalog);
      pending.push(...messages);
      const parent = parentOf(c);
      const info = { macroStep: parent !== undefined };
      // マクロの終わり: 次の確定が、同じマクロの手でない（その場の観戦は、マクロの止まった知らせで、ためた確定を 1 枠にする）
      const macroEnds = info.macroStep && parentOf(commits[i + 1]) !== parent;
      const due = followFrameDue(perceived, info);
      if (!due) unsent = true;
      if (due || (macroEnds && followFlushAtMacroEnd(unsent))) {
        unsent = false;
        const s1 = JSON.stringify({ view: withSeasonClosed(view, sub.final), events: pending } satisfies ReviewFrame);
        frames.push(s1);
        bytes += s1.length;
        pending = [];
        count++;
        lastFrameSeq = world.seq;
        if (i < endAt && (count >= L.pageFrames || bytes >= L.pageBytes)) { i++; break; }
      }
      await pause();
    }
    const more = i <= endAt;
    // 続きの求めのために、作り直した World を覚えておく（最後のコマの所。ランの本体の World ではない: キーフレームの写し）
    if (more) this.putCached(`${sub.runId}|${sub.pid}|${x.no}|${lastFrameSeq}`, world);
    const end = more ? lastFrameSeq : commits[endAt][commits[endAt].length - 1].seq;
    // AI の呼び出しの記録: その命令の最初の出来事が、このコマの幅に入るもの（マクロは、始まったコマの求めに入る: 考えは、その行動を描く時に出る）
    const from = after ?? base;
    const agent = activitiesFrom(records, sub.pid, sub.secrets).filter((a) => a.first > from && a.first <= end).map(({ first: _f, ...a }) => a);
    const body = `{"runId":${JSON.stringify(sub.runId)},"playerId":${JSON.stringify(sub.pid)},"no":${x.no},"frames":[${frames.join(',')}],"agent":${JSON.stringify(agent)},"next":${more ? lastFrameSeq : 'null'},"range":${JSON.stringify({ startSeq: x.startSeq, endSeq: x.endSeq })}}`;
    return { ok: true, body };
  }

  // ---------- 覚えておく World ----------

  private sweep(): void {
    const now = Date.now();
    for (let i = this.cache.length - 1; i >= 0; i--) if (now - this.cache[i].at > this.limits.cacheMs) this.cache.splice(i, 1);
  }

  /** 取り出す（同じ所の続きを、2 つの求めが同時に進めない: 取り出したら、覚えているものから外す） */
  private takeCached(key: string): World | null {
    this.sweep();
    const i = this.cache.findIndex((e) => e.key === key);
    if (i < 0) return null;
    const [e] = this.cache.splice(i, 1);
    return e.world;
  }

  private putCached(key: string, world: World): void {
    this.sweep();
    const i = this.cache.findIndex((e) => e.key === key);
    if (i >= 0) this.cache.splice(i, 1);
    this.cache.push({ key, world, at: Date.now() });
    while (this.cache.length > this.limits.cacheEntries) this.cache.shift();
  }
}

function fail(status: number, code: Parameters<typeof actionError>[0], message: string, hint: string): { ok: false; status: number; error: ActionError } {
  return { ok: false, status, error: actionError(code, message, hint) };
}

/** JSON の行のファイルを読む（読めない行は飛ばす）。行を区切りながら、sliceMs ごとに譲る */
async function readJsonlAsync<T>(path: string, sliceMs: number): Promise<T[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return []; }
  const out: T[] = [];
  let t0 = performance.now();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end).replace(/^\0+/, '');
    start = end + 1;
    if (line.trim()) { try { out.push(JSON.parse(line) as T); } catch { /* 書きかけの行 */ } }
    if (performance.now() - t0 >= sliceMs) { await yieldNow(); t0 = performance.now(); }
  }
  return out;
}

/**
 * 出来事の記録のうち、番号が (from, to] で、命令の記録が覆っているものだけを読む（大きな記録を全部は解かない: 行の中の "seq":N のどれかが範囲に入る行だけを解く。
 * 本当の番号は、その中のどれかなので、落とさない。解いた後に番号を確かめる）。sliceMs ごとに譲る
 */
async function readEventsRange(path: string, from: number, to: number, covers: (seq: number) => boolean, sliceMs: number): Promise<GameEvent[]> {
  let text: string;
  try { text = await readFile(path, 'utf8'); } catch { return []; }
  const out: GameEvent[] = [];
  const re = /"seq":(\d+)/g;
  let t0 = performance.now();
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    start = end + 1;
    re.lastIndex = 0;
    let hit = false;
    for (let m = re.exec(line); m; m = re.exec(line)) { const n = Number(m[1]); if (n > from && n <= to) { hit = true; break; } }
    if (hit) {
      try {
        const ev = JSON.parse(line.replace(/^\0+/, '')) as GameEvent;
        if (ev.seq > from && ev.seq <= to && covers(ev.seq)) out.push(ev);
      } catch { /* 書きかけの行 */ }
    }
    if (performance.now() - t0 >= sliceMs) { await yieldNow(); t0 = performance.now(); }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

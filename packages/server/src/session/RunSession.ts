// 1 ラン = 1 RunSession。World、コマンド待ち行列（直列化）、マクロ展開、LogWriter、購読者ハブ。
// World に触れるのはこのファイルと PlayerPort / SpectatorPort の実装だけ。
import { randomBytes } from 'node:crypto';
import type { Catalog } from '@muse/shared';
import type { Content } from '@muse/content';
import { createRun, isPlayersTurn, joinPlayer, resumeSeq, seasonSync, step } from '@muse/engine';
import type {
  ActionError, AgentActivity, Command, CommandRecord, CommandSource, Dir, Expedition, ExpeditionReport, GameEvent, JoinCommand, LegacyMonster, MacroStop, ProjectedEvent,
  PerceivedEvent, PlayerId, PlayerView, Pos, ReportCall, RunMetaFile, RunSummary, SeasonSyncCommand, SeqResumeCommand, TurnSnapshot, World,
} from '@muse/shared';
import {
  actionError, applyEvent, buildExpeditionReport, canonicalHash, guardianDisplayName, compareReports, emptyWorld, filterEventsForPlayer, FREE_COMMANDS, MACRO_COMMANDS,
  macroNext, macroStart, macroStopError, narrate, projectPlayerView, publicStairsAt, riskText, fightRiskStop, fightThreats, threatEstimate, seasonReportable, seasonReportableSpots, selfTurnMarks, t,
} from '@muse/shared';
import type { SeasonHooks } from '../season/SeasonService';
import type { ServerConfig } from '../config';
import { LogWriter } from '../log/LogWriter';
import { readJsonl } from '../log/RunStore';
import { cutEventsAfter, isRunMeta, keyframeFromEvents, latestKeyframe, logBounds, metaFromWorld, resumeSeqTarget } from '../log/repair';
import { readJsonStable } from '../log/atomicWrite';
import { summaryMarkdown } from './summary';
import type { ProfileHooks } from './profiles';
import { basename, join } from 'node:path';
import { rmSync } from 'node:fs';

export interface SessionDeps {
  content: Content;
  catalog: Catalog;
  config: ServerConfig;
  /** プロフィール（V3-7）。遠征とランが終わるたびに記録を書き直す */
  profiles?: ProfileHooks;
  /** シーズン（S0。PROTOCOL §9）。シーズンのランの取り込み・報告・記録 */
  season?: SeasonHooks;
}

export interface SessionListener {
  onEvents?(events: GameEvent[]): void;
  onAgent?(a: AgentActivity): void;
  onMacro?(m: { playerId: PlayerId; kind: string; state: 'running' | 'stopped'; steps: number; reason?: string }): void;
}

export interface SubmitOpts {
  source: CommandSource;
  thought?: string;
  expectSeq?: number;
}

/** 応答テキストの表示オプション（IMPROVEMENTS_V3 §1.8） */
export interface PlayerOptions {
  /** auto: 階が変わった・新しいセルを知った・敵の出入りがあった応答だけ地図を付ける */
  map: 'auto' | 'always' | 'never';
  /** on_change: 所持品の行は変わったときだけ */
  inventory: 'on_change' | 'always';
  /** short: 状態が変わらない間は「▶ あなたの番（手番 N）」 */
  status_line: 'short' | 'long';
}
export const DEFAULT_PLAYER_OPTIONS: PlayerOptions = { map: 'auto', inventory: 'on_change', status_line: 'short' };

/** マクロの実績（結果の報告用。PlayerView から計算） */
export interface MacroReport {
  kind: string;
  /** 歩いた手数（explore / travel）。rest は 0 */
  distance: number;
  /** 経過したフロア時間（階を移った場合は null） */
  timeElapsed: number | null;
  hpGained: number;
  /** explore（careful）が止まらずに続けた、遅く離れた追跡中の敵の数（V4-0b §1.4） */
  slowChasers?: number;
  /** fight: 標的を最後に見た場所（V4-0c §4.2） */
  targetSeenAt?: Pos;
  /** explore toward: 始めた所と方角・方角に行ける境界が無かった手・遠回りで近い境界を先にした回数（S1b §12.4 の 4。結果の文で理由を言う） */
  toward?: { kind: 'draft' | 'sense'; dir: Dir | null; start: Pos; noAlong: number; detour: number };
  /** fight: 投げる物が尽きたが、隣に追ってくる敵がいるので床の投げ物を拾いに行かなかった（S1b §12.4 の 5） */
  retrieveHeld?: boolean;
  /** fight・steady・flee: 実際に使った hp_floor（渡した値か既定。S1c §14.4 の 1: 文と食い違わないように） */
  hpFloor?: number;
  /** travel・collect: 動かない敵の隣を避けた遠回り（S1c §14.6 の 1） */
  detour?: { extra: number; around: { id: string; name: string }[] };
  /** 往復（no_progress）で止まったとき、近道をふさいで道を変えさせた動く敵（S3c §33.3 の 2） */
  routeFoes?: { id: string; name: string }[];
}

export type SubmitResult =
  | { ok: true; events: GameEvent[]; startSeq: number; steps?: number; interruptedBy?: MacroStop | 'waiting_others'; macro?: MacroReport }
  | { ok: false; error: ActionError };

const MESSAGE_LOG_CAP = 3000;

export function newRunId(): string {
  return 'run_' + randomBytes(6).toString('hex').slice(0, 10);
}

export function newToken(): string {
  return randomBytes(18).toString('base64url');
}

export class RunSession {
  world: World;
  readonly runId: string;
  readonly history: GameEvent[] = [];
  readonly agentActivity: AgentActivity[] = [];
  createdAt: number;
  updatedAt: number;
  private cseq = 0;
  private readonly tokens = new Map<string, PlayerId>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<SessionListener>();
  private readonly waiters = new Set<() => void>();
  private readonly messageLogs = new Map<PlayerId, PerceivedEvent[]>();
  private readonly lastResultSeq = new Map<PlayerId, number>();
  private readonly timeoutTimers = new Map<PlayerId, { timer: NodeJS.Timeout; key: string }>();
  /** turn.changes の基準（前回の応答時点の要約） */
  private readonly turnSnaps = new Map<PlayerId, TurnSnapshot>();
  /** マクロ展開中のプレイヤー（ターンフィードはこの間 turn を送らない） */
  private readonly macroActive = new Set<PlayerId>();
  /** 最後に入力（コマンド投入）があった時刻 */
  private readonly lastInput = new Map<PlayerId, number>();
  /** 応答テキストの表示オプション（ゲームには影響しない。World の外） */
  private readonly options = new Map<PlayerId, PlayerOptions>();
  /** プレイヤーごとの、送ったコマンドの記録（遠征レポートの呼び出し数・マクロの割合。V3-6 §6） */
  private readonly calls = new Map<PlayerId, ReportCall[]>();
  private readonly macroKinds = new Map<number, string>();
  /** 終了した遠征のレポート（プレイヤー×遠征） */
  private readonly reports = new Map<string, ExpeditionReport>();
  /** 参加コマンドのプロフィールの ID と継承した知識（V3-7。参加コマンドから。復元時も作り直す） */
  private readonly joinInfo = new Map<PlayerId, { profile?: string; legacy?: LegacyMonster[] }>();
  private readonly log: LogWriter | null;
  private lastKeyframeSeq = 0;
  private metaFile: RunMetaFile;
  private closed = false;
  /**
   * 食い違ったランの続きの番号の送り先（SEASON.md §40.2 の 2。復旧で食い違ったときだけ）。続けて最初に記録へ書く前に、
   * システムの命令 seq_resume として確定する（resumeSeqIfNeeded）。null なら送らない
   */
  private pendingSeqResume: number | null = null;

  private constructor(readonly deps: SessionDeps, runId: string, world: World, createdAt: number) {
    this.runId = runId;
    this.world = world;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
    this.log = deps.config.runsDir ? new LogWriter(deps.config.runsDir, runId) : null;
    this.metaFile = this.buildMeta();
  }

  // ---------- 生成・復旧 ----------

  static create(deps: SessionDeps, p: { seed?: string; mode?: 'solo' | 'coop'; runId?: string; wall?: number; season?: { id: string; name: string } }): RunSession {
    const runId = p.runId ?? newRunId();
    const seed = p.seed ?? randomBytes(6).toString('hex');
    const wall = p.wall ?? Date.now();
    const { world, events } = createRun(deps.content, { runId, seed, mode: p.mode ?? 'solo', wall, ...(p.season ? { season: p.season } : {}) });
    const s = new RunSession(deps, runId, world, wall);
    appendAll(s.history, events);
    s.log?.writeMeta(s.metaFile);
    s.log?.appendEvents(events);
    s.writeKeyframe();
    return s;
  }

  /** クラッシュ復旧: 最新キーフレーム＋それ以降の commands.jsonl を再実行し、events.jsonl とハッシュ照合 */
  static recover(deps: SessionDeps, runId: string): { session: RunSession; verified: boolean; message: string } {
    const dir = join(deps.config.runsDir!, runId);
    const mr = readJsonStable<RunMetaFile>(join(dir, 'meta.json'), isRunMeta);
    if (!('value' in mr)) throw new Error('meta.json が読めない');
    const meta = mr.value;
    // 原則（SEASON.md §38.1）: 記録のファイルは、再生が記録と一致したときにだけ直す。ここでは読むだけで、直すことは決めておき、照合の後に行う
    const notes: string[] = [];
    const commands = readJsonl<CommandRecord>(join(dir, 'commands.jsonl'));
    const allEvents = readJsonl<GameEvent>(join(dir, 'events.jsonl'));
    // 記録の範囲（§36.1 の 1）。命令の記録が覆っていない出来事（出来事を追記した後、命令を書く前に落ちた）は、照合にも履歴にも入れない
    const bounds = logBounds(allEvents, commands);
    const orphans = allEvents.filter((e) => e.seq > bounds.covered).length;
    const kept = orphans ? allEvents.filter((e) => e.seq <= bounds.covered) : allEvents;
    const lastKept = kept.length ? kept[kept.length - 1].seq : 0;
    // いちばん新しい、読めて、記録が覆っているキーフレーム（出来事の番号・命令の番号が、どちらも記録の最後以下）。範囲の中で最新のものが
    // 一時的に読めなければ、古いものへ下がらずに失敗する（§38.2 の 2: 長い再実行になり、版をまたいだランでは食い違いに入る）
    const found = latestKeyframe(dir, { moveBroken: false, maxSeq: Math.min(lastKept, bounds.covered), maxCseq: bounds.lastCseq });
    if (found.unreadable) throw new Error(`キーフレーム ${basename(found.unreadable)} を一時的に読めない（ほかのプログラムが開いている）。次の起動で直る`);
    const kf = found.kf ?? keyframeFromEvents(kept, commands, bounds.covered);
    if (!kf) throw new Error(`no keyframe for ${runId}`);
    const s = new RunSession(deps, runId, kf.world, meta.createdAt);
    s.metaFile = meta;
    // 履歴はキーフレーム時点までのログ＋再実行分
    appendAll(s.history, kept.filter((e) => e.seq <= kf.seq));
    // 命令の番号は、キーフレームと記録の大きいほうから続ける（§36.1 の 1）
    s.cseq = Math.max(kf.cseq, bounds.lastCseq);
    // 参加者のプロフィールと継承（参加の命令から）。参加の直後にキーフレームが書かれるので、キーフレームより前の参加も読む
    // （読んでいなかったので、起動し直して復旧したランでは、プロフィールの記録が書き直されず、シーズンの取り込みも止まった。S0 で見つけた）
    for (const rec of commands) {
      if (rec.command.type !== 'join' || !rec.assigned) continue;
      const jc = rec.command;
      s.joinInfo.set(rec.assigned, { ...(jc.profile ? { profile: jc.profile } : {}), ...(jc.legacy ? { legacy: jc.legacy.monsters } : {}) });
    }
    const replayed: GameEvent[] = [];
    for (const rec of commands) {
      if (rec.cseq <= kf.cseq || rec.macro) continue;
      const evs = s.reexecute(rec);
      appendAll(replayed, evs);
    }
    appendAll(s.history, replayed);
    s.rebuildCalls(commands);
    // 目標の宣言（V3-7a）は V3-8 §53.5 で外した。古いランの goals.jsonl は読まない（再実行は commands.jsonl だけで、宣言はゲームに影響しない）
    const logged = kept.filter((e) => e.seq > kf.seq);
    const strip = (es: GameEvent[]) => es.map((e) => ({ ...e, wall: 0 }));
    // 一致と見るのは、照合する範囲の出来事が同じで、かつ再生の終わりの番号が、命令の記録の覆う最後の番号と同じときだけ（SEASON.md §40.2 の 1:
    // 再生が記録より先まで進んだ分を、比べずに捨てていた。今の engine が最後の命令について記録より多くの出来事を出すと、一致と出ていた。
    // 覆う番号まで届かないときも、命令の記録の言う結果と違うので食い違い）
    const replayEnd = s.world.seq;
    const verified = replayEnd === bounds.covered && canonicalHash(strip(logged)) === canonicalHash(strip(replayed.filter((e) => e.seq <= lastKept)));
    // 命令は記録にあるのに、出来事の記録が先に欠けていた（出来事の追記だけが届かなかった）: 照合が一致し、命令の記録の覆う最後の番号が
    // 出来事の記録の最後より大きいときだけ、その番号までの再実行の出来事を足す（§38.2 の 1。食い違いのときは、今の engine の出来事なので足さない）
    const missing = verified && bounds.covered > lastKept ? replayed.filter((e) => e.seq > lastKept && e.seq <= bounds.covered) : [];
    // トークン
    for (const [tok, pid] of Object.entries(s.log?.readTokens() ?? {})) s.tokens.set(tok, pid);
    for (const pid of s.world.playerOrder) s.rebuildMessages(pid);
    s.lastKeyframeSeq = kf.seq;
    const last = s.history[s.history.length - 1];
    if (last) s.updatedAt = last.wall;
    if (verified) {
      // 一致したときだけ、記録を直す（§38.1）: この後にまた追記するので、命令の無い出来事を切り、欠けた出来事を足し、使えないキーフレームを避ける
      if (orphans) { const n = cutEventsAfter(join(dir, 'events.jsonl'), bounds.covered); if (n) notes.push(`命令の記録が覆っていない出来事 ${n} 件を events.jsonl から切った（events.jsonl.uncommitted に残した）`); }
      if (missing.length && s.log) { s.log.appendEvents(missing); notes.push(`出来事の記録に欠けていた ${missing.length} 件を、再実行から足した`); }
      const aside = latestKeyframe(dir, { moveBroken: true, maxSeq: Math.min(lastKept, bounds.covered), maxCseq: bounds.lastCseq, ...(found.kf ? { stopAt: kf.seq } : {}) });
      if (aside.moved.length) notes.push(`読めないキーフレーム ${aside.moved.length} 個の名前を替えた（${aside.moved.map((p) => basename(p)).join(', ')}）`);
      if (aside.ahead.length) notes.push(`記録より先に進んだキーフレーム ${aside.ahead.length} 個の名前を替えた（${aside.ahead.map((p) => basename(p)).join(', ')}）`);
      if (!found.kf) notes.push('読めるキーフレームが無いので、出来事の記録だけから作った');
      // 出来事の記録から作ったとき・キーフレームを避けたときは、キーフレームを書き直す（次に起動し直したときに使う）
      if (!found.kf || aside.moved.length || aside.ahead.length) s.writeKeyframe();
    } else {
      if (orphans || found.skipped) notes.push(`食い違ったので、記録のファイルは直していない（${[orphans ? `命令の記録が覆っていない出来事 ${orphans} 件` : '', found.skipped ? `使えないキーフレーム ${found.skipped} 個` : ''].filter(Boolean).join('・')}は、そのまま）`);
      if (replayEnd > bounds.covered) notes.push(`再生が記録より先まで進んだ（再生の終わり ${replayEnd}、命令の記録の覆う最後 ${bounds.covered}）`);
      else if (replayEnd < bounds.covered) notes.push(`再生が記録の覆う番号まで届かなかった（再生の終わり ${replayEnd}、命令の記録の覆う最後 ${bounds.covered}）`);
      // 続きの出来事の番号を、記録の中のどの番号とも重ねない（SEASON.md §40.2 の 2）。送るのは、続けて最初に記録へ書くとき（読むだけなら何も書かない。§38.1）
      const next = resumeSeqTarget(dir, allEvents, bounds.covered);
      if (next > s.world.seq + 1) {
        s.pendingSeqResume = next;
        notes.push(`続けると、出来事の番号を ${s.world.seq + 1} からでなく ${next} から振る（記録の番号と重ならないように。最初に記録へ書くときに seq_resume として残す）`);
      }
    }
    const message = verified ? `recovered ${runId} (${replayed.length} events re-executed, hash ok)` : `recovered ${runId} with mismatch (logged ${logged.length}, replayed ${replayed.length})`;
    return { session: s, verified, message: notes.length ? `${message}。${notes.join('。')}` : message };
  }

  /** コマンドの記録から、プレイヤーごとの呼び出しの記録を作り直す（復元時） */
  private rebuildCalls(commands: readonly CommandRecord[]): void {
    let lastSeq = 0;
    for (const rec of commands) {
      const pid = rec.player;
      if (pid && rec.source !== 'timeout' && rec.source !== 'system' && rec.command.type !== 'join') {
        if (rec.macro) {
          this.macroKinds.set(rec.cseq, rec.command.type);
          this.pushCall(pid, { seq: lastSeq + 1, kind: 'macro_call', type: rec.command.type });
        } else if (rec.resultSeq) {
          this.pushCall(pid, { seq: rec.resultSeq[0], kind: rec.parent ? 'macro_step' : 'call', type: rec.command.type, ...(rec.parent ? { macro: this.macroKinds.get(rec.parent) } : {}) });
        }
      }
      if (rec.resultSeq) lastSeq = rec.resultSeq[1];
    }
  }

  private pushCall(pid: PlayerId, c: ReportCall): void {
    const list = this.calls.get(pid) ?? [];
    list.push(c);
    this.calls.set(pid, list);
  }

  private reexecute(rec: CommandRecord): GameEvent[] {
    const cmd = rec.command;
    if (cmd.type === 'join') {
      const r = joinPlayer(this.world, this.deps.content, cmd, { cseq: rec.cseq, wall: rec.wall });
      if (r.ok) this.joinInfo.set(r.playerId, { ...(cmd.profile ? { profile: cmd.profile } : {}), ...(cmd.legacy ? { legacy: cmd.legacy.monsters } : {}) });
      return r.events;
    }
    // シーズンの取り込み（S0 §9.7）: 中身は記録に全部ある（シーズンの記録は読まない）
    if (cmd.type === 'season_sync') return seasonSync(this.world, this.deps.content, rec.player!, cmd, { cseq: rec.cseq, wall: rec.wall, thought: rec.thought }).events;
    // 食い違ったランの続きの番号（S3f §40.2 の 2）: 記録の番号で出す
    if (cmd.type === 'seq_resume') return resumeSeq(this.world, this.deps.content, cmd, { cseq: rec.cseq, wall: rec.wall }).events;
    const r = step(this.world, this.deps.content, rec.player!, cmd, { cseq: rec.cseq, wall: rec.wall, thought: rec.thought, auto: rec.source === 'timeout' || rec.source === 'system' });
    return r.events;
  }

  private buildMeta(): RunMetaFile {
    return metaFromWorld(this.world, this.runId, this.createdAt, this.updatedAt);
  }

  // ---------- 記録 ----------

  /**
   * 食い違ったランを続けるとき（SEASON.md §40.2 の 2）: 最初に記録へ書く前に（キューの中から。命令・取り込み・参加・マクロの呼び出しの記録の前）、
   * 出来事の番号を記録の最後の次へ送る。システムの命令 seq_resume を記録し、engine が出来事 seq_resumed をその番号で出す（再実行でも同じ番号）。
   * 送った直後にキーフレームを書く（次の起動では、そこから再生するので一致する）。1 回だけ
   */
  private resumeSeqIfNeeded(): void {
    const next = this.pendingSeqResume;
    // 再生で終わったラン（記録では進行中でも）には書かない: 命令は engine が断る（§40.3 の run_92d0d0cd26 の形）
    if (next === null || this.world.status === 'ended') return;
    this.pendingSeqResume = null;
    if (next <= this.world.seq) return;
    const cseq = this.cseq + 1;
    const wall = Date.now();
    const cmd: SeqResumeCommand = { type: 'seq_resume', next };
    const r = resumeSeq(this.world, this.deps.content, cmd, { cseq, wall });
    if (!r.events.length) return;
    this.cseq = cseq;
    this.commit({ cseq, player: null, command: cmd, source: 'system', wall }, r.events);
    if (this.lastKeyframeSeq !== this.world.seq) this.writeKeyframe();
  }

  /** 続けて最初に記録へ書くときに、出来事の番号を送るか（その送り先。テストと記録の確かめ用） */
  seqResumePending(): number | null {
    return this.pendingSeqResume;
  }

  private writeKeyframe(): void {
    this.lastKeyframeSeq = this.world.seq;
    this.log?.writeKeyframe({ seq: this.world.seq, cseq: this.cseq, world: this.world });
  }

  /** 状態変化を確定させる: ログ、履歴、メッセージ、キーフレーム、購読者、待機者 */
  private commit(rec: Omit<CommandRecord, 'cseq' | 'resultSeq'> & { cseq: number }, events: GameEvent[]): void {
    const resultSeq: [number, number] | null = events.length ? [events[0].seq, events[events.length - 1].seq] : null;
    this.log?.appendEvents(events);
    this.log?.appendCommand({ ...rec, resultSeq });
    appendAll(this.history, events);
    this.updatedAt = rec.wall;
    for (const pid of this.world.playerOrder) this.appendMessages(pid, events);
    const floorChange = events.some((e) => e.type === 'entity_changed_floor' || e.type === 'player_joined'
      || e.type === 'expedition_started' || e.type === 'expedition_ended');
    const ended = events.some((e) => e.type === 'run_ended');
    if (events.length && (floorChange || ended || this.world.seq - this.lastKeyframeSeq >= this.deps.config.keyframeEvery)) this.writeKeyframe();
    if (events.some((e) => e.type === 'player_joined' || e.type === 'run_ended' || e.type === 'player_state' || e.type === 'expedition_ended')) {
      this.metaFile = this.buildMeta();
      this.log?.writeMeta(this.metaFile);
    }
    if (ended) {
      const ev = events.find((e) => e.type === 'run_ended') as Extract<GameEvent, { type: 'run_ended' }>;
      this.log?.writeSummary(ev.summary, summaryMarkdown(ev.summary, this.history, this.deps.catalog));
      for (const t0 of this.timeoutTimers.values()) clearTimeout(t0.timer);
      this.timeoutTimers.clear();
    } else {
      // 遠征の終了ごとに途中経過の記録を書く（キャンプで止めても成績が残る）
      const xe = [...events].reverse().find((e) => e.type === 'expedition_ended') as Extract<GameEvent, { type: 'expedition_ended' }> | undefined;
      if (xe) this.log?.writeSummary(xe.summary, summaryMarkdown(xe.summary, this.history, this.deps.catalog));
    }
    // プロフィール（V3-7）: 参加・遠征の終わり・ランの終わりで記録を書き直す（図鑑・実績の目標の判定より先に）
    if (events.length) this.deps.profiles?.onCommit(this, events);
    // シーズン（S0）: 参加者の記録を書き直し、キャンプに着いたら取り込む（次に積む。いま確定している命令の後、次の命令より前）
    if (events.length && this.world.meta.season && this.deps.season) {
      this.deps.season.onCommit(this, events);
      if (events.some((e) => e.type === 'expedition_ended')) {
        for (const pid of this.world.playerOrder) if (this.world.players[pid].state === 'at_camp') void this.enqueue(() => this.seasonSyncNow(pid, 'camp'));
      }
    }
    if (events.length) for (const l of this.listeners) l.onEvents?.(events);
    for (const w of [...this.waiters]) w();
    this.scheduleTimeouts();
  }

  /** そのプレイヤーの終わった遠征のレポート（古い順） */
  endedReports(pid: PlayerId): ExpeditionReport[] {
    return (this.world.expeditions ?? []).filter((x) => x.participants.includes(pid) && x.endSeq !== null)
      .map((x) => this.expeditionReport(pid, x.no)).filter((r): r is ExpeditionReport => !!r);
  }

  private appendMessages(pid: PlayerId, events: GameEvent[]): void {
    if (!events.length) return;
    const view = projectPlayerView(this.world, pid);
    const pe = filterEventsForPlayer(events, pid, view);
    const ctx = this.narrateCtx(view);
    const log = this.messageLogs.get(pid) ?? [];
    for (const e of pe) {
      const text = narrate(e, ctx);
      if (text) log.push({ seq: e.seq, type: e.type, text, event: e });
    }
    if (log.length > MESSAGE_LOG_CAP) log.splice(0, log.length - MESSAGE_LOG_CAP);
    this.messageLogs.set(pid, log);
  }

  private rebuildMessages(pid: PlayerId): void {
    this.messageLogs.set(pid, []);
    this.appendMessages(pid, this.history.slice(-5000));
    const log = this.messageLogs.get(pid)!;
    this.lastResultSeq.set(pid, log.length ? log[log.length - 1].seq : 0);
  }

  narrateCtx(view: PlayerView) {
    const playerNames: Record<string, string> = {};
    for (const m of view.party) { playerNames[m.entityId] = m.name; playerNames[m.playerId] = m.name; }
    return { locale: view.locale, catalog: this.deps.catalog, selfId: view.self.id, selfPlayerId: view.playerId, playerNames, selfPos: view.self.pos };
  }

  // ---------- 直列化 ----------

  private enqueue<T>(fn: () => T): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  // ---------- 公開 API（PlayerPort / SpectatorPort / Manager から使う） ----------

  join(req: JoinCommand, source: CommandSource): Promise<{ ok: true; playerId: PlayerId; token: string } | { ok: false; error: ActionError }> {
    return this.enqueue(() => {
      // 食い違ったランの続き（§40.2 の 2）: 参加の前に番号を送る（参加者の番号・ID は送った後の World から）
      if (!this.closed) this.resumeSeqIfNeeded();
      const cseq = ++this.cseq;
      const wall = Date.now();
      const token = newToken();
      // 再開用のトークンの控えを、参加を確定する前に書く（SEASON.md §36.1 の 4: 書けなければ参加を断る。World は変えない）。
      // 参加者の ID は、World の写しで同じ参加を試して知る（エンジンは決定論的なので、同じ ID になる）
      let probeId: PlayerId | null = null;
      if (this.log) {
        const probe = joinPlayer(structuredClone(this.world), this.deps.content, req, { cseq, wall });
        if (!probe.ok) { this.cseq--; return { ok: false as const, error: probe.error }; }
        probeId = probe.playerId;
        try {
          this.log.writeTokens({ ...Object.fromEntries(this.tokens), [token]: probe.playerId });
        } catch (e) {
          this.cseq--;
          console.error(`[write] ${this.runId} の tokens.json を書けなかったので、参加を断った: ${String((e as Error).message ?? e).split('\n')[0]}`);
          return { ok: false as const, error: actionError('bad_request', t(req.locale ?? 'ja', 'サーバーが再開用のトークンを記録できなかったので、参加を断った（ランは変わっていない）。少し待って、もう一度。', 'The server could not record your resume token, so the join was refused (the run is unchanged). Try again shortly.'), t(req.locale ?? 'ja', '続くときは、サーバーの管理者に知らせる。', 'If it keeps happening, tell the server operator.')) };
        }
      }
      const r = joinPlayer(this.world, this.deps.content, req, { cseq, wall });
      if (!r.ok) { this.cseq--; return { ok: false as const, error: r.error }; }
      this.joinInfo.set(r.playerId, { ...(req.profile ? { profile: req.profile } : {}), ...(req.legacy ? { legacy: req.legacy.monsters } : {}) });
      this.tokens.set(token, r.playerId);
      if (this.log && probeId !== r.playerId) { try { this.log.writeTokens(Object.fromEntries(this.tokens)); } catch { /* 次の起動で、復旧に失敗したランとして出る */ } }
      this.messageLogs.set(r.playerId, []);
      this.commit({ cseq, player: null, command: req, source, wall, assigned: r.playerId }, r.events);
      this.lastResultSeq.set(r.playerId, 0);
      return { ok: true as const, playerId: r.playerId, token };
    });
  }

  /** そのプレイヤーのプロフィールの ID（V3-7） */
  profileOf(pid: PlayerId): string | null {
    return this.joinInfo.get(pid)?.profile ?? null;
  }

  /** 参加のときに継承した種族の知識（V3-7 §7.3） */
  legacyOf(pid: PlayerId): readonly LegacyMonster[] | null {
    return this.joinInfo.get(pid)?.legacy ?? null;
  }

  /**
   * seq より後に、そのプレイヤーが知覚した他の者の移動（文にならないので出来事の記録には残らない）。
   * 見えなくなった敵の最後に見た位置と向きに使う（V4-0c §4.2）
   */
  movesSince(pid: PlayerId, seq: number): PerceivedEvent[] {
    const slice = this.history.slice(this.indexOfSeq(seq + 1)).filter((e) => e.type === 'entity_moved');
    if (!slice.length) return [];
    const view = this.view(pid);
    return filterEventsForPlayer(slice, pid, view).filter((e) => (e as unknown as { id?: string }).id !== view.self.id)
      .map((e) => ({ seq: e.seq, type: e.type, text: '', event: e }));
  }

  /** その遠征の間に、そのプレイヤーが知覚した出来事（実績の判定。V3-7） */
  expeditionEvents(pid: PlayerId, no: number): ProjectedEvent[] {
    const x = (this.world.expeditions ?? []).find((y) => y.no === no);
    if (!x) return [];
    const slice = this.history.slice(this.indexOfSeq(x.startSeq), this.indexOfSeq((x.endSeq ?? this.world.seq) + 1));
    return filterEventsForPlayer(slice, pid, this.view(pid));
  }

  playerForToken(token: string): PlayerId | null {
    return this.tokens.get(token) ?? null;
  }

  hasToken(token: string): boolean {
    return this.tokens.has(token);
  }

  view(pid: PlayerId): PlayerView {
    return projectPlayerView(this.world, pid);
  }

  isTurn(pid: PlayerId): boolean {
    return isPlayersTurn(this.world, pid);
  }

  /**
   * 遠征レポート（V3-6 §6・§35.9）。no を省くと、そのプレイヤーが参加した最後の遠征。
   * 中身はそのプレイヤーが知覚した出来事（filterEventsForPlayer）と、自分の手番・自分のコマンドの記録だけから作る。終了した遠征は覚えておく
   */
  expeditionReport(pid: PlayerId, no?: number, opts: { endedOnly?: boolean } = {}): ExpeditionReport | null {
    const xs = (this.world.expeditions ?? []).filter((x) => x.participants.includes(pid) && (!opts.endedOnly || x.endSeq !== null));
    const x = no === undefined ? xs[xs.length - 1] : xs.find((y) => y.no === no);
    if (!x) return null;
    const key = `${pid}|${x.no}`;
    const cached = this.reports.get(key);
    if (cached) return cached;
    const r = this.buildReport(pid, x);
    if (x.endSeq === null) return r;
    const prevs = xs.filter((y) => y.no < x.no && y.endSeq !== null).map((y) => this.expeditionReport(pid, y.no)).filter((y): y is ExpeditionReport => !!y);
    const cmp = compareReports(this.view(pid).locale, r, prevs);
    if (cmp) r.compare = cmp;
    this.reports.set(key, r);
    return r;
  }

  private buildReport(pid: PlayerId, x: Expedition): ExpeditionReport {
    const view = this.view(pid);
    const from = x.startSeq;
    const to = x.endSeq ?? this.world.seq;
    const i0 = this.indexOfSeq(from);
    const i1 = this.indexOfSeq(to + 1);
    const slice = this.history.slice(i0, i1);
    // 遠征の前から正体を知っていた見た目（自分の item_identified）
    const known = new Set<string>();
    for (let i = 0; i < i0; i++) {
      const e = this.history[i];
      if (e.type === 'item_identified' && e.player === pid && e.appearanceId) known.add(e.appearanceId);
    }
    const ctx = this.narrateCtx(view);
    return buildExpeditionReport({
      locale: view.locale, catalog: this.deps.catalog, selfId: view.self.id, no: x.no,
      events: filterEventsForPlayer(slice, pid, view), marks: selfTurnMarks(slice, view.self.id),
      calls: (this.calls.get(pid) ?? []).filter((c) => c.seq >= from && c.seq <= to),
      knownAppearances: known, milestone: this.deps.catalog.rules?.milestone,
      // 大守護者の個体（V4-0a §1.3）: 生きている大守護者と、倒れた大守護者（履歴の warden_slain）。節目の深さの守護者を大守護者と数えない
      wardenIds: this.wardenIds(),
      // 公開されている名前だけ（節目の大守護者、この遠征の目的の守護者）
      guardianNames: {
        ...(x.milestone ? { warden: { [x.milestone.depth]: guardianDisplayName(view.locale, x.milestone) } } : {}),
        ...(x.guardianName ? { objective: guardianDisplayName(view.locale, { name: x.guardianName, ...(x.guardianTitle ? { title: x.guardianTitle } : {}) }) } : {}),
      },
      narrate: (e) => narrate(e, ctx) ?? '',
      ...(x.targets.bounty ? { bountyIds: [x.targets.bounty] } : {}),
    });
  }

  /** 大守護者の個体の ID（生きている個体と、履歴で倒れた個体） */
  private wardenIds(): string[] {
    const ids = new Set<string>();
    for (const e of Object.values(this.world.entities)) if (e.guardian?.warden) ids.add(e.id);
    for (const e of this.history) if (e.type === 'warden_slain' && e.id) ids.add(e.id);
    return [...ids];
  }

  /** seq 以上の最初の出来事の位置（履歴は seq 順） */
  private indexOfSeq(seq: number): number {
    let lo = 0, hi = this.history.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.history[mid].seq < seq) lo = mid + 1; else hi = mid; }
    return lo;
  }

  messages(pid: PlayerId): PerceivedEvent[] {
    return this.messageLogs.get(pid) ?? [];
  }

  /** 前回の行動結果以降に知覚した出来事（消費しない） */
  pendingFor(pid: PlayerId): PerceivedEvent[] {
    const since = this.lastResultSeq.get(pid) ?? 0;
    return this.messages(pid).filter((m) => m.seq > since);
  }

  /** 行動結果として返した分を既読にする */
  consumeFor(pid: PlayerId): PerceivedEvent[] {
    const out = this.pendingFor(pid);
    this.lastResultSeq.set(pid, this.world.seq);
    return out;
  }

  addListener(l: SessionListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  playerOptions(pid: PlayerId): PlayerOptions {
    return this.options.get(pid) ?? DEFAULT_PLAYER_OPTIONS;
  }

  setPlayerOptions(pid: PlayerId, o: Partial<PlayerOptions>): PlayerOptions {
    const next = { ...this.playerOptions(pid), ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) } as PlayerOptions;
    this.options.set(pid, next);
    return next;
  }

  turnSnapshot(pid: PlayerId): TurnSnapshot | null {
    return this.turnSnaps.get(pid) ?? null;
  }

  setTurnSnapshot(pid: PlayerId, s: TurnSnapshot): void {
    this.turnSnaps.set(pid, s);
  }

  isMacroRunning(pid: PlayerId): boolean {
    return this.macroActive.has(pid);
  }

  lastInputAt(pid: PlayerId): number {
    return this.lastInput.get(pid) ?? this.createdAt;
  }

  /** 現在の手番の識別子（同じ手番かどうかの判定用） */
  turnKeyOf(pid: PlayerId): string {
    return this.turnKey(pid);
  }

  recordAgentActivity(a: AgentActivity): void {
    this.agentActivity.push(a);
    if (this.agentActivity.length > 50) this.agentActivity.shift();
    for (const l of this.listeners) l.onAgent?.(a);
  }

  /** 状態が変わるか timeoutMs 経過まで待つ */
  waitChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(done);
    });
  }

  /** 自分の手番かランの終了まで待つ。手番が来たら true */
  async waitForTurn(pid: PlayerId, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.world.status === 'ended' || this.world.players[pid]?.state !== 'alive') return false;
      if (this.isTurn(pid)) return true;
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await this.waitChange(left);
    }
  }

  /** コマンドを投入する。マクロはここで基本行動に展開する（AI も人間も同じ） */
  async submit(pid: PlayerId, cmd: Command, opts: SubmitOpts): Promise<SubmitResult> {
    const pr = this.world.players[pid];
    if (!pr) return { ok: false, error: actionError('no_session', 'no such player', 'resume_run') };
    this.lastInput.set(pid, Date.now());
    if (opts.expectSeq !== undefined && opts.expectSeq !== this.world.seq && !FREE_COMMANDS.has(cmd.type)) {
      return {
        ok: false,
        error: actionError('stale_turn', t(pr.locale, `前提の seq ${opts.expectSeq} は古い（現在 ${this.world.seq}）。`, `expect_seq ${opts.expectSeq} is stale (now ${this.world.seq}).`), t(pr.locale, 'observe で最新の状態を取得してから行動する。', 'Call observe and act on the latest state.')),
      };
    }
    if (MACRO_COMMANDS.has(cmd.type) || (cmd.type === 'wait' && (cmd.turns ?? 1) > 1)) return this.runMacro(pid, cmd, opts);
    // シーズン（S0 §9.4）: 階段の報告はサーバーが共有層に問い合わせ、season_sync として記録する
    if (cmd.type === 'report_stairs') return this.enqueue(() => this.reportNow(pid, opts));
    // シーズン（S0 §9.4）: 遠征を始めるときに取り込む（予算・終わりの時刻・公開された階段・順位）
    if (cmd.type === 'start_expedition' && this.world.meta.season && this.deps.season && pr.state === 'at_camp') {
      return this.enqueue(() => { this.seasonSyncNow(pid, 'start'); return this.stepNow(pid, cmd, opts.source, opts.thought); });
    }
    return this.enqueue(() => this.stepNow(pid, cmd, opts.source, opts.thought));
  }

  /** シーズンの取り込みを、キューの中で。参加の直後に SessionManager が呼ぶ */
  syncSeason(pid: PlayerId, reason: 'join' | 'camp' | 'start'): Promise<SubmitResult> {
    return this.enqueue(() => this.seasonSyncNow(pid, reason));
  }

  /**
   * シーズンの取り込み（S0 §9.7）: 共有層の今の写しを、システムの命令 season_sync として記録して流す（キューの中から呼ぶ）。
   * report: 報告の結果（送った者の source と thought で記録する）
   */
  private seasonSyncNow(pid: PlayerId, reason: SeasonSyncCommand['reason'], src: { source: CommandSource; thought?: string } = { source: 'system' }, report?: SeasonSyncCommand['report']): SubmitResult {
    if (this.closed || !this.world.meta.season || !this.deps.season || this.world.status === 'ended') return { ok: false, error: actionError('bad_request', 'not a season run', '') };
    const season = this.deps.season.sync(this, pid);
    if (!season) return { ok: false, error: actionError('bad_request', 'this player is not a participant of the season', '') };
    const cmd: SeasonSyncCommand = { type: 'season_sync', reason, season, ...(report ? { report } : {}) };
    this.resumeSeqIfNeeded();
    const startSeq = this.world.seq;
    const cseq = this.cseq + 1;
    const wall = Date.now();
    const r = seasonSync(this.world, this.deps.content, pid, cmd, { cseq, wall, thought: src.thought });
    if (!r.ok) return { ok: false, error: r.error };
    this.cseq = cseq;
    this.commit({ cseq, player: pid, command: cmd, source: src.source, wall, thought: src.thought }, r.events);
    return { ok: true, events: r.events, startSeq };
  }

  /** report_stairs（S0 §9.4・S1c §14.5）: キャンプでだけ。このランで自分の目で見た下り階段と特別な場所のうち、まだ報告していないものを全部送る */
  private reportNow(pid: PlayerId, opts: SubmitOpts): SubmitResult {
    const pr = this.world.players[pid];
    const L = pr.locale;
    if (!this.world.meta.season || !this.deps.season) return { ok: false, error: actionError('bad_request', t(L, 'report_stairs はシーズンのランだけで使える。', 'report_stairs works only in a season run.'), '') };
    if (pr.state !== 'at_camp' || this.world.status === 'ended') {
      return { ok: false, error: actionError('not_at_camp', t(L, '階段の報告はキャンプでだけできる。', 'You can report stairs only at camp.'), t(L, '階段から帰るか、遠征を終えてから。', 'Return to camp first.')) };
    }
    const list = seasonReportable(this.world, pid);
    // 特別な場所（S1c §14.5。祭壇・賭けの祭壇・碑文）も、まとめて送る
    const spots = seasonReportableSpots(this.world, pid);
    if (!list.length && !spots.length) return { ok: false, error: actionError('nothing_to_do', t(L, 'このランで見た下り階段と特別な場所（部屋の作りにある祭壇・賭けの祭壇・碑文）は、全部報告してある。', 'You have already reported every down staircase and special place (built-in altar, altar of chance, inscription) you saw in this run.'), t(L, '新しく見つけたら、キャンプでまた報告できる。', 'Find new ones and report them at camp.')) };
    const res = this.deps.season.report(this, pid, list, spots);
    if (!res) return { ok: false, error: actionError('season_ended', t(L, 'このシーズンは結果が確定している。報告はもう受け付けない。', 'This season has been finalized; reports are no longer accepted.'), '') };
    return this.seasonSyncNow(pid, 'report', { source: opts.source, thought: opts.thought }, res);
  }

  private stepNow(pid: PlayerId, cmd: Command, source: CommandSource, thought?: string, parent?: number): SubmitResult {
    if (this.closed) return { ok: false, error: actionError('no_session', 'session closed', '') };
    this.resumeSeqIfNeeded();
    const startSeq = this.world.seq;
    const cseq = this.cseq + 1;
    const wall = Date.now();
    const r = step(this.world, this.deps.content, pid, cmd, { cseq, wall, thought, auto: source === 'timeout' || source === 'system' });
    if (!r.ok && !r.events.length) return { ok: false, error: r.error };
    this.cseq = cseq;
    // 呼び出しの記録は確定の前に（確定の中で遠征レポートが作られ、残る。V3-7 のプロフィールの更新）
    if (source !== 'timeout' && source !== 'system' && r.events.length) this.pushCall(pid, { seq: r.events[0].seq, kind: parent ? 'macro_step' : 'call', type: cmd.type, ...(parent ? { macro: this.macroKinds.get(parent) } : {}) });
    this.commit({ cseq, player: pid, command: cmd, source, wall, thought, parent }, r.events);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, events: r.events, startSeq };
  }

  private async runMacro(pid: PlayerId, cmd: Command, opts: SubmitOpts): Promise<SubmitResult> {
    const startSeq = this.world.seq;
    const startView = this.view(pid);
    if (startView.status === 'dead') return { ok: false, error: actionError('dead', t(startView.locale, 'あなたは死んでいる。', 'You are dead.'), '') };
    if (startView.status === 'ended') return { ok: false, error: actionError('run_ended', t(startView.locale, 'ランは終了している。', 'The run has ended.'), '') };
    if (startView.status === 'at_camp') return { ok: false, error: actionError('at_camp', t(startView.locale, 'あなたはキャンプにいる（盤面にいない）。', 'You are at camp (off the board).'), t(startView.locale, 'start_expedition { offer } で次の遠征を始める。ここで終えてもよい。', 'Start the next expedition with start_expedition { offer }, or stop here.')) };
    if (startView.status !== 'your_turn') {
      return { ok: false, error: actionError('not_your_turn', t(startView.locale, 'まだあなたの番ではない。', 'It is not your turn yet.'), t(startView.locale, 'observe で手番を待つ。', 'Call observe to wait.')) };
    }
    // 1 歩も進めないと分かるなら、手番を使わずに理由付きで拒否する（V3-2R §14.2）
    {
      const probe = macroStart(startView, cmd, this.deps.catalog);
      const d0 = macroNext(probe, startView, this.deps.catalog, []);
      if ('stop' in d0) {
        const err = macroStopError(startView.locale, d0.stop, cmd, d0.dir, d0.blockedBy, d0.traps, d0.explored);
        // fight の被弾の前の断り（S1c §14.4 の 1）: 見込みと最悪の 2 つの数・いまの HP・実際に使った hp_floor
        if ((d0.stop === 'hp_risk' || (d0.stop === 'hp_floor' && cmd.type === 'fight')) && startView.self.pos) {
          if (d0.stop === 'hp_risk') err.message += ' ' + riskText(startView, this.deps.catalog, probe.hpFloor);
          // 死にうる（S1d の 1 つ目の判定）なら、hp_floor を下げても始められない。「hp_floor を下げる」と言わない（S2a §20.10 の 3）。
          // HP がもう hp_floor 以下で断るとき（判定が先に効く）も同じ（S2b）
          const est = threatEstimate(startView, this.deps.catalog, fightThreats(this.deps.catalog, startView.entities.filter((e) => e.cat === 'monster'), startView.self.pos));
          if (fightRiskStop(startView.self.stats.hp, 0, est) === 'lethal') {
            if (d0.stop === 'hp_floor') err.message += t(startView.locale, `（しかも最悪の 1 手 ${est.worst} で倒れうる: HP ${startView.self.stats.hp}。hp_floor を下げても戦えない）`, ` (and one worst turn of ${est.worst} could kill you at HP ${startView.self.stats.hp}; lowering hp_floor does not help)`);
            err.hint = t(startView.locale, '最悪の 1 手で倒れうる間は、hp_floor によらず始められない。退く（mode: flee・帰還の綱）か、回復してから。', 'While one worst turn could kill you, fight does not start whatever hp_floor is. Retreat (mode: flee, the lifeline) or heal first.');
          }
        }
        // 公開された階段（S0 §9.4）: 地図に載っていても途中の道は分からない。下への風の方角を探す手を出す
        const pub = startView.floor ? publicStairsAt(startView.season, startView.floor.depth) : null;
        if (pub && d0.stop === 'unreachable' && cmd.type === 'travel' && cmd.to === 'stairs_down' && (startView.memory.unsighted ?? []).includes(pub.y * startView.floor!.width + pub.x)) {
          err.hint = t(startView.locale, `この下り階段は公開されたもの（${pub.by} が報告）で、途中の道はまだ分からない。explore { toward: 'draft' } で下への風の方角を探す。`, `These stairs were published (reported by ${pub.by}); the way there is still unknown. Use explore { toward: 'draft' } to search toward the draft.`);
        }
        return { ok: false, error: err };
      }
    }
    // 元の呼び出し 1 件（イベント無し）を記録
    const parent = await this.enqueue(() => {
      // 食い違ったランの続き（§40.2 の 2）: マクロの呼び出しの記録より前に番号を送る
      if (!this.closed) this.resumeSeqIfNeeded();
      const c = ++this.cseq;
      this.log?.appendCommand({ cseq: c, player: pid, command: cmd, source: opts.source, macro: true, thought: opts.thought, wall: Date.now(), resultSeq: null });
      this.macroKinds.set(c, cmd.type);
      if (opts.source !== 'timeout' && opts.source !== 'system') this.pushCall(pid, { seq: this.world.seq + 1, kind: 'macro_call', type: cmd.type });
      return c;
    });
    const state = macroStart(this.view(pid), cmd, this.deps.catalog);
    const all: GameEvent[] = [];
    let lastEvents: GameEvent[] = [];
    let stop: MacroStop | 'waiting_others' = 'step_limit';
    let firstError: ActionError | null = null;
    this.macroActive.add(pid);
    for (const l of this.listeners) l.onMacro?.({ playerId: pid, kind: cmd.type, state: 'running', steps: 0 });
    try {
    for (;;) {
      if (!this.isTurn(pid)) {
        const got = await this.waitForTurn(pid, this.deps.config.waitOthersMs);
        // シーズンの予算が尽きてキャンプへ戻された（S0 §9.2）は time_up
        if (!got) { stop = this.world.status === 'ended' ? 'run_ended' : this.world.players[pid].state === 'at_camp' && this.world.season ? 'time_up' : this.world.players[pid].state !== 'alive' ? 'dead' : 'waiting_others'; break; }
      }
      const res = await this.enqueue(() => {
        const view = this.view(pid);
        const perceived = filterEventsForPlayer(lastEvents, pid, view);
        const d = macroNext(state, view, this.deps.catalog, perceived);
        if ('stop' in d) return { stop: d.stop };
        const r = this.stepNow(pid, d.command, 'macro', state.steps === 1 ? opts.thought : undefined, parent);
        return { r };
      });
      if ('stop' in res) { stop = res.stop!; break; }
      const r = res.r!;
      if (!r.ok) { firstError = r.error; stop = 'error'; break; }
      appendAll(all, r.events);
      lastEvents = r.events;
      if (state.steps % 5 === 0) for (const l of this.listeners) l.onMacro?.({ playerId: pid, kind: cmd.type, state: 'running', steps: state.steps });
    }
    } finally {
      this.macroActive.delete(pid);
    }
    for (const l of this.listeners) l.onMacro?.({ playerId: pid, kind: cmd.type, state: 'stopped', steps: state.steps, reason: stop });
    if (firstError && state.steps <= 1 && !all.length) return { ok: false, error: firstError };
    const end = this.view(pid);
    const sameFloor = end.floor?.key === state.floorKey;
    const macro: MacroReport = {
      kind: cmd.type,
      distance: cmd.type === 'rest' ? 0 : all.filter((e) => e.type === 'entity_moved' && e.id === end.self.id).length,
      timeElapsed: sameFloor && end.floor ? end.floor.time - state.startTime : null,
      hpGained: end.self.stats.hp - state.startHp,
      ...(state.slowChasers?.length ? { slowChasers: state.slowChasers.length } : {}),
      ...(state.targetSeenAt ? { targetSeenAt: { ...state.targetSeenAt } } : {}),
      ...(cmd.type === 'explore' && cmd.toward && startView.self.pos ? { toward: { kind: cmd.toward, dir: state.towardDir ?? null, start: { ...startView.self.pos }, noAlong: state.towardNoAlong ?? 0, detour: state.towardDetour ?? 0 } } : {}),
      ...(state.retrieveHeld ? { retrieveHeld: true } : {}),
      hpFloor: state.hpFloor,
      ...(state.detour ? { detour: structuredClone(state.detour) } : {}),
      ...(stop === 'no_progress' && state.noProgressBy?.length ? { routeFoes: structuredClone(state.noProgressBy) } : {}),
    };
    return { ok: true, events: all, startSeq, steps: state.steps, interruptedBy: stop, macro };
  }

  /** COOP: 同一フロアで他プレイヤーを待たせているときのタイムアウト（wait を source:'timeout' で投入） */
  private scheduleTimeouts(): void {
    const ms = this.world.meta.options.turnTimeoutMs;
    if (ms === null || this.world.status === 'ended') return;
    for (const [pid, t0] of this.timeoutTimers) {
      if (!this.isTurn(pid) || t0.key !== this.turnKey(pid)) { clearTimeout(t0.timer); this.timeoutTimers.delete(pid); }
    }
    for (const pid of this.world.playerOrder) {
      if (!this.isTurn(pid) || this.timeoutTimers.has(pid)) continue;
      const e = this.world.entities[this.world.players[pid].entityId];
      const others = this.world.playerOrder.some((o) => o !== pid && this.world.players[o].state === 'alive'
        && this.world.entities[this.world.players[o].entityId]?.pos?.floor === e.pos?.floor);
      if (!others) continue;
      const key = this.turnKey(pid);
      const timer = setTimeout(() => {
        this.timeoutTimers.delete(pid);
        if (this.isTurn(pid) && this.turnKey(pid) === key) void this.enqueue(() => {
          if (this.isTurn(pid) && this.turnKey(pid) === key) this.stepNow(pid, { type: 'wait' }, 'timeout');
        });
      }, ms);
      timer.unref?.();
      this.timeoutTimers.set(pid, { timer, key });
    }
  }

  private turnKey(pid: PlayerId): string {
    const e = this.world.entities[this.world.players[pid].entityId];
    return `${e.pos?.floor}|${e.actor?.nextActAt}|${e.actor?.turns}`;
  }

  /** 観戦用の World 畳み込み検証（テスト用） */
  foldHistory(): World {
    const w = emptyWorld();
    for (const ev of this.history) applyEvent(w, ev);
    return w;
  }

  summary(): RunSummary | null {
    const ev = [...this.history].reverse().find((e) => e.type === 'run_ended') as Extract<GameEvent, { type: 'run_ended' }> | undefined;
    return ev?.summary ?? null;
  }

  meta(): RunMetaFile {
    return this.metaFile;
  }

  /**
   * 管理ファイル（meta.json・要約）を World と比べて、違えば書き直す（SEASON.md §36.1 の 3: 書けなかった古い中身が残り続けない。
   * 終わったランが、起動のたびに進行中として生き返っていた）。起動時の復旧の後に呼ぶ。書き直したファイルの名前
   */
  reconcileFiles(): string[] {
    if (!this.log) return [];
    const out: string[] = [];
    const want = this.buildMeta();
    const disk = readJsonStable<RunMetaFile>(join(this.log.dir, 'meta.json'));
    // 比べるのは lastSeq のほか（lastSeq は書いたときの番号で、ふだんから World より古い。進行中のランを起動のたびに書き直さない）
    const key = (m: RunMetaFile) => JSON.stringify({ ...m, lastSeq: 0 });
    if ((!('value' in disk) || key(disk.value) !== key(want)) && this.log.writeMeta(want)) out.push('meta.json');
    this.metaFile = want;
    let at = -1;
    for (let i = this.history.length - 1; i >= 0; i--) { const ty = this.history[i].type; if (ty === 'run_ended' || ty === 'expedition_ended') { at = i; break; } }
    if (at >= 0) {
      const ev = this.history[at] as Extract<GameEvent, { type: 'run_ended' | 'expedition_ended' }>;
      const ds = readJsonStable<RunSummary>(join(this.log.dir, 'summary.json'));
      if (!('value' in ds) || JSON.stringify(ds.value) !== JSON.stringify(ev.summary)) {
        this.log.writeSummary(ev.summary, summaryMarkdown(ev.summary, this.history.slice(0, at + 1), this.deps.catalog));
        out.push('summary.json');
      }
    }
    return out;
  }

  close(): void {
    this.closed = true;
    for (const t0 of this.timeoutTimers.values()) clearTimeout(t0.timer);
    this.timeoutTimers.clear();
    for (const w of [...this.waiters]) w();
  }

  /** 作ったばかりで誰も参加しなかったランを捨てる（このランの記録のフォルダも消す。SessionManager.createRun で参加が断られたとき） */
  discard(): void {
    this.close();
    if (this.log) rmSync(this.log.dir, { recursive: true, force: true });
  }
}


/**
 * 配列の後ろに足す（push(...src) は引数の数に上限があり、長いランの復旧で src が十数万件になると
 * 「Maximum call stack size exceeded」で落ちた。V4-1m §37.1）
 */
function appendAll<T>(dst: T[], src: readonly T[]): void {
  for (const x of src) dst.push(x);
}

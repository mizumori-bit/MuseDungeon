// 1 ラン = 1 RunSession。World、コマンド待ち行列（直列化）、マクロ展開、LogWriter、購読者ハブ。
// World に触れるのはこのファイルと PlayerPort / SpectatorPort の実装だけ。
import { randomBytes } from 'node:crypto';
import type { Catalog } from '@muse/shared';
import type { Content } from '@muse/content';
import { createRun, isPlayersTurn, joinPlayer, resumeSeq, seasonSync, step } from '@muse/engine';
import type {
  ActionError, AgentActivity, Command, CommandRecord, CommandSource, Dir, Expedition, ExpeditionReport, GameEvent, JoinCommand, LegacyMonster, MacroStop, ProjectedEvent,
  PerceivedEvent, PlayerId, PlayerView, Pos, ReportCall, RunMetaFile, RunSummary, SeasonSlay, SeasonSlayFacts, SeasonSyncCommand, SeqResumeCommand, TurnSnapshot, World,
  CheckpointLedger,
} from '@muse/shared';
import {
  actionError, applyEvent, buildExpeditionReport, canonicalHash, guardianDisplayName, compareReports, emptyWorld, filterEventsForPlayer, FREE_COMMANDS, MACRO_COMMANDS,
  CHECKPOINT_EVERY, checkpointCamp, checkpointStep, monsterInView,
  fleeOptionsText, fleeRiskText, macroNext, macroProbe, macroStart, macroStopError, narrate, projectPlayerView, publicStairsAt, riskText, fightRiskStop, fightThreats, threatEstimate, seasonReportable, seasonReportableSpots, selfTurnMarks, t,
} from '@muse/shared';
import type { SeasonHooks } from '../season/SeasonService';
import type { ServerConfig } from '../config';
import { LogWriter } from '../log/LogWriter';
import { readJsonl } from '../log/RunStore';
import { boundaryKeyframeMissing, cutEventsAfter, isRunMeta, keyframeFromEvents, latestKeyframe, logBounds, metaFromWorld, resumeSeqTarget } from '../log/repair';
import { readJsonStable } from '../log/atomicWrite';
import { summaryMarkdown } from './summary';
import { buildAttempts, incapStatuses } from '../season/slays';
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
  /** widen: その方角（と両隣）に行ける境界が無いので、幅を広げた（S7 §52.3 の 4。level 1 = 横・2 = 後ろ、steps: 広げた手、dir: 向かった境界の方角） */
  toward?: { kind: 'draft' | 'sense'; dir: Dir | null; start: Pos; noAlong: number; detour: number; widen?: { level: 1 | 2; steps: number; from: Pos } };
  /** explore toward が、同じマスに 3 回目に入るところで止まった（S7b。そのマス） */
  revisit?: Pos;
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
  /** 倒さずに帰った大守護者への挑戦（S5。プレイヤーと遠征ごと） */
  private readonly attempts = new Map<string, SeasonSlayFacts[]>();
  /** いちばん新しい挑戦（S5b。プレイヤー・深さ・最後に終わった遠征ごと）と、前のキャンプまでに見えていた討伐の記録（S5b。プレイヤーと遠征ごと） */
  private readonly lastAttempt = new Map<string, { no: number; facts: SeasonSlayFacts } | null>();
  private readonly slaySeen = new Map<string, Set<string>>();
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
  /** 食い違いの後の続きの境目（seq_resumed の番号。S3h §41.10 の中 2）。履歴を空の World から畳む所は、境目のキーフレームから後を畳む */
  private readonly boundarySeqs: number[] = [];
  private boundaryCache: { seq: number; world: World } | null = null;
  /** 読めなかった境目のキーフレーム（知らせるのは 1 回だけ） */
  private readonly foldWarned = new Set<number>();
  /**
   * 遠征の途中の区切り（S7。SEASON.md §52.2 の 2）の控え（プレイヤーごと）。ランの記録（履歴）を畳んで作り、記録には何も書かない。
   * 初めて要るときに畳み（起動し直した後も同じに作り直せる）、その後は確定のたびに今の World で進める
   */
  private readonly checkpoints = new Map<PlayerId, CheckpointLedger>();

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
    // 記録の範囲（§36.1 の 1）。命令の記録が覆っていない出来事（出来事を追記した後、命令を書く前に落ちた）は、照合にも履歴にも入れない。
    // 覆うかどうかは、命令の結果の区間の和で見る（S3h §41.10 の中 1: 最後の番号だけで見ると、続けた後に、途中に残った命令の無い出来事が混ざる）。
    // 読み方だけで、記録のファイルには何も書かない
    const bounds = logBounds(allEvents, commands);
    const orphans = allEvents.filter((e) => e.seq > bounds.covered).length;
    const kept = allEvents.filter((e) => bounds.covers(e.seq));
    const inner = allEvents.length - kept.length - orphans;
    const lastKept = kept.length ? kept[kept.length - 1].seq : 0;
    // いちばん新しい、読めて、記録が覆っているキーフレーム（出来事の番号・命令の番号が、どちらも記録の最後以下）。範囲の中で最新のものが
    // 一時的に読めなければ、古いものへ下がらずに失敗する（§38.2 の 2: 長い再実行になり、版をまたいだランでは食い違いに入る）
    const found = latestKeyframe(dir, { moveBroken: false, maxSeq: Math.min(lastKept, bounds.covered), maxCseq: bounds.lastCseq });
    if (found.unreadable) throw new Error(`キーフレーム ${basename(found.unreadable)} を一時的に読めない（ほかのプログラムが開いている）。次の起動で直る`);
    // 食い違いの後の続きのラン（S3i §46.2 の 2）: 読めるキーフレームが 1 つも無いとき、境目があれば、出来事だけから境目をまたいで畳んで作らない
    // （畳んだ World は本当の続きと違うのに、再実行する命令が無いので「一致」になり、記録を直してしまう）。復旧に失敗したランとして出す（何も書かない）。
    // 境目より前の古いキーフレームがあるときは、今までどおり、そこから命令を再実行して照合する（食い違えば何も書かない。S3f のテストの形）
    if (!found.kf) { const miss = boundaryKeyframeMissing(kept, null); if (miss) throw new Error(miss); }
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
      // 途中に残った命令の無い出来事（S3h §41.10 の中 1）: 読まずに、記録のファイルには残す
      if (inner) notes.push(`命令の記録が覆っていない途中の出来事 ${inner} 件は、読まずに残した`);
      // 出来事の記録から作ったとき・キーフレームを避けたときは、キーフレームを書き直す（次に起動し直したときに使う）
      if (!found.kf || aside.moved.length || aside.ahead.length) s.writeKeyframe();
    } else {
      if (orphans || inner || found.skipped) notes.push(`食い違ったので、記録のファイルは直していない（${[orphans || inner ? `命令の記録が覆っていない出来事 ${orphans + inner} 件` : '', found.skipped ? `使えないキーフレーム ${found.skipped} 個` : ''].filter(Boolean).join('・')}は、そのまま）`);
      if (replayEnd > bounds.covered) notes.push(`再生が記録より先まで進んだ（再生の終わり ${replayEnd}、命令の記録の覆う最後 ${bounds.covered}）`);
      else if (replayEnd < bounds.covered) notes.push(`再生が記録の覆う番号まで届かなかった（再生の終わり ${replayEnd}、命令の記録の覆う最後 ${bounds.covered}）`);
      // 続けるときは、最初に記録へ書く前に、必ず境目（seq_resume）を残す（S3h §41.10 の中 2）。番号は、記録の中のどの番号とも、
      // ライブの World の番号とも重ねない（SEASON.md §40.2 の 2）。読むだけなら何も書かない（§38.1）。再生で終わったランには書かない
      const next = Math.max(resumeSeqTarget(dir, allEvents, bounds.covered), s.world.seq + 1);
      if (s.world.status !== 'ended') {
        s.pendingSeqResume = next;
        notes.push(next > s.world.seq + 1
          ? `続けると、境目（seq_resume #${next}）を残し、出来事の番号を ${s.world.seq + 1} からでなく ${next} から振る（記録の番号と重ならないように）`
          : `続けると、境目（seq_resume #${next}）を残してから続ける`);
      }
    }
    // 食い違いの後の続きの境目（S3h §41.10 の中 2）: 遅らせた観戦は、境目のキーフレームから後を畳む
    for (const e of s.history) if (e.type === 'seq_resumed') s.boundarySeqs.push(e.seq);
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
    // 境目のキーフレーム（次の起動は、ここから再生するので一致する。遅らせた観戦と巻き戻しも、ここから畳む）
    if (this.lastKeyframeSeq !== this.world.seq) this.writeKeyframe();
    this.boundarySeqs.push(r.events[r.events.length - 1].seq);
  }

  /** 続けて最初に記録へ書くときに、出来事の番号を送るか（その送り先。テストと記録の確かめ用） */
  seqResumePending(): number | null {
    return this.pendingSeqResume;
  }

  /** 食い違いの後の続きの境目（seq_resumed の番号。古い順） */
  boundaries(): readonly number[] {
    return this.boundarySeqs;
  }

  /**
   * 履歴を upTo まで畳むときの出発点（S3h §41.10 の中 2）: upTo 以下の最後の境目のキーフレームが読めれば、その World（写し）と番号。
   * 無ければ空の World と 0（境目より前は、今までどおり最初から畳む）
   */
  foldBase(upTo: number): { world: World; from: number } {
    // upTo 以下の最後の境目だけを使う。そのキーフレームが読めなければ、1 つ前の境目へは下がらない（S3i §46.2 の 3: 下がると、新しい境目をまたいで畳む）。
    // 今までどおり空の World から畳み、合わないことを 1 行知らせる
    let b = 0;
    for (const x of this.boundarySeqs) if (x <= upTo && x > b) b = x;
    if (!b) return { world: emptyWorld(), from: 0 };
    if (this.boundaryCache?.seq !== b) {
      const r = this.log
        ? readJsonStable<{ seq: number; world: World }>(join(this.log.dir, 'keyframes', `${b}.json`), (v) => !!v && typeof v === 'object' && (v as { seq?: number }).seq === b && !!(v as { world?: unknown }).world)
        : null;
      if (!r || !('value' in r)) {
        if (!this.foldWarned.has(b)) {
          this.foldWarned.add(b);
          console.error(`[fold] ${this.runId} の境目のキーフレーム（${b}.json）が読めないので、空の World から畳む（境目より前は前の版の出来事なので、畳んだ World は本当の続きと合わないことがある）`);
        }
        return { world: emptyWorld(), from: 0 };
      }
      this.boundaryCache = { seq: b, world: r.value.world };
    }
    return { world: structuredClone(this.boundaryCache!.world), from: b };
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
    this.stepCheckpoints(events);
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
    if (events.length) this.notify((l) => l.onEvents?.(events));
    for (const w of [...this.waiters]) w();
    this.scheduleTimeouts();
  }

  /**
   * 倒さずに帰った節目の大守護者への自分の挑戦（S5。SEASON.md §47.4 の 2）: 終わった遠征 no で戦った（攻撃・被害の出来事があった）のに、
   * 倒れなかった大守護者ごとの、討伐の記録と同じ作り方の事実。このランの出来事の記録から作って覚えておく（共有しない。キャンプの観測にだけ出す）
   */
  wardenAttempts(pid: PlayerId, no: number, wardenIds?: ReadonlySet<string>): SeasonSlayFacts[] {
    const key = `${pid}|${no}`;
    const hit = this.attempts.get(key);
    if (hit) return hit;
    const x = (this.world.expeditions ?? []).find((y) => y.no === no && y.participants.includes(pid));
    if (!x || x.endSeq === null) return [];
    const end = this.indexOfSeq(x.endSeq + 1);
    // 大守護者と攻撃・被害の出来事があった遠征だけ畳む（ほとんどの遠征は、ここで済む）
    const wardens = wardenIds ?? new Set(this.wardenIds());
    const isW = (id: string | null | undefined) => !!id && wardens.has(id);
    const fought = this.history.slice(this.indexOfSeq(x.startSeq), end)
      .some((e) => (e.type === 'attack' && (isW(e.attacker) || isW(e.target))) || (e.type === 'damaged' && (isW(e.target) || isW(e.source))));
    let out: SeasonSlayFacts[] = [];
    if (fought) {
      try {
        out = buildAttempts(this.history.slice(0, end), this.foldBase(x.startSeq), pid, this.world, no, incapStatuses(this.deps.content));
      } catch (err) {
        console.error(`[season] ${this.runId} の遠征 ${no} の大守護者への挑戦を数えられなかった: ${(err as Error).message}`);
      }
    }
    this.attempts.set(key, out);
    return out;
  }

  /**
   * そのランで、その深さの節目の大守護者に挑んで退いた、いちばん新しい挑戦（S5b。大守護者の候補に添える）: 終わった遠征を新しい順に見て、
   * `wardenAttempts` に、その深さの挑戦があった最初の遠征。ランの記録（履歴）から作り、何も書かない（起動し直しても同じに作り直せる）
   */
  lastWardenAttempt(pid: PlayerId, depth: number): { no: number; facts: SeasonSlayFacts } | null {
    const xs = (this.world.expeditions ?? []).filter((x) => x.participants.includes(pid) && x.endSeq !== null);
    const key = `${pid}|${depth}|${xs[xs.length - 1]?.no ?? 0}`;
    const hit = this.lastAttempt.get(key);
    if (hit !== undefined) return hit;
    let out: { no: number; facts: SeasonSlayFacts } | null = null;
    const wardens = new Set(this.wardenIds());
    for (let i = xs.length - 1; i >= 0 && !out; i--) {
      const f = this.wardenAttempts(pid, xs[i].no, wardens).find((a) => a.depth === depth);
      if (f) out = { no: xs[i].no, facts: f };
    }
    this.lastAttempt.set(key, out);
    return out;
  }

  /**
   * 前のキャンプの後に初めて受け取った討伐の記録（S5b。キャンプの知らせ）: 今の World の `season.slays` のうち、いちばん新しい遠征を始めたときの
   * 取り込みより前の取り込み（前のキャンプまでに見えていたもの）に無かった記録（深さと名前で見る。自分の記録は除く）。
   * キャンプにいて、遠征を 1 つ以上終えているときだけ。ランの記録（取り込みの出来事）から作り、何も書かない
   */
  slayNews(pid: PlayerId, opts: { firstCamp?: boolean } = {}): SeasonSlay[] {
    const pr = this.world.players[pid];
    const cur = (this.world.season?.slays ?? []).filter((s) => !s.mine);
    if (!pr || pr.state !== 'at_camp' || !cur.length) return [];
    const xs = (this.world.expeditions ?? []).filter((x) => x.participants.includes(pid) && x.endSeq !== null);
    const x = xs[xs.length - 1];
    // ランの最初のキャンプ（まだ遠征を終えていない）: 知らせは出さない。firstCamp なら、取り込んであるものすべてを、そのキャンプで初めて見るものとする（S6 §49.5 の 4）
    if (!x) return opts.firstCamp ? cur : [];
    const key = `${pid}|${x.no}`;
    let seen = this.slaySeen.get(key);
    if (!seen) {
      // その遠征を始めたときの取り込み（遠征を始める直前の、いちばん新しい取り込み）
      const i0 = this.indexOfSeq(x.startSeq);
      let start = -1;
      for (let i = i0 - 1; i >= 0; i--) { const e = this.history[i]; if (e.type === 'season_synced' && e.player === pid) { start = i; break; } }
      seen = new Set<string>();
      for (let i = 0; i < start; i++) {
        const e = this.history[i];
        if (e.type === 'season_synced' && e.player === pid) for (const s of e.seasonAfter.slays ?? []) seen.add(`${s.depth}|${s.by}`);
      }
      this.slaySeen.set(key, seen);
    }
    return cur.filter((s) => !seen!.has(`${s.depth}|${s.by}`));
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

  /**
   * 参加を World の写しで試す（S3i §46.2 の 1）: 食い違ったランで番号を送る前なら、写しに先に番号の送り（resumeSeq）を当ててから試す。
   * 何も書かない。断られるならそのエラー、通るなら参加者の ID（エンジンは決定論的なので、本当の参加と同じ ID）
   */
  private probeJoin(req: JoinCommand, wall: number): { ok: true; playerId: PlayerId } | { ok: false; error: ActionError } {
    const w = structuredClone(this.world);
    let cseq = this.cseq;
    const next = this.pendingSeqResume;
    if (!this.closed && next !== null && w.status !== 'ended' && next > w.seq) resumeSeq(w, this.deps.content, { type: 'seq_resume', next }, { cseq: ++cseq, wall });
    const r = joinPlayer(w, this.deps.content, req, { cseq: cseq + 1, wall });
    return r.ok ? { ok: true, playerId: r.playerId } : { ok: false, error: r.error };
  }

  /** この参加が断られるか（断られるならそのエラー。何も書かない。SessionManager が、断られる参加でプロフィールを作らないために使う。S3i §46.2 の 1） */
  joinRefusal(req: JoinCommand): ActionError | null {
    if (this.closed) return actionError('no_session', 'session closed', '');
    const r = this.probeJoin(req, Date.now());
    return r.ok ? null : r.error;
  }

  join(req: JoinCommand, source: CommandSource): Promise<{ ok: true; playerId: PlayerId; token: string } | { ok: false; error: ActionError }> {
    return this.enqueue(() => {
      const wall = Date.now();
      // 断られる参加では、何も書かない（S3i §46.2 の 1: 食い違ったランに断られる参加を試すと、境目の命令とキーフレームが書かれ、
      // 次の起動から一致の側へ移っていた）。番号を送る前に、写しで（送りを当ててから）試す
      const probe = this.probeJoin(req, wall);
      if (!probe.ok) return { ok: false as const, error: probe.error };
      // 食い違ったランの続き（§40.2 の 2）: 参加の前に番号を送る（参加者の番号・ID は送った後の World から）
      if (!this.closed) this.resumeSeqIfNeeded();
      const cseq = ++this.cseq;
      const token = newToken();
      // 再開用のトークンの控えを、参加を確定する前に書く（SEASON.md §36.1 の 4: 書けなければ参加を断る。World は変えない）。
      // 参加者の ID は、World の写しで同じ参加を試して知る（エンジンは決定論的なので、同じ ID になる）
      let probeId: PlayerId | null = null;
      if (this.log) {
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

  /**
   * リスナーに知らせる。1 つのリスナー（観戦者の枠を作る・送るなど）の例外で、ほかのリスナーと、確定の残り（待っている者・手番の時計）と、
   * 命令の結果を飛ばさない。例外はログに 1 行出して捨てる
   */
  private notify(fn: (l: SessionListener) => void): void {
    for (const l of this.listeners) {
      try {
        fn(l);
      } catch (e) {
        console.error(`[listener] ${this.runId} のリスナーで例外（捨てた）: ${String((e as Error)?.message ?? e).split('\n')[0]}`);
      }
    }
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
    this.notify((l) => l.onAgent?.(a));
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
      // valid_actions の行を出すかと同じ判定（S5c: macroProbe）
      const { state: probe, decision: d0 } = macroProbe(startView, cmd, this.deps.catalog);
      if ('stop' in d0) {
        const err = macroStopError(startView.locale, d0.stop, cmd, d0.dir, d0.blockedBy, d0.traps, d0.explored, d0.obstacle);
        // fight の被弾の前の断り（S1c §14.4 の 1）: 見込みと最悪の 2 つの数・いまの HP・実際に使った hp_floor
        // 逃げる移動の断り（S6 §49.6 の 1）: 最悪の見込みと今の HP。取れる手は hint（S6a: 持っている品のスロット付き・階段の上なら階段と extract）
        if (d0.stop === 'flee_lethal') { err.message += ' ' + fleeRiskText(startView, this.deps.catalog, false); err.hint = fleeOptionsText(startView, this.deps.catalog); }
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
    this.notify((l) => l.onMacro?.({ playerId: pid, kind: cmd.type, state: 'running', steps: 0 }));
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
      if (state.steps % 5 === 0) this.notify((l) => l.onMacro?.({ playerId: pid, kind: cmd.type, state: 'running', steps: state.steps }));
    }
    } finally {
      this.macroActive.delete(pid);
    }
    this.notify((l) => l.onMacro?.({ playerId: pid, kind: cmd.type, state: 'stopped', steps: state.steps, reason: stop }));
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
      ...(cmd.type === 'explore' && cmd.toward && startView.self.pos ? { toward: { kind: cmd.toward, dir: state.towardDir ?? null, start: { ...startView.self.pos }, noAlong: state.towardNoAlong ?? 0, detour: state.towardDetour ?? 0, ...(state.towardWiden ? { widen: { ...state.towardWiden } } : {}) } } : {}),
      ...(state.retrieveHeld ? { retrieveHeld: true } : {}),
      hpFloor: state.hpFloor,
      ...(state.detour ? { detour: structuredClone(state.detour) } : {}),
      ...(stop === 'no_progress' && state.noProgressBy?.length ? { routeFoes: structuredClone(state.noProgressBy) } : {}),
      ...(stop === 'no_progress' && state.revisit ? { revisit: { ...state.revisit } } : {}),
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

  /**
   * 遠征の途中の区切り（S7 §52.2 の 2）: 確定した出来事で、控えのあるプレイヤーの控えを進める。自分の手番の初め（turn_began）ごとに、
   * その手番の数と、敵が見えていないか（monsterInView。今の World: 手番の初めの後に、同じ階の出来事は続かない）。キャンプに着いたら、そこまでを出したことにする
   */
  private stepCheckpoints(events: readonly GameEvent[]): void {
    if (!this.checkpoints.size) return;
    for (const ev of events) {
      if (ev.type === 'turn_began') {
        for (const [pid, l] of this.checkpoints) {
          const rec = this.world.players[pid];
          if (rec?.entityId !== ev.actor) continue;
          checkpointStep(l, this.world.entities[ev.actor]?.actor?.turns ?? 0, !monsterInView(this.world, pid), ev.seq, CHECKPOINT_EVERY);
        }
      } else if (ev.type === 'player_state' && ev.state === 'at_camp') {
        const l = this.checkpoints.get(ev.player);
        const rec = this.world.players[ev.player];
        if (l && rec) checkpointCamp(l, this.world.entities[rec.entityId]?.actor?.turns ?? 0);
      }
    }
  }

  /**
   * 遠征の途中の区切りの控え（S7 §52.2 の 2）。無ければ、ランの記録を畳んで作る: 今の 100 手番の区切りが始まる前の手番から
   * （その前の区切りの手番は、今の区切りを決めない）。畳む元は、その手番より前の、境目をまたがないキーフレーム（無ければ境目か空の World）
   */
  private checkpointLedger(pid: PlayerId): CheckpointLedger {
    const have = this.checkpoints.get(pid);
    if (have) return have;
    let l: CheckpointLedger;
    try {
      l = this.foldCheckpoints(pid, false);
    } catch (err) {
      // 畳めない記録（記録の外から World を書き換えたテストの場面など）: 区切りの控えは空から始める（区切りは表示だけ。ゲームは止めない）
      console.error(`[checkpoint] ${this.runId} の区切りの控えを、記録から作れなかった（空から始める）: ${String((err as Error)?.message ?? err).split(/\r?\n/)[0]}`);
      l = { lastCalm: -1, due: [] };
    }
    this.checkpoints.set(pid, l);
    return l;
  }

  /** 区切りの控えを、ランの記録を畳んで作る（full: ランの初めから。テスト・確かめ用。ふつうは今の 100 手番の区切りが始まる前から） */
  private foldCheckpoints(pid: PlayerId, full: boolean): CheckpointLedger {
    const l: CheckpointLedger = { lastCalm: -1, due: [] };
    const rec = this.world.players[pid];
    const eid = rec?.entityId;
    const now = eid ? this.world.entities[eid]?.actor?.turns ?? 0 : 0;
    if (rec && eid && (full || now >= CHECKPOINT_EVERY)) {
      // S7a: 1 つ前の 100 手番の区切りから畳む（その区切りの手番が、まだ出ていない（応答の終わりで敵が見えていた）ことがある）
      const block = Math.max(0, Math.trunc(now / CHECKPOINT_EVERY) * CHECKPOINT_EVERY - CHECKPOINT_EVERY);
      // 手番の数が block に届く前の、最後の自分の手番の数の知らせ（無ければ、ランの初めから）
      let startSeq = 0;
      for (let i = this.history.length - 1; i >= 0 && !full && block > 0; i--) {
        const e = this.history[i];
        if (e.type === 'actor_scheduled' && e.id === eid && e.turns < block) { startSeq = e.seq; break; }
      }
      let base = this.foldBase(startSeq);
      if (this.log && startSeq > 0) {
        try {
          const k = latestKeyframe(this.log.dir, { moveBroken: false, maxSeq: startSeq });
          if (k.kf && k.kf.seq >= base.from) base = { world: k.kf.world, from: k.kf.seq };
        } catch { /* 読めなければ、境目か空の World から畳む */ }
      }
      let w = base.world;
      const later = this.boundarySeqs.filter((b) => b > base.from).sort((a, b) => a - b);
      for (let i = this.indexOfSeq(base.from + 1); i < this.history.length; i++) {
        const ev = this.history[i];
        // 境目（食い違いの後の続き）をまたぐときは、境目のキーフレームから続ける（foldBase と同じ考え方）
        while (later.length && ev.seq > later[0]) { const fb = this.foldBase(later[0]); if (fb.from === later[0]) w = fb.world; later.shift(); }
        applyEvent(w, ev);
        if (ev.type === 'turn_began' && ev.actor === eid) checkpointStep(l, w.entities[eid]?.actor?.turns ?? 0, !monsterInView(w, pid), ev.seq, CHECKPOINT_EVERY);
        else if (ev.type === 'player_state' && ev.player === pid && ev.state === 'at_camp') checkpointCamp(l, w.entities[eid]?.actor?.turns ?? 0);
      }
      // 途中から畳んだときは、畳み始めの前を知らないので、1 つ前の区切りより前の手番の区切りは数えない（これからの応答に効くのは、いちばん新しい区切りだけ）
      if (!full) l.due = l.due.filter((d) => d.turn >= block);
    }
    return l;
  }

  /**
   * 区切りを出すか（S7 §52.2 の 2・S7a §53.9 の 4）: いちばん新しい区切りの手番の後で、まだ出していなくて、いまの自分の手番に敵が見えていないとき。
   * 「出した」は記録から分かる: 区切りの手番から、いまの手番の前までに、敵の見えていない「応答の終わり」の手番（その後の自分の呼び出しが
   * マクロの続きの一歩でない手番）があったか、キャンプに着いたか。マクロの途中の手番が区切りで、止まった所で敵が見えていれば、出さずに次へ回す。
   * since（前の応答の seq）が、いまの手番の初めより後なら、同じ手番の 2 回目の応答なので出さない
   */
  checkpointDue(pid: PlayerId, since: number | null): boolean {
    const rec = this.world.players[pid];
    if (!rec || rec.state !== 'alive') return false;
    const l = this.checkpointLedger(pid);
    const last = l.due[l.due.length - 1];
    if (!last || l.camped || l.shown || !l.calm?.length) return false;
    let cur = -1;
    for (let i = this.history.length - 1; i >= 0 && cur < 0; i--) {
      const e = this.history[i];
      if (e.type === 'turn_began' && e.actor === rec.entityId) cur = e.seq;
    }
    if (cur < last.seq || (since !== null && since >= cur)) return false;
    // いまの手番に敵が見えていない
    if (!l.calm.includes(cur)) return false;
    const calls = this.calls.get(pid) ?? [];
    // 前の応答の控えが無い（起動し直した直後など。S7b）: いまの手番を作った呼び出しが記録にあれば、いまの手番の応答はもう返している
    // （敵が見えていない応答の終わりなので、そこで出した）。出したことにする
    if (since === null && calls.some((c) => c.seq <= cur)) { l.shown = true; return false; }
    // 区切りの手番から、いまの手番の前までに、敵の見えていない応答の終わりがあれば、もう出した
    for (const tseq of l.calm) {
      if (tseq >= cur) break;
      const next = calls.find((c) => c.seq > tseq);
      if (!next || next.kind !== 'macro_step') { l.shown = true; return false; }
    }
    return true;
  }

  /** 区切りの手番（テスト・確かめ用。控えが無ければ畳んで作る。fold: 控えを使わずに、ランの初めから畳み直した答え） */
  checkpointTurns(pid: PlayerId, fold = false): { seq: number; turn: number }[] {
    return (fold ? this.foldCheckpoints(pid, true) : this.checkpointLedger(pid)).due.map((d) => ({ ...d }));
  }

  /** 観戦用の World 畳み込み検証（テスト用） */
  foldHistory(): World {
    // 食い違いの後の続き（S3h §41.10 の中 2）: 境目があれば、境目のキーフレームから後を畳む
    const { world: w, from } = this.foldBase(this.world.seq);
    for (const ev of this.history) if (ev.seq > from) applyEvent(w, ev);
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

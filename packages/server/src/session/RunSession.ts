// 1 ラン = 1 RunSession。World、コマンド待ち行列（直列化）、マクロ展開、LogWriter、購読者ハブ。
// World に触れるのはこのファイルと PlayerPort / SpectatorPort の実装だけ。
import { randomBytes } from 'node:crypto';
import type { Catalog } from '@muse/shared';
import type { Content } from '@muse/content';
import { createRun, ENGINE_VERSION, isPlayersTurn, joinPlayer, step } from '@muse/engine';
import type {
  ActionError, AgentActivity, Command, CommandRecord, CommandSource, Expedition, ExpeditionReport, GameEvent, JoinCommand, LegacyMonster, MacroStop, ProjectedEvent,
  PerceivedEvent, PlayerId, PlayerView, ReportCall, RunMetaFile, RunSummary, TurnSnapshot, World,
} from '@muse/shared';
import {
  actionError, applyEvent, buildExpeditionReport, canonicalHash, guardianDisplayName, compareReports, emptyWorld, filterEventsForPlayer, FREE_COMMANDS, MACRO_COMMANDS,
  macroNext, macroStart, macroStopError, narrate, projectPlayerView, selfTurnMarks, t,
} from '@muse/shared';
import type { ServerConfig } from '../config';
import { LogWriter } from '../log/LogWriter';
import type { KeyframeFile } from '../log/LogWriter';
import { readJsonl } from '../log/RunStore';
import { summaryMarkdown } from './summary';
import type { ProfileHooks } from './profiles';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

export interface SessionDeps {
  content: Content;
  catalog: Catalog;
  config: ServerConfig;
  /** プロフィール（V3-7）。遠征とランが終わるたびに記録を書き直す */
  profiles?: ProfileHooks;
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

  private constructor(readonly deps: SessionDeps, runId: string, world: World, createdAt: number) {
    this.runId = runId;
    this.world = world;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
    this.log = deps.config.runsDir ? new LogWriter(deps.config.runsDir, runId) : null;
    this.metaFile = this.buildMeta();
  }

  // ---------- 生成・復旧 ----------

  static create(deps: SessionDeps, p: { seed?: string; mode?: 'solo' | 'coop'; runId?: string; wall?: number }): RunSession {
    const runId = p.runId ?? newRunId();
    const seed = p.seed ?? randomBytes(6).toString('hex');
    const wall = p.wall ?? Date.now();
    const { world, events } = createRun(deps.content, { runId, seed, mode: p.mode ?? 'solo', wall });
    const s = new RunSession(deps, runId, world, wall);
    s.history.push(...events);
    s.log?.writeMeta(s.metaFile);
    s.log?.appendEvents(events);
    s.writeKeyframe();
    return s;
  }

  /** クラッシュ復旧: 最新キーフレーム＋それ以降の commands.jsonl を再実行し、events.jsonl とハッシュ照合 */
  static recover(deps: SessionDeps, runId: string): { session: RunSession; verified: boolean; message: string } {
    const dir = join(deps.config.runsDir!, runId);
    const meta = JSON.parse(require_read(join(dir, 'meta.json'))) as RunMetaFile;
    const kfDir = join(dir, 'keyframes');
    const seqs = existsSync(kfDir) ? readdirSync(kfDir).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b) : [];
    if (!seqs.length) throw new Error(`no keyframe for ${runId}`);
    const kf = JSON.parse(require_read(join(kfDir, `${seqs[seqs.length - 1]}.json`))) as KeyframeFile;
    const s = new RunSession(deps, runId, kf.world, meta.createdAt);
    s.metaFile = meta;
    const allEvents = readJsonl<GameEvent>(join(dir, 'events.jsonl'));
    // 履歴はキーフレーム時点までのログ＋再実行分
    s.history.push(...allEvents.filter((e) => e.seq <= kf.seq));
    const commands = readJsonl<CommandRecord>(join(dir, 'commands.jsonl'));
    s.cseq = commands.length ? commands[commands.length - 1].cseq : 0;
    const replayed: GameEvent[] = [];
    for (const rec of commands) {
      if (rec.cseq <= kf.cseq || rec.macro) continue;
      const evs = s.reexecute(rec);
      replayed.push(...evs);
    }
    s.history.push(...replayed);
    s.rebuildCalls(commands);
    // 目標の宣言（V3-7a）は V3-8 §53.5 で外した。古いランの goals.jsonl は読まない（再実行は commands.jsonl だけで、宣言はゲームに影響しない）
    const logged = allEvents.filter((e) => e.seq > kf.seq);
    const strip = (es: GameEvent[]) => es.map((e) => ({ ...e, wall: 0 }));
    const verified = canonicalHash(strip(logged)) === canonicalHash(strip(replayed));
    // トークン
    for (const [tok, pid] of Object.entries(s.log?.readTokens() ?? {})) s.tokens.set(tok, pid);
    for (const pid of s.world.playerOrder) s.rebuildMessages(pid);
    s.lastKeyframeSeq = kf.seq;
    return { session: s, verified, message: verified ? `recovered ${runId} (${replayed.length} events re-executed, hash ok)` : `recovered ${runId} with mismatch (logged ${logged.length}, replayed ${replayed.length})` };
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
    const r = step(this.world, this.deps.content, rec.player!, cmd, { cseq: rec.cseq, wall: rec.wall, thought: rec.thought });
    return r.events;
  }

  private buildMeta(): RunMetaFile {
    const w = this.world;
    return {
      runId: this.runId,
      createdAt: this.createdAt,
      endedAt: w.status === 'ended' ? this.updatedAt : undefined,
      mode: w.meta.mode,
      contentVersion: w.meta.contentVersion,
      engineVersion: w.meta.engineVersion || ENGINE_VERSION,
      eventVersion: w.meta.eventVersion,
      options: { ...w.meta.options },
      status: w.status,
      players: w.playerOrder.map((pid) => {
        const p = w.players[pid];
        return { id: pid, name: p.name, classId: p.classId, controller: { ...p.controller }, joinedSeq: p.joinedSeq };
      }),
      seed: w.status === 'ended' ? w.secret.seed : undefined,
      lastSeq: w.seq,
    };
  }

  // ---------- 記録 ----------

  private writeKeyframe(): void {
    this.lastKeyframeSeq = this.world.seq;
    this.log?.writeKeyframe({ seq: this.world.seq, cseq: this.cseq, world: this.world });
  }

  /** 状態変化を確定させる: ログ、履歴、メッセージ、キーフレーム、購読者、待機者 */
  private commit(rec: Omit<CommandRecord, 'cseq' | 'resultSeq'> & { cseq: number }, events: GameEvent[]): void {
    const resultSeq: [number, number] | null = events.length ? [events[0].seq, events[events.length - 1].seq] : null;
    this.log?.appendEvents(events);
    this.log?.appendCommand({ ...rec, resultSeq });
    this.history.push(...events);
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
      const cseq = ++this.cseq;
      const wall = Date.now();
      const r = joinPlayer(this.world, this.deps.content, req, { cseq, wall });
      if (!r.ok) { this.cseq--; return { ok: false as const, error: r.error }; }
      const token = newToken();
      this.joinInfo.set(r.playerId, { ...(req.profile ? { profile: req.profile } : {}), ...(req.legacy ? { legacy: req.legacy.monsters } : {}) });
      this.tokens.set(token, r.playerId);
      this.log?.writeTokens(Object.fromEntries(this.tokens));
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
    return this.enqueue(() => this.stepNow(pid, cmd, opts.source, opts.thought));
  }

  private stepNow(pid: PlayerId, cmd: Command, source: CommandSource, thought?: string, parent?: number): SubmitResult {
    if (this.closed) return { ok: false, error: actionError('no_session', 'session closed', '') };
    const startSeq = this.world.seq;
    const cseq = this.cseq + 1;
    const wall = Date.now();
    const r = step(this.world, this.deps.content, pid, cmd, { cseq, wall, thought });
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
      if ('stop' in d0) return { ok: false, error: macroStopError(startView.locale, d0.stop, cmd, d0.dir) };
    }
    // 元の呼び出し 1 件（イベント無し）を記録
    const parent = await this.enqueue(() => {
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
        if (!got) { stop = this.world.status === 'ended' ? 'run_ended' : this.world.players[pid].state !== 'alive' ? 'dead' : 'waiting_others'; break; }
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
      all.push(...r.events);
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

  close(): void {
    this.closed = true;
    for (const t0 of this.timeoutTimers.values()) clearTimeout(t0.timer);
    this.timeoutTimers.clear();
    for (const w of [...this.waiters]) w();
  }
}

function require_read(p: string): string {
  return readFileSync(p, 'utf8');
}

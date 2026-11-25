// 複数ランの管理。参加時にプレイヤートークンを発行し、再接続・再開はトークンで行う。
import { existsSync, mkdirSync } from 'node:fs';
import { CallLog } from '../mcp/calls';
import { basename, join } from 'node:path';
import type { Content } from '@muse/content';
import { buildCatalog } from '@muse/content';
import { checkRunGaps, compareVersions, ENGINE_VERSION } from '@muse/engine';
import type {
  ActionError, AgentActivity, Catalog, Controller, ExpeditionOffer, JoinCommand, Locale, NewRunRequest, ObjectiveChoice, PlayerId, RunListing,
  RunListingPlayer, SeasonWatchResponse, OwnerRunRow, OwnerRunsResponse,
} from '@muse/shared';
import { actionError } from '@muse/shared';
import { ownerRow } from './OwnerPort';
import type { ServerConfig } from '../config';
import { RunStore } from '../log/RunStore';
import { readTokensStrict, repairMeta, repairSummary } from '../log/repair';
import { acquireLock, markLockListening, releaseLock, retryPendingWrites, RUNS_LOCK, scrubPaths, sweepTmpFiles } from '../log/atomicWrite';
import type { MetaRepair } from '../log/repair';
import { SessionPlayerPort } from './PlayerPort';
import type { PlayerPort } from './PlayerPort';
import { RunSession } from './RunSession';

/** 知らないプロフィールのトークン（V3-7 §7.1。黙って別のプロフィールに積まない） */
function unknownProfileError(): ActionError {
  return actionError('no_session', 'そのプロフィールのトークンは見つからない / unknown profile_token', 'profile_token を省くと新しいプロフィールを作る / omit profile_token to create a new profile');
}

/** 開催中のシーズンのランの観戦を断る（S3。SEASON.md §25.1）。withToken: トークンは渡されたが、そのランの参加者のものでない */
export function seasonWatchError(withToken: boolean): ActionError {
  return actionError('season_unavailable',
    `${withToken ? 'そのトークンは、このランの参加者のものではない。' : ''}開催中のシーズンのランは、その参加者のトークン（招かれたプロフィールのもの）が要る。シーズンの結果が確定した後は、だれでも見返せる / ${withToken ? 'that token is not this run\'s participant\'s; ' : ''}a run of a season in progress can be watched only with its participant's profile token; once the season is finalized, anyone can watch it`,
    'ロビーのシーズンの欄に、招かれたプロフィールのトークンを覚えさせてから観戦する / save your invited profile token in the lobby\'s season box, then watch');
}

/** 確定する前のシーズンのランの巻き戻しを断る（S3。巻き戻しは World を見せ、まだ見ていない地図と階段が分かる） */
export function seasonReplayError(): ActionError {
  return actionError('season_unavailable',
    '開催中のシーズンのランの巻き戻しは、シーズンの結果が確定した後に、だれでも見られる（その場の観戦は、参加者が招かれたプロフィールのトークンで） / runs of a season in progress can be rewound once the season is finalized (participants can watch their own run live with their profile token)',
    'ロビーのシーズンの欄から観戦する / watch from the lobby\'s season box');
}
import type { SessionDeps } from './RunSession';
import { ProfilePort, ProfileService, ProfileStore } from './profiles';
import { SeasonService, SeasonStore } from '../season/SeasonService';
import type { LiveRunState } from '../season/SeasonService';

/** profile: そのプレイヤーのプロフィール（token は新しく作ったときだけ） */
export interface Joined { session: RunSession; playerId: PlayerId; token: string; port: PlayerPort; profile: { id: string; token?: string } }

export class SessionManager {
  readonly sessions = new Map<string, RunSession>();
  readonly deps: SessionDeps;
  readonly store: RunStore | null;
  readonly catalog: Catalog;
  readonly profiles: ProfileService;
  /** シーズン（S0。PROTOCOL §9） */
  readonly seasons: SeasonService;
  /** MCP の呼び出しの時間の控え（S7 §52.1 の 2。メモリだけ） */
  readonly calls = new CallLog();
  private seasonTimer: NodeJS.Timeout | null = null;

  constructor(content: Content, readonly config: ServerConfig) {
    this.catalog = buildCatalog(content);
    this.profiles = new ProfileService(content, this.catalog, new ProfileStore(config.profilesDir));
    this.seasons = new SeasonService(new SeasonStore(config.seasonsDir ?? null), { engineVersion: ENGINE_VERSION, contentVersion: content.version }, (runId) => this.liveRunState(runId), Date.now, content.balance.season.supportMinHealPct, content.lists.seasonTitles);
    this.deps = { content, catalog: this.catalog, config, profiles: this.profiles, season: this.seasons };
    this.store = config.runsDir ? new RunStore(config.runsDir) : null;
    // 終わりの時刻の後の確定（SEASON.md §2.1）: 1 分ごとに見る
    this.seasonTimer = setInterval(() => this.seasons.tick(), 60_000);
    this.seasonTimer.unref?.();
  }

  /** シーズンの確定のための、ランの今の状態（S0） */
  private liveRunState(runId: string): LiveRunState {
    const s = this.sessions.get(runId);
    if (!s) return null;
    if (s.world.status === 'ended') return 'ended';
    const pid = s.world.playerOrder[0];
    const st = pid ? s.world.players[pid].state : 'dead';
    return st === 'alive' ? 'in_dungeon' : st === 'at_camp' ? 'at_camp' : 'ended';
  }

  /** 起動時に復旧できなかったラン（理由の 1 行と時刻）と、そのランのトークン（V4-1m §37.1: 一覧と再開のエラーに出す） */
  private readonly failed = new Map<string, { reason: string; at: number; season?: string }>();
  private readonly failedTokens = new Map<string, string>();

  /** 起動時: 進行中だったランをキーフレーム＋コマンド再実行で復旧する */
  recoverAll(log: (msg: string) => void = () => undefined): void {
    const dir = this.config.runsDir;
    // 読めなかったプロフィールとシーズンの記録（SEASON.md §33.1 の 4: 黙って飛ばさない。読まずに残し、上書きしない）
    for (const f of this.profiles.store.brokenFiles()) log(`プロフィールのファイル ${f} が読めない（読まずに残す。上書きしない。そのプロフィールのトークンは使えない）`);
    for (const b of this.seasons.brokenSeasons()) log(`シーズン ${b.id} の記録が読めない（${b.files.join('・')}）。このシーズンは読まず、書き戻さない。シーズンのランは復旧に失敗したランとして出す`);
    if (!dir || !existsSync(dir)) return;
    // 残っている一時のファイルを掃除する（SEASON.md §36.1 の 6。書いたプロセスがもう居ないものだけ: 運用の道具が書いている最中のものは消さない）
    const swept = sweepTmpFiles([dir, this.config.profilesDir, this.config.seasonsDir]);
    if (swept) log(`残っていた一時のファイル ${swept} 個を消した`);
    for (const runId of this.store!.listRunDirs()) {
      const runDir0 = join(dir, runId);
      const ms = this.store!.metaState(runId);
      // 一時的に読めない（ほかのプログラムが開いている）: 作り直さずに、復旧に失敗したランとして出す（次の起動で直る。§36.1 の 2）
      if ('unreadable' in ms) {
        const reason = `meta.json を一時的に読めない（${ms.unreadable}。ほかのプログラムが開いている）。作り直さずに残した。次の起動で直る`;
        log(`failed to recover ${runId}: ${reason}`);
        this.markFailed(runId, reason, undefined);
        continue;
      }
      let meta = 'value' in ms ? ms.value : null;
      // meta.json が読めない・形が違う・消えた（SEASON.md §33.1 の 2）: ほかの記録から作り直す。作り直せなければ、復旧に失敗したランとして出す
      if (!meta) {
        let r: MetaRepair;
        try { r = repairMeta(runDir0, runId); } catch (e) { r = { error: `meta.json を作り直せない: ${String((e as Error).message ?? e).split('\n')[0].slice(0, 160)}` }; }
        if ('error' in r) {
          log(`failed to recover ${runId}: ${r.error}`);
          this.markFailed(runId, r.error, r.season);
          continue;
        }
        meta = r.meta;
        log(`rebuilt meta.json of ${runId} from the ${r.from === 'keyframe' ? 'latest keyframe and the event log' : 'event log'}（${r.moved ? `壊れた元は ${basename(r.moved)} に残した` : 'meta.json は無かった'}）`);
      }
      // 要約（SEASON.md §33.1 の 4）: あるのに読めなければ、出来事の記録の最後の要約から作り直す
      try {
        const sr = repairSummary(runDir0, this.catalog);
        if (sr) log(`${sr.rebuilt ? 'rebuilt summary.json/.md' : 'moved aside unreadable summary.json'} of ${runId}${sr.moved ? `（壊れた元は ${basename(sr.moved)}）` : ''}`);
      } catch (e) { log(`summary.json of ${runId} を作り直せない: ${String((e as Error).message ?? e).split('\n')[0]}`); }
      if (meta.status !== 'active') continue;
      // 再開用のトークン（tokens.json）は作り直せない。読めない・無い・どの参加者のものも無いなら、復旧に失敗したランとして出す
      if (meta.players.length) {
        const tk = readTokensStrict(runDir0);
        const have = 'tokens' in tk ? new Set(Object.values(tk.tokens)) : new Set<string>();
        if ('error' in tk || !meta.players.some((p) => have.has(p.id))) {
          const reason = 'error' in tk && tk.error === 'broken' ? 'tokens.json が読めない（再開用のトークンは、ほかの記録から作り直せない）'
            : 'error' in tk && tk.error === 'unreadable' ? 'tokens.json を一時的に読めない（ほかのプログラムが開いている）。次の起動で直る'
              : 'error' in tk ? 'tokens.json が無い（再開用のトークンは、ほかの記録から作り直せない）' : 'tokens.json に、このランの参加者のトークンが無い';
          log(`failed to recover ${runId}: ${reason}`);
          this.markFailed(runId, reason, meta.season);
          continue;
        }
        const lost = meta.players.filter((p) => !have.has(p.id));
        if (lost.length) log(`  ${runId}: tokens.json に ${lost.map((p) => p.name).join('・')} のトークンが無い（その参加者は再開できない）`);
      }
      // シーズンのランで、そのシーズンの記録が読めない（読まずに続けると、取り込みと参加者の記録が狂う）
      if (meta.season && this.seasons.isBroken(meta.season)) {
        const reason = `シーズン ${meta.season} の記録が読めない`;
        log(`failed to recover ${runId}: ${reason}`);
        this.markFailed(runId, reason, meta.season);
        continue;
      }
      try {
        const r = RunSession.recover(this.deps, runId);
        log(r.message);
        // 管理ファイル・シーズンの記録を直すのは、再生が記録と一致したときだけ（SEASON.md §38.1。食い違いは版の違いでも起きる。
        // 食い違った World から要約・meta・シーズンの数え直しを作ると、正しい記録を書き換える。食い違ったランは、今までどおり知らせて続ける）
        if (r.verified) {
          // 管理ファイルを World と比べて、違えば書き直す（§36.1 の 3: 書けなかった古い meta.json が、終わったランを進行中として残していた）
          const fixed = r.session.reconcileFiles();
          if (fixed.length) log(`  ${runId}: ${fixed.join('・')} を World に合わせて書き直した`);
          // 終わっていたラン（meta.json だけが進行中のまま残っていた）: 動いているランにしない（記録の一覧から、終わったランとして出る）
          if (r.session.world.status === 'ended') {
            if (r.session.world.meta.season) this.seasons.onRecovered(r.session);
            r.session.close();
            log(`  ${runId} は終わっていた（進行中として読み込まない）`);
            continue;
          }
        } else {
          log(`  ${runId}: 再生が記録と食い違ったので、記録のファイル・管理ファイル・シーズンの記録は直していない`);
        }
        this.sessions.set(runId, r.session);
        // シーズン（S1a §10.1 の 4）: キャンプにいるかランが終わっていれば、火を載せて支援を数え直す（落ちる前に保存できなかった分。一致したときだけ）
        if (r.verified && r.session.world.meta.season) this.seasons.onRecovered(r.session);
        // 古い版で始まったラン（V4-0b §1.2。World は変えない。記録だけ）: 分かっている不整合（遠征の開始時の検査で直るもの）
        const created = r.session.world.meta.engineVersion;
        if (created && compareVersions(created, ENGINE_VERSION) < 0) {
          const gaps = checkRunGaps(r.session.world, this.deps.content);
          log(`  古い版で始まったラン ${runId}（engine ${created}。今は ${ENGINE_VERSION}）${gaps.length ? `: ${gaps.join(' / ')}` : '。分かっている不整合は無い'}`);
        }
      } catch (e) {
        // 理由の文に、絶対のパス（利用者の名前を含む）を出さない（§36.1 の 6。記録の置き場所からの相対にする）
        const reason = scrubPaths(String((e as Error).message ?? e).split('\n')[0], dir).slice(0, 200);
        log(`failed to recover ${runId}: ${reason}`);
        this.markFailed(runId, reason, meta.season);
      }
    }
  }

  /**
   * 同じ記録の置き場所で、サーバーを 2 つ動かさない（§36.1 の 6）: 置き場所に印（`.server.lock`。プロセスの番号と起動の時刻）を置く。
   * 生きている別のサーバーの印があれば、理由の文を返す（呼ぶ側が止まる）。古い印（プロセスがもう居ない・機械の起動より前）は掃除する。
   * 運用の道具（season など）は印を取らない（サーバーが動いていても使える）
   */
  async acquireRunsLock(log: (msg: string) => void = () => undefined, probe?: (host: string | undefined, port: number) => Promise<boolean>): Promise<string | null> {
    const dir = this.config.runsDir;
    if (!dir) return null;
    try { mkdirSync(dir, { recursive: true }); } catch (e) { return `記録の置き場所（${dir}）を作れない（${(e as NodeJS.ErrnoException).code ?? ''}）`; }
    const host = this.config.host.split(',')[0]?.trim();
    const r = await acquireLock(join(dir, RUNS_LOCK), { port: this.config.port, host }, probe);
    if ('error' in r) return `${r.error}。同じ記録の置き場所で 2 つのサーバーを動かさないための印（${RUNS_LOCK}）なので、取れないまま起動しない`;
    if ('busy' in r) return `この記録の置き場所（${dir}）は、ほかのサーバー（プロセス ${r.busy.pid}${r.busy.port ? `・ポート ${r.busy.port}` : ''}、${new Date(r.busy.startedAt).toISOString()} に起動）が使っている。同じ置き場所で 2 つ動かすと、記録を壊しうるので止まる。そのサーバーを止めるか、別の置き場所（MUSE_RUNS_DIR）で起動する。そのサーバーがもう居ないのに止まるなら、${join(dir, RUNS_LOCK)} を消す`;
    if (r.stale) log(`古いサーバーの印（プロセス ${r.stale.pid}）を掃除した`);
    this.lockPath = join(dir, RUNS_LOCK);
    return null;
  }

  /** 待ち受けを始めたことを印に書く（それからは、印のプロセスが生きていても、ポートが応えなければ古い印と見る） */
  markRunsLockListening(): void {
    if (this.lockPath) markLockListening(this.lockPath);
  }

  /** 印を外す（自分のものだけ） */
  releaseRunsLock(): void {
    if (this.lockPath) releaseLock(this.lockPath);
    this.lockPath = null;
  }

  private lockPath: string | null = null;

  /** 復旧に失敗したランを覚える（一覧と再開のエラーに出す。V4-1m §37.1）。読めるトークンがあれば、そのトークンでの再開にも */
  private markFailed(runId: string, reason: string, season: string | undefined): void {
    this.failed.set(runId, { reason, at: Date.now(), ...(season ? { season } : {}) });
    for (const tok of Object.keys(this.store!.tokens(runId))) this.failedTokens.set(tok, runId);
  }

  get(runId: string): RunSession | undefined {
    return this.sessions.get(runId);
  }

  /**
   * 起動時に復旧できなかったランの、外に出す理由と時刻（V4-1m §37.1）。開催中のシーズンのランは、確定するまで理由を伏せる
   * （S3b §30.3 の 3: 「復旧に失敗した」だけ。理由の文に、ランの中身が出うる。運用者はサーバーのログで見る）
   */
  private failedShown(runId: string): { reason: string; at: number } | undefined {
    const f = this.failed.get(runId);
    if (!f) return undefined;
    return { reason: this.seasonHidden(f.season) ? HIDDEN_FAILURE : f.reason, at: f.at };
  }

  /** そのランが起動時に復旧できなかったなら、そのエラー（理由つき。V4-1m §37.1。開催中のシーズンのランは理由を伏せる） */
  recoveryFailedError(runId: string): ActionError | null {
    const f = this.failedShown(runId);
    if (!f) return null;
    if (f.reason === HIDDEN_FAILURE) {
      return actionError('recovery_failed',
        `ラン ${runId} は、サーバーの起動時に復旧に失敗した。ランの記録は残っている / run ${runId} failed to recover at server start; its records are kept`,
        'サーバーの管理者に知らせる。直してサーバーを起動し直せば、同じトークンで再開できる / tell the server operator; once fixed and restarted, resume with the same token');
    }
    return actionError('recovery_failed',
      `ラン ${runId} は、サーバーの起動時に復旧できなかった（理由: ${f.reason}）。ランの記録は残っている / run ${runId} could not be recovered at server start (${f.reason}); its records are kept`,
      'サーバーの管理者に知らせる。直してサーバーを起動し直せば、同じトークンで再開できる / tell the server operator; once fixed and restarted, resume with the same token');
  }

  /** そのトークンのランが起動時に復旧できなかったなら、そのエラー */
  recoveryFailedForToken(token: string | undefined): ActionError | null {
    const runId = token ? this.failedTokens.get(token) : undefined;
    return runId ? this.recoveryFailedError(runId) : null;
  }

  /** 新しいラン: 作成 → 参加 → 最初の遠征の開始（start_expedition をコマンドとして記録する） */
  async createRun(req: NewRunRequest & { controller: Controller }): Promise<Joined | { error: ActionError }> {
    if (req.season !== undefined) return this.createSeasonRun(req as NewRunRequest & { controller: Controller; season: string });
    // 知らないプロフィールのトークンは、ランを作る前に断る（断った後に、誰もいないランが残らない）
    if (req.profileToken && !this.profiles.store.resolve(req.profileToken)) return { error: unknownProfileError() };
    const session = RunSession.create(this.deps, { seed: req.seed, mode: req.mode ?? 'solo' });
    this.sessions.set(session.runId, session);
    // objective を省くとキャンプから始まる（最初の遠征も候補 3 つから選ぶ。V3-2R §14.4）
    const atCamp = req.objective === undefined;
    const joined = await this.joinSession(session, { name: req.name, classId: req.classId, locale: req.locale, controller: req.controller, atCamp, profileToken: req.profileToken, legacy: req.legacy }, req.controller.kind === 'agent' ? 'mcp' : 'ws');
    // 参加が断られた（知らない職業など）: 作ったばかりのランは捨てる（一覧にも記録のフォルダにも残さない）
    if ('error' in joined) { this.sessions.delete(session.runId); session.discard(); return joined; }
    if (atCamp) return joined;
    const offer = firstOffer(joined.port.view().camp?.offers ?? [], req.objective ?? 'auto');
    if (offer !== null) {
      const r = await session.submit(joined.playerId, { type: 'start_expedition', offer }, { source: 'system' });
      if (!r.ok) return { error: r.error };
    }
    return joined;
  }

  /**
   * シーズンのラン（S0。PROTOCOL §9.1）: シーズンのシードでソロ、Lv1 のキャンプから。継承は受けない。
   * 参加者（プロフィール）ごとに同時に 1 つ。参加の直後に取り込む（予算・公開された階段・順位）
   */
  private async createSeasonRun(req: NewRunRequest & { controller: Controller; season: string }): Promise<Joined | { error: ActionError }> {
    // 招かれたプロフィールだけ（S0a。SEASON.md §4.1）: トークンは必須。知らないトークンも、理由つきで断る（ランを作る前に）
    const prof = req.profileToken ? this.profiles.store.resolve(req.profileToken) : null;
    if (req.profileToken && !prof) {
      return { error: actionError('season_unavailable', 'そのプロフィールのトークンは見つからない。運用者から受け取った profile_token を確かめる / unknown profile_token; check the token the operator gave you', '運用者に招いてもらう / ask the operator to invite you') };
    }
    const profileId = prof?.id ?? null;
    const chk = this.seasons.canStart(req.season, profileId);
    if ('reason' in chk) return { error: actionError('season_unavailable', chk.reason, profileId ? 'list_runs の seasons で開いているシーズンを確かめる / check open seasons with list_runs' : '運用者から受け取った profile_token を渡す / pass the profile_token the operator gave you') };
    const def = chk.def;
    const session = RunSession.create(this.deps, { seed: def.seed, mode: 'solo', season: { id: def.id, name: def.name } });
    this.sessions.set(session.runId, session);
    const joined = await this.joinSession(session, { name: req.name, classId: req.classId, locale: req.locale, controller: req.controller, atCamp: true, profileToken: req.profileToken, legacy: false }, req.controller.kind === 'agent' ? 'mcp' : 'ws');
    if ('error' in joined) { this.sessions.delete(session.runId); session.discard(); return joined; }
    // 順位の表の名前は、招いたときの表示名（S0a）
    this.seasons.registerRun(def.id, joined.profile.id, chk.name, session.runId);
    await session.syncSeason(joined.playerId, 'join');
    return joined;
  }

  async joinRun(runId: string, req: { name: string; classId?: string; locale?: Locale; controller: Controller; profileToken?: string; legacy?: boolean }): Promise<Joined | { error: ActionError }> {
    const session = this.sessions.get(runId);
    if (!session) return { error: this.recoveryFailedError(runId) ?? actionError('no_session', `run ${runId} is not active`, 'list_runs で参加可能なランを確認する / check list_runs') };
    // シーズンのランはソロ（S0 §9.1）。ほかの者は入れない
    if (session.world.meta.season) return { error: actionError('season_unavailable', 'シーズンのランには参加できない（new_run の season で自分のランを始める） / season runs are solo; start your own with new_run { season }', 'new_run { season }') };
    // 協力プレイのランに入った者は、遠征が進んでいても、キャンプから始める。進んでいる遠征には入らず、次の遠征から一緒に出る（V4-1g G1）
    return this.joinSession(session, { ...req, atCamp: true }, req.controller.kind === 'agent' ? 'mcp' : 'ws');
  }

  private async joinSession(session: RunSession, req: { name: string; classId?: string; locale?: Locale; controller: Controller; atCamp?: boolean; profileToken?: string; legacy?: boolean }, source: 'mcp' | 'ws'): Promise<Joined | { error: ActionError }> {
    const base = { type: 'join' as const, name: req.name.slice(0, 32) || 'Muse', classId: req.classId, controller: req.controller, locale: req.locale ?? 'ja', ...(req.atCamp ? { atCamp: true } : {}) };
    // プロフィール（V3-7 §7.1）: トークンが無ければ新しく作る。知らないトークンは拒否（黙って別のプロフィールに積まない）
    const known = req.profileToken ? this.profiles.store.resolve(req.profileToken) : null;
    if (req.profileToken && !known) return { error: unknownProfileError() };
    // 断られる参加では、プロフィールを作らない（S3i §46.2 の 1。参加の可否はプロフィールの ID・継承によらない）。ここで通っても、本当の参加でもう一度試す
    const refused = session.joinRefusal({ ...base, profile: known?.id ?? 'prof_probe' });
    if (refused) return { error: refused };
    let profile: { id: string; token?: string };
    if (known) profile = { id: known.id };
    else {
      const c = this.profiles.store.create(req.name, Date.now());
      profile = { id: c.profile.id, token: c.token };
    }
    // 継承（V3-7 §7.3）: 既定であり。サーバーの legacyPolicy が off か、legacy: false なら無し。中身は参加コマンドに入り commands.jsonl に残る
    const useLegacy = this.config.legacyPolicy === 'on' && req.legacy !== false;
    const monsters = useLegacy ? this.profiles.legacyFor(profile.id, session.runId) : [];
    const join: JoinCommand = { ...base, profile: profile.id, ...(monsters.length ? { legacy: { monsters } } : {}) };
    const r = await session.join(join, source);
    if (!r.ok) return { error: r.error };
    return { session, playerId: r.playerId, token: r.token, port: new SessionPlayerPort(session, r.playerId), profile };
  }

  /** プロフィールのトークン → 読み取り口（V3-7） */
  profilePortForToken(token: string): ProfilePort | null {
    const p = this.profiles.store.resolve(token);
    return p ? this.profilePort(p.id) : null;
  }

  profilePort(id: string): ProfilePort | null {
    if (!this.profiles.store.get(id)) return null;
    return new ProfilePort(this.profiles, id, (runId) => this.sessions.get(runId)?.world.status === 'active', () => this.seasons.titlesOf(id));
  }

  /** トークン → (セッション, プレイヤー) */
  resolveToken(token: string): { session: RunSession; playerId: PlayerId } | null {
    for (const s of this.sessions.values()) {
      const pid = s.playerForToken(token);
      if (pid) return { session: s, playerId: pid };
    }
    return null;
  }

  portForToken(token: string): PlayerPort | null {
    const r = this.resolveToken(token);
    return r ? new SessionPlayerPort(r.session, r.playerId) : null;
  }

  listRuns(): RunListing[] {
    const out: RunListing[] = [];
    const seen = new Set<string>();
    for (const s of this.sessions.values()) {
      seen.add(s.runId);
      const w = s.world;
      const players: RunListingPlayer[] = w.playerOrder.map((pid) => {
        const p = w.players[pid];
        const e = w.entities[p.entityId];
        return {
          id: pid, name: p.name, classId: p.classId, controller: p.controller, state: p.state,
          depth: e?.pos ? w.floors[e.pos.floor]?.depth ?? null : p.stats.deepest, level: e?.level?.level ?? 1,
        };
      });
      const alive = players.filter((p) => p.state === 'alive' || p.state === 'at_camp').length;
      // 開催中のシーズンのラン（S2a §20.10 の 2・S3a §27.9 の 3。終わったランも、確定するまで）: 名前と、シーズンのランであることだけ
      // （今いる階・レベル・状態・遠征・進み具合・要約を出さない。外との出入りはキャンプでだけ）
      if (w.meta.season && this.seasonHidden(w.meta.season.id)) {
        out.push(hiddenListing(s.runId, w.status, w.meta.mode, w.meta.season.id, s.createdAt, true, players));
        continue;
      }
      out.push({
        runId: s.runId, status: w.status, mode: w.meta.mode, ...(w.meta.season ? { season: w.meta.season.id } : {}), createdAt: s.createdAt, updatedAt: s.updatedAt, seq: w.seq,
        live: true, joinable: w.status === 'active' && alive < w.meta.options.maxPlayers, players, summary: s.summary() ?? undefined,
        expeditions: (w.expeditions ?? []).map((x) => ({ no: x.no, objective: { ...x.objective }, status: x.status, endReason: x.endReason, points: x.points, startSeq: x.startSeq, endSeq: x.endSeq })),
      });
    }
    if (this.store) {
      for (const id of this.store.listRunIds()) {
        if (seen.has(id)) continue;
        const meta = this.store.meta(id);
        if (!meta) continue;
        if (meta.season && this.seasonHidden(meta.season)) {
          out.push(hiddenListing(id, meta.status, meta.mode, meta.season, meta.createdAt, false, meta.players.map((p) => ({ id: p.id, name: p.name, classId: p.classId, controller: p.controller })), this.failedShown(id)));
          continue;
        }
        const summary = this.store.summary(id) ?? undefined;
        out.push({
          // シーズンのラン（S3: ロビーが、確定する前のシーズンのランの巻き戻しを出し分ける）
          runId: id, status: meta.status, mode: meta.mode, ...(meta.season ? { season: meta.season } : {}), createdAt: meta.createdAt, updatedAt: meta.endedAt ?? this.store.mtime(id), seq: meta.lastSeq ?? 0,
          live: false, joinable: false,
          players: meta.players.map((p) => {
            const sp = summary?.players.find((x) => x.id === p.id);
            return { id: p.id, name: p.name, classId: p.classId, controller: p.controller, state: sp?.state ?? 'dead', depth: sp?.deepest ?? null, level: sp?.level ?? 1 };
          }),
          summary,
          expeditions: summary?.expeditions,
          ...(this.failed.has(id) ? { recoveryFailed: this.failedShown(id)! } : {}),
        });
        seen.add(id);
      }
    }
    // meta.json が読めず、作り直せもしなかったラン（SEASON.md §33.1 の 3）: ランの ID と失敗だけ（参加者・状態は分からない）
    for (const [id, f] of this.failed) {
      if (seen.has(id) || (this.store && this.store.meta(id))) continue;
      out.push({
        runId: id, status: 'active', mode: 'solo', ...(f.season ? { season: f.season } : {}), createdAt: f.at, updatedAt: f.at, seq: 0,
        live: false, joinable: false, players: [], recoveryFailed: this.failedShown(id)!,
      });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * 開催中のシーズンのランか（S3a §27.9 の 3）: 結果が確定するまで、どの口（ランの一覧・リーダーボード・meta）からも、
   * 名前とシーズンのランであることだけを出す（§20.10 の 2 と同じ考え）
   */
  seasonHidden(seasonId: string | undefined | null): boolean {
    return !!seasonId && !this.seasonFinal(seasonId);
  }

  /** シーズンの結果が確定しているか（S3 §25.1: 確定した後は、だれでも観戦・巻き戻しできる） */
  seasonFinal(seasonId: string | undefined | null): boolean {
    return !!seasonId && !!this.seasons.get(seasonId)?.result;
  }

  /**
   * そのランを観戦できるか（S3。SEASON.md §25.1・PROTOCOL §9.7）。確定する前のシーズンのランは、そのランの参加者のトークン（owner: その参加者を追う）か、
   * サーバーと同じ機械からの接続（local）だけ。シーズンのランでない・確定したシーズンのランは public（今までどおり）
   */
  seasonWatchAccess(session: RunSession, o: { local: boolean; profileToken?: string }): { access: 'public' | 'local' } | { access: 'owner'; pid: PlayerId } | { error: ActionError } {
    const sid = session.world.meta.season?.id;
    if (!sid || this.seasonFinal(sid)) return { access: 'public' };
    const who = this.ownerOf(session, o);
    if (who) return who;
    return { error: seasonWatchError(!!o.profileToken) };
  }

  /**
   * そのランの持ち主か（S3 §25.1 の観戦の認め方。S8 §54.1 の持ち主の口も、これを使う）: サーバーと同じ機械からの接続（local: すべてのプレイヤー）か、
   * そのランのプレイヤーのプロフィールのトークン（owner: そのプレイヤー）。どちらでもなければ null
   */
  ownerOf(session: RunSession, o: { local: boolean; profileToken?: string }): { access: 'local' } | { access: 'owner'; pid: PlayerId } | null {
    if (o.local) return { access: 'local' };
    const prof = o.profileToken ? this.profiles.store.resolve(o.profileToken) : null;
    const pid = prof ? session.world.playerOrder.find((p) => session.profileOf(p) === prof.id) : undefined;
    return pid ? { access: 'owner', pid } : null;
  }

  /**
   * 持ち主の口（S8 §54.1）: そのランで、持ち主と認められたプレイヤー（同じ機械からなら最初のプレイヤー。持ち主の口はソロのランだけなので 1 人）。
   * 認められなければ断り（トークンが違う・外からの接続）
   */
  ownerAccess(runId: string, o: { local: boolean; profileToken?: string }): { session: RunSession; pid: PlayerId } | { error: ActionError; status: number } {
    const session = this.sessions.get(runId);
    if (!session) {
      const f = this.recoveryFailedError(runId);
      return f ? { error: f, status: 503 } : { error: actionError('no_session', `unknown or finished run ${runId}`, 'GET /api/owner/runs'), status: 404 };
    }
    const who = this.ownerOf(session, o);
    if (!who) return { error: actionError('bad_request', 'この口は、そのランのプレイヤーのプロフィールのトークンか、サーバーと同じ機械からだけ / owner access needs the player\'s profile token or the same machine', 'Authorization: Bearer <profile_token>'), status: 403 };
    const pid = who.access === 'owner' ? who.pid : session.world.playerOrder[0];
    if (!pid) return { error: actionError('no_session', 'no player in this run', ''), status: 404 };
    return { session, pid };
  }

  /** 持ち主と認められた、進行中のラン（S8 §54.7 の「出撃」）。同じ機械からなら、すべての進行中のラン（ソロのものだけ） */
  ownerRuns(o: { local: boolean; profileToken?: string }): OwnerRunsResponse {
    const runs: OwnerRunRow[] = [];
    for (const s of this.sessions.values()) {
      if (s.world.status !== 'active' || s.world.meta.mode !== 'solo') continue;
      const who = this.ownerOf(s, o);
      if (!who) continue;
      const pid = who.access === 'owner' ? who.pid : s.world.playerOrder[0];
      const pr = pid ? s.world.players[pid] : undefined;
      if (!pid || !pr || pr.state === 'dead' || pr.state === 'left') continue;
      const sid = s.world.meta.season?.id;
      const d = sid ? this.seasons.get(sid) : null;
      // シーズンの名前と、その参加者の表示名（順位の表の名前。招いたときの名前。持ち主の画面が自分の行を目立たせる）
      const prof = s.profileOf(pid);
      const participant = d?.participants.find((x) => x.profileId === prof)?.name;
      runs.push(ownerRow(s, pid, d ? { name: d.def.name, ...(participant ? { participant } : {}) } : undefined));
    }
    return { local: o.local, runs: runs.sort((a, b) => Number(b.waiting) - Number(a.waiting) || b.updatedAt - a.updatedAt) };
  }

  /** いま観戦できる、そのシーズンの進行中のラン（S3。GET /api/seasons/:id/watch。人間の画面のロビーの「観戦」） */
  seasonWatchable(seasonId: string, o: { local: boolean; profileToken?: string }): SeasonWatchResponse | null {
    const d = this.seasons.get(seasonId);
    if (!d) return null;
    const final = !!d.result;
    const prof = o.profileToken ? this.profiles.store.resolve(o.profileToken) : null;
    const runs: SeasonWatchResponse['runs'] = [];
    for (const s of this.sessions.values()) {
      const w = s.world;
      if (w.meta.season?.id !== seasonId || w.status !== 'active') continue;
      const owners = w.playerOrder.map((p) => s.profileOf(p));
      if (!final && !o.local && !(prof && owners.includes(prof.id))) continue;
      const name = d.participants.find((p) => owners.includes(p.profileId))?.name ?? w.players[w.playerOrder[0]]?.name ?? '?';
      runs.push({ runId: s.runId, name });
    }
    return { local: o.local, final, runs: runs.sort((a, b) => a.name.localeCompare(b.name) || (a.runId < b.runId ? -1 : 1)) };
  }

  /** AI パネル用のツール呼び出し記録（観戦にのみ流す） */
  recordActivity(runId: string, a: AgentActivity): void {
    this.sessions.get(runId)?.recordAgentActivity(a);
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    // 書けなかった管理ファイルを、もう一度書く（§36.1 の 3・5）
    retryPendingWrites();
    this.seasons.flush();
    if (this.seasonTimer) { clearInterval(this.seasonTimer); this.seasonTimer = null; }
  }
}

/** 開催中のシーズンのランの、復旧に失敗した理由の代わりの文（S3b §30.3 の 3） */
const HIDDEN_FAILURE = '開催中のシーズンのランは、確定するまで理由を出さない / not shown until the season is final';

/** 開催中のシーズンのランの一覧の行（S2a・S3a）: 名前・職業・操作の種類と、シーズンのランであることだけ（state・depth・level は意味を持たない） */
function hiddenListing(runId: string, status: RunListing['status'], mode: RunListing['mode'], season: string, createdAt: number, live: boolean,
  players: { id: PlayerId; name: string; classId: string; controller: Controller }[], failed?: { reason: string; at: number }): RunListing {
  return {
    runId, status, mode, season, createdAt, updatedAt: createdAt, seq: 0, live, joinable: false,
    players: players.map((p) => ({ id: p.id, name: p.name, classId: p.classId, controller: p.controller, state: 'alive', depth: null, level: 0, hidden: true })),
    ...(failed ? { recoveryFailed: { ...failed } } : {}),
  };
}

/** new_run の objective → 最初の遠征の候補番号（auto = 1 番目、endless は目的なし） */
export function firstOffer(offers: ExpeditionOffer[], choice: ObjectiveChoice): number | 'endless' | null {
  if (!offers.length) return null;
  if (choice === 'endless') return 'endless';
  if (choice === 'auto') return offers[0].index;
  return offers.find((o) => o.objective.type === choice)?.index ?? offers[0].index;
}

export function runDir(config: ServerConfig, runId: string): string {
  return join(config.runsDir!, runId);
}

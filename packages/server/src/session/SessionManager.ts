// 複数ランの管理。参加時にプレイヤートークンを発行し、再接続・再開はトークンで行う。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@muse/content';
import { buildCatalog } from '@muse/content';
import { checkRunGaps, compareVersions, ENGINE_VERSION } from '@muse/engine';
import type {
  ActionError, AgentActivity, Catalog, Controller, ExpeditionOffer, JoinCommand, Locale, NewRunRequest, ObjectiveChoice, PlayerId, RunListing,
  RunListingPlayer,
} from '@muse/shared';
import { actionError } from '@muse/shared';
import type { ServerConfig } from '../config';
import { RunStore } from '../log/RunStore';
import { SessionPlayerPort } from './PlayerPort';
import type { PlayerPort } from './PlayerPort';
import { RunSession } from './RunSession';

/** 知らないプロフィールのトークン（V3-7 §7.1。黙って別のプロフィールに積まない） */
function unknownProfileError(): ActionError {
  return actionError('no_session', 'そのプロフィールのトークンは見つからない / unknown profile_token', 'profile_token を省くと新しいプロフィールを作る / omit profile_token to create a new profile');
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
  private seasonTimer: NodeJS.Timeout | null = null;

  constructor(content: Content, readonly config: ServerConfig) {
    this.catalog = buildCatalog(content);
    this.profiles = new ProfileService(content, this.catalog, new ProfileStore(config.profilesDir));
    this.seasons = new SeasonService(new SeasonStore(config.seasonsDir ?? null), { engineVersion: ENGINE_VERSION, contentVersion: content.version }, (runId) => this.liveRunState(runId));
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
  private readonly failed = new Map<string, { reason: string; at: number }>();
  private readonly failedTokens = new Map<string, string>();

  /** 起動時: 進行中だったランをキーフレーム＋コマンド再実行で復旧する */
  recoverAll(log: (msg: string) => void = () => undefined): void {
    const dir = this.config.runsDir;
    if (!dir || !existsSync(dir)) return;
    for (const runId of readdirSync(dir)) {
      if (!runId.startsWith('run_')) continue;
      const meta = this.store!.meta(runId);
      if (!meta || meta.status !== 'active') continue;
      try {
        const r = RunSession.recover(this.deps, runId);
        this.sessions.set(runId, r.session);
        log(r.message);
        // 古い版で始まったラン（V4-0b §1.2。World は変えない。記録だけ）: 分かっている不整合（遠征の開始時の検査で直るもの）
        const created = r.session.world.meta.engineVersion;
        if (created && compareVersions(created, ENGINE_VERSION) < 0) {
          const gaps = checkRunGaps(r.session.world, this.deps.content);
          log(`  古い版で始まったラン ${runId}（engine ${created}。今は ${ENGINE_VERSION}）${gaps.length ? `: ${gaps.join(' / ')}` : '。分かっている不整合は無い'}`);
        }
      } catch (e) {
        const reason = String((e as Error).message ?? e).split('\n')[0].slice(0, 200);
        log(`failed to recover ${runId}: ${reason}`);
        this.failed.set(runId, { reason, at: Date.now() });
        for (const tok of Object.keys(this.store!.tokens(runId))) this.failedTokens.set(tok, runId);
      }
    }
  }

  get(runId: string): RunSession | undefined {
    return this.sessions.get(runId);
  }

  /** そのランが起動時に復旧できなかったなら、そのエラー（理由つき。V4-1m §37.1） */
  recoveryFailedError(runId: string): ActionError | null {
    const f = this.failed.get(runId);
    if (!f) return null;
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
    // プロフィール（V3-7 §7.1）: トークンが無ければ新しく作る。知らないトークンは拒否（黙って別のプロフィールに積まない）
    let profile: { id: string; token?: string };
    if (req.profileToken) {
      const p = this.profiles.store.resolve(req.profileToken);
      if (!p) return { error: unknownProfileError() };
      profile = { id: p.id };
    } else {
      const c = this.profiles.store.create(req.name, Date.now());
      profile = { id: c.profile.id, token: c.token };
    }
    // 継承（V3-7 §7.3）: 既定であり。サーバーの legacyPolicy が off か、legacy: false なら無し。中身は参加コマンドに入り commands.jsonl に残る
    const useLegacy = this.config.legacyPolicy === 'on' && req.legacy !== false;
    const monsters = useLegacy ? this.profiles.legacyFor(profile.id, session.runId) : [];
    const join: JoinCommand = {
      type: 'join', name: req.name.slice(0, 32) || 'Muse', classId: req.classId, controller: req.controller, locale: req.locale ?? 'ja', ...(req.atCamp ? { atCamp: true } : {}),
      profile: profile.id, ...(monsters.length ? { legacy: { monsters } } : {}),
    };
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
    return new ProfilePort(this.profiles, id, (runId) => this.sessions.get(runId)?.world.status === 'active');
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
        const summary = this.store.summary(id) ?? undefined;
        out.push({
          runId: id, status: meta.status, mode: meta.mode, createdAt: meta.createdAt, updatedAt: meta.endedAt ?? this.store.mtime(id), seq: meta.lastSeq ?? 0,
          live: false, joinable: false,
          players: meta.players.map((p) => {
            const sp = summary?.players.find((x) => x.id === p.id);
            return { id: p.id, name: p.name, classId: p.classId, controller: p.controller, state: sp?.state ?? 'dead', depth: sp?.deepest ?? null, level: sp?.level ?? 1 };
          }),
          summary,
          expeditions: summary?.expeditions,
          ...(this.failed.has(id) ? { recoveryFailed: { ...this.failed.get(id)! } } : {}),
        });
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** AI パネル用のツール呼び出し記録（観戦にのみ流す） */
  recordActivity(runId: string, a: AgentActivity): void {
    this.sessions.get(runId)?.recordAgentActivity(a);
  }

  closeAll(): void {
    for (const s of this.sessions.values()) s.close();
    this.seasons.flush();
    if (this.seasonTimer) { clearInterval(this.seasonTimer); this.seasonTimer = null; }
  }
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

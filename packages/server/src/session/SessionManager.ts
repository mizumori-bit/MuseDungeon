// 複数ランの管理。参加時にプレイヤートークンを発行し、再接続・再開はトークンで行う。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@muse/content';
import { buildCatalog } from '@muse/content';
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
import type { SessionDeps } from './RunSession';

export interface Joined { session: RunSession; playerId: PlayerId; token: string; port: PlayerPort }

export class SessionManager {
  readonly sessions = new Map<string, RunSession>();
  readonly deps: SessionDeps;
  readonly store: RunStore | null;
  readonly catalog: Catalog;

  constructor(content: Content, readonly config: ServerConfig) {
    this.catalog = buildCatalog(content);
    this.deps = { content, catalog: this.catalog, config };
    this.store = config.runsDir ? new RunStore(config.runsDir) : null;
  }

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
      } catch (e) {
        log(`failed to recover ${runId}: ${(e as Error).message}`);
      }
    }
  }

  get(runId: string): RunSession | undefined {
    return this.sessions.get(runId);
  }

  /** 新しいラン: 作成 → 参加 → 最初の遠征の開始（start_expedition をコマンドとして記録する） */
  async createRun(req: NewRunRequest & { controller: Controller }): Promise<Joined | { error: ActionError }> {
    const session = RunSession.create(this.deps, { seed: req.seed, mode: req.mode ?? 'solo' });
    this.sessions.set(session.runId, session);
    const joined = await this.joinSession(session, { name: req.name, classId: req.classId, locale: req.locale, controller: req.controller }, req.controller.kind === 'agent' ? 'mcp' : 'ws');
    if ('error' in joined) return joined;
    const offer = firstOffer(joined.port.view().camp?.offers ?? [], req.objective ?? 'auto');
    if (offer !== null) {
      const r = await session.submit(joined.playerId, { type: 'start_expedition', offer }, { source: 'system' });
      if (!r.ok) return { error: r.error };
    }
    return joined;
  }

  async joinRun(runId: string, req: { name: string; classId?: string; locale?: Locale; controller: Controller }): Promise<Joined | { error: ActionError }> {
    const session = this.sessions.get(runId);
    if (!session) return { error: actionError('no_session', `run ${runId} is not active`, 'list_runs で参加可能なランを確認する / check list_runs') };
    return this.joinSession(session, req, req.controller.kind === 'agent' ? 'mcp' : 'ws');
  }

  private async joinSession(session: RunSession, req: { name: string; classId?: string; locale?: Locale; controller: Controller }, source: 'mcp' | 'ws'): Promise<Joined | { error: ActionError }> {
    const join: JoinCommand = { type: 'join', name: req.name.slice(0, 32) || 'Muse', classId: req.classId, controller: req.controller, locale: req.locale ?? 'ja' };
    const r = await session.join(join, source);
    if (!r.ok) return { error: r.error };
    return { session, playerId: r.playerId, token: r.token, port: new SessionPlayerPort(session, r.playerId) };
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
        runId: s.runId, status: w.status, mode: w.meta.mode, createdAt: s.createdAt, updatedAt: s.updatedAt, seq: w.seq,
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

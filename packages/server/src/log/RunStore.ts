// ディスク上のラン記録の読み出し（ReplayPort の土台）。観戦者向けの変換もここで行う。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRecord, ExpeditionBrief, GameEvent, LeaderboardEntry, Marker, RunIndex, RunMetaFile, RunSummary, World } from '@muse/shared';
import { INTERNAL_EVENT_TYPES, stripSecret } from '@muse/shared';
import type { KeyframeFile } from './LogWriter';
import { isRunMeta, logBounds } from './repair';
import { readJsonStable } from './atomicWrite';

/**
 * 観戦者・HTTP 向けのイベント: 進行中は secret を伏せる。
 * 内部イベント（rng_advanced）は中身を空にして残す（seq の連続性を保ち、観戦側の World.seq をライブと一致させる）。
 */
export function spectatorEvent(ev: GameEvent, runEnded: boolean): GameEvent | null {
  if (ev.type === 'rng_advanced') return { ...ev, states: {} };
  if (INTERNAL_EVENT_TYPES.has(ev.type)) return null;
  if (ev.type === 'run_started') {
    const s = ev.secret;
    return { ...ev, secret: s ? { seed: runEnded ? s.seed : '', rng: {}, appearances: { ...s.appearances } } : null };
  }
  return ev;
}

export function spectatorWorld(world: World): World {
  return stripSecret(world);
}

export function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    // 頭の空のバイトは、落ちて中身が届かなかった追記の残り（その後ろにつながった行は読める。SEASON.md §33.1）
    const line = raw.replace(/^\0+/, '');
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as T); } catch { /* 末尾の書きかけ行は無視 */ }
  }
  return out;
}

export class MarkerBuilder {
  readonly markers: Marker[] = [];
  /** 遠征単位のリプレイ選択用 */
  readonly expeditions: ExpeditionBrief[] = [];
  private playerEntity = new Map<string, string>();
  private names = new Map<string, string>();
  private maxHp = new Map<string, number>();
  private lowFlag = new Set<string>();

  add(ev: GameEvent): void {
    switch (ev.type) {
      case 'player_joined':
        this.playerEntity.set(ev.entity.id, ev.player.id);
        this.names.set(ev.player.id, ev.player.name);
        this.maxHp.set(ev.entity.id, ev.entity.stats?.maxHp ?? 1);
        this.markers.push({ seq: ev.seq, type: 'join', label: `${ev.player.name} joined`, player: ev.player.id });
        break;
      case 'entity_changed_floor': {
        const pid = this.playerEntity.get(ev.id);
        if (pid) this.markers.push({ seq: ev.seq, type: 'floor', label: `${this.names.get(pid)} → ${ev.to.floor}`, player: pid });
        break;
      }
      case 'level_up': {
        const pid = this.playerEntity.get(ev.target);
        this.maxHp.set(ev.target, ev.statsAfter.maxHp);
        if (pid) this.markers.push({ seq: ev.seq, type: 'level_up', label: `${this.names.get(pid)} Lv${ev.levelAfter}`, player: pid });
        break;
      }
      case 'stats_changed':
        if (this.playerEntity.has(ev.target)) this.maxHp.set(ev.target, ev.statsAfter.maxHp);
        break;
      case 'max_hp_changed':
        if (this.playerEntity.has(ev.target)) this.maxHp.set(ev.target, ev.maxHpAfter);
        break;
      case 'damaged': {
        const pid = this.playerEntity.get(ev.target);
        if (!pid) break;
        const max = this.maxHp.get(ev.target) ?? 1;
        if (ev.hpAfter > 0 && ev.hpAfter * 4 < max) {
          if (!this.lowFlag.has(ev.target)) {
            this.lowFlag.add(ev.target);
            this.markers.push({ seq: ev.seq, type: 'near_death', label: `${this.names.get(pid)} HP ${ev.hpAfter}/${max}`, player: pid });
          }
        }
        break;
      }
      case 'healed':
        if (this.playerEntity.has(ev.target) && ev.hpAfter * 2 >= (this.maxHp.get(ev.target) ?? 1)) this.lowFlag.delete(ev.target);
        break;
      case 'died': {
        const victim = this.playerEntity.get(ev.id);
        if (victim) this.markers.push({ seq: ev.seq, type: 'death', label: `${this.names.get(victim)} died`, player: victim });
        else {
          const killer = ev.killer ? this.playerEntity.get(ev.killer) : undefined;
          if (killer) this.markers.push({ seq: ev.seq, type: 'kill', label: `${ev.kind}`, player: killer });
        }
        break;
      }
      case 'thought':
        this.markers.push({ seq: ev.seq, type: 'thought', label: ev.text.slice(0, 60), player: ev.player });
        break;
      case 'run_ended':
        this.markers.push({ seq: ev.seq, type: 'end', label: ev.reason });
        break;
      case 'expedition_started':
        this.markers.push({ seq: ev.seq, type: 'expedition_start', label: `#${ev.expedition.no} ${ev.expedition.objective.type}${ev.expedition.objective.targetDepth ? ` @${ev.expedition.objective.targetDepth}` : ''}` });
        this.expeditions.push({
          no: ev.expedition.no, objective: { ...ev.expedition.objective }, status: 'in_progress', endReason: null,
          points: ev.expedition.points, startSeq: ev.seq, endSeq: null,
        });
        break;
      case 'objective_completed':
        this.markers.push({ seq: ev.seq, type: 'objective', label: `#${ev.no} ${ev.objective.type}` });
        for (const x of this.expeditions) if (x.no === ev.no) x.status = 'objective_complete';
        break;
      case 'expedition_ended':
        this.markers.push({ seq: ev.seq, type: 'expedition_end', label: `#${ev.no} ${ev.reason}` });
        for (const x of this.expeditions) if (x.no === ev.no) { x.status = 'ended'; x.endReason = ev.reason; x.endSeq = ev.seq; }
        break;
      default:
        break;
    }
  }
}

export class RunStore {
  constructor(readonly runsDir: string) {}

  dir(runId: string): string {
    return join(this.runsDir, runId);
  }

  exists(runId: string): boolean {
    return /^run_[0-9a-z]+$/.test(runId) && existsSync(join(this.dir(runId), 'meta.json'));
  }

  /** 再開用トークン（tokens.json。サーバーの中だけで使う。復旧に失敗したランのトークンを見分けるため。V4-1m §37.1） */
  tokens(runId: string): Record<string, string> {
    const p = join(this.dir(runId), 'tokens.json');
    try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) as Record<string, string> : {}; } catch { return {}; }
  }

  listRunIds(): string[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir).filter((d) => d.startsWith('run_') && existsSync(join(this.runsDir, d, 'meta.json')));
  }

  /** ランの記録のフォルダ（meta.json が消えていても、出来事の記録があれば。起動時の復旧が作り直す。SEASON.md §33.1） */
  listRunDirs(): string[] {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir).filter((d) => /^run_[0-9a-z]+$/.test(d)
      && (existsSync(join(this.runsDir, d, 'meta.json')) || existsSync(join(this.runsDir, d, 'events.jsonl'))));
  }

  /** meta.json（読めない・形が違うものは null。起動時の復旧が作り直す） */
  meta(runId: string): RunMetaFile | null {
    const r = this.metaState(runId);
    return 'value' in r ? r.value : null;
  }

  /** meta.json の状態（§36.1 の 2: 無い・一時的に読めない・壊れている・読めた、を分ける。BOM は外す） */
  metaState(runId: string): ReturnType<typeof readJsonStable<RunMetaFile>> {
    return readJsonStable<RunMetaFile>(join(this.dir(runId), 'meta.json'), isRunMeta);
  }

  summary(runId: string): RunSummary | null {
    const r = readJsonStable<RunSummary>(join(this.dir(runId), 'summary.json'), (v) => !!v && typeof v === 'object' && Array.isArray((v as RunSummary).players));
    return 'value' in r ? r.value : null;
  }

  mtime(runId: string): number {
    try { return statSync(join(this.dir(runId), 'events.jsonl')).mtimeMs; } catch { return 0; }
  }

  events(runId: string): GameEvent[] {
    return readJsonl<GameEvent>(join(this.dir(runId), 'events.jsonl'));
  }

  commands(runId: string): CommandRecord[] {
    return readJsonl<CommandRecord>(join(this.dir(runId), 'commands.jsonl'));
  }

  /**
   * 命令の記録が覆っている出来事だけ（S3i §46.2 の 5。起動時の復旧・replay:verify と同じ読み方 logBounds）。
   * 命令を書く前に落ちた出来事など、区間の外の出来事を巻き戻しの画面に出さない。読み方だけで、ファイルは変えない
   */
  coveredEvents(runId: string): GameEvent[] {
    const events = this.events(runId);
    const b = logBounds(events, this.commands(runId));
    return events.filter((e) => b.covers(e.seq));
  }

  keyframeSeqs(runId: string): number[] {
    const d = join(this.dir(runId), 'keyframes');
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10)).sort((a, b) => a - b);
  }

  keyframe(runId: string, seq: number): KeyframeFile | null {
    try { return JSON.parse(readFileSync(join(this.dir(runId), 'keyframes', `${seq}.json`), 'utf8')); } catch { return null; }
  }

  index(runId: string, events?: GameEvent[]): RunIndex {
    const evs = events ?? this.events(runId);
    const mb = new MarkerBuilder();
    for (const ev of evs) mb.add(ev);
    return { runId, lastSeq: evs.length ? evs[evs.length - 1].seq : 0, markers: mb.markers, keyframes: this.keyframeSeqs(runId), expeditions: mb.expeditions };
  }

  /** 記録（ラン終了時、または遠征の終了ごとの途中経過）。達成した遠征の数を主な並び順にする */
  leaderboard(hideSeason: (seasonId: string) => boolean = () => false): LeaderboardEntry[] {
    const out: LeaderboardEntry[] = [];
    for (const id of this.listRunIds()) {
      const s = this.summary(id);
      if (!s) continue;
      const meta = this.meta(id);
      // 開催中のシーズンのランは載せない（S3a §27.9 の 3: 確定するまで、名前とシーズンのランであることだけ）
      if (meta?.season && hideSeason(meta.season)) continue;
      const endedAt = meta?.endedAt ?? this.mtime(id);
      const ongoing = meta?.status === 'active';
      for (const p of s.players) {
        out.push({
          runId: id, playerId: p.id, name: p.name, classId: p.classId, controller: p.controller, deepest: p.deepest,
          kills: p.kills, level: p.level, turns: p.turns, score: p.score, deathCause: p.deathCause, endedAt,
          expeditions: p.expeditions ?? 0, ongoing, scoreVersion: s.scoreVersion ?? 1, ...(p.legacy ? { legacy: true } : {}),
        });
      }
    }
    // 版 2 は確定点、同点なら達成した遠征の数・最深。版 1 は従来どおり。版ごとに別の表（版 2 が先）
    return out.sort((a, b) => b.scoreVersion - a.scoreVersion
      || (a.scoreVersion === 2 ? b.score - a.score || b.expeditions - a.expeditions || b.deepest - a.deepest : b.expeditions - a.expeditions || b.deepest - a.deepest || b.score - a.score)
      || a.turns - b.turns || b.endedAt - a.endedAt).slice(0, 200);
  }
}

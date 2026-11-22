// SpectatorPort: 観戦者向け。スナップショット（secret の seed/rng 除去）＋イベント購読。書き込み不可。
// spectatorPolicy: omniscient = 全情報 / follow_only = 特定プレイヤーの PlayerView のみ / delayed = 一定 seq 遅らせた俯瞰
import type { AgentActivity, GameEvent, PerceivedEvent, PlayerId, PlayerView, SpectatorPolicy, World } from '@muse/shared';
import { applyEvent, emptyWorld, filterEventsForPlayer, projectPlayerView, stripSecret } from '@muse/shared';
import { spectatorEvent } from '../log/RunStore';
import type { RunSession } from './RunSession';

export class SpectatorPort {
  /**
   * owner（S3。SEASON.md §25.1）: 開催中のシーズンのランを、その参加者のトークンで見ている。その参加者の PlayerView だけを送り、
   * ランが終わった後も俯瞰（World）は送らない（まだ見ていない地図と階段が分かるため）
   */
  constructor(private readonly session: RunSession, readonly policy: SpectatorPolicy, private readonly delaySeq: number, readonly owner: PlayerId | null = null) {}

  get runId(): string { return this.session.runId; }
  get contentVersion(): string { return this.session.world.meta.contentVersion; }

  /** 俯瞰が許可されるか */
  directorAllowed(): boolean {
    if (this.owner) return false;
    return this.policy !== 'follow_only' || this.session.world.status === 'ended';
  }

  /** PlayerView だけを送るか（追従のみの方針で進行中か、持ち主の観戦） */
  viewOnly(): boolean {
    return !!this.owner || (this.policy === 'follow_only' && this.summary() === null);
  }

  private visibleUpTo(): number {
    const w = this.session.world;
    if (this.policy === 'delayed' && w.status === 'active') return Math.max(0, w.seq - this.delaySeq);
    return w.seq;
  }

  snapshot(): { seq: number; world: World } {
    const upTo = this.visibleUpTo();
    if (upTo === this.session.world.seq) return { seq: upTo, world: stripSecret(this.session.world) };
    const w = emptyWorld();
    for (const ev of this.session.history) {
      if (ev.seq > upTo) break;
      applyEvent(w, ev);
    }
    return { seq: upTo, world: stripSecret(w) };
  }

  /** 観戦用に変換したイベントを逐次受け取る（delayed では遅れて届く） */
  subscribe(cb: (events: GameEvent[]) => void, fromSeq: number): () => void {
    let sent = fromSeq;
    const flush = () => {
      const upTo = this.visibleUpTo();
      if (upTo <= sent) return;
      // シーズンのラン（S0）は終わってもシードを出さない
      const ended = this.session.world.status === 'ended' && !this.session.world.meta.season;
      const out: GameEvent[] = [];
      for (const ev of this.session.history) {
        if (ev.seq <= sent) continue;
        if (ev.seq > upTo) break;
        const se = spectatorEvent(ev, ended);
        if (se) out.push(se);
      }
      sent = upTo;
      if (out.length) cb(out);
    };
    return this.session.addListener({ onEvents: flush });
  }

  /** そのランのプレイヤーか（利用者の文字列で World の players を引かない: `toString`・`__proto__` などが真になる） */
  hasPlayer(pid: unknown): pid is PlayerId {
    return typeof pid === 'string' && this.session.world.playerOrder.includes(pid) && Object.hasOwn(this.session.world.players, pid);
  }

  followView(pid: PlayerId): PlayerView | null {
    if (!this.hasPlayer(pid)) return null;
    return projectPlayerView(this.session.world, pid);
  }

  /**
   * 追従の相手に届いた出来事のうち、seq より後のもの。その人の PlayerPort.perceivedSince（遊ぶ画面の WS の view の枠）と同じ中身
   * （RunSession が filterEventsForPlayer で作ったその人のメッセージ。ほかの者にしか届かない出来事は入らない）
   */
  followPerceivedSince(pid: PlayerId, seq: number): PerceivedEvent[] {
    if (!this.hasPlayer(pid)) return [];
    return this.session.messages(pid).filter((m) => m.seq > seq);
  }

  /** この出来事の中に、追従の相手が知覚したもの（filterEventsForPlayer に残るもの）があるか。view はその相手の今の PlayerView */
  followPerceives(pid: PlayerId, events: readonly GameEvent[], view: PlayerView): boolean {
    if (!this.hasPlayer(pid)) return false;
    return filterEventsForPlayer(events, pid, view).length > 0;
  }

  players(): PlayerId[] {
    return [...this.session.world.playerOrder];
  }

  recentActivity(): AgentActivity[] {
    return [...this.session.agentActivity];
  }

  onAgent(cb: (a: AgentActivity) => void): () => void {
    return this.session.addListener({ onAgent: cb });
  }

  onMacro(cb: (m: { playerId: PlayerId; kind: string; state: 'running' | 'stopped'; steps: number; reason?: string }) => void): () => void {
    return this.session.addListener({ onMacro: cb });
  }

  onChange(cb: () => void): () => void {
    return this.session.addListener({ onEvents: () => cb() });
  }

  /** 命令が 1 回確定するたび（世界が 1 回進むたび）に、その確定で出た出来事を受け取る。World はもう進んだ後 */
  onCommit(cb: (events: readonly GameEvent[]) => void): () => void {
    return this.session.addListener({ onEvents: (events) => cb(events) });
  }

  summary() { return this.session.summary(); }
}

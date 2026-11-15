// SpectatorPort: 観戦者向け。スナップショット（secret の seed/rng 除去）＋イベント購読。書き込み不可。
// spectatorPolicy: omniscient = 全情報 / follow_only = 特定プレイヤーの PlayerView のみ / delayed = 一定 seq 遅らせた俯瞰
import type { AgentActivity, GameEvent, PlayerId, PlayerView, SpectatorPolicy, World } from '@muse/shared';
import { applyEvent, emptyWorld, projectPlayerView, stripSecret } from '@muse/shared';
import { spectatorEvent } from '../log/RunStore';
import type { RunSession } from './RunSession';

export class SpectatorPort {
  constructor(private readonly session: RunSession, readonly policy: SpectatorPolicy, private readonly delaySeq: number) {}

  get runId(): string { return this.session.runId; }
  get contentVersion(): string { return this.session.world.meta.contentVersion; }

  /** 俯瞰が許可されるか */
  directorAllowed(): boolean {
    return this.policy !== 'follow_only' || this.session.world.status === 'ended';
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
      const ended = this.session.world.status === 'ended';
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

  followView(pid: PlayerId): PlayerView | null {
    if (!this.session.world.players[pid]) return null;
    return projectPlayerView(this.session.world, pid);
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

  summary() { return this.session.summary(); }
}

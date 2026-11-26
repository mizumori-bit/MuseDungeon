// 追従の観戦の 1 コマ（S17。SEASON.md §70.6 の 4）: その場の観戦（ws/hub.ts の追従だけの枠）と、見返し（session/review.ts）が、同じ決まりで使う。
// 2 つの実装を、別々に持たない。ここにあるのは、どれも純粋な関数（World を書き換えない。読むだけ）。
// - 1 コマの区切り: 命令の確定 1 回（世界が 1 回進む）で、追従の相手が知覚した出来事があれば、その確定の後の見え方で 1 コマ（followFrameDue）。
// - コマの出来事: 前のコマより後に、その相手に届いた出来事のうち、文になったもの（perceiveCommit の messages。遊ぶ画面の WS の枠と同じ中身）。
// - コマの見え方: projectPlayerView を通した、その相手の見え方（followViewOf。確定したシーズンのランは「閉じた」見え方）。
// - 見せている所: 遅らせる観戦（delayed）は、進行中のランを delaySeq 遅らせる（liveVisibleUpTo）。シーズンのランは、追従だけ（livePolicyFor）。
import type { Catalog, GameEvent, PerceivedEvent, PlayerId, PlayerView, ProjectedEvent, SpectatorPolicy, World } from '@muse/shared';
import { filterEventsForPlayer, narrate, projectPlayerView } from '@muse/shared';

/** そのランの観戦の方針: シーズンのランは追従だけ（S0 §9.7: 俯瞰から公開されていない階段が分からないように）。ほかはサーバーの設定 */
export function livePolicyFor(world: World, configured: SpectatorPolicy): SpectatorPolicy {
  return world.meta.season ? 'follow_only' : configured;
}

/** その場の観戦が、いま見せている所（出来事の番号）。遅らせる観戦は、進行中のランを delaySeq 遅らせる。ほかは今 */
export function liveVisibleUpTo(world: World, policy: SpectatorPolicy, delaySeq: number): number {
  if (policy === 'delayed' && world.status === 'active') return Math.max(0, world.seq - delaySeq);
  return world.seq;
}

/** 追従の相手の見え方（確定したシーズンのラン（S9b）は、World の写しは確定の前のままなので、見え方だけ「閉じた」にする。engine と World は変えない） */
export function followViewOf(world: World, pid: PlayerId, seasonFinal: boolean): PlayerView {
  return withSeasonClosed(projectPlayerView(world, pid), seasonFinal);
}

/** 見え方を「閉じた」シーズンのものにする（確定したシーズンのランだけ。渡した見え方を変えて返す） */
export function withSeasonClosed(v: PlayerView, seasonFinal: boolean): PlayerView {
  if (v.season && seasonFinal) v.season = { ...v.season, ended: true, final: true };
  return v;
}

/** 出来事の文の手がかり（見ているプレイヤーの見え方から） */
export function narrateContext(view: PlayerView, catalog: Catalog) {
  const playerNames: Record<string, string> = {};
  for (const m of view.party) { playerNames[m.entityId] = m.name; playerNames[m.playerId] = m.name; }
  return { locale: view.locale, catalog, selfId: view.self.id, selfPlayerId: view.playerId, playerNames, selfPos: view.self.pos };
}

/**
 * 確定 1 回の出来事を、そのプレイヤーの目で読む。world は、その確定の後の World（読むだけ）。
 * perceived: そのプレイヤーに届いた出来事（filterEventsForPlayer）。messages: そのうち文になったもの（RunSession のメッセージの記録・
 * 遊ぶ画面の WS の枠の出来事・追従だけの観戦の枠の出来事と同じ中身）。view: その確定の後の、そのプレイヤーの見え方（projectPlayerView）
 */
export function perceiveCommit(world: World, pid: PlayerId, events: readonly GameEvent[], catalog: Catalog): { view: PlayerView; perceived: ProjectedEvent[]; messages: PerceivedEvent[] } {
  const view = projectPlayerView(world, pid);
  if (!events.length) return { view, perceived: [], messages: [] };
  const perceived = filterEventsForPlayer(events, pid, view);
  const ctx = narrateContext(view, catalog);
  const messages: PerceivedEvent[] = [];
  for (const e of perceived) {
    const text = narrate(e, ctx);
    if (text) messages.push({ seq: e.seq, type: e.type, text, event: e });
  }
  return { view, perceived, messages };
}

/** 確定の種類（1 コマの区切りに要るもの）。macroStep: マクロ（explore・rest など）の途中の手（元の呼び出しの続き）。ほかは、1 回の呼び出しの確定・サーバーの命令 */
export interface CommitInfo { macroStep: boolean }

/**
 * その確定で、追従の相手に、今 1 コマを送るか（その場の観戦と見返しの、1 コマの区切りの決まり。S17 で 1 つにした）:
 * 相手が知覚した出来事（filterEventsForPlayer に残るもの）があるとき、か、マクロの途中の手でないとき（1 回の呼び出し・サーバーの命令）。
 * マクロの途中の手で、相手が知覚しないもの（休む・待つの手、ほかの階の者の手）は、送らずにためて、次のコマか、そのマクロの終わりに 1 コマ（followFlushAtMacroEnd）。
 * （S17 より前のその場の観戦は、知覚しない確定を 40ms でまとめていた。時刻によらない決まりにした。送りが詰まっている間だけは、今までどおり 40ms でまとめる）
 */
export function followFrameDue(perceived: readonly ProjectedEvent[], info: CommitInfo): boolean {
  return perceived.length > 0 || !info.macroStep;
}

/** マクロが終わったときに、ためた確定（送っていない確定）があれば、1 コマを送る */
export function followFlushAtMacroEnd(unsent: boolean): boolean {
  return unsent;
}

/** 出来事を、命令の確定ごとに分ける（同じ命令 cause の、続いた出来事が 1 回の確定。ランを作ったときの出来事は cause が無い） */
export function splitCommits(events: readonly GameEvent[]): GameEvent[][] {
  const out: GameEvent[][] = [];
  for (const ev of events) {
    const last = out[out.length - 1];
    if (last && last[0].cause === ev.cause) last.push(ev);
    else out.push([ev]);
  }
  return out;
}

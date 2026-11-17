// PlayerPort: プレイヤー（AI・人間とも）への唯一の窓口。PlayerView 経由の情報しか返さない。
// MCP アダプタと人間用 WS の両方がこれを使う（どちらかを特別扱いしない）。
import type {
  ActionError, Catalog, Command, ExpeditionReport, GameEvent, Locale, Observation, ObservationOptions, PerceivedEvent, PlayerId, PlayerView, Pos, RunSummary, TurnBlock, TurnReason,
} from '@muse/shared';
import {
  actionError, briefingLines, briefingShort, buildObservation, buildTurnBlock, campLines, changesLine, compareLines, describeInventory, describeTarget, diffChanges, progressLines, reportLines,
  formatObservationText, guardianDisplayName, kindName, MACRO_COMPLETED_STOPS, mapTextLines, memoryCombatText, memoryKey, mineCount, nameOf, pickableItems, progressText, renderAsciiMap, resultText, t,
  turnLine, turnSnapshot, turnStateOf,
} from '@muse/shared';
import type { PlayerOptions } from './RunSession';
import type { MacroStop } from '@muse/shared';
import type { RunSession, SubmitOpts } from './RunSession';

const NL = String.fromCharCode(10);

export interface BriefEvent { seq: number; type: string; text: string }

export interface RestReport { hp_gained: number; turns: number; time_elapsed: number | null; stopped_by: string }

export interface ActionSuccess {
  ok: true;
  outcome: string;
  steps?: number;
  interrupted_by?: string;
  /** マクロ: 歩いた手数・経過したフロア時間 */
  distance?: number;
  time_elapsed?: number | null;
  /** rest の実績 */
  rest?: RestReport;
  events: BriefEvent[];
  observation: Observation;
  turn: TurnBlock;
  /** start_expedition の応答: 遠征のブリーフィング */
  briefing?: string[];
  /** 遠征が終わった応答: 遠征レポート（V3-6 §6。文は 12 行以内、JSON は全項目） */
  report?: ExpeditionReport;
  /** collect の実績 */
  collected?: { picked: number; remaining: number };
}
export interface ActionFailure { ok: false; error: ActionError; valid_actions: string[]; turn: TurnBlock }
export type ActionPayload = ActionSuccess | ActionFailure;

export interface InfoResult { text: string; data: unknown }

export interface ObserveResult { observation: Observation; text: string; turn: TurnBlock }

export interface PlayerPort {
  readonly runId: string;
  readonly playerId: PlayerId;
  readonly catalog: Catalog;
  locale(): Locale;
  view(): PlayerView;
  observe(opts?: { detail?: 'brief' | 'full'; map?: boolean; consume?: boolean }): { observation: Observation; text: string };
  /**
   * 観測＋turn ブロック。text には変化の行と末尾の状態行が付く。
   * changes: true なら前回の応答からの変化を計算して基準を更新する（照会系は false）
   */
  observeWithTurn(reason: TurnReason, opts?: { detail?: 'brief' | 'full'; map?: boolean; consume?: boolean; changes?: boolean | 'peek' }): ObserveResult;
  /** turn ブロックだけ（変化は計算しない） */
  turnBlock(reason: TurnReason): TurnBlock;
  /** 応答テキストの表示オプション（ゲームには影響しない） */
  options(): PlayerOptions;
  setOptions(o: Partial<PlayerOptions>): PlayerOptions;
  turnLine(b: TurnBlock): string;
  act(cmd: Command, opts: SubmitOpts & { waitTurnMs?: number; map?: boolean }): Promise<ActionPayload>;
  waitForTurn(timeoutMs: number): Promise<boolean>;
  /** 遠征のブリーフィング（開始時・再開時） */
  /** camp: false でキャンプの候補を省く（観測の文と一緒に返すとき。既定は出す） */
  briefing(kind: 'start' | 'resume', opts?: { camp?: boolean }): string[];
  look(target: Pos | string): InfoResult;
  map(region?: { x: number; y: number; w: number; h: number }): InfoResult;
  inventory(): InfoResult;
  recall(kindNameOrId: string): InfoResult;
  messages(sinceSeq?: number, limit?: number): InfoResult;
  /** 遠征レポート（V3-6 §6）。no を省くと最後の遠征（進行中なら途中経過） */
  report(no?: number): ExpeditionReport | null;
  /** review: 終了した遠征のレポートと場面 */
  review(no?: number): InfoResult;
  /** expedition ツールに足す行（進行中なら途中経過、キャンプなら直前の遠征のレポート） */
  expeditionReportLines(): { lines: string[]; progress?: Pick<ExpeditionReport, 'combat' | 'tempo'>; report?: ExpeditionReport };
  /** 前回の行動結果以降に知覚した出来事（消費しない） */
  pending(): PerceivedEvent[];
  /** seq より後に知覚した出来事（WS のフレーム用） */
  perceivedSince(seq: number): PerceivedEvent[];
  /** このプレイヤーのマクロ進行の通知 */
  onMacro(cb: (m: { kind: string; state: 'running' | 'stopped'; steps: number; reason?: string }) => void): () => void;
  /** 状態変化の通知を受ける（WS のプッシュ用） */
  onChange(cb: () => void): () => void;
  summary(): RunSummary | null;
  formatActionText(p: ActionPayload): string;
}

const STOP_TEXT: Record<string, [string, string]> = {
  hostile_in_view: ['敵が視界に入った', 'a hostile came into view'],
  hostile_adjacent: ['隣に起きている敵がいる（退くなら mode: flee、戦うなら fight）', "an awake enemy is adjacent (retreat with mode: 'flee', or fight)"],
  hp_floor: ['HP が hp_floor 以下になった', 'HP fell to hp_floor or below'],
  hp_risk: ['次の手番に最悪の被害を受けると hp_floor を割る（被弾の前に止まった）', 'one more turn of the worst damage would drop you below hp_floor (stopped before being hit)'],
  first_hit: ['被弾の記録の無い相手から初めて被弾した（数字を見てから続けるかを決める）', 'first hit from a creature with no record (check the numbers before continuing)'],
  hostile_alerted: ['見えている敵が追跡に変わった', 'a visible enemy started hunting you'],
  hp_threshold: ['HP が 50%・25% の線をまたいだ', 'HP crossed the 50% / 25% line'],
  target_down: ['相手が倒れた', 'the target fell'],
  target_gone: ['相手が見えなくなった（物陰に入ったまま、待っても現れない）', 'the target is out of sight (it took cover and did not come out)'],
  target_fled: ['相手が逃げて見えなくなった', 'the target fled out of sight'],
  shot_while_waiting: ['待っている間に、標的ではない敵に撃たれた（射撃する敵へ近づく／視線を切る）', 'another enemy shot you while you waited (close in on the shooter or break line of sight)'],
  cleared: ['届く追跡中の敵がいなくなった', 'no hunting enemy left in reach'],
  intent: ['見えている敵が予備動作を見せた（次の手番に大きな行動が来る。alerts の intent を見る）', 'a visible enemy shows an intent (a big move comes next turn; see the intent alert)'],
  target_moved: ['相手が離れた（逃げた・射程を出た）', 'the target moved away (fled or left range)'],
  target_adjacent: ['相手が隣に来た（近接で続けるなら fight { target }）', 'the target is adjacent (continue in melee with fight { target })'],
  out_of_ammo: ['投げる物が尽きた', 'nothing left to throw'],
  not_throwable: ['そのスロットの品は投げられない', 'that slot holds nothing throwable'],
  no_line_of_sight: ['射線が 3 手番続けて通らなかった', 'no clear line for 3 turns'],
  target_not_approaching: ['相手が近づいてこない（3 手番続けて近づかない・待つ上限）', 'the target is not coming (3 turns without closing in, or the wait limit)'],
  no_progress: ['同じ 2 マスを往復して進めない（行き先か道を変える）', 'stuck going back and forth between two cells (pick another destination or route)'],
  hit_and_run: ['待つ間に標的に殴られたが、標的は隣にいない（当てては離れる相手。寄って殴る・通路で受ける・投げる）', 'the target hit you while you waited but is not adjacent (it strikes and backs off: close in, hold a corridor, or throw)'],
  target_not_hunting: ['相手はあなたを追っていない', 'the target is not hunting you'],
  damaged: ['ダメージを受けた', 'you took damage'],
  item_seen: ['新しいアイテムを見つけた', 'you spotted a new item'],
  stairs_seen: ['階段を見つけた', 'you found stairs'],
  arrived: ['到着した', 'arrived'],
  explored: ['この階で辿り着ける場所は探索し尽くした', 'nothing reachable left to explore'],
  unreachable: ['既知の経路では到達できない', 'unreachable via known map'],
  unknown_destination: ['行き先が既知の地図に無い', 'destination is not on your known map'],
  step_limit: ['1 回の手数の上限に達した', 'reached the step limit'],
  full_hp: ['HP が全快した', 'HP is full'],
  rest_cap: ['休憩で戻る上限に達した（それより上は薬・立て直し・泉・キャンプで）', 'reached the rest cap (heal further with potions, second wind, fountains or camp)'],
  target_hp: ['指定した HP に達した', 'reached the requested HP'],
  max_turns: ['指定した手数に達した', 'reached the requested turns'],
  status_changed: ['状態異常が変化した', 'a status effect changed'],
  not_your_turn: ['手番ではない', 'not your turn'],
  waiting_others: ['他プレイヤーの手番待ち', 'waiting for other players'],
  dead: ['死亡した', 'you died'],
  run_ended: ['ランが終了した', 'the run ended'],
  floor_changed: ['階が変わった', 'floor changed'],
  blocked: ['道が塞がれている', 'the path is blocked'],
  trap_ahead: ['次のマスが発見済みの罠（ほかに道が無い。踏むなら move）', 'the next step is a discovered trap (no other way; use move to step on it)'],
  left_board: ['盤面を離れた', 'you left the board'],
  error: ['行動できなかった', 'an action failed'],
  attacked: ['攻撃を受けた', 'you were attacked'],
  collected: ['回収し終えた', 'nothing left to collect'],
};

const LONG_REASONS: ReadonlySet<TurnReason> = new Set<TurnReason>(['run_started', 'resumed', 'expedition_started']);

/**
 * 自分が受けた攻撃と被害の合計。行動から次の自分の手番までのイベント（自分が対象のものだけ）から数える。
 * 知覚ログ（文章のある出来事）は通常の命中の attack を持たないので使わない。
 */
function harmSummary(events: readonly GameEvent[], selfId: string): { hits: number; misses: number; total: number; other: number; healed: number; levelHp: number } {
  let hits = 0, misses = 0, total = 0, other = 0, healed = 0, levelHp = 0;
  for (const ev of events) {
    if (ev.type === 'attack' && ev.target === selfId) { if (ev.hit) hits++; else misses++; }
    if (ev.type === 'damaged' && ev.target === selfId) {
      const d = ev.dealt ?? ev.amount;
      total += d;
      if (ev.via !== 'melee' && ev.via !== 'ranged' && ev.via !== 'thrown') other += d;
    }
    if (ev.type === 'healed' && ev.target === selfId) healed += ev.amount;
    // レベルアップで増えた最大 HP（同じだけ HP も増える。回復とは別に書く）
    if (ev.type === 'level_up' && ev.target === selfId) levelHp += ev.gains?.maxHp ?? 0;
  }
  return { hits, misses, total, other, healed, levelHp };
}

/** HP の前後（回復・レベルアップが混ざったら添える） */
function hpDelta(L: Locale, before: number, after: number, total: number, levelHp = 0): string {
  const regen = after - (before - total) - levelHp;
  const extra = (regen > 0 ? t(L, `、回復 +${regen}`, `, healed +${regen}`) : '') + (levelHp > 0 ? t(L, `、レベルアップ +${levelHp}`, `, level up +${levelHp}`) : '');
  return t(L, `HP ${before}→${after}${extra}`, `HP ${before}→${after}${extra}`);
}

const MILESTONE_TYPES = new Set(['entity_changed_floor', 'level_up', 'objective_completed', 'expedition_started', 'expedition_ended', 'item_identified', 'player_state', 'player_joined']);

export class SessionPlayerPort implements PlayerPort {
  constructor(private readonly session: RunSession, readonly playerId: PlayerId) {}

  get runId(): string { return this.session.runId; }
  get catalog(): Catalog { return this.session.deps.catalog; }
  locale(): Locale { return this.view().locale; }
  view(): PlayerView { return this.session.view(this.playerId); }
  summary(): RunSummary | null { return this.session.summary(); }
  pending(): PerceivedEvent[] { return this.session.pendingFor(this.playerId); }
  perceivedSince(seq: number): PerceivedEvent[] { return this.session.messages(this.playerId).filter((m) => m.seq > seq); }
  onMacro(cb: (m: { kind: string; state: 'running' | 'stopped'; steps: number; reason?: string }) => void): () => void {
    return this.session.addListener({ onMacro: (m) => { if (m.playerId === this.playerId) cb(m); } });
  }

  observe(opts: { detail?: 'brief' | 'full'; map?: boolean; consume?: boolean } = {}): { observation: Observation; text: string } {
    const view = this.view();
    const recent = opts.consume ? this.session.consumeFor(this.playerId) : this.pending();
    const observation = buildObservation(view, this.catalog, { detail: opts.detail ?? 'brief', map: opts.map ?? true, recent: recent.slice(-10), campCompare: this.campCompare(view) });
    return { observation, text: formatObservationText(observation, view.locale) };
  }

  /** キャンプの観測に出す、直前の遠征の比較（2 行以内。V3-6 §35.9） */
  private campCompare(view: PlayerView): ObservationOptions['campCompare'] {
    if (view.status !== 'at_camp') return undefined;
    const r = this.session.expeditionReport(this.playerId, undefined, { endedOnly: true });
    if (!r) return undefined;
    return { no: r.no, lines: compareLines(view.locale, r), ...(r.compare ? { compare: r.compare } : {}) };
  }

  /** expedition ツールに足す行: 進行中なら途中経過（戦闘と進み）、キャンプなら直前の遠征のレポート（V3-6 §6.1・§6.2） */
  expeditionReportLines(): { lines: string[]; progress?: Pick<ExpeditionReport, 'combat' | 'tempo'>; report?: ExpeditionReport } {
    const view = this.view();
    const L = view.locale;
    const r = this.session.expeditionReport(this.playerId);
    if (!r) return { lines: [] };
    if (r.status === 'in_progress') return { lines: progressLines(L, r), progress: { combat: r.combat, tempo: r.tempo } };
    // キャンプのブリーフィングに結果の行が出ているので、確定の行は省く
    return { lines: reportLines(L, r, { payout: false }), report: r };
  }

  /** 遠征レポート（no を省くと最後の遠征。進行中なら途中経過） */
  report(no?: number): ExpeditionReport | null {
    return this.session.expeditionReport(this.playerId, no);
  }

  /** review: 終了した遠征のレポートと場面（V3-6 §6.2） */
  review(no?: number): InfoResult {
    const L = this.view().locale;
    const r = this.session.expeditionReport(this.playerId, no, { endedOnly: true });
    if (!r) return { text: no === undefined ? t(L, 'まだ終わった遠征が無い。', 'No expedition has ended yet.') : t(L, `遠征 ${no} は終わっていないか、参加していない。`, `Expedition ${no} has not ended or you did not take part.`), data: null };
    const lines = reportLines(L, r);
    // 12 行に入らなかった場面と、倒れる直前の出来事は全部出す
    const shown = new Set(lines);
    const rest = r.moments.map((m) => `- ${m.text}`).filter((x) => !shown.has(x));
    if (rest.length) lines.push(t(L, 'ほかの場面:', 'More moments:'), ...rest);
    if (r.death?.last_events.length) lines.push(t(L, '倒れる直前の出来事:', 'Right before you fell:'), ...r.death.last_events.map((x) => `- ${x}`));
    return { text: lines.join(NL), data: r };
  }

  options(): PlayerOptions { return this.session.playerOptions(this.playerId); }
  setOptions(o: Partial<PlayerOptions>): PlayerOptions { return this.session.setPlayerOptions(this.playerId, o); }

  /**
   * 観測 → turn ブロック → 表示オプションに沿ったテキスト。
   * changes: true なら前回の応答からの変化を計算して基準を更新、'peek' なら比べるだけ、false なら変化を出さない。
   */
  private render(view: PlayerView, reason: TurnReason, p: {
    detail?: 'brief' | 'full'; recent: PerceivedEvent[]; changes: boolean | 'peek'; interruptedBy?: string; expeditionEndedNow?: boolean;
  }): ObserveResult {
    const L = view.locale;
    const opts = this.options();
    const prev = this.session.turnSnapshot(this.playerId);
    // 帰還の綱の長い説明は遠征ごとに最初の 1 回だけ（V3-3a §35.8）
    const xNo = view.expedition && view.expedition.status !== 'ended' ? view.expedition.no : undefined;
    const lifelineShort = xNo !== undefined && prev?.lifeNo === xNo;
    const observation = buildObservation(view, this.catalog, { detail: p.detail ?? 'brief', map: true, recent: p.recent.slice(-10), lifelineShort, campCompare: this.campCompare(view) });
    const state = turnStateOf(view, p.expeditionEndedNow ?? false).state;
    const cur = turnSnapshot(view, observation, state);
    const longLife = observation.valid_actions.some((a) => a.includes('次の遠征はこの遠征を始めた階段から') || a.includes('the next expedition starts from where this one began'));
    cur.lifeNo = lifelineShort ? prev?.lifeNo : longLife ? xNo : prev?.lifeNo;
    let changes: TurnBlock['changes'] = [];
    if (p.changes) {
      const events = prev ? this.session.messages(this.playerId).filter((m) => m.seq > prev.seq) : [];
      changes = diffChanges(prev, cur, view, observation, events);
      if (p.changes === true) this.session.setTurnSnapshot(this.playerId, cur);
    }
    const turn = buildTurnBlock(view, { reason, interruptedBy: p.interruptedBy, changes, expeditionEndedNow: p.expeditionEndedNow });
    // 地図: auto は、階が変わった・新しいセルを知った・敵の出入りがあった応答だけ
    let mapMode: 'show' | 'unchanged' | 'none' = 'show';
    if (opts.map === 'never') mapMode = 'none';
    else if (opts.map === 'auto' && prev) {
      const sameHostiles = Object.keys(prev.hostiles).sort().join(',') === Object.keys(cur.hostiles).sort().join(',');
      if (prev.floorKey === cur.floorKey && prev.knownCells === cur.knownCells && sameHostiles) mapMode = 'unchanged';
    }
    if (mapMode !== 'show') delete observation.map;
    const invShow = opts.inventory === 'always' || !prev || prev.inv !== cur.inv;
    const long = opts.status_line === 'long' || !prev || prev.state !== cur.state || LONG_REASONS.has(reason);
    // 【遠征】の見出しが前の応答と同じなら、戦利品と extract の可否だけ（V3-4b §28.8）
    const expShort = !long && !!prev?.expHead && prev.expHead === cur.expHead;
    const body = view.status === 'at_camp' || !observation.self.pos ? formatObservationText(observation, L)
      : formatObservationText(observation, L, { inventory: invShow, map: mapMode === 'unchanged' ? 'unchanged' : 'show', expedition: expShort ? 'short' : 'full' });
    const text = [body, changesLine(L, turn.changes), turnLine(view, turn, !long)].filter(Boolean).join('\n');
    return { observation, text, turn };
  }

  observeWithTurn(reason: TurnReason, opts: { detail?: 'brief' | 'full'; map?: boolean; consume?: boolean; changes?: boolean | 'peek' } = {}): ObserveResult {
    const recent = opts.consume ? this.session.consumeFor(this.playerId) : this.pending();
    return this.render(this.view(), reason, { detail: opts.detail, recent, changes: opts.changes ?? true });
  }

  turnBlock(reason: TurnReason): TurnBlock {
    return buildTurnBlock(this.view(), { reason, changes: [] });
  }

  turnLine(b: TurnBlock): string {
    return turnLine(this.view(), b);
  }

  waitForTurn(timeoutMs: number): Promise<boolean> {
    return this.session.waitForTurn(this.playerId, timeoutMs);
  }

  onChange(cb: () => void): () => void {
    return this.session.addListener({ onEvents: () => cb() });
  }

  async act(cmd0: Command, opts: SubmitOpts & { waitTurnMs?: number; map?: boolean }): Promise<ActionPayload> {
    const before = this.view();
    let cmd = cmd0;
    // fight の標的が今は見えない（V3-4b §28.4）: 直前の応答で逃げていたなら「逃げて見えなくなった」で断り、
    // 逃げていなかったなら（物陰に入った）出てくるまで待つ
    if (cmd.type === 'fight' && !before.entities.some((e) => e.id === (cmd as { target: string }).target)) {
      const prev = this.session.turnSnapshot(this.playerId);
      const id = cmd.target;
      if (prev?.hostiles[id] !== undefined) {
        if (prev.hostileFleeing?.includes(id)) {
          const at = prev.hostilePos?.[id];
          const L0 = before.locale;
          const error = actionError('no_target', t(L0, `${prev.hostiles[id]}は逃げて見えなくなった${at ? `（最後に見た位置 (${at.x},${at.y})）` : ''}。`, `${prev.hostiles[id]} fled out of sight${at ? ` (last seen at (${at.x},${at.y}))` : ''}.`),
            t(L0, '追うなら travel_to で最後に見た位置へ。ほかの相手なら visible.monsters の id を指定する。', 'To chase it, travel_to where you last saw it; otherwise give an id from visible.monsters.'));
          const res = this.render(before, 'action_rejected', { recent: [], changes: true });
          return { ok: false, error, valid_actions: res.observation.valid_actions, turn: res.turn };
        }
        cmd = { ...cmd, lostOk: true };
      }
    }
    const r = await this.session.submit(this.playerId, cmd, opts);
    // 次に自分の手番が来るかランが終わるまで待つ（COOP で長引けば waiting_others のまま返す）
    if (r.ok && opts.waitTurnMs && this.view().status === 'waiting_others') await this.session.waitForTurn(this.playerId, opts.waitTurnMs);
    const view = this.view();
    if (!r.ok) {
      const res = this.render(view, 'action_rejected', { recent: [], changes: true });
      const payload: ActionFailure = { ok: false, error: r.error, valid_actions: res.observation.valid_actions, turn: res.turn };
      return payload;
    }
    const perceived = this.session.consumeFor(this.playerId);
    const mine = perceived.filter((p) => p.seq > r.startSeq);
    const L = view.locale;
    let outcome: string;
    let rest: RestReport | undefined;
    let collected: { picked: number; remaining: number } | undefined;
    if (r.steps !== undefined) {
      const stop = r.interruptedBy ? STOP_TEXT[r.interruptedBy] : undefined;
      const m = r.macro;
      if (cmd.type === 'rest') {
        rest = { hp_gained: m?.hpGained ?? 0, turns: r.steps, time_elapsed: m?.timeElapsed ?? null, stopped_by: r.interruptedBy ?? 'step_limit' };
        outcome = t(L,
          `rest: ${r.steps} 手休んだ。HP ${rest.hp_gained >= 0 ? '+' : ''}${rest.hp_gained}${rest.time_elapsed !== null ? `、時間 ${rest.time_elapsed}` : ''}。${stop ? `停止: ${stop[0]}。` : ''}`,
          `rest: ${r.steps} turns. HP ${rest.hp_gained >= 0 ? '+' : ''}${rest.hp_gained}${rest.time_elapsed !== null ? `, time ${rest.time_elapsed}` : ''}.${stop ? ` Stopped: ${stop[1]}.` : ''}`);
      } else {
        const tm = m?.timeElapsed !== null && m?.timeElapsed !== undefined ? t(L, `（${m.distance} 歩、時間 ${m.timeElapsed}）`, ` (${m.distance} moves, time ${m.timeElapsed})`) : '';
        outcome = t(L, `${cmd.type}: ${r.steps} 手進んだ${tm}。${stop ? `停止: ${stop[0]}。` : ''}`, `${cmd.type}: ${r.steps} steps${tm}.${stop ? ` Stopped: ${stop[1]}.` : ''}`);
        // hp_risk: 何にすれば、あと 1 回の最悪の被害まで続けられるか（V3-3a §35.6）
        if (r.interruptedBy === 'hp_risk' && cmd.type === 'fight') {
          const after = this.view();
          const obsNow = buildObservation(after, this.catalog, { detail: 'brief', map: false });
          const inc = obsNow.visible.monsters.filter((x) => x.awareness === 'hunting' && !x.fleeing && (x.dist <= 1 || x.traits.includes('ranged'))).reduce((a, x) => a + (x.worst_turn ?? 0), 0);
          const nf = Math.max(0, after.self.stats.hp - inc);
          if (inc > 0) outcome += t(L, ` hp_floor を ${nf} にすれば、あと 1 回の最悪の被害（${inc}）まで続けられる。`, ` With hp_floor ${nf} you can take one more worst turn (${inc}).`);
        }
        // 初被弾（記録の無い種族から。止まらずに続けた小さい被弾も）: 名前と値（V3-3a §35.6）
        if (cmd.type === 'fight') {
          const firsts = new Map<string, number>();
          for (const e of r.events) {
            if (e.type !== 'damaged' || e.target !== view.self.id || !e.sourceKind) continue;
            const src = view.entities.find((x) => x.id === e.source);
            const key = memoryKey(e.sourceKind, src?.role);
            if ((view.monsterMemory[key]?.maxDamageToYou ?? 0) > 0 || firsts.has(key)) continue;
            firsts.set(key, e.amount);
          }
          if (firsts.size) outcome += ' ' + t(L, `初被弾: ${[...firsts].map(([k, a]) => `${nameOf(this.catalog.monsters[k.replace('guardian|', '')]?.name, L, k)} ${a}`).join('・')}。`, `First hits: ${[...firsts].map(([k, a]) => `${nameOf(this.catalog.monsters[k.replace('guardian|', '')]?.name, L, k)} ${a}`).join(', ')}.`);
        }
        if (cmd.type === 'collect') {
          // 実際に拾った数（イベントから）と、まだ拾える数
          const picked = r.events.filter((e) => e.type === 'item_picked_up' && e.actor === view.self.id).length;
          const remaining = (cmd.what ?? 'thrown') === 'items' ? pickableItems(view, this.catalog).length : mineCount(view);
          collected = { picked, remaining };
          outcome += t(L, ` 回収 ${collected.picked} 個、残り ${remaining} 個。`, ` Recovered ${collected.picked}, ${remaining} left.`);
          // 遺物は拾わない（拾うと階の敵が目を覚ます判断なので、マクロに任せない）。知っている遺物が床にあれば、拾い方を添える
          const relic = view.entities.find((e) => e.cat === 'item' && e.role === 'relic') ?? view.memory.remembered.find((r) => r.cat === 'item' && r.kind === 'core:relic');
          if ((cmd.what ?? 'thrown') === 'items' && relic) outcome += t(L, ` 遺物は数えていない（拾うと階の敵が目を覚ます）。拾うなら travel_to ${relic.id}。`, ` The relic is not counted (picking it up wakes the floor); to take it, travel_to ${relic.id}.`);
        }
      }
      const notable = mine.filter((x) => x.type !== 'entity_moved' && x.type !== 'damaged' && x.type !== 'attack'
        && !(cmd.type === 'collect' && x.type === 'item_picked_up')).slice(-2).map((x) => x.text);
      if (notable.length) outcome += ' ' + notable.join(' ');
    } else {
      const texts = mine.filter((x) => !(x.type === 'damaged' && (x.event as Record<string, unknown>).target === view.self.id)).map((x) => x.text).slice(0, 3);
      outcome = texts.length ? texts.join(' ') : defaultOutcome(cmd, L);
    }
    // 行動から次の自分の手番までに受けた被害の合計（必ず書く）
    if (cmd.type === 'fight') {
      let swings = 0, hits = 0, dealt = 0;
      // until: 'clear' は標的が替わるので、自分の攻撃をすべて数える
      const clear = cmd.until === 'clear';
      const isTarget = (id: string | null | undefined) => clear ? !!id && id !== view.self.id : id === cmd.target;
      for (const e of r.events) {
        if (e.type === 'attack' && e.attacker === view.self.id && isTarget(e.target)) { swings++; if (e.hit) hits++; }
        // 投擲で戦った（with）: 投げた数と当たった数
        if (e.type === 'item_thrown' && e.actor === view.self.id) { swings++; if (e.hit && isTarget(e.hit)) hits++; }
        if (e.type === 'damaged' && e.source === view.self.id && isTarget(e.target)) dealt += e.dealt ?? e.amount;
      }
      if (clear) {
        // 接辞付きの名前・守護者の呼び名で（V3-3 後の AI 評価: 「毒牙の小悪魔」が「小悪魔」、守護者ネガが「ジャッカル」と出た）
        const killed = r.events.filter((e) => e.type === 'died' && e.killer === view.self.id && e.id !== view.self.id).map((e) => {
          if (e.type !== 'died') return '';
          const g = view.entities.find((x) => x.id === e.id)?.guardian;
          if (g) return guardianDisplayName(L, g);
          const base = nameOf(this.catalog.monsters[e.kind ?? '']?.name, L, e.kind ?? '?');
          const af = (e.affixes ?? []).map((a) => nameOf(this.catalog.affixes?.[a]?.name, L, '')).filter(Boolean);
          return af.length ? (L === 'en' ? `${af.join(' ')} ${base}` : `${af.join('')}${base}`) : base;
        });
        if (killed.length) outcome += ' ' + t(L, `倒した: ${killed.length} 体（${killed.join('・')}）。`, `Killed ${killed.length} (${killed.join(', ')}).`);
      }
      // 載せた能動技を使った回数（V3-4a §25.3）
      const used = new Map<string, number>();
      for (const e of r.events) if (e.type === 'ability_used' && e.actor === view.self.id) used.set(e.ability, (used.get(e.ability) ?? 0) + 1);
      const waits = Math.max(0, (r.steps ?? 0) - swings);
      const verb = cmd.with ? t(L, '投げ', 'threw') : t(L, '攻撃し', 'swung');
      const abText = [...used].map(([id, n]) => `${nameOf(this.catalog.abilities[id]?.name, L, id)} ${n} ${t(L, '回', '')}`.trim()).join(t(L, '・', ', '));
      outcome += ' ' + t(L, `${swings} 回${verb} ${hits} 回命中・合計 ${dealt} ダメージを与えた${abText ? `（能動技: ${abText}）` : ''}${waits ? `（待った手番 ${waits}）` : ''}。`,
        `${cmd.with ? 'Threw' : 'Swung'} ${swings} times, ${hits} hit for ${dealt} total${abText ? ` (abilities: ${abText})` : ''}${waits ? ` (waited ${waits} turns)` : ''}.`);
    }
    // 帰還の綱で戻った: 確定点
    const lifelined = r.events.some((e) => e.type === 'player_state' && e.player === this.playerId && e.reason === 'lifeline');
    if (lifelined) {
      const pay = view.expedition?.result?.payout?.players.find((x) => x.player === this.playerId);
      outcome = t(L, `帰還の綱でキャンプへ戻った${pay ? `。確定 +${pay.banked}` : ''}。`, `The lifeline pulled you back to camp${pay ? `. Banked +${pay.banked}` : ''}.`) + ' ' + outcome;
    }
    const harm = harmSummary(r.events, view.self.id);
    // 攻撃によるダメージと、毒・罠などのダメージを分けて書く
    const split = harm.other && harm.other < harm.total ? t(L, `攻撃 ${harm.total - harm.other}・毒など ${harm.other}、`, `attacks ${harm.total - harm.other}, poison etc. ${harm.other}; `)
      : harm.other && (harm.hits || harm.misses) ? t(L, `攻撃 0・毒など ${harm.other}、`, `attacks 0, poison etc. ${harm.other}; `) : '';
    const hpText = split + hpDelta(L, before.self.stats.hp, view.self.stats.hp, harm.total, harm.levelHp);
    if (harm.hits || harm.misses) {
      outcome += ' ' + t(L,
        `${harm.hits + harm.misses} 回攻撃を受け、${harm.hits} 回命中・合計 ${harm.total} ダメージ（${hpText}）${harm.misses ? `、外れ ${harm.misses} 回` : ''}。`,
        `Attacked ${harm.hits + harm.misses} times: ${harm.hits} hit for ${harm.total} total (${hpText})${harm.misses ? `, ${harm.misses} missed` : ''}.`);
    } else if (harm.total) {
      outcome += ' ' + t(L, `合計 ${harm.total} ダメージを受けた（${hpText}）。`, `Took ${harm.total} damage (${hpText}).`);
    }
    const endedNow = r.events.some((e) => e.type === 'expedition_ended');
    let reason: TurnReason = 'action_completed';
    if (cmd.type === 'start_expedition') reason = 'expedition_started';
    else if (r.steps !== undefined && r.interruptedBy && !MACRO_COMPLETED_STOPS.has(r.interruptedBy as MacroStop)) reason = 'macro_interrupted';
    // 結果の文に含めた出来事は「直前の出来事」に重ねて出さない
    const recent = perceived.filter((pe) => !pe.text || !outcome.includes(pe.text));
    const res = this.render(view, reason, { recent, changes: true, interruptedBy: r.steps !== undefined ? r.interruptedBy : undefined, expeditionEndedNow: endedNow });
    const payload: ActionSuccess = {
      ok: true, outcome, steps: r.steps, interrupted_by: r.interruptedBy,
      events: perceived.slice(-20).map((p) => ({ seq: p.seq, type: p.type, text: p.text })),
      observation: res.observation, turn: res.turn,
    };
    if (r.macro && cmd.type !== 'rest') { payload.distance = r.macro.distance; payload.time_elapsed = r.macro.timeElapsed; }
    if (rest) payload.rest = rest;
    if (collected) payload.collected = collected;
    if (cmd.type === 'start_expedition') payload.briefing = this.briefing('start');
    // 遠征が終わった: 遠征レポート（V3-6 §6.1）。キャンプなら結果の行と比較の行は観測に出ているので省く
    if (endedNow) {
      const xe = [...r.events].reverse().find((e) => e.type === 'expedition_ended') as Extract<GameEvent, { type: 'expedition_ended' }> | undefined;
      const rep = xe ? this.session.expeditionReport(this.playerId, xe.no) : null;
      if (rep && rep.status === 'ended') {
        payload.report = rep;
        const atCamp = view.status === 'at_camp';
        this.reportText.set(payload, reportLines(L, rep, { payout: !atCamp, compare: !atCamp }));
      }
    }
    this.rendered.set(payload, res.text);
    return payload;
  }

  /** act が作ったテキスト本文（観測＋変化＋状態行） */
  private readonly rendered = new WeakMap<object, string>();
  private readonly reportText = new WeakMap<object, string[]>();

  formatActionText(p: ActionPayload): string {
    const view = this.view();
    const L = view.locale;
    if (!p.ok) {
      return [
        `${t(L, 'エラー', 'Error')} [${p.error.code}] ${p.error.message}`,
        p.error.hint ? `${t(L, 'ヒント', 'Hint')}: ${p.error.hint}` : '',
        `${t(L, 'できること', 'Actions')}: ${p.valid_actions.join(' / ')}`,
        turnLine(view, p.turn),
      ].filter(Boolean).join('\n');
    }
    const body = this.rendered.get(p) ?? [formatObservationText(p.observation, L), changesLine(L, p.turn.changes), turnLine(view, p.turn)].filter(Boolean).join('\n');
    return [`${t(L, '結果', 'Result')}: ${p.outcome}`, ...(p.briefing ?? []), ...(this.reportText.get(p) ?? []), body].filter(Boolean).join('\n');
  }

  briefing(kind: 'start' | 'resume', opts: { camp?: boolean } = {}): string[] {
    const view = this.view();
    const L = view.locale;
    const lines: string[] = [];
    const x = view.expedition;
    if (x && x.status !== 'ended' && view.status !== 'at_camp') {
      // 2 回目以降の遠征の開始は 1 行（ルールは最初の遠征で説明済み。V3-2R3 §20.6）
      if (kind === 'start' && x.no > 1) lines.push(briefingShort(L, x, this.catalog.rules));
      else {
        lines.push(...briefingLines(L, x, this.catalog.rules));
        lines.push(t(L, `進捗: ${progressText(L, x, view.floor?.depth ?? null)}`, `Progress: ${progressText(L, x, view.floor?.depth ?? null)}`));
      }
    } else if (view.status === 'at_camp') {
      if (x?.result) lines.push(resultText(L, x, this.catalog.rules));
      if (opts.camp !== false) lines.push(...campLines(L, view, this.catalog.rules));
    } else if (!x) {
      lines.push(t(L, '遠征は設定されていない（目的なし）。', 'No expedition is set (no objective).'));
    }
    if (kind === 'resume') {
      lines.push(view.floor && view.self.pos
        ? t(L, `現在地: 地下${view.floor.depth}階 (${view.self.pos.x},${view.self.pos.y})、HP ${view.self.stats.hp}/${view.self.stats.maxHp}`, `Location: depth ${view.floor.depth} (${view.self.pos.x},${view.self.pos.y}), HP ${view.self.stats.hp}/${view.self.stats.maxHp}`)
        : view.status === 'at_camp' ? t(L, '現在地: キャンプ', 'Location: camp') : t(L, '現在地: なし', 'Location: none'));
      const ms = this.session.messages(this.playerId).filter((m) => MILESTONE_TYPES.has(m.type) || (m.type === 'died' && m.text.includes(t(L, 'を倒した', 'You kill')))).slice(-10);
      if (ms.length) {
        lines.push(t(L, '直近の節目:', 'Recent milestones:'));
        for (const m of ms) lines.push(`- [${m.seq}] ${m.text}`);
      }
      if (view.notes.length) {
        lines.push(t(L, 'あなたのメモ:', 'Your notes:'));
        view.notes.forEach((n, i) => lines.push(`- ${i}: ${n}`));
      }
    }
    return lines;
  }

  look(target: Pos | string): InfoResult {
    return describeTarget(this.view(), this.catalog, target);
  }

  map(region?: { x: number; y: number; w: number; h: number }): InfoResult {
    const view = this.view();
    const L = view.locale;
    const f = view.floor;
    if (!f) return { text: t(L, 'フロア外', 'Not on a floor'), data: null };
    let r = region;
    if (!r) {
      // 既知セルのバウンディングボックス
      let minX = f.width, minY = f.height, maxX = -1, maxY = -1;
      view.memory.terrain.forEach((v, i) => {
        if (!v) return;
        const x = i % f.width, y = Math.trunc(i / f.width);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      });
      r = maxX < 0 ? { x: 0, y: 0, w: 1, h: 1 } : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
    }
    const m = renderAsciiMap(view, this.catalog, r);
    const pois: { type: string; name: string; pos: Pos }[] = [];
    view.memory.terrain.forEach((v, i) => {
      const tid = view.terrainTable[v];
      const st = this.catalog.terrain[tid]?.stairs;
      if (v && st) pois.push({ type: `stairs_${st}`, name: nameOf(this.catalog.terrain[tid].name, L), pos: { x: i % f.width, y: Math.trunc(i / f.width) } });
    });
    for (const rem of view.memory.remembered) pois.push({ type: rem.role ?? rem.cat, name: kindName(this.catalog, L, rem.kind, rem.appearanceId), pos: rem.pos });
    const text = [
      t(L, `地下${f.depth}階の記憶地図（上の 2 行が x 座標の 10 の位と 1 の位、左が y 座標）`, `Known map of depth ${f.depth} (top rows: x tens/ones, left: y)`),
      ...mapTextLines(m),
      t(L, '凡例: ', 'Legend: ') + Object.entries(m.legend).map(([k, v]) => `${k}=${v}`).join(' '),
      t(L, '注目点: ', 'Points of interest: ') + (pois.map((p) => `${p.name}(${p.pos.x},${p.pos.y})`).join(', ') || t(L, 'なし', 'none')),
    ].join('\n');
    return { text, data: { ...m, points_of_interest: pois, floor: { depth: f.depth, width: f.width, height: f.height } } };
  }

  inventory(): InfoResult {
    const view = this.view();
    const inv = describeInventory(view, this.catalog);
    const eq = view.self.equip;
    return { text: inv.text, data: { items: inv.items, equipment: eq, capacity: view.self.capacity } };
  }

  recall(q: string): InfoResult {
    const view = this.view();
    const L = view.locale;
    const needle = q.trim().toLowerCase();
    const kind = Object.keys(this.catalog.monsters).find((id) => {
      const n = this.catalog.monsters[id].name;
      return id === q || n.ja === q.trim() || n.en.toLowerCase() === needle;
    });
    if (!kind) return { text: t(L, `「${q}」という種族は知らない。`, `You know of no creature called "${q}".`), data: null };
    const mem = view.monsterMemory[kind];
    // 守護者の記録は種族と分けて残る（V3-2R3 §20.4）
    const gmem = view.monsterMemory[memoryKey(kind, 'guardian')];
    const name = kindName(this.catalog, L, kind);
    if (!mem && !gmem) return { text: t(L, `${name}にはまだ遭遇していない。`, `You have not met a ${name} yet.`), data: { kind, memory: null } };
    const note = mem?.hpSeen
      ? t(L, '（体力の記録は目の前で倒した個体の最大 HP。接辞・深層強化はこれより頑丈なことがある。守護者は別の記録）', ' (HP record = max HP of those you saw die; affixes and tiers can be sturdier; guardians are recorded separately)')
      : t(L, '（体力は目の前で倒すと分かる）', ' (HP is learned when you see one die)');
    const parts = [mem ? `${name}: ${memoryCombatText(L, mem)}${note}` : t(L, `${name}: 通常の個体の記録なし`, `${name}: no record of ordinary ones`)];
    if (gmem) parts.push(t(L, `守護者の記録: ${memoryCombatText(L, gmem)}`, `Guardian record: ${memoryCombatText(L, gmem)}`));
    return { text: parts.join('\n'), data: { kind, memory: mem ?? null, ...(gmem ? { guardian: gmem } : {}) } };
  }

  messages(sinceSeq = 0, limit = 30): InfoResult {
    const msgs = this.session.messages(this.playerId).filter((m) => m.seq > sinceSeq).slice(-Math.max(1, Math.min(200, limit)));
    return { text: msgs.map((m) => `[${m.seq}] ${m.text}`).join('\n') || t(this.locale(), '（新しい出来事は無い）', '(no new messages)'), data: msgs.map((m) => ({ seq: m.seq, type: m.type, text: m.text })) };
  }
}

function defaultOutcome(cmd: Command, L: Locale): string {
  switch (cmd.type) {
    case 'move': return t(L, `${cmd.dir} へ移動した。`, `You move ${cmd.dir}.`);
    case 'wait': return t(L, '待機した。', 'You wait.');
    case 'say': return t(L, '発言した。', 'Message sent.');
    case 'note': return t(L, 'メモを更新した。', 'Notes updated.');
    case 'extract': return t(L, 'extract した。', 'You extract.');
    case 'start_expedition': return t(L, '遠征を始めた。', 'The expedition begins.');
    default: return t(L, `${cmd.type} を実行した。`, `Did ${cmd.type}.`);
  }
}

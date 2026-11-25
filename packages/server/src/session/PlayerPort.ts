// PlayerPort: プレイヤー（AI・人間とも）への唯一の窓口。PlayerView 経由の情報しか返さない。
// MCP アダプタと人間用 WS の両方がこれを使う（どちらかを特別扱いしない）。
import type {
  ActionError, Catalog, Command, Dir, ExpeditionReport, GameEvent, Locale, ObsSlay, Observation, ObservationOptions, PerceivedEvent, PlayerId, PlayerView, Pos, RunSummary, TurnBlock, TurnReason,
} from '@muse/shared';
import {
  actionError, briefingLines, briefingShort, buildObservation, checkpointChangeText, withdrawText, buildTurnBlock, campLines, changesLine, compareLines, describeInventory, describeTarget, diffChanges, progressLines, reportLines,
  cheb, compassDir, dirLabel, formatObservationText, guardianDisplayName, kindName, lastWithoutXp, MACRO_COMPLETED_STOPS, mapTextLines, memoryCombatText, memoryKey, mineCount, nameOf, nearDirs, pickableItems, progressText, renderAsciiMap, resultText, t,
  turnLine, turnSnapshot, turnStateOf, fightThreats, fleeRiskText, riskText, threatEstimate, DIR_VEC, collectTargets, collectWhatOf, itemDisplayName, slayGroupText, slaysAt,
} from '@muse/shared';
import type { MacroReport } from './RunSession';
import { compareVersions, ENGINE_VERSION } from '@muse/engine';
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
  /** キャンプで目的を持ち主に握られているとき、持ち主が遠征を始めるまで待つ（S8。SEASON.md §54.4 の 5） */
  waitForOwner(timeoutMs: number): Promise<'started' | 'released' | 'timeout' | 'ended'>;
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
  /** 目標（V3-7a §40.8）: 宣言中の目標・候補・記録・キャンプの文 */
  /** review: 終了した遠征のレポートと場面 */
  review(no?: number): InfoResult;
  /** expedition ツールに足す行（進行中なら途中経過、キャンプなら直前の遠征のレポート） */
  expeditionReportLines(): { lines: string[]; progress?: Pick<ExpeditionReport, 'combat' | 'tempo'>; report?: ExpeditionReport };
  /** 討伐の記録の全文（S6。records ツール） */
  slayArchive(): { lines: string[]; data: { depth: number; warden: string; records: ObsSlay[] }[] };
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

/**
 * 装備を替えたときの能力の変わった所（S7）: 能力の行と同じ項目（命中・ダメージ・回避・装甲）の「前 → 後」。変わっていなければ空
 */
export function statChangeText(L: Locale, a: Observation['self'], b: Observation['self']): string {
  const sg = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  const parts = [
    a.attack.acc !== b.attack.acc ? t(L, `命中${sg(a.attack.acc)} → ${sg(b.attack.acc)}`, `acc ${sg(a.attack.acc)} -> ${sg(b.attack.acc)}`) : '',
    a.attack.dmg !== b.attack.dmg ? t(L, `ダメージ${a.attack.dmg} → ${b.attack.dmg}`, `dmg ${a.attack.dmg} -> ${b.attack.dmg}`) : '',
    a.defense.eva !== b.defense.eva ? t(L, `回避${a.defense.eva} → ${b.defense.eva}`, `eva ${a.defense.eva} -> ${b.defense.eva}`) : '',
    a.defense.armor !== b.defense.armor ? t(L, `装甲${a.defense.armor} → ${b.defense.armor}`, `armor ${a.defense.armor} -> ${b.defense.armor}`) : '',
    a.speed !== b.speed ? t(L, `速さ${a.speed} → ${b.speed}`, `speed ${a.speed} -> ${b.speed}`) : '',
  ].filter(Boolean);
  return parts.length ? t(L, `能力の変わった所: ${parts.join('・')}。`, `Stats changed: ${parts.join(', ')}.`) : '';
}

/**
 * explore toward の結果の文に添える、方角と違う向きに歩いた理由（S1b §12.4 の 4）。
 * 方角に行ける未探索の境界が無かった手・方角の境界が遠回りで近い境界を先に見た回数・始めた所から見て方角と違う向きに進んだ（道が回り込んでいる）
 */
export function towardNote(L: Locale, tw: NonNullable<MacroReport['toward']>, end: Pos | null): string {
  if (!tw.dir) return '';
  const what = tw.kind === 'draft' ? t(L, '下への風', 'the draft') : t(L, '気配', 'the sense');
  const dir = dirLabel(L, tw.dir);
  // 方角の幅を広げた（S7 §52.3 の 4・S7b）: 実際にしたこと（広げた所から、どちらへ何マス、何手）
  if (tw.widen) {
    const how = tw.widen.level === 1 ? t(L, '横', 'the sides') : t(L, '後ろ', 'behind');
    const d = end ? cheb(tw.widen.from, end) : 0;
    const nd = end && d > 0 ? compassDir(tw.widen.from, end) : null;
    const moved = nd ? t(L, `広げた所から${dirLabel(L, nd)}へ ${d} マス進んだ`, `ended ${d} cells ${nd} of where it widened`) : t(L, '広げた所の近くに戻った', 'ended back near where it widened');
    return t(L, `${what}の方角（${dir}）とその両隣に、行ける未探索の境界が無かったので、方角の幅を${how}まで広げて ${tw.widen.steps} 手歩き、${moved}。`,
      `There was no reachable unexplored edge toward ${what} (${tw.dir}) or either side of it, so it widened to ${how} and walked ${tw.widen.steps} step${tw.widen.steps > 1 ? 's' : ''}; it ${moved}.`);
  }
  if (tw.noAlong) return t(L, `${what}の方角（${dir}）に、行ける未探索の境界が無い手が ${tw.noAlong} 手あった（その間は、ほかの方角の近い境界を探した）。`, `For ${tw.noAlong} step${tw.noAlong > 1 ? 's' : ''} there was no reachable unexplored edge toward ${what} (${tw.dir}); meanwhile it searched the nearest edges in other directions.`);
  if (tw.detour) return t(L, `${what}の方角（${dir}）の境界は遠回りなので、近くの境界を先に見た（${tw.detour} 回）。`, `The edges toward ${what} (${tw.dir}) were a long way round, so it looked at nearer ones first (${tw.detour} time${tw.detour > 1 ? 's' : ''}).`);
  const moved = end && cheb(tw.start, end) >= 2 ? compassDir(tw.start, end) : null;
  if (moved && !nearDirs(tw.dir).includes(moved)) return t(L, `${what}の方角（${dir}）の境界へは、分かっている道が回り込んでいるので、始めた所から${dirLabel(L, moved)}へ進んだ。`, `The known way to the edges toward ${what} (${tw.dir}) winds around, so you moved ${moved} from where you started.`);
  return '';
}

/**
 * 予備動作で止まった応答の文（S1c §14.4 の 4）: 見えている予備動作ごとに、だれが・何の構えか・的のマス（突進は直線の始めと終わり）・自分がそこにいるか。
 * 的から外れる一歩（valid_actions の「外れる」の move）も添える
 */
export function intentStopText(L: Locale, view: PlayerView, catalog: Catalog): string {
  const me = view.self.pos;
  const f = view.floor;
  if (!me || !f) return '';
  const obs = buildObservation(view, catalog, { detail: 'brief', map: false });
  const parts: string[] = [];
  for (const m of obs.visible.monsters) {
    const e = view.entities.find((x) => x.id === m.id);
    if (!m.intent || !e?.intent) continue;
    if (e.intent.kind === 'winding_up' && e.intent.dir) {
      // 突進の直線（6 マス以内。覚えている地形で通れないマスの手前まで）
      const cells: Pos[] = [];
      for (let k = 1; k <= 6; k++) {
        const x = e.pos.x + DIR_VEC[e.intent.dir][0] * k, y = e.pos.y + DIR_VEC[e.intent.dir][1] * k;
        if (x < 0 || y < 0 || x >= f.width || y >= f.height) break;
        const tr = catalog.terrain[view.terrainTable[view.memory.terrain[y * f.width + x]]];
        if (tr && !tr.passable && !tr.door) break;
        cells.push({ x, y });
      }
      const on = cells.some((c) => c.x === me.x && c.y === me.y);
      const span = cells.length ? `(${cells[0].x},${cells[0].y})〜(${cells[cells.length - 1].x},${cells[cells.length - 1].y})` : '-';
      parts.push(t(L, `${m.name} ${m.id} が突進の構え: ${dirLabel(L, e.intent.dir)}の直線 ${span}。あなたは${on ? 'その直線の上にいる' : '直線の上にいない'}`, `${m.name} ${m.id} braces to charge: the ${e.intent.dir} line ${span}; you are ${on ? 'on' : 'off'} that line`));
    } else if (e.intent.kind === 'swinging' && e.intent.pos) {
      const on = e.intent.pos.x === me.x && e.intent.pos.y === me.y;
      parts.push(t(L, `${m.name} ${m.id} が大振りの構え: 打つマス (${e.intent.pos.x},${e.intent.pos.y})。あなたは${on ? 'そのマスにいる' : 'そのマスにいない'}`, `${m.name} ${m.id} winds up a heavy swing at (${e.intent.pos.x},${e.intent.pos.y}); you are ${on ? 'on' : 'off'} that cell`));
    } else parts.push(`${m.name} ${m.id}: ${m.intent.text}`);
  }
  if (!parts.length) return '';
  const steps = obs.valid_actions.filter((v) => v.startsWith('move ') && (v.includes('大振りの的から外れる') || v.includes('突進の直線から外れる') || v.includes('step out of the heavy swing') || v.includes('step off the charge line'))).map((v) => v.split(' (')[0]);
  return ' ' + t(L, `予備動作: ${parts.join('／')}。${steps.length ? `外れる一歩: ${steps.join('・')}。` : ''}`, `Telegraphs: ${parts.join(' / ')}.${steps.length ? ` Steps out: ${steps.join(', ')}.` : ''}`);
}

/** シーズンの決まりの短い説明（S0。参加したとき・再開したとき） */
function seasonBriefing(L: Locale, s: NonNullable<PlayerView['season']>, fire?: { costPerDepth: number; returnTurns?: number; perSeason: number }, supply?: { cap: number; perExpedition: number }): string[] {
  const cost = fire?.costPerDepth ?? 100;
  const turns = fire?.returnTurns ?? 5;
  return [
    t(L, `シーズン「${s.name}」に参加している（ソロ。全員が同じシードのダンジョンを、それぞれのランで潜る）。詳しくは get_rules topic=season。`, `You are in season "${s.name}" (solo; everyone dives the same seed in their own run). Details: get_rules topic=season.`),
    t(L, `- 行動予算: シーズンを通して自分の手番 ${s.budget.limit}（ランをまたいで 1 つ。残り ${Math.max(0, s.budgetLeft)}）。迷宮の中の手番だけ減る。尽きた手番で時間切れ（キャンプへ戻り、未確定の戦利品を失う。倒れた扱いにはしない）。帰る分を残すこと。`, `- Budget: ${s.budget.limit} own turns for the whole season (one budget across runs; ${Math.max(0, s.budgetLeft)} left). Only dungeon turns count. Running out is time up (back to camp, unbanked haul lost; not counted as dying). Keep enough to get home.`),
    t(L, '- 階は、ランの間、作られたまま残る（遠征ごとに変わらない）。地形と階段の位置は、だれのランでも同じ。キャンプで report_stairs すると、このランで見た下り階段と特別な場所（部屋の作りにある祭壇・賭けの祭壇・碑文）を報告できる（それぞれ最初の報告者に貢献 1）。倒れると、報告していないものは報告できなくなる。公開された階段は、次の遠征から、入口からの道しるべ（いちばん短い道のマス）と一緒に地図に載る（travel_to stairs_down で向かえる）。', '- Floors persist for the whole run (they do not change between expeditions). Terrain and stairs are the same in every run. At camp, report_stairs reports the down stairs and special places (built-in altars, altars of chance, inscriptions) you saw in this run (1 contribution to the first reporter of each). If you die, what you did not report is lost. Published stairs appear on your map from the next expedition, with a trail from the entrance (the shortest way; travel_to stairs_down goes there).'),
    t(L, '- 賞: 冒険（いちばん深い階）・貢献（最初の報告の数）・生還（一度も倒れていない者の確定点の合計）・支援（自分の野営の火を、ほかの参加者が使った人数）。同着は使った予算の少ないほうが上。順位はキャンプの観測に出る。', '- Awards: adventure (deepest floor), contribution (first reports), survival (banked points of those who never died), support (other participants who used your campfires). Ties go to less budget used. Standings show at camp.'),
    t(L, `- 補給の置き場: 各階の上り・下り階段のマスと野営の火に、消耗品（薬・巻物・投げる武器）を deposit_supply { slot } で預けられる（1 手番。置き場 1 つに ${supply?.cap ?? 5} 個まで）。take_supply { id } で取れる（1 回の遠征で ${supply?.perExpedition ?? 1} つまで）。預けた品はキャンプに着くと共有され、ほかの参加者が取ると支援賞に数える。`, `- Supply caches: at the stairs up and down of each floor and at campfires, deposit_supply { slot } leaves a consumable (potion, scroll, throwing weapon; one turn; ${supply?.cap ?? 5} per cache), take_supply { id } takes one (${supply?.perExpedition ?? 1} per expedition). Deposits are shared once you reach camp, and takes by others count for your support award.`),
    t(L, '- 討伐の記録: 節目の大守護者を倒した者の、その戦いの事実（装備とそれを手に入れた階・与えた被害・使った品など）が、倒した者がキャンプに着くと記録庫に載り、まだ倒していない者の、その大守護者を倒す候補とキャンプの記録庫に出る。ほかの参加者の残したものは、道しるべ・野営の火・補給の置き場・公開された場所・討伐の記録だけ（書き置きや野営の跡は迷宮に元からある）。', '- Warden kill records: when someone slays a milestone warden, the facts of that fight (gear and where it was found, damage dealt, items used...) go into the archive once they reach camp, and show in that warden\'s offer for those who have not slain it, and in the camp archive. The only things other participants leave are trails, campfires, supply caches, published places and kill records (notes and old camps are part of the dungeon).'),
    t(L, `- 野営の火: 迷宮の中で place_fire（1 手番。費用は 深さ × ${cost} 点を、このランの確定点から。シーズンで ${fire?.perSeason ?? 3} つまで）。置いた本人の得: 火の上か隣から extract で帰れる（追ってくる敵が見えていなければ。帰り支度 ${turns} 手番）・火から帰ると次の遠征はそこから始まる・interact で HP が休憩の上限まで戻る（1 回の遠征で、1 つの階につき 1 回）。キャンプに着くと、ほかの参加者の世界の同じマスにも現れ、使われると支援賞に数える。詳しくは get_rules topic=season。`, `- Campfires: place_fire in the dungeon (one turn; costs depth x ${cost} of this run's banked points; ${fire?.perSeason ?? 3} per season). What you get: extract on or next to it takes you home (with no hunting enemy in view; ${turns} turns packing up), your next expedition then starts there, and interact heals you to the rest cap (once per floor per expedition). Once you reach camp it appears on the same cell in the others' worlds, and their uses count for your support award. Details: get_rules topic=season.`),
  ];
}

/**
 * fight が「相手が離れた」で止まったときの添え書き（S4 §35.6 の 4）: 離れて撃つ相手・逃げる相手には、寄って殴るより、投げる品か視線を切る。
 * 言うのは、見れば分かる性質（公開の種族のタグ `ranged`）と思い出（`ranged`・`flees`）の範囲だけ。「寄ると下がる」は種族ごとに違う
 * （骨の射手は下がらない）ので言わない（S4b §46.4 の 3）
 */
export function movedAwayNote(L: Locale, catalog: Catalog, view: PlayerView, targetId: string): string {
  const tg = view.entities.find((e) => e.id === targetId && e.cat === 'monster');
  const kind = tg?.kind ?? null;
  const mem = kind ? view.monsterMemory[kind] : undefined;
  const ranged = !!kind && (!!catalog.monsters[kind]?.tags.includes('ranged') || !!mem?.abilities.includes('ranged'));
  const flees = !!tg?.fleeing || !!mem?.abilities.includes('flees');
  if (!ranged && !flees) return '';
  const name = tg ? kindName(catalog, L, tg.kind) : '';
  return ranged
    ? t(L, `${name}は離れて撃つ相手なので、寄って殴るのは難しいことがある。この相手には、投げる品（fight { target, with }）か、視線を切る（曲がり角・扉の陰に入り、寄ってくるのを待つ）。`, `The ${name} shoots from afar, so walking up to strike may not work. Against it, throw things (fight { target, with }) or break its line of sight (step behind a corner or door and let it come to you).`)
    : t(L, `${name}は手負いになると逃げる相手なので、追っても追いつきにくい。この相手には、投げる品（fight { target, with } は逃げる相手にも投げる）。`, `The ${name} runs when wounded, so chasing it rarely works. Against it, throw things (fight { target, with } throws at fleeing targets too).`);
}

const STOP_TEXT: Record<string, [string, string]> = {
  hostile_in_view: ['敵が視界に入った', 'a hostile came into view'],
  hostile_adjacent: ['隣に起きている敵がいる（退くなら mode: flee、戦うなら fight）', "an awake enemy is adjacent (retreat with mode: 'flee', or fight)"],
  hp_floor: ['HP が hp_floor 以下になった', 'HP fell to hp_floor or below'],
  hp_risk: ['次の手番に、最悪の 1 手で倒れうるか、見込みの被害で hp_floor を割る（被弾の前に止まった）', 'one worst turn could kill you, or the expected damage would drop you below hp_floor (stopped before being hit)'],
  flee_lethal: ['次の 1 歩の間に、届く敵の最悪の 1 手で倒れうる（逃げる移動。hp_floor によらず止まった）', 'one worst turn from enemies in reach could kill you during the next step (flight; stopped whatever hp_floor is)'],
  first_hit: ['被弾の記録の無い相手から初めて被弾した（数字を見てから続けるかを決める）', 'first hit from a creature with no record (check the numbers before continuing)'],
  hostile_alerted: ['見えている敵が追跡に変わった', 'a visible enemy started hunting you'],
  hp_threshold: ['HP が 50%・25% の線をまたいだ', 'HP crossed the 50% / 25% line'],
  target_down: ['相手が倒れた', 'the target fell'],
  target_gone: ['相手が見えなくなった（物陰に入ったまま、待っても現れない）', 'the target is out of sight (it took cover and did not come out)'],
  target_fled: ['相手が逃げて見えなくなった', 'the target fled out of sight'],
  shot_while_waiting: ['待っている間に、標的ではない敵に撃たれた（射撃する敵へ近づく／視線を切る。fight の approach: \'advance\' で寄って戦える）', 'another enemy shot you while you waited (close in on the shooter or break line of sight; fight with approach: \'advance\' closes in and fights)'],
  cleared: ['届く追跡中の敵がいなくなった', 'no hunting enemy left in reach'],
  intent: ['見えている敵が予備動作を見せた（次の手番に大きな行動が来る。alerts の intent を見る）', 'a visible enemy shows an intent (a big move comes next turn; see the intent alert)'],
  target_moved: ['相手が離れた（逃げた・射程を出た）', 'the target moved away (fled or left range)'],
  target_adjacent: ['相手が隣に来た（近接で続けるなら fight { target }）', 'the target is adjacent (continue in melee with fight { target })'],
  out_of_ammo: ['投げる物が尽きた', 'nothing left to throw'],
  not_throwable: ['そのスロットの品は投げられない', 'that slot holds nothing throwable'],
  no_line_of_sight: ['射線が 3 手番続けて通らなかった', 'no clear line for 3 turns'],
  target_not_approaching: ['相手が近づいてこない（3 手番続けて近づかない・待つ上限。fight の approach: \'advance\' で寄って戦える）', 'the target is not coming (3 turns without closing in, or the wait limit; fight with approach: \'advance\' closes in)'],
  no_progress: ['同じ 2 マスを往復して進めない（行き先か道を変える）', 'stuck going back and forth between two cells (pick another destination or route)'],
  hit_and_run: ['待つ間に標的に殴られたが、標的は隣にいない（当てては離れる相手。寄って殴る・通路で受ける・投げる）', 'the target hit you while you waited but is not adjacent (it strikes and backs off: close in, hold a corridor, or throw)'],
  target_shooting: ['標的は離れたまま撃ってくる（その場で撃つ相手。射線を切るか、寄って殴る: fight の approach: \'advance\' で寄って戦える）', 'the target keeps shooting from where it stands (it does not close in: break its line of fire or close in yourself; fight with approach: \'advance\' closes in and fights)'],
  target_not_hunting: ['相手はあなたを追っていない（寄って殴るなら fight の approach: \'advance\'）', 'the target is not hunting you (fight with approach: \'advance\' walks up and strikes)'],
  collect_far: ['残りの品は within 歩より遠い（拾うなら within を大きくする）', 'the remaining items are farther than within steps (raise within to fetch them)'],
  chaser_near: ['止まらずに探索を続けていた遅い追跡者が 2 マス以内に来た', 'a slow hunter you kept exploring ahead of came within 2 cells'],
  damage_taken: ['この呼び出しで受けた被害の合計が最大 HP の 4 分の 1 を超えた（steady）', 'the damage taken during this call passed a quarter of your max HP (steady)'],
  damaged: ['ダメージを受けた', 'you took damage'],
  item_seen: ['新しいアイテムを見つけた', 'you spotted a new item'],
  stairs_seen: ['階段を見つけた', 'you found stairs'],
  arrived: ['到着した', 'arrived'],
  sense_found: ['気配の元（この遠征の目的の遺物・守護者）が見えた（travel_to でその場所へ）', 'the source of the sense (this expedition\'s relic or guardian) is in view (travel_to it)'],
  hit_while_waiting: ['待つ間に、標的ではない隣の敵に殴られた（その敵と戦うなら fight { target }、until: clear なら隣の敵へ切り替える）', 'a non-target enemy next to you hit you while you waited (fight it with fight { target }; until: clear switches to it)'],
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
  time_up: ['シーズンの行動予算が尽きた（時間切れでキャンプへ戻った）', 'the season budget ran out (time up: back at camp)'],
  error: ['行動できなかった', 'an action failed'],
  attacked: ['攻撃を受けた', 'you were attacked'],
  collected: ['回収し終えた', 'nothing left to collect'],
  toward_exhausted: ['その方角（下への風・気配）から両隣・横・後ろまで幅を広げても、行ける未探索の境界が無くなった（残りは敵にふさがれた道か、罠を通る道の先）', 'no reachable unexplored edge left toward the hint, even widening to the sides and behind (the rest are behind enemies or traps)'],
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

/** 見えていない相手からの射撃の方角（古い順。草の中の射手など。V4-0c §4.3） */
function unseenShots(events: readonly PerceivedEvent[], selfId: string): Dir[] {
  const out: Dir[] = [];
  // 当たった射撃は damaged（攻撃の出来事は外れたときだけ文になる）、外れた射撃は attack で数える
  for (const e of events) {
    const ev = e.event as unknown as { attacker?: string | null; source?: string | null; target?: string; fromDir?: Dir | null; ranged?: boolean; hit?: boolean; via?: string };
    if (ev.target !== selfId || !ev.fromDir) continue;
    if (e.type === 'attack' && ev.attacker === null && ev.ranged && !ev.hit) out.push(ev.fromDir);
    if (e.type === 'damaged' && ev.source === null && (ev.via === 'ranged' || ev.via === 'thrown')) out.push(ev.fromDir);
  }
  return out;
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
    const observation = buildObservation(view, this.catalog, { detail: opts.detail ?? 'brief', map: opts.map ?? true, recent: lastWithoutXp(recent, 10), campCompare: this.campCompare(view), ...this.campSlayExtras(view), offerNotes: this.offerNotes(view), records: this.campRecords(view) });
    return { observation, text: formatObservationText(observation, view.locale) };
  }

  /** 観測に渡す目標（V3-7a §40.8）: キャンプでは候補と記録、遠征中は宣言中の目標といまの値 */
  /** キャンプの記録の 1 行と、直前の遠征で取った実績（V3-7。プロフィールは World の外） */
  private campRecords(view: PlayerView): ObservationOptions['records'] {
    if (view.status !== 'at_camp') return undefined;
    const prof = this.session.deps.profiles;
    const id = this.session.profileOf(this.playerId);
    if (!prof || !id) return undefined;
    const first = this.session.endedReports(this.playerId).length === 0;
    const line = prof.campLine(id, view.locale, first ? this.session.runId : undefined);
    if (!line) return undefined;
    const last = this.session.endedReports(this.playerId).pop();
    const featsNew = last ? prof.featsOf(id, this.session.runId, last.no, view.locale) : [];
    return { line, ...(featsNew.length ? { featsNew } : {}) };
  }

  /** 候補に添える注記（V3-3c §44.1）: 再挑戦の守護者と前回戦ったときの与えた・受けた被害（本人の遠征レポートから） */
  private offerNotes(view: PlayerView): Record<number, string> | undefined {
    if (view.status !== 'at_camp' || !view.camp) return undefined;
    const L = view.locale;
    const out: Record<number, string> = {};
    for (const o of view.camp.offers) {
      if (!o.rechallenge) continue;
      // その守護者と戦った最後の遠征
      let last: { no: number; dealt: number; taken: number } | null = null;
      const bounty = !!o.rechallenge.bounty;
      for (const r of this.session.endedReports(this.playerId)) {
        const f = (bounty ? r.combat.bounty_fights : r.combat.guardian_fights)?.find((x) => x.id === o.rechallenge!.guardian);
        if (f) last = { no: r.no, dealt: f.dealt, taken: f.taken };
      }
      // 傷跡（V3-8 §53.3）は候補の文にも出るが、前回の戦いと並べて読めるようにここにも添える
      const scar = o.scar ? t(L, `。傷跡で体力 −${o.scar}`, `; scars: −${o.scar} HP`) : '';
      out[o.index] = (last ? t(L, `前回（遠征 ${last.no}）は与 ${last.dealt}・被 ${last.taken}`, `last time (expedition ${last.no}): dealt ${last.dealt}, took ${last.taken}`)
        : bounty ? t(L, 'この賞金首とはまだ戦っていない', 'you have not fought this bounty yet') : t(L, 'この守護者とはまだ戦っていない', 'you have not fought this guardian yet')) + scar;
    }
    return Object.keys(out).length ? out : undefined;
  }

  /** キャンプの観測に出す、直前の遠征の比較（2 行以内。V3-6 §35.9） */
  private campCompare(view: PlayerView): ObservationOptions['campCompare'] {
    if (view.status !== 'at_camp') return undefined;
    const r = this.session.expeditionReport(this.playerId, undefined, { endedOnly: true });
    if (!r) return undefined;
    // 倒さずに帰った節目の大守護者への挑戦（S5 §47.4 の 2）: 直前の遠征の振り返りの中に、その遠征の後のキャンプでだけ（次の遠征が終われば、その遠征の振り返りになる）
    const wardens = this.session.wardenAttempts(this.playerId, r.no);
    return { no: r.no, lines: compareLines(view.locale, r), ...(r.compare ? { compare: r.compare } : {}), ...(wardens.length ? { wardens } : {}) };
  }

  /**
   * キャンプの観測に添える（S5b）: 大守護者の候補ごとの、そのランでその大守護者に挑んで退いたいちばん新しい挑戦と、
   * 前のキャンプの後に初めて受け取った討伐の記録。どちらもランの記録から作る（書かない。外に出さない）
   */
  private campSlayExtras(view: PlayerView): Pick<ObservationOptions, 'wardenPrev' | 'slayNews' | 'slayFullDepths'> {
    if (view.status !== 'at_camp' || !view.camp) return {};
    const prev: NonNullable<ObservationOptions['wardenPrev']> = {};
    for (const o of view.camp.offers) {
      const d = o.objective.targetDepth;
      if (o.objective.type !== 'slay_warden' || d === null || (view.milestonesCleared ?? []).includes(d) || prev[d]) continue;
      const a = this.session.lastWardenAttempt(this.playerId, d);
      if (a) prev[d] = a;
    }
    const news = this.session.slayNews(this.playerId);
    // 記録庫を全文で出す節目（S6 §49.5 の 3・4）: そのキャンプで初めて見る記録のある節目（ランの最初のキャンプでは、取り込んであるものすべて）
    const fresh = [...new Set(this.session.slayNews(this.playerId, { firstCamp: true }).map((s) => s.depth))];
    return { ...(Object.keys(prev).length ? { wardenPrev: prev } : {}), ...(news.length ? { slayNews: news } : {}), ...(fresh.length ? { slayFullDepths: fresh } : {}) };
  }

  /**
   * 討伐の記録の全文（S6 §49.5 の 3・4: キャンプの記録庫は 1 行にたたむので、全文はここで読む。records ツール。手番を使わない）。
   * 取り込み済みの World（season.slays）から。シーズンでないラン・記録が無ければ空
   */
  slayArchive(): { lines: string[]; data: { depth: number; warden: string; records: ObsSlay[] }[] } {
    const view = this.view();
    const L = view.locale;
    const all = view.season?.slays ?? [];
    const depths = [...new Set(all.map((s) => s.depth))].sort((a, b) => a - b);
    if (!depths.length) return { lines: [], data: [] };
    const data = depths.map((depth) => ({ depth, warden: guardianDisplayName(L, { name: all.find((s) => s.depth === depth)!.warden }), records: slaysAt(L, this.catalog, view, depth) }));
    const lines = [t(L, '記録庫・討伐の記録（全文。このシーズンで取り込んだもの）:', 'Archive, warden kill records (full text, as last received this season):')];
    for (const x of data) {
      lines.push(t(L, `- 地下${x.depth}階の大守護者「${x.warden}」:`, `- Depth ${x.depth} warden "${x.warden}":`));
      for (const r of x.records) lines.push(`  ${slayGroupText(L, [r])}`);
    }
    return { lines, data };
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
    // 加護の説明は、持っている加護が変わったときの 1 回だけ（V3-3c §44.6 は遠征ごとに 1 回。V3-8a §56.1 の 5 で、ランを通して 1 回に）
    const boonKey = [...(view.self.boons ?? [])].sort().join(',');
    const boonsShort = !!boonKey && prev?.boonKey === boonKey;
    // 古い版で始まったラン（V4-0b §1.2）: キャンプの観測に 1 行、最初の 1 度だけ（覚えているのはサーバーのメモリ。再起動したら、もう 1 度だけ出る）
    const created = this.session.world.meta.engineVersion;
    const versionNote = view.status === 'at_camp' && !prev?.versionNoted && !!created && compareVersions(created, ENGINE_VERSION) < 0
      ? t(L, `このランは古い版で始まった（engine ${created}）。階の一部が姿を変えることがある`, `This run began on an older version (engine ${created}). Some floors may change shape`) : undefined;
    const shots = unseenShots(p.recent, view.self.id);
    const observation = buildObservation(view, this.catalog, { detail: p.detail ?? 'brief', map: true, recent: lastWithoutXp(p.recent, 10), lifelineShort, boonsShort, campCompare: this.campCompare(view), ...this.campSlayExtras(view), offerNotes: this.offerNotes(view), records: this.campRecords(view), ...(versionNote ? { versionNote } : {}), ...(shots.length ? { unseenShots: shots } : {}) });
    const state = turnStateOf(view, p.expeditionEndedNow ?? false).state;
    const cur = turnSnapshot(view, observation, state);
    const longLife = observation.valid_actions.some((a) => a.includes('次の遠征はこの遠征を始めた階段から') || a.includes('the next expedition starts from where this one began'));
    cur.lifeNo = lifelineShort ? prev?.lifeNo : longLife ? xNo : prev?.lifeNo;
    cur.boonKey = xNo !== undefined && boonKey ? boonKey : prev?.boonKey;
    cur.versionNoted = prev?.versionNoted || !!versionNote;
    let changes: TurnBlock['changes'] = [];
    if (p.changes) {
      // 文になった出来事と、知覚した他の者の移動（見えなくなった敵の最後に見た位置。V4-0c §4.2）
      const events = prev ? [...this.session.messages(this.playerId).filter((m) => m.seq > prev.seq), ...this.session.movesSince(this.playerId, prev.seq)].sort((a, b) => a.seq - b.seq) : [];
      changes = diffChanges(prev, cur, view, observation, events, this.catalog);
      // 遠征の途中の区切り（S7 §52.2 の 2・S7a・S7b）: 上限の外に 1 回だけ。どの手番か・出したかは記録から決まる。
      // 判定するのは、基準を進める応答だけ（観戦の先読み peek では呼ばない）。応答を作る時点で敵が見えていれば（協力プレイで仲間の番を待つ間など）出さない
      // （控えは応答のたびに作っておく: 初めて要るときに、長い記録を畳まなくて済むように）
      if (p.changes === true && view.status !== 'at_camp' && this.session.checkpointDue(this.playerId, prev?.seq ?? null) && !view.entities.some((e) => e.cat === 'monster')) changes = [...changes, { code: 'checkpoint', text: checkpointChangeText(L) }];
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

  waitForOwner(timeoutMs: number): Promise<'started' | 'released' | 'timeout' | 'ended'> {
    return this.session.waitForOwner(this.playerId, timeoutMs);
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
      // その方角に行ける境界が無いと断った explore toward の行は、同じ応答の「できること」に出さない（S2a §20.6 の 2。観測は境界の数だけで出すので、方角の境界までは見ない）
      const toward = cmd.type === 'explore' && cmd.toward && (r.error.details as { stop?: string } | undefined)?.stop === 'toward_exhausted' ? `explore toward:${cmd.toward}` : null;
      const valid = toward ? res.observation.valid_actions.filter((l) => !l.startsWith(toward)) : res.observation.valid_actions;
      // 撤退の確かめ（S7）: engine の文は「撤退（報酬なし）」だが、撤退でも戦利品の一部は確定する。事実の文に差し替える（code と hint はそのまま）
      let error = r.error;
      if (cmd.type === 'extract' && error.code === 'confirm_required') {
        const L0 = view.locale;
        const endless = view.expedition?.objective.type === 'endless';
        const ifNow = res.observation.expedition?.haul?.if_extract_now;
        const what = withdrawText(L0, this.catalog.rules.haul.withdrawPct, endless, ifNow);
        error = { ...error, message: endless
          ? t(L0, `目的なしの遠征なので、extract は撤退になる（${what}）。`, `This expedition has no objective, so extracting is a withdrawal (${what}).`)
          : t(L0, `目的は未達成。今 extract すると撤退になる（${what}）。`, `The objective is not complete; extracting now is a withdrawal (${what}).`) };
      }
      const payload: ActionFailure = { ok: false, error, valid_actions: valid, turn: res.turn };
      return payload;
    }
    const perceived = this.session.consumeFor(this.playerId);
    const mine = perceived.filter((p) => p.seq > r.startSeq);
    const L = view.locale;
    let outcome: string;
    let rest: RestReport | undefined;
    let collected: { picked: number; remaining: number } | undefined;
    if (r.steps !== undefined) {
      // 停止の理由（S7b: explore toward の空回りは「同じ 2 マスを往復」ではない。探索し終えた toward_exhausted は、括弧の理由を付けない）
      const stop0 = r.interruptedBy ? STOP_TEXT[r.interruptedBy] : undefined;
      const stop: [string, string] | undefined = r.interruptedBy === 'no_progress' && r.macro?.revisit
        ? ['同じ道を行き来して進めない（同じマスに 3 回目に入るところ）', 'going back and forth on the same way (about to enter the same cell a third time)']
        : r.interruptedBy === 'toward_exhausted' && view.self.pos && buildObservation(view, this.catalog, { detail: 'brief', map: false }).navigation.frontiers.length === 0
          ? ['この階は探索し終えた（行ける未探索の境界が 1 つも無い）', 'this floor is fully explored (no reachable unexplored edge left)']
          : stop0;
      // 見えない相手に撃たれて止まった: 停止の理由に方角を書く（V4-0c §4.3。休憩もほかのマクロも）
      const unseen = r.interruptedBy ? unseenShots(mine, view.self.id) : [];
      const unseenText = unseen.length
        ? t(L, `${dirLabel(L, unseen[unseen.length - 1])}から撃たれた。相手は見えていない。`, ` Shot from the ${unseen[unseen.length - 1]}; the shooter is not in sight.`) : '';
      const m = r.macro;
      if (cmd.type === 'rest') {
        rest = { hp_gained: m?.hpGained ?? 0, turns: r.steps, time_elapsed: m?.timeElapsed ?? null, stopped_by: r.interruptedBy ?? 'step_limit' };
        outcome = t(L,
          `rest: ${r.steps} 手休んだ。HP ${rest.hp_gained >= 0 ? '+' : ''}${rest.hp_gained}${rest.time_elapsed !== null ? `、時間 ${rest.time_elapsed}` : ''}。${stop ? `停止: ${stop[0]}。` : ''}${unseenText}`,
          `rest: ${r.steps} turns. HP ${rest.hp_gained >= 0 ? '+' : ''}${rest.hp_gained}${rest.time_elapsed !== null ? `, time ${rest.time_elapsed}` : ''}.${stop ? ` Stopped: ${stop[1]}.` : ''}${unseenText}`);
      } else {
        const tm = m?.timeElapsed !== null && m?.timeElapsed !== undefined ? t(L, `（${m.distance} 歩、時間 ${m.timeElapsed}）`, ` (${m.distance} moves, time ${m.timeElapsed})`) : '';
        outcome = t(L, `${cmd.type}: ${r.steps} 手進んだ${tm}。${stop ? `停止: ${stop[0]}。` : ''}${unseenText}`, `${cmd.type}: ${r.steps} steps${tm}.${stop ? ` Stopped: ${stop[1]}.` : ''}${unseenText}`);
        // 止まったマスに品がある: 拾う前に止まったことを言う（V3-7 の評価: 薬の上で止まり、拾っていないと気づかなかった）
        if (r.interruptedBy && (cmd.type === 'travel' || cmd.type === 'collect' || cmd.type === 'explore')) {
          const me = view.self.pos;
          const here = me ? view.entities.filter((e) => e.cat === 'item' && e.pos.x === me.x && e.pos.y === me.y) : [];
          if (here.length) outcome += ' ' + t(L, `足元の${here.map((e) => kindName(this.catalog, L, e.kind, e.appearanceId)).join('・')}はまだ拾っていない（pickup）。`, `You have not picked up the ${here.map((e) => kindName(this.catalog, L, e.kind, e.appearanceId)).join(', ')} under you yet (pickup).`);
        }
        // 遅い追跡者に追われたまま探索した（V4-0b §1.4）
        if (m?.slowChasers) outcome += ' ' + t(L, `遅い敵 ${m.slowChasers} 体に追われたまま探索した。`, `Explored with ${m.slowChasers} slow hunter${m.slowChasers > 1 ? 's' : ''} on your trail.`);
        // explore toward: 方角と違う向きに歩いた理由（S1b §12.4 の 4。仕様どおりの動きだが、逆へ進んだと読まれた）
        if (m?.toward) { const note = towardNote(L, m.toward, view.self.pos); if (note) outcome += ' ' + note; }
        // 動かない敵の隣を避けた遠回り（S1c §14.6 の 1。最短より 10 歩を超えて長く、かつ 2 倍を超えるときだけ）
        if (m?.detour) {
          const who = m.detour.around.length ? m.detour.around.map((x) => `${x.name} ${x.id}`).join('・') : t(L, '動かない敵', 'a stationary enemy');
          outcome += ' ' + t(L, `動かない ${who} の隣を通らない道を選んだ（隣を通る近道より ${m.detour.extra} 歩長い）。`, `Took a way that avoids passing next to the stationary ${who} (${m.detour.extra} steps longer than the shortcut past it).`);
        }
        // 往復で止まった: 近道をふさいで道を変えさせた動く敵を名指す（S3c §33.3 の 2。マクロは、道が入れ替わる往復を直さない）
        // 同じマスに 3 回目に入るところで止まった（S7b。explore toward の空回りの見張り）: 事実どおりに
        if (m?.revisit && r.interruptedBy === 'no_progress') outcome += ' ' + t(L, `同じ道を行き来していたので、(${m.revisit.x},${m.revisit.y}) に 3 回目に入るところで止めた（toward の方角の境界へ、この道では近づけない。toward を付けない explore か、travel_to で場所を指す）。`, `It was going back and forth on the same way, so it stopped before entering (${m.revisit.x},${m.revisit.y}) a third time (this way does not get closer to the edges toward the hint; explore without toward, or travel_to a place).`);
        if (m?.routeFoes?.length && r.interruptedBy === 'no_progress') {
          const who = m.routeFoes.map((x) => `${x.name} ${x.id}`).join(t(L, '・', ', '));
          outcome += ' ' + t(L, `道を変えさせた相手: ${who}（動いて近道をふさいだり空けたりするので、通る道が入れ替わった。相手を片付けるか、動きを待つか、別の行き先へ）。`, `What kept changing the route: ${who} (it moved on and off the short way, so the route kept switching; deal with it, wait for it to move, or pick another destination).`);
        }
        // fight: 床の投げ物を拾いに行かなかった（S1b §12.4 の 5）
        if (m?.retrieveHeld) outcome += ' ' + t(L, '床の投げ物を拾いに行くと隣の追ってくる敵から離れるので、拾いに行かなかった（隣の相手と戦うなら fight { target }）。', 'Did not go for your thrown items on the floor: that would mean stepping away from an adjacent hunter (to fight it, fight { target }).');
        // fight で見失った・逃げられた: 最後に見た場所（V4-0b §1.4。マクロが覚えた場所。V4-0c §4.2）
        if (cmd.type === 'fight' && (r.interruptedBy === 'target_gone' || r.interruptedBy === 'target_fled')) {
          const at = m?.targetSeenAt;
          const me = view.self.pos;
          if (at && me) outcome += ' ' + t(L, `最後に見た場所: (${at.x},${at.y})・${dirLabel(L, compassDir(me, at))}${cheb(at, me)} マス。`, `Last seen at (${at.x},${at.y}), ${dirLabel(L, compassDir(me, at))} ${cheb(at, me)}.`);
        }
        // 逃げる移動が、死にうるので止まった（S6 §49.6 の 1）: 最悪の見込みと今の HP、取れる手
        if (r.interruptedBy === 'flee_lethal') outcome += ' ' + fleeRiskText(this.view(), this.catalog);
        // hp_risk: 見込みと最悪の 2 つの数と、実際に使った hp_floor（S1c §14.4 の 1）。何にすれば、あと 1 回の見込みの被害まで続けられるか（V3-3a §35.6）
        if (r.interruptedBy === 'hp_risk' && cmd.type === 'fight') {
          const after = this.view();
          const obsNow = buildObservation(after, this.catalog, { detail: 'brief', map: false });
          outcome += ' ' + riskText(after, this.catalog, m?.hpFloor ?? cmd.hpFloor ?? 0);
          const est = after.self.pos ? threatEstimate(after, this.catalog, fightThreats(this.catalog, after.entities.filter((e) => e.cat === 'monster'), after.self.pos)) : { expected: 0, worst: 0 };
          const inc = est.expected;
          const nf = after.self.stats.hp - inc;
          // 死にうるので止まった（S1d §17.2）: hp_floor を下げても続けられない。退くか回復する
          if (est.worst > 0 && after.self.stats.hp <= est.worst) outcome += t(L, ' hp_floor を下げても、最悪の 1 手で倒れうる間は止まる（退くか、回復してから）。', ' Lowering hp_floor does not help while one worst turn could kill you (retreat or heal first).');
          // 見込みの 1 手を受けても 1 以上残るときだけ、続けられる値を出す（V3-7 の評価: HP 8 で「0 にすれば 22 まで」と出た）
          else if (inc > 0 && nf >= 1) outcome += t(L, ` hp_floor を ${nf} にすれば、あと 1 回の見込みの被害（${inc}）まで続けられる。`, ` With hp_floor ${nf} you can take one more expected turn (${inc}).`);
          else if (inc > 0) outcome += t(L, ` いまの HP ${after.self.stats.hp} では、次の見込みの被害（${inc}）で倒れうる。`, ` At HP ${after.self.stats.hp}, the next expected turn (${inc}) could kill you.`);
          // 囲まれている: この hp_floor では毎手番止まる。何にすれば何手番続くか（V3-3c §44.6）
          const adj = obsNow.visible.monsters.filter((x) => x.awareness === 'hunting' && !x.fleeing && x.dist <= 1).length;
          const hpNow = after.self.stats.hp;
          const k = inc > 0 ? Math.min(3, Math.trunc((hpNow - 1) / inc)) : 0;
          // 死にうるときは、hp_floor の話をしない（S2a §20.10 の 3）
          if (adj >= 2 && k >= 2 && !(est.worst > 0 && hpNow <= est.worst)) outcome += t(L, ` 隣に ${adj} 体いるので、この hp_floor では毎手番止まる。hp_floor を ${hpNow - k * inc} にすれば ${k} 手番続く。`, ` ${adj} enemies are adjacent, so this hp_floor stops every turn; hp_floor ${hpNow - k * inc} keeps going for ${k} turns.`);
        }
        // 相手が離れて止まった（S4 §35.6 の 4）: 離れて撃つ・寄ると下がる・逃げる相手には、寄って殴るより、投げる品か視線を切る（相手の習性は公開の種族の性質と思い出から）
        if (cmd.type === 'fight' && r.interruptedBy === 'target_moved') {
          const note = movedAwayNote(L, this.catalog, view, cmd.target);
          if (note) outcome += ' ' + note;
        }
        // hp_floor で止まった（S4 §35.6 の 1・3）: 使った値と、それが HP の値（割合ではない）であること。1 歩の間に何度も撃たれると、その分だけ下回って止まる
        if (r.interruptedBy === 'hp_floor' && m?.hpFloor !== undefined) {
          const given = 'hpFloor' in cmd && cmd.hpFloor !== undefined;
          const pct = cmd.type === 'fight' ? 50 : 'mode' in cmd && cmd.mode === 'flee' ? 25 : 50;
          outcome += ' ' + t(L,
            `HP ${view.self.stats.hp}・hp_floor ${m.hpFloor}（HP の値で、割合ではない。${given ? '渡した値' : `省いたので既定の最大 HP の ${pct}%`}）。判定は 1 歩・1 手ごとの後なので、その間に何度も攻撃されると、その分だけ下回って止まる。`,
            `HP ${view.self.stats.hp}, hp_floor ${m.hpFloor} (an HP value, not a percentage; ${given ? 'the value you gave' : `omitted, so the default ${pct}% of max HP`}). It is checked after each step or action, so several hits within one step take you below it by that much.`);
        }
        // 予備動作で止まった（S1c §14.4 の 4）: 的になっているマス（大振りのマス・突進の直線）と、自分がそこにいるか、外れる一歩。observe を呼び直さなくて済むように
        if (r.interruptedBy === 'intent') outcome += intentStopText(L, view, this.catalog);
        // 投げた物の在りか（V3-8 §53.3）: 手元の数と床の数（敵の足元の分を含む）
        if (cmd.type === 'fight' && (cmd.with || r.events.some((e) => e.type === 'item_thrown' && e.actor === view.self.id))) {
          const hand = view.inventory.filter((i) => i.kind && this.catalog.items[i.kind]?.category === 'throwing').reduce((a, i) => a + i.qty, 0);
          const mons = view.entities.filter((e) => e.cat === 'monster');
          const floorItems = [
            ...view.entities.filter((e) => e.cat === 'item' && e.mine).map((e) => ({ pos: e.pos, qty: e.qty ?? 1 })),
            ...view.memory.remembered.filter((m) => m.cat === 'item' && m.mine && !view.entities.some((e) => e.id === m.id)).map((m) => ({ pos: m.pos, qty: m.qty })),
          ];
          const onFloor = floorItems.reduce((a, i) => a + i.qty, 0);
          const under = floorItems.filter((i) => mons.some((m) => m.pos.x === i.pos.x && m.pos.y === i.pos.y)).reduce((a, i) => a + i.qty, 0);
          if (onFloor || hand) outcome += ' ' + t(L, `投げ物: 手元 ${hand}・床に ${onFloor}${under ? `（うち敵の足元 ${under}）` : ''}。`, `Throwables: ${hand} in hand, ${onFloor} on the floor${under ? ` (${under} under enemies)` : ''}.`);
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
        // 決着の後に拾った（collect_after。V3-3c §44.6）
        if (cmd.type === 'fight' && cmd.collectAfter) {
          const picked = r.events.filter((e) => e.type === 'item_picked_up' && e.actor === view.self.id).length;
          if (picked) outcome += t(L, ` 投擲物を ${picked} 回拾った（残り ${mineCount(view)} 個）。`, ` Picked up your throws ${picked} times (${mineCount(view)} left).`);
        }
        if (cmd.type === 'collect') {
          // 実際に拾った数（イベントから）と、まだ拾える数
          const picked = r.events.filter((e) => e.type === 'item_picked_up' && e.actor === view.self.id).length;
          const what = collectWhatOf(cmd);
          const remaining = what === 'items' ? pickableItems(view, this.catalog).length : mineCount(view);
          collected = { picked, remaining };
          // 既定（thrown）は自分が投げた物だけ（S1c §14.4 の 6: 薬や宝が残っているのに「回収し終えた」と読まれた）。ほかに拾える品があれば、そう書く
          const others = what === 'thrown' ? collectTargets(view, this.catalog).length : 0;
          const thrownNote = what === 'thrown'
            ? t(L, `（自分が投げた物だけを拾う${others ? `。ほかに拾える品 ${others} 個: collect { what: 'items' }` : ''}）`, ` (only your own thrown items${others ? `; ${others} other items to pick up: collect { what: 'items' }` : ''})`) : '';
          // 遺物は拾わない（拾うと階の敵が目を覚ます判断なので、マクロに任せない）。知っている遺物が床にあれば、「残り 0 個」ではなく対象外と書く（V4-0b §1.5）
          const relic = view.entities.find((e) => e.cat === 'item' && e.role === 'relic') ?? view.memory.remembered.find((r) => r.cat === 'item' && (r.role === 'relic' || r.kind === 'core:relic'));
          const relicNote = what === 'items' && relic
            ? t(L, `遺物は対象外（拾うと階の敵が目を覚ます。拾うなら travel_to ${relic.id} で着いて pickup）`, `the relic is not included (picking it up wakes the floor; travel_to ${relic.id}, then pickup)`) : '';
          outcome += t(L, ` 回収 ${collected.picked} 個、残り ${remaining} 個${thrownNote}。${relicNote ? `${relicNote}。` : ''}`, ` Recovered ${collected.picked}, ${remaining} left${thrownNote}.${relicNote ? ` ${relicNote[0].toUpperCase()}${relicNote.slice(1)}.` : ''}`);
        }
      }
      // 目的を達成した（S3b §30.4 の 1）: 止まった文の先頭に出す（「標的は離れたまま撃ってくる」などの後ろに回り、達成が読み落とされた）
      const achieved = mine.find((x) => x.type === 'objective_completed');
      // 経験値の文（S0b）は最後の 2 件に入れない（直前の出来事に出る。倒した文・レベルアップの文を押し出さない）
      const notable = mine.filter((x) => x !== achieved && x.type !== 'entity_moved' && x.type !== 'damaged' && x.type !== 'attack' && x.type !== 'xp_gained'
        && !(cmd.type === 'collect' && x.type === 'item_picked_up')).slice(-2).map((x) => x.text);
      if (notable.length) outcome += ' ' + notable.join(' ');
      if (achieved) outcome = `${achieved.text}${t(L, '。', '.')} ${outcome}`;
    } else {
      const shown = mine.filter((x) => !(x.type === 'damaged' && (x.event as Record<string, unknown>).target === view.self.id));
      // 最初の 3 件に、倒した文は必ず足す（V3-7 の評価: 薙ぐで倒した 2 体目の「倒した」が無かった）。
      // 経験値の文（S0b）は 3 件の枠に数えず、出た場所にそのまま入れる（ほかの知らせを押し出さない。S0b §7.9）
      const others = shown.filter((x) => x.type !== 'xp_gained');
      const keep = new Set([...others.slice(0, 3), ...others.slice(3).filter((x) => x.type === 'died')]);
      const texts = shown.filter((x) => keep.has(x) || x.type === 'xp_gained').map((x) => x.text);
      outcome = texts.length ? texts.join(' ') : defaultOutcome(cmd, L);
      // 同じ枠の品を外して付けた（S6 §49.6 の 8: 護符を着けると、指輪が黙って外れたと読まれた）: 外れた品と、その枠を先に出す
      if (cmd.type === 'equip') {
        const off = r.events.find((e) => e.type === 'item_unequipped' && (e as { actor?: string }).actor === view.self.id) as { item: string; slotName: string } | undefined;
        const it = off ? view.inventory.find((i) => i.id === off.item) : undefined;
        if (off && it) {
          const name = itemDisplayName(this.catalog, L, it.kind, it.appearanceId, it.affixes);
          const slotNote = off.slotName === 'accessory' ? t(L, '（装飾品の枠は 1 つ: 指輪と護符は同時に付けられない）', ' (one accessory slot: a ring and an amulet cannot be worn together)') : '';
          outcome = t(L, `外れた品: ${name}${slotNote}。`, `Came off: ${name}${slotNote}.`) + ' ' + outcome;
        }
      }
      // 装備を替えた（S7: 指輪の命中 −2 が文に出なかった）: 能力の行の命中・ダメージ・回避・装甲のうち、変わった所を「前 → 後」で
      if (cmd.type === 'equip' || cmd.type === 'unequip') {
        const note = statChangeText(L, buildObservation(before, this.catalog, { detail: 'brief', map: false }).self, buildObservation(view, this.catalog, { detail: 'brief', map: false }).self);
        if (note) outcome += ' ' + note;
      }
      // 地形が分かる品（残り頁・地図の巻物）を使った（S6 §49.6 の 9: 「使った」としか出なかった）: 分かったことを 1 文
      if (cmd.type === 'use') {
        const maps = r.events.filter((e) => e.type === 'knowledge_updated' && (e as { player?: string }).player === this.playerId && (e as { visible?: unknown }).visible === null) as { newlySeen?: number[]; mappedAdd?: number[] }[];
        if (maps.length) {
          const cells = maps.reduce((s, e) => s + Math.floor((e.newlySeen?.length ?? 0) / 2), 0);
          outcome += ' ' + (cells
            ? t(L, `地形が地図に載った（新しく ${cells} マス。目で見たのではないので、敵と品はまだ分からない）。`, `The terrain went onto your map (${cells} new cells; you have not seen them, so enemies and items there are still unknown).`)
            : t(L, '新しく地図に載った地形は無かった（もう知っている範囲だった）。', 'Nothing new went onto your map (you already knew that area).'));
        }
      }
      // 鑑定の巻物を対象なしで使い、ほかにも鑑定できる品があった: 対象の選び方を添える（S1b §12.4 の 8: ねらいと違う品に使った）
      if (cmd.type === 'use' && !cmd.targetSlot) {
        const used = before.inventory.find((i) => i.slot === cmd.slot);
        const ided = r.events.filter((e) => e.type === 'item_identified' && (e as { player?: string }).player === this.playerId) as { kind: string; appearanceId: string | null }[];
        const usedKind = used?.kind ?? (used?.appearanceId ? ided.find((e) => e.appearanceId === used.appearanceId)?.kind : undefined);
        if (used && usedKind && this.catalog.items[usedKind]?.identifies) {
          const cands = before.inventory.filter((i) => i.id !== used.id && ((!i.kind && i.appearanceId !== used.appearanceId) || (!!i.kind && !!this.catalog.items[i.kind]?.slot && !i.inspected)));
          if (cands.length >= 2) outcome += ' ' + t(L, '対象を付けなかったので、スロット順で最初の未鑑定の品を鑑定した（品を選ぶなら use_item { slot, target_slot: <その品のスロット> }）。', 'With no target, it identified the first unidentified item by slot order (to choose, use_item { slot, target_slot: <that item\'s slot> }).');
        }
      }
    }
    // 行動から次の自分の手番までに受けた被害の合計（必ず書く）
    if (cmd.type === 'fight') {
      let swings = 0, hits = 0, dealt = 0, melee = 0, throws = 0, overkill = 0;
      // until: 'clear' は標的が替わるので、自分の攻撃をすべて数える
      const clear = cmd.until === 'clear';
      const isTarget = (id: string | null | undefined) => clear ? !!id && id !== view.self.id : id === cmd.target;
      for (const e of r.events) {
        if (e.type === 'attack' && e.attacker === view.self.id && isTarget(e.target)) { swings++; melee++; if (e.hit) hits++; }
        // 投擲で戦った（with）: 投げた数と当たった数
        if (e.type === 'item_thrown' && e.actor === view.self.id) { swings++; throws++; if (e.hit && isTarget(e.hit)) hits++; }
        if (e.type === 'damaged' && e.source === view.self.id && isTarget(e.target)) {
          dealt += e.dealt ?? e.amount;
          // とどめの超過分（1 行ごとのとどめの文は出目の値を出すので、合計と食い違って見えないように添える。S0b §6.2 の 2）
          if (e.dealt !== undefined && e.amount > e.dealt) overkill += e.amount - e.dealt;
        }
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
      const abText = [...used].map(([id, n]) => `${nameOf(this.catalog.abilities[id]?.name, L, id)} ${n} ${t(L, '回', '')}`.trim()).join(t(L, '・', ', '));
      // 近接と投擲を分けて書く（V3-5a 後の AI 評価: adjacent: 'melee' に切り替えた後の近接も「投げ」と数えた）
      const how = melee && throws ? t(L, `近接 ${melee} 回・投擲 ${throws} 回、`, `${melee} melee and ${throws} throws, `)
        : throws ? t(L, `${throws} 回投げ `, `Threw ${throws} times, `) : t(L, `${melee} 回攻撃し `, `Swung ${melee} times, `);
      const overText = overkill ? t(L, `（実際に減らした HP。とどめの一撃の超過分 ${overkill} は含まない）`, ` (HP actually removed; the finishing blow's ${overkill} overkill is not counted)`) : '';
      outcome += ' ' + t(L, `${how}${hits} 回命中・合計 ${dealt} ダメージを与えた${overText}${abText ? `（能動技: ${abText}）` : ''}${waits ? `（待った手番 ${waits}）` : ''}。`,
        `${how}${hits} hit for ${dealt} total${overText}${abText ? ` (abilities: ${abText})` : ''}${waits ? ` (waited ${waits} turns)` : ''}.`);
    }
    // 帰還の綱で戻った: 確定点
    const lifelined = r.events.some((e) => e.type === 'player_state' && e.player === this.playerId && e.reason === 'lifeline');
    if (lifelined) {
      const pay = view.expedition?.result?.payout?.players.find((x) => x.player === this.playerId);
      outcome = t(L, `帰還の綱でキャンプへ戻った${pay ? `。確定 +${pay.banked}` : ''}。`, `The lifeline pulled you back to camp${pay ? `. Banked +${pay.banked}` : ''}.`) + ' ' + outcome;
    }
    // 引退: ランの確定点の合計（V3-7 の評価: 引退の応答にランのスコアが無かった）
    if (cmd.type === 'retire') {
      const rec = view.record;
      outcome += ' ' + t(L, `ランの確定点の合計 ${rec.banked}・達成した遠征 ${rec.expeditions}${rec.lost ? `・失った戦利品 ${rec.lost}` : ''}。`, `Run total banked ${rec.banked}, expeditions completed ${rec.expeditions}${rec.lost ? `, haul lost ${rec.lost}` : ''}.`);
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
      events: lastWithoutXp(perceived, 20).map((p) => ({ seq: p.seq, type: p.type, text: p.text })),
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
    // シーズン（S0 §9.6）: 参加したときと再開したときに、決まりを短く（詳しくは get_rules topic=season）
    if (view.season) lines.push(...seasonBriefing(L, view.season, this.catalog.rules.seasonFire, this.catalog.rules.seasonSupply));
    if (x && x.status !== 'ended' && view.status !== 'at_camp') {
      // 2 回目以降の遠征の開始は 1 行（ルールは最初の遠征で説明済み。V3-2R3 §20.6）
      if (kind === 'start' && x.no > 1) lines.push(briefingShort(L, x, this.catalog.rules));
      else {
        lines.push(...briefingLines(L, x, this.catalog.rules));
        lines.push(t(L, `進捗: ${progressText(L, x, view.floor?.depth ?? null)}`, `Progress: ${progressText(L, x, view.floor?.depth ?? null)}`));
      }
      // 今いる階と、目的の階が上か下か（S1b §12.4 の 8: 目的の階と逆の階段へ向かった）
      // 2 回目以降の遠征は 1 行のまま（V3-2R3 §20.6）なので、その行に足す
      if (kind === 'start' && view.floor) {
        const here = view.floor.depth, to = x.objective.targetDepth;
        const way = to === null ? '' : to > here ? t(L, `（${to - here} 階下。下り階段から降りる）`, ` (${to - here} down: take the stairs down)`)
          : to < here ? t(L, `（${here - to} 階上。上り階段から上がる）`, ` (${here - to} up: take the stairs up)`) : t(L, '（この階）', ' (this floor)');
        const where = to === null
          ? t(L, `今いる階: 地下${here}階。`, `You are on depth ${here}.`)
          : t(L, `今いる階: 地下${here}階。目的の階: 地下${to}階${way}。`, `You are on depth ${here}. Objective floor: depth ${to}${way}.`);
        if (x.no > 1 && lines.length) lines[lines.length - 1] += (L === 'en' ? ' ' : '') + where;
        else lines.push(where);
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

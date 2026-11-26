// 観戦の画面の、行動ごとの 1 行と、場面の帯（S15。SEASON.md §68.2 の 2。HUMAN.md §3.3）。画面（Watch.tsx）から離した、決める所だけ（テストする: test/watchLines.test.ts）。
// - 命令ごとの 1 行: 「▶ （命令を、人の言葉で）: （結果の 1 文）」。命令の名前は MCP のツールの名前から言い換える（知らない名前は、そのまま）。
//   結果の 1 文は、AI の応答の文（呼び出しの知らせの text）の「結果:」の行（無ければ、最初の意味のある 1 行。断られた命令は「断られた: …」）。120 字で切る。
//   世界が動かない呼び出し（observe・get_rules・notes・wait_for_turn など）は、出さない。
//   メッセージの欄に、もう出ている出来事の文（被害・倒した など）は、結果の 1 文から除く（同じことを 2 回言わない）。
// - 場面の帯: 前の歩と、今の歩の見え方（PlayerView を縮めた BannerSnap）の違いから。遠征を始めた・階を移った・目的を達成した・帰還した・撤退した・
//   帰還の綱で戻った・倒れた。音は足さない（今ある合図のまま）。
// どちらも、見ている相手のプレイヤーに届いたもの（応答の文・見え方）だけから作る。届いていない情報は作らない
import type { Objective, PlayerView } from '@muse/shared';
import { objectiveText } from '@muse/shared';
import { getLocale, tr } from '../util';

// ---- 命令ごとの 1 行 ----

/** MCP のツールの名前 → 人の言葉（日・英）。world: 世界が動く命令か（false は出さない） */
const TOOLS: Record<string, { ja: string; en: string; world: boolean }> = {
  // 世界が動く命令
  move: { ja: '歩く', en: 'Step', world: true },
  wait: { ja: '待つ', en: 'Wait', world: true },
  rest: { ja: '休む', en: 'Rest', world: true },
  explore: { ja: '探索', en: 'Explore', world: true },
  travel_to: { ja: '移動', en: 'Travel', world: true },
  collect: { ja: '拾い集める', en: 'Collect', world: true },
  fight: { ja: '戦う', en: 'Fight', world: true },
  attack: { ja: '攻撃', en: 'Attack', world: true },
  use_ability: { ja: '能動技', en: 'Ability', world: true },
  report_stairs: { ja: '階段を知らせる', en: 'Report the stairs', world: true },
  place_fire: { ja: '野営の火を置く', en: 'Place a campfire', world: true },
  deposit_supply: { ja: '補給を預ける', en: 'Deposit supplies', world: true },
  take_supply: { ja: '補給を取る', en: 'Take supplies', world: true },
  choose_perk: { ja: '特技を選ぶ', en: 'Choose a perk', world: true },
  choose_boon: { ja: '加護を選ぶ', en: 'Choose a boon', world: true },
  pickup: { ja: '拾う', en: 'Pick up', world: true },
  drop: { ja: '置く', en: 'Drop', world: true },
  equip: { ja: '装備', en: 'Equip', world: true },
  unequip: { ja: '装備を外す', en: 'Unequip', world: true },
  use_item: { ja: '使う', en: 'Use', world: true },
  throw_item: { ja: '投げる', en: 'Throw', world: true },
  interact: { ja: '操作', en: 'Interact', world: true },
  use_stairs: { ja: '階段を使う', en: 'Use the stairs', world: true },
  start_expedition: { ja: '遠征を始める', en: 'Start the expedition', world: true },
  extract: { ja: '帰還', en: 'Extract', world: true },
  retire: { ja: '引退', en: 'Retire', world: true },
  // 世界が動かない呼び出し（出さない）
  observe: { ja: '観測', en: 'Observe', world: false },
  get_rules: { ja: '規則', en: 'Rules', world: false },
  notes: { ja: '覚え書き', en: 'Notes', world: false },
  wait_for_turn: { ja: '手番を待つ', en: 'Wait for the turn', world: false },
  look: { ja: '調べる', en: 'Look', world: false },
  get_map: { ja: '地図', en: 'Map', world: false },
  inventory: { ja: '持ち物', en: 'Inventory', world: false },
  recall: { ja: '思い出す', en: 'Recall', world: false },
  get_messages: { ja: 'メッセージ', en: 'Messages', world: false },
  expedition: { ja: '遠征', en: 'Expedition', world: false },
  review: { ja: '振り返り', en: 'Review', world: false },
  records: { ja: '記録', en: 'Records', world: false },
  profile: { ja: 'プロフィール', en: 'Profile', world: false },
  set_options: { ja: '設定', en: 'Options', world: false },
  list_runs: { ja: 'ランの一覧', en: 'List runs', world: false },
  new_run: { ja: '新しいラン', en: 'New run', world: false },
  join_run: { ja: 'ランに入る', en: 'Join a run', world: false },
  resume_run: { ja: 'ランに戻る', en: 'Resume a run', world: false },
  // 発言は、メッセージの欄に、もう出る（会話の行）
  say: { ja: '発言', en: 'Say', world: false },
};

/** その呼び出しを、命令の行に出すか（世界が動く命令と、知らない名前） */
export function isWorldTool(tool: string): boolean {
  return TOOLS[tool]?.world ?? true;
}

/** 命令の名前の言い換えの細かい所（届いた出来事から分かる帰り方: 帰還の綱・撤退） */
export interface ActFlags { returned?: 'extracted' | 'withdrew' | 'lifeline' | null }

/** 命令の名前（人の言葉）。知らない名前は、そのまま */
export function actionLabel(tool: string, flags: ActFlags = {}): string {
  if (tool === 'use_item' && flags.returned === 'lifeline') return tr('帰還の綱', 'Lifeline');
  if (tool === 'extract' && flags.returned === 'withdrew') return tr('撤退', 'Withdraw');
  const t = TOOLS[tool];
  if (!t) return tool;
  return tr(t.ja, t.en);
}

/** 結果の 1 文の長さ（字） */
export const ACT_RESULT_MAX = 120;

/** 結果の行の頭（日・英） */
const RESULT_RE = /^(?:結果|Result)\s*[:：]\s*/;
/** 断りの行（`エラー [code] …` / `Error [code] …`） */
const ERROR_RE = /^(?:エラー|Error)\s*\[[^\]]*\]\s*/;
/** 引数の形の断り（サーバーが記録に残す `bad_request …` の形。code は下線を含む小文字の語） */
const CODE_RE = /^[a-z]+(?:_[a-z]+)+\s+(?=\S)/;

/** 断りの文の最初の 1 文（「。」か「. 」まで） */
function firstSentence(s: string): string {
  const m = /^(.+?[。．]|.+?\.(?=\s|$))/.exec(s);
  return (m ? m[1] : s).trim();
}
/** マクロの結果の頭に付く命令の種類（`explore: 12 手進んだ…`） */
const CMD_PREFIX_RE = /^[a-z_]+:\s*/;

/** 文字数（コードポイント）で切る */
function cut(s: string, max: number): string {
  const cs = [...s];
  return cs.length > max ? `${cs.slice(0, max - 1).join('')}…` : s;
}

/**
 * 応答の文から、結果の 1 文。「結果:」で始まる行（無ければ、最初の意味のある 1 行）。断られた命令は「断られた: …」。
 * dup: メッセージの欄に、もう出ている（か、これから同じ歩で出る）出来事の文。結果の 1 文から除く（同じことを 2 回言わない）。
 * 除いて何も残らなければ null（命令の名前だけの行になる）
 */
export function actionResult(text: string | null | undefined, dup: readonly string[] = []): string | null {
  const lines = (text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (!lines.some((l) => RESULT_RE.test(l))) {
    const err = lines.find((l) => ERROR_RE.test(l));
    const msg = err ? err.replace(ERROR_RE, '') : CODE_RE.test(lines[0]) ? lines[0].replace(CODE_RE, '') : null;
    if (msg !== null) {
      const one = firstSentence(msg);
      return cut(tr(`断られた: ${one}`, `Refused: ${one}`), ACT_RESULT_MAX);
    }
  }
  const res = lines.find((l) => RESULT_RE.test(l));
  let s = (res ?? lines[0]).replace(RESULT_RE, '').replace(CMD_PREFIX_RE, '');
  // 出来事の文と同じ所を除く（長いものから。空白と句点を整える）
  for (const d of [...new Set(dup.map((x) => x.trim()).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length)) {
    if (s.includes(d)) s = s.split(d).join(' ');
  }
  s = s.replace(/\s+/g, ' ').replace(/^[\s。．.、,]+/, '').replace(/\s+([。．.、,])/g, '$1').trim();
  if (!s || /^[。．.、,\s]*$/.test(s)) return null;
  return cut(s, ACT_RESULT_MAX);
}

/** 命令の 1 行（「▶ 探索: 12 手進んだ。…」）。出さない呼び出しは null。who: 協力プレイで、だれの命令か（1 人なら省く） */
export function actionLine(x: { tool: string; text?: string | null; flags?: ActFlags; dup?: readonly string[]; who?: string | null }): string | null {
  if (!isWorldTool(x.tool)) return null;
  const label = actionLabel(x.tool, x.flags);
  const res = actionResult(x.text, x.dup);
  const head = x.who ? `▶ ${x.who}: ${label}` : `▶ ${label}`;
  return res ? `${head}: ${res}` : head;
}

/** 欄の行（命令の行を、seq の位置へ差し込むために要るもの） */
export interface SeqLine { seq: number }

/**
 * 命令の行を、その命令の出来事の文の上（seq の位置）へ差し込む。after: その命令の出来事は after より後。
 * 行の seq は after + 0.5（その命令の最初の出来事の文より前、前の命令の文より後）。後ろから探す（ふつうは、いちばん下か、その少し上）
 */
export function insertBySeq<T extends SeqLine>(lines: readonly T[], line: T): T[] {
  let i = lines.length;
  while (i > 0 && lines[i - 1].seq > line.seq) i--;
  return [...lines.slice(0, i), line, ...lines.slice(i)];
}

// ---- 場面の帯 ----

/** 帯の種類（見た目の色） */
export type BannerTone = 'start' | 'floor' | 'objective' | 'return' | 'withdraw' | 'lifeline' | 'death';
export interface SceneBanner { tone: BannerTone; text: string }

/** 帯を決めるのに使う、見え方の縮め（PlayerView から） */
export interface BannerSnap {
  where: 'camp' | 'dungeon' | 'dead' | 'ended';
  depth: number | null;
  exp: { no: number; status: string; objective: Objective; endReason: string | null } | null;
  banked: number;
}

export function bannerSnap(v: PlayerView): BannerSnap {
  const where: BannerSnap['where'] = v.status === 'dead' ? 'dead' : v.status === 'ended' || v.runStatus === 'ended' ? 'ended' : v.status === 'at_camp' ? 'camp' : 'dungeon';
  const x = v.expedition;
  return {
    where,
    depth: where === 'dungeon' ? v.floor?.depth ?? null : null,
    exp: x ? { no: x.no, status: x.status, objective: x.objective, endReason: x.endReason ?? x.result?.reason ?? null } : null,
    banked: v.record.banked,
  };
}

/** 確定した点の添え書き（増えていれば） */
function gainText(prev: BannerSnap, cur: BannerSnap): string {
  const g = cur.banked - prev.banked;
  return g > 0 ? tr(`（確定 +${g}）`, ` (banked +${g})`) : '';
}

/**
 * 前の歩と今の歩の見え方から、出す帯（順に）。prev が無い（つないだ最初・飛んだ後）ときは出さない。
 * 遠征を始めた（キャンプ → 迷宮）・階を移った（迷宮の中で深さが変わった）・目的を達成した（遠征の状態が達成に）・
 * 帰還した／撤退した／帰還の綱で戻った（迷宮 → キャンプ。遠征の終わり方から）・倒れた
 */
export function sceneBanners(prev: BannerSnap | null, cur: BannerSnap): SceneBanner[] {
  if (!prev) return [];
  const out: SceneBanner[] = [];
  const L = getLocale();
  if (cur.where === 'dead' && prev.where !== 'dead') return [{ tone: 'death', text: tr('倒れた', 'Fell') }];
  if (prev.where === 'camp' && cur.where === 'dungeon') {
    const x = cur.exp;
    out.push({ tone: 'start', text: x ? tr(`遠征 ${x.no} を始めた — ${objectiveText(L, x.objective)}`, `Expedition ${x.no} begins — ${objectiveText(L, x.objective)}`) : tr('遠征を始めた', 'The expedition begins') });
    return out;
  }
  if (prev.where !== 'dungeon') return out;
  const sameExp = !!prev.exp && !!cur.exp && prev.exp.no === cur.exp.no;
  const completedNow = sameExp && prev.exp!.status !== 'objective_complete' && (cur.exp!.status === 'objective_complete' || cur.exp!.endReason === 'completed');
  if (cur.where === 'dungeon') {
    if (prev.depth !== null && cur.depth !== null && cur.depth !== prev.depth) out.push({ tone: 'floor', text: tr(`地下 ${cur.depth} 階へ`, `Down to depth ${cur.depth}`) });
    if (completedNow) out.push({ tone: 'objective', text: tr('目的を達成した', 'Objective complete') });
    return out;
  }
  if (cur.where === 'camp') {
    // 達成と帰還が同じ歩（達成の歩を描く前に帰った）: 達成の帯を先に
    if (completedNow) out.push({ tone: 'objective', text: tr('目的を達成した', 'Objective complete') });
    const why = cur.exp?.endReason ?? null;
    const gain = gainText(prev, cur);
    if (why === 'completed') out.push({ tone: 'return', text: tr(`帰還した${gain}`, `Extracted${gain}`) });
    else if (why === 'withdrawn') out.push({ tone: 'withdraw', text: tr(`撤退した${gain}`, `Withdrew${gain}`) });
    else if (why === 'lifeline') out.push({ tone: 'lifeline', text: tr(`帰還の綱で戻った${gain}`, `Pulled back by the lifeline${gain}`) });
    else out.push({ tone: 'return', text: tr(`キャンプへ戻った${gain}`, `Back at camp${gain}`) });
  }
  return out;
}

/** 帯を出しておく長さ（ミリ秒） */
export const BANNER_MS = 2500;
/** 同時に重ねて出す帯の数 */
export const BANNER_MAX = 3;

/** 届いた出来事の、帰り方（命令の名前の言い換えに使う）。player: そのプレイヤー。キャンプへ戻った出来事の理由 */
export function returnedOf(events: readonly { type: string; player?: unknown; state?: unknown; reason?: unknown }[], player: string): ActFlags['returned'] {
  for (const e of events) {
    if (e.type !== 'player_state' || e.player !== player || e.state !== 'at_camp') continue;
    if (e.reason === 'lifeline' || e.reason === 'extracted' || e.reason === 'withdrew') return e.reason;
  }
  return null;
}

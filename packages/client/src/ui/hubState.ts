// 拠点の冒険者の札（S10。SEASON.md §58.4）: 冒険者の状態から、札の文・状態の札（ピル）・主のボタン 1 つを決める。画面から離した関数（テストする）。
// 中身は、持ち主の口の一覧の行（GET /api/owner/runs。AI の観測と同じ関数で作ったもの）と、プロフィールの招かれたシーズン（GET /api/profile の seasons）だけ。
import type { OwnerRunRow, ProfileSeasonEntry, SeasonListing } from '@muse/shared';
import { tr } from '../util';
import { aiPresenceText, undecidedLine } from './ownerCheck';

/** 札の状態（§58.4 の表の 6 つと、人間が自分で遊ぶ冒険者・招かれていない冒険者） */
export type HubCardState = 'not_joined' | 'not_invited' | 'camp_free' | 'camp_pending' | 'camp_ready' | 'dungeon' | 'over' | 'human';
/** 状態の札の色: amber 支度が「まだ」・green 準備完了・blue 迷宮の中・gold 印（希望）・muted ふつう */
export type HubTone = 'amber' | 'green' | 'blue' | 'gold' | 'muted';

/** 主のボタン: href へ移る、か dive（自分で潜る窓を開く） */
export interface HubAction { label: string; href?: string; dive?: true }

export interface HubCardModel {
  state: HubCardState;
  pill: { text: string; tone: HubTone };
  /** 今どこで何をしているか（1 文） */
  where: string;
  /** 札の文（§58.4 の表）。where と同じなら null */
  text: string | null;
  /** 補足（小さく薄く）: AI の行き来・決めていないもの */
  notes: string[];
  /** AI の希望が届いている */
  wish: boolean;
  /** 支度が「まだ」（目立たせる） */
  highlight: boolean;
  action: HubAction;
  stats: { level: number | null; banked: number; budget: { left: number; limit: number } | null; rank: number | null };
}

export interface HubCardInput {
  /** 冒険者の名前 */
  name: string;
  /** 札のシーズン（無ければシーズンの外） */
  season: Pick<SeasonListing, 'id' | 'status' | 'budget'> | null;
  /** そのシーズンの招き（GET /api/profile の seasons の 1 行）。null: 招かれていない。undefined: 分からない（運用者の札・読めなかった） */
  membership?: Pick<ProfileSeasonEntry, 'used' | 'budget' | 'died' | 'runs'> | null;
  /** そのシーズンの、続きのあるラン（持ち主の口の一覧の行）。無ければ null */
  row: OwnerRunRow | null;
  /** このブラウザに、そのランを遊ぶ鍵（プレイヤーのトークン）がある（人間が自分で遊ぶラン） */
  playable: boolean;
  /** 冒険賞の順位（順位の表から。無ければ null） */
  rank: number | null;
  /** 順位の表の確定点（ランが無いとき。無ければ 0） */
  banked?: number;
}

const depthText = (d: number | null) => (d !== null ? tr(`地下${d}階を進んでいる`, `Making their way through depth ${d}`) : tr('迷宮を進んでいる', 'Making their way through the dungeon'));

/** 札を決める（§58.4 の表） */
export function hubCard(x: HubCardInput): HubCardModel {
  const n = x.name;
  const row = x.row;
  const s = x.season;
  if (row) {
    const budget = row.budgetLeft !== undefined && row.budgetLimit !== undefined ? { left: Math.max(0, row.budgetLeft), limit: row.budgetLimit } : null;
    const stats = { level: row.level, banked: row.banked, budget, rank: x.rank };
    const base = { notes: [] as string[], wish: false, highlight: false, stats };
    const inDungeon = row.status === 'in_dungeon';
    // 人間が自分で遊ぶ冒険者: 指図は出さない。ボタンは「続きを遊ぶ」（このブラウザに遊ぶ鍵が無ければ、見守る）
    if (!row.eligible) {
      return {
        ...base, state: 'human',
        pill: inDungeon ? { text: tr('迷宮の中', 'In the dungeon'), tone: 'blue' } : { text: tr('あなたが遊ぶ', 'You play'), tone: 'muted' },
        where: inDungeon ? depthText(row.depth) : tr('キャンプにいる', 'At camp'),
        text: tr('あなたが、自分で遊んでいる冒険者', 'An adventurer you play yourself'),
        notes: x.playable ? [] : [tr('このブラウザでは、続きを遊べない（始めたブラウザで遊ぶ）', 'This browser cannot continue it (play it from the browser that started it)')],
        action: x.playable ? { label: tr('続きを遊ぶ', 'Continue'), href: `#/play/${row.runId}` } : { label: tr('見守る', 'Watch'), href: `#/watch/${row.runId}` },
      };
    }
    if (inDungeon) {
      return { ...base, state: 'dungeon', pill: { text: tr('迷宮の中', 'In the dungeon'), tone: 'blue' }, where: depthText(row.depth), text: null, action: { label: tr('見守る', 'Watch'), href: `#/watch/${row.runId}` } };
    }
    const result: HubAction = { label: tr('結果を見る', 'See the results'), href: s ? `#/season/${s.id}` : '#/records' };
    if (row.status === 'ended') {
      return { ...base, state: 'over', pill: { text: tr('終わった', 'Ended'), tone: 'muted' }, where: tr('この冒険は、終わった', 'This adventure has ended'), text: null, action: result };
    }
    const where = tr('キャンプにいる', 'At camp');
    // 予算切れ・シーズンの終わり（新しい遠征は始まらない）
    const over = s && s.status !== 'open' ? tr('シーズンが終わった。結果を待っている', 'The season is over. Waiting for the results')
      : budget && budget.left <= 0 ? tr(`このシーズンの手番を、使い切った。持ち帰った点 ${row.banked}`, `All of this season's turns are used. Points brought home: ${row.banked}`)
        : null;
    if (over) return { ...base, state: 'over', pill: { text: tr('終わり', 'Done'), tone: 'muted' }, where, text: over, action: result };
    const prepare: HubAction = { label: tr('支度をする', 'Prepare'), href: `#/prepare/${row.runId}` };
    const wish = (row.wishes ?? 0) > 0;
    const ai = aiPresenceText(row.ai);
    if (!row.hold.length) {
      return { ...base, state: 'camp_free', pill: { text: tr('任せている', 'Left to them'), tone: 'muted' }, where, text: tr(`次の遠征は、${n}が、自分で決めて出発する`, `${n} will choose the next expedition and set out on their own`), action: prepare };
    }
    if (row.prep?.state === 'ready') {
      return {
        ...base, state: 'camp_ready', wish, pill: { text: tr('準備完了', 'Ready'), tone: 'green' }, where,
        text: tr(`準備完了。${n}が来たら、出発する。AI に、声をかける`, `Ready. ${n} sets out when they come. Let your AI know`),
        notes: ai ? [ai] : [],
        action: { label: tr('支度を見直す', 'Review'), href: `#/prepare/${row.runId}` },
      };
    }
    const und = undecidedLine(row.undecided);
    return {
      ...base, state: 'camp_pending', wish, highlight: true, pill: { text: tr('支度: まだ', 'Not ready'), tone: 'amber' }, where,
      text: tr('あなたの支度を、待っている', 'Waiting for your preparations'),
      notes: [und, ai].filter((v): v is string => !!v),
      action: prepare,
    };
  }
  // ランが無い（まだ入っていない・前の冒険が終わった・招かれていない）
  const m = x.membership;
  const budget = m ? { left: Math.max(0, m.budget - m.used), limit: m.budget } : s ? { left: s.budget, limit: s.budget } : null;
  const stats = { level: null, banked: x.banked ?? 0, budget, rank: x.rank };
  const base = { notes: [] as string[], wish: false, highlight: false, stats };
  if (m === null || !s) {
    return {
      ...base, state: 'not_invited', pill: { text: tr('招かれていない', 'Not invited'), tone: 'muted' },
      where: tr('このシーズンには、まだ招かれていない', 'Not invited to this season yet'), text: tr('運用者に、招いてもらう', 'Ask the operator for an invitation'),
      action: { label: tr('記録を見る', 'Records'), href: '#/records' },
    };
  }
  const result: HubAction = { label: tr('結果を見る', 'See the results'), href: `#/season/${s.id}` };
  if (s.status !== 'open') {
    return { ...base, state: 'over', pill: { text: tr('終わり', 'Done'), tone: 'muted' }, where: tr('シーズンが終わった', 'The season is over'), text: null, action: result };
  }
  if (m && m.used >= m.budget) {
    return { ...base, state: 'over', pill: { text: tr('終わり', 'Done'), tone: 'muted' }, where: tr('このシーズンの手番を、使い切った', 'All of this season\'s turns are used'), text: null, action: result };
  }
  const where = m && m.runs > 0
    ? (m.died ? tr('前の冒険は、倒れて終わった', 'The last adventure ended in a fall') : tr('前の冒険は、終わった', 'The last adventure has ended'))
    : tr('まだ、このシーズンに入っていない', 'Not in this season yet');
  return {
    ...base, state: 'not_joined', pill: { text: tr('まだ入っていない', 'Not in yet'), tone: 'muted' }, where,
    text: tr('AI に、声をかける（AI が、鍵を使って入ってくる）。自分で潜ることもできる', 'Let your AI know (it comes in with the key). You can also go down yourself'),
    action: { label: tr('自分で潜る', 'Go down yourself'), dive: true },
  };
}

/**
 * 札のシーズン: 開催中のシーズン（current。開催中 → 終わりの時刻を過ぎた、の順に並べたもの）のうち、その冒険者のランがあるもの → 招かれている開催中のもの →
 * 招かれているもの → いちばん上のもの
 */
export function pickSeason<S extends Pick<SeasonListing, 'id' | 'status'>>(current: readonly S[], rows: readonly Pick<OwnerRunRow, 'season'>[], memberships: readonly Pick<ProfileSeasonEntry, 'id'>[] | undefined): S | null {
  return current.find((s) => rows.some((r) => r.season?.id === s.id))
    ?? current.find((s) => s.status === 'open' && memberships?.some((m) => m.id === s.id))
    ?? current.find((s) => memberships?.some((m) => m.id === s.id))
    ?? current[0] ?? null;
}

/** そのシーズンの招き。memberships が無ければ undefined（分からない）、招かれていなければ null */
export function membershipFor<M extends Pick<ProfileSeasonEntry, 'id'>>(memberships: readonly M[] | undefined, seasonId: string): M | null | undefined {
  if (!memberships) return undefined;
  return memberships.find((m) => m.id === seasonId) ?? null;
}

/** シーズンの残り（「あと 3 日」「あと 5 時間」「終わった」）。終わりの時刻の表示は呼ぶ側で足す */
export function seasonLeftText(s: Pick<SeasonListing, 'status' | 'endsAt'>, now: number): string {
  if (s.status === 'final') return tr('終わった（結果が出た）', 'Over (results are in)');
  const ms = s.endsAt - now;
  if (s.status === 'ended' || ms <= 0) return tr('終わりの時刻を過ぎた（結果を待っている）', 'Past its end (waiting for the results)');
  const d = Math.floor(ms / 86_400_000);
  if (d >= 1) return tr(`あと ${d} 日`, `${d} day${d > 1 ? 's' : ''} left`);
  const h = Math.floor(ms / 3_600_000);
  if (h >= 1) return tr(`あと ${h} 時間`, `${h} hour${h > 1 ? 's' : ''} left`);
  const mi = Math.max(1, Math.floor(ms / 60_000));
  return tr(`あと ${mi} 分`, `${mi} min left`);
}

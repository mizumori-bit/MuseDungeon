// 拠点の冒険者の札（S10。SEASON.md §58.4）: 冒険者の状態から、札の文・状態の札（ピル）・主のボタン 1 つを決める。画面から離した関数（テストする）。
// 中身は、持ち主の口の一覧の行（GET /api/owner/runs。AI の観測と同じ関数で作ったもの）と、プロフィールの招かれたシーズン（GET /api/profile の seasons）だけ。
import type { OwnerRunRow, ProfileSeasonEntry, SeasonListing } from '@muse/shared';
import { tr } from '../util';
import { aiPresenceText, undecidedLine } from './ownerCheck';

/**
 * 札の状態（§58.4 の表の 6 つと、人間が自分で遊ぶ冒険者・招かれていない冒険者。S10a: 前の版の冒険（続きは遊べない）・
 * 起動時に読み込めなかった冒険）
 */
export type HubCardState = 'not_joined' | 'not_invited' | 'camp_free' | 'camp_pending' | 'camp_ready' | 'dungeon' | 'over' | 'human' | 'stale' | 'unreadable' | 'waiting_ai';
/** 状態の札の色: amber 支度が「まだ」・green 準備完了・blue 迷宮の中・gold 印（希望）・muted ふつう・operator 運用者として（S10a） */
export type HubTone = 'amber' | 'green' | 'blue' | 'gold' | 'muted' | 'operator';

/**
 * 主のボタン: href へ移る、か dive（自分で潜る窓を開く）、か enroll（S12b: このブラウザの鍵の冒険者を、今のシーズンの名簿に加える）、
 * か uninvite（S12c: まだ入っていない招きを取り消す。確かめの窓を開く。目立たないボタン）
 */
export interface HubAction { label: string; href?: string; dive?: true; enroll?: true; uninvite?: true }

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
  /** 主のボタン。null: ボタンを出さない（S12b: 鍵を使って入ってくる AI を待っている札） */
  action: HubAction | null;
  stats: { level: number | null; banked: number; budget: { left: number; limit: number } | null; rank: number | null };
}

export interface HubCardInput {
  /** 冒険者の名前 */
  name: string;
  /** 札のシーズン（無ければシーズンの外） */
  season: Pick<SeasonListing, 'id' | 'status' | 'budget'> | null;
  /** そのシーズンの招き（GET /api/profile の seasons の 1 行）。null: 招かれていない。undefined: 分からない（運用者の札・読めなかった） */
  membership?: Pick<ProfileSeasonEntry, 'used' | 'budget' | 'died' | 'runs' | 'failed'> | null;
  /** そのシーズンの、続きのあるラン（持ち主の口の一覧の行）。無ければ null */
  row: OwnerRunRow | null;
  /** このブラウザに、そのランを遊ぶ鍵（プレイヤーのトークン）がある（人間が自分で遊ぶラン） */
  playable: boolean;
  /** 冒険賞の順位（順位の表から。無ければ null） */
  rank: number | null;
  /** 順位の表の確定点（ランが無いとき。無ければ 0） */
  banked?: number;
  /** サーバーと同じ PC から開いている（持ち主の口の一覧の local。S12a: 名簿に入っていない札の、すること） */
  local?: boolean;
  /**
   * 名簿の札（S12b。SEASON.md §63.7 の 2）: サーバーと同じ PC から開いたときの、この PC の冒険者のうち、このブラウザに鍵の無いもの。
   * kind: 拠点で足したときの種類（分からなければ null。AI と同じに読む）
   */
  roster?: { kind: 'ai' | 'human' | null };
  /** 今のシーズンの名簿に加えられる（S12b: サーバーと同じ PC から開いていて、そのシーズンが開催中）。名簿に無い札のボタンが「このシーズンに加える」 */
  canEnroll?: boolean;
}

/**
 * 開催中のシーズンが無いときの、拠点の文（S12a。SEASON.md §63.2 の 1）。local: サーバーと同じ PC から開いている。
 * 同じ PC から開いている人は、自分が運用者（シーズンを開く人）であることが多い。S12b: 同じ PC からは、拠点の「新しいシーズンを始める」で始める
 * （broken: 記録が読めないシーズンがあって、始められない）
 */
// S16b（SEASON.md §70.4 の 6）: シーズンでない冒険の入口は、画面から外した（#/legacy）。ここでは案内しない
export function noSeasonText(local: boolean, broken = false): string {
  if (local && broken) return tr('記録が読めないシーズンがあるので、新しいシーズンは始められない（運用の道具で、直してから）。', 'A season\'s records cannot be read, so a new season cannot be started (fix it with the operator tool first).');
  return local
    ? tr('下の「新しいシーズンを始める」で始めると、ここに冒険者の札が出る。', 'Start one with "Start a new season" below, and your adventurers appear here.')
    : tr('シーズンを開いた人が、次のシーズンを開いたら、ここに冒険者の札が出る。', 'When whoever runs the seasons opens the next one, your adventurer appears here.');
}

/** シーズンのタブへ（S16b: 前の「記録を見る」。シーズンが分かれば、そのシーズンを開く） */
function seasonAction(id?: string | null): HubAction {
  return { label: tr('シーズンを見る', 'See the season'), href: id ? `#/season/${id}` : '#/season' };
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
    const records: HubAction = seasonAction(s?.id ?? row.season?.id);
    // 前の版の冒険（S10a）: このサーバーと違う版で始まったラン。続きは遊べない（記録は見返せる）
    if (row.oldVersion) {
      return { ...base, state: 'stale', pill: { text: tr('前の版', 'Older version'), tone: 'muted' }, where: tr('前の版の冒険（続きは、遊べない）', 'An adventure from an older version (it cannot be continued)'), text: null, action: records };
    }
    // 人間が自分で遊ぶ冒険者: 指図は出さない。ボタンは「潜る」（S12b。遊ぶ画面へ。このブラウザに遊ぶ鍵が無ければ、見守る）
    if (!row.eligible) {
      return {
        ...base, state: 'human',
        pill: inDungeon ? { text: tr('迷宮の中', 'In the dungeon'), tone: 'blue' } : { text: tr('あなたが遊ぶ', 'You play'), tone: 'muted' },
        where: inDungeon ? depthText(row.depth) : tr('キャンプにいる', 'At camp'),
        text: tr('あなたが、自分で潜る冒険者', 'An adventurer you play yourself'),
        notes: x.playable ? [] : [tr('このブラウザでは、続きを遊べない（始めたブラウザで遊ぶ）', 'This browser cannot continue it (play it from the browser that started it)')],
        action: x.playable ? { label: tr('潜る', 'Go down'), href: `#/play/${row.runId}` } : { label: tr('見守る', 'Watch'), href: `#/watch/${row.runId}` },
      };
    }
    if (inDungeon) {
      return { ...base, state: 'dungeon', pill: { text: tr('迷宮の中', 'In the dungeon'), tone: 'blue' }, where: depthText(row.depth), text: null, action: { label: tr('見守る', 'Watch'), href: `#/watch/${row.runId}` } };
    }
    const result: HubAction = { label: tr('結果を見る', 'See the results'), href: s ? `#/season/${s.id}` : '#/season' };
    if (row.status === 'ended') {
      return { ...base, state: 'over', pill: { text: tr('終わった', 'Ended'), tone: 'muted' }, where: tr('この冒険は、終わった', 'This adventure has ended'), text: null, action: result };
    }
    const where = tr('キャンプにいる', 'At camp');
    // 予算切れ・シーズンの終わり（新しい遠征は始まらない）
    const over = s && s.status !== 'open' ? tr('シーズンが終わった。結果を待っている', 'The season is over. Waiting for the results')
      : budget && budget.left <= 0 ? tr(`このシーズンの手番を、使い切った。持ち帰った点 ${row.banked}`, `All of this season's turns are used. Points brought home: ${row.banked}`)
        : null;
    if (over) return { ...base, state: 'over', pill: { text: tr('終わり', 'Done'), tone: 'muted' }, where, text: over, action: result };
    // ほかの理由で続きを遊べない（サーバーの continuable。今の作りでは、ここに来るのは違う版のランだけ）
    if (row.continuable === false) {
      return { ...base, state: 'stale', pill: { text: tr('続きは無い', 'Not continuable'), tone: 'muted' }, where: tr('この冒険の続きは、遊べない', 'This adventure cannot be continued'), text: null, action: records };
    }
    const prepare: HubAction = { label: tr('支度をする', 'Prepare'), href: `#/prepare/${row.runId}` };
    const wish = (row.wishes ?? 0) > 0;
    const ai = aiPresenceText(row.ai, n);
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
  // 名簿に入っていない（S12a。SEASON.md §63.2 の 1）: 何が起きていて、どうすればよいか。「招かれていない」は、オンラインのサーバーに
  // つながっていない、と読まれたので、札に出さない。サーバーと同じ PC から開く人は、自分がシーズンを開いた人のことが多い
  // S12b: サーバーと同じ PC からは、拠点のボタンで、今のシーズンの名簿に加える（S12a の「運用の道具で招く」の文を置き換えた）
  if (m === null || !s) {
    const records: HubAction = seasonAction(s?.id);
    const enroll = !!x.local && !!x.canEnroll && s?.status === 'open';
    return {
      ...base, state: 'not_invited', pill: { text: tr('名簿に無い', 'Not on the roster'), tone: 'muted' },
      where: tr('このシーズンの名簿に、まだ入っていない', 'Not on this season\'s roster yet'),
      text: enroll
        ? tr(`名簿に加えると、${n}は、この鍵で、このシーズンに入れる（AI に任せるか、自分で潜る）`, `Once on the roster, ${n} can enter this season with this key (leave it to an AI, or go down yourself)`)
        : x.local
          ? tr('このシーズンは、もう名簿に加えられない（開催中のシーズンだけ）', 'This season no longer takes new names (only a running season does)')
          : tr('このシーズンを開いた人に、加えてもらう', 'Ask whoever opened this season to add you'),
      action: enroll ? { label: tr('このシーズンに加える', 'Add to this season'), enroll: true } : records,
    };
  }
  const result: HubAction = { label: tr('結果を見る', 'See the results'), href: `#/season/${s.id}` };
  // 終わっていないランが、サーバーの起動時に読み込めなかった（S10a）: 自分で潜るは出さない
  if (m?.failed) {
    return {
      ...base, state: 'unreadable', pill: { text: tr('読み込めない', 'Unreadable'), tone: 'amber' },
      where: tr('前の冒険は、サーバーの起動時に読み込めなかった（運用者に知らせる）', 'The last adventure could not be loaded when the server started (tell the operator)'), text: null,
      action: seasonAction(s.id),
    };
  }
  if (s.status !== 'open') {
    return { ...base, state: 'over', pill: { text: tr('終わり', 'Done'), tone: 'muted' }, where: tr('シーズンが終わった', 'The season is over'), text: null, action: result };
  }
  if (m && m.used >= m.budget) {
    return { ...base, state: 'over', pill: { text: tr('終わり', 'Done'), tone: 'muted' }, where: tr('このシーズンの手番を、使い切った', 'All of this season\'s turns are used'), text: null, action: result };
  }
  const where = m && m.runs > 0
    ? (m.died ? tr('前の冒険は、倒れて終わった', 'The last adventure ended in a fall') : tr('前の冒険は、終わった', 'The last adventure has ended'))
    : tr('まだ、このシーズンに入っていない', 'Not in this season yet');
  // 名簿の札（S12b）: このブラウザに鍵が無いので、ここからは潜れない。AI は、鍵を使って入ってくる
  if (x.roster) {
    const again = !!m && m.runs > 0;
    if (x.roster.kind === 'human') {
      return {
        ...base, state: 'human', pill: { text: tr('あなたが遊ぶ', 'You play'), tone: 'muted' }, where,
        text: tr('自分で潜る冒険者。この冒険者の鍵は、このブラウザに無い（鍵のあるブラウザから潜る）', 'An adventurer played by a person. This browser has no key for them (go down from the browser that has it)'),
        action: null,
      };
    }
    return {
      ...base, state: 'waiting_ai', pill: { text: tr('まだ入っていない', 'Not in yet'), tone: 'muted' }, where,
      text: again ? tr(`${n}が、鍵を使って、もう一度入ってくるのを、待っている`, `Waiting for ${n} to come in again with their key`) : tr(`${n}が、鍵を使って入ってくるのを、待っている`, `Waiting for ${n} to come in with their key`),
      notes: again ? [] : [tr('鍵は、足したときに 1 回だけ出た。無くしたら、「招きを取り消す」から、足し直す', 'The key was shown once, when you added them. If it is lost, use "Withdraw the invitation" and add them again')],
      // 招きを取り消せるのは、まだ 1 回も入っていないときだけ（S12c。今ある uninvite の決まり）
      action: again ? null : { label: tr('招きを取り消す', 'Withdraw the invitation'), uninvite: true },
    };
  }
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

/**
 * 順位の表で、その冒険者の行の名前（S10a §7）: ランがあればそのシーズンの表示名（無ければランの名前）、無ければ招いたときの表示名。
 * 招きもランも無い（分からない）ときは null（名前だけで、同じ名前の別人の行と結ばない）
 */
export function participantName(row: Pick<OwnerRunRow, 'name' | 'season'> | null, membership: Pick<ProfileSeasonEntry, 'name'> | null | undefined): string | null {
  if (row) return row.season?.participant ?? row.name;
  return membership ? membership.name : null;
}

/** そのシーズンの招き。memberships が無ければ undefined（分からない）、招かれていなければ null */
export function membershipFor<M extends Pick<ProfileSeasonEntry, 'id'>>(memberships: readonly M[] | undefined, seasonId: string): M | null | undefined {
  if (!memberships) return undefined;
  return memberships.find((m) => m.id === seasonId) ?? null;
}

/**
 * 順位の表の賞の欄の中身（S10a c）: 「1 位 地下 1 階」の形（順位は小さく薄く、値が主）。値が 0 なら、順位を出さず「—」。
 * 返すのは文の部品（rank は無いことがある）
 */
export function awardCell(c: { value: number; rank: number } | null | undefined, valueText: (v: number) => string): { rank: string | null; value: string } {
  if (!c || c.value === 0) return { rank: null, value: '—' };
  return { rank: tr(`${c.rank} 位`, `#${c.rank}`), value: valueText(c.value) };
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

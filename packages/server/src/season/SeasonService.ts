// シーズン（S0。SEASON.md §2・PROTOCOL.md §9）: 同じシードの個別ダンジョン＋共有層。World の外にあり、サーバーが seasons/<id>/ に持つ。
// ランに入るのは、キャンプでの取り込み（システムの命令 season_sync）だけ。ここはその中身を作り、ランの出来事から参加者の記録を書き直す。
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonStable, writeFileAtomicLogged } from '../log/atomicWrite';
import type {
  GameEvent, PlayerId, SeasonAward, SeasonListing, SeasonResultView, SeasonSectionRow, SeasonSlay, SeasonStandingRow, SeasonStandingsResponse, SeasonSyncCommand, SeasonTitle, SupplyPlace,
} from '@muse/shared';
import { awardName, SeasonSlaySchema } from '@muse/shared';
import type { RunSession } from '../session/RunSession';
import type { ProfileStore } from '../session/profiles';
import { buildSlays } from './slays';
import type { SlayFacts } from './slays';

/** シーズンの定義（運用者が開く。season.json） */
export interface SeasonDef {
  id: string;
  name: string;
  seed: string;
  /** 開いたときの版（サーバーの版と違えば、シーズンのランは始められない） */
  engineVersion: string;
  contentVersion: string;
  /** 参加者 1 人の行動予算（自分の手番） */
  budget: number;
  /** 終わりの時刻（ミリ秒） */
  endsAt: number;
  openedAt: number;
}

/** firesSeen（S1a）: そのランの火の使用（fire_used）のうち、記録（log.jsonl）に書いた数。数える処理はやり直しても同じ（火ごとの users で 1 人 1 回） */
export interface SeasonRunRec { runId: string; startedAt: number; turns: number; deepest: number; banked: number; died: boolean; ended: boolean; firesSeen?: number }

export interface Participant {
  profileId: string;
  name: string;
  joinedAt: number;
  runs: SeasonRunRec[];
  /** シーズンで着いたいちばん深い階と、初めて着いたときまでに使った予算 */
  best: { depth: number; used: number };
  /** 最初に報告した数（階段と特別な場所。S1c §14.5）と、最後の 1 つを報告したときまでに使った予算 */
  firstReports: number;
  lastFirstUsed: number;
  died: boolean;
  /**
   * 公開の値（S2a §20.10 の 2）: その参加者が最後にキャンプに着いた時点（か、ランが終わった時点）の最深・使った予算・倒れたか・確定点・ランの数。
   * 順位の表・断面・ほかの参加者の取り込みの写しは、これを使う（外との出入りはキャンプでだけ。§1.2 の 2）。無ければ（S2 より前の記録）今の値
   */
  shown?: ShownValues;
}

export interface ShownValues { best: { depth: number; used: number }; used: number; died: boolean; banked: number; runs: number }

/** 招いた者（S0a。SEASON.md §4.1）。invites.json は運用の道具だけが書き、サーバーは読むだけ。トークンは入れない */
export interface SeasonInvite { profileId: string; name: string; invitedAt: number }

/** 表示名の比べ方（前後の空白を除き、全角と半角・大文字と小文字を区別しない） */
export function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export interface PublicStairsRec { depth: number; x: number; y: number; by: string; profileId: string; runId: string; used: number; wall: number; order: number }

/** 公開された特別な場所（S1c §14.5。spots.json）: 祭壇・賭けの祭壇・碑文のうち、部屋の作りに組み込まれたもの。最初に報告した者 */
export interface PublicSpotRec { depth: number; x: number; y: number; kind: string; by: string; profileId: string; runId: string; used: number; wall: number; order: number }

/**
 * 共有層の野営の火（S1。PROTOCOL §9.10。fires.json）。used: 載せたときまでに置いた者が使った予算、
 * uses: 支援賞に数えた回数、users: 数えた参加者（1 つの火で 1 人 1 回）
 */
export interface PublicFireRec {
  order: number; depth: number; x: number; y: number; by: string; profileId: string; runId: string; used: number; wall: number; uses: number; users: string[];
  /** 同じマスの取り合いで載らなかった火（S1a §10.1 の 5）: ほかの者には渡さず、置いた者の火としてだけ数える（上限・自分の使用を支援に数えない） */
  dup?: boolean;
}

/**
 * 共有層の補給の品（S3。SEASON.md §25.2。supplies.json）。id は 's<order>'。runId・n は預けたランと、そのランの通し番号（同じ品を 2 回載せない）。
 * takenBy: 最初に取ってキャンプに着いた参加者（支援賞に数えるのは、預けた者でないときだけ）。doubles: その後に、同じ品を取ってキャンプに着いた参加者（世界は別々なので、両方の手元に残る。数えない）
 */
export interface PublicSupplyRec {
  order: number; id: string; depth: number; x: number; y: number; place: SupplyPlace; kind: string; identified: boolean;
  by: string; profileId: string; runId: string; n: number; used: number; wall: number;
  takenBy?: string; takenRun?: string; takenUsed?: number; takenWall?: number; doubles?: string[];
}

/** 称号の記録（S2 §18.2。result.json の titles）。profileId は HTTP に出さない */
export interface SeasonTitleRec extends SeasonTitle { profileId: string; holder: string }

export interface SeasonResult {
  finalizedAt: number;
  reason: 'all_back' | 'grace_over' | 'operator';
  winners: Record<SeasonAward['id'], { name: string; value: number }[]>;
  standings: SeasonStandingRow[];
  /** 称号（S2 §18.2）。S2 より前の結果には無い */
  titles?: SeasonTitleRec[];
  /** 節目の大守護者の初討伐（S2 §18.2。深さの順） */
  deeds?: { depth: number; name: string; profileId: string }[];
}

/**
 * 節目の大守護者の初討伐（S2 §18.2。deeds.json）: その階の大守護者を倒した後に、最初にキャンプへ着いた参加者（§1.2 の 2: 外との出入りはキャンプでだけ）。
 * 1 つの階に 1 人。used はキャンプに着いたときまでに使った予算
 */
export interface SeasonDeedRec { depth: number; profileId: string; name: string; runId: string; used: number; wall: number; order: number }

/**
 * 討伐の記録（S4。SEASON.md §35.5。slays.json）: 節目の大守護者を倒した参加者の、その戦いの事実（そのランの出来事の記録から作る）。
 * 載せた順に order。runId と depth で同じ記録を 2 回載せない。name は招いたときの表示名、budgetUsed は載せたときまでに使った予算
 */
export interface SeasonSlayRec extends SlayFacts { order: number; profileId: string; runId: string; name: string; budgetUsed: number; wall: number }

/** 称号の定義（content の seasonTitles と同じ形。サーバーと運用の道具が渡す） */
export interface SeasonTitleDefLite { id: string; kind: 'award' | 'first_warden'; award?: SeasonAward['id']; name: { ja: string; en: string } }

interface SeasonData {
  def: SeasonDef;
  participants: Participant[];
  public: PublicStairsRec[];
  /** 公開された特別な場所（S1c §14.5） */
  spots: PublicSpotRec[];
  fires: PublicFireRec[];
  /** 節目の大守護者の初討伐（S2 §18.2） */
  deeds: SeasonDeedRec[];
  /** 補給の置き場の品（S3 §25.2） */
  supplies: PublicSupplyRec[];
  /** 討伐の記録（S4 §35.5） */
  slays: SeasonSlayRec[];
  result: SeasonResult | null;
}

const AWARD_IDS = ['adventure', 'contribution', 'survival', 'support'] as const;
/** 称号を付けるのに要る、ランを始めた参加者の数（S2 §18.2） */
export const TITLE_MIN_ENTRANTS = 2;

/** 終わりの時刻の後、全員がキャンプに戻らなくても、この時間で確定する（SEASON.md §2.1） */
export const SEASON_GRACE_MS = 60 * 60 * 1000;
export const SEASON_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** 読めないファイルの印（無いファイルの null と分ける。SEASON.md §33.1 の 4） */
const BROKEN: unique symbol = Symbol('broken');
const isObj = (v: unknown): boolean => !!v && typeof v === 'object' && !Array.isArray(v);

const used = (p: Participant) => p.runs.reduce((a, r) => a + r.turns, 0);
/** 順位に数える参加者（1 回でもランを始めた者。招いただけの者は入れない） */
const started = (ps: readonly Participant[]) => ps.filter((p) => p.runs.length > 0);
const banked = (p: Participant) => p.runs.reduce((a, r) => a + r.banked, 0);
/** 今の値（内部。予算の残り・同着の決め方の元） */
export function liveShown(p: Participant): ShownValues {
  return { best: { ...p.best }, used: used(p), died: p.died, banked: banked(p), runs: p.runs.length };
}
/** 公開の値（キャンプに着いた時点の写し。無ければ今の値） */
const shownOf = (p: Participant): ShownValues => p.shown ?? liveShown(p);

/**
 * 支援の数は、火ごとの記録（fires.json の uses）から作る（S1a §10.1 の 4: 参加者ごとの数を別に持たない）。
 * S3 §25.2: 自分の預けた補給の品を、ほかの参加者が取った数（supplies.json の takenBy。二重に取られた品は 1 人分）を足す
 */
const supportOf = (fires: readonly PublicFireRec[], supplies: readonly PublicSupplyRec[] = []) => (p: Participant) =>
  fires.reduce((a, f) => a + (!f.dup && f.profileId === p.profileId ? f.uses : 0), 0)
  + supplies.filter((x) => x.profileId === p.profileId && x.takenBy && x.takenBy !== p.profileId).length;

/** 値の大きい順、同着は使った予算の少ない順。値も予算も同じなら同じ順位（1, 2, 2, 4） */
function ranked<T>(items: T[], value: (x: T) => number, tie: (x: T) => number): Map<T, number> {
  const sorted = [...items].sort((a, b) => value(b) - value(a) || tie(a) - tie(b));
  const out = new Map<T, number>();
  sorted.forEach((x, i) => {
    const prev = sorted[i - 1];
    out.set(x, prev && value(prev) === value(x) && tie(prev) === tie(x) ? out.get(prev)! : i + 1);
  });
  return out;
}

/** 3 つの賞の順位（PROTOCOL §9.5） */
export function computeStandings(ps: readonly Participant[], fires: readonly PublicFireRec[] = [], supplies: readonly PublicSupplyRec[] = []): {
  rows: SeasonStandingRow[];
  award: (p: Participant, id: SeasonAward['id']) => SeasonAward;
} {
  const list = [...ps];
  // 公開の値で数える（S2a §20.10 の 2）。報告と支援は、もともとキャンプでだけ動く
  const sv = new Map(list.map((p) => [p, shownOf(p)]));
  const S = (p: Participant) => sv.get(p) ?? shownOf(p);
  const used = (p: Participant) => S(p).used;
  const banked = (p: Participant) => S(p).banked;
  const adv = ranked(list, (p) => S(p).best.depth, (p) => S(p).best.used);
  const con = ranked(list, (p) => p.firstReports, (p) => (p.firstReports ? p.lastFirstUsed : 0));
  const alive = list.filter((p) => !S(p).died);
  const sur = ranked(alive, (p) => banked(p), (p) => used(p));
  const leaderOf = (m: Map<Participant, number>, value: (p: Participant) => number) => {
    const top = [...m.entries()].filter(([, r]) => r === 1).map(([p]) => p);
    // 1 位が並んだら、先に参加した者を名前に出す
    const first = top.sort((a, b) => list.indexOf(a) - list.indexOf(b))[0];
    return first ? { name: first.name, value: value(first) } : null;
  };
  const advLead = leaderOf(adv, (p) => S(p).best.depth);
  const conLead = leaderOf(con, (p) => p.firstReports);
  const surLead = leaderOf(sur, (p) => banked(p));
  // 支援賞（S1 §8.5）: 自分の火が使われた回数（S3: と、預けた品が取られた数）。同着は使った予算の少ないほう
  const support = supportOf(fires, supplies);
  const sup = ranked(list, (p) => support(p), (p) => used(p));
  const supLead = leaderOf(sup, (p) => support(p));
  const rows: SeasonStandingRow[] = list.map((p) => ({
    name: p.name, runs: S(p).runs, used: used(p), died: S(p).died,
    adventure: { value: S(p).best.depth, rank: adv.get(p)! },
    contribution: { value: p.firstReports, rank: con.get(p)! },
    survival: S(p).died ? null : { value: banked(p), rank: sur.get(p)! },
    support: { value: support(p), rank: sup.get(p)! },
    banked: banked(p),
  })).sort((a, b) => a.adventure.rank - b.adventure.rank || a.name.localeCompare(b.name));
  const award = (p: Participant, id: SeasonAward['id']): SeasonAward => {
    if (id === 'support') return { id, value: support(p), rank: sup.get(p) ?? null, entrants: list.length, leader: supLead, gap: supLead ? supLead.value - support(p) : null };
    if (id === 'adventure') return { id, value: S(p).best.depth, rank: adv.get(p) ?? null, entrants: list.length, leader: advLead, gap: advLead ? advLead.value - S(p).best.depth : null };
    if (id === 'contribution') return { id, value: p.firstReports, rank: con.get(p) ?? null, entrants: list.length, leader: conLead, gap: conLead ? conLead.value - p.firstReports : null };
    if (S(p).died) return { id, value: null, rank: null, entrants: alive.length, leader: surLead, gap: null };
    return { id, value: banked(p), rank: sur.get(p) ?? null, entrants: alive.length, leader: surLead, gap: surLead ? surLead.value - banked(p) : null };
  };
  return { rows, award };
}

/** シーズンの記録の置き場所（dir が null ならメモリだけ。テスト用） */
export class SeasonStore {
  private readonly data = new Map<string, SeasonData>();
  /** dir が null のとき（テスト）の招いた者 */
  private readonly memInvites = new Map<string, SeasonInvite[]>();

  constructor(readonly dir: string | null) {}

  private path(id: string, file: string): string { return join(this.dir!, id, file); }

  /** 読めなかったシーズンと、そのファイル（SEASON.md §33.1 の 4。読まず、書き戻さない） */
  private readonly brokenFiles = new Map<string, string[]>();

  /** 一時的に読めなかったファイル（ほかのプログラムが開いていた。§36.1 の 2）。読めない理由の文に添える */
  private lastUnreadable = new Set<string>();

  /**
   * 無ければ null。あるのに読めない・形が違えば BROKEN（BOM は外して読む。一時的に読めなければ、少し待って読み直してから。§36.1 の 2）。
   * 一時的に読めなかったものは lastUnreadable に覚える（壊れているとは書かない。次に読むときにまた試す）
   */
  private readJson<T>(id: string, file: string, shape: (v: unknown) => boolean = () => true): T | null | typeof BROKEN {
    if (!this.dir) return null;
    const p = this.path(id, file);
    const r = readJsonStable<T>(p, shape);
    if ('missing' in r) return null;
    if ('value' in r) { this.lastUnreadable.delete(p); return r.value; }
    if ('unreadable' in r) this.lastUnreadable.add(p); else this.lastUnreadable.delete(p);
    return BROKEN;
  }

  /** 書き切ってから名前を替える（§33.1 の 1）。書けなければ知らせて false（前の中身のまま。次の書き込みでまた試す）。読めないシーズンには書かない */
  private writeJson(id: string, file: string, v: unknown): boolean {
    if (!this.dir) return true;
    if (this.brokenFiles.has(id)) { console.error(`[season] シーズン ${id} の記録が読めないので、${file} を書かなかった`); return false; }
    const d = join(this.dir, id);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    return writeFileAtomicLogged(join(d, file), JSON.stringify(v, null, 1));
  }

  /** 読めなかったファイルの名前（一時的に読めなかったものは、そう添える） */
  private fileLabel(id: string, file: string): string {
    return this.lastUnreadable.has(this.path(id, file)) ? `${file}（一時的に読めない。ほかのプログラムが開いている）` : file;
  }

  /** 読めなかったシーズン（起動時に知らせる。そのシーズンのランは、復旧に失敗したランとして出す） */
  broken(): { id: string; files: string[] }[] {
    for (const id of this.ids()) this.get(id);
    return [...this.brokenFiles].map(([id, files]) => ({ id, files })).sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  isBroken(id: string): boolean {
    this.get(id);
    return this.brokenFiles.has(id);
  }

  /** そのシーズン（知らない ID はディスクを読み直す。動いているサーバーで、後から開いたシーズン） */
  get(id: string): SeasonData | null {
    const have = this.data.get(id);
    if (have) {
      // 確定は 1 回だけ（S2a §20.10 の 1）: 運用の道具（別のプロセス）が確定して result.json を書いていれば、それを確定済みとして使う（上書きしない）
      if (!have.result && this.dir) {
        const r = this.readJson<SeasonResult>(id, 'result.json', isObj);
        // result.json が読めない: 「確定していない」と見ない（確定し直して上書きしない。§36.1 の 6）。そのシーズンを読まず、書かない
        if (r === BROKEN) {
          this.brokenFiles.set(id, [this.fileLabel(id, 'result.json')]);
          this.data.delete(id);
          return null;
        }
        if (r) {
          have.result = r;
          // 確定した側の参加者の記録（公開の値を含む）も読み直す（S2b: 古い写しで断面を作らない・書き戻さない）
          const ps = this.readJson<Participant[]>(id, 'participants.json', Array.isArray);
          if (ps && ps !== BROKEN) have.participants = ps;
        }
      }
      return have;
    }
    if (!SEASON_ID_RE.test(id)) return null;
    // 1 つでも読めないファイルがあれば、そのシーズンは読まない（空として読むと、次に書くときに中身を消してしまう。§33.1 の 4）
    const bad: string[] = [];
    const read = <T>(file: string, shape: (v: unknown) => boolean): T | null => {
      const v = this.readJson<T>(id, file, shape);
      if (v === BROKEN) { bad.push(this.fileLabel(id, file)); return null; }
      return v;
    };
    const def = read<SeasonDef>('season.json', (v) => isObj(v) && typeof (v as SeasonDef).id === 'string' && typeof (v as SeasonDef).seed === 'string');
    const d = {
      participants: read<Participant[]>('participants.json', Array.isArray) ?? [],
      public: read<PublicStairsRec[]>('public.json', Array.isArray) ?? [],
      spots: read<PublicSpotRec[]>('spots.json', Array.isArray) ?? [],
      fires: read<PublicFireRec[]>('fires.json', Array.isArray) ?? [],
      deeds: read<SeasonDeedRec[]>('deeds.json', Array.isArray) ?? [],
      supplies: read<PublicSupplyRec[]>('supplies.json', Array.isArray) ?? [],
      slays: read<SeasonSlayRec[]>('slays.json', Array.isArray) ?? [],
      result: read<SeasonResult>('result.json', isObj),
    };
    if (bad.length) { this.brokenFiles.set(id, bad); return null; }
    this.brokenFiles.delete(id);
    if (!def) return null;
    const out: SeasonData = { def, ...d };
    this.data.set(id, out);
    return out;
  }

  /** 開いているシーズンの ID（ディスクにあるものも） */
  ids(): string[] {
    const out = new Set(this.data.keys());
    if (this.dir && existsSync(this.dir)) for (const f of readdirSync(this.dir)) if (SEASON_ID_RE.test(f) && existsSync(join(this.dir, f, 'season.json'))) out.add(f);
    return [...out].sort();
  }

  /** シーズンを開く（運用者。CLI とテスト） */
  open(def: SeasonDef): SeasonData {
    if (!SEASON_ID_RE.test(def.id)) throw new Error(`bad season id ${def.id} (a-z 0-9 _ -, up to 32)`);
    // 読めないシーズン（§33.1）も「ある」と数える（上書きして消さない）
    if (this.get(def.id) || (this.dir && existsSync(this.path(def.id, 'season.json')))) throw new Error(`season ${def.id} already exists`);
    const d: SeasonData = { def, participants: [], public: [], spots: [], fires: [], deeds: [], supplies: [], slays: [], result: null };
    if (!this.writeJson(def.id, 'season.json', def)) throw new Error(`season ${def.id}: season.json を書けなかった`);
    this.data.set(def.id, d);
    this.log(def.id, { type: 'opened', def });
    return d;
  }

  /** 招いた者（毎回ファイルから読む。書くのは運用の道具だけで、動いているサーバーは読み直すだけ）。読めなければ空（だれも始められない。§33.1） */
  invites(id: string): SeasonInvite[] {
    const v = this.invitesOrBroken(id);
    return v === BROKEN ? [] : v;
  }

  /** invites.json が読めないか（§33.1 の 4: 読めないまま足すと、ほかの招きを消してしまう） */
  invitesBroken(id: string): boolean {
    return this.invitesOrBroken(id) === BROKEN;
  }

  private invitesOrBroken(id: string): SeasonInvite[] | typeof BROKEN {
    if (!this.dir) return [...(this.memInvites.get(id) ?? [])];
    return this.readJson<SeasonInvite[]>(id, 'invites.json', Array.isArray) ?? [];
  }

  /** 招いた者を足す（運用の道具。サーバーは呼ばない）。invites.json が読めない・書けなければ例外（前の中身のまま） */
  addInvite(id: string, inv: SeasonInvite): void {
    if (this.invitesBroken(id)) throw new Error(`シーズン ${id} の invites.json が読めない。直してから招く / invites.json of season ${id} is unreadable`);
    const list = [...this.invites(id), inv];
    if (!this.dir) { this.memInvites.set(id, list); return; }
    if (!this.writeJson(id, 'invites.json', list)) throw new Error(`シーズン ${id} の invites.json を書けなかった`);
  }

  /** 招いた者を外す（運用の道具。S0b §6.2 の 5）。外したら true */
  removeInvite(id: string, profileId: string): boolean {
    if (this.invitesBroken(id)) throw new Error(`シーズン ${id} の invites.json が読めない。直してから取り消す / invites.json of season ${id} is unreadable`);
    const list = this.invites(id);
    const next = list.filter((x) => x.profileId !== profileId);
    if (next.length === list.length) return false;
    if (!this.dir) { this.memInvites.set(id, next); return true; }
    if (!this.writeJson(id, 'invites.json', next)) throw new Error(`シーズン ${id} の invites.json を書けなかった`);
    return true;
  }

  saveParticipants(d: SeasonData): void { this.writeJson(d.def.id, 'participants.json', d.participants); }
  savePublic(d: SeasonData): void { this.writeJson(d.def.id, 'public.json', d.public); }
  saveSpots(d: SeasonData): void { this.writeJson(d.def.id, 'spots.json', d.spots); }
  saveFires(d: SeasonData): void { this.writeJson(d.def.id, 'fires.json', d.fires); }
  saveDeeds(d: SeasonData): void { this.writeJson(d.def.id, 'deeds.json', d.deeds); }
  saveSupplies(d: SeasonData): void { this.writeJson(d.def.id, 'supplies.json', d.supplies); }
  saveSlays(d: SeasonData): void { this.writeJson(d.def.id, 'slays.json', d.slays); }
  saveResult(d: SeasonData): void { this.writeJson(d.def.id, 'result.json', d.result); }

  log(id: string, rec: Record<string, unknown>): void {
    if (!this.dir) return;
    const d = join(this.dir, id);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    appendFileSync(join(d, 'log.jsonl'), JSON.stringify({ wall: Date.now(), ...rec }) + '\n');
  }
}

export interface SeasonReportResult { stairs: { depth: number; x: number; y: number; first: boolean }[]; spots?: { depth: number; x: number; y: number; kind: string; first: boolean }[] }

/** ランが今どうなっているか（SessionManager が答える）。null は動いていない（終わった・復旧していない） */
export type LiveRunState = 'in_dungeon' | 'at_camp' | 'ended' | null;

/** RunSession が呼ぶ口（SessionDeps.season） */
export interface SeasonHooks {
  /** その参加者の、今の取り込みの中身（予算の残り・公開された階段・順位の写し） */
  sync(session: RunSession, pid: PlayerId): SeasonSyncCommand['season'] | null;
  /** 階段と特別な場所（S1c §14.5）の報告: サーバーに届いた順で、最初の報告かを決めて残す */
  report(session: RunSession, pid: PlayerId, stairs: readonly { depth: number; x: number; y: number }[], spots?: readonly { depth: number; x: number; y: number; kind: string }[]): SeasonReportResult | null;
  onCommit(session: RunSession, events: readonly GameEvent[]): void;
}

export class SeasonService implements SeasonHooks {
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly dirty = new Set<string>();

  constructor(
    readonly store: SeasonStore,
    readonly versions: { engineVersion: string; contentVersion: string },
    private readonly liveRun: (runId: string) => LiveRunState = () => null,
    private readonly now: () => number = Date.now,
    /** 支援賞に数える使用の戻りの下限（最大 HP の %。balance.season.supportMinHealPct） */
    private readonly supportMinHealPct = 10,
    /** 称号の定義（S2 §18.2。content の seasonTitles）。無ければ賞の名前から作る */
    private readonly titleDefs: readonly SeasonTitleDefLite[] = [],
  ) {}

  status(d: SeasonData): SeasonListing['status'] {
    if (d.result) return 'final';
    return this.now() >= d.def.endsAt ? 'ended' : 'open';
  }

  list(): SeasonListing[] {
    return this.store.ids().map((id) => this.store.get(id)).filter((d): d is SeasonData => !!d).map((d) => this.listing(d));
  }

  private listing(d: SeasonData): SeasonListing {
    return { id: d.def.id, name: d.def.name, budget: d.def.budget, endsAt: d.def.endsAt, status: this.status(d), participants: started(d.participants).length, invited: this.store.invites(d.def.id).length };
  }

  /**
   * 招く（S0a。SEASON.md §4.1。運用の道具から）: token を渡せば今あるプロフィールを、無ければその表示名で新しいプロフィールを作って招く。
   * 新しく作ったときだけトークンを返す（表示はこの 1 回だけ）。表示名はそのシーズンの中で重ならないこと
   */
  invite(id: string, name: string, profiles: ProfileStore, token?: string): { profileId: string; name: string; token?: string } | { error: string } {
    const d = this.store.get(id);
    if (!d && this.store.isBroken(id)) return { error: `シーズン ${id} の記録が読めない（起動時の記録か season -- list で、どのファイルかを見る） / the records of season ${id} are unreadable` };
    if (!d) return { error: `シーズン ${id} は無い / no such season` };
    if (d.result) return { error: `シーズン ${id} は確定している / season ${id} is final` };
    if (this.store.invitesBroken(id)) return { error: `シーズン ${id} の invites.json が読めない。直してから / invites.json of season ${id} is unreadable` };
    const existing = token ? profiles.resolve(token) : null;
    if (token && !existing) return { error: 'そのプロフィールのトークンは見つからない / unknown profile token' };
    const display = (name || existing?.name || '').normalize('NFKC').trim().slice(0, 32);
    if (!display) return { error: '--name が要る（表示名。同じシーズンの中で重ならないこと） / --name is required' };
    const invites = this.store.invites(id);
    if (invites.some((x) => nameKey(x.name) === nameKey(display))) return { error: `表示名「${display}」は、このシーズンですでに使われている / the display name is taken in this season` };
    if (existing && invites.some((x) => x.profileId === existing.id)) return { error: `そのプロフィール（${existing.id}）は、もう招いてある / already invited` };
    const now = this.now();
    let profileId: string;
    let newToken: string | undefined;
    if (existing) profileId = existing.id;
    else { const c = profiles.create(display, now); profileId = c.profile.id; newToken = c.token; }
    this.store.addInvite(id, { profileId, name: display, invitedAt: now });
    this.store.log(id, { type: 'invited', profileId, name: display, newProfile: !existing });
    return { profileId, name: display, ...(newToken ? { token: newToken } : {}) };
  }

  /**
   * 招きを取り消す（S0b。SEASON.md §6.2 の 5。運用の道具から）: ランを 1 回も始めていない者だけ。
   * 表示名（招いたときの比べ方と同じ）かプロフィールの ID で指す。プロフィールそのものは消さない（シーズンに入れなくなるだけ）
   */
  uninvite(id: string, by: { name?: string; profileId?: string }): { profileId: string; name: string } | { error: string } {
    const d = this.store.get(id);
    if (!d && this.store.isBroken(id)) return { error: `シーズン ${id} の記録が読めない（起動時の記録か season -- list で、どのファイルかを見る） / the records of season ${id} are unreadable` };
    if (!d) return { error: `シーズン ${id} は無い / no such season` };
    if (d.result) return { error: `シーズン ${id} は確定している / season ${id} is final` };
    if (this.store.invitesBroken(id)) return { error: `シーズン ${id} の invites.json が読めない。直してから / invites.json of season ${id} is unreadable` };
    if (!by.name && !by.profileId) return { error: '--name（招いたときの表示名）か --profile（プロフィールの ID）が要る。一覧は season -- invites --id <id> / --name or --profile is required' };
    const invites = this.store.invites(id);
    const inv = by.profileId ? invites.find((x) => x.profileId === by.profileId) : invites.find((x) => nameKey(x.name) === nameKey(by.name!));
    if (!inv) return { error: `${by.profileId ? `プロフィール ${by.profileId}` : `表示名「${by.name}」`}は、シーズン ${id} に招かれていない（一覧は season -- invites --id ${id}） / not invited` };
    const runs = this.participant(d, inv.profileId)?.runs.length ?? 0;
    if (runs > 0) return { error: `「${inv.name}」（${inv.profileId}）は、このシーズンのランを ${runs} 回始めている。ランを始めた者の招きは取り消せない（順位と予算の記録が残るため） / already started ${runs} run(s); cannot uninvite` };
    this.store.removeInvite(id, inv.profileId);
    this.store.log(id, { type: 'uninvited', profileId: inv.profileId, name: inv.name });
    return { profileId: inv.profileId, name: inv.name };
  }

  get(id: string): SeasonData | null { return this.store.get(id); }

  private participant(d: SeasonData, profileId: string | null): Participant | null {
    return profileId ? d.participants.find((p) => p.profileId === profileId) ?? null : null;
  }

  /** 新しいランを始められるか（PROTOCOL §9.1）。理由の文を返す（日本語 / 英語）。招かれたプロフィールだけ（S0a §4.1） */
  canStart(id: string, profileId: string | null): { def: SeasonDef; name: string } | { reason: string } {
    const d = this.store.get(id);
    if (!d && this.store.isBroken(id)) return { reason: `シーズン ${id} の記録が読めない。運用者に知らせる / the records of season ${id} are unreadable; tell the operator` };
    if (!d) return { reason: `そのシーズンは無い / no such season: ${id}` };
    if (!profileId) return { reason: `シーズンのランには profile_token が要る（運用者から受け取った、このシーズンに招かれたプロフィールのもの） / a season run needs the profile_token the operator gave you` };
    if (this.store.invitesBroken(id)) return { reason: `シーズン ${id} の招いた者の記録（invites.json）が読めない。運用者に知らせる / invites.json of season ${id} is unreadable; tell the operator` };
    const inv = this.store.invites(id).find((x) => x.profileId === profileId);
    if (!inv) return { reason: `このプロフィール（${profileId}）は、シーズン ${id} に招かれていない。参加するには、運用者に招いてもらう / this profile is not invited to season ${id}; ask the operator to invite you` };
    if (this.status(d) !== 'open') return { reason: `シーズン ${id} は終わっている / season ${id} has ended` };
    if (d.def.engineVersion !== this.versions.engineVersion || d.def.contentVersion !== this.versions.contentVersion) {
      return { reason: `シーズン ${id} は版 engine ${d.def.engineVersion}・content ${d.def.contentVersion} で開かれた。このサーバーは engine ${this.versions.engineVersion}・content ${this.versions.contentVersion} / version mismatch` };
    }
    const p = this.participant(d, profileId);
    if (p) {
      if (used(p) >= d.def.budget) return { reason: `このシーズンの行動予算（${d.def.budget} 手番）を使い切っている / budget used up` };
      const live = p.runs.find((r) => !r.ended && this.liveRun(r.runId) !== null && this.liveRun(r.runId) !== 'ended');
      if (live) return { reason: `進行中のシーズンのラン ${live.runId} がある。resume_run で続けるか、retire で終えてから / a season run is in progress: ${live.runId}` };
    }
    return { def: d.def, name: inv.name };
  }

  /** 参加者に新しいランを足す（その参加者がいなければ、ここで参加） */
  registerRun(id: string, profileId: string, name: string, runId: string): void {
    const d = this.store.get(id);
    // 始めてよいかを見た後（canStart）に、ほかのプロセスで確定していたら、足さない（S2b）
    if (!d || d.result) return;
    let p = this.participant(d, profileId);
    const wall = this.now();
    if (!p) {
      p = { profileId, name: name.slice(0, 32) || 'Muse', joinedAt: wall, runs: [], best: { depth: 1, used: 0 }, firstReports: 0, lastFirstUsed: 0, died: false };
      d.participants.push(p);
      this.store.log(id, { type: 'joined', profileId, name: p.name });
    }
    p.runs.push({ runId, startedAt: wall, turns: 0, deepest: 1, banked: 0, died: false, ended: false });
    // 参加はキャンプから（公開の値を今の値にする。S2a §20.10 の 2）
    p.shown = liveShown(p);
    this.store.log(id, { type: 'run_started', profileId, runId, used: used(p) });
    this.store.saveParticipants(d);
  }

  private find(session: RunSession, pid: PlayerId): { d: SeasonData; p: Participant; run: SeasonRunRec } | null {
    const sid = session.world.meta.season?.id;
    const d = sid ? this.store.get(sid) : null;
    const p = d ? this.participant(d, session.profileOf(pid)) : null;
    const run = p?.runs.find((r) => r.runId === session.runId);
    return d && p && run ? { d, p, run } : null;
  }

  sync(session: RunSession, pid: PlayerId): SeasonSyncCommand['season'] | null {
    const f = this.find(session, pid);
    if (!f) return null;
    const { d, p } = f;
    this.refresh(session, pid, f);
    const st = computeStandings(started(d.participants), d.fires, d.supplies);
    const nameOf = (profileId: string) => d.participants.find((q) => q.profileId === profileId)?.name ?? '?';
    return {
      id: d.def.id, name: d.def.name,
      budget: { limit: d.def.budget, left: d.def.budget - used(p) },
      ends_at: d.def.endsAt, ended: this.status(d) !== 'open',
      public: [...d.public].sort((a, b) => a.depth - b.depth).map((x) => ({ depth: x.depth, x: x.x, y: x.y, by: x.by })),
      // 特別な場所（S1c §14.5）: 報告の順
      spots: [...d.spots].sort((a, b) => a.order - b.order).map((x) => ({ depth: x.depth, x: x.x, y: x.y, kind: x.kind, by: x.by })),
      awards: (['adventure', 'contribution', 'survival', 'support'] as const).map((id) => st.award(p, id)),
      contribution: p.firstReports, died: p.died,
      // 野営の火（S1 §9.10）: 共有層の火（載せた順）。自分の火には mine と、支援賞に数えた回数
      // 取り合いで載らなかった火（dup）は、置いた者にだけ渡す（自分の火として数える）
      // users（S1c §14.4 の 7）: 自分の火を使った（支援賞に数えた）参加者の表示名（数えた順）
      fires: [...d.fires].filter((f) => !f.dup || f.profileId === p.profileId).sort((a, b) => a.order - b.order)
        .map((f) => ({ depth: f.depth, x: f.x, y: f.y, by: f.by, ...(f.profileId === p.profileId ? { mine: true, uses: f.uses, ...(f.dup ? { dup: true } : {}), ...(f.users.length ? { users: f.users.map((id) => d.participants.find((q) => q.profileId === id)?.name ?? '?') } : {}) } : {}) })),
      self: p.name,
      // 補給の置き場（S3 §25.2）: 共有層の品のうち、まだだれも取っていないもの（載せた順）。このランで預けた品には、そのランの番号 n
      supplies: d.supplies.filter((x) => !x.takenBy).sort((a, b) => a.order - b.order).map((x) => ({
        id: x.id, depth: x.depth, x: x.x, y: x.y, place: x.place, kind: x.kind, identified: x.identified, by: x.by,
        ...(x.profileId === p.profileId ? { mine: true } : {}), ...(x.runId === session.runId ? { n: x.n } : {}),
      })),
      // このランで預けた品のうち、もう載ったものの番号（取られて supplies から消えた後も、自分の世界の写しと重ねない）
      deposits_published: d.supplies.filter((x) => x.runId === session.runId).map((x) => x.n).sort((a, b) => a - b),
      // 自分の預けた品を、ほかの参加者が取ったもの（キャンプの知らせ。engine が前の写しと比べる）
      mine_taken: d.supplies.filter((x) => x.profileId === p.profileId && x.takenBy && x.takenBy !== p.profileId).sort((a, b) => a.order - b.order)
        .map((x) => ({ id: x.id, depth: x.depth, x: x.x, y: x.y, place: x.place, kind: x.kind, identified: x.identified, taker: nameOf(x.takenBy!) })),
      // 討伐の記録（S4 §35.5）: 節目ごとに、最初の 1 件といちばん少ない被害の 1 件（自分の記録には mine）
      ...((): { slays?: SeasonSlay[] } => { const s = slaysView(d.slays, p.profileId); return s.length ? { slays: s } : {}; })(),
    };
  }

  report(session: RunSession, pid: PlayerId, stairs: readonly { depth: number; x: number; y: number }[], spots: readonly { depth: number; x: number; y: number; kind: string }[] = []): SeasonReportResult | null {
    const f = this.find(session, pid);
    if (!f || f.d.result) return null;
    const { d, p } = f;
    this.refresh(session, pid, f);
    const out: { depth: number; x: number; y: number; first: boolean }[] = [];
    let gained = 0;
    for (const s of stairs) {
      const first = !d.public.some((x) => x.depth === s.depth);
      if (first) {
        d.public.push({ depth: s.depth, x: s.x, y: s.y, by: p.name, profileId: p.profileId, runId: session.runId, used: used(p), wall: this.now(), order: d.public.length + 1 });
        gained++;
      }
      out.push({ ...s, first });
    }
    // 特別な場所（S1c §14.5）: その階のそのマスを最初に報告した者に貢献 1（階段と同じ数え方）
    const outSpots: { depth: number; x: number; y: number; kind: string; first: boolean }[] = [];
    for (const s of spots) {
      const first = !d.spots.some((x) => x.depth === s.depth && x.x === s.x && x.y === s.y);
      if (first) {
        d.spots.push({ depth: s.depth, x: s.x, y: s.y, kind: s.kind, by: p.name, profileId: p.profileId, runId: session.runId, used: used(p), wall: this.now(), order: d.spots.length + 1 });
        gained++;
      }
      outSpots.push({ ...s, first });
    }
    if (gained) { p.firstReports += gained; p.lastFirstUsed = used(p); }
    this.store.log(d.def.id, { type: 'reported', profileId: p.profileId, runId: session.runId, used: used(p), stairs: out, ...(outSpots.length ? { spots: outSpots } : {}) });
    if (out.length) this.store.savePublic(d);
    if (outSpots.length) this.store.saveSpots(d);
    this.store.saveParticipants(d);
    return { stairs: out, ...(outSpots.length ? { spots: outSpots } : {}) };
  }

  /** ランの今の状態を参加者の記録に写す。大事な変化があれば true */
  private refresh(session: RunSession, pid: PlayerId, f: { d: SeasonData; p: Participant; run: SeasonRunRec }): boolean {
    const { d, p, run } = f;
    if (d.result) return false;
    const w = session.world;
    const pr = w.players[pid];
    if (!pr) return false;
    const turns = w.entities[pr.entityId]?.actor?.turns ?? run.turns;
    const died = pr.state === 'dead';
    const ended = died || pr.state === 'left' || w.status === 'ended';
    const changed = turns !== run.turns;
    let big = false;
    run.turns = turns;
    if (pr.stats.deepest > run.deepest) run.deepest = pr.stats.deepest;
    if ((pr.stats.banked ?? 0) !== run.banked) { run.banked = pr.stats.banked ?? 0; big = true; }
    if (died && !run.died) { run.died = true; p.died = true; big = true; this.store.log(d.def.id, { type: 'died', profileId: p.profileId, runId: run.runId, used: used(p), cause: pr.stats.deathCause }); }
    if (ended && !run.ended) { run.ended = true; big = true; this.store.log(d.def.id, { type: 'run_ended', profileId: p.profileId, runId: run.runId, used: used(p), died }); }
    if (run.deepest > p.best.depth) {
      p.best = { depth: run.deepest, used: used(p) };
      big = true;
      this.store.log(d.def.id, { type: 'deepest', profileId: p.profileId, runId: run.runId, depth: run.deepest, used: p.best.used });
    }
    // 公開の値は、キャンプにいるか、ランが終わったときだけ今の値にする（S2a §20.10 の 2）
    if ((pr.state === 'at_camp' || ended) && JSON.stringify(p.shown) !== JSON.stringify(liveShown(p))) { p.shown = liveShown(p); big = true; }
    if (big) this.store.saveParticipants(d);
    else if (changed) this.markDirty(d);
    return big;
  }

  private markDirty(d: SeasonData): void {
    this.dirty.add(d.def.id);
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 2000);
    this.saveTimer.unref?.();
  }

  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    // 確定したシーズンは書かない（S2b: ほかのプロセスが確定した後に、保存待ちの古い写しで上書きしない）
    for (const id of this.dirty) { const d = this.store.get(id); if (d && !d.result) this.store.saveParticipants(d); }
    this.dirty.clear();
  }

  onCommit(session: RunSession, events: readonly GameEvent[]): void {
    if (!session.world.meta.season) return;
    for (const pid of session.world.playerOrder) {
      const f = this.find(session, pid);
      if (!f) continue;
      const big = this.refresh(session, pid, f);
      // 野営の火（S1 §8.4・§8.5。S1a §10.1 の 1）: キャンプに着いた・ランが終わったコミットで、このランで置いた火を載せ、このランの火の使用をまとめて数える
      const arrived = events.some((e) => e.type === 'expedition_ended' || e.type === 'run_ended' || (e.type === 'player_state' && e.player === pid));
      const fires = arrived && this.isHome(session, pid) ? this.settleFires(session, pid, f) : false;
      // 節目の大守護者の初討伐（S2 §18.2）: 倒した後にキャンプへ着いた順
      if (arrived) this.recordDeeds(session, pid, f);
      if (big || fires) this.store.saveParticipants(f.d);
      if (big || events.some((e) => e.type === 'expedition_ended' || e.type === 'run_ended')) this.tick();
    }
  }

  /** キャンプにいるか、ランが終わったか（外との出入りの時機。§1.2 の 2） */
  private isHome(session: RunSession, pid: PlayerId): boolean {
    const pr = session.world.players[pid];
    return !!pr && (pr.state === 'at_camp' || pr.state === 'dead' || pr.state === 'left' || session.world.status === 'ended');
  }

  /** 載せて数える（キャンプに着いたとき・ランが終わったとき・起動し直して復旧したとき）。変わったら true */
  private settleFires(session: RunSession, pid: PlayerId, f: { d: SeasonData; p: Participant; run: SeasonRunRec }): boolean {
    const published = this.publishFires(f.d, f.p, session);
    const counted = this.countFireUses(f.d, f.p, f.run, session, pid);
    // 補給の置き場（S3 §25.2）も、同じ時機（キャンプに着いたとき・ランが終わったとき・復旧のとき）
    const supplies = this.settleSupplies(f.d, f.p, session);
    // 討伐の記録（S4 §35.5）も、同じ時機（倒した者がキャンプに着いたとき・帰る前に倒れてもランが終わったとき・復旧のとき）
    const slays = this.settleSlays(f.d, f.p, session, pid);
    return published > 0 || counted || supplies || slays;
  }

  /**
   * 討伐の記録（S4。SEASON.md §35.5）: このランで倒した節目の大守護者のうち、まだ載っていないもの（runId と深さで見る）を、そのランの出来事の記録から作って載せる。
   * やり直しても同じ（載せたかは runId と depth で決まる）。変わったら true
   */
  private settleSlays(d: SeasonData, p: Participant, session: RunSession, pid: PlayerId): boolean {
    if (d.result) return false;
    const done = new Set(d.slays.filter((x) => x.runId === session.runId).map((x) => x.depth));
    // 畳み始めは、まだ載っていない最初の討伐より前（境目のキーフレームがあれば、それより前の最後の境目から）
    const first = session.history.find((e) => e.type === 'warden_slain' && !done.has(e.depth));
    if (!first) return false;
    let facts: SlayFacts[];
    try {
      facts = buildSlays(session.history, session.foldBase(first.seq), pid, session.world, done);
    } catch (err) {
      console.error(`[season] ${session.runId} の討伐の記録を作れなかった: ${(err as Error).message}`);
      return false;
    }
    let n = 0;
    for (const f of facts) {
      const rec: SeasonSlayRec = { ...f, order: d.slays.length + 1, profileId: p.profileId, runId: session.runId, name: p.name, budgetUsed: used(p), wall: this.now() };
      d.slays.push(rec);
      this.store.log(d.def.id, { type: 'warden_record', profileId: p.profileId, runId: session.runId, depth: rec.depth, order: rec.order, used: rec.budgetUsed, taken: rec.taken, attempt: rec.attempt });
      n++;
    }
    if (n) this.store.saveSlays(d);
    return n > 0;
  }

  /**
   * 補給の置き場（S3。SEASON.md §25.2）: このランで預けた品（SeasonState.deposited）のうち、まだ載っていない・取り返していないものを共有層へ載せ、
   * このランで取った共有層の品（SeasonState.taken の 's<番号>'）を、取られたことにする（先に着いた 1 人が takenBy。後から着いた者は doubles。両方の手元に残る）。
   * やり直しても同じ（載せたかは runId と n、取ったかは takenBy・doubles で決まる）。変わったら true
   */
  private settleSupplies(d: SeasonData, p: Participant, session: RunSession): boolean {
    if (d.result) return false;
    const s = session.world.season;
    if (!s) return false;
    let changed = false;
    const taken = new Set((s.taken ?? []).map((x) => x.id));
    for (const dep of s.deposited ?? []) {
      if (d.supplies.some((x) => x.runId === session.runId && x.n === dep.n)) continue;
      // 載せる前に自分で取り返した品は、もう置き場に無い
      if (taken.has(`l${dep.n}`)) continue;
      const order = d.supplies.length + 1;
      const rec: PublicSupplyRec = { order, id: `s${order}`, depth: dep.depth, x: dep.x, y: dep.y, place: dep.place, kind: dep.kind, identified: dep.identified, by: p.name, profileId: p.profileId, runId: session.runId, n: dep.n, used: used(p), wall: this.now() };
      d.supplies.push(rec);
      this.store.log(d.def.id, { type: 'supply_published', profileId: p.profileId, runId: session.runId, id: rec.id, depth: rec.depth, x: rec.x, y: rec.y, place: rec.place, kind: rec.kind, identified: rec.identified });
      changed = true;
    }
    for (const tk of s.taken ?? []) {
      if (!tk.id.startsWith('s')) continue;
      const rec = d.supplies.find((x) => x.id === tk.id);
      if (!rec || rec.takenBy === p.profileId || rec.doubles?.includes(p.profileId)) continue;
      if (!rec.takenBy) {
        rec.takenBy = p.profileId; rec.takenRun = session.runId; rec.takenUsed = used(p); rec.takenWall = this.now();
        this.store.log(d.def.id, { type: 'supply_taken', profileId: p.profileId, runId: session.runId, id: rec.id, holder: rec.profileId, counted: rec.profileId !== p.profileId });
      } else {
        // 二重に取られた（世界は別々なので、両方の手元に残る）。支援賞は先に着いた 1 人の分だけ
        rec.doubles = [...(rec.doubles ?? []), p.profileId];
        this.store.log(d.def.id, { type: 'supply_double', profileId: p.profileId, runId: session.runId, id: rec.id, holder: rec.profileId, first: rec.takenBy });
      }
      changed = true;
    }
    if (changed) this.store.saveSupplies(d);
    return changed;
  }

  /**
   * 起動し直して復旧したラン（S1a §10.1 の 4）: キャンプにいるかランが終わっていれば、載せて数え直す。
   * 数える処理はやり直しても同じなので、記録を書いた後・保存の前に落ちた使用も、ここで数えられる
   */
  onRecovered(session: RunSession): void {
    if (!session.world.meta.season) return;
    for (const pid of session.world.playerOrder) {
      const f = this.find(session, pid);
      if (!f) continue;
      this.refresh(session, pid, f);
      if (this.isHome(session, pid) && this.settleFires(session, pid, f)) this.store.saveParticipants(f.d);
      this.recordDeeds(session, pid, f);
    }
  }

  /**
   * 節目の大守護者の初討伐（S2 §18.2）: キャンプにいる参加者のランで倒した節目の階（milestones.cleared）のうち、
   * まだだれの記録にも無い階を、その参加者の偉業にする（「最初」は倒した後にキャンプへ着いた順。倒れて帰れなかった討伐は数えない）
   */
  private recordDeeds(session: RunSession, pid: PlayerId, f: { d: SeasonData; p: Participant; run: SeasonRunRec }): void {
    const { d, p } = f;
    if (d.result || session.world.players[pid]?.state !== 'at_camp') return;
    // 討伐の後にキャンプへ着いた時刻（S2a §20.10 の 4: ランの記録から。起動し直した後でも、記録の順と時刻で決まる）
    const arrived = new Map<number, number>();
    const pending = new Set<number>();
    for (const e of session.history) {
      if (e.type === 'warden_slain') { if (!arrived.has(e.depth)) pending.add(e.depth); }
      else if (e.type === 'player_state' && e.player === pid && e.state === 'at_camp' && pending.size) {
        for (const dep of pending) arrived.set(dep, e.wall);
        pending.clear();
      }
    }
    let n = 0;
    for (const depth of session.world.milestones?.cleared ?? []) {
      const at = { wall: arrived.get(depth) ?? this.now() };
      const cur = d.deeds.find((x) => x.depth === depth);
      if (cur && (cur.profileId === p.profileId || cur.wall <= at.wall)) continue;
      const rec: SeasonDeedRec = { depth, profileId: p.profileId, name: p.name, runId: session.runId, used: used(p), wall: at.wall, order: 0 };
      if (cur) d.deeds[d.deeds.indexOf(cur)] = rec; else d.deeds.push(rec);
      this.store.log(d.def.id, { type: 'first_warden', profileId: p.profileId, runId: session.runId, depth, used: rec.used, arrivedAt: at.wall, ...(cur ? { replaced: cur.profileId } : {}) });
      n++;
    }
    if (n) {
      [...d.deeds].sort((a, b) => a.wall - b.wall).forEach((x, i) => { x.order = i + 1; });
      this.store.saveDeeds(d);
    }
  }

  /** 開いているシーズンのうち、版（engine・コンテンツ）がこのサーバーと違うもの（S1a: 起動時の警告） */
  /** 記録のファイルが読めないシーズン（SEASON.md §33.1 の 4。起動時に知らせる） */
  brokenSeasons(): { id: string; files: string[] }[] {
    return this.store.broken();
  }

  isBroken(id: string): boolean {
    return this.store.isBroken(id);
  }

  versionWarnings(): string[] {
    const out: string[] = [];
    for (const id of this.store.ids()) {
      const d = this.store.get(id);
      if (!d || this.status(d) !== 'open') continue;
      if (d.def.engineVersion === this.versions.engineVersion && d.def.contentVersion === this.versions.contentVersion) continue;
      out.push(`シーズン ${id}「${d.def.name}」は版 engine ${d.def.engineVersion}・content ${d.def.contentVersion} で開かれた。このサーバーは engine ${this.versions.engineVersion}・content ${this.versions.contentVersion}。このシーズンでは新しいランを始められない（進行中のランは続けられるが、記録の再生と版が合わない）。シーズンの間は版を変えない（SEASON.md §2.1） / season ${id} was opened on another version; new runs cannot start`);
    }
    return out;
  }

  /**
   * このランで置いた火（SeasonState.placed）のうち、まだ載っていないものを共有層へ載せる（S1 §8.4: キャンプに着いたとき・ランが終わったとき）。
   * 同じマスにほかの者の火がもう載っていれば載せない（fire_duplicate。費用は戻らない）。載せた数を返す
   */
  private publishFires(d: SeasonData, p: Participant, session: RunSession): number {
    if (d.result) return 0;
    const placed = session.world.season?.placed ?? [];
    let n = 0;
    for (const pl of placed) {
      const at = d.fires.filter((x) => x.depth === pl.depth && x.x === pl.x && x.y === pl.y);
      if (at.some((x) => x.profileId === p.profileId)) continue;
      // 同じマスにほかの者の火がもう載っている: ほかの者には渡さないが、置いた者の火として残す（dup。S1a §10.1 の 5。費用は戻らない）
      const dup = at.length > 0;
      const rec: PublicFireRec = { order: d.fires.length + 1, depth: pl.depth, x: pl.x, y: pl.y, by: p.name, profileId: p.profileId, runId: session.runId, used: used(p), wall: this.now(), uses: 0, users: [], ...(dup ? { dup: true } : {}) };
      d.fires.push(rec);
      this.store.log(d.def.id, dup
        ? { type: 'fire_duplicate', profileId: p.profileId, runId: session.runId, depth: pl.depth, x: pl.x, y: pl.y, holder: at[0].profileId, order: rec.order }
        : { type: 'fire_published', profileId: p.profileId, runId: session.runId, depth: pl.depth, x: pl.x, y: pl.y, order: rec.order });
      n++;
    }
    if (n) this.store.saveFires(d);
    return n;
  }

  /**
   * 火が使われた（S1 §8.5・S1c §14.3 の 5）: 置いた本人でない・その参加者がその火で数えられるのはシーズンを通して 1 回・
   * 「使った」は、最大 HP の supportMinHealPct% 以上が戻った（fire_used）か、その火から帰還・撤退した（fire_return の done）、
   * をすべて満たす使用だけを、火を置いた参加者の支援賞に数える。数えた数を返す
   */
  private countFireUses(d: SeasonData, user: Participant, run: SeasonRunRec, session: RunSession, pid: PlayerId): boolean {
    if (d.result) return false;
    // そのランの火の使用をすべて見る（やり直しても同じ: 数えたかどうかは火ごとの users で決まる）。記録の順のまま（firesSeen は、その順で記録に書いた数）
    // 火から帰った使用は、その帰還・撤退で確定した点が 1 以上のときだけ数える（S1d §17.5: 何も持たずに、ほかの者の火の隣で撤退するだけでは数えない）。
    // 確定した点は、続く expedition_ended の payout（その参加者の banked）
    type Use = { depth: number; x: number; y: number; amount: number | null; maxHp: number | null; via: 'heal' | 'return'; banked?: number };
    const uses: Use[] = [];
    let pendingReturn: Use | null = null;
    for (const e of session.history) {
      if (e.type === 'fire_used' && e.player === pid) uses.push({ depth: e.depth, x: e.x, y: e.y, amount: e.amount, maxHp: e.maxHp, via: 'heal' });
      else if (e.type === 'fire_return' && e.player === pid && e.phase === 'done') { pendingReturn = { depth: e.depth, x: e.x, y: e.y, amount: null, maxHp: null, via: 'return', banked: 0 }; uses.push(pendingReturn); }
      else if (e.type === 'expedition_ended' && pendingReturn) {
        const share = e.result?.payout?.players?.find((x) => x.player === pid);
        pendingReturn.banked = share?.banked ?? 0;
        pendingReturn = null;
      }
    }
    const placed = session.world.season?.placed ?? [];
    const seen = run.firesSeen ?? 0;
    let n = 0;
    uses.forEach((e, i) => {
      const cell = (x: { depth: number; x: number; y: number }) => x.depth === e.depth && x.x === e.x && x.y === e.y;
      const fire = d.fires.find((x) => !x.dup && cell(x));
      // 使った者の火（自分の置いた火・取り合いで載らなかった火）は、同じマスにほかの者の火があっても数えない（S1a §10.1 の 5）
      const own = !!fire && (fire.profileId === user.profileId || d.fires.some((x) => x.profileId === user.profileId && cell(x)) || placed.some(cell));
      const enough = e.via === 'return' ? (e.banked ?? 0) >= 1 : e.amount! * 100 >= e.maxHp! * this.supportMinHealPct;
      const counted = !!fire && !own && !fire.users.includes(user.profileId) && enough;
      if (i >= seen) this.store.log(d.def.id, { type: 'fire_used', via: e.via, profileId: user.profileId, runId: session.runId, depth: e.depth, x: e.x, y: e.y, ...(e.via === 'heal' ? { amount: e.amount, maxHp: e.maxHp } : { banked: e.banked ?? 0 }), counted, ...(fire ? { holder: fire.profileId } : {}) });
      if (!counted || !fire) return;
      fire.uses++;
      fire.users.push(user.profileId);
      n++;
    });
    const changed = n > 0 || uses.length !== seen;
    run.firesSeen = uses.length;
    if (n) this.store.saveFires(d);
    return changed;
  }

  /** 確定（SEASON.md §2.1）: 終わりの時刻の後、参加者の全員が迷宮にいないか、終わりから 1 時間たったら */
  tick(): void {
    const now = this.now();
    for (const id of this.store.ids()) {
      const d = this.store.get(id);
      if (!d || d.result || now < d.def.endsAt) continue;
      const inside = d.participants.some((p) => p.runs.some((r) => !r.ended && this.liveRun(r.runId) === 'in_dungeon'));
      if (inside && now < d.def.endsAt + SEASON_GRACE_MS) continue;
      this.finalize(d, inside ? 'grace_over' : 'all_back');
    }
  }

  finalize(d: SeasonData, reason: SeasonResult['reason']): SeasonResult {
    // ほかのプロセスが先に確定していれば、それを使う（S2a §20.10 の 1。get がディスクを見直す）
    const cur = this.store.get(d.def.id);
    if (cur?.result) { d.result = cur.result; return cur.result; }
    // 記録が読めないシーズン（result.json が読めないときを含む。§36.1 の 6）は、確定し直さない（書かない）
    if (!cur && this.store.isBroken(d.def.id)) return d.result ?? { finalizedAt: 0, reason, winners: { adventure: [], contribution: [], survival: [], support: [] }, standings: [] };
    if (d.result) return d.result;
    // 確定は、すべての参加者の今の値を出す（終わりから 1 時間で、迷宮にいる者の分も。S2a §20.10 の 2）
    for (const p of d.participants) p.shown = liveShown(p);
    this.flush();
    const st = computeStandings(started(d.participants), d.fires, d.supplies);
    const winners = { adventure: [], contribution: [], survival: [], support: [] } as SeasonResult['winners'];
    for (const r of st.rows) {
      if (r.adventure.rank === 1) winners.adventure.push({ name: r.name, value: r.adventure.value });
      if (r.contribution.rank === 1 && r.contribution.value > 0) winners.contribution.push({ name: r.name, value: r.contribution.value });
      if (r.survival?.rank === 1) winners.survival.push({ name: r.name, value: r.survival.value });
      if (r.support?.rank === 1 && r.support.value > 0) winners.support.push({ name: r.name, value: r.support.value });
    }
    const at = this.now();
    const titles = this.titlesFor(d, st, at);
    const deeds = [...d.deeds].sort((a, b) => a.depth - b.depth).map((x) => ({ depth: x.depth, name: x.name, profileId: x.profileId }));
    d.result = { finalizedAt: at, reason, winners, standings: st.rows, titles, deeds };
    this.store.saveParticipants(d);
    this.store.saveResult(d);
    this.store.log(d.def.id, { type: 'finalized', reason, winners, titles: titles.map((x) => ({ id: x.id, profileId: x.profileId, ...(x.award ? { award: x.award } : {}), ...(x.depth ? { depth: x.depth } : {}) })) });
    return d.result;
  }

  /**
   * 称号（S2 §18.2）: 賞ごとの 1 位（同じ順位の 1 位は全員）と、節目の大守護者の初討伐（階ごと）。
   * ランを始めた参加者が TITLE_MIN_ENTRANTS 人に満たないシーズンでは付けない。値が 0 の賞（と対象外）にも付けない
   */
  private titlesFor(d: SeasonData, st: ReturnType<typeof computeStandings>, at: number): SeasonTitleRec[] {
    const ps = started(d.participants);
    if (ps.length < TITLE_MIN_ENTRANTS) return [];
    const out: SeasonTitleRec[] = [];
    const base = { season: d.def.id, seasonName: d.def.name, at };
    for (const id of AWARD_IDS) {
      for (const p of ps) {
        const a = st.award(p, id);
        // 冒険賞は、最深が地下 1 階のままなら付けない（だれも下りていないシーズンで全員に付くのを防ぐ。S2a §20.10 の 6）
        if (a.rank !== 1 || !a.value || (id === 'adventure' && a.value <= 1)) continue;
        const def = this.titleDefs.find((x) => x.kind === 'award' && x.award === id);
        out.push({ ...base, id: def?.id ?? `core:title_${id}`, kind: 'award', award: id, name: titleName(def, d.def.name, null, awardName('ja', id), awardName('en', id)), profileId: p.profileId, holder: p.name });
      }
    }
    const def = this.titleDefs.find((x) => x.kind === 'first_warden');
    for (const x of [...d.deeds].sort((a, b) => a.depth - b.depth)) {
      out.push({ ...base, id: def?.id ?? 'core:title_first_warden', kind: 'first_warden', depth: x.depth, name: titleName(def, d.def.name, x.depth, `地下${x.depth}階の初討伐`, `First to slay the depth ${x.depth} warden`), profileId: x.profileId, holder: x.name });
    }
    return out;
  }

  /** そのプロフィールの称号（S2 §18.2。確定したすべてのシーズンの結果から。付いた順） */
  titlesOf(profileId: string): SeasonTitle[] {
    const out: SeasonTitle[] = [];
    for (const id of this.store.ids()) {
      const d = this.store.get(id);
      for (const x of d?.result?.titles ?? []) if (x.profileId === profileId) out.push(publicTitle(x));
    }
    return out.sort((a, b) => a.at - b.at || (a.season < b.season ? -1 : a.season > b.season ? 1 : 0));
  }

  /**
   * 坑の断面（S2 §18.3）: 階ごとの最深の印・公開された階段と特別な場所・共有層の火（取り合いで載らなかった火は除く）。位置は出さない。
   * 確定したシーズンでは、節目の大守護者の初討伐も
   */
  section(d: SeasonData): SeasonSectionRow[] {
    const ps = started(d.participants);
    const fires = d.fires.filter((f) => !f.dup);
    const deeds = d.result ? d.deeds : [];
    // 確定したシーズンの最深は、確定した結果から（S2b）。進行中は公開の値
    const finalDepth = new Map((d.result?.standings ?? []).map((r) => [nameKey(r.name), r.adventure.value]));
    const depthOf = (p: Participant) => finalDepth.get(nameKey(p.name)) ?? shownOf(p).best.depth;
    const max = Math.max(1, ...ps.map(depthOf), ...d.public.map((x) => x.depth), ...d.spots.map((x) => x.depth), ...fires.map((x) => x.depth), ...deeds.map((x) => x.depth), ...d.supplies.filter((x) => !x.takenBy).map((x) => x.depth));
    const out: SeasonSectionRow[] = [];
    for (let depth = 1; depth <= max; depth++) {
      const st = d.public.find((x) => x.depth === depth);
      const deed = deeds.find((x) => x.depth === depth);
      out.push({
        depth,
        deepest: ps.filter((p) => depthOf(p) === depth).map((p) => p.name),
        stairs: st ? { by: st.by } : null,
        spots: d.spots.filter((x) => x.depth === depth).sort((a, b) => a.order - b.order).map((x) => ({ kind: x.kind, by: x.by })),
        fires: fires.filter((x) => x.depth === depth).sort((a, b) => a.order - b.order).map((x) => ({ by: x.by, uses: x.uses })),
        // 補給の置き場（S3 §25.2）: 共有層に載って、まだだれも取っていない品の数（場所と種類は出さない）
        supplies: d.supplies.filter((x) => x.depth === depth && !x.takenBy).length,
        ...(deed ? { firstWarden: deed.name } : {}),
      });
    }
    return out;
  }

  /**
   * 順位の表（GET /api/seasons/:id。公開された階段の位置は入れない）。S2: 参加者ごとの確定点と称号、確定した結果の称号と初討伐、坑の断面。
   * プロフィールの ID とトークンは出さない
   */
  standings(id: string): SeasonStandingsResponse | null {
    const d = this.store.get(id);
    if (!d) return null;
    const pOf = (name: string) => d.participants.find((p) => nameKey(p.name) === nameKey(name));
    const decorate = (r: SeasonStandingRow): SeasonStandingRow => {
      const p = pOf(r.name);
      return { ...r, banked: r.banked ?? (p ? banked(p) : 0), titles: p ? this.titlesOf(p.profileId) : [] };
    };
    const rows = (d.result?.standings ?? computeStandings(started(d.participants), d.fires, d.supplies).rows).map(decorate);
    let result: SeasonResultView | undefined;
    if (d.result) {
      const { titles, deeds, standings: _s, ...rest } = d.result;
      result = {
        ...rest, standings: rows,
        ...(titles ? { titles: titles.map((x) => ({ ...publicTitle(x), holder: x.holder })) } : {}),
        ...(deeds ? { deeds: deeds.map((x) => ({ depth: x.depth, name: x.name })) } : {}),
      };
    }
    // 討伐の記録（S4 §35.5）: 節目ごとに、最初の 1 件といちばん少ない被害の 1 件（載ったもの。位置は無い）
    const slays = slaysView(d.slays, null);
    return { season: this.listing(d), standings: rows, ...(result ? { result } : {}), section: this.section(d), ...(slays.length ? { slays } : {}) };
  }
}

/**
 * 討伐の記録の見せる分（S4 §35.5）: 節目ごとに、最初に載った 1 件と、受けた被害がいちばん少ない 1 件（同じなら 1 件）。深さの順。
 * 取り込みの決まった形（SeasonSlaySchema）に合わないものは渡さない。viewer: 見る者のプロフィールの ID（自分の記録に mine）
 */
export function slaysView(recs: readonly SeasonSlayRec[], viewer: string | null): SeasonSlay[] {
  const out: SeasonSlay[] = [];
  const depths = [...new Set(recs.map((r) => r.depth))].sort((a, b) => a - b);
  for (const depth of depths) {
    const list = recs.filter((r) => r.depth === depth).sort((a, b) => a.order - b.order);
    const first = list[0];
    const least = [...list].sort((a, b) => a.taken - b.taken || a.order - b.order)[0];
    for (const r of first === least ? [first] : [first, least]) {
      const { order: _o, profileId, runId: _r, name, budgetUsed: _u, wall: _w, ...facts } = r;
      const v: SeasonSlay = {
        ...structuredClone(facts), by: name, of: list.length,
        ...(r === first ? { first: true } : {}), ...(r === least ? { least: true } : {}), ...(viewer && profileId === viewer ? { mine: true } : {}),
      };
      if (SeasonSlaySchema.safeParse(v).success) out.push(v);
    }
  }
  return out;
}

/** 称号の名前（データの {season}・{depth} を置き換える。定義が無ければ賞の名前から） */
function titleName(def: SeasonTitleDefLite | undefined, season: string, depth: number | null, ja: string, en: string): { ja: string; en: string } {
  const fill = (s: string) => s.split('{season}').join(season).split('{depth}').join(depth === null ? '' : String(depth));
  return def ? { ja: fill(def.name.ja), en: fill(def.name.en) } : { ja: `${ja}（${season}）`, en: `${en} (${season})` };
}

/** 外へ出す称号（プロフィールの ID と持ち主の名前を外す） */
function publicTitle(x: SeasonTitleRec): SeasonTitle {
  return { id: x.id, season: x.season, seasonName: x.seasonName, kind: x.kind, ...(x.award ? { award: x.award } : {}), ...(x.depth !== undefined ? { depth: x.depth } : {}), name: { ...x.name }, at: x.at };
}

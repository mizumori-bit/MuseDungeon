// シーズン（S0。SEASON.md §2・PROTOCOL.md §9）: 同じシードの個別ダンジョン＋共有層。World の外にあり、サーバーが seasons/<id>/ に持つ。
// ランに入るのは、キャンプでの取り込み（システムの命令 season_sync）だけ。ここはその中身を作り、ランの出来事から参加者の記録を書き直す。
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GameEvent, PlayerId, SeasonAward, SeasonListing, SeasonStandingRow, SeasonSyncCommand } from '@muse/shared';
import type { RunSession } from '../session/RunSession';
import type { ProfileStore } from '../session/profiles';

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
  /** 最初に報告した階段の数と、最後の 1 つを報告したときまでに使った予算 */
  firstReports: number;
  lastFirstUsed: number;
  died: boolean;
}

/** 招いた者（S0a。SEASON.md §4.1）。invites.json は運用の道具だけが書き、サーバーは読むだけ。トークンは入れない */
export interface SeasonInvite { profileId: string; name: string; invitedAt: number }

/** 表示名の比べ方（前後の空白を除き、全角と半角・大文字と小文字を区別しない） */
export function nameKey(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

export interface PublicStairsRec { depth: number; x: number; y: number; by: string; profileId: string; runId: string; used: number; wall: number; order: number }

/**
 * 共有層の野営の火（S1。PROTOCOL §9.10。fires.json）。used: 載せたときまでに置いた者が使った予算、
 * uses: 支援賞に数えた回数、users: 数えた参加者（1 つの火で 1 人 1 回）
 */
export interface PublicFireRec {
  order: number; depth: number; x: number; y: number; by: string; profileId: string; runId: string; used: number; wall: number; uses: number; users: string[];
  /** 同じマスの取り合いで載らなかった火（S1a §10.1 の 5）: ほかの者には渡さず、置いた者の火としてだけ数える（上限・自分の使用を支援に数えない） */
  dup?: boolean;
}

export interface SeasonResult {
  finalizedAt: number;
  reason: 'all_back' | 'grace_over' | 'operator';
  winners: Record<SeasonAward['id'], { name: string; value: number }[]>;
  standings: SeasonStandingRow[];
}

interface SeasonData {
  def: SeasonDef;
  participants: Participant[];
  public: PublicStairsRec[];
  fires: PublicFireRec[];
  result: SeasonResult | null;
}

/** 終わりの時刻の後、全員がキャンプに戻らなくても、この時間で確定する（SEASON.md §2.1） */
export const SEASON_GRACE_MS = 60 * 60 * 1000;
export const SEASON_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const used = (p: Participant) => p.runs.reduce((a, r) => a + r.turns, 0);
/** 順位に数える参加者（1 回でもランを始めた者。招いただけの者は入れない） */
const started = (ps: readonly Participant[]) => ps.filter((p) => p.runs.length > 0);
const banked = (p: Participant) => p.runs.reduce((a, r) => a + r.banked, 0);
/** 支援の数は、火ごとの記録（fires.json の uses）から作る（S1a §10.1 の 4: 参加者ごとの数を別に持たない） */
const supportOf = (fires: readonly PublicFireRec[]) => (p: Participant) => fires.reduce((a, f) => a + (!f.dup && f.profileId === p.profileId ? f.uses : 0), 0);

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
export function computeStandings(ps: readonly Participant[], fires: readonly PublicFireRec[] = []): {
  rows: SeasonStandingRow[];
  award: (p: Participant, id: SeasonAward['id']) => SeasonAward;
} {
  const list = [...ps];
  const adv = ranked(list, (p) => p.best.depth, (p) => p.best.used);
  const con = ranked(list, (p) => p.firstReports, (p) => (p.firstReports ? p.lastFirstUsed : 0));
  const alive = list.filter((p) => !p.died);
  const sur = ranked(alive, (p) => banked(p), (p) => used(p));
  const leaderOf = (m: Map<Participant, number>, value: (p: Participant) => number) => {
    const top = [...m.entries()].filter(([, r]) => r === 1).map(([p]) => p);
    // 1 位が並んだら、先に参加した者を名前に出す
    const first = top.sort((a, b) => list.indexOf(a) - list.indexOf(b))[0];
    return first ? { name: first.name, value: value(first) } : null;
  };
  const advLead = leaderOf(adv, (p) => p.best.depth);
  const conLead = leaderOf(con, (p) => p.firstReports);
  const surLead = leaderOf(sur, (p) => banked(p));
  // 支援賞（S1 §8.5）: 自分の火が使われた回数。同着は使った予算の少ないほう
  const support = supportOf(fires);
  const sup = ranked(list, (p) => support(p), (p) => used(p));
  const supLead = leaderOf(sup, (p) => support(p));
  const rows: SeasonStandingRow[] = list.map((p) => ({
    name: p.name, runs: p.runs.length, used: used(p), died: p.died,
    adventure: { value: p.best.depth, rank: adv.get(p)! },
    contribution: { value: p.firstReports, rank: con.get(p)! },
    survival: p.died ? null : { value: banked(p), rank: sur.get(p)! },
    support: { value: support(p), rank: sup.get(p)! },
  })).sort((a, b) => a.adventure.rank - b.adventure.rank || a.name.localeCompare(b.name));
  const award = (p: Participant, id: SeasonAward['id']): SeasonAward => {
    if (id === 'support') return { id, value: support(p), rank: sup.get(p) ?? null, entrants: list.length, leader: supLead, gap: supLead ? supLead.value - support(p) : null };
    if (id === 'adventure') return { id, value: p.best.depth, rank: adv.get(p) ?? null, entrants: list.length, leader: advLead, gap: advLead ? advLead.value - p.best.depth : null };
    if (id === 'contribution') return { id, value: p.firstReports, rank: con.get(p) ?? null, entrants: list.length, leader: conLead, gap: conLead ? conLead.value - p.firstReports : null };
    if (p.died) return { id, value: null, rank: null, entrants: alive.length, leader: surLead, gap: null };
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

  private readJson<T>(id: string, file: string): T | null {
    if (!this.dir) return null;
    const p = this.path(id, file);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return null; }
  }

  private writeJson(id: string, file: string, v: unknown): void {
    if (!this.dir) return;
    const d = join(this.dir, id);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const p = join(d, file);
    writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 1));
    renameSync(`${p}.tmp`, p);
  }

  /** そのシーズン（知らない ID はディスクを読み直す。動いているサーバーで、後から開いたシーズン） */
  get(id: string): SeasonData | null {
    const have = this.data.get(id);
    if (have) return have;
    if (!SEASON_ID_RE.test(id)) return null;
    const def = this.readJson<SeasonDef>(id, 'season.json');
    if (!def) return null;
    const d: SeasonData = {
      def,
      participants: this.readJson<Participant[]>(id, 'participants.json') ?? [],
      public: this.readJson<PublicStairsRec[]>(id, 'public.json') ?? [],
      fires: this.readJson<PublicFireRec[]>(id, 'fires.json') ?? [],
      result: this.readJson<SeasonResult>(id, 'result.json'),
    };
    this.data.set(id, d);
    return d;
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
    if (this.get(def.id)) throw new Error(`season ${def.id} already exists`);
    const d: SeasonData = { def, participants: [], public: [], fires: [], result: null };
    this.data.set(def.id, d);
    this.writeJson(def.id, 'season.json', def);
    this.log(def.id, { type: 'opened', def });
    return d;
  }

  /** 招いた者（毎回ファイルから読む。書くのは運用の道具だけで、動いているサーバーは読み直すだけ） */
  invites(id: string): SeasonInvite[] {
    if (!this.dir) return [...(this.memInvites.get(id) ?? [])];
    return this.readJson<SeasonInvite[]>(id, 'invites.json') ?? [];
  }

  /** 招いた者を足す（運用の道具。サーバーは呼ばない） */
  addInvite(id: string, inv: SeasonInvite): void {
    const list = [...this.invites(id), inv];
    if (!this.dir) { this.memInvites.set(id, list); return; }
    this.writeJson(id, 'invites.json', list);
  }

  /** 招いた者を外す（運用の道具。S0b §6.2 の 5）。外したら true */
  removeInvite(id: string, profileId: string): boolean {
    const list = this.invites(id);
    const next = list.filter((x) => x.profileId !== profileId);
    if (next.length === list.length) return false;
    if (!this.dir) { this.memInvites.set(id, next); return true; }
    this.writeJson(id, 'invites.json', next);
    return true;
  }

  saveParticipants(d: SeasonData): void { this.writeJson(d.def.id, 'participants.json', d.participants); }
  savePublic(d: SeasonData): void { this.writeJson(d.def.id, 'public.json', d.public); }
  saveFires(d: SeasonData): void { this.writeJson(d.def.id, 'fires.json', d.fires); }
  saveResult(d: SeasonData): void { this.writeJson(d.def.id, 'result.json', d.result); }

  log(id: string, rec: Record<string, unknown>): void {
    if (!this.dir) return;
    const d = join(this.dir, id);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    appendFileSync(join(d, 'log.jsonl'), JSON.stringify({ wall: Date.now(), ...rec }) + '\n');
  }
}

/** ランが今どうなっているか（SessionManager が答える）。null は動いていない（終わった・復旧していない） */
export type LiveRunState = 'in_dungeon' | 'at_camp' | 'ended' | null;

/** RunSession が呼ぶ口（SessionDeps.season） */
export interface SeasonHooks {
  /** その参加者の、今の取り込みの中身（予算の残り・公開された階段・順位の写し） */
  sync(session: RunSession, pid: PlayerId): SeasonSyncCommand['season'] | null;
  /** 階段の報告: サーバーに届いた順で、最初の報告かを決めて残す */
  report(session: RunSession, pid: PlayerId, stairs: readonly { depth: number; x: number; y: number }[]): { stairs: { depth: number; x: number; y: number; first: boolean }[] } | null;
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
    if (!d) return { error: `シーズン ${id} は無い / no such season` };
    if (d.result) return { error: `シーズン ${id} は確定している / season ${id} is final` };
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
    if (!d) return { error: `シーズン ${id} は無い / no such season` };
    if (d.result) return { error: `シーズン ${id} は確定している / season ${id} is final` };
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
    if (!d) return { reason: `そのシーズンは無い / no such season: ${id}` };
    if (!profileId) return { reason: `シーズンのランには profile_token が要る（運用者から受け取った、このシーズンに招かれたプロフィールのもの） / a season run needs the profile_token the operator gave you` };
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
    if (!d) return;
    let p = this.participant(d, profileId);
    const wall = this.now();
    if (!p) {
      p = { profileId, name: name.slice(0, 32) || 'Muse', joinedAt: wall, runs: [], best: { depth: 1, used: 0 }, firstReports: 0, lastFirstUsed: 0, died: false };
      d.participants.push(p);
      this.store.log(id, { type: 'joined', profileId, name: p.name });
    }
    p.runs.push({ runId, startedAt: wall, turns: 0, deepest: 1, banked: 0, died: false, ended: false });
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
    const st = computeStandings(started(d.participants), d.fires);
    return {
      id: d.def.id, name: d.def.name,
      budget: { limit: d.def.budget, left: d.def.budget - used(p) },
      ends_at: d.def.endsAt, ended: this.status(d) !== 'open',
      public: [...d.public].sort((a, b) => a.depth - b.depth).map((x) => ({ depth: x.depth, x: x.x, y: x.y, by: x.by })),
      awards: (['adventure', 'contribution', 'survival', 'support'] as const).map((id) => st.award(p, id)),
      contribution: p.firstReports, died: p.died,
      // 野営の火（S1 §9.10）: 共有層の火（載せた順）。自分の火には mine と、支援賞に数えた回数
      // 取り合いで載らなかった火（dup）は、置いた者にだけ渡す（自分の火として数える）
      fires: [...d.fires].filter((f) => !f.dup || f.profileId === p.profileId).sort((a, b) => a.order - b.order)
        .map((f) => ({ depth: f.depth, x: f.x, y: f.y, by: f.by, ...(f.profileId === p.profileId ? { mine: true, uses: f.uses, ...(f.dup ? { dup: true } : {}) } : {}) })),
      self: p.name,
    };
  }

  report(session: RunSession, pid: PlayerId, stairs: readonly { depth: number; x: number; y: number }[]): { stairs: { depth: number; x: number; y: number; first: boolean }[] } | null {
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
    if (gained) { p.firstReports += gained; p.lastFirstUsed = used(p); }
    this.store.log(d.def.id, { type: 'reported', profileId: p.profileId, runId: session.runId, used: used(p), stairs: out });
    this.store.savePublic(d);
    this.store.saveParticipants(d);
    return { stairs: out };
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
    for (const id of this.dirty) { const d = this.store.get(id); if (d) this.store.saveParticipants(d); }
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
    return published > 0 || counted;
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
    }
  }

  /** 開いているシーズンのうち、版（engine・コンテンツ）がこのサーバーと違うもの（S1a: 起動時の警告） */
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
   * 火が使われた（S1 §8.5）: 置いた本人でない・その参加者がその火で数えられるのはシーズンを通して 1 回・最大 HP の supportMinHealPct% 以上が戻った、
   * をすべて満たす使用だけを、火を置いた参加者の支援賞に数える。数えた数を返す
   */
  private countFireUses(d: SeasonData, user: Participant, run: SeasonRunRec, session: RunSession, pid: PlayerId): boolean {
    if (d.result) return false;
    // そのランの火の使用をすべて見る（やり直しても同じ: 数えたかどうかは火ごとの users で決まる）
    const uses = session.history.filter((e): e is Extract<GameEvent, { type: 'fire_used' }> => e.type === 'fire_used' && e.player === pid);
    const placed = session.world.season?.placed ?? [];
    const seen = run.firesSeen ?? 0;
    let n = 0;
    uses.forEach((e, i) => {
      const cell = (x: { depth: number; x: number; y: number }) => x.depth === e.depth && x.x === e.x && x.y === e.y;
      const fire = d.fires.find((x) => !x.dup && cell(x));
      // 使った者の火（自分の置いた火・取り合いで載らなかった火）は、同じマスにほかの者の火があっても数えない（S1a §10.1 の 5）
      const own = !!fire && (fire.profileId === user.profileId || d.fires.some((x) => x.profileId === user.profileId && cell(x)) || placed.some(cell));
      const counted = !!fire && !own && !fire.users.includes(user.profileId) && e.amount * 100 >= e.maxHp * this.supportMinHealPct;
      if (i >= seen) this.store.log(d.def.id, { type: 'fire_used', profileId: user.profileId, runId: session.runId, depth: e.depth, x: e.x, y: e.y, amount: e.amount, maxHp: e.maxHp, counted, ...(fire ? { holder: fire.profileId } : {}) });
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
    if (d.result) return d.result;
    this.flush();
    const st = computeStandings(started(d.participants), d.fires);
    const winners = { adventure: [], contribution: [], survival: [], support: [] } as SeasonResult['winners'];
    for (const r of st.rows) {
      if (r.adventure.rank === 1) winners.adventure.push({ name: r.name, value: r.adventure.value });
      if (r.contribution.rank === 1 && r.contribution.value > 0) winners.contribution.push({ name: r.name, value: r.contribution.value });
      if (r.survival?.rank === 1) winners.survival.push({ name: r.name, value: r.survival.value });
      if (r.support?.rank === 1 && r.support.value > 0) winners.support.push({ name: r.name, value: r.support.value });
    }
    d.result = { finalizedAt: this.now(), reason, winners, standings: st.rows };
    this.store.saveParticipants(d);
    this.store.saveResult(d);
    this.store.log(d.def.id, { type: 'finalized', reason, winners });
    return d.result;
  }

  /** 順位の表（GET /api/seasons/:id。公開された階段の位置は入れない） */
  standings(id: string): { season: SeasonListing; standings: SeasonStandingRow[]; result?: SeasonResult } | null {
    const d = this.store.get(id);
    if (!d) return null;
    return { season: this.listing(d), standings: d.result?.standings ?? computeStandings(started(d.participants), d.fires).rows, ...(d.result ? { result: d.result } : {}) };
  }
}

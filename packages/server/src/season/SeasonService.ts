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

export interface SeasonRunRec { runId: string; startedAt: number; turns: number; deepest: number; banked: number; died: boolean; ended: boolean }

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
  result: SeasonResult | null;
}

/** 終わりの時刻の後、全員がキャンプに戻らなくても、この時間で確定する（SEASON.md §2.1） */
export const SEASON_GRACE_MS = 60 * 60 * 1000;
export const SEASON_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const used = (p: Participant) => p.runs.reduce((a, r) => a + r.turns, 0);
/** 順位に数える参加者（1 回でもランを始めた者。招いただけの者は入れない） */
const started = (ps: readonly Participant[]) => ps.filter((p) => p.runs.length > 0);
const banked = (p: Participant) => p.runs.reduce((a, r) => a + r.banked, 0);

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
export function computeStandings(ps: readonly Participant[]): {
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
  const rows: SeasonStandingRow[] = list.map((p) => ({
    name: p.name, runs: p.runs.length, used: used(p), died: p.died,
    adventure: { value: p.best.depth, rank: adv.get(p)! },
    contribution: { value: p.firstReports, rank: con.get(p)! },
    survival: p.died ? null : { value: banked(p), rank: sur.get(p)! },
  })).sort((a, b) => a.adventure.rank - b.adventure.rank || a.name.localeCompare(b.name));
  const award = (p: Participant, id: SeasonAward['id']): SeasonAward => {
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
    const d: SeasonData = { def, participants: [], public: [], result: null };
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

  saveParticipants(d: SeasonData): void { this.writeJson(d.def.id, 'participants.json', d.participants); }
  savePublic(d: SeasonData): void { this.writeJson(d.def.id, 'public.json', d.public); }
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
    const st = computeStandings(started(d.participants));
    return {
      id: d.def.id, name: d.def.name,
      budget: { limit: d.def.budget, left: d.def.budget - used(p) },
      ends_at: d.def.endsAt, ended: this.status(d) !== 'open',
      public: [...d.public].sort((a, b) => a.depth - b.depth).map((x) => ({ depth: x.depth, x: x.x, y: x.y, by: x.by })),
      awards: (['adventure', 'contribution', 'survival'] as const).map((id) => st.award(p, id)),
      contribution: p.firstReports, died: p.died,
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
      if (big || events.some((e) => e.type === 'expedition_ended' || e.type === 'run_ended')) this.tick();
    }
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
    const st = computeStandings(started(d.participants));
    const winners = { adventure: [], contribution: [], survival: [] } as SeasonResult['winners'];
    for (const r of st.rows) {
      if (r.adventure.rank === 1) winners.adventure.push({ name: r.name, value: r.adventure.value });
      if (r.contribution.rank === 1 && r.contribution.value > 0) winners.contribution.push({ name: r.name, value: r.contribution.value });
      if (r.survival?.rank === 1) winners.survival.push({ name: r.name, value: r.survival.value });
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
    return { season: this.listing(d), standings: d.result?.standings ?? computeStandings(started(d.participants)).rows, ...(d.result ? { result: d.result } : {}) };
  }
}

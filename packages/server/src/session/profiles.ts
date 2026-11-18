// プロフィール（IMPROVEMENTS_V3 §7・§16.3。V3-7）: ランをまたいで残る記録・図鑑・継承・実績。
// World の外にあり、サーバーが profiles/<id>.json に持つ（既定は runs/profiles）。トークンはハッシュだけを残す。
// ランの記録は、遠征が終わるたび・ランが終わるたびに、そのプレイヤー本人の知識と出来事から作り直す（他人の情報・シードは入らない）。
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Content } from '@muse/content';
import type {
  Catalog, CodexIndex, CodexRun, FeatContext, FeatDefLite, FeatRecord, GameEvent, LegacyMonster, Locale, PlayerId, ProfileData, ProfileRecords, ProfileRun,
} from '@muse/shared';
import { abilityName, buildRecords, codexCount, emptyCodex, evalFeatCond, expeditionBest, floorsUnhurt, kindName, legacyFrom, mergeCodex, recordsCampLine, recordsLines, t } from '@muse/shared';
import type { RunSession } from './RunSession';

interface ProfileFile extends ProfileData { version: 1; tokenHash: string }

const hashToken = (tok: string) => createHash('sha256').update(tok).digest('hex');

export function newProfileId(): string {
  return 'prof_' + randomBytes(6).toString('hex').slice(0, 10);
}

/** プロフィールの置き場所（dir が null ならメモリだけ。テスト用） */
export class ProfileStore {
  private readonly byId = new Map<string, ProfileFile>();
  private readonly byHash = new Map<string, string>();

  constructor(readonly dir: string | null) {
    if (dir && existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (!/^prof_[0-9a-f]+\.json$/.test(f)) continue;
        try {
          const p = JSON.parse(readFileSync(join(dir, f), 'utf8')) as ProfileFile;
          this.byId.set(p.id, p);
          this.byHash.set(p.tokenHash, p.id);
        } catch { /* 壊れたファイルは読まない */ }
      }
    }
  }

  create(name: string, wall: number): { token: string; profile: ProfileData } {
    const token = randomBytes(18).toString('base64url');
    const p: ProfileFile = { version: 1, id: newProfileId(), tokenHash: hashToken(token), name: name.slice(0, 32) || 'Muse', createdAt: wall, updatedAt: wall, runs: [], feats: [] };
    this.byId.set(p.id, p);
    this.byHash.set(p.tokenHash, p.id);
    this.save(p);
    return { token, profile: p };
  }

  resolve(token: string): ProfileData | null {
    const id = this.byHash.get(hashToken(token));
    return id ? this.byId.get(id) ?? null : null;
  }

  get(id: string): ProfileData | null {
    return this.byId.get(id) ?? null;
  }

  save(p: ProfileData): void {
    const f = this.byId.get(p.id);
    if (!f) return;
    if (f !== p) Object.assign(f, p);
    if (!this.dir) return;
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, `${p.id}.json`);
    writeFileSync(`${path}.tmp`, JSON.stringify(f, null, 1));
    renameSync(`${path}.tmp`, path);
  }
}

/** 図鑑の項目（コンテンツから） */
export function buildCodexIndex(content: Content): CodexIndex {
  const short = (s: string) => (s.length > 18 ? `${s.slice(0, 18)}…` : s);
  return {
    species: content.lists.monsters.map((m) => ({ id: m.id, name: m.name })),
    items: content.lists.items.filter((i) => i.unidentified).map((i) => ({ id: i.id, name: i.name })),
    relics: content.lists.relics.map((r) => ({ id: r.id, name: r.name })),
    guardians: [...content.lists.guardianTypes.map((g) => ({ id: g.id, name: g.name })), ...content.lists.guardianWeaknesses.map((w) => ({ id: w.id, name: w.name }))],
    fragments: content.lists.lore.filter((l) => l.kind === 'inscription' || l.kind === 'note').map((l) => ({ id: l.id, name: { ja: short(l.text.ja), en: short(l.text.en) } })),
    rooms: content.lists.prefabs.filter((p) => p.tags.includes('room')).map((p) => ({ id: p.id, name: p.name ?? { ja: p.id, en: p.id } })),
  };
}

/**
 * プロフィールの読み取り口（§7.1 の ProfilePort）。MCP の records・profile と、人間向けの HTTP（画面）が同じものを使う。
 * 書き換えは表示名だけ（記録はサーバーがランから作る）
 */
export class ProfilePort {
  constructor(private readonly service: ProfileService, readonly id: string, private readonly liveRun: (runId: string) => boolean) {}

  records(L: Locale): { text: string; data: ProfileRecords } | null {
    const r = this.service.records(this.id, L);
    return r ? { text: r.lines.join('\n'), data: r.records } : null;
  }

  /** 表示名・記録の要約・進行中で再開できるラン（run_id だけ。player_token は返さない） */
  info(L: Locale): { text: string; data: { profile_id: string; name: string; summary: string; runs: { run_id: string; character: string; status: 'active' | 'ended'; resumable: boolean }[] } } | null {
    const p = this.service.store.get(this.id);
    const r = this.service.records(this.id, L);
    if (!p || !r) return null;
    const runs = [...p.runs].sort((a, b) => b.startedAt - a.startedAt).map((x) => ({ run_id: x.runId, character: x.character, status: x.status, resumable: x.status === 'active' && this.liveRun(x.runId) }));
    const summary = recordsCampLine(L, r.records);
    const open = runs.filter((x) => x.resumable);
    const lines = [
      t(L, `プロフィール: ${p.name}（${p.id}）`, `Profile: ${p.name} (${p.id})`),
      summary,
      open.length ? t(L, `進行中のラン: ${open.map((x) => `${x.run_id}（${x.character}）`).join('・')}（resume_run は player_token で）`, `Runs in progress: ${open.map((x) => `${x.run_id} (${x.character})`).join(', ')} (resume_run takes the player_token)`) : t(L, '進行中のランは無い', 'No run in progress'),
    ];
    return { text: lines.join('\n'), data: { profile_id: p.id, name: p.name, summary, runs } };
  }

  rename(name: string): boolean {
    const p = this.service.store.get(this.id);
    if (!p || !name.trim()) return false;
    p.name = name.trim().slice(0, 32);
    this.service.store.save(p);
    return true;
  }
}

/** RunSession が呼ぶ口（SessionDeps.profiles） */
export interface ProfileHooks {
  onCommit(session: RunSession, events: readonly GameEvent[]): void;
  /** キャンプの観測の 1 行（記録の要約と次の節目） */
  /** firstOf: このランの最初のキャンプなら、そのランの ID（前のランまでの記録を先頭に出す。V3-8 §53.5） */
  campLine(profileId: string, L: Locale, firstOf?: string): string | null;
  featsOf(profileId: string | null, runId: string, no: number, L: Locale): string[];
}

export class ProfileService implements ProfileHooks {
  readonly index: CodexIndex;
  private readonly loreByText = new Map<string, string>();
  private readonly feats: FeatDefLite[];

  constructor(readonly content: Content, readonly catalog: Catalog, readonly store: ProfileStore) {
    this.index = buildCodexIndex(content);
    for (const l of content.lists.lore) if (l.kind === 'inscription' || l.kind === 'note') this.loreByText.set(l.text.ja, l.id);
    this.feats = content.lists.feats.map((f) => ({ id: f.id, name: f.name, desc: f.desc, hidden: f.hidden }));
  }

  /** 継承する種族の知識（そのプロフィールの、このランより前の記録から） */
  legacyFor(profileId: string, exceptRun?: string): LegacyMonster[] {
    const p = this.store.get(profileId);
    if (!p) return [];
    return legacyFrom(p.runs.filter((r) => r.runId !== exceptRun), this.content.balance.legacy.minKills);
  }

  onCommit(session: RunSession, events: readonly GameEvent[]): void {
    const joined = new Set<string>();
    const ended: number[] = [];
    let runEnded = false;
    for (const e of events) {
      if (e.type === 'player_joined') joined.add(e.player.id);
      else if (e.type === 'expedition_ended') ended.push(e.no);
      else if (e.type === 'run_ended') runEnded = true;
    }
    if (!joined.size && !ended.length && !runEnded) return;
    for (const pid of session.world.playerOrder) {
      const nos = ended.filter((no) => (session.world.expeditions ?? []).find((x) => x.no === no)?.participants.includes(pid));
      if (!joined.has(pid) && !nos.length && !runEnded) continue;
      this.update(session, pid, nos);
    }
  }

  /** そのランの記録を作り直し、実績を判定して保存する。返り値: 新しく取った実績 */
  update(session: RunSession, pid: PlayerId, endedNos: readonly number[] = []): FeatRecord[] {
    const profileId = session.profileOf(pid);
    const prof = profileId ? this.store.get(profileId) : null;
    if (!prof) return [];
    const prevRun = prof.runs.find((r) => r.runId === session.runId);
    const run = this.buildRun(session, pid);
    if (prevRun) prof.runs[prof.runs.indexOf(prevRun)] = run; else prof.runs.push(run);
    const earned = new Set(prof.feats.map((f) => f.id));
    const got: FeatRecord[] = [];
    const judge = (ctx: FeatContext, no: number | null) => {
      for (const f of this.content.lists.feats) {
        if (earned.has(f.id) || !evalFeatCond(f.cond, ctx)) continue;
        earned.add(f.id);
        const rec = { id: f.id, runId: session.runId, no, wall: session.updatedAt };
        prof.feats.push(rec);
        got.push(rec);
      }
    };
    let wardensBefore = prevRun?.wardens ?? [];
    if (endedNos.length) {
      for (const no of endedNos) {
        const ctx = this.featContext(session, pid, prof, run, no, wardensBefore);
        wardensBefore = run.wardens;
        judge(ctx, no);
      }
    } else judge(this.featContext(session, pid, prof, run, null, wardensBefore), null);
    prof.updatedAt = session.updatedAt;
    this.store.save(prof);
    return got;
  }

  /** 1 ランの記録（本人の知識と、本人の出来事だけから） */
  buildRun(session: RunSession, pid: PlayerId): ProfileRun {
    const w = session.world;
    const p = w.players[pid];
    const e = w.entities[p.entityId];
    const reports = session.endedReports(pid);
    let streak = 0, streakMax = 0;
    for (const r of reports) { streak = r.reason === 'completed' ? streak + 1 : 0; streakMax = Math.max(streakMax, streak); }
    const dead = p.state === 'dead';
    const over = dead || w.status === 'ended' || p.state === 'left';
    return {
      runId: session.runId, character: p.name, classId: p.classId, legacy: !!p.legacy, legacyKinds: p.legacy?.kinds ?? 0,
      startedAt: session.createdAt, endedAt: over ? session.updatedAt : null, status: over ? 'ended' : 'active',
      end: dead ? 'died' : over ? 'retired' : null, deathCause: p.stats.deathCause,
      level: e?.level?.level ?? 1, banked: p.stats.banked ?? 0, deepest: p.stats.deepest,
      expeditions: reports.length, completed: reports.filter((r) => r.reason === 'completed').length, withdrawn: reports.filter((r) => r.reason === 'withdrawn').length,
      wardens: [...(w.milestones?.cleared ?? [])].sort((a, b) => a - b), streakMax,
      best: expeditionBest(reports),
      codex: this.runCodex(session, pid),
    };
  }

  private runCodex(session: RunSession, pid: PlayerId): CodexRun {
    const k = session.world.players[pid].knowledge;
    const c = emptyCodex();
    const inherited = new Map((session.legacyOf(pid) ?? []).map((l) => [l.kind, l]));
    for (const m of Object.values(k.monsterMemory)) {
      const cur = c.species[m.kind] ?? { met: 0, kills: 0, abilities: [] };
      cur.met += m.encounters;
      cur.kills += m.kills;
      if (m.guardian) {
        for (const ty of m.types ?? []) if (!c.guardianTypes.includes(ty)) c.guardianTypes.push(ty);
      } else {
        cur.abilities = [...new Set([...cur.abilities, ...m.abilities])].sort();
        // 継承した分は前のランの記録にあるので数えない（体力の記録の数だけ引く。範囲は重ねても変わらない）
        const legacySamples = inherited.get(m.kind)?.hpSeen?.samples ?? 0;
        if (m.hpSeen && m.hpSeen.samples > legacySamples) cur.hpSeen = { ...m.hpSeen, samples: m.hpSeen.samples - legacySamples };
        if (m.maxDamageToYou) cur.maxHit = Math.max(cur.maxHit ?? 0, m.maxDamageToYou);
        if (m.rangeMax) cur.rangeMax = Math.max(cur.rangeMax ?? 0, m.rangeMax);
      }
      if (cur.met || cur.kills) c.species[m.kind] = cur;
    }
    const identifiable = new Set(this.index.items.map((i) => i.id));
    c.items = [...new Set(k.identified.filter((id) => identifiable.has(id)))].sort();
    c.relics = [...new Set(k.archive ?? [])].sort();
    c.weaknesses = [...new Set([...Object.values(k.guardianIntel ?? {}), ...Object.values(k.wardenIntel ?? {}).map((x) => x.weakness).filter((x): x is string => !!x)])].sort();
    c.guardianTypes.sort();
    const frag = new Set<string>();
    const rooms = new Set<string>();
    for (const e of session.history) {
      if (e.type === 'inscription_read' && e.player === pid && e.lore) { const id = this.loreByText.get(e.lore.ja); if (id) frag.add(id); }
      else if (e.type === 'room_found' && e.player === pid) rooms.add(e.room);
    }
    c.fragments = [...frag].sort();
    c.rooms = [...rooms].sort();
    return c;
  }

  private featContext(session: RunSession, pid: PlayerId, prof: ProfileData, run: ProfileRun, no: number | null, wardensBefore: readonly number[]): FeatContext {
    const w = session.world;
    const report = no !== null ? session.expeditionReport(pid, no) : null;
    const x = no !== null ? (w.expeditions ?? []).find((y) => y.no === no) : undefined;
    const reports = session.endedReports(pid);
    let streak = 0;
    for (const r of reports) streak = r.reason === 'completed' ? streak + 1 : 0;
    const traits = this.catalog.rules?.traits ?? {};
    const codex = mergeCodex(prof.runs.map((r) => r.codex));
    const cc = codexCount(codex, this.index);
    const deaths = new Map<string, number>();
    for (const r of prof.runs) if (r.end === 'died' && r.deathCause) deaths.set(r.deathCause, (deaths.get(r.deathCause) ?? 0) + 1);
    const speciesMet = this.index.species.filter((s) => (codex.species[s.id]?.met ?? 0) > 0).length;
    const e = w.entities[w.players[pid].entityId];
    return {
      report,
      expedition: x && report ? {
        slot: x.slot ?? null, trait_danger: (x.traits ?? []).reduce((a, id) => a + (traits[id]?.danger ?? 0), 0), rechallenge: !!x.rechallengeOf, objective: x.objective.type,
        guardian_slain: !!report.combat.guardian_fights?.some((f) => f.outcome === 'slain'),
        warden_slain: run.wardens.some((d) => !wardensBefore.includes(d)),
        floors_unhurt: e ? floorsUnhurt(session.expeditionEvents(pid, x.no), e.id) : 0,
      } : null,
      run: {
        ended: run.status === 'ended', end: run.end, expeditions: run.expeditions, completed: run.completed, withdrawn: run.withdrawn,
        lifeline: reports.filter((r) => r.reason === 'lifeline').length, streak, banked: run.banked, deepest: run.deepest, level: run.level,
        kills: w.players[pid].stats.kills, legacy: run.legacy,
      },
      profile: {
        runs: prof.runs.length, same_death_max: Math.max(0, ...deaths.values()), codex_found: cc.found, codex_total: cc.total,
        codex_pct: cc.total ? Math.floor((cc.found * 100) / cc.total) : 0, species_met: speciesMet, species_total: this.index.species.length,
        species_left: this.index.species.length - speciesMet, wardens: new Set(prof.runs.flatMap((r) => r.wardens)).size,
      },
    };
  }

  records(profileId: string, L: Locale): { records: ProfileRecords; lines: string[] } | null {
    const p = this.store.get(profileId);
    if (!p) return null;
    const name = (k: string) => kindName(this.catalog, L, k);
    const ab = (a: string) => abilityName(L, a);
    const records = buildRecords(L, p, this.index, this.feats, { milestone: this.catalog.rules?.milestone ?? null, kindName: name, abilityName: ab });
    return { records, lines: recordsLines(L, records, { kindName: name, className: name }) };
  }

  campLine(profileId: string, L: Locale, firstOf?: string): string | null {
    const r = this.records(profileId, L);
    if (!r) return null;
    const line = recordsCampLine(L, r.records);
    // 2 回目以降のランの最初のキャンプ: 前のランまでの確定の最高・最深を先頭に（V3-8 §53.5: records を呼ばなくても目に入るように）
    const before = firstOf ? (this.store.get(profileId)?.runs ?? []).filter((x) => x.runId !== firstOf && x.status === 'ended') : [];
    if (!before.length) return line;
    const best = Math.max(...before.map((x) => x.banked));
    const deep = Math.max(...before.map((x) => x.deepest));
    return t(L, `前のランまで: 確定の最高 ${best}・最深 地下${deep}階（${before.length} ラン）。`, `Earlier runs: best banked ${best}, deepest ${deep} (${before.length} runs). `) + line;
  }

  /** その遠征で取った実績の名前（キャンプの遠征レポートの行） */
  featsOf(profileId: string | null, runId: string, no: number, L: Locale): string[] {
    const p = profileId ? this.store.get(profileId) : null;
    if (!p) return [];
    return p.feats.filter((f) => f.runId === runId && f.no === no).map((f) => {
      const d = this.content.feats[f.id];
      return d ? (L === 'en' ? d.name.en : d.name.ja) : f.id;
    });
  }
}

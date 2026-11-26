// 拠点の運用者の口（S12b。SEASON.md §63.7・PROTOCOL.md §9.15）: 名簿・シーズンを始める・冒険者を足す・鍵のある冒険者を今のシーズンに加える。
// HTTP の口（http/api.ts）は、サーバーと同じ PC からの要求（isLocalRequest。状態を変える口の守りも、今までどおり先に通る）だけをここへ渡す。
// ここは認め方を持たない。シーズンを開くのと招くのは、運用の道具（tools/src/season.ts）と同じ関数（SeasonService の openBlockers・open・invite）。
// 鍵（プロフィールのトークン）は、冒険者を足した応答の 1 回だけ。シードは、どの応答にも出さない。どちらも、ログ・記録・エラーの文に出さない。
import { randomBytes } from 'node:crypto';
import type { ActionError, Controller, Locale, OpsAdventurerAdded, OpsEnrolled, OpsRosterEntry, OpsRosterResponse, OpsSeasonOpened } from '@muse/shared';
import { actionError } from '@muse/shared';
import type { SeasonDef } from '../season/SeasonService';
import { normalizeName } from './names';
import { isKnownClass } from './SessionManager';
import type { SessionManager } from './SessionManager';

/** 上限と下限（SEASON.md §63.7 の 1。日数・予算は整数） */
export const OPS_LIMITS = { days: { min: 1, max: 60, def: 7 }, budget: { min: 100, max: 20_000, def: 3000 }, name: 32 } as const;

export type OpsResult<T> = { status: 200; body: T } | { status: number; error: ActionError };

const DAY_MS = 86_400_000;

/** 整数で、範囲の中か。省けば既定 */
function intIn(v: unknown, lim: { min: number; max: number; def: number }): number | null {
  if (v === undefined || v === null) return lim.def;
  return typeof v === 'number' && Number.isInteger(v) && v >= lim.min && v <= lim.max ? v : null;
}

const bad = (message: string, hint = ''): { status: number; error: ActionError } => ({ status: 400, error: actionError('bad_request', message, hint) });
const conflict = (message: string, hint = ''): { status: number; error: ActionError } => ({ status: 409, error: actionError('season_unavailable', message, hint) });

/** 確定していないシーズンがあるときの断り（画面からは閉じられない: §63.5 の 1） */
const UNRESOLVED = '開催中のシーズンがある。閉じるのは、運用の道具で / a season is still open; close it with the operator tool';

/** ランの操作の種類 → 名簿の種類（人間・AI。分からなければ null） */
function kindOfRun(m: SessionManager, runId: string, profileId: string): 'ai' | 'human' | null {
  const s = m.get(runId);
  let c: Controller | undefined;
  if (s) {
    const pid = s.world.playerOrder.find((p) => s.profileOf(p) === profileId) ?? s.world.playerOrder[0];
    c = pid ? s.world.players[pid]?.controller : undefined;
  } else {
    c = m.store?.meta(runId)?.players[0]?.controller;
  }
  return c?.kind === 'human' ? 'human' : c?.kind === 'agent' ? 'ai' : null;
}

/** GET /api/ops/roster */
export function opsRoster(m: SessionManager): OpsRosterResponse {
  const svc = m.seasons;
  const cur = svc.currentOpen();
  const blk = svc.openBlockers('');
  const pending = blk.unresolved.filter((d) => d.def.id !== cur?.def.id).map((d) => ({ id: d.def.id, name: d.def.name }));
  const canOpen = !blk.unresolved.length && !blk.broken.length;
  const roster: OpsRosterEntry[] = cur
    ? svc.roster(cur.def.id, (runId) => !!m.recoveryFailedError(runId)).map((x) => ({
      ...x, budget: cur.def.budget, kind: x.kind ?? (x.runId ? kindOfRun(m, x.runId, x.profileId) : null),
    }))
    : [];
  const next = canOpen ? svc.nextDefault() : null;
  return {
    season: cur ? { id: cur.def.id, name: cur.def.name, budget: cur.def.budget, endsAt: cur.def.endsAt } : null,
    roster, pending, canOpen,
    ...(next ? { next: { ...next, days: OPS_LIMITS.days.def, budget: OPS_LIMITS.budget.def } } : {}),
    ...(blk.broken.length ? { broken: true as const } : {}),
  };
}

/**
 * POST /api/ops/season `{ name?, days?, budget? }`: 新しいシーズンを開く。ID はサーバーが決め（s<数>）、シードは暗号用の乱数（返さない）。
 * 確定していないシーズン・記録が読めないシーズンがあれば断る（画面からは閉じられない）
 */
export function opsOpenSeason(m: SessionManager, body: unknown, now = Date.now()): OpsResult<OpsSeasonOpened> {
  const b = (body && typeof body === 'object' ? body : {}) as { name?: unknown; days?: unknown; budget?: unknown };
  const days = intIn(b.days, OPS_LIMITS.days);
  if (days === null) return bad(`日数は ${OPS_LIMITS.days.min}〜${OPS_LIMITS.days.max} の整数 / days must be an integer from ${OPS_LIMITS.days.min} to ${OPS_LIMITS.days.max}`, '{ name?, days?, budget? }');
  const budget = intIn(b.budget, OPS_LIMITS.budget);
  if (budget === null) return bad(`予算は ${OPS_LIMITS.budget.min}〜${OPS_LIMITS.budget.max} の整数（手番） / budget must be an integer from ${OPS_LIMITS.budget.min} to ${OPS_LIMITS.budget.max}`, '{ name?, days?, budget? }');
  const svc = m.seasons;
  const blk = svc.openBlockers('');
  if (blk.broken.length) return conflict(`記録が読めないシーズン（${blk.broken.map((x) => x.id).join('・')}）があるので、新しいシーズンは始めない（運用の道具で、直してから） / a season's records are unreadable; no new season is opened`);
  if (blk.unresolved.length) return conflict(UNRESOLVED, '終わりの時刻を過ぎたシーズンは、全員が戻るか、1 時間たつと確定する / a season past its end is finalized once everyone is back, or after an hour');
  const nx = svc.nextDefault();
  // 名前は、名前を整える 1 つの関数で（S12c）。省いた・空（空白だけ）なら、サーバーが決める（重ならない「シーズン N」）
  let name = nx.name;
  if (b.name !== undefined && b.name !== null && !(typeof b.name === 'string' && !b.name.trim())) {
    const nm = normalizeName(b.name, OPS_LIMITS.name);
    if (!nm.ok) return bad(nm.message, '{ name?, days?, budget? }');
    name = nm.name;
  }
  const def: SeasonDef = {
    id: nx.id, name, seed: randomBytes(16).toString('base64url'), engineVersion: svc.versions.engineVersion, contentVersion: svc.versions.contentVersion,
    budget, endsAt: now + days * DAY_MS, openedAt: now,
  };
  try {
    svc.open(def);
  } catch {
    // 例外の文には、置き場所のパスが入りうるので出さない
    return conflict('シーズンを開けなかった（同じ ID がある・書けない）。もう一度試す / could not open the season');
  }
  return { status: 200, body: { season: { id: def.id, name: def.name, budget: def.budget, endsAt: def.endsAt } } };
}

/** 冒険者の名前（名前を整える 1 つの関数で。1〜32 字。招くときの invite も、同じ関数でもう一度見る） */
function adventurerName(raw: unknown): string | { status: number; error: ActionError } {
  if (raw === undefined || raw === null || raw === '') return bad('名前が要る / name is required', '{ name, kind: "ai" | "human", classId? }');
  const nm = normalizeName(raw, OPS_LIMITS.name);
  return nm.ok ? nm.name : bad(nm.message, '{ name, kind: "ai" | "human", classId? }');
}

/** 内部のエラーの決まった文（S12c: 中の例外の文は、応答に出さない。詳細はサーバーのログ） */
export function internalError(): ActionError {
  return actionError('bad_request', '内部のエラー（詳細はサーバーのログ） / internal error (details are in the server log)', '');
}

/** 冒険者を足す先（今のシーズン。版がこのサーバーと同じこと） */
function targetSeason(m: SessionManager): { id: string } | { status: number; error: ActionError } {
  const cur = m.seasons.currentOpen();
  if (!cur) return conflict('開催中のシーズンが無い。先に、新しいシーズンを始める / no season is open; start one first');
  const v = m.seasons.versions;
  if (cur.def.engineVersion !== v.engineVersion || cur.def.contentVersion !== v.contentVersion) return conflict(`シーズン ${cur.def.id} は、このサーバーと版が違う / season ${cur.def.id} is on a different version from this server`);
  return { id: cur.def.id };
}

/**
 * POST /api/ops/adventurers `{ name, kind: "ai" | "human", classId?, locale? }`: プロフィールを作り、今のシーズンに招く（運用の道具の invite と同じ関数）。
 * ai: 鍵を、この応答の 1 回だけ返す。human: そのうえで人間のラン（controller human・そのシーズン・その職）を始め、POST /api/runs と同じ値も返す。
 * ランを始められなければ、招きを取り消して断る（プロフィールは残る。鍵は返さない）
 */
export async function opsAddAdventurer(m: SessionManager, body: unknown): Promise<OpsResult<OpsAdventurerAdded>> {
  const b = (body && typeof body === 'object' ? body : {}) as { name?: unknown; kind?: unknown; classId?: unknown; locale?: unknown };
  if (b.kind !== 'ai' && b.kind !== 'human') return bad('kind は "ai"（AI に任せる）か "human"（自分で潜る） / kind must be "ai" or "human"', '{ name, kind: "ai" | "human", classId? }');
  const kind: 'ai' | 'human' = b.kind;
  const nm = adventurerName(b.name);
  if (typeof nm !== 'string') return nm;
  let classId: string | undefined;
  if (kind === 'human' && b.classId !== undefined && b.classId !== null) {
    // 自分の持つ鍵かどうかで見る（S12c: constructor・__proto__ などの名前を「知っている職」にしない）
    if (typeof b.classId !== 'string' || !isKnownClass(m.deps.content.classes, b.classId)) return bad('知らない職 / unknown class', `classes: ${Object.keys(m.deps.content.classes).join(', ')}`);
    classId = b.classId;
  }
  const locale: Locale = b.locale === 'en' ? 'en' : 'ja';
  const t = targetSeason(m);
  if ('error' in t) return t;
  const inv = m.seasons.invite(t.id, nm, m.profiles.store, undefined, { kind });
  if ('error' in inv) return bad(inv.error);
  const profileToken = inv.token!;
  const base = { seasonId: t.id, name: inv.name, profileId: inv.profileId, kind, profileToken };
  if (kind === 'ai') return { status: 200, body: base };
  // ランを始められない・途中で例外が出たときは、招きを取り消す（できたランは、createRun が捨てる。S12c）
  let r: Awaited<ReturnType<SessionManager['createRun']>>;
  try {
    r = await m.createRun({ name: inv.name, ...(classId ? { classId } : {}), locale, controller: { kind: 'human', label: 'browser' }, season: t.id, profileToken });
  } catch (e) {
    console.error(`[ops] 自分で潜る冒険者のランを始められなかった（招きは取り消した）: ${String((e as Error)?.stack ?? e)}`);
    m.seasons.uninvite(t.id, { profileId: inv.profileId });
    return { status: 500, error: internalError() };
  }
  if ('error' in r) {
    m.seasons.uninvite(t.id, { profileId: inv.profileId });
    return { status: r.error.code === 'season_unavailable' || r.error.code === 'run_in_progress' ? 409 : 400, error: r.error };
  }
  return { status: 200, body: { ...base, runId: r.session.runId, playerId: r.playerId, token: r.token } };
}

/**
 * POST /api/ops/uninvite `{ profileId }`（S12c。鍵を無くしたときの道）: 今のシーズンの招きを取り消す。ランを 1 回も始めていない招きだけ
 * （運用の道具の uninvite と同じ関数・同じ決まり）。プロフィールは残る（その鍵では、もうこのシーズンに入れない）
 */
export function opsUninvite(m: SessionManager, body: unknown): OpsResult<{ seasonId: string; name: string; profileId: string }> {
  const b = (body && typeof body === 'object' ? body : {}) as { profileId?: unknown };
  if (typeof b.profileId !== 'string' || !/^prof_[0-9a-f]{1,32}$/.test(b.profileId)) return bad('profileId が要る（名簿の profileId） / profileId is required', '{ profileId }');
  const t = targetSeason(m);
  if ('error' in t) return t;
  const r = m.seasons.uninvite(t.id, { profileId: b.profileId });
  if ('error' in r) return { status: r.error.includes('始めている') ? 409 : 400, error: actionError('bad_request', r.error, '') };
  return { status: 200, body: { seasonId: t.id, name: r.name, profileId: r.profileId } };
}

/**
 * POST /api/ops/enroll（見出し Authorization: Bearer <鍵>）`{ name? }`: その鍵のプロフィールを、今のシーズンに招く（表示名は name、無ければプロフィールの名前）。
 * もう招かれていれば、そのまま通す（already）
 */
export function opsEnroll(m: SessionManager, key: string | undefined, body: unknown): OpsResult<OpsEnrolled> {
  if (!key) return { status: 401, error: actionError('no_session', '鍵が要る（Authorization の見出しで） / the key is required (in the Authorization header)', 'Authorization: Bearer <profile_token>') };
  const prof = m.profiles.store.resolve(key);
  if (!prof) return { status: 401, error: actionError('no_session', 'その鍵は、見つからない / unknown key', '') };
  const t = targetSeason(m);
  if ('error' in t) return t;
  const have = m.seasons.store.invites(t.id).find((x) => x.profileId === prof.id);
  if (have) return { status: 200, body: { seasonId: t.id, name: have.name, profileId: prof.id, already: true } };
  const b = (body && typeof body === 'object' ? body : {}) as { name?: unknown };
  let name = '';
  if (b.name !== undefined && b.name !== null) {
    const nm = adventurerName(b.name);
    if (typeof nm !== 'string') return nm;
    name = nm;
  }
  const inv = m.seasons.invite(t.id, name, m.profiles.store, key);
  if ('error' in inv) return bad(inv.error);
  return { status: 200, body: { seasonId: t.id, name: inv.name, profileId: inv.profileId } };
}

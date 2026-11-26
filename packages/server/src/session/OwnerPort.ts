// 持ち主の口（S8。SEASON.md §54.1・§54.5）: 人間の画面から、キャンプで、握った項目を決める。MCP のツールには出さない。
// 持ち主が見るのは、そのプレイヤーの PlayerView と、そこから作る観測だけ（プレイヤーより多くを見せない）。命令は、プレイヤーと同じ Command を、
// 同じ道（RunSession.submit → engine の step）で流す。違うのは出どころ（source: owner）だけ。プレイヤーの応答の基準（turn.changes）は動かさない。
// S9（§58.1・§58.2）: 支度（prepare: 目的を選ぶ・準備完了）もこの口から。遠征を始めるのはプレイヤー（持ち主の start_expedition は engine が断る）。
import type { ActionError, Command, DirectiveItem, DirectiveUndecided, Observation, OwnerPace, OwnerRunRow, OwnerViewResponse, PlayerId, PlayerView } from '@muse/shared';
import { actionError, activeWishes, CommandSchema, directiveUndecided, OWNER_COMMANDS, OWNER_PACES, ownerWaitOpen, prepStateView, seasonFinalText, t } from '@muse/shared';
import { directiveTarget, ENGINE_VERSION } from '@muse/engine';
import type { RunSession } from './RunSession';
import { SessionPlayerPort } from './PlayerPort';

/** 指図を出せないなら、その理由（§54.1: ソロで、プレイヤーが人間でないランだけ） */
export function ownerIneligible(session: RunSession, pid: PlayerId): string | null {
  const w = session.world;
  const pr = w.players[pid];
  if (!pr) return 'no such player';
  if (!directiveTarget(w, pr)) {
    return w.meta.mode !== 'solo'
      ? t(pr.locale, '協力プレイのランには、指図は無い。', 'Co-op runs have no directives.')
      : t(pr.locale, '人間が自分で遊ぶランには、指図は無い。', 'Runs played by a human have no directives.');
  }
  return null;
}

/** AI が持ち主の支度を待っているか（§54.5。S9 §58.1: キャンプで、支度の札が「まだ」で、次の遠征を始められる） */
export function ownerWaited(view: PlayerView): boolean {
  return ownerWaitOpen(view);
}

/** AI との行き来（S9 §58.1。サーバーの控えから。World に入れない） */
function aiOf(session: RunSession, pid: PlayerId, now = Date.now()): { lastCallAgoS: number | null; waitingNow: boolean } {
  const at = session.lastCallAt(pid);
  return { lastCallAgoS: at === null ? null : Math.max(0, Math.round((now - at) / 1000)), waitingNow: session.waitingForOwner(pid) };
}

/** 持ち主の見るもの: プレイヤーの PlayerView と観測（AI に見えているのと同じ文と数字）。何も消費しない・基準を動かさない */
export function ownerView(session: RunSession, pid: PlayerId): OwnerViewResponse {
  const port = new SessionPlayerPort(session, pid);
  const view = port.view();
  const o: { observation: Observation; text: string } = port.observe({ detail: 'full', map: false });
  const why = ownerIneligible(session, pid);
  return {
    runId: session.runId, playerId: pid, name: view.self.name,
    eligible: !why, ...(why ? { reason: why } : {}),
    waiting: !why && ownerWaited(view),
    ...(!why ? { ai: aiOf(session, pid), pace: session.ownerPace(pid) } : {}),
    ...(oldVersionRun(session) ? { oldVersion: true as const } : {}),
    view, observation: o.observation, text: o.text,
  };
}

/** そのプレイヤーが参加して、終わった遠征の数（S14。拠点の「続けて遊ばせる」が数える。World から数えるだけ） */
function expeditionsEndedOf(session: RunSession, pid: PlayerId): number {
  return (session.world.expeditions ?? []).filter((x) => x.participants.includes(pid) && x.status === 'ended').length;
}

/**
 * 進め方の希望を変える（S14。SEASON.md §65.4 の 2。POST …/owner/pace）。握る項目ではない: プロフィールに控えるだけ（World に入れない・出来事も足さない・
 * 支度の札も戻さない）。指図と同じく、指図を出せる冒険者（ソロで、人間が自分で遊んでいない）だけ・キャンプにいるときだけ（遠征の途中は、口をはさまない）。
 * 確定したシーズンのランは、ほかの持ち主の口と同じく season_ended。断りは、指図と同じ code と文
 */
export function ownerSetPace(session: RunSession, pid: PlayerId, raw: unknown, setPace: (profileId: string | null, pace: OwnerPace) => boolean | null): { ok: true } | { ok: false; error: ActionError } {
  const L = session.world.players[pid]?.locale ?? 'ja';
  if (typeof raw !== 'string' || !(OWNER_PACES as readonly string[]).includes(raw)) {
    return { ok: false, error: actionError('bad_request', t(L, '進め方は、self（自分で考えて進む）か pilot（pilot で進める）。', 'pace is self (play on your own) or pilot (play with pilot).'), '{ pace: "self" | "pilot" }') };
  }
  const why = ownerIneligible(session, pid);
  if (why) return { ok: false, error: actionError('bad_request', why, '') };
  if (session.seasonFinal()) return { ok: false, error: actionError('season_ended', seasonFinalText(L, session.world.meta.season!.name), '') };
  if (session.world.players[pid]?.state !== 'at_camp') {
    return { ok: false, error: actionError('not_at_camp', t(L, '指図と支度は、キャンプでだけ変えられる（遠征の途中は、見守る）。', 'Directives and preparations can be changed only at camp (during an expedition, you watch).'), t(L, 'AI がキャンプに戻ってから。', 'Wait until your AI is back at camp.')) };
  }
  const r = setPace(session.profileOf(pid), raw as OwnerPace);
  if (r === null) return { ok: false, error: actionError('bad_request', t(L, 'この冒険者には、プロフィールが無いので、進め方の希望を覚えられない。', 'This adventurer has no profile, so the pace wish cannot be kept.'), '') };
  return { ok: true };
}

/** このサーバーと違う版の engine で始まったラン（S10a。続きは遊べない: SessionManager.continuable） */
function oldVersionRun(session: RunSession): boolean {
  return session.world.meta.engineVersion !== ENGINE_VERSION;
}

/** 一覧の 1 行（ホームの「出撃」の、自分のランの枠） */
export function ownerRow(session: RunSession, pid: PlayerId, season?: { name: string; participant?: string }): OwnerRunRow {
  const view = session.view(pid);
  const why = ownerIneligible(session, pid);
  const d = view.directive;
  const sm = session.world.meta.season;
  const st = prepStateView(view);
  const wishes = !why && view.status === 'at_camp' ? activeWishes(view).length : 0;
  return {
    runId: session.runId, playerId: pid, name: view.self.name, classId: view.self.classId,
    ...(sm ? { season: { id: sm.id, name: season?.name ?? sm.name, ...(season?.participant ? { participant: season.participant } : {}) } } : {}),
    status: view.status === 'at_camp' ? 'at_camp' : view.status === 'dead' || view.status === 'ended' ? 'ended' : 'in_dungeon',
    eligible: !why, waiting: !why && ownerWaited(view),
    hold: [...(d?.hold ?? [])] as DirectiveItem[], message: d?.message ?? '',
    level: view.self.level, hp: view.self.stats.hp, maxHp: view.self.stats.maxHp, depth: view.floor?.depth ?? null,
    banked: view.record.banked, ...(view.season ? { budgetLeft: Math.max(0, view.season.budgetLeft), budgetLimit: view.season.budget.limit } : {}),
    // 持ち主が、まだ決めていないもの（S9a §57.3 の 2。AI に見えている観測の self.directive.undecided と同じもの）
    ...((): { undecided?: DirectiveUndecided } => { const u = !why ? directiveUndecided(view, session.deps.catalog) : null; return u ? { undecided: u } : {}; })(),
    // 支度の札・希望・AI との行き来（S9 §58.1・§58.2）
    ...(!why && st ? { prep: { state: st, ...(d?.hold.includes('objective') && d.prep?.objective !== undefined ? { objective: d.prep.objective } : {}) } } : {}),
    ...(wishes ? { wishes } : {}),
    ...(!why ? { ai: aiOf(session, pid), pace: session.ownerPace(pid) } : {}),
    ...(oldVersionRun(session) ? { oldVersion: true as const } : {}),
    // 終わった遠征の数（S14。拠点の「続けて遊ばせる」が、回数を数える）
    expeditionsEnded: expeditionsEndedOf(session, pid),
    updatedAt: session.updatedAt,
  };
}

/**
 * 持ち主の命令を流す（§54.3・S9 §58.1）。受けるのは set_directive・prepare と、握れる項目の命令だけ（equip・unequip・choose_perk・choose_boon。
 * start_expedition は engine が断る: 遠征を始めるのはプレイヤー）。形の検査は Command のスキーマ（プレイヤーと同じ）。断りは engine のもの（手番を使わず、World を変えない）
 */
export async function ownerAct(session: RunSession, pid: PlayerId, raw: unknown): Promise<{ ok: true } | { ok: false; error: ActionError }> {
  const L = session.world.players[pid]?.locale ?? 'ja';
  const parsed = CommandSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: actionError('bad_request', t(L, '命令の形が違う。', 'Malformed command.'), parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300)) };
  const cmd: Command = parsed.data;
  if (!OWNER_COMMANDS.has(cmd.type)) {
    return { ok: false, error: actionError('bad_request', t(L, '持ち主の口から出せるのは、set_directive・prepare と、握った項目の命令（equip・unequip・choose_perk・choose_boon）だけ。', 'From the owner you can send set_directive, prepare and the held items\' commands (equip, unequip, choose_perk, choose_boon) only.'), '') };
  }
  const why = ownerIneligible(session, pid);
  if (why) return { ok: false, error: actionError('bad_request', why, '') };
  const r = await session.submit(pid, cmd, { source: 'owner' });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

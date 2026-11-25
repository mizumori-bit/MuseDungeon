// 持ち主の口（S8。SEASON.md §54.1・§54.5）: 人間の画面から、キャンプで、握った項目を決める。MCP のツールには出さない。
// 持ち主が見るのは、そのプレイヤーの PlayerView と、そこから作る観測だけ（プレイヤーより多くを見せない）。命令は、プレイヤーと同じ Command を、
// 同じ道（RunSession.submit → engine の step）で流す。違うのは出どころ（source: owner）だけ。プレイヤーの応答の基準（turn.changes）は動かさない。
import type { ActionError, Command, DirectiveItem, DirectiveUndecided, Observation, OwnerRunRow, OwnerViewResponse, PlayerId, PlayerView } from '@muse/shared';
import { actionError, CommandSchema, directiveUndecided, ownerWaitOpen, t } from '@muse/shared';
import { directiveTarget, heldItemOf } from '@muse/engine';
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

/** AI が持ち主の決定を待っているか（§54.5: キャンプで、目的を握られていて、次の遠征を始められる） */
export function ownerWaited(view: PlayerView): boolean {
  return ownerWaitOpen(view);
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
    view, observation: o.observation, text: o.text,
  };
}

/** 一覧の 1 行（ホームの「出撃」の、自分のランの枠） */
export function ownerRow(session: RunSession, pid: PlayerId, season?: { name: string; participant?: string }): OwnerRunRow {
  const view = session.view(pid);
  const why = ownerIneligible(session, pid);
  const d = view.directive;
  const sm = session.world.meta.season;
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
    updatedAt: session.updatedAt,
  };
}

/**
 * 持ち主の命令を流す（§54.3）。受けるのは set_directive と、握れる項目の命令だけ（start_expedition・equip・unequip・choose_perk・choose_boon）。
 * 形の検査は Command のスキーマ（プレイヤーと同じ）。断りは engine のもの（手番を使わず、World を変えない）
 */
export async function ownerAct(session: RunSession, pid: PlayerId, raw: unknown): Promise<{ ok: true } | { ok: false; error: ActionError }> {
  const L = session.world.players[pid]?.locale ?? 'ja';
  const parsed = CommandSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: actionError('bad_request', t(L, '命令の形が違う。', 'Malformed command.'), parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, 300)) };
  const cmd: Command = parsed.data;
  if (cmd.type !== 'set_directive' && !heldItemOf(cmd)) {
    return { ok: false, error: actionError('bad_request', t(L, '持ち主の口から出せるのは、set_directive と、握った項目の命令（start_expedition・equip・unequip・choose_perk・choose_boon）だけ。', 'From the owner you can send set_directive and the held items\' commands (start_expedition, equip, unequip, choose_perk, choose_boon) only.'), '') };
  }
  const why = ownerIneligible(session, pid);
  if (why) return { ok: false, error: actionError('bad_request', why, '') };
  const r = await session.submit(pid, cmd, { source: 'owner' });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

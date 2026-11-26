// 続けて遊ばせる（S14）の、ブラウザの側の小さい道具: 一覧の読み直し・呼び鈴を送る。決める所は ui/keepGoing.ts。
// S15: 呼び鈴は、この PC の受け口だけ（人の操作が要らない。リンクを開く・光らせて押してもらう・短い音は、外した）
import type { OwnerRunRow } from '@muse/shared';
import { api } from '../api';
import { bellRingOf, readBellConfig, ringPort, type BellRing } from './bell';
import { keyForRun } from './keys';
import { kgPortFailed, kgPortOk, kgRang, kgRead, kgWrite, type KgObs, type KgState, type KgWhere } from './keepGoing';

/**
 * そのランの様子（持ち主の口の一覧の行。鍵は、そのランの冒険者のもの。無ければ同じ PC から）。
 * 一覧に無ければ、ランが終わったか（ランの meta）・シーズンが確定したか（シーズンの一覧）を確かめる。読めなければ error（何もしない）
 */
export async function kgObserveRun(st: Pick<KgState, 'runId' | 'seasonId'>): Promise<KgObs> {
  try {
    const tok = await keyForRun(st.runId);
    const r = await api.ownerRuns(tok);
    const row: OwnerRunRow | undefined = r.runs.find((x) => x.runId === st.runId);
    if (row) return { kind: 'row', row };
    const meta = await api.meta(st.runId).catch(() => null);
    if (meta?.status === 'ended') return { kind: 'gone', why: 'ended' };
    if (st.seasonId) {
      const ss = await api.seasons().catch(() => null);
      const s = ss?.find((x) => x.id === st.seasonId);
      if (s && s.status !== 'open') return { kind: 'gone', why: 'season_over' };
    }
    return { kind: 'gone', why: 'unknown' };
  } catch {
    return { kind: 'error' };
  }
}

/**
 * 鳴らす（受け口へ送る）。つながらなければ false（S14a）。鳴らした記録と、受け口に送れなかった知らせを、状態に書く
 */
export async function kgRingVia(r: BellRing, st: KgState, where: KgWhere, now: number): Promise<boolean> {
  // 送っている間に、ほかのタブが重ねて鳴らさないよう、先に鳴らした記録を書く
  kgWrite(kgRang(st, where, now));
  const ok = await ringPort(r);
  const cur = kgRead(st.runId);
  if (cur) kgWrite(ok ? kgPortOk(cur) : kgPortFailed(cur, r.port, Date.now()));
  return ok;
}

/** 「もう一度鳴らす」（人が押した）。鳴らした記録に足す（キャンプで鳴らした回数には数えない） */
export async function kgRingNow(st: KgState): Promise<void> {
  const r = bellRingOf(readBellConfig(), { season: st.seasonId, run: st.runId, pace: st.pace ?? null });
  if (!r) return;
  const fresh = kgRead(st.runId) ?? st;
  await kgRingVia(r, fresh, fresh.seen?.where ?? 'camp', Date.now());
}

// 続けて遊ばせる（S14）の、ブラウザの側の小さい道具: 一覧の読み直し・呼び鈴を開く・短い音。決める所は ui/keepGoing.ts。
import type { OwnerRunRow } from '@muse/shared';
import { api } from '../api';
import { bellRingOf, readBellConfig, ringBell, ringPort, type BellRing } from './bell';
import { keyForRun } from './keys';
import { kgNoteInput, kgNoteLaunch, kgPortFailed, kgPortOk, kgRang, kgRead, kgWrite, type KgObs, type KgState, type KgWhere } from './keepGoing';

/** 人の操作の直後か（分からなければ null） */
export function activationNow(): boolean | null {
  try {
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
    return ua ? ua.isActive : null;
  } catch {
    return null;
  }
}

// ---- 短い音（呼び鈴を鳴らせなかったかもしれないとき）。ブラウザは、人の操作の後でないと音を出させないので、「始める」を押したときに用意する ----
let audio: AudioContext | null = null;

/** 「始める」「今、鳴らす」を押したときに呼ぶ（音を出せるようにしておく） */
export function kgPrimeChime(): void {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audio ??= new AC();
    void audio.resume();
  } catch { /* 音は出さない */ }
}

/** 短い 2 つの音（用意していなければ、鳴らない） */
export function kgChime(): void {
  try {
    if (!audio) return;
    void audio.resume();
    const t0 = audio.currentTime + 0.02;
    for (const [i, f] of [880, 660].entries()) {
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.22);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.22 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.22 + 0.2);
      o.connect(g).connect(audio.destination);
      o.start(t0 + i * 0.22);
      o.stop(t0 + i * 0.22 + 0.22);
    }
  } catch { /* 音は出さない */ }
}

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
 * 鳴らす（今の設定の鳴らし方で）。リンクは開くだけ（届いたかは分からない）。受け口は送って、つながらなければ false（S14a）。
 * 鳴らした記録と、受け口に送れなかった知らせを、状態に書く。maybeBlocked: リンクを、人の操作なしに開いた（止められたかもしれない）
 */
export async function kgRingVia(r: BellRing, st: KgState, where: KgWhere, now: number, maybeBlocked: boolean): Promise<boolean> {
  if (r.via === 'link') {
    ringBell(r.url);
    kgNoteLaunch(now);
    kgWrite(kgRang(st, where, now, maybeBlocked, 'link'));
    return true;
  }
  // 送っている間に、ほかのタブが重ねて鳴らさないよう、先に鳴らした記録を書く
  kgWrite(kgRang(st, where, now, false, 'port'));
  const ok = await ringPort(r);
  const cur = kgRead(st.runId);
  if (cur) kgWrite(ok ? kgPortOk(cur) : kgPortFailed(cur, r.port, Date.now()));
  return ok;
}

/** 「今、鳴らす」「もう一度鳴らす」（人が押した: ブラウザはリンクも通す）。札の光を消し、鳴らした記録に足す（キャンプで鳴らした回数には数えない） */
export async function kgRingNow(st: KgState): Promise<void> {
  const r = bellRingOf(readBellConfig(), { season: st.seasonId, run: st.runId, pace: st.pace ?? null });
  if (!r) return;
  kgPrimeChime();
  const now = Date.now();
  kgNoteInput(now);
  const fresh = kgRead(st.runId) ?? st;
  await kgRingVia(r, fresh, fresh.attention?.where ?? fresh.seen?.where ?? 'camp', now, false);
}

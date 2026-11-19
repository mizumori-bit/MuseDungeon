// 自動で返事をする簡単な相手（IMPROVEMENTS_V4 §10.8・§14.8 の計測用。AI の代わり）。起こされたら orders.json を書くだけ。
// よくある場面（倒せない相手・HP が減った・queue の失敗）は pilot が自分で続ける（§14.1〜§14.5）ので、返事は薄い:
//   キャンプ     → state.json の候補のうち、大守護者に挑む（節目）を除いて順に回して出発（同じ遠征をくり返さない）
//   目的の相手・品 → engage_objective: true（以後は pilot が挑む・拾う）
//   特技・加護   → 最初の候補
//   動けない（refused_hostile_adjacent・refused_blocked） → じゃまをしている敵（detail の先頭の行）と戦う
//   危ない・行き詰まり・やることが無い・目的の相手を諦めた → 帰る（帰還の綱）
// それ以外は「わかった」とだけ返す（rev を上げる）。知らせる（notify）には返事をしない。
// 自分の返事の相手（--wake-cmd や --wake-url の先）を書くときの手本にもなる。
import type { QueuedCommand } from './orders';
import { defaultOrders, readOrders, writeJsonAtomic } from './orders';
import type { WakeEvent } from './pilot';

const HOME: QueuedCommand[] = [{ tool: 'use_item', args: { slot: 'lifeline' } }];
/** orders.json ごとの、キャンプで起こされた回数 */
const camps = new Map<string, number>();

export function simpleResponder(ev: WakeEvent): void {
  if (ev.level !== 'wake' || ev.reason === 'ended' || ev.reason === 'safety') return;
  let cur;
  try { cur = readOrders(ev.ordersPath) ?? defaultOrders(); } catch { cur = defaultOrders(); }
  const next = { ...cur, rev: cur.rev + 1, mode: 'auto' as const, queue: [] as QueuedCommand[], policy: { ...cur.policy, ignore: [], unignore: [] } };
  const role = ev.reason.replace(/_hunting$/, '');
  switch (role) {
    case 'camp': {
      const n = camps.get(ev.ordersPath) ?? 0;
      camps.set(ev.ordersPath, n + 1);
      const offers = (ev.state.camp?.offers ?? []).filter((o) => o.type !== 'slay_warden');
      next.queue = [{ tool: 'start_expedition', args: { offer: offers.length ? offers[n % offers.length]!.index : 1 + (n % 3) } }];
      // 新しい遠征: 目的の相手は、見えたらまた起こしてもらう
      next.policy.engage_objective = false;
      break;
    }
    case 'perk_pending': next.queue = [{ tool: 'choose_perk', args: { option: 1 } }]; break;
    case 'boon_pending': next.queue = [{ tool: 'choose_boon', args: { option: 1 } }]; break;
    case 'guardian_seen': case 'warden_seen': case 'elite_seen': case 'relic_seen':
      next.policy.engage_objective = true;
      break;
    case 'refused_hostile_adjacent': case 'refused_blocked': {
      // じゃまをしている敵（blocked_by の行が detail の先頭）と戦う（倒したら、届く追跡中の敵も片付ける）。
      // 守護者・大守護者など役割のある敵なら戦わずに帰る（state.json の hostiles の role で見る）
      const id = /\be_[0-9a-z]{6}\b/.exec(ev.detail)?.[0];
      const h = id ? ev.state.hostiles.find((x) => x.id === id) : undefined;
      next.queue = id && !h?.role ? [{ tool: 'fight', args: { target: id, until: 'clear' } }] : HOME;
      break;
    }
    case 'danger': case 'nothing_to_do': case 'stuck': case 'gave_up':
      next.queue = HOME;
      break;
    default:
      break;
  }
  writeJsonAtomic(ev.ordersPath, next);
}

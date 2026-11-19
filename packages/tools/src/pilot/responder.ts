// 自動で返事をする簡単な相手（IMPROVEMENTS_V4 §10.8 の計測用。AI の代わり）。起こされたら orders.json を書くだけ:
// 目的の敵（守護者を倒す遠征の守護者・節目の大守護者・賞金首）には挑む（HP の下限は最大 HP の 30%。倒す前に止まったら挑み直し、下限なら帰る）、目的の遺物は拾いに行く、
// 撃ってくる・寄ってこない相手には寄って戦う（fight の approach: 'advance'）、動けなければ添えられた最初の者と戦う、
// 危ないときは帰る（帰還の綱）、キャンプでは候補を 1・2・3 の順に回して出発（同じ遠征をくり返さない。無い番号なら 1）、
// 特技・加護は最初の候補、目的を果たしたら帰る。
// それ以外は「わかった」とだけ返す（rev を上げる）。
// 自分の返事の相手（--wake-cmd や --wake-url の先）を書くときの手本にもなる。
import type { QueuedCommand } from './orders';
import { defaultOrders, readOrders, writeJsonAtomic } from './orders';
import type { WakeEvent } from './pilot';

/** 起こし方の鍵から相手の ID（"guardian_seen:e_xxxxxx" など） */
function idOf(key: string): string | null {
  const id = key.split(':')[1];
  return id && /^e_[0-9a-z]{6}$/.test(id) ? id : null;
}

const HOME: QueuedCommand[] = [{ tool: 'use_item', args: { slot: 'lifeline' } }];
/** orders.json ごとの、キャンプで起こされた回数 */
const camps = new Map<string, number>();
/** orders.json ごとの、目的の相手として fight を書いた相手の ID */
const objectiveFoe = new Map<string, string>();

export function simpleResponder(ev: WakeEvent): void {
  if (ev.level !== 'wake' || ev.reason === 'ended' || ev.reason === 'safety') return;
  let cur;
  try { cur = readOrders(ev.ordersPath) ?? defaultOrders(); } catch { cur = defaultOrders(); }
  const next = { ...cur, rev: cur.rev + 1, mode: 'auto' as const, queue: [] as QueuedCommand[], policy: { ...cur.policy } };
  const objective = ev.state.objective?.type;
  const target = idOf(ev.key);
  const role = ev.reason.replace(/_hunting$/, '');
  const last = ev.state.last;
  // 目的の相手に挑む fight（HP の下限は最大 HP の 30%。下回る見込みなら止まって、帰る）
  const challenge = (id: string): QueuedCommand[] => {
    objectiveFoe.set(ev.ordersPath, id);
    return [{ tool: 'fight', args: { target: id, hp_floor: Math.floor(ev.state.self.max_hp * 0.3) } }];
  };
  // 撃ってくる相手（その場から撃つ）・寄ってこない相手: 寄って戦う（fight の approach: 'advance'。V4-1a §12.5）
  if ((role === 'fight_target_shooting' || role === 'fight_target_not_approaching') && last?.tool === 'fight' && typeof last.args.target === 'string' && last.args.approach !== 'advance') {
    next.queue = [{ tool: 'fight', args: { ...last.args, approach: 'advance' } }];
    if (ev.state.objective) next.policy.after_objective = 'extract';
    writeJsonAtomic(ev.ordersPath, next);
    return;
  }
  // 目的の相手に書いた fight が、倒す前に止まった: HP の下限なら帰る、見失ったらそのまま、ほかは挑み直す
  // （寄っていく fight が下がる相手を追えなかったときなど、目的でない相手は、そのまま pilot に戻す）
  if (role.startsWith('fight_') && last?.source === 'queue' && last.tool === 'fight' && typeof last.args.target === 'string' && last.args.target === objectiveFoe.get(ev.ordersPath)) {
    if (/hp_floor|hp_risk/.test(role)) next.queue = HOME;
    else if (!/target_gone|target_fled/.test(role)) next.queue = [{ tool: 'fight', args: last.args }];
    if (ev.state.objective) next.policy.after_objective = 'extract';
    writeJsonAtomic(ev.ordersPath, next);
    return;
  }
  switch (role) {
    case 'camp': {
      const n = camps.get(ev.ordersPath) ?? 0;
      camps.set(ev.ordersPath, n + 1);
      next.queue = [{ tool: 'start_expedition', args: { offer: 1 + (n % 3) } }];
      break;
    }
    case 'queue_failed': if (ev.detail.startsWith('start_expedition')) next.queue = [{ tool: 'start_expedition', args: { offer: 1 } }]; break;
    case 'perk_pending': next.queue = [{ tool: 'choose_perk', args: { option: 1 } }]; break;
    case 'boon_pending': next.queue = [{ tool: 'choose_boon', args: { option: 1 } }]; break;
    case 'objective_done': next.policy.after_objective = 'extract'; break;
    case 'guardian_seen': if (objective === 'slay_guardian' && target) next.queue = challenge(target); break;
    case 'warden_seen': if (objective === 'slay_warden' && target) next.queue = challenge(target); break;
    case 'elite_seen': if (objective === 'slay_bounty' && target) next.queue = challenge(target); break;
    case 'relic_seen': if (objective === 'retrieve_relic' && target) next.queue = [{ tool: 'travel_to', args: { to: target } }]; break;
    case 'refused_hostile_adjacent': case 'refused_blocked': {
      // 隣に起きている敵がいる・経路が敵にふさがれていて動けない: 添えられた者の行（近い順）の、最初の ID と戦う（倒したら、届く追跡中の敵も片付ける）
      const id = /\be_[0-9a-z]{6}\b/.exec(ev.detail)?.[0];
      next.queue = id ? [{ tool: 'fight', args: { target: id, until: 'clear' } }] : HOME;
      break;
    }
    case 'danger': case 'low_hp': case 'too_many': case 'nothing_to_do': case 'stuck':
      next.queue = HOME;
      break;
    default:
      // HP の下限で止まった・断られた戦いも「危ない」として帰る
      if (/hp_floor|hp_risk/.test(ev.reason)) next.queue = HOME;
      break;
  }
  // 目的を果たした後は、いつも帰る
  if (ev.state.objective && ev.reason !== 'camp') next.policy.after_objective = 'extract';
  writeJsonAtomic(ev.ordersPath, next);
}

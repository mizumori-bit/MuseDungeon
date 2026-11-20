// 自動で返事をする簡単な相手（IMPROVEMENTS_V4 §10.8・§14.8 の計測用。AI の代わり）。起こされたら orders.json を書くだけ。
// よくある場面（倒せない相手・HP が減った・queue の失敗）は pilot が自分で続ける（§14.1〜§14.5）ので、返事は薄い:
//   キャンプ     → state.json の候補のうち、大守護者に挑む（節目）と節目の先へ行くものを除いて順に回して出発（同じ遠征をくり返さない。
//                  policy.warden: engage なら除かない）
//   目的の相手・品 → engage_objective: true（以後は pilot が挑む・拾う）
//   特技・加護   → 最初の候補
//   動けない（refused_hostile_adjacent・refused_blocked） → じゃまをしている敵（detail の先頭の行）と戦う。罠にふさがれていたら帰る
//   行き詰まり・やることが無い・目的の相手を諦めた・目的の相手が見つからない（target_not_found）・目的の階へ行けない（target_blocked）・立て直しの手が尽きた（recover_failed） → 帰る
//   （危ない（danger）は V4-1g から escalate なので、見本は答えない。pilot は自分で退く）
//   同じ理由に同じ返事を 2 回続けない: 2 回目は「帰る」にする（V4-1g §24.3。返事役の記録は orders.json の隣の responder.json）（mode: return。階段から帰り、綱は階段へ着けないとき・途中で危ないときだけ。
//                  そのために allow_lifeline: true にする。V4-1e §19.4。今までは綱を queue に書いていた）
// それ以外は「わかった」とだけ返す（rev を上げる）。知らせる（notify）と上げる（escalate: AI か人間へ回すもの。V4-1e §19.1）には返事をしない。
// 自分の返事の相手（--wake-cmd や --wake-url の先）を書くときの手本にもなる。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PilotOrders, QueuedCommand } from './orders';
import { defaultOrders, readOrders, writeJsonAtomic } from './orders';
import type { WakeEvent } from './pilot';

/** 帰る: mode を return にする（queue は空。綱を queue に書かない。綱は pilot が、階段へ着けないときだけ使う。V4-1e §19.4） */
const HOME = 'return' as const;
/** orders.json ごとの、キャンプで起こされた回数 */
const camps = new Map<string, number>();

export function simpleResponder(ev: WakeEvent): void {
  // 答えるのは wake だけ。escalate（節目の大守護者・空回り・安全装置）は AI か人間へ回すもので、プログラムの返事役は答えない（V4-1e §19.1）
  if (ev.level !== 'wake' || ev.reason === 'ended' || ev.reason === 'safety') return;
  let cur;
  try { cur = readOrders(ev.ordersPath) ?? defaultOrders(); } catch { cur = defaultOrders(); }
  const next: PilotOrders = { ...cur, rev: cur.rev + 1, mode: 'auto', queue: [] as QueuedCommand[], policy: { ...cur.policy, ignore: [], unignore: [] } };
  const home = () => { next.mode = HOME; next.queue = []; next.policy.allow_lifeline = true; };
  const role = ev.reason.replace(/_hunting$/, '');
  switch (role) {
    case 'camp': {
      const n = camps.get(ev.ordersPath) ?? 0;
      camps.set(ev.ordersPath, n + 1);
      // 大守護者に関わる候補（挑む・節目の先へ行く）は、warden: engage のときだけ選ぶ（決めるのは AI か人間。V4-1e §19.2）
      const ms = ev.state.camp?.milestone;
      const all = ev.state.camp?.offers ?? [];
      const offers = cur.policy.warden === 'engage' ? all : all.filter((o) => o.type !== 'slay_warden' && !(ms && !ms.cleared && o.target_depth !== null && o.target_depth > ms.depth));
      // 選べる候補が無ければ、何も書かない（pilot が上げる）
      if (!offers.length) return;
      next.queue = [{ tool: 'start_expedition', args: { offer: offers[n % offers.length]!.index } }];
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
      // 守護者・大守護者など役割のある敵なら戦わずに帰る（state.json の hostiles の role で見る）。
      // 道をふさいでいるのが罠（detail の先頭が罠の行で、その ID が state.json の traps にある）なら帰る（踏むかは利用者が決める。V4-1d §18.1）
      const id = /\be_[0-9a-z]{6}\b/.exec(ev.detail)?.[0];
      const h = id ? ev.state.hostiles.find((x) => x.id === id) : undefined;
      const trap = !!id && (ev.state.traps ?? []).some((x) => x.id === id);
      if (id && !trap && !h?.role) next.queue = [{ tool: 'fight', args: { target: id, until: 'clear' } }];
      else home();
      break;
    }
    case 'danger': case 'nothing_to_do': case 'stuck': case 'gave_up': case 'target_not_found': case 'target_blocked': case 'recover_failed':
      home();
      break;
    default:
      break;
  }
  // 同じ理由に同じ返事を 2 回続けない（V4-1g §24.3）: 前の返事と同じなら、2 回目は「帰る」にする。--wake-cmd では毎回別のプロセスなので、ファイルに残す
  const memPath = join(dirname(ev.ordersPath), 'responder.json');
  const sigOf = (o: PilotOrders) => JSON.stringify({ mode: o.mode, queue: o.queue, policy: { ...o.policy, ignore: [], unignore: [] } });
  let last: { reason?: string; sig?: string } = {};
  try { if (existsSync(memPath)) last = JSON.parse(readFileSync(memPath, 'utf-8')) as typeof last; } catch { /* 壊れていれば無いものとする */ }
  if (role !== 'camp' && role !== 'perk_pending' && role !== 'boon_pending' && last.reason === ev.reason && last.sig === sigOf(next) && next.mode !== HOME) home();
  writeJsonAtomic(memPath, { reason: ev.reason, sig: sigOf(next) });
  writeJsonAtomic(ev.ordersPath, next);
}

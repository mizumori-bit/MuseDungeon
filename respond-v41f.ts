// V4-1f 用の返事役（--wake-cmd の先）。捨てラン run_aab99529a1、Bot（p_1evt）用。
// 先輩のPCの MuseDungeon リポジトリのルートに置いて、npx tsx で動かす。
// 呼ばれ方: pilot が起こす・知らせるときに起動。標準入力に summary、環境変数に
// MUSE_PILOT_STATE / MUSE_PILOT_ORDERS / MUSE_PILOT_LEVEL / MUSE_PILOT_REASON。
// 役割:
//   - notify / escalate には返事をしない（記録だけ）。escalate は escalations.log に全文を残す。
//   - camp: まだ一度も遠征していないときだけ、候補 1（[堅実]）で遠征を始め、mode を 'auto' にする。
//     V4-1f の follow（仲間についていく）は pilot 側の方針なので、mode は 'auto' のままにする。
//     遠征を終えてキャンプに戻ったときは、すぐ次の遠征を始めない（手で始める）。
//   - それ以外: 付属の simpleResponder（responder.ts）に任せる。
// 呼ばれた記録は wakes.log に、上げるもの（escalate）は escalations.log に残す。
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { simpleResponder } from './packages/tools/src/pilot/responder.ts';
import { readOrders, writeJsonAtomic } from './packages/tools/src/pilot/orders.ts';

const statePath = process.env.MUSE_PILOT_STATE ?? '';
const ordersPath = process.env.MUSE_PILOT_ORDERS ?? '';
const level = process.env.MUSE_PILOT_LEVEL ?? '';
const reason = process.env.MUSE_PILOT_REASON ?? '';
const dir = dirname(statePath);
const logPath = join(dir, 'wakes.log');
const escPath = join(dir, 'escalations.log');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d: string) => { stdin += d; });
process.stdin.on('end', () => {
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const detail: string = state.wake?.detail ?? '';
  appendFileSync(logPath, JSON.stringify({
    t: new Date().toISOString(), level, reason,
    turn: state.turn ?? null, exp: state.expedition_no ?? null,
    detail: detail.split('\n')[0] ?? '',
  }) + '\n');

  // 上げる（escalate）: 返事をしない。全文を escalations.log に残して、ミュゼ美の判断を待つ。
  if (level === 'escalate') {
    appendFileSync(escPath, JSON.stringify({
      t: new Date().toISOString(), reason,
      turn: state.turn ?? null, exp: state.expedition_no ?? null,
      self: state.self ?? null,
      banked: state.banked ?? null,
      camp: state.camp ?? null,
      detail,
    }, null, 2) + '\n---\n');
    return;
  }
  if (level !== 'wake') return;
  if (reason === 'ended' || reason === 'safety') return;

  if (reason === 'camp') {
    // まだ一度も遠征していないときだけ、候補 1（[堅実]）で遠征を始め、mode を 'auto' にする。
    // V4-1f の follow は pilot 側の方針なので、mode は 'auto' のまま（'hold' にしない）。
    const expNo: number | null = state.expedition_no ?? null;
    const cur = readOrders(ordersPath);
    const rev = (cur?.rev ?? 1) + 1;
    if (expNo === null || expNo === 0) {
      const offerIndex = 1;
      appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), note: 'camp-start-auto', offer: offerIndex }) + '\n');
      const next = {
        ...(cur ?? { rev: 0, mode: 'auto', queue: [], policy: {}, camp: { auto_start: null } }),
        rev, mode: 'auto' as const,
        queue: [{ tool: 'start_expedition', args: { offer: offerIndex } }],
        policy: { ...(cur?.policy ?? {}), engage_objective: false },
      };
      writeJsonAtomic(ordersPath, next);
      return;
    }
    // 遠征を終えてキャンプに戻ったときは、すぐ次の遠征を始めない。待つだけ。
    appendFileSync(logPath, JSON.stringify({ t: new Date().toISOString(), note: 'camp-wait', exp: expNo, detail: detail.split('\n')[0] ?? '' }) + '\n');
    return;
  }

  // それ以外: 付属の返事役に任せる
  simpleResponder({ level: level as 'wake', reason, key: '', detail, state, statePath, ordersPath });
});

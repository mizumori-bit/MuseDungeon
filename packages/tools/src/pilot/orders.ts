// pilot の方針（orders.json。AI が書き、pilot は読むだけ）。IMPROVEMENTS_V4 §10.2。
// 知らない項目は無視し、無い項目は既定値。既定値は手綱の短い側（キャンプでは必ず起こす・綱は使わない・HP が半分を切ったら起こす）。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface QueuedCommand { tool: string; args?: Record<string, unknown> }

export interface PilotPolicy {
  /** HP がこの割合を切ったら起こす */
  wake_hp_pct: number;
  /** 敵がいなくて HP がこの割合を切っていたら休む */
  rest_below_pct: number;
  /** 追ってくる敵がこの数を超えたら起こす（戦わない） */
  max_chasers: number;
  /** 役割の無い敵（守護者・強敵でない敵）と戦ってよいか */
  fight: boolean;
  /** pilot の fight にそのまま渡す approach（V4-1a §12.5）: wait＝隣に来るまで待つ（既定）/ advance＝寄っていく。pilot は自分で切り替えない */
  approach: 'wait' | 'advance';
  /** 品を拾ってよいか（遺物は拾わない） */
  collect: boolean;
  /** 目的の階へ向けて階段を下りてよいか */
  descend: boolean;
  /** 目的を果たした後: wake（起こす）/ extract（階段へ戻って帰る） */
  after_objective: 'wake' | 'extract';
  /** 危ないとき、階段の上なら帰ってよいか */
  allow_extract: boolean;
  /** 危ないとき、帰還の綱を使ってよいか（綱は遠征を終わらせる取り消せない手） */
  allow_lifeline: boolean;
  /** この手番ごとに経過を知らせる（0＝知らせない） */
  notify_every_turns: number;
  /** 起こして待つ間、この手番ごとにもう一度起こす */
  hold_max_turns: number;
}

export interface PilotOrders {
  rev: number;
  /** auto＝方針どおり動く / hold＝持ち場の動きだけ / stop＝pilot を終える */
  mode: 'auto' | 'hold' | 'stop';
  /** 先にやる 1 回きりの命令。上から順に 1 つずつ。空になったら方針に戻る */
  queue: QueuedCommand[];
  policy: PilotPolicy;
  /** auto_start: null＝キャンプでは必ず起こす / "safe" など＝その枠の候補で自動で出発 */
  camp: { auto_start: string | null };
}

export const DEFAULT_POLICY: PilotPolicy = {
  wake_hp_pct: 50,
  rest_below_pct: 70,
  max_chasers: 2,
  fight: true,
  approach: 'wait',
  collect: true,
  descend: true,
  after_objective: 'wake',
  allow_extract: true,
  allow_lifeline: false,
  notify_every_turns: 100,
  hold_max_turns: 40,
};

export function defaultOrders(): PilotOrders {
  return { rev: 1, mode: 'auto', queue: [], policy: { ...DEFAULT_POLICY }, camp: { auto_start: null } };
}

const num = (x: unknown, d: number, min = 0): number => (typeof x === 'number' && Number.isFinite(x) && x >= min ? x : d);
const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);

/** JSON を方針に直す（知らない項目は捨て、無い・型の違う項目は既定値）。形が壊れていれば Error */
export function parseOrders(raw: unknown): PilotOrders {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('orders.json is not an object');
  const r = raw as Record<string, unknown>;
  if (typeof r.rev !== 'number' || !Number.isFinite(r.rev)) throw new Error('orders.json: rev must be a number');
  const p = (r.policy && typeof r.policy === 'object' ? r.policy : {}) as Record<string, unknown>;
  const d = DEFAULT_POLICY;
  const queue: QueuedCommand[] = [];
  if (r.queue !== undefined) {
    if (!Array.isArray(r.queue)) throw new Error('orders.json: queue must be an array');
    for (const q of r.queue) {
      if (!q || typeof q !== 'object' || typeof (q as QueuedCommand).tool !== 'string') throw new Error('orders.json: each queue entry needs "tool"');
      const args = (q as QueuedCommand).args;
      queue.push({ tool: (q as QueuedCommand).tool, ...(args && typeof args === 'object' ? { args: { ...args } } : {}) });
    }
  }
  const camp = (r.camp && typeof r.camp === 'object' ? r.camp : {}) as Record<string, unknown>;
  return {
    rev: r.rev,
    mode: r.mode === 'hold' || r.mode === 'stop' ? r.mode : 'auto',
    queue,
    policy: {
      wake_hp_pct: num(p.wake_hp_pct, d.wake_hp_pct),
      rest_below_pct: num(p.rest_below_pct, d.rest_below_pct),
      max_chasers: num(p.max_chasers, d.max_chasers),
      fight: bool(p.fight, d.fight),
      approach: p.approach === 'advance' ? 'advance' : 'wait',
      collect: bool(p.collect, d.collect),
      descend: bool(p.descend, d.descend),
      after_objective: p.after_objective === 'extract' ? 'extract' : 'wake',
      allow_extract: bool(p.allow_extract, d.allow_extract),
      allow_lifeline: bool(p.allow_lifeline, d.allow_lifeline),
      notify_every_turns: num(p.notify_every_turns, d.notify_every_turns),
      hold_max_turns: num(p.hold_max_turns, d.hold_max_turns, 1),
    },
    camp: { auto_start: typeof camp.auto_start === 'string' && camp.auto_start ? camp.auto_start : null },
  };
}

/** ファイルを読む。無ければ null、壊れていれば Error */
export function readOrders(path: string): PilotOrders | null {
  if (!existsSync(path)) return null;
  return parseOrders(JSON.parse(readFileSync(path, 'utf-8')));
}

/** 別の名前で書いてから置き換える（書きかけを読ませない） */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

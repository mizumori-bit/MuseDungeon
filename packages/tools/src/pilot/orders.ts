// pilot の方針（orders.json。AI が書き、pilot は読むだけ）。IMPROVEMENTS_V4 §10.2、§14 で見直し。
// 知らない項目は無視し、無い項目は既定値。綱は使わない・キャンプと目的の相手では起こす、は既定のまま。
// 決められることは pilot が決めて知らせる（§14.0）ので、目的を果たしたら帰る・決着しない戦いは諦める、が既定。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface QueuedCommand { tool: string; args?: Record<string, unknown> }

export interface PilotPolicy {
  /** HP がこの割合を切ったら、立て直しの段に入る（§14.3。起こさない）。pilot の fight の hp_floor にも使う */
  wake_hp_pct: number;
  /** 敵がいなくて HP がこの割合を切っていたら休む（立て直しの段も、ここまで休む） */
  rest_below_pct: number;
  /** 追ってくる敵がこの数を超えたら知らせる（§14.1。止まらない） */
  max_chasers: number;
  /** 役割の無い敵（守護者・強敵でない敵）と戦ってよいか */
  fight: boolean;
  /** pilot の fight の寄り方（V4-1a §12.5・§14.2）: auto＝最初は待ち、離れて撃ってくる・寄ってこない相手には寄ってやり直す（既定）/ wait / advance＝固定 */
  approach: 'auto' | 'wait' | 'advance';
  /**
   * 同じ相手に、倒す前にこの回数止まったら、その階にいる間は相手にしない（§14.2）。既定 3（V4-1d §18.2: 離れたままの相手に
   * 待つ → 寄る → 投げる、の 3 回目を数に入れる）
   */
  give_up_after: number;
  /**
   * 離れたままの相手（fight が target_shooting・target_not_approaching で止まった）への、諦める前の最後のやり直しで、
   * 分類が「投げる武器」の品を with に渡してよいか（V4-1d §18.2。既定 true。投げた品は床に落ち、collect が拾う。薬は投げない）
   */
  allow_throw: boolean;
  /**
   * 道をふさいでいる罠（断りのエラーの details.blocked_by_traps）を踏んで通ってよいか（V4-1d §18.1。既定 false＝踏まずに知らせる・起こす）。
   * pilot は罠の種類を見分けないので、true はどの罠でも踏む。隣の罠は 1 歩の move で踏み、stepped_on_trap で知らせる
   */
  step_on_traps: boolean;
  /** この遠征の目的の相手・品が見えたら、起こさずに挑む・拾う（§14.1。既定 false＝起こす） */
  engage_objective: boolean;
  /** 特技・加護の選択: wake＝起こす（既定）/ first＝起こさずに最初の候補を選ぶ（§14.1） */
  perk: 'wake' | 'first';
  /** 品を拾ってよいか（遺物は拾わない） */
  collect: boolean;
  /** 目的の階へ向けて階段を下りてよいか */
  descend: boolean;
  /** 目的を果たした後: extract（階段へ戻って帰る・既定。§14.1）/ wake（起こす）/ continue（そのまま先へ進む） */
  after_objective: 'extract' | 'wake' | 'continue';
  /** 危ないとき、階段の上なら帰ってよいか */
  allow_extract: boolean;
  /** 危ないとき、帰還の綱を使ってよいか（綱は遠征を終わらせる取り消せない手） */
  allow_lifeline: boolean;
  /**
   * 回復の手段（観測の self.recovery）を使ってよいか（V4-1c §16.3。既定 true）。能動技は立て直しの最初に、
   * 品（使うと減る）は倒されうるのに退く手が無いときだけ。未鑑定の品には触れない
   */
  allow_heal: boolean;
  /** 立て直しで、階段を使って階を移って休んでよいか（§14.3）。null＝ソロは true・協力プレイは false（同じ階に仲間が生きている間は移らない。V4-1j §30.4） */
  retreat_via_stairs: boolean | null;
  /**
   * 危ない（danger）を上げた後（V4-1j §30.3）: return＝その遠征は帰る（既定）/ recover＝立て直しの段へ。倒されうる状態でなくなったら続ける。
   * 同じ遠征で 2 回目の danger は帰る
   */
  on_danger: 'return' | 'recover';
  /**
   * 戦い方（V4-1k §32.1）: auto＝近接で戦い、通っていない（当てた回数が 6 回を超えても相手の HP の段階が下がらない）と分かったら投げる。
   * 投げても通らなければやめる（既定）/ throw_first＝投げる武器があれば先に投げる（無くなったら近接）/ melee＝投げない
   */
  fight_with: 'auto' | 'throw_first' | 'melee';
  /** queue の命令が失敗したとき: discard＝残りを捨てる（既定）/ skip＝失敗した命令だけ捨てて次へ。どちらも知らせるだけ（§14.5） */
  queue_on_fail: 'discard' | 'skip';
  /** 相手にしない敵の ID を足す・外す（§14.6。rev を上げたときに一度だけ効く） */
  ignore: string[];
  unignore: string[];
  /** この手番ごとに経過を知らせる（0＝知らせない） */
  notify_every_turns: number;
  /** 起こしてから、この手番が過ぎても返事が無ければ、帰る側へ倒す（§14.4: 階段へ行き、allow_extract なら帰る） */
  hold_max_turns: number;
  /**
   * 節目の大守護者（V4-1e §19.2）: escalate＝その大守護者につき 1 回、AI か人間に上げる（既定）/ engage＝起こさずに挑む /
   * avoid＝挑まない（節目の先が要る候補は選ばない。選べる候補が尽きたら空回りとして上げて止まる）
   */
  warden: 'escalate' | 'engage' | 'avoid';
  /** 直近のこの回数の遠征が、どれも「確定が 0」か「10 手番以内に終わった」なら空回り: 次を始めずにキャンプで上げる（V4-1e §19.3。0＝見ない） */
  stall_after: number;
  /** 目的でない遺物も、追ってくる敵が見えていないときに拾う（V4-1e §19.5。既定 false: 拾うと階が起きる） */
  pick_relics: boolean;
  /** 目的の相手・品を探す（V4-1f §22.1）手番の上限。使っても見つからなければ target_not_found で起こす */
  seek_max_turns: number;
  /** warden: engage にした後、その大守護者を目的にした遠征が倒さずにこの回数終わったら、もう一度上げる（V4-1f §22.2） */
  warden_retry_after: number;
  /**
   * 協力プレイで仲間と一緒に動く（V4-1f §22.5）。follow: auto＝人間の仲間、いなければ参加がいちばん早い者（自分がそれなら、だれにもついていかない）/
   * none＝1 人のときと同じ / 仲間の名前か ID。follow_distance: 同じ階でこれより離れたら寄る。wait_for_party: 遠征の最初に、相手が同じ階に来るまで待つ。
   * idle_minutes: 仲間を待つ間に、仲間が何もしないまま（観測の party の状態・階・見えていれば位置と HP が変わらないまま）この実時間（分）が過ぎたら
   * party_idle で上げる（§23.8。0＝切る）。
   * wait_for_join: 協力プレイのランで、ほかの参加者が 1 人もいなければ、キャンプで遠征を始めずに待つ（V4-1g §24.4）。
   * assist: ついていく相手の HP が重傷以下になったら、助けに行く。on_party_down: ついていく相手が倒れたら return（帰る）/ continue（続ける）
   */
  coop: { follow: string; follow_distance: number; wait_for_party: boolean; idle_minutes: number; wait_for_join: boolean; assist: boolean; on_party_down: 'return' | 'continue' };
}

export interface PilotOrders {
  rev: number;
  /**
   * auto＝方針どおり動く / hold＝持ち場の動きだけ / stop＝その場で pilot を終える / stop_at_camp＝帰ってから終える（§14.7）/
   * return＝階段へ行って帰り、キャンプに着いたら auto に戻る（V4-1e §19.4。綱は階段へ着けないときだけ。orders.json は書き換えず、
   * 同じ rev の間は auto として扱う）
   */
  mode: 'auto' | 'hold' | 'stop' | 'stop_at_camp' | 'return';
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
  approach: 'auto',
  give_up_after: 3,
  allow_throw: true,
  step_on_traps: false,
  engage_objective: false,
  perk: 'wake',
  collect: true,
  descend: true,
  after_objective: 'extract',
  allow_extract: true,
  allow_lifeline: false,
  allow_heal: true,
  retreat_via_stairs: null,
  on_danger: 'return',
  fight_with: 'auto',
  queue_on_fail: 'discard',
  ignore: [],
  unignore: [],
  notify_every_turns: 100,
  hold_max_turns: 40,
  warden: 'escalate',
  stall_after: 3,
  pick_relics: false,
  seek_max_turns: 150,
  warden_retry_after: 2,
  coop: { follow: 'auto', follow_distance: 8, wait_for_party: true, idle_minutes: 10, wait_for_join: true, assist: true, on_party_down: 'return' },
};

export function defaultOrders(): PilotOrders {
  return { rev: 1, mode: 'auto', queue: [], policy: { ...DEFAULT_POLICY, ignore: [], unignore: [], coop: { ...DEFAULT_POLICY.coop } }, camp: { auto_start: null } };
}

const num = (x: unknown, d: number, min = 0): number => (typeof x === 'number' && Number.isFinite(x) && x >= min ? x : d);
const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);
const ids = (x: unknown): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && /^e_[0-9a-z]{6}$/.test(v)) : []);

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
    mode: r.mode === 'hold' || r.mode === 'stop' || r.mode === 'stop_at_camp' || r.mode === 'return' ? r.mode : 'auto',
    queue,
    policy: {
      wake_hp_pct: num(p.wake_hp_pct, d.wake_hp_pct),
      rest_below_pct: num(p.rest_below_pct, d.rest_below_pct),
      max_chasers: num(p.max_chasers, d.max_chasers),
      fight: bool(p.fight, d.fight),
      approach: p.approach === 'wait' || p.approach === 'advance' ? p.approach : 'auto',
      give_up_after: num(p.give_up_after, d.give_up_after, 1),
      allow_throw: bool(p.allow_throw, d.allow_throw),
      step_on_traps: bool(p.step_on_traps, d.step_on_traps),
      engage_objective: bool(p.engage_objective, d.engage_objective),
      perk: p.perk === 'first' ? 'first' : 'wake',
      collect: bool(p.collect, d.collect),
      descend: bool(p.descend, d.descend),
      after_objective: p.after_objective === 'wake' || p.after_objective === 'continue' ? p.after_objective : 'extract',
      allow_extract: bool(p.allow_extract, d.allow_extract),
      allow_lifeline: bool(p.allow_lifeline, d.allow_lifeline),
      allow_heal: bool(p.allow_heal, d.allow_heal),
      retreat_via_stairs: typeof p.retreat_via_stairs === 'boolean' ? p.retreat_via_stairs : null,
      on_danger: p.on_danger === 'recover' ? 'recover' : 'return',
      fight_with: p.fight_with === 'throw_first' || p.fight_with === 'melee' ? p.fight_with : 'auto',
      queue_on_fail: p.queue_on_fail === 'skip' ? 'skip' : 'discard',
      ignore: ids(p.ignore),
      unignore: ids(p.unignore),
      notify_every_turns: num(p.notify_every_turns, d.notify_every_turns),
      hold_max_turns: num(p.hold_max_turns, d.hold_max_turns, 1),
      warden: p.warden === 'engage' || p.warden === 'avoid' ? p.warden : 'escalate',
      stall_after: num(p.stall_after, d.stall_after),
      pick_relics: bool(p.pick_relics, d.pick_relics),
      seek_max_turns: num(p.seek_max_turns, d.seek_max_turns, 1),
      warden_retry_after: num(p.warden_retry_after, d.warden_retry_after, 1),
      coop: (() => {
        const c = (p.coop && typeof p.coop === 'object' ? p.coop : {}) as Record<string, unknown>;
        return {
          follow: typeof c.follow === 'string' && c.follow ? c.follow : d.coop.follow,
          follow_distance: num(c.follow_distance, d.coop.follow_distance, 1),
          wait_for_party: bool(c.wait_for_party, d.coop.wait_for_party),
          idle_minutes: num(c.idle_minutes, d.coop.idle_minutes),
          wait_for_join: bool(c.wait_for_join, d.coop.wait_for_join),
          assist: bool(c.assist, d.coop.assist),
          on_party_down: c.on_party_down === 'continue' ? 'continue' as const : 'return' as const,
        };
      })(),
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

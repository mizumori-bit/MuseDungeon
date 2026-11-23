// MCP の呼び出しの時間の控え（S7。SEASON.md §52.1 の 2・§52.3 の 8）: 呼び出しごとに、受け取った時刻・ツールの名前・ラン・
// かかった時間（サーバーの側）だけを、メモリに持つ（ファイルに書かない）。引数・トークン・考えは持たない。
// 長いもの（LONG_CALL_MS より長い）と、例外で終わったものは、サーバーのログに 1 行出す。運用者は GET /api/ops/calls（同じ機械からだけ）で直近を見る。

/** 1 回の呼び出しの控え */
export interface CallRecord {
  /** 受け取った時刻（ISO 8601） */
  at: string;
  tool: string;
  /** 呼び出しのプレイヤーのラン（分からなければ null: 束縛の前の new_run の失敗など） */
  run: string | null;
  /** サーバーの側でかかった時間（ミリ秒） */
  ms: number;
  /** 例外で終わった（ゲームの断りは例外でない） */
  error?: true;
}

/** 例外の 1 行目（トークンらしい長い英数字の並びは伏せる。引数・考えは、例外の文に入らない作りだが、念のため） */
function errLine(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0].slice(0, 200).replace(/[A-Za-z0-9_-]{20,}/g, '••••');
}

/** ログに出す長さ（ミリ秒） */
export const LONG_CALL_MS = 10_000;
/** メモリに持つ数 */
export const CALL_LOG_SIZE = 200;

export class CallLog {
  private readonly items: CallRecord[] = [];
  constructor(public longMs = LONG_CALL_MS, private readonly size = CALL_LOG_SIZE, private readonly log: (line: string) => void = (l) => console.error(l)) {}

  /** 控える。長いもの・例外で終わったものは 1 行ログに出す（引数・トークン・考えは出さない） */
  record(r: CallRecord, err?: unknown): void {
    this.items.push(r);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
    if (r.error) this.log(`[mcp] 例外で終わった呼び出し: ${r.tool} run=${r.run ?? '-'} ${r.ms} ms（受け取り ${r.at}）: ${errLine(err)}`);
    else if (r.ms > this.longMs) this.log(`[mcp] 長い呼び出し: ${r.tool} run=${r.run ?? '-'} ${(r.ms / 1000).toFixed(1)} 秒（受け取り ${r.at}）`);
  }

  /** 直近の呼び出し（新しい順。limit 件まで） */
  list(limit = this.size): CallRecord[] {
    return this.items.slice(-Math.max(0, Math.min(limit, this.size))).reverse().map((x) => ({ ...x }));
  }
}

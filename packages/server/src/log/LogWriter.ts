// ラン記録の書き出し。追記のみ、イベント適用と同じ順序で書く。上書きするファイルは一時ファイル→ディスクまで書き切る→リネーム（SEASON.md §33.1）。
// キーフレームと管理ファイルを書く前に、追記するファイル（命令と出来事の記録）もディスクまで書き切る（§36.1 の 1: 機械が止まったとき、
// キーフレームだけが記録より先に進んで残らないように）。
// runs/<runId>/ meta.json, commands.jsonl, events.jsonl, keyframes/<seq>.json, summary.json/.md, tokens.json
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRecord, GameEvent, RunMetaFile, World } from '@muse/shared';
import { fsyncFile, readJsonStable, writeFileAtomic, writeFileAtomicLogged } from './atomicWrite';

export interface KeyframeFile { seq: number; cseq: number; world: World }

export class LogWriter {
  readonly dir: string;
  /** 前に書き切った後、追記したか（書き切るのは、追記した後の最初のキーフレーム・管理ファイルの前だけ） */
  private appended = true;

  constructor(runsDir: string, runId: string) {
    this.dir = join(runsDir, runId);
    mkdirSync(join(this.dir, 'keyframes'), { recursive: true });
  }

  /** 命令と出来事の記録を、ディスクまで書き切る */
  syncLogs(): void {
    if (!this.appended) return;
    try {
      fsyncFile(join(this.dir, 'events.jsonl'));
      fsyncFile(join(this.dir, 'commands.jsonl'));
      this.appended = false;
    } catch (e) {
      console.error(`[write] ${this.dir} の記録を書き切れなかった: ${String((e as Error).message ?? e).split('\n')[0]}`);
    }
  }

  /** 書けなかったら知らせて続ける（命令の確定の途中。前の中身は残り、次の書き込みと閉じるときにやり直す。起動し直したときにも作り直せる） */
  private atomic(path: string, data: string): boolean {
    this.syncLogs();
    return writeFileAtomicLogged(path, data);
  }

  writeMeta(meta: RunMetaFile): boolean {
    return this.atomic(join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  appendEvents(events: readonly GameEvent[]): void {
    if (!events.length) return;
    appendFileSync(join(this.dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.appended = true;
  }

  appendCommand(rec: CommandRecord): void {
    appendFileSync(join(this.dir, 'commands.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
    this.appended = true;
  }

  writeKeyframe(kf: KeyframeFile): void {
    this.atomic(join(this.dir, 'keyframes', `${kf.seq}.json`), JSON.stringify(kf));
  }

  writeSummary(summary: unknown, markdown: string): void {
    this.atomic(join(this.dir, 'summary.json'), JSON.stringify(summary, null, 2));
    this.atomic(join(this.dir, 'summary.md'), markdown);
  }

  /**
   * サーバー専用（HTTP では配信しない）: 再開用トークン。書けなければ例外（§36.1 の 4: 参加を断る。
   * プレイヤーにトークンを返したのに、ディスクに残らず、次の起動で復旧に失敗する形をふさぐ）
   */
  writeTokens(tokens: Record<string, string>): void {
    this.syncLogs();
    writeFileAtomic(join(this.dir, 'tokens.json'), JSON.stringify(tokens, null, 2));
  }

  readTokens(): Record<string, string> {
    const r = readJsonStable<Record<string, string>>(join(this.dir, 'tokens.json'));
    if ('value' in r) return r.value;
    if ('missing' in r) return {};
    throw new Error('tokens.json が読めない');
  }
}

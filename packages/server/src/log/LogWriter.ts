// ラン記録の書き出し。追記のみ、イベント適用と同じ順序で書く。上書きするファイルは一時ファイル→ディスクまで書き切る→リネーム（SEASON.md §33.1）。
// runs/<runId>/ meta.json, commands.jsonl, events.jsonl, keyframes/<seq>.json, summary.json/.md, tokens.json
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRecord, GameEvent, RunMetaFile, World } from '@muse/shared';
import { writeFileAtomicLogged } from './atomicWrite';

export interface KeyframeFile { seq: number; cseq: number; world: World }

export class LogWriter {
  readonly dir: string;

  constructor(runsDir: string, runId: string) {
    this.dir = join(runsDir, runId);
    mkdirSync(join(this.dir, 'keyframes'), { recursive: true });
  }

  /** 書けなかったら知らせて続ける（命令の確定の途中。前の中身は残り、起動し直したときにほかの記録から作り直せる） */
  private atomic(path: string, data: string): void {
    writeFileAtomicLogged(path, data);
  }

  writeMeta(meta: RunMetaFile): void {
    this.atomic(join(this.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  }

  appendEvents(events: readonly GameEvent[]): void {
    if (!events.length) return;
    appendFileSync(join(this.dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  appendCommand(rec: CommandRecord): void {
    appendFileSync(join(this.dir, 'commands.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
  }

  writeKeyframe(kf: KeyframeFile): void {
    this.atomic(join(this.dir, 'keyframes', `${kf.seq}.json`), JSON.stringify(kf));
  }

  writeSummary(summary: unknown, markdown: string): void {
    this.atomic(join(this.dir, 'summary.json'), JSON.stringify(summary, null, 2));
    this.atomic(join(this.dir, 'summary.md'), markdown);
  }

  /** サーバー専用（HTTP では配信しない）: 再開用トークン */
  writeTokens(tokens: Record<string, string>): void {
    this.atomic(join(this.dir, 'tokens.json'), JSON.stringify(tokens, null, 2));
  }

  readTokens(): Record<string, string> {
    const p = join(this.dir, 'tokens.json');
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
  }
}

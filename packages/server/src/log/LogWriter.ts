// ラン記録の書き出し。追記のみ、イベント適用と同じ順序で書く。キーフレームは一時ファイル→リネーム。
// runs/<runId>/ meta.json, commands.jsonl, events.jsonl, keyframes/<seq>.json, summary.json/.md, tokens.json
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandRecord, GameEvent, RunMetaFile, World } from '@muse/shared';

export interface KeyframeFile { seq: number; cseq: number; world: World }

export class LogWriter {
  readonly dir: string;

  constructor(runsDir: string, runId: string) {
    this.dir = join(runsDir, runId);
    mkdirSync(join(this.dir, 'keyframes'), { recursive: true });
  }

  private atomic(path: string, data: string): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, data, 'utf8');
    renameSync(tmp, path);
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

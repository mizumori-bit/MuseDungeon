// 長いランの復旧のテスト（v41m.test.ts）から、別のプロセスで起動する: サーバーの起動時と同じ recoverAll を、既定のスタックの大きさで動かす。
// vitest の worker はスタックが大きく、本番（サーバーの本体のスレッド）で落ちた push(...) の溢れが起きないため（V4-1m §37.1）。
// 使い方: node --import tsx recover-child.ts <runsDir>  → 標準出力に JSON（logs・runs・ms）
import { loadContent } from '@muse/content';
import { loadConfig, SessionManager } from '@muse/server';

const m = new SessionManager(loadContent(), loadConfig({ runsDir: process.argv[2]!, profilesDir: null, waitOthersMs: 100 }));
const logs: string[] = [];
const t0 = Date.now();
m.recoverAll((s) => logs.push(s));
const ms = Date.now() - t0;
const runs = m.listRuns().map((r) => ({ runId: r.runId, live: r.live, seq: r.seq, recoveryFailed: r.recoveryFailed ?? null, history: m.get(r.runId)?.history.length ?? null }));
m.closeAll();
process.stdout.write(JSON.stringify({ logs, runs, ms }));

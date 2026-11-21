// サーバー設定。環境変数で上書き可能。既定は 127.0.0.1:7777 にのみバインド。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SpectatorPolicy } from '@muse/shared';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..', '..');

export interface ServerConfig {
  host: string;
  port: number;
  /** null ならログをディスクに書かない（テスト用） */
  runsDir: string | null;
  spectatorPolicy: SpectatorPolicy;
  /** delayed ポリシー時の遅延（seq 数） */
  spectatorDelaySeq: number;
  clientDist: string;
  keyframeEvery: number;
  /** MCP の行動ツールが他プレイヤー待ちで一旦返るまでの時間 */
  waitOthersMs: number;
  /** ターンフィードの idle 通知の間隔（手番のまま入力が無いとき） */
  idleNoticeMs: number;
  /** プロフィールの置き場所（V3-7 §7.1）。null ならメモリだけ。既定は runsDir/profiles（runsDir が null なら null） */
  profilesDir: string | null;
  /** 継承（V3-7 §7.3）: off なら new_run {legacy: true} でも継承しない */
  legacyPolicy: 'on' | 'off';
  /** シーズンの置き場所（S0。PROTOCOL §9.1）。null ならメモリだけ。既定は runsDir/seasons（runsDir が null なら null） */
  seasonsDir: string | null;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const env = process.env;
  const policy = (env.MUSE_SPECTATOR_POLICY as SpectatorPolicy | undefined) ?? 'omniscient';
  return {
    // カンマで区切って複数書ける（main.ts がそれぞれで待ち受ける）
    host: env.MUSE_HOST ?? '127.0.0.1',
    port: env.MUSE_PORT ? parseInt(env.MUSE_PORT, 10) : 7777,
    runsDir: env.MUSE_RUNS_DIR ?? resolve(REPO_ROOT, 'runs'),
    spectatorPolicy: ['omniscient', 'follow_only', 'delayed'].includes(policy) ? policy : 'omniscient',
    spectatorDelaySeq: env.MUSE_SPECTATOR_DELAY ? parseInt(env.MUSE_SPECTATOR_DELAY, 10) : 300,
    clientDist: resolve(REPO_ROOT, 'packages', 'client', 'dist'),
    keyframeEvery: 500,
    waitOthersMs: 20000,
    idleNoticeMs: env.MUSE_IDLE_NOTICE_MS ? parseInt(env.MUSE_IDLE_NOTICE_MS, 10) : 60000,
    legacyPolicy: env.MUSE_LEGACY_POLICY === 'off' ? 'off' : 'on',
    ...overrides,
    profilesDir: overrides.profilesDir !== undefined ? overrides.profilesDir : env.MUSE_PROFILES_DIR ?? (runsDirOf(overrides, env) ? join(runsDirOf(overrides, env)!, 'profiles') : null),
    seasonsDir: overrides.seasonsDir !== undefined ? overrides.seasonsDir : env.MUSE_SEASONS_DIR ?? (runsDirOf(overrides, env) ? join(runsDirOf(overrides, env)!, 'seasons') : null),
  };
}

function runsDirOf(overrides: Partial<ServerConfig>, env: NodeJS.ProcessEnv): string | null {
  if (overrides.runsDir !== undefined) return overrides.runsDir;
  return env.MUSE_RUNS_DIR ?? resolve(REPO_ROOT, 'runs');
}

// ディスク上の pack ディレクトリを読み込む。packages/content/data/<pack>/<kind>.json
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Content, RawPack } from './content';
import { buildContent, ContentError } from './content';
import { FILE_SCHEMAS } from './schema';
import type { FileKind } from './schema';

export const DEFAULT_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data');

export function readPacks(dataDir: string = DEFAULT_DATA_DIR, packIds?: string[]): RawPack[] {
  if (!existsSync(dataDir)) throw new ContentError(`data dir not found: ${dataDir}`);
  const dirs = readdirSync(dataDir).filter((d) => statSync(join(dataDir, d)).isDirectory()).sort();
  // core を常に先頭に（後続 pack が上書き・追加できる）
  const ordered = ['core', ...dirs.filter((d) => d !== 'core')].filter((d) => dirs.includes(d));
  const use = packIds ? ordered.filter((d) => packIds.includes(d)) : ordered;
  return use.map((id) => {
    const files: RawPack['files'] = {};
    for (const f of readdirSync(join(dataDir, id))) {
      if (!f.endsWith('.json')) continue;
      const kind = f.slice(0, -5) as FileKind;
      if (!(kind in FILE_SCHEMAS)) throw new ContentError(`未知の定義ファイル: ${id}/${f}`);
      try {
        files[kind] = JSON.parse(readFileSync(join(dataDir, id, f), 'utf8'));
      } catch (e) {
        throw new ContentError(`${id}/${f}: JSON 解析エラー: ${(e as Error).message}`);
      }
    }
    return { id, files };
  });
}

let cached: Content | null = null;

/** 既定の data ディレクトリを読み込んで検証する（プロセス内でキャッシュ） */
export function loadContent(dataDir?: string): Content {
  if (!dataDir && cached) return cached;
  const c = buildContent(readPacks(dataDir));
  if (!dataDir) cached = c;
  return c;
}

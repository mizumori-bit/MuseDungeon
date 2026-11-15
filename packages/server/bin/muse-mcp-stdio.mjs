#!/usr/bin/env node
// muse-mcp-stdio ランチャー: 作業ディレクトリに依存せず `node <このファイル>` で起動できる。
import { register } from 'tsx/esm/api';
register();
await import('../src/stdio.ts');

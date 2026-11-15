#!/usr/bin/env node
// muse-server ランチャー: `node packages/server/bin/muse-server.mjs`
import { register } from 'tsx/esm/api';
register();
await import('../src/main.ts');

#!/usr/bin/env node
// 試運転の道具 call の入口（S1a。SEASON.md §10.1・§11）: npm.cmd（cmd.exe）を通さずに node で直接呼ぶ。
// 使い方（作業場所はリポジトリの直下。PowerShell でも bash でも同じ）: node packages/tools/bin/call.mjs <tool> [key=value ...]
//   npm.cmd run call は、引数に「数字＋空白＋日本語」や JSON の波かっこがあると cmd.exe の解釈で失敗するので、こちらを使う。
import process from 'node:process';
import { register } from 'tsx/esm/api';

register();
const { mcpCall } = await import('../src/mcp-call.ts');
process.exitCode = await mcpCall(process.argv.slice(2));

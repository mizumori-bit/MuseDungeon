// 境界ルール（docs/DESIGN.md §2.3）を機械的に守るための ESLint 設定。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const noEngineInClient = {
  patterns: [
    { group: ['@muse/engine', '@muse/engine/*', '**/engine/src/**'], message: 'client は engine を import できない（描画とロジックの分離）。' },
    { group: ['@muse/server', '@muse/server/*', '**/server/src/**'], message: 'client は server を import できない。' },
    { group: ['@muse/content', '@muse/content/*', '**/content/src/**'], message: 'client は content を直接読まない（公開カタログ API を使う）。' },
  ],
};

const nondeterministicGlobals = [
  { name: 'Date', message: 'engine は決定論的: Date 禁止。' },
  { name: 'performance', message: 'engine は決定論的: performance 禁止。' },
  { name: 'setTimeout', message: 'engine は I/O・タイマー禁止。' },
  { name: 'setInterval', message: 'engine は I/O・タイマー禁止。' },
  { name: 'process', message: 'engine は I/O 禁止。' },
  { name: 'require', message: 'engine は I/O 禁止。' },
  { name: 'fetch', message: 'engine は I/O 禁止。' },
  { name: 'parseFloat', message: 'engine は浮動小数禁止。' },
];
const nondeterministicProps = ['random', 'sin', 'cos', 'tan', 'atan', 'atan2', 'exp', 'log', 'pow', 'sqrt', 'hypot', 'cbrt']
  .map((property) => ({ object: 'Math', property, message: `engine は決定論的・整数のみ: Math.${property} 禁止。` }));

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'runs/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: ['packages/engine/src/**/*.ts'],
    rules: {
      'no-restricted-globals': ['error', ...nondeterministicGlobals],
      'no-restricted-properties': ['error', ...nondeterministicProps],
      'no-restricted-imports': ['error', {
        paths: ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'path', 'node:path', 'http', 'node:http', 'net', 'node:net', 'child_process', 'node:child_process']
          .map((name) => ({ name, message: 'engine は I/O 禁止。' })),
        patterns: [{ group: ['@muse/server', '@muse/server/*', '@muse/tools'], message: 'engine は server/tools に依存しない。' }],
      }],
    },
  },
  {
    files: ['packages/shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@muse/engine', '@muse/content', '@muse/server', '@muse/client', '@muse/tools'], message: 'shared は他パッケージに依存しない。' }],
      }],
      'no-restricted-properties': ['error', { object: 'Math', property: 'random', message: 'shared に乱数を置かない。' }],
    },
  },
  {
    files: ['packages/content/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@muse/engine', '@muse/server', '@muse/client', '@muse/tools'], message: 'content は shared 以外に依存しない。' }],
      }],
    },
  },
  {
    files: ['packages/client/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { window: 'readonly', document: 'readonly' } },
    rules: { 'no-restricted-imports': ['error', noEngineInClient] },
  },
  {
    // プレイヤー向けアダプタは World に直接触れない（PlayerPort 経由のみ）
    files: ['packages/server/src/mcp/**/*.ts', 'packages/server/src/ws/player*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['@muse/engine', '**/session/world*'], message: 'プレイヤー向けコードは PlayerPort 以外から World に触れない。' }],
      }],
    },
  },
);

import { defineConfig } from 'vite';

// root は packages/client（npm --workspace @muse/client run build/dev で cwd がここになる）
export default defineConfig({
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: {
    port: 5173,
    proxy: {
      // xfwd: 接続元を X-Forwarded-For で伝える（S3a §27.9 の 5。サーバーは、それで「同じ機械からの接続」かを見分ける）
      '/api': { target: 'http://127.0.0.1:7777', xfwd: true },
      '/mcp': { target: 'http://127.0.0.1:7777', xfwd: true },
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true, xfwd: true },
    },
  },
});

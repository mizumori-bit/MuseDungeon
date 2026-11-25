import { defineConfig } from 'vite';
import type { ProxyOptions } from 'vite';

const TARGET = 'http://127.0.0.1:7777';
/**
 * 開発用のサーバーの proxy（S8a。SEASON.md §55.6）: サーバーは、Host が許しの一覧（受けたポートつき）で、Origin が Host と同じ origin のときだけ
 * 「同じ機械」と認める。この proxy は Host をサーバーのもの（changeOrigin）にし、この開発用のサーバー自身の画面（localhost・127.0.0.1 の 5173）
 * から来た Origin だけを、サーバーの origin に置き換える（ほかのページの Origin は、そのまま渡して断らせる）
 */
const DEV_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
const proxyTo = (target: string, ws = false): ProxyOptions => ({
  target, ws, xfwd: true, changeOrigin: true,
  configure: (proxy) => {
    const fix = (proxyReq: { getHeader(n: string): unknown; setHeader(n: string, v: string): void }) => {
      const o = proxyReq.getHeader('origin');
      if (typeof o === 'string' && DEV_ORIGINS.has(o)) proxyReq.setHeader('origin', TARGET);
    };
    proxy.on('proxyReq', fix);
    proxy.on('proxyReqWs', fix);
  },
});

// root は packages/client（npm --workspace @muse/client run build/dev で cwd がここになる）
export default defineConfig({
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: {
    port: 5173,
    proxy: {
      // xfwd: 接続元を X-Forwarded-For で伝える（S3a §27.9 の 5。サーバーは、それで「同じ機械からの接続」かを見分ける）
      '/api': proxyTo(TARGET),
      '/mcp': proxyTo(TARGET),
      '/ws': proxyTo('ws://127.0.0.1:7777', true),
    },
  },
});

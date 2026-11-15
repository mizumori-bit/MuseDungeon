import { defineConfig } from 'vite';

// root は packages/client（npm --workspace @muse/client run build/dev で cwd がここになる）
export default defineConfig({
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/mcp': 'http://127.0.0.1:7777',
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
});

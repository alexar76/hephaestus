import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  // The hub mounts the built bundle at /studio, so every asset URL has to be written
  // relative to that prefix — an absolute /assets/... 404s behind the mount.
  base: '/studio/',
  resolve: {
    alias: { '@core': fileURLToPath(new URL('../src', import.meta.url)) },
  },
  // `npm run dev` serves only this bundle, but every fetch the page makes is same-origin
  // by design (the hub's CORS is fail-closed, so a cross-origin studio cannot read the
  // catalogue at all). Without this proxy the dev server answers /ai-market/... itself and
  // the page opens on an empty catalogue — so point those paths at a real hub. Default is
  // production, read-only apart from Run, which is metered per visitor like any other.
  server: {
    proxy: Object.fromEntries(
      ['/ai-market', '/studio/run', '/studio/trace', '/studio-ui-i18n.json'].map((path) => [
        path,
        { target: process.env.HEPHAESTUS_HUB || 'https://modelmarket.dev', changeOrigin: true },
      ]),
    ),
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
});

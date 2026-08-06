/**
 * Phase 2 uses esbuild via `scripts/build.mjs` for reliable MV3 outputs
 * (content IIFE + background ESM + sidepanel). This file documents the
 * intended multi-entry layout from the phase plan for future Vite migration.
 */
import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/index.ts'),
        sidepanel: resolve(__dirname, 'src/sidepanel/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
      },
    },
  },
});

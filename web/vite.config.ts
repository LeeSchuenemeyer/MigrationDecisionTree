import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// `shared/` is plain TypeScript source that both web/ and api/ compile into
// their own bundles. It is deliberately not an npm workspace package: SWA's
// Oryx build and workspace hoisting interact badly, and the failure mode
// (missing deps at runtime, zero functions registered) is slow to diagnose.
const sharedDir = fileURLToPath(new URL('../shared', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': sharedDir,
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Allow importing from ../shared during dev.
    fs: { allow: ['..'] },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    /**
     * Pinned to the oldest engine we actually have to serve, rather than
     * inheriting Vite's default (which tracks "baseline widely available" and
     * will drift forward under us on a dependency bump).
     *
     * The floor is the LG StanbyME 2. webOS 24 ships Chromium 108, webOS 25
     * ships Chromium 120 — and which one a given unit runs is a fact about the
     * device, not something we can assume. 108 is the safe assumption; open
     * /compat.html on the tablet to find out what it actually is.
     *
     * This governs JS syntax only. Tailwind v4 needs Chrome 111+ for
     * `color-mix()`, but it emits an 8-digit-hex fallback outside the
     * `@supports` guard for every opacity modifier, so on 108 the colours
     * still land — verified against the built CSS, not assumed.
     *
     * Android tablets and phones are all far newer than this; the floor costs
     * them nothing but a few bytes of downlevelled syntax.
     */
    target: ['chrome108', 'safari16', 'firefox115'],
  },
});

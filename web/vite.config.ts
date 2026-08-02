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
  },
});

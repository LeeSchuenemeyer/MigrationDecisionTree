import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { build, context } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

/**
 * Bundle the Functions app into a single file.
 *
 * `nodePaths` is load-bearing, not incidental.
 *
 * We import `shared/` as plain source from outside this package. esbuild
 * resolves a bare import (`luxon`, `zod`) starting from the *importing file's*
 * directory, so an import inside `../shared/time.ts` searches
 * `shared/node_modules` and then the repo root — it never looks in
 * `api/node_modules`, where the dependency actually is.
 *
 * That failed only in CI: locally the repo root has its own node_modules (the
 * dev-tooling package that runs the shared/ tests), which silently satisfied
 * the import. The deploy workflow installs only web/ and api/, so the root
 * directory is bare and the build broke.
 *
 * Pointing nodePaths at api/node_modules makes resolution deterministic and
 * independent of whatever happens to exist at the repo root. Every runtime
 * dependency of shared/ must therefore be declared in api/package.json.
 */
const options = {
  entryPoints: [resolve(here, 'src/index.ts')],
  outfile: resolve(here, 'dist/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  // The host provides this; everything else is inlined, which is why the
  // deploy can prune api/ to a single runtime dependency.
  external: ['@azure/functions'],
  nodePaths: [resolve(here, 'node_modules')],
  logLevel: 'info',
};

if (watch) {
  // esbuild 0.17+ moved watch mode to the context API.
  const ctx = await context(options);
  await ctx.watch();
  console.log('watching for changes…');
} else {
  await build(options);
}

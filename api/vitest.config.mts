import { defineConfig } from 'vitest/config';

/**
 * Integration tests for the api package.
 *
 * These run against Azurite, not mocks — the whole point is to exercise the
 * storage semantics the design leans on (deterministic row keys, 409 on
 * duplicate create, ETag conflicts). A mocked table client would happily agree
 * with whatever we assumed and catch none of it.
 *
 * Azurite's table implementation is not byte-identical to Azure. Known
 * divergences are ETag semantics and conditional create, which is exactly what
 * we depend on — so the plan calls for exercising these paths against a real
 * storage account once per phase too.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // Storage tests share one emulator; running files in parallel makes table
    // state non-deterministic across suites.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

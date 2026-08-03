import { defineConfig, devices } from '@playwright/test';

/**
 * Exactly one end-to-end test, deliberately.
 *
 * One test catches integration breakage — the wiring between the SPA, the SWA
 * routing layer, the Functions, and Table Storage, none of which the unit and
 * Azurite tests exercise together. Ten become maintenance nobody wants and a
 * suite people start skipping.
 *
 * It runs against `swa start` on :4280, never Vite on :5173: only the SWA CLI
 * applies staticwebapp.config.json routing, proxies /api, and preserves the
 * same-origin cookie behaviour the whole session design depends on. Testing
 * against :5173 would pass while production was broken.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  // The flow is inherently sequential — one household, one shared points
  // ledger — and parallel workers would approve each other's chores.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? 'line' : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: process.env['E2E_BASE_URL'] ?? 'http://localhost:4280',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      // Escape hatch for environments that already have a Chromium and would
      // rather not download a second one whose build number happens to match
      // this Playwright release. Unset, Playwright resolves its own.
      ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']
        ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] }
        : {}),
    },
  },
  projects: [
    {
      name: 'kiosk',
      use: {
        ...devices['Desktop Chrome'],
        // The kiosk surface is the one that must not break: it is unattended,
        // it is the primary device, and it is the only surface with no
        // navigation chrome to work around a broken screen with.
        viewport: { width: 1280, height: 800 },
        hasTouch: true,
      },
    },
  ],
});

import type { HttpRequest } from '@azure/functions';

/**
 * Minimal stand-in for the parts of HttpRequest our auth layer touches.
 *
 * The real class is constructed by the Functions host and is awkward to build
 * by hand; everything under test reads cookies via `headers.get('cookie')` and
 * nothing else, so this is a faithful surface rather than a mock of behavior.
 */
export function fakeRequest(options: { cookies?: Record<string, string>; body?: unknown } = {}): HttpRequest {
  const cookieHeader = Object.entries(options.cookies ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const headers = new Map<string, string>();
  if (cookieHeader) headers.set('cookie', cookieHeader);

  return {
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    params: {},
    query: new URLSearchParams(),
    json: async () => options.body,
  } as unknown as HttpRequest;
}

/** Extract a cookie value from a Set-Cookie string produced by lib/auth. */
export function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0]!.split('=').slice(1).join('=');
}

/**
 * Wipe one household's rows before a suite runs.
 *
 * Azurite persists between runs, so without this the second `npm test` sees
 * state left by the first — a chore already claimed, a queue already drained —
 * and fails for reasons that have nothing to do with the code under test.
 * Scoped by the household prefix that every partition key carries, so it can
 * never reach another household's data.
 */
export async function purgeHousehold(householdId: string): Promise<void> {
  const { ALL_TABLES } = await import('../../shared/keys.js');
  const { table } = await import('../src/lib/tables.js');

  await Promise.all(
    ALL_TABLES.map(async (name) => {
      const client = table(name);
      const doomed: { partitionKey: string; rowKey: string }[] = [];
      for await (const e of client.listEntities()) {
        const pk = String(e.partitionKey ?? '');
        // Match the `|{householdId}` segment exactly, not as a substring, so
        // purging "test" cannot also wipe "test-tasks".
        if (pk.split('|')[1] === householdId) {
          doomed.push({ partitionKey: pk, rowKey: String(e.rowKey) });
        }
      }
      for (const d of doomed) {
        await client.deleteEntity(d.partitionKey, d.rowKey).catch(() => undefined);
      }
    }),
  );
}

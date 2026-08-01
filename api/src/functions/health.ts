import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { localDateNow } from '../../../shared/time.js';
import { env, VERSION } from '../lib/env.js';
import { json } from '../lib/http.js';
import { ensureTables } from '../lib/tables.js';

/**
 * Liveness plus a real storage round-trip.
 *
 * Deliberately proves more than "the process is up": it reports the household
 * id and the resolved local date, which is how you catch a misconfigured
 * HOUSEHOLD_ID (preview writing to production) or HOUSEHOLD_TZ (wrong-day
 * partitions) before they corrupt data rather than after.
 */
export async function health(
  _req: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  let storage: 'ok' | 'unconfigured' | 'error' = 'unconfigured';

  if (env.tablesConnectionStringOrNull) {
    try {
      await ensureTables();
      storage = 'ok';
    } catch (e) {
      context.error('Storage check failed', e);
      storage = 'error';
    }
  }

  return json({
    ok: storage !== 'error',
    version: VERSION,
    householdId: env.householdId,
    timezone: env.timezone,
    localDate: localDateNow(env.timezone),
    storage,
  });
}

app.http('health', {
  route: 'health',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: health,
});

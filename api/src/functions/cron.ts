import { timingSafeEqual } from 'node:crypto';
import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { addLocalDays, localDateNow } from '../../../shared/time.js';
import { isConfigured } from '../lib/claude.js';
import { householdConfig } from '../lib/config.js';
import { env } from '../lib/env.js';
import { error, json } from '../lib/http.js';
import { annotateRecentFeed, fillFallbackCommentary } from '../services/commentary.js';
import { ensureChallenge } from '../services/challenge.js';
import { expireOverdue, materialize } from '../services/materializer.js';
import { listTasksForDate, today } from '../services/tasks.js';
import { ensureWatchChannel } from './google.js';
import { sync as googleSync } from '../services/googleSync.js';

/**
 * POST /api/cron/tick — the timer trigger SWA does not have.
 *
 * Managed Functions on Static Web Apps are HTTP-trigger only, so every
 * "scheduled" behavior in this app is either lazy-on-read or driven from here
 * by a GitHub Actions schedule.
 *
 * Nothing correctness-critical depends on this endpoint. Materialization and
 * expiry both also run lazily on read; what the tick adds is the work nobody
 * would otherwise trigger — batched commentary, the daily challenge — and a
 * backstop for a household that has not opened the app all day.
 *
 * ⚠️ GitHub Actions cron runs 5-20 minutes late under load and GitHub disables
 * scheduled workflows after 60 days of repository inactivity. Every job below
 * is idempotent and separately guarded precisely because this driver is
 * best-effort.
 */
export async function postTick(req: HttpRequest): Promise<HttpResponseInit> {
  if (!authorized(req)) return error('Nope.', 401);

  const date = localDateNow(env.timezone);
  const results: Record<string, unknown> = { date };

  // Each job is isolated: one failing must not stop the rest, or a transient
  // Anthropic outage would also stop chores materializing.
  results['materialize'] = await attempt(() => materialize());
  results['expire'] = await attempt(() => expireOverdue());

  const config = await householdConfig();

  results['challenge'] = await attempt(async () => {
    if (!config.challengeEnabled) return { skipped: true };
    const chores = (await listTasksForDate(today()))
      .filter((t) => t.status === 'open')
      .slice(0, 12)
      .map((t) => t.title);
    return ensureChallenge(date, chores);
  });

  results['commentary'] = await attempt(async () => {
    // With commentary off or unconfigured, still lay down hand-written lines —
    // the ticker reads better and it costs nothing.
    if (!config.commentaryEnabled || !isConfigured()) {
      return { filled: await fillFallbackCommentary(date), generated: 0 };
    }
    return annotateRecentFeed(date);
  });

  // The ticker backfills from yesterday when today is quiet (see recentFeed),
  // so the fallback fill has to cover the same window or a quiet morning shows
  // a mix of styled lines and bare headlines. Generation deliberately does NOT
  // reach back: paying to annotate yesterday's news is spend on stale content.
  results['commentaryBackfill'] = await attempt(() =>
    fillFallbackCommentary(addLocalDays(date, -1)),
  );

  // Google: renew the push channel before it lapses, and force a sync. The
  // webhook is the fast path, but channels expire in about a week and this is
  // the only thing that notices.
  results['googleChannel'] = await attempt(() => ensureWatchChannel());
  results['googleSync'] = await attempt(() => googleSync({ force: true }));

  return json({ ok: true, results });
}

/**
 * Constant-time comparison on a shared secret.
 *
 * This endpoint spends money (it is the only scheduled path that can call
 * Anthropic), so it is the one route where an unauthenticated caller has a
 * direct cost. `timingSafeEqual` throws on a length mismatch, hence the guard.
 */
function authorized(req: HttpRequest): boolean {
  const provided = req.headers.get('x-cron-secret');
  if (!provided) return false;

  let expected: string;
  try {
    expected = env.cronSharedSecret;
  } catch {
    // No secret configured — refuse rather than running open.
    return false;
  }

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function attempt<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'failed' };
  }
}

app.http('cron-tick', {
  route: 'cron/tick',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: postTick,
});

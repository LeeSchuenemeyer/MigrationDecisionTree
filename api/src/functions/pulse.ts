import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { json, withETag } from '../lib/http.js';
import { requireRead } from '../lib/auth.js';
import { readRev, sliceCounters } from '../lib/rev.js';
import { recentFeed, tickerItems } from '../services/feed.js';
import { today } from '../services/tasks.js';
import { taskGuard } from './tasks.js';

/**
 * GET /api/pulse — the only thing the kiosk polls.
 *
 * This endpoint is the whole reason a 24/7 wall tablet costs ~40 MB/month
 * instead of hammering six queries on their own intervals. Everything else in
 * the client is `staleTime: Infinity` and only refetches when the counters here
 * say its slice actually moved.
 *
 * Two layers of cheapness, and the order matters:
 *
 *   1. An ETag on the global `rev`. An idle household — which is most hours of
 *      most days — gets a 304 with no body at all. That is the common case and
 *      it costs headers only.
 *   2. When something did change, the per-slice counters (~120 bytes). The
 *      client diffs them against its previous map and invalidates only the keys
 *      that moved. The server does not attempt this diff itself: it has no
 *      history, and the obvious approximation invalidates everything forever.
 *
 * Deliberately `requireRead`, so an enrolled tablet with nobody signed in keeps
 * updating. A wall display that goes stale the moment a session expires is not
 * a wall display.
 */
export async function getPulse(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);

  const rev = await readRev();
  const etag = `W/"${rev.rev}"`;

  return withETag(
    {
      rev: rev.rev,
      slices: sliceCounters(rev),
      // The client renders local dates; sending the household's idea of "today"
      // stops a tablet with a wrong clock from asking for the wrong partition.
      today: today(),
      serverTime: new Date().toISOString(),
    },
    etag,
    req.headers.get('if-none-match'),
  );
}

/**
 * GET /api/feed — the ticker payload.
 *
 * ETagged on the feed and task counters together, since the marquee mixes
 * activity with deadlines and either moving should refresh it.
 */
export async function getFeed(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);

  const rev = await readRev();
  const etag = `W/"f${rev.feed}-t${rev.tasks}"`;
  const inm = req.headers.get('if-none-match');
  if (inm && inm === etag) return { status: 304, headers: { etag } };

  const items = await tickerItems();
  return withETag({ items, today: today() }, etag, null);
}

/** GET /api/feed/history — the plain activity list, for a scrollable view. */
export async function getFeedHistory(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  const limit = Math.min(100, Math.max(1, Number(req.query.get('limit') ?? 40) || 40));
  return json({ items: await recentFeed(limit), today: today() });
}

app.http('pulse', {
  route: 'pulse',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: taskGuard(getPulse),
});
app.http('feed', {
  route: 'feed',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: taskGuard(getFeed),
});
app.http('feed-history', {
  route: 'feed/history',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: taskGuard(getFeedHistory),
});

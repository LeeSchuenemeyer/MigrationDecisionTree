import { randomBytes, timingSafeEqual } from 'node:crypto';
import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import { CONFIG_ROWS, TABLES, configPK, configRK } from '../../../shared/keys.js';
import { addLocalDays, assertLocalDate, localDateNow } from '../../../shared/time.js';
import { requireElevated, requireMember, requireParent, requireRead } from '../lib/auth.js';
import { env } from '../lib/env.js';
import {
  GoogleError,
  authorizeUrl,
  connectionStatus,
  disconnect,
  exchangeCode,
  listCalendars,
  setCalendar,
  readChannel,
  watchEvents,
  writeChannel,
} from '../lib/google.js';
import { badRequest, error, json } from '../lib/http.js';
import { getEntity, remove, upsert } from '../lib/tables.js';
import {
  createEvent,
  deleteEvent,
  listConflicts,
  listEventsBetween,
  restoreConflictVersion,
  sync,
  syncState,
  upcomingEvents,
  updateEvent,
} from '../services/googleSync.js';
import { taskGuard } from './tasks.js';

/**
 * Google Calendar over HTTP.
 *
 * One household-level connection, not per-person login. PINs already handle
 * identity inside the app; this is a single stored refresh token that lets the
 * board read the family calendar. One parent connects once.
 */

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

interface StateRow {
  state: string;
  createdAt: string;
  startedBy: string;
}

const STATE_TTL_MS = 10 * 60_000;

/**
 * GET /api/google/oauth/start
 *
 * Step-up required. Connecting a calendar hands this app durable read access to
 * the family's schedule — that belongs in the same tier as revoking a device or
 * changing a PIN, not with everyday chore approval.
 */
export async function getOauthStart(req: HttpRequest): Promise<HttpResponseInit> {
  const { session } = await requireElevated(req);

  // CSRF: a random state, stored server-side and checked on the callback.
  // Without it, anyone can hand a parent a link that connects *their* calendar
  // to this household.
  const state = randomBytes(24).toString('base64url');
  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.oauthState),
    state,
    createdAt: new Date().toISOString(),
    startedBy: session.memberId,
  } satisfies StateRow & { partitionKey: string; rowKey: string });

  return json({ url: authorizeUrl(state) });
}

/**
 * GET /api/google/oauth/callback
 *
 * Google redirects a browser here, so this returns a redirect rather than JSON —
 * whatever it responds with is what a parent sees in their address bar.
 */
export async function getOauthCallback(req: HttpRequest): Promise<HttpResponseInit> {
  const code = req.query.get('code');
  const state = req.query.get('state');
  const denied = req.query.get('error');

  if (denied) return redirect('/settings?google=denied');
  if (!code || !state) return redirect('/settings?google=bad_request');

  const stored = await getEntity<StateRow>(
    TABLES.config,
    configPK(env.householdId),
    configRK(CONFIG_ROWS.oauthState),
  );
  // One-shot: consumed whether or not it matched, so a leaked state cannot be
  // replayed.
  await remove(TABLES.config, configPK(env.householdId), configRK(CONFIG_ROWS.oauthState)).catch(
    () => undefined,
  );

  if (!stored || !constantTimeEqual(stored.state, state)) {
    return redirect('/settings?google=bad_state');
  }
  if (Date.now() - Date.parse(stored.createdAt) > STATE_TTL_MS) {
    return redirect('/settings?google=expired');
  }

  const ok = await exchangeCode(code, stored.startedBy);
  // A failure here is most often Google declining to re-issue a refresh token.
  // Better to say so now than to look connected and stop syncing within the
  // hour — see the prompt=consent note in lib/google.ts.
  return redirect(ok ? '/settings?google=connected' : '/settings?google=no_refresh_token');
}

/** GET /api/google/status — safe to call with nothing configured. */
export async function getStatus(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  const connection = await connectionStatus();

  const state = connection.calendarId ? await syncState(connection.calendarId) : null;
  return json({
    ...connection,
    lastFullAt: state?.lastFullAt ?? null,
    lastIncrementalAt: state?.lastIncrementalAt ?? null,
    failureCount: state?.failureCount ?? 0,
    lastError: state?.lastError ?? null,
  });
}

/** GET /api/google/calendars — the picker. */
export async function getCalendars(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);
  try {
    return json({ calendars: await listCalendars() });
  } catch {
    return error('Could not reach Google. Try reconnecting.', 502);
  }
}

const PickBody = z.object({ calendarId: z.string().min(1), summary: z.string().min(1).max(200) });

/** POST /api/google/calendar — choose which calendar the board shows. */
export async function postPickCalendar(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);

  const parsed = PickBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('Which calendar?');

  await setCalendar(parsed.data.calendarId, parsed.data.summary);

  // Sync immediately so the board is populated before anyone navigates to it.
  // Failure is fine — the lazy path on the next read will pick it up.
  const result = await sync({ force: true }).catch(() => null);
  return json({ ok: true, sync: result });
}

/** DELETE /api/google/connection — disconnect. Step-up, since it is destructive. */
export async function deleteConnection(req: HttpRequest): Promise<HttpResponseInit> {
  await requireElevated(req);
  await disconnect();
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * GET /api/events?from=&to=
 *
 * This is the fallback that actually matters. The kiosk polls all day, so an
 * incremental sync on read bounds staleness at five minutes even with webhooks
 * entirely broken — which they will be, at some point, since channels expire
 * weekly and GitHub Actions cron is best-effort.
 *
 * The sync is best-effort inside the read: if Google is down, the board still
 * renders whatever was last stored rather than erroring.
 */
export async function getEvents(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);

  const today = localDateNow(env.timezone);
  const from = req.query.get('from') ?? today;
  const to = req.query.get('to') ?? addLocalDays(today, 30);

  try {
    assertLocalDate(from);
    assertLocalDate(to);
  } catch {
    return badRequest('Dates must look like YYYY-MM-DD.');
  }
  if (to < from) return badRequest('That range runs backwards.');

  const synced = await sync().catch(() => null);
  const events = await listEventsBetween(from, to);

  return json({ events, from, to, today, synced: synced?.mode ?? 'unavailable' });
}

/** GET /api/events/upcoming — the short list for the board and the ticker. */
export async function getUpcoming(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  await sync().catch(() => null);
  return json({ events: await upcomingEvents(6) });
}

/** POST /api/google/sync — a parent forcing a refresh. */
export async function postSync(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);
  try {
    return json(await sync({ force: true }));
  } catch (e) {
    return error(e instanceof Error ? e.message : 'Sync failed.', 502);
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

/**
 * POST /api/google/webhook
 *
 * Google's notification is a *thin* signal — headers only, no event data. The
 * contract is: verify the channel token, return 200 immediately, then sync.
 * Holding the response open while syncing gets the channel throttled or dropped.
 *
 * `resource_state: sync` is the handshake Google sends when a channel opens.
 * Treating it as a change notification means a full sync every time a channel
 * is created or renewed.
 */
export async function postWebhook(req: HttpRequest): Promise<HttpResponseInit> {
  const channelToken = req.headers.get('x-goog-channel-token');
  const resourceState = req.headers.get('x-goog-resource-state');

  const stored = await readChannel();
  if (!stored.token || !channelToken || !constantTimeEqual(stored.token, channelToken)) {
    // 200 rather than 401 on purpose: a non-2xx teaches Google to retry and
    // eventually drop the channel, and an unauthenticated caller learns nothing
    // either way.
    return { status: 200 };
  }

  if (resourceState === 'sync') return { status: 200 };

  // Fire and forget. The response must not wait on Google.
  void sync({ force: true }).catch(() => undefined);
  return { status: 200 };
}

/**
 * Ensure a push channel exists.
 *
 * Called from the cron tick. Channels expire in about a week, so this renews
 * within a day of expiry rather than waiting for silence to reveal the problem.
 */
export async function ensureWatchChannel(): Promise<{ renewed: boolean; reason?: string }> {
  const connection = await connectionStatus();
  if (!connection.connected || !connection.calendarId) {
    return { renewed: false, reason: 'not_connected' };
  }

  const expiry = connection.channelExpiresAt ? Date.parse(connection.channelExpiresAt) : 0;
  if (Number.isFinite(expiry) && expiry - 24 * 3_600_000 > Date.now()) {
    return { renewed: false, reason: 'still_valid' };
  }

  const webhookUrl = env.googleWebhookUrl;
  if (!webhookUrl) return { renewed: false, reason: 'no_public_url' };

  const channelId = randomBytes(16).toString('hex');
  const channelToken = randomBytes(24).toString('base64url');

  const result = await watchEvents(connection.calendarId, channelId, channelToken, webhookUrl);
  if (!result) return { renewed: false, reason: 'watch_failed' };

  await writeChannel(channelId, channelToken, result.expiration);
  return { renewed: true };
}

// ---------------------------------------------------------------------------

function redirect(location: string): HttpResponseInit {
  return { status: 302, headers: { location } };
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

app.http('google-oauth-start', { route: 'google/oauth/start', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getOauthStart) });
app.http('google-oauth-callback', { route: 'google/oauth/callback', methods: ['GET'], authLevel: 'anonymous', handler: getOauthCallback });
app.http('google-status', { route: 'google/status', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getStatus) });
app.http('google-calendars', { route: 'google/calendars', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getCalendars) });
app.http('google-pick', { route: 'google/calendar', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postPickCalendar) });
app.http('google-disconnect', { route: 'google/connection', methods: ['DELETE'], authLevel: 'anonymous', handler: taskGuard(deleteConnection) });
app.http('google-sync', { route: 'google/sync', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postSync) });
app.http('google-webhook', { route: 'google/webhook', methods: ['POST'], authLevel: 'anonymous', handler: postWebhook });
app.http('events', { route: 'events', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getEvents) });
app.http('events-upcoming', { route: 'events/upcoming', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getUpcoming) });

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

const EventBody = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(1000).nullish(),
    location: z.string().max(300).nullish(),
    allDay: z.boolean(),
    startUtc: z.string().datetime().optional(),
    endUtc: z.string().datetime().optional(),
    startLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endLocalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine(
    (v) => (v.allDay ? Boolean(v.startLocalDate) : Boolean(v.startUtc && v.endUtc)),
    'An all-day event needs a date; a timed one needs a start and an end.',
  )
  .refine((v) => v.allDay || (v.endUtc ?? '') > (v.startUtc ?? ''), 'That event ends before it starts.');

/**
 * POST /api/events — create.
 *
 * requireMember, not requireParent. Adding a football match to the family
 * calendar is not a privileged act, and a board where only parents can add
 * anything is a board the kids stop opening.
 */
export async function postEvent(req: HttpRequest): Promise<HttpResponseInit> {
  const session = await requireMember(req);

  const parsed = EventBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Could not read that event.');

  try {
    const event = await createEvent(parsed.data, {
      id: session.memberId,
      displayName: session.displayName,
    });
    return json({ event });
  } catch (e) {
    return googleFailure(e);
  }
}

/** PATCH /api/events/{googleEventId} — edit. */
export async function patchEventRoute(req: HttpRequest): Promise<HttpResponseInit> {
  const session = await requireMember(req);

  const id = req.params['id'];
  if (!id) return badRequest('Which event?');

  const parsed = EventBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? 'Could not read that event.');

  try {
    const event = await updateEvent(decodeURIComponent(id), parsed.data, {
      id: session.memberId,
      displayName: session.displayName,
    });
    return json({ event });
  } catch (e) {
    return googleFailure(e);
  }
}

/**
 * DELETE /api/events/{googleEventId}
 *
 * requireParent rather than requireMember: creating is cheap to undo, deleting
 * someone else's dentist appointment from a wall tablet is not.
 */
export async function deleteEventRoute(req: HttpRequest): Promise<HttpResponseInit> {
  const { session, member } = await requireParent(req);

  const id = req.params['id'];
  if (!id) return badRequest('Which event?');

  try {
    const result = await deleteEvent(decodeURIComponent(id), {
      id: session.memberId,
      displayName: member.displayName,
    });
    return json(result);
  } catch (e) {
    return googleFailure(e);
  }
}

/** POST /api/events/{id}/restore — "actually, use mine" on a conflict. */
export async function postRestore(req: HttpRequest): Promise<HttpResponseInit> {
  const { session, member } = await requireParent(req);

  const id = req.params['id'];
  if (!id) return badRequest('Which event?');

  try {
    const event = await restoreConflictVersion(decodeURIComponent(id), {
      id: session.memberId,
      displayName: member.displayName,
    });
    return json({ event });
  } catch (e) {
    return googleFailure(e);
  }
}

/** GET /api/events/conflicts — what still needs a decision. */
export async function getConflicts(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  return json({ conflicts: await listConflicts() });
}

/**
 * Map a Google failure onto something a family can act on.
 *
 * A 403 here almost always means the household is still on a Phase 6
 * read-only token, which is a "reconnect once" problem rather than a bug — so
 * it says that rather than surfacing Google's own wording.
 */
function googleFailure(e: unknown): HttpResponseInit {
  if (e instanceof GoogleError) {
    return error(e.message, e.status >= 400 && e.status < 600 ? e.status : 502);
  }
  return error('Could not reach Google.', 502);
}

app.http('events-create', { route: 'events', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postEvent) });
app.http('events-update', { route: 'events/{id}', methods: ['PATCH'], authLevel: 'anonymous', handler: taskGuard(patchEventRoute) });
app.http('events-delete', { route: 'events/{id}', methods: ['DELETE'], authLevel: 'anonymous', handler: taskGuard(deleteEventRoute) });
app.http('events-restore', { route: 'events/{id}/restore', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postRestore) });
app.http('events-conflicts', { route: 'events/conflicts', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getConflicts) });

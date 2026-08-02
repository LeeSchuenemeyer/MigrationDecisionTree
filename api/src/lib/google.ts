import { CONFIG_ROWS, TABLES, configPK, configRK } from '../../../shared/keys.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { env } from './env.js';
import { getEntity, remove, upsert } from './tables.js';

/**
 * Google OAuth and the three Calendar endpoints this app actually uses.
 *
 * Deliberately NO `google-auth-library`, and no `googleapis`.
 *
 * The plan called for google-auth-library, and building it made the case for
 * dropping it: what we need is an authorize URL, a code exchange, and a refresh
 * — three POSTs to one endpoint, about sixty lines. The library's value is
 * service-account JWT signing and ADC discovery, neither of which applies to a
 * single household-level OAuth connection.
 *
 * Removing it also settles a real problem rather than deferring it:
 * google-auth-library@11 declares `node >= 22` while the SWA runtime is pinned
 * to `node:20`. Pinning an older major would have inherited a dependency
 * actively fighting the runtime; not taking the dependency resolves it
 * permanently and shrinks the bundle.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/**
 * Scopes.
 *
 * `calendar.events` is read AND write on events — it supersedes
 * `calendar.readonly`, so a household connected before Phase 7 holds a token
 * that can read but not write. That is handled rather than errored: reads keep
 * working, write controls are hidden, and a parent is told once that
 * reconnecting enables editing. Asking for write access before anything writes
 * would have been the wrong trade.
 */
export const READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** What we ask for now. Existing read-only tokens keep working until reconnect. */
export const REQUESTED_SCOPE = WRITE_SCOPE;

interface OAuthRow {
  /** AES-256-GCM. Never stored or logged in plaintext. */
  refreshTokenEncrypted: string;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  scope: string;
  connectedBy: string;
  connectedAt: string;
  /** Which calendar the family picked. Null until they choose. */
  calendarId: string | null;
  calendarSummary: string | null;
  /** Verifies inbound webhooks actually came from our own watch request. */
  channelToken: string | null;
  channelId: string | null;
  channelExpiresAt: string | null;
}

export interface GoogleConnection {
  connected: boolean;
  /** False for a token minted before Phase 7 — reads fine, cannot write. */
  canWrite: boolean;
  calendarId: string | null;
  calendarSummary: string | null;
  connectedAt: string | null;
  scope: string | null;
  channelExpiresAt: string | null;
}

// ---------------------------------------------------------------------------
// Stored connection
// ---------------------------------------------------------------------------

async function readRow(): Promise<OAuthRow | null> {
  return getEntity<OAuthRow>(TABLES.config, configPK(env.householdId), configRK(CONFIG_ROWS.googleOAuth));
}

async function writeRow(patch: Partial<OAuthRow>): Promise<void> {
  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.googleOAuth),
    ...patch,
  });
}

/**
 * Can this connection write?
 *
 * Checked against the *stored* scope rather than what we currently request, so
 * a household that connected during Phase 6 is correctly reported as read-only
 * instead of being handed write controls that 403 on use.
 */
export function scopeAllowsWrite(scope: string | null | undefined): boolean {
  return typeof scope === 'string' && scope.includes(WRITE_SCOPE);
}

export async function canWrite(): Promise<boolean> {
  const row = await readRow();
  return Boolean(row?.refreshTokenEncrypted) && scopeAllowsWrite(row?.scope);
}

export async function connectionStatus(): Promise<GoogleConnection> {
  const row = await readRow();
  if (!row?.refreshTokenEncrypted) {
    return {
      connected: false,
      canWrite: false,
      calendarId: null,
      calendarSummary: null,
      connectedAt: null,
      scope: null,
      channelExpiresAt: null,
    };
  }
  return {
    connected: true,
    canWrite: scopeAllowsWrite(row.scope),
    calendarId: row.calendarId ?? null,
    calendarSummary: row.calendarSummary ?? null,
    connectedAt: row.connectedAt ?? null,
    scope: row.scope ?? null,
    channelExpiresAt: row.channelExpiresAt ?? null,
  };
}

export async function disconnect(): Promise<void> {
  await remove(TABLES.config, configPK(env.householdId), configRK(CONFIG_ROWS.googleOAuth));
}

export async function setCalendar(calendarId: string, summary: string): Promise<void> {
  await writeRow({ calendarId, calendarSummary: summary });
}

export async function readChannel(): Promise<{ token: string | null; id: string | null }> {
  const row = await readRow();
  return { token: row?.channelToken ?? null, id: row?.channelId ?? null };
}

export async function writeChannel(id: string, token: string, expiresAt: string): Promise<void> {
  await writeRow({ channelId: id, channelToken: token, channelExpiresAt: expiresAt });
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * The authorize URL.
 *
 * `access_type=offline` + `prompt=consent` together are what actually produce a
 * refresh token. Google issues one only on the *first* consent for a given
 * client/user pair — so without `prompt=consent`, a household that has
 * previously authorized this app gets an access token and nothing else, and the
 * connection silently dies an hour later.
 */
export function authorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: env.googleRedirectUri,
    response_type: 'code',
    scope: REQUESTED_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type: string;
}

export async function exchangeCode(code: string, connectedBy: string): Promise<boolean> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      redirect_uri: env.googleRedirectUri,
      grant_type: 'authorization_code',
    }),
  });

  if (!response.ok) return false;
  const token = (await response.json()) as TokenResponse;
  if (!token.refresh_token) {
    // No refresh token means the connection would die within the hour. Better
    // to fail the connect loudly now than to look connected and stop syncing
    // at lunchtime — see the prompt=consent note above.
    return false;
  }

  await writeRow({
    refreshTokenEncrypted: encryptSecret(token.refresh_token),
    accessToken: token.access_token,
    accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: token.scope ?? REQUESTED_SCOPE,
    connectedBy,
    connectedAt: new Date().toISOString(),
    calendarId: null,
    calendarSummary: null,
    channelToken: null,
    channelId: null,
    channelExpiresAt: null,
  });
  return true;
}

/**
 * A valid access token, refreshing when needed.
 *
 * Cached on the config row with a 60-second safety margin, so a burst of sync
 * calls costs one refresh rather than one per request.
 */
export async function accessToken(): Promise<string | null> {
  const row = await readRow();
  if (!row?.refreshTokenEncrypted) return null;

  const expiry = row.accessTokenExpiresAt ? Date.parse(row.accessTokenExpiresAt) : 0;
  if (row.accessToken && Number.isFinite(expiry) && expiry - 60_000 > Date.now()) {
    return row.accessToken;
  }

  const refreshToken = decryptSecret(row.refreshTokenEncrypted);
  if (!refreshToken) return null;

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: env.googleClientId,
      client_secret: env.googleClientSecret,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) {
    // A 400 here usually means the refresh token was revoked — or that the
    // OAuth consent screen is still in "Testing", where Google expires refresh
    // tokens after 7 days. That is the single most common way projects like
    // this break, which is why SETUP-TODO calls out publishing it.
    return null;
  }

  const token = (await response.json()) as TokenResponse;
  await writeRow({
    accessToken: token.access_token,
    accessTokenExpiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    // Google does not re-issue a refresh token on refresh; the stored one stays.
  });
  return token.access_token;
}

// ---------------------------------------------------------------------------
// Calendar API
// ---------------------------------------------------------------------------

export class GoogleError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
}

async function call<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const token = await accessToken();
  if (!token) throw new GoogleError('Google is not connected.', 401);

  const url = new URL(`${CALENDAR_API}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new GoogleError(body.slice(0, 300) || response.statusText, response.status);
  }
  return (await response.json()) as T;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  backgroundColor?: string;
}

export async function listCalendars(): Promise<CalendarListEntry[]> {
  const data = await call<{ items?: CalendarListEntry[] }>('/users/me/calendarList', {
    minAccessRole: 'reader',
    maxResults: '50',
  });
  return data.items ?? [];
}

export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurringEventId?: string;
  etag?: string;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
}

export interface EventsPage {
  items: GoogleEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

/**
 * List events.
 *
 * `singleEvents=true` is the important flag: recurring series arrive already
 * expanded into individual instances. That is 100% of the display value and
 * ~90% of the edit value, and it is why full RRULE round-tripping stays out of
 * scope — expanding recurrence correctly is comfortably a larger job than the
 * entire points economy.
 */
export async function listEvents(
  calendarId: string,
  options: {
    syncToken?: string;
    pageToken?: string;
    timeMin?: string;
    timeMax?: string;
  } = {},
): Promise<EventsPage> {
  const params: Record<string, string> = {
    singleEvents: 'true',
    maxResults: '250',
    showDeleted: 'true',
  };

  if (options.syncToken) {
    // An incremental request must not carry time bounds or an ordering — Google
    // rejects the combination, and the sync token already encodes the window.
    params['syncToken'] = options.syncToken;
  } else {
    params['orderBy'] = 'startTime';
    if (options.timeMin) params['timeMin'] = options.timeMin;
    if (options.timeMax) params['timeMax'] = options.timeMax;
  }
  if (options.pageToken) params['pageToken'] = options.pageToken;

  return call<EventsPage>(`/calendars/${encodeURIComponent(calendarId)}/events`, params);
}

/**
 * Ask Google to push change notifications to our webhook.
 *
 * Channels expire after roughly a week, which the cron tick renews. The
 * `token` we set here comes back on every notification as `X-Goog-Channel-Token`
 * and is the only thing that distinguishes a real notification from anyone who
 * found the public webhook URL.
 */
export async function watchEvents(
  calendarId: string,
  channelId: string,
  channelToken: string,
  webhookUrl: string,
): Promise<{ resourceId: string; expiration: string } | null> {
  const token = await accessToken();
  if (!token) return null;

  const response = await fetch(
    `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events/watch`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        token: channelToken,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  );

  if (!response.ok) return null;
  const data = (await response.json()) as { resourceId?: string; expiration?: string };
  if (!data.resourceId) return null;

  return {
    resourceId: data.resourceId,
    expiration: new Date(Number(data.expiration ?? Date.now() + 6 * 86_400_000)).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Marks an event as ours.
 *
 * `extendedProperties.private` is Google's own supported mechanism for
 * application metadata: it round-trips through their storage, survives
 * restarts, and is invisible to anyone reading the calendar normally.
 * `fdOrigin` scopes it to this household (so two dashboards on one calendar do
 * not claim each other's writes) and `fdRev` identifies the specific push,
 * which is what makes "is this my own change coming back?" answerable rather
 * than guessed.
 */
export interface EchoStamp {
  fdOrigin: string;
  fdRev: string;
}

export interface EventDraft {
  summary: string;
  description?: string | null;
  location?: string | null;
  /** Timed events. Mutually exclusive with `startDate`/`endDate`. */
  startDateTime?: string;
  endDateTime?: string;
  /** All-day. `endDate` is exclusive, per Google. */
  startDate?: string;
  endDate?: string;
}

function draftToBody(draft: EventDraft, stamp: EchoStamp): Record<string, unknown> {
  const body: Record<string, unknown> = {
    summary: draft.summary,
    extendedProperties: { private: { ...stamp } },
  };
  if (draft.description !== undefined) body['description'] = draft.description ?? '';
  if (draft.location !== undefined) body['location'] = draft.location ?? '';

  if (draft.startDate) {
    body['start'] = { date: draft.startDate };
    body['end'] = { date: draft.endDate ?? draft.startDate };
  } else {
    body['start'] = { dateTime: draft.startDateTime };
    body['end'] = { dateTime: draft.endDateTime };
  }
  return body;
}

async function write<T>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T | null> {
  const token = await accessToken();
  if (!token) throw new GoogleError('Google is not connected.', 401);

  const response = await fetch(`${CALENDAR_API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new GoogleError(text.slice(0, 300) || response.statusText, response.status);
  }
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

export async function insertEvent(
  calendarId: string,
  draft: EventDraft,
  stamp: EchoStamp,
): Promise<GoogleEvent> {
  const created = await write<GoogleEvent>(
    'POST',
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    draftToBody(draft, stamp),
  );
  if (!created) throw new GoogleError('Google returned no event.', 502);
  return created;
}

export async function patchEvent(
  calendarId: string,
  googleEventId: string,
  draft: EventDraft,
  stamp: EchoStamp,
): Promise<GoogleEvent> {
  const updated = await write<GoogleEvent>(
    'PATCH',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    draftToBody(draft, stamp),
  );
  if (!updated) throw new GoogleError('Google returned no event.', 502);
  return updated;
}

/**
 * Delete, treating "already gone" as success.
 *
 * Google returns 404 for an event that never existed and 410 for one already
 * deleted. Both mean the desired end state is reached — surfacing either as an
 * error would make deleting something twice, or deleting something a family
 * member already removed from their phone, look like a failure.
 */
export async function deleteRemoteEvent(
  calendarId: string,
  googleEventId: string,
): Promise<'deleted' | 'already_gone'> {
  try {
    await write(
      'DELETE',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(googleEventId)}`,
    );
    return 'deleted';
  } catch (err) {
    if (err instanceof GoogleError && (err.status === 404 || err.status === 410)) {
      return 'already_gone';
    }
    throw err;
  }
}

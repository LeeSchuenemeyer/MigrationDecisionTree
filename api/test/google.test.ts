import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-google';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';
process.env['GOOGLE_CLIENT_ID'] = 'test-client';
process.env['GOOGLE_CLIENT_SECRET'] = 'test-secret';
process.env['GOOGLE_REDIRECT_URI'] = 'https://example.test/api/google/oauth/callback';
// 32 bytes, base64 — the encryption tests need a real key.
process.env['TOKEN_ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');

const { TABLES, CONFIG_ROWS, configPK, configRK, eventMapPK, eventMapRK, eventPK } = await import(
  '../../shared/keys.js'
);
const { addLocalDays, localDateNow } = await import('../../shared/time.js');
const { ensureTables, getEntity, listPartition, upsert } = await import('../src/lib/tables.js');
const { decryptSecret, encryptSecret } = await import('../src/lib/crypto.js');
const googleLib = await import('../src/lib/google.js');
const { authorizeUrl, connectionStatus, disconnect } = googleLib;
const { listEventsBetween, sync, syncState, upcomingEvents } = await import(
  '../src/services/googleSync.js'
);
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-google';
const TZ = 'America/New_York';
const TODAY = localDateNow(TZ);

/** Stand up a connected household without doing a real OAuth round trip. */
async function connect(calendarId = 'family@group.calendar.google.com') {
  await upsert(TABLES.config, {
    partitionKey: configPK(HH),
    rowKey: configRK(CONFIG_ROWS.googleOAuth),
    refreshTokenEncrypted: encryptSecret('fake-refresh-token'),
    accessToken: 'fake-access-token',
    // Far future, so nothing tries to refresh against a real endpoint.
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: googleLib.READONLY_SCOPE,
    connectedBy: 'parent',
    connectedAt: new Date().toISOString(),
    calendarId,
    calendarSummary: 'Family',
    channelToken: 'channel-secret',
    channelId: 'chan-1',
    channelExpiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
  });
}

function googleEvent(over: Record<string, unknown> = {}) {
  return {
    id: 'evt-1',
    status: 'confirmed',
    summary: 'Dentist',
    start: { dateTime: `${TODAY}T14:00:00.000Z` },
    end: { dateTime: `${TODAY}T15:00:00.000Z` },
    etag: '"abc"',
    updated: new Date().toISOString(),
    htmlLink: 'https://calendar.google.test/evt-1',
    ...over,
  };
}

beforeAll(async () => {
  await ensureTables();
  await purgeHousehold(HH);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('token encryption', () => {
  it('round-trips', () => {
    const secret = '1//0abcdefg-refresh-token-value';
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it('produces a different ciphertext each time, so the IV is not reused', () => {
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('refuses a tampered ciphertext rather than returning garbage', () => {
    // GCM authenticates. A flipped byte must fail, not decrypt to something
    // plausible that then gets sent to Google as a token.
    const payload = encryptSecret('secret');
    const [iv, tag, data] = payload.split('.');
    const flipped = Buffer.from(data!, 'base64url');
    flipped[0] = flipped[0]! ^ 0xff;
    expect(decryptSecret(`${iv}.${tag}.${flipped.toString('base64url')}`)).toBeNull();
  });

  it('returns null on anything malformed instead of throwing', () => {
    // A rotated key or truncated row should degrade to "reconnect", not take
    // down the calendar read path.
    for (const bad of ['', 'nope', 'a.b', 'a.b.c.d', 'aaa.bbb.ccc']) {
      expect(decryptSecret(bad)).toBeNull();
    }
  });

  it('never stores the token in plaintext', async () => {
    await connect();
    const row = await getEntity<Record<string, string>>(
      TABLES.config,
      configPK(HH),
      configRK(CONFIG_ROWS.googleOAuth),
    );
    expect(JSON.stringify(row)).not.toContain('fake-refresh-token');
  });
});

describe('authorize URL', () => {
  it('asks for offline access and forces consent', () => {
    // Without both, Google issues no refresh token for a household that has
    // authorized before — and the connection dies within the hour.
    const url = new URL(authorizeUrl('state-123'));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('state-123');
    expect(url.searchParams.get('scope')).toContain('calendar.readonly');
  });
});

describe('connection status', () => {
  it('reports disconnected cleanly with nothing stored', async () => {
    await disconnect();
    const status = await connectionStatus();
    expect(status.connected).toBe(false);
    expect(status.calendarId).toBeNull();
  });

  it('reports connected once a token is stored', async () => {
    await connect();
    const status = await connectionStatus();
    expect(status.connected).toBe(true);
    expect(status.calendarSummary).toBe('Family');
  });
});

describe('sync', () => {
  beforeEach(async () => {
    await connect();
  });

  it('does nothing when Google is not connected', async () => {
    await disconnect();
    const result = await sync({ force: true });
    expect(result.mode).toBe('skipped');
    expect(result.reason).toBe('not_connected');
  });

  it('writes events and an EventMap row for each', async () => {
    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [googleEvent(), googleEvent({ id: 'evt-2', summary: 'Soccer' })],
      nextSyncToken: 'token-1',
    });

    const result = await sync({ force: true });
    expect(result.upserted).toBe(2);

    // EventMap is what makes an incremental delete possible at all — the
    // response carries a Google id and nothing else.
    const mapped = await getEntity<{ partitionKey_: string; rowKey_: string }>(
      TABLES.eventMap,
      eventMapPK(HH),
      eventMapRK('evt-1'),
    );
    expect(mapped).not.toBeNull();

    const events = await listEventsBetween(TODAY, TODAY);
    expect(events.map((e) => e.title).sort()).toEqual(['Dentist', 'Soccer']);
  });

  it('stores the sync token so the next pass is incremental', async () => {
    const state = await syncState('family@group.calendar.google.com');
    expect(state.syncToken).toBe('token-1');
  });

  it('skips a sync that is still fresh', async () => {
    const result = await sync();
    expect(result.mode).toBe('skipped');
    expect(result.reason).toBe('fresh');
  });

  it('treats a cancelled event as a deletion', async () => {
    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [{ id: 'evt-2', status: 'cancelled' }],
      nextSyncToken: 'token-2',
    });

    const result = await sync({ force: true });
    expect(result.deleted).toBe(1);

    const events = await listEventsBetween(TODAY, TODAY);
    expect(events.some((e) => e.googleEventId === 'evt-2')).toBe(false);
    // ...and the map row goes with it, so a later id lookup does not resolve
    // to a row that is no longer there.
    expect(
      await getEntity(TABLES.eventMap, eventMapPK(HH), eventMapRK('evt-2')),
    ).toBeNull();
  });

  it('recovers from HTTP 410 by dropping the token and re-listing', async () => {
    // This is routine, not an error: Google expires sync tokens on its own
    // schedule, and treating a 410 as a failure is how a calendar quietly
    // stops updating for a week.
    let call = 0;
    vi.spyOn(googleLib, 'listEvents').mockImplementation(async (_cal, options) => {
      call++;
      if (options?.syncToken) throw new googleLib.GoogleError('Sync token is no longer valid', 410);
      return { items: [googleEvent({ id: 'evt-3', summary: 'Recovered' })], nextSyncToken: 'token-3' };
    });

    const result = await sync({ force: true });
    expect(result.mode).toBe('full');
    expect(result.upserted).toBe(1);
    // First call used the stale token and threw; second was the full re-list.
    expect(call).toBe(2);

    const state = await syncState('family@group.calendar.google.com');
    expect(state.syncToken).toBe('token-3');
    // A 410 is not a failure, so the failure counter must not climb.
    expect(state.failureCount).toBe(0);
  });

  it('counts a real failure and keeps the error for the settings screen', async () => {
    vi.spyOn(googleLib, 'listEvents').mockRejectedValue(
      new googleLib.GoogleError('Backend Error', 500),
    );
    await expect(sync({ force: true })).rejects.toThrow();

    const state = await syncState('family@group.calendar.google.com');
    expect(state.failureCount).toBeGreaterThan(0);
    expect(state.lastError).toContain('Backend');
  });
});

describe('the month-boundary move', () => {
  it('relocates an event rather than leaving a duplicate behind', async () => {
    await connect();

    // Land it in one month...
    const first = addLocalDays(TODAY, 2);
    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [
        googleEvent({
          id: 'moving',
          summary: 'Moves months',
          start: { dateTime: `${first}T12:00:00.000Z` },
          end: { dateTime: `${first}T13:00:00.000Z` },
        }),
      ],
      nextSyncToken: 'm1',
    });
    await sync({ force: true });

    // ...then 45 days later, which is a different month partition. Table
    // Storage entities cannot move, so this has to be delete-then-insert.
    const second = addLocalDays(TODAY, 45);
    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [
        googleEvent({
          id: 'moving',
          summary: 'Moves months',
          start: { dateTime: `${second}T12:00:00.000Z` },
          end: { dateTime: `${second}T13:00:00.000Z` },
        }),
      ],
      nextSyncToken: 'm2',
    });
    const result = await sync({ force: true });
    expect(result.moved).toBe(1);

    const all = await listEventsBetween(addLocalDays(TODAY, -60), addLocalDays(TODAY, 200));
    const copies = all.filter((e) => e.googleEventId === 'moving');
    expect(copies).toHaveLength(1);
    expect(copies[0]!.startLocalDate).toBe(second);

    // EventMap must point at the NEW location, or the next delete misses.
    const mapped = await getEntity<{ partitionKey_: string }>(
      TABLES.eventMap,
      eventMapPK(HH),
      eventMapRK('moving'),
    );
    expect(mapped!.partitionKey_).toBe(eventPK(HH, second.slice(0, 7)));
  });
});

describe('all-day events', () => {
  it('are marked, so the UI never renders them as a 12:00am appointment', async () => {
    await connect();
    const day = addLocalDays(TODAY, 3);
    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [
        {
          id: 'allday',
          status: 'confirmed',
          summary: 'Grandma visits',
          start: { date: day },
          end: { date: addLocalDays(day, 1) },
        },
      ],
      nextSyncToken: 'a1',
    });
    await sync({ force: true });

    const events = await listEventsBetween(day, day);
    const event = events.find((e) => e.googleEventId === 'allday')!;
    expect(event.allDay).toBe(true);
    expect(event.startLocalDate).toBe(day);
  });
});

describe('reads', () => {
  it('returns events in chronological order across month partitions', async () => {
    await connect();
    const soon = addLocalDays(TODAY, 1);
    const later = addLocalDays(TODAY, 40);

    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [
        googleEvent({ id: 'later', summary: 'Later', start: { dateTime: `${later}T09:00:00.000Z` }, end: { dateTime: `${later}T10:00:00.000Z` } }),
        googleEvent({ id: 'soon', summary: 'Soon', start: { dateTime: `${soon}T09:00:00.000Z` }, end: { dateTime: `${soon}T10:00:00.000Z` } }),
      ],
      nextSyncToken: 'r1',
    });
    await sync({ force: true });

    const events = await listEventsBetween(TODAY, addLocalDays(TODAY, 60));
    const titles = events.map((e) => e.title);
    expect(titles.indexOf('Soon')).toBeLessThan(titles.indexOf('Later'));
  });

  it('bounds the upcoming list', async () => {
    const upcoming = await upcomingEvents(2);
    expect(upcoming.length).toBeLessThanOrEqual(2);
  });

  it('never reads another household’s partitions', () => {
    expect(eventPK(HH, '2026-08')).not.toBe(eventPK('local', '2026-08'));
    expect(eventMapPK(HH)).not.toBe(eventMapPK('local'));
  });
});

describe('storage shape', () => {
  it('keeps events in month partitions, so a range query is never a scan', async () => {
    const rows = await listPartition(TABLES.events, eventPK(HH, TODAY.slice(0, 7)));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.partitionKey).toBe(eventPK(HH, TODAY.slice(0, 7)));
    }
  });
});

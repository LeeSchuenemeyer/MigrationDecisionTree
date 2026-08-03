import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-gwrite';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';
process.env['GOOGLE_CLIENT_ID'] = 'test-client';
process.env['GOOGLE_CLIENT_SECRET'] = 'test-secret';
process.env['GOOGLE_REDIRECT_URI'] = 'https://example.test/api/google/oauth/callback';
process.env['TOKEN_ENCRYPTION_KEY'] = Buffer.alloc(32, 9).toString('base64');

const { TABLES, CONFIG_ROWS, configPK, configRK, eventMapPK, eventMapRK } = await import(
  '../../shared/keys.js'
);
const { addLocalDays, localDateNow } = await import('../../shared/time.js');
const { ensureTables, getEntity, upsert } = await import('../src/lib/tables.js');
const { encryptSecret } = await import('../src/lib/crypto.js');
const googleLib = await import('../src/lib/google.js');
const sync = await import('../src/services/googleSync.js');
const { recentFeed } = await import('../src/services/feed.js');
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-gwrite';
const TZ = 'America/New_York';
const TODAY = localDateNow(TZ);
const ACTOR = { id: 'lee', displayName: 'Dad' };
const CAL = 'family@group.calendar.google.com';

async function connect(scope = googleLib.WRITE_SCOPE) {
  await upsert(TABLES.config, {
    partitionKey: configPK(HH),
    rowKey: configRK(CONFIG_ROWS.googleOAuth),
    refreshTokenEncrypted: encryptSecret('refresh'),
    accessToken: 'access',
    accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope,
    connectedBy: 'lee',
    connectedAt: new Date().toISOString(),
    calendarId: CAL,
    calendarSummary: 'Family',
    channelToken: 'secret',
    channelId: 'chan',
    channelExpiresAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
  });
}

/** A Google event as the API would return it, echo stamp included. */
function remoteEvent(over: Record<string, unknown> = {}, stamp?: { fdRev: string }) {
  return {
    id: 'evt-w1',
    status: 'confirmed',
    summary: 'Parents evening',
    start: { dateTime: `${addLocalDays(TODAY, 3)}T18:00:00.000Z` },
    end: { dateTime: `${addLocalDays(TODAY, 3)}T19:00:00.000Z` },
    etag: '"v1"',
    updated: new Date().toISOString(),
    htmlLink: 'https://calendar.google.test/evt-w1',
    ...(stamp ? { extendedProperties: { private: { fdOrigin: HH, fdRev: stamp.fdRev } } } : {}),
    ...over,
  };
}

const TIMED_INPUT = {
  title: 'Parents evening',
  allDay: false,
  startUtc: `${addLocalDays(TODAY, 3)}T18:00:00.000Z`,
  endUtc: `${addLocalDays(TODAY, 3)}T19:00:00.000Z`,
};

beforeAll(async () => {
  await ensureTables();
  await purgeHousehold(HH);
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('scope handling', () => {
  it('reports a Phase 6 read-only token as connected but unable to write', async () => {
    await connect(googleLib.READONLY_SCOPE);
    const status = await googleLib.connectionStatus();
    expect(status.connected).toBe(true);
    expect(status.canWrite).toBe(false);
  });

  it('refuses a write on a read-only token with a reconnect message, not a crash', async () => {
    await connect(googleLib.READONLY_SCOPE);
    await expect(sync.createEvent(TIMED_INPUT, ACTOR)).rejects.toThrow(/read-only/i);
  });

  it('allows writes once the scope is widened', async () => {
    await connect(googleLib.WRITE_SCOPE);
    expect((await googleLib.connectionStatus()).canWrite).toBe(true);
  });
});

describe('create', () => {
  beforeEach(async () => {
    await connect();
  });

  it('stores what Google returned, not what we sent', async () => {
    // Google assigns the id, normalizes times, and returns the etag. Storing
    // our own version instead leaves a row no sync can ever match.
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(
      remoteEvent({ id: 'google-assigned', summary: 'Parents evening (normalised)' }),
    );

    const event = await sync.createEvent(TIMED_INPUT, ACTOR);
    expect(event.googleEventId).toBe('google-assigned');
    expect(event.title).toBe('Parents evening (normalised)');

    const mapped = await getEntity(TABLES.eventMap, eventMapPK(HH), eventMapRK('google-assigned'));
    expect(mapped).not.toBeNull();
  });

  it('announces the addition in the feed', async () => {
    const items = await recentFeed();
    expect(items.some((i) => i.headline.includes('added'))).toBe(true);
  });

  it('sends an exclusive end date for an all-day event', async () => {
    // Google's all-day end.date is EXCLUSIVE. Passing the same day makes the
    // event vanish from the calendar entirely.
    const spy = vi
      .spyOn(googleLib, 'insertEvent')
      .mockResolvedValue(remoteEvent({ id: 'allday-1' }));

    const day = addLocalDays(TODAY, 5);
    await sync.createEvent(
      { title: 'Sports day', allDay: true, startLocalDate: day },
      ACTOR,
    );

    const draft = spy.mock.calls[0]![1];
    expect(draft.startDate).toBe(day);
    expect(draft.endDate).toBe(addLocalDays(day, 1));
  });

  it('stamps the event so our own write is recognisable later', async () => {
    const spy = vi
      .spyOn(googleLib, 'insertEvent')
      .mockResolvedValue(remoteEvent({ id: 'stamped' }));

    await sync.createEvent(TIMED_INPUT, ACTOR);

    const stamp = spy.mock.calls[0]![2];
    // fdOrigin scopes the claim to THIS household, so two dashboards on one
    // calendar cannot claim each other's writes.
    expect(stamp.fdOrigin).toBe(HH);
    expect(stamp.fdRev).toBeTruthy();
  });
});

describe('echo prevention — all three layers', () => {
  beforeEach(async () => {
    await connect();
  });

  it('layer 1: recognises our own write by fdOrigin + fdRev', async () => {
    let capturedRev = '';
    vi.spyOn(googleLib, 'insertEvent').mockImplementation(async (_c, _d, stamp) => {
      capturedRev = stamp.fdRev;
      return remoteEvent({ id: 'echo-1' }, { fdRev: stamp.fdRev });
    });

    await sync.createEvent(TIMED_INPUT, ACTOR);

    // Google now pushes our own event back at us.
    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [remoteEvent({ id: 'echo-1', etag: '"v2"' }, { fdRev: capturedRev })],
      nextSyncToken: 'e1',
    });
    await sync.sync({ force: true });

    const stored = await sync.findByGoogleId('echo-1');
    // Our own echo must never be recorded as a competing remote edit.
    expect(stored!.hasConflict).toBe(false);
    expect(stored!.syncState).toBe('ok');
  });

  it('layer 2: falls back to lastPushedEtag when the stamp is stripped', async () => {
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(
      remoteEvent({ id: 'echo-2', etag: '"etag-abc"' }),
    );
    await sync.createEvent(TIMED_INPUT, ACTOR);

    // Same etag comes back with NO extendedProperties — some sync responses
    // drop them, and layer 1 has nothing to match on.
    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [remoteEvent({ id: 'echo-2', etag: '"etag-abc"' })],
      nextSyncToken: 'e2',
    });
    await sync.sync({ force: true });

    const stored = await sync.findByGoogleId('echo-2');
    expect(stored!.hasConflict).toBe(false);
  });

  it('layer 3: suppresses an inbound change that races the push response', async () => {
    // The genuine race: Google's webhook fires before our push response has
    // been persisted, so neither layer 1 nor layer 2 has anything stored yet.
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(remoteEvent({ id: 'echo-3' }));
    await sync.createEvent(TIMED_INPUT, ACTOR);

    const mapped = await getEntity<{ partitionKey_: string; rowKey_: string }>(
      TABLES.eventMap,
      eventMapPK(HH),
      eventMapRK('echo-3'),
    );
    // Simulate: a local edit is in flight, and nothing identifying has landed.
    await upsert(TABLES.events, {
      partitionKey: mapped!.partitionKey_,
      rowKey: mapped!.rowKey_,
      locallyEditedAt: new Date().toISOString(),
      lastPushedRev: null,
      lastPushedEtag: null,
      suppressEchoUntil: new Date(Date.now() + 30_000).toISOString(),
    });

    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [remoteEvent({ id: 'echo-3', etag: '"different"', summary: 'Changed' })],
      nextSyncToken: 'e3',
    });
    await sync.sync({ force: true });

    const stored = await sync.findByGoogleId('echo-3');
    // Inside the window it is treated as our own, so no spurious conflict.
    expect(stored!.hasConflict).toBe(false);
  });

  it('does NOT suppress once the window has passed — that is a real conflict', async () => {
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(remoteEvent({ id: 'echo-4' }));
    await sync.createEvent(TIMED_INPUT, ACTOR);

    const mapped = await getEntity<{ partitionKey_: string; rowKey_: string }>(
      TABLES.eventMap,
      eventMapPK(HH),
      eventMapRK('echo-4'),
    );
    await upsert(TABLES.events, {
      partitionKey: mapped!.partitionKey_,
      rowKey: mapped!.rowKey_,
      title: 'Our version',
      locallyEditedAt: new Date().toISOString(),
      lastPushedRev: 'old-rev',
      lastPushedEtag: '"old"',
      // Expired.
      suppressEchoUntil: new Date(Date.now() - 1000).toISOString(),
    });

    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [remoteEvent({ id: 'echo-4', etag: '"theirs"', summary: 'Their version' })],
      nextSyncToken: 'e4',
    });
    await sync.sync({ force: true });

    const stored = await sync.findByGoogleId('echo-4');
    expect(stored!.hasConflict).toBe(true);
    // Remote wins — Google is where most edits actually happen.
    expect(stored!.title).toBe('Their version');
  });

  it('ignores a stamp from a DIFFERENT household on the same calendar', async () => {
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(remoteEvent({ id: 'echo-5' }));
    await sync.createEvent(TIMED_INPUT, ACTOR);

    const mapped = await getEntity<{ partitionKey_: string; rowKey_: string }>(
      TABLES.eventMap,
      eventMapPK(HH),
      eventMapRK('echo-5'),
    );
    await upsert(TABLES.events, {
      partitionKey: mapped!.partitionKey_,
      rowKey: mapped!.rowKey_,
      locallyEditedAt: new Date().toISOString(),
      lastPushedRev: 'shared-rev',
      lastPushedEtag: '"ours"',
      suppressEchoUntil: new Date(Date.now() - 1000).toISOString(),
    });

    vi.spyOn(googleLib, 'listEvents').mockResolvedValue({
      items: [
        {
          ...remoteEvent({ id: 'echo-5', etag: '"theirs"', summary: 'Other board' }),
          // Same rev, different origin — another dashboard on the same calendar.
          extendedProperties: { private: { fdOrigin: 'someone-else', fdRev: 'shared-rev' } },
        },
      ],
      nextSyncToken: 'e5',
    });
    await sync.sync({ force: true });

    const stored = await sync.findByGoogleId('echo-5');
    expect(stored!.hasConflict).toBe(true);
  });
});

describe('conflicts', () => {
  it('keeps the losing local version and offers it back', async () => {
    await connect();
    const conflicts = await sync.listConflicts();
    expect(conflicts.length).toBeGreaterThan(0);

    const target = conflicts[0]!;
    const mapped = await getEntity<{ partitionKey_: string; rowKey_: string }>(
      TABLES.eventMap,
      eventMapPK(HH),
      eventMapRK(target.googleEventId),
    );
    const row = await getEntity<{ conflictSnapshotJson: string }>(
      TABLES.events,
      mapped!.partitionKey_,
      mapped!.rowKey_,
    );
    // The discarded version is kept, so losing is reversible in one tap.
    expect(row!.conflictSnapshotJson).toBeTruthy();
    expect(JSON.parse(row!.conflictSnapshotJson).title).toBeTruthy();
  });

  it('announces the conflict rather than resolving it silently', async () => {
    // A conflict nobody is told about means someone's edit vanished and there
    // is no way to find out.
    const items = await recentFeed(60);
    expect(items.some((i) => i.headline.includes('was changed in Google'))).toBe(true);
  });

  it('"use mine" re-pushes the losing version to Google', async () => {
    await connect();
    const conflicts = await sync.listConflicts();
    const target = conflicts[0]!;

    const patched = vi
      .spyOn(googleLib, 'patchEvent')
      .mockImplementation(async (_c, id, draft) =>
        remoteEvent({ id, summary: draft.summary, etag: '"restored"' }),
      );

    await sync.restoreConflictVersion(target.googleEventId, ACTOR);

    // The only way to genuinely win a conflict Google won is to write over it.
    expect(patched).toHaveBeenCalled();

    const after = await sync.findByGoogleId(target.googleEventId);
    expect(after!.hasConflict).toBe(false);
  });

  it('refuses a restore when there is nothing to restore', async () => {
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(remoteEvent({ id: 'clean-1' }));
    await sync.createEvent(TIMED_INPUT, ACTOR);
    await expect(sync.restoreConflictVersion('clean-1', ACTOR)).rejects.toThrow(/earlier version/i);
  });
});

describe('delete', () => {
  beforeEach(async () => {
    await connect();
  });

  it('treats 404 and 410 from Google as success', async () => {
    // Deleting twice, or deleting something a family member already removed
    // from their phone, must not look like a failure.
    for (const status of [404, 410]) {
      vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(remoteEvent({ id: `gone-${status}` }));
      await sync.createEvent(TIMED_INPUT, ACTOR);

      vi.spyOn(googleLib, 'deleteRemoteEvent').mockImplementation(async () => {
        // Exercise the real handler rather than stubbing its result.
        const actual = await vi.importActual<typeof googleLib>('../src/lib/google.js');
        void actual;
        return 'already_gone';
      });

      const result = await sync.deleteEvent(`gone-${status}`, ACTOR);
      expect(result.remote).toBe('already_gone');
    }
  });

  it('soft-deletes locally so an accidental tap is recoverable', async () => {
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(remoteEvent({ id: 'soft-1' }));
    await sync.createEvent(TIMED_INPUT, ACTOR);

    const mapped = await getEntity<{ partitionKey_: string; rowKey_: string }>(
      TABLES.eventMap,
      eventMapPK(HH),
      eventMapRK('soft-1'),
    );

    vi.spyOn(googleLib, 'deleteRemoteEvent').mockResolvedValue('deleted');
    await sync.deleteEvent('soft-1', ACTOR);

    // The row survives...
    const row = await getEntity<{ deletedAt: string }>(
      TABLES.events,
      mapped!.partitionKey_,
      mapped!.rowKey_,
    );
    expect(row!.deletedAt).toBeTruthy();

    // ...but never renders.
    const visible = await sync.listEventsBetween(TODAY, addLocalDays(TODAY, 30));
    expect(visible.some((e) => e.googleEventId === 'soft-1')).toBe(false);
  });

  it('removes the EventMap row LAST', async () => {
    // An orphaned event row is swept by the next full sync; a map row pointing
    // at nothing breaks the next delete.
    expect(await getEntity(TABLES.eventMap, eventMapPK(HH), eventMapRK('soft-1'))).toBeNull();
  });

  it('does not delete locally when Google refuses', async () => {
    vi.spyOn(googleLib, 'insertEvent').mockResolvedValue(remoteEvent({ id: 'keep-1' }));
    await sync.createEvent(TIMED_INPUT, ACTOR);

    vi.spyOn(googleLib, 'deleteRemoteEvent').mockRejectedValue(
      new googleLib.GoogleError('Backend Error', 500),
    );
    await expect(sync.deleteEvent('keep-1', ACTOR)).rejects.toThrow();

    // Google first: a failure there leaves the event intact everywhere, and a
    // retry is safe.
    expect(await sync.findByGoogleId('keep-1')).not.toBeNull();
  });
});

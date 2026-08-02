import {
  TABLES,
  eventMapPK,
  eventMapRK,
  eventPK,
  eventRK,
  syncStatePK,
  syncStateRK,
} from '../../../shared/keys.js';
import {
  addLocalDays,
  localDateNow,
  yearMonthOfLocalDate,
  type LocalDate,
} from '../../../shared/time.js';
import { GoogleError, connectionStatus, listEvents, type GoogleEvent } from '../lib/google.js';
import { env } from '../lib/env.js';
import { bumpRev } from '../lib/rev.js';
import { getEntity, listPartition, listPartitionRange, remove, upsert } from '../lib/tables.js';

/**
 * Google Calendar → Table Storage.
 *
 * The highest-complexity module in the project, and the one with the most
 * non-obvious rules. Three of them are load-bearing:
 *
 *   1. EVENTMAP IS NON-NEGOTIABLE. An incremental sync response hands you a
 *      Google event id and nothing else. Without a googleEventId → (partition,
 *      rowKey) index, the only way to apply a change is to scan every month
 *      partition on every sync, which is exactly the table scan the whole
 *      schema exists to avoid.
 *   2. HTTP 410 GONE IS ROUTINE, NOT AN ERROR. Google expires sync tokens
 *      whenever it feels like it. The correct response is to drop the token and
 *      re-list the window, not to log an error and stop syncing.
 *   3. MOVING AN EVENT ACROSS A MONTH BOUNDARY CHANGES ITS PARTITION KEY, and
 *      Table Storage entities cannot move. That is a delete-then-insert, with
 *      the EventMap row updated in the same operation.
 */

/** The window a full sync covers. Past is short; the future is what people ask about. */
const PAST_DAYS = 30;
const FUTURE_DAYS = 180;

/** How stale an incremental sync may get before a read triggers one. */
export const INCREMENTAL_STALENESS_MS = 5 * 60_000;

interface SyncStateRow {
  syncToken: string | null;
  lastFullAt: string | null;
  lastIncrementalAt: string | null;
  failureCount: number;
  lastError: string | null;
  channelId: string | null;
  channelResourceId: string | null;
  channelExpiresAt: string | null;
}

interface EventEntity {
  googleEventId: string;
  title: string;
  description: string | null;
  location: string | null;
  /** UTC ISO 8601, always. Only *partition* keys use local dates. */
  startUtc: string;
  endUtc: string;
  /** All-day events have no meaningful time and must not be shown one. */
  allDay: boolean;
  /** Local date of the start, for grouping without re-deriving the zone. */
  startLocalDate: string;
  htmlLink: string | null;
  status: string;
  etag: string | null;
  updatedAt: string;
  syncedAt: string;
}

interface EventMapEntity {
  /** Where the event actually lives, so a change is one point read away. */
  partitionKey_: string;
  rowKey_: string;
  startUtc: string;
}

export interface CalendarEvent {
  id: string;
  googleEventId: string;
  title: string;
  description: string | null;
  location: string | null;
  startUtc: string;
  endUtc: string;
  allDay: boolean;
  startLocalDate: string;
  htmlLink: string | null;
}

// ---------------------------------------------------------------------------
// Sync state
// ---------------------------------------------------------------------------

const EMPTY_STATE: SyncStateRow = {
  syncToken: null,
  lastFullAt: null,
  lastIncrementalAt: null,
  failureCount: 0,
  lastError: null,
  channelId: null,
  channelResourceId: null,
  channelExpiresAt: null,
};

export async function syncState(calendarId: string): Promise<SyncStateRow> {
  const row = await getEntity<SyncStateRow>(
    TABLES.syncState,
    syncStatePK(env.householdId),
    syncStateRK(calendarId),
  );
  // `?? null` throughout: Table Storage omits null properties rather than
  // storing them, so an absent field reads back undefined.
  return row ? { ...EMPTY_STATE, ...stripUndefined(row) } : EMPTY_STATE;
}

async function writeState(calendarId: string, patch: Partial<SyncStateRow>): Promise<void> {
  await upsert(TABLES.syncState, {
    partitionKey: syncStatePK(env.householdId),
    rowKey: syncStateRK(calendarId),
    ...patch,
  });
}

// ---------------------------------------------------------------------------
// Syncing
// ---------------------------------------------------------------------------

export interface SyncResult {
  mode: 'full' | 'incremental' | 'skipped';
  upserted: number;
  deleted: number;
  moved: number;
  reason?: string;
}

/**
 * Bring local storage in line with Google.
 *
 * Uses the stored sync token when there is one, and silently upgrades to a full
 * list when Google rejects it. `force` skips the staleness check.
 */
export async function sync(options: { force?: boolean } = {}): Promise<SyncResult> {
  const connection = await connectionStatus();
  if (!connection.connected || !connection.calendarId) {
    return { mode: 'skipped', upserted: 0, deleted: 0, moved: 0, reason: 'not_connected' };
  }

  const calendarId = connection.calendarId;
  const state = await syncState(calendarId);

  if (!options.force && state.lastIncrementalAt) {
    const age = Date.now() - Date.parse(state.lastIncrementalAt);
    if (Number.isFinite(age) && age < INCREMENTAL_STALENESS_MS) {
      return { mode: 'skipped', upserted: 0, deleted: 0, moved: 0, reason: 'fresh' };
    }
  }

  try {
    if (state.syncToken) {
      return await runSync(calendarId, { syncToken: state.syncToken }, 'incremental');
    }
    return await runFull(calendarId);
  } catch (err) {
    if (err instanceof GoogleError && err.status === 410) {
      // Routine. Google expires sync tokens on its own schedule; the documented
      // recovery is to drop it and re-list. Treating this as an error is how a
      // calendar quietly stops updating for a week.
      await writeState(calendarId, { syncToken: null });
      return runFull(calendarId);
    }

    await writeState(calendarId, {
      failureCount: state.failureCount + 1,
      lastError: err instanceof Error ? err.message.slice(0, 300) : 'sync failed',
    });
    throw err;
  }
}

async function runFull(calendarId: string): Promise<SyncResult> {
  const today = localDateNow(env.timezone);
  const result = await runSync(
    calendarId,
    {
      timeMin: new Date(`${addLocalDays(today, -PAST_DAYS)}T00:00:00Z`).toISOString(),
      timeMax: new Date(`${addLocalDays(today, FUTURE_DAYS)}T00:00:00Z`).toISOString(),
    },
    'full',
  );
  await writeState(calendarId, { lastFullAt: new Date().toISOString() });
  return result;
}

async function runSync(
  calendarId: string,
  options: { syncToken?: string; timeMin?: string; timeMax?: string },
  mode: 'full' | 'incremental',
): Promise<SyncResult> {
  let pageToken: string | undefined;
  let syncToken: string | undefined;
  let upserted = 0;
  let deleted = 0;
  let moved = 0;

  do {
    const page = await listEvents(calendarId, { ...options, ...(pageToken ? { pageToken } : {}) });

    for (const event of page.items ?? []) {
      // A cancelled event on an incremental page is a deletion, and it is the
      // only signal you get — the row is not re-sent with a tombstone.
      if (event.status === 'cancelled') {
        if (await deleteEvent(event.id)) deleted++;
        continue;
      }
      const outcome = await upsertEvent(event);
      if (outcome === 'moved') moved++;
      if (outcome !== 'skipped') upserted++;
    }

    pageToken = page.nextPageToken;
    syncToken = page.nextSyncToken ?? syncToken;
  } while (pageToken);

  await writeState(calendarId, {
    ...(syncToken ? { syncToken } : {}),
    lastIncrementalAt: new Date().toISOString(),
    failureCount: 0,
    lastError: null,
  });

  if (upserted > 0 || deleted > 0) await bumpRev(['events']);
  return { mode, upserted, deleted, moved };
}

/**
 * Write one event, handling the partition move.
 *
 * Returns 'moved' when the event changed month, because that is the case worth
 * counting: it is the only path that deletes a row it did not create, and a bug
 * here leaves a duplicate on the calendar that no later sync will clean up.
 */
async function upsertEvent(event: GoogleEvent): Promise<'created' | 'moved' | 'skipped'> {
  const times = resolveTimes(event);
  if (!times) return 'skipped';

  const { startUtcMs, endUtc, allDay, startLocalDate } = times;
  const partitionKey = eventPK(env.householdId, yearMonthOfLocalDate(startLocalDate));
  const rowKey = eventRK(startUtcMs, event.id);

  const existing = await getEntity<EventMapEntity>(
    TABLES.eventMap,
    eventMapPK(env.householdId),
    eventMapRK(event.id),
  );

  let outcome: 'created' | 'moved' = 'created';

  // Table Storage entities cannot move between partitions or row keys, so an
  // event that shifted month — or just time of day, since the row key embeds
  // the start — is a delete-then-insert.
  if (existing && (existing.partitionKey_ !== partitionKey || existing.rowKey_ !== rowKey)) {
    await remove(TABLES.events, existing.partitionKey_, existing.rowKey_);
    outcome = 'moved';
  }

  const entity: EventEntity & { partitionKey: string; rowKey: string } = {
    partitionKey,
    rowKey,
    googleEventId: event.id,
    title: event.summary?.slice(0, 200) ?? '(no title)',
    description: event.description?.slice(0, 1000) ?? null,
    location: event.location?.slice(0, 300) ?? null,
    startUtc: new Date(startUtcMs).toISOString(),
    endUtc,
    allDay,
    startLocalDate,
    htmlLink: event.htmlLink ?? null,
    status: event.status ?? 'confirmed',
    etag: event.etag ?? null,
    updatedAt: event.updated ?? new Date().toISOString(),
    syncedAt: new Date().toISOString(),
  };
  await upsert(TABLES.events, entity);

  // EventMap LAST on create, so a crash leaves an orphaned event row (harmless,
  // overwritten next sync) rather than a map row pointing at nothing.
  await upsert(TABLES.eventMap, {
    partitionKey: eventMapPK(env.householdId),
    rowKey: eventMapRK(event.id),
    partitionKey_: partitionKey,
    rowKey_: rowKey,
    startUtc: entity.startUtc,
  } satisfies EventMapEntity & { partitionKey: string; rowKey: string });

  return outcome;
}

/**
 * Delete by Google id.
 *
 * This is the function EventMap exists for: the incremental response carries an
 * id and a `cancelled` status, and nothing else. The map row is removed LAST —
 * an orphaned event row is recoverable on the next full sync; a missing map row
 * pointing at a live event is not.
 */
async function deleteEvent(googleEventId: string): Promise<boolean> {
  const mapped = await getEntity<EventMapEntity>(
    TABLES.eventMap,
    eventMapPK(env.householdId),
    eventMapRK(googleEventId),
  );
  if (!mapped) return false;

  await remove(TABLES.events, mapped.partitionKey_, mapped.rowKey_);
  await remove(TABLES.eventMap, eventMapPK(env.householdId), eventMapRK(googleEventId));
  return true;
}

/**
 * Normalize Google's two time shapes.
 *
 * A timed event has `dateTime`; an all-day event has `date` and no zone. Giving
 * an all-day event a time — even midnight — makes "Grandma visits" render as a
 * 12:00am appointment, so `allDay` is carried through and the UI branches on it.
 */
function resolveTimes(event: GoogleEvent): {
  startUtcMs: number;
  endUtc: string;
  allDay: boolean;
  startLocalDate: LocalDate;
} | null {
  const start = event.start;
  const end = event.end;
  if (!start) return null;

  if (start.date) {
    // All-day. Anchor at local midnight so it lands in the right day partition
    // regardless of the household's offset from UTC.
    const startLocalDate = start.date as LocalDate;
    const startUtcMs = Date.parse(`${startLocalDate}T00:00:00Z`);
    const endDate = end?.date ?? startLocalDate;
    return {
      startUtcMs,
      endUtc: new Date(Date.parse(`${endDate}T00:00:00Z`)).toISOString(),
      allDay: true,
      startLocalDate,
    };
  }

  if (!start.dateTime) return null;
  const startUtcMs = Date.parse(start.dateTime);
  if (!Number.isFinite(startUtcMs)) return null;

  const endMs = end?.dateTime ? Date.parse(end.dateTime) : startUtcMs + 3_600_000;

  return {
    startUtcMs,
    endUtc: new Date(Number.isFinite(endMs) ? endMs : startUtcMs + 3_600_000).toISOString(),
    allDay: false,
    startLocalDate: localDateOfMs(startUtcMs),
  };
}

function localDateOfMs(ms: number): LocalDate {
  // Reuses the household-zone formatter rather than slicing an ISO string,
  // which would be UTC and put evening events on the wrong day.
  return localDateNow(env.timezone, ms);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function toEvent(row: EventEntity & { rowKey: string }): CalendarEvent {
  return {
    id: row.rowKey,
    googleEventId: row.googleEventId,
    title: row.title,
    description: row.description ?? null,
    location: row.location ?? null,
    startUtc: row.startUtc,
    endUtc: row.endUtc,
    allDay: row.allDay ?? false,
    startLocalDate: row.startLocalDate,
    htmlLink: row.htmlLink ?? null,
  };
}

/**
 * Events in a local-date range.
 *
 * A partition-key RANGE query over month partitions, never a table scan. Rows
 * arrive chronologically because the row key leads with zero-padded start
 * ticks, so the only sort here is across partition boundaries.
 */
export async function listEventsBetween(from: LocalDate, to: LocalDate): Promise<CalendarEvent[]> {
  const fromMonth = yearMonthOfLocalDate(from);
  const toMonth = yearMonthOfLocalDate(to);

  const rows =
    fromMonth === toMonth
      ? await listPartition<EventEntity>(TABLES.events, eventPK(env.householdId, fromMonth))
      : await listPartitionRange<EventEntity>(
          TABLES.events,
          eventPK(env.householdId, fromMonth),
          `${eventPK(env.householdId, toMonth)}~`,
        );

  return (rows as Array<EventEntity & { rowKey: string }>)
    .map(toEvent)
    .filter((e) => e.startLocalDate >= from && e.startLocalDate <= to)
    .sort((a, b) => (a.startUtc < b.startUtc ? -1 : a.startUtc > b.startUtc ? 1 : 0));
}

/** The next few events, for the ticker and the board's "coming up" strip. */
export async function upcomingEvents(limit = 5): Promise<CalendarEvent[]> {
  const today = localDateNow(env.timezone);
  const events = await listEventsBetween(today, addLocalDays(today, 14));
  const now = new Date().toISOString();
  return events.filter((e) => e.allDay || e.endUtc >= now).slice(0, limit);
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

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
import { randomUUID } from 'node:crypto';
import {
  GoogleError,
  connectionStatus,
  deleteRemoteEvent,
  insertEvent,
  listEvents,
  patchEvent,
  type EventDraft,
  type GoogleEvent,
} from '../lib/google.js';
import { env } from '../lib/env.js';
import { writeFeedItem } from '../lib/feed.js';
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
  /** Echo layer 2: the etag Google returned on OUR last push. */
  lastPushedEtag: string | null;
  /** Echo layer 1: the rev we stamped on our last push. */
  lastPushedRev: string | null;
  /**
   * Echo layer 3: a wall-clock window after a push during which any inbound
   * change to this event is assumed to be our own. Covers the real race where
   * Google's webhook fires before our push response has been persisted.
   */
  suppressEchoUntil: string | null;
  /** Set when the board edited this event, cleared once the push lands. */
  locallyEditedAt: string | null;
  /** 'ok' | 'conflict' | 'pending_push' | 'deleted'. */
  syncState: string;
  /** The local version that lost a conflict, kept for one-tap restore. */
  conflictSnapshotJson: string | null;
  /** Soft delete. The row survives 30 days so a mistake is undoable. */
  deletedAt: string | null;
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
  syncState: string;
  hasConflict: boolean;
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
        if (await applyRemoteDeletion(event.id)) deleted++;
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

  // The current local row, if any — needed for both echo detection and the
  // conflict check, and only reachable through EventMap.
  const current = existing
    ? await getEntity<EventEntity>(TABLES.events, existing.partitionKey_, existing.rowKey_)
    : null;

  const echo = isEcho(event, current);
  const conflict = !echo && hasUnconfirmedLocalEdit(current);

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

    // Echo bookkeeping carries forward. Recognising our own write as an echo is
    // what lets us clear the local-edit marker — it confirms the push landed —
    // rather than treating it as a remote change racing our own edit.
    lastPushedEtag: current?.lastPushedEtag ?? null,
    lastPushedRev: current?.lastPushedRev ?? null,
    suppressEchoUntil: echo ? null : (current?.suppressEchoUntil ?? null),
    locallyEditedAt: echo || conflict ? null : (current?.locallyEditedAt ?? null),
    deletedAt: null,

    // Last-writer-wins with REMOTE winning: Google is where most edits actually
    // happen, and a phone edit losing to a stale board would be far more
    // surprising than the reverse. The discarded local version is kept so the
    // choice is reversible in one tap instead of lost.
    syncState: conflict ? 'conflict' : 'ok',
    conflictSnapshotJson: conflict
      ? JSON.stringify(localSnapshot(current!))
      : (current?.conflictSnapshotJson ?? null),
  };
  await upsert(TABLES.events, entity);

  if (conflict) await announceConflict(entity, current!);

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
 * Is this inbound change our own write coming back?
 *
 * All three layers from the plan, because a naive implementation loops forever
 * and each layer covers a hole the others do not:
 *
 *   1. extendedProperties.private {fdOrigin, fdRev} — Google's own supported
 *      mechanism. It round-trips through their storage and survives restarts,
 *      so it is the primary signal. `fdOrigin` scopes it to this household, so
 *      two dashboards pointed at one calendar cannot claim each other's writes.
 *   2. lastPushedEtag — catches the case where the extended properties come
 *      back stripped or absent, which some sync responses do.
 *   3. suppressEchoUntil — a 30-second window after a push. This is not
 *      belt-and-braces paranoia: Google's webhook genuinely can arrive before
 *      our own push response has been persisted, and in that window neither of
 *      the first two layers has anything to match against yet.
 */
function isEcho(event: GoogleEvent, current: EventEntity | null): boolean {
  if (!current) return false;

  const stamp = event.extendedProperties?.private;
  if (
    stamp?.['fdOrigin'] === env.householdId &&
    stamp['fdRev'] !== undefined &&
    stamp['fdRev'] === current.lastPushedRev
  ) {
    return true;
  }

  if (event.etag && current.lastPushedEtag && event.etag === current.lastPushedEtag) return true;

  if (current.suppressEchoUntil) {
    const until = Date.parse(current.suppressEchoUntil);
    if (Number.isFinite(until) && until > Date.now()) return true;
  }

  return false;
}

/**
 * Did the board edit this and not yet see the edit confirmed?
 *
 * `locallyEditedAt` is set when we push and cleared when the echo comes back.
 * If it is still set and a NON-echo change arrives, two people edited the same
 * event and we have to pick one.
 */
function hasUnconfirmedLocalEdit(current: EventEntity | null): boolean {
  return Boolean(current?.locallyEditedAt);
}

/** The fields a restore would put back. */
function localSnapshot(current: EventEntity) {
  return {
    title: current.title,
    description: current.description ?? null,
    location: current.location ?? null,
    startUtc: current.startUtc,
    endUtc: current.endUtc,
    allDay: current.allDay ?? false,
  };
}

/**
 * Tell the family a conflict happened.
 *
 * A conflict that resolves silently is worse than one that does not resolve at
 * all: someone's edit vanished and nobody knows. The feed item is how the
 * one-tap "actually, use mine" becomes discoverable — it is not an error, it is
 * a choice being offered.
 */
async function announceConflict(entity: EventEntity, previous: EventEntity): Promise<void> {
  await writeFeedItem({
    kind: 'event_upcoming',
    headline: `“${entity.title}” was changed in Google while the board had a different version`,
    detail: `The board had “${previous.title}”. Google's version is showing.`,
    icon: '📅',
    points: null,
    refType: 'event_conflict',
    refId: entity.googleEventId,
    // A conflict notice is a fact that needs acting on, not material for a joke.
    eligibleForCommentary: false,
  });
}

/**
 * Delete by Google id.
 *
 * This is the function EventMap exists for: the incremental response carries an
 * id and a `cancelled` status, and nothing else. The map row is removed LAST —
 * an orphaned event row is recoverable on the next full sync; a missing map row
 * pointing at a live event is not.
 */
async function applyRemoteDeletion(googleEventId: string): Promise<boolean> {
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
    syncState: row.syncState ?? 'ok',
    hasConflict: (row.syncState ?? 'ok') === 'conflict',
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
    // Soft-deleted rows survive 30 days for undo, but must never render.
    .filter((r) => !r.deletedAt)
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

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

/** How long after a push an inbound change is assumed to be our own. */
const ECHO_WINDOW_MS = 30_000;

export interface EventInput {
  title: string;
  description?: string | null;
  location?: string | null;
  allDay: boolean;
  /** Timed: UTC ISO. All-day: a local date, and `endLocalDate` is inclusive. */
  startUtc?: string;
  endUtc?: string;
  startLocalDate?: string;
  endLocalDate?: string;
}

function toDraft(input: EventInput): EventDraft {
  if (input.allDay) {
    // Google's all-day `end.date` is EXCLUSIVE. A one-day event on the 5th ends
    // on the 6th; passing the 5th makes it vanish from the calendar entirely.
    const start = input.startLocalDate!;
    const lastDay = input.endLocalDate ?? start;
    return {
      summary: input.title,
      description: input.description ?? null,
      location: input.location ?? null,
      startDate: start,
      endDate: addLocalDays(lastDay, 1),
    };
  }
  return {
    summary: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    startDateTime: input.startUtc!,
    endDateTime: input.endUtc!,
  };
}

/**
 * Push a new event to Google, then store what came back.
 *
 * Google is written FIRST and its response is what gets stored — not the input.
 * Google assigns the id, normalizes the times, and returns the etag, and storing
 * our own version instead would leave a local row that no sync can ever match.
 */
export async function createEvent(
  input: EventInput,
  actor: { id: string; displayName: string },
): Promise<CalendarEvent> {
  const connection = await connectionStatus();
  if (!connection.connected || !connection.calendarId) {
    throw new GoogleError('Google is not connected.', 409);
  }
  if (!connection.canWrite) {
    throw new GoogleError('This connection is read-only. Reconnect to enable editing.', 403);
  }

  const rev = randomUUID();
  const created = await insertEvent(connection.calendarId, toDraft(input), {
    fdOrigin: env.householdId,
    fdRev: rev,
  });

  await upsertEvent(created);
  await stampPush(created.id, rev, created.etag ?? null);

  await writeFeedItem({
    kind: 'event_upcoming',
    headline: `${actor.displayName} added “${input.title}” to the calendar`,
    icon: '📅',
    points: null,
    actor: { id: actor.id, name: actor.displayName, avatar: '📅' },
    refType: 'event',
    refId: created.id,
  });

  await bumpRev(['events']);
  const stored = await findByGoogleId(created.id);
  if (!stored) throw new GoogleError('Event was created but could not be read back.', 500);
  return stored;
}

/** Edit an existing event. Same ordering: Google first, then store its answer. */
export async function updateEvent(
  googleEventId: string,
  input: EventInput,
  _actor: { id: string; displayName: string },
): Promise<CalendarEvent> {
  const connection = await connectionStatus();
  if (!connection.connected || !connection.calendarId) {
    throw new GoogleError('Google is not connected.', 409);
  }
  if (!connection.canWrite) {
    throw new GoogleError('This connection is read-only. Reconnect to enable editing.', 403);
  }

  const rev = randomUUID();

  // Mark BEFORE the call. If the push fails or the webhook beats the response,
  // the marker is what tells the next sync that a local edit was in flight.
  await markLocalEdit(googleEventId, rev);

  const updated = await patchEvent(connection.calendarId, googleEventId, toDraft(input), {
    fdOrigin: env.householdId,
    fdRev: rev,
  });

  await upsertEvent(updated);
  await stampPush(updated.id, rev, updated.etag ?? null);
  await bumpRev(['events']);

  const stored = await findByGoogleId(updated.id);
  if (!stored) throw new GoogleError('Event was updated but could not be read back.', 500);
  return stored;
}

/**
 * Delete, in both directions.
 *
 * Google first — if that fails, the event still exists everywhere and a retry
 * is safe. Locally it is a SOFT delete: the row survives 30 days so an
 * accidental tap on a wall tablet is recoverable, and the EventMap row goes
 * LAST for the same reason it does everywhere else.
 */
export async function deleteEvent(
  googleEventId: string,
  actor: { id: string; displayName: string },
): Promise<{ remote: 'deleted' | 'already_gone' }> {
  const connection = await connectionStatus();
  if (!connection.connected || !connection.calendarId) {
    throw new GoogleError('Google is not connected.', 409);
  }
  if (!connection.canWrite) {
    throw new GoogleError('This connection is read-only. Reconnect to enable editing.', 403);
  }

  const remote = await deleteRemoteEvent(connection.calendarId, googleEventId);

  const mapped = await getEntity<EventMapEntity>(
    TABLES.eventMap,
    eventMapPK(env.householdId),
    eventMapRK(googleEventId),
  );

  if (mapped) {
    const row = await getEntity<EventEntity>(TABLES.events, mapped.partitionKey_, mapped.rowKey_);
    if (row) {
      await upsert(TABLES.events, {
        partitionKey: mapped.partitionKey_,
        rowKey: mapped.rowKey_,
        deletedAt: new Date().toISOString(),
        syncState: 'deleted',
      });

      await writeFeedItem({
        kind: 'event_upcoming',
        headline: `${actor.displayName} removed “${row.title}” from the calendar`,
        icon: '📅',
        points: null,
        actor: { id: actor.id, name: actor.displayName, avatar: '📅' },
        refType: 'event',
        refId: googleEventId,
      });
    }
    // EventMap LAST. An orphaned event row is swept by the next full sync; a
    // map row pointing at nothing breaks the next delete.
    await remove(TABLES.eventMap, eventMapPK(env.householdId), eventMapRK(googleEventId));
  }

  await bumpRev(['events']);
  return { remote };
}

/**
 * "Actually, use mine."
 *
 * Re-pushes the snapshot that lost the conflict. Deliberately a re-push rather
 * than a local restore: the whole point of losing is that Google won, so the
 * only way to genuinely win is to write over it — and then it is just an
 * ordinary edit, with the same echo handling as any other.
 */
export async function restoreConflictVersion(
  googleEventId: string,
  actor: { id: string; displayName: string },
): Promise<CalendarEvent> {
  const mapped = await getEntity<EventMapEntity>(
    TABLES.eventMap,
    eventMapPK(env.householdId),
    eventMapRK(googleEventId),
  );
  if (!mapped) throw new GoogleError('That event is no longer on the calendar.', 404);

  const row = await getEntity<EventEntity>(TABLES.events, mapped.partitionKey_, mapped.rowKey_);
  if (!row?.conflictSnapshotJson) {
    throw new GoogleError('There is no earlier version to restore.', 409);
  }

  const snapshot = JSON.parse(row.conflictSnapshotJson) as ReturnType<typeof localSnapshot>;

  const restored = await updateEvent(
    googleEventId,
    {
      title: snapshot.title,
      description: snapshot.description,
      location: snapshot.location,
      allDay: snapshot.allDay,
      ...(snapshot.allDay
        ? {
            startLocalDate: snapshot.startUtc.slice(0, 10),
            endLocalDate: snapshot.endUtc.slice(0, 10),
          }
        : { startUtc: snapshot.startUtc, endUtc: snapshot.endUtc }),
    },
    actor,
  );

  // Clear the conflict once resolved, so the badge stops showing.
  await upsert(TABLES.events, {
    partitionKey: mapped.partitionKey_,
    rowKey: mapped.rowKey_,
    conflictSnapshotJson: null,
    syncState: 'ok',
  });

  return restored;
}

/** Record that a push is in flight, before the network call. */
async function markLocalEdit(googleEventId: string, rev: string): Promise<void> {
  const mapped = await getEntity<EventMapEntity>(
    TABLES.eventMap,
    eventMapPK(env.householdId),
    eventMapRK(googleEventId),
  );
  if (!mapped) return;

  await upsert(TABLES.events, {
    partitionKey: mapped.partitionKey_,
    rowKey: mapped.rowKey_,
    locallyEditedAt: new Date().toISOString(),
    lastPushedRev: rev,
    // Echo layer 3, opened BEFORE the call so a webhook that beats the response
    // still lands inside the window.
    suppressEchoUntil: new Date(Date.now() + ECHO_WINDOW_MS).toISOString(),
  });
}

/** Record what Google returned, so the echo can be recognised. */
async function stampPush(
  googleEventId: string,
  rev: string,
  etag: string | null,
): Promise<void> {
  const mapped = await getEntity<EventMapEntity>(
    TABLES.eventMap,
    eventMapPK(env.householdId),
    eventMapRK(googleEventId),
  );
  if (!mapped) return;

  await upsert(TABLES.events, {
    partitionKey: mapped.partitionKey_,
    rowKey: mapped.rowKey_,
    lastPushedRev: rev,
    lastPushedEtag: etag,
    suppressEchoUntil: new Date(Date.now() + ECHO_WINDOW_MS).toISOString(),
    locallyEditedAt: null,
    syncState: 'ok',
  });
}

export async function findByGoogleId(googleEventId: string): Promise<CalendarEvent | null> {
  const mapped = await getEntity<EventMapEntity>(
    TABLES.eventMap,
    eventMapPK(env.householdId),
    eventMapRK(googleEventId),
  );
  if (!mapped) return null;

  const row = await getEntity<EventEntity>(TABLES.events, mapped.partitionKey_, mapped.rowKey_);
  return row ? toEvent(row as EventEntity & { rowKey: string }) : null;
}

/** Events a parent still has to make a call on. */
export async function listConflicts(): Promise<CalendarEvent[]> {
  const today = localDateNow(env.timezone);
  const events = await listEventsBetween(addLocalDays(today, -PAST_DAYS), addLocalDays(today, FUTURE_DAYS));
  return events.filter((e) => e.hasConflict);
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';

/**
 * Calendar reads and the connection controls.
 *
 * `GET /api/events` runs an incremental sync server-side when the local copy is
 * more than five minutes stale, so the client never has to know about sync at
 * all — it asks for a date range and gets events. That lazy path is also the
 * fallback that matters: the kiosk polls all day, so staleness stays bounded
 * even with the webhook entirely broken.
 */

export const eventsKey = (from: string, to: string) => ['events', from, to] as const;
export const googleStatusKey = ['google-status'] as const;

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

export interface GoogleStatus {
  connected: boolean;
  /**
   * False for a household still on the Phase 6 `calendar.readonly` token.
   * Everything reads normally; only the editing affordances are withheld, which
   * is the whole point of carrying this flag to the client rather than letting
   * every write fail with a 403 the user cannot interpret.
   */
  canWrite: boolean;
  calendarId: string | null;
  calendarSummary: string | null;
  connectedAt: string | null;
  lastIncrementalAt: string | null;
  failureCount: number;
  lastError: string | null;
}

/**
 * What the write endpoints accept.
 *
 * All-day and timed events carry genuinely different fields — a date has no
 * instant and an instant has no date — so this is a union in spirit even though
 * the server validates it with a refinement.
 */
export interface EventDraft {
  title: string;
  description?: string | null;
  location?: string | null;
  allDay: boolean;
  startUtc?: string;
  endUtc?: string;
  startLocalDate?: string;
  endLocalDate?: string;
}

export interface CalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
}

export function useEvents(from: string, to: string) {
  return useQuery({
    queryKey: eventsKey(from, to),
    queryFn: () =>
      api.get<{ events: CalendarEvent[]; from: string; to: string; today: string }>(
        `/events?from=${from}&to=${to}`,
      ),
  });
}

export function useGoogleStatus() {
  return useQuery({
    queryKey: googleStatusKey,
    queryFn: () => api.get<GoogleStatus>('/google/status'),
    staleTime: 60_000,
  });
}

export function useGoogleCalendars(enabled: boolean) {
  return useQuery({
    queryKey: ['google-calendars'],
    queryFn: async () =>
      (await api.get<{ calendars: CalendarListEntry[] }>('/google/calendars')).calendars,
    enabled,
  });
}

export function usePickCalendar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { calendarId: string; summary: string }) =>
      api.post('/google/calendar', vars),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: googleStatusKey });
      void qc.invalidateQueries({ queryKey: ['events'] });
    },
  });
}

/**
 * Start the OAuth flow.
 *
 * Step-up gated server-side, so a 403 here means "re-enter your PIN" rather
 * than "you cannot do this" — connecting a calendar hands the app durable read
 * access to the family's schedule.
 */
export function useConnectGoogle() {
  return useMutation({
    mutationFn: async () => {
      const { url } = await api.get<{ url: string }>('/google/oauth/start');
      window.location.href = url;
    },
  });
}

export function useForceSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/google/sync'),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: googleStatusKey });
    },
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Every write invalidates `events` wholesale rather than patching the cache.
 *
 * The server's answer is Google's answer — Google assigns the id, normalizes the
 * times, and may move the row to a different month partition — so a locally
 * patched cache entry would be a guess that disagrees with the next poll.
 */
function useEventMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: conflictsKey });
    },
  });
}

export const conflictsKey = ['event-conflicts'] as const;

export function useCreateEvent() {
  return useEventMutation((draft: EventDraft) =>
    api.post<{ event: CalendarEvent }>('/events', draft),
  );
}

export function useUpdateEvent() {
  return useEventMutation((vars: { googleEventId: string; draft: EventDraft }) =>
    api.patch<{ event: CalendarEvent }>(`/events/${encodeURIComponent(vars.googleEventId)}`, vars.draft),
  );
}

export function useDeleteEvent() {
  return useEventMutation((googleEventId: string) =>
    api.del<{ remote: 'deleted' | 'already_gone' }>(`/events/${encodeURIComponent(googleEventId)}`),
  );
}

/** "Actually, use mine" — re-push the local version a remote edit overwrote. */
export function useRestoreEvent() {
  return useEventMutation((googleEventId: string) =>
    api.post<{ event: CalendarEvent }>(`/events/${encodeURIComponent(googleEventId)}/restore`),
  );
}

export function useConflicts(enabled: boolean) {
  return useQuery({
    queryKey: conflictsKey,
    queryFn: async () => (await api.get<{ conflicts: CalendarEvent[] }>('/events/conflicts')).conflicts,
    enabled,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Form <-> wire conversion
// ---------------------------------------------------------------------------

/**
 * `<input type="datetime-local">` speaks local wall time with no zone; the API
 * speaks UTC instants. Converting through `new Date(...)` is correct here
 * *because* the browser's zone is the household's zone on every device that
 * matters — a wall tablet in the kitchen and phones in the same house.
 */
export function localInputToUtc(value: string): string {
  return new Date(value).toISOString();
}

export function utcToLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  // Noon, not midnight: a DST spring-forward day has no 00:00 in some zones,
  // and the constructor quietly shifts to the previous day when asked for one.
  const dt = new Date(y!, m! - 1, d! + days, 12);
  return dt.toLocaleDateString('en-CA');
}

/**
 * The inclusive last day of an all-day event, for the form.
 *
 * Google's all-day `end.date` is EXCLUSIVE — a one-day event on the 5th ends on
 * the 6th — and the stored `endUtc` is that exclusive date anchored at UTC
 * midnight. The API takes an INCLUSIVE `endLocalDate` and adds the day back, so
 * the whole off-by-one lives in these two lines rather than in every caller.
 */
export function lastDayOf(event: CalendarEvent): string {
  const inclusive = addDays(event.endUtc.slice(0, 10), -1);
  // Google always sends an end for all-day events, but the sync defaults a
  // missing one to the start date — which would land this before the start.
  return inclusive < event.startLocalDate ? event.startLocalDate : inclusive;
}

/** Group into local days, so the UI renders day headers without re-deriving. */
export function groupByDay(events: CalendarEvent[]): Array<{ date: string; events: CalendarEvent[] }> {
  const map = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const list = map.get(event.startLocalDate) ?? [];
    list.push(event);
    map.set(event.startLocalDate, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, list]) => ({ date, events: list }));
}

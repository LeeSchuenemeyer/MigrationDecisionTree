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
  calendarId: string | null;
  calendarSummary: string | null;
  connectedAt: string | null;
  lastIncrementalAt: string | null;
  failureCount: number;
  lastError: string | null;
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

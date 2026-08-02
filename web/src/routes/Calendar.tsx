import { useMemo, type ReactNode } from 'react';
import {
  groupByDay,
  useConnectGoogle,
  useEvents,
  useGoogleCalendars,
  useGoogleStatus,
  usePickCalendar,
  type CalendarEvent,
} from '@/lib/calendar';
import { useSession } from '@/lib/session';
import { useSurface } from '@/lib/surface';

/**
 * The family calendar.
 *
 * An agenda list rather than a month grid, deliberately. A month grid is read
 * by scanning, which works at desk distance and fails completely at three
 * metres — and the question a wall display actually answers is "what is
 * happening next", not "what does October look like".
 */
export function Calendar(): ReactNode {
  const surface = useSurface();
  const session = useSession();
  const status = useGoogleStatus();

  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
  const horizon = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toLocaleDateString('en-CA');
  }, []);

  const events = useEvents(today, horizon);
  const isParent = session.data?.member?.role === 'parent';

  if (status.isPending) {
    return <p className="text-ink-faint p-6 text-sm">Loading…</p>;
  }

  if (!status.data?.connected) {
    return <NotConnected canConnect={isParent} />;
  }

  if (!status.data.calendarId) {
    return <PickCalendar canPick={isParent} />;
  }

  const days = groupByDay(events.data?.events ?? []);

  return (
    <section
      className={[
        'flex h-full min-h-0 flex-col gap-3 p-4 kiosk:p-6',
        surface === 'kiosk' ? 'overflow-hidden' : 'overflow-y-auto',
      ].join(' ')}
    >
      <h2 className="font-display text-ink-dim flex items-baseline justify-between text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        {status.data.calendarSummary ?? 'Calendar'}
        <span className="text-ink-faint font-mono text-xs tracking-normal kiosk:text-base">
          next 30 days
        </span>
      </h2>

      {/* A stale calendar is worth saying out loud — a wall display that has
          quietly stopped syncing looks exactly like one with nothing on. */}
      {status.data.failureCount > 0 && (
        <p className="border-overdue/40 bg-overdue/10 text-overdue rounded-md border px-3 py-2 text-xs kiosk:text-base">
          Google sync has failed {status.data.failureCount}×. A parent may need to reconnect
          in Settings.
        </p>
      )}

      {events.isPending && <p className="text-ink-faint text-sm">Loading events…</p>}

      {!events.isPending && days.length === 0 && (
        <p className="text-ink-faint py-6 text-center text-sm italic">
          Nothing on the calendar for the next month.
        </p>
      )}

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto">
        {days.map(({ date, events: dayEvents }) => (
          <div key={date} className="flex flex-col gap-1.5">
            <div className="font-display text-ink-faint flex items-baseline gap-2 text-xs tracking-[0.12em] uppercase kiosk:text-base">
              {formatDayHeading(date, today)}
            </div>
            {dayEvents.map((event) => (
              <EventRow key={event.id} event={event} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function EventRow({ event }: { event: CalendarEvent }): ReactNode {
  return (
    <div className="border-line border-l-brand/50 bg-panel grid grid-cols-[auto_1fr] items-baseline gap-3 rounded-md border border-l-[3px] px-3 py-2 kiosk:gap-5 kiosk:px-5 kiosk:py-3">
      <span className="text-ink-dim w-16 font-mono text-xs tabular-nums kiosk:w-24 kiosk:text-lg">
        {/* All-day events genuinely have no time. Rendering one as 12:00am
            makes "Grandma visits" look like a midnight appointment. */}
        {event.allDay ? 'all day' : formatTime(event.startUtc)}
      </span>
      <span className="min-w-0">
        <span className="block truncate kiosk:text-2xl">{event.title}</span>
        {event.location && (
          <span className="text-ink-faint block truncate text-xs kiosk:text-base">
            {event.location}
          </span>
        )}
      </span>
    </div>
  );
}

function NotConnected({ canConnect }: { canConnect: boolean }): ReactNode {
  const connect = useConnectGoogle();

  return (
    <section className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-ink-dim max-w-prose text-sm kiosk:text-xl">
        No calendar connected yet. One parent connects once — this is not a per-person login,
        and nobody else needs a Google account to see what is on.
      </p>
      {canConnect ? (
        <>
          <button
            type="button"
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
            className="border-brand bg-brand/15 text-brand hover:bg-brand hover:text-ground min-h-touch kiosk:min-h-touch-kiosk font-display rounded-full border px-6 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-50"
          >
            Connect Google Calendar
          </button>
          {connect.isError && (
            <p className="text-overdue max-w-prose text-xs">
              {/* The endpoint is step-up gated, so the usual cause is an
                  un-elevated session rather than a real failure. */}
              Re-enter your PIN and try again — connecting a calendar needs confirmation.
            </p>
          )}
        </>
      ) : (
        <p className="text-ink-faint font-display text-xs tracking-[0.12em] uppercase">
          A parent can connect this
        </p>
      )}
    </section>
  );
}

function PickCalendar({ canPick }: { canPick: boolean }): ReactNode {
  const calendars = useGoogleCalendars(canPick);
  const pick = usePickCalendar();

  if (!canPick) {
    return (
      <p className="text-ink-faint p-6 text-center text-sm italic">
        Connected, but no calendar chosen yet. A parent can pick one in Settings.
      </p>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4 kiosk:p-6">
      <h2 className="font-display text-ink-dim text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        Which calendar?
      </h2>
      <p className="text-ink-faint max-w-prose text-xs kiosk:text-base">
        Pick the one the family actually shares. You can change this later.
      </p>

      {calendars.isPending && <p className="text-ink-faint text-sm">Loading calendars…</p>}

      <ul className="flex flex-col gap-2">
        {(calendars.data ?? []).map((cal) => (
          <li key={cal.id}>
            <button
              type="button"
              disabled={pick.isPending}
              onClick={() => pick.mutate({ calendarId: cal.id, summary: cal.summary })}
              className="border-line bg-panel hover:bg-panel-2 min-h-touch kiosk:min-h-touch-kiosk flex w-full items-center justify-between rounded-md border px-4 text-left transition-colors disabled:opacity-50"
            >
              <span className="truncate kiosk:text-2xl">{cal.summary}</span>
              {cal.primary && (
                <span className="font-display text-ink-faint text-[10px] tracking-[0.12em] uppercase kiosk:text-sm">
                  primary
                </span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatDayHeading(date: string, today: string): string {
  if (date === today) return 'Today';

  // Parse as local noon rather than midnight UTC — a plain `new Date('2026-08-02')`
  // is UTC and renders as the previous day west of Greenwich.
  const [y, m, d] = date.split('-').map(Number);
  const local = new Date(y!, m! - 1, d!, 12);

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date === tomorrow.toLocaleDateString('en-CA')) return 'Tomorrow';

  return local.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function formatTime(iso: string): string {
  return new Date(iso)
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    .toLowerCase();
}

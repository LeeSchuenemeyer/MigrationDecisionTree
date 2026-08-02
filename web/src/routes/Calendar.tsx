import { useMemo, useState, type ReactNode } from 'react';
import {
  groupByDay,
  lastDayOf,
  localInputToUtc,
  useConflicts,
  useConnectGoogle,
  useCreateEvent,
  useDeleteEvent,
  useEvents,
  useGoogleCalendars,
  useGoogleStatus,
  usePickCalendar,
  useRestoreEvent,
  useUpdateEvent,
  utcToLocalInput,
  type CalendarEvent,
  type EventDraft,
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
  const signedIn = Boolean(session.data?.member);

  // Editing needs both halves: a write-scoped Google token *and* somebody
  // actually signed in. An ambient kiosk showing the family calendar with no
  // session is the normal resting state, and it is a read-only one.
  const canEdit = Boolean(status.data?.canWrite) && signedIn;

  const conflicts = useConflicts(Boolean(status.data?.connected) && isParent);
  const [editing, setEditing] = useState<CalendarEvent | 'new' | null>(null);

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
      <h2 className="font-display text-ink-dim flex items-baseline justify-between gap-3 text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        <span className="min-w-0 truncate">{status.data.calendarSummary ?? 'Calendar'}</span>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="border-brand text-brand hover:bg-brand hover:text-ground min-h-touch kiosk:min-h-touch-kiosk shrink-0 rounded-full border px-4 text-xs tracking-[0.12em] uppercase transition-colors kiosk:px-6 kiosk:text-base"
          >
            + Add
          </button>
        ) : (
          <span className="text-ink-faint shrink-0 font-mono text-xs tracking-normal kiosk:text-base">
            next 30 days
          </span>
        )}
      </h2>

      {/* A read-only token is a Phase 6 household that has not re-consented.
          Everything still shows; only editing is missing, and saying which is
          far kinder than letting the add button 403. */}
      {status.data.connected && !status.data.canWrite && isParent && (
        <p className="border-line bg-panel text-ink-faint rounded-md border px-3 py-2 text-xs kiosk:text-base">
          This calendar is connected for reading only. Reconnect it in Settings to add and
          edit events from here — Google asks for permission again, once.
        </p>
      )}

      {(conflicts.data?.length ?? 0) > 0 && (
        <ConflictBanner conflicts={conflicts.data ?? []} />
      )}

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
              <EventRow
                key={event.id}
                event={event}
                onEdit={canEdit ? () => setEditing(event) : null}
              />
            ))}
          </div>
        ))}
      </div>

      {editing && (
        <EventForm
          // Keyed so the form's state is rebuilt from the event it is editing
          // rather than carrying the previous one's fields across.
          key={editing === 'new' ? 'new' : editing.id}
          event={editing === 'new' ? null : editing}
          canDelete={isParent}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function EventRow({
  event,
  onEdit,
}: {
  event: CalendarEvent;
  onEdit: (() => void) | null;
}): ReactNode {
  const body = (
    <>
      <span className="text-ink-dim w-16 font-mono text-xs tabular-nums kiosk:w-24 kiosk:text-lg">
        {/* All-day events genuinely have no time. Rendering one as 12:00am
            makes "Grandma visits" look like a midnight appointment. */}
        {event.allDay ? 'all day' : formatTime(event.startUtc)}
      </span>
      <span className="min-w-0">
        <span className="block truncate kiosk:text-2xl">
          {event.title}
          {event.hasConflict && (
            <span className="text-pending ml-2 align-middle text-xs kiosk:text-base" title="Edited in two places">
              ⚠
            </span>
          )}
        </span>
        {event.location && (
          <span className="text-ink-faint block truncate text-xs kiosk:text-base">
            {event.location}
          </span>
        )}
      </span>
    </>
  );

  const shell =
    'border-line border-l-brand/50 bg-panel grid w-full grid-cols-[auto_1fr] items-baseline gap-3 rounded-md border border-l-[3px] px-3 py-2 text-left kiosk:gap-5 kiosk:px-5 kiosk:py-3';

  if (!onEdit) return <div className={shell}>{body}</div>;

  return (
    <button type="button" onClick={onEdit} className={`${shell} hover:bg-panel-2 min-h-touch kiosk:min-h-touch-kiosk transition-colors`}>
      {body}
    </button>
  );
}

/**
 * The conflict resolution surface.
 *
 * Deliberately one line and one button. A conflict means a remote edit
 * overwrote a local one; Google already won and the calendar is consistent, so
 * this is an offer to reverse that, not an error blocking anything.
 */
function ConflictBanner({ conflicts }: { conflicts: CalendarEvent[] }): ReactNode {
  const restore = useRestoreEvent();

  return (
    <ul className="border-pending/40 bg-pending/10 flex flex-col gap-2 rounded-md border px-3 py-2">
      {conflicts.map((event) => (
        <li key={event.id} className="flex items-center justify-between gap-3">
          <span className="text-pending min-w-0 truncate text-xs kiosk:text-base">
            “{event.title}” was changed in Google after you edited it here.
          </span>
          <button
            type="button"
            disabled={restore.isPending}
            onClick={() => restore.mutate(event.googleEventId)}
            className="border-pending text-pending hover:bg-pending hover:text-ground min-h-touch kiosk:min-h-touch-kiosk font-display shrink-0 rounded-full border px-4 text-[10px] tracking-[0.12em] uppercase transition-colors disabled:opacity-50 kiosk:text-sm"
          >
            Use mine
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Add / edit / delete.
 *
 * A plain overlay rather than a Radix dialog: the kiosk has no keyboard-driven
 * focus story to preserve, and every field here has to be finger-sized anyway.
 */
function EventForm({
  event,
  canDelete,
  onClose,
}: {
  event: CalendarEvent | null;
  canDelete: boolean;
  onClose: () => void;
}): ReactNode {
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const del = useDeleteEvent();

  const [title, setTitle] = useState(event?.title ?? '');
  const [location, setLocation] = useState(event?.location ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? false);

  const [startLocalDate, setStartLocalDate] = useState(
    event?.startLocalDate ?? new Date().toLocaleDateString('en-CA'),
  );
  const [endLocalDate, setEndLocalDate] = useState(
    event?.allDay ? lastDayOf(event) : (event?.startLocalDate ?? new Date().toLocaleDateString('en-CA')),
  );
  const [startAt, setStartAt] = useState(
    event && !event.allDay ? utcToLocalInput(event.startUtc) : defaultStart(),
  );
  const [endAt, setEndAt] = useState(
    event && !event.allDay ? utcToLocalInput(event.endUtc) : defaultEnd(),
  );

  const [confirmDelete, setConfirmDelete] = useState(false);

  const busy = create.isPending || update.isPending || del.isPending;
  const failure = create.error ?? update.error ?? del.error;

  const invalid =
    title.trim().length === 0 || (allDay ? endLocalDate < startLocalDate : endAt <= startAt);

  function submit() {
    const draft: EventDraft = {
      title: title.trim(),
      location: location.trim() || null,
      allDay,
      ...(allDay
        ? { startLocalDate, endLocalDate }
        : { startUtc: localInputToUtc(startAt), endUtc: localInputToUtc(endAt) }),
    };

    const done = { onSuccess: onClose };
    if (event) update.mutate({ googleEventId: event.googleEventId, draft }, done);
    else create.mutate(draft, done);
  }

  return (
    <div className="bg-ground/80 fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <div className="border-line bg-panel flex max-h-full w-full max-w-lg flex-col gap-3 overflow-y-auto rounded-t-xl border p-4 sm:rounded-xl kiosk:max-w-2xl kiosk:gap-5 kiosk:p-8">
        <h3 className="font-display text-ink-dim text-sm tracking-[0.16em] uppercase kiosk:text-lg">
          {event ? 'Edit event' : 'New event'}
        </h3>

        <Field label="What">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            autoFocus
            className={inputClass}
          />
        </Field>

        <Field label="Where (optional)">
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            maxLength={300}
            className={inputClass}
          />
        </Field>

        <label className="min-h-touch kiosk:min-h-touch-kiosk flex items-center gap-3">
          <input
            type="checkbox"
            checked={allDay}
            onChange={(e) => setAllDay(e.target.checked)}
            className="accent-brand h-5 w-5 kiosk:h-7 kiosk:w-7"
          />
          <span className="text-sm kiosk:text-xl">All day</span>
        </label>

        {allDay ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <input
                type="date"
                value={startLocalDate}
                onChange={(e) => {
                  setStartLocalDate(e.target.value);
                  // Dragging the start past the end is a slip, not an intent.
                  if (e.target.value > endLocalDate) setEndLocalDate(e.target.value);
                }}
                className={inputClass}
              />
            </Field>
            <Field label="Through">
              <input
                type="date"
                value={endLocalDate}
                min={startLocalDate}
                onChange={(e) => setEndLocalDate(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts">
              <input
                type="datetime-local"
                value={startAt}
                onChange={(e) => {
                  const shift = new Date(e.target.value).getTime() - new Date(startAt).getTime();
                  setStartAt(e.target.value);
                  // Move the end with the start, preserving duration — moving an
                  // hour-long thing to Thursday should not make it end Tuesday.
                  if (Number.isFinite(shift)) {
                    setEndAt(utcToLocalInput(new Date(new Date(endAt).getTime() + shift).toISOString()));
                  }
                }}
                className={inputClass}
              />
            </Field>
            <Field label="Ends">
              <input
                type="datetime-local"
                value={endAt}
                min={startAt}
                onChange={(e) => setEndAt(e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        )}

        {failure && (
          <p className="text-overdue text-xs kiosk:text-base">{failure.message}</p>
        )}

        <div className="mt-1 flex items-center gap-2">
          {event && canDelete && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!confirmDelete) return setConfirmDelete(true);
                del.mutate(event.googleEventId, { onSuccess: onClose });
              }}
              className="border-overdue text-overdue hover:bg-overdue hover:text-ground min-h-touch kiosk:min-h-touch-kiosk font-display mr-auto rounded-full border px-4 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-50 kiosk:text-base"
            >
              {confirmDelete ? 'Really delete?' : 'Delete'}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="border-line text-ink-dim hover:bg-panel-2 min-h-touch kiosk:min-h-touch-kiosk font-display ml-auto rounded-full border px-5 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-50 kiosk:text-base"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || invalid}
            onClick={submit}
            className="border-brand bg-brand/15 text-brand hover:bg-brand hover:text-ground min-h-touch kiosk:min-h-touch-kiosk font-display rounded-full border px-5 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-40 kiosk:text-base"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

const inputClass =
  'border-line bg-ground min-h-touch kiosk:min-h-touch-kiosk w-full rounded-md border px-3 text-base kiosk:text-xl';

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-display text-ink-faint text-[10px] tracking-[0.12em] uppercase kiosk:text-sm">
        {label}
      </span>
      {children}
    </label>
  );
}

/** Next round hour — the overwhelmingly common case for "add something now". */
function defaultStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return utcToLocalInput(d.toISOString());
}

function defaultEnd(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 2);
  return utcToLocalInput(d.toISOString());
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

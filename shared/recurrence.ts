/**
 * Recurrence: turning a task definition into the dates it happens on.
 *
 * Deliberately not RFC 5545. A household needs daily, every-N-days, specific
 * weekdays, monthly-by-day, and one-offs; that is ~100 lines of pure,
 * exhaustively testable code. Taking on an RRULE dependency would buy
 * EXDATE, BYSETPOS, and a decade of calendar edge cases we would never use,
 * and would still need this wrapper.
 *
 * Everything here is calendar arithmetic on LOCAL dates. No instants, no
 * timezones — which is what keeps it correct across DST, where a day can be
 * 23 or 25 hours long but is still exactly one day.
 */

import { addLocalDays, assertLocalDate, daysBetween, isBefore, weekdayOf, type LocalDate } from './time.js';

export type Frequency = 'once' | 'daily' | 'weekly' | 'monthly';

export interface Recurrence {
  freq: Frequency;
  /** Every N days/weeks/months. 1 = every one. Ignored for `once`. */
  interval: number;
  /**
   * ISO weekdays (1 = Monday … 7 = Sunday). Only meaningful for `weekly`.
   * Empty or absent means "the same weekday as dtStart".
   */
  byWeekday?: number[];
  /**
   * Day of month (1–31). Only meaningful for `monthly`. Absent means "the same
   * day-of-month as dtStart". A value past the end of a short month simply
   * does not occur that month — see the note in `occursOn`.
   */
  byMonthDay?: number;
  /** First date the task can occur. */
  dtStart: LocalDate;
  /** Last date, inclusive. Absent means it runs forever. */
  until?: LocalDate;
}

/** Does this definition produce an occurrence on `date`? */
export function occursOn(rec: Recurrence, date: LocalDate): boolean {
  assertLocalDate(date);
  assertLocalDate(rec.dtStart);

  if (isBefore(date, rec.dtStart)) return false;
  if (rec.until) {
    assertLocalDate(rec.until);
    // `until` is inclusive: a task that runs "through Friday" happens on Friday.
    if (isBefore(rec.until, date)) return false;
  }

  const interval = Math.max(1, Math.floor(rec.interval || 1));

  switch (rec.freq) {
    case 'once':
      return date === rec.dtStart;

    case 'daily': {
      const elapsed = daysBetween(rec.dtStart, date);
      return elapsed % interval === 0;
    }

    case 'weekly': {
      const days = rec.byWeekday?.length ? rec.byWeekday : [weekdayOf(rec.dtStart)];
      if (!days.includes(weekdayOf(date))) return false;

      // Week alignment is measured from the start of dtStart's week, so an
      // every-2-weeks task with several weekdays keeps all of them in the same
      // week rather than drifting apart.
      const startOfStartWeek = addLocalDays(rec.dtStart, -(weekdayOf(rec.dtStart) - 1));
      const startOfThisWeek = addLocalDays(date, -(weekdayOf(date) - 1));
      const weeksElapsed = Math.round(daysBetween(startOfStartWeek, startOfThisWeek) / 7);
      return weeksElapsed % interval === 0;
    }

    case 'monthly': {
      const wantedDay = rec.byMonthDay ?? dayOfMonth(rec.dtStart);
      // A 31st-of-the-month task simply does not occur in November. Silently
      // rolling it to the 30th (or into December) would either duplicate a
      // chore or move it somewhere nobody expects.
      if (dayOfMonth(date) !== wantedDay) return false;

      const monthsElapsed = monthIndex(date) - monthIndex(rec.dtStart);
      return monthsElapsed >= 0 && monthsElapsed % interval === 0;
    }

    default:
      return false;
  }
}

/** Every occurrence in an inclusive date range. */
export function occurrencesBetween(
  rec: Recurrence,
  from: LocalDate,
  to: LocalDate,
): LocalDate[] {
  const out: LocalDate[] = [];
  const span = daysBetween(from, to);
  if (span < 0) return out;

  for (let i = 0; i <= span; i++) {
    const date = addLocalDays(from, i);
    if (occursOn(rec, date)) out.push(date);
  }
  return out;
}

/** Human-readable summary, for the task-management screen. */
export function describeRecurrence(rec: Recurrence): string {
  const every = rec.interval > 1 ? `every ${rec.interval} ` : 'every ';

  switch (rec.freq) {
    case 'once':
      return `once on ${rec.dtStart}`;
    case 'daily':
      return rec.interval > 1 ? `${every}days` : 'every day';
    case 'weekly': {
      const days = rec.byWeekday?.length ? rec.byWeekday : [weekdayOf(rec.dtStart)];
      const names = days.slice().sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d - 1]).join(', ');
      return rec.interval > 1 ? `${every}weeks on ${names}` : `every ${names}`;
    }
    case 'monthly': {
      const day = rec.byMonthDay ?? dayOfMonth(rec.dtStart);
      return rec.interval > 1
        ? `${every}months on the ${ordinal(day)}`
        : `monthly on the ${ordinal(day)}`;
    }
    default:
      return 'never';
  }
}

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

function dayOfMonth(date: LocalDate): number {
  return Number(date.slice(8, 10));
}

/** Months since year 0, so month arithmetic never wraps incorrectly. */
function monthIndex(date: LocalDate): number {
  return Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1);
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

// ---------------------------------------------------------------------------
// Assignment rotation
// ---------------------------------------------------------------------------

export type AssignMode = 'fixed' | 'anyone' | 'rotate';

/**
 * Who owns a given occurrence.
 *
 * `rotate` is indexed by the occurrence ordinal rather than by date, so a
 * skipped week does not hand the same person two turns in a row.
 */
export function resolveAssignee(
  mode: AssignMode,
  opts: {
    fixedMemberId?: string | null;
    rotationOrder?: string[];
    rotationIndex?: number;
    occurrenceOrdinal: number;
    anyoneToken: string;
  },
): string {
  if (mode === 'anyone') return opts.anyoneToken;

  if (mode === 'rotate') {
    const order = opts.rotationOrder ?? [];
    if (order.length === 0) return opts.anyoneToken;
    const idx = ((opts.rotationIndex ?? 0) + opts.occurrenceOrdinal) % order.length;
    return order[idx]!;
  }

  return opts.fixedMemberId ?? opts.anyoneToken;
}

/**
 * How many occurrences precede `date`, used as the rotation ordinal.
 * Counting from dtStart keeps rotation stable no matter when we materialize.
 */
export function occurrenceOrdinal(rec: Recurrence, date: LocalDate): number {
  return occurrencesBetween(rec, rec.dtStart, date).length - 1;
}

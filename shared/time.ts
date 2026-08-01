/**
 * All local-date math for the household.
 *
 * Every partition-key date in this system is a LOCAL date in the household's
 * IANA timezone. `new Date().toISOString().slice(0, 10)` is UTC and silently
 * produces wrong-day partitions for anyone west of Greenwich — and double-fires
 * or skips scheduled jobs across a DST transition. Use these helpers instead.
 */

import { DateTime, Duration } from 'luxon';

/** A local calendar date, `YYYY-MM-DD`. */
export type LocalDate = string;

/** A local calendar month, `YYYY-MM`. */
export type YearMonth = string;

export const DATE_FMT = 'yyyy-MM-dd';
export const MONTH_FMT = 'yyyy-MM';

function zoned(zone: string, ms?: number): DateTime {
  const dt = ms === undefined ? DateTime.now() : DateTime.fromMillis(ms);
  const z = dt.setZone(zone);
  if (!z.isValid) throw new Error(`Invalid timezone "${zone}": ${z.invalidReason}`);
  return z;
}

/** Today's local date in the household timezone. */
export function localDateNow(zone: string, nowMs?: number): LocalDate {
  return zoned(zone, nowMs).toFormat(DATE_FMT);
}

/** The local date a given UTC instant falls on. */
export function localDateOf(epochMs: number, zone: string): LocalDate {
  return zoned(zone, epochMs).toFormat(DATE_FMT);
}

/** The local year-month a given UTC instant falls in. */
export function yearMonthOf(epochMs: number, zone: string): YearMonth {
  return zoned(zone, epochMs).toFormat(MONTH_FMT);
}

/** The year-month a local date belongs to — pure string math, no zone needed. */
export function yearMonthOfLocalDate(date: LocalDate): YearMonth {
  assertLocalDate(date);
  return date.slice(0, 7);
}

/** Current local year-month. */
export function yearMonthNow(zone: string, nowMs?: number): YearMonth {
  return zoned(zone, nowMs).toFormat(MONTH_FMT);
}

/**
 * Start of a local day as a UTC instant. On a DST spring-forward day where
 * midnight does not exist, Luxon returns the following valid instant, which is
 * the behavior we want (the day still starts exactly once).
 */
export function startOfLocalDayMs(date: LocalDate, zone: string): number {
  return parseLocalDate(date, zone).startOf('day').toMillis();
}

/** Exclusive end of a local day as a UTC instant. */
export function endOfLocalDayMs(date: LocalDate, zone: string): number {
  return parseLocalDate(date, zone).plus({ days: 1 }).startOf('day').toMillis();
}

/**
 * Length of a local day in hours. 23 or 25 on DST transition days — which is
 * exactly why nothing in this codebase may assume 24.
 */
export function localDayLengthHours(date: LocalDate, zone: string): number {
  const ms = endOfLocalDayMs(date, zone) - startOfLocalDayMs(date, zone);
  return ms / 3_600_000;
}

/** Add (or subtract, with a negative count) whole calendar days. */
export function addLocalDays(date: LocalDate, days: number): LocalDate {
  return parseLocalDateNaive(date).plus({ days }).toFormat(DATE_FMT);
}

/** Whole calendar days from `a` to `b`. Negative when `b` precedes `a`. */
export function daysBetween(a: LocalDate, b: LocalDate): number {
  const diff = parseLocalDateNaive(b).diff(parseLocalDateNaive(a), 'days').days;
  return Math.round(diff);
}

/** Inclusive list of local dates from `from` to `to`. */
export function localDateRange(from: LocalDate, to: LocalDate): LocalDate[] {
  const n = daysBetween(from, to);
  if (n < 0) return [];
  const out: LocalDate[] = [];
  for (let i = 0; i <= n; i++) out.push(addLocalDays(from, i));
  return out;
}

/** ISO weekday, 1 = Monday … 7 = Sunday (matches our recurrence `byWeekday`). */
export function weekdayOf(date: LocalDate): number {
  return parseLocalDateNaive(date).weekday;
}

/** Whether `date` is strictly before `other`. */
export function isBefore(date: LocalDate, other: LocalDate): boolean {
  assertLocalDate(date);
  assertLocalDate(other);
  return date < other; // ISO dates sort lexically
}

/** Combine a local date with a `HH:mm` wall time into a UTC instant. */
export function localDateTimeMs(date: LocalDate, timeHHmm: string, zone: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(timeHHmm);
  if (!m) throw new Error(`Invalid time "${timeHHmm}", expected HH:mm`);
  return parseLocalDate(date, zone)
    .set({ hour: Number(m[1]), minute: Number(m[2]), second: 0, millisecond: 0 })
    .toMillis();
}

/** Format a UTC instant as a short wall-clock time in the household zone. */
export function formatLocalTime(epochMs: number, zone: string): string {
  return zoned(zone, epochMs).toFormat('h:mm a').toLowerCase();
}

/** Human-friendly duration, for session countdowns. */
export function formatDuration(ms: number): string {
  return Duration.fromMillis(Math.max(0, ms)).toFormat('m:ss');
}

export function assertLocalDate(date: string): asserts date is LocalDate {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Invalid local date "${date}", expected YYYY-MM-DD`);
  }
}

function parseLocalDate(date: LocalDate, zone: string): DateTime {
  assertLocalDate(date);
  const dt = DateTime.fromFormat(date, DATE_FMT, { zone });
  if (!dt.isValid) throw new Error(`Invalid local date "${date}" in ${zone}: ${dt.invalidReason}`);
  return dt;
}

/**
 * Parse without a zone, for pure calendar arithmetic (add days, weekday). Using
 * a fixed UTC zone here keeps day-count math free of DST distortion — the
 * result is a calendar label, never an instant.
 */
function parseLocalDateNaive(date: LocalDate): DateTime {
  assertLocalDate(date);
  const dt = DateTime.fromFormat(date, DATE_FMT, { zone: 'utc' });
  if (!dt.isValid) throw new Error(`Invalid local date "${date}": ${dt.invalidReason}`);
  return dt;
}

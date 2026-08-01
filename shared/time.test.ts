import { describe, expect, it } from 'vitest';
import * as t from './time.js';

const NY = 'America/New_York';
const UTC = 'UTC';

describe('local dates are local, not UTC', () => {
  it('resolves the previous day for a late-evening US instant', () => {
    // 2026-03-09T02:30:00Z is still 2026-03-08 21:30 in New York. The naive
    // `toISOString().slice(0,10)` bug would write this into tomorrow's partition.
    const ms = Date.UTC(2026, 2, 9, 2, 30, 0);
    expect(t.localDateOf(ms, NY)).toBe('2026-03-08');
    expect(t.localDateOf(ms, UTC)).toBe('2026-03-09');
  });

  it('derives year-month from the local date, not the UTC one', () => {
    const ms = Date.UTC(2026, 3, 1, 3, 0, 0); // Apr 1 03:00Z === Mar 31 23:00 NY
    expect(t.yearMonthOf(ms, NY)).toBe('2026-03');
    expect(t.yearMonthOf(ms, UTC)).toBe('2026-04');
  });

  it('rejects a malformed date instead of silently coercing it', () => {
    expect(() => t.assertLocalDate('2026-3-8')).toThrow();
    expect(() => t.assertLocalDate('not-a-date')).toThrow();
  });
});

describe('DST transitions', () => {
  // US DST 2026: forward Sun Mar 8, back Sun Nov 1.
  it('a spring-forward day is 23 hours long', () => {
    expect(t.localDayLengthHours('2026-03-08', NY)).toBe(23);
  });

  it('a fall-back day is 25 hours long', () => {
    expect(t.localDayLengthHours('2026-11-01', NY)).toBe(25);
  });

  it('an ordinary day is 24 hours long', () => {
    expect(t.localDayLengthHours('2026-06-15', NY)).toBe(24);
  });

  it('day boundaries stay adjacent across a transition', () => {
    // The end of the spring-forward day must equal the start of the next one,
    // or a task instance can fall into no partition at all.
    expect(t.endOfLocalDayMs('2026-03-08', NY)).toBe(t.startOfLocalDayMs('2026-03-09', NY));
    expect(t.endOfLocalDayMs('2026-11-01', NY)).toBe(t.startOfLocalDayMs('2026-11-02', NY));
  });

  it('calendar arithmetic crosses a transition without drifting', () => {
    expect(t.addLocalDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(t.addLocalDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(t.daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(t.daysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });
});

describe('calendar arithmetic', () => {
  it('crosses month and year boundaries', () => {
    expect(t.addLocalDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(t.addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(t.addLocalDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('handles leap day', () => {
    expect(t.addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(t.addLocalDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(t.addLocalDays('2026-02-28', 1)).toBe('2026-03-01'); // 2026 is not a leap year
    expect(t.daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(t.daysBetween('2026-02-28', '2026-03-01')).toBe(1);
  });

  it('produces an inclusive range', () => {
    expect(t.localDateRange('2026-03-06', '2026-03-09')).toEqual([
      '2026-03-06',
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
    ]);
    expect(t.localDateRange('2026-03-06', '2026-03-06')).toEqual(['2026-03-06']);
    expect(t.localDateRange('2026-03-09', '2026-03-06')).toEqual([]);
  });

  it('reports ISO weekdays with Monday as 1', () => {
    expect(t.weekdayOf('2026-03-09')).toBe(1); // Monday
    expect(t.weekdayOf('2026-03-15')).toBe(7); // Sunday
  });

  it('orders dates lexically', () => {
    expect(t.isBefore('2026-03-08', '2026-03-09')).toBe(true);
    expect(t.isBefore('2026-03-09', '2026-03-08')).toBe(false);
    expect(t.isBefore('2026-03-08', '2026-03-08')).toBe(false);
  });

  it('derives year-month from a local date string', () => {
    expect(t.yearMonthOfLocalDate('2026-03-08')).toBe('2026-03');
  });
});

describe('wall-clock times', () => {
  it('combines a date and HH:mm into the right instant', () => {
    // 17:30 on 2026-06-15 in New York (EDT, UTC-4) === 21:30Z
    const ms = t.localDateTimeMs('2026-06-15', '17:30', NY);
    expect(new Date(ms).toISOString()).toBe('2026-06-15T21:30:00.000Z');
  });

  it('accounts for the offset change across DST', () => {
    // Same wall time in January is EST (UTC-5) === 22:30Z
    const ms = t.localDateTimeMs('2026-01-15', '17:30', NY);
    expect(new Date(ms).toISOString()).toBe('2026-01-15T22:30:00.000Z');
  });

  it('rejects a malformed time', () => {
    expect(() => t.localDateTimeMs('2026-06-15', '5:30pm', NY)).toThrow(/HH:mm/);
  });

  it('formats durations for the session countdown', () => {
    expect(t.formatDuration(600_000)).toBe('10:00');
    expect(t.formatDuration(65_000)).toBe('1:05');
    expect(t.formatDuration(-5)).toBe('0:00');
  });
});

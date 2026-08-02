import { describe, expect, it } from 'vitest';
import {
  describeRecurrence,
  occurrenceOrdinal,
  occurrencesBetween,
  occursOn,
  resolveAssignee,
  type Recurrence,
} from './recurrence.js';

const daily = (over: Partial<Recurrence> = {}): Recurrence => ({
  freq: 'daily',
  interval: 1,
  dtStart: '2026-03-01',
  ...over,
});

describe('once', () => {
  const rec: Recurrence = { freq: 'once', interval: 1, dtStart: '2026-03-05' };

  it('happens on exactly its start date', () => {
    expect(occursOn(rec, '2026-03-05')).toBe(true);
    expect(occursOn(rec, '2026-03-04')).toBe(false);
    expect(occursOn(rec, '2026-03-06')).toBe(false);
  });
});

describe('daily', () => {
  it('happens every day', () => {
    const rec = daily();
    for (const d of ['2026-03-01', '2026-03-02', '2026-03-31', '2027-01-01']) {
      expect(occursOn(rec, d), d).toBe(true);
    }
  });

  it('never happens before dtStart', () => {
    expect(occursOn(daily(), '2026-02-28')).toBe(false);
  });

  it('respects every-N-days', () => {
    const rec = daily({ interval: 3 });
    expect(occursOn(rec, '2026-03-01')).toBe(true);
    expect(occursOn(rec, '2026-03-02')).toBe(false);
    expect(occursOn(rec, '2026-03-03')).toBe(false);
    expect(occursOn(rec, '2026-03-04')).toBe(true);
  });

  it('keeps its cadence across a DST transition', () => {
    // 2026-03-08 is the US spring-forward day: 23 hours long, still one day.
    const rec = daily({ interval: 2, dtStart: '2026-03-06' });
    expect(occursOn(rec, '2026-03-06')).toBe(true);
    expect(occursOn(rec, '2026-03-08')).toBe(true);
    expect(occursOn(rec, '2026-03-09')).toBe(false);
    expect(occursOn(rec, '2026-03-10')).toBe(true);
  });

  it('keeps its cadence across a fall-back day', () => {
    // 2026-11-01 is 25 hours long.
    const rec = daily({ interval: 2, dtStart: '2026-10-30' });
    expect(occursOn(rec, '2026-11-01')).toBe(true);
    expect(occursOn(rec, '2026-11-03')).toBe(true);
  });

  it('honors an inclusive until', () => {
    const rec = daily({ until: '2026-03-03' });
    expect(occursOn(rec, '2026-03-03')).toBe(true);
    expect(occursOn(rec, '2026-03-04')).toBe(false);
  });
});

describe('weekly', () => {
  it('happens on the listed weekdays', () => {
    // Mon/Wed/Fri, starting Sunday 2026-03-01.
    const rec: Recurrence = {
      freq: 'weekly',
      interval: 1,
      byWeekday: [1, 3, 5],
      dtStart: '2026-03-01',
    };
    expect(occursOn(rec, '2026-03-02')).toBe(true); // Mon
    expect(occursOn(rec, '2026-03-03')).toBe(false); // Tue
    expect(occursOn(rec, '2026-03-04')).toBe(true); // Wed
    expect(occursOn(rec, '2026-03-06')).toBe(true); // Fri
    expect(occursOn(rec, '2026-03-07')).toBe(false); // Sat
  });

  it('defaults to the weekday of dtStart', () => {
    const rec: Recurrence = { freq: 'weekly', interval: 1, dtStart: '2026-03-04' }; // Wed
    expect(occursOn(rec, '2026-03-11')).toBe(true);
    expect(occursOn(rec, '2026-03-12')).toBe(false);
  });

  it('crosses a month boundary without losing its footing', () => {
    const rec: Recurrence = {
      freq: 'weekly',
      interval: 1,
      byWeekday: [2],
      dtStart: '2026-03-24',
    };
    expect(occursOn(rec, '2026-03-31')).toBe(true);
    expect(occursOn(rec, '2026-04-07')).toBe(true);
    expect(occursOn(rec, '2026-04-14')).toBe(true);
  });

  it('keeps every weekday of a fortnightly task in the same week', () => {
    // Every 2 weeks on Mon and Fri, from Monday 2026-03-02.
    const rec: Recurrence = {
      freq: 'weekly',
      interval: 2,
      byWeekday: [1, 5],
      dtStart: '2026-03-02',
    };
    expect(occursOn(rec, '2026-03-02')).toBe(true); // Mon, week 0
    expect(occursOn(rec, '2026-03-06')).toBe(true); // Fri, week 0
    expect(occursOn(rec, '2026-03-09')).toBe(false); // week 1
    expect(occursOn(rec, '2026-03-13')).toBe(false); // week 1
    expect(occursOn(rec, '2026-03-16')).toBe(true); // week 2
    expect(occursOn(rec, '2026-03-20')).toBe(true); // week 2
  });
});

describe('monthly', () => {
  it('happens on the same day each month', () => {
    const rec: Recurrence = { freq: 'monthly', interval: 1, dtStart: '2026-03-15' };
    expect(occursOn(rec, '2026-03-15')).toBe(true);
    expect(occursOn(rec, '2026-04-15')).toBe(true);
    expect(occursOn(rec, '2026-04-16')).toBe(false);
  });

  it('simply does not occur in months that are too short', () => {
    // Rolling a 31st to the 30th would duplicate a chore or move it somewhere
    // nobody expects, so the occurrence is skipped instead.
    const rec: Recurrence = { freq: 'monthly', interval: 1, byMonthDay: 31, dtStart: '2026-01-31' };
    expect(occursOn(rec, '2026-01-31')).toBe(true);
    expect(occursOn(rec, '2026-03-31')).toBe(true);
    expect(occurrencesBetween(rec, '2026-02-01', '2026-02-28')).toEqual([]);
  });

  it('handles leap day', () => {
    const rec: Recurrence = { freq: 'monthly', interval: 1, byMonthDay: 29, dtStart: '2028-01-29' };
    expect(occursOn(rec, '2028-02-29')).toBe(true); // 2028 is a leap year
    const rec2026: Recurrence = { freq: 'monthly', interval: 1, byMonthDay: 29, dtStart: '2026-01-29' };
    expect(occurrencesBetween(rec2026, '2026-02-01', '2026-02-28')).toEqual([]);
  });

  it('respects every-N-months across a year boundary', () => {
    const rec: Recurrence = { freq: 'monthly', interval: 3, dtStart: '2026-11-10' };
    expect(occursOn(rec, '2026-11-10')).toBe(true);
    expect(occursOn(rec, '2026-12-10')).toBe(false);
    expect(occursOn(rec, '2027-02-10')).toBe(true);
    expect(occursOn(rec, '2027-05-10')).toBe(true);
  });
});

describe('occurrencesBetween', () => {
  it('returns an inclusive list', () => {
    expect(occurrencesBetween(daily({ interval: 2 }), '2026-03-01', '2026-03-07')).toEqual([
      '2026-03-01',
      '2026-03-03',
      '2026-03-05',
      '2026-03-07',
    ]);
  });

  it('returns nothing for an inverted range', () => {
    expect(occurrencesBetween(daily(), '2026-03-07', '2026-03-01')).toEqual([]);
  });
});

describe('assignment', () => {
  const order = ['maya', 'theo', 'iris'];

  it('gives a fixed task to its owner', () => {
    expect(
      resolveAssignee('fixed', { fixedMemberId: 'maya', occurrenceOrdinal: 5, anyoneToken: '*' }),
    ).toBe('maya');
  });

  it('leaves an anyone task unclaimed', () => {
    expect(resolveAssignee('anyone', { occurrenceOrdinal: 0, anyoneToken: '*' })).toBe('*');
  });

  it('rotates by occurrence, so a skipped week does not double up', () => {
    const at = (n: number) =>
      resolveAssignee('rotate', {
        rotationOrder: order,
        rotationIndex: 0,
        occurrenceOrdinal: n,
        anyoneToken: '*',
      });
    expect([at(0), at(1), at(2), at(3)]).toEqual(['maya', 'theo', 'iris', 'maya']);
  });

  it('honors a starting rotation offset', () => {
    expect(
      resolveAssignee('rotate', {
        rotationOrder: order,
        rotationIndex: 2,
        occurrenceOrdinal: 0,
        anyoneToken: '*',
      }),
    ).toBe('iris');
  });

  it('falls back to unclaimed when the rotation is empty', () => {
    expect(
      resolveAssignee('rotate', { rotationOrder: [], occurrenceOrdinal: 0, anyoneToken: '*' }),
    ).toBe('*');
  });

  it('counts occurrence ordinals from dtStart, so rotation is stable', () => {
    const rec = daily({ interval: 2 });
    expect(occurrenceOrdinal(rec, '2026-03-01')).toBe(0);
    expect(occurrenceOrdinal(rec, '2026-03-03')).toBe(1);
    expect(occurrenceOrdinal(rec, '2026-03-05')).toBe(2);
  });
});

describe('descriptions', () => {
  it('reads naturally', () => {
    expect(describeRecurrence(daily())).toBe('every day');
    expect(describeRecurrence(daily({ interval: 3 }))).toBe('every 3 days');
    expect(
      describeRecurrence({ freq: 'weekly', interval: 1, byWeekday: [1, 3], dtStart: '2026-03-01' }),
    ).toBe('every Mon, Wed');
    expect(
      describeRecurrence({ freq: 'monthly', interval: 1, byMonthDay: 1, dtStart: '2026-03-01' }),
    ).toBe('monthly on the 1st');
    expect(
      describeRecurrence({ freq: 'monthly', interval: 1, byMonthDay: 22, dtStart: '2026-03-22' }),
    ).toBe('monthly on the 22nd');
  });
});

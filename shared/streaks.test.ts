import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FREEZES,
  daysToNextTier,
  deadlineFor,
  effectiveLength,
  effectiveMultiplier,
  emptyStreak,
  isAlive,
  recordQualifyingDay,
  replay,
  type StreakState,
} from './streaks.js';

describe('starting a streak', () => {
  it('begins at one', () => {
    const out = recordQualifyingDay(emptyStreak(), '2026-03-01');
    expect(out.event).toBe('started');
    expect(out.state.current).toBe(1);
    expect(out.state.longest).toBe(1);
    expect(out.multiplier).toBe(1);
  });
});

describe('extending', () => {
  it('counts consecutive days', () => {
    let s = emptyStreak();
    for (const d of ['2026-03-01', '2026-03-02', '2026-03-03']) {
      s = recordQualifyingDay(s, d).state;
    }
    expect(s.current).toBe(3);
    expect(s.longest).toBe(3);
  });

  it('reaches the multiplier tiers at the right lengths', () => {
    let s = emptyStreak();
    let day = '2026-03-01';
    const seen: Record<number, number> = {};
    for (let i = 0; i < 30; i++) {
      const out = recordQualifyingDay(s, day);
      s = out.state;
      seen[s.current] = out.multiplier;
      day = `2026-03-${String(i + 2).padStart(2, '0')}`;
      if (i >= 29) break;
    }
    expect(seen[1]).toBe(1);
    expect(seen[2]).toBe(1);
    expect(seen[3]).toBe(1.1);
    expect(seen[7]).toBe(1.25);
  });

  it('does not inflate when the same day qualifies twice', () => {
    // Four chores on Tuesday is still one day. Otherwise a single busy
    // afternoon buys a week-long multiplier.
    let s = recordQualifyingDay(emptyStreak(), '2026-03-01').state;
    s = recordQualifyingDay(s, '2026-03-02').state;
    expect(s.current).toBe(2);

    const again = recordQualifyingDay(s, '2026-03-02');
    expect(again.event).toBe('unchanged');
    expect(again.state.current).toBe(2);

    const thrice = recordQualifyingDay(again.state, '2026-03-02');
    expect(thrice.state.current).toBe(2);
  });

  it('ignores an out-of-order replay rather than corrupting state', () => {
    let s = recordQualifyingDay(emptyStreak(), '2026-03-05').state;
    const backwards = recordQualifyingDay(s, '2026-03-01');
    expect(backwards.event).toBe('unchanged');
    expect(backwards.state.current).toBe(1);
    expect(backwards.state.lastQualifiedDate).toBe('2026-03-05');
  });
});

describe('freezes', () => {
  it('burns a freeze to survive one missed day', () => {
    let s = emptyStreak();
    s = recordQualifyingDay(s, '2026-03-01').state;
    s = recordQualifyingDay(s, '2026-03-02').state;
    expect(s.freezesRemaining).toBe(DEFAULT_FREEZES);

    // Skips 2026-03-03.
    const out = recordQualifyingDay(s, '2026-03-04');
    expect(out.event).toBe('froze');
    expect(out.state.current).toBe(3);
    expect(out.state.freezesRemaining).toBe(DEFAULT_FREEZES - 1);
  });

  it('breaks once the freezes are gone', () => {
    let s: StreakState = {
      current: 9,
      longest: 9,
      lastQualifiedDate: '2026-03-01',
      freezesRemaining: 0,
    };
    const out = recordQualifyingDay(s, '2026-03-03');
    expect(out.event).toBe('broken');
    expect(out.state.current).toBe(1);
    // The record survives the break.
    expect(out.state.longest).toBe(9);
  });

  it('will not paper over a two-day gap even with freezes available', () => {
    const s: StreakState = {
      current: 5,
      longest: 5,
      lastQualifiedDate: '2026-03-01',
      freezesRemaining: 2,
    };
    const out = recordQualifyingDay(s, '2026-03-04'); // gap of 3
    expect(out.event).toBe('broken');
    expect(out.state.current).toBe(1);
    expect(out.state.freezesRemaining).toBe(2);
  });
});

describe('breaking', () => {
  it('restarts at one, not zero, so today still counts', () => {
    const s: StreakState = {
      current: 12,
      longest: 12,
      lastQualifiedDate: '2026-03-01',
      freezesRemaining: 0,
    };
    const out = recordQualifyingDay(s, '2026-03-10');
    expect(out.state.current).toBe(1);
    expect(out.multiplier).toBe(1);
  });

  it('keeps the personal best', () => {
    let s = replay(['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'], 0);
    expect(s.longest).toBe(4);
    s = recordQualifyingDay(s, '2026-03-20').state;
    expect(s.current).toBe(1);
    expect(s.longest).toBe(4);
  });
});

describe('lapsing (display, without mutation)', () => {
  const s: StreakState = {
    current: 10,
    longest: 10,
    lastQualifiedDate: '2026-03-10',
    freezesRemaining: 1,
  };

  it('is alive today and tomorrow', () => {
    expect(isAlive(s, '2026-03-10')).toBe(true);
    expect(isAlive(s, '2026-03-11')).toBe(true);
  });

  it('is alive across a one-day gap while a freeze remains', () => {
    expect(isAlive(s, '2026-03-12')).toBe(true);
    expect(isAlive({ ...s, freezesRemaining: 0 }, '2026-03-12')).toBe(false);
  });

  it('is dead once the gap is too large', () => {
    expect(isAlive(s, '2026-03-14')).toBe(false);
  });

  it('stops advertising a multiplier the moment it lapses', () => {
    // The board must never still show a multiplier for a streak that died on
    // Tuesday. (A 10-day streak sits in the 7-day tier, so 1.25 — not 1.5,
    // which needs 30.)
    expect(effectiveMultiplier(s, '2026-03-11')).toBe(1.25);
    expect(effectiveMultiplier(s, '2026-03-14')).toBe(1);
    expect(effectiveLength(s, '2026-03-11')).toBe(10);
    expect(effectiveLength(s, '2026-03-14')).toBe(0);
  });

  it('treats an empty streak as dead', () => {
    expect(isAlive(emptyStreak(), '2026-03-10')).toBe(false);
  });
});

describe('replay', () => {
  it('is order-independent', () => {
    const forward = replay(['2026-03-01', '2026-03-02', '2026-03-03']);
    const shuffled = replay(['2026-03-03', '2026-03-01', '2026-03-02']);
    expect(shuffled.current).toBe(forward.current);
    expect(shuffled.longest).toBe(forward.longest);
  });

  it('folds a long run', () => {
    const dates = Array.from({ length: 10 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`);
    expect(replay(dates).current).toBe(10);
  });
});

describe('nudges', () => {
  it('reports how far the next tier is', () => {
    expect(daysToNextTier(0)).toEqual({ days: 3, multiplier: 1.1 });
    expect(daysToNextTier(2)).toEqual({ days: 1, multiplier: 1.1 });
    expect(daysToNextTier(3)).toEqual({ days: 4, multiplier: 1.25 });
    expect(daysToNextTier(30)).toBeNull();
  });

  it('reports the day the streak must be kept alive by', () => {
    expect(deadlineFor({ ...emptyStreak(), lastQualifiedDate: '2026-03-08' })).toBe('2026-03-09');
    expect(deadlineFor(emptyStreak())).toBeNull();
  });
});

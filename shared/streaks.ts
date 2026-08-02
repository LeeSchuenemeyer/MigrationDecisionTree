/**
 * Streak state machine.
 *
 * Pure, because this is the part of the points economy kids will scrutinise
 * hardest and the part that is easiest to get subtly wrong. Every transition
 * below is pinned by a test.
 *
 * A streak counts *qualifying days*, not completions. Finishing four chores on
 * Tuesday is still one day — otherwise a single busy afternoon would buy a
 * week-long multiplier and the whole thing stops meaning anything.
 */

import { addLocalDays, daysBetween, type LocalDate } from './time.js';
import { streakMultiplier } from './points.js';

export interface StreakState {
  current: number;
  longest: number;
  /** The last local date that counted toward this streak. */
  lastQualifiedDate: LocalDate | null;
  /**
   * Grace days. A streak is a motivator, not a punishment — one missed day
   * after a fortnight of effort should sting, not erase the fortnight.
   */
  freezesRemaining: number;
}

export interface StreakOutcome {
  state: StreakState;
  /** What changed, so the caller knows whether to write a feed item. */
  event: 'started' | 'extended' | 'froze' | 'broken' | 'unchanged';
  /** Multiplier that now applies to awards. */
  multiplier: number;
}

export const DEFAULT_FREEZES = 2;

export function emptyStreak(freezes = DEFAULT_FREEZES): StreakState {
  return { current: 0, longest: 0, lastQualifiedDate: null, freezesRemaining: freezes };
}

/**
 * Record that `date` qualified.
 *
 * The gap rules:
 *   same day  → unchanged (double-qualifying must not inflate the count)
 *   +1 day    → extend
 *   +2 days   → one missed day: burn a freeze if there is one, else break
 *   +3 days   → too far gone to paper over; break
 *   backwards → ignored, so replaying history out of order cannot corrupt state
 */
export function recordQualifyingDay(state: StreakState, date: LocalDate): StreakOutcome {
  if (state.lastQualifiedDate === null) {
    const next: StreakState = {
      current: 1,
      longest: Math.max(1, state.longest),
      lastQualifiedDate: date,
      freezesRemaining: state.freezesRemaining,
    };
    return { state: next, event: 'started', multiplier: streakMultiplier(next.current) };
  }

  const gap = daysBetween(state.lastQualifiedDate, date);

  // Same day, or an out-of-order replay. Either way, nothing moves.
  if (gap <= 0) {
    return { state, event: 'unchanged', multiplier: streakMultiplier(state.current) };
  }

  if (gap === 1) {
    const current = state.current + 1;
    const next: StreakState = {
      current,
      longest: Math.max(state.longest, current),
      lastQualifiedDate: date,
      freezesRemaining: state.freezesRemaining,
    };
    return { state: next, event: 'extended', multiplier: streakMultiplier(current) };
  }

  if (gap === 2 && state.freezesRemaining > 0) {
    const current = state.current + 1;
    const next: StreakState = {
      current,
      longest: Math.max(state.longest, current),
      lastQualifiedDate: date,
      freezesRemaining: state.freezesRemaining - 1,
    };
    return { state: next, event: 'froze', multiplier: streakMultiplier(current) };
  }

  // Broken. Today still counts as day one — a broken streak should restart
  // immediately, not sit at zero until tomorrow.
  const next: StreakState = {
    current: 1,
    longest: state.longest,
    lastQualifiedDate: date,
    freezesRemaining: state.freezesRemaining,
  };
  return { state: next, event: 'broken', multiplier: streakMultiplier(1) };
}

/**
 * Whether a streak is still alive as of `today`, without mutating it.
 *
 * Used for display: a streak whose last qualifying day was three days ago is
 * already dead and must not still be showing a 1.5× multiplier on the board.
 */
export function isAlive(state: StreakState, today: LocalDate): boolean {
  if (state.lastQualifiedDate === null || state.current === 0) return false;
  const gap = daysBetween(state.lastQualifiedDate, today);
  if (gap <= 1) return true;
  return gap === 2 && state.freezesRemaining > 0;
}

/** The multiplier that actually applies right now — 1 if the streak has lapsed. */
export function effectiveMultiplier(state: StreakState, today: LocalDate): number {
  return isAlive(state, today) ? streakMultiplier(state.current) : 1;
}

/** Display length — zero once lapsed, so the board never overstates a streak. */
export function effectiveLength(state: StreakState, today: LocalDate): number {
  return isAlive(state, today) ? state.current : 0;
}

/**
 * Fold a run of qualifying dates in one go. Used by the seed script and by the
 * nightly reconciler; order-independent because out-of-order dates are ignored.
 */
export function replay(dates: LocalDate[], freezes = DEFAULT_FREEZES): StreakState {
  let state = emptyStreak(freezes);
  for (const d of [...dates].sort()) {
    state = recordQualifyingDay(state, d).state;
  }
  return state;
}

/** Days until the next multiplier tier, for the "2 more days" nudge. */
export function daysToNextTier(current: number): { days: number; multiplier: number } | null {
  const tiers = [3, 7, 30];
  for (const t of tiers) {
    if (current < t) return { days: t - current, multiplier: streakMultiplier(t) };
  }
  return null;
}

/** Tomorrow, for messaging like "keep it alive by Tuesday". */
export function deadlineFor(state: StreakState): LocalDate | null {
  return state.lastQualifiedDate ? addLocalDays(state.lastQualifiedDate, 1) : null;
}

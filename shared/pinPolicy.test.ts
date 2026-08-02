import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_WINDOW_MS,
  LOCKOUT_MS,
  MAX_ATTEMPTS,
  checkLockout,
  registerFailure,
  sessionLifetimeMs,
  validatePin,
  type AttemptState,
} from './pinPolicy.js';

const YEAR = 2026;
const ctx = { currentYear: YEAR };

describe('PIN validation', () => {
  it('accepts a reasonable PIN', () => {
    expect(validatePin('4816', ctx)).toEqual({ ok: true });
    expect(validatePin('7391', ctx)).toEqual({ ok: true });
  });

  it('requires exactly four digits', () => {
    for (const bad of ['123', '12345', 'abcd', '12a4', '', ' 123', '12.4']) {
      const r = validatePin(bad, ctx);
      expect(r.ok, `expected ${JSON.stringify(bad)} to be rejected`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('format');
    }
  });

  it('rejects the PINs a sibling guesses first', () => {
    for (const bad of ['0000', '1234', '1111', '4321', '2580', '6969']) {
      const r = validatePin(bad, ctx);
      expect(r.ok, `expected ${bad} to be denylisted`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('denylisted');
    }
  });

  it('rejects plausible years, including birth years', () => {
    for (const year of ['2026', '2025', '2027', '1990', '2014', '1975']) {
      const r = validatePin(year, ctx);
      expect(r.ok, `expected ${year} to be rejected as a year`).toBe(false);
      if (!r.ok) expect(r.reason).toBe('year');
    }
  });

  it('allows numbers below the birth-year window', () => {
    // 1900 is exactly currentYear - 126, outside the rejected span.
    expect(validatePin('0847', ctx)).toEqual({ ok: true });
  });

  it('rejects a PIN another family member already uses', () => {
    const r = validatePin('4816', { ...ctx, existingPins: ['9142', '4816'] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('duplicate');
  });

  it('allows a PIN when the household uses different ones', () => {
    expect(validatePin('4816', { ...ctx, existingPins: ['9142', '3078'] })).toEqual({ ok: true });
  });
});

describe('lockout state machine', () => {
  const t0 = 1_700_000_000_000;

  it('permits a login with no prior failures', () => {
    const d = checkLockout(null, t0);
    expect(d.locked).toBe(false);
    expect(d.next.count).toBe(0);
  });

  it('locks on the Nth failure and not before', () => {
    let state: AttemptState | null = null;
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const d = registerFailure(state, t0 + i * 1000);
      expect(d.locked, `attempt ${i} should not lock`).toBe(false);
      expect(d.justLocked).toBe(false);
      expect(d.next.count).toBe(i);
      state = d.next;
    }

    const final = registerFailure(state, t0 + MAX_ATTEMPTS * 1000);
    expect(final.locked).toBe(true);
    expect(final.justLocked).toBe(true);
    expect(final.next.lockedUntilMs).toBe(t0 + MAX_ATTEMPTS * 1000 + LOCKOUT_MS);
  });

  it('reports justLocked exactly once, so the feed item is written once', () => {
    let state: AttemptState | null = null;
    let justLockedCount = 0;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const d = registerFailure(state, t0 + i * 1000);
      if (d.justLocked) justLockedCount++;
      state = d.next;
    }
    expect(justLockedCount).toBe(1);

    // A further check while locked must not re-fire it.
    const during = checkLockout(state, t0 + MAX_ATTEMPTS * 1000 + 1000);
    expect(during.locked).toBe(true);
    expect(during.justLocked).toBe(false);
  });

  it('keeps rejecting while locked, then allows through afterwards', () => {
    const lockedUntilMs = t0 + LOCKOUT_MS;
    const state: AttemptState = { count: 0, firstFailAtMs: t0, lockedUntilMs };

    const during = checkLockout(state, t0 + 60_000);
    expect(during.locked).toBe(true);
    expect(during.retryAfterSeconds).toBe(Math.ceil((lockedUntilMs - (t0 + 60_000)) / 1000));

    const after = checkLockout(state, lockedUntilMs + 1);
    expect(after.locked).toBe(false);
  });

  it('starts a fresh window once the old one lapses, instead of accumulating forever', () => {
    const stale: AttemptState = { count: 4, firstFailAtMs: t0, lockedUntilMs: null };
    const d = registerFailure(stale, t0 + ATTEMPT_WINDOW_MS + 1);
    expect(d.locked).toBe(false);
    expect(d.next.count).toBe(1);
  });

  it('accumulates inside the window', () => {
    const recent: AttemptState = { count: 2, firstFailAtMs: t0, lockedUntilMs: null };
    const d = registerFailure(recent, t0 + ATTEMPT_WINDOW_MS - 1);
    expect(d.next.count).toBe(3);
    expect(d.next.firstFailAtMs).toBe(t0);
  });
});

describe('session lifetimes', () => {
  it('gives the kiosk a short session and personal devices a long one', () => {
    expect(sessionLifetimeMs('kiosk')).toBe(10 * 60 * 1000);
    expect(sessionLifetimeMs('personal')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(sessionLifetimeMs('kiosk')).toBeLessThan(sessionLifetimeMs('personal'));
  });
});

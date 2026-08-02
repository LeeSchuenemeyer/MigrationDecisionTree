/**
 * PIN policy — pure, so it can be enforced identically on both sides and
 * tested without infrastructure.
 *
 * Be honest about the ceiling: a 4-digit PIN has 10,000 possibilities and no
 * hash function makes that meaningfully hard offline. The hash protects
 * against a casual storage dump. The load-bearing control is the online
 * attempt limiter, and the most *effective* control is social — a lockout
 * writes a visible feed item, and in a household that deters better than any
 * cryptographic measure.
 *
 * So this module's job is modest and specific: keep people off the PINs a
 * sibling would guess in three tries, and stop two members sharing one.
 */

export const PIN_LENGTH = 4;

/** Attempts allowed inside the window before the account locks. */
export const MAX_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

/** Session lifetimes, by device kind. */
export const KIOSK_SESSION_MS = 10 * 60 * 1000;
export const PERSONAL_SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEVICE_TOKEN_MS = 365 * 24 * 60 * 60 * 1000;

/** How long a step-up stays valid before a destructive action re-prompts. */
export const ELEVATION_MS = 5 * 60 * 1000;

/** Idle timeout before the kiosk drops back to ambient mode. */
export const KIOSK_IDLE_MS = 60 * 1000;

/**
 * PINs a motivated sibling tries first. Deliberately short — a long denylist
 * mostly frustrates people into writing the PIN down, which is worse.
 */
const DENYLIST = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '2345', '3456', '4567', '5678', '6789', '0123',
  '1122', '1212', '2121', '1313', '6969', '0007', '2580', '1379', '1004',
]);

export type PinRejection =
  | { ok: false; reason: 'format'; message: string }
  | { ok: false; reason: 'denylisted'; message: string }
  | { ok: false; reason: 'year'; message: string }
  | { ok: false; reason: 'duplicate'; message: string };

export type PinCheck = { ok: true } | PinRejection;

export interface PinPolicyContext {
  /** Current year, so "this year" and recent birth years are rejected. */
  currentYear: number;
  /**
   * PINs already in use in this household. Collisions are far likelier than
   * attacks here, and two members sharing a PIN quietly breaks attribution:
   * points would land on whoever tapped the avatar, not whoever typed.
   */
  existingPins?: string[];
}

export function validatePin(pin: string, ctx: PinPolicyContext): PinCheck {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
    return {
      ok: false,
      reason: 'format',
      message: `Your PIN needs to be exactly ${PIN_LENGTH} digits.`,
    };
  }

  if (DENYLIST.has(pin)) {
    return {
      ok: false,
      reason: 'denylisted',
      message: 'That PIN is too easy to guess. Pick another one.',
    };
  }

  // Reject plausible years: this year forward a little, and back far enough to
  // cover every family member's birth year.
  const asNumber = Number(pin);
  if (asNumber >= ctx.currentYear - 100 && asNumber <= ctx.currentYear + 1) {
    return {
      ok: false,
      reason: 'year',
      message: 'That looks like a year. Pick something harder to guess.',
    };
  }

  if (ctx.existingPins?.includes(pin)) {
    return {
      ok: false,
      reason: 'duplicate',
      message: 'Somebody in the family already uses that PIN. Pick another one.',
    };
  }

  return { ok: true };
}

/** Lockout state derived from the stored attempt counter. */
export interface AttemptState {
  count: number;
  firstFailAtMs: number;
  lockedUntilMs: number | null;
}

export interface AttemptDecision {
  locked: boolean;
  retryAfterSeconds: number;
  /** Set on the transition into lockout, so the feed item is written once. */
  justLocked: boolean;
  next: AttemptState;
}

/** Whether a login may proceed right now. */
export function checkLockout(state: AttemptState | null, nowMs: number): AttemptDecision {
  if (state?.lockedUntilMs && state.lockedUntilMs > nowMs) {
    return {
      locked: true,
      retryAfterSeconds: Math.ceil((state.lockedUntilMs - nowMs) / 1000),
      justLocked: false,
      next: state,
    };
  }
  return {
    locked: false,
    retryAfterSeconds: 0,
    justLocked: false,
    next: state ?? { count: 0, firstFailAtMs: nowMs, lockedUntilMs: null },
  };
}

/** Fold a failed attempt into the counter, locking once the limit is reached. */
export function registerFailure(state: AttemptState | null, nowMs: number): AttemptDecision {
  // A stale window starts over rather than accumulating forever.
  const withinWindow = state !== null && nowMs - state.firstFailAtMs < ATTEMPT_WINDOW_MS;
  const count = (withinWindow ? state.count : 0) + 1;
  const firstFailAtMs = withinWindow ? state.firstFailAtMs : nowMs;

  if (count >= MAX_ATTEMPTS) {
    const lockedUntilMs = nowMs + LOCKOUT_MS;
    return {
      locked: true,
      retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000),
      justLocked: true,
      // Counter resets so the next window starts clean after the lock expires.
      next: { count: 0, firstFailAtMs: nowMs, lockedUntilMs },
    };
  }

  return {
    locked: false,
    retryAfterSeconds: 0,
    justLocked: false,
    next: { count, firstFailAtMs, lockedUntilMs: null },
  };
}

export function sessionLifetimeMs(deviceKind: 'kiosk' | 'personal'): number {
  return deviceKind === 'kiosk' ? KIOSK_SESSION_MS : PERSONAL_SESSION_MS;
}

import { useEffect, useState } from 'react';

/**
 * The three things that make an unattended wall tablet survivable.
 *
 * None of this is polish. A display that sleeps, burns in, or blinds the
 * kitchen at 2am is a display the family unmounts — and every one of these
 * failures takes weeks to show up, so they are cheaper to write now than to
 * diagnose later.
 *
 * All of it is kiosk-only. On a phone, holding the screen awake drains a
 * battery and dimming the display fights the OS.
 */

// ---------------------------------------------------------------------------
// Wake lock
// ---------------------------------------------------------------------------

/**
 * Hold the screen on.
 *
 * The sentinel is released by the browser whenever the page is hidden — every
 * tab switch, every screen-off — and it is NOT re-acquired automatically. A
 * `visibilitychange` re-acquire is therefore not defensive coding; without it
 * the lock survives exactly until the first interruption and then never again.
 *
 * `navigator.wakeLock` is Chromium 84+, so it is present on both the Chromium
 * 108 floor and every Android tablet in scope. It still fails at runtime for
 * reasons that have nothing to do with support — a backgrounded page, a
 * battery-saver mode, an insecure origin — so every call is guarded and a
 * failure is silent. Fully Kiosk Browser holds the screen on at the OS level
 * anyway; this is the belt to its braces.
 */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;

    const nav = navigator as Navigator & {
      wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
    };
    if (!nav.wakeLock) return;

    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        sentinel = await nav.wakeLock!.request('screen');
        // Released for us, or by us. Either way the reference is now stale.
        sentinel.addEventListener?.('release', () => {
          sentinel = null;
        });
      } catch {
        // Denied. Nothing to tell anyone — there is no user action that helps.
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !sentinel) void acquire();
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release?.().catch(() => {});
    };
  }, [enabled]);
}

interface WakeLockSentinelLike {
  release?: () => Promise<void>;
  addEventListener?: (type: 'release', listener: () => void) => void;
}

// ---------------------------------------------------------------------------
// Night dim
// ---------------------------------------------------------------------------

const NIGHT_START_HOUR = 22;
const NIGHT_END_HOUR = 6;

export function isNightAt(date: Date): boolean {
  const h = date.getHours();
  // The window wraps midnight, so this is an OR, not the range check that
  // reads more naturally and is wrong for every hour after 00:00.
  return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
}

/**
 * Dim the display overnight by setting `data-night` on <html>; the actual
 * brightness change is one CSS rule in globals.css.
 *
 * Checked every minute rather than scheduled for the exact boundary: a tablet
 * that has been awake for three months has drifted, been suspended, and crossed
 * a DST boundary twice, and a `setTimeout` aimed at 22:00 tomorrow survives none
 * of that. A minute of latency on a slow fade nobody is watching costs nothing.
 */
export function useNightDim(enabled: boolean): void {
  useEffect(() => {
    const root = document.documentElement;

    if (!enabled) {
      delete root.dataset['night'];
      return;
    }

    const apply = () => {
      const night = isNightAt(new Date());
      if (night) root.dataset['night'] = 'true';
      else delete root.dataset['night'];
    };

    apply();
    const timer = setInterval(apply, 60_000);
    return () => {
      clearInterval(timer);
      delete root.dataset['night'];
    };
  }, [enabled]);
}

// ---------------------------------------------------------------------------
// Burn-in drift
// ---------------------------------------------------------------------------

const DRIFT_PERIOD_MS = 60_000;
/**
 * Four pixels of travel, one pixel a minute, cycling every four minutes.
 *
 * Small enough that nobody perceives it and no layout reflows; large enough
 * that a static element never sits on the same subpixel for months. OLED is the
 * acute case — the StanbyME 2 is one — but a permanently-lit LCD ghosts too.
 */
const DRIFT_STEPS = [0, 1, 2, 1] as const;

export function useBurnInDrift(enabled: boolean): { x: number; y: number } {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setStep((s) => (s + 1) % DRIFT_STEPS.length), DRIFT_PERIOD_MS);
    return () => clearInterval(timer);
  }, [enabled]);

  if (!enabled) return { x: 0, y: 0 };

  // Offset x and y out of phase so the path is a square rather than a diagonal,
  // which covers twice as many pixels for the same maximum displacement.
  return {
    x: DRIFT_STEPS[step] ?? 0,
    y: DRIFT_STEPS[(step + 1) % DRIFT_STEPS.length] ?? 0,
  };
}

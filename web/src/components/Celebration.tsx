import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TickerItem } from '@shared/types';
import { useTicker } from '@/lib/pulse';
import { usePrefersReducedMotion } from '@/lib/motion';

/**
 * The badge moment.
 *
 * A kid crosses a threshold and something has to happen on the wall — that is
 * the entire pitch of the points system, and a badge that only appears in a
 * list nobody scrolls to is not a reward.
 *
 * Driven off the ticker rather than a dedicated query. The feed already carries
 * achievement rows, the ticker already refetches when the feed counter moves,
 * and the kiosk has no session to ask "whose badge is this?" with. One less
 * poll, and the celebration cannot disagree with what the ticker says.
 */

const HOLD_MS = 9000;

export function Celebration(): ReactNode {
  const item = useNewestAchievement();
  const reduced = usePrefersReducedMotion();
  const [showing, setShowing] = useState<TickerItem | null>(null);

  useEffect(() => {
    if (!item) return;
    setShowing(item);
    const timer = setTimeout(() => setShowing(null), HOLD_MS);
    return () => clearTimeout(timer);
  }, [item]);

  if (!showing) return null;

  return (
    <div
      // `alert`, not `status`: this interrupts, and on the surface where it
      // matters there is no other announcement of it.
      role="alert"
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-6"
    >
      <div
        className={[
          'border-brand bg-panel flex max-w-lg flex-col items-center gap-3 rounded-2xl border-2 px-8 py-7 text-center shadow-2xl kiosk:max-w-2xl kiosk:gap-5 kiosk:px-14 kiosk:py-12',
          // The animation is dropped entirely under reduced motion — the panel
          // still appears, still holds, still announces. What goes away is the
          // movement, not the information.
          reduced ? '' : 'fd-celebrate',
        ].join(' ')}
      >
        <span aria-hidden="true" className="text-5xl kiosk:text-8xl">
          {showing.icon ?? '🏆'}
        </span>
        <span className="font-display text-brand text-xs tracking-[0.2em] uppercase kiosk:text-lg">
          Achievement unlocked
        </span>
        <span className="text-lg leading-snug kiosk:text-4xl">{showing.text}</span>
        {showing.detail && (
          <span className="text-ink-dim text-sm kiosk:text-xl">{showing.detail}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The newest achievement line, but only once it is genuinely new.
 *
 * The first ticker payload after a page load is full of history, and firing on
 * that would mean a wall tablet throwing confetti for a badge earned last
 * Tuesday every time it reloaded. So the first payload establishes a baseline
 * and returns nothing — the same shape as the pulse baseline, for the same
 * reason.
 */
function useNewestAchievement(): TickerItem | null {
  const ticker = useTicker();
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<TickerItem | null>(null);

  useEffect(() => {
    const items = ticker.data;
    if (!items) return;

    const achievements = items.filter((i) => i.kind === 'achievement');

    if (seen.current === null) {
      seen.current = new Set(achievements.map((i) => i.id));
      return;
    }

    // Newest-first, so the first unseen one is the one to celebrate. If two
    // landed in the same 10-second poll, the older is silently absorbed —
    // stacking two overlays on a wall is worse than missing one.
    const next = achievements.find((i) => !seen.current!.has(i.id));
    for (const i of achievements) seen.current.add(i.id);

    if (next) setFresh(next);
  }, [ticker.data]);

  return fresh;
}

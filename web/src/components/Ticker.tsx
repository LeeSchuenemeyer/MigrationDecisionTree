import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { TickerItem } from '@shared/types';
import { useTicker } from '@/lib/pulse';
import { useSuppressFeedItem } from '@/lib/claude';
import { usePrefersReducedMotion } from '@/lib/motion';
import { useSession } from '@/lib/session';

/**
 * The marquee along the bottom of the wall display.
 *
 * Two genuinely different presentations, not one with an animation disabled:
 *
 *   Scrolling — the default. A continuous belt, duplicated once so the loop has
 *   no visible seam. Speed is derived from content length so a busy day does
 *   not scroll faster than anyone can read.
 *
 *   Rotating — for `prefers-reduced-motion`. One item at a time, swapped on a
 *   timer with no movement at all. This is not a degraded fallback: for anyone
 *   with vestibular sensitivity a horizontally scrolling strip in their
 *   peripheral vision all day is genuinely unpleasant, and a kitchen display is
 *   unavoidable in a way a web page is not.
 *
 * The strip is `aria-live="off"` on purpose. A screen reader announcing every
 * chore that scrolls past would be unusable; the same content is available as a
 * static list on the Board and Points screens.
 */
export function Ticker(): ReactNode {
  const ticker = useTicker();
  const reduced = usePrefersReducedMotion();
  const session = useSession();
  const suppress = useSuppressFeedItem();
  const items = ticker.data ?? [];

  // The "that wasn't ok" control is parent-only and appears on hover/long-press
  // rather than permanently: a dismiss button on every line would invite a kid
  // to quietly delete anything they did not like about the day.
  const canSuppress = session.data?.member?.role === 'parent';
  const onSuppress = canSuppress
    ? (item: TickerItem) => {
        if (!item.id.startsWith('feed:')) return;
        suppress.mutate({ id: item.id.slice('feed:'.length) });
      }
    : undefined;

  if (items.length === 0) {
    return (
      <div className="border-line bg-panel text-ink-faint flex h-12 items-center border-t px-5 text-sm kiosk:h-16 kiosk:text-lg">
        {ticker.isPending ? 'Loading…' : 'Quiet so far today.'}
      </div>
    );
  }

  return reduced ? (
    <RotatingTicker items={items} onSuppress={onSuppress} />
  ) : (
    <ScrollingTicker items={items} onSuppress={onSuppress} />
  );
}

function ScrollingTicker({
  items,
  onSuppress,
}: {
  items: TickerItem[];
  onSuppress?: (item: TickerItem) => void;
}): ReactNode {
  // Roughly 55px per second reads comfortably at across-the-room distance.
  // Estimated from character count rather than measured, because measuring
  // would mean a layout read on every poll for a number that only needs to be
  // approximately right.
  const seconds = useMemo(() => {
    const chars = items.reduce((n, i) => n + i.text.length + 12, 0);
    return Math.max(30, Math.round((chars * 9) / 55));
  }, [items]);

  return (
    <div
      className="border-line bg-panel relative flex h-12 items-center overflow-hidden border-t kiosk:h-16"
      aria-live="off"
    >
      <div
        className="flex shrink-0 items-center whitespace-nowrap will-change-transform"
        style={{ animation: `fd-ticker ${seconds}s linear infinite` }}
      >
        {/* Duplicated so the belt wraps seamlessly: by the time the first copy
            has scrolled fully off, the second is exactly where it started. */}
        {items.map((item) => (
          <TickerLine key={item.id} item={item} onSuppress={onSuppress} />
        ))}
        {items.map((item) => (
          <TickerLine key={`${item.id}:dup`} item={item} ariaHidden />
        ))}
      </div>
    </div>
  );
}

function RotatingTicker({
  items,
  onSuppress,
}: {
  items: TickerItem[];
  onSuppress?: (item: TickerItem) => void;
}): ReactNode {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    const timer = setInterval(() => setIndex((i) => (i + 1) % items.length), 7000);
    return () => clearInterval(timer);
  }, [items]);

  const item = items[index % items.length];

  return (
    <div
      className="border-line bg-panel flex h-12 items-center overflow-hidden border-t px-5 kiosk:h-16"
      aria-live="off"
    >
      {item && <TickerLine item={item} flush onSuppress={onSuppress} />}
    </div>
  );
}

function TickerLine({
  item,
  ariaHidden,
  flush,
  onSuppress,
}: {
  item: TickerItem;
  ariaHidden?: boolean;
  flush?: boolean;
  onSuppress?: (item: TickerItem) => void;
}): ReactNode {
  const labelColor =
    item.source === 'overdue'
      ? 'text-overdue'
      : item.source === 'upcoming'
        ? 'text-pending'
        : 'text-brand';

  return (
    <span
      aria-hidden={ariaHidden || undefined}
      className={[
        'flex items-center gap-2 text-sm kiosk:gap-3 kiosk:text-xl',
        flush ? '' : 'px-6 kiosk:px-10',
      ].join(' ')}
    >
      {item.icon && (
        <span aria-hidden="true" className="text-base kiosk:text-2xl">
          {item.icon}
        </span>
      )}

      {/* Labelling Claude's lines is a product decision, not decoration: on a
          kitchen wall it must always be obvious which words a machine wrote. */}
      {item.label && (
        <span
          className={[
            'font-display text-[10px] tracking-[0.14em] uppercase kiosk:text-sm',
            labelColor,
          ].join(' ')}
        >
          {item.label}
        </span>
      )}

      <span className={item.source === 'overdue' ? 'text-overdue' : 'text-ink'}>{item.text}</span>

      {item.points !== null && item.points !== 0 && (
        <span className="text-brand font-mono tabular-nums">
          {item.points > 0 ? '+' : ''}
          {item.points}
        </span>
      )}

      {/* Only offered on Claude-written lines: a parent has no reason to
          suppress the plain fact that a chore was finished. */}
      {onSuppress && !ariaHidden && item.label === 'Claude' && (
        <button
          type="button"
          onClick={() => onSuppress(item)}
          title="That wasn’t ok — take it down"
          aria-label="Remove this line"
          className="border-line text-ink-faint hover:border-overdue hover:text-overdue ml-1 rounded-full border px-2 text-[10px] leading-5 transition-colors kiosk:text-sm"
        >
          ✕
        </button>
      )}

      <span aria-hidden="true" className="text-ink-faint px-1">
        ·
      </span>
    </span>
  );
}

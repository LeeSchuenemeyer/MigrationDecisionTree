import type { ReactNode } from 'react';
import { useQueue, useResolveQueueItem } from '@/lib/tasks';
import { useSession } from '@/lib/session';

/**
 * The approvals queue.
 *
 * Task approvals and reward redemptions share one queue deliberately — a
 * parent gets one badge, one screen, one habit, instead of two places to
 * remember to check.
 *
 * Every row renders from a single query with no fan-out, because the member
 * name, avatar, title, and points are denormalized onto the queue row at write
 * time. That is the whole reason this screen is fast.
 */
export function Queue(): ReactNode {
  const session = useSession();
  const queue = useQueue();
  const resolve = useResolveQueueItem();

  const isParent = session.data?.member?.role === 'parent';
  const items = queue.data ?? [];

  return (
    <section className="flex h-full min-h-0 flex-col gap-3 p-4 kiosk:p-6">
      <h2 className="font-display text-ink-dim flex items-baseline justify-between text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        Waiting on a parent
        <span className="text-ink-faint font-mono text-xs tracking-normal kiosk:text-base">
          {items.length === 0 ? 'all clear' : `${items.length} waiting`}
        </span>
      </h2>

      {queue.isPending && <p className="text-ink-faint text-sm">Loading…</p>}

      {!queue.isPending && items.length === 0 && (
        <p className="text-ink-faint py-4 text-sm italic">
          Nothing waiting. Chores land here once somebody ticks them off.
        </p>
      )}

      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        {items.map((item) => (
          <div
            key={item.id}
            className="border-line border-l-pending bg-panel grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border border-l-[3px] p-3"
          >
            <span className="text-2xl kiosk:text-4xl" aria-hidden="true">
              {item.memberAvatar}
            </span>

            <span className="min-w-0">
              <span className="block truncate kiosk:text-2xl">
                <strong>{item.memberName}</strong> — {item.title}
              </span>
              <span className="text-ink-faint block font-mono text-xs kiosk:text-base">
                +{item.points} points
                {item.kind === 'redemption' ? ' · reward' : ''}
              </span>
            </span>

            {isParent ? (
              <span className="flex gap-2">
                <button
                  type="button"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ id: item.id, action: 'reject' })}
                  className="border-line text-ink-dim hover:text-ink min-h-touch kiosk:min-h-touch-kiosk font-display rounded-full border px-4 text-xs tracking-[0.12em] uppercase disabled:opacity-50"
                >
                  Send back
                </button>
                <button
                  type="button"
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate({ id: item.id, action: 'approve' })}
                  className="border-approved bg-approved/15 text-approved hover:bg-approved hover:text-ground min-h-touch kiosk:min-h-touch-kiosk font-display rounded-full border px-5 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-50"
                >
                  Approve
                </button>
              </span>
            ) : (
              <span className="text-ink-faint font-display text-xs tracking-[0.12em] uppercase">
                Parent only
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

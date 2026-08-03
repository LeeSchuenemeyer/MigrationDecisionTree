import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { TickerItem } from '@shared/types';
import { api } from './api';
import { membersKey, sessionKey } from './session';
import { queueKey } from './tasks';
import { leaderboardKey, rewardsKey } from './points';

/**
 * The single poll.
 *
 * Every other query in the app is `staleTime: Infinity` and never refetches on
 * its own. This one endpoint runs on an interval, and what it returns decides
 * which of them gets invalidated. Six independent `refetchInterval`s on a
 * tablet that is awake 24 hours a day is the difference between ~40 MB/month
 * and blowing through the SWA Free bandwidth cap.
 *
 * The server sends per-slice counters and we diff them here, rather than asking
 * it "what changed since rev N" — it has no history to answer that with, and
 * the approximation it would have to make invalidates everything forever after
 * the first write.
 */

const POLL_MS = 10_000;

type Slice = 'members' | 'tasks' | 'queue' | 'points' | 'feed' | 'events' | 'rewards';

export interface PulseResponse {
  rev: number;
  slices: Record<Slice, number>;
  today: string;
  serverTime: string;
}

export const pulseKey = ['pulse'] as const;
export const tickerKey = ['ticker'] as const;

/** Which query keys each slice owns. One place, so nothing drifts. */
const INVALIDATES: Record<Slice, readonly unknown[][]> = {
  members: [[...membersKey], [...leaderboardKey], [...sessionKey]],
  tasks: [['tasks'], [...tickerKey]],
  queue: [[...queueKey]],
  points: [[...leaderboardKey], ['points'], [...membersKey]],
  feed: [[...tickerKey]],
  events: [['events']],
  rewards: [[...rewardsKey]],
};

/**
 * Poll, diff, invalidate.
 *
 * Mounted once, in the shell. Returns nothing — its whole job is the side
 * effect, and having components read from it would tempt someone into
 * rendering off the counter rather than off the data.
 */
export function usePulse(enabled = true): void {
  const qc = useQueryClient();
  const previous = useRef<Record<Slice, number> | null>(null);

  const query = useQuery({
    queryKey: pulseKey,
    queryFn: () => api.get<PulseResponse>('/pulse'),
    refetchInterval: enabled ? POLL_MS : false,
    // The kiosk is never focused and never "stale" in the usual sense; the
    // interval is the only thing that should drive this.
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    enabled,
  });

  useEffect(() => {
    const slices = query.data?.slices;
    if (!slices) return;

    const before = previous.current;
    previous.current = slices;

    // First successful poll establishes the baseline. Invalidating here would
    // refetch everything on every page load for no reason — the data was just
    // fetched moments ago by the components that mounted.
    if (!before) return;

    for (const key of Object.keys(slices) as Slice[]) {
      if (before[key] === slices[key]) continue;
      for (const queryKey of INVALIDATES[key]) {
        void qc.invalidateQueries({ queryKey });
      }
    }
  }, [query.data, qc]);
}

/**
 * The ticker payload.
 *
 * Never polls on its own — `usePulse` invalidates it when the feed or task
 * counters move. The endpoint is ETagged, so even the refetch is usually a 304.
 */
export function useTicker() {
  return useQuery({
    queryKey: tickerKey,
    queryFn: async () => (await api.get<{ items: TickerItem[]; today: string }>('/feed')).items,
  });
}

/** Escape hatch for mutations that want an immediate refresh, not a poll away. */
export function refreshPulse(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: pulseKey });
}

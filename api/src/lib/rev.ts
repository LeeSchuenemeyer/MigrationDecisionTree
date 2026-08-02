import { CONFIG_ROWS, TABLES, configPK, configRK } from '../../../shared/keys.js';
import { env } from './env.js';
import { getEntity, upsert } from './tables.js';

/**
 * The household revision counter behind GET /api/pulse.
 *
 * The kiosk polls one tiny endpoint rather than putting a refetchInterval on
 * six queries. Each mutation bumps the global counter and the sub-counter for
 * the slice it touched; the client invalidates only what actually changed.
 * That is what keeps a 24/7 tablet at roughly 40 MB/month.
 */

export type RevSlice = 'members' | 'tasks' | 'queue' | 'points' | 'feed' | 'events' | 'rewards';

interface RevEntity {
  rev: number;
  members: number;
  tasks: number;
  queue: number;
  points: number;
  feed: number;
  events: number;
  rewards: number;
  /** Set when a feed item needs Claude commentary on the next cron tick. */
  commentaryDirty: boolean;
  updatedAt: string;
}

const EMPTY: RevEntity = {
  rev: 0,
  members: 0,
  tasks: 0,
  queue: 0,
  points: 0,
  feed: 0,
  events: 0,
  rewards: 0,
  commentaryDirty: false,
  updatedAt: new Date(0).toISOString(),
};

export async function readRev(): Promise<RevEntity> {
  const row = await getEntity<RevEntity>(
    TABLES.config,
    configPK(env.householdId),
    configRK(CONFIG_ROWS.rev),
  );
  return row ? { ...EMPTY, ...row } : EMPTY;
}

/**
 * Bump the global counter plus each named slice.
 *
 * Deliberately not ETag-guarded: a lost increment under concurrency costs at
 * most one extra poll cycle, and failing a user's mutation because two writes
 * raced on a *cache-invalidation counter* would be a much worse trade.
 */
export async function bumpRev(
  slices: RevSlice[],
  opts: { commentaryDirty?: boolean } = {},
): Promise<number> {
  const current = await readRev();
  const next: RevEntity = { ...current, rev: current.rev + 1, updatedAt: new Date().toISOString() };
  for (const s of slices) next[s] = current[s] + 1;
  if (opts.commentaryDirty !== undefined) next.commentaryDirty = opts.commentaryDirty;

  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.rev),
    ...next,
  });
  return next.rev;
}

/** Which slices changed since the client's last known revision. */
export function changedSlices(current: RevEntity, sinceRev: number): RevSlice[] {
  if (sinceRev >= current.rev) return [];
  // Without per-slice history we cannot diff precisely, so any bump since the
  // client's revision invalidates every slice whose counter is non-zero. The
  // pulse payload stays ~150 bytes either way.
  const all: RevSlice[] = ['members', 'tasks', 'queue', 'points', 'feed', 'events', 'rewards'];
  return all.filter((s) => current[s] > 0);
}

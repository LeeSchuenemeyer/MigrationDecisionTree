import { TABLES, feedPK, parseFeedRK } from '../../../shared/keys.js';
import {
  addLocalDays,
  formatLocalTime,
  localDateNow,
  localDateTimeMs,
  type LocalDate,
} from '../../../shared/time.js';
import type { FeedEntity, FeedItem, TaskInstance, TickerItem } from '../../../shared/types.js';
import { env } from '../lib/env.js';
import { listPartition } from '../lib/tables.js';
import { listTasksForDate } from './tasks.js';

/**
 * The activity feed and the ticker built on top of it.
 *
 * Reads only. Writes go through lib/feed.ts, which every service already calls;
 * splitting them keeps the write path free of any dependency on how the ticker
 * happens to present things today.
 */

const TICKER_LIMIT = 40;

/**
 * Storage row → wire shape.
 *
 * Every nullable field is coerced with `?? null`. Table Storage does not store
 * null properties — it omits them — so a field written as null comes back
 * `undefined`. Left uncoerced, the DTO's declared `string | null` is a lie,
 * `JSON.stringify` drops the key entirely, and any `=== null` comparison
 * downstream silently never matches.
 */
function toItem(row: FeedEntity & { rowKey: string }): FeedItem {
  return {
    id: row.rowKey,
    kind: row.kind,
    actorName: row.actorName ?? null,
    actorAvatar: row.actorAvatar ?? null,
    headline: row.headline,
    detail: row.detail ?? null,
    icon: row.icon ?? null,
    points: row.points ?? null,
    commentary: row.commentary ?? null,
    commentarySource: row.commentarySource ?? null,
    refType: row.refType ?? null,
    refId: row.refId ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * One line per thing, newest wins.
 *
 * A chore writes a feed item when it is ticked off and another when a parent
 * approves it. Both belong in the history — "done at 4, approved at 6" is a
 * real record — but in a marquee the earlier one is stale the moment the later
 * one exists, and showing "waiting on a parent" next to "cleared" for the same
 * chore just looks broken. Rows arrive newest-first, so keeping the first
 * occurrence keeps the current state.
 */
function collapseByRef(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter((i) => {
    if (!i.refType || !i.refId) return true;
    const key = `${i.refType}:${i.refId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One local day of activity, newest first.
 *
 * No sort: row keys are inverse ticks, so storage order is already the display
 * order. Suppressed items are dropped here rather than in the client — the
 * "that wasn't ok" button (Phase 5) has to work on a wall display nobody is
 * signed in to, so suppression cannot be a client-side concern.
 */
export async function listFeedForDate(date: LocalDate, limit = TICKER_LIMIT): Promise<FeedItem[]> {
  const rows = await listPartition<FeedEntity>(TABLES.feed, feedPK(env.householdId, date));
  return (rows as Array<FeedEntity & { rowKey: string }>)
    .filter((r) => !r.suppressed)
    .slice(0, limit)
    .map(toItem);
}

/**
 * Today's feed, backfilled from yesterday when today is quiet.
 *
 * A ticker that empties out at 6am and shows nothing until the first chore is
 * ticked off reads as broken rather than idle — and the wall display is at its
 * most visible first thing in the morning. Two point queries, worst case.
 */
export async function recentFeed(limit = TICKER_LIMIT): Promise<FeedItem[]> {
  const today = localDateNow(env.timezone);
  const items = await listFeedForDate(today, limit);
  if (items.length >= 6) return items;

  const yesterday = await listFeedForDate(addLocalDays(today, -1), limit);
  return [...items, ...yesterday].slice(0, limit);
}

/**
 * What the marquee shows.
 *
 * Three sources, interleaved rather than concatenated: activity that already
 * happened, deadlines that have not, and (from Phase 6) calendar events. The
 * mix is the product — a ticker of pure history is a log, and a ticker of pure
 * deadlines is a nag.
 */
export async function tickerItems(): Promise<TickerItem[]> {
  const today = localDateNow(env.timezone);
  const [feed, tasks] = await Promise.all([recentFeed(), listTasksForDate(today)]);

  const activity: TickerItem[] = collapseByRef(feed).map((f) => ({
    id: `feed:${f.id}`,
    source: 'activity',
    // Claude's line when there is one, the plain fact when there is not. The
    // ticker is complete either way, which is what makes the API optional.
    text: f.commentary ?? f.headline,
    detail: f.commentary ? f.headline : f.detail,
    icon: f.icon,
    points: f.points,
    label: f.commentarySource === 'claude' ? 'Claude' : null,
    at: f.createdAt,
  }));

  const upcoming = upcomingFromTasks(tasks, today);

  return interleave(activity, upcoming);
}

/**
 * Chores still open today that have a due time, soonest first.
 *
 * Overdue ones are included and marked — a deadline that has already slipped is
 * more worth saying out loud than one that has not.
 */
function upcomingFromTasks(tasks: TaskInstance[], today: LocalDate): TickerItem[] {
  const now = Date.now();

  return tasks
    .filter((t) => (t.status === 'open' || t.status === 'expired') && t.dueTimeLocal)
    .map((t) => {
      const dueMs = localDateTimeMs(today, t.dueTimeLocal!, env.timezone);
      return { task: t, dueMs };
    })
    .sort((a, b) => a.dueMs - b.dueMs)
    .slice(0, 8)
    .map(({ task, dueMs }) => ({
      id: `due:${task.id}`,
      source: dueMs < now ? ('overdue' as const) : ('upcoming' as const),
      text:
        dueMs < now
          ? `${task.title} was due at ${formatLocalTime(dueMs, env.timezone)}`
          : `${task.title} by ${formatLocalTime(dueMs, env.timezone)}`,
      detail: task.assignedMemberName,
      icon: task.icon,
      points: task.basePoints,
      label: dueMs < now ? 'Overdue' : 'Next',
      at: new Date(dueMs).toISOString(),
    }));
}

/**
 * Alternate between the two lists rather than running one then the other.
 *
 * A marquee is read in passing: whatever is on screen when someone walks by is
 * what they see. Concatenating means a family that had a busy morning never
 * sees a deadline, because forty activity items scroll past first.
 */
function interleave(a: TickerItem[], b: TickerItem[]): TickerItem[] {
  const out: TickerItem[] = [];
  const ratio = Math.max(1, Math.round(a.length / Math.max(1, b.length)));

  let ai = 0;
  let bi = 0;
  while (ai < a.length || bi < b.length) {
    for (let n = 0; n < ratio && ai < a.length; n++) out.push(a[ai++]!);
    if (bi < b.length) out.push(b[bi++]!);
  }
  return out;
}

export { parseFeedRK };

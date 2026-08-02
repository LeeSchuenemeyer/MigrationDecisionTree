import { randomUUID } from 'node:crypto';
import {
  ANY_MEMBER,
  TABLES,
  actionQueuePK,
  actionQueueRK,
  ledgerPK,
  ledgerRK,
  memberPK,
  memberRK,
  parseTaskInstanceRK,
  taskInstancePK,
  taskInstancePKRange,
} from '../../../shared/keys.js';
import { computeAward, describeBonus } from '../../../shared/points.js';
import {
  localDateNow,
  localDateTimeMs,
  yearMonthOfLocalDate,
  type LocalDate,
} from '../../../shared/time.js';
import type {
  Achievement,
  ActionQueueEntity,
  LedgerEntity,
  MemberEntity,
  QueueItem,
  TaskInstance,
  TaskInstanceEntity,
} from '../../../shared/types.js';
import { effectiveLength } from '../../../shared/streaks.js';
import { env } from '../lib/env.js';
import { TaskError } from '../lib/errors.js';
import { writeFeedItem } from '../lib/feed.js';
import { getMemberRow } from '../lib/members.js';
import { bumpRev } from '../lib/rev.js';
import {
  getEntity,
  listPartition,
  listPartitionRange,
  remove,
  updateWithRetry,
  upsert,
} from '../lib/tables.js';
import { evaluateStreak, readStreak } from './points.js';
import { evaluateAchievements, statsFor } from './achievements.js';

type InstanceRow = TaskInstanceEntity & { partitionKey: string; rowKey: string; etag: string };

/** Incremental achievement counters, carried on the member row. */
interface CounterFields {
  tasksCompleted?: number;
  categoriesJson?: string;
  earlyCompletions?: number;
  wildcardsClaimed?: number;
}

/**
 * Per-category tally, stored as JSON on the member row.
 *
 * Table Storage has no nested types, so a small map lives as a string. Kept
 * here rather than in a separate table because it is only ever read and
 * written alongside the row it belongs to.
 */
function bumpCategory(json: string | undefined, taskDefId: string): string {
  let map: Record<string, number> = {};
  try {
    map = json ? (JSON.parse(json) as Record<string, number>) : {};
  } catch {
    map = {};
  }
  map[taskDefId] = (map[taskDefId] ?? 0) + 1;
  return JSON.stringify(map);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function toInstance(row: InstanceRow, nowMs: number): TaskInstance {
  const dueMs = row.dueTimeLocal
    ? localDateTimeMs(row.dueDateLocal, row.dueTimeLocal, env.timezone)
    : null;

  return {
    id: row.rowKey,
    taskDefId: row.taskDefId,
    title: row.title,
    icon: row.icon,
    basePoints: row.basePoints,
    multiplier: row.multiplier,
    bonusReason: row.bonusReason,
    dueDateLocal: row.dueDateLocal,
    dueTimeLocal: row.dueTimeLocal,
    assignedMemberId: row.assignedMemberId,
    assignedMemberName: row.assignedMemberName,
    status: row.status,
    computedPoints: row.computedPoints ?? null,
    appliedStreakMultiplier: row.appliedStreakMultiplier ?? null,
    awardedPoints: row.awardedPoints,
    overdue: row.status === 'open' && dueMs !== null && dueMs < nowMs,
  };
}

/** One day = one point-partition query. This is the kiosk's primary view. */
export async function listTasksForDate(date: LocalDate): Promise<TaskInstance[]> {
  const rows = await listPartition<TaskInstanceEntity>(
    TABLES.taskInstances,
    taskInstancePK(env.householdId, date),
  );
  const now = Date.now();
  return (rows as InstanceRow[]).map((r) => toInstance(r, now)).sort(compareTasks);
}

/** A span = a partition-key RANGE query over N partitions, never a table scan. */
export async function listTasksBetween(from: LocalDate, to: LocalDate): Promise<TaskInstance[]> {
  const range = taskInstancePKRange(env.householdId, from, to);
  const rows = await listPartitionRange<TaskInstanceEntity>(
    TABLES.taskInstances,
    range.from,
    range.to,
  );
  const now = Date.now();
  return (rows as InstanceRow[]).map((r) => toInstance(r, now)).sort(compareTasks);
}

function compareTasks(a: TaskInstance, b: TaskInstance): number {
  if (a.dueDateLocal !== b.dueDateLocal) return a.dueDateLocal < b.dueDateLocal ? -1 : 1;
  const at = a.dueTimeLocal ?? '99:99';
  const bt = b.dueTimeLocal ?? '99:99';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.title.localeCompare(b.title);
}

async function getInstance(date: LocalDate, rowKey: string): Promise<InstanceRow | null> {
  return (await getEntity<TaskInstanceEntity>(
    TABLES.taskInstances,
    taskInstancePK(env.householdId, date),
    rowKey,
  )) as InstanceRow | null;
}

// ---------------------------------------------------------------------------
// Completing a chore
// ---------------------------------------------------------------------------

export { TaskError };

/**
 * Mark a chore done. It becomes `pending` and enters the parent queue.
 *
 * Points move into `pendingPoints`, never into the balance — a pending chore
 * must not affect the ranked leaderboard, or the standings would swing on work
 * nobody has confirmed.
 *
 * The award is computed **here**, once, and snapshotted onto the instance as
 * `computedPoints`. Approval then pays exactly that number rather than
 * recomputing it. Two reasons: the streak in force when the work was actually
 * done is the honest multiplier, and a recomputed award could differ from the
 * "+18 pending" the kid was shown, leaving `pendingPoints` permanently adrift.
 */
export async function completeTask(
  date: LocalDate,
  rowKey: string,
  actor: { id: string; displayName: string; avatarEmoji: string },
): Promise<TaskInstance> {
  const row = await getInstance(date, rowKey);
  if (!row) throw new TaskError('That chore is not on the board.', 404);

  if (row.status === 'pending' || row.status === 'approved') {
    // Idempotent: a double-tap on a laggy tablet is not an error.
    return toInstance(row, Date.now());
  }
  if (row.status !== 'open' && row.status !== 'expired') {
    throw new TaskError('That chore cannot be completed.', 409);
  }

  // An `anyone` chore is claimed by whoever taps it first.
  const claimed = row.assignedMemberId === ANY_MEMBER;
  if (!claimed && row.assignedMemberId !== actor.id) {
    throw new TaskError('That is somebody else’s chore.', 403);
  }

  const now = Date.now();

  // The streak as it stands *entering* today. Deliberately read before this
  // chore is recorded, so finishing the day's last chore does not retroactively
  // pay itself the tier it just unlocked — that tier applies from tomorrow.
  const streak = await readStreak(actor.id);
  const award = computeAward({
    basePoints: row.basePoints,
    wildcardMultiplier: row.multiplier,
    streakDays: effectiveLength(streak, row.dueDateLocal),
  });

  await upsert(TABLES.taskInstances, {
    partitionKey: row.partitionKey,
    rowKey: row.rowKey,
    status: 'pending',
    completedAt: new Date(now).toISOString(),
    completedBy: actor.id,
    computedPoints: award.total,
    appliedStreakMultiplier: award.streakMultiplier,
    ...(claimed ? { assignedMemberId: actor.id, assignedMemberName: actor.displayName } : {}),
  });

  // Pending points are visible but deliberately excluded from the ranked total.
  await updateWithRetry<MemberEntity>(
    TABLES.members,
    memberPK(env.householdId),
    memberRK(actor.id),
    (current) => ({
      partitionKey: current.partitionKey,
      rowKey: current.rowKey,
      pendingPoints: (current.pendingPoints ?? 0) + award.total,
    }),
  );

  const queueEntity: ActionQueueEntity & { partitionKey: string; rowKey: string } = {
    partitionKey: actionQueuePK(env.householdId),
    rowKey: actionQueueRK(now, 'task_approval', `${date}:${rowKey}`),
    kind: 'task_approval',
    refPartitionKey: row.partitionKey,
    refRowKey: row.rowKey,
    memberId: actor.id,
    // Denormalized so the parent queue renders from ONE query with zero fan-out.
    memberName: actor.displayName,
    memberAvatar: actor.avatarEmoji,
    title: row.title,
    points: award.total,
    dueDateLocal: row.dueDateLocal,
    note: null,
    createdAt: new Date(now).toISOString(),
  };
  await upsert(TABLES.actionQueue, queueEntity);

  await writeFeedItem({
    kind: 'task_completed',
    headline: `${actor.displayName} ticked off “${row.title}”`,
    detail: describeBonus(award) ?? 'waiting on a parent',
    icon: row.icon,
    points: award.total,
    actor: { id: actor.id, name: actor.displayName, avatar: actor.avatarEmoji },
    refType: 'task',
    refId: row.rowKey,
  });

  await bumpRev(['tasks', 'queue', 'points']);

  const updated = await getInstance(date, rowKey);
  return toInstance(updated ?? row, Date.now());
}

// ---------------------------------------------------------------------------
// Approval — the fixed write ordering
// ---------------------------------------------------------------------------

/**
 * Approve a completed chore.
 *
 * Table Storage has NO cross-table transactions: entity-group transactions
 * require the same table *and* partition, so the ledger write and the balance
 * update cannot be atomic. The ordering below is what makes a crash at any
 * point converge on retry instead of corrupting the ledger:
 *
 *   1. No-op if already approved      → makes the whole operation idempotent
 *   2. Write the ledger row           → the authoritative record, written first
 *   3. Update the instance            → records which ledger entry paid it
 *   4. Update the balance cache       → ETag-conditional, retried on 412
 *   5. Delete the queue row LAST      → an orphaned queue row is recoverable
 *                                       (a retry no-ops at step 1); a deleted
 *                                       one with no ledger entry is not.
 */
export async function approveTask(
  queueRowKey: string,
  approver: { id: string; displayName: string },
): Promise<{ awarded: number; memberId: string; achievements?: Achievement[] }> {
  const queueRow = await getEntity<ActionQueueEntity>(
    TABLES.actionQueue,
    actionQueuePK(env.householdId),
    queueRowKey,
  );
  if (!queueRow) throw new TaskError('That item is no longer waiting.', 404);
  if (queueRow.kind !== 'task_approval') throw new TaskError('Wrong kind of item.', 400);

  const row = (await getEntity<TaskInstanceEntity>(
    TABLES.taskInstances,
    queueRow.refPartitionKey,
    queueRow.refRowKey,
  )) as InstanceRow | null;
  if (!row) {
    // The chore vanished; clear the stale queue row so it stops nagging.
    await remove(TABLES.actionQueue, queueRow.partitionKey, queueRow.rowKey);
    throw new TaskError('That chore no longer exists.', 404);
  }

  // ---- 1. Idempotency gate -------------------------------------------------
  if (row.status === 'approved') {
    await remove(TABLES.actionQueue, queueRow.partitionKey, queueRow.rowKey);
    return { awarded: row.awardedPoints ?? 0, memberId: row.assignedMemberId, achievements: [] };
  }
  if (row.status !== 'pending') {
    throw new TaskError('That chore is not waiting for approval.', 409);
  }

  const memberId = row.completedBy ?? row.assignedMemberId;
  const member = await getMemberRow(memberId);
  if (!member) throw new TaskError('That family member no longer exists.', 404);

  // Pay the number snapshotted at completion, not a fresh computation. The kid
  // was shown "+18 pending"; anything else here is a bug they will notice.
  const awarded =
    row.computedPoints ??
    computeAward({ basePoints: row.basePoints, wildcardMultiplier: row.multiplier }).total;
  const now = Date.now();
  const entryId = randomUUID();

  // ---- 2. Ledger first — this is the authoritative record -------------------
  const ledgerEntity: LedgerEntity & { partitionKey: string; rowKey: string } = {
    partitionKey: ledgerPK(env.householdId, memberId, yearMonthOfLocalDate(row.dueDateLocal)),
    rowKey: ledgerRK(now, entryId),
    delta: awarded,
    kind: 'task_award',
    refType: 'task',
    refId: row.rowKey,
    description: row.title,
    balanceAfter: member.pointsBalance + awarded,
    actorMemberId: approver.id,
    createdAt: new Date(now).toISOString(),
  };
  await upsert(TABLES.ledger, ledgerEntity);

  // ---- 3. Instance --------------------------------------------------------
  await upsert(TABLES.taskInstances, {
    partitionKey: row.partitionKey,
    rowKey: row.rowKey,
    status: 'approved',
    approvedAt: new Date(now).toISOString(),
    approvedBy: approver.id,
    ledgerEntryId: entryId,
    awardedPoints: awarded,
  });

  // ---- 4. Balance cache, ETag-conditional ---------------------------------
  // Achievement counters ride along in the same ETag-guarded write. Keeping
  // them incremental is what makes evaluation cheap enough to run on every
  // approval — the alternative is a full history scan in the write path.
  const wasWildcard = row.multiplier > 1;
  const wasEarly =
    row.dueTimeLocal !== null &&
    now < localDateTimeMs(row.dueDateLocal, row.dueTimeLocal, env.timezone);

  await updateWithRetry<MemberEntity & CounterFields>(
    TABLES.members,
    memberPK(env.householdId),
    memberRK(memberId),
    (current) => ({
      partitionKey: current.partitionKey,
      rowKey: current.rowKey,
      pointsBalance: (current.pointsBalance ?? 0) + awarded,
      lifetimePoints: (current.lifetimePoints ?? 0) + awarded,
      pendingPoints: Math.max(0, (current.pendingPoints ?? 0) - awarded),
      tasksCompleted: (current.tasksCompleted ?? 0) + 1,
      categoriesJson: bumpCategory(current.categoriesJson, row.taskDefId),
      ...(wasEarly ? { earlyCompletions: (current.earlyCompletions ?? 0) + 1 } : {}),
      ...(wasWildcard ? { wildcardsClaimed: (current.wildcardsClaimed ?? 0) + 1 } : {}),
    }),
  );

  await writeFeedItem({
    kind: 'task_approved',
    headline: `${member.displayName} cleared “${row.title}”`,
    icon: row.icon,
    points: awarded,
    actor: { id: memberId, name: member.displayName, avatar: member.avatarEmoji },
    refType: 'task',
    refId: row.rowKey,
  });

  // ---- 5. Queue row LAST --------------------------------------------------
  await remove(TABLES.actionQueue, queueRow.partitionKey, queueRow.rowKey);

  // ---- 6. Streak, after the points are safely down ------------------------
  // Runs last and never throws into the caller: a streak is a motivator, and
  // failing an approval that already landed in the ledger because a bonus
  // counter would not write would be a strictly worse outcome. The cron tick
  // re-evaluates the same day idempotently, so a miss here self-heals.
  try {
    await evaluateStreak(memberId, row.dueDateLocal);
  } catch {
    // Deliberately swallowed; see above.
  }

  // ---- 7. Achievements, synchronously ------------------------------------
  // A child is standing at the tablet waiting for the badge, so this runs
  // inline rather than on the next tick. evaluateAchievements never throws —
  // a slow or missing API costs a hand-written badge name, not an approval.
  const badges = await evaluateAchievements(memberId, await statsFor(memberId));

  await bumpRev(['tasks', 'queue', 'points', 'members']);
  return { awarded, memberId, achievements: badges };
}

/** Send a chore back. Points never landed, so only the pending cache unwinds. */
export async function rejectTask(
  queueRowKey: string,
  approver: { id: string },
  note?: string,
): Promise<void> {
  const queueRow = await getEntity<ActionQueueEntity>(
    TABLES.actionQueue,
    actionQueuePK(env.householdId),
    queueRowKey,
  );
  if (!queueRow) throw new TaskError('That item is no longer waiting.', 404);

  const row = (await getEntity<TaskInstanceEntity>(
    TABLES.taskInstances,
    queueRow.refPartitionKey,
    queueRow.refRowKey,
  )) as InstanceRow | null;

  if (row && row.status === 'pending') {
    await upsert(TABLES.taskInstances, {
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
      // Back to open so it can still be done today, rather than dead-ended.
      status: 'open',
      completedAt: null,
      completedBy: null,
      // Clear the snapshot too: if it is done again tomorrow the streak may
      // have moved, and a stale snapshot would pay yesterday's multiplier.
      computedPoints: null,
      appliedStreakMultiplier: null,
      note: note ?? null,
      approvedBy: approver.id,
    });

    await updateWithRetry<MemberEntity>(
      TABLES.members,
      memberPK(env.householdId),
      memberRK(queueRow.memberId),
      (current) => ({
        partitionKey: current.partitionKey,
        rowKey: current.rowKey,
        pendingPoints: Math.max(0, (current.pendingPoints ?? 0) - queueRow.points),
      }),
    );
  }

  await remove(TABLES.actionQueue, queueRow.partitionKey, queueRow.rowKey);
  await bumpRev(['tasks', 'queue', 'points']);
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/** Everything waiting on a parent, in one point-partition query. */
export async function listQueue(): Promise<QueueItem[]> {
  const rows = await listPartition<ActionQueueEntity>(
    TABLES.actionQueue,
    actionQueuePK(env.householdId),
  );
  return rows.map((r) => ({
    id: r.rowKey,
    kind: r.kind,
    memberId: r.memberId,
    memberName: r.memberName,
    memberAvatar: r.memberAvatar,
    title: r.title,
    points: r.points,
    dueDateLocal: r.dueDateLocal,
    createdAt: r.createdAt,
  }));
}

/** Today, in the household's timezone — never the server's. */
export function today(): LocalDate {
  return localDateNow(env.timezone);
}

export { parseTaskInstanceRK };

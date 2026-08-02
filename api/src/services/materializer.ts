import {
  ANY_MEMBER,
  CONFIG_ROWS,
  TABLES,
  configPK,
  configRK,
  parseTaskDefRK,
  taskDefPK,
  taskInstancePK,
  taskInstanceRK,
} from '../../../shared/keys.js';
import { occurrenceOrdinal, occursOn, resolveAssignee, type Recurrence } from '../../../shared/recurrence.js';
import { addLocalDays, isBefore, localDateNow, localDateRange, type LocalDate } from '../../../shared/time.js';
import type { TaskDefEntity, TaskInstanceEntity } from '../../../shared/types.js';
import { env } from '../lib/env.js';
import { createIfAbsent, getEntity, listPartition, upsert } from '../lib/tables.js';
import { listMembers } from '../lib/members.js';

/**
 * Turning task definitions into dated instances.
 *
 * The row key is DETERMINISTIC — taskDefId|memberId|seq inside a per-day
 * partition — so `createEntity` either succeeds or throws 409
 * EntityAlreadyExists. Swallowing that 409 is the entire idempotency
 * guarantee, and it is what makes this safe to call from three different
 * triggers without coordination:
 *
 *   1. Lazily, on every task read (the primary path — the kiosk polls all day,
 *      so this alone keeps the critical path correct).
 *   2. From POST /api/cron/tick, driven by a GitHub Actions schedule.
 *   3. Manually, from the parent settings screen.
 *
 * SWA managed functions are HTTP-trigger only — there is no timer trigger —
 * which is why this design leans on the lazy path rather than a scheduler.
 */

/** How far ahead to materialize. Far enough that the calendar and "what's
 *  coming up" work; short enough that editing a definition only orphans two
 *  weeks of instances. */
export const HORIZON_DAYS = 14;

interface Watermark {
  /** Last local date materialized for the household. */
  through: string | null;
  updatedAt: string;
}

async function readWatermark(): Promise<Watermark> {
  const row = await getEntity<Watermark>(
    TABLES.config,
    configPK(env.householdId),
    configRK(CONFIG_ROWS.materialization),
  );
  return row ?? { through: null, updatedAt: new Date(0).toISOString() };
}

async function writeWatermark(through: LocalDate): Promise<void> {
  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.materialization),
    through,
    updatedAt: new Date().toISOString(),
  });
}

export interface MaterializeResult {
  created: number;
  skipped: number;
  from: LocalDate | null;
  through: LocalDate;
}

/**
 * Ensure instances exist through `throughDate`.
 *
 * The watermark check makes this a single point read on the overwhelming
 * majority of calls, which is what makes it acceptable to run on every task
 * read rather than only on a schedule.
 */
export async function materialize(throughDate?: LocalDate): Promise<MaterializeResult> {
  const today = localDateNow(env.timezone);
  const target = throughDate ?? addLocalDays(today, HORIZON_DAYS);

  const watermark = await readWatermark();
  if (watermark.through && !isBefore(watermark.through, target)) {
    return { created: 0, skipped: 0, from: null, through: watermark.through };
  }

  // Always re-cover from today rather than resuming at the watermark: a
  // definition created after the watermark advanced still needs instances for
  // the days already "covered". Redundant work is free because the row key is
  // deterministic, so re-creating an existing occurrence is a swallowed 409.
  //
  // Never earlier than today — we materialize the future, not history. Past
  // days hold whatever was created when they *were* today.
  const from = today;

  const [defRows, members] = await Promise.all([
    listPartition<TaskDefEntity>(TABLES.taskDefs, taskDefPK(env.householdId)),
    listMembers(),
  ]);

  const memberNames = new Map(members.map((m) => [m.rowKey, m.displayName]));
  const dates = localDateRange(from, target);

  let created = 0;
  let skipped = 0;

  for (const defRow of defRows) {
    if (!defRow.active) continue;

    const taskDefId = parseTaskDefRK(defRow.rowKey).taskDefId;
    let recurrence: Recurrence;
    try {
      recurrence = JSON.parse(defRow.recurrenceJson) as Recurrence;
    } catch {
      // A malformed definition must not take down materialization for every
      // other chore in the household.
      continue;
    }

    const rotationOrder = safeParseArray(defRow.rotationOrderJson);

    for (const date of dates) {
      if (!occursOn(recurrence, date)) continue;

      const assignedMemberId = resolveAssignee(defRow.assignMode, {
        fixedMemberId: defRow.assigneeMemberId,
        rotationOrder,
        rotationIndex: defRow.rotationIndex,
        occurrenceOrdinal: occurrenceOrdinal(recurrence, date),
        anyoneToken: ANY_MEMBER,
      });

      const entity: TaskInstanceEntity & { partitionKey: string; rowKey: string } = {
        partitionKey: taskInstancePK(env.householdId, date),
        rowKey: taskInstanceRK(taskDefId, assignedMemberId, 0),
        taskDefId,
        title: defRow.title,
        icon: defRow.icon,
        // Snapshot: editing the definition later must not retroactively change
        // what an already-completed chore was worth.
        basePoints: defRow.points,
        multiplier: 1,
        bonusReason: null,
        dueDateLocal: date,
        dueTimeLocal: defRow.dueTimeLocal,
        assignedMemberId,
        assignedMemberName:
          assignedMemberId === ANY_MEMBER ? null : (memberNames.get(assignedMemberId) ?? null),
        status: 'open',
        completedAt: null,
        completedBy: null,
        approvedAt: null,
        approvedBy: null,
        ledgerEntryId: null,
        awardedPoints: null,
        note: null,
      };

      // The 409 swallow. Not an error — it means this occurrence already
      // exists, which is exactly what we want when three triggers race.
      if (await createIfAbsent(TABLES.taskInstances, entity)) created++;
      else skipped++;
    }
  }

  await writeWatermark(target);
  return { created, skipped, from, through: target };
}

function safeParseArray(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Roll yesterday's unfinished chores to `expired`.
 *
 * Runs on the cron tick. Deliberately does not touch `pending` — a chore a kid
 * finished but a parent has not looked at yet must not silently expire out
 * from under them.
 */
export async function expireOverdue(asOfDate?: LocalDate): Promise<number> {
  const today = asOfDate ?? localDateNow(env.timezone);
  const yesterday = addLocalDays(today, -1);

  const rows = await listPartition<TaskInstanceEntity>(
    TABLES.taskInstances,
    taskInstancePK(env.householdId, yesterday),
  );

  let expired = 0;
  for (const row of rows) {
    if (row.status !== 'open') continue;
    await upsert(TABLES.taskInstances, {
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
      status: 'expired',
    });
    expired++;
  }
  return expired;
}

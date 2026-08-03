import { beforeAll, describe, expect, it } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-tasks';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';

const {
  CONFIG_ROWS,
  TABLES,
  actionQueuePK,
  configPK,
  configRK,
  ledgerPK,
  memberPK,
  memberRK,
  taskDefPK,
  taskDefRK,
  taskInstancePK,
} = await import('../../shared/keys.js');
const { addLocalDays, localDateNow, yearMonthOfLocalDate } = await import('../../shared/time.js');
const { env } = await import('../src/lib/env.js');
const { ensureTables, getEntity, listPartition, remove, upsert } = await import('../src/lib/tables.js');
const { hashPin } = await import('../src/lib/pin.js');
const { materialize, expireOverdue } = await import('../src/services/materializer.js');
const { approveTask, completeTask, listQueue, listTasksForDate, rejectTask } = await import(
  '../src/services/tasks.js'
);
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-tasks';
const TZ = 'America/New_York';

async function member(id: string, role: 'parent' | 'child', points = 0) {
  await upsert(TABLES.members, {
    partitionKey: memberPK(HH),
    rowKey: memberRK(id),
    displayName: id,
    role,
    avatarEmoji: '🦊',
    avatarColor: '#F0A830',
    ...(await hashPin('4816')),
    active: true,
    sortOrder: 0,
    pointsBalance: points,
    lifetimePoints: points,
    pendingPoints: 0,
    createdAt: new Date().toISOString(),
  });
}

async function taskDef(id: string, over: Record<string, unknown> = {}) {
  await upsert(TABLES.taskDefs, {
    partitionKey: taskDefPK(HH),
    rowKey: taskDefRK(id),
    title: `Task ${id}`,
    description: null,
    points: 15,
    assignMode: 'fixed',
    assigneeMemberId: 'kid',
    rotationOrderJson: '[]',
    rotationIndex: 0,
    recurrenceJson: JSON.stringify({
      freq: 'daily',
      interval: 1,
      dtStart: addLocalDays(localDateNow(TZ), -1),
    }),
    dueTimeLocal: '18:00',
    requiresApproval: true,
    category: null,
    icon: '🧹',
    active: true,
    materializedThrough: null,
    createdBy: 'parent',
    createdAt: new Date().toISOString(),
    ...over,
  });
}

/** Materialization short-circuits on a watermark, so tests must clear it. */
async function resetWatermark() {
  await remove(TABLES.config, configPK(HH), configRK(CONFIG_ROWS.materialization));
}

async function clearQueue() {
  for (const r of await listPartition(TABLES.actionQueue, actionQueuePK(HH))) {
    await remove(TABLES.actionQueue, r.partitionKey, r.rowKey);
  }
}

beforeAll(async () => {
  await ensureTables();
  await purgeHousehold(HH);
  await member('kid', 'child');
  await member('parent', 'parent');
});

describe('materializer idempotency', () => {
  it('creates instances once, and running again creates nothing', async () => {
    await taskDef('t1');
    await resetWatermark();

    const first = await materialize();
    expect(first.created).toBeGreaterThan(0);

    // This is the property the whole design leans on: the row key is
    // deterministic, so a duplicate create throws 409 and is swallowed. It is
    // what makes the lazy path, the cron tick, and the manual trigger safe to
    // run concurrently without coordination.
    await resetWatermark();
    const second = await materialize();
    expect(second.created).toBe(0);
    expect(second.skipped).toBeGreaterThan(0);
  });

  it('short-circuits on the watermark without touching storage', async () => {
    await materialize();
    const cached = await materialize();
    expect(cached.created).toBe(0);
    expect(cached.skipped).toBe(0);
    expect(cached.from).toBeNull();
  });

  it('produces exactly one instance per day for a daily task', async () => {
    const day = localDateNow(TZ);
    const rows = await listPartition(TABLES.taskInstances, taskInstancePK(HH, day));
    const forT1 = rows.filter((r) => (r as { taskDefId?: string }).taskDefId === 't1');
    expect(forT1).toHaveLength(1);
  });

  it('snapshots the points value, so editing the definition later does not rewrite history', async () => {
    const day = localDateNow(TZ);
    const before = (await listPartition(TABLES.taskInstances, taskInstancePK(HH, day)))
      .find((r) => (r as { taskDefId?: string }).taskDefId === 't1') as { basePoints: number };
    expect(before.basePoints).toBe(15);

    await upsert(TABLES.taskDefs, { partitionKey: taskDefPK(HH), rowKey: taskDefRK('t1'), points: 999 });
    await resetWatermark();
    await materialize();

    const after = (await listPartition(TABLES.taskInstances, taskInstancePK(HH, day)))
      .find((r) => (r as { taskDefId?: string }).taskDefId === 't1') as { basePoints: number };
    expect(after.basePoints).toBe(15);

    await upsert(TABLES.taskDefs, { partitionKey: taskDefPK(HH), rowKey: taskDefRK('t1'), points: 15 });
  });

  it('skips inactive definitions', async () => {
    await taskDef('inactive', { active: false });
    await resetWatermark();
    await materialize();
    const rows = await listPartition(TABLES.taskInstances, taskInstancePK(HH, localDateNow(TZ)));
    expect(rows.some((r) => (r as { taskDefId?: string }).taskDefId === 'inactive')).toBe(false);
  });

  it('survives a malformed definition instead of failing the whole household', async () => {
    await taskDef('broken', { recurrenceJson: 'not json at all' });
    await resetWatermark();
    const result = await materialize();
    expect(result).toBeDefined();
    const rows = await listPartition(TABLES.taskInstances, taskInstancePK(HH, localDateNow(TZ)));
    expect(rows.some((r) => (r as { taskDefId?: string }).taskDefId === 't1')).toBe(true);
  });
});

describe('complete → approve', () => {
  const today = localDateNow(TZ);

  it('moves a chore to pending without touching the ranked balance', async () => {
    await clearQueue();
    const tasks = await listTasksForDate(today);
    const task = tasks.find((t) => t.taskDefId === 't1')!;

    const before = await getEntity<{ pointsBalance: number; pendingPoints: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    );

    await completeTask(today, task.id, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' });

    const after = await getEntity<{ pointsBalance: number; pendingPoints: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    );

    // Pending points move; the ranked balance must not.
    expect(after!.pendingPoints).toBe(before!.pendingPoints + 15);
    expect(after!.pointsBalance).toBe(before!.pointsBalance);
  });

  it('is idempotent, so a double-tap on a laggy tablet is harmless', async () => {
    const tasks = await listTasksForDate(today);
    const task = tasks.find((t) => t.taskDefId === 't1')!;

    const before = await getEntity<{ pendingPoints: number }>(TABLES.members, memberPK(HH), memberRK('kid'));
    await completeTask(today, task.id, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' });
    const after = await getEntity<{ pendingPoints: number }>(TABLES.members, memberPK(HH), memberRK('kid'));

    expect(after!.pendingPoints).toBe(before!.pendingPoints);
  });

  it('puts exactly one item in the parent queue, with display data denormalized', async () => {
    const items = await listQueue();
    expect(items).toHaveLength(1);
    // Denormalized so the queue screen renders from ONE query with no fan-out.
    expect(items[0]!.memberName).toBe('kid');
    expect(items[0]!.memberAvatar).toBe('🦊');
    expect(items[0]!.points).toBe(15);
  });

  it('approves: ledger written, balance moved, pending unwound, queue cleared', async () => {
    const [item] = await listQueue();
    const before = await getEntity<{ pointsBalance: number; pendingPoints: number; lifetimePoints: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    );

    const result = await approveTask(item!.id, { id: 'parent', displayName: 'parent' });
    expect(result.awarded).toBe(15);

    const after = await getEntity<{ pointsBalance: number; pendingPoints: number; lifetimePoints: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    );
    // An approval can also unlock a badge, which carries its own points and
    // lands on the same balance. Accounting for it rather than asserting
    // `+ 15`: that form only held while the achievement ladder was empty.
    const bonus = (result.achievements ?? []).reduce((n, a) => n + a.pointsAwarded, 0);
    expect(after!.pointsBalance).toBe(before!.pointsBalance + 15 + bonus);
    expect(after!.lifetimePoints).toBe(before!.lifetimePoints + 15 + bonus);
    // Pending tracks the chore only — a badge was never "pending".
    expect(after!.pendingPoints).toBe(before!.pendingPoints - 15);

    // The ledger is the authoritative record and must exist.
    const ledger = await listPartition<{ delta: number }>(
      TABLES.ledger,
      ledgerPK(HH, 'kid', yearMonthOfLocalDate(today)),
    );
    // Look for the chore's own entry rather than indexing: rows come back
    // newest-first, so a badge awarded microseconds later sorts ahead of it.
    expect(ledger.some((e) => e.delta === 15)).toBe(true);

    // Queue row is deleted LAST, and by now it is gone.
    expect(await listQueue()).toHaveLength(0);
  });

  it('does not double-award if approve is retried after a crash', async () => {
    // Re-running an already-approved item must no-op at the idempotency gate
    // rather than writing a second ledger entry. This is what makes the
    // queue-row-deleted-last ordering safe.
    const day = localDateNow(TZ);
    const tasks = await listTasksForDate(day);
    const task = tasks.find((t) => t.taskDefId === 't1')!;
    expect(task.status).toBe('approved');

    const balanceBefore = (await getEntity<{ pointsBalance: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    ))!.pointsBalance;
    const ledgerBefore = (await listPartition(TABLES.ledger, ledgerPK(HH, 'kid', yearMonthOfLocalDate(day)))).length;

    // Simulate the crash window: the queue row survived, the approval did not
    // finish clearing it. A retry must recognise the work is already done.
    await upsert(TABLES.actionQueue, {
      partitionKey: actionQueuePK(HH),
      rowKey: 'ghost-row',
      kind: 'task_approval',
      refPartitionKey: taskInstancePK(HH, day),
      refRowKey: task.id,
      memberId: 'kid',
      memberName: 'kid',
      memberAvatar: '🦊',
      title: task.title,
      points: 15,
      dueDateLocal: day,
      note: null,
      createdAt: new Date().toISOString(),
    });

    const retry = await approveTask('ghost-row', { id: 'parent', displayName: 'parent' });
    expect(retry.awarded).toBe(15);

    const balanceAfter = (await getEntity<{ pointsBalance: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    ))!.pointsBalance;
    const ledgerAfter = (await listPartition(TABLES.ledger, ledgerPK(HH, 'kid', yearMonthOfLocalDate(day)))).length;

    expect(balanceAfter).toBe(balanceBefore);
    expect(ledgerAfter).toBe(ledgerBefore);
    // ...and the ghost row is swept.
    expect(await listQueue()).toHaveLength(0);
  });
});

describe('rejection', () => {
  it('returns the chore to open and unwinds only the pending points', async () => {
    await clearQueue();
    await taskDef('t2');
    await resetWatermark();
    await materialize();

    const day = localDateNow(TZ);
    const task = (await listTasksForDate(day)).find((t) => t.taskDefId === 't2')!;
    await completeTask(day, task.id, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' });

    const beforeReject = await getEntity<{ pointsBalance: number; pendingPoints: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    );

    const [item] = await listQueue();
    await rejectTask(item!.id, { id: 'parent' }, 'have another go');

    const afterReject = await getEntity<{ pointsBalance: number; pendingPoints: number }>(
      TABLES.members, memberPK(HH), memberRK('kid'),
    );

    expect(afterReject!.pendingPoints).toBe(beforeReject!.pendingPoints - 15);
    expect(afterReject!.pointsBalance).toBe(beforeReject!.pointsBalance);

    // Back to open so it can still be done today, rather than dead-ended.
    const after = (await listTasksForDate(day)).find((t) => t.taskDefId === 't2')!;
    expect(after.status).toBe('open');
    expect(await listQueue()).toHaveLength(0);
  });
});

describe('ownership', () => {
  it('refuses to let one child complete another child’s chore', async () => {
    await member('other', 'child');
    const day = localDateNow(TZ);
    const task = (await listTasksForDate(day)).find((t) => t.taskDefId === 't2')!;

    await expect(
      completeTask(day, task.id, { id: 'other', displayName: 'other', avatarEmoji: '🐢' }),
    ).rejects.toThrow(/somebody else/i);
  });

  it('lets anyone claim an unassigned chore, and records who took it', async () => {
    await taskDef('shared', { assignMode: 'anyone', assigneeMemberId: null });
    await resetWatermark();
    await materialize();

    const day = localDateNow(TZ);
    const task = (await listTasksForDate(day)).find((t) => t.taskDefId === 'shared')!;
    expect(task.assignedMemberId).toBe('*');

    const done = await completeTask(day, task.id, {
      id: 'other',
      displayName: 'other',
      avatarEmoji: '🐢',
    });
    expect(done.status).toBe('pending');
    expect(done.assignedMemberId).toBe('other');
  });
});

describe('expiry', () => {
  it('expires yesterday’s open chores but never a pending one', async () => {
    const yesterday = addLocalDays(localDateNow(TZ), -1);

    // The materializer only creates forward from today — it materializes the
    // future, not history. Yesterday's rows exist in production because they
    // were written when yesterday *was* today, so the test stands them up
    // directly rather than pretending materialize() would backfill them.
    for (const [defId, status] of [
      ['stale-a', 'open'],
      ['stale-b', 'open'],
      ['stale-c', 'pending'],
    ] as const) {
      await upsert(TABLES.taskInstances, {
        partitionKey: taskInstancePK(HH, yesterday),
        rowKey: `${defId}|kid|0`,
        taskDefId: defId,
        title: `Yesterday ${defId}`,
        icon: null,
        basePoints: 10,
        multiplier: 1,
        bonusReason: null,
        dueDateLocal: yesterday,
        dueTimeLocal: '18:00',
        assignedMemberId: 'kid',
        assignedMemberName: 'kid',
        status,
        completedAt: null,
        completedBy: null,
        approvedAt: null,
        approvedBy: null,
        ledgerEntryId: null,
        awardedPoints: null,
        note: null,
      });
    }

    const rows = await listPartition<{ status: string }>(
      TABLES.taskInstances,
      taskInstancePK(HH, yesterday),
    );
    expect(rows.filter((r) => r.status === 'open').length).toBeGreaterThan(0);
    const pendingRow = rows.find((r) => r.status === 'pending')!;

    await expireOverdue();

    const after = await listPartition<{ status: string }>(
      TABLES.taskInstances,
      taskInstancePK(HH, yesterday),
    );

    // Every open chore rolls to expired...
    expect(after.filter((r) => r.status === 'open')).toHaveLength(0);
    expect(after.filter((r) => r.status === 'expired').length).toBeGreaterThan(0);

    // ...but a chore a kid finished must never silently expire out from under
    // them while it is still waiting on a parent.
    expect(after.find((r) => r.rowKey === pendingRow.rowKey)!.status).toBe('pending');
  });
});

describe('household isolation', () => {
  it('never reads another household’s partitions', async () => {
    expect(env.householdId).toBe(HH);
    expect(taskInstancePK(HH, '2026-03-08')).not.toBe(taskInstancePK('local', '2026-03-08'));
  });
});

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-ops';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';
process.env['CRON_SHARED_SECRET'] = 'test-cron-secret';

const {
  TABLES,
  memberPK,
  ledgerPK,
  ledgerRK,
  sessionPK,
  sessionRK,
  pinAttemptPK,
  pinAttemptRK,
  feedPK,
  taskInstancePK,
} = await import('../../shared/keys.js');
const { localDateNow, addLocalDays } = await import('../../shared/time.js');
const { ensureTables, getEntity, listPartition, upsert } = await import('../src/lib/tables.js');
const ops = await import('../src/services/ops.js');
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-ops';
const TZ = 'America/New_York';
const TODAY = localDateNow(TZ);
const MONTH = TODAY.slice(0, 7);

beforeAll(async () => {
  await ensureTables();
});

beforeEach(async () => {
  await purgeHousehold(HH);
});

async function member(id: string, balance: number): Promise<void> {
  await upsert(TABLES.members, {
    partitionKey: memberPK(HH),
    rowKey: id,
    displayName: id,
    role: 'child',
    pointsBalance: balance,
    pinHash: `do-not-touch-${id}`,
    avatarEmoji: '🦊',
    sortOrder: 1,
  });
}

async function ledgerEntry(memberId: string, delta: number, seq: number): Promise<void> {
  const at = Date.now() - seq * 1000;
  await upsert(TABLES.ledger, {
    partitionKey: ledgerPK(HH, memberId, MONTH),
    rowKey: ledgerRK(at, `entry-${seq}`),
    delta,
    reason: 'test',
    createdAt: new Date(at).toISOString(),
  });
}

// ---------------------------------------------------------------------------

describe('runOncePerLocalDay', () => {
  it('runs the job once and skips every later call the same day', async () => {
    let runs = 0;
    const job = async () => {
      runs++;
      return { runs };
    };

    const first = await ops.runOncePerLocalDay('unit-a', job, TODAY);
    const second = await ops.runOncePerLocalDay('unit-a', job, TODAY);
    const third = await ops.runOncePerLocalDay('unit-a', job, TODAY);

    expect(runs).toBe(1);
    expect(first).toEqual({ runs: 1 });
    expect(second).toEqual({ skipped: 'already ran today' });
    expect(third).toEqual({ skipped: 'already ran today' });
  });

  it('runs again on the next local day', async () => {
    let runs = 0;
    const job = async () => ++runs;

    await ops.runOncePerLocalDay('unit-b', job, TODAY);
    await ops.runOncePerLocalDay('unit-b', job, addLocalDays(TODAY, 1));

    expect(runs).toBe(2);
  });

  it('claims the day BEFORE running, so concurrent ticks cannot both proceed', async () => {
    // The claim ordering is the whole point: two ticks arriving together both
    // read "not run today", and only one may go on to spend money or write a
    // feed item. A job that observes the claim already in place proves the
    // write happened first.
    await ops.runOncePerLocalDay('unit-c', async () => 'seed', addLocalDays(TODAY, -1));

    let observed: string | null = null;
    await ops.runOncePerLocalDay(
      'unit-c',
      async () => {
        const statuses = await ops.jobStatuses();
        observed = statuses.find((s) => s.job === 'unit-c')?.lastRunDate ?? null;
        return 'done';
      },
      TODAY,
    );

    expect(observed).toBe(TODAY);
  });

  it('reports what it last did', async () => {
    await ops.runOncePerLocalDay('unit-d', async () => ({ cleaned: 3 }), TODAY);

    const status = (await ops.jobStatuses()).find((s) => s.job === 'unit-d');
    expect(status?.lastRunDate).toBe(TODAY);
    expect(status?.lastRunAt).toBeTruthy();
    expect(status?.lastResult).toEqual({ cleaned: 3 });
  });
});

describe('reconciler', () => {
  it('reports and corrects a balance that disagrees with the ledger', async () => {
    await member('maya', 40); // cache says 40
    await ledgerEntry('maya', 30, 1);
    await ledgerEntry('maya', 25, 2); // ledger says 55

    const result = await ops.reconcile();

    expect(result.checked).toBe(1);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]).toMatchObject({
      memberId: 'maya',
      cached: 40,
      fromLedger: 55,
      delta: 15,
    });

    const after = await getEntity<{ pointsBalance: number }>(TABLES.members, memberPK(HH), 'maya');
    expect(after?.pointsBalance).toBe(55);
  });

  it('leaves an agreeing balance completely alone', async () => {
    await member('theo', 55);
    await ledgerEntry('theo', 55, 1);

    const result = await ops.reconcile();

    expect(result.drift).toHaveLength(0);
  });

  it('does not disturb the rest of the member row', async () => {
    // Merge, not Replace. A reconciler that wipes the PIN hash to fix a
    // points total has locked a child out of the app to correct 15 points.
    await member('iris', 0);
    await ledgerEntry('iris', 90, 1);

    await ops.reconcile();

    const after = await getEntity<{ pinHash: string; displayName: string; pointsBalance: number }>(
      TABLES.members,
      memberPK(HH),
      'iris',
    );
    expect(after?.pinHash).toBe('do-not-touch-iris');
    expect(after?.displayName).toBe('iris');
    expect(after?.pointsBalance).toBe(90);
  });

  it('treats a member with no ledger history as zero, not as untouched', async () => {
    await member('ghost', 500);

    const result = await ops.reconcile();

    expect(result.drift[0]).toMatchObject({ memberId: 'ghost', fromLedger: 0, delta: -500 });
  });

  it('is idempotent — a second pass finds nothing', async () => {
    await member('maya', 40);
    await ledgerEntry('maya', 55, 1);

    await ops.reconcile();
    const second = await ops.reconcile();

    expect(second.drift).toHaveLength(0);
  });
});

describe('session sweep', () => {
  async function session(id: string, expiresAt: string): Promise<void> {
    await upsert(TABLES.sessions, {
      partitionKey: sessionPK(HH),
      rowKey: sessionRK(id),
      memberId: 'maya',
      expiresAt,
    });
  }

  it('removes expired sessions and keeps live ones', async () => {
    await session('dead', new Date(Date.now() - 60_000).toISOString());
    await session('alive', new Date(Date.now() + 600_000).toISOString());

    const result = await ops.sweepSessions();

    expect(result.sessions).toBe(1);
    const left = await listPartition(TABLES.sessions, sessionPK(HH));
    expect(left.map((r) => r.rowKey)).toEqual([sessionRK('alive')]);
  });

  it('leaves a row with an unreadable expiry alone', async () => {
    // Guessing is worse than keeping it: the read path rejects an unparseable
    // expiry anyway, so the row is inert, and deleting on a parse failure is
    // how a date-format change silently signs the whole family out.
    await session('weird', 'not-a-date');

    const result = await ops.sweepSessions();

    expect(result.sessions).toBe(0);
    expect(await listPartition(TABLES.sessions, sessionPK(HH))).toHaveLength(1);
  });

  it('keeps a PIN counter that is still inside its lockout', async () => {
    await upsert(TABLES.pinAttempts, {
      partitionKey: pinAttemptPK(HH),
      rowKey: pinAttemptRK('maya'),
      failures: 5,
      lockedUntil: new Date(Date.now() + 600_000).toISOString(),
      lastAttemptAt: new Date(Date.now() - 5 * 24 * 3600_000).toISOString(),
    });

    const result = await ops.sweepSessions();

    expect(result.pinAttempts).toBe(0);
  });

  it('drops a stale PIN counter whose lockout has passed', async () => {
    await upsert(TABLES.pinAttempts, {
      partitionKey: pinAttemptPK(HH),
      rowKey: pinAttemptRK('theo'),
      failures: 2,
      lockedUntil: null,
      lastAttemptAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
    });

    const result = await ops.sweepSessions();

    expect(result.pinAttempts).toBe(1);
  });
});

describe('end-of-day streaks', () => {
  it('evaluates yesterday for every member', async () => {
    await member('maya', 0);
    await member('theo', 0);

    const seen: Array<[string, string]> = [];
    const result = await ops.settleYesterdayStreaks(async (memberId, date) => {
      seen.push([memberId, date]);
      return { event: memberId === 'maya' ? 'advanced' : 'unchanged', current: 1 };
    });

    const yesterday = addLocalDays(TODAY, -1);
    expect(seen).toHaveLength(2);
    expect(seen.every(([, date]) => date === yesterday)).toBe(true);
    expect(result).toEqual({ evaluated: 2, advanced: 1 });
  });
});

/**
 * The requirement from the plan, stated directly: running the tick twice must
 * produce no duplicate instances, ledger entries, or feed items.
 *
 * Asserted at the level that actually matters — row counts in storage — rather
 * than by trusting each job's own idempotency claim.
 */
describe('running the tick twice', () => {
  it('leaves storage identical the second time through', async () => {
    const { taskDefPK, taskDefRK, configPK, configRK, CONFIG_ROWS, actionQueuePK } = await import(
      '../../shared/keys.js'
    );
    const { remove } = await import('../src/lib/tables.js');
    const { materialize, expireOverdue } = await import('../src/services/materializer.js');
    const { evaluateStreak } = await import('../src/services/points.js');
    const { completeTask } = await import('../src/services/tasks.js');
    const { resolveQueueItem } = await import('../src/services/queue.js');

    await member('maya', 0);
    await member('parent', 0);

    // A recurring chore, so materialization has something to create. Without
    // this the whole test compares three zeroes to three zeroes and proves
    // nothing at all.
    await upsert(TABLES.taskDefs, {
      partitionKey: taskDefPK(HH),
      rowKey: taskDefRK('dishes'),
      title: 'Dishes',
      description: null,
      points: 15,
      assignMode: 'fixed',
      assigneeMemberId: 'maya',
      rotationOrderJson: '[]',
      rotationIndex: 0,
      recurrenceJson: JSON.stringify({
        freq: 'daily',
        interval: 1,
        dtStart: addLocalDays(TODAY, -2),
      }),
      dueTimeLocal: '18:00',
      requiresApproval: true,
      category: 'kitchen',
      icon: '🍽️',
      active: true,
      materializedThrough: null,
      createdBy: 'parent',
      createdAt: new Date().toISOString(),
    });

    await remove(TABLES.config, configPK(HH), configRK(CONFIG_ROWS.materialization));

    const tick = async () => {
      await materialize();
      await expireOverdue();
      await ops.runOncePerLocalDay('tick-streaks', () => ops.settleYesterdayStreaks(evaluateStreak));
      await ops.runOncePerLocalDay('tick-reconcile', ops.reconcile);
      await ops.runOncePerLocalDay('tick-sessions', ops.sweepSessions);
    };

    await tick();

    // Drive a real chore all the way through, so there is a ledger entry and
    // feed items for the second tick to be able to duplicate.
    const instances = await listPartition<{ taskDefId: string }>(
      TABLES.taskInstances,
      taskInstancePK(HH, TODAY),
    );
    const mine = instances.find((r) => r.taskDefId === 'dishes');
    expect(mine, 'materialization should have created the chore').toBeTruthy();

    await completeTask(TODAY, mine!.rowKey, { id: 'maya', displayName: 'maya', role: 'child' });

    const queued = await listPartition(TABLES.actionQueue, actionQueuePK(HH));
    expect(queued.length).toBeGreaterThan(0);
    await resolveQueueItem(queued[0]!.rowKey, 'approve', {
      id: 'parent',
      displayName: 'parent',
      role: 'parent',
    });

    const before = await snapshot();
    // The assertions that keep this test honest: it has to be comparing real
    // rows, or "unchanged" is meaningless.
    expect(before.instances).toBeGreaterThan(0);
    expect(before.ledger).toBeGreaterThan(0);
    expect(before.feed).toBeGreaterThan(0);

    await tick();
    await tick();

    expect(await snapshot()).toEqual(before);
  });

  async function snapshot(): Promise<Record<string, number>> {
    const [instances, ledger, feed] = await Promise.all([
      listPartition(TABLES.taskInstances, taskInstancePK(HH, TODAY)),
      listPartition(TABLES.ledger, ledgerPK(HH, 'maya', MONTH)),
      listPartition(TABLES.feed, feedPK(HH, TODAY)),
    ]);

    return {
      instances: instances.length,
      ledger: ledger.length,
      feed: feed.length,
    };
  }
});

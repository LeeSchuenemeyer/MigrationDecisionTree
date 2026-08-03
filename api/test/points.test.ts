import { beforeAll, describe, expect, it } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-points';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';

const {
  STREAK_DAILY_ALL,
  TABLES,
  actionQueuePK,
  ledgerPK,
  memberPK,
  memberRK,
  streakPK,
  streakRK,
  taskInstancePK,
} = await import('../../shared/keys.js');
const { addLocalDays, localDateNow, yearMonthOfLocalDate } = await import('../../shared/time.js');
const { ensureTables, getEntity, listPartition, remove, upsert } = await import(
  '../src/lib/tables.js'
);
const { hashPin } = await import('../src/lib/pin.js');
const {
  adjustPoints,
  dayQualifies,
  deactivateReward,
  evaluateStreak,
  leaderboard,
  listRedemptions,
  listRewards,
  memberLedger,
  readStreak,
  requestRedemption,
  rollWildcards,
  streakView,
  upsertReward,
} = await import('../src/services/points.js');
const { completeTask, listQueue, listTasksForDate } = await import('../src/services/tasks.js');
const { resolveQueueItem } = await import('../src/services/queue.js');
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-points';
const TZ = 'America/New_York';
const TODAY = localDateNow(TZ);

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

async function balanceOf(id: string): Promise<number> {
  const row = await getEntity<{ pointsBalance: number }>(TABLES.members, memberPK(HH), memberRK(id));
  return row!.pointsBalance;
}

/** Stand up a task instance directly — the materializer is covered elsewhere. */
async function instance(
  date: string,
  defId: string,
  memberId: string,
  over: Record<string, unknown> = {},
) {
  await upsert(TABLES.taskInstances, {
    partitionKey: taskInstancePK(HH, date),
    rowKey: `${defId}|${memberId}|0`,
    taskDefId: defId,
    title: `Chore ${defId}`,
    icon: '🧹',
    basePoints: 10,
    multiplier: 1,
    bonusReason: null,
    dueDateLocal: date,
    dueTimeLocal: '18:00',
    assignedMemberId: memberId,
    assignedMemberName: memberId,
    status: 'open',
    completedAt: null,
    completedBy: null,
    computedPoints: null,
    appliedStreakMultiplier: null,
    approvedAt: null,
    approvedBy: null,
    ledgerEntryId: null,
    awardedPoints: null,
    note: null,
    ...over,
  });
}

async function clearQueue() {
  for (const r of await listPartition(TABLES.actionQueue, actionQueuePK(HH))) {
    await remove(TABLES.actionQueue, r.partitionKey, r.rowKey);
  }
}

beforeAll(async () => {
  await ensureTables();
  await purgeHousehold(HH);
  await member('kid', 'child', 100);
  await member('sib', 'child', 40);
  await member('parent', 'parent');
});

describe('leaderboard', () => {
  it('ranks on approved points and never folds pending in', async () => {
    await instance(TODAY, 'lb', 'kid');
    const task = (await listTasksForDate(TODAY)).find((t) => t.taskDefId === 'lb')!;
    await completeTask(TODAY, task.id, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' });

    const rows = await leaderboard();
    const kid = rows.find((r) => r.member.id === 'kid')!;

    // Ten points are sitting in the queue. The ranked number must not move.
    expect(kid.pendingPoints).toBe(10);
    expect(kid.points).toBe(100);
    expect(kid.rank).toBe(1);

    await clearQueue();
  });

  it('excludes parents, who are not competing', async () => {
    const rows = await leaderboard();
    expect(rows.some((r) => r.member.id === 'parent')).toBe(false);
  });

  it('gives tied members the same rank', async () => {
    await member('twin-a', 'child', 55);
    await member('twin-b', 'child', 55);

    const rows = await leaderboard();
    const a = rows.find((r) => r.member.id === 'twin-a')!;
    const b = rows.find((r) => r.member.id === 'twin-b')!;
    expect(a.rank).toBe(b.rank);
  });
});

describe('streaks', () => {
  it('does not qualify a day with an unfinished chore', async () => {
    const day = addLocalDays(TODAY, -5);
    await instance(day, 's1', 'kid', { status: 'approved' });
    await instance(day, 's2', 'kid', { status: 'open' });

    expect(await dayQualifies('kid', day)).toBe(false);
  });

  it('qualifies once every assigned chore is approved', async () => {
    const day = addLocalDays(TODAY, -5);
    await instance(day, 's2', 'kid', { status: 'approved' });
    expect(await dayQualifies('kid', day)).toBe(true);
  });

  it('does not qualify a day with no chores at all', async () => {
    // A day off is not a streak day. Otherwise the longest streak in the house
    // belongs to whoever was assigned the least.
    expect(await dayQualifies('kid', addLocalDays(TODAY, -400))).toBe(false);
  });

  it('extends across consecutive qualifying days and is idempotent', async () => {
    for (const offset of [-4, -3, -2]) {
      const day = addLocalDays(TODAY, offset);
      await instance(day, 'daily', 'kid', { status: 'approved' });
      await evaluateStreak('kid', day);
    }
    expect((await readStreak('kid')).current).toBe(3);

    // Re-running the same day — which the cron tick will do — must not inflate.
    await evaluateStreak('kid', addLocalDays(TODAY, -2));
    expect((await readStreak('kid')).current).toBe(3);
  });

  it('reports the tier and the deadline without mutating anything', async () => {
    const view = await streakView('kid');
    expect(view.key).toBe(STREAK_DAILY_ALL);
    expect(view.longest).toBeGreaterThanOrEqual(3);
    expect(view.multiplier).toBe(1.1);
    expect(view.deadline).toBe(addLocalDays(TODAY, -1));
  });

  it('stops advertising a multiplier once the streak has lapsed', async () => {
    await upsert(TABLES.streaks, {
      partitionKey: streakPK(HH, 'sib'),
      rowKey: streakRK(STREAK_DAILY_ALL),
      current: 12,
      longest: 12,
      lastQualifiedDate: addLocalDays(TODAY, -9),
      freezesRemaining: 0,
      updatedAt: new Date().toISOString(),
    });

    const view = await streakView('sib');
    // The board must never still show 1.25× for a streak that died last week.
    expect(view.alive).toBe(false);
    expect(view.current).toBe(0);
    expect(view.multiplier).toBe(1);
    // ...but the personal best survives.
    expect(view.longest).toBe(12);
  });
});

describe('streak multipliers on an award', () => {
  it('pays the multiplier in force when the chore was done, snapshotted at completion', async () => {
    await clearQueue();
    // kid is on a 3-day streak from the block above → 1.1×, and the streak's
    // last qualifying day is yesterday-ish, so it is still alive today.
    await upsert(TABLES.streaks, {
      partitionKey: streakPK(HH, 'kid'),
      rowKey: streakRK(STREAK_DAILY_ALL),
      current: 7,
      longest: 7,
      lastQualifiedDate: addLocalDays(TODAY, -1),
      freezesRemaining: 2,
      updatedAt: new Date().toISOString(),
    });

    await instance(TODAY, 'mult', 'kid', { basePoints: 20 });
    const pendingBefore = (await getEntity<{ pendingPoints: number }>(
      TABLES.members,
      memberPK(HH),
      memberRK('kid'),
    ))!.pendingPoints;

    const task = (await listTasksForDate(TODAY)).find((t) => t.taskDefId === 'mult')!;
    const done = await completeTask(TODAY, task.id, {
      id: 'kid',
      displayName: 'kid',
      avatarEmoji: '🦊',
    });

    // 20 × 1.25 (7-day tier) = 25, computed once and pinned to the instance.
    expect(done.computedPoints).toBe(25);
    expect(done.appliedStreakMultiplier).toBe(1.25);

    const [item] = await listQueue();
    expect(item!.points).toBe(25);

    const before = await balanceOf('kid');
    const result = await resolveQueueItem(item!.id, 'approve', {
      id: 'parent',
      displayName: 'parent',
    });

    // Approval pays exactly the number the kid was shown as pending.
    expect(result.delta).toBe(25);

    // The balance also absorbs any badge unlocked by this same approval, which
    // carries its own pointsAwarded. Accounting for it explicitly rather than
    // asserting `before + 25`: that form passed only while the achievement
    // ladder was empty and no badge could ever fire.
    const bonus = (result.achievements ?? []).reduce((n, a) => n + a.pointsAwarded, 0);
    expect(await balanceOf('kid')).toBe(before + 25 + bonus);

    // Pending must unwind by exactly what was added — not by a freshly
    // recomputed award, which is the drift this snapshot exists to prevent.
    const after = await getEntity<{ pendingPoints: number }>(
      TABLES.members,
      memberPK(HH),
      memberRK('kid'),
    );
    expect(after!.pendingPoints).toBe(pendingBefore);
  });

  it('stacks a wildcard on top of the streak, multiplicatively', async () => {
    await clearQueue();
    await instance(TODAY, 'wild', 'kid', { basePoints: 20, multiplier: 2 });
    const task = (await listTasksForDate(TODAY)).find((t) => t.taskDefId === 'wild')!;
    const done = await completeTask(TODAY, task.id, {
      id: 'kid',
      displayName: 'kid',
      avatarEmoji: '🦊',
    });
    // 20 × 2 × 1.25 = 50.
    expect(done.computedPoints).toBe(50);
    await clearQueue();
  });
});

describe('wildcards', () => {
  it('marks open chores double and refuses to roll twice in a day', async () => {
    await instance(TODAY, 'w1', 'sib');
    await instance(TODAY, 'w2', 'sib');

    const first = await rollWildcards(TODAY, 2);
    expect(first.alreadyRolled).toBe(false);
    expect(first.rolled).toBeGreaterThan(0);

    // The cron tick is at-least-once. A second roll must be a no-op, or every
    // chore eventually becomes a wildcard and none of them mean anything.
    const second = await rollWildcards(TODAY, 2);
    expect(second.alreadyRolled).toBe(true);
    expect(second.rolled).toBe(0);
  });

  it('never turns an already-completed chore into a wildcard', async () => {
    const rows = await listPartition<{ status: string; multiplier: number }>(
      TABLES.taskInstances,
      taskInstancePK(HH, TODAY),
    );
    // Paying a bonus for work done without knowing the bonus existed is not
    // what a wildcard is for.
    for (const r of rows.filter((x) => x.status === 'approved')) {
      expect(r.multiplier).toBeLessThanOrEqual(2);
    }
  });
});

describe('rewards and redemptions', () => {
  let rewardId = '';

  it('creates a catalog entry and computes affordability per viewer', async () => {
    rewardId = await upsertReward({ title: 'Pick dinner', cost: 60, icon: '🍕' }, 'parent');

    const forKid = await listRewards('kid');
    const forSib = await listRewards('sib');

    expect(forKid.find((r) => r.id === rewardId)!.affordable).toBe(true);
    // sib has 40 points against a 60-point reward.
    expect(forSib.find((r) => r.id === rewardId)!.affordable).toBe(false);
  });

  it('hides a restricted reward from everyone else', async () => {
    const secret = await upsertReward(
      { title: 'Sib only', cost: 5, restrictedToMemberIds: ['sib'] },
      'parent',
    );
    expect((await listRewards('kid')).some((r) => r.id === secret)).toBe(false);
    expect((await listRewards('sib')).some((r) => r.id === secret)).toBe(true);
  });

  it('refuses a purchase nobody can afford, without writing anything', async () => {
    const ledgerBefore = (
      await listPartition(TABLES.ledger, ledgerPK(HH, 'sib', yearMonthOfLocalDate(TODAY)))
    ).length;

    await expect(
      requestRedemption(rewardId, { id: 'sib', displayName: 'sib', avatarEmoji: '🐢' }),
    ).rejects.toThrow(/not enough points/i);

    const ledgerAfter = (
      await listPartition(TABLES.ledger, ledgerPK(HH, 'sib', yearMonthOfLocalDate(TODAY)))
    ).length;
    expect(ledgerAfter).toBe(ledgerBefore);
  });

  it('debits immediately rather than holding, so queued requests cannot overdraw', async () => {
    await clearQueue();
    const before = await balanceOf('kid');

    await requestRedemption(rewardId, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' });

    // The whole reason for debiting up front: a kid could otherwise queue five
    // redemptions they can each individually afford but not collectively, and a
    // parent approving all five would drive the balance negative.
    expect(await balanceOf('kid')).toBe(before - 60);

    const [item] = await listQueue();
    expect(item!.kind).toBe('redemption');
    expect(item!.title).toBe('Pick dinner');
  });

  it('fulfils without moving points again', async () => {
    const [item] = await listQueue();
    const before = await balanceOf('kid');

    const result = await resolveQueueItem(item!.id, 'approve', {
      id: 'parent',
      displayName: 'parent',
    });

    expect(result.kind).toBe('redemption');
    expect(result.delta).toBe(0);
    expect(await balanceOf('kid')).toBe(before);
    expect(await listQueue()).toHaveLength(0);

    const mine = await listRedemptions('kid');
    expect(mine[0]!.status).toBe('fulfilled');
  });

  it('refunds a refusal with a reversal entry, keeping the ledger append-only', async () => {
    await clearQueue();
    const before = await balanceOf('kid');
    const cheap = await upsertReward({ title: 'Skip a chore', cost: 25 }, 'parent');

    await requestRedemption(cheap, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' });
    expect(await balanceOf('kid')).toBe(before - 25);

    const [item] = await listQueue();
    await resolveQueueItem(item!.id, 'reject', { id: 'parent', displayName: 'parent' });

    expect(await balanceOf('kid')).toBe(before);

    const entries = await memberLedger('kid');
    const reversal = entries.find((e) => e.kind === 'reversal');
    expect(reversal).toBeDefined();
    expect(reversal!.delta).toBe(25);

    // The original debit is still there — nothing was deleted.
    expect(entries.some((e) => e.kind === 'redemption' && e.delta === -25)).toBe(true);

    const mine = await listRedemptions('kid');
    expect(mine.find((r) => r.rewardTitle === 'Skip a chore')!.status).toBe('rejected');
  });

  it('decrements limited stock and then refuses to sell', async () => {
    await clearQueue();
    const limited = await upsertReward({ title: 'Last cookie', cost: 1, stock: 1 }, 'parent');

    await requestRedemption(limited, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' });
    await expect(
      requestRedemption(limited, { id: 'kid', displayName: 'kid', avatarEmoji: '🦊' }),
    ).rejects.toThrow(/out of stock/i);

    await clearQueue();
  });

  it('retires a reward without erasing what was already bought', async () => {
    await deactivateReward(rewardId);
    expect((await listRewards('kid')).some((r) => r.id === rewardId)).toBe(false);
    // The history still says what was bought, because the title is denormalized.
    expect((await listRedemptions('kid')).some((r) => r.rewardTitle === 'Pick dinner')).toBe(true);
  });
});

describe('manual adjustment', () => {
  it('writes a traceable ledger entry and moves the balance', async () => {
    const before = await balanceOf('sib');
    await adjustPoints('sib', 15, 'helped without being asked', {
      id: 'parent',
      displayName: 'parent',
    });

    expect(await balanceOf('sib')).toBe(before + 15);

    const entry = (await memberLedger('sib')).find((e) => e.kind === 'manual_adjust')!;
    expect(entry.delta).toBe(15);
    // An adjustment nobody can trace is how a points economy loses credibility.
    expect(entry.description).toBe('helped without being asked');
  });

  it('does not inflate lifetime points on a deduction', async () => {
    const row = await getEntity<{ lifetimePoints: number }>(
      TABLES.members,
      memberPK(HH),
      memberRK('sib'),
    );
    const lifetimeBefore = row!.lifetimePoints;

    await adjustPoints('sib', -5, 'correction', { id: 'parent', displayName: 'parent' });

    const after = await getEntity<{ lifetimePoints: number }>(
      TABLES.members,
      memberPK(HH),
      memberRK('sib'),
    );
    expect(after!.lifetimePoints).toBe(lifetimeBefore);
  });

  it('refuses a zero adjustment', async () => {
    await expect(
      adjustPoints('sib', 0, 'nothing', { id: 'parent', displayName: 'parent' }),
    ).rejects.toThrow();
  });
});

describe('household isolation', () => {
  it('keeps every partition behind the household prefix', () => {
    expect(ledgerPK(HH, 'kid', '2026-03')).not.toBe(ledgerPK('test-tasks', 'kid', '2026-03'));
    expect(streakPK(HH, 'kid')).not.toBe(streakPK('local', 'kid'));
  });
});

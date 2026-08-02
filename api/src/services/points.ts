import { randomUUID } from 'node:crypto';
import {
  CONFIG_ROWS,
  STREAK_DAILY_ALL,
  TABLES,
  actionQueuePK,
  actionQueueRK,
  configPK,
  configRK,
  ledgerPK,
  ledgerRK,
  memberPK,
  memberRK,
  redemptionPK,
  redemptionRK,
  rewardPK,
  rewardRK,
  streakPK,
  streakRK,
  taskInstancePK,
} from '../../../shared/keys.js';
import { canAfford } from '../../../shared/points.js';
import {
  DEFAULT_FREEZES,
  daysToNextTier,
  deadlineFor,
  effectiveLength,
  effectiveMultiplier,
  emptyStreak,
  isAlive,
  recordQualifyingDay,
  type StreakState,
} from '../../../shared/streaks.js';
import {
  addLocalDays,
  localDateNow,
  yearMonthNow,
  yearMonthOfLocalDate,
  type LocalDate,
} from '../../../shared/time.js';
import type {
  ActionQueueEntity,
  LeaderboardRow,
  LedgerEntity,
  LedgerEntry,
  MemberEntity,
  Redemption,
  RedemptionEntity,
  Reward,
  RewardEntity,
  StreakEntity,
  StreakView,
  TaskInstanceEntity,
} from '../../../shared/types.js';
import { env } from '../lib/env.js';
import { TaskError } from '../lib/errors.js';
import { writeFeedItem } from '../lib/feed.js';
import { listMembers, toMember, getMemberRow } from '../lib/members.js';
import { bumpRev } from '../lib/rev.js';
import { getEntity, listPartition, remove, updateWithRetry, upsert } from '../lib/tables.js';

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

function toState(row: StreakEntity | null): StreakState {
  if (!row) return emptyStreak();
  return {
    current: row.current,
    longest: row.longest,
    lastQualifiedDate: row.lastQualifiedDate,
    freezesRemaining: row.freezesRemaining,
  };
}

export async function readStreak(memberId: string, key = STREAK_DAILY_ALL): Promise<StreakState> {
  return toState(
    await getEntity<StreakEntity>(TABLES.streaks, streakPK(env.householdId, memberId), streakRK(key)),
  );
}

async function writeStreak(memberId: string, key: string, state: StreakState): Promise<void> {
  await upsert(TABLES.streaks, {
    partitionKey: streakPK(env.householdId, memberId),
    rowKey: streakRK(key),
    current: state.current,
    longest: state.longest,
    lastQualifiedDate: state.lastQualifiedDate,
    freezesRemaining: state.freezesRemaining,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * A day qualifies when every chore assigned to that member for the day is
 * approved — and there was at least one. "Did all my chores" is the thing
 * worth rewarding; partial credit would make the multiplier meaningless.
 */
export async function dayQualifies(memberId: string, date: LocalDate): Promise<boolean> {
  const rows = await listPartition<TaskInstanceEntity>(
    TABLES.taskInstances,
    taskInstancePK(env.householdId, date),
  );
  const mine = rows.filter((r) => r.assignedMemberId === memberId || r.completedBy === memberId);
  if (mine.length === 0) return false;
  return mine.every((r) => r.status === 'approved' || r.status === 'skipped');
}

/**
 * Re-evaluate a member's daily streak for `date`.
 *
 * Idempotent: recording the same day twice is a no-op inside the state
 * machine, so running this from both the approval path and the cron tick is
 * safe.
 */
export async function evaluateStreak(
  memberId: string,
  date: LocalDate,
): Promise<{ event: string; current: number }> {
  if (!(await dayQualifies(memberId, date))) {
    const existing = await readStreak(memberId);
    return { event: 'unchanged', current: existing.current };
  }

  const before = await readStreak(memberId);
  const outcome = recordQualifyingDay(before, date);

  if (outcome.event === 'unchanged') {
    return { event: 'unchanged', current: before.current };
  }

  await writeStreak(memberId, STREAK_DAILY_ALL, outcome.state);

  // Only shout about milestones. A feed item every single day would train
  // everyone to ignore the ticker.
  const milestone = [3, 7, 14, 30, 50, 100].includes(outcome.state.current);
  if (milestone || outcome.event === 'froze') {
    const member = await getMemberRow(memberId);
    if (member) {
      await writeFeedItem({
        kind: 'streak',
        headline:
          outcome.event === 'froze'
            ? `${member.displayName} used a streak freeze — ${outcome.state.current} days still standing`
            : `${member.displayName} is on a ${outcome.state.current}-day streak`,
        icon: '🔥',
        points: null,
        actor: { id: memberId, name: member.displayName, avatar: member.avatarEmoji },
        refType: 'streak',
        refId: STREAK_DAILY_ALL,
      });
    }
  }

  await bumpRev(['points']);
  return { event: outcome.event, current: outcome.state.current };
}

export async function streakView(memberId: string): Promise<StreakView> {
  const state = await readStreak(memberId);
  const today = localDateNow(env.timezone);
  const next = daysToNextTier(effectiveLength(state, today));

  return {
    key: STREAK_DAILY_ALL,
    current: effectiveLength(state, today),
    longest: state.longest,
    multiplier: effectiveMultiplier(state, today),
    alive: isAlive(state, today),
    deadline: deadlineFor(state),
    daysToNextTier: next?.days ?? null,
    nextTierMultiplier: next?.multiplier ?? null,
  };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * Standings.
 *
 * Ranked on APPROVED points only. Pending is reported alongside but never
 * folded in — a leaderboard that counts unapproved work is one kids stop
 * trusting the moment a chore gets sent back.
 */
export async function leaderboard(): Promise<LeaderboardRow[]> {
  const members = (await listMembers()).filter((m) => m.role === 'child');
  const today = localDateNow(env.timezone);

  const rows = await Promise.all(
    members.map(async (row) => {
      const member = toMember(row);
      const state = await readStreak(member.id);
      return {
        member,
        rank: 0,
        points: member.pointsBalance,
        pendingPoints: member.pendingPoints,
        streakDays: effectiveLength(state, today),
        streakMultiplier: effectiveMultiplier(state, today),
        streakAlive: isAlive(state, today),
      };
    }),
  );

  rows.sort((a, b) => b.points - a.points || a.member.displayName.localeCompare(b.member.displayName));

  // Ties share a rank rather than being ordered arbitrarily.
  let rank = 0;
  let previous: number | null = null;
  rows.forEach((r, i) => {
    if (previous === null || r.points !== previous) rank = i + 1;
    r.rank = rank;
    previous = r.points;
  });

  return rows;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** One month of a member's history — a single point-partition query. */
export async function memberLedger(memberId: string, yearMonth?: string): Promise<LedgerEntry[]> {
  const ym = yearMonth ?? yearMonthNow(env.timezone);
  const rows = await listPartition<LedgerEntity>(
    TABLES.ledger,
    ledgerPK(env.householdId, memberId, ym),
  );
  // Row keys use inverse ticks, so storage order is already newest-first.
  return rows.map((r) => ({
    id: r.rowKey,
    delta: r.delta,
    kind: r.kind,
    description: r.description,
    balanceAfter: r.balanceAfter,
    createdAt: r.createdAt,
  }));
}

/**
 * A member's recent history, for the default view.
 *
 * Month bucketing is right for storage — it bounds partition size forever — but
 * wrong as a default view: on the 2nd of the month "this month" is one entry,
 * and the points screen reads as broken. So when the current month is thin,
 * reach back one more partition. Still two point queries, never a scan.
 */
export async function recentLedger(memberId: string, minimum = 8): Promise<LedgerEntry[]> {
  const now = Date.now();
  const current = await memberLedger(memberId, yearMonthNow(env.timezone, now));
  if (current.length >= minimum) return current;

  const firstOfThisMonth = `${yearMonthNow(env.timezone, now)}-01`;
  const previous = await memberLedger(
    memberId,
    yearMonthOfLocalDate(addLocalDays(firstOfThisMonth, -1)),
  );
  return [...current, ...previous].slice(0, Math.max(minimum, current.length) + minimum);
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

export async function listRewards(forMemberId?: string): Promise<Reward[]> {
  const rows = await listPartition<RewardEntity>(TABLES.rewards, rewardPK(env.householdId));
  const member = forMemberId ? await getMemberRow(forMemberId) : null;

  return rows
    .filter((r) => r.active)
    .map((r) => {
      const restricted = safeArray(r.restrictedToMemberIdsJson);
      return {
        id: r.rowKey,
        title: r.title,
        description: r.description,
        cost: r.cost,
        icon: r.icon,
        stock: r.stock,
        restrictedToMemberIds: restricted,
        active: r.active,
        affordable: member ? canAfford(member.pointsBalance, r.cost) : undefined,
      };
    })
    .filter((r) => !forMemberId || r.restrictedToMemberIds.length === 0 || r.restrictedToMemberIds.includes(forMemberId))
    .sort((a, b) => a.cost - b.cost);
}

export async function upsertReward(
  input: {
    id?: string;
    title: string;
    description?: string | null;
    cost: number;
    icon?: string | null;
    stock?: number;
    restrictedToMemberIds?: string[];
    active?: boolean;
  },
  createdBy: string,
): Promise<string> {
  const id = input.id ?? randomUUID();
  const entity: RewardEntity & { partitionKey: string; rowKey: string } = {
    partitionKey: rewardPK(env.householdId),
    rowKey: rewardRK(id),
    title: input.title,
    description: input.description ?? null,
    cost: Math.max(0, Math.round(input.cost)),
    icon: input.icon ?? null,
    stock: input.stock ?? -1,
    requiresApproval: true,
    restrictedToMemberIdsJson: JSON.stringify(input.restrictedToMemberIds ?? []),
    active: input.active ?? true,
    createdBy,
    createdAt: new Date().toISOString(),
  };
  await upsert(TABLES.rewards, entity);
  await bumpRev(['rewards']);
  return id;
}

/**
 * Retire a reward.
 *
 * Deactivates rather than deletes: past redemptions reference it, and the
 * history has to keep saying what was bought even after the catalog moves on.
 * (`Redemptions` denormalizes the title for exactly the same reason, so this is
 * belt and braces.)
 */
export async function deactivateReward(rewardId: string): Promise<void> {
  const existing = await getEntity<RewardEntity>(
    TABLES.rewards,
    rewardPK(env.householdId),
    rewardRK(rewardId),
  );
  if (!existing) throw new TaskError('That reward is not in the catalog.', 404);

  await upsert(TABLES.rewards, {
    partitionKey: rewardPK(env.householdId),
    rowKey: rewardRK(rewardId),
    active: false,
  });
  await bumpRev(['rewards']);
}

// ---------------------------------------------------------------------------
// Redemptions
// ---------------------------------------------------------------------------

/**
 * Request a reward.
 *
 * Points are debited immediately, not on approval. If they were only held, a
 * kid could queue five redemptions they can each individually afford but not
 * collectively — and a parent approving all five would drive the balance
 * negative. Debiting up front makes the ledger the single source of truth and
 * a rejection simply refunds.
 */
export async function requestRedemption(
  rewardId: string,
  member: { id: string; displayName: string; avatarEmoji: string },
): Promise<{ redemptionId: string; cost: number }> {
  const reward = await getEntity<RewardEntity>(
    TABLES.rewards,
    rewardPK(env.householdId),
    rewardRK(rewardId),
  );
  if (!reward || !reward.active) throw new TaskError('That reward is not available.', 404);

  const restricted = safeArray(reward.restrictedToMemberIdsJson);
  if (restricted.length > 0 && !restricted.includes(member.id)) {
    throw new TaskError('That reward is not available to you.', 403);
  }
  if (reward.stock === 0) throw new TaskError('That reward is out of stock.', 409);

  const row = await getMemberRow(member.id);
  if (!row) throw new TaskError('That account no longer exists.', 404);
  if (!canAfford(row.pointsBalance, reward.cost)) {
    throw new TaskError('Not enough points yet.', 409);
  }

  const now = Date.now();
  const redemptionId = randomUUID();
  const entryId = randomUUID();

  // Ledger first, as with approvals — it is the authoritative record.
  await upsert(TABLES.ledger, {
    partitionKey: ledgerPK(env.householdId, member.id, yearMonthNow(env.timezone, now)),
    rowKey: ledgerRK(now, entryId),
    delta: -reward.cost,
    kind: 'redemption',
    refType: 'reward',
    refId: rewardId,
    description: reward.title,
    balanceAfter: row.pointsBalance - reward.cost,
    actorMemberId: member.id,
    createdAt: new Date(now).toISOString(),
  } satisfies LedgerEntity & { partitionKey: string; rowKey: string });

  await upsert(TABLES.redemptions, {
    partitionKey: redemptionPK(env.householdId, member.id),
    rowKey: redemptionRK(now, redemptionId),
    rewardId,
    // Denormalized: the catalog entry may be deleted later, and the history
    // still has to say what was bought.
    rewardTitle: reward.title,
    cost: reward.cost,
    status: 'pending',
    requestedAt: new Date(now).toISOString(),
    resolvedAt: null,
    resolvedBy: null,
    ledgerEntryId: entryId,
    note: null,
  } satisfies RedemptionEntity & { partitionKey: string; rowKey: string });

  await updateWithRetry<MemberEntity>(
    TABLES.members,
    memberPK(env.householdId),
    memberRK(member.id),
    (current) => ({
      partitionKey: current.partitionKey,
      rowKey: current.rowKey,
      pointsBalance: (current.pointsBalance ?? 0) - reward.cost,
    }),
  );

  if (reward.stock > 0) {
    await upsert(TABLES.rewards, {
      partitionKey: rewardPK(env.householdId),
      rowKey: rewardRK(rewardId),
      stock: reward.stock - 1,
    });
  }

  // Same queue as chore approvals: one badge, one screen, one habit.
  await upsert(TABLES.actionQueue, {
    partitionKey: actionQueuePK(env.householdId),
    rowKey: actionQueueRK(now, 'redemption', redemptionId),
    kind: 'redemption',
    refPartitionKey: redemptionPK(env.householdId, member.id),
    refRowKey: redemptionRK(now, redemptionId),
    memberId: member.id,
    memberName: member.displayName,
    memberAvatar: member.avatarEmoji,
    title: reward.title,
    points: reward.cost,
    dueDateLocal: null,
    note: null,
    createdAt: new Date(now).toISOString(),
  } satisfies ActionQueueEntity & { partitionKey: string; rowKey: string });

  await writeFeedItem({
    kind: 'redemption',
    headline: `${member.displayName} redeemed “${reward.title}”`,
    icon: reward.icon ?? '🎁',
    points: -reward.cost,
    actor: { id: member.id, name: member.displayName, avatar: member.avatarEmoji },
    refType: 'reward',
    refId: rewardId,
  });

  await bumpRev(['points', 'queue', 'rewards', 'members']);
  return { redemptionId, cost: reward.cost };
}

/** Fulfil or refuse a redemption. Refusing refunds, because the debit already happened. */
export async function resolveRedemption(
  queueRowKey: string,
  action: 'fulfil' | 'refuse',
  resolver: { id: string },
): Promise<void> {
  const queueRow = await getEntity<ActionQueueEntity>(
    TABLES.actionQueue,
    actionQueuePK(env.householdId),
    queueRowKey,
  );
  if (!queueRow) throw new TaskError('That item is no longer waiting.', 404);
  if (queueRow.kind !== 'redemption') throw new TaskError('Wrong kind of item.', 400);

  const row = await getEntity<RedemptionEntity>(
    TABLES.redemptions,
    queueRow.refPartitionKey,
    queueRow.refRowKey,
  );

  if (row && row.status === 'pending') {
    if (action === 'refuse') {
      // Refund: a reversal entry rather than deleting the original, so the
      // ledger stays append-only and the history still shows what happened.
      const now = Date.now();
      const entryId = randomUUID();
      const member = await getMemberRow(queueRow.memberId);

      await upsert(TABLES.ledger, {
        partitionKey: ledgerPK(env.householdId, queueRow.memberId, yearMonthNow(env.timezone, now)),
        rowKey: ledgerRK(now, entryId),
        delta: row.cost,
        kind: 'reversal',
        refType: 'redemption',
        refId: queueRow.refRowKey,
        description: `Refund — ${row.rewardTitle}`,
        balanceAfter: (member?.pointsBalance ?? 0) + row.cost,
        actorMemberId: resolver.id,
        createdAt: new Date(now).toISOString(),
      } satisfies LedgerEntity & { partitionKey: string; rowKey: string });

      await updateWithRetry<MemberEntity>(
        TABLES.members,
        memberPK(env.householdId),
        memberRK(queueRow.memberId),
        (current) => ({
          partitionKey: current.partitionKey,
          rowKey: current.rowKey,
          pointsBalance: (current.pointsBalance ?? 0) + row.cost,
        }),
      );
    }

    await upsert(TABLES.redemptions, {
      partitionKey: queueRow.refPartitionKey,
      rowKey: queueRow.refRowKey,
      status: action === 'fulfil' ? 'fulfilled' : 'rejected',
      resolvedAt: new Date().toISOString(),
      resolvedBy: resolver.id,
    });
  }

  // Queue row last, same ordering rule as chore approval.
  await remove(TABLES.actionQueue, queueRow.partitionKey, queueRow.rowKey);
  await bumpRev(['points', 'queue', 'members']);
}

export async function listRedemptions(memberId: string): Promise<Redemption[]> {
  const rows = await listPartition<RedemptionEntity>(
    TABLES.redemptions,
    redemptionPK(env.householdId, memberId),
  );
  return rows.map((r) => ({
    id: r.rowKey,
    rewardId: r.rewardId,
    rewardTitle: r.rewardTitle,
    cost: r.cost,
    status: r.status,
    requestedAt: r.requestedAt,
  }));
}

// ---------------------------------------------------------------------------
// Wildcards
// ---------------------------------------------------------------------------

const WILDCARD_MULTIPLIER = 2;
const WILDCARD_REASON = 'Wildcard — double points';

/**
 * Turn a couple of today's open chores into double-points wildcards.
 *
 * Guarded to once per local day in Config, because the cron tick is
 * at-least-once and re-rolling every hour would mean every chore is eventually
 * a wildcard — which is the same as none of them being one.
 *
 * Only untouched, unclaimed-or-assigned OPEN chores are eligible. Marking
 * something already ticked off would be paying a bonus for work that was done
 * without knowing the bonus existed, which is not what a wildcard is for.
 */
export async function rollWildcards(
  date: LocalDate,
  count = 2,
): Promise<{ rolled: number; alreadyRolled: boolean }> {
  const guard = await getEntity<{ lastRolledDate: string }>(
    TABLES.config,
    configPK(env.householdId),
    configRK(CONFIG_ROWS.wildcards),
  );
  if (guard?.lastRolledDate === date) return { rolled: 0, alreadyRolled: true };

  const rows = await listPartition<TaskInstanceEntity>(
    TABLES.taskInstances,
    taskInstancePK(env.householdId, date),
  );
  const eligible = (rows as Array<TaskInstanceEntity & { partitionKey: string; rowKey: string }>)
    .filter((r) => r.status === 'open' && r.multiplier === 1);

  // Fisher-Yates on a copy, then take the first `count`.
  for (let i = eligible.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [eligible[i], eligible[j]] = [eligible[j]!, eligible[i]!];
  }
  const chosen = eligible.slice(0, count);

  for (const row of chosen) {
    await upsert(TABLES.taskInstances, {
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
      multiplier: WILDCARD_MULTIPLIER,
      bonusReason: WILDCARD_REASON,
    });
  }

  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.wildcards),
    lastRolledDate: date,
    lastRolledCount: chosen.length,
    updatedAt: new Date().toISOString(),
  });

  if (chosen.length > 0) {
    await writeFeedItem({
      kind: 'wildcard',
      headline:
        chosen.length === 1
          ? `Wildcard! “${chosen[0]!.title}” is worth double today`
          : `${chosen.length} wildcards on the board today — double points`,
      detail: chosen.map((c) => c.title).join(' · '),
      icon: '🃏',
      points: null,
    });
    await bumpRev(['tasks', 'points']);
  }

  return { rolled: chosen.length, alreadyRolled: false };
}

// ---------------------------------------------------------------------------
// Manual adjustment
// ---------------------------------------------------------------------------

/**
 * A parent moving points by hand.
 *
 * Step-up authentication is enforced at the endpoint, not here. The ledger
 * entry names the parent who did it: an adjustment nobody can trace is how a
 * points economy loses its credibility.
 */
export async function adjustPoints(
  memberId: string,
  delta: number,
  reason: string,
  actor: { id: string; displayName: string },
): Promise<{ balance: number }> {
  const rounded = Math.round(delta);
  if (rounded === 0) throw new TaskError('That would not change anything.', 400);

  const row = await getMemberRow(memberId);
  if (!row) throw new TaskError('That family member no longer exists.', 404);

  const now = Date.now();
  await upsert(TABLES.ledger, {
    partitionKey: ledgerPK(env.householdId, memberId, yearMonthNow(env.timezone, now)),
    rowKey: ledgerRK(now, randomUUID()),
    delta: rounded,
    kind: 'manual_adjust',
    refType: 'member',
    refId: actor.id,
    description: reason,
    balanceAfter: row.pointsBalance + rounded,
    actorMemberId: actor.id,
    createdAt: new Date(now).toISOString(),
  } satisfies LedgerEntity & { partitionKey: string; rowKey: string });

  await updateWithRetry<MemberEntity>(
    TABLES.members,
    memberPK(env.householdId),
    memberRK(memberId),
    (current) => ({
      partitionKey: current.partitionKey,
      rowKey: current.rowKey,
      pointsBalance: (current.pointsBalance ?? 0) + rounded,
      // Only gains count toward lifetime; a correction should not inflate it.
      lifetimePoints: (current.lifetimePoints ?? 0) + Math.max(0, rounded),
    }),
  );

  await writeFeedItem({
    kind: 'adjustment',
    headline: `${actor.displayName} ${rounded > 0 ? 'awarded' : 'deducted'} ${Math.abs(rounded)} points ${rounded > 0 ? 'to' : 'from'} ${row.displayName}`,
    detail: reason,
    icon: rounded > 0 ? '✨' : '➖',
    points: rounded,
    actor: { id: memberId, name: row.displayName, avatar: row.avatarEmoji },
    // A parent's stated reason is the whole content here; a generated quip on
    // top of a correction would read as mockery.
    eligibleForCommentary: false,
  });

  await bumpRev(['points', 'members']);
  return { balance: row.pointsBalance + rounded };
}

// ---------------------------------------------------------------------------

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

export { DEFAULT_FREEZES };

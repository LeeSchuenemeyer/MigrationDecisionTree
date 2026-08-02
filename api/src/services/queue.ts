import { TABLES, actionQueuePK } from '../../../shared/keys.js';
import type { ActionQueueEntity } from '../../../shared/types.js';
import { env } from '../lib/env.js';
import { TaskError } from '../lib/errors.js';
import { getEntity } from '../lib/tables.js';
import { resolveRedemption } from './points.js';
import { approveTask, rejectTask } from './tasks.js';

/**
 * One queue, one verb pair.
 *
 * Chore approvals and reward redemptions land in the same partition on purpose:
 * a parent should have one badge, one screen, and one habit rather than two
 * places to remember to check. That only pays off if the *endpoints* are
 * unified too — otherwise the client has to know which kind a row is before it
 * can act on it, and the single screen quietly grows a branch for every kind we
 * add later.
 *
 * So the dispatch happens here, on the row's own `kind`. The cost is one extra
 * point read, which is nothing against the clarity it buys on both sides.
 */
export type QueueAction = 'approve' | 'reject';

export interface QueueResolution {
  kind: ActionQueueEntity['kind'];
  /** Points that moved, signed. Zero for a rejection. */
  delta: number;
  memberId: string;
}

export async function resolveQueueItem(
  rowKey: string,
  action: QueueAction,
  resolver: { id: string; displayName: string },
  note?: string,
): Promise<QueueResolution> {
  const row = await getEntity<ActionQueueEntity>(
    TABLES.actionQueue,
    actionQueuePK(env.householdId),
    rowKey,
  );
  if (!row) throw new TaskError('That item is no longer waiting.', 404);

  if (row.kind === 'redemption') {
    await resolveRedemption(rowKey, action === 'approve' ? 'fulfil' : 'refuse', resolver);
    // The debit already happened at request time, so fulfilling moves nothing
    // and refusing refunds. See requestRedemption for why.
    return {
      kind: 'redemption',
      delta: action === 'approve' ? 0 : row.points,
      memberId: row.memberId,
    };
  }

  if (action === 'reject') {
    await rejectTask(rowKey, resolver, note);
    return { kind: row.kind, delta: 0, memberId: row.memberId };
  }

  const result = await approveTask(rowKey, resolver);
  return { kind: row.kind, delta: result.awarded, memberId: result.memberId };
}

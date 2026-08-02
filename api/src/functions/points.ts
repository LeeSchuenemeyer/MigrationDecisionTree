import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import { STREAK_DAILY_ALL } from '../../../shared/keys.js';
import { env } from '../lib/env.js';
import { badRequest, json } from '../lib/http.js';
import { requireElevated, requireMember, requireParent, requireRead } from '../lib/auth.js';
import { getMemberRow } from '../lib/members.js';
import {
  adjustPoints,
  deactivateReward,
  leaderboard,
  listRedemptions,
  listRewards,
  memberLedger,
  recentLedger,
  requestRedemption,
  rollWildcards,
  streakView,
  upsertReward,
} from '../services/points.js';
import { today } from '../services/tasks.js';
import { taskGuard } from './tasks.js';

/**
 * The points economy over HTTP.
 *
 * Reads take `requireRead`, so the wall tablet renders standings with nobody
 * signed in — that is the entire point of the device credential. Everything
 * that moves points takes a member session, and the two operations a kid could
 * not undo (manual adjustment, retiring a reward) take step-up on top.
 */

const YearMonth = z.string().regex(/^\d{4}-\d{2}$/);

/** GET /api/leaderboard — standings, streaks, and pending, in one call. */
export async function getLeaderboard(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  return json({ rows: await leaderboard(), today: today() });
}

/**
 * GET /api/points/{memberId}?month=YYYY-MM
 *
 * One month is one point-partition query, and the rows arrive newest-first
 * because the row key is inverse ticks — no client-side sort, ever.
 */
export async function getMemberPoints(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);

  const memberId = req.params['memberId'];
  if (!memberId) return badRequest('Which family member?');

  const month = req.query.get('month');
  if (month && !YearMonth.safeParse(month).success) {
    return badRequest('Month must look like YYYY-MM.');
  }

  const member = await getMemberRow(memberId);
  if (!member) return badRequest('No such family member.');

  const [entries, streak, redemptions] = await Promise.all([
    month ? memberLedger(memberId, month) : recentLedger(memberId),
    streakView(memberId),
    listRedemptions(memberId),
  ]);

  return json({
    memberId,
    displayName: member.displayName,
    pointsBalance: member.pointsBalance,
    pendingPoints: member.pendingPoints,
    lifetimePoints: member.lifetimePoints,
    entries,
    streak,
    redemptions,
  });
}

/** GET /api/streaks/{memberId} — the flame, and how far the next tier is. */
export async function getStreak(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  const memberId = req.params['memberId'];
  if (!memberId) return badRequest('Which family member?');
  return json({ streak: await streakView(memberId), key: STREAK_DAILY_ALL });
}

/**
 * GET /api/rewards
 *
 * Affordability is computed per viewer, so the catalog can grey out what the
 * signed-in child cannot buy yet rather than letting them tap and be refused.
 */
export async function getRewards(req: HttpRequest): Promise<HttpResponseInit> {
  const { session } = await requireRead(req);
  const forMember = req.query.get('for') ?? session?.memberId ?? undefined;
  return json({ rewards: await listRewards(forMember) });
}

const RewardBody = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1).max(80),
  description: z.string().max(280).nullish(),
  cost: z.number().int().min(0).max(100_000),
  icon: z.string().max(8).nullish(),
  stock: z.number().int().min(-1).max(9999).optional(),
  restrictedToMemberIds: z.array(z.string().min(1)).max(20).optional(),
  active: z.boolean().optional(),
});

/** POST /api/rewards — create or edit a catalog entry. */
export async function postReward(req: HttpRequest): Promise<HttpResponseInit> {
  const { session } = await requireParent(req);

  const parsed = RewardBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('A reward needs a title and a cost.');

  const id = await upsertReward(parsed.data, session.memberId);
  return json({ id });
}

/**
 * DELETE /api/rewards/{id}
 *
 * Step-up, because removing a reward changes what points are *for* — the
 * exchange rate is the load-bearing part of a points economy, and a kid saving
 * up for something that quietly vanishes is the fastest way to lose them.
 */
export async function deleteReward(req: HttpRequest): Promise<HttpResponseInit> {
  await requireElevated(req);
  const id = req.params['id'];
  if (!id) return badRequest('Which reward?');
  await deactivateReward(decodeURIComponent(id));
  return json({ ok: true });
}

/** POST /api/rewards/{id}/redeem — debits now, queues for a parent. */
export async function postRedeem(req: HttpRequest): Promise<HttpResponseInit> {
  const session = await requireMember(req);
  const id = req.params['id'];
  if (!id) return badRequest('Which reward?');

  const member = await getMemberRow(session.memberId);
  if (!member) return badRequest('That account no longer exists.');

  const result = await requestRedemption(decodeURIComponent(id), {
    id: session.memberId,
    displayName: member.displayName,
    avatarEmoji: member.avatarEmoji,
  });
  return json(result);
}

const AdjustBody = z.object({
  memberId: z.string().min(1),
  delta: z.number().int().min(-10_000).max(10_000),
  reason: z.string().min(1).max(140),
});

/** POST /api/points/adjust — a parent moving points by hand. Step-up required. */
export async function postAdjust(req: HttpRequest): Promise<HttpResponseInit> {
  const { session, member } = await requireElevated(req);

  const parsed = AdjustBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('An adjustment needs a member, an amount, and a reason.');

  const result = await adjustPoints(parsed.data.memberId, parsed.data.delta, parsed.data.reason, {
    id: session.memberId,
    displayName: member.displayName,
  });
  return json(result);
}

/** POST /api/admin/wildcards — roll today's double-points chores. Once per day. */
export async function postWildcards(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);
  return json(await rollWildcards(today()));
}

app.http('leaderboard', { route: 'leaderboard', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getLeaderboard) });
app.http('points-member', { route: 'points/{memberId}', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getMemberPoints) });
app.http('points-adjust', { route: 'points/adjust', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postAdjust) });
app.http('streak-member', { route: 'streaks/{memberId}', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getStreak) });
app.http('rewards-list', { route: 'rewards', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getRewards) });
app.http('rewards-upsert', { route: 'rewards', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postReward) });
app.http('rewards-delete', { route: 'rewards/{id}', methods: ['DELETE'], authLevel: 'anonymous', handler: taskGuard(deleteReward) });
app.http('rewards-redeem', { route: 'rewards/{id}/redeem', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postRedeem) });
app.http('admin-wildcards', { route: 'admin/wildcards', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postWildcards) });

export const _env = env;

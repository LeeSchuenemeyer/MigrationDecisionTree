import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import { assertLocalDate, localDateNow } from '../../../shared/time.js';
import { requireParent, requireRead } from '../lib/auth.js';
import { DAILY_CAPS, isConfigured, readBudget } from '../lib/claude.js';
import { householdConfig, updateHouseholdConfig } from '../lib/config.js';
import { env } from '../lib/env.js';
import { badRequest, json } from '../lib/http.js';
import { listIncidents, suppressFeedItem } from '../services/commentary.js';
import { currentChallenge } from '../services/challenge.js';
import { listAwards } from '../services/achievements.js';
import { taskGuard } from './tasks.js';

/**
 * The parent-facing controls for generated content.
 *
 * Two of these are the feature's safety valve rather than settings:
 * `commentaryEnabled` turns the whole thing off in one tap (leaving a
 * facts-only ticker that breaks nothing), and the suppress endpoint takes a
 * single line off the wall immediately. Both belong to parents only.
 */

/** GET /api/claude/status — is it on, is it configured, what has it spent. */
export async function getStatus(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  const [config, used] = await Promise.all([householdConfig(), readBudget()]);

  return json({
    configured: isConfigured(),
    enabled: config.commentaryEnabled,
    challengeEnabled: config.challengeEnabled,
    budget: (Object.keys(DAILY_CAPS) as Array<keyof typeof DAILY_CAPS>).map((job) => ({
      job,
      used: used[job],
      cap: DAILY_CAPS[job],
    })),
  });
}

const SettingsBody = z.object({
  commentaryEnabled: z.boolean().optional(),
  challengeEnabled: z.boolean().optional(),
  extraDenylist: z.array(z.string().min(1).max(40)).max(100).optional(),
});

/**
 * POST /api/claude/settings
 *
 * Deliberately requireParent rather than requireElevated: a parent who wants
 * the commentary off — because something landed badly — should not have to
 * re-enter a PIN first. Turning a feature OFF is never the destructive
 * direction.
 */
export async function postSettings(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);

  const parsed = SettingsBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('Could not read those settings.');

  const { extraDenylist, ...rest } = parsed.data;
  await updateHouseholdConfig({
    ...rest,
    ...(extraDenylist ? { extraDenylistJson: JSON.stringify(extraDenylist) } : {}),
  });

  return json(await householdConfig());
}

const SuppressBody = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().max(200).optional(),
});

/**
 * POST /api/feed/{id}/suppress — the "that wasn't ok" button.
 *
 * One tap, no confirmation dialog, no explanation required. If a parent has to
 * think about whether it is worth reporting, the control has already failed:
 * the thing is on a kitchen wall right now and the only correct default is that
 * it comes down first and gets discussed second.
 */
export async function postSuppress(req: HttpRequest): Promise<HttpResponseInit> {
  const { session } = await requireParent(req);

  const id = req.params['id'];
  if (!id) return badRequest('Which item?');

  const parsed = SuppressBody.safeParse(await req.json().catch(() => ({})));
  const date = parsed.success && parsed.data.date ? parsed.data.date : localDateNow(env.timezone);
  try {
    assertLocalDate(date);
  } catch {
    return badRequest('Bad date.');
  }

  const ok = await suppressFeedItem(
    date,
    decodeURIComponent(id),
    session.memberId,
    parsed.success ? (parsed.data.reason ?? 'Flagged by a parent') : 'Flagged by a parent',
  );
  if (!ok) return badRequest('That item is not on the board.');

  return json({ ok: true });
}

/** GET /api/claude/incidents — what got flagged, so the rubric can be tuned. */
export async function getIncidents(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);
  return json({ incidents: await listIncidents(14) });
}

/** GET /api/challenge — today's goal. Pure storage read; never generates. */
export async function getChallenge(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  return json({ challenge: await currentChallenge() });
}

/** GET /api/achievements/{memberId} — the trophy case. */
export async function getAchievements(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  const memberId = req.params['memberId'];
  if (!memberId) return badRequest('Which family member?');
  return json({ achievements: await listAwards(memberId) });
}

app.http('claude-status', { route: 'claude/status', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getStatus) });
app.http('claude-settings', { route: 'claude/settings', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postSettings) });
app.http('claude-incidents', { route: 'claude/incidents', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getIncidents) });
app.http('feed-suppress', { route: 'feed/{id}/suppress', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postSuppress) });
app.http('challenge', { route: 'challenge', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getChallenge) });
app.http('achievements-member', { route: 'achievements/{memberId}', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getAchievements) });

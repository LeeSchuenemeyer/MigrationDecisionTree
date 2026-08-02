import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import { addLocalDays } from '../../../shared/time.js';
import { env } from '../lib/env.js';
import { badRequest, error, json } from '../lib/http.js';
import { requireMember, requireParent, requireRead } from '../lib/auth.js';
import { getMemberRow } from '../lib/members.js';
import { materialize } from '../services/materializer.js';
import {
  TaskError,
  completeTask,
  listQueue,
  listTasksBetween,
  listTasksForDate,
  today,
} from '../services/tasks.js';
import { resolveQueueItem } from '../services/queue.js';
import { guarded } from './auth.js';

const DateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * GET /api/tasks?from&to
 *
 * Materializes lazily before reading. The watermark check makes that a single
 * point read on virtually every call, and because the kiosk polls all day this
 * is what actually keeps instances current — the cron tick is insurance, not
 * the primary mechanism. SWA has no timer trigger to rely on.
 */
export async function getTasks(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);

  const from = req.query.get('from') ?? today();
  const to = req.query.get('to') ?? from;
  if (!DateParam.safeParse(from).success || !DateParam.safeParse(to).success) {
    return badRequest('Dates must look like YYYY-MM-DD.');
  }

  await materialize();

  const tasks = from === to ? await listTasksForDate(from) : await listTasksBetween(from, to);
  return json({ tasks, from, to, today: today() });
}

const CompleteBody = z.object({
  date: DateParam,
  instanceId: z.string().min(1),
});

/** POST /api/tasks/complete — the tap. */
export async function postComplete(req: HttpRequest): Promise<HttpResponseInit> {
  const session = await requireMember(req);

  const parsed = CompleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('Which chore?');

  const member = await getMemberRow(session.memberId);
  if (!member) return error('That account no longer exists.', 403);

  const task = await completeTask(parsed.data.date, parsed.data.instanceId, {
    id: session.memberId,
    displayName: member.displayName,
    avatarEmoji: member.avatarEmoji,
  });
  return json({ task });
}

/** GET /api/queue — everything waiting on a parent, one query, zero fan-out. */
export async function getQueue(req: HttpRequest): Promise<HttpResponseInit> {
  await requireRead(req);
  return json({ items: await listQueue() });
}

const ResolveBody = z.object({ note: z.string().max(280).optional() });

/**
 * POST /api/queue/{id}/approve and /reject.
 *
 * Deliberately polymorphic: the same two endpoints resolve a chore approval and
 * a reward redemption, dispatching on the queue row's own kind. The client
 * shows one list with one pair of buttons and never has to know the difference
 * — which is the only way the "one queue, one habit" design actually pays off.
 */
function resolveHandler(action: 'approve' | 'reject') {
  return async (req: HttpRequest): Promise<HttpResponseInit> => {
    const { session, member } = await requireParent(req);
    const id = req.params['id'];
    if (!id) return badRequest('Which item?');

    const body = ResolveBody.safeParse(await req.json().catch(() => ({})));
    const result = await resolveQueueItem(
      decodeURIComponent(id),
      action,
      { id: session.memberId, displayName: member.displayName },
      body.success ? body.data.note : undefined,
    );
    return json({ ok: true, ...result });
  };
}

export const postApprove = resolveHandler('approve');
export const postReject = resolveHandler('reject');

/** POST /api/admin/materialize — for when a parent adds a chore and wants it now. */
export async function postMaterialize(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);
  const result = await materialize(addLocalDays(today(), 14));
  return json(result);
}

/** Maps TaskError alongside AuthError. Shared with the points endpoints. */
export function taskGuard(handler: (req: HttpRequest) => Promise<HttpResponseInit>) {
  return guarded(async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof TaskError) return error(e.message, e.status);
      throw e;
    }
  });
}

app.http('tasks-list', { route: 'tasks', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getTasks) });
app.http('tasks-complete', { route: 'tasks/complete', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postComplete) });
app.http('queue-list', { route: 'queue', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getQueue) });
app.http('queue-approve', { route: 'queue/{id}/approve', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postApprove) });
app.http('queue-reject', { route: 'queue/{id}/reject', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postReject) });
app.http('admin-materialize', { route: 'admin/materialize', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postMaterialize) });

export const _env = env;

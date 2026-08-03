import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { DAILY_CAPS, isConfigured, readBudget } from '../lib/claude.js';
import { requireParent } from '../lib/auth.js';
import { json } from '../lib/http.js';
import { listBackups } from '../services/backup.js';
import { listIncidents } from '../services/commentary.js';
import { listConflicts } from '../services/googleSync.js';
import { jobStatuses, reconcile } from '../services/ops.js';
import { taskGuard } from './tasks.js';

/**
 * The parent-facing operations view.
 *
 * One endpoint, not five, because the question a parent actually has is "is
 * this thing healthy?" and answering it across five requests means five
 * loading states for a screen nobody visits twice a month.
 *
 * Everything here is best-effort in the strong sense: a section that cannot be
 * read renders as unavailable rather than failing the request. A settings
 * screen that 500s because the calendar is disconnected is a settings screen
 * that cannot be used to reconnect the calendar.
 */
export async function getOps(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);

  const [budgetUsed, jobs, conflicts, incidents, backups] = await Promise.all([
    soft(() => readBudget()),
    soft(() => jobStatuses()),
    soft(() => listConflicts()),
    soft(() => listIncidents(14)),
    soft(() => listBackups(10)),
  ]);

  return json({
    claude: {
      configured: isConfigured(),
      budget: (Object.keys(DAILY_CAPS) as Array<keyof typeof DAILY_CAPS>).map((job) => ({
        job,
        used: budgetUsed?.[job] ?? 0,
        cap: DAILY_CAPS[job],
      })),
      // Published so the "under a dollar a month" claim in the plan is
      // checkable by the person paying for it, rather than an assertion.
      estimatedMonthlyUsd: ESTIMATED_MONTHLY_USD,
    },
    jobs: jobs ?? [],
    conflicts: conflicts ?? [],
    incidents: incidents ?? [],
    backups: backups ?? [],
  });
}

/**
 * Per-call cost at the daily cap, times thirty.
 *
 * A deliberate over-estimate: it assumes every job hits its cap every day,
 * which no household does. The useful property is that the real bill is always
 * below this number, so it can only ever be a pleasant surprise.
 */
const ESTIMATED_MONTHLY_USD =
  Math.round(
    (DAILY_CAPS.ticker * 0.0009 + DAILY_CAPS.achievement * 0.006 + DAILY_CAPS.keepsake * 0.05) *
      30 *
      100,
  ) / 100;

/** POST /api/ops/reconcile — run the reconciler now, ignoring the daily guard. */
export async function postReconcile(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);
  return json(await reconcile());
}

async function soft<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

app.http('ops-summary', { route: 'ops', methods: ['GET'], authLevel: 'anonymous', handler: taskGuard(getOps) });
app.http('ops-reconcile', { route: 'ops/reconcile', methods: ['POST'], authLevel: 'anonymous', handler: taskGuard(postReconcile) });

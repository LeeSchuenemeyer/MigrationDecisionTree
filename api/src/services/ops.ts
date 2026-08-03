import {
  TABLES,
  configPK,
  configRK,
  ledgerPK,
  memberPK,
  pinAttemptPK,
  sessionPK,
} from '../../../shared/keys.js';
import { addLocalDays, localDateNow, type LocalDate } from '../../../shared/time.js';
import { env } from '../lib/env.js';
import { getEntity, listPartition, remove, upsert, updateWithRetry } from '../lib/tables.js';
import { bumpRev } from '../lib/rev.js';

/**
 * Housekeeping.
 *
 * Everything here is driven by the cron tick, which is best-effort by
 * construction: GitHub Actions cron runs 5-20 minutes late under load and
 * GitHub disables scheduled workflows after 60 days of repository inactivity.
 * So nothing in this file may be load-bearing for correctness — each job either
 * repairs a cache the app can rebuild, or removes rows whose absence changes
 * nothing. If the tick never fires again, the family notices nothing for weeks.
 */

// ---------------------------------------------------------------------------
// The once-a-day guard
// ---------------------------------------------------------------------------

interface JobRow {
  lastRunDate: string;
  lastRunAt: string;
  lastResultJson: string;
}

const jobRK = (job: string) => configRK(`job_${job}`);

/**
 * Run `fn` at most once per household-local day.
 *
 * The claim is written BEFORE the work, and conditionally: two ticks arriving
 * together (a delayed run overlapping the next hour's, which Actions does
 * produce) both read "not run today", and only the one whose ETag-guarded write
 * lands gets to proceed. Claiming afterwards would let both run.
 *
 * The cost of that ordering is that a job which crashes has burned its day.
 * That is the right trade here: every one of these is a repair job, and a
 * repair skipped for a day is invisible, while a reconciler that runs twenty
 * times because it keeps failing at the end is not.
 */
export async function runOncePerLocalDay<T>(
  job: string,
  fn: () => Promise<T>,
  date: LocalDate = localDateNow(env.timezone),
): Promise<T | { skipped: 'already ran today' }> {
  const pk = configPK(env.householdId);
  const rk = jobRK(job);

  const existing = await getEntity<JobRow>(TABLES.config, pk, rk);

  if (!existing) {
    // First ever run of this job. `upsert` rather than a conditional create
    // because two racing ticks on day one is a theoretical problem whose worst
    // outcome is one duplicated repair pass.
    await upsert(TABLES.config, { partitionKey: pk, rowKey: rk, lastRunDate: date });
  } else {
    if (existing.lastRunDate === date) return { skipped: 'already ran today' };

    const claimed = await updateWithRetry<JobRow>(TABLES.config, pk, rk, (current) => {
      if (current.lastRunDate === date) return null; // someone else claimed it
      return { partitionKey: pk, rowKey: rk, lastRunDate: date };
    });
    if (!claimed) return { skipped: 'already ran today' };

    const after = await getEntity<JobRow>(TABLES.config, pk, rk);
    if (after?.lastRunDate !== date) return { skipped: 'already ran today' };
  }

  const result = await fn();

  await upsert(TABLES.config, {
    partitionKey: pk,
    rowKey: rk,
    lastRunDate: date,
    lastRunAt: new Date().toISOString(),
    lastResultJson: JSON.stringify(result).slice(0, 8000),
  });

  return result;
}

export interface JobStatus {
  job: string;
  lastRunDate: string | null;
  lastRunAt: string | null;
  lastResult: unknown;
}

/** What the tick has actually been doing — the parent-facing ops view. */
export async function jobStatuses(): Promise<JobStatus[]> {
  const rows = await listPartition<JobRow>(TABLES.config, configPK(env.householdId));
  return rows
    .filter((r) => r.rowKey.startsWith('job_'))
    .map((r) => ({
      job: r.rowKey.slice('job_'.length),
      lastRunDate: r.lastRunDate ?? null,
      lastRunAt: r.lastRunAt ?? null,
      lastResult: safeParse(r.lastResultJson),
    }))
    .sort((a, b) => (a.job < b.job ? -1 : 1));
}

function safeParse(json: string | undefined): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

interface LedgerRow {
  delta: number;
}

interface MemberRow {
  displayName: string;
  pointsBalance: number;
}

export interface Drift {
  memberId: string;
  displayName: string;
  cached: number;
  fromLedger: number;
  delta: number;
}

/**
 * Recompute every balance from the ledger and correct the cache.
 *
 * `Member.pointsBalance` is a cache; the ledger is authoritative. They live in
 * different tables, so the write that pays a chore cannot be atomic across
 * both — a crash between them leaves the cache low. This is the sweeper for
 * that, and drift showing up here is the signal that something is wrong with
 * the ordering, not merely that a machine died once.
 *
 * Bounded by construction: ledger partitions are per member per month, and it
 * reads MONTHS back, not all of history. A balance error older than that is
 * beyond the point where recomputing it silently is the right move anyway.
 */
const MONTHS = 24;

export async function reconcile(): Promise<{ checked: number; drift: Drift[] }> {
  const members = await listPartition<MemberRow>(TABLES.members, memberPK(env.householdId));
  const months = recentMonths(MONTHS);
  const drift: Drift[] = [];

  for (const member of members) {
    let total = 0;
    for (const month of months) {
      const rows = await listPartition<LedgerRow>(
        TABLES.ledger,
        ledgerPK(env.householdId, member.rowKey, month),
      );
      for (const row of rows) total += row.delta ?? 0;
    }

    const cached = member.pointsBalance ?? 0;
    if (cached === total) continue;

    drift.push({
      memberId: member.rowKey,
      displayName: member.displayName,
      cached,
      fromLedger: total,
      delta: total - cached,
    });

    // Correct it. Merge-updating a single property, so nothing else on the
    // member row — the PIN hash above all — can be touched by this.
    await updateWithRetry<MemberRow>(
      TABLES.members,
      memberPK(env.householdId),
      member.rowKey,
      (current) => {
        if ((current.pointsBalance ?? 0) === total) return null;
        return { partitionKey: current.partitionKey, rowKey: current.rowKey, pointsBalance: total };
      },
    );
  }

  if (drift.length > 0) {
    console.warn('reconciler corrected balance drift', JSON.stringify(drift));
    await bumpRev(['points', 'members']);
  }

  return { checked: members.length, drift };
}

/** `YYYY-MM` for this month and the previous `count - 1`, newest first. */
function recentMonths(count: number): string[] {
  const out: string[] = [];
  const today = localDateNow(env.timezone);
  const [y, m] = today.split('-').map(Number);
  let year = y!;
  let month = m!;
  for (let i = 0; i < count; i++) {
    out.push(`${year}-${String(month).padStart(2, '0')}`);
    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Session sweep
// ---------------------------------------------------------------------------

interface SessionRow {
  expiresAt: string;
}

interface PinAttemptRow {
  lockedUntil: string | null;
  lastAttemptAt: string;
}

/**
 * Delete rows nobody can use any more.
 *
 * Expiry is already enforced on read — an expired session is rejected whether
 * or not its row still exists — so this is hygiene, not security. It matters
 * because the sessions partition is otherwise append-only: a kiosk issuing a
 * 10-minute session every time somebody walks past accumulates thousands of
 * dead rows a month, and they are all in ONE partition.
 */
const PIN_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;

export async function sweepSessions(): Promise<{ sessions: number; pinAttempts: number }> {
  const now = Date.now();

  const sessions = await listPartition<SessionRow>(TABLES.sessions, sessionPK(env.householdId));
  let removedSessions = 0;
  for (const row of sessions) {
    const expires = Date.parse(row.expiresAt ?? '');
    // A row with an unparseable expiry is not something to guess about — leave
    // it; the read path rejects it anyway.
    if (!Number.isFinite(expires) || expires > now) continue;
    await remove(TABLES.sessions, row.partitionKey, row.rowKey);
    removedSessions++;
  }

  // Failed-PIN counters are only meaningful inside the lockout window. Keeping
  // them a day covers "was somebody trying my PIN yesterday?" and no longer.
  const attempts = await listPartition<PinAttemptRow>(
    TABLES.pinAttempts,
    pinAttemptPK(env.householdId),
  );
  let removedAttempts = 0;
  for (const row of attempts) {
    const locked = row.lockedUntil ? Date.parse(row.lockedUntil) : 0;
    if (Number.isFinite(locked) && locked > now) continue;

    const last = Date.parse(row.lastAttemptAt ?? '');
    if (Number.isFinite(last) && now - last < PIN_ATTEMPT_TTL_MS) continue;

    await remove(TABLES.pinAttempts, row.partitionKey, row.rowKey);
    removedAttempts++;
  }

  return { sessions: removedSessions, pinAttempts: removedAttempts };
}

// ---------------------------------------------------------------------------
// End-of-day streaks
// ---------------------------------------------------------------------------

/**
 * Settle yesterday for everybody.
 *
 * Streaks are evaluated on approval too, so this is a backstop for the case
 * approval cannot cover: the last chore of the day approved before midnight
 * counts, but a day whose final state only became qualifying because something
 * *expired* has nobody to trigger it. Idempotent — `recordQualifyingDay` is a
 * no-op for a day already recorded — which is why it is safe to run from both
 * places and twice from here.
 *
 * A missed day is not written anywhere: aliveness is computed from the last
 * qualifying date on read, so a streak breaks by the passage of time rather
 * than by a job running. That is deliberate, and it is why a tick that never
 * fires cannot corrupt anyone's streak.
 */
export async function settleYesterdayStreaks(
  evaluate: (memberId: string, date: LocalDate) => Promise<{ event: string; current: number }>,
): Promise<{ evaluated: number; advanced: number }> {
  const yesterday = addLocalDays(localDateNow(env.timezone), -1);
  const members = await listPartition<MemberRow>(TABLES.members, memberPK(env.householdId));

  let advanced = 0;
  for (const member of members) {
    const outcome = await evaluate(member.rowKey, yesterday);
    if (outcome.event !== 'unchanged') advanced++;
  }

  return { evaluated: members.length, advanced };
}

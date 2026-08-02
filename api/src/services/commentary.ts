import { TABLES, feedPK } from '../../../shared/keys.js';
import { fallbackCommentary } from '../../../shared/fallbackCopy.js';
import { checkPG13 } from '../../../shared/pg13.js';
import { addLocalDays, localDateNow, type LocalDate } from '../../../shared/time.js';
import type { FeedEntity } from '../../../shared/types.js';
import { cacheKey, generate } from '../lib/claude.js';
import { env } from '../lib/env.js';
import { householdConfig } from '../lib/config.js';
import { listMembers } from '../lib/members.js';
import { bumpRev } from '../lib/rev.js';
import { listPartition, upsert } from '../lib/tables.js';

/**
 * Ticker commentary.
 *
 * Batched, deferred, and never on a read path. One Haiku call annotates up to
 * eight feed items; the alternative — a call per item, inline on the write —
 * would put a model round trip in front of a child tapping a chore, for a joke
 * nobody is waiting on.
 *
 * The generated line is an *addition*. `headline` always holds the plain fact,
 * so the ticker is complete whether or not this ever runs. That is what makes
 * the Anthropic API optional rather than load-bearing.
 */

const PROMPT_VERSION = 'commentary-v1';
const BATCH_SIZE = 8;

/**
 * The rubric, frozen.
 *
 * Six layers protect this feature (see the plan); this is layer one, and the
 * few-shot section below is layer two. In practice the three BAD examples with
 * a stated reason do more work than every instruction above them combined —
 * a model shown what "too far" looks like calibrates far better than one told
 * to be appropriate.
 */
const SYSTEM = `You write one-line commentary for a family chore board displayed on a kitchen wall. Children aged 6-16 read it. So do their grandparents.

You will be given a list of things that happened. For each one, write a single short line — under 100 characters — that makes it a bit more fun to read.

ALLOWED:
- Comic-book bombast about the CHORE ("The dishwasher never stood a chance")
- Playful exaggeration of the event
- Gentle teasing of the TASK, the mess, the deadline, the laundry
- Dry understatement

BANNED, without exception:
- Profanity of any kind, including minced oaths (heck, darn, frick)
- Anything sexual, substance-related, or violent beyond cartoon slapstick
- ANY comment on a person's body, weight, appearance, or eating
- ANY comment on someone's intelligence, character, laziness, effort, or worth
- Comparing one family member to another, in any direction
- Sarcasm aimed at a PERSON rather than an EVENT
- Medical, religious, or political references
- Links, @-mentions, ALL CAPS, hashtags

The distinction that matters: tease the task, never the child. If the line would sting to read on a wall for a week, it is wrong.

GOOD:
- "Another sock rescued from under the bed."
- "The recycling bin has been defeated."
- "That deadline never saw it coming."

BAD, and why:
- "Finally, some effort from Theo." — BAD: implies the person is usually lazy.
- "Maya did better than her brother today." — BAD: compares siblings.
- "About time someone cleaned this pigsty." — BAD: insults the family's home.

Respond with JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['lines'],
  additionalProperties: false,
};

interface GeneratedLines {
  lines: { id: string; text: string }[];
}

type FeedRow = FeedEntity & { partitionKey: string; rowKey: string };

/**
 * Annotate today's un-commented feed items.
 *
 * Called from the cron tick, never from a read. Returns counts so the tick can
 * be observed without reading storage.
 */
export async function annotateRecentFeed(
  date: LocalDate = localDateNow(env.timezone),
): Promise<{ considered: number; generated: number; fallback: number; skipped: boolean }> {
  const config = await householdConfig();
  if (!config.commentaryEnabled) {
    return { considered: 0, generated: 0, fallback: 0, skipped: true };
  }

  const rows = (await listPartition<FeedEntity>(
    TABLES.feed,
    feedPK(env.householdId, date),
  )) as FeedRow[];

  const pending = rows
    // `== null` on purpose: Table Storage OMITS null properties rather than
    // storing them, so a field written as null reads back as undefined. A
    // strict `=== null` here matched nothing and silently skipped every row.
    .filter((r) => !r.suppressed && r.commentary == null && isEligible(r.kind))
    .slice(0, BATCH_SIZE);

  if (pending.length === 0) {
    return { considered: 0, generated: 0, fallback: 0, skipped: false };
  }

  const members = await listMembers();
  const filterOptions = {
    memberNames: members.map((m) => m.displayName),
    householdDenylist: safeList(config.extraDenylistJson),
    maxLength: 120,
  };

  const outcome = await generate<GeneratedLines>({
    job: 'ticker',
    kind: 'commentary',
    system: SYSTEM,
    user: buildPrompt(pending),
    schema: SCHEMA,
    // Content-addressed on the exact item ids, so a duplicated cron tick within
    // the same minute costs one point read instead of a second call.
    cacheKey: cacheKey(PROMPT_VERSION, pending.map((r) => r.rowKey)),
    validate: (value) => validateLines(value, pending.length),
  });

  const byId = new Map<string, string>();
  for (const line of outcome.value?.lines ?? []) byId.set(line.id, line.text);

  let generated = 0;
  let fallback = 0;

  for (const row of pending) {
    const candidate = byId.get(row.rowKey);

    // Layer four: every generated string is filtered before storage. Layer
    // five: a rejection falls back rather than retrying forever — unvalidated
    // model text never reaches an unattended display, full stop.
    const accepted =
      candidate !== undefined && checkPG13(candidate, filterOptions).ok ? candidate : null;

    const text = accepted ?? fallbackCommentary(row.kind, row.rowKey);
    if (accepted) generated++;
    else fallback++;

    await upsert(TABLES.feed, {
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
      commentary: text,
      commentarySource: accepted ? 'claude' : 'fallback',
      commentaryModel: accepted ? outcome.model : null,
    });
  }

  await bumpRev(['feed']);
  return { considered: pending.length, generated, fallback, skipped: false };
}

/**
 * Backfill hand-written lines without calling anything.
 *
 * Used when commentary is disabled or unconfigured: the ticker still reads
 * better than a bare list of facts, at zero cost and zero risk.
 */
export async function fillFallbackCommentary(
  date: LocalDate = localDateNow(env.timezone),
): Promise<number> {
  const rows = (await listPartition<FeedEntity>(
    TABLES.feed,
    feedPK(env.householdId, date),
  )) as FeedRow[];

  let filled = 0;
  for (const row of rows) {
    if (row.suppressed || row.commentary != null || !isEligible(row.kind)) continue;
    await upsert(TABLES.feed, {
      partitionKey: row.partitionKey,
      rowKey: row.rowKey,
      commentary: fallbackCommentary(row.kind, row.rowKey),
      commentarySource: 'fallback',
      commentaryModel: null,
    });
    filled++;
  }
  if (filled > 0) await bumpRev(['feed']);
  return filled;
}

/**
 * "That wasn't ok."
 *
 * One tap. The item disappears immediately — suppression is applied server-side
 * in the feed read, so it is gone from the wall on the next poll whether or not
 * anyone is signed in there. The prompt/output pair is kept for the
 * parent-visible incident list, because the useful question later is "what
 * kind of thing does it get wrong", not "how many".
 */
export async function suppressFeedItem(
  date: LocalDate,
  rowKey: string,
  reportedBy: string,
  reason = 'Flagged by a parent',
): Promise<boolean> {
  const rows = (await listPartition<FeedEntity>(
    TABLES.feed,
    feedPK(env.householdId, date),
  )) as FeedRow[];
  const row = rows.find((r) => r.rowKey === rowKey);
  if (!row) return false;

  await upsert(TABLES.feed, {
    partitionKey: row.partitionKey,
    rowKey: row.rowKey,
    suppressed: true,
    suppressedBy: reportedBy,
    suppressedAt: new Date().toISOString(),
    suppressedReason: reason,
  });

  await bumpRev(['feed']);
  return true;
}

/** The parent-visible incident list — what got flagged, and what it said. */
export async function listIncidents(days = 7) {
  const today = localDateNow(env.timezone);
  const out: Array<{
    id: string;
    headline: string;
    commentary: string | null;
    reason: string;
    reportedBy: string | null;
    reportedAt: string;
  }> = [];

  for (let i = 0; i < days; i++) {
    const rows = (await listPartition<
      FeedEntity & { suppressedBy?: string; suppressedAt?: string; suppressedReason?: string }
    >(TABLES.feed, feedPK(env.householdId, addLocalDays(today, -i)))) as Array<
      FeedRow & { suppressedBy?: string; suppressedAt?: string; suppressedReason?: string }
    >;

    for (const row of rows) {
      if (!row.suppressed) continue;
      out.push({
        id: row.rowKey,
        headline: row.headline,
        commentary: row.commentary,
        reason: row.suppressedReason ?? 'Flagged by a parent',
        reportedBy: row.suppressedBy ?? null,
        reportedAt: row.suppressedAt ?? row.createdAt,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------

/** Security notices and adjustments are never made funny. */
function isEligible(kind: string): boolean {
  return kind !== 'security' && kind !== 'adjustment' && kind !== 'challenge';
}

function buildPrompt(rows: FeedRow[]): string {
  const lines = rows.map((r) => `- id: ${r.rowKey}\n  event: ${r.headline}`).join('\n');
  return `Write one line for each of these ${rows.length} events. Return every id exactly as given.\n\n${lines}`;
}

function validateLines(value: unknown, expected: number): GeneratedLines | null {
  if (typeof value !== 'object' || value === null) return null;
  const lines = (value as { lines?: unknown }).lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;

  const out: { id: string; text: string }[] = [];
  for (const entry of lines) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, text } = entry as { id?: unknown; text?: unknown };
    if (typeof id !== 'string' || typeof text !== 'string') continue;
    // The schema subset does not honor maxLength, so length is enforced here.
    out.push({ id, text: text.trim().slice(0, 120) });
  }

  // A response that ignored most of the batch is a malformed response, not a
  // partial success — fall back for all of them rather than annotating one.
  if (out.length < Math.ceil(expected / 2)) return null;
  return { lines: out };
}

function safeList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

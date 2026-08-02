import { CONFIG_ROWS, TABLES, configPK, configRK } from '../../../shared/keys.js';
import { fallbackChallenge } from '../../../shared/fallbackCopy.js';
import { checkPG13 } from '../../../shared/pg13.js';
import { localDateNow, type LocalDate } from '../../../shared/time.js';
import { cacheKey, generate } from '../lib/claude.js';
import { householdConfig } from '../lib/config.js';
import { env } from '../lib/env.js';
import { writeFeedItem } from '../lib/feed.js';
import { listMembers } from '../lib/members.js';
import { getEntity, upsert } from '../lib/tables.js';

/**
 * The daily challenge.
 *
 * One line a day, shown on the board and written into the ticker. Generated on
 * the cron tick — never on read — and guarded so that a duplicate tick produces
 * one challenge rather than a new one every hour.
 *
 * There are 30 hand-written challenges behind this. A household that never
 * configures a key still gets a fresh one each day; generation just makes it
 * specific to what is actually on the board.
 */

const PROMPT_VERSION = 'challenge-v1';

const SYSTEM = `You write a single daily challenge for a family chore board on a kitchen wall. Children aged 6-16 read it.

The challenge should be a short, achievable goal for the day — one sentence, under 90 characters, addressed to the whole family. It should be something a child could decide to do today and know whether they succeeded.

ALLOWED:
- Concrete goals tied to the chores listed
- Light competition between everyone as a group ("clear the whole board before dinner")
- Playful framing of the task

BANNED, without exception:
- Profanity of any kind, including minced oaths
- Anything sexual, substance-related, or violent beyond cartoon slapstick
- ANY reference to bodies, weight, appearance, or eating
- ANY reference to intelligence, character, laziness, or worth
- Naming or singling out one family member
- Comparing family members to each other
- Links, @-mentions, ALL CAPS, hashtags

GOOD:
- "Clear every chore before dinner is on the table."
- "Nobody leaves a deadline behind today."

BAD, and why:
- "Beat Theo to the trash." — BAD: names a person and pits siblings against each other.
- "Prove you're not lazy today." — BAD: insults the reader.

Respond with JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: { challenge: { type: 'string' } },
  required: ['challenge'],
  additionalProperties: false,
};

interface ChallengeRow {
  date: string;
  text: string;
  source: 'claude' | 'fallback';
  createdAt: string;
}

export async function currentChallenge(
  date: LocalDate = localDateNow(env.timezone),
): Promise<{ date: string; text: string; source: 'claude' | 'fallback' } | null> {
  const config = await householdConfig();
  if (!config.challengeEnabled) return null;

  const row = await getEntity<ChallengeRow>(
    TABLES.config,
    configPK(env.householdId),
    configRK('challenge'),
  );

  // A stored challenge from a previous day is stale — fall back to today's
  // deterministic one rather than showing yesterday's goal all morning.
  if (row && row.date === date) {
    return { date, text: row.text, source: row.source };
  }
  return { date, text: fallbackChallenge(date), source: 'fallback' };
}

/**
 * Generate today's challenge, once.
 *
 * Guarded on the stored date, because the cron tick is at-least-once and a
 * challenge that changes every hour is not a challenge.
 */
export async function ensureChallenge(
  date: LocalDate = localDateNow(env.timezone),
  chores: string[] = [],
): Promise<{ text: string; source: 'claude' | 'fallback'; alreadySet: boolean }> {
  const config = await householdConfig();

  const existing = await getEntity<ChallengeRow>(
    TABLES.config,
    configPK(env.householdId),
    configRK('challenge'),
  );
  if (existing && existing.date === date) {
    return { text: existing.text, source: existing.source, alreadySet: true };
  }

  const backup = fallbackChallenge(date);
  let text = backup;
  let source: 'claude' | 'fallback' = 'fallback';

  if (config.challengeEnabled && config.commentaryEnabled) {
    const members = await listMembers();
    const filterOptions = {
      memberNames: members.map((m) => m.displayName),
      householdDenylist: safeList(config.extraDenylistJson),
      maxLength: 100,
    };

    const outcome = await generate<{ challenge: string }>({
      job: 'keepsake',
      kind: 'challenge',
      system: SYSTEM,
      user:
        chores.length > 0
          ? `Today's chores are:\n${chores.map((c) => `- ${c}`).join('\n')}\n\nWrite one challenge for the family.`
          : 'Write one general challenge for the family today.',
      schema: SCHEMA,
      cacheKey: cacheKey(PROMPT_VERSION, [date, ...chores]),
      maxTokens: 2000,
      validate: (value) => {
        if (typeof value !== 'object' || value === null) return null;
        const raw = (value as { challenge?: unknown }).challenge;
        if (typeof raw !== 'string') return null;
        const trimmed = raw.trim();
        return trimmed.length > 0 && trimmed.length <= 100 ? { challenge: trimmed } : null;
      },
    });

    if (outcome.value && checkPG13(outcome.value.challenge, filterOptions).ok) {
      text = outcome.value.challenge;
      source = 'claude';
    }
  }

  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK('challenge'),
    date,
    text,
    source,
    createdAt: new Date().toISOString(),
  } satisfies ChallengeRow & { partitionKey: string; rowKey: string });

  await writeFeedItem({
    kind: 'challenge',
    headline: `Today’s challenge: ${text}`,
    icon: '🎯',
    points: null,
    // The challenge is already the generated line — annotating it again would
    // put a joke on top of a goal.
    eligibleForCommentary: false,
  });

  return { text, source, alreadySet: false };
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

export { CONFIG_ROWS };

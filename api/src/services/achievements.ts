import {
  TABLES,
  achievementAwardPK,
  achievementAwardRK,
  achievementDefPK,
  achievementDefRK,
  ledgerPK,
  ledgerRK,
  memberPK,
  memberRK,
} from '../../../shared/keys.js';
import {
  criteriaNoun,
  describeCriteria,
  emptyStats,
  newlyEarned,
  nextUp,
  tierFor,
  type Criteria,
  type MemberStats,
} from '../../../shared/achievements.js';
import { DEFAULT_ACHIEVEMENTS } from '../../../shared/achievementCatalog.js';
import { fallbackAchievement, type Tier } from '../../../shared/fallbackCopy.js';
import { checkPG13, isSingleEmoji } from '../../../shared/pg13.js';
import { yearMonthNow } from '../../../shared/time.js';
import type {
  Achievement,
  AchievementAwardEntity,
  AchievementDefEntity,
  LedgerEntity,
  MemberEntity,
} from '../../../shared/types.js';
import { randomUUID } from 'node:crypto';
import { cacheKey, generate } from '../lib/claude.js';
import { householdConfig } from '../lib/config.js';
import { env } from '../lib/env.js';
import { writeFeedItem } from '../lib/feed.js';
import { getMemberRow, listMembers } from '../lib/members.js';
import { bumpRev } from '../lib/rev.js';
import { createIfAbsent, getEntity, listPartition, updateWithRetry, upsert } from '../lib/tables.js';

/**
 * Achievement evaluation and naming.
 *
 * Runs SYNCHRONOUSLY inside the approval handler, unlike ticker commentary.
 * The reason is entirely about the moment: a child is standing at the tablet
 * having just had a chore approved, and the badge is the payoff. Sonnet at low
 * effort returns in a couple of seconds, which is the difference between a
 * reward and a notification that shows up later.
 *
 * Everything is still wrapped so that a slow or missing API costs a
 * hand-written badge name rather than a failed approval — the award is what
 * matters; the wording is cosmetic and can be regenerated later.
 */

const PROMPT_VERSION = 'achievement-v1';

const SYSTEM = `You name achievement badges for a family chore board displayed on a kitchen wall. Children aged 6-16 will see these badges, and a badge stays in their trophy case permanently.

You will be told what the badge is awarded for. Invent a name, a one-line description, and a short flavour line.

TONE: comic-book trophy. Grand, a bit silly, celebratory. Think arcade high-score board, not corporate certificate.

ALLOWED:
- Bombast and mock-grandeur about the CHORE or the streak
- Invented titles, ranks, orders ("Keeper of the Clean Sink")
- Playful exaggeration of the achievement itself

BANNED, without exception:
- Profanity of any kind, including minced oaths
- Anything sexual, substance-related, or violent beyond cartoon slapstick
- ANY reference to a person's body, weight, appearance, or eating
- ANY reference to intelligence, character, laziness, effort, or worth
- Comparing family members
- Naming any specific person — the badge belongs to whoever earns it
- Links, @-mentions, ALL CAPS, hashtags

GOOD:
- name: "Dishwasher's Bane", flavour: "The racks have learned to fear you."
- name: "Keeper of the Streak", flavour: "Thirty days. Not one missed."

BAD, and why:
- "Not Lazy Anymore" — BAD: implies the earner was previously lazy.
- "Better Than Your Sister" — BAD: compares family members.
- "Finally Useful" — BAD: insults the earner.

Respond with JSON only.`;

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    flavorText: { type: 'string' },
    iconEmoji: { type: 'string' },
  },
  required: ['name', 'description', 'flavorText', 'iconEmoji'],
  additionalProperties: false,
};

interface GeneratedBadge {
  name: string;
  description: string;
  flavorText: string;
  iconEmoji: string;
}

type DefRow = AchievementDefEntity & { partitionKey: string; rowKey: string };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Put the default badge ladder in place, once.
 *
 * Deterministic row keys plus `createIfAbsent`, so this is safe to call on
 * every read — the same idempotency guarantee the materializer leans on. It
 * deliberately does NOT update existing rows: a parent who renamed a badge or
 * deactivated one must not have that undone on the next request.
 *
 * This exists because without it the whole feature is inert. Everything else
 * was built — the evaluator, the namer, the tiers, the trophy case, the
 * celebration — but nothing ever wrote a definition, so no badge could be
 * earned by anyone, ever.
 */
export async function ensureDefaultDefs(): Promise<number> {
  let created = 0;
  for (const seed of DEFAULT_ACHIEVEMENTS) {
    const ok = await createIfAbsent<AchievementDefEntity>(TABLES.achievementDefs, {
      partitionKey: achievementDefPK(env.householdId),
      rowKey: achievementDefRK(seed.id),
      name: seed.name,
      description: seed.description,
      criteriaJson: JSON.stringify(seed.criteria),
      tier: seed.tier,
      icon: seed.icon,
      pointsReward: seed.pointsReward,
      active: true,
      createdAt: new Date().toISOString(),
    });
    if (ok) created++;
  }
  return created;
}

export async function listDefs(): Promise<Array<{ id: string; criteria: Criteria; row: DefRow }>> {
  let rows = (await listPartition<AchievementDefEntity>(
    TABLES.achievementDefs,
    achievementDefPK(env.householdId),
  )) as DefRow[];

  // Empty means a household that has never had the ladder installed. Install
  // it and re-read rather than returning nothing — otherwise the first family
  // to use the app gets no badges until some other code path happens to run.
  if (rows.length === 0) {
    await ensureDefaultDefs();
    rows = (await listPartition<AchievementDefEntity>(
      TABLES.achievementDefs,
      achievementDefPK(env.householdId),
    )) as DefRow[];
  }

  const out: Array<{ id: string; criteria: Criteria; row: DefRow }> = [];
  for (const row of rows) {
    if (!row.active) continue;
    try {
      out.push({ id: row.rowKey, criteria: JSON.parse(row.criteriaJson) as Criteria, row });
    } catch {
      // A malformed definition must not take down evaluation for the whole
      // household — skip it and keep going.
    }
  }
  return out;
}

export async function listAwards(memberId: string): Promise<Achievement[]> {
  const rows = (await listPartition<AchievementAwardEntity>(
    TABLES.achievementAwards,
    achievementAwardPK(env.householdId, memberId),
  )) as Array<AchievementAwardEntity & { rowKey: string }>;

  return rows
    .map((r) => ({
      id: r.rowKey,
      name: r.name,
      description: r.description,
      flavorText: r.flavorText,
      tier: r.tier,
      icon: r.icon,
      pointsAwarded: r.pointsAwarded,
      copySource: r.copySource,
      earnedAt: r.earnedAt,
    }))
    .sort((a, b) => (a.earnedAt < b.earnedAt ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate everything this member might have just unlocked.
 *
 * Called after a chore approval, with the counters the approval path already
 * has. Cheap by construction: "already earned?" is a point-partition read, and
 * criteria evaluation is pure arithmetic.
 *
 * Never throws into the caller. An approval that already moved points must not
 * fail because a badge could not be named.
 */
export async function evaluateAchievements(
  memberId: string,
  stats: MemberStats,
): Promise<Achievement[]> {
  try {
    const defs = await listDefs();
    if (defs.length === 0) return [];

    const held = new Set((await listAwards(memberId)).map((a) => a.id));
    const earned = newlyEarned(
      defs.map((d) => ({ id: d.id, criteria: d.criteria })),
      stats,
      held,
    );
    if (earned.length === 0) return [];

    const member = await getMemberRow(memberId);
    if (!member) return [];

    const awarded: Achievement[] = [];
    for (const def of earned) {
      const row = defs.find((d) => d.id === def.id)!.row;
      const badge = await award(memberId, member.displayName, member.avatarEmoji, def.id, def.criteria, row);
      if (badge) awarded.push(badge);
    }

    if (awarded.length > 0) await bumpRev(['points', 'members', 'feed']);
    return awarded;
  } catch {
    // Deliberately swallowed. The cron tick re-evaluates idempotently, so a
    // miss here self-heals on the next pass.
    return [];
  }
}

async function award(
  memberId: string,
  displayName: string,
  avatarEmoji: string,
  defId: string,
  criteria: Criteria,
  def: DefRow,
): Promise<Achievement | null> {
  const tier = tierFor(criteria);
  const copy = await generateCopy(tier, criteria, defId);
  const points = clampPoints(def.pointsReward);
  const now = Date.now();

  // Deterministic row key on the definition id, so a concurrent double
  // evaluation writes the same row rather than two badges. Same idempotency
  // trick the materializer uses.
  const entity: AchievementAwardEntity & { partitionKey: string; rowKey: string } = {
    partitionKey: achievementAwardPK(env.householdId, memberId),
    rowKey: achievementAwardRK(defId),
    name: copy.name,
    description: copy.description,
    flavorText: copy.flavorText,
    tier,
    icon: copy.iconEmoji,
    pointsAwarded: points,
    copySource: copy.source,
    copyModel: copy.model,
    earnedAt: new Date(now).toISOString(),
  };
  await upsert(TABLES.achievementAwards, entity);

  // Ledger first, as everywhere else — it is the authoritative record.
  if (points > 0) {
    await upsert(TABLES.ledger, {
      partitionKey: ledgerPK(env.householdId, memberId, yearMonthNow(env.timezone, now)),
      rowKey: ledgerRK(now, randomUUID()),
      delta: points,
      kind: 'achievement',
      refType: 'achievement',
      refId: defId,
      description: copy.name,
      balanceAfter: 0,
      actorMemberId: null,
      createdAt: new Date(now).toISOString(),
    } satisfies LedgerEntity & { partitionKey: string; rowKey: string });

    await updateWithRetry<MemberEntity>(
      TABLES.members,
      memberPK(env.householdId),
      memberRK(memberId),
      (current) => ({
        partitionKey: current.partitionKey,
        rowKey: current.rowKey,
        pointsBalance: (current.pointsBalance ?? 0) + points,
        lifetimePoints: (current.lifetimePoints ?? 0) + points,
      }),
    );
  }

  await writeFeedItem({
    kind: 'achievement',
    headline: `${displayName} earned “${copy.name}”`,
    detail: copy.flavorText,
    icon: copy.iconEmoji,
    points: points || null,
    actor: { id: memberId, name: displayName, avatar: avatarEmoji },
    refType: 'achievement',
    refId: defId,
  });

  return {
    id: defId,
    name: copy.name,
    description: copy.description,
    flavorText: copy.flavorText,
    tier,
    icon: copy.iconEmoji,
    pointsAwarded: points,
    copySource: copy.source,
    earnedAt: entity.earnedAt,
  };
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

interface Copy {
  name: string;
  description: string;
  flavorText: string;
  iconEmoji: string;
  source: 'claude' | 'fallback';
  model: string | null;
}

async function generateCopy(tier: Tier, criteria: Criteria, defId: string): Promise<Copy> {
  const noun = criteriaNoun(criteria);
  const backup = fallbackAchievement(tier, noun, defId);
  const asCopy = (): Copy => ({ ...backup, source: 'fallback', model: null });

  const config = await householdConfig();
  if (!config.commentaryEnabled) return asCopy();

  const members = await listMembers();
  const filterOptions = {
    memberNames: members.map((m) => m.displayName),
    householdDenylist: safeList(config.extraDenylistJson),
    maxLength: 120,
  };

  // Gold and legendary badges are keepsakes — the 100-day-streak trophy is the
  // one a kid still remembers years later, so it gets the better model. Bronze
  // and silver arrive often enough that Sonnet is the right trade.
  const job = tier === 'gold' || tier === 'legendary' ? 'keepsake' : 'achievement';

  const outcome = await generate<GeneratedBadge>({
    job,
    kind: 'achievement',
    system: SYSTEM,
    user: `Award tier: ${tier}\nAwarded for: ${describeCriteria(criteria)}\n\nInvent the badge.`,
    schema: SCHEMA,
    cacheKey: cacheKey(PROMPT_VERSION, [defId, tier]),
    maxTokens: job === 'keepsake' ? 2000 : 1000,
    validate: (value) => validateBadge(value),
  });

  const badge = outcome.value;
  if (!badge) return asCopy();

  // Every field is filtered independently. A good name attached to a bad
  // flavour line is still a bad badge on the wall.
  for (const field of [badge.name, badge.description, badge.flavorText]) {
    if (!checkPG13(field, filterOptions).ok) return asCopy();
  }
  if (!isSingleEmoji(badge.iconEmoji)) return asCopy();

  return {
    name: badge.name,
    description: badge.description,
    flavorText: badge.flavorText,
    iconEmoji: badge.iconEmoji,
    source: 'claude',
    model: outcome.model,
  };
}

/**
 * The structured-output schema subset does not honour `minLength`,
 * `maxLength`, or numeric bounds, so every constraint is enforced here after
 * parsing rather than declared and trusted.
 */
function validateBadge(value: unknown): GeneratedBadge | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v['name'] !== 'string' ||
    typeof v['description'] !== 'string' ||
    typeof v['flavorText'] !== 'string' ||
    typeof v['iconEmoji'] !== 'string'
  ) {
    return null;
  }

  const name = v['name'].trim();
  if (name.length === 0 || name.length > 40) return null;

  return {
    name,
    description: v['description'].trim().slice(0, 140),
    flavorText: v['flavorText'].trim().slice(0, 140),
    iconEmoji: v['iconEmoji'].trim(),
  };
}

function clampPoints(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(200, Math.max(0, Math.round(value as number)));
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

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/**
 * Build the counters a criterion is evaluated against.
 *
 * Reads the member row (already cached balances) plus their streak, and counts
 * approved instances for today only — the expensive historical counters
 * (`tasksCompleted`, `perfectDays`) are maintained incrementally on the member
 * row rather than recomputed, because a full history scan on every approval
 * would be the one genuinely slow thing in the write path.
 */
export async function statsFor(
  memberId: string,
  extra: Partial<MemberStats> = {},
): Promise<MemberStats> {
  const row = await getMemberRow(memberId);
  if (!row) return emptyStats();

  const counters = await getEntity<{
    tasksCompleted?: number;
    perfectDays?: number;
    earlyCompletions?: number;
    wildcardsClaimed?: number;
    pointsSpent?: number;
    longestStreak?: number;
    categoriesJson?: string;
  }>(TABLES.members, memberPK(env.householdId), memberRK(memberId));

  let categories: Record<string, number> = {};
  try {
    categories = counters?.categoriesJson
      ? (JSON.parse(counters.categoriesJson) as Record<string, number>)
      : {};
  } catch {
    categories = {};
  }

  return {
    ...emptyStats(),
    tasksCompleted: counters?.tasksCompleted ?? 0,
    tasksByCategory: categories,
    longestStreak: counters?.longestStreak ?? 0,
    lifetimePoints: row.lifetimePoints,
    pointsSpent: counters?.pointsSpent ?? 0,
    perfectDays: counters?.perfectDays ?? 0,
    earlyCompletions: counters?.earlyCompletions ?? 0,
    wildcardsClaimed: counters?.wildcardsClaimed ?? 0,
    ...extra,
  };
}

export { nextUp };

/**
 * Hand-written copy for every place Claude would otherwise speak.
 *
 * This is not an error path. It is the *default* path that generation improves
 * on — the ticker, the badges, and the daily challenge all have to work with
 * the Anthropic API switched off, the key missing, the budget spent, or the
 * filter rejecting twice in a row. The wall display has no error state, because
 * there is nothing a child standing in a kitchen can do about a 529.
 *
 * Selection is seeded by a stable id rather than random, so the same feed item
 * keeps the same line across polls. A ticker whose wording changes every ten
 * seconds looks broken.
 *
 * Every line here is written to pass shared/pg13.ts unchanged — teasing the
 * task, never the person.
 */

/** FNV-1a. Small, stable across runtimes, and good enough to spread 50 lines. */
export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function pick<T>(list: readonly T[], seed: string): T {
  return list[hashSeed(seed) % list.length]!;
}

// ---------------------------------------------------------------------------
// Ticker commentary
// ---------------------------------------------------------------------------

const TASK_COMPLETED = [
  'One down. The board notices.',
  'That chore has been dealt with.',
  'Filed under: handled.',
  'The list just got shorter.',
  'Consider it done.',
  'Struck from the record.',
  'That one is off the board.',
  'Another item bites the dust.',
  'Job logged. Board updated.',
  'Neatly done.',
] as const;

const TASK_APPROVED = [
  'Signed off. Points are real now.',
  'Approved — that counts.',
  'A parent has spoken. Points awarded.',
  'Confirmed and paid out.',
  'Stamped, sealed, credited.',
  'That is officially in the books.',
  'Rubber-stamped.',
  'Points delivered.',
  'The ledger agrees.',
  'Made official.',
] as const;

const STREAK = [
  'The streak survives another day.',
  'Still going. Still counting.',
  'Day after day after day.',
  'The run continues.',
  'Unbroken.',
  'The flame stays lit.',
  'Consistency, quietly winning.',
  'Another day on the pile.',
] as const;

const REDEMPTION = [
  'Points converted into something better.',
  'Saved up and spent well.',
  'The catalog claims another.',
  'Cashed in.',
  'Points out, reward in.',
  'A worthwhile trade.',
  'Balance down, morale up.',
  'Well earned, well spent.',
] as const;

const ACHIEVEMENT = [
  'A badge appears on the shelf.',
  'That one goes in the trophy case.',
  'Unlocked.',
  'New hardware for the collection.',
  'The badge case gets heavier.',
  'Something rare just landed.',
] as const;

const WILDCARD = [
  'Double points are on the table.',
  'The board is offering extra today.',
  'Somebody is about to get lucky.',
  'Bonus territory. Move quickly.',
] as const;

const GENERIC = [
  'Noted.',
  'Logged.',
  'The board keeps score.',
  'On the record.',
] as const;

const BY_KIND: Record<string, readonly string[]> = {
  task_completed: TASK_COMPLETED,
  task_approved: TASK_APPROVED,
  streak: STREAK,
  redemption: REDEMPTION,
  achievement: ACHIEVEMENT,
  wildcard: WILDCARD,
};

/**
 * A line for a feed item.
 *
 * Seeded on the feed id so it is stable: the same item reads the same on every
 * poll, and two items of the same kind on the same day almost never collide.
 */
export function fallbackCommentary(kind: string, feedId: string): string {
  return pick(BY_KIND[kind] ?? GENERIC, `${kind}:${feedId}`);
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export type Tier = 'bronze' | 'silver' | 'gold' | 'legendary';

const TIER_ADJECTIVES: Record<Tier, readonly string[]> = {
  bronze: ['Budding', 'Fledgling', 'Steady', 'Reliable', 'Quiet'],
  silver: ['Seasoned', 'Practiced', 'Relentless', 'Polished', 'Dedicated'],
  gold: ['Gilded', 'Formidable', 'Unstoppable', 'Legendary', 'Peerless'],
  legendary: ['Immortal', 'Mythic', 'Eternal', 'Fabled', 'Storied'],
};

const TIER_ICONS: Record<Tier, string> = {
  bronze: '🥉',
  silver: '🥈',
  gold: '🥇',
  legendary: '🏆',
};

const TIER_FLAVOR: Record<Tier, readonly string[]> = {
  bronze: ['A solid start.', 'The first of many.', 'Everyone begins here.'],
  silver: ['Hard-won.', 'Not an accident.', 'Earned the long way.'],
  gold: ['Few get this far.', 'The board takes notice.', 'A serious milestone.'],
  legendary: ['This one goes on the wall.', 'Rarely seen.', 'A record worth keeping.'],
};

export interface FallbackAchievement {
  name: string;
  description: string;
  flavorText: string;
  tier: Tier;
  iconEmoji: string;
  pointsReward: number;
}

const TIER_POINTS: Record<Tier, number> = {
  bronze: 10,
  silver: 25,
  gold: 60,
  legendary: 150,
};

/**
 * A deterministic badge, for when generation is unavailable.
 *
 * `${tierAdjective} ${criteriaNoun}` — "Gilded Dish Slayer". Deliberately
 * formulaic: a badge earned during an outage should still feel like a badge,
 * and a parent can regenerate the name later once the API is back (the award
 * itself is what matters; the wording is cosmetic).
 */
export function fallbackAchievement(
  tier: Tier,
  criteriaNoun: string,
  seed: string,
): FallbackAchievement {
  const adjective = pick(TIER_ADJECTIVES[tier], `adj:${seed}`);
  const noun = criteriaNoun.trim() || 'Achiever';

  return {
    name: `${adjective} ${noun}`.slice(0, 40),
    description: `Earned by ${criteriaNoun.toLowerCase()} — a ${tier} badge.`,
    flavorText: pick(TIER_FLAVOR[tier], `flavor:${seed}`),
    tier,
    iconEmoji: TIER_ICONS[tier],
    pointsReward: TIER_POINTS[tier],
  };
}

// ---------------------------------------------------------------------------
// Daily challenge
// ---------------------------------------------------------------------------

const CHALLENGES = [
  'Finish everything before dinner.',
  'Clear one chore nobody asked you to do.',
  'Beat yesterday’s total.',
  'Be the first name on the board today.',
  'Get through the whole list without a reminder.',
  'Take on the chore you like least, first.',
  'Finish two things before breakfast is cleared.',
  'Leave one room tidier than you found it.',
  'Complete every chore before the last one is due.',
  'Help with something that is not on your list.',
  'Get every chore approved on the first try.',
  'Keep the streak alive one more day.',
  'Finish before the sun goes down.',
  'Tackle the biggest points on the board.',
  'Clear the kitchen before anyone asks.',
  'Do the thing you put off yesterday.',
  'Get everything done without checking the board twice.',
  'Take the chore with the earliest deadline first.',
  'Finish your list before anyone else finishes theirs.',
  'End the day with nothing left open.',
  'Do one chore properly rather than three quickly.',
  'Beat the timer on every deadline today.',
  'Clear the board before homework starts.',
  'Take on a wildcard if one appears.',
  'Finish the list and then check on somebody else’s.',
  'Get a parent to approve everything in one go.',
  'Complete a chore before it is due, not after.',
  'Start the day by clearing the oldest item.',
  'Leave the board empty at bedtime.',
  'Do it all before anyone reminds you.',
] as const;

/** Seeded on the local date, so everyone sees the same challenge all day. */
export function fallbackChallenge(localDate: string): string {
  return pick(CHALLENGES, `challenge:${localDate}`);
}

export const FALLBACK_COUNTS = {
  commentary:
    TASK_COMPLETED.length +
    TASK_APPROVED.length +
    STREAK.length +
    REDEMPTION.length +
    ACHIEVEMENT.length +
    WILDCARD.length +
    GENERIC.length,
  challenges: CHALLENGES.length,
} as const;

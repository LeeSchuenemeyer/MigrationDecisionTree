/**
 * Achievement criteria — machine-checkable, never prose.
 *
 * A badge whose unlock condition is a sentence is a badge nobody can verify and
 * that fires at the wrong moment. Every criterion here is a small typed record
 * evaluated against a snapshot of the member's counters, which is what makes
 * "have they earned this?" a pure function that can be tested at the boundary
 * (n-1 / n / n+1) rather than observed in production.
 *
 * Evaluation runs on every approval, so it must stay cheap: the counters come
 * from rows the approval path already read, and "already earned?" is a point
 * read against AchievementAwards.
 */

import type { Tier } from './fallbackCopy.js';

export type CriteriaType =
  | 'tasks_completed'
  | 'tasks_of_category'
  | 'streak_days'
  | 'points_earned'
  | 'points_spent'
  | 'perfect_days'
  | 'early_completions'
  | 'wildcards_claimed';

export interface Criteria {
  type: CriteriaType;
  /** The number to reach. Always "at least". */
  threshold: number;
  /** For `tasks_of_category`, which category counts. */
  category?: string;
}

/** The counters a criterion can be evaluated against. */
export interface MemberStats {
  tasksCompleted: number;
  tasksByCategory: Record<string, number>;
  longestStreak: number;
  currentStreak: number;
  lifetimePoints: number;
  pointsSpent: number;
  perfectDays: number;
  earlyCompletions: number;
  wildcardsClaimed: number;
}

export function emptyStats(): MemberStats {
  return {
    tasksCompleted: 0,
    tasksByCategory: {},
    longestStreak: 0,
    currentStreak: 0,
    lifetimePoints: 0,
    pointsSpent: 0,
    perfectDays: 0,
    earlyCompletions: 0,
    wildcardsClaimed: 0,
  };
}

/** The member's current value for a criterion, or null if it does not apply. */
export function valueFor(criteria: Criteria, stats: MemberStats): number | null {
  switch (criteria.type) {
    case 'tasks_completed':
      return stats.tasksCompleted;
    case 'tasks_of_category':
      if (!criteria.category) return null;
      return stats.tasksByCategory[criteria.category] ?? 0;
    case 'streak_days':
      // Longest, not current: a badge for a 30-day streak should stay earned
      // after the streak eventually breaks. Taking it away would be cruel and
      // would make every badge feel provisional.
      return stats.longestStreak;
    case 'points_earned':
      return stats.lifetimePoints;
    case 'points_spent':
      return stats.pointsSpent;
    case 'perfect_days':
      return stats.perfectDays;
    case 'early_completions':
      return stats.earlyCompletions;
    case 'wildcards_claimed':
      return stats.wildcardsClaimed;
    default:
      return null;
  }
}

/** Has this been earned? Inclusive at the threshold. */
export function isEarned(criteria: Criteria, stats: MemberStats): boolean {
  const value = valueFor(criteria, stats);
  if (value === null) return false;
  return value >= criteria.threshold;
}

/** How far to go, for the "3 more chores" nudge. Zero once earned. */
export function remaining(criteria: Criteria, stats: MemberStats): number {
  const value = valueFor(criteria, stats);
  if (value === null) return criteria.threshold;
  return Math.max(0, criteria.threshold - value);
}

/**
 * Tier from threshold.
 *
 * Kept as a function rather than stored per-badge so a seeded catalog stays
 * internally consistent: two badges at the same difficulty always look the same
 * weight on the shelf.
 */
export function tierFor(criteria: Criteria): Tier {
  const t = criteria.threshold;
  switch (criteria.type) {
    case 'streak_days':
      if (t >= 100) return 'legendary';
      if (t >= 30) return 'gold';
      if (t >= 7) return 'silver';
      return 'bronze';
    case 'points_earned':
    case 'points_spent':
      if (t >= 5000) return 'legendary';
      if (t >= 1500) return 'gold';
      if (t >= 500) return 'silver';
      return 'bronze';
    default:
      if (t >= 250) return 'legendary';
      if (t >= 100) return 'gold';
      if (t >= 25) return 'silver';
      return 'bronze';
  }
}

/** A short noun phrase for the deterministic fallback namer. */
export function criteriaNoun(criteria: Criteria): string {
  switch (criteria.type) {
    case 'tasks_completed':
      return 'Chore Crusher';
    case 'tasks_of_category':
      return `${titleCase(criteria.category ?? 'Task')} Specialist`;
    case 'streak_days':
      return 'Streak Keeper';
    case 'points_earned':
      return 'Point Collector';
    case 'points_spent':
      return 'Big Spender';
    case 'perfect_days':
      return 'Clean Sweeper';
    case 'early_completions':
      return 'Early Bird';
    case 'wildcards_claimed':
      return 'Wildcard Hunter';
    default:
      return 'Achiever';
  }
}

/** One sentence a model can be handed as the thing the badge is *for*. */
export function describeCriteria(criteria: Criteria): string {
  const n = criteria.threshold;
  switch (criteria.type) {
    case 'tasks_completed':
      return `completing ${n} chores`;
    case 'tasks_of_category':
      return `completing ${n} ${criteria.category ?? 'task'} chores`;
    case 'streak_days':
      return `keeping a ${n}-day streak alive`;
    case 'points_earned':
      return `earning ${n} points`;
    case 'points_spent':
      return `spending ${n} points on rewards`;
    case 'perfect_days':
      return `finishing every chore on ${n} separate days`;
    case 'early_completions':
      return `finishing ${n} chores ahead of their deadline`;
    case 'wildcards_claimed':
      return `claiming ${n} wildcard chores`;
    default:
      return `reaching ${n}`;
  }
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Everything newly earned in this evaluation.
 *
 * `alreadyEarned` is the set of definition ids the member already holds, so a
 * badge fires exactly once. Order is by threshold ascending, so a member who
 * crosses two thresholds at once sees the smaller badge first and the bigger
 * one second — which reads as progression rather than a dump.
 */
export function newlyEarned(
  defs: ReadonlyArray<{ id: string; criteria: Criteria }>,
  stats: MemberStats,
  alreadyEarned: ReadonlySet<string>,
): Array<{ id: string; criteria: Criteria }> {
  return defs
    .filter((def) => !alreadyEarned.has(def.id) && isEarned(def.criteria, stats))
    .sort((a, b) => a.criteria.threshold - b.criteria.threshold);
}

/**
 * The next unearned badge, for a "what am I working toward" nudge.
 * Closest first, measured in absolute distance.
 */
export function nextUp(
  defs: ReadonlyArray<{ id: string; criteria: Criteria }>,
  stats: MemberStats,
  alreadyEarned: ReadonlySet<string>,
): { id: string; criteria: Criteria; remaining: number } | null {
  const candidates = defs
    .filter((def) => !alreadyEarned.has(def.id))
    .map((def) => ({ ...def, remaining: remaining(def.criteria, stats) }))
    .filter((def) => def.remaining > 0)
    .sort((a, b) => a.remaining - b.remaining);

  return candidates[0] ?? null;
}

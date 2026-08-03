import type { Criteria } from './achievements.js';
import type { Tier } from './fallbackCopy.js';

/**
 * The default badge ladder.
 *
 * Without this the entire achievement feature is inert: `listDefs()` reads the
 * AchievementDefs table, the evaluator runs on every approval, the trophy case
 * and the celebration overlay are all built — and nothing writes a definition,
 * so nothing can ever be earned. A gamification system with no achievable
 * achievements looks identical to a broken one.
 *
 * These are the *conditions*, deliberately, not the names. Claude renames a
 * badge at the moment it is earned, which is where the personality comes from;
 * the `name` here is the fallback a household gets when generation is off or
 * unavailable, and it has to read decently on a kitchen wall on its own.
 *
 * Thresholds are chosen so a child crosses something in week one — the first
 * badge has to arrive before anyone decides the feature is decorative — and
 * then spaces out fast enough that the legendary tier means something.
 */
export interface AchievementSeed {
  id: string;
  name: string;
  description: string;
  criteria: Criteria;
  tier: Tier;
  icon: string;
  pointsReward: number;
}

export const DEFAULT_ACHIEVEMENTS: AchievementSeed[] = [
  // Volume. The spine of the ladder — everyone is always making progress here.
  { id: 'first-chore', name: 'Off the Mark', description: 'Finish your first chore.', criteria: { type: 'tasks_completed', threshold: 1 }, tier: 'bronze', icon: '🌱', pointsReward: 5 },
  { id: 'ten-chores', name: 'Getting Somewhere', description: 'Finish 10 chores.', criteria: { type: 'tasks_completed', threshold: 10 }, tier: 'bronze', icon: '🧹', pointsReward: 10 },
  { id: 'fifty-chores', name: 'Reliable', description: 'Finish 50 chores.', criteria: { type: 'tasks_completed', threshold: 50 }, tier: 'silver', icon: '🛠️', pointsReward: 25 },
  { id: 'hundred-chores', name: 'Household Legend', description: 'Finish 100 chores.', criteria: { type: 'tasks_completed', threshold: 100 }, tier: 'gold', icon: '🏅', pointsReward: 50 },
  { id: 'fivehundred-chores', name: 'Immovable', description: 'Finish 500 chores.', criteria: { type: 'tasks_completed', threshold: 500 }, tier: 'legendary', icon: '👑', pointsReward: 150 },

  // Streaks. Evaluated against the LONGEST streak, so these stay earned.
  { id: 'streak-3', name: 'Three in a Row', description: 'Clear your list three days running.', criteria: { type: 'streak_days', threshold: 3 }, tier: 'bronze', icon: '🔥', pointsReward: 10 },
  { id: 'streak-7', name: 'A Full Week', description: 'Clear your list seven days running.', criteria: { type: 'streak_days', threshold: 7 }, tier: 'silver', icon: '🔥', pointsReward: 25 },
  { id: 'streak-30', name: 'A Month Unbroken', description: 'Clear your list thirty days running.', criteria: { type: 'streak_days', threshold: 30 }, tier: 'gold', icon: '🔥', pointsReward: 75 },
  { id: 'streak-100', name: 'One Hundred Days', description: 'Clear your list a hundred days running.', criteria: { type: 'streak_days', threshold: 100 }, tier: 'legendary', icon: '💯', pointsReward: 250 },

  // Points earned. Rewards consistency at higher-value chores.
  { id: 'points-100', name: 'First Hundred', description: 'Earn 100 points.', criteria: { type: 'points_earned', threshold: 100 }, tier: 'bronze', icon: '⭐', pointsReward: 10 },
  { id: 'points-500', name: 'Five Hundred Up', description: 'Earn 500 points.', criteria: { type: 'points_earned', threshold: 500 }, tier: 'silver', icon: '🌟', pointsReward: 25 },
  { id: 'points-2000', name: 'Serious Money', description: 'Earn 2,000 points.', criteria: { type: 'points_earned', threshold: 2000 }, tier: 'gold', icon: '💫', pointsReward: 75 },

  // Spending. Deliberately celebrated — a points economy nobody spends in is a
  // scoreboard, and hoarding is not the behaviour worth reinforcing.
  { id: 'spent-first', name: 'Cashed In', description: 'Redeem your first reward.', criteria: { type: 'points_spent', threshold: 1 }, tier: 'bronze', icon: '🎁', pointsReward: 5 },
  { id: 'spent-500', name: 'Big Spender', description: 'Spend 500 points on rewards.', criteria: { type: 'points_spent', threshold: 500 }, tier: 'silver', icon: '🛒', pointsReward: 20 },

  // Perfect days and punctuality.
  { id: 'perfect-1', name: 'Clean Sweep', description: 'Finish everything on your list in one day.', criteria: { type: 'perfect_days', threshold: 1 }, tier: 'bronze', icon: '✨', pointsReward: 10 },
  { id: 'perfect-10', name: 'Ten Clean Sweeps', description: 'Finish everything on your list, ten times.', criteria: { type: 'perfect_days', threshold: 10 }, tier: 'silver', icon: '✨', pointsReward: 30 },
  { id: 'early-10', name: 'Ahead of Time', description: 'Finish 10 chores before they were due.', criteria: { type: 'early_completions', threshold: 10 }, tier: 'silver', icon: '⏰', pointsReward: 25 },
  { id: 'early-50', name: 'Never Late', description: 'Finish 50 chores before they were due.', criteria: { type: 'early_completions', threshold: 50 }, tier: 'gold', icon: '⏰', pointsReward: 75 },

  // Wildcards, so the bonus mechanic has something pulling at it.
  { id: 'wildcard-5', name: 'Chancer', description: 'Claim 5 wildcard bonuses.', criteria: { type: 'wildcards_claimed', threshold: 5 }, tier: 'bronze', icon: '🃏', pointsReward: 15 },
  { id: 'wildcard-25', name: 'Lucky Streak', description: 'Claim 25 wildcard bonuses.', criteria: { type: 'wildcards_claimed', threshold: 25 }, tier: 'gold', icon: '🃏', pointsReward: 60 },
];

/**
 * Category badges are NOT in the default set, on purpose.
 *
 * `tasks_of_category` needs a category that exists in this household's chore
 * list, and a badge for "kitchen" in a family that never tagged anything
 * kitchen is a badge that can never be earned — worse than absent, because it
 * sits in the trophy case looking like a goal. A parent adds these once the
 * chore list has settled.
 */
export const CATEGORY_BADGE_EXAMPLE: AchievementSeed = {
  id: 'kitchen-10',
  name: 'Kitchen Hand',
  description: 'Finish 10 kitchen chores.',
  criteria: { type: 'tasks_of_category', threshold: 10, category: 'kitchen' },
  tier: 'silver',
  icon: '🍽️',
  pointsReward: 25,
};

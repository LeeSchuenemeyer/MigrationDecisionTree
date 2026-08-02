/**
 * Award arithmetic.
 *
 * Small surface, but it is the number kids will argue about, so the rules are
 * explicit and pinned by tests rather than left to whatever the expression
 * happened to evaluate to.
 */

/** Streak length → multiplier. Checked longest-first. */
export const STREAK_TIERS: ReadonlyArray<{ days: number; multiplier: number }> = [
  { days: 30, multiplier: 1.5 },
  { days: 7, multiplier: 1.25 },
  { days: 3, multiplier: 1.1 },
];

export function streakMultiplier(streakDays: number): number {
  for (const tier of STREAK_TIERS) {
    if (streakDays >= tier.days) return tier.multiplier;
  }
  return 1;
}

export interface AwardInput {
  /** Snapshotted onto the instance at materialization, so editing a task
   *  definition never retroactively changes what a completed chore was worth. */
  basePoints: number;
  /** Surprise double-points and similar, set on the instance. */
  wildcardMultiplier?: number;
  /** Current streak length for this member, in days. */
  streakDays?: number;
}

export interface AwardBreakdown {
  base: number;
  wildcardMultiplier: number;
  streakMultiplier: number;
  /** What actually lands in the ledger. */
  total: number;
  /** Points attributable to multipliers, for the "+5 streak bonus" line. */
  bonus: number;
}

/**
 * Stacking order is multiplicative and fixed: base × wildcard × streak.
 *
 * Multiplicative rather than additive so a wildcard stays exciting for someone
 * on a long streak. Rounding is half-up at the very end, once — rounding after
 * each multiplier would make a 15-point chore worth a different amount
 * depending on which order they were applied.
 */
export function computeAward(input: AwardInput): AwardBreakdown {
  const base = Math.max(0, Math.round(input.basePoints));
  const wildcard = input.wildcardMultiplier && input.wildcardMultiplier > 0 ? input.wildcardMultiplier : 1;
  const streak = streakMultiplier(input.streakDays ?? 0);

  const raw = base * wildcard * streak;
  // Math.round is half-up for positive numbers, which is what we want: a
  // multiplier should never round a chore's value *down*.
  const total = Math.round(raw);

  return {
    base,
    wildcardMultiplier: wildcard,
    streakMultiplier: streak,
    total,
    bonus: total - base,
  };
}

/** One-line explanation for the UI, or null when nothing was applied. */
export function describeBonus(breakdown: AwardBreakdown): string | null {
  const parts: string[] = [];
  if (breakdown.wildcardMultiplier > 1) parts.push(`${breakdown.wildcardMultiplier}× bonus`);
  if (breakdown.streakMultiplier > 1) parts.push(`${breakdown.streakMultiplier}× streak`);
  if (parts.length === 0) return null;
  return `${parts.join(' · ')} → +${breakdown.bonus}`;
}

/**
 * Whether a member can afford a reward.
 *
 * Pending points are deliberately excluded: they are not earned until a parent
 * approves, and letting someone spend them would mean a rejected chore could
 * put a balance underwater.
 */
export function canAfford(pointsBalance: number, cost: number): boolean {
  return pointsBalance >= cost;
}

import { describe, expect, it } from 'vitest';
import { canAfford, computeAward, describeBonus, streakMultiplier } from './points.js';

describe('streak multipliers', () => {
  it('applies the highest tier reached', () => {
    expect(streakMultiplier(0)).toBe(1);
    expect(streakMultiplier(2)).toBe(1);
    expect(streakMultiplier(3)).toBe(1.1);
    expect(streakMultiplier(6)).toBe(1.1);
    expect(streakMultiplier(7)).toBe(1.25);
    expect(streakMultiplier(29)).toBe(1.25);
    expect(streakMultiplier(30)).toBe(1.5);
    expect(streakMultiplier(365)).toBe(1.5);
  });
});

describe('award computation', () => {
  it('returns the base when nothing applies', () => {
    const a = computeAward({ basePoints: 15 });
    expect(a.total).toBe(15);
    expect(a.bonus).toBe(0);
  });

  it('stacks wildcard and streak multiplicatively', () => {
    // 10 × 2 × 1.5 = 30
    const a = computeAward({ basePoints: 10, wildcardMultiplier: 2, streakDays: 30 });
    expect(a.total).toBe(30);
    expect(a.bonus).toBe(20);
  });

  it('rounds once at the end, not after each multiplier', () => {
    // 15 × 1.1 = 16.5 → 17. Rounding 15×1.1 to 17 then ×1 keeps 17;
    // rounding intermediate steps differently would drift.
    expect(computeAward({ basePoints: 15, streakDays: 3 }).total).toBe(17);

    // 15 × 2 × 1.1 = 33 exactly.
    expect(computeAward({ basePoints: 15, wildcardMultiplier: 2, streakDays: 3 }).total).toBe(33);
  });

  it('rounds half-up, so a multiplier never rounds a chore down', () => {
    // 5 × 1.1 = 5.5 → 6
    expect(computeAward({ basePoints: 5, streakDays: 3 }).total).toBe(6);
    // 10 × 1.25 = 12.5 → 13
    expect(computeAward({ basePoints: 10, streakDays: 7 }).total).toBe(13);
  });

  it('never produces less than the base for a positive multiplier', () => {
    for (const base of [1, 5, 10, 15, 25, 100]) {
      for (const days of [0, 3, 7, 30]) {
        const a = computeAward({ basePoints: base, streakDays: days });
        expect(a.total, `base ${base} days ${days}`).toBeGreaterThanOrEqual(base);
      }
    }
  });

  it('clamps nonsense input rather than propagating it', () => {
    expect(computeAward({ basePoints: -5 }).total).toBe(0);
    expect(computeAward({ basePoints: 10, wildcardMultiplier: 0 }).total).toBe(10);
    expect(computeAward({ basePoints: 10, wildcardMultiplier: -3 }).total).toBe(10);
    expect(computeAward({ basePoints: 10.4 }).total).toBe(10);
  });
});

describe('bonus description', () => {
  it('is null when no multiplier applied', () => {
    expect(describeBonus(computeAward({ basePoints: 15 }))).toBeNull();
  });

  it('names each multiplier that applied', () => {
    expect(describeBonus(computeAward({ basePoints: 10, streakDays: 7 }))).toBe('1.25× streak → +3');
    expect(describeBonus(computeAward({ basePoints: 10, wildcardMultiplier: 2 }))).toBe(
      '2× bonus → +10',
    );
    expect(
      describeBonus(computeAward({ basePoints: 10, wildcardMultiplier: 2, streakDays: 30 })),
    ).toBe('2× bonus · 1.5× streak → +20');
  });
});

describe('affordability', () => {
  it('spends only approved points, never pending ones', () => {
    expect(canAfford(120, 120)).toBe(true);
    expect(canAfford(119, 120)).toBe(false);
    // A member with 100 approved and 50 pending cannot buy a 120 reward: the
    // pending 50 could still be rejected, which would leave them underwater.
    expect(canAfford(100, 120)).toBe(false);
  });
});

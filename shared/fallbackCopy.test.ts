import { describe, expect, it } from 'vitest';
import { isPG13 } from './pg13.js';
import {
  FALLBACK_COUNTS,
  fallbackAchievement,
  fallbackChallenge,
  fallbackCommentary,
  hashSeed,
} from './fallbackCopy.js';

const FAMILY = { memberNames: ['Maya', 'Theo', 'Iris', 'Dad', 'Mom'] };

describe('stability', () => {
  it('gives the same line for the same id, so the ticker does not churn', () => {
    // A marquee whose wording changes on every 10s poll reads as broken.
    const a = fallbackCommentary('task_approved', 'feed-123');
    const b = fallbackCommentary('task_approved', 'feed-123');
    expect(a).toBe(b);
  });

  it('gives different lines to different items', () => {
    const lines = new Set(
      Array.from({ length: 20 }, (_, i) => fallbackCommentary('task_approved', `feed-${i}`)),
    );
    expect(lines.size).toBeGreaterThan(3);
  });

  it('holds the challenge steady for a whole day', () => {
    expect(fallbackChallenge('2026-08-02')).toBe(fallbackChallenge('2026-08-02'));
    // ...and moves on to a new one.
    const week = new Set(
      ['02', '03', '04', '05', '06', '07', '08'].map((d) => fallbackChallenge(`2026-08-${d}`)),
    );
    expect(week.size).toBeGreaterThan(3);
  });

  it('hashes consistently', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
  });
});

describe('every hand-written line passes the filter', () => {
  // If a fallback line could not itself survive shared/pg13.ts, the degradation
  // path would be the one thing capable of putting unfiltered text on the wall.
  const kinds = [
    'task_completed',
    'task_approved',
    'streak',
    'redemption',
    'achievement',
    'wildcard',
    'unknown_kind',
  ];

  it('commentary', () => {
    for (const kind of kinds) {
      for (let i = 0; i < 40; i++) {
        const line = fallbackCommentary(kind, `id-${i}`);
        expect(isPG13(line, FAMILY), `${kind}: ${line}`).toBe(true);
      }
    }
  });

  it('challenges', () => {
    for (let d = 1; d <= 31; d++) {
      const line = fallbackChallenge(`2026-08-${String(d).padStart(2, '0')}`);
      expect(isPG13(line, FAMILY), line).toBe(true);
    }
  });

  it('achievements', () => {
    for (const tier of ['bronze', 'silver', 'gold', 'legendary'] as const) {
      for (const noun of ['Dish Slayer', 'Trash Tactician', 'Early Riser']) {
        const badge = fallbackAchievement(tier, noun, `${tier}:${noun}`);
        expect(isPG13(badge.name, FAMILY), badge.name).toBe(true);
        expect(isPG13(badge.description, FAMILY), badge.description).toBe(true);
        expect(isPG13(badge.flavorText, FAMILY), badge.flavorText).toBe(true);
      }
    }
  });
});

describe('achievement shape', () => {
  it('respects the field limits the storage layer enforces', () => {
    const badge = fallbackAchievement('gold', 'Extraordinarily Long Criteria Noun That Goes On', 'x');
    expect(badge.name.length).toBeLessThanOrEqual(40);
    expect(badge.pointsReward).toBeGreaterThanOrEqual(5);
    expect(badge.pointsReward).toBeLessThanOrEqual(200);
  });

  it('scales the reward with the tier', () => {
    const seed = 'same';
    const bronze = fallbackAchievement('bronze', 'Tidier', seed);
    const legendary = fallbackAchievement('legendary', 'Tidier', seed);
    expect(legendary.pointsReward).toBeGreaterThan(bronze.pointsReward);
  });

  it('survives an empty criteria noun rather than producing a dangling name', () => {
    const badge = fallbackAchievement('silver', '   ', 'x');
    expect(badge.name.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
  });
});

describe('coverage', () => {
  it('has enough lines that repeats are rare', () => {
    // The plan calls for ~50 templates; below that the ticker starts to feel
    // like a screensaver.
    expect(FALLBACK_COUNTS.commentary).toBeGreaterThanOrEqual(45);
    expect(FALLBACK_COUNTS.challenges).toBeGreaterThanOrEqual(30);
  });
});

import { describe, expect, it } from 'vitest';
import {
  criteriaNoun,
  describeCriteria,
  emptyStats,
  isEarned,
  newlyEarned,
  nextUp,
  remaining,
  tierFor,
  valueFor,
  type Criteria,
  type MemberStats,
} from './achievements.js';

function stats(over: Partial<MemberStats> = {}): MemberStats {
  return { ...emptyStats(), ...over };
}

describe('threshold boundaries', () => {
  // n-1 / n / n+1 for every criteria type. Off-by-one here means a badge that
  // fires a chore early or never fires at all, and nobody notices for weeks.
  const cases: Array<{ criteria: Criteria; key: keyof MemberStats }> = [
    { criteria: { type: 'tasks_completed', threshold: 10 }, key: 'tasksCompleted' },
    { criteria: { type: 'streak_days', threshold: 7 }, key: 'longestStreak' },
    { criteria: { type: 'points_earned', threshold: 500 }, key: 'lifetimePoints' },
    { criteria: { type: 'points_spent', threshold: 200 }, key: 'pointsSpent' },
    { criteria: { type: 'perfect_days', threshold: 5 }, key: 'perfectDays' },
    { criteria: { type: 'early_completions', threshold: 3 }, key: 'earlyCompletions' },
    { criteria: { type: 'wildcards_claimed', threshold: 4 }, key: 'wildcardsClaimed' },
  ];

  for (const { criteria, key } of cases) {
    it(`${criteria.type} fires at exactly ${criteria.threshold}`, () => {
      const n = criteria.threshold;
      expect(isEarned(criteria, stats({ [key]: n - 1 } as Partial<MemberStats>))).toBe(false);
      expect(isEarned(criteria, stats({ [key]: n } as Partial<MemberStats>))).toBe(true);
      expect(isEarned(criteria, stats({ [key]: n + 1 } as Partial<MemberStats>))).toBe(true);
    });
  }

  it('tasks_of_category counts only its own category', () => {
    const criteria: Criteria = { type: 'tasks_of_category', threshold: 3, category: 'kitchen' };
    expect(isEarned(criteria, stats({ tasksByCategory: { kitchen: 2, pets: 9 } }))).toBe(false);
    expect(isEarned(criteria, stats({ tasksByCategory: { kitchen: 3 } }))).toBe(true);
  });

  it('tasks_of_category without a category never fires, rather than matching everything', () => {
    const criteria: Criteria = { type: 'tasks_of_category', threshold: 1 };
    expect(valueFor(criteria, stats({ tasksByCategory: { kitchen: 99 } }))).toBeNull();
    expect(isEarned(criteria, stats({ tasksByCategory: { kitchen: 99 } }))).toBe(false);
  });
});

describe('streaks use the personal best', () => {
  it('stays earned after the streak breaks', () => {
    // A 30-day badge that vanishes when the streak lapses makes every badge
    // feel provisional, which defeats the point of a trophy case.
    const criteria: Criteria = { type: 'streak_days', threshold: 30 };
    const broken = stats({ longestStreak: 34, currentStreak: 0 });
    expect(isEarned(criteria, broken)).toBe(true);
  });
});

describe('remaining', () => {
  it('counts down and floors at zero', () => {
    const criteria: Criteria = { type: 'tasks_completed', threshold: 10 };
    expect(remaining(criteria, stats({ tasksCompleted: 0 }))).toBe(10);
    expect(remaining(criteria, stats({ tasksCompleted: 7 }))).toBe(3);
    expect(remaining(criteria, stats({ tasksCompleted: 10 }))).toBe(0);
    expect(remaining(criteria, stats({ tasksCompleted: 99 }))).toBe(0);
  });
});

describe('newlyEarned', () => {
  const defs = [
    { id: 'a', criteria: { type: 'tasks_completed', threshold: 5 } as Criteria },
    { id: 'b', criteria: { type: 'tasks_completed', threshold: 25 } as Criteria },
    { id: 'c', criteria: { type: 'streak_days', threshold: 7 } as Criteria },
  ];

  it('returns nothing when nothing is met', () => {
    expect(newlyEarned(defs, stats({ tasksCompleted: 1 }), new Set())).toHaveLength(0);
  });

  it('never re-awards something already held', () => {
    const held = new Set(['a']);
    const out = newlyEarned(defs, stats({ tasksCompleted: 30 }), held);
    expect(out.map((d) => d.id)).toEqual(['b']);
  });

  it('orders simultaneous unlocks smallest-first, so it reads as progression', () => {
    const out = newlyEarned(defs, stats({ tasksCompleted: 30, longestStreak: 9 }), new Set());
    expect(out.map((d) => d.criteria.threshold)).toEqual([5, 7, 25]);
  });
});

describe('nextUp', () => {
  const defs = [
    { id: 'a', criteria: { type: 'tasks_completed', threshold: 5 } as Criteria },
    { id: 'b', criteria: { type: 'tasks_completed', threshold: 25 } as Criteria },
  ];

  it('picks the closest unearned badge', () => {
    const out = nextUp(defs, stats({ tasksCompleted: 4 }), new Set());
    expect(out?.id).toBe('a');
    expect(out?.remaining).toBe(1);
  });

  it('skips badges already held', () => {
    const out = nextUp(defs, stats({ tasksCompleted: 4 }), new Set(['a']));
    expect(out?.id).toBe('b');
  });

  it('returns null when everything is earned', () => {
    expect(nextUp(defs, stats({ tasksCompleted: 100 }), new Set())).toBeNull();
  });
});

describe('tiers', () => {
  it('scales with difficulty', () => {
    expect(tierFor({ type: 'tasks_completed', threshold: 5 })).toBe('bronze');
    expect(tierFor({ type: 'tasks_completed', threshold: 25 })).toBe('silver');
    expect(tierFor({ type: 'tasks_completed', threshold: 100 })).toBe('gold');
    expect(tierFor({ type: 'tasks_completed', threshold: 250 })).toBe('legendary');
  });

  it('uses a different scale for streaks, where 100 days is the keepsake', () => {
    expect(tierFor({ type: 'streak_days', threshold: 3 })).toBe('bronze');
    expect(tierFor({ type: 'streak_days', threshold: 30 })).toBe('gold');
    expect(tierFor({ type: 'streak_days', threshold: 100 })).toBe('legendary');
  });

  it('uses a points scale, so 500 points is not legendary', () => {
    expect(tierFor({ type: 'points_earned', threshold: 500 })).toBe('silver');
    expect(tierFor({ type: 'points_earned', threshold: 5000 })).toBe('legendary');
  });
});

describe('prose for the model and the fallback namer', () => {
  it('produces a noun phrase for every criteria type', () => {
    const types: Criteria['type'][] = [
      'tasks_completed',
      'tasks_of_category',
      'streak_days',
      'points_earned',
      'points_spent',
      'perfect_days',
      'early_completions',
      'wildcards_claimed',
    ];
    for (const type of types) {
      const noun = criteriaNoun({ type, threshold: 10, category: 'kitchen' });
      expect(noun.length).toBeGreaterThan(0);
      expect(noun).not.toContain('undefined');
    }
  });

  it('describes the criterion as something a badge can be for', () => {
    expect(describeCriteria({ type: 'streak_days', threshold: 30 })).toContain('30');
    expect(describeCriteria({ type: 'tasks_of_category', threshold: 5, category: 'kitchen' })).toContain(
      'kitchen',
    );
  });
});

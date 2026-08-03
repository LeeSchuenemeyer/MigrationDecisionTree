import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-catalog';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';
delete process.env['ANTHROPIC_API_KEY'];

const { TABLES, achievementDefPK, achievementDefRK } = await import('../../shared/keys.js');
const { ensureTables, listPartition, upsert } = await import('../src/lib/tables.js');
const { DEFAULT_ACHIEVEMENTS } = await import('../../shared/achievementCatalog.js');
const { emptyStats, isEarned } = await import('../../shared/achievements.js');
const { ensureDefaultDefs, listDefs } = await import('../src/services/achievements.js');
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-catalog';

beforeAll(async () => {
  await ensureTables();
});

beforeEach(async () => {
  await purgeHousehold(HH);
});

/**
 * The regression this file exists for.
 *
 * Everything about achievements was built — the criteria evaluator, the Claude
 * namer, the tier ladder, the trophy case, the celebration overlay — and
 * nothing ever wrote a definition row. `listDefs()` returned an empty array
 * forever, `evaluateAchievements` short-circuited on it, and no member could
 * earn a badge under any circumstances. Every test passed; the headline
 * feature of the product did not work.
 */
describe('the default badge ladder', () => {
  it('installs itself on first read, so a fresh household can earn badges', async () => {
    expect(await listPartition(TABLES.achievementDefs, achievementDefPK(HH))).toHaveLength(0);

    const defs = await listDefs();

    expect(defs.length).toBe(DEFAULT_ACHIEVEMENTS.length);
  });

  it('is idempotent — installing twice does not duplicate or reset', async () => {
    const first = await ensureDefaultDefs();
    const second = await ensureDefaultDefs();

    expect(first).toBe(DEFAULT_ACHIEVEMENTS.length);
    expect(second).toBe(0);
    expect(await listPartition(TABLES.achievementDefs, achievementDefPK(HH))).toHaveLength(
      DEFAULT_ACHIEVEMENTS.length,
    );
  });

  it('does not undo a parent editing or deactivating a badge', async () => {
    await ensureDefaultDefs();

    await upsert(TABLES.achievementDefs, {
      partitionKey: achievementDefPK(HH),
      rowKey: achievementDefRK('first-chore'),
      name: 'Our Own Name',
      active: false,
    });

    await ensureDefaultDefs();
    const defs = await listDefs();

    // Deactivated stays deactivated...
    expect(defs.find((d) => d.id === 'first-chore')).toBeUndefined();
    // ...and the rename survives.
    const raw = await listPartition<{ name: string }>(
      TABLES.achievementDefs,
      achievementDefPK(HH),
    );
    expect(raw.find((r) => r.rowKey === achievementDefRK('first-chore'))?.name).toBe('Our Own Name');
  });

  it('does not re-install once a household has definitions', async () => {
    // A household that deliberately deleted most of the ladder must not have it
    // silently restored on the next read — only a completely empty partition
    // counts as "never installed".
    await upsert(TABLES.achievementDefs, {
      partitionKey: achievementDefPK(HH),
      rowKey: achievementDefRK('only-one'),
      name: 'Only One',
      description: 'The only badge this family wants.',
      criteriaJson: JSON.stringify({ type: 'tasks_completed', threshold: 1 }),
      tier: 'bronze',
      icon: '⭐',
      pointsReward: 5,
      active: true,
      createdAt: new Date().toISOString(),
    });

    const defs = await listDefs();

    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('only-one');
  });
});

describe('the catalog itself', () => {
  it('has a badge reachable on day one', () => {
    // If the cheapest badge takes a fortnight, everyone decides the feature is
    // decorative before it ever fires.
    const stats = { ...emptyStats(), tasksCompleted: 1 };
    const reachable = DEFAULT_ACHIEVEMENTS.filter((a) => isEarned(a.criteria, stats));

    expect(reachable.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = DEFAULT_ACHIEVEMENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no unreachable category badges', () => {
    // `tasks_of_category` needs a category this household actually uses. A
    // default badge for a category nobody tagged sits in the trophy case
    // looking like a goal and can never be earned — worse than absent.
    expect(DEFAULT_ACHIEVEMENTS.some((a) => a.criteria.type === 'tasks_of_category')).toBe(false);
  });

  it('gives every criteria type at least one badge', () => {
    // A counter maintained on every approval that no badge reads is dead code
    // that still costs a write.
    const covered = new Set(DEFAULT_ACHIEVEMENTS.map((a) => a.criteria.type));
    for (const type of [
      'tasks_completed',
      'streak_days',
      'points_earned',
      'points_spent',
      'perfect_days',
      'early_completions',
      'wildcards_claimed',
    ]) {
      expect(covered.has(type as never), `no badge uses ${type}`).toBe(true);
    }
  });

  it('escalates tier with threshold within each criteria type', () => {
    const rank = { bronze: 0, silver: 1, gold: 2, legendary: 3 } as const;
    const byType = new Map<string, typeof DEFAULT_ACHIEVEMENTS>();
    for (const a of DEFAULT_ACHIEVEMENTS) {
      byType.set(a.criteria.type, [...(byType.get(a.criteria.type) ?? []), a]);
    }

    for (const [type, list] of byType) {
      const sorted = [...list].sort((a, b) => a.criteria.threshold - b.criteria.threshold);
      for (let i = 1; i < sorted.length; i++) {
        expect(
          rank[sorted[i]!.tier] >= rank[sorted[i - 1]!.tier],
          `${type}: ${sorted[i]!.id} is a lower tier than the easier ${sorted[i - 1]!.id}`,
        ).toBe(true);
      }
    }
  });
});

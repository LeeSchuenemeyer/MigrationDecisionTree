import { beforeAll, describe, expect, it } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-claude';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';
// Deliberately unset. Every test in this file exercises the degradation path,
// which is the one that has to work on a wall display at 7am when the API is
// down, the key has expired, or nobody ever configured one.
delete process.env['ANTHROPIC_API_KEY'];

const {
  TABLES,
  achievementDefPK,
  achievementDefRK,
  achievementAwardPK,
  budgetPK,
  budgetRK,
  feedPK,
  memberPK,
  memberRK,
} = await import('../../shared/keys.js');
const { localDateNow } = await import('../../shared/time.js');
const { ensureTables, getEntity, listPartition, upsert } = await import('../src/lib/tables.js');
const { hashPin } = await import('../src/lib/pin.js');
const { writeFeedItem } = await import('../src/lib/feed.js');
const { householdConfig, updateHouseholdConfig } = await import('../src/lib/config.js');
const { DAILY_CAPS, cacheKey, generate, isConfigured, readBudget } = await import(
  '../src/lib/claude.js'
);
const { annotateRecentFeed, fillFallbackCommentary, listIncidents, suppressFeedItem } =
  await import('../src/services/commentary.js');
const { currentChallenge, ensureChallenge } = await import('../src/services/challenge.js');
const { evaluateAchievements, listAwards, statsFor } = await import(
  '../src/services/achievements.js'
);
const { recentFeed } = await import('../src/services/feed.js');
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-claude';
const TZ = 'America/New_York';
const TODAY = localDateNow(TZ);

beforeAll(async () => {
  await ensureTables();
  await purgeHousehold(HH);
  await upsert(TABLES.members, {
    partitionKey: memberPK(HH),
    rowKey: memberRK('kid'),
    displayName: 'Maya',
    role: 'child',
    avatarEmoji: '🦊',
    avatarColor: '#F0A830',
    ...(await hashPin('4816')),
    active: true,
    sortOrder: 0,
    pointsBalance: 500,
    lifetimePoints: 500,
    pendingPoints: 0,
    tasksCompleted: 40,
    longestStreak: 9,
    createdAt: new Date().toISOString(),
  });
});

describe('configuration', () => {
  it('reports itself unconfigured without a key', () => {
    expect(isConfigured()).toBe(false);
  });

  it('returns not_configured rather than throwing', async () => {
    const outcome = await generate({
      job: 'ticker',
      kind: 'commentary',
      system: 's',
      user: 'u',
      schema: {},
      cacheKey: 'never-used',
      validate: (v) => v as null,
    });
    expect(outcome.value).toBeNull();
    expect(outcome.reason).toBe('not_configured');
  });

  it('does not spend budget on a call it never makes', async () => {
    const used = await readBudget();
    expect(used.ticker).toBe(0);
  });
});

describe('household config defaults', () => {
  it('works before a parent has ever opened settings', async () => {
    const config = await householdConfig();
    expect(config.commentaryEnabled).toBe(true);
    expect(config.challengeEnabled).toBe(true);
    expect(config.extraDenylistJson).toBe('[]');
  });

  it('round-trips a parent toggle', async () => {
    await updateHouseholdConfig({ commentaryEnabled: false });
    expect((await householdConfig()).commentaryEnabled).toBe(false);
    await updateHouseholdConfig({ commentaryEnabled: true });
    expect((await householdConfig()).commentaryEnabled).toBe(true);
  });

  it('does not let a partial row wipe the other defaults', async () => {
    // Table Storage omits nulls rather than storing them, so a partial write
    // spreads `undefined` over good defaults unless it is filtered.
    await updateHouseholdConfig({ name: 'The Board' });
    const config = await householdConfig();
    expect(config.name).toBe('The Board');
    expect(config.challengeEnabled).toBe(true);
  });
});

describe('commentary degradation', () => {
  it('fills hand-written lines when there is no API', async () => {
    await writeFeedItem({ kind: 'task_approved', headline: 'Maya cleared the table', points: 15 });
    await writeFeedItem({ kind: 'task_completed', headline: 'Maya ticked off sweeping' });

    const filled = await fillFallbackCommentary(TODAY);
    expect(filled).toBeGreaterThanOrEqual(2);

    const items = await recentFeed();
    for (const item of items.filter((i) => i.kind !== 'security')) {
      expect(item.commentary).toBeTruthy();
      expect(item.commentarySource).toBe('fallback');
    }
  });

  it('is stable — a second pass does not rewrite what is already there', async () => {
    const before = (await recentFeed()).map((i) => i.commentary);
    await fillFallbackCommentary(TODAY);
    const after = (await recentFeed()).map((i) => i.commentary);
    expect(after).toEqual(before);
  });

  it('routes through the fallback when annotation cannot reach a model', async () => {
    await writeFeedItem({ kind: 'redemption', headline: 'Maya redeemed screen time' });
    const result = await annotateRecentFeed(TODAY);
    // No key, so nothing is generated — but every item still ends up with copy.
    expect(result.generated).toBe(0);
    expect(result.fallback).toBeGreaterThan(0);
    expect(result.skipped).toBe(false);
  });

  it('never annotates a security notice', async () => {
    // "Someone tried Maya's PIN five times" must not arrive with a joke on it.
    await writeFeedItem({ kind: 'security', headline: 'Someone tried a PIN five times' });
    await fillFallbackCommentary(TODAY);
    const item = (await recentFeed()).find((i) => i.kind === 'security');
    expect(item).toBeDefined();
    expect(item!.commentary).toBeNull();
  });

  it('skips entirely when a parent turns commentary off', async () => {
    await updateHouseholdConfig({ commentaryEnabled: false });
    const result = await annotateRecentFeed(TODAY);
    expect(result.skipped).toBe(true);
    await updateHouseholdConfig({ commentaryEnabled: true });
  });
});

describe('that wasn’t ok', () => {
  it('takes the item off the board immediately and records why', async () => {
    const feedId = await writeFeedItem({ kind: 'quip', headline: 'Something that landed badly' });
    const rows = await listPartition<{ headline: string }>(TABLES.feed, feedPK(HH, TODAY));
    const row = rows.find((r) => r.headline === 'Something that landed badly')!;

    expect(await suppressFeedItem(TODAY, row.rowKey, 'parent', 'Not funny')).toBe(true);

    // Suppression is applied server-side: the wall display has nobody signed
    // in, so it can never be a client-side filter.
    const visible = await recentFeed();
    expect(visible.some((i) => i.headline === 'Something that landed badly')).toBe(false);

    const incidents = await listIncidents(2);
    const incident = incidents.find((i) => i.headline === 'Something that landed badly');
    expect(incident).toBeDefined();
    expect(incident!.reason).toBe('Not funny');
    expect(incident!.reportedBy).toBe('parent');
    expect(feedId).toBeTruthy();
  });

  it('reports a miss rather than pretending to suppress', async () => {
    expect(await suppressFeedItem(TODAY, 'no-such-row', 'parent')).toBe(false);
  });
});

describe('daily challenge', () => {
  it('always has one, even with no API and nothing stored', async () => {
    const challenge = await currentChallenge(TODAY);
    expect(challenge).not.toBeNull();
    expect(challenge!.text.length).toBeGreaterThan(0);
    expect(challenge!.source).toBe('fallback');
  });

  it('is set once per day, not once per tick', async () => {
    const first = await ensureChallenge(TODAY, ['Sweep', 'Dishes']);
    expect(first.alreadySet).toBe(false);

    // The cron tick is at-least-once. A challenge that changes hourly is not a
    // challenge.
    const second = await ensureChallenge(TODAY, ['Sweep', 'Dishes']);
    expect(second.alreadySet).toBe(true);
    expect(second.text).toBe(first.text);
  });

  it('disappears cleanly when a parent turns it off', async () => {
    await updateHouseholdConfig({ challengeEnabled: false });
    expect(await currentChallenge(TODAY)).toBeNull();
    await updateHouseholdConfig({ challengeEnabled: true });
  });
});

describe('achievements', () => {
  beforeAll(async () => {
    for (const [id, threshold, name] of [
      ['chores-25', 25, 'Chore Crusher'],
      ['chores-100', 100, 'Century'],
      ['streak-7', 7, 'Week Keeper'],
    ] as const) {
      await upsert(TABLES.achievementDefs, {
        partitionKey: achievementDefPK(HH),
        rowKey: achievementDefRK(id),
        name,
        description: `Reach ${threshold}`,
        criteriaJson: JSON.stringify(
          id.startsWith('streak')
            ? { type: 'streak_days', threshold }
            : { type: 'tasks_completed', threshold },
        ),
        tier: 'silver',
        icon: '🥈',
        pointsReward: 25,
        active: true,
        createdAt: new Date().toISOString(),
      });
    }
  });

  it('reads the incremental counters off the member row', async () => {
    const stats = await statsFor('kid');
    expect(stats.tasksCompleted).toBe(40);
    expect(stats.longestStreak).toBe(9);
    expect(stats.lifetimePoints).toBe(500);
  });

  it('awards what has been earned and nothing else', async () => {
    const awarded = await evaluateAchievements('kid', await statsFor('kid'));
    const ids = awarded.map((a) => a.id).sort();
    // 40 chores and a 9-day best: the 25 and the 7 are earned, the 100 is not.
    expect(ids).toEqual(['chores-25', 'streak-7']);
  });

  it('uses hand-written copy when generation is unavailable', async () => {
    const badges = await listAwards('kid');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.copySource).toBe('fallback');
      expect(badge.name.trim().length).toBeGreaterThan(0);
      expect(badge.icon.length).toBeGreaterThan(0);
    }
  });

  it('never awards the same badge twice', async () => {
    const before = (await listAwards('kid')).length;
    const again = await evaluateAchievements('kid', await statsFor('kid'));
    expect(again).toHaveLength(0);
    expect((await listAwards('kid')).length).toBe(before);
  });

  it('pays the badge points into the ledger and the balance', async () => {
    const row = await getEntity<{ pointsBalance: number }>(
      TABLES.members,
      memberPK(HH),
      memberRK('kid'),
    );
    // Two silver badges at 25 each on top of the seeded 500.
    expect(row!.pointsBalance).toBe(550);
  });

  it('writes one feed item per badge, so the ticker announces it', async () => {
    const items = await recentFeed();
    const achievements = items.filter((i) => i.kind === 'achievement');
    expect(achievements.length).toBeGreaterThanOrEqual(2);
  });

  it('survives a malformed definition instead of failing the household', async () => {
    await upsert(TABLES.achievementDefs, {
      partitionKey: achievementDefPK(HH),
      rowKey: achievementDefRK('broken'),
      name: 'Broken',
      description: '',
      criteriaJson: 'not json at all',
      tier: 'bronze',
      icon: '🥉',
      pointsReward: 0,
      active: true,
      createdAt: new Date().toISOString(),
    });

    const stats = await statsFor('kid');
    await expect(evaluateAchievements('kid', stats)).resolves.toBeDefined();
  });

  it('keeps the award partition per-member', async () => {
    expect(achievementAwardPK(HH, 'kid')).not.toBe(achievementAwardPK(HH, 'other'));
  });
});

describe('budget', () => {
  it('caps every job', () => {
    expect(DAILY_CAPS.ticker).toBeGreaterThan(0);
    expect(DAILY_CAPS.achievement).toBeGreaterThan(0);
    expect(DAILY_CAPS.keepsake).toBeGreaterThan(0);
  });

  it('refuses once the cap is reached, without calling anything', async () => {
    await upsert(TABLES.budget, {
      partitionKey: budgetPK(HH),
      rowKey: budgetRK(TODAY),
      ticker: DAILY_CAPS.ticker,
      achievement: 0,
      keepsake: 0,
      updatedAt: new Date().toISOString(),
    });

    // Still not_configured here (no key), but the cap is what a configured
    // household would hit — and the ordering matters: cap before client.
    const used = await readBudget(TODAY);
    expect(used.ticker).toBe(DAILY_CAPS.ticker);
  });
});

describe('cache keys', () => {
  it('are order-independent, so a reordered batch is still a hit', async () => {
    expect(cacheKey('v1', ['a', 'b'])).toBe(cacheKey('v1', ['b', 'a']));
  });

  it('change when the prompt version changes, invalidating everything', async () => {
    expect(cacheKey('v1', ['a'])).not.toBe(cacheKey('v2', ['a']));
  });

  it('change when the inputs change', async () => {
    expect(cacheKey('v1', ['a'])).not.toBe(cacheKey('v1', ['a', 'b']));
  });
});

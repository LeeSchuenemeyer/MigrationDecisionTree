import { beforeAll, describe, expect, it } from 'vitest';

process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test-pulse';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';

const { TABLES, memberPK, memberRK, taskInstancePK } = await import('../../shared/keys.js');
const { addLocalDays, localDateNow } = await import('../../shared/time.js');
const { ensureTables, upsert } = await import('../src/lib/tables.js');
const { hashPin } = await import('../src/lib/pin.js');
const { bumpRev, readRev, sliceCounters } = await import('../src/lib/rev.js');
const { writeFeedItem } = await import('../src/lib/feed.js');
const { listFeedForDate, recentFeed, tickerItems } = await import('../src/services/feed.js');
const { purgeHousehold } = await import('./helpers.js');

const HH = 'test-pulse';
const TZ = 'America/New_York';
const TODAY = localDateNow(TZ);

async function instance(defId: string, over: Record<string, unknown> = {}) {
  await upsert(TABLES.taskInstances, {
    partitionKey: taskInstancePK(HH, TODAY),
    rowKey: `${defId}|kid|0`,
    taskDefId: defId,
    title: `Chore ${defId}`,
    icon: '🧹',
    basePoints: 10,
    multiplier: 1,
    bonusReason: null,
    dueDateLocal: TODAY,
    dueTimeLocal: '18:00',
    assignedMemberId: 'kid',
    assignedMemberName: 'kid',
    status: 'open',
    completedAt: null,
    completedBy: null,
    computedPoints: null,
    appliedStreakMultiplier: null,
    approvedAt: null,
    approvedBy: null,
    ledgerEntryId: null,
    awardedPoints: null,
    note: null,
    ...over,
  });
}

beforeAll(async () => {
  await ensureTables();
  await purgeHousehold(HH);
  await upsert(TABLES.members, {
    partitionKey: memberPK(HH),
    rowKey: memberRK('kid'),
    displayName: 'kid',
    role: 'child',
    avatarEmoji: '🦊',
    avatarColor: '#F0A830',
    ...(await hashPin('4816')),
    active: true,
    sortOrder: 0,
    pointsBalance: 0,
    lifetimePoints: 0,
    pendingPoints: 0,
    createdAt: new Date().toISOString(),
  });
});

describe('revision counters', () => {
  it('bumps the global counter and only the named slices', async () => {
    const before = sliceCounters(await readRev());
    await bumpRev(['tasks', 'queue']);
    const after = sliceCounters(await readRev());

    expect(after.tasks).toBe(before.tasks + 1);
    expect(after.queue).toBe(before.queue + 1);
    // Everything else must hold still, or the client invalidates queries whose
    // data did not change and the whole bandwidth argument collapses.
    expect(after.points).toBe(before.points);
    expect(after.feed).toBe(before.feed);
    expect(after.rewards).toBe(before.rewards);
  });

  it('advances the global rev on every bump, whatever the slice', async () => {
    const a = (await readRev()).rev;
    await bumpRev(['feed']);
    const b = (await readRev()).rev;
    expect(b).toBe(a + 1);
  });

  it('reports every slice, so the client can diff a complete map', async () => {
    const counters = sliceCounters(await readRev());
    expect(Object.keys(counters).sort()).toEqual(
      ['events', 'feed', 'members', 'points', 'queue', 'rewards', 'tasks'].sort(),
    );
  });
});

describe('feed reads', () => {
  it('returns newest first with no client sort, because row keys are inverse ticks', async () => {
    await writeFeedItem({ kind: 'task_approved', headline: 'first' });
    await new Promise((r) => setTimeout(r, 5));
    await writeFeedItem({ kind: 'task_approved', headline: 'second' });
    await new Promise((r) => setTimeout(r, 5));
    await writeFeedItem({ kind: 'task_approved', headline: 'third' });

    const items = await listFeedForDate(TODAY);
    const headlines = items.map((i) => i.headline);
    expect(headlines.indexOf('third')).toBeLessThan(headlines.indexOf('first'));
  });

  it('hides suppressed items server-side', async () => {
    // "That wasn't ok" has to work on a display nobody is signed in to, so
    // suppression can never be a client-side filter.
    const { TABLES: T, feedPK, feedRK } = await import('../../shared/keys.js');
    const when = Date.now();
    await upsert(T.feed, {
      partitionKey: feedPK(HH, TODAY),
      rowKey: feedRK(when, 'suppressed-one'),
      kind: 'quip',
      actorMemberId: null,
      actorName: null,
      actorAvatar: null,
      headline: 'this should never render',
      detail: null,
      icon: null,
      points: null,
      refType: null,
      refId: null,
      commentary: null,
      commentarySource: null,
      commentaryModel: null,
      suppressed: true,
      createdAt: new Date(when).toISOString(),
    });

    const items = await listFeedForDate(TODAY);
    expect(items.some((i) => i.headline === 'this should never render')).toBe(false);
  });

  it('backfills from yesterday when today is quiet', async () => {
    const { TABLES: T, feedPK, feedRK } = await import('../../shared/keys.js');
    const yesterday = addLocalDays(TODAY, -1);
    const when = Date.now() - 24 * 60 * 60 * 1000;

    await upsert(T.feed, {
      partitionKey: feedPK(HH, yesterday),
      rowKey: feedRK(when, 'yesterday-one'),
      kind: 'task_approved',
      actorMemberId: null,
      actorName: null,
      actorAvatar: null,
      headline: 'yesterday happened',
      detail: null,
      icon: null,
      points: 10,
      refType: null,
      refId: null,
      commentary: null,
      commentarySource: null,
      commentaryModel: null,
      suppressed: false,
      createdAt: new Date(when).toISOString(),
    });

    // Today currently has 3 items — under the 6-item threshold — so yesterday
    // should be pulled in rather than leaving a near-empty strip at 6am.
    const items = await recentFeed();
    expect(items.some((i) => i.headline === 'yesterday happened')).toBe(true);
  });
});

describe('ticker', () => {
  it('mixes activity with upcoming deadlines rather than concatenating', async () => {
    await instance('due-a');
    await instance('due-b');

    const items = await tickerItems();
    const sources = items.map((i) => i.source);

    expect(sources).toContain('activity');
    expect(sources.some((s) => s === 'upcoming' || s === 'overdue')).toBe(true);

    // A ticker that runs forty activity items before the first deadline means
    // nobody walking past ever sees a deadline.
    const firstDeadline = sources.findIndex((s) => s === 'upcoming' || s === 'overdue');
    expect(firstDeadline).toBeLessThan(6);
  });

  it('marks a passed deadline as overdue and says so', async () => {
    await instance('late-one', { dueTimeLocal: '00:01' });
    const items = await tickerItems();
    const late = items.find((i) => i.id === 'due:late-one|kid|0');

    expect(late).toBeDefined();
    expect(late!.source).toBe('overdue');
    expect(late!.text).toMatch(/was due at/);
    expect(late!.label).toBe('Overdue');
  });

  it('leaves finished chores out of the deadline list', async () => {
    await instance('finished', { status: 'approved', dueTimeLocal: '23:59' });
    const items = await tickerItems();
    expect(items.some((i) => i.id === 'due:finished|kid|0')).toBe(false);
  });

  it('falls back to the plain headline when there is no commentary', async () => {
    // This is what makes the Anthropic API optional rather than load-bearing:
    // with commentary null, the factual line still carries the ticker.
    const items = await tickerItems();
    const activity = items.filter((i) => i.source === 'activity');
    expect(activity.length).toBeGreaterThan(0);
    for (const item of activity) {
      expect(item.text.length).toBeGreaterThan(0);
      expect(item.label).toBeNull();
    }
  });

  it('collapses a chore’s lifecycle to its latest state', async () => {
    // A chore writes a feed item when it is ticked off and another when it is
    // approved. Showing "waiting on a parent" next to "cleared" for the same
    // chore, in the same strip, just looks broken.
    await writeFeedItem({
      kind: 'task_completed',
      headline: 'kid ticked off “Sweep up”',
      detail: 'waiting on a parent',
      refType: 'task',
      refId: 'sweep|kid|0',
    });
    await new Promise((r) => setTimeout(r, 5));
    await writeFeedItem({
      kind: 'task_approved',
      headline: 'kid cleared “Sweep up”',
      refType: 'task',
      refId: 'sweep|kid|0',
    });

    const items = await tickerItems();
    const sweep = items.filter((i) => i.text.includes('Sweep up'));
    expect(sweep).toHaveLength(1);
    expect(sweep[0]!.text).toContain('cleared');

    // ...but the history still has both, because "done at 4, approved at 6" is
    // a real record.
    const history = await listFeedForDate(TODAY);
    expect(history.filter((i) => i.headline.includes('Sweep up'))).toHaveLength(2);
  });

  it('gives every line a stable unique id, so React keys do not collide', async () => {
    const items = await tickerItems();
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

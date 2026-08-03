/**
 * Seed a household for local development.
 *
 *   cp api/local.settings.example.json api/local.settings.json
 *   (start azurite)
 *   npm run seed --prefix api
 *
 * Backdated feed history is the point of this script, not decoration. Without
 * it you cannot meaningfully look at the ticker, the leaderboard, or (once
 * Phase 3 lands) streaks — everything renders empty and every layout decision
 * is a guess.
 *
 * Refuses to run against a non-local household so it can never be pointed at
 * real family data.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Load local.settings.json into process.env before anything reads env.
const here = dirname(fileURLToPath(import.meta.url));
try {
  const raw = readFileSync(resolve(here, '../local.settings.json'), 'utf8');
  const values = (JSON.parse(raw) as { Values?: Record<string, string> }).Values ?? {};
  for (const [k, v] of Object.entries(values)) process.env[k] ??= v;
} catch {
  // Fall back to whatever is already in the environment.
}

const {
  CONFIG_ROWS,
  STREAK_DAILY_ALL,
  TABLES,
  configPK,
  configRK,
  feedPK,
  feedRK,
  ledgerPK,
  ledgerRK,
  memberPK,
  memberRK,
  rewardPK,
  rewardRK,
  streakPK,
  streakRK,
  taskDefPK,
  taskDefRK,
} = await import('../../shared/keys.js');
const { addLocalDays, localDateOf, localDateNow, yearMonthOfLocalDate } = await import(
  '../../shared/time.js'
);
const { env } = await import('../src/lib/env.js');
const { ensureTables, upsert } = await import('../src/lib/tables.js');
const { hashPin } = await import('../src/lib/pin.js');

const SAFE_HOUSEHOLDS = new Set(['local', 'preview', 'test']);
if (!SAFE_HOUSEHOLDS.has(env.householdId)) {
  console.error(
    `Refusing to seed HOUSEHOLD_ID="${env.householdId}". ` +
      `Only ${[...SAFE_HOUSEHOLDS].join(', ')} are allowed.`,
  );
  process.exit(1);
}

interface SeedMember {
  id: string;
  displayName: string;
  role: 'parent' | 'child';
  avatarEmoji: string;
  avatarColor: string;
  pin: string;
  points: number;
  sortOrder: number;
}

// PINs avoid the denylist and the year window in shared/pinPolicy.ts, and are
// distinct from one another — the same rules the API enforces.
const MEMBERS: SeedMember[] = [
  { id: 'lee', displayName: 'Dad', role: 'parent', avatarEmoji: '🧔', avatarColor: '#7FA8D9', pin: '4816', points: 0, sortOrder: 0 },
  { id: 'dana', displayName: 'Mom', role: 'parent', avatarEmoji: '👩', avatarColor: '#57C98A', pin: '5273', points: 0, sortOrder: 1 },
  { id: 'maya', displayName: 'Maya', role: 'child', avatarEmoji: '🦊', avatarColor: '#F0A830', pin: '7391', points: 340, sortOrder: 2 },
  { id: 'theo', displayName: 'Theo', role: 'child', avatarEmoji: '🐢', avatarColor: '#57C98A', pin: '6142', points: 295, sortOrder: 3 },
  { id: 'iris', displayName: 'Iris', role: 'child', avatarEmoji: '🐙', avatarColor: '#E8705F', pin: '8305', points: 180, sortOrder: 4 },
];

/**
 * A stable instant for a history entry.
 *
 * Anchored to midday UTC of the target date rather than "now minus N days",
 * because the timestamp is part of the row key. With `Date.now()` in it, every
 * re-seed writes a NEW row instead of replacing the old one — so running the
 * seed twice silently doubled the ledger and left the reconciler reporting
 * drift that was entirely an artifact of the seeding.
 *
 * Midday, not midnight, so a household west of Greenwich still lands on the
 * intended local date.
 */
function historyWhen(daysAgo: number): number {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  d.setUTCHours(12, 0, 0, 0);
  return d.getTime();
}

/** Deterministic sample history, so repeated seeds produce a stable board. */
const HISTORY: { daysAgo: number; actor: string; headline: string; points: number | null; icon: string }[] = [
  { daysAgo: 0, actor: 'iris', headline: 'Iris cleared "Feed the dog"', points: 10, icon: '🐕' },
  { daysAgo: 0, actor: 'theo', headline: 'Theo cleared "Take the trash out"', points: 15, icon: '🗑️' },
  { daysAgo: 1, actor: 'maya', headline: 'Maya cleared "Unload the dishwasher"', points: 15, icon: '🍽️' },
  { daysAgo: 1, actor: 'maya', headline: 'Maya redeemed "Pick Friday dinner"', points: -120, icon: '🎁' },
  { daysAgo: 2, actor: 'iris', headline: 'Iris hit an 11-day streak', points: null, icon: '🔥' },
  { daysAgo: 3, actor: 'theo', headline: 'Theo cleared "Math homework"', points: 25, icon: '📐' },
  { daysAgo: 5, actor: 'maya', headline: 'Maya cleared "Practice piano"', points: 20, icon: '🎹' },
  { daysAgo: 8, actor: 'iris', headline: 'Iris cleared "Put away the LEGO"', points: 10, icon: '🧱' },
  { daysAgo: 13, actor: 'theo', headline: 'Theo earned "Trash Tactician"', points: null, icon: '🥈' },
  { daysAgo: 21, actor: 'maya', headline: 'Maya earned "Early Riser"', points: null, icon: '🥉' },
  { daysAgo: 29, actor: 'iris', headline: 'Iris earned "Streak Sovereign"', points: null, icon: '🥇' },
];

/**
 * Chores across every recurrence shape, because the shapes are what the
 * materializer can get subtly wrong — a weekly-by-weekday crossing a month
 * boundary, a monthly on a day some months do not have, a rotation, an
 * unassigned "anyone" chore claimed on first tap.
 *
 * Points are deliberately uneven. If everything is worth 10, nothing is.
 */
interface SeedTask {
  id: string;
  title: string;
  icon: string;
  points: number;
  assignMode: 'fixed' | 'anyone' | 'rotate';
  assignee: string | null;
  rotation?: string[];
  recurrence: Record<string, unknown>;
  dueTimeLocal: string | null;
  category: string | null;
}

const TASKS: SeedTask[] = [
  { id: 'dishwasher', title: 'Unload the dishwasher', icon: '🍽️', points: 15, assignMode: 'rotate', assignee: null, rotation: ['maya', 'theo', 'iris'], recurrence: { freq: 'daily', interval: 1 }, dueTimeLocal: '18:00', category: 'kitchen' },
  { id: 'dog', title: 'Feed the dog', icon: '🐕', points: 10, assignMode: 'fixed', assignee: 'iris', recurrence: { freq: 'daily', interval: 1 }, dueTimeLocal: '07:30', category: 'pets' },
  { id: 'beds', title: 'Make your bed', icon: '🛏️', points: 5, assignMode: 'anyone', assignee: null, recurrence: { freq: 'daily', interval: 1 }, dueTimeLocal: '09:00', category: 'bedroom' },
  { id: 'piano', title: 'Practice piano', icon: '🎹', points: 20, assignMode: 'fixed', assignee: 'maya', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 3, 5] }, dueTimeLocal: '19:00', category: 'school' },
  { id: 'trash', title: 'Take the trash out', icon: '🗑️', points: 15, assignMode: 'fixed', assignee: 'theo', recurrence: { freq: 'weekly', interval: 1, byWeekday: [2] }, dueTimeLocal: '20:00', category: 'chores' },
  { id: 'recycling', title: 'Sort the recycling', icon: '♻️', points: 15, assignMode: 'rotate', assignee: null, rotation: ['theo', 'maya'], recurrence: { freq: 'weekly', interval: 1, byWeekday: [6] }, dueTimeLocal: null, category: 'chores' },
  { id: 'vacuum', title: 'Vacuum the front room', icon: '🧹', points: 25, assignMode: 'anyone', assignee: null, recurrence: { freq: 'weekly', interval: 1, byWeekday: [7] }, dueTimeLocal: '16:00', category: 'chores' },
  { id: 'laundry', title: 'Put your laundry away', icon: '🧺', points: 20, assignMode: 'anyone', assignee: null, recurrence: { freq: 'weekly', interval: 2, byWeekday: [4] }, dueTimeLocal: null, category: 'bedroom' },
  { id: 'homework', title: 'Homework check-in', icon: '📐', points: 25, assignMode: 'fixed', assignee: 'theo', recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4] }, dueTimeLocal: '17:30', category: 'school' },
  // The 31st simply does not occur in a short month — deliberate, and pinned by
  // a test in shared/recurrence.test.ts.
  { id: 'sheets', title: 'Strip your sheets', icon: '🛌', points: 30, assignMode: 'anyone', assignee: null, recurrence: { freq: 'monthly', interval: 1, byMonthDay: 31 }, dueTimeLocal: null, category: 'bedroom' },
  { id: 'bathroom', title: 'Wipe down the bathroom', icon: '🪣', points: 35, assignMode: 'rotate', assignee: null, rotation: ['maya', 'theo', 'iris'], recurrence: { freq: 'monthly', interval: 1, byMonthDay: 1 }, dueTimeLocal: null, category: 'chores' },
  { id: 'lego', title: 'Put away the LEGO', icon: '🧱', points: 10, assignMode: 'fixed', assignee: 'iris', recurrence: { freq: 'daily', interval: 1 }, dueTimeLocal: '19:30', category: 'bedroom' },
];

/**
 * The catalog. The exchange rate matters far more than the list: against
 * ~40–60 points a day per child, a 400-point reward is a week of effort and a
 * 60-point one is an afternoon. Both should exist.
 */
const REWARDS: { id: string; title: string; description: string; cost: number; icon: string }[] = [
  { id: 'screen-30', title: '30 minutes of screen time', description: 'On top of the usual', cost: 60, icon: '📺' },
  { id: 'dinner-pick', title: 'Pick Friday dinner', description: 'Anything, within reason', cost: 120, icon: '🍕' },
  { id: 'skip-chore', title: 'Skip a chore', description: 'One chore, once, no questions', cost: 150, icon: '🎫' },
  { id: 'movie-night', title: 'Choose movie night', description: 'You pick, everyone watches', cost: 200, icon: '🎬' },
  { id: 'late-night', title: 'Stay up an extra hour', description: 'Weekends only', cost: 250, icon: '🌙' },
  { id: 'cash-5', title: '$5', description: 'Actual money', cost: 400, icon: '💵' },
];

/** Live streaks, so the Points screen has flames on it the moment you open it. */
const STREAKS: { memberId: string; current: number; longest: number; lastDaysAgo: number }[] = [
  { memberId: 'iris', current: 11, longest: 14, lastDaysAgo: 0 },
  { memberId: 'maya', current: 4, longest: 9, lastDaysAgo: 1 },
  // Theo's lapsed on purpose: the board must be able to show a dead streak
  // without advertising its old multiplier.
  { memberId: 'theo', current: 6, longest: 12, lastDaysAgo: 5 },
];

async function main(): Promise<void> {
  console.log(`Seeding household "${env.householdId}" (${env.timezone})…`);
  await ensureTables();

  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.household),
    name: 'Family HQ',
    timezone: env.timezone,
    tickerEnabled: true,
    commentaryEnabled: true,
    createdAt: new Date().toISOString(),
  });

  for (const m of MEMBERS) {
    const hashed = await hashPin(m.pin);
    await upsert(TABLES.members, {
      partitionKey: memberPK(env.householdId),
      rowKey: memberRK(m.id),
      displayName: m.displayName,
      role: m.role,
      avatarEmoji: m.avatarEmoji,
      avatarColor: m.avatarColor,
      ...hashed,
      active: true,
      sortOrder: m.sortOrder,
      pointsBalance: m.points,
      lifetimePoints: m.points,
      pendingPoints: 0,
      createdAt: new Date().toISOString(),
    });
    console.log(`  member ${m.displayName.padEnd(5)} PIN ${m.pin}`);
  }

  const byId = new Map(MEMBERS.map((m) => [m.id, m]));
  for (const [index, h] of HISTORY.entries()) {
    const when = historyWhen(h.daysAgo);
    const actor = byId.get(h.actor)!;
    const feedId = `seed-feed-${index}`;
    await upsert(TABLES.feed, {
      partitionKey: feedPK(env.householdId, localDateOf(when, env.timezone)),
      rowKey: feedRK(when, feedId),
      kind: h.points === null ? 'achievement' : 'task_approved',
      actorMemberId: actor.id,
      actorName: actor.displayName,
      actorAvatar: actor.avatarEmoji,
      headline: h.headline,
      detail: null,
      icon: h.icon,
      points: h.points,
      refType: null,
      refId: null,
      commentary: null,
      commentarySource: null,
      commentaryModel: null,
      suppressed: false,
      createdAt: new Date(when).toISOString(),
    });
  }
  console.log(`  ${HISTORY.length} backdated feed items across 30 days`);

  // The ledger is authoritative; the feed is a narration of it. Seeding one
  // without the other gives a ticker full of events and an empty points screen.
  let ledgerRows = 0;
  for (const [index, h] of HISTORY.entries()) {
    if (h.points === null) continue;
    const when = historyWhen(h.daysAgo);
    const localDate = localDateOf(when, env.timezone);
    await upsert(TABLES.ledger, {
      partitionKey: ledgerPK(env.householdId, h.actor, yearMonthOfLocalDate(localDate)),
      rowKey: ledgerRK(when, `seed-ledger-${index}`),
      delta: h.points,
      kind: h.points > 0 ? 'task_award' : 'redemption',
      refType: null,
      refId: null,
      description: h.headline.replace(/^\w+ (cleared|redeemed) "?|"$/g, '').replace(/"/g, ''),
      balanceAfter: byId.get(h.actor)!.points,
      actorMemberId: h.actor,
      createdAt: new Date(when).toISOString(),
    });
    ledgerRows++;
  }

  /**
   * Make the ledger actually add up to the balances above.
   *
   * `Member.pointsBalance` is a cache; the ledger is authoritative. Seeding a
   * balance of 340 alongside a handful of unrelated history entries breaks that
   * invariant on row one — and the Phase 9 reconciler, correctly, "fixes" it by
   * wiping the standings on the first cron tick.
   *
   * So the difference becomes an explicit opening-balance entry, dated before
   * the history window. The standings survive, the ledger explains them, and
   * the reconciler has nothing to report — which is what makes it worth
   * believing when it does report something.
   */
  for (const m of MEMBERS) {
    const earned = HISTORY.filter((h) => h.actor === m.id && h.points !== null).reduce(
      (sum, h) => sum + (h.points ?? 0),
      0,
    );
    const opening = m.points - earned;
    if (opening === 0) continue;

    const when = historyWhen(45);
    const localDate = localDateOf(when, env.timezone);
    await upsert(TABLES.ledger, {
      partitionKey: ledgerPK(env.householdId, m.id, yearMonthOfLocalDate(localDate)),
      rowKey: ledgerRK(when, `seed-opening-${m.id}`),
      delta: opening,
      kind: 'adjustment',
      refType: null,
      refId: null,
      description: 'Opening balance',
      balanceAfter: opening,
      actorMemberId: m.id,
      createdAt: new Date(when).toISOString(),
    });
    ledgerRows++;
  }

  console.log(`  ${ledgerRows} backdated ledger entries (ledger sums to each seeded balance)`);

  const today = localDateNow(env.timezone);
  for (const s of STREAKS) {
    await upsert(TABLES.streaks, {
      partitionKey: streakPK(env.householdId, s.memberId),
      rowKey: streakRK(STREAK_DAILY_ALL),
      current: s.current,
      longest: s.longest,
      lastQualifiedDate: addLocalDays(today, -s.lastDaysAgo),
      freezesRemaining: 2,
      updatedAt: new Date().toISOString(),
    });
  }
  console.log(`  ${STREAKS.length} streaks (one deliberately lapsed)`);

  for (const t of TASKS) {
    await upsert(TABLES.taskDefs, {
      partitionKey: taskDefPK(env.householdId),
      rowKey: taskDefRK(t.id),
      title: t.title,
      description: null,
      points: t.points,
      assignMode: t.assignMode,
      assigneeMemberId: t.assignee,
      rotationOrderJson: JSON.stringify(t.rotation ?? []),
      rotationIndex: 0,
      recurrenceJson: JSON.stringify({ ...t.recurrence, dtStart: addLocalDays(today, -30) }),
      dueTimeLocal: t.dueTimeLocal,
      requiresApproval: true,
      category: t.category,
      icon: t.icon,
      active: true,
      materializedThrough: null,
      createdBy: 'lee',
      createdAt: new Date().toISOString(),
    });
  }
  console.log(`  ${TASKS.length} task definitions across every recurrence shape`);

  for (const r of REWARDS) {
    await upsert(TABLES.rewards, {
      partitionKey: rewardPK(env.householdId),
      rowKey: rewardRK(r.id),
      title: r.title,
      description: r.description,
      cost: r.cost,
      icon: r.icon,
      stock: -1,
      requiresApproval: true,
      restrictedToMemberIdsJson: '[]',
      active: true,
      createdBy: 'lee',
      createdAt: new Date().toISOString(),
    });
  }
  console.log(`  ${REWARDS.length} rewards in the catalog`);

  // Clear the watermark so the next GET /api/tasks materializes the new defs
  // rather than short-circuiting on a stale "already current" marker.
  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.materialization),
    throughDate: null,
    updatedAt: new Date().toISOString(),
  });

  console.log('\nDone. Sign in at http://localhost:4280 with any PIN above.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

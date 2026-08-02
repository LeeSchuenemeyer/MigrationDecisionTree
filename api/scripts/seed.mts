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

import { randomUUID } from 'node:crypto';
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

const { CONFIG_ROWS, TABLES, configPK, configRK, feedPK, feedRK, memberPK, memberRK } = await import(
  '../../shared/keys.js'
);
const { localDateOf } = await import('../../shared/time.js');
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
  for (const h of HISTORY) {
    const when = Date.now() - h.daysAgo * 24 * 60 * 60 * 1000;
    const actor = byId.get(h.actor)!;
    const feedId = randomUUID();
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

  console.log('\nDone. Sign in at http://localhost:4280 with any PIN above.');
  console.log('Task definitions and the rewards catalog are seeded from Phase 2/3.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

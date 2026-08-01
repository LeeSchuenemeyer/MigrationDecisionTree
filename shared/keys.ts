/**
 * Every PartitionKey / RowKey format in the system.
 *
 * This is the highest-leverage file in the repo: Azure Table Storage has no
 * schema, so a malformed key produces a *silent* data bug rather than an error.
 * Every `buildX` has a matching `parseX`, and `parse(build(x)) === x` is
 * property-tested in keys.test.ts.
 *
 * Conventions
 * -----------
 * - Separator is `|`. Segment values are escaped so a `|` inside a value can
 *   never be mistaken for a separator.
 * - All partition keys carry a household prefix, which is what makes preview
 *   environments (HOUSEHOLD_ID=preview) safe against production data.
 * - Dates embedded in *partition keys* are LOCAL dates (household timezone),
 *   formatted YYYY-MM-DD or YYYY-MM. Use shared/time.ts — never
 *   `new Date().toISOString().slice(0, 10)`, which is UTC and silently creates
 *   wrong-day partitions west of Greenwich.
 * - Timestamps embedded in *row keys* are UTC epoch milliseconds, zero-padded
 *   so they sort lexically.
 */

export const SEP = '|';

/**
 * Characters Azure Table Storage rejects in a key, plus our separator and the
 * escape character itself. Escaping `~` is what makes the encoding reversible.
 */
const RESERVED = /[|/\\#?~\u0000-\u001F\u007F-\u009F]/g;

/** Escape a value so it is safe to embed as one segment of a key. */
export function encodeSegment(value: string): string {
  return value.replace(RESERVED, (c) => `~${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** Inverse of {@link encodeSegment}. */
export function decodeSegment(value: string): string {
  return value.replace(/~([0-9a-f]{2})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

function join(...parts: string[]): string {
  return parts.join(SEP);
}

/**
 * Split a key into exactly `expected` segments, decoding each.
 * Throws rather than returning a partial parse — a malformed key is a bug, and
 * failing loudly here is the whole point of this module.
 */
function split(key: string, expected: number, what: string): string[] {
  const raw = key.split(SEP);
  if (raw.length !== expected) {
    throw new Error(
      `Malformed ${what} key: expected ${expected} segments, got ${raw.length} (${key})`,
    );
  }
  return raw.map(decodeSegment);
}

// ---------------------------------------------------------------------------
// Tick helpers (row-key ordering)
// ---------------------------------------------------------------------------

/** Width every tick value is padded to, so keys sort lexically. */
export const TICKS_WIDTH = 19;

/**
 * Upper bound for inverse ticks: epoch ms at roughly the year 2286. Comfortably
 * inside Number.MAX_SAFE_INTEGER, so inversion needs no BigInt.
 */
export const MAX_TICKS = 9_999_999_999_999;

/** Ascending (oldest-first) ordering. */
export function ticks(epochMs: number): string {
  assertTickRange(epochMs);
  return String(epochMs).padStart(TICKS_WIDTH, '0');
}

/** Descending (newest-first) ordering, with no client-side sort required. */
export function inverseTicks(epochMs: number): string {
  assertTickRange(epochMs);
  return String(MAX_TICKS - epochMs).padStart(TICKS_WIDTH, '0');
}

export function parseTicks(padded: string): number {
  return Number(padded);
}

export function parseInverseTicks(padded: string): number {
  return MAX_TICKS - Number(padded);
}

function assertTickRange(epochMs: number): void {
  if (!Number.isInteger(epochMs) || epochMs < 0 || epochMs > MAX_TICKS) {
    throw new Error(`Timestamp out of range for a key: ${epochMs}`);
  }
}

// ---------------------------------------------------------------------------
// Table names
// ---------------------------------------------------------------------------

export const TABLES = {
  members: 'Members',
  taskDefs: 'TaskDefs',
  taskInstances: 'TaskInstances',
  actionQueue: 'ActionQueue',
  ledger: 'Ledger',
  streaks: 'Streaks',
  achievementDefs: 'AchievementDefs',
  achievementAwards: 'AchievementAwards',
  rewards: 'Rewards',
  redemptions: 'Redemptions',
  events: 'Events',
  eventMap: 'EventMap',
  syncState: 'SyncState',
  feed: 'Feed',
  sessions: 'Sessions',
  devices: 'Devices',
  pinAttempts: 'PinAttempts',
  config: 'Config',
  claudeCache: 'ClaudeCache',
  budget: 'Budget',
} as const;

export type TableName = (typeof TABLES)[keyof typeof TABLES];

/** Every table, for provisioning. */
export const ALL_TABLES: TableName[] = Object.values(TABLES);

// ---------------------------------------------------------------------------
// Members — PK member|{hh}  RK {memberId}
// ---------------------------------------------------------------------------

export const memberPK = (hh: string) => join('member', encodeSegment(hh));
export const memberRK = (memberId: string) => encodeSegment(memberId);
export const parseMemberPK = (pk: string) => ({ householdId: split(pk, 2, 'member')[1]! });
export const parseMemberRK = (rk: string) => ({ memberId: decodeSegment(rk) });

// ---------------------------------------------------------------------------
// TaskDefs — PK taskdef|{hh}  RK {taskDefId}
// ---------------------------------------------------------------------------

export const taskDefPK = (hh: string) => join('taskdef', encodeSegment(hh));
export const taskDefRK = (taskDefId: string) => encodeSegment(taskDefId);
export const parseTaskDefRK = (rk: string) => ({ taskDefId: decodeSegment(rk) });

// ---------------------------------------------------------------------------
// TaskInstances — PK ti|{hh}|{localDate}  RK {taskDefId}|{memberId}|{seq}
//
// The RK is DETERMINISTIC, which is what makes materialization idempotent:
// createEntity either succeeds or throws 409 EntityAlreadyExists.
// ---------------------------------------------------------------------------

export const ANY_MEMBER = '*';

export const taskInstancePK = (hh: string, localDate: string) =>
  join('ti', encodeSegment(hh), localDate);

export const taskInstanceRK = (taskDefId: string, memberId: string, seq = 0) =>
  join(encodeSegment(taskDefId), encodeSegment(memberId), String(seq));

export function parseTaskInstancePK(pk: string) {
  const [, householdId, localDate] = split(pk, 3, 'taskInstance partition');
  return { householdId: householdId!, localDate: localDate! };
}

export function parseTaskInstanceRK(rk: string) {
  const [taskDefId, memberId, seq] = split(rk, 3, 'taskInstance row');
  return { taskDefId: taskDefId!, memberId: memberId!, seq: Number(seq) };
}

/** Inclusive partition-key range for a date span — a PK range query, not a scan. */
export function taskInstancePKRange(hh: string, fromLocalDate: string, toLocalDate: string) {
  return { from: taskInstancePK(hh, fromLocalDate), to: taskInstancePK(hh, toLocalDate) };
}

// ---------------------------------------------------------------------------
// ActionQueue — PK queue|{hh}|pending  RK {ticks}|{kind}|{refId}
//
// One tiny hot partition holding BOTH task approvals and reward redemptions, so
// a parent gets one badge, one screen, one habit. Rows are deleted on resolve.
// ---------------------------------------------------------------------------

export type QueueKind = 'task_approval' | 'redemption';

export const actionQueuePK = (hh: string) => join('queue', encodeSegment(hh), 'pending');

export const actionQueueRK = (createdAtMs: number, kind: QueueKind, refId: string) =>
  join(ticks(createdAtMs), kind, encodeSegment(refId));

export function parseActionQueueRK(rk: string) {
  const [t, kind, refId] = split(rk, 3, 'actionQueue row');
  return { createdAtMs: parseTicks(t!), kind: kind as QueueKind, refId: refId! };
}

/** Resolved items are appended here for audit, then the pending row is deleted. */
export const actionQueueResolvedPK = (hh: string, yearMonth: string) =>
  join('queue', encodeSegment(hh), 'resolved', yearMonth);

// ---------------------------------------------------------------------------
// Ledger — PK ledger|{hh}|{memberId}|{YYYY-MM}  RK {inverseTicks}|{entryId}
//
// Append-only and authoritative. Member.pointsBalance is only a cache.
// ---------------------------------------------------------------------------

export const ledgerPK = (hh: string, memberId: string, yearMonth: string) =>
  join('ledger', encodeSegment(hh), encodeSegment(memberId), yearMonth);

export const ledgerRK = (createdAtMs: number, entryId: string) =>
  join(inverseTicks(createdAtMs), encodeSegment(entryId));

export function parseLedgerPK(pk: string) {
  const [, householdId, memberId, yearMonth] = split(pk, 4, 'ledger partition');
  return { householdId: householdId!, memberId: memberId!, yearMonth: yearMonth! };
}

export function parseLedgerRK(rk: string) {
  const [t, entryId] = split(rk, 2, 'ledger row');
  return { createdAtMs: parseInverseTicks(t!), entryId: entryId! };
}

// ---------------------------------------------------------------------------
// Streaks — PK streak|{hh}|{memberId}  RK {streakKey}
// ---------------------------------------------------------------------------

export const streakPK = (hh: string, memberId: string) =>
  join('streak', encodeSegment(hh), encodeSegment(memberId));

export const streakRK = (streakKey: string) => encodeSegment(streakKey);

/** Well-known streak keys. `def:{taskDefId}` is also valid. */
export const STREAK_DAILY_ALL = 'daily_all';
export const STREAK_CHALLENGE = 'challenge';
export const streakKeyForDef = (taskDefId: string) => `def:${taskDefId}`;

// ---------------------------------------------------------------------------
// Achievements
//   defs   — PK achdef|{hh}          RK {achievementDefId}
//   awards — PK ach|{hh}|{memberId}  RK {achievementDefId}[|{seq}]
//
// The award RK is the def id specifically so "has this member already earned
// it?" is a point read — that is what makes evaluation cheap enough to run on
// every single task approval.
// ---------------------------------------------------------------------------

export const achievementDefPK = (hh: string) => join('achdef', encodeSegment(hh));
export const achievementDefRK = (defId: string) => encodeSegment(defId);

export const achievementAwardPK = (hh: string, memberId: string) =>
  join('ach', encodeSegment(hh), encodeSegment(memberId));

export const achievementAwardRK = (defId: string, seq?: number) =>
  seq === undefined ? encodeSegment(defId) : join(encodeSegment(defId), String(seq));

export function parseAchievementAwardRK(rk: string) {
  const raw = rk.split(SEP);
  if (raw.length === 1) return { defId: decodeSegment(raw[0]!), seq: undefined };
  if (raw.length === 2) return { defId: decodeSegment(raw[0]!), seq: Number(raw[1]) };
  throw new Error(`Malformed achievementAward row key: ${rk}`);
}

// ---------------------------------------------------------------------------
// Rewards & Redemptions
// ---------------------------------------------------------------------------

export const rewardPK = (hh: string) => join('reward', encodeSegment(hh));
export const rewardRK = (rewardId: string) => encodeSegment(rewardId);

export const redemptionPK = (hh: string, memberId: string) =>
  join('redemption', encodeSegment(hh), encodeSegment(memberId));

export const redemptionRK = (requestedAtMs: number, redemptionId: string) =>
  join(inverseTicks(requestedAtMs), encodeSegment(redemptionId));

export function parseRedemptionRK(rk: string) {
  const [t, redemptionId] = split(rk, 2, 'redemption row');
  return { requestedAtMs: parseInverseTicks(t!), redemptionId: redemptionId! };
}

// ---------------------------------------------------------------------------
// Calendar
//   Events   — PK event|{hh}|{YYYY-MM}  RK {startTicks}|{eventId}
//   EventMap — PK evmap|{hh}            RK {googleEventId}
//
// EventMap is non-negotiable: an incremental sync hands you a Google event id
// and nothing else. Without this index, resolving it is a full scan of every
// month partition on every sync.
// ---------------------------------------------------------------------------

export const eventPK = (hh: string, yearMonth: string) =>
  join('event', encodeSegment(hh), yearMonth);

export const eventRK = (startUtcMs: number, eventId: string) =>
  join(ticks(startUtcMs), encodeSegment(eventId));

export function parseEventPK(pk: string) {
  const [, householdId, yearMonth] = split(pk, 3, 'event partition');
  return { householdId: householdId!, yearMonth: yearMonth! };
}

export function parseEventRK(rk: string) {
  const [t, eventId] = split(rk, 2, 'event row');
  return { startUtcMs: parseTicks(t!), eventId: eventId! };
}

export const eventMapPK = (hh: string) => join('evmap', encodeSegment(hh));
export const eventMapRK = (googleEventId: string) => encodeSegment(googleEventId);

export const syncStatePK = (hh: string) => join('sync', encodeSegment(hh));
export const syncStateRK = (calendarId: string) => `google:${encodeSegment(calendarId)}`;

// ---------------------------------------------------------------------------
// Feed — PK feed|{hh}|{localDate}  RK {inverseTicks}|{feedId}
// ---------------------------------------------------------------------------

export const feedPK = (hh: string, localDate: string) =>
  join('feed', encodeSegment(hh), localDate);

export const feedRK = (createdAtMs: number, feedId: string) =>
  join(inverseTicks(createdAtMs), encodeSegment(feedId));

export function parseFeedPK(pk: string) {
  const [, householdId, localDate] = split(pk, 3, 'feed partition');
  return { householdId: householdId!, localDate: localDate! };
}

export function parseFeedRK(rk: string) {
  const [t, feedId] = split(rk, 2, 'feed row');
  return { createdAtMs: parseInverseTicks(t!), feedId: feedId! };
}

// ---------------------------------------------------------------------------
// Auth — the token itself is NEVER stored, only its SHA-256 hash, so a storage
// dump does not yield usable sessions.
// ---------------------------------------------------------------------------

export const sessionPK = (hh: string) => join('sess', encodeSegment(hh));
export const sessionRK = (tokenSha256Hex: string) => tokenSha256Hex;

export const devicePK = (hh: string) => join('device', encodeSegment(hh));
export const deviceRK = (tokenSha256Hex: string) => tokenSha256Hex;

export const pinAttemptPK = (hh: string) => join('pinfail', encodeSegment(hh));
export const pinAttemptRK = (memberId: string) => encodeSegment(memberId);

// ---------------------------------------------------------------------------
// Config / cache / budget
// ---------------------------------------------------------------------------

export const CONFIG_ROWS = {
  household: 'household',
  googleOAuth: 'google_oauth',
  rev: 'rev',
  materialization: 'materialization',
  oauthState: 'oauth_state',
} as const;

export type ConfigRow = (typeof CONFIG_ROWS)[keyof typeof CONFIG_ROWS];

export const configPK = (hh: string) => join('config', encodeSegment(hh));
export const configRK = (row: ConfigRow | string) => encodeSegment(row);

export type ClaudeCacheKind = 'commentary' | 'achievement' | 'challenge';

export const claudeCachePK = (hh: string, kind: ClaudeCacheKind) =>
  join('claudecache', encodeSegment(hh), kind);
export const claudeCacheRK = (inputSha256Hex: string) => inputSha256Hex;

export const budgetPK = (hh: string) => join('budget', encodeSegment(hh));
export const budgetRK = (localDate: string) => localDate;

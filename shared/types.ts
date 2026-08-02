/**
 * Entity and DTO shapes shared by the Functions and the web client.
 *
 * Table Storage is stringly-typed and schemaless, so these types plus the Zod
 * contracts in schemas.ts are the only thing preventing entity-shape drift
 * between the two sides. Storage entities carry PartitionKey/RowKey; DTOs are
 * what crosses the wire and deliberately never expose key structure.
 */

import type { AssignMode, Recurrence } from './recurrence.js';

export type Role = 'parent' | 'child';
export type DeviceKind = 'kiosk' | 'personal';

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** Stored shape. `pinHash`/`pinSalt` never leave the server. */
export interface MemberEntity {
  displayName: string;
  role: Role;
  avatarEmoji: string;
  avatarColor: string;
  pinHash: string;
  pinSalt: string;
  /** Versioned so the hashing parameters can change without a migration. */
  pinAlgo: string;
  active: boolean;
  sortOrder: number;
  /**
   * Denormalized cache of the points ledger, which is authoritative. The two
   * live in different tables and therefore cannot be updated atomically — see
   * the write ordering in the approval service.
   */
  pointsBalance: number;
  lifetimePoints: number;
  /** Earned but not yet parent-approved. Never folded into the ranked total. */
  pendingPoints: number;
  createdAt: string;
}

/** Wire shape. Notably free of anything secret. */
export interface Member {
  id: string;
  displayName: string;
  role: Role;
  avatarEmoji: string;
  avatarColor: string;
  sortOrder: number;
  pointsBalance: number;
  lifetimePoints: number;
  pendingPoints: number;
}

// ---------------------------------------------------------------------------
// Sessions & devices
// ---------------------------------------------------------------------------

/**
 * The row key is sha256(token) — the token itself is never stored, so a
 * storage dump does not yield usable sessions.
 */
export interface SessionEntity {
  memberId: string;
  role: Role;
  displayName: string;
  deviceKind: DeviceKind;
  deviceId: string;
  /** Set by a successful step-up; gates the genuinely destructive operations. */
  elevatedUntil: string | null;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
}

export interface DeviceEntity {
  label: string;
  deviceKind: DeviceKind;
  /** Device tokens grant household READ scope only. Writes need a member session. */
  scope: 'read_only';
  enrolledBy: string;
  enrolledAt: string;
  lastSeenAt: string;
  revoked: boolean;
}

export interface PinAttemptEntity {
  count: number;
  firstFailAt: string;
  lockedUntil: string | null;
}

// ---------------------------------------------------------------------------
// Session DTOs
// ---------------------------------------------------------------------------

/** What `GET /api/auth/me` returns. */
export interface SessionInfo {
  member: Member | null;
  /** Seconds until the member session expires; null when signed out. */
  expiresInSeconds: number | null;
  elevated: boolean;
  /** Present once this browser is an enrolled kiosk. Drives surface selection. */
  deviceKind: DeviceKind | null;
  deviceLabel: string | null;
}

export interface LoginResult {
  member: Member;
  expiresInSeconds: number;
}

// ---------------------------------------------------------------------------
// Feed — written from Phase 1 onward (the PIN lockout notice is the first
// producer), consumed by the ticker in Phase 4.
// ---------------------------------------------------------------------------

export type FeedKind =
  | 'task_completed'
  | 'task_approved'
  | 'achievement'
  | 'streak'
  | 'redemption'
  | 'wildcard'
  | 'adjustment'
  | 'event_upcoming'
  | 'challenge'
  | 'security'
  | 'quip';

export interface FeedEntity {
  kind: FeedKind;
  actorMemberId: string | null;
  /** Denormalized so the ticker renders from one query with zero fan-out. */
  actorName: string | null;
  actorAvatar: string | null;
  headline: string;
  detail: string | null;
  icon: string | null;
  points: number | null;
  refType: string | null;
  refId: string | null;
  /** Claude-written commentary, null until Phase 5 (and whenever it degrades). */
  commentary: string | null;
  commentarySource: 'claude' | 'fallback' | null;
  commentaryModel: string | null;
  /** Set by the parent-facing "that wasn't ok" control. */
  suppressed: boolean;
  createdAt: string;
}

export interface FeedItem {
  id: string;
  kind: FeedKind;
  actorName: string | null;
  actorAvatar: string | null;
  headline: string;
  detail: string | null;
  icon: string | null;
  points: number | null;
  commentary: string | null;
  commentarySource: 'claude' | 'fallback' | null;
  /** What this item is about, so the ticker can collapse one thing's lifecycle. */
  refType: string | null;
  refId: string | null;
  createdAt: string;
}

/**
 * One line in the marquee.
 *
 * Flattened from feed items, upcoming deadlines, and (Phase 6) calendar events
 * into a single shape, so the ticker component renders a list and never branches
 * on where a line came from.
 */
export interface TickerItem {
  id: string;
  source: 'activity' | 'upcoming' | 'overdue' | 'event';
  /** What is actually displayed. Claude's line when present, the fact otherwise. */
  text: string;
  detail: string | null;
  icon: string | null;
  points: number | null;
  /** Small tag before the text: "Claude", "Next", "Overdue". Null for plain facts. */
  label: string | null;
  at: string;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------


export type TaskStatus = 'open' | 'pending' | 'approved' | 'rejected' | 'expired' | 'skipped';

export interface TaskDefEntity {
  title: string;
  description: string | null;
  points: number;
  assignMode: AssignMode;
  assigneeMemberId: string | null;
  /** JSON array of member ids, for assignMode 'rotate'. */
  rotationOrderJson: string;
  rotationIndex: number;
  /** JSON-encoded Recurrence. */
  recurrenceJson: string;
  /** Wall-clock time the chore is due, HH:mm. Null means end of day. */
  dueTimeLocal: string | null;
  requiresApproval: boolean;
  category: string | null;
  icon: string | null;
  active: boolean;
  /** Last local date materialized for this definition. */
  materializedThrough: string | null;
  createdBy: string;
  createdAt: string;
}

export interface TaskDef {
  id: string;
  title: string;
  description: string | null;
  points: number;
  assignMode: AssignMode;
  assigneeMemberId: string | null;
  rotationOrder: string[];
  recurrence: Recurrence;
  recurrenceLabel: string;
  dueTimeLocal: string | null;
  requiresApproval: boolean;
  category: string | null;
  icon: string | null;
  active: boolean;
}

export interface TaskInstanceEntity {
  taskDefId: string;
  /** Denormalized so the board renders from one query with no fan-out. */
  title: string;
  icon: string | null;
  /** Snapshotted at materialization — editing a def must never retroactively
   *  change what an already-completed chore was worth. */
  basePoints: number;
  /** Surprise double-points and similar. 1 = none. */
  multiplier: number;
  bonusReason: string | null;
  dueDateLocal: string;
  dueTimeLocal: string | null;
  assignedMemberId: string;
  assignedMemberName: string | null;
  status: TaskStatus;
  completedAt: string | null;
  completedBy: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  /**
   * The award computed at completion time, including the streak multiplier in
   * force that day. Approval pays this rather than recomputing, so the number
   * shown as "pending" is exactly the number that lands.
   */
  computedPoints: number | null;
  appliedStreakMultiplier: number | null;
  /** Set once points land, and what makes approval idempotent. */
  ledgerEntryId: string | null;
  awardedPoints: number | null;
  note: string | null;
}

export interface TaskInstance {
  id: string;
  taskDefId: string;
  title: string;
  icon: string | null;
  basePoints: number;
  multiplier: number;
  bonusReason: string | null;
  dueDateLocal: string;
  dueTimeLocal: string | null;
  assignedMemberId: string;
  assignedMemberName: string | null;
  status: TaskStatus;
  /** What it is worth now that it is done — base × wildcard × streak. */
  computedPoints: number | null;
  appliedStreakMultiplier: number | null;
  awardedPoints: number | null;
  /** True when the due time has passed and it is still open. */
  overdue: boolean;
}

// ---------------------------------------------------------------------------
// Approval queue — task approvals AND reward redemptions in one place, so a
// parent gets one badge, one screen, one habit.
// ---------------------------------------------------------------------------

export type QueueItemKind = 'task_approval' | 'redemption';

export interface ActionQueueEntity {
  kind: QueueItemKind;
  refPartitionKey: string;
  refRowKey: string;
  memberId: string;
  memberName: string;
  memberAvatar: string;
  title: string;
  points: number;
  dueDateLocal: string | null;
  note: string | null;
  createdAt: string;
}

export interface QueueItem {
  id: string;
  kind: QueueItemKind;
  memberId: string;
  memberName: string;
  memberAvatar: string;
  title: string;
  points: number;
  dueDateLocal: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Ledger — append-only and authoritative. Member.pointsBalance is a cache.
// ---------------------------------------------------------------------------

export type LedgerKind =
  | 'task_award'
  | 'bonus'
  | 'streak_bonus'
  | 'challenge'
  | 'achievement'
  | 'redemption'
  | 'manual_adjust'
  | 'reversal';

export interface LedgerEntity {
  delta: number;
  kind: LedgerKind;
  refType: string | null;
  refId: string | null;
  description: string;
  /** Best-effort snapshot; the running sum of deltas is the real answer. */
  balanceAfter: number;
  actorMemberId: string | null;
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  delta: number;
  kind: LedgerKind;
  description: string;
  balanceAfter: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

export interface StreakEntity {
  current: number;
  longest: number;
  lastQualifiedDate: string | null;
  freezesRemaining: number;
  updatedAt: string;
}

export interface StreakView {
  key: string;
  current: number;
  longest: number;
  multiplier: number;
  alive: boolean;
  deadline: string | null;
  daysToNextTier: number | null;
  nextTierMultiplier: number | null;
}

// ---------------------------------------------------------------------------
// Rewards & redemptions
// ---------------------------------------------------------------------------

export type RedemptionStatus = 'pending' | 'fulfilled' | 'rejected' | 'cancelled';

export interface RewardEntity {
  title: string;
  description: string | null;
  cost: number;
  icon: string | null;
  /** -1 means unlimited. */
  stock: number;
  requiresApproval: boolean;
  /** JSON array of member ids; empty means everyone. */
  restrictedToMemberIdsJson: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export interface Reward {
  id: string;
  title: string;
  description: string | null;
  cost: number;
  icon: string | null;
  stock: number;
  restrictedToMemberIds: string[];
  active: boolean;
  /** Computed per-viewer, so the catalog can grey out what they cannot buy. */
  affordable?: boolean;
}

export interface RedemptionEntity {
  rewardId: string;
  /** Denormalized — the catalog entry may be deleted later. */
  rewardTitle: string;
  cost: number;
  status: RedemptionStatus;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  ledgerEntryId: string | null;
  note: string | null;
}

export interface Redemption {
  id: string;
  rewardId: string;
  rewardTitle: string;
  cost: number;
  status: RedemptionStatus;
  requestedAt: string;
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export interface LeaderboardRow {
  member: Member;
  rank: number;
  /** Approved points only. Pending is reported separately and never ranked. */
  points: number;
  pendingPoints: number;
  streakDays: number;
  streakMultiplier: number;
  streakAlive: boolean;
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export interface AchievementDefEntity {
  name: string;
  description: string;
  /** JSON-encoded Criteria from shared/achievements.ts. */
  criteriaJson: string;
  tier: string;
  icon: string;
  pointsReward: number;
  active: boolean;
  createdAt: string;
}

export interface AchievementAwardEntity {
  /** Denormalized so the trophy case renders from one query with no fan-out. */
  name: string;
  description: string;
  flavorText: string | null;
  tier: string;
  icon: string;
  pointsAwarded: number;
  /** 'claude' when generated, 'fallback' when hand-written copy was used. */
  copySource: 'claude' | 'fallback';
  copyModel: string | null;
  earnedAt: string;
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  flavorText: string | null;
  tier: string;
  icon: string;
  pointsAwarded: number;
  copySource: 'claude' | 'fallback';
  earnedAt: string;
}

// ---------------------------------------------------------------------------
// Claude integration — parent-facing status and controls
// ---------------------------------------------------------------------------

export interface CommentaryStatus {
  /** False when no API key is set; the ticker runs on hand-written copy. */
  configured: boolean;
  /** The parent toggle. Off means facts only, and nothing breaks. */
  enabled: boolean;
  budget: { job: string; used: number; cap: number }[];
  /** Items a parent flagged with "that wasn't ok", newest first. */
  incidents: CommentaryIncident[];
}

export interface CommentaryIncident {
  id: string;
  headline: string;
  commentary: string | null;
  reason: string;
  reportedBy: string | null;
  reportedAt: string;
}

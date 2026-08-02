/**
 * Entity and DTO shapes shared by the Functions and the web client.
 *
 * Table Storage is stringly-typed and schemaless, so these types plus the Zod
 * contracts in schemas.ts are the only thing preventing entity-shape drift
 * between the two sides. Storage entities carry PartitionKey/RowKey; DTOs are
 * what crosses the wire and deliberately never expose key structure.
 */

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
  createdAt: string;
}

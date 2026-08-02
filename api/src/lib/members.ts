import { TABLES, memberPK, memberRK, parseMemberRK } from '../../../shared/keys.js';
import type { Member, MemberEntity } from '../../../shared/types.js';
import { env } from './env.js';
import { getEntity, listPartition } from './tables.js';

export type MemberRow = MemberEntity & { partitionKey: string; rowKey: string; etag: string };

/**
 * Storage row → wire shape.
 *
 * The important part is what it drops: pinHash, pinSalt, and pinAlgo never
 * cross the wire, so no endpoint can leak them by returning a member.
 */
export function toMember(row: MemberRow): Member {
  return {
    id: parseMemberRK(row.rowKey).memberId,
    displayName: row.displayName,
    role: row.role,
    avatarEmoji: row.avatarEmoji,
    avatarColor: row.avatarColor,
    sortOrder: row.sortOrder,
    pointsBalance: row.pointsBalance,
    lifetimePoints: row.lifetimePoints,
    pendingPoints: row.pendingPoints,
  };
}

/** The whole family in one point-partition query — the kiosk's first call. */
export async function listMembers(includeInactive = false): Promise<MemberRow[]> {
  const rows = await listPartition<MemberEntity>(TABLES.members, memberPK(env.householdId));
  return (rows as MemberRow[])
    .filter((r) => includeInactive || r.active)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.displayName.localeCompare(b.displayName));
}

export async function getMemberRow(memberId: string): Promise<MemberRow | null> {
  const row = await getEntity<MemberEntity>(
    TABLES.members,
    memberPK(env.householdId),
    memberRK(memberId),
  );
  return row as MemberRow | null;
}

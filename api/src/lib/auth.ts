import { createHash, randomBytes } from 'node:crypto';
import type { HttpRequest, HttpResponseInit } from '@azure/functions';
import {
  DEVICE_TOKEN_MS,
  ELEVATION_MS,
  sessionLifetimeMs,
} from '../../../shared/pinPolicy.js';
import type { DeviceEntity, DeviceKind, Member, Role, SessionEntity } from '../../../shared/types.js';
import {
  TABLES,
  devicePK,
  deviceRK,
  memberPK,
  memberRK,
  sessionPK,
  sessionRK,
} from '../../../shared/keys.js';
import { env } from './env.js';
import { getEntity, remove, table, upsert } from './tables.js';
import { toMember, type MemberRow } from './members.js';

/**
 * Sessions, device credentials, and the guards every mutating endpoint runs.
 *
 * Two layered credentials, which is what lets the wall display stay useful
 * while still gating writes:
 *
 *   fd_device  — long-lived, household READ scope only. A parent enrolls the
 *                tablet once and the board then renders forever with nobody
 *                signed in. That is the entire point of a kiosk.
 *   fd_session — short-lived member credential. Required for every write.
 *                10 minutes on the kiosk, 30 days on a personal device.
 *
 * Neither token is stored. Only its SHA-256 is, so dumping the tables does not
 * hand anyone a working session.
 */

export const SESSION_COOKIE = 'fd_session';
export const DEVICE_COOKIE = 'fd_device';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

function cookieAttrs(maxAgeSeconds: number): string {
  // SameSite=Lax is enough: every call is same-origin, and Lax still permits
  // the top-level navigations the OAuth callback needs.
  const base = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
  // Secure would make cookies vanish on http://localhost:4280 during dev.
  return env.isProduction ? `${base}; Secure` : base;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; ${cookieAttrs(maxAgeSeconds)}`;
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(req: HttpRequest, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || null;
  }
  return null;
}

/** Attach one or more Set-Cookie headers to a response. */
export function withCookies(res: HttpResponseInit, cookies: string[]): HttpResponseInit {
  if (cookies.length === 0) return res;
  return {
    ...res,
    cookies: cookies.map((c) => {
      const [pair, ...attrs] = c.split('; ');
      const [name, ...v] = pair!.split('=');
      const attrMap = Object.fromEntries(
        attrs.map((a) => {
          const [k, ...rest] = a.split('=');
          return [k!.toLowerCase(), rest.join('=') || true];
        }),
      );
      return {
        name: name!,
        value: v.join('='),
        path: (attrMap['path'] as string) ?? '/',
        httpOnly: 'httponly' in attrMap,
        sameSite: 'Lax' as const,
        secure: 'secure' in attrMap,
        maxAge: attrMap['max-age'] ? Number(attrMap['max-age']) : undefined,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface ActiveSession {
  token: string;
  memberId: string;
  role: Role;
  displayName: string;
  deviceKind: DeviceKind;
  expiresAtMs: number;
  elevatedUntilMs: number | null;
}

export async function issueSession(
  member: { id: string; role: Role; displayName: string },
  deviceKind: DeviceKind,
  deviceId: string,
): Promise<{ token: string; expiresInSeconds: number; cookie: string }> {
  const token = newToken();
  const now = Date.now();
  const lifetime = sessionLifetimeMs(deviceKind);
  const expiresAt = new Date(now + lifetime);

  const entity: SessionEntity & { partitionKey: string; rowKey: string } = {
    partitionKey: sessionPK(env.householdId),
    rowKey: sessionRK(sha256(token)),
    memberId: member.id,
    role: member.role,
    displayName: member.displayName,
    deviceKind,
    deviceId,
    elevatedUntil: null,
    createdAt: new Date(now).toISOString(),
    expiresAt: expiresAt.toISOString(),
    lastSeenAt: new Date(now).toISOString(),
  };
  await upsert(TABLES.sessions, entity);

  return {
    token,
    expiresInSeconds: Math.floor(lifetime / 1000),
    cookie: setCookie(SESSION_COOKIE, token, Math.floor(lifetime / 1000)),
  };
}

/** Resolve the session cookie, treating an expired row as signed out. */
export async function resolveSession(req: HttpRequest): Promise<ActiveSession | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;

  const row = await getEntity<SessionEntity>(
    TABLES.sessions,
    sessionPK(env.householdId),
    sessionRK(sha256(token)),
  );
  if (!row) return null;

  const expiresAtMs = Date.parse(row.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await remove(TABLES.sessions, row.partitionKey, row.rowKey);
    return null;
  }

  return {
    token,
    memberId: row.memberId,
    role: row.role,
    displayName: row.displayName,
    deviceKind: row.deviceKind,
    expiresAtMs,
    elevatedUntilMs: row.elevatedUntil ? Date.parse(row.elevatedUntil) : null,
  };
}

export async function destroySession(req: HttpRequest): Promise<void> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return;
  await remove(TABLES.sessions, sessionPK(env.householdId), sessionRK(sha256(token)));
}

/** Mark a session elevated after a successful step-up. */
export async function elevateSession(session: ActiveSession): Promise<number> {
  const until = Date.now() + ELEVATION_MS;
  const row = await getEntity<SessionEntity>(
    TABLES.sessions,
    sessionPK(env.householdId),
    sessionRK(sha256(session.token)),
  );
  if (!row) throw new Error('Session vanished during step-up');

  await upsert(TABLES.sessions, {
    partitionKey: row.partitionKey,
    rowKey: row.rowKey,
    elevatedUntil: new Date(until).toISOString(),
  });
  return Math.floor(ELEVATION_MS / 1000);
}

// ---------------------------------------------------------------------------
// Device credentials
// ---------------------------------------------------------------------------

export async function enrollDevice(
  label: string,
  deviceKind: DeviceKind,
  enrolledBy: string,
): Promise<{ cookie: string }> {
  const token = newToken();
  const now = new Date().toISOString();

  const entity: DeviceEntity & { partitionKey: string; rowKey: string } = {
    partitionKey: devicePK(env.householdId),
    rowKey: deviceRK(sha256(token)),
    label,
    deviceKind,
    scope: 'read_only',
    enrolledBy,
    enrolledAt: now,
    lastSeenAt: now,
    revoked: false,
  };
  await upsert(TABLES.devices, entity);

  return { cookie: setCookie(DEVICE_COOKIE, token, Math.floor(DEVICE_TOKEN_MS / 1000)) };
}

export interface ActiveDevice {
  label: string;
  deviceKind: DeviceKind;
  rowKey: string;
}

export async function resolveDevice(req: HttpRequest): Promise<ActiveDevice | null> {
  const token = readCookie(req, DEVICE_COOKIE);
  if (!token) return null;

  const row = await getEntity<DeviceEntity>(
    TABLES.devices,
    devicePK(env.householdId),
    deviceRK(sha256(token)),
  );
  if (!row || row.revoked) return null;

  return { label: row.label, deviceKind: row.deviceKind, rowKey: row.rowKey };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export class AuthError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/** Any mutating endpoint. */
export async function requireMember(req: HttpRequest): Promise<ActiveSession> {
  const session = await resolveSession(req);
  if (!session) throw new AuthError('Tap your face and enter your PIN first.', 401);
  return session;
}

/**
 * Privileged endpoints.
 *
 * Deliberately re-reads the Members row rather than trusting the role cached
 * on the session: it is one cheap point read, and it means a role change takes
 * effect immediately instead of at next login. Hiding the button client-side
 * is cosmetic only — this is the actual control.
 */
export async function requireParent(req: HttpRequest): Promise<{ session: ActiveSession; member: Member }> {
  const session = await requireMember(req);

  const row = await getEntity<MemberRow>(
    TABLES.members,
    memberPK(env.householdId),
    memberRK(session.memberId),
  );
  if (!row || !row.active) throw new AuthError('That account is no longer active.', 403);
  if (row.role !== 'parent') throw new AuthError('Only a parent can do that.', 403);

  return { session, member: toMember(row) };
}

/** The genuinely destructive operations, on top of requireParent. */
export async function requireElevated(
  req: HttpRequest,
): Promise<{ session: ActiveSession; member: Member }> {
  const result = await requireParent(req);
  const until = result.session.elevatedUntilMs;
  if (!until || until <= Date.now()) {
    throw new AuthError('Re-enter your PIN to confirm.', 403);
  }
  return result;
}

/**
 * Read endpoints: either an enrolled device or a signed-in member will do.
 * This is what keeps the wall display alive with nobody logged in.
 */
export async function requireRead(
  req: HttpRequest,
): Promise<{ session: ActiveSession | null; device: ActiveDevice | null }> {
  const [session, device] = await Promise.all([resolveSession(req), resolveDevice(req)]);
  if (!session && !device) {
    throw new AuthError('This device is not set up yet.', 401);
  }
  return { session, device };
}

/** Best-effort touch of lastSeenAt, for the parent-facing device list. */
export async function touchDevice(device: ActiveDevice): Promise<void> {
  try {
    await table(TABLES.devices).updateEntity(
      {
        partitionKey: devicePK(env.householdId),
        rowKey: device.rowKey,
        lastSeenAt: new Date().toISOString(),
      },
      'Merge',
    );
  } catch {
    // Never fail a read because a timestamp could not be written.
  }
}

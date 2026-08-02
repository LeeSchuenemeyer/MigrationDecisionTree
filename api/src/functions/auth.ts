import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from '@azure/functions';
import { z } from 'zod';
import { PIN_LENGTH, checkLockout, registerFailure } from '../../../shared/pinPolicy.js';
import { TABLES, pinAttemptPK, pinAttemptRK } from '../../../shared/keys.js';
import type { PinAttemptEntity, SessionInfo } from '../../../shared/types.js';
import { env } from '../lib/env.js';
import { badRequest, error, json, tooManyRequests, unauthorized } from '../lib/http.js';
import { getEntity, remove, upsert } from '../lib/tables.js';
import { verifyPin } from '../lib/pin.js';
import { getMemberRow, toMember } from '../lib/members.js';
import { writeFeedItem } from '../lib/feed.js';
import {
  AuthError,
  DEVICE_COOKIE,
  SESSION_COOKIE,
  clearCookie,
  destroySession,
  elevateSession,
  issueSession,
  requireMember,
  resolveDevice,
  resolveSession,
  withCookies,
} from '../lib/auth.js';

const LoginBody = z.object({
  memberId: z.string().min(1),
  pin: z.string().regex(new RegExp(`^\\d{${PIN_LENGTH}}$`)),
});

const StepUpBody = z.object({
  pin: z.string().regex(new RegExp(`^\\d{${PIN_LENGTH}}$`)),
});

async function readAttempts(memberId: string) {
  const row = await getEntity<PinAttemptEntity>(
    TABLES.pinAttempts,
    pinAttemptPK(env.householdId),
    pinAttemptRK(memberId),
  );
  if (!row) return null;
  return {
    count: row.count,
    firstFailAtMs: Date.parse(row.firstFailAt),
    lockedUntilMs: row.lockedUntil ? Date.parse(row.lockedUntil) : null,
  };
}

async function writeAttempts(
  memberId: string,
  state: { count: number; firstFailAtMs: number; lockedUntilMs: number | null },
) {
  await upsert(TABLES.pinAttempts, {
    partitionKey: pinAttemptPK(env.householdId),
    rowKey: pinAttemptRK(memberId),
    count: state.count,
    firstFailAt: new Date(state.firstFailAtMs).toISOString(),
    lockedUntil: state.lockedUntilMs ? new Date(state.lockedUntilMs).toISOString() : null,
  });
}

async function clearAttempts(memberId: string) {
  await remove(TABLES.pinAttempts, pinAttemptPK(env.householdId), pinAttemptRK(memberId));
}

/**
 * POST /api/auth/login
 *
 * Failure responses deliberately do not distinguish "wrong PIN" from "locked
 * out" in their wording beyond the retry hint — there is no reason to confirm
 * to a guesser that they were close.
 */
export async function login(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const parsed = LoginBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('Enter a 4-digit PIN.');
  const { memberId, pin } = parsed.data;

  const member = await getMemberRow(memberId);
  if (!member || !member.active) return unauthorized('That PIN did not work.');

  const now = Date.now();
  const lock = checkLockout(await readAttempts(memberId), now);
  if (lock.locked) {
    return tooManyRequests(lock.retryAfterSeconds, 'Too many tries. Wait a bit and try again.');
  }

  const ok = await verifyPin(pin, member);
  if (!ok) {
    const decision = registerFailure(await readAttempts(memberId), now);
    await writeAttempts(memberId, decision.next);

    // The social control. In a household, a visible "someone was trying" line
    // deters far better than any cryptographic measure — and it turns a silent
    // security event into a conversation at the kitchen table.
    if (decision.justLocked) {
      await writeFeedItem({
        kind: 'security',
        headline: `Someone tried ${member.displayName}'s PIN five times and struck out.`,
        icon: '🕵️',
        actor: null,
        eligibleForCommentary: false,
      }).catch((e) => context.error('Failed to write lockout feed item', e));
    }

    if (decision.locked) {
      return tooManyRequests(decision.retryAfterSeconds, 'Too many tries. Wait a bit and try again.');
    }
    return unauthorized('That PIN did not work.');
  }

  await clearAttempts(memberId);

  const device = await resolveDevice(req);
  const deviceKind = device?.deviceKind ?? 'personal';
  const session = await issueSession(
    { id: memberId, role: member.role, displayName: member.displayName },
    deviceKind,
    device?.rowKey ?? 'unenrolled',
  );

  return withCookies(
    json({ member: toMember(member), expiresInSeconds: session.expiresInSeconds }),
    [session.cookie],
  );
}

/** POST /api/auth/logout — explicit "I'm done" on the kiosk. */
export async function logout(req: HttpRequest): Promise<HttpResponseInit> {
  await destroySession(req);
  return withCookies(json({ ok: true }), [clearCookie(SESSION_COOKIE)]);
}

/**
 * GET /api/auth/me
 *
 * Intentionally never 401s. An unenrolled, signed-out browser is a completely
 * valid state — it is what the wall tablet looks like most of the day — and
 * the client needs to render that state, not an error.
 */
export async function me(req: HttpRequest): Promise<HttpResponseInit> {
  const [session, device] = await Promise.all([resolveSession(req), resolveDevice(req)]);

  let info: SessionInfo = {
    member: null,
    expiresInSeconds: null,
    elevated: false,
    deviceKind: device?.deviceKind ?? null,
    deviceLabel: device?.label ?? null,
  };

  if (session) {
    const row = await getMemberRow(session.memberId);
    if (row?.active) {
      info = {
        ...info,
        member: toMember(row),
        expiresInSeconds: Math.max(0, Math.floor((session.expiresAtMs - Date.now()) / 1000)),
        elevated: session.elevatedUntilMs !== null && session.elevatedUntilMs > Date.now(),
      };
    }
  }

  return json(info);
}

/**
 * POST /api/auth/step-up
 *
 * Required for the genuinely destructive operations only — manual point
 * adjustment, deleting a member, changing a PIN, revoking a device,
 * connecting Google. Deliberately NOT required for ordinary chore approval,
 * which would train everyone to hate the app.
 */
export async function stepUp(req: HttpRequest): Promise<HttpResponseInit> {
  const session = await requireMember(req);

  const parsed = StepUpBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('Enter your 4-digit PIN.');

  const member = await getMemberRow(session.memberId);
  if (!member || !member.active) return unauthorized('That account is no longer active.');

  const now = Date.now();
  const lock = checkLockout(await readAttempts(session.memberId), now);
  if (lock.locked) {
    return tooManyRequests(lock.retryAfterSeconds, 'Too many tries. Wait a bit and try again.');
  }

  if (!(await verifyPin(parsed.data.pin, member))) {
    const decision = registerFailure(await readAttempts(session.memberId), now);
    await writeAttempts(session.memberId, decision.next);
    return unauthorized('That PIN did not work.');
  }

  await clearAttempts(session.memberId);
  const elevatedForSeconds = await elevateSession(session);
  return json({ ok: true, elevatedForSeconds });
}

/** Maps AuthError onto a response so each handler stays free of try/catch noise. */
export function guarded(
  handler: (req: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>,
) {
  return async (req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      return await handler(req, context);
    } catch (e) {
      if (e instanceof AuthError) return error(e.message, e.status);
      context.error('Unhandled error', e);
      return error('Something went wrong.', 500);
    }
  };
}

app.http('auth-login', {
  route: 'auth/login',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: guarded(login),
});

app.http('auth-logout', {
  route: 'auth/logout',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: guarded(logout),
});

app.http('auth-me', {
  route: 'auth/me',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: guarded(me),
});

app.http('auth-step-up', {
  route: 'auth/step-up',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: guarded(stepUp),
});

/** Referenced so the device cookie name is not accidentally dropped from the bundle. */
export const COOKIES = { SESSION_COOKIE, DEVICE_COOKIE };

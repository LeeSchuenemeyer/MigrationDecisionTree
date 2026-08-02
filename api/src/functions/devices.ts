import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { z } from 'zod';
import { TABLES, devicePK } from '../../../shared/keys.js';
import type { DeviceEntity } from '../../../shared/types.js';
import { env } from '../lib/env.js';
import { badRequest, json } from '../lib/http.js';
import { listPartition, upsert } from '../lib/tables.js';
import { enrollDevice, requireElevated, requireParent, withCookies } from '../lib/auth.js';
import { guarded } from './auth.js';

const EnrollBody = z.object({
  label: z.string().min(1).max(60),
  deviceKind: z.enum(['kiosk', 'personal']).default('kiosk'),
});

/**
 * POST /api/kiosk/enroll
 *
 * A parent does this once per tablet. The resulting cookie grants household
 * READ scope for a year, which is what lets the wall display render forever
 * with nobody signed in. It grants no write access whatsoever — every
 * mutation still needs a member session.
 */
export async function enroll(req: HttpRequest): Promise<HttpResponseInit> {
  const { member } = await requireParent(req);

  const parsed = EnrollBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return badRequest('Give this device a name.');

  const { cookie } = await enrollDevice(parsed.data.label, parsed.data.deviceKind, member.id);
  return withCookies(
    json({ ok: true, label: parsed.data.label, deviceKind: parsed.data.deviceKind }),
    [cookie],
  );
}

/** GET /api/devices — the parent-facing list, so a lost tablet can be revoked. */
export async function listDevices(req: HttpRequest): Promise<HttpResponseInit> {
  await requireParent(req);
  const rows = await listPartition<DeviceEntity>(TABLES.devices, devicePK(env.householdId));
  return json({
    devices: rows
      .filter((r) => !r.revoked)
      .map((r) => ({
        id: r.rowKey,
        label: r.label,
        deviceKind: r.deviceKind,
        enrolledAt: r.enrolledAt,
        lastSeenAt: r.lastSeenAt,
      })),
  });
}

/**
 * POST /api/devices/{id}/revoke
 *
 * Step-up required: revoking is how you respond to a tablet walking off, and
 * it is exactly the kind of action worth re-confirming.
 */
export async function revokeDevice(req: HttpRequest): Promise<HttpResponseInit> {
  await requireElevated(req);

  const id = req.params['id'];
  if (!id) return badRequest('Which device?');

  await upsert(TABLES.devices, {
    partitionKey: devicePK(env.householdId),
    rowKey: id,
    revoked: true,
  });
  return json({ ok: true });
}

app.http('kiosk-enroll', {
  route: 'kiosk/enroll',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: guarded(enroll),
});

app.http('devices-list', {
  route: 'devices',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: guarded(listDevices),
});

app.http('devices-revoke', {
  route: 'devices/{id}/revoke',
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: guarded(revokeDevice),
});

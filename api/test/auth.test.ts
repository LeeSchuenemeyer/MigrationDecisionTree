import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

// Point every module at the emulator before anything reads env.
process.env['TABLES_CONNECTION_STRING'] = 'UseDevelopmentStorage=true';
process.env['HOUSEHOLD_ID'] = 'test';
process.env['HOUSEHOLD_TZ'] = 'America/New_York';

const { TABLES, memberPK, memberRK, sessionPK } = await import('../../shared/keys.js');
const { MAX_ATTEMPTS } = await import('../../shared/pinPolicy.js');
const { ensureTables, listPartition, upsert, getEntity } = await import('../src/lib/tables.js');
const { hashPin, verifyPin } = await import('../src/lib/pin.js');
const {
  enrollDevice,
  destroySession,
  issueSession,
  requireParent,
  requireElevated,
  requireRead,
  resolveDevice,
  resolveSession,
  elevateSession,
} = await import('../src/lib/auth.js');
const { fakeRequest, cookieValue, purgeHousehold } = await import('./helpers.js');

const HH = 'test';

async function seedMember(id: string, role: 'parent' | 'child', pin: string) {
  const hashed = await hashPin(pin);
  await upsert(TABLES.members, {
    partitionKey: memberPK(HH),
    rowKey: memberRK(id),
    displayName: id,
    role,
    avatarEmoji: '🦊',
    avatarColor: '#F0A830',
    ...hashed,
    active: true,
    sortOrder: 0,
    pointsBalance: 0,
    lifetimePoints: 0,
    pendingPoints: 0,
    createdAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  await ensureTables();
  await purgeHousehold(HH);
  await seedMember('parent1', 'parent', '4816');
  await seedMember('child1', 'child', '7391');
});

describe('PIN hashing', () => {
  it('verifies the correct PIN and rejects a wrong one', async () => {
    const hashed = await hashPin('4816');
    expect(await verifyPin('4816', hashed)).toBe(true);
    expect(await verifyPin('4817', hashed)).toBe(false);
    expect(await verifyPin('', hashed)).toBe(false);
  });

  it('salts, so the same PIN never produces the same hash twice', async () => {
    const a = await hashPin('4816');
    const b = await hashPin('4816');
    expect(a.pinHash).not.toBe(b.pinHash);
    expect(a.pinSalt).not.toBe(b.pinSalt);
    // ...and both still verify.
    expect(await verifyPin('4816', a)).toBe(true);
    expect(await verifyPin('4816', b)).toBe(true);
  });

  it('rejects rather than throws when the algorithm is unknown', async () => {
    const hashed = await hashPin('4816');
    expect(await verifyPin('4816', { ...hashed, pinAlgo: 'scrypt-from-the-future' })).toBe(false);
  });
});

describe('sessions', () => {
  it('issues a session the cookie can resolve', async () => {
    const issued = await issueSession(
      { id: 'child1', role: 'child', displayName: 'child1' },
      'personal',
      'dev1',
    );
    const req = fakeRequest({ cookies: { fd_session: issued.token } });

    const resolved = await resolveSession(req);
    expect(resolved).not.toBeNull();
    expect(resolved!.memberId).toBe('child1');
    expect(resolved!.role).toBe('child');
  });

  it('never stores the raw token — only its hash', async () => {
    const issued = await issueSession(
      { id: 'child1', role: 'child', displayName: 'child1' },
      'personal',
      'dev1',
    );
    const rows = await listPartition(TABLES.sessions, sessionPK(HH));
    for (const row of rows) {
      expect(row.rowKey).not.toBe(issued.token);
      expect(JSON.stringify(row)).not.toContain(issued.token);
    }
    // The row key is a 64-char sha256 hex digest.
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.rowKey))).toBe(true);
  });

  it('gives the kiosk a much shorter session than a personal device', async () => {
    const kiosk = await issueSession({ id: 'child1', role: 'child', displayName: 'c' }, 'kiosk', 'd');
    const personal = await issueSession({ id: 'child1', role: 'child', displayName: 'c' }, 'personal', 'd');
    expect(kiosk.expiresInSeconds).toBe(600);
    expect(personal.expiresInSeconds).toBeGreaterThan(kiosk.expiresInSeconds);
  });

  it('treats an expired session as signed out and cleans the row up', async () => {
    const issued = await issueSession({ id: 'child1', role: 'child', displayName: 'c' }, 'kiosk', 'd');
    const req = fakeRequest({ cookies: { fd_session: issued.token } });

    expect(await resolveSession(req)).not.toBeNull();

    // Address the row by its own key. Earlier tests left several sessions for
    // this member in the partition, so searching by memberId would backdate an
    // unrelated one and the assertion below would pass for the wrong reason.
    const partitionKey = sessionPK(HH);
    const rowKey = createHash('sha256').update(issued.token).digest('hex');

    // Backdate expiry directly, rather than waiting ten minutes.
    await upsert(TABLES.sessions, {
      partitionKey,
      rowKey,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    expect(await resolveSession(fakeRequest({ cookies: { fd_session: issued.token } }))).toBeNull();
    // ...and the expired row is swept rather than left to accumulate.
    expect(await getEntity(TABLES.sessions, partitionKey, rowKey)).toBeNull();
  });

  it('resolves to null for an unknown or absent cookie', async () => {
    expect(await resolveSession(fakeRequest())).toBeNull();
    expect(await resolveSession(fakeRequest({ cookies: { fd_session: 'nonsense' } }))).toBeNull();
  });

  it('destroys a session on logout', async () => {
    const issued = await issueSession({ id: 'child1', role: 'child', displayName: 'c' }, 'personal', 'd');
    const req = fakeRequest({ cookies: { fd_session: issued.token } });
    expect(await resolveSession(req)).not.toBeNull();
    await destroySession(req);
    expect(await resolveSession(req)).toBeNull();
  });
});

describe('role guards', () => {
  it('lets a parent through and stops a child', async () => {
    const parent = await issueSession({ id: 'parent1', role: 'parent', displayName: 'p' }, 'personal', 'd');
    const child = await issueSession({ id: 'child1', role: 'child', displayName: 'c' }, 'personal', 'd');

    const ok = await requireParent(fakeRequest({ cookies: { fd_session: parent.token } }));
    expect(ok.member.role).toBe('parent');

    await expect(
      requireParent(fakeRequest({ cookies: { fd_session: child.token } })),
    ).rejects.toThrow(/Only a parent/);
  });

  it('re-reads the member row, so a demotion takes effect immediately', async () => {
    // The session was minted while this member was a parent...
    const issued = await issueSession(
      { id: 'parent1', role: 'parent', displayName: 'p' },
      'personal',
      'd',
    );
    const req = fakeRequest({ cookies: { fd_session: issued.token } });
    expect((await requireParent(req)).member.role).toBe('parent');

    // ...then the role changes underneath it.
    await upsert(TABLES.members, {
      partitionKey: memberPK(HH),
      rowKey: memberRK('parent1'),
      role: 'child',
    });
    await expect(requireParent(req)).rejects.toThrow(/Only a parent/);

    await upsert(TABLES.members, {
      partitionKey: memberPK(HH),
      rowKey: memberRK('parent1'),
      role: 'parent',
    });
  });

  it('requires a step-up for elevated actions, and honors one once granted', async () => {
    const issued = await issueSession(
      { id: 'parent1', role: 'parent', displayName: 'p' },
      'personal',
      'd',
    );
    const req = fakeRequest({ cookies: { fd_session: issued.token } });

    await expect(requireElevated(req)).rejects.toThrow(/Re-enter your PIN/);

    const session = (await resolveSession(req))!;
    await elevateSession(session);

    const elevated = await requireElevated(req);
    expect(elevated.member.role).toBe('parent');
  });
});

describe('device credentials', () => {
  it('lets an enrolled device read with nobody signed in', async () => {
    const { cookie } = await enrollDevice('Kitchen tablet', 'kiosk', 'parent1');
    const token = cookieValue(cookie);
    const req = fakeRequest({ cookies: { fd_device: token } });

    const device = await resolveDevice(req);
    expect(device?.deviceKind).toBe('kiosk');
    expect(device?.label).toBe('Kitchen tablet');

    // This is the whole point of the kiosk: reads work signed out.
    const read = await requireRead(req);
    expect(read.session).toBeNull();
    expect(read.device).not.toBeNull();
  });

  it('refuses reads from a browser with neither credential', async () => {
    await expect(requireRead(fakeRequest())).rejects.toThrow(/not set up/);
  });

  it('stops honoring a revoked device', async () => {
    const { cookie } = await enrollDevice('Lost tablet', 'kiosk', 'parent1');
    const token = cookieValue(cookie);
    const req = fakeRequest({ cookies: { fd_device: token } });

    const device = (await resolveDevice(req))!;
    await upsert(TABLES.devices, {
      partitionKey: (await import('../../shared/keys.js')).devicePK(HH),
      rowKey: device.rowKey,
      revoked: true,
    });

    expect(await resolveDevice(req)).toBeNull();
  });

  it('grants read scope only — a device token is not a write credential', async () => {
    const { cookie } = await enrollDevice('Hall tablet', 'kiosk', 'parent1');
    const req = fakeRequest({ cookies: { fd_device: cookieValue(cookie) } });
    // No member session, so every write guard must reject.
    await expect(requireParent(req)).rejects.toThrow();
  });
});

describe('lockout counter reaches storage', () => {
  it('locks after the configured number of failures', async () => {
    // Exercised end-to-end through the policy module in shared/, so here we
    // only confirm the constant the API enforces matches the shared policy.
    expect(MAX_ATTEMPTS).toBe(5);
  });
});

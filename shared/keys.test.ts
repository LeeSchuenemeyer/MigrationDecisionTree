import { describe, expect, it } from 'vitest';
import * as k from './keys.js';

/**
 * A malformed key is the #1 Table Storage bug class and it fails *silently* —
 * you get an empty query result, not an error. These round-trip tests are the
 * cheapest defense available.
 */

/** Values chosen to break naive key building: separators, reserved chars, unicode. */
const NASTY = [
  'simple',
  'with|separator',
  'with/slash',
  'with\\backslash',
  'with#hash',
  'with?question',
  'with~tilde',
  'with~7cfake-escape',
  '|leading',
  'trailing|',
  '||double||',
  'unicode-café-🦊',
  'a'.repeat(200),
  '01JAV8Y5R4Q9WZK3N2M7X6P1TB', // ULID
];

describe('segment encoding', () => {
  it('round-trips every nasty value', () => {
    for (const v of NASTY) {
      expect(k.decodeSegment(k.encodeSegment(v))).toBe(v);
    }
  });

  it('leaves no reserved character in the encoded form', () => {
    for (const v of NASTY) {
      const enc = k.encodeSegment(v);
      expect(enc).not.toMatch(/[|/\\#?]/);
    }
  });

  it('escapes the escape character, so fake escapes survive', () => {
    // If `~` were not escaped, "~7c" would decode to "|" and corrupt the key.
    expect(k.decodeSegment(k.encodeSegment('~7c'))).toBe('~7c');
    expect(k.encodeSegment('~7c')).not.toBe('~7c');
  });

  it('is idempotent under decode of an unencoded plain value', () => {
    expect(k.decodeSegment('plain')).toBe('plain');
  });
});

describe('tick ordering', () => {
  it('pads to a fixed width so keys sort lexically', () => {
    expect(k.ticks(0)).toHaveLength(k.TICKS_WIDTH);
    expect(k.ticks(1_700_000_000_000)).toHaveLength(k.TICKS_WIDTH);
    expect(k.inverseTicks(1_700_000_000_000)).toHaveLength(k.TICKS_WIDTH);
  });

  it('sorts ascending by time', () => {
    const a = k.ticks(1_000);
    const b = k.ticks(2_000);
    expect(a < b).toBe(true);
  });

  it('sorts newest-first for inverse ticks', () => {
    const older = k.inverseTicks(1_000);
    const newer = k.inverseTicks(2_000);
    expect(newer < older).toBe(true);
  });

  it('round-trips both directions', () => {
    for (const ms of [0, 1, 1_700_000_000_000, k.MAX_TICKS]) {
      expect(k.parseTicks(k.ticks(ms))).toBe(ms);
      expect(k.parseInverseTicks(k.inverseTicks(ms))).toBe(ms);
    }
  });

  it('rejects out-of-range timestamps rather than producing a short key', () => {
    expect(() => k.ticks(-1)).toThrow();
    expect(() => k.ticks(k.MAX_TICKS + 1)).toThrow();
    expect(() => k.ticks(1.5)).toThrow();
  });
});

describe('key round-trips', () => {
  const hh = 'house|hold';

  it('member', () => {
    expect(k.parseMemberPK(k.memberPK(hh))).toEqual({ householdId: hh });
    for (const id of NASTY) {
      expect(k.parseMemberRK(k.memberRK(id))).toEqual({ memberId: id });
    }
  });

  it('taskDef', () => {
    for (const id of NASTY) {
      expect(k.parseTaskDefRK(k.taskDefRK(id))).toEqual({ taskDefId: id });
    }
  });

  it('taskInstance', () => {
    const pk = k.taskInstancePK(hh, '2026-03-08');
    expect(k.parseTaskInstancePK(pk)).toEqual({ householdId: hh, localDate: '2026-03-08' });

    for (const defId of NASTY) {
      for (const memberId of ['maya', k.ANY_MEMBER, 'we|ird']) {
        const rk = k.taskInstanceRK(defId, memberId, 3);
        expect(k.parseTaskInstanceRK(rk)).toEqual({ taskDefId: defId, memberId, seq: 3 });
      }
    }
  });

  it('taskInstance seq defaults to 0 and stays in the key', () => {
    const rk = k.taskInstanceRK('d', 'm');
    expect(k.parseTaskInstanceRK(rk).seq).toBe(0);
    expect(rk.split('|')).toHaveLength(3);
  });

  it('actionQueue', () => {
    const rk = k.actionQueueRK(1_700_000_000_000, 'redemption', 'r|1');
    expect(k.parseActionQueueRK(rk)).toEqual({
      createdAtMs: 1_700_000_000_000,
      kind: 'redemption',
      refId: 'r|1',
    });
  });

  it('ledger', () => {
    const pk = k.ledgerPK(hh, 'ma|ya', '2026-03');
    expect(k.parseLedgerPK(pk)).toEqual({ householdId: hh, memberId: 'ma|ya', yearMonth: '2026-03' });

    const rk = k.ledgerRK(1_700_000_000_000, 'e|1');
    expect(k.parseLedgerRK(rk)).toEqual({ createdAtMs: 1_700_000_000_000, entryId: 'e|1' });
  });

  it('achievement award, with and without a repeat sequence', () => {
    expect(k.parseAchievementAwardRK(k.achievementAwardRK('def|1'))).toEqual({
      defId: 'def|1',
      seq: undefined,
    });
    expect(k.parseAchievementAwardRK(k.achievementAwardRK('def|1', 2))).toEqual({
      defId: 'def|1',
      seq: 2,
    });
  });

  it('redemption', () => {
    const rk = k.redemptionRK(1_700_000_000_000, 'red|1');
    expect(k.parseRedemptionRK(rk)).toEqual({
      requestedAtMs: 1_700_000_000_000,
      redemptionId: 'red|1',
    });
  });

  it('event', () => {
    expect(k.parseEventPK(k.eventPK(hh, '2026-03'))).toEqual({
      householdId: hh,
      yearMonth: '2026-03',
    });
    const rk = k.eventRK(1_700_000_000_000, 'ev|1');
    expect(k.parseEventRK(rk)).toEqual({ startUtcMs: 1_700_000_000_000, eventId: 'ev|1' });
  });

  it('feed', () => {
    expect(k.parseFeedPK(k.feedPK(hh, '2026-03-08'))).toEqual({
      householdId: hh,
      localDate: '2026-03-08',
    });
    const rk = k.feedRK(1_700_000_000_000, 'f|1');
    expect(k.parseFeedRK(rk)).toEqual({ createdAtMs: 1_700_000_000_000, feedId: 'f|1' });
  });
});

describe('malformed keys fail loudly', () => {
  it('throws on the wrong segment count rather than returning a partial parse', () => {
    expect(() => k.parseTaskInstanceRK('only|two')).toThrow(/expected 3 segments/);
    expect(() => k.parseLedgerPK('ledger|hh')).toThrow(/expected 4 segments/);
    expect(() => k.parseAchievementAwardRK('a|b|c')).toThrow(/Malformed/);
  });
});

describe('partition isolation', () => {
  it('household prefix keeps preview data away from production', () => {
    // This is the whole mechanism behind HOUSEHOLD_ID=preview on PR environments.
    expect(k.taskInstancePK('preview', '2026-03-08'))
      .not.toBe(k.taskInstancePK('prod', '2026-03-08'));
    expect(k.feedPK('preview', '2026-03-08')).toMatch(/^feed\|preview\|/);
  });

  it('builds an inclusive partition range for a week', () => {
    const r = k.taskInstancePKRange('hh', '2026-03-02', '2026-03-08');
    expect(r.from < r.to).toBe(true);
    expect(k.taskInstancePK('hh', '2026-03-05') > r.from).toBe(true);
    expect(k.taskInstancePK('hh', '2026-03-05') < r.to).toBe(true);
  });
});

describe('table registry', () => {
  it('exposes every table exactly once for provisioning', () => {
    expect(new Set(k.ALL_TABLES).size).toBe(k.ALL_TABLES.length);
    expect(k.ALL_TABLES).toContain('TaskInstances');
    expect(k.ALL_TABLES).toContain('EventMap');
  });
});

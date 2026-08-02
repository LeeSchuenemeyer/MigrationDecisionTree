import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

/**
 * PIN hashing.
 *
 * scrypt rather than PBKDF2 because it is memory-hard, and the ~50ms cost is
 * invisible at family request volume. The algorithm identifier is stored
 * alongside each hash so parameters can change later without a migration:
 * verify against whatever version the row was written with, then re-hash.
 *
 * This does not make a 4-digit PIN hard to brute-force offline — nothing
 * could. It protects against a casual storage-account dump. The online
 * attempt limiter in shared/pinPolicy.ts is the control that actually matters.
 */

const CURRENT_ALGO = 'scrypt-n16384-r8-p1-len64';

const PARAMS: Record<string, { N: number; r: number; p: number; keylen: number }> = {
  [CURRENT_ALGO]: { N: 16384, r: 8, p: 1, keylen: 64 },
};

export interface HashedPin {
  pinHash: string;
  pinSalt: string;
  pinAlgo: string;
}

export async function hashPin(pin: string): Promise<HashedPin> {
  const salt = randomBytes(16);
  const params = PARAMS[CURRENT_ALGO]!;
  const derived = await scrypt(pin, salt, params.keylen, params);
  return {
    pinHash: derived.toString('hex'),
    pinSalt: salt.toString('hex'),
    pinAlgo: CURRENT_ALGO,
  };
}

/** Constant-time verification. Returns false for an unknown algorithm rather than throwing. */
export async function verifyPin(pin: string, stored: HashedPin): Promise<boolean> {
  const params = PARAMS[stored.pinAlgo];
  if (!params) return false;

  const salt = Buffer.from(stored.pinSalt, 'hex');
  const expected = Buffer.from(stored.pinHash, 'hex');
  const derived = await scrypt(pin, salt, params.keylen, params);

  // timingSafeEqual throws on a length mismatch, which would itself leak a bit.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** True when a stored hash should be upgraded to the current parameters. */
export function needsRehash(stored: { pinAlgo: string }): boolean {
  return stored.pinAlgo !== CURRENT_ALGO;
}

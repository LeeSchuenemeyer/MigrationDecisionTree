import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from './env.js';

/**
 * AES-256-GCM for the one secret this app stores at rest: the Google refresh
 * token.
 *
 * That token is a durable credential for the household calendar — it does not
 * expire on its own, and anyone holding it can read and write the family's
 * schedule indefinitely. Storing it as plaintext in a table row means a storage
 * key leak is also a calendar compromise, and rotating out of that is a manual
 * mess. Encrypting it means the blast radius of a leaked storage key stops at
 * the data, not the Google account.
 *
 * GCM rather than CBC because it authenticates: a tampered ciphertext fails to
 * decrypt rather than yielding plausible garbage that gets sent to Google as a
 * token.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — the GCM standard, and what node expects.
const TAG_LENGTH = 16;

/**
 * `iv.tag.ciphertext`, all base64url.
 *
 * A self-describing single string, so the stored column is one field and a
 * partially-written row cannot produce a ciphertext missing its IV.
 */
export function encryptSecret(plaintext: string): string {
  const key = env.tokenEncryptionKey;
  const iv = randomBytes(IV_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

/**
 * Returns null rather than throwing on anything malformed.
 *
 * A rotated `TOKEN_ENCRYPTION_KEY`, a truncated row, or a tampered value should
 * all land in the same place: "we no longer have a usable token, ask a parent
 * to reconnect". Throwing here would take down the calendar read path for a
 * recoverable configuration problem.
 */
export function decryptSecret(payload: string): string | null {
  try {
    const parts = payload.split('.');
    if (parts.length !== 3) return null;

    const iv = Buffer.from(parts[0]!, 'base64url');
    const tag = Buffer.from(parts[1]!, 'base64url');
    const data = Buffer.from(parts[2]!, 'base64url');

    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) return null;

    const decipher = createDecipheriv(ALGORITHM, env.tokenEncryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

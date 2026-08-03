/**
 * Environment configuration.
 *
 * Every secret lives in a SWA Application Setting (or api/local.settings.json
 * for development) and is read here — never inlined, never shipped to the
 * browser. `HOUSEHOLD_ID` in particular is load-bearing: it prefixes every
 * partition key, which is what makes a PR preview environment
 * (HOUSEHOLD_ID=preview) safe against production family data.
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required app setting: ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  get householdId(): string {
    return optional('HOUSEHOLD_ID', 'local');
  },
  get timezone(): string {
    return optional('HOUSEHOLD_TZ', 'America/New_York');
  },
  get tablesConnectionString(): string {
    return required('TABLES_CONNECTION_STRING');
  },
  get tablesConnectionStringOrNull(): string | null {
    return process.env['TABLES_CONNECTION_STRING'] ?? null;
  },
  get anthropicApiKey(): string | null {
    return process.env['ANTHROPIC_API_KEY'] ?? null;
  },
  get googleClientId(): string {
    return required('GOOGLE_CLIENT_ID');
  },
  get googleClientSecret(): string {
    return required('GOOGLE_CLIENT_SECRET');
  },
  get googleRedirectUri(): string {
    return required('GOOGLE_REDIRECT_URI');
  },
  get tokenEncryptionKey(): Buffer {
    const raw = required('TOKEN_ENCRYPTION_KEY');
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) {
      throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    }
    return key;
  },
  get cronSharedSecret(): string {
    return required('CRON_SHARED_SECRET');
  },
  /**
   * Public HTTPS URL Google should push change notifications to.
   *
   * Optional by design: without it the watch channel is simply never created
   * and the calendar falls back to lazy sync on read, which bounds staleness at
   * five minutes anyway. That is also the only mode available during local
   * development, since Google cannot reach localhost.
   */
  get googleWebhookUrl(): string | null {
    return process.env['GOOGLE_WEBHOOK_URL'] ?? null;
  },
  get isProduction(): boolean {
    return (process.env['NODE_ENV'] ?? '') === 'production';
  },
};

export const VERSION = '0.1.0';

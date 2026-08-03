import { CONFIG_ROWS, TABLES, configPK, configRK } from '../../../shared/keys.js';
import { env } from './env.js';
import { getEntity, upsert } from './tables.js';

/**
 * Household settings.
 *
 * One point read, and every field has a safe default — the app has to work
 * before a parent has visited a settings screen, and it has to keep working if
 * the row is missing entirely.
 *
 * The defaults are chosen so that a household which never touches settings gets
 * the conservative behavior: commentary on (it degrades to hand-written copy
 * without a key anyway), challenges on, and an empty extra denylist.
 */
export interface HouseholdConfig {
  name: string;
  timezone: string;
  tickerEnabled: boolean;
  /** The parent kill switch for generated commentary. Off = facts only. */
  commentaryEnabled: boolean;
  challengeEnabled: boolean;
  /** JSON array of household-specific words the filter should also reject. */
  extraDenylistJson: string;
}

const DEFAULTS: HouseholdConfig = {
  name: 'Family HQ',
  timezone: 'America/New_York',
  tickerEnabled: true,
  commentaryEnabled: true,
  challengeEnabled: true,
  extraDenylistJson: '[]',
};

export async function householdConfig(): Promise<HouseholdConfig> {
  const row = await getEntity<Partial<HouseholdConfig>>(
    TABLES.config,
    configPK(env.householdId),
    configRK(CONFIG_ROWS.household),
  );
  return { ...DEFAULTS, timezone: env.timezone, ...stripUndefined(row) };
}

export async function updateHouseholdConfig(patch: Partial<HouseholdConfig>): Promise<void> {
  await upsert(TABLES.config, {
    partitionKey: configPK(env.householdId),
    rowKey: configRK(CONFIG_ROWS.household),
    ...stripUndefined(patch),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Table Storage omits null properties rather than storing them, so a partial
 * row spreads `undefined` over good defaults unless they are filtered out.
 */
function stripUndefined<T extends object>(value: T | null): Partial<T> {
  if (!value) return {};
  const out: Partial<T> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined && v !== null) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

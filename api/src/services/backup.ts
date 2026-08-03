import { gzipSync } from 'node:zlib';
import { BlobServiceClient } from '@azure/storage-blob';
import { ALL_TABLES, TABLES, type TableName } from '../../../shared/keys.js';
import { localDateNow } from '../../../shared/time.js';
import { env } from '../lib/env.js';
import { table } from '../lib/tables.js';

/**
 * The nightly snapshot.
 *
 * Table Storage has no point-in-time restore and no undo. The realistic
 * disaster is not Azure losing the account — it is a bad migration, a
 * mis-scoped delete, or a bug in a repair job wiping something a family cannot
 * reconstruct from memory. Two months of daily JSON in the same storage account
 * costs cents and turns that from unrecoverable into tedious.
 *
 * Deliberately NOT clever: whole tables, dumped as JSON, gzipped, one blob per
 * day. The household is a few thousand rows. Anything incremental would be more
 * code to get wrong, and the thing being protected against is precisely a bug
 * in code like that.
 *
 * Restore is manual on purpose. An automated restore endpoint is a
 * one-tap way to destroy the live household, and the event it serves happens
 * approximately never.
 */

const CONTAINER = 'backups';
const RETAIN_DAYS = 60;

/**
 * Tables excluded from the snapshot.
 *
 * `Sessions` and `PinAttempts` are ephemeral by construction — restoring them
 * would resurrect logins that were meant to have expired. `ClaudeCache` is a
 * cache of generated text, regenerable and not worth the bytes.
 */
const SKIP: TableName[] = [TABLES.sessions, TABLES.pinAttempts, TABLES.claudeCache];

export interface BackupResult {
  blob: string;
  tables: number;
  rows: number;
  bytes: number;
  pruned: number;
}

export async function backup(): Promise<BackupResult | { skipped: string }> {
  const connection = env.tablesConnectionStringOrNull;
  if (!connection) return { skipped: 'no storage connection configured' };

  const date = localDateNow(env.timezone);
  const dump: Record<string, unknown[]> = {};
  let rows = 0;

  for (const name of ALL_TABLES) {
    if (SKIP.includes(name)) continue;

    const entities: unknown[] = [];
    try {
      for await (const entity of table(name).listEntities()) {
        entities.push(entity);
        rows++;
      }
    } catch {
      // A table that does not exist yet is not a failure — it is a household
      // that has not used that feature. Recording it as empty is honest.
    }
    dump[name] = entities;
  }

  const body = gzipSync(
    Buffer.from(
      JSON.stringify({
        householdId: env.householdId,
        timezone: env.timezone,
        takenAt: new Date().toISOString(),
        localDate: date,
        tables: dump,
      }),
    ),
  );

  const service = BlobServiceClient.fromConnectionString(connection);
  const container = service.getContainerClient(CONTAINER);
  // No public access argument: a backup container that is publicly readable is
  // strictly worse than no backup at all.
  await container.createIfNotExists();

  // Household-prefixed like every partition key, so the preview environment
  // sharing this storage account cannot overwrite production's snapshot.
  const blob = `${env.householdId}/${date}.json.gz`;
  await container.getBlockBlobClient(blob).uploadData(body, {
    blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip' },
  });

  return { blob, tables: Object.keys(dump).length, rows, bytes: body.byteLength, pruned: await prune(container) };
}

/** Drop snapshots older than the retention window. */
async function prune(
  container: ReturnType<BlobServiceClient['getContainerClient']>,
): Promise<number> {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60 * 1000;
  let pruned = 0;

  for await (const blob of container.listBlobsFlat({ prefix: `${env.householdId}/` })) {
    const created = blob.properties.createdOn?.getTime();
    if (created === undefined || created >= cutoff) continue;
    await container.deleteBlob(blob.name);
    pruned++;
  }

  return pruned;
}

export interface BackupSummary {
  name: string;
  takenAt: string | null;
  bytes: number;
}

/** What snapshots exist — the parent-facing "is this actually running?" view. */
export async function listBackups(limit = 10): Promise<BackupSummary[]> {
  const connection = env.tablesConnectionStringOrNull;
  if (!connection) return [];

  const container = BlobServiceClient.fromConnectionString(connection).getContainerClient(
    CONTAINER,
  );
  if (!(await container.exists())) return [];

  const out: BackupSummary[] = [];
  for await (const blob of container.listBlobsFlat({ prefix: `${env.householdId}/` })) {
    out.push({
      name: blob.name,
      takenAt: blob.properties.createdOn?.toISOString() ?? null,
      bytes: blob.properties.contentLength ?? 0,
    });
  }

  return out.sort((a, b) => (a.name < b.name ? 1 : -1)).slice(0, limit);
}

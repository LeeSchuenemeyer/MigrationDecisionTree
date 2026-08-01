import { odata, TableClient, TableServiceClient, type TableEntity } from '@azure/data-tables';
import { ALL_TABLES, type TableName } from '../../../shared/keys.js';
import { env } from './env.js';

/**
 * Table Storage access.
 *
 * Two constraints from the plan are enforced here rather than left to callers:
 *
 * 1. There are NO cross-table transactions. Entity-group transactions require
 *    the same table *and* the same partition, so the ledger write and the
 *    balance update cannot be atomic. The fixed write ordering that makes the
 *    approve flow converge on retry lives in the approval service, not here.
 *
 * 2. Dates are stored as ISO *strings*, never `Date`. The SDK maps a JS Date to
 *    Edm.DateTime, which round-trips through timezone conversion and will
 *    surprise you inside a partition key.
 */

const clients = new Map<TableName, TableClient>();

export function table(name: TableName): TableClient {
  let c = clients.get(name);
  if (!c) {
    c = TableClient.fromConnectionString(env.tablesConnectionString, name, {
      allowInsecureConnection: true, // Azurite runs over http locally
    });
    clients.set(name, c);
  }
  return c;
}

/** Idempotent provisioning — safe to call on every cold start. */
export async function ensureTables(): Promise<void> {
  const service = TableServiceClient.fromConnectionString(env.tablesConnectionString, {
    allowInsecureConnection: true,
  });
  await Promise.all(
    ALL_TABLES.map(async (name) => {
      try {
        await service.createTable(name);
      } catch (e) {
        if (!isAlreadyExists(e)) throw e;
      }
    }),
  );
}

// --- error classification --------------------------------------------------

interface RestError {
  statusCode?: number;
  code?: string;
}

function asRestError(e: unknown): RestError {
  return (e ?? {}) as RestError;
}

/**
 * A 409 on createEntity is the entire idempotency guarantee behind
 * materialization: the row key is deterministic, so a duplicate create is a
 * no-op rather than an error. Callers swallow this deliberately.
 */
export function isAlreadyExists(e: unknown): boolean {
  const r = asRestError(e);
  return r.statusCode === 409 || r.code === 'EntityAlreadyExists' || r.code === 'TableAlreadyExists';
}

export function isNotFound(e: unknown): boolean {
  const r = asRestError(e);
  return r.statusCode === 404 || r.code === 'ResourceNotFound' || r.code === 'TableNotFound';
}

/** 412 means someone else wrote first — re-read and retry. */
export function isPreconditionFailed(e: unknown): boolean {
  const r = asRestError(e);
  return r.statusCode === 412 || r.code === 'UpdateConditionNotSatisfied';
}

// --- helpers ---------------------------------------------------------------

export type Entity<T extends object> = TableEntity<T>;

/** Point read that returns null instead of throwing on a miss. */
export async function getEntity<T extends object>(
  name: TableName,
  partitionKey: string,
  rowKey: string,
): Promise<(Entity<T> & { etag: string }) | null> {
  try {
    const e = await table(name).getEntity<T>(partitionKey, rowKey);
    return e as Entity<T> & { etag: string };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Every row in one partition — a point-partition query, never a table scan. */
export async function listPartition<T extends object>(
  name: TableName,
  partitionKey: string,
  options: { top?: number } = {},
): Promise<(Entity<T> & { etag: string })[]> {
  const iter = table(name).listEntities<T>({
    queryOptions: { filter: odata`PartitionKey eq ${partitionKey}` },
  });
  return collect(iter, options.top);
}

/**
 * Inclusive partition-key *range* query — this is what makes "this week" cheap
 * (7 partitions) instead of a filtered scan of the whole table.
 */
export async function listPartitionRange<T extends object>(
  name: TableName,
  fromPartitionKey: string,
  toPartitionKey: string,
  options: { top?: number } = {},
): Promise<(Entity<T> & { etag: string })[]> {
  const iter = table(name).listEntities<T>({
    queryOptions: {
      filter: odata`PartitionKey ge ${fromPartitionKey} and PartitionKey le ${toPartitionKey}`,
    },
  });
  return collect(iter, options.top);
}

async function collect<T extends object>(
  iter: AsyncIterable<T>,
  top?: number,
): Promise<(Entity<T> & { etag: string })[]> {
  const out: (Entity<T> & { etag: string })[] = [];
  for await (const e of iter) {
    out.push(e as Entity<T> & { etag: string });
    if (top !== undefined && out.length >= top) break;
  }
  return out;
}

/**
 * Create, reporting whether the row was new. Returns false on 409 rather than
 * throwing — see the note on isAlreadyExists.
 */
export async function createIfAbsent<T extends object>(
  name: TableName,
  entity: Entity<T>,
): Promise<boolean> {
  try {
    await table(name).createEntity(entity);
    return true;
  } catch (e) {
    if (isAlreadyExists(e)) return false;
    throw e;
  }
}

export async function upsert<T extends object>(name: TableName, entity: Entity<T>): Promise<void> {
  await table(name).upsertEntity(entity, 'Merge');
}

export async function replace<T extends object>(
  name: TableName,
  entity: Entity<T>,
  etag?: string,
): Promise<void> {
  await table(name).updateEntity(entity, 'Replace', etag ? { etag } : undefined);
}

export async function remove(name: TableName, partitionKey: string, rowKey: string): Promise<void> {
  try {
    await table(name).deleteEntity(partitionKey, rowKey);
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
}

/**
 * Read-modify-write against an ETag, retrying on 412. Used for the
 * `Member.pointsBalance` cache, where a concurrent approval would otherwise
 * silently clobber the other writer.
 */
export async function updateWithRetry<T extends object>(
  name: TableName,
  partitionKey: string,
  rowKey: string,
  mutate: (current: Entity<T> & { etag: string }) => Entity<T> | null,
  attempts = 5,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const current = await getEntity<T>(name, partitionKey, rowKey);
    if (!current) return false;

    const next = mutate(current);
    if (next === null) return true; // caller decided this is already done

    try {
      await table(name).updateEntity(next, 'Replace', { etag: current.etag });
      return true;
    } catch (e) {
      if (!isPreconditionFailed(e)) throw e;
      // Someone wrote first — loop and re-read.
    }
  }
  throw new Error(`updateWithRetry exhausted ${attempts} attempts on ${name}/${partitionKey}`);
}

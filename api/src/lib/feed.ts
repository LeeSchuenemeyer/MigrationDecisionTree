import { randomUUID } from 'node:crypto';
import { TABLES, feedPK, feedRK } from '../../../shared/keys.js';
import { localDateNow } from '../../../shared/time.js';
import type { FeedEntity, FeedKind } from '../../../shared/types.js';
import { env } from './env.js';
import { bumpRev } from './rev.js';
import { upsert } from './tables.js';

/**
 * The activity feed behind the ticker.
 *
 * Actor name and avatar are denormalized onto every row so the ticker renders
 * from a single point-partition query with zero fan-out. Rows are written with
 * inverse ticks, so "today, newest first" needs no client-side sort.
 *
 * `commentary` stays null here. Claude annotates items in batches on the cron
 * tick (Phase 5) — writing a feed item never blocks on a model call, and the
 * factual headline alone is a complete ticker if the API is unavailable.
 */
export interface WriteFeedInput {
  kind: FeedKind;
  headline: string;
  detail?: string | null;
  icon?: string | null;
  points?: number | null;
  actor?: { id: string; name: string; avatar: string } | null;
  refType?: string | null;
  refId?: string | null;
  /** Set false for items that should never receive generated commentary. */
  eligibleForCommentary?: boolean;
}

export async function writeFeedItem(input: WriteFeedInput): Promise<string> {
  const now = Date.now();
  const feedId = randomUUID();

  const entity: FeedEntity & { partitionKey: string; rowKey: string } = {
    partitionKey: feedPK(env.householdId, localDateNow(env.timezone, now)),
    rowKey: feedRK(now, feedId),
    kind: input.kind,
    actorMemberId: input.actor?.id ?? null,
    actorName: input.actor?.name ?? null,
    actorAvatar: input.actor?.avatar ?? null,
    headline: input.headline,
    detail: input.detail ?? null,
    icon: input.icon ?? null,
    points: input.points ?? null,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    commentary: null,
    commentarySource: null,
    commentaryModel: null,
    suppressed: false,
    createdAt: new Date(now).toISOString(),
  };

  await upsert(TABLES.feed, entity);
  await bumpRev(['feed'], {
    ...(input.eligibleForCommentary === false ? {} : { commentaryDirty: true }),
  });

  return feedId;
}

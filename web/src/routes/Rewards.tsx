import { useState, type ReactNode } from 'react';
import type { Reward } from '@shared/types';
import { useMemberPoints, useRedeem, useRewards } from '@/lib/points';
import { useSession } from '@/lib/session';

/**
 * What points are actually for.
 *
 * The exchange rate is the load-bearing part of a points economy — a catalog
 * where everything is affordable is a participation trophy, and one where
 * nothing is is a tax. So this screen leads with the balance and shows the gap
 * to anything out of reach, rather than just greying it out.
 *
 * Redeeming debits immediately and queues for a parent. That ordering is
 * deliberate (see requestRedemption): holding the points instead would let
 * someone queue five rewards they can each afford but not collectively.
 */
export function Rewards(): ReactNode {
  const session = useSession();
  const rewards = useRewards();
  const redeem = useRedeem();

  const me = session.data?.member ?? null;
  const mine = useMemberPoints(me?.id ?? null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const balance = mine.data?.pointsBalance ?? me?.pointsBalance ?? 0;
  const list = rewards.data ?? [];

  if (rewards.isPending) return <p className="text-ink-faint p-6 text-sm">Loading rewards…</p>;

  return (
    <section className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4 kiosk:p-6">
      <h2 className="font-display text-ink-dim flex items-baseline justify-between text-sm tracking-[0.16em] uppercase kiosk:text-lg">
        Rewards
        {me && (
          <span className="text-brand font-mono text-base tracking-normal tabular-nums kiosk:text-2xl">
            {balance} points
          </span>
        )}
      </h2>

      {!me && (
        <p className="text-ink-faint text-sm italic">
          Tap your face up top and enter your PIN to spend points.
        </p>
      )}

      {list.length === 0 && (
        <p className="text-ink-faint py-6 text-center text-sm italic">
          The catalog is empty. A parent can add rewards from Settings.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {list.map((reward) => (
          <RewardCard
            key={reward.id}
            reward={reward}
            balance={balance}
            signedIn={me !== null}
            busy={redeem.isPending}
            confirming={confirming === reward.id}
            onAsk={() => setConfirming(reward.id)}
            onCancel={() => setConfirming(null)}
            onConfirm={() => {
              setConfirming(null);
              redeem.mutate(reward.id);
            }}
          />
        ))}
      </ul>

      {redeem.isError && (
        <p className="text-overdue text-sm">
          {redeem.error instanceof Error ? redeem.error.message : 'That did not go through.'}
        </p>
      )}

      {mine.data && mine.data.redemptions.length > 0 && (
        <div className="flex flex-col gap-2">
          <h3 className="font-display text-ink-dim text-xs tracking-[0.14em] uppercase kiosk:text-base">
            Your redemptions
          </h3>
          <ul className="flex flex-col gap-1">
            {mine.data.redemptions.slice(0, 8).map((r) => (
              <li
                key={r.id}
                className="border-line/60 flex items-baseline justify-between gap-3 border-b py-1.5 text-sm last:border-0 kiosk:text-lg"
              >
                <span className="truncate">{r.rewardTitle}</span>
                <span
                  className={[
                    'font-display shrink-0 text-xs tracking-[0.12em] uppercase kiosk:text-base',
                    r.status === 'pending'
                      ? 'text-pending'
                      : r.status === 'fulfilled'
                        ? 'text-approved'
                        : 'text-ink-faint',
                  ].join(' ')}
                >
                  {r.status === 'rejected' ? 'refunded' : r.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RewardCard({
  reward,
  balance,
  signedIn,
  busy,
  confirming,
  onAsk,
  onCancel,
  onConfirm,
}: {
  reward: Reward;
  balance: number;
  signedIn: boolean;
  busy: boolean;
  confirming: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode {
  const affordable = reward.affordable ?? balance >= reward.cost;
  const short = reward.cost - balance;
  const soldOut = reward.stock === 0;

  return (
    <li
      className={[
        'border-line bg-panel grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border p-3',
        'kiosk:gap-5 kiosk:p-5',
        affordable && !soldOut ? '' : 'opacity-60',
      ].join(' ')}
    >
      <span className="text-2xl kiosk:text-4xl" aria-hidden="true">
        {reward.icon ?? '🎁'}
      </span>

      <span className="min-w-0">
        <span className="block truncate kiosk:text-2xl">{reward.title}</span>
        <span className="text-ink-faint block font-mono text-xs kiosk:text-base">
          {soldOut
            ? 'out of stock'
            : affordable
              ? reward.description || 'ready to redeem'
              : /* The gap, not just "you cannot". A number to aim at is the
                   difference between a locked door and a goal. */
                `${short} more ${short === 1 ? 'point' : 'points'} to go`}
          {reward.stock > 0 && !soldOut ? ` · ${reward.stock} left` : ''}
        </span>
      </span>

      {confirming ? (
        <span className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="border-line text-ink-dim hover:text-ink min-h-touch kiosk:min-h-touch-kiosk font-display rounded-full border px-4 text-xs tracking-[0.12em] uppercase"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="border-brand bg-brand/15 text-brand hover:bg-brand hover:text-ground min-h-touch kiosk:min-h-touch-kiosk font-display rounded-full border px-5 text-xs tracking-[0.12em] uppercase transition-colors disabled:opacity-50"
          >
            Spend {reward.cost}
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={!signedIn || !affordable || soldOut || busy}
          onClick={onAsk}
          className="border-line text-brand hover:bg-panel-2 min-h-touch kiosk:min-h-touch-kiosk font-mono rounded-full border px-5 tabular-nums transition-colors disabled:opacity-40 kiosk:text-2xl"
        >
          {reward.cost}
        </button>
      )}
    </li>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import type { Member } from '@shared/types';
import { useLogin, useLogout, useMembers, useSession } from '@/lib/session';
import { PinKeypad } from './PinKeypad';

/**
 * The avatar row in the top bar, and everything sign-in.
 *
 * Signed out, this is just faces — which is the resting state of the wall
 * tablet and is deliberately not treated as an error or an empty state.
 * Signed in, it becomes a name plus a visible countdown, so nobody is
 * surprised when the session drops back to ambient.
 */
export function SessionControl(): ReactNode {
  const session = useSession();
  const members = useMembers();
  const login = useLogin();
  const logout = useLogout();
  const [pendingMember, setPendingMember] = useState<Member | null>(null);

  const me = session.data?.member ?? null;

  // Close the keypad once a login lands.
  useEffect(() => {
    if (me) setPendingMember(null);
  }, [me]);

  if (me) {
    return (
      <div className="flex items-center gap-2">
        <SessionChip
          member={me}
          expiresInSeconds={session.data?.expiresInSeconds ?? null}
          onExpire={() => void session.refetch()}
        />
        <button
          type="button"
          onClick={() => logout.mutate()}
          aria-label="Sign out"
          className="border-line text-ink-faint hover:text-ink min-h-touch kiosk:min-h-touch-kiosk grid aspect-square place-items-center rounded-full border"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-1.5">
        {members.data?.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              login.reset();
              setPendingMember(m);
            }}
            aria-label={`Sign in as ${m.displayName}`}
            title={m.displayName}
            className="bg-panel-2 min-h-touch kiosk:min-h-touch-kiosk grid aspect-square place-items-center rounded-full border-2 border-transparent text-xl transition-transform hover:-translate-y-0.5 kiosk:text-3xl"
            style={{ borderColor: 'transparent' }}
          >
            <span aria-hidden="true">{m.avatarEmoji}</span>
          </button>
        ))}
      </div>

      {pendingMember && (
        <PinKeypad
          member={pendingMember}
          pending={login.isPending}
          error={login.error ?? null}
          onSubmit={(pin) => login.mutate({ memberId: pendingMember.id, pin })}
          onCancel={() => {
            login.reset();
            setPendingMember(null);
          }}
        />
      )}
    </>
  );
}

function SessionChip({
  member,
  expiresInSeconds,
  onExpire,
}: {
  member: Member;
  expiresInSeconds: number | null;
  onExpire: () => void;
}): ReactNode {
  const [left, setLeft] = useState(expiresInSeconds ?? 0);

  useEffect(() => {
    setLeft(expiresInSeconds ?? 0);
    if (expiresInSeconds === null) return;
    const timer = setInterval(() => {
      setLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          onExpire();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresInSeconds, onExpire]);

  const mins = Math.floor(left / 60);
  const secs = left % 60;

  return (
    <span className="border-brand bg-brand/15 text-brand font-display flex items-center gap-2 rounded-full border px-3 py-1 text-xs tracking-[0.1em] uppercase kiosk:text-base">
      <span aria-hidden="true">{member.avatarEmoji}</span>
      {member.displayName}
      {/* Only worth showing when it is short enough to matter — i.e. the kiosk. */}
      {left > 0 && left <= 60 * 60 && (
        <span className="font-mono tracking-normal tabular-nums">
          {mins}:{String(secs).padStart(2, '0')}
        </span>
      )}
    </span>
  );
}

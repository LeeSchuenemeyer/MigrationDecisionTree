import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Member } from '@shared/types';
import { PIN_LENGTH } from '@shared/pinPolicy';

interface Props {
  member: Member;
  onSubmit: (pin: string) => void;
  onCancel: () => void;
  pending: boolean;
  error: { message: string; retryAfterSeconds: number | null } | null;
}

/**
 * Big numeric keypad.
 *
 * Deliberately not a text input: a wall tablet must never summon the OS
 * keyboard, and the digits need to be hittable at arm's length. Physical
 * keyboard input is still accepted, because on a laptop that is what people
 * will reach for.
 */
export function PinKeypad({ member, onSubmit, onCancel, pending, error }: Props): ReactNode {
  const [digits, setDigits] = useState('');

  // Clear the entry after a rejection so the next attempt starts clean.
  useEffect(() => {
    if (error) setDigits('');
  }, [error]);

  const push = useCallback(
    (d: string) => {
      if (pending) return;
      setDigits((prev) => {
        if (prev.length >= PIN_LENGTH) return prev;
        const next = prev + d;
        if (next.length === PIN_LENGTH) onSubmit(next);
        return next;
      });
    },
    [onSubmit, pending],
  );

  const back = useCallback(() => setDigits((p) => p.slice(0, -1)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') push(e.key);
      else if (e.key === 'Backspace') back();
      else if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [push, back, onCancel]);

  const lockedFor = error?.retryAfterSeconds ?? null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Enter ${member.displayName}'s PIN`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="border-line bg-panel flex w-full max-w-xs flex-col items-center gap-5 rounded-xl border p-6">
        <div className="flex flex-col items-center gap-2">
          <span className="text-4xl" aria-hidden="true">
            {member.avatarEmoji}
          </span>
          <h2 className="font-display text-lg tracking-[0.14em] uppercase">
            {member.displayName}
          </h2>
        </div>

        <div className="flex gap-3" aria-live="polite" aria-label={`${digits.length} of ${PIN_LENGTH} digits entered`}>
          {Array.from({ length: PIN_LENGTH }, (_, i) => (
            <span
              key={i}
              className={[
                'size-3.5 rounded-full border-2 transition-colors',
                i < digits.length ? 'border-brand bg-brand' : 'border-ink-faint',
              ].join(' ')}
            />
          ))}
        </div>

        {error && (
          <p className="text-overdue text-center text-sm" role="alert">
            {error.message}
            {lockedFor !== null && lockedFor > 0 && (
              <span className="text-ink-faint mt-1 block font-mono text-xs">
                try again in {Math.ceil(lockedFor / 60)} min
              </span>
            )}
          </p>
        )}

        <div className="grid grid-cols-3 gap-2.5">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => (
            <KeypadButton key={n} onClick={() => push(n)} disabled={pending}>
              {n}
            </KeypadButton>
          ))}
          <KeypadButton onClick={back} disabled={pending} label="Delete">
            ⌫
          </KeypadButton>
          <KeypadButton onClick={() => push('0')} disabled={pending}>
            0
          </KeypadButton>
          <span />
        </div>

        <button
          type="button"
          onClick={onCancel}
          className="text-ink-faint hover:text-ink font-display min-h-touch text-sm tracking-[0.12em] uppercase"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function KeypadButton({
  children,
  onClick,
  disabled,
  label,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled: boolean;
  label?: string;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="border-line bg-panel-2 hover:bg-line min-h-touch kiosk:min-h-touch-kiosk w-16 rounded-lg border font-mono text-2xl transition-colors active:scale-95 disabled:opacity-50 kiosk:w-24 kiosk:text-4xl"
    >
      {children}
    </button>
  );
}

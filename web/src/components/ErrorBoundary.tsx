import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  /**
   * Seconds before an unattended surface reloads itself. A wall tablet must
   * never sit on a white screen until somebody notices — this is a correctness
   * requirement for the kiosk, not polish.
   */
  autoReloadAfterSeconds: number | null;
}

interface State {
  error: Error | null;
  secondsLeft: number;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, secondsLeft: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error', error, info.componentStack);

    const after = this.props.autoReloadAfterSeconds;
    if (after === null) return;

    this.setState({ secondsLeft: after });
    this.timer = setInterval(() => {
      this.setState(
        (s) => ({ secondsLeft: s.secondsLeft - 1 }),
        () => {
          if (this.state.secondsLeft <= 0) window.location.reload();
        },
      );
    }, 1000);
  }

  override componentWillUnmount(): void {
    if (this.timer) clearInterval(this.timer);
  }

  override render(): ReactNode {
    const { error, secondsLeft } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <p className="font-display text-brand text-sm tracking-[0.18em] uppercase">
          Something broke
        </p>
        <h1 className="font-display text-2xl tracking-wide uppercase kiosk:text-4xl">
          The board hit a snag
        </h1>
        <p className="text-ink-dim max-w-prose text-sm">
          {this.props.autoReloadAfterSeconds === null
            ? 'Reload the page to try again.'
            : `Reloading automatically in ${Math.max(0, secondsLeft)}s.`}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="border-brand text-brand min-h-touch kiosk:min-h-touch-kiosk rounded-full border px-6 font-display text-sm tracking-[0.12em] uppercase"
        >
          Reload now
        </button>
      </div>
    );
  }
}

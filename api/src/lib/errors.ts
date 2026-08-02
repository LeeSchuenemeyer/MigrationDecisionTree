/**
 * The one error type the service layer throws to mean "this is the caller's
 * fault, here is the status code and a sentence a child can read".
 *
 * It lives in lib/ rather than in a service so that services can throw it
 * without importing one another — tasks and points both raise it, and a
 * services/tasks ↔ services/points import cycle is exactly the kind of thing
 * that works under tsc and then breaks subtly once esbuild reorders the bundle.
 */
export class TaskError extends Error {
  constructor(
    override readonly message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'TaskError';
  }
}

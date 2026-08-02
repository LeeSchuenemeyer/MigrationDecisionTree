/**
 * Function app entry point.
 *
 * esbuild bundles this whole tree into a single dist/index.js with
 * @azure/functions left external (the host resolves it). That sidesteps every
 * node_modules hoisting question in the SWA managed-functions environment,
 * whose failure mode is a deploy that "succeeds" with zero functions
 * registered and no obvious error.
 *
 * Each module below registers its routes via `app.http(...)` as a side effect,
 * so importing it here is what makes the function exist.
 *
 * Note: SWA managed functions are HTTP-trigger only — there is no timer
 * trigger. Scheduled work runs lazily on read, or via POST /api/cron/tick
 * driven by a GitHub Actions schedule.
 */

import './functions/health.js';
import './functions/auth.js';
import './functions/members.js';
import './functions/devices.js';
import './functions/tasks.js';
import './functions/points.js';

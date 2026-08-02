import { app, type HttpRequest, type HttpResponseInit } from '@azure/functions';
import { json } from '../lib/http.js';
import { listMembers, toMember } from '../lib/members.js';
import { guarded } from './auth.js';

/**
 * GET /api/members
 *
 * Anonymous on purpose. The avatar grid has to render before any credential
 * exists — on first boot there is no device token and nobody is signed in, and
 * a kiosk that cannot show you who to tap is unusable.
 *
 * What that exposes is bounded by design: first names, an emoji, a colour, and
 * a score. The threat model explicitly accepts this (no PII beyond first names
 * and emoji), and `toMember` strips every credential field.
 */
export async function getMembers(_req: HttpRequest): Promise<HttpResponseInit> {
  const rows = await listMembers();
  return json({ members: rows.map(toMember) });
}

app.http('members-list', {
  route: 'members',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: guarded(getMembers),
});

import type { Express } from 'express';
import { parseTypingReport } from '../../../../../shared/room-typing.mjs';
import { isAppSession } from '../../../request/app-session.js';
import type { AuthenticatedRequest } from '../../../http/helpers.js';
import { roomTyping } from '../../../server/room-typing.js';
import { resolveParticipantRoom } from './helpers.js';
import type { RoomMessageRouteDeps } from './types.js';

export function registerRoomTypingRoute(app: Express, deps: RoomMessageRouteDeps): void {
  app.post(/^\/rooms\/(.+)\/typing$/, async (req: AuthenticatedRequest, res) => {
    if (!isAppSession(req)) {
      res.status(req.authKind ? 403 : 401).json({ error: 'person_required' });
      return;
    }
    const input = parseTypingReport(req.body);
    if (!input) { res.status(400).json({ error: 'invalid_typing' }); return; }
    const project = await resolveParticipantRoom(req, res, deps);
    if (!project) return;
    if (!project.focus_key?.startsWith('rental:')) {
      const account = req.sessionAccount!;
      roomTyping.report(project.id, account.account_id, account.display_name?.trim() || account.login, input);
    }
    res.status(204).end();
  });
}

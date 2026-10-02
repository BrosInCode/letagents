import type { Express, Response } from 'express';
import { ROOM_NOTIFICATION_LEVELS, type RoomNotificationPreferenceChange } from '../../../../shared/room-notification-preferences.mjs';
import * as databaseStore from '../../db/room-notification-preferences.js';
import type { AuthenticatedRequest } from '../../http/helpers.js';
import { isHumanAppWrite } from '../../request/app-session.js';
import { resolveParticipantRoom } from './messages/helpers.js';
import type { RoomMessageRouteDeps } from './messages/types.js';

type Deps = RoomMessageRouteDeps & { notificationPreferenceStore?: typeof databaseStore };

function requirePerson(req: AuthenticatedRequest, res: Response): string | null {
  if (isHumanAppWrite(req, req.body ?? {})) return req.sessionAccount!.account_id;
  res.status(req.authKind ? 403 : 401).json({ code: 'person_required', error: 'Sign in as a person to manage your notifications.' });
  return null;
}

function fail(res: Response, error: unknown): void {
  const busy = (error as { code?: string } | null)?.code === '55P03';
  if (!busy) console.error('[notification preferences]', error);
  res.status(busy ? 503 : 500).json({ error: busy ? 'This setting is busy. Please retry.' : 'Notification settings could not be loaded or saved.' });
}

export function registerRoomNotificationPreferenceRoutes(app: Express, deps: Deps): void {
  const store = deps.notificationPreferenceStore ?? databaseStore;
  app.get('/account/room-notification-preferences', async (req: AuthenticatedRequest, res) => {
    const accountId = requirePerson(req, res);
    if (!accountId) return;
    try { res.json(await store.listRoomNotificationPreferences(accountId)); }
    catch (error) { fail(res, error); }
  });

  const route = /^\/rooms\/(.+)\/notification-preferences$/;
  app.get(route, async (req: AuthenticatedRequest, res) => {
    const accountId = requirePerson(req, res);
    if (!accountId) return;
    try {
      const room = await resolveParticipantRoom(req, res, deps);
      if (room) res.json(await store.getRoomNotificationPreference(accountId, room.id));
    } catch (error) { fail(res, error); }
  });
  app.put(route, async (req: AuthenticatedRequest, res) => {
    const accountId = requirePerson(req, res);
    if (!accountId) return;
    try {
      const room = await resolveParticipantRoom(req, res, deps);
      if (!room) return;
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || !Object.keys(body).length || Object.keys(body).some((key) => key !== 'level' && key !== 'snoozed_until')
        || ('level' in body && !ROOM_NOTIFICATION_LEVELS.includes(body.level))) {
        res.status(400).json({ error: 'Choose a notification level or snooze time.' }); return;
      }
      const change: RoomNotificationPreferenceChange = {};
      if ('level' in body) change.level = body.level;
      if ('snoozed_until' in body) {
        if (body.snoozed_until === null) change.snoozed_until = null;
        else {
          const raw = body.snoozed_until;
          if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(raw)
            || !Number.isFinite(Date.parse(raw))) {
            res.status(400).json({ error: 'Send an absolute snooze timestamp with a timezone.' }); return;
          }
          change.snoozed_until = new Date(raw).toISOString();
        }
      }
      const result = await store.setRoomNotificationPreference(accountId, room.id, change);
      if (!result) { res.status(400).json({ error: 'Snooze must end in the future, within seven days.' }); return; }
      res.json(result);
    } catch (error) { fail(res, error); }
  });
}

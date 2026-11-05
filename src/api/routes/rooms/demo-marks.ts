import type { Express, Response } from 'express';

import { isLiveDemoKey, parseDemoMarkInput } from '../../../../shared/live-demo.mjs';
import type { Project } from '../../db.js';
import * as databaseStore from '../../db/demo-marks.js';
import type { AuthenticatedRequest } from '../../http/helpers.js';
import { liveDemosOffered } from '../../live-demos/access.js';
import type { LiveDemoHub } from '../../live-demos/hub.js';
import { CROSS_SITE_WRITE_REFUSED, isAppSession, isSameOriginCookieWrite } from '../../request/app-session.js';
import { resolveGitRoomProjectRole } from '../../rooms/access.js';
import { normalizeRoomId } from '../../rooms/routing.js';
import { routeParam } from './messages/helpers.js';
import type { RoomMessageRouteDeps } from './messages/types.js';

export type DemoMarkRouteDeps = Pick<
  RoomMessageRouteDeps,
  'resolveCanonicalRoomRequestId' | 'resolveRoomOrReply' | 'requireParticipant'
> & {
  demoMarkStore?: Pick<typeof databaseStore, 'listDemoMarks' | 'createDemoMark' | 'getDemoMarkOwner' | 'deleteDemoMark'>;
  resolveProjectRole?: typeof resolveGitRoomProjectRole;
  /** Tells the demo's live viewers about a saved or removed mark. */
  liveDemoHub?: Pick<LiveDemoHub, 'broadcast'>;
};

const MARK_ID = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Saved strokes and pins on an HTML demo. Anyone who can read the room reads
 * them; a person in the app saves them; the author or a room admin removes
 * one. Rental rooms have no live demos, so they have no marks either.
 */
export function registerDemoMarkRoutes(app: Express, deps: DemoMarkRouteDeps): void {
  const store = deps.demoMarkStore ?? databaseStore;
  const resolveRole = deps.resolveProjectRole ?? resolveGitRoomProjectRole;
  const hub = deps.liveDemoHub;

  const room = async (req: AuthenticatedRequest, res: Response): Promise<Project | null> => {
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(routeParam(req, 0)));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project || !(await deps.requireParticipant(req, res, project))) return null;
    if (!liveDemosOffered(project)) {
      res.status(404).json({ error: 'demo_marks_unavailable', message: 'Demos in this room have no marks.' });
      return null;
    }
    return project;
  };

  const person = (req: AuthenticatedRequest, res: Response): string | null => {
    if (!isAppSession(req)) {
      res.status(req.authKind ? 403 : 401).json({ error: 'person_required', message: 'Sign in to LetAgents to draw on demos.' });
      return null;
    }
    if (!isSameOriginCookieWrite(req)) {
      res.status(403).json({ error: 'cross_site_write', message: CROSS_SITE_WRITE_REFUSED });
      return null;
    }
    return req.sessionAccount!.account_id;
  };

  app.get(/^\/rooms\/(.+)\/demo-marks$/, async (req: AuthenticatedRequest, res) => {
    const project = await room(req, res);
    if (!project) return;
    const demo = typeof req.query.demo === 'string' ? req.query.demo : '';
    if (!isLiveDemoKey(demo)) {
      res.status(400).json({ error: 'invalid_demo', message: 'Name the demo as <message id>/<attachment id>.' });
      return;
    }
    res.json({ marks: await store.listDemoMarks(project.id, demo) });
  });

  app.post(/^\/rooms\/(.+)\/demo-marks$/, async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res);
    if (!accountId) return;
    const input = parseDemoMarkInput(req.body);
    if (!input) {
      res.status(400).json({ error: 'invalid_mark', message: 'This mark is not valid.' });
      return;
    }
    const project = await room(req, res);
    if (!project) return;
    const result = await store.createDemoMark(project.id, accountId, input);
    if (result.kind === 'demo_not_found') {
      res.status(404).json({ error: 'demo_not_found', message: 'This demo is not in this room.' });
      return;
    }
    if (result.kind === 'full') {
      res.status(409).json({ error: 'demo_marks_full', message: 'This demo has too many marks. Remove some first.' });
      return;
    }
    hub?.broadcast(project.id, result.mark.demo, { t: 'mark', demo: result.mark.demo, mark: result.mark });
    res.status(201).json({ mark: result.mark });
  });

  app.delete(/^\/rooms\/(.+)\/demo-marks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const accountId = person(req, res);
    if (!accountId) return;
    const project = await room(req, res);
    if (!project) return;
    const markId = routeParam(req, 1);
    const owner = MARK_ID.test(markId) ? await store.getDemoMarkOwner(project.id, markId) : null;
    if (!owner) {
      res.status(404).json({ error: 'demo_mark_not_found', message: 'This mark is already gone.' });
      return;
    }
    if (owner.accountId !== accountId && (await resolveRole(project, req.sessionAccount)) !== 'admin') {
      res.status(403).json({ error: 'demo_mark_not_yours', message: 'Only its author or a room admin can remove this mark.' });
      return;
    }
    if (await store.deleteDemoMark(project.id, markId)) {
      hub?.broadcast(project.id, owner.demo, { t: 'unmark', demo: owner.demo, id: markId });
    }
    res.status(204).end();
  });
}

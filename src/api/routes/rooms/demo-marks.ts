import type { Express, Response } from 'express';

import { DEMO_MARK_RATE_LIMITED_TEXT, isLiveDemoKey, parseDemoMarkInput } from '../../../../shared/live-demo.mjs';
import type { Project } from '../../db.js';
import * as databaseStore from '../../db/demo-marks.js';
import type { AuthenticatedRequest } from '../../http/helpers.js';
import { liveDemoAccess, type LiveDemoAccess } from '../../live-demos/access.js';
import type { LiveDemoHub } from '../../live-demos/hub.js';
import { CROSS_SITE_WRITE_REFUSED, isAppSession, isSameOriginCookieWrite } from '../../request/app-session.js';
import { resolveGitRoomProjectRole, type RoomAccessAccount } from '../../rooms/access.js';
import { routeParam } from './messages/helpers.js';

export interface DemoMarkWriteLimit {
  /** Saves and removals one account may make at once. */
  burst: number;
  /** How fast that allowance comes back. */
  perSecond: number;
  now?: () => number;
}

/** Per account, in this process: 20 at once, then 2 a second (120 a minute). */
export const DEMO_MARK_WRITE_LIMIT: Readonly<DemoMarkWriteLimit> = Object.freeze({ burst: 20, perSecond: 2 });

export interface DemoMarkRouteDeps {
  access?: Pick<LiveDemoAccess, 'findRoom' | 'canView'>;
  demoMarkStore?: Pick<typeof databaseStore, 'listDemoMarks' | 'createDemoMark' | 'getDemoMarkOwner' | 'deleteDemoMark'>;
  resolveProjectRole?: typeof resolveGitRoomProjectRole;
  /** Tells the demo's live viewers about a saved or removed mark. */
  liveDemoHub?: Pick<LiveDemoHub, 'broadcast'>;
  /**
   * The room for a reader that is not a person in the app (an agent's worker
   * bearer or sign-in), by the same check as reading the room's messages; it
   * answers the refusal itself. Without it, only people read marks.
   */
  participantRoom?: (req: AuthenticatedRequest, res: Response) => Promise<Project | null>;
  writeLimit?: DemoMarkWriteLimit;
}

const MARK_ID = /^[A-Za-z0-9_-]{8,64}$/;
const WRITE_LIMIT_ACCOUNTS = 10_000;

/** A decoded path part, or null for a malformed escape. */
function param(req: AuthenticatedRequest, index: number): string | null {
  try {
    return routeParam(req, index);
  } catch {
    return null;
  }
}

/** A token bucket per account. Returns 0 when the write may go, else the wait in ms. */
export function createDemoMarkWriteLimiter(limit: DemoMarkWriteLimit): (accountId: string) => number {
  const now = limit.now ?? Date.now;
  const buckets = new Map<string, { tokens: number; at: number }>();
  return (accountId) => {
    const at = now();
    const bucket = buckets.get(accountId) ?? { tokens: limit.burst, at };
    bucket.tokens = Math.min(limit.burst, bucket.tokens + ((at - bucket.at) / 1000) * limit.perSecond);
    bucket.at = at;
    // Most recent last, so the oldest is dropped first when the map is full.
    buckets.delete(accountId);
    buckets.set(accountId, bucket);
    if (buckets.size > WRITE_LIMIT_ACCOUNTS) buckets.delete(buckets.keys().next().value!);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - bucket.tokens) / limit.perSecond) * 1000);
  };
}

/**
 * Saved strokes and pins on an HTML demo, for a person in the app who can
 * read the room; the author or a room admin removes one. An agent that may
 * read the room's messages may read its marks too, so it can act on them; only
 * people save or remove marks. The person is
 * checked before the room is looked up, and a person who cannot read the room
 * gets the same plain refusal as the live socket, with no room name.
 */
export function registerDemoMarkRoutes(app: Express, deps: DemoMarkRouteDeps): void {
  const access = deps.access ?? liveDemoAccess;
  const store = deps.demoMarkStore ?? databaseStore;
  const resolveRole = deps.resolveProjectRole ?? resolveGitRoomProjectRole;
  const hub = deps.liveDemoHub;
  const takeWrite = createDemoMarkWriteLimiter(deps.writeLimit ?? DEMO_MARK_WRITE_LIMIT);

  const person = (req: AuthenticatedRequest, res: Response, write: boolean): RoomAccessAccount | null => {
    if (!isAppSession(req)) {
      res.status(req.authKind ? 403 : 401).json({ error: 'person_required', message: 'Sign in to LetAgents to see demo marks.' });
      return null;
    }
    if (write && !isSameOriginCookieWrite(req)) {
      res.status(403).json({ error: 'cross_site_write', message: CROSS_SITE_WRITE_REFUSED });
      return null;
    }
    const account = req.sessionAccount!;
    if (write) {
      const wait = takeWrite(account.account_id);
      if (wait > 0) {
        res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
        res.status(429).json({ error: 'demo_marks_rate_limited', message: DEMO_MARK_RATE_LIMITED_TEXT });
        return null;
      }
    }
    return account;
  };

  const room = async (req: AuthenticatedRequest, res: Response, account: RoomAccessAccount): Promise<Project | null> => {
    const roomId = param(req, 0);
    if (!roomId) {
      res.status(400).json({ error: 'invalid_room', message: 'The room id is not valid.' });
      return null;
    }
    const project = await access.findRoom(roomId);
    if (!project) {
      res.status(404).json({ error: 'room_not_found', message: 'Room not found.' });
      return null;
    }
    const view = await access.canView(project, account);
    if (view.decision === 'unavailable') {
      res.setHeader('Retry-After', '30');
      res.status(503).json({ error: 'repo_access_unavailable', message: 'GitHub did not answer the access check. Try again soon.' });
      return null;
    }
    if (view.decision !== 'allow') {
      res.status(403).json({ error: 'room_access_required', message: 'Only people who can open this room can see its demo marks.' });
      return null;
    }
    return project;
  };

  app.get(/^\/rooms\/(.+)\/demo-marks$/, async (req: AuthenticatedRequest, res) => {
    let project: Project | null;
    if (!isAppSession(req) && req.authKind && deps.participantRoom) {
      project = await deps.participantRoom(req, res);
    } else {
      const account = person(req, res, false);
      if (!account) return;
      project = await room(req, res, account);
    }
    if (!project) return;
    const demo = typeof req.query.demo === 'string' ? req.query.demo : '';
    if (!isLiveDemoKey(demo)) {
      res.status(400).json({ error: 'invalid_demo', message: 'Name the demo as <message id>/<attachment id>.' });
      return;
    }
    res.json({ marks: await store.listDemoMarks(project.id, demo) });
  });

  app.post(/^\/rooms\/(.+)\/demo-marks$/, async (req: AuthenticatedRequest, res) => {
    const account = person(req, res, true);
    if (!account) return;
    const project = await room(req, res, account);
    if (!project) return;
    const input = parseDemoMarkInput(req.body);
    if (!input) {
      res.status(400).json({ error: 'invalid_mark', message: 'This mark is not valid.' });
      return;
    }
    const result = await store.createDemoMark(project.id, account.account_id, input);
    if (result.kind === 'demo_not_found') {
      res.status(404).json({ error: 'demo_not_found', message: 'This demo is not in this room.' });
      return;
    }
    if (result.kind === 'exists') {
      // Saved before; its viewers already had the mark frame.
      res.status(200).json({ mark: result.mark });
      return;
    }
    if (result.kind === 'id_taken') {
      res.status(409).json({ error: 'demo_mark_id_taken', message: 'This mark id is taken.' });
      return;
    }
    if (result.kind === 'full') {
      res.status(409).json(result.reason === 'marks'
        ? { error: 'demo_marks_full', message: 'This demo has too many marks. Remove some first.' }
        : { error: 'demo_marks_too_large', message: 'The marks on this demo are too large. Remove some strokes first.' });
      return;
    }
    hub?.broadcast(project.id, result.mark.demo, { t: 'mark', demo: result.mark.demo, mark: result.mark });
    res.status(201).json({ mark: result.mark });
  });

  app.delete(/^\/rooms\/(.+)\/demo-marks\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    const account = person(req, res, true);
    if (!account) return;
    const project = await room(req, res, account);
    if (!project) return;
    const markId = param(req, 1) ?? '';
    const owner = MARK_ID.test(markId) ? await store.getDemoMarkOwner(project.id, markId) : null;
    if (!owner) {
      res.status(404).json({ error: 'demo_mark_not_found', message: 'This mark is already gone.' });
      return;
    }
    if (owner.accountId !== account.account_id && (await resolveRole(project, account)) !== 'admin') {
      res.status(403).json({ error: 'demo_mark_not_yours', message: 'Only its author or a room admin can remove this mark.' });
      return;
    }
    if (await store.deleteDemoMark(project.id, markId)) {
      hub?.broadcast(project.id, owner.demo, { t: 'unmark', demo: owner.demo, id: markId });
    }
    res.status(204).end();
  });
}

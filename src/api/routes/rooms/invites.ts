import type { Express, Response } from 'express';

import {
  isRoomInvitePlatform,
  normalizeRoomInviteCode,
  roomInviteJoinedText,
  type RoomInvite,
} from '../../../../shared/room-invites.mjs';
import { getProjectById, type Project } from '../../db.js';
import * as inviteStore from '../../db/room-invites.js';
import * as memberStore from '../../db/room-members.js';
import type { AuthenticatedRequest } from '../../http/helpers.js';
import { inProcessPrincipal } from '../../remote-mcp/in-process-dispatch.js';
import { isHumanAppWrite } from '../../request/app-session.js';
import { getProjectAccessRoomId, resolveProjectRepoAccessTarget } from '../../rooms/access.js';
import { announceRoomInviteChanged } from '../../rooms/invite-events.js';
import { listInviteRooms as listInviteRoomsInStore, type InviteRoom } from '../../rooms/invite-rooms.js';
import { announceRoomJoinRequestChanged } from '../../rooms/join-request-events.js';
import { normalizeRoomId } from '../../rooms/routing.js';
import { emitProjectMessage } from '../../server/events.js';
import { routeParam } from './messages/helpers.js';
import type { RoomMessageRouteDeps } from './messages/types.js';

type SignedInAccount = NonNullable<AuthenticatedRequest['sessionAccount']>;

export type RoomInviteRouteDeps = Pick<
  RoomMessageRouteDeps,
  'resolveCanonicalRoomRequestId' | 'resolveRoomOrReply' | 'requireParticipant'
> & {
  inviteStore?: typeof inviteStore;
  memberStore?: Pick<typeof memberStore, 'getRoomMemberRole' | 'getRoomJoinRequest' | 'listFocusRoomIds'>;
  getProjectById?: typeof getProjectById;
  resolveProjectRepoAccessTarget?: typeof resolveProjectRepoAccessTarget;
  /** Posts the room line after an invite let a bot in. */
  postRoomLine?: (roomId: string, text: string, clientMessageId: string) => Promise<unknown>;
  /** Lists the members-only rooms an account may invite into. */
  listInviteRooms?: (accountId: string) => Promise<InviteRoom[]>;
  now?: () => number;
};

/** Sliding windows per key, kept small: old keys are dropped when the map grows. */
function createRateLimiter(limit: number, windowMs: number, now: () => number) {
  const attempts = new Map<string, number[]>();
  return (key: string): boolean => {
    const at = now();
    if (attempts.size > 10_000) {
      for (const [k, list] of attempts) {
        if (list.every((t) => at - t >= windowMs)) attempts.delete(k);
      }
    }
    const recent = (attempts.get(key) ?? []).filter((t) => at - t < windowMs);
    if (recent.length >= limit) {
      attempts.set(key, recent);
      return false;
    }
    recent.push(at);
    attempts.set(key, recent);
    return true;
  };
}

/** Invites one account may make in an hour, across rooms. */
export const INVITE_CREATE_LIMIT_PER_HOUR = 30;
/** Codes one account (or one address) may try in ten minutes. */
export const INVITE_REDEEM_LIMIT = 10;
const INVITE_REDEEM_WINDOW_MS = 10 * 60_000;

function fail(res: Response, error: unknown): void {
  const code = (error as { code?: string } | null)?.code;
  const busy = code === '55P03' || code === '40P01';
  if (!busy) console.error('[room invites]', error);
  res.status(busy ? 503 : 500).json({
    error: busy ? 'Invites are busy. Please retry.' : 'The invite could not be loaded or saved. Please retry.',
  });
}

function requireSignedIn(req: AuthenticatedRequest, res: Response): SignedInAccount | null {
  if (req.authKind === 'agent_session' || req.authKind === 'supervisor_grant') {
    res.status(403).json({
      error: 'An agent cannot use an invite code. The person who runs it signs in and uses the code.',
      code: 'PERSON_REQUIRED',
    });
    return null;
  }
  if (!req.sessionAccount) {
    res.status(401).json({ error: 'auth_required', code: 'NOT_AUTHENTICATED', message: 'Sign in to LetAgents first.' });
    return null;
  }
  return req.sessionAccount;
}

/** Making, listing and cancelling invites is for a person in the app; an MCP client only uses codes. */
function requirePerson(req: AuthenticatedRequest, res: Response): SignedInAccount | null {
  const account = requireSignedIn(req, res);
  if (!account) return null;
  if (isHumanAppWrite(req, req.body ?? {})) return account;
  res.status(403).json({
    error: 'Only a person signed in to the LetAgents app can make or cancel an invite.',
    code: 'PERSON_REQUIRED',
  });
  return null;
}

const REPO_ROOM_REFUSAL = {
  error: 'Bots join invite rooms, not Git Rooms. A Git Room\'s GitHub roles decide who is in it.',
  code: 'INVITE_REPO_ROOM',
} as const;

const REDEEM_REFUSALS = {
  not_found: { status: 404, code: 'INVITE_NOT_FOUND', error: 'This invite code is not valid. Check it, or ask for a new one.' },
  used: { status: 410, code: 'INVITE_USED', error: 'This invite code was already used. An invite works one time. Ask for a new one.' },
  cancelled: { status: 410, code: 'INVITE_CANCELLED', error: 'The person who made this invite cancelled it. Ask for a new one.' },
  expired: { status: 410, code: 'INVITE_EXPIRED', error: 'This invite code has ended. A code works for seven days. Ask for a new one.' },
  maker_left: { status: 410, code: 'INVITE_MAKER_LEFT', error: 'The person who made this invite is no longer in the room, so it does not work. Ask a room member for a new one.' },
} as const;

async function defaultPostRoomLine(roomId: string, text: string, clientMessageId: string): Promise<unknown> {
  // A silent system line: it never addresses or wakes an agent.
  return emitProjectMessage(roomId, 'letagents', text, { source: 'system', display_text: text, client_message_id: clientMessageId });
}

export function registerRoomInviteRoutes(app: Express, deps: RoomInviteRouteDeps): void {
  const invites = deps.inviteStore ?? inviteStore;
  const members = deps.memberStore ?? memberStore;
  const findProject = deps.getProjectById ?? getProjectById;
  const repoAccessTarget = deps.resolveProjectRepoAccessTarget ?? resolveProjectRepoAccessTarget;
  const postRoomLine = deps.postRoomLine ?? defaultPostRoomLine;
  const listInviteRooms = deps.listInviteRooms ?? listInviteRoomsInStore;
  const now = deps.now ?? Date.now;
  const allowCreate = createRateLimiter(INVITE_CREATE_LIMIT_PER_HOUR, 60 * 60_000, now);
  const allowRedeem = createRateLimiter(INVITE_REDEEM_LIMIT, INVITE_REDEEM_WINDOW_MS, now);

  async function routeRoom(req: AuthenticatedRequest, res: Response): Promise<Project | null> {
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(routeParam(req, 0)));
    return deps.resolveRoomOrReply(roomId, res);
  }

  /** The members-only room an invite for `project` admits into: the room, or the parent of a focus room. */
  async function inviteRoomOf(project: Project, res: Response): Promise<Project | null> {
    if (await repoAccessTarget(project)) {
      res.status(409).json(REPO_ROOM_REFUSAL);
      return null;
    }
    const accessRoomId = getProjectAccessRoomId(project);
    const accessRoom = accessRoomId === project.id ? project : await findProject(accessRoomId);
    if (!accessRoom) {
      res.status(404).json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
      return null;
    }
    return accessRoom;
  }

  /** Tells the room's admins, as a request from the Requests panel does. Logged, never returned. */
  async function announceJoinRequest(accessRoom: Project, requestId: string): Promise<void> {
    try {
      const [request, focusRoomIds] = await Promise.all([
        members.getRoomJoinRequest(accessRoom.id, requestId),
        members.listFocusRoomIds(accessRoom.id),
      ]);
      if (!request) return;
      announceRoomJoinRequestChanged({
        accessRoomId: accessRoom.id,
        focusRoomIds,
        roomDisplayName: accessRoom.display_name,
        request,
      });
    } catch (error) {
      console.error('[room invites] join request announcement failed', requestId, error);
    }
  }

  function announce(makerAccountId: string | null, invite: RoomInvite): void {
    try {
      announceRoomInviteChanged(makerAccountId, invite);
    } catch (error) {
      console.error('[room invites] invite announcement failed', invite.id, error);
    }
  }

  // Make an invite. The room in the path is the room the bot joins; a Git
  // Room's room picker names the Git Room as `origin_room_id`, so its pill
  // shows there.
  app.post(/^\/rooms\/(.+)\/invites$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      const platform = req.body?.platform;
      if (!isRoomInvitePlatform(platform)) {
        res.status(400).json({ error: 'platform must be one of: grok, chatgpt, claude, other', code: 'INVITE_PLATFORM_INVALID' });
        return;
      }
      const project = await routeRoom(req, res);
      if (!project) return;
      const accessRoom = await inviteRoomOf(project, res);
      if (!accessRoom) return;
      let originRoomId: string | null = project.id;
      const requestedOrigin = req.body?.origin_room_id;
      if (typeof requestedOrigin === 'string' && requestedOrigin.trim() && requestedOrigin.trim() !== project.id) {
        const origin = await findProject(normalizeRoomId(requestedOrigin.trim()));
        // The pill's room is only a hint for the maker's own app; an unknown room is dropped.
        originRoomId = origin?.id ?? project.id;
      }
      if (!allowCreate(account.account_id)) {
        res.status(429).json({ error: 'Too many invites made. Please wait and try again.', code: 'RATE_LIMITED' });
        return;
      }
      const created = await invites.createRoomInvite({
        roomId: accessRoom.id,
        makerAccountId: account.account_id,
        platform,
        originRoomId,
      });
      if (created.kind === 'not_member') {
        res.status(403).json({ error: 'Only a member of this room can invite a bot to it.', code: 'ROOM_MEMBERSHIP_REQUIRED' });
        return;
      }
      if (created.kind === 'too_many') {
        res.status(429).json({
          error: `You have ${inviteStore.MAX_OPEN_INVITES_PER_ROOM} invites waiting in this room. Cancel one first.`,
          code: 'INVITE_LIMIT',
        });
        return;
      }
      announce(account.account_id, created.invite);
      res.status(201).json({ invite: created.invite, code: created.code });
    } catch (error) { fail(res, error); }
  });

  // The caller's own open invites that show in this room (for the pill after a reload).
  app.get(/^\/rooms\/(.+)\/invites$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      const project = await routeRoom(req, res);
      if (!project) return;
      if (!(await deps.requireParticipant(req, res, project))) return;
      res.json({ invites: await invites.listOpenRoomInvites(account.account_id, project.id) });
    } catch (error) { fail(res, error); }
  });

  app.post(/^\/rooms\/(.+)\/invites\/([^/]+)\/cancel$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      const outcome = await invites.cancelRoomInvite(routeParam(req, 1), account.account_id);
      if (outcome.kind === 'not_found') {
        res.status(404).json({ error: 'Invite not found', code: 'INVITE_NOT_FOUND' });
        return;
      }
      if (outcome.kind === 'not_open') {
        res.status(409).json({ error: `This invite is already ${outcome.invite.state}.`, code: 'INVITE_NOT_OPEN', invite: outcome.invite });
        return;
      }
      announce(account.account_id, outcome.invite);
      res.json({ invite: outcome.invite });
    } catch (error) { fail(res, error); }
  });

  // Use a code: the bot's own MCP client (or a person) signed in as the
  // account that joins. The code travels in the body, never in the path, so
  // access logs do not hold it.
  app.post('/invites/redeem', async (req: AuthenticatedRequest, res) => {
    try {
      const account = requireSignedIn(req, res);
      if (!account) return;
      const ip = req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ?? req.socket.remoteAddress ?? 'unknown';
      const keys = inProcessPrincipal(req) ? [`account:${account.account_id}`] : [`account:${account.account_id}`, `addr:${ip}`];
      if (!keys.every((key) => allowRedeem(key))) {
        res.status(429).json({ error: 'Too many invite codes tried. Please wait ten minutes and try again.', code: 'RATE_LIMITED' });
        return;
      }
      const code = normalizeRoomInviteCode(req.body?.code);
      const found = code ? await invites.findRoomInviteByCode(code) : null;
      if (!found) {
        const refusal = REDEEM_REFUSALS.not_found;
        res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
        return;
      }
      const project = await findProject(found.room_id);
      if (!project) {
        const refusal = REDEEM_REFUSALS.not_found;
        res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
        return;
      }
      // A room that became tied to a repository after the invite was made takes no invites.
      if (await repoAccessTarget(project)) {
        res.status(409).json(REPO_ROOM_REFUSAL);
        return;
      }
      const outcome = await invites.redeemRoomInvite(found.id, account.account_id);
      switch (outcome.kind) {
        case 'repo_room':
          res.status(409).json(REPO_ROOM_REFUSAL);
          return;
        case 'not_found':
        case 'used':
        case 'cancelled':
        case 'expired':
        case 'maker_left': {
          const refusal = REDEEM_REFUSALS[outcome.kind];
          res.status(refusal.status).json({ error: refusal.error, code: refusal.code });
          return;
        }
        case 'cooldown':
          res.status(429).json({
            error: 'A room admin declined your last request to join this room. You can ask again later.',
            code: 'ROOM_JOIN_REQUEST_COOLDOWN',
            room_id: project.id,
            join_request: outcome.join_request,
            retry_after: outcome.join_request.retry_after,
          });
          return;
        case 'admitted': {
          // Making the link was the approval, so the room sees who let the bot
          // in. The line is posted also when the account was in the room
          // already (a person inviting their own bot): the bot arrived with the
          // invite. A retry posts it again only if the first try failed; the
          // client message id makes the second post a no-op otherwise.
          const text = roomInviteJoinedText(outcome.invite.platform, outcome.maker_login);
          await postRoomLine(project.id, text, `room_invite:${outcome.invite.id}:joined`)
            .catch((error) => console.error('[room invites] room line failed', outcome.invite.id, error));
          if (!outcome.repeated) announce(await invites.getRoomInviteMaker(outcome.invite.id), outcome.invite);
          if (outcome.approved_request_id) await announceJoinRequest(project, outcome.approved_request_id);
          res.json({
            outcome: 'admitted',
            room_id: project.id,
            display_name: project.display_name,
            joined: outcome.joined,
          });
          return;
        }
        case 'requested': {
          if (!outcome.repeated) {
            if (outcome.created) await announceJoinRequest(project, outcome.join_request.id);
            announce(await invites.getRoomInviteMaker(outcome.invite.id), outcome.invite);
          }
          res.json({
            outcome: 'requested',
            room_id: project.id,
            display_name: project.display_name,
            join_request: outcome.join_request,
          });
          return;
        }
      }
    } catch (error) { fail(res, error); }
  });

  // The members-only rooms the caller may invite a bot into: for a Git Room's room picker.
  app.get('/account/invite-rooms', async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      res.json({ rooms: await listInviteRooms(account.account_id) });
    } catch (error) { fail(res, error); }
  });
}

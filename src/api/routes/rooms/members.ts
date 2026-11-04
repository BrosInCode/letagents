import type { Express, Response } from 'express';

import {
  REPO_ROOM_USES_GITHUB_ROLES,
  REPO_ROOM_USES_GITHUB_ROLES_MESSAGE,
  ROOM_MEMBER_ROLES,
  roomMembershipRequiredBody,
  type RoomMemberRole,
  type RoomMembershipState,
} from '../../../../shared/room-membership.mjs';
import { isMcpWorkerId } from '../../../shared/mcp-worker.js';
import { cancelAsk, endAsk, getAskById } from '../../agent-asks/store.js';
import { endRoomAgentSession, getProjectById, type Project } from '../../db.js';
import * as databaseStore from '../../db/room-members.js';
import type { AuthenticatedRequest } from '../../http/helpers.js';
import { isHumanAppWrite } from '../../request/app-session.js';
import { getProjectAccessRoomId, resolveProjectRepoAccessTarget } from '../../rooms/access.js';
import { disconnectRoomAgentDeliverySession } from '../../rooms/agent-delivery.js';
import { announceAgentSessionEnded } from '../../rooms/agent-process-connections.js';
import { closeRequestsOfRetiredAgent } from '../../rooms/attention-answers.js';
import { announceRoomMembershipEnded } from '../../rooms/membership-events.js';
import { normalizeRoomId } from '../../rooms/routing.js';
import { routeParam } from './messages/helpers.js';
import type { RoomMessageRouteDeps } from './messages/types.js';

type SignedInAccount = NonNullable<AuthenticatedRequest['sessionAccount']>;

export type RoomMemberRouteDeps = Pick<
  RoomMessageRouteDeps,
  'resolveCanonicalRoomRequestId' | 'resolveRoomOrReply' | 'requireParticipant'
> & {
  memberStore?: typeof databaseStore;
  getProjectById?: typeof getProjectById;
  resolveProjectRepoAccessTarget?: typeof resolveProjectRepoAccessTarget;
  /** Ends one agent session of a removed member, as a room admin would. */
  endMemberAgentSession?: (
    session: databaseStore.RemovedMemberAgentSession,
    person: SignedInAccount,
    options: { closeOpenRequests: boolean },
  ) => Promise<boolean>;
  /** Ends an agent ask of a removed member, with its grant and its agent. */
  endMemberAgentAsk?: (askId: string) => Promise<boolean>;
};

/** One room's membership context: the room asked for, and the room whose members decide. */
interface MemberRoom {
  project: Project;
  accessRoom: Project;
  managedBy: 'letagents' | 'github';
}

const JOIN_REQUEST_LIMIT_PER_HOUR = 20;
const joinRequestAttempts = new Map<string, number[]>();

function allowJoinRequestAttempt(accountId: string, now = Date.now()): boolean {
  if (joinRequestAttempts.size > 10_000) {
    for (const [key, attempts] of joinRequestAttempts) {
      if (attempts.every((at) => now - at >= 60 * 60_000)) joinRequestAttempts.delete(key);
    }
  }
  const recent = (joinRequestAttempts.get(accountId) ?? []).filter((at) => now - at < 60 * 60_000);
  if (recent.length >= JOIN_REQUEST_LIMIT_PER_HOUR) {
    joinRequestAttempts.set(accountId, recent);
    return false;
  }
  recent.push(now);
  joinRequestAttempts.set(accountId, recent);
  return true;
}

async function endAgentSessionAsRoomAdmin(
  session: databaseStore.RemovedMemberAgentSession,
  person: SignedInAccount,
  options: { closeOpenRequests: boolean },
): Promise<boolean> {
  const ended = await endRoomAgentSession({
    session_id: session.session_id,
    room_id: session.room_id,
    end_reason: 'room_admin',
  });
  if (!ended) return false;
  announceAgentSessionEnded(session.session_id);
  if (!isMcpWorkerId(ended.agent_instance_id)) {
    await disconnectRoomAgentDeliverySession({ room_id: session.room_id, agent_session_id: session.session_id });
  }
  // An admin who removes someone closes the agent's open requests, as the
  // admin disconnect does. A person who leaves posts nothing in the room.
  if (options.closeOpenRequests) {
    await closeRequestsOfRetiredAgent({
      room_id: session.room_id,
      agent_key: ended.agent_key,
      session_id: ended.session_id,
      person: { id: person.account_id, label: person.login, kind: 'human' },
    });
  }
  return true;
}

async function endAgentAskOfRemovedMember(askId: string): Promise<boolean> {
  const ask = await getAskById(askId);
  if (!ask) return false;
  if (ask.state === 'open' || ask.state === 'claimed') {
    if (await cancelAsk(ask)) return true;
    // The giver's agent joined in the meantime: the ask is live now, so end it.
    const live = await getAskById(askId);
    return live ? Boolean(await endAsk(live, 'removed')) : false;
  }
  return Boolean(await endAsk(ask, 'removed'));
}

function fail(res: Response, error: unknown): void {
  const code = (error as { code?: string } | null)?.code;
  // Lock timeout or a deadlock with a concurrent change: retrying is safe.
  const busy = code === '55P03' || code === '40P01';
  if (!busy) console.error('[room members]', error);
  res.status(busy ? 503 : 500).json({
    error: busy ? 'Room members are busy. Please retry.' : 'Room members could not be loaded or saved. Please retry.',
  });
}

/**
 * A person or their own MCP client may ask to join, read and leave. A worker
 * bearer or a supervisor grant acts for an agent, never for a person.
 */
function requireSignedIn(req: AuthenticatedRequest, res: Response): SignedInAccount | null {
  if (req.authKind === 'agent_session' || req.authKind === 'supervisor_grant') {
    res.status(403).json({ error: 'Agents cannot read or change room members.', code: 'PERSON_REQUIRED' });
    return null;
  }
  if (!req.sessionAccount) {
    res.status(401).json({ error: 'auth_required', code: 'NOT_AUTHENTICATED', message: 'Sign in to LetAgents first.' });
    return null;
  }
  return req.sessionAccount;
}

/**
 * Who is in a room, who asks to join it, and letting people in or out are for
 * a person signed in to the app. An agent must not read or change them, not
 * even with the token of an admin who owns it. An owner token (the MCP
 * client) may only ask to join, read its own state, and leave.
 */
function requirePerson(req: AuthenticatedRequest, res: Response): SignedInAccount | null {
  const account = requireSignedIn(req, res);
  if (!account) return null;
  if (isHumanAppWrite(req, req.body ?? {})) return account;
  res.status(403).json({
    error: 'Only a person signed in to the LetAgents app can see or change room members.',
    code: 'PERSON_REQUIRED',
  });
  return null;
}

export function registerRoomMemberRoutes(app: Express, deps: RoomMemberRouteDeps): void {
  const store = deps.memberStore ?? databaseStore;
  const findProject = deps.getProjectById ?? getProjectById;
  const repoAccessTarget = deps.resolveProjectRepoAccessTarget ?? resolveProjectRepoAccessTarget;
  const endMemberAgentSession = deps.endMemberAgentSession ?? endAgentSessionAsRoomAdmin;
  const endMemberAgentAsk = deps.endMemberAgentAsk ?? endAgentAskOfRemovedMember;

  async function memberRoom(req: AuthenticatedRequest, res: Response): Promise<MemberRoom | null> {
    const roomId = await deps.resolveCanonicalRoomRequestId(normalizeRoomId(routeParam(req, 0)));
    const project = await deps.resolveRoomOrReply(roomId, res);
    if (!project) return null;
    if (await repoAccessTarget(project)) {
      // The repository decides who may see this room, and so its name too.
      if (!(await deps.requireParticipant(req, res, project))) return null;
      return { project, accessRoom: project, managedBy: 'github' };
    }
    const accessRoomId = getProjectAccessRoomId(project);
    const accessRoom = accessRoomId === project.id ? project : await findProject(accessRoomId);
    if (!accessRoom) {
      res.status(404).json({ error: 'Room not found', code: 'ROOM_NOT_FOUND' });
      return null;
    }
    return { project, accessRoom, managedBy: 'letagents' };
  }

  function refuseRepoRoom(res: Response): void {
    res.status(409).json({ ...REPO_ROOM_USES_GITHUB_ROLES, message: REPO_ROOM_USES_GITHUB_ROLES_MESSAGE });
  }

  async function refuseNonMember(res: Response, room: MemberRoom, account: SignedInAccount): Promise<void> {
    res.status(403).json(roomMembershipRequiredBody({
      room_id: room.project.id,
      display_name: room.accessRoom.display_name,
      join_request: await store.getLatestRoomJoinRequest(room.accessRoom.id, account.account_id),
    }));
  }

  /** Resolves the room and the caller's role; answers the refusal when the caller is not a member. */
  async function requireMember(req: AuthenticatedRequest, res: Response, account: SignedInAccount) {
    const room = await memberRoom(req, res);
    if (!room) return null;
    if (room.managedBy === 'github') return { room, role: null };
    const role = await store.getRoomMemberRole(room.accessRoom.id, account.account_id);
    if (!role) {
      await refuseNonMember(res, room, account);
      return null;
    }
    return { room, role };
  }

  async function requireRoomAdmin(req: AuthenticatedRequest, res: Response, account: SignedInAccount): Promise<MemberRoom | null> {
    const member = await requireMember(req, res, account);
    if (!member) return null;
    if (member.room.managedBy === 'github') {
      refuseRepoRoom(res);
      return null;
    }
    if (member.role !== 'admin') {
      res.status(403).json({ error: 'Admin privileges required' });
      return null;
    }
    return member.room;
  }

  app.get(/^\/rooms\/(.+)\/membership$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requireSignedIn(req, res);
      if (!account) return;
      const room = await memberRoom(req, res);
      if (!room) return;
      const github = room.managedBy === 'github';
      const role = github ? null : await store.getRoomMemberRole(room.accessRoom.id, account.account_id);
      const state: RoomMembershipState = {
        room_id: room.project.id,
        access_room_id: room.accessRoom.id,
        display_name: room.accessRoom.display_name,
        managed_by: room.managedBy,
        member: github ? null : role !== null,
        role,
        join_request: github ? null : await store.getLatestRoomJoinRequest(room.accessRoom.id, account.account_id),
      };
      res.json(state);
    } catch (error) { fail(res, error); }
  });

  app.get(/^\/rooms\/(.+)\/members$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      const member = await requireMember(req, res, account);
      if (!member) return;
      const { room, role } = member;
      res.json({
        room_id: room.project.id,
        access_room_id: room.accessRoom.id,
        managed_by: room.managedBy,
        can_manage: role === 'admin',
        members: room.managedBy === 'github' ? [] : await store.listRoomMembers(room.accessRoom.id),
      });
    } catch (error) { fail(res, error); }
  });

  app.put(/^\/rooms\/(.+)\/members\/([^/]+)\/role$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      const role = req.body?.role as RoomMemberRole;
      if (!ROOM_MEMBER_ROLES.includes(role)) {
        res.status(400).json({ error: `role must be one of: ${ROOM_MEMBER_ROLES.join(', ')}` });
        return;
      }
      const room = await requireRoomAdmin(req, res, account);
      if (!room) return;
      const targetAccountId = routeParam(req, 1);
      const change = await store.setRoomMemberRole(room.accessRoom.id, targetAccountId, role, account.account_id);
      if (change.kind === 'forbidden') {
        res.status(403).json({ error: 'Admin privileges required' });
        return;
      }
      if (change.kind === 'not_member') {
        res.status(404).json({ error: 'That person is not a member of this room.', code: 'ROOM_MEMBER_NOT_FOUND' });
        return;
      }
      if (change.kind === 'last_admin') {
        res.status(409).json({ error: 'A room needs at least one admin. Make another member an admin first.', code: 'ROOM_LAST_ADMIN' });
        return;
      }
      res.json({ member: await store.getRoomMember(room.accessRoom.id, targetAccountId) });
    } catch (error) { fail(res, error); }
  });

  app.delete(/^\/rooms\/(.+)\/members\/([^/]+)$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requireSignedIn(req, res);
      if (!account) return;
      const targetAccountId = routeParam(req, 1);
      const leaving = targetAccountId === account.account_id;
      // Anyone may leave. Removing someone else needs an admin in the app.
      if (!leaving && !requirePerson(req, res)) return;
      const member = await requireMember(req, res, account);
      if (!member) return;
      if (member.room.managedBy === 'github') {
        refuseRepoRoom(res);
        return;
      }
      if (!leaving && member.role !== 'admin') {
        res.status(403).json({ error: 'Admin privileges required' });
        return;
      }
      const removal = await store.removeRoomMember(member.room.accessRoom.id, targetAccountId, account.account_id);
      if (removal.kind === 'forbidden') {
        res.status(403).json({ error: 'Admin privileges required' });
        return;
      }
      if (removal.kind === 'not_member') {
        res.status(404).json({ error: 'That person is not a member of this room.', code: 'ROOM_MEMBER_NOT_FOUND' });
        return;
      }
      if (removal.kind === 'last_admin') {
        res.status(409).json({
          error: leaving
            ? 'You are the only admin of this room. Make another member an admin before you leave.'
            : 'A room needs at least one admin. Make another member an admin first.',
          code: 'ROOM_LAST_ADMIN',
        });
        return;
      }
      // Their open streams in the room and its focus rooms close now.
      if (removal.login) announceRoomMembershipEnded(member.room.accessRoom.id, removal.login);
      // The person is out of the room, so their agents are too. A failure to
      // end one is logged; the membership change stands either way.
      let ended = 0;
      for (const session of removal.agent_sessions) {
        try {
          if (await endMemberAgentSession(session, account, { closeOpenRequests: !leaving })) ended += 1;
        } catch (error) {
          console.error('[room members] agent session of a removed member did not end', session.session_id, error);
        }
      }
      // An agent someone lent the person through an agent ask worked for them;
      // its ask ends, which ends the agent and revokes its grant.
      let endedAsks = 0;
      for (const askId of await store.liveAgentAskIdsForAsker(member.room.accessRoom.id, targetAccountId)) {
        try {
          if (await endMemberAgentAsk(askId)) endedAsks += 1;
        } catch (error) {
          console.error('[room members] agent ask of a removed member did not end', askId, error);
        }
      }
      res.json({ removed: true, account_id: targetAccountId, ended_agent_sessions: ended, ended_agent_asks: endedAsks });
    } catch (error) { fail(res, error); }
  });

  app.post(/^\/rooms\/(.+)\/join-requests$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requireSignedIn(req, res);
      if (!account) return;
      const room = await memberRoom(req, res);
      if (!room) return;
      if (room.managedBy === 'github') {
        refuseRepoRoom(res);
        return;
      }
      if (!allowJoinRequestAttempt(account.account_id)) {
        res.status(429).json({ error: 'Too many requests to join rooms. Please wait and try again.', code: 'RATE_LIMITED' });
        return;
      }
      const creation = await store.createRoomJoinRequest(room.accessRoom.id, account.account_id);
      switch (creation.kind) {
        case 'member':
          res.status(409).json({ error: 'You are already a member of this room.', code: 'ROOM_ALREADY_MEMBER' });
          return;
        case 'cooldown':
          res.status(429).json({
            error: 'A room admin declined your last request. You can ask again later.',
            code: 'ROOM_JOIN_REQUEST_COOLDOWN',
            join_request: creation.join_request,
            retry_after: creation.join_request.retry_after,
          });
          return;
        case 'pending':
          res.json({ join_request: creation.join_request });
          return;
        case 'created':
          res.status(201).json({ join_request: creation.join_request });
          return;
      }
    } catch (error) { fail(res, error); }
  });

  app.get(/^\/rooms\/(.+)\/join-requests$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      const state = req.query?.state === 'all' ? 'all' : 'pending';
      const room = await requireRoomAdmin(req, res, account);
      if (!room) return;
      res.json({
        room_id: room.project.id,
        access_room_id: room.accessRoom.id,
        join_requests: await store.listRoomJoinRequests(room.accessRoom.id, state),
      });
    } catch (error) { fail(res, error); }
  });

  app.post(/^\/rooms\/(.+)\/join-requests\/([^/]+)\/(approve|decline)$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      const room = await requireRoomAdmin(req, res, account);
      if (!room) return;
      const decision = routeParam(req, 2) === 'approve' ? 'approved' : 'declined';
      const outcome = await store.decideRoomJoinRequest({
        roomId: room.accessRoom.id,
        requestId: routeParam(req, 1),
        decision,
        deciderAccountId: account.account_id,
      });
      if (outcome.kind === 'forbidden') {
        res.status(403).json({ error: 'Admin privileges required' });
        return;
      }
      if (outcome.kind === 'not_found') {
        res.status(404).json({ error: 'Join request not found', code: 'ROOM_JOIN_REQUEST_NOT_FOUND' });
        return;
      }
      if (outcome.kind === 'not_pending') {
        res.status(409).json({
          error: `This request is already ${outcome.join_request.state}.`,
          code: 'ROOM_JOIN_REQUEST_NOT_PENDING',
          join_request: outcome.join_request,
        });
        return;
      }
      res.json({
        join_request: outcome.join_request,
        ...(decision === 'approved'
          ? { member: await store.getRoomMember(room.accessRoom.id, outcome.join_request.account_id) }
          : {}),
      });
    } catch (error) { fail(res, error); }
  });

  app.post(/^\/rooms\/(.+)\/join-requests\/([^/]+)\/cancel$/, async (req: AuthenticatedRequest, res) => {
    try {
      const account = requireSignedIn(req, res);
      if (!account) return;
      const room = await memberRoom(req, res);
      if (!room) return;
      if (room.managedBy === 'github') {
        refuseRepoRoom(res);
        return;
      }
      const outcome = await store.cancelRoomJoinRequest(room.accessRoom.id, routeParam(req, 1), account.account_id);
      if (outcome.kind === 'not_found') {
        res.status(404).json({ error: 'Join request not found', code: 'ROOM_JOIN_REQUEST_NOT_FOUND' });
        return;
      }
      if (outcome.kind === 'not_pending') {
        res.status(409).json({
          error: `This request is already ${outcome.join_request.state}.`,
          code: 'ROOM_JOIN_REQUEST_NOT_PENDING',
          join_request: outcome.join_request,
        });
        return;
      }
      res.json({ join_request: outcome.join_request });
    } catch (error) { fail(res, error); }
  });

  app.get('/account/room-join-requests', async (req: AuthenticatedRequest, res) => {
    try {
      const account = requirePerson(req, res);
      if (!account) return;
      res.json({ join_requests: await store.listPendingJoinRequestsForAdmin(account.account_id) });
    } catch (error) { fail(res, error); }
  });
}

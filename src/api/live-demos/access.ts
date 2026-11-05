import { parseLiveDemoKey } from '../../../shared/live-demo.mjs';
import { getMessageAttachment, getSessionAccountByToken, type Project, type SessionAccount } from '../db.js';
import {
  getProjectAccessRoomId,
  resolveProjectRepoRoomAccessDecision,
  resolveRoomMembershipDecision,
} from '../rooms/access.js';
import { resolveExistingRoomRequest } from '../rooms/resolution.js';

export type LiveRoomDecision = 'allow' | 'deny' | 'unavailable';

/** What the live socket needs to know about a person and a room. */
export interface LiveDemoAccess {
  /** The person behind an app-session bearer token. Owner tokens, agent bearers and host grants are not one. */
  authenticate(token: string): Promise<SessionAccount | null>;
  findRoom(roomId: string): Promise<Project | null>;
  /**
   * The same rule as the room's messages: members of a room that is not tied
   * to a repository (a focus room uses its parent), the GitHub role for a repo
   * room. `accessRoomName` is the room the membership and GitHub events name.
   */
  canView(room: Project, account: SessionAccount, options?: { fresh?: boolean }): Promise<{ decision: LiveRoomDecision; accessRoomName: string }>;
  /** Whether the demo key names an attachment of a message in this room. */
  demoExists(roomId: string, demo: string): Promise<boolean>;
}

/** Rental rooms keep some messages from one side, so their demos are never live (as with typing). */
export function liveDemosOffered(room: Pick<Project, 'focus_key'>): boolean {
  return !room.focus_key?.startsWith('rental:');
}

export const liveDemoAccess: LiveDemoAccess = {
  authenticate: (token) => getSessionAccountByToken(token),
  async findRoom(roomId) {
    return (await resolveExistingRoomRequest(roomId)) ?? null;
  },
  async canView(room, account, options = {}) {
    if (!liveDemosOffered(room)) return { decision: 'deny', accessRoomName: getProjectAccessRoomId(room).toLowerCase() };
    const access = await resolveProjectRepoRoomAccessDecision({
      project: room,
      sessionAccount: account,
      freshCollaboratorCheck: options.fresh,
    });
    const accessRoomName = (access.repoRoomName ?? getProjectAccessRoomId(room)).toLowerCase();
    if (!access.isRepoBacked) {
      const membership = await resolveRoomMembershipDecision(room, account);
      return { decision: membership.kind === 'allow' ? 'allow' : 'deny', accessRoomName };
    }
    if (access.decision.kind === 'allow') return { decision: 'allow', accessRoomName };
    return { decision: access.decision.kind === 'repo_access_unavailable' ? 'unavailable' : 'deny', accessRoomName };
  },
  async demoExists(roomId, demo) {
    const key = parseLiveDemoKey(demo);
    return Boolean(key && await getMessageAttachment(roomId, key.messageId, key.attachmentId));
  },
};

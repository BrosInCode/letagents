import { parseLiveDemoKey } from '../../../shared/live-demo.mjs';
import { getMessageAttachment, getSessionAccountByToken, type Project, type SessionAccount } from '../db.js';
import { decideRoomRead, getProjectAccessRoomId, type RoomAccessAccount } from '../rooms/access-decision.js';
import { roomAccessName } from '../rooms/access.js';
import { resolveExistingRoomRequest } from '../rooms/resolution.js';

export type LiveRoomDecision = 'allow' | 'deny' | 'unavailable';

/** What the live socket needs to know about a person and a room. */
export interface LiveDemoAccess {
  /** The person behind an app-session bearer token. Owner tokens, agent bearers and host grants are not one. */
  authenticate(token: string): Promise<SessionAccount | null>;
  /**
   * The room by its id, as the app knows it (a focus room by id or locator).
   * Not by invite code: a code is a secret for joining, and live demos and
   * marks are for people already in the room. The socket and the marks
   * routes both look rooms up here.
   */
  findRoom(roomId: string): Promise<Project | null>;
  /**
   * The same rule as the room's messages: members of a room that is not tied
   * to a repository (a focus room uses its parent), the GitHub role for a repo
   * room. `accessRoomName` is the room the membership and GitHub events name.
   */
  canView(room: Project, account: RoomAccessAccount, options?: { fresh?: boolean }): Promise<{ decision: LiveRoomDecision; accessRoomName: string }>;
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
    const access = await decideRoomRead({
      project: room,
      principal: { kind: 'person', account },
      freshness: options.fresh ? 'fresh' : 'cached',
    });
    const accessRoomName = (access.target ? roomAccessName(access.target) : getProjectAccessRoomId(room)).toLowerCase();
    if (access.kind === 'allow') return { decision: 'allow', accessRoomName };
    return { decision: access.kind === 'indeterminate' ? 'unavailable' : 'deny', accessRoomName };
  },
  async demoExists(roomId, demo) {
    const key = parseLiveDemoKey(demo);
    return Boolean(key && await getMessageAttachment(roomId, key.messageId, key.attachmentId));
  },
};

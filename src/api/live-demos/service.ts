import type { Server } from 'node:http';

import { githubRepoAccessInvalidationEvents } from '../github/repo-access.js';
import { roomMembershipInvalidationEvents } from '../rooms/membership-events.js';
import { liveDemoAccess } from './access.js';
import { createLiveDemoHub } from './hub.js';
import { attachLiveDemoSockets } from './sockets.js';

/** The process's one hub. The marks routes broadcast through it. */
export const liveDemoHub = createLiveDemoHub({ demoExists: liveDemoAccess.demoExists });

function invalidation(payload: unknown, roomKey: 'roomId' | 'roomName') {
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  return {
    accessRoomName: typeof value[roomKey] === 'string' ? (value[roomKey] as string).toLowerCase() : null,
    login: typeof value.login === 'string' ? value.login.toLowerCase() : null,
  };
}

/**
 * Serves `GET /rooms/<room>/live` on the API's HTTP server. A person removed
 * from a room, or whose GitHub access changed, is re-checked at once rather
 * than at the next periodic check. Returns the shutdown step.
 */
export function startLiveDemoSockets(server: Server): () => Promise<void> {
  const sockets = attachLiveDemoSockets(server, { access: liveDemoAccess, hub: liveDemoHub });
  const onMembership = (payload: unknown) => {
    const match = invalidation(payload, 'roomId');
    // Only an exact room and person: a broad event must not re-check everyone.
    if (match.accessRoomName && match.login) sockets.recheckWhere(match);
  };
  const onRepoAccess = (payload: unknown) => {
    const match = invalidation(payload, 'roomName');
    if (match.accessRoomName || match.login) sockets.recheckWhere(match);
  };
  roomMembershipInvalidationEvents.on('invalidate', onMembership);
  githubRepoAccessInvalidationEvents.on('invalidate', onRepoAccess);
  return async () => {
    roomMembershipInvalidationEvents.off('invalidate', onMembership);
    githubRepoAccessInvalidationEvents.off('invalidate', onRepoAccess);
    await sockets.close();
  };
}



/**
 * The room refused the worker bearer itself (HTTP 401 or 403), as opposed to
 * a transport or server failure that the same bearer may survive.
 */
export class SupervisedRoomAuthorizationError extends Error {
  constructor(message: string, readonly status: 401 | 403) {
    super(message);
    this.name = "SupervisedRoomAuthorizationError";
  }
}

/**
 * Shown while the room refuses the agent's bearer. It says what the daemon
 * knows and names no cause or remedy: the server answers an expired bearer
 * and a session a room admin ended identically, and a restarted runtime is
 * given the same bearer while that bearer has time left.
 */
export const ROOM_REFUSED_ACCESS_DETAIL = "The room refused this agent's access, so it is not receiving room messages.";

export const SUCCESSFUL_POLL_PACE_MS = 25;
/**
 * The longest a lane holds its polls for a rotated bearer. After it, the lane
 * polls with the bearer it holds, and a refusal shows as one.
 */
export const BEARER_ROTATION_HOLD_MS = 60_000;
export const BEARER_ROTATION_WAIT_STEP_MS = 250;
export const POLL_ERROR_BACKOFF_BASE_MS = 250;
export const POLL_ERROR_BACKOFF_CAP_MS = 30_000;

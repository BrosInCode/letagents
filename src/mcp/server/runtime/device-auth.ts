import {
  getPendingDeviceAuth,
  setPendingDeviceAuth,
  type PendingDeviceAuthState,
} from "../../local-state.js";
import {
  ApiError,
  apiCall,
  parseApiErrorPayload,
  resolveApiPath,
} from "./api.js";

/**
 * A room answered 401 auth_required: this runtime has no sign-in the room
 * accepts. Every room needs one (repo rooms and rooms without a repository),
 * so the device flow starts the same way for each.
 */
export class RepoRoomAuthRequiredError extends Error {
  readonly roomId: string;
  readonly pendingAuth: PendingDeviceAuthState;

  constructor(roomId: string, pendingAuth: PendingDeviceAuthState) {
    super(
      `Room '${roomId}' requires sign-in. Device flow started: open ${pendingAuth.verification_uri} and enter code ${pendingAuth.user_code}, then run poll_device_auth.`
    );
    this.name = "RepoRoomAuthRequiredError";
    this.roomId = roomId;
    this.pendingAuth = pendingAuth;
  }
}

export async function startPendingDeviceAuth(
  roomId: string,
  deviceFlowUrl?: string
): Promise<PendingDeviceAuthState> {
  const existing = getPendingDeviceAuth();
  if (existing?.suggested_room_id === roomId) {
    return existing;
  }

  const response = await apiCall<{
    request_id: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  }>(resolveApiPath(deviceFlowUrl), {
    method: "POST",
  });

  return setPendingDeviceAuth({
    request_id: response.request_id,
    user_code: response.user_code,
    verification_uri: response.verification_uri,
    interval_seconds: response.interval,
    expires_at: new Date(Date.now() + response.expires_in * 1000).toISOString(),
    started_at: new Date().toISOString(),
    suggested_room_id: roomId,
  });
}

export async function maybeHandleRepoRoomAuthRequired(error: unknown, roomId: string): Promise<void> {
  const payload = parseApiErrorPayload(error);
  // A saved sign-in the room just rejected (expired, revoked) is gone now, so
  // the same call starts the device flow instead of answering raw 401 text.
  if (!(error instanceof ApiError) || error.status !== 401
    || (payload?.error !== "auth_required" && !error.savedSignInRejected)) {
    return;
  }

  const pendingAuth = await startPendingDeviceAuth(
    roomId,
    typeof payload?.device_flow_url === "string" ? payload.device_flow_url : undefined
  );

  throw new RepoRoomAuthRequiredError(roomId, pendingAuth);
}

export function toRepoRoomAuthRequiredResult(error: RepoRoomAuthRequiredError): Record<string, unknown> {
  // The request id is left out: whoever polls with it after the person
  // approves receives the token, and any room tool may now return this result.
  // poll_device_auth reads it from local state.
  const { request_id: _requestId, ...pendingAuth } = error.pendingAuth;
  return {
    success: false,
    error: "auth_required",
    room_id: error.roomId,
    next_step: "poll_device_auth",
    pending_device_auth: pendingAuth,
    message: error.message,
  };
}

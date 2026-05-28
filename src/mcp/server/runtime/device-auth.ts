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

export class RepoRoomAuthRequiredError extends Error {
  readonly roomId: string;
  readonly pendingAuth: PendingDeviceAuthState;

  constructor(roomId: string, pendingAuth: PendingDeviceAuthState) {
    super(
      `Repo room '${roomId}' requires authentication. Device flow started: open ${pendingAuth.verification_uri} and enter code ${pendingAuth.user_code}, then run poll_device_auth.`
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
  if (!(error instanceof ApiError) || error.status !== 401 || payload?.error !== "auth_required") {
    return;
  }

  const pendingAuth = await startPendingDeviceAuth(
    roomId,
    typeof payload.device_flow_url === "string" ? payload.device_flow_url : undefined
  );

  throw new RepoRoomAuthRequiredError(roomId, pendingAuth);
}

export function toRepoRoomAuthRequiredResult(error: RepoRoomAuthRequiredError): Record<string, unknown> {
  return {
    success: false,
    error: "auth_required",
    room_id: error.roomId,
    next_step: "poll_device_auth",
    pending_device_auth: error.pendingAuth,
    message: error.message,
  };
}

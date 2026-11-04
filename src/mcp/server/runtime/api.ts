import { clearAuthenticatedAccountCache } from "./auth-cache.js";
import { currentWorkerCall } from "../../worker-call-context.js";
import {
  roomAccessRefusal,
  type RoomJoinRequestSummary,
} from "../../../../shared/room-membership.mjs";
import {
  AGENT_SESSION_ENDED_ERROR,
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../../shared/request-headers.js";
import { endStoredAgentSession } from "../../local-state/agent-sessions.js";
import { getDaemonToolExecutionContext } from "./daemon-tool-context.js";
import { currentSessionScope, requireScopeWhenHosted, scopedValue } from "./session-scope.js";
import { requireValidWorkerBearerRuntime } from "./worker-bearer.js";
import {
  borrowCurrentSupervisedWorkerCredential,
  type SupervisedCredentialBorrowResult,
} from "./supervisor-bridge.js";

type OwnerAuthStore = Pick<typeof import("../../local-state.js"), "clearStoredAuth" | "getStoredAuth">;

let ownerAuthStoreLoader: () => Promise<OwnerAuthStore> = () => import("../../local-state.js");
let supervisedCredentialBorrower: () => Promise<SupervisedCredentialBorrowResult> =
  () => borrowCurrentSupervisedWorkerCredential();

export function setOwnerAuthStoreLoaderForTest(
  loader: (() => Promise<OwnerAuthStore>) | null,
): void {
  ownerAuthStoreLoader = loader ?? (() => import("../../local-state.js"));
}

export function setSupervisedCredentialBorrowerForTest(
  borrower: (() => Promise<SupervisedCredentialBorrowResult>) | null,
): void {
  supervisedCredentialBorrower = borrower ?? (() => borrowCurrentSupervisedWorkerCredential());
}

export class SupervisedWorkerCredentialError extends Error {
  constructor(readonly code: "SUPERVISED_CREDENTIAL_UNAVAILABLE" | "SUPERVISED_CREDENTIAL_STALE") {
    super(code === "SUPERVISED_CREDENTIAL_UNAVAILABLE"
      ? "The daemon-supervised worker credential is not available yet."
      : "The daemon-supervised worker credential is stale or missing its exact context.");
    this.name = "SupervisedWorkerCredentialError";
  }
}

async function getSupervisedCredential(): Promise<string> {
  const daemonContext = getDaemonToolExecutionContext();
  if (daemonContext) return daemonContext.bearer;
  const result = await supervisedCredentialBorrower();
  if (result.state === "available") return result.credential;
  throw new SupervisedWorkerCredentialError(
    result.state === "deferred" ? "SUPERVISED_CREDENTIAL_UNAVAILABLE" : "SUPERVISED_CREDENTIAL_STALE",
  );
}

export const API_URL = (process.env.LETAGENTS_API_URL || "http://localhost:3001").replace(/\/+$/, "");

export function getApiUrl(): string {
  // In a remote session this names the public origin for links and keys only;
  // requests never go to it (see apiCall).
  const scope = currentSessionScope();
  if (scope) return scope.publicBaseUrl;
  return getDaemonToolExecutionContext()?.apiUrl.replace(/\/+$/, "") ?? API_URL;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  /** This 401 rejected the saved sign-in, which is now forgotten. */
  savedSignInRejected = false;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export type RoomAccessRefusalKind = "membership_required" | "repo_collaborator_required";

/**
 * A 403 from a members-only room. The sign-in is good, but the account is not
 * a member (a room without a repository) or has no GitHub role on the
 * repository (a public repo room). Asking again cannot help until an admin
 * lets the account in, so tools answer with it instead of retrying.
 */
export class RoomAccessRefusedError extends ApiError {
  readonly refusal: RoomAccessRefusalKind;
  readonly roomId: string | null;
  readonly displayName: string | null;
  readonly joinRequest: RoomJoinRequestSummary | null;
  readonly serverMessage: string | null;

  constructor(status: number, body: string, refusal: RoomAccessRefusalKind, payload: Record<string, unknown>) {
    super(status, body);
    this.name = "RoomAccessRefusedError";
    this.refusal = refusal;
    this.roomId = typeof payload.room_id === "string" ? payload.room_id : null;
    this.displayName = typeof payload.display_name === "string" ? payload.display_name : null;
    this.joinRequest = payload.join_request && typeof payload.join_request === "object"
      ? payload.join_request as RoomJoinRequestSummary
      : null;
    this.serverMessage = typeof payload.message === "string" ? payload.message : null;
  }
}

// The room that last refused this runtime, so request_room_access can default
// to it. Per session in a remote scope, per process otherwise.
const lastRefusedRoom = scopedValue<string | null>("last-refused-room", () => null);

export function getLastRefusedRoomId(): string | null {
  return lastRefusedRoom.get();
}

function apiErrorFor(status: number, body: string): ApiError {
  if (status !== 403) return new ApiError(status, body);
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new ApiError(status, body);
  }
  const refusal = roomAccessRefusal(payload);
  if (!refusal) return new ApiError(status, body);
  const error = new RoomAccessRefusedError(status, body, refusal, payload as Record<string, unknown>);
  if (error.roomId) lastRefusedRoom.set(error.roomId);
  return error;
}

/** Whether this runtime acts for a LetAgents account, without reading a token. */
export async function hasLetagentsCredential(): Promise<boolean> {
  if (currentSessionScope()) return true;
  return Boolean(await getLetagentsToken());
}

export async function getLetagentsToken(): Promise<string> {
  if (currentSessionScope()) {
    // A remote session's identity is bound to its in-process dispatcher.
    throw new Error("A remote MCP session has no token to read.");
  }
  requireScopeWhenHosted("An MCP token");
  const runtime = requireValidWorkerBearerRuntime();
  if (runtime.mode === "worker") {
    return runtime.bearer;
  }
  if (runtime.mode === "supervised") return getSupervisedCredential();

  const envToken = process.env.LETAGENTS_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const { getStoredAuth } = await ownerAuthStoreLoader();
  return getStoredAuth()?.token || "";
}

export async function getAuthorizationHeader(): Promise<string | null> {
  const letagentsToken = await getLetagentsToken();
  return letagentsToken ? `Bearer ${letagentsToken}` : null;
}

export function isMissingRouteError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.status === 405) &&
    /Cannot (GET|POST|PATCH)|Not Found|Cannot GET \/rooms|Cannot POST \/rooms/i.test(error.body)
  );
}

export function parseApiErrorPayload(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiError)) {
    return null;
  }

  try {
    const parsed = JSON.parse(error.body) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveApiPath(urlOrPath: string | undefined): string {
  if (!urlOrPath) {
    return "/auth/device/start";
  }

  try {
    const apiUrl = getApiUrl();
    const parsed = new URL(urlOrPath, `${apiUrl}/`);
    const apiBase = new URL(`${apiUrl}/`);
    if (parsed.origin !== apiBase.origin) {
      return "/auth/device/start";
    }

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/auth/device/start";
  }
}

/**
 * The room says the session this request was made for has ended. Record it,
 * so that the next registration starts a session instead of answering from
 * the one the room no longer has.
 */
function forgetEndedSession(headers: Headers, body: unknown): void {
  let sessionId = headers.get(LETAGENTS_AGENT_SESSION_ID_HEADER);
  let sessionToken = headers.get(LETAGENTS_AGENT_SESSION_TOKEN_HEADER);
  if ((!sessionId || !sessionToken) && typeof body === "string") {
    try {
      const sent = JSON.parse(body) as { agent_session_id?: unknown; agent_session_token?: unknown };
      if (typeof sent.agent_session_id === "string") sessionId = sent.agent_session_id;
      if (typeof sent.agent_session_token === "string") sessionToken = sent.agent_session_token;
    } catch {
      // Not a request that names a session.
    }
  }
  if (!sessionId || !sessionToken) return;
  try {
    endStoredAgentSession(sessionId, new Date().toISOString(), sessionToken);
  } catch {
    // The error the agent is about to see tells it what to do.
  }
}

const BUSY_RETRY_DELAYS_MS = [1_000, 2_000] as const;

/**
 * For a request the room may turn away only because it is busy for a moment,
 * and that changed nothing when it was turned away. The room answers 503 when
 * another registration is still committing; asking again shortly succeeds.
 */
export async function apiCallWhenFree<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await apiCall<T>(path, options);
    } catch (error) {
      const delay = BUSY_RETRY_DELAYS_MS[attempt];
      if (!(error instanceof ApiError) || error.status !== 503 || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function apiCall<T = unknown>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const scope = currentSessionScope();
  if (scope) {
    // The API's own routes, in process, as the session's account. Any caller
    // Authorization header is dropped: the dispatcher alone sets identity.
    headers.delete("Authorization");
    const res = await scope.dispatch(path, { ...options, headers });
    const body = await res.text();
    if (!res.ok) {
      if (res.status === 401 && body.includes(AGENT_SESSION_ENDED_ERROR)) forgetEndedSession(headers, options?.body);
      throw apiErrorFor(res.status, body);
    }
    return (body ? JSON.parse(body) : null) as T;
  }

  const runtime = requireValidWorkerBearerRuntime();
  let sentOwnerToken: string | null = null;
  if (runtime.mode === "worker") {
    // The bearer is the complete worker credential. Normalize headers first so
    // every caller spelling of Authorization is overwritten.
    headers.set("Authorization", `Bearer ${runtime.bearer}`);
  } else if (runtime.mode === "supervised") {
    // Resolve on every API request: the daemon may rotate the in-memory
    // credential while Codex remains running.
    headers.set("Authorization", `Bearer ${await getSupervisedCredential()}`);
  } else {
    const ownerToken = await getLetagentsToken();
    if (ownerToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${ownerToken}`);
      sentOwnerToken = ownerToken;
    }
  }

  const res = await fetch(`${getApiUrl()}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    let savedSignInRejected = false;
    const hasWorkerCredential = currentWorkerCall() || headers.has(LETAGENTS_AGENT_SESSION_TOKEN_HEADER)
      || (typeof options?.body === "string" && /"(?:agent_session_token|replace_agent_session_token|connection_token)"\s*:/.test(options.body));
    if (res.status === 401 && sentOwnerToken && requireValidWorkerBearerRuntime().mode === "owner"
      && !hasWorkerCredential && !body.includes(AGENT_SESSION_ENDED_ERROR)) {
      // A real 401: the server turned away the owner token this request
      // carried. Forget it only when it is the saved sign-in; LETAGENTS_TOKEN
      // stays in the environment. A signed-in account that may not open a
      // room gets a 403 (private repo, not a member), which keeps the sign-in.
      const { clearStoredAuth, getStoredAuth } = await ownerAuthStoreLoader();
      const saved = getStoredAuth()?.token;
      if (saved === sentOwnerToken) {
        clearStoredAuth();
        savedSignInRejected = true;
      } else if (!saved && !process.env.LETAGENTS_TOKEN?.trim()) {
        // The saved token was sent, and a call that ran at the same time
        // has already forgotten it.
        savedSignInRejected = true;
      }
      clearAuthenticatedAccountCache();
    }
    if (res.status === 401 && body.includes(AGENT_SESSION_ENDED_ERROR)) {
      forgetEndedSession(headers, options?.body);
    }
    const error = apiErrorFor(res.status, body);
    error.savedSignInRejected = savedSignInRejected;
    throw error;
  }

  const body = await res.text();
  if (!body) {
    return null as T;
  }

  return JSON.parse(body) as T;
}

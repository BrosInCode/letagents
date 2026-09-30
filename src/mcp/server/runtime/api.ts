import { clearAuthenticatedAccountCache } from "./auth-cache.js";
import { currentWorkerCall } from "../../worker-call-context.js";
import {
  AGENT_SESSION_ENDED_ERROR,
  LETAGENTS_AGENT_SESSION_ID_HEADER,
  LETAGENTS_AGENT_SESSION_TOKEN_HEADER,
} from "../../../shared/request-headers.js";
import { endStoredAgentSession } from "../../local-state/agent-sessions.js";
import { getDaemonToolExecutionContext } from "./daemon-tool-context.js";
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
  return getDaemonToolExecutionContext()?.apiUrl.replace(/\/+$/, "") ?? API_URL;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`API error ${status}: ${body}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export async function getLetagentsToken(): Promise<string> {
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

  const runtime = requireValidWorkerBearerRuntime();
  if (runtime.mode === "worker") {
    // The bearer is the complete worker credential. Normalize headers first so
    // every caller spelling of Authorization is overwritten.
    headers.set("Authorization", `Bearer ${runtime.bearer}`);
  } else if (runtime.mode === "supervised") {
    // Resolve on every API request: the daemon may rotate the in-memory
    // credential while Codex remains running.
    headers.set("Authorization", `Bearer ${await getSupervisedCredential()}`);
  } else {
    const authorizationHeader = await getAuthorizationHeader();
    if (authorizationHeader && !headers.has("Authorization")) {
      headers.set("Authorization", authorizationHeader);
    }
  }

  const res = await fetch(`${getApiUrl()}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.text();
    const hasWorkerCredential = currentWorkerCall() || headers.has(LETAGENTS_AGENT_SESSION_TOKEN_HEADER)
      || (typeof options?.body === "string" && /"(?:agent_session_token|replace_agent_session_token|connection_token)"\s*:/.test(options.body));
    if (res.status === 401 && requireValidWorkerBearerRuntime().mode === "owner" && !hasWorkerCredential) {
      // Only clear on 401 (invalid/expired credential), NOT on 403
      // (valid credential but insufficient permissions, e.g., private repo access)
      const { clearStoredAuth } = await ownerAuthStoreLoader();
      clearStoredAuth();
      clearAuthenticatedAccountCache();
    }
    if (res.status === 401 && body.includes(AGENT_SESSION_ENDED_ERROR)) {
      forgetEndedSession(headers, options?.body);
    }
    throw new ApiError(res.status, body);
  }

  const body = await res.text();
  if (!body) {
    return null as T;
  }

  return JSON.parse(body) as T;
}

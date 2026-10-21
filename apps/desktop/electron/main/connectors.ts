import type {
  TrackerApiTokenInput,
  TrackerConnectionList,
  TrackerConnectionPatch,
  TrackerConnectionTestResult,
  TrackerConnectionView,
  TrackerOAuthStart,
  TrackerProvider,
} from "../../../../shared/ticket-connectors.mjs";
import { apiFetch } from "./auth.js";
import { openAllowedExternalUrl } from "./external-url.js";

/** The only hosts a tracker sign-in may open in the browser. */
const TRACKER_AUTHORIZE_HOSTS = ["auth.atlassian.com", "linear.app"] as const;
const CONNECTION_ID = /^tcon_[0-9a-f-]{36}$/;

function provider(value: unknown): TrackerProvider {
  if (value !== "jira" && value !== "linear") throw new Error("Choose Jira or Linear.");
  return value;
}

function connectionPath(id: unknown): string {
  if (typeof id !== "string" || !CONNECTION_ID.test(id)) throw new Error("Choose a tracker connection.");
  return `/account/connectors/${id}`;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export function listTrackerConnections(): Promise<TrackerConnectionList> {
  return apiFetch<TrackerConnectionList>("/account/connectors");
}

/** Start OAuth and open the tracker's consent page in the system browser. */
export async function startTrackerOAuth(value: unknown): Promise<{ expires_at: string }> {
  const start = await apiFetch<TrackerOAuthStart>(`/account/connectors/oauth/${provider(value)}/start`, { method: "POST" });
  await openAllowedExternalUrl(start.authorize_url, TRACKER_AUTHORIZE_HOSTS);
  return { expires_at: start.expires_at };
}

export async function saveTrackerApiToken(input: TrackerApiTokenInput): Promise<TrackerConnectionView> {
  const body: TrackerApiTokenInput = {
    provider: provider(input?.provider),
    api_token: String(input?.api_token ?? ""),
    ...(input?.provider === "jira" ? { site_url: String(input.site_url ?? ""), email: String(input.email ?? "") } : {}),
  };
  const result = await apiFetch<{ connection: TrackerConnectionView }>("/account/connectors/api-token", json("POST", body));
  return result.connection;
}

export function testTrackerConnection(id: unknown): Promise<TrackerConnectionTestResult> {
  return apiFetch<TrackerConnectionTestResult>(`${connectionPath(id)}/test`, { method: "POST" }, { timeoutMs: 45_000 });
}

export async function updateTrackerConnection(id: unknown, patch: TrackerConnectionPatch): Promise<TrackerConnectionView> {
  const body: TrackerConnectionPatch = {};
  if (patch?.display_name !== undefined) body.display_name = String(patch.display_name);
  if (patch?.status_map !== undefined) body.status_map = patch.status_map;
  if (patch?.jev_linking_enabled !== undefined) body.jev_linking_enabled = patch.jev_linking_enabled === true;
  const result = await apiFetch<{ connection: TrackerConnectionView }>(connectionPath(id), json("PATCH", body));
  return result.connection;
}

export async function removeTrackerConnection(id: unknown): Promise<void> {
  await apiFetch<{ deleted: boolean }>(connectionPath(id), { method: "DELETE" });
}

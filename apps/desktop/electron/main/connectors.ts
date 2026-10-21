import type {
  TrackerApiTokenInput,
  TrackerConnectionList,
  TrackerConnectionPatch,
  TrackerConnectionTestResult,
  TrackerConnectionView,
  TrackerOAuthStart,
  TrackerProvider,
  TrackerRuleInput,
  TrackerRuleList,
  TrackerRuleVersionView,
  TrackerRuleView,
  TrackerWebhookSetup,
} from "../../../../shared/ticket-connectors.mjs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

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

/** The path the server's OAuth callback forwards the browser to on this computer. */
export const TRACKER_OAUTH_LOOPBACK_PATH = "/tracker-oauth/callback";
const OAUTH_WAIT_MS = 10 * 60_000;

let activeOAuth: { cancel(): void } | null = null;

function loopbackPage(title: string, detail: string): string {
  // Fixed text only: nothing from the request is reflected.
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
    + "<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}</style>"
    + `</head><body><h1>${title}</h1><p>${detail}</p></body></html>`;
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * Connect a tracker with OAuth. The browser approves access; the server's
 * callback forwards the code to a listener on 127.0.0.1 that only this app
 * opened, and this app finishes with its own session. A sign-in link that
 * reaches another computer cannot connect anyone's tracker to this account.
 */
export async function connectTrackerWithOAuth(value: unknown): Promise<TrackerConnectionView> {
  const trackerProvider = provider(value);
  activeOAuth?.cancel();
  const server = createServer();
  const port = await listenOnLoopback(server);
  let settle: { resolve(view: TrackerConnectionView): void; reject(error: Error): void } | null = null;
  const result = new Promise<TrackerConnectionView>((resolve, reject) => { settle = { resolve, reject }; });
  const finish = (outcome: TrackerConnectionView | Error) => {
    if (!settle) return;
    const current = settle;
    settle = null;
    clearTimeout(timer);
    server.close();
    if (activeOAuth === handle) activeOAuth = null;
    if (outcome instanceof Error) current.reject(outcome);
    else current.resolve(outcome);
  };
  const handle = { cancel: () => finish(new Error("Tracker sign-in was cancelled.")) };
  const timer = setTimeout(() => finish(new Error("Tracker sign-in timed out. Start again.")), OAUTH_WAIT_MS);
  activeOAuth = handle;

  let expectedState: string | null = null;
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reply = (status: number, title: string, detail: string) => {
      res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end(loopbackPage(title, detail));
    };
    if (req.method !== "GET" || url.pathname !== TRACKER_OAUTH_LOOPBACK_PATH || !expectedState
      || url.searchParams.get("state") !== expectedState) {
      reply(404, "Not found", "This address only finishes a tracker sign-in that the LetAgents app started.");
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      reply(400, "Connection cancelled", "The tracker did not grant access. You can close this window.");
      finish(new Error("The tracker did not grant access."));
      return;
    }
    void apiFetch<{ connection: TrackerConnectionView }>(
      `/account/connectors/oauth/${trackerProvider}/complete`,
      json("POST", { state: expectedState, code }),
    ).then((response) => {
      reply(200, "Connected", "The tracker is connected to LetAgents. You can close this window and return to the app.");
      finish(response.connection);
    }, (error: unknown) => {
      reply(502, "Connection failed", "LetAgents could not finish connecting the tracker. Return to the app and try again.");
      finish(error instanceof Error ? error : new Error("Tracker sign-in failed."));
    });
  });

  try {
    const start = await apiFetch<TrackerOAuthStart>(
      `/account/connectors/oauth/${trackerProvider}/start`,
      json("POST", { loopback_port: port }),
    );
    expectedState = new URL(start.authorize_url).searchParams.get("state");
    if (!expectedState) throw new Error("The server returned a sign-in link without a state.");
    await openAllowedExternalUrl(start.authorize_url, TRACKER_AUTHORIZE_HOSTS);
  } catch (error) {
    finish(error instanceof Error ? error : new Error("Tracker sign-in could not start."));
  }
  return result;
}

export function cancelTrackerOAuth(): void {
  activeOAuth?.cancel();
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

export function getTrackerWebhookSetup(id: unknown): Promise<TrackerWebhookSetup> {
  return apiFetch<TrackerWebhookSetup>(`${connectionPath(id)}/webhook`);
}

const RULE_ID = /^trule_[0-9a-f-]{36}$/;

function rulePath(connectionId: unknown, ruleId?: unknown): string {
  const base = `${connectionPath(connectionId)}/rules`;
  if (ruleId === undefined) return base;
  if (typeof ruleId !== "string" || !RULE_ID.test(ruleId)) throw new Error("Choose a rule.");
  return `${base}/${ruleId}`;
}

/** The rule as the editor built it. The server validates it strictly. */
function ruleBody(input: TrackerRuleInput): TrackerRuleInput {
  return {
    name: String(input?.name ?? ""),
    room_id: typeof input?.room_id === "string" && input.room_id ? input.room_id : null,
    ...(typeof input?.enabled === "boolean" ? { enabled: input.enabled } : {}),
    trigger: input?.trigger,
    actions: Array.isArray(input?.actions) ? input.actions : [],
  };
}

export function listTrackerRules(connectionId: unknown): Promise<TrackerRuleList> {
  return apiFetch<TrackerRuleList>(rulePath(connectionId));
}

export async function createTrackerRule(connectionId: unknown, input: TrackerRuleInput): Promise<TrackerRuleView> {
  return (await apiFetch<{ rule: TrackerRuleView }>(rulePath(connectionId), json("POST", ruleBody(input)))).rule;
}

export async function updateTrackerRule(connectionId: unknown, ruleId: unknown, input: TrackerRuleInput): Promise<TrackerRuleView> {
  return (await apiFetch<{ rule: TrackerRuleView }>(rulePath(connectionId, ruleId), json("PUT", ruleBody(input)))).rule;
}

export async function setTrackerRuleEnabled(connectionId: unknown, ruleId: unknown, enabled: unknown): Promise<TrackerRuleView> {
  return (await apiFetch<{ rule: TrackerRuleView }>(`${rulePath(connectionId, ruleId)}/enabled`, json("POST", { enabled: enabled === true }))).rule;
}

export async function listTrackerRuleVersions(connectionId: unknown, ruleId: unknown): Promise<TrackerRuleVersionView[]> {
  return (await apiFetch<{ versions: TrackerRuleVersionView[] }>(`${rulePath(connectionId, ruleId)}/versions`)).versions;
}

export async function rollbackTrackerRule(connectionId: unknown, ruleId: unknown, version: unknown): Promise<TrackerRuleView> {
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) throw new Error("Choose a version.");
  return (await apiFetch<{ rule: TrackerRuleView }>(`${rulePath(connectionId, ruleId)}/rollback`, json("POST", { version }))).rule;
}

export async function removeTrackerRule(connectionId: unknown, ruleId: unknown): Promise<void> {
  await apiFetch<{ deleted: boolean }>(rulePath(connectionId, ruleId), { method: "DELETE" });
}

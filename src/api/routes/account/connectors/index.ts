import { createHash, randomBytes } from "node:crypto";

import type { Express, Response } from "express";

import {
  JEV_LINKING_DISCLOSURE,
  isTrackerProvider,
  type TrackerConnectionList,
  type TrackerConnectionTestResult,
  type TrackerOAuthStart,
  type TrackerProvider,
} from "../../../../../shared/ticket-connectors.mjs";
import {
  type ConnectionService,
  connectorErrorText,
  createConnectionService,
  toConnectionView,
} from "../../../connectors/connections.js";
import { type ConnectorCipher, ConnectorDecryptError, loadConnectorCipher } from "../../../connectors/crypto.js";
import {
  buildTrackerAuthorizeUrl,
  exchangeTrackerCode,
  getTrackerOAuthConfig,
  listAtlassianResources,
} from "../../../connectors/oauth.js";
import { createWorkItemProviders, type WorkItemProviders } from "../../../connectors/providers/index.js";
import { TrackerProviderError, type TrackerCredentials } from "../../../connectors/providers/types.js";
import { isAtlassianCloudId, normalizeJiraSiteUrl, TrackerSiteUrlError } from "../../../connectors/site-url.js";
import { parseStatusMap, remainingUnmapped } from "../../../connectors/status-map.js";
import { trackerConnectionStore, type TrackerConnectionStore } from "../../../connectors/store.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { parseBearerAuthorization } from "../../../request/bearer-authorization.js";

export const TRACKER_OAUTH_STATE_TTL_MS = 10 * 60_000;
const TEST_ITEM_LIMIT = 5;
const MAX_SECRET_LENGTH = 4_096;

export interface ConnectorRouteDeps {
  store: TrackerConnectionStore;
  /** Null when LETAGENTS_CONNECTOR_SECRET_KEY is missing: every route answers 503. */
  cipher: ConnectorCipher | null;
  providers: WorkItemProviders;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function defaultConnectorRouteDeps(): ConnectorRouteDeps {
  return {
    store: trackerConnectionStore,
    cipher: loadConnectorCipher(),
    providers: createWorkItemProviders(),
  };
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function providerParam(req: AuthenticatedRequest): TrackerProvider | null {
  const value = (req.params as Record<string, string>).provider;
  return isTrackerProvider(value) ? value : null;
}

function idParam(req: AuthenticatedRequest): string {
  return String((req.params as Record<string, string>).id ?? "").trim();
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

/**
 * Connector routes act for the signed-in human only: a desktop session or an
 * owner token sent as a bearer. Agent and supervisor credentials are refused,
 * and cookie-only requests are refused so no other site can drive them.
 */
function requireAccount(req: AuthenticatedRequest, res: Response): string | null {
  const bearer = parseBearerAuthorization(req.headers.authorization).kind === "token";
  if (!req.sessionAccount || !bearer || (req.authKind !== "owner_token" && req.authKind !== "session")) {
    res.status(req.authKind ? 403 : 401).json({ error: "Sign in to LetAgents to manage ticket connections." });
    return null;
  }
  return req.sessionAccount.account_id;
}

function sendProviderError(res: Response, error: unknown): void {
  if (error instanceof TrackerSiteUrlError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof TrackerProviderError && error.outcome === "auth") {
    res.status(400).json({ error: "The tracker refused these credentials. Check them and try again." });
  } else if (error instanceof TrackerProviderError) {
    res.status(502).json({ error: connectorErrorText(error) });
  } else {
    console.error("Ticket connector request failed:", connectorErrorText(error));
    res.status(500).json({ error: "The tracker connection could not be saved." });
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]!);
}

function sendCallbackPage(res: Response, status: number, title: string, detail: string): void {
  res.status(status)
    .set({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    })
    .type("html")
    .send(`<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>`
      + "<style>body{font:16px system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}</style>"
      + `</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`);
}

async function oauthCredentials(
  provider: TrackerProvider,
  code: string,
  deps: ConnectorRouteDeps,
): Promise<{ credentials: TrackerCredentials; site: { key: string; url: string | null; name: string } | null }> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const config = getTrackerOAuthConfig(provider, env);
  if (!config) throw new TrackerProviderError("definite", "OAuth for this tracker is not set up on this server.");
  const tokens = await exchangeTrackerCode(provider, config, code, fetchImpl, deps.now?.() ?? new Date());
  if (provider === "linear") {
    return { credentials: { kind: "oauth", ...tokens }, site: null };
  }
  const resources = await listAtlassianResources(tokens.access_token, fetchImpl);
  // One connection per Jira site; with several, the first is connected and
  // the user can connect again to choose another (follow-up).
  const resource = resources.find((entry) => isAtlassianCloudId(entry.id));
  if (!resource) throw new TrackerProviderError("definite", "This Atlassian account has no Jira site that LetAgents can use.");
  const siteUrl = normalizeJiraSiteUrl(resource.url, env);
  return {
    credentials: { kind: "oauth", cloud_id: resource.id, site_url: siteUrl, ...tokens },
    site: { key: new URL(siteUrl).hostname, url: siteUrl, name: resource.name },
  };
}

export function registerConnectorRoutes(app: Express, deps: ConnectorRouteDeps = defaultConnectorRouteDeps()): void {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  if (!deps.cipher) {
    console.warn("LETAGENTS_CONNECTOR_SECRET_KEY is not set or invalid; ticket connector routes answer 503.");
  }
  const service: ConnectionService | null = deps.cipher
    ? createConnectionService({ store: deps.store, cipher: deps.cipher, providers: deps.providers })
    : null;

  /** The service, or a 503 when the server has no connector key. */
  function ready(res: Response): ConnectionService | null {
    if (!service) {
      res.status(503).json({ error: "Ticket connectors are not configured on this server." });
      return null;
    }
    return service;
  }

  async function ownedRow(req: AuthenticatedRequest, res: Response, accountId: string) {
    const row = await deps.store.get(idParam(req));
    if (!row || row.account_id !== accountId) {
      res.status(404).json({ error: "Tracker connection not found." });
      return null;
    }
    return row;
  }

  app.get("/account/connectors", async (req: AuthenticatedRequest, res) => {
    if (!ready(res)) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const rows = await deps.store.list(accountId);
    const body: TrackerConnectionList = {
      connections: rows.map(toConnectionView),
      providers: {
        jira: { oauth: Boolean(getTrackerOAuthConfig("jira", env)), api_token: true },
        linear: { oauth: Boolean(getTrackerOAuthConfig("linear", env)), api_token: true },
      },
      jev_linking_disclosure: JEV_LINKING_DISCLOSURE,
    };
    res.json(body);
  });

  app.post("/account/connectors/oauth/:provider/start", async (req: AuthenticatedRequest, res) => {
    if (!ready(res)) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const provider = providerParam(req);
    if (!provider) {
      res.status(404).json({ error: "Unknown tracker." });
      return;
    }
    const config = getTrackerOAuthConfig(provider, env);
    if (!config) {
      res.status(409).json({ error: "OAuth for this tracker is not set up on this server. Use an API token instead." });
      return;
    }
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now().getTime() + TRACKER_OAUTH_STATE_TTL_MS).toISOString();
    await deps.store.createOAuthState({ state_hash: hashOAuthState(state), account_id: accountId, provider, expires_at: expiresAt });
    const body: TrackerOAuthStart = { authorize_url: buildTrackerAuthorizeUrl(provider, config, state), expires_at: expiresAt };
    res.json(body);
  });

  // The tracker redirects the user's browser here. The browser carries no
  // LetAgents credential; the single-use state names the account.
  app.get("/account/connectors/oauth/:provider/callback", async (req: AuthenticatedRequest, res) => {
    const connections = service;
    if (!connections) {
      sendCallbackPage(res, 503, "Ticket connectors are off", "This LetAgents server is not configured for ticket connectors.");
      return;
    }
    const provider = providerParam(req);
    const state = boundedString(req.query.state, 512);
    if (!provider || !state) {
      sendCallbackPage(res, 400, "Connection failed", "This link is not a valid tracker sign-in. Start again from LetAgents settings.");
      return;
    }
    // Consume first: a state is good for one attempt, success or not.
    const owner = await deps.store.consumeOAuthState(hashOAuthState(state), provider);
    if (!owner) {
      sendCallbackPage(res, 400, "Connection failed", "This sign-in link expired or was already used. Start again from LetAgents settings.");
      return;
    }
    if (req.query.error !== undefined) {
      sendCallbackPage(res, 400, "Connection cancelled", "The tracker did not grant access. You can close this window.");
      return;
    }
    const code = boundedString(req.query.code, 2_048);
    if (!code) {
      sendCallbackPage(res, 400, "Connection failed", "The tracker sent no authorization code. Start again from LetAgents settings.");
      return;
    }
    try {
      const { credentials, site } = await oauthCredentials(provider, code, deps);
      const row = await connections.connect({ account_id: owner.account_id, provider, auth_kind: "oauth", credentials, site });
      sendCallbackPage(res, 200, "Connected", `${row.display_name} is connected to LetAgents. You can close this window and return to the app.`);
    } catch (error) {
      console.error("Ticket connector OAuth callback failed:", connectorErrorText(error, [code]));
      sendCallbackPage(res, 502, "Connection failed", "LetAgents could not finish connecting the tracker. Start again from LetAgents settings.");
    }
  });

  app.post("/account/connectors/api-token", async (req: AuthenticatedRequest, res) => {
    const connections = ready(res);
    if (!connections) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = isTrackerProvider(body.provider) ? body.provider : null;
    const token = boundedString(body.api_token, MAX_SECRET_LENGTH);
    if (!provider || !token) {
      res.status(400).json({ error: "Choose a tracker and enter an API token." });
      return;
    }
    try {
      let credentials: TrackerCredentials;
      let site: { key: string; url: string; name: string } | null = null;
      if (provider === "jira") {
        const email = boundedString(body.email, 320);
        if (!email || !email.includes("@")) {
          res.status(400).json({ error: "Enter the Atlassian account email that owns the API token." });
          return;
        }
        const siteUrl = normalizeJiraSiteUrl(body.site_url, env);
        const host = new URL(siteUrl).hostname;
        credentials = { kind: "api_token", site_url: siteUrl, email, api_token: token };
        site = { key: host, url: siteUrl, name: host.replace(/\.atlassian\.net$/, "") };
      } else {
        credentials = { kind: "api_token", api_key: token };
      }
      const row = await connections.connect({ account_id: accountId, provider, auth_kind: "api_token", credentials, site });
      res.status(201).json({ connection: toConnectionView(row) });
    } catch (error) {
      sendProviderError(res, error);
    }
  });

  app.post("/account/connectors/:id/test", async (req: AuthenticatedRequest, res) => {
    const connections = ready(res);
    if (!connections) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const row = await ownedRow(req, res, accountId);
    if (!row) return;
    let result: TrackerConnectionTestResult;
    try {
      const conn = connections.open(row);
      const items = await deps.providers[row.provider as TrackerProvider].listItems(conn, null, {
        assigneeMe: true,
        limit: TEST_ITEM_LIMIT,
      });
      await deps.store.addUnmapped(row.id, [...new Set(items.filter((item) => item.unmapped).map((item) => item.raw_status))]);
      await deps.store.setStatus(row.id, "active", null, true);
      result = {
        ok: true,
        connection: toConnectionView((await deps.store.get(row.id)) ?? row),
        items: items.map((item) => ({
          key: item.key,
          title: item.title,
          raw_status: item.raw_status,
          ticket_state: item.ticket_state,
          unmapped: item.unmapped,
          url: item.url,
        })),
        error: null,
      };
    } catch (error) {
      const text = error instanceof ConnectorDecryptError ? error.message : await connections.recordFailure(row, error);
      if (error instanceof ConnectorDecryptError) await deps.store.setStatus(row.id, "needs_reauth", text);
      result = { ok: false, connection: toConnectionView((await deps.store.get(row.id)) ?? row), items: [], error: text };
    }
    res.json(result);
  });

  app.patch("/account/connectors/:id", async (req: AuthenticatedRequest, res) => {
    if (!ready(res)) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const row = await ownedRow(req, res, accountId);
    if (!row) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Parameters<TrackerConnectionStore["update"]>[2] = {};
    if (body.display_name !== undefined) {
      const name = boundedString(body.display_name, 120);
      if (!name) {
        res.status(400).json({ error: "The name must be 1 to 120 characters." });
        return;
      }
      patch.display_name = name;
    }
    if (body.status_map !== undefined) {
      const parsed = parseStatusMap(body.status_map);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      patch.status_map = parsed.map;
      patch.unmapped_statuses = remainingUnmapped(parsed.map, Array.isArray(row.unmapped_statuses) ? row.unmapped_statuses : []);
    }
    if (body.jev_linking_enabled !== undefined) {
      if (typeof body.jev_linking_enabled !== "boolean") {
        res.status(400).json({ error: "jev_linking_enabled must be true or false." });
        return;
      }
      patch.jev_linking_enabled = body.jev_linking_enabled;
    }
    if (!Object.keys(patch).length) {
      res.status(400).json({ error: "Nothing to change." });
      return;
    }
    const updated = await deps.store.update(row.id, accountId, patch);
    if (!updated) {
      res.status(404).json({ error: "Tracker connection not found." });
      return;
    }
    res.json({ connection: toConnectionView(updated) });
  });

  app.delete("/account/connectors/:id", async (req: AuthenticatedRequest, res) => {
    if (!ready(res)) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const deleted = await deps.store.delete(idParam(req), accountId);
    if (!deleted) {
      res.status(404).json({ error: "Tracker connection not found." });
      return;
    }
    res.json({ deleted: true });
  });
}

import { createHash, randomBytes } from "node:crypto";

import type { Express, Response } from "express";

import {
  CONNECTORS_NOT_CONFIGURED_CODE,
  CONNECTORS_NOT_CONFIGURED_MESSAGE,
  JEV_LINKING_DISCLOSURE,
  isTrackerProvider,
  type TrackerConnectionList,
  type TrackerConnectionTestResult,
  type TrackerOAuthStart,
  type TrackerProvider,
  type TrackerWebhookSetup,
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
  connectorPublicBaseUrl,
  exchangeTrackerCode,
  createPkcePair,
  getTrackerOAuthConfig,
  listAtlassianResources,
  trackerOAuthMissingBaseUrl,
} from "../../../connectors/oauth.js";
import { normalizeGitHubRepo } from "../../../connectors/key-detectors.js";
import { defaultGitHubAppDirectory, GitHubAccessRefusedError, type GitHubAppDirectory } from "../../../connectors/providers/github.js";
import { createWorkItemProviders, type WorkItemProviders } from "../../../connectors/providers/index.js";
import { TrackerProviderError, type TrackerCredentials } from "../../../connectors/providers/types.js";
import { isAtlassianCloudId, normalizeJiraSiteUrl, TrackerSiteUrlError } from "../../../connectors/site-url.js";
import { parseStatusMap, remainingUnmapped } from "../../../connectors/status-map.js";
import { trackerConnectionStore, type TrackerConnectionStore } from "../../../connectors/store.js";
import { hasGitHubAppConfig } from "../../../github/config.js";
import type { AuthenticatedRequest } from "../../../http/helpers.js";
import { parseBearerAuthorization } from "../../../request/bearer-authorization.js";

export const TRACKER_OAUTH_STATE_TTL_MS = 10 * 60_000;
/** Where the callback sends the browser: the starting app's loopback listener. */
export const TRACKER_OAUTH_LOOPBACK_PATH = "/tracker-oauth/callback";
const CONNECT_ATTEMPTS_PER_WINDOW = 10;
const CONNECT_ATTEMPT_WINDOW_MS = 10 * 60_000;
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
  /** Where GitHub Issues finds the App's installations; defaults to the server's records. */
  githubDirectory?: Pick<GitHubAppDirectory, "repositoryInstallation">;
  /** Whether the server has a GitHub App to read GitHub Issues with. */
  githubAppConfigured?: () => Promise<boolean>;
}

export function defaultConnectorRouteDeps(): ConnectorRouteDeps {
  return {
    store: trackerConnectionStore,
    cipher: loadConnectorCipher(),
    providers: createWorkItemProviders(),
  };
}

const GITHUB_APP_WEBHOOK_TEXT = "GitHub Issues uses the LetAgents GitHub App's own webhook. There is nothing to set up.";

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

/** A tracker that signs in with OAuth. GitHub Issues uses the GitHub App, so it is unknown here. */
function providerParam(req: AuthenticatedRequest): TrackerProvider | null {
  const value = (req.params as Record<string, string>).provider;
  return isTrackerProvider(value) && value !== "github" ? value : null;
}

function idParam(req: AuthenticatedRequest): string {
  return String((req.params as Record<string, string>).id ?? "").trim();
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

/**
 * Connector routes act for the signed-in human only: the desktop app's session
 * sent as a bearer. Owner tokens (what MCP agents carry), worker bearers and
 * supervisor grants are refused, so no agent can add a connection, read
 * tickets with it, or turn on Jev consent. Cookie-only requests are refused so
 * no other site can drive these routes.
 */
export function requireAccount(req: AuthenticatedRequest, res: Response): string | null {
  const bearer = parseBearerAuthorization(req.headers.authorization).kind === "token";
  if (!req.sessionAccount || !bearer || req.authKind !== "session") {
    res.status(req.authKind ? 403 : 401).json({ error: "Sign in to the LetAgents app to manage connectors." });
    return null;
  }
  return req.sessionAccount.account_id;
}

/** At most `limit` attempts per key in a sliding window; in memory, per process. */
export function createAttemptLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const attempts = new Map<string, number[]>();
  return (key: string): boolean => {
    const cutoff = now() - windowMs;
    const recent = (attempts.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= limit) {
      attempts.set(key, recent);
      return false;
    }
    recent.push(now());
    attempts.set(key, recent);
    if (attempts.size > 10_000) {
      for (const [entry, times] of attempts) if (!times.some((at) => at > cutoff)) attempts.delete(entry);
    }
    return true;
  };
}

function parseLoopbackPort(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : null;
}

function sendProviderError(res: Response, error: unknown): void {
  if (error instanceof TrackerSiteUrlError) {
    res.status(400).json({ error: error.message });
  } else if (error instanceof GitHubAccessRefusedError) {
    res.status(403).json({ error: error.message });
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

/** The Jira site's https origin for links, or null. OAuth calls never use it. */
function displaySiteUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

async function oauthCredentials(
  provider: TrackerProvider,
  code: string,
  codeVerifier: string | null,
  deps: ConnectorRouteDeps,
): Promise<{ credentials: TrackerCredentials; site: { key: string; url: string | null; name: string } | null }> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const config = getTrackerOAuthConfig(provider, env);
  if (!config) throw new TrackerProviderError("definite", "OAuth for this tracker is not set up on this server.");
  const tokens = await exchangeTrackerCode(provider, config, code, fetchImpl, deps.now?.() ?? new Date(), codeVerifier);
  if (provider === "linear") {
    return { credentials: { kind: "oauth", ...tokens }, site: null };
  }
  const resources = await listAtlassianResources(tokens.access_token, fetchImpl);
  // One connection per Jira site; with several, the first is connected and
  // the user can connect again to choose another (follow-up).
  const resource = resources.find((entry) => isAtlassianCloudId(entry.id));
  if (!resource) throw new TrackerProviderError("definite", "This Atlassian account has no Jira site that LetAgents can use.");
  // OAuth calls go to api.atlassian.com/ex/jira/{cloud_id}; the site URL is
  // only shown and used in links, so a custom domain is fine.
  const siteUrl = displaySiteUrl(resource.url);
  return {
    credentials: { kind: "oauth", cloud_id: resource.id, site_url: siteUrl ?? "", ...tokens },
    site: { key: siteUrl ? new URL(siteUrl).hostname : `cloud:${resource.id}`, url: siteUrl, name: resource.name },
  };
}

export function registerConnectorRoutes(app: Express, deps: ConnectorRouteDeps = defaultConnectorRouteDeps()): void {
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  if (!deps.cipher) {
    console.warn("LETAGENTS_CONNECTOR_SECRET_KEY is not set or invalid; connector routes answer 503.");
  }
  const allowAttempt = createAttemptLimiter(CONNECT_ATTEMPTS_PER_WINDOW, CONNECT_ATTEMPT_WINDOW_MS);
  const service: ConnectionService | null = deps.cipher
    ? createConnectionService({ store: deps.store, cipher: deps.cipher, providers: deps.providers })
    : null;

  /** The service, or a 503 when the server has no connector key. */
  function ready(res: Response): ConnectionService | null {
    if (!service) {
      res.status(503).json({ error: CONNECTORS_NOT_CONFIGURED_MESSAGE, code: CONNECTORS_NOT_CONFIGURED_CODE });
      return null;
    }
    return service;
  }

  const githubDirectory = deps.githubDirectory ?? defaultGitHubAppDirectory;
  const githubAppConfigured = deps.githubAppConfigured ?? hasGitHubAppConfig;

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
        github: { oauth: false, api_token: false, github_app: await githubAppConfigured().catch(() => false) },
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
    if (!config && trackerOAuthMissingBaseUrl(provider, env)) {
      res.status(503).json({ error: "OAuth needs an https LETAGENTS_BASE_URL on this server. Use an API token instead." });
      return;
    }
    if (!config) {
      res.status(409).json({ error: "OAuth for this tracker is not set up on this server. Use an API token instead." });
      return;
    }
    const loopbackPort = parseLoopbackPort(((req.body ?? {}) as Record<string, unknown>).loopback_port);
    if (!loopbackPort) {
      res.status(400).json({ error: "loopback_port must be the app's local port (1024 to 65535)." });
      return;
    }
    if (!allowAttempt(`oauth:${accountId}`)) {
      res.status(429).json({ error: "Too many connection attempts. Wait a few minutes and try again." });
      return;
    }
    const state = randomBytes(32).toString("base64url");
    // Linear supports PKCE; Atlassian 3LO for confidential apps does not.
    const pkce = provider === "linear" ? createPkcePair() : null;
    const expiresAt = new Date(now().getTime() + TRACKER_OAUTH_STATE_TTL_MS).toISOString();
    await deps.store.createOAuthState({
      state_hash: hashOAuthState(state),
      account_id: accountId,
      provider,
      loopback_port: loopbackPort,
      code_verifier: pkce?.verifier ?? null,
      expires_at: expiresAt,
    });
    const body: TrackerOAuthStart = {
      authorize_url: buildTrackerAuthorizeUrl(provider, config, { state, codeChallenge: pkce?.challenge }),
      expires_at: expiresAt,
    };
    res.json(body);
  });

  // The tracker redirects the person's browser here. The browser carries no
  // LetAgents credential and may not belong to the person who started the
  // flow, so nothing is connected here: the code goes on to the starting app's
  // loopback listener on this computer, and that app finishes with its own
  // session (see /complete). A link forwarded to someone else delivers the
  // code to their computer, where no app waits for this state.
  app.get("/account/connectors/oauth/:provider/callback", async (req: AuthenticatedRequest, res) => {
    if (!service) {
      sendCallbackPage(res, 503, "Connectors are off", CONNECTORS_NOT_CONFIGURED_MESSAGE);
      return;
    }
    const provider = providerParam(req);
    const state = boundedString(req.query.state, 512);
    if (!provider || !state) {
      sendCallbackPage(res, 400, "Connection failed", "This link is not a valid tracker sign-in. Start again from LetAgents settings.");
      return;
    }
    const pending = await deps.store.peekOAuthState(hashOAuthState(state), provider);
    if (!pending) {
      sendCallbackPage(res, 400, "Connection failed", "This sign-in link expired or was already used. Start again from LetAgents settings.");
      return;
    }
    const target = new URL(`http://127.0.0.1:${pending.loopback_port}${TRACKER_OAUTH_LOOPBACK_PATH}`);
    target.searchParams.set("state", state);
    const code = boundedString(req.query.code, 2_048);
    if (req.query.error !== undefined || !code) {
      const error = typeof req.query.error === "string" && /^[a-z_]{1,64}$/.test(req.query.error) ? req.query.error : "no_code";
      target.searchParams.set("error", error);
    } else {
      target.searchParams.set("code", code);
    }
    res.status(302)
      .set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", Location: target.toString() })
      .end();
  });

  app.post("/account/connectors/oauth/:provider/complete", async (req: AuthenticatedRequest, res) => {
    const connections = ready(res);
    if (!connections) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const provider = providerParam(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const state = boundedString(body.state, 512);
    const code = boundedString(body.code, 2_048);
    if (!provider || !state || !code) {
      res.status(400).json({ error: "The tracker sign-in is incomplete. Start again." });
      return;
    }
    // Consume first: a state is good for one attempt, success or not.
    const owner = await deps.store.consumeOAuthState(hashOAuthState(state), provider);
    if (!owner || owner.account_id !== accountId) {
      res.status(400).json({ error: "This sign-in expired, was already used, or was started by another account. Start again." });
      return;
    }
    try {
      const { credentials, site } = await oauthCredentials(provider, code, owner.code_verifier, deps);
      const row = await connections.connect({ account_id: accountId, provider, auth_kind: "oauth", credentials, site });
      res.status(201).json({ connection: toConnectionView(row) });
    } catch (error) {
      console.error("Ticket connector OAuth completion failed:", connectorErrorText(error, [code]));
      sendProviderError(res, error);
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
    if (provider === "github") {
      res.status(400).json({ error: "GitHub Issues connects through the LetAgents GitHub App, not an API token." });
      return;
    }
    if (!provider || !token) {
      res.status(400).json({ error: "Choose a tracker and enter an API token." });
      return;
    }
    // Each attempt checks a credential with the tracker: bound them, so this
    // server cannot be used to test stolen credentials.
    if (!allowAttempt(`token:${accountId}`)) {
      res.status(429).json({ error: "Too many connection attempts. Wait a few minutes and try again." });
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

  /**
   * Connect GitHub Issues: the LetAgents GitHub App installation that holds
   * the named repository, for the signed-in person's GitHub login. Nothing
   * secret is stored. The person must be able to read that repository on
   * GitHub; every later read checks the repository it reads the same way.
   */
  app.post("/account/connectors/github-app", async (req: AuthenticatedRequest, res) => {
    const connections = ready(res);
    if (!connections) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const account = req.sessionAccount!;
    if (account.provider !== "github" || !account.login) {
      res.status(400).json({ error: "Sign in to LetAgents with GitHub to connect GitHub Issues." });
      return;
    }
    const repo = normalizeGitHubRepo(String(((req.body ?? {}) as Record<string, unknown>).repository ?? ""));
    if (!repo) {
      res.status(400).json({ error: "Enter a repository as owner/repo." });
      return;
    }
    if (!await githubAppConfigured().catch(() => false)) {
      res.status(409).json({ error: "This server has no GitHub App, so GitHub Issues is not available." });
      return;
    }
    if (!allowAttempt(`github:${accountId}`)) {
      res.status(429).json({ error: "Too many connection attempts. Wait a few minutes and try again." });
      return;
    }
    // The person is the signed-in GitHub id, checked before anything about the repository.
    const githubUserId = account.provider_user_id ? String(account.provider_user_id) : null;
    if (!githubUserId) {
      res.status(400).json({ error: "Sign in to LetAgents with GitHub to connect GitHub Issues." });
      return;
    }
    const credentials = { kind: "github_app" as const, installation_id: "", login: account.login, repository: repo };
    try {
      const holder = await githubDirectory.repositoryInstallation(repo);
      if (!holder) throw new GitHubAccessRefusedError(account.login, repo);
      credentials.installation_id = holder.installation_id;
      // Every read checks the repository; connecting also needs the person's own
      // access (not only public read), and the permission answer must name this
      // GitHub id, so an outsider or a renamed login cannot attach to an installation.
      await deps.providers.github.assertMember({
        id: "probe_github",
        provider: "github",
        auth_kind: "github_app",
        status_map: {},
        tracker_user_id: githubUserId,
        credentials,
        async saveCredentials() { return true; },
      }, repo);
    } catch (error) {
      // One answer for "not installed", "cannot read" and any GitHub error on
      // the way (a mint 404 or 422, a timeout): no probe for private names.
      if (!(error instanceof TrackerProviderError)) throw error;
      console.warn("GitHub Issues connect refused:", connectorErrorText(error));
      const refused = new GitHubAccessRefusedError(account.login, repo);
      res.status(403).json({ error: refused.message });
      return;
    }
    try {
      const row = await connections.connect({
        account_id: accountId,
        provider: "github",
        auth_kind: "github_app",
        credentials,
        site: null,
        tracker_user_id: githubUserId,
      });
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
    // GitHub Issues spends the organization's App budget (the search API is 30 a minute).
    if (row.provider === "github" && !allowAttempt(`github-test:${accountId}`)) {
      res.status(429).json({ error: "Too many tests. Wait a few minutes and try again." });
      return;
    }
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

  /** Where to point the tracker's webhook for this connection, and its signing secret. */
  app.get("/account/connectors/:id/webhook", async (req: AuthenticatedRequest, res) => {
    if (!ready(res)) return;
    const accountId = requireAccount(req, res);
    if (!accountId) return;
    const row = await ownedRow(req, res, accountId);
    if (!row) return;
    if (row.provider === "github") {
      res.status(409).json({ error: GITHUB_APP_WEBHOOK_TEXT });
      return;
    }
    const base = connectorPublicBaseUrl(env);
    if (!base) {
      res.status(503).json({ error: "Set LETAGENTS_BASE_URL to an https URL to receive tracker webhooks." });
      return;
    }
    const setup: TrackerWebhookSetup = {
      url: `${base}/webhooks/trackers/${row.provider}/${encodeURIComponent(row.id)}`,
      secret: deps.cipher!.webhookSecret(row.id),
    };
    res.set("Cache-Control", "no-store").json(setup);
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

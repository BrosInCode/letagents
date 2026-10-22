import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerConnectorRoutes, hashOAuthState } = await import("../routes/account/connectors/index.js");
const { createConnectorCipher } = await import("../connectors/crypto.js");
const { TrackerProviderError } = await import("../connectors/providers/types.js");
import type { TrackerConnectionRow, TrackerConnectionStore } from "../connectors/store.js";
import type { WorkItemProvider } from "../connectors/providers/types.js";
import type { GitHubIssuesProvider } from "../connectors/providers/github.js";
const { GitHubAccessRefusedError } = await import("../connectors/providers/github.js");
import { CONNECTORS_NOT_CONFIGURED_MESSAGE } from "../../../shared/ticket-connectors.mjs";
import type { AuthenticatedRequest } from "../http/helpers.js";

const key = randomBytes(32).toString("hex");

function memoryStore() {
  const rows = new Map<string, TrackerConnectionRow>();
  const states = new Map<string, { account_id: string; provider: string; loopback_port: number; expires_at: string }>();
  const store: TrackerConnectionStore = {
    async list(accountId) { return [...rows.values()].filter((row) => row.account_id === accountId); },
    async get(id) { return rows.get(id) ?? null; },
    async findBySite(accountId, provider, siteKey) {
      return [...rows.values()].find((row) => row.account_id === accountId && row.provider === provider && row.site_key === siteKey) ?? null;
    },
    async upsert(values) {
      const now = new Date().toISOString();
      const existing = rows.get(values.id);
      const row: TrackerConnectionRow = {
        unmapped_statuses: [],
        jev_linking_enabled: false,
        created_at: now,
        ...existing,
        ...values,
        status: "active",
        last_error: null,
        last_verified_at: now,
        updated_at: now,
      };
      rows.set(values.id, row);
      return row;
    },
    async saveCredentials(id, values, expectedIv) {
      const row = rows.get(id)!;
      if (row.credentials_iv !== expectedIv) return false;
      rows.set(id, { ...row, credentials_ciphertext: values.ciphertext, credentials_iv: values.iv });
      return true;
    },
    async update(id, accountId, patch) {
      const row = rows.get(id);
      if (!row || row.account_id !== accountId) return null;
      const next = { ...row, ...patch } as TrackerConnectionRow;
      rows.set(id, next);
      return next;
    },
    async setStatus(id, status, lastError) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, status, last_error: lastError });
    },
    async addUnmapped(id, names) {
      const row = rows.get(id)!;
      rows.set(id, { ...row, unmapped_statuses: [...new Set([...(row.unmapped_statuses as string[]), ...names])] });
    },
    async delete(id, accountId) {
      const row = rows.get(id);
      if (!row || row.account_id !== accountId) return false;
      rows.delete(id);
      return true;
    },
    async createOAuthState(input) { states.set(input.state_hash, input); },
    async peekOAuthState(hash, provider) {
      const state = states.get(hash);
      if (!state || state.provider !== provider || Date.parse(state.expires_at) <= Date.now()) return null;
      return { loopback_port: state.loopback_port };
    },
    async consumeOAuthState(hash, provider) {
      const state = states.get(hash);
      states.delete(hash);
      if (!state || state.provider !== provider || Date.parse(state.expires_at) <= Date.now()) return null;
      return { account_id: state.account_id, code_verifier: (state as { code_verifier?: string | null }).code_verifier ?? null };
    },
  };
  return { store, rows, states };
}

function provider(name: "jira" | "linear", overrides: Partial<WorkItemProvider> = {}): WorkItemProvider {
  return {
    name,
    async whoAmI(conn) {
      const credentials = conn.credentials as { api_token?: string; api_key?: string; access_token?: string };
      if ((credentials.api_token ?? credentials.api_key ?? credentials.access_token) === "bad-token") {
        throw new TrackerProviderError("auth", "Tracker answered 401");
      }
      return name === "jira"
        ? { id: "acc-1", label: "Emmy May" }
        : { id: "lin-1", label: "emmy", site: { key: "org-1", url: "https://linear.app/herotel", name: "Herotel" } };
    },
    async listItems(conn) {
      return [
        { provider: name, key: "HT-1", title: "One", ticket_state: "in_progress", raw_status: "In Progress", unmapped: false, assignee_id: "acc-1", assignee_label: "Emmy", url: null, tracker_updated_at: null, payload: {} },
        { provider: name, key: "HT-2", title: "Two", ticket_state: "in_progress", raw_status: "Blocked", unmapped: true, assignee_id: "acc-1", assignee_label: "Emmy", url: null, tracker_updated_at: null, payload: {} },
      ].map((item) => ({ ...item, unmapped: !conn.status_map[item.raw_status] && item.unmapped }));
    },
    async getItem() { return null; },
    async listTransitions() { return []; },
    async transition() { throw new Error("no"); },
    async comment() { throw new Error("no"); },
    async findTransition() { return null; },
    async findComment() { return null; },
    ...overrides,
  };
}

/** GitHub Issues: the App holds acme/api in installation 555; the login can read acme/api only. */
function githubProvider(): GitHubIssuesProvider {
  return {
    ...provider("jira"),
    name: "github",
    async whoAmI(conn) {
      const credentials = conn.credentials as { installation_id: string; login: string };
      return { id: "31524469", label: credentials.login, site: { key: `installation:${credentials.installation_id}`, url: "https://github.com/acme", name: "acme" } };
    },
    async assertReadable(conn, repo) {
      if (repo !== "acme/api") throw new GitHubAccessRefusedError((conn.credentials as { login: string }).login, repo);
      return "api";
    },
    async assertMember(conn, repo) {
      await this.assertReadable(conn, repo);
    },
  };
}

type Who = "owner_token" | "session" | "agent_session" | "cookie_session" | "anonymous" | "other_account";

async function serve(options: { cipher?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; githubApp?: boolean } = {}) {
  const memory = memoryStore();
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => {
    const who = (req.headers["x-test-auth"] as Who | undefined) ?? "anonymous";
    if (who === "agent_session") {
      req.authKind = "agent_session";
      req.sessionAccount = null;
    } else if (who !== "anonymous") {
      req.authKind = who === "cookie_session" || who === "other_account" ? "session" : who;
      req.sessionAccount = { account_id: who === "other_account" ? "acct_2" : "acct_1", login: "emmy", provider: "github", provider_user_id: who === "other_account" ? "999" : "31524469" } as AuthenticatedRequest["sessionAccount"];
    }
    if (who !== "cookie_session" && who !== "anonymous") req.headers.authorization = "Bearer test-token";
    next();
  });
  registerConnectorRoutes(app, {
    store: memory.store,
    cipher: options.cipher === false ? null : createConnectorCipher(key),
    providers: { jira: provider("jira"), linear: provider("linear"), github: githubProvider() },
    env: options.env ?? {},
    fetchImpl: options.fetchImpl,
    githubAppConfigured: async () => options.githubApp !== false,
    githubDirectory: {
      async repositoryInstallation(repo) {
        return repo === "acme/api" || repo === "acme/secret" ? { installation_id: "555" } : null;
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, who: Who = "session") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "x-test-auth": who, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    const text = await response.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status: response.status, json, text, headers: response.headers };
  };
  return { call, memory, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("without LETAGENTS_CONNECTOR_SECRET_KEY every connector route answers 503", async () => {
  const warn = console.warn;
  console.warn = () => {};
  const server = await serve({ cipher: false });
  console.warn = warn;
  try {
    for (const [method, path] of [
      ["GET", "/account/connectors"],
      ["POST", "/account/connectors/api-token"],
      ["POST", "/account/connectors/oauth/jira/start"],
      ["POST", "/account/connectors/oauth/jira/complete"],
      ["POST", "/account/connectors/tcon_1/test"],
      ["PATCH", "/account/connectors/tcon_1"],
      ["DELETE", "/account/connectors/tcon_1"],
      ["POST", "/account/connectors/github-app"],
    ]) {
      const answer = await server.call(method, path, method === "GET" ? undefined : { provider: "jira" });
      assert.equal(answer.status, 503, `${method} ${path}`);
      // The app shows its own page state for this code; the text names the setting, never a stack.
      assert.deepEqual(answer.json, { error: CONNECTORS_NOT_CONFIGURED_MESSAGE, code: "connectors_not_configured" }, `${method} ${path}`);
    }
    assert.match(CONNECTORS_NOT_CONFIGURED_MESSAGE, /^Connectors are not enabled on this server\. Ask your server admin to set LETAGENTS_CONNECTOR_SECRET_KEY\.$/);
    assert.equal((await server.call("GET", "/account/connectors/oauth/jira/callback?state=x&code=y")).status, 503);
  } finally {
    await server.close();
  }
});

test("only the app's session bearer may use connector routes; agents' owner tokens may not", async () => {
  const server = await serve();
  try {
    assert.equal((await server.call("GET", "/account/connectors", undefined, "anonymous")).status, 401);
    assert.equal((await server.call("GET", "/account/connectors", undefined, "agent_session")).status, 403);
    assert.equal((await server.call("GET", "/account/connectors", undefined, "cookie_session")).status, 403);
    assert.equal((await server.call("GET", "/account/connectors", undefined, "owner_token")).status, 403);
    assert.equal((await server.call("POST", "/account/connectors/api-token", { provider: "linear", api_token: "lin_api_x" }, "owner_token")).status, 403);
    assert.equal((await server.call("PATCH", "/account/connectors/tcon_1", { jev_linking_enabled: true }, "owner_token")).status, 403);
    const listed = await server.call("GET", "/account/connectors");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.providers, {
      jira: { oauth: false, api_token: true },
      linear: { oauth: false, api_token: true },
      github: { oauth: false, api_token: false, github_app: true },
    });
    assert.match(listed.json.jev_linking_disclosure, /Jev/);
  } finally {
    await server.close();
  }
});

test("a Jira API token is verified, stored encrypted, and never returned", async () => {
  const server = await serve();
  try {
    const refused = await server.call("POST", "/account/connectors/api-token", {
      provider: "jira", site_url: "https://169.254.169.254", email: "emmy@example.com", api_token: "ATATT3xFfGF0secret",
    });
    assert.equal(refused.status, 400);
    assert.equal(server.memory.rows.size, 0);
    const bad = await server.call("POST", "/account/connectors/api-token", {
      provider: "jira", site_url: "acme.atlassian.net", email: "emmy@example.com", api_token: "bad-token",
    });
    assert.equal(bad.status, 400);
    assert.equal(server.memory.rows.size, 0);

    const created = await server.call("POST", "/account/connectors/api-token", {
      provider: "jira", site_url: "acme.atlassian.net", email: "emmy@example.com", api_token: "ATATT3xFfGF0secret",
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.connection.provider, "jira");
    assert.equal(created.json.connection.site_url, "https://acme.atlassian.net");
    assert.equal(created.json.connection.tracker_user_label, "Emmy May");
    assert.equal(created.json.connection.jev_linking_enabled, false);
    assert.equal(created.json.connection.status_map["Code Review"], "in_review");
    assert.ok(!created.text.includes("ATATT3x") && !created.text.includes("ciphertext"));
    const [row] = server.memory.rows.values();
    assert.ok(!row.credentials_ciphertext.includes("ATATT3x"));

    // Reconnecting the same site updates the same connection.
    const again = await server.call("POST", "/account/connectors/api-token", {
      provider: "jira", site_url: "https://acme.atlassian.net", email: "emmy@example.com", api_token: "ATATT3xFfGF0newer",
    });
    assert.equal(again.json.connection.id, created.json.connection.id);
    assert.equal(server.memory.rows.size, 1);

    const list = await server.call("GET", "/account/connectors");
    assert.ok(!list.text.includes("ATATT3x"));
  } finally {
    await server.close();
  }
});

test("test connection lists assigned tickets and flags unmapped statuses until mapped", async () => {
  const server = await serve();
  try {
    const created = await server.call("POST", "/account/connectors/api-token", {
      provider: "jira", site_url: "acme.atlassian.net", email: "emmy@example.com", api_token: "ATATT3xFfGF0secret",
    });
    const id = created.json.connection.id;
    assert.equal((await server.call("POST", `/account/connectors/${id}/test`, undefined, "other_account")).status, 404);
    const tested = await server.call("POST", `/account/connectors/${id}/test`);
    assert.equal(tested.json.ok, true);
    assert.deepEqual(tested.json.items.map((item: { key: string }) => item.key), ["HT-1", "HT-2"]);
    assert.deepEqual(tested.json.connection.unmapped_statuses, ["Blocked"]);

    const badMap = await server.call("PATCH", `/account/connectors/${id}`, { status_map: { Blocked: "stuck" } });
    assert.equal(badMap.status, 400);
    const mapped = await server.call("PATCH", `/account/connectors/${id}`, {
      status_map: { ...tested.json.connection.status_map, Blocked: "in_progress" },
      jev_linking_enabled: true,
    });
    assert.equal(mapped.status, 200);
    assert.deepEqual(mapped.json.connection.unmapped_statuses, []);
    assert.equal(mapped.json.connection.jev_linking_enabled, true);
    assert.equal((await server.call("PATCH", `/account/connectors/${id}`, { jev_linking_enabled: "yes" })).status, 400);
    assert.equal((await server.call("PATCH", `/account/connectors/${id}`, { jev_linking_enabled: false }, "other_account")).status, 404);

    assert.equal((await server.call("DELETE", `/account/connectors/${id}`, undefined, "other_account")).status, 404);
    assert.equal((await server.call("DELETE", `/account/connectors/${id}`)).status, 200);
    assert.equal(server.memory.rows.size, 0);
  } finally {
    await server.close();
  }
});

test("a failing test marks the connection for reconnect without leaking the token", async () => {
  const server = await serve();
  try {
    const created = await server.call("POST", "/account/connectors/api-token", { provider: "linear", api_token: "lin_api_abcdefghijklmnopqrstuvwxyz" });
    assert.equal(created.status, 201);
    assert.equal(created.json.connection.display_name, "Herotel");
    const row = server.memory.rows.get(created.json.connection.id)!;
    // Tamper: credentials bound to another connection id cannot be decrypted.
    server.memory.rows.set(row.id, { ...row, credentials_iv: Buffer.alloc(12).toString("base64") });
    const tested = await server.call("POST", `/account/connectors/${row.id}/test`);
    assert.equal(tested.json.ok, false);
    assert.equal(tested.json.connection.status, "needs_reauth");
    assert.ok(!tested.text.includes("lin_api_abc"));
  } finally {
    await server.close();
  }
});

test("OAuth: the callback only forwards to the starting app's loopback port; completion needs the same account", async () => {
  const env = {
    LETAGENTS_BASE_URL: "https://letagents.example",
    LETAGENTS_LINEAR_CLIENT_ID: "linear-client",
    LETAGENTS_LINEAR_CLIENT_SECRET: "linear-secret",
  };
  const tokenCalls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    assert.equal(url, "https://api.linear.app/oauth/token");
    tokenCalls.push(String(init?.body));
    return new Response(JSON.stringify({ access_token: "lin_oauth_access", refresh_token: "lin_refresh", expires_in: 86399 }), { status: 200 });
  }) as typeof fetch;
  const server = await serve({ env, fetchImpl });
  const start = async (who: Who = "session") => {
    const started = await server.call("POST", "/account/connectors/oauth/linear/start", { loopback_port: 49152 }, who);
    assert.equal(started.status, 200);
    return new URL(started.json.authorize_url).searchParams.get("state")!;
  };
  try {
    assert.equal((await server.call("POST", "/account/connectors/oauth/jira/start", { loopback_port: 49152 })).status, 409);
    assert.equal((await server.call("POST", "/account/connectors/oauth/github/start", { loopback_port: 49152 })).status, 404);
    assert.equal((await server.call("POST", "/account/connectors/oauth/linear/start", { loopback_port: 49152 }, "agent_session")).status, 403);
    assert.equal((await server.call("POST", "/account/connectors/oauth/linear/start", { loopback_port: 80 })).status, 400);
    assert.equal((await server.call("POST", "/account/connectors/oauth/linear/start", {})).status, 400);

    const started = await server.call("POST", "/account/connectors/oauth/linear/start", { loopback_port: 49152 });
    const authorize = new URL(started.json.authorize_url);
    assert.equal(authorize.origin, "https://linear.app");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.match(authorize.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://letagents.example/account/connectors/oauth/linear/callback");
    const state = authorize.searchParams.get("state")!;
    assert.ok(state.length >= 40);
    assert.ok(!server.memory.states.has(state), "the raw state is not stored");
    assert.ok(server.memory.states.has(hashOAuthState(state)));

    // The callback connects nothing: it forwards the code to the app's loopback port.
    const callback = await server.call("GET", `/account/connectors/oauth/linear/callback?state=${state}&code=the-code`, undefined, "anonymous");
    assert.equal(callback.status, 302);
    const target = new URL(callback.headers.get("location")!);
    assert.equal(target.origin, "http://127.0.0.1:49152");
    assert.equal(target.pathname, "/tracker-oauth/callback");
    assert.equal(target.searchParams.get("state"), state);
    assert.equal(target.searchParams.get("code"), "the-code");
    assert.equal(callback.headers.get("cache-control"), "no-store");
    assert.equal(tokenCalls.length, 0);
    assert.equal(server.memory.rows.size, 0);

    const denied = await server.call("GET", `/account/connectors/oauth/linear/callback?state=${state}&error=access_denied%3Cx%3E`, undefined, "anonymous");
    assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "no_code");
    assert.equal((await server.call("GET", `/account/connectors/oauth/jira/callback?state=${state}&code=x`, undefined, "anonymous")).status, 400);
    const unknown = await server.call("GET", "/account/connectors/oauth/linear/callback?state=%3Cscript%3E&code=x", undefined, "anonymous");
    assert.equal(unknown.status, 400);
    assert.ok(!unknown.text.includes("<script>"));

    // The account-linking swap: another account's app cannot finish this state,
    // and the try uses it up.
    const swapped = await server.call("POST", "/account/connectors/oauth/linear/complete", { state, code: "the-code" }, "other_account");
    assert.equal(swapped.status, 400);
    assert.equal(tokenCalls.length, 0);
    assert.equal((await server.call("POST", "/account/connectors/oauth/linear/complete", { state, code: "the-code" })).status, 400);

    const state2 = await start();
    assert.equal((await server.call("POST", "/account/connectors/oauth/linear/complete", { state: state2, code: "c" }, "owner_token")).status, 403);
    const completed = await server.call("POST", "/account/connectors/oauth/linear/complete", { state: state2, code: "the-code" });
    assert.equal(completed.status, 201, completed.text);
    assert.equal(completed.json.connection.display_name, "Herotel");
    assert.equal(completed.json.connection.auth_kind, "oauth");
    assert.match(tokenCalls[0], /code=the-code/);
    assert.match(tokenCalls[0], /code_verifier=[A-Za-z0-9_-]{43}/);
    assert.ok(!completed.text.includes("lin_oauth_access"));
    const [row] = server.memory.rows.values();
    assert.equal(row.account_id, "acct_1");
    assert.equal((await server.call("POST", "/account/connectors/oauth/linear/complete", { state: state2, code: "the-code" })).status, 400);
    assert.equal(tokenCalls.length, 1);
  } finally {
    await server.close();
  }
});

test("connection attempts are rate limited per account", async () => {
  const server = await serve();
  try {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      statuses.push((await server.call("POST", "/account/connectors/api-token", {
        provider: "jira", site_url: "acme.atlassian.net", email: "emmy@example.com", api_token: "bad-token",
      })).status);
    }
    assert.deepEqual(statuses, [...Array(10).fill(400), 429]);
    // Another account has its own budget.
    assert.equal((await server.call("POST", "/account/connectors/api-token", {
      provider: "jira", site_url: "acme.atlassian.net", email: "emmy@example.com", api_token: "bad-token",
    }, "other_account")).status, 400);
  } finally {
    await server.close();
  }
});

test("OAuth is unavailable without an https base URL, and Jira OAuth keeps a custom-domain site for display only", async () => {
  const noBase = await serve({ env: { LETAGENTS_JIRA_CLIENT_ID: "id", LETAGENTS_JIRA_CLIENT_SECRET: "secret" } });
  try {
    assert.equal((await noBase.call("GET", "/account/connectors")).json.providers.jira.oauth, false);
    assert.equal((await noBase.call("POST", "/account/connectors/oauth/jira/start", { loopback_port: 49152 })).status, 503);
  } finally {
    await noBase.close();
  }
  const httpBase = await serve({ env: { LETAGENTS_BASE_URL: "http://letagents.example", LETAGENTS_JIRA_CLIENT_ID: "id", LETAGENTS_JIRA_CLIENT_SECRET: "secret" } });
  try {
    assert.equal((await httpBase.call("POST", "/account/connectors/oauth/jira/start", { loopback_port: 49152 })).status, 503);
  } finally {
    await httpBase.close();
  }

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "https://auth.atlassian.com/oauth/token") {
      return new Response(JSON.stringify({ access_token: "atl-access", refresh_token: "atl-refresh", expires_in: 3600 }), { status: 200 });
    }
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") {
      return new Response(JSON.stringify([{ id: "11111111-2222-3333-4444-555555555555", url: "https://jira.acme-corp.com", name: "Acme", scopes: ["read:jira-work"] }]), { status: 200 });
    }
    throw new Error(`Unexpected live request: ${url}`);
  }) as typeof fetch;
  const server = await serve({
    env: { LETAGENTS_BASE_URL: "https://letagents.example", LETAGENTS_JIRA_CLIENT_ID: "id", LETAGENTS_JIRA_CLIENT_SECRET: "secret" },
    fetchImpl,
  });
  try {
    const started = await server.call("POST", "/account/connectors/oauth/jira/start", { loopback_port: 49152 });
    const authorize = new URL(started.json.authorize_url);
    assert.equal(authorize.origin, "https://auth.atlassian.com");
    assert.equal(authorize.searchParams.get("code_challenge"), null);
    const completed = await server.call("POST", "/account/connectors/oauth/jira/complete", { state: authorize.searchParams.get("state"), code: "c" });
    assert.equal(completed.status, 201, completed.text);
    assert.equal(completed.json.connection.site_url, "https://jira.acme-corp.com");
  } finally {
    await server.close();
  }
});

test("GitHub Issues connects the App installation of a repository the person can read, and stores no token", async () => {
  const server = await serve();
  try {
    const unknown = await server.call("POST", "/account/connectors/github-app", { repository: "other/repo" });
    const unreadable = await server.call("POST", "/account/connectors/github-app", { repository: "acme/secret" });
    assert.equal(unreadable.status, 403, "the App can read it, the person cannot: no connection");
    assert.equal(unknown.status, 403);
    assert.equal(unknown.json.error.replace("other/repo", "R"), unreadable.json.error.replace("acme/secret", "R"),
      "one text for 'not installed' and 'cannot read': no probe for private repository names");
    const renamed = await server.call("POST", "/account/connectors/github-app", { repository: "acme/api" }, "other_account");
    assert.equal(renamed.status, 409, "the GitHub id behind the login must be the signed-in person's");
    assert.equal(server.memory.rows.size, 0);
    assert.equal((await server.call("POST", "/account/connectors/github-app", { repository: "not a repo" })).status, 400);
    assert.equal((await server.call("POST", "/account/connectors/github-app", { repository: "acme/api" }, "owner_token")).status, 403);

    const created = await server.call("POST", "/account/connectors/github-app", { repository: "Acme/API" });
    assert.equal(created.status, 201);
    assert.equal(created.json.connection.provider, "github");
    assert.equal(created.json.connection.auth_kind, "github_app");
    assert.equal(created.json.connection.display_name, "acme");
    assert.deepEqual(created.json.connection.status_map, { Open: "todo", "Open (assigned)": "in_progress", Closed: "done" });
    const row = [...server.memory.rows.values()][0]!;
    assert.equal(row.site_key, "installation:555");
    const stored = createConnectorCipher(key).decrypt(
      { ciphertext: row.credentials_ciphertext, iv: row.credentials_iv, version: row.credentials_version },
      { connection_id: row.id, account_id: "acct_1" },
    );
    assert.deepEqual(stored, { kind: "github_app", installation_id: "555", login: "emmy" }, "only a reference to the installation");

    const webhook = await server.call("GET", `/account/connectors/${row.id}/webhook`);
    assert.equal(webhook.status, 409, "the App's own webhook delivers issue events");
    const token = await server.call("POST", "/account/connectors/api-token", { provider: "github", api_token: "x" });
    assert.equal(token.status, 400);
  } finally {
    await server.close();
  }
});

test("GitHub Issues is not offered on a server without a GitHub App", async () => {
  const server = await serve({ githubApp: false });
  try {
    const listed = await server.call("GET", "/account/connectors");
    assert.equal(listed.json.providers.github.github_app, false);
    assert.equal((await server.call("POST", "/account/connectors/github-app", { repository: "acme/api" })).status, 409);
  } finally {
    await server.close();
  }
});

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
import type { AuthenticatedRequest } from "../http/helpers.js";

const key = randomBytes(32).toString("hex");

function memoryStore() {
  const rows = new Map<string, TrackerConnectionRow>();
  const states = new Map<string, { account_id: string; provider: string; expires_at: string }>();
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
    async saveCredentials(id, values) {
      const row = rows.get(id)!;
      rows.set(id, { ...row, credentials_ciphertext: values.ciphertext, credentials_iv: values.iv });
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
    async consumeOAuthState(hash, provider) {
      const state = states.get(hash);
      states.delete(hash);
      if (!state || state.provider !== provider || Date.parse(state.expires_at) <= Date.now()) return null;
      return { account_id: state.account_id };
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

type Who = "owner_token" | "session" | "agent_session" | "cookie_session" | "anonymous" | "other_account";

async function serve(options: { cipher?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {}) {
  const memory = memoryStore();
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => {
    const who = (req.headers["x-test-auth"] as Who | undefined) ?? "anonymous";
    if (who === "agent_session") {
      req.authKind = "agent_session";
      req.sessionAccount = null;
    } else if (who !== "anonymous") {
      req.authKind = who === "cookie_session" ? "session" : who === "other_account" ? "owner_token" : who;
      req.sessionAccount = { account_id: who === "other_account" ? "acct_2" : "acct_1", login: "emmy" } as AuthenticatedRequest["sessionAccount"];
    }
    if (who !== "cookie_session" && who !== "anonymous") req.headers.authorization = "Bearer test-token";
    next();
  });
  registerConnectorRoutes(app, {
    store: memory.store,
    cipher: options.cipher === false ? null : createConnectorCipher(key),
    providers: { jira: provider("jira"), linear: provider("linear") },
    env: options.env ?? {},
    fetchImpl: options.fetchImpl,
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
      ["POST", "/account/connectors/tcon_1/test"],
      ["PATCH", "/account/connectors/tcon_1"],
      ["DELETE", "/account/connectors/tcon_1"],
    ]) {
      assert.equal((await server.call(method, path, method === "GET" ? undefined : { provider: "jira" })).status, 503, `${method} ${path}`);
    }
    assert.equal((await server.call("GET", "/account/connectors/oauth/jira/callback?state=x&code=y")).status, 503);
  } finally {
    await server.close();
  }
});

test("only a human bearer may use connector routes", async () => {
  const server = await serve();
  try {
    assert.equal((await server.call("GET", "/account/connectors", undefined, "anonymous")).status, 401);
    assert.equal((await server.call("GET", "/account/connectors", undefined, "agent_session")).status, 403);
    assert.equal((await server.call("GET", "/account/connectors", undefined, "cookie_session")).status, 403);
    assert.equal((await server.call("GET", "/account/connectors", undefined, "owner_token")).status, 200);
    const listed = await server.call("GET", "/account/connectors");
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.providers, { jira: { oauth: false, api_token: true }, linear: { oauth: false, api_token: true } });
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

test("OAuth start stores only a hashed single-use state; the callback consumes it once", async () => {
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
  try {
    assert.equal((await server.call("POST", "/account/connectors/oauth/jira/start")).status, 409);
    assert.equal((await server.call("POST", "/account/connectors/oauth/github/start")).status, 404);
    assert.equal((await server.call("POST", "/account/connectors/oauth/linear/start", undefined, "agent_session")).status, 403);
    const started = await server.call("POST", "/account/connectors/oauth/linear/start");
    assert.equal(started.status, 200);
    const authorize = new URL(started.json.authorize_url);
    assert.equal(authorize.origin, "https://linear.app");
    assert.equal(authorize.searchParams.get("redirect_uri"), "https://letagents.example/account/connectors/oauth/linear/callback");
    const state = authorize.searchParams.get("state")!;
    assert.ok(state.length >= 40);
    assert.ok(!server.memory.states.has(state), "the raw state is not stored");
    assert.ok(server.memory.states.has(hashOAuthState(state)));

    const wrongProvider = await server.call("GET", `/account/connectors/oauth/jira/callback?state=${state}&code=abc`, undefined, "anonymous");
    assert.equal(wrongProvider.status, 400);
    // A state is good for one attempt: the wrong-provider try used it up.
    assert.equal(server.memory.states.size, 0);

    const second = await server.call("POST", "/account/connectors/oauth/linear/start");
    const state2 = new URL(second.json.authorize_url).searchParams.get("state")!;
    const page = await server.call("GET", `/account/connectors/oauth/linear/callback?state=${encodeURIComponent(state2)}&code=the-code`, undefined, "anonymous");
    assert.equal(page.status, 200, page.text);
    assert.match(page.text, /Herotel is connected/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(tokenCalls[0], /code=the-code/);
    const [row] = server.memory.rows.values();
    assert.equal(row.account_id, "acct_1");
    assert.equal(row.auth_kind, "oauth");
    assert.ok(!page.text.includes("lin_oauth_access"));

    const replay = await server.call("GET", `/account/connectors/oauth/linear/callback?state=${encodeURIComponent(state2)}&code=the-code`, undefined, "anonymous");
    assert.equal(replay.status, 400);
    assert.equal(tokenCalls.length, 1);

    const xss = await server.call("GET", "/account/connectors/oauth/linear/callback?state=%3Cscript%3E&code=x", undefined, "anonymous");
    assert.ok(!xss.text.includes("<script>"));
  } finally {
    await server.close();
  }
});

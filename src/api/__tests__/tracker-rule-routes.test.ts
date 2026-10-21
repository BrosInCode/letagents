import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

import type { TrackerRuleInput, TrackerRuleVersionView } from "../../../shared/ticket-connectors.mjs";
import type { TrackerRuleRow } from "../connectors/rules/store.js";
import type { TrackerConnectionRow } from "../connectors/store.js";
import type { AuthenticatedRequest } from "../http/helpers.js";
import type { TrackerRuleRouteDeps } from "../routes/account/connectors/rules.js";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { registerTrackerRuleRoutes } = await import("../routes/account/connectors/rules.js");

const CONNECTION = "tcon_00000000-0000-0000-0000-000000000001";
const OTHER_CONNECTION = "tcon_00000000-0000-0000-0000-000000000002";

function memoryRules() {
  const rows = new Map<string, TrackerRuleRow>();
  const versions: Array<TrackerRuleVersionView & { rule_id: string }> = [];
  let next = 0;
  const snapshot = (row: TrackerRuleRow) => versions.push({
    rule_id: row.id, version: row.version, name: row.name, room_id: row.room_id,
    trigger: row.trigger as never, actions: row.actions as never, created_at: row.updated_at,
  });
  const rules: TrackerRuleRouteDeps["rules"] = {
    async list(connectionId) { return [...rows.values()].filter((row) => row.connection_id === connectionId); },
    async count(connectionId) { return [...rows.values()].filter((row) => row.connection_id === connectionId).length; },
    async get(connectionId, id) { const row = rows.get(id); return row && row.connection_id === connectionId ? row : null; },
    async create(connectionId, accountId, input) {
      const now = new Date().toISOString();
      const row: TrackerRuleRow = {
        id: `trule_00000000-0000-0000-0000-00000000000${++next}`, connection_id: connectionId, room_id: input.room_id,
        name: input.name, enabled: input.enabled ?? true, trigger: input.trigger as never, actions: input.actions as never,
        version: 1, created_by: accountId, created_at: now, updated_at: now,
      };
      rows.set(row.id, row);
      snapshot(row);
      return row;
    },
    async update(connectionId, id, _accountId, input) {
      const current = await rules.get(connectionId, id);
      if (!current) return null;
      const row = { ...current, ...input, enabled: input.enabled ?? current.enabled, trigger: input.trigger as never, actions: input.actions as never, version: current.version + 1 };
      rows.set(id, row);
      snapshot(row);
      return row;
    },
    async setEnabled(connectionId, id, enabled) {
      const current = await rules.get(connectionId, id);
      if (!current) return null;
      const row = { ...current, enabled };
      rows.set(id, row);
      return row;
    },
    async delete(connectionId, id) { return (await rules.get(connectionId, id)) ? rows.delete(id) : false; },
    async versions(id) { return versions.filter((entry) => entry.rule_id === id).reverse(); },
    async version(id, version) { return versions.find((entry) => entry.rule_id === id && entry.version === version) ?? null; },
    async roomsForConnection(connectionId) { return connectionId === CONNECTION ? ["room-billing"] : []; },
  };
  return { rules, rows };
}

type Who = "session" | "owner_token" | "agent_session" | "anonymous" | "other_account";

async function serve() {
  const memory = memoryRules();
  const connections = new Map<string, Partial<TrackerConnectionRow>>([
    [CONNECTION, { id: CONNECTION, account_id: "acct_1", provider: "jira" }],
    [OTHER_CONNECTION, { id: OTHER_CONNECTION, account_id: "acct_2", provider: "jira" }],
  ]);
  const app = express();
  app.use(express.json());
  app.use((req: AuthenticatedRequest, _res, next) => {
    const who = (req.headers["x-test-auth"] as Who | undefined) ?? "anonymous";
    if (who === "agent_session") {
      req.authKind = "agent_session";
      req.sessionAccount = null;
    } else if (who !== "anonymous") {
      req.authKind = who === "other_account" ? "session" : who;
      req.sessionAccount = { account_id: who === "other_account" ? "acct_2" : "acct_1", login: "emmy" } as AuthenticatedRequest["sessionAccount"];
    }
    if (who !== "anonymous") req.headers.authorization = "Bearer test-token";
    next();
  });
  registerTrackerRuleRoutes(app, {
    connections: { get: async (id) => (connections.get(id) as TrackerConnectionRow | undefined) ?? null },
    rules: memory.rules,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, body?: unknown, who: Who = "session") => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "x-test-auth": who, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json().catch(() => null) as any };
  };
  return { call, memory, close: () => new Promise((resolve) => server.close(resolve)) };
}

const rule: TrackerRuleInput = {
  name: "Opened: In Review",
  room_id: null,
  trigger: { event: "pull_request", action: "opened", draft: false },
  actions: [{ kind: "transition", toStatus: "In Review" }, { kind: "comment", template: "{{pr_url}}" }],
};

test("only the connection owner's app session may use rule routes", async () => {
  const server = await serve();
  try {
    const path = `/account/connectors/${CONNECTION}/rules`;
    assert.equal((await server.call("GET", path, undefined, "anonymous")).status, 401);
    assert.equal((await server.call("GET", path, undefined, "agent_session")).status, 403);
    assert.equal((await server.call("POST", path, rule, "owner_token")).status, 403, "an agent's owner token cannot write rules");
    assert.equal((await server.call("GET", path, undefined, "other_account")).status, 404, "another account's connection is not found");
    assert.equal((await server.call("POST", `/account/connectors/${OTHER_CONNECTION}/rules`, rule)).status, 404);
    assert.equal(server.memory.rows.size, 0);
    assert.deepEqual((await server.call("GET", path)).json, { rules: [], rooms: ["room-billing"] });
  } finally {
    await server.close();
  }
});

test("rules are created, versioned, switched, rolled back and deleted", async () => {
  const server = await serve();
  try {
    const path = `/account/connectors/${CONNECTION}/rules`;
    const created = await server.call("POST", path, rule);
    assert.equal(created.status, 201);
    const id = created.json.rule.id as string;
    assert.equal(created.json.rule.version, 1);

    // A rule is reachable only under its own connection, and only by its owner.
    assert.equal((await server.call("PUT", `/account/connectors/${OTHER_CONNECTION}/rules/${id}`, rule, "other_account")).status, 404);
    assert.equal((await server.call("POST", `${path}/${id}/enabled`, { enabled: false }, "other_account")).status, 404);

    const updated = await server.call("PUT", `${path}/${id}`, { ...rule, name: "Renamed", actions: [{ kind: "transition", toStatus: "Code Review" }] });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.rule.version, 2);

    const disabled = await server.call("POST", `${path}/${id}/enabled`, { enabled: false });
    assert.equal(disabled.json.rule.enabled, false);
    assert.equal(disabled.json.rule.version, 2, "switching a rule is not a new version");
    assert.equal((await server.call("POST", `${path}/${id}/enabled`, { enabled: "no" })).status, 400);

    const history = await server.call("GET", `${path}/${id}/versions`);
    assert.deepEqual(history.json.versions.map((entry: { version: number }) => entry.version), [2, 1]);

    const rolledBack = await server.call("POST", `${path}/${id}/rollback`, { version: 1 });
    assert.equal(rolledBack.status, 200);
    assert.equal(rolledBack.json.rule.version, 3);
    assert.equal(rolledBack.json.rule.name, rule.name);
    assert.deepEqual(rolledBack.json.rule.actions, rule.actions);
    assert.equal((await server.call("POST", `${path}/${id}/rollback`, { version: 9 })).status, 404);

    assert.equal((await server.call("DELETE", `${path}/${id}`)).status, 200);
    assert.equal((await server.call("GET", `${path}/${id}/versions`)).status, 404);
  } finally {
    await server.close();
  }
});

test("rule JSON is validated strictly on write", async () => {
  const server = await serve();
  try {
    const path = `/account/connectors/${CONNECTION}/rules`;
    for (const body of [
      { ...rule, trigger: { ...rule.trigger, event: "push" } },
      { ...rule, actions: [{ kind: "comment", template: "{{api_token}}" }] },
      { ...rule, connection_id: OTHER_CONNECTION },
      { ...rule, room_id: "room-elsewhere" },
    ]) {
      const result = await server.call("POST", path, body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(typeof result.json.error, "string");
    }
    assert.equal((await server.call("POST", path, { ...rule, room_id: "room-billing" })).status, 201);
    assert.equal(server.memory.rows.size, 1);
  } finally {
    await server.close();
  }
});

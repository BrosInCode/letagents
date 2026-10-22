import assert from "node:assert/strict";
import test from "node:test";
import { createConnectorsApi } from "../src/composables/connectors-api";
test("web adapter uses existing account contracts and exposes no loopback OAuth", async () => {
  const calls: { path: string; options?: RequestInit }[] = [];
  const connection = { id: "tcon1" };
  const api = createConnectorsApi(async (path, options) => {
    calls.push({ path, options });
    if (path.endsWith("/versions")) return { versions: [{ version: 1 }] };
    if (path.includes("/rules"))
      return { rule: { id: "rule1" }, rules: [], rooms: [] };
    return { connection, connections: [] };
  });
  assert.equal(api.trackers.connectOAuth, undefined);
  assert.equal(
    await api.trackers.saveApiToken({ provider: "linear", api_token: "test" }),
    connection,
  );
  assert.equal(calls[0].path, "/account/connectors/api-token");
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {
    provider: "linear",
    api_token: "test",
  });
  await api.trackers.connectGitHub("owner/repo");
  assert.equal(calls[1].path, "/account/connectors/github-app");
  await api.trackers.update("tcon1", { jev_linking_enabled: true });
  assert.equal(calls[2].options?.method, "PATCH");
  await api.trackers.rules.update("tcon1", "rule1", {
    name: "rule",
    room_id: null,
    trigger: { event: "pull_request", action: "opened" },
    actions: [],
  });
  assert.equal(calls[3].path, "/account/connectors/tcon1/rules/rule1");
  assert.equal(calls[3].options?.method, "PUT");
  await api.trackers.rules.rollback("tcon1", "rule1", 1);
  assert.equal(calls[4].path, "/account/connectors/tcon1/rules/rule1/rollback");
  await api.remote.disconnect("remote1");
  assert.equal(calls[5].path, "/account/mcp-connections/remote1");
  assert.equal(calls[5].options?.method, "DELETE");
});
test("web adapter normalizes disabled connectors but retains unexpected failures", async () => {
  const api = createConnectorsApi(async () => {
    throw Object.assign(new Error("disabled"), {
      status: 503,
      code: "connectors_not_configured",
    });
  });
  const result = await api.trackers.list();
  assert.equal(result.not_configured, true);
  assert.equal(result.providers.github.github_app, false);
  assert.deepEqual(result.connections, []);
  const failing = createConnectorsApi(async () => {
    throw new Error("network unavailable");
  });
  await assert.rejects(() => failing.trackers.list(), /network unavailable/);
});

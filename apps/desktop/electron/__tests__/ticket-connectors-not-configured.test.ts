import assert from "node:assert/strict";
import { mock, test } from "node:test";

class DesktopApiError extends Error {
  constructor(readonly status: number, readonly payload: { error?: string; code?: string } | null) {
    super(payload?.error ?? `API request failed: ${status}`);
    this.name = "DesktopApiError";
  }
}

let answer: () => unknown = () => ({});
const calls: Array<{ path: string; body: unknown }> = [];

mock.module("../main/auth.js", {
  namedExports: {
    DesktopApiError,
    apiFetch: async (path: string, init?: RequestInit) => {
      calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : null });
      return answer();
    },
  },
});
mock.module("../main/external-url.js", { namedExports: { openAllowedExternalUrl: async () => undefined } });
const connectors = await import("../main/connectors.js");

test("a server without a connector key lists as not configured, not as an error", async () => {
  // Servers from this release send the code; older ones (letagents.chat before it) only the text.
  for (const payload of [
    { error: "Connectors are not enabled on this server. Ask your server admin to set LETAGENTS_CONNECTOR_SECRET_KEY.", code: "connectors_not_configured" },
    { error: "Ticket connectors are not configured on this server." },
  ]) {
    answer = () => { throw new DesktopApiError(503, payload); };
    const list = await connectors.listTrackerConnections();
    assert.equal(list.not_configured, true);
    assert.deepEqual(list.connections, []);
    assert.equal(list.providers.github.github_app, false);
  }
});

test("other failures stay errors: a proxy 503 has no connector code", async () => {
  answer = () => { throw new DesktopApiError(503, null); };
  await assert.rejects(connectors.listTrackerConnections(), DesktopApiError);
  answer = () => { throw new DesktopApiError(500, { error: "boom" }); };
  await assert.rejects(connectors.listTrackerConnections(), /boom/);
});

test("GitHub Issues connects by repository name and checks the form first", async () => {
  calls.length = 0;
  answer = () => ({ connection: { id: "tcon_00000000-0000-4000-8000-000000000000", provider: "github" } });
  const connection = await connectors.connectGitHubIssues(" BrosInCode/letagents ");
  assert.equal(connection.provider, "github");
  assert.deepEqual(calls, [{ path: "/account/connectors/github-app", body: { repository: "BrosInCode/letagents" } }]);
  await assert.rejects(connectors.connectGitHubIssues("https://github.com/x/y"), /owner\/repo/);
  await assert.rejects(connectors.connectTrackerWithOAuth("github"), /Choose Jira or Linear/);
});

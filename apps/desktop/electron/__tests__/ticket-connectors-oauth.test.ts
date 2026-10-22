import assert from "node:assert/strict";
import { mock, test } from "node:test";

const calls: Array<{ path: string; body: unknown }> = [];
let opened: string[] = [];
let completeFails = false;
const authorizeState = "s".repeat(43);

mock.module("../main/auth.js", {
  namedExports: {
    DesktopApiError: class DesktopApiError extends Error {},
    apiFetch: async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path, body });
      if (path.endsWith("/start")) {
        return { authorize_url: `https://auth.atlassian.com/authorize?state=${authorizeState}`, expires_at: "2026-10-21T10:10:00.000Z" };
      }
      if (path.endsWith("/complete")) {
        if (completeFails) throw new Error("This sign-in expired.");
        return { connection: { id: "tcon_00000000-0000-4000-8000-000000000000", provider: "jira", display_name: "acme" } };
      }
      throw new Error(`unexpected ${path}`);
    },
  },
});
mock.module("../main/external-url.js", {
  namedExports: { openAllowedExternalUrl: async (url: string) => { opened.push(url); } },
});
const connectors = await import("../main/connectors.js");

async function waitForStart(): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const start = calls.find((call) => call.path.endsWith("/start"));
    if (start && opened.length) return (start.body as { loopback_port: number }).loopback_port;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("OAuth did not start");
}

test("OAuth finishes in the app that started it, through its own loopback listener", async () => {
  calls.length = 0;
  opened = [];
  completeFails = false;
  const pending = connectors.connectTrackerWithOAuth("jira");
  const port = await waitForStart();
  assert.ok(port >= 1024);
  assert.deepEqual(opened, [`https://auth.atlassian.com/authorize?state=${authorizeState}`]);

  const base = `http://127.0.0.1:${port}${connectors.TRACKER_OAUTH_LOOPBACK_PATH}`;
  const wrong = await fetch(`${base}?state=other&code=abc`);
  assert.equal(wrong.status, 404);
  assert.ok(!calls.some((call) => call.path.endsWith("/complete")), "a wrong state never reaches the server");

  const done = await fetch(`${base}?state=${authorizeState}&code=the-code`);
  assert.equal(done.status, 200);
  assert.ok(!(await done.text()).includes("the-code"));
  const connection = await pending;
  assert.equal(connection.id, "tcon_00000000-0000-4000-8000-000000000000");
  assert.deepEqual(calls.find((call) => call.path.endsWith("/complete"))?.body, { state: authorizeState, code: "the-code" });
  await assert.rejects(fetch(`${base}?state=${authorizeState}&code=again`), "the listener is closed afterwards");
});

test("a denied sign-in, a failed completion, or a cancel ends the wait", async () => {
  calls.length = 0;
  opened = [];
  const denied = assert.rejects(connectors.connectTrackerWithOAuth("linear"), /did not grant access/);
  const port = await waitForStart();
  const response = await fetch(`http://127.0.0.1:${port}${connectors.TRACKER_OAUTH_LOOPBACK_PATH}?state=${authorizeState}&error=access_denied`);
  assert.equal(response.status, 400);
  await denied;

  calls.length = 0;
  opened = [];
  completeFails = true;
  const failing = assert.rejects(connectors.connectTrackerWithOAuth("jira"), /expired/);
  const failingPort = await waitForStart();
  const failed = await fetch(`http://127.0.0.1:${failingPort}${connectors.TRACKER_OAUTH_LOOPBACK_PATH}?state=${authorizeState}&code=x`);
  assert.equal(failed.status, 502);
  await failing;

  calls.length = 0;
  opened = [];
  const cancelled = assert.rejects(connectors.connectTrackerWithOAuth("jira"), /cancelled/);
  await waitForStart();
  connectors.cancelTrackerOAuth();
  await cancelled;
  await assert.rejects(connectors.connectTrackerWithOAuth("github"), /Jira or Linear/);
});

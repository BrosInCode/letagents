import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";

import express from "express";

process.env.DB_URL ??= "postgresql://test:test@127.0.0.1:1/test";
const { parseJiraWebhook, parseLinearWebhook, verifyJiraWebhook, verifyLinearWebhook } = await import("../connectors/providers/webhooks.js");
const { registerTrackerWebhookRoutes } = await import("../routes/connectors/tracker-webhooks.js");
const { createConnectorCipher } = await import("../connectors/crypto.js");
const { createWorkItemProviders } = await import("../connectors/providers/index.js");
const { trackerPollIntervalMs, DEFAULT_TRACKER_POLL_MS } = await import("../connectors/sync.js");
const { linearTeamKeysInFilter } = await import("../connectors/room-filters.js");
import type { ExternalItemChange } from "../connectors/providers/types.js";
import type { TrackerConnectionRow } from "../connectors/store.js";
import type { AuthenticatedRequest } from "../http/helpers.js";

const sign = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest("hex");

test("Jira webhooks need the connection's HMAC signature", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const body = Buffer.from(JSON.stringify({ timestamp: now.getTime(), webhookEvent: "jira:issue_updated", issue: { key: "HT-12" } }));
  const ok = verifyJiraWebhook({
    now,
    headers: { "x-hub-signature": `sha256=${sign("s3cret", body.toString())}`, "x-atlassian-webhook-identifier": "d-1" },
    rawBody: body,
    secret: "s3cret",
  });
  assert.deepEqual(ok, { ok: true, deliveryId: "d-1" });
  assert.equal(verifyJiraWebhook({ headers: { "x-hub-signature": `sha256=${sign("other", body.toString())}` }, rawBody: body, secret: "s3cret", now }).ok, false);
  // A recorded delivery replayed later is refused.
  assert.equal(verifyJiraWebhook({
    headers: { "x-hub-signature": `sha256=${sign("s3cret", body.toString())}` },
    rawBody: body, secret: "s3cret", now: new Date(now.getTime() + 60 * 60_000),
  }).ok, false);
  assert.equal(verifyJiraWebhook({ headers: {}, rawBody: body, secret: "s3cret" }).ok, false);
  assert.deepEqual(parseJiraWebhook(JSON.parse(body.toString())), [{ key: "HT-12", item: null, deleted: false }]);
  assert.deepEqual(parseJiraWebhook({ webhookEvent: "jira:issue_deleted", issue: { key: "HT-3" } }), [{ key: "HT-3", item: null, deleted: true }]);
  assert.deepEqual(parseJiraWebhook({ webhookEvent: "comment_created", issue: { key: "HT-3" } }), []);
  assert.deepEqual(parseJiraWebhook({ webhookEvent: "jira:issue_updated", issue: { key: "not a key" } }), []);
});

test("Linear webhooks need a signature and a recent timestamp", () => {
  const now = new Date("2026-10-21T12:00:00.000Z");
  const payload = { type: "Issue", action: "update", data: { identifier: "ENG-7" }, webhookTimestamp: now.getTime() };
  const body = Buffer.from(JSON.stringify(payload));
  const headers = { "linear-signature": sign("k", body.toString()), "linear-delivery": "ld-1" };
  assert.deepEqual(verifyLinearWebhook({ headers, rawBody: body, secret: "k", now }), { ok: true, deliveryId: "ld-1" });
  assert.equal(verifyLinearWebhook({ headers, rawBody: body, secret: "k", now: new Date(now.getTime() + 10 * 60_000) }).ok, false);
  assert.equal(verifyLinearWebhook({ headers: { "linear-signature": "00" }, rawBody: body, secret: "k", now }).ok, false);
  assert.deepEqual(parseLinearWebhook(payload), [{ key: "ENG-7", item: null, deleted: false }]);
  assert.deepEqual(parseLinearWebhook({ ...payload, type: "Comment" }), []);
});

test("poll interval and Linear team keys", () => {
  assert.equal(trackerPollIntervalMs({}), DEFAULT_TRACKER_POLL_MS);
  assert.equal(trackerPollIntervalMs({ LETAGENTS_TRACKER_POLL_MS: "1000" }), 15_000);
  assert.equal(trackerPollIntervalMs({ LETAGENTS_TRACKER_POLL_MS: "nope" }), DEFAULT_TRACKER_POLL_MS);
  assert.deepEqual(linearTeamKeysInFilter("team:eng project:abc"), ["ENG"]);
});

test("the webhook route verifies the signature, then hands the keys to sync once", async () => {
  const cipher = createConnectorCipher(randomBytes(32).toString("hex"));
  const connection = { id: "tcon_1", provider: "jira", status: "active" } as TrackerConnectionRow;
  const handled: ExternalItemChange[][] = [];
  const app = express();
  app.use(express.json({ verify(req, _res, buf) { (req as AuthenticatedRequest).rawBody = Buffer.from(buf); } }));
  registerTrackerWebhookRoutes(app, {
    cipher,
    store: { get: async (id) => (id === connection.id ? connection : null) },
    providers: createWorkItemProviders({ fetchImpl: (async () => { throw new Error("no network"); }) as typeof fetch }),
    sync: { handleWebhook: async (_conn, changes) => { handled.push([...changes]); return { applied: changes.length }; } },
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = JSON.stringify({ timestamp: Date.now(), webhookEvent: "jira:issue_updated", issue: { key: "HT-1" } });
    const post = (path: string, signature: string) => fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature": `sha256=${signature}`, "x-atlassian-webhook-identifier": "d-9" },
      body,
    });
    assert.equal((await post("/webhooks/trackers/jira/tcon_1", sign("wrong", body))).status, 401);
    assert.equal((await post("/webhooks/trackers/jira/tcon_unknown", sign(cipher.webhookSecret("tcon_unknown"), body))).status, 404);
    assert.equal((await post("/webhooks/trackers/linear/tcon_1", sign(cipher.webhookSecret("tcon_1"), body))).status, 404);
    const good = sign(cipher.webhookSecret("tcon_1"), body);
    assert.equal((await post("/webhooks/trackers/jira/tcon_1", good)).status, 202);
    assert.deepEqual(await (await post("/webhooks/trackers/jira/tcon_1", good)).json(), { ok: true, duplicate: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(handled, [[{ key: "HT-1", item: null, deleted: false }]]);
  } finally {
    server.close();
  }
});

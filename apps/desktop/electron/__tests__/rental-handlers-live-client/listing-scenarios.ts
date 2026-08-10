import assert from "node:assert/strict";
import test from "node:test";

import { listingRow } from "./fixtures.js";
import { captureHandlersWithClient, invoke, makeFakeClient } from "./harness.js";

test("create-listing forwards to apiClient.createListing and maps the response", async () => {
  const { client, calls } = makeFakeClient({
    createListing: {
      ok: true,
      status: 201,
      body: listingRow({
        id: "listing_42",
        display_name: "Antigravity desk",
        updated_at: "2026-05-12T10:00:00.000Z",
      }),
    },
  });
  const handlers = captureHandlersWithClient(client);
  const result = (await invoke(handlers, "desktop:rental:create-listing", {
    displayName: " Antigravity desk ",
    ideKind: "antigravity",
    supportedModes: ["scoped"],
  })) as { id: string; displayName: string };

  assert.equal(result.id, "listing_42");
  assert.equal(result.displayName, "Antigravity desk");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "createListing");
  const sentBody = calls[0]?.args[0] as { displayName?: string; ideKind?: string };
  assert.equal(sentBody.displayName, "Antigravity desk");
  assert.equal(sentBody.ideKind, "antigravity");
});

test("create-listing surfaces API failure", async () => {
  const { client } = makeFakeClient({
    createListing: { ok: false, status: 500, error: "boom", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  await assert.rejects(() => invoke(handlers, "desktop:rental:create-listing", {
    displayName: "Stub",
    ideKind: "antigravity",
  }), { code: "request_failed" });
});

test("update-listing forwards to apiClient.updateListing", async () => {
  const { client, calls } = makeFakeClient({
    updateListing: {
      ok: true,
      status: 200,
      body: listingRow({
        id: "listing_42",
        display_name: "Updated label",
        updated_at: "2026-05-12T10:00:00.000Z",
      }),
    },
  });
  const handlers = captureHandlersWithClient(client);
  const result = (await invoke(
    handlers,
    "desktop:rental:update-listing",
    "listing_42",
    { displayName: "Updated label" },
  )) as { id: string; displayName: string };
  assert.equal(result.displayName, "Updated label");
  assert.equal(calls[0]?.args[0], "listing_42");
  assert.deepEqual(calls[0]?.args[1], { displayName: "Updated label" });
});

test("pause-listing forwards to apiClient.pauseListing", async () => {
  const { client, calls } = makeFakeClient({
    pauseListing: {
      ok: true,
      status: 200,
      body: listingRow({
        id: "listing_42",
        display_name: "Antigravity desk",
        status: "paused",
        updated_at: "2026-05-12T10:00:00.000Z",
      }),
    },
  });
  const handlers = captureHandlersWithClient(client);
  const result = (await invoke(
    handlers,
    "desktop:rental:pause-listing",
    "listing_42",
  )) as { status: string };
  assert.equal(result.status, "paused");
  assert.equal(calls[0]?.method, "pauseListing");
  assert.equal(calls[0]?.args[0], "listing_42");
});

test("resume-listing surfaces API failure", async () => {
  const { client } = makeFakeClient({
    resumeListing: { ok: false, status: 404, error: "missing", body: null },
  });
  const handlers = captureHandlersWithClient(client);
  await assert.rejects(() => invoke(
    handlers,
    "desktop:rental:resume-listing",
    "listing_404",
  ), { code: "request_failed" });
});

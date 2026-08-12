import assert from "node:assert/strict";
import test from "node:test";

import { DesktopApiError } from "../main/auth.js";
import { loadSource } from "../main/rooms/snapshot/fetch-data.js";
import { isMissingThreadRouteError } from "../main/rooms/messages.js";

test("loadSource returns ready state and data when the source resolves", async () => {
  const result = await loadSource(Promise.resolve({ tasks: [{ id: "task_1" }] }), {
    tasks: [],
  });

  assert.equal(result.state.status, "ready");
  assert.equal(result.state.error, null);
  assert.deepEqual(result.data, { tasks: [{ id: "task_1" }] });
});

test("loadSource falls back to the provided value and records the error message", async () => {
  const fallback = { tasks: [] as Array<{ id: string }> };
  const result = await loadSource(
    Promise.reject(new DesktopApiError(500, { error: "boom", message: "server exploded" })),
    fallback,
  );

  assert.equal(result.state.status, "error");
  assert.equal(result.state.error, "server exploded");
  // Failed source degrades to the fallback rather than blanking or throwing.
  assert.deepEqual(result.data, fallback);
});

test("loadSource stringifies non-Error rejections", async () => {
  const result = await loadSource(Promise.reject("nope"), null);

  assert.equal(result.state.status, "error");
  assert.equal(result.state.error, "nope");
  assert.equal(result.data, null);
});

test("isMissingThreadRouteError only swallows a bare 404 from an older server", () => {
  // Older server without the threads route: bare 404, no machine-readable code.
  assert.equal(isMissingThreadRouteError(new DesktopApiError(404, null)), true);
  assert.equal(
    isMissingThreadRouteError(new DesktopApiError(404, { error: "not available" })),
    true,
  );
});

test("isMissingThreadRouteError surfaces a coded 404 as a real error", () => {
  // A 404 that identifies a specific room must NOT be masked as an empty inbox.
  assert.equal(
    isMissingThreadRouteError(
      new DesktopApiError(404, { error: "Room not found", code: "ROOM_NOT_FOUND" }),
    ),
    false,
  );
});

test("isMissingThreadRouteError surfaces auth, server, and non-API errors", () => {
  assert.equal(isMissingThreadRouteError(new DesktopApiError(401, { error: "auth_required" })), false);
  assert.equal(isMissingThreadRouteError(new DesktopApiError(500, { error: "boom" })), false);
  assert.equal(isMissingThreadRouteError(new Error("offline")), false);
  assert.equal(isMissingThreadRouteError(null), false);
});

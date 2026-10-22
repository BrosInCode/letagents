import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { DesktopMyWorkQuery } from "../ipc-types.js";

const paths: string[] = [];
const page = { cards: [], next_cursor: null, has_connections: false, providers: [] };
mock.module("../main/auth.js", { namedExports: {
  apiFetch: async (path: string) => { paths.push(path); return page; },
} });
const { getDesktopMyWork } = await import("../main/rooms/my-work.js");

test("My work only includes completed work on an explicit boolean opt-in", async () => {
  for (const includeCompleted of [undefined, false, "true"] as const) {
    assert.equal(await getDesktopMyWork({ includeCompleted } as DesktopMyWorkQuery), page);
    assert.equal(paths.at(-1), "/account/my-work");
  }
  assert.equal(await getDesktopMyWork({ includeCompleted: true, limit: 500, roomId: " room/a ", needsMe: true }), page);
  const url = new URL(paths.at(-1)!, "https://example.invalid");
  assert.equal(url.searchParams.get("include_completed"), "true");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.get("room"), "room/a");
  assert.equal(url.searchParams.get("needs_me"), "true");
});

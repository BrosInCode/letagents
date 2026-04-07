import assert from "node:assert/strict";
import test from "node:test";

import { buildRoomEventsQueryString } from "../room-events-query.js";

test("buildRoomEventsQueryString returns an empty query for empty input", () => {
  assert.equal(buildRoomEventsQueryString({}), "");
});

test("buildRoomEventsQueryString includes supported filters and pagination fields", () => {
  const query = buildRoomEventsQueryString({
    event_type: "pull_request",
    object_id: "143",
    actor: "octocat",
    since: "2026-04-07T00:00:00.000Z",
    until: "2026-04-08T00:00:00.000Z",
    after: "gre_cursor",
    limit: 50,
  });

  const params = new URLSearchParams(query);
  assert.equal(params.get("event_type"), "pull_request");
  assert.equal(params.get("object_id"), "143");
  assert.equal(params.get("actor"), "octocat");
  assert.equal(params.get("since"), "2026-04-07T00:00:00.000Z");
  assert.equal(params.get("until"), "2026-04-08T00:00:00.000Z");
  assert.equal(params.get("after"), "gre_cursor");
  assert.equal(params.get("limit"), "50");
});

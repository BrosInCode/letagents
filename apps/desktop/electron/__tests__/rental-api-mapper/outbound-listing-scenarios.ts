import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  toApiCreateSessionBody,
  toApiListingCreateBody,
  toApiListingPatchBody,
} from "../../rental/api-mapper.js";

describe("toApiListingCreateBody / toApiListingPatchBody", () => {
  it("routes marketplace sessions directly into the selected room with disclosed history access", () => {
    const body = toApiCreateSessionBody({
      listingId: "listing-1",
      roomIdentifier: "room-canonical",
      taskTitle: "Continue the work",
      taskPrompt: "Read context and continue.",
    });
    assert.equal(body.targetRoomId, "room-canonical");
    assert.equal(body.roomHistoryAccess, "full");
    assert.ok(!("roomIdentifier" in body));
  });

  it("passes maxConcurrentSessions through on create", () => {
    const body = toApiListingCreateBody({
      displayName: "Agent",
      ideKind: "claude_code",
      maxConcurrentSessions: 3,
    });
    assert.strictEqual(body.maxConcurrentSessions, 3);
  });

  it("omits maxConcurrentSessions when undefined", () => {
    const body = toApiListingCreateBody({
      displayName: "Agent",
      ideKind: "claude_code",
    });
    assert.ok(!("maxConcurrentSessions" in body));
  });

  it("passes maxConcurrentSessions through on patch", () => {
    const body = toApiListingPatchBody({ maxConcurrentSessions: 2 });
    assert.strictEqual(body.maxConcurrentSessions, 2);
  });
});

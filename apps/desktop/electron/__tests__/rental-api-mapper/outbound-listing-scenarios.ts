import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  toApiListingCreateBody,
  toApiListingPatchBody,
} from "../../rental/api-mapper.js";

describe("toApiListingCreateBody / toApiListingPatchBody", () => {
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

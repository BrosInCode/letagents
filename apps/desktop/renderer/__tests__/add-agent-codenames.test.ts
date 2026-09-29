import assert from "node:assert/strict";
import test from "node:test";
import { supervisedAgentDisplayLabel, supervisedAgentShortTag } from "../src/domain/codenames";

test("names written by older versions project to the friendly label of their own entry only", () => {
  const firstRequestId = "request_00000005";
  const secondRequestId = "request_00000070";

  assert.equal(
    supervisedAgentDisplayLabel(`CloudHaven · ${firstRequestId}`, `supervised_${firstRequestId}`),
    "CloudHaven",
  );
  assert.equal(
    supervisedAgentDisplayLabel(`CloudHaven · ${supervisedAgentShortTag(firstRequestId)}`, `supervised_${firstRequestId}`),
    "CloudHaven",
  );
  assert.equal(
    supervisedAgentDisplayLabel(`CloudHaven · ${firstRequestId}`, `supervised_${secondRequestId}`),
    `CloudHaven · ${firstRequestId}`,
    "only the exact entry-owned suffix is hidden",
  );
});

test("the renderer offers no way to choose an agent name", async () => {
  // Naming needs the names already taken in the room. Only the background
  // service that saves the agent can read them and claim one in one step.
  const codenames = await import("../src/domain/codenames");
  assert.deepEqual(Object.keys(codenames).sort(), ["supervisedAgentDisplayLabel", "supervisedAgentShortTag"]);
});

test("name projection preserves punctuation that is not owned by the exact durable entry", () => {
  const entryId = "supervised_request_00000005";

  assert.equal(
    supervisedAgentDisplayLabel("Ava · 000001", entryId),
    "Ava · 000001",
  );
  assert.equal(
    supervisedAgentDisplayLabel("Ava · request_00000070", entryId),
    "Ava · request_00000070",
  );
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  dispenseRoomAgentPrompt,
  resetRoomAgentPromptDeliveryForTests,
} from "../agent-prompt-delivery.js";
import {
  buildCompactRoomAgentPrompt,
  buildRoomAgentPrompt,
} from "../../shared/room-agent-prompts.js";

test("first expansion delivers the full prompt, later expansions the compact form", () => {
  resetRoomAgentPromptDeliveryForTests();

  assert.equal(dispenseRoomAgentPrompt("inline"), buildRoomAgentPrompt("inline"));
  assert.equal(dispenseRoomAgentPrompt("inline"), buildCompactRoomAgentPrompt("inline"));
  assert.equal(dispenseRoomAgentPrompt("auto"), buildCompactRoomAgentPrompt("auto"));
});

test("join always delivers the full prompt and marks delivery", () => {
  resetRoomAgentPromptDeliveryForTests();

  assert.equal(dispenseRoomAgentPrompt("join"), buildRoomAgentPrompt("join"));
  assert.equal(dispenseRoomAgentPrompt("auto"), buildCompactRoomAgentPrompt("auto"));
  // A re-join still gets the full onboarding prompt.
  assert.equal(dispenseRoomAgentPrompt("join"), buildRoomAgentPrompt("join"));
});

test("compact prompts stay small and point back at the standing instructions", () => {
  for (const kind of ["inline", "auto"] as const) {
    const compact = buildCompactRoomAgentPrompt(kind);
    assert.ok(compact.length < buildRoomAgentPrompt(kind).length / 4);
    assert.match(compact, /instructions you already received/);
    assert.match(compact, /wait_for_messages/);
  }
  assert.equal(buildCompactRoomAgentPrompt("join"), buildRoomAgentPrompt("join"));
});

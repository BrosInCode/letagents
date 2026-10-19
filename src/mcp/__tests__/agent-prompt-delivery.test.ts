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

test("every prompt variant teaches agents to act on liveness signals", () => {
  for (const kind of ["join", "inline", "auto"] as const) {
    const full = buildRoomAgentPrompt(kind);
    assert.match(full, /Resilience:/);
    assert.match(full, /never reply that you are waiting/);
    assert.match(full, /A person or the Board Manager reassigns its unfinished work/);
    assert.match(full, /list_board_intents/);
  }
  for (const kind of ["inline", "auto"] as const) {
    assert.match(
      buildCompactRoomAgentPrompt(kind),
      /offline\/failover system messages as actionable/
    );
  }
});

test("room agent prompts never nudge an agent toward unassigned or abandoned work", () => {
  for (const kind of ["join", "inline", "auto"] as const) {
    for (const prompt of [buildRoomAgentPrompt(kind), buildCompactRoomAgentPrompt(kind)]) {
      assert.doesNotMatch(prompt, /pick up its (unfinished )?work/);
      assert.doesNotMatch(prompt, /stalled board/);
      assert.doesNotMatch(prompt, /file the next task/);
      assert.match(prompt, /unassigned tasks (alone|are not yours)/);
    }
  }
});

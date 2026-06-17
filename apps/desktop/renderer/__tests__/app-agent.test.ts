import assert from "node:assert/strict";
import test from "node:test";

import {
  appAgentStatusLabel,
  buildAppAgentRunInput,
  shouldRefreshRoomsAfterAppAgentResult,
  visibleAppAgentChoices,
} from "../src/domain/app-agent";

test("App Agent submit input trims prompts and includes the active room", () => {
  assert.deepEqual(
    buildAppAgentRunInput({
      prompt: "  Pin the LetAgents room.  ",
      activeRoomIdentifier: "room_1",
    }),
    {
      prompt: "Pin the LetAgents room.",
      activeRoomIdentifier: "room_1",
      selectedRoomIdentifier: null,
      selectedPinned: null,
    },
  );
  assert.equal(buildAppAgentRunInput({ prompt: "   " }), null);
});

test("App Agent ambiguous choices are visible only for choice results", () => {
  const choices = visibleAppAgentChoices({
    state: "choices",
    message: "Choose a room.",
    choices: [
      {
        roomIdentifier: "room_1",
        displayName: "Rentals",
        reason: "Name match",
        pinned: false,
        desiredPinned: true,
        lastOpenedAt: null,
      },
    ],
  });
  assert.equal(choices.length, 1);
  assert.equal(choices[0].displayName, "Rentals");
  assert.deepEqual(
    visibleAppAgentChoices({ state: "success", message: "Pinned." }),
    [],
  );
});

test("App Agent success results request room refresh", () => {
  assert.equal(
    shouldRefreshRoomsAfterAppAgentResult({
      state: "success",
      message: "Pinned LetAgents.",
      roomIdentifier: "room_1",
    }),
    true,
  );
  assert.equal(
    shouldRefreshRoomsAfterAppAgentResult({
      state: "choices",
      message: "Choose a room.",
    }),
    false,
  );
});

test("App Agent status label reflects busy and setup states", () => {
  assert.equal(appAgentStatusLabel(null, true), "Running");
  assert.equal(appAgentStatusLabel(null, false), "Checking");
  assert.equal(
    appAgentStatusLabel({
      configured: false,
      hasApiKey: false,
      model: "anthropic/claude-3.5-sonnet",
      savedAt: null,
      settingsPath: "/tmp/settings.json",
      error: null,
    }, false),
    "Setup needed",
  );
  assert.equal(
    appAgentStatusLabel({
      configured: true,
      hasApiKey: true,
      model: "openai/gpt-4o-mini",
      savedAt: "2026-06-17T00:00:00.000Z",
      settingsPath: "/tmp/settings.json",
      error: null,
    }, false),
    "openai/gpt-4o-mini",
  );
});

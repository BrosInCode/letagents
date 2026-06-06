import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopRoomSnapshot } from "../../electron/ipc-types";
import { rootRoomMeta } from "../src/domain/sidebar-rooms";

function roomSnapshot(input: {
  code?: string;
  displayName?: string;
  identifier: string;
}): DesktopRoomSnapshot {
  return {
    roomIdentifier: input.identifier,
    access: {
      status: "ready",
      title: "Room ready",
      message: "",
      roomIdentifier: input.identifier,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    },
    room: {
      identifier: input.identifier,
      code: input.code || "",
      name: input.identifier,
      displayName: input.displayName || input.identifier,
      role: "participant",
      authenticated: true,
      kind: "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
    },
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    messages: [],
  };
}

test("rootRoomMeta only shows branch for the workspace room", () => {
  const revAppRoom = roomSnapshot({
    identifier: "github.com/example/revapp",
    displayName: "RevApp",
    code: "REVAPP",
  });

  assert.equal(
    rootRoomMeta({
      snapshot: revAppRoom,
      workspaceRoomIdentifier: "github.com/BrosInCode/letagents",
      branch: "codex/ui-polishing",
      fallback: "Parent room",
    }),
    "REVAPP",
  );
});

test("rootRoomMeta uses branch when the selected room matches the workspace room", () => {
  const workspaceRoom = roomSnapshot({
    identifier: "github.com/BrosInCode/letagents",
    displayName: "LetAgents",
    code: "LETAGENTS",
  });

  assert.equal(
    rootRoomMeta({
      snapshot: workspaceRoom,
      workspaceRoomIdentifier: "github.com/BrosInCode/letagents",
      branch: "codex/ui-polishing",
      fallback: "Parent room",
    }),
    "codex/ui-polishing",
  );
});

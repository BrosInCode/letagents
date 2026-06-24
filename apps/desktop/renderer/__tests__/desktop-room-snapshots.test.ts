import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopRoomMessage,
  DesktopRoomSnapshot,
} from "../../electron/ipc-types";
import { mergeRoomSnapshotMessages } from "../src/domain/desktop-room-snapshots";

describe("desktop room snapshot merging", () => {
  it("replaces messages instead of merging when room storage changes namespace", () => {
    const current = roomSnapshot("cloud", "Cloud message", "msg_1");
    const incoming = roomSnapshot("local", "Local message", "msg_1", "local_room");

    const merged = mergeRoomSnapshotMessages(current, incoming);

    assert.equal(merged.storage.effectiveMode, "local");
    assert.deepEqual(merged.messages.map((message) => message.text), ["Local message"]);
  });
});

function roomSnapshot(
  storageMode: "cloud" | "local",
  text: string,
  messageId: string,
  localRoomIdentifier: string | null = null,
): DesktopRoomSnapshot {
  const roomIdentifier = "github.com/BrosInCode/letagents";
  return {
    roomIdentifier,
    access: {
      status: "ready",
      title: "",
      message: "",
      roomIdentifier,
      deviceFlowUrl: null,
      code: null,
      httpStatus: null,
    },
    room: {
      identifier: roomIdentifier,
      code: "",
      name: "sky-lake",
      displayName: "sky-lake",
      role: "admin",
      authenticated: true,
      kind: "main",
      parentRoomId: null,
      focusKey: null,
      sourceTaskId: null,
      focusStatus: null,
      focusParentVisibility: null,
      focusActivityScope: null,
      focusGitHubEventRouting: null,
      focusSettings: null,
      focusArchivedAt: null,
      concludedAt: null,
      conclusionSummary: null,
      conclusionDetails: null,
    },
    storage: {
      roomIdentifier,
      defaultMode: "cloud",
      overrideMode: storageMode,
      effectiveMode: storageMode,
      isLocalRoom: storageMode === "local",
      localRoom: localRoomIdentifier
        ? {
            roomIdentifier: localRoomIdentifier,
            displayName: "sky-lake",
            cloudRoomIdentifier: roomIdentifier,
            publishStatus: "linked",
            createdAt: "2026-06-17T00:00:00.000Z",
            updatedAt: "2026-06-17T00:00:00.000Z",
            publishedAt: null,
          }
        : null,
      databasePath: "/tmp/local-chat.sqlite",
      localFilesPath: "/tmp/local-files",
    },
    focusRooms: [],
    tasks: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    reasoningSessions: [],
    recentActivity: [],
    messages: [roomMessage(messageId, text)],
    githubEvents: null,
  };
}

function roomMessage(id: string, text: string): DesktopRoomMessage {
  return {
    id,
    sender: "EmmyMay",
    text,
    attachments: [],
    agentPromptKind: null,
    source: "browser",
    timestamp: "2026-06-17T00:00:00.000Z",
    actorLabel: null,
    agentIdentity: null,
    threadRootId: id,
    threadReplyToId: null,
    thread: null,
    replyTo: null,
  };
}

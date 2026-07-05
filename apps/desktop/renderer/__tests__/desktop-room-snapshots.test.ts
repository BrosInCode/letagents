import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopRoomMessage,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
} from "../../electron/ipc-types";
import {
  mergeRoomSnapshotMessages,
  upsertSnapshotRoomArtifact,
} from "../src/domain/desktop-room-snapshots";

describe("desktop room snapshot merging", () => {
  it("replaces messages instead of merging when room storage changes namespace", () => {
    const current = roomSnapshot("cloud", "Cloud message", "msg_1");
    const incoming = roomSnapshot("local", "Local message", "msg_1", "local_room");

    const merged = mergeRoomSnapshotMessages(current, incoming);

    assert.equal(merged.storage.effectiveMode, "local");
    assert.deepEqual(merged.messages.map((message) => message.text), ["Local message"]);
  });

  it("upserts room artifacts by identity and keeps newest activity first", () => {
    const snapshot = {
      ...roomSnapshot("local", "Local message", "msg_1", "local_room"),
      roomArtifacts: [
        roomArtifact("git:branch:ref:feature/old", "feature/old", "2026-06-17T00:01:00.000Z"),
      ],
    };

    const withNew = upsertSnapshotRoomArtifact(
      snapshot,
      roomArtifact("git:commit:id:abc123", "abc123", "2026-06-17T00:02:00.000Z"),
    );
    assert.deepEqual(withNew?.roomArtifacts.map((artifact) => artifact.identityKey), [
      "git:commit:id:abc123",
      "git:branch:ref:feature/old",
    ]);

    const withUpdated = upsertSnapshotRoomArtifact(
      withNew,
      {
        ...roomArtifact("git:branch:ref:feature/old", "feature/old", "2026-06-17T00:03:00.000Z"),
        state: "updated",
      },
    );
    assert.deepEqual(withUpdated?.roomArtifacts.map((artifact) => artifact.identityKey), [
      "git:branch:ref:feature/old",
      "git:commit:id:abc123",
    ]);
    assert.equal(withUpdated?.roomArtifacts[0]?.state, "updated");
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
      gitRoom: null,
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
            gitRoom: null,
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
    roomArtifacts: [],
    boardSettings: {
      managerMode: "manager_optional",
      activeManager: null,
      pendingIntentCount: 0,
    },
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

function roomArtifact(
  identityKey: string,
  ref: string,
  updatedAt: string,
): DesktopRoomSharedArtifact {
  return {
    roomId: "local_room",
    identityKey,
    provider: "git",
    kind: identityKey.includes(":commit:") ? "commit" : "branch",
    artifactId: identityKey.includes(":commit:") ? ref : null,
    artifactNumber: null,
    title: null,
    url: null,
    ref,
    state: null,
    source: "manual",
    firstSeenAt: "2026-06-17T00:00:00.000Z",
    updatedAt,
    linkedTaskIds: [],
  };
}

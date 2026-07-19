import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type {
  DesktopRoomLiveMetadata,
  DesktopRoomMessage,
  DesktopRoomSharedArtifact,
  DesktopRoomSnapshot,
} from "../../electron/ipc-types";
import {
  appendDesktopRoomMessage,
  applyRoomLiveMetadata,
  mergeDesktopRoomMessages,
  mergeRoomSnapshotMessages,
  messageReferencesMissingThreadContext,
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

  it("preserves last-good data for sources that failed to refresh", () => {
    const current = {
      ...roomSnapshot("cloud", "hello", "msg_1"),
      tasks: [{ id: "task_1", title: "Keep me" }],
      reasoningSessions: [{ id: "reason_1" }],
    } as DesktopRoomSnapshot;
    const incoming = {
      ...roomSnapshot("cloud", "hello", "msg_1"),
      tasks: [],
      reasoningSessions: [],
      participants: [],
      sourceStates: {
        ...readyStates(),
        tasks: { status: "error", error: "API request failed: 500" },
        reasoning: { status: "error", error: "network down" },
      },
    } as DesktopRoomSnapshot;

    const merged = mergeRoomSnapshotMessages(current, incoming);

    // Failed sources keep the previously loaded data instead of blanking.
    assert.deepEqual(merged.tasks.map((task) => task.id), ["task_1"]);
    assert.deepEqual(merged.reasoningSessions.map((session) => session.id), ["reason_1"]);
    // The fresh (error) states are still reported so the UI can show a banner.
    assert.equal(merged.sourceStates.tasks.status, "error");
    assert.equal(merged.sourceStates.reasoning.status, "error");
    // A source that loaded fine (ready) with an empty result is NOT preserved.
    assert.deepEqual(merged.participants, []);
    assert.equal(merged.sourceStates.participants.status, "ready");
  });

  it("replaces a source that recovered to ready", () => {
    const current = {
      ...roomSnapshot("cloud", "hi", "msg_1"),
      tasks: [{ id: "stale" }],
      sourceStates: { ...readyStates(), tasks: { status: "error", error: "x" } },
    } as DesktopRoomSnapshot;
    const incoming = {
      ...roomSnapshot("cloud", "hi", "msg_1"),
      tasks: [{ id: "fresh" }],
    } as DesktopRoomSnapshot;

    const merged = mergeRoomSnapshotMessages(current, incoming);

    assert.deepEqual(merged.tasks.map((task) => task.id), ["fresh"]);
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

describe("appendDesktopRoomMessage fast path", () => {
  const loaded = [
    roomMessage("msg_1", "first"),
    roomMessage("msg_2", "second"),
    roomMessage("msg_3", "third"),
  ];

  it("appends an in-order message byte-identically to the slow path", () => {
    const incoming = roomMessage("msg_4", "fourth");

    const fast = appendDesktopRoomMessage(loaded, incoming);
    const slow = mergeDesktopRoomMessages(loaded, [incoming]);

    // Property: fast path must equal the slow path exactly for this case.
    assert.deepEqual(fast, slow);
    assert.deepEqual(fast.map((message) => message.id), ["msg_1", "msg_2", "msg_3", "msg_4"]);
    // The new message is the exact object appended, not a copy.
    assert.equal(fast[fast.length - 1], incoming);
  });

  it("fast-appends into an empty list", () => {
    const incoming = roomMessage("msg_1", "first");

    const fast = appendDesktopRoomMessage([], incoming);
    const slow = mergeDesktopRoomMessages([], [incoming]);

    assert.deepEqual(fast, slow);
    assert.deepEqual(fast.map((message) => message.id), ["msg_1"]);
  });

  it("does not double-append a duplicate id delivered by a second transport", () => {
    // SSE and the fallback poll can deliver the same message id twice; the
    // re-delivery must not create a second copy.
    const redelivery = { ...roomMessage("msg_3", "third (edited)"), text: "third (edited)" };

    const result = appendDesktopRoomMessage(loaded, redelivery);
    const slow = mergeDesktopRoomMessages(loaded, [redelivery]);

    assert.deepEqual(result, slow);
    assert.deepEqual(result.map((message) => message.id), ["msg_1", "msg_2", "msg_3"]);
    // The duplicate routes through the slow path, which replaces in place.
    assert.equal(result[2]?.text, "third (edited)");
  });

  it("falls back and re-sorts an out-of-order arrival", () => {
    // msg_2 sorts before the current last message (msg_3), so it cannot be
    // appended at the end.
    const outOfOrder = roomMessage("msg_2", "late arrival");
    const current = [roomMessage("msg_1", "first"), roomMessage("msg_3", "third")];

    const result = appendDesktopRoomMessage(current, outOfOrder);
    const slow = mergeDesktopRoomMessages(current, [outOfOrder]);

    assert.deepEqual(result, slow);
    assert.deepEqual(result.map((message) => message.id), ["msg_1", "msg_2", "msg_3"]);
  });

  it("still filters a prompt-only message", () => {
    const promptOnly: DesktopRoomMessage = {
      ...roomMessage("msg_4", ""),
      agentPromptKind: "auto",
      text: "   ",
    };

    const result = appendDesktopRoomMessage(loaded, promptOnly);
    const slow = mergeDesktopRoomMessages(loaded, [promptOnly]);

    assert.deepEqual(result, slow);
    assert.deepEqual(result.map((message) => message.id), ["msg_1", "msg_2", "msg_3"]);
  });
});

describe("messageReferencesMissingThreadContext", () => {
  const existing = [roomMessage("msg_1", "Root")];

  it("returns false for a top-level message that only references itself", () => {
    const message = roomMessage("msg_2", "Top level");
    assert.equal(messageReferencesMissingThreadContext(message, existing), false);
  });

  it("returns false when the root and reply-to are in the loaded window", () => {
    const message: DesktopRoomMessage = {
      ...roomMessage("msg_2", "Reply"),
      threadRootId: "msg_1",
      threadReplyToId: "msg_1",
    };
    assert.equal(messageReferencesMissingThreadContext(message, existing), false);
  });

  it("returns true when the thread root is outside the loaded window", () => {
    const message: DesktopRoomMessage = {
      ...roomMessage("msg_2", "Reply to old root"),
      threadRootId: "msg_missing",
    };
    assert.equal(messageReferencesMissingThreadContext(message, existing), true);
  });

  it("returns true when the reply-to is outside the loaded window", () => {
    const message: DesktopRoomMessage = {
      ...roomMessage("msg_2", "Reply to old message"),
      threadRootId: "msg_2",
      threadReplyToId: "msg_missing",
    };
    assert.equal(messageReferencesMissingThreadContext(message, existing), true);
  });
});

describe("applyRoomLiveMetadata", () => {
  it("replaces only the poll-only sections and leaves event-fed data untouched", () => {
    const current = {
      ...roomSnapshot("cloud", "hello", "msg_1"),
      tasks: [{ id: "task_1", title: "Keep me" }],
      reasoningSessions: [{ id: "reason_1" }],
      roomArtifacts: [{ identityKey: "git:branch:ref:feat" }],
      participants: [{ participantKey: "old" }],
    } as unknown as DesktopRoomSnapshot;
    const metadata = liveMetadata({
      participants: [{ participantKey: "fresh" }],
      participantHiddenCount: 4,
      presence: [{ actorLabel: "agent:river" }],
      boardSettings: { managerMode: "intent_required", activeManager: null, pendingIntentCount: 2 },
    });

    const applied = applyRoomLiveMetadata(current, metadata)!;

    // Poll-only sections are replaced from the metadata.
    assert.deepEqual(applied.participants.map((p) => (p as { participantKey: string }).participantKey), ["fresh"]);
    assert.equal(applied.participantHiddenCount, 4);
    assert.equal(applied.presence.length, 1);
    assert.equal(applied.boardSettings.managerMode, "intent_required");
    // Event-fed sections are preserved verbatim (never re-downloaded on a tick).
    assert.deepEqual(applied.messages.map((m) => m.id), ["msg_1"]);
    assert.deepEqual(applied.tasks.map((t) => t.id), ["task_1"]);
    assert.deepEqual(applied.reasoningSessions.map((s) => s.id), ["reason_1"]);
    assert.deepEqual(
      applied.roomArtifacts.map((a) => a.identityKey),
      ["git:branch:ref:feat"],
    );
  });

  it("preserves the sourceStates of the skipped event-fed sections", () => {
    const current = {
      ...roomSnapshot("cloud", "hello", "msg_1"),
      sourceStates: {
        ...readyStates(),
        tasks: { status: "error", error: "tasks down" },
        messages: { status: "error", error: "messages down" },
      },
    } as DesktopRoomSnapshot;

    const applied = applyRoomLiveMetadata(current, liveMetadata({}))!;

    // Event-fed sections keep whatever state they had — a metadata tick never
    // fetched them, so it must not flip them to ready or error.
    assert.equal(applied.sourceStates.tasks.status, "error");
    assert.equal(applied.sourceStates.messages.status, "error");
    // Poll-only sections adopt the metadata's fresh (ready) states.
    assert.equal(applied.sourceStates.presence.status, "ready");
    assert.equal(applied.sourceStates.participants.status, "ready");
  });

  it("keeps last-good data for a poll-only section that failed to refresh", () => {
    const current = {
      ...roomSnapshot("cloud", "hello", "msg_1"),
      presence: [{ actorLabel: "agent:river" }],
    } as unknown as DesktopRoomSnapshot;
    const metadata = liveMetadata({
      presence: [],
      sourceStates: {
        focusRooms: { status: "ready", error: null },
        participants: { status: "ready", error: null },
        presence: { status: "error", error: "presence down" },
        activityHistory: { status: "ready", error: null },
        boardSettings: { status: "ready", error: null },
      },
    });

    const applied = applyRoomLiveMetadata(current, metadata)!;

    // Failed poll-only source keeps prior data but reports the error state.
    assert.equal(applied.presence.length, 1);
    assert.equal(applied.sourceStates.presence.status, "error");
  });

  it("returns the snapshot unchanged when the metadata is for a different room", () => {
    const current = roomSnapshot("cloud", "hello", "msg_1");
    const metadata = liveMetadata({ roomIdentifier: "some/other/room" });

    assert.equal(applyRoomLiveMetadata(current, metadata), current);
  });

  it("is a no-op on a null snapshot", () => {
    assert.equal(applyRoomLiveMetadata(null, liveMetadata({})), null);
  });
});

function liveMetadata(
  overrides: Partial<DesktopRoomLiveMetadata>,
): DesktopRoomLiveMetadata {
  const ready = () => ({ status: "ready" as const, error: null });
  return {
    roomIdentifier: "github.com/BrosInCode/letagents",
    focusRooms: [],
    participants: [],
    participantHiddenCount: 0,
    presence: [],
    recentActivity: [],
    boardSettings: { managerMode: "manager_optional", activeManager: null, pendingIntentCount: 0 },
    sourceStates: {
      focusRooms: ready(),
      participants: ready(),
      presence: ready(),
      activityHistory: ready(),
      boardSettings: ready(),
    },
    ...overrides,
  };
}

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
    sourceStates: readyStates(),
  };
}

function readyStates(): DesktopRoomSnapshot["sourceStates"] {
  const ready = () => ({ status: "ready" as const, error: null });
  return {
    focusRooms: ready(),
    tasks: ready(),
    participants: ready(),
    presence: ready(),
    reasoning: ready(),
    activityHistory: ready(),
    roomArtifacts: ready(),
    boardSettings: ready(),
    messages: ready(),
    githubEvents: ready(),
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

import assert from "node:assert/strict";
import test from "node:test";

import {
  looksLikeInviteCode,
  normalizeJoinRoomInput,
  validateJoinRoomInput,
} from "../src/domain/join-room-input";
import { useDesktopNewRoomModal } from "../src/composables/useDesktopNewRoomModal";
import type { DesktopRoomSnapshot } from "../../electron/ipc-types";

test("normalizeJoinRoomInput uppercases invite codes and strips spaces", () => {
  assert.equal(normalizeJoinRoomInput(" abcd 1234 "), "ABCD-1234");
  assert.equal(normalizeJoinRoomInput("abcd-1234"), "ABCD-1234");
  assert.equal(looksLikeInviteCode("ABCD-1234"), true);
});

test("normalizeJoinRoomInput accepts LetAgents room URLs", () => {
  assert.equal(
    normalizeJoinRoomInput("https://letagents.chat/in/ABCD-1234"),
    "ABCD-1234",
  );
  assert.equal(
    normalizeJoinRoomInput("https://letagents.chat/in/github.com/brosincode/letagents"),
    "github.com/brosincode/letagents",
  );
  assert.equal(
    normalizeJoinRoomInput("/in/focus_31"),
    "focus_31",
  );
});

test("validateJoinRoomInput rejects empty input", () => {
  assert.deepEqual(validateJoinRoomInput("   "), {
    normalized: null,
    error: "Enter an invite code or room URL.",
  });
});

test("validateJoinRoomInput rejects foreign absolute URLs", () => {
  assert.deepEqual(validateJoinRoomInput("https://example.com/x"), {
    normalized: null,
    error: "Use an invite code or a LetAgents room URL.",
  });
  assert.equal(validateJoinRoomInput("https://letagents.chat/in/ABCD-1234").normalized, "ABCD-1234");
  assert.equal(validateJoinRoomInput("ABCD-1234").normalized, "ABCD-1234");
  assert.equal(validateJoinRoomInput("/in/focus_31").normalized, "focus_31");
});

test("new room modal starts on chooser and navigates intents", () => {
  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: () => undefined,
    setRepoStatus: () => undefined,
    getDefaultStorageMode: () => "cloud",
  });

  modal.selectNewRoomEntry();
  assert.equal(modal.newRoomModalOpen.value, true);
  assert.equal(modal.newRoomStep.value, "chooser");
  assert.equal(modal.newRoomStorage.value, "cloud");
  assert.ok(modal.newRoomName.value.length > 0);

  modal.chooseStandaloneIntent();
  assert.equal(modal.newRoomStep.value, "standalone");

  modal.backFromSubstep();
  assert.equal(modal.newRoomStep.value, "chooser");

  modal.chooseJoinIntent();
  assert.equal(modal.newRoomStep.value, "join");
});

test("shared create patches stale snapshot name after successful rename", async () => {
  const opened: Array<{
    snapshot: DesktopRoomSnapshot;
    options?: { displayName?: string | null };
  }> = [];
  const creationSnapshot = snapshotFixture("room_1", "Generated Room", "ABCD-9999");

  stubDesktopBridge({
    createInviteRoom: async () => ({
      roomIdentifier: "room_1",
      code: "ABCD-9999",
      snapshot: creationSnapshot,
    }),
    rename: async (_roomIdentifier: string, displayName: string) => ({
      identifier: "room_1",
      code: "ABCD-9999",
      name: displayName,
      displayName,
    }),
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: (snapshot, options) => opened.push({ snapshot, options }),
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseStandaloneIntent();
  modal.newRoomName.value = "Team sync";
  modal.newRoomStorage.value = "cloud";
  await modal.createStandaloneRoom();

  assert.equal(modal.newRoomStep.value, "success");
  assert.equal(modal.newRoomSuccess.value?.roomName, "Team sync");
  assert.equal(modal.newRoomSuccess.value?.snapshot.room?.displayName, "Team sync");
  assert.notEqual(modal.newRoomSuccess.value?.snapshot.room?.displayName, "Generated Room");
  assert.equal(modal.newRoomSuccess.value?.openOptions.displayName, "Team sync");

  modal.openSuccessRoom();
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.options?.displayName, "Team sync");
  assert.equal(opened[0]?.snapshot.room?.displayName, "Team sync");
});

test("shared create keeps invite code when rename fails and surfaces warning", async () => {
  stubDesktopBridge({
    createInviteRoom: async () => ({
      roomIdentifier: "room_2",
      code: "WXYZ-1111",
      snapshot: snapshotFixture("room_2", "Generated Room", "WXYZ-1111"),
    }),
    rename: async () => {
      throw new Error("rename unavailable");
    },
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: () => undefined,
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseStandaloneIntent();
  modal.newRoomName.value = "Team sync";
  modal.newRoomStorage.value = "cloud";
  await modal.createStandaloneRoom();

  assert.equal(modal.newRoomStep.value, "success");
  assert.equal(modal.newRoomSuccess.value?.inviteCode, "WXYZ-1111");
  assert.equal(modal.newRoomSuccess.value?.roomName, "Generated Room");
  assert.match(modal.newRoomFeedback.value || "", /renaming failed/i);
  assert.equal(modal.newRoomFeedbackState.value, "info");
  assert.equal(modal.newRoomBusy.value, false);

  // Success with naming warning is not an error-step retry trap; Back returns to chooser.
  modal.backFromSubstep();
  assert.equal(modal.newRoomStep.value, "chooser");
  assert.equal(modal.newRoomSuccess.value, null);
});

test("create local standalone room lands on success without invite code", async () => {
  const snapshot = snapshotFixture("local_abc", "Private notes");
  stubDesktopBridge({
    createLocalRoom: async (input?: { displayName?: string | null }) => ({
      roomIdentifier: "local_abc",
      snapshot: {
        ...snapshot,
        room: {
          ...snapshot.room!,
          displayName: input?.displayName || "Local room",
        },
      },
    }),
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: () => undefined,
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseStandaloneIntent();
  modal.newRoomName.value = "Private notes";
  modal.newRoomStorage.value = "local";
  await modal.createStandaloneRoom();

  assert.equal(modal.newRoomStep.value, "success");
  assert.equal(modal.newRoomSuccess.value?.kind, "local");
  assert.equal(modal.newRoomSuccess.value?.inviteCode, null);
  assert.equal(modal.newRoomSuccess.value?.roomName, "Private notes");
});

test("join normalizes input and opens on ready access", async () => {
  const opened: Array<{ meta?: string | null }> = [];
  stubDesktopBridge({
    getSnapshot: async (code: string) => {
      assert.equal(code, "ABCD-1234");
      return snapshotFixture("room_join", "Joined", "ABCD-1234");
    },
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: (_snapshot, options) => opened.push(options || {}),
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseJoinIntent();
  modal.newRoomJoinCode.value = "https://letagents.chat/in/abcd-1234";
  await modal.joinRoomCodeFromModal();

  assert.equal(opened.length, 1);
  assert.equal(modal.newRoomModalOpen.value, false);
});

test("join access failure keeps form values and shows error step", async () => {
  stubDesktopBridge({
    getSnapshot: async () => ({
      ...snapshotFixture("room_denied", "Denied"),
      access: {
        status: "denied",
        message: "You need access to that room.",
        reason: "forbidden",
      },
    }),
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: () => undefined,
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseJoinIntent();
  modal.newRoomJoinCode.value = "ABCD-1234";
  await modal.joinRoomCodeFromModal();

  assert.equal(modal.newRoomStep.value, "error");
  assert.match(modal.newRoomFeedback.value || "", /access/i);
  assert.equal(modal.newRoomJoinCode.value, "ABCD-1234");
  assert.equal(modal.newRoomModalOpen.value, true);
});

test("join rejects foreign absolute URLs before snapshot lookup", async () => {
  let snapshotCalls = 0;
  stubDesktopBridge({
    getSnapshot: async () => {
      snapshotCalls += 1;
      return snapshotFixture("should-not-run", "Nope");
    },
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: () => undefined,
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseJoinIntent();
  modal.newRoomJoinCode.value = "https://example.com/x";
  assert.equal(modal.canSubmitJoin.value, false);
  await modal.joinRoomCodeFromModal();
  assert.equal(snapshotCalls, 0);
  assert.equal(modal.newRoomJoinError.value, "Use an invite code or a LetAgents room URL.");
  assert.equal(modal.newRoomStep.value, "join");
});

test("busy state blocks close and duplicate submit", async () => {
  let resolveCreate: ((value: unknown) => void) | null = null;
  stubDesktopBridge({
    createInviteRoom: () =>
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: () => undefined,
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseStandaloneIntent();
  const first = modal.createStandaloneRoom();
  assert.equal(modal.newRoomBusy.value, true);
  assert.equal(modal.newRoomStep.value, "working");

  modal.closeNewRoomModal();
  assert.equal(modal.newRoomModalOpen.value, true);

  const second = modal.createStandaloneRoom();
  await second;

  resolveCreate?.({
    roomIdentifier: "room_1",
    code: "ABCD-1111",
    snapshot: snapshotFixture("room_1", "Room", "ABCD-1111"),
  });
  await first;
  assert.equal(modal.newRoomStep.value, "success");
});

test("project cancel returns to project step without losing modal", async () => {
  stubDesktopBridge({
    pickRoom: async () => ({
      canceled: true,
      repoPath: null,
      repoStatus: null,
      roomIdentifier: null,
      source: null,
      snapshot: null,
      error: null,
      warning: null,
    }),
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: () => undefined,
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseProjectIntent();
  await modal.openProjectRoomFromModal();
  assert.equal(modal.newRoomStep.value, "project");
  assert.equal(modal.newRoomModalOpen.value, true);
  assert.equal(modal.newRoomProjectSelection.value, null);
});

function snapshotFixture(
  identifier: string,
  displayName: string,
  code?: string,
): DesktopRoomSnapshot {
  return {
    roomIdentifier: identifier,
    room: {
      identifier,
      id: identifier,
      name: displayName,
      displayName,
      code: code || null,
      kind: "room",
    },
    access: {
      status: "ready",
      message: null,
      reason: null,
    },
    messages: [],
    tasks: [],
    participants: [],
    agents: [],
    focusRooms: [],
    githubEvents: [],
    githubIntegration: null,
    board: null,
    artifacts: [],
  } as unknown as DesktopRoomSnapshot;
}

function stubDesktopBridge(input: {
  createInviteRoom?: () => Promise<unknown>;
  createLocalRoom?: (input?: { displayName?: string | null }) => Promise<unknown>;
  getSnapshot?: (code: string) => Promise<DesktopRoomSnapshot>;
  pickRoom?: () => Promise<unknown>;
  rename?: (roomIdentifier: string, displayName: string) => Promise<unknown>;
}): void {
  const existing = (globalThis as { window?: unknown }).window as
    | { letagentsDesktop?: Record<string, unknown> }
    | undefined;
  const root = existing || ((globalThis as { window: Record<string, unknown> }).window = {});
  const desktop = (root.letagentsDesktop || {}) as Record<string, unknown>;
  desktop.room = {
    ...((desktop.room as object) || {}),
    createInviteRoom: input.createInviteRoom,
    getSnapshot: input.getSnapshot,
    rename: input.rename,
  };
  desktop.chatStorage = {
    ...((desktop.chatStorage as object) || {}),
    createLocalRoom: input.createLocalRoom,
  };
  desktop.repos = {
    ...((desktop.repos as object) || {}),
    pickRoom: input.pickRoom,
  };
  root.letagentsDesktop = desktop;
  (globalThis as { window: unknown }).window = root;
}

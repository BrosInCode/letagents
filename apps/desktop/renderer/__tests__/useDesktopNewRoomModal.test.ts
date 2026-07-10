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

test("create shared standalone room lands on success with invite code", async () => {
  const opened: unknown[] = [];
  const renamed: Array<[string, string]> = [];
  const snapshot = snapshotFixture("room_1", "Team sync", "ABCD-9999");

  stubDesktopBridge({
    createInviteRoom: async () => ({
      roomIdentifier: "room_1",
      code: "ABCD-9999",
      snapshot,
    }),
    rename: async (roomIdentifier: string, displayName: string) => {
      renamed.push([roomIdentifier, displayName]);
    },
  });

  const modal = useDesktopNewRoomModal({
    openRoomSnapshot: (next) => opened.push(next),
    setRepoStatus: () => undefined,
  });

  modal.selectNewRoomEntry();
  modal.chooseStandaloneIntent();
  modal.newRoomName.value = "Team sync";
  modal.newRoomStorage.value = "cloud";

  await modal.createStandaloneRoom();

  assert.equal(modal.newRoomStep.value, "success");
  assert.equal(modal.newRoomSuccess.value?.kind, "shared");
  assert.equal(modal.newRoomSuccess.value?.inviteCode, "ABCD-9999");
  assert.equal(modal.newRoomBusy.value, false);
  assert.deepEqual(renamed, [["room_1", "Team sync"]]);
  assert.equal(opened.length, 0);

  modal.openSuccessRoom();
  assert.equal(opened.length, 1);
  assert.equal(modal.newRoomModalOpen.value, false);
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

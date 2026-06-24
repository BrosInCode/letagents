import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Buffer } from "node:buffer";

import type {
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
  DesktopChatStorageSettings,
} from "../ipc-types.js";
import {
  createAppActionRegistry,
  createAppAgentActionTrace,
} from "../main/app-agent/action-registry.js";
import {
  getAppAgentSettingsStatus,
  readAppAgentSettings,
  saveAppAgentSettings,
} from "../main/app-agent/settings.js";
import {
  listDesktopAppAgentActions,
  runDesktopAppAgent,
} from "../main/app-agent/runner.js";

function room(
  overrides: Partial<DesktopAccountRoomEntry> = {},
): DesktopAccountRoomEntry {
  return {
    roomIdentifier: "room_1",
    displayName: "LetAgents",
    name: "LetAgents",
    kind: "main",
    parentRoomId: null,
    focusKey: null,
    sourceTaskId: null,
    focusStatus: null,
    role: "participant",
    source: "open_room",
    pinned: false,
    archived: false,
    canLeave: true,
    canDelete: false,
    deleteReason: null,
    firstOpenedAt: "2026-06-16T10:00:00.000Z",
    lastOpenedAt: "2026-06-16T10:00:00.000Z",
    latestMessageId: null,
    latestMessageAt: null,
    focusRooms: [],
    ...overrides,
  };
}

function chatStorageSettings(
  mode: DesktopChatStorageSettings["mode"] = "cloud",
): DesktopChatStorageSettings {
  return {
    mode,
    defaultMode: mode,
    roomOverrides: {},
    databasePath: "/tmp/local-chat.sqlite",
    localFilesPath: "/tmp/local-files",
    settingsPath: "/tmp/chat-storage.json",
    savedAt: "2026-06-17T00:00:00.000Z",
  };
}

function mutableRoomStore(initialRooms: DesktopAccountRoomEntry[]) {
  const rooms = initialRooms.map((entry) => ({ ...entry }));
  return {
    rooms,
    listAccountRooms: async (options?: { includeArchived?: boolean }) =>
      rooms
        .filter((entry) => options?.includeArchived || !entry.archived)
        .map((entry) => ({ ...entry })),
    updateAccountRoom: async (
      roomIdentifier: string,
      updates: { pinned?: boolean; archived?: boolean },
    ): Promise<DesktopAccountRoomActionResult> => {
      const entry = rooms.find((roomEntry) => roomEntry.roomIdentifier === roomIdentifier);
      if (!entry) throw new Error(`Missing room ${roomIdentifier}`);
      if (updates.pinned !== undefined) entry.pinned = updates.pinned;
      if (updates.archived !== undefined) entry.archived = updates.archived;
      return { roomIdentifier, ...updates };
    },
  };
}

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "letagents-app-agent-"));
  return join(dir, "settings.json");
}

async function writePlainSettings(
  settingsPath: string,
  model = "anthropic/claude-3.5-sonnet",
): Promise<void> {
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        encryptedOpenRouterApiKey: "plain:openrouter-key",
        model,
        savedAt: "2026-06-17T00:00:00.000Z",
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function withSettingsEnv<T>(
  settingsPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env.LETAGENTS_APP_AGENT_SETTINGS_PATH;
  process.env.LETAGENTS_APP_AGENT_SETTINGS_PATH = settingsPath;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.LETAGENTS_APP_AGENT_SETTINGS_PATH;
    } else {
      process.env.LETAGENTS_APP_AGENT_SETTINGS_PATH = previous;
    }
    await rm(dirname(settingsPath), { recursive: true, force: true });
  }
}

test("App Agent settings encrypt and decrypt the OpenRouter key", async () => {
  const settingsPath = await tempSettingsPath();
  const secretStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`encrypted:${value}`, "utf8"),
    decryptString: (value: Buffer) =>
      value.toString("utf8").replace(/^encrypted:/, ""),
  };

  await saveAppAgentSettings(
    {
      openRouterApiKey: "openrouter-secret",
      model: "openai/gpt-4o-mini",
    },
    { storePath: settingsPath, secretStorage },
  );

  const raw = await readFile(settingsPath, "utf8");
  assert.doesNotMatch(raw, /openrouter-secret/);
  const settings = await readAppAgentSettings({
    storePath: settingsPath,
    secretStorage,
  });
  assert.equal(settings.openRouterApiKey, "openrouter-secret");
  assert.equal(settings.model, "openai/gpt-4o-mini");

  const status = await getAppAgentSettingsStatus({
    storePath: settingsPath,
    secretStorage,
  });
  assert.equal(status.configured, true);
  assert.equal(status.hasApiKey, true);
});

test("missing App Agent key returns a clear configuration error", async () => {
  const settingsPath = await tempSettingsPath();
  await withSettingsEnv(settingsPath, async () => {
    const result = await runDesktopAppAgent(
      { prompt: "Pin the LetAgents room." },
      {
        listAccountRooms: async () => [room()],
        updateAccountRoom: async () => {
          throw new Error("should not mutate");
        },
      },
    );
    assert.equal(result.state, "configuration_required");
    assert.match(result.message, /OpenRouter API key/);
  });
});

test("App Action Registry builds room and settings tools from metadata", async () => {
  const registry = createAppActionRegistry({
    listAccountRooms: async () => [room()],
    updateAccountRoom: async (roomIdentifier, updates) => ({ roomIdentifier, ...updates }),
    getChatStorageSettings: async () => chatStorageSettings(),
    setChatStorageMode: async (mode) => chatStorageSettings(mode),
    getAppAgentSettingsStatus: async () => ({
      configured: true,
      hasApiKey: true,
      model: "openai/gpt-4o-mini",
      savedAt: "2026-06-17T00:00:00.000Z",
      settingsPath: "/tmp/app-agent.json",
      error: null,
    }),
  });
  const actions = registry.list();
  assert.deepEqual(
    actions.map((action) => action.id).sort(),
    [
      "rooms.archive",
      "rooms.archive_many",
      "rooms.archive_unpinned",
      "rooms.list",
      "rooms.open",
      "rooms.pin",
      "rooms.pin_many",
      "settings.get",
      "settings.set_chat_storage_mode",
    ],
  );
  assert.equal(actions.find((action) => action.id === "rooms.archive")?.requiresConfirmation, true);
  assert.equal(actions.find((action) => action.id === "rooms.pin")?.risk, "low");
  assert.equal(registry.tools(createAppAgentActionTrace()).length, actions.length + 1);
});

test("App Agent action metadata is safe for the settings surface", () => {
  const actions = listDesktopAppAgentActions();
  const archiveAction = actions.find((action) => action.id === "rooms.archive");
  assert.ok(archiveAction);
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), actions);
  assert.equal(archiveAction.toolName, "set_room_archived");
  assert.equal(archiveAction.displayName, "Archive or restore a room");
  assert.equal(archiveAction.capabilityName, "Single-room archiving");
  assert.equal(
    archiveAction.displayDescription,
    "Moves one room out of active lists, or brings it back.",
  );
  assert.equal(archiveAction.category, "rooms");
  assert.equal(archiveAction.risk, "medium");
  assert.equal(archiveAction.requiresConfirmation, true);
  assert.deepEqual(archiveAction.refreshTargets, ["rooms", "active_room", "foreground"]);
});

test("rooms.open validates input and returns an open-room refresh result", async () => {
  const registry = createAppActionRegistry({
    listAccountRooms: async () => [
      room({ roomIdentifier: "room_open", displayName: "Open Me" }),
    ],
    updateAccountRoom: async (roomIdentifier, updates) => ({ roomIdentifier, ...updates }),
    getChatStorageSettings: async () => chatStorageSettings(),
    setChatStorageMode: async (mode) => chatStorageSettings(mode),
    getAppAgentSettingsStatus: async () => ({
      configured: true,
      hasApiKey: true,
      model: "openai/gpt-4o-mini",
      savedAt: "2026-06-17T00:00:00.000Z",
      settingsPath: "/tmp/app-agent.json",
      error: null,
    }),
  });
  const action = registry.actionReference("rooms.open", {
    roomIdentifier: "room_open",
  });
  assert.ok(action);
  const trace = createAppAgentActionTrace();
  const result = await registry.execute(action, { trace });
  assert.equal(result.openRoomIdentifier, "room_open");
  assert.deepEqual(result.refreshTargets, ["active_room", "foreground"]);
});

test("low-risk App Agent plan with five actions executes immediately", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore(
      Array.from({ length: 5 }, (_value, index) =>
        room({
          roomIdentifier: `room_${index + 1}`,
          displayName: `Room ${index + 1}`,
        }),
      ),
    );
    const calls: Array<{ roomIdentifier: string; pinned: boolean | undefined }> = [];
    const result = await runDesktopAppAgent(
      { prompt: "pin room 1, room 2, room 3, room 4, and room 5" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, pinned: updates.pinned });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async (_input, _settings, registry) => {
          const pendingPlan = await registry.preparePlanForDisplay({
            title: "Pin rooms",
            description: "Pin Room 1, Room 2, Room 3, Room 4, and Room 5.",
            actions: store.rooms.map((entry) => ({
              actionId: "rooms.pin",
              input: { roomIdentifier: entry.roomIdentifier, pinned: true },
            })),
          });
          return {
            state: "confirmation_required",
            message: pendingPlan.description,
            pendingPlan,
          };
        },
      },
    );

    assert.equal(result.state, "success");
    assert.equal(result.pendingPlan, undefined);
    assert.equal(result.executedActions?.length, 5);
    assert.deepEqual(
      calls,
      store.rooms.map((entry) => ({
        roomIdentifier: entry.roomIdentifier,
        pinned: true,
      })),
    );
  });
});

test("low-risk App Agent plan with six actions requires preview confirmation", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore(
      Array.from({ length: 6 }, (_value, index) =>
        room({
          roomIdentifier: `room_${index + 1}`,
          displayName: `Room ${index + 1}`,
        }),
      ),
    );
    const calls: string[] = [];
    const result = await runDesktopAppAgent(
      { prompt: "pin all six rooms" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push(`${roomIdentifier}:${updates.pinned}`);
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async (_input, _settings, registry) => {
          const pendingPlan = await registry.preparePlanForDisplay({
            title: "Pin rooms",
            description: "Pin six rooms.",
            actions: store.rooms.map((entry) => ({
              actionId: "rooms.pin",
              input: { roomIdentifier: entry.roomIdentifier, pinned: true },
            })),
          });
          return {
            state: "confirmation_required",
            message: pendingPlan.description,
            pendingPlan,
          };
        },
      },
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(result.pendingPlan?.actions.length, 6);
    assert.equal(result.pendingPlan?.risk, "low");
    assert.deepEqual(calls, []);
  });
});

test("App Agent plan display rejects missing single-room targets", async () => {
  const registry = createAppActionRegistry({
    listAccountRooms: async () => [
      room({ roomIdentifier: "room_1", displayName: "Room 1" }),
    ],
    updateAccountRoom: async (roomIdentifier, updates) => ({ roomIdentifier, ...updates }),
    getChatStorageSettings: async () => chatStorageSettings(),
    setChatStorageMode: async (mode) => chatStorageSettings(mode),
    getAppAgentSettingsStatus: async () => ({
      configured: true,
      hasApiKey: true,
      model: "openai/gpt-4o-mini",
      savedAt: "2026-06-17T00:00:00.000Z",
      settingsPath: "/tmp/app-agent.json",
      error: null,
    }),
  });

  await assert.rejects(
    () => registry.preparePlanForDisplay({
      title: "Pin missing room",
      description: "Pin a missing room.",
      actions: [
        {
          actionId: "rooms.pin",
          input: { roomIdentifier: "missing-room", pinned: true },
        },
      ],
    }),
    /I don't see a room called "missing-room"/,
  );
});

test("confirmed App Agent plan executes actions exactly once in order", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "dawn-marsh", displayName: "dawn-marsh" }),
      room({ roomIdentifier: "fern-river", displayName: "fern-river" }),
    ]);
    const calls: string[] = [];
    const result = await runDesktopAppAgent(
      {
        prompt: "pin dawn marsh and fern river",
        confirmedPlan: {
          planId: "plan_pin_two",
          title: "Pin rooms",
          description: "Pin dawn-marsh and fern-river.",
          actions: [
            {
              actionId: "rooms.pin",
              input: { roomIdentifier: "dawn-marsh", pinned: true },
              label: "Pin dawn-marsh",
              risk: "low",
            },
            {
              actionId: "rooms.pin",
              input: { roomIdentifier: "fern-river", pinned: true },
              label: "Pin fern-river",
              risk: "low",
            },
          ],
          risk: "low",
          confirmLabel: "Run",
          cancelLabel: "Cancel",
          refreshTargets: ["rooms", "active_room", "foreground"],
        },
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push(`${roomIdentifier}:${updates.pinned}`);
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async () => {
          throw new Error("confirmed plans should not call the model");
        },
      },
    );

    assert.equal(result.state, "success");
    assert.deepEqual(calls, ["dawn-marsh:true", "fern-river:true"]);
    assert.deepEqual(
      result.executedActions?.map((action) => [action.label, action.status]),
      [
        ["Pin dawn-marsh", "success"],
        ["Pin fern-river", "success"],
      ],
    );
  });
});

test("confirmed App Agent plan stops on failure with a safe execution journal", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "room_1", displayName: "Room 1" }),
      room({ roomIdentifier: "room_2", displayName: "Room 2" }),
      room({ roomIdentifier: "room_3", displayName: "Room 3" }),
    ]);
    const result = await runDesktopAppAgent(
      {
        prompt: "pin three rooms",
        confirmedPlan: {
          planId: "plan_failure",
          title: "Pin rooms",
          description: "Pin Room 1, Room 2, and Room 3.",
          actions: store.rooms.map((entry) => ({
            actionId: "rooms.pin",
            input: { roomIdentifier: entry.roomIdentifier, pinned: true },
            label: `Pin ${entry.displayName}`,
            risk: "low" as const,
          })),
          risk: "low",
          confirmLabel: "Run",
          cancelLabel: "Cancel",
          refreshTargets: ["rooms"],
        },
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          if (roomIdentifier === "room_2") {
            throw new Error("token secret should not leak");
          }
          return store.updateAccountRoom(roomIdentifier, updates);
        },
      },
    );

    assert.equal(result.state, "error");
    assert.equal(result.message, "Stopped after 1 of 3 actions.");
    assert.deepEqual(
      result.executedActions?.map((action) => action.status),
      ["success", "error", "skipped"],
    );
    assert.doesNotMatch(result.executedActions?.[1]?.message || "", /secret/);
  });
});

test("selected ambiguous room choice calls the room update helper", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const calls: Array<{ roomIdentifier: string; pinned: boolean | undefined }> = [];
    const store = mutableRoomStore([room()]);
    const result = await runDesktopAppAgent(
      {
        prompt: "Pin the LetAgents room.",
        selectedAction: {
          actionId: "rooms.pin",
          input: { roomIdentifier: "room_1", pinned: true },
          label: "Pin LetAgents",
          risk: "low",
        },
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, pinned: updates.pinned });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
      },
    );

    assert.equal(result.state, "success");
    assert.deepEqual(calls, [{ roomIdentifier: "room_1", pinned: true }]);
    assert.deepEqual(
      result.executedActions?.map((action) => [
        action.actionId,
        action.status,
        action.message,
        action.roomIdentifier,
        action.displayName,
      ]),
      [["rooms.pin", "success", "Pinned LetAgents.", "room_1", "LetAgents"]],
    );
  });
});

test("exact room name prompt goes through the model tool loop", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const calls: Array<{ roomIdentifier: string; pinned: boolean | undefined }> = [];
    const store = mutableRoomStore([
      room({ roomIdentifier: "shore-delta", displayName: "shore-delta" }),
    ]);
    let modelRan = false;
    const result = await runDesktopAppAgent(
      { prompt: "pin shore-delta" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, pinned: updates.pinned });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async (_input, _settings, registry, trace) => {
          modelRan = true;
          const action = registry.actionReference("rooms.pin", {
            roomIdentifier: "shore-delta",
            pinned: true,
          });
          assert.ok(action);
          const actionResult = await registry.execute(action, { trace });
          return {
            state: "success",
            message: "Pinned shore-delta.",
            roomIdentifier: actionResult.roomIdentifier,
            displayName: "shore-delta",
            pinned: true,
          };
        },
      },
    );

    assert.equal(result.state, "success");
    assert.equal(modelRan, true);
    assert.equal(result.message, "Pinned shore-delta.");
    assert.deepEqual(calls, [{ roomIdentifier: "shore-delta", pinned: true }]);
    assert.deepEqual(
      result.executedActions?.map((action) => [action.actionId, action.status, action.message]),
      [["rooms.pin", "success", "Pinned shore-delta."]],
    );
  });
});

test("deferred model room response retries with a tool-use correction", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const prompts: string[] = [];
    const result = await runDesktopAppAgent(
      { prompt: "open sky-lake room" },
      {
        listAccountRooms: async () => [
          room({ roomIdentifier: "sky-lake", displayName: "sky-lake" }),
        ],
        updateAccountRoom: async (roomIdentifier, updates) => ({ roomIdentifier, ...updates }),
        runAgent: async (input, _settings, registry, trace) => {
          prompts.push(input.prompt);
          if (prompts.length === 1) {
            return {
              state: "info",
              message:
                "I need to find the exact room you're referring to. Let me pull up your room list first.",
            };
          }
          const action = registry.actionReference("rooms.open", {
            roomIdentifier: "sky-lake",
          });
          assert.ok(action);
          const actionResult = await registry.execute(action, { trace });
          return {
            state: "success",
            message: actionResult.message,
            roomIdentifier: actionResult.roomIdentifier,
            displayName: actionResult.displayName,
            openRoomIdentifier: actionResult.openRoomIdentifier,
            refreshTargets: actionResult.refreshTargets,
          };
        },
      },
    );

    assert.equal(result.state, "success");
    assert.equal(result.openRoomIdentifier, "sky-lake");
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /previous response stopped before using tools/i);
    assert.ok(
      result.trace?.some((entry) => entry.label === "Model stopped before tool use"),
    );
  });
});

test("hallucinated pin success without set_room_pinned is rejected", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    let modelRuns = 0;
    const calls: Array<{ roomIdentifier: string; pinned: boolean | undefined }> = [];
    const result = await runDesktopAppAgent(
      { prompt: "pin sky lake" },
      {
        listAccountRooms: async () => [
          room({ roomIdentifier: "sky-lake", displayName: "sky-lake" }),
        ],
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, pinned: updates.pinned });
          return { roomIdentifier, pinned: updates.pinned };
        },
        runAgent: async () => {
          modelRuns += 1;
          return {
            state: "success",
            message: "Pinned the room 'sky-lake'.",
            roomIdentifier: "sky-lake",
            displayName: "sky-lake",
            pinned: true,
          };
        },
      },
    );

    assert.equal(result.state, "error");
    assert.equal(modelRuns, 2);
    assert.deepEqual(calls, []);
    assert.match(result.message, /stopped before completing the app tool path/i);
  });
});

test("repeated deferred model room responses return a real tool-use error", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    let modelRuns = 0;
    const result = await runDesktopAppAgent(
      { prompt: "open sky-lake room" },
      {
        listAccountRooms: async () => [
          room({ roomIdentifier: "sky-lake", displayName: "sky-lake" }),
        ],
        updateAccountRoom: async (roomIdentifier, updates) => ({ roomIdentifier, ...updates }),
        runAgent: async () => {
          modelRuns += 1;
          return {
            state: "info",
            message:
              "I need to find the exact room you're referring to. Let me pull up your room list first.",
          };
        },
      },
    );

    assert.equal(result.state, "error");
    assert.equal(modelRuns, 2);
    assert.match(result.message, /stopped before completing the app tool path/i);
  });
});

test("single high-confidence model fallback mutates through set_room_pinned", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const calls: Array<{ roomIdentifier: string; pinned: boolean | undefined }> = [];
    const store = mutableRoomStore([room()]);
    const result = await runDesktopAppAgent(
      { prompt: "Pin the repo room I opened yesterday." },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, pinned: updates.pinned });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async (_input, _settings, registry, trace) => {
          const action = registry.actionReference("rooms.pin", {
            roomIdentifier: "room_1",
            pinned: true,
          });
          assert.ok(action);
          const actionResult = await registry.execute(action, { trace });
          return {
            state: "success",
            message: "Pinned LetAgents.",
            roomIdentifier: actionResult.roomIdentifier,
            displayName: "LetAgents",
            pinned: true,
          };
        },
      },
    );

    assert.equal(result.state, "success");
    assert.deepEqual(calls, [{ roomIdentifier: "room_1", pinned: true }]);
  });
});

test("risky model action asks for confirmation before archive mutation", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const calls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const store = mutableRoomStore([
      room({ roomIdentifier: "room_rentals", displayName: "Rentals" }),
    ]);
    const result = await runDesktopAppAgent(
      { prompt: "Archive the rentals room." },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, archived: updates.archived });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async (_input, _settings, registry, trace) => {
          const action = registry.actionReference("rooms.archive", {
            roomIdentifier: "room_rentals",
            archived: true,
          });
          assert.ok(action);
          await registry.execute(action, { trace });
          const pendingAction = registry.pendingAction(action.actionId, action.input);
          return {
            state: "confirmation_required",
            message: pendingAction.description,
            pendingAction,
          };
        },
      },
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(result.pendingAction?.actionId, "rooms.archive");
    assert.deepEqual(calls, []);
  });
});

test("confirmed risky archive action mutates exactly once", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const calls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const store = mutableRoomStore([
      room({ roomIdentifier: "room_rentals", displayName: "Rentals" }),
    ]);
    const result = await runDesktopAppAgent(
      {
        prompt: "Archive the rentals room.",
        confirmedAction: {
          actionId: "rooms.archive",
          input: { roomIdentifier: "room_rentals", archived: true },
          label: "Archive Rentals",
          risk: "medium",
        },
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, archived: updates.archived });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
      },
    );

    assert.equal(result.state, "success");
    assert.equal(result.archived, true);
    assert.deepEqual(calls, [{ roomIdentifier: "room_rentals", archived: true }]);
    assert.deepEqual(
      result.executedActions?.map((action) => [
        action.actionId,
        action.status,
        action.message,
        action.roomIdentifier,
        action.displayName,
      ]),
      [["rooms.archive", "success", "Archived Rentals.", "room_rentals", "Rentals"]],
    );
  });
});

test("multiple-room archive asks once and confirmed action archives all rooms", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "ember-vista", displayName: "ember-vista" }),
      room({ roomIdentifier: "cedar-vista", displayName: "cedar-vista" }),
    ]);
    const pendingCalls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const pendingResult = await runDesktopAppAgent(
      { prompt: "archive ember vista and cedar vista rooms" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          pendingCalls.push({ roomIdentifier, archived: updates.archived });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async (_input, _settings, registry, trace) => {
          const action = registry.actionReference("rooms.archive_many", {
            roomIdentifiers: ["ember-vista", "cedar-vista"],
            archived: true,
          });
          assert.ok(action);
          await registry.execute(action, { trace });
          return {
            state: "confirmation_required",
            message: "Archive ember-vista and cedar-vista?",
            pendingAction: registry.pendingAction(action.actionId, action.input),
          };
        },
      },
    );

    assert.equal(pendingResult.state, "confirmation_required");
    assert.equal(pendingResult.pendingAction?.actionId, "rooms.archive_many");
    assert.deepEqual(pendingCalls, []);

    const confirmedCalls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const confirmedResult = await runDesktopAppAgent(
      {
        prompt: "archive ember vista and cedar vista rooms",
        confirmedAction: {
          actionId: "rooms.archive_many",
          input: {
            roomIdentifiers: ["ember-vista", "cedar-vista"],
            archived: true,
          },
          label: "Archive rooms",
          risk: "medium",
        },
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          confirmedCalls.push({ roomIdentifier, archived: updates.archived });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
      },
    );

    assert.equal(confirmedResult.state, "success");
    assert.deepEqual(confirmedCalls, [
      { roomIdentifier: "ember-vista", archived: true },
      { roomIdentifier: "cedar-vista", archived: true },
    ]);
    assert.equal(store.rooms.find((entry) => entry.roomIdentifier === "ember-vista")?.archived, true);
    assert.equal(store.rooms.find((entry) => entry.roomIdentifier === "cedar-vista")?.archived, true);
  });
});

test("multiple-room archive rejects a single-room tool path and retries", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "ember-vista", displayName: "ember-vista" }),
      room({ roomIdentifier: "cedar-vista", displayName: "cedar-vista" }),
    ]);
    const prompts: string[] = [];
    const result = await runDesktopAppAgent(
      { prompt: "archive ember vista and cedar vista rooms" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: store.updateAccountRoom,
        runAgent: async (input, _settings, registry, trace) => {
          prompts.push(input.prompt);
          if (prompts.length === 1) {
            const action = registry.actionReference("rooms.archive", {
              roomIdentifier: "ember-vista",
              archived: true,
            });
            assert.ok(action);
            await registry.execute(action, { trace });
            return {
              state: "confirmation_required",
              message: "Archive ember-vista?",
              pendingAction: registry.pendingAction(action.actionId, action.input),
            };
          }
          const action = registry.actionReference("rooms.archive_many", {
            roomIdentifiers: ["ember-vista", "cedar-vista"],
            archived: true,
          });
          assert.ok(action);
          await registry.execute(action, { trace });
          return {
            state: "confirmation_required",
            message: "Archive ember-vista and cedar-vista?",
            pendingAction: registry.pendingAction(action.actionId, action.input),
          };
        },
      },
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(result.pendingAction?.actionId, "rooms.archive_many");
    assert.equal(prompts.length, 2);
  });
});

test("pattern-based archive requires the batch room action", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "ember-vista", displayName: "ember-vista" }),
      room({ roomIdentifier: "cedar-vista", displayName: "cedar-vista" }),
      room({ roomIdentifier: "solar-garden", displayName: "solar-garden" }),
    ]);
    const prompts: string[] = [];
    const result = await runDesktopAppAgent(
      { prompt: "archive all room that have vista at the end of their names" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: store.updateAccountRoom,
        runAgent: async (input, _settings, registry, trace) => {
          prompts.push(input.prompt);
          if (prompts.length === 1) {
            const action = registry.actionReference("rooms.archive", {
              roomIdentifier: "ember-vista",
              archived: true,
            });
            assert.ok(action);
            await registry.execute(action, { trace });
            return {
              state: "confirmation_required",
              message: "Archive ember-vista?",
              pendingAction: registry.pendingAction(action.actionId, action.input),
            };
          }
          const action = registry.actionReference("rooms.archive_many", {
            roomIdentifiers: ["ember-vista", "cedar-vista"],
            archived: true,
          });
          assert.ok(action);
          await registry.execute(action, { trace });
          return {
            state: "confirmation_required",
            message: "Archive ember-vista and cedar-vista?",
            pendingAction: registry.pendingAction(action.actionId, action.input),
          };
        },
      },
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(result.pendingAction?.actionId, "rooms.archive_many");
    assert.equal(prompts.length, 2);
  });
});

test("archive confirmation displays room names instead of internal identifiers", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({
        roomIdentifier: "local-visual-fc0427aeb8",
        displayName: "ember-vista",
      }),
      room({
        roomIdentifier: "local-fbrf-186988c484",
        displayName: "cedar-vista",
      }),
      room({
        roomIdentifier: "3SFQ-C9G1-79NP",
        displayName: "solar-garden",
      }),
    ]);
    const result = await runDesktopAppAgent(
      { prompt: "archive ember vista, cedar and solar garden rooms" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: store.updateAccountRoom,
        runAgent: async (_input, _settings, registry, trace) => {
          const pendingAction = registry.pendingAction("rooms.archive_many", {
            roomIdentifiers: [
              "local-visual-fc0427aeb8",
              "local-fbrf-186988c484",
              "3SFQ-C9G1-79NP",
            ],
            archived: true,
          });
          trace.add("Confirmation needed", {
            status: "info",
            detail: "Archive 3 rooms",
            actionId: "rooms.archive_many",
          });
          return {
            state: "confirmation_required",
            message:
              "Please confirm to archive the rooms ember-vista, cedar-vista, and solar-garden.",
            pendingAction,
          };
        },
      },
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(
      result.pendingAction?.description,
      "Archive ember-vista, cedar-vista, and solar-garden?",
    );
    assert.doesNotMatch(result.pendingAction?.description || "", /local-|3SFQ/);
  });
});

test("archive all unpinned rooms is computed by Electron main", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "sky-lake", displayName: "sky-lake", pinned: true }),
      room({ roomIdentifier: "dawn-marsh", displayName: "dawn-marsh", pinned: true }),
      room({ roomIdentifier: "solar-garden", displayName: "solar-garden", pinned: false }),
      room({ roomIdentifier: "noble-wood", displayName: "noble-wood", pinned: false }),
    ]);
    const result = await runDesktopAppAgent(
      { prompt: "archive all rooms that are not pinned" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: store.updateAccountRoom,
        runAgent: async (_input, _settings, registry, trace) => {
          const pendingAction = registry.pendingAction("rooms.archive_unpinned", {
            excludeRoomIdentifiers: [],
            archived: true,
          });
          trace.add("Confirmation needed", {
            status: "info",
            detail: "Archive unpinned rooms",
            actionId: "rooms.archive_unpinned",
          });
          return {
            state: "confirmation_required",
            message: "Please confirm to archive all rooms that are not pinned.",
            pendingAction,
          };
        },
      },
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(result.pendingAction?.actionId, "rooms.archive_many");
    assert.deepEqual(result.pendingAction?.input, {
      roomIdentifiers: ["solar-garden", "noble-wood"],
      archived: true,
    });
    assert.equal(result.pendingPlan?.actions.length, 1);
    assert.equal(result.pendingPlan?.actions[0]?.actionId, "rooms.archive_many");
    assert.equal(result.pendingPlan?.risk, "medium");
    assert.equal(result.pendingAction?.description, "Archive solar-garden and noble-wood?");
  });
});

test("archive unpinned pendingAction freezes targets for legacy confirmations", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "sky-lake", displayName: "sky-lake", pinned: true }),
      room({ roomIdentifier: "solar-garden", displayName: "solar-garden", pinned: false }),
      room({ roomIdentifier: "noble-wood", displayName: "noble-wood", pinned: false }),
    ]);
    const preview = await runDesktopAppAgent(
      { prompt: "archive all rooms that are not pinned" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: store.updateAccountRoom,
        runAgent: async (_input, _settings, registry) => ({
          state: "confirmation_required",
          message: "Confirm archive.",
          pendingAction: registry.pendingAction("rooms.archive_unpinned", {
            excludeRoomIdentifiers: [],
            archived: true,
          }),
        }),
      },
    );

    assert.equal(preview.state, "confirmation_required");
    assert.equal(preview.pendingAction?.actionId, "rooms.archive_many");
    assert.deepEqual(preview.pendingAction?.input, {
      roomIdentifiers: ["solar-garden", "noble-wood"],
      archived: true,
    });

    const solar = store.rooms.find((entry) => entry.roomIdentifier === "solar-garden");
    if (solar) solar.pinned = true;
    store.rooms.push(room({
      roomIdentifier: "cedar-vista",
      displayName: "cedar-vista",
      pinned: false,
    }));

    const calls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const confirmed = await runDesktopAppAgent(
      {
        prompt: "archive all rooms that are not pinned",
        confirmedAction: preview.pendingAction,
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, archived: updates.archived });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async () => {
          throw new Error("legacy confirmed actions should not call the model");
        },
      },
    );

    assert.equal(confirmed.state, "success");
    assert.deepEqual(calls, [
      { roomIdentifier: "solar-garden", archived: true },
      { roomIdentifier: "noble-wood", archived: true },
    ]);
    assert.equal(store.rooms.find((entry) => entry.roomIdentifier === "cedar-vista")?.archived, false);
  });
});

test("archive unpinned confirmation freezes the resolved room targets", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "sky-lake", displayName: "sky-lake", pinned: true }),
      room({ roomIdentifier: "solar-garden", displayName: "solar-garden", pinned: false }),
      room({ roomIdentifier: "noble-wood", displayName: "noble-wood", pinned: false }),
    ]);
    const preview = await runDesktopAppAgent(
      { prompt: "archive all rooms that are not pinned" },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: store.updateAccountRoom,
        runAgent: async (_input, _settings, registry) => ({
          state: "confirmation_required",
          message: "Confirm archive.",
          pendingPlan: await registry.preparePlanForDisplay({
            title: "Archive unpinned rooms",
            description: "Archive solar-garden and noble-wood.",
            actions: [
              {
                actionId: "rooms.archive_unpinned",
                input: { excludeRoomIdentifiers: [], archived: true },
              },
            ],
          }),
        }),
      },
    );

    assert.equal(preview.state, "confirmation_required");
    assert.deepEqual(preview.pendingPlan?.actions[0]?.input, {
      roomIdentifiers: ["solar-garden", "noble-wood"],
      archived: true,
    });

    const solar = store.rooms.find((entry) => entry.roomIdentifier === "solar-garden");
    if (solar) solar.pinned = true;
    store.rooms.push(room({
      roomIdentifier: "cedar-vista",
      displayName: "cedar-vista",
      pinned: false,
    }));

    const calls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const confirmed = await runDesktopAppAgent(
      {
        prompt: "archive all rooms that are not pinned",
        confirmedPlan: preview.pendingPlan,
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, archived: updates.archived });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
        runAgent: async () => {
          throw new Error("confirmed plans should not call the model");
        },
      },
    );

    assert.equal(confirmed.state, "success");
    assert.deepEqual(calls, [
      { roomIdentifier: "solar-garden", archived: true },
      { roomIdentifier: "noble-wood", archived: true },
    ]);
    assert.equal(store.rooms.find((entry) => entry.roomIdentifier === "cedar-vista")?.archived, false);
  });
});

test("confirmed archive all unpinned rooms archives every unpinned room", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const store = mutableRoomStore([
      room({ roomIdentifier: "sky-lake", displayName: "sky-lake", pinned: true }),
      room({ roomIdentifier: "dawn-marsh", displayName: "dawn-marsh", pinned: true }),
      room({ roomIdentifier: "solar-garden", displayName: "solar-garden", pinned: false }),
      room({ roomIdentifier: "noble-wood", displayName: "noble-wood", pinned: false }),
    ]);
    const calls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const result = await runDesktopAppAgent(
      {
        prompt: "archive all rooms that are not pinned",
        confirmedAction: {
          actionId: "rooms.archive_unpinned",
          input: {
            excludeRoomIdentifiers: [],
            archived: true,
          },
          label: "Archive unpinned rooms",
          risk: "medium",
        },
      },
      {
        listAccountRooms: store.listAccountRooms,
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, archived: updates.archived });
          return store.updateAccountRoom(roomIdentifier, updates);
        },
      },
    );

    assert.equal(result.state, "success");
    assert.deepEqual(calls, [
      { roomIdentifier: "solar-garden", archived: true },
      { roomIdentifier: "noble-wood", archived: true },
    ]);
    assert.equal(store.rooms.find((entry) => entry.roomIdentifier === "sky-lake")?.archived, false);
    assert.equal(store.rooms.find((entry) => entry.roomIdentifier === "dawn-marsh")?.archived, false);
  });
});

test("archive unpinned rooms includes the active visible local room", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const result = await runDesktopAppAgent(
      {
        prompt: "archive the unpinned room",
        activeRoomIdentifier: "local_test_room",
        activeRoomDisplayName: "The Test Room",
        activeRoomPinned: false,
      },
      {
        listAccountRooms: async () => [],
        updateAccountRoom: async (roomIdentifier, updates) => ({ roomIdentifier, ...updates }),
        runAgent: async (_input, _settings, registry, trace) => {
          const pendingAction = await registry.pendingActionForDisplay("rooms.archive_unpinned", {
            excludeRoomIdentifiers: [],
            archived: true,
          });
          trace.add("Confirmation needed", {
            status: "info",
            detail: "Archive unpinned rooms",
            actionId: "rooms.archive_unpinned",
          });
          return {
            state: "confirmation_required",
            message: "Please confirm to archive the unpinned room.",
            pendingAction,
          };
        },
      },
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(result.pendingAction?.actionId, "rooms.archive_many");
    assert.equal(result.pendingPlan?.actions.length, 1);
    assert.equal(result.pendingAction?.description, "Archive The Test Room?");
  });
});

test("confirmed archive unpinned rooms can mutate the active visible local room", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    let archived = false;
    const calls: Array<{ roomIdentifier: string; archived: boolean | undefined }> = [];
    const activeRoom = () => room({
      roomIdentifier: "local_test_room",
      displayName: "The Test Room",
      pinned: false,
      archived,
      source: "local",
    });
    const result = await runDesktopAppAgent(
      {
        prompt: "archive the unpinned room",
        activeRoomIdentifier: "local_test_room",
        activeRoomDisplayName: "The Test Room",
        activeRoomPinned: false,
        confirmedAction: {
          actionId: "rooms.archive_unpinned",
          input: {
            excludeRoomIdentifiers: [],
            archived: true,
          },
          label: "Archive unpinned rooms",
          risk: "medium",
        },
      },
      {
        listAccountRooms: async (options) => options?.includeArchived && archived ? [activeRoom()] : [],
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, archived: updates.archived });
          if (updates.archived !== undefined) archived = updates.archived;
          return { roomIdentifier, ...updates };
        },
      },
    );

    assert.equal(result.state, "success");
    assert.deepEqual(calls, [{ roomIdentifier: "local_test_room", archived: true }]);
    assert.equal(archived, true);
    assert.equal(result.message, "Archived The Test Room.");
  });
});

test("confirmed chat storage action calls the settings helper once", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const calls: DesktopChatStorageSettings["mode"][] = [];
    const result = await runDesktopAppAgent(
      {
        prompt: "Switch chat storage to local.",
        confirmedAction: {
          actionId: "settings.set_chat_storage_mode",
          input: { mode: "local" },
          label: "Set chat storage to local",
          risk: "medium",
        },
      },
      {
        listAccountRooms: async () => [room()],
        updateAccountRoom: async (roomIdentifier, updates) => ({ roomIdentifier, ...updates }),
        getChatStorageSettings: async () => chatStorageSettings("cloud"),
        setChatStorageMode: async (mode) => {
          calls.push(mode);
          return chatStorageSettings(mode);
        },
      },
    );

    assert.equal(result.state, "success");
    assert.deepEqual(calls, ["local"]);
    assert.deepEqual(result.refreshTargets, ["settings", "active_room", "foreground"]);
  });
});

test("ambiguous model match returns choices without mutation", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    let mutated = false;
    const result = await runDesktopAppAgent(
      { prompt: "Pin the room about leases." },
      {
        listAccountRooms: async () => [
          room({ roomIdentifier: "room_1", displayName: "Rentals" }),
          room({ roomIdentifier: "room_2", displayName: "Rental Ops" }),
        ],
        updateAccountRoom: async (): Promise<DesktopAccountRoomActionResult> => {
          mutated = true;
          return { roomIdentifier: "room_1", pinned: true };
        },
        runAgent: async (_input, _settings, registry, trace) => {
          const listAction = registry.actionReference("rooms.list", {
            includeArchived: false,
          });
          assert.ok(listAction);
          await registry.execute(listAction, { trace });
          return {
            state: "choices",
            message: "Choose a room.",
            choices: [
              {
                choiceId: "rooms.pin:1",
                label: "Rentals",
                description: "Name match",
                actionId: "rooms.pin",
                input: { roomIdentifier: "room_1", pinned: true },
                risk: "low",
              },
              {
                choiceId: "rooms.pin:2",
                label: "Rental Ops",
                description: "Description match",
                actionId: "rooms.pin",
                input: { roomIdentifier: "room_2", pinned: true },
                risk: "low",
              },
            ],
          };
        },
      },
    );

    assert.equal(result.state, "choices");
    assert.equal(result.choices?.length, 2);
    assert.equal(mutated, false);
  });
});

test("model errors return safe UI messages", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const result = await runDesktopAppAgent(
      { prompt: "Pin the repo room I opened yesterday." },
      {
        listAccountRooms: async () => [room()],
        updateAccountRoom: async () => ({ roomIdentifier: "room_1", pinned: true }),
        runAgent: async () => {
          throw new Error("Authorization failed for bearer openrouter-secret");
        },
      },
    );

    assert.equal(result.state, "error");
    assert.doesNotMatch(result.message, /openrouter-secret/i);
    assert.doesNotMatch(JSON.stringify(result.trace || []), /openrouter-secret/i);
    assert.match(result.message, /OpenRouter configuration/);
  });
});

test("stalled model runs return a timeout error", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  const previousTimeout = process.env.LETAGENTS_APP_AGENT_TIMEOUT_MS;
  process.env.LETAGENTS_APP_AGENT_TIMEOUT_MS = "250";
  try {
    await withSettingsEnv(settingsPath, async () => {
      const startedAt = Date.now();
      const result = await runDesktopAppAgent(
        { prompt: "Open the handoff focus room." },
        {
          listAccountRooms: async () => [room()],
          updateAccountRoom: async () => ({ roomIdentifier: "room_1" }),
          runAgent: async () => new Promise(() => undefined),
        },
      );

      assert.equal(result.state, "error");
      assert.match(result.message, /timed out/i);
      assert.ok(Date.now() - startedAt < 2_000);
    });
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.LETAGENTS_APP_AGENT_TIMEOUT_MS;
    } else {
      process.env.LETAGENTS_APP_AGENT_TIMEOUT_MS = previousTimeout;
    }
  }
});

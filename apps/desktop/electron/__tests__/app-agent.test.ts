import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Buffer } from "node:buffer";

import type {
  DesktopAccountRoomActionResult,
  DesktopAccountRoomEntry,
} from "../ipc-types.js";
import {
  getAppAgentSettingsStatus,
  readAppAgentSettings,
  saveAppAgentSettings,
} from "../main/app-agent/settings.js";
import { runDesktopAppAgent } from "../main/app-agent/runner.js";

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

test("selected ambiguous room choice calls the room update helper", async () => {
  const settingsPath = await tempSettingsPath();
  await withSettingsEnv(settingsPath, async () => {
    const calls: Array<{ roomIdentifier: string; pinned: boolean | undefined }> = [];
    const result = await runDesktopAppAgent(
      {
        prompt: "Pin the LetAgents room.",
        selectedRoomIdentifier: "room_1",
        selectedPinned: true,
      },
      {
        listAccountRooms: async () => [room()],
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, pinned: updates.pinned });
          return { roomIdentifier, pinned: updates.pinned };
        },
      },
    );

    assert.equal(result.state, "success");
    assert.deepEqual(calls, [{ roomIdentifier: "room_1", pinned: true }]);
  });
});

test("single high-confidence model match mutates through set_room_pinned", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    const calls: Array<{ roomIdentifier: string; pinned: boolean | undefined }> = [];
    const result = await runDesktopAppAgent(
      { prompt: "Pin the LetAgents room." },
      {
        listAccountRooms: async () => [room()],
        updateAccountRoom: async (roomIdentifier, updates) => {
          calls.push({ roomIdentifier, pinned: updates.pinned });
          return { roomIdentifier, pinned: updates.pinned };
        },
        runAgent: async (_input, _settings, tools) => {
          const actionResult = await tools.updateAccountRoom("room_1", {
            pinned: true,
          });
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

test("ambiguous model match returns choices without mutation", async () => {
  const settingsPath = await tempSettingsPath();
  await writePlainSettings(settingsPath);
  await withSettingsEnv(settingsPath, async () => {
    let mutated = false;
    const result = await runDesktopAppAgent(
      { prompt: "Pin the rentals room." },
      {
        listAccountRooms: async () => [
          room({ roomIdentifier: "room_1", displayName: "Rentals" }),
          room({ roomIdentifier: "room_2", displayName: "Rental Ops" }),
        ],
        updateAccountRoom: async (): Promise<DesktopAccountRoomActionResult> => {
          mutated = true;
          return { roomIdentifier: "room_1", pinned: true };
        },
        runAgent: async () => ({
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
            {
              roomIdentifier: "room_2",
              displayName: "Rental Ops",
              reason: "Description match",
              pinned: false,
              desiredPinned: true,
              lastOpenedAt: null,
            },
          ],
        }),
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
      { prompt: "Pin the LetAgents room." },
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
    assert.match(result.message, /OpenRouter configuration/);
  });
});

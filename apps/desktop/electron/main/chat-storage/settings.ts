import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopChatStorageSettings,
  DesktopRoomStorageOverrideMode,
  DesktopRoomStorageState,
} from "../../ipc-types.js";

export type ChatStorageMode = DesktopChatStorageSettings["mode"];
export type RoomStorageOverrideMode = DesktopRoomStorageOverrideMode;

const validModes = new Set<ChatStorageMode>(["cloud", "local"]);
const validRoomOverrideModes = new Set<RoomStorageOverrideMode>([
  "inherit",
  "cloud",
  "local",
]);

export const chatStorageSettingsPath =
  process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH?.trim() ||
  join(homedir(), ".letagents", "chat-storage.json");

export const localChatDatabasePath =
  process.env.LETAGENTS_LOCAL_CHAT_DB?.trim() ||
  join(homedir(), ".letagents", "local-chat.sqlite");

export const localFilesPath =
  process.env.LETAGENTS_LOCAL_FILES_DIR?.trim() ||
  join(homedir(), ".letagents", "local-files");

export const localProfilePath =
  process.env.LETAGENTS_LOCAL_PROFILE_PATH?.trim() ||
  join(homedir(), ".letagents", "local-profile.json");

type PersistedChatStorageSettings = {
  mode?: string;
  defaultMode?: string;
  roomOverrides?: Record<string, unknown>;
  savedAt?: string;
};

type PersistedLocalProfile = {
  id?: string;
  createdAt?: string;
};

let localProfileIdPromise: Promise<string> | null = null;

function normalizeChatStorageMode(value: unknown): ChatStorageMode {
  return typeof value === "string" && validModes.has(value as ChatStorageMode)
    ? (value as ChatStorageMode)
    : "cloud";
}

function normalizeRoomOverrideMode(
  value: unknown,
): RoomStorageOverrideMode {
  return typeof value === "string" &&
    validRoomOverrideModes.has(value as RoomStorageOverrideMode)
    ? (value as RoomStorageOverrideMode)
    : "inherit";
}

function normalizeRoomOverrides(
  value: unknown,
): Record<string, RoomStorageOverrideMode> {
  if (!value || typeof value !== "object") return {};
  const overrides: Record<string, RoomStorageOverrideMode> = {};
  for (const [roomIdentifier, rawMode] of Object.entries(value)) {
    const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
    const normalizedMode = normalizeRoomOverrideMode(rawMode);
    if (!normalizedRoomIdentifier || normalizedMode === "inherit") continue;
    overrides[normalizedRoomIdentifier] = normalizedMode;
  }
  return overrides;
}

function normalizeRoomIdentifier(roomIdentifier: string): string {
  return roomIdentifier.trim();
}

function buildSettings(input: {
  mode: ChatStorageMode;
  roomOverrides?: Record<string, RoomStorageOverrideMode>;
  savedAt?: string | null;
}): DesktopChatStorageSettings {
  return {
    mode: input.mode,
    defaultMode: input.mode,
    roomOverrides: input.roomOverrides || {},
    databasePath: localChatDatabasePath,
    localFilesPath,
    settingsPath: chatStorageSettingsPath,
    savedAt: input.savedAt || new Date(0).toISOString(),
  };
}

export async function readChatStorageSettings(): Promise<DesktopChatStorageSettings> {
  try {
    const raw = await readFile(chatStorageSettingsPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedChatStorageSettings;
    const mode = normalizeChatStorageMode(parsed.defaultMode ?? parsed.mode);
    return buildSettings({
      mode,
      roomOverrides: normalizeRoomOverrides(parsed.roomOverrides),
      savedAt: parsed.savedAt,
    });
  } catch {
    return buildSettings({ mode: "cloud" });
  }
}

export async function readLocalProfileId(): Promise<string> {
  localProfileIdPromise ??= readOrCreateLocalProfileId().catch((error: unknown) => {
    localProfileIdPromise = null;
    throw error;
  });
  return localProfileIdPromise;
}

async function readPersistedLocalProfileId(): Promise<string | null> {
  try {
    const raw = await readFile(localProfilePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedLocalProfile;
    const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
    if (id) return id;
  } catch {
    // Missing profile files are expected on first launch.
  }
  return null;
}

async function readOrCreateLocalProfileId(): Promise<string> {
  const existingId = await readPersistedLocalProfileId();
  if (existingId) return existingId;
  const id = randomUUID();
  await mkdir(dirname(localProfilePath), { recursive: true });
  try {
    await writeLocalProfileId(id, "wx");
  } catch (error) {
    if (!isFileExistsError(error)) throw error;
    const racedId = await readPersistedLocalProfileId();
    if (racedId) return racedId;
    await writeLocalProfileId(id);
  }
  return id;
}

async function writeLocalProfileId(id: string, flag?: "wx"): Promise<void> {
  await writeFile(
    localProfilePath,
    `${JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: "utf8", ...(flag ? { flag } : {}) },
  );
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

async function writeChatStorageSettings(
  settings: DesktopChatStorageSettings,
): Promise<DesktopChatStorageSettings> {
  const next = {
    mode: settings.mode,
    defaultMode: settings.defaultMode,
    roomOverrides: settings.roomOverrides,
    savedAt: new Date().toISOString(),
  } satisfies PersistedChatStorageSettings;
  await mkdir(dirname(chatStorageSettingsPath), { recursive: true });
  await writeFile(chatStorageSettingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return buildSettings({
    mode: normalizeChatStorageMode(next.defaultMode ?? next.mode),
    roomOverrides: normalizeRoomOverrides(next.roomOverrides),
    savedAt: next.savedAt,
  });
}

export async function setChatStorageMode(
  mode: ChatStorageMode,
): Promise<DesktopChatStorageSettings> {
  const normalizedMode = normalizeChatStorageMode(mode);
  const current = await readChatStorageSettings();
  return writeChatStorageSettings({
    ...current,
    mode: normalizedMode,
    defaultMode: normalizedMode,
  });
}

export async function isLocalChatStorageEnabled(): Promise<boolean> {
  return (await readChatStorageSettings()).mode === "local";
}

export async function setRoomStorageMode(
  roomIdentifier: string,
  mode: RoomStorageOverrideMode,
): Promise<DesktopRoomStorageState> {
  const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier);
  if (!normalizedRoomIdentifier) {
    throw new Error("Choose a room before changing storage mode.");
  }
  const normalizedMode = normalizeRoomOverrideMode(mode);
  const current = await readChatStorageSettings();
  const roomOverrides = { ...current.roomOverrides };
  if (normalizedMode === "inherit") {
    delete roomOverrides[normalizedRoomIdentifier];
  } else {
    roomOverrides[normalizedRoomIdentifier] = normalizedMode;
  }
  await writeChatStorageSettings({
    ...current,
    roomOverrides,
  });
  return resolveRoomStorageMode(normalizedRoomIdentifier);
}

export async function resolveRoomStorageMode(
  roomIdentifier?: string | null,
): Promise<DesktopRoomStorageState> {
  const normalizedRoomIdentifier = normalizeRoomIdentifier(roomIdentifier || "");
  const settings = await readChatStorageSettings();
  const overrideMode = normalizedRoomIdentifier
    ? settings.roomOverrides[normalizedRoomIdentifier] || "inherit"
    : "inherit";
  const effectiveMode =
    overrideMode === "inherit" ? settings.defaultMode : overrideMode;
  return {
    roomIdentifier: normalizedRoomIdentifier || null,
    defaultMode: settings.defaultMode,
    overrideMode,
    effectiveMode,
    isLocalRoom: effectiveMode === "local",
    localRoom: null,
    databasePath: localChatDatabasePath,
    localFilesPath,
  };
}

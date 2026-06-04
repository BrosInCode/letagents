import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { DesktopChatStorageSettings } from "../../ipc-types.js";

export type ChatStorageMode = DesktopChatStorageSettings["mode"];

const validModes = new Set<ChatStorageMode>(["cloud", "local"]);

export const chatStorageSettingsPath =
  process.env.LETAGENTS_CHAT_STORAGE_SETTINGS_PATH?.trim() ||
  join(homedir(), ".letagents", "chat-storage.json");

export const localChatDatabasePath =
  process.env.LETAGENTS_LOCAL_CHAT_DB?.trim() ||
  join(homedir(), ".letagents", "local-chat.sqlite");

type PersistedChatStorageSettings = {
  mode?: string;
  savedAt?: string;
};

function normalizeChatStorageMode(value: unknown): ChatStorageMode {
  return typeof value === "string" && validModes.has(value as ChatStorageMode)
    ? (value as ChatStorageMode)
    : "cloud";
}

function buildSettings(input: {
  mode: ChatStorageMode;
  savedAt?: string | null;
}): DesktopChatStorageSettings {
  return {
    mode: input.mode,
    databasePath: localChatDatabasePath,
    settingsPath: chatStorageSettingsPath,
    savedAt: input.savedAt || new Date(0).toISOString(),
  };
}

export async function readChatStorageSettings(): Promise<DesktopChatStorageSettings> {
  try {
    const raw = await readFile(chatStorageSettingsPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedChatStorageSettings;
    return buildSettings({
      mode: normalizeChatStorageMode(parsed.mode),
      savedAt: parsed.savedAt,
    });
  } catch {
    return buildSettings({ mode: "cloud" });
  }
}

export async function setChatStorageMode(
  mode: ChatStorageMode,
): Promise<DesktopChatStorageSettings> {
  const normalizedMode = normalizeChatStorageMode(mode);
  const next = {
    mode: normalizedMode,
    savedAt: new Date().toISOString(),
  } satisfies PersistedChatStorageSettings;
  await mkdir(dirname(chatStorageSettingsPath), { recursive: true });
  await writeFile(chatStorageSettingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return buildSettings(next);
}

export async function isLocalChatStorageEnabled(): Promise<boolean> {
  return (await readChatStorageSettings()).mode === "local";
}

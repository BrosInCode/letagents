import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopAppAgentSaveSettingsInput,
  DesktopAppAgentSettingsStatus,
} from "../../ipc-types.js";

export const DEFAULT_APP_AGENT_OPENROUTER_MODEL =
  "anthropic/claude-3.5-sonnet";

const require = createRequire(import.meta.url);

interface AppAgentSecretStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

interface AppAgentSettingsStoreOptions {
  storePath?: string;
  secretStorage?: AppAgentSecretStorage;
}

interface StoredAppAgentSettings {
  enabled: boolean;
  openRouterApiKey: string | null;
  model: string;
  savedAt: string | null;
}

interface PersistedAppAgentSettings {
  enabled?: boolean;
  encryptedOpenRouterApiKey?: string | null;
  model?: string | null;
  savedAt?: string | null;
}

function getElectronMain(): {
  app?: { getPath: (name: "userData") => string };
  safeStorage?: AppAgentSecretStorage;
} {
  try {
    const electron = require("electron") as unknown;
    return typeof electron === "object" && electron !== null
      ? electron as {
          app?: { getPath: (name: "userData") => string };
          safeStorage?: AppAgentSecretStorage;
        }
      : {};
  } catch {
    return {};
  }
}

function defaultSecretStorage(): AppAgentSecretStorage {
  const electronSafeStorage = getElectronMain().safeStorage;
  if (electronSafeStorage) return electronSafeStorage;
  return {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
}

export function getAppAgentSettingsStorePath(
  options: AppAgentSettingsStoreOptions = {},
): string {
  return (
    options.storePath ||
    process.env.LETAGENTS_APP_AGENT_SETTINGS_PATH ||
    join(
      getElectronMain().app?.getPath("userData") || homedir(),
      "letagents-desktop-app-agent.json",
    )
  );
}

function encryptSecret(
  value: string | null,
  secretStorage: AppAgentSecretStorage,
): string | null {
  if (!value) return null;
  if (!secretStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable, so the OpenRouter API key was not saved.");
  }
  return `safe:${secretStorage.encryptString(value).toString("base64")}`;
}

function decryptSecret(
  encryptedValue: string | null | undefined,
  secretStorage: AppAgentSecretStorage,
): string | null {
  if (!encryptedValue) return null;
  if (encryptedValue.startsWith("plain:")) {
    return encryptedValue.slice("plain:".length) || null;
  }
  if (
    !encryptedValue.startsWith("safe:") ||
    !secretStorage.isEncryptionAvailable()
  ) {
    return null;
  }
  try {
    return secretStorage.decryptString(
      Buffer.from(encryptedValue.slice("safe:".length), "base64"),
    );
  } catch {
    return null;
  }
}

function normalizeModel(model: string | null | undefined): string {
  return model?.trim() || DEFAULT_APP_AGENT_OPENROUTER_MODEL;
}

export async function readAppAgentSettings(
  options: AppAgentSettingsStoreOptions = {},
): Promise<StoredAppAgentSettings> {
  const settingsPath = getAppAgentSettingsStorePath(options);
  const secretStorage = options.secretStorage || defaultSecretStorage();
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedAppAgentSettings;
    return {
      enabled: parsed.enabled === true,
      openRouterApiKey: decryptSecret(
        parsed.encryptedOpenRouterApiKey,
        secretStorage,
      ),
      model: normalizeModel(parsed.model),
      savedAt: parsed.savedAt || null,
    };
  } catch {
    return {
      enabled: false,
      openRouterApiKey: null,
      model: DEFAULT_APP_AGENT_OPENROUTER_MODEL,
      savedAt: null,
    };
  }
}

export async function saveAppAgentSettings(
  input: DesktopAppAgentSaveSettingsInput,
  options: AppAgentSettingsStoreOptions = {},
): Promise<DesktopAppAgentSettingsStatus> {
  const current = await readAppAgentSettings(options);
  const nextApiKey =
    input.openRouterApiKey === null
      ? null
      : typeof input.openRouterApiKey === "string" &&
          input.openRouterApiKey.trim()
        ? input.openRouterApiKey.trim()
        : current.openRouterApiKey;
  const nextSettings: StoredAppAgentSettings = {
    enabled: typeof input.enabled === "boolean" ? input.enabled : current.enabled,
    openRouterApiKey: nextApiKey,
    model: normalizeModel(input.model),
    savedAt: new Date().toISOString(),
  };
  await writeAppAgentSettings(nextSettings, options);
  return getAppAgentSettingsStatus(options);
}

export async function writeAppAgentSettings(
  settings: StoredAppAgentSettings,
  options: AppAgentSettingsStoreOptions = {},
): Promise<void> {
  const settingsPath = getAppAgentSettingsStorePath(options);
  const secretStorage = options.secretStorage || defaultSecretStorage();
  const persisted: PersistedAppAgentSettings = {
    enabled: settings.enabled === true,
    encryptedOpenRouterApiKey: encryptSecret(
      settings.openRouterApiKey,
      secretStorage,
    ),
    model: normalizeModel(settings.model),
    savedAt: settings.savedAt || new Date().toISOString(),
  };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
}

export async function getAppAgentSettingsStatus(
  options: AppAgentSettingsStoreOptions = {},
): Promise<DesktopAppAgentSettingsStatus> {
  const settingsPath = getAppAgentSettingsStorePath(options);
  try {
    const settings = await readAppAgentSettings(options);
    const model = normalizeModel(settings.model);
    const hasApiKey = Boolean(settings.openRouterApiKey);
    return {
      enabled: settings.enabled,
      configured: hasApiKey && Boolean(model),
      hasApiKey,
      model,
      savedAt: settings.savedAt,
      settingsPath,
      error: null,
    };
  } catch (error) {
    return {
      enabled: false,
      configured: false,
      hasApiKey: false,
      model: DEFAULT_APP_AGENT_OPENROUTER_MODEL,
      savedAt: null,
      settingsPath,
      error:
        error instanceof Error
          ? error.message
          : "App Agent settings could not be read.",
    };
  }
}

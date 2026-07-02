import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopOpenModelSaveSettingsInput,
  DesktopOpenModelSettingsStatus,
} from "../../ipc-types.js";

export const DEFAULT_OPEN_MODEL_BASE_URL = "https://openrouter.ai/api/v1";

const require = createRequire(import.meta.url);

interface OpenModelSecretStorage {
  isEncryptionAvailable: () => boolean;
  encryptString: (value: string) => Buffer;
  decryptString: (value: Buffer) => string;
}

interface OpenModelSettingsStoreOptions {
  storePath?: string;
  secretStorage?: OpenModelSecretStorage;
}

export interface StoredOpenModelSettings {
  apiKey: string | null;
  baseUrl: string;
  model: string;
  savedAt: string | null;
}

interface PersistedOpenModelSettings {
  encryptedApiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
  savedAt?: string | null;
}

function getElectronMain(): {
  app?: { getPath: (name: "userData") => string };
  safeStorage?: OpenModelSecretStorage;
} {
  try {
    const electron = require("electron") as unknown;
    return typeof electron === "object" && electron !== null
      ? electron as {
          app?: { getPath: (name: "userData") => string };
          safeStorage?: OpenModelSecretStorage;
        }
      : {};
  } catch {
    return {};
  }
}

function defaultSecretStorage(): OpenModelSecretStorage {
  const electronSafeStorage = getElectronMain().safeStorage;
  if (electronSafeStorage) return electronSafeStorage;
  return {
    isEncryptionAvailable: () => false,
    encryptString: (value) => Buffer.from(value, "utf8"),
    decryptString: (value) => value.toString("utf8"),
  };
}

export function getOpenModelSettingsStorePath(
  options: OpenModelSettingsStoreOptions = {},
): string {
  return (
    options.storePath ||
    process.env.LETAGENTS_OPEN_MODEL_SETTINGS_PATH ||
    join(
      getElectronMain().app?.getPath("userData") || homedir(),
      "letagents-desktop-open-model.json",
    )
  );
}

function encryptSecret(
  value: string | null,
  secretStorage: OpenModelSecretStorage,
): string | null {
  if (!value) return null;
  if (!secretStorage.isEncryptionAvailable()) {
    throw new Error("Secure credential storage is unavailable, so the model API key was not saved.");
  }
  return `safe:${secretStorage.encryptString(value).toString("base64")}`;
}

function decryptSecret(
  encryptedValue: string | null | undefined,
  secretStorage: OpenModelSecretStorage,
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

function normalizeBaseUrl(baseUrl: string | null | undefined): string {
  const normalized = baseUrl?.trim().replace(/\/+$/, "") || "";
  return normalized || DEFAULT_OPEN_MODEL_BASE_URL;
}

function normalizeModel(model: string | null | undefined): string {
  return model?.trim() || "";
}

export function assertValidOpenModelBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`The model endpoint URL is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The model endpoint URL must use http or https.");
  }
}

export async function readOpenModelSettings(
  options: OpenModelSettingsStoreOptions = {},
): Promise<StoredOpenModelSettings> {
  const settingsPath = getOpenModelSettingsStorePath(options);
  const secretStorage = options.secretStorage || defaultSecretStorage();
  try {
    const raw = await readFile(settingsPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedOpenModelSettings;
    return {
      apiKey: decryptSecret(parsed.encryptedApiKey, secretStorage),
      baseUrl: normalizeBaseUrl(parsed.baseUrl),
      model: normalizeModel(parsed.model),
      savedAt: parsed.savedAt || null,
    };
  } catch {
    return {
      apiKey: null,
      baseUrl: DEFAULT_OPEN_MODEL_BASE_URL,
      model: "",
      savedAt: null,
    };
  }
}

export async function saveOpenModelSettings(
  input: DesktopOpenModelSaveSettingsInput,
  options: OpenModelSettingsStoreOptions = {},
): Promise<DesktopOpenModelSettingsStatus> {
  const settingsPath = getOpenModelSettingsStorePath(options);
  const secretStorage = options.secretStorage || defaultSecretStorage();
  const current = await readOpenModelSettings(options);
  const nextApiKey =
    input.apiKey === null
      ? null
      : typeof input.apiKey === "string" && input.apiKey.trim()
        ? input.apiKey.trim()
        : current.apiKey;
  const nextBaseUrl = normalizeBaseUrl(
    input.baseUrl === undefined ? current.baseUrl : input.baseUrl,
  );
  assertValidOpenModelBaseUrl(nextBaseUrl);
  const nextSettings: StoredOpenModelSettings = {
    apiKey: nextApiKey,
    baseUrl: nextBaseUrl,
    model: normalizeModel(input.model === undefined ? current.model : input.model),
    savedAt: new Date().toISOString(),
  };
  const persisted: PersistedOpenModelSettings = {
    encryptedApiKey: encryptSecret(nextSettings.apiKey, secretStorage),
    baseUrl: nextSettings.baseUrl,
    model: nextSettings.model,
    savedAt: nextSettings.savedAt,
  };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  return getOpenModelSettingsStatus(options);
}

export function isOpenModelConfigured(settings: StoredOpenModelSettings): boolean {
  return Boolean(settings.baseUrl && settings.model);
}

export async function getOpenModelSettingsStatus(
  options: OpenModelSettingsStoreOptions = {},
): Promise<DesktopOpenModelSettingsStatus> {
  const settingsPath = getOpenModelSettingsStorePath(options);
  try {
    const settings = await readOpenModelSettings(options);
    return {
      configured: isOpenModelConfigured(settings),
      hasApiKey: Boolean(settings.apiKey),
      baseUrl: settings.baseUrl,
      model: settings.model,
      savedAt: settings.savedAt,
      settingsPath,
      error: null,
    };
  } catch (error) {
    return {
      configured: false,
      hasApiKey: false,
      baseUrl: DEFAULT_OPEN_MODEL_BASE_URL,
      model: "",
      savedAt: null,
      settingsPath,
      error:
        error instanceof Error
          ? error.message
          : "Open model settings could not be read.",
    };
  }
}

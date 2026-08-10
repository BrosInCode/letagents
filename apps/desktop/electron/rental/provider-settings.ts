import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
  DesktopRentalProviderSettingsInput,
  DesktopRentalRuntimeId,
} from "../ipc-types/rental.js";

export type StoredRentalProviderSettings = {
  version: 1;
  enabled: boolean;
  maxConcurrentSessions: number;
  defaultTimeLimitMinutes: number;
  defaultLrtLimit: number;
  enabledRuntimes: DesktopRentalRuntimeId[];
  updatedAt: string | null;
};

const RUNTIMES = new Set<DesktopRentalRuntimeId>(["codex", "claude-code", "cursor", "open-model"]);
const defaults: StoredRentalProviderSettings = {
  version: 1,
  enabled: false,
  maxConcurrentSessions: 1,
  defaultTimeLimitMinutes: 30,
  defaultLrtLimit: 50_000,
  enabledRuntimes: [],
  updatedAt: null,
};

function settingsPath(): string {
  return process.env.LETAGENTS_RENTAL_PROVIDER_SETTINGS_PATH?.trim()
    || join(homedir(), ".letagents", "desktop", "rental-provider-settings.json");
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}

function normalize(value: unknown): StoredRentalProviderSettings {
  if (!value || typeof value !== "object") return { ...defaults };
  const raw = value as Partial<StoredRentalProviderSettings>;
  return {
    version: 1,
    enabled: raw.enabled === true,
    maxConcurrentSessions: boundedInteger(raw.maxConcurrentSessions, defaults.maxConcurrentSessions, 1, 8),
    defaultTimeLimitMinutes: boundedInteger(raw.defaultTimeLimitMinutes, defaults.defaultTimeLimitMinutes, 5, 24 * 60),
    defaultLrtLimit: boundedInteger(raw.defaultLrtLimit, defaults.defaultLrtLimit, 1_000, 10_000_000),
    enabledRuntimes: Array.isArray(raw.enabledRuntimes)
      ? [...new Set(raw.enabledRuntimes.filter((runtime): runtime is DesktopRentalRuntimeId => RUNTIMES.has(runtime as DesktopRentalRuntimeId)))]
      : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
  };
}

export async function readRentalProviderSettings(): Promise<StoredRentalProviderSettings> {
  try {
    return normalize(JSON.parse(await readFile(settingsPath(), "utf8")));
  } catch {
    return { ...defaults, enabledRuntimes: [] };
  }
}

export async function updateRentalProviderSettings(
  input: DesktopRentalProviderSettingsInput,
): Promise<StoredRentalProviderSettings> {
  const current = await readRentalProviderSettings();
  const enabledRuntimes = input.runtimes
    ? input.runtimes.filter((runtime) => runtime.enabled).map((runtime) => runtime.providerId)
    : current.enabledRuntimes;
  const next = normalize({
    ...current,
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    ...(input.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: input.maxConcurrentSessions } : {}),
    ...(input.defaultTimeLimitMinutes !== undefined ? { defaultTimeLimitMinutes: input.defaultTimeLimitMinutes } : {}),
    ...(input.defaultLrtLimit !== undefined ? { defaultLrtLimit: input.defaultLrtLimit } : {}),
    enabledRuntimes,
    updatedAt: new Date().toISOString(),
  });
  const path = settingsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
  return next;
}

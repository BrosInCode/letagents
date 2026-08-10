import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { DesktopNotificationTarget } from "../ipc-types.js";
import { parseDesktopNotificationTarget } from "./notification-target.js";

export const MAX_NOTIFICATION_TARGETS = 200;

export interface PersistedNotificationState {
  enabled: boolean;
  installationId: string;
  deviceToken: string | null;
  lastError: string | null;
  targets: DesktopNotificationTarget[];
}

export interface NotificationHistoryEntry {
  id: string;
  on(event: "click" | "close", listener: () => void): unknown;
}

export function emptyNotificationState(
  createInstallationId: () => string = randomUUID,
): PersistedNotificationState {
  return {
    enabled: false,
    installationId: createInstallationId(),
    deviceToken: null,
    lastError: null,
    targets: [],
  };
}

function parseNotificationState(
  parsed: Partial<PersistedNotificationState>,
  createInstallationId: () => string,
): PersistedNotificationState {
  return {
    enabled: parsed.enabled === true,
    installationId: typeof parsed.installationId === "string" && parsed.installationId
      ? parsed.installationId
      : createInstallationId(),
    deviceToken: typeof parsed.deviceToken === "string" ? parsed.deviceToken : null,
    lastError: typeof parsed.lastError === "string" ? parsed.lastError : null,
    targets: Array.isArray(parsed.targets)
      ? parsed.targets
        .map(parseDesktopNotificationTarget)
        .filter((target): target is DesktopNotificationTarget => Boolean(target))
        .slice(-MAX_NOTIFICATION_TARGETS)
      : [],
  };
}

export class DesktopNotificationStateStore {
  private state: PersistedNotificationState | null = null;

  constructor(
    private readonly path: string,
    private readonly createInstallationId: () => string = randomUUID,
  ) {}

  async read(): Promise<PersistedNotificationState> {
    if (this.state) return this.state;
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<PersistedNotificationState>;
      this.state = parseNotificationState(parsed, this.createInstallationId);
    } catch {
      this.state = emptyNotificationState(this.createInstallationId);
    }
    return this.state;
  }

  async persist(): Promise<void> {
    const current = await this.read();
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async remember(target: DesktopNotificationTarget): Promise<void> {
    const current = await this.read();
    current.targets = [
      ...current.targets.filter((entry) => entry.notificationId !== target.notificationId),
      target,
    ].slice(-MAX_NOTIFICATION_TARGETS);
    await this.persist();
  }
}

export class DesktopNotificationActivationState {
  private pending: DesktopNotificationTarget | null = null;
  private receivedDuringStartup: DesktopNotificationTarget | null = null;

  captureDuringStartup(target: DesktopNotificationTarget): void {
    this.receivedDuringStartup = target;
  }

  takeStartupTarget(): DesktopNotificationTarget | null {
    const target = this.receivedDuringStartup;
    this.receivedDuringStartup = null;
    return target;
  }

  markActivated(target: DesktopNotificationTarget): void {
    this.pending = target;
  }

  takePending(): DesktopNotificationTarget | null {
    const target = this.pending;
    this.pending = null;
    return target;
  }
}

export function attachNotificationHistoryEntries<T extends NotificationHistoryEntry>(input: {
  history: T[];
  targets: DesktopNotificationTarget[];
  restored: Map<string, T>;
  activate(target: DesktopNotificationTarget): void;
}): void {
  const targets = new Map(input.targets.map((target) => [target.notificationId, target]));
  for (const notification of input.history) {
    if (input.restored.has(notification.id)) continue;
    const target = targets.get(notification.id);
    if (!target) continue;
    input.restored.set(notification.id, notification);
    notification.on("click", () => input.activate(target));
    notification.on("close", () => input.restored.delete(notification.id));
  }
}

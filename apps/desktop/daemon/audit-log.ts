import { appendFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";

import type { DaemonLaunchEvent, Transition } from "./types.js";
import { redactCredentialText } from "./credential-redaction.js";

type LaunchAuditRecord = { record_type: "launch_event"; event: DaemonLaunchEvent };

export class AuditLog {
  private readonly launchCache = new Map<string, DaemonLaunchEvent[]>();

  constructor(readonly path: string, private readonly maxBytes = 1024 * 1024) {}

  async append(transition: Transition): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded();
    const sanitized: Transition = {
      ...transition,
      entry_id: redactCredentialText(transition.entry_id).value,
      cause: redactCredentialText(transition.cause).value,
      actor: redactCredentialText(transition.actor).value,
    };
    await appendFile(this.path, `${JSON.stringify(sanitized)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  async appendLaunchEvents(events: readonly DaemonLaunchEvent[]): Promise<void> {
    if (events.length === 0) return;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await this.rotateIfNeeded();
    const records = events.map((event): LaunchAuditRecord => ({
      record_type: "launch_event",
      event: sanitizeLaunchEvent(event),
    }));
    await appendFile(this.path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    for (const { event } of records) {
      const cached = this.launchCache.get(event.launch_id);
      if (!cached) continue;
      const existing = cached.findIndex((candidate) => candidate.sequence === event.sequence);
      if (existing >= 0) cached[existing] = event;
      else cached.push(event);
      cached.sort((left, right) => left.sequence - right.sequence);
    }
  }

  /** Replay across the current file and every rotated archive. */
  async readLaunchEvents(launchId: string): Promise<DaemonLaunchEvent[]> {
    const cached = this.launchCache.get(launchId);
    if (cached) return cached.map((event) => ({ ...event }));
    const files = await this.auditFiles();
    const bySequence = new Map<number, DaemonLaunchEvent>();
    for (const file of files) {
      const body = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
      });
      for (const line of body.split("\n")) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Partial<LaunchAuditRecord>;
          if (parsed.record_type !== "launch_event" || parsed.event?.launch_id !== launchId) continue;
          const event = parsed.event;
          if (!Number.isSafeInteger(event.sequence) || event.sequence < 1) continue;
          bySequence.set(event.sequence, event);
        } catch {
          // A partial/corrupt tail must not make the manifest unreadable.
        }
      }
    }
    const events = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
    this.launchCache.set(launchId, events);
    return events.map((event) => ({ ...event }));
  }

  private async auditFiles(): Promise<string[]> {
    const directory = dirname(this.path);
    const prefix = `${basename(this.path)}.`;
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const archives = names
      .filter((name) => name.startsWith(prefix) && name.endsWith(".archive"))
      .sort()
      .map((name) => `${directory}/${name}`);
    return [...archives, this.path];
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      if ((await stat(this.path)).size < this.maxBytes) return;
      await rename(this.path, `${this.path}.${Date.now()}.archive`);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function sanitizeLaunchEvent(event: DaemonLaunchEvent): DaemonLaunchEvent {
  return {
    ...event,
    launch_id: redactCredentialText(event.launch_id).value,
    entry_id: event.entry_id === null ? null : redactCredentialText(event.entry_id).value,
    room_id: redactCredentialText(event.room_id).value,
    provider: redactCredentialText(event.provider).value,
    detail: event.detail === null ? null : redactCredentialText(event.detail).value,
  };
}

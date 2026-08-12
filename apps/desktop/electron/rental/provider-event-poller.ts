import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { DesktopRentalProviderEvent } from "../ipc-types/rental.js";
import type { RentalApiClient } from "./api-client.js";

const POLL_MS = 5_000;
const EVENT_KINDS = new Set<DesktopRentalProviderEvent["kind"]>([
  "request.created",
  "request.cancelled",
  "session.accepted",
  "launch.updated",
]);

function statePath(): string {
  return process.env.LETAGENTS_RENTAL_PROVIDER_EVENT_STATE_PATH?.trim()
    || join(homedir(), ".letagents", "desktop", "rental-provider-events.json");
}

async function readCursor(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), "utf8")) as { cursor?: unknown };
    return typeof parsed.cursor === "string" && parsed.cursor.trim() ? parsed.cursor.trim() : null;
  } catch {
    return null;
  }
}

async function writeCursor(cursor: string): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ version: 1, cursor })}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sanitizedEvent(value: unknown): DesktopRentalProviderEvent | null {
  const row = record(value);
  const kind = typeof row.kind === "string" ? row.kind : "";
  if (!EVENT_KINDS.has(kind as DesktopRentalProviderEvent["kind"])) return null;
  const rawSessionId = row.sessionId ?? row.session_id;
  return {
    kind: kind as DesktopRentalProviderEvent["kind"],
    sessionId: typeof rawSessionId === "string" && rawSessionId.trim() ? rawSessionId.trim() : null,
  };
}

/** Polls the durable owner-auth feed and exposes only badge/refresh metadata. */
export class RentalProviderEventPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private operation: Promise<void> | null = null;
  private cursor: string | null = null;

  constructor(
    private readonly api: RentalApiClient,
    private readonly emit: (event: DesktopRentalProviderEvent) => void,
    private readonly handle: (event: DesktopRentalProviderEvent) => Promise<void> = async () => undefined,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.operation?.catch(() => undefined);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.operation) return;
    const operation = this.pollOnce();
    this.operation = operation;
    try {
      await operation;
    } catch {
      // Network/auth failures are expected during offline and sign-in states.
      // The durable cursor remains unchanged and the next tick retries.
    } finally {
      if (this.operation === operation) this.operation = null;
      if (!this.stopped) {
        this.timer = setTimeout(() => void this.tick(), POLL_MS);
        this.timer.unref();
      }
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.cursor === null) this.cursor = await readCursor();
    const result = await this.api.providerEvents(this.cursor);
    if (!result.ok) throw new Error(result.error);
    const body = record(result.body);
    const events = Array.isArray(body.events) ? body.events : [];
    for (const raw of events) {
      const event = sanitizedEvent(raw);
      if (!event) continue;
      await this.handle(event);
      this.emit(event);
    }
    const nextCursor = typeof body.cursor === "string" && body.cursor.trim() ? body.cursor.trim() : null;
    if (nextCursor && nextCursor !== this.cursor) {
      await writeCursor(nextCursor);
      this.cursor = nextCursor;
    }
  }
}

let activePoller: RentalProviderEventPoller | null = null;

export function setActiveRentalProviderEventPoller(poller: RentalProviderEventPoller): void {
  activePoller = poller;
}

export async function stopActiveRentalProviderEventPoller(): Promise<void> {
  const poller = activePoller;
  activePoller = null;
  await poller?.stop();
}

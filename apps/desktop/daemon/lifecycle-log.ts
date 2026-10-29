import {
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { redactCredentialText } from "./credential-redaction.js";
import { setRoomLatencyReporter } from "./room-latency-trace.js";
import { setTurnStartLatencyReporter } from "./turn-start-latency.js";
import { protectOwnerPrivateSync } from "../../../shared/owner-private-fs.mjs";

const MAX_LIFECYCLE_LOG_BYTES = 256 * 1024;

export type DaemonLifecycleEvent = {
  event: "daemon_starting" | "daemon_ready" | "handoff_complete" | "entrypoint_failure" | "fatal_exception" | "process_exit" | "room_latency"
    | "turn_start_latency" | "provider_launch_latency";
  detail?: string | null;
  exitCode?: number | null;
};

/**
 * Minimal process-level diagnostics for failures that happen outside the
 * daemon's durable agent journal. Writes are synchronous by design: fatal
 * exceptions and process exit do not provide an asynchronous flush window.
 */
export class DaemonLifecycleLog {
  private descriptor: number | null = null;

  constructor(readonly path: string, private readonly maxBytes = MAX_LIFECYCLE_LOG_BYTES) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      protectOwnerPrivateSync(dirname(path), "directory");
      try {
        if (statSync(path).size >= maxBytes) renameSync(path, `${path}.previous`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.descriptor = openSync(path, "a", 0o600);
      protectOwnerPrivateSync(path, "file");
    } catch {
      this.descriptor = null;
    }
  }

  append(event: DaemonLifecycleEvent): void {
    if (this.descriptor === null) return;
    try {
      // Slow-operation samples can recur throughout a long-lived process.
      // Keep the same two-file retention used at startup.
      if (statSync(this.path).size >= this.maxBytes) {
        closeSync(this.descriptor);
        this.descriptor = null;
        renameSync(this.path, `${this.path}.previous`);
        this.descriptor = openSync(this.path, "a", 0o600);
        protectOwnerPrivateSync(this.path, "file");
      }
      const detail = event.detail == null
        ? null
        : redactCredentialText(event.detail, 4_096).value;
      writeSync(this.descriptor, `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        ppid: process.ppid,
        event: event.event,
        ...(detail ? { detail } : {}),
        ...(event.exitCode === undefined ? {} : { exit_code: event.exitCode }),
      })}\n`);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.descriptor === null) return;
    try {
      closeSync(this.descriptor);
    } catch {
      // Diagnostics are best-effort and must never affect daemon lifecycle.
    }
    this.descriptor = null;
  }
}

/** Install process-level diagnostics only from the executable entrypoint. */
export function startDaemonLifecycleDiagnostics(path: string): DaemonLifecycleLog {
  const lifecycle = new DaemonLifecycleLog(path);
  setRoomLatencyReporter(sample => lifecycle.append({ event: "room_latency", detail: JSON.stringify(sample) }));
  // One start-up sample per turn would soon push process failures out of the
  // lifecycle file, so they get a sibling file, created at the first sample.
  const turnLatencyPath = join(dirname(path), "daemon-turn-latency.jsonl");
  let turnLatency: DaemonLifecycleLog | null = null;
  setTurnStartLatencyReporter(record => {
    turnLatency ??= new DaemonLifecycleLog(turnLatencyPath);
    turnLatency.append({ event: record.event, detail: JSON.stringify(record.sample) });
  });
  lifecycle.append({ event: "daemon_starting" });
  process.on("uncaughtExceptionMonitor", error => {
    lifecycle.append({ event: "fatal_exception", detail: daemonLifecycleErrorDetail(error) });
  });
  process.on("exit", exitCode => {
    setRoomLatencyReporter(null);
    setTurnStartLatencyReporter(null);
    turnLatency?.close();
    lifecycle.append({ event: "process_exit", exitCode });
    lifecycle.close();
  });
  return lifecycle;
}

export function daemonLifecycleErrorDetail(error: unknown): string {
  const seen = new Set<unknown>();
  const details: string[] = [];
  const visit = (value: unknown, label: string, depth: number): void => {
    if (depth > 4 || seen.has(value)) return;
    if ((typeof value === "object" && value !== null) || typeof value === "function") seen.add(value);
    if (value instanceof Error) {
      details.push(`${label}${value.stack || value.message}`);
      if (value instanceof AggregateError) {
        for (const [index, nested] of [...value.errors].entries()) {
          visit(nested, `Aggregate error ${index + 1}: `, depth + 1);
        }
      }
      if ("cause" in value && value.cause !== undefined) {
        visit(value.cause, "Caused by: ", depth + 1);
      }
      return;
    }
    details.push(`${label}${String(value ?? "Unknown daemon failure.")}`);
  };
  visit(error, "", 0);
  return details.join("\n").slice(0, 16_384) || "Unknown daemon failure.";
}

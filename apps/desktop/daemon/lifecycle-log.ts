import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import { redactCredentialText } from "./credential-redaction.js";

const MAX_LIFECYCLE_LOG_BYTES = 256 * 1024;

export type DaemonLifecycleEvent = {
  event: "daemon_starting" | "daemon_ready" | "handoff_complete" | "entrypoint_failure" | "fatal_exception" | "process_exit";
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
      chmodSync(dirname(path), 0o700);
      try {
        if (statSync(path).size >= maxBytes) renameSync(path, `${path}.previous`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      this.descriptor = openSync(path, "a", 0o600);
      chmodSync(path, 0o600);
    } catch {
      this.descriptor = null;
    }
  }

  append(event: DaemonLifecycleEvent): void {
    if (this.descriptor === null) return;
    try {
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

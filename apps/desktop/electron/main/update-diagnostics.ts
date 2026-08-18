import {
  chmodSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type { DesktopUpdateDiagnosticEvent } from "./desktop-updater.js";
import { redactCredentialText } from "./agents/provider-evidence.js";

const DEFAULT_MAX_UPDATE_LOG_BYTES = 256 * 1024;

function sanitizeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "unavailable";
  }
}

function sanitizeDiagnosticDetail(value: string): string {
  const withoutUrlSecrets = value.replace(/https:\/\/[^\s"'<>]+/gi, (candidate) => sanitizeDiagnosticUrl(candidate));
  return redactCredentialText(withoutUrlSecrets).value.slice(0, 4_096);
}

export type DesktopUpdateDiagnosticContext = {
  currentVersion: string;
  arch: string;
  feedUrl: string;
};

/**
 * Private, bounded updater diagnostics. The main process is the sole writer,
 * so rotation cannot race another process or become part of update delivery.
 */
export class DesktopUpdateDiagnosticLog {
  private descriptor: number | null = null;

  constructor(
    readonly path: string,
    private readonly context: DesktopUpdateDiagnosticContext,
    private readonly maxBytes = DEFAULT_MAX_UPDATE_LOG_BYTES,
  ) {
    this.open();
  }

  append(event: DesktopUpdateDiagnosticEvent): void {
    if (this.descriptor === null) return;
    try {
      const detail = event.detail ? sanitizeDiagnosticDetail(event.detail) : null;
      const line = `${JSON.stringify({
        at: new Date().toISOString(),
        pid: process.pid,
        current_version: this.context.currentVersion,
        arch: this.context.arch,
        feed_url: sanitizeDiagnosticUrl(this.context.feedUrl),
        event: event.event,
        ...(event.stage ? { stage: event.stage } : {}),
        ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
        ...(event.attemptLimit === undefined ? {} : { attempt_limit: event.attemptLimit }),
        ...(event.delayMs === undefined ? {} : { delay_ms: event.delayMs }),
        ...(event.version ? { available_version: event.version } : {}),
        ...(detail ? { detail } : {}),
      })}\n`;
      this.rotateBeforeWrite(Buffer.byteLength(line));
      if (this.descriptor !== null) writeSync(this.descriptor, line);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.descriptor === null) return;
    try {
      closeSync(this.descriptor);
    } catch {
      // Diagnostics are best-effort and must never affect update delivery.
    }
    this.descriptor = null;
  }

  private open(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(this.path), 0o700);
      this.descriptor = openSync(this.path, "a", 0o600);
      chmodSync(this.path, 0o600);
    } catch {
      this.descriptor = null;
    }
  }

  private rotateBeforeWrite(nextBytes: number): void {
    if (this.descriptor === null || fstatSync(this.descriptor).size + nextBytes <= this.maxBytes) return;
    this.close();
    try {
      rmSync(`${this.path}.previous`, { force: true });
      renameSync(this.path, `${this.path}.previous`);
    } catch {
      // A failed rotation disables this diagnostic session rather than update delivery.
      return;
    }
    this.open();
  }
}

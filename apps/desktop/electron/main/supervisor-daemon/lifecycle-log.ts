import { dirname } from "node:path";
import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { redactCredentialText } from "../agents/provider-evidence.js";

const DAEMON_LIFECYCLE_LOG_MAX_BYTES = 256 * 1024;
const daemonLifecycleLogWrites = new Map<string, Promise<void>>();

export type DesktopDaemonLifecycleEvent = {
  event: "daemon_spawned" | "daemon_spawn_error" | "daemon_exited" | "daemon_disappeared" | "daemon_identity_changed";
  pid: number | null;
  detail?: string | null;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  generation?: number | null;
};

export function appendDaemonLifecycleEvent(path: string, event: DesktopDaemonLifecycleEvent): void {
  const previous = daemonLifecycleLogWrites.get(path) ?? Promise.resolve();
  const operation = previous.then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    try {
      // Rotation belongs exclusively to the daemon process. Electron only
      // appends below the cap so the two processes can never rename the file
      // out from under one another.
      if ((await stat(path)).size >= DAEMON_LIFECYCLE_LOG_MAX_BYTES) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const detail = event.detail == null
      ? null
      : redactCredentialText(event.detail).value.slice(0, 4_096);
    await appendFile(path, `${JSON.stringify({
      at: new Date().toISOString(),
      event: event.event,
      pid: event.pid,
      ...(detail ? { detail } : {}),
      ...(event.exitCode === undefined ? {} : { exit_code: event.exitCode }),
      ...(event.signal === undefined ? {} : { signal: event.signal }),
      ...(event.generation === undefined ? {} : { generation: event.generation }),
    })}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }).catch(() => undefined).finally(() => {
    if (daemonLifecycleLogWrites.get(path) === operation) daemonLifecycleLogWrites.delete(path);
  });
  daemonLifecycleLogWrites.set(path, operation);
}

/**
 * Shell commands that a Cursor agent runs in the background, for the owner's Live tab and the room's strip.
 *
 * How Cursor runs them (cursor-agent 2026.09.18, verified live):
 * 1. The shell tool call has `isBackground: true`. Its completed event gives the shell's id and pid, and the
 *    folder where Cursor writes its output: `<terminalsFolder>/<shellId>.txt`.
 * 2. That file starts with a header between two `---` lines (pid, command, status), which Cursor rewrites in
 *    place with the same length. The command's output follows, and a footer with `exit_code` ends the file.
 * 3. A `system/task_notification` event (its `task_id` is the shell id) reports the end.
 * 4. The shell runs in its own process group. The CLI waits for it before it exits, and kills it when it is
 *    stopped itself: a background shell lives no longer than the turn's CLI process.
 *
 * So a shell is shown, and can be stopped, while its turn runs. When the turn's CLI process exits, every shell of
 * that turn ends in what LetAgents shows. Only a CLI that was killed outright can leave its shell running; that
 * shell is no longer followed.
 *
 * Stop sends SIGTERM to the shell's process group, only while the process is the same one that started (its
 * birth identity, read when the call reported it).
 */
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  BackgroundCommandOutput,
  type BackgroundOutputFormat,
} from "../background-command-output.js";
import type { LiveBackgroundCommandPayload } from "../../../../../../shared/live-command-output.mjs";

/** The header Cursor writes first: field lines between two `---` lines. */
const HEADER = /^---\n(?:[a-z_]+: [^\n]*\n)*?---\n/;
/** The footer Cursor adds when the shell ends. */
const FOOTER = /\n?---\nexit_code: (-?\d+)\n(?:[a-z_]+: [^\n]*\n)*---\n?\s*$/;
/** Background shells of one agent that are followed at once; more are not shown. */
const MAX_SHELLS = 16;

/** Cursor's output file: the header, the command's output, and the footer when it ends. */
export const CURSOR_BACKGROUND_OUTPUT: BackgroundOutputFormat = {
  body: (raw) => {
    const header = HEADER.exec(raw);
    // A header that is not complete yet holds no output; text without one was read from the middle of the file.
    const output = header ? raw.slice(header[0].length) : raw.startsWith("---\n") && !/\n---\n/.test(raw.slice(3)) ? "" : raw;
    return output.replace(FOOTER, "");
  },
  exitCode: (raw) => {
    const match = FOOTER.exec(raw);
    return match ? Number(match[1]) : null;
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type CursorBackgroundShell = {
  shellId: string;
  pid: number;
  command: string;
  description: string | null;
  path: string;
  callId: string | null;
};

/** The background shell that a completed shell tool call started, or null for any other event. */
export function cursorBackgroundShell(message: Record<string, unknown>): CursorBackgroundShell | null {
  if (message.type !== "tool_call" || message.subtype !== "completed") return null;
  const shell = record(record(message.tool_call)?.shellToolCall);
  const result = record(shell?.result);
  const success = record(result?.success);
  if (result?.isBackground !== true || !success) return null;
  const rawId = success.shellId;
  const shellId = typeof rawId === "number" && Number.isSafeInteger(rawId) && rawId >= 0 ? String(rawId)
    : typeof rawId === "string" && /^\d{1,15}$/.test(rawId) ? rawId : null;
  const pid = typeof success.pid === "number" && Number.isSafeInteger(success.pid) && success.pid > 1 ? success.pid : null;
  const folder = typeof result.terminalsFolder === "string" ? result.terminalsFolder : null;
  // The file must be `<data>/projects/<workspace>/terminals/<shell id>.txt`, in Cursor's own folder.
  if (!shellId || !pid || !folder || !isAbsolute(folder) || basename(folder) !== "terminals"
    || basename(dirname(dirname(folder))) !== "projects") return null;
  const args = record(shell?.args);
  const command = typeof args?.command === "string" ? args.command : typeof success.command === "string" ? success.command : "";
  const description = typeof args?.description === "string" && args.description.trim() ? args.description.trim() : null;
  return { shellId, pid, command, description, path: join(folder, `${shellId}.txt`), callId: typeof message.call_id === "string" ? message.call_id : null };
}

/**
 * What Cursor and the agent's runtime let the shells do: the clock, the owner's feed (each value with the turn
 * whose CLI process started the shell), and the exact process.
 */
export type CursorBackgroundShellPort<Turn = unknown> = {
  now(): string;
  publish(payload: LiveBackgroundCommandPayload, turn: Turn): void;
  processIdentity(pid: number): string | null | undefined;
  signalExact(pid: number, identity: string, signal: NodeJS.Signals): "signalled" | "absent" | "ambiguous";
};

type Followed<Turn> = {
  follower: BackgroundCommandOutput;
  pid: number;
  identity: string | null;
  stopRequested: boolean;
  turn: Turn;
};

/** The background shells of one Cursor agent: followed from their calls until their end. */
export class CursorBackgroundShells<Turn = unknown> {
  private readonly shells = new Map<string, Followed<Turn>>();

  constructor(private readonly port: CursorBackgroundShellPort<Turn>, private readonly exitQuietMs?: number) {}

  /** A completed shell call of `turn`: follow its shell when it runs in the background. */
  follow(message: Record<string, unknown>, turn: Turn): void {
    const shell = cursorBackgroundShell(message);
    if (!shell || this.shells.has(shell.shellId) || this.shells.size >= MAX_SHELLS) return;
    // Read now, while the pid surely still names the shell that the call started.
    const identity = this.port.processIdentity(shell.pid) ?? null;
    const follower = new BackgroundCommandOutput({
      taskId: shell.shellId,
      toolUseId: shell.callId,
      command: shell.command,
      description: shell.description,
      path: shell.path,
      startedAt: this.port.now(),
      now: () => this.port.now(),
      publish: (payload) => this.port.publish(payload, turn),
      onStopped: () => { if (this.shells.get(shell.shellId)?.follower === follower) this.shells.delete(shell.shellId); },
      format: CURSOR_BACKGROUND_OUTPUT,
      ...(this.exitQuietMs !== undefined ? { exitQuietMs: this.exitQuietMs } : {}),
    });
    this.shells.set(shell.shellId, { follower, pid: shell.pid, identity, stopRequested: false, turn });
    follower.start();
  }

  /** Cursor's `task_notification`: the shell ended. */
  noticeEnded(message: Record<string, unknown>): void {
    if (message.type !== "system" || message.subtype !== "task_notification") return;
    const taskId = typeof message.task_id === "string" ? message.task_id : typeof message.task_id === "number" ? String(message.task_id) : null;
    const shell = taskId ? this.shells.get(taskId) : undefined;
    if (!shell) return;
    // The owner's Stop comes first: a server that exits cleanly on SIGTERM still ends because it was stopped.
    const status = shell.stopRequested || message.status === "aborted" || message.status === "killed" ? "stopped"
      : message.status === "success" ? "completed" : "failed";
    shell.follower.finish(status, null);
  }

  /**
   * The turn's CLI process exited: its shells have ended, or it was killed outright and they are no longer
   * followed. A shell without its notice ends with the turn; Cursor's footer still shows an end of its own.
   */
  turnEnded(turn: Turn): void {
    for (const shell of [...this.shells.values()]) {
      if (shell.turn !== turn) continue;
      shell.follower.finish(shell.stopRequested ? "stopped" : "lost", null);
    }
  }

  /** The owner's Stop: SIGTERM to the shell's process group, only while it is the same process. */
  stop(taskId: string): "stopping" | "not_running" | "failed" {
    const shell = this.shells.get(taskId);
    if (!shell) return "not_running";
    if (!shell.identity) return "failed";
    shell.stopRequested = true;
    shell.follower.noteStopRequested(true);
    const signalled = this.port.signalExact(shell.pid, shell.identity, "SIGTERM");
    if (signalled === "signalled") return "stopping";
    shell.stopRequested = false;
    shell.follower.noteStopRequested(false);
    return signalled === "absent" ? "not_running" : "failed";
  }

  /** The agent's runtime ended: stop following without a last event; the feed ends with it. */
  closeAll(): void {
    for (const shell of [...this.shells.values()]) shell.follower.close();
    this.shells.clear();
  }
}

import { constants, watch, type FSWatcher } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  LIVE_OUTPUT_TAIL_CHARS,
  liveOutputTail,
  plainTerminalText,
  type LiveBackgroundCommandPayload,
  type LiveBackgroundCommandStatus,
} from "../../../../../../shared/live-command-output.mjs";

/** New output is read at most this often; one read takes everything that arrived since the last. */
const READ_PACE_MS = 250;
/** A file watch can miss a change; a slow check catches the rest. */
const SAFETY_CHECK_MS = 5_000;
/** One read takes at most this much new output; a command that writes more is followed from its newest output. */
const MAX_READ_BYTES = 256 * 1024;
/** Raw text kept for the tail: more than one tail, so a cut lands on a line start. */
const RAW_TAIL_CHARS = LIVE_OUTPUT_TAIL_CHARS * 2;
/** The file may appear a moment after the CLI names it. */
const OPEN_RETRY_MS = 500;
const OPEN_ATTEMPTS = 20;
/** Claude Code ends the file of a command with this line. */
const EXIT_LINE = /\n?\[exited with code (-?\d+)\]\s*$/;

/**
 * The file in which Claude Code writes the output of a command that it runs
 * in the background, read from the result of the tool call that started it:
 * "Command running in background with ID: <id>. Output is being written to:
 * <path>". The task id comes from the result's structured fields, never from
 * its text: a command's own output can print any text. The file must be
 * `<session>/tasks/<task id>.output`, in the CLI's own folder for the session.
 */
export function claudeBackgroundOutputPath(resultText: string, taskId: string, sessionId: string): string | null {
  const match = /Output is being written to: (\S+)/.exec(resultText);
  if (!match || !/^[A-Za-z0-9_-]{1,128}$/.test(taskId) || !sessionId) return null;
  const path = match[1]!.replace(/[.,;]+$/, "");
  if (!isAbsolute(path) || basename(path) !== `${taskId}.output`) return null;
  const tasks = dirname(path);
  if (basename(tasks) !== "tasks" || basename(dirname(tasks)) !== sessionId) return null;
  return path;
}

/** How a background task ended, from Claude Code's status and the command's exit code. */
export function claudeBackgroundEndStatus(status: unknown, exitCode: number | null): LiveBackgroundCommandStatus {
  if (status === "killed" || status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  return exitCode !== null && exitCode !== 0 ? "failed" : "completed";
}

export type BackgroundCommandOutputInput = {
  taskId: string;
  toolUseId: string | null;
  command: string;
  description: string | null;
  path: string;
  startedAt: string;
  now: () => string;
  publish: (payload: LiveBackgroundCommandPayload) => void;
};

/**
 * Follows the output file of one command that Claude Code runs in the
 * background, and publishes its newest lines while it runs.
 * 1. The file is opened once, without following a symbolic link, and only
 *    when it is a regular file of this user.
 * 2. A file watch, with a slow safety check, says that new output arrived.
 *    Reads are paced: one read takes all new bytes since the last read.
 * 3. Each read publishes the newest whole lines (see liveOutputTail).
 * 4. When Claude Code reports that the task ended, a last read publishes the
 *    final output, the exit code and the end state, and the follower stops.
 */
export class BackgroundCommandOutput {
  private file: FileHandle | null = null;
  private watcher: FSWatcher | null = null;
  private safety: ReturnType<typeof setInterval> | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private reading: Promise<void> = Promise.resolve();
  private offset = 0;
  private raw = "";
  private cut = false;
  private decoder = new StringDecoder("utf8");
  private lastPublished = "";
  private closed = false;
  private ended: { status: LiveBackgroundCommandStatus; exitCode: number | null; endedAt: string } | null = null;

  constructor(private readonly input: BackgroundCommandOutputInput) {}

  get taskId(): string {
    return this.input.taskId;
  }

  /** Publish the running state at once, then follow the file. */
  start(): void {
    this.publish();
    void this.openFile(0);
  }

  /** The task ended: read what is left, publish the end, and stop. */
  finish(status: unknown, exitCodeHint: number | null): void {
    if (this.closed || this.ended) return;
    const endedAt = this.input.now();
    this.ended = { status: "running", exitCode: exitCodeHint, endedAt };
    this.stopWatching();
    this.reading = this.reading.then(() => this.readNew()).catch(() => undefined).then(() => {
      if (this.closed || !this.ended) return;
      const exitCode = this.exitCodeFromOutput() ?? exitCodeHint;
      this.ended = { status: claudeBackgroundEndStatus(status, exitCode), exitCode, endedAt };
      this.publish(true);
      this.close();
    });
  }

  /** Stop following without a last event: the agent's runtime ended, and the feed with it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    const file = this.file;
    this.file = null;
    void file?.close().catch(() => undefined);
  }

  private async openFile(attempt: number): Promise<void> {
    if (this.closed || this.ended) return;
    try {
      // O_NOFOLLOW: a symbolic link put in the file's place is never followed.
      const file = await open(this.input.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await file.stat();
      const ownUser = typeof process.getuid !== "function" || info.uid === process.getuid();
      if (!info.isFile() || !ownUser || this.closed) {
        await file.close().catch(() => undefined);
        return;
      }
      this.file = file;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && attempt + 1 < OPEN_ATTEMPTS) {
        const retry = setTimeout(() => void this.openFile(attempt + 1), OPEN_RETRY_MS);
        retry.unref?.();
      }
      return;
    }
    try {
      this.watcher = watch(this.input.path, { persistent: false }, () => this.scheduleRead());
      this.watcher.on("error", () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null;
    }
    this.safety = setInterval(() => this.scheduleRead(), SAFETY_CHECK_MS);
    this.safety.unref?.();
    this.scheduleRead(0);
  }

  private scheduleRead(delayMs = READ_PACE_MS): void {
    if (this.closed || this.ended || this.readTimer) return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      this.reading = this.reading.then(() => this.readNew()).catch(() => undefined).then(() => {
        if (!this.closed && !this.ended) this.publish();
      });
    }, delayMs);
    this.readTimer.unref?.();
  }

  private async readNew(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const { size } = await file.stat();
    if (size < this.offset) {
      // The file was cut short: follow it from its start again.
      this.offset = 0;
      this.raw = "";
      this.cut = true;
      this.decoder = new StringDecoder("utf8");
    }
    if (size - this.offset > MAX_READ_BYTES) {
      this.offset = size - MAX_READ_BYTES;
      this.raw = "";
      this.cut = true;
      this.decoder = new StringDecoder("utf8");
    }
    if (size <= this.offset) return;
    const buffer = Buffer.alloc(size - this.offset);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
    this.offset += bytesRead;
    this.raw += this.decoder.write(buffer.subarray(0, bytesRead));
    if (this.raw.length > RAW_TAIL_CHARS) {
      this.raw = this.raw.slice(-RAW_TAIL_CHARS);
      this.cut = true;
    }
  }

  private exitCodeFromOutput(): number | null {
    const match = EXIT_LINE.exec(this.raw);
    return match ? Number(match[1]) : null;
  }

  private publish(final = false): void {
    if (this.closed) return;
    const text = final ? this.raw.replace(EXIT_LINE, "") : this.raw;
    const tail = liveOutputTail(plainTerminalText(text), { cut: this.cut, final });
    const payload: LiveBackgroundCommandPayload = {
      taskId: this.input.taskId,
      toolUseId: this.input.toolUseId,
      command: this.input.command,
      description: this.input.description,
      status: final && this.ended ? this.ended.status : "running",
      output: tail.text,
      outputTruncated: tail.cut,
      exitCode: final ? this.ended?.exitCode ?? null : null,
      startedAt: this.input.startedAt,
      endedAt: final ? this.ended?.endedAt ?? null : null,
    };
    const key = JSON.stringify([payload.status, payload.output, payload.exitCode]);
    if (!final && key === this.lastPublished) return;
    this.lastPublished = key;
    this.input.publish(payload);
  }

  private stopWatching(): void {
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = null;
    if (this.safety) clearInterval(this.safety);
    this.safety = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

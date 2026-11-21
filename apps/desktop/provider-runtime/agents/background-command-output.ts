import { constants, watch, type FSWatcher } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  LIVE_OUTPUT_TAIL_CHARS,
  liveOutputTail,
  plainTerminalText,
  type LiveBackgroundCommandPayload,
  type LiveBackgroundCommandStatus,
} from "../../../../../shared/live-command-output.mjs";

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
/**
 * A command can print its file's end mark itself and go on. The mark ends the
 * command only when the file then stays the same for this long.
 */
const EXIT_QUIET_MS = 3_000;
/** The longest command and description an event carries. */
const MAX_COMMAND_CHARS = 2_000;
const MAX_DESCRIPTION_CHARS = 300;
/**
 * A final event must fit the stream's payload limit, or it never arrives and
 * the command looks as if it still runs. Above this size it goes without output.
 */
const MAX_PAYLOAD_BYTES = 24 * 1024;

/** How a background command ended, from the agent's own status for it and the command's exit code. */
export function backgroundEndStatus(status: unknown, exitCode: number | null): LiveBackgroundCommandStatus {
  if (status === "killed" || status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  // Ended with the agent's runtime, unless the file's end mark shows how the command ended by itself.
  if (status === "lost") return exitCode === null ? "lost" : exitCode === 0 ? "completed" : "failed";
  return exitCode !== null && exitCode !== 0 ? "failed" : "completed";
}

/**
 * How one agent writes a command's output file: what of the file is the command's output, and the mark with the
 * exit code that the agent adds when the command ends.
 */
export type BackgroundOutputFormat = {
  /** The command's own output in the text read so far (`final`: the command has ended). */
  body(raw: string, final: boolean): string;
  /** The exit code in the agent's end mark at the end of the text read so far, or null. */
  exitCode(raw: string): number | null;
};

export type BackgroundCommandOutputInput = {
  taskId: string;
  toolUseId: string | null;
  command: string;
  description: string | null;
  path: string;
  startedAt: string;
  now: () => string;
  publish: (payload: LiveBackgroundCommandPayload) => void;
  /** The follower has stopped: it published its end, or it was closed. */
  onStopped?: () => void;
  /** How long the file must stay the same after the end mark (EXIT_QUIET_MS; shorter in tests). */
  exitQuietMs?: number;
  format: BackgroundOutputFormat;
};

/**
 * Follows the output file of one command that an agent (Claude Code, Cursor) runs in the
 * background, and publishes its newest lines while it runs.
 * 1. The file is opened once, without following a symbolic link, and only
 *    when it is a regular file of this user.
 * 2. A file watch, with a slow safety check, says that new output arrived.
 *    Reads are paced: one read takes all new bytes since the last read.
 * 3. Each read publishes the newest whole lines (see liveOutputTail).
 * 4. When the agent reports that the command ended, a last read publishes the
 *    final output, the exit code and the end state, and the follower stops.
 * 5. If that report never comes, the end mark that the agent writes at the end
 *    of the file ends the command in what it shows, once the file stays the
 *    same for a moment (see BackgroundOutputFormat).
 */
export class BackgroundCommandOutput {
  private file: FileHandle | null = null;
  private watcher: FSWatcher | null = null;
  private safety: ReturnType<typeof setInterval> | null = null;
  private readTimer: ReturnType<typeof setTimeout> | null = null;
  private exitTimer: ReturnType<typeof setTimeout> | null = null;
  private reading: Promise<void> = Promise.resolve();
  /** The first attempt to open the file has settled: an end that comes at once still reads what the file holds. */
  private opened: Promise<void> = Promise.resolve();
  private offset = 0;
  private raw = "";
  private cut = false;
  private decoder = new StringDecoder("utf8");
  private lastPublished = "";
  private closed = false;
  private ended: { status: LiveBackgroundCommandStatus; exitCode: number | null; endedAt: string } | null = null;
  /** The end came from the exit line alone, at this file offset: new output there takes it back to running. */
  private provisionalAt: number | null = null;
  /** The owner asked to stop the command: an end that the end mark alone shows reads as stopped. */
  private stopRequested = false;

  constructor(private readonly input: BackgroundCommandOutputInput) {}

  get taskId(): string {
    return this.input.taskId;
  }

  /** Publish the running state at once, then follow the file. */
  start(): void {
    this.publish();
    this.opened = this.openFile(0);
  }

  /** The task ended: read what is left, publish the end, and stop. */
  finish(status: unknown, exitCodeHint: number | null): void {
    if (this.closed || this.final()) return;
    this.provisionalAt = null;
    const endedAt = this.input.now();
    this.ended = { status: "running", exitCode: exitCodeHint, endedAt };
    this.stopWatching();
    const reading = this.reading;
    this.reading = this.opened.then(() => reading).then(() => this.readNew()).catch(() => undefined).then(() => {
      if (this.closed || !this.ended) return;
      const exitCode = this.exitCodeFromOutput() ?? exitCodeHint;
      this.ended = { status: backgroundEndStatus(status, exitCode), exitCode, endedAt };
      this.publish(true);
      this.close();
    });
  }

  /** The owner's Stop was sent (true), or did not reach the command (false). */
  noteStopRequested(requested: boolean): void {
    this.stopRequested = requested;
  }

  /** Stop following without a last event: the agent's runtime ended, and the feed with it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopWatching();
    const file = this.file;
    this.file = null;
    void file?.close().catch(() => undefined);
    this.input.onStopped?.();
  }

  private async openFile(attempt: number): Promise<void> {
    if (this.closed || this.ended) return;
    try {
      // O_NOFOLLOW: a symbolic link put in the file's place is never followed.
      // O_NONBLOCK: a pipe put in its place cannot hold the open; it is no regular file and is closed below.
      const file = await open(this.input.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
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
    if (this.closed || this.final() || this.readTimer) return;
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      this.reading = this.reading.then(() => this.readNew()).catch(() => undefined).then(() => {
        if (this.closed || this.final()) return;
        if (this.provisionalAt !== null) {
          if (this.offset === this.provisionalAt) return;
          // Output after the end mark: the command printed that mark itself and still runs.
          this.provisionalAt = null;
          this.ended = null;
        }
        this.publish();
        // The agent writes this mark when the command ends: the end is known even if its notice never comes.
        if (this.exitCodeFromOutput() !== null) this.confirmExit();
      });
    }, delayMs);
    this.readTimer.unref?.();
  }

  /** The output ends with the end mark: the command ended if nothing more arrives before EXIT_QUIET_MS. */
  private confirmExit(): void {
    if (this.closed || this.ended || this.exitTimer) return;
    const offset = this.offset;
    this.exitTimer = setTimeout(() => {
      this.exitTimer = null;
      this.reading = this.reading.then(() => this.readNew()).catch(() => undefined).then(() => {
        if (this.closed || this.ended) return;
        const exitCode = this.exitCodeFromOutput();
        if (this.offset === offset && exitCode !== null) this.endProvisionally(exitCode);
        else if (exitCode !== null) this.confirmExit();
      });
    }, this.input.exitQuietMs ?? EXIT_QUIET_MS);
    this.exitTimer.unref?.();
  }

  /**
   * The end mark ends the command in what the follower shows, but the follower stays: it keeps reading the file,
   * new output takes the command back to running, and the agent's own notice still ends it for good.
   */
  private endProvisionally(exitCode: number): void {
    this.ended = { status: backgroundEndStatus(this.stopRequested ? "stopped" : "completed", exitCode), exitCode, endedAt: this.input.now() };
    this.provisionalAt = this.offset;
    this.publish(true);
  }

  /** The end is known for good: from the agent's notice, not from the end mark alone. */
  private final(): boolean {
    return this.ended !== null && this.provisionalAt === null;
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
    return this.input.format.exitCode(this.raw);
  }

  private publish(final = false): void {
    if (this.closed) return;
    const text = this.input.format.body(this.raw, final);
    const tail = liveOutputTail(plainTerminalText(text), { cut: this.cut, final });
    const payload: LiveBackgroundCommandPayload = {
      taskId: this.input.taskId,
      toolUseId: this.input.toolUseId,
      command: this.input.command.slice(0, MAX_COMMAND_CHARS),
      description: this.input.description?.slice(0, MAX_DESCRIPTION_CHARS) ?? null,
      status: final && this.ended ? this.ended.status : "running",
      output: tail.text,
      outputTruncated: tail.cut,
      exitCode: final ? this.ended?.exitCode ?? null : null,
      startedAt: this.input.startedAt,
      endedAt: final ? this.ended?.endedAt ?? null : null,
    };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_PAYLOAD_BYTES) {
      payload.output = "";
      payload.outputTruncated = true;
    }
    // The same value again says nothing new: the agent's notice after an end that the end mark already showed.
    const key = JSON.stringify([payload.status, payload.output, payload.exitCode]);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.input.publish(payload);
  }

  private stopWatching(): void {
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = null;
    if (this.exitTimer) clearTimeout(this.exitTimer);
    this.exitTimer = null;
    if (this.safety) clearInterval(this.safety);
    this.safety = null;
    this.watcher?.close();
    this.watcher = null;
  }
}

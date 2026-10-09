import assert from "node:assert/strict";

import type {
  EmitInboundEntry,
  ExpectOutboundEntry,
  JsonObject,
  Located,
  ProviderReplayEntry,
  ProviderReplayTranscript,
  RuntimeExitEntry,
} from "./transcript.js";

/**
 * Plays one transcript in place of a provider runtime. It knows nothing about
 * any provider: a transport gives it the frames the adapter sends, and it
 * gives the transport the frames to deliver.
 *
 * The session walks the entries in file order, one entry per event-loop turn:
 *
 * - `emit_inbound`: the frame is delivered to the adapter.
 * - `expect_outbound`: the session waits here until the adapter has sent a
 *   frame, then checks it against the recording. Nothing recorded after this
 *   entry is delivered first.
 * - `runtime_exit`: the runtime ends. When the recording says LetAgents asked
 *   for the stop, the session waits here until the adapter asks.
 *
 * Recorded timing is ignored. The adapter may send a frame earlier than the
 * recording shows, because the replay is faster than the provider was; the
 * frame then waits its turn. The order of the adapter's own frames, and the
 * order of the provider's, are exactly the recorded ones.
 *
 * The limit of that: order is checked for each direction, not across them.
 * A frame the adapter sends before inbound frames that the recording holds
 * ahead of it is accepted. So a replay does not prove that the adapter waited
 * for a reply before it sent its next request: an adapter that sends
 * `thread/start` without waiting for the `mcpServerStatus/list` reply still
 * passes. Real interleavings differ from run to run, so this is not made
 * stricter. Assert such a dependency on what the adapter shows its caller.
 */
export interface ProviderReplayTransport {
  deliverInbound(frame: JsonObject, entry: Located<EmitInboundEntry>): void;
  exitRuntime(entry: Located<RuntimeExitEntry>): void;
  /** Applied to a recorded inbound frame before delivery, for example to fill in this run's workspace path. */
  prepareInbound?(frame: JsonObject): JsonObject;
  /** Applied to the recorded and to the sent outbound frame before they are compared. */
  normalizeOutbound?(frame: JsonObject): JsonObject;
}

export interface ProviderReplaySessionOptions {
  /**
   * How long the session waits for the adapter before it reports a stall.
   * It is a failure guard only: a passing replay never waits for it.
   */
  stallTimeoutMs?: number;
}

const DEFAULT_STALL_TIMEOUT_MS = 10_000;

function describeEntry(entry: Located<ProviderReplayEntry>): string {
  const label = entry.type === "runtime_exit" ? "" : ` ${JSON.stringify(entry.label ?? frameName(entry.frame))}`;
  return `${entry.type}${label} (line ${entry.line})`;
}

/** A short name for a frame: its method, or `response` for a reply. */
export function frameName(frame: JsonObject): string {
  if (typeof frame.method === "string") return frame.method;
  if (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error")) return "response";
  return "frame";
}

export class ProviderReplaySession {
  /** Every frame the adapter sent, as it sent it, in order. */
  readonly outbound: JsonObject[] = [];
  /**
   * Frames the adapter sent after the replay ended. `run` cannot report a
   * frame that comes after it returned, so a test file checks this in an
   * `after` hook. Each such frame also throws to its sender.
   */
  readonly lateFrames: JsonObject[] = [];
  /** Settles when the whole transcript has been played, or with the first failure. */
  readonly finished: Promise<void>;

  private readonly entries: readonly Located<ProviderReplayEntry>[];
  private readonly outbox: JsonObject[] = [];
  private readonly deliveredListeners = new Set<(entry: Located<EmitInboundEntry>) => void>();
  private readonly exitWaiters: Array<() => void> = [];
  private readonly stallTimeoutMs: number;
  private cursor = 0;
  private opened = false;
  private exitRequested = false;
  private exitIsNext = false;
  private scheduled = false;
  private delivering = false;
  private done = false;
  private disposed = false;
  private error: Error | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private settle!: { resolve: () => void; reject: (error: Error) => void };

  constructor(
    private readonly transcript: ProviderReplayTranscript,
    private readonly transport: ProviderReplayTransport,
    options: ProviderReplaySessionOptions = {},
  ) {
    this.entries = transcript.entries;
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.finished = new Promise<void>((resolve, reject) => { this.settle = { resolve, reject }; });
    // A caller that never awaits `finished` must not see an unhandled rejection.
    this.finished.catch(() => undefined);
  }

  /** The transport is connected: start playing. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.schedule();
  }

  /** The adapter sent a frame. */
  send(frame: JsonObject): void {
    this.outbound.push(frame);
    if (this.done || this.disposed) {
      // Nothing plays this frame. While `run` still waits, it fails the run;
      // after that only `lateFrames` and this throw can report it.
      this.lateFrames.push(frame);
      const error = new Error(`The adapter sent ${JSON.stringify(frameName(frame))} after the replay ended.`);
      this.fail(error);
      throw error;
    }
    this.outbox.push(frame);
    this.schedule();
  }

  /** The adapter asked the runtime to stop. */
  requestExit(): void {
    this.exitRequested = true;
    this.schedule();
  }

  /**
   * Called right after each recorded inbound frame has been given to the
   * adapter, before the adapter continues from anything it awaited. A listener
   * that wants to see the adapter's reaction waits one `setImmediate`: that
   * runs after the reaction and before the session plays its next entry.
   */
  onInboundDelivered(listener: (entry: Located<EmitInboundEntry>) => void): () => void {
    this.deliveredListeners.add(listener);
    return () => this.deliveredListeners.delete(listener);
  }

  /**
   * Resolves when everything before `runtime_exit` has been played: the
   * provider has nothing more to say until it is stopped.
   */
  untilExitIsNext(): Promise<void> {
    if (this.error) return Promise.reject(this.error);
    if (this.done || this.exitIsNext) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.exitWaiters.push(resolve);
      this.finished.catch(reject);
    });
  }

  /**
   * Run a test body against this session. The body's result is returned once
   * the whole transcript has been played. A frame that does not match the
   * recording fails the run even when the adapter swallows the error.
   */
  async run<T>(body: () => Promise<T>): Promise<T> {
    try {
      const failed = new Promise<never>((_, reject) => { this.finished.catch(reject); });
      const value = await Promise.race([body(), failed]);
      await this.finished;
      // A frame sent after the last recorded entry is a failure too.
      if (this.error) throw this.error;
      return value;
    } finally {
      this.dispose();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    if (!this.done && !this.error) this.fail(new Error(`The replay was dropped before ${this.describeNext()}.`));
  }

  private describeNext(): string {
    const entry = this.entries[this.cursor];
    return entry ? describeEntry(entry) : "the end of the recording";
  }

  private schedule(): void {
    // While a frame is being delivered, the step itself schedules the next one, after its listeners.
    if (this.scheduled || this.delivering || this.done || this.error || !this.opened) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.step();
    });
  }

  /** Hold the event loop open while the adapter owes a frame, and report it if the frame never comes. */
  private armStallGuard(waitingFor: string): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      this.fail(new Error(
        `The replay of ${this.transcript.source} stalled: ${waitingFor}, and nothing came within ${this.stallTimeoutMs} ms.`,
      ));
    }, this.stallTimeoutMs);
  }

  private step(): void {
    if (this.done || this.error) return;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    const entry = this.entries[this.cursor]!;

    if (entry.type === "emit_inbound") {
      this.cursor += 1;
      this.delivering = true;
      try {
        this.transport.deliverInbound(this.transport.prepareInbound?.(entry.frame) ?? entry.frame, entry);
        for (const listener of [...this.deliveredListeners]) listener(entry);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      } finally {
        this.delivering = false;
      }
      // Scheduled last, so an immediate that a listener set runs before the next entry is played.
      this.schedule();
      return;
    }

    if (entry.type === "expect_outbound") {
      const sent = this.outbox.shift();
      if (!sent) {
        this.armStallGuard(`the recording expects the adapter to send ${describeEntry(entry)}`);
        return;
      }
      if (!this.matches(entry, sent)) return;
      this.cursor += 1;
      this.schedule();
      return;
    }

    if (this.outbox.length) {
      this.fail(new Error(
        `The adapter sent ${JSON.stringify(frameName(this.outbox[0]!))}, which the recording does not hold: `
        + `the next recorded entry is ${describeEntry(entry)}.`,
      ));
      return;
    }
    // The adapter has had a full turn of the event loop since the last frame.
    this.exitIsNext = true;
    for (const waiter of this.exitWaiters.splice(0)) waiter();
    if (entry.requested && !this.exitRequested) {
      this.armStallGuard("the recording expects the adapter to stop the runtime");
      return;
    }
    this.cursor += 1;
    this.done = true;
    try {
      this.transport.exitRuntime(entry);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.settle.resolve();
  }

  private matches(entry: Located<ExpectOutboundEntry>, sent: JsonObject): boolean {
    const normalize = (frame: JsonObject) => this.transport.normalizeOutbound?.(frame) ?? frame;
    try {
      // No message of our own here: Node then writes the diff of the two frames.
      assert.deepStrictEqual(normalize(sent), normalize(entry.frame));
      return true;
    } catch (error) {
      const position = this.outbound.length - this.outbox.length;
      this.fail(new Error(
        `Outbound frame ${position} does not match the recording (${this.transcript.source}, ${describeEntry(entry)}). `
        + `"actual" is what the adapter sent, "expected" is what was recorded.\n${(error as Error).message}`,
        { cause: error },
      ));
      return false;
    }
  }

  private fail(error: Error): void {
    if (this.error) return;
    this.error = error;
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
    this.settle.reject(error);
  }
}

import { posix } from "node:path";

import { SIGN_IN_NOT_HIDDEN, codexReadOnlyProfileOverrides } from "../../main/agents/codex-agent-home.js";
import { READ_ONLY_POLICY_WITHOUT_LEVEL, type CodexAppServerExit } from "../../main/agents/codex-app-server.js";
import type { CodexProviderAdapterDependencies } from "../../main/agents/codex-provider-adapter.js";
import { CodexRpcClient, type CodexRpcWebSocketCtor } from "../../main/agents/codex-rpc-client.js";
import { REPLAY_HOME_DIRECTORY, REPLAY_WORKSPACE } from "./redaction.js";
import { ProviderReplaySession, type ProviderReplaySessionOptions } from "./replay-session.js";
import type { JsonObject, JsonValue, ProviderReplayTranscript } from "./transcript.js";

/**
 * Plays a recorded Codex app-server in place of the real one.
 *
 * The seam is the WebSocket the RPC client opens. Everything above it is
 * production code: `CodexRpcClient` (request ids, the initialize handshake,
 * response and server-request correlation) and `CodexProviderAdapter`. Below
 * it, the recording stands in for the socket and for the process: launching
 * returns a process that lives until the recorded `runtime_exit`.
 *
 * The launch is a stand-in too, for the launch that was recorded: one whose
 * checks of Codex passed. It starts nothing. It refuses what the product's
 * launch refuses before it starts anything, in the product's own words, and
 * it keeps what it was asked for, with the overrides the product's launch
 * gives Codex for a Read-only agent's permission profile (`launches`).
 *
 * Outbound frames are compared with the recording exactly, request ids
 * included: the real client numbers its requests the same way every run.
 * Two things are made equal on both sides before the comparison:
 *
 * 1. The workspace path. A recording holds `<workspace>`; a replay runs in a
 *    path of its own. Inbound frames get this run's path, and it is taken
 *    out of outbound frames again.
 * 2. The text of a `turn/start` input. It is LetAgents' own prompt wording,
 *    not Codex protocol, and it changes without the protocol changing. A test
 *    asserts the parts of the prompt it cares about on `session.outbound`.
 */
export const CODEX_REPLAY_PROTOCOL = "codex.app-server/websocket";
export const CODEX_REPLAY_PROMPT = "<prompt>";

const REPLAY_PID = 4242;
/** The shape `ps -o lstart=` prints; the adapter keeps it as the process's birth. */
const REPLAY_PROCESS_IDENTITY = "Thu Jan  1 00:00:00 2026";
const REPLAY_SERVER_URL = "ws://codex-replay.invalid";

function mapStrings(value: JsonValue, map: (text: string) => string): JsonValue {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapStrings(child, map)]));
  }
  return value;
}

function replaceAll(text: string, search: string, replacement: string): string {
  return text.split(search).join(replacement);
}

/** See the two rules above. Applied to the recorded frame and to the sent one. */
export function normalizeCodexOutbound(frame: JsonObject, workspace: string): JsonObject {
  const normalized = mapStrings(frame, (text) => replaceAll(text, workspace, REPLAY_WORKSPACE)) as JsonObject;
  const params = normalized.params;
  if (normalized.method !== "turn/start" || params === null || typeof params !== "object" || Array.isArray(params)) {
    return normalized;
  }
  const input = params.input;
  if (!Array.isArray(input)) return normalized;
  return {
    ...normalized,
    params: {
      ...params,
      input: input.map((item) =>
        item !== null && typeof item === "object" && !Array.isArray(item) && typeof item.text === "string"
          ? { ...item, text: CODEX_REPLAY_PROMPT }
          : item),
    },
  };
}

export interface CodexReplayOptions extends ProviderReplaySessionOptions {
  /** The folder the adapter is told to work in. Nothing is read from it or written to it. */
  workspace: string;
  /**
   * What the launch's check of this Codex found: whether it keeps a file that
   * a permission profile denies from a command. It passed when a recording was
   * made, and that is the default. `false` stands for a Codex that did not
   * show it: the product's launch then starts nothing for a Read-only agent.
   */
  codexHonoursDeny?: boolean;
}

/** One launch the adapter asked for, and what the product's launch would have started Codex with. */
export interface CodexReplayLaunch {
  /** What the adapter asked the launch for. */
  options: Parameters<CodexProviderAdapterDependencies["launchServer"]>[2];
  /** The home the recorded Codex ran with, which its `initialize` reply names. Null when the launch asked for no home of the agents'. */
  codexHome: string | null;
  /**
   * The overrides that define the launch's permission profile, with the owner's
   * sign-in file denied, and that make it the default. The paths are the
   * recording's stand-ins for the owner's Codex home and for the agents'.
   * Empty for a launch that names no profile.
   */
  profileOverrides: string[];
}

/** The folder a recorded Codex said it runs with. Null when the recording does not hold it. */
function recordedCodexHome(transcript: ProviderReplayTranscript): string | null {
  for (const entry of transcript.entries) {
    if (entry.type !== "emit_inbound" || entry.label !== "initialize") continue;
    const result = entry.frame.result;
    const home = result !== null && typeof result === "object" && !Array.isArray(result) ? result.codexHome : undefined;
    return typeof home === "string" && home ? home : null;
  }
  return null;
}

export class CodexReplay {
  readonly session: ProviderReplaySession;
  /** Every signal the adapter sent to the app-server process. */
  readonly signals: NodeJS.Signals[] = [];
  /** Every launch the adapter asked for and was given. */
  readonly launches: CodexReplayLaunch[] = [];
  /** Give these to `new CodexProviderAdapter({ dependencies })`. Nothing here starts a process. */
  readonly dependencies: CodexProviderAdapterDependencies;

  private socket: ReplaySocket | null = null;
  private alive = true;
  private clock = 0;
  private resolveExit!: (exit: CodexAppServerExit) => void;
  private readonly exited = new Promise<CodexAppServerExit>((resolve) => { this.resolveExit = resolve; });

  constructor(transcript: ProviderReplayTranscript, options: CodexReplayOptions) {
    if (transcript.start.provider !== "codex" || transcript.start.protocol !== CODEX_REPLAY_PROTOCOL) {
      throw new Error(`${transcript.source} is not a ${CODEX_REPLAY_PROTOCOL} recording.`);
    }
    const { workspace } = options;
    this.session = new ProviderReplaySession(transcript, {
      prepareInbound: (frame) => mapStrings(frame, (text) => replaceAll(text, REPLAY_WORKSPACE, workspace)) as JsonObject,
      normalizeOutbound: (frame) => normalizeCodexOutbound(frame, workspace),
      deliverInbound: (frame, entry) => {
        if (!this.socket?.deliver(JSON.stringify(frame))) {
          throw new Error(`The adapter closed its connection, but the recording still holds a frame for it (line ${entry.line}).`);
        }
      },
      exitRuntime: (entry) => {
        // A real app-server's socket closes about when its process exits. The
        // adapter reacts to whichever it sees first, so the recorded order is kept.
        const exit = () => {
          this.alive = false;
          this.resolveExit({ type: "exit", code: entry.code, signal: entry.signal as NodeJS.Signals | null });
        };
        const close = () => this.socket?.closeFromServer();
        const [first, second] = entry.transportClosedBeforeExit ? [close, exit] : [exit, close];
        first();
        setImmediate(second);
      },
    }, options);
    // A failed replay answers nothing more. Drop the connection and the
    // process, so the adapter fails at once instead of waiting out its timeouts.
    this.session.finished.catch(() => {
      if (!this.alive) return;
      this.alive = false;
      this.resolveExit({ type: "exit", code: null, signal: null });
      this.socket?.closeFromServer();
    });

    const notReplayed = (name: string) => (): never => {
      throw new Error(`The Codex replay does not cover ${name}. Record a scenario that needs it before a test relies on it.`);
    };
    this.dependencies = {
      resolveMcpRuntime: notReplayed("resolveMcpRuntime"),
      readMcpRuntimeContract: notReplayed("readMcpRuntimeContract"),
      assertLiveProjectUnchanged: notReplayed("assertLiveProjectUnchanged"),
      // Which command rules a Codex would read, and which MCP servers a launch would turn off now, is asked
      // of a second Codex process, of the disk and of the process list. A recording holds none of them, so
      // the stand-ins refuse nothing. The command line is read before the second question and is not looked at.
      sandboxedLoadRefusal: async () => null,
      readCommandLine: async () => "codex app-server (replayed)",
      assertLiveIsolationUnchanged: async () => {},
      writeSupervisorBridgeContext: notReplayed("writeSupervisorBridgeContext"),
      resolveServerUrl: async () => REPLAY_SERVER_URL,
      launchServer: (_serverUrl, _codexBin, launch) => {
        const profile = launch.hideSignInProfile?.trim() || undefined;
        // What the product's launch refuses: the Read-only policy without the level's profile, before it asks
        // Codex anything; and a Read-only launch for a Codex that did not pass the check.
        if (launch.readOnlySandbox === true && !profile) throw new Error(READ_ONLY_POLICY_WITHOUT_LEVEL);
        if (profile && options.codexHonoursDeny === false) throw new Error(SIGN_IN_NOT_HIDDEN);
        // A sandboxed launch runs Codex with the agents' home, and says so: the adapter holds Codex's own word to it.
        const codexHome = launch.sandboxed === true ? recordedCodexHome(transcript) : null;
        this.launches.push({
          options: launch,
          codexHome,
          profileOverrides: profile ? codexReadOnlyProfileOverrides(profile, [
            posix.join(REPLAY_HOME_DIRECTORY, ".codex", "auth.json"),
            ...(codexHome ? [posix.join(codexHome, "auth.json")] : []),
          ]) : [],
        });
        return { pid: REPLAY_PID, exited: this.exited, ...(codexHome ? { codexHome } : {}) };
      },
      waitForServer: async () => true,
      createRpcClient: (serverUrl, onNotification) =>
        new CodexRpcClient(serverUrl, onNotification, undefined, this.webSocketCtor()),
      signalProcess: (_pid, signal) => {
        this.signals.push(signal);
        this.session.requestExit();
      },
      getProcessIdentity: () => (this.alive ? REPLAY_PROCESS_IDENTITY : null),
      observeProcessExit: () => this.exited,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, this.clock++)).toISOString(),
      sleep: async () => {},
    };
  }

  /** The socket class the real RPC client opens. One recording holds one connection. */
  private webSocketCtor(): CodexRpcWebSocketCtor {
    const replay = this;
    class RecordedSocket extends ReplaySocket {
      constructor(_url: string) {
        super();
        if (replay.socket) throw new Error("The recording holds one connection, and the adapter opened a second one.");
        replay.socket = this;
        this.onSend = (text) => replay.session.send(JSON.parse(text) as JsonObject);
        // A real socket opens on a later turn of the event loop, never inside its constructor.
        setImmediate(() => { if (this.open()) replay.session.open(); });
      }
    }
    // The client uses only what ReplaySocket has: the four handlers, send, close and readyState.
    return RecordedSocket as unknown as CodexRpcWebSocketCtor;
  }
}

/** The part of a WebSocket that `CodexRpcClient` uses. */
class ReplaySocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState: number = ReplaySocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  protected onSend: (text: string) => void = () => {};

  protected open(): boolean {
    if (this.readyState !== ReplaySocket.CONNECTING) return false;
    this.readyState = ReplaySocket.OPEN;
    this.onopen?.({});
    return true;
  }

  send(data: string): void {
    if (this.readyState !== ReplaySocket.OPEN) throw new Error("The replayed Codex connection is not open.");
    this.onSend(String(data));
  }

  /** Give the adapter one recorded frame. False when it has closed the connection. */
  deliver(data: string): boolean {
    if (this.readyState !== ReplaySocket.OPEN) return false;
    this.onmessage?.({ data });
    return true;
  }

  /** The adapter closes its end. Like a real socket, the close event comes on a later turn. */
  close(): void {
    if (this.readyState === ReplaySocket.CLOSED) return;
    this.readyState = ReplaySocket.CLOSED;
    setImmediate(() => this.onclose?.({}));
  }

  closeFromServer(): void {
    if (this.readyState === ReplaySocket.CLOSED) return;
    this.readyState = ReplaySocket.CLOSED;
    this.onclose?.({});
  }
}

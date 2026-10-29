import type { ProviderActivityEvent, ProviderSpawnRequest, ProviderStreamEvent } from "../provider-adapter.js";
import type { ProviderProcessExit } from "../provider-evidence.js";
import type { ClaudeEvidenceRecord, ClaudeExactTurnFailure, ClaudeExactTurnResult } from "../claude-room-turn-evidence.js";

/** One parsed stream-json line from the CLI. */
export type ClaudeStreamMessage = Record<string, unknown> & { type?: unknown; subtype?: unknown };

export interface ClaudeCliChild {
  pid: number | null;
  exited: Promise<ProviderProcessExit>;
  /** Output volume only; native stderr contents never leave the child owner. */
  stderrBytesRead?(): number;
  /** Positive native spawn failure before any child process was acquired. */
  didNotSpawn?(): boolean;
  /** Ordered stdout stream-json lines (raw, one JSON document per line). */
  onLine(listener: (line: string) => void): () => void;
  /** Control-channel loss (stdout closed while the child was not stopped by us). */
  onDisconnect(listener: () => void): () => void;
  /** Write one stream-json input line (a user message) to the CLI's stdin. */
  writeLine(json: string): void;
  /** Close stdin; in --input-format stream-json mode the CLI finishes and exits. */
  endInput(): void;
  /** Mark teardown as intentional so the stdio close does not read as control loss. */
  markIntentionalClose(): void;
}

export interface ClaudeCodeProviderAdapterDependencies {
  readVersion(claudeBin: string): Promise<string>;
  /** `ownerSetup` marks a launch whose CLI environment the owner's own servers and hooks inherit. */
  launchChild(input: { claudeBin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; ownerSetup?: true }): ClaudeCliChild;
  /** `roomServerEnvironment` is given to the room's server alone, in its own configuration. */
  createLetAgentsMcpConfig(
    req: ProviderSpawnRequest,
    roomServerEnvironment?: Record<string, string>,
  ): Promise<{ path: string; dispose(): Promise<void> }>;
  /** `identity`: the recorded birth; on Windows a pid this process does not hold is ended only with it. */
  signalProcess(pid: number, signal: NodeJS.Signals, identity?: string | null): void;
  /** null means verified absent; undefined means liveness could not be verified. */
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<ProviderProcessExit>;
  /**
   * The rows of a session's transcript, read where the CLI that ran it wrote
   * it (`transcriptsRoot`, its `projects` directory). Null when no transcript
   * for the session is found there: that proves nothing about the turn.
   */
  readSessionRows(sessionId: string, transcriptsRoot?: string): Promise<ClaudeEvidenceRecord[] | null>;
  /** The managed commit identity for this work attempt, or none. */
  resolveCommitEnvironment(req: ProviderSpawnRequest): Promise<Record<string, string>>;
  /** The owner's own `MCP_TIMEOUT`, when their environment sets one. Defaults to the desktop's environment. */
  ownerMcpTimeout?(): string | undefined;
  now(): string;
}

export interface ClaudeCodeProviderAdapterOptions {
  claudeBin?: string;
  dependencies?: Partial<ClaudeCodeProviderAdapterDependencies>;
  activitySink?: (event: ProviderActivityEvent) => void;
  streamSink?: (event: ProviderStreamEvent) => void;
  /** Cumulative startup time outside positively observed compaction. */
  initTimeoutMs?: number;
  /** The same budget for resuming a saved conversation; defaults to initTimeoutMs when only that is set. */
  resumeInitTimeoutMs?: number;
  /** Cumulative time spent compacting during one startup; defaults to five minutes. */
  compactionTimeoutMs?: number;
  /** SIGTERM → SIGKILL escalation window for stop() and the attach-path fence. */
  stopGraceMs?: number;
  /** How long a room turn stays open for a sub-agent that it started; defaults to thirty minutes. */
  backgroundSubagentWaitLimitMs?: number;
  /** How long a room turn stays open for a background command, or other work, that still runs; defaults to two minutes. */
  backgroundCommandWaitLimitMs?: number;
  /** How long the answer to a finished task's notice gets to begin; defaults to five minutes. */
  backgroundNoticeStartLimitMs?: number;
  /** How often a turn that is held open says so again, with the time it has waited; defaults to one minute. */
  backgroundWorkNoticeEveryMs?: number;
}

export type ClaudeRoomTurnTerminal = ClaudeExactTurnResult | ClaudeExactTurnFailure;

export type ClaudeHeldRoomTurn = {
  turnId: string;
  /** The turn's own result line. It is published when the turn ends. */
  result: ClaudeStreamMessage;
  /** What the model wrote for the room: the turn's own answer, then each answer to a notice. */
  answers: string[];
  sinceMs: number;
  /** A line of the answer to a notice has been seen, and its result has not. */
  answering: boolean;
  /** Since when all the work that the turn waits for has ended, and no line of an answer has been seen. */
  answerDueSinceMs: number | null;
  /** Since when none of the turn's work runs. */
  endedSinceMs: number | null;
  /** The lines that were published since the turn last said what it waits for. */
  linesSinceNotice: number;
  /** Says again, at a fixed pace, what the turn waits for. */
  notice: ReturnType<typeof setInterval>;
  /** Looks again when the next limit is reached. */
  wake: ReturnType<typeof setTimeout> | null;
};

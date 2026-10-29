/** Adapter limits and constants, dependency and option contracts, capabilities and the permission observation type. */
import type { ChildProcess } from "node:child_process";
import type { ProviderAdapterCapabilities } from "../provider-adapter.js";
import type { ProviderProcessExit } from "../provider-evidence.js";
import type { HardControlEvidence } from "../../../../shared/execution-protocol.js";
import type { OpenCodePermissionRequest } from "../opencode-server-client.js";

export const START_TIMEOUT_MS = 30_000;
export const TURN_TIMEOUT_MS = 30 * 60_000;
export const TURN_CONTROL_TIMEOUT_MS = 5_000;
export const MAX_ASSISTANT_STEPS = 32;
export const NO_REPLY_SENTINEL = "LETAGENTS_NO_ROOM_REPLY";
// A session that ever received a user message outside OpenCode's ascending ID
// scheme can never satisfy the native loop-exit predicate again; the whole
// transcript must be scanned once before this process dispatches into it.
export const SESSION_ORDERING_SCAN_LIMIT = 4_096;

export interface OpenModelProviderAdapterDependencies {
  launch(input: {
    binary: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }): { child: ChildProcess; exited: Promise<ProviderProcessExit> };
  getProcessIdentity(pid: number): string | null | undefined;
  observeProcessExit(pid: number, processIdentity: string): Promise<ProviderProcessExit>;
  /** `identity`: the recorded birth; on Windows a pid this process does not hold is ended only with it. */
  signalProcess(pid: number, signal: NodeJS.Signals, identity?: string | null): void;
  allocatePort(): Promise<number>;
  discoverRuntimeConnection(runtimeRoot: string): Promise<{ pid: number; url: string } | null>;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  now(): string;
  /** Null when Git, run with the launch's environment, takes the workspace as a repository. */
  probeGit(workspace: string, environment: NodeJS.ProcessEnv): Promise<string | null>;
}

export interface OpenModelProviderAdapterOptions {
  binary?: string;
  runtimeRoot?: string;
  dependencies?: Partial<OpenModelProviderAdapterDependencies>;
  startTimeoutMs?: number;
  turnTimeoutMs?: number;
  turnControlTimeoutMs?: number;
  maxAssistantSteps?: number;
  stopGraceMs?: number;
}

export const CAPABILITIES: ProviderAdapterCapabilities = {
  deliveryModes: ["daemon_inbox"],
  resume: true,
  midTurnInjection: false,
  // Open Model cannot resume an interrupted turn; corrections are delivered via
  // stop-then-resend on the same OpenCode session.
  midTurnCorrection: false,
  transcriptAccess: true,
  permissionPromptBridging: false,
  survivesRestart: true,
  turnControl: "native_interrupt",
  continuationRepair: "same_process",
  execution: {
    controlProbe: "http",
    approvals: { kinds: ["command", "file_change"], recovery: "native_instance_only", denyScope: "session" },
  },
};

/** Native request data is host-ephemeral; it is never an execution fact or room projection. */
export type OpenCodePermissionObservation =
  | { type: "snapshot"; requests: OpenCodePermissionRequest[] }
  | { type: "degraded" }
  | { type: "unavailable"; reason: HardControlEvidence | "handle_replaced" };

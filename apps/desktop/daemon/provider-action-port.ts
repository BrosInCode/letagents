/**
 * Daemon-side mirror of the Electron ProviderAdapter.  P1e owns the
 * control-socket bridge; keeping this structural port here keeps reconciliation
 * outside Electron's failure domain.
 */
export type ProviderActionCapabilities = {
  resume: boolean;
  midTurnInjection: boolean;
  transcriptAccess: boolean;
  permissionPromptBridging: boolean;
  survivesRestart: boolean;
  turnControl?: "native_interrupt" | "restart_resume" | "unsupported";
};
export type ProviderTurnControlResult = {
  capability: NonNullable<ProviderActionCapabilities["turnControl"]>;
  interrupted: boolean;
  resumed: boolean;
  state: "idle" | "working";
};
export type ProviderActionConnectionRef =
  | { kind: "codex_app_server"; url: string; pid: number | null; processIdentity?: string | null }
  | { kind: "claude_cli"; pid: number | null; processIdentity?: string | null }
  | { kind: "cursor_cli"; pid: number | null; processIdentity?: string | null };

/**
 * Compare the complete durable identity of two native provider connections.
 * A missing connection, PID, or process-birth identity is unknown evidence and
 * therefore never sufficient to authenticate a cached live handle.
 */
export function sameProviderActionConnectionIdentity(
  expected: ProviderActionConnectionRef | null | undefined,
  actual: ProviderActionConnectionRef | null | undefined,
): boolean {
  if (!expected || !actual || expected.kind !== actual.kind) return false;
  if (expected.pid === null || actual.pid === null) return false;
  if (expected.pid !== actual.pid) return false;
  if (!expected.processIdentity || !actual.processIdentity) return false;
  if (expected.processIdentity !== actual.processIdentity) return false;
  if (expected.kind === "codex_app_server") {
    return actual.kind === "codex_app_server" && Boolean(expected.url) && expected.url === actual.url;
  }
  return true;
}

export type ProviderActionRef = { workAttemptId: string; providerContinuationId: string; provider?: string; providerConnection?: ProviderActionConnectionRef | null };
export type ProviderActionSpawn = { workAttemptId: string; roomId: string; cwd: string; launchPolicy: unknown; provider?: string; agentDisplayName?: string; resumeFrom?: ProviderActionRef | null; actionId?: string; supervisorEntryId?: string; supervisorSocketPath?: string; supervisorExecutionGenerationId?: string; supervisorWorkerSession?: { agentSessionId: string; roomCursor: string | null }; devMcpServerEntryPath?: string };
export type ProviderActionHandle = { workAttemptId: string; pid: number | null; providerContinuationId: string | null; providerConnection?: ProviderActionConnectionRef | null; observedState: "starting" | "working" | "idle" | "stopping" | "stopped" | "failed" };
export type ProviderActionTerminal = { endedAt: string; exitCode: number | null; signal: string | null; terminalCause: "exited" | "killed" | "stopped" | "crashed" | "protocol_error" | "provider_quota"; providerContinuationId: string | null };
export type ProviderActionAttachTerminal = { state: "terminal"; terminal: ProviderActionTerminal };
export type ProviderActionAttachment = { state: "attached"; handle: ProviderActionHandle } | { state: "absent" } | { state: "ambiguous"; reason: string };
export type ProviderActionStreamEvent = {
  workAttemptId: string;
  providerContinuationId: string | null;
  observedAt: string;
  sequence: number;
  provider: string;
  kind: string;
  method: string;
  payload: unknown;
  payloadTruncated: boolean;
  payloadRedacted: boolean;
  durablePayloadRef: string | null;
};

/**
 * One durable room delivery. The daemon owns retries and publication; the
 * provider adapter owns only this bounded turn on an already-running handle.
 */
export type ProviderRoomTurnRequest = {
  inboxItemId: string;
  sourceMessage: unknown;
  activation: Record<string, unknown>;
  actionId: string;
};
export type ProviderRoomTurnResult = {
  turnId: string;
  outcome: "reply" | "no_reply";
  text: string | null;
};
export type ProviderRoomTurnRecoveryRequest = { inboxItemId: string; providerTurnId: string };

export interface ProviderActionPort {
  capabilities(workAttemptId: string, provider?: string): Promise<ProviderActionCapabilities>;
  spawn(request: ProviderActionSpawn): Promise<ProviderActionHandle>;
  attach(ref: ProviderActionRef): Promise<ProviderActionHandle | ProviderActionAttachTerminal | null>;
  /** Recover an intent journaled before dispatch, never by spawning a second child. */
  attachAction(actionId: string, workAttemptId: string): Promise<ProviderActionAttachment>;
  resume(ref: ProviderActionRef, request: ProviderActionSpawn): Promise<ProviderActionHandle>;
  poke(handle: ProviderActionHandle, message: string, options?: { actionId?: string }): Promise<void>;
  controlTurn?(handle: ProviderActionHandle, correction?: string | null, options?: {
    actionId?: string;
    markDispatched?: () => Promise<void>;
  }): Promise<ProviderTurnControlResult>;
  runRoomTurn?(handle: ProviderActionHandle, request: ProviderRoomTurnRequest, options?: {
    /** Durable intent checkpoint; completes before the first native turn/start side effect. */
    beforeNativeDispatch?: () => Promise<void>;
    /** Durable exact turn checkpoint; completes after turn/start returns and before terminal observation. */
    checkpointTurnStarted?: (turnId: string) => Promise<void>;
    /** Detach this local observation without interrupting the native turn. */
    detachSignal?: AbortSignal;
    /** @deprecated compatibility alias; new providers must use beforeNativeDispatch. */
    markDispatched?: () => Promise<void>;
  }): Promise<ProviderRoomTurnResult>;
  /** Recover only this persisted native turn; implementations must never call turn/start. */
  recoverRoomTurn?(handle: ProviderActionHandle, request: ProviderRoomTurnRecoveryRequest, options?: { detachSignal?: AbortSignal }): Promise<ProviderRoomTurnResult>;
  stop(handle: ProviderActionHandle, options?: { force?: boolean; graceMs?: number; actionId?: string }): Promise<ProviderActionTerminal>;
  onExit(handle: ProviderActionHandle, listener: (terminal: ProviderActionTerminal) => void): Promise<() => void>;
  onStream?(handle: ProviderActionHandle, listener: (event: ProviderActionStreamEvent) => void): Promise<() => void>;
}
